import type Database from "better-sqlite3-multiple-ciphers";
import { Schema } from "effect";
import { Attachment } from "../../../../packages/contracts/src/attachments.js";
import { Inbox } from "../../../../packages/contracts/src/inboxes.js";
import { Message, MessageItem } from "../../../../packages/contracts/src/messages.js";
import { ThreadItem } from "../../../../packages/contracts/src/threads.js";
import { notFound } from "./errors.js";

const JsonRow = Schema.Record(Schema.String, Schema.Unknown);
const JsonString = Schema.String;
const LabelRow = Schema.Struct({ label: Schema.String });

function wireRow(value: unknown, jsonFields: readonly string[]): Record<string, unknown> {
  const row = Schema.decodeUnknownSync(JsonRow)(value);
  return Object.fromEntries(
    Object.entries(row)
      .filter(([, value]) => value !== null)
      .map(([key, value]) => [
        key,
        jsonFields.includes(key) ? JSON.parse(Schema.decodeUnknownSync(JsonString)(value)) : value,
      ]),
  );
}

export function inboxRow(value: unknown) {
  return Schema.decodeUnknownSync(Inbox)({
    ...wireRow(value, ["metadata"]),
    pod_id: "local",
  });
}

export function getInbox(db: Database.Database, inboxId: string) {
  const row = db
    .prepare("SELECT *, inbox_id AS email FROM inboxes WHERE inbox_id = ?")
    .get(inboxId);
  if (row === undefined) throw notFound();
  return inboxRow(row);
}

export const itemColumns = `m.inbox_id, m.thread_id, m.message_id, m.timestamp,
  m."from", m."to", m.cc, m.bcc, m.subject, m.preview, m.in_reply_to,
  m."references", m.headers, m.calendar_event_id, m.size, m.created_at, m.updated_at`;

export function messageLabels(db: Database.Database, inboxId: string, messageId: string) {
  return db
    .prepare(`
    SELECT label FROM message_labels WHERE inbox_id = ? AND message_id = ? ORDER BY label
  `)
    .all(inboxId, messageId)
    .map((row) => Schema.decodeUnknownSync(LabelRow)(row).label);
}

export function threadLabels(db: Database.Database, inboxId: string, threadId: string) {
  return db
    .prepare(`
    SELECT DISTINCT l.label FROM message_labels l JOIN messages m
      ON m.inbox_id = l.inbox_id AND m.message_id = l.message_id
    WHERE m.inbox_id = ? AND m.thread_id = ? ORDER BY l.label
  `)
    .all(inboxId, threadId)
    .map((row) => Schema.decodeUnknownSync(LabelRow)(row).label);
}

export function attachmentRow(row: unknown) {
  return Schema.decodeUnknownSync(Attachment)(wireRow(row, []));
}

export function messageAttachments(db: Database.Database, inboxId: string, messageId: string) {
  return db
    .prepare(`
    SELECT attachment_id, filename, content_type, size, content_disposition, content_id
    FROM attachments WHERE inbox_id = ? AND message_id = ? ORDER BY attachment_id
  `)
    .all(inboxId, messageId)
    .map(attachmentRow);
}

function messageData(db: Database.Database, value: unknown) {
  const row = wireRow(value, ["to", "cc", "bcc", "reply_to", "references", "headers"]);
  const ids = Schema.decodeUnknownSync(
    Schema.Struct({
      inbox_id: Schema.String,
      message_id: Schema.String,
    }),
  )(row);
  return {
    ...row,
    labels: messageLabels(db, ids.inbox_id, ids.message_id),
    attachments: messageAttachments(db, ids.inbox_id, ids.message_id),
  };
}

export function messageItemRow(db: Database.Database, row: unknown) {
  return Schema.decodeUnknownSync(MessageItem)(messageData(db, row));
}

export function messageRow(db: Database.Database, row: unknown) {
  return Schema.decodeUnknownSync(Message)(messageData(db, row));
}

export function getMessage(db: Database.Database, inboxId: string, messageId: string) {
  const row = db
    .prepare("SELECT * FROM messages WHERE inbox_id = ? AND message_id = ?")
    .get(inboxId, messageId);
  if (row === undefined) throw notFound();
  return messageRow(db, row);
}

export function threadRow(db: Database.Database, value: unknown) {
  const row = wireRow(value, ["senders", "recipients", "attachments"]);
  const ids = Schema.decodeUnknownSync(
    Schema.Struct({
      inbox_id: Schema.String,
      thread_id: Schema.String,
    }),
  )(row);
  return Schema.decodeUnknownSync(ThreadItem)({
    ...row,
    labels: threadLabels(db, ids.inbox_id, ids.thread_id),
  });
}

export function getThreadItem(db: Database.Database, inboxId: string, threadId: string) {
  const row = db
    .prepare("SELECT * FROM threads WHERE inbox_id = ? AND thread_id = ?")
    .get(inboxId, threadId);
  if (row === undefined) throw notFound();
  return threadRow(db, row);
}

export const BytesRow = Schema.Struct({ content: Schema.Uint8Array });
export const PageRow = Schema.Struct({
  cursor_key: Schema.Union([Schema.String, Schema.Finite]),
  cursor_id: Schema.String,
});
