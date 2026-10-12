---
title: Quickstart
description: From the first start of the service to an agent reading and answering mail in its own inbox, with your approval before anything is sent.
---

This walkthrough takes you from an empty machine to an agent with its own inbox. It assumes Inbot is [installed](/get-started/install). In a source checkout, [build the service and web app](/development/build), replace `inbot` with `pnpm start:cli`, and pass `--web-root "$PWD/apps/web/dist"` when serving. Source commands default to `~/.inbot-dev`; use an explicit `--home` for development. You need a Cloudflare account with an active zone for your domain.

## 1. Start the service

```sh
inbot serve --init --port 8025
```

`--init` creates the home (`~/.inbot`), generates the database key and stores its wrapping key in your OS keychain. Your system may ask you to allow access. Later starts drop `--init`. A fixed `--port` keeps the URL stable for agents.

The first start prints two lines:

```json
{"event":"owner.setup_required","code":"<one-time setup code>"}
{"event":"server.ready","url":"http://127.0.0.1:8025"}
```

Keep the process running in this terminal for now. Step 8 shows how to run it as a background service instead.

## 2. Set your owner password

Open `http://127.0.0.1:8025`, enter the setup code from the terminal and choose a password of at least 12 characters. The code is valid only for this run of the service and only until setup completes.

Later, sign in with the password, or run `inbot open` to print a single-use login link that expires after two minutes.

## 3. Connect Cloudflare

Go to **Settings > Mail transport**:

1. Select **Create API token**. Cloudflare's dashboard opens with the required permissions prefilled.
2. Narrow **Account Resources** and **Zone Resources** to your account and mail zone, then create the token.
3. Paste the token and select **Verify and save**. If the token reaches more than one account, enter the account ID shown in the error.

[Mail transport](/guides/transport) lists every permission and why it is needed.

## 4. Provision your mail domain

On the **Domains** page, register a dedicated subdomain such as `agents.example.com`, select **Preview plan**, then **Apply automatically via Cloudflare**. Inbot creates the Email Worker, the encrypted buffer, routing and sending configuration, then waits for public DNS and sends itself a test message. The domain becomes **Verified** only after that encrypted test message has actually arrived, which can take about ten minutes or longer. The self-test retries every five minutes while no arrival has been observed.

Read [Domains](/guides/domains) before applying to an existing zone.

## 5. Create an inbox

In the Mail sidebar, select **New inbox**, choose your verified domain, enter `support` as the username, and create the inbox. **Manage inbox** in Mail lets you edit its display name, pause or resume it, and delete it. Alternatively, use the CLI on the same machine, which acts as the owner:

```sh
inbot inboxes create --username support --domain agents.example.com
```

The inbox ID is the address, `support@agents.example.com`. Inbot adds the Email Routing rule for it in the background.

## 6. Give your agent a key

On the **API keys** page, create a key:

- **Inbox:** `support@agents.example.com`
- **Permissions:** **Full access**, the default preset, includes reading, drafting and sending. It does not grant every permission or owner administration. **Read only** and **Read and draft** are narrower presets; **Choose individual permissions** lets you customize them.
- **Send policy:** **Approval**, the default, so you approve each reply before it leaves

The form initially selects no inboxes. Select `support@agents.example.com`; choose **All current and future inboxes** only if that is the scope you intend.

Copy the key now; it is shown only once. The same works from the CLI:

```sh
inbot api-keys create --name support-agent --inbox-id support@agents.example.com \
  --permissions '{"inbox_read":true,"message_read":true,"message_reply":true,"message_update":true}' \
  --send-policy approval --show-secret
```

## 7. Connect the agent

For Claude Code, paste the key at the hidden prompt so it stays out of shell history. Run this in Bash or Zsh:

```sh
printf "Inbot API key: "
read -rs INBOT_API_KEY
printf "\n"
claude mcp add -s user --transport http inbot http://127.0.0.1:8025/mcp \
  --header "Authorization: Bearer $INBOT_API_KEY"
unset INBOT_API_KEY
```

See [Connect Claude Code](/agents/claude-code) to install the Inbot skill and verify the connection.

[Connect an agent](/agents/connect) covers other MCP clients, OAuth, the CLI and REST.

## 8. Keep it running

Foreground `inbot serve` stops when you close the terminal. After you have set the owner password, stop it with Ctrl-C and install the per-user background service:

```sh
inbot service install
inbot service status
```

The service starts at login with the same home on port 8025 (`--port` changes it). Setup is already complete, so it unlocks with the keychain and needs no setup code. Run `inbot open --browser` for a login link. Logs are in `<home>/logs/service.log` and `service.err.log`. See [Run as a background service](/operations/service#run-as-a-background-service) for the details.

## 9. Try it

Send an email from your personal address to `support@agents.example.com`, then ask your agent to check its inbox and reply. It will call `list_threads`, read the message, and call `reply_to_message`. Because the key uses the `approval` policy, the reply appears on the **Approvals** page instead of being sent. Approve it, and the message is queued. Committing the approval wakes the outbox immediately; inspect its state for provider acceptance and delivery.

## Next

- [Concepts](/get-started/concepts) explains grants, send policies and labels.
- [Security model](/concepts/security) explains what Cloudflare can and cannot see.
- [The owner app](/guides/owner-app) tours every screen.
- [Remote access](/guides/remote-access) lets agents in the cloud use the same inbox.
