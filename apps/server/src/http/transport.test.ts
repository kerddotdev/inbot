import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redacted, Schema } from "effect";
import { expect, test as base, vi } from "vitest";
import { Domain } from "../../../../packages/contracts/src/domains.js";
import { ErrorResponse } from "../../../../packages/contracts/src/errors.js";
import {
  OwnerSessionResponse,
  OwnerTransportStatus,
} from "../../../../packages/contracts/src/owner.js";
import { Connection } from "../auth/owner.js";
import { client } from "../mcp/test-client.js";
import { fixture } from "./test-fixture.js";

const path = "/v0/owner/transport";
const settings = { account_id: "a".repeat(32), api_token: "synthetic-cloud-token" };
const empty = {
  provider: "cloudflare",
  account_id: null,
  token_set: false,
  verification_status: "not_configured",
  verified_at: null,
};
const test = base.extend<{ api: Awaited<ReturnType<typeof fixture>> }>({
  api: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-transport-"));
    const api = await fixture(home);
    try {
      await use(api);
    } finally {
      await api.close();
      await rm(home, { recursive: true, force: true });
    }
  },
});
async function status(response: Response) {
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(JSON.stringify(body)).not.toContain(settings.api_token);
  expect(body).not.toHaveProperty("api_token");
  return Schema.decodeUnknownSync(OwnerTransportStatus)(body);
}

test("requires owner credentials for every transport route and CSRF for unsafe session requests", async ({
  api,
}) => {
  const key = await api.run(
    api.keys.create({ permissions: { inbox_read: true }, send_policy: "direct" }),
  );
  const login = await api.request("/v0/owner/setup", {
    token: null,
    method: "POST",
    body: { password: "synthetic owner password", code: api.setupCode },
  });
  const session = Schema.decodeUnknownSync(OwnerSessionResponse)(await login.json());
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  for (const method of ["GET", "PUT", "DELETE"]) {
    const body = method === "PUT" ? settings : undefined;
    for (const headers of [{}, { cookie }]) {
      const denied = await api.request(path, { method, body, token: key.api_key, headers });
      expect(denied.status).toBe(403);
      expect(Schema.decodeUnknownSync(ErrorResponse)(await denied.json()).code).toBe(
        "missing_permission",
      );
    }
    expect((await api.request(path, { method, body, token: null })).status).toBe(401);
    if (method !== "GET") {
      for (const headers of [{ cookie }, { cookie, "x-inbot-csrf": "wrong" }])
        expect((await api.request(path, { method, body, token: null, headers })).status).toBe(403);
    }
  }
  expect(await status(await api.request(path))).toEqual(empty);
  expect(await status(await api.request(path, { token: null, headers: { cookie } }))).toEqual(
    empty,
  );
  const headers = { cookie, "x-inbot-csrf": session.csrf_token, origin: api.url };
  expect(
    (await api.request(path, { method: "PUT", body: settings, token: null, headers })).status,
  ).toBe(200);
  expect((await api.request(path, { method: "DELETE", token: null, headers })).status).toBe(200);
  const mcp = await client(api, api.token);
  expect((await mcp.list()).tools.some((tool) => /transport/i.test(tool.name))).toBe(false);
});

test("persists verified credentials encrypted, exposes only metadata, and clears verification with the token", async ({
  api,
}) => {
  await api.run(api.transport.set(settings));
  expect(await status(await api.request(path))).toMatchObject({
    verification_status: "unverified",
    verified_at: null,
  });
  const configured = await status(await api.request(path, { method: "PUT", body: settings }));
  expect(configured).toEqual({
    provider: "cloudflare",
    account_id: settings.account_id,
    token_set: true,
    verification_status: "verified",
    verified_at: "2026-10-10T12:00:00.000Z",
  });
  const saved = await api.run(api.transport.get());
  if (saved === undefined) throw new Error("Expected configured transport");
  expect(Redacted.value(saved.api_token)).toBe(settings.api_token);
  const restarted = await api.restart();
  try {
    const connection = Schema.decodeUnknownSync(Schema.fromJsonString(Connection))(
      await readFile(join(api.home, "connection.json"), "utf8"),
    );
    expect(
      await status(
        await fetch(`${restarted.url}${path}`, {
          headers: { authorization: `Bearer ${connection.token}` },
        }),
      ),
    ).toEqual(configured);
  } finally {
    await restarted.close();
  }
  expect(await readFile(join(api.home, "inbot.db"), "utf8")).not.toContain(settings.api_token);
  for (const body of [
    { ...settings, account_id: "bad" },
    { ...settings, api_token: " " },
    { ...settings, api_token: "" },
    { ...settings, extra: true },
  ]) {
    const response = await api.request(path, { method: "PUT", body });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(settings.api_token);
  }
  expect(await status(await api.request(path))).toEqual(configured);
  expect((await api.request(path, { method: "DELETE" })).status).toBe(200);
  expect(await status(await api.request(path))).toEqual(empty);
  expect(await api.run(api.transport.get())).toBeUndefined();
  expect((await api.request(path, { method: "DELETE" })).status).toBe(200);
});

test("verifies candidate credentials before persistence, uses the user fallback, and preserves the last verified config on failure", async () => {
  const home = await mkdtemp(join(tmpdir(), "inbot-transport-verify-"));
  let api: Awaited<ReturnType<typeof fixture>> | undefined;
  let mode: "active" | "disabled" | "denied" | "offline" = "active";
  const fetcher = vi.fn<typeof fetch>(async (input, options) => {
    const current = api;
    if (current === undefined) throw new Error("Expected a running test server");
    expect(await current.run(current.transport.get())).toBeUndefined();
    expect(new Headers(options?.headers).get("authorization")).toBe(`Bearer ${settings.api_token}`);
    if (String(input).includes("/accounts/")) return new Response(null, { status: 403 });
    return Response.json({ success: true, result: { status: "active" } });
  });
  try {
    api = await fixture(home, { transportFetch: fetcher });
    const configured = await status(await api.request(path, { method: "PUT", body: settings }));
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/${settings.account_id}/tokens/verify`,
      "https://api.cloudflare.com/client/v4/user/tokens/verify",
    ]);
    fetcher.mockImplementation(async (_input, options) => {
      const current = api;
      if (current === undefined) throw new Error("Expected a running test server");
      const saved = await current.run(current.transport.get());
      if (saved === undefined) throw new Error("Expected configured transport");
      expect(saved?.verified_at).toBe(configured.verified_at);
      expect(Redacted.value(saved.api_token)).toBe(settings.api_token);
      expect(new Headers(options?.headers).get("authorization")).toBe(
        "Bearer replacement-synthetic-token",
      );
      if (mode === "offline") throw new Error("replacement-synthetic-token");
      if (mode === "denied")
        return Response.json(
          { errors: [{ message: "replacement-synthetic-token" }] },
          { status: 403 },
        );
      return Response.json({ success: true, result: { status: mode } });
    });
    for (const next of ["disabled", "denied", "offline"] as const) {
      mode = next;
      const response = await api.request(path, {
        method: "PUT",
        body: { ...settings, api_token: "replacement-synthetic-token" },
      });
      expect(response.status).toBe(next === "denied" ? 403 : 503);
      const raw = await response.text();
      expect(raw).not.toContain("replacement-synthetic-token");
      expect(Schema.decodeUnknownSync(ErrorResponse)(JSON.parse(raw))).toMatchObject({
        name: "InbotError",
        message: "The Cloudflare token could not be verified.",
        fix: expect.any(String),
      });
      expect(await status(await api.request(path))).toEqual(configured);
    }
  } finally {
    await api?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("refuses clearing provisioned domains or changing their account and permits clearing after teardown", async ({
  api,
}) => {
  await api.run(api.transport.set({ account_id: "fake-account", api_token: settings.api_token }));
  const registered = Schema.decodeUnknownSync(Domain)(
    await (
      await api.request("/v0/domains", { method: "POST", body: { domain: "agents.example.test" } })
    ).json(),
  );
  const basePath = `/v0/domains/${registered.domain_id}`;
  expect((await api.request(`${basePath}/apply`, { method: "POST" })).status).toBe(200);
  for (const options of [{ method: "DELETE" }, { method: "PUT", body: settings }]) {
    const response = await api.request(path, options);
    expect(response.status).toBe(409);
    expect(Schema.decodeUnknownSync(ErrorResponse)(await response.json())).toMatchObject({
      code: "action_required",
      fix: expect.stringContaining("Teardown"),
    });
  }
  expect((await status(await api.request(path))).token_set).toBe(true);
  expect((await api.request(`${basePath}/teardown`, { method: "POST" })).status).toBe(200);
  expect((await api.request(path, { method: "DELETE" })).status).toBe(200);
  expect(await status(await api.request(path))).toEqual(empty);
});

test("detects one account, requires a choice for several, and preserves saved settings on discovery failures", async () => {
  const home = await mkdtemp(join(tmpdir(), "inbot-transport-accounts-"));
  let accounts = [{ id: settings.account_id, name: "First account" }];
  let active = true;
  let unavailable = false;
  const fetcher = vi.fn<typeof fetch>(async (input, options) => {
    expect(new Headers(options?.headers).get("authorization")).toBe(`Bearer ${settings.api_token}`);
    if (String(input).endsWith("/user/tokens/verify"))
      return Response.json({ success: true, result: { status: active ? "active" : "disabled" } });
    if (String(input).includes("/accounts?")) {
      if (unavailable) throw new Error("synthetic network failure");
      return Response.json({ success: true, result: accounts });
    }
    return Response.json({ success: true, result: { status: "active" } });
  });
  const api = await fixture(home, { transportFetch: fetcher });
  try {
    const body = { api_token: settings.api_token };
    const configured = await status(await api.request(path, { method: "PUT", body }));
    expect(configured.account_id).toBe(settings.account_id);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.cloudflare.com/client/v4/user/tokens/verify",
      "https://api.cloudflare.com/client/v4/accounts?page=1&per_page=50",
    ]);
    accounts = [...accounts, { id: "b".repeat(32), name: "Second account" }];
    const multiple = await api.request(path, { method: "PUT", body });
    expect(multiple.status).toBe(409);
    const error = Schema.decodeUnknownSync(ErrorResponse)(await multiple.json());
    expect(error.code).toBe("action_required");
    for (const account of accounts) {
      expect(error.fix).toContain(account.id);
      expect(error.fix).toContain(account.name);
    }
    expect(await status(await api.request(path))).toEqual(configured);
    expect(
      (
        await status(
          await api.request(path, { method: "PUT", body: { ...body, account_id: "b".repeat(32) } }),
        )
      ).account_id,
    ).toBe("b".repeat(32));
    accounts = [];
    const none = await api.request(path, { method: "PUT", body });
    expect(none.status).toBe(409);
    expect(Schema.decodeUnknownSync(ErrorResponse)(await none.json()).message).toContain(
      "cannot access any",
    );
    unavailable = true;
    expect((await api.request(path, { method: "PUT", body })).status).toBe(503);
    active = false;
    fetcher.mockClear();
    expect((await api.request(path, { method: "PUT", body })).status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await status(await api.request(path))).account_id).toBe("b".repeat(32));
  } finally {
    await api.close();
    await rm(home, { recursive: true, force: true });
  }
});
