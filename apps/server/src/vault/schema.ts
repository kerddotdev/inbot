export const vaultSchema = `
CREATE TABLE IF NOT EXISTS credentials (
  credential_id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL REFERENCES inboxes(inbox_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT,
  origins TEXT NOT NULL,
  username TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS credentials_inbox_page ON credentials (inbox_id, created_at, credential_id);
CREATE TABLE IF NOT EXISTS credential_fields (
  credential_id TEXT NOT NULL REFERENCES credentials(credential_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (credential_id, name)
);
`;
