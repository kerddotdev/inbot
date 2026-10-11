# Loopback HTTP API

Build with Node 24.21.0 and run against an explicit home:

```sh
pnpm build
pnpm start:server --home /path/to/explicit/inbot-home --port 0 --init
```

`serve` defaults to development flavor. Port 0 chooses an available loopback
port; `--port` accepts 0 through 65535. The service listens only on `127.0.0.1`.
`--init` initializes a new home with a random DEK wrapped by an OS-keychain KEK;
existing homes unlock with the keychain. Passphrase startup remains later work. The [CLI](../../../cli/README.md)
delegates `serve` to this entry and uses the REST API for resource commands. Owner browser sessions authenticate against the unlocked service;
they do not unlock the database. SIGINT and SIGTERM close HTTP and
the encrypted Store. Files, keys, and `connection.json` remain in the home.

On each successful start, the service replaces `<home>/connection.json`
atomically with mode 0600. Its shape is `{ "url": "http://127.0.0.1:<port>",
"token": "<owner-bearer-token>" }`. Local clients read that file and send
`Authorization: Bearer <token>`. Only the token's SHA-256 remains in the owner
authentication service. The service prints a JSON `server.ready` line containing the URL, never the
bearer token. When no owner password exists it first prints
`{"event":"owner.setup_required","code":"<one-time-code>"}`. Only the code
SHA-256 stays in process memory. Restart rotates both the bearer token and any
unconsumed setup code. Existing owner accounts and sessions persist.

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
- Domains: owner-only register, list, get, update, delete, verify, BIND zone-file,
  apply, and teardown. See [provisioning](../provision/README.md) for safety and states.
- Mail transport: owner-only `GET`, `PUT`, and `DELETE /v0/owner/transport`.
- Lists: global and inbox allow/block CRUD for `receive`, `send`, and `reply`.
  See [list policy and enforcement](../lists/README.md).
- API keys: owner-only organization CRUD and inbox-scoped create, list, update,
  delete. The contract has no inbox-scoped key-get route.

Send endpoints return `{ message_id, thread_id }` after the outbox transaction
commits, with the message initially `queued`. The `idempotency-key` header is
passed to the durable inbox-scoped replay ledger. Provider acceptance later
changes the label to `sent`; it does not prove delivery. No configured transport
returns 503 `service_unavailable` with fix `Configure the Cloudflare mail transport`
and does not enqueue. Configure the transport in Settings > Mail transport or through the owner routes below.

Webhook CRUD/header routes and authenticated `/v0/ws` are implemented; see
[event delivery](../events/README.md) for scope, signing, SSRF guards, retries,
resume and the owner cookie/CSRF handshake. Optional [remote access](../remote/README.md)
guards these routes on a separate tunnel listener. OAuth authorization is implemented. The same server
exposes authenticated streamable HTTP MCP at `/mcp`; see
[the MCP reference](../mcp/README.md).

Raw and attachment endpoints return the declared metadata and a signed
five-minute URL under `/v0/downloads/:token`. Downloads still require a bearer
token or owner session cookie and recheck its current permissions, inbox scope, and hidden labels. They
read encrypted storage at download time and send binary content as an attachment
with `nosniff` and `no-store`. No plaintext download cache is written. URLs
expire on restart as well as at their advertised expiry time.

## Owner mail transport

`GET /v0/owner/transport` returns `{ provider: "cloudflare", account_id, token_set,
verification_status, verified_at }`. An absent configuration has a null account and
time, `token_set: false`, and `not_configured` status. Previously configured internal
credentials have `unverified` status until verified through the owner route. A saved
verification has `verified` status and an ISO timestamp. This records the last
successful token check; it does not prove the token remains active or has all required
permissions. Responses never contain the API token or a token hint.

`PUT /v0/owner/transport` accepts `{ api_token, account_id? }`. A supplied account ID is 32
hexadecimal characters and the token must be nonempty without whitespace. With an
explicit ID, the existing provision adapter checks the candidate with account token
verification and user-token fallback. Without it, the adapter first verifies the user
token, then lists accessible accounts with `GET /accounts`. Exactly one is selected;
none or several return 409 `action_required`. For several accounts, the error's `fix`
lists their names and IDs; resubmit with the chosen `account_id`. Discovery or verification
failure preserves the existing configuration. Account-owned tokens can use an explicit ID.

Only after verification and account selection are credentials and the verification time
persisted atomically in the encrypted Store. Provider errors never include response bodies,
credentials, or keys. Token verification confirms active status; domain preflight and provider
operations check permissions. Missing permissions name the dashboard selection
and scope in the fix. See the [shared permission table and token template](../provision/README.md#token-permissions).

`DELETE /v0/owner/transport` returns an empty 200 response and is idempotent. Active
provisioning or remaining resource ledger entries return 409 `action_required` with a
teardown instruction. Clear succeeds after teardown, without deleting local mail,
inbound identity, or domain registration. Changing accounts requires teardown and
registration deletion first; token rotation for the same account is supported.
Transport writes share the provisioning lock with apply, verification, routing, and
teardown. Outbox, inbound, and delivery runners observe changes on their next cycle;
provider requests already in flight can finish with the previous configuration.

Every transport route requires owner bearer or owner session authentication. Unsafe
session requests require `X-Inbot-CSRF`; agent API keys receive 403 regardless of grant.
No MCP tool, CLI command, or remote route is added. Errors retain
`{ name, code, message, fix }`, including validation, permission, provider availability,
and action-required failures.

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

## Unknown send outcomes

Message reads, lists, search, and thread messages expose `send_status` and optional
`send_reason`. `send_unknown` means the provider may have sent the message; never
resend automatically. Its label is also `send_unknown`, and its durable event is
`message.send_unknown`. `send_status: "failed"` means no provider acceptance.
Delivery failure labels can coexist with `send_status: "sent"`.

`POST /v0/inboxes/{inbox_id}/messages/{message_id}/resolve` accepts
`{ "decision": "sent" | "failed" }` and returns the message. Only the local owner
can call it after confirming sent or not sent. Non-unknown messages fail with
`validation_error`; repeating the same recorded decision returns the message
without another event. Resolution commits the state and `message.sent` or
`message.failed` event together, using `owner_confirmed_sent` or
`owner_confirmed_not_sent` as reason. It never invokes the provider. A deliberate
retry uses the normal send route with a new key and a new message.
Agents receive 403 `missing_permission`; no MCP tool exposes resolution, and the
tunnel blocks its route. Public label updates cannot change outbox send labels.

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
same Mailbox/Outbox/Drafts methods. The middleware checks contract permission annotations
through that same authorization function. Scope remains checked before permissions.

Browser requests with an `Origin` different from the server's exact origin,
including `null`, return 403. Requests without `Origin` and same-origin requests
are allowed; protected endpoints still need authentication. Host must match the
loopback URL, preventing browser DNS rebinding. API responses use `no-store`.

## Owner browser authentication

The separate `OwnerApiGroup` in `packages/contracts/src/api/owner.ts` declares
Inbot extensions, outside the main `InbotApi`. These endpoints
are never MCP tools. Agent API keys are rejected on every owner endpoint,
including public endpoints when an agent Authorization header is supplied.

| Method | Path                           | Input / result                                                                               | Access                                               |
| ------ | ------------------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| GET    | `/v0/owner/status`             | `{ setup_required, authenticated, locked }` booleans                                         | Public                                               |
| POST   | `/v0/owner/setup`              | `{ password, code }` -> session                                                              | Public, only before setup, valid setup code required |
| POST   | `/v0/owner/login`              | `{ password }` -> session                                                                    | Public                                               |
| POST   | `/v0/owner/logout`             | Revokes current cookie session and clears cookie                                             | Owner                                                |
| GET    | `/v0/owner/sessions`           | `{ sessions: [{ id, created_at, last_seen_at, expires_at, user_agent, revoked, current }] }` | Owner                                                |
| DELETE | `/v0/owner/sessions/:id`       | Revokes session; clears cookie if current                                                    | Owner                                                |
| POST   | `/v0/owner/password`           | `{ current_password, password }`; revokes other sessions                                     | Owner                                                |
| POST   | `/v0/owner/login-links`        | `{ url: "<origin>/login?token=..." }`                                                        | Owner bearer only                                    |
| POST   | `/v0/owner/login-links/redeem` | `{ token }` -> session                                                                       | Public                                               |

Setup, login, and link redemption set the session cookie and return
`{ csrf_token, expires_at }`. New passwords require 12 to 1024 characters.
The password uses Node's built-in Argon2id with a random 16-byte salt,
19,456 KiB memory, two passes, one lane, and a 32-byte hash. Verification uses
constant-time hash comparison, including a dummy derivation before setup.
Password failures share process-wide exponential backoff from one to 60 seconds;
concurrent password verification attempts return 429 `rate_limit_exceeded`.
A successful verification resets backoff. This limiter resets on restart.

Migration 8 adds a singleton `owner_account` and `owner_sessions` inside the
encrypted database. Session tokens are random 32-byte values; only SHA-256
hashes persist. Session metadata stores a SHA-256 of User-Agent, no IP address.
Expiry slides by 14 days per authenticated request, bounded by 30 days from
creation. Expired and revoked sessions cannot authenticate. Listing keeps
revocation history. Password changes preserve the current cookie session and
revoke all others; bearer-only password changes revoke all browser sessions.

The loopback HTTP service sets `inbot_session`, with `HttpOnly`, `SameSite=Strict`,
`Path=/`, no Domain, and an explicit expiry. The cookie builder uses
`__Host-inbot_session` and `Secure` for HTTPS origins; TLS serving is not
implemented by this loopback server. Cookie requests authenticate exclusively as
owner. An Authorization header takes precedence and never falls back to cookies.
This applies to REST, downloads, and MCP; it preserves agent scope and permissions.

For cookie-authenticated unsafe methods, send `X-Inbot-CSRF: <csrf_token>`.
The token is derived from the session token with HMAC-SHA-256 and compared in
constant time. Authenticated `GET /v0/owner/status` returns it in the
`X-Inbot-CSRF` response header, keeping the JSON body boolean-only. Browser code
can obtain it after reload without reading the HttpOnly cookie. The exact Origin
check remains enforced. Bearer requests do not need CSRF. Setup/login/redemption
without an existing session do not need CSRF, but still require same-origin
browser requests. Foreign and null Origins are rejected.

Setup atomically creates the account and session, refuses subsequent setup, and
consumes the in-memory setup code after success. The setup code is entered from
the startup stdout line; it is never returned by status or stored on disk.
Login links are hashed in a bounded in-memory map, expire after two minutes,
are consumed before redemption, and disappear on restart or password change.
The owner UI redeems the URL token once and removes it from
browser history before rendering. `inbot open` requests links with the local
owner bearer and opens the browser only with `--browser`.

`locked` is currently false because HTTP starts only after the database unlocks.
There is no browser database-unlock endpoint. Owner sessions and setup do not
change agent grants or the implemented tunnel allowlist.

## Static owner UI serving

Pass `serve --web-root /absolute/path/to/apps/web/dist` to serve a prebuilt UI.
The path is resolved explicitly; there is no automatic repository or `dist`
discovery and no UI when the flag is omitted. An invalid root or missing `index.html` fails startup.
Build the React bundle with `pnpm web:build`. The bundle and owner authentication
API share the loopback origin. The UI connects owner authentication, mail, API keys, approvals, and mail transport settings to these routes.
Domains and optional remote access use owner-only APIs; other settings still use mock data. See [owner UI](../../../web/README.md).

GET requests first try files under the canonical web root, then fall back to
`index.html`. `/v0`, `/mcp`, `/oauth`, and `/.well-known`, including their
subpaths and encoded spellings, never get SPA fallback. Non-GET requests do not
serve files. Malformed encodings, encoded dot segments or separators that form
traversal, backslashes, NULs, double encodings, and symlinks outside the root are
rejected. Canonical paths are checked before reading files.

JavaScript, CSS, HTML, images, fonts, JSON, and WASM have explicit content types.
Files whose names end in a hash-like suffix of at least eight characters before
the extension use `public, max-age=31536000, immutable`; HTML uses `no-cache`.
Other files use `no-cache`. All responses include `X-Content-Type-Options:
nosniff`, `Referrer-Policy: no-referrer`, and this CSP:

```text
default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com; frame-ancestors 'none'; base-uri 'none'
```

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

## Allow and block lists

`GET`/`POST /v0/lists/:direction/:type` and `GET`/`DELETE` with `/:entry` manage global entries. Prefix with `/v0/inboxes/:inbox_id` for inbox entries. Create accepts `{ entry, reason? }`; directions are `receive`, `send`, `reply`, types `allow`, `block`. Entries normalize to lowercase (domains to IDNA) and match case-insensitively. Lists paginate with `limit` and `page_token`, lexically ascending.

Reads need `list_entry_read`, creation `list_entry_create`, deletion `list_entry_delete`. Global access requires owner authentication or an unrestricted inbox grant; inbox access enforces fixed scope. Global and inbox rules add together, blocks win, and non-empty allow lists restrict mail. Replies pass send and reply rules. Forbidden outbound recipients return `message_rejected` with nothing queued. Inbound rejection reasons are recorded durably before ciphertext cleanup. Settings uses these same routes with owner sessions and CSRF.

## Event routes

- `/v0/webhooks` and `/v0/inboxes/:inbox_id/webhooks`: GET/POST.
- Append `/:webhook_id` for GET/PATCH/DELETE; append `/headers` for GET/PATCH.
- `/v0/ws`: authenticated WebSocket upgrade; send one contract `subscribe` frame.

Webhook routes enforce `webhook_read/create/update/delete`, key ownership and
inbox scope. Creation alone returns `secret`; subsequent metadata omits it.
Header reads return names only. Unsupported pod filters fail `not_supported`.
`message_read`/`draft_read` and hidden-label permissions govern event payloads.
Domain events require the owner. Disabled state and failures are visible in GET.
Agents require public HTTPS webhook targets; only owners can use loopback HTTP.
Credential header names are forbidden for all webhooks. Agent-created webhook
delivery errors expose only `delivery_failed`, without HTTP status details.
Deletion redacts received event content transactionally. Event history expires
after 30 days unless webhook delivery still needs it; pruned resume IDs fail
`validation_error`. WebSocket output is capped at 1 MiB, closing with 1013 for
slow clients or oversized events.
Owner cookie upgrades require exact Origin plus `inbot.events` and
`csrf.<token>` subprotocols; API keys use a bearer header. See the module README
for durable resume, heartbeat and revocation. The tunnel listener applies its
policy before upgrades: agent keys retain their
permissions and inbox scope, owner sessions require the exact public HTTPS Origin
and CSRF subprotocol, and local owner bearer tokens are rejected.

## Optional remote access

Local owner routes are `GET /v0/owner/remote`,
`POST /v0/owner/remote/enable` with `{ "hostname": "inbot.example.com" }`, and
`POST /v0/owner/remote/disable`. Responses contain state, hostname, reason and
connector version, never credentials. These routes are rejected over the tunnel.

The tunnel has a dedicated loopback listener and the exact allowlist documented
in [remote access](../remote/README.md#security-boundary-and-exact-allowlist).
It rejects local owner bearer tokens and management routes, preserves API key
scope/send policy, and accepts secure owner browser sessions with CSRF and exact
public Host/Origin checks. Download URLs use the public HTTPS origin. Ordinary
loopback requests keep their existing behavior. Remote access uses migration 12
after lists (10) and events (11); the runner remains strict.

## OAuth clients

Public clients discover path-specific resources at
`/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-protected-resource/v0`.
The root `/.well-known/oauth-protected-resource` describes the origin itself.
`/.well-known/oauth-authorization-server` advertises PKCE S256 and issuer responses.
Protocol routes are `/oauth/register`, `/oauth/authorize`, `/oauth/authorize/details`,
`/oauth/token`, and `/oauth/revoke`. Public requests ignore unknown parameters.
Registration accepts common DCR metadata and returns the supported grant-type subset;
invalid metadata returns `invalid_client_metadata`. Native private-use scheme redirects
are supported; loopback callback ports may vary at authorization, but the token
exchange binds the exact callback, including its port. Authorization responses include
`iss`; errors redirect with `error` and `state` only after callback validation.

Consent requires an owner browser session, exact Origin and CSRF on POST, and its
body remains strict. Public discovery, registration, token and revocation routes permit
any Origin without credentials and support OPTIONS. Consent and owner routes never
permit cross-origin requests or credentialed CORS.

PKCE S256 and the listener's exact `resource` are mandatory. The loopback listener
always advertises loopback URLs; the tunnel advertises its usable public HTTPS origin.
Opaque tokens share API key grants but are bound to that listener and MCP or REST;
owner-only routes reject them. 401 challenges include the matching `resource_metadata`
URL and add `error="invalid_token"` for invalid presented credentials.

Owner-only local `GET /v0/owner/oauth/clients` lists approved grants;
`DELETE /v0/owner/oauth/grants/:grant_id` revokes them and all credentials.
`POST /v0/owner/oauth/clients/purge` deletes registrations without grants and returns
`{ "deleted_clients": <count> }`. These routes are blocked over the tunnel and never
exposed as MCP tools. The owner UI and `inbot oauth clients|revoke|purge` use the same API.
Unexchanged consent grants expire with their five-minute codes. Unapproved client
registrations expire after 24 hours. Loopback and tunnel rate buckets are separate;
only the dedicated cloudflared listener trusts `CF-Connecting-IP` for per-IP buckets.
It must receive Internet traffic exclusively from cloudflared, with the owner's host
trusted. The loopback listener ignores proxy headers; unknown client IDs cannot spend
the token bucket.

See [OAuth security and lifecycle](../oauth/README.md) for migration 13,
registration limits, refresh rotation, family reuse detection and event handling.
