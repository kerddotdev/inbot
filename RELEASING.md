# Releasing Inbot

This is the maintainer runbook for CI and releases. Contributors only need [CONTRIBUTING.md](CONTRIBUTING.md). No release has been published yet.

## Runners

Every job runs in a disposable Vectis VM on a maintainer's Mac:

| Label                     | Environment                                                       | Used by                                                                                 |
| ------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `vectis-ubuntu`           | Ubuntu 24.04, environment ID `ubuntu`                             | Linux checks, packaging all six targets, Linux ARM64/x64 smoke, PR metadata, publishing |
| `vectis-macos-26-arm64`   | macOS 26 with Xcode and its license accepted, ID `macos-26-arm64` | macOS checks, Developer ID signing, notarization, signed ARM64 smoke                    |
| `vectis-windows-11-arm64` | Windows 11 ARM64, ID `windows-11-arm64`                           | Windows checks, ARM64 and emulated x64 smoke, PowerShell installer tests                |

Connect `kerddotdev/inbot` to these environments through the Vectis GitHub App and enable automatic runners. Labels are `vectis-` followed by the environment ID. Keep labels and required check names aligned when changing environments. Windows smoke installs the official Microsoft Visual C++ v14 ARM64 and x64 runtimes only inside its disposable guest.

## Repository settings once public

Apply these settings before accepting external contributions or cutting the first public release:

1. Import [.github/rulesets/main.json](.github/rulesets/main.json) and [.github/rulesets/release-tags.json](.github/rulesets/release-tags.json) in **Settings > Rules > Rulesets**. Required checks are `check (linux)`, `check (macos)`, `check (windows)` and `pr-title`. Main requires a PR, resolved review threads and squash merges. Only administrators can create release tags; nobody should rewrite or delete a published tag.
2. In **Settings > Actions > General**, require approval for fork PR workflows from **all external contributors**, keep the default workflow token **read-only**, and disable the option allowing fork workflows write tokens. Review the exact commit before approving a fork run. Self-hosted execution remains a trust decision even in disposable VMs; never approve unknown code blindly.
3. In **Settings > Code security**, enable private vulnerability reporting, secret scanning with push protection and Dependabot alerts.
4. Enable squash merges only, using the PR title as the commit message.
5. Restrict the `release` environment to tags matching `v*`. Environment approval, if configured, happens before jobs can use signing secrets or publish. Leave required reviewers unset if releases must complete without an approval click.

Workflows use `pull_request`, never `pull_request_target`. Checkouts do not persist credentials. The size label job only runs for branches in this repository because fork tokens cannot write labels. CI has read-only permissions; only publishing receives `contents: write`, `id-token: write` and `attestations: write`.

The JSON rulesets are import templates, not applied settings. The `release` environment and signing values already exist; do not recreate or print them. GitHub Free supports these rulesets and artifact attestations for public repositories. Private-repository attestations require GitHub Enterprise Cloud; make the repository public before the first release unless that plan is available.

## Release environment

| Kind     | Name                         | Purpose                                                              |
| -------- | ---------------------------- | -------------------------------------------------------------------- |
| Secret   | `MACOS_CERTIFICATE_P12`      | Base64 Developer ID Application certificate and private key (`.p12`) |
| Secret   | `MACOS_CERTIFICATE_PASSWORD` | Password for that `.p12`                                             |
| Secret   | `APPLE_API_KEY_P8`           | App Store Connect API key contents (`.p8`)                           |
| Variable | `APPLE_API_KEY_ID`           | App Store Connect key ID                                             |
| Variable | `APPLE_API_ISSUER`           | App Store Connect issuer ID                                          |
| Variable | `MACOS_SIGNING_IDENTITY`     | `Developer ID Application: Daniel Kerekes (7LA5DMHTL9)`              |

The signing job imports the certificate with `security import` into a temporary keychain. This supports the existing legacy RC2-encrypted P12 without converting it through OpenSSL. The keychain, certificate file and API key file are removed by an `always()` cleanup step; Vectis disposes of the VM afterwards. No signing material is uploaded with artifacts or cached.

## Cut a release

1. Open a PR titled `chore(release): vX.Y.Z`. Set the root `package.json` version to `X.Y.Z` and update its root importer in `pnpm-lock.yaml` if needed. Add curated notes to `CHANGELOG.md` under `## [X.Y.Z]` or `## X.Y.Z`. For 0.1.0, replace `(unreleased)` with the planned publication date and review the capability summary. Run `pnpm check`, review the generated license index and `THIRD_PARTY_NOTICES.md` before merging. The initial version is already `0.1.0`; the first bump PR can retain it while finalizing its notes. Packaging copies this version into the CLI, application manifest, archive names and `BUILD.json`.
2. Confirm all required redistribution materials are complete. From the reviewed merge commit, create and push the matching tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The tag workflow checks the version, calls the full reusable CI, packages all six targets, verifies Linux and Windows archives and installers, signs and notarizes both macOS archives, and smoke-tests the signed ARM64 archive. Every package build refuses missing dependency license material before any signing or publication. It replaces the unsigned macOS artifacts, rebuilds checksums and attests the final archives and `SHA256SUMS` before publishing a **non-draft** GitHub release. No manual workflow dispatch or separate publication step is needed.
4. Confirm the workflow and release assets succeeded. Stable tags become the latest release; tags containing a hyphen, such as `v0.2.0-rc.1`, become prereleases and do not replace the latest stable release. Installers without an explicit version use the public `releases/latest` endpoint.

Generated release notes use [.github/release.yml](.github/release.yml) categories. The workflow prepends the matching curated changelog section when it exists; a missing file, missing version or empty section falls back to generated notes. It never treats `Unreleased` as the tagged version.

Publishing refuses to modify an already published version. If a run fails before publication, inspect its logs and rerun that tagged workflow after correcting infrastructure. Code changes require a new reviewed version and tag. Never move a published tag or replace its assets.

## Archive licenses

Release archives retain the root `LICENSE`, `THIRD_PARTY_NOTICES.md`, Node's upstream `runtime/LICENSE`, and the generated `licenses/INDEX.md` with exact dependency versions and copied upstream license and notice files. License materials cover production dependencies and components compiled into the owner UI and Email Worker.

`stagePackageNotices` fails every package build if a dependency lacks license material or a declared license. The pinned `unzipper` override removes the former `buffers`, `binary` and `chainsaw` dependencies. Review supplement provenance in `THIRD_PARTY_NOTICES.md` whenever dependency versions change.

Release preparation does not authorize live mail tests, Cloudflare deployment, DNS changes or tunnel creation. Synthetic checks do not establish real mail delivery.

## macOS signing and notarization

`scripts/sign-macos.mjs` finds every Mach-O in both macOS payloads, including Node, native `.node` modules and any bundled executable such as `cloudflared`. All receive Developer ID signatures, hardened runtime and secure timestamps. Node alone receives `allow-jit` and `allow-unsigned-executable-memory`, matching the Vectis Node signing policy. Native addons are signed with the same identity, so library validation remains enabled. Debugging, dyld environment and executable page protection exceptions are not granted.

The script verifies each binary with `codesign --verify --strict --deep`, submits a ZIP of the signed payload using `xcrun notarytool submit --wait`, requires `Accepted`, and fetches the notary log even on rejection. The published tarball contains those exact signed binaries. Standalone CLI executables and tar archives cannot carry a stapled ticket: Gatekeeper verifies notarization online when assessing downloaded code. A raw CLI binary's `spctl --assess --type execute` result is not an app-bundle assessment; the notary submission status and log are the release gate.

Local signing verification, with a Developer ID identity already available, requires no API key and does not contact the notary service:

```sh
pnpm package --target darwin-arm64
node scripts/sign-macos.mjs dist-release --identity 'Developer ID Application: Name (TEAMID)'
INBOT_TEST_SIGNED_RELEASE_DIR=dist-release node --test scripts/macos-signing.test.mjs
node scripts/smoke-release.mjs dist-release
INBOT_TEST_RELEASE_DIR=dist-release pnpm test:packaging
```

These checks use temporary homes and an in-memory test keychain. Signing itself uses the explicitly supplied Developer ID identity. They do not access Inbot keychain items, real mail, Cloudflare infrastructure or the owner's Inbot home. Local signing is not notarization; only the tagged release job exercises Apple's service.

To verify published provenance, use `gh attestation verify <archive> --repo kerddotdev/inbot`. Installers verify SHA-256 checksums; they do not perform this additional provenance check automatically.

## Windows installation

From a checkout, run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1`. See [README.md](README.md#install) for the download one-liner and version selection.

Before installing or changing the shim, the installer runs the bundled Node and loads both native modules, opening only an in-memory SQLite database. If the native runtime cannot load, it stops with the official architecture-specific Microsoft Visual C++ v14 Redistributable URL and asks the user to install or repair it and restart if requested. The installer deliberately leaves the administrator-level runtime installation to the user. Existing installations and PATH remain unchanged on prerequisite failure. See [Microsoft's runtime downloads](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist/) for supported versions.
