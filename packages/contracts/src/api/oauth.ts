import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { OAuthClientsResponse, OAuthGrantId, PurgeOAuthClientsResponse } from "../oauth.js";
import { WriteErrors } from "../errors.js";
import { BearerAuth, OwnerOnly } from "../security.js";

export const OAuthOwnerApi = HttpApiGroup.make("oauth-owner")
  .add(
    HttpApiEndpoint.get("oauth_clients", "/v0/owner/oauth/clients", {
      success: OAuthClientsResponse,
      error: WriteErrors,
    }),
    HttpApiEndpoint.post("oauth_purge", "/v0/owner/oauth/clients/purge", {
      success: PurgeOAuthClientsResponse,
      error: WriteErrors,
    }),
    HttpApiEndpoint.delete("oauth_revokeGrant", "/v0/owner/oauth/grants/:grant_id", {
      params: { grant_id: OAuthGrantId },
      success: HttpApiSchema.Empty(200),
      error: WriteErrors,
    }),
  )
  .middleware(OwnerOnly)
  .middleware(BearerAuth);
