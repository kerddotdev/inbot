import type { HttpApiEndpoint } from "effect/http-api";
import { InboxesApi } from "../../../packages/contracts/src/api/inboxes.js";
import { ThreadsApi } from "../../../packages/contracts/src/api/threads.js";
import { MessagesApi } from "../../../packages/contracts/src/api/messages.js";
import { DraftsApi } from "../../../packages/contracts/src/api/drafts.js";
import { ApiKeysApi } from "../../../packages/contracts/src/api/api-keys.js";
import { OwnerApiGroup } from "../../../packages/contracts/src/api/owner.js";

export type Endpoint = Pick<HttpApiEndpoint.Top, "path" | "method" | "payload" | "success">;
export type FieldKind = "string" | "array" | "boolean" | "number" | "object";
export interface Command {
  readonly name: string;
  readonly description: string;
  readonly endpoint: Endpoint;
  readonly scopedEndpoint?: Endpoint;
  readonly params?: readonly string[];
  readonly body?: Readonly<Record<string, FieldKind>>;
  readonly query?: Readonly<Record<string, FieldKind>>;
  readonly idempotent?: boolean;
  readonly browser?: boolean;
  readonly secret?: boolean;
}
const pagination = { limit: "number", page_token: "string", ascending: "boolean" } as const;
const cursor = { limit: "number", page_token: "string" } as const;
const mailQuery = {
  ...pagination,
  before: "string",
  after: "string",
  labels: "array",
  include_spam: "boolean",
  include_blocked: "boolean",
  include_unauthenticated: "boolean",
  include_trash: "boolean",
  senders: "array",
  recipients: "array",
  subject: "array",
} as const;
const composition = {
  to: "array",
  cc: "array",
  bcc: "array",
  reply_to: "array",
  subject: "string",
  text: "string",
  html: "string",
  labels: "array",
} as const;
const labels = { add_labels: "array", remove_labels: "array" } as const;
const { subject: _subject, ...reply } = composition;
const inbox = ["inbox_id"];
const message = ["inbox_id", "message_id"];
const draft = ["inbox_id", "draft_id"];

export const commands: readonly Command[] = [
  {
    name: "open",
    description: "Print a single-use owner login link. Open it only with --browser.",
    endpoint: OwnerApiGroup.endpoints.owner_loginLink,
    browser: true,
  },
  {
    name: "inboxes list",
    description: "List accessible inboxes.",
    endpoint: InboxesApi.endpoints.inboxes_list,
    query: pagination,
  },
  {
    name: "inboxes create",
    description: "Create an inbox within the current grant.",
    endpoint: InboxesApi.endpoints.inboxes_create,
    body: {
      username: "string",
      domain: "string",
      display_name: "string",
      client_id: "string",
      status: "string",
      metadata: "object",
    },
  },
  {
    name: "inboxes get",
    description: "Get an inbox.",
    endpoint: InboxesApi.endpoints.inboxes_get,
    params: inbox,
  },
  {
    name: "inboxes delete",
    description: "Delete an inbox.",
    endpoint: InboxesApi.endpoints.inboxes_delete,
    params: inbox,
  },
  {
    name: "threads list",
    description: "List accessible threads, optionally within --inbox.",
    endpoint: ThreadsApi.endpoints.threads_list,
    scopedEndpoint: ThreadsApi.endpoints.inboxes_threads_list,
    query: mailQuery,
  },
  {
    name: "threads get",
    description: "Get a thread and its messages, optionally within --inbox.",
    endpoint: ThreadsApi.endpoints.threads_get,
    scopedEndpoint: ThreadsApi.endpoints.inboxes_threads_get,
    params: ["thread_id"],
    query: cursor,
  },
  {
    name: "messages get",
    description: "Read a message.",
    endpoint: MessagesApi.endpoints.inboxes_messages_get,
    params: message,
  },
  {
    name: "messages send",
    description: "Queue a message with an idempotency key.",
    endpoint: MessagesApi.endpoints.inboxes_messages_send,
    params: inbox,
    body: composition,
    idempotent: true,
  },
  {
    name: "messages reply",
    description: "Reply to a message; --reply-all includes other recipients.",
    endpoint: MessagesApi.endpoints.inboxes_messages_reply,
    params: message,
    body: { ...reply, reply_all: "boolean" },
    idempotent: true,
  },
  {
    name: "messages forward",
    description: "Forward a message.",
    endpoint: MessagesApi.endpoints.inboxes_messages_forward,
    params: message,
    body: composition,
    idempotent: true,
  },
  {
    name: "messages update",
    description: "Add or remove message labels.",
    endpoint: MessagesApi.endpoints.inboxes_messages_update,
    params: message,
    body: labels,
  },
  {
    name: "drafts list",
    description: "List drafts, optionally within --inbox.",
    endpoint: DraftsApi.endpoints.drafts_list,
    scopedEndpoint: DraftsApi.endpoints.inboxes_drafts_list,
    query: { ...pagination, before: "string", after: "string", labels: "array" },
  },
  {
    name: "drafts create",
    description: "Create an incomplete, reply, or forward draft.",
    endpoint: DraftsApi.endpoints.inboxes_drafts_create,
    params: inbox,
    body: {
      ...composition,
      in_reply_to: "string",
      forward_of: "string",
      reply_all: "boolean",
      send_at: "string",
      client_id: "string",
    },
  },
  {
    name: "drafts get",
    description: "Get a draft, optionally within --inbox.",
    endpoint: DraftsApi.endpoints.drafts_get,
    scopedEndpoint: DraftsApi.endpoints.inboxes_drafts_get,
    params: ["draft_id"],
  },
  {
    name: "drafts update",
    description: "Update a draft. Use --data for nulls or attachment changes.",
    endpoint: DraftsApi.endpoints.inboxes_drafts_update,
    params: draft,
    body: {
      to: "array",
      cc: "array",
      bcc: "array",
      reply_to: "array",
      subject: "string",
      text: "string",
      html: "string",
      send_at: "string",
      ...labels,
    },
  },
  {
    name: "drafts delete",
    description: "Delete a draft.",
    endpoint: DraftsApi.endpoints.inboxes_drafts_delete,
    params: draft,
  },
  {
    name: "drafts send",
    description: "Send a draft now, overriding its schedule.",
    endpoint: DraftsApi.endpoints.inboxes_drafts_send,
    params: draft,
    body: labels,
    idempotent: true,
  },
  {
    name: "drafts approve",
    description: "Approve a draft as owner; scheduled drafts remain scheduled.",
    endpoint: DraftsApi.endpoints.inboxes_drafts_approve,
    params: draft,
    idempotent: true,
  },
  {
    name: "drafts reject",
    description: "Reject a draft as owner.",
    endpoint: DraftsApi.endpoints.inboxes_drafts_reject,
    params: draft,
    body: { reason: "string" },
  },
  {
    name: "api-keys list",
    description: "List API key metadata as owner.",
    endpoint: ApiKeysApi.endpoints.apiKeys_list,
    scopedEndpoint: ApiKeysApi.endpoints.inboxes_apiKeys_list,
    query: cursor,
  },
  {
    name: "api-keys create",
    description: "Create a scoped API key as owner. --show-secret prints its one-time secret.",
    endpoint: ApiKeysApi.endpoints.apiKeys_create,
    scopedEndpoint: ApiKeysApi.endpoints.inboxes_apiKeys_create,
    secret: true,
    body: {
      name: "string",
      inbox_id: "string",
      inbox_ids: "array",
      permissions: "object",
      send_policy: "string",
      expires_at: "string",
    },
  },
  {
    name: "api-keys revoke",
    description: "Revoke an API key as owner.",
    endpoint: ApiKeysApi.endpoints.apiKeys_delete,
    scopedEndpoint: ApiKeysApi.endpoints.inboxes_apiKeys_delete,
    params: ["api_key_id"],
  },
];

export const flagName = (field: string) => field.replaceAll("_", "-");
