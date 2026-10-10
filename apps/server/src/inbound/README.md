# Inbound MIME ingestion

`ingestInbound(payload, { trusted_authserv_ids? })` is an Effect requiring
`Mailbox`. It consumes a decrypted SMTP envelope and raw RFC 5322 bytes. It does
not decrypt envelopes, pull Cloudflare buffers, acknowledge deliveries, send
bounces, expose routes, or emit events. No Mailbox API changes are required.

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
