# Allow and block lists

Lists contain exact email addresses or domain names for `receive`, `send`, and
`reply`. They are persisted in the encrypted Store by migration 10. CRUD uses the
existing contract schemas and error codes; there is no update endpoint. Delete
and recreate an entry to change its reason.

## Policy

- Global and inbox entries form a union for each direction. Inbox entries add
  rules; they never override a global block.
- A matching block always wins, including over a more specific address allow.
- If any allow entries exist in that union, every evaluated address must match
  an allow entry. With no allow entries, addresses pass unless blocked.
- Domains are trimmed, converted to ASCII IDNA, and lowercased. Matching is exact:
  `example.test` does not match `sub.example.test`.
- Email entries contain one unquoted mailbox without a display name. The domain
  and local part are lowercased, so matching is case-insensitive and a block cannot
  be bypassed by changing letter case. Wildcards,
  URLs, and multiple addresses are invalid. Mail display names do not affect
  policy matching. Reasons are optional and limited to 2048 characters.
- Receive evaluates both the MIME From address and the SMTP envelope sender when
  present. Every present sender must pass. An empty SMTP reverse path is ignored;
  From falls back to the envelope sender. These lists do not authenticate a sender;
  the existing authentication labels remain independent.
- Send evaluates every To, CC, and BCC recipient after reply/forward composition.
  Reply and reply-all must pass both `send` and `reply`. Reply drafts retain that
  distinction when sent, approved, or scheduled. Forward uses `send`.

For example, a global `receive/allow` domain and an inbox `receive/allow` address
both permit matches, but a block in either scope rejects them. Removing the last
allow entry from both scopes lifts the allow restriction. Removing a block does
not bypass a remaining allow restriction.

## Durable decisions

Blocked inbound recipients return `skipped_blocked` with `blocked_sender` or
`sender_not_allowed`. Before returning, ingestion records the inbox, SHA-256 of
the raw payload, reason, received timestamp, rejected sender address, and rule
snapshot in `inbound_list_rejections` (migration 14). Block decisions retain the
matching rule; allow denials retain the applicable allow rules.
It stores no message body in that trace and creates no visible mailbox message.
Other recipients are evaluated independently and can still receive the message.
Repeated ingestion of the same rejected payload retains its original decision,
even after a policy edit. A fresh payload is evaluated against the current rules.
Deleting the inbox deletes its entries and rejection traces.

The buffer consumer records `committed` with `message_rejected` when any recipient
was blocked, then deletes the ciphertext and acknowledges the pointer. If either
durable write fails, ciphertext remains and the pointer is retried. A crash after
commit replays cleanup without changing the decision or duplicating the trace.
Malformed payloads continue to use the existing ciphertext-retaining quarantine.
Policy rejections count as processed skips, not malformed-object quarantines.
The owner can inspect and delete rejection metadata. Deletion removes the record
and retains only an encrypted inbox/hash/reason receipt, so cleanup retries do not
accept previously rejected mail. It does not release or recover a message.
Legacy records preserve their original decision with a null sender and empty rule
snapshot. Subjects were never stored and remain absent; bodies are never exposed.

Outbound sends, approval proposals, draft sends, and approvals fail with 403
`message_rejected` and an actionable fix before queuing. Failed draft sends and
approvals leave the draft unchanged. Incomplete draft creation and editing remain
possible. Scheduled drafts recheck policy when due; forbidden ones become failed.
The outbox rechecks queued recipients before invoking the provider, so newly added
rules mark existing queued mail failed/rejected without sending it. Successful
idempotency replays return the original identity and never enqueue another message.
A policy edit cannot recall an already dispatched provider request.

## Surfaces and permissions

- Owner REST: `GET /v0/owner/lists/rejections` accepts `limit`, `page_token`, and
  optional `inbox_id`. It returns `rejections`, `count`, `limit`, and optional
  `next_page_token`, ordered by received time descending with a unique ID tie-breaker.
  Cursors bind to the inbox filter. `DELETE /v0/owner/lists/rejections/:rejection_id`
  removes a record; absent IDs return `not_found`. These routes are owner-only:
  list-entry permissions manage policy and do not grant access to mail metadata.
  No rejection MCP tools are exposed, regardless of agent scope or send policy.
- REST: `GET`/`POST /v0/lists/:direction/:type`, and `GET`/`DELETE` with `/:entry`.
  Inbox paths prefix lists with `/v0/inboxes/:inbox_id`.
- List responses include `count`, `limit`, and optional `next_page_token`. Entries
  sort lexically ascending. Default limit 20, maximum 100; cursors bind to scope,
  direction, and list type. Get and delete normalize the entry identically to create.
  Duplicate creation returns `already_exists`; absent get/delete returns `not_found`.
- Reads need `list_entry_read`, creates `list_entry_create`, deletes
  `list_entry_delete`. Inbox-scoped grants may operate only inside that scope;
  global operations require an unrestricted inbox grant. The owner can do all.
  Send policy does not restrict list management. These permissions deliberately
  permit policy changes; grant them only to agents trusted to manage those rules.
- MCP: `list_list_entries`, `get_list_entry`, `create_list_entry`,
  `delete_list_entry` call the same authorized operations. `inboxId` is optional.
- Owner CLI: `inbot lists rejections [--inbox-id ADDRESS] [--limit N] [--page-token TOKEN]`
  and `inbot lists delete-rejection REJECTION_ID`. JSON and table output are supported.
- CLI: `inbot lists list|create|get|delete <direction> <type>`, optional `--inbox`.
  Create uses `--entry` and optional `--reason`; get/delete take a positional entry.
- Web: Settings > Allow and block lists manages one global or inbox list at a time,
  with pagination, explicit scope/direction/type, and loading, empty, and failure states.
  Its Rejected mail section uses the selected inbox, or all inboxes with Global,
  and supports refresh, pagination, empty/error states, and deletion.
  Existing session/CSRF and locked-screen handling applies.
- Events: the current contract has no list-change event. Receive-list rejections
  create no mailbox message or thread, so they cannot populate the existing
  `message.received.blocked` snapshot or `message.rejected` identity payload.
  No event names or resource identities are invented. Newly blocked queued mail
  emits `message.failed` with reason `message_rejected` in its failure transaction;
  signed webhooks and WebSocket replay deliver it under existing read permissions.
- Remote: the tunnel allowlist blocks both owner rejection routes.
