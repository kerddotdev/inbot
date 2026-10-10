# Inbound Email Worker

`@inbot/worker` implements a Cloudflare Email Worker handler. It rejects messages above 25 MiB, streams raw MIME through X25519 age encryption into R2, then sends a JSON pointer only after the R2 write completes. It does not read addresses or headers, attach object metadata, forward mail, or log anything. The provider still sees plaintext in transit; this provides zero-knowledge storage at rest, not end-to-end encryption.

Required owner-account bindings:

- `INBOUND_BUCKET`: R2 bucket for ciphertext.
- `INBOUND_QUEUE`: Queue for version 1 inbound pointers.
- `RECIPIENT`: the owner's public X25519 age recipient. Never configure the private identity in the Worker.

The encrypted stream's `size(message.rawSize)` supplies the length for Cloudflare's native `FixedLengthStream`. The Worker awaits the R2 upload and the Queue send in the email handler. Errors propagate; if Queue submission fails after storage, the ciphertext remains for the planned service's R2 listing reconciliation. A retry can create another random object: exactly-once delivery and duplicate reconciliation are not implemented here. The schema intentionally contains no sender, subject, or message identifier.

`pnpm typecheck` checks the Worker against `@cloudflare/workers-types` 5.20260929.1 in an isolated configuration with no Node globals. The separate test configuration permits Node APIs only for tests. `pnpm build` emits JavaScript, including the Worker module at `dist/apps/worker/src/index.js`. This is compilation, not a deployable bundle: resolving and bundling workspace exports and npm dependencies for Cloudflare API upload remains future work. There is no Wrangler configuration, deploy script, provisioning, or runnable local mail service.

Node tests use in-memory R2 and Queue fakes and a length-checking stand-in for `FixedLengthStream`. They do not prove native R2 stream acceptance, native stream cancellation, X25519 compatibility or fallback behavior in Workers, 25 MiB CPU time, isolate memory under concurrent messages, or the platform's SMTP retry/bounce behavior after an uncaught email-handler exception. These require an explicitly authorized deployed test. No automatic retry guarantee is assumed.

References: [email handler](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/), [R2 binding](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [FixedLengthStream](https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/#fixedlengthstream), [Queue send](https://developers.cloudflare.com/queues/configuration/javascript-apis/).
