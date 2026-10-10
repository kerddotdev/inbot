import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { WriteErrors } from "../errors.js";
import { EnableRemoteRequest, RemoteStatus } from "../remote.js";
import { BearerAuth, OwnerOnly } from "../security.js";

export const RemoteApiGroup = HttpApiGroup.make("remote").add(
  HttpApiEndpoint.get("remote_status", "/v0/owner/remote", {
    success: RemoteStatus,
    error: WriteErrors,
  })
    .middleware(OwnerOnly)
    .middleware(BearerAuth),
  HttpApiEndpoint.post("remote_enable", "/v0/owner/remote/enable", {
    payload: EnableRemoteRequest,
    success: RemoteStatus,
    error: WriteErrors,
  })
    .middleware(OwnerOnly)
    .middleware(BearerAuth),
  HttpApiEndpoint.post("remote_disable", "/v0/owner/remote/disable", {
    success: RemoteStatus,
    error: WriteErrors,
  })
    .middleware(OwnerOnly)
    .middleware(BearerAuth),
);
