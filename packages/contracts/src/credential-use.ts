import { Schema } from "effect";
import {
  ApiKeyId,
  CredentialId,
  InboxId,
  PageFields,
  PaginationQuery,
  Timestamp,
} from "./common.js";
import { CredentialFieldName } from "./vault.js";

export const CredentialUseRequestId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/));
export const CredentialUseKind = Schema.Literals(["fill", "run"]);
export const CredentialUseState = Schema.Literals(["pending", "approved", "rejected", "consumed"]);
export const CredentialUseRequest = Schema.Struct({
  request_id: CredentialUseRequestId,
  api_key_id: ApiKeyId,
  api_key_name: Schema.optionalKey(Schema.String),
  inbox_id: InboxId,
  kind: CredentialUseKind,
  credentials: Schema.Array(
    Schema.Struct({
      credential_id: CredentialId,
      name: Schema.String,
      fields: Schema.Array(CredentialFieldName),
    }),
  ),
  url_hint: Schema.optionalKey(Schema.String),
  state: CredentialUseState,
  created_at: Timestamp,
  decided_at: Schema.optionalKey(Timestamp),
  expires_at: Timestamp,
}).annotate({ identifier: "CredentialUseRequest" });
export type CredentialUseRequest = typeof CredentialUseRequest.Type;
export const ListCredentialUseRequestsQuery = Schema.Struct({
  ...PaginationQuery.fields,
  state: Schema.optionalKey(CredentialUseState),
});
export type ListCredentialUseRequestsQuery = typeof ListCredentialUseRequestsQuery.Type;
export const ListCredentialUseRequestsResponse = Schema.Struct({
  ...PageFields,
  requests: Schema.Array(CredentialUseRequest),
});
export type ListCredentialUseRequestsResponse = typeof ListCredentialUseRequestsResponse.Type;
