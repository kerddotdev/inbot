import type Database from "better-sqlite3-multiple-ciphers";
import { Schema } from "effect";
import { OutboxEntry, type OutboundRequest } from "../../../../packages/contracts/src/outbound.js";
import { getMessage } from "../mailbox/rows.js";
import { getAttachment } from "../mailbox/threads.js";
import { compose } from "./compose.js";
import { invalid } from "./errors.js";

const ProviderIdRow = Schema.Struct({
  provider_message_id: Schema.NullOr(Schema.String),
  state: OutboxEntry.fields.state,
});

export function prepare(db: Database.Database, inboxId: string, request: OutboundRequest) {
  const parent = request.kind === "send" ? undefined : getMessage(db, inboxId, request.message_id);
  const sourceId =
    parent === undefined
      ? undefined
      : db
          .prepare(
            "SELECT provider_message_id, state FROM outbox WHERE inbox_id = ? AND message_id = ?",
          )
          .get(inboxId, parent.message_id);
  const source =
    sourceId === undefined ? undefined : Schema.decodeUnknownSync(ProviderIdRow)(sourceId);
  const parentRfcId =
    source?.state === "sent" ? (source.provider_message_id ?? undefined) : undefined;
  if (
    (request.kind === "reply" || request.kind === "reply-all") &&
    sourceId !== undefined &&
    parentRfcId === undefined
  )
    throw invalid("Wait for the outgoing parent to be accepted before replying to it.");
  return compose(inboxId, request, {
    ...(parent !== undefined ? { parent } : {}),
    ...(parentRfcId !== undefined ? { parent_rfc_id: parentRfcId } : {}),
    ...(request.kind === "forward" && parent
      ? {
          attachments: (parent.attachments ?? []).map((attachment) =>
            getAttachment(db, inboxId, parent.message_id, attachment.attachment_id),
          ),
        }
      : {}),
  });
}
