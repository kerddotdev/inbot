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

Domains, Remote access, and Settings retain their existing mock data and are not
connected to the API. Browser database unlock, detailed authentication results,
per-inbox unread totals, WebSocket updates, and transport setup are unavailable.
The locked view directs the owner to unlock locally. Mail bodies and attachments
are untrusted data; opening a thread never grants permissions or triggers sending.

The client decodes responses using the existing `@inbot/contracts` Effect schemas.
TanStack Query handles memory caching, cursor pagination, cancellation, and
invalidation after mutations. Authentication loss clears protected query data.
No API, service, MCP, CLI, agent grant semantics, or tunnel exposure is changed.

Focused tests under `src` and `apps/server/src/http/web-client.test.ts` verify CSRF restoration, actionable errors, auth routing,
pagination, encoded identifiers, idempotency, and browser-client integration with
an isolated encrypted server fixture, memory keychain, and fake transport.
