import { HttpApi, HttpApiMiddleware } from "effect/http-api";
import { InbotApi } from "../../../../packages/contracts/src/api.js";
import {
  BadRequestError,
  ServiceUnavailableError,
} from "../../../../packages/contracts/src/errors.js";

import { RemoteApiGroup } from "../../../../packages/contracts/src/api/remote.js";
import { OAuthOwnerApi } from "../../../../packages/contracts/src/api/oauth.js";
import { OwnerApiGroup } from "../../../../packages/contracts/src/api/owner.js";

export class WireErrors extends HttpApiMiddleware.Service<WireErrors>()("inbot/WireErrors", {
  error: [BadRequestError, ServiceUnavailableError],
}) {}

export const ServerApi = InbotApi.add(OwnerApiGroup)
  .add(RemoteApiGroup)
  .add(OAuthOwnerApi)
  .annotate(HttpApi.PayloadParseOptions, {
    onExcessProperty: "error",
  })
  .middleware(WireErrors);
