import type Database from "better-sqlite3-multiple-ciphers";
import { Schema } from "effect";
import {
  Timestamp,
  type CursorQuery,
  type MailQueryFields,
} from "../../../../packages/contracts/src/common.js";
import type { ListMessagesQuery } from "../../../../packages/contracts/src/messages.js";
import type { ListThreadsQuery } from "../../../../packages/contracts/src/threads.js";
import { staleToken, validate } from "./errors.js";
import {
  fingerprint,
  nextToken,
  pageLimit,
  readCursor,
  timestampKey,
  type Cursor,
} from "./pagination.js";
import { PageRow } from "./rows.js";
import type { InboxScope } from "./types.js";

export type SqlValue = string | number;
type MailQuery = Schema.Struct<typeof MailQueryFields>["Type"];

export class Where {
  readonly clauses: string[] = [];
  readonly params: SqlValue[] = [];

  add(sql: string, ...params: SqlValue[]) {
    this.clauses.push(sql);
    this.params.push(...params);
    return this;
  }

  get sql() {
    return this.clauses.length ? this.clauses.join(" AND ") : "1";
  }
}

export const hiddenLabels = ["spam", "blocked", "unauthenticated", "trash"] as const;

export function normalizedMailQuery<Q extends MailQuery>(query: Q) {
  return {
    ...query,
    ascending: query.ascending ?? false,
    labels: query.labels ?? [],
    before: query.before === undefined ? undefined : timestampKey(query.before),
    after: query.after === undefined ? undefined : timestampKey(query.after),
    include_spam: query.include_spam ?? false,
    include_blocked: query.include_blocked ?? false,
    include_unauthenticated: query.include_unauthenticated ?? false,
    include_trash: query.include_trash ?? false,
  };
}

export function scopeWhere(where: Where, scope: InboxScope, alias: "m" | "t") {
  if (scope.inbox_id !== undefined) where.add(`${alias}.inbox_id = ?`, scope.inbox_id);
  if (scope.inbox_ids !== undefined) {
    if (scope.inbox_ids.length === 0) where.add("0");
    else
      where.add(
        `${alias}.inbox_id IN (${scope.inbox_ids.map(() => "?").join(", ")})`,
        ...scope.inbox_ids,
      );
  }
}

export function timeWhere(
  where: Where,
  query: { readonly before?: string; readonly after?: string },
  column: string,
) {
  if (query.before !== undefined)
    where.add(`${column} < ?`, timestampKey(validate(Timestamp, query.before)));
  if (query.after !== undefined)
    where.add(`${column} > ?`, timestampKey(validate(Timestamp, query.after)));
}

export function labelWhere(where: Where, query: MailQuery, alias: "m" | "t") {
  const source =
    alias === "m"
      ? "message_labels l"
      : `messages lm JOIN message_labels l
    ON l.inbox_id = lm.inbox_id AND l.message_id = lm.message_id`;
  const match =
    alias === "m"
      ? "l.inbox_id = m.inbox_id AND l.message_id = m.message_id"
      : "lm.inbox_id = t.inbox_id AND lm.thread_id = t.thread_id";
  for (const label of query.labels ?? []) {
    where.add(`EXISTS (SELECT 1 FROM ${source} WHERE ${match} AND l.label = ?)`, label);
  }
  for (const label of hiddenLabels) {
    if (!query[`include_${label}`]) {
      where.add(`NOT EXISTS (SELECT 1 FROM ${source} WHERE ${match} AND l.label = ?)`, label);
    }
  }
}

function substringWhere(where: Where, column: string, values: readonly string[] | undefined) {
  for (const value of values ?? [])
    where.add(`mailbox_contains(coalesce(${column}, ''), ?)`, value);
}

function addressWhere(
  where: Where,
  columns: readonly string[],
  values: readonly string[] | undefined,
) {
  for (const value of values ?? []) {
    where.add(
      `(${columns
        .map(
          (column) =>
            `EXISTS (SELECT 1 FROM json_each(${column}) WHERE mailbox_contains(value, ?))`,
        )
        .join(" OR ")})`,
      ...columns.map(() => value),
    );
  }
}

export function messageWhere(inboxId: string, query: typeof ListMessagesQuery.Type) {
  const where = new Where().add("m.inbox_id = ?", inboxId);
  labelWhere(where, query, "m");
  timeWhere(where, query, "m.timestamp_key");
  substringWhere(where, 'm."from"', query.from);
  addressWhere(where, ['m."to"', "m.cc", "m.bcc"], query.to);
  substringWhere(where, "m.subject", query.subject);
  return where;
}

export function threadWhere(scope: InboxScope, query: typeof ListThreadsQuery.Type) {
  const where = new Where();
  scopeWhere(where, scope, "t");
  labelWhere(where, query, "t");
  timeWhere(where, query, "t.timestamp_key");
  addressWhere(where, ["t.senders"], query.senders);
  addressWhere(where, ["t.recipients"], query.recipients);
  substringWhere(where, "t.subject", query.subject);
  return where;
}

export function keysetWhere(
  where: Where,
  cursor: Cursor | undefined,
  key: string,
  id: string,
  ascending: boolean,
) {
  if (cursor) where.add(`(${key}, ${id}) ${ascending ? ">" : "<"} (?, ?)`, cursor.key, cursor.id);
}

export function rankedWhere(where: Where, cursor: Cursor | undefined) {
  if (!cursor) return;
  const score = Number(cursor.key);
  if (!Number.isFinite(score) || cursor.key.trim() === "") throw staleToken();
  where.add("(score, cursor_id) > (?, ?)", score, cursor.id);
}

export function page<A>(
  rows: readonly unknown[],
  limit: number,
  expected: string,
  decode: (row: unknown) => A,
) {
  const selected = rows.slice(0, limit);
  const last = selected.at(-1);
  const cursor = last === undefined ? undefined : Schema.decodeUnknownSync(PageRow)(last);
  return {
    count: selected.length,
    limit,
    ...(rows.length > limit && cursor
      ? {
          next_page_token: nextToken(expected, String(cursor.cursor_key), cursor.cursor_id),
        }
      : {}),
    items: selected.map(decode),
  };
}

export function preparePage(query: typeof CursorQuery.Type, filters: unknown) {
  const limit = pageLimit(query.limit);
  const expected = fingerprint(filters);
  return { limit, expected, cursor: readCursor(query.page_token, expected) };
}

export function searchRevision(db: Database.Database) {
  return Schema.decodeUnknownSync(Schema.Struct({ search_revision: Schema.Int }))(
    db.prepare("SELECT search_revision FROM mailbox_state WHERE id = 1").get(),
  ).search_revision;
}
