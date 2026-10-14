import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { expect, test as base, vi } from "vitest";
import type { Permissions } from "../../../../packages/contracts/src/api-keys.js";
import { CurrentPrincipal, type Principal } from "../../../../packages/contracts/src/security.js";
import {
  Credential,
  CredentialFieldsResponse,
  ListCredentialsResponse,
  TotpCodeResponse,
} from "../../../../packages/contracts/src/vault.js";
import { eventVisible, readEvents } from "../events/log.js";
import { fixture } from "../http/test-fixture.js";
import { normalizeTotp } from "./totp.js";
import { makeVault } from "./vault.js";

const inboxId = "agent@example.test";
const otherId = "other@example.test";
const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const uri = `otpauth://totp/Test?secret=${seed}&algorithm=SHA1&digits=8&period=30`;
const owner: Principal = { kind: "owner" };
const permissions: Permissions = {
  credential_read: true,
  credential_create: true,
  credential_update: true,
  credential_delete: true,
  credential_totp: true,
};
const test = base.extend<{ api: Awaited<ReturnType<typeof fixture>> }>({
  api: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-vault-"));
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
async function agent(api: Awaited<ReturnType<typeof fixture>>, allowed: Permissions = permissions) {
  const grant = { inbox_ids: [inboxId], permissions: allowed, send_policy: "read_only" as const };
  const key = await api.run(api.keys.create(grant));
  const principal: Principal = { kind: "agent", api_key_id: key.api_key_id, grant };
  return { token: key.api_key, principal };
}
async function credential(
  api: Awaited<ReturnType<typeof fixture>>,
  name = "GitHub",
  inbox = inboxId,
) {
  return run(api, makeVault(api.store).create({ name, generate: {} }, inbox));
}
function noSecrets(value: unknown, secrets: readonly string[]) {
  const json = JSON.stringify(value) ?? "";
  for (const secret of secrets) expect(json).not.toContain(secret);
}

async function errorCode(response: Response, code: string, status: number) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ code, fix: expect.any(String) });
}

test("conceals foreign inboxes and checks permissions on service and HTTP operations", async ({
  api,
}) => {
  const vault = makeVault(api.store);
  const own = await credential(api);
  const foreign = await credential(api, "Foreign", otherId);
  const { principal, token } = await agent(api);
  for (const operation of [
    vault.get(foreign.credential_id, otherId),
    vault.update(foreign.credential_id, { name: "Hidden" }, otherId),
    vault.delete(foreign.credential_id, otherId),
    vault.generate(foreign.credential_id, {}, otherId),
    vault.totp(foreign.credential_id, otherId),
    vault.list({}, otherId),
    vault.create({ name: "Hidden" }, otherId),
  ])
    expect(await run(api, Effect.result(operation), principal)).toMatchObject({
      _tag: "Failure",
      failure: { code: "not_found" },
    });
  expect(
    (await run(api, vault.list(), principal)).credentials.map((row) => row.credential_id),
  ).toEqual([own.credential_id]);
  expect(
    await run(api, Effect.result(vault.get(foreign.credential_id, inboxId)), principal),
  ).toMatchObject({ failure: { code: "not_found" } });
  for (const [suffix, method, body] of [
    ["", "GET", undefined],
    ["", "PATCH", { name: "Hidden" }],
    ["", "DELETE", undefined],
    ["/generate", "POST", {}],
    ["/totp", "GET", undefined],
  ] as const)
    await errorCode(
      await api.request(`/v0/inboxes/${otherId}/credentials/${foreign.credential_id}${suffix}`, {
        token,
        method,
        ...(body === undefined ? {} : { body }),
      }),
      "not_found",
      404,
    );
  await errorCode(
    await api.request(`/v0/credentials?inbox_id=${otherId}`, { token }),
    "not_found",
    404,
  );
  const global = await api.request("/v0/credentials", { token });
  expect(
    Schema.decodeUnknownSync(ListCredentialsResponse)(await global.json()).credentials.map(
      (row) => row.credential_id,
    ),
  ).toEqual([own.credential_id]);
  const denied = await agent(api, {});
  for (const operation of [
    vault.list(),
    vault.get(own.credential_id, inboxId),
    vault.create({ name: "Denied" }, inboxId),
    vault.update(own.credential_id, { name: "Denied" }, inboxId),
    vault.generate(own.credential_id, {}, inboxId),
    vault.delete(own.credential_id, inboxId),
    vault.totp(own.credential_id, inboxId),
  ])
    expect(await run(api, Effect.result(operation), denied.principal)).toMatchObject({
      failure: { code: "missing_permission" },
    });
  await errorCode(
    await api.request(`/v0/inboxes/${inboxId}/credentials/${own.credential_id}`, {
      token: denied.token,
    }),
    "missing_permission",
    403,
  );
});

test("generates server-side passwords, reveals only to owner, and shares scoped credentials across keys", async ({
  api,
}) => {
  const vault = makeVault(api.store);
  const creator = await agent(api);
  const created = await run(
    api,
    vault.create(
      {
        name: "GitHub",
        url: "https://github.com/signup",
        username: inboxId,
        fields: { recovery_codes: "synthetic-recovery-secret" },
        generate: {},
      },
      inboxId,
    ),
    creator.principal,
  );
  expect(created.credential_id).toMatch(/^[0-9a-f]{32}$/);
  expect(created.fields).toEqual(["password", "recovery_codes"]);
  expect(created.refs.password).toBe(`inbot://credentials/${created.credential_id}/password`);
  const revealed = await run(api, vault.reveal(created.credential_id, inboxId));
  expect(revealed.fields.password).toMatch(/^[a-zA-Z0-9]{6}-[a-zA-Z0-9]{6}-[a-zA-Z0-9]{6}$/);
  expect(revealed.fields.recovery_codes).toBe("synthetic-recovery-secret");
  noSecrets(created, Object.values(revealed.fields));
  expect(
    await run(
      api,
      api.store.use((db) =>
        db
          .prepare("SELECT created_by FROM credentials WHERE credential_id = ?")
          .get(created.credential_id),
      ),
    ),
  ).toEqual({ created_by: creator.principal.api_key_id });
  const reader = await agent(api, { credential_read: true });
  expect(await run(api, vault.get(created.credential_id, inboxId), reader.principal)).toEqual(
    created,
  );
  expect(
    await run(api, Effect.result(vault.reveal(created.credential_id, inboxId)), reader.principal),
  ).toMatchObject({ failure: { code: "missing_permission" } });
  const path = `/v0/inboxes/${inboxId}/credentials/${created.credential_id}/fields`;
  await errorCode(await api.request(path, { token: creator.token }), "missing_permission", 403);
  const response = await api.request(path);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(Schema.decodeUnknownSync(CredentialFieldsResponse)(await response.json())).toEqual(
    revealed,
  );
});

test("keeps distinctive secret values out of every agent service and HTTP response, errors, events and logs", async ({
  api,
}) => {
  const vault = makeVault(api.store);
  const { principal, token } = await agent(api);
  const secrets = [
    "distinctive-password-7gT",
    "distinctive-recovery-a8H",
    "distinctive-api-key-5xF",
    seed,
    uri,
  ];
  const results: unknown[] = [];
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const created = await run(
      api,
      vault.create(
        {
          name: "Synthetic vault",
          fields: {
            password: secrets[0] ?? "",
            recovery_codes: secrets[1] ?? "",
            api_key: secrets[2] ?? "",
            totp: uri,
          },
        },
        inboxId,
      ),
      principal,
    );
    results.push(
      created,
      await run(api, vault.list(), principal),
      await run(api, vault.list({}, inboxId), principal),
      await run(api, vault.get(created.credential_id, inboxId), principal),
    );
    results.push(
      await run(
        api,
        vault.update(
          created.credential_id,
          { name: "Renamed", fields: { api_key: secrets[2] ?? "" } },
          inboxId,
        ),
        principal,
      ),
    );
    results.push(await run(api, vault.generate(created.credential_id, {}, inboxId), principal));
    secrets.push(
      ...Object.values((await run(api, vault.reveal(created.credential_id, inboxId))).fields),
    );
    results.push(
      await run(api, vault.totp(created.credential_id, inboxId), principal),
      await run(api, Effect.result(vault.reveal(created.credential_id, inboxId)), principal),
    );
    const path = `/v0/inboxes/${inboxId}/credentials`;
    const posted = await api.request(path, {
      token,
      method: "POST",
      body: {
        name: "HTTP synthetic",
        fields: {
          password: secrets[0],
          recovery_codes: secrets[1],
          api_key: secrets[2],
          totp: uri,
        },
      },
    });
    expect(posted.status).toBe(200);
    const http = Schema.decodeUnknownSync(Credential)(await posted.json());
    results.push(http);
    for (const [url, method, body] of [
      [path, "GET", undefined],
      ["/v0/credentials", "GET", undefined],
      [`${path}/${http.credential_id}`, "GET", undefined],
      [`${path}/${http.credential_id}`, "PATCH", { fields: { recovery_codes: secrets[1] } }],
      [`${path}/${http.credential_id}/generate`, "POST", {}],
      [`${path}/${http.credential_id}/totp`, "GET", undefined],
      [`${path}/${http.credential_id}/fields`, "GET", undefined],
      [path, "POST", { name: "Invalid", fields: { totp: secrets[0] } }],
      [path, "POST", { name: "Invalid", fields: { password: secrets[0], api_key: "" } }],
      [
        `${path}/${http.credential_id}`,
        "PATCH",
        { fields: { password: secrets[0] }, generate: { rules: "minlength: 200; maxlength: 1;" } },
      ],
      [`${path}/${http.credential_id}`, "DELETE", undefined],
    ] as const) {
      const response = await api.request(url, {
        token,
        method,
        ...(body === undefined ? {} : { body }),
      });
      if (method === "DELETE") {
        expect(response.status).toBe(200);
        results.push(await response.text());
      } else results.push(await response.json());
    }
    results.push(await run(api, vault.delete(created.credential_id, inboxId), principal));
    results.push(await api.run(api.store.use((db) => readEvents(db, 0))));
    noSecrets(results, secrets);
    noSecrets([log.mock.calls, error.mock.calls], secrets);
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

test("uses the injected clock for the RFC TOTP vector and records agent usage without exposing the seed", async ({
  api,
}) => {
  const vault = makeVault(api.store);
  const created = await run(
    api,
    vault.create({ name: "RFC account", fields: { totp: uri } }, inboxId),
  );
  api.advance(59_000 - Date.parse(created.created_at));
  await run(api, vault.totp(created.credential_id, inboxId));
  expect((await run(api, vault.get(created.credential_id, inboxId))).last_used_at).toBeUndefined();
  const { principal, token } = await agent(api);
  expect(await run(api, vault.totp(created.credential_id, inboxId), principal)).toEqual({
    code: "94287082",
    expires_at: "1970-01-01T00:01:00.000Z",
    period: 30,
  });
  const metadata = await run(api, vault.get(created.credential_id, inboxId), principal);
  expect(metadata.last_used_at).toBe("1970-01-01T00:00:59.000Z");
  const response = await api.request(
    `/v0/inboxes/${inboxId}/credentials/${created.credential_id}/totp`,
    { token },
  );
  expect(Schema.decodeUnknownSync(TotpCodeResponse)(await response.json()).code).toBe("94287082");
  expect((await run(api, vault.reveal(created.credential_id, inboxId))).fields.totp).toBe(
    normalizeTotp(uri),
  );
  const absent = await credential(api);
  expect(
    await run(api, Effect.result(vault.totp(absent.credential_id, inboxId)), principal),
  ).toMatchObject({ failure: { code: "not_found" } });
  await errorCode(
    await api.request(`/v0/inboxes/${inboxId}/credentials/${absent.credential_id}/totp`, { token }),
    "not_found",
    404,
  );
});

test("renames, removes and regenerates fields while preserving refs and transactional state on validation failures", async ({
  api,
}) => {
  const vault = makeVault(api.store);
  const created = await run(
    api,
    vault.create(
      {
        name: "Before",
        url: "https://first.example.test/path",
        origins: ["https://extra.example.test"],
        fields: { recovery_codes: "remove-this-secret" },
        generate: {},
      },
      inboxId,
    ),
  );
  const original = await run(api, vault.reveal(created.credential_id, inboxId));
  api.advance(1000);
  const updated = await run(
    api,
    vault.update(
      created.credential_id,
      {
        name: "After",
        url: "https://second.example.test/login",
        remove_fields: ["recovery_codes"],
        generate: {},
      },
      inboxId,
    ),
  );
  expect(updated.name).toBe("After");
  expect(updated.fields).toEqual(["password"]);
  expect(updated.refs.password).toBe(created.refs.password);
  expect(updated.origins).toEqual(["https://second.example.test", "https://extra.example.test"]);
  expect(updated.updated_at).not.toBe(created.updated_at);
  expect((await run(api, vault.reveal(created.credential_id, inboxId))).fields.password).not.toBe(
    original.fields.password,
  );
  expect(
    (await run(api, vault.update(created.credential_id, { origins: [] }, inboxId))).origins,
  ).toEqual(["https://second.example.test"]);
  const before = await run(api, vault.get(created.credential_id, inboxId));
  for (const input of [
    {},
    { fields: { "invalid.name": "invalid-field-secret" } },
    { generate: { field: "totp" } },
    { fields: { totp: "invalid-seed" } },
    { generate: { rules: "minlength: 99; maxlength: 1;" } },
  ]) {
    expect(
      await run(api, Effect.result(vault.update(created.credential_id, input, inboxId))),
    ).toMatchObject({ failure: { code: "validation_error", fix: expect.any(String) } });
    expect(await run(api, vault.get(created.credential_id, inboxId))).toEqual(before);
  }
  const filled = await run(
    api,
    vault.update(
      created.credential_id,
      {
        fields: Object.fromEntries(
          Array.from({ length: 31 }, (_, i) => [`field_${i}`, `synthetic-${i}`]),
        ),
      },
      inboxId,
    ),
  );
  expect(filled.fields).toHaveLength(32);
  expect(
    await run(
      api,
      Effect.result(vault.generate(created.credential_id, { field: "extra" }, inboxId)),
    ),
  ).toMatchObject({ failure: { code: "validation_error" } });
  const replaced = await run(
    api,
    vault.update(
      created.credential_id,
      { remove_fields: ["field_0"], fields: { extra: "replacement" } },
      inboxId,
    ),
  );
  expect(replaced.fields).toHaveLength(32);
  expect(replaced.fields).not.toContain("field_0");
  await run(api, vault.update(created.credential_id, { remove_fields: replaced.fields }, inboxId));
  expect((await run(api, vault.get(created.credential_id, inboxId))).refs).toEqual({});
});

test("normalizes unique primary-first origins and rejects unsafe URLs, extra paths and origin limits", async ({
  api,
}) => {
  const vault = makeVault(api.store);
  const good = await run(
    api,
    vault.create(
      {
        name: "Origins",
        url: "https://example.test/login",
        origins: ["https://example.test", "https://extra.test", "https://extra.test"],
      },
      inboxId,
    ),
  );
  expect(good.origins).toEqual(["https://example.test", "https://extra.test"]);
  for (const url of [
    "http://localhost:3000/login",
    "http://127.0.0.1/login",
    "http://[::1]:8080/login",
  ])
    expect((await run(api, vault.create({ name: "Loopback", url }, inboxId))).origins).toEqual([
      new URL(url).origin,
    ]);
  for (const input of [
    { url: "http://example.test/login" },
    { url: "ftp://example.test" },
    { url: "not-a-url" },
    { url: "https://user:password@example.test" },
    { origins: ["https://example.test/path"] },
    { origins: ["https://example.test/"] },
    { origins: ["http://remote.test"] },
    { origins: ["https://example.test?query"] },
    { origins: ["https://example.test#fragment"] },
    {
      url: "https://primary.test",
      origins: Array.from({ length: 16 }, (_, i) => `https://extra${i}.test`),
    },
  ])
    expect(
      await run(api, Effect.result(vault.create({ name: "Invalid", ...input }, inboxId))),
    ).toMatchObject({ failure: { code: "validation_error", fix: expect.any(String) } });
  expect((await run(api, vault.create({ name: "No origin" }, inboxId))).origins).toEqual([]);
});

test("binds pagination to scope and metadata search and matches non-ASCII case without searching secrets", async ({
  api,
}) => {
  const vault = makeVault(api.store);
  const { principal } = await agent(api);
  const first = await run(
    api,
    vault.create(
      {
        name: "Árvíz",
        url: "https://example.test/First",
        fields: { password: "secret-search-needle" },
      },
      inboxId,
    ),
  );
  api.advance(1000);
  const second = await run(api, vault.create({ name: "Second", username: "CaseUSER" }, inboxId));
  await credential(api, "Foreign", otherId);
  const page = await run(api, vault.list({ limit: 1 }, inboxId), principal);
  expect(page.credentials.map((row) => row.credential_id)).toEqual([second.credential_id]);
  if (page.next_page_token === undefined) throw new Error("Expected a continuation");
  const next = await run(
    api,
    vault.list({ limit: 1, page_token: page.next_page_token }, inboxId),
    principal,
  );
  expect(next.credentials.map((row) => row.credential_id)).toEqual([first.credential_id]);
  expect(next.next_page_token).toBeUndefined();
  for (const q of ["árVÍZ", "FIRST", "caseuser"])
    expect((await run(api, vault.list({ q }), principal)).credentials).toHaveLength(1);
  expect(
    (await run(api, vault.list({ q: "secret-search-needle" }), principal)).credentials,
  ).toEqual([]);
  expect(
    await run(
      api,
      Effect.result(vault.list({ q: "different", page_token: page.next_page_token }, inboxId)),
      principal,
    ),
  ).toMatchObject({ failure: { code: "page_token_stale" } });
  expect(
    (await run(api, vault.list({ ascending: true }), principal)).credentials.map(
      (row) => row.credential_id,
    ),
  ).toEqual([first.credential_id, second.credential_id]);
});

test("appends only field names atomically and gates event visibility by inbox and credential_read", async ({
  api,
}) => {
  const vault = makeVault(api.store);
  const { principal } = await agent(api);
  const created = await run(
    api,
    vault.create(
      { name: "Events", fields: { password: "event-secret-distinctive", totp: seed } },
      inboxId,
    ),
  );
  await run(api, vault.update(created.credential_id, { remove_fields: ["totp"] }, inboxId));
  await run(api, vault.delete(created.credential_id, inboxId));
  await credential(api, "Foreign", otherId);
  const rows = (await api.run(api.store.use((db) => readEvents(db, 0)))).filter(
    (row) => "credential" in row.payload,
  );
  expect(rows.map((row) => row.event_type)).toEqual([
    "credential.created",
    "credential.updated",
    "credential.deleted",
    "credential.created",
  ]);
  expect(rows[0]?.payload).toMatchObject({
    credential: {
      credential_id: created.credential_id,
      inbox_id: inboxId,
      fields: ["password", "totp"],
    },
  });
  for (const row of rows) {
    expect(eventVisible(row, principal)).toBe(row.inbox_id === inboxId);
    expect(
      eventVisible(row, {
        ...principal,
        grant: { ...principal.grant, permissions: { message_read: true, draft_read: true } },
      }),
    ).toBe(false);
    expect(eventVisible(row, owner)).toBe(true);
    expect(eventVisible(row, principal, { inbox_ids: [otherId] })).toBe(false);
    noSecrets(row, ["event-secret-distinctive", seed]);
  }
  await api.run(
    api.store.use((db) =>
      db.exec(
        "CREATE TRIGGER reject_vault_event BEFORE INSERT ON event_log WHEN NEW.event_type = 'credential.created' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
      ),
    ),
  );
  expect(
    await run(
      api,
      Effect.result(
        vault.create({ name: "Must roll back", fields: { password: "rollback-secret" } }, inboxId),
      ),
    ),
  ).toMatchObject({ failure: { code: "database_failed" } });
  expect((await run(api, vault.list({ q: "Must roll back" }))).credentials).toEqual([]);
  expect(
    await api.run(
      api.store.use((db) =>
        db
          .prepare("SELECT COUNT(*) AS count FROM credential_fields WHERE value = ?")
          .get("rollback-secret"),
      ),
    ),
  ).toEqual({ count: 0 });
});

test("deleting an inbox cascades through credentials and secret fields", async ({ api }) => {
  const created = await credential(api);
  const retained = await credential(api, "Retained", otherId);
  await api.run(api.mailbox.deleteInbox(inboxId));
  expect(
    await api.run(
      api.store.use((db) =>
        db
          .prepare("SELECT credential_id FROM credentials WHERE credential_id = ?")
          .get(created.credential_id),
      ),
    ),
  ).toBeUndefined();
  expect(
    await api.run(
      api.store.use((db) =>
        db
          .prepare("SELECT name FROM credential_fields WHERE credential_id = ?")
          .all(created.credential_id),
      ),
    ),
  ).toEqual([]);
  expect(
    (await run(api, makeVault(api.store).get(retained.credential_id, otherId))).credential_id,
  ).toBe(retained.credential_id);
});
