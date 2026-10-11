---
title: Remote access
description: Let agents in the cloud reach your local Inbot through a named Cloudflare Tunnel, with a strict route allowlist.
---

Remote access is off by default. When you enable it, Inbot provisions a named Cloudflare Tunnel and a DNS record for a hostname you choose, downloads a pinned and verified `cloudflared`, and supervises it. Cloud agents then reach a restricted set of agent routes at `https://<hostname>` with the same API keys or OAuth grants as local agents. Owner management stays local.

## Before you enable it

- A [configured mail transport](/guides/transport) whose token also has **Cloudflare Tunnel: Edit**, **DNS: Edit** and **Zone: Read**.
- An unused hostname in one of the account's zones, such as `inbot.example.com`. Not the apex, not a wildcard, and with no existing DNS record. Hostnames more than one level deep may need a Cloudflare Advanced Certificate.

Cloudflare terminates TLS for the tunnel, so it can see tunneled requests and responses in plaintext, including mail an agent reads. See the [security model](/concepts/security).

## Enable

On the **Remote access** page, enter the hostname and confirm the download. Or, on the machine running Inbot:

```sh
inbot remote enable --hostname inbot.example.com
inbot remote status
```

Enabling:

1. Downloads `cloudflared` 2026.9.1 from Cloudflare's GitHub releases into `<home>/bin`, and checks it against a SHA-256 pinned in Inbot for your platform. It is checked again before every start and never auto-updates.
2. Creates a remotely managed tunnel named `inbot-remote-<uuid>`.
3. Creates a proxied CNAME from your hostname to the tunnel. Inbot never replaces an existing record; if one exists, it stops with `action_required`.
4. Starts the connector with its token in a private file, never on the command line or in the environment.

| State             | Meaning                                                  |
| ----------------- | -------------------------------------------------------- |
| `disabled`        | Off                                                      |
| `provisioning`    | Creating the tunnel and DNS record                       |
| `connecting`      | The connector is starting or reconnecting                |
| `connected`       | The connector reports an active connection to Cloudflare |
| `action_required` | Stopped; `reason` explains what to fix                   |

Each creation step is recorded before it happens, so after a timeout or restart, inspect status and run enable again with the same hostname to reconcile. The desired state survives restarts, and the connector restarts with backoff up to 60 seconds. To change the hostname or rotate the tunnel token, disable and enable again.

## What is reachable

The tunnel connects to a second loopback listener that always enforces this policy. It requires the `Host` to be your hostname and any `Origin` to be `https://<hostname>`, and it rejects the local owner bearer token on every path.

| Reachable over the tunnel                                                                                        |
| ---------------------------------------------------------------------------------------------------------------- |
| `/mcp`                                                                                                           |
| `/v0/ws`                                                                                                         |
| Agent REST routes under `/v0`: inboxes, threads, messages, drafts, attachments, downloads, lists and webhooks    |
| OAuth discovery under `/.well-known/`, and `/oauth/register`, `/oauth/token`, `/oauth/revoke`                    |
| Owner sign-in: `/v0/owner/status`, `login`, `logout`, `password`, `sessions`, `/oauth/authorize` and the web app |

| Blocked over the tunnel, even with an owner browser session                                  |
| -------------------------------------------------------------------------------------------- |
| `/v0/owner/setup`, login links, transport, remote access, OAuth management and rejected mail |
| `/v0/domains` and `/v0/api-keys`, including inbox-scoped API key routes                      |
| Resolving `send_unknown` messages                                                            |
| `/mcp/*` subpaths, and any other `/oauth` or `/.well-known` path                             |

Paths with encoded separators, traversal, `//`, `;`, `#`, NUL or backslashes are rejected before routing.

The owner can sign in to the web app over the tunnel. The session cookie becomes `__Host-inbot_session` with `Secure`, and unsafe requests still need the CSRF token. This lets you approve drafts and OAuth clients away from home, while keys, domains and transport stay manageable only on the machine itself.

## Connect a cloud agent

Give the agent `https://<hostname>` as its base URL and its API key, or let an OAuth-capable MCP client discover authorization at `https://<hostname>/mcp`. OAuth tokens are bound to the origin they were issued for; a token issued on the loopback URL does not work through the tunnel, and changing the hostname invalidates tokens issued for the old one.

## Disable

```sh
inbot remote disable
```

Disabling stops the connector, deletes the DNS record and the tunnel, and reports `disabled` only after Cloudflare confirms both are gone. Disable before clearing the transport or switching Cloudflare accounts.

## Validation status

The tunnel lifecycle, route policy, cookies and Origin checks are tested against a fake Cloudflare API and a fake connector. A full validation against a real Cloudflare account, including certificates, connector restarts and the native connector builds on every platform, is still pending. Check `inbot remote status` after enabling.
