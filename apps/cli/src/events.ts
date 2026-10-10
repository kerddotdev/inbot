import { parseArgs } from "node:util";
import { NodeSocket } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import { Socket } from "effect/socket";
import { WebSocketFrame, Subscribe } from "../../../packages/contracts/src/events.js";
import { connection } from "./client.js";
import { CliError, usage } from "./errors.js";
import { humanOutput } from "./output.js";
import type { CliIO } from "./cli.js";

export async function followEvents(args: readonly string[], io: CliIO) {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      home: { type: "string" },
      flavor: { type: "string" },
      json: { type: "boolean" },
      follow: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      "last-event-id": { type: "string" },
      inbox: { type: "string", multiple: true },
      "event-type": { type: "string", multiple: true },
    },
  });
  if (values.help) {
    io.stdout(
      "Usage: inbot events --follow [--json] [--last-event-id <id>] [--inbox <id>] [--event-type <type>] [--home <directory>]\n\nStream accessible events. Filters are repeatable. Resume after a previously received event ID. Ctrl-C stops the stream.\n",
    );
    return;
  }
  if (!values.follow || positionals.length !== 0)
    usage("Use inbot events --follow. Run inbot events --help.");
  const flavor = values.flavor ?? "development";
  if (flavor !== "development" && flavor !== "production")
    usage("--flavor must be development or production.");
  let subscription: Subscribe;
  try {
    subscription = Schema.decodeUnknownSync(Subscribe)({
      type: "subscribe",
      ...(values.inbox === undefined ? {} : { inbox_ids: values.inbox }),
      ...(values["event-type"] === undefined ? {} : { event_types: values["event-type"] }),
    });
  } catch {
    usage("Invalid event filters. Use contract event types and inbox IDs.");
  }
  const auth = await connection(
    { flavor, ...(values.home === undefined ? {} : { home: values.home }) },
    io.env,
  );
  const url = new URL("/v0/ws", auth.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (values["last-event-id"] !== undefined)
    url.searchParams.set("last_event_id", values["last-event-id"]);
  const stopped = Effect.callback<void>((resume) => {
    const stop = () => resume(Effect.void);
    if (io.signal?.aborted) {
      stop();
      return;
    }
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    io.signal?.addEventListener("abort", stop, { once: true });
    return Effect.sync(() => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      io.signal?.removeEventListener("abort", stop);
    });
  });
  const tail = Effect.gen(function* () {
    const construct = yield* Socket.WebSocketConstructor;
    const socket = yield* Socket.fromWebSocket(
      Effect.acquireRelease(
        Effect.sync(() =>
          construct(url.href, { headers: { authorization: `Bearer ${auth.token}` } }),
        ),
        (ws) => Effect.sync(() => ws.close(1000)),
      ),
    );
    const reader = yield* socket.reader;
    const writer = yield* socket.writer;
    yield* writer.write(JSON.stringify(subscription));
    while (true) {
      for (const chunk of yield* reader.pull) {
        const frame = yield* Effect.try({
          try: () =>
            Schema.decodeUnknownSync(WebSocketFrame)(
              JSON.parse(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)),
            ),
          catch: () => new Error("Invalid event frame"),
        });
        if (frame.type === "ping") yield* writer.write(JSON.stringify({ type: "pong" }));
        else if (frame.type === "event")
          yield* Effect.sync(() =>
            io.stdout(values.json ? `${JSON.stringify(frame)}\n` : humanOutput(frame)),
          );
      }
    }
  }).pipe(Effect.scoped);
  try {
    await Effect.runPromise(
      Effect.raceFirst(tail, stopped).pipe(Effect.provide(NodeSocket.layerWebSocketConstructorWS)),
    );
  } catch {
    throw new CliError(
      {
        code: "service_unavailable",
        message: "The event connection closed or could not authenticate.",
        fix: "Check the active grant and service, then resume with --last-event-id from the last event received.",
      },
      10,
    );
  }
}
