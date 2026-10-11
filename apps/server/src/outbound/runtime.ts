import { Effect, Layer, Redacted } from "effect";
import { OutboundProvider } from "./cloudflare.js";
import { Outbox } from "./outbox.js";
import { TransportConfig } from "./transport-config.js";
import { OutboundError } from "./errors.js";

function unavailable() {
  return new OutboundError({
    code: "service_unavailable",
    retryable: true,
    message: "The mail transport is unavailable.",
    fix: "Configure the Cloudflare mail transport",
  });
}

export const ConfiguredProvider = Layer.effect(
  OutboundProvider,
  Effect.gen(function* () {
    const config = yield* TransportConfig;
    return OutboundProvider.of({
      send: (message) =>
        Effect.gen(function* () {
          const settings = yield* config.get().pipe(Effect.mapError(unavailable));
          if (settings === undefined) return yield* unavailable();
          return yield* Effect.flatMap(OutboundProvider, (provider) => provider.send(message)).pipe(
            Effect.provide(
              OutboundProvider.live({
                account_id: settings.account_id,
                api_token: Redacted.value(settings.api_token),
              }),
            ),
          );
        }),
    });
  }),
);

export function startOutboxLoop() {
  return Effect.gen(function* () {
    const outbox = yield* Outbox;
    const config = yield* TransportConfig;
    return yield* Effect.gen(function* () {
      while (true) {
        const processed = (yield* config.get()) === undefined ? 0 : yield* outbox.processDue();
        yield* outbox.waitForWork(processed === 0 ? 30_000 : 2000);
      }
    }).pipe(Effect.forkScoped);
  });
}
