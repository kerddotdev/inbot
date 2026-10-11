---
title: Permissions
description: The 25 grant permissions, inbox scope rules, hidden-label permissions, send policies and owner-only capabilities.
---

A grant is `{ inbox_id?, inbox_ids?, permissions, send_policy }`. It belongs to an API key or an OAuth authorization, and the service reads the current grant on every request. Permissions are explicit: anything not set to `true` is denied, and unknown permission names are rejected.

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
- OAuth client and grant management
- `domain.verified` and `oauth.*` events

The owner always sends directly, regardless of any policy.
