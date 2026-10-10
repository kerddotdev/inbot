import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import { ErrorStatus, type ErrorResponse } from "../../../../packages/contracts/src/errors.js";
import { MailboxError } from "../mailbox/errors.js";

export function wireError<const C extends ErrorResponse["code"]>(
  code: C,
  message: string,
  fix: string,
): Omit<ErrorResponse, "code"> & { readonly code: C } {
  return { name: "InbotError", code, message, fix };
}

export function errorResponse(error: ErrorResponse) {
  return HttpServerResponse.jsonUnsafe(error, { status: ErrorStatus[error.code] });
}

export const unavailable = () =>
  errorResponse(
    wireError(
      "service_unavailable",
      "The service could not complete the request.",
      "Check that the local service is unlocked and available, then retry.",
    ),
  );

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
  return effect.pipe(
    Effect.catch((error) =>
      Effect.succeed(
        error instanceof MailboxError
          ? errorResponse(wireError(error.code, error.message, error.fix))
          : unavailable(),
      ),
    ),
  );
}
