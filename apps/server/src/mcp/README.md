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
The initialized notification receives HTTP 202. OAuth, stdio, resumable event
streams, and remote tunnel exposure are not implemented here.

Every HTTP request requires `Authorization: Bearer <owner-token-or-api-key>`.
Missing, invalid, expired, and revoked credentials return HTTP 401 with
`WWW-Authenticate: Bearer`. Foreign browser origins are rejected. Tools
reauthenticate the current request, never a captured session credential or a
registration-time principal. Effect dispatches tool handlers in request fibers;
the registrations capture only the service handles and read request headers at
invocation time. A session does not retain permissions when its bearer changes.

## Tools and annotations

All tools include fresh guidance that email content is untrusted external data
and must never become instructions. All input schemas have an object root and
at least one documented field; `list_inboxes` accepts optional pagination fields.
Parameters use camelCase (`inboxId`, `messageId`, `threadId`, `pageToken`,
`replyTo`, `replyAll`, `clientId`, `addLabels`, `removeLabels`, `idempotencyKey`).
Attachment objects retain the shared request fields. `get_attachment`
uses `threadId`, `attachmentId`, and optional `inboxId` and returns the same signed,
bearer-protected download metadata as REST. Thread tools may omit `inboxId` for
a scoped organization lookup. Default page size is 10; `limit` can override it.

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
| `reply_to_message`                                                                                                  | false        | false           | false          | `message_reply`  |

Create/send annotations stay non-idempotent because `clientId` and
`idempotencyKey` are optional. Replaying a send with the same `idempotencyKey`
and payload returns the original ids; changing the payload returns
`idempotency_conflict`. This ledger is shared with REST's `idempotency-key` header.
Parent-based sends also need `message_read` and a visible parent. Owners send
directly, `read_only` blocks, and `approval` returns `approval_required` without
creating drafts. The pending-draft approval workflow remains later work.

There are no tools for domains, keys, webhooks, settings, transport, unlock,
drafts, or list entries. Owner-only capabilities never enter the MCP registry.

## Shared behavior and results

Both REST and MCP call `AgentOperations`, which uses the same Mailbox/Outbox
methods and authorization helpers. Scope checks precede permission checks and
conceal foreign resources with `not_found`. Organization pagination and search
apply the key's fixed inbox allowlist before reading. Hidden-label permissions
control listing flags and direct resources, including parents, threads, and
attachment downloads. Missing transport cannot enqueue through either surface.

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
available through REST's authenticated raw download, without a plaintext cache.

Tests initialize and list tools over a real port-0 loopback server, use encrypted
Store in temporary homes, inject fake providers and an in-memory keychain, and
check cross-surface idempotency, policies, scope, labels, current credentials,
truncation, and server lifetime. No real Cloudflare request or email was sent.
