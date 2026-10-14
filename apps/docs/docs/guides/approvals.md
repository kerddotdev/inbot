---
title: Drafts and approvals
description: How drafts, scheduled sends and owner approval work, how to approve or reject drafts and credential uses, and how to resolve a message whose outcome is unknown.
---

## Drafts

A draft is an unsent message. Agents and the owner can create, edit, schedule and delete drafts with the `draft_*` permissions. Drafts may be incomplete; recipients, size and attachment limits are checked only when the draft is sent or approved.

```sh
inbot drafts create support@agents.example.com --to customer@example.org \
  --subject "Your order" --text "Hello..."
inbot drafts list --inbox support@agents.example.com
inbot drafts send support@agents.example.com <draft_id> --idempotency-key order-42
```

A draft can start a new thread, reply to a message (`in_reply_to`, with `reply_all`) or forward one (`forward_of`). Replying or forwarding also needs `message_read` on the original.

| Field              | Values                                            |
| ------------------ | ------------------------------------------------- |
| `approval_state`   | `pending`, `approved` or `rejected`               |
| `pending_approval` | `true` while the owner has to decide              |
| `send_status`      | `scheduled`, `sending` or `failed`, when relevant |
| `send_at`          | Scheduled time, if any                            |
| `rejection_reason` | The owner's reason, after a rejection             |

A draft that is `sending` cannot be edited, deleted or rejected; edits return `resource_taken`.

## Scheduling

Set `send_at` when creating or updating a draft to schedule it. Scheduling needs `draft_send` and a send policy other than `read_only`. Set `send_at` to `null`, or delete the draft, to cancel.

Creation, editing and approval wake the scheduler; it waits until the next due time and wakes the outbox as soon as a send commits. Its 30-second idle and 2-second after-work checks are recovery caps.

The scheduler only sends approved drafts, and only while the service is running. After downtime it sends overdue drafts as soon as it starts, and the message's timestamp is the time it was actually queued. `send_at` is the earliest time Inbot queues the message, not a delivery promise. `drafts send` sends immediately and overrides any schedule.

## Approval

A key with the `approval` send policy never sends on its own:

- Its drafts are created as `pending`, and editing an approved draft makes it `pending` again.
- `send_message`, `reply_to_message`, `forward_message` and `send_draft` create or reuse a pending draft and return the error `approval_required`, with the draft's ID in `message` and `fix`. No message ID exists yet.
- A `draft.approval_required` event fires, so you can be notified by webhook.

Pending drafts appear on the **Approvals** page. Review the recipients, text and attachment download buttons, then:

- **Approve** queues the message, or keeps it scheduled if `send_at` is in the future. If the transport or composition fails, the draft stays pending.
- **Reject**, with an optional reason, is final. The draft can no longer be sent or approved, and any schedule is cancelled. The agent sees `approval_state: "rejected"` and the reason.

```sh
inbot drafts approve support@agents.example.com <draft_id>
inbot drafts reject support@agents.example.com <draft_id> --reason "Wrong customer"
```

Attachment buttons issue signed five-minute download capabilities. They require no bearer, recheck the issuer's current access, and must never be shared or logged.

Approve and reject are owner-only. There is no MCP tool for them, and agent keys get `missing_permission`. An agent that retries a send with the same idempotency key gets the same `approval_required` answer for the same draft, even after you decide.

## Credential use approvals

Approval also applies to the [credential vault](/guides/vault). A key with `use_policy: approval`, the default, cannot fill a credential into a browser page or resolve it for `inbot run` without you. The first attempt stores a pending request, emits `credential.use_requested` and returns `approval_required` with the request ID. Nothing is read and no browser is contacted.

```sh
inbot credentials use-requests list --state pending
inbot credentials use-requests approve <request_id>
inbot credentials use-requests reject <request_id>
```

Each request shows the key, the inbox, the credential names, the fields and the kind (`fill` or `run`). A `url_hint` is only what the agent claimed; Inbot checks the real page origin when it fills. Approving permits one use within 15 minutes, after which the agent repeats the identical call with the same idempotency key. Rejecting is final for that request. Pending requests expire after 24 hours, and an expired or used approval needs a new request with a new key.

Listing and deciding are owner-only and have no MCP tool. They work in an owner browser session through the tunnel, like draft approval.

## Credential requests

An agent that needs a value only you have, such as the password for an existing account, can ask for it with `request_credential` instead of asking in chat. You see the name, URL, requested field names and the agent's reason as plain text. The reason never grants anything.

```sh
inbot credentials requests --state pending
printf '%s' '{"password":"..."}' | inbot credentials fulfill <request_id> --fields-stdin
inbot credentials decline <request_id>
```

Fulfilling creates a credential in the agent's inbox and gives the agent its references. It must happen on the Inbot host and is blocked through the tunnel, because Cloudflare terminates TLS at its edge. Declining carries no secret and works through the tunnel. Requests expire after seven days.

## Resolve an unknown send outcome

If Inbot cannot tell whether Cloudflare accepted a message, for example after a network timeout, the message ends in `send_unknown`. Inbot never resends it automatically, because that could send it twice. See [Message states](/concepts/message-states).

Find out whether the message went out, for example by asking the recipient or checking Cloudflare, then record the answer. In the web app, open the message and choose **Resolve outcome**. From the CLI:

```sh
inbot messages resolve support@agents.example.com <message_id> --decision sent
inbot messages resolve support@agents.example.com <message_id> --decision failed
```

Resolving only records the outcome and emits `message.sent` or `message.failed`; it never calls Cloudflare. To try again after `failed`, send a new message with a new idempotency key. Resolving is owner-only, available through the local CLI and `POST /v0/inboxes/{inbox_id}/messages/{message_id}/resolve`, and blocked over the tunnel.
