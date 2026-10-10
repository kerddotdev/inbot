import { Context, Effect, Layer } from "effect";
import type { Permission } from "../../../../packages/contracts/src/api-keys.js";
import type {
  CursorQuery,
  PaginationQuery,
  SearchInboxesQuery,
  SearchMailQuery,
} from "../../../../packages/contracts/src/common.js";
import type {
  CreateInboxRequest,
  UpdateInboxRequest,
} from "../../../../packages/contracts/src/inboxes.js";
import type {
  ListMessagesQuery,
  UpdateMessageRequest,
} from "../../../../packages/contracts/src/messages.js";
import type {
  ListThreadsQuery,
  UpdateThreadRequest,
} from "../../../../packages/contracts/src/threads.js";
import type { OutboundRequest } from "../../../../packages/contracts/src/outbound.js";
import { Mailbox, type MailboxService } from "../mailbox/mailbox.js";
import { validationError } from "../mailbox/errors.js";
import { inboxAllowlist, visible, visibleQuery } from "../agent/authorization.js";
import { Downloads } from "../http/downloads.js";
import { wireError } from "../http/errors.js";
import { Outbox, type OutboxService } from "../outbound/outbox.js";
import { TransportConfig } from "../outbound/transport-config.js";
import { authorize, authorizeSendPolicy } from "./authorization.js";

function makeOperations(
  mailbox: MailboxService,
  outbox: OutboxService,
  config: TransportConfig["Service"],
  downloads: Downloads["Service"],
) {
  function checked<A, E, R>(
    permission: Permission,
    inboxId: string | undefined,
    effect: Effect.Effect<A, E, R>,
  ) {
    return Effect.andThen(authorize(permission, inboxId), effect);
  }
  const message = (inboxId: string, messageId: string) =>
    visible(mailbox.getMessage(inboxId, messageId));
  const thread = (inboxId: string, threadId: string, query: typeof CursorQuery.Type = {}) =>
    visible(mailbox.getThread(inboxId, threadId, query));
  const scope = Effect.map(inboxAllowlist, (inboxIds) =>
    inboxIds === undefined ? {} : { inbox_ids: inboxIds },
  );
  const resolve = (threadId: string) =>
    Effect.flatMap(scope, (allowed) => mailbox.resolveThreadInbox(threadId, allowed));
  const threadInbox = (inboxId: string | undefined, threadId: string) =>
    inboxId === undefined ? resolve(threadId) : Effect.succeed(inboxId);
  return {
    listInboxes: (query: typeof PaginationQuery.Type) =>
      checked(
        "inbox_read",
        undefined,
        Effect.flatMap(inboxAllowlist, (ids) => mailbox.listInboxes(query, ids)),
      ),
    searchInboxes: ({ q, ...query }: typeof SearchInboxesQuery.Type) =>
      checked(
        "inbox_read",
        undefined,
        Effect.flatMap(inboxAllowlist, (ids) => mailbox.searchInboxes(q, query, ids)),
      ),
    createInbox: (input: CreateInboxRequest) =>
      checked(
        "inbox_create",
        undefined,
        Effect.gen(function* () {
          if (input.domain === undefined)
            return yield* validationError("A mailbox domain is required.");
          return yield* mailbox.createInbox(
            { ...input, domain: input.domain },
            yield* inboxAllowlist,
          );
        }),
      ),
    getInbox: (inboxId: string) => checked("inbox_read", inboxId, mailbox.getInbox(inboxId)),
    updateInbox: (inboxId: string, input: UpdateInboxRequest) =>
      checked("inbox_update", inboxId, mailbox.updateInbox(inboxId, input)),
    deleteInbox: (inboxId: string) =>
      checked("inbox_delete", inboxId, mailbox.deleteInbox(inboxId)),
    listMessages: (inboxId: string, query: typeof ListMessagesQuery.Type) =>
      checked(
        "message_read",
        inboxId,
        Effect.flatMap(visibleQuery(query), (query) => mailbox.listMessages(inboxId, query)),
      ),
    searchMessages: (inboxId: string, { q, ...query }: typeof SearchMailQuery.Type) =>
      checked("message_read", inboxId, mailbox.searchMessages(inboxId, q, query)),
    getMessage: (inboxId: string, messageId: string) =>
      checked("message_read", inboxId, message(inboxId, messageId)),
    updateMessage: (inboxId: string, messageId: string, input: UpdateMessageRequest) =>
      checked(
        "message_update",
        inboxId,
        Effect.andThen(
          message(inboxId, messageId),
          mailbox.updateMessage(inboxId, messageId, input),
        ),
      ),
    listThreads: (inboxId: string | undefined, query: typeof ListThreadsQuery.Type) =>
      checked(
        "message_read",
        inboxId,
        Effect.gen(function* () {
          return yield* mailbox.listThreads(
            inboxId === undefined ? yield* scope : { inbox_id: inboxId },
            yield* visibleQuery(query),
          );
        }),
      ),
    searchThreads: (inboxId: string | undefined, { q, ...query }: typeof SearchMailQuery.Type) =>
      checked(
        "message_read",
        inboxId,
        Effect.gen(function* () {
          return yield* mailbox.searchThreads(
            inboxId === undefined ? yield* scope : { inbox_id: inboxId },
            q,
            query,
          );
        }),
      ),
    getThread: (inboxId: string | undefined, threadId: string, query: typeof CursorQuery.Type) =>
      Effect.gen(function* () {
        const id = yield* threadInbox(inboxId, threadId);
        return yield* checked("message_read", id, thread(id, threadId, query));
      }),
    updateThread: (inboxId: string | undefined, threadId: string, input: UpdateThreadRequest) =>
      Effect.gen(function* () {
        const id = yield* threadInbox(inboxId, threadId);
        return yield* checked(
          "message_update",
          id,
          Effect.andThen(
            thread(id, threadId, { limit: 1 }),
            mailbox.updateThread(id, threadId, input),
          ),
        );
      }),
    deleteThread: (inboxId: string | undefined, threadId: string) =>
      Effect.gen(function* () {
        const id = yield* threadInbox(inboxId, threadId);
        return yield* checked(
          "message_delete",
          id,
          Effect.andThen(thread(id, threadId, { limit: 1 }), mailbox.deleteThread(id, threadId)),
        );
      }),
    getAttachment: (inboxId: string | undefined, threadId: string, attachmentId: string) =>
      Effect.gen(function* () {
        const id = yield* threadInbox(inboxId, threadId);
        return yield* checked(
          "message_read",
          id,
          Effect.gen(function* () {
            yield* thread(id, threadId, { limit: 1 });
            const { attachment } = yield* mailbox.getThreadAttachment(id, threadId, attachmentId);
            return {
              ...attachment,
              ...(yield* downloads.link({
                inbox_id: id,
                thread_id: threadId,
                attachment_id: attachmentId,
              })),
            };
          }),
        );
      }),
    send: (inboxId: string, input: OutboundRequest, idempotencyKey?: string) =>
      checked(
        input.kind === "reply" || input.kind === "reply-all" ? "message_reply" : "message_send",
        inboxId,
        Effect.gen(function* () {
          yield* authorizeSendPolicy;
          if (input.kind !== "send") {
            yield* authorize("message_read", inboxId);
            yield* message(inboxId, input.message_id);
          }
          if ((yield* config.get()) === undefined)
            return yield* Effect.fail(
              wireError(
                "service_unavailable",
                "The mail transport is not configured.",
                "Configure the Cloudflare mail transport",
              ),
            );
          return yield* outbox.enqueue(inboxId, input, idempotencyKey);
        }),
      ),
  };
}

export class AgentOperations extends Context.Service<
  AgentOperations,
  ReturnType<typeof makeOperations>
>()("inbot/AgentOperations") {
  static readonly Live = Layer.effect(
    AgentOperations,
    Effect.gen(function* () {
      return makeOperations(
        yield* Mailbox,
        yield* Outbox,
        yield* TransportConfig,
        yield* Downloads,
      );
    }),
  );
}
