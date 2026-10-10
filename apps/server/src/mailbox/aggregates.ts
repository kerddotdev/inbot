import type Database from "better-sqlite3-multiple-ciphers";
import { Schema } from "effect";
import { itemColumns, messageItemRow } from "./rows.js";
import { normalizedSubject } from "./threading.js";
import { timestampKey } from "./pagination.js";

const Direction = Schema.Struct({ direction: Schema.Literals(["received", "sent"]) });

export function refreshThread(
  db: Database.Database,
  inboxId: string,
  threadId: string,
  now: string,
) {
  const messages = db
    .prepare(`
    SELECT ${itemColumns}, m.direction FROM messages m
    WHERE m.inbox_id = ? AND m.thread_id = ? ORDER BY m.timestamp_key, m.message_id
  `)
    .all(inboxId, threadId)
    .map((row) => ({
      ...messageItemRow(db, row),
      direction: Schema.decodeUnknownSync(Direction)(row).direction,
    }));
  const first = messages[0];
  const last = messages.at(-1);
  if (!first || !last) {
    db.prepare("DELETE FROM threads WHERE inbox_id = ? AND thread_id = ?").run(inboxId, threadId);
    return;
  }
  db.prepare(`
    UPDATE threads SET subject = ?, timestamp = ?, timestamp_key = ?,
      received_timestamp = ?, sent_timestamp = ?, senders = ?, recipients = ?,
      preview = ?, last_message_id = ?, message_count = ?, size = ?, attachments = ?, updated_at = ?
    WHERE inbox_id = ? AND thread_id = ?
  `).run(
    normalizedSubject(first.subject) ?? null,
    last.timestamp,
    timestampKey(last.timestamp),
    messages.findLast((message) => message.direction === "received")?.timestamp ?? null,
    messages.findLast((message) => message.direction === "sent")?.timestamp ?? null,
    JSON.stringify([...new Set(messages.map((message) => message.from))]),
    JSON.stringify([
      ...new Set(
        messages.flatMap((message) => [
          ...message.to,
          ...(message.cc ?? []),
          ...(message.bcc ?? []),
        ]),
      ),
    ]),
    last.preview ?? "",
    last.message_id,
    messages.length,
    messages.reduce((sum, message) => sum + message.size, 0),
    JSON.stringify(messages.flatMap((message) => message.attachments ?? [])),
    now,
    inboxId,
    threadId,
  );
}
