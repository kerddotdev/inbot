import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Effect, Schema } from "effect";
import { expect, test as baseTest } from "vitest";
import { InbotApi } from "../../../../packages/contracts/src/api.js";
import {
  ApiKey,
  CreateApiKeyResponse,
  ListApiKeysResponse,
  type CreateApiKeyRequest,
} from "../../../../packages/contracts/src/api-keys.js";
import { AttachmentResponse } from "../../../../packages/contracts/src/attachments.js";
import { ErrorResponse } from "../../../../packages/contracts/src/errors.js";
import {
  Inbox,
  ListInboxesResponse,
  SearchInboxesResponse,
} from "../../../../packages/contracts/src/inboxes.js";
import {
  BatchGetMessagesResponse,
  BatchUpdateMessagesResponse,
  ListMessagesResponse,
  Message,
  RawMessageResponse,
  SearchMessagesResponse,
  UpdateMessageResponse,
} from "../../../../packages/contracts/src/messages.js";
import {
  ListThreadsResponse,
  SearchThreadsResponse,
  Thread,
  UpdateThreadResponse,
} from "../../../../packages/contracts/src/threads.js";
import { Connection } from "../auth/owner.js";
import { DatabaseError } from "../store.js";

import { fixture } from "./test-fixture.js";

const inboxId = "agent@example.test";
const otherInbox = "other@example.test";
const messageId = "<first@example.test>";
const messagePath = `/v0/inboxes/${inboxId}/messages/${encodeURIComponent(messageId)}`;

type ApiFixture = Awaited<ReturnType<typeof fixture>>;
const test = baseTest.extend<{ home: string; api: ApiFixture }>({
  home: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-http-test-"));
    try {
      await use(home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  api: async ({ home }, use) => {
    const api = await fixture(home);
    try {
      await use(api);
    } finally {
      await api.close();
    }
  },
});

async function decoded<S extends Schema.Top & { readonly DecodingServices: never }>(
  response: Response,
  schema: S,
  status = 200,
): Promise<S["Type"]> {
  expect(response.status, await response.clone().text()).toBe(status);
  const body: unknown = await response.json();
  return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(body);
}

async function failure(response: Response, status: number, code: typeof ErrorResponse.Type.code) {
  const body = await decoded(response, ErrorResponse, status);
  expect(body.code).toBe(code);
  expect(body.name).toBeTruthy();
  expect(body.message).toBeTruthy();
  expect(body.fix).toBeTruthy();
  return body;
}

async function createKey(api: ApiFixture, overrides: Partial<CreateApiKeyRequest> = {}) {
  return decoded(
    await api.request("/v0/api-keys", {
      method: "POST",
      body: {
        inbox_ids: [inboxId],
        permissions: { inbox_read: true, message_read: true },
        send_policy: "read_only",
        ...overrides,
      },
    }),
    CreateApiKeyResponse,
  );
}

function nextPage(token: string | undefined) {
  if (token === undefined) throw new Error("Expected a pagination token");
  return encodeURIComponent(token);
}

test("authenticates owners and keys, rejects missing, invalid, expired, and revoked credentials", async ({
  api,
}) => {
  await failure(await api.request("/v0/inboxes", { token: null }), 401, "unauthorized");
  await failure(await api.request("/v0/inboxes", { token: "invalid" }), 401, "unauthorized");
  const key = await createKey(api);
  expect(key.api_key).toMatch(/^inbot_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/);
  expect(key.prefix).toBe(key.api_key.slice(0, key.prefix.length));
  await decoded(await api.request("/v0/inboxes"), ListInboxesResponse);
  await decoded(await api.request("/v0/inboxes", { token: key.api_key }), ListInboxesResponse);
  const secretWrong = `${key.api_key.slice(0, -1)}${key.api_key.endsWith("a") ? "b" : "a"}`;
  await failure(await api.request("/v0/inboxes", { token: secretWrong }), 401, "unauthorized");
  const expired = await createKey(api, { expires_at: "2026-10-10T12:00:00Z" });
  await failure(await api.request("/v0/inboxes", { token: expired.api_key }), 401, "unauthorized");
  const expiring = await createKey(api, { expires_at: "2026-10-10T12:01:00Z" });
  await decoded(await api.request("/v0/inboxes", { token: expiring.api_key }), ListInboxesResponse);
  api.advance(60_000);
  await failure(await api.request("/v0/inboxes", { token: expiring.api_key }), 401, "unauthorized");
  expect((await api.request(`/v0/api-keys/${key.api_key_id}`, { method: "DELETE" })).status).toBe(
    200,
  );
  await failure(await api.request("/v0/inboxes", { token: key.api_key }), 401, "unauthorized");
  await failure(await api.request(`/v0/api-keys/${key.api_key_id}`), 404, "not_found");
  if (process.platform !== "win32")
    expect((await stat(join(api.home, "connection.json"))).mode & 0o777).toBe(0o600);
});

test("keeps plaintext keys out of reads, persists grants and throttles used_at without caching revoked permissions", async ({
  api,
}) => {
  const key = await createKey(api, { name: "Reader" });
  const list = await decoded(await api.request("/v0/api-keys"), ListApiKeysResponse);
  expect(list.api_keys).toHaveLength(1);
  expect(JSON.stringify(list)).not.toContain(key.api_key);
  const before = await decoded(await api.request(`/v0/api-keys/${key.api_key_id}`), ApiKey);
  expect(before.used_at).toBeUndefined();
  await decoded(await api.request("/v0/inboxes", { token: key.api_key }), ListInboxesResponse);
  const used = await api.run(api.keys.get(key.api_key_id));
  expect(used.used_at).toBe("2026-10-10T12:00:00.000Z");
  api.advance(59_999);
  await decoded(await api.request("/v0/inboxes", { token: key.api_key }), ListInboxesResponse);
  expect((await api.run(api.keys.get(key.api_key_id))).used_at).toBe(used.used_at);
  api.advance(1);
  await decoded(await api.request("/v0/inboxes", { token: key.api_key }), ListInboxesResponse);
  expect((await api.run(api.keys.get(key.api_key_id))).used_at).toBe("2026-10-10T12:01:00.000Z");
  await decoded(
    await api.request(`/v0/api-keys/${key.api_key_id}`, {
      method: "PATCH",
      body: { name: "Disabled", permissions: {} },
    }),
    ApiKey,
  );
  await failure(
    await api.request("/v0/inboxes", { token: key.api_key }),
    403,
    "missing_permission",
  );
  for (const body of [
    { inbox_ids: [otherInbox] },
    { expires_at: "2027-01-01T00:00:00Z" },
    { permissions: { domain_create: true } },
  ])
    await failure(
      await api.request(`/v0/api-keys/${key.api_key_id}`, { method: "PATCH", body }),
      400,
      "validation_error",
    );
  const db = await readFile(join(api.home, "inbot.db"));
  expect(db.includes(Buffer.from(key.api_key))).toBe(false);
  const row = await api.run(
    api.store.use((database) =>
      database.prepare("SELECT * FROM api_keys WHERE api_key_id = ?").get(key.api_key_id),
    ),
  );
  expect(JSON.stringify(row)).not.toContain(key.api_key);
  const stored = Schema.decodeUnknownSync(Schema.Struct({ secret_hash: Schema.Uint8Array }))(row);
  expect(Buffer.from(stored.secret_hash)).toEqual(
    createHash("sha256").update(key.api_key).digest(),
  );
});

test("enforces all endpoint annotations and blocks every owner-only route for agents", async ({
  api,
}) => {
  const key = await createKey(api, { permissions: {} });
  for (const group of Object.values(InbotApi.groups)) {
    for (const endpoint of Object.values(group.endpoints)) {
      const path = endpoint.path.replace(/:([a-z_]+)/g, (_match: string, field: string) => {
        if (field === "inbox_id") return inboxId;
        if (field === "direction") return "receive";
        if (field === "type") return "allow";
        return "synthetic";
      });
      await failure(
        await api.request(path, {
          token: key.api_key,
          method: endpoint.method,
          ...(endpoint.method === "POST" || endpoint.method === "PATCH" ? { body: {} } : {}),
        }),
        403,
        "missing_permission",
      );
    }
  }
});

test("hides out-of-scope resources and applies intersected inbox scopes before pagination and search", async ({
  api,
}) => {
  const other = await api.run(
    api.mailbox.insertMessage({
      inbox_id: otherInbox,
      message_id: "<other@example.test>",
      direction: "received",
      from: "alice@example.test",
      to: [otherInbox],
      subject: "Synthetic project update",
      timestamp: "2026-10-10T10:00:00Z",
      raw: Buffer.from("Synthetic MIME"),
      labels: ["received"],
    }),
  );
  const key = await createKey(api);
  await failure(
    await api.request(messagePath, {
      token: key.api_key,
      method: "PATCH",
      body: { add_labels: "seen" },
    }),
    403,
    "missing_permission",
  );
  await failure(
    await api.request(`/v0/inboxes/${otherInbox}`, { token: key.api_key }),
    404,
    "not_found",
  );
  await failure(
    await api.request(`/v0/threads/${other.thread_id}`, { token: key.api_key }),
    404,
    "not_found",
  );
  const threads = await decoded(
    await api.request("/v0/threads", { token: key.api_key }),
    ListThreadsResponse,
  );
  expect(threads.threads.map((thread) => thread.inbox_id)).toEqual([inboxId]);
  const inboxes = await decoded(
    await api.request("/v0/inboxes?limit=1", { token: key.api_key }),
    ListInboxesResponse,
  );
  expect(inboxes.inboxes.map((inbox) => inbox.inbox_id)).toEqual([inboxId]);
  expect(inboxes.next_page_token).toBeUndefined();
  const search = await decoded(
    await api.request("/v0/inboxes/search?q=example", { token: key.api_key }),
    SearchInboxesResponse,
  );
  expect(search.inboxes.map((inbox) => inbox.inbox_id)).toEqual([inboxId]);
  const threadSearch = await decoded(
    await api.request("/v0/threads/search?q=project", { token: key.api_key }),
    SearchThreadsResponse,
  );
  expect(threadSearch.threads.map((thread) => thread.inbox_id)).toEqual([inboxId]);
  const empty = await createKey(api, { inbox_ids: [] });
  expect(
    (await decoded(await api.request("/v0/threads", { token: empty.api_key }), ListThreadsResponse))
      .count,
  ).toBe(0);
  const intersected = await createKey(api, { inbox_id: otherInbox, inbox_ids: [inboxId] });
  expect(
    (
      await decoded(
        await api.request("/v0/inboxes", { token: intersected.api_key }),
        ListInboxesResponse,
      )
    ).count,
  ).toBe(0);
  const all = await decoded(
    await api.request("/v0/api-keys", {
      method: "POST",
      body: { permissions: { message_read: true }, send_policy: "read_only" },
    }),
    CreateApiKeyResponse,
  );
  expect(
    (await decoded(await api.request("/v0/threads", { token: all.api_key }), ListThreadsResponse))
      .count,
  ).toBe(2);
});

test("requires hidden-label read permissions for flags, direct reads, batches, threads, and downloads", async ({
  api,
}) => {
  const key = await createKey(api);
  const raw = await decoded(
    await api.request(`${messagePath}/raw`, { token: key.api_key }),
    RawMessageResponse,
  );
  await api.run(
    api.mailbox.updateMessage(inboxId, messageId, { add_labels: ["spam", "unauthenticated"] }),
  );
  expect(
    (
      await decoded(
        await api.request(
          `/v0/inboxes/${inboxId}/messages?include_spam=true&include_unauthenticated=true`,
          { token: key.api_key },
        ),
        ListMessagesResponse,
      )
    ).count,
  ).toBe(0);
  expect(
    (
      await decoded(
        await api.request("/v0/threads?include_spam=true&include_unauthenticated=true", {
          token: key.api_key,
        }),
        ListThreadsResponse,
      )
    ).count,
  ).toBe(0);
  await failure(await api.request(messagePath, { token: key.api_key }), 404, "not_found");
  await failure(
    await api.request(`/v0/threads/${api.threadId}`, { token: key.api_key }),
    404,
    "not_found",
  );
  expect(
    (
      await decoded(
        await api.request(`/v0/inboxes/${inboxId}/messages/batch-get`, {
          token: key.api_key,
          method: "POST",
          body: { message_ids: [messageId] },
        }),
        BatchGetMessagesResponse,
      )
    ).count,
  ).toBe(0);
  await failure(
    await api.request(raw.download_url.slice(api.url.length), { token: key.api_key }),
    404,
    "not_found",
  );
  const permitted = await createKey(api, {
    permissions: { message_read: true, label_spam_read: true, label_unauthenticated_read: true },
  });
  expect(
    (
      await decoded(
        await api.request(
          `/v0/inboxes/${inboxId}/messages?include_spam=true&include_unauthenticated=true`,
          { token: permitted.api_key },
        ),
        ListMessagesResponse,
      )
    ).count,
  ).toBe(1);
  await decoded(await api.request(messagePath, { token: permitted.api_key }), Message);
  await decoded(
    await api.request(`/v0/threads/${api.threadId}`, { token: permitted.api_key }),
    Thread,
  );
  await decoded(await api.request(messagePath), Message);
});

test("returns contract-decoded ingested mail and round-trips message, thread, inbox, and key pagination", async ({
  api,
}) => {
  const created = await decoded(
    await api.request("/v0/inboxes", {
      method: "POST",
      body: { username: "third", domain: "example.test" },
    }),
    Inbox,
  );
  expect(created.inbox_id).toBe("third@example.test");
  const message = await decoded(await api.request(messagePath), Message);
  expect(message.message_id).toBe(messageId);
  expect(message.text).toContain("searchable project");
  for (let index = 0; index < 2; index++)
    await api.run(
      api.mailbox.insertMessage({
        inbox_id: inboxId,
        message_id: `<page-${index}@example.test>`,
        direction: "received",
        from: "alice@example.test",
        to: [inboxId],
        subject: "Synthetic project update",
        timestamp: `2026-10-10T11:0${index}:00Z`,
        raw: Buffer.from("Synthetic raw MIME"),
      }),
    );
  const paths = [
    { path: `/v0/inboxes/${inboxId}/messages`, schema: ListMessagesResponse },
    { path: "/v0/threads", schema: ListThreadsResponse },
    { path: "/v0/inboxes", schema: ListInboxesResponse },
  ];
  for (const { path, schema } of paths) {
    const first = await decoded(await api.request(`${path}?limit=1`), schema);
    const second = await decoded(
      await api.request(`${path}?limit=1&page_token=${nextPage(first.next_page_token)}`),
      schema,
    );
    expect(first.count).toBe(1);
    expect(second.count).toBe(1);
    expect(first).not.toEqual(second);
  }
  const key1 = await createKey(api);
  await createKey(api);
  const first = await decoded(await api.request("/v0/api-keys?limit=1"), ListApiKeysResponse);
  const second = await decoded(
    await api.request(`/v0/api-keys?limit=1&page_token=${nextPage(first.next_page_token)}`),
    ListApiKeysResponse,
  );
  expect(first.api_keys[0]?.api_key_id).not.toBe(second.api_keys[0]?.api_key_id);
  const ownerThreads = await decoded(await api.request("/v0/threads?limit=1"), ListThreadsResponse);
  await failure(
    await api.request(`/v0/threads?limit=1&page_token=${nextPage(ownerThreads.next_page_token)}`, {
      token: key1.api_key,
    }),
    409,
    "page_token_stale",
  );
  await decoded(
    await api.request(`/v0/inboxes/${inboxId}/messages/search?q=project`),
    SearchMessagesResponse,
  );
  await decoded(
    await api.request(`/v0/inboxes/${inboxId}/threads/search?q=project`),
    SearchThreadsResponse,
  );
});

test("updates and deletes mailbox resources and supports inbox-scoped owner key administration", async ({
  api,
}) => {
  const updated = await decoded(
    await api.request(messagePath, { method: "PATCH", body: { add_labels: "seen" } }),
    UpdateMessageResponse,
  );
  expect(updated.labels).toContain("seen");
  await decoded(
    await api.request(`/v0/threads/${api.threadId}`, {
      method: "PATCH",
      body: { add_labels: ["processed"] },
    }),
    UpdateThreadResponse,
  );
  const batch = await decoded(
    await api.request(`/v0/inboxes/${inboxId}/messages/batch-update`, {
      method: "POST",
      body: { message_ids: [messageId, "<missing@example.test>"], add_labels: ["batched"] },
    }),
    BatchUpdateMessagesResponse,
  );
  expect(batch.count).toBe(1);
  await decoded(
    await api.request(`/v0/inboxes/${inboxId}`, { method: "PATCH", body: { status: "paused" } }),
    Inbox,
  );
  const key = await decoded(
    await api.request(`/v0/inboxes/${inboxId}/api-keys`, {
      method: "POST",
      body: { permissions: { message_read: true }, send_policy: "read_only" },
    }),
    CreateApiKeyResponse,
  );
  expect(key.inbox_id).toBe(inboxId);
  expect(
    (await decoded(await api.request(`/v0/inboxes/${inboxId}/api-keys`), ListApiKeysResponse))
      .count,
  ).toBe(1);
  await failure(
    await api.request(`/v0/inboxes/${otherInbox}/api-keys/${key.api_key_id}`, { method: "DELETE" }),
    404,
    "not_found",
  );
  await decoded(
    await api.request(`/v0/inboxes/${inboxId}/api-keys/${key.api_key_id}`, {
      method: "PATCH",
      body: { name: "Scoped" },
    }),
    ApiKey,
  );
  expect(
    (await api.request(`/v0/inboxes/${inboxId}/api-keys/${key.api_key_id}`, { method: "DELETE" }))
      .status,
  ).toBe(200);
  expect((await api.request(`/v0/threads/${api.threadId}`, { method: "DELETE" })).status).toBe(200);
  await failure(await api.request(messagePath), 404, "not_found");
  expect((await api.request(`/v0/inboxes/${inboxId}`, { method: "DELETE" })).status).toBe(200);
  await failure(await api.request(`/v0/inboxes/${inboxId}`), 404, "not_found");
});

test("allows inbox creation with permission while preserving immutable scope and transactional rollback", async ({
  api,
}) => {
  const scoped = await createKey(api, {
    inbox_ids: ["new@example.test"],
    permissions: { inbox_create: true },
  });
  await decoded(
    await api.request("/v0/inboxes", {
      token: scoped.api_key,
      method: "POST",
      body: { username: "new", domain: "example.test" },
    }),
    Inbox,
  );
  await failure(
    await api.request("/v0/inboxes", {
      token: scoped.api_key,
      method: "POST",
      body: { username: "escape", domain: "example.test" },
    }),
    404,
    "not_found",
  );
  await failure(await api.request("/v0/inboxes/escape@example.test"), 404, "not_found");
  await failure(
    await api.request("/v0/inboxes", {
      token: scoped.api_key,
      method: "POST",
      body: { username: "other", domain: "example.test" },
    }),
    404,
    "not_found",
  );
  await api.run(
    api.mailbox.createInbox({
      username: "replayed",
      domain: "example.test",
      client_id: "shared-id",
    }),
  );
  await failure(
    await api.request("/v0/inboxes", {
      token: scoped.api_key,
      method: "POST",
      body: { username: "new", domain: "example.test", client_id: "shared-id" },
    }),
    404,
    "not_found",
  );
  await failure(
    await api.request("/v0/inboxes", {
      token: scoped.api_key,
      method: "POST",
      body: { username: "different", domain: "example.test", client_id: "replay" },
    }),
    404,
    "not_found",
  );
});

test("maps malformed requests, missing resources, stale tokens, and unsupported families to safe wire errors", async ({
  api,
}) => {
  for (const path of [
    "/v0/inboxes?limit=garbage",
    "/v0/inboxes?limit=0",
    `/v0/inboxes/${inboxId}/messages?include_spam=maybe`,
  ])
    await failure(await api.request(path), 400, "validation_error");
  await failure(
    await api.request("/v0/api-keys", {
      method: "POST",
      body: { permissions: { unexpected_permission: true }, send_policy: "direct" },
    }),
    400,
    "validation_error",
  );
  await failure(
    await api.request("/v0/inboxes", { method: "POST", body: { domain: 12 } }),
    400,
    "validation_error",
  );
  const invalidJson = await fetch(`${api.url}/v0/inboxes`, {
    method: "POST",
    headers: { authorization: `Bearer ${api.token}`, "content-type": "application/json" },
    body: "{invalid secret body",
  });
  const body = await failure(invalidJson, 400, "validation_error");
  expect(JSON.stringify(body)).not.toContain("secret body");
  await failure(
    await api.request("/v0/inboxes", {
      method: "POST",
      body: {},
      headers: { "content-type": "text/plain" },
    }),
    400,
    "validation_error",
  );
  await failure(await api.request("/v0/inboxes/missing@example.test"), 404, "not_found");
  await failure(await api.request("/v0/unknown"), 404, "not_found");
  await failure(await api.request("/v0/inboxes?page_token=invalid"), 409, "page_token_stale");
  for (const path of ["/v0/lists/receive/allow", "/v0/webhooks", "/v0/domains"])
    await failure(
      await api.request(path, path.includes("/messages/") ? { method: "POST", body: {} } : {}),
      501,
      "not_supported",
    );
});

test("rejects foreign and null browser origins and accepts same-origin requests", async ({
  api,
}) => {
  for (const origin of ["https://attacker.example", "null", "http://127.0.0.1:1"])
    await failure(
      await api.request("/v0/inboxes", { headers: { origin } }),
      403,
      "missing_permission",
    );
  await decoded(
    await api.request("/v0/inboxes", { headers: { origin: api.url } }),
    ListInboxesResponse,
  );
});

test("maps storage failures and unexpected defects to 503 without exposing internals", async ({
  api,
}) => {
  const original = api.mailbox.getMessage;
  try {
    api.mailbox.getMessage = () =>
      Effect.fail(new DatabaseError({ operation: "private-database-detail" }));
    const storage = await failure(await api.request(messagePath), 503, "service_unavailable");
    expect(JSON.stringify(storage)).not.toContain("private-database-detail");
    api.mailbox.getMessage = () => Effect.die(new Error("Private synthetic message content"));
    const defect = await failure(await api.request(messagePath), 503, "service_unavailable");
    expect(JSON.stringify(defect)).not.toContain("Private synthetic message content");
  } finally {
    api.mailbox.getMessage = original;
  }
  const key = await createKey(api);
  const authenticate = api.keys.authenticate;
  try {
    api.keys.authenticate = () => Effect.fail(new DatabaseError({ operation: "authenticate" }));
    await failure(
      await api.request("/v0/inboxes", { token: key.api_key }),
      503,
      "service_unavailable",
    );
  } finally {
    api.keys.authenticate = authenticate;
  }
});

test("serves authenticated raw and attachment downloads with live scope, revocation, tamper, and expiry checks", async ({
  api,
}) => {
  const key = await createKey(api);
  const raw = await decoded(
    await api.request(`${messagePath}/raw`, { token: key.api_key }),
    RawMessageResponse,
  );
  expect(raw.size).toBe(api.raw.byteLength);
  const path = raw.download_url.slice(api.url.length);
  await failure(await api.request(path, { token: null }), 401, "unauthorized");
  const download = await api.request(path, { token: key.api_key });
  expect(download.status).toBe(200);
  expect(Buffer.from(await download.arrayBuffer())).toEqual(api.raw);
  const outside = await createKey(api, { inbox_ids: [otherInbox] });
  await failure(await api.request(path, { token: outside.api_key }), 404, "not_found");
  await failure(
    await api.request(`${path.slice(0, -3)}aaa`, { token: key.api_key }),
    404,
    "not_found",
  );
  const stored = await api.run(
    api.mailbox.insertMessage({
      inbox_id: inboxId,
      message_id: "<attachment@example.test>",
      direction: "received",
      from: "alice@example.test",
      to: [inboxId],
      timestamp: "2026-10-10T11:00:00Z",
      raw: Buffer.from("MIME"),
      attachments: [
        {
          attachment_id: "file-1",
          filename: "sample.txt",
          content_type: "text/plain",
          content: Buffer.from("Synthetic attachment"),
        },
      ],
    }),
  );
  for (const attachmentPath of [
    `/v0/inboxes/${inboxId}/messages/${encodeURIComponent("<attachment@example.test>")}/attachments/file-1`,
    `/v0/inboxes/${inboxId}/threads/${stored.thread_id}/attachments/file-1`,
    `/v0/threads/${stored.thread_id}/attachments/file-1`,
  ]) {
    const attachment = await decoded(
      await api.request(attachmentPath, { token: key.api_key }),
      AttachmentResponse,
    );
    expect(
      await (
        await api.request(attachment.download_url.slice(api.url.length), { token: key.api_key })
      ).text(),
    ).toBe("Synthetic attachment");
  }
  api.advance(5 * 60_000);
  await failure(await api.request(path, { token: key.api_key }), 404, "not_found");
  const fresh = await decoded(
    await api.request(`${messagePath}/raw`, { token: key.api_key }),
    RawMessageResponse,
  );
  await api.request(`/v0/api-keys/${key.api_key_id}`, { method: "DELETE" });
  await failure(
    await api.request(fresh.download_url.slice(api.url.length), { token: key.api_key }),
    401,
    "unauthorized",
  );
});

const Ready = Schema.Struct({ event: Schema.Literal("server.ready"), url: Schema.String });

function spawnServer(home: string, args: readonly string[] = []) {
  const child = spawn(
    process.execPath,
    ["dist/apps/server/src/main.js", "serve", "--home", home, "--port", "0", "--init", ...args],
    {
      cwd: process.cwd(),
      env: { ...process.env, INBOT_TEST_MEMORY_KEYCHAIN: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  return { child, exited, stderr: () => stderr };
}

test("builds and starts the service in a child process with a test keychain and shuts down by its captured PID", async ({
  home,
}) => {
  const build = spawn("pnpm", ["build"], { cwd: process.cwd(), stdio: "pipe" });
  let buildOutput = "";
  build.stdout?.on("data", (data: Buffer) => {
    buildOutput += data.toString();
  });
  build.stderr?.on("data", (data: Buffer) => {
    buildOutput += data.toString();
  });
  const buildCode = await new Promise<number | null>((resolve, reject) => {
    build.once("error", reject);
    build.once("exit", resolve);
  });
  expect(buildCode, buildOutput).toBe(0);
  const processServer = spawnServer(home);
  const { child, exited } = processServer;
  let timer: NodeJS.Timeout | undefined;
  const lines: string[] = [];
  const reader = createInterface({ input: child.stdout });
  try {
    const ready = await Promise.race([
      new Promise<typeof Ready.Type>((resolve, reject) => {
        reader.on("line", (line) => {
          lines.push(line);
          try {
            const event = Schema.decodeUnknownSync(
              Schema.fromJsonString(Schema.Struct({ event: Schema.String })),
            )(line);
            if (event.event === "owner.setup_required") {
              const setup = Schema.decodeUnknownSync(
                Schema.fromJsonString(Schema.Struct({ event: Schema.String, code: Schema.String })),
              )(line);
              expect(setup.code).toMatch(/^[A-Za-z0-9_-]{32}$/);
              return;
            }
            resolve(Schema.decodeUnknownSync(Schema.fromJsonString(Ready))(line));
          } catch {
            reject(new Error("Unexpected server stdout"));
          }
        });
      }),
      exited.then(() => {
        throw new Error(`Server exited before ready: ${processServer.stderr()}`);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Server ready timeout")), 10_000);
      }),
    ]);
    expect(ready.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const connection = Schema.decodeUnknownSync(Schema.fromJsonString(Connection))(
      await readFile(join(home, "connection.json"), "utf8"),
    );
    expect(connection.url).toBe(ready.url);
    await decoded(
      await fetch(`${ready.url}/v0/inboxes`, {
        headers: { authorization: `Bearer ${connection.token}` },
      }),
      ListInboxesResponse,
    );
    const pid = child.pid;
    if (pid === undefined) throw new Error("Expected the spawned server PID");
    process.kill(pid, "SIGTERM");
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(lines).toHaveLength(2);
    expect(processServer.stderr()).toBe("");
    expect(await readFile(join(home, "connection.json"), "utf8")).toBeTruthy();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    reader.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await exited;
    }
  }
  const production = spawnServer(home, ["--flavor", "production"]);
  expect((await production.exited).code).toBe(1);
  expect(production.stderr()).toContain("server.failed");
}, 20_000);
