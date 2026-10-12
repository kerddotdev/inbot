import { Schema } from "effect";
import { CursorQuery, PageFields, Timestamp } from "./common.js";

export const QuarantineItem = Schema.Struct({
  quarantine_id: Schema.String,
  source_kind: Schema.Literals(["buffer_object", "queue_message"]),
  reason_code: Schema.String,
  first_seen: Timestamp,
  size: Schema.NullOr(Schema.Int),
  inbox_id: Schema.NullOr(Schema.String),
  attempts: Schema.NullOr(Schema.Int),
  last_attempt_at: Schema.NullOr(Timestamp),
  status: Schema.Literals(["quarantined", "release_pending", "delete_pending"]),
});
export type QuarantineItem = typeof QuarantineItem.Type;
export const ListQuarantineQuery = CursorQuery;
export type ListQuarantineQuery = typeof ListQuarantineQuery.Type;
export const ListQuarantineResponse = Schema.Struct({
  ...PageFields,
  items: Schema.Array(QuarantineItem),
});
export const RetryQuarantineResponse = Schema.Struct({
  status: Schema.Literals(["released", "quarantined"]),
  item: Schema.optionalKey(QuarantineItem),
});
