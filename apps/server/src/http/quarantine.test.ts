import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, test as base } from "vitest";
import {
  ListQuarantineResponse,
  RetryQuarantineResponse,
} from "../../../../packages/contracts/src/quarantine.js";
import { OwnerSessionResponse } from "../../../../packages/contracts/src/owner.js";
import {
  RegisteredClient,
  ConsentResponse,
  TokenResponse,
} from "../../../../packages/contracts/src/oauth.js";
import { bufferState } from "../inbound/state.js";
import { client } from "../mcp/test-client.js";
import { tunnelRoute } from "./tunnel-policy.js";
import { fixture } from "./test-fixture.js";

const path = "/v0/owner/quarantine";
const config = {
  account_id: "fake-account",
  bucket: "fake-bucket",
  inbound_queue_id: "inbound-queue",
  events_queue_id: "events-queue",
};
const test = base.extend<{ api: Awaited<ReturnType<typeof fixture>> }>({
  api: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-quarantine-http-"));
    const api = await fixture(home);
    try {
      await use(api);
    } finally {
      await api.close();
      await rm(home, { recursive: true, force: true });
    }
  },
});
async function seed(api: Awaited<ReturnType<typeof fixture>>) {
  await api.run(api.inbound.set(config));
  await api.run(api.transport.set({ account_id: config.account_id, api_token: "synthetic-token" }));
  const key = "inbound/01a1269c-73cc-7dd9-8d18-000000000001.age";
  api.buffer.putObject(key, new Uint8Array(64).fill(42), "2026-10-10T10:00:00Z");
  await api.run(
    bufferState(api.store, config.account_id, config.bucket).put(
      key,
      "quarantined",
      "invalid_pointer",
    ),
  );
  const response = await api.request(path);
  expect(response.status).toBe(200);
  const page = Schema.decodeUnknownSync(ListQuarantineResponse)(await response.json());
  const item = page.items[0];
  if (!item) throw new Error("Expected quarantine item");
  return item;
}

test("REST lists metadata, reports a permanent retry failure and deletes idempotently", async ({
  api,
}) => {
  const item = await seed(api);
  const retry = await api.request(`${path}/${item.quarantine_id}/retry`, { method: "POST" });
  expect(retry.status).toBe(200);
  expect(Schema.decodeUnknownSync(RetryQuarantineResponse)(await retry.json())).toMatchObject({
    status: "quarantined",
    item: { reason_code: "invalid_ciphertext", attempts: 1 },
  });
  for (let index = 0; index < 2; index++)
    expect((await api.request(`${path}/${item.quarantine_id}`, { method: "DELETE" })).status).toBe(
      200,
    );
  expect(api.buffer.objects.size).toBe(0);
  expect(
    Schema.decodeUnknownSync(ListQuarantineResponse)(await (await api.request(path)).json()).count,
  ).toBe(0);
  expect(
    (await api.request(`${path}/${item.quarantine_id}/retry`, { method: "POST" })).status,
  ).toBe(404);
});

test("denies agent keys, valid OAuth tokens and tunnel traffic, and requires browser CSRF", async ({
  api,
}) => {
  const item = await seed(api);
  const key = await api.run(
    api.keys.create({ permissions: { message_read: true }, send_policy: "direct" }),
  );
  const setup = await api.request("/v0/owner/setup", {
    token: null,
    method: "POST",
    body: { password: "synthetic owner password", code: api.setupCode },
  });
  const session = Schema.decodeUnknownSync(OwnerSessionResponse)(await setup.json());
  const cookie = setup.headers.get("set-cookie")?.split(";")[0] ?? "";
  const headers = { cookie, "x-inbot-csrf": session.csrf_token, origin: api.url };
  const redirect = "http://127.0.0.1:4567/callback";
  const registration = await api.request("/oauth/register", {
    token: null,
    method: "POST",
    body: { client_name: "Synthetic client", redirect_uris: [redirect] },
  });
  const registered = Schema.decodeUnknownSync(RegisteredClient)(await registration.json());
  const verifier = randomBytes(32).toString("base64url");
  const consent = await api.request("/oauth/authorize", {
    token: null,
    method: "POST",
    headers,
    body: {
      response_type: "code",
      client_id: registered.client_id,
      redirect_uri: redirect,
      resource: `${api.url}/v0`,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      approved: true,
      grant: { permissions: { inbox_read: true, message_read: true }, send_policy: "read_only" },
    },
  });
  const authorized = Schema.decodeUnknownSync(ConsentResponse)(await consent.json());
  const exchange = await api.request("/oauth/token", {
    token: null,
    method: "POST",
    body: {
      grant_type: "authorization_code",
      client_id: registered.client_id,
      redirect_uri: redirect,
      code: new URL(authorized.redirect_uri).searchParams.get("code"),
      code_verifier: verifier,
      resource: `${api.url}/v0`,
    },
  });
  const tokens = Schema.decodeUnknownSync(TokenResponse)(await exchange.json());
  expect((await api.request("/v0/inboxes", { token: tokens.access_token })).status).toBe(200);
  for (const [url, method] of [
    [path, "GET"],
    [`${path}/${item.quarantine_id}/retry`, "POST"],
    [`${path}/${item.quarantine_id}`, "DELETE"],
  ]) {
    if (!url || !method) throw new Error("Expected route");
    for (const token of [key.api_key, tokens.access_token])
      expect((await api.request(url, { token, method })).status).toBe(403);
    expect(tunnelRoute(url)).toBe("blocked");
    expect(
      (
        await fetch(`${api.tunnelUrl}${url}`, {
          method,
          headers: { authorization: `Bearer ${tokens.access_token}` },
        })
      ).status,
    ).toBe(403);
  }
  expect((await api.request(path, { token: null })).status).toBe(401);
  expect((await api.request(path, { token: null, headers: { cookie } })).status).toBe(200);
  expect(
    (
      await api.request(`${path}/${item.quarantine_id}`, {
        token: null,
        method: "DELETE",
        headers: { cookie },
      })
    ).status,
  ).toBe(403);
  expect(
    (await api.request(`${path}/${item.quarantine_id}`, { token: null, method: "DELETE", headers }))
      .status,
  ).toBe(200);
  const mcp = await client(api, api.token);
  expect((await mcp.list()).tools.some((tool) => /quarantine/i.test(tool.name))).toBe(false);
});

test("retains ciphertext when its original buffer configuration is unavailable", async ({
  api,
}) => {
  const item = await seed(api);
  await api.run(api.inbound.clear());
  expect((await api.request(`${path}/${item.quarantine_id}`, { method: "DELETE" })).status).toBe(
    409,
  );
  expect(api.buffer.objects.size).toBe(1);
  expect((await api.request(path)).status).toBe(200);
  expect(
    (await api.request(`${path}/${item.quarantine_id}/retry`, { method: "POST" })).status,
  ).toBe(409);
});
