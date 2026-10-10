import { Schema } from "effect";

export const RemoteStatus = Schema.Struct({
  state: Schema.Literals([
    "disabled",
    "provisioning",
    "connecting",
    "connected",
    "action_required",
  ]),
  hostname: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  connector_version: Schema.String,
});
export type RemoteStatus = typeof RemoteStatus.Type;

export const EnableRemoteRequest = Schema.Struct({
  hostname: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(253)),
});
export type EnableRemoteRequest = typeof EnableRemoteRequest.Type;
