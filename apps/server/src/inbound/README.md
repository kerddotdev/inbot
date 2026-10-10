# Inbound MIME ingestion

`ingestInbound(payload, { trusted_authserv_ids? })` is an Effect requiring
`Mailbox`. It consumes a decrypted SMTP envelope and raw RFC 5322 bytes. It does
not itself decrypt envelopes, pull buffers, acknowledge deliveries, send
bounces or expose routes. Mailbox insertion records the received event atomically. `puller.ts` supplies the Cloudflare
buffer consumer and calls this same ingestion service. No Mailbox API changes are required.

## Payload and results

`InboundPayload` in `payload.ts` is an Effect Schema for `mail_from`, `rcpt_to`,
and RFC 3339 `received_at`. Decode that metadata separately, then supply `raw`
as a `Uint8Array`; raw bytes are not part of the serialized envelope schema.
`InboundInput` combines the decoded metadata with those raw bytes.

The result is an array in SMTP recipient order. Addresses are lowercased:

- `{ recipient, status: "stored", message_id, thread_id }`
- `{ recipient, status: "skipped_paused" }`
- `{ recipient, status: "skipped_unknown" }`

Only existing active inboxes receive mail. Header recipients are stored as
written, independently of SMTP delivery recipients. Missing From addresses
fall back to `mail_from`; missing To headers stay empty. Paused recipients are
skipped without storing or bouncing, and unknown recipients never create
inboxes. A skipped paused recipient can receive a later replay after resuming.

Each insert uses the existing Mailbox transaction and `(inbox_id, message_id)`
idempotency. Copies in different inboxes have separate threads and attachment
identities. If ingestion stops between recipients, replaying the payload keeps
already committed copies unchanged and completes remaining active recipients.

Raw payloads larger than 25 MiB fail before MIME parsing with
`InboundError.code = "payload_too_large"`. Invalid metadata, MIME parser limits,
and extraction failures have typed errors with fixed messages and actionable
fixes. Neither this module nor its extraction path logs content or addresses.

## Parsing

`postal-mime@4.0.5` is pinned in the root package manifest. Addresses use
`Display Name <user@domain>` or `user@domain`; address groups are flattened.
Bodies, decoded subjects, reply-to addresses, MIME attachment bytes, disposition,
and content ids are retained. Nested `message/rfc822` parts stay attachments,
so forwarded headers cannot supply the outer message's authentication results.

Message identifiers and references use angle brackets. References are
deduplicated in order. An absent or unusable Message-ID becomes
`<sha256hex@inbot.invalid>`, computed from the exact raw bytes independently of
receipt time. A parseable Date becomes a UTC ISO timestamp; an absent or
unparseable Date uses `received_at`.

Selected headers are `message-id`, `in-reply-to`, `references`, `date`, `list-id`,
`list-unsubscribe`, `auto-submitted`, and `authentication-results`. Keys are
lowercase, values retain the parser's RFC unfolding, and duplicate values are
joined with a newline to fit the string-valued contract map. Authentication
uses a separate ordered array rather than that joined map. PostalMime's default
nesting, header-size, and part-count limits remain enabled.

## Reply extraction

The npm package `agentextract@0.3.0` exists, is MIT licensed, and was verified
under Node 24 ESM. Inbot uses its `agentextract/body` exports for quote cutting
and boilerplate stripping. The individual stages avoid the package's logging
entry point and do not invoke attachment document parsers.

The adapter adds the Hungarian single-line `napon ... ezt irta:` attribution
(including its accented form), while retaining the package's signature rescue.
It also removes a trailing standalone `>` quote line, which this release otherwise
keeps. English, German, French, Spanish, Outlook header blocks and dividers,
Gmail HTML quote containers, blockquotes, and mobile footers are covered by tests.
Personal signatures above history and recognizable signatures after it are kept.

Extraction is heuristic, not a MIME transformation or HTML sanitizer. Original
bodies and raw bytes remain available. Unrecognized attribution styles can keep
history, and ordinary prose resembling a quote or boilerplate marker can be cut.
The package may keep interleaved replies, forwarded content, and delivery-status
notifications whole. The Hungarian adapter recognizes single-line text and
contiguous HTML text, not attributions split across lines or HTML tags. Signatures
after history require the package's recognizable signature markers. Extracted
HTML can be a fragment and must be treated as untrusted content by consumers.

## Authentication trust

Any `spf`, `dkim`, or `dmarc` result equal to `pass` on a trusted header is enough;
all other cases, including no header, add `unauthenticated` to `received` and
`unread`. This interprets receiver results, rather than performing SPF, DKIM,
or DMARC verification. Comments and quoted reasons cannot introduce a passing
result, and malformed headers fail closed.

With the default empty `trusted_authserv_ids`, only the topmost
Authentication-Results header is trusted. This assumes the receiving service
prepends its own header. A later untrusted `pass` cannot override a failing top
header. With a configured list, only exact, case-insensitive authserv-id matches
are considered; the topmost header is not implicitly trusted in that mode.

An authserv-id is not a cryptographic credential. The receiving transport must
strip sender-supplied headers claiming its own trusted ids and prepend its
observed results. This module cannot distinguish a forged header with the same
id after that trust boundary has been lost. Cloudflare SMTP DMARC rejection is
outside this unit; ingestion only labels and never rejects based on these results.

## Cloudflare buffer consumer

Migration **6** adds encrypted inbound settings, an age identity, object receipts,
and quarantine metadata. `InboundConfig.set({ account_id, bucket,
inbound_queue_id, events_queue_id })` creates an identity if needed.
`generateInboundIdentity()` can run before setup; `getRecipient()` derives the
public recipient. Identity reads are `Redacted`; `clear()` disables pulling while
preserving the identity and existing receipts. V1 reuses the `TransportConfig`
API token and requires matching account ids. Owner setup routes and UI are planned.

`InboundBuffer` provides `pull`, `ack`, `retry`, `getObject`, `deleteObject`, and
`listObjects`, with a bounded, timeout-protected fetch adapter and a clock-driven
`memoryBuffer()` fake. Both queues require `http_pull` consumers. JSON bodies
support the plain JSON string seen in captured responses and documented base64.

`processInbound()` decodes the shared pointer, checks ciphertext size, decrypts,
parses the frame, and calls `ingestInbound` with trusted authserv ids
`["mx.cloudflare.net"]`. Every active recipient insert commits before a durable
`committed` receipt, R2 deletion, and Queue ack, in that order. Replay before the
receipt re-ingests idempotently; replay after deletion uses the receipt without
requiring the object. Receipts are scoped by account/bucket/key and are retained
to handle duplicate pointers; pruning is not implemented.

Transient failures retry leases with exponential backoff capped at one hour;
failed retry requests leave leases to expire. Corrupt or wrong-key ciphertext,
invalid frames/MIME, and size mismatches first record `key`, fixed `reason_code`,
and `first_seen` in the encrypted DB, then ack while retaining R2 ciphertext.
Malformed pointers also retain only queue/message ids and any valid referenced
key. `bufferState(...).listQuarantine()` and `listMessageQuarantine()` supply owner
metadata; `releaseQuarantine(key)` enables deliberate reconciliation without
deleting ciphertext. Quarantine never stores payloads, credentials, or error text.

`reconcileInbound()` paginates objects under `inbound/`, processing those at least
ten minutes old while skipping quarantined keys and known unexpired pending
leases. Queue APIs cannot enumerate all pending pointers; eventual unseen-pointer
replays are safe through receipts. Orphans use R2 `last_modified` as receipt time.
`serve` runs scoped inbound/events consumers beside the outbox: two-second polling
after completed work, thirty seconds when idle, reconciliation at startup and
every fifteen minutes. Inbound pulling runs first to observe pending leases.
Missing unlocked services report `locked`; missing config/token reports
`no_config`, with no provider calls. Unhandled DB failures stop the runtime.
Dynamic HTTP locking is not implemented; serve interrupts consumers before Store
closes. Tests use temporary encrypted stores, real age, fake fetch/buffers, and
controlled clocks, without real provider calls.

REST paths relative to `https://api.cloudflare.com/client/v4`:

- `POST /accounts/{account_id}/queues/{queue_id}/messages/pull` with
  `{batch_size: 5, visibility_timeout_ms: 300000}`.
- `POST /accounts/{account_id}/queues/{queue_id}/messages/ack` with
  `{acks: [{lease_id}], retries: []}`, or retries with `delay_seconds`.
  Returned ack/retry counts must confirm the operation.
- `GET /accounts/{account_id}/r2/buckets/{bucket}/objects/{key}`.
- `GET /accounts/{account_id}/r2/buckets/{bucket}/objects?prefix=inbound%2F&per_page=1000&cursor=...`,
  following `result_info.cursor` while `is_truncated` is true.
- `DELETE /accounts/{account_id}/r2/buckets/{bucket}/objects/{key}` after commit.

Object key slashes stay literal; other reserved characters are encoded. The
REST object API is sufficient for this local consumer, with rate limits and no
extra S3 credentials. Sources: [pull consumers](https://developers.cloudflare.com/queues/configuration/pull-consumers/),
[pull](https://developers.cloudflare.com/api/resources/queues/subresources/messages/methods/pull/),
[ack](https://developers.cloudflare.com/api/resources/queues/subresources/messages/methods/ack/),
[R2 get](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/get/),
[R2 list](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/list/),
[R2 delete](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/delete/).

Service, delivery events, reverse states, and docs apply. Existing contracts and
mailbox semantics are reused; REST, MCP, CLI, web, grants, and remote allowlists
have no new public surface. Agent guidance lives in `skills/inbot`.

## Receive lists

Ingestion evaluates global and inbox `receive` lists against both From and the non-empty envelope sender. Blocked recipients return `skipped_blocked`, with a durable `blocked_sender` or `sender_not_allowed` trace in the encrypted Store. Allowed recipients are still ingested independently. The buffer receipt records `message_rejected` before deleting ciphertext; storage failure retains it for retry. See [list policy](../lists/README.md).
