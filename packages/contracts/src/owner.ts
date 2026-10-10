import { Schema } from "effect";

export const OwnerStatus = Schema.Struct({
  setup_required: Schema.Boolean,
  authenticated: Schema.Boolean,
  locked: Schema.Boolean,
});
export const OwnerPassword = Schema.String.check(Schema.isMinLength(12), Schema.isMaxLength(1024));
const Credential = Schema.String.check(Schema.isMaxLength(1024));
export const OwnerSetupRequest = Schema.Struct({ password: OwnerPassword, code: Credential });
export const OwnerLoginRequest = Schema.Struct({ password: Credential });
export const OwnerPasswordRequest = Schema.Struct({
  current_password: Credential,
  password: OwnerPassword,
});
export const OwnerSessionResponse = Schema.Struct({
  csrf_token: Schema.String,
  expires_at: Schema.String,
});
export const OwnerSession = Schema.Struct({
  id: Schema.String,
  created_at: Schema.String,
  last_seen_at: Schema.String,
  expires_at: Schema.String,
  user_agent: Schema.String,
  revoked: Schema.Boolean,
  current: Schema.Boolean,
});
export const OwnerSessionsResponse = Schema.Struct({ sessions: Schema.Array(OwnerSession) });
export const OwnerLoginLink = Schema.Struct({ url: Schema.String });
export const OwnerRedeemRequest = Schema.Struct({ token: Credential });

export const OwnerTransportRequest = Schema.Struct({
  account_id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/i)),
  api_token: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1024),
    Schema.isPattern(/^\S+$/),
  ),
});
export type OwnerTransportRequest = typeof OwnerTransportRequest.Type;
export const OwnerTransportStatus = Schema.Struct({
  provider: Schema.Literal("cloudflare"),
  account_id: Schema.NullOr(Schema.String),
  token_set: Schema.Boolean,
  verification_status: Schema.Literals(["not_configured", "unverified", "verified"]),
  verified_at: Schema.NullOr(Schema.String),
});
export type OwnerTransportStatus = typeof OwnerTransportStatus.Type;
