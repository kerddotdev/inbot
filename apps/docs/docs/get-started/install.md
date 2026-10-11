---
title: Install Inbot
description: Requirements, supported platforms, what the checksum-verifying installers do, what gets installed, and how to upgrade or remove Inbot.
---

No release has been published yet. The installers described here are implemented and tested against [locally built archives](/development/packaging), and they will work once the first release appears on [GitHub Releases](https://github.com/kerddotdev/inbot/releases). Until then, [build from source](/development/build).

## Requirements

| Requirement      | Details                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Operating system | macOS (Apple Silicon or Intel), Linux with glibc (x64 or ARM64), Windows x64. Alpine and other musl distributions are not supported.      |
| Credential store | The OS keychain holds the key that unlocks your database. On Linux this needs a working Secret Service, such as GNOME Keyring or KWallet. |
| Mail provider    | A Cloudflare account with a zone for your domain. See [Mail transport](/guides/transport).                                                |
| Node.js          | Not needed for release archives, which bundle Node.js 24.21.0. Source builds need Node.js 24.21.0 or newer (below 25) and pnpm 10.24.0.   |

Release archives are only smoke-tested on macOS and Linux. Windows archives are built and installable, but not yet smoke-tested.

## macOS and Linux

```sh
sh install.sh
# Or pick a version:
sh install.sh --version 0.1.0
```

The installer needs `curl`, `tar`, and `sha256sum` or `shasum`. It:

1. Asks GitHub for the latest release, unless you pass `--version`.
2. Downloads `SHA256SUMS` and `inbot-<version>-<os>-<arch>.tar.gz`.
3. Refuses to continue unless the archive's SHA-256 matches its line in `SHA256SUMS`, every entry stays inside the archive's `inbot/` folder, and the launcher, runtime and CLI are present.
4. Extracts into `~/.local/share/inbot/app/<version>` and writes an `~/.local/bin/inbot` shim.

It does not change your `PATH`. If `~/.local/bin` is not on it, the installer prints the directory to add. It never installs a background service.

| Option                 | Environment variable     | Default                  |
| ---------------------- | ------------------------ | ------------------------ |
| `--version <x.y.z>`    |                          | Latest published release |
| `--install-root <dir>` | `INBOT_INSTALL_ROOT`     | `~/.local/share/inbot`   |
| `--bin-dir <dir>`      | `INBOT_BIN_DIR`          | `~/.local/bin`           |
|                        | `INBOT_RELEASE_BASE_URL` | GitHub Releases          |

Paths must be absolute. `INBOT_RELEASE_BASE_URL` requires `--version` and accepts an HTTPS URL, a loopback `http://127.0.0.1:` or `http://localhost:` URL, or a `file://` directory, which is how release fixtures are tested.

## Windows

```powershell
.\install.ps1
# Or pick a version:
.\install.ps1 -Version 0.1.0
```

The PowerShell installer performs the same checksum and archive checks on `inbot-<version>-win32-x64.zip`. It installs under `%LOCALAPPDATA%\Programs\inbot\app\<version>`, writes `inbot.cmd` to `%LOCALAPPDATA%\Programs\inbot\bin`, and adds that folder to your user `PATH`. It needs no administrator rights. `-InstallRoot`, `-BinDir` and `-ReleaseBaseUrl` match the Unix options.

## What gets installed

Each archive is self-contained:

| Path                       | Contents                                                                        |
| -------------------------- | ------------------------------------------------------------------------------- |
| `inbot` or `inbot.cmd`     | Launcher                                                                        |
| `runtime/`                 | Node.js 24.21.0, verified against nodejs.org's published checksums at packaging |
| `application/dist`         | Server, CLI, shared packages and the inbound Email Worker bundle                |
| `application/web`          | The owner web app                                                               |
| `application/node_modules` | Production dependencies, including prebuilt SQLite and keychain native modules  |
| `BUILD.json`               | Version, target and integrity values of the bundled runtime and native modules  |

Installed commands default to the production flavor: the home is `~/.inbot`, and `inbot serve` serves the bundled web app. See [Configuration](/operations/configuration) for overrides.

Verify the installed version with `inbot --version` (or `inbot version`); neither command connects to the service.

## Upgrade, downgrade and remove

- **Upgrade:** stop the running `inbot serve`, then run the installer again. Your home directory and database are not touched.
- **Downgrade:** previous versions stay under `app/<version>`. Run the installer with `--version` (or `-Version`) to point the shim back at one.
- **Repeat installs** of the same version and checksum reuse the installed archive and rewrite the shim. A different archive under an existing version number is refused.
- **Remove:** delete the install root and the shim. Your mail lives in the home directory (`~/.inbot`), which you remove separately, together with its keychain entry, only if you want the data gone. See [Running the service](/operations/service#back-up-your-home) before deleting anything.

There is no automatic update and no `inbot update` command.

## Next

Continue with the [quickstart](/get-started/quickstart).
