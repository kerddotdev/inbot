# Inbot CLI

`inbot` is an authenticated REST client. It uses the shared endpoint declarations
and validates JSON with their schemas. Resource commands never open the database.
`inbot serve` imports the existing server entry point and preserves its flags,
startup, and shutdown behavior.

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

## Connect

Owner commands read `{ url, token }` from the home's private `connection.json`.
Home resolution reuses the server's `resolveHome`: `--home`, then `INBOT_HOME`,
then `~/.inbot-dev` for the default development flavor or `~/.inbot` with
`--flavor production`. Reading a connection does not initialize or unlock a home.
Use the same flavor and home as the server.

Agents set both `INBOT_URL` (the HTTP(S) origin without `/v0`) and
`INBOT_API_KEY`. This pair takes precedence over the owner connection, including
when `--home` is present. An incomplete pair fails rather than falling back to
owner credentials. Every request sends the selected bearer credential. Redirects
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

Every command accepts `--help`; `inbot --help` lists all commands. Global options
are `--home <directory>`, `--flavor development|production`, and `--json`.
Place the command first, or precede it with global options. Addresses and IDs are
positional; quote IDs containing shell metacharacters.

| Command            | Arguments                                                       | REST operation                               |
| ------------------ | --------------------------------------------------------------- | -------------------------------------------- |
| `serve`            | Existing server flags                                           | Existing server entry point                  |
| `open`             | Optional `--browser`                                            | POST `/v0/owner/login-links`                 |
| `inboxes list`     | Pagination flags                                                | GET `/v0/inboxes`                            |
| `inboxes create`   | Body flags or JSON                                              | POST `/v0/inboxes`                           |
| `inboxes get`      | `<inbox_id>`                                                    | GET `/v0/inboxes/:inbox_id`                  |
| `inboxes delete`   | `<inbox_id>`                                                    | DELETE `/v0/inboxes/:inbox_id`               |
| `threads list`     | Optional `--inbox`, filters                                     | GET `/v0/threads` or inbox threads           |
| `threads get`      | `<thread_id>`, optional `--inbox`                               | GET organization or inbox thread             |
| `messages get`     | `<inbox_id> <message_id>`                                       | GET inbox message                            |
| `messages resolve` | `<inbox_id> <message_id> --decision sent or failed`             | POST inbox message/resolve (local owner)     |
| `messages send`    | `<inbox_id>`, body                                              | POST inbox messages/send                     |
| `messages reply`   | `<inbox_id> <message_id>`, body                                 | POST inbox message/reply                     |
| `messages forward` | `<inbox_id> <message_id>`, body                                 | POST inbox message/forward                   |
| `messages update`  | `<inbox_id> <message_id>`, labels                               | PATCH inbox message                          |
| `drafts list`      | Optional `--inbox`, filters                                     | GET `/v0/drafts` or inbox drafts             |
| `drafts create`    | `<inbox_id>`, body                                              | POST inbox drafts                            |
| `drafts get`       | `<draft_id>`, optional `--inbox`                                | GET organization or inbox draft              |
| `drafts update`    | `<inbox_id> <draft_id>`, body                                   | PATCH inbox draft                            |
| `drafts delete`    | `<inbox_id> <draft_id>`                                         | DELETE inbox draft                           |
| `drafts send`      | `<inbox_id> <draft_id>`, labels                                 | POST inbox draft/send                        |
| `drafts approve`   | `<inbox_id> <draft_id>`                                         | POST inbox draft/approve (owner)             |
| `drafts reject`    | `<inbox_id> <draft_id>`, optional `--reason`                    | POST inbox draft/reject (owner)              |
| `lists list`       | `<direction> <type>`, optional `--inbox`, cursor flags          | GET global or inbox list                     |
| `lists create`     | `<direction> <type>`, `--entry`, optional `--reason`, `--inbox` | POST global or inbox list                    |
| `lists get`        | `<direction> <type> <entry>`, optional `--inbox`                | GET global or inbox list entry               |
| `lists delete`     | `<direction> <type> <entry>`, optional `--inbox`                | DELETE global or inbox list entry            |
| `api-keys list`    | Optional `--inbox`, cursor flags                                | GET organization or inbox API keys (owner)   |
| `api-keys create`  | Optional `--inbox`, body                                        | POST organization or inbox API keys (owner)  |
| `api-keys revoke`  | `<api_key_id>`, optional `--inbox`                              | DELETE organization or inbox API key (owner) |

`open` prints a single-use login URL and never opens a browser unless
`--browser` is present. Password setup must already be complete; links expire
after two minutes. Treat a login link as a credential.

Common payload fields have kebab-case flags: `--display-name`, `--to`, `--text`,
`--reply-all`, `--add-labels`, `--remove-labels`, and so on. Repeat array flags:
`--to first@example.test --to second@example.test`. `--permissions` and
`--metadata` accept JSON objects. See command help for all available flags.

All body commands also accept `--data '<wire JSON>'` or `--data-file <path>`.
Use `--data-file -` to read stdin. JSON uses the contract's snake_case fields and
cannot be combined with body flags. It exposes the full existing payload,
including attachments, headers, and null values for clearing draft fields.
No email content is written to temporary files by the CLI.

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
fake provider. No real mail, infrastructure, or owner home is used. Domains,
transport setup, service installation, and additional REST
operations are outside this CLI implementation. Resource commands add no
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
JSON object. Pod filters are unavailable. `--data` can provide the full payload.

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
