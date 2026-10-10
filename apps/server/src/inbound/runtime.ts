import { Clock, Effect } from "effect";
import { processDeliveryEvents } from "../outbound/events-puller.js";
import { processInbound, reconcileInbound } from "./puller.js";

export function startInboundLoop() {
  return Effect.gen(function* () {
    let nextReconcile = 0;
    while (true) {
      const report = yield* processInbound().pipe(
        Effect.catchTag("BufferError", () =>
          Effect.succeed({ processed: 0, status: "unavailable" }),
        ),
      );
      const now = yield* Clock.currentTimeMillis;
      if (report.status === "ready" && now >= nextReconcile) {
        yield* reconcileInbound().pipe(Effect.catchTag("BufferError", () => Effect.void));
        nextReconcile = now + 15 * 60 * 1000;
      }
      yield* Effect.sleep(report.processed === 0 ? "30 seconds" : "2 seconds");
    }
  }).pipe(Effect.forkScoped);
}

export function startEventsLoop() {
  return Effect.gen(function* () {
    while (true) {
      const report = yield* processDeliveryEvents().pipe(
        Effect.catchTag("BufferError", () => Effect.succeed({ processed: 0 })),
      );
      yield* Effect.sleep(report.processed === 0 ? "30 seconds" : "2 seconds");
    }
  }).pipe(Effect.forkScoped);
}
