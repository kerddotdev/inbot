import { randomBytes } from "node:crypto";
import { Clock, Context, Effect, Exit, Layer, Scope } from "effect";
import { encrypt, frameInbound } from "../../../../packages/envelope/src/index.js";
import { Home } from "../home.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { OutboundProvider } from "../outbound/cloudflare.js";
import { Outbox } from "../outbound/outbox.js";
import { TransportConfig } from "../outbound/transport-config.js";
import { Store } from "../store.js";
import { InboundBuffer, memoryBuffer } from "./cloudflare.js";
import { InboundConfig } from "./config.js";
import { bufferState } from "./state.js";

export const inbox = "agent@example.test";
export const receivedAt = "2026-10-10T12:00:00.000Z";
const initialNow = Date.parse(receivedAt);
export const config = {
  account_id: "fake-account",
  bucket: "fake-bucket",
  inbound_queue_id: "inbound-queue",
  events_queue_id: "events-queue",
};
export const key = (index: number) =>
  `inbound/01a1269c-73cc-7dd9-8d18-${String(index).padStart(12, "0")}.age`;
const raw = Buffer.from(
  [
    "Message-ID: <inbound@example.test>",
    "From: alice@example.test",
    `To: ${inbox}`,
    "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=example.test",
    "Subject: Synthetic inbound",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Synthetic body.",
  ].join("\r\n"),
);

export async function fixture(home: string) {
  const scope = Scope.makeUnsafe();
  const dek = randomBytes(32);
  const time = { now: initialNow };
  const buffer = memoryBuffer();
  const liveClock = Context.get(Context.empty(), Clock.Clock);
  const clock: Clock.Clock = {
    sleep: (duration) => liveClock.sleep(duration),
    monotonicTimeNanosUnsafe: () => liveClock.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: liveClock.monotonicTimeNanos,
    currentTimeMillisUnsafe: () => time.now,
    currentTimeMillis: Effect.sync(() => time.now),
    currentTimeNanosUnsafe: () => BigInt(time.now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(time.now) * 1_000_000n),
  };
  const services = Layer.mergeAll(
    Mailbox.Live,
    InboundConfig.Live,
    TransportConfig.Live,
    Outbox.Live,
  ).pipe(
    Layer.provideMerge(
      Store.layer(dek).pipe(Layer.provide(Home.layer({ flag: home, flavor: "development" }))),
    ),
    Layer.provide(
      OutboundProvider.fake(() =>
        Effect.succeed({ provider_message_id: "<provider@example.test>" }),
      ),
    ),
  );
  try {
    const context = await Effect.runPromise(
      Layer.buildWithScope(services, scope).pipe(Effect.provideService(Scope.Scope, scope)),
    );
    const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provideService(Clock.Clock, clock),
          Effect.provideService(Scope.Scope, scope),
        ),
      );
    const process = <A, E>(effect: Effect.Effect<A, E, InboundConfig | Mailbox | Scope.Scope>) =>
      run(
        effect.pipe(
          Effect.provideContext(context),
          Effect.provideService(InboundBuffer, buffer.service),
        ),
      );
    const mailbox = Context.get(context, Mailbox);
    const store = Context.get(context, Store);
    const inbound = Context.get(context, InboundConfig);
    const transport = Context.get(context, TransportConfig);
    const outbox = Context.get(context, Outbox);
    await run(mailbox.createInbox({ username: "agent", domain: "example.test" }));
    await run(inbound.set(config));
    await run(transport.set({ account_id: config.account_id, api_token: "synthetic-token" }));
    const recipient = await run(inbound.getRecipient());
    if (recipient === undefined) throw new Error("Expected an inbound recipient");
    return {
      run,
      process,
      context,
      clock,
      time,
      buffer,
      mailbox,
      store,
      inbound,
      transport,
      outbox,
      state: bufferState(store, config.account_id, config.bucket),
      put: async (
        index: number,
        options: {
          pointer?: boolean;
          received_at?: string;
          bytes?: Uint8Array;
          recipient?: string;
          mime?: Uint8Array;
        } = {},
      ) => {
        const source = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(options.mime ?? raw);
            controller.close();
          },
        });
        const frame = frameInbound({ mail_from: "alice@example.test", rcpt_to: [inbox] }, source);
        const bytes =
          options.bytes ??
          new Uint8Array(
            await new Response(
              await encrypt(options.recipient ?? recipient, frame.stream),
            ).arrayBuffer(),
          );
        const received_at = options.received_at ?? receivedAt;
        buffer.putObject(key(index), bytes, received_at);
        const pointer = { version: 1, key: key(index), size: bytes.byteLength, received_at };
        if (options.pointer !== false) buffer.push(config.inbound_queue_id, pointer);
        return { bytes, pointer };
      },
      close: async () => {
        await Effect.runPromise(Scope.close(scope, Exit.void));
        dek.fill(0);
      },
    };
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    dek.fill(0);
    throw error;
  }
}
