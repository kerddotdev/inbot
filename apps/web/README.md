# Owner UI

Build with `pnpm web:build` and serve the bundle using the server's explicit
`--web-root /absolute/path/to/apps/web/dist` option. Requests use relative `/v0`
URLs on the same loopback origin. No owner bearer token is stored in the browser.

Implemented screens:

- Setup with the terminal's one-time code and a password, sign-in, sign-out,
  session checking on load, and single-use login link redemption. Link tokens
  are removed from browser history before rendering. Cookie sessions use the
  server-issued CSRF token for unsafe requests; reload restores it through status.
- Real inboxes, cursor-paginated threads and messages, plain-text message bodies,
  mark read/unread, thread labels, new mail, and replies. HTML source is displayed
  as escaped text, never executed. Sends retain an idempotency key when retrying
  the same composition and report queueing separately from provider delivery.
- API key listing, creation with inbox scope, explicit permissions and send policy,
  one-time secret display, and revocation. Key secrets are not cached or persisted.
- Pending approval listing across all draft pages, draft review, approval, and
  rejection with an optional reason. Scheduled approval is shown separately from
  immediate queueing. Failed operations show the server's message and fix.
- Settings > Mail transport inspects safe configuration metadata, verifies and saves
  Cloudflare credentials, and clears configuration after domain teardown. Token inputs
  are password fields cleared on submission; tokens are never returned, displayed again,
  or stored in query/mutation variables. The screen lists required token permissions.
- Settings > Allow and block lists manages global and inbox entries for receive, send,
  and reply using the shared API. Scope, direction, and list type are explicit; entries
  have cursor pagination, optional reasons, and removal. Blocks win over allows;
  the screen explains exact matching and how non-empty allow lists restrict mail.
- Owner-only domain registration, list and detail loading, plan preview, resumable
  apply, verification followed by a fresh GET, teardown, registration deletion, and
  supported feature updates. Domain and per-record DNS states, incomplete DNS
  placeholders, self-test reasons, and actionable errors use server responses.
  Teardown and deletion require explicit confirmation. BIND exports download as
  authenticated blobs using the owner session. Pending operations disable actions;
  pending and verifying domains refresh while the view is open.
- Settings webhook creation with one-time signing secret, listing, failure state,
  enable/disable and delete. Metadata refreshes while the section is open.
- Authenticated WebSocket updates invalidate mail, draft, approval and domain
  caches. Reconnect uses backoff, durable event IDs and a cache refresh.

Registration requires a configured transport; without one the server's
`validation_error` message and fix are shown as returned.

Remote access uses the owner API with explicit download confirmation and observed connector state. Other Settings sections retain their existing mock data. Browser
database unlock, detailed authentication results, per-inbox unread totals, and
detailed event-history browsing is unavailable.
The locked view directs the owner to unlock locally. Mail bodies and attachments
are untrusted data; opening a thread never grants permissions or triggers sending.

The client decodes responses using the existing `@inbot/contracts` Effect schemas.
TanStack Query handles memory caching, cursor pagination, cancellation, and
invalidation after mutations. Authentication loss clears protected query data.
Owner transport routes are protected by owner authentication and CSRF. Agent grant
semantics, MCP tools, CLI commands, and tunnel exposure are unchanged.

Focused tests under `src` and `apps/server/src/http/web-client.test.ts` verify CSRF restoration, actionable errors, auth routing,
pagination, encoded identifiers, idempotency, and browser-client integration with
an isolated encrypted server fixture, memory keychain, and fake transport.

Thread messages offer Show quoted text only when the normalized full text contains
more text than the extracted reply. Whitespace-only differences do not show it.
