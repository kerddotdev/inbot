import { Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { ErrorStatus, ErrorResponse } from "../../../../packages/contracts/src/errors.js";
import { MailboxError } from "../mailbox/errors.js";
import { OutboundError } from "../outbound/errors.js";
import { ProvisionError } from "../provision/errors.js";

export function wireError<const C extends ErrorResponse["code"]>(
  code: C,
  message: string,
  fix: string,
): Omit<ErrorResponse, "code"> & { readonly code: C } {
  return { name: "InbotError", code, message, fix };
}

export function errorResponse(error: ErrorResponse) {
  return HttpServerResponse.jsonUnsafe(error, {
    status: ErrorStatus[error.code],
    ...(error.code === "unauthorized" ? { headers: { "www-authenticate": "Bearer" } } : {}),
  });
}

export function wireFailure(error: unknown): ErrorResponse {
  if (
    error instanceof MailboxError ||
    error instanceof OutboundError ||
    error instanceof ProvisionError
  )
    return wireError(error.code, error.message, error.fix);
  if (Schema.is(ErrorResponse)(error)) return error;
  return wireError(
    "service_unavailable",
    "The service could not complete the request.",
    "Check that the local service is unlocked and available, then retry.",
  );
}

export const unavailable = () => errorResponse(wireFailure(undefined));

export const unsupported = () =>
  Effect.succeed(
    errorResponse(
      wireError(
        "not_supported",
        "This operation is not implemented by this Inbot version.",
        "Use an implemented mailbox operation or upgrade when this capability is available.",
      ),
    ),
  );

export function respond<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(Effect.catch((error) => Effect.succeed(errorResponse(wireFailure(error)))));
}
