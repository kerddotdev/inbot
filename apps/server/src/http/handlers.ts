import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { CurrentPrincipal } from "../../../../packages/contracts/src/security.js";
import { ApiKeys } from "../auth/api-keys.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { notFound, validationError } from "../mailbox/errors.js";
import { ServerApi } from "./api.js";
import { inboxAllowlist, labelsAllowed, visible, visibleQuery } from "./authorization.js";
import { Downloads } from "./downloads.js";
import { respond, unsupported } from "./errors.js";

const InboxesLive = HttpApiBuilder.group(ServerApi, "inboxes", (handlers) =>
  Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    return handlers
      .handle("inboxes_list", ({ query }) =>
        respond(
          Effect.gen(function* () {
            return yield* mailbox.listInboxes(query, yield* inboxAllowlist);
          }),
        ),
      )
      .handle("inboxes_search", ({ query: { q, ...query } }) =>
        respond(
          Effect.gen(function* () {
            return yield* mailbox.searchInboxes(q, query, yield* inboxAllowlist);
          }),
        ),
      )
      .handle("inboxes_create", ({ payload }) =>
        respond(
          Effect.gen(function* () {
            if (payload.domain === undefined)
              return yield* validationError("A mailbox domain is required.");
            return yield* mailbox.createInbox(
              { ...payload, domain: payload.domain },
              yield* inboxAllowlist,
            );
          }),
        ),
      )
      .handle("inboxes_get", ({ params }) => respond(mailbox.getInbox(params.inbox_id)))
      .handle("inboxes_update", ({ params, payload }) =>
        respond(mailbox.updateInbox(params.inbox_id, payload)),
      )
      .handle("inboxes_delete", ({ params }) => respond(mailbox.deleteInbox(params.inbox_id)));
  }),
);

const MessagesLive = HttpApiBuilder.group(ServerApi, "messages", (handlers) =>
  Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    const downloads = yield* Downloads;
    const message = (inboxId: string, messageId: string) =>
      visible(mailbox.getMessage(inboxId, messageId));
    return handlers
      .handle("inboxes_messages_list", ({ params, query }) =>
        respond(
          Effect.gen(function* () {
            return yield* mailbox.listMessages(params.inbox_id, yield* visibleQuery(query));
          }),
        ),
      )
      .handle("inboxes_messages_search", ({ params, query: { q, ...query } }) =>
        respond(mailbox.searchMessages(params.inbox_id, q, query)),
      )
      .handle("inboxes_messages_get", ({ params }) =>
        respond(message(params.inbox_id, params.message_id)),
      )
      .handle("inboxes_messages_update", ({ params, payload }) =>
        respond(
          Effect.gen(function* () {
            yield* message(params.inbox_id, params.message_id);
            return yield* mailbox.updateMessage(params.inbox_id, params.message_id, payload);
          }),
        ),
      )
      .handle("inboxes_messages_delete", ({ params }) =>
        respond(
          Effect.gen(function* () {
            yield* message(params.inbox_id, params.message_id);
            return yield* mailbox.deleteMessage(params.inbox_id, params.message_id);
          }),
        ),
      )
      .handle("inboxes_messages_batchGet", ({ params, payload }) =>
        respond(
          Effect.gen(function* () {
            const principal = yield* CurrentPrincipal;
            const result = yield* mailbox.batchGetMessages(params.inbox_id, payload);
            const messages = result.messages.filter((value) =>
              labelsAllowed(principal, value.labels),
            );
            return { ...result, count: messages.length, messages };
          }),
        ),
      )
      .handle("inboxes_messages_batchUpdate", ({ params, payload }) =>
        respond(
          Effect.gen(function* () {
            const principal = yield* CurrentPrincipal;
            const result = yield* mailbox.batchGetMessages(params.inbox_id, {
              message_ids: payload.message_ids,
            });
            if (result.messages.some((value) => !labelsAllowed(principal, value.labels)))
              return yield* notFound();
            return yield* mailbox.batchUpdateMessages(params.inbox_id, payload);
          }),
        ),
      )
      .handle("inboxes_messages_getRaw", ({ params }) =>
        respond(
          Effect.gen(function* () {
            yield* message(params.inbox_id, params.message_id);
            const raw = yield* mailbox.getRawMessage(params.inbox_id, params.message_id);
            const link = yield* downloads.link({
              inbox_id: params.inbox_id,
              message_id: params.message_id,
            });
            return { message_id: params.message_id, size: raw.byteLength, ...link };
          }),
        ),
      )
      .handle("inboxes_messages_getAttachment", ({ params }) =>
        respond(
          Effect.gen(function* () {
            yield* message(params.inbox_id, params.message_id);
            const { attachment } = yield* mailbox.getAttachment(
              params.inbox_id,
              params.message_id,
              params.attachment_id,
            );
            return { ...attachment, ...(yield* downloads.link(params)) };
          }),
        ),
      )
      .handle("inboxes_messages_send", unsupported)
      .handle("inboxes_messages_reply", unsupported)
      .handle("inboxes_messages_replyAll", unsupported)
      .handle("inboxes_messages_forward", unsupported);
  }),
);

const ThreadsLive = HttpApiBuilder.group(ServerApi, "threads", (handlers) =>
  Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    const downloads = yield* Downloads;
    const resolve = (threadId: string) =>
      Effect.gen(function* () {
        const inboxIds = yield* inboxAllowlist;
        return yield* mailbox.resolveThreadInbox(
          threadId,
          inboxIds === undefined ? {} : { inbox_ids: inboxIds },
        );
      });
    const thread = (inboxId: string, threadId: string) =>
      visible(mailbox.getThread(inboxId, threadId, { limit: 1 }));
    const attachment = (inboxId: string, threadId: string, attachmentId: string) =>
      respond(
        Effect.gen(function* () {
          yield* thread(inboxId, threadId);
          const { attachment } = yield* mailbox.getThreadAttachment(
            inboxId,
            threadId,
            attachmentId,
          );
          return {
            ...attachment,
            ...(yield* downloads.link({
              inbox_id: inboxId,
              thread_id: threadId,
              attachment_id: attachmentId,
            })),
          };
        }),
      );
    return handlers
      .handle("inboxes_threads_list", ({ params, query }) =>
        respond(
          Effect.gen(function* () {
            return yield* mailbox.listThreads(
              { inbox_id: params.inbox_id },
              yield* visibleQuery(query),
            );
          }),
        ),
      )
      .handle("inboxes_threads_search", ({ params, query: { q, ...query } }) =>
        respond(mailbox.searchThreads({ inbox_id: params.inbox_id }, q, query)),
      )
      .handle("inboxes_threads_get", ({ params, query }) =>
        respond(visible(mailbox.getThread(params.inbox_id, params.thread_id, query))),
      )
      .handle("inboxes_threads_update", ({ params, payload }) =>
        respond(
          Effect.gen(function* () {
            yield* thread(params.inbox_id, params.thread_id);
            return yield* mailbox.updateThread(params.inbox_id, params.thread_id, payload);
          }),
        ),
      )
      .handle("inboxes_threads_delete", ({ params }) =>
        respond(
          Effect.gen(function* () {
            yield* thread(params.inbox_id, params.thread_id);
            return yield* mailbox.deleteThread(params.inbox_id, params.thread_id);
          }),
        ),
      )
      .handle("inboxes_threads_getAttachment", ({ params }) =>
        attachment(params.inbox_id, params.thread_id, params.attachment_id),
      )
      .handle("threads_list", ({ query }) =>
        respond(
          Effect.gen(function* () {
            const inboxIds = yield* inboxAllowlist;
            return yield* mailbox.listThreads(
              inboxIds === undefined ? {} : { inbox_ids: inboxIds },
              yield* visibleQuery(query),
            );
          }),
        ),
      )
      .handle("threads_search", ({ query: { q, ...query } }) =>
        respond(
          Effect.gen(function* () {
            const inboxIds = yield* inboxAllowlist;
            return yield* mailbox.searchThreads(
              inboxIds === undefined ? {} : { inbox_ids: inboxIds },
              q,
              query,
            );
          }),
        ),
      )
      .handle("threads_get", ({ params, query }) =>
        respond(
          Effect.gen(function* () {
            return yield* visible(
              mailbox.getThread(yield* resolve(params.thread_id), params.thread_id, query),
            );
          }),
        ),
      )
      .handle("threads_update", ({ params, payload }) =>
        respond(
          Effect.gen(function* () {
            const inboxId = yield* resolve(params.thread_id);
            yield* thread(inboxId, params.thread_id);
            return yield* mailbox.updateThread(inboxId, params.thread_id, payload);
          }),
        ),
      )
      .handle("threads_delete", ({ params }) =>
        respond(
          Effect.gen(function* () {
            const inboxId = yield* resolve(params.thread_id);
            yield* thread(inboxId, params.thread_id);
            return yield* mailbox.deleteThread(inboxId, params.thread_id);
          }),
        ),
      )
      .handle("threads_getAttachment", ({ params }) =>
        respond(
          Effect.gen(function* () {
            return yield* attachment(
              yield* resolve(params.thread_id),
              params.thread_id,
              params.attachment_id,
            );
          }),
        ),
      );
  }),
);

const ApiKeysLive = HttpApiBuilder.group(ServerApi, "api-keys", (handlers) =>
  Effect.gen(function* () {
    const keys = yield* ApiKeys;
    const mailbox = yield* Mailbox;
    return handlers
      .handle("apiKeys_list", ({ query: { type: _type, ...query } }) => respond(keys.list(query)))
      .handle("apiKeys_create", ({ payload }) => respond(keys.create(payload)))
      .handle("apiKeys_get", ({ params }) => respond(keys.get(params.api_key_id)))
      .handle("apiKeys_update", ({ params, payload }) =>
        respond(keys.update(params.api_key_id, payload)),
      )
      .handle("apiKeys_delete", ({ params }) => respond(keys.delete(params.api_key_id)))
      .handle("inboxes_apiKeys_list", ({ params, query }) =>
        respond(
          Effect.gen(function* () {
            yield* mailbox.getInbox(params.inbox_id);
            return yield* keys.list(query, params.inbox_id);
          }),
        ),
      )
      .handle("inboxes_apiKeys_create", ({ params, payload }) =>
        respond(
          Effect.gen(function* () {
            yield* mailbox.getInbox(params.inbox_id);
            return yield* keys.create(payload, params.inbox_id);
          }),
        ),
      )
      .handle("inboxes_apiKeys_update", ({ params, payload }) =>
        respond(
          Effect.gen(function* () {
            yield* mailbox.getInbox(params.inbox_id);
            return yield* keys.update(params.api_key_id, payload, params.inbox_id);
          }),
        ),
      )
      .handle("inboxes_apiKeys_delete", ({ params }) =>
        respond(
          Effect.gen(function* () {
            yield* mailbox.getInbox(params.inbox_id);
            return yield* keys.delete(params.api_key_id, params.inbox_id);
          }),
        ),
      );
  }),
);

const DraftsLive = HttpApiBuilder.group(ServerApi, "drafts", (handlers) =>
  handlers
    .handle("inboxes_drafts_list", unsupported)
    .handle("inboxes_drafts_create", unsupported)
    .handle("inboxes_drafts_get", unsupported)
    .handle("inboxes_drafts_update", unsupported)
    .handle("inboxes_drafts_delete", unsupported)
    .handle("inboxes_drafts_getAttachment", unsupported)
    .handle("inboxes_drafts_send", unsupported)
    .handle("drafts_list", unsupported)
    .handle("drafts_get", unsupported)
    .handle("drafts_getAttachment", unsupported),
);

const ListsLive = HttpApiBuilder.group(ServerApi, "lists", (handlers) =>
  handlers
    .handle("inboxes_lists_list", unsupported)
    .handle("inboxes_lists_create", unsupported)
    .handle("inboxes_lists_get", unsupported)
    .handle("inboxes_lists_delete", unsupported)
    .handle("lists_list", unsupported)
    .handle("lists_create", unsupported)
    .handle("lists_get", unsupported)
    .handle("lists_delete", unsupported),
);

const WebhooksLive = HttpApiBuilder.group(ServerApi, "webhooks", (handlers) =>
  handlers
    .handle("inboxes_webhooks_list", unsupported)
    .handle("inboxes_webhooks_create", unsupported)
    .handle("inboxes_webhooks_get", unsupported)
    .handle("inboxes_webhooks_update", unsupported)
    .handle("inboxes_webhooks_delete", unsupported)
    .handle("inboxes_webhooks_getHeaders", unsupported)
    .handle("inboxes_webhooks_updateHeaders", unsupported)
    .handle("webhooks_list", unsupported)
    .handle("webhooks_create", unsupported)
    .handle("webhooks_get", unsupported)
    .handle("webhooks_update", unsupported)
    .handle("webhooks_delete", unsupported)
    .handle("webhooks_getHeaders", unsupported)
    .handle("webhooks_updateHeaders", unsupported),
);

const DomainsLive = HttpApiBuilder.group(ServerApi, "domains", (handlers) =>
  handlers
    .handle("domains_list", unsupported)
    .handle("domains_create", unsupported)
    .handle("domains_get", unsupported)
    .handle("domains_update", unsupported)
    .handle("domains_delete", unsupported)
    .handle("domains_getZoneFile", unsupported)
    .handle("domains_verify", unsupported),
);

export const HandlersLive = Layer.mergeAll(
  InboxesLive,
  MessagesLive,
  ThreadsLive,
  ApiKeysLive,
  DraftsLive,
  ListsLive,
  WebhooksLive,
  DomainsLive,
);
