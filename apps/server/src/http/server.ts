import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { Cause, Effect, Layer, Result, Schema } from "effect";
import { HttpRouter, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder, HttpApiError } from "effect/http-api";
import { ApiKeys } from "../auth/api-keys.js";
import { OwnerAuth } from "../auth/owner.js";
import { Home } from "../home.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { ServerApi } from "./api.js";
import { DownloadRoutes, Downloads } from "./downloads.js";
import { errorResponse, unavailable, wireError } from "./errors.js";
import { HandlersLive } from "./handlers.js";
import { AuthLive, OwnerOnlyLive, WireErrorsLive } from "./middleware.js";

export function startHttpServer(
  options: { readonly port?: number; readonly ready?: (url: string) => void } = {},
) {
  return Effect.gen(function* () {
    const port = yield* Schema.decodeUnknownEffect(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
    )(options.port ?? 0);
    const home = yield* Home;
    const mailbox = yield* Mailbox;
    const keys = yield* ApiKeys;
    const nodeServer = createServer();
    const server = yield* NodeHttpServer.make(() => nodeServer, {
      host: "127.0.0.1",
      port,
      gracefulShutdownTimeout: "5 seconds",
    });
    const address = nodeServer.address();
    if (address === null || typeof address === "string")
      return yield* Effect.die("Expected a loopback TCP address");
    const url = `http://127.0.0.1:${address.port}`;
    const services = Layer.mergeAll(
      Layer.succeed(Home, home),
      Layer.succeed(Mailbox, mailbox),
      Layer.succeed(ApiKeys, keys),
      Downloads.layer(url),
      OwnerAuth.layer(url).pipe(Layer.provide(Layer.succeed(Home, home))),
    );
    const handlers = HandlersLive.pipe(
      Layer.provide(Layer.mergeAll(AuthLive, OwnerOnlyLive, WireErrorsLive)),
    );
    const routes = Layer.mergeAll(
      HttpApiBuilder.layer(ServerApi).pipe(Layer.provide(handlers)),
      DownloadRoutes,
    ).pipe(Layer.provide(services));
    const app = yield* HttpRouter.toHttpEffect(routes).pipe(
      Effect.provideService(HttpRouter.RouterConfig, { maxParamLength: 8192 }),
    );
    const guarded = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== url)
        return errorResponse(
          wireError(
            "missing_permission",
            "Cross-origin browser requests are not allowed.",
            "Use the server's own origin for browser requests.",
          ),
        );
      return yield* app.pipe(
        Effect.catchCause((cause) => {
          const error =
            Result.getOrUndefined(Cause.findError(cause)) ??
            Result.getOrUndefined(Cause.findDefect(cause));
          if (
            HttpApiError.HttpApiSchemaError.is(error) &&
            error.kind !== "Body" &&
            error.kind !== "ResponseHeaders"
          )
            return Effect.succeed(
              errorResponse(
                wireError(
                  "validation_error",
                  "The request does not match the API schema.",
                  "Check the request fields, query parameters, and JSON syntax.",
                ),
              ),
            );
          if (
            error instanceof HttpServerError.HttpServerError &&
            error.reason._tag === "RequestParseError"
          )
            return Effect.succeed(
              errorResponse(
                wireError(
                  "validation_error",
                  "The request body could not be decoded.",
                  "Send a complete JSON body using the documented request format.",
                ),
              ),
            );
          if (
            error instanceof HttpServerError.HttpServerError &&
            error.reason._tag === "RouteNotFound"
          )
            return Effect.succeed(
              errorResponse(
                wireError(
                  "not_found",
                  "The requested route was not found.",
                  "Use a declared /v0 API route.",
                ),
              ),
            );
          return Effect.succeed(unavailable());
        }),
      );
    }).pipe(
      Effect.map((response) => {
        if (response.status === 415)
          return errorResponse(
            wireError(
              "validation_error",
              "The request content type is not supported.",
              "Send a JSON body with Content-Type: application/json.",
            ),
          );
        return HttpServerResponse.setHeaders(response, {
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
      }),
    );
    yield* server.serve(guarded);
    yield* Effect.sync(() => options.ready?.(url));
    return { url };
  }).pipe(Effect.provide(NodeHttpServer.layerHttpServices));
}
