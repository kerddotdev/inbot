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
