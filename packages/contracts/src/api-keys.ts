import { Schema } from "effect";
import { ApiKeyId, InboxId, PageFields, Timestamp } from "./common.js";

export const Permissions = Schema.Struct({
  inbox_read: Schema.optionalKey(Schema.Boolean),
  inbox_create: Schema.optionalKey(Schema.Boolean),
  inbox_update: Schema.optionalKey(Schema.Boolean),
  inbox_delete: Schema.optionalKey(Schema.Boolean),
  message_read: Schema.optionalKey(Schema.Boolean),
  message_reply: Schema.optionalKey(Schema.Boolean),
  message_send: Schema.optionalKey(Schema.Boolean),
  message_update: Schema.optionalKey(Schema.Boolean),
  message_delete: Schema.optionalKey(Schema.Boolean),
  label_spam_read: Schema.optionalKey(Schema.Boolean),
  label_blocked_read: Schema.optionalKey(Schema.Boolean),
  label_unauthenticated_read: Schema.optionalKey(Schema.Boolean),
  label_trash_read: Schema.optionalKey(Schema.Boolean),
  draft_read: Schema.optionalKey(Schema.Boolean),
  draft_create: Schema.optionalKey(Schema.Boolean),
  draft_update: Schema.optionalKey(Schema.Boolean),
  draft_delete: Schema.optionalKey(Schema.Boolean),
  draft_send: Schema.optionalKey(Schema.Boolean),
  list_entry_read: Schema.optionalKey(Schema.Boolean),
  list_entry_create: Schema.optionalKey(Schema.Boolean),
  list_entry_delete: Schema.optionalKey(Schema.Boolean),
  webhook_read: Schema.optionalKey(Schema.Boolean),
  webhook_create: Schema.optionalKey(Schema.Boolean),
  webhook_update: Schema.optionalKey(Schema.Boolean),
  webhook_delete: Schema.optionalKey(Schema.Boolean),
  credential_read: Schema.optionalKey(Schema.Boolean),
  credential_create: Schema.optionalKey(Schema.Boolean),
  credential_update: Schema.optionalKey(Schema.Boolean),
  credential_delete: Schema.optionalKey(Schema.Boolean),
  credential_totp: Schema.optionalKey(Schema.Boolean),
  credential_fill: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "Permissions" });
export type Permissions = typeof Permissions.Type;
export type Permission = keyof Permissions;

export const SendPolicy = Schema.Literals(["direct", "approval", "read_only"]);
export type SendPolicy = typeof SendPolicy.Type;

export const Grant = Schema.Struct({
  inbox_id: Schema.optionalKey(InboxId),
  inbox_ids: Schema.optionalKey(Schema.Array(InboxId)),
  permissions: Permissions,
  send_policy: SendPolicy,
}).annotate({ identifier: "Grant" });
export type Grant = typeof Grant.Type;

export const ApiKey = Schema.Struct({
  ...Grant.fields,
  api_key_id: ApiKeyId,
  name: Schema.String,
  prefix: Schema.String,
  created_at: Timestamp,
  updated_at: Timestamp,
  expires_at: Schema.optionalKey(Timestamp),
  used_at: Schema.optionalKey(Timestamp),
}).annotate({ identifier: "ApiKey" });
export type ApiKey = typeof ApiKey.Type;

export const CreateApiKeyRequest = Schema.Struct({
  ...Grant.fields,
  name: Schema.optionalKey(Schema.String),
  expires_at: Schema.optionalKey(Timestamp),
}).annotate({ identifier: "CreateApiKeyRequest" });
export type CreateApiKeyRequest = typeof CreateApiKeyRequest.Type;

export const UpdateApiKeyRequest = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  permissions: Schema.optionalKey(Permissions),
  send_policy: Schema.optionalKey(SendPolicy),
})
  .check(Schema.isMinProperties(1))
  .annotate({ identifier: "UpdateApiKeyRequest" });
export type UpdateApiKeyRequest = typeof UpdateApiKeyRequest.Type;

export const CreateApiKeyResponse = Schema.Struct({
  ...ApiKey.fields,
  api_key: Schema.String,
}).annotate({ identifier: "CreateApiKeyResponse" });
export type CreateApiKeyResponse = typeof CreateApiKeyResponse.Type;

export const ListApiKeysResponse = Schema.Struct({
  ...PageFields,
  api_keys: Schema.Array(ApiKey),
}).annotate({ identifier: "ListApiKeysResponse" });
export type ListApiKeysResponse = typeof ListApiKeysResponse.Type;
