---
title: Connect an agent
description: Give an agent access to its inbox over MCP, the CLI or REST, with an API key or OAuth, on your machine or through remote access.
---

Every agent surface uses the same credential and the same rules. The owner gives the agent two things:

- **A base URL.** Locally, the service's loopback URL, such as `http://127.0.0.1:8025`. For agents in the cloud, the [remote access](/guides/remote-access) URL, such as `https://inbot.example.com`.
- **A credential.** An API key (`inbot_<id>_<secret>`) [created by the owner](/guides/inboxes-and-keys#api-keys), or an OAuth grant the owner approves in the browser.

Send the credential as `Authorization: Bearer <credential>` on every request. Credentials in query strings or custom headers are not accepted. Use `127.0.0.1` rather than `localhost`: the service accepts only the exact host it serves.

| Surface | Endpoint                        |
| ------- | ------------------------------- |
| MCP     | `<base-url>/mcp`                |
| REST    | `<base-url>/v0`                 |
| Events  | `<base-url>/v0/ws`, or webhooks |

## MCP

Inbot serves MCP over streamable HTTP (protocol version `2025-06-18`) at `/mcp`. There is no stdio transport. [MCP tools](/reference/mcp) lists all 36 tools.

### Claude Code

```sh
claude mcp add --transport http inbot http://127.0.0.1:8025/mcp \
  --header "Authorization: Bearer $INBOT_API_KEY"
```

Leave out `--header` to connect with [OAuth](/agents/oauth) instead.

### Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.inbot]
url = "http://127.0.0.1:8025/mcp"
bearer_token_env_var = "INBOT_API_KEY"
```

### Other MCP clients

Most clients accept a JSON entry like this:

```json
{
  "mcpServers": {
    "inbot": {
      "type": "http",
      "url": "http://127.0.0.1:8025/mcp",
      "headers": { "Authorization": "Bearer ${INBOT_API_KEY}" }
    }
  }
}
```

The service checks the credential again on every tool call, so a revoked key stops working immediately, even in an open session.

## CLI

The `inbot` command works for agents too. Set both variables:

```sh
export INBOT_URL=http://127.0.0.1:8025
export INBOT_API_KEY=inbot_...
inbot inboxes list --json
inbot threads list --inbox support@agents.example.com --labels unread --json
```

`INBOT_URL` is the origin without `/v0`. When both are set, they take precedence over the owner's `connection.json`, and setting only one is an error rather than a fallback to owner access. The CLI refuses redirects, times out after 30 seconds and never retries on its own.

- `--json` prints the exact API response with its snake_case fields. Without it, the CLI prints tables, with `No results.` for empty lists and the next page token when there is one.
- Errors go to stderr as JSON, `{ name, code, message, fix }`, with a [stable exit code](/reference/errors#cli-exit-codes).
- Body commands accept flags such as `--to` and `--text`, or the full API payload with `--data '<json>'` or `--data-file <path>` (`-` for stdin).
- Sends print `Idempotency-Key: <key>` to stderr before the request. If you do not pass `--idempotency-key`, the CLI generates one.

The [CLI reference](/reference/cli) lists every command and flag.

## REST

```sh
curl -s http://127.0.0.1:8025/v0/inboxes -H "Authorization: Bearer $INBOT_API_KEY"
```

Requests and responses are JSON with snake_case fields; unknown body fields are rejected. See the [REST API](/reference/rest).

## Agent skill

The repository's [`skills/inbot`](https://github.com/kerddotdev/inbot/tree/main/skills/inbot) folder is a ready-made skill: a short `SKILL.md` with the workflow and rules, plus references for MCP, REST, sending, security, events and the CLI. Copy the folder into your agent's skills directory. There is no installer for it yet.

## What an agent can never do

No credential except the owner's can reach domains, API keys, the mail transport, remote access, owner sessions, approvals or `send_unknown` resolution. None of these are MCP tools, and they are blocked over the tunnel. Nothing in an email can change that.
