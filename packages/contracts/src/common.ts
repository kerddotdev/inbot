import { Schema } from "effect";

export const Timestamp = Schema.String.check(
  Schema.isPattern(
    /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/,
  ),
  Schema.makeFilter(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().startsWith(value.slice(0, 10)),
    { toJsonSchema: () => [{ format: "date-time" }, true] },
  ),
).annotate({ identifier: "Timestamp", format: "date-time" });
export type Timestamp = typeof Timestamp.Type;

export const InboxId = Schema.String;
export const ThreadId = Schema.String;
export const MessageId = Schema.String;
export const DraftId = Schema.String;
export const AttachmentId = Schema.String;
export const DomainId = Schema.String;
export const WebhookId = Schema.String;
export const ApiKeyId = Schema.String;
export const Limit = Schema.Int;
export const Count = Schema.Int;
export const PageToken = Schema.String;
export const Labels = Schema.Array(Schema.String);
export const Headers = Schema.Record(Schema.String, Schema.String);

export const PageFields = {
  count: Count,
  limit: Schema.optionalKey(Limit),
  next_page_token: Schema.optionalKey(PageToken),
};

export const CursorQuery = Schema.Struct({
  limit: Schema.optionalKey(Limit.check(Schema.isGreaterThanOrEqualTo(1))),
  page_token: Schema.optionalKey(PageToken),
});
export const PaginationQuery = Schema.Struct({
  ...CursorQuery.fields,
  ascending: Schema.optionalKey(Schema.Boolean),
});
export const TimeFilterFields = {
  before: Schema.optionalKey(Timestamp),
  after: Schema.optionalKey(Timestamp),
};
export const MailQueryFields = {
  ...PaginationQuery.fields,
  ...TimeFilterFields,
  labels: Schema.optionalKey(Labels),
  include_spam: Schema.optionalKey(Schema.Boolean),
  include_blocked: Schema.optionalKey(Schema.Boolean),
  include_unauthenticated: Schema.optionalKey(Schema.Boolean),
  include_trash: Schema.optionalKey(Schema.Boolean),
};
export const SearchInboxesQuery = Schema.Struct({
  ...CursorQuery.fields,
  limit: Schema.optionalKey(Limit.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  q: Schema.String,
});
export const SearchMailQuery = Schema.Struct({
  ...SearchInboxesQuery.fields,
  ...TimeFilterFields,
});

export const IdempotencyKey = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9._~-]+$/),
).annotate({ identifier: "IdempotencyKey" });
export const SendHeaders = Schema.Struct({
  "idempotency-key": Schema.optionalKey(IdempotencyKey),
});
