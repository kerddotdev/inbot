import { Schema } from "effect";
import { Timestamp } from "./common.js";
import { ErrorCode } from "./errors.js";
import {
  SendMessageRequest,
  ReplyToMessageRequest,
  ReplyAllMessageRequest,
  ForwardMessageRequest,
} from "./messages.js";

export const OutboundRequest = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("send"), request: SendMessageRequest }),
  Schema.Struct({
    kind: Schema.Literal("reply"),
    message_id: Schema.String,
    request: ReplyToMessageRequest,
  }),
  Schema.Struct({
    kind: Schema.Literal("reply-all"),
    message_id: Schema.String,
    request: ReplyAllMessageRequest,
  }),
  Schema.Struct({
    kind: Schema.Literal("forward"),
    message_id: Schema.String,
    request: ForwardMessageRequest,
  }),
]);
export type OutboundRequest = typeof OutboundRequest.Type;

export const DeliveryStatus = Schema.Literals([
  "delivered",
  "bounced",
  "complained",
  "failed",
  "rejected",
  "deferred",
]);
export type DeliveryStatus = typeof DeliveryStatus.Type;
export const DeliveryEvent = Schema.Struct({
  event_id: Schema.String,
  provider_message_id: Schema.String,
  status: DeliveryStatus,
  recipient: Schema.String,
  timestamp: Timestamp,
});
export type DeliveryEvent = typeof DeliveryEvent.Type;

export const OutboxEntry = Schema.Struct({
  id: Schema.String,
  inbox_id: Schema.String,
  message_id: Schema.String,
  thread_id: Schema.String,
  state: Schema.Literals(["queued", "sending", "sent", "failed"]),
  attempts: Schema.Int,
  next_attempt_at: Schema.Finite,
  last_error_code: Schema.NullOr(Schema.Union([ErrorCode, Schema.Literal("unknown_outcome")])),
  provider_message_id: Schema.NullOr(Schema.String),
  created_at: Schema.Finite,
  updated_at: Schema.Finite,
});
export type OutboxEntry = typeof OutboxEntry.Type;
