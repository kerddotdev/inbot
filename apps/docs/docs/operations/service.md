---
title: Running the service
description: Start and stop inbot serve, understand startup output and unlock, keep it running, back up the home, and know what runs in the background.
---

`inbot serve` is the whole service: one foreground process that unlocks the database, serves REST, MCP and the web app on a loopback port, and runs the mail loops. There is no daemon mode and no built-in service installation yet.

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

## Keep it running

There is no `service install` yet. To keep Inbot running, start `inbot serve` from your own supervisor, such as a launchd agent, a systemd user unit or a terminal multiplexer. Inbound mail waits safely in Cloudflare while the service is down and is fetched when it starts again; see [Architecture](/concepts/architecture#inbound).

## Check health

There is no dedicated health endpoint. `GET /v0/owner/status` is public and answers as soon as the service is serving:

```sh
curl -s http://127.0.0.1:8025/v0/owner/status
```

`inbot remote status` reports the tunnel, and the web app's Domains page reports DNS and verification state.

## Logs

There is no log file and there are no log levels. stdout and stderr carry only the JSON lines above and rare internal error codes. Message content, credentials, keys and webhook payloads are never logged. The remote access connector's own output is discarded.

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
