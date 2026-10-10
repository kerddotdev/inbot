import { Schema } from "effect";

export const EventType = Schema.Literals([
  "message.received",
  "message.received.spam",
  "message.received.blocked",
  "message.received.unauthenticated",
  "message.sent",
  "message.send_unknown",
  "message.delivered",
  "message.bounced",
  "message.complained",
  "message.rejected",
  "message.failed",
  "draft.created",
  "draft.approval_required",
  "draft.approved",
  "draft.rejected",
  "draft.sent",
  "domain.verified",
  "oauth.authorized",
  "oauth.revoked",
  "oauth.tokens_revoked",
]).annotate({ identifier: "EventType" });
export type EventType = typeof EventType.Type;

export const MessageReceivedEventType = Schema.Literals([
  "message.received",
  "message.received.spam",
  "message.received.blocked",
  "message.received.unauthenticated",
]).annotate({ identifier: "MessageReceivedEventType" });
export type MessageReceivedEventType = typeof MessageReceivedEventType.Type;
