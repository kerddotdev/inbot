---
title: OAuth for MCP clients
description: How MCP clients connect with owner-approved OAuth grants instead of API keys, with every endpoint, lifetime and rule.
---

MCP clients that support OAuth can connect to Inbot without an API key. Inbot is its own authorization server: the client registers itself, sends the owner to a consent screen in the Inbot web app, and receives short-lived, audience-bound tokens. The owner chooses the grant, using the same inbox scope, permissions and send policy as for API keys.

## The flow

1. The client calls `/mcp` without a credential and receives `401` with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp", scope="inbot"`.
2. It reads the protected resource and authorization server metadata, and registers itself at `/oauth/register`.
3. It opens `/oauth/authorize` in the owner's browser. If the owner is signed out, they sign in first.
4. The owner sees **Allow access to Inbot?** with the client's name and redirect host, both as declared by the client and unverified, chooses a grant, and approves or denies.
5. The client exchanges the code at `/oauth/token` with its PKCE verifier and receives an access token and a refresh token.

Consent requires the web app, so the service must run with the bundled app or `--web-root`. Without it, `/oauth/authorize` returns `not_supported`.

## Endpoints

| Path                                                             | Purpose                                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET /.well-known/oauth-protected-resource`, `.../mcp`, `.../v0` | Resource metadata: `resource`, `authorization_servers`, `scopes_supported: ["inbot"]`                                          |
| `GET /.well-known/oauth-authorization-server`                    | Authorization server metadata                                                                                                  |
| `POST /oauth/register`                                           | Dynamic client registration. Public clients only (`token_endpoint_auth_method: none`), 1 to 10 `redirect_uris`. Returns `201`. |
| `GET /oauth/authorize`                                           | Opens the consent screen in the browser                                                                                        |
| `POST /oauth/token`                                              | `authorization_code` or `refresh_token` grants. JSON or form-encoded, at most 16 KiB.                                          |
| `POST /oauth/revoke`                                             | Revokes a token and its whole family. Always answers `200`.                                                                    |

Discovery, registration, token and revocation responses allow any origin (`Access-Control-Allow-Origin: *`, without credentials). Errors from these endpoints use the OAuth format, `{ error, error_description }`.

## Rules

| Rule               | Value                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Grant types        | `authorization_code` and `refresh_token`                                                                              |
| PKCE               | Required, `S256` only                                                                                                 |
| Scope              | `inbot`, optional. It grants nothing by itself; permissions come from the grant the owner chooses.                    |
| Resource           | Required at authorization and token exchange: exactly `<origin>/mcp` or `<origin>/v0`                                 |
| Redirect URIs      | HTTPS, HTTP on loopback only, or a private-use custom scheme. Loopback ports may change between registration and use. |
| Authorization code | Five minutes, single use                                                                                              |
| Access token       | Five minutes (`inbot_oauth_...`)                                                                                      |
| Refresh tokens     | Rotate on every use. The family ends 30 days after consent; rotation does not extend it.                              |

Reusing a refresh token that was already used revokes the whole family, including its access tokens. Reusing an authorization code revokes the tokens it issued.

Tokens are bound to the origin and resource they were issued for. A token for `/mcp` does not work on `/v0`, a token issued on the loopback URL does not work through the tunnel, and changing the remote access hostname invalidates tokens issued for the old one. WebSocket events and attachment downloads belong to `/v0`.

## Limits

Registration is limited to 20 per hour, and token and revocation requests to 120 per minute each, with separate counters for loopback and tunnel traffic. Over the limit, Inbot returns `429` with `Retry-After: 60`. At most 1,000 client registrations are kept; registrations that never receive a grant expire after 24 hours.

## Through remote access

OAuth works through the [tunnel](/guides/remote-access). Discovery, registration, token and revocation are reachable, and the consent screen works once the owner signs in to the web app over the tunnel.

## Manage grants

The owner sees every grant under **API keys > Authorized OAuth clients**, or with `inbot oauth clients`.

- `inbot oauth revoke <grant_id>` revokes a grant and every token it issued.
- `inbot oauth purge` deletes client registrations that have no grant. Existing grants are untouched.

OAuth management is owner-only and blocked over the tunnel. The `oauth.authorized`, `oauth.revoked` and `oauth.tokens_revoked` events are visible only to the owner.
