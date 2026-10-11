---
title: Architecture
description: How mail flows into and out of Inbot, what runs on Cloudflare and on your machine, and how the service recovers after crashes and outages.
---

```text
Inbound
  sender -> Email Routing -> Email Worker (age-encrypts)
         -> R2 (ciphertext) + Queue (pointer)
         -> inbot serve: pull, decrypt, store in encrypted SQLite

Outbound
  agent -> inbot serve (outbox) -> Email Service -> recipient
  Email Service -> delivery events Queue -> inbot serve
```

## The service

`inbot serve` is one process. It unlocks the encrypted SQLite database, then serves REST under `/v0`, MCP at `/mcp`, the WebSocket at `/v0/ws` and the owner web app on a single `127.0.0.1` port. The same service methods sit behind every surface: REST, MCP, the CLI and the web app are all clients of one typed contract, so a rule enforced for one is enforced for all. The CLI never opens the database; it calls the REST API.

Background loops send mail, pull inbound mail and delivery events, apply routing, check domain verification, send scheduled drafts, deliver webhooks and supervise the tunnel. They are listed in [Running the service](/operations/service#background-loops).

The machine only makes outbound connections to Cloudflare. Nothing on the internet connects to it, unless you enable [remote access](/guides/remote-access).

## Inbound

1. Cloudflare Email Routing receives a message for one of your inbox addresses. Each inbox has its own routing rule; there is no catch-all.
2. The Email Worker rejects anything over 25 MiB. Otherwise it streams the message, together with the SMTP sender and recipient, through [age](https://age-encryption.org) encryption to your instance's X25519 public key, writes the ciphertext to R2 as `inbound/<id>.age`, and queues a pointer `{ key, size, received_at }`. The Worker holds only the public key; it does not inspect, filter or log the message.
3. The service pulls pointers in batches, downloads and decrypts each object, parses the MIME, applies allow and block lists, threads the message and stores it, all in the encrypted database.
4. Only after the store commits does it delete the R2 object and acknowledge the pointer. A crash at any point replays safely, because ingestion is idempotent.
5. Every 15 minutes, and at startup, it lists R2 for objects older than ten minutes that the Queue missed, so a long outage or a lost pointer loses nothing.

While your machine is off, mail waits in R2 as ciphertext. It is fetched when the service starts again.

**Parsing.** The `Message-ID` falls back to a hash of the raw message, and an unparseable `Date` falls back to the receive time. `extracted_text` and `extracted_html` remove quoted history and boilerplate heuristically; the original `text`, `html` and raw MIME are always kept. Attachments are stored in the database.

**Authentication.** Inbot reads Cloudflare's `Authentication-Results` header. If SPF, DKIM or DMARC passed, the message is treated as authenticated; otherwise it gets the `unauthenticated` label. Inbot does not run its own checks and never rejects mail for failed authentication.

**Threading.** `In-Reply-To` is resolved first, then `References` from newest to oldest, within the same inbox. Subjects never join threads, and a parent that arrives late does not merge existing threads.

**Failures.** Temporary errors are retried with backoff up to one hour. Objects that can never be processed, such as corrupt ciphertext or invalid MIME, are quarantined: the ciphertext stays in R2 and the database records only its key, a reason code and when it was first seen. There is no screen or command to review or release quarantined objects yet.

## Outbound

1. A send, reply or forward writes the message and an outbox entry in one transaction and returns `queued`.
2. The outbox loop checks the send and reply lists again, then calls Cloudflare Email Service.
3. Cloudflare's acceptance makes the message `sent`. Retryable errors (rate limits, quota, server errors) are retried with exponential backoff up to one hour, for at most 8 attempts. Validation, authentication and unverified-sender errors fail permanently.
4. If Inbot cannot tell whether Cloudflare accepted the message, for example after a timeout or a crash mid-call, it marks the message `send_unknown` and never resends it on its own.
5. Delivery, bounce, complaint, rejection and deferral reports arrive through the delivery events Queue and become labels and events on the message.

Every message gets a local `Message-ID` of the form `<uuid@your-inbox-domain>`. Cloudflare assigns its own RFC `Message-ID` on sending; Inbot stores it as an alias, so replies to your agent thread correctly.

See [Message states](/concepts/message-states) for every state and label.

## Crash and timeout recovery

Inbot writes intent before effect, then reconciles:

- **Inbound** commits locally before deleting from Cloudflare, and replays idempotently.
- **Outbound** never retries an attempt whose outcome is unknown.
- **Provisioning** records each Cloudflare resource in a ledger before creating it, and apply resumes instead of duplicating.
- **Remote access** records creation intents and reconciles by name and hostname.
- **Events** are written in the same transaction as the change they describe, so there is never an event without its change or a change without its event.

## Code layout

| Path                 | Contents                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `apps/server`        | The service: storage, keys, mailbox, inbound, outbound, drafts, auth, HTTP, MCP, OAuth, events, provisioning, remote access |
| `apps/cli`           | The `inbot` command                                                                                                         |
| `apps/web`           | The owner web app (React, Vite, Tailwind)                                                                                   |
| `apps/worker`        | The inbound Email Worker                                                                                                    |
| `apps/docs`          | This documentation                                                                                                          |
| `packages/contracts` | Shared schemas and API declarations used by every surface                                                                   |
| `packages/envelope`  | The age envelope format shared by the Worker and the service                                                                |
| `packages/design`    | Design tokens shared by the web app and the documentation                                                                   |
| `skills/inbot`       | The agent skill                                                                                                             |
