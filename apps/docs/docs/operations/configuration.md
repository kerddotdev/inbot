---
title: Configuration
description: Every serve flag, environment variable and flavor default, the files in the Inbot home directory, and the settings stored in the database.
---

Inbot keeps configuration small. Startup flags choose the home, port and web app; everything else, such as the mail transport, domains and remote access, is stored encrypted in the database and changed through the owner API or the web app.

## `inbot serve` flags

| Flag                               | Default     | Meaning                                                                 |
| ---------------------------------- | ----------- | ----------------------------------------------------------------------- |
| `--home <dir>`                     | See below   | The home directory                                                      |
| `--port <n>`                       | `0`         | Loopback port. `0` picks a free port on each start.                     |
| `--init`                           | Off         | Create a new home with fresh keys. On an existing home it just unlocks. |
| `--web-root <dir>`                 | Bundled app | Override the owner web app directory. It must contain `index.html`.     |
| `--flavor development\|production` | See below   | Selects the default home                                                |

## Flavors and the home directory

The home is resolved in this order:

1. `--home <dir>`
2. The `INBOT_HOME` environment variable
3. `~/.inbot` for the production flavor, or `~/.inbot-dev` for the development flavor

Installed packages run as `production`. Flavor selects home and package defaults; the test-only memory keychain is refused in production flavor.

## Environment variables

| Variable                                                        | Used by      | Meaning                                                                                                                                                       |
| --------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INBOT_HOME`                                                    | Service, CLI | Home directory when `--home` is absent                                                                                                                        |
| `INBOT_URL`                                                     | CLI          | Service origin for an agent, without `/v0`, for example `http://127.0.0.1:8025`                                                                               |
| `INBOT_API_KEY`                                                 | CLI          | Agent API key. Must be set together with `INBOT_URL`; the pair takes precedence over the owner connection.                                                    |
| `INBOT_CLOUDFLARE_API_TOKEN`                                    | CLI          | Cloudflare API token read by `inbot transport configure` when `--token-stdin` is not used. See [Mail transport](/guides/transport#configure-it-with-the-cli). |
| `INBOT_INSTALL_ROOT`, `INBOT_BIN_DIR`, `INBOT_RELEASE_BASE_URL` | Installers   | See [Install Inbot](/get-started/install)                                                                                                                     |

The remote access connector runs with only `PATH` (and `SystemRoot` on Windows) from the environment.

## The home directory

The home is created with mode `0700`. Files containing secrets are written atomically with mode `0600`. On Windows, protection relies on the directory's access control list.

| Path                       | Contents                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `keys.json`                | The database key, wrapped by the keychain key (AES-256-GCM). Never contains a usable key on its own.         |
| `inbot.db`, `-wal`, `-shm` | The encrypted SQLite database (ChaCha20 via SQLite3 Multiple Ciphers)                                        |
| `connection.json`          | `{ "url", "token" }`: the loopback URL and owner bearer token, rewritten on every start                      |
| `bin/`                     | Created only when remote access is enabled: the verified `cloudflared` download and per-run connector tokens |

| `logs/` | Created by `inbot service install`: `service.log` and `service.err.log` from the background service |

There is no lock file. Do not run two services on the same home.

## Settings stored in the database

These are configured at runtime, not with flags:

| Setting                      | Where to change it                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Cloudflare token and account | Settings > Mail transport, `inbot transport`, or `PUT /v0/owner/transport`. See [Mail transport](/guides/transport). |
| Domains and inbox routing    | Domains page, `inbot domains`, or `/v0/domains`. See [Domains](/guides/domains).                                     |
| API keys and OAuth grants    | API keys page, `inbot api-keys`, `inbot oauth`. See [Inboxes and API keys](/guides/inboxes-and-keys).                |
| Allow and block lists        | Settings > Allow and block lists, `inbot lists`. See [Allow and block lists](/guides/lists).                         |
| Webhooks                     | Settings > Webhooks, `inbot webhooks`. See [Webhooks and events](/guides/webhooks).                                  |
| Remote access                | Remote access page, `inbot remote`. See [Remote access](/guides/remote-access).                                      |
| Appearance                   | Settings > Appearance, stored in the browser only                                                                    |

Transport changes take effect on the next loop cycle without a restart.

## Development

A source checkout runs as `development`, with `~/.inbot-dev` as its default home. Always pass an explicit temporary `--home` when developing or testing. `node dist/apps/server/src/main.js serve` and `pnpm start:server` accept the same flags as `inbot serve`, but require an explicit `--web-root` for the [built owner app](/development/build).

`INBOT_TEST_MEMORY_KEYCHAIN=1` keeps the key in memory instead of the OS keychain for tests. It requires an explicit `--home` and the development flavor, and refuses the default homes.
