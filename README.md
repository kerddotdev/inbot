# Inbot

Self-hosted, privacy-first email for AI agents. Each agent gets its own inbox on your custom domain, mail is stored encrypted on your own machine, and agents reach it through MCP, a CLI, or a REST API. An optional Cloudflare Tunnel lets cloud-hosted agents reach your local instance with scoped credentials. The mail provider still sees plaintext in transit: Inbot is zero-knowledge at rest, not end-to-end encrypted.

[Documentation](https://inbot.kerd.dev/docs) covers installation, the owner app, agent connections and the security model. Inbot 0.1.0 includes encrypted inbound buffering, durable outbound sending, scoped API keys and OAuth, owner approval, signed webhooks, live events and optional remote access. Domain verification requires public DNS and an observed encrypted self-test before reporting success.

## Install

Install the latest release on macOS or Linux:

```sh
curl -fsSL https://inbot.kerd.dev/install.sh | sh
```

On Windows 11 x64 or ARM64:

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://inbot.kerd.dev/install.ps1 | iex"
```

`-ExecutionPolicy Bypass` applies only to this PowerShell process and does not change the machine's saved execution policy. Windows native modules require the Microsoft Visual C++ v14 Redistributable; the installer checks them and reports a download link if they cannot load, rather than installing the runtime automatically.

Archives bundle Node.js 24.21.0, so no separate Node installation is needed. See the [install guide](https://inbot.kerd.dev/docs/get-started/install) for `--version <version>` / `-Version <version>`, custom paths, verification and removal.

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
`--bin-dir` are also supported. Windows accepts `-InstallRoot`, `-BinDir`,
`-ReleaseBaseUrl` and `-NoPathUpdate`. Paths must be absolute.

## First steps

You need an OS credential store and a Cloudflare account with an active zone for your domain. On the first start, open the printed loopback URL, enter the one-time setup code and choose an owner password. Configure Settings > Mail transport, provision a dedicated mail subdomain from Domains, and wait for its encrypted self-test. Verification can take about ten minutes or longer; probes retry every five minutes. Then create an inbox from Mail > New inbox and a scoped API key. New web grants default to Full access with approval and no selected inboxes. See the [quickstart](https://inbot.kerd.dev/docs/get-started/quickstart) and [agent connections](https://inbot.kerd.dev/docs/agents/connect).

Use a fixed `--port` for saved agent configurations. Otherwise `serve` chooses a random port on each start. Run `inbot --version` or `inbot version` to inspect the package version without connecting.

## Platform coverage

| Target              | Archive        | Release workflow smoke coverage           |
| ------------------- | -------------- | ----------------------------------------- |
| macOS ARM64         | `darwin-arm64` | Native                                    |
| macOS Intel         | `darwin-x64`   | No dedicated smoke job                    |
| Linux ARM64 (glibc) | `linux-arm64`  | Native on the ARM64 Ubuntu runner         |
| Linux x64 (glibc)   | `linux-x64`    | QEMU emulation on the ARM64 Ubuntu runner |
| Windows 11 ARM64    | `win32-arm64`  | Native on the Windows 11 ARM64 runner     |
| Windows 11 x64      | `win32-x64`    | Emulation on the Windows 11 ARM64 runner  |

macOS is the most validated platform. Windows 11 x64 and ARM64 are supported with CI validation as shown above. Archives include native addon prebuilds; archive availability does not establish mail delivery or keychain support on every platform. Linux requires a working Secret Service. musl distributions are unsupported.

## Remove an installation

Run `inbot service uninstall` if you installed a background service, or stop the foreground process, before removing installed files. On macOS and Linux, delete the install root (`~/.local/share/inbot` by default, including retained versions) and the shim (`~/.local/bin/inbot`). On Windows, remove `%LOCALAPPDATA%\Programs\inbot` and its `bin` entry from your user PATH. Remove any Inbot-specific PATH entry you added, but keep shared bin directories used by other tools. Custom install roots and shims must be removed at their actual locations. See the [uninstall guide](https://inbot.kerd.dev/docs/get-started/install#uninstall).

Installed files are separate from mail and keys. Removing them leaves the home (`~/.inbot` by default) and its OS keychain entry intact. Back up the complete home while the service is stopped before any data deletion. Do not remove `keys.json` or the keychain item if you want to retain access to the encrypted database; there is no passphrase startup or recovery command.

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

The tag-triggered release workflow runs CI and archive smoke tests on Vectis runners, signs and notarizes both macOS archives, rebuilds checksums for the final assets, and adds GitHub build provenance attestations. It publishes a public GitHub release with release notes and refuses to modify an already published version. Stable tags become the latest release; tags containing a hyphen become prereleases. Local packaging produces unsigned archives. See [RELEASING.md](RELEASING.md) for the maintainer runbook and [Packaging and releases](https://inbot.kerd.dev/docs/development/packaging) for the exact platform coverage and `gh attestation verify` commands.

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

## Current limitations

- Automatic updates are unavailable. Packaged builds support per-user background services; source checkouts run `serve` in the foreground.
- Unlock uses the OS keychain. No CLI, API or web passphrase unlock is available.
- The owner app sanitizes HTML in a sandboxed frame, displays same-message raster CID images, and requires per-message consent for remote images. Agents receive HTML as stored.
- Local owners can review, retry or permanently delete quarantined inbound mail through REST, the CLI and Settings. Acknowledged invalid Queue items retain metadata only and cannot be retried.
- The CLI covers REST resource operations, including search, updates, deletion, batch operations, downloads, domains and transport. Owner browser authentication and OAuth protocol/consent flows use their dedicated interfaces.
- Inbound ciphertext survives host downtime, but provider delivery reports have only five-minute Queue retention and unmatched reports are not reconciled.
- There is no password reset, export or managed backup. See [service operations](apps/docs/docs/operations/service.md).

## License

Inbot is licensed under the [MIT License](LICENSE). Release archives include the license and [third-party notices](THIRD_PARTY_NOTICES.md).
