import { CredentialUseApi } from "../../../packages/contracts/src/api/credential-use.js";
import type { Command } from "./commands.js";

export const credentialUseCommands: readonly Command[] = [
  {
    name: "credentials use-requests list",
    description:
      "List credential use requests as owner. URL hints are agent claims, not verified browser origins.",
    endpoint: CredentialUseApi.endpoints.credentialUseRequests_list,
    query: { limit: "number", page_token: "string", ascending: "boolean", state: "string" },
  },
  {
    name: "credentials use-requests approve",
    description: "Approve one credential use for 15 minutes as owner.",
    endpoint: CredentialUseApi.endpoints.credentialUseRequests_approve,
    params: ["request_id"],
  },
  {
    name: "credentials use-requests reject",
    description: "Reject a pending credential use request as owner.",
    endpoint: CredentialUseApi.endpoints.credentialUseRequests_reject,
    params: ["request_id"],
  },
];
