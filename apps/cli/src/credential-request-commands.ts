import { CredentialRequestsApi } from "../../../packages/contracts/src/api/credential-requests.js";
import type { Command } from "./commands.js";

export const credentialRequestCommands: readonly Command[] = [
  {
    name: "credentials request",
    description:
      "Ask the owner for credentials; returns metadata and refs only. Requires credential_request.",
    endpoint: CredentialRequestsApi.endpoints.credentialRequests_create,
    params: ["inbox_id"],
    body: { name: "string", url: "string", username: "string", fields: "array", reason: "string" },
  },
  {
    name: "credentials request-get",
    description: "Read your credential request. Check back later while pending; do not busy-loop.",
    endpoint: CredentialRequestsApi.endpoints.credentialRequests_get,
    params: ["inbox_id", "request_id"],
  },
  {
    name: "credentials requests",
    description: "List your own scoped credential requests; owners see all.",
    endpoint: CredentialRequestsApi.endpoints.credentialRequests_list,
    query: { state: "string", limit: "number", page_token: "string", ascending: "boolean" },
  },
  {
    name: "credentials fulfill",
    description:
      "Fulfill a request as local owner. --fields-stdin reads a JSON object of field values from stdin only.",
    endpoint: CredentialRequestsApi.endpoints.credentialRequests_fulfill,
    params: ["request_id"],
    body: { username: "string" },
    fieldsInput: true,
  },
  {
    name: "credentials decline",
    description: "Decline a credential request as owner. Repeating a decline is safe.",
    endpoint: CredentialRequestsApi.endpoints.credentialRequests_decline,
    params: ["request_id"],
  },
];
