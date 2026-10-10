import { Schema } from "effect";
import { Timestamp } from "../../../../packages/contracts/src/common.js";

export const InboundPayload = Schema.Struct({
  mail_from: Schema.String,
  rcpt_to: Schema.Array(Schema.String),
  received_at: Timestamp,
});
export type InboundPayload = typeof InboundPayload.Type;
export type InboundInput = InboundPayload & { readonly raw: Uint8Array };
