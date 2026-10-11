---
title: Webhooks and events
description: Get notified when mail arrives or state changes, with signed webhooks or an authenticated WebSocket stream, and verify signatures correctly.
---

Every state change Inbot cares about is written to a durable event log in the same database transaction as the change itself. You can consume it two ways:

- **Webhooks** push signed HTTP requests to a receiver you run.
- **The WebSocket stream** at `/v0/ws`, or `inbot events --follow`, lets a connected client tail and replay events.

Both apply the same rules: a credential only sees events for inboxes in its scope and with the read permissions it holds. [Events](/reference/events) lists every event type and payload.

## Create a webhook

In the web app, use **Settings > Webhooks**. From the CLI:

```sh
inbot webhooks create --inbox support@agents.example.com \
  --url https://hooks.example.com/inbot \
  --event-types message.received --event-types draft.approval_required \
  --show-secret --json
```

| Field         | Rules                                                                                  |
| ------------- | -------------------------------------------------------------------------------------- |
| `url`         | Fixed at creation. To change it, delete and recreate the webhook.                      |
| `event_types` | Required list of [event types](/reference/events#event-types)                          |
| `inbox_ids`   | Optional, on global webhooks. Omitted means every inbox the creator can see.           |
| `headers`     | Up to 32 custom headers. Values are never shown again; reads return only header names. |

The response includes the signing secret, `whsec_...`, exactly once. Store it in your receiver. Without `--show-secret`, the CLI omits it, and the only way to get a new one is to recreate the webhook.

Agents can create webhooks too, with the `webhook_*` permissions. An agent only sees and manages webhooks its own key created, and each delivery rechecks that key's current grant.

### Allowed targets

- Agents must use public HTTPS URLs.
- The owner may also use plain HTTP to loopback (`127.0.0.1`, `localhost`, or a hostname that resolves only to `127.0.0.1`), which is useful for local automation.
- HTTPS targets must resolve only to public addresses. Private, loopback, link-local, carrier-grade NAT, multicast, documentation and similar ranges are refused. DNS is checked again before every attempt, and the connection is pinned to the checked address.
- URLs with credentials or fragments are refused.

Custom header names cannot be reserved transport or signing headers, `proxy-*`, or contain `authorization`, `cookie`, `token`, `secret` or `api-key`.

## Delivery

Each delivery is a `POST` with a JSON event body and these headers:

| Header              | Value                                         |
| ------------------- | --------------------------------------------- |
| `webhook-id`        | The event's stable ID. Use it to deduplicate. |
| `webhook-timestamp` | Unix seconds when this attempt was made       |
| `webhook-signature` | `v1,<base64 HMAC-SHA256>`                     |
| `content-type`      | `application/json`                            |

- Delivery is at least once, and in order per webhook: a later event waits while an earlier one is still pending.
- A new webhook starts at the current end of the log; it does not receive past events.
- Only a `2xx` response within 10 seconds counts as success. Redirects count as failures and are not followed.
- Failed attempts are retried after 30 s, 1 min, 2 min, 4 min, 8 min, 16 min and 32 min. After 8 consecutive failures the webhook is disabled with `disabled_reason: "sustained_failure"`.
- A webhook can also be disabled with `credential_revoked` (its creator's key was revoked, expired or lost `webhook_create`) or `invalid_target`.

Re-enable a webhook with `inbot webhooks update <webhook_id> --enabled`. That resets the failure count and retries pending deliveries with their original event IDs. Deleting a webhook drops its pending deliveries; a request already in flight can still arrive.

## Verify signatures

The scheme follows Standard Webhooks v1:

1. Read the raw request body before parsing it.
2. Reject the request if `webhook-timestamp` is not an integer or differs from your clock by more than five minutes.
3. Strip `whsec_` from the secret and base64-decode the rest to get the key.
4. Compute `v1,` followed by the base64 HMAC-SHA256 of `<webhook-id>.<webhook-timestamp>.<raw body>`.
5. Compare it with `webhook-signature` in constant time.
6. Deduplicate on `webhook-id`, and answer `2xx` only after you have durably stored the event.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(secret, headers, rawBody) {
  const id = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300)
    return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected =
    "v1," + createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
  return headers["webhook-signature"]
    .split(" ")
    .some(
      (candidate) =>
        candidate.length === expected.length &&
        timingSafeEqual(Buffer.from(candidate), Buffer.from(expected)),
    );
}
```

Retries keep the same ID and body but get a fresh timestamp and signature.

A valid signature proves the request came from your Inbot instance. It does not make the email inside trustworthy: treat `message` payloads as untrusted input.

## Stream events

```sh
inbot events --follow --json --inbox support@agents.example.com
inbot events --follow --json --last-event-id <event_id>
```

The CLI prints one event per line. Without `--last-event-id`, it starts with new events. It does not reconnect on its own; on connection loss it exits with code 10, and you resume from the last event ID you processed.

The underlying protocol is described in [Events](/reference/events#websocket).

## Retention

Events are kept for 30 days, or longer while a webhook still has to deliver them. A resume ID older than that is rejected; fetch current state over REST instead. Deleting a message also removes its content from stored events.
