# Inbot

Self-hosted, privacy-first email for AI agents. Each agent gets its own inbox on your custom domain, mail is stored encrypted on your own machine, and agents reach it through MCP, a CLI, or a REST API. An optional Cloudflare Tunnel lets cloud-hosted agents reach your local instance with scoped credentials. The mail provider still sees plaintext in transit: Inbot is zero-knowledge at rest, not end-to-end encrypted.

Status: early development. The encrypted storage foundation, mailbox service, [inbound MIME ingestion](apps/server/src/inbound/README.md), [authenticated loopback HTTP API](apps/server/src/http/README.md), shared [age envelope package](packages/envelope/README.md), and [inbound Email Worker handler](apps/worker/README.md) exist. Live mail delivery, the owner web UI, and installers remain planned.

## Development

Requires Node.js 24 (24.21.0 or newer) and pnpm 10.24.0.

```sh
pnpm install
pnpm check
pnpm build
pnpm start:server --home /path/to/explicit/inbot-home --port 0 --init
```

Choose an explicit home directory for development. Initialization uses the OS
keychain. Later starts omit `--init` and unlock through the keychain. The server
prints its URL once and writes the owner token to the home directory's private
`connection.json`. Sending requires a configured Cloudflare transport; drafts,
lists, webhooks, and domains return `not_supported`. Passphrase startup and web
sessions are not implemented yet.
