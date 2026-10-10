import { Schema } from "effect";

export const EventType = Schema.Literals([
  "message.received",
  "message.received.spam",
  "message.received.blocked",
  "message.received.unauthenticated",
  "message.sent",
  "message.delivered",
  "message.bounced",
  "message.complained",
  "message.rejected",
  "domain.verified",
]).annotate({ identifier: "EventType" });
export type EventType = typeof EventType.Type;

export const MessageReceivedEventType = Schema.Literals([
  "message.received",
  "message.received.spam",
  "message.received.blocked",
  "message.received.unauthenticated",
]).annotate({ identifier: "MessageReceivedEventType" });
export type MessageReceivedEventType = typeof MessageReceivedEventType.Type;
