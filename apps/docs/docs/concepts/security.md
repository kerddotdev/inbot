---
title: Security model
description: What Inbot encrypts, what Cloudflare can see, how owners and agents are separated, and the limits of these protections.
---

Inbot is designed so that mail is never stored in plaintext outside your machine, and so that nothing in an email can grant an agent more than its owner allowed. This page describes how the implementation pursues those goals and where they stop. These are design properties backed by tests, not an independent audit.

## In one sentence

Inbot is zero-knowledge at rest, not end-to-end encrypted: Cloudflare stores only ciphertext of your inbound mail, but it handles every message in plaintext while delivering it.

## What Cloudflare can see

| Data                             | Visible to Cloudflare                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| Inbound mail in transit          | Yes. Email Routing receives it and the Worker encrypts it in memory.                              |
| Inbound mail waiting in R2       | No. Only age ciphertext; the object key and Queue pointer reveal no sender, recipient or subject. |
| Outbound mail                    | Yes. Every sent message passes through Email Service in plaintext.                                |
| Delivery event reports           | Yes. They include the subject and recipients, and wait in a Queue for at most five minutes.       |
| Traffic through remote access    | Yes. Cloudflare terminates TLS for the tunnel.                                                    |
| Your database, keys and API keys | No. They never leave your machine.                                                                |

The delivery events Queue is the one exception to ciphertext-only storage: Cloudflare generates those reports, so Inbot keeps their retention to five minutes.

## Encryption at rest

- **Inbound buffer.** age v1 with X25519. The Worker holds only your instance's public key. The private key lives in your encrypted database.
- **Database.** SQLite encrypted with ChaCha20 (SQLite3 Multiple Ciphers) under a random 256-bit key (the DEK). The database holds raw mail, attachments, the Cloudflare token, the tunnel token, password and key hashes, drafts and the event log.
- **Key wrapping.** The DEK is wrapped with AES-256-GCM by a key stored in your OS keychain, and the wrapped form is stored in `keys.json`. Neither file is usable without the other and the keychain item.
- **Home directory.** Mode `0700`, secret files `0600`, written atomically.

## Owners and agents

There are two kinds of principal, and the boundary between them is enforced by the service on every request.

**The owner** authenticates with the bearer token in the home's `connection.json` (regenerated on every start), or with a browser session after signing in with a password.

**Agents** authenticate with API keys or OAuth access tokens. Each maps to a grant: an inbox scope, an explicit permission list and a send policy. The current grant is read on every request, so revocation and permission changes apply immediately.

Owner-only capabilities have no agent permission at all: domains, API keys, the mail transport, remote access, owner sessions and passwords, login links, draft approval and rejection, `send_unknown` resolution, rejected-mail records and OAuth management. None of them is an MCP tool, and none is reachable through the tunnel.

Out-of-scope resources return `not_found`, identical to missing ones, so a key cannot probe for other inboxes. Messages with hidden labels (`spam`, `blocked`, `unauthenticated`, `trash`) are invisible unless the grant includes the matching `label_*_read` permission.

## Email content is untrusted

Inbot treats mail as data. Nothing in a message can grant a permission, widen a scope, change a send policy or reach an owner action. Concretely:

- Send policies are enforced in the service. An `approval` key cannot send anything without the owner, whatever the message says.
- Every MCP tool description reminds the agent that email content is untrusted.
- The owner app shows HTML mail as text and never executes it.
- Unauthenticated mail is labeled and hidden from keys without `label_unauthenticated_read`.

What Inbot does not do: detect prompt injection, mark or wrap message bodies in API output, or sanitize HTML. Agents receive message content as stored. The skill and the [agent guide](/agents/mail#treat-every-message-as-untrusted) tell agents how to handle it, but the real protection is a narrow grant.

## Credentials

| Credential       | Storage and handling                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API keys         | Shown once. Only a SHA-256 hash is stored; compared in constant time. Optional expiry.                                                                       |
| OAuth tokens     | Opaque, stored as hashes. Access tokens last five minutes and are bound to one origin and resource.                                                          |
| Owner password   | Argon2id. Failed sign-ins back off from one second to a minute.                                                                                              |
| Owner sessions   | 32 random bytes, stored as a hash. `HttpOnly`, `SameSite=Strict` cookie; `Secure` and `__Host-` prefixed over HTTPS. CSRF token required on unsafe requests. |
| Setup code       | Printed to stdout, held only as a hash in memory, single use                                                                                                 |
| Login links      | Single use, two minutes, in memory, created only with the owner bearer token                                                                                 |
| Webhook secrets  | Shown once at creation                                                                                                                                       |
| Cloudflare token | Encrypted in the database, never returned by the API or shown again                                                                                          |

Message content, credentials and keys are never written to logs.

## Network exposure

- The service listens on `127.0.0.1` only and accepts only its exact `Host`, which blocks DNS rebinding. Requests from a foreign browser `Origin` are rejected.
- API responses are not cached. The web app is served with a restrictive Content Security Policy, `frame-ancestors 'none'` and `no-referrer`.
- Attachment and raw message downloads use signed URLs valid for five minutes that still require the credential, and are served as downloads with `nosniff`.
- Webhooks only reach public HTTPS addresses, checked on every attempt, except owner webhooks to loopback.
- Remote access uses a separate listener with a fixed route allowlist. See [Remote access](/guides/remote-access#what-is-reachable).

## Limits

Be clear about what this model does not cover:

- **Your machine is the trust anchor.** Anyone who can run code as your user, or read the home and the keychain, can read all mail. While the service runs, the key is in its memory.
- **`connection.json` is full owner access** for anyone who can read it.
- **Sender identity depends on Cloudflare's authentication results.** A single SPF, DKIM or DMARC pass, even for an attacker's own domain, clears the `unauthenticated` label. Allow and block lists match addresses that can be forged.
- **Backups are not managed.** Losing `keys.json` or the keychain item makes the database unreadable, and there is no passphrase recovery yet.
- **Delivery reports can be missed** in the first minutes after a domain is set up, and while the service is offline for longer than five minutes.
- **Validation is ongoing.** The test suite uses fakes for Cloudflare, DNS and the keychain. Behavior against real Cloudflare accounts, real mail delivery and every supported operating system is less proven.
