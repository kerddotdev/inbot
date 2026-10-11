---
title: Domains
description: Register a mail subdomain, review the plan, provision Cloudflare resources, verify delivery end to end, and tear it all down again.
---

A domain is the subdomain your agents' addresses live on, such as `agents.example.com`. Inbot provisions everything Cloudflare needs for it, then proves that mail actually arrives before calling it verified. Domains are owner-only: use the **Domains** page or `/v0/domains`. There is no CLI command or MCP tool for them.

## Before you start

- [Configure the mail transport](/guides/transport) with a verified token.
- The zone (`example.com`) must already exist in that Cloudflare account, with its nameservers active.
- Choose a dedicated subdomain. Inbot manages exactly one literal subdomain per instance, and never the zone apex, a wildcard or `@`.

Inbot does not touch your apex mail. Before every step that can affect DNS, it snapshots the apex MX records, the apex SPF record and `_dmarc` at the apex. If any of them changes during the step, it stops with `action_required` instead of continuing, and it never rolls back someone else's edits.

## Register and review

Select **Preview plan** to review, then **Apply automatically via Cloudflare** to provision. The screen distinguishes unprovisioned registrations, operations in progress, DNS propagation, the self-test and observed verification.

Registering only records the domain; nothing changes in Cloudflare yet. The domain starts as `NOT_STARTED`.

Review what will happen before applying:

- **Plan** (`GET /v0/domains/{id}/plan`) lists the steps, the DNS records and any warnings. Values Cloudflare assigns during apply, such as the sending DKIM key, show as placeholders.
- **Zone file** (`GET /v0/domains/{id}/zone-file`) exports the records as BIND text. Unassigned values appear as comments.

## Apply

Apply creates, in order:

| Resource              | Name                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| Sending subdomain     | Your subdomain, in Email Service, with sending previews disabled                                              |
| Email Routing         | Enabled for your subdomain only                                                                               |
| R2 bucket             | `inbot-<id>-inbound`, for encrypted inbound mail                                                              |
| Inbound Queue         | `inbot-<id>-inbound`, with a pull consumer                                                                    |
| Delivery events Queue | `inbot-<id>-events`, with a pull consumer and 5-minute retention                                              |
| Email Worker          | `inbot-<id>-inbound`, holding only your instance's public age key. workers.dev and preview URLs are disabled. |
| Event subscription    | `inbot-<id>-events`, sending Email Service events to the events Queue                                         |

`<id>` is the domain's ID. Inbot also generates the instance's inbound key pair if it does not exist yet; the private key stays in your encrypted database.

Cloudflare supplies the DNS records. For routing, that is MX and SPF on your subdomain. For sending, Cloudflare's bounce subdomain gets DKIM, MX and SPF records, and `_dmarc.<subdomain>` gets a strict DMARC policy (`v=DMARC1; p=reject;`). If Cloudflare adds its routing DKIM record at the apex, Inbot only records it as its own when it did not exist before, and removes it only if no other Cloudflare-routed MX still needs it.

Apply is resumable. Every created resource is written to a ledger first, so after a crash or timeout, running apply again reconciles instead of duplicating. Resources that existed before Inbot touched them are adopted and never deleted by teardown.

## Verification

After apply, the domain is `VERIFYING`. The service checks every DNS record through public DNS-over-HTTPS. Each record is `MISSING`, `INVALID` or `VALID`. Once all are valid, Inbot:

1. Adds a temporary routing rule for `inbot-selftest@<subdomain>`.
2. Sends a message to that address with a random token.
3. Waits for the encrypted message to arrive through the Worker, R2 and the Queue, and checks the token, sender and recipient.

Verification can take about ten minutes or longer, depending on public DNS propagation and the encrypted test arrival.

Only then does the domain become `VERIFIED` and emit a `domain.verified` event. Provider status alone is never enough. If nothing arrives, the self-test is retried after five minutes. The self-test message is not stored as mail, and `inbot-selftest` cannot be used as an inbox name.

| Status        | Meaning                                                           |
| ------------- | ----------------------------------------------------------------- |
| `NOT_STARTED` | Registered, nothing provisioned                                   |
| `PENDING`     | Apply or teardown is running                                      |
| `VERIFYING`   | Provisioned; waiting for DNS propagation or the self-test         |
| `VERIFIED`    | DNS is valid and an encrypted test message arrived                |
| `FAILED`      | Stopped with `action_required`; `reason` says what you need to do |

A changed or replaced resource, or DNS that no longer matches, resets verification. The Domains page refreshes pending and verifying domains while it is open; `POST /v0/domains/{id}/verify` starts a check on demand.

## Inbox routing

Each inbox on the domain gets its own Email Routing rule that sends exactly that address to the Worker. There is no catch-all: mail to an address without an inbox is not delivered to Inbot. Creating or deleting an inbox records the routing change in the same database transaction, and the provisioning loop applies it within seconds, retrying with backoff. If an unrelated rule already exists for the address, the job stops with `resource_taken` for you to resolve.

## Update

`PATCH /v0/domains/{id}` changes the domain's feature flags within the supported combination. The web app offers **Confirm supported features**, which sets that combination; it has no independent feature toggles. Inbot rejects conflicting-provider mode, feedback, tracking and wildcard subdomains.

## Tear down

Teardown removes what apply created, in reverse order, and returns the domain to `NOT_STARTED`:

1. Inbox routing rules are removed first.
2. If the R2 bucket still holds encrypted mail, teardown stops with `action_required` and deletes nothing else. Inbot never empties the bucket for you, because those objects may be mail it has not fetched yet. Let the service catch up first.
3. The self-test rule, subscription, Worker, consumers, Queues, bucket, routing DNS and sending subdomain are deleted. Anything already gone counts as deleted, and adopted resources are left alone.

Your local mail and the inbound private key survive teardown. Applying again recreates the infrastructure and the routing rules for existing inboxes. Deleting a domain registration (`DELETE /v0/domains/{id}`) is allowed only after teardown.

The web app asks for confirmation before teardown and deletion.

## Verification boundaries

Automated tests cover provisioning against a fake Cloudflare API, with real encryption and a real encrypted database. Your domain is verified only after its public DNS records match and Inbot observes its encrypted self-test arrival. This verifies the inbound path, not delivery of every outbound message.

Cloudflare's delivery event subscription needs a few minutes to warm up, so delivery reports for the very first messages can be missed.
