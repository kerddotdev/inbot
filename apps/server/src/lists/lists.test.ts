import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, test as base } from "vitest";
import {
  ListListEntriesResponse,
  PodListEntry,
  type Direction,
  type ListType,
} from "../../../../packages/contracts/src/lists.js";
import { Draft } from "../../../../packages/contracts/src/drafts.js";
import { SendMessageResponse } from "../../../../packages/contracts/src/messages.js";
import { fixture } from "../http/test-fixture.js";
import { client as connect } from "../mcp/test-client.js";
import { evaluate, normalizeEntry } from "./policy.js";
import { makeLists } from "./lists.js";
import { readEvents } from "../events/log.js";

const inbox = "agent@example.test";
const other = "other@example.test";
const test = base.extend<{ api: Awaited<ReturnType<typeof fixture>> }>({
  api: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-lists-test-"));
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
const route = (direction: Direction = "receive", type: ListType = "block", inboxId?: string) =>
  `${inboxId ? `/v0/inboxes/${encodeURIComponent(inboxId)}` : "/v0"}/lists/${direction}/${type}`;
async function failure(response: Response, code: string) {
  expect(response.ok).toBe(false);
  expect(await response.json()).toMatchObject({ code, fix: expect.any(String) });
}

base("normalizes entries case-insensitively while rejecting ambiguous entries", () => {
  expect(normalizeEntry("  User@EXAMPLE.TEST ")).toEqual({
    entry: "user@example.test",
    entry_type: "email",
  });
  expect(normalizeEntry("EXAMPLE.TEST")).toEqual({ entry: "example.test", entry_type: "domain" });
  expect(normalizeEntry("bücher.test").entry).toBe("xn--bcher-kva.test");
  for (const value of [
    "",
    "*.example.test",
    "@example.test",
    "a@@example.test",
    "Alice <alice@example.test>",
    "https://example.test",
    "a..b@example.test",
    "example.test.",
    "-example.test",
    "example.test/path",
    "%65xample.test",
    "a@example.test\nInjected: yes",
  ])
    expect(() => normalizeEntry(value)).toThrow();
});

test("REST CRUD preserves scope, normalizes identity, paginates and rejects mismatched cursors", async ({
  api,
}) => {
  const path = route();
  for (const entry of ["C.TEST", "b.test", "a.test"])
    expect(
      (await api.request(path, { method: "POST", body: { entry, reason: "Synthetic rule" } }))
        .status,
    ).toBe(200);
  await failure(
    await api.request(path, { method: "POST", body: { entry: "A.TEST" } }),
    "already_exists",
  );
  const page = Schema.decodeUnknownSync(ListListEntriesResponse)(
    await (await api.request(`${path}?limit=2`)).json(),
  );
  expect(page.entries.map((item) => item.entry)).toEqual(["a.test", "b.test"]);
  expect(page.next_page_token).toBeDefined();
  expect(page.limit).toBe(2);
  const next = Schema.decodeUnknownSync(ListListEntriesResponse)(
    await (await api.request(`${path}?limit=2&page_token=${page.next_page_token}`)).json(),
  );
  expect(next.entries.map((item) => item.entry)).toEqual(["c.test"]);
  expect(next.next_page_token).toBeUndefined();
  for (const changed of [
    route("send"),
    route("receive", "allow"),
    route("receive", "block", inbox),
  ])
    await failure(
      await api.request(`${changed}?page_token=${page.next_page_token}`),
      "page_token_stale",
    );
  const local = Schema.decodeUnknownSync(PodListEntry)(
    await (
      await api.request(route("receive", "block", inbox), {
        method: "POST",
        body: { entry: "User@EXAMPLE.TEST" },
      })
    ).json(),
  );
  expect(local).toMatchObject({
    entry: "user@example.test",
    inbox_id: inbox,
    pod_id: "local",
    organization_id: "local",
    entry_type: "email",
  });
  expect((await api.request(`${path}/A.TEST`)).status).toBe(200);
  expect((await api.request(`${path}/A.TEST`, { method: "DELETE" })).status).toBe(200);
  await failure(await api.request(`${path}/a.test`), "not_found");
  await failure(await api.request(`${route()}?limit=0`), "validation_error");
  await failure(
    await api.request(route(), { method: "POST", body: { entry: "*.test" } }),
    "validation_error",
  );
  await api.run(api.mailbox.deleteInbox(inbox));
  expect(
    await api.run(
      api.store.use((db) =>
        db.prepare("SELECT entry FROM list_entries WHERE scope = ?").all(inbox),
      ),
    ),
  ).toEqual([]);
});

test("blocks win and global/inbox allow entries form an exact union per direction", async ({
  api,
}) => {
  const lists = makeLists(api.store);
  const verdict = (address: string, direction: Direction = "receive", id = inbox) =>
    api.run(api.store.use((db) => evaluate(db, id, direction, [address])));
  await api.run(lists.create(undefined, "receive", "allow", { entry: "trusted.test" }));
  await api.run(lists.create(inbox, "receive", "allow", { entry: "User@outside.test" }));
  expect(await verdict("Person <User@OUTSIDE.TEST>")).toBeUndefined();
  expect(await verdict("USER@outside.test")).toBeUndefined();
  expect(await verdict("alice@trusted.test")).toBeUndefined();
  expect(await verdict("alice@sub.trusted.test")).toBe("sender_not_allowed");
  expect(await verdict("User@outside.test", "receive", other)).toBe("sender_not_allowed");
  expect(await verdict("user@outside.test", "send")).toBeUndefined();
  await api.run(lists.create(undefined, "receive", "block", { entry: "outside.test" }));
  expect(await verdict("User@outside.test")).toBe("blocked_sender");
  await api.run(lists.create(inbox, "receive", "block", { entry: "alice@trusted.test" }));
  expect(await verdict("alice@trusted.test")).toBe("blocked_sender");
  expect(await verdict("Alice@Trusted.Test")).toBe("blocked_sender");
  expect(await verdict("other@trusted.test")).toBeUndefined();
  await api.run(lists.delete(undefined, "receive", "allow", "trusted.test"));
  await api.run(lists.delete(inbox, "receive", "allow", "User@outside.test"));
  expect(await verdict("any@new.test")).toBeUndefined();
});

test("list permissions and inbox scopes agree over REST and MCP under every send policy", async ({
  api,
}) => {
  for (const send_policy of ["direct", "approval", "read_only"] as const) {
    const key = await api.run(
      api.keys.create({
        inbox_id: inbox,
        permissions: { list_entry_read: true, list_entry_create: true, list_entry_delete: true },
        send_policy,
      }),
    );
    const path = route("send", "block", inbox);
    const mcp = await connect(api, key.api_key);
    const entry = `${send_policy.replaceAll("_", "-")}.test`;
    const created = await mcp.call("create_list_entry", {
      inboxId: inbox,
      direction: "send",
      type: "block",
      entry,
    });
    expect(created.isError).not.toBe(true);
    expect(Schema.decodeUnknownSync(PodListEntry)(created.structuredContent).entry).toBe(entry);
    expect((await api.request(`${path}/${entry}`, { token: key.api_key })).status).toBe(200);
    expect(
      (
        await mcp.call("get_list_entry", {
          inboxId: inbox,
          direction: "send",
          type: "block",
          entry,
        })
      ).structuredContent,
    ).toMatchObject({ entry });
    expect(
      (
        await mcp.call("list_list_entries", {
          inboxId: inbox,
          direction: "send",
          type: "block",
          limit: 1,
        })
      ).structuredContent,
    ).toMatchObject({ count: 1 });
    for (const method of ["GET", "POST", "DELETE"]) {
      const suffix = method === "DELETE" ? `/${entry}` : "";
      const options = {
        token: key.api_key,
        method,
        ...(method === "POST" ? { body: { entry } } : {}),
      };
      await failure(
        await api.request(route("send", "block", other) + suffix, options),
        "not_found",
      );
      await failure(
        await api.request(route("send", "block") + suffix, options),
        "missing_permission",
      );
    }
    expect(
      (await mcp.call("create_list_entry", { direction: "send", type: "block", entry }))
        .structuredContent,
    ).toMatchObject({ code: "missing_permission" });
    expect(
      (
        await mcp.call("delete_list_entry", {
          inboxId: inbox,
          direction: "send",
          type: "block",
          entry,
        })
      ).isError,
    ).not.toBe(true);
    await failure(await api.request(`${path}/${entry}`, { token: key.api_key }), "not_found");
  }
  const reader = await api.run(
    api.keys.create({
      inbox_ids: [inbox],
      permissions: { list_entry_read: true },
      send_policy: "direct",
    }),
  );
  await failure(
    await api.request(route("send", "block", inbox), {
      token: reader.api_key,
      method: "POST",
      body: { entry: "blocked.test" },
    }),
    "missing_permission",
  );
  await failure(
    await api.request(`${route("send", "block", inbox)}/blocked.test`, {
      token: reader.api_key,
      method: "DELETE",
    }),
    "missing_permission",
  );
  const unscoped = await api.run(
    api.keys.create({
      permissions: { list_entry_create: true, list_entry_read: true, list_entry_delete: true },
      send_policy: "direct",
    }),
  );
  expect(
    (
      await api.request(route(), {
        token: unscoped.api_key,
        method: "POST",
        body: { entry: "global.test" },
      })
    ).status,
  ).toBe(200);
  expect((await api.request(route(), { token: unscoped.api_key })).status).toBe(200);
  expect(
    (await api.request(`${route()}/global.test`, { token: unscoped.api_key, method: "DELETE" }))
      .status,
  ).toBe(200);
});

test("send, reply, forward and draft approval reject any forbidden recipient without queueing", async ({
  api,
}) => {
  await api.run(api.transport.set({ account_id: "fake", api_token: "fake" }));
  const lists = makeLists(api.store);
  await api.run(lists.create(undefined, "send", "block", { entry: "forbidden.test" }));
  const messages = `/v0/inboxes/${inbox}/messages`;
  for (const field of ["to", "cc", "bcc"])
    await failure(
      await api.request(`${messages}/send`, {
        method: "POST",
        body: {
          to: "safe@test.test",
          [field]: "Named <Bad@FORBIDDEN.TEST>",
          text: "Synthetic body",
        },
      }),
      "message_rejected",
    );
  await failure(
    await api.request(`${messages}/${encodeURIComponent("<first@example.test>")}/forward`, {
      method: "POST",
      body: { to: "bad@forbidden.test", text: "Synthetic forward" },
    }),
    "message_rejected",
  );
  await api.run(lists.create(inbox, "reply", "block", { entry: "alice@example.test" }));
  await failure(
    await api.request(`${messages}/${encodeURIComponent("<first@example.test>")}/reply`, {
      method: "POST",
      body: { text: "Synthetic reply" },
    }),
    "message_rejected",
  );
  const drafts = `/v0/inboxes/${inbox}/drafts`;
  for (const scheduled of [false, true]) {
    const draft = Schema.decodeUnknownSync(Draft)(
      await (
        await api.request(drafts, {
          method: "POST",
          body: {
            to: ["bad@forbidden.test"],
            text: "Synthetic draft",
            ...(scheduled ? { send_at: "2026-10-11T12:00:00Z" } : {}),
          },
        })
      ).json(),
    );
    for (const operation of ["send", "approve"])
      await failure(
        await api.request(`${drafts}/${draft.draft_id}/${operation}`, {
          method: "POST",
          ...(operation === "send" ? { body: {} } : {}),
        }),
        "message_rejected",
      );
    expect(await api.run(api.drafts.get(inbox, draft.draft_id))).toEqual(draft);
  }
  const replyDraft = await api.run(
    api.drafts.create(
      inbox,
      { in_reply_to: "<first@example.test>", text: "Synthetic reply draft" },
      "owner",
      false,
    ),
  );
  await failure(
    await api.request(`${drafts}/${replyDraft.draft_id}/approve`, { method: "POST" }),
    "message_rejected",
  );
  const agent = await api.run(
    api.keys.create({
      inbox_id: inbox,
      permissions: { message_send: true, draft_send: true },
      send_policy: "approval",
    }),
  );
  await failure(
    await api.request(`${messages}/send`, {
      token: agent.api_key,
      method: "POST",
      body: { to: "bad@forbidden.test", text: "Synthetic approval proposal" },
    }),
    "message_rejected",
  );
  const approvalDraft = await api.run(
    api.drafts.create(
      inbox,
      { to: ["bad@forbidden.test"], text: "Synthetic approval draft" },
      "owner",
      false,
    ),
  );
  await failure(
    await api.request(`${drafts}/${approvalDraft.draft_id}/send`, {
      token: agent.api_key,
      method: "POST",
      body: {},
    }),
    "message_rejected",
  );
  await api.run(lists.create(undefined, "send", "allow", { entry: "trusted.test" }));
  await failure(
    await api.request(`${messages}/send`, {
      method: "POST",
      body: { to: "outside@other.test", text: "Synthetic body" },
    }),
    "message_rejected",
  );
  expect(await api.run(api.store.use((db) => db.prepare("SELECT id FROM outbox").all()))).toEqual(
    [],
  );
  expect(
    await api.run(api.store.use((db) => db.prepare("SELECT * FROM outbound_idempotency").all())),
  ).toEqual([]);
  expect(api.sent).toEqual([]);
  const accepted = await api.request(`${messages}/send`, {
    method: "POST",
    body: { to: "safe@trusted.test", text: "Synthetic allowed body" },
  });
  expect(accepted.status).toBe(200);
});

test("new rules stop previously queued and scheduled mail before the fake provider sees it", async ({
  api,
}) => {
  await api.run(api.transport.set({ account_id: "fake", api_token: "fake" }));
  const queued = await api.run(
    api.outbox.enqueue(
      inbox,
      {
        kind: "send",
        request: { to: "Alice <alice@example.test>", text: "Synthetic queued body" },
      },
      "queued-rule",
    ),
  );
  const scheduled = await api.run(
    api.drafts.create(
      inbox,
      {
        to: ["alice@example.test"],
        text: "Synthetic scheduled body",
        send_at: "2026-10-11T12:00:00Z",
      },
      "owner",
      false,
    ),
  );
  await api.run(makeLists(api.store).create(inbox, "send", "block", { entry: "example.test" }));
  await api.run(api.outbox.processDue());
  expect(await api.run(api.outbox.get(inbox, queued.message_id))).toMatchObject({
    state: "failed",
    last_error_code: "message_rejected",
    attempts: 0,
  });
  expect((await api.run(api.mailbox.getMessage(inbox, queued.message_id))).labels).toEqual(
    expect.arrayContaining(["failed", "rejected"]),
  );
  const replay = await api.run(
    api.outbox.enqueue(
      inbox,
      {
        kind: "send",
        request: { to: "Alice <alice@example.test>", text: "Synthetic queued body" },
      },
      "queued-rule",
    ),
  );
  expect(Schema.decodeUnknownSync(SendMessageResponse)(replay)).toEqual(queued);
  api.advance(24 * 60 * 60 * 1000);
  await api.run(api.drafts.processDue());
  expect(await api.run(api.drafts.get(inbox, scheduled.draft_id))).toMatchObject({
    send_status: "failed",
  });
  expect(api.sent).toEqual([]);
  await api.run(api.outbox.processDue());
  const failures = await api.run(api.store.use((db) => readEvents(db, 0)));
  expect(
    failures.filter((row) => row.payload.event_type === "message.failed").map((row) => row.payload),
  ).toEqual([
    {
      type: "event",
      event_type: "message.failed",
      event_id: expect.any(String),
      failure: {
        inbox_id: inbox,
        message_id: queued.message_id,
        thread_id: queued.thread_id,
        timestamp: "2026-10-10T12:00:00.000Z",
        reason: "message_rejected",
      },
    },
  ]);
});

test("global and inbox list wire responses agree between REST and MCP", async ({ api }) => {
  const key = await api.run(
    api.keys.create({
      permissions: { list_entry_read: true, list_entry_create: true },
      send_policy: "direct",
    }),
  );
  const mcp = await connect(api, key.api_key);
  for (const inboxId of [undefined, inbox]) {
    const args = {
      ...(inboxId ? { inboxId } : {}),
      direction: "send",
      type: "allow",
      entry: "same.test",
    };
    const created = await mcp.call("create_list_entry", args);
    const path = route("send", "allow", inboxId);
    const rest = await (await api.request(`${path}/same.test`)).json();
    expect(created.structuredContent).toEqual(rest);
    expect((await mcp.call("get_list_entry", args)).structuredContent).toEqual(rest);
    expect(
      (
        await mcp.call("list_list_entries", {
          ...(inboxId ? { inboxId } : {}),
          direction: "send",
          type: "allow",
          limit: 20,
        })
      ).structuredContent,
    ).toEqual(await (await api.request(`${path}?limit=20`)).json());
  }
});
