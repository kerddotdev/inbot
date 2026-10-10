import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, test as baseTest } from "vitest";
import { Draft, ListDraftsResponse } from "../../../../packages/contracts/src/drafts.js";
import { ErrorResponse } from "../../../../packages/contracts/src/errors.js";
import { SendMessageResponse } from "../../../../packages/contracts/src/messages.js";
import type { CreateApiKeyRequest } from "../../../../packages/contracts/src/api-keys.js";
import { fixture } from "./test-fixture.js";
import { client } from "../mcp/test-client.js";

const inboxId = "agent@example.test";
const parentId = "<first@example.test>";
const route = `/v0/inboxes/${inboxId}/drafts`;
const body = {
  to: ["recipient@example.test"],
  subject: "Synthetic draft",
  text: "Private synthetic draft body",
};
const permissions = {
  draft_read: true,
  draft_create: true,
  draft_update: true,
  draft_delete: true,
  draft_send: true,
  message_read: true,
};
const test = baseTest.extend<{ api: Awaited<ReturnType<typeof fixture>> }>({
  api: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-drafts-test-"));
    const api = await fixture(home);
    try {
      await use(api);
    } finally {
      await api.close();
      await rm(home, { recursive: true, force: true });
    }
  },
});
async function failure(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const error = Schema.decodeUnknownSync(ErrorResponse)(await response.json());
  expect(error.code).toBe(code);
  expect(Object.keys(error).sort()).toEqual(["code", "fix", "message", "name"]);
  return error;
}
async function create(
  api: Awaited<ReturnType<typeof fixture>>,
  input: unknown = body,
  token?: string,
) {
  const response = await api.request(route, {
    method: "POST",
    body: input,
    ...(token === undefined ? {} : { token }),
  });
  expect(response.status).toBe(200);
  return Schema.decodeUnknownSync(Draft)(await response.json());
}
async function key(
  api: Awaited<ReturnType<typeof fixture>>,
  options: Partial<CreateApiKeyRequest> = {},
) {
  return api.run(
    api.keys.create({ inbox_id: inboxId, send_policy: "direct", permissions, ...options }),
  );
}
async function configured(api: Awaited<ReturnType<typeof fixture>>) {
  await api.run(api.transport.set({ account_id: "fake", api_token: "fake" }));
}

test("REST CRUD persists encrypted drafts, replays client_id, and clears fields and attachments", async ({
  api,
}) => {
  const agent = await key(api);
  const input = {
    ...body,
    client_id: "draft-client-1",
    labels: ["review"],
    reply_to: ["reply@example.test"],
    attachments: [
      {
        filename: "note.txt",
        content_type: "text/plain",
        content: Buffer.from("Private attachment").toString("base64"),
      },
    ],
  };
  const draft = await create(api, input, agent.api_key);
  expect(draft.created_by).toBe(agent.api_key_id);
  expect((await create(api, { ...input, subject: "Different" }, agent.api_key)).draft_id).toBe(
    draft.draft_id,
  );
  expect(
    Schema.decodeUnknownSync(Draft)(
      await (await api.request(`/v0/drafts/${draft.draft_id}`, { token: agent.api_key })).json(),
    ),
  ).toEqual(draft);
  const attachment = draft.attachments?.[0];
  if (attachment === undefined) throw new Error("Expected draft attachment");
  const metadata = await api.request(
    `${route}/${draft.draft_id}/attachments/${attachment.attachment_id}`,
    { token: agent.api_key },
  );
  const download = Schema.decodeUnknownSync(Schema.Struct({ download_url: Schema.String }))(
    await metadata.json(),
  );
  const bytes = await api.request(new URL(download.download_url).pathname, {
    token: agent.api_key,
  });
  expect(await bytes.text()).toBe("Private attachment");
  const updated = await api.request(`${route}/${draft.draft_id}`, {
    token: agent.api_key,
    method: "PATCH",
    body: {
      subject: null,
      reply_to: null,
      to: [],
      add_labels: ["edited"],
      remove_labels: ["review"],
      remove_attachments: [attachment.attachment_id],
    },
  });
  expect(updated.status).toBe(200);
  const result = Schema.decodeUnknownSync(Draft)(await updated.json());
  expect(result.subject).toBeUndefined();
  expect(result.reply_to).toBeUndefined();
  expect(result.to).toEqual([]);
  expect(result.labels).toEqual(["edited"]);
  expect(result.attachments).toEqual([]);
  for (const file of await readdir(api.home))
    expect((await readFile(join(api.home, file))).includes(Buffer.from(body.text))).toBe(false);
  expect(
    (await api.request(`${route}/${draft.draft_id}`, { token: agent.api_key, method: "DELETE" }))
      .status,
  ).toBe(200);
  await failure(
    await api.request(`${route}/${draft.draft_id}`, { token: agent.api_key }),
    404,
    "not_found",
  );
  await failure(
    await api.request(new URL(download.download_url).pathname, { token: agent.api_key }),
    404,
    "not_found",
  );
});

test("REST permissions and scopes constrain CRUD, organization lists, gets, downloads and pagination", async ({
  api,
}) => {
  const agent = await key(api);
  const first = await create(api);
  api.advance(1000);
  const second = await create(api, { ...body, labels: ["review"] });
  await api.request("/v0/inboxes/other@example.test/drafts", { method: "POST", body });
  const page = Schema.decodeUnknownSync(ListDraftsResponse)(
    await (await api.request("/v0/drafts?limit=1", { token: agent.api_key })).json(),
  );
  expect(page.drafts.map((value) => value.draft_id)).toEqual([second.draft_id]);
  const next = Schema.decodeUnknownSync(ListDraftsResponse)(
    await (
      await api.request(`/v0/drafts?limit=1&page_token=${page.next_page_token}`, {
        token: agent.api_key,
      })
    ).json(),
  );
  expect(next.drafts.map((value) => value.draft_id)).toEqual([first.draft_id]);
  expect(next.next_page_token).toBeUndefined();
  expect(
    Schema.decodeUnknownSync(ListDraftsResponse)(
      await (
        await api.request(`/v0/drafts?labels=review&after=2026-10-10T12:00:00Z`, {
          token: agent.api_key,
        })
      ).json(),
    ).drafts,
  ).toHaveLength(1);
  await failure(
    await api.request(`/v0/drafts?ascending=true&page_token=${page.next_page_token}`, {
      token: agent.api_key,
    }),
    409,
    "page_token_stale",
  );
  await failure(
    await api.request("/v0/inboxes/other@example.test/drafts", {
      token: agent.api_key,
      method: "POST",
      body,
    }),
    404,
    "not_found",
  );
  const foreign = await api.run(api.drafts.create("other@example.test", body, "owner", false));
  await failure(
    await api.request(`/v0/drafts/${foreign.draft_id}`, { token: agent.api_key }),
    404,
    "not_found",
  );
  await api.run(api.keys.update(agent.api_key_id, { permissions: {} }));
  for (const [method, path, payload] of [
    ["GET", route, undefined],
    ["POST", route, body],
    ["PATCH", `${route}/${first.draft_id}`, {}],
    ["DELETE", `${route}/${first.draft_id}`, undefined],
    ["POST", `${route}/${first.draft_id}/send`, {}],
  ] as const)
    await failure(
      await api.request(path, {
        token: agent.api_key,
        method,
        ...(payload === undefined ? {} : { body: payload }),
      }),
      403,
      "missing_permission",
    );
  const empty = await key(api, { inbox_ids: [] });
  expect(
    Schema.decodeUnknownSync(ListDraftsResponse)(
      await (await api.request("/v0/drafts", { token: empty.api_key })).json(),
    ).drafts,
  ).toEqual([]);
});

test("sends a reply draft in the original thread, atomically deletes it and replays Idempotency-Key", async ({
  api,
}) => {
  await configured(api);
  const agent = await key(api);
  const draft = await create(
    api,
    { in_reply_to: parentId, reply_all: true, text: "Draft reply" },
    agent.api_key,
  );
  expect(draft.to).toEqual(["Alice <alice@example.test>"]);
  expect(draft.subject).toBe("Re: Synthetic project update");
  const options = {
    token: agent.api_key,
    method: "POST",
    body: { add_labels: ["reviewed"] },
    headers: { "idempotency-key": "draft-send-1" },
  };
  const response = await api.request(`${route}/${draft.draft_id}/send`, options);
  expect(response.status).toBe(200);
  const sent = Schema.decodeUnknownSync(SendMessageResponse)(await response.json());
  expect(sent.thread_id).toBe(api.threadId);
  expect((await api.run(api.mailbox.getMessage(inboxId, sent.message_id))).in_reply_to).toBe(
    parentId,
  );
  await failure(await api.request(`${route}/${draft.draft_id}`), 404, "not_found");
  expect(
    Schema.decodeUnknownSync(SendMessageResponse)(
      await (await api.request(`${route}/${draft.draft_id}/send`, options)).json(),
    ),
  ).toEqual(sent);
  await failure(
    await api.request(`${route}/${draft.draft_id}/send`, { ...options, body: {} }),
    409,
    "idempotency_conflict",
  );
  expect(await api.run(api.outbox.processDue())).toBe(1);
  expect(api.sent).toHaveLength(1);
});

test("approval sends, replies, reply-all and forwards create replayable pending drafts with unchanged errors", async ({
  api,
}) => {
  await configured(api);
  const agent = await key(api, {
    send_policy: "approval",
    permissions: { ...permissions, message_send: true, message_reply: true },
  });
  for (const kind of ["send", "reply", "reply-all", "forward"] as const) {
    const path = `/v0/inboxes/${inboxId}/messages/${kind === "send" ? "send" : `${encodeURIComponent(parentId)}/${kind}`}`;
    const input =
      kind === "send" || kind === "forward"
        ? { to: body.to, text: "Approval body" }
        : { text: "Approval reply" };
    const options = {
      token: agent.api_key,
      method: "POST",
      body: input,
      headers: { "idempotency-key": `approval-${kind}` },
    };
    const error = await failure(await api.request(path, options), 403, "approval_required");
    expect(await failure(await api.request(path, options), 403, "approval_required")).toEqual(
      error,
    );
    const drafts = Schema.decodeUnknownSync(ListDraftsResponse)(
      await (await api.request(route)).json(),
    ).drafts;
    const draft = drafts.find((value) => error.message.includes(value.draft_id));
    if (draft === undefined) throw new Error("Expected pending draft identity");
    expect(draft.pending_approval).toBe(true);
    expect(draft.approval_state).toBe("pending");
    expect(error.fix).toContain(draft.draft_id);
    const approved = await api.request(`${route}/${draft.draft_id}/approve`, { method: "POST" });
    expect(approved.status).toBe(200);
    const sent = Schema.decodeUnknownSync(SendMessageResponse)(await approved.json());
    expect(sent.thread_id === api.threadId).toBe(kind === "reply" || kind === "reply-all");
    const message = await api.run(api.mailbox.getMessage(inboxId, sent.message_id));
    if (kind === "forward") expect(message.text).toContain("A searchable project message.");
  }
  expect(await api.run(api.outbox.processDue())).toBe(4);
  expect(api.sent).toHaveLength(4);
});

test("send_draft requests approval, only owners approve or reject, and rejection remains unsendable", async ({
  api,
}) => {
  await configured(api);
  const agent = await key(api, { send_policy: "approval" });
  const draft = await create(api, body, agent.api_key);
  await failure(
    await api.request(`${route}/${draft.draft_id}/send`, {
      token: agent.api_key,
      method: "POST",
      body: { add_labels: ["submitted"] },
    }),
    403,
    "approval_required",
  );
  const replayOptions = {
    token: agent.api_key,
    method: "POST",
    body: {},
    headers: { "idempotency-key": "approval-draft-send" },
  };
  const approvalError = await failure(
    await api.request(`${route}/${draft.draft_id}/send`, replayOptions),
    403,
    "approval_required",
  );
  expect(
    await failure(
      await api.request(`${route}/${draft.draft_id}/send`, replayOptions),
      403,
      "approval_required",
    ),
  ).toEqual(approvalError);
  await failure(
    await api.request(`${route}/${draft.draft_id}/send`, {
      ...replayOptions,
      body: { add_labels: ["changed"] },
    }),
    409,
    "idempotency_conflict",
  );
  for (const action of ["approve", "reject"])
    await failure(
      await api.request(`${route}/${draft.draft_id}/${action}`, {
        token: agent.api_key,
        method: "POST",
        ...(action === "reject" ? { body: {} } : {}),
      }),
      403,
      "missing_permission",
    );
  const rejected = Schema.decodeUnknownSync(Draft)(
    await (
      await api.request(`${route}/${draft.draft_id}/reject`, {
        method: "POST",
        body: { reason: "Revise the recipient" },
      })
    ).json(),
  );
  expect(rejected.approval_state).toBe("rejected");
  expect(rejected.rejection_reason).toBe("Revise the recipient");
  expect(rejected.labels).toContain("submitted");
  await failure(
    await api.request(`${route}/${draft.draft_id}/send`, { method: "POST", body: {} }),
    403,
    "message_rejected",
  );
  await failure(
    await api.request(`${route}/${draft.draft_id}/approve`, { method: "POST" }),
    403,
    "message_rejected",
  );
  expect(await api.run(api.outbox.processDue())).toBe(0);
});

test("approval revalidates transport and message limits without deleting or approving invalid drafts", async ({
  api,
}) => {
  const agent = await key(api, { send_policy: "approval" });
  const draft = await create(api, body, agent.api_key);
  await failure(
    await api.request(`${route}/${draft.draft_id}/approve`, { method: "POST" }),
    503,
    "service_unavailable",
  );
  expect((await api.run(api.drafts.get(inboxId, draft.draft_id))).approval_state).toBe("pending");
  await configured(api);
  await api.request(`${route}/${draft.draft_id}`, {
    method: "PATCH",
    body: { text: "x".repeat(6 * 1024 * 1024) },
  });
  await failure(
    await api.request(`${route}/${draft.draft_id}/approve`, { method: "POST" }),
    413,
    "payload_too_large",
  );
  expect((await api.run(api.drafts.get(inboxId, draft.draft_id))).approval_state).toBe("pending");
  await api.request(`${route}/${draft.draft_id}`, { method: "PATCH", body: { text: body.text } });
  await api.run(api.transport.clear());
  await failure(
    await api.request(`${route}/${draft.draft_id}/approve`, { method: "POST" }),
    503,
    "service_unavailable",
  );
});

test("schedules only due direct or approved drafts, sends late honestly, and deleting or clearing send_at cancels", async ({
  api,
}) => {
  await configured(api);
  const future = "2026-10-10T12:01:00Z";
  const direct = await create(api, { ...body, send_at: future });
  const cancelled = await create(api, { ...body, send_at: future });
  const cleared = await create(api, { ...body, send_at: future });
  const agent = await key(api, { send_policy: "approval" });
  const pending = await create(api, { ...body, send_at: future }, agent.api_key);
  const approved = await create(api, { ...body, send_at: future }, agent.api_key);
  expect(
    Schema.decodeUnknownSync(Draft)(
      await (
        await api.request(`${route}/${approved.draft_id}/approve`, {
          method: "POST",
          headers: { "idempotency-key": "scheduled-approval" },
        })
      ).json(),
    ).approval_state,
  ).toBe("approved");
  expect(await api.run(api.drafts.processDue())).toBe(0);
  expect(await api.run(api.outbox.processDue())).toBe(0);
  await api.request(`${route}/${cancelled.draft_id}`, { method: "DELETE" });
  await api.request(`${route}/${cleared.draft_id}`, { method: "PATCH", body: { send_at: null } });
  api.advance(90_000);
  expect(await api.run(api.drafts.processDue())).toBe(2);
  expect(await api.run(api.drafts.processDue())).toBe(0);
  expect(await api.run(api.outbox.processDue())).toBe(2);
  expect(api.sent).toHaveLength(2);
  const replay = await api.request(`${route}/${approved.draft_id}/approve`, {
    method: "POST",
    headers: { "idempotency-key": "scheduled-approval" },
  });
  expect(replay.status).toBe(200);
  const queued = Schema.decodeUnknownSync(SendMessageResponse)(await replay.json());
  expect((await api.run(api.outbox.get(inboxId, queued.message_id))).state).toBe("sent");
  await failure(await api.request(`${route}/${direct.draft_id}`), 404, "not_found");
  expect((await api.run(api.drafts.get(inboxId, pending.draft_id))).approval_state).toBe("pending");
  expect((await api.run(api.drafts.get(inboxId, cleared.draft_id))).send_status).toBeUndefined();
  const messages = await api.run(api.mailbox.listMessages(inboxId));
  expect(
    messages.messages
      .filter((message) => message.labels.includes("sent"))
      .every((message) => message.timestamp === "2026-10-10T12:01:30.000Z"),
  ).toBe(true);
});

test("editing an approved draft requires another approval and read-only or missing send permissions cannot schedule", async ({
  api,
}) => {
  await configured(api);
  const agent = await key(api, { send_policy: "approval" });
  const draft = await create(api, { ...body, send_at: "2026-10-10T12:01:00Z" }, agent.api_key);
  await api.request(`${route}/${draft.draft_id}/approve`, { method: "POST" });
  await api.request(`${route}/${draft.draft_id}`, {
    token: agent.api_key,
    method: "PATCH",
    body: { text: "Changed after approval" },
  });
  api.advance(120_000);
  expect(await api.run(api.drafts.processDue())).toBe(0);
  expect((await api.run(api.drafts.get(inboxId, draft.draft_id))).pending_approval).toBe(true);
  for (const options of [
    { send_policy: "read_only" },
    { permissions: { draft_create: true, draft_update: true } },
  ] satisfies Partial<CreateApiKeyRequest>[]) {
    const restricted = await key(api, options);
    await failure(
      await api.request(route, {
        token: restricted.api_key,
        method: "POST",
        body: { ...body, send_at: "2026-10-10T12:05:00Z" },
      }),
      403,
      "missing_permission",
    );
  }
});

test("a due draft that loses transport becomes failed and keeps its contents for recovery", async ({
  api,
}) => {
  const draft = await create(api, { ...body, send_at: "2026-10-10T12:01:00Z" });
  api.advance(60_000);
  expect(await api.run(api.drafts.processDue())).toBe(1);
  expect((await api.run(api.drafts.get(inboxId, draft.draft_id))).send_status).toBe("failed");
  await configured(api);
  expect(
    (await api.request(`${route}/${draft.draft_id}/send`, { method: "POST", body: {} })).status,
  ).toBe(200);
  expect(await api.run(api.outbox.processDue())).toBe(1);
});

test("MCP draft CRUD, client id replay, pagination and send share REST behavior and permissions", async ({
  api,
}) => {
  await configured(api);
  const agent = await key(api);
  const mcp = await client(api, agent.api_key);
  const tools = (await mcp.list()).tools.map((value) => value.name);
  expect(tools).toEqual(
    expect.arrayContaining([
      "create_draft",
      "list_drafts",
      "get_draft",
      "update_draft",
      "send_draft",
      "delete_draft",
    ]),
  );
  expect(tools.some((name) => /approve|reject/.test(name))).toBe(false);
  const input = { inboxId, ...body, clientId: "mcp-draft-1", inReplyTo: parentId };
  const draft = Schema.decodeUnknownSync(Draft)(
    (await mcp.call("create_draft", input)).structuredContent,
  );
  expect(
    Schema.decodeUnknownSync(Draft)((await mcp.call("create_draft", input)).structuredContent)
      .draft_id,
  ).toBe(draft.draft_id);
  expect(
    Schema.decodeUnknownSync(Draft)(
      (await mcp.call("get_draft", { inboxId, draftId: draft.draft_id })).structuredContent,
    ).draft_id,
  ).toBe(draft.draft_id);
  await mcp.call("update_draft", {
    inboxId,
    draftId: draft.draft_id,
    subject: "Edited reply",
    addLabels: ["reviewed"],
  });
  const second = Schema.decodeUnknownSync(Draft)(
    (await mcp.call("create_draft", { inboxId, ...body })).structuredContent,
  );
  const page = Schema.decodeUnknownSync(ListDraftsResponse)(
    (await mcp.call("list_drafts", { limit: 1 })).structuredContent,
  );
  expect(page.drafts).toHaveLength(1);
  expect(page.next_page_token).toBeDefined();
  expect(
    Schema.decodeUnknownSync(ListDraftsResponse)(
      (await mcp.call("list_drafts", { limit: 1, pageToken: page.next_page_token }))
        .structuredContent,
    ).drafts,
  ).toHaveLength(1);
  const sent = Schema.decodeUnknownSync(SendMessageResponse)(
    (
      await mcp.call("send_draft", {
        inboxId,
        draftId: draft.draft_id,
        idempotencyKey: "mcp-draft-send",
      })
    ).structuredContent,
  );
  expect(sent.thread_id).toBe(api.threadId);
  expect(
    Schema.decodeUnknownSync(SendMessageResponse)(
      await (
        await api.request(`${route}/${draft.draft_id}/send`, {
          token: agent.api_key,
          method: "POST",
          body: {},
          headers: { "idempotency-key": "mcp-draft-send" },
        })
      ).json(),
    ),
  ).toEqual(sent);
  expect((await mcp.call("delete_draft", { inboxId, draftId: second.draft_id })).isError).toBe(
    false,
  );
  const foreign = await api.run(api.drafts.create("other@example.test", body, "owner", false));
  expect(
    Schema.decodeUnknownSync(ErrorResponse)(
      (await mcp.call("get_draft", { inboxId: "other@example.test", draftId: foreign.draft_id }))
        .structuredContent,
    ).code,
  ).toBe("not_found");
  await api.run(api.keys.update(agent.api_key_id, { permissions: {} }));
  expect(
    Schema.decodeUnknownSync(ErrorResponse)((await mcp.call("list_drafts", {})).structuredContent)
      .code,
  ).toBe("missing_permission");
});

test("MCP approval send_draft returns the same pending draft error as REST", async ({ api }) => {
  const agent = await key(api, { send_policy: "approval" });
  const mcp = await client(api, agent.api_key);
  const draft = Schema.decodeUnknownSync(Draft)(
    (await mcp.call("create_draft", { inboxId, ...body })).structuredContent,
  );
  const result = await mcp.call("send_draft", { inboxId, draftId: draft.draft_id });
  expect(result.isError).toBe(true);
  expect(Schema.decodeUnknownSync(ErrorResponse)(result.structuredContent).message).toContain(
    draft.draft_id,
  );
  expect((await api.run(api.drafts.get(inboxId, draft.draft_id))).pending_approval).toBe(true);
});

test("concurrent draft sends produce only one outbox entry and replay after deletion", async ({
  api,
}) => {
  await configured(api);
  const draft = await create(api);
  const responses = await Promise.all(
    Array.from({ length: 3 }, () =>
      api.request(`${route}/${draft.draft_id}/send`, {
        method: "POST",
        body: {},
        headers: { "idempotency-key": "concurrent-draft" },
      }),
    ),
  );
  const sent = await Promise.all(
    responses.map(async (response) => {
      expect(response.status).toBe(200);
      return Schema.decodeUnknownSync(SendMessageResponse)(await response.json());
    }),
  );
  expect(sent.every((value) => value.message_id === sent[0]?.message_id)).toBe(true);
  expect(await api.run(api.outbox.processDue())).toBe(1);
  expect(api.sent).toHaveLength(1);
});

test("hidden-label grants and attachment access are rechecked before every draft read or send", async ({
  api,
}) => {
  await configured(api);
  const agent = await key(api);
  const draft = await create(api, {
    ...body,
    attachments: [{ content: Buffer.from("Hidden attachment").toString("base64") }],
  });
  const attachmentId = draft.attachments?.[0]?.attachment_id;
  if (attachmentId === undefined) throw new Error("Expected attachment id");
  const metadata = Schema.decodeUnknownSync(Schema.Struct({ download_url: Schema.String }))(
    await (
      await api.request(`${route}/${draft.draft_id}/attachments/${attachmentId}`, {
        token: agent.api_key,
      })
    ).json(),
  );
  await api.request(`${route}/${draft.draft_id}`, {
    method: "PATCH",
    body: { add_labels: ["spam"] },
  });
  expect(
    Schema.decodeUnknownSync(ListDraftsResponse)(
      await (await api.request("/v0/drafts", { token: agent.api_key })).json(),
    ).drafts,
  ).toEqual([]);
  for (const path of [
    `${route}/${draft.draft_id}`,
    `/v0/drafts/${draft.draft_id}/attachments/${attachmentId}`,
    new URL(metadata.download_url).pathname,
  ])
    await failure(await api.request(path, { token: agent.api_key }), 404, "not_found");
  await failure(
    await api.request(`${route}/${draft.draft_id}/send`, {
      token: agent.api_key,
      method: "POST",
      body: {},
    }),
    404,
    "not_found",
  );
  await api.run(
    api.keys.update(agent.api_key_id, { permissions: { ...permissions, label_spam_read: true } }),
  );
  expect(
    (await api.request(new URL(metadata.download_url).pathname, { token: agent.api_key })).status,
  ).toBe(200);
  await api.run(
    api.keys.update(agent.api_key_id, {
      permissions: { message_read: true, label_spam_read: true },
    }),
  );
  await failure(
    await api.request(new URL(metadata.download_url).pathname, { token: agent.api_key }),
    403,
    "missing_permission",
  );
});

test("draft conversion rolls back both queue insertion and deletion on storage failure", async ({
  api,
}) => {
  await configured(api);
  const draft = await create(api);
  await api.run(
    api.store.use((db) =>
      db.exec(
        "CREATE TEMP TRIGGER draft_delete_fail BEFORE DELETE ON drafts BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
      ),
    ),
  );
  const options = {
    method: "POST",
    body: {},
    headers: { "idempotency-key": "rollback-draft-send" },
  };
  await failure(
    await api.request(`${route}/${draft.draft_id}/send`, options),
    503,
    "service_unavailable",
  );
  expect((await api.run(api.drafts.get(inboxId, draft.draft_id))).text).toBe(body.text);
  expect((await api.run(api.mailbox.listMessages(inboxId))).messages).toHaveLength(1);
  expect(await api.run(api.outbox.processDue())).toBe(0);
  await api.run(api.store.use((db) => db.exec("DROP TRIGGER draft_delete_fail")));
  expect((await api.request(`${route}/${draft.draft_id}/send`, options)).status).toBe(200);
  expect(await api.run(api.outbox.processDue())).toBe(1);
});

test("large MCP drafts keep their identity and provide actionable full-content guidance", async ({
  api,
}) => {
  const draft = await create(api, { ...body, text: "Synthetic draft content. ".repeat(10_000) });
  const mcp = await client(api, api.token);
  const result = await mcp.call("get_draft", { inboxId, draftId: draft.draft_id });
  const bounded = Schema.decodeUnknownSync(
    Schema.Struct({ draft_id: Schema.String, truncated: Schema.Boolean, fix: Schema.String }),
  )(result.structuredContent);
  expect(bounded.draft_id).toBe(draft.draft_id);
  expect(bounded.truncated).toBe(true);
  expect(bounded.fix).toContain("REST draft endpoints");
  await api.request(`${route}/${draft.draft_id}`, {
    method: "PATCH",
    body: { subject: "Synthetic metadata ".repeat(10_000) },
  });
  const fallback = Schema.decodeUnknownSync(
    Schema.Struct({ draft_id: Schema.String, truncated: Schema.Boolean }),
  )((await mcp.call("get_draft", { inboxId, draftId: draft.draft_id })).structuredContent);
  expect(fallback.draft_id).toBe(draft.draft_id);
  expect(fallback.truncated).toBe(true);
});
