import { Clock, Context, Effect, Layer, Redacted, Schema } from "effect";
import {
  maxInboundFrameOverhead,
  maxMessageSize,
} from "../../../../packages/envelope/src/index.js";

export class BufferError extends Schema.TaggedError<BufferError>()("BufferError", {
  code: Schema.Literals([
    "buffer_unavailable",
    "object_missing",
    "object_too_large",
    "invalid_config",
    "identity_failed",
  ]),
}) {
  readonly message = "The Cloudflare buffer operation could not be completed.";
  readonly fix =
    "Check buffer configuration, credentials, permissions, and retry transient failures.";
}
export const QueueMessage = Schema.Struct({
  id: Schema.String,
  lease_id: Schema.String,
  body: Schema.String,
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type QueueMessage = typeof QueueMessage.Type;
export const BufferObject = Schema.Struct({
  key: Schema.String,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  last_modified: Schema.String.check(
    Schema.makeFilter((value) =>
      Number.isFinite(Date.parse(value)) ? undefined : "Expected a timestamp.",
    ),
  ),
});
export type BufferObject = typeof BufferObject.Type;
export const visibilityTimeoutMs = 300_000;
export const batchSize = 5;
export const maxCiphertextSize = maxMessageSize + maxInboundFrameOverhead + 64 * 1024;

export interface InboundBufferService {
  readonly pull: (queueId: string) => Effect.Effect<readonly QueueMessage[], BufferError>;
  readonly ack: (queueId: string, leaseId: string) => Effect.Effect<void, BufferError>;
  readonly retry: (
    queueId: string,
    leaseId: string,
    delaySeconds: number,
  ) => Effect.Effect<void, BufferError>;
  readonly getObject: (key: string) => Effect.Effect<Uint8Array, BufferError>;
  readonly deleteObject: (key: string) => Effect.Effect<void, BufferError>;
  readonly listObjects: (
    prefix: string,
    cursor?: string,
  ) => Effect.Effect<
    { readonly objects: readonly BufferObject[]; readonly cursor?: string },
    BufferError
  >;
}
const PullResponse = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({ messages: Schema.Array(QueueMessage) }),
});
const MutationResponse = Schema.Struct({ success: Schema.Literal(true) });
const AckResponse = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({ ackCount: Schema.Int, retryCount: Schema.Int }),
});
const ListResponse = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Array(BufferObject),
  result_info: Schema.optionalKey(
    Schema.Struct({
      cursor: Schema.optionalKey(Schema.String),
      is_truncated: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export function decodeQueueBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return JSON.parse(Buffer.from(body, "base64").toString("utf8"));
  }
}
export function retryDelay(attempts: number) {
  return Math.min(3600, 5 * 2 ** Math.min(attempts, 10));
}

export class InboundBuffer extends Context.Service<InboundBuffer, InboundBufferService>()(
  "inbot/InboundBuffer",
) {
  static live(config: {
    readonly account_id: string;
    readonly bucket: string;
    readonly api_token: Redacted.Redacted<string>;
    readonly fetch?: typeof globalThis.fetch;
    readonly timeout_ms?: number;
  }) {
    const fetch = config.fetch ?? globalThis.fetch;
    const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.account_id)}`;
    const objects = `${base}/r2/buckets/${encodeURIComponent(config.bucket)}/objects`;
    const queue = (id: string, action: string) =>
      `${base}/queues/${encodeURIComponent(id)}/messages/${action}`;
    const object = (key: string) =>
      `${objects}/${key.split("/").map(encodeURIComponent).join("/")}`;
    const unavailable = () => new BufferError({ code: "buffer_unavailable" });
    function request<A>(
      url: string,
      method: string,
      read: (response: Response) => Promise<A>,
      body?: unknown,
    ) {
      return Effect.tryPromise({
        try: async (signal) => {
          const response = await fetch(url, {
            method,
            signal,
            redirect: "error",
            headers: {
              Authorization: `Bearer ${Redacted.value(config.api_token)}`,
              ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          if (response.status === 404) throw new BufferError({ code: "object_missing" });
          if (!response.ok) throw unavailable();
          return await read(response);
        },
        catch: (error) => (error instanceof BufferError ? error : unavailable()),
      }).pipe(
        Effect.timeoutOrElse({
          duration: config.timeout_ms ?? 30_000,
          orElse: () => Effect.fail(unavailable()),
        }),
      );
    }
    const mutate = (url: string, body?: unknown, method = "POST") =>
      request(
        url,
        method,
        async (response) => {
          Schema.decodeUnknownSync(MutationResponse)(await response.json());
        },
        body,
      );
    const settle = (id: string, lease: string, delay?: number) =>
      request(
        queue(id, "ack"),
        "POST",
        async (response) => {
          const result = Schema.decodeUnknownSync(AckResponse)(await response.json()).result;
          if (delay === undefined ? result.ackCount !== 1 : result.retryCount !== 1)
            throw unavailable();
        },
        delay === undefined
          ? { acks: [{ lease_id: lease }], retries: [] }
          : { acks: [], retries: [{ lease_id: lease, delay_seconds: delay }] },
      );
    return Layer.succeed(InboundBuffer, {
      pull: (id) =>
        request(
          queue(id, "pull"),
          "POST",
          async (response) =>
            Schema.decodeUnknownSync(PullResponse)(await response.json()).result.messages,
          { batch_size: batchSize, visibility_timeout_ms: visibilityTimeoutMs },
        ),
      ack: (id, lease) => settle(id, lease),
      retry: (id, lease, delay) => settle(id, lease, delay),
      getObject: (key) =>
        request(object(key), "GET", async (response) => {
          if (Number(response.headers.get("Content-Length")) > maxCiphertextSize) {
            await response.body?.cancel();
            throw new BufferError({ code: "object_too_large" });
          }
          if (response.body === null) throw unavailable();
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let length = 0;
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              length += next.value.byteLength;
              if (length > maxCiphertextSize) {
                await reader.cancel();
                throw new BufferError({ code: "object_too_large" });
              }
              chunks.push(next.value);
            }
          } finally {
            reader.releaseLock();
          }
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return bytes;
        }),
      deleteObject: (key) =>
        mutate(object(key), undefined, "DELETE").pipe(
          Effect.catchTag("BufferError", (error) =>
            error.code === "object_missing" ? Effect.void : Effect.fail(error),
          ),
        ),
      listObjects: (prefix, cursor) => {
        const url = new URL(objects);
        url.searchParams.set("prefix", prefix);
        url.searchParams.set("per_page", "1000");
        if (cursor !== undefined) url.searchParams.set("cursor", cursor);
        return request(url.href, "GET", async (response) => {
          const decoded = Schema.decodeUnknownSync(ListResponse)(await response.json());
          if (decoded.result_info?.is_truncated) {
            const next = decoded.result_info.cursor;
            if (!next || next === cursor) throw unavailable();
            return { objects: decoded.result, cursor: next };
          }
          return { objects: decoded.result };
        });
      },
    });
  }
}

export function memoryBuffer() {
  const objects = new Map<string, { bytes: Uint8Array; last_modified: string }>();
  const messages = new Map<
    string,
    { queue: string; message: QueueMessage; available_at: number; leased_until: number }
  >();
  const acks: string[] = [];
  const retries: { lease_id: string; delay_seconds: number }[] = [];
  let sequence = 0;
  const service: InboundBufferService = {
    pull: (queue) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const batch: QueueMessage[] = [];
        for (const entry of messages.values()) {
          if (entry.queue !== queue || entry.available_at > now || entry.leased_until > now)
            continue;
          entry.message = { ...entry.message, lease_id: `lease-${++sequence}` };
          entry.leased_until = now + visibilityTimeoutMs;
          batch.push({ ...entry.message });
          if (batch.length === batchSize) break;
        }
        return batch;
      }),
    ack: (queue, lease) =>
      Effect.sync(() => {
        for (const [id, entry] of messages)
          if (entry.queue === queue && entry.message.lease_id === lease) {
            messages.delete(id);
            acks.push(lease);
          }
      }),
    retry: (queue, lease, delay) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        for (const entry of messages.values())
          if (entry.queue === queue && entry.message.lease_id === lease) {
            entry.available_at = now + delay * 1000;
            entry.leased_until = 0;
            entry.message = { ...entry.message, attempts: entry.message.attempts + 1 };
            retries.push({ lease_id: lease, delay_seconds: delay });
          }
      }),
    getObject: (key) =>
      Effect.suspend(() => {
        const value = objects.get(key);
        return value === undefined
          ? Effect.fail(new BufferError({ code: "object_missing" }))
          : Effect.succeed(value.bytes.slice());
      }),
    deleteObject: (key) =>
      Effect.sync(() => {
        objects.delete(key);
      }),
    listObjects: (prefix, cursor) =>
      Effect.sync(() => {
        const keys = [...objects.keys()]
          .filter((key) => key.startsWith(prefix) && (cursor === undefined || key > cursor))
          .sort();
        const page = keys.slice(0, 1000);
        const next = page.at(-1);
        return {
          objects: page.flatMap((key) => {
            const value = objects.get(key);
            return value === undefined
              ? []
              : [{ key, size: value.bytes.byteLength, last_modified: value.last_modified }];
          }),
          ...(keys.length > page.length && next !== undefined ? { cursor: next } : {}),
        };
      }),
  };
  return {
    service,
    objects,
    messages,
    acks,
    retries,
    layer: Layer.succeed(InboundBuffer, service),
    putObject: (key: string, bytes: Uint8Array, last_modified: string) => {
      objects.set(key, { bytes: bytes.slice(), last_modified });
    },
    push: (queue: string, body: unknown) => {
      const id = `message-${++sequence}`;
      messages.set(id, {
        queue,
        message: {
          id,
          body: typeof body === "string" ? body : JSON.stringify(body),
          attempts: 0,
          lease_id: "",
        },
        available_at: 0,
        leased_until: 0,
      });
      return id;
    },
  };
}
