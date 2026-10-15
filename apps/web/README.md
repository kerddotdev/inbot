# Owner UI

Build with `pnpm web:build` and serve the bundle using the server's explicit
`--web-root /absolute/path/to/apps/web/dist` option. Requests use relative `/v0`
URLs on the same loopback origin. No owner bearer token is stored in the browser.

Implemented screens:

- Setup with the terminal's one-time code and a password, sign-in, sign-out,
  session checking on load, and single-use login link redemption. Link tokens
  are removed from browser history before rendering. Cookie sessions use the
  server-issued CSRF token for unsafe requests; reload restores it through status.
- Real inboxes, cursor-paginated threads and messages, sanitized HTML or plain-text
  message bodies, mark read/unread, thread labels, new mail, and replies. HTML
  rendering follows the isolation and remote-content rules below. Sends retain an idempotency key when retrying
  the same composition and report queueing separately from provider delivery.
- New inbox in the sidebar and empty Mail view creates an address from a username,
  domain, and optional display name. The domain picker loads registration details
  and offers only VERIFIED domains. If none are available or lookup fails, manual
  entry remains available with a warning that receiving mail requires a configured,
  verified domain. Lookup failures show the server's fix and a retry action.
  Manage inbox in the Mail header edits the display name and active/paused status.
  Paused inboxes are labeled in the sidebar. Clearing a display name shows the
  address instead. Deletion requires a second confirmation explicitly stating
  that all mail is permanently deleted. Successful deletion clears cached threads,
  refreshes related lists, and selects a remaining inbox or returns to the empty view.
  Pending operations disable controls; validation and duplicate-address errors
  show the server's message and fix. These actions use the existing inbox endpoints.
  Message and draft attachments download as files through signed download URLs;
  message raster CID images can also be displayed inside the isolated HTML view.
- API key listing, creation with inbox scope, explicit permissions and send policy,
  one-time secret display, editing of names, permissions and send policies, and
  revocation. Edits apply on the next request without rotating the secret. Key secrets are not cached or persisted.
- Pending approval listing across all draft pages, draft review, approval, and
  rejection with an optional reason. Scheduled approval is shown separately from
  immediate queueing. Failed operations show the server's message and fix.
- Settings > Mail transport inspects safe configuration metadata, verifies and saves
  Cloudflare credentials, and clears configuration after domain teardown and remote disablement. Changing accounts also requires deleting domain registrations. Token inputs
  are password fields cleared on submission; tokens are never returned, displayed again,
  or stored in query/mutation variables. Account ID is optional: one accessible account is
  detected after token verification; multiple-account errors list names and IDs for an
  explicit choice. The Create API token button opens a prefilled dashboard link. Its
  adjacent instruction asks the owner to narrow Account Resources and Zone Resources
  to their account and mail zone before token creation. Required permissions expands
  a table with scope, level, and purpose, including the optional remote access tunnel.
  Both copy and URL come from the
  [shared permission definition](../../packages/contracts/src/cloudflare-permissions.ts).
  Its two email keys and tunnel key were owner-verified against the live dashboard on
  2026-10-11. See the
  [token setup notes](../server/src/provision/README.md#token-permissions).
- Settings > Allow and block lists manages global and inbox entries for receive, send,
  and reply using the shared API. Scope, direction, and list type are explicit; entries
  have cursor pagination, optional reasons, and removal. Blocks win over allows;
  the screen explains exact matching and how non-empty allow lists restrict mail.
  Rejected mail shows owner-only metadata for the selected inbox (all inboxes with
  Global), with refresh, pagination, loading/empty/error states, and deletion.
  Legacy records show missing metadata explicitly. No subject or body is exposed;
  deleting a record does not accept the mail.
- Owner-only domain registration, list and detail loading, plan preview, resumable
  apply, verification followed by a fresh GET, teardown, registration deletion, and
  supported feature updates. Domain and per-record DNS states, incomplete DNS
  placeholders, self-test reasons, and actionable errors use server responses.
  Teardown and deletion require explicit confirmation. BIND exports download as
  authenticated blobs using the owner session. Pending operations disable actions;
  pending and verifying domains refresh while the view is open.
- Settings webhook creation with one-time signing secret, listing, failure state,
  enable/disable and delete. Metadata refreshes while the section is open.
- Vault: searchable credential list with inbox filter, field refs, on-demand owner
  reveal (kept in component state and cleared after a minute), live TOTP code with
  countdown, create, edit, generate password and delete, plus Bitwarden JSON import and
  export. Approvals also lists pending credential use requests and agent credential
  requests (the agent's reason is shown as plain text). Settings > Remote browser
  hosts edits the remote fill allowlist. Reveal, export, import and fulfill are
  blocked through the tunnel and show the server's error.
- Authenticated WebSocket updates invalidate mail, draft, approval and domain
  caches. Reconnect uses backoff, durable event IDs and a cache refresh.

Registration requires a configured transport; without one the server's
`validation_error` message and fix are shown as returned.

Remote access uses the owner API with explicit download confirmation and observed connector state. OAuth consent uses the shared grant editor, defaults to Full access with approval and explicit inbox selection, and redirects signed-out owners through sign-in before returning to the request. API keys lists and revokes authorized grants and purges unused OAuth registrations. Browser
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

## HTML messages

HTML is preferred when `extracted_html ?? html` exists, including an explicitly
empty extracted body. HTML and Plain text buttons switch formats; plain text
uses `extracted_text ?? text`. Show full HTML message reveals the sanitized
original when extraction changed it; Show extracted HTML switches back. Plain-text
messages retain their styling.

DOMPurify uses explicit HTML element and attribute allowlists. Scripts, event
handlers, forms, embedded documents, SVG, unsafe links, base URLs, meta refresh,
stylesheets and resource-bearing CSS are removed. Only a small set of inline
formatting properties remains. The document has its own restrictive CSP and
renders in a `srcdoc` iframe without script permission.
Popup permissions allow user-activated links to open a usable new tab; every
link uses `_blank` and `noopener noreferrer`. Referrers are suppressed.

The sandbox grants same-origin access only so the host can measure the document
and size the frame to its content. Scripts stay disabled by both the sandbox and
the frame CSP, so the sanitized document never runs code. Never add
`allow-scripts` to this frame: combined with same-origin access it would let mail
content escape the sandbox. It stays
on a light paper surface in both app themes, with a theme-token border and
visible keyboard focus. The frame has a message title and reachable links.

HTTP(S) images are blocked by default. Load remote images allows them for that
message only, in memory until reload or the owner session ends; Block remote
images reverses it. This can contact the sender's image host and reveal that the
message was opened. External backgrounds, image sets (`srcset`), stylesheets,
and relative image URLs remain blocked. Notices appear only for detected
external sources. The host CSP permits HTTP(S) image protocols because `srcdoc`
inherits it; the frame CSP and sanitizer enforce the per-message choice.

CID images resolve only to the same message's `content_id` attachments through
`api.messageAttachment`, including the signed local download and issuer checks.
PNG, JPEG, GIF, WebP and AVIF attachments up to 10 MiB with matching response
types are converted to in-memory data URLs. SVG and other attachments remain
download-only. Direct raster data images are allowed; arbitrary blob and data
URLs are removed. All attachments retain their download action, including inline
images, so saving remains possible and failed previews never hide attachments.
Download and unsafe-image errors include the existing code and actionable fix.

Sanitization is a browser presentation step. REST, MCP and CLI still receive raw
`html` and `extracted_html` as untrusted data. There are no new routes, permissions,
events or tunnel exposures. Sanitizer tests cover active content, URLs, external
images, consent, CID scope, CSS and image sets without asserting static UI markup.

Settings includes Quarantine beside receive-list rejection history. It loads paginated owner metadata with reason, source kind, first-seen time, known size, and tracked attempt count. Buffer objects support Retry; pending release shows Finish cleanup. Delete asks for confirmation and permanently removes ciphertext before the visible record. Queue items explain that they retain metadata only and cannot be retried. Loading, empty, locked, and request failure states are explicit. Mutations disable concurrent controls, refresh metadata after success or failure, and report another permanent failure as still quarantined. Owner `inbound.*` WebSocket events invalidate quarantine queries, including after reconnect.
