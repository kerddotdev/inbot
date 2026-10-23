import type Database from "better-sqlite3-multiple-ciphers";
import { Schema } from "effect";

export function migrateUsePolicy(database: Database.Database) {
  const columns = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String })))(
    database.pragma("table_info(api_keys)"),
  );
  if (!columns.some((column) => column.name === "use_policy"))
    database.exec(
      "ALTER TABLE api_keys ADD COLUMN use_policy TEXT NOT NULL DEFAULT 'approval' CHECK (use_policy IN ('direct', 'approval'))",
    );
}

export const credentialUseSchema = `
CREATE TABLE IF NOT EXISTS credential_use_requests (
  request_id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  inbox_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fill', 'run')),
  credential_ids TEXT NOT NULL,
  fields TEXT NOT NULL,
  origin TEXT,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'consumed')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  UNIQUE (api_key_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS credential_use_requests_page
  ON credential_use_requests (created_at, request_id);
`;

export function migrateTrustedBrowsers(database: Database.Database) {
  const columns = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String })))(
    database.pragma("table_info(vault_settings)"),
  );
  if (!columns.some((column) => column.name === "cdp_endpoints"))
    database.exec("ALTER TABLE vault_settings ADD COLUMN cdp_endpoints TEXT NOT NULL DEFAULT '[]'");
  const useColumns = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String })))(
    database.pragma("table_info(credential_use_requests)"),
  );
  if (useColumns.some((column) => column.name === "browser")) return;
  const indexes = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ sql: Schema.String })))(
    database
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'credential_use_requests' AND sql IS NOT NULL",
      )
      .all(),
  );
  database.exec(`
    CREATE TABLE credential_use_requests_v20 (
      request_id TEXT PRIMARY KEY,
      api_key_id TEXT NOT NULL,
      inbox_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('fill', 'capture', 'run')),
      credential_ids TEXT NOT NULL,
      fields TEXT NOT NULL,
      origin TEXT,
      browser TEXT,
      idempotency_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'consumed')),
      created_at TEXT NOT NULL,
      decided_at TEXT,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      UNIQUE (api_key_id, idempotency_key)
    );
    INSERT INTO credential_use_requests_v20
      (request_id, api_key_id, inbox_id, kind, credential_ids, fields, origin,
       idempotency_key, fingerprint, state, created_at, decided_at, expires_at, consumed_at)
      SELECT request_id, api_key_id, inbox_id, kind, credential_ids, fields, origin,
       idempotency_key, fingerprint, state, created_at, decided_at, expires_at, consumed_at
      FROM credential_use_requests;
    DROP TABLE credential_use_requests;
    ALTER TABLE credential_use_requests_v20 RENAME TO credential_use_requests;
  `);
  for (const index of indexes) database.exec(index.sql);
}
