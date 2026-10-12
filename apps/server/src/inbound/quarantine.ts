import { randomUUID } from "node:crypto";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import {
  type ListQuarantineQuery,
  type QuarantineItem,
} from "../../../../packages/contracts/src/quarantine.js";
import { appendEvent } from "../events/log.js";
import { notFound } from "../mailbox/errors.js";
import { fingerprint, nextToken, pageLimit, readCursor } from "../mailbox/pagination.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { TransportConfig } from "../outbound/transport-config.js";
import { Store, type StoreService } from "../store.js";
import { InboundBuffer } from "./cloudflare.js";
import { InboundConfig } from "./config.js";
import { inboundLock } from "./coordination.js";
import { ingestObject } from "./puller.js";
import { quarantineId } from "./quarantine-id.js";
import { configuredBuffer, loadBufferSettings } from "./settings.js";
import { bufferState } from "./state.js";

const Row = Schema.Struct({
  source_kind: Schema.Literals(["buffer_object", "queue_message"]),
  account_id: Schema.String,
  location: Schema.String,
  source_id: Schema.String,
  state: Schema.String,
  reason_code: Schema.NullOr(Schema.String),
  first_seen: Schema.String,
  size: Schema.NullOr(Schema.Int),
  received_at: Schema.NullOr(Schema.String),
  attempts: Schema.NullOr(Schema.Int),
  last_attempt_at: Schema.NullOr(Schema.String),
  action: Schema.NullOr(Schema.Literals(["retry", "delete"])),
});
type Row = typeof Row.Type;
function item(row: Row): QuarantineItem {
  return {
    quarantine_id: quarantineId(row.source_kind, row.account_id, row.location, row.source_id),
    source_kind: row.source_kind,
    reason_code: row.reason_code ?? "unknown",
    first_seen: row.first_seen,
    size: row.size,
    inbox_id: null,
    attempts: row.attempts,
    last_attempt_at: row.last_attempt_at,
    status:
      row.action === "delete"
        ? "delete_pending"
        : row.state === "committed"
          ? "release_pending"
          : "quarantined",
  };
}
function rows(store: StoreService) {
  return store.use((db) =>
    Schema.decodeUnknownSync(Schema.Array(Row))(
      db
        .prepare(`
    SELECT 'buffer_object' AS source_kind, o.account_id, o.bucket AS location, o.key AS source_id,
      o.state, o.reason_code, o.first_seen, m.size, m.received_at, m.attempts, m.last_attempt_at, m.action
    FROM inbound_objects o LEFT JOIN inbound_quarantine_metadata m USING (account_id, bucket, key)
    WHERE o.state = 'quarantined' OR m.action IS NOT NULL
    UNION ALL
    SELECT 'queue_message', account_id, queue_id, message_id, 'quarantined', reason_code, first_seen,
      NULL, NULL, NULL, NULL, NULL FROM buffer_quarantine
  `)
        .all(),
    ),
  );
}
const failure = (
  code: "locked" | "action_required" | "not_supported",
  message: string,
  fix: string,
) => Effect.fail({ name: "InbotError", code, message, fix });

export function makeQuarantine(store: StoreService) {
  const find = (id: string) =>
    Effect.map(rows(store), (all) => all.find((row) => item(row).quarantine_id === id));
  const ready = Effect.gen(function* () {
    const loaded = yield* loadBufferSettings();
    if (loaded.status === "locked")
      return yield* failure(
        "locked",
        "The service is locked.",
        "Unlock the local service and retry.",
      );
    if (loaded.status === "no_config")
      return yield* failure(
        "action_required",
        "The inbound buffer is not configured.",
        "Configure the original inbound buffer and retry.",
      );
    return loaded;
  });
  const matching = (row: Row) =>
    Effect.gen(function* () {
      const loaded = yield* ready;
      if (loaded.settings.account_id !== row.account_id || loaded.settings.bucket !== row.location)
        return yield* failure(
          "action_required",
          "This item belongs to a different inbound buffer.",
          "Restore its original buffer configuration before retrying or deleting it.",
        );
      return { ...loaded, buffer: yield* configuredBuffer(loaded) };
    });
  return {
    list: (query: ListQuarantineQuery = {}) =>
      Effect.gen(function* () {
        const pagination = yield* Effect.try({
          try: () => {
            const limit = pageLimit(query.limit);
            const expected = fingerprint({ resource: "quarantine" });
            return { limit, expected, cursor: readCursor(query.page_token, expected) };
          },
          catch: (error) => error,
        });
        const all = (yield* rows(store)).map(item).sort((a, b) => {
          const left = `${a.first_seen}/${a.quarantine_id}`;
          const right = `${b.first_seen}/${b.quarantine_id}`;
          return left < right ? 1 : left > right ? -1 : 0;
        });
        const remaining = all.filter(
          (entry) =>
            pagination.cursor === undefined ||
            entry.first_seen < pagination.cursor.key ||
            (entry.first_seen === pagination.cursor.key &&
              entry.quarantine_id < pagination.cursor.id),
        );
        const items = remaining.slice(0, pagination.limit);
        const last = items.at(-1);
        return {
          count: items.length,
          limit: pagination.limit,
          items,
          ...(last && remaining.length > items.length
            ? {
                next_page_token: nextToken(
                  pagination.expected,
                  last.first_seen,
                  last.quarantine_id,
                ),
              }
            : {}),
        };
      }),
    retry: (id: string) =>
      Effect.gen(function* () {
        const row = yield* find(id);
        if (row === undefined) return yield* notFound();
        if (row.source_kind === "queue_message")
          return yield* failure(
            "not_supported",
            "An acknowledged invalid Queue message cannot be retried.",
            "Retry its buffer object if one is listed, or delete this metadata record.",
          );
        if (row.action === "delete")
          return yield* failure(
            "action_required",
            "Deletion is awaiting buffer cleanup.",
            "Retry deletion to finish removing the ciphertext.",
          );
        const loaded = yield* matching(row);
        const mailbox = yield* Mailbox;
        const state = bufferState(store, row.account_id, row.location);
        yield* state.beginAction(row.source_id, "retry");
        const outcome = yield* ingestObject(
          { key: row.source_id, received_at: row.received_at ?? row.first_seen },
          loaded.settings,
          loaded.buffer,
          mailbox,
          state,
          store,
          true,
        );
        if (outcome === "stored") return { status: "released" as const };
        const updated = yield* find(id);
        if (updated === undefined) return yield* notFound();
        return { status: "quarantined" as const, item: item(updated) };
      }).pipe(inboundLock(store)),
    delete: (id: string) =>
      Effect.gen(function* () {
        const row = yield* find(id);
        if (row === undefined) return;
        if (row.source_kind === "buffer_object") {
          const loaded = yield* matching(row);
          const state = bufferState(store, row.account_id, row.location);
          yield* state.beginAction(row.source_id, "delete");
          yield* loaded.buffer.deleteObject(row.source_id);
          yield* state.finishAction(row.source_id, true);
        } else {
          const now = yield* Clock.currentTimeMillis;
          yield* store.use((db) =>
            db
              .transaction(() => {
                db.prepare(
                  "DELETE FROM buffer_quarantine WHERE account_id = ? AND queue_id = ? AND message_id = ?",
                ).run(row.account_id, row.location, row.source_id);
                appendEvent(
                  db,
                  {
                    type: "event",
                    event_type: "inbound.deleted",
                    event_id: randomUUID(),
                    quarantine: {
                      quarantine_id: id,
                      reason_code: row.reason_code ?? "unknown",
                      timestamp: new Date(now).toISOString(),
                    },
                  },
                  now,
                );
              })
              .immediate(),
          );
        }
      }).pipe(inboundLock(store)),
  };
}

export class Quarantine extends Context.Service<Quarantine, ReturnType<typeof makeQuarantine>>()(
  "inbot/Quarantine",
) {
  static readonly Live = Layer.effect(
    Quarantine,
    Effect.gen(function* () {
      const store = yield* Store;
      const inbound = yield* InboundConfig;
      const transport = yield* TransportConfig;
      const mailbox = yield* Mailbox;
      const buffer = yield* Effect.serviceOption(InboundBuffer);
      const context = Context.make(Store, store).pipe(
        Context.add(InboundConfig, inbound),
        Context.add(TransportConfig, transport),
        Context.add(Mailbox, mailbox),
      );
      const provided = Option.isSome(buffer)
        ? Context.add(context, InboundBuffer, buffer.value)
        : context;
      const service = makeQuarantine(store);
      return {
        list: service.list,
        retry: (id: string) => service.retry(id).pipe(Effect.provideContext(provided)),
        delete: (id: string) => service.delete(id).pipe(Effect.provideContext(provided)),
      };
    }),
  );
}
