import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { WriteErrors } from "../errors.js";
import { BearerAuth, OwnerOnly } from "../security.js";
import * as Quarantine from "../quarantine.js";

export const QuarantineApi = HttpApiGroup.make("quarantine")
  .add(
    HttpApiEndpoint.get("quarantine_list", "/v0/owner/quarantine", {
      query: Quarantine.ListQuarantineQuery,
      success: Quarantine.ListQuarantineResponse,
      error: WriteErrors,
    }),
    HttpApiEndpoint.post("quarantine_retry", "/v0/owner/quarantine/:quarantine_id/retry", {
      params: { quarantine_id: Schema.String },
      success: Quarantine.RetryQuarantineResponse,
      error: WriteErrors,
    }),
    HttpApiEndpoint.delete("quarantine_delete", "/v0/owner/quarantine/:quarantine_id", {
      params: { quarantine_id: Schema.String },
      success: HttpApiSchema.Empty(200),
      error: WriteErrors,
    }),
  )
  .middleware(OwnerOnly)
  .middleware(BearerAuth);
