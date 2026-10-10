import { Effect, Schema } from "effect";
import { Mailbox } from "../mailbox/mailbox.js";
import { authenticateInbound } from "./authentication.js";
import { InboundError } from "./errors.js";
import { extractInbound } from "./extract.js";
import { parseInbound } from "./parse.js";
import { InboundPayload, type InboundInput } from "./payload.js";

export const MAX_INBOUND_BYTES = 25 * 1024 * 1024;

export const InboundRecipientResult = Schema.Union([
  Schema.Struct({
    recipient: Schema.String,
    status: Schema.Literal("stored"),
    message_id: Schema.String,
    thread_id: Schema.String,
  }),
  Schema.Struct({
    recipient: Schema.String,
    status: Schema.Literals(["skipped_paused", "skipped_unknown"]),
  }),
]);
export type InboundRecipientResult = typeof InboundRecipientResult.Type;

export function ingestInbound(
  payload: InboundInput,
  options: { readonly trusted_authserv_ids?: readonly string[] } = {},
) {
  return Effect.gen(function* () {
    if (payload.raw.byteLength > MAX_INBOUND_BYTES)
      return yield* new InboundError({
        code: "payload_too_large",
        message: "The inbound MIME payload exceeds 25 MiB.",
        fix: "Reject messages larger than 25 MiB before ingestion.",
      });
    const metadata = yield* Schema.decodeUnknownEffect(InboundPayload)(payload).pipe(
      Effect.mapError(
        () =>
          new InboundError({
            code: "invalid_payload",
            message: "The inbound envelope or received timestamp is invalid.",
            fix: "Decode a valid inbound envelope with an RFC 3339 received_at timestamp.",
          }),
      ),
    );
    const parsed = yield* Effect.tryPromise({
      try: () => parseInbound(payload.raw, metadata.received_at),
      catch: () =>
        new InboundError({
          code: "invalid_mime",
          message: "The inbound MIME payload could not be parsed.",
          fix: "Check the MIME structure and parser limits before retrying.",
        }),
    });
    const extracted = yield* Effect.try({
      try: () => extractInbound(parsed),
      catch: () =>
        new InboundError({
          code: "extraction_failed",
          message: "The inbound reply body could not be extracted.",
          fix: "Check the MIME body and extractor compatibility before retrying.",
        }),
    });
    const { date, authentication_results: authenticationResults, ...message } = parsed;
    const labels = ["received", "unread"];
    if (authenticateInbound(authenticationResults, options.trusted_authserv_ids) !== "pass")
      labels.push("unauthenticated");
    const mailbox = yield* Mailbox;
    const results: InboundRecipientResult[] = [];
    for (const recipient of metadata.rcpt_to) {
      const inboxId = recipient.toLowerCase();
      const inbox = yield* mailbox
        .getInbox(inboxId)
        .pipe(
          Effect.catchTag("MailboxError", (error) =>
            error.code === "not_found" ? Effect.succeed(undefined) : Effect.fail(error),
          ),
        );
      if (inbox === undefined) {
        results.push({ recipient: inboxId, status: "skipped_unknown" });
      } else if (inbox.status === "paused") {
        results.push({ recipient: inboxId, status: "skipped_paused" });
      } else {
        const stored = yield* mailbox.insertMessage({
          ...message,
          ...extracted,
          inbox_id: inboxId,
          direction: "received",
          from: parsed.from || metadata.mail_from,
          timestamp: date,
          labels,
          raw: payload.raw,
        });
        results.push({ recipient: inboxId, status: "stored", ...stored });
      }
    }
    return results;
  });
}
