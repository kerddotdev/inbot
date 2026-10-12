# Changelog

Published changes are recorded in [GitHub releases](https://github.com/kerddotdev/inbot/releases), with notes generated from merged pull requests. This file summarizes each release.

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
