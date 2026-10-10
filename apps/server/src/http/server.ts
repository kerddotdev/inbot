import { EventLog } from "../events/log.js";
import { Webhooks } from "../events/webhooks.js";
import { websocket } from "../events/websocket.js";
import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { Cause, Context, Effect, Layer, Option, Redacted, Result, Schema } from "effect";
import {
  Headers,
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { HttpApiBuilder, HttpApiError } from "effect/http-api";
import { ApiKeys } from "../auth/api-keys.js";
import { OwnerSessions } from "../auth/sessions.js";
import { Store } from "../store.js";
import { Lists } from "../lists/lists.js";
import { ownerHandlers } from "./owner.js";
import {
  CurrentOwnerSession,
  CurrentRequestOrigin,
  cookieName,
  matchesCsrf,
  sessionCookie,
} from "./owner-session.js";
import { staticWeb, webSecurityHeaders } from "./static.js";
import { OwnerAuth } from "../auth/owner.js";
import { InboundConfig } from "../inbound/config.js";
import { CloudflareApi } from "../provision/cloudflare-api.js";
import { PublicDns } from "../provision/dns.js";
import { Provisioner } from "../provision/provisioner.js";
import { RemoteAccess, makeRemote } from "../remote/remote.js";
import { makeBinary } from "../remote/binary.js";
import { RemoteHandlers } from "./remote.js";
import { tunnelPath, tunnelRoute, TunnelTraffic } from "./tunnel-policy.js";
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
    const suppliedRemote = yield* Effect.serviceOption(RemoteAccess);
    const remote = Option.isSome(suppliedRemote)
      ? suppliedRemote.value
      : makeRemote({
          store,
          provisioner,
          binary: makeBinary(home.path),
          api: yield* CloudflareApi.pipe(
            Effect.provide(
              CloudflareApi.live().pipe(Layer.provide(Layer.succeed(TransportConfig, config))),
            ),
          ),
        });
    if (Option.isNone(suppliedRemote))
      yield* Effect.addFinalizer(() => remote.shutdown().pipe(Effect.orDie));
    const nodeServer = createServer();
    const server = yield* NodeHttpServer.make(() => nodeServer, {
      host: "127.0.0.1",
      port,
      gracefulShutdownTimeout: "5 seconds",
      websocket: {
        maxPayload: 8192,
        perMessageDeflate: false,
        handleProtocols: (protocols) => (protocols.has("inbot.events") ? "inbot.events" : false),
      },
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
      Lists.Live.pipe(Layer.provide(Layer.succeed(Store, store))),
      ownerTransport,
      EventLog.Live.pipe(Layer.provide(Layer.succeed(Store, store))),
      Webhooks.Live.pipe(Layer.provide(Layer.succeed(Store, store))),
      Layer.succeed(RemoteAccess, remote),
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
    const handlers = Layer.mergeAll(HandlersLive, ownerHandlers(url), RemoteHandlers).pipe(
      Layer.provide(Layer.mergeAll(AuthLive, OwnerOnlyLive, WireErrorsLive)),
    );
    const routes = Layer.mergeAll(
      HttpApiBuilder.layer(ServerApi).pipe(Layer.provide(handlers)),
      DownloadRoutes,
      mcpRoutes(url),
    ).pipe(Layer.provide(shared));
    const app = yield* HttpRouter.toHttpEffect(routes).pipe(
      Effect.provideService(HttpRouter.RouterConfig, { caseSensitive: true, maxParamLength: 8192 }),
    );
    const guarded = Effect.gen(function* () {
      const tunnel = yield* TunnelTraffic;
      const request = yield* HttpServerRequest.HttpServerRequest;
      let routePath: string;
      try {
        routePath = tunnel
          ? tunnelPath(request.url)
          : decodeURIComponent(request.url.split("?")[0] ?? "");
      } catch {
        return errorResponse(
          wireError("validation_error", "The request path is invalid.", "Use a valid URL path."),
        );
      }
      const requestOrigin = tunnel ? yield* remote.publicOrigin() : url;
      if (requestOrigin === undefined)
        return errorResponse(
          wireError(
            "missing_permission",
            "Remote access is disabled or requires local action.",
            "Enable or repair remote access locally.",
          ),
        );
      let policy: ReturnType<typeof tunnelRoute> | undefined;
      if (tunnel) {
        try {
          policy = tunnelRoute(request.url);
        } catch {
          return errorResponse(
            wireError(
              "validation_error",
              "The tunnel request path is invalid.",
              "Use a canonical URL path.",
            ),
          );
        }
        if (policy === "blocked")
          return errorResponse(
            wireError(
              "missing_permission",
              "This management route is unavailable over the tunnel.",
              "Use the local Inbot URL for owner management.",
            ),
          );
        const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
        if (owner.authenticate(bearer))
          return errorResponse(
            wireError(
              "missing_permission",
              "The local owner bearer token is not accepted over the tunnel.",
              "Use a scoped API key or sign in with an owner browser session.",
            ),
          );
      }
      const origin = request.headers.origin;
      if (request.headers.host !== new URL(requestOrigin).host)
        return errorResponse(
          wireError(
            "missing_permission",
            "The request host is not allowed.",
            "Use the local server URL.",
          ),
        );
      if (origin !== undefined && origin !== requestOrigin)
        return errorResponse(
          wireError(
            "missing_permission",
            "Cross-origin browser requests are not allowed.",
            "Use the server's own origin for browser requests.",
          ),
        );
      const session =
        request.headers.authorization === undefined
          ? yield* sessions.authenticate(request.cookies[cookieName(requestOrigin)] ?? "")
          : undefined;
      if (tunnel && routePath === "/v0/ws" && session !== undefined && origin !== requestOrigin)
        return errorResponse(
          wireError(
            "missing_permission",
            "Owner WebSocket sessions require the public HTTPS origin.",
            "Send the exact public origin in the Origin header.",
          ),
        );
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
      if (routePath === "/v0/ws")
        return yield* websocket(requestOrigin).pipe(Effect.provideContext(context));
      if (tunnel && policy === "web" && session === undefined)
        return HttpServerResponse.redirect("/login");
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
        Effect.provideService(CurrentRequestOrigin, requestOrigin),
        // The outer guard validates the dynamic public origin before MCP's static origin check.
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          tunnel && routePath === "/mcp"
            ? request.modify({ headers: Headers.remove(request.headers, "origin") })
            : request,
        ),
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
      return session === undefined ||
        response.cookies.cookies[cookieName(requestOrigin)] !== undefined
        ? response
        : sessionCookie(response, requestOrigin, session);
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
          "content-security-policy": `${webSecurityHeaders["content-security-policy"]}; connect-src 'self' ${url.replace(/^http/, "ws")}`,
          "cache-control": response.headers["cache-control"] ?? "no-store",
        });
      }),
    );
    yield* server.serve(guarded);
    const tunnelNodeServer = createServer();
    const tunnelServer = yield* NodeHttpServer.make(() => tunnelNodeServer, {
      host: "127.0.0.1",
      port: 0,
      gracefulShutdownTimeout: "5 seconds",
      websocket: {
        maxPayload: 8192,
        perMessageDeflate: false,
        handleProtocols: (protocols) => (protocols.has("inbot.events") ? "inbot.events" : false),
      },
    });
    const tunnelAddress = tunnelNodeServer.address();
    if (tunnelAddress === null || typeof tunnelAddress === "string")
      return yield* Effect.die("Expected a tunnel loopback address");
    const tunnelUrl = `http://127.0.0.1:${tunnelAddress.port}`;
    yield* remote.attach(tunnelUrl);
    yield* tunnelServer.serve(guarded.pipe(Effect.provideService(TunnelTraffic, true)));
    const scheduler =
      options.runOutbox === false || options.runScheduler === false
        ? undefined
        : yield* startDraftLoop();
    const runner = options.runOutbox === false ? undefined : yield* startOutboxLoop();
    yield* Effect.sync(() => options.ready?.(url));
    return { url, tunnelUrl, remote, runner, scheduler };
  }).pipe(Effect.provide(NodeHttpServer.layerHttpServices));
}
