import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, test as base } from "vitest";
import { RemoteStatus } from "../../../../packages/contracts/src/remote.js";
import { fixture } from "./test-fixture.js";
import { tunnelPath, tunnelRoute } from "./tunnel-policy.js";

const hostname = "inbot.example.test";
const publicOrigin = `https://${hostname}`;
const password = "synthetic owner password";
const test = base.extend<{ f: Awaited<ReturnType<typeof fixture>> }>({
  f: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-tunnel-http-"));
    const webRoot = join(home, "web");
    await mkdir(webRoot);
    await writeFile(join(webRoot, "index.html"), "<html><body>Synthetic owner UI</body></html>");
    const f = await fixture(home, { webRoot });
    try {
      await use(f);
    } finally {
      await f.close();
      await rm(home, { recursive: true, force: true });
    }
  },
});
const remoteRequest = (
  f: Awaited<ReturnType<typeof fixture>>,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
) =>
  new Promise<Response>((resolve, reject) => {
    const request = httpRequest(
      f.tunnelUrl,
      { path, method: options.method ?? "GET", headers: { host: hostname, ...options.headers } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers))
            if (value !== undefined)
              for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
          resolve(
            new Response(Buffer.concat(chunks), { status: response.statusCode ?? 500, headers }),
          );
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(options.body);
  });

const websocketHandshake = (url: string, headers: Record<string, string>) =>
  new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      `${url}/v0/ws`,
      {
        agent: false,
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "c3ludGhldGljLWtleS0xMg==",
          ...headers,
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.setTimeout(5000, () => request.destroy(new Error("WebSocket handshake timed out")));
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.end();
  });

const ownerSession = async (f: Awaited<ReturnType<typeof fixture>>) => {
  expect(
    (
      await f.request("/v0/owner/setup", {
        token: null,
        method: "POST",
        body: { password, code: f.setupCode },
      })
    ).status,
  ).toBe(200);
  const login = await remoteRequest(f, "/v0/owner/login", {
    method: "POST",
    headers: { origin: publicOrigin, "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  expect(login.status).toBe(200);
  const session = Schema.decodeUnknownSync(Schema.Struct({ csrf_token: Schema.String }))(
    await login.json(),
  );
  return {
    cookie: login.headers.get("set-cookie")?.split(";")[0] ?? "",
    origin: publicOrigin,
    "x-inbot-csrf": session.csrf_token,
    "content-type": "application/json",
    "idempotency-key": "synthetic-route-bypass",
  };
};

test("owner sessions cannot bypass route boundaries with separators or mixed static casing", async ({
  f,
}) => {
  await f.run(f.remote.enable({ hostname }));
  const headers = await ownerSession(f);
  for (const [method, path] of [
    ["POST", "/v0/owner/setup"],
    ["POST", "/v0/owner/password"],
    ["POST", "/v0/api-keys"],
    ["POST", "/v0/inboxes/agent@example.test/api-keys"],
    ["POST", "/v0/domains"],
    ["PUT", "/v0/owner/transport"],
    ["POST", "/v0/owner/remote/enable"],
    ["POST", "/v0/inboxes/agent@example.test/drafts/synthetic/approve"],
    ["POST", "/v0/inboxes/agent@example.test/drafts/synthetic/reject"],
  ] as const) {
    for (const separator of [";", "#", "%3b", "%3B", "%23", "%253b", "%2523"]) {
      const target = `${path}${separator}x`;
      const response = await remoteRequest(f, target, { method, headers, body: "{}" });
      expect(response.status, target).toBe(400);
      expect(await response.json()).toMatchObject({ code: "validation_error" });
    }
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index++) {
      const segment = segments[index];
      if (segment === undefined || segment.includes("@") || segment === "synthetic") continue;
      for (const replacement of new Set([
        segment.toUpperCase(),
        `${segment[0]?.toUpperCase()}${segment.slice(1)}`,
      ])) {
        const target = segments.map((part, i) => (i === index ? replacement : part)).join("/");
        const response = await remoteRequest(f, target, { method, headers, body: "{}" });
        expect([403, 404], target).toContain(response.status);
        expect(await response.json()).toMatchObject({
          code: expect.stringMatching(/^(missing_permission|not_found)$/),
        });
      }
    }
  }
});

test("tunnel rejects owner bearer and invalid session origins before requiring a WebSocket upgrade", async ({
  f,
}) => {
  expect(tunnelRoute("/v0/ws")).toBe("agent");
  expect(tunnelRoute("/v0/ws?cursor=synthetic")).toBe("agent");
  await f.run(f.remote.enable({ hostname }));
  const bearer = await remoteRequest(f, "/v0/ws", {
    headers: { authorization: `Bearer ${f.token}`, origin: publicOrigin },
  });
  expect(bearer.status).toBe(403);
  expect(await bearer.json()).toMatchObject({ message: expect.stringContaining("owner bearer") });
  const headers = await ownerSession(f);
  const allowed = await remoteRequest(f, "/v0/ws", {
    headers: { cookie: headers.cookie, origin: publicOrigin },
  });
  expect(allowed.status).toBe(400);
  expect(await allowed.json()).toMatchObject({
    code: "validation_error",
    message: "A WebSocket upgrade is required.",
  });
  for (const origin of [undefined, "https://evil.test", `${publicOrigin}/`]) {
    const response = await remoteRequest(f, "/v0/ws", {
      headers: { cookie: headers.cookie, ...(origin === undefined ? {} : { origin }) },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "missing_permission" });
  }
});

test("path classification preserves router separators and ignores query data", () => {
  expect(tunnelPath("/v0/inboxes/Agent%40Example.test/?filter=%3b%23;x#y")).toBe(
    "/v0/inboxes/Agent%40Example.test",
  );
  expect(tunnelRoute("/v0/owner/login/")).toBe("auth");
  expect(tunnelRoute("/v0/inboxes/agent%2fapi-keys")).toBe("agent");
  expect(tunnelRoute("/v0/%6fwner/transport")).toBe("blocked");
  for (const path of ["/v0/domains;x", "/v0/domains#x", "/v0/domains%3Bx", "/v0/domains%23x"])
    expect(() => tunnelRoute(path), path).toThrow("Invalid tunnel path");
});

test("case-sensitive static routes preserve uppercase inbox parameters", async ({ f }) => {
  const inboxId = "Agent@Example.test";
  await f.run(
    f.store.use((db) =>
      db
        .prepare("UPDATE inboxes SET inbox_id = ? WHERE inbox_id = ?")
        .run(inboxId, "other@example.test"),
    ),
  );
  const local = await f.request(`/v0/inboxes/${encodeURIComponent(inboxId)}`);
  expect(local.status).toBe(200);
  expect(await local.json()).toMatchObject({ inbox_id: inboxId });
  await f.run(f.remote.enable({ hostname }));
  const key = await f.run(
    f.keys.create({
      inbox_ids: [inboxId],
      permissions: { inbox_read: true },
      send_policy: "read_only",
    }),
  );
  const tunneled = await remoteRequest(f, `/v0/inboxes/${encodeURIComponent(inboxId)}`, {
    headers: { authorization: `Bearer ${key.api_key}` },
  });
  expect(tunneled.status).toBe(200);
  expect(await tunneled.json()).toMatchObject({ inbox_id: inboxId });
  const mixed = await f.request("/v0/Inboxes", { method: "POST", body: {} });
  expect(mixed.status).toBe(404);
});

test("owner remote REST is local-only and schemas never disclose credentials", async ({ f }) => {
  const initial = await f.request("/v0/owner/remote");
  expect(Schema.decodeUnknownSync(RemoteStatus)(await initial.json()).state).toBe("disabled");
  const key = await f.run(
    f.keys.create({ permissions: { message_read: true }, send_policy: "read_only" }),
  );
  expect((await f.request("/v0/owner/remote", { token: key.api_key })).status).toBe(403);
  const response = await f.request("/v0/owner/remote/enable", {
    method: "POST",
    body: { hostname },
  });
  expect(response.status).toBe(200);
  const status = Schema.decodeUnknownSync(RemoteStatus)(await response.json());
  expect(status.state).toBe("connecting");
  expect(Object.keys(status).sort()).toEqual(["connector_version", "hostname", "reason", "state"]);
  expect(
    (
      await remoteRequest(f, "/v0/owner/remote", {
        headers: { authorization: `Bearer ${f.token}` },
      })
    ).status,
  ).toBe(403);
  const disabled = await f.request("/v0/owner/remote/disable", { method: "POST" });
  expect(Schema.decodeUnknownSync(RemoteStatus)(await disabled.json()).state).toBe("disabled");
  expect(
    (await remoteRequest(f, "/v0/inboxes", { headers: { authorization: `Bearer ${key.api_key}` } }))
      .status,
  ).toBe(403);
});

test("tunnel allowlist rejects management, encoded bypasses and prefix lookalikes", async ({
  f,
}) => {
  await f.run(f.remote.enable({ hostname }));
  const key = await f.run(
    f.keys.create({ permissions: { message_read: true }, send_policy: "read_only" }),
  );
  for (const path of [
    "/v0/owner/transport",
    "/v0/domains",
    "/v0/api-keys",
    "/v0/inboxes/agent%40example.test/api-keys",
    "/v0/owner/setup",
    "/v0/owner/login-links",
    "/v0/owner/login-links/redeem",
    "/v0/owner/remote/enable",
    "/v0/%6fwner/transport",
    "/v0/inboxes/x/%61pi-keys",
    "/mcp/tools",
  ]) {
    const response = await remoteRequest(f, path, {
      headers: { authorization: `Bearer ${key.api_key}` },
    });
    expect(response.status, path).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "missing_permission",
      message: expect.stringContaining("management"),
    });
  }
  for (const path of [
    "/v0//owner/transport",
    "/v0/%256fwner/transport",
    "/v0/owner%5ctransport",
    "/v0/%00owner/transport",
    "/v0/%ZZowner/transport",
  ]) {
    expect((await remoteRequest(f, path)).status, path).toBe(400);
  }
  for (const path of ["/v0evil", "/mcpevil", "/oauth-evil", "/.well-known-evil"]) {
    expect((await remoteRequest(f, path)).status, path).toBe(302);
  }
  expect(tunnelRoute("/oauth")).toBe("agent");
  expect(tunnelRoute("/.well-known/openid-configuration")).toBe("agent");
});

test("owner bearer is refused on every tunneled surface and loopback ignores forged proxy headers", async ({
  f,
}) => {
  await f.run(f.remote.enable({ hostname }));
  for (const path of [
    "/v0/inboxes",
    "/mcp",
    "/v0/owner/status",
    "/",
    "/oauth",
    "/.well-known/openid-configuration",
  ]) {
    const response = await remoteRequest(f, path, {
      headers: { authorization: `Bearer ${f.token}` },
    });
    expect(response.status, path).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "missing_permission",
      message: expect.stringContaining("owner bearer"),
    });
  }
  expect(
    (
      await f.request("/v0/owner/remote", {
        headers: {
          "cf-connecting-ip": "203.0.113.1",
          "x-forwarded-host": hostname,
          "x-forwarded-proto": "https",
        },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await remoteRequest(f, "/v0/inboxes", {
        headers: { host: new URL(f.url).host, authorization: `Bearer ${f.token}` },
      })
    ).status,
  ).toBe(403);
});

test("API keys retain inbox scope, send policy and public download links", async ({ f }) => {
  await f.run(f.remote.enable({ hostname }));
  const key = await f.run(
    f.keys.create({
      inbox_ids: ["agent@example.test"],
      permissions: { inbox_read: true, message_read: true, message_send: true },
      send_policy: "read_only",
    }),
  );
  const headers = { authorization: `Bearer ${key.api_key}` };
  const list = await remoteRequest(f, "/v0/inboxes", { headers });
  expect(
    list.status,
    JSON.stringify(list.status !== 200 ? await list.clone().json() : undefined),
  ).toBe(200);
  expect(await list.json()).toMatchObject({
    count: 1,
    inboxes: [{ inbox_id: "agent@example.test" }],
  });
  expect((await remoteRequest(f, "/v0/inboxes/other%40example.test", { headers })).status).toBe(
    404,
  );
  const messages = await (
    await remoteRequest(f, "/v0/inboxes/agent%40example.test/messages", { headers })
  ).json();
  const parsed = Schema.decodeUnknownSync(
    Schema.Struct({ messages: Schema.Array(Schema.Struct({ message_id: Schema.String })) }),
  )(messages);
  const id = parsed.messages[0]?.message_id;
  const raw = await remoteRequest(f, `/v0/inboxes/agent%40example.test/messages/${id}/raw`, {
    headers,
  });
  expect(raw.status).toBe(200);
  const download = Schema.decodeUnknownSync(Schema.Struct({ download_url: Schema.String }))(
    await raw.json(),
  );
  expect(download.download_url).toContain(`${publicOrigin}/v0/downloads/`);
  const downloaded = await remoteRequest(f, new URL(download.download_url).pathname, { headers });
  expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(f.raw);
  expect(
    (
      await remoteRequest(f, new URL(download.download_url).pathname, {
        headers: { authorization: `Bearer ${f.token}` },
      })
    ).status,
  ).toBe(403);
  const send = await remoteRequest(f, "/v0/inboxes/agent%40example.test/messages/send", {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      "idempotency-key": "synthetic-remote-send",
    },
    body: JSON.stringify({ to: ["recipient@example.test"], text: "Synthetic" }),
  });
  expect(send.status).toBe(403);
  expect(f.sent).toEqual([]);
});

test("public web uses owner login, secure cookies, host/origin checks and CSRF", async ({ f }) => {
  await f.run(f.remote.enable({ hostname }));
  const opening = await remoteRequest(f, "/mail");
  expect(
    opening.headers.get("location"),
    JSON.stringify(opening.status === 403 ? await opening.json() : undefined),
  ).toBe("/login");
  expect((await remoteRequest(f, "/login")).status).toBe(200);
  const setup = await f.request("/v0/owner/setup", {
    token: null,
    method: "POST",
    body: { password, code: f.setupCode },
  });
  expect(setup.status).toBe(200);
  const login = await remoteRequest(f, "/v0/owner/login", {
    method: "POST",
    headers: { origin: publicOrigin, "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie") ?? "";
  expect(cookie).toContain("__Host-inbot_session=");
  expect(cookie).toContain("Secure");
  const session = Schema.decodeUnknownSync(Schema.Struct({ csrf_token: Schema.String }))(
    await login.json(),
  );
  const headers = { cookie: cookie.split(";")[0] ?? "", origin: publicOrigin };
  expect((await remoteRequest(f, "/mail", { headers })).status).toBe(200);
  const status = await remoteRequest(f, "/v0/owner/status", { headers });
  expect(await status.json()).toMatchObject({ authenticated: true });
  expect((await remoteRequest(f, "/v0/owner/logout", { method: "POST", headers })).status).toBe(
    403,
  );
  expect(
    (
      await remoteRequest(f, "/v0/inboxes", {
        headers: { ...headers, origin: "https://evil.test" },
      })
    ).status,
  ).toBe(403);
  expect(
    (await remoteRequest(f, "/v0/inboxes", { headers: { ...headers, host: "evil.test" } })).status,
  ).toBe(403);
  expect((await remoteRequest(f, "/v0/owner/transport", { headers })).status).toBe(403);
  const logout = await remoteRequest(f, "/v0/owner/logout", {
    method: "POST",
    headers: { ...headers, "x-inbot-csrf": session.csrf_token },
  });
  expect(logout.status).toBe(200);
  expect(logout.headers.get("set-cookie")).toContain("__Host-inbot_session=");
  expect((await remoteRequest(f, "/mail", { headers })).status).toBe(302);
});

test("tunneled MCP accepts the validated public origin and exposes only agent tools", async ({
  f,
}) => {
  await f.run(f.remote.enable({ hostname }));
  const key = await f.run(
    f.keys.create({
      inbox_ids: ["agent@example.test"],
      permissions: { inbox_read: true, message_read: true },
      send_policy: "read_only",
    }),
  );
  const headers = {
    authorization: `Bearer ${key.api_key}`,
    origin: publicOrigin,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const initialize = await remoteRequest(f, "/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "synthetic", version: "1" },
      },
    }),
  });
  expect(initialize.status).toBe(200);
  const sessionId = initialize.headers.get("mcp-session-id");
  const sessionHeaders = { ...headers, ...(sessionId ? { "mcp-session-id": sessionId } : {}) };
  const tools = await remoteRequest(f, "/mcp", {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  expect(tools.status).toBe(200);
  const list = await tools.text();
  expect(list).toContain("list_inboxes");
  expect(list).not.toContain("remote_enable");
  expect(list).not.toContain("approve_draft");
  const call = await remoteRequest(f, "/mcp", {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_inboxes", arguments: {} },
    }),
  });
  expect(call.status).toBe(200);
  const result = await call.text();
  expect(result).toContain("agent@example.test");
  expect(result).not.toContain("other@example.test");
  const denied = await remoteRequest(f, "/mcp", {
    method: "POST",
    headers: { ...sessionHeaders, origin: "https://evil.test" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
  });
  expect(denied.status).toBe(403);
});

test("transport cannot be cleared or moved while remote resources remain", async ({ f }) => {
  await f.run(f.remote.enable({ hostname }));
  const clear = await f.request("/v0/owner/transport", { method: "DELETE" });
  expect(clear.status).toBe(409);
  expect(await clear.json()).toMatchObject({
    code: "action_required",
    fix: expect.stringContaining("Disable remote access"),
  });
  const move = await f.request("/v0/owner/transport", {
    method: "PUT",
    body: { account_id: "a".repeat(32), api_token: "synthetic-token" },
  });
  expect(move.status).toBe(409);
  expect(await move.json()).toMatchObject({ code: "action_required" });
  await f.run(f.remote.disable());
  expect((await f.request("/v0/owner/transport", { method: "DELETE" })).status).toBe(200);
});

test("tunnel WebSocket upgrades reject owner bearer before accepting scoped agent keys", async ({
  f,
}) => {
  await f.run(f.remote.enable({ hostname }));
  expect(
    await websocketHandshake(f.tunnelUrl, {
      host: hostname,
      authorization: `Bearer ${f.token}`,
    }),
  ).toBe(403);
  expect(await websocketHandshake(f.url, { authorization: `Bearer ${f.token}` })).toBe(101);
  const key = await f.run(
    f.keys.create({
      inbox_ids: ["agent@example.test"],
      permissions: { message_read: true },
      send_policy: "read_only",
    }),
  );
  const headers = { host: hostname, authorization: `Bearer ${key.api_key}` };
  expect(await websocketHandshake(f.tunnelUrl, headers)).toBe(101);
  expect(await websocketHandshake(f.tunnelUrl, { ...headers, origin: "https://evil.test" })).toBe(
    403,
  );
  const unreadable = await f.run(
    f.keys.create({ permissions: { inbox_read: true }, send_policy: "read_only" }),
  );
  expect(
    await websocketHandshake(f.tunnelUrl, {
      host: hostname,
      authorization: `Bearer ${unreadable.api_key}`,
    }),
  ).toBe(403);
});

test("tunnel owner WebSocket upgrades require exact public origin and CSRF subprotocol", async ({
  f,
}) => {
  await f.run(f.remote.enable({ hostname }));
  const session = await ownerSession(f);
  const headers = {
    host: hostname,
    cookie: session.cookie,
    "sec-websocket-protocol": `inbot.events, csrf.${session["x-inbot-csrf"]}`,
  };
  expect(await websocketHandshake(f.tunnelUrl, headers)).toBe(403);
  expect(await websocketHandshake(f.tunnelUrl, { ...headers, origin: "https://evil.test" })).toBe(
    403,
  );
  expect(
    await websocketHandshake(f.tunnelUrl, {
      ...headers,
      origin: publicOrigin,
      "sec-websocket-protocol": "inbot.events, csrf.invalid",
    }),
  ).toBe(403);
  expect(await websocketHandshake(f.tunnelUrl, { ...headers, origin: publicOrigin })).toBe(101);
});

test("tunneled lists and webhooks preserve agent permissions and inbox scope", async ({ f }) => {
  await f.run(f.remote.enable({ hostname }));
  const key = await f.run(
    f.keys.create({
      inbox_ids: ["agent@example.test"],
      permissions: {
        list_entry_read: true,
        list_entry_create: true,
        webhook_read: true,
        webhook_create: true,
      },
      send_policy: "read_only",
    }),
  );
  const headers = { authorization: `Bearer ${key.api_key}`, "content-type": "application/json" };
  const lists = "/v0/inboxes/agent%40example.test/lists/receive/block";
  const webhooks = "/v0/inboxes/agent%40example.test/webhooks";
  expect((await remoteRequest(f, lists, { headers })).status).toBe(200);
  expect((await remoteRequest(f, webhooks, { headers })).status).toBe(200);
  expect(
    (
      await remoteRequest(f, lists, {
        method: "POST",
        headers,
        body: JSON.stringify({ entry: "blocked.test" }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await remoteRequest(f, webhooks, {
        method: "POST",
        headers,
        body: JSON.stringify({
          url: "https://receiver.example.test/events",
          event_types: ["message.received"],
        }),
      })
    ).status,
  ).toBe(200);
  for (const path of [lists, webhooks]) {
    expect((await remoteRequest(f, path.replace("agent%40", "other%40"), { headers })).status).toBe(
      404,
    );
  }
  expect((await remoteRequest(f, "/v0/lists/receive/block", { headers })).status).toBe(403);
  expect((await remoteRequest(f, "/v0/webhooks", { headers })).status).toBe(200);
  const unreadable = await f.run(
    f.keys.create({ permissions: { message_read: true }, send_policy: "read_only" }),
  );
  for (const path of [lists, webhooks]) {
    expect(
      (
        await remoteRequest(f, path, {
          headers: { authorization: `Bearer ${unreadable.api_key}` },
        })
      ).status,
    ).toBe(403);
  }
});

test("valid tunnel owner sessions cannot access local management routes", async ({ f }) => {
  await f.run(f.remote.enable({ hostname }));
  const headers = await ownerSession(f);
  for (const path of [
    "/v0/owner/transport",
    "/v0/owner/remote",
    "/v0/domains",
    "/v0/api-keys",
    "/v0/inboxes/agent%40example.test/api-keys",
  ]) {
    const response = await remoteRequest(f, path, { headers });
    expect(response.status, path).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "missing_permission",
      message: expect.stringContaining("management"),
    });
  }
});
