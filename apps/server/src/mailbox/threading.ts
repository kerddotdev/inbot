import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { Schema } from "effect";

export function sortableId(now: number) {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x70, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizedSubject(subject: string | undefined) {
  return subject
    ?.replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function preview(text: string | undefined) {
  return Array.from((text ?? "").replace(/\s+/g, " ").trim())
    .slice(0, 200)
    .join("");
}

const ThreadReference = Schema.Struct({ thread_id: Schema.String });

export function resolveThread(
  db: Database.Database,
  inboxId: string,
  inReplyTo: string | undefined,
  references: readonly string[],
) {
  for (const id of [...(inReplyTo ? [inReplyTo] : []), ...references.toReversed()]) {
    const row = db
      .prepare(`
      SELECT thread_id FROM messages WHERE inbox_id = ? AND message_id = ?
      UNION ALL
      SELECT m.thread_id FROM message_aliases a JOIN messages m
        ON m.inbox_id = a.inbox_id AND m.message_id = a.message_id
      WHERE a.inbox_id = ? AND a.alias = ? LIMIT 1
    `)
      .get(inboxId, id, inboxId, id);
    if (row !== undefined) return Schema.decodeUnknownSync(ThreadReference)(row).thread_id;
  }
  return undefined;
}
