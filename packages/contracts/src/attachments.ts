import { Schema } from "effect";
import { AttachmentId, Timestamp } from "./common.js";

export const AttachmentContentDisposition = Schema.Literals(["inline", "attachment"]).annotate({
  identifier: "AttachmentContentDisposition",
});
export type AttachmentContentDisposition = typeof AttachmentContentDisposition.Type;

export const Attachment = Schema.Struct({
  attachment_id: AttachmentId,
  filename: Schema.optionalKey(Schema.String),
  size: Schema.Int,
  content_type: Schema.optionalKey(Schema.String),
  content_disposition: Schema.optionalKey(AttachmentContentDisposition),
  content_id: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Attachment" });
export type Attachment = typeof Attachment.Type;

export const AttachmentResponse = Schema.Struct({
  ...Attachment.fields,
  download_url: Schema.String,
  text_url: Schema.optionalKey(Schema.String),
  expires_at: Timestamp,
}).annotate({ identifier: "AttachmentResponse" });
export type AttachmentResponse = typeof AttachmentResponse.Type;

export const SendAttachment = Schema.Struct({
  filename: Schema.optionalKey(Schema.String),
  content_type: Schema.optionalKey(Schema.String),
  content_disposition: Schema.optionalKey(AttachmentContentDisposition),
  content_id: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "SendAttachment" });
export type SendAttachment = typeof SendAttachment.Type;
