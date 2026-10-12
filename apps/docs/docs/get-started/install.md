---
title: Install Inbot
description: One-line installers, supported platforms, release verification, updates and removal.
---

Install the latest [published release](https://github.com/kerddotdev/inbot/releases) with the command for your platform. Archives include Node.js and the owner web app; no separate Node.js installation is needed.

## Requirements

| Requirement      | Details                                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operating system | macOS (Apple Silicon or Intel), Linux with glibc (x64 or ARM64), or Windows 11 (x64 or ARM64). Alpine and other musl distributions are unsupported.             |
| Credential store | The OS credential store holds the key that unlocks your database. Linux needs a working Secret Service, such as GNOME Keyring or KWallet.                       |
| Mail provider    | A Cloudflare account with an active zone for your domain and Workers Paid for sending. See [Mail transport](/guides/transport).                                 |
| Windows runtime  | The latest Microsoft Visual C++ v14 Redistributable for your architecture. The installer checks native modules and reports a download link if they cannot load. |

macOS is the most validated platform. Windows 11 x64 and ARM64 are supported and validated in CI: ARM64 runs natively, while x64 release archives are smoke-tested under emulation on the Windows 11 ARM64 runner. Linux ARM64 runs natively and x64 archives are tested under QEMU. macOS Intel archives are signed and notarized but have no dedicated runtime smoke job. These are synthetic startup and native-module checks, not evidence of real mail delivery on every platform.

## macOS and Linux

```sh
curl -fsSL https://inbot.kerd.dev/install.sh | sh
```

The installer needs `curl`, `tar`, and `sha256sum` or `shasum`. To inspect the script first, or select a version:

```sh
curl -fsSL https://inbot.kerd.dev/install.sh -o install.sh
sh install.sh --version <version>
```

Replace `<version>` with a published version number. Without `--version`, the installer selects GitHub's latest stable release. It downloads `SHA256SUMS` and `inbot-<version>-<os>-<arch>.tar.gz`, verifies the archive's SHA-256, checks its paths and required files, then installs it under `~/.local/share/inbot/app/<version>`. It writes a launcher shim at `~/.local/bin/inbot`.

The installer does not change `PATH`. If `~/.local/bin` is missing, it prints the directory to add to your shell configuration. It does not install a background service; [`inbot service install`](/operations/service#run-as-a-background-service) does that after initialization and owner setup.

| Option                 | Environment variable     | Default                         |
| ---------------------- | ------------------------ | ------------------------------- |
| `--version <version>`  |                          | Latest published stable release |
| `--install-root <dir>` | `INBOT_INSTALL_ROOT`     | `~/.local/share/inbot`          |
| `--bin-dir <dir>`      | `INBOT_BIN_DIR`          | `~/.local/bin`                  |
| `--help`, `-h`         |                          | Print usage                     |
|                        | `INBOT_RELEASE_BASE_URL` | GitHub Releases                 |

Paths must be absolute. `INBOT_RELEASE_BASE_URL` requires an explicit version and accepts HTTPS, a loopback HTTP URL (`http://127.0.0.1:` or `http://localhost:`), or a `file://` directory for local archive fixtures.

## Windows

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://inbot.kerd.dev/install.ps1 | iex"
```

`-ExecutionPolicy Bypass` applies only to this PowerShell process and does not change the machine's saved execution policy.

To inspect the script first, or select a version:

```powershell
irm https://inbot.kerd.dev/install.ps1 -OutFile install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Version <version>
```

The installer detects x64 or ARM64 Windows, downloads the matching `inbot-<version>-win32-<arch>.zip`, and performs the checksum and archive checks. It probes the bundled Node.js, SQLite and keychain modules before installing. If they fail to load, it stops and asks you to install or repair the latest [Microsoft Visual C++ v14 Redistributable](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist) for your architecture, with a direct download link. It does not install the Redistributable automatically; installing it may need administrator rights or a restart.

Inbot itself installs without administrator rights under `%LOCALAPPDATA%\Programs\inbot\app\<version>`, with an `inbot.cmd` shim in `%LOCALAPPDATA%\Programs\inbot\bin`. That `bin` directory is added to your user PATH and the current process's PATH. The one-line command runs in a child PowerShell process, so open a new terminal before using `inbot` if needed. No background service is registered. Later, `inbot service install` can create a per-user Scheduled Task that runs at logon.

| Option                  | Environment variable     | Default                                                       |
| ----------------------- | ------------------------ | ------------------------------------------------------------- |
| `-Version <version>`    |                          | Latest published stable release                               |
| `-InstallRoot <dir>`    | `INBOT_INSTALL_ROOT`     | `%LOCALAPPDATA%\Programs\inbot`                               |
| `-BinDir <dir>`         | `INBOT_BIN_DIR`          | `%LOCALAPPDATA%\Programs\inbot\bin`                           |
| `-ReleaseBaseUrl <url>` | `INBOT_RELEASE_BASE_URL` | GitHub Releases; requires an explicit version when overridden |
| `-NoPathUpdate`         |                          | Skip both user and process PATH changes                       |

Paths must be absolute. A custom install root does not change the default bin directory; set both options if you want both moved.

## What gets installed

| Path                       | Contents                                                                        |
| -------------------------- | ------------------------------------------------------------------------------- |
| `inbot` or `inbot.cmd`     | Launcher                                                                        |
| `runtime/`                 | Node.js 24.21.0, verified against nodejs.org's published checksums at packaging |
| `application/dist`         | Server, CLI, shared packages and the inbound Email Worker bundle                |
| `application/web`          | Owner web app                                                                   |
| `application/node_modules` | Production dependencies, including prebuilt SQLite and keychain native modules  |
| `BUILD.json`               | Version, target and integrity values of the bundled runtime and native modules  |

Installed commands default to the production flavor: the home is `~/.inbot` (`%USERPROFILE%\.inbot` on Windows), and `inbot serve` serves the bundled web app. The home is separate from the install directory and holds your encrypted mail database and key files. See [Configuration](/operations/configuration).

## Verify

```sh
inbot --version
```

This prints the installed package version without connecting to the service. `inbot version` is equivalent.

The installer verifies checksums before extraction. macOS archives contain Developer ID signed code and are notarized by Apple. Final archives and checksums have GitHub build provenance attestations; verify them separately with `gh attestation verify`. See [Release verification](/development/packaging#verify-a-downloaded-release) and the [security model](/concepts/security#release-integrity). The installer does not perform the attestation check.

## Update

Stop the foreground service, or run `inbot service uninstall` if you installed the background service. Re-run the one-line installer to select the latest release, then check `inbot --version`. Your home and database are not touched by the installer.

If you use the background service, run `inbot service install` again with the same home and port: the service definition pins the previous package's executable paths. Otherwise restart `inbot serve` without `--init`.

Previous versions remain under `app/<version>`. To select one, use `--version <version>` or `-Version <version>`. This changes the launcher; it does not roll back database migrations, so an older version may not be compatible with an upgraded home. Repeat installs of the same version and checksum reuse the archive; a different archive under an existing version is refused. There is no automatic update and no `inbot update` command.

## Uninstall

1. Run `inbot service uninstall` if a background service is installed, using the same `--home` if you selected a custom home. Otherwise stop the foreground process.
2. On macOS or Linux, remove `~/.local/share/inbot` and the `~/.local/bin/inbot` shim. Remove any PATH entry you added for Inbot if you no longer need it; keep `~/.local/bin` on PATH if other tools use it.
3. On Windows, remove `%LOCALAPPDATA%\Programs\inbot` and its `bin` entry from your user PATH. Open a new terminal afterward.

For custom install roots or bin directories, remove those paths and only the Inbot shim and PATH entry. Downloaded installer scripts can also be removed.

Uninstalling the service or removing the installed package does not remove the home (`~/.inbot`), which holds your mail and keys. Keychain entries and logs are retained too. Keep them for reinstallation or recovery; see [Back up your home](/operations/service#back-up-your-home).

## Next

Continue with the [quickstart](/get-started/quickstart). To keep Inbot running without a terminal, see [Run as a background service](/operations/service#run-as-a-background-service).
