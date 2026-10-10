import { Context, Effect, Layer, Redacted, Result } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApiMiddleware } from "effect/http-api";
import {
  BearerAuth,
  CurrentPrincipal,
  OwnerOnly,
  RequiredPermission,
} from "../../../../packages/contracts/src/security.js";
import { authenticatePrincipal } from "../auth/bearer.js";
import { ApiKeys, type ApiKeysService } from "../auth/api-keys.js";
import { OwnerAuth } from "../auth/owner.js";
import { WireErrors } from "./api.js";
import { authorize } from "../agent/authorization.js";
import { errorResponse, unavailable, wireError, wireFailure } from "./errors.js";

export function authenticate(
  credential: Redacted.Redacted<string>,
  owner: OwnerAuth["Service"],
  keys: ApiKeysService,
) {
  return authenticatePrincipal(credential, owner, keys).pipe(
    Effect.catch((error) => Effect.succeed(errorResponse(wireFailure(error)))),
  );
}

export const AuthLive = Layer.effect(
  BearerAuth,
  Effect.gen(function* () {
    const owner = yield* OwnerAuth;
    const keys = yield* ApiKeys;
    return BearerAuth.of({
      Bearer: (httpEffect, { credential, endpoint }) =>
        Effect.gen(function* () {
          const principal = yield* authenticate(credential, owner, keys);
          if (HttpServerResponse.isHttpServerResponse(principal)) return principal;
          const params = yield* HttpRouter.params;
          const permission = Context.get(endpoint.annotations, RequiredPermission);
          if (permission !== undefined) {
            const authorization = yield* authorize(
              permission,
              endpoint.middlewares.has(OwnerOnly) ? undefined : params.inbox_id,
            ).pipe(Effect.provideService(CurrentPrincipal, principal), Effect.result);
            if (Result.isFailure(authorization)) {
              const error = authorization.failure;
              return errorResponse(
                wireError(error.code, error.message, error.fix ?? "Check the API key grant."),
              );
            }
          }
          return yield* Effect.provideService(httpEffect, CurrentPrincipal, principal);
        }),
    });
  }),
);

export const OwnerOnlyLive = Layer.succeed(
  OwnerOnly,
  OwnerOnly.of((httpEffect) =>
    Effect.gen(function* () {
      if ((yield* CurrentPrincipal).kind !== "owner")
        return yield* Effect.fail(
          wireError(
            "missing_permission",
            "This operation requires owner authentication.",
            "Use the local owner token from connection.json.",
          ),
        );
      return yield* httpEffect;
    }),
  ),
);

export const WireErrorsLive = HttpApiMiddleware.layerSchemaErrorTransform(WireErrors, (error) =>
  Effect.succeed(
    error.kind === "Body" || error.kind === "ResponseHeaders"
      ? unavailable()
      : errorResponse(
          wireError(
            "validation_error",
            `The request ${error.kind.toLowerCase()} does not match the API schema.`,
            "Check field names and types, query values, and JSON syntax against the API contract.",
          ),
        ),
  ),
);
