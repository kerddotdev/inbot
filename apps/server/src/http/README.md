# Loopback HTTP API

Build with Node 24.21.0 and run against an explicit home:

```sh
pnpm build
pnpm start:server --home /path/to/explicit/inbot-home --port 0 --init
```

`serve` defaults to development flavor. Port 0 chooses an available loopback
port; `--port` accepts 0 through 65535. The service listens only on `127.0.0.1`.
`--init` initializes a new home with a random DEK wrapped by an OS-keychain KEK;
existing homes unlock with the keychain. Passphrase startup, password/cookie web
sessions, and the full CLI remain later work. SIGINT and SIGTERM close HTTP and
the encrypted Store. Files, keys, and `connection.json` remain in the home.

On each successful start, the service replaces `<home>/connection.json`
atomically with mode 0600. Its shape is `{ "url": "http://127.0.0.1:<port>",
"token": "<owner-bearer-token>" }`. Local clients read that file and send
`Authorization: Bearer <token>`. Only the token's SHA-256 remains in the owner
authentication service. The service prints one JSON `server.ready` line
containing the URL, never the token. Restart rotates the owner token.

Tests use temporary homes and the in-memory keychain. The process smoke test
sets `INBOT_TEST_MEMORY_KEYCHAIN=1`; this switch requires an explicit `--home`,
refuses the default homes, and refuses production flavor. Its keys disappear at
process exit, so that test home cannot be reopened through a real keychain.

## Implemented routes

All declared `InbotApi` endpoints are registered with Effect v4
`HttpApiBuilder.group` and `HttpApiBuilder.layer`. The server uses
`HttpRouter.toHttpEffect`, `NodeHttpServer.make`, and
`NodeHttpServer.layerHttpServices`; resources stay in Mailbox and ApiKeys service
methods. The exact `@effect/platform-node` dependency and its shared adapter
override are 4.0.2, matching the installed Effect version.

- Inboxes: list, search, create, get, update, delete.
- Threads: inbox and organization list, search, get, update, delete, attachment.
- Messages: list, search, get, update, delete, batch-get, batch-update, raw,
  attachment, send, reply, reply-all, forward.
- Drafts: inbox CRUD, send, attachment; organization list, get, attachment;
  owner-only approve and reject.
- API keys: owner-only organization CRUD and inbox-scoped create, list, update,
  delete. The contract has no inbox-scoped key-get route.

Send endpoints return `{ message_id, thread_id }` after the outbox transaction
commits, with the message initially `queued`. The `idempotency-key` header is
passed to the durable inbox-scoped replay ledger. Provider acceptance later
changes the label to `sent`; it does not prove delivery. No configured transport
returns 503 `service_unavailable` with fix `Configure the Cloudflare mail transport`
and does not enqueue. Transport settings have only an internal service for now.

Lists, webhooks, and domains return HTTP 501 `not_supported` after
authentication and authorization. Validated input is still required. Provisioning,
tunnels, the web UI, OAuth, and event streams remain planned. The same server
exposes authenticated streamable HTTP MCP at `/mcp`; see
[the MCP reference](../mcp/README.md).

Raw and attachment endpoints return the declared metadata and a signed
five-minute URL under `/v0/downloads/:token`. Downloads still require a bearer
token and recheck its current permissions, inbox scope, and hidden labels. They
read encrypted storage at download time and send binary content as an attachment
with `nosniff` and `no-store`. No plaintext download cache is written. URLs
expire on restart as well as at their advertised expiry time.

## Authentication and authorization

Owners bypass agent grants; only owners can administer keys and domains.
Agent keys use `inbot_<32-hex-character-id>_<32-byte-base64url-secret>`. Migration
3 stores only the full token's SHA-256, display prefix, metadata, and validated
grant in the encrypted database. Create returns plaintext once; get, list, and
update never return it. Delete removes the row and revokes immediately.
Authentication reads current grants on every request, rejects expired keys,
compares hashes in constant time, and updates `used_at` at most once per minute.
Key scope and expiry are immutable; name, permission flags, and send policy can
be updated. Unknown payload fields and permission flags fail validation.

`BearerAuth` provides `CurrentPrincipal`. It enforces each endpoint's
`RequiredPermission` annotation and the fixed inbox scope. Mailbox scope is
checked before permissions to conceal out-of-scope resources. Both `inbox_id`
and `inbox_ids` intersect when present; missing scope allows all inboxes and
an empty array allows none. Out-of-scope routes return the same 404 as absent
resources. Organization listings and searches apply scope in SQL before
pagination, and continuation tokens bind that scope. Organization thread ids
resolve through a scoped Mailbox lookup.

Agents can create inboxes with `inbox_create`. Creation must also fit the
existing fixed scope; it never widens the grant. Outside-scope creation and
`client_id` replay roll back without returning a resource.

For each hidden label (`spam`, `blocked`, `unauthenticated`, `trash`), the
corresponding `label_*_read` permission is required. Without it, the respective
`include_*` flag is treated as false, direct resources return 404, and batch-get
omits hidden messages. Thread checks cover the union of member labels.
Search retains Mailbox's existing behavior of excluding all hidden labels.
Sending requires `message_send` for send/forward or `message_reply` for replies.
Parent-based operations also require `message_read` and a visible parent. Owners
always send directly. Agent `read_only` grants fail with 403 `missing_permission`;
`approval` grants create a pending draft and return 403 `approval_required`.
The error keeps the `{ name, code, message, fix }` shape: both `message`
and `fix` identify the created `draft_id`. There is no extra error field or 202
success response because send clients expect real `{ message_id, thread_id }`
identities, which do not exist before approval. This applies to send, reply,
reply-all, forward, and draft send. Replaying a proposed message with the same
`Idempotency-Key` returns the same draft error without creating another draft;
a changed payload returns `idempotency_conflict`. A proposal replay retains its
original draft identity even after approval or deletion.

## Drafts and owner decisions

Migration 7 stores draft content, base64 attachments, creator identity, approval
state, schedules, and replay ledgers inside the encrypted Store. Version 6 is
reserved for integration with concurrent work; migrations accept strictly
increasing versions. No new dependency is needed. Drafts may be incomplete;
composition limits are validated again when they are sent or approved.

- `GET|POST /v0/inboxes/{inbox_id}/drafts`
- `GET|PATCH|DELETE /v0/inboxes/{inbox_id}/drafts/{draft_id}`
- `POST /v0/inboxes/{inbox_id}/drafts/{draft_id}/send`
- `GET /v0/inboxes/{inbox_id}/drafts/{draft_id}/attachments/{attachment_id}`
- `GET /v0/drafts`, `GET /v0/drafts/{draft_id}` and
  `GET /v0/drafts/{draft_id}/attachments/{attachment_id}`
- Owner extension: `POST /v0/inboxes/{inbox_id}/drafts/{draft_id}/approve`
- Owner extension: `POST /v0/inboxes/{inbox_id}/drafts/{draft_id}/reject`
  with `{ "reason": "Optional explanation" }` or `{}`.

Draft operations require their respective `draft_read`, `draft_create`,
`draft_update`, `draft_send`, or `draft_delete` permission and the inbox scope.
Organization lookups and page tokens retain scope and hidden-label filtering.
Reply/forward creation also requires `message_read` and a visible source.
`client_id` is idempotent within an inbox while its draft exists. Null clears an
editable field; recipient arrays also accept `[]`. Attachment metadata has
stable ids until removed, and downloads recheck `draft_read` at access time.

A direct `send_draft` explicitly sends now, overriding a future schedule. It
returns `{ message_id, thread_id }` after atomically inserting the queued message
and deleting the draft. The draft send's `Idempotency-Key` replays after deletion;
changing draft identity or label updates conflicts. Provider acceptance and
later delivery remain separate from queueing. The owner approval endpoint
validates current transport and composition before making any durable decision.
An immediate approval returns the queued message ids; a future approval returns
the approved draft with `send_status: "scheduled"`. Failed approval keeps the
draft pending and returns the actionable composition or transport error.

Only owners can approve or reject. An agent cannot escape approval by editing a
previously approved draft: edits require another review. Rejected drafts retain
`approval_state: "rejected"` and cannot be sent or approved; create a new draft
for reconsideration. Rejection cancels scheduling. Approve/reject are absent from
MCP, and agents cannot supply approval fields in draft payloads.

## Scheduled sending

Creating or updating a draft with `send_at` schedules it and additionally
requires `draft_send` and a non-read-only send policy. Approval-policy schedules
remain pending until an owner approves them. The scheduler claims only due
approved/direct drafts and transitions `scheduled -> sending`, then atomically
converts the draft into a queued message and deletes it. Composition or transport
failure leaves a `failed` draft for editing, explicit send, or owner retry.
Deleting the draft or setting `send_at: null` cancels the schedule. Already
`sending` drafts cannot be edited, deleted, or rejected.

Schedules fire only while the service runs. The scheduler polls every 30 seconds
when idle and every 2 seconds after work. After an outage it processes overdue
drafts and recovers persisted `sending` drafts before retrying. Message timestamps
reflect the actual queue time, including lateness; `send_at` is not a delivery
promise. Outbox retries, provider acceptance, and delivery can introduce further
delay. Both background fibers are scoped to the HTTP service and observed by
`serve`; storage failures stop the service. Integration tests can disable the
loops and drive the clock and fake provider explicitly.

REST and MCP use `AgentOperations`, the shared authorization helpers, and the
same Mailbox/Outbox methods. The middleware checks contract permission annotations
through that same authorization function. Scope remains checked before permissions.

Browser requests with an `Origin` different from the server's exact origin,
including `null`, return 403. Requests without `Origin` and same-origin requests
are allowed; both still need authentication. Responses use `no-store`.

## Errors

Errors use `{ name, code, message, fix }`, with no Effect `_tag`, and the status
from the contracts' `ErrorStatus` mapping:

| Failure                                                             | Code                   | HTTP status |
| ------------------------------------------------------------------- | ---------------------- | ----------- |
| Request schema, JSON syntax, or content type                        | `validation_error`     | 400         |
| Missing, invalid, expired, or deleted bearer key                    | `unauthorized`         | 401         |
| Missing endpoint permission, owner-only route, or foreign Origin    | `missing_permission`   | 403         |
| Missing resource, excluded scope/label, or invalid/expired download | `not_found`            | 404         |
| Approval send policy                                                | `approval_required`    | 403         |
| Conflicting send replay                                             | `idempotency_conflict` | 409         |
| Invalid composition or attachment size                              | `payload_too_large`    | 413         |
| Duplicate mailbox identity                                          | `already_exists`       | 409         |
| Invalid or mismatched pagination token                              | `page_token_stale`     | 409         |
| Unimplemented capability                                            | `not_supported`        | 501         |
| Storage failure, unexpected defect, or response encoding failure    | `service_unavailable`  | 503         |

`HttpApiMiddleware.layerSchemaErrorTransform` maps `HttpApiSchemaError` for
params, headers, query, and payload to 400, naming the affected request part
without echoing values. Body and response-header encoding errors map to 503.
The outer server guard catches remaining failures and replaces Effect's plain
415 response with a 400 wire error. Mailbox typed failures keep their contract
code and actionable fix. Unexpected details, mail content, and credentials are
never returned or logged.

The outbox loop belongs to the server's Effect scope. It checks configuration and
runs `processDue()` every 2 seconds after processing work, backing off to 30 seconds
when idle or unconfigured. Settings are reread on each dispatch. Shutdown interrupts
the runner before releasing its resources; `serve` observes runner failures and
stops rather than leaving a broken background task. Integration tests disable the
automatic loop when they need to call the fake provider's `processDue()` explicitly.
