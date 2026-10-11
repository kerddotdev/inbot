# OAuth authorization

Inbot is its own authorization server for public MCP and REST clients. No upstream
identity provider or network metadata lookup is involved. The owner signs in and
explicitly chooses inbox scope, permissions and send policy in the browser.
Client names and redirect targets are unverified, escaped text, never HTML or proof
of identity. Consent reuses the API key grant editor and displays the host or native
URI scheme. Denial preserves client state and returns `access_denied` only to a
validated registered callback.

## Discovery and protocol

- `GET /.well-known/oauth-protected-resource` describes the listener origin.
- `GET /.well-known/oauth-protected-resource/mcp` and
  `GET /.well-known/oauth-protected-resource/v0` describe the respective resources.
  MCP clients use the challenge's metadata URL first; absent a challenge, they try
  the path-specific document before the root fallback.
- `GET /.well-known/oauth-authorization-server` advertises the issuer, authorization,
  token, public registration and revocation endpoints and mandatory `S256` PKCE.
  `authorization_response_iss_parameter_supported` is true. Success, denial and
  redirected authorization errors include `iss` matching this listener's issuer.
- `POST /oauth/register` accepts a name and one to ten absolute redirect URIs.
  Clients are public (`token_endpoint_auth_method: none`). HTTPS, HTTP loopback
  and private-use URI scheme callbacks are supported, without userinfo, control
  characters or fragments. Dangerous schemes such as `javascript`, `data`, `file`,
  `vbscript`, `about` and `blob`, non-loopback HTTP and other reserved transport
  schemes are rejected. At authorization, loopback IP literals and `localhost`
  may change ports; scheme, host, literal path and query must still match.
- Registration ignores unknown metadata, accepts `client_uri`, `logo_uri`, `scope`,
  `software_id`, `software_version` and `contacts`, and never fetches any metadata.
  Invalid metadata returns `invalid_client_metadata`; unsafe callbacks return
  `invalid_redirect_uri`. `grant_types` must contain `authorization_code` if supplied;
  unsupported entries, including device-code grants, are ignored and the response
  contains only the supported requested subset. The default is `authorization_code`.
- `GET /oauth/authorize` ignores unknown parameters, including `prompt` and `nonce`,
  and opens the owner web UI. Without an owner browser session it redirects to
  sign-in with the pending request. Navigation may omit Origin and never issues a
  code. Once client and callback are validated, authorization errors redirect with
  `error`, `error_description`, `state` when supplied, and `iss`. Unvalidated callbacks
  receive an HTTP error without a redirect.
- `POST /oauth/authorize/details` validates and displays the consent request.
- `POST /oauth/authorize` approves or denies consent, returning `redirect_uri` for
  the UI to navigate. These two POSTs require an owner browser session, exact
  server Origin and CSRF. Owner bearer credentials and agent tokens cannot consent.
  The consent body and its grant use strict decoding; unknown fields are rejected.
  The owner UI defaults new consent to Full access with `approval`: sends have the
  required permissions but wait for owner approval. Inbox selection is explicit;
  existing grants retain their permissions and policy.
- `POST /oauth/token` accepts `authorization_code` with `code_verifier`, or
  `refresh_token`. Both require `client_id` and `resource`. Code exchange additionally
  binds to the exact `redirect_uri` used at authorization, including its chosen port.
  JSON and form-encoded requests work; unknown parameters are ignored and duplicate
  form/query parameters are rejected. OAuth errors use RFC error fields.
- `POST /oauth/revoke` accepts `client_id`, `token`, and an optional token type hint;
  it revokes the entire token family. Unknown parameters and hints are ignored.
  Unknown or foreign tokens return 200 without modifying another client's family.

Discovery, registration, token and revocation routes allow any browser Origin with
`Access-Control-Allow-Origin: *`, without credentials, including OPTIONS preflights.
They ignore incidental owner cookies. Authorize, consent and owner management routes
retain the exact Origin guard and never enable CORS.

`resource` must exactly equal `<listener origin>/mcp` or `<listener origin>/v0`
at authorization and token exchange. The loopback listener always uses its bound
loopback origin, even while remote access is enabled. The tunnel listener uses the
configured public HTTPS origin after remote access is usable. Issuer, endpoints,
audiences and challenges use that same listener identity, never forwarded headers.
Tokens cannot cross listeners or resources. Changing the tunnel hostname invalidates
old public audiences without changing local audiences. WebSocket connections belong to `/v0`. Download URLs are signed capabilities
bound to the issuing token and listener, so tokens of either audience can mint them. API keys retain their existing behavior.
401 responses include `WWW-Authenticate: Bearer resource_metadata="..."` pointing
to the matching path-specific metadata document and the `inbot` scope. A presented
invalid credential additionally receives `error="invalid_token"`; a missing credential
does not. OAuth scope `inbot` identifies the resource capability, never permissions.

## Credentials and persistence

Migration 13 adds the registry, consent timestamps, authorization codes, grant links,
token families, hashed opaque tokens and persistent rate counters to the encrypted
store. The migration runner remains strict. Grants reuse existing `api_keys` rows,
the `Grant` schema and agent principal identity. Internal rows have prefix `oauth`,
a random inaccessible secret hash and no issued API key. API key CRUD excludes
these rows and API key authentication explicitly rejects them. Existing permission,
inbox, hidden-label, sending, draft ownership and webhook ownership checks apply.

Codes and access tokens expire in five minutes. Grants whose code was never exchanged
are removed after code expiry during protocol/owner-list maintenance and emit an
owner-only revocation event. Refresh tokens rotate transactionally within a fixed
30-day family lifetime. Consumed refresh hashes remain for reuse detection. Reuse
revokes the family, including every access token, in the committed transaction before
the error is returned. Reusing a valid code revokes its issued families. Credentials
are opaque random values stored only as SHA-256 hashes. Verifiers and raw credentials
are never persisted or logged. Restarts do not restore revoked families. Discovery
and credential responses use `no-store`.

Public mutations use separate persistent loopback and tunnel buckets: 20 registrations
per hour, 120 token requests and 120 revocations per minute. Token requests charge a
bucket only after `client_id` resolves. Tunnel buckets additionally use a hash of
`CF-Connecting-IP`; missing/invalid IPs share a tunnel fallback bucket. This relies on
only cloudflared forwarding Internet traffic to the dedicated guarded listener and
Cloudflare supplying that header. The owner's host is trusted; do not expose this
listener directly or route arbitrary proxies into it. The ordinary loopback listener
ignores all proxy/IP headers. Expired counter windows are pruned. Clients that have
never received owner approval are pruned after 24 hours. Previously approved clients
are retained until owner purge. The registry remains capped at 1,000 clients.

## Owner management and tunnel boundary

`GET /v0/owner/oauth/clients` lists grants and minimal client metadata.
`DELETE /v0/owner/oauth/grants/:grant_id` revokes authorization and deletes every
code and token through cascading foreign keys.
`POST /v0/owner/oauth/clients/purge` deletes client registrations without any grant
and returns `{ "deleted_clients": <count> }`; granted clients remain untouched.
The API keys screen provides revoke and purge buttons. `inbot oauth clients`,
`inbot oauth revoke <grant_id>` and `inbot oauth purge` use the same owner-only
service methods. Management stays local and is excluded from MCP and tunnel access.
Owner-only durable events `oauth.authorized`, `oauth.revoked`, and
`oauth.tokens_revoked` invalidate the UI list and can reach owner webhooks; agent
subscriptions and webhooks cannot observe them. Purging registrations without grants
changes no authorization and emits no grant event. Events contain only grant/client
IDs and a timestamp, never secrets.

The tunnel exposes only declared discovery and OAuth protocol routes. Its dedicated
listener preserves public Host checks and rejects the local owner bearer everywhere.
Consent POSTs require exact Origin and CSRF. The sign-in shell is public, with Secure,
HttpOnly, SameSite=Strict owner cookies. Consent requires an explicit `--web-root`
bundle, including remotely.

Tests use temporary encrypted homes, memory keychains, synthetic mail, fake remote
provisioning and an injected clock. They do not send mail, provision resources,
fetch redirect metadata or contact a real account.

Protocol references: [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization),
[RFC 7591](https://www.rfc-editor.org/rfc/rfc7591),
[RFC 6749](https://www.rfc-editor.org/rfc/rfc6749),
[RFC 8252](https://www.rfc-editor.org/rfc/rfc8252),
[RFC 9728](https://www.rfc-editor.org/rfc/rfc9728),
[RFC 6750](https://www.rfc-editor.org/rfc/rfc6750) and
[RFC 9207](https://www.rfc-editor.org/rfc/rfc9207).
