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
      yield* store.use((db) => {
        db.prepare(`INSERT INTO inbound_objects (account_id, bucket, key, state, reason_code, first_seen, pending_until) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, bucket, key) DO UPDATE SET state = excluded.state, reason_code = excluded.reason_code, pending_until = excluded.pending_until
        WHERE inbound_objects.state = 'pending' OR excluded.state != 'pending'`).run(
          account,
          bucket,
          key,
          state,
          reason,
          new Date(now).toISOString(),
          pendingUntil,
        );
      });
    });
  return {
    get,
    put,
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
        yield* store.use((db) => {
          db.prepare(
            "INSERT OR IGNORE INTO buffer_quarantine (account_id, queue_id, message_id, reason_code, first_seen) VALUES (?, ?, ?, ?, ?)",
          ).run(account, queue, messageId, reason, new Date(now).toISOString());
        });
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
