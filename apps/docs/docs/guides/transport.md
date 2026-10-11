---
title: Mail transport
description: Create the Cloudflare API token Inbot needs, with every permission explained, then verify, save, rotate and clear it safely.
---

The mail transport is the Cloudflare account Inbot uses to receive and send mail. Inbot talks to Cloudflare's API with one API token that you create and store in Inbot's encrypted database. Sending, domain provisioning, inbound pulling and remote access all need it.

## Required token permissions

| Scope   | Permission          | Level | Used for                                                                   |
| ------- | ------------------- | ----- | -------------------------------------------------------------------------- |
| Zone    | Zone                | Read  | Find the zone that holds your mail domain                                  |
| Zone    | DNS                 | Edit  | Snapshot and manage mail DNS records, and the remote access hostname       |
| Zone    | Zone Settings       | Edit  | Enable and unlock Email Routing DNS for the mail subdomain                 |
| Zone    | Email Routing Rules | Edit  | Route each inbox, and the verification self-test address, to the Worker    |
| Account | Email Sending       | Edit  | Sending subdomains, their DNS, outbound mail and the self-test             |
| Account | Workers Scripts     | Edit  | Upload and manage the inbound Email Worker                                 |
| Account | Workers R2 Storage  | Edit  | The encrypted inbound bucket, and reading and deleting its objects         |
| Account | Queues              | Edit  | Inbound and delivery-event Queues, their consumers and event subscriptions |
| Account | Cloudflare Tunnel   | Edit  | Optional, only for [remote access](/guides/remote-access)                  |

The same list drives the web app's **Required permissions** table, the prefilled token link and the errors Inbot shows when a permission is missing, so they cannot disagree.

## Configure it in the web app

Open **Settings > Mail transport**.

1. Select **Create API token**. Cloudflare's token page opens with Inbot's permissions prefilled and the name `Inbot`.
2. The template starts with all accounts and all zones. Narrow **Account Resources** to your account and **Zone Resources** to your mail zone before you create the token.
3. Paste the token into **API token**. Leave **Account ID** empty unless the token reaches several accounts.
4. Select **Verify and save**.

The token field is a password field that clears when you submit. Inbot never returns, displays or logs the token again.

### What verification checks

Verification confirms that the token is active and finds its account:

- Without an account ID, Inbot verifies the token and lists the accounts it can reach. With exactly one account, that account is selected. With none or several, you get `action_required` listing each account's name and ID; submit again with the right ID.
- With an account ID, Inbot verifies the token against that account.

Verification does not prove the token has every permission or that its resource scopes include your zone. Cloudflare checks each call when it happens, and a refused call becomes a `missing_permission` error that names the missing permission and asks you to save a replacement token. If verification fails, the previous configuration stays in place.

## Configure it with the API

The transport is owner-only. There is no CLI command and no MCP tool for it.

```sh
TOKEN=$(jq -r .token ~/.inbot/connection.json)
curl -s http://127.0.0.1:8025/v0/owner/transport \
  -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"api_token":"<cloudflare token>"}'
```

| Route                        | Result                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `GET /v0/owner/transport`    | `provider`, `account_id`, `token_set`, `verification_status` (`not_configured`, `unverified`, `verified`) and `verified_at` |
| `PUT /v0/owner/transport`    | `{ "api_token", "account_id"? }`. Verifies, then saves. `account_id` is 32 hex characters.                                  |
| `DELETE /v0/owner/transport` | Clears the configuration. Repeating it is safe.                                                                             |

## Rotate or change accounts

- **Rotate** by saving a new token for the same account. Changes take effect on the next loop cycle, without a restart.
- **Change accounts** only after tearing down every domain and disabling remote access. Inbot refuses a token for a different account while either still belongs to the old one.

## Clear it

`DELETE /v0/owner/transport`, or **Clear transport** in Settings, returns `action_required` while remote access is enabled or any domain still has provisioned resources. [Tear down](/guides/domains#tear-down) domains and [disable remote access](/guides/remote-access#disable) first. Clearing keeps your local mail, the inbound decryption key and your domain registrations.
