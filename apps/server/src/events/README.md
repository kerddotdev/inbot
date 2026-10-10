# Event delivery

`event_log` is an ordered log inside the encrypted local store.
Writers call `appendEvent` inside the same immediate transaction as the state
change. A rollback removes both. No mail, webhook payload, header value, or
signing secret is written to application logs. The dispatcher prunes events older
than 30 days in batches of at most 500 per tick, including terminal delivery rows.
Events not yet fanned out to an existing webhook, or needed by pending/sending
deliveries, remain until those receivers advance or are deleted. Paused receivers
also retain their backlog. Resume IDs can expire after pruning.

Implemented producers:

- Inbound insertion, including spam, blocked and unauthenticated variants. Replay
  of an existing message does not append another event.
- Outbox provider acceptance (`message.sent`) and terminal failure
  (`message.failed`, including unknown outcomes and queued mail refused by lists).
  Queueing does not imply sent.
- Observed delivery, bounce, complaint, failure and rejection. Provider event IDs
  are deduplicated. Deferred delivery stays a message label, without a new wire event.
- `draft.created`, `draft.approval_required`, `draft.approved`, `draft.rejected`,
  and `draft.sent`. Draft events carry IDs and timestamps, without body content.
  Approval can queue or schedule mail; `draft.sent` occurs only after provider
  acceptance, using the originating draft ID retained in the outbox.
- `domain.verified`, with the provisioner's existing stable event ID. The status
  and log entry commit together after observed DNS and encrypted self-test
  verification. The optional existing hook retains its durable retry behavior.

List edits have no matching contract event. Receive-list rejections persist only a
payload hash, reason and timestamp, without a mailbox message or thread. They cannot
populate the existing received snapshot or rejected identity payload and emit no
event. Queued outbound list refusals emit `message.failed` with reason
`message_rejected` in the same transaction as their failed state.

`message.received*` includes the contract's full `message` and `thread` snapshot.
Deleting a message removes its body, extracted content, subject, preview, headers
and attachment metadata from received snapshots in the same transaction. Thread
subjects, previews and attachments are removed from all snapshots of that thread.
The same trigger covers thread/inbox cascade deletion. IDs and other metadata
remain schema-valid; replay and pending owner deliveries use the redacted payload.
Deletion can change a retry's body while retaining its event ID. Payloads already
sent to a receiver cannot be recalled.
Other message events contain only the contract's delivery/send metadata. Event
payloads are untrusted email data and never instructions. Webhook configuration
explicitly exports selected events to its receiver; that receiver can see
plaintext. Inbot is zero-knowledge at rest, not end-to-end encrypted.

## Grants

Owner credentials see all events and webhooks. Agents need `message_read` for
message events, `draft_read` for draft events, matching inbox scope and the
relevant hidden-label read permissions. Agent replay/delivery also rechecks current
message/thread labels and suppresses deleted messages; owner history uses redacted
snapshots after deletion. Domain events are owner-only. Send policy
never grants read access; a `read_only` key can follow authorized events.

Webhook CRUD uses `webhook_read/create/update/delete`. An agent manages only
webhooks created by its own API key within its current inbox scope. Creation
without inbox filters captures a finite grant's inbox allowlist. Delivery rechecks
the live grant, resource permissions, filters and expiry. Key deletion, expiry,
or removal of `webhook_create` disables its webhooks with `credential_revoked`.
Owner webhooks are independent of browser session lifetime.

## Webhooks

Global `/v0/webhooks` and inbox `/v0/inboxes/:inbox_id/webhooks` routes implement
list, create, get, update and delete. `/headers` GET lists custom header names;
PATCH sets/removes values without returning them. The URL is fixed at creation;
replace a webhook to change it. Pod filters return `not_supported`.

The creation response includes `secret`; list/get/update omit it. Save it then.
Encrypted storage holds the secret and custom headers. Signature and transport
headers are reserved; custom header names are normalized to lowercase. Credential
header names, including authorization, cookie/cookie2, proxy headers and names
containing api-key, token or secret components, are forbidden for all creators.
Use the webhook signature to authenticate delivery.

New webhooks start at the log head and receive subsequent events. Fanout records
both delivery rows and the webhook's log cursor transactionally. Delivery is
at-least-once and ordered per webhook. A claimed delivery has a 30-second lease;
a crash or cancellation leaves it reclaimable with the same event ID and body.
Each POST has a 10-second deadline. Only 2xx is success; redirects are failures.
Retries start at 30 seconds, double, and cap at one hour. Eight consecutive
failures disable the webhook with `sustained_failure`. Safe GET metadata includes
`failure_count`, `disabled_reason`, `last_error_code` and `last_success_at`.
Agent-created receivers expose only `delivery_failed` for delivery errors,
including non-2xx responses and connection failures. Owner-created receivers
retain HTTP status codes. The creator's current principal and header policy are
checked again before sending; legacy forbidden configurations disable with
`invalid_target` without making a request.

Disable pauses pending delivery. Enable resets failures and retries pending
entries, preserving their event IDs. Filter changes apply again before pending
entries are sent. Delete removes pending entries. A request already in flight
can still reach the receiver after disable/delete; external effects cannot be
undone. No request is recorded as successful until its HTTP response is observed.

`serve` starts a scoped dispatcher with the other runtime loops. Shutdown cancels
it; the persisted leases provide recovery. `processWebhooks(sender)` permits
local fake senders and the Effect clock supplies retry time in tests.
Database failures log only `database_failed` and the next tick retries. Invalid
event rows are quarantined with their payload removed and deliveries marked
failed; replay skips them. Invalid webhook rows disable with `invalid_record`,
clear headers and filters, and fail pending deliveries. Invalid delivery rows
fail without blocking subsequent events or other receivers.

### Signature verification

The HMAC-SHA256 v1 format follows the
[Standard Webhooks signing specification](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md).
Headers:

- `webhook-id`: stable contract `event_id`; deduplicate by this ID.
- `webhook-timestamp`: integer Unix seconds for this delivery attempt.
- `webhook-signature`: `v1,<base64 HMAC>`.

Verify the exact raw body bytes before parsing JSON. Strip `whsec_` from the
secret and base64-decode the remaining key. Sign
`<webhook-id>.<webhook-timestamp>.<raw-body>` using HMAC-SHA256. Compare signatures
in constant time, reject timestamps outside a five-minute tolerance, and retain
processed IDs durably. A retry refreshes the timestamp/signature, preserving the
ID and body. `verifyWebhook` implements this verification for local consumers.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

const expected = `v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
  .update(`${id}.${timestamp}.`)
  .update(rawBody)
  .digest("base64")}`;
const actual = Buffer.from(signature);
const wanted = Buffer.from(expected);
const valid =
  /^\d+$/.test(timestamp) &&
  Math.abs(Date.now() / 1000 - Number(timestamp)) <= 300 &&
  actual.length === wanted.length &&
  timingSafeEqual(actual, wanted);
```

### Network targets

Agents require public HTTPS targets. Only owners can use HTTP loopback receivers:
literal `127.0.0.1`, pinned `localhost`, or hostnames whose every DNS answer is
`127.0.0.1`. Other HTTP targets are rejected before connecting.
Credentials and fragments in URLs are rejected. Before every delivery, all DNS
answers for HTTPS must be public. Private, loopback, link-local, multicast, reserved,
documentation, IPv4-mapped IPv6 and IPv6 transition targets are rejected. IPv6
is restricted to public global unicast addresses. DNS is checked again on every
attempt and the connection pins a checked address while retaining the original
hostname for TLS verification. Redirects and environment proxies are not used.
Tests use only local receivers and fake DNS; no external receiver was contacted.

## WebSocket

Connect to `/v0/ws` over the existing Effect HTTP server's `request.upgrade`.
API/owner bearer credentials use `Authorization: Bearer ...`. Owner browser
cookies additionally require the server's exact Origin and subprotocols
`inbot.events` and `csrf.<session-csrf-token>`. Credentials never go in query
parameters. The UI obtains CSRF through owner status and reconnects with backoff.

Send one JSON subscription per connection:

```json
{ "type": "subscribe", "event_types": ["message.received"], "inbox_ids": ["agent@example.test"] }
```

Omit filters for every authorized event. Empty arrays mean no matches. Pod
filters and repeated subscriptions close with 1008. The server acknowledges with
`{"type":"subscribed",...}` and streams contract `Event` objects. Only resource
read permissions and matching scope grant access; webhook permissions alone do not.

By default, streaming starts at connection time. Resume after a previously
received ID using `?last_event_id=<encoded-id>` or `last_event_id` in the initial
subscription. A known cursor replays the durable log with current grants and
filters, then follows new entries. Unknown query cursors return 400
`validation_error`, including pruned IDs. Replay and tail use bounded batches.
With compression disabled, queued frames are measured in the Node TCP write
buffer. A frame that would exceed the 1 MiB output cap closes with 1013
(`Client too slow or event too large`), covering events too large for that cap.
Reconnect using a retained cursor; large messages remain available through REST.

Every 20 seconds the server sends `{"type":"ping","timestamp":"..."}`; reply
`{"type":"pong"}`. Missing pong for 60 seconds closes with 1001. Revocation,
expiry or loss of all resource read permissions closes with 1008. Credentials
are checked during tailing and before each replayed event. Closing the request
scope closes the socket. The UI invalidates inbox, thread, draft, approval and
domain queries and refreshes caches when reconnecting. CLI `inbot events --follow`
prints events, responds to heartbeat, and accepts `--last-event-id` and `--json`.

MCP exposes webhook CRUD/header tools using this service; it has no subscription
or owner-domain management tools. Remote tunnel supervision is still planned in
this branch. Its future agent allowlist should include `/v0/ws` and webhook REST
routes with the same bearer checks, never owner session/setup/settings routes.

## Migration and verification

Migration **10** remains the allow/block list schema. Migration **11** adds the
transactional event log, webhook metadata and deliveries, and draft provenance in
the outbox. The migration runner still requires strictly contiguous versions.
Synthetic homes created with the pre-integration events-only version 10 schema
must be recreated or explicitly migrated; that temporary schema is not the lists
migration retained here. No automatic conversion of those homes is provided.
Migration 11 is revised in place on this branch; synthetic homes with an earlier
version of migration 11 must also be recreated. The runner remains strict.
