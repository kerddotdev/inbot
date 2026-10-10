import { Schema } from "effect";
import { ErrorCode } from "../../../../packages/contracts/src/errors.js";

export class OutboundError extends Schema.TaggedError<OutboundError>()("OutboundError", {
  code: ErrorCode,
  message: Schema.String,
  fix: Schema.String,
  retryable: Schema.Boolean,
  outcome_unknown: Schema.optionalKey(Schema.Boolean),
  retry_after_ms: Schema.optionalKey(Schema.Finite),
}) {}

export function invalid(message = "The outbound request is invalid.") {
  return new OutboundError({
    code: "validation_error",
    message,
    fix: "Check recipients, body, attachments, and allowed headers.",
    retryable: false,
  });
}

export function tooLarge() {
  return new OutboundError({
    code: "payload_too_large",
    message: "The composed message exceeds 5 MiB.",
    fix: "Reduce body or attachment size, including base64 and MIME overhead.",
    retryable: false,
  });
}
