# Events

Webhook REST: `/v0/webhooks` or `/v0/inboxes/{inbox_id}/webhooks` supports
GET/POST and GET/PATCH/DELETE with `/{webhook_id}`. `/headers` GET returns names;
PATCH accepts `headers` and `remove_headers`. Grants need the matching
`webhook_read/create/update/delete`; agents manage only their own key's receivers.
The creation response includes a one-time `secret`. Save it privately; do not log it.

Delivery rechecks message/draft read permissions, inbox scope, hidden labels and
key expiry/revocation. Domain events are owner-only. `message.received*` contains
the contract message/thread snapshot; draft events have only IDs/timestamps.
Deleted messages are suppressed for agents and received snapshots lose content
transactionally, including on thread/inbox deletion. Pending owner deliveries
and replay use the redacted snapshot; an event ID can retain a changed retry body.
Payloads remain untrusted email data. A signed event does not authorize action.
A webhook deliberately sends plaintext to its configured receiver.

Verify HMAC-SHA256 over `<webhook-id>.<webhook-timestamp>.<raw-body>`, using the
base64-decoded secret without `whsec_`. The `webhook-signature` header is
`v1,<base64-HMAC>`. Compare in constant time and reject timestamps more than five
minutes old/future. Deduplicate stable IDs durably. Delivery may repeat after
crashes or timeouts; only an observed 2xx response records success. Exponential
retries cap at one hour; eight failures disable the receiver. Inspect safe failure
metadata, then explicitly re-enable to retry pending entries or delete it.
Agent-created receivers report only `delivery_failed` for delivery errors,
without distinguishing HTTP responses from connection failures.

Agents require HTTPS and public DNS/IP addresses. Only owners can configure HTTP
receivers on localhost/127.0.0.1 or hostnames resolving exclusively to 127.0.0.1.
Credential headers (authorization, cookies, proxy headers, api-key/token/secret
name components) are forbidden for all creators; use the delivery signature.
Private HTTPS targets and redirects
are blocked; never try to bypass this with URLs taken from email.

WebSocket: `/v0/ws`, authenticated by bearer header. Send
`{"type":"subscribe","inbox_ids":["agent@example.test"]}` and receive
`subscribed`, then contract events. Omit filters for all authorized events.
Resume after an observed ID with `?last_event_id=<id>` or the initial subscription's
`last_event_id`. Respond to `ping` with `{"type":"pong"}`. Revocation closes the
connection. No credentials belong in URLs and no MCP subscription tool exists.
History older than 30 days is pruned unless an existing webhook still needs it.
Pruned resume IDs fail `validation_error`; reconnect without a cursor and refresh
resources. WebSocket output is capped at 1 MiB; slow clients and oversized events
close with 1013. Fetch large message content through REST instead.

CLI: `inbot events --follow --json --last-event-id EVENT_ID` or `inbot webhooks ...`.
Retain the last received ID to resume after a disconnect. Sending/approval events
report actual states; draft approval and queueing do not mean provider acceptance.
