---
title: Permissions
description: The 33 grant permissions, inbox scope rules, hidden-label permissions, send and credential use policies and owner-only capabilities.
---

A grant is `{ inbox_id?, inbox_ids?, permissions, send_policy, use_policy }`. It belongs to an API key or an OAuth authorization, and the service reads the current grant on every request. Permissions are explicit: anything not set to `true` is denied, and unknown permission names are rejected.

## Permission list

| Permission                   | Allows                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `inbox_read`                 | List, search and read inboxes in scope                                                        |
| `inbox_create`               | Create inboxes whose address is in scope                                                      |
| `inbox_update`               | Change display name, status and metadata                                                      |
| `inbox_delete`               | Delete inboxes and everything in them                                                         |
| `message_read`               | List, search and read threads, messages, attachments and raw messages; receive message events |
| `message_reply`              | Reply and reply-all (also needs `message_read`)                                               |
| `message_send`               | Send new messages and forward (forwarding also needs `message_read`)                          |
| `message_update`             | Add and remove labels on messages and threads                                                 |
| `message_delete`             | Delete messages and threads                                                                   |
| `label_spam_read`            | See mail labeled `spam`                                                                       |
| `label_blocked_read`         | See mail labeled `blocked`                                                                    |
| `label_unauthenticated_read` | See mail labeled `unauthenticated`                                                            |
| `label_trash_read`           | See mail labeled `trash`                                                                      |
| `draft_read`                 | List and read drafts and their attachments; receive draft events                              |
| `draft_create`               | Create drafts                                                                                 |
| `draft_update`               | Edit drafts                                                                                   |
| `draft_delete`               | Delete drafts                                                                                 |
| `draft_send`                 | Send drafts and set `send_at`                                                                 |
| `list_entry_read`            | Read allow and block list entries                                                             |
| `list_entry_create`          | Add list entries                                                                              |
| `list_entry_delete`          | Remove list entries                                                                           |
| `webhook_read`               | Read the webhooks this key created                                                            |
| `webhook_create`             | Create webhooks. Losing it disables the key's webhooks.                                       |
| `webhook_update`             | Update the key's webhooks and their headers                                                   |
| `webhook_delete`             | Delete the key's webhooks                                                                     |
| `credential_read`            | List and read credential metadata and references; receive credential events                   |
| `credential_create`          | Create credentials, including generated passwords                                             |
| `credential_update`          | Update credentials and generate passwords into existing fields                                |
| `credential_delete`          | Delete credentials                                                                            |
| `credential_totp`            | Read the current TOTP code of a credential                                                    |
| `credential_fill`            | Fill and capture credential fields in a browser over CDP                                      |
| `credential_run`             | Resolve references for `inbot run` (local CLI only, no MCP tool)                              |
| `credential_request`         | Ask the owner for credential values and read the key's own requests                           |

## Inbox scope

| Grant         | Scope                                     |
| ------------- | ----------------------------------------- |
| Neither field | All inboxes, including ones created later |
| `inbox_id`    | That inbox                                |
| `inbox_ids`   | Those inboxes; `[]` means none            |
| Both          | Their intersection                        |

Scope is checked before permissions, and anything out of scope returns `not_found`. Global allow and block lists need a grant with neither field. Scope and expiry cannot change after creation.

## Send policies

| Policy      | Send, reply, forward, draft send                                | Scheduling (`send_at`)      |
| ----------- | --------------------------------------------------------------- | --------------------------- |
| `direct`    | Queued                                                          | Allowed                     |
| `approval`  | A pending draft is created; `403 approval_required` with its ID | Allowed; waits for approval |
| `read_only` | `403 missing_permission`                                        | `403 missing_permission`    |

Send policies only add restrictions: the sending permissions are still required.

## Owner-only capabilities

No permission grants these. They require the owner's bearer token or browser session:

- Domains, API keys and the mail transport
- Remote access
- Owner setup, sign-in, sessions, password and login links
- Draft approval and rejection
- Resolving `send_unknown`
- Rejected mail records
- Inbound quarantine: list, retry and delete (local only, not available through the tunnel)
- OAuth client and grant management
- Revealing credential values (`GET .../credentials/{credential_id}/fields`), Bitwarden import and export, and the browser host allowlist (`/v0/owner/vault/settings`)
- Listing and deciding credential use requests, and fulfilling or declining credential requests
- `domain.verified`, `inbound.*` and `oauth.*` events

Owner sign-in, session/password management, draft approval, credential use decisions, declining credential requests and OAuth consent are reachable through the tunnel with a browser session. Revealing credentials, import, export, request fulfillment, `inbot run` resolution and the browser host allowlist stay local. Domains, keys, transport, remote configuration, login links, rejected-mail records, quarantine, OAuth management and unknown-send resolution remain local. Local owner bearer tokens never work over the tunnel.

## Credential permissions

Credentials belong to an inbox, so inbox scope applies to every credential operation, and anything out of scope returns `not_found`. Any key with the permission and the scope can use a credential in that inbox, whoever created it. Mail send policy does not affect credential permissions. See the [credential vault](/guides/vault).

| Operation                                 | Permission           |
| ----------------------------------------- | -------------------- |
| List and get metadata                     | `credential_read`    |
| Create (with optional generated password) | `credential_create`  |
| Update, `generate`                        | `credential_update`  |
| Delete                                    | `credential_delete`  |
| Read a TOTP code                          | `credential_totp`    |
| Fill or capture over CDP                  | `credential_fill`    |
| `inbot run` resolution                    | `credential_run`     |
| Create, read and list credential requests | `credential_request` |

A fulfilled request exposes the new credential's metadata and references to the requesting key without `credential_read`. Using a reference still needs the permission for that use.

Credential events reach webhooks and WebSocket clients with `credential_read` and inbox scope. Request events need `credential_request`, inbox scope and the requesting key.

### Use policy

`use_policy` is independent of `send_policy`. It applies to browser fill and `inbot run` resolution, the two operations that put a value to use.

| Policy     | Fill and `inbot run`                                                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approval` | The default for new and migrated keys and OAuth grants. The first call returns `403 approval_required` and waits for the owner. An `Idempotency-Key` is required. |
| `direct`   | Proceeds immediately                                                                                                                                              |

Capture, metadata changes, password generation and TOTP codes are not gated by `use_policy`. The owner is never gated.

The owner always sends directly, regardless of any policy.
