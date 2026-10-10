import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Clock, Context, Effect, Exit, Layer, Schema, Scope } from "effect";
import { Drafts } from "../drafts/drafts.js";
import { ApiKeys } from "../auth/api-keys.js";
import { Connection } from "../auth/owner.js";
import { Home } from "../home.js";
import { ingestInbound } from "../inbound/ingest.js";
import { KeychainStore } from "../keychain.js";
import { KeyManager } from "../keys.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { Outbox, type OutboxService } from "../outbound/outbox.js";
import { OutboundProvider, type ProviderMessage } from "../outbound/cloudflare.js";
import { TransportConfig } from "../outbound/transport-config.js";
import { Store } from "../store.js";
import { InboundConfig } from "../inbound/config.js";
import { memoryBuffer } from "../inbound/cloudflare.js";
import { fakeCloudflare } from "../provision/fake-cloudflare.js";
import { makeProvisioner, Provisioner } from "../provision/provisioner.js";
import { startHttpServer } from "./server.js";

const inboxId = "agent@example.test";

export async function fixture(home: string, options: { readonly webRoot?: string } = {}) {
  const scope = Scope.makeUnsafe();
  let now = Date.parse("2026-10-10T12:00:00Z");
  const sent: ProviderMessage[] = [];
  const liveClock = Context.get(Context.empty(), Clock.Clock);
  const clock: Clock.Clock = {
    sleep: (duration) => liveClock.sleep(duration),
    monotonicTimeNanosUnsafe: () => liveClock.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: liveClock.monotonicTimeNanos,
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
  };
  const run = <A, E, R>(
    effect: Effect.Effect<A, E, R | Scope.Scope>,
    context: Context.Context<R>,
  ) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideContext(context),
        Effect.provideService(Scope.Scope, scope),
        Effect.provideService(Clock.Clock, clock),
      ),
    );
  try {
    const foundation = await run(
      Layer.buildWithScope(
        KeyManager.Live.pipe(
          Layer.provideMerge(Home.layer({ flag: home, flavor: "development" })),
          Layer.provide(KeychainStore.memory()),
        ),
        scope,
      ),
      Context.empty(),
    );
    const dek = await run(
      Context.get(foundation, KeyManager).initialize({ useKeychain: true }),
      Context.empty(),
    );
    const outbound = Outbox.Live.pipe(
      Layer.provide(
        OutboundProvider.fake((message) =>
          Effect.sync(() => {
            sent.push(message);
            return { provider_message_id: `<fake-${sent.length}@example.test>` };
          }),
        ),
      ),
    );
    const baseServices = await run(
      Layer.buildWithScope(
        Layer.mergeAll(
          Mailbox.Live,
          ApiKeys.Live,
          TransportConfig.Live,
          InboundConfig.Live,
          Drafts.Live.pipe(Layer.provideMerge(outbound)),
        ).pipe(
          Layer.provideMerge(TransportConfig.Live),
          Layer.provideMerge(Store.layer(dek)),
          Layer.provideMerge(Layer.succeedContext(foundation)),
        ),
        scope,
      ),
      Context.empty(),
    );
    const cloud = fakeCloudflare();
    const provisioner = makeProvisioner({
      store: Context.get(baseServices, Store),
      api: cloud.service,
      buffer: memoryBuffer().service,
      dns: { check: (records) => Effect.succeed(records) },
      inbound: Context.get(baseServices, InboundConfig),
      transport: Context.get(baseServices, TransportConfig),
      mailbox: Context.get(baseServices, Mailbox),
      readWorker: async () => "export default { email() {} };",
    });
    const services = Context.add(baseServices, Provisioner, provisioner);
    dek.fill(0);
    let setupCode: string | undefined;
    const server = await run(
      startHttpServer({
        runOutbox: false,
        ...options,
        setupRequired: (code) => {
          setupCode = code;
        },
      }),
      services,
    );
    const connection = Schema.decodeUnknownSync(Schema.fromJsonString(Connection))(
      await readFile(join(home, "connection.json"), "utf8"),
    );
    const mailbox = Context.get(services, Mailbox);
    const keys = Context.get(services, ApiKeys);
    await run(mailbox.createInbox({ username: "agent", domain: "example.test" }), Context.empty());
    await run(mailbox.createInbox({ username: "other", domain: "example.test" }), Context.empty());
    const raw = Buffer.from(
      [
        "Message-ID: <first@example.test>",
        "Date: Sat, 10 Oct 2026 10:00:00 +0000",
        "From: Alice <alice@example.test>",
        `To: ${inboxId}`,
        "Subject: Synthetic project update",
        "Authentication-Results: mx.example.test; dkim=pass header.d=example.test",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "A searchable project message.",
      ].join("\r\n"),
    );
    const ingested = await run(
      ingestInbound(
        {
          raw,
          mail_from: "alice@example.test",
          rcpt_to: [inboxId],
          received_at: "2026-10-10T10:00:01Z",
        },
        {
          trusted_authserv_ids: ["mx.example.test"],
        },
      ),
      services,
    );
    const stored = ingested[0];
    if (stored?.status !== "stored") throw new Error("Expected a stored synthetic message");
    return {
      home,
      setupCode,
      cloud,
      provisioner,
      url: server.url,
      token: connection.token,
      raw,
      threadId: stored.thread_id,
      mailbox,
      keys,
      store: Context.get(services, Store),
      outbox: Context.get(services, Outbox),
      drafts: Context.get(services, Drafts),
      transport: Context.get(services, TransportConfig),
      sent,
      start: async (outbox: OutboxService, clock: Clock.Clock, runScheduler = false) => {
        const serverScope = Scope.makeUnsafe();
        try {
          const started = await run(
            startHttpServer({ runScheduler }).pipe(
              Effect.provideService(Outbox, outbox),
              Effect.provideService(Clock.Clock, clock),
              Effect.provideService(Scope.Scope, serverScope),
            ),
            services,
          );
          return {
            ...started,
            close: () => Effect.runPromise(Scope.close(serverScope, Exit.void)),
          };
        } catch (error) {
          await Effect.runPromise(Scope.close(serverScope, Exit.void));
          throw error;
        }
      },
      restart: async () => {
        const serverScope = Scope.makeUnsafe();
        let code: string | undefined;
        try {
          const started = await run(
            startHttpServer({
              runOutbox: false,
              setupRequired: (value) => {
                code = value;
              },
            }).pipe(Effect.provideService(Scope.Scope, serverScope)),
            services,
          );
          return {
            ...started,
            setupCode: code,
            close: () => Effect.runPromise(Scope.close(serverScope, Exit.void)),
          };
        } catch (error) {
          await Effect.runPromise(Scope.close(serverScope, Exit.void));
          throw error;
        }
      },
      run: <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => run(effect, Context.empty()),
      advance: (milliseconds: number) => {
        now += milliseconds;
      },
      request: (
        path: string,
        options: {
          token?: string | null;
          method?: string;
          body?: unknown;
          headers?: Record<string, string>;
        } = {},
      ) =>
        fetch(`${server.url}${path}`, {
          method: options.method ?? "GET",
          headers: {
            ...(options.token === null
              ? {}
              : { authorization: `Bearer ${options.token ?? connection.token}` }),
            ...(options.body === undefined ? {} : { "content-type": "application/json" }),
            ...options.headers,
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        }),
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    };
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  }
}
