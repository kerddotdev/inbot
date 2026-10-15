import { Schema } from "effect";
import { ApiKeyId, InboxId, PageFields, PaginationQuery, Timestamp } from "./common.js";
import { Credential, CredentialFieldName, CredentialValue } from "./vault.js";

export const CredentialRequestId = Schema.String;
export const CredentialRequestState = Schema.Literals([
  "pending",
  "fulfilled",
  "declined",
  "expired",
]);
const fields = Schema.Array(CredentialFieldName).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(8),
  Schema.isUnique(),
);
export const CreateCredentialRequestRequest = Schema.Struct({
  name: Credential.fields.name,
  url: Credential.fields.url,
  username: Credential.fields.username,
  fields,
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
}).annotate({ identifier: "CreateCredentialRequestRequest" });
export type CreateCredentialRequestRequest = typeof CreateCredentialRequestRequest.Type;

export const CredentialRequest = Schema.Struct({
  ...CreateCredentialRequestRequest.fields,
  request_id: CredentialRequestId,
  inbox_id: InboxId,
  state: CredentialRequestState,
  credential: Schema.optionalKey(Credential),
  requested_by: Schema.optionalKey(ApiKeyId),
  created_at: Timestamp,
  decided_at: Schema.optionalKey(Timestamp),
  expires_at: Timestamp,
}).annotate({ identifier: "CredentialRequest" });
export type CredentialRequest = typeof CredentialRequest.Type;

export const FulfillCredentialRequestRequest = Schema.Struct({
  fields: Schema.Record(CredentialFieldName, CredentialValue).check(
    Schema.isMinProperties(1),
    Schema.isMaxProperties(8),
  ),
  username: Credential.fields.username,
}).annotate({ identifier: "FulfillCredentialRequestRequest" });
export type FulfillCredentialRequestRequest = typeof FulfillCredentialRequestRequest.Type;

export const ListCredentialRequestsQuery = Schema.Struct({
  ...PaginationQuery.fields,
  state: Schema.optionalKey(CredentialRequestState),
}).annotate({ identifier: "ListCredentialRequestsQuery" });
export type ListCredentialRequestsQuery = typeof ListCredentialRequestsQuery.Type;
export const ListCredentialRequestsResponse = Schema.Struct({
  ...PageFields,
  credential_requests: Schema.Array(CredentialRequest),
}).annotate({ identifier: "ListCredentialRequestsResponse" });
export type ListCredentialRequestsResponse = typeof ListCredentialRequestsResponse.Type;
