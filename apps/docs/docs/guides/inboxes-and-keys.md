---
title: Inboxes and API keys
description: Create, pause and delete inboxes, issue scoped API keys, choose permissions and send policies, and manage OAuth grants.
---

## Inboxes

An inbox is one address. Its `inbox_id` is the address itself, such as `support@agents.example.com`.

```sh
inbot inboxes create --username support --domain agents.example.com --display-name "Support"
inbot inboxes list
inbot inboxes get support@agents.example.com
inbot inboxes update support@agents.example.com --display-name "Support" --status paused
inbot inboxes delete support@agents.example.com
```

In Mail, use **New inbox** in the sidebar to create an address and **Manage inbox** to edit the display name, pause, resume or delete it. The CLI supports create, list, search, get, update and delete. `inbot inboxes update` takes `--display-name`, `--status active|paused` and `--metadata`; use `--data` with JSON to remove metadata keys. REST `PATCH /v0/inboxes/{inbox_id}` and MCP `update_inbox` do the same.

| Field          | Rules                                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `username`     | Lowercased local part, at most 64 characters, no leading, trailing or doubled dots. Omit it for 16 random hex characters.                                                      |
| `domain`       | Required. Use your [provisioned domain](/guides/domains); inbox creation does not validate provisioning. Receiving needs its Worker and routing rule; verify the domain first. |
| `display_name` | Optional sender name                                                                                                                                                           |
| `status`       | `active` (default) or `paused`                                                                                                                                                 |
| `metadata`     | Optional object of up to 256 string, number or boolean values. On update, a `null` value removes a key; `metadata: null` clears all metadata.                                  |
| `client_id`    | Optional idempotency token. Creating again with the same `client_id` returns the existing inbox.                                                                               |

A duplicate address returns `already_exists`. `inbot-selftest` is reserved on registered domains.

**Pausing** an inbox (`PATCH /v0/inboxes/{inbox_id}` with `"status": "paused"`) skips incoming mail for it without storing or bouncing, and refuses new sends with `inbox_paused`.

**Deleting** an inbox is permanent and immediate. It removes its threads, messages, drafts, list entries and rejection records, and its routing rule is removed in the background. Mail sent to the address afterwards is no longer routed to Inbot.

## API keys

An API key gives one agent a fixed [grant](/get-started/concepts#people-and-credentials): which inboxes it can see, what it may do, and how its mail is sent. Only the owner can create, change or revoke keys, from the **API keys** page, `inbot api-keys`, or `/v0/api-keys`.

```sh
inbot api-keys create --name triage --inbox-id support@agents.example.com \
  --permissions '{"inbox_read":true,"message_read":true,"message_update":true}' \
  --send-policy read_only --show-secret --json
```

The secret (`inbot_<id>_<secret>`) is returned once. The CLI prints it only with `--show-secret`, and the web app shows it once after creation. Inbot stores only a hash, so a lost key cannot be recovered: revoke it and create a new one.

Read one key's metadata with `inbot api-keys get <api_key_id>`; it never returns the secret. Edit a key in the web app, with `PATCH /v0/api-keys/{api_key_id}`, or with `inbot api-keys update <api_key_id> --name triage --send-policy approval`. Editing changes its name, permissions or send policy without rotating the secret. Omitted fields stay unchanged; a supplied permissions object replaces the existing set.

### Choose the inbox scope

| Grant                        | The key can use                              |
| ---------------------------- | -------------------------------------------- |
| No `inbox_id` or `inbox_ids` | Every inbox, including inboxes created later |
| `inbox_id`                   | Exactly that inbox                           |
| `inbox_ids`                  | Those inboxes; an empty list means none      |

Anything outside the scope returns `not_found`, exactly like something that does not exist, so an agent cannot discover other inboxes. Inbox scope and expiry are fixed when the key is created. You can later change only its name, permissions and send policy.

### Choose permissions

New API key and OAuth consent forms default to **Full access** with **Approval**, with no inboxes selected. Full access grants inbox reading, mail reading/updating/replying/sending, and draft reading/creating/updating/deleting/sending; it does not grant owner administration, inbox management, hidden-label access, list or webhook management.

**Read only** grants inbox, message and draft reads and selects the read-only policy. **Read and draft** adds draft create, update and delete. Expand **Choose individual permissions** for a custom set. These are web form defaults, not implicit API permissions: CLI and REST callers must supply their own permission set.

Grant only what the agent needs. Common sets:

| Agent role          | Permissions                                                                     | Send policy |
| ------------------- | ------------------------------------------------------------------------------- | ----------- |
| Reads and triages   | `inbox_read`, `message_read`, `message_update`                                  | `read_only` |
| Answers with review | `inbox_read`, `message_read`, `message_reply`, `message_update`, `draft_read`   | `approval`  |
| Sends on its own    | `inbox_read`, `message_read`, `message_send`, `message_reply`, `message_update` | `direct`    |

[Permissions](/reference/permissions) lists all 25 permissions and what each route requires.

### Choose a send policy

| Policy      | Effect                                                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `direct`    | Sends are queued immediately.                                                                                                                                    |
| `approval`  | Every send, reply, forward or draft send becomes a pending draft and returns `approval_required`. Nothing leaves until you approve it on the **Approvals** page. |
| `read_only` | Sending and scheduling are refused with `missing_permission`. Drafts can still be written if granted.                                                            |

The policy is enforced by the service on every surface. An agent cannot talk its way past it, and nothing in an email can change it.

### Expiry and revocation

Set `expires_at` at creation for temporary access using CLI `--expires-at` or REST. The web key form has no expiry field. Expiry cannot be changed later. Revoking a key (`inbot api-keys revoke <api_key_id>`) takes effect on the next request; open WebSocket streams close, and webhooks the key created are disabled with `credential_revoked`. The key list shows when each key was last used, updated at most once a minute.

## OAuth grants

MCP clients that support OAuth can connect without an API key. You approve each client in the browser and choose its grant with the same editor as for API keys. See [OAuth for MCP clients](/agents/oauth).

Approved clients are listed under **Authorized OAuth clients** on the API keys page:

```sh
inbot oauth clients                 # list grants and their clients
inbot oauth revoke <grant_id>       # revoke a grant and all of its tokens
inbot oauth purge                   # delete client registrations that never got a grant
```
