import { Schema } from "effect";
import { DraftId, InboxId, MessageId, ThreadId, Timestamp } from "./common.js";
import { Domain } from "./domains.js";
import { EventType, MessageReceivedEventType } from "./event-types.js";
import { Message } from "./messages.js";
import { ThreadItem } from "./threads.js";

export const Recipient = Schema.Struct({
  address: Schema.String,
  status: Schema.String,
}).annotate({ identifier: "Recipient" });
export type Recipient = typeof Recipient.Type;

export const Send = Schema.Struct({
  reason: Schema.optionalKey(Schema.String),
  inbox_id: InboxId,
  thread_id: ThreadId,
  message_id: MessageId,
  timestamp: Timestamp,
  recipients: Schema.Array(Schema.String),
}).annotate({ identifier: "Send" });
export type Send = typeof Send.Type;

export const Delivery = Schema.Struct({
  inbox_id: InboxId,
  thread_id: ThreadId,
  message_id: MessageId,
  timestamp: Timestamp,
  recipients: Schema.Array(Schema.String),
}).annotate({ identifier: "Delivery" });
export type Delivery = typeof Delivery.Type;

export const Bounce = Schema.Struct({
  inbox_id: InboxId,
  thread_id: ThreadId,
  message_id: MessageId,
  timestamp: Timestamp,
  type: Schema.String,
  sub_type: Schema.String,
  recipients: Schema.Array(Recipient),
}).annotate({ identifier: "Bounce" });
export type Bounce = typeof Bounce.Type;

export const Complaint = Schema.Struct({
  inbox_id: InboxId,
  thread_id: ThreadId,
  message_id: MessageId,
  timestamp: Timestamp,
  type: Schema.String,
  sub_type: Schema.String,
  recipients: Schema.Array(Schema.String),
}).annotate({ identifier: "Complaint" });
export type Complaint = typeof Complaint.Type;

export const Reject = Schema.Struct({
  inbox_id: InboxId,
  thread_id: ThreadId,
  message_id: MessageId,
  timestamp: Timestamp,
  reason: Schema.String,
}).annotate({ identifier: "Reject" });
export type Reject = typeof Reject.Type;

export const MessageReceivedEvent = Schema.Struct({
  type: Schema.Literal("event"),
  event_type: MessageReceivedEventType,
  event_id: Schema.String,
  message: Message,
  thread: ThreadItem,
}).annotate({ identifier: "MessageReceivedEvent" });
export type MessageReceivedEvent = typeof MessageReceivedEvent.Type;

export const MessageSentEvent = Schema.Struct({
  type: Schema.Literal("event"),
  event_type: Schema.Literal("message.sent"),
  event_id: Schema.String,
  send: Send,
}).annotate({ identifier: "MessageSentEvent" });
export type MessageSentEvent = typeof MessageSentEvent.Type;

export const MessageDeliveredEvent = Schema.Struct({
  type: Schema.Literal("event"),
  event_type: Schema.Literal("message.delivered"),
  event_id: Schema.String,
  delivery: Delivery,
}).annotate({ identifier: "MessageDeliveredEvent" });
export type MessageDeliveredEvent = typeof MessageDeliveredEvent.Type;

export const MessageBouncedEvent = Schema.Struct({
  type: Schema.Literal("event"),
  event_type: Schema.Literal("message.bounced"),
  event_id: Schema.String,
  bounce: Bounce,
}).annotate({ identifier: "MessageBouncedEvent" });
export type MessageBouncedEvent = typeof MessageBouncedEvent.Type;

export const MessageComplainedEvent = Schema.Struct({
  type: Schema.Literal("event"),
  event_type: Schema.Literal("message.complained"),
  event_id: Schema.String,
  complaint: Complaint,
}).annotate({ identifier: "MessageComplainedEvent" });
export type MessageComplainedEvent = typeof MessageComplainedEvent.Type;

export const MessageRejectedEvent = Schema.Struct({
  type: Schema.Literal("event"),
  event_type: Schema.Literal("message.rejected"),
  event_id: Schema.String,
  reject: Reject,
}).annotate({ identifier: "MessageRejectedEvent" });
export type MessageRejectedEvent = typeof MessageRejectedEvent.Type;

export const MessageFailedEvent = Schema.Struct({
  type: Schema.Literal("event"),
  event_type: Schema.Literal("message.failed"),
  event_id: Schema.String,
  failure: Reject,
}).annotate({ identifier: "MessageFailedEvent" });
export type MessageFailedEvent = typeof MessageFailedEvent.Type;

export const MessageSendUnknownEvent = Schema.Struct({
  type: Schema.Literal("event"),
  event_type: Schema.Literal("message.send_unknown"),
  event_id: Schema.String,
  outcome: Reject,
}).annotate({ identifier: "MessageSendUnknownEvent" });
export type MessageSendUnknownEvent = typeof MessageSendUnknownEvent.Type;

export const DraftEvent = Schema.Struct({
  type: Schema.Literal("event"),
  event_type: Schema.Literals([
    "draft.created",
    "draft.approval_required",
    "draft.approved",
    "draft.rejected",
    "draft.sent",
  ]),
  event_id: Schema.String,
  draft: Schema.Struct({
    inbox_id: InboxId,
    draft_id: DraftId,
    timestamp: Timestamp,
    message_id: Schema.optionalKey(MessageId),
    thread_id: Schema.optionalKey(ThreadId),
  }),
}).annotate({ identifier: "DraftEvent" });
export type DraftEvent = typeof DraftEvent.Type;

export const DomainVerifiedEvent = Schema.Struct({
  type: Schema.Literal("event"),
  event_type: Schema.Literal("domain.verified"),
  event_id: Schema.String,
  domain: Domain,
}).annotate({ identifier: "DomainVerifiedEvent" });
export type DomainVerifiedEvent = typeof DomainVerifiedEvent.Type;

export const OAuthGrantEvent = Schema.Struct({
  type: Schema.Literal("event"),
  event_type: Schema.Literals(["oauth.authorized", "oauth.revoked", "oauth.tokens_revoked"]),
  event_id: Schema.String,
  oauth: Schema.Struct({ grant_id: Schema.String, client_id: Schema.String, timestamp: Timestamp }),
});

export const QuarantineEvent = Schema.Struct({
  type: Schema.Literal("event"),
  event_type: Schema.Literals(["inbound.quarantined", "inbound.released", "inbound.deleted"]),
  event_id: Schema.String,
  quarantine: Schema.Struct({
    quarantine_id: Schema.String,
    reason_code: Schema.String,
    timestamp: Timestamp,
  }),
});

export const EventEnvelope = Schema.Struct({
  type: Schema.Literal("event"),
  event_type: EventType,
  event_id: Schema.String,
});
export type EventEnvelope = typeof EventEnvelope.Type;

export const Event = Schema.Union([
  MessageReceivedEvent,
  MessageSentEvent,
  MessageDeliveredEvent,
  MessageBouncedEvent,
  MessageComplainedEvent,
  MessageRejectedEvent,
  MessageFailedEvent,
  MessageSendUnknownEvent,
  DraftEvent,
  DomainVerifiedEvent,
  OAuthGrantEvent,
  QuarantineEvent,
]).annotate({ identifier: "Event" });
export type Event = typeof Event.Type;

export const Subscribe = Schema.Struct({
  type: Schema.Literal("subscribe"),
  event_types: Schema.optionalKey(Schema.Array(EventType)),
  inbox_ids: Schema.optionalKey(Schema.Array(Schema.String)),
  last_event_id: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Subscribe" });
export type Subscribe = typeof Subscribe.Type;

export const Subscribed = Schema.Struct({
  ...Subscribe.fields,
  type: Schema.Literal("subscribed"),
}).annotate({ identifier: "Subscribed" });
export type Subscribed = typeof Subscribed.Type;

export const Heartbeat = Schema.Struct({
  type: Schema.Literal("ping"),
  timestamp: Timestamp,
});
export const Pong = Schema.Struct({ type: Schema.Literal("pong") });
export const WebSocketFrame = Schema.Union([Event, Subscribed, Heartbeat]);
export type WebSocketFrame = typeof WebSocketFrame.Type;
