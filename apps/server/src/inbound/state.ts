import { randomUUID } from "node:crypto";
import { appendEvent } from "../events/log.js";
import { quarantineId } from "./quarantine-id.js";
import { Clock, Effect, Schema } from "effect";
import type { StoreService } from "../store.js";

const ObjectState = Schema.Struct({
  key: Schema.String,
  state: Schema.Literals(["pending", "committed", "quarantined"]),
  reason_code: Schema.NullOr(Schema.String),
  first_seen: Schema.String,
  pending_until: Schema.Int,
});
const QueueQuarantine = Schema.Struct({
  queue_id: Schema.String,
  message_id: Schema.String,
  reason_code: Schema.String,
  first_seen: Schema.String,
});
export function bufferState(store: StoreService, account: string, bucket: string) {
  const get = (key: string) =>
    store.use((db) => {
      const row = db
        .prepare(
          "SELECT key, state, reason_code, first_seen, pending_until FROM inbound_objects WHERE account_id = ? AND bucket = ? AND key = ?",
        )
        .get(account, bucket, key);
      return row === undefined ? undefined : Schema.decodeUnknownSync(ObjectState)(row);
    });
  const put = (
    key: string,
    state: (typeof ObjectState.Type)["state"],
    reason: string | null = null,
    pendingUntil = 0,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* store.use((db) =>
        db
          .transaction(() => {
            const existing = db
              .prepare(
                "SELECT state FROM inbound_objects WHERE account_id = ? AND bucket = ? AND key = ?",
              )
              .get(account, bucket, key);
            const previous = Schema.decodeUnknownSync(
              Schema.optional(Schema.Struct({ state: Schema.String })),
            )(existing);
            db.prepare(`INSERT INTO inbound_objects (account_id, bucket, key, state, reason_code, first_seen, pending_until) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, bucket, key) DO UPDATE SET state = excluded.state, reason_code = excluded.reason_code, pending_until = excluded.pending_until
        WHERE (inbound_objects.state = 'pending' OR excluded.state != 'pending') AND NOT (inbound_objects.state = 'committed' AND excluded.state = 'quarantined')`).run(
              account,
              bucket,
              key,
              state,
              reason,
              new Date(now).toISOString(),
              pendingUntil,
            );
            if (state === "quarantined" && previous?.state !== "committed")
              appendEvent(
                db,
                {
                  type: "event",
                  event_type: "inbound.quarantined",
                  event_id: randomUUID(),
                  quarantine: {
                    quarantine_id: quarantineId("buffer_object", account, bucket, key),
                    reason_code: reason ?? "unknown",
                    timestamp: new Date(now).toISOString(),
                  },
                },
                now,
              );
          })
          .immediate(),
      );
    });
  return {
    get,
    put,
    attempt: (key: string, size: number | undefined, receivedAt: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* store.use((db) => {
          db.prepare(`INSERT INTO inbound_quarantine_metadata (account_id, bucket, key, size, received_at, attempts, last_attempt_at) VALUES (?, ?, ?, ?, ?, 1, ?)
          ON CONFLICT(account_id, bucket, key) DO UPDATE SET size = COALESCE(excluded.size, size), received_at = excluded.received_at, attempts = attempts + 1, last_attempt_at = excluded.last_attempt_at`).run(
            account,
            bucket,
            key,
            size ?? null,
            receivedAt,
            new Date(now).toISOString(),
          );
        });
      }),
    beginAction: (key: string, action: "retry" | "delete") =>
      store.use((db) =>
        db
          .transaction(() => {
            db.prepare(`INSERT INTO inbound_quarantine_metadata (account_id, bucket, key, action) VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id, bucket, key) DO UPDATE SET action = excluded.action`).run(
              account,
              bucket,
              key,
              action,
            );
            if (action === "delete")
              db.prepare(
                "UPDATE inbound_objects SET state = 'committed' WHERE account_id = ? AND bucket = ? AND key = ?",
              ).run(account, bucket, key);
          })
          .immediate(),
      ),
    finishAction: (key: string, success: boolean) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* store.use((db) =>
          db
            .transaction(() => {
              const row = Schema.decodeUnknownSync(
                Schema.optional(
                  Schema.Struct({
                    action: Schema.NullOr(Schema.String),
                    reason_code: Schema.NullOr(Schema.String),
                  }),
                ),
              )(
                db
                  .prepare(
                    `SELECT m.action, o.reason_code FROM inbound_quarantine_metadata m JOIN inbound_objects o USING (account_id, bucket, key) WHERE m.account_id = ? AND m.bucket = ? AND m.key = ?`,
                  )
                  .get(account, bucket, key),
              );
              if (success) {
                if (row?.action)
                  appendEvent(
                    db,
                    {
                      type: "event",
                      event_type: row.action === "delete" ? "inbound.deleted" : "inbound.released",
                      event_id: randomUUID(),
                      quarantine: {
                        quarantine_id: quarantineId("buffer_object", account, bucket, key),
                        reason_code: row.reason_code ?? "unknown",
                        timestamp: new Date(now).toISOString(),
                      },
                    },
                    now,
                  );
                db.prepare(
                  "DELETE FROM inbound_quarantine_metadata WHERE account_id = ? AND bucket = ? AND key = ?",
                ).run(account, bucket, key);
              } else
                db.prepare(
                  "UPDATE inbound_quarantine_metadata SET action = NULL WHERE account_id = ? AND bucket = ? AND key = ?",
                ).run(account, bucket, key);
            })
            .immediate(),
        );
      }),
    listPendingActions: () =>
      store.use((db) =>
        Schema.decodeUnknownSync(Schema.Array(ObjectState))(
          db
            .prepare(
              `SELECT o.key, o.state, o.reason_code, o.first_seen, o.pending_until FROM inbound_objects o JOIN inbound_quarantine_metadata m USING (account_id, bucket, key) WHERE o.account_id = ? AND o.bucket = ? AND o.state = 'committed' AND m.action IS NOT NULL`,
            )
            .all(account, bucket),
        ),
      ),
    listQuarantine: () =>
      store.use((db) =>
        Schema.decodeUnknownSync(Schema.Array(ObjectState))(
          db
            .prepare(
              "SELECT key, state, reason_code, first_seen, pending_until FROM inbound_objects WHERE account_id = ? AND bucket = ? AND state = 'quarantined' ORDER BY first_seen, key",
            )
            .all(account, bucket),
        ),
      ),
    releaseQuarantine: (key: string) =>
      store.use((db) => {
        db.prepare(
          "DELETE FROM inbound_objects WHERE account_id = ? AND bucket = ? AND key = ? AND state = 'quarantined'",
        ).run(account, bucket, key);
      }),
    quarantineMessage: (queue: string, messageId: string, reason: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* store.use((db) =>
          db
            .transaction(() => {
              const inserted = db
                .prepare(
                  "INSERT OR IGNORE INTO buffer_quarantine (account_id, queue_id, message_id, reason_code, first_seen) VALUES (?, ?, ?, ?, ?)",
                )
                .run(account, queue, messageId, reason, new Date(now).toISOString());
              if (inserted.changes)
                appendEvent(
                  db,
                  {
                    type: "event",
                    event_type: "inbound.quarantined",
                    event_id: randomUUID(),
                    quarantine: {
                      quarantine_id: quarantineId("queue_message", account, queue, messageId),
                      reason_code: reason,
                      timestamp: new Date(now).toISOString(),
                    },
                  },
                  now,
                );
            })
            .immediate(),
        );
      }),
    listMessageQuarantine: () =>
      store.use((db) =>
        Schema.decodeUnknownSync(Schema.Array(QueueQuarantine))(
          db
            .prepare(
              "SELECT queue_id, message_id, reason_code, first_seen FROM buffer_quarantine WHERE account_id = ? ORDER BY first_seen, message_id",
            )
            .all(account),
        ),
      ),
  };
}
