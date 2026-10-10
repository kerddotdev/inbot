import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { Clock, Context, Effect, Layer, Result, Schema } from "effect";
import {
  ApiKey,
  CreateApiKeyRequest,
  Permissions,
  UpdateApiKeyRequest,
  type CreateApiKeyResponse,
  type ListApiKeysResponse,
} from "../../../../packages/contracts/src/api-keys.js";
import { PaginationQuery } from "../../../../packages/contracts/src/common.js";
import type { Principal } from "../../../../packages/contracts/src/security.js";
import { Store, type StoreService } from "../store.js";
import { MailboxError, notFound, validationError } from "../mailbox/errors.js";
import { keysetWhere, page, preparePage, Where } from "../mailbox/queries.js";

const Row = Schema.Struct({
  ...ApiKey.fields,
  inbox_id: Schema.NullOr(Schema.String),
  inbox_ids: Schema.NullOr(Schema.fromJsonString(Schema.Array(Schema.String))),
  permissions: Schema.fromJsonString(Permissions),
  expires_at: Schema.NullOr(Schema.String),
  used_at: Schema.NullOr(Schema.String),
});

function keyRow(value: unknown): ApiKey {
  const row = Schema.decodeUnknownSync(Row)(value);
  return Schema.decodeUnknownSync(ApiKey)(
    Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)),
  );
}

function getKey(db: Database.Database, id: string, inboxId?: string) {
  const row = db.prepare("SELECT * FROM api_keys WHERE api_key_id = ?").get(id);
  if (row === undefined) throw notFound();
  const key = keyRow(row);
  if (inboxId !== undefined && key.inbox_id !== inboxId) throw notFound();
  return key;
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest();
}

function decode<S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  value: unknown,
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  } catch {
    throw validationError("The API key request contains invalid or unsupported fields.");
  }
}

function makeApiKeys(store: StoreService) {
  function run<A>(operation: (db: Database.Database, now: number) => A) {
    return Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const result = yield* store.use((db): Result.Result<A, MailboxError> => {
        try {
          return Result.succeed(db.transaction(() => operation(db, now)).immediate());
        } catch (error) {
          if (error instanceof MailboxError) return Result.fail(error);
          throw error;
        }
      });
      return yield* Effect.fromResult(result);
    });
  }

  return {
    create: (request: CreateApiKeyRequest, inboxId?: string) =>
      run((db, now): CreateApiKeyResponse => {
        const input = decode(CreateApiKeyRequest, request);
        if (inboxId !== undefined && input.inbox_id !== undefined && input.inbox_id !== inboxId)
          throw validationError("The key inbox scope must match the inbox in the route.");
        const id = randomBytes(16).toString("hex");
        const token = `inbot_${id}_${randomBytes(32).toString("base64url")}`;
        const timestamp = new Date(now).toISOString();
        db.prepare(`
          INSERT INTO api_keys (api_key_id, name, prefix, secret_hash, inbox_id, inbox_ids,
            permissions, send_policy, expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          input.name ?? "",
          token.slice(0, 16),
          hashToken(token),
          inboxId ?? input.inbox_id ?? null,
          input.inbox_ids === undefined ? null : JSON.stringify(input.inbox_ids),
          JSON.stringify(input.permissions),
          input.send_policy,
          input.expires_at ?? null,
          timestamp,
          timestamp,
        );
        return { ...getKey(db, id), api_key: token };
      }),
    list: (request: typeof PaginationQuery.Type = {}, inboxId?: string) =>
      run((db): ListApiKeysResponse => {
        const query = decode(PaginationQuery, request);
        const { limit, expected, cursor } = preparePage(query, {
          resource: "api-keys",
          inbox_id: inboxId,
          ascending: query.ascending ?? false,
        });
        const where = new Where();
        if (inboxId !== undefined) where.add("inbox_id = ?", inboxId);
        keysetWhere(where, cursor, "created_at", "api_key_id", query.ascending ?? false);
        const order = query.ascending ? "ASC" : "DESC";
        const rows = db
          .prepare(`
          SELECT *, created_at AS cursor_key, api_key_id AS cursor_id FROM api_keys
          WHERE ${where.sql} ORDER BY created_at ${order}, api_key_id ${order} LIMIT ?
        `)
          .all(...where.params, limit + 1);
        const { items, ...fields } = page(rows, limit, expected, keyRow);
        return { ...fields, api_keys: items };
      }),
    get: (id: string, inboxId?: string) => run((db) => getKey(db, id, inboxId)),
    update: (id: string, request: UpdateApiKeyRequest, inboxId?: string) =>
      run((db, now) => {
        const input = decode(UpdateApiKeyRequest, request);
        const key = getKey(db, id, inboxId);
        db.prepare(`
          UPDATE api_keys SET name = ?, permissions = ?, send_policy = ?, updated_at = ?
          WHERE api_key_id = ?
        `).run(
          input.name ?? key.name,
          JSON.stringify(input.permissions ?? key.permissions),
          input.send_policy ?? key.send_policy,
          new Date(now).toISOString(),
          id,
        );
        return getKey(db, id, inboxId);
      }),
    delete: (id: string, inboxId?: string) =>
      run((db) => {
        getKey(db, id, inboxId);
        db.prepare("DELETE FROM api_keys WHERE api_key_id = ?").run(id);
      }),
    authenticate: (bearer: string) =>
      run((db, now): Principal | undefined => {
        const match = /^inbot_([0-9a-f]{32})_[A-Za-z0-9_-]{43}$/.exec(bearer);
        if (!match) return undefined;
        const row = db.prepare("SELECT * FROM api_keys WHERE api_key_id = ?").get(match[1]);
        const expected =
          row === undefined
            ? Buffer.alloc(32)
            : Schema.decodeUnknownSync(Schema.Struct({ secret_hash: Schema.Uint8Array }))(row)
                .secret_hash;
        if (!timingSafeEqual(hashToken(bearer), expected) || row === undefined) return undefined;
        const key = keyRow(row);
        if (key.expires_at !== undefined && Date.parse(key.expires_at) <= now) return undefined;
        if (key.used_at === undefined || now - Date.parse(key.used_at) >= 60_000)
          db.prepare("UPDATE api_keys SET used_at = ? WHERE api_key_id = ?").run(
            new Date(now).toISOString(),
            key.api_key_id,
          );
        return {
          kind: "agent",
          api_key_id: key.api_key_id,
          grant: {
            ...(key.inbox_id === undefined ? {} : { inbox_id: key.inbox_id }),
            ...(key.inbox_ids === undefined ? {} : { inbox_ids: key.inbox_ids }),
            permissions: key.permissions,
            send_policy: key.send_policy,
          },
        };
      }),
  };
}

export type ApiKeysService = ReturnType<typeof makeApiKeys>;

export class ApiKeys extends Context.Service<ApiKeys, ApiKeysService>()("inbot/ApiKeys") {
  static readonly Live = Layer.effect(ApiKeys, Effect.map(Store, makeApiKeys));
}
