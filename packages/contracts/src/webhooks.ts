import { Schema } from "effect";
import { PageFields, Timestamp, WebhookId } from "./common.js";
import { EventType } from "./event-types.js";

export const Webhook = Schema.Struct({
  webhook_id: WebhookId,
  url: Schema.String,
  event_types: Schema.optionalKey(Schema.Array(EventType)),
  pod_ids: Schema.optionalKey(Schema.Array(Schema.String)),
  inbox_ids: Schema.optionalKey(Schema.Array(Schema.String)),
  pod_id: Schema.optionalKey(Schema.String),
  inbox_id: Schema.optionalKey(Schema.String),
  secret: Schema.optionalKey(Schema.String),
  failure_count: Schema.optionalKey(Schema.Int),
  disabled_reason: Schema.optionalKey(Schema.String),
  last_success_at: Schema.optionalKey(Timestamp),
  last_error_code: Schema.optionalKey(Schema.String),
  enabled: Schema.Boolean,
  updated_at: Timestamp,
  created_at: Timestamp,
  client_id: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Webhook" });
export type Webhook = typeof Webhook.Type;

export const ListWebhooksResponse = Schema.Struct({
  ...PageFields,
  webhooks: Schema.Array(Webhook),
}).annotate({ identifier: "ListWebhooksResponse" });
export type ListWebhooksResponse = typeof ListWebhooksResponse.Type;

export const WebhookHeaderNamesResponse = Schema.Struct({
  header_names: Schema.Array(Schema.String),
}).annotate({ identifier: "WebhookHeaderNamesResponse" });
export type WebhookHeaderNamesResponse = typeof WebhookHeaderNamesResponse.Type;

export const WebhookHeaders = Schema.Record(Schema.String, Schema.String)
  .check(Schema.isMinProperties(1))
  .annotate({ identifier: "WebhookHeaders" });
export type WebhookHeaders = typeof WebhookHeaders.Type;

export const CreateInboxWebhookRequest = Schema.Struct({
  url: Schema.String,
  event_types: Schema.Array(EventType),
  client_id: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(WebhookHeaders),
}).annotate({ identifier: "CreateInboxWebhookRequest" });
export type CreateInboxWebhookRequest = typeof CreateInboxWebhookRequest.Type;

export const UpdateInboxWebhookRequest = Schema.Struct({
  event_types: Schema.optionalKey(Schema.Array(EventType)),
  enabled: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "UpdateInboxWebhookRequest" });
export type UpdateInboxWebhookRequest = typeof UpdateInboxWebhookRequest.Type;

export const UpdateWebhookHeadersRequest = Schema.Struct({
  headers: Schema.optionalKey(WebhookHeaders),
  remove_headers: Schema.optionalKey(Schema.Array(Schema.String)),
}).annotate({ identifier: "UpdateWebhookHeadersRequest" });
export type UpdateWebhookHeadersRequest = typeof UpdateWebhookHeadersRequest.Type;

export const CreateWebhookRequest = Schema.Struct({
  url: Schema.String,
  event_types: Schema.Array(EventType),
  client_id: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(WebhookHeaders),
  inbox_ids: Schema.optionalKey(Schema.Array(Schema.String)),
  pod_ids: Schema.optionalKey(Schema.Array(Schema.String)),
}).annotate({ identifier: "CreateWebhookRequest" });
export type CreateWebhookRequest = typeof CreateWebhookRequest.Type;

export const UpdateWebhookRequest = Schema.Struct({
  event_types: Schema.optionalKey(Schema.Array(EventType)),
  enabled: Schema.optionalKey(Schema.Boolean),
  add_inbox_ids: Schema.optionalKey(Schema.Array(Schema.String)),
  remove_inbox_ids: Schema.optionalKey(Schema.Array(Schema.String)),
  add_pod_ids: Schema.optionalKey(Schema.Array(Schema.String)),
  remove_pod_ids: Schema.optionalKey(Schema.Array(Schema.String)),
}).annotate({ identifier: "UpdateWebhookRequest" });
export type UpdateWebhookRequest = typeof UpdateWebhookRequest.Type;
