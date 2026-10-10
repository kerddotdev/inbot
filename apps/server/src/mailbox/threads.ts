import type Database from "better-sqlite3-multiple-ciphers";
import { Schema } from "effect";
import { CursorQuery } from "../../../../packages/contracts/src/common.js";
import {
  ListThreadsQuery,
  Thread,
  UpdateThreadRequest,
  type ListThreadsResponse,
  type UpdateThreadResponse,
} from "../../../../packages/contracts/src/threads.js";
import { notFound, validate } from "./errors.js";
import { updateMessage } from "./messages.js";
import {
  BytesRow,
  attachmentRow,
  getInbox,
  getThreadItem,
  messageRow,
  threadLabels,
  threadRow,
} from "./rows.js";
import {
  Where,
  keysetWhere,
  normalizedMailQuery,
  page,
  preparePage,
  threadWhere,
} from "./queries.js";
import type { InboxScope, StoredAttachment } from "./types.js";

export function listThreads(
  db: Database.Database,
  scope: InboxScope,
  request: typeof ListThreadsQuery.Type,
): ListThreadsResponse {
  const query = validate(ListThreadsQuery, request);
  if (scope.inbox_id !== undefined) getInbox(db, scope.inbox_id);
  const { limit, expected, cursor } = preparePage(query, {
    resource: "threads",
    scope,
    ...normalizedMailQuery(query),
  });
  const where = threadWhere(scope, query);
  keysetWhere(where, cursor, "t.timestamp_key", "t.thread_id", query.ascending ?? false);
  const order = query.ascending ? "ASC" : "DESC";
  const rows = db
    .prepare(`
    SELECT t.*, t.timestamp_key AS cursor_key, t.thread_id AS cursor_id FROM threads t
    WHERE ${where.sql} ORDER BY t.timestamp_key ${order}, t.thread_id ${order} LIMIT ?
  `)
    .all(...where.params, limit + 1);
  const { items, ...fields } = page(rows, limit, expected, (row) => threadRow(db, row));
  return { ...fields, threads: items };
}

export function getThread(
  db: Database.Database,
  inboxId: string,
  threadId: string,
  request: typeof CursorQuery.Type,
) {
  const query = validate(CursorQuery, request);
  const thread = getThreadItem(db, inboxId, threadId);
  const { limit, expected, cursor } = preparePage(query, {
    resource: "thread-messages",
    inbox_id: inboxId,
    thread_id: threadId,
  });
  const where = new Where().add("m.inbox_id = ? AND m.thread_id = ?", inboxId, threadId);
  keysetWhere(where, cursor, "m.timestamp_key", "m.message_id", false);
  const rows = db
    .prepare(`
    SELECT m.*, m.timestamp_key AS cursor_key, m.message_id AS cursor_id FROM messages m
    WHERE ${where.sql} ORDER BY m.timestamp_key DESC, m.message_id DESC LIMIT ?
  `)
    .all(...where.params, limit + 1);
  const { items, ...fields } = page(rows, limit, expected, (row) => messageRow(db, row));
  return Schema.decodeUnknownSync(Thread)({ ...thread, ...fields, messages: items.toReversed() });
}

export function updateThread(
  db: Database.Database,
  inboxId: string,
  threadId: string,
  request: UpdateThreadRequest,
  now: string,
): UpdateThreadResponse {
  const input = validate(UpdateThreadRequest, request);
  getThreadItem(db, inboxId, threadId);
  const identities = db
    .prepare("SELECT message_id FROM messages WHERE inbox_id = ? AND thread_id = ?")
    .all(inboxId, threadId);
  for (const row of identities) {
    const { message_id: messageId } = Schema.decodeUnknownSync(
      Schema.Struct({ message_id: Schema.String }),
    )(row);
    updateMessage(db, inboxId, messageId, input, now);
  }
  return { thread_id: threadId, labels: threadLabels(db, inboxId, threadId) };
}

export function deleteThread(db: Database.Database, inboxId: string, threadId: string) {
  getThreadItem(db, inboxId, threadId);
  db.prepare("DELETE FROM threads WHERE inbox_id = ? AND thread_id = ?").run(inboxId, threadId);
}

export function getAttachment(
  db: Database.Database,
  inboxId: string,
  messageId: string,
  attachmentId: string,
): StoredAttachment {
  const row = db
    .prepare(`
    SELECT * FROM attachments WHERE inbox_id = ? AND message_id = ? AND attachment_id = ?
  `)
    .get(inboxId, messageId, attachmentId);
  if (row === undefined) throw notFound();
  return {
    attachment: attachmentRow(row),
    content: Schema.decodeUnknownSync(BytesRow)(row).content,
  };
}

export function getThreadAttachment(
  db: Database.Database,
  inboxId: string,
  threadId: string,
  attachmentId: string,
): StoredAttachment {
  const row = db
    .prepare(`
    SELECT a.* FROM attachments a JOIN messages m
      ON m.inbox_id = a.inbox_id AND m.message_id = a.message_id
    WHERE m.inbox_id = ? AND m.thread_id = ? AND a.attachment_id = ?
  `)
    .get(inboxId, threadId, attachmentId);
  if (row === undefined) throw notFound();
  return {
    attachment: attachmentRow(row),
    content: Schema.decodeUnknownSync(BytesRow)(row).content,
  };
}
