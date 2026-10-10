# Contracts

`@inbot/contracts` defines Effect v4 schemas, inferred types, and the `InbotApi`
HTTP API declaration. It contains no handlers, mail delivery, storage, or
permission enforcement. Workspace consumers import relative paths to `src`.

The implemented subset uses `/v0` paths, snake_case fields,
required response fields, cursor pagination, search highlights, and event
payloads. `OpenApi.fromApi(InbotApi)` from `effect/http-api` generates its OpenAPI
document. Unsupported resource families have no endpoint declarations.

Timestamps are validated ISO-8601 strings. Decoding and encoding preserve the
original offset and fractional precision. Message list items exclude bodies;
batch-get returns full messages. Raw-message and attachment endpoints return
download metadata, while domain zone files use `text/plain`. Deletions and
domain verification return empty HTTP 200 responses; webhook header updates
return HTTP 204.

`Draft` and `DraftItem` add an optional boolean `pending_approval`. They retain
the `scheduled`, `sending`, and `failed` send statuses. Creating a draft
does not authorize sending it. Reply and forward context is set on creation;
draft updates follow nullable content fields and attachment and
label deltas. Setting `send_at` to null cancels scheduling.

API keys use Inbot's grant model. Missing `inbox_ids` means all inboxes, an empty
array means none, and `inbox_id` narrows the scope to one inbox. When both scope
fields are present, both apply. Missing or false permission flags grant no
permission. Threads use message permissions. `send_policy` is `direct`,
`approval`, or `read_only`; services must enforce it. Only key creation returns
the plaintext `api_key`. Expiry and inbox scope are immutable on update.

`BearerAuth` declares `Authorization: Bearer <key>` and provides a
`CurrentPrincipal`. Domains and API keys additionally declare `OwnerOnly`.
Other endpoints carry a typed `RequiredPermission` annotation. The server HTTP
layer implements these middleware services, inbox scopes, and restricted-label
checks for mailbox operations. Send operations currently return `not_supported`;
send policies and scoped event subscriptions need enforcement when their
services land. Owner-only resources must never become agent MCP tools.

Errors use the `{ name, code, message, fix?, docs? }` wire shape without an Effect
`_tag`. Status-specific schemas constrain the code and carry `httpApiStatus`;
`ErrorStatus` exposes the same mapping. The HTTP server maps Effect's request
decoding failures to `validation_error` with safe, actionable error text.
Read and write error sets both declare `not_supported` so generated clients can
decode the 501 responses of registered operations awaiting implementation.
The optional `Idempotency-Key` header is declared on send, reply, reply-all,
forward, and draft-send operations. Persistence, replay, and conflict detection
belong to the service.

Compatibility fields such as `pod_id`, `organization_id`, `calendar_event_id`,
and `tracking_enabled` remain in resource shapes for wire compatibility.
They do not implement those resource families. Event types are limited to the
supported mail and domain events. Open tracking requests (`track_opens`) and
tracking events are not modeled. Providers, domains, keys, and webhook secrets
are not provisioned by this package.

`outbound.ts` adds shared service-only `OutboundRequest` wrappers, `OutboxEntry`,
and `DeliveryEvent` schemas. The wrappers reuse the existing requests
and do not change REST wire formats. The outbound service persists replay keys
and acceptance state, composes mail, and applies provider events; public handlers,
grants/send policies, and webhook/WebSocket publication remain unimplemented.
