import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { expect, test as base } from "vitest";
import * as OAuth from "../../../../packages/contracts/src/oauth.js";
import type { Grant } from "../../../../packages/contracts/src/api-keys.js";
import { ListInboxesResponse } from "../../../../packages/contracts/src/inboxes.js";
import { ErrorResponse } from "../../../../packages/contracts/src/errors.js";
import { AttachmentResponse } from "../../../../packages/contracts/src/attachments.js";
import { makeOAuth } from "../oauth/service.js";
import { hashToken } from "../auth/api-keys.js";
import { Store } from "../store.js";
import { EventLog, eventVisible } from "../events/log.js";
import { client as mcpClient } from "../mcp/test-client.js";
import { fixture } from "./test-fixture.js";
import { defaultGrant } from "../../../web/src/components/grant-presets.js";

const inboxId = "agent@example.test";
const otherInbox = "other@example.test";
const redirect = "http://127.0.0.1:4567/callback";
const grant: Grant = {
  inbox_ids: [inboxId],
  permissions: { inbox_read: true, message_read: true },
  send_policy: "read_only",
};
const test = base.extend<{ f: Awaited<ReturnType<typeof fixture>> }>({
  f: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-oauth-test-"));
    const webRoot = join(home, "web");
    await mkdir(webRoot);
    await writeFile(join(webRoot, "index.html"), "<html><body>Owner consent UI</body></html>");
    const f = await fixture(home, { webRoot });
    try {
      await use(f);
    } finally {
      await f.close();
      await rm(home, { recursive: true, force: true });
    }
  },
});
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function post(f: Fixture, path: string, body: unknown, headers: Record<string, string> = {}) {
  return f.request(path, { token: null, method: "POST", body, headers });
}
async function browser(f: Fixture) {
  const response = await post(f, "/v0/owner/setup", {
    code: f.setupCode,
    password: "synthetic owner password",
  });
  expect(response.status).toBe(200);
  const { csrf_token } = Schema.decodeUnknownSync(Schema.Struct({ csrf_token: Schema.String }))(
    await response.json(),
  );
  return {
    cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
    "x-inbot-csrf": csrf_token,
    origin: f.url,
  };
}
async function flow(f: Fixture, resourcePath = "/mcp", customGrant = grant) {
  const session = await browser(f);
  const registration = await post(f, "/oauth/register", {
    client_name: "<Untrusted client>",
    redirect_uris: [redirect],
  });
  expect(registration.status).toBe(201);
  const registered = Schema.decodeUnknownSync(OAuth.RegisteredClient)(await registration.json());
  const verifier = randomBytes(32).toString("base64url");
  const input: OAuth.AuthorizationRequest = {
    response_type: "code",
    client_id: registered.client_id,
    redirect_uri: redirect,
    resource: `${f.url}${resourcePath}`,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: "client-state",
  };
  const inspect = await post(f, "/oauth/authorize/details", input, session);
  expect(inspect.status).toBe(200);
  expect(await inspect.json()).toEqual({
    client_name: "<Untrusted client>",
    redirect_host: "127.0.0.1:4567",
    resource: input.resource,
  });
  const authorized = await post(
    f,
    "/oauth/authorize",
    { ...input, approved: true, grant: customGrant },
    session,
  );
  expect(authorized.status).toBe(200);
  const result = Schema.decodeUnknownSync(OAuth.ConsentResponse)(await authorized.json());
  const callback = new URL(result.redirect_uri);
  expect(callback.searchParams.get("state")).toBe(input.state);
  expect(callback.searchParams.get("iss")).toBe(f.url);
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("Missing code");
  const exchange = {
    grant_type: "authorization_code",
    client_id: input.client_id,
    code,
    redirect_uri: redirect,
    code_verifier: verifier,
    resource: input.resource,
  };
  return { input, exchange, session };
}
async function exchange(f: Fixture, value: unknown) {
  const response = await post(f, "/oauth/token", value);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return Schema.decodeUnknownSync(OAuth.TokenResponse)(await response.json());
}
async function oauthFailure(response: Response, error: string, status = 400) {
  expect(response.status).toBe(status);
  expect(Schema.decodeUnknownSync(OAuth.OAuthErrorResponse)(await response.json()).error).toBe(
    error,
  );
}

for (const resourcePath of ["/mcp", "/v0"])
  test(`${resourcePath} OAuth capabilities recheck the issuing access token and grant`, async ({
    f,
  }) => {
    const { input, exchange: code } = await flow(f, resourcePath);
    const tokens = await exchange(f, code);
    const stored = await f.run(
      f.mailbox.insertMessage({
        inbox_id: inboxId,
        message_id: "<oauth-file@example.test>",
        direction: "received",
        from: "alice@example.test",
        to: [inboxId],
        timestamp: "2026-10-10T12:00:00Z",
        raw: Buffer.from("Synthetic MIME"),
        attachments: [
          {
            attachment_id: "file-1",
            filename: "sample.txt",
            content: Buffer.from("Synthetic OAuth attachment"),
          },
        ],
      }),
    );
    const attachment =
      resourcePath === "/mcp"
        ? Schema.decodeUnknownSync(AttachmentResponse)(
            (
              await (
                await mcpClient(f, tokens.access_token)
              ).call("get_attachment", { threadId: stored.thread_id, attachmentId: "file-1" })
            ).structuredContent,
          )
        : Schema.decodeUnknownSync(AttachmentResponse)(
            await (
              await f.request(
                `/v0/inboxes/${inboxId}/messages/${encodeURIComponent("<oauth-file@example.test>")}/attachments/file-1`,
                { token: tokens.access_token },
              )
            ).json(),
          );
    const path = new URL(attachment.download_url).pathname;
    expect(await (await f.request(path, { token: null })).text()).toBe(
      "Synthetic OAuth attachment",
    );
    expect((await f.request(path, { token: tokens.access_token })).status).toBe(200);
    expect(attachment.download_url).not.toContain(tokens.access_token);
    await f.run(
      f.store.use((db) =>
        db
          .prepare("UPDATE api_keys SET permissions = ? WHERE prefix = 'oauth'")
          .run(JSON.stringify({ inbox_read: true })),
      ),
    );
    expect((await f.request(path, { token: null })).status).toBe(403);
    await f.run(
      f.store.use((db) =>
        db
          .prepare("UPDATE api_keys SET permissions = ? WHERE prefix = 'oauth'")
          .run(JSON.stringify(grant.permissions)),
      ),
    );
    await post(f, "/oauth/revoke", { client_id: input.client_id, token: tokens.access_token });
    expect((await f.request(path, { token: null })).status).toBe(401);
  });

test("OAuth token expiry invalidates a capability before its advertised expiry", async ({ f }) => {
  const { exchange: code } = await flow(f, "/v0");
  const tokens = await exchange(f, code);
  f.advance(30_000);
  const capability = Schema.decodeUnknownSync(
    Schema.Struct({ download_url: Schema.String, expires_at: Schema.String }),
  )(
    await (
      await f.request(
        `/v0/inboxes/${inboxId}/messages/${encodeURIComponent("<first@example.test>")}/raw`,
        { token: tokens.access_token },
      )
    ).json(),
  );
  f.advance(270_000);
  expect(Date.parse(capability.expires_at)).toBe(Date.parse("2026-10-10T12:05:30Z"));
  expect((await fetch(capability.download_url)).status).toBe(401);
});

test("discovers canonical resources and completes the owner code/PKCE flow with hashed credentials and MCP access", async ({
  f,
}) => {
  for (const [path, resource] of [
    ["", ""],
    ["/mcp", "/mcp"],
    ["/v0", "/v0"],
  ]) {
    const response = await f.request(`/.well-known/oauth-protected-resource${path}`, {
      token: null,
    });
    expect(await response.json()).toMatchObject({
      resource: `${f.url}${resource}`,
      authorization_servers: [f.url],
    });
  }
  expect(
    await (await f.request("/.well-known/oauth-authorization-server", { token: null })).json(),
  ).toMatchObject({
    issuer: f.url,
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
  });
  const { input, exchange: code } = await flow(f);
  const tokens = await exchange(f, code);
  const mcp = await mcpClient(f, tokens.access_token);
  const result = await mcp.call("list_inboxes", {});
  expect(result.isError).not.toBe(true);
  expect(
    Schema.decodeUnknownSync(ListInboxesResponse)(result.structuredContent).inboxes.map(
      (i) => i.inbox_id,
    ),
  ).toEqual([inboxId]);
  expect((await f.request("/v0/inboxes", { token: tokens.access_token })).status).toBe(401);
  const keys = await f.run(f.keys.list());
  expect(keys.api_keys).toEqual([]);
  const clients = Schema.decodeUnknownSync(OAuth.OAuthClientsResponse)(
    await (await f.request("/v0/owner/oauth/clients")).json(),
  );
  expect(clients.grants).toHaveLength(1);
  expect(clients.grants[0]).toMatchObject({ client_id: input.client_id, ...grant });
  const rows = await f.run(
    f.store.use((db) => ({
      codes: db.prepare("SELECT * FROM oauth_codes").all(),
      tokens: db.prepare("SELECT * FROM oauth_tokens").all(),
      version: db.pragma("user_version", { simple: true }),
    })),
  );
  expect(rows.version).toBe(14);
  const persisted = JSON.stringify(rows);
  for (const secret of [tokens.access_token, tokens.refresh_token, code.code, code.code_verifier])
    expect(persisted).not.toContain(secret);
});

test("rejects wrong verifiers, redirect/client/resource mismatches and code reuse without issuing credentials", async ({
  f,
}) => {
  const { exchange: code } = await flow(f);
  await oauthFailure(
    await post(f, "/oauth/token", { ...code, code_verifier: "z".repeat(43) }),
    "invalid_grant",
  );
  await oauthFailure(
    await post(f, "/oauth/token", { ...code, redirect_uri: `${redirect}?changed=1` }),
    "invalid_grant",
  );
  await oauthFailure(
    await post(f, "/oauth/token", { ...code, resource: `${f.url}/v0` }),
    "invalid_grant",
  );
  await oauthFailure(
    await post(f, "/oauth/token", { ...code, resource: "https://foreign.example.test/mcp" }),
    "invalid_target",
  );
  const otherClient = Schema.decodeUnknownSync(OAuth.RegisteredClient)(
    await (await post(f, "/oauth/register", { redirect_uris: [redirect] })).json(),
  );
  await oauthFailure(
    await post(f, "/oauth/token", { ...code, client_id: otherClient.client_id }),
    "invalid_grant",
  );
  const tokens = await exchange(f, code);
  await oauthFailure(await post(f, "/oauth/token", code), "invalid_grant");
  expect((await f.request("/mcp", { token: tokens.access_token })).status).toBe(401);
});

test("rotates refresh tokens atomically, revokes the family on reuse, and persists the revocation after restart", async ({
  f,
}) => {
  const { input, exchange: code } = await flow(f, "/v0");
  const tokens = await exchange(f, code);
  const refresh = {
    grant_type: "refresh_token",
    client_id: input.client_id,
    refresh_token: tokens.refresh_token,
    resource: input.resource,
  };
  const rotated = await exchange(f, refresh);
  expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
  expect((await f.request("/v0/inboxes", { token: rotated.access_token })).status).toBe(200);
  await oauthFailure(await post(f, "/oauth/token", refresh), "invalid_grant");
  for (const token of [tokens.access_token, rotated.access_token])
    expect((await f.request("/v0/inboxes", { token })).status).toBe(401);
  await oauthFailure(
    await post(f, "/oauth/token", { ...refresh, refresh_token: rotated.refresh_token }),
    "invalid_grant",
  );
  const restarted = await f.restart();
  try {
    expect(
      (
        await fetch(`${restarted.url}/v0/inboxes`, {
          headers: { authorization: `Bearer ${rotated.access_token}` },
        })
      ).status,
    ).toBe(401);
  } finally {
    await restarted.close();
  }
});

test("enforces access/code/refresh expiry with an injected clock", async ({ f }) => {
  const { exchange: code } = await flow(f, "/v0");
  const tokens = await exchange(f, code);
  f.advance(300_001);
  expect((await f.request("/v0/inboxes", { token: tokens.access_token })).status).toBe(401);
  const refreshed = await exchange(f, {
    grant_type: "refresh_token",
    client_id: code.client_id,
    refresh_token: tokens.refresh_token,
    resource: code.resource,
  });
  expect((await f.request("/v0/inboxes", { token: refreshed.access_token })).status).toBe(200);
  await oauthFailure(await post(f, "/oauth/token", code), "invalid_grant");
  f.advance(30 * 24 * 60 * 60_000);
  await oauthFailure(
    await post(f, "/oauth/token", {
      grant_type: "refresh_token",
      client_id: code.client_id,
      refresh_token: refreshed.refresh_token,
      resource: code.resource,
    }),
    "invalid_grant",
  );
});

test("gives REST OAuth and API keys identical scope, permission, hidden-label and send-policy enforcement", async ({
  f,
}) => {
  const { exchange: code } = await flow(f, "/v0", {
    ...grant,
    permissions: { ...grant.permissions, message_send: true },
  });
  const tokens = await exchange(f, code);
  const key = await f.run(
    f.keys.create({ ...grant, permissions: { ...grant.permissions, message_send: true } }),
  );
  await f.run(f.mailbox.updateMessage(inboxId, "<first@example.test>", { add_labels: ["spam"] }));
  for (const token of [tokens.access_token, key.api_key]) {
    const hidden = await f.request(
      `/v0/inboxes/${inboxId}/messages/${encodeURIComponent("<first@example.test>")}`,
      { token },
    );
    expect(hidden.status).toBe(404);
    const list = Schema.decodeUnknownSync(ListInboxesResponse)(
      await (await f.request("/v0/inboxes", { token })).json(),
    );
    expect(list.inboxes.map((i) => i.inbox_id)).toEqual([inboxId]);
    expect((await f.request(`/v0/inboxes/${otherInbox}`, { token })).status).toBe(404);
    for (const [path, body] of [
      ["/v0/inboxes", { inbox_id: "new@example.test" }],
      [
        `/v0/inboxes/${inboxId}/messages/send`,
        { to: ["recipient@example.test"], subject: "Synthetic", text: "Synthetic" },
      ],
    ]) {
      const response = await f.request(String(path), {
        token,
        method: "POST",
        body,
        headers: { "idempotency-key": "synthetic-oauth-policy" },
      });
      expect(response.status).toBe(403);
      expect(Schema.decodeUnknownSync(ErrorResponse)(await response.json()).code).toBe(
        "missing_permission",
      );
    }
    for (const path of [
      "/v0/api-keys",
      "/v0/domains",
      "/v0/owner/oauth/clients",
      "/v0/owner/status",
      "/v0/owner/transport",
      "/v0/owner/remote",
    ])
      expect((await f.request(path, { token })).status, path).toBe(403);
  }
});

test("revokes token families and owner grants, returns 200 for unknown token revocation, and emits owner-only events", async ({
  f,
}) => {
  const { input, exchange: code } = await flow(f, "/v0");
  const tokens = await exchange(f, code);
  expect(
    (await post(f, "/oauth/revoke", { client_id: input.client_id, token: "unknown" })).status,
  ).toBe(200);
  expect(
    (await post(f, "/oauth/revoke", { client_id: input.client_id, token: tokens.access_token }))
      .status,
  ).toBe(200);
  expect((await f.request("/v0/inboxes", { token: tokens.access_token })).status).toBe(401);
  await oauthFailure(
    await post(f, "/oauth/token", {
      grant_type: "refresh_token",
      client_id: input.client_id,
      refresh_token: tokens.refresh_token,
      resource: input.resource,
    }),
    "invalid_grant",
  );
  const clients = Schema.decodeUnknownSync(OAuth.OAuthClientsResponse)(
    await (await f.request("/v0/owner/oauth/clients")).json(),
  );
  const grantId = clients.grants[0]?.grant_id;
  expect((await f.request(`/v0/owner/oauth/grants/${grantId}`, { method: "DELETE" })).status).toBe(
    200,
  );
  expect(
    Schema.decodeUnknownSync(OAuth.OAuthClientsResponse)(
      await (await f.request("/v0/owner/oauth/clients")).json(),
    ).grants,
  ).toEqual([]);
  const events = await f.run(
    Effect.flatMap(EventLog, (service) => service.read(0)).pipe(
      Effect.provide(EventLog.Live.pipe(Layer.provide(Layer.succeed(Store, f.store)))),
    ),
  );
  expect(
    events
      .filter((e) => e.payload.event_type.startsWith("oauth."))
      .map((e) => e.payload.event_type),
  ).toEqual(["oauth.authorized", "oauth.tokens_revoked", "oauth.revoked"]);
  for (const event of events.filter((e) => e.payload.event_type.startsWith("oauth."))) {
    expect(eventVisible(event, { kind: "owner" })).toBe(true);
    expect(eventVisible(event, { kind: "agent", api_key_id: "synthetic", grant })).toBe(false);
  }
});

test("requires browser consent, exact Origin and CSRF, preserves state on denial, and refuses implicit or non-S256 authorization", async ({
  f,
}) => {
  const { input, session } = await flow(f);
  const consent = { ...input, approved: true, grant };
  await oauthFailure(await post(f, "/oauth/authorize", consent), "access_denied", 403);
  await oauthFailure(
    await f.request("/oauth/authorize", {
      method: "POST",
      body: consent,
      headers: { origin: f.url },
    }),
    "access_denied",
    403,
  );
  for (const headers of [
    { ...session, origin: "" },
    { ...session, origin: "https://foreign.example.test" },
    { ...session, "x-inbot-csrf": "wrong" },
  ])
    expect((await post(f, "/oauth/authorize", consent, headers)).status).toBe(403);
  for (const change of [
    { code_challenge_method: "plain" },
    { code_challenge: undefined },
    { resource: undefined },
    { response_type: "token" },
    { redirect_uri: "https://foreign.example.test/callback" },
  ]) {
    const response = await post(f, "/oauth/authorize", { ...consent, ...change }, session);
    expect(response.status).toBe(400);
  }
  const denied = Schema.decodeUnknownSync(OAuth.ConsentResponse)(
    await (await post(f, "/oauth/authorize", { ...input, approved: false }, session)).json(),
  );
  const target = new URL(denied.redirect_uri);
  expect(target.searchParams.get("error")).toBe("access_denied");
  expect(target.searchParams.get("state")).toBe(input.state);
  expect(target.searchParams.has("code")).toBe(false);
  const query = new URLSearchParams(Object.entries(input)).toString();
  const unauthenticated = await fetch(`${f.url}/oauth/authorize?${query}`, { redirect: "manual" });
  expect(unauthenticated.status).toBe(302);
  expect(unauthenticated.headers.get("location")).toBe(
    `/login?authorize=${encodeURIComponent(query)}`,
  );
  const page = await f.request(`/oauth/authorize?${query}`, {
    token: null,
    headers: { cookie: session.cookie },
  });
  expect(await page.text()).toContain("Owner consent UI");
});

test("accepts only public DCR clients with safe redirects and applies persistent registration limits", async ({
  f,
}) => {
  for (const uri of [
    "http://foreign.example.test/callback",
    "javascript:alert(1)",
    "https://user:pass@example.test/cb",
    "https://example.test/cb#fragment",
  ])
    expect((await post(f, "/oauth/register", { redirect_uris: [uri] })).status).toBe(400);
  expect(
    (
      await post(f, "/oauth/register", {
        redirect_uris: [redirect],
        token_endpoint_auth_method: "client_secret_basic",
      })
    ).status,
  ).toBe(400);
  for (let index = 0; index < 15; index++)
    expect(
      (
        await post(f, "/oauth/register", {
          redirect_uris: ["https://client.example.test/callback", "http://[::1]:8765/cb"],
        })
      ).status,
    ).toBe(201);
  await oauthFailure(
    await post(f, "/oauth/register", { redirect_uris: [redirect] }),
    "temporarily_unavailable",
    429,
  );
});

test("accepts form token exchange, rejects duplicate parameters, and includes resource metadata in REST and MCP challenges", async ({
  f,
}) => {
  const { exchange: code } = await flow(f);
  const response = await fetch(`${f.url}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(code),
  });
  expect(response.status).toBe(200);
  const duplicate = await fetch(`${f.url}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `client_id=${code.client_id}&client_id=${code.client_id}`,
  });
  await oauthFailure(duplicate, "invalid_request");
  for (const path of ["/mcp", "/mcp/", "/m%63p", "/v0/inboxes"]) {
    const challenged = await f.request(path, { token: null });
    expect(challenged.status).toBe(401);
    expect(challenged.headers.get("www-authenticate")).toContain(
      `resource_metadata="${f.url}/.well-known/oauth-protected-resource/${path.startsWith("/v0") ? "v0" : "mcp"}"`,
    );
  }
});

test("revoking an owner grant immediately invalidates access and refresh tokens without affecting another grant", async ({
  f,
}) => {
  const { input, exchange: code, session } = await flow(f, "/v0");
  const first = await exchange(f, code);
  const approved = Schema.decodeUnknownSync(OAuth.ConsentResponse)(
    await (await post(f, "/oauth/authorize", { ...input, approved: true, grant }, session)).json(),
  );
  const secondCode = new URL(approved.redirect_uri).searchParams.get("code");
  const second = await exchange(f, { ...code, code: secondCode });
  const list = Schema.decodeUnknownSync(OAuth.OAuthClientsResponse)(
    await (await f.request("/v0/owner/oauth/clients")).json(),
  );
  const firstId = await f.run(
    f.store.use(
      (db) =>
        Schema.decodeUnknownSync(Schema.Struct({ grant_id: Schema.String }))(
          db
            .prepare("SELECT grant_id FROM oauth_codes WHERE code_hash = ?")
            .get(createHash("sha256").update(code.code).digest()),
        ).grant_id,
    ),
  );
  const firstGrant = list.grants.find((item) => item.grant_id === firstId);
  if (!firstGrant) throw new Error("Missing grant");
  expect(
    (await f.request(`/v0/owner/oauth/grants/${firstGrant.grant_id}`, { method: "DELETE" })).status,
  ).toBe(200);
  expect((await f.request("/v0/inboxes", { token: first.access_token })).status).toBe(401);
  await oauthFailure(
    await post(f, "/oauth/token", {
      grant_type: "refresh_token",
      client_id: input.client_id,
      resource: input.resource,
      refresh_token: first.refresh_token,
    }),
    "invalid_grant",
  );
  expect((await f.request("/v0/inboxes", { token: second.access_token })).status).toBe(200);
});

test("concurrent refresh reuse commits family revocation before either issued access token can be used", async ({
  f,
}) => {
  const { input, exchange: code } = await flow(f, "/v0");
  const tokens = await exchange(f, code);
  const refresh = {
    grant_type: "refresh_token",
    client_id: input.client_id,
    refresh_token: tokens.refresh_token,
    resource: input.resource,
  };
  const responses = await Promise.all([
    post(f, "/oauth/token", refresh),
    post(f, "/oauth/token", refresh),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
  const success = responses.find((response) => response.ok);
  if (!success) throw new Error("Missing successful rotation");
  const issued = Schema.decodeUnknownSync(OAuth.TokenResponse)(await success.json());
  expect((await f.request("/v0/inboxes", { token: issued.access_token })).status).toBe(401);
  expect((await f.request("/v0/inboxes", { token: tokens.access_token })).status).toBe(401);
});

test("accepts realistic public client metadata and ignores protocol extensions while keeping owner consent strict", async ({
  f,
}) => {
  const session = await browser(f);
  const metadata = {
    client_name: "Synthetic native MCP client",
    redirect_uris: [redirect],
    token_endpoint_auth_method: "none",
    grant_types: [
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:device_code",
      "device_code",
    ],
    response_types: ["code"],
    client_uri: "https://client.example.test",
    logo_uri: "https://client.example.test/logo.png",
    scope: "inbot",
    software_id: "synthetic-client",
    software_version: "1.2.3",
    contacts: ["developer@example.test"],
    application_type: "native",
    extension_metadata: { ignored: true },
  };
  const response = await post(f, "/oauth/register", metadata);
  expect(response.status).toBe(201);
  const registered = Schema.decodeUnknownSync(OAuth.RegisteredClient)(await response.json());
  expect(registered).toMatchObject({
    client_uri: metadata.client_uri,
    logo_uri: metadata.logo_uri,
    contacts: metadata.contacts,
    software_id: metadata.software_id,
    software_version: metadata.software_version,
    grant_types: ["authorization_code", "refresh_token"],
  });
  const verifier = randomBytes(32).toString("base64url");
  const input = {
    response_type: "code",
    client_id: registered.client_id,
    redirect_uri: redirect,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    resource: `${f.url}/mcp`,
    state: "realistic-client-state",
    prompt: "consent",
    nonce: "client-nonce",
    constructor: "ignored extension",
  };
  const query = new URLSearchParams(input).toString();
  const page = await fetch(`${f.url}/oauth/authorize?${query}`, {
    headers: { cookie: session.cookie },
    redirect: "manual",
  });
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Owner consent UI");
  expect((await post(f, "/oauth/authorize/details", input, session)).status).toBe(200);
  await oauthFailure(
    await post(f, "/oauth/authorize", { ...input, approved: true, grant }, session),
    "invalid_request",
  );
  const { prompt: _prompt, nonce: _nonce, constructor: _constructor, ...consent } = input;
  const approved = Schema.decodeUnknownSync(OAuth.ConsentResponse)(
    await (
      await post(f, "/oauth/authorize", { ...consent, approved: true, grant }, session)
    ).json(),
  );
  const code = new URL(approved.redirect_uri).searchParams.get("code");
  const tokens = await exchange(f, {
    grant_type: "authorization_code",
    client_id: input.client_id,
    code,
    code_verifier: verifier,
    redirect_uri: redirect,
    resource: input.resource,
    extension_parameter: "ignored",
  });
  expect(
    (
      await post(f, "/oauth/revoke", {
        client_id: input.client_id,
        token: tokens.access_token,
        token_type_hint: "future_type",
        extension: "ignored",
      })
    ).status,
  ).toBe(200);
  for (const change of [
    { grant_types: ["device_code"] },
    { grant_types: "authorization_code" },
    { token_endpoint_auth_method: "client_secret_basic" },
    { contacts: "developer@example.test" },
    { client_uri: "javascript:alert(1)" },
    { software_version: 123 },
  ])
    await oauthFailure(
      await post(f, "/oauth/register", { ...metadata, ...change }),
      "invalid_client_metadata",
    );
  const subset = Schema.decodeUnknownSync(OAuth.RegisteredClient)(
    await (
      await post(f, "/oauth/register", {
        redirect_uris: [redirect],
        grant_types: ["authorization_code", "device_code"],
      })
    ).json(),
  );
  expect(subset.grant_types).toEqual(["authorization_code"]);
});

test("allows ephemeral loopback ports and private-use schemes but binds code exchange to the exact callback", async ({
  f,
}) => {
  const session = await browser(f);
  for (const [registeredUri, actualUri, display] of [
    [
      "http://127.0.0.1/callback?client=one",
      "http://127.0.0.1:34567/callback?client=one",
      "127.0.0.1:34567",
    ],
    ["http://[::1]:4567/callback", "http://[::1]:34567/callback", "[::1]:34567"],
    ["http://localhost:4567/callback", "http://localhost:34567/callback", "localhost:34567"],
    ["com.example.agent:/callback", "com.example.agent:/callback", "com.example.agent:"],
    [
      "com.example.agent://auth/callback",
      "com.example.agent://auth/callback",
      "com.example.agent://auth",
    ],
  ] as const) {
    const registered = Schema.decodeUnknownSync(OAuth.RegisteredClient)(
      await (await post(f, "/oauth/register", { redirect_uris: [registeredUri] })).json(),
    );
    const verifier = randomBytes(32).toString("base64url");
    const input = {
      response_type: "code",
      client_id: registered.client_id,
      redirect_uri: actualUri,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      resource: `${f.url}/v0`,
      state: "native-client-state",
    };
    const details = await post(f, "/oauth/authorize/details", input, session);
    expect(details.status).toBe(200);
    expect(await details.json()).toMatchObject({ redirect_host: display });
    for (const changed of [actualUri.replace("callback", "different"), `${actualUri}&extra=value`])
      await oauthFailure(
        await post(f, "/oauth/authorize/details", { ...input, redirect_uri: changed }, session),
        "invalid_redirect_uri",
      );
    if (actualUri.startsWith("http://127.0.0.1:")) {
      for (const host of ["127.000.000.001", "0x7f000001", "localhost"])
        await oauthFailure(
          await post(
            f,
            "/oauth/authorize/details",
            {
              ...input,
              redirect_uri: actualUri.replace("127.0.0.1", host),
            },
            session,
          ),
          "invalid_redirect_uri",
        );
    }
    const approved = Schema.decodeUnknownSync(OAuth.ConsentResponse)(
      await (
        await post(f, "/oauth/authorize", { ...input, approved: true, grant }, session)
      ).json(),
    );
    const target = new URL(approved.redirect_uri);
    expect(target.searchParams.get("iss")).toBe(f.url);
    const exchangeRequest = {
      grant_type: "authorization_code",
      client_id: input.client_id,
      redirect_uri: actualUri,
      code: target.searchParams.get("code"),
      code_verifier: verifier,
      resource: input.resource,
    };
    if (actualUri !== registeredUri)
      await oauthFailure(
        await post(f, "/oauth/token", { ...exchangeRequest, redirect_uri: registeredUri }),
        "invalid_grant",
      );
    else
      await oauthFailure(
        await post(f, "/oauth/token", {
          ...exchangeRequest,
          redirect_uri: "com.example.other:/callback",
        }),
        "invalid_grant",
      );
    const tokens = await exchange(f, exchangeRequest);
    expect((await f.request("/v0/inboxes", { token: tokens.access_token })).status).toBe(200);
  }
});

test("rejects dangerous callback schemes, non-loopback HTTP and changed HTTPS ports", async ({
  f,
}) => {
  for (const uri of [
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///tmp/callback",
    "vbscript:test",
    "about:blank",
    "blob:https://example.test/id",
    "http://192.168.1.1/cb",
    "http://example.test/cb",
    "com.example.agent:/cb#fragment",
    "com.example.agent://user:password@auth/callback",
    "com.example.agent:/cb\n",
  ]) {
    await oauthFailure(
      await post(f, "/oauth/register", { redirect_uris: [uri] }),
      "invalid_redirect_uri",
    );
  }
  const session = await browser(f);
  const registered = Schema.decodeUnknownSync(OAuth.RegisteredClient)(
    await (
      await post(f, "/oauth/register", { redirect_uris: ["https://example.test:4567/cb"] })
    ).json(),
  );
  await oauthFailure(
    await post(
      f,
      "/oauth/authorize/details",
      {
        client_id: registered.client_id,
        redirect_uri: "https://example.test:34567/cb",
        resource: `${f.url}/mcp`,
        response_type: "code",
        code_challenge: "a".repeat(43),
        code_challenge_method: "S256",
      },
      session,
    ),
    "invalid_redirect_uri",
  );
});

test("redirects authorization errors only after callback validation and returns state and issuer", async ({
  f,
}) => {
  const { input } = await flow(f);
  for (const change of [
    { code_challenge_method: "plain" },
    { response_type: "token" },
    { resource: "https://foreign.example.test/mcp" },
  ]) {
    const query = new URLSearchParams({ ...input, ...change }).toString();
    const response = await fetch(`${f.url}/oauth/authorize?${query}`, { redirect: "manual" });
    expect(response.status).toBe(302);
    const target = new URL(response.headers.get("location") ?? "");
    expect(target.origin).toBe(new URL(redirect).origin);
    expect(target.searchParams.get("error")).toBe(
      change.resource ? "invalid_target" : "invalid_request",
    );
    expect(target.searchParams.get("state")).toBe(input.state);
    expect(target.searchParams.get("iss")).toBe(f.url);
    expect(target.searchParams.has("code")).toBe(false);
  }
  for (const change of [
    { redirect_uri: "https://foreign.example.test/cb" },
    { client_id: "0".repeat(32) },
  ]) {
    const query = new URLSearchParams({ ...input, ...change }).toString();
    const response = await fetch(`${f.url}/oauth/authorize?${query}`, { redirect: "manual" });
    expect(response.status).toBe(400);
    expect(response.headers.has("location")).toBe(false);
  }
});

test("supports credential-free browser CORS only for discovery and public protocol requests", async ({
  f,
}) => {
  const foreignOrigin = "https://browser-client.example.test";
  for (const path of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-protected-resource/v0",
    "/oauth/register",
    "/oauth/token",
    "/oauth/revoke",
  ]) {
    const preflight = await f.request(path, {
      token: null,
      method: "OPTIONS",
      headers: {
        origin: foreignOrigin,
        "access-control-request-method": path.startsWith("/.well-known/") ? "GET" : "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(preflight.status, path).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("content-type");
    expect(preflight.headers.has("access-control-allow-credentials")).toBe(false);
    const response = await f.request(path, {
      token: null,
      ...(path.startsWith("/.well-known/") ? {} : { method: "POST", body: {} }),
      headers: { origin: foreignOrigin },
    });
    expect(response.status, path).not.toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.has("access-control-allow-credentials")).toBe(false);
    expect(response.headers.has("set-cookie")).toBe(false);
  }
  for (const path of [
    "/oauth/authorize",
    "/oauth/authorize/details",
    "/v0/owner/oauth/clients",
    "/v0/owner/oauth/clients/purge",
  ])
    for (const method of ["OPTIONS", "POST"]) {
      const response = await f.request(path, {
        token: null,
        method,
        body: {},
        headers: { origin: foreignOrigin },
      });
      expect(response.status).toBe(403);
      expect(response.headers.has("access-control-allow-origin")).toBe(false);
    }
});

test("reports invalid presented credentials in bearer challenges while leaving missing credentials unqualified", async ({
  f,
}) => {
  for (const path of ["/mcp", "/v0/inboxes"])
    for (const token of [null, "inbot_oauth_invalid", "invalid-api-key"]) {
      const response = await f.request(path, { token });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")?.includes('error="invalid_token"')).toBe(
        token !== null,
      );
    }
});

test("unknown clients cannot exhaust the token bucket and an injected clock resets the bucket", async ({
  f,
}) => {
  const { exchange: code } = await flow(f);
  for (let attempt = 0; attempt < 125; attempt++)
    await oauthFailure(
      await post(f, "/oauth/token", { ...code, client_id: "0".repeat(32) }),
      "invalid_client",
    );
  const limits = await f.run(
    f.store.use((db) =>
      db.prepare("SELECT count FROM oauth_limits WHERE operation = 'token:loopback'").get(),
    ),
  );
  expect(limits).toBeUndefined();
  for (let attempt = 0; attempt < 120; attempt++)
    await oauthFailure(
      await post(f, "/oauth/token", { ...code, code_verifier: "a".repeat(43) }),
      "invalid_grant",
    );
  await oauthFailure(await post(f, "/oauth/token", code), "temporarily_unavailable", 429);
  f.advance(60_000);
  await exchange(f, code);
});

test("expires abandoned consent grants and prunes never-approved clients after 24 hours, with owner-only purge", async ({
  f,
}) => {
  const { input, exchange: code, session } = await flow(f, "/v0");
  const key = await f.run(f.keys.create(grant));
  expect(
    (await f.request("/v0/owner/oauth/clients/purge", { token: key.api_key, method: "POST" }))
      .status,
  ).toBe(403);
  expect(
    (await post(f, "/v0/owner/oauth/clients/purge", {}, { ...session, "x-inbot-csrf": "wrong" }))
      .status,
  ).toBe(403);
  const active = await exchange(f, code);
  const abandoned = Schema.decodeUnknownSync(OAuth.ConsentResponse)(
    await (await post(f, "/oauth/authorize", { ...input, approved: true, grant }, session)).json(),
  );
  const abandonedCode = new URL(abandoned.redirect_uri).searchParams.get("code");
  const unused = Schema.decodeUnknownSync(OAuth.RegisteredClient)(
    await (await post(f, "/oauth/register", { redirect_uris: [redirect] })).json(),
  );
  f.advance(300_001);
  const list = Schema.decodeUnknownSync(OAuth.OAuthClientsResponse)(
    await (await f.request("/v0/owner/oauth/clients")).json(),
  );
  expect(list.grants).toHaveLength(1);
  await oauthFailure(
    await post(f, "/oauth/token", { ...code, code: abandonedCode }),
    "invalid_grant",
  );
  expect((await f.request("/v0/inboxes", { token: active.access_token })).status).toBe(401);
  const registered = (clientId: string) =>
    f.run(
      f.store.use((db) =>
        db.prepare("SELECT client_id FROM oauth_clients WHERE client_id = ?").get(clientId),
      ),
    );
  f.advance(24 * 60 * 60_000 - 300_002);
  await f.request("/v0/owner/oauth/clients");
  expect(await registered(unused.client_id)).toBeDefined();
  f.advance(1);
  await f.request("/v0/owner/oauth/clients");
  expect(await registered(unused.client_id)).toBeUndefined();
  expect(await registered(input.client_id)).toBeDefined();
  const fresh = Schema.decodeUnknownSync(OAuth.RegisteredClient)(
    await (await post(f, "/oauth/register", { redirect_uris: [redirect] })).json(),
  );
  const purge = await f.request("/v0/owner/oauth/clients/purge", { method: "POST" });
  expect(purge.status).toBe(200);
  expect(await purge.json()).toEqual({ deleted_clients: 1 });
  expect(await registered(fresh.client_id)).toBeUndefined();
  expect(await registered(input.client_id)).toBeDefined();
  const grantId = list.grants[0]?.grant_id;
  await f.request(`/v0/owner/oauth/grants/${grantId}`, { method: "DELETE" });
  f.advance(24 * 60 * 60_000);
  await f.request("/v0/owner/oauth/clients");
  expect(await registered(input.client_id)).toBeDefined();
  expect(
    await (await f.request("/v0/owner/oauth/clients/purge", { method: "POST" })).json(),
  ).toEqual({ deleted_clients: 1 });
});

test("API key authentication rejects internal OAuth rows even if their hashes match a synthetic API key", async ({
  f,
}) => {
  const { exchange: code } = await flow(f, "/v0");
  const token = await exchange(f, code);
  const oauth = makeOAuth(f.store);
  const clients = await f.run(oauth.clients());
  const grantId = clients.grants[0]?.grant_id;
  if (!grantId) throw new Error("Missing OAuth grant");
  const synthetic = `inbot_${grantId}_${randomBytes(32).toString("base64url")}`;
  await f.run(
    f.store.use((db) =>
      db
        .prepare("UPDATE api_keys SET secret_hash = ? WHERE api_key_id = ?")
        .run(hashToken(synthetic), grantId),
    ),
  );
  expect(await f.run(f.keys.authenticate(synthetic))).toBeUndefined();
  expect((await f.request("/v0/inboxes", { token: synthetic })).status).toBe(401);
  expect((await f.request("/v0/inboxes", { token: token.access_token })).status).toBe(200);
});

test("the default consent grant holds OAuth sends for owner approval", async ({ f }) => {
  const { exchange: code } = await flow(f, "/mcp", { ...defaultGrant, inbox_ids: [inboxId] });
  const tokens = await exchange(f, code);
  const mcp = await mcpClient(f, tokens.access_token);
  const result = await mcp.call("send_message", {
    inboxId,
    to: ["recipient@example.test"],
    text: "Synthetic default consent send",
    idempotencyKey: "default-consent-send",
  });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({ code: "approval_required" });
  const pending = await f.run(f.drafts.list(inboxId, {}));
  expect(pending.drafts).toHaveLength(1);
  expect(pending.drafts[0]).toMatchObject({ inbox_id: inboxId, pending_approval: true });
  expect(f.sent).toHaveLength(0);
});
