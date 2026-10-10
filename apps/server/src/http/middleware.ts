import { Context, Effect, Layer, Redacted } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApiMiddleware } from "effect/http-api";
import {
  BearerAuth,
  CurrentPrincipal,
  OwnerOnly,
  RequiredPermission,
} from "../../../../packages/contracts/src/security.js";
import { ApiKeys, type ApiKeysService } from "../auth/api-keys.js";
import { OwnerAuth } from "../auth/owner.js";
import { WireErrors } from "./api.js";
import { inScope, permits } from "./authorization.js";
import { errorResponse, unavailable, wireError } from "./errors.js";

const unauthorized = () =>
  wireError(
    "unauthorized",
    "A valid bearer token is required.",
    "Read the local owner token from connection.json or supply an active API key.",
  );

export function authenticate(
  credential: Redacted.Redacted<string>,
  owner: OwnerAuth["Service"],
  keys: ApiKeysService,
) {
  return Effect.gen(function* () {
    const bearer = Redacted.value(credential);
    if (owner.authenticate(bearer)) return { kind: "owner" as const };
    const principal = yield* keys
      .authenticate(bearer)
      .pipe(Effect.catch(() => Effect.succeed(unavailable())));
    return principal ?? errorResponse(unauthorized());
  });
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
          if (
            !endpoint.middlewares.has(OwnerOnly) &&
            params.inbox_id !== undefined &&
            !inScope(principal, params.inbox_id)
          )
            return errorResponse(
              wireError(
                "not_found",
                "The requested mailbox resource was not found.",
                "Check the inbox and resource identifiers.",
              ),
            );
          const permission = Context.get(endpoint.annotations, RequiredPermission);
          if (permission !== undefined && !permits(principal, permission))
            return errorResponse(
              wireError(
                "missing_permission",
                "The API key does not permit this operation.",
                `Ask the owner for the ${permission} permission.`,
              ),
            );
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
