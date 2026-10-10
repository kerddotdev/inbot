import { Schema } from "effect";

export * from "./frame.js";
export const InboundEnvelope = Schema.Struct({
  mail_from: Schema.String,
  rcpt_to: Schema.Array(Schema.String),
});
