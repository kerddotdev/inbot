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

Errors may also carry an optional `docs` link; the contract permits an omitted `fix`, while service errors provide an actionable fix.

`code` is stable; `message` and `fix` are for people and agents to read. Follow `fix`. OAuth endpoints are the exception: they use the OAuth format, `{ error, error_description }`.

A `401` response also carries `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/...", scope="inbot"`, which OAuth-capable clients use to start authorization.

## Error codes

| Code                   | HTTP | Meaning                                                                                                                                                                                                                                                                |
| ---------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validation_error`     | 400  | Invalid fields, query parameters, JSON or content type; invalid composition; an expired resume ID; unsatisfiable password rules; a credential without origins; a missing page or non-editable element in the browser                                                   |
| `unauthorized`         | 401  | Missing, invalid or expired credential; wrong password, setup code or login link                                                                                                                                                                                       |
| `missing_permission`   | 403  | The grant lacks a permission; an owner-only route; a `read_only` send; a foreign origin or host; missing CSRF; a route blocked over the tunnel; a rejected credential use; a page origin that does not match the credential; a remote CDP host that is not allowlisted |
| `approval_required`    | 403  | The key's send policy is `approval` and a pending draft was created (its ID is in `message` and `fix`), or the key's credential `use_policy` is `approval` and the use awaits the owner (the request ID is in `message` and `fix`).                                    |
| `message_rejected`     | 403  | A recipient is refused by the send or reply lists, or the draft was rejected by the owner. Nothing was queued.                                                                                                                                                         |
| `inbox_paused`         | 403  | The inbox is paused                                                                                                                                                                                                                                                    |
| `not_found`            | 404  | The resource does not exist, is outside the grant's scope, or carries a hidden label the grant cannot read                                                                                                                                                             |
| `already_exists`       | 409  | Duplicate inbox address, list entry, or owner account                                                                                                                                                                                                                  |
| `resource_taken`       | 409  | The draft is being sent, or a Cloudflare resource belongs to someone else                                                                                                                                                                                              |
| `idempotency_conflict` | 409  | The idempotency key was used with a different payload                                                                                                                                                                                                                  |
| `page_token_stale`     | 409  | The page token does not match the query; restart without it                                                                                                                                                                                                            |
| `action_required`      | 409  | The owner must act first, for example choose an account, tear down a domain, fix DNS, or restore the buffer configuration before a quarantine retry or delete                                                                                                          |
| `payload_too_large`    | 413  | The composed outbound message exceeds 5 MiB                                                                                                                                                                                                                            |
| `locked`               | 423  | The database is locked. The current service only serves after unlocking, so this is not returned in practice.                                                                                                                                                          |
| `rate_limit_exceeded`  | 429  | Too many password attempts or pending login links                                                                                                                                                                                                                      |
| `not_supported`        | 501  | URL attachments, OAuth consent without the web app, retrying a quarantined Queue item, a local service install from a source checkout, or another unsupported option                                                                                                   |
| `service_unavailable`  | 503  | Storage failure, unexpected error, no mail transport configured, or an unreachable, timed-out or invalid CDP browser connection                                                                                                                                        |

### Credential vault errors

The vault adds no error codes. Browser and approval failures use the existing ones, and the `fix` says what to change:

| Situation                                                                                          | Code                   |
| -------------------------------------------------------------------------------------------------- | ---------------------- |
| First fill or resolve under `use_policy: approval`                                                 | `approval_required`    |
| Same idempotency key with a different fill target, selector, field or refs                         | `idempotency_conflict` |
| The owner rejected the use                                                                         | `missing_permission`   |
| Retrying an expired, consumed or already decided request, or deciding it the other way             | `validation_error`     |
| The main-frame origin is not one of the credential's origins (the error names the observed origin) | `missing_permission`   |
| The credential has no URL or origins                                                               | `validation_error`     |
| No matching page, no matching element, or an element that cannot be edited                         | `validation_error`     |
| The CDP endpoint cannot be reached, times out or answers incorrectly                               | `service_unavailable`  |
| A tunnel request to a non-allowlisted host, an HTTP or WS endpoint, or a non-public address        | `missing_permission`   |
| Missing `credential_*` permission, `inbot run` over the tunnel or a non-loopback URL               | `missing_permission`   |
| A credential, request or reference outside the key's inbox scope                                   | `not_found`            |

Errors never echo captured values, endpoint credentials or protocol messages from the browser.

The inbound 25 MiB limit is an SMTP rejection or a quarantine reason, not an API `413` response.

The contract also declares `permission_escalation`, `limit_exceeded` and `domain_not_verified` (403). The first two are not currently returned. `domain_not_verified` can appear as a failed message's `send_reason` when Cloudflare refuses the sender, rather than as a response to the send request.

## CLI exit codes

| Exit | Meaning                                                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------- |
| 0    | Success, or help                                                                                                        |
| 1    | Unexpected local failure, including failing to open a browser                                                           |
| 2    | Invalid arguments or payload; HTTP 400 or 413; binary download output to a terminal                                     |
| 3    | HTTP 401                                                                                                                |
| 4    | HTTP 403, including `approval_required` and `message_rejected`; `inbot service` with `INBOT_URL` or `INBOT_API_KEY` set |
| 5    | HTTP 404                                                                                                                |
| 6    | HTTP 409                                                                                                                |
| 7    | HTTP 423                                                                                                                |
| 8    | HTTP 429                                                                                                                |
| 9    | HTTP 501                                                                                                                |
| 10   | Connection or response failure, HTTP 503, any other status, or a lost event stream                                      |

Errors print to stderr as one JSON line. Server errors keep their original fields; local errors print `{ code, message, fix }` without credentials or payload contents. `inbot serve` exits with 0 after a clean stop and 1 when startup fails.
