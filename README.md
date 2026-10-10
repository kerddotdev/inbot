# Inbot

Self-hosted, privacy-first email for AI agents. Each agent gets its own inbox on your custom domain, mail is stored encrypted on your own machine, and agents reach it through MCP, a CLI, or a REST API. An optional Cloudflare Tunnel lets cloud-hosted agents reach your local instance with scoped credentials. The mail provider still sees plaintext in transit: Inbot is zero-knowledge at rest, not end-to-end encrypted.

Status: early development. The encrypted storage foundation, mailbox service, [inbound ingestion and encrypted buffer pulling](apps/server/src/inbound/README.md), [authenticated loopback HTTP API](apps/server/src/http/README.md), shared [age envelope package](packages/envelope/README.md), [inbound Email Worker handler](apps/worker/README.md), [owner browser authentication and static UI serving](apps/server/src/http/README.md#owner-browser-authentication), drafts with owner approval and scheduled sending, and [delivery Queue consumer](apps/server/src/outbound/README.md#delivery-queue-consumer) exist. The owner UI has presentational screens with mock data; API wiring, live mail validation, and installers remain planned.

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
`connection.json`. Sending requires a configured Cloudflare transport. Draft CRUD,
owner approval, and scheduled sending are implemented; lists, webhooks, and domains return
`not_supported`. Passphrase startup remains planned. Before password setup, the
server prints a one-time owner setup code. Browser sessions require CSRF on
unsafe requests. Build the presentational UI with `pnpm web:build` and pass
`--web-root /absolute/path/to/apps/web/dist` to serve it on the loopback origin.

Inbound and delivery pulling require internal encrypted buffer configuration and
the existing Cloudflare transport token. `serve` starts their scoped loops after
unlock, including startup and periodic inbound reconciliation. Owner transport
setup routes are not implemented. Inbound R2 stores ciphertext only; provider-generated delivery
events can contain plaintext subjects in their Queue until acknowledged. See the
linked consumer documentation for configuration, quarantine, and API boundaries.
