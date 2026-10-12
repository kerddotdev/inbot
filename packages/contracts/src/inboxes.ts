import { Schema } from "effect";
import { InboxId, PageFields, Timestamp } from "./common.js";

export const InboxStatus = Schema.Literals(["active", "paused"]).annotate({
  identifier: "InboxStatus",
});
export type InboxStatus = typeof InboxStatus.Type;

export const MetadataValue = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]).annotate({
  identifier: "MetadataValue",
});
export type MetadataValue = typeof MetadataValue.Type;

export const Metadata = Schema.Record(Schema.String, MetadataValue)
  .check(Schema.isMaxProperties(256))
  .annotate({ identifier: "Metadata" });
export type Metadata = typeof Metadata.Type;

export const UpdateMetadata = Schema.Record(
  Schema.String,
  Schema.Union([MetadataValue, Schema.Null]),
)
  .check(Schema.isMinProperties(1))
  .annotate({ identifier: "UpdateMetadata" });
export type UpdateMetadata = typeof UpdateMetadata.Type;

export const Inbox = Schema.Struct({
  inbox_id: InboxId,
  email: Schema.String,
  display_name: Schema.optionalKey(Schema.String),
  client_id: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(InboxStatus),
  metadata: Schema.optionalKey(Metadata),
  updated_at: Timestamp,
  created_at: Timestamp,
}).annotate({ identifier: "Inbox" });
export type Inbox = typeof Inbox.Type;

export const ListInboxesResponse = Schema.Struct({
  ...PageFields,
  inboxes: Schema.Array(Inbox),
}).annotate({ identifier: "ListInboxesResponse" });
export type ListInboxesResponse = typeof ListInboxesResponse.Type;

export const SearchInboxesResponse = Schema.Struct({
  ...PageFields,
  inboxes: Schema.Array(Inbox),
}).annotate({ identifier: "SearchInboxesResponse" });
export type SearchInboxesResponse = typeof SearchInboxesResponse.Type;

export const CreateInboxRequest = Schema.Struct({
  username: Schema.optionalKey(Schema.String),
  domain: Schema.optionalKey(Schema.String),
  display_name: Schema.optionalKey(Schema.String),
  client_id: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(InboxStatus),
  metadata: Schema.optionalKey(Metadata),
}).annotate({ identifier: "CreateInboxRequest" });
export type CreateInboxRequest = typeof CreateInboxRequest.Type;

export const UpdateInboxRequest = Schema.Struct({
  display_name: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(InboxStatus),
  metadata: Schema.optionalKey(
    Schema.Union([UpdateMetadata, Schema.Null]).annotate({
      description:
        "Merge provided keys, remove keys whose value is null, or clear all metadata with null. Omitted keys remain unchanged.",
    }),
  ),
})
  .check(Schema.isMinProperties(1))
  .annotate({ identifier: "UpdateInboxRequest" });
export type UpdateInboxRequest = typeof UpdateInboxRequest.Type;
