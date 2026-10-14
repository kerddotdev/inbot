import { Schema } from "effect";
import { CredentialId, InboxId, PageFields, PaginationQuery, Timestamp } from "./common.js";

export const CredentialFieldName = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9_]{0,63}$/),
).annotate({ identifier: "CredentialFieldName" });
export const CredentialValue = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(16384),
);
export const CredentialFields = Schema.Record(CredentialFieldName, CredentialValue).check(
  Schema.isMaxProperties(32),
);
const origins = Schema.Array(Schema.String).check(Schema.isMaxLength(16));
const name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const username = Schema.String.check(Schema.isMaxLength(320));
const ref = Schema.String.check(
  Schema.isPattern(/^inbot:\/\/credentials\/[0-9a-f]{32}\/[a-z][a-z0-9_]{0,63}$/),
);

export const Credential = Schema.Struct({
  credential_id: CredentialId,
  inbox_id: InboxId,
  name,
  url: Schema.optionalKey(Schema.String),
  origins,
  username: Schema.optionalKey(username),
  fields: Schema.Array(CredentialFieldName).check(Schema.isMaxLength(32)),
  refs: Schema.Record(CredentialFieldName, ref),
  created_at: Timestamp,
  updated_at: Timestamp,
  last_used_at: Schema.optionalKey(Timestamp),
}).annotate({ identifier: "Credential" });
export type Credential = typeof Credential.Type;

export const GenerateFieldRequest = Schema.Struct({
  field: Schema.optionalKey(
    CredentialFieldName.check(Schema.makeFilter((value) => value !== "totp")),
  ),
  mode: Schema.optionalKey(Schema.Literals(["apple", "random"])),
  length: Schema.optionalKey(Schema.Int),
  rules: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "GenerateFieldRequest" });
export type GenerateFieldRequest = typeof GenerateFieldRequest.Type;

const metadata = {
  url: Schema.optionalKey(Schema.String),
  origins: Schema.optionalKey(origins),
  username: Schema.optionalKey(username),
  fields: Schema.optionalKey(CredentialFields),
  generate: Schema.optionalKey(GenerateFieldRequest),
};
export const CreateCredentialRequest = Schema.Struct({ name, ...metadata }).annotate({
  identifier: "CreateCredentialRequest",
});
export type CreateCredentialRequest = typeof CreateCredentialRequest.Type;
export const UpdateCredentialRequest = Schema.Struct({
  name: Schema.optionalKey(name),
  ...metadata,
  remove_fields: Schema.optionalKey(
    Schema.Array(CredentialFieldName).check(Schema.isMaxLength(32)),
  ),
})
  .check(Schema.isMinProperties(1))
  .annotate({ identifier: "UpdateCredentialRequest" });
export type UpdateCredentialRequest = typeof UpdateCredentialRequest.Type;

export const ListCredentialsQuery = Schema.Struct({
  ...PaginationQuery.fields,
  q: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "ListCredentialsQuery" });
export type ListCredentialsQuery = typeof ListCredentialsQuery.Type;
export const GlobalCredentialsQuery = Schema.Struct({
  ...ListCredentialsQuery.fields,
  inbox_id: Schema.optionalKey(InboxId),
}).annotate({ identifier: "GlobalCredentialsQuery" });
export const ListCredentialsResponse = Schema.Struct({
  ...PageFields,
  credentials: Schema.Array(Credential),
}).annotate({ identifier: "ListCredentialsResponse" });
export type ListCredentialsResponse = typeof ListCredentialsResponse.Type;

export const TotpCodeResponse = Schema.Struct({
  code: Schema.String,
  expires_at: Timestamp,
  period: Schema.Int,
}).annotate({ identifier: "TotpCodeResponse" });
export type TotpCodeResponse = typeof TotpCodeResponse.Type;
export const CredentialFieldsResponse = Schema.Struct({
  credential_id: CredentialId,
  fields: CredentialFields,
}).annotate({ identifier: "CredentialFieldsResponse" });
export type CredentialFieldsResponse = typeof CredentialFieldsResponse.Type;
