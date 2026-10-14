import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { expect, test as base } from "vitest";
import {
  BitwardenExport,
  ImportCredentialsResponse,
} from "../../../../packages/contracts/src/bitwarden.js";
import { CurrentPrincipal } from "../../../../packages/contracts/src/security.js";
import {
  Credential,
  CredentialFieldsResponse,
  ListCredentialsResponse,
} from "../../../../packages/contracts/src/vault.js";
import { readEvents } from "../events/log.js";
import { fixture } from "../http/test-fixture.js";
import { TunnelTraffic } from "../http/tunnel-policy.js";
import { makeVault } from "./vault.js";
import { normalizeTotp } from "./totp.js";

const inbox = "agent@example.test";
const target = "other@example.test";
const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const test = base.extend<{ api: Awaited<ReturnType<typeof fixture>> }>({
  api: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-bitwarden-"));
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

const login = (name = "Synthetic login") => ({
  type: 1,
  name,
  login: { username: "robot", password: "synthetic password" },
});
async function importJson(api: Awaited<ReturnType<typeof fixture>>, body: unknown, query = "") {
  const response = await api.request(`/v0/credentials/import?inbox_id=${target}${query}`, {
    method: "POST",
    body,
  });
  expect(response.status).toBe(200);
  return Schema.decodeUnknownSync(ImportCredentialsResponse)(await response.json());
}

test("round trips secrets and metadata across inboxes with stable folders and value-free events", async ({
  api,
}) => {
  const values = {
    password: "Synthetic!Password",
    totp: normalizeTotp(seed),
    notes: "Private synthetic note",
    api_key: "synthetic API secret",
    username: "custom username field",
  };
  const created = await api.request(`/v0/inboxes/${inbox}/credentials`, {
    method: "POST",
    body: {
      name: "GitHub",
      username: "agent@example.test",
      url: "https://github.com/login?q=one",
      origins: ["https://api.github.com", "http://localhost:3000"],
      fields: values,
    },
  });
  const original = Schema.decodeUnknownSync(Credential)(await created.json());
  const response = await api.request(`/v0/credentials/export?inbox_id=${inbox}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const exported = Schema.decodeUnknownSync(BitwardenExport)(await response.json());
  expect(exported.encrypted).toBe(false);
  expect(exported.folders).toEqual([{ id: expect.stringMatching(/^[a-f0-9-]{36}$/), name: inbox }]);
  expect(exported.items).toEqual([
    {
      id: original.credential_id,
      folderId: exported.folders[0]?.id,
      type: 1,
      name: "GitHub",
      notes: values.notes,
      login: {
        username: original.username,
        password: values.password,
        totp: values.totp,
        uris: [original.url, "https://api.github.com", "http://localhost:3000"].map((uri) => ({
          uri,
          match: null,
        })),
      },
      fields: [
        { name: "api_key", value: values.api_key, type: 1 },
        { name: "username", value: values.username, type: 1 },
      ],
    },
  ]);
  expect(
    Schema.decodeUnknownSync(BitwardenExport)(
      await (await api.request(`/v0/credentials/export?inbox_id=${inbox}`)).json(),
    ).folders,
  ).toEqual(exported.folders);
  const all = Schema.decodeUnknownSync(BitwardenExport)(
    await (await api.request("/v0/credentials/export")).json(),
  );
  expect(all.folders.map((folder) => folder.name)).toEqual([inbox, target]);
  const imported = await importJson(api, exported);
  expect(imported).toMatchObject({ imported: 1, skipped: 0, reasons: {} });
  const credential = imported.credentials[0];
  if (credential === undefined) throw new Error("Expected imported credential");
  expect(credential).toMatchObject({
    name: original.name,
    username: original.username,
    url: original.url,
    origins: original.origins,
    fields: original.fields,
  });
  expect(credential.credential_id).not.toBe(original.credential_id);
  const revealed = Schema.decodeUnknownSync(CredentialFieldsResponse)(
    await (
      await api.request(`/v0/inboxes/${target}/credentials/${credential.credential_id}/fields`)
    ).json(),
  );
  expect(revealed.fields).toEqual(values);
  const events = await api.run(
    api.store.use((db) =>
      readEvents(db, 0).filter((row) => row.payload.event_type === "credential.created"),
    ),
  );
  expect(events).toHaveLength(2);
  expect(events[1]?.payload).toMatchObject({
    credential: {
      credential_id: credential.credential_id,
      inbox_id: target,
      fields: original.fields,
    },
  });
  for (const value of Object.values(values)) {
    expect(JSON.stringify(imported)).not.toContain(value);
    expect(JSON.stringify(events)).not.toContain(value);
  }
});

test("imports realistic JSON, tolerates extra keys and summarizes skipped items and invalid URIs", async ({
  api,
}) => {
  const sample = {
    encrypted: false,
    folders: [{ id: "foreign-folder", name: "Ignored" }],
    exportVersion: "synthetic",
    items: [
      {
        id: "foreign-id",
        folderId: "foreign-folder",
        type: 1,
        name: "Sample login",
        notes: "Synthetic note",
        favorite: false,
        reprompt: 0,
        login: {
          username: "robot",
          password: "synthetic password",
          totp: seed,
          uris: [
            { uri: "androidapp://invalid", match: null },
            { uri: "http://public.example.test/login", match: 0 },
            { uri: "https://example.test/login", match: null },
            { uri: "https://other.example.test/path", match: 1 },
            { uri: "https://user:pass@example.test", match: null },
          ],
        },
        fields: [
          { name: "API Key", value: "one", type: 1 },
          { name: "api-key", value: "two", type: 0 },
          { name: "9 PIN", value: "three", type: 1 },
          { name: "password", value: "custom", type: 1 },
          { name: "", value: "unnamed", type: 0 },
          { name: "empty", value: "", type: 1 },
          { name: "a".repeat(100), value: "long name", type: 1 },
        ],
        passwordHistory: [],
      },
      { type: 2, name: "Secure note", secureNote: { type: 0 }, notes: "Never returned" },
      { type: 3, name: "Card", card: { number: "4111111111111111" } },
      { ...login("Invalid TOTP"), login: { totp: "not-a-seed!" } },
      {
        ...login("Too many fields"),
        fields: Array.from({ length: 32 }, (_, i) => ({ name: `field_${i}`, value: "v", type: 1 })),
      },
      login("x".repeat(201)),
      { ...login("Too long value"), notes: "x".repeat(16385) },
      {
        ...login("Too many origins"),
        login: {
          uris: Array.from({ length: 17 }, (_, i) => ({
            uri: `https://site${i}.example.test/path`,
          })),
        },
      },
      { type: 1, name: 123 },
    ],
  };
  const result = await importJson(api, sample);
  expect(result).toMatchObject({
    imported: 1,
    skipped: 8,
    reasons: {
      unsupported_type: 2,
      invalid_totp: 1,
      too_many_fields: 1,
      name_too_long: 1,
      value_too_long: 1,
      too_many_origins: 1,
      invalid_item: 1,
      invalid_uri: 3,
    },
  });
  const credential = result.credentials[0];
  if (credential === undefined) throw new Error("Expected imported credential");
  expect(credential).toMatchObject({
    url: "https://example.test/login",
    origins: ["https://example.test", "https://other.example.test"],
  });
  const revealed = Schema.decodeUnknownSync(CredentialFieldsResponse)(
    await (
      await api.request(`/v0/inboxes/${target}/credentials/${credential.credential_id}/fields`)
    ).json(),
  );
  expect(revealed.fields).toEqual({
    password: "synthetic password",
    totp: normalizeTotp(seed),
    notes: "Synthetic note",
    api_key: "one",
    api_key_2: "two",
    f_9_pin: "three",
    password_2: "custom",
    f_: "unnamed",
    ["a".repeat(64)]: "long name",
  });
});

test("rejects encrypted exports, malformed envelopes and missing target inboxes without writes", async ({
  api,
}) => {
  for (const body of [
    { encrypted: true },
    { encrypted: true, items: [] },
    { items: "invalid" },
    {},
    { Items: [] },
  ]) {
    const response = await api.request(`/v0/credentials/import?inbox_id=${target}`, {
      method: "POST",
      body,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "validation_error",
      fix: expect.any(String),
    });
  }
  const encrypted = await api.request(`/v0/credentials/import?inbox_id=${target}`, {
    method: "POST",
    body: { encrypted: true },
  });
  expect(await encrypted.json()).toMatchObject({
    fix: expect.stringContaining("unencrypted JSON"),
  });
  for (const path of [
    "/v0/credentials/import",
    "/v0/credentials/import?inbox_id=missing@example.test",
    "/v0/credentials/export?inbox_id=missing@example.test",
  ]) {
    const response = await api.request(
      path,
      path.includes("import") ? { method: "POST", body: { items: [login()] } } : {},
    );
    expect(response.status).toBe(path === "/v0/credentials/import" ? 400 : 404);
  }
  const listed = Schema.decodeUnknownSync(ListCredentialsResponse)(
    await (await api.request("/v0/credentials")).json(),
  );
  expect(listed.credentials).toEqual([]);
});

test("skips duplicates against stored and newly imported credentials unless creation is explicit", async ({
  api,
}) => {
  const body = {
    items: [
      login(),
      login(),
      { ...login(), login: { username: "another", password: "another secret" } },
    ],
  };
  expect(await importJson(api, body)).toMatchObject({
    imported: 2,
    skipped: 1,
    reasons: { duplicate: 1 },
  });
  expect(await importJson(api, body)).toMatchObject({
    imported: 0,
    skipped: 3,
    reasons: { duplicate: 3 },
  });
  expect(await importJson(api, body, "&on_duplicate=create")).toMatchObject({
    imported: 3,
    skipped: 0,
    reasons: {},
  });
  const response = await api.request(
    `/v0/credentials/import?inbox_id=${target}&on_duplicate=replace`,
    { method: "POST", body },
  );
  expect(response.status).toBe(400);
});

test("agents and unauthenticated clients cannot import or export even with all credential permissions", async ({
  api,
}) => {
  const grant = {
    inbox_ids: [inbox, target],
    permissions: {
      credential_read: true,
      credential_create: true,
      credential_update: true,
      credential_delete: true,
      credential_fill: true,
      credential_totp: true,
      credential_run: true,
    },
    send_policy: "direct" as const,
  };
  const key = await api.run(api.keys.create(grant));
  for (const token of [key.api_key, null]) {
    for (const name of ["export", "import"]) {
      const response = await api.request(`/v0/credentials/${name}?inbox_id=${target}`, {
        token,
        ...(name === "import" ? { method: "POST", body: { items: [login()] } } : {}),
      });
      expect(response.status).toBe(token === null ? 401 : 403);
      expect(await response.json()).toMatchObject({
        code: token === null ? "unauthorized" : "missing_permission",
      });
    }
  }
  const vault = makeVault(api.store);
  for (const operation of [
    vault.exportBitwarden().pipe(Effect.asVoid),
    vault.importBitwarden({ items: [login()] }, { inbox_id: target }).pipe(Effect.asVoid),
  ]) {
    expect(
      await api.run(
        operation.pipe(
          Effect.provideService(CurrentPrincipal, {
            kind: "agent",
            api_key_id: key.api_key_id,
            grant,
          }),
          Effect.result,
        ),
      ),
    ).toMatchObject({ failure: { code: "missing_permission" } });
    expect(
      await api.run(
        operation.pipe(
          Effect.provideService(CurrentPrincipal, { kind: "owner" }),
          Effect.provideService(TunnelTraffic, true),
          Effect.result,
        ),
      ),
    ).toMatchObject({ failure: { code: "missing_permission" } });
  }
});

test("rolls back all credentials, fields and events when a later item fails in SQLite", async ({
  api,
}) => {
  await api.run(
    api.store.use((db) =>
      db.exec(
        `CREATE TRIGGER synthetic_import_failure BEFORE INSERT ON credentials WHEN NEW.name = 'Fail second' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;`,
      ),
    ),
  );
  const response = await api.request(`/v0/credentials/import?inbox_id=${target}`, {
    method: "POST",
    body: { items: [login("First"), login("Fail second")] },
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "service_unavailable" });
  const state = await api.run(
    api.store.use((db) => ({
      credentials: db.prepare("SELECT * FROM credentials").all(),
      fields: db.prepare("SELECT * FROM credential_fields").all(),
      events: readEvents(db, 0).filter((row) => row.payload.event_type === "credential.created"),
    })),
  );
  expect(state).toEqual({ credentials: [], fields: [], events: [] });
  await api.run(api.store.use((db) => db.exec("DROP TRIGGER synthetic_import_failure")));
  expect(await importJson(api, { items: [login("First"), login("Second")] })).toMatchObject({
    imported: 2,
    skipped: 0,
  });
});

test("enforces the 5 MB body limit including streamed requests without Content-Length", async ({
  api,
}) => {
  const body = JSON.stringify({ items: [login()], ignored: "x".repeat(5 * 1024 * 1024) });
  const url = `${api.url}/v0/credentials/import?inbox_id=${target}`;
  const headers = { authorization: `Bearer ${api.token}`, "content-type": "application/json" };
  // The server rejects oversized bodies without draining them, so a client still
  // writing may see a connection reset instead of the validation response.
  const rejected = (error: unknown) =>
    error instanceof Error &&
    /ECONNRESET|EPIPE/.test(
      `${error.message} ${error.cause instanceof Error ? error.cause.message : ""}`,
    );
  const declared = await fetch(url, { method: "POST", headers, body }).then(
    async (response) => ({ status: response.status, body: await response.json() }),
    (error: unknown) => {
      if (!rejected(error)) throw error;
      return undefined;
    },
  );
  if (declared !== undefined)
    expect(declared).toMatchObject({
      status: 400,
      body: { code: "validation_error", fix: expect.stringContaining("5 MB") },
    });
  const streamed = await new Promise<{ status: number; body: unknown } | undefined>(
    (resolve, reject) => {
      const request = httpRequest(url, { method: "POST", headers }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          }),
        );
      });
      request.on("error", (error) => (rejected(error) ? resolve(undefined) : reject(error)));
      request.write(body.slice(0, 1024));
      request.end(body.slice(1024));
    },
  );
  if (streamed !== undefined)
    expect(streamed).toMatchObject({ status: 400, body: { code: "validation_error" } });
  const after = await api.request(`/v0/inboxes/${target}/credentials`);
  expect(await after.json()).toMatchObject({ credentials: [] });
  const small = await importJson(api, { items: [login()], ignored: "x".repeat(1024 * 1024) });
  expect(small.imported).toBe(1);
});
