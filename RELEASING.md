# Releasing Inbot

This is the maintainer runbook for releases. Contributors only need [CONTRIBUTING.md](CONTRIBUTING.md).

## How CI runs

All workflows use disposable Vectis runners: `vectis-ubuntu` for Linux checks and packaging, and `vectis-macos-26-arm64` for macOS checks and archive smoke tests. Native addons are tested on both systems. Windows archives are inspected for their target architecture; the workflow does not run a Windows smoke test.

## Repository settings

After the repository is public:

1. Import `.github/rulesets/main.json` and `.github/rulesets/release-tags.json` in **Settings > Rules > Rulesets**. Required checks are `check (linux)`, `check (macos)`, and `pr-title`. The main rules have no bypass; only admins create release tags.
2. In **Settings > Actions > General**, require approval for fork pull request workflows from all external contributors and keep the default workflow token read-only.
3. In **Settings > Code security**, enable private vulnerability reporting, secret scanning with push protection, and Dependabot alerts.
4. Allow squash merges with the pull request title as the commit message.

## Cut a release

1. Open a release PR with the root `package.json` version. For 0.1.0, replace `(unreleased)` in `CHANGELOG.md` with the publication date and review its capability summary. Run `pnpm check` and review license materials before merging.
2. With explicit maintainer authorization, tag the merge commit `vX.Y.Z` and push that tag. Manual dispatch of `.github/workflows/release.yml` uses the package version instead; a tag must match it.
3. The workflow builds all five archives with pinned Node and native addons, verifies archive contents and installers, and smoke-tests Linux and macOS. It creates a draft GitHub release containing the archives, `SHA256SUMS`, and generated notes. It refuses to change a published version.
4. Review the draft notes and the first-release summary, archive license index, checksums, and smoke results. Resolve every publication blocker in `THIRD_PARTY_NOTICES.md` before publishing; a successful package build does not clear those gaps. Mark a prerelease explicitly if applicable. Publish only after explicit maintainer approval.

Release preparation does not authorize live mail tests, Cloudflare deployment, DNS changes, or tunnel creation. Synthetic checks do not establish real mail delivery. Published versions are never modified; fixes need a new version.
