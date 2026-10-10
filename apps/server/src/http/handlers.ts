import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { CurrentPrincipal } from "../../../../packages/contracts/src/security.js";
import { ApiKeys } from "../auth/api-keys.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { notFound } from "../mailbox/errors.js";
import { Provisioner } from "../provision/provisioner.js";
import { AgentOperations } from "../agent/operations.js";
import { ServerApi } from "./api.js";
import { labelsAllowed, visible } from "../agent/authorization.js";
import { Downloads } from "./downloads.js";
import { respond, unsupported } from "./errors.js";

const InboxesLive = HttpApiBuilder.group(ServerApi, "inboxes", (handlers) =>
  Effect.gen(function* () {
    const operations = yield* AgentOperations;
    return handlers
      .handle("inboxes_list", ({ query }) => respond(operations.listInboxes(query)))
      .handle("inboxes_search", ({ query }) => respond(operations.searchInboxes(query)))
      .handle("inboxes_create", ({ payload }) => respond(operations.createInbox(payload)))
      .handle("inboxes_get", ({ params }) => respond(operations.getInbox(params.inbox_id)))
      .handle("inboxes_update", ({ params, payload }) =>
        respond(operations.updateInbox(params.inbox_id, payload)),
      )
      .handle("inboxes_delete", ({ params }) => respond(operations.deleteInbox(params.inbox_id)));
  }),
);

const MessagesLive = HttpApiBuilder.group(ServerApi, "messages", (handlers) =>
  Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    const operations = yield* AgentOperations;
    const downloads = yield* Downloads;
    const message = (inboxId: string, messageId: string) =>
      visible(mailbox.getMessage(inboxId, messageId));
    return handlers
      .handle("inboxes_messages_list", ({ params, query }) =>
        respond(operations.listMessages(params.inbox_id, query)),
      )
      .handle("inboxes_messages_search", ({ params, query }) =>
        respond(operations.searchMessages(params.inbox_id, query)),
      )
      .handle("inboxes_messages_get", ({ params }) =>
        respond(operations.getMessage(params.inbox_id, params.message_id)),
      )
      .handle("inboxes_messages_update", ({ params, payload }) =>
        respond(operations.updateMessage(params.inbox_id, params.message_id, payload)),
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
      .handle("inboxes_messages_send", ({ params, payload, headers }) =>
        respond(
          operations.send(
            params.inbox_id,
            { kind: "send", request: payload },
            headers["idempotency-key"],
          ),
        ),
      )
      .handle("inboxes_messages_reply", ({ params, payload, headers }) =>
        respond(
          operations.send(
            params.inbox_id,
            { kind: "reply", message_id: params.message_id, request: payload },
            headers["idempotency-key"],
          ),
        ),
      )
      .handle("inboxes_messages_replyAll", ({ params, payload, headers }) =>
        respond(
          operations.send(
            params.inbox_id,
            { kind: "reply-all", message_id: params.message_id, request: payload },
            headers["idempotency-key"],
          ),
        ),
      )
      .handle("inboxes_messages_forward", ({ params, payload, headers }) =>
        respond(
          operations.send(
            params.inbox_id,
            { kind: "forward", message_id: params.message_id, request: payload },
            headers["idempotency-key"],
          ),
        ),
      );
  }),
);

const ThreadsLive = HttpApiBuilder.group(ServerApi, "threads", (handlers) =>
  Effect.gen(function* () {
    const operations = yield* AgentOperations;
    return handlers
      .handle("inboxes_threads_list", ({ params, query }) =>
        respond(operations.listThreads(params.inbox_id, query)),
      )
      .handle("inboxes_threads_search", ({ params, query }) =>
        respond(operations.searchThreads(params.inbox_id, query)),
      )
      .handle("inboxes_threads_get", ({ params, query }) =>
        respond(operations.getThread(params.inbox_id, params.thread_id, query)),
      )
      .handle("inboxes_threads_update", ({ params, payload }) =>
        respond(operations.updateThread(params.inbox_id, params.thread_id, payload)),
      )
      .handle("inboxes_threads_delete", ({ params }) =>
        respond(operations.deleteThread(params.inbox_id, params.thread_id)),
      )
      .handle("inboxes_threads_getAttachment", ({ params }) =>
        respond(operations.getAttachment(params.inbox_id, params.thread_id, params.attachment_id)),
      )
      .handle("threads_list", ({ query }) => respond(operations.listThreads(undefined, query)))
      .handle("threads_search", ({ query }) => respond(operations.searchThreads(undefined, query)))
      .handle("threads_get", ({ params, query }) =>
        respond(operations.getThread(undefined, params.thread_id, query)),
      )
      .handle("threads_update", ({ params, payload }) =>
        respond(operations.updateThread(undefined, params.thread_id, payload)),
      )
      .handle("threads_delete", ({ params }) =>
        respond(operations.deleteThread(undefined, params.thread_id)),
      )
      .handle("threads_getAttachment", ({ params }) =>
        respond(operations.getAttachment(undefined, params.thread_id, params.attachment_id)),
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
  Effect.gen(function* () {
    const operations = yield* AgentOperations;
    return handlers
      .handle("inboxes_drafts_list", ({ params, query }) =>
        respond(operations.listDrafts(params.inbox_id, query)),
      )
      .handle("inboxes_drafts_create", ({ params, payload }) =>
        respond(operations.createDraft(params.inbox_id, payload)),
      )
      .handle("inboxes_drafts_get", ({ params }) =>
        respond(operations.getDraft(params.inbox_id, params.draft_id)),
      )
      .handle("inboxes_drafts_update", ({ params, payload }) =>
        respond(operations.updateDraft(params.inbox_id, params.draft_id, payload)),
      )
      .handle("inboxes_drafts_delete", ({ params }) =>
        respond(operations.deleteDraft(params.inbox_id, params.draft_id)),
      )
      .handle("inboxes_drafts_getAttachment", ({ params }) =>
        respond(
          operations.getDraftAttachment(params.inbox_id, params.draft_id, params.attachment_id),
        ),
      )
      .handle("inboxes_drafts_send", ({ params, payload, headers }) =>
        respond(
          operations.sendDraft(
            params.inbox_id,
            params.draft_id,
            payload,
            headers["idempotency-key"],
          ),
        ),
      )
      .handle("inboxes_drafts_approve", ({ params, headers }) =>
        respond(
          operations.approveDraft(params.inbox_id, params.draft_id, headers["idempotency-key"]),
        ),
      )
      .handle("inboxes_drafts_reject", ({ params, payload }) =>
        respond(operations.rejectDraft(params.inbox_id, params.draft_id, payload.reason)),
      )
      .handle("drafts_list", ({ query }) => respond(operations.listDrafts(undefined, query)))
      .handle("drafts_get", ({ params }) =>
        respond(operations.getDraft(undefined, params.draft_id)),
      )
      .handle("drafts_getAttachment", ({ params }) =>
        respond(operations.getDraftAttachment(undefined, params.draft_id, params.attachment_id)),
      );
  }),
);

const ListsLive = HttpApiBuilder.group(ServerApi, "lists", (handlers) =>
  Effect.gen(function* () {
    const operations = yield* AgentOperations;
    return handlers
      .handle("inboxes_lists_list", ({ params, query }) =>
        respond(operations.listEntries(params.inbox_id, params.direction, params.type, query)),
      )
      .handle("inboxes_lists_create", ({ params, payload }) =>
        respond(
          operations.createListEntry(params.inbox_id, params.direction, params.type, payload),
        ),
      )
      .handle("inboxes_lists_get", ({ params }) =>
        respond(
          operations.getListEntry(params.inbox_id, params.direction, params.type, params.entry),
        ),
      )
      .handle("inboxes_lists_delete", ({ params }) =>
        respond(
          operations.deleteListEntry(params.inbox_id, params.direction, params.type, params.entry),
        ),
      )
      .handle("lists_list", ({ params, query }) =>
        respond(operations.listEntries(undefined, params.direction, params.type, query)),
      )
      .handle("lists_create", ({ params, payload }) =>
        respond(operations.createListEntry(undefined, params.direction, params.type, payload)),
      )
      .handle("lists_get", ({ params }) =>
        respond(operations.getListEntry(undefined, params.direction, params.type, params.entry)),
      )
      .handle("lists_delete", ({ params }) =>
        respond(operations.deleteListEntry(undefined, params.direction, params.type, params.entry)),
      );
  }),
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
  Effect.gen(function* () {
    const domains = yield* Provisioner;
    return handlers
      .handle("domains_list", ({ query }) => respond(domains.list(query)))
      .handle("domains_create", ({ payload }) => respond(domains.create(payload)))
      .handle("domains_get", ({ params }) => respond(domains.get(params.domain_id)))
      .handle("domains_update", ({ params, payload }) =>
        respond(domains.update(params.domain_id, payload)),
      )
      .handle("domains_delete", ({ params }) => respond(domains.delete(params.domain_id)))
      .handle("domains_getZoneFile", ({ params }) => respond(domains.zoneFile(params.domain_id)))
      .handle("domains_plan", ({ params }) =>
        respond(
          domains
            .get(params.domain_id)
            .pipe(Effect.flatMap((domain) => domains.plan(domain.domain))),
        ),
      )
      .handle("domains_verify", ({ params }) =>
        respond(domains.verify(params.domain_id).pipe(Effect.asVoid)),
      )
      .handle("domains_apply", ({ params }) => respond(domains.apply(params.domain_id)))
      .handle("domains_teardown", ({ params }) => respond(domains.teardown(params.domain_id)));
  }),
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
