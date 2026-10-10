import { Schema } from "effect";
import { Attachment } from "./attachments.js";
import { InboxId, MailQueryFields, PageFields, ThreadId, Timestamp } from "./common.js";
import { Message } from "./messages.js";

export const ListThreadsQuery = Schema.Struct({
  ...MailQueryFields,
  senders: Schema.optionalKey(Schema.Array(Schema.String)),
  recipients: Schema.optionalKey(Schema.Array(Schema.String)),
  subject: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const ThreadItem = Schema.Struct({
  inbox_id: InboxId,
  thread_id: ThreadId,
  labels: Schema.Array(Schema.String),
  timestamp: Timestamp,
  received_timestamp: Schema.optionalKey(Timestamp),
  sent_timestamp: Schema.optionalKey(Timestamp),
  senders: Schema.Array(Schema.String),
  recipients: Schema.Array(Schema.String),
  subject: Schema.optionalKey(Schema.String),
  preview: Schema.optionalKey(Schema.String),
  attachments: Schema.optionalKey(Schema.Array(Attachment)),
  last_message_id: Schema.String,
  message_count: Schema.Int,
  size: Schema.Int,
  updated_at: Timestamp,
  created_at: Timestamp,
}).annotate({ identifier: "ThreadItem" });
export type ThreadItem = typeof ThreadItem.Type;

export const ListThreadsResponse = Schema.Struct({
  ...PageFields,
  threads: Schema.Array(ThreadItem),
}).annotate({ identifier: "ListThreadsResponse" });
export type ListThreadsResponse = typeof ListThreadsResponse.Type;

export const SearchThreadHighlights = Schema.Struct({
  from: Schema.optionalKey(Schema.Array(Schema.String)),
  recipients: Schema.optionalKey(Schema.Array(Schema.String)),
  subject: Schema.optionalKey(Schema.Array(Schema.String)),
  text: Schema.optionalKey(Schema.Array(Schema.String)),
}).annotate({ identifier: "SearchThreadHighlights" });
export type SearchThreadHighlights = typeof SearchThreadHighlights.Type;

export const SearchThreadItem = Schema.Struct({
  ...ThreadItem.fields,
  highlights: Schema.optionalKey(SearchThreadHighlights),
}).annotate({ identifier: "SearchThreadItem" });
export type SearchThreadItem = typeof SearchThreadItem.Type;

export const SearchThreadsResponse = Schema.Struct({
  ...PageFields,
  threads: Schema.Array(SearchThreadItem),
}).annotate({ identifier: "SearchThreadsResponse" });
export type SearchThreadsResponse = typeof SearchThreadsResponse.Type;

export const Thread = Schema.Struct({
  ...ThreadItem.fields,
  ...PageFields,
  messages: Schema.Array(Message),
}).annotate({ identifier: "Thread" });
export type Thread = typeof Thread.Type;

export const UpdateThreadRequest = Schema.Struct({
  add_labels: Schema.optionalKey(Schema.Array(Schema.String)),
  remove_labels: Schema.optionalKey(Schema.Array(Schema.String)),
}).annotate({ identifier: "UpdateThreadRequest" });
export type UpdateThreadRequest = typeof UpdateThreadRequest.Type;

export const UpdateThreadResponse = Schema.Struct({
  thread_id: ThreadId,
  labels: Schema.Array(Schema.String),
}).annotate({ identifier: "UpdateThreadResponse" });
export type UpdateThreadResponse = typeof UpdateThreadResponse.Type;
