import { mkdtemp, rm, mkdir, writeFile, symlink, readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, test as base } from "vitest";
import { CreateApiKeyResponse } from "../../../../packages/contracts/src/api-keys.js";
import {
  OwnerSessionResponse,
  OwnerSessionsResponse,
  OwnerStatus,
  OwnerLoginLink,
} from "../../../../packages/contracts/src/owner.js";
import { cookieName, sessionCookie } from "./owner-session.js";
import { HttpServerResponse } from "effect/http";
import { fixture } from "./test-fixture.js";

const password = "synthetic owner password";
const test = base.extend<{ api: Awaited<ReturnType<typeof fixture>> }>({
  api: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-owner-"));
    const api = await fixture(home);
    try {
      await use(api);
    } finally {
      await api.close();
      await rm(home, { recursive: true, force: true });
    }
  },
});
async function decode<A>(response: Response, schema: Schema.Codec<A>) {
  expect(response.status).toBe(200);
  return Schema.decodeUnknownSync(schema)(await response.json());
}
async function signIn(api: Awaited<ReturnType<typeof fixture>>, setup = true) {
  const response = await api.request(`/v0/owner/${setup ? "setup" : "login"}`, {
    token: null,
    method: "POST",
    body: { password, ...(setup ? { code: api.setupCode } : {}) },
  });
  const body = await decode(response, OwnerSessionResponse);
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null) throw new Error("Expected a session cookie");
  return {
    body,
    setCookie,
    cookie: setCookie.split(";")[0] ?? "",
    headers: { cookie: setCookie.split(";")[0] ?? "", "x-inbot-csrf": body.csrf_token },
  };
}

test("requires a one-time setup code and stores only password and session hashes", async ({
  api,
}) => {
  expect(await decode(await api.request("/v0/owner/status", { token: null }), OwnerStatus)).toEqual(
    { setup_required: true, authenticated: false, locked: false },
  );
  for (const body of [
    { password },
    { password, code: "wrong" },
    { password: "short", code: api.setupCode },
  ]) {
    const result = await api.request("/v0/owner/setup", { token: null, method: "POST", body });
    expect(result.status).toBe("code" in body && body.code === "wrong" ? 401 : 400);
  }
  const session = await signIn(api);
  expect(session.setCookie).toContain("HttpOnly");
  expect(session.setCookie).toContain("SameSite=Strict");
  expect(session.setCookie).toContain("Path=/");
  expect(session.setCookie).not.toContain("Secure");
  expect(session.setCookie).not.toContain("Domain=");
  expect(
    await decode(
      await api.request("/v0/owner/status", { token: null, headers: { cookie: session.cookie } }),
      OwnerStatus,
    ),
  ).toEqual({ setup_required: false, authenticated: true, locked: false });
  expect(
    (
      await api.request("/v0/owner/setup", {
        token: null,
        method: "POST",
        body: { password, code: api.setupCode },
      })
    ).status,
  ).toBe(409);
  const rows = await api.run(
    api.store.use((db) => ({
      account: db.prepare("SELECT * FROM owner_account").all(),
      sessions: db.prepare("SELECT * FROM owner_sessions").all(),
      version: db.pragma("user_version", { simple: true }),
    })),
  );
  expect(rows.version).toBe(10);
  expect(JSON.stringify(rows)).not.toContain(password);
  expect(JSON.stringify(rows)).not.toContain(session.cookie.split("=")[1]);
  expect(await readFile(join(api.home, "inbot.db"), "utf8")).not.toContain("owner_sessions");
});

test("supports owner cookies, enforces CSRF and origin, and preserves agent credential priority", async ({
  api,
}) => {
  const session = await signIn(api);
  expect(
    (await api.request("/v0/api-keys", { token: null, headers: { cookie: session.cookie } }))
      .status,
  ).toBe(200);
  const status = await api.request("/v0/owner/status", {
    token: null,
    headers: { cookie: session.cookie },
  });
  expect(status.headers.get("x-inbot-csrf")).toBe(session.body.csrf_token);
  expect(
    Object.values(Schema.decodeUnknownSync(OwnerStatus)(await status.json())).every(
      (value) => typeof value === "boolean",
    ),
  ).toBe(true);
  const body = {
    name: "Cookie key",
    permissions: { message_read: true },
    send_policy: "read_only",
  };
  for (const headers of [
    { cookie: session.cookie },
    { cookie: session.cookie, "x-inbot-csrf": "invalid" },
    { ...session.headers, origin: "https://foreign.example" },
  ])
    expect(
      (await api.request("/v0/api-keys", { token: null, method: "POST", body, headers })).status,
    ).toBe(403);
  const key = await decode(
    await api.request("/v0/api-keys", {
      token: null,
      method: "POST",
      body,
      headers: { ...session.headers, origin: api.url },
    }),
    CreateApiKeyResponse,
  );
  expect(
    (await api.request("/v0/api-keys", { token: key.api_key, headers: { cookie: session.cookie } }))
      .status,
  ).toBe(403);
  for (const path of ["/v0/owner/status", "/v0/owner/sessions", "/v0/%6fwner/status"])
    expect(
      (await api.request(path, { token: key.api_key, headers: { cookie: session.cookie } })).status,
    ).toBe(403);
  expect(
    (await api.request("/v0/inboxes", { token: key.api_key, headers: { cookie: session.cookie } }))
      .status,
  ).toBe(403);
  expect(
    (
      await api.request("/v0/inboxes", {
        token: null,
        headers: { cookie: `inbot_session=${key.api_key}` },
      })
    ).status,
  ).toBe(401);
  expect(
    (await api.request("/v0/api-keys", { token: "invalid", headers: { cookie: session.cookie } }))
      .status,
  ).toBe(401);
  expect(
    (
      await api.request("/v0/owner/login-links", {
        token: null,
        method: "POST",
        headers: session.headers,
      })
    ).status,
  ).toBe(403);
  expect((await api.request("/v0/api-keys", { method: "POST", body })).status).toBe(200);
  const raw = Schema.decodeUnknownSync(Schema.Struct({ download_url: Schema.String }))(
    await (
      await api.request(
        `/v0/inboxes/agent@example.test/messages/${encodeURIComponent("<first@example.test>")}/raw`,
        { token: null, headers: session.headers },
      )
    ).json(),
  );
  const downloaded = await fetch(raw.download_url, { headers: { cookie: session.cookie } });
  expect(downloaded.status).toBe(200);
  expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(api.raw);
});

test("logs in, limits password failures, and revokes a session on logout", async ({ api }) => {
  await signIn(api);
  expect(
    (
      await api.request("/v0/owner/login", {
        token: null,
        method: "POST",
        body: { password: "wrong" },
      })
    ).status,
  ).toBe(401);
  expect(
    (await api.request("/v0/owner/login", { token: null, method: "POST", body: { password } }))
      .status,
  ).toBe(429);
  api.advance(1000);
  const session = await signIn(api, false);
  expect(
    (
      await api.request("/v0/owner/logout", {
        token: null,
        method: "POST",
        headers: { cookie: session.cookie },
      })
    ).status,
  ).toBe(403);
  const logout = await api.request("/v0/owner/logout", {
    token: null,
    method: "POST",
    headers: session.headers,
  });
  expect(logout.status).toBe(200);
  expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(
    (await api.request("/v0/api-keys", { token: null, headers: session.headers })).status,
  ).toBe(401);
});

test("slides active sessions while enforcing inactivity and absolute expiry", async ({ api }) => {
  const session = await signIn(api);
  const day = 24 * 60 * 60_000;
  api.advance(13 * day);
  const refreshed = await api.request("/v0/api-keys", { token: null, headers: session.headers });
  expect(refreshed.status).toBe(200);
  expect(refreshed.headers.get("set-cookie")).not.toBe(session.setCookie);
  api.advance(13 * day);
  expect(
    (await api.request("/v0/api-keys", { token: null, headers: session.headers })).status,
  ).toBe(200);
  api.advance(4 * day);
  expect(
    (await api.request("/v0/api-keys", { token: null, headers: session.headers })).status,
  ).toBe(401);
  const idle = await signIn(api, false);
  api.advance(14 * day);
  expect((await api.request("/v0/api-keys", { token: null, headers: idle.headers })).status).toBe(
    401,
  );
});

test("requires the current password, revokes other sessions, and supports explicit session revocation", async ({
  api,
}) => {
  const current = await signIn(api);
  const other = await signIn(api, false);
  const list = await decode(
    await api.request("/v0/owner/sessions", { token: null, headers: current.headers }),
    OwnerSessionsResponse,
  );
  expect(list.sessions).toHaveLength(2);
  const currentRow = list.sessions.find((session) => session.current);
  if (currentRow === undefined) throw new Error("Expected a current session");
  expect(list.sessions.every((session) => /^[a-f0-9]{64}$/.test(session.user_agent))).toBe(true);
  const next = "a changed synthetic password";
  expect(
    (
      await api.request("/v0/owner/password", {
        token: null,
        method: "POST",
        headers: current.headers,
        body: { current_password: "wrong", password: next },
      })
    ).status,
  ).toBe(401);
  expect((await api.request("/v0/api-keys", { token: null, headers: other.headers })).status).toBe(
    200,
  );
  api.advance(1000);
  expect(
    (
      await api.request("/v0/owner/password", {
        token: null,
        method: "POST",
        headers: current.headers,
        body: { current_password: password, password: next },
      })
    ).status,
  ).toBe(200);
  expect(
    (await api.request("/v0/api-keys", { token: null, headers: current.headers })).status,
  ).toBe(200);
  expect((await api.request("/v0/api-keys", { token: null, headers: other.headers })).status).toBe(
    401,
  );
  expect(
    (await api.request("/v0/owner/login", { token: null, method: "POST", body: { password } }))
      .status,
  ).toBe(401);
  api.advance(1000);
  const newLogin = await api.request("/v0/owner/login", {
    token: null,
    method: "POST",
    body: { password: next },
  });
  expect(newLogin.status).toBe(200);
  const revoked = await api.request(`/v0/owner/sessions/${currentRow.id}`, {
    token: null,
    method: "DELETE",
    headers: current.headers,
  });
  expect(revoked.status).toBe(200);
  expect(revoked.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(
    (await api.request("/v0/api-keys", { token: null, headers: current.headers })).status,
  ).toBe(401);
});

test("redeems owner bearer login links once and enforces their two-minute expiry", async ({
  api,
}) => {
  await signIn(api);
  const makeLink = async () => {
    const body = await decode(
      await api.request("/v0/owner/login-links", { method: "POST" }),
      OwnerLoginLink,
    );
    expect(body.url.startsWith(`${api.url}/login?token=`)).toBe(true);
    const token = new URL(body.url).searchParams.get("token");
    if (token === null) throw new Error("Expected a link token");
    return token;
  };
  const token = await makeLink();
  const redeem = () =>
    api.request("/v0/owner/login-links/redeem", { token: null, method: "POST", body: { token } });
  const [first, second] = await Promise.all([redeem(), redeem()]);
  expect([first.status, second.status].sort()).toEqual([200, 401]);
  const success = first.status === 200 ? first : second;
  expect(success.headers.get("set-cookie")).toContain("HttpOnly");
  const expired = await makeLink();
  api.advance(120_000);
  expect(
    (
      await api.request("/v0/owner/login-links/redeem", {
        token: null,
        method: "POST",
        body: { token: expired },
      })
    ).status,
  ).toBe(401);
});

test("uses secure host-only cookies for HTTPS origins", () => {
  const response = sessionCookie(HttpServerResponse.empty(), "https://inbot.example", {
    token: "synthetic",
    expires_at: "2026-11-01T00:00:00Z",
  });
  const cookie = response.cookies.cookies[cookieName("https://inbot.example")];
  expect(cookie?.name).toBe("__Host-inbot_session");
  expect(cookie?.options).toMatchObject({
    secure: true,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
  });
  expect(cookie?.options?.domain).toBeUndefined();
});

function rawRequest(url: string, path: string) {
  return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const request = httpRequest(new URL(url), { path }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    request.once("error", reject);
    request.end();
  });
}
test("serves only the explicit web root, excludes API paths, and rejects traversal and escaped symlinks", async () => {
  const home = await mkdtemp(join(tmpdir(), "inbot-web-"));
  const root = join(home, "web");
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), "<html><body>Synthetic owner UI</body></html>");
  await writeFile(join(root, "assets", "app-a1b2c3d4.js"), "console.log('synthetic');");
  await writeFile(join(root, "assets", "app-a1b2c3d4.css"), "body { color: navy; }");
  await writeFile(join(home, "outside.txt"), "PRIVATE SYNTHETIC DATA");
  await symlink(join(home, "outside.txt"), join(root, "escaped.txt"));
  const api = await fixture(home, { webRoot: root });
  try {
    for (const path of ["/", "/login", "/settings/sessions"]) {
      const response = await api.request(path, { token: null });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Synthetic owner UI");
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(response.headers.get("content-security-policy")).toContain("base-uri 'none'");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("cache-control")).toBe("no-cache");
    }
    for (const [path, type] of [
      ["/assets/app-a1b2c3d4.js", "text/javascript"],
      ["/assets/app-a1b2c3d4.css", "text/css"],
    ]) {
      const response = await api.request(path ?? "", { token: null });
      expect(response.headers.get("content-type")).toContain(type);
      expect(response.headers.get("cache-control")).toContain("immutable");
    }
    for (const path of [
      "/v0",
      "/v0/unknown",
      "/mcp/unknown",
      "/oauth",
      "/oauth/unknown",
      "/.well-known",
      "/.well-known/unknown",
      "/%76%30/unknown",
    ]) {
      const response = await api.request(path);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("Synthetic owner UI");
    }
    expect((await api.request("/v0/owner/status", { token: null })).status).toBe(200);
    expect((await api.request("/v0/api-keys")).status).toBe(200);
    for (const path of [
      "/..%2f..",
      "/%2e%2e%2foutside.txt",
      "/%252e%252e%252foutside.txt",
      "/%2e%2e/outside.txt",
      "/../outside.txt",
      "/..%5coutside.txt",
      "/%00",
      "/%",
      "/escaped.txt",
    ]) {
      const response = await rawRequest(api.url, path);
      expect(response.status, path).toBe(400);
      expect(response.body).not.toContain("PRIVATE SYNTHETIC DATA");
    }
  } finally {
    await api.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("does not serve a UI when no web root was supplied", async ({ api }) => {
  expect((await api.request("/", { token: null })).status).toBe(404);
});

test("preserves the account and sessions across a server restart and drops pending login links", async ({
  api,
}) => {
  const session = await signIn(api);
  const link = await decode(
    await api.request("/v0/owner/login-links", { method: "POST" }),
    OwnerLoginLink,
  );
  const restarted = await api.restart();
  try {
    expect(restarted.setupCode).toBeUndefined();
    expect(
      await decode(
        await fetch(`${restarted.url}/v0/owner/status`, { headers: { cookie: session.cookie } }),
        OwnerStatus,
      ),
    ).toEqual({ setup_required: false, authenticated: true, locked: false });
    expect(
      (await fetch(`${restarted.url}/v0/api-keys`, { headers: { cookie: session.cookie } })).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${restarted.url}/v0/owner/login-links/redeem`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: new URL(link.url).searchParams.get("token") }),
        })
      ).status,
    ).toBe(401);
  } finally {
    await restarted.close();
  }
});

test("serializes concurrent setup attempts without replacing the owner password", async ({
  api,
}) => {
  const setup = (value: string) =>
    api.request("/v0/owner/setup", {
      token: null,
      method: "POST",
      body: { password: value, code: api.setupCode },
    });
  const results = await Promise.all([setup(password), setup("another synthetic password")]);
  expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
  expect(
    await api.run(api.store.use((db) => db.prepare("SELECT id FROM owner_account").all())),
  ).toHaveLength(1);
  expect(
    await api.run(api.store.use((db) => db.prepare("SELECT id FROM owner_sessions").all())),
  ).toHaveLength(1);
});

test("backs off exponentially after repeated password failures", async ({ api }) => {
  await signIn(api);
  const login = (value: string) =>
    api.request("/v0/owner/login", { token: null, method: "POST", body: { password: value } });
  expect((await login("wrong")).status).toBe(401);
  api.advance(1000);
  expect((await login("wrong")).status).toBe(401);
  api.advance(1000);
  expect((await login(password)).status).toBe(429);
  api.advance(1000);
  expect((await login(password)).status).toBe(200);
});
