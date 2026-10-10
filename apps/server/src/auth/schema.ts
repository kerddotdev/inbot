export const apiKeysSchema = `
CREATE TABLE api_keys (
  api_key_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  secret_hash BLOB NOT NULL CHECK (length(secret_hash) = 32),
  inbox_id TEXT,
  inbox_ids TEXT,
  permissions TEXT NOT NULL,
  send_policy TEXT NOT NULL CHECK (send_policy IN ('direct', 'approval', 'read_only')),
  expires_at TEXT,
  used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
