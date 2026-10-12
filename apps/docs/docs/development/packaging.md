---
title: Packaging and releases
description: Build release archives for every platform, smoke-test them locally, and how the release workflow signs, notarizes, attests and publishes archives.
---

## Build archives

Packaging runs on macOS or Linux with Node.js exactly 24.21.0, pnpm 10.24.0, `tar`, `zip` and `unzip`:

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

The output is `inbot-<version>-<target>.tar.gz` (Windows: `.zip`) plus `SHA256SUMS`. One machine can build all six targets: Node.js runtimes are downloaded and verified against nodejs.org's `SHASUMS256.txt`, and the SQLite and keychain native modules come from official npm prebuilds verified against the lockfile's integrity hashes. Nothing is compiled natively. Download caches live in the output's `.cache` directory and are not part of the release.

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
