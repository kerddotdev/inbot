import { credentialUseCommands } from "./credential-use-commands.js";
import { credentialRequestCommands } from "./credential-request-commands.js";
import { quarantineCommands } from "./quarantine-commands.js";
import type { HttpApiEndpoint } from "effect/http-api";
import { WebhooksApi } from "../../../packages/contracts/src/api/webhooks.js";
import { CredentialsApi } from "../../../packages/contracts/src/api/vault.js";
import { InboxesApi } from "../../../packages/contracts/src/api/inboxes.js";
import { ThreadsApi } from "../../../packages/contracts/src/api/threads.js";
import { MessagesApi } from "../../../packages/contracts/src/api/messages.js";
import { DraftsApi } from "../../../packages/contracts/src/api/drafts.js";
import { OAuthOwnerApi } from "../../../packages/contracts/src/api/oauth.js";
import { ApiKeysApi } from "../../../packages/contracts/src/api/api-keys.js";
import { RemoteApiGroup } from "../../../packages/contracts/src/api/remote.js";
import { OwnerApiGroup } from "../../../packages/contracts/src/api/owner.js";
import { DomainsApi } from "../../../packages/contracts/src/api/domains.js";
import { ListsApi } from "../../../packages/contracts/src/api/lists.js";

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
  readonly idempotent?: boolean | "manual";
  readonly browser?: boolean;
  readonly secret?: boolean;
  readonly download?: boolean;
  readonly response?: "text";
  readonly tokenInput?: boolean;
  readonly generateField?: boolean;
  readonly fieldsInput?: boolean;
  readonly bitwarden?: "export" | "import";
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
const cursorSearch = { ...cursor, q: "string" } as const;
const search = { ...cursor, q: "string", before: "string", after: "string" } as const;
const messageQuery = {
  ...pagination,
  before: "string",
  after: "string",
  labels: "array",
  include_spam: "boolean",
  include_blocked: "boolean",
  include_unauthenticated: "boolean",
  include_trash: "boolean",
  from: "array",
  to: "array",
  subject: "array",
} as const;
const domainOptions = {
  feedback_enabled: "boolean",
  inbound_enabled: "boolean",
  subdomains_enabled: "boolean",
  tracking_enabled: "boolean",
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
const credential = ["inbox_id", "credential_id"];
const credentialTarget = {
  cdp_endpoint: "string",
  url: "string",
  target_id: "string",
  selector: "string",
  field: "string",
} as const;
const credentialBody = {
  name: "string",
  url: "string",
  origins: "array",
  username: "string",
  fields: "object",
  generate: "object",
} as const;

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
    name: "inboxes search",
    description: "Search accessible inboxes with --q.",
    endpoint: InboxesApi.endpoints.inboxes_search,
    query: cursorSearch,
  },
  {
    name: "inboxes get",
    description: "Get an inbox.",
    endpoint: InboxesApi.endpoints.inboxes_get,
    params: inbox,
  },
  {
    name: "inboxes update",
    description:
      "Update display name, active/paused status, or metadata; use JSON to clear metadata.",
    endpoint: InboxesApi.endpoints.inboxes_update,
    params: inbox,
    body: { display_name: "string", status: "string", metadata: "object" },
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
    name: "threads search",
    description: "Search accessible threads with --q, optionally within --inbox.",
    endpoint: ThreadsApi.endpoints.threads_search,
    scopedEndpoint: ThreadsApi.endpoints.inboxes_threads_search,
    query: search,
  },
  {
    name: "threads update",
    description: "Add or remove thread labels, optionally within --inbox.",
    endpoint: ThreadsApi.endpoints.threads_update,
    scopedEndpoint: ThreadsApi.endpoints.inboxes_threads_update,
    params: ["thread_id"],
    body: labels,
  },
  {
    name: "threads delete",
    description: "Delete a thread and its messages, optionally within --inbox.",
    endpoint: ThreadsApi.endpoints.threads_delete,
    scopedEndpoint: ThreadsApi.endpoints.inboxes_threads_delete,
    params: ["thread_id"],
  },
  {
    name: "threads attachment",
    description: "Download a thread attachment; use -o <path> or redirected stdout.",
    endpoint: ThreadsApi.endpoints.threads_getAttachment,
    scopedEndpoint: ThreadsApi.endpoints.inboxes_threads_getAttachment,
    params: ["thread_id", "attachment_id"],
    download: true,
  },
  {
    name: "messages list",
    description: "List messages within an inbox, with pagination and mail filters.",
    endpoint: MessagesApi.endpoints.inboxes_messages_list,
    params: inbox,
    query: messageQuery,
  },
  {
    name: "messages search",
    description: "Search inbox messages with --q.",
    endpoint: MessagesApi.endpoints.inboxes_messages_search,
    params: inbox,
    query: search,
  },
  {
    name: "messages get",
    description:
      "Read a message, including send_status and send_reason. On send_unknown, do not resend; inform the human.",
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
    name: "messages resolve",
    description:
      "Resolve send_unknown as owner with --decision sent|failed. Confirm sent or not sent first; this never resends.",
    endpoint: MessagesApi.endpoints.inboxes_messages_resolve,
    params: message,
    body: { decision: "string" },
  },
  {
    name: "messages delete",
    description: "Delete a message.",
    endpoint: MessagesApi.endpoints.inboxes_messages_delete,
    params: message,
  },
  {
    name: "messages batch-get",
    description: "Read up to 500 unique message IDs.",
    endpoint: MessagesApi.endpoints.inboxes_messages_batchGet,
    params: inbox,
    body: { message_ids: "array" },
  },
  {
    name: "messages batch-update",
    description: "Update labels on up to 50 unique message IDs.",
    endpoint: MessagesApi.endpoints.inboxes_messages_batchUpdate,
    params: inbox,
    body: { message_ids: "array", ...labels },
  },
  {
    name: "messages attachment",
    description: "Download a message attachment; use -o <path> or redirected stdout.",
    endpoint: MessagesApi.endpoints.inboxes_messages_getAttachment,
    params: [...message, "attachment_id"],
    download: true,
  },
  {
    name: "messages raw",
    description: "Download the original MIME message; use -o <path> or redirected stdout.",
    endpoint: MessagesApi.endpoints.inboxes_messages_getRaw,
    params: message,
    download: true,
  },
  {
    name: "messages reply-all",
    description: "Reply to all original recipients with an idempotency key.",
    endpoint: MessagesApi.endpoints.inboxes_messages_replyAll,
    params: message,
    body: { reply_to: "array", text: "string", html: "string", labels: "array" },
    idempotent: true,
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
    name: "drafts attachment",
    description: "Download a draft attachment, optionally within --inbox.",
    endpoint: DraftsApi.endpoints.drafts_getAttachment,
    scopedEndpoint: DraftsApi.endpoints.inboxes_drafts_getAttachment,
    params: ["draft_id", "attachment_id"],
    download: true,
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
    query: { ...pagination, type: "string" },
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
      use_policy: "string",
    },
  },
  {
    name: "api-keys get",
    description: "Read API key metadata as owner; never returns the secret.",
    endpoint: ApiKeysApi.endpoints.apiKeys_get,
    params: ["api_key_id"],
  },
  {
    name: "api-keys update",
    description:
      "Update an API key's name, permissions, send policy, or credential use policy as owner.",
    endpoint: ApiKeysApi.endpoints.apiKeys_update,
    scopedEndpoint: ApiKeysApi.endpoints.inboxes_apiKeys_update,
    params: ["api_key_id"],
    body: { name: "string", permissions: "object", send_policy: "string", use_policy: "string" },
  },
  {
    name: "api-keys revoke",
    description: "Revoke an API key as owner.",
    endpoint: ApiKeysApi.endpoints.apiKeys_delete,
    scopedEndpoint: ApiKeysApi.endpoints.inboxes_apiKeys_delete,
    params: ["api_key_id"],
  },
  {
    name: "lists list",
    description: "List allow/block entries for receive, send, or reply; --inbox selects an inbox.",
    endpoint: ListsApi.endpoints.lists_list,
    scopedEndpoint: ListsApi.endpoints.inboxes_lists_list,
    params: ["direction", "type"],
    query: cursor,
  },
  {
    name: "lists create",
    description: "Add one exact address or domain; blocks win over allows.",
    endpoint: ListsApi.endpoints.lists_create,
    scopedEndpoint: ListsApi.endpoints.inboxes_lists_create,
    params: ["direction", "type"],
    body: { entry: "string", reason: "string" },
  },
  {
    name: "lists get",
    description: "Read one allow/block entry, optionally within --inbox.",
    endpoint: ListsApi.endpoints.lists_get,
    scopedEndpoint: ListsApi.endpoints.inboxes_lists_get,
    params: ["direction", "type", "entry"],
  },
  {
    name: "lists delete",
    description: "Remove an entry, optionally within --inbox.",
    endpoint: ListsApi.endpoints.lists_delete,
    scopedEndpoint: ListsApi.endpoints.inboxes_lists_delete,
    params: ["direction", "type", "entry"],
  },
  {
    name: "lists rejections",
    description: "List rejected inbound metadata as owner, optionally filtered by --inbox-id.",
    endpoint: OwnerApiGroup.endpoints.owner_listRejections,
    query: { ...cursor, inbox_id: "string" },
  },
  {
    name: "lists delete-rejection",
    description: "Delete rejected inbound metadata as owner; this does not accept the mail.",
    endpoint: OwnerApiGroup.endpoints.owner_deleteRejection,
    params: ["rejection_id"],
  },
  {
    name: "webhooks list",
    description: "List webhook metadata, optionally within --inbox.",
    endpoint: WebhooksApi.endpoints.webhooks_list,
    scopedEndpoint: WebhooksApi.endpoints.inboxes_webhooks_list,
    query: pagination,
  },
  {
    name: "webhooks create",
    description: "Create a webhook. --show-secret prints its one-time signing secret.",
    endpoint: WebhooksApi.endpoints.webhooks_create,
    scopedEndpoint: WebhooksApi.endpoints.inboxes_webhooks_create,
    secret: true,
    body: {
      url: "string",
      event_types: "array",
      inbox_ids: "array",
      client_id: "string",
      headers: "object",
    },
  },
  {
    name: "webhooks get",
    description: "Get webhook metadata.",
    endpoint: WebhooksApi.endpoints.webhooks_get,
    scopedEndpoint: WebhooksApi.endpoints.inboxes_webhooks_get,
    params: ["webhook_id"],
  },
  {
    name: "webhooks update",
    description: "Update event filters, enabled state, or inbox filters.",
    endpoint: WebhooksApi.endpoints.webhooks_update,
    scopedEndpoint: WebhooksApi.endpoints.inboxes_webhooks_update,
    params: ["webhook_id"],
    body: {
      event_types: "array",
      enabled: "boolean",
      add_inbox_ids: "array",
      remove_inbox_ids: "array",
    },
  },
  {
    name: "webhooks delete",
    description: "Delete a webhook and its pending deliveries.",
    endpoint: WebhooksApi.endpoints.webhooks_delete,
    scopedEndpoint: WebhooksApi.endpoints.inboxes_webhooks_delete,
    params: ["webhook_id"],
  },
  {
    name: "webhooks headers",
    description: "List custom header names without their values.",
    endpoint: WebhooksApi.endpoints.webhooks_getHeaders,
    scopedEndpoint: WebhooksApi.endpoints.inboxes_webhooks_getHeaders,
    params: ["webhook_id"],
  },
  {
    name: "webhooks update-headers",
    description: "Set or remove custom headers.",
    endpoint: WebhooksApi.endpoints.webhooks_updateHeaders,
    scopedEndpoint: WebhooksApi.endpoints.inboxes_webhooks_updateHeaders,
    params: ["webhook_id"],
    body: { headers: "object", remove_headers: "array" },
  },
  {
    name: "credentials list",
    description: "List credential metadata and refs, optionally within --inbox.",
    endpoint: CredentialsApi.endpoints.credentials_list,
    scopedEndpoint: CredentialsApi.endpoints.inboxes_credentials_list,
    query: { ...pagination, q: "string", inbox_id: "string" },
  },
  {
    name: "credentials get",
    description: "Read credential metadata and refs without secret values.",
    endpoint: CredentialsApi.endpoints.inboxes_credentials_get,
    params: credential,
  },
  {
    name: "credentials create",
    description:
      "Store credentials. --generate creates a password server-side and keeps it out of shell history; --rules sets Apple passwordrules.",
    endpoint: CredentialsApi.endpoints.inboxes_credentials_create,
    params: inbox,
    body: credentialBody,
    generateField: true,
  },
  {
    name: "credentials update",
    description:
      "Update metadata or fields; --generate replaces a password without returning its value.",
    endpoint: CredentialsApi.endpoints.inboxes_credentials_update,
    params: credential,
    body: { ...credentialBody, remove_fields: "array" },
    generateField: true,
  },
  {
    name: "credentials delete",
    description: "Delete a credential and all its secret fields.",
    endpoint: CredentialsApi.endpoints.inboxes_credentials_delete,
    params: credential,
  },
  {
    name: "credentials generate",
    description:
      "Generate a password into an existing credential field; returns metadata and a stable ref.",
    endpoint: CredentialsApi.endpoints.inboxes_credentials_generate,
    params: credential,
    body: { field: "string", mode: "string", length: "number", rules: "string" },
  },
  {
    name: "credentials fill",
    description:
      "Type a vault field directly into a matching-origin browser page. The totp field types the current code. Approval grants need --idempotency-key; retry unchanged after owner approval. Requires credential_fill.",
    endpoint: CredentialsApi.endpoints.inboxes_credentials_fill,
    idempotent: "manual",
    params: credential,
    body: credentialTarget,
  },
  {
    name: "credentials capture",
    description:
      "Capture a matching-origin browser field into the vault; returns refs only. Requires credential_fill.",
    endpoint: CredentialsApi.endpoints.inboxes_credentials_capture,
    params: credential,
    body: credentialTarget,
  },
  {
    name: "credentials totp",
    description: "Get a temporary TOTP code and expiry without revealing its seed.",
    endpoint: CredentialsApi.endpoints.inboxes_credentials_totp,
    params: credential,
  },
  {
    name: "credentials reveal",
    description:
      "Reveal stored secret fields as local owner. Agent keys and tunnel access are rejected.",
    endpoint: CredentialsApi.endpoints.inboxes_credentials_reveal,
    params: credential,
  },
  {
    name: "vault settings show",
    description: "Inspect remote CDP host settings as local owner.",
    endpoint: CredentialsApi.endpoints.owner_vault_settings,
  },
  {
    name: "vault settings set",
    description:
      "Replace remote CDP hosts as local owner. Use --data '{\"remote_cdp_hosts\":[]}' to disable remote fill and capture.",
    endpoint: CredentialsApi.endpoints.owner_vault_setSettings,
    body: { remote_cdp_hosts: "array" },
  },
  {
    name: "domains list",
    description: "List domains as owner.",
    endpoint: DomainsApi.endpoints.domains_list,
    query: pagination,
  },
  {
    name: "domains create",
    description: "Register a domain as owner; apply its plan separately.",
    endpoint: DomainsApi.endpoints.domains_create,
    body: { domain: "string", allow_conflicting_provider: "boolean", ...domainOptions },
  },
  {
    name: "domains get",
    description: "Inspect domain state and DNS records as owner.",
    endpoint: DomainsApi.endpoints.domains_get,
    params: ["domain_id"],
  },
  {
    name: "domains update",
    description: "Update supported domain options as owner.",
    endpoint: DomainsApi.endpoints.domains_update,
    params: ["domain_id"],
    body: domainOptions,
  },
  {
    name: "domains delete",
    description: "Delete a domain after teardown as owner.",
    endpoint: DomainsApi.endpoints.domains_delete,
    params: ["domain_id"],
  },
  {
    name: "domains zone-file",
    description: "Print domain DNS records as a text zone file.",
    endpoint: DomainsApi.endpoints.domains_getZoneFile,
    params: ["domain_id"],
    response: "text",
  },
  {
    name: "domains plan",
    description: "Inspect the provisioning plan before applying it as owner.",
    endpoint: DomainsApi.endpoints.domains_plan,
    params: ["domain_id"],
  },
  {
    name: "domains verify",
    description: "Check domain DNS and provider verification as owner.",
    endpoint: DomainsApi.endpoints.domains_verify,
    params: ["domain_id"],
  },
  {
    name: "domains apply",
    description: "Provision the registered domain using its plan as owner.",
    endpoint: DomainsApi.endpoints.domains_apply,
    params: ["domain_id"],
  },
  {
    name: "domains teardown",
    description: "Remove recorded provider resources as owner.",
    endpoint: DomainsApi.endpoints.domains_teardown,
    params: ["domain_id"],
  },
  {
    name: "transport status",
    description: "Inspect transport and token verification metadata as local owner.",
    endpoint: OwnerApiGroup.endpoints.owner_transport,
  },
  {
    name: "transport configure",
    description:
      "Verify and save transport credentials from INBOT_CLOUDFLARE_API_TOKEN or --token-stdin.",
    endpoint: OwnerApiGroup.endpoints.owner_setTransport,
    body: { account_id: "string" },
    tokenInput: true,
  },
  {
    name: "transport clear",
    description: "Clear transport credentials after tearing down provisioned resources as owner.",
    endpoint: OwnerApiGroup.endpoints.owner_clearTransport,
  },
  {
    name: "oauth clients",
    description: "List authorized OAuth clients and grants as owner.",
    endpoint: OAuthOwnerApi.endpoints.oauth_clients,
  },
  {
    name: "oauth revoke",
    description: "Revoke an OAuth grant and every token as owner.",
    endpoint: OAuthOwnerApi.endpoints.oauth_revokeGrant,
    params: ["grant_id"],
  },
  {
    name: "oauth purge",
    description: "Purge unused OAuth client registrations as owner.",
    endpoint: OAuthOwnerApi.endpoints.oauth_purge,
  },
  {
    name: "remote status",
    description: "Inspect optional remote access (owner, local URL).",
    endpoint: RemoteApiGroup.endpoints.remote_status,
  },
  {
    name: "remote enable",
    description: "Download the verified connector and provision remote access (owner, local URL).",
    endpoint: RemoteApiGroup.endpoints.remote_enable,
    body: { hostname: "string" },
  },
  {
    name: "remote disable",
    description: "Stop the connector and remove its recorded DNS and tunnel (owner, local URL).",
    endpoint: RemoteApiGroup.endpoints.remote_disable,
  },
  ...quarantineCommands,
  ...credentialUseCommands,
  ...credentialRequestCommands,
  {
    name: "credentials export",
    description:
      "Export unencrypted Bitwarden JSON as local owner. Requires -o <file> or explicit -o -; --force replaces a file.",
    endpoint: CredentialsApi.endpoints.credentials_export,
    bitwarden: "export",
  },
  {
    name: "credentials import",
    description:
      "Import a Bitwarden JSON file as local owner into --inbox. Duplicates are skipped unless --on-duplicate create is given.",
    endpoint: CredentialsApi.endpoints.credentials_import,
    query: { on_duplicate: "string" },
    bitwarden: "import",
  },
];

export const flagName = (field: string) => field.replaceAll("_", "-");
