import { Effect, Schema } from "effect";
import { DeliveryEvent } from "../../../../packages/contracts/src/outbound.js";
import { Timestamp } from "../../../../packages/contracts/src/common.js";
import { invalid } from "./errors.js";

const eventStatuses = {
  "cf.email.sending.message.delivered": "delivered",
  "cf.email.sending.message.bounced": "bounced",
  "cf.email.sending.message.complained": "complained",
  "cf.email.sending.message.failed": "failed",
  "cf.email.sending.message.rejected": "rejected",
  "cf.email.sending.message.deferred": "deferred",
} as const;

const CloudflareEvent = Schema.Struct({
  type: Schema.Literals(Object.keys(eventStatuses)),
  source: Schema.Struct({ type: Schema.Literal("email.sending") }),
  payload: Schema.Struct({
    eventId: Schema.String.check(Schema.isMinLength(1)),
    messageId: Schema.String.check(Schema.isMinLength(1)),
    recipient: Schema.String.check(Schema.isMinLength(1)),
  }),
  metadata: Schema.Struct({ eventSchemaVersion: Schema.Literal(1), eventTimestamp: Timestamp }),
});

export function parseDeliveryEvent(payload: unknown) {
  return Effect.try({
    try: () => {
      const event = Schema.decodeUnknownSync(CloudflareEvent)(payload);
      const status = Object.entries(eventStatuses).find(([type]) => type === event.type)?.[1];
      if (status === undefined) throw invalid();
      return Schema.decodeUnknownSync(DeliveryEvent)({
        event_id: event.payload.eventId,
        provider_message_id: event.payload.messageId,
        recipient: event.payload.recipient,
        status,
        timestamp: event.metadata.eventTimestamp,
      });
    },
    catch: () =>
      invalid("The delivery event has an unsupported type, version, or invalid envelope."),
  });
}
