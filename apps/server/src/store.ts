import { chmodSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { Context, Effect, Layer, Schema } from "effect";
import { eventsSchema } from "./events/schema.js";
import { draftsSchema } from "./drafts/schema.js";
import { inboundSchema } from "./inbound/schema.js";
import { Home } from "./home.js";
import { apiKeysSchema, ownerSessionsSchema } from "./auth/schema.js";
import { mailboxSchema } from "./mailbox/schema.js";
import { outboxSchema, transportConfigSchema } from "./outbound/schema.js";
import { provisionSchema } from "./provision/schema.js";
import { listsSchema } from "./lists/schema.js";

export class DatabaseKeyInvalid extends Schema.TaggedError<DatabaseKeyInvalid>()(
  "DatabaseKeyInvalid",
  {},
) {
  readonly code = "database_key_invalid";
  readonly fix =
    "Unlock this home with its original keys. Restore a backup if the database is damaged.";
}

export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  operation: Schema.String,
}) {
  readonly code = "database_failed";
  readonly fix = "Check the database permissions, available disk space, and schema version.";
}

export interface Migration {
  readonly version: number;
  readonly sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  },
  { version: 2, sql: mailboxSchema },
  { version: 3, sql: apiKeysSchema },
  { version: 4, sql: outboxSchema },
  { version: 5, sql: transportConfigSchema },
  { version: 6, sql: inboundSchema },
  { version: 7, sql: draftsSchema },
  { version: 8, sql: ownerSessionsSchema },
  { version: 9, sql: provisionSchema },
  { version: 10, sql: listsSchema },
  { version: 11, sql: eventsSchema },
];

export function migrate(database: Database.Database, ordered: readonly Migration[] = migrations) {
  return Effect.try({
    try: () => {
      for (const [index, migration] of ordered.entries()) {
        if (migration.version !== index + 1) throw new DatabaseError({ operation: "migrate" });
      }
      database
        .transaction(() => {
          const version = Schema.decodeUnknownSync(
            Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          )(database.pragma("user_version", { simple: true }));
          if (version > ordered.length) throw new DatabaseError({ operation: "migrate" });
          for (const migration of ordered) {
            if (migration.version <= version) continue;
            database.exec(migration.sql);
            database.pragma(`user_version = ${migration.version}`);
          }
        })
        .immediate();
    },
    catch: () => new DatabaseError({ operation: "migrate" }),
  });
}

function openDatabase(path: string, dek: Uint8Array) {
  return Effect.try({
    try: () => {
      if (dek.byteLength !== 32) throw new DatabaseKeyInvalid({});
      const database = new Database(path);
      const key = Buffer.from(dek);
      try {
        database.pragma("cipher = 'chacha20'");
        database.pragma("legacy = 0");
        database.pragma("plaintext_header_size = 0");
        database.pragma(`key = "x'${key.toString("hex")}'"`);
        database.prepare("SELECT name FROM sqlite_master").all();
        database.pragma("journal_mode = WAL");
        database.pragma("foreign_keys = ON");
        database.pragma("temp_store = MEMORY");
        if (process.platform !== "win32") chmodSync(path, 0o600);
        return database;
      } catch (error) {
        database.close();
        throw error;
      } finally {
        key.fill(0);
      }
    },
    catch: (error) =>
      error instanceof DatabaseKeyInvalid ||
      (error instanceof Database.SqliteError &&
        (error.code === "SQLITE_NOTADB" || error.code === "SQLITE_CORRUPT"))
        ? new DatabaseKeyInvalid({})
        : new DatabaseError({ operation: "open" }),
  });
}

export interface StoreService {
  readonly use: <A>(
    operation: (database: Database.Database) => A,
  ) => Effect.Effect<A, DatabaseError>;
}

export class Store extends Context.Service<Store, StoreService>()("inbot/Store") {
  static layer(dek: Uint8Array) {
    return Layer.effect(
      Store,
      Effect.gen(function* () {
        const home = yield* Home;
        const database = yield* Effect.acquireRelease(
          openDatabase(join(home.path, "inbot.db"), dek),
          (connection) =>
            Effect.try({
              try: () => connection.close(),
              catch: () => new DatabaseError({ operation: "close" }),
            }).pipe(Effect.orDie),
        );
        yield* migrate(database);
        return Store.of({
          use: (operation) =>
            Effect.try({
              try: () => operation(database),
              catch: () => new DatabaseError({ operation: "query" }),
            }),
        });
      }),
    );
  }
}
