# Inbot

Inbot is self-hosted, privacy-first email for AI agents. It gives each agent its own inbox on the owner's custom domain and runs on the owner's machine, with mail stored in an encrypted local database. Agents use it through MCP, a CLI, and a REST API. The owner manages it through a local web UI. An optional Cloudflare Tunnel lets cloud-hosted agents reach the local instance with scoped credentials.

The workspace, home, key management, encrypted SQLite storage, mailbox service, inbound MIME ingestion, durable outbound sending runtime, authenticated loopback HTTP API, owner password/session authentication, explicit static web bundle serving, and streamable HTTP MCP server in `apps/server/src`, the shared contracts in `packages/contracts`, the shared age envelope in `packages/envelope`, and the inbound Email Worker handler in `apps/worker` are implemented. Encrypted Cloudflare buffer configuration, inbound pulling and reconciliation, and delivery Queue pulling are implemented as internal services with scoped runtime loops. Owner quarantine list, retry, and idempotent deletion are implemented through local owner-only REST, CLI, and Settings, with shared inbound serialization and durable cleanup intents. Owner UI authentication, mail, API keys, approvals, domains, and allow/block lists are wired to the local API. Owner transport inspection, token verification, configuration, and clearing are available through owner-only REST routes and Settings. Update descriptions as the code lands, and never present a planned capability as implemented.

## What we never compromise on

### 1. Plaintext never rests outside the owner's machine

Inbound mail is encrypted to the owner's key before it is stored anywhere in the cloud, and only ciphertext waits in the buffer. On the host, mail lives only in the encrypted database. The mail provider still sees plaintext in transit and outbound mail passes through it. Say so plainly: Inbot is zero-knowledge at rest, not end-to-end encrypted. Never weaken this property for convenience, and never log message content, credentials, or keys.

### 2. Email content is untrusted data

Every message an agent reads may be written by an attacker. Content never becomes an instruction, never grants a permission, and never widens a scope. Owner-only capabilities (domains, keys, remote access, settings, unlock) are unreachable with agent credentials and are never exposed as MCP tools. Send policies (`direct`, `approval`, `read-only`) are enforced by the service, not by agent goodwill.

### 3. One contract, every surface

REST, MCP, CLI, and the web UI are clients of the same typed contract and the same service methods. A feature that works on one surface and is missing or behaves differently on another is a bug. The REST wire format (paths, snake_case fields, error codes, idempotency, and pagination) is a compatibility contract: change it only deliberately. Unsupported resources fail with an explicit `not_supported` error.

### 4. Honest state

Queued, sent, delivered, bounced, and failed are different states. Never report an external effect (a sent message, a verified domain, a registered tunnel, a provisioned resource) before observing it. After a crash or timeout, reconcile durable state before retrying effects. Every surface shows the real state, including `locked` and action-required states.

## How we work

Prefer ambitious ideas and simple systems. Do not preserve complexity just because it exists, and do not add machinery because it looks impressive. Find the real constraint, then build the smallest model that makes the correct behavior unsurprising. Channel both "measure twice, cut once" and "yagni".

Treat this document as good defaults, not hard rules. The developer's instructions override it. If a rule here fights the task in front of you, say so and get a human sign-off before breaking it.

## A small glossary

- **you** means the agent reading this file and changing Inbot.
- **maintainers** means the people building Inbot.
- **owner** means the single person who runs an Inbot instance and controls its domains, keys, and settings.
- **agent** means an AI agent that uses an Inbot inbox through MCP, the CLI, or REST.
- **home** means the service data directory: `--home`, then `INBOT_HOME`, then `~/.inbot` for production builds or `~/.inbot-dev` for development builds.
- **inbox** means one agent address, such as `bot@agents.example.com`. Its `inbox_id` is the address.
- **thread**, **message**, **draft**, **label** are the core mail resources. Threads are derived from `Message-ID`, `In-Reply-To`, and `References`.
- **domain** means a sending and receiving domain or subdomain with its DNS records and verification status.
- **transport** means a mail provider adapter. Cloudflare (Email Routing plus Email Service) is the first one.
- **buffer** means the provider-side holding area for inbound mail while the host is offline: an R2 bucket plus a pointer Queue for Cloudflare.
- **envelope** means an inbound message encrypted with age to the instance's public key.
- **DEK** is the random key that encrypts the database. **KEK** is a key that wraps the DEK: one stored in the OS keychain, one derived from the optional passphrase, or both.
- **key** means an agent API key (`inbot_<id>_<secret>`). A **grant** is its inbox scope, permission whitelist, and send policy. OAuth tokens map to the same grant model.
- **tunnel** means the optional named Cloudflare Tunnel that exposes selected routes to remote agents.

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or kill a PID found by matching a name or path. Your own agent and other Inbot processes share those strings. Kill only a PID you captured at spawn.
2. **Touching the real install.** `~/.inbot` and `~/.inbot-dev` can hold the owner's real mail and keys. Always pass `--home` or set `INBOT_HOME` to a temporary directory. Never read or write Inbot keychain items, and never run `service install`, `uninstall`, or `update` against a real home.
3. **Touching real mail infrastructure.** Never send real email, provision Cloudflare resources, upload the Email Worker, change DNS, or create tunnels against a real account unless the developer asks for that specific operation. Tests use fakes of the Cloudflare API.

## Hit every surface

Before calling a change done, walk this list and say which entries applied:

- **Contract.** Resources, errors, permissions, and events are Effect Schemas in `packages/contracts`. Change the schema and every consumer follows.
- **Service.** Behavior lives in service methods in `apps/server`. Transports decode input, call one service method, and map errors.
- **REST.** The REST route and its error codes.
- **MCP.** The tool, its annotations, and its permission declaration. Owner-only behavior never becomes a tool.
- **CLI.** Command parsing and help text.
- **Web.** The view and its states, including empty, locked, and failure states.
- **Events.** Webhook and WebSocket events for the state change.
- **Permissions.** Which grant permits it, how inbox scope applies, and what each send policy does.
- **Remote.** Whether the route is reachable through the tunnel path allowlist, and whether it should be.
- **Reverse states.** A way in needs a way out: create needs delete, enable needs disable, lock needs unlock, approve needs reject.
- **Docs.** Update `skills/inbot` and user-facing docs when behavior they describe changes.

## Development

- Node 24 and pnpm, with one committed workspace lockfile. Read the root `package.json` for the commands that actually exist. Do not assume a script exists before it lands.
- Build with `pnpm build`, then run `pnpm start:server --home <explicit-directory> --port 0 --init`. Initialization uses the OS keychain; subsequent starts unlock with it. `connection.json` holds the loopback URL and owner bearer token. Before owner password setup, `serve` prints a one-time setup code to stdout. Browser sessions use the same owner principal and require CSRF on unsafe requests; owner auth endpoints never become MCP tools. Source-checkout UI serving requires explicit `--web-root`; packaged CLI `serve` defaults to its bundled UI and production flavor. See `apps/server/src/http/README.md` for implemented routes and test-only startup.
- Do not add another package manager, lockfile, automatic Git hook, or install-time script that rewrites repository files.
- Never deploy, publish packages, push tags, or create releases unless asked.
- Keep setup and checks independent of private files and machine-specific paths.

## Verifying

- Smallest proof that the change works: the tests you touched, plus typecheck or lint when types or lint rules are affected.
- Every test uses its own temporary home (`mkdtemp`) and synthetic data. Stub the keychain, the Cloudflare API, DNS, and the clock.
- Test permissions and scope boundaries, idempotency, crash and timeout reconciliation, threading, lock and unlock, and the tunnel path allowlist. Do not add tests that only mirror the implementation or assert static UI markup.
- Wait for observable events or persisted state. Do not use arbitrary sleeps; keep bounded timeouts as failure guards.
- Real Cloudflare runs, other operating systems, and real mail delivery are reported separately from synthetic tests. Never claim them without evidence.

## Pull requests

- Every change after the initial bootstrap goes through a pull request targeting `main`. Never commit directly to `main`.
- Never open a PR unless the developer asks.
- Conventional commit titles in plain language, no commit body: `fix(inbound): keep envelopes until the store commits`.
- PR body: the problem in a sentence or two, then how you fixed it.
- One concern per PR. If the description says "also", split it.
- CI runs on Vectis runners. Implementation never authorizes merging, publishing releases, or deploying.

## How it works

The local `inbot serve` service owns the encrypted SQLite database and serves REST under `/v0` and MCP at `/mcp` on the same loopback port. Its scoped outbox runner sends configured Cloudflare mail. Owner browser authentication and static bundle serving are implemented with `serve --web-root <directory>`. The React owner UI connects authentication, mail, API keys, approvals, domains, mail transport settings, and allow/block lists to the local API. Optional remote access provisions a named tunnel and proxied DNS record, supervises a pinned connector, and isolates tunnel traffic on a guarded loopback listener. WebSocket live updates and signed webhook delivery use an encrypted durable event log. Other settings retain mock data; OAuth authorization with owner consent and audience-bound tokens is implemented.

**Inbound.** Cloudflare Email Routing delivers each inbox address to an Email Worker. The Worker streams the raw message through age encryption into R2 and queues a pointer. The service pulls the Queue, decrypts, parses, threads, and stores each message, then records the store commit, deletes the object, and acks the pointer. Permanent failures retain ciphertext with durable quarantine metadata. The owner can list, retry buffer objects, or permanently delete items through local REST, CLI, and Settings; acknowledged invalid Queue messages support metadata deletion only. It also reconciles by listing R2, so long outages lose nothing.

**Outbound.** Sends go through an idempotent outbox to the Cloudflare Email Service API. Delivery, bounce, and complaint events come back through a second Queue.

**Remote access.** When remote access is enabled, the service provisions a named Cloudflare Tunnel and DNS record through the Cloudflare API and supervises a pinned `cloudflared`. A separate loopback listener enforces the allowlist and rejects local owner bearer tokens and owner management routes. See `apps/server/src/remote/README.md` for the exact policy and migration 12 integration note.

**CLI.** The implemented `inbot` binary delegates `serve` to the existing server entry. Local owner `service install`, `service uninstall`, and `service status` manage per-user login services on macOS, Linux, and Windows with fixed ports, private logs, and observed manager/HTTP state. Install requires an initialized keychain home and a release package. Resource commands authenticate with the home connection or scoped `INBOT_URL` and `INBOT_API_KEY`, call the shared REST endpoints, and decode responses with the shared schemas. It never opens the database. See `apps/cli/README.md` for commands, JSON output, login links, idempotency, and exit codes.

## Where code lives

`apps/server/src` contains the storage foundation, mailbox service, inbound MIME ingestion and encrypted buffer pulling/reconciliation, delivery Queue pulling, outbound composition and durable outbox, drafts with owner approval and scheduling, authentication, loopback HTTP server, and `serve` entry point. `packages/contracts` contains the shared schemas and HTTP API declarations. `packages/envelope` and `apps/worker` implement inbound encryption and the Email Worker handler. The remaining layout is planned. Create a package only when it has a real implementation.

- `apps/server` - implemented home, key management, encrypted store, mailbox service, inbound MIME parsing and ingestion, outbound composition and durable outbox, Cloudflare REST adapter, delivery event application, API keys, owner bearer and password/session authentication, CSRF protection, single-use login links, explicit static UI serving, HTTP mailbox, draft and send APIs, owner-only draft approval and rejection, scheduled draft sending, streamable HTTP MCP, encrypted transport and inbound settings, inbound decryption/pulling/reconciliation and quarantine, delivery Queue pulling, scoped mail runners, owner-only transport configuration and verification, owner-only subdomain provisioning with durable inbox routing, global/inbox allow/block list CRUD and enforcement, transactional events, scoped signed webhook delivery, authenticated WebSocket replay, and owner-only optional remote access with durable tunnel/DNS reconciliation and pinned connector supervision, and OAuth authorization with browser consent, shared grants, PKCE and refresh rotation.
- `apps/cli` - implemented `inbot` binary, existing server dispatch, authenticated inbox/thread/message/draft/API-key/list/webhook REST commands, mail search and batch operations, raw/attachment downloads, owner domain lifecycle, transport configuration, local owner quarantine management, and WebSocket event tailing, single-use owner login links, shared response decoding, JSON and table output, idempotency keys, stable error exits, and local owner per-user service install/uninstall/status on macOS LaunchAgents, Linux user systemd, and Windows logon tasks.
- `apps/web` - React, Vite, and Tailwind owner UI in the approved design: owner sign-in, mail, API keys, approvals, domains, mail transport settings, quarantine management, and allow/block lists use the API through TanStack Query, with WebSocket cache invalidation and Settings webhook management; HTML mail uses DOMPurify and script-free sandboxed frames, same-message raster CID images, per-message remote-image consent and a plain-text toggle; remote access uses the owner API with explicit download confirmation; other settings still use mock data.
- `apps/worker` - implemented streaming inbound encryption to R2 and Queue pointers, one ES module bundle, and owner-provisioner upload support; real-account deployment requires explicit authorization.
- `packages/contracts` - implemented Effect schemas and HTTP API declarations shared by every surface. No handlers or service runtime.
- `packages/envelope` - implemented X25519 age streaming encryption, the inbound frame carrying the SMTP envelope, buffered decryption, and the Queue pointer schema shared by the Worker and the service consumer.
- `skills/inbot` - portable agent guidance for using Inbot.
- `scripts` - cross-target release packaging (`package.mjs`), isolated archive smoke checks (`smoke-release.mjs`) for Unix and Windows ARM64/x64, and installer verification. The tag-only release workflow gates automatic publication on full Vectis CI, Linux and Windows smoke tests, Developer ID signing and notarization of every macOS Mach-O, signed macOS smoke, final checksums and provenance attestations. Root `install.sh` and `install.ps1` verify and install published release archives without installing services; Windows selects the OS architecture and supports `-NoPathUpdate` for isolated checks. Releases have not been published yet.

## Taste

- Small cohesive modules, strict types, inferred local types. No `any`, unchecked casts, or speculative frameworks.
- Complexity belongs at adapter boundaries: transports, providers, keychain, and platform service managers. Domain logic stays free of them.
- Comments explain non-obvious constraints only.
- Command inputs are data, never shell text.
- Errors carry a stable `code` and an actionable `fix`.
- Add a dependency only for a responsibility that is actually implemented.

## Interface

- Restrained, spacious, accessible, and keyboard usable, in an Apple-like direction. No pure black or white primary surfaces or text.
- Status uses an icon and a label, not color alone.
- Animate only transform and opacity, respect reduced motion, and avoid continuous decorative animation.
- Copy states only verified behavior.

## Language and documentation

- Write all tracked content in English, including documentation, comments, test names, error messages, and commit messages.
- Do not use emojis, em dashes, or en dashes in code or documentation. Use ordinary hyphens.
- Keep guidance focused on capabilities and commands that exist.
