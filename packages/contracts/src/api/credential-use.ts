import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import * as Requests from "../credential-use.js";
import * as Errors from "../errors.js";
import { BearerAuth, OwnerOnly } from "../security.js";

export const CredentialUseApi = HttpApiGroup.make("credentialUseRequests")
  .add(
    HttpApiEndpoint.get("credentialUseRequests_list", "/v0/credential-use-requests", {
      query: Requests.ListCredentialUseRequestsQuery,
      success: Requests.ListCredentialUseRequestsResponse,
      error: Errors.ListErrors,
    }).middleware(OwnerOnly),
    HttpApiEndpoint.post(
      "credentialUseRequests_approve",
      "/v0/credential-use-requests/:request_id/approve",
      {
        params: { request_id: Requests.CredentialUseRequestId },
        success: Requests.CredentialUseRequest,
        error: Errors.WriteErrors,
      },
    ).middleware(OwnerOnly),
    HttpApiEndpoint.post(
      "credentialUseRequests_reject",
      "/v0/credential-use-requests/:request_id/reject",
      {
        params: { request_id: Requests.CredentialUseRequestId },
        success: Requests.CredentialUseRequest,
        error: Errors.WriteErrors,
      },
    ).middleware(OwnerOnly),
  )
  .middleware(BearerAuth);
