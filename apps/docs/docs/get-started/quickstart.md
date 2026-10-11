---
title: Quickstart
description: From the first start of the service to an agent reading and answering mail in its own inbox, with your approval before anything is sent.
---

This walkthrough takes you from an empty machine to an agent with its own inbox. It assumes Inbot is [installed](/get-started/install); in a source checkout, replace `inbot` with `pnpm start:cli` after [building](/development/build). You need a Cloudflare account with an active zone for your domain.

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

Keep the process running in this terminal.

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

On the **Domains** page, register a dedicated subdomain such as `agents.example.com`, review the plan, and apply it. Inbot creates the Email Worker, the encrypted buffer, routing and sending configuration, then waits for public DNS and sends itself a test message. The domain becomes **Verified** only after that encrypted test message has actually arrived, which usually takes a few minutes.

Read [Domains](/guides/domains) before applying to an existing zone.

## 5. Create an inbox

The web app does not create inboxes yet. Use the CLI on the same machine, which acts as the owner:

```sh
inbot inboxes create --username support --domain agents.example.com
```

The inbox ID is the address, `support@agents.example.com`. Inbot adds the Email Routing rule for it in the background.

## 6. Give your agent a key

On the **API keys** page, create a key:

- **Inbox:** `support@agents.example.com`
- **Permissions:** `inbox_read`, `message_read`, `message_reply`, `message_update`
- **Send policy:** `approval`, so you approve each reply before it leaves

Copy the key now; it is shown only once. The same works from the CLI:

```sh
inbot api-keys create --name support-agent --inbox-id support@agents.example.com \
  --permissions '{"inbox_read":true,"message_read":true,"message_reply":true,"message_update":true}' \
  --send-policy approval --show-secret
```

## 7. Connect the agent

For Claude Code:

```sh
claude mcp add --transport http inbot http://127.0.0.1:8025/mcp \
  --header "Authorization: Bearer $INBOT_API_KEY"
```

[Connect an agent](/agents/connect) covers other MCP clients, OAuth, the CLI and REST.

## 8. Try it

Send an email from your personal address to `support@agents.example.com`, then ask your agent to check its inbox and reply. It will call `list_threads`, read the message, and call `reply_to_message`. Because the key uses the `approval` policy, the reply appears on the **Approvals** page instead of being sent. Approve it, and the message is queued and sent.

## Next

- [Concepts](/get-started/concepts) explains grants, send policies and labels.
- [Security model](/concepts/security) explains what Cloudflare can and cannot see.
- [The owner app](/guides/owner-app) tours every screen.
- [Remote access](/guides/remote-access) lets agents in the cloud use the same inbox.
