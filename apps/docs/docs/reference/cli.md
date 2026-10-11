---
title: CLI reference
description: Every inbot command, argument and option, generated from the CLI's own help output each time the documentation is built.
---

This page is generated from `inbot --help` when the documentation is built. For connection setup, output modes and idempotency, see [Connect an agent](/agents/connect#cli); for exit codes, see [Errors and exit codes](/reference/errors). Resource commands accept the global options `--home`, `--flavor`, `--json` and `--help`.

```text
Usage: inbot <command> [options] | inbot --version

  serve                Run the existing server (inbot serve --help).
  open                 Print a single-use owner login link. Open it only with --browser.
  inboxes list         List accessible inboxes.
  inboxes create       Create an inbox within the current grant.
  inboxes search       Search accessible inboxes with --q.
  inboxes get          Get an inbox.
  inboxes update       Update display name, active/paused status, or metadata; use JSON to clear metadata.
  inboxes delete       Delete an inbox.
  threads list         List accessible threads, optionally within --inbox.
  threads get          Get a thread and its messages, optionally within --inbox.
  threads search       Search accessible threads with --q, optionally within --inbox.
  threads update       Add or remove thread labels, optionally within --inbox.
  threads delete       Delete a thread and its messages, optionally within --inbox.
  threads attachment   Download a thread attachment; use -o <path> or redirected stdout.
  messages list        List messages within an inbox, with pagination and mail filters.
  messages search      Search inbox messages with --q.
  messages get         Read a message, including send_status and send_reason. On send_unknown, do not resend; inform the human.
  messages send        Queue a message with an idempotency key.
  messages reply       Reply to a message; --reply-all includes other recipients.
  messages forward     Forward a message.
  messages update      Add or remove message labels.
  messages resolve     Resolve send_unknown as owner with --decision sent|failed. Confirm sent or not sent first; this never resends.
  messages delete      Delete a message.
  messages batch-get   Read up to 500 unique message IDs.
  messages batch-update Update labels on up to 50 unique message IDs.
  messages attachment  Download a message attachment; use -o <path> or redirected stdout.
  messages raw         Download the original MIME message; use -o <path> or redirected stdout.
  messages reply-all   Reply to all original recipients with an idempotency key.
  drafts list          List drafts, optionally within --inbox.
  drafts create        Create an incomplete, reply, or forward draft.
  drafts get           Get a draft, optionally within --inbox.
  drafts attachment    Download a draft attachment, optionally within --inbox.
  drafts update        Update a draft. Use --data for nulls or attachment changes.
  drafts delete        Delete a draft.
  drafts send          Send a draft now, overriding its schedule.
  drafts approve       Approve a draft as owner; scheduled drafts remain scheduled.
  drafts reject        Reject a draft as owner.
  api-keys list        List API key metadata as owner.
  api-keys create      Create a scoped API key as owner. --show-secret prints its one-time secret.
  api-keys get         Read API key metadata as owner; never returns the secret.
  api-keys update      Update an API key's name, permissions, or send policy as owner.
  api-keys revoke      Revoke an API key as owner.
  lists list           List allow/block entries for receive, send, or reply; --inbox selects an inbox.
  lists create         Add one exact address or domain; blocks win over allows.
  lists get            Read one allow/block entry, optionally within --inbox.
  lists delete         Remove an entry, optionally within --inbox.
  lists rejections     List rejected inbound metadata as owner, optionally filtered by --inbox-id.
  lists delete-rejection Delete rejected inbound metadata as owner; this does not accept the mail.
  webhooks list        List webhook metadata, optionally within --inbox.
  webhooks create      Create a webhook. --show-secret prints its one-time signing secret.
  webhooks get         Get webhook metadata.
  webhooks update      Update event filters, enabled state, or inbox filters.
  webhooks delete      Delete a webhook and its pending deliveries.
  webhooks headers     List custom header names without their values.
  webhooks update-headers Set or remove custom headers.
  domains list         List domains as owner.
  domains create       Register a domain as owner; apply its plan separately.
  domains get          Inspect domain state and DNS records as owner.
  domains update       Update supported domain options as owner.
  domains delete       Delete a domain after teardown as owner.
  domains zone-file    Print domain DNS records as a text zone file.
  domains plan         Inspect the provisioning plan before applying it as owner.
  domains verify       Check domain DNS and provider verification as owner.
  domains apply        Provision the registered domain using its plan as owner.
  domains teardown     Remove recorded provider resources as owner.
  transport status     Inspect transport and token verification metadata as local owner.
  transport configure  Verify and save transport credentials from INBOT_CLOUDFLARE_API_TOKEN or --token-stdin.
  transport clear      Clear transport credentials after tearing down provisioned resources as owner.
  oauth clients        List authorized OAuth clients and grants as owner.
  oauth revoke         Revoke an OAuth grant and every token as owner.
  oauth purge          Purge unused OAuth client registrations as owner.
  remote status        Inspect optional remote access (owner, local URL).
  remote enable        Download the verified connector and provision remote access (owner, local URL).
  remote disable       Stop the connector and remove its recorded DNS and tunnel (owner, local URL).
  quarantine list      List inbound quarantine metadata as owner.
  quarantine retry     Retry a quarantined buffer object as owner; Queue metadata cannot be retried.
  quarantine delete    Delete quarantined ciphertext and metadata as owner. This is permanent.
  service install      Install and restart the per-user background service.
  service uninstall    Stop and remove the service, retaining mail and keys.
  service status       Inspect the service manager and local HTTP health.
  events --follow      Stream accessible events (--json, --last-event-id).

Global options: --home <directory>, --flavor development|production, --json, --help
Owner: read connection.json from the server home. Agent: set INBOT_URL and INBOT_API_KEY.
```

## version

### `inbot version`

```text
Usage: inbot --version | inbot version

Print the package version without connecting to a server.
```

## serve

### `inbot serve`

```text
Usage: inbot serve --home <directory> [--port 0] [--init] [--web-root <directory>] [--flavor development|production]
```

## open

### `inbot open`

```text
Usage: inbot open [options]

Print a single-use owner login link. Open it only with --browser.

  --browser
```

## inboxes

### `inbot inboxes list`

```text
Usage: inbot inboxes list [options]

List accessible inboxes.

  --limit <value>
  --page-token <value>
  --ascending
```

### `inbot inboxes create`

```text
Usage: inbot inboxes create [options]

Create an inbox within the current grant.

  --username <value>
  --domain <value>
  --display-name <value>
  --client-id <value>
  --status <value>
  --metadata <value>
  --data <value>
  --data-file <value>

--data accepts the REST JSON payload; --data-file reads it from a file or '-' for stdin. Do not combine payload JSON with body flags.
```

### `inbot inboxes search`

```text
Usage: inbot inboxes search [options]

Search accessible inboxes with --q.

  --limit <value>
  --page-token <value>
  --q <value>
```

### `inbot inboxes get`

```text
Usage: inbot inboxes get <inbox_id> [options]

Get an inbox.

```

### `inbot inboxes update`

```text
Usage: inbot inboxes update <inbox_id> [options]

Update display name, active/paused status, or metadata; use JSON to clear metadata.

  --display-name <value>
  --status <value>
  --metadata <value>
  --data <value>
  --data-file <value>

--data accepts the REST JSON payload; --data-file reads it from a file or '-' for stdin. Do not combine payload JSON with body flags.
```

### `inbot inboxes delete`

```text
Usage: inbot inboxes delete <inbox_id> [options]

Delete an inbox.

```

## threads

### `inbot threads list`

```text
Usage: inbot threads list [options]

List accessible threads, optionally within --inbox.

  --limit <value>
  --page-token <value>
  --ascending
  --before <value>
  --after <value>
  --labels <value> (repeatable)
  --include-spam
  --include-blocked
  --include-unauthenticated
  --include-trash
  --senders <value> (repeatable)
  --recipients <value> (repeatable)
  --subject <value> (repeatable)
  --inbox <value>
```

### `inbot threads get`

```text
Usage: inbot threads get <thread_id> [options]

Get a thread and its messages, optionally within --inbox.

  --limit <value>
  --page-token <value>
  --inbox <value>
```

### `inbot threads search`

```text
Usage: inbot threads search [options]

Search accessible threads with --q, optionally within --inbox.

  --limit <value>
  --page-token <value>
  --q <value>
  --before <value>
  --after <value>
  --inbox <value>
```

### `inbot threads update`

```text
Usage: inbot threads update <thread_id> [options]

Add or remove thread labels, optionally within --inbox.

  --add-labels <value> (repeatable)
  --remove-labels <value> (repeatable)
  --data <value>
  --data-file <value>
  --inbox <value>

--data accepts the REST JSON payload; --data-file reads it from a file or '-' for stdin. Do not combine payload JSON with body flags.
```

### `inbot threads delete`

```text
Usage: inbot threads delete <thread_id> [options]

Delete a thread and its messages, optionally within --inbox.

  --inbox <value>
```

### `inbot threads attachment`

```text
Usage: inbot threads attachment <thread_id> <attachment_id> [options]

Download a thread attachment; use -o <path> or redirected stdout.

  --inbox <value>
  --output <value>

-o, --output <path> creates a private file and refuses to overwrite it. Omit it or use '-' for redirected binary stdout. --json returns download metadata only and cannot be combined with --output.
```

## messages

### `inbot messages list`

```text
Usage: inbot messages list <inbox_id> [options]

List messages within an inbox, with pagination and mail filters.

  --limit <value>
  --page-token <value>
  --ascending
  --before <value>
  --after <value>
  --labels <value> (repeatable)
  --include-spam
  --include-blocked
  --include-unauthenticated
  --include-trash
  --from <value> (repeatable)
  --to <value> (repeatable)
  --subject <value> (repeatable)
```

### `inbot messages search`

```text
Usage: inbot messages search <inbox_id> [options]

Search inbox messages with --q.

  --limit <value>
  --page-token <value>
  --q <value>
  --before <value>
  --after <value>
```

### `inbot messages get`

```text
Usage: inbot messages get <inbox_id> <message_id> [options]

Read a message, including send_status and send_reason. On send_unknown, do not resend; inform the human.

```

### `inbot messages send`

```text
Usage: inbot messages send <inbox_id> [options]

Queue a message with an idempotency key.

  --to <value> (repeatable)
  --cc <value> (repeatable)
  --bcc <value> (repeatable)
  --reply-to <value> (repeatable)
  --subject <value>
  --text <value>
  --html <value>
  --labels <value> (repeatable)
  --data <value>
  --data-file <value>
  --idempotency-key <value>

--data accepts the REST JSON payload; --data-file reads it from a file or '-' for stdin. Do not combine payload JSON with body flags.

The Idempotency-Key is printed to stderr before sending. Reuse it with the same payload after an uncertain result.
```

### `inbot messages reply`

```text
Usage: inbot messages reply <inbox_id> <message_id> [options]

Reply to a message; --reply-all includes other recipients.

  --to <value> (repeatable)
  --cc <value> (repeatable)
  --bcc <value> (repeatable)
  --reply-to <value> (repeatable)
  --text <value>
  --html <value>
  --labels <value> (repeatable)
  --reply-all
  --data <value>
  --data-file <value>
  --idempotency-key <value>

--data accepts the REST JSON payload; --data-file reads it from a file or '-' for stdin. Do not combine payload JSON with body flags.

The Idempotency-Key is printed to stderr before sending. Reuse it with the same payload after an uncertain result.
```

### `inbot messages forward`

```text
Usage: inbot messages forward <inbox_id> <message_id> [options]

Forward a message.

  --to <value> (repeatable)
  --cc <value> (repeatable)
  --bcc <value> (repeatable)
  --reply-to <value> (repeatable)
  --subject <value>
  --text <value>
  --html <value>
  --labels <value> (repeatable)
  --data <value>
  --data-file <value>
  --idempotency-key <value>

--data accepts the REST JSON payload; --data-file reads it from a file or '-' for stdin. Do not combine payload JSON with body flags.

The Idempotency-Key is printed to stderr before sending. Reuse it with the same payload after an uncertain result.
```

### `inbot messages update`

```text
Usage: inbot messages update <inbox_id> <message_id> [options]

Add or remove message labels.

  --add-labels <value> (repeatable)
  --remove-labels <value> (repeatable)
  --data <value>
  --data-file <value>

--data accepts the REST JSON payload; --data-file reads it from a file or '-' for stdin. Do not combine payload JSON with body flags.
```

### `inbot messages resolve`

```text
Usage: inbot messages resolve <inbox_id> <message_id> [options]

Resolve send_unknown as owner with --decision sent|failed. Confirm sent or not sent first; this never resends.

  --decision <value>
  --data <value>
  --data-file <value>

--data accepts the REST JSON payload; --data-file reads it from a file or '-' for stdin. Do not combine payload JSON with body flags.
```

### `inbot messages delete`

```text
Usage: inbot messages delete <inbox_id> <message_id> [options]

Delete a message.

```

### `inbot messages batch-get`

```text
Usage: inbot messages batch-get <inbox_id> [options]

Read up to 500 unique message IDs.

  --message-ids <value> (repeatable)
  --data <value>
  --data-file <value>

--data accepts the REST JSON payload; --data-file reads it from a file or '-' for stdin. Do not combine payload JSON with body flags.
```

### `inbot messages batch-update`

```text
Usage: inbot messages batch-update <inbox_id> [options]

Update labels on up to 50 unique message IDs.

  --message-ids <value> (repeatable)
  --add-labels <value> (repeatable)
  --remove-labels <value> (repeatable)
  --data <value>
  --data-file <value>

--data accepts the REST JSON payload; --data-file reads it from a file or '-' for stdin. Do not combine payload JSON with body flags.
```

### `inbot messages attachment`

```text
Usage: inbot messages attachment <inbox_id> <message_id> <attachment_id> [options]

Download a message attachment; use -o <path> or redirected stdout.

  --output <value>

-o, --output <path> creates a private file and refuses to overwrite it. Omit it or use '-' for redirected binary stdout. --json returns download metadata only and cannot be combined with --output.
```

### `inbot messages raw`

```text
Usage: inbot messages raw <inbox_id> <message_id> [options]

Download the original MIME message; use -o <path> or redirected stdout.

  --output <value>

-o, --output <path> creates a private file and refuses to overwrite it. Omit it or use '-' for redirected binary stdout. --json returns download metadata only and cannot be combined with --output.
```

### `inbot messages reply-all`

```text
Usage: inbot messages reply-all <inbox_id> <message_id> [options]

Reply to all original recipients with an idempotency key.

  --reply-to <value> (repeatable)
  --text <value>
  --html <value>
  --labels <value> (repeatable)
  --data <value>
  --data-file <value>
  --idempotency-key <value>

--data accepts the REST JSON payload; --data-file reads it from a file or '-' for stdin. Do not combine payload JSON with body flags.

The Idempotency-Key is printed to stderr before sending. Reuse it with the same payload after an uncertain result.
```

## drafts

### `inbot drafts list`

```text
Usage: inbot drafts list [options]

List drafts, optionally within --inbox.

  --limit <value>
  --page-token <value>
  --ascending
  --before <value>
  --after <value>
  --labels <value> (repeatable)
  --inbox <value>
```

### `inbot drafts create`

```text
Usage: inbot drafts create <inbox_id> [options]

Create an incomplete, reply, or forward draft.

  --to <value> (repeatable)
  --cc <value> (repeatable)
  --bcc <value> (repeatable)
  --reply-to <value> (repeatable)
  --subject <value>
  --text <value>
  --html <value>
  --labels <value> (repeatable)
  --in-reply-to <value>
  --forward-of <value>
  --reply-all
  --send-at <value>
  --client-id <value>
  --data <value>
  --data-file <value>

--data accepts the REST JSON payload; --data-file reads it from a file or '-' for stdin. Do not combine payload JSON with body flags.
```

### `inbot drafts get`

```text
Usage: inbot drafts get <draft_id> [options]

Get a draft, optionally within --inbox.

  --inbox <value>
```

### `inbot drafts attachment`

```text
Usage: inbot drafts attachment <draft_id> <attachment_id> [options]

Download a draft attachment, optionally within --inbox.

  --inbox <value>
  --output <value>

-o, --output <path> creates a private file and refuses to overwrite it. Omit it or use '-' for redirected binary stdout. --json returns download metadata only and cannot be combined with --output.
```

### `inbot drafts update`

```text
Usage: inbot drafts update <inbox_id> <draft_id> [options]

Update a draft. Use --data for nulls or attachment changes.

  --to <value> (repeatable)
  --cc <value> (repeatable)
  --bcc <value> (repeatable)
  --reply-to <value> (repeatable)
  --subject <value>
  --text <value>
  --html <value>
  --send-at <value>
  --add-labels <value> (repeatable)
  --remove-labels <value> (repeatable)
  --data <value>
  --data-file <value>

--data accepts the REST JSON payload; --data-file reads it from a file or '-' for stdin. Do not combine payload JSON with body flags.
```

### `inbot drafts delete`

```text
Usage: inbot drafts delete <inbox_id> <draft_id> [options]

Delete a draft.

```

### `inbot drafts send`

```text
Usage: inbot drafts send <inbox_id> <draft_id> [options]

Send a draft now, overriding its schedule.

  --add-labels <value> (repeatable)
  --remove-labels <value> (repeatable)
  --data <value>
  --data-file <value>
  --idempotency-key <value>

--data accepts the REST JSON payload; --data-file reads it from a file or '-' for stdin. Do not combine payload JSON with body flags.

The Idempotency-Key is printed to stderr before sending. Reuse it with the same payload after an uncertain result.
```

### `inbot drafts approve`

```text
Usage: inbot drafts approve <inbox_id> <draft_id> [options]

Approve a draft as owner; scheduled drafts remain scheduled.

  --idempotency-key <value>

The Idempotency-Key is printed to stderr before sending. Reuse it with the same payload after an uncertain result.
```

### `inbot drafts reject`

```text
Usage: inbot drafts reject <inbox_id> <draft_id> [options]

Reject a draft as owner.

  --reason <value>
  --data <value>
  --data-file <value>

--data accepts the REST JSON payload; --data-file reads it from a file or '-' for stdin. Do not combine payload JSON with body flags.
```

## api-keys

### `inbot api-keys list`

```text
Usage: inbot api-keys list [options]

List API key metadata as owner.

  --limit <value>
  --page-token <value>
  --ascending
  --type <value>
  --inbox <value>
```

### `inbot api-keys create`

```text
Usage: inbot api-keys create [options]

Create a scoped API key as owner. --show-secret prints its one-time secret.

  --name <value>
  --inbox-id <value>
  --inbox-ids <value> (repeatable)
  --permissions <value>
  --send-policy <value>
  --expires-at <value>
  --data <value>
  --data-file <value>
  --inbox <value>
  --show-secret

--data accepts the REST JSON payload; --data-file reads it from a file or '-' for stdin. Do not combine payload JSON with body flags.
```

### `inbot api-keys get`

```text
Usage: inbot api-keys get <api_key_id> [options]

Read API key metadata as owner; never returns the secret.

```

### `inbot api-keys update`

```text
Usage: inbot api-keys update <api_key_id> [options]

Update an API key's name, permissions, or send policy as owner.

  --name <value>
  --permissions <value>
  --send-policy <value>
  --data <value>
  --data-file <value>
  --inbox <value>

--data accepts the REST JSON payload; --data-file reads it from a file or '-' for stdin. Do not combine payload JSON with body flags.
```

### `inbot api-keys revoke`

```text
Usage: inbot api-keys revoke <api_key_id> [options]

Revoke an API key as owner.

  --inbox <value>
```

## lists

### `inbot lists list`

```text
Usage: inbot lists list <direction> <type> [options]

List allow/block entries for receive, send, or reply; --inbox selects an inbox.

  --limit <value>
  --page-token <value>
  --inbox <value>
```

### `inbot lists create`

```text
Usage: inbot lists create <direction> <type> [options]

Add one exact address or domain; blocks win over allows.

  --entry <value>
  --reason <value>
  --data <value>
  --data-file <value>
  --inbox <value>

--data accepts the REST JSON payload; --data-file reads it from a file or '-' for stdin. Do not combine payload JSON with body flags.
```

### `inbot lists get`

```text
Usage: inbot lists get <direction> <type> <entry> [options]

Read one allow/block entry, optionally within --inbox.

  --inbox <value>
```

### `inbot lists delete`

```text
Usage: inbot lists delete <direction> <type> <entry> [options]

Remove an entry, optionally within --inbox.

  --inbox <value>
```

### `inbot lists rejections`

```text
Usage: inbot lists rejections [options]

List rejected inbound metadata as owner, optionally filtered by --inbox-id.

  --limit <value>
  --page-token <value>
  --inbox-id <value>
```

### `inbot lists delete-rejection`

```text
Usage: inbot lists delete-rejection <rejection_id> [options]

Delete rejected inbound metadata as owner; this does not accept the mail.

```

## webhooks

### `inbot webhooks list`

```text
Usage: inbot webhooks list [options]

List webhook metadata, optionally within --inbox.

  --limit <value>
  --page-token <value>
  --ascending
  --inbox <value>
```

### `inbot webhooks create`

```text
Usage: inbot webhooks create [options]

Create a webhook. --show-secret prints its one-time signing secret.

  --url <value>
  --event-types <value> (repeatable)
  --inbox-ids <value> (repeatable)
  --client-id <value>
  --headers <value>
  --data <value>
  --data-file <value>
  --inbox <value>
  --show-secret

--data accepts the REST JSON payload; --data-file reads it from a file or '-' for stdin. Do not combine payload JSON with body flags.
```

### `inbot webhooks get`

```text
Usage: inbot webhooks get <webhook_id> [options]

Get webhook metadata.

  --inbox <value>
```

### `inbot webhooks update`

```text
Usage: inbot webhooks update <webhook_id> [options]

Update event filters, enabled state, or inbox filters.

  --event-types <value> (repeatable)
  --enabled
  --add-inbox-ids <value> (repeatable)
  --remove-inbox-ids <value> (repeatable)
  --data <value>
  --data-file <value>
  --inbox <value>

--data accepts the REST JSON payload; --data-file reads it from a file or '-' for stdin. Do not combine payload JSON with body flags.
```

### `inbot webhooks delete`

```text
Usage: inbot webhooks delete <webhook_id> [options]

Delete a webhook and its pending deliveries.

  --inbox <value>
```

### `inbot webhooks headers`

```text
Usage: inbot webhooks headers <webhook_id> [options]

List custom header names without their values.

  --inbox <value>
```

### `inbot webhooks update-headers`

```text
Usage: inbot webhooks update-headers <webhook_id> [options]

Set or remove custom headers.

  --headers <value>
  --remove-headers <value> (repeatable)
  --data <value>
  --data-file <value>
  --inbox <value>

--data accepts the REST JSON payload; --data-file reads it from a file or '-' for stdin. Do not combine payload JSON with body flags.
```

## events

### `inbot events`

```text
Usage: inbot events --follow [--json] [--last-event-id <id>] [--inbox <id>] [--event-type <type>] [--home <directory>]

Stream accessible events. Filters are repeatable. Resume after a previously received event ID. Ctrl-C stops the stream.
```

## oauth

### `inbot oauth clients`

```text
Usage: inbot oauth clients [options]

List authorized OAuth clients and grants as owner.

```

### `inbot oauth revoke`

```text
Usage: inbot oauth revoke <grant_id> [options]

Revoke an OAuth grant and every token as owner.

```

### `inbot oauth purge`

```text
Usage: inbot oauth purge [options]

Purge unused OAuth client registrations as owner.

```

## remote

### `inbot remote status`

```text
Usage: inbot remote status [options]

Inspect optional remote access (owner, local URL).

```

### `inbot remote enable`

```text
Usage: inbot remote enable [options]

Download the verified connector and provision remote access (owner, local URL).

  --hostname <value>
  --data <value>
  --data-file <value>

--data accepts the REST JSON payload; --data-file reads it from a file or '-' for stdin. Do not combine payload JSON with body flags.
```

### `inbot remote disable`

```text
Usage: inbot remote disable [options]

Stop the connector and remove its recorded DNS and tunnel (owner, local URL).

```

## domains

### `inbot domains list`

```text
Usage: inbot domains list [options]

List domains as owner.

  --limit <value>
  --page-token <value>
  --ascending
```

### `inbot domains create`

```text
Usage: inbot domains create [options]

Register a domain as owner; apply its plan separately.

  --domain <value>
  --allow-conflicting-provider
  --feedback-enabled
  --inbound-enabled
  --subdomains-enabled
  --tracking-enabled
  --data <value>
  --data-file <value>

--data accepts the REST JSON payload; --data-file reads it from a file or '-' for stdin. Do not combine payload JSON with body flags.
```

### `inbot domains get`

```text
Usage: inbot domains get <domain_id> [options]

Inspect domain state and DNS records as owner.

```

### `inbot domains update`

```text
Usage: inbot domains update <domain_id> [options]

Update supported domain options as owner.

  --feedback-enabled
  --inbound-enabled
  --subdomains-enabled
  --tracking-enabled
  --data <value>
  --data-file <value>

--data accepts the REST JSON payload; --data-file reads it from a file or '-' for stdin. Do not combine payload JSON with body flags.
```

### `inbot domains delete`

```text
Usage: inbot domains delete <domain_id> [options]

Delete a domain after teardown as owner.

```

### `inbot domains zone-file`

```text
Usage: inbot domains zone-file <domain_id> [options]

Print domain DNS records as a text zone file.

```

### `inbot domains plan`

```text
Usage: inbot domains plan <domain_id> [options]

Inspect the provisioning plan before applying it as owner.

```

### `inbot domains verify`

```text
Usage: inbot domains verify <domain_id> [options]

Check domain DNS and provider verification as owner.

```

### `inbot domains apply`

```text
Usage: inbot domains apply <domain_id> [options]

Provision the registered domain using its plan as owner.

```

### `inbot domains teardown`

```text
Usage: inbot domains teardown <domain_id> [options]

Remove recorded provider resources as owner.

```

## transport

### `inbot transport status`

```text
Usage: inbot transport status [options]

Inspect transport and token verification metadata as local owner.

```

### `inbot transport configure`

```text
Usage: inbot transport configure [options]

Verify and save transport credentials from INBOT_CLOUDFLARE_API_TOKEN or --token-stdin.

  --account-id <value>
  --token-stdin

Provide the token through INBOT_CLOUDFLARE_API_TOKEN or --token-stdin (raw token, trailing newline allowed). Never put it in command arguments. --account-id is optional when exactly one account is accessible. Configure verifies before saving; there is no separate verify route.
```

### `inbot transport clear`

```text
Usage: inbot transport clear [options]

Clear transport credentials after tearing down provisioned resources as owner.

```

## quarantine

### `inbot quarantine list`

```text
Usage: inbot quarantine list [options]

List inbound quarantine metadata as owner.

  --limit <value>
  --page-token <value>
```

### `inbot quarantine retry`

```text
Usage: inbot quarantine retry <quarantine_id> [options]

Retry a quarantined buffer object as owner; Queue metadata cannot be retried.

```

### `inbot quarantine delete`

```text
Usage: inbot quarantine delete <quarantine_id> [options]

Delete quarantined ciphertext and metadata as owner. This is permanent.

```

## service

### `inbot service install`

```text
Usage: inbot service install [--home <directory>] [--flavor development|production] [--json] [--port <1-65535>]

Requires an installed release and an initialized keychain home. Port defaults to 8025. Complete setup with foreground serve --init and stop it first. Reinstall restarts the service. Setup codes, if still needed, go to <home>/logs/service.log; inbot open --browser provides a login link.
```

### `inbot service uninstall`

```text
Usage: inbot service uninstall [--home <directory>] [--flavor development|production] [--json]

Stops and removes only the user service definition. Mail, logs, and keychain entries are retained.
```

### `inbot service status`

```text
Usage: inbot service status [--home <directory>] [--flavor development|production] [--json]

Reports observed manager state, the installed port, and HTTP health. Unknown manager state is never reported as running.
```
