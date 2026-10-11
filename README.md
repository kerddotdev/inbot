# Inbot

Self-hosted, privacy-first email for AI agents. Each agent gets its own inbox on your custom domain, mail is stored encrypted on your own machine, and agents reach it through MCP, a CLI, or a REST API. An optional Cloudflare Tunnel lets cloud-hosted agents reach your local instance with scoped credentials. The mail provider still sees plaintext in transit: Inbot is zero-knowledge at rest, not end-to-end encrypted.

Status: early development. The encrypted storage foundation, mailbox service, [inbound ingestion and encrypted buffer pulling](apps/server/src/inbound/README.md), [authenticated loopback HTTP API](apps/server/src/http/README.md), [authenticated CLI](apps/cli/README.md), shared [age envelope package](packages/envelope/README.md), [inbound Email Worker handler](apps/worker/README.md), [owner browser authentication and static UI serving](apps/server/src/http/README.md#owner-browser-authentication), drafts with owner approval and scheduled sending, and [delivery Queue consumer](apps/server/src/outbound/README.md#delivery-queue-consumer) exist. The [owner UI](apps/web/README.md) connects authentication, mail, API keys, approvals, domains, mail transport settings, and allow/block lists to the local API. The [durable event log, signed webhooks and authenticated WebSocket](apps/server/src/events/README.md) provide live updates. Optional [remote access](apps/server/src/remote/README.md) connects cloud agents through a supervised, verified Cloudflare Tunnel. Other settings still use mock data. Installable archives and checksum-verifying installers are implemented. Releases have not been published yet; live mail validation remains planned.

## Install

Releases have not been published yet. The installers below work once a release
is published in [kerddotdev/inbot](https://github.com/kerddotdev/inbot/releases).
They include Node 24.21.0, so no separate Node installation is needed.

From a source checkout, run the installer for your platform:

```sh
sh install.sh
# Or select a published version:
sh install.sh --version 0.1.0
```

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
# Or select a published version:
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Version 0.1.0
```

Once the repository is public, download and run the Windows installer in PowerShell:

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/kerddotdev/inbot/main/install.ps1 -OutFile "$env:TEMP\inbot-install.ps1"; powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\inbot-install.ps1"
```

Installers select the latest published stable release by default; prereleases require an explicit version.
Windows checks the bundled Node and native addons before installation. If the Microsoft Visual C++ v14 runtime is missing or cannot load, it stops with an architecture-specific [official Microsoft download](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist/) link. Install or repair that runtime, restart if requested, and rerun the installer. Installing the runtime can require administrator approval; the Inbot installer does not install it automatically.

macOS and Linux install under `~/.local/share/inbot/app/<version>` with an
`~/.local/bin/inbot` shim. Windows installs under
`%LOCALAPPDATA%\Programs\inbot\app\<version>` and adds its `bin` directory to
the user PATH. No administrator privileges or automatic service installation
are required. Installers verify the release's `SHA256SUMS` before extraction,
retain previous versions, and safely repeat an installation of the same asset.
On Unix, add `~/.local/bin` to PATH if the installer requests it.

```sh
inbot serve --init --port 8025
```

Packaged commands default to the production home (`~/.inbot`), and `serve`
serves the bundled owner UI. Complete owner setup, stop the foreground process,
then run `inbot service install` to start a per-user background service at login
with restart on failure and fixed port 8025. Use `inbot service status --json`
to inspect observed manager state and HTTP health. `inbot service uninstall`
stops and removes only the service, retaining mail, logs, and keychain entries.
Use the same `--home` or `INBOT_HOME` for all three; install accepts `--port`
for a different fixed port. Custom and development homes get distinct unit names.
See the [background service reference](apps/cli/README.md#background-service-local-owner)
for platform requirements, logs, setup codes, and errors. Initialization uses the
OS keychain; install requires an initialized keychain home. Linux needs a working
user systemd session and Secret Service credential store. Headless passphrase
startup remains planned. Linux archives target glibc distributions, not Alpine/musl.

Uninstall the background service (or stop the foreground process), re-run the
installer to upgrade, then run `inbot service install` again with the same home
and port. The service pins the installing package's executable paths.
To select an earlier retained version, re-run with `--version` (or `-Version`).
`INBOT_INSTALL_ROOT` and `INBOT_BIN_DIR` override both install destinations;
`INBOT_RELEASE_BASE_URL` with an explicit version selects an HTTPS asset directory
or a local `file://`/loopback HTTP fixture. On Unix, flags `--install-root` and
`--bin-dir` are also supported. Windows accepts `-InstallRoot`, `-BinDir` and
`-ReleaseBaseUrl`. Paths must be absolute.

## Packaging

On macOS or Linux, install Node 24.21.0, pnpm 10.24.0, `tar`, `zip` and `unzip`:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm package
# One or more targets; each invocation also builds server, CLI, Worker and UI:
pnpm package --target darwin-arm64 --target linux-x64
```

The targets are `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`,
`win32-x64` and `win32-arm64`. Output is `dist-release/inbot-<version>-<target>.tar.gz` (Windows:
`.zip`) plus `SHA256SUMS`. A single macOS or Linux machine can build all six.
Each archive contains the pinned Node runtime verified against nodejs.org's
`SHASUMS256.txt`, the compiled application and shared packages, the provisioner's
`dist/worker/inbound.js`, the owner UI and frozen-lockfile production dependencies.
SQLite and keyring prebuilds come from official npm tarballs verified against the
lockfile's SHA-512 integrity. No native compilation or new dependency is required.
`BUILD.json` records target, version and source integrity values.

Archives include Inbot's `LICENSE`, `THIRD_PARTY_NOTICES.md`, Node's upstream
license, and a generated `licenses/INDEX.md` with dependency license materials.
Packaging rejects dependencies with missing license declarations or materials.
See [RELEASING.md](RELEASING.md)
for the maintainer checklist and generated GitHub release notes.

`--skip-build` reuses an existing complete build; `--output` changes the release
directory. Download caches are stored under the output's `.cache` directory and
are excluded from release assets. For a local, keychain-free startup check:

```sh
node scripts/smoke-release.mjs dist-release
INBOT_TEST_RELEASE_DIR=dist-release pnpm test:packaging
```

The smoke script extracts the host archive, checks the launcher and native addon
imports, starts with a temporary explicit home and memory keychain, queries
`/v0/owner/status` and the UI, then stops only its own captured PID. Unix shutdown
is graceful; Windows terminates the bundled Node process directly. Installer
tests use temporary roots, cover idempotence, upgrades and checksum refusal, and
optionally install the actual host archive from a local release directory.
On Windows, run `node --test scripts/install-windows.test.mjs` with
`INBOT_TEST_RELEASE_DIR` set to the release directory. These tests pass
`-NoPathUpdate` so the installer leaves the user PATH untouched.

The tag-only release workflow runs the full reusable CI on Vectis before packaging.
It verifies Linux ARM64/x64 and Windows ARM64/x64 archives and installers, signs every Mach-O in both macOS archives with Developer ID and hardened runtime, notarizes both payloads, and smoke-tests the signed macOS ARM64 archive. Checksums are rebuilt after signing, and provenance attestations cover the final archives and checksums. The workflow publishes a non-draft release with generated notes and the matching curated `CHANGELOG.md` section when available. Tags containing a hyphen become prereleases. Published versions are never modified.

CLI binaries cannot be stapled; Gatekeeper verifies their notarization online.
See [RELEASING.md](RELEASING.md) for runners, signing, release notes and repository settings.

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
`connection.json`. Sending and domain provisioning require a configured Cloudflare
transport. Configure and verify it in Settings > Mail transport or through the
owner-only `GET`, `PUT`, and `DELETE /v0/owner/transport` routes. See the
[required token permissions](apps/server/src/provision/README.md#token-permissions).
Draft CRUD, owner approval, scheduled sending, [allow/block lists](apps/server/src/lists/README.md), webhook CRUD and event streams are implemented. Passphrase startup remains planned. Before
password setup, the server prints a one-time owner setup code. Browser sessions
require CSRF on unsafe requests. Build the owner UI with `pnpm web:build`
and pass `--web-root /absolute/path/to/apps/web/dist` to serve it on the loopback origin.

Inbound and delivery pulling require internal encrypted buffer configuration and
the existing Cloudflare transport token. `serve` starts their scoped loops after
unlock, including startup and periodic inbound reconciliation. Transport configuration changes take effect on the next runner cycle without a restart. Inbound R2 stores ciphertext only; provider-generated delivery
events can contain plaintext subjects in their Queue until acknowledged. See the
linked consumer documentation for configuration, quarantine, and API boundaries.

The owner-only [domain API and subdomain provisioner](apps/server/src/provision/README.md)
plan and provision Cloudflare infrastructure with apex DNS protection, encrypted
self-test verification, exact teardown, and durable inbox routing jobs.
`pnpm build` ships a single Worker bundle; real-account deployment is not part of
build or tests.

## Documentation

The documentation site lives in `apps/docs`. Run `pnpm docs:dev` for a local preview or `pnpm docs:build` for a static build in `apps/docs/dist`.

## CLI

After `pnpm build`, use `pnpm start:cli --help` in a source checkout. The root
package exposes the `inbot` binary from `dist/apps/cli/src/main.js` when linked
or installed. `inbot serve` delegates to the existing server with identical flags.

Resource commands read the owner's `connection.json` from the same home as the
server. Agents instead set both `INBOT_URL` and `INBOT_API_KEY` for scoped bearer
authentication. Use `--json` for wire JSON, `--help` on every command, and retain
the idempotency key printed to stderr before sends. `inbot open` prints an
owner-only single-use login link; only `--browser` opens it. API key and webhook creation
print one-time secrets only with explicit `--show-secret`. `inbot webhooks ...` manages
signed receivers; `inbot events --follow --json` tails authorized events.

See the [CLI reference](apps/cli/README.md) for resource commands, payload flags,
pagination, and stable exit codes, or the [agent CLI guidance](skills/inbot/references/cli.md).
