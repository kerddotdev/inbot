import { ByteSize, Cause, Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import type {
  ProtectedResourceMetadata,
  AuthorizationServerMetadata,
} from "../../../../packages/contracts/src/oauth.js";
import { OAuth, OAuthError } from "../oauth/service.js";
import { ServerApi } from "./api.js";
import { CurrentOwnerSession, CurrentRequestOrigin } from "./owner-session.js";
import { respond, errorResponse, wireError, unavailable } from "./errors.js";
import { staticWeb } from "./static.js";

export function publicOAuthPath(path: string) {
  return [
    "/oauth/register",
    "/oauth/token",
    "/oauth/revoke",
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-protected-resource/v0",
  ].includes(path);
}
export const oauthCorsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization",
};
const headers = { "cache-control": "no-store", pragma: "no-cache" };
export const OAuthHandlers = HttpApiBuilder.group(ServerApi, "oauth-owner", (handlers) =>
  Effect.gen(function* () {
    const oauth = yield* OAuth;
    return handlers
      .handle("oauth_clients", () => respond(oauth.clients()))
      .handle("oauth_purge", () => respond(oauth.purge()))
      .handle("oauth_revokeGrant", ({ params }) => respond(oauth.revokeGrant(params.grant_id)));
  }),
);

function parameters(text: string) {
  const params = new URLSearchParams(text);
  const result = new Map<string, string>();
  for (const [key, value] of params) {
    if (result.has(key))
      throw new OAuthError("invalid_request", "OAuth parameters must not be repeated.");
    result.set(key, value);
  }
  return Object.fromEntries(result);
}

export function oauthRoutes(loopbackOrigin: string, webRoot?: string) {
  return HttpRouter.use((router) =>
    Effect.gen(function* () {
      const oauth = yield* OAuth;
      const web = yield* staticWeb(webRoot);
      const origin = Effect.map(CurrentRequestOrigin, (value) => value ?? loopbackOrigin);
      const endpoint = <A, E, R>(effect: Effect.Effect<A, E, R>, redirectErrors = false) =>
        effect.pipe(
          Effect.catch((error) =>
            Effect.succeed(
              error instanceof OAuthError
                ? redirectErrors && error.redirect_uri !== undefined
                  ? HttpServerResponse.redirect(error.redirect_uri)
                  : HttpServerResponse.jsonUnsafe(
                      { error: error.code, error_description: error.message },
                      {
                        status: error.status,
                        headers: {
                          ...headers,
                          ...(error.status === 429 ? { "retry-after": "60" } : {}),
                        },
                      },
                    )
                : unavailable(),
            ),
          ),
          Effect.map((response) =>
            HttpServerResponse.isHttpServerResponse(response)
              ? HttpServerResponse.setHeaders(response, headers)
              : HttpServerResponse.jsonUnsafe(response, { headers }),
          ),
        );
      const body = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const text = yield* request.text.pipe(
          Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.kibibytes(16)),
        );
        if (Buffer.byteLength(text) > 16_384)
          throw new OAuthError("invalid_request", "The OAuth request is too large.");
        try {
          if (request.headers["content-type"]?.split(";")[0] === "application/json") {
            const value: unknown = JSON.parse(text);
            return value;
          }
          if (
            request.headers["content-type"]?.split(";")[0] === "application/x-www-form-urlencoded"
          )
            return parameters(text);
        } catch (error) {
          if (error instanceof OAuthError) throw error;
        }
        throw new OAuthError(
          "invalid_request",
          "Send JSON or an application/x-www-form-urlencoded request.",
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.fail(
                new OAuthError("invalid_request", "The OAuth request body could not be decoded."),
              ),
        ),
      );
      const publicBody = body.pipe(Effect.catch(() => Effect.succeed(undefined)));
      const ownerSession = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* CurrentOwnerSession;
        const requestOrigin = (yield* CurrentRequestOrigin) ?? loopbackOrigin;
        if (
          session === undefined ||
          request.headers.authorization !== undefined ||
          request.headers.origin !== requestOrigin
        )
          return yield* Effect.fail(
            new OAuthError(
              "access_denied",
              "Owner consent requires a browser session and the exact server Origin.",
              403,
            ),
          );
      });
      yield* router.add(
        "GET",
        "/.well-known/oauth-authorization-server",
        endpoint(
          Effect.gen(function* () {
            const base = yield* origin;
            return {
              issuer: base,
              authorization_endpoint: `${base}/oauth/authorize`,
              token_endpoint: `${base}/oauth/token`,
              registration_endpoint: `${base}/oauth/register`,
              revocation_endpoint: `${base}/oauth/revoke`,
              response_types_supported: ["code"],
              grant_types_supported: ["authorization_code", "refresh_token"],
              token_endpoint_auth_methods_supported: ["none"],
              revocation_endpoint_auth_methods_supported: ["none"],
              code_challenge_methods_supported: ["S256"],
              scopes_supported: ["inbot"],
              resource_indicators_supported: true,
              authorization_response_iss_parameter_supported: true,
            } satisfies AuthorizationServerMetadata;
          }),
        ),
      );
      for (const path of ["", "/mcp", "/v0"])
        yield* router.add(
          "GET",
          `/.well-known/oauth-protected-resource${path}`,
          endpoint(
            Effect.gen(function* () {
              const base = yield* origin;
              return {
                resource: `${base}${path}`,
                authorization_servers: [base],
                bearer_methods_supported: ["header"],
                scopes_supported: ["inbot"],
              } satisfies ProtectedResourceMetadata;
            }),
          ),
        );
      yield* router.add(
        "POST",
        "/oauth/register",
        endpoint(
          Effect.gen(function* () {
            const registered = yield* oauth.register(yield* publicBody);
            return HttpServerResponse.jsonUnsafe(registered, { status: 201, headers });
          }),
        ),
      );
      yield* router.add(
        "POST",
        "/oauth/token",
        endpoint(
          Effect.gen(function* () {
            return yield* oauth.token(yield* publicBody, yield* origin);
          }),
        ),
      );
      yield* router.add(
        "POST",
        "/oauth/revoke",
        endpoint(
          Effect.gen(function* () {
            yield* oauth.revoke(yield* publicBody);
            return HttpServerResponse.empty({ status: 200 });
          }),
        ),
      );
      yield* router.add(
        "GET",
        "/oauth/authorize",
        endpoint(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const query = request.url.split("?")[1] ?? "";
            const input = yield* Effect.try({
              try: () => parameters(query),
              catch: () => new OAuthError("invalid_request", "Invalid authorization parameters."),
            });
            yield* oauth.inspectAuthorization(input, yield* origin);
            if ((yield* CurrentOwnerSession) === undefined)
              return HttpServerResponse.redirect(`/login?authorize=${encodeURIComponent(query)}`);
            if (web === undefined)
              return errorResponse(
                wireError(
                  "not_supported",
                  "The owner consent UI is unavailable.",
                  "Start Inbot with --web-root pointing to the owner web bundle.",
                ),
              );
            return (yield* web("/", "GET")) ?? unavailable();
          }),
          true,
        ),
      );
      yield* router.add(
        "POST",
        "/oauth/authorize/details",
        endpoint(
          Effect.gen(function* () {
            yield* ownerSession;
            return yield* oauth.inspectAuthorization(yield* body, yield* origin);
          }),
        ),
      );
      yield* router.add(
        "POST",
        "/oauth/authorize",
        endpoint(
          Effect.gen(function* () {
            yield* ownerSession;
            return yield* oauth.consent(yield* body, yield* origin);
          }),
        ),
      );
    }),
  );
}
