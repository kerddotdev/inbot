# Inbot

Self-hosted, privacy-first email for AI agents. Each agent gets its own inbox on your custom domain, mail is stored encrypted on your own machine, and agents reach it through MCP, a CLI, or a REST API. An optional Cloudflare Tunnel lets cloud-hosted agents reach your local instance with scoped credentials. The mail provider still sees plaintext in transit: Inbot is zero-knowledge at rest, not end-to-end encrypted.

Status: early development. The encrypted storage foundation and mailbox service exist; there is no runnable email service or installer yet.

## Development

Requires Node.js 24 (24.21.0 or newer) and pnpm 10.24.0.

```sh
pnpm install
pnpm check
```
