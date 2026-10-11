# Sending

All send paths (REST send/reply/reply-all/forward, MCP send/reply/forward, draft send) use the same outbox and the same rules.

## Operations

| Operation  | MCP tool                                 | REST                               | Permission      | Thread                        |
| ---------- | ---------------------------------------- | ---------------------------------- | --------------- | ----------------------------- |
| Send       | `send_message`                           | `POST .../messages/send`           | `message_send`  | New thread                    |
| Reply      | `reply_to_message`                       | `POST .../messages/{id}/reply`     | `message_reply` | Existing thread of the parent |
| Reply all  | `reply_to_message` with `replyAll: true` | `POST .../messages/{id}/reply-all` | `message_reply` | Existing thread               |
| Forward    | `forward_message`                        | `POST .../messages/{id}/forward`   | `message_send`  | New thread                    |
| Send draft | `send_draft`                             | `POST .../drafts/{id}/send`        | `draft_send`    | As composed in the draft      |

Reply, reply-all, and forward also need `message_read` and a parent message you can see.

## Composition

- Provide `text`, `html`, or both. Providing both is best for compatibility.
- `to`, `cc`, `bcc`, `reply_to` accept one address string or an array (drafts use arrays). Addresses may be `user@domain` or `Name <user@domain>`.
- Reply recipients: the parent's Reply-To, or From if absent. Per-field overrides win, including an empty array. Use `reply_all: true` with overrides if you need both.
- Reply-all adds the original To and Cc, drops your own address and duplicates (case-insensitive), and never inherits Bcc. The reply-all endpoint accepts no recipient overrides.
- Subjects: replies keep an existing `Re:` and add one otherwise. Forwards get `Fwd:`. `reply` takes no subject.
- Replies contain only the text you provide. No quoted history is added. Add a short quote yourself only if it helps the reader.
- Forwards include an original-message section and the original attachments. Bcc is not shown in the forwarded summary.
- Threading follows `Message-ID`, `In-Reply-To`, and `References`. Never change subjects to try to join threads. Replies thread automatically. Replies to your own outgoing message require that message to have been accepted by the provider (state `sent`); until then the reply is rejected.
- Attachments: `content` is canonical base64, with `filename`, `content_type`, `content_disposition` (`inline` or `attachment`), and `content_id` (required for `inline`). `url` attachments fail with `not_supported`.
- Custom `headers`: only `X-*`, `In-Reply-To`, `References`, and `Auto-Submitted`. Header names are case-insensitive and cannot repeat, names are at most 100 bytes, values at most 2048 bytes, total at most 16 KiB, and at most 20 non-`X-` fields. Replies set their own threading headers. Send and forward refuse threading headers. Line breaks in subject, addresses, or headers are refused.
- Do not set system labels yourself. `received`, `queued`, `sent`, `send_unknown`, `failed`, and delivery labels are managed by the service and caller-supplied ones are dropped. Other custom labels in `labels` are kept through state changes.

## Limits

| Limit                      | Value                                                            |
| -------------------------- | ---------------------------------------------------------------- |
| Recipients (to + cc + bcc) | 50                                                               |
| Attachments                | 32                                                               |
| Composed size              | 5 MiB, counting base64 expansion, line wrapping, headers, bodies |
| Idempotency key            | 1-256 characters of `A-Za-z0-9._~-`                              |
| Inbound raw size           | 25 MiB (inbound only)                                            |

Exceeding them fails before anything is saved: `validation_error` (recipients, attachments, headers) or `payload_too_large` (size). The size check is deliberately conservative and can refuse a message a provider would accept. Shrink attachments rather than retrying.

System state labels (`received`, `queued`, `sent`, `send_unknown`, `failed`, `delivered`, `bounced`, `complained`, `rejected`, `deferred`) are protected on every message, including messages without an outbox entry. Message, thread, and batch label edits that add or remove any of them return `validation_error` with a fix and make no changes. Custom labels and `unread` remain editable.

## States and labels

A sent message carries labels that record real, observed state. Do not report more than you have seen.

| Label          | Meaning                                                                                |
| -------------- | -------------------------------------------------------------------------------------- |
| `queued`       | Stored locally, waiting for the outbox. Nothing has left the machine yet.              |
| `sent`         | The mail provider accepted it. Not proof of delivery.                                  |
| `failed`       | Send permanently failed without acceptance, or a later delivery failure beside `sent`. |
| `send_unknown` | Acceptance is unknown. The provider may have sent it. Do not resend; inform the human. |
| `delivered`    | The provider reported delivery for at least one recipient.                             |
| `bounced`      | The provider reported a bounce.                                                        |
| `complained`   | A recipient reported spam.                                                             |
| `rejected`     | The provider reported a rejection event for the message.                               |
| `deferred`     | Delivery is delayed and still being retried.                                           |

Delivery labels are observations, not exclusive states. With several recipients a message can be both `delivered` and `bounced`, and `deferred` can sit beside a later final label. A bounce does not remove `sent`.

Read the state with `get_message` (`send_status`, optional `send_reason`, and labels) or `GET .../messages/{message_id}`. Inbound mail has `received` and `unread` labels. Outbound mail has direction `sent` internally and the labels above.

### Outbox behavior

- The outbox sends in the background. Idle checks run every 30 seconds, and every 2 seconds after work. If the service is down, mail stays `queued` and goes out later.
- Retryable provider failures (429, quota, 5xx) back off from 1 second up to 1 hour, at most 8 attempts, then become `failed`. Permanent failures (invalid message, unverified sender, authentication) become `failed` immediately.
- A timeout, lost response, or crash with an expired 5-minute sending lease becomes `send_unknown`, with `send_reason: "unknown_outcome"`. It is never retried automatically. Do not resend; inform the human.
- `send_status: "failed"` means the send permanently failed without provider acceptance. A `failed` delivery label beside `send_status: "sent"` records a later delivery failure.
- Only the local owner can resolve `send_unknown`: `POST .../messages/{id}/resolve` with `{ "decision": "sent" }` after confirming it was sent, or `{ "decision": "failed" }` after confirming it was not sent. Resolution records a durable event and never sends mail. A deliberate retry creates a new message with a new idempotency key. Resolution is unavailable through MCP and the tunnel.
- A paused inbox keeps messages queued until it is resumed, and refuses new sends.

## Idempotency and safe retries

1. Generate one unique key per intended send, for example a UUID. Keep it for the life of that intent.
2. If the call returns ids, you are done. The message is `queued`.
3. If you get a network error, timeout, or `service_unavailable`, retry with the same key and the same payload. If a message was already created you get the original ids back and nothing is sent twice.
4. Never retry with a new key until you have checked the thread or `list_messages` and confirmed no message exists.
5. On `send_unknown`, do not resend. Inform your human; it may already have been delivered. On `failed`, inspect `send_reason` and ask before a new send. Only an explicitly requested resend uses a new key.
6. `idempotency_conflict` means the key was used for a different request. Do not alter the payload to fit. Use a new key only if the new request is intentional.

A different payload includes a changed recipient order. Array order matters; object key order does not.

## Drafts and scheduled sending

Drafts hold unfinished or deferred mail.

- Create with `create_draft` or `POST .../drafts`. Drafts can be incomplete. Limits are checked when they are sent.
- Edit with `update_draft` (`null` clears a field; `[]` clears recipients). Attachments are added with `addAttachments` and removed by id with `removeAttachments`.
- `send_draft` queues the message now and deletes the draft in one step. It overrides any future `sendAt`. Pass an `idempotencyKey`.
- To reply or forward from a draft, set `inReplyTo` or `forwardOf` to a message id you can read.
- `sendAt` (RFC 3339) schedules the draft. It requires `draft_send` plus a send policy that is not `read_only`. `sendAt: null` or deleting the draft cancels the schedule.
- `send_status` on a draft: `scheduled`, `sending`, or `failed`. A failed draft stays for editing, an explicit send, or an owner retry. A `sending` draft cannot be edited or deleted.
- Schedules fire only while the Inbot service is running, so they can be late. A message's timestamp shows the actual queue time. `sendAt` is not a delivery promise.
- Draft ids are not message ids. The message gets its own id when it is queued.

## Approval policy flow

If your key has `send_policy: "approval"`, every send, reply, reply-all, forward, and draft send is held for the owner.

What you see:

1. The call fails with 403 `approval_required` (MCP: `isError: true`). `message` and `fix` both name the draft id, for example `Draft <id> requires owner approval before sending.` No `message_id` exists yet.
2. A pending draft was created for the owner (`approval_state: "pending"`, `pending_approval: true`). Replaying the same request with the same idempotency key returns the same error and the same draft. It does not create more drafts. A changed payload with the same key is `idempotency_conflict`.

What to do:

- Tell your human plainly that the message is waiting for their approval, name the inbox and the draft id, and summarize recipients and subject.
- Do not retry in a loop, rephrase, split the message, or switch tools to bypass it.
- You can check progress with `get_draft` or `list_drafts`. An approved draft with a future `sendAt` stays with `send_status: "scheduled"`. An immediately approved draft is converted into a queued message, so look for it in the inbox before ever considering a resend.
- If the owner rejected it, `approval_state` is `rejected` with `rejection_reason` when given. It cannot be sent. Create a new draft only if your human asks.
- Editing an approved draft requires a new approval.
- Only the owner approves or rejects, through owner-only REST routes that an agent key cannot use. Neither exists as an MCP tool.

If the key is `read_only`, sends fail with 403 `missing_permission` and nothing is created. Ask your human to change the key if sending is needed.
