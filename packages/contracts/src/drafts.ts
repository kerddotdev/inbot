import { Schema } from "effect";
import { Attachment, SendAttachment } from "./attachments.js";
import {
  DraftId,
  InboxId,
  Labels,
  PageFields,
  PaginationQuery,
  TimeFilterFields,
  Timestamp,
} from "./common.js";
import { UpdateMessageRequest } from "./messages.js";

export const ListDraftsQuery = Schema.Struct({
  ...PaginationQuery.fields,
  ...TimeFilterFields,
  labels: Schema.optionalKey(Labels),
});

export const SendDraftRequest = UpdateMessageRequest.annotate({ identifier: "SendDraftRequest" });
export type SendDraftRequest = typeof SendDraftRequest.Type;

export const DraftSendStatus = Schema.Literals(["scheduled", "sending", "failed"]).annotate({
  identifier: "DraftSendStatus",
});
export type DraftSendStatus = typeof DraftSendStatus.Type;

export const DraftItem = Schema.Struct({
  inbox_id: InboxId,
  draft_id: DraftId,
  labels: Schema.Array(Schema.String),
  to: Schema.optionalKey(Schema.Array(Schema.String)),
  cc: Schema.optionalKey(Schema.Array(Schema.String)),
  bcc: Schema.optionalKey(Schema.Array(Schema.String)),
  subject: Schema.optionalKey(Schema.String),
  preview: Schema.optionalKey(Schema.String),
  attachments: Schema.optionalKey(Schema.Array(Attachment)),
  in_reply_to: Schema.optionalKey(Schema.String),
  forward_of: Schema.optionalKey(Schema.String),
  send_status: Schema.optionalKey(DraftSendStatus),
  send_at: Schema.optionalKey(Timestamp),
  updated_at: Timestamp,
  pending_approval: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "DraftItem" });
export type DraftItem = typeof DraftItem.Type;

export const ListDraftsResponse = Schema.Struct({
  ...PageFields,
  drafts: Schema.Array(DraftItem),
}).annotate({ identifier: "ListDraftsResponse" });
export type ListDraftsResponse = typeof ListDraftsResponse.Type;

export const Draft = Schema.Struct({
  ...DraftItem.fields,
  client_id: Schema.optionalKey(Schema.String),
  reply_to: Schema.optionalKey(Schema.Array(Schema.String)),
  text: Schema.optionalKey(Schema.String),
  html: Schema.optionalKey(Schema.String),
  references: Schema.optionalKey(Schema.Array(Schema.String)),
  created_at: Timestamp,
}).annotate({ identifier: "Draft" });
export type Draft = typeof Draft.Type;

export const CreateDraftRequest = Schema.Struct({
  labels: Schema.optionalKey(Schema.Array(Schema.String)),
  reply_to: Schema.optionalKey(Schema.Array(Schema.String)),
  to: Schema.optionalKey(Schema.Array(Schema.String)),
  cc: Schema.optionalKey(Schema.Array(Schema.String)),
  bcc: Schema.optionalKey(Schema.Array(Schema.String)),
  subject: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  html: Schema.optionalKey(Schema.String),
  attachments: Schema.optionalKey(Schema.Array(SendAttachment)),
  in_reply_to: Schema.optionalKey(Schema.String),
  forward_of: Schema.optionalKey(Schema.String),
  reply_all: Schema.optionalKey(Schema.Boolean),
  send_at: Schema.optionalKey(Timestamp),
  client_id: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "CreateDraftRequest" });
export type CreateDraftRequest = typeof CreateDraftRequest.Type;

export const UpdateDraftRequest = Schema.Struct({
  reply_to: Schema.optionalKey(Schema.Union([Schema.Array(Schema.String), Schema.Null])),
  to: Schema.optionalKey(Schema.Union([Schema.Array(Schema.String), Schema.Null])),
  cc: Schema.optionalKey(Schema.Union([Schema.Array(Schema.String), Schema.Null])),
  bcc: Schema.optionalKey(Schema.Union([Schema.Array(Schema.String), Schema.Null])),
  subject: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  text: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  html: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  add_attachments: Schema.optionalKey(Schema.Array(SendAttachment)),
  remove_attachments: Schema.optionalKey(Schema.Array(Schema.String)),
  add_labels: Schema.optionalKey(Schema.Array(Schema.String)),
  remove_labels: Schema.optionalKey(Schema.Array(Schema.String)),
  send_at: Schema.optionalKey(Schema.Union([Timestamp, Schema.Null])),
}).annotate({ identifier: "UpdateDraftRequest" });
export type UpdateDraftRequest = typeof UpdateDraftRequest.Type;
