---
title: Events
description: Every event type and payload, who can see it, how the durable and encrypted event log works, and the WebSocket subscription protocol.
---

Events are written to an encrypted, durable log in the same transaction as the state change they describe. Each event has a stable `event_id` that orders, deduplicates and resumes delivery. They reach consumers through [webhooks](/guides/webhooks) and the [WebSocket](#websocket).

## Event shape

```json
{
  "type": "event",
  "event_type": "message.received",
  "event_id": "...",
  "message": { "...": "the full message" },
  "thread": { "...": "the thread summary" }
}
```

## Event types

| Event type                                                                                   | Payload                                                                                            | Visible to                                     |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `message.received`                                                                           | `message`, `thread`                                                                                | `message_read`                                 |
| `message.received.spam`, `message.received.blocked`, `message.received.unauthenticated`      | `message`, `thread`, for mail with a hidden label                                                  | `message_read` and the matching `label_*_read` |
| `message.sent`                                                                               | `send`: identifiers, `timestamp`, `recipients`, optional `reason`                                  | `message_read`                                 |
| `message.send_unknown`                                                                       | `outcome`: identifiers, `timestamp`, `reason`                                                      | `message_read`                                 |
| `message.delivered`                                                                          | `delivery`: identifiers, `recipients`                                                              | `message_read`                                 |
| `message.bounced`                                                                            | `bounce`: identifiers, `type`, `sub_type`, `recipients` with status                                | `message_read`                                 |
| `message.complained`                                                                         | `complaint`: identifiers, `type`, `sub_type`, `recipients`                                         | `message_read`                                 |
| `message.rejected`                                                                           | `reject`: identifiers, `reason` (`provider_rejected`)                                              | `message_read`                                 |
| `message.failed`                                                                             | `failure`: identifiers, `reason`                                                                   | `message_read`                                 |
| `draft.created`, `draft.approval_required`, `draft.approved`, `draft.rejected`, `draft.sent` | `draft`: `inbox_id`, `draft_id`, `timestamp`, and `message_id`, `thread_id` once sent. No content. | `draft_read`                                   |
| `domain.verified`                                                                            | `domain`                                                                                           | Owner only                                     |
| `inbound.quarantined`, `inbound.released`, `inbound.deleted`                                | `quarantine`: `quarantine_id`, `reason_code`, `timestamp`. No content.                             | Owner only                                     |
| `oauth.authorized`, `oauth.revoked`, `oauth.tokens_revoked`                                  | `oauth`: `grant_id`, `client_id`, `timestamp`                                                      | Owner only                                     |

Identifiers are `inbox_id`, `thread_id` and `message_id`.

- A `message.received` event uses the hidden variant if the message has a hidden label, checked in the order blocked, spam, unauthenticated.
- `message.failed` covers send failures, recipients refused by lists when the outbox rechecks them, and owner resolution of `send_unknown` (`owner_confirmed_not_sent`). Owner resolution as sent emits `message.sent` with `owner_confirmed_sent`.
- `message.failed` also covers a provider failure report, with `failure.reason: "delivery_failed"`. Bounce and complaint payloads currently use `"unknown"` for both `type` and `sub_type`.
- `inbound.released` and `inbound.deleted` follow the observed cleanup of the Cloudflare object. Quarantine events are visible to the owner credential only; agent keys and OAuth tokens never receive them.
- Deferred delivery, list changes and inbound list rejections produce no event.

Every event is filtered by the consumer's current inbox scope and permissions at delivery time.

## The log

- Ordered by an increasing sequence; `event_id` is unique.
- Kept for 30 days, and longer only while a webhook still has to deliver an event.
- Deleting a message redacts its body, subject, preview, headers and attachment metadata from stored events in the same transaction. Replays and pending deliveries carry the redacted version.

## WebSocket

Connect to `GET /v0/ws` with `Authorization: Bearer <credential>`: the owner token, an API key, or an OAuth token issued for `<origin>/v0`. Credentials in the URL are not accepted. Browser sessions authenticate with the cookie, the exact origin, and the subprotocols `inbot.events` and `csrf.<csrf_token>`.

The credential needs `message_read` or `draft_read`. Webhook permissions alone are not enough.

### Subscribe

Nothing is streamed until the client sends exactly one subscribe frame:

```json
{
  "type": "subscribe",
  "event_types": ["message.received"],
  "inbox_ids": ["support@agents.example.com"],
  "last_event_id": "..."
}
```

The server answers `{ "type": "subscribed", ... }` and starts streaming.

- Omitted filters mean everything the credential can see; empty arrays match nothing.
- Without `last_event_id`, the stream starts with events that happen after the connection opened.
- To resume, pass `last_event_id` in the frame or as `?last_event_id=` on the URL. The server replays later events with current permissions and filters, then continues live. An unknown or expired ID in the URL returns `400 validation_error`; in the frame, it closes the connection.

### Heartbeat and limits

| Behavior                                                                                          | Result                                                                      |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| The server sends `{ "type": "ping", "timestamp": "..." }` every 20 s; answer `{ "type": "pong" }` | No pong for 60 s closes with `1001`                                         |
| Invalid frame, second subscribe, or unknown resume ID in the frame                                | Close `1008`                                                                |
| Revoked or expired credential, or lost read permission                                            | Close `1008`                                                                |
| Client frame over 8,192 characters                                                                | Close `1009`                                                                |
| More than 1 MiB waiting to be sent to a slow client                                               | Close `1013`; reconnect from the last ID and fetch large messages over REST |

The connection does not reconnect by itself. Store the last `event_id` you processed and resume from it.

`inbot events --follow` implements this protocol; see [Webhooks and events](/guides/webhooks#stream-events).
