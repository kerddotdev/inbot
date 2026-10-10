import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { Clock, Effect, Result, Schema } from "effect";
import { ApiKey, Permissions } from "../../../../packages/contracts/src/api-keys.js";
import type { Principal } from "../../../../packages/contracts/src/security.js";
import { permits } from "../agent/authorization.js";
import { Store } from "../store.js";
import { EventRow, eventReadable, pruneEvents } from "./log.js";
import { WebhookRow, checkedHeaders } from "./webhooks.js";
import { signWebhook } from "./signature.js";
import { webhookSender, webhookUrl, type WebhookSender } from "./target.js";

export const WEBHOOK_MAX_ATTEMPTS = 8;
export const WEBHOOK_MAX_BACKOFF_MS = 60 * 60_000;
export const WEBHOOK_LEASE_MS = 30_000;
const DeliveryRow = Schema.Struct({
  webhook_id: Schema.String,
  sequence: Schema.Int,
  state: Schema.String,
  attempts: Schema.Int,
  next_attempt_at: Schema.Int,
});
const KeyRow = Schema.Struct({
  ...ApiKey.fields,
  inbox_id: Schema.NullOr(Schema.String),
  inbox_ids: Schema.NullOr(Schema.fromJsonString(Schema.Array(Schema.String))),
  permissions: Schema.fromJsonString(Permissions),
  expires_at: Schema.NullOr(Schema.String),
  used_at: Schema.NullOr(Schema.String),
});

export function webhookPrincipal(
  db: Database.Database,
  row: WebhookRow,
  now: number,
): Principal | undefined {
  if (row.api_key_id === null) return { kind: "owner" };
  const value = db.prepare("SELECT * FROM api_keys WHERE api_key_id = ?").get(row.api_key_id);
  if (value === undefined) return undefined;
  const decoded = Schema.decodeUnknownResult(KeyRow)(value);
  if (Result.isFailure(decoded)) return undefined;
  const key = decoded.success;
  if (key.expires_at !== null && Date.parse(key.expires_at) <= now) return undefined;
  const principal: Principal = {
    kind: "agent",
    api_key_id: key.api_key_id,
    grant: {
      ...(key.inbox_id === null ? {} : { inbox_id: key.inbox_id }),
      ...(key.inbox_ids === null ? {} : { inbox_ids: key.inbox_ids }),
      permissions: key.permissions,
      send_policy: key.send_policy,
    },
  };
  return permits(principal, "webhook_create") ? principal : undefined;
}

function subscription(row: WebhookRow) {
  return {
    event_types: row.event_types,
    ...(row.inbox_ids === null ? {} : { inbox_ids: row.inbox_ids }),
  };
}

export function processWebhooks(sender: WebhookSender = webhookSender()) {
  return Effect.gen(function* () {
    let poisoned = false;
    function failEvent(db: Database.Database, sequence: number) {
      poisoned = true;
      db.prepare(
        "UPDATE event_log SET invalid = 1, payload = '{}', labels = '[]' WHERE sequence = ?",
      ).run(sequence);
      db.prepare(
        "UPDATE webhook_deliveries SET state = 'failed', lease_until = NULL, claim_id = NULL WHERE sequence = ? AND state IN ('pending', 'sending')",
      ).run(sequence);
    }
    function failWebhook(db: Database.Database, id: string, reason: string) {
      if (reason === "invalid_record")
        db.prepare(
          "UPDATE webhooks SET headers = '{}', event_types = '[]', inbox_ids = '[]', failure_count = 0, cursor = (SELECT COALESCE(MAX(sequence), 0) FROM event_log) WHERE webhook_id = ?",
        ).run(id);
      db.prepare(
        "UPDATE webhooks SET enabled = 0, disabled_reason = ?, last_error_code = 'delivery_failed', updated_at = ? WHERE webhook_id = ?",
      ).run(reason, new Date(now).toISOString(), id);
      db.prepare(
        "UPDATE webhook_deliveries SET state = 'failed', lease_until = NULL, claim_id = NULL WHERE webhook_id = ? AND state IN ('pending', 'sending')",
      ).run(id);
    }
    const store = yield* Store;
    const now = yield* Clock.currentTimeMillis;
    const due = yield* store.use((db) =>
      db
        .transaction(() => {
          db.prepare(
            "UPDATE webhook_deliveries SET state = 'pending', lease_until = NULL, claim_id = NULL WHERE state = 'sending' AND lease_until <= ?",
          ).run(now);
          pruneEvents(db, now);
          const hooks: WebhookRow[] = [];
          for (const value of db
            .prepare("SELECT * FROM webhooks WHERE enabled = 1 ORDER BY created_at, webhook_id")
            .all()) {
            const decoded = Schema.decodeUnknownResult(WebhookRow)(value);
            if (Result.isFailure(decoded)) {
              poisoned = true;
              const { webhook_id } = Schema.decodeUnknownSync(
                Schema.Struct({ webhook_id: Schema.String }),
              )(value);
              failWebhook(db, webhook_id, "invalid_record");
            } else hooks.push(decoded.success);
          }
          for (const hook of hooks) {
            const principal = webhookPrincipal(db, hook, now);
            if (principal === undefined) {
              db.prepare(
                "UPDATE webhooks SET enabled = 0, disabled_reason = 'credential_revoked', updated_at = ? WHERE webhook_id = ?",
              ).run(new Date(now).toISOString(), hook.webhook_id);
              continue;
            }
            const rows = db
              .prepare(
                "SELECT * FROM event_log WHERE sequence > ? AND invalid = 0 ORDER BY sequence LIMIT 100",
              )
              .all(hook.cursor);
            for (const value of rows) {
              const { sequence } = Schema.decodeUnknownSync(
                Schema.Struct({ sequence: Schema.Int }),
              )(value);
              const decoded = Schema.decodeUnknownResult(EventRow)(value);
              if (Result.isFailure(decoded)) failEvent(db, sequence);
              else if (eventReadable(db, decoded.success, principal, subscription(hook)))
                db.prepare(
                  "INSERT OR IGNORE INTO webhook_deliveries (webhook_id, sequence, next_attempt_at) VALUES (?, ?, ?)",
                ).run(hook.webhook_id, sequence, now);
              db.prepare("UPDATE webhooks SET cursor = ? WHERE webhook_id = ?").run(
                sequence,
                hook.webhook_id,
              );
            }
          }
          const due: (typeof DeliveryRow.Type)[] = [];
          for (const value of db
            .prepare(`SELECT d.* FROM webhook_deliveries d JOIN webhooks w USING (webhook_id)
            WHERE w.enabled = 1 AND d.state = 'pending' AND d.next_attempt_at <= ?
            AND NOT EXISTS (SELECT 1 FROM webhook_deliveries earlier WHERE earlier.webhook_id = d.webhook_id
              AND earlier.sequence < d.sequence AND earlier.state IN ('pending', 'sending'))
            ORDER BY d.sequence, d.webhook_id LIMIT 100`)
            .all(now)) {
            const decoded = Schema.decodeUnknownResult(DeliveryRow)(value);
            if (Result.isSuccess(decoded)) due.push(decoded.success);
            else {
              poisoned = true;
              const identity = Schema.decodeUnknownSync(
                Schema.Struct({ webhook_id: Schema.String, sequence: Schema.Int }),
              )(value);
              db.prepare(
                "UPDATE webhook_deliveries SET state = 'failed', lease_until = NULL, claim_id = NULL WHERE webhook_id = ? AND sequence = ?",
              ).run(identity.webhook_id, identity.sequence);
            }
          }
          return due;
        })
        .immediate(),
    );
    let processed = 0;
    for (const delivery of due) {
      const claimedAt = yield* Clock.currentTimeMillis;
      const claimId = randomUUID();
      const claimed = yield* store.use((db) =>
        db
          .transaction(() => {
            const value = db
              .prepare("SELECT * FROM webhooks WHERE webhook_id = ? AND enabled = 1")
              .get(delivery.webhook_id);
            if (value === undefined) return undefined;
            const decodedHook = Schema.decodeUnknownResult(WebhookRow)(value);
            if (Result.isFailure(decodedHook)) {
              poisoned = true;
              failWebhook(db, delivery.webhook_id, "invalid_record");
              return undefined;
            }
            const hook = decodedHook.success;
            const decoded = Schema.decodeUnknownResult(EventRow)(
              db
                .prepare("SELECT * FROM event_log WHERE sequence = ? AND invalid = 0")
                .get(delivery.sequence),
            );
            if (Result.isFailure(decoded)) {
              failEvent(db, delivery.sequence);
              return undefined;
            }
            const event = decoded.success;
            const principal = webhookPrincipal(db, hook, claimedAt);
            if (
              principal === undefined ||
              !eventReadable(db, event, principal, subscription(hook))
            ) {
              db.prepare(
                "UPDATE webhook_deliveries SET state = 'cancelled' WHERE webhook_id = ? AND sequence = ? AND state = 'pending'",
              ).run(delivery.webhook_id, delivery.sequence);
              return undefined;
            }
            try {
              webhookUrl(hook.url, principal);
              checkedHeaders(hook.headers);
            } catch {
              failWebhook(db, hook.webhook_id, "invalid_target");
              return undefined;
            }
            const claim = db
              .prepare(`UPDATE webhook_deliveries SET state = 'sending', attempts = attempts + 1,
          lease_until = ?, claim_id = ? WHERE webhook_id = ? AND sequence = ? AND state = 'pending' AND next_attempt_at <= ?`)
              .run(
                claimedAt + WEBHOOK_LEASE_MS,
                claimId,
                delivery.webhook_id,
                delivery.sequence,
                claimedAt,
              );
            return claim.changes === 1 ? { hook, event, principal } : undefined;
          })
          .immediate(),
      );
      if (claimed === undefined) continue;
      const body = JSON.stringify(claimed.event.payload);
      const timestamp = String(Math.floor(claimedAt / 1000));
      const result = yield* Effect.result(
        Effect.tryPromise({
          try: (signal) =>
            sender({
              signal,
              url: claimed.hook.url,
              principal: claimed.principal,
              body,
              headers: {
                ...claimed.hook.headers,
                "content-type": "application/json",
                "webhook-id": claimed.event.event_id,
                "webhook-timestamp": timestamp,
                "webhook-signature": signWebhook(
                  claimed.hook.secret,
                  claimed.event.event_id,
                  timestamp,
                  body,
                ),
              },
            }),
          catch: () => "delivery_failed",
        }).pipe(Effect.timeout("10 seconds")),
      );
      const completedAt = yield* Clock.currentTimeMillis;
      yield* store.use((db) =>
        db
          .transaction(() => {
            const value = db
              .prepare(`SELECT d.attempts FROM webhook_deliveries d JOIN webhooks w USING (webhook_id)
          WHERE d.webhook_id = ? AND d.sequence = ? AND d.state = 'sending' AND d.claim_id = ?`)
              .get(delivery.webhook_id, delivery.sequence, claimId);
            if (value === undefined) return;
            const { attempts } = Schema.decodeUnknownSync(Schema.Struct({ attempts: Schema.Int }))(
              value,
            );
            const success =
              Result.isSuccess(result) && result.success >= 200 && result.success < 300;
            db.prepare(`UPDATE webhook_deliveries SET state = ?, next_attempt_at = ?, lease_until = NULL,
          claim_id = NULL WHERE webhook_id = ? AND sequence = ?`).run(
              success ? "delivered" : "pending",
              completedAt + Math.min(30_000 * 2 ** (attempts - 1), WEBHOOK_MAX_BACKOFF_MS),
              delivery.webhook_id,
              delivery.sequence,
            );
            if (success) {
              db.prepare(
                "UPDATE webhooks SET failure_count = 0, last_error_code = NULL, last_success_at = ?, updated_at = ? WHERE webhook_id = ?",
              ).run(
                new Date(completedAt).toISOString(),
                new Date(completedAt).toISOString(),
                delivery.webhook_id,
              );
            } else {
              db.prepare(`UPDATE webhooks SET failure_count = failure_count + 1,
            enabled = CASE WHEN failure_count + 1 >= ? THEN 0 ELSE enabled END,
            disabled_reason = CASE WHEN failure_count + 1 >= ? THEN 'sustained_failure' ELSE disabled_reason END,
            last_error_code = ?, updated_at = ? WHERE webhook_id = ?`).run(
                WEBHOOK_MAX_ATTEMPTS,
                WEBHOOK_MAX_ATTEMPTS,
                claimed.principal.kind === "owner" && Result.isSuccess(result)
                  ? `http_${result.success}`
                  : "delivery_failed",
                new Date(completedAt).toISOString(),
                delivery.webhook_id,
              );
            }
          })
          .immediate(),
      );
      processed++;
    }
    if (poisoned) yield* Effect.logError("database_failed");
    return processed;
  });
}

export function startWebhookLoop(sender: WebhookSender = webhookSender()) {
  return Effect.gen(function* () {
    while (true) {
      yield* processWebhooks(sender).pipe(
        Effect.catchTag("DatabaseError", (error) => Effect.logError(error.code)),
      );
      yield* Effect.sleep("1 second");
    }
  }).pipe(Effect.forkScoped);
}
