import { Context, Schema } from "effect";
import { HttpApiMiddleware, HttpApiSecurity } from "effect/http-api";
import { Grant, type Permission } from "./api-keys.js";
import { ForbiddenError, UnauthorizedError } from "./errors.js";

export const Principal = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("owner") }),
  Schema.Struct({ kind: Schema.Literal("agent"), api_key_id: Schema.String, grant: Grant }),
]);
export type Principal = typeof Principal.Type;

export const RequiredPermission = Context.Reference<Permission | undefined>(
  "inbot/RequiredPermission",
  { defaultValue: () => undefined },
);

export class CurrentPrincipal extends Context.Service<CurrentPrincipal, Principal>()(
  "inbot/CurrentPrincipal",
) {}

export class BearerAuth extends HttpApiMiddleware.Service<
  BearerAuth,
  { provides: CurrentPrincipal }
>()("inbot/BearerAuth", {
  security: { Bearer: HttpApiSecurity.bearer },
  error: UnauthorizedError,
}) {}

export class OwnerOnly extends HttpApiMiddleware.Service<
  OwnerOnly,
  { requires: CurrentPrincipal }
>()("inbot/OwnerOnly", { error: ForbiddenError }) {}
