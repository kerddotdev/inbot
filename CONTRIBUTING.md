# Contributing to Inbot

Thanks for helping. Read [AGENTS.md](AGENTS.md) first: it describes what Inbot never compromises on and applies to human and agent contributors alike.

## Before you start

- Open an issue before large changes so we can agree on the approach.
- Keep each pull request to one concern. If the description says "also", split it.
- Report security problems privately, as described in [SECURITY.md](SECURITY.md).

## Development

Use Node 24.22.1 and pnpm 10.24.0:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

Always pass `--home` or set `INBOT_HOME` to a fresh temporary directory. Never read or modify `~/.inbot`, `~/.inbot-dev`, or real Inbot keychain items. Tests use their own `mkdtemp` homes, synthetic mail, and fakes for the keychain, Cloudflare API, DNS, and clock.

For a local UI smoke check with the test-only memory keychain:

```sh
pnpm web:build
INBOT_TEST_MEMORY_KEYCHAIN=1 pnpm start:server --home "$(mktemp -d)" --port 0 --init --flavor development --web-root "$PWD/apps/web/dist"
```

That home cannot be reopened after the process exits. Never run `service install`, `service uninstall`, or updates against a real installation during development. Never send real mail, provision Cloudflare resources, upload the Email Worker, change DNS, or create tunnels as part of tests.

Before pushing, run `pnpm check`. Keep verification proportional to the change and test the affected behavior and permission boundaries. Packaging changes also need `pnpm test:packaging` and archive verification as described in [README.md](README.md#packaging). Keep one workspace lockfile and do not add automatic Git hooks or install-time scripts that rewrite repository files.

## Pull requests

- Changes reach `main` only through pull requests. Never commit directly to `main`.
- Use small, logically complete commits with conventional titles and no commit body, for example `fix(inbound): keep envelopes until the store commits`.
- Use a conventional PR title. Explain the problem in a sentence or two, then how you fixed it.
- Rebase an unpublished branch onto the latest `main` before opening a real, non-draft PR. Agree with collaborators before rewriting a shared or published branch.
- Cover every affected surface: contract, service, REST, MCP, CLI, web, events, permissions, remote access, reverse states, and docs. Owner-only behavior must never become an agent tool.
- Preserve unrelated changes. Write code, documentation, and commit messages in English, using ordinary ASCII hyphens.
- Opening a PR does not authorize merging, deploying, publishing packages, pushing tags, or creating releases.

## CI

CI runs on Vectis runners in disposable Linux and macOS VMs on a maintainer's Mac. A maintainer must approve workflow runs from external contributors before they start. When the Mac is asleep or busy, checks wait until a runner is available.
