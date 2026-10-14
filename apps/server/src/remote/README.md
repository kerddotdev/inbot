# Optional remote access

Remote access is off until the owner explicitly enables it locally. Configure the
Cloudflare mail transport first. Its token additionally needs Account > Cloudflare
Tunnel > Edit (`Cloudflare Tunnel Write`), Zone > DNS > Edit, and Zone > Zone > Read
on the configured account and target zone. Enable accepts one unused literal
subdomain, never the zone apex, a wildcard, or a foreign zone. Multi-level
subdomains may require an Advanced Certificate from Cloudflare.

## Owner API and lifecycle

- `GET /v0/owner/remote` returns `state`, `hostname`, `reason`, and
  `connector_version`.
- `POST /v0/owner/remote/enable` accepts `{ "hostname": "inbot.example.com" }`.
- `POST /v0/owner/remote/disable` stops the child, deletes its owned DNS and
  tunnel, and reports disabled only after confirming teardown.

All three routes require local owner authentication. No remote-management MCP
tool exists. The UI asks for explicit confirmation before download and enable.
The CLI provides `inbot remote status|enable --hostname <hostname>|disable`.
Enable may take up to two minutes for download plus bounded provider operations;
a client timeout does not confirm failure. Inspect status and retry the same
hostname to reconcile. Changing hostname requires disabling the previous tunnel.
Token rotation is not implemented; disable and enable to replace the tunnel.

Migration 12 stores desired state, account/zone binding, a unique tunnel name,
creation intents, created tunnel/DNS IDs, and the tunnel token in the encrypted
database, after lists (10) and events (11).
The migration runner remains strict and contiguous. No token or provider
credential is returned by the contract. The connector receives its token through
the private runtime file described below.

Creation intents precede cloud effects. On retry, list named tunnels and reconcile
DNS by the exact hostname, target and ownership comment. Never replace existing
DNS. Disable also discovers resources from uncertain creates. IDs remain until
all teardown effects are confirmed; changed DNS or account binding stops cleanup
with an actionable reason. The provisioning configuration lock also protects
transport account changes and clearing while remote resources exist.

State is `disabled`, `provisioning`, `connecting`, `connected`, or
`action_required` with a reason. `connected` requires the spawned connector's
local `/ready` endpoint to confirm an active connection; starting a process is
not proof of connectivity or public DNS/TLS availability. Exits immediately
invalidate the displayed connection state. The scoped loop restarts exited
children with exponential backoff from one to 60 seconds. Disable and service
shutdown stop only the child captured at spawn. Shutdown retains desired state;
startup reconciles the existing tunnel and updates its dedicated listener port.
Provider or binary failures require a local retry instead of reporting success.

## Connector verification

`binary.ts` pins cloudflared 2026.9.1 and published SHA-256 values for macOS
arm64/x64, Linux arm64/x64, and Windows x64. Only explicit enable downloads from
the pinned GitHub release into `<home>/bin`. Every spawn verifies the cached
artifact, safely extracts the single macOS executable in memory, and replaces
and verifies the executable. Missing or invalid cache refuses startup; runtime
restarts never download. Automatic cloudflared updates are disabled.

The process adapter uses `spawn` with an argument array and `shell: false`.
cloudflared 2026.9.1 supports `--token-file`: a unique 0700 runtime directory
inside `<home>/bin` holds a 0600 token file. Only its path appears in argv; no
token is placed in the child's environment. The child inherits only PATH and
Windows SystemRoot where present. Stop, natural exit and spawn failure remove
the runtime directory. An abrupt host crash can leave this private file behind;
the home must remain protected. Existing bin directories are tightened to 0700
after rejecting symlinks, before reading or writing connector files. Unix modes
do not replace Windows filesystem ACLs.

The metrics endpoint binds `127.0.0.1:0` directly in cloudflared. Its bound port
is learned only from the spawned child's JSON stderr startup announcement, with
bounded line buffering and loopback/port validation. Readiness stays false until
that announcement and a successful `/ready` response. There is no released-port
reservation window. All other child output is discarded, never forwarded to
service logs or persisted. The local metrics endpoint has no authentication;
readiness assumes the host and the spawned process are trusted. Spawner,
downloader, and Effect clock are injectable; tests never download or run
cloudflared.

## Security boundary and exact allowlist

cloudflared targets a separate `127.0.0.1` listener on an ephemeral port. That
listener always applies the tunnel policy. Proxy headers cannot turn ordinary
loopback traffic into tunnel traffic or bypass the policy. Public Host must equal
the configured hostname; any supplied Origin must exactly equal its HTTPS origin.
Cloudflare terminates public TLS and sees requests in transit. Mail remains
zero-knowledge at rest, not end-to-end encrypted.

The tunnel listener permits:

- Exactly `/mcp`, with scoped API key, audience-bound OAuth token or owner browser session authentication.
- Exactly `/v0/ws` as an agent route, with API key or REST-audience OAuth bearer authentication or an
  owner browser session supplying exactly `Origin: https://<public host>`.
  Missing or mismatched session Origin is rejected. The common request guard
  runs before the events handler upgrades the connection; owner sessions also
  require the `inbot.events` and `csrf.<token>` subprotocols.
- `/v0` and `/v0/*` agent API routes with existing scope, label, permission and
  send-policy checks, including list permissions and scoped webhook ownership,
  subject to the management exclusions below. Signed
  `/v0/downloads/*` URLs use the public origin and remain on the agent allowlist.
  They are HMAC-signed, five-minute capabilities that need no bearer header or
  cookie. They recheck the issuing credential's activity, current permissions,
  scope, and hidden labels. Tokens bind the exact origin: local capabilities
  (including owner bearer capabilities) cannot cross to the tunnel, and tunnel
  capabilities cannot cross to the local listener. A supplied bearer must
  authenticate the issuing principal; local owner bearer headers remain rejected.
  Treat these URLs as temporary credentials and never log or publish them.
- Exactly `/.well-known/oauth-authorization-server`,
  `/.well-known/oauth-protected-resource`, and its `/mcp` and `/v0` variants.
- Exactly `/oauth/register`, `/oauth/token`, and `/oauth/revoke`, public with
  persistent rate limits. `/oauth/authorize` serves the session-gated consent UI;
  consent and `/oauth/authorize/details` POSTs require an owner browser session,
  exact public Origin and CSRF. Other OAuth/metadata paths are rejected.
  See [OAuth](../oauth/README.md) for resource binding and refresh rotation.
- `/`, `/login`, `/favicon.svg`, `/favicon.ico`, and `/assets/*` for the sign-in
  shell. Other web paths require an owner browser session and redirect to
  `/login` without one. Static serving still requires explicit `--web-root`.
- `/v0/owner/status` and `/v0/owner/login` for browser authentication;
  `/v0/owner/logout`, `/v0/owner/password`, `/v0/owner/sessions`, and
  `/v0/owner/sessions/:id` for authenticated browser session management.

The tunnel rejects `/v0/owner/*` except those exact auth routes, `/v0/domains`
and its descendants, `/v0/api-keys` and its descendants, and any inbox
`/api-keys` route. This includes transport, remote access, owner setup and
login-link creation/redemption. Management rejection is a clear 403
`missing_permission`, including with a valid owner browser session. The local
`connection.json` owner bearer is rejected on every tunneled path, including
public auth, static files, downloads and MCP. Agents cannot use owner-only
operations, including draft approval/rejection. Owner browser sessions can use
mail and approvals but cannot manage the excluded resources remotely.

Namespace boundaries are exact; lookalikes are web paths, not API namespaces.
The REST router matches static segments case-sensitively; uppercase characters
in path parameters remain intact. Policy classification uses the same URI path
decoding and trailing-slash handling as the router, preserving encoded URI
separators. Raw path `;` and `#` characters and their encoded forms are rejected
before routing, so FindMyWay cannot truncate a path after policy classification.
Query data is not part of the path. Malformed paths, double encodings, repeated
separators, backslashes, NULs and traversal are rejected before routing.
Cookies use `__Host-inbot_session`, Secure, HttpOnly and SameSite=Strict at the
public origin. Unsafe session requests require
CSRF. Authorization takes precedence over cookies and never falls back to them.
MCP's static Origin check receives a request without Origin only after the outer
guard has validated the dynamic public Origin.

No remote state webhook or WebSocket event is added. The durable mail event log,
signed webhook delivery and authenticated WebSocket replay are implemented.
The owner UI polls only while remote access is active; there is no
additional agent permission or send-policy bypass.

## Verification

Focused tests cover fake provisioning, uncertain effects, exact cleanup,
account binding, changed DNS, checksum refusal, cached tampering, injected
readiness port discovery, private token-file cleanup, existing bin permissions,
clock-driven restarts, shutdown, path separators and encodings, mixed static
casing, uppercase inbox parameters, key scope, owner-token rejection including
WebSocket upgrades, scoped list/webhook access, HTTPS cookies, Origin/Host checks
and CSRF. No real
Cloudflare account, DNS, tunnel, mail, keychain or connector download is used in
tests.

A separately authorized real-account run must validate token permissions,
provider response shapes, tunnel and DNS lifecycle, TLS certificate availability,
connector readiness and shutdown, restart recovery, and public REST/MCP/browser
flows. The five native artifacts and process behavior on other operating systems
also need actual platform validation.

Sources: [API lifecycle](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/),
[pinned token-file flag](https://github.com/cloudflare/cloudflared/blob/2026.9.1/cmd/cloudflared/tunnel/subcommands.go),
[pinned metrics binding and announcement](https://github.com/cloudflare/cloudflared/blob/2026.9.1/metrics/metrics.go),
[pinned JSON stderr logging](https://github.com/cloudflare/cloudflared/blob/2026.9.1/logger/create.go),
[pinned release checksums](https://github.com/cloudflare/cloudflared/releases/tag/2026.9.1).

Owner quarantine routes under `/v0/owner/quarantine` are blocked on the tunnel listener, including list, retry, and delete. They require a local owner connection; OAuth tokens and agent keys cannot access them locally either.

Credential use request listing and decisions follow draft approvals:
`GET /v0/credential-use-requests` and
`POST /v0/credential-use-requests/:request_id/approve|reject` permit owner browser
sessions with the exact public Origin and CSRF on decisions. Agent keys and
OAuth tokens cannot list or decide requests. Local owner bearer credentials are
refused through the tunnel. Browser fill still applies remote CDP endpoint and
origin restrictions after approval; `/v0/credentials/resolve` stays blocked.
The owner request UI is deferred. URL hints are agent claims, not verified origins.
