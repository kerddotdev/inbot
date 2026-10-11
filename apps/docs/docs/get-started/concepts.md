---
title: Concepts
description: The words Inbot uses for people, credentials, mail resources and infrastructure, such as owner, agent, grant, inbox and buffer.
---

## People and credentials

**Owner.** The one person who runs an Inbot instance. The owner controls domains, the mail transport, API keys, remote access and approvals. The owner signs in to the web app with a password, and the `inbot` CLI on the same machine acts as the owner by reading the home's `connection.json`.

**Agent.** An AI agent that uses Inbot through MCP, the CLI or REST. An agent authenticates with an API key or an OAuth access token, and only ever sees what its grant allows.

**API key.** A credential of the form `inbot_<id>_<secret>`. The secret is shown once, when the owner creates the key; Inbot stores only a hash. Keys can expire, and the owner can revoke them at any time.

**Grant.** What a credential may do. Every API key and every OAuth authorization has one, made of three parts:

| Part        | Meaning                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| Inbox scope | `inbox_id` or `inbox_ids`. Omitted means every inbox; an empty list means none.                              |
| Permissions | An explicit list such as `message_read` or `message_reply`. Anything not granted is denied.                  |
| Send policy | `direct` sends immediately, `approval` turns every send into a draft for the owner, `read_only` never sends. |

Resources outside a grant's inbox scope behave as if they do not exist: they return `not_found`. See [Permissions](/reference/permissions) for the full list.

## Mail resources

**Inbox.** One agent address, such as `support@agents.example.com`. Its `inbox_id` is the address itself. An inbox can be `active` or `paused`; a paused inbox skips incoming mail and holds outgoing mail.

**Thread.** A conversation. Inbot builds threads from the `Message-ID`, `In-Reply-To` and `References` headers inside one inbox. The subject line never joins threads.

**Message.** One email, received or sent. Received messages include the original `text` and `html`, and an `extracted_text` with quoted history and signatures removed, which is usually what an agent should read first.

**Draft.** An unsent message. Drafts can be scheduled with `send_at`, and drafts created under the `approval` policy wait for the owner to approve or reject them.

**Label.** A free-form string on a message. Inbot sets some labels itself, such as `unread`, `sent`, `delivered` and `unauthenticated`; agents and the owner add their own. A thread's labels are the union of its messages' labels. See [Message states](/concepts/message-states).

**Allow and block lists.** Exact addresses or domains that restrict who an inbox may receive from, send to, or reply to. See [Allow and block lists](/guides/lists).

## Infrastructure

**Home.** The service's data directory: the encrypted database, the wrapped key and the connection file. It defaults to `~/.inbot` for installed packages and `~/.inbot-dev` for source checkouts.

**Transport.** The mail provider adapter. Cloudflare, using Email Routing for inbound and Email Service for outbound, is the only transport today.

**Domain.** A subdomain you dedicate to agent mail, such as `agents.example.com`, with the Cloudflare resources and DNS records Inbot provisions for it. One instance manages one subdomain, never your zone's apex.

**Buffer.** Where inbound mail waits while your machine is offline: an R2 bucket holding encrypted messages, plus a Queue of pointers to them.

**Envelope.** One inbound message encrypted with [age](https://age-encryption.org) to your instance's public key, together with its SMTP sender and recipient.

**DEK and KEK.** The DEK is the random key that encrypts the database. A KEK wraps the DEK; today it is kept in the OS keychain.

**Tunnel.** The optional named Cloudflare Tunnel that lets agents in the cloud reach selected agent routes on your machine. See [Remote access](/guides/remote-access).

**Event.** A durable record of a state change, such as `message.received` or `draft.approval_required`, delivered over WebSocket or signed webhooks. See [Events](/reference/events).
