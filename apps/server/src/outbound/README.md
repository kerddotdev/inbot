# Outbound mail

The outbound service composes contract request schemas, persists mail and an
outbox in the encrypted Store, sends through an injected Effect provider, and
applies delivery events. REST send/reply/reply-all/forward handlers and the MCP
send tools now enqueue through the same authorized operations. `serve` runs a
scoped adaptive outbox loop with the configured Cloudflare provider. Tests use
fake providers and fake fetch only; no real delivery was tested or dependency added.

## Service API

`Outbox.Live` requires `Store` and `OutboundProvider`. `OutboundProvider.live`
accepts `account_id`, `api_token`, optional injected `fetch`, and `timeout_ms`
(default 30 seconds, maximum 60 seconds). Configuration and responses are never
logged. `OutboundProvider.fake(send)` supplies an Effect send function for tests.

`enqueue(inbox_id, request, idempotency_key?)` returns the contract's
`{ message_id, thread_id }`. The internal request wrapper is `OutboundRequest`
from `packages/contracts/src/outbound.ts`:

```ts
{ kind: "send", request: SendMessageRequest }
{ kind: "reply", message_id, request: ReplyToMessageRequest }
{ kind: "reply-all", message_id, request: ReplyAllMessageRequest }
{ kind: "forward", message_id, request: ForwardMessageRequest }
```

These wrappers are service inputs, not new REST wire formats. Parents are read
only from the specified inbox. `AgentOperations` enforces grants, inbox scope, `message_send` for send/forward
or `message_reply` for replies, parent `message_read`, hidden labels, and send
policies before enqueueing. Owners use direct sending. `read_only` returns
`missing_permission`; `approval` returns `approval_required` with fix `Drafts and
owner approval arrive in a later release`. Both are HTTP 403 and create nothing.
Approval will create pending drafts once drafts and owner approval are implemented.
Without configured transport, adapters return 503 `service_unavailable` with fix
`Configure the Cloudflare mail transport`, without enqueueing.

`get(inbox_id, message_id)` returns the typed `OutboxEntry`, including state,
attempts, scheduling, provider id, and `last_error_code`. `processDue()` recovers
expired leases and claims up to 100 due entries, individually and transactionally.
Paused inboxes remain queued until resumed. `start(interval_ms = 1000)` returns
a scoped, interruptible Effect fiber. An idle iteration performs indexed queries
without loading bodies or calling the provider. Storage failures end the fiber;
its owner must observe it, rather than silently continuing a broken store.
The server instead uses `startOutboxLoop()`: 2 seconds after processing work,
30 seconds while idle or unconfigured. No provider call occurs without due mail.
The server scope interrupts it on shutdown, and `serve` observes its failures.
Configuration is reread each iteration and before each provider dispatch; clearing
it suspends processing. A clear during an active batch leaves unaccepted attempts
retryable. It cannot recall mail already handed to the provider.

## Composition and size

Send and forward create new local threads. Replies use the parent's Reply-To
or From. Reply-all adds original To/Cc, excludes the inbox address and duplicates
case-insensitively, and never inherits BCC. Overrides on `ReplyToMessageRequest`
win per field, including empty arrays; use `reply_all: true` there when overrides
are needed. The separate reply-all contract has no recipient overrides. Reply
subjects preserve an existing case-insensitive `Re:`; forwards use `Fwd:`.

Reply bodies contain only caller text/HTML. No quoted history is appended; extraction of incoming quotes is a
separate capability. Forward bodies include an original-message section and
original attachments. BCC is omitted from the forwarded summary and local MIME.

Base64 content must be canonical. Missing filename/type receive `attachment`
and `application/octet-stream`. Inline attachments require a content id; angle
brackets from inbound MIME are normalized. URL attachments fail with
`not_supported`: fetching arbitrary URLs would expose the host to SSRF. Revisiting
this needs an explicit fetching policy and network isolation. Multiple outbound
Reply-To addresses are rejected because the REST schema accepts only one.

Validation precedes persistence and sending: 50 combined recipients, 32
attachments, and 5 MiB including encoding/framing. The conservative size bound
is the larger of the locally rendered MIME and provider JSON. It includes
base64 expansion, line wrapping, metadata, and bodies, and can reject a message
that Cloudflare's own MIME encoder might fit. Subject and address/header line
breaks are rejected. The local MIME is a composed snapshot with the local id,
not a capture of Cloudflare's final wire message.

The small custom header allowlist is `X-*`, `In-Reply-To`, `References`, and
`Auto-Submitted`. The standard headers serve threading and transactional agent
identification; speculative list, notification, and marketing headers are
excluded. Headers are case-insensitive, cannot repeat under different casing,
and respect 100-byte names, 2,048-byte values, 16 KiB combined payload, and at
most 20 non-X fields. Replies replace caller threading headers. Send/forward reject threading headers
to preserve their new-thread semantics. References
retain the newest suffix plus the parent id within both value and total limits.
The [Cloudflare header reference](https://developers.cloudflare.com/email-service/reference/headers/)
forbids platform-generated `Message-ID` and dedicated-field headers.

## State, labels, identity, and recovery

Enqueue inserts the mailbox message and outbox row in one immediate transaction,
using the existing mailbox domain function. Direction is `sent` to distinguish
outgoing from received mail, but acceptance is represented by the outbox state
and labels, not the direction timestamp. Initially only `queued` is added.
Caller-supplied managed delivery labels are withheld. Acceptance atomically
swaps `queued` for `sent`, stores the provider id, and inserts its alias. A final
failure swaps `queued` for `failed`. Custom labels survive these transitions.
`sent` means provider acceptance, not recipient delivery.

Local ids are stable `<uuid@inbot.local>` RFC identifiers and remain the ids
returned to clients. They are never supplied to Cloudflare as Message-ID.
The provider's returned RFC id is stored as an inbox-scoped mailbox alias, so
inbound In-Reply-To/References resolve to the existing thread. Replies to accepted
outgoing parents use the provider id in headers; replies to outgoing parents
without a provider id are rejected until acceptance. Forwarding does not need
an accepted parent's wire id. An alias collision is quarantined as
`unknown_outcome`, preserving the provider id without shadowing another message.

Known retryable rejections use exponential backoff from 1 second, capped at
1 hour, with at most 8 attempts. Retry-After can extend the delay beyond the cap.
Validation/header rejection, unverified sender, and authentication failures are
permanent. HTTP 429/quota and 5xx failures are retryable. Network errors and
timeouts carry a retryable provider classification but an unknown-outcome flag;
the outbox deliberately does not retry them because acceptance may already have
happened. A success response without a valid RFC id is also uncertain.

An interrupted/crashed send stays `sending`. Once its 5-minute lease expires,
`processDue()` marks it `failed` with `last_error_code = "unknown_outcome"`, without
resending. No provider reconciliation API is implemented here. The owner must
reconcile externally before explicitly creating another send. A crash after
acceptance but before the final database transaction follows this same rule.

Delivery event labels are historical observations, not exclusive per-recipient
states: a multi-recipient message can have both `delivered` and `bounced`, and
`deferred` can coexist with later terminal labels. Delivery failure does not
rewrite provider acceptance in the outbox. Events are deduplicated by event id
per inbox and stored without subject or provider diagnostic text. Unknown ids
are ignored and return `false`; a future Queue consumer must retain/reconcile
unmatched events if they arrive before acceptance is persisted. Queue pulling,
webhooks, and WebSocket emission are outside this implementation.

## Idempotency

The fingerprint is SHA-256 over schema-decoded canonical JSON with recursively
sorted object keys. Array order is preserved; operation kind and parent id are
included. Same key and fingerprint replay original ids without recomposing or
sending, even after restart. A different payload/operation yields
`idempotency_conflict` (HTTP 409 in the existing contract mapping). Keys use the
contract's 1-256 character rules and are scoped per inbox.

Queued/sending entries retain keys through arbitrarily long outages. Keys on
terminal entries expire 24 hours after completion. Expiry clears the old key but retains its outbox
history. A separate content-free replay ledger survives message deletion, so
purging a sent message cannot make its key send again within the window. A deleted
pending message retains its replay guard until the inbox is deleted, because no
completion was observed. Inbox deletion removes the ledger as well. A reused key then creates a new message. Deletes cascade with mailbox
messages/inboxes; deleting pending mail prevents a later claim, but cannot undo
an already-running or accepted external send.

## Cloudflare REST and event shapes

The adapter uses authenticated `POST
https://api.cloudflare.com/client/v4/accounts/{account_id}/email/sending/send`.
Plain addresses are strings; named addresses are `{ address, name }`. Recipient
fields accept arrays; empty optional fields are omitted. REST uses `reply_to`
(single address), and attachments use `content`, `filename`, `type`, `disposition`,
and `content_id` for inline parts. A successful envelope is
`{ success: true, result: { message_id, delivered, permanent_bounces, queued,
suppressed_recipients } }`; only acceptance identity is consumed here.
Sources: [REST guide](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/),
[detailed API reference](https://developers.cloudflare.com/api/resources/email_sending/methods/send/),
[recipient examples](https://developers.cloudflare.com/email-service/examples/email-sending/recipients/),
and [official SDK request types](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/email-sending/email-sending.ts).

The REST guide's response example omits `message_id`, while the detailed API
reference and official SDK include it. The Workers binding's `messageId`,
`replyTo`, and `contentId` are not REST field names. Numeric REST error codes
are decoded; documented Workers-style sender/header/quota identifiers are also
recognized defensively, without retaining provider error text.

`parseDeliveryEvent(unknown)` decodes a Queue message body with
`type: "cf.email.sending.message.<status>"`, `source.type: "email.sending"`,
`payload: { eventId, messageId, recipient }`, and
`metadata: { eventSchemaVersion: 1, eventTimestamp }`. It returns the shared
`DeliveryEvent` schema for `applyDeliveryEvent`. The six accepted statuses are
delivered, bounced, complained, failed, rejected, and deferred. Extra fields
are discarded. This parses the body, not the Queue HTTP-pull response wrapper.
Source: [event subscriptions](https://developers.cloudflare.com/email-service/platform/event-subscriptions/).

## Migration and integration boundary

The contiguous migration list uses **4** for the durable outbox and **5** for the
singleton Cloudflare transport settings. `TransportConfig.Live` depends on Store
and exposes only `get()`, `set({ account_id, api_token })`, and `clear()`. Settings
and the token reside inside the encrypted database, including its encrypted WAL.
Reads wrap the token in `Redacted`; no token is logged. There is no transport HTTP
route, MCP tool, or owner UI yet. A later provisioning unit will add owner setup.
`ConfiguredProvider` reads those settings to select the existing live Cloudflare
adapter. Test servers inject a fake provider instead.

The existing schemas, service, REST, MCP, permissions, idempotency, reverse states,
and documentation apply. Delivery events still apply through the existing internal
service; Queue pulling, event publishing, CLI resource commands, the web UI, and
tunnel allowlists remain planned. `skills/inbot` does not exist, so no guidance for
nonexistent commands was added. No real home or cloud resource was accessed.

## Questions requiring an authorized real-account check

- Does REST `result.message_id` exactly match the wire Message-ID, and does
  event `payload.messageId` use that same id? Event examples show opaque ids
  while the REST reference shows angle-bracket RFC ids. Unknown ids are not
  guessed or normalized into fabricated aliases.
- Which numeric REST error identifies a sender that is not onboarded? The REST
  table does not map this explicitly; string identifiers come from the Workers
  documentation. `10203` is sending-disabled, not proof of an unverified domain.
- Does Cloudflare measure 5 MiB exactly as the generated MIME, and can optional
  empty recipient fields be rejected? The adapter avoids them and uses a
  conservative size estimate. The requested 32-attachment cap is retained.
- How are recipient-grouped immediate bounce/suppression results correlated
  with subsequent events? They are not treated as delivery confirmation here.
- Is sent-message preview disabled on the provisioned domain? The research
  notes warn that cloud preview retains plaintext. A future provisioner must
  disable it before this adapter is enabled; no provisioning was performed.

Cloudflare sending is for transactional mail. Outbound content passes through
Cloudflare in plaintext in transit; this is not end-to-end encryption. Local
mail and outbox payloads are encrypted at rest by Store.
