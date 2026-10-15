# Browser credential use

The vault service fills and captures fields through CDP. Agents get field names,
origins and stable refs, never stored values. Both operations require
`credential_fill` and matching inbox scope, independently of mail send policy.
The credential must have a URL or allowed origins before use. The main frame
origin must match exactly; subframes cannot authorize a page.

## Browser connection

Pass `cdp_endpoint`, `selector`, `field`, optional page `url`, and optional
`target_id`. A page-level WebSocket uses that page directly. A browser-level
socket selects a page by target ID or URL hint; ambiguous pages need an explicit
hint. A URL hint selects a page and never adds a credential origin.

Sources of CDP endpoints include Chrome/Chromium launched with
`--remote-debugging-port=9222` (`http://127.0.0.1:9222`), Playwright
`chromium.launch({ args: ["--remote-debugging-port=9222"] })`, Chrome DevTools MCP
`--browserUrl`, or a remote browser provider's connect URL. The Inbot server must
be able to reach that endpoint; an agent's localhost is not necessarily Inbot's.
Keep CDP access private because it grants control over the browser.

Fill verifies the main frame, selects an editable element, verifies the frame
again, and sends the secret only with native `Input.insertText`. It does not put
values into JavaScript expressions. Fill on `totp` generates the current code from
the injected service clock, never types the seed, and returns no code. Capture
reads the value or displayed text into the encrypted database and returns refs;
`totp` capture normalizes a base32 setup key or otpauth URI. The owner can reveal
captured values through the existing local owner route.

Read and final state/event writes use separate short SQLite transactions. Success
records `last_used_at`; capture also updates the field and `updated_at`.
`credential.used` includes identity, field, origin and `via: "fill"`;
`credential.captured` includes identity, field and origin. Both require
`credential_read` and inbox scope for WebSocket/webhook visibility. No event
contains a value. The final transaction rechecks the credential and its origin.
Browser operations are non-idempotent: after a timeout or final database failure,
inspect the page and current vault state before retrying.

## Remote endpoint policy

Only the dedicated tunnel listener classifies traffic as remote. The REST context
and each MCP invocation preserve that classification, including when a session
moves between listeners. Client headers cannot mark requests as local.

Local requests may use any HTTP(S)/WS(S) endpoint, including loopback. Tunnel
requests require an owner allowlist in GET/PUT `/v0/owner/vault/settings`:
`{ "remote_cdp_hosts": ["browser.example.com", "*.browserbase.com"] }`.
The list accepts at most 32 lowercase DNS hostnames or wildcard suffixes, with no
IPs, ports or schemes. Wildcards require a subdomain; list an apex separately.
An empty list disables remote fill and capture. Owners can replace or clear the
list through local REST or `inbot vault settings show`/`set`. Agent credentials,
tunnel requests and MCP cannot manage it. The Settings UI is deferred.

Tunnel endpoints must use HTTPS/WSS. All resolved addresses must be public;
loopback, private, link-local, unique-local, CGNAT, multicast and reserved ranges
are rejected, including IPv4-mapped IPv6 forms. HTTP discovery redirects are
rejected and the returned WebSocket endpoint is checked separately before use.
DNS resolution is checked before connecting but is not pinned to the socket, so
DNS rebinding between validation and connection remains a residual risk. TLS
certificate validation on HTTPS/WSS limits that risk; allowlist only trusted
browser providers and hosts controlled by the owner.

## Errors

Every error uses existing wire codes and an actionable fix. Origin mismatch is
`missing_permission` and includes the observed origin; absent origins are
`validation_error` with a fix to set the credential URL or origins. Missing pages,
missing elements and non-editable elements are `validation_error`. Unreachable,
timed-out or invalid CDP connections are `service_unavailable`. Protocol peer
messages, captured values and endpoint credentials are never echoed in wire
errors. Scope violations return `not_found` before browser access; missing
`credential_fill` returns `missing_permission`.

Migration 17 adds owner vault settings with `CREATE TABLE IF NOT EXISTS`, keeping
migration replay from older versions safe. Existing credential deletion, field
removal and inbox cascading delete remain the way to remove captured values.
