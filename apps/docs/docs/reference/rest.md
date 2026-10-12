---
title: REST API
description: Every /v0 route with who may call it and the permission it needs, plus pagination, idempotency, composing rules, downloads and limits.
---

The REST API lives under `/v0` on the service's loopback URL, or on the [remote access](/guides/remote-access) hostname for agent routes. It is the contract every other surface uses, and its paths, snake_case fields, error codes, idempotency and pagination are kept stable deliberately.

## Conventions

- **Authentication:** `Authorization: Bearer <credential>`, with the owner token, an API key or an OAuth access token issued for `<origin>/v0`. Browser sessions use a cookie plus the `X-Inbot-CSRF` header on unsafe methods. When an `Authorization` header is present, cookies are ignored.
- **Bodies:** JSON with `Content-Type: application/json`. Unknown body fields are rejected with `validation_error`.
- **Arrays in queries:** repeat the parameter, for example `?labels=unread&labels=important`.
- **Time:** RFC 3339 timestamps, for example `2026-10-11T08:00:00Z`.
- **Deletes** return an empty `200`. Deleting is permanent; there is no trash timer.
- **Errors:** `{ name, code, message, fix?, docs? }`. See [Errors and exit codes](/reference/errors).
- **Scope:** for an agent, anything outside its inbox scope returns `404 not_found`, checked before permissions.

In the tables, **Owner** means owner only, and a permission name means agents need that [permission](/reference/permissions); the owner may always call it.

## Pagination

List endpoints accept `limit` (1 to 100, default 20), `page_token` and, on most lists, `ascending` (default `false`, newest first). Responses contain `count`, `limit`, the items, and `next_page_token` when there are more.

Page tokens are opaque and bound to the query's filters and the caller's scope. Reusing one with different filters, or after a search index change, returns `409 page_token_stale`: start again without a token. Allow and block list entries sort by entry, ascending only.

## Idempotency

`POST` routes that send mail accept an `Idempotency-Key` header of 1 to 256 characters from `A-Z a-z 0-9 . _ ~ -`: send, reply, reply-all, forward, draft send and draft approve.

- Keys are scoped to the inbox and shared across those routes and MCP's `idempotencyKey`.
- The same key with the same payload returns the original `{ message_id, thread_id }`.
- The same key with a different payload returns `409 idempotency_conflict`.
- A key becomes reusable 24 hours after its send reaches a final state. Keys for approval requests and draft sends do not expire.

Creating inboxes and drafts also accepts a `client_id`: repeating a create with the same `client_id` returns the existing resource.

## Inboxes

| Route                        | Access         | Notes                                                                                                                                                                |
| ---------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /inboxes`               | `inbox_read`   | Only inboxes in scope                                                                                                                                                |
| `POST /inboxes`              | `inbox_create` | Required: `domain`. Optional: `username` (16 random hex characters if omitted), `display_name`, `status`, `metadata`, `client_id`. The new address must be in scope. |
| `GET /inboxes/search?q=`     | `inbox_read`   |                                                                                                                                                                      |
| `GET /inboxes/{inbox_id}`    | `inbox_read`   |                                                                                                                                                                      |
| `PATCH /inboxes/{inbox_id}`  | `inbox_update` | `display_name`, `status` (`active`, `paused`), `metadata` (merged; `null` values remove keys, `metadata: null` clears all)                                           |
| `DELETE /inboxes/{inbox_id}` | `inbox_delete` | Deletes the inbox and everything in it                                                                                                                               |

`inbot-selftest` is reserved on registered domains for verification.

## Threads

Each route exists inbox-scoped (`/inboxes/{inbox_id}/threads/...`) and organization-wide (`/threads/...`). Organization routes resolve the thread within the caller's scope.

| Route                                                     | Access           | Notes                                                                                                                                                   |
| --------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET .../threads`                                         | `message_read`   | Filters: `before`, `after`, `labels`, `senders`, `recipients`, `subject`, `include_spam`, `include_blocked`, `include_unauthenticated`, `include_trash` |
| `GET .../threads/search?q=`                               | `message_read`   | Full-text, ranked by relevance; also `before`, `after`. Never includes hidden mail.                                                                     |
| `GET .../threads/{thread_id}`                             | `message_read`   | The thread with its messages. Pages hold the newest messages, oldest first within the page.                                                             |
| `PATCH .../threads/{thread_id}`                           | `message_update` | `add_labels`, `remove_labels`                                                                                                                           |
| `DELETE .../threads/{thread_id}`                          | `message_delete` |                                                                                                                                                         |
| `GET .../threads/{thread_id}/attachments/{attachment_id}` | `message_read`   | Attachment metadata with a download URL                                                                                                                 |

## Messages

All message routes are inbox-scoped: `/inboxes/{inbox_id}/messages/...`.

| Route                                                       | Access                          | Notes                                                                                                                             |
| ----------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET .../messages`                                          | `message_read`                  | Pagination, time, label and hidden-label filters; `from`, `to`, `subject` substring matches. No `senders` or `recipients`.        |
| `GET .../messages/search?q=`                                | `message_read`                  |                                                                                                                                   |
| `GET .../messages/{message_id}`                             | `message_read`                  | Includes `text`, `html`, `extracted_text`, `extracted_html`, `send_status`, `send_reason`                                         |
| `PATCH .../messages/{message_id}`                           | `message_update`                | `add_labels`, `remove_labels`. System state labels cannot be changed; attempting to add or remove one returns `validation_error`. |
| `DELETE .../messages/{message_id}`                          | `message_delete`                |                                                                                                                                   |
| `POST .../messages/batch-get`                               | `message_read`                  | `message_ids`, up to 500. Missing and hidden messages are omitted.                                                                |
| `POST .../messages/batch-update`                            | `message_update`                | `message_ids` up to 50, `add_labels`, `remove_labels`. Removal wins over addition.                                                |
| `GET .../messages/{message_id}/raw`                         | `message_read`                  | Download URL for the original MIME (`message/rfc822`)                                                                             |
| `GET .../messages/{message_id}/attachments/{attachment_id}` | `message_read`                  | Attachment metadata with a download URL                                                                                           |
| `POST .../messages/send`                                    | `message_send`                  | Idempotent. Returns `{ message_id, thread_id }` once queued.                                                                      |
| `POST .../messages/{message_id}/reply`                      | `message_reply`, `message_read` | Idempotent. `reply_all: true` includes the original To and Cc.                                                                    |
| `POST .../messages/{message_id}/reply-all`                  | `message_reply`, `message_read` | Idempotent                                                                                                                        |
| `POST .../messages/{message_id}/forward`                    | `message_send`, `message_read`  | Idempotent. Original attachments are included.                                                                                    |
| `POST .../messages/{message_id}/resolve`                    | Owner                           | `{ "decision": "sent" \| "failed" }`, only for `send_unknown`. Never contacts Cloudflare.                                         |

### Composing

| Field             | Rules                                                                                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `to`, `cc`, `bcc` | A string or a list. 1 to 50 recipients in total.                                                                                                                                                                                                             |
| `reply_to`        | At most one address                                                                                                                                                                                                                                          |
| `subject`         | At most 998 characters, no line breaks. Replies and forwards derive it.                                                                                                                                                                                      |
| `text`, `html`    | At least one is required                                                                                                                                                                                                                                     |
| `attachments`     | Up to 32, each `{ filename?, content_type?, content_disposition?, content_id?, content }` with canonical base64 `content`. Inline attachments need `content_id`. URL attachments return `not_supported`.                                                     |
| `headers`         | Caller headers: `X-*` and `Auto-Submitted` (`no`, `auto-generated`, `auto-replied`); names up to 100 bytes, values 2048 bytes, 16 KiB total and at most 20 non-`X-` headers. `In-Reply-To` and `References` are reserved for threading; replies derive them. |
| `labels`          | Labels to add to the sent message                                                                                                                                                                                                                            |

The whole message, including attachments and encoding overhead, must stay under 5 MiB (`413 payload_too_large`). Before queueing, every recipient must pass the [send and reply lists](/guides/lists) (`403 message_rejected`), the inbox must be active (`403 inbox_paused`), and a transport must be configured (`503 service_unavailable`).

The caller's send policy applies to every sending route: `approval` returns `403 approval_required` with the new draft's ID, and `read_only` returns `403 missing_permission`.

## Drafts

Inbox-scoped routes are `/inboxes/{inbox_id}/drafts/...`; listing and reading also work organization-wide under `/drafts`.

| Route                                                   | Access         | Notes                                                                                                                                                                                                          |
| ------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET .../drafts`                                        | `draft_read`   | Filters: `before`, `after`, `labels`                                                                                                                                                                           |
| `POST /inboxes/{inbox_id}/drafts`                       | `draft_create` | `to`, `cc`, `bcc`, `reply_to` as lists; `subject`, `text`, `html`, `attachments`, `labels`, `in_reply_to`, `forward_of`, `reply_all`, `references`, `send_at`, `client_id`. `send_at` also needs `draft_send`. |
| `GET .../drafts/{draft_id}`                             | `draft_read`   |                                                                                                                                                                                                                |
| `PATCH /inboxes/{inbox_id}/drafts/{draft_id}`           | `draft_update` | Content fields (`null` clears), `add_attachments`, `remove_attachments`, `add_labels`, `remove_labels`, `send_at` (`null` cancels)                                                                             |
| `DELETE /inboxes/{inbox_id}/drafts/{draft_id}`          | `draft_delete` |                                                                                                                                                                                                                |
| `GET .../drafts/{draft_id}/attachments/{attachment_id}` | `draft_read`   |                                                                                                                                                                                                                |
| `POST /inboxes/{inbox_id}/drafts/{draft_id}/send`       | `draft_send`   | Idempotent. Sends now, overriding `send_at`. Body: `add_labels`, `remove_labels`.                                                                                                                              |
| `POST /inboxes/{inbox_id}/drafts/{draft_id}/approve`    | Owner          | Idempotent. Returns `{ message_id, thread_id }`, or the draft if it stays scheduled.                                                                                                                           |
| `POST /inboxes/{inbox_id}/drafts/{draft_id}/reject`     | Owner          | `{ "reason"? }`. Final.                                                                                                                                                                                        |

System state labels are `received`, `queued`, `sent`, `send_unknown`, `failed`, `delivered`, `bounced`, `complained`, `rejected` and `deferred`. Message, thread and batch label edits that touch any of them return `validation_error` atomically; `unread` and custom labels remain editable.

## Downloads

Attachment routes return attachment fields (`attachment_id`, `size` and optional filename, content type, disposition and content ID) alongside `download_url` and `expires_at`; the shared `AttachmentResponse` also declares optional `text_url`, which current handlers do not populate. Raw message routes return `{ download_url, expires_at }`.

The HMAC-signed URL is a five-minute capability: fetch it (`GET /v0/downloads/{token}`) without a bearer header or cookie. Never share, log or publish it. It is bound to the issuing principal and listener origin; local and tunnel URLs cannot cross listeners, and a service restart invalidates them.

Downloads recheck the issuer's activity, current permissions, inbox scope and hidden labels. Revocation or expiry of the issuing API key, OAuth access token or owner session invalidates its URL. OAuth capabilities retain their issuing audience, including `/mcp`. If a bearer is supplied, it must authenticate the issuing principal. An inactive issuer returns `401`; a missing read permission returns `403`; invalid, expired, wrong-origin, hidden or out-of-scope resources return `404`. Files are returned as attachments with `nosniff` and `no-store`.

## Allow and block lists

`{direction}` is `receive`, `send` or `reply`; `{type}` is `allow` or `block`; `{entry}` is the URL-encoded address or domain.

| Route                                                      | Access              |
| ---------------------------------------------------------- | ------------------- |
| `GET /lists/{direction}/{type}`                            | `list_entry_read`   |
| `POST /lists/{direction}/{type}` with `{ entry, reason? }` | `list_entry_create` |
| `GET /lists/{direction}/{type}/{entry}`                    | `list_entry_read`   |
| `DELETE /lists/{direction}/{type}/{entry}`                 | `list_entry_delete` |

The same four routes exist under `/inboxes/{inbox_id}/lists/...` for inbox lists. Global lists additionally require a key without an inbox restriction.

## Webhooks

Organization routes are `/webhooks/...`; inbox routes are `/inboxes/{inbox_id}/webhooks/...`.

| Route                                     | Access           | Notes                                                                                                 |
| ----------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------- |
| `GET .../webhooks`                        | `webhook_read`   |                                                                                                       |
| `POST .../webhooks`                       | `webhook_create` | `url`, `event_types`, `headers`, and `inbox_ids` on organization webhooks. Returns the `secret` once. |
| `GET .../webhooks/{webhook_id}`           | `webhook_read`   | Includes `enabled`, `failure_count`, `disabled_reason`, `last_error_code`, `last_success_at`          |
| `PATCH .../webhooks/{webhook_id}`         | `webhook_update` | `event_types`, `enabled`, and `add_inbox_ids`, `remove_inbox_ids` on organization webhooks            |
| `DELETE .../webhooks/{webhook_id}`        | `webhook_delete` |                                                                                                       |
| `GET .../webhooks/{webhook_id}/headers`   | `webhook_read`   | Header names only                                                                                     |
| `PATCH .../webhooks/{webhook_id}/headers` | `webhook_update` | `{ headers?, remove_headers? }`. Returns `204`.                                                       |

Agents see only webhooks their own key created. See [Webhooks and events](/guides/webhooks).

## Events

`GET /v0/ws` upgrades to a WebSocket. See [Events](/reference/events#websocket). There is no REST route for reading the event log.

## API keys

Owner only.

| Route                           | Notes                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /api-keys`                 |                                                                                                                           |
| `POST /api-keys`                | `permissions` and `send_policy` required; `inbox_id`, `inbox_ids`, `name`, `expires_at` optional. Returns `api_key` once. |
| `GET /api-keys/{api_key_id}`    |                                                                                                                           |
| `PATCH /api-keys/{api_key_id}`  | Only `name`, `permissions`, `send_policy` can change                                                                      |
| `DELETE /api-keys/{api_key_id}` | Revokes immediately                                                                                                       |

`GET`, `POST`, `PATCH` and `DELETE` also exist under `/inboxes/{inbox_id}/api-keys`, where the route fixes `inbox_id`.

## Domains

Owner only. See [Domains](/guides/domains).

| Route                                | Notes                                                      |
| ------------------------------------ | ---------------------------------------------------------- |
| `GET /domains`, `POST /domains`      | Register with `{ domain }`; feature flags are optional     |
| `GET /domains/{domain_id}`           | `status`, `reason`, and `records` with per-record `status` |
| `PATCH /domains/{domain_id}`         | Feature flags                                              |
| `DELETE /domains/{domain_id}`        | Only after teardown                                        |
| `GET /domains/{domain_id}/plan`      | `{ domain, steps, records, warnings }`                     |
| `GET /domains/{domain_id}/zone-file` | BIND text                                                  |
| `POST /domains/{domain_id}/apply`    | Provision or resume                                        |
| `POST /domains/{domain_id}/verify`   | Start a verification check                                 |
| `POST /domains/{domain_id}/teardown` | Remove provisioned resources                               |

## Owner

Quarantine items have `quarantine_id`, `source_kind` (`buffer_object` or `queue_message`), `reason_code`, `first_seen`, `size`, `inbox_id` and `attempts` (nullable when unknown), `last_attempt_at`, and `status`: `quarantined`, `release_pending` or `delete_pending`. Listing never decrypts mail. Quarantine routes need the local owner bearer or an owner browser session with CSRF on `POST` and `DELETE`. Agent keys and OAuth tokens receive `403`, and the tunnel blocks them. Queue items hold metadata only, so retrying one returns `not_supported`. An unknown ID returns `not_found`; missing or mismatched buffer configuration, or retrying an item whose deletion is pending, returns `action_required`; storage or provider failures return `service_unavailable`. Retry `released` means processing and cleanup finished; the receive lists still apply and the mail may have been rejected.

| Route                                                                          | Access            | Notes                                                                                                                                |
| ------------------------------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /owner/status`                                                            | Public            | `{ setup_required, authenticated, locked }`. With a session, returns `X-Inbot-CSRF`.                                                 |
| `POST /owner/setup`                                                            | Public, once      | `{ password, code }`. Password 12 to 1024 characters.                                                                                |
| `POST /owner/login`                                                            | Public            | `{ password }`. Throttled.                                                                                                           |
| `POST /owner/login-links`                                                      | Owner bearer only | Returns `{ url }`, single use, two minutes                                                                                           |
| `POST /owner/login-links/redeem`                                               | Public            | `{ token }`                                                                                                                          |
| `POST /owner/logout`                                                           | Owner             |                                                                                                                                      |
| `GET /owner/sessions`                                                          | Owner             | Session list; `user_agent` is a hash                                                                                                 |
| `DELETE /owner/sessions/{id}`                                                  | Owner             |                                                                                                                                      |
| `POST /owner/password`                                                         | Owner             | `{ current_password, password }`. Signs out other sessions.                                                                          |
| `GET`, `PUT`, `DELETE /owner/transport`                                        | Owner             | See [Mail transport](/guides/transport)                                                                                              |
| `GET /owner/remote`, `POST /owner/remote/enable`, `POST /owner/remote/disable` | Owner             | See [Remote access](/guides/remote-access)                                                                                           |
| `GET /owner/oauth/clients`                                                     | Owner             | OAuth grants                                                                                                                         |
| `DELETE /owner/oauth/grants/{grant_id}`                                        | Owner             |                                                                                                                                      |
| `POST /owner/oauth/clients/purge`                                              | Owner             | `{ deleted_clients }`                                                                                                                |
| `GET /owner/quarantine`                                                        | Owner, local only | Quarantine metadata. Query `limit` (1 to 100, default 20) and `page_token`. Returns `items`, `count`, `limit` and `next_page_token`. |
| `POST /owner/quarantine/{quarantine_id}/retry`                                 | Owner, local only | Returns `{ "status": "released" }`, or `{ "status": "quarantined", "item" }` after another permanent failure                         |
| `DELETE /owner/quarantine/{quarantine_id}`                                     | Owner, local only | Permanently deletes the ciphertext and the record. Repeating it returns 200.                                                         |
| `GET /owner/lists/rejections`                                                  | Owner             | Rejected inbound metadata; `inbox_id` filter                                                                                         |
| `DELETE /owner/lists/rejections/{rejection_id}`                                | Owner             |                                                                                                                                      |

Session setup, login and redeem return `{ csrf_token, expires_at }` and set the session cookie. Browser requests must come from the service's own origin.

## Outside `/v0`

| Path                         | Purpose                                                                   |
| ---------------------------- | ------------------------------------------------------------------------- |
| `/mcp`                       | [MCP](/reference/mcp)                                                     |
| `/oauth/*`, `/.well-known/*` | [OAuth](/agents/oauth)                                                    |
| Everything else              | The owner web app, when served. Unknown API paths return `404 not_found`. |

There is no health, version or OpenAPI route, and no general REST rate limit. Cross-origin browser requests to `/v0` are rejected.
