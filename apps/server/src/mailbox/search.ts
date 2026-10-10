import type Database from "better-sqlite3-multiple-ciphers";
import { Schema } from "effect";
import { SearchInboxesQuery, SearchMailQuery } from "../../../../packages/contracts/src/common.js";
import {
  SearchMessageHighlights,
  type SearchMessagesResponse,
} from "../../../../packages/contracts/src/messages.js";
import type { SearchThreadsResponse } from "../../../../packages/contracts/src/threads.js";
import type { SearchInboxesResponse } from "../../../../packages/contracts/src/inboxes.js";
import { getInbox, inboxRow, itemColumns, messageItemRow, threadRow } from "./rows.js";
import { validate, validationError } from "./errors.js";
import {
  Where,
  labelWhere,
  page,
  preparePage,
  rankedWhere,
  scopeWhere,
  searchRevision,
  timeWhere,
  inboxScopeWhere,
} from "./queries.js";
import { timestampKey } from "./pagination.js";
import type { InboxScope } from "./types.js";

export function searchTerms(q: string, prefix = false) {
  const terms = q.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return terms.map((term) => `"${term.replaceAll('"', '""')}"${prefix ? "*" : ""}`).join(" AND ");
}

const HighlightRow = Schema.Struct({
  highlight_from: Schema.String,
  highlight_recipients: Schema.String,
  highlight_subject: Schema.String,
  highlight_text: Schema.String,
});

function highlights(value: unknown) {
  const row = Schema.decodeUnknownSync(HighlightRow)(value);
  return Schema.decodeUnknownSync(SearchMessageHighlights)(
    Object.fromEntries(
      Object.entries(row)
        .filter(([, text]) => text.includes("\u0001"))
        .map(([key, text]) => [
          key.replace("highlight_", ""),
          [text.replaceAll("\u0001", "**").replaceAll("\u0002", "**")],
        ]),
    ),
  );
}

const highlightColumns = `
  coalesce(snippet(message_search, 1, char(1), char(2), '...', 32), '') AS highlight_from,
  coalesce(snippet(message_search, 2, char(1), char(2), '...', 32), '') AS highlight_recipients,
  coalesce(snippet(message_search, 0, char(1), char(2), '...', 32), '') AS highlight_subject,
  coalesce(snippet(message_search, 3, char(1), char(2), '...', 32), '') AS highlight_text`;

function mailSearchPage(
  db: Database.Database,
  query: typeof SearchMailQuery.Type,
  resource: string,
  scope: InboxScope,
) {
  return preparePage(query, {
    resource,
    scope,
    q: searchTerms(query.q),
    before: query.before === undefined ? undefined : timestampKey(query.before),
    after: query.after === undefined ? undefined : timestampKey(query.after),
    revision: searchRevision(db),
  });
}

export function searchMessages(
  db: Database.Database,
  inboxId: string,
  q: string,
  request: Omit<typeof SearchMailQuery.Type, "q">,
): SearchMessagesResponse {
  const query = validate(SearchMailQuery, { ...request, q });
  getInbox(db, inboxId);
  const { limit, expected, cursor } = mailSearchPage(db, query, "search-messages", {
    inbox_id: inboxId,
  });
  const match = searchTerms(q);
  const where = new Where().add("message_search MATCH ?", match).add("m.inbox_id = ?", inboxId);
  labelWhere(where, {}, "m");
  timeWhere(where, query, "m.timestamp_key");
  const cursorWhere = new Where();
  rankedWhere(cursorWhere, cursor);
  const rows =
    match === ""
      ? []
      : db
          .prepare(`
    WITH matched AS MATERIALIZED (
      SELECT ${itemColumns}, bm25(message_search) AS score, ${highlightColumns}, m.message_id AS cursor_id
      FROM message_search JOIN messages m ON m.rowid = message_search.rowid WHERE ${where.sql}
    )
    SELECT *, score AS cursor_key FROM matched WHERE ${cursorWhere.sql}
    ORDER BY score, cursor_id LIMIT ?
  `)
          .all(...where.params, ...cursorWhere.params, limit + 1);
  const { items, ...fields } = page(rows, limit, expected, (row) => ({
    ...messageItemRow(db, row),
    highlights: highlights(row),
  }));
  return { ...fields, messages: items };
}

export function searchThreads(
  db: Database.Database,
  scope: InboxScope,
  q: string,
  request: Omit<typeof SearchMailQuery.Type, "q">,
): SearchThreadsResponse {
  const query = validate(SearchMailQuery, { ...request, q });
  if (scope.inbox_id !== undefined) getInbox(db, scope.inbox_id);
  const { limit, expected, cursor } = mailSearchPage(db, query, "search-threads", scope);
  const match = searchTerms(q);
  const where = new Where().add("message_search MATCH ?", match);
  scopeWhere(where, scope, "m");
  const threadFilters = new Where().add("ranked.position = 1");
  labelWhere(threadFilters, {}, "t");
  timeWhere(threadFilters, query, "t.timestamp_key");
  const cursorWhere = new Where();
  rankedWhere(cursorWhere, cursor);
  const rows =
    match === ""
      ? []
      : db
          .prepare(`
    WITH matched AS MATERIALIZED (
      SELECT m.inbox_id, m.thread_id, m.message_id, bm25(message_search) AS score, ${highlightColumns}
      FROM message_search JOIN messages m ON m.rowid = message_search.rowid WHERE ${where.sql}
    ), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY thread_id ORDER BY score, message_id) AS position FROM matched
    ), results AS (
      SELECT t.*, ranked.score, ranked.highlight_from, ranked.highlight_recipients,
        ranked.highlight_subject, ranked.highlight_text, t.thread_id AS cursor_id
      FROM ranked JOIN threads t ON t.thread_id = ranked.thread_id AND t.inbox_id = ranked.inbox_id
      WHERE ${threadFilters.sql}
    )
    SELECT *, score AS cursor_key FROM results WHERE ${cursorWhere.sql}
    ORDER BY score, cursor_id LIMIT ?
  `)
          .all(...where.params, ...threadFilters.params, ...cursorWhere.params, limit + 1);
  const { items, ...fields } = page(rows, limit, expected, (row) => ({
    ...threadRow(db, row),
    highlights: highlights(row),
  }));
  return { ...fields, threads: items };
}

export function searchInboxes(
  db: Database.Database,
  q: string,
  request: Omit<typeof SearchInboxesQuery.Type, "q">,
  inboxIds?: readonly string[],
): SearchInboxesResponse {
  const query = validate(SearchInboxesQuery, { ...request, q });
  if (q.length < 2 || q.length > 256)
    throw validationError("Inbox search requires 2 to 256 characters.");
  const match = searchTerms(q, true);
  const { limit, expected, cursor } = preparePage(query, {
    resource: "search-inboxes",
    q: match,
    revision: searchRevision(db),
    inbox_ids: inboxIds,
  });
  const where = new Where();
  rankedWhere(where, cursor);
  const scope = new Where();
  inboxScopeWhere(scope, inboxIds);
  const rows =
    match === ""
      ? []
      : db
          .prepare(`
    WITH matched AS MATERIALIZED (
      SELECT i.*, i.inbox_id AS email, i.inbox_id AS cursor_id, bm25(inbox_search) AS score
      FROM inbox_search JOIN inboxes i ON i.rowid = inbox_search.rowid WHERE inbox_search MATCH ? AND ${scope.sql}
    )
    SELECT *, score AS cursor_key FROM matched WHERE ${where.sql}
    ORDER BY score, cursor_id LIMIT ?
  `)
          .all(match, ...scope.params, ...where.params, limit + 1);
  const { items, ...fields } = page(rows, limit, expected, inboxRow);
  return { ...fields, inboxes: items };
}
