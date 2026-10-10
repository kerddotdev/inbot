import { HttpApi, HttpApiMiddleware } from "effect/http-api";
import { InbotApi } from "../../../../packages/contracts/src/api.js";
import {
  BadRequestError,
  ServiceUnavailableError,
} from "../../../../packages/contracts/src/errors.js";

import { OwnerApiGroup } from "../../../../packages/contracts/src/api/owner.js";

export class WireErrors extends HttpApiMiddleware.Service<WireErrors>()("inbot/WireErrors", {
  error: [BadRequestError, ServiceUnavailableError],
}) {}

export const ServerApi = InbotApi.add(OwnerApiGroup)
  .annotate(HttpApi.PayloadParseOptions, {
    onExcessProperty: "error",
  })
  .middleware(WireErrors);
