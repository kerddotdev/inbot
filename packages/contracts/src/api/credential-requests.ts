import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { InboxId } from "../common.js";
import * as Requests from "../credential-requests.js";
import * as Errors from "../errors.js";
import { BearerAuth, OwnerOnly, RequiredPermission } from "../security.js";

const params = { request_id: Requests.CredentialRequestId };
export const CredentialRequestsApi = HttpApiGroup.make("credential-requests")
  .add(
    HttpApiEndpoint.post("credentialRequests_create", "/v0/inboxes/:inbox_id/credential-requests", {
      params: { inbox_id: InboxId },
      payload: Requests.CreateCredentialRequestRequest,
      success: Requests.CredentialRequest,
      error: Errors.WriteErrors,
    }).annotate(RequiredPermission, "credential_request"),
    HttpApiEndpoint.get(
      "credentialRequests_get",
      "/v0/inboxes/:inbox_id/credential-requests/:request_id",
      {
        params: { inbox_id: InboxId, ...params },
        success: Requests.CredentialRequest,
        error: Errors.ReadErrors,
      },
    ).annotate(RequiredPermission, "credential_request"),
    HttpApiEndpoint.get("credentialRequests_list", "/v0/credential-requests", {
      query: Requests.ListCredentialRequestsQuery,
      success: Requests.ListCredentialRequestsResponse,
      error: Errors.ListErrors,
    }).annotate(RequiredPermission, "credential_request"),
    HttpApiEndpoint.post(
      "credentialRequests_fulfill",
      "/v0/credential-requests/:request_id/fulfill",
      {
        params,
        payload: Requests.FulfillCredentialRequestRequest,
        success: Requests.CredentialRequest,
        error: Errors.WriteErrors,
      },
    ).middleware(OwnerOnly),
    HttpApiEndpoint.post(
      "credentialRequests_decline",
      "/v0/credential-requests/:request_id/decline",
      {
        params,
        success: Requests.CredentialRequest,
        error: Errors.WriteErrors,
      },
    ).middleware(OwnerOnly),
  )
  .middleware(BearerAuth);
