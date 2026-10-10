import { Schema } from "effect";
import { Attachment, SendAttachment } from "./attachments.js";
import {
  Count,
  InboxId,
  Limit,
  MailQueryFields,
  MessageId,
  PageFields,
  ThreadId,
  Timestamp,
} from "./common.js";

export const ListMessagesQuery = Schema.Struct({
  ...MailQueryFields,
  from: Schema.optionalKey(Schema.Array(Schema.String)),
  to: Schema.optionalKey(Schema.Array(Schema.String)),
  subject: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const Addresses = Schema.Union([Schema.String, Schema.Array(Schema.String)]).annotate({
  identifier: "Addresses",
});
export type Addresses = typeof Addresses.Type;

export const SendStatus = Schema.Literals(["queued", "sending", "sent", "failed", "send_unknown"]);
export type SendStatus = typeof SendStatus.Type;

export const ResolveMessageRequest = Schema.Struct({
  decision: Schema.Literals(["sent", "failed"]),
});
export type ResolveMessageRequest = typeof ResolveMessageRequest.Type;

export const MessageItem = Schema.Struct({
  inbox_id: InboxId,
  thread_id: ThreadId,
  message_id: MessageId,
  labels: Schema.Array(Schema.String),
  send_status: Schema.optionalKey(SendStatus),
  send_reason: Schema.optionalKey(Schema.String),
  timestamp: Timestamp,
  from: Schema.String,
  to: Schema.Array(Schema.String),
  cc: Schema.optionalKey(Schema.Array(Schema.String)),
  bcc: Schema.optionalKey(Schema.Array(Schema.String)),
  subject: Schema.optionalKey(Schema.String),
  preview: Schema.optionalKey(Schema.String),
  attachments: Schema.optionalKey(Schema.Array(Attachment)),
  in_reply_to: Schema.optionalKey(Schema.String),
  calendar_event_id: Schema.optionalKey(Schema.String),
  references: Schema.optionalKey(Schema.Array(Schema.String)),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  size: Schema.Int,
  updated_at: Timestamp,
  created_at: Timestamp,
}).annotate({ identifier: "MessageItem" });
export type MessageItem = typeof MessageItem.Type;

export const Message = Schema.Struct({
  ...MessageItem.fields,
  reply_to: Schema.optionalKey(Schema.Array(Schema.String)),
  text: Schema.optionalKey(Schema.String),
  html: Schema.optionalKey(Schema.String),
  extracted_text: Schema.optionalKey(Schema.String),
  extracted_html: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Message" });
export type Message = typeof Message.Type;

export const ListMessagesResponse = Schema.Struct({
  ...PageFields,
  messages: Schema.Array(MessageItem),
}).annotate({ identifier: "ListMessagesResponse" });
export type ListMessagesResponse = typeof ListMessagesResponse.Type;

export const SearchMessageHighlights = Schema.Struct({
  from: Schema.optionalKey(Schema.Array(Schema.String)),
  recipients: Schema.optionalKey(Schema.Array(Schema.String)),
  subject: Schema.optionalKey(Schema.Array(Schema.String)),
  text: Schema.optionalKey(Schema.Array(Schema.String)),
}).annotate({ identifier: "SearchMessageHighlights" });
export type SearchMessageHighlights = typeof SearchMessageHighlights.Type;

export const SearchMessageItem = Schema.Struct({
  ...MessageItem.fields,
  highlights: Schema.optionalKey(SearchMessageHighlights),
}).annotate({ identifier: "SearchMessageItem" });
export type SearchMessageItem = typeof SearchMessageItem.Type;

export const SearchMessagesResponse = Schema.Struct({
  ...PageFields,
  messages: Schema.Array(SearchMessageItem),
}).annotate({ identifier: "SearchMessagesResponse" });
export type SearchMessagesResponse = typeof SearchMessagesResponse.Type;

export const BatchGetMessagesRequest = Schema.Struct({
  message_ids: Schema.Array(MessageId).check(
    Schema.isMaxLength(500),
    Schema.makeFilter((ids) => new Set(ids).size === ids.length, {
      toJsonSchema: () => ({ uniqueItems: true }),
    }),
  ),
}).annotate({ identifier: "BatchGetMessagesRequest" });
export type BatchGetMessagesRequest = typeof BatchGetMessagesRequest.Type;

export const BatchGetMessagesResponse = Schema.Struct({
  limit: Limit,
  count: Count,
  messages: Schema.Array(Message),
}).annotate({ identifier: "BatchGetMessagesResponse" });
export type BatchGetMessagesResponse = typeof BatchGetMessagesResponse.Type;

export const UpdateMessageLabels = Schema.Union([
  Schema.String,
  Schema.Array(Schema.String),
]).annotate({ identifier: "UpdateMessageLabels" });
export type UpdateMessageLabels = typeof UpdateMessageLabels.Type;

export const UpdateMessageRequest = Schema.Struct({
  add_labels: Schema.optionalKey(UpdateMessageLabels),
  remove_labels: Schema.optionalKey(UpdateMessageLabels),
}).annotate({ identifier: "UpdateMessageRequest" });
export type UpdateMessageRequest = typeof UpdateMessageRequest.Type;

export const UpdateMessageResponse = Schema.Struct({
  message_id: MessageId,
  labels: Schema.Array(Schema.String),
}).annotate({ identifier: "UpdateMessageResponse" });
export type UpdateMessageResponse = typeof UpdateMessageResponse.Type;

export const BatchUpdateMessagesRequest = Schema.Struct({
  message_ids: Schema.Array(MessageId).check(
    Schema.isMaxLength(50),
    Schema.makeFilter((ids) => new Set(ids).size === ids.length, {
      toJsonSchema: () => ({ uniqueItems: true }),
    }),
  ),
  add_labels: Schema.optionalKey(UpdateMessageLabels),
  remove_labels: Schema.optionalKey(UpdateMessageLabels),
}).annotate({ identifier: "BatchUpdateMessagesRequest" });
export type BatchUpdateMessagesRequest = typeof BatchUpdateMessagesRequest.Type;

export const BatchUpdateMessagesResponse = Schema.Struct({
  limit: Limit,
  count: Count,
  updates: Schema.Array(UpdateMessageResponse),
}).annotate({ identifier: "BatchUpdateMessagesResponse" });
export type BatchUpdateMessagesResponse = typeof BatchUpdateMessagesResponse.Type;

export const RawMessageResponse = Schema.Struct({
  message_id: MessageId,
  size: Schema.Int,
  download_url: Schema.String,
  expires_at: Timestamp,
}).annotate({ identifier: "RawMessageResponse" });
export type RawMessageResponse = typeof RawMessageResponse.Type;

export const SendMessageRequest = Schema.Struct({
  labels: Schema.optionalKey(Schema.Array(Schema.String)),
  reply_to: Schema.optionalKey(Addresses),
  to: Schema.optionalKey(Addresses),
  cc: Schema.optionalKey(Addresses),
  bcc: Schema.optionalKey(Addresses),
  subject: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  html: Schema.optionalKey(Schema.String),
  attachments: Schema.optionalKey(Schema.Array(SendAttachment)),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
}).annotate({ identifier: "SendMessageRequest" });
export type SendMessageRequest = typeof SendMessageRequest.Type;

export const ForwardMessageRequest = SendMessageRequest.annotate({
  identifier: "ForwardMessageRequest",
});
export type ForwardMessageRequest = typeof ForwardMessageRequest.Type;

export const SendMessageResponse = Schema.Struct({
  message_id: MessageId,
  thread_id: ThreadId,
}).annotate({ identifier: "SendMessageResponse" });
export type SendMessageResponse = typeof SendMessageResponse.Type;

export const ReplyAll = Schema.Boolean.annotate({ identifier: "ReplyAll" });
export type ReplyAll = typeof ReplyAll.Type;

export const ReplyToMessageRequest = Schema.Struct({
  labels: Schema.optionalKey(Schema.Array(Schema.String)),
  reply_to: Schema.optionalKey(Addresses),
  to: Schema.optionalKey(Addresses),
  cc: Schema.optionalKey(Addresses),
  bcc: Schema.optionalKey(Addresses),
  reply_all: Schema.optionalKey(ReplyAll),
  text: Schema.optionalKey(Schema.String),
  html: Schema.optionalKey(Schema.String),
  attachments: Schema.optionalKey(Schema.Array(SendAttachment)),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
}).annotate({ identifier: "ReplyToMessageRequest" });
export type ReplyToMessageRequest = typeof ReplyToMessageRequest.Type;

export const ReplyAllMessageRequest = Schema.Struct({
  labels: Schema.optionalKey(Schema.Array(Schema.String)),
  reply_to: Schema.optionalKey(Addresses),
  text: Schema.optionalKey(Schema.String),
  html: Schema.optionalKey(Schema.String),
  attachments: Schema.optionalKey(Schema.Array(SendAttachment)),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
}).annotate({ identifier: "ReplyAllMessageRequest" });
export type ReplyAllMessageRequest = typeof ReplyAllMessageRequest.Type;
