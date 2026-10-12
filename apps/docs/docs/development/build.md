---
title: Build from source
description: Build and run Inbot from a source checkout, run the checks the project uses, and build this documentation site locally.
---

## Requirements

- Node.js 24.21.0 or newer, below 25
- pnpm 10.24.0
- An OS keychain, or the test-only memory keychain described below

## Build and run

```sh
pnpm install
pnpm build
pnpm web:build
pnpm start:server --home "$HOME/inbot-dev-home" --port 8025 --init \
  --web-root "$PWD/apps/web/dist"
```

`pnpm build` compiles the server, CLI and shared packages, and bundles the inbound Email Worker to `dist/worker/inbound.js`, which domain provisioning uploads. `pnpm web:build` builds the owner app. Later starts omit `--init`.

In a source checkout, use `pnpm start:cli` (or `node dist/apps/cli/src/main.js`) wherever the docs say `inbot`. Source builds default to the development flavor and `~/.inbot-dev`. Always pass an explicit `--home` while developing, so you never touch an installed instance's mail or keychain item.

## Checks

| Command               | What it runs                          |
| --------------------- | ------------------------------------- |
| `pnpm check`          | Formatting, lint, typecheck and tests |
| `pnpm test`           | Vitest                                |
| `pnpm typecheck`      | TypeScript for every package          |
| `pnpm lint`           | oxlint                                |
| `pnpm format:check`   | oxfmt                                 |
| `pnpm test:packaging` | Installer and packaging tests         |

Tests use temporary homes, a memory keychain, a fixed clock and fakes of the Cloudflare API and DNS. They never send real mail or touch a real account.

For local experiments without the OS keychain, set `INBOT_TEST_MEMORY_KEYCHAIN=1`. It requires an explicit `--home` and the development flavor, refuses the default homes, and the key is lost when the process exits, so the home cannot be reopened.

## Documentation

The documentation lives in `apps/docs` and is built with Blume, a Markdown documentation framework on Astro. It shares its design tokens with the web app through `packages/design`.

```sh
pnpm docs:dev     # build, then preview with hot reload
pnpm docs:build   # build, then write the static site to apps/docs/dist
```

`docs/reference/cli.md` is generated from `inbot --help` on every docs build; do not edit it by hand.
