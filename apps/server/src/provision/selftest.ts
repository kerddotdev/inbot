import { Effect, Schema } from "effect";
import PostalMime from "postal-mime";
import type { InboundEnvelope } from "../../../../packages/envelope/src/frame.js";
import type { StoreService } from "../store.js";
import { unavailable } from "./errors.js";

const Probe = Schema.Struct({ domain_id: Schema.String, selftest_token: Schema.String });
export function observeSelfTest(
  store: StoreService,
  envelope: InboundEnvelope,
  raw: Uint8Array,
  receivedAt: string,
) {
  return Effect.gen(function* () {
    const address = envelope.rcpt_to.length === 1 ? envelope.rcpt_to[0]?.toLowerCase() : undefined;
    if (address === undefined || !address.startsWith("inbot-selftest@")) return false;
    const domain = address.slice("inbot-selftest@".length);
    const probe = yield* store.use((db) => {
      const row = db
        .prepare(
          "SELECT domain_id, selftest_token FROM domains WHERE domain = ? AND phase = 'ready' AND selftest_token IS NOT NULL AND selftest_sent_at IS NOT NULL",
        )
        .get(domain);
      return row === undefined ? undefined : Schema.decodeUnknownSync(Probe)(row);
    });
    if (probe === undefined) return false;
    const message = yield* Effect.tryPromise({
      try: () => PostalMime.parse(raw),
      catch: () => unavailable(),
    });
    const markers = message.headers.filter(
      (header) => header.key.toLowerCase() === "x-inbot-selftest",
    );
    if (
      markers.length !== 1 ||
      markers[0]?.value !== probe.selftest_token ||
      message.from?.address?.toLowerCase() !== address
    )
      return false;
    yield* store.use((db) => {
      db.prepare(
        "UPDATE domains SET selftest_received_at = coalesce(selftest_received_at, ?) WHERE domain_id = ? AND selftest_token = ? AND phase = 'ready'",
      ).run(receivedAt, probe.domain_id, probe.selftest_token);
    });
    return true;
  });
}
