---
title: Running the service
description: Start and stop inbot serve, install it as a per-user background service, understand startup output and unlock, read logs, back up the home, and know what runs in the background.
---

`inbot serve` is the whole service: one foreground process that unlocks the database, serves REST, MCP and the web app on a loopback port, and runs the mail loops. To run it without a terminal, [install it as a background service](#run-as-a-background-service).

## Start

```sh
# First start creates the home and its keys:
inbot serve --init
# Every later start:
inbot serve --port 8025
```

`--port` defaults to `0`, which picks a free port on every start. Give a fixed port when agents or MCP clients store the URL. The service listens on `127.0.0.1` only.

The service prints one JSON line per event to stdout:

| Line                                                     | When                                                                                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `{"event":"owner.setup_required","code":"..."}`          | No owner password exists yet. The code is single-use, held only in memory, and changes on every restart until setup is done. |
| `{"event":"server.ready","url":"http://127.0.0.1:8025"}` | The database is unlocked and the API is serving.                                                                             |

If startup fails, it prints `{"event":"server.failed","code":"<stable code>","cause":"...","message":"...","fix":"..."}` to stderr and exits with code 1. Known home, key, keychain, connection and database errors preserve their specific code and recovery fix. Unknown failures use `service_unavailable` with `cause: "UnexpectedError"`; raw error details are not printed. [Troubleshooting](/operations/troubleshooting#startup) lists the common causes.

On every start the service also writes `connection.json` into the home: the loopback URL and a fresh owner bearer token. The `inbot` CLI on the same machine reads it to act as the owner. Treat it as a secret.

## Unlock

The database key (DEK) is random and never stored in plaintext. On `--init`, Inbot wraps it with a second key kept in your OS keychain and writes the wrapped form to `keys.json` in the home. Every later start reads the keychain item and unlocks automatically.

| Situation                        | What happens                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------- |
| New home without `--init`        | Startup fails with `not_initialized`.                                             |
| `--init` on an existing home     | It unlocks normally; nothing is overwritten.                                      |
| Keychain locked or access denied | `keychain_unavailable`. Unlock the credential store and allow Inbot to access it. |
| Keychain item deleted            | `keychain_entry_missing`. The database cannot be opened.                          |
| `keys.json` damaged or wrong key | `keys_file_corrupt` or `database_key_invalid`.                                    |

Other startup codes include `home_unavailable` and `key_storage_unavailable` (home permissions or disk space), `database_failed` (database access or schema), and `key_crypto_failed` (runtime or memory). Key manager state failures include `method_not_configured`, `invalid_configuration`, `locked`, `last_unlock_method` and `invalid_passphrase`; these describe internal key-method state, not supported passphrase startup commands. Connection-file failures use `service_unavailable` with `cause: "ConnectionError"`. Follow the returned fix where the public interface supports it.

The service only starts serving after a successful unlock, so a running service is never locked. `GET /v0/owner/status` reports `"locked": false`, and the web app's locked screen exists for the contract's `locked` state.

The internal key manager can wrap the key with a passphrase, but `serve` has no passphrase option and no command, route or screen exposes passphrase unlock. Even if `keychain_entry_missing` suggests passphrase recovery in its fix, that recovery is not available through the current user interfaces.

## Stop

Press Ctrl-C or send SIGTERM. The service stops its background loops before closing the database, gives in-flight HTTP requests 5 seconds, clears the key from memory, and stops the remote access connector if one is running. Kill only the process ID you started; never match processes by name.

## Run as a background service

`inbot service` registers `inbot serve` with your operating system's per-user service manager, so Inbot starts at login and restarts after a failure. Mail keeps arriving while the service is down, because it waits in Cloudflare and is fetched when the service starts again; see [Architecture](/concepts/architecture#inbound).

| Platform | Manager                                           | Default name     | Definition                                 |
| -------- | ------------------------------------------------- | ---------------- | ------------------------------------------ |
| macOS    | LaunchAgent (`launchctl bootstrap` and `bootout`) | `dev.kerd.inbot` | `~/Library/LaunchAgents/<name>.plist`      |
| Linux    | systemd user unit (`systemctl --user`)            | `inbot.service`  | `~/.config/systemd/user/<name>`            |
| Windows  | Scheduled Task that runs at logon (`schtasks`)    | `Inbot`          | `~/AppData/Local/Inbot/services/<name>.xml` |

The commands manage your own user account directly. They need no administrator rights, do not use REST or MCP, and do not change system-wide configuration or enable lingering. If `INBOT_URL` or `INBOT_API_KEY` is set, they fail with `missing_permission` (exit 4), because service management is a local owner operation.

### Install

Initialize and finish owner setup in the foreground first, then stop that process and install:

```sh
inbot serve --init --port 8025
# Open http://127.0.0.1:8025, enter the setup code and choose a password.
# Stop the foreground server with Ctrl-C, then:
inbot service install
```

Installing requires:

- A release package. A source checkout is refused with `not_supported` (exit 9), as are unsupported platforms.
- A home that was already initialized with the OS keychain. A missing, corrupt or passphrase-only home returns `action_required` (exit 6). Install never initializes a home and never touches keychain items.

| Option                          | Meaning                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `--home <directory>`            | Home to run. Falls back to `INBOT_HOME`, then `~/.inbot`.                     |
| `--flavor development\|production` | Selects the default home when none is given. Packaged commands default to production. |
| `--port <1-65535>`              | Install only. The fixed port the service listens on. Defaults to `8025`.      |
| `--json`                        | Print the result as JSON.                                                     |

The installed service always runs the production flavor with the resolved absolute home, the installing package's absolute Node.js and CLI paths, and its bundled web app. Installing again stops the existing unit, rewrites it and requests a fresh start. The definition contains no credentials or secrets.

Install reports that a start was requested, not that Inbot is running. Check [status](#status) until HTTP health answers.

### Status

```sh
inbot service status
inbot service status --json
```

Status reports two things separately:

- The service manager's view: `installed`, `registered`, `running` and `state`. When the manager cannot be observed, `running` and `registered` are `null` and `state` is `unknown`. Unknown is never reported as running.
- HTTP health (`http_healthy`): whether `GET /v0/owner/status` answers on the installed `port` with the expected shape. A healthy endpoint can belong to a foreground `inbot serve` rather than the managed service, so it does not prove the service is running.

The output also includes the home, the unit name and path, and the log paths.

### Uninstall

```sh
inbot service uninstall
```

Uninstall stops the service and removes only its definition (and, on Windows, its helper script). The home, database, mail, logs and keychain entries stay.

### Logs and first sign-in

The service appends stdout and stderr to `<home>/logs/service.log` and `<home>/logs/service.err.log`. On Unix the files are mode `0600` and the directory `0700`. They carry the same JSON lines as a foreground run.

If owner setup is still pending when the service starts, the one-time setup code is in `service.log`. Once HTTP answers, run `inbot open --browser` with the same home to get a single-use login link.

### Several homes and upgrades

Only the default production home gets the plain unit name. Any other home gets a name with the first 16 hex characters of the SHA-256 of its absolute path appended, so several homes can be installed side by side. Each needs its own fixed port. Pass the same `--home` or `--flavor` to install, status and uninstall.

The unit pins the absolute paths of the Node.js runtime and CLI that you installed from. After [upgrading](/get-started/install#upgrade-downgrade-and-remove), run `inbot service install` again before removing the old package version.

### Service errors

| Code                  | Exit | Cause                                                                                       |
| --------------------- | ---- | ------------------------------------------------------------------------------------------- |
| `missing_permission`  | 4    | `INBOT_URL` or `INBOT_API_KEY` is set.                                                      |
| `action_required`     | 6    | The home is missing, not initialized, corrupt, or does not use keychain unlock.             |
| `not_supported`       | 9    | Source checkout or unsupported platform.                                                    |
| `service_unavailable` | 10   | The service manager failed. Linux needs a working user systemd session and Secret Service at login. |

## Check health

There is no dedicated health endpoint. `GET /v0/owner/status` is public and answers as soon as the service is serving:

```sh
curl -s http://127.0.0.1:8025/v0/owner/status
```

`inbot remote status` reports the tunnel, and the web app's Domains page reports DNS and verification state.

## Logs

There are no log levels. A foreground run writes only the JSON lines above and rare internal error codes to stdout and stderr; the background service appends the same output to [its log files](#logs-and-first-sign-in). Message content, credentials, keys and webhook payloads are never logged. The remote access connector's own output is discarded.

## Background loops

All loops start after unlock and stop with the service.

| Loop              | What it does                                             | Timing                                                                                                                                                       |
| ----------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Outbox            | Sends queued mail through Cloudflare                     | Wakes immediately after enqueue or approval; 2 s after work and 30 s idle/unconfigured are recovery checks                                                   |
| Inbound pull      | Fetches and decrypts new mail from the Cloudflare buffer | Every 2 s while busy, 30 s when idle                                                                                                                         |
| Inbound reconcile | Lists the buffer for anything the Queue missed           | At startup, then every 15 minutes                                                                                                                            |
| Delivery events   | Applies delivery, bounce and complaint reports           | Every 2 s while busy, 30 s when idle                                                                                                                         |
| Scheduled drafts  | Sends approved drafts whose `send_at` has passed         | Wakes on creation, editing or approval; waits until the next due time, with 30 s idle/2 s after-work recovery caps. Processes overdue drafts after an outage |
| Provisioning      | Applies inbox routing and checks domain verification     | Every 10 s, with a full routing reconcile every 5 minutes                                                                                                    |
| Webhooks          | Delivers signed events                                   | Every second                                                                                                                                                 |
| Remote access     | Supervises the tunnel connector                          | Every second, restarting with backoff up to 60 s                                                                                                             |

If a loop crashes, the service stops rather than running partially.

## Back up your home

There is no export or backup command. A backup is a copy of the whole home directory taken while the service is stopped. `keys.json` and `inbot.db` belong together, and neither is usable without the keychain item that unwraps the key. Losing `keys.json` or the keychain item makes the database permanently unreadable.

The keychain item uses the service name `dev.kerd.inbot`, with an account derived from the home's absolute path. A backup restored to a different path or machine will not find it, and passphrase unlock is not available yet, so test any restore procedure before you rely on it.

## Data retention

| Data                       | Retention                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| Messages, threads, inboxes | Deleted immediately when you delete them. Their content is also redacted from stored events.           |
| Event log                  | 30 days, longer only for events a webhook still has to deliver                                         |
| Send idempotency keys      | 24 hours                                                                                               |
| OAuth                      | Unused client registrations expire after 24 hours; refresh token families after 30 days                |
| Inbound ciphertext         | Deleted from Cloudflare after the message is committed locally; quarantined objects stay until you act |
| Owner sessions             | Expire after 14 days of inactivity, and 30 days at most                                                |
