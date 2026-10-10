import { Clock, Effect, Option, Redacted, Result, Schema } from "effect";
import { decrypt, parseInbound } from "../../../../packages/envelope/src/index.js";
import { InboundPointer } from "../../../../packages/envelope/src/pointer.js";
import type { DatabaseError } from "../store.js";
import { Mailbox, type MailboxService } from "../mailbox/mailbox.js";
import {
  type BufferError,
  decodeQueueBody,
  maxCiphertextSize,
  retryDelay,
  visibilityTimeoutMs,
  type InboundBufferService,
} from "./cloudflare.js";
import type { InboundSettings } from "./config.js";
import { ingestInbound } from "./ingest.js";
import { configuredBuffer, loadBufferSettings } from "./settings.js";
import { bufferState } from "./state.js";
import type { StoreService } from "../store.js";
import { observeSelfTest } from "../provision/selftest.js";

export class InboundQuarantine extends Schema.TaggedError<InboundQuarantine>()(
  "InboundQuarantine",
  {
    code: Schema.Literals([
      "invalid_pointer",
      "size_mismatch",
      "invalid_ciphertext",
      "invalid_inbound_frame",
      "invalid_mime",
      "invalid_payload",
      "payload_too_large",
      "extraction_failed",
    ]),
  },
) {}
const PointerKey = Schema.Struct({ key: InboundPointer.fields.key });
const decodePointer = Schema.decodeUnknownSync(InboundPointer);
const orphanAgeMs = 10 * 60 * 1000;
export interface InboundReport {
  readonly status: "ready" | "locked" | "no_config";
  readonly processed: number;
  readonly quarantined: number;
  readonly retried: number;
}

function ingestObject(
  pointer: InboundPointer,
  config: InboundSettings,
  buffer: InboundBufferService,
  mailbox: MailboxService,
  state: ReturnType<typeof bufferState>,
  store: StoreService,
) {
  return Effect.gen(function* () {
    const existing = yield* state.get(pointer.key);
    if (existing?.state === "quarantined") return "quarantined" as const;
    if (existing?.state !== "committed") {
      const bytes = yield* buffer
        .getObject(pointer.key)
        .pipe(
          Effect.mapError((error) =>
            error.code === "object_too_large"
              ? new InboundQuarantine({ code: "payload_too_large" })
              : error,
          ),
        );
      if (bytes.byteLength !== pointer.size || bytes.byteLength > maxCiphertextSize)
        return yield* new InboundQuarantine({ code: "size_mismatch" });
      const plaintext = yield* Effect.tryPromise({
        try: () => decrypt(Redacted.value(config.identity), bytes),
        catch: () => new InboundQuarantine({ code: "invalid_ciphertext" }),
      });
      yield* Effect.gen(function* () {
        const framed = yield* Effect.try({
          try: () => parseInbound(plaintext),
          catch: () => new InboundQuarantine({ code: "invalid_inbound_frame" }),
        });
        const selfTest = yield* observeSelfTest(
          store,
          framed.envelope,
          framed.raw,
          pointer.received_at,
        );
        if (!selfTest)
          yield* ingestInbound(
            { ...framed.envelope, raw: framed.raw, received_at: pointer.received_at },
            { trusted_authserv_ids: ["mx.cloudflare.net"] },
          ).pipe(
            Effect.provideService(Mailbox, mailbox),
            Effect.catchTag("InboundError", (error) =>
              Effect.fail(new InboundQuarantine({ code: error.code })),
            ),
          );
        yield* state.put(pointer.key, "committed");
      }).pipe(Effect.ensuring(Effect.sync(() => plaintext.fill(0))));
    }
    yield* buffer.deleteObject(pointer.key);
    return "stored" as const;
  }).pipe(
    Effect.catchTag("InboundQuarantine", (error) =>
      state.put(pointer.key, "quarantined", error.code).pipe(Effect.as("quarantined" as const)),
    ),
  );
}

export function processInbound(): Effect.Effect<InboundReport, DatabaseError | BufferError> {
  return Effect.gen(function* () {
    const loaded = yield* loadBufferSettings();
    if (loaded.status !== "ready")
      return { status: loaded.status, processed: 0, quarantined: 0, retried: 0 };
    const mailbox = yield* Effect.serviceOption(Mailbox);
    if (Option.isNone(mailbox))
      return { status: "locked", processed: 0, quarantined: 0, retried: 0 };
    const buffer = yield* configuredBuffer(loaded);
    const config = loaded.settings;
    const state = bufferState(loaded.store, config.account_id, config.bucket);
    const batch = yield* buffer.pull(config.inbound_queue_id);
    let processed = 0;
    let quarantined = 0;
    let retried = 0;
    const now = yield* Clock.currentTimeMillis;
    for (const message of batch) {
      const result = yield* Effect.gen(function* () {
        let body: unknown;
        let pointer: InboundPointer;
        try {
          body = decodeQueueBody(message.body);
          pointer = decodePointer(body);
        } catch {
          const key = Schema.decodeUnknownResult(PointerKey)(body);
          if (Result.isSuccess(key))
            yield* state.put(key.success.key, "quarantined", "invalid_pointer");
          yield* state.quarantineMessage(config.inbound_queue_id, message.id, "invalid_pointer");
          yield* buffer.ack(config.inbound_queue_id, message.lease_id);
          return "quarantined" as const;
        }
        yield* state.put(pointer.key, "pending", null, now + visibilityTimeoutMs);
        const outcome = yield* ingestObject(
          pointer,
          config,
          buffer,
          mailbox.value,
          state,
          loaded.store,
        );
        yield* buffer.ack(config.inbound_queue_id, message.lease_id);
        return outcome;
      }).pipe(Effect.result);
      if (Result.isSuccess(result)) {
        processed++;
        if (result.success === "quarantined") quarantined++;
      } else {
        retried++;
        yield* buffer
          .retry(config.inbound_queue_id, message.lease_id, retryDelay(message.attempts))
          .pipe(Effect.catch(() => Effect.void));
      }
    }
    return { status: "ready", processed, quarantined, retried };
  });
}

export function reconcileInbound(): Effect.Effect<InboundReport, DatabaseError | BufferError> {
  return Effect.gen(function* () {
    const loaded = yield* loadBufferSettings();
    if (loaded.status !== "ready")
      return { status: loaded.status, processed: 0, quarantined: 0, retried: 0 };
    const mailbox = yield* Effect.serviceOption(Mailbox);
    if (Option.isNone(mailbox))
      return { status: "locked", processed: 0, quarantined: 0, retried: 0 };
    const config = loaded.settings;
    const buffer = yield* configuredBuffer(loaded);
    const state = bufferState(loaded.store, config.account_id, config.bucket);
    const now = yield* Clock.currentTimeMillis;
    let cursor: string | undefined;
    let processed = 0;
    let quarantined = 0;
    let retried = 0;
    do {
      const page = yield* buffer.listObjects("inbound/", cursor);
      for (const object of page.objects) {
        if (now - Date.parse(object.last_modified) < orphanAgeMs) continue;
        const existing = yield* state.get(object.key);
        if (
          existing?.state === "quarantined" ||
          (existing?.state === "pending" && existing.pending_until > now)
        )
          continue;
        const decoded = Schema.decodeUnknownResult(InboundPointer)({
          version: 1,
          key: object.key,
          size: object.size,
          received_at: new Date(object.last_modified).toISOString(),
        });
        if (Result.isFailure(decoded)) {
          yield* state.put(object.key, "quarantined", "invalid_pointer");
          quarantined++;
          continue;
        }
        const result = yield* ingestObject(
          decoded.success,
          config,
          buffer,
          mailbox.value,
          state,
          loaded.store,
        ).pipe(Effect.result);
        if (Result.isFailure(result)) retried++;
        else {
          processed++;
          if (result.success === "quarantined") quarantined++;
        }
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
    return { status: "ready", processed, quarantined, retried };
  });
}
