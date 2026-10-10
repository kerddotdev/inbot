# Inbound Email Worker

`@inbot/worker` implements a Cloudflare Email Worker handler. It rejects raw MIME above 25 MiB, frames the SMTP envelope with the unchanged MIME stream, encrypts it with X25519 age into R2, then sends a JSON pointer only after the R2 write completes. Sender and recipient appear only inside the ciphertext. It does not read MIME headers, attach object metadata, forward mail, or log anything. The provider still sees plaintext in transit; this provides zero-knowledge storage at rest, not end-to-end encryption.

Required owner-account bindings:

- `INBOUND_BUCKET`: R2 bucket for ciphertext.
- `INBOUND_QUEUE`: Queue for version 1 inbound pointers.
- `RECIPIENT`: the owner's public X25519 age recipient. Never configure the private identity in the Worker.

The version 1 plaintext is `INBOT-INBOUND/1\n`, a 4-byte big-endian JSON byte length, UTF-8 JSON `{"mail_from": message.from, "rcpt_to": [message.to]}` (at most 16 KiB), then raw MIME. Cloudflare's [email handler API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/#forwardableemailmessage-interface) exposes one envelope `RCPT TO` as `message.to: string` per invocation, and envelope `MAIL FROM` as `message.from: string`. The Worker records that recipient as a single-element array; MIME `To:` headers cannot substitute for it, especially for BCC, aliases, and lists.

The encrypted stream's `size(framed.length(message.rawSize))` supplies the exact length for Cloudflare's native `FixedLengthStream`, including plaintext frame overhead. The Worker awaits the R2 upload and the Queue send in the email handler. Errors propagate; if Queue submission fails after storage, the ciphertext remains for the planned service's R2 listing reconciliation. A retry can create another random object: exactly-once delivery and duplicate reconciliation are not implemented here. The pointer schema and R2 key format are unchanged and intentionally contain no sender, recipient, subject, or message identifier.

`pnpm typecheck` checks the Worker against `@cloudflare/workers-types` 5.20260929.1 in an isolated configuration with no Node globals. The separate test configuration permits Node APIs only for tests. `pnpm build` emits JavaScript, including the Worker module at `dist/apps/worker/src/index.js`. This is compilation, not a deployable bundle: resolving and bundling workspace exports and npm dependencies for Cloudflare API upload remains future work. There is no Wrangler configuration, deploy script, provisioning, or runnable local mail service.

Node tests use in-memory R2 and Queue fakes and a length-checking stand-in for `FixedLengthStream`. They do not prove native R2 stream acceptance, native stream cancellation, X25519 compatibility or fallback behavior in Workers, 25 MiB CPU time, isolate memory under concurrent messages, or the platform's SMTP retry/bounce behavior after an uncaught email-handler exception. These require an explicitly authorized deployed test. No automatic retry guarantee is assumed.

References: [email handler](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/), [R2 binding](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [FixedLengthStream](https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/#fixedlengthstream), [Queue send](https://developers.cloudflare.com/queues/configuration/javascript-apis/).
