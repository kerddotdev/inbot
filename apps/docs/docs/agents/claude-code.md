---
title: Connect Claude Code
description: Connect Claude Code to a local Inbot inbox over HTTP MCP, enter the API key without shell history, and install the Inbot skill.
---

## Prepare Inbot

Start the service with a fixed port, for example `inbot serve --port 8025`. Use `--init` only for the first start. Without `--port`, the service chooses a random free port on every start, so a saved MCP configuration will no longer point to it after a restart. Source checkouts need the [built web app and an explicit web root](/development/build).

Create an inbox and a scoped API key in the owner app. Select the intended inbox; new forms start with no inboxes selected. **Full access** with **Approval** permits reading, drafting and sending, with each send held for your approval. Copy the one-time secret.

## Add the MCP server

Run this in Bash or Zsh, replacing `8025` with your fixed port:

```sh
printf "Inbot API key: "
read -rs INBOT_API_KEY
printf "\n"
claude mcp add -s user --transport http inbot http://127.0.0.1:8025/mcp \
  --header "Authorization: Bearer $INBOT_API_KEY"
unset INBOT_API_KEY
```

`read -s` hides the pasted key and keeps its value out of shell history. The add command stores the expanded header in your private user MCP configuration, so protect that file. The bearer header is a credential; never commit or share the MCP configuration. User scope makes this connection available across projects on this machine. Use `127.0.0.1`, not `localhost`, because Inbot enforces its exact listener host. See the [official MCP setup guide](https://code.claude.com/docs/en/mcp).

## Install the Inbot skill

Download or clone the [public repository](https://github.com/kerddotdev/inbot), then copy its complete [`skills/inbot`](https://github.com/kerddotdev/inbot/tree/main/skills/inbot) folder, including the references, to your personal skills directory. This does not require building Inbot:

```sh
mkdir -p ~/.claude/skills
cp -R skills/inbot ~/.claude/skills/
```

This installs `~/.claude/skills/inbot/SKILL.md` and its `references/` directory. If that folder already exists, update the existing copy deliberately rather than keeping multiple versions. Personal skills apply to local projects on this machine; see the [official skills guide](https://code.claude.com/docs/en/skills).

## Check the workflow

Start Claude Code and inspect `/mcp` for the Inbot connection. Ask it to use the Inbot skill, list its inboxes and read unread threads. A reply under the approval policy creates a pending draft, not a sent message. Review it in the owner app's **Approvals** page.

If connection fails, check the service's printed URL, fixed port, key expiry and inbox scope. If a signed attachment URL is returned, fetch it directly without a bearer and never share or log it. See [Troubleshooting](/operations/troubleshooting) and [Reading and sending mail](/agents/mail).
