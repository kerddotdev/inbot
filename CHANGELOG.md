# Changelog

Published changes are recorded in [GitHub releases](https://github.com/kerddotdev/inbot/releases), with notes generated from merged pull requests. This file summarizes each release.

## 0.2.1 - 2026-10-22

- Breaking: browser fill and capture now connect only to browsers the owner trusts. Register a local browser under Settings > Trusted browsers or with `inbot vault settings set --cdp-endpoints http://127.0.0.1:9222`; until then local fill and capture fail with `missing_permission`. Loopback is no longer trusted by default. Remote browsers still need an allowlisted HTTPS or WSS host.
- Credential use approvals show the browser endpoint and field selector, and capture now needs approval and serializes with fill like any other credential use.
- Inbot still cannot authenticate a CDP peer: a process that takes over a registered browser's port while that browser is stopped can receive fills. Keep registered browsers running and remove stale entries.
- With trusted authserv-ids, only the topmost trusted `Authentication-Results` header decides the `unauthenticated` label. The label still relies on the receiving provider adding its own header and stripping forged ones.
- Release archives ship Node.js 24.22.1, verified against SHA-256 pins in the packaging script.
- On Windows, the updater extracts releases with the system `tar.exe` instead of the first `tar` on PATH.
- Release updates are still verified by checksums published beside the archive and, on macOS, the Node signature. There is no independent publisher signature yet.

## 0.2.0 - 2026-10-15

- A credential vault stores logins for each inbox in the encrypted database. Agents see names and `inbot://credentials/<id>/<field>` references, never values, and every use is authorized again against the key's `credential_*` permissions and inbox scope.
- The server generates passwords (Apple-style by default, or matching a site's password rules) and TOTP codes, so a new account's secrets never pass through the agent.
- Browser fill and capture connect to a CDP endpoint, check the page's origin against the credential and type the value server-side. Remote agents can only reach owner-allowlisted public browser hosts.
- `inbot run --env NAME=REF -- command` passes credentials to local commands without showing them to the agent. It is not a security boundary.
- Keys default to `use_policy: approval`: the owner approves each fill or run from Approvals, the CLI or REST.
- Agents can request a credential the owner fills in locally, and the owner can import and export Bitwarden JSON.
- The owner UI has a Vault screen with on-demand reveal, live TOTP codes and generation.

## 0.1.1 - 2026-10-14

- `inbot update` installs a newer release after verifying its checksum and, on macOS, its Developer ID signature, then restarts the background service. `inbot update --check` only reports whether an update exists.
- The background service checks for new releases about every four hours and installs them automatically. Owners can turn this off with `inbot update --auto off` or in Settings, which also shows the last check and its result.
- Domain verification asks the zone's authoritative nameservers, so records turn valid as soon as they exist instead of waiting out a resolver's negative cache. Lookup failures are reported as unknown rather than missing.
- The Windows launcher can be replaced safely while it runs, and connector credential cleanup retries while Windows releases the files.
- The MCP server reports the installed version.

## 0.1.0 - 2026-10-12

- Self-hosted agent inboxes on custom domains, encrypted local SQLite storage, and OS-keychain-backed initialization and unlock.
- Mailbox operations through a shared typed REST API, MCP server, and authenticated CLI, with mail search, batch operations, raw messages, and attachment downloads through REST and the CLI.
- Scoped API keys and owner-consented OAuth with PKCE, audience-bound tokens, refresh rotation, and service-enforced send policies.
- Cloudflare inbound Email Worker with streaming age encryption, ciphertext R2 buffering, Queue pulling, reconciliation, and owner quarantine management.
- Durable idempotent outbound sending, owner approval and rejection, scheduled drafts, and delivery, bounce, and complaint event processing.
- Owner password and browser sessions with CSRF protection, single-use login links, and a local web UI for mail, API keys, approvals, domains, transport, and allow/block lists.
- Sanitized HTML mail in sandboxed frames, same-message raster CID images, per-message remote-image consent, and a plain-text view.
- Owner domain provisioning and teardown, inbox routing, signed webhooks, and authenticated WebSocket event replay.
- Optional Cloudflare Tunnel access with a pinned supervised connector, scoped credentials, and a separate listener enforcing the remote route allowlist.
- Installable macOS, Linux, and Windows archives with bundled Node, checksum-verifying installers, and per-user background service management.

Inbot is zero-knowledge at rest, not end-to-end encrypted. These capabilities are covered by synthetic tests; real mail delivery has not been validated for this release.
