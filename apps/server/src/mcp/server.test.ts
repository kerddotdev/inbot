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
import { ErrorResponse } from "../../../../packages/contracts/src/errors.js";
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

async function client(api: Awaited<ReturnType<typeof fixture>>, token?: string) {
  const key = token === undefined ? await api.run(api.keys.create(grant)) : undefined;
  const initialCredential = token ?? key?.api_key;
  if (initialCredential === undefined) throw new Error("Expected bearer credential");
  let credential = initialCredential;
  let id = 0;
  let session: string | undefined;
  async function rpc(method: string, params: unknown, notification = false) {
    const response = await api.request("/mcp", {
      token: credential,
      method: "POST",
      body: { jsonrpc: "2.0", ...(notification ? {} : { id: ++id }), method, params },
      headers: {
        accept: "application/json, text/event-stream",
        ...(session === undefined
          ? {}
          : { "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" }),
      },
    });
    expect(response.status).toBe(notification ? 202 : 200);
    session = response.headers.get("mcp-session-id") ?? session;
    if (notification) return undefined;
    const body = await response.text();
    const json = response.headers.get("content-type")?.includes("text/event-stream")
      ? body
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .at(-1)
          ?.slice(6)
      : body;
    const envelope = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ result: Schema.Unknown })),
    )(json);
    return envelope.result;
  }
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "inbot-test", version: "1.0.0" },
  });
  expect(
    Schema.decodeUnknownSync(Schema.Struct({ protocolVersion: Schema.String }))(initialized)
      .protocolVersion,
  ).toBe("2025-06-18");
  await rpc("notifications/initialized", {}, true);
  return {
    key,
    list: async () =>
      Schema.decodeUnknownSync(Schema.Struct({ tools: Schema.Array(McpSchema.Tool) }))(
        await rpc("tools/list", {}),
      ),
    call: async (name: string, args: unknown) => {
      const result = Schema.decodeUnknownSync(McpSchema.CallToolResult)(
        await rpc("tools/call", { name, arguments: args }),
      );
      const text = result.content.find((block) => block.type === "text");
      if (text?.type !== "text") throw new Error("Expected text content");
      expect(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(text.text)).toEqual(
        result.structuredContent,
      );
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(20_000);
      return result;
    },
    credential: (value: string) => {
      credential = value;
    },
  };
}

function failure(result: McpSchema.CallToolResult, code: string) {
  expect(result.isError).toBe(true);
  const error = Schema.decodeUnknownSync(ErrorResponse)(result.structuredContent);
  expect(error.code).toBe(code);
  expect(Object.keys(error).sort()).toEqual(["code", "fix", "message", "name"]);
  return error;
}

test("initializes with an API key and lists only mailbox tools with object schemas and accurate annotations", async ({
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
      read || tool.name.startsWith("update_") || tool.name.startsWith("delete_"),
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
  expect(response.headers.get("www-authenticate")).toBe("Bearer");
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
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
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
