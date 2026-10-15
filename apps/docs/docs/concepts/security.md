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

- **Inbound buffer.** age v1 with X25519. The Worker holds only your instance's public key. The private key lives in your encrypted database. Quarantined mail stays encrypted in the buffer; Inbot lists only a reason code and metadata, and decrypts it only when you retry.
- **Database.** SQLite encrypted with ChaCha20 (SQLite3 Multiple Ciphers) under a random 256-bit key (the DEK). The database holds raw mail, attachments, the Cloudflare token, the tunnel token, password and key hashes, drafts and the event log.
- **Key wrapping.** The DEK is wrapped with AES-256-GCM by a key stored in your OS keychain, and the wrapped form is stored in `keys.json`. Neither file is usable without the other and the keychain item.
- **Home directory.** Mode `0700`, secret files `0600`, written atomically on Unix. Windows protection relies on the directory access control list.

## Owners and agents

There are two kinds of principal, and the boundary between them is enforced by the service on every request.

**The owner** authenticates with the bearer token in the home's `connection.json` (regenerated on every start), or with a browser session after signing in with a password.

**Agents** authenticate with API keys or OAuth access tokens. Each maps to a grant: an inbox scope, an explicit permission list and a send policy. The current grant is read on every request, so revocation and permission changes apply immediately.

Owner-only capabilities have no agent permission at all: domains, API keys, the mail transport, remote access, owner sessions and passwords, login links, draft approval and rejection, `send_unknown` resolution, rejected-mail records, inbound quarantine, OAuth management, and in the credential vault revealing values, import and export, browser host settings, use decisions and request fulfillment. None of them is an MCP tool. The tunnel allows owner browser sign-in, session and password management, draft approval and rejection, credential use decisions, declining credential requests, and OAuth consent. Domains, keys, transport, remote configuration, login links, rejected-mail records, quarantine, OAuth management, `send_unknown` resolution and everything in the vault that handles plaintext values stay local; the local owner bearer is always rejected over the tunnel.

Out-of-scope resources return `not_found`, identical to missing ones, so a key cannot probe for other inboxes. Messages with hidden labels (`spam`, `blocked`, `unauthenticated`, `trash`) are invisible unless the grant includes the matching `label_*_read` permission.

## Email content is untrusted

Inbot treats mail as data. Nothing in a message can grant a permission, widen a scope, change a send policy or reach an owner action. Concretely:

- Send policies are enforced in the service. An `approval` key cannot send anything without the owner, whatever the message says.
- Every MCP tool description reminds the agent that email content is untrusted.
- The owner app sanitizes HTML mail with DOMPurify and shows it in a sandboxed frame with no script permission and its own Content Security Policy. The sandbox has same-origin access only so the app can size the frame. Links open in a new tab without a referrer.
- Remote images are blocked by default, because loading one can tell the sender that the message was opened. **Load remote images** is a per-message choice kept only in memory. CSS resources and `srcset` stay blocked. Inline images attached to the same message are shown from its attachments.
- Unauthenticated mail is labeled and hidden from keys without `label_unauthenticated_read`.

What Inbot does not do: detect prompt injection, mark or wrap message bodies in API output, or sanitize HTML for agents. The owner app sanitizes only for display in the browser; nothing is sanitized on the server, so REST, MCP and the CLI return `html` and `extracted_html` as stored. Agents receive message content as stored. The skill and the [agent guide](/agents/mail#treat-every-message-as-untrusted) tell agents how to handle it, but the real protection is a narrow grant.

## Credentials

| Credential       | Storage and handling                                                                                                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API keys         | Shown once. Only a SHA-256 hash is stored; compared in constant time. Optional expiry.                                                                                                                          |
| OAuth tokens     | Opaque, stored as hashes. Access tokens last five minutes and are bound to one origin and resource.                                                                                                             |
| Owner password   | Argon2id. Failed sign-ins back off from one second to a minute.                                                                                                                                                 |
| Owner sessions   | 32 random bytes, stored as a hash. 14-day sliding lifetime, 30-day absolute lifetime. `HttpOnly`, `SameSite=Strict` cookie; `Secure` and `__Host-` prefixed over HTTPS. CSRF token required on unsafe requests. |
| Setup code       | Printed to stdout, held only as a hash in memory, single use                                                                                                                                                    |
| Login links      | Single use, two minutes, in memory, created only with the owner bearer token                                                                                                                                    |
| Webhook secrets  | Shown once at creation                                                                                                                                                                                          |
| Cloudflare token | Encrypted in the database, never returned by the API or shown again                                                                                                                                             |

Message content, credentials and keys are never written to logs.

## Credential vault

The vault stores account credentials for agents. Values sit in the same encrypted database as your mail, so the zero-knowledge-at-rest property is unchanged. Agents receive references (`inbot://credentials/<id>/<field>`), never values. A reference is a name, not a bearer secret: every use is authorized again against the key's permissions, inbox scope and `use_policy`.

Passwords are generated by the server, so a new account's password never enters the conversation. Whatever types a password holds it at that moment. That is true of any tool that fills forms, and Inbot cannot avoid it. What it controls is where the value goes and who may trigger it.

| Way to use a credential                              | What it guarantees                                                                                                                                                                                                                                       | Limit                                                                                                                                                                                          |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser fill and capture over CDP                    | Inbot's server types the value with `Input.insertText` after checking that the page's main-frame origin matches one of the credential's origins. The value stays out of the model, and injected email content cannot steer a password to the wrong site. | An agent that controls the machine can point Inbot at a fake CDP endpoint or read the page afterwards. Use `use_policy: approval` and the audit events against a deliberately malicious agent. |
| `inbot run`                                          | Local only. The CLI decrypts values with an ephemeral age key and injects them into a child environment. Output masking is best effort.                                                                                                                  | Not a security boundary: a process the agent controls can print the value. It has its own permission, `credential_run`.                                                                        |
| TOTP codes                                           | Agents with `credential_totp` get the current code, which is valid for 30 seconds. The seed is never returned to agents.                                                                                                                                 | A code is a value. Anyone who sees it can use it until it expires.                                                                                                                             |
| Owner reveal, import, export and request fulfillment | Owner-only, local-only, and not available over MCP. They are blocked through the remote tunnel because Cloudflare terminates TLS at its edge and would see the plaintext.                                                                                | Exported Bitwarden JSON is an unencrypted copy outside the database. Keep it private and delete it.                                                                                            |

Remote browsers are limited further. A request that arrives through the tunnel may only use an HTTPS or WSS endpoint on a host the owner allowlisted, resolving to public addresses. Inbot checks DNS before it connects but does not pin the address to the socket, so DNS rebinding is a residual risk. Allowlist only browser providers you trust.

Each key has a `use_policy`, `approval` by default, which holds every browser fill and `inbot run` resolution until the owner approves it. The `url_hint` in an approval request is the agent's claim, not the origin Inbot will check. Every use, capture, approval and request writes an audit event that contains identifiers and field names, never values.

Email content never triggers a credential action. A message cannot cause a fill, a reveal, an approval or a request; only the agent's task and the owner's decisions can. The `reason` in a credential request is agent-written text and is shown to the owner as plain text.

See the [credential vault guide](/guides/vault) for how to use it.

## Network exposure

- The service listens on `127.0.0.1` only and accepts only its exact `Host`, which blocks DNS rebinding. Requests from a foreign browser `Origin` are rejected.
- API responses are not cached. The web app is served with a restrictive Content Security Policy, `frame-ancestors 'none'` and `no-referrer`.
- Attachment and raw message downloads use signed five-minute capability URLs and need no bearer or cookie. They are bound to the issuer and listener origin and recheck current permissions, inbox scope, hidden labels and issuer activity. A supplied bearer must authenticate the issuer. Never share or log these URLs. Restarting the service invalidates them; files are served as downloads with `nosniff` and `no-store`.
- Webhooks only reach public HTTPS addresses, checked on every attempt, except owner webhooks to loopback.
- Remote access uses a separate listener with a fixed route allowlist. See [Remote access](/guides/remote-access#what-is-reachable).

## Release integrity

Release installers verify the archive against the release's `SHA256SUMS` before extraction. macOS archives contain Developer ID signed executables and native modules and are notarized by Apple. Linux and Windows archives are checksum-verified; they are not claimed to have Apple signing or notarization.

The final release archives and checksums have GitHub build provenance attestations. After downloading an archive, verify its provenance with the [GitHub CLI](https://cli.github.com/manual/gh_attestation_verify):

```sh
gh attestation verify ./inbot-<version>-<target>.tar.gz --repo kerddotdev/inbot
```

Use the `.zip` filename on Windows. The installers do not run this attestation check for you. Checksums detect corruption relative to the downloaded manifest; provenance ties the asset to the repository's build workflow. Neither is an independent security audit. See [Packaging and releases](/development/packaging) for the release pipeline.

## Limits

Be clear about what this model does not cover:

- **Your machine is the trust anchor.** Anyone who can run code as your user, or read the home and the keychain, can read all mail. While the service runs, the key is in its memory.
- **`connection.json` is full owner access** for anyone who can read it.
- **Vault values are visible to what types them.** Browser fill, `inbot run` and TOTP codes necessarily expose a value to the page, the child process or the caller at that moment. See the [vault section](#credential-vault) for each path's limits.
- **Sender identity depends on Cloudflare's authentication results.** A single SPF, DKIM or DMARC pass, even for an attacker's own domain, clears the `unauthenticated` label. Allow and block lists match addresses that can be forged.
- **Backups are not managed.** Losing `keys.json` or the keychain item makes the database unreadable, and there is no passphrase recovery yet.
- **Delivery reports can be missed** in the first minutes after a domain is set up, and while the service is offline for longer than five minutes.
- **Test coverage has boundaries.** CI checks use synthetic data and fakes for Cloudflare, DNS and the keychain. Archive smoke tests validate startup and native modules, not real mail delivery or every OS credential store. macOS is the most validated platform; Windows 11 ARM64 runs natively in CI, with x64 release smoke tests under emulation.
