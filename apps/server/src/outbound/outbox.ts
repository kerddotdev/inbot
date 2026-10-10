import { deliveryEvent, draftEvent, outboundEvent } from "../events/log.js";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { Clock, Context, Effect, Layer, Result, Schema } from "effect";
import { SendMessageResponse } from "../../../../packages/contracts/src/messages.js";
import { IdempotencyKey } from "../../../../packages/contracts/src/common.js";
import {
  DeliveryEvent,
  OutboxEntry,
  type OutboundRequest,
} from "../../../../packages/contracts/src/outbound.js";
import { Store, type StoreService } from "../store.js";
import { MailboxError, notFound } from "../mailbox/errors.js";
import { insertMessage, updateMessage } from "../mailbox/messages.js";
import { getInbox } from "../mailbox/rows.js";
import { compose, decodeRequest } from "./compose.js";
import { OutboundProvider, ProviderMessage, type OutboundProviderService } from "./cloudflare.js";
import { invalid, OutboundError } from "./errors.js";
import { prepare } from "./prepare.js";
import { draftRequest, getDraft, saveDraft, sendLabels } from "../drafts/rows.js";
import type { SendDraftRequest } from "../../../../packages/contracts/src/drafts.js";
import { renderMime } from "./mime.js";
import { assertOutbound } from "../lists/policy.js";

const IDEMPOTENCY_TTL = 24 * 60 * 60 * 1000;
export const SENDING_LEASE_MS = 5 * 60 * 1000;
export const MAX_ATTEMPTS = 8;
export const MAX_BACKOFF_MS = 60 * 60 * 1000;
const managedLabels = new Set([
  "queued",
  "sent",
  "failed",
  "delivered",
  "bounced",
  "complained",
  "rejected",
  "deferred",
]);
const PendingRow = Schema.Struct({ ...OutboxEntry.fields, provider_message: Schema.String });
const ReplayRow = Schema.Struct({
  ...SendMessageResponse.fields,
  fingerprint: Schema.String,
  completed_at: Schema.NullOr(Schema.Finite),
});
const AliasRow = Schema.Struct({ inbox_id: Schema.String, message_id: Schema.String });

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item: unknown) => canonical(item)).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function makeOutbox(store: StoreService, provider: OutboundProviderService) {
  function run<A>(operation: (db: Database.Database, now: number) => A, write = true) {
    return Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const result = yield* store.use((db): Result.Result<A, OutboundError | MailboxError> => {
        try {
          const transaction = db.transaction(() => operation(db, now));
          return Result.succeed(write ? transaction.immediate() : transaction.deferred());
        } catch (error) {
          if (error instanceof OutboundError || error instanceof MailboxError)
            return Result.fail(error);
          throw error;
        }
      });
      return yield* Effect.fromResult(result);
    });
  }

  const completeKey = (db: Database.Database, row: OutboxEntry, now: number) => {
    db.prepare(
      "UPDATE outbound_idempotency SET completed_at = ? WHERE inbox_id = ? AND message_id = ? AND completed_at IS NULL",
    ).run(now, row.inbox_id, row.message_id);
  };

  const recoverExpired = (db: Database.Database, now: number) => {
    const rows = db
      .prepare("SELECT * FROM outbox WHERE state = 'sending' AND updated_at <= ?")
      .all(now - SENDING_LEASE_MS);
    for (const value of rows) {
      const row = Schema.decodeUnknownSync(OutboxEntry)(value);
      db.prepare(
        "UPDATE outbox SET state = 'failed', last_error_code = 'unknown_outcome', updated_at = ? WHERE id = ?",
      ).run(now, row.id);
      completeKey(db, row, now);
      updateMessage(
        db,
        row.inbox_id,
        row.message_id,
        { add_labels: "failed", remove_labels: "queued" },
        new Date(now).toISOString(),
      );
      outboundEvent(db, row.inbox_id, row.message_id, "failed", now, "unknown_outcome");
    }
  };

  const processDue = () =>
    Effect.gen(function* () {
      yield* run((db, now) => recoverExpired(db, now));
      const due = yield* run(
        (db, now) =>
          db
            .prepare(
              "SELECT id FROM outbox WHERE state = 'queued' AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT 100",
            )
            .all(now)
            .map((row) => Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(row).id),
        false,
      );
      let processed = 0;
      for (const id of due) {
        const row = yield* run((db, now) => {
          const value = db
            .prepare(
              "SELECT * FROM outbox WHERE id = ? AND state = 'queued' AND next_attempt_at <= ?",
            )
            .get(id, now);
          if (value === undefined) return undefined;
          const pending = Schema.decodeUnknownSync(PendingRow)(value);
          const inbox = getInbox(db, pending.inbox_id);
          if (inbox.status === "paused") return undefined;
          const message = Schema.decodeUnknownSync(ProviderMessage)(
            JSON.parse(pending.provider_message),
          );
          try {
            assertOutbound(
              db,
              pending.inbox_id,
              [...message.to, ...message.cc, ...message.bcc].map((value) =>
                typeof value === "string" ? value : value.address,
              ),
              Object.keys(message.headers).some((name) => name.toLowerCase() === "in-reply-to"),
            );
          } catch (error) {
            if (!(error instanceof OutboundError) || error.code !== "message_rejected") throw error;
            db.prepare(
              "UPDATE outbox SET state = 'failed', last_error_code = 'message_rejected', updated_at = ? WHERE id = ?",
            ).run(now, id);
            completeKey(db, pending, now);
            updateMessage(
              db,
              pending.inbox_id,
              pending.message_id,
              { add_labels: ["failed", "rejected"], remove_labels: "queued" },
              new Date(now).toISOString(),
            );
            outboundEvent(
              db,
              pending.inbox_id,
              pending.message_id,
              "failed",
              now,
              "message_rejected",
            );
            return undefined;
          }
          db.prepare(
            "UPDATE outbox SET state = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ?",
          ).run(now, id);
          return { ...pending, attempts: pending.attempts + 1 };
        });
        if (row === undefined) continue;
        const result = yield* Effect.result(
          Effect.try({
            try: () => Schema.decodeUnknownSync(ProviderMessage)(JSON.parse(row.provider_message)),
            catch: () => invalid("The stored outbound payload is invalid."),
          }).pipe(Effect.flatMap((message) => provider.send(message))),
        );
        yield* run((db, now) => {
          const current = db
            .prepare("SELECT * FROM outbox WHERE id = ? AND state = 'sending' AND attempts = ?")
            .get(row.id, row.attempts);
          if (current === undefined) return;
          const timestamp = new Date(now).toISOString();
          if (Result.isSuccess(result)) {
            const providerId = result.success.provider_message_id;
            const validId = /^<[^\s<>@]+@[^\s<>@]+>$/.test(providerId);
            const collision = db
              .prepare(`SELECT message_id FROM messages WHERE inbox_id = ? AND message_id = ?
            UNION ALL SELECT message_id FROM message_aliases WHERE inbox_id = ? AND alias = ?`)
              .all(row.inbox_id, providerId, row.inbox_id, providerId);
            if (
              !validId ||
              collision.some(
                (value) =>
                  Schema.decodeUnknownSync(Schema.Struct({ message_id: Schema.String }))(value)
                    .message_id !== row.message_id,
              )
            ) {
              db.prepare(
                "UPDATE outbox SET state = 'failed', last_error_code = 'unknown_outcome', provider_message_id = ?, updated_at = ? WHERE id = ?",
              ).run(providerId, now, row.id);
              completeKey(db, row, now);
              updateMessage(
                db,
                row.inbox_id,
                row.message_id,
                { add_labels: "failed", remove_labels: "queued" },
                timestamp,
              );
              outboundEvent(db, row.inbox_id, row.message_id, "failed", now, "unknown_outcome");
              return;
            }
            db.prepare(
              "INSERT OR IGNORE INTO message_aliases (inbox_id, alias, message_id) VALUES (?, ?, ?)",
            ).run(row.inbox_id, providerId, row.message_id);
            db.prepare(
              "UPDATE outbox SET state = 'sent', provider_message_id = ?, last_error_code = NULL, updated_at = ? WHERE id = ?",
            ).run(providerId, now, row.id);
            completeKey(db, row, now);
            updateMessage(
              db,
              row.inbox_id,
              row.message_id,
              { add_labels: "sent", remove_labels: ["queued", "failed"] },
              timestamp,
            );
            outboundEvent(db, row.inbox_id, row.message_id, "sent", now);
          } else {
            const error = result.failure;
            const retry = error.retryable && !error.outcome_unknown && row.attempts < MAX_ATTEMPTS;
            const delay = Math.max(
              Math.min(1000 * 2 ** (row.attempts - 1), MAX_BACKOFF_MS),
              error.retry_after_ms ?? 0,
            );
            db.prepare(
              "UPDATE outbox SET state = ?, next_attempt_at = ?, last_error_code = ?, updated_at = ? WHERE id = ?",
            ).run(
              retry ? "queued" : "failed",
              now + delay,
              error.outcome_unknown ? "unknown_outcome" : error.code,
              now,
              row.id,
            );
            if (!retry) {
              completeKey(db, row, now);
              updateMessage(
                db,
                row.inbox_id,
                row.message_id,
                { add_labels: "failed", remove_labels: "queued" },
                timestamp,
              );
              outboundEvent(
                db,
                row.inbox_id,
                row.message_id,
                "failed",
                now,
                error.outcome_unknown ? "unknown_outcome" : error.code,
              );
            }
          }
        });
        processed++;
      }
      return processed;
    });

  function enqueue(
    db: Database.Database,
    now: number,
    inboxId: string,
    input: OutboundRequest,
    idempotencyKey?: string,
    draft = false,
  ) {
    if (idempotencyKey !== undefined) {
      try {
        Schema.decodeUnknownSync(IdempotencyKey)(idempotencyKey);
      } catch {
        throw invalid("Idempotency-Key must contain 1 to 256 permitted characters.");
      }
    }
    const request = decodeRequest(input);
    const fingerprint = createHash("sha256").update(canonical(request)).digest("hex");
    const inbox = getInbox(db, inboxId);
    if (idempotencyKey !== undefined) {
      const expired = db
        .prepare(
          "DELETE FROM outbound_idempotency WHERE inbox_id = ? AND idempotency_key = ? AND completed_at <= ?",
        )
        .run(inboxId, idempotencyKey, now - IDEMPOTENCY_TTL);
      if (expired.changes)
        db.prepare(
          "UPDATE outbox SET idempotency_key = NULL WHERE inbox_id = ? AND idempotency_key = ?",
        ).run(inboxId, idempotencyKey);
      const existing = db
        .prepare("SELECT * FROM outbound_idempotency WHERE inbox_id = ? AND idempotency_key = ?")
        .get(inboxId, idempotencyKey);
      if (existing !== undefined) {
        const replay = Schema.decodeUnknownSync(ReplayRow)(existing);
        if (replay.fingerprint !== fingerprint)
          throw new OutboundError({
            code: "idempotency_conflict",
            message: "This idempotency key belongs to a different request.",
            fix: "Use the original request or a new idempotency key.",
            retryable: false,
          });
        return { message_id: replay.message_id, thread_id: replay.thread_id };
      }
    }
    if (inbox.status === "paused")
      throw new OutboundError({
        code: "inbox_paused",
        message: "This inbox is paused.",
        fix: "Resume the inbox before enqueueing mail.",
        retryable: false,
      });
    const composed = draft
      ? compose(inboxId, request, { draft: true })
      : prepare(db, inboxId, request);
    assertOutbound(
      db,
      inboxId,
      [...composed.to, ...composed.cc, ...composed.bcc],
      request.kind === "reply" ||
        request.kind === "reply-all" ||
        (draft && composed.in_reply_to !== undefined),
    );
    const messageId = `<${randomUUID()}@inbot.local>`;
    const timestamp = new Date(now).toISOString();
    const raw = renderMime(composed.provider, messageId, timestamp);
    const identity = insertMessage(
      db,
      {
        inbox_id: inboxId,
        message_id: messageId,
        direction: "sent",
        from: inboxId,
        timestamp,
        raw,
        to: composed.to,
        cc: composed.cc,
        bcc: composed.bcc,
        reply_to: composed.reply_to,
        subject: composed.provider.subject,
        ...(composed.provider.text !== undefined ? { text: composed.provider.text } : {}),
        ...(composed.provider.html !== undefined ? { html: composed.provider.html } : {}),
        ...(composed.in_reply_to !== undefined ? { in_reply_to: composed.in_reply_to } : {}),
        references: composed.references,
        headers: composed.provider.headers,
        labels: [
          ...(request.request.labels ?? []).filter((label) => !managedLabels.has(label)),
          "queued",
        ],
        attachments: composed.provider.attachments.map((attachment) => ({
          filename: attachment.filename,
          content_type: attachment.type,
          content_disposition: attachment.disposition,
          ...(attachment.content_id !== undefined ? { content_id: attachment.content_id } : {}),
          content: Buffer.from(attachment.content, "base64"),
        })),
      },
      now,
    );
    db.prepare(`INSERT INTO outbox (id, inbox_id, idempotency_key, fingerprint, provider_message, state, next_attempt_at, message_id, thread_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`).run(
      randomUUID(),
      inboxId,
      idempotencyKey ?? null,
      fingerprint,
      JSON.stringify(composed.provider),
      now,
      identity.message_id,
      identity.thread_id,
      now,
      now,
    );
    if (idempotencyKey !== undefined)
      db.prepare(
        "INSERT INTO outbound_idempotency (inbox_id, idempotency_key, fingerprint, message_id, thread_id) VALUES (?, ?, ?, ?, ?)",
      ).run(inboxId, idempotencyKey, fingerprint, identity.message_id, identity.thread_id);
    return identity;
  }

  function sendDraft(
    inboxId: string,
    draftId: string,
    input: SendDraftRequest = {},
    idempotencyKey?: string,
    approve = false,
    excludedLabels: readonly string[] = [],
  ) {
    return run((db, now) => {
      const fingerprint = createHash("sha256")
        .update(canonical({ draft_id: draftId, ...input }))
        .digest("hex");
      if (idempotencyKey !== undefined) {
        const value = db
          .prepare("SELECT * FROM draft_send_replays WHERE inbox_id = ? AND idempotency_key = ?")
          .get(inboxId, idempotencyKey);
        if (value !== undefined) {
          const replay = Schema.decodeUnknownSync(
            Schema.Struct({
              fingerprint: Schema.String,
              message_id: Schema.String,
              thread_id: Schema.String,
            }),
          )(value);
          if (replay.fingerprint !== fingerprint)
            throw new OutboundError({
              code: "idempotency_conflict",
              message: "This idempotency key belongs to a different draft send.",
              fix: "Use the original draft and labels or a new idempotency key.",
              retryable: false,
            });
          return { message_id: replay.message_id, thread_id: replay.thread_id };
        }
      }
      const stored = getDraft(db, inboxId, draftId);
      if (stored.labels.some((label) => excludedLabels.includes(label))) throw notFound();
      if (stored.approval_state === "rejected")
        throw new OutboundError({
          code: "message_rejected",
          message: "The owner rejected this draft.",
          fix: "Create a new draft for the owner to review.",
          retryable: false,
        });
      if (!approve && stored.approval_state === "pending")
        throw new OutboundError({
          code: "approval_required",
          message: `Draft ${draftId} requires owner approval.`,
          fix: `Ask the owner to approve draft ${draftId}.`,
          retryable: false,
        });
      const draft = { ...stored, labels: sendLabels(stored.labels, input) };
      const request = draftRequest(draft);
      if (approve && stored.approval_state !== "approved")
        draftEvent(db, draft, "draft.approved", now);
      if (approve && draft.send_at !== undefined && Date.parse(draft.send_at) > now) {
        const composed = compose(inboxId, request, { draft: true });
        assertOutbound(
          db,
          inboxId,
          [...composed.to, ...composed.cc, ...composed.bcc],
          draft.in_reply_to !== undefined,
        );
        return saveDraft(db, {
          ...draft,
          approval_state: "approved",
          pending_approval: false,
          send_status: "scheduled",
          ...(idempotencyKey === undefined ? {} : { send_idempotency_key: idempotencyKey }),
          updated_at: new Date(now).toISOString(),
        });
      }
      const response = enqueue(db, now, inboxId, request, idempotencyKey, true);
      db.prepare("UPDATE outbox SET source_draft_id = ? WHERE inbox_id = ? AND message_id = ?").run(
        draftId,
        inboxId,
        response.message_id,
      );
      db.prepare("DELETE FROM drafts WHERE inbox_id = ? AND draft_id = ?").run(inboxId, draftId);
      if (idempotencyKey !== undefined)
        db.prepare(`INSERT INTO draft_send_replays
        (inbox_id, idempotency_key, draft_id, fingerprint, message_id, thread_id) VALUES (?, ?, ?, ?, ?, ?)`).run(
          inboxId,
          idempotencyKey,
          draftId,
          fingerprint,
          response.message_id,
          response.thread_id,
        );
      return response;
    });
  }

  return {
    enqueue: (inboxId: string, input: OutboundRequest, idempotencyKey?: string) =>
      run((db, now) => enqueue(db, now, inboxId, input, idempotencyKey)),
    sendDraft,
    get: (inboxId: string, messageId: string) =>
      run((db) => {
        const row = db
          .prepare("SELECT * FROM outbox WHERE inbox_id = ? AND message_id = ?")
          .get(inboxId, messageId);
        if (row === undefined) throw notFound();
        return Schema.decodeUnknownSync(OutboxEntry)(row);
      }, false),
    processDue,
    applyDeliveryEvent: (input: DeliveryEvent) =>
      run((db, now) => {
        let event: DeliveryEvent;
        try {
          event = Schema.decodeUnknownSync(DeliveryEvent)(input);
        } catch {
          throw invalid("The delivery event is invalid.");
        }
        const rows = db
          .prepare(`SELECT a.inbox_id, a.message_id FROM message_aliases a JOIN outbox o
        ON o.inbox_id = a.inbox_id AND o.message_id = a.message_id WHERE a.alias = ? AND o.provider_message_id = ?`)
          .all(event.provider_message_id, event.provider_message_id);
        for (const value of rows) {
          const row = Schema.decodeUnknownSync(AliasRow)(value);
          const inserted = db
            .prepare(
              "INSERT OR IGNORE INTO delivery_events (inbox_id, message_id, event_id, status, recipient, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run(
              row.inbox_id,
              row.message_id,
              event.event_id,
              event.status,
              event.recipient,
              event.timestamp,
            );
          if (inserted.changes) {
            updateMessage(
              db,
              row.inbox_id,
              row.message_id,
              { add_labels: event.status },
              new Date(now).toISOString(),
            );
            deliveryEvent(db, row.inbox_id, row.message_id, event, now);
          }
        }
        return rows.length > 0;
      }),
    start: (intervalMs = 1000) =>
      Effect.gen(function* () {
        if (!Number.isFinite(intervalMs) || intervalMs <= 0)
          return yield* invalid("The runner interval must be positive.");
        return yield* Effect.gen(function* () {
          while (true) {
            yield* processDue();
            yield* Effect.sleep(intervalMs);
          }
        }).pipe(Effect.forkScoped);
      }),
  };
}

export type OutboxService = ReturnType<typeof makeOutbox>;
export class Outbox extends Context.Service<Outbox, OutboxService>()("inbot/Outbox") {
  static readonly Live = Layer.effect(
    Outbox,
    Effect.gen(function* () {
      return makeOutbox(yield* Store, yield* OutboundProvider);
    }),
  );
}
