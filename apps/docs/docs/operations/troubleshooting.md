---
title: Troubleshooting
description: Find and fix common problems with startup, sign-in, agents, sending, receiving, domains, webhooks and remote access.
---

Every Inbot error carries a `code` and a `fix`. Start there; this page covers the cases where the cause is less obvious.

## Startup

| Symptom                                                               | Cause and fix                                                                                                                                             |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.failed` with `not_initialized`                                | The home has no keys. Start once with `--init`, or check that `--home` or `INBOT_HOME` points where you expect.                                           |
| `server.failed` with `keychain_unavailable`                           | The OS keychain is locked or Inbot was denied access. Unlock it and allow access. On Linux, start a Secret Service such as GNOME Keyring in your session. |
| `keychain_entry_missing`                                              | The keychain item for this home is gone. The database cannot be opened without it.                                                                        |
| `keys_file_corrupt` or `database_key_invalid`                         | `keys.json` is damaged or does not belong to this database. Restore both files from the same backup.                                                      |
| `already_initialized` with `--init`                                   | `inbot.db` exists without `keys.json`. Do not delete the database; restore `keys.json`.                                                                   |
| A source-checkout command does not see your installed instance's data | Source checkouts default to `~/.inbot-dev`, installed packages to `~/.inbot`. Pass the same `--home` or `--flavor` to both.                               |
| The web app is not served                                             | In a source checkout, build it and pass `--web-root` with a relative or absolute path to `apps/web/dist`.                                                 |

Additional startup codes are `home_unavailable`, `key_storage_unavailable`, `database_failed` and `key_crypto_failed`; see [unlock and startup codes](/operations/service#unlock). A missing keychain entry cannot currently be recovered through a passphrase command, even if the internal error fix mentions one.

## Background service

| Symptom                                              | Cause and fix                                                                                                                                                        |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inbot service install` returns `action_required`    | The home is not initialized for keychain unlock. Run `inbot serve --init`, finish setup, stop it, then install again.                                                |
| `inbot service install` returns `not_supported`      | Services need a release package on macOS, Linux or Windows. Source checkouts are refused.                                                                            |
| `inbot service install` returns `missing_permission` | `INBOT_URL` or `INBOT_API_KEY` is set. Unset both and run it as the owner.                                                                                           |
| `service_unavailable` on Linux                       | `systemctl --user` needs a working user systemd session, and the keychain needs Secret Service at login.                                                             |
| Status shows `state: unknown`                        | The service manager could not be observed, so Inbot does not claim it is running. Check the manager directly and the logs.                                           |
| `http_healthy` is true but `running` is false        | A foreground `inbot serve` may be answering on that port. Stop it, then check status again.                                                                          |
| The service does not start                           | Read `<home>/logs/service.err.log` and `service.log`. Startup failures are printed there as `server.failed`. Two installed homes need two different ports.                       |
| No setup code to enter                               | A pending setup code is written to `<home>/logs/service.log`. Alternatively run `inbot open --browser` for a login link.                                             |
| The service fails after an upgrade                   | The unit pins the old package's paths. Run `inbot service install` again.                                                                                            |

## Sign-in

| Symptom                                 | Cause and fix                                                                                                                                                                                                                |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `403 missing_permission` in the browser | Open `http://127.0.0.1:<port>`, not `localhost`. The service only accepts its exact host and origin.                                                                                                                         |
| The setup code is rejected              | Each start prints a new code until setup completes. Use the code from the current run.                                                                                                                                       |
| `429 rate_limit_exceeded`               | Failed password attempts back off for up to a minute. Wait, or restart the service to reset it.                                                                                                                              |
| Forgotten password                      | There is no reset. From the same machine, `inbot open` prints a login link, and `POST /v0/owner/password` changes the password with the current one. Without the current password, the password cannot be changed today.     |
| `inbot open` fails                      | Check that the service is running and the CLI uses the same home and flavor. A login link expires after two minutes and is lost on service restart; generate a fresh one. Password setup is not required to create the link. |

## Agents and the CLI

| Symptom                                                 | Cause and fix                                                                                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The agent stopped connecting after a restart            | With `--port 0`, the port changes on every start. Use a fixed `--port`.                                                                                      |
| `not_found` for an inbox that exists                    | The inbox is outside the key's scope. Hidden labels apply separately to messages and threads, which return `not_found` without the matching read permission. |
| `missing_permission`                                    | `fix` names the permission. Owner-only routes have no permission for agents.                                                                                 |
| `approval_required`                                     | Expected for keys with the `approval` policy. Approve the draft on the Approvals page.                                                                       |
| CLI exits with code 10                                  | The service is not running, `connection.json` is from another home, or the URL is wrong. Check the service output and the `--home` you pass.                 |
| CLI says `INBOT_URL` and `INBOT_API_KEY` are incomplete | Set both or neither. The CLI never falls back to owner access.                                                                                               |
| `page_token_stale`                                      | The filters changed or new mail invalidated a search. Start again without a page token.                                                                      |

## Sending

| Symptom                           | Cause and fix                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `503 service_unavailable` on send | No mail transport is configured. See [Mail transport](/guides/transport).                                                                                     |
| Messages stay `queued`            | The service only sends while it runs. Retryable Cloudflare errors back off for up to an hour between attempts.                                                |
| `failed` with a `send_reason`     | The reason comes from Cloudflare or from the lists. `domain_not_verified` means Cloudflare does not accept the sender yet; check the domain's status.         |
| `send_unknown`                    | Do not resend. Confirm what happened, then [resolve it](/guides/approvals#resolve-an-unknown-send-outcome).                                                   |
| `message_rejected`                | A send or reply list blocks a recipient. Check global and inbox lists.                                                                                        |
| `sent` but no `delivered` label   | Delivery reports can take time, and reports during the first minutes after setup, or while the service was offline for more than five minutes, can be missed. |

## Receiving

| Symptom                                          | Cause and fix                                                                                                                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mail to an address never arrives                 | The address needs an inbox; there is no catch-all. The domain must be `VERIFIED`, and the inbox must be `active`.                                                                                            |
| Mail arrives late                                | Mail waits in Cloudflare while the service is down. A missed Queue pointer is picked up by reconciliation within 15 minutes.                                                                                 |
| A sender's mail disappears                       | Check **Settings > Allow and block lists > Rejected mail**. A non-empty allow list rejects everyone not on it.                                                                                               |
| An agent cannot see a message the app shows      | The message has a hidden label such as `unauthenticated`, and the key lacks the matching `label_*_read` permission.                                                                                          |
| Teardown refuses because the bucket is not empty | Inbound mail is still waiting. Keep the service running until it is fetched. Objects that failed permanently are quarantined. Retry or delete them in **Settings > Quarantine** or with `inbot quarantine`, then retry the teardown. |

## Quarantine

| Symptom                                           | Cause and fix                                                                                                                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A message never arrived and there is no rejection | Check **Settings > Quarantine** or `inbot quarantine list`. Mail that can never be processed, such as corrupt ciphertext or invalid MIME, is kept there with a reason code.     |
| Retry returns `quarantined`                       | The object failed permanently again. The ciphertext is kept and the reason is updated.                                                                                           |
| Retry says `released`, but no message appears     | Release means processing and cleanup finished. The receive allow and block lists still apply, so the mail may have been rejected; check **Rejected mail**.                       |
| Retry returns `not_supported`                     | Queue items hold metadata only. Retry the separately listed buffer object, or delete the Queue item.                                                                             |
| `action_required` on retry or delete              | The Cloudflare buffer configuration is missing or differs from the one that received the mail, or a deletion is still pending. Restore the original configuration, then try again. |
| An item shows `release_pending` or `delete_pending` | Cleanup was interrupted. Retry a `release_pending` item to finish it; repeat the delete for a `delete_pending` item. Reconciliation also finishes interrupted deletions.                                                               |
| `page_token_stale` when paging                    | The list changed. Start again without a page token.                                                                                                                              |

## Domains

| Symptom                                             | Cause and fix                                                                                                                                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stuck in `VERIFYING`                                | Waiting for public DNS or the encrypted self-test arrival. Verification can take about ten minutes or longer; the self-test retries every five minutes. Check record states and the reported reason. |
| `FAILED` with `action_required`                     | Read `reason`. Common causes: apex mail records changed during apply, an existing routing rule for an address, or a missing token permission.                                                        |
| `missing_permission` naming a Cloudflare permission | The token lacks it or does not cover the zone. Save a replacement token.                                                                                                                             |

## Webhooks

| Symptom                               | Cause and fix                                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `disabled_reason: sustained_failure`  | Eight consecutive failures. Fix the receiver, then re-enable with `inbot webhooks update <id> --enabled`. |
| `disabled_reason: credential_revoked` | The key that created the webhook was revoked, expired, or lost `webhook_create`.                          |
| `validation_error` on create          | Agents must use public HTTPS URLs. Only the owner may use HTTP, and only to loopback.                     |
| Signature does not verify             | Sign the raw body, not re-serialized JSON, and check the timestamp tolerance and the `whsec_` prefix.     |

## Remote access

| Symptom                                    | Cause and fix                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `action_required` on enable                | A DNS record already exists at the hostname, the token lacks Tunnel permission, or the zone is not in the account. |
| Stuck in `connecting`                      | The connector cannot reach Cloudflare. It retries with backoff up to 60 seconds.                                   |
| `403` on management routes over the tunnel | Expected. Manage keys, domains, transport and remote access on the machine itself.                                 |
| OAuth token rejected over the tunnel       | Tokens are bound to the origin they were issued for. Authorize again through the tunnel URL.                       |
