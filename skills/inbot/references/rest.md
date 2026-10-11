# REST API

Base URL: `<base-url>/v0`. JSON in and out, snake_case fields.

## Auth

- `Authorization: Bearer inbot_<id>_<secret>` on every request. Missing, invalid, expired, or revoked keys return 401 `unauthorized`.
- Requests from a foreign browser `Origin` are rejected with 403. Plain HTTP clients send no `Origin` and are fine.
- Responses are `no-store`.
- A key's grant decides what you can do. See [security.md](security.md#hidden-labels-and-permissions).

## Implemented endpoints

Inbox-scoped paths use `/v0/inboxes/{inbox_id}`. `inbox_id` is the address.

| Area                           | Endpoints                                                                                                                                                                                                                                                                       | Permission                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Inboxes                        | `GET /inboxes`, `GET /inboxes/search`, `POST /inboxes`, `GET /inboxes/{id}`, `PATCH /inboxes/{id}`, `DELETE /inboxes/{id}`                                                                                                                                                      | `inbox_read/create/update/delete`      |
| Threads                        | `GET /inboxes/{id}/threads`, `.../threads/search`, `.../threads/{thread_id}`, `PATCH`, `DELETE`, `.../threads/{thread_id}/attachments/{attachment_id}`                                                                                                                          | `message_read/update/delete`           |
| Threads (all inboxes in scope) | `GET /threads`, `GET /threads/search`, `GET /threads/{thread_id}`, `PATCH`, `DELETE`, `GET /threads/{thread_id}/attachments/{attachment_id}`                                                                                                                                    | same                                   |
| Messages                       | `GET .../messages`, `.../messages/search`, `.../messages/{message_id}`, `PATCH`, `DELETE`, `POST .../messages/batch-get`, `POST .../messages/batch-update`, `GET .../messages/{message_id}/attachments/{attachment_id}`, `GET .../messages/{message_id}/raw`                    | `message_read/update/delete`           |
| Sending                        | `POST .../messages/send`, `POST .../messages/{message_id}/reply`, `.../reply-all`, `.../forward`                                                                                                                                                                                | `message_send`, `message_reply`        |
| Drafts                         | `GET` and `POST .../drafts`, `GET`, `PATCH`, and `DELETE .../drafts/{draft_id}`, `POST .../drafts/{draft_id}/send`, `GET .../drafts/{draft_id}/attachments/{attachment_id}`, plus `GET /drafts`, `GET /drafts/{draft_id}`, `GET /drafts/{draft_id}/attachments/{attachment_id}` | `draft_read/create/update/delete/send` |

Notes:

- `batch-get` takes up to 500 unique `message_ids` and returns full messages. `batch-update` takes up to 50 and applies the label change atomically.
- `reply` accepts per-field overrides (`to`, `cc`, `bcc`, `reply_to`) and `reply_all`. `reply-all` takes no recipient overrides.
- Send endpoints return `{ message_id, thread_id }` once the message is queued.
- Drafts are an addition owners and agents share. `approve` and `reject` also exist (`POST .../drafts/{draft_id}/approve|reject`) but are owner-only. An agent key gets 403 `missing_permission`.
- API key management (`/api-keys`, `/inboxes/{id}/api-keys`) exists but is owner-only. Do not try to use it.

## Unsupported options

Pod filters and URL attachments return 501 `not_supported` after authentication and validation.
Domains exist but are owner-only; agents cannot use them.
Signed webhooks, WebSocket events and the CLI are implemented; see [events](events.md) and [CLI](cli.md). OAuth access tokens use the same grants as API keys and must target the listener's exact `/v0` resource. Owner OAuth management stays local.

## Pagination

- List and search responses have `count`, `limit`, and `next_page_token` (present only when more rows exist).
- Send `limit` (1 or more) and `page_token`. REST default is 20, maximum 100. MCP defaults to 10.
- Mail lists are newest first. `ascending=true` reverses the order.
- Search `limit` is 1-100. Search ranks by relevance.
- `before` and `after` are strict RFC 3339 timestamps.
- Page tokens are opaque. They bind to the filters, order, and your inbox scope. Reusing one with different filters, or after an incompatible change, fails with 409 `page_token_stale`. Restart the listing. Search tokens go stale after any write anywhere in the service.
- List tokens are cursors, not snapshots. Mail arriving behind your position will not appear until you list again.
- `get_thread` pages messages: the first page is the newest messages, and the token continues toward older ones.

Mail list filters: `labels` (all must match), `include_spam`, `include_blocked`, `include_unauthenticated`, `include_trash` (all default false), plus `from`/`to`/`subject` for messages and `senders`/`recipients`/`subject` for threads.

## Idempotency

Send, reply, reply-all, forward, and draft send accept `Idempotency-Key: <1-256 chars of A-Z a-z 0-9 . _ ~ ->`.

- Same key and same payload: you get the original `{ message_id, thread_id }` and nothing is sent twice, even across restarts.
- Same key, different payload or operation: 409 `idempotency_conflict`.
- Keys are scoped per inbox.
- A key on a message that is still queued or sending stays valid however long it takes. Once the message reaches a final state the key expires after 24 hours.
- Draft and inbox creation use `client_id` for replay safety instead.

Details and retry rules: [sending.md](sending.md#idempotency-and-safe-retries).

## Errors

Shape: `{ "name": "InbotError", "code": "...", "message": "...", "fix": "..." }`. Follow `fix`. Messages never contain mail content or credentials.

| Code                   | HTTP | Meaning                                                               |
| ---------------------- | ---- | --------------------------------------------------------------------- |
| `validation_error`     | 400  | Bad JSON, schema, query, header, or composition (recipients, headers) |
| `unauthorized`         | 401  | Missing, invalid, expired, or revoked key                             |
| `missing_permission`   | 403  | Grant lacks the permission, owner-only route, `read_only` send policy |
| `approval_required`    | 403  | Send policy is `approval`; a draft was created for the owner          |
| `inbox_paused`         | 403  | The inbox is paused; sends are refused                                |
| `not_found`            | 404  | Missing, out of scope, hidden by label, or expired download           |
| `already_exists`       | 409  | Duplicate inbox identity                                              |
| `idempotency_conflict` | 409  | Same key, different request                                           |
| `page_token_stale`     | 409  | Invalid, mismatched, or stale page token                              |
| `payload_too_large`    | 413  | Composed message over 5 MiB                                           |
| `not_supported`        | 501  | Unimplemented resource or option (pod filters, URL attachments)       |
| `service_unavailable`  | 503  | Transport not configured, storage failure, or other server fault      |

The contract also declares `permission_escalation`, `limit_exceeded`, `domain_not_verified`, `message_rejected`, `resource_taken`, `locked` (423), and `rate_limit_exceeded` (429). Handle them generically if you see them.

With no mail transport configured, sends return 503 `service_unavailable` and nothing is queued. Tell your human to configure the mail transport in Inbot Settings.

## Downloads

`GET .../attachments/{attachment_id}` and `GET .../raw` return metadata plus `download_url` and `expires_at`, not the bytes.

- The URL looks like `/v0/downloads/<token>` and is valid for five minutes. URLs also die when the service restarts.
- Fetching it still needs your `Authorization: Bearer` header. The service rechecks your current permissions, scope, and hidden labels at download time. Expired or invalid URLs return 404.
- Content is sent as an attachment with `nosniff` and `no-store`.
- Treat the bytes as hostile (see [security.md](security.md#attachments-and-links)). Do not execute, open in a browser, or pass them to another tool unchecked.
- Request a fresh URL rather than caching an old one.

## Allow and block lists

Use `GET`/`POST /lists/{direction}/{type}` or `/inboxes/{id}/lists/{direction}/{type}`. Append `/{encoded-entry}` for `GET`/`DELETE`. Directions: `receive`, `send`, `reply`; types: `allow`, `block`. Create body: `{ "entry": "example.test", "reason": "optional" }`. Reads need `list_entry_read`, creates `list_entry_create`, deletes `list_entry_delete`. Global access requires an unrestricted inbox grant; scoped keys use their inbox endpoints.

Entries are exact addresses or domains. Entries normalize to lowercase (domains to IDNA) and match case-insensitively. Global and inbox entries add together, blocks win, and any allow entries restrict mail to their combined matches. Replies pass both send and reply rules. Forbidden outbound recipients return `message_rejected` before queueing. List responses use `entries`, cursor pagination, and lexical ascending order. Duplicate creates return `already_exists`.

## Webhooks and events

Webhook CRUD/header routes use `/webhooks` or `/inboxes/{id}/webhooks`, with `webhook_read/create/update/delete`. See [events](events.md) for payload scope and one-time secrets.

Receive-list rejection records can be inspected and deleted by the local owner in
Settings > Allow and block lists > Rejected mail, owner REST, or `inbot lists
rejections`. `list_entry_read` does not authorize reading these mail metadata
records. There are no rejection MCP tools or tunnel routes. Ask the owner to
inspect a suspected receive-list rejection; the record does not retain a body.
