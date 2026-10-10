import { Schema } from "effect";

export const InboundPointer = Schema.Struct({
  version: Schema.Literal(1),
  key: Schema.String.check(
    Schema.isPattern(
      /^inbound\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.age$/,
    ),
  ),
  size: Schema.Int.check(Schema.isBetween({ minimum: 32, maximum: Number.MAX_SAFE_INTEGER })),
  received_at: Schema.String.check(
    Schema.makeFilter((value) => {
      const date = new Date(value);
      return Number.isFinite(date.getTime()) && date.toISOString() === value
        ? undefined
        : "Expected an ISO UTC timestamp.";
    }),
  ),
});

export type InboundPointer = typeof InboundPointer.Type;

export { createInboundKey } from "./key.js";
