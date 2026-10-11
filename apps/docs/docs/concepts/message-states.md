---
title: Message states
description: Send statuses, delivery labels, inbound labels and hidden labels, what each one means and proves, and what to do about each.
---

Inbot keeps states that mean different things apart. `queued`, `sent`, `delivered`, `bounced` and `failed` are never merged, and no surface reports an outcome Inbot has not observed.

## Send status

Every outgoing message has a `send_status`:

| Status         | Meaning                                                                      | What to do                                                                                 |
| -------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `queued`       | Stored and waiting to be sent, or waiting to retry                           | Wait                                                                                       |
| `sending`      | Being handed to Cloudflare right now                                         | Wait                                                                                       |
| `sent`         | Cloudflare accepted the message. It does not mean the recipient received it. | Watch delivery labels                                                                      |
| `failed`       | It was not sent. `send_reason` explains why.                                 | Fix the cause, then send again with a new idempotency key                                  |
| `send_unknown` | Inbot cannot tell whether Cloudflare accepted it                             | Do not resend. The owner [resolves it](/guides/approvals#resolve-an-unknown-send-outcome). |

`send_unknown` happens after a network error or timeout during the provider call, a crash or expired lease while sending, or a success response Inbot cannot match. When the owner resolves it, the message becomes `sent` or `failed` with the reason `owner_confirmed_sent` or `owner_confirmed_not_sent`.

Draft scheduling has its own `send_status` on the draft: `scheduled`, `sending` or `failed`.

## Delivery labels

Delivery reports from Cloudflare are added as labels on the sent message:

| Label        | Meaning                                   |
| ------------ | ----------------------------------------- |
| `delivered`  | The receiving server accepted the message |
| `bounced`    | The message bounced                       |
| `complained` | The recipient marked it as spam           |
| `rejected`   | Cloudflare rejected the message           |
| `deferred`   | Delivery was delayed and will be retried  |
| `failed`     | Delivery failed                           |

These labels are a history of what Cloudflare reported, not a single state: one message can carry both `delivered` and `bounced`, for example when it had several recipients. Delivery labels do not change `send_status`. Reports Inbot cannot match to a message are dropped.

## Labels

Labels are free-form strings. A thread's labels are the union of its messages' labels.

| Labels                                                       | Set by                                                           |
| ------------------------------------------------------------ | ---------------------------------------------------------------- |
| `received`, `unread`                                         | Inbot, on every incoming message                                 |
| `unauthenticated`                                            | Inbot, when Cloudflare's results show no SPF, DKIM or DMARC pass |
| `queued`, `sent`, `failed`, `send_unknown`                   | Inbot, from the outbox. Callers cannot change them.              |
| `delivered`, `bounced`, `complained`, `rejected`, `deferred` | Inbot, from delivery reports. Callers cannot set them.           |
| `spam`, `blocked`, `trash`                                   | You or an agent. Inbot never sets them automatically.            |
| Anything else                                                | You or an agent, with `add_labels` and `remove_labels`           |

Mark mail as handled by removing `unread`.

### Hidden labels

`spam`, `blocked`, `unauthenticated` and `trash` hide a message. Listing hidden mail needs both an `include_spam`, `include_blocked`, `include_unauthenticated` or `include_trash` filter and the matching `label_*_read` permission; without the permission, the filter is ignored. Reading a hidden message directly returns `not_found`, and a thread is hidden if any of its messages is. Search always excludes hidden mail.

## Events

Each state change also produces an event: `message.received` (or `.spam`, `.blocked`, `.unauthenticated` for hidden mail), `message.sent`, `message.send_unknown`, `message.delivered`, `message.bounced`, `message.complained`, `message.rejected` and `message.failed`. Deferral produces no event. See [Events](/reference/events).
