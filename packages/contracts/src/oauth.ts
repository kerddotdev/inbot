import { Schema } from "effect";
import { Grant } from "./api-keys.js";
import { Timestamp } from "./common.js";

const Text = Schema.String.check(Schema.isMaxLength(2048));
export const OAuthClientId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/));
export const OAuthGrantId = OAuthClientId;
export const ProtectedResourceMetadata = Schema.Struct({
  resource: Text,
  authorization_servers: Schema.Array(Text),
  bearer_methods_supported: Schema.Array(Schema.Literal("header")),
  scopes_supported: Schema.Array(Schema.Literal("inbot")),
});
export type ProtectedResourceMetadata = typeof ProtectedResourceMetadata.Type;
export const AuthorizationServerMetadata = Schema.Struct({
  issuer: Text,
  authorization_endpoint: Text,
  token_endpoint: Text,
  registration_endpoint: Text,
  revocation_endpoint: Text,
  response_types_supported: Schema.Array(Schema.Literal("code")),
  grant_types_supported: Schema.Array(Schema.Literals(["authorization_code", "refresh_token"])),
  token_endpoint_auth_methods_supported: Schema.Array(Schema.Literal("none")),
  revocation_endpoint_auth_methods_supported: Schema.Array(Schema.Literal("none")),
  code_challenge_methods_supported: Schema.Array(Schema.Literal("S256")),
  scopes_supported: Schema.Array(Schema.Literal("inbot")),
  resource_indicators_supported: Schema.Boolean,
  authorization_response_iss_parameter_supported: Schema.Boolean,
});
export type AuthorizationServerMetadata = typeof AuthorizationServerMetadata.Type;
const ClientMetadata = {
  client_uri: Schema.optionalKey(Text),
  logo_uri: Schema.optionalKey(Text),
  scope: Schema.optionalKey(Text),
  software_id: Schema.optionalKey(Text),
  software_version: Schema.optionalKey(Text),
  contacts: Schema.optionalKey(Schema.Array(Text).check(Schema.isMaxLength(20))),
};
export const RegisterClientRequest = Schema.Struct({
  ...ClientMetadata,
  client_name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  redirect_uris: Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
  token_endpoint_auth_method: Schema.optionalKey(Schema.Literal("none")),
  grant_types: Schema.optionalKey(Schema.Array(Schema.String)),
  response_types: Schema.optionalKey(Schema.Array(Schema.Literal("code"))),
});
export type RegisterClientRequest = typeof RegisterClientRequest.Type;
export const RegisteredClient = Schema.Struct({
  ...ClientMetadata,
  client_id: OAuthClientId,
  client_name: Schema.String,
  redirect_uris: Schema.Array(Text),
  token_endpoint_auth_method: Schema.Literal("none"),
  grant_types: Schema.Array(Schema.Literals(["authorization_code", "refresh_token"])),
  response_types: Schema.Array(Schema.Literal("code")),
});
export const AuthorizationRequest = Schema.Struct({
  response_type: Schema.Literal("code"),
  client_id: OAuthClientId,
  redirect_uri: Text,
  code_challenge: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
  code_challenge_method: Schema.Literal("S256"),
  resource: Text,
  state: Schema.optionalKey(Text),
  scope: Schema.optionalKey(Schema.Literal("inbot")),
});
export type AuthorizationRequest = typeof AuthorizationRequest.Type;
export const ConsentRequest = Schema.Struct({
  ...AuthorizationRequest.fields,
  approved: Schema.Boolean,
  grant: Schema.optionalKey(Grant),
});
export type ConsentRequest = typeof ConsentRequest.Type;
export const ConsentDetails = Schema.Struct({
  client_name: Schema.String,
  redirect_host: Schema.String,
  resource: Schema.String,
});
export const ConsentResponse = Schema.Struct({ redirect_uri: Schema.String });
export const TokenRequest = Schema.Union([
  Schema.Struct({
    grant_type: Schema.Literal("authorization_code"),
    client_id: OAuthClientId,
    code: Text,
    redirect_uri: Text,
    code_verifier: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._~-]{43,128}$/)),
    resource: Text,
  }),
  Schema.Struct({
    grant_type: Schema.Literal("refresh_token"),
    client_id: OAuthClientId,
    refresh_token: Text,
    resource: Text,
  }),
]);
export type TokenRequest = typeof TokenRequest.Type;
export const RevokeTokenRequest = Schema.Struct({
  client_id: OAuthClientId,
  token: Text,
  token_type_hint: Schema.optionalKey(Text),
});
export type RevokeTokenRequest = typeof RevokeTokenRequest.Type;
export const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.Literal("Bearer"),
  expires_in: Schema.Int,
  refresh_token: Schema.String,
  scope: Schema.Literal("inbot"),
});
export type TokenResponse = typeof TokenResponse.Type;
export const AuthorizedOAuthGrant = Schema.Struct({
  ...Grant.fields,
  grant_id: OAuthGrantId,
  client_id: OAuthClientId,
  client_name: Schema.String,
  redirect_host: Schema.String,
  resource: Schema.String,
  created_at: Timestamp,
});
export const OAuthClientsResponse = Schema.Struct({ grants: Schema.Array(AuthorizedOAuthGrant) });
export const PurgeOAuthClientsResponse = Schema.Struct({ deleted_clients: Schema.Int });
export const OAuthErrorResponse = Schema.Struct({
  error: Schema.Literals([
    "invalid_request",
    "invalid_client",
    "invalid_grant",
    "invalid_redirect_uri",
    "invalid_client_metadata",
    "invalid_target",
    "access_denied",
    "temporarily_unavailable",
  ]),
  error_description: Schema.String,
});
export type OAuthErrorResponse = typeof OAuthErrorResponse.Type;
