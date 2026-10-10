import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import * as Owner from "../owner.js";
import { WriteErrors } from "../errors.js";
import { BearerAuth, OwnerOnly } from "../security.js";

export const OwnerApiGroup = HttpApiGroup.make("owner").add(
  HttpApiEndpoint.get("owner_status", "/v0/owner/status", {
    success: Owner.OwnerStatus,
    error: WriteErrors,
  }),
  HttpApiEndpoint.post("owner_setup", "/v0/owner/setup", {
    payload: Owner.OwnerSetupRequest,
    success: Owner.OwnerSessionResponse,
    error: WriteErrors,
  }),
  HttpApiEndpoint.post("owner_login", "/v0/owner/login", {
    payload: Owner.OwnerLoginRequest,
    success: Owner.OwnerSessionResponse,
    error: WriteErrors,
  }),
  HttpApiEndpoint.post("owner_redeem", "/v0/owner/login-links/redeem", {
    payload: Owner.OwnerRedeemRequest,
    success: Owner.OwnerSessionResponse,
    error: WriteErrors,
  }),
  HttpApiEndpoint.post("owner_logout", "/v0/owner/logout", {
    success: HttpApiSchema.Empty(200),
    error: WriteErrors,
  })
    .middleware(OwnerOnly)
    .middleware(BearerAuth),
  HttpApiEndpoint.get("owner_sessions", "/v0/owner/sessions", {
    success: Owner.OwnerSessionsResponse,
    error: WriteErrors,
  })
    .middleware(OwnerOnly)
    .middleware(BearerAuth),
  HttpApiEndpoint.delete("owner_revoke", "/v0/owner/sessions/:id", {
    params: { id: Schema.String },
    success: HttpApiSchema.Empty(200),
    error: WriteErrors,
  })
    .middleware(OwnerOnly)
    .middleware(BearerAuth),
  HttpApiEndpoint.post("owner_password", "/v0/owner/password", {
    payload: Owner.OwnerPasswordRequest,
    success: HttpApiSchema.Empty(200),
    error: WriteErrors,
  })
    .middleware(OwnerOnly)
    .middleware(BearerAuth),
  HttpApiEndpoint.post("owner_loginLink", "/v0/owner/login-links", {
    success: Owner.OwnerLoginLink,
    error: WriteErrors,
  })
    .middleware(OwnerOnly)
    .middleware(BearerAuth),
);
export const OwnerApi = HttpApi.make("inbot-owner").add(OwnerApiGroup);
