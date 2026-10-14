---
title: Inbot documentation
description: Self-hosted, privacy-first email for AI agents. Each agent gets its own inbox on your domain, and mail stays encrypted on your machine.
---

Inbot gives each of your AI agents its own email address on a domain you own, and a credential vault for the accounts it signs up for. It runs on your own computer, stores mail and credentials in an encrypted local database, and lets agents read and send mail, and use credentials without seeing them, through MCP, a command line tool, or a REST API. You manage everything from a local web app.

Install the latest release with a [one-line installer](/get-started/install). The download includes its own Node.js runtime and the owner web app.

## How the pieces fit

- **The Inbot service** (`inbot serve`) runs on your machine. It owns the encrypted SQLite database and serves the REST API, the MCP endpoint and the owner web app on one loopback port.
- **Cloudflare** is the mail provider. Email Routing receives mail for your domain and hands it to a small Email Worker that encrypts each message to your instance's public key before storing it. Outbound mail goes through Cloudflare Email Service.
- **Agents** connect with a scoped API key or an owner-approved OAuth grant. A key fixes which inboxes an agent can see, what it may do, and whether its mail is sent directly, held for your approval, or not at all.
- **Remote access** is optional. It provisions a named Cloudflare Tunnel so agents running in the cloud can reach a restricted set of agent routes on your machine.

## What Inbot promises, and what it does not

Inbot is zero-knowledge at rest, not end-to-end encrypted. Mail waiting in Cloudflare is stored only as ciphertext, and on your machine it lives only in the encrypted database. Cloudflare still sees message contents in transit, and outbound mail passes through it in plaintext. Read the [security model](/concepts/security) for the exact boundaries.

The [credential vault](/guides/vault) gives agents references instead of values. The server generates passwords and types them into a browser page after checking the page's origin, so a new account's password never enters the conversation. Whatever types a password holds it at that moment, and the security model lists each path's limits.

Every message an agent reads may have been written by an attacker. Inbot treats mail as data: nothing in a message can grant a permission, widen a scope or reach an owner-only action.

## Start here

1. [Install Inbot](/get-started/install).
2. Follow the [quickstart](/get-started/quickstart) from first start to an agent reading its first message.
3. Learn the [concepts](/get-started/concepts): owner, agent, inbox, grant and send policy.

## For agents

Agents should read [Connect an agent](/agents/connect), [Reading and sending mail](/agents/mail) and [Using credentials](/agents/credentials). The repository's [`skills/inbot`](https://github.com/kerddotdev/inbot/tree/main/skills/inbot) folder is a ready-made agent skill. Append `.md` to any page URL to get its Markdown source; [`llms.txt`](/llms.txt) indexes every page and [`llms-full.txt`](/llms-full.txt) contains all of them.
