import { Effect, Option, Result, Schema } from "effect";
import { decodeQueueBody, retryDelay } from "../inbound/cloudflare.js";
import { configuredBuffer, loadBufferSettings } from "../inbound/settings.js";
import { bufferState } from "../inbound/state.js";
import { parseDeliveryEvent, supportedDeliveryEventTypes } from "./delivery.js";
import { Outbox } from "./outbox.js";
const EventType = Schema.Struct({ type: Schema.String });

export function processDeliveryEvents() {
  return Effect.gen(function* () {
    const loaded = yield* loadBufferSettings();
    if (loaded.status !== "ready")
      return {
        status: loaded.status,
        processed: 0,
        applied: 0,
        unknown: 0,
        quarantined: 0,
        retried: 0,
      };
    const outbox = yield* Effect.serviceOption(Outbox);
    if (Option.isNone(outbox))
      return { status: "locked", processed: 0, applied: 0, unknown: 0, quarantined: 0, retried: 0 };
    const config = loaded.settings;
    const buffer = yield* configuredBuffer(loaded);
    const state = bufferState(loaded.store, config.account_id, config.bucket);
    const batch = yield* buffer.pull(config.events_queue_id);
    let processed = 0;
    let applied = 0;
    let unknown = 0;
    let quarantined = 0;
    let retried = 0;
    for (const message of batch) {
      const result = yield* Effect.gen(function* () {
        const payload = yield* Effect.try({
          try: () => decodeQueueBody(message.body),
          catch: () => "invalid_event" as const,
        }).pipe(Effect.result);
        const type = Result.isSuccess(payload)
          ? Schema.decodeUnknownResult(EventType)(payload.success)
          : undefined;
        if (
          type !== undefined &&
          Result.isSuccess(type) &&
          !supportedDeliveryEventTypes.includes(type.success.type)
        ) {
          yield* buffer.ack(config.events_queue_id, message.lease_id);
          return "unknown" as const;
        }
        const event = Result.isSuccess(payload)
          ? yield* parseDeliveryEvent(payload.success).pipe(Effect.result)
          : undefined;
        if (event === undefined || Result.isFailure(event)) {
          yield* state.quarantineMessage(config.events_queue_id, message.id, "invalid_event");
          yield* buffer.ack(config.events_queue_id, message.lease_id);
          return "quarantined" as const;
        }
        const matched = yield* outbox.value.applyDeliveryEvent(event.success);
        yield* buffer.ack(config.events_queue_id, message.lease_id);
        return matched ? ("applied" as const) : ("unmatched" as const);
      }).pipe(Effect.result);
      if (Result.isFailure(result)) {
        retried++;
        yield* buffer
          .retry(config.events_queue_id, message.lease_id, retryDelay(message.attempts))
          .pipe(Effect.catch(() => Effect.void));
      } else {
        processed++;
        if (result.success === "applied") applied++;
        if (result.success === "unknown") unknown++;
        if (result.success === "quarantined") quarantined++;
      }
    }
    return { status: "ready", processed, applied, unknown, quarantined, retried };
  });
}
