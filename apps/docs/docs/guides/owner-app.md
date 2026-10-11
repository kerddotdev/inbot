---
title: The owner app
description: Sign in to the local web app and find your way around mail, approvals, domains, API keys, remote access and settings.
---

The owner app is a web interface served by `inbot serve` on the same loopback address as the API, for example `http://127.0.0.1:8025`. Installed packages serve it automatically; in a source checkout, build it and pass `--web-root` (see [Build from source](/development/build)). It uses the same REST API as every other client and keeps no API token in the browser.

Open it at `127.0.0.1`, not `localhost`: the service accepts only its exact address.

## Sign in

| Screen     | When                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Set up     | No password exists yet. Enter the setup code that `inbot serve` printed and choose a password of 12 to 1024 characters.                      |
| Sign in    | Enter your password. After a wrong password, each further attempt waits longer, from one second up to a minute.                              |
| Login link | `inbot open` prints a single-use link valid for two minutes; `inbot open --browser` opens it. The token is removed from the browser history. |
| Locked     | Shown if the API reports a locked database. The current service only serves after unlocking, so this screen should not appear in practice.   |

Sessions last 14 days from your last activity, and at most 30 days. Sign out from the sidebar. There is no password reset: if you forget the password, you cannot recover it through the app. Changing the password is available through `POST /v0/owner/password`, which also signs out every other session; the app has no screen for it yet.

## Mail

The sidebar lists your inboxes. **New inbox** creates an address; **Manage inbox** in the Mail header edits the display name and active/paused status or deletes the inbox after confirmation. Selecting an inbox shows its threads, newest first, with unread threads marked.

- **Read** a thread in the reading column. Inbot shows the reply text with quoted history folded away; **Show quoted text** reveals the rest when there is any. HTML mail is shown as plain text, and **Show HTML source** displays the escaped source. Nothing in a message is ever executed.
- **Mark read or unread**, and add or remove **labels** on the thread.
- **Download attachments** with the buttons in Mail. Files use signed five-minute capabilities and are downloaded, never rendered inline. Treat the URLs as temporary credentials and never share them.
- **Reply** to a message, or start a **New message** from the inbox.
- **Sent mail** shows its real state: queued, sent, failed with a reason, or unknown. For an unknown outcome, use **Resolve outcome** after you have confirmed what happened; see [Drafts and approvals](/guides/approvals#resolve-an-unknown-send-outcome).

Sending from the app retries with the same idempotency key while you are retrying the same message, so a flaky connection does not send twice.

## Approvals

Lists every draft waiting for your decision, across all inboxes. Open one to review recipients, text and attachment download buttons, then approve or reject it with an optional reason. Approving a scheduled draft keeps it scheduled. See [Drafts and approvals](/guides/approvals).

## Domains

Register a mail subdomain, preview the provisioning plan, apply it, watch DNS records and verification, export a BIND zone file, confirm supported domain features, tear down and delete. Teardown and deletion ask for confirmation. See [Domains](/guides/domains).

## API keys

Create keys with an inbox scope, explicit permissions and a send policy; copy the secret, which is shown once; edit names, permissions and send policies without rotating the secret; and revoke keys. New key forms default to **Full access** with **Approval** and no selected inboxes. Expiry is set only at creation through CLI or REST. The **Authorized OAuth clients** section lists OAuth grants, revokes them and purges unused client registrations. See [Inboxes and API keys](/guides/inboxes-and-keys).

## Remote access

Enable or disable the tunnel for a hostname, after confirming the connector download, and see the connector state, the public tunnel URL and the MCP endpoint to give cloud agents. See [Remote access](/guides/remote-access).

## Settings

| Section               | What it does                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Appearance            | System, light or dark theme, stored in this browser                                                                               |
| Mail transport        | Create, verify, save and clear the Cloudflare token. See [Mail transport](/guides/transport).                                     |
| Allow and block lists | Manage global and inbox lists, and review rejected mail. See [Allow and block lists](/guides/lists).                              |
| Webhooks              | Create webhooks, copy the one-time secret, see failures, enable, disable and delete. See [Webhooks and events](/guides/webhooks). |

## Live updates

The app keeps a WebSocket open to the service. New mail, draft changes, approvals and domain updates refresh the affected views automatically, and after a disconnect it reconnects with backoff and refreshes.

## OAuth consent

When an MCP client starts OAuth, your browser opens the **Allow access to Inbot?** screen. It shows the client's self-declared name, where it will redirect, and which resource it wants. New grants default to **Full access** with **Approval** and no inboxes selected. Choose the intended scope and grant, then approve or deny. If you are signed out, you sign in first and return to the request. See [OAuth for MCP clients](/agents/oauth).

## Not in the app yet

- Changing the password and listing or revoking owner sessions: use `/v0/owner/password` and `/v0/owner/sessions`.
- Per-inbox unread totals, forwarding, and browsing event history.
