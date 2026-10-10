import { Effect, Option, type Redacted } from "effect";
import { Store } from "../store.js";
import { TransportConfig } from "../outbound/transport-config.js";
import { InboundConfig } from "./config.js";
import { BufferError, InboundBuffer } from "./cloudflare.js";

export function loadBufferSettings() {
  return Effect.gen(function* () {
    const store = yield* Effect.serviceOption(Store);
    const config = yield* Effect.serviceOption(InboundConfig);
    const transport = yield* Effect.serviceOption(TransportConfig);
    if (Option.isNone(store) || Option.isNone(config) || Option.isNone(transport))
      return { status: "locked" } as const;
    const settings = yield* config.value.get();
    const token = yield* transport.value.get();
    if (settings === undefined || token === undefined) return { status: "no_config" } as const;
    if (settings.account_id !== token.account_id)
      return yield* new BufferError({ code: "invalid_config" });
    return { status: "ready", settings, token: token.api_token, store: store.value } as const;
  });
}
export function configuredBuffer(settings: {
  readonly settings: { readonly account_id: string; readonly bucket: string };
  readonly token: Redacted.Redacted<string>;
}) {
  return Effect.gen(function* () {
    const buffer = yield* Effect.serviceOption(InboundBuffer);
    if (Option.isSome(buffer)) return buffer.value;
    return yield* InboundBuffer.pipe(
      Effect.provide(InboundBuffer.live({ ...settings.settings, api_token: settings.token })),
    );
  });
}
