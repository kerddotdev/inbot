import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  AttachmentResponse,
  ApiKey,
  BatchGetMessagesRequest,
  BatchGetMessagesResponse,
  BatchUpdateMessagesRequest,
  CreateApiKeyResponse,
  CreateDraftRequest,
  CreateInboxRequest,
  Direction,
  Domain,
  Draft,
  DraftItem,
  ErrorCode,
  ErrorResponse,
  Event,
  Inbox,
  IdempotencyKey,
  ListEntry,
  Message,
  MessageItem,
  Permissions,
  SendMessageRequest,
  SendPolicy,
  Subscribe,
  Subscribed,
  Thread,
  Timestamp,
  UpdateDraftRequest,
  UpdateInboxRequest,
  Webhook,
} from "./index.js";

function expectRoundTrip<A, I>(schema: Schema.Codec<A, I>, fixture: unknown) {
  const decoded = Schema.decodeUnknownSync(schema)(fixture);
  expect(Schema.encodeSync(schema)(decoded)).toEqual(fixture);
}

const timestamp = "2026-10-10T09:12:34.123Z";
const inbox = {
  inbox_id: "assistant@agents.example.com",
  email: "assistant@agents.example.com",
  display_name: "Assistant",
  client_id: "assistant-inbox",
  status: "active",
  metadata: { team: "research", priority: 2, enabled: true },
  created_at: timestamp,
  updated_at: timestamp,
};
const attachment = {
  attachment_id: "att-report",
  filename: "report.txt",
  size: 24,
  content_type: "text/plain",
  content_disposition: "attachment",
  content_id: "report",
};
const message = {
  inbox_id: inbox.inbox_id,
  thread_id: "thread-1",
  message_id: "<report-1@example.com>",
  labels: ["received", "unread"],
  timestamp,
  from: "Alex <alex@example.com>",
  reply_to: ["alex@example.com"],
  to: ["Assistant <assistant@agents.example.com>"],
  cc: ["reviewer@example.com"],
  bcc: [],
  subject: "Research update",
  preview: "Here is the report.",
  text: "Here is the report.\n\n> Earlier conversation",
  html: "<p>Here is the report.</p><blockquote>Earlier conversation</blockquote>",
  extracted_text: "Here is the report.",
  extracted_html: "<p>Here is the report.</p>",
  attachments: [attachment],
  in_reply_to: "<previous@example.com>",
  references: ["<previous@example.com>"],
  calendar_event_id: "external-calendar-reference",
  headers: { "X-Research-Id": "r-1" },
  size: 512,
  created_at: timestamp,
  updated_at: timestamp,
};
const threadItem = {
  inbox_id: inbox.inbox_id,
  thread_id: "thread-1",
  labels: ["received", "unread"],
  timestamp,
  received_timestamp: timestamp,
  sent_timestamp: "2026-10-09T18:00:00Z",
  senders: ["Alex <alex@example.com>"],
  recipients: [inbox.inbox_id],
  subject: "Research update",
  preview: "Here is the report.",
  attachments: [attachment],
  last_message_id: message.message_id,
  message_count: 2,
  size: 1024,
  created_at: "2026-10-09T18:00:00Z",
  updated_at: timestamp,
};
const draft = {
  inbox_id: inbox.inbox_id,
  draft_id: "draft-1",
  client_id: "report-reply",
  labels: ["scheduled"],
  reply_to: [inbox.inbox_id],
  to: ["alex@example.com"],
  cc: [],
  bcc: [],
  subject: "Re: Research update",
  preview: "Thank you for the report.",
  text: "Thank you for the report.",
  html: "<p>Thank you for the report.</p>",
  attachments: [attachment],
  in_reply_to: message.message_id,
  forward_of: "<other@example.com>",
  references: [message.message_id],
  send_status: "scheduled",
  send_at: "2026-10-11T09:00:00+02:00",
  created_at: timestamp,
  updated_at: timestamp,
};
const domain = {
  domain_id: "agents.example.com",
  domain: "agents.example.com",
  status: "PENDING",
  reason: "dns_records_missing",
  feedback_enabled: true,
  inbound_enabled: true,
  subdomains_enabled: false,
  tracking_enabled: false,
  client_id: "agent-domain",
  records: [
    { type: "TXT", name: "agents.example.com", value: "v=spf1 -all", status: "VALID" },
    {
      type: "MX",
      name: "agents.example.com",
      value: "mx.example.com",
      status: "MISSING",
      priority: 10,
      reason: "record_missing",
    },
    {
      type: "CNAME",
      name: "mail.agents.example.com",
      value: "target.example.com",
      status: "VALID",
    },
  ],
  created_at: timestamp,
  updated_at: timestamp,
};
const webhook = {
  webhook_id: "webhook-1",
  url: "https://receiver.example.com/events",
  event_types: ["message.received", "message.delivered"],
  inbox_ids: [inbox.inbox_id],
  inbox_id: inbox.inbox_id,
  secret: "whsec_synthetic_fixture",
  enabled: true,
  client_id: "research-events",
  created_at: timestamp,
  updated_at: timestamp,
};
const deliveryFields = {
  inbox_id: inbox.inbox_id,
  thread_id: message.thread_id,
  message_id: message.message_id,
  timestamp,
};

describe("wire fidelity", () => {
  it("round-trips an inbox, including metadata and status", () => {
    expectRoundTrip(Inbox, inbox);
  });

  it("round-trips a thread with full messages and a pagination cursor", () => {
    expectRoundTrip(Thread, {
      ...threadItem,
      count: 1,
      limit: 1,
      next_page_token: "older-page",
      messages: [message],
    });
  });

  it("round-trips a full message with extracted bodies and attachment metadata", () => {
    expectRoundTrip(Message, message);
  });

  it("round-trips a draft without changing its send status or timestamp representation", () => {
    expectRoundTrip(Draft, draft);
  });

  it("round-trips a domain and its verification records", () => {
    expectRoundTrip(Domain, domain);
  });

  it("round-trips a webhook without requiring optional subscription filters", () => {
    expectRoundTrip(Webhook, webhook);
    expectRoundTrip(Webhook, {
      webhook_id: "webhook-minimal",
      url: "https://receiver.example.com/events",
      secret: "whsec_synthetic_fixture",
      enabled: false,
      created_at: timestamp,
      updated_at: timestamp,
    });
  });

  it.each([
    "message.received",
    "message.received.spam",
    "message.received.blocked",
    "message.received.unauthenticated",
  ])("round-trips a %s event", (event_type) => {
    expectRoundTrip(Event, {
      type: "event",
      event_type,
      event_id: "evt-received",
      message,
      thread: threadItem,
    });
  });

  it.each([
    { event_type: "message.sent", send: { ...deliveryFields, recipients: ["alex@example.com"] } },
    {
      event_type: "message.delivered",
      delivery: { ...deliveryFields, recipients: ["alex@example.com"] },
    },
    {
      event_type: "message.bounced",
      bounce: {
        ...deliveryFields,
        type: "Permanent",
        sub_type: "NoEmail",
        recipients: [{ address: "alex@example.com", status: "5.1.1" }],
      },
    },
    {
      event_type: "message.complained",
      complaint: {
        ...deliveryFields,
        type: "abuse",
        sub_type: "reported",
        recipients: ["alex@example.com"],
      },
    },
    {
      event_type: "message.rejected",
      reject: { ...deliveryFields, reason: "Blocked recipient" },
    },
    { event_type: "domain.verified", domain: { ...domain, status: "VERIFIED" } },
  ])("round-trips a $event_type event", (payload) => {
    expectRoundTrip(Event, { type: "event", event_id: "evt-status", ...payload });
  });

  it("round-trips WebSocket subscribe and subscribed messages", () => {
    const filters = {
      inbox_ids: [inbox.inbox_id],
      event_types: ["message.sent"],
    };
    expectRoundTrip(Subscribe, { type: "subscribe", ...filters });
    expectRoundTrip(Subscribed, { type: "subscribed", ...filters });
    expectRoundTrip(Subscribe, { type: "subscribe" });
    expectRoundTrip(Subscribed, { type: "subscribed" });
  });

  it("round-trips raw attachment download metadata and global list entries", () => {
    expectRoundTrip(AttachmentResponse, {
      ...attachment,
      download_url: "https://downloads.example.com/attachment",
      text_url: "https://downloads.example.com/extracted",
      expires_at: timestamp,
    });
    expectRoundTrip(ListEntry, {
      entry: "example.com",
      reason: "Trusted sender",
      direction: "receive",
      list_type: "allow",
      entry_type: "domain",
      read_only: false,
      created_at: timestamp,
    });
  });

  it("preserves full bodies in batch-get responses while omitting them from list items", () => {
    expectRoundTrip(BatchGetMessagesResponse, { count: 1, limit: 2, messages: [message] });
    const item = Schema.decodeUnknownSync(MessageItem)(message);
    expect(item).not.toHaveProperty("text");
    expect(item).not.toHaveProperty("html");
    expect(item).not.toHaveProperty("reply_to");
    expect(item.message_id).toBe(message.message_id);
  });

  it("preserves the additive approval flag in full drafts and list items", () => {
    expectRoundTrip(Draft, { ...draft, pending_approval: true });
    const item = Schema.decodeUnknownSync(DraftItem)({ ...draft, pending_approval: true });
    expect(item.pending_approval).toBe(true);
    expect(item.send_status).toBe("scheduled");
  });

  it("returns the plaintext API key only in the creation response schema", () => {
    const created = {
      api_key_id: "key-1",
      api_key: "inbot_fixture_synthetic",
      name: "Research agent",
      prefix: "inbot_fixture",
      inbox_ids: [inbox.inbox_id],
      permissions: { message_read: true, message_send: false },
      send_policy: "approval",
      created_at: timestamp,
      updated_at: timestamp,
      expires_at: "2027-10-10T09:12:34Z",
      used_at: timestamp,
    };
    expectRoundTrip(CreateApiKeyResponse, created);
    const stored = Schema.decodeUnknownSync(ApiKey)(created);
    expect(stored).not.toHaveProperty("api_key");
    expect(Schema.encodeSync(ApiKey)(stored)).not.toHaveProperty("api_key");
  });

  it("encodes a wire error without an Effect tag or an extra wrapper", () => {
    expectRoundTrip(ErrorResponse, {
      name: "ForbiddenError",
      code: "approval_required",
      message: "This send needs owner approval.",
      fix: "Create a draft for the owner to review.",
      docs: "https://example.com/errors#approval_required",
    });
  });
});

describe("request and literal validation", () => {
  it("rejects missing resource identifiers and required thread pagination fields", () => {
    const withoutInboxId = { ...inbox };
    Reflect.deleteProperty(withoutInboxId, "inbox_id");
    expect(() => Schema.decodeUnknownSync(Inbox)(withoutInboxId)).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(Thread)({ ...threadItem, messages: [message] }),
    ).toThrow();
  });

  it.each(["", " ", "bad/key", "key:value", "a".repeat(257)])(
    "rejects an invalid idempotency key %j",
    (value) => {
      expect(() => Schema.decodeUnknownSync(IdempotencyKey)(value)).toThrow();
    },
  );

  it("accepts both idempotency key length boundaries and the complete alphabet", () => {
    expectRoundTrip(IdempotencyKey, "A");
    expectRoundTrip(IdempotencyKey, "a".repeat(256));
    expectRoundTrip(IdempotencyKey, "AZaz09-._~");
  });

  it("rejects unsupported directions, policies, statuses, events, and error codes", () => {
    expect(() => Schema.decodeUnknownSync(Direction)("outbound")).toThrow();
    expect(() => Schema.decodeUnknownSync(SendPolicy)("read-only")).toThrow();
    expect(() => Schema.decodeUnknownSync(ErrorCode)("internal_error")).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(Draft)({ ...draft, send_status: "pending_approval" }),
    ).toThrow();
    expect(() => Schema.decodeUnknownSync(Domain)({ ...domain, status: "verified" })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(Event)({ type: "event", event_type: "message.opened" }),
    ).toThrow();
  });

  it("validates timestamp syntax while retaining offsets and fractional precision", () => {
    expectRoundTrip(Timestamp, "2026-10-10T11:12:34+02:00");
    expectRoundTrip(Timestamp, "2026-10-10T09:12:34.123456Z");
    expect(() => Schema.decodeUnknownSync(Timestamp)("2026-10-10")).toThrow();
    expect(() => Schema.decodeUnknownSync(Timestamp)("2026-13-10T09:12:34Z")).toThrow();
    expect(() => Schema.decodeUnknownSync(Timestamp)("2026-02-30T09:12:34Z")).toThrow();
  });

  it("accepts scalar send recipients, arrays, and both attachment sources", () => {
    expectRoundTrip(SendMessageRequest, {
      to: "Alex <alex@example.com>",
      cc: ["reviewer@example.com"],
      attachments: [
        { filename: "report.txt", content: "cmVwb3J0", content_type: "text/plain" },
        { url: "https://example.com/report.txt" },
      ],
      headers: { "X-Report-Id": "r-1" },
      labels: ["research"],
    });
  });

  it("accepts metadata removal and clearing without treating null as missing", () => {
    expectRoundTrip(UpdateInboxRequest, { metadata: { team: null, priority: 3 } });
    expectRoundTrip(UpdateInboxRequest, { metadata: null });
    expectRoundTrip(CreateInboxRequest, { status: "paused", metadata: { owner: "research" } });
    expect(() => Schema.decodeUnknownSync(UpdateInboxRequest)({})).toThrow();
    expect(() => Schema.decodeUnknownSync(UpdateInboxRequest)({ metadata: {} })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CreateInboxRequest)({ metadata: { team: null } }),
    ).toThrow();
  });

  it("preserves draft clearing, schedule cancellation, and reply context", () => {
    expectRoundTrip(UpdateDraftRequest, { to: null, subject: null, text: null, send_at: null });
    expectRoundTrip(CreateDraftRequest, {
      in_reply_to: message.message_id,
      forward_of: "<forwarded@example.com>",
      reply_all: true,
      send_at: timestamp,
    });
  });

  it("rejects duplicate and oversized batch identifiers", () => {
    expect(() =>
      Schema.decodeUnknownSync(BatchGetMessagesRequest)({ message_ids: ["a", "a"] }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(BatchUpdateMessagesRequest)({ message_ids: ["a", "a"] }),
    ).toThrow();
    const message_ids = Array.from({ length: 501 }, (_, index) => `<${index}@example.com>`);
    expect(() => Schema.decodeUnknownSync(BatchGetMessagesRequest)({ message_ids })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(BatchUpdateMessagesRequest)({
        message_ids: message_ids.slice(0, 51),
      }),
    ).toThrow();
  });

  it("validates boolean permission whitelists without adding default grants", () => {
    expectRoundTrip(Permissions, {});
    expectRoundTrip(Permissions, { message_read: true, message_send: false });
    expect(() => Schema.decodeUnknownSync(Permissions)({ message_send: "true" })).toThrow();
  });
});
