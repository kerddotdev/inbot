import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { Context, Effect, Layer, Schema } from "effect";
import { Event, type DraftEvent } from "../../../../packages/contracts/src/events.js";
import type { Principal } from "../../../../packages/contracts/src/security.js";
import type { Subscribe } from "../../../../packages/contracts/src/events.js";
import type { DeliveryEvent } from "../../../../packages/contracts/src/outbound.js";
import { Store, type StoreService } from "../store.js";
import { inScope, labelsAllowed, permits } from "../agent/authorization.js";
import { getMessage, getThreadItem, messageLabels, threadLabels } from "../mailbox/rows.js";
import { validationError } from "../mailbox/errors.js";

export const EventRow = Schema.Struct({
  sequence: Schema.Int,
  event_id: Schema.String,
  inbox_id: Schema.NullOr(Schema.String),
  event_type: Schema.String,
  labels: Schema.fromJsonString(Schema.Array(Schema.String)),
  payload: Schema.fromJsonString(Event),
  created_at: Schema.Int,
});
export type EventRow = typeof EventRow.Type;
export const EVENT_RETENTION_MS = 30 * 24 * 60 * 60_000;

export function pruneEvents(db: Database.Database, now: number) {
  return db
    .prepare(`DELETE FROM event_log WHERE sequence IN (
    SELECT e.sequence FROM event_log e WHERE e.created_at < ?
    AND (e.invalid = 1 OR NOT EXISTS (SELECT 1 FROM webhooks w WHERE w.cursor < e.sequence))
    AND NOT EXISTS (SELECT 1 FROM webhook_deliveries d
      WHERE d.sequence = e.sequence AND d.state IN ('pending', 'sending'))
    ORDER BY e.created_at, e.sequence LIMIT 500
  )`)
    .run(now - EVENT_RETENTION_MS).changes;
}

export function eventInbox(event: Event): string | undefined {
  if ("message" in event) return event.message.inbox_id;
  if ("send" in event) return event.send.inbox_id;
  if ("delivery" in event) return event.delivery.inbox_id;
  if ("bounce" in event) return event.bounce.inbox_id;
  if ("complaint" in event) return event.complaint.inbox_id;
  if ("reject" in event) return event.reject.inbox_id;
  if ("failure" in event) return event.failure.inbox_id;
  if ("outcome" in event) return event.outcome.inbox_id;
  if ("draft" in event) return event.draft.inbox_id;
  if ("credential" in event) return event.credential.inbox_id;
  if ("credential_use" in event) return event.credential_use.inbox_id;
  if ("credential_request" in event) return event.credential_request.inbox_id;
  return undefined;
}

export function appendEvent(
  db: Database.Database,
  event: Event,
  now: number,
  labels: readonly string[] = [],
) {
  if (!db.inTransaction) throw new Error("Events require the state change transaction");
  const decoded = Schema.decodeUnknownSync(Event)(event);
  db.prepare(`INSERT OR IGNORE INTO event_log
    (event_id, inbox_id, event_type, labels, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
    decoded.event_id,
    eventInbox(decoded) ?? null,
    decoded.event_type,
    JSON.stringify(labels),
    JSON.stringify(decoded),
    now,
  );
}

export function receivedEvent(
  db: Database.Database,
  inboxId: string,
  messageId: string,
  now: number,
) {
  const message = getMessage(db, inboxId, messageId);
  const thread = getThreadItem(db, inboxId, message.thread_id);
  const eventType = message.labels.includes("blocked")
    ? "message.received.blocked"
    : message.labels.includes("spam")
      ? "message.received.spam"
      : message.labels.includes("unauthenticated")
        ? "message.received.unauthenticated"
        : "message.received";
  appendEvent(
    db,
    {
      type: "event",
      event_type: eventType,
      event_id: randomUUID(),
      message,
      thread,
    },
    now,
    [...message.labels, ...thread.labels],
  );
}

export function draftEvent(
  db: Database.Database,
  draft: {
    readonly inbox_id: string;
    readonly draft_id: string;
    readonly labels: readonly string[];
  },
  eventType: DraftEvent["event_type"],
  now: number,
  identity?: { readonly message_id: string; readonly thread_id: string },
) {
  appendEvent(
    db,
    {
      type: "event",
      event_type: eventType,
      event_id: randomUUID(),
      draft: {
        inbox_id: draft.inbox_id,
        draft_id: draft.draft_id,
        timestamp: new Date(now).toISOString(),
        ...identity,
      },
    },
    now,
    draft.labels,
  );
}

export function outboundEvent(
  db: Database.Database,
  inboxId: string,
  messageId: string,
  status: "sent" | "failed" | "send_unknown",
  now: number,
  reason?: string,
) {
  const message = getMessage(db, inboxId, messageId);
  const identity = {
    inbox_id: inboxId,
    message_id: messageId,
    thread_id: message.thread_id,
    timestamp: new Date(now).toISOString(),
  };
  appendEvent(
    db,
    status === "sent"
      ? {
          type: "event",
          event_type: "message.sent",
          event_id: randomUUID(),
          send: {
            ...identity,
            ...(reason === undefined ? {} : { reason }),
            recipients: [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])],
          },
        }
      : status === "send_unknown"
        ? {
            type: "event",
            event_type: "message.send_unknown",
            event_id: randomUUID(),
            outcome: { ...identity, reason: reason ?? "unknown_outcome" },
          }
        : {
            type: "event",
            event_type: "message.failed",
            event_id: randomUUID(),
            failure: { ...identity, reason: reason ?? "send_failed" },
          },
    now,
    message.labels,
  );
  if (status === "sent") {
    const source = Schema.decodeUnknownSync(
      Schema.Struct({ source_draft_id: Schema.NullOr(Schema.String) }),
    )(
      db
        .prepare("SELECT source_draft_id FROM outbox WHERE inbox_id = ? AND message_id = ?")
        .get(inboxId, messageId),
    );
    if (source.source_draft_id !== null)
      draftEvent(
        db,
        {
          inbox_id: inboxId,
          draft_id: source.source_draft_id,
          labels: message.labels,
        },
        "draft.sent",
        now,
        identity,
      );
  }
}

export function deliveryEvent(
  db: Database.Database,
  inboxId: string,
  messageId: string,
  input: DeliveryEvent,
  now: number,
) {
  const message = getMessage(db, inboxId, messageId);
  const identity = {
    inbox_id: inboxId,
    message_id: messageId,
    thread_id: message.thread_id,
    timestamp: input.timestamp,
  };
  const envelope = { type: "event" as const, event_id: `delivery:${inboxId}:${input.event_id}` };
  let event: Event;
  switch (input.status) {
    case "delivered":
      event = {
        ...envelope,
        event_type: "message.delivered",
        delivery: { ...identity, recipients: [input.recipient] },
      };
      break;
    case "bounced":
      event = {
        ...envelope,
        event_type: "message.bounced",
        bounce: {
          ...identity,
          type: "unknown",
          sub_type: "unknown",
          recipients: [{ address: input.recipient, status: "bounced" }],
        },
      };
      break;
    case "complained":
      event = {
        ...envelope,
        event_type: "message.complained",
        complaint: {
          ...identity,
          type: "unknown",
          sub_type: "unknown",
          recipients: [input.recipient],
        },
      };
      break;
    case "failed":
      event = {
        ...envelope,
        event_type: "message.failed",
        failure: { ...identity, reason: "delivery_failed" },
      };
      break;
    case "rejected":
      event = {
        ...envelope,
        event_type: "message.rejected",
        reject: { ...identity, reason: "provider_rejected" },
      };
      break;
    case "deferred":
      return;
  }
  appendEvent(db, event, now, messageLabels(db, inboxId, messageId));
}

export function eventVisible(
  row: EventRow,
  principal: Principal,
  subscription: Pick<Subscribe, "event_types" | "inbox_ids"> = {},
) {
  if (
    subscription.event_types !== undefined &&
    !subscription.event_types.includes(row.payload.event_type)
  )
    return false;
  if (row.inbox_id === null)
    return principal.kind === "owner" && subscription.inbox_ids === undefined;
  if (subscription.inbox_ids !== undefined && !subscription.inbox_ids.includes(row.inbox_id))
    return false;
  return (
    inScope(principal, row.inbox_id) &&
    labelsAllowed(principal, row.labels) &&
    permits(
      principal,
      "credential_request" in row.payload
        ? "credential_request"
        : "credential" in row.payload || "credential_use" in row.payload
          ? "credential_read"
          : "draft" in row.payload
            ? "draft_read"
            : "message_read",
    )
  );
}

export function eventReadable(
  db: Database.Database,
  row: EventRow,
  principal: Principal,
  subscription: Pick<Subscribe, "event_types" | "inbox_ids"> = {},
) {
  if (!eventVisible(row, principal, subscription)) return false;
  if (principal.kind === "owner") return true;
  const event = row.payload;
  if ("credential_request" in event) {
    const request = Schema.decodeUnknownSync(
      Schema.optional(Schema.Struct({ api_key_id: Schema.NullOr(Schema.String) })),
    )(
      db
        .prepare("SELECT api_key_id FROM credential_requests WHERE request_id = ? AND inbox_id = ?")
        .get(event.credential_request.request_id, event.credential_request.inbox_id),
    );
    return request?.api_key_id === principal.api_key_id;
  }
  const message =
    "message" in event
      ? event.message
      : "send" in event
        ? event.send
        : "delivery" in event
          ? event.delivery
          : "bounce" in event
            ? event.bounce
            : "complaint" in event
              ? event.complaint
              : "reject" in event
                ? event.reject
                : "failure" in event
                  ? event.failure
                  : "outcome" in event
                    ? event.outcome
                    : undefined;
  if (message === undefined) return true;
  const current = Schema.decodeUnknownSync(
    Schema.optional(Schema.Struct({ thread_id: Schema.String })),
  )(
    db
      .prepare("SELECT thread_id FROM messages WHERE inbox_id = ? AND message_id = ?")
      .get(message.inbox_id, message.message_id),
  );
  if (
    current === undefined ||
    !labelsAllowed(principal, messageLabels(db, message.inbox_id, message.message_id))
  )
    return false;
  return (
    !("message" in event) ||
    labelsAllowed(principal, threadLabels(db, message.inbox_id, current.thread_id))
  );
}

export function readEvents(db: Database.Database, after: number, limit = 100) {
  return Schema.decodeUnknownSync(Schema.Array(EventRow))(
    db
      .prepare(
        "SELECT * FROM event_log WHERE sequence > ? AND invalid = 0 ORDER BY sequence LIMIT ?",
      )
      .all(after, limit),
  );
}

export function latestSequence(db: Database.Database) {
  return Schema.decodeUnknownSync(Schema.Struct({ sequence: Schema.Int }))(
    db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM event_log").get(),
  ).sequence;
}

function makeEventLog(store: StoreService) {
  return {
    cursor: (eventId?: string) =>
      Effect.gen(function* () {
        const cursor = yield* store.use((db) =>
          eventId === undefined
            ? latestSequence(db)
            : Schema.decodeUnknownSync(Schema.optional(Schema.Struct({ sequence: Schema.Int })))(
                db.prepare("SELECT sequence FROM event_log WHERE event_id = ?").get(eventId),
              )?.sequence,
        );
        if (cursor === undefined) return yield* validationError("The resume event id is unknown.");
        return cursor;
      }),
    read: (after: number) => store.use((db) => readEvents(db, after)),
    readable: (
      sequence: number,
      principal: Principal,
      subscription: Pick<Subscribe, "event_types" | "inbox_ids">,
    ) =>
      store.use((db) => {
        const row = Schema.decodeUnknownSync(Schema.optional(EventRow))(
          db.prepare("SELECT * FROM event_log WHERE sequence = ? AND invalid = 0").get(sequence),
        );
        return row !== undefined && eventReadable(db, row, principal, subscription)
          ? row.payload
          : undefined;
      }),
  };
}

export class EventLog extends Context.Service<EventLog, ReturnType<typeof makeEventLog>>()(
  "inbot/EventLog",
) {
  static readonly Live = Layer.effect(EventLog, Effect.map(Store, makeEventLog));
}
