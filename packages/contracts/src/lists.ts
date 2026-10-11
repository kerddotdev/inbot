import { Schema } from "effect";
import { CursorQuery, PageFields, Timestamp } from "./common.js";

export const Direction = Schema.Literals(["send", "receive", "reply"]).annotate({
  identifier: "Direction",
});
export type Direction = typeof Direction.Type;

export const ListType = Schema.Literals(["allow", "block"]).annotate({ identifier: "ListType" });
export type ListType = typeof ListType.Type;

export const EntryType = Schema.Literals(["email", "domain"]).annotate({ identifier: "EntryType" });
export type EntryType = typeof EntryType.Type;

export const ListEntry = Schema.Struct({
  entry: Schema.String,
  organization_id: Schema.String,
  reason: Schema.optionalKey(Schema.String),
  direction: Direction,
  list_type: ListType,
  entry_type: EntryType,
  created_at: Timestamp,
  read_only: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "ListEntry" });
export type ListEntry = typeof ListEntry.Type;

export const ListListEntriesResponse = Schema.Struct({
  ...PageFields,
  entries: Schema.Array(ListEntry),
}).annotate({ identifier: "ListListEntriesResponse" });
export type ListListEntriesResponse = typeof ListListEntriesResponse.Type;

export const PodListEntry = Schema.Struct({
  ...ListEntry.fields,
  pod_id: Schema.String,
  inbox_id: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "PodListEntry" });
export type PodListEntry = typeof PodListEntry.Type;

export const PodListListEntriesResponse = Schema.Struct({
  ...PageFields,
  entries: Schema.Array(PodListEntry),
}).annotate({ identifier: "PodListListEntriesResponse" });
export type PodListListEntriesResponse = typeof PodListListEntriesResponse.Type;

export const CreateListEntryRequest = Schema.Struct({
  entry: Schema.String,
  reason: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "CreateListEntryRequest" });
export type CreateListEntryRequest = typeof CreateListEntryRequest.Type;

export const RejectionRule = Schema.Struct({
  entry: Schema.String,
  entry_type: EntryType,
  list_type: ListType,
  inbox_id: Schema.NullOr(Schema.String),
});
export const InboundListRejection = Schema.Struct({
  rejection_id: Schema.String,
  inbox_id: Schema.String,
  received_at: Timestamp,
  sender_address: Schema.NullOr(Schema.String),
  reason_code: Schema.Literals(["blocked_sender", "sender_not_allowed"]),
  rules: Schema.Array(RejectionRule),
});
export type InboundListRejection = typeof InboundListRejection.Type;
export const ListRejectionsQuery = Schema.Struct({
  ...CursorQuery.fields,
  inbox_id: Schema.optionalKey(Schema.String),
});
export type ListRejectionsQuery = typeof ListRejectionsQuery.Type;
export const ListRejectionsResponse = Schema.Struct({
  ...PageFields,
  rejections: Schema.Array(InboundListRejection),
});
