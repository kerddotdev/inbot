---
title: Packaging and releases
description: Build release archives for every platform, smoke-test them locally, and how the release workflow publishes drafts.
---

## Build archives

Packaging runs on macOS or Linux with Node.js exactly 24.21.0, pnpm 10.24.0, `tar`, `zip` and `unzip`:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm package
# One or more targets:
pnpm package --target darwin-arm64 --target linux-x64
```

| Option            | Meaning                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| `--target <name>` | `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64` or `win32-x64`; repeatable. Default: all five. |
| `--output <dir>`  | Release directory, default `dist-release`                                                               |
| `--skip-build`    | Reuse an existing complete build                                                                        |

The output is `inbot-<version>-<target>.tar.gz` (Windows: `.zip`) plus `SHA256SUMS`. One machine can build all five targets: Node.js runtimes are downloaded and verified against nodejs.org's `SHASUMS256.txt`, and the SQLite and keychain native modules come from official npm prebuilds verified against the lockfile's integrity hashes. Nothing is compiled natively. Download caches live in the output's `.cache` directory and are not part of the release.

See [Install Inbot](/get-started/install#what-gets-installed) for what each archive contains.

## Smoke-test locally

```sh
node scripts/smoke-release.mjs dist-release
INBOT_TEST_RELEASE_DIR=dist-release pnpm test:packaging
```

The smoke test extracts the archive for your machine, checks the launcher and native modules, starts the service with a temporary home and the memory keychain, queries `/v0/owner/status` and the web app, and stops only the process it started. The installer tests use temporary install roots and cover repeat installs, upgrades and checksum refusal, optionally installing the real archive from a local release directory.

## Release workflow

The GitHub release workflow runs on Vectis runners. A `v*` tag must match the version in `package.json`. It packages all targets, smoke-tests Linux ARM64 natively, Linux x64 under QEMU emulation on the ARM64 Ubuntu runner, and macOS ARM64, and creates a **draft** GitHub release with the archives and checksums. Publishing is a manual review step, and published versions are never modified.

No release has been published yet.
