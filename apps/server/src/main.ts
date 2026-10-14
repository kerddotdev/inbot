import { automaticUpdates } from "./update/automatic.js";
import { startWebhookLoop } from "./events/dispatcher.js";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Effect, Fiber, Layer } from "effect";
import { Drafts } from "./drafts/drafts.js";
import { ApiKeys } from "./auth/api-keys.js";
import { Home, resolveHome, type HomeOptions } from "./home.js";
import { startHttpServer } from "./http/server.js";
import { InboundConfig } from "./inbound/config.js";
import { startEventsLoop, startInboundLoop } from "./inbound/runtime.js";
import { KeychainStore } from "./keychain.js";
import { KeyManager } from "./keys.js";
import { Mailbox } from "./mailbox/mailbox.js";
import { Outbox } from "./outbound/outbox.js";
import { TransportConfig } from "./outbound/transport-config.js";
import { ConfiguredProvider } from "./outbound/runtime.js";
import { CloudflareApi } from "./provision/cloudflare-api.js";
import { PublicDns } from "./provision/dns.js";
import { Provisioner } from "./provision/provisioner.js";
import { startProvisionLoop } from "./provision/runtime.js";
import { RemoteAccess } from "./remote/remote.js";
import { startRemoteLoop } from "./remote/runtime.js";
import { Store } from "./store.js";
import { startupFailure } from "./startup-error.js";

function options():
  | (HomeOptions & {
      readonly port: number;
      readonly init: boolean;
      readonly memoryKeychain: boolean;
      readonly webRoot?: string;
    })
  | undefined {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      home: { type: "string" },
      "web-root": { type: "string" },
      port: { type: "string", default: "0" },
      init: { type: "boolean", default: false },
      flavor: { type: "string", default: "development" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return undefined;
  if (positionals.length !== 1 || positionals[0] !== "serve")
    throw new Error("Expected the serve command.");
  const flavor = values.flavor;
  if (flavor !== "development" && flavor !== "production")
    throw new Error("Flavor must be development or production.");
  if (!/^\d+$/.test(values.port ?? "")) throw new Error("Port must be an integer from 0 to 65535.");
  const port = Number(values.port);
  if (!Number.isInteger(port) || port > 65535)
    throw new Error("Port must be an integer from 0 to 65535.");
  const memoryKeychain = process.env.INBOT_TEST_MEMORY_KEYCHAIN === "1";
  if (memoryKeychain && (flavor === "production" || values.home === undefined))
    throw new Error("The test memory keychain requires development flavor and an explicit --home.");
  return {
    ...(values.home === undefined ? {} : { flag: values.home }),
    flavor,
    port,
    init: values.init,
    memoryKeychain,
    ...(values["web-root"] === undefined ? {} : { webRoot: resolve(values["web-root"]) }),
  };
}

async function serve() {
  const input = options();
  if (input === undefined) {
    process.stdout.write(
      "Usage: inbot serve --home <directory> [--port 0] [--init] [--web-root <directory>] [--flavor development|production]\n",
    );
    return;
  }
  if (input.memoryKeychain) {
    const path = resolveHome(input);
    const parent = await realpath(resolve(path, ".."));
    const canonical = await realpath(path).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return resolve(parent, basename(path));
      throw error;
    });
    if ([resolve(homedir(), ".inbot"), resolve(homedir(), ".inbot-dev")].includes(canonical))
      throw new Error("The test memory keychain cannot use a default Inbot home.");
  }
  const updateStop = Promise.withResolvers<void>();
  const updates = await automaticUpdates(resolveHome(input), updateStop.resolve);
  const home = Home.layer(input);
  const manager = KeyManager.Live.pipe(
    Layer.provideMerge(home),
    Layer.provide(input.memoryKeychain ? KeychainStore.memory() : KeychainStore.Live),
  );
  const stopped = Effect.callback<void>((resume) => {
    const stop = () => resume(Effect.void);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return Effect.sync(() => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    });
  });
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const keys = yield* KeyManager;
        const status = yield* keys.status();
        const unlock =
          input.init && !status.initialized
            ? keys.initialize({ useKeychain: true })
            : keys.unlockWithKeychain();
        const dek = yield* unlock;
        yield* Effect.addFinalizer(() => Effect.sync(() => dek.fill(0)));
        const store = Store.layer(dek);
        const config = TransportConfig.Live.pipe(Layer.provideMerge(store));
        const outbound = Outbox.Live.pipe(
          Layer.provide(ConfiguredProvider),
          Layer.provideMerge(config),
        );
        const baseServices = Layer.mergeAll(
          Mailbox.Live,
          ApiKeys.Live,
          InboundConfig.Live,
          Drafts.Live.pipe(Layer.provideMerge(outbound)),
        ).pipe(Layer.provideMerge(store));
        const provisionServices = Provisioner.Live.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              baseServices,
              PublicDns.live(),
              CloudflareApi.live().pipe(Layer.provide(config)),
            ),
          ),
        );
        const services = RemoteAccess.Live.pipe(
          Layer.provideMerge(provisionServices),
          Layer.provideMerge(config),
        );
        yield* Effect.gen(function* () {
          const server = yield* startHttpServer({
            updates: updates.state,
            port: input.port,
            ...(input.webRoot === undefined ? {} : { webRoot: input.webRoot }),
            setupRequired: (code) =>
              process.stdout.write(`${JSON.stringify({ event: "owner.setup_required", code })}\n`),
            ready: (url) =>
              process.stdout.write(`${JSON.stringify({ event: "server.ready", url })}\n`),
          });
          const inbound = yield* startInboundLoop();
          const events = yield* startEventsLoop();
          const provision = yield* startProvisionLoop();
          const webhooks = yield* startWebhookLoop();
          const remote = yield* startRemoteLoop();
          const runners = [
            inbound,
            events,
            provision,
            webhooks,
            remote,
            ...(server.runner === undefined ? [] : [server.runner]),
            ...(server.scheduler === undefined ? [] : [server.scheduler]),
          ];
          yield* Effect.addFinalizer(() => Effect.promise(() => updates.close()));
          yield* Effect.promise(() => updates.start());
          yield* Effect.raceFirst(
            Effect.raceFirst(
              stopped,
              Effect.promise(() => updateStop.promise),
            ),
            Effect.all(
              runners.map((runner) => Fiber.join(runner)),
              { concurrency: "unbounded" },
            ),
          );
        }).pipe(Effect.provide(services));
      }).pipe(Effect.provide(manager), Effect.scoped),
    );
  } catch (error) {
    await updates.abort();
    throw error;
  } finally {
    await updates.close();
  }
  if (await updates.applyAfterShutdown()) process.exitCode = 75;
}

void serve().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify(startupFailure(error))}\n`);
  process.exitCode = 1;
});
