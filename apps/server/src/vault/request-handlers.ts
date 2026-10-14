import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { ServerApi } from "../http/api.js";
import { respond } from "../http/errors.js";
import { CredentialRequests } from "./requests.js";

export const CredentialRequestsLive = HttpApiBuilder.group(
  ServerApi,
  "credential-requests",
  (handlers) =>
    Effect.gen(function* () {
      const requests = yield* CredentialRequests;
      return handlers
        .handle("credentialRequests_create", ({ params, payload }) =>
          respond(requests.create(payload, params.inbox_id)),
        )
        .handle("credentialRequests_get", ({ params }) =>
          respond(requests.get(params.request_id, params.inbox_id)),
        )
        .handle("credentialRequests_list", ({ query }) => respond(requests.list(query)))
        .handle("credentialRequests_fulfill", ({ params, payload }) =>
          respond(requests.fulfill(params.request_id, payload)),
        )
        .handle("credentialRequests_decline", ({ params }) =>
          respond(requests.decline(params.request_id)),
        );
    }),
);
