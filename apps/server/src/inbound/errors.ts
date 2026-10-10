import { Schema } from "effect";

export class InboundError extends Schema.TaggedError<InboundError>()("InboundError", {
  code: Schema.Literals([
    "payload_too_large",
    "invalid_payload",
    "invalid_mime",
    "extraction_failed",
  ]),
  message: Schema.String,
  fix: Schema.String,
}) {}
