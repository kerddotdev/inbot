import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { Clock, Effect, Layer, Schema } from "effect";
import { expect, test as baseTest } from "vitest";
import { ErrorResponse, ErrorStatus } from "../../../../packages/contracts/src/errors.js";
import {
  Message,
  ListMessagesResponse,
  SearchMessagesResponse,
} from "../../../../packages/contracts/src/messages.js";
import {
  ListThreadsResponse,
  SearchThreadsResponse,
  Thread,
} from "../../../../packages/contracts/src/threads.js";
import { Home } from "../home.js";
import { DatabaseError, Store, migrate, migrations, type StoreService } from "../store.js";
import { Mailbox, type MailboxService } from "./mailbox.js";
import type { InsertMessage } from "./types.js";
import { createInbox } from "./inboxes.js";

const test = baseTest.extend<{ home: string; key: Uint8Array }>({
  home: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-mailbox-test-"));
    try {
      await use(home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  key: async ({ home: _home }, use) => {
    const key = randomBytes(32);
    try {
      await use(key);
    } finally {
      key.fill(0);
    }
  },
});

const now = Date.parse("2026-10-10T12:00:00Z");
const clock: Clock.Clock = {
  currentTimeMillisUnsafe: () => now,
  currentTimeMillis: Effect.succeed(now),
  currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
  currentTimeNanos: Effect.succeed(BigInt(now) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => 0n,
  monotonicTimeNanos: Effect.succeed(0n),
  sleep: () => Effect.succeed(undefined),
};

function withMailbox<A, E>(
  home: string,
  key: Uint8Array,
  use: (mailbox: MailboxService, store: StoreService) => Effect.Effect<A, E>,
) {
  const store = Store.layer(key).pipe(
    Layer.provide(Home.layer({ flag: home, flavor: "development" })),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* Mailbox, yield* Store);
    }).pipe(
      Effect.provide(Mailbox.Live.pipe(Layer.provideMerge(store))),
      Effect.provideService(Clock.Clock, clock),
    ),
  );
}

function message(
  inboxId: string,
  id: string,
  overrides: Partial<InsertMessage> = {},
): InsertMessage {
  return {
    inbox_id: inboxId,
    message_id: `<${id}@example.test>`,
    direction: "received",
    from: "Alice <alice@example.test>",
    to: [inboxId],
    subject: "Project update",
    text: "Synthetic searchable project message",
    labels: ["received", "unread"],
    timestamp: "2026-10-10T10:00:00Z",
    raw: Buffer.from(`Message-ID: <${id}@example.test>\r\n\r\nSynthetic raw message`),
    ...overrides,
  };
}

function requireToken(token: string | undefined) {
  if (token === undefined) throw new Error("Expected another page");
  return token;
}

test("creates inboxes, replays client ids, merges metadata, and validates changes", async ({
  home,
  key,
}) => {
  await withMailbox(home, key, (mailbox) =>
    Effect.gen(function* () {
      const inbox = yield* mailbox.createInbox({
        username: "Agent",
        domain: "EXAMPLE.TEST",
        client_id: "client-1",
        metadata: { keep: true, remove: "value" },
      });
      expect(inbox.inbox_id).toBe("agent@example.test");
      expect(inbox.email).toBe(inbox.inbox_id);
      expect(inbox.pod_id).toBe("local");
      expect(
        yield* mailbox.createInbox({
          username: "different",
          domain: "other.test",
          client_id: "client-1",
        }),
      ).toEqual(inbox);
      const generated = yield* mailbox.createInbox({ domain: "example.test" });
      expect(generated.inbox_id).toMatch(/^[a-f0-9]{16}@example\.test$/);
      const updated = yield* mailbox.updateInbox(inbox.inbox_id, {
        display_name: "Agent One",
        status: "paused",
        metadata: { remove: null, added: 3 },
      });
      expect(updated).toMatchObject({
        display_name: "Agent One",
        status: "paused",
        metadata: { keep: true, added: 3 },
      });
      expect(
        (yield* mailbox.updateInbox(inbox.inbox_id, { metadata: null, status: "active" })).metadata,
      ).toEqual({});
      expect(
        (yield* Effect.flip(mailbox.createInbox({ username: "agent", domain: "example.test" })))
          .code,
      ).toBe("already_exists");
      for (const username of [
        "",
        ".agent",
        "agent.",
        "two..dots",
        "a@b",
        "with space",
        "a".repeat(65),
      ]) {
        expect(
          (yield* Effect.flip(mailbox.createInbox({ username, domain: "example.test" }))).code,
        ).toBe("validation_error");
      }
      for (const domain of ["", "bad domain", "-bad.test", "bad..test", "a".repeat(64) + ".test"]) {
        expect((yield* Effect.flip(mailbox.createInbox({ domain }))).code).toBe("validation_error");
      }
      expect(
        (yield* Effect.flip(mailbox.createInbox({ domain: "example.test", client_id: "bad@id" })))
          .code,
      ).toBe("validation_error");
      const tooMany = Object.fromEntries(
        Array.from({ length: 257 }, (_, index) => [String(index), true]),
      );
      expect(
        (yield* Effect.flip(mailbox.updateInbox(inbox.inbox_id, { metadata: tooMany }))).code,
      ).toBe("validation_error");
      expect((yield* mailbox.getInbox(inbox.inbox_id)).metadata).toEqual({});
    }),
  );
});

test("keeps duplicate deliveries separate by inbox and cascades all inbox data", async ({
  home,
  key,
}) => {
  await withMailbox(home, key, (mailbox, store) =>
    Effect.gen(function* () {
      const first = (yield* mailbox.createInbox({ username: "first", domain: "example.test" }))
        .inbox_id;
      const second = (yield* mailbox.createInbox({ username: "second", domain: "example.test" }))
        .inbox_id;
      const input = message(first, "same", {
        aliases: ["provider-id"],
        attachments: [
          {
            attachment_id: "attachment-1",
            filename: "report.txt",
            content: Buffer.from("synthetic attachment"),
          },
        ],
      });
      const a = yield* mailbox.insertMessage(input);
      const b = yield* mailbox.insertMessage({ ...input, inbox_id: second, to: [second] });
      expect(a.message_id).toBe(b.message_id);
      expect(a.thread_id).not.toBe(b.thread_id);
      yield* mailbox.deleteInbox(first);
      expect((yield* Effect.flip(mailbox.getMessage(first, a.message_id))).code).toBe("not_found");
      expect((yield* mailbox.getMessage(second, b.message_id)).inbox_id).toBe(second);
      expect((yield* mailbox.searchMessages(second, "synthetic")).count).toBe(1);
      yield* store.use((db) => {
        for (const table of [
          "threads",
          "messages",
          "raw_messages",
          "message_labels",
          "attachments",
          "message_aliases",
        ]) {
          expect(db.prepare(`SELECT 1 FROM ${table} WHERE inbox_id = ?`).all(first)).toEqual([]);
        }
        expect(db.prepare("SELECT count(*) AS count FROM message_search").get()).toEqual({
          count: 1,
        });
      });
      yield* mailbox.deleteInbox(second);
      yield* store.use((db) =>
        expect(db.prepare("SELECT count(*) AS count FROM message_search").get()).toEqual({
          count: 0,
        }),
      );
    }),
  );
});

test("ingests idempotently and retains parsed fields, raw bytes, and attachments", async ({
  home,
  key,
}) => {
  await withMailbox(home, key, (mailbox) =>
    Effect.gen(function* () {
      const inboxId = (yield* mailbox.createInbox({ domain: "example.test" })).inbox_id;
      const input = message(inboxId, "parsed", {
        reply_to: ["reply@example.test"],
        cc: ["cc@example.test"],
        bcc: ["bcc@example.test"],
        html: "<p>Body</p>",
        extracted_text: "  Extracted\n\t   body  ",
        extracted_html: "<p>Extracted body</p>",
        headers: { "X-Test": "value" },
        calendar_event_id: "event-1",
        references: ["<missing@example.test>"],
        aliases: ["provider-1"],
        attachments: [
          {
            filename: "file.bin",
            content_type: "application/octet-stream",
            content_disposition: "attachment",
            content_id: "cid-1",
            content: Buffer.from([0, 1, 255]),
          },
        ],
      });
      const inserted = yield* mailbox.insertMessage(input);
      expect(inserted.thread_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(
        yield* mailbox.insertMessage({
          ...input,
          text: "different",
          raw: Buffer.from("different"),
          labels: ["trash"],
        }),
      ).toEqual(inserted);
      const stored = yield* mailbox.getMessage(inboxId, inserted.message_id);
      expect(Schema.decodeUnknownSync(Message)(stored)).toEqual(stored);
      expect(stored).toMatchObject({
        text: input.text,
        html: input.html,
        reply_to: input.reply_to,
        cc: input.cc,
        bcc: input.bcc,
        preview: "Extracted body",
        extracted_text: input.extracted_text,
        extracted_html: input.extracted_html,
        headers: input.headers,
        references: input.references,
        calendar_event_id: "event-1",
        size: input.raw.byteLength,
      });
      expect(yield* mailbox.getRawMessage(inboxId, inserted.message_id)).toEqual(input.raw);
      const attachment = stored.attachments?.[0];
      if (!attachment) throw new Error("Expected an attachment");
      const downloaded = yield* mailbox.getAttachment(
        inboxId,
        inserted.message_id,
        attachment.attachment_id,
      );
      expect(downloaded.attachment).toEqual(attachment);
      expect(downloaded.content).toEqual(Buffer.from([0, 1, 255]));
      expect(
        yield* mailbox.getThreadAttachment(inboxId, inserted.thread_id, attachment.attachment_id),
      ).toEqual(downloaded);
      expect((yield* mailbox.getThread(inboxId, inserted.thread_id)).message_count).toBe(1);
      const other = yield* mailbox.insertMessage(message(inboxId, "other"));
      expect(
        (yield* Effect.flip(
          mailbox.getAttachment(inboxId, other.message_id, attachment.attachment_id),
        )).code,
      ).toBe("not_found");
      expect(
        (yield* Effect.flip(
          mailbox.getThreadAttachment(inboxId, other.thread_id, attachment.attachment_id),
        )).code,
      ).toBe("not_found");
    }),
  );
});

test("threads by reply ids, newest matching references, and aliases without subject merging", async ({
  home,
  key,
}) => {
  await withMailbox(home, key, (mailbox) =>
    Effect.gen(function* () {
      const inboxId = (yield* mailbox.createInbox({ username: "one", domain: "example.test" }))
        .inbox_id;
      const otherId = (yield* mailbox.createInbox({ username: "two", domain: "example.test" }))
        .inbox_id;
      const first = yield* mailbox.insertMessage(
        message(inboxId, "first", { aliases: ["provider-first"] }),
      );
      const second = yield* mailbox.insertMessage(
        message(inboxId, "second", { aliases: ["provider-second"] }),
      );
      expect(first.thread_id).not.toBe(second.thread_id);
      const reply = yield* mailbox.insertMessage(
        message(inboxId, "reply", {
          in_reply_to: first.message_id,
          references: [second.message_id],
          subject: "Re: Different title",
        }),
      );
      expect(reply.thread_id).toBe(first.thread_id);
      const references = yield* mailbox.insertMessage(
        message(inboxId, "references", {
          in_reply_to: "<missing@example.test>",
          references: [first.message_id, second.message_id, "<missing@example.test>"],
        }),
      );
      expect(references.thread_id).toBe(second.thread_id);
      expect(
        (yield* mailbox.insertMessage(message(inboxId, "alias", { in_reply_to: "provider-first" })))
          .thread_id,
      ).toBe(first.thread_id);
      expect(
        (yield* mailbox.insertMessage(
          message(inboxId, "reference-alias", { references: ["provider-second"] }),
        )).thread_id,
      ).toBe(second.thread_id);
      const isolated = yield* mailbox.insertMessage(
        message(otherId, "first", {
          in_reply_to: second.message_id,
          references: ["provider-second"],
        }),
      );
      expect(isolated.thread_id).not.toBe(second.thread_id);
      expect(
        (yield* mailbox.insertMessage(
          message(otherId, "local-reply", { in_reply_to: first.message_id }),
        )).thread_id,
      ).toBe(isolated.thread_id);
    }),
  );
});

test("recomputes thread aggregates after out-of-order ingestion and permanent deletion", async ({
  home,
  key,
}) => {
  await withMailbox(home, key, (mailbox) =>
    Effect.gen(function* () {
      const inboxId = (yield* mailbox.createInbox({ domain: "example.test" })).inbox_id;
      const first = yield* mailbox.insertMessage(
        message(inboxId, "first", {
          subject: "Re: Fwd:  Original  subject",
          timestamp: "2026-10-10T09:00:00Z",
          size: 10,
          labels: ["received", "unread"],
          attachments: [{ attachment_id: "a", content: Buffer.from("a") }],
        }),
      );
      const latest = yield* mailbox.insertMessage(
        message(inboxId, "latest", {
          in_reply_to: first.message_id,
          direction: "sent",
          from: inboxId,
          to: ["bob@example.test"],
          cc: ["cc@example.test"],
          bcc: ["bcc@example.test"],
          timestamp: "2026-10-10T11:00:00Z",
          extracted_text: " Latest   reply ",
          size: 20,
          labels: ["sent"],
        }),
      );
      const middle = yield* mailbox.insertMessage(
        message(inboxId, "middle", {
          in_reply_to: first.message_id,
          timestamp: "2026-10-10T10:00:00Z",
          size: 30,
          attachments: [{ attachment_id: "b", content: Buffer.from("bb") }],
        }),
      );
      const thread = yield* mailbox.getThread(inboxId, first.thread_id);
      expect(thread).toMatchObject({
        subject: "Original subject",
        timestamp: "2026-10-10T11:00:00Z",
        received_timestamp: "2026-10-10T10:00:00Z",
        sent_timestamp: "2026-10-10T11:00:00Z",
        last_message_id: latest.message_id,
        preview: "Latest reply",
        message_count: 3,
        size: 60,
      });
      expect(thread.senders).toEqual(["Alice <alice@example.test>", inboxId]);
      expect(thread.recipients).toEqual([
        inboxId,
        "bob@example.test",
        "cc@example.test",
        "bcc@example.test",
      ]);
      expect(thread.attachments?.map((a) => a.attachment_id)).toEqual(["a", "b"]);
      expect(thread.labels).toEqual(["received", "sent", "unread"]);
      yield* mailbox.deleteMessage(inboxId, latest.message_id);
      const reduced = yield* mailbox.getThread(inboxId, first.thread_id);
      expect(reduced).toMatchObject({
        message_count: 2,
        size: 40,
        last_message_id: middle.message_id,
        timestamp: "2026-10-10T10:00:00Z",
      });
      expect(reduced.sent_timestamp).toBeUndefined();
      expect(reduced.senders).toEqual(["Alice <alice@example.test>"]);
      expect(reduced.recipients).toEqual([inboxId]);
      yield* mailbox.deleteMessage(inboxId, first.message_id);
      expect(
        (yield* mailbox.getThread(inboxId, first.thread_id)).attachments?.map(
          (a) => a.attachment_id,
        ),
      ).toEqual(["b"]);
      yield* mailbox.deleteMessage(inboxId, middle.message_id);
      expect((yield* Effect.flip(mailbox.getThread(inboxId, first.thread_id))).code).toBe(
        "not_found",
      );
      expect((yield* mailbox.listThreads({ inbox_id: inboxId })).count).toBe(0);
      expect((yield* mailbox.searchMessages(inboxId, "project")).count).toBe(0);
    }),
  );
});

test("updates message and thread labels as a union and omits missing batch ids", async ({
  home,
  key,
}) => {
  await withMailbox(home, key, (mailbox) =>
    Effect.gen(function* () {
      const inboxId = (yield* mailbox.createInbox({ domain: "example.test" })).inbox_id;
      const first = yield* mailbox.insertMessage(message(inboxId, "first"));
      const second = yield* mailbox.insertMessage(
        message(inboxId, "second", {
          in_reply_to: first.message_id,
          labels: ["received", "other"],
        }),
      );
      expect(
        (yield* mailbox.updateMessage(inboxId, first.message_id, {
          add_labels: ["read", "read"],
          remove_labels: "unread",
        })).labels,
      ).toEqual(["read", "received"]);
      expect((yield* mailbox.getThread(inboxId, first.thread_id)).labels).toEqual([
        "other",
        "read",
        "received",
      ]);
      expect(
        (yield* mailbox.listThreads({ inbox_id: inboxId }, { labels: ["other", "read"] })).count,
      ).toBe(1);
      expect((yield* mailbox.listMessages(inboxId, { labels: ["other", "read"] })).count).toBe(0);
      const updated = yield* mailbox.updateThread(inboxId, first.thread_id, {
        add_labels: ["archive"],
        remove_labels: ["received", "other"],
      });
      expect(updated.labels).toEqual(["archive", "read"]);
      expect((yield* mailbox.getMessage(inboxId, second.message_id)).labels).toEqual(["archive"]);
      const batch = yield* mailbox.batchGetMessages(inboxId, {
        message_ids: [second.message_id, "<missing@example.test>", first.message_id],
      });
      expect(batch.count).toBe(2);
      expect(batch.limit).toBe(3);
      expect(batch.messages.map((m) => m.message_id)).toEqual([
        second.message_id,
        first.message_id,
      ]);
      expect(batch.messages[0]?.text).toBe("Synthetic searchable project message");
      const changes = yield* mailbox.batchUpdateMessages(inboxId, {
        message_ids: [first.message_id, "<missing@example.test>", second.message_id],
        add_labels: "done",
        remove_labels: "archive",
      });
      expect(changes).toMatchObject({ count: 2, limit: 3 });
      expect((yield* mailbox.getThread(inboxId, first.thread_id)).labels).toEqual(["done", "read"]);
      expect(
        (yield* Effect.flip(
          mailbox.batchUpdateMessages(inboxId, { message_ids: [first.message_id] }),
        )).code,
      ).toBe("validation_error");
      expect(
        (yield* Effect.flip(
          mailbox.batchGetMessages(inboxId, { message_ids: [first.message_id, first.message_id] }),
        )).code,
      ).toBe("validation_error");
    }),
  );
});

for (const label of ["spam", "blocked", "unauthenticated", "trash"] as const) {
  test(`excludes ${label} messages and threads unless explicitly included`, async ({
    home,
    key,
  }) => {
    await withMailbox(home, key, (mailbox) =>
      Effect.gen(function* () {
        const inboxId = (yield* mailbox.createInbox({ domain: "example.test" })).inbox_id;
        const hidden = yield* mailbox.insertMessage(
          message(inboxId, "hidden", { labels: [label] }),
        );
        yield* mailbox.insertMessage(
          message(inboxId, "visible-reply", {
            in_reply_to: hidden.message_id,
            labels: ["received"],
          }),
        );
        expect((yield* mailbox.listMessages(inboxId)).count).toBe(1);
        expect((yield* mailbox.listThreads({ inbox_id: inboxId })).count).toBe(0);
        const query = { [`include_${label}`]: true };
        expect((yield* mailbox.listMessages(inboxId, query)).count).toBe(2);
        expect((yield* mailbox.listThreads({ inbox_id: inboxId }, query)).count).toBe(1);
        expect((yield* mailbox.listMessages(inboxId, { labels: [label] })).count).toBe(0);
        expect((yield* mailbox.searchMessages(inboxId, "project")).count).toBe(1);
        expect((yield* mailbox.searchThreads({ inbox_id: inboxId }, "project")).count).toBe(0);
        yield* mailbox.updateThread(inboxId, hidden.thread_id, { remove_labels: [label] });
        expect((yield* mailbox.listThreads({ inbox_id: inboxId })).count).toBe(1);
        expect((yield* mailbox.searchMessages(inboxId, "project")).count).toBe(2);
      }),
    );
  });
}

test("paginates messages, threads, and inboxes in both directions without gaps or duplicates", async ({
  home,
  key,
}) => {
  await withMailbox(home, key, (mailbox) =>
    Effect.gen(function* () {
      const inboxId = (yield* mailbox.createInbox({ username: "agent-0", domain: "example.test" }))
        .inbox_id;
      const timestamps = [
        "2026-10-10T09:00:00Z",
        "2026-10-10T11:00:00+02:00",
        "2026-10-10T09:00:00.0001Z",
        "2026-10-10T09:00:00.1Z",
        "2026-10-10T09:00:00.11Z",
        "2026-10-10T10:00:00Z",
        "2026-10-10T09:30:00Z",
      ];
      for (const [index, timestamp] of timestamps.entries()) {
        yield* mailbox.insertMessage(message(inboxId, String(index), { timestamp }));
        if (index > 0)
          yield* mailbox.createInbox({ username: `agent-${index}`, domain: "example.test" });
      }
      for (const ascending of [false, true]) {
        const ids: string[] = [];
        const threadIds: string[] = [];
        const inboxIds: string[] = [];
        let messageToken: string | undefined;
        let threadToken: string | undefined;
        let inboxToken: string | undefined;
        for (let index = 0; index < 4; index++) {
          const messages = yield* mailbox.listMessages(inboxId, {
            limit: 2,
            ascending,
            ...(messageToken ? { page_token: messageToken } : {}),
          });
          const threads = yield* mailbox.listThreads(
            { inbox_id: inboxId },
            { limit: 2, ascending, ...(threadToken ? { page_token: threadToken } : {}) },
          );
          const inboxes = yield* mailbox.listInboxes({
            limit: 2,
            ascending,
            ...(inboxToken ? { page_token: inboxToken } : {}),
          });
          expect(Schema.decodeUnknownSync(ListMessagesResponse)(messages)).toEqual(messages);
          expect(Schema.decodeUnknownSync(ListThreadsResponse)(threads)).toEqual(threads);
          ids.push(...messages.messages.map((m) => m.message_id));
          threadIds.push(...threads.threads.map((t) => t.thread_id));
          inboxIds.push(...inboxes.inboxes.map((i) => i.inbox_id));
          expect(messages.messages.every((m) => !("text" in m) && !("html" in m))).toBe(true);
          messageToken = messages.next_page_token;
          threadToken = threads.next_page_token;
          inboxToken = inboxes.next_page_token;
          if (index < 3) {
            expect(messageToken).toBeDefined();
            expect(threadToken).toBeDefined();
            expect(inboxToken).toBeDefined();
          }
        }
        const expected = [0, 1, 2, 3, 4, 6, 5].map((id) => `<${id}@example.test>`);
        expect(ids).toEqual(ascending ? expected : expected.toReversed());
        expect(new Set(threadIds).size).toBe(7);
        expect(threadIds).toEqual(
          (yield* mailbox.listThreads({ inbox_id: inboxId }, { ascending })).threads.map(
            (t) => t.thread_id,
          ),
        );
        const expectedInboxes = Array.from(
          { length: 7 },
          (_, index) => `agent-${index}@example.test`,
        );
        expect(inboxIds).toEqual(ascending ? expectedInboxes : expectedInboxes.toReversed());
        expect(messageToken).toBeUndefined();
        expect(threadToken).toBeUndefined();
        expect(inboxToken).toBeUndefined();
      }
      expect((yield* mailbox.listMessages(inboxId)).limit).toBe(20);
      for (const limit of [0, -1, 101, 1.5]) {
        expect((yield* Effect.flip(mailbox.listMessages(inboxId, { limit }))).code).toBe(
          "validation_error",
        );
      }
    }),
  );
});

test("binds page tokens to filters, ordering, resource, and inbox scope", async ({ home, key }) => {
  await withMailbox(home, key, (mailbox) =>
    Effect.gen(function* () {
      const inboxId = (yield* mailbox.createInbox({ domain: "example.test" })).inbox_id;
      const otherId = (yield* mailbox.createInbox({ domain: "example.test" })).inbox_id;
      for (let index = 0; index < 5; index++)
        yield* mailbox.insertMessage(message(inboxId, String(index)));
      const first = yield* mailbox.listMessages(inboxId, {
        limit: 2,
        labels: ["unread", "received"],
      });
      const token = requireToken(first.next_page_token);
      const second = yield* mailbox.listMessages(inboxId, {
        limit: 3,
        page_token: token,
        labels: ["received", "unread", "unread"],
        ascending: false,
        include_spam: false,
      });
      expect(second.count).toBe(3);
      expect(new Set([...first.messages, ...second.messages].map((m) => m.message_id)).size).toBe(
        5,
      );
      for (const query of [
        { labels: ["unread"] },
        { labels: ["unread", "received"], ascending: true },
        { labels: ["unread", "received"], include_spam: true },
        { labels: ["unread", "received"], subject: ["Project"] },
      ]) {
        expect(
          (yield* Effect.flip(mailbox.listMessages(inboxId, { ...query, page_token: token }))).code,
        ).toBe("page_token_stale");
      }
      expect(
        (yield* Effect.flip(
          mailbox.listMessages(otherId, { labels: ["unread", "received"], page_token: token }),
        )).code,
      ).toBe("page_token_stale");
      expect(
        (yield* Effect.flip(mailbox.listThreads({ inbox_id: inboxId }, { page_token: token })))
          .code,
      ).toBe("page_token_stale");
      for (const malformed of [
        "",
        "%%%",
        "a",
        Buffer.from("not json").toString("base64url"),
        Buffer.from('{"version":2}').toString("base64url"),
      ]) {
        const failure = yield* Effect.flip(
          mailbox.listMessages(inboxId, { page_token: malformed }),
        );
        expect(failure.code).toBe("page_token_stale");
        expect(ErrorStatus[Schema.decodeUnknownSync(ErrorResponse)(failure).code]).toBe(409);
      }
      const orgPage = yield* mailbox.listThreads({ inbox_ids: [inboxId] }, { limit: 1 });
      expect(
        (yield* Effect.flip(
          mailbox.listThreads({}, { page_token: requireToken(orgPage.next_page_token) }),
        )).code,
      ).toBe("page_token_stale");
    }),
  );
});

test("applies all substring filters and strict before and after bounds", async ({ home, key }) => {
  await withMailbox(home, key, (mailbox) =>
    Effect.gen(function* () {
      const inboxId = (yield* mailbox.createInbox({ domain: "example.test" })).inbox_id;
      const matching = yield* mailbox.insertMessage(
        message(inboxId, "matching", {
          from: "Alice Smith <alice@example.test>",
          to: ["direct@example.test"],
          cc: ["Carbon@example.test"],
          bcc: ["Blind@example.test"],
          subject: "Quarterly Budget_100% review",
          timestamp: "2026-10-10T10:00:00Z",
          labels: ["received", "unread"],
        }),
      );
      yield* mailbox.insertMessage(
        message(inboxId, "other", {
          from: "Bob <bob@example.test>",
          labels: ["received"],
          timestamp: "2026-10-10T09:00:00Z",
        }),
      );
      const query = {
        from: ["ALICE", "Smith"],
        to: ["Carbon", "BLIND"],
        subject: ["budget_100%", "review"],
        labels: ["unread", "received"],
        after: "2026-10-10T11:30:00+02:00",
        before: "2026-10-10T10:30:00Z",
      };
      expect(
        (yield* mailbox.listMessages(inboxId, query)).messages.map((m) => m.message_id),
      ).toEqual([matching.message_id]);
      expect(
        (yield* mailbox.listThreads(
          { inbox_id: inboxId },
          {
            senders: query.from,
            recipients: query.to,
            subject: query.subject,
            labels: query.labels,
            after: query.after,
            before: query.before,
          },
        )).threads.map((t) => t.thread_id),
      ).toEqual([matching.thread_id]);
      expect((yield* mailbox.listMessages(inboxId, { before: "2026-10-10T10:00:00Z" })).count).toBe(
        1,
      );
      expect((yield* mailbox.listMessages(inboxId, { after: "2026-10-10T10:00:00Z" })).count).toBe(
        0,
      );
      expect((yield* mailbox.listMessages(inboxId, { from: ["Alice", "Bob"] })).count).toBe(0);
      expect((yield* mailbox.listMessages(inboxId, { to: ["missing"] })).count).toBe(0);
      expect(
        (yield* mailbox.listThreads({ inbox_id: inboxId }, { senders: ["Alice", "Bob"] })).count,
      ).toBe(0);
    }),
  );
});

test("returns the newest thread page in chronological order and pages toward older messages", async ({
  home,
  key,
}) => {
  await withMailbox(home, key, (mailbox) =>
    Effect.gen(function* () {
      const inboxId = (yield* mailbox.createInbox({ domain: "example.test" })).inbox_id;
      const parent = yield* mailbox.insertMessage(
        message(inboxId, "0", { timestamp: "2026-10-10T08:00:00Z" }),
      );
      for (let index = 1; index <= 4; index++) {
        yield* mailbox.insertMessage(
          message(inboxId, String(index), {
            in_reply_to: parent.message_id,
            timestamp: `2026-10-10T${String(8 + index).padStart(2, "0")}:00:00Z`,
          }),
        );
      }
      const first = yield* mailbox.getThread(inboxId, parent.thread_id, { limit: 2 });
      expect(Schema.decodeUnknownSync(Thread)(first)).toEqual(first);
      expect(first.messages.map((m) => m.message_id)).toEqual([
        "<3@example.test>",
        "<4@example.test>",
      ]);
      expect(first).toMatchObject({ count: 2, message_count: 5, limit: 2 });
      const second = yield* mailbox.getThread(inboxId, parent.thread_id, {
        limit: 2,
        page_token: requireToken(first.next_page_token),
      });
      expect(second.messages.map((m) => m.message_id)).toEqual([
        "<1@example.test>",
        "<2@example.test>",
      ]);
      const third = yield* mailbox.getThread(inboxId, parent.thread_id, {
        limit: 2,
        page_token: requireToken(second.next_page_token),
      });
      expect(third.messages.map((m) => m.message_id)).toEqual([parent.message_id]);
      expect(third.next_page_token).toBeUndefined();
    }),
  );
});

test("restricts org-wide lists and searches to the intersection of inbox scopes", async ({
  home,
  key,
}) => {
  await withMailbox(home, key, (mailbox) =>
    Effect.gen(function* () {
      const first = (yield* mailbox.createInbox({ username: "first", domain: "example.test" }))
        .inbox_id;
      const second = (yield* mailbox.createInbox({ username: "second", domain: "example.test" }))
        .inbox_id;
      yield* mailbox.insertMessage(message(first, "same"));
      yield* mailbox.insertMessage(message(second, "same"));
      expect((yield* mailbox.listThreads()).count).toBe(2);
      expect((yield* mailbox.searchThreads({}, "project")).count).toBe(2);
      for (const scope of [
        { inbox_ids: [first] },
        { inbox_id: first, inbox_ids: [first, second] },
      ]) {
        expect((yield* mailbox.listThreads(scope)).threads.map((t) => t.inbox_id)).toEqual([first]);
        expect(
          (yield* mailbox.searchThreads(scope, "project")).threads.map((t) => t.inbox_id),
        ).toEqual([first]);
      }
      for (const scope of [{ inbox_ids: [] }, { inbox_id: second, inbox_ids: [first] }]) {
        expect((yield* mailbox.listThreads(scope)).count).toBe(0);
        expect((yield* mailbox.searchThreads(scope, "project")).count).toBe(0);
      }
    }),
  );
});

test("ranks full-text results, highlights matches, and paginates exact BM25 scores", async ({
  home,
  key,
}) => {
  await withMailbox(home, key, (mailbox) =>
    Effect.gen(function* () {
      const inboxId = (yield* mailbox.createInbox({ domain: "example.test" })).inbox_id;
      const strongest = yield* mailbox.insertMessage(
        message(inboxId, "strongest", {
          subject: "Quartz report",
          extracted_text: "quartz ".repeat(30),
        }),
      );
      for (let index = 0; index < 4; index++)
        yield* mailbox.insertMessage(
          message(inboxId, `weak-${index}`, {
            subject: "Long report",
            text: `quartz ${"ordinary ".repeat(100 + index * 13)}`,
          }),
        );
      const whole = yield* mailbox.searchMessages(inboxId, "quartz");
      expect(Schema.decodeUnknownSync(SearchMessagesResponse)(whole)).toEqual(whole);
      expect(whole.messages[0]?.message_id).toBe(strongest.message_id);
      expect(whole.messages[0]?.highlights?.subject?.[0]).toContain("**Quartz**");
      expect(whole.messages[0]?.highlights?.text?.[0]).toContain("**quartz**");
      const ids: string[] = [];
      let token: string | undefined;
      for (let index = 0; index < 5; index++) {
        const page = yield* mailbox.searchMessages(inboxId, "quartz", {
          limit: 1,
          ...(token ? { page_token: token } : {}),
        });
        ids.push(...page.messages.map((m) => m.message_id));
        token = page.next_page_token;
        if (index < 4) expect(token).toBeDefined();
      }
      expect(ids).toEqual(whole.messages.map((m) => m.message_id));
      expect(new Set(ids).size).toBe(5);
      expect(token).toBeUndefined();
      const threads = yield* mailbox.searchThreads({ inbox_id: inboxId }, "quartz");
      expect(Schema.decodeUnknownSync(SearchThreadsResponse)(threads)).toEqual(threads);
      expect(threads.threads[0]?.thread_id).toBe(strongest.thread_id);
      expect(threads.threads[0]?.highlights?.text?.[0]).toContain("**quartz**");
      const threadIds: string[] = [];
      token = undefined;
      for (let index = 0; index < 5; index++) {
        const page: SearchThreadsResponse = yield* mailbox.searchThreads({}, "quartz", {
          limit: 1,
          ...(token ? { page_token: token } : {}),
        });
        threadIds.push(...page.threads.map((t) => t.thread_id));
        token = page.next_page_token;
      }
      expect(threadIds).toEqual(threads.threads.map((t) => t.thread_id));
      expect(token).toBeUndefined();
      expect(
        (yield* mailbox.searchMessages(inboxId, "alice")).messages[0]?.highlights?.from?.[0],
      ).toContain("**Alice**");
      const recipient = yield* mailbox.insertMessage(
        message(inboxId, "recipient", { cc: ["Carbon@example.test"], bcc: ["Blind@example.test"] }),
      );
      expect((yield* mailbox.searchMessages(inboxId, "blind")).messages[0]).toMatchObject({
        message_id: recipient.message_id,
        highlights: { recipients: [expect.stringContaining("**Blind**")] },
      });
      expect(
        (yield* Effect.flip(mailbox.searchMessages(inboxId, "quartz", { limit: 101 }))).code,
      ).toBe("validation_error");
      expect(
        (yield* mailbox.searchMessages(inboxId, "quartz", { before: "2026-10-10T10:00:00Z" }))
          .count,
      ).toBe(0);
    }),
  );
});

test("treats hostile search syntax as plain terms and prefers extracted text", async ({
  home,
  key,
}) => {
  await withMailbox(home, key, (mailbox) =>
    Effect.gen(function* () {
      const inboxId = (yield* mailbox.createInbox({ domain: "example.test" })).inbox_id;
      const literal = yield* mailbox.insertMessage(
        message(inboxId, "literal", {
          text: "Literal NEAR operator quartz OR value",
          extracted_text: "Literal NEAR operator quartz OR value",
        }),
      );
      yield* mailbox.insertMessage(
        message(inboxId, "quoted-history", {
          text: "secretquoted quartz",
          extracted_text: "Visible answer",
        }),
      );
      expect((yield* mailbox.searchMessages(inboxId, "secretquoted")).count).toBe(0);
      for (const q of ['"', "*", "-", "()"]) {
        expect((yield* mailbox.searchMessages(inboxId, q)).count).toBe(0);
        expect((yield* mailbox.searchThreads({}, q)).count).toBe(0);
      }
      for (const q of ["NEAR(", '"quartz"', "quartz*", "-quartz", '"quartz" OR NEAR(']) {
        expect(
          (yield* mailbox.searchMessages(inboxId, q)).messages.map((m) => m.message_id),
        ).toEqual([literal.message_id]);
      }
      expect((yield* mailbox.searchMessages(inboxId, 'quartz OR "missing"')).count).toBe(0);
    }),
  );
});

test("keeps FTS consistent on content changes and rejects search tokens after changes", async ({
  home,
  key,
}) => {
  await withMailbox(home, key, (mailbox, store) =>
    Effect.gen(function* () {
      const inboxId = (yield* mailbox.createInbox({ domain: "example.test" })).inbox_id;
      const first = yield* mailbox.insertMessage(
        message(inboxId, "first", { text: "oldterm", labels: [] }),
      );
      yield* mailbox.insertMessage(message(inboxId, "second", { text: "oldterm", labels: [] }));
      const page = yield* mailbox.searchMessages(inboxId, "oldterm", { limit: 1 });
      const token = requireToken(page.next_page_token);
      expect(
        (yield* Effect.flip(mailbox.searchMessages(inboxId, "different", { page_token: token })))
          .code,
      ).toBe("page_token_stale");
      yield* store.use((db) =>
        db
          .prepare("UPDATE messages SET extracted_text = ? WHERE inbox_id = ? AND message_id = ?")
          .run("newterm", inboxId, first.message_id),
      );
      expect(
        (yield* mailbox.searchMessages(inboxId, "newterm")).messages.map((m) => m.message_id),
      ).toEqual([first.message_id]);
      expect((yield* mailbox.searchMessages(inboxId, "oldterm")).count).toBe(1);
      expect(
        (yield* Effect.flip(mailbox.searchMessages(inboxId, "oldterm", { page_token: token })))
          .code,
      ).toBe("page_token_stale");
      yield* mailbox.deleteMessage(inboxId, first.message_id);
      expect((yield* mailbox.searchMessages(inboxId, "newterm")).count).toBe(0);
    }),
  );
});

test("searches inbox word prefixes with relevance pagination", async ({ home, key }) => {
  await withMailbox(home, key, (mailbox) =>
    Effect.gen(function* () {
      yield* mailbox.createInbox({
        username: "robot-one",
        domain: "example.test",
        display_name: "Robotics",
      });
      yield* mailbox.createInbox({
        username: "robot-two",
        domain: "example.test",
        display_name: "Assistant",
      });
      yield* mailbox.createInbox({
        username: "helper",
        domain: "example.test",
        display_name: "Other",
      });
      const whole = yield* mailbox.searchInboxes("rob");
      expect(whole.count).toBe(2);
      const first = yield* mailbox.searchInboxes("rob", { limit: 1 });
      const second = yield* mailbox.searchInboxes("rob", {
        limit: 1,
        page_token: requireToken(first.next_page_token),
      });
      expect([...first.inboxes, ...second.inboxes]).toEqual(whole.inboxes);
      expect(second.next_page_token).toBeUndefined();
      expect((yield* mailbox.searchInboxes("obo")).count).toBe(0);
      expect((yield* Effect.flip(mailbox.searchInboxes("r"))).code).toBe("validation_error");
      yield* mailbox.updateInbox(whole.inboxes[0]?.inbox_id ?? "", { display_name: "Updated" });
      expect(
        (yield* Effect.flip(
          mailbox.searchInboxes("rob", { page_token: requireToken(first.next_page_token) }),
        )).code,
      ).toBe("page_token_stale");
    }),
  );
});

test("rolls back ingestion and atomic batches on database failures", async ({ home, key }) => {
  await withMailbox(home, key, (mailbox, store) =>
    Effect.gen(function* () {
      const inboxId = (yield* mailbox.createInbox({ domain: "example.test" })).inbox_id;
      const first = yield* mailbox.insertMessage(message(inboxId, "first"));
      const second = yield* mailbox.insertMessage(message(inboxId, "second"));
      const searchPage = yield* mailbox.searchMessages(inboxId, "project", { limit: 1 });
      yield* store.use((db) =>
        db.exec(
          "CREATE TEMP TRIGGER attachment_fail BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
        ),
      );
      const failure = yield* Effect.flip(
        mailbox.insertMessage(
          message(inboxId, "failed", {
            aliases: ["failed-alias"],
            attachments: [{ content: Buffer.from("attachment") }],
          }),
        ),
      );
      expect(failure).toBeInstanceOf(DatabaseError);
      expect((yield* mailbox.listMessages(inboxId)).count).toBe(2);
      expect((yield* mailbox.listThreads()).count).toBe(2);
      expect(
        (yield* mailbox.searchMessages(inboxId, "project", {
          limit: 1,
          page_token: requireToken(searchPage.next_page_token),
        })).count,
      ).toBe(1);
      yield* store.use((db) => {
        expect(
          db.prepare("SELECT 1 FROM message_aliases WHERE alias = ?").all("failed-alias"),
        ).toEqual([]);
        expect(db.prepare("SELECT count(*) AS count FROM raw_messages").get()).toEqual({
          count: 2,
        });
        db.exec(`CREATE TEMP TRIGGER batch_fail BEFORE UPDATE ON messages
        WHEN old.message_id = '<second@example.test>' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
      });
      expect(
        yield* Effect.flip(
          mailbox.batchUpdateMessages(inboxId, {
            message_ids: [first.message_id, second.message_id],
            add_labels: ["changed"],
            remove_labels: ["unread"],
          }),
        ),
      ).toBeInstanceOf(DatabaseError);
      expect((yield* mailbox.getMessage(inboxId, first.message_id)).labels).toEqual([
        "received",
        "unread",
      ]);
      expect((yield* mailbox.getMessage(inboxId, second.message_id)).labels).toEqual([
        "received",
        "unread",
      ]);
    }),
  );
});

test("rejects ambiguous aliases and conflicting attachments without partial writes", async ({
  home,
  key,
}) => {
  await withMailbox(home, key, (mailbox) =>
    Effect.gen(function* () {
      const inboxId = (yield* mailbox.createInbox({ domain: "example.test" })).inbox_id;
      const parent = yield* mailbox.insertMessage(
        message(inboxId, "parent", {
          aliases: ["provider", "<reserved@example.test>"],
          attachments: [{ attachment_id: "existing", content: Buffer.from("first") }],
        }),
      );
      for (const input of [
        message(inboxId, "reserved"),
        message(inboxId, "alias", { aliases: ["provider"] }),
        message(inboxId, "canonical-alias", { aliases: [parent.message_id] }),
        message(inboxId, "attachment", {
          attachments: [{ attachment_id: "existing", content: Buffer.from("other") }],
        }),
      ]) {
        expect((yield* Effect.flip(mailbox.insertMessage(input))).code).toBe("already_exists");
      }
      expect(
        (yield* Effect.flip(
          mailbox.insertMessage(
            message(inboxId, "size", {
              attachments: [{ size: 20, content: Buffer.from("short") }],
            }),
          ),
        )).code,
      ).toBe("validation_error");
      expect(
        (yield* Effect.flip(
          mailbox.insertMessage(message(inboxId, "bad", { message_id: "no-brackets" })),
        )).code,
      ).toBe("validation_error");
      expect((yield* mailbox.listMessages(inboxId)).count).toBe(1);
      expect((yield* mailbox.listThreads()).count).toBe(1);
    }),
  );
});

test("persists mailbox data across encrypted store reopen and deletes whole threads", async ({
  home,
  key,
}) => {
  const created = await withMailbox(home, key, (mailbox) =>
    Effect.gen(function* () {
      const inboxId = (yield* mailbox.createInbox({
        username: "persistent",
        domain: "example.test",
      })).inbox_id;
      const inserted = yield* mailbox.insertMessage(
        message(inboxId, "persistent", {
          text: "unique-private-mailbox-marker",
          raw: Buffer.from("unique-private-raw-marker"),
          aliases: ["provider"],
          attachments: [
            { attachment_id: "file", content: Buffer.from("unique-private-attachment-marker") },
          ],
        }),
      );
      return { inboxId, ...inserted };
    }),
  );
  const bytes = await readFile(join(home, "inbot.db"));
  expect(bytes.subarray(0, 15).toString()).not.toBe("SQLite format 3");
  for (const marker of [
    "unique-private-mailbox-marker",
    "unique-private-raw-marker",
    "unique-private-attachment-marker",
  ])
    expect(bytes.includes(Buffer.from(marker))).toBe(false);
  await withMailbox(home, key, (mailbox, store) =>
    Effect.gen(function* () {
      expect((yield* mailbox.getMessage(created.inboxId, created.message_id)).text).toBe(
        "unique-private-mailbox-marker",
      );
      expect((yield* mailbox.searchMessages(created.inboxId, "mailbox")).count).toBe(1);
      expect(
        (yield* mailbox.insertMessage(
          message(created.inboxId, "reply", { in_reply_to: "provider" }),
        )).thread_id,
      ).toBe(created.thread_id);
      yield* mailbox.deleteThread(created.inboxId, created.thread_id);
      expect((yield* mailbox.listMessages(created.inboxId)).count).toBe(0);
      expect((yield* mailbox.searchThreads({}, "private")).count).toBe(0);
      expect(
        (yield* Effect.flip(mailbox.getRawMessage(created.inboxId, created.message_id))).code,
      ).toBe("not_found");
      expect(
        (yield* Effect.flip(mailbox.getAttachment(created.inboxId, created.message_id, "file")))
          .code,
      ).toBe("not_found");
      yield* store.use((db) => {
        for (const table of [
          "messages",
          "raw_messages",
          "message_labels",
          "attachments",
          "message_aliases",
          "message_search",
        ])
          expect(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      });
    }),
  );
});

test("matches Unicode sender, recipient, and subject filters without SQL wildcard semantics", async ({
  home,
  key,
}) => {
  await withMailbox(home, key, (mailbox) =>
    Effect.gen(function* () {
      const inboxId = (yield* mailbox.createInbox({ domain: "example.test" })).inbox_id;
      const inserted = yield* mailbox.insertMessage(
        message(inboxId, "unicode", {
          from: "\u00c9va <eva@example.test>",
          to: ["\u00c1kos <akos@example.test>"],
          subject: "\u00c1RV\u00cdZ_100% Review",
        }),
      );
      const query = { from: ["\u00e9va"], to: ["\u00e1kos"], subject: ["\u00e1rv\u00edz_100%"] };
      expect(
        (yield* mailbox.listMessages(inboxId, query)).messages.map((m) => m.message_id),
      ).toEqual([inserted.message_id]);
      expect(
        (yield* mailbox.listThreads(
          { inbox_id: inboxId },
          { senders: query.from, recipients: query.to, subject: query.subject },
        )).threads.map((t) => t.thread_id),
      ).toEqual([inserted.thread_id]);
      expect((yield* mailbox.listMessages(inboxId, { subject: ["_200%"] })).count).toBe(0);
    }),
  );
});

for (const version of [1, 10]) {
  test(`upgrades an encrypted version-${version} database without losing existing data`, async ({
    home,
    key,
  }) => {
    const db = new Database(join(home, "inbot.db"));
    try {
      db.pragma("cipher = 'chacha20'");
      db.pragma("legacy = 0");
      db.pragma("plaintext_header_size = 0");
      db.pragma(`key = "x'${Buffer.from(key).toString("hex")}'"`);
      await Effect.runPromise(migrate(db, migrations.slice(0, version)));
      db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("original", "preserved");
      if (version === 10) {
        const timestamp = new Date(now).toISOString();
        createInbox(db, { username: "existing", domain: "example.test" }, timestamp);
        db.prepare(
          "INSERT INTO list_entries (scope, direction, list_type, entry, entry_type, created_at) VALUES ('', 'receive', 'block', 'blocked.test', 'domain', ?)",
        ).run(timestamp);
        db.prepare(
          "INSERT INTO inbound_list_rejections (inbox_id, payload_hash, reason_code, received_at) VALUES ('existing@example.test', 'synthetic-hash', 'blocked_sender', ?)",
        ).run(timestamp);
      }
    } finally {
      db.close();
    }
    const inboxId = await withMailbox(home, key, (mailbox, store) =>
      Effect.gen(function* () {
        yield* store.use((database) => {
          expect(database.pragma("user_version", { simple: true })).toBe(
            migrations.at(-1)?.version ?? 0,
          );
          expect(database.prepare("SELECT value FROM meta WHERE key = ?").get("original")).toEqual({
            value: "preserved",
          });
        });
        if (version === 10) {
          expect((yield* mailbox.getInbox("existing@example.test")).inbox_id).toBe(
            "existing@example.test",
          );
          yield* store.use((database) => {
            expect(database.prepare("SELECT entry FROM list_entries").all()).toEqual([
              { entry: "blocked.test" },
            ]);
            expect(
              database
                .prepare("SELECT payload_hash, reason_code FROM inbound_list_rejections")
                .all(),
            ).toEqual([{ payload_hash: "synthetic-hash", reason_code: "blocked_sender" }]);
            expect(database.prepare("SELECT * FROM event_log").all()).toEqual([]);
          });
        }
        return (yield* mailbox.createInbox({ username: "migrated", domain: "example.test" }))
          .inbox_id;
      }),
    );
    await withMailbox(home, key, (mailbox) =>
      Effect.gen(function* () {
        expect((yield* mailbox.getInbox(inboxId)).inbox_id).toBe(inboxId);
        yield* mailbox.insertMessage(message(inboxId, "after-migration"));
        expect((yield* mailbox.searchMessages(inboxId, "project")).count).toBe(1);
      }),
    );
  });
}
