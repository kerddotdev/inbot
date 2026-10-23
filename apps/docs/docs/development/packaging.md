---
title: Packaging and releases
description: Build release archives for every platform, smoke-test them locally, and how the release workflow signs, notarizes, attests and publishes archives.
---

## Build archives

Packaging runs on macOS or Linux with Node.js exactly 24.22.1, pnpm 10.24.0, `tar`, `zip` and `unzip`:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm package
# One or more targets:
pnpm package --target darwin-arm64 --target linux-x64
```

| Option            | Meaning                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| `--target <name>` | `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64` or `win32-arm64`; repeatable. Default: all six. |
| `--output <dir>`  | Release directory, default `dist-release`                                                                             |
| `--skip-build`    | Reuse an existing complete build                                                                                      |

The output is `inbot-<version>-<target>.tar.gz` (Windows: `.zip`) plus `SHA256SUMS`. One machine can build all six targets: Node.js runtimes are downloaded and verified against SHA-256 pins in `scripts/package.mjs`. Packaging also fetches nodejs.org's `SHASUMS256.txt` and fails if any pinned checksum disagrees. The SQLite and keychain native modules come from official npm prebuilds verified against the lockfile's integrity hashes. Nothing is compiled natively. Download caches live in the output's `.cache` directory and are not part of the release.

See [Install Inbot](/get-started/install#what-gets-installed) for what each archive contains.

## Smoke-test locally

```sh
node scripts/smoke-release.mjs dist-release
INBOT_TEST_RELEASE_DIR=dist-release pnpm test:packaging
```

The smoke test extracts the archive for your machine, checks the launcher and native modules, starts the service with a temporary home and the memory keychain, queries `/v0/owner/status` and the web app, and stops only the process it started. The installer tests use temporary install roots and cover repeat installs, upgrades and checksum refusal, optionally installing the real archive from a local release directory.

## Release workflow

The GitHub release workflow runs on Vectis runners when a `v*.*.*` tag is pushed. The tag must match `package.json`. It runs the full CI checks, builds all six targets, and validates Linux ARM64 natively, macOS ARM64, Windows 11 ARM64 natively and Windows x64 under emulation on the Windows 11 ARM64 runner. Linux x64 archives get archive content checks only, and macOS Intel is signed and notarized, but neither has a dedicated runtime smoke job. macOS is the most validated platform; these CI checks do not establish real mail delivery on every platform.

Both macOS archives are Developer ID signed and notarized. Checksums are rebuilt after the signed archives replace the unsigned ones. The workflow attests the final archives and `SHA256SUMS`, then publishes a public GitHub release with curated notes when available and generated notes. Stable tags become the latest release; version tags containing a hyphen are marked as prereleases. An already published version is never modified.

The workflow uses the GitHub `release` environment for signing and publication. Signing credentials stay in a temporary runner keychain and are removed afterward. Local `pnpm package` builds unsigned archives; it does not publish, sign or notarize them.

## Verify a downloaded release

Download the archive and `SHA256SUMS` from [GitHub Releases](https://github.com/kerddotdev/inbot/releases). On Linux, run `sha256sum --ignore-missing -c SHA256SUMS`; on macOS, run `shasum -a 256 --ignore-missing -c SHA256SUMS`. On Windows, use `Get-FileHash -Algorithm SHA256` and compare the archive's hash with its exact filename in `SHA256SUMS`. The installers perform that checksum comparison automatically.

Verify the archive's build provenance separately:

```sh
gh attestation verify ./inbot-<version>-<target>.tar.gz --repo kerddotdev/inbot
```

Replace the placeholders with the downloaded filename; Windows archives use `.zip`. You can verify `SHA256SUMS` with the same command. The [GitHub CLI reference](https://cli.github.com/manual/gh_attestation_verify) explains the verification output and authentication requirements. The installer does not perform attestation verification. Apple signing and notarization, checksums and provenance protect different boundaries; none substitutes for an independent audit.

## Runtime updates

`inbot update` and the automatic service updater share release lookup, semantic
version ordering, SHA-256 verification, staging, layout validation and launcher
activation. The release scripts import the same checksum verifier. Release lookup
uses GitHub's stable latest release unless a version is explicitly requested.
The runtime downloads only from `kerddotdev/inbot`; it has no configurable mirror.
Tests inject fake network and process adapters instead.

The updater requires the installer's `app/<version>` layout and archive marker.
New installers record the shim in `installation.json`; older installations can
identify it through PATH. Versions are installed alongside one another and the
shim is replaced by a same-directory rename. A different archive under an existing
version is rejected. Updates serialize through an install-root lock. An interrupted
updater may leave `.update-lock`; remove it only after confirming no updater is
running. Previous versions are never deleted automatically.

On macOS, activation additionally requires `codesign --verify --strict` and
`TeamIdentifier=7LA5DMHTL9` on the bundled Node binary. Local unsigned packages are
therefore intentionally rejected by the updater. This is not a fresh notarization
check and does not replace independent provenance verification. Neither the
installers nor the updater automatically verifies GitHub attestations.

Automatic checks run 30-60 seconds after service startup, then every 3.5-4 hours
with jitter. A service host starts the version selected by the shim and provides
an IPC channel identifying managed execution. The updater also observes the
service registration before enabling its scheduler. It downloads while the server
runs, then uses the existing scoped shutdown path before activating. Exit status
75 asks launchd, systemd or Task Scheduler to restart the service. The bootstrap
host's original package remains required until service reinstall rewrites its paths.
The next successful server startup records `updated`; a restart request alone is
only `restarting`. The latest check, result and failure are persisted in the home.

Database migrations run on the new server's startup. Rollback to an older version
after migration is unsupported, even though previous packages are retained.
