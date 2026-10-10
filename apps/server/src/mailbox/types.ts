import { Schema } from "effect";
import { Attachment } from "../../../../packages/contracts/src/attachments.js";
import { Message } from "../../../../packages/contracts/src/messages.js";

export const IngestAttachment = Schema.Struct({
  ...Attachment.fields,
  attachment_id: Schema.optionalKey(Schema.String),
  size: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  content: Schema.Uint8Array,
});
export type IngestAttachment = typeof IngestAttachment.Type;

export const InsertMessage = Schema.Struct({
  inbox_id: Message.fields.inbox_id,
  message_id: Message.fields.message_id,
  direction: Schema.Literals(["received", "sent"]),
  from: Message.fields.from,
  reply_to: Message.fields.reply_to,
  to: Message.fields.to,
  cc: Message.fields.cc,
  bcc: Message.fields.bcc,
  subject: Message.fields.subject,
  text: Message.fields.text,
  html: Message.fields.html,
  extracted_text: Message.fields.extracted_text,
  extracted_html: Message.fields.extracted_html,
  in_reply_to: Message.fields.in_reply_to,
  references: Message.fields.references,
  headers: Message.fields.headers,
  calendar_event_id: Message.fields.calendar_event_id,
  timestamp: Message.fields.timestamp,
  labels: Schema.optionalKey(Message.fields.labels),
  aliases: Schema.optionalKey(Schema.Array(Schema.String)),
  attachments: Schema.optionalKey(Schema.Array(IngestAttachment)),
  raw: Schema.Uint8Array,
  size: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type InsertMessage = typeof InsertMessage.Type;

export interface InboxScope {
  readonly inbox_id?: string;
  readonly inbox_ids?: readonly string[];
}

export interface StoredAttachment {
  readonly attachment: Attachment;
  readonly content: Uint8Array;
}
