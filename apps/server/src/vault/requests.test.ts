import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { expect, test as base, vi } from "vitest";
import {
  CredentialRequest,
  ListCredentialRequestsResponse,
} from "../../../../packages/contracts/src/credential-requests.js";
import { CurrentPrincipal, type Principal } from "../../../../packages/contracts/src/security.js";
import { eventReadable, readEvents } from "../events/log.js";
import { fixture } from "../http/test-fixture.js";
import { TunnelTraffic } from "../http/tunnel-policy.js";
import { migrate } from "../store.js";
import { normalizeTotp } from "./totp.js";
import { makeCredentialRequests } from "./requests.js";
import { makeVault } from "./vault.js";

const inboxId = "agent@example.test";
const otherId = "other@example.test";
const owner: Principal = { kind: "owner" };
const input = {
  name: "Existing account",
  url: "https://example.test/login",
  username: "agent",
  fields: ["password", "totp"],
  reason: "<script>agent-authored reason</script>",
};
const secret = "request-distinctive-password-f3L";
const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const uri = `otpauth://totp/Test?secret=${seed}&algorithm=SHA1&digits=8&period=30`;
const lifetime = 7 * 24 * 60 * 60_000;
const test = base.extend<{ api: Awaited<ReturnType<typeof fixture>> }>({
  api: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-credential-requests-"));
    try {
      const api = await fixture(home);
      try {
        await use(api);
      } finally {
        await api.close();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
});
function run<A, E>(
  api: Awaited<ReturnType<typeof fixture>>,
  effect: Effect.Effect<A, E, CurrentPrincipal>,
  principal: Principal = owner,
) {
  return api.run(effect.pipe(Effect.provideService(CurrentPrincipal, principal)));
}
async function agent(api: Awaited<ReturnType<typeof fixture>>, allowed = true) {
  const key = await api.run(
    api.keys.create({
      inbox_ids: [inboxId],
      permissions: { credential_request: allowed },
      send_policy: "read_only",
    }),
  );
  const principal: Principal = { kind: "agent", api_key_id: key.api_key_id, grant: key };
  return { token: key.api_key, principal };
}
async function create(api: Awaited<ReturnType<typeof fixture>>, token: string) {
  const response = await api.request(`/v0/inboxes/${inboxId}/credential-requests`, {
    token,
    method: "POST",
    body: input,
  });
  expect(response.status).toBe(200);
  return Schema.decodeUnknownSync(CredentialRequest, { onExcessProperty: "error" })(
    await response.json(),
  );
}
async function error(response: Response, code: string, status: number) {
  expect(response.status).toBe(status);
  const payload: unknown = await response.json();
  expect(payload).toMatchObject({ code, fix: expect.any(String) });
  noSecrets(payload);
}
function noSecrets(value: unknown) {
  const json = JSON.stringify(value);
  for (const value of [secret, seed, uri, normalizeTotp(uri)]) expect(json).not.toContain(value);
}

test("creates pending requests and conceals other keys and foreign inboxes on REST and service", async ({
  api,
}) => {
  const requests = makeCredentialRequests(api.store);
  const first = await agent(api);
  const second = await agent(api);
  const denied = await agent(api, false);
  const request = await create(api, first.token);
  expect(request).toMatchObject({
    ...input,
    state: "pending",
    expires_at: new Date(Date.parse(request.created_at) + lifetime).toISOString(),
  });
  expect(request.requested_by).toBeUndefined();
  const path = `/v0/inboxes/${inboxId}/credential-requests/${request.request_id}`;
  for (const token of [second.token, first.token]) {
    const foreign =
      token === second.token
        ? path
        : `/v0/inboxes/${otherId}/credential-requests/${request.request_id}`;
    await error(await api.request(foreign, { token }), "not_found", 404);
  }
  expect((await run(api, requests.list(), second.principal)).credential_requests).toEqual([]);
  expect((await run(api, requests.list(), first.principal)).credential_requests).toEqual([request]);
  expect(
    await run(api, Effect.result(requests.get(request.request_id, inboxId)), second.principal),
  ).toMatchObject({ failure: { code: "not_found" } });
  await error(
    await api.request(`/v0/inboxes/${otherId}/credential-requests`, {
      token: first.token,
      method: "POST",
      body: input,
    }),
    "not_found",
    404,
  );
  for (const operation of [
    requests.create(input, inboxId).pipe(Effect.asVoid),
    requests.get(request.request_id, inboxId).pipe(Effect.asVoid),
    requests.list().pipe(Effect.asVoid),
  ])
    expect(await run(api, Effect.result(operation), denied.principal)).toMatchObject({
      failure: { code: "missing_permission" },
    });
  for (const [url, method, body] of [
    [path, "GET", undefined],
    ["/v0/credential-requests", "GET", undefined],
    [`/v0/inboxes/${inboxId}/credential-requests`, "POST", input],
  ] as const)
    await error(
      await api.request(url, {
        token: denied.token,
        method,
        ...(body === undefined ? {} : { body }),
      }),
      "missing_permission",
      403,
    );
  await error(
    await api.request(`/v0/inboxes/${inboxId}/credential-requests`, {
      method: "POST",
      body: input,
    }),
    "validation_error",
    400,
  );
  const ownerResponse = Schema.decodeUnknownSync(CredentialRequest)(
    await (await api.request(path)).json(),
  );
  expect(ownerResponse.requested_by).toBe(first.principal.api_key_id);
  expect(ownerResponse.reason).toBe(input.reason);
  for (const url of ["http://public.test", "https://user:password@example.test", "not-a-url"])
    await error(
      await api.request(`/v0/inboxes/${inboxId}/credential-requests`, {
        token: first.token,
        method: "POST",
        body: { ...input, url },
      }),
      "validation_error",
      400,
    );
});

test("fulfills atomically with exact normalized fields and exposes only metadata to agents and event consumers", async ({
  api,
}) => {
  const logs = [
    vi.spyOn(console, "log").mockImplementation(() => undefined),
    vi.spyOn(console, "info").mockImplementation(() => undefined),
    vi.spyOn(console, "warn").mockImplementation(() => undefined),
    vi.spyOn(console, "error").mockImplementation(() => undefined),
  ];
  try {
    const first = await agent(api);
    const second = await agent(api);
    const request = await create(api, first.token);
    const requests = makeCredentialRequests(api.store);
    const path = `/v0/credential-requests/${request.request_id}`;
    for (const fields of [
      { password: secret },
      { password: secret, totp: uri, extra: "unexpected" },
      { password: secret, totp: "invalid-seed" },
    ])
      await error(
        await api.request(`${path}/fulfill`, { method: "POST", body: { fields } }),
        "validation_error",
        400,
      );
    for (const action of ["fulfill", "decline"])
      await error(
        await api.request(`${path}/${action}`, {
          token: first.token,
          method: "POST",
          ...(action === "fulfill" ? { body: { fields: { password: secret, totp: uri } } } : {}),
        }),
        "missing_permission",
        403,
      );
    expect(
      await run(
        api,
        Effect.result(
          requests.fulfill(request.request_id, { fields: { password: secret, totp: uri } }),
        ),
        first.principal,
      ),
    ).toMatchObject({ failure: { code: "missing_permission" } });
    expect(
      await run(api, Effect.result(requests.decline(request.request_id)), first.principal),
    ).toMatchObject({ failure: { code: "missing_permission" } });
    for (const principal of [owner, first.principal])
      expect(
        await run(
          api,
          Effect.result(
            requests
              .fulfill(request.request_id, { fields: { password: secret, totp: uri } })
              .pipe(Effect.provideService(TunnelTraffic, true)),
          ),
          principal,
        ),
      ).toMatchObject({
        failure: { code: "missing_permission", fix: expect.stringContaining("Inbot host") },
      });
    const fulfilled = Schema.decodeUnknownSync(CredentialRequest)(
      await (
        await api.request(`${path}/fulfill`, {
          method: "POST",
          body: { fields: { password: secret, totp: uri }, username: "owner override" },
        })
      ).json(),
    );
    expect(fulfilled.state).toBe("fulfilled");
    const credential = fulfilled.credential;
    if (credential === undefined) throw new Error("Expected fulfilled credential");
    expect(credential).toMatchObject({
      name: input.name,
      url: input.url,
      username: "owner override",
      fields: input.fields,
      origins: ["https://example.test"],
    });
    expect(credential.refs).toEqual(
      Object.fromEntries(
        input.fields.map((field) => [
          field,
          `inbot://credentials/${credential.credential_id}/${field}`,
        ]),
      ),
    );
    expect(
      (await run(api, makeVault(api.store).reveal(credential.credential_id, inboxId))).fields,
    ).toEqual({ password: secret, totp: normalizeTotp(uri) });
    expect(
      await api.run(
        api.store.use((db) =>
          db
            .prepare("SELECT created_by FROM credentials WHERE credential_id = ?")
            .get(credential.credential_id),
        ),
      ),
    ).toEqual({ created_by: null });
    const agentResponse = await run(
      api,
      requests.get(request.request_id, inboxId),
      first.principal,
    );
    expect(agentResponse.credential).toEqual(credential);
    expect(agentResponse.requested_by).toBeUndefined();
    const agentHttp = await (
      await api.request(`/v0/inboxes/${inboxId}/credential-requests/${request.request_id}`, {
        token: first.token,
      })
    ).json();
    const listed = await (
      await api.request("/v0/credential-requests?state=fulfilled", { token: first.token })
    ).json();
    await error(
      await api.request(`${path}/fulfill`, {
        method: "POST",
        body: { fields: { password: secret, totp: uri } },
      }),
      "validation_error",
      400,
    );
    await error(await api.request(`${path}/decline`, { method: "POST" }), "validation_error", 400);
    const events = await api.run(api.store.use((db) => readEvents(db, 0)));
    const requestEvents = events.filter((row) => "credential_request" in row.payload);
    expect(requestEvents.map((row) => row.event_type)).toEqual([
      "credential.requested",
      "credential.request_fulfilled",
    ]);
    expect(events.filter((row) => row.event_type === "credential.created")).toHaveLength(1);
    for (const row of requestEvents) {
      const visibility = await api.run(
        api.store.use((db) => [
          eventReadable(db, row, owner),
          eventReadable(db, row, first.principal),
          eventReadable(db, row, second.principal),
          eventReadable(db, row, {
            ...first.principal,
            grant: { ...first.principal.grant, inbox_ids: [otherId] },
          }),
          eventReadable(db, row, {
            ...first.principal,
            grant: { ...first.principal.grant, permissions: {} },
          }),
        ]),
      );
      expect(visibility).toEqual([true, true, false, false, false]);
      expect(JSON.stringify(row)).not.toContain(input.reason);
      expect(JSON.stringify(row)).not.toContain(first.principal.api_key_id);
    }
    noSecrets([
      fulfilled,
      agentResponse,
      agentHttp,
      listed,
      events,
      logs.map((log) => log.mock.calls),
    ]);
    await run(api, makeVault(api.store).delete(credential.credential_id, inboxId));
    expect(
      await run(api, requests.get(request.request_id, inboxId), first.principal),
    ).toMatchObject({ state: "fulfilled" });
    expect(
      (await run(api, requests.get(request.request_id, inboxId), first.principal)).credential,
    ).toBeUndefined();
  } finally {
    for (const log of logs) log.mockRestore();
  }
});

test("declines idempotently and expires at seven days even when a decision fails", async ({
  api,
}) => {
  const first = await agent(api);
  const requests = makeCredentialRequests(api.store);
  const request = await create(api, first.token);
  const declined = await run(api, requests.decline(request.request_id));
  expect(declined).toMatchObject({ state: "declined", decided_at: request.created_at });
  expect(await run(api, requests.decline(request.request_id))).toEqual(declined);
  expect(
    await run(
      api,
      Effect.result(
        requests.fulfill(request.request_id, { fields: { password: secret, totp: uri } }),
      ),
    ),
  ).toMatchObject({ failure: { code: "validation_error" } });
  expect(
    (await api.run(api.store.use((db) => readEvents(db, 0)))).filter(
      (row) => row.event_type === "credential.request_declined",
    ),
  ).toHaveLength(1);
  const pending = await create(api, first.token);
  api.advance(lifetime - 1);
  expect((await run(api, requests.get(pending.request_id, inboxId), first.principal)).state).toBe(
    "pending",
  );
  api.advance(1);
  expect(
    await run(
      api,
      Effect.result(
        requests.fulfill(pending.request_id, { fields: { password: secret, totp: uri } }),
      ),
    ),
  ).toMatchObject({ failure: { code: "validation_error", fix: expect.any(String) } });
  expect(
    await api.run(
      api.store.use((db) =>
        db
          .prepare("SELECT state FROM credential_requests WHERE request_id = ?")
          .get(pending.request_id),
      ),
    ),
  ).toEqual({ state: "expired" });
  expect(
    (await run(api, requests.list({ state: "pending" }), first.principal)).credential_requests,
  ).toEqual([]);
  expect(
    (await run(api, requests.list({ state: "expired" }), first.principal)).credential_requests.map(
      (row) => row.request_id,
    ),
  ).toEqual([pending.request_id]);
  expect(await run(api, Effect.result(requests.decline(pending.request_id)))).toMatchObject({
    failure: { code: "validation_error" },
  });
});

test("paginates per key, binds cursors to filters and cascades inbox deletion with safe migration replay", async ({
  api,
}) => {
  const first = await agent(api);
  const requests = makeCredentialRequests(api.store);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    api.advance(1);
    ids.push((await create(api, first.token)).request_id);
  }
  const page1 = Schema.decodeUnknownSync(ListCredentialRequestsResponse)(
    await (
      await api.request("/v0/credential-requests?limit=2&ascending=true", { token: first.token })
    ).json(),
  );
  expect(page1.credential_requests.map((row) => row.request_id)).toEqual(ids.slice(0, 2));
  if (page1.next_page_token === undefined) throw new Error("Expected next page token");
  const page2 = await run(
    api,
    requests.list({ limit: 2, ascending: true, page_token: page1.next_page_token }),
    first.principal,
  );
  expect(page2.credential_requests.map((row) => row.request_id)).toEqual(ids.slice(2));
  expect(
    await run(
      api,
      Effect.result(
        requests.list({
          state: "declined",
          limit: 2,
          ascending: true,
          page_token: page1.next_page_token,
        }),
      ),
      first.principal,
    ),
  ).toMatchObject({ failure: { code: "page_token_stale" } });
  await api.run(
    api.store.use((db) => {
      db.pragma("user_version = 17");
      Effect.runSync(migrate(db));
    }),
  );
  expect((await run(api, requests.list(), first.principal)).count).toBe(3);
  expect((await api.request(`/v0/inboxes/${inboxId}`, { method: "DELETE" })).status).toBe(200);
  expect((await run(api, requests.list())).credential_requests).toEqual([]);
  expect(
    await run(api, Effect.result(requests.get(ids[0] ?? "", inboxId)), first.principal),
  ).toMatchObject({ failure: { code: "not_found" } });
});

test("rolls back fulfillment and credential creation if event persistence fails", async ({
  api,
}) => {
  const first = await agent(api);
  const request = await create(api, first.token);
  const requests = makeCredentialRequests(api.store);
  await api.run(
    api.store.use((db) =>
      db.exec(
        "CREATE TRIGGER reject_fulfillment BEFORE INSERT ON event_log WHEN NEW.event_type = 'credential.request_fulfilled' BEGIN SELECT RAISE(ABORT, 'synthetic event failure'); END",
      ),
    ),
  );
  expect(
    await run(
      api,
      Effect.result(
        requests.fulfill(request.request_id, { fields: { password: secret, totp: uri } }),
      ),
    ),
  ).toMatchObject({ failure: { code: "database_failed" } });
  expect((await run(api, requests.get(request.request_id, inboxId), first.principal)).state).toBe(
    "pending",
  );
  expect((await run(api, makeVault(api.store).list())).credentials).toEqual([]);
  expect(
    (await api.run(api.store.use((db) => readEvents(db, 0)))).filter(
      (row) => row.event_type === "credential.created",
    ),
  ).toEqual([]);
});
