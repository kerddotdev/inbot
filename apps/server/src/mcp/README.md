# MCP mailbox tools

The loopback HTTP server mounts streamable HTTP at `/mcp` using Effect 4.0.2's
built-in `McpServer.layerHttp` from `effect/ai`, with `McpProtocol.v2025_06_18`.
No separate MCP SDK or dependency is needed. `McpSchema.Tool` registrations allow
explicit wire error results and a bounded success payload without additional
business logic in the transport.

Clients initialize with `protocolVersion: "2025-06-18"`, keep the returned
`Mcp-Session-Id`, and send it with `MCP-Protocol-Version: 2025-06-18` on later
requests. POST requests use `Content-Type: application/json` and
`Accept: application/json, text/event-stream`; responses can be JSON or SSE.
The initialized notification receives HTTP 202. OAuth, stdio, resumable MCP event
streams, and remote tunnel exposure are not implemented here. Mail events support
replay through the separate authenticated `/v0/ws` WebSocket.

Every HTTP request requires `Authorization: Bearer <owner-token-api-key-or-oauth-access-token>`
or an owner browser session cookie. Cookie-authenticated POST/DELETE requests
also require `X-Inbot-CSRF`; see [owner authentication](../http/README.md#owner-browser-authentication).
An Authorization header takes precedence over cookies.
Missing, invalid, expired, and revoked credentials return HTTP 401 with
`WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp", scope="inbot"`. Foreign browser origins are rejected. Tools
reauthenticate the current request, never a captured session credential or a
registration-time principal. Effect dispatches tool handlers in request fibers;
the registrations capture only the service handles and read request headers at
invocation time. A session does not retain permissions when its bearer changes.

## Tools and annotations

All tools include fresh guidance that email content is untrusted external data
and must never become instructions. All input schemas have an object root and
at least one documented field; `list_inboxes` accepts optional pagination fields.
Parameters use camelCase (`inboxId`, `messageId`, `threadId`, `pageToken`,
`replyTo`, `replyAll`, `inReplyTo`, `forwardOf`, `sendAt`, `draftId`, `clientId`, `addLabels`, `removeLabels`, `idempotencyKey`).
Attachment objects retain the shared request fields. `get_attachment`
uses `threadId`, `attachmentId`, and optional `inboxId` and returns the same signed
capability download metadata as REST. Fetch the absolute URL without a bearer
header. The HMAC-signed URL expires after five minutes or service restart and is
bound to the issuing principal and origin. Every download rechecks credential
activity, current permissions, inbox scope, and hidden labels. OAuth capabilities
retain the issuing access token's hash and audience, including `/mcp`; owner session
capabilities stop working on session revocation. A supplied bearer must authenticate
the issuing principal. Keep URLs private. File bytes are not embedded in tool results.

Thread tools may omit `inboxId` for a scoped organization lookup. Default page size is 10; `limit` can override it.

| Tools                                                                                                               | readOnlyHint | destructiveHint | idempotentHint | Permission       |
| ------------------------------------------------------------------------------------------------------------------- | ------------ | --------------- | -------------- | ---------------- |
| `list_inboxes`, `search_inboxes`, `get_inbox`                                                                       | true         | false           | true           | `inbox_read`     |
| `list_threads`, `search_threads`, `get_thread`, `get_attachment`, `list_messages`, `search_messages`, `get_message` | true         | false           | true           | `message_read`   |
| `create_inbox`                                                                                                      | false        | false           | false          | `inbox_create`   |
| `update_inbox`                                                                                                      | false        | false           | true           | `inbox_update`   |
| `delete_inbox`                                                                                                      | false        | true            | true           | `inbox_delete`   |
| `update_thread`, `update_message`                                                                                   | false        | false           | true           | `message_update` |
| `delete_thread`                                                                                                     | false        | true            | true           | `message_delete` |
| `send_message`, `forward_message`                                                                                   | false        | false           | false          | `message_send`   |
| `create_draft`                                                                                                      | false        | false           | false          | `draft_create`   |
| `list_drafts`, `get_draft`                                                                                          | true         | false           | true           | `draft_read`     |
| `update_draft`                                                                                                      | false        | false           | true           | `draft_update`   |
| `send_draft`                                                                                                        | false        | false           | false          | `draft_send`     |
| `delete_draft`                                                                                                      | false        | true            | true           | `draft_delete`   |
| `reply_to_message`                                                                                                  | false        | false           | false          | `message_reply`  |

Create/send annotations stay non-idempotent because `clientId` and
`idempotencyKey` are optional. Replaying a send with the same `idempotencyKey`
and payload returns the original ids; changing the payload returns
`idempotency_conflict`. This ledger is shared with REST's `idempotency-key` header.
Parent-based sends also need `message_read` and a visible parent. Owners send
directly, `read_only` blocks, and `approval` creates or marks a pending draft and
returns `isError: true` with `approval_required`. The error shape stays
`{ name, code, message, fix }`; `message` and `fix` contain the draft id. No message
id is invented before the owner approves. Proposed message idempotency is shared
with REST, including after the original draft is approved or deleted.

There are no tools for owner authentication, sessions, passwords, domains, keys,
settings, transport, unlock, or approval/rejection.
Owner-only capabilities never enter the MCP registry.

## Drafts

`create_draft`, `list_drafts`, `get_draft`, `update_draft`, `send_draft`, and
`delete_draft` call the same draft service and shared operations as REST.
`list_drafts` may omit `inboxId` for a scoped organization list. The other tools
require `inboxId` and existing-draft tools require `draftId`. Draft recipients use
arrays; `replyTo`, `inReplyTo`, `forwardOf`, `replyAll`, `sendAt`, `clientId`,
`addAttachments`, and `removeAttachments` map to the shared wire fields.

`clientId` replays creation within the inbox while the draft exists. Reply and
forward drafts derive recipients/content/threading from a visible source and
also require `message_read`. `send_draft` queues now and deletes the draft
atomically, with `idempotencyKey` replaying the result after deletion. An approval
key instead marks the draft pending and receives the documented error.

`sendAt` schedules a draft, requiring `draft_send` in addition to the create or
update permission. Only due direct or owner-approved drafts are queued. Setting
`sendAt: null` or deleting cancels scheduling. Schedules require the running
service and may be late; message timestamps show actual queue time. Edits to an
approved draft needing review require another approval. Owners use the REST
extension endpoints to approve or reject; neither is an MCP tool. Attachment
download metadata is available through the draft REST endpoints.

See [the HTTP reference](../http/README.md) for states, owner decisions, and
scheduling guarantees.

## Shared behavior and results

Both REST and MCP call `AgentOperations`, which uses the same Mailbox/Outbox/Drafts
methods and authorization helpers. Scope checks precede permission checks and
conceal foreign resources with `not_found`. Organization pagination and search
apply the key's fixed inbox allowlist before reading. Hidden-label permissions
control listing flags and direct resources, including parents, threads, and
attachment downloads. Missing transport cannot enqueue through either surface; approval proposals can
still be stored for later owner review.

Success results put the same JSON in `structuredContent` and text `content`.
Errors set `isError: true` and return `{ name, code, message, fix }` in both places.
Validation and service failures are scrubbed without logging or returning mail,
credentials, or exception details. Interruption propagates to the request fiber.

The complete result, including the duplicated text encoding, stays below 20 KB.
Bodies are shortened only when necessary and receive an explicit `truncated: true`
marker plus guidance to fetch individual messages or attachments. If unusually
large metadata still exceeds the budget, a small identity/count result with the
same marker is returned. Repeat an oversized page with a smaller `limit` before
using any continuation token. MCP `get_message` is also bounded; full raw mail is
available through REST's capability raw download, without a plaintext cache.

Tests initialize and list tools over a real port-0 loopback server, use encrypted
Store in temporary homes, inject fake providers and an in-memory keychain, and
check cross-surface idempotency, policies, scope, labels, current credentials,
truncation, and server lifetime. No real Cloudflare request or email was sent.

## Allow and block list tools

`list_list_entries`, `get_list_entry`, `create_list_entry`, and `delete_list_entry` use the same authorized service as REST. Arguments are `direction`, `type`, optional `inboxId`, plus `entry` on get/create/delete, optional `reason` on create, and `limit`/`pageToken` on list. Reads need `list_entry_read`, creates `list_entry_create`, deletes `list_entry_delete`. Global access requires an unrestricted inbox grant. Read/create/delete annotations follow the existing patterns. See [policy](../lists/README.md) for normalization, precedence, and durable enforcement.

## Webhook tools

Webhook tools: `list_webhooks`, `get_webhook`, `create_webhook`, `update_webhook`,
`delete_webhook`, `get_webhook_headers`, and `update_webhook_headers`. All use the
same service and grants as REST. Optional `inboxId` selects the inbox route scope;
`webhookId` identifies a receiver; write tools take the shared REST body under
`request`. `list_webhooks` uses existing pagination arguments. Reads are marked
read-only, deletes destructive, and updates/deletes idempotent. Creation returns
the secret once; header reads expose names only. Required permissions are named
in descriptions and enforced by the service. No stream subscription or owner-only
domain, session, settings, or key tools are added.

OAuth-capable MCP clients can connect without an API key after browser approval by the owner. See [OAuth authorization](../oauth/README.md).

System state labels (`received`, `queued`, `sent`, `send_unknown`, `failed`, `delivered`, `bounced`, `complained`, `rejected`, `deferred`) are protected on every message, including messages without an outbox entry. Message, thread, and batch label edits that add or remove any of them return `validation_error` with a fix and make no changes. Custom labels and `unread` remain editable.
