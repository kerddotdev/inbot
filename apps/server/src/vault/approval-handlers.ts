import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { ServerApi } from "../http/api.js";
import { respond } from "../http/errors.js";
import { Store } from "../store.js";
import { makeCredentialUseApprovals } from "./approvals.js";

export const CredentialUseLive = HttpApiBuilder.group(
  ServerApi,
  "credentialUseRequests",
  (handlers) =>
    Effect.gen(function* () {
      const approvals = makeCredentialUseApprovals(yield* Store);
      return handlers
        .handle("credentialUseRequests_list", ({ query }) => respond(approvals.list(query)))
        .handle("credentialUseRequests_approve", ({ params }) =>
          respond(approvals.approve(params.request_id)),
        )
        .handle("credentialUseRequests_reject", ({ params }) =>
          respond(approvals.reject(params.request_id)),
        );
    }),
);
