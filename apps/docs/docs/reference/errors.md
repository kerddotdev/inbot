---
title: Errors and exit codes
description: Every Inbot error code with its HTTP status and meaning, the error body shape shared by REST and MCP, and the stable inbot CLI exit codes.
---

Every REST and MCP error has the same shape:

```json
{
  "name": "InbotError",
  "code": "missing_permission",
  "message": "The API key does not permit this operation.",
  "fix": "Ask the owner for the message_send permission."
}
```

`code` is stable; `message` and `fix` are for people and agents to read. Follow `fix`. OAuth endpoints are the exception: they use the OAuth format, `{ error, error_description }`.

A `401` response also carries `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/...", scope="inbot"`, which OAuth-capable clients use to start authorization.

## Error codes

| Code                   | HTTP | Meaning                                                                                                                                        |
| ---------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `validation_error`     | 400  | Invalid fields, query parameters, JSON or content type; invalid composition; an expired resume ID                                              |
| `unauthorized`         | 401  | Missing, invalid or expired credential; wrong password, setup code or login link                                                               |
| `missing_permission`   | 403  | The grant lacks a permission; an owner-only route; a `read_only` send; a foreign origin or host; missing CSRF; a route blocked over the tunnel |
| `approval_required`    | 403  | The key's send policy is `approval`. A pending draft was created; its ID is in `message` and `fix`.                                            |
| `message_rejected`     | 403  | A recipient is refused by the send or reply lists, or the draft was rejected by the owner. Nothing was queued.                                 |
| `inbox_paused`         | 403  | The inbox is paused                                                                                                                            |
| `not_found`            | 404  | The resource does not exist, is outside the grant's scope, or carries a hidden label the grant cannot read                                     |
| `already_exists`       | 409  | Duplicate inbox address, list entry, or owner account                                                                                          |
| `resource_taken`       | 409  | The draft is being sent, or a Cloudflare resource belongs to someone else                                                                      |
| `idempotency_conflict` | 409  | The idempotency key was used with a different payload                                                                                          |
| `page_token_stale`     | 409  | The page token does not match the query; restart without it                                                                                    |
| `action_required`      | 409  | The owner must act first, for example choose an account, tear down a domain, or fix DNS                                                        |
| `payload_too_large`    | 413  | The message exceeds 5 MiB, or an inbound message exceeds 25 MiB                                                                                |
| `locked`               | 423  | The database is locked. The current service only serves after unlocking, so this is not returned in practice.                                  |
| `rate_limit_exceeded`  | 429  | Too many password attempts or pending login links                                                                                              |
| `not_supported`        | 501  | URL attachments, OAuth consent without the web app, or another unsupported option                                                              |
| `service_unavailable`  | 503  | Storage failure, unexpected error, or no mail transport configured                                                                             |

The contract also declares `permission_escalation`, `limit_exceeded` and `domain_not_verified` (403). The first two are not currently returned. `domain_not_verified` can appear as a failed message's `send_reason` when Cloudflare refuses the sender, rather than as a response to the send request.

## CLI exit codes

| Exit | Meaning                                                                            |
| ---- | ---------------------------------------------------------------------------------- |
| 0    | Success, or help                                                                   |
| 1    | Unexpected local failure, including failing to open a browser                      |
| 2    | Invalid arguments or payload; HTTP 400 or 413                                      |
| 3    | HTTP 401                                                                           |
| 4    | HTTP 403, including `approval_required` and `message_rejected`                     |
| 5    | HTTP 404                                                                           |
| 6    | HTTP 409                                                                           |
| 7    | HTTP 423                                                                           |
| 8    | HTTP 429                                                                           |
| 9    | HTTP 501                                                                           |
| 10   | Connection or response failure, HTTP 503, any other status, or a lost event stream |

Errors print to stderr as one JSON line. Server errors keep their original fields; local errors print `{ code, message, fix }` without credentials or payload contents. `inbot serve` exits with 0 after a clean stop and 1 when startup fails.
