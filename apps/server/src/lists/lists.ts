import type Database from "better-sqlite3-multiple-ciphers";
import { Clock, Context, Effect, Layer, Result, Schema } from "effect";
import { CursorQuery } from "../../../../packages/contracts/src/common.js";
import {
  CreateListEntryRequest,
  InboundListRejection,
  ListRejectionsQuery,
  RejectionRule,
  Direction,
  ListType,
  PodListEntry,
} from "../../../../packages/contracts/src/lists.js";
import {
  MailboxError,
  alreadyExists,
  notFound,
  validate,
  validationError,
} from "../mailbox/errors.js";
import { Where, keysetWhere, page, preparePage } from "../mailbox/queries.js";
import { getInbox } from "../mailbox/rows.js";
import { Store, type StoreService } from "../store.js";
import { normalizeEntry } from "./policy.js";

const Row = Schema.Struct({
  ...PodListEntry.fields,
  reason: Schema.NullOr(Schema.String),
  inbox_id: Schema.NullOr(Schema.String),
});
function read(row: unknown) {
  const { reason, inbox_id, ...entry } = Schema.decodeUnknownSync(Row)(row);
  return {
    ...entry,
    ...(reason === null ? {} : { reason }),
    ...(inbox_id === null ? {} : { inbox_id }),
  };
}
const columns = "*, 'local' AS organization_id, 'local' AS pod_id";

export function makeLists(store: StoreService) {
  function run<A>(operation: (db: Database.Database, now: string) => A, write = false) {
    return Effect.gen(function* () {
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      const result = yield* store.use((db): Result.Result<A, MailboxError> => {
        try {
          const transaction = db.transaction(() => operation(db, now));
          return Result.succeed(write ? transaction.immediate() : transaction.deferred());
        } catch (error) {
          if (error instanceof MailboxError) return Result.fail(error);
          throw error;
        }
      });
      return yield* Effect.fromResult(result);
    });
  }
  function scope(
    db: Database.Database,
    inboxId: string | undefined,
    direction: Direction,
    type: ListType,
  ) {
    validate(Direction, direction);
    validate(ListType, type);
    if (inboxId !== undefined) getInbox(db, inboxId);
    return new Where().add(
      "scope = ? AND direction = ? AND list_type = ?",
      inboxId ?? "",
      direction,
      type,
    );
  }
  function get(
    db: Database.Database,
    inboxId: string | undefined,
    direction: Direction,
    type: ListType,
    entry: string,
  ) {
    const where = scope(db, inboxId, direction, type).add("entry = ?", normalizeEntry(entry).entry);
    const row = db
      .prepare(`SELECT ${columns} FROM list_entries WHERE ${where.sql}`)
      .get(...where.params);
    if (row === undefined) throw notFound();
    return read(row);
  }
  const rejectionRow = Schema.Struct({
    ...InboundListRejection.fields,
    rules: Schema.fromJsonString(Schema.Array(RejectionRule)),
  });
  return {
    rejections: (request: ListRejectionsQuery = {}) =>
      run((db) => {
        const query = validate(ListRejectionsQuery, request);
        const where = new Where();
        if (query.inbox_id !== undefined) {
          getInbox(db, query.inbox_id);
          where.add("inbox_id = ?", query.inbox_id);
        }
        const { limit, expected, cursor } = preparePage(query, {
          resource: "list_rejections",
          inboxId: query.inbox_id,
        });
        keysetWhere(where, cursor, "received_at", "rejection_id", false);
        const rows = db
          .prepare(
            `SELECT *, received_at AS cursor_key, rejection_id AS cursor_id FROM inbound_list_rejections WHERE ${where.sql} ORDER BY received_at DESC, rejection_id DESC LIMIT ?`,
          )
          .all(...where.params, limit + 1);
        const { items, ...fields } = page(
          rows,
          limit,
          expected,
          Schema.decodeUnknownSync(rejectionRow),
        );
        return { ...fields, rejections: items };
      }),
    deleteRejection: (id: string) =>
      run((db) => {
        const existing = db
          .prepare("SELECT 1 FROM inbound_list_rejections WHERE rejection_id = ?")
          .get(id);
        if (existing === undefined) throw notFound();
        db.prepare(
          "INSERT INTO inbound_list_rejection_receipts (inbox_id, payload_hash, reason_code) SELECT inbox_id, payload_hash, reason_code FROM inbound_list_rejections WHERE rejection_id = ?",
        ).run(id);
        db.prepare("DELETE FROM inbound_list_rejections WHERE rejection_id = ?").run(id);
      }, true),
    list: (
      inboxId: string | undefined,
      direction: Direction,
      type: ListType,
      request: typeof CursorQuery.Type = {},
    ) =>
      run((db) => {
        const query = validate(CursorQuery, request);
        const where = scope(db, inboxId, direction, type);
        const { limit, expected, cursor } = preparePage(query, {
          resource: "lists",
          inboxId,
          direction,
          type,
        });
        keysetWhere(where, cursor, "entry", "entry", true);
        const rows = db
          .prepare(
            `SELECT ${columns}, entry AS cursor_key, entry AS cursor_id FROM list_entries WHERE ${where.sql} ORDER BY entry ASC LIMIT ?`,
          )
          .all(...where.params, limit + 1);
        const { items, ...fields } = page(rows, limit, expected, read);
        return { ...fields, entries: items };
      }),
    get: (inboxId: string | undefined, direction: Direction, type: ListType, entry: string) =>
      run((db) => get(db, inboxId, direction, type, entry)),
    create: (
      inboxId: string | undefined,
      direction: Direction,
      type: ListType,
      request: CreateListEntryRequest,
    ) =>
      run((db, now) => {
        const input = validate(CreateListEntryRequest, request);
        const where = scope(db, inboxId, direction, type);
        const entry = normalizeEntry(input.entry);
        if (input.reason !== undefined && (input.reason.length > 2048 || /[\0]/.test(input.reason)))
          throw validationError("The reason must be at most 2048 characters without null bytes.");
        if (
          db
            .prepare(`SELECT 1 FROM list_entries WHERE ${where.sql} AND entry = ?`)
            .get(...where.params, entry.entry) !== undefined
        )
          throw alreadyExists();
        db.prepare(
          "INSERT INTO list_entries (scope, inbox_id, direction, list_type, entry, entry_type, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          inboxId ?? "",
          inboxId ?? null,
          direction,
          type,
          entry.entry,
          entry.entry_type,
          input.reason ?? null,
          now,
        );
        return get(db, inboxId, direction, type, entry.entry);
      }, true),
    delete: (inboxId: string | undefined, direction: Direction, type: ListType, entry: string) =>
      run((db) => {
        const current = get(db, inboxId, direction, type, entry);
        db.prepare(
          "DELETE FROM list_entries WHERE scope = ? AND direction = ? AND list_type = ? AND entry = ?",
        ).run(inboxId ?? "", direction, type, current.entry);
      }, true),
  };
}

export class Lists extends Context.Service<Lists, ReturnType<typeof makeLists>>()("inbot/Lists") {
  static readonly Live = Layer.effect(Lists, Effect.map(Store, makeLists));
}
