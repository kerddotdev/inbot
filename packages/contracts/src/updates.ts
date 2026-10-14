import { Schema } from "effect";

export const UpdatePreference = Schema.Struct({ enabled: Schema.Boolean });
export type UpdatePreference = typeof UpdatePreference.Type;
export const UpdateRecord = Schema.Struct({
  last_check: Schema.NullOr(Schema.String),
  latest: Schema.NullOr(Schema.String),
  last_result: Schema.Literals([
    "never_checked",
    "checking",
    "up_to_date",
    "available",
    "ready",
    "restarting",
    "updated",
    "failed",
  ]),
  error: Schema.NullOr(Schema.Struct({ message: Schema.String, fix: Schema.String })),
});
export type UpdateRecord = typeof UpdateRecord.Type;
export const UpdateStatus = Schema.Struct({
  ...UpdatePreference.fields,
  ...UpdateRecord.fields,
  current: Schema.String,
  eligible: Schema.Boolean,
});
export type UpdateStatus = typeof UpdateStatus.Type;
