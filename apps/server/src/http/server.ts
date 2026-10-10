import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { Cause, Context, Effect, Layer, Option, Redacted, Result, Schema } from "effect";
import { HttpRouter, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder, HttpApiError } from "effect/http-api";
import { ApiKeys } from "../auth/api-keys.js";
import { OwnerSessions } from "../auth/sessions.js";
import { Store } from "../store.js";
import { ownerHandlers } from "./owner.js";
import { CurrentOwnerSession, cookieName, matchesCsrf, sessionCookie } from "./owner-session.js";
import { staticWeb, webSecurityHeaders } from "./static.js";
import { OwnerAuth } from "../auth/owner.js";
import { InboundConfig } from "../inbound/config.js";
import { CloudflareApi } from "../provision/cloudflare-api.js";
import { PublicDns } from "../provision/dns.js";
import { Provisioner } from "../provision/provisioner.js";
import { Home } from "../home.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { AgentOperations } from "../agent/operations.js";
import { Drafts } from "../drafts/drafts.js";
import { Outbox } from "../outbound/outbox.js";
import { OwnerTransport } from "../outbound/owner-transport.js";
import { TransportConfig } from "../outbound/transport-config.js";
import { startDraftLoop } from "../drafts/runtime.js";
import { startOutboxLoop } from "../outbound/runtime.js";
import { mcpRoutes } from "../mcp/server.js";
import { authenticate } from "./middleware.js";
import { ServerApi } from "./api.js";
import { DownloadRoutes, Downloads } from "./downloads.js";
import { errorResponse, unavailable, wireError } from "./errors.js";
import { HandlersLive } from "./handlers.js";
import { AuthLive, OwnerOnlyLive, WireErrorsLive } from "./middleware.js";

export function startHttpServer(
  options: {
    readonly port?: number;
    readonly ready?: (url: string) => void;
    readonly runOutbox?: boolean;
    readonly runScheduler?: boolean;
    readonly webRoot?: string;
    readonly setupRequired?: (code: string) => void;
    readonly transportFetch?: typeof globalThis.fetch;
  } = {},
) {
  return Effect.gen(function* () {
    const port = yield* Schema.decodeUnknownEffect(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
    )(options.port ?? 0);
    const home = yield* Home;
    const store = yield* Store;
    const web = yield* staticWeb(options.webRoot);
    const mailbox = yield* Mailbox;
    const keys = yield* ApiKeys;
    const outbox = yield* Outbox;
    const config = yield* TransportConfig;
    const drafts = yield* Drafts;
    const supplied = yield* Effect.serviceOption(Provisioner);
    const provisioner = Option.isSome(supplied)
      ? supplied.value
      : yield* Provisioner.pipe(
          Effect.provide(
            Provisioner.Live.pipe(
              Layer.provide(
                Layer.mergeAll(
                  CloudflareApi.live().pipe(Layer.provide(Layer.succeed(TransportConfig, config))),
                  PublicDns.live(),
                  InboundConfig.Live.pipe(Layer.provide(Layer.succeed(Store, store))),
                  Layer.succeed(Store, store),
                  Layer.succeed(TransportConfig, config),
                  Layer.succeed(Mailbox, mailbox),
                ),
              ),
            ),
          ),
        );
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
    const ownerTransport = OwnerTransport.live(
      options.transportFetch === undefined ? {} : { fetch: options.transportFetch },
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Store, store),
          Layer.succeed(TransportConfig, config),
          Layer.succeed(Provisioner, provisioner),
        ),
      ),
    );
    const services = Layer.mergeAll(
      ownerTransport,
      Layer.succeed(Home, home),
      OwnerSessions.layer(options.setupRequired).pipe(Layer.provide(Layer.succeed(Store, store))),
      Layer.succeed(Mailbox, mailbox),
      Layer.succeed(ApiKeys, keys),
      Layer.succeed(Outbox, outbox),
      Layer.succeed(Drafts, drafts),
      Layer.succeed(Provisioner, provisioner),
      Layer.succeed(TransportConfig, config),
      Downloads.layer(url),
      OwnerAuth.layer(url).pipe(Layer.provide(Layer.succeed(Home, home))),
    );
    const context = yield* Layer.build(services);
    const owner = Context.get(context, OwnerAuth);
    const sessions = Context.get(context, OwnerSessions);
    const shared = AgentOperations.Live.pipe(Layer.provideMerge(Layer.succeedContext(context)));
    const handlers = Layer.mergeAll(HandlersLive, ownerHandlers(url)).pipe(
      Layer.provide(Layer.mergeAll(AuthLive, OwnerOnlyLive, WireErrorsLive)),
    );
    const routes = Layer.mergeAll(
      HttpApiBuilder.layer(ServerApi).pipe(Layer.provide(handlers)),
      DownloadRoutes,
      mcpRoutes(url),
    ).pipe(Layer.provide(shared));
    const app = yield* HttpRouter.toHttpEffect(routes).pipe(
      Effect.provideService(HttpRouter.RouterConfig, { maxParamLength: 8192 }),
    );
    const guarded = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      let routePath: string;
      try {
        routePath = decodeURIComponent(request.url.split("?")[0] ?? "");
      } catch {
        return errorResponse(
          wireError("validation_error", "The request path is invalid.", "Use a valid URL path."),
        );
      }
      const origin = request.headers.origin;
      if (request.headers.host !== new URL(url).host)
        return errorResponse(
          wireError(
            "missing_permission",
            "The request host is not allowed.",
            "Use the local server URL.",
          ),
        );
      if (origin !== undefined && origin !== url)
        return errorResponse(
          wireError(
            "missing_permission",
            "Cross-origin browser requests are not allowed.",
            "Use the server's own origin for browser requests.",
          ),
        );
      const session =
        request.headers.authorization === undefined
          ? yield* sessions.authenticate(request.cookies[cookieName(url)] ?? "")
          : undefined;
      if (
        session !== undefined &&
        !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
        !matchesCsrf(session.csrf_token, request.headers["x-inbot-csrf"])
      )
        return errorResponse(
          wireError(
            "missing_permission",
            "A matching CSRF header is required.",
            "Send the session CSRF token in X-Inbot-CSRF.",
          ),
        );
      if (routePath.startsWith("/v0/owner/") && request.headers.authorization !== undefined) {
        const bearer = request.headers.authorization.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
        const principal = yield* authenticate(Redacted.make(bearer), owner, keys);
        if (HttpServerResponse.isHttpServerResponse(principal)) return principal;
        if (principal.kind !== "owner")
          return errorResponse(
            wireError(
              "missing_permission",
              "Owner endpoints require owner credentials.",
              "Sign in as the owner.",
            ),
          );
      }
      const staticResponse =
        web === undefined ? undefined : yield* web(request.url, request.method);
      if (staticResponse !== undefined) return staticResponse;
      if (routePath === "/mcp" && session === undefined) {
        const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
        const principal = yield* authenticate(Redacted.make(bearer), owner, keys);
        if (HttpServerResponse.isHttpServerResponse(principal)) return principal;
      }
      const response = yield* app.pipe(
        Effect.provideService(CurrentOwnerSession, session),
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
      return session === undefined || response.cookies.cookies[cookieName(url)] !== undefined
        ? response
        : sessionCookie(response, url, session);
    }).pipe(
      Effect.catch(() => Effect.succeed(unavailable())),
      Effect.map((original) => {
        const response =
          original.status === 415
            ? errorResponse(
                wireError(
                  "validation_error",
                  "The request content type is not supported.",
                  "Send a JSON body with Content-Type: application/json.",
                ),
              )
            : original;
        return HttpServerResponse.setHeaders(response, {
          ...webSecurityHeaders,
          "cache-control": response.headers["cache-control"] ?? "no-store",
        });
      }),
    );
    yield* server.serve(guarded);
    const scheduler =
      options.runOutbox === false || options.runScheduler === false
        ? undefined
        : yield* startDraftLoop();
    const runner = options.runOutbox === false ? undefined : yield* startOutboxLoop();
    yield* Effect.sync(() => options.ready?.(url));
    return { url, runner, scheduler };
  }).pipe(Effect.provide(NodeHttpServer.layerHttpServices));
}
