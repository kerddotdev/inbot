# Inbot CLI

`inbot` is an authenticated REST client. It uses the shared endpoint declarations
and validates JSON with their schemas. Resource commands never open the database.
`inbot serve` imports the existing server entry point and preserves its flags,
startup, and shutdown behavior. Packaged commands default to production flavor;
packaged `serve` also defaults `--web-root` to the included UI. Explicit flags
override both defaults.

## Run

Requires Node 24.21.0 and pnpm 10.24.0. Build from the workspace root:

```sh
pnpm install
pnpm build
pnpm start:cli --help
pnpm start:cli serve --home /path/to/explicit/inbot-home --port 0 --init
```

The root package exposes one `inbot` bin at `dist/apps/cli/src/main.js`. When the
package is linked or installed, use `inbot` directly. In a source checkout, use
`pnpm start:cli` or `node dist/apps/cli/src/main.js` with the same arguments.
The compiled entry imports `dist/apps/server/src/main.js` for `serve`; runtime
dependencies resolve from the root package. No additional dependency is needed.

## Packaged installation

Release archives include Node 24.21.0, production dependencies with the target's
native prebuilds, the server, CLI, inbound Worker bundle, and owner UI. No external
Node runtime is required. Releases have not been published yet. See the root
[install and packaging guide](../../README.md#install) for the checksum-verifying
`install.sh` and `install.ps1`, supported platforms and local verification.
Windows archives include x64 and ARM64 builds; `install.ps1` selects the OS
architecture. Its `-NoPathUpdate` switch leaves PATH unchanged for isolated
installer checks or manual shim management.

```sh
inbot serve --init --port 8025
# Later starts:
inbot serve
# Override package defaults when needed:
inbot serve --home /absolute/path/to/home --web-root /absolute/path/to/ui
```

Packaged owner commands use `~/.inbot` by default. Source-checkout commands still
use development flavor and `~/.inbot-dev`. Use explicit `--flavor development`
with `INBOT_TEST_MEMORY_KEYCHAIN=1` and a temporary `--home` in smoke tests.
No installer automatically registers a service. Use the local owner commands below
after initialization. Keep the complete extracted package intact. The Unix installer uses a
shim, since directly symlinking the package-relative shell launcher is unsupported.

## Background service (local owner)

Initialize with `inbot serve --init --port 8025`, complete owner setup in the UI,
then stop the foreground process before installing:

```sh
inbot service install
inbot service install --home /absolute/path/to/home --port 9123 --json
inbot service status --json
inbot service uninstall
```

These commands manage the current user's machine directly, without REST or MCP.
They reject `INBOT_URL` or `INBOT_API_KEY` with `missing_permission` (exit 4).
Install requires a release package and an initialized `keys.json` with keychain
unlock enabled. Missing, corrupt, or passphrase-only initialization returns
`action_required` (exit 6); it never initializes or touches keychain entries.
Unsupported platforms and source-checkout installs return `not_supported` (exit 9).
Manager failures return `service_unavailable` (exit 10) with recovery guidance.

Home selection is `--home`, `INBOT_HOME`, then the flavor default. Packaged commands
default to production (`~/.inbot`); `--flavor development` selects `~/.inbot-dev`.
The installed server always runs production flavor with the resolved absolute home,
the installing package's absolute Node and CLI paths, and its bundled UI. `--port`
is install-only, defaults to 8025, and must be 1-65535. Foreground `serve` retains
its existing default of port 0. A different home needs a different fixed port.

| Platform | Manager                                              | Default name     | Definition                                  |
| -------- | ---------------------------------------------------- | ---------------- | ------------------------------------------- |
| macOS    | LaunchAgent, `launchctl bootstrap/bootout gui/<uid>` | `dev.kerd.inbot` | `~/Library/LaunchAgents/<name>.plist`       |
| Linux    | `systemctl --user`                                   | `inbot.service`  | `~/.config/systemd/user/<name>`             |
| Windows  | Logon Scheduled Task, `schtasks`                     | `Inbot`          | `~/AppData/Local/Inbot/services/<name>.xml` |

Only the default production home gets the plain name. Other homes append the first
16 hex characters of SHA-256 of the resolved absolute home, before `.service` on
Linux. Windows names normalize path casing. Development and custom homes coexist;
use the same home flags for install, status, and uninstall. Definitions contain no
credentials or environment secrets. Services start at login and restart on failure.
Windows uses the current user's interactive token and least privileges, with no
admin rights; retries run once per minute, up to 255 times. Linux requires a
working user systemd session and Secret Service store at login; no lingering or
system-wide configuration is changed.

Reinstall stops the existing unit, rewrites it, and requests a fresh start. It does
not claim running until the manager reports it. `status` reports `installed`,
`registered`, `running`, `state`, `unit_path`, `port`, and `http_healthy`, plus the
home, unit name, and log paths. `running` and `registered` are null and `state` is
`unknown` when the manager cannot be observed. HTTP health separately probes the
existing public `GET /v0/owner/status` and validates its shared schema. A healthy
endpoint can belong to a foreground process; it is not proof that the managed
service runs. Install may return before HTTP is ready; check status again.

Stdout and stderr append to `<home>/logs/service.log` and `service.err.log`.
Unix log permissions are 0600 and the log directory is 0700. If owner setup is
still needed, its one-time setup code goes to the private stdout log. After HTTP
answers, `inbot open --browser` with the same home prints/opens a single-use login
link. The Windows task action uses `%SystemRoot%\System32\conhost.exe --headless`
to launch the package's Node log host without a console window. An adjacent
`.xml.ps1` helper reads numeric Task Scheduler states without depending on
localized `schtasks` output.
Uninstall stops and removes only the unit and its Windows helper, retaining the
home, database, logs, and keychain. Upgrade the package, then reinstall the service
to update its pinned executable paths before removing an old package version.

## Connect

Owner commands read `{ url, token }` from the home's private `connection.json`.
Home resolution reuses the server's `resolveHome`: `--home`, then `INBOT_HOME`,
then `~/.inbot-dev` for the default development flavor or `~/.inbot` with
`--flavor production`. Reading a connection does not initialize or unlock a home.
Use the same flavor and home as the server.

Agents set both `INBOT_URL` (the HTTP(S) origin without `/v0`) and
`INBOT_API_KEY`. This pair takes precedence over the owner connection, including
when `--home` is present. An incomplete pair fails rather than falling back to
owner credentials. REST requests send the selected bearer credential. Capability downloads use their short-lived URL without forwarding that credential. Redirects
are refused; requests have a 30-second timeout.

```sh
inbot inboxes list --json
inbot threads list --inbox agent@example.test --labels unread --json
inbot messages get agent@example.test '<message-id>' --json
```

The service enforces permissions, fixed inbox scope, hidden-label visibility, and
send policy on every request. Out-of-scope resources return `not_found`. Agent
keys cannot administer API keys, approve/reject drafts, or create owner login
links; the CLI displays the server's 403 without using owner credentials instead.

Message output includes `send_status` and optional `send_reason`. On
`send_unknown`, do not resend; inform the human. After confirming sent or not sent,
the local owner can record the outcome with `inbot messages resolve INBOX ID
--decision sent` or `--decision failed`. This never resends the message; an
intentional retry is a new send with a new idempotency key.

## Commands

`inbot --version` and `inbot version` print the package version without connecting to a server.

Every command accepts `--help`; `inbot --help` lists all commands. Global options
are `--home <directory>`, `--flavor development|production`, and `--json`.
Place the command first, or precede it with global options. Addresses and IDs are
positional; quote IDs containing shell metacharacters.

| Command                   | Arguments                                                                                                 | REST operation                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `serve`                   | Existing server flags                                                                                     | Existing server entry point                                                                                                      |
| `service install`         | Optional `--port`, home and JSON flags                                                                    | Local per-user service manager                                                                                                   |
| `service uninstall`       | Home and JSON flags                                                                                       | Local per-user service manager                                                                                                   |
| `service status`          | Home and JSON flags                                                                                       | Local manager and public owner status probe                                                                                      |
| `open`                    | optional `--browser`                                                                                      | POST `/v0/owner/login-links`                                                                                                     |
| `inboxes list`            | query flags                                                                                               | GET `/v0/inboxes`                                                                                                                |
| `inboxes create`          | body flags or JSON                                                                                        | POST `/v0/inboxes`                                                                                                               |
| `inboxes search`          | query flags                                                                                               | GET `/v0/inboxes/search`                                                                                                         |
| `inboxes get`             | `<inbox_id>`                                                                                              | GET `/v0/inboxes/:inbox_id`                                                                                                      |
| `inboxes update`          | `<inbox_id>`, body flags or JSON                                                                          | PATCH `/v0/inboxes/:inbox_id`                                                                                                    |
| `inboxes delete`          | `<inbox_id>`                                                                                              | DELETE `/v0/inboxes/:inbox_id`                                                                                                   |
| `threads list`            | optional `--inbox`, query flags                                                                           | GET `/v0/threads` or `/v0/inboxes/:inbox_id/threads`                                                                             |
| `threads get`             | `<thread_id>`, optional `--inbox`, query flags                                                            | GET `/v0/threads/:thread_id` or `/v0/inboxes/:inbox_id/threads/:thread_id`                                                       |
| `threads search`          | optional `--inbox`, query flags                                                                           | GET `/v0/threads/search` or `/v0/inboxes/:inbox_id/threads/search`                                                               |
| `threads update`          | `<thread_id>`, optional `--inbox`, body flags or JSON                                                     | PATCH `/v0/threads/:thread_id` or `/v0/inboxes/:inbox_id/threads/:thread_id`                                                     |
| `threads delete`          | `<thread_id>`, optional `--inbox`                                                                         | DELETE `/v0/threads/:thread_id` or `/v0/inboxes/:inbox_id/threads/:thread_id`                                                    |
| `threads attachment`      | `<thread_id>`, `<attachment_id>`, optional `--inbox`, `-o <path>` or redirected stdout; `--json` metadata | GET `/v0/threads/:thread_id/attachments/:attachment_id` or `/v0/inboxes/:inbox_id/threads/:thread_id/attachments/:attachment_id` |
| `messages list`           | `<inbox_id>`, query flags                                                                                 | GET `/v0/inboxes/:inbox_id/messages`                                                                                             |
| `messages search`         | `<inbox_id>`, query flags                                                                                 | GET `/v0/inboxes/:inbox_id/messages/search`                                                                                      |
| `messages get`            | `<inbox_id>`, `<message_id>`                                                                              | GET `/v0/inboxes/:inbox_id/messages/:message_id`                                                                                 |
| `messages send`           | `<inbox_id>`, body flags or JSON                                                                          | POST `/v0/inboxes/:inbox_id/messages/send`                                                                                       |
| `messages reply`          | `<inbox_id>`, `<message_id>`, body flags or JSON                                                          | POST `/v0/inboxes/:inbox_id/messages/:message_id/reply`                                                                          |
| `messages forward`        | `<inbox_id>`, `<message_id>`, body flags or JSON                                                          | POST `/v0/inboxes/:inbox_id/messages/:message_id/forward`                                                                        |
| `messages update`         | `<inbox_id>`, `<message_id>`, body flags or JSON                                                          | PATCH `/v0/inboxes/:inbox_id/messages/:message_id`                                                                               |
| `messages resolve`        | `<inbox_id>`, `<message_id>`, body flags or JSON                                                          | POST `/v0/inboxes/:inbox_id/messages/:message_id/resolve`                                                                        |
| `messages delete`         | `<inbox_id>`, `<message_id>`                                                                              | DELETE `/v0/inboxes/:inbox_id/messages/:message_id`                                                                              |
| `messages batch-get`      | `<inbox_id>`, body flags or JSON                                                                          | POST `/v0/inboxes/:inbox_id/messages/batch-get`                                                                                  |
| `messages batch-update`   | `<inbox_id>`, body flags or JSON                                                                          | POST `/v0/inboxes/:inbox_id/messages/batch-update`                                                                               |
| `messages attachment`     | `<inbox_id>`, `<message_id>`, `<attachment_id>`, `-o <path>` or redirected stdout; `--json` metadata      | GET `/v0/inboxes/:inbox_id/messages/:message_id/attachments/:attachment_id`                                                      |
| `messages raw`            | `<inbox_id>`, `<message_id>`, `-o <path>` or redirected stdout; `--json` metadata                         | GET `/v0/inboxes/:inbox_id/messages/:message_id/raw`                                                                             |
| `messages reply-all`      | `<inbox_id>`, `<message_id>`, body flags or JSON                                                          | POST `/v0/inboxes/:inbox_id/messages/:message_id/reply-all`                                                                      |
| `drafts list`             | optional `--inbox`, query flags                                                                           | GET `/v0/drafts` or `/v0/inboxes/:inbox_id/drafts`                                                                               |
| `drafts create`           | `<inbox_id>`, body flags or JSON                                                                          | POST `/v0/inboxes/:inbox_id/drafts`                                                                                              |
| `drafts get`              | `<draft_id>`, optional `--inbox`                                                                          | GET `/v0/drafts/:draft_id` or `/v0/inboxes/:inbox_id/drafts/:draft_id`                                                           |
| `drafts attachment`       | `<draft_id>`, `<attachment_id>`, optional `--inbox`, `-o <path>` or redirected stdout; `--json` metadata  | GET `/v0/drafts/:draft_id/attachments/:attachment_id` or `/v0/inboxes/:inbox_id/drafts/:draft_id/attachments/:attachment_id`     |
| `drafts update`           | `<inbox_id>`, `<draft_id>`, body flags or JSON                                                            | PATCH `/v0/inboxes/:inbox_id/drafts/:draft_id`                                                                                   |
| `drafts delete`           | `<inbox_id>`, `<draft_id>`                                                                                | DELETE `/v0/inboxes/:inbox_id/drafts/:draft_id`                                                                                  |
| `drafts send`             | `<inbox_id>`, `<draft_id>`, body flags or JSON                                                            | POST `/v0/inboxes/:inbox_id/drafts/:draft_id/send`                                                                               |
| `drafts approve`          | `<inbox_id>`, `<draft_id>`                                                                                | POST `/v0/inboxes/:inbox_id/drafts/:draft_id/approve`                                                                            |
| `drafts reject`           | `<inbox_id>`, `<draft_id>`, body flags or JSON                                                            | POST `/v0/inboxes/:inbox_id/drafts/:draft_id/reject`                                                                             |
| `api-keys list`           | optional `--inbox`, query flags                                                                           | GET `/v0/api-keys` or `/v0/inboxes/:inbox_id/api-keys`                                                                           |
| `api-keys create`         | optional `--inbox`, body flags or JSON                                                                    | POST `/v0/api-keys` or `/v0/inboxes/:inbox_id/api-keys`                                                                          |
| `api-keys get`            | <api_key_id>                                                                                              | GET `/v0/api-keys/:api_key_id`                                                                                                   |
| `api-keys update`         | <api_key_id>, optional `--inbox`, body flags or JSON                                                      | PATCH `/v0/api-keys/:api_key_id` or `/v0/inboxes/:inbox_id/api-keys/:api_key_id`                                                 |
| `api-keys revoke`         | <api_key_id>, optional `--inbox`                                                                          | DELETE `/v0/api-keys/:api_key_id` or `/v0/inboxes/:inbox_id/api-keys/:api_key_id`                                                |
| `lists list`              | `<direction>`, `<type>`, optional `--inbox`, query flags                                                  | GET `/v0/lists/:direction/:type` or `/v0/inboxes/:inbox_id/lists/:direction/:type`                                               |
| `lists create`            | `<direction>`, `<type>`, optional `--inbox`, body flags or JSON                                           | POST `/v0/lists/:direction/:type` or `/v0/inboxes/:inbox_id/lists/:direction/:type`                                              |
| `lists get`               | `<direction>`, `<type>`, `<entry>`, optional `--inbox`                                                    | GET `/v0/lists/:direction/:type/:entry` or `/v0/inboxes/:inbox_id/lists/:direction/:type/:entry`                                 |
| `lists delete`            | `<direction>`, `<type>`, `<entry>`, optional `--inbox`                                                    | DELETE `/v0/lists/:direction/:type/:entry` or `/v0/inboxes/:inbox_id/lists/:direction/:type/:entry`                              |
| `lists rejections`        | query flags                                                                                               | GET `/v0/owner/lists/rejections`                                                                                                 |
| `lists delete-rejection`  | `<rejection_id>`                                                                                          | DELETE `/v0/owner/lists/rejections/:rejection_id`                                                                                |
| `webhooks list`           | optional `--inbox`, query flags                                                                           | GET `/v0/webhooks` or `/v0/inboxes/:inbox_id/webhooks`                                                                           |
| `webhooks create`         | optional `--inbox`, body flags or JSON                                                                    | POST `/v0/webhooks` or `/v0/inboxes/:inbox_id/webhooks`                                                                          |
| `webhooks get`            | `<webhook_id>`, optional `--inbox`                                                                        | GET `/v0/webhooks/:webhook_id` or `/v0/inboxes/:inbox_id/webhooks/:webhook_id`                                                   |
| `webhooks update`         | `<webhook_id>`, optional `--inbox`, body flags or JSON                                                    | PATCH `/v0/webhooks/:webhook_id` or `/v0/inboxes/:inbox_id/webhooks/:webhook_id`                                                 |
| `webhooks delete`         | `<webhook_id>`, optional `--inbox`                                                                        | DELETE `/v0/webhooks/:webhook_id` or `/v0/inboxes/:inbox_id/webhooks/:webhook_id`                                                |
| `webhooks headers`        | `<webhook_id>`, optional `--inbox`                                                                        | GET `/v0/webhooks/:webhook_id/headers` or `/v0/inboxes/:inbox_id/webhooks/:webhook_id/headers`                                   |
| `webhooks update-headers` | `<webhook_id>`, optional `--inbox`, body flags or JSON                                                    | PATCH `/v0/webhooks/:webhook_id/headers` or `/v0/inboxes/:inbox_id/webhooks/:webhook_id/headers`                                 |
| `domains list`            | query flags                                                                                               | GET `/v0/domains`                                                                                                                |
| `domains create`          | body flags or JSON                                                                                        | POST `/v0/domains`                                                                                                               |
| `domains get`             | `<domain_id>`                                                                                             | GET `/v0/domains/:domain_id`                                                                                                     |
| `domains update`          | `<domain_id>`, body flags or JSON                                                                         | PATCH `/v0/domains/:domain_id`                                                                                                   |
| `domains delete`          | `<domain_id>`                                                                                             | DELETE `/v0/domains/:domain_id`                                                                                                  |
| `domains zone-file`       | `<domain_id>`                                                                                             | GET `/v0/domains/:domain_id/zone-file`                                                                                           |
| `domains plan`            | `<domain_id>`                                                                                             | GET `/v0/domains/:domain_id/plan`                                                                                                |
| `domains verify`          | `<domain_id>`                                                                                             | POST `/v0/domains/:domain_id/verify`                                                                                             |
| `domains apply`           | `<domain_id>`                                                                                             | POST `/v0/domains/:domain_id/apply`                                                                                              |
| `domains teardown`        | `<domain_id>`                                                                                             | POST `/v0/domains/:domain_id/teardown`                                                                                           |
| `transport status`        | None                                                                                                      | GET `/v0/owner/transport`                                                                                                        |
| `transport configure`     | token env/stdin, optional `--account-id`                                                                  | PUT `/v0/owner/transport`                                                                                                        |
| `transport clear`         | None                                                                                                      | DELETE `/v0/owner/transport`                                                                                                     |
| `oauth clients`           | None                                                                                                      | GET `/v0/owner/oauth/clients`                                                                                                    |
| `oauth revoke`            | `<grant_id>`                                                                                              | DELETE `/v0/owner/oauth/grants/:grant_id`                                                                                        |
| `oauth purge`             | None                                                                                                      | POST `/v0/owner/oauth/clients/purge`                                                                                             |
| `remote status`           | None                                                                                                      | GET `/v0/owner/remote`                                                                                                           |
| `remote enable`           | body flags or JSON                                                                                        | POST `/v0/owner/remote/enable`                                                                                                   |
| `remote disable`          | None                                                                                                      | POST `/v0/owner/remote/disable`                                                                                                  |

`open` prints a single-use login URL and never opens a browser unless
`--browser` is present. Password setup must already be complete; links expire
after two minutes. Treat a login link as a credential.

Common payload fields have kebab-case flags: `--display-name`, `--to`, `--text`,
`--reply-all`, `--add-labels`, `--remove-labels`, and so on. Repeat array flags:
`--to first@example.test --to second@example.test`. `--permissions` and
`--metadata` accept JSON objects. See command help for all available flags.

Except for `transport configure`, body commands also accept `--data '<wire JSON>'` or `--data-file <path>`.
Use `--data-file -` to read stdin. JSON uses the contract's snake_case fields and
cannot be combined with body flags. It exposes the full existing payload,
including attachments, headers, and null values for clearing draft fields.
The CLI writes mail bytes only to an explicitly requested download path or redirected stdout; it creates no plaintext download cache.

```sh
inbot messages send agent@example.test --to recipient@example.test \
  --subject 'Status' --text 'Synthetic status update' --idempotency-key status-1
inbot messages reply agent@example.test '<message-id>' --text 'Received' \
  --reply-all --idempotency-key reply-1
inbot drafts update agent@example.test '<draft-id>' --data '{"send_at":null}'
inbot api-keys create --inbox agent@example.test --name reader \
  --permissions '{"inbox_read":true,"message_read":true}' \
  --send-policy read_only --show-secret --json
```

## Output and retries

Default output is a table; empty lists print `No results.`. Detail commands print
field/value rows. Pagination prints the next page token; pass it with
`--page-token`. The CLI fetches one page at a time. List filters include `--limit`,
repeatable `--labels`, time filters, and applicable visibility flags.

`--json` prints the validated raw wire object with snake_case fields. An empty
success body prints `null`. Idempotency keys and errors go to stderr. For key
creation, the one-time `api_key` is omitted unless `--show-secret` explicitly
requests it, including in JSON mode. The omitted secret cannot be retrieved
later; revoke and recreate the key if needed. Connection tokens are never printed.

Send, reply, forward, draft send, and approve accept `--idempotency-key`. Without
one, the CLI generates a UUID. It prints `Idempotency-Key: <key>` to stderr
before the request. After a timeout or uncertain result, retry with the printed
key and identical payload. A changed payload returns `idempotency_conflict`.
There is no automatic retry. A successful send means `queued`, not delivered.
`approval_required` includes the pending draft identity in the server's error;
`read_only` is rejected. Scheduled approval can return a draft rather than a
message identity; the CLI preserves that response.

## Errors and exit codes

Server errors print the original JSON `{ name, code, message, fix }` to stderr
(with any declared optional fields). Local errors print `{ code, message, fix }`
without credentials or payload contents. Exit codes are stable:

| Exit | Meaning                                                          |
| ---- | ---------------------------------------------------------------- |
| 0    | Success or help                                                  |
| 1    | Unexpected local failure, including browser launch failure       |
| 2    | Invalid arguments/payload or HTTP 400/413                        |
| 3    | HTTP 401: unauthorized                                           |
| 4    | HTTP 403: permission/policy failure, including approval required |
| 5    | HTTP 404: absent or concealed out-of-scope resource              |
| 6    | HTTP 409: conflict or action required                            |
| 7    | HTTP 423: locked                                                 |
| 8    | HTTP 429: rate limit                                             |
| 9    | HTTP 501: not supported                                          |
| 10   | Connection/response failure or HTTP 503: service unavailable     |

`serve` retains the server's existing exit behavior (0 or 1).

## Verification and boundaries

`pnpm exec vitest run apps/cli/src/cli.test.ts` runs against the real in-process
HTTP server with a temporary encrypted home, memory keychain, fixed clock, and
fake provider. No real mail, infrastructure, or owner home is used. Service installation remains outside this CLI implementation. All declared REST resources are covered, except owner browser authentication/session/password routes. OAuth registration, token exchange, metadata, and consent are protocol/browser flows rather than resource commands. Quarantine commands belong to a separate change and no quarantine routes exist on this branch. Resource commands add no
service behavior, permission, event, MCP tool, or remote route.

## Allow and block lists

```sh
inbot lists list receive block --inbox agent@example.test --json
inbot lists create send block --inbox agent@example.test --entry blocked.test --reason "Synthetic rule"
inbot lists get send block blocked.test --inbox agent@example.test --json
inbot lists delete send block blocked.test --inbox agent@example.test
```

Directions: `receive`, `send`, `reply`; types: `allow`, `block`. Omit `--inbox` for global lists (owner or unrestricted grant required). Read/create/delete need their respective `list_entry_*` permissions. Entries are exact addresses or domains; entries normalize to lowercase and match case-insensitively. Global and inbox entries add together, blocks win, and non-empty allow lists restrict mail. Replies must pass send and reply rules. List pagination uses `--limit` and `--page-token`, lexically ascending. Duplicate creates return `already_exists`; rejected sends return `message_rejected` (exit 4), with nothing queued.

## Webhooks and events

`inbot webhooks list|create|get|update|delete|headers|update-headers` uses the
shared global routes, or inbox routes with `--inbox <address>`. List accepts the
usual pagination flags. Create requires `--url` and repeatable `--event-types`;
`--inbox-ids` is repeatable for a globally scoped receiver. `--headers` accepts a
JSON object. `--data` can provide the full payload.

```sh
inbot webhooks create --inbox agent@example.test --url http://127.0.0.1:8081/events --event-types message.received --show-secret --json
inbot webhooks update WEBHOOK_ID --no-enabled
inbot webhooks headers WEBHOOK_ID --json
inbot webhooks update-headers WEBHOOK_ID --headers '{"X-Receiver":"synthetic"}'
inbot webhooks update-headers WEBHOOK_ID --remove-headers X-Receiver
inbot webhooks delete WEBHOOK_ID
inbot events --follow --json --inbox agent@example.test
inbot events --follow --json --last-event-id EVENT_ID
```

The signing secret is shown only at creation with `--show-secret`; omitting it
requires recreating the receiver if its secret is needed. Other reads and header
commands never expose secret/header values. `--enabled` resumes pending delivery
and resets sustained failure state. Deleting removes pending entries. See
[event delivery](../server/src/events/README.md) for HMAC verification, retries,
URL restrictions and at-least-once deduplication.

`events --follow` authenticates with the same home connection or scoped environment
as REST commands. It sends the WebSocket subscription, prints only contract events,
and answers heartbeat. `--json` prints one event per line. `--inbox` and
`--event-type` filters are repeatable. Resume after the last observed event ID;
new connections without a cursor follow future events. Ctrl-C closes cleanly.
Connection loss, revoked credentials or invalid resume fail with exit 10; there
is no automatic reconnect. Event read permissions and inbox scope are enforced
by the server; read-only send policy does not prevent authorized event reads.

## Remote access (local owner)

```sh
inbot remote status --json
inbot remote enable --hostname inbot.example.com --json
inbot remote disable --json
```

Use the local server connection and configure the Cloudflare transport first.
Enable explicitly authorizes downloading the pinned verified connector and
creating a named tunnel and a proxied CNAME for an unused non-apex subdomain.
The commands call `GET /v0/owner/remote`, `POST /v0/owner/remote/enable`, and
`POST /v0/owner/remote/disable`. Agent keys and tunneled management requests are
rejected. Status distinguishes disabled, provisioning, connecting, connected and
action_required; it never includes tunnel credentials. After a client timeout,
inspect status and retry the same hostname to reconcile, or disable to clean up.
See [remote access](../server/src/remote/README.md) for the exact tunnel policy.

`inbot oauth clients` lists approved OAuth grants as owner; `inbot oauth revoke <grant_id>` revokes a grant and every associated token. `inbot oauth purge` deletes unused client registrations without revoking existing grants and reports `deleted_clients`. These management commands use the local owner API.

Rejected mail metadata is available only with the local owner connection. List
permissions do not authorize it. Records contain time, inbox, sender, and rules;
legacy sender/rule metadata may be missing. Bodies and subjects are never returned.
Deletion does not release mail and preserves the durable rejection decision.
Configure transport with the local owner connection using the commands below.

Update an existing key without rotating its secret:

```sh
inbot api-keys update <api_key_id> --name researcher \
  --permissions '{"inbox_read":true,"message_read":true,"message_send":true}' \
  --send-policy approval
```

Use `--inbox <inbox_id>` for the inbox route. Omitted fields stay unchanged;
`--permissions` replaces the permission set. Changes apply on the next request.
Inbox scope and expiry cannot be changed by this command.

Startup failures from `serve` print `server.failed` JSON with the specific stable code and recovery fix for known key, keychain, home, and database errors. See [startup failures](../server/src/http/README.md#startup-failures).

## Search, updates, batches, and downloads

```sh
inbot inboxes search --q researcher --limit 20 --json
inbot inboxes update agent@example.test --display-name Research --status paused
inbot inboxes update agent@example.test --status active --metadata '{"project":"synthetic"}'
inbot inboxes update agent@example.test --data '{"metadata":{"project":null}}'
inbot threads search --q project --inbox agent@example.test --json
inbot threads update THREAD_ID --inbox agent@example.test --add-labels reviewed --remove-labels unread
inbot threads delete THREAD_ID --inbox agent@example.test
inbot messages list agent@example.test --from alice@example.test --to agent@example.test --subject project --json
inbot messages search agent@example.test --q project --after 2026-10-10T00:00:00Z --json
inbot messages batch-get agent@example.test --message-ids '<first@example.test>' --message-ids '<second@example.test>' --json
inbot messages batch-update agent@example.test --message-ids '<first@example.test>' --remove-labels unread
inbot messages delete agent@example.test '<first@example.test>'
inbot messages reply-all agent@example.test '<first@example.test>' --text Received --idempotency-key reply-all-1
inbot api-keys get KEY_ID --json
inbot messages raw agent@example.test '<first@example.test>' -o message.eml
inbot messages attachment agent@example.test '<first@example.test>' ATTACHMENT_ID --output file.bin
inbot threads attachment THREAD_ID ATTACHMENT_ID --inbox agent@example.test > file.bin
inbot drafts attachment DRAFT_ID ATTACHMENT_ID --inbox agent@example.test -o draft.bin
```

Inbox search accepts `--q`, `--limit` (1-100), and `--page-token`. Mail searches
add `--before` and `--after`. Message lists use repeatable `--from`, `--to`,
and `--subject`; thread lists use `--senders`, `--recipients`, and `--subject`.
Both list forms retain pagination, labels, time, and hidden-mail filters.
Batch-get accepts at most 500 unique `--message-ids`; batch-update accepts at
most 50. Neither batch command is a send or needs a send idempotency key.
Global `api-keys list` additionally accepts `--ascending` and `--type bearer`;
these two options do not apply to its inbox route.

Inbox status is `active` or `paused`. Metadata updates merge keys; null values
remove keys and `metadata: null` clears all metadata. Use JSON for nulls.
Thread label edits affect its messages. Thread deletion removes its messages;
message and thread deletion have no restore command. The service continues to
enforce `inbox_update`, `message_read/update/delete`, or `draft_read` and inbox
scope. API key reads remain owner-only and never reveal the key secret.

Raw and attachment commands obtain the shared download metadata, then fetch the
five-minute capability URL from the same Inbot origin, without bearer headers
or redirects. `-o` / `--output` creates a new file with mode 0600 and refuses to
overwrite any existing path. Without an output path, or with `-o -`, the CLI
writes bytes to redirected stdout. A TTY is rejected with `validation_error`
(exit 2). `--json` prints only download metadata, including the sensitive
capability URL; it cannot be combined with `--output`. File creation failures
return exit 1 without replacing an existing file. Download errors retain the
usual REST exit mapping. No default attachment filename is trusted or used.

## Domains and mail transport (local owner)

```sh
inbot transport status --json
# Read a token privately from stdin, for example from a password manager:
inbot transport configure --account-id ACCOUNT_ID --token-stdin --json
# Or supply INBOT_CLOUDFLARE_API_TOKEN through a trusted environment/secret manager:
inbot transport configure --account-id ACCOUNT_ID --json
inbot domains list --json
inbot domains create --domain agents.example.test --json
inbot domains get DOMAIN_ID --json
inbot domains update DOMAIN_ID --inbound-enabled --no-tracking-enabled
inbot domains plan DOMAIN_ID --json
inbot domains zone-file DOMAIN_ID > domain.zone
inbot domains apply DOMAIN_ID --json
inbot domains verify DOMAIN_ID
inbot domains get DOMAIN_ID --json
inbot domains teardown DOMAIN_ID --json
inbot domains delete DOMAIN_ID
inbot transport clear
```

`transport configure` accepts `--account-id` and exactly one token source:
`INBOT_CLOUDFLARE_API_TOKEN` or `--token-stdin` (raw token, trailing newline
allowed). It rejects `--api-token`, `--data`, and `--data-file` so tokens cannot
be passed as command arguments. Never paste a token into a shell command or
history. The REST body remains `{ api_token, account_id? }`. Without an account
ID the service selects a single accessible account; multiple accounts require
an explicit choice through `action_required` (exit 6). Configuration verifies
the candidate token before saving encrypted credentials. There is no separate
transport verify endpoint or command. Status never returns the token; a failed
verification preserves the previous configuration. Clear removes credentials
and verification metadata only after recorded infrastructure is torn down.

Domain create registers the literal subdomain without cloud mutations. Plan
inspects provider requirements; apply provisions resources, and teardown
removes recorded owned resources. Verify returns an empty 200, not the verified
domain: run get afterward to observe `VERIFYING`, `VERIFIED`, or action-required
state. Zone-file preserves the REST `text/plain` response, including newlines;
`--json` returns that text as a JSON string. Domain options use the shared
payload; unsupported tracking, feedback, wildcard subdomains, inbound disabling,
and conflicting-provider overrides are rejected by the existing service.
These commands neither widen permissions nor add remote management routes.

## REST parity audit

The initial comparison found 42 endpoint declarations without direct command
mapping. This change covers 34 through 29 new commands (global/inbox variants
share commands): inbox search/update; thread search/update/delete/attachment;
message list/search/delete/batch-get/batch-update/attachment/raw/reply-all;
draft attachment; API key get; all ten domain routes; all three transport routes.
The command table above gives their exact HTTP methods and paths.

The remaining eight declared endpoints are deliberately browser-only:
`GET /v0/owner/status`, `POST /v0/owner/setup`, `POST /v0/owner/login`,
`POST /v0/owner/login-links/redeem`, `POST /v0/owner/logout`,
`GET /v0/owner/sessions`, `DELETE /v0/owner/sessions/:id`, and
`POST /v0/owner/password`. Existing `open` still creates a single-use login link.
OAuth protocol/consent internals and quarantine are intentionally outside this
work. The HTTP capability download route is consumed by attachment/raw commands;
`/v0/ws` is covered by `events --follow`. There is no CLI-reference generator in
this branch; help derives from the command table.

## Owner quarantine

```sh
inbot quarantine list --limit 20 --json
inbot quarantine list --page-token <token> --json
inbot quarantine retry <quarantine_id> --json
inbot quarantine delete <quarantine_id> --json
```

Use the local owner connection with `--home <directory>` or `INBOT_HOME`; scoped agent keys and OAuth tokens cannot use these commands. List prints a table by default or the unchanged paginated REST response with `--json`. Retry JSON distinguishes `released` from another permanent `quarantined` result. Delete permanently removes ciphertext and metadata, is idempotent, and prints `null` with `--json`. Queue items contain metadata only and retry returns `not_supported` (exit 9). Missing/mismatched buffer configuration and pending deletion return `action_required` (exit 6); forbidden credentials exit 4. Cleanup may remain pending after provider/storage failure: inspect the list before retrying. No extra CLI confirmation is requested.
