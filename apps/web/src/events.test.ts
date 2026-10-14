import { QueryClient } from "@tanstack/react-query";
import { expect, test } from "vitest";
import type { Event } from "@inbot/contracts/src/events.js";
import { invalidateEvent } from "./events";

const timestamp = "2026-10-10T12:00:00Z";
const cases: readonly { event: Event; changed: readonly string[] }[] = [
  {
    event: {
      type: "event",
      event_type: "inbound.quarantined",
      event_id: "quarantine",
      quarantine: { quarantine_id: "item", reason_code: "invalid_ciphertext", timestamp },
    },
    changed: ["quarantine"],
  },
  {
    event: {
      type: "event",
      event_type: "oauth.revoked",
      event_id: "oauth",
      oauth: { grant_id: "grant", client_id: "client", timestamp },
    },
    changed: ["oauth"],
  },
  {
    event: {
      type: "event",
      event_type: "message.sent",
      event_id: "sent",
      send: {
        inbox_id: "agent@example.test",
        message_id: "<sent@example.test>",
        thread_id: "thread",
        recipients: ["recipient@example.test"],
        timestamp,
      },
    },
    changed: ["inboxes", "threads", "thread"],
  },
  {
    event: {
      type: "event",
      event_type: "message.send_unknown",
      event_id: "unknown",
      outcome: {
        inbox_id: "agent@example.test",
        message_id: "<unknown@example.test>",
        thread_id: "thread",
        timestamp,
        reason: "unknown_outcome",
      },
    },
    changed: ["inboxes", "threads", "thread"],
  },
  {
    event: {
      type: "event",
      event_type: "draft.approval_required",
      event_id: "approval",
      draft: { inbox_id: "agent@example.test", draft_id: "draft", timestamp },
    },
    changed: ["inboxes", "threads", "thread", "approvals", "draft", "drafts"],
  },
  {
    event: {
      type: "event",
      event_type: "domain.verified",
      event_id: "domain",
      domain: {
        domain_id: "domain",
        domain: "agents.example.test",
        status: "VERIFIED",
        feedback_enabled: true,
        subdomains_enabled: true,
        tracking_enabled: false,
        records: [],
        created_at: timestamp,
        updated_at: timestamp,
      },
    },
    changed: ["domains", "inboxes"],
  },
  {
    event: {
      type: "event",
      event_type: "credential.updated",
      event_id: "credential",
      credential: { credential_id: "c1", inbox_id: "agent@example.test", fields: ["password"] },
    },
    changed: ["credentials"],
  },
  {
    event: {
      type: "event",
      event_type: "credential.use_requested",
      event_id: "use",
      credential_use: {
        request_id: "r1",
        inbox_id: "agent@example.test",
        kind: "fill",
        credential_ids: ["c1"],
        fields: ["password"],
      },
    },
    changed: ["approvals", "credentials"],
  },
  {
    event: {
      type: "event",
      event_type: "credential.requested",
      event_id: "request",
      credential_request: { request_id: "q1", inbox_id: "agent@example.test", fields: ["totp"] },
    },
    changed: ["approvals", "credentials"],
  },
];

test.each(cases)("$event.event_type invalidates affected query caches", ({ event, changed }) => {
  const client = new QueryClient();
  const keys = [
    "inboxes",
    "threads",
    "thread",
    "approvals",
    "credentials",
    "draft",
    "drafts",
    "domains",
    "keys",
    "transport",
    "quarantine",
  ];
  for (const key of keys) client.setQueryData([key, "synthetic"], { value: "cached" });
  invalidateEvent(client, event);
  for (const key of keys)
    expect(client.getQueryState([key, "synthetic"])?.isInvalidated).toBe(changed.includes(key));
  client.clear();
});
