---
title: Allow and block lists
description: Restrict who each inbox receives from, sends to and replies to with exact addresses or domains, and review the inbound mail that was rejected.
---

Allow and block lists are exact addresses or domains that control mail per direction:

| Direction | Checked against                                                     |
| --------- | ------------------------------------------------------------------- |
| `receive` | The `From` address and the SMTP envelope sender of incoming mail    |
| `send`    | Every `to`, `cc` and `bcc` recipient of sends, replies and forwards |
| `reply`   | Every recipient of replies and reply-alls, in addition to `send`    |

Each direction has an `allow` and a `block` list, both globally and per inbox.

## How rules combine

- Global and inbox entries add together.
- A block always wins.
- If any allow entry exists for a direction, every checked address must match an allow entry.
- An entry is an exact address (`ceo@example.org`) or a domain (`example.org`). Entries are lowercased and matched case-insensitively. There are no wildcards, display names or URLs.

Lists match addresses, and the `From` address is easy to forge. They are a policy tool, not sender authentication. For authentication, see the `unauthenticated` label in [Message states](/concepts/message-states#labels).

## What happens when a rule matches

- **Receive:** the message is not stored. No message, thread or event is created. Inbot keeps a rejection record and deletes the encrypted copy from Cloudflare. Other recipients of the same message are evaluated separately.
- **Send and reply:** the request fails with `message_rejected` before anything is queued. The outbox checks again right before sending, so a rule added later still stops a queued message, which then becomes `failed`.
- Scheduled drafts are checked when they are sent.

## Manage entries

In the web app, use **Settings > Allow and block lists** and pick the scope (Global or an inbox), direction and list type.

```sh
inbot lists create receive block --inbox support@agents.example.com --entry spam.example --reason "Bulk sender"
inbot lists list receive block --inbox support@agents.example.com
inbot lists get receive block spam.example --inbox support@agents.example.com
inbot lists delete receive block spam.example --inbox support@agents.example.com
```

Omit `--inbox` for global lists. A duplicate entry returns `already_exists`.

Agents can manage lists through MCP or REST with `list_entry_read`, `list_entry_create` and `list_entry_delete`. Inbox lists are limited to the key's inbox scope; global lists also require a key with no inbox restriction. Changing lists emits no event.

## Rejected mail

Every inbound rejection leaves owner-only metadata: the time, inbox, sender address and the rules that matched. The subject and body are never kept.

- In the web app: **Settings > Allow and block lists > Rejected mail**, for the selected inbox, or all inboxes with Global.
- From the CLI: `inbot lists rejections [--inbox-id <inbox>]` and `inbot lists delete-rejection <rejection_id>`.

Deleting a rejection record only removes the metadata. It does not accept or recover the mail, which was never stored. Rejection records are not available to agents, over MCP or through the tunnel. Older records may lack sender or rule details, which the web app shows explicitly.
