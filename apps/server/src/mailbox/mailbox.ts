import type Database from "better-sqlite3-multiple-ciphers";
import { Clock, Context, Effect, Layer, Result } from "effect";
import type {
  CursorQuery,
  PaginationQuery,
  SearchInboxesQuery,
  SearchMailQuery,
} from "../../../../packages/contracts/src/common.js";
import type { UpdateInboxRequest } from "../../../../packages/contracts/src/inboxes.js";
import type {
  BatchGetMessagesRequest,
  BatchUpdateMessagesRequest,
  ListMessagesQuery,
  UpdateMessageRequest,
} from "../../../../packages/contracts/src/messages.js";
import type {
  ListThreadsQuery,
  UpdateThreadRequest,
} from "../../../../packages/contracts/src/threads.js";
import { Store, type StoreService } from "../store.js";
import { MailboxError } from "./errors.js";
import { acceptInbound } from "../lists/policy.js";
import * as Inboxes from "./inboxes.js";
import * as Messages from "./messages.js";
import * as Threads from "./threads.js";
import * as Search from "./search.js";
import * as Rows from "./rows.js";
import type { InboxScope, InsertMessage } from "./types.js";

function makeMailbox(store: StoreService) {
  function run<A>(operation: (db: Database.Database, now: number) => A, write = false) {
    return Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const result = yield* store.use((db): Result.Result<A, MailboxError> => {
        try {
          const transaction = db.transaction(() => operation(db, now));
          return Result.succeed(write ? transaction.immediate() : transaction.deferred());
        } catch (error) {
          if (error instanceof MailboxError) return Result.fail(error);
          throw error;
        }
      });
      return yield* Effect.fromResult(result);
    });
  }

  return {
    acceptInbound: (
      inboxId: string,
      senders: readonly string[],
      raw: Uint8Array,
      receivedAt: string,
    ) => run((db) => acceptInbound(db, inboxId, senders, raw, receivedAt), true),
    createInbox: (input: Inboxes.CreateInbox, inboxIds?: readonly string[]) =>
      run((db, now) => Inboxes.createInbox(db, input, new Date(now).toISOString(), inboxIds), true),
    getInbox: (inboxId: string) => run((db) => Rows.getInbox(db, inboxId)),
    listInboxes: (query: typeof PaginationQuery.Type = {}, inboxIds?: readonly string[]) =>
      run((db) => Inboxes.listInboxes(db, query, inboxIds)),
    searchInboxes: (
      q: string,
      query: Omit<typeof SearchInboxesQuery.Type, "q"> = {},
      inboxIds?: readonly string[],
    ) => run((db) => Search.searchInboxes(db, q, query, inboxIds)),
    updateInbox: (inboxId: string, input: UpdateInboxRequest) =>
      run((db, now) => Inboxes.updateInbox(db, inboxId, input, new Date(now).toISOString()), true),
    deleteInbox: (inboxId: string) =>
      run((db) => {
        Rows.getInbox(db, inboxId);
        db.prepare("DELETE FROM inboxes WHERE inbox_id = ?").run(inboxId);
      }, true),
    insertMessage: (input: InsertMessage) =>
      run((db, now) => Messages.insertMessage(db, input, now), true),
    getMessage: (inboxId: string, messageId: string) =>
      run((db) => Rows.getMessage(db, inboxId, messageId)),
    listMessages: (inboxId: string, query: typeof ListMessagesQuery.Type = {}) =>
      run((db) => Messages.listMessages(db, inboxId, query)),
    searchMessages: (
      inboxId: string,
      q: string,
      query: Omit<typeof SearchMailQuery.Type, "q"> = {},
    ) => run((db) => Search.searchMessages(db, inboxId, q, query)),
    updateMessage: (inboxId: string, messageId: string, input: UpdateMessageRequest) =>
      run(
        (db, now) =>
          Messages.updateMessage(db, inboxId, messageId, input, new Date(now).toISOString()),
        true,
      ),
    batchGetMessages: (inboxId: string, input: BatchGetMessagesRequest) =>
      run((db) => Messages.batchGetMessages(db, inboxId, input)),
    batchUpdateMessages: (inboxId: string, input: BatchUpdateMessagesRequest) =>
      run(
        (db, now) => Messages.batchUpdateMessages(db, inboxId, input, new Date(now).toISOString()),
        true,
      ),
    deleteMessage: (inboxId: string, messageId: string) =>
      run(
        (db, now) => Messages.deleteMessage(db, inboxId, messageId, new Date(now).toISOString()),
        true,
      ),
    getRawMessage: (inboxId: string, messageId: string) =>
      run((db) => Messages.getRawMessage(db, inboxId, messageId)),
    getAttachment: (inboxId: string, messageId: string, attachmentId: string) =>
      run((db) => Threads.getAttachment(db, inboxId, messageId, attachmentId)),
    listThreads: (scope: InboxScope = {}, query: typeof ListThreadsQuery.Type = {}) =>
      run((db) => Threads.listThreads(db, scope, query)),
    searchThreads: (
      scope: InboxScope,
      q: string,
      query: Omit<typeof SearchMailQuery.Type, "q"> = {},
    ) => run((db) => Search.searchThreads(db, scope, q, query)),
    getThread: (inboxId: string, threadId: string, query: typeof CursorQuery.Type = {}) =>
      run((db) => Threads.getThread(db, inboxId, threadId, query)),
    resolveThreadInbox: (threadId: string, scope: InboxScope = {}) =>
      run((db) => Threads.resolveThreadInbox(db, threadId, scope)),
    updateThread: (inboxId: string, threadId: string, input: UpdateThreadRequest) =>
      run(
        (db, now) =>
          Threads.updateThread(db, inboxId, threadId, input, new Date(now).toISOString()),
        true,
      ),
    deleteThread: (inboxId: string, threadId: string) =>
      run((db) => Threads.deleteThread(db, inboxId, threadId), true),
    getThreadAttachment: (inboxId: string, threadId: string, attachmentId: string) =>
      run((db) => Threads.getThreadAttachment(db, inboxId, threadId, attachmentId)),
  };
}

export type MailboxService = ReturnType<typeof makeMailbox>;

export class Mailbox extends Context.Service<Mailbox, MailboxService>()("inbot/Mailbox") {
  static readonly Live = Layer.effect(
    Mailbox,
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.use((db) =>
        db.function(
          "mailbox_contains",
          { deterministic: true },
          (value: unknown, substring: unknown) =>
            Number(
              typeof value === "string" &&
                typeof substring === "string" &&
                value.toLowerCase().includes(substring.toLowerCase()),
            ),
        ),
      );
      return makeMailbox(store);
    }),
  );
}
