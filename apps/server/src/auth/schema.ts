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

export const ownerSessionsSchema = `
CREATE TABLE owner_account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE owner_sessions (
  id TEXT PRIMARY KEY,
  token_hash BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
);
`;
