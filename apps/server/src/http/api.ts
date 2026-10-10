import { HttpApi, HttpApiMiddleware } from "effect/http-api";
import { InbotApi } from "../../../../packages/contracts/src/api.js";
import {
  BadRequestError,
  ServiceUnavailableError,
} from "../../../../packages/contracts/src/errors.js";

export class WireErrors extends HttpApiMiddleware.Service<WireErrors>()("inbot/WireErrors", {
  error: [BadRequestError, ServiceUnavailableError],
}) {}

export const ServerApi = InbotApi.annotate(HttpApi.PayloadParseOptions, {
  onExcessProperty: "error",
}).middleware(WireErrors);
