import type Database from "better-sqlite3-multiple-ciphers";
import { receivedEvent } from "../events/log.js";
import { Schema } from "effect";
import {
  BatchGetMessagesRequest,
  BatchUpdateMessagesRequest,
  ListMessagesQuery,
  UpdateMessageRequest,
  type SendMessageResponse,
  type ListMessagesResponse,
  type UpdateMessageResponse,
  type BatchGetMessagesResponse,
  type BatchUpdateMessagesResponse,
} from "../../../../packages/contracts/src/messages.js";
import { alreadyExists, notFound, validate, validationError } from "./errors.js";
import { refreshThread } from "./aggregates.js";
import {
  BytesRow,
  getInbox,
  getMessage,
  itemColumns,
  messageItemRow,
  messageLabels,
} from "./rows.js";
import { keysetWhere, messageWhere, normalizedMailQuery, page, preparePage } from "./queries.js";
import { timestampKey } from "./pagination.js";
import { preview, resolveThread, sortableId } from "./threading.js";
import { InsertMessage } from "./types.js";

const managedSendLabels = new Set(["queued", "sent", "failed", "send_unknown"]);
const MessageIdentity = Schema.Struct({ message_id: Schema.String, thread_id: Schema.String });

export function insertMessage(
  db: Database.Database,
  request: InsertMessage,
  nowMillis: number,
): SendMessageResponse {
  const input = validate(InsertMessage, request);
  if (!/^<[^\s<>@]+@[^\s<>@]+>$/.test(input.message_id))
    throw validationError(
      "The message_id must be an RFC message identifier including angle brackets.",
    );
  getInbox(db, input.inbox_id);
  const existing = db
    .prepare("SELECT message_id, thread_id FROM messages WHERE inbox_id = ? AND message_id = ?")
    .get(input.inbox_id, input.message_id);
  if (existing !== undefined) return Schema.decodeUnknownSync(MessageIdentity)(existing);
  for (const alias of [input.message_id, ...(input.aliases ?? [])]) {
    if (!alias) throw validationError("Message aliases cannot be empty.");
    const found = db
      .prepare(`
      SELECT message_id FROM messages WHERE inbox_id = ? AND message_id = ?
      UNION ALL SELECT message_id FROM message_aliases WHERE inbox_id = ? AND alias = ?
    `)
      .get(input.inbox_id, alias, input.inbox_id, alias);
    if (found !== undefined) throw alreadyExists();
  }
  const now = new Date(nowMillis).toISOString();
  const threadId =
    resolveThread(db, input.inbox_id, input.in_reply_to, input.references ?? []) ??
    sortableId(nowMillis);
  db.prepare(`
    INSERT OR IGNORE INTO threads (thread_id, inbox_id, timestamp, timestamp_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(threadId, input.inbox_id, input.timestamp, timestampKey(input.timestamp), now, now);
  db.prepare(`
    INSERT INTO messages (inbox_id, message_id, thread_id, direction, "from", reply_to, "to", cc, bcc,
      subject, preview, text, html, extracted_text, extracted_html, in_reply_to, "references", headers,
      calendar_event_id, size, timestamp, timestamp_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.inbox_id,
    input.message_id,
    threadId,
    input.direction,
    input.from,
    JSON.stringify(input.reply_to ?? []),
    JSON.stringify(input.to),
    JSON.stringify(input.cc ?? []),
    JSON.stringify(input.bcc ?? []),
    input.subject ?? null,
    preview(input.extracted_text ?? input.text),
    input.text ?? null,
    input.html ?? null,
    input.extracted_text ?? null,
    input.extracted_html ?? null,
    input.in_reply_to ?? null,
    JSON.stringify(input.references ?? []),
    JSON.stringify(input.headers ?? {}),
    input.calendar_event_id ?? null,
    input.size ?? input.raw.byteLength,
    input.timestamp,
    timestampKey(input.timestamp),
    now,
    now,
  );
  db.prepare("INSERT INTO raw_messages (inbox_id, message_id, content) VALUES (?, ?, ?)").run(
    input.inbox_id,
    input.message_id,
    Buffer.from(input.raw),
  );
  for (const label of new Set(input.labels ?? [])) {
    db.prepare("INSERT INTO message_labels (inbox_id, message_id, label) VALUES (?, ?, ?)").run(
      input.inbox_id,
      input.message_id,
      label,
    );
  }
  for (const alias of new Set(input.aliases ?? [])) {
    db.prepare("INSERT INTO message_aliases (inbox_id, alias, message_id) VALUES (?, ?, ?)").run(
      input.inbox_id,
      alias,
      input.message_id,
    );
  }
  for (const attachment of input.attachments ?? []) {
    if (attachment.size !== undefined && attachment.size !== attachment.content.byteLength)
      throw validationError("The attachment size must match its content bytes.");
    const id = attachment.attachment_id ?? sortableId(nowMillis);
    if (
      db
        .prepare("SELECT 1 FROM attachments WHERE inbox_id = ? AND attachment_id = ?")
        .get(input.inbox_id, id) !== undefined
    )
      throw alreadyExists();
    db.prepare(`
      INSERT INTO attachments (attachment_id, inbox_id, message_id, filename, content_type, size,
        content_disposition, content_id, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.inbox_id,
      input.message_id,
      attachment.filename ?? null,
      attachment.content_type ?? null,
      attachment.content.byteLength,
      attachment.content_disposition ?? null,
      attachment.content_id ?? null,
      Buffer.from(attachment.content),
    );
  }
  refreshThread(db, input.inbox_id, threadId, now);
  if (input.direction === "received")
    receivedEvent(db, input.inbox_id, input.message_id, nowMillis);
  return { message_id: input.message_id, thread_id: threadId };
}

export function listMessages(
  db: Database.Database,
  inboxId: string,
  request: typeof ListMessagesQuery.Type,
): ListMessagesResponse {
  const query = validate(ListMessagesQuery, request);
  getInbox(db, inboxId);
  const { limit, expected, cursor } = preparePage(query, {
    resource: "messages",
    inbox_id: inboxId,
    ...normalizedMailQuery(query),
  });
  const where = messageWhere(inboxId, query);
  keysetWhere(where, cursor, "m.timestamp_key", "m.message_id", query.ascending ?? false);
  const order = query.ascending ? "ASC" : "DESC";
  const rows = db
    .prepare(`
    SELECT ${itemColumns}, m.timestamp_key AS cursor_key, m.message_id AS cursor_id
    FROM messages m WHERE ${where.sql} ORDER BY m.timestamp_key ${order}, m.message_id ${order} LIMIT ?
  `)
    .all(...where.params, limit + 1);
  const { items, ...fields } = page(rows, limit, expected, (row) => messageItemRow(db, row));
  return { ...fields, messages: items };
}

export function updateMessage(
  db: Database.Database,
  inboxId: string,
  messageId: string,
  request: UpdateMessageRequest,
  now: string,
  manageSendLabels = false,
): UpdateMessageResponse {
  const input = validate(UpdateMessageRequest, request);
  const identity = db
    .prepare("SELECT message_id, thread_id FROM messages WHERE inbox_id = ? AND message_id = ?")
    .get(inboxId, messageId);
  if (identity === undefined) throw notFound();
  const { thread_id: threadId } = Schema.decodeUnknownSync(MessageIdentity)(identity);
  const additions =
    typeof input.add_labels === "string" ? [input.add_labels] : (input.add_labels ?? []);
  const removals =
    typeof input.remove_labels === "string" ? [input.remove_labels] : (input.remove_labels ?? []);
  const managed =
    !manageSendLabels &&
    db
      .prepare("SELECT 1 FROM outbox WHERE inbox_id = ? AND message_id = ?")
      .get(inboxId, messageId) !== undefined;
  for (const label of additions.filter((label) => !managed || !managedSendLabels.has(label)))
    db.prepare(
      "INSERT OR IGNORE INTO message_labels (inbox_id, message_id, label) VALUES (?, ?, ?)",
    ).run(inboxId, messageId, label);
  for (const label of removals.filter((label) => !managed || !managedSendLabels.has(label)))
    db.prepare(
      "DELETE FROM message_labels WHERE inbox_id = ? AND message_id = ? AND label = ?",
    ).run(inboxId, messageId, label);
  db.prepare("UPDATE messages SET updated_at = ? WHERE inbox_id = ? AND message_id = ?").run(
    now,
    inboxId,
    messageId,
  );
  db.prepare("UPDATE threads SET updated_at = ? WHERE inbox_id = ? AND thread_id = ?").run(
    now,
    inboxId,
    threadId,
  );
  return { message_id: messageId, labels: messageLabels(db, inboxId, messageId) };
}

export function batchGetMessages(
  db: Database.Database,
  inboxId: string,
  request: BatchGetMessagesRequest,
): BatchGetMessagesResponse {
  const input = validate(BatchGetMessagesRequest, request);
  getInbox(db, inboxId);
  const messages = input.message_ids
    .filter(
      (id) =>
        db
          .prepare("SELECT 1 FROM messages WHERE inbox_id = ? AND message_id = ?")
          .get(inboxId, id) !== undefined,
    )
    .map((id) => getMessage(db, inboxId, id));
  return { limit: input.message_ids.length, count: messages.length, messages };
}

export function batchUpdateMessages(
  db: Database.Database,
  inboxId: string,
  request: BatchUpdateMessagesRequest,
  now: string,
): BatchUpdateMessagesResponse {
  const input = validate(BatchUpdateMessagesRequest, request);
  if (input.add_labels === undefined && input.remove_labels === undefined)
    throw validationError("Batch updates require add_labels or remove_labels.");
  getInbox(db, inboxId);
  const updates = input.message_ids
    .filter(
      (id) =>
        db
          .prepare("SELECT 1 FROM messages WHERE inbox_id = ? AND message_id = ?")
          .get(inboxId, id) !== undefined,
    )
    .map((id) => updateMessage(db, inboxId, id, input, now));
  return { limit: input.message_ids.length, count: updates.length, updates };
}

export function deleteMessage(
  db: Database.Database,
  inboxId: string,
  messageId: string,
  now: string,
) {
  const identity = db
    .prepare("SELECT message_id, thread_id FROM messages WHERE inbox_id = ? AND message_id = ?")
    .get(inboxId, messageId);
  if (identity === undefined) throw notFound();
  const { thread_id: threadId } = Schema.decodeUnknownSync(MessageIdentity)(identity);
  db.prepare("DELETE FROM messages WHERE inbox_id = ? AND message_id = ?").run(inboxId, messageId);
  refreshThread(db, inboxId, threadId, now);
}

export function getRawMessage(db: Database.Database, inboxId: string, messageId: string) {
  const row = db
    .prepare("SELECT content FROM raw_messages WHERE inbox_id = ? AND message_id = ?")
    .get(inboxId, messageId);
  if (row === undefined) throw notFound();
  return Schema.decodeUnknownSync(BytesRow)(row).content;
}
