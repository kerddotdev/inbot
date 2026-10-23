import {
  CredentialRequest,
  ListCredentialRequestsResponse,
} from "../../../../packages/contracts/src/credential-requests.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { McpSchema } from "effect/ai";
import { expect, test as baseTest } from "vitest";
import { Grant } from "../../../../packages/contracts/src/api-keys.js";
import { ListInboxesResponse, Inbox } from "../../../../packages/contracts/src/inboxes.js";
import {
  SendMessageResponse,
  Message,
  UpdateMessageResponse,
  ListMessagesResponse,
} from "../../../../packages/contracts/src/messages.js";
import { Webhook } from "../../../../packages/contracts/src/webhooks.js";
import { fakeCdp } from "../vault/cdp-test-server.js";
import { readEvents } from "../events/log.js";
import {
  Credential,
  CredentialFieldsResponse,
  FillCredentialResponse,
} from "../../../../packages/contracts/src/vault.js";
import { Draft, ListDraftsResponse } from "../../../../packages/contracts/src/drafts.js";
import { ErrorResponse } from "../../../../packages/contracts/src/errors.js";
import { client as connect } from "./test-client.js";
import { fixture } from "../http/test-fixture.js";

const inboxId = "agent@example.test";
const messageId = "<first@example.test>";
const grant: typeof Grant.Type = {
  inbox_id: inboxId,
  send_policy: "direct",
  permissions: {
    inbox_read: true,
    inbox_create: true,
    inbox_update: true,
    inbox_delete: true,
    message_read: true,
    message_send: true,
    message_reply: true,
    message_update: true,
    message_delete: true,
  },
};
const test = baseTest.extend<{ api: Awaited<ReturnType<typeof fixture>> }>({
  api: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-mcp-test-"));
    const api = await fixture(home);
    try {
      await use(api);
    } finally {
      await api.close();
      await rm(home, { recursive: true, force: true });
    }
  },
});

async function client(
  api: Awaited<ReturnType<typeof fixture>>,
  token?: string,
  browser?: { cookie: string; csrf: string },
) {
  const key =
    token === undefined && browser === undefined
      ? await api.run(api.keys.create(grant))
      : undefined;
  const credential = token ?? key?.api_key;
  if (credential === undefined && browser === undefined)
    throw new Error("Expected bearer credential");
  return { ...(await connect(api, credential ?? "", browser)), key };
}

function failure(result: McpSchema.CallToolResult, code: string) {
  expect(result.isError).toBe(true);
  const error = Schema.decodeUnknownSync(ErrorResponse)(result.structuredContent);
  expect(error.code).toBe(code);
  expect(Object.keys(error).sort()).toEqual(["code", "fix", "message", "name"]);
  return error;
}

test("initializes with an API key and lists mailbox, list and webhook tools with object schemas and accurate annotations", async ({
  api,
}) => {
  const mcp = await client(api);
  const { tools } = await mcp.list();
  expect(tools.map((tool) => tool.name).sort()).toEqual(
    [
      "list_inboxes",
      "search_inboxes",
      "get_inbox",
      "create_inbox",
      "update_inbox",
      "delete_inbox",
      "list_threads",
      "search_threads",
      "get_thread",
      "get_attachment",
      "update_thread",
      "delete_thread",
      "list_messages",
      "search_messages",
      "get_message",
      "send_message",
      "reply_to_message",
      "forward_message",
      "update_message",
      "create_draft",
      "list_drafts",
      "get_draft",
      "update_draft",
      "send_draft",
      "delete_draft",
      "list_list_entries",
      "get_list_entry",
      "create_list_entry",
      "delete_list_entry",
      "list_credentials",
      "get_credential",
      "create_credential",
      "update_credential",
      "delete_credential",
      "generate_password",
      "get_totp_code",
      "fill_credential",
      "capture_credential",
      "list_webhooks",
      "get_webhook",
      "create_webhook",
      "update_webhook",
      "delete_webhook",
      "get_webhook_headers",
      "update_webhook_headers",
      "request_credential",
      "get_credential_request",
      "list_credential_requests",
    ].sort(),
  );
  for (const tool of tools) {
    expect(tool.inputSchema.type).toBe("object");
    expect(Object.keys(tool.inputSchema.properties ?? {})).not.toHaveLength(0);
    expect(tool.description).toContain("untrusted external data");
    const read = /^(list_|search_|get_)/.test(tool.name);
    expect(tool.annotations?.readOnlyHint).toBe(read);
    expect(tool.annotations?.destructiveHint).toBe(tool.name.startsWith("delete_"));
    expect(tool.annotations?.idempotentHint).toBe(
      tool.name !== "update_credential" &&
        (read || tool.name.startsWith("update_") || tool.name.startsWith("delete_")),
    );
  }
  expect(
    Schema.decodeUnknownSync(ListInboxesResponse)(
      (await mcp.call("list_inboxes", {})).structuredContent,
    ).inboxes.map((item) => item.inbox_id),
  ).toEqual([inboxId]);
});

test("reads, queues, replays and updates mail using the same service and fake provider as REST", async ({
  api,
}) => {
  await api.run(api.transport.set({ account_id: "fake", api_token: "fake" }));
  const mcp = await client(api);
  const original = Schema.decodeUnknownSync(Message)(
    (await mcp.call("get_message", { inboxId, messageId })).structuredContent,
  );
  expect(original.text).toContain("searchable project");
  const input = {
    inboxId,
    to: "alice@example.test",
    subject: "MCP mail",
    text: "Hello",
    idempotencyKey: "mcp-send-1",
  };
  const sent = Schema.decodeUnknownSync(SendMessageResponse)(
    (await mcp.call("send_message", input)).structuredContent,
  );
  expect((await api.run(api.outbox.get(inboxId, sent.message_id))).state).toBe("queued");
  expect(
    Schema.decodeUnknownSync(SendMessageResponse)(
      (await mcp.call("send_message", input)).structuredContent,
    ),
  ).toEqual(sent);
  failure(await mcp.call("send_message", { ...input, text: "Different" }), "idempotency_conflict");
  const restReplay = await api.request(`/v0/inboxes/${inboxId}/messages/send`, {
    method: "POST",
    body: { to: "alice@example.test", subject: "MCP mail", text: "Hello" },
    headers: { "idempotency-key": "mcp-send-1" },
  });
  expect(Schema.decodeUnknownSync(SendMessageResponse)(await restReplay.json())).toEqual(sent);
  expect(await api.run(api.outbox.processDue())).toBe(1);
  expect(api.sent).toHaveLength(1);
  const updated = Schema.decodeUnknownSync(UpdateMessageResponse)(
    (
      await mcp.call("update_message", {
        inboxId,
        messageId: sent.message_id,
        addLabels: ["reviewed"],
      })
    ).structuredContent,
  );
  expect(updated.labels).toContain("reviewed");
  expect((await api.run(api.mailbox.getMessage(inboxId, sent.message_id))).labels).toContain(
    "reviewed",
  );
  const reply = Schema.decodeUnknownSync(SendMessageResponse)(
    (
      await mcp.call("reply_to_message", {
        inboxId,
        messageId,
        text: "Reply",
        replyAll: true,
        idempotencyKey: "mcp-reply-1",
      })
    ).structuredContent,
  );
  expect(reply.thread_id).toBe(api.threadId);
  const forward = Schema.decodeUnknownSync(SendMessageResponse)(
    (
      await mcp.call("forward_message", {
        inboxId,
        messageId,
        to: "forward@example.test",
        text: "Note",
      })
    ).structuredContent,
  );
  expect(forward.thread_id).not.toBe(api.threadId);
});

test("conceals out-of-scope resources and enforces hidden labels and current permissions per call", async ({
  api,
}) => {
  const mcp = await client(api);
  failure(await mcp.call("get_inbox", { inboxId: "other@example.test" }), "not_found");
  failure(await mcp.call("get_message", { inboxId: "other@example.test", messageId }), "not_found");
  await api.run(api.mailbox.updateMessage(inboxId, messageId, { add_labels: ["spam"] }));
  failure(await mcp.call("get_message", { inboxId, messageId }), "not_found");
  failure(await mcp.call("get_thread", { threadId: api.threadId }), "not_found");
  failure(
    await mcp.call("update_message", { inboxId, messageId, removeLabels: ["spam"] }),
    "not_found",
  );
  expect(
    Schema.decodeUnknownSync(ListMessagesResponse)(
      (await mcp.call("list_messages", { inboxId, includeSpam: true })).structuredContent,
    ).messages,
  ).toHaveLength(0);
  if (mcp.key === undefined) throw new Error("Expected API key");
  await api.run(
    api.keys.update(mcp.key.api_key_id, {
      permissions: { ...grant.permissions, label_spam_read: true },
    }),
  );
  expect((await mcp.call("get_message", { inboxId, messageId })).isError).toBe(false);
  await api.run(api.keys.update(mcp.key.api_key_id, { permissions: { inbox_read: true } }));
  failure(await mcp.call("get_message", { inboxId, messageId }), "missing_permission");
  await api.run(api.keys.delete(mcp.key.api_key_id));
  const response = await api.request("/mcp", {
    token: mcp.key.api_key,
    method: "POST",
    body: { jsonrpc: "2.0", id: 5, method: "tools/list", params: {} },
    headers: { accept: "application/json, text/event-stream" },
  });
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toBe(
    `Bearer resource_metadata="${api.url}/.well-known/oauth-protected-resource/mcp", scope="inbot", error="invalid_token"`,
  );
});

test("authenticates every MCP HTTP request, supports owner tokens and rejects invalid arguments safely", async ({
  api,
}) => {
  for (const token of [null, "invalid"])
    for (const method of ["POST", "GET", "DELETE"]) {
      const response = await api.request("/mcp", {
        token,
        method,
        ...(method === "POST"
          ? { body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } }
          : {}),
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe(
        `Bearer resource_metadata="${api.url}/.well-known/oauth-protected-resource/mcp", scope="inbot"${token === null ? "" : ', error="invalid_token"'}`,
      );
      expect(Schema.decodeUnknownSync(ErrorResponse)(await response.json()).code).toBe(
        "unauthorized",
      );
    }
  const mcp = await client(api, api.token);
  expect(
    Schema.decodeUnknownSync(ListInboxesResponse)(
      (await mcp.call("list_inboxes", {})).structuredContent,
    ).inboxes,
  ).toHaveLength(2);
  failure(await mcp.call("get_message", { inbox_id: inboxId, messageId }), "validation_error");
  failure(await mcp.call("list_inboxes", { limit: -1 }), "validation_error");
});

test("marks large untrusted bodies as truncated and bounds complete tool results", async ({
  api,
}) => {
  const largeId = "<large@example.test>";
  await api.run(
    api.mailbox.insertMessage({
      inbox_id: inboxId,
      message_id: largeId,
      direction: "received",
      from: "alice@example.test",
      to: [inboxId],
      timestamp: "2026-10-10T12:00:00Z",
      text: 'Quoted "external" content. '.repeat(20_000),
      html: "<p>content</p>".repeat(20_000),
      extracted_text: "x".repeat(100_000),
      raw: Buffer.from("Synthetic large MIME"),
    }),
  );
  const mcp = await client(api);
  const result = await mcp.call("get_message", { inboxId, messageId: largeId });
  expect(result.isError).toBe(false);
  const bounded = Schema.decodeUnknownSync(
    Schema.Struct({
      message_id: Schema.String,
      text: Schema.String,
      truncated: Schema.Boolean,
      fix: Schema.String,
    }),
  )(result.structuredContent);
  expect(bounded.message_id).toBe(largeId);
  expect(bounded.truncated).toBe(true);
  expect(bounded.text.length).toBeLessThan(3000);
  expect(bounded.fix).toContain("get_message");
  expect(bounded.fix).toContain("get_attachment");
});

test("keeps session credentials request-scoped when owner and limited keys share a session", async ({
  api,
}) => {
  const mcp = await client(api, api.token);
  const limited = await api.run(
    api.keys.create({
      inbox_id: inboxId,
      permissions: { inbox_read: true },
      send_policy: "read_only",
    }),
  );
  mcp.credential(limited.api_key);
  failure(await mcp.call("get_inbox", { inboxId: "other@example.test" }), "not_found");
  expect(
    Schema.decodeUnknownSync(Inbox)((await mcp.call("get_inbox", { inboxId })).structuredContent)
      .inbox_id,
  ).toBe(inboxId);
  mcp.credential(api.token);
  expect(
    Schema.decodeUnknownSync(Inbox)(
      (await mcp.call("get_inbox", { inboxId: "other@example.test" })).structuredContent,
    ).inbox_id,
  ).toBe("other@example.test");
});

for (const policy of ["approval", "read_only", "direct"] as const) {
  test(`enforces ${policy} policy and transport readiness through MCP`, async ({ api }) => {
    const key = await api.run(api.keys.create({ ...grant, send_policy: policy }));
    const mcp = await client(api, key.api_key);
    const input = { inboxId, to: "recipient@example.test", text: "Hello" };
    const code =
      policy === "approval"
        ? "approval_required"
        : policy === "read_only"
          ? "missing_permission"
          : "service_unavailable";
    failure(await mcp.call("send_message", input), code);
    await api.run(api.transport.set({ account_id: "fake", api_token: "fake" }));
    if (policy === "direct") {
      expect((await mcp.call("send_message", input)).isError).toBe(false);
      expect(await api.run(api.outbox.processDue())).toBe(1);
    } else {
      failure(await mcp.call("send_message", input), code);
      expect(await api.run(api.outbox.processDue())).toBe(0);
    }
  });
}

test("authenticates browser MCP requests as the owner with CSRF and keeps owner endpoints out of tools", async ({
  api,
}) => {
  const response = await api.request("/v0/owner/setup", {
    token: null,
    method: "POST",
    body: { password: "synthetic owner password", code: api.setupCode },
  });
  const body = Schema.decodeUnknownSync(Schema.Struct({ csrf_token: Schema.String }))(
    await response.json(),
  );
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (cookie === undefined) throw new Error("Expected a session cookie");
  expect(
    (
      await api.request("/mcp", {
        token: null,
        method: "POST",
        body: {},
        headers: { cookie, accept: "application/json, text/event-stream" },
      })
    ).status,
  ).toBe(403);
  const owner = await client(api, undefined, { cookie, csrf: body.csrf_token });
  const listed = await owner.list();
  expect(
    listed.tools.every(
      (tool) =>
        !tool.name.includes("owner") &&
        !tool.name.includes("session") &&
        (!tool.name.includes("password") || tool.name === "generate_password"),
    ),
  ).toBe(true);
  const result = await owner.call("list_inboxes", {});
  expect(Schema.decodeUnknownSync(ListInboxesResponse)(result.structuredContent).count).toBe(2);
});

test("lists persisted drafts over MCP and REST with an owner cookie session and CSRF", async ({
  api,
}) => {
  const draft = await api.run(
    api.drafts.create(
      inboxId,
      { to: ["recipient@example.test"], subject: "Cookie draft", text: "Synthetic draft" },
      "owner",
      false,
    ),
  );
  const setup = await api.request("/v0/owner/setup", {
    token: null,
    method: "POST",
    body: { password: "synthetic owner password", code: api.setupCode },
  });
  expect(setup.status).toBe(200);
  const { csrf_token } = Schema.decodeUnknownSync(Schema.Struct({ csrf_token: Schema.String }))(
    await setup.json(),
  );
  const cookie = setup.headers.get("set-cookie")?.split(";")[0];
  if (cookie === undefined) throw new Error("Expected a session cookie");
  const owner = await client(api, undefined, { cookie, csrf: csrf_token });
  const result = await owner.call("list_drafts", { inboxId });
  expect(result.isError).toBe(false);
  const listed = Schema.decodeUnknownSync(ListDraftsResponse)(result.structuredContent).drafts;
  expect(listed.map((value) => value.draft_id)).toEqual([draft.draft_id]);
  const rest = await api.request(`/v0/inboxes/${inboxId}/drafts`, {
    token: null,
    headers: { cookie, "x-inbot-csrf": csrf_token },
  });
  expect(rest.status).toBe(200);
  expect(Schema.decodeUnknownSync(ListDraftsResponse)(await rest.json()).drafts).toEqual(listed);
  const created = await owner.call("create_draft", {
    inboxId,
    to: ["recipient@example.test"],
    text: "Another synthetic draft",
  });
  expect(created.isError).toBe(false);
  const stored = Schema.decodeUnknownSync(Draft)(created.structuredContent);
  expect((await api.run(api.drafts.get(inboxId, stored.draft_id))).created_by).toBe("owner");
});

test("MCP webhook operations share REST permissions, inbox isolation and one-time secrets", async ({
  api,
}) => {
  const denied = await client(api);
  failure(
    await denied.call("create_webhook", {
      request: { url: "http://localhost:1234/", event_types: ["message.received"] },
    }),
    "missing_permission",
  );
  const key = await api.run(
    api.keys.create({
      inbox_id: inboxId,
      send_policy: "read_only",
      permissions: {
        message_read: true,
        webhook_create: true,
        webhook_read: true,
        webhook_update: true,
        webhook_delete: true,
      },
    }),
  );
  const mcp = await client(api, key.api_key);
  failure(
    await mcp.call("create_webhook", {
      inboxId,
      request: { url: "http://localhost:1234/", event_types: ["message.received"] },
    }),
    "validation_error",
  );
  const created = Schema.decodeUnknownSync(Webhook)(
    (
      await mcp.call("create_webhook", {
        inboxId,
        request: { url: "https://receiver.example.test/", event_types: ["message.received"] },
      })
    ).structuredContent,
  );
  expect(created.secret).toMatch(/^whsec_/);
  const metadata = await mcp.call("get_webhook", { inboxId, webhookId: created.webhook_id });
  expect(metadata.structuredContent).not.toHaveProperty("secret");
  failure(
    await mcp.call("get_webhook", { inboxId: "other@example.test", webhookId: created.webhook_id }),
    "not_found",
  );
  const updated = await mcp.call("update_webhook", {
    inboxId,
    webhookId: created.webhook_id,
    request: { enabled: false },
  });
  expect(updated.structuredContent).toMatchObject({ enabled: false });
  expect(
    (await mcp.call("delete_webhook", { inboxId, webhookId: created.webhook_id })).isError,
  ).not.toBe(true);
});

test("REST and MCP reject every system label edit on inbound and queued messages atomically", async ({
  api,
}) => {
  const mcp = await client(api);
  const sent = await api.run(
    api.outbox.enqueue(inboxId, {
      kind: "send",
      request: { to: "alice@example.test", text: "Synthetic protected labels" },
    }),
  );
  if (mcp.key === undefined) throw new Error("Expected an agent key");
  const labels = [
    "received",
    "queued",
    "sent",
    "send_unknown",
    "failed",
    "delivered",
    "bounced",
    "complained",
    "rejected",
    "deferred",
  ];
  for (const id of [messageId, sent.message_id]) {
    const before = await api.run(api.mailbox.getMessage(inboxId, id));
    for (const label of labels) {
      for (const remove of [false, true]) {
        const response = await api.request(
          `/v0/inboxes/${inboxId}/messages/${encodeURIComponent(id)}`,
          {
            token: mcp.key.api_key,
            method: "PATCH",
            body: remove
              ? { add_labels: "custom", remove_labels: label }
              : { add_labels: ["custom", label] },
          },
        );
        expect(response.status).toBe(400);
        const rest = Schema.decodeUnknownSync(ErrorResponse)(await response.json());
        expect(rest.code).toBe("validation_error");
        expect(rest.fix).toContain("Remove system state labels");
        const result = await mcp.call("update_message", {
          inboxId,
          messageId: id,
          ...(remove
            ? { addLabels: ["custom"], removeLabels: [label] }
            : { addLabels: ["custom", label] }),
        });
        expect(failure(result, "validation_error")).toEqual(rest);
      }
    }
    expect(await api.run(api.mailbox.getMessage(inboxId, id))).toEqual(before);
  }
});

test("uses metadata-only vault tools and never registers owner reveal", async ({ api }) => {
  const key = await api.run(
    api.keys.create({
      inbox_id: inboxId,
      send_policy: "read_only",
      permissions: {
        credential_read: true,
        credential_create: true,
        credential_update: true,
        credential_delete: true,
        credential_totp: true,
      },
    }),
  );
  const mcp = await client(api, key.api_key);
  const tools = await mcp.list();
  expect(tools.tools.some((tool) => /reveal/.test(tool.name))).toBe(false);
  const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const secret = "mcp-distinctive-api-secret";
  const results: unknown[] = [];
  const createdResult = await mcp.call("create_credential", {
    inboxId,
    request: { name: "MCP account", fields: { api_key: secret, totp: seed }, generate: {} },
  });
  results.push(createdResult);
  const created = Schema.decodeUnknownSync(Credential)(createdResult.structuredContent);
  expect(created.refs.password).toBe(`inbot://credentials/${created.credential_id}/password`);
  const input = { inboxId, credentialId: created.credential_id };
  results.push(await mcp.call("list_credentials", {}), await mcp.call("get_credential", input));
  results.push(await mcp.call("update_credential", { ...input, request: { name: "Renamed" } }));
  results.push(await mcp.call("generate_password", { ...input, mode: "random", length: 32 }));
  const revealed = Schema.decodeUnknownSync(CredentialFieldsResponse)(
    await (
      await api.request(`/v0/inboxes/${inboxId}/credentials/${created.credential_id}/fields`)
    ).json(),
  );
  results.push(await mcp.call("get_totp_code", input));
  const denied = await client(api);
  const deniedResult = await denied.call("get_credential", input);
  failure(deniedResult, "missing_permission");
  results.push(deniedResult);
  failure(
    await mcp.call("get_credential", { ...input, inboxId: "other@example.test" }),
    "not_found",
  );
  results.push(await mcp.call("delete_credential", input));
  failure(await mcp.call("get_credential", input), "not_found");
  for (const value of [secret, seed, ...Object.values(revealed.fields)])
    expect(JSON.stringify(results)).not.toContain(value);
});

test("fills and captures without exposing values in MCP content and enforces credential_fill", async ({
  api,
}) => {
  const secret = "mcp-fill-secret-d9K";
  const captured = "mcp-capture-secret-m2Z";
  const created = Schema.decodeUnknownSync(Credential)(
    await (
      await api.request(`/v0/inboxes/${inboxId}/credentials`, {
        method: "POST",
        body: { name: "Browser", url: "https://example.test", fields: { password: secret } },
      })
    ).json(),
  );
  const key = await api.run(
    api.keys.create({
      inbox_id: inboxId,
      permissions: { credential_fill: true },
      use_policy: "direct",
      send_policy: "read_only",
    }),
  );
  const mcp = await client(api, key.api_key);
  const denied = await client(api);
  const browser = await fakeCdp({ value: captured });
  await api.request("/v0/owner/vault/settings", {
    method: "PUT",
    body: { cdp_endpoints: [browser.endpoint] },
  });
  try {
    const input = {
      inboxId,
      credentialId: created.credential_id,
      cdp_endpoint: browser.endpoint,
      url: "https://example.test/login",
      target_id: "page-1",
      selector: "#password",
      field: "password",
    };
    const results = [];
    for (const name of ["fill_credential", "capture_credential"]) {
      const result = await denied.call(name, input);
      results.push(result);
      failure(result, "missing_permission");
    }
    expect(browser.messages).toEqual([]);
    const filled = await mcp.call("fill_credential", input);
    expect(filled.isError).not.toBe(true);
    expect(
      Schema.decodeUnknownSync(FillCredentialResponse)(filled.structuredContent),
    ).toMatchObject({
      credential_id: created.credential_id,
      field: "password",
      origin: "https://example.test",
    });
    const result = await mcp.call("capture_credential", input);
    expect(result.isError).not.toBe(true);
    expect(Schema.decodeUnknownSync(Credential)(result.structuredContent).refs.password).toBe(
      created.refs.password,
    );
    results.push(filled, result);
    const revealed = Schema.decodeUnknownSync(CredentialFieldsResponse)(
      await (
        await api.request(`/v0/inboxes/${inboxId}/credentials/${created.credential_id}/fields`)
      ).json(),
    );
    expect(revealed.fields.password).toBe(captured);
    expect(browser.messages.filter((message) => JSON.stringify(message).includes(secret))).toEqual([
      expect.objectContaining({ method: "Input.insertText", params: { text: secret } }),
    ]);
    expect(JSON.stringify(browser.messages)).not.toContain(captured);
    const rows = await api.run(api.store.use((db) => readEvents(db, 0)));
    for (const value of [secret, captured])
      expect(JSON.stringify([results, rows])).not.toContain(value);
    const { tools } = await mcp.list();
    expect(tools.some((tool) => /vault.*settings|reveal/.test(tool.name))).toBe(false);
    for (const name of ["fill_credential", "capture_credential"]) {
      const tool = tools.find((tool) => tool.name === name);
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      });
      expect(tool?.description).toContain("--remote-debugging-port");
      expect(tool?.description).toContain("credential_fill");
    }
  } finally {
    await browser.close();
  }
});

test("requests owner-entered credentials, isolates keys and returns refs without exposing owner tools or values", async ({
  api,
}) => {
  const key = await api.run(
    api.keys.create({
      inbox_ids: [inboxId],
      permissions: { credential_request: true },
      send_policy: "read_only",
    }),
  );
  const other = await api.run(
    api.keys.create({
      inbox_ids: [inboxId],
      permissions: { credential_request: true },
      send_policy: "read_only",
    }),
  );
  const mcp = await client(api, key.api_key);
  const second = await client(api, other.api_key);
  const { tools } = await mcp.list();
  expect(tools.some((tool) => /fulfill|decline/.test(tool.name))).toBe(false);
  const request = Schema.decodeUnknownSync(CredentialRequest)(
    (
      await mcp.call("request_credential", {
        inboxId,
        request: { name: "Owner account", fields: ["api_key"], reason: "Existing account needed" },
      })
    ).structuredContent,
  );
  expect(request.state).toBe("pending");
  failure(
    await second.call("get_credential_request", { inboxId, requestId: request.request_id }),
    "not_found",
  );
  expect(
    Schema.decodeUnknownSync(ListCredentialRequestsResponse)(
      (await second.call("list_credential_requests", {})).structuredContent,
    ).credential_requests,
  ).toEqual([]);
  const secret = "mcp-request-distinctive-secret-q8A";
  expect(
    (
      await api.request(`/v0/credential-requests/${request.request_id}/fulfill`, {
        method: "POST",
        body: { fields: { api_key: secret } },
      })
    ).status,
  ).toBe(200);
  const result = await mcp.call("get_credential_request", {
    inboxId,
    requestId: request.request_id,
  });
  const fulfilled = Schema.decodeUnknownSync(CredentialRequest)(result.structuredContent);
  expect(fulfilled).toMatchObject({
    state: "fulfilled",
    credential: {
      fields: ["api_key"],
      refs: { api_key: expect.stringMatching(/^inbot:\/\/credentials\//) },
    },
  });
  expect(fulfilled.requested_by).toBeUndefined();
  const listed = await mcp.call("list_credential_requests", { state: "fulfilled", limit: 1 });
  expect(
    Schema.decodeUnknownSync(ListCredentialRequestsResponse)(listed.structuredContent)
      .credential_requests,
  ).toEqual([fulfilled]);
  expect(JSON.stringify([request, result, listed])).not.toContain(secret);
  const deniedKey = await api.run(
    api.keys.create({ inbox_ids: [inboxId], permissions: {}, send_policy: "read_only" }),
  );
  const denied = await client(api, deniedKey.api_key);
  failure(
    await denied.call("request_credential", {
      inboxId,
      request: { name: "Denied", fields: ["password"], reason: "Needed" },
    }),
    "missing_permission",
  );
});
