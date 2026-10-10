import { randomBytes } from "node:crypto";
import { domainToASCII } from "node:url";
import type Database from "better-sqlite3-multiple-ciphers";
import { PaginationQuery } from "../../../../packages/contracts/src/common.js";
import {
  CreateInboxRequest,
  Metadata,
  UpdateInboxRequest,
  type ListInboxesResponse,
} from "../../../../packages/contracts/src/inboxes.js";
import { alreadyExists, notFound, validate, validationError } from "./errors.js";
import { getInbox, inboxRow } from "./rows.js";
import { Where, inboxScopeWhere, keysetWhere, page, preparePage } from "./queries.js";

export type CreateInbox = CreateInboxRequest & { readonly domain: string };

export function createInbox(
  db: Database.Database,
  request: CreateInbox,
  now: string,
  inboxIds?: readonly string[],
) {
  const input = validate(CreateInboxRequest, request);
  if (input.client_id !== undefined) {
    if (!input.client_id || input.client_id.includes("@"))
      throw validationError("The client_id must be non-empty and cannot contain @.");
    const existing = db
      .prepare("SELECT *, inbox_id AS email FROM inboxes WHERE client_id = ?")
      .get(input.client_id);
    if (existing !== undefined) {
      const inbox = inboxRow(existing);
      if (inboxIds !== undefined && !inboxIds.includes(inbox.inbox_id)) throw notFound();
      return inbox;
    }
  }
  const username = (input.username ?? randomBytes(8).toString("hex")).toLowerCase();
  if (
    username.length > 64 ||
    !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(username) ||
    username.startsWith(".") ||
    username.endsWith(".") ||
    username.includes("..")
  ) {
    throw validationError(
      "The username must be a valid unquoted email local part of at most 64 characters.",
    );
  }
  const domain = domainToASCII(input.domain ?? "").toLowerCase();
  if (
    !domain ||
    domain.length > 253 ||
    !domain
      .split(".")
      .every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  ) {
    throw validationError("A valid mailbox domain is required.");
  }
  const inboxId = `${username}@${domain}`;
  if (inboxIds !== undefined && !inboxIds.includes(inboxId)) throw notFound();
  if (db.prepare("SELECT 1 FROM inboxes WHERE inbox_id = ?").get(inboxId) !== undefined)
    throw alreadyExists();
  db.prepare(`
    INSERT INTO inboxes (inbox_id, display_name, client_id, status, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    inboxId,
    input.display_name ?? null,
    input.client_id ?? null,
    input.status ?? "active",
    JSON.stringify(input.metadata ?? {}),
    now,
    now,
  );
  return getInbox(db, inboxId);
}

export function updateInbox(
  db: Database.Database,
  inboxId: string,
  request: UpdateInboxRequest,
  now: string,
) {
  const input = validate(UpdateInboxRequest, request);
  const inbox = getInbox(db, inboxId);
  const metadata = new Map(Object.entries(inbox.metadata ?? {}));
  if (input.metadata === null) metadata.clear();
  else
    for (const [key, value] of Object.entries(input.metadata ?? {})) {
      if (value === null) metadata.delete(key);
      else metadata.set(key, value);
    }
  const merged = validate(Metadata, Object.fromEntries(metadata));
  db.prepare(`
    UPDATE inboxes SET display_name = ?, status = ?, metadata = ?, updated_at = ? WHERE inbox_id = ?
  `).run(
    input.display_name ?? inbox.display_name ?? null,
    input.status ?? inbox.status,
    JSON.stringify(merged),
    now,
    inboxId,
  );
  return getInbox(db, inboxId);
}

export function listInboxes(
  db: Database.Database,
  request: typeof PaginationQuery.Type,
  inboxIds?: readonly string[],
): ListInboxesResponse {
  const query = validate(PaginationQuery, request);
  const { limit, expected, cursor } = preparePage(query, {
    resource: "inboxes",
    ascending: query.ascending ?? false,
    inbox_ids: inboxIds,
  });
  const where = new Where();
  inboxScopeWhere(where, inboxIds);
  keysetWhere(where, cursor, "i.created_at", "i.inbox_id", query.ascending ?? false);
  const order = query.ascending ? "ASC" : "DESC";
  const rows = db
    .prepare(`
    SELECT i.*, i.inbox_id AS email, i.created_at AS cursor_key, i.inbox_id AS cursor_id
    FROM inboxes i WHERE ${where.sql} ORDER BY i.created_at ${order}, i.inbox_id ${order} LIMIT ?
  `)
    .all(...where.params, limit + 1);
  const { items, ...fields } = page(rows, limit, expected, inboxRow);
  return { ...fields, inboxes: items };
}
