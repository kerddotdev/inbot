export const quarantineSchema = `
CREATE TABLE IF NOT EXISTS inbound_quarantine_metadata (
  account_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  key TEXT NOT NULL,
  size INTEGER,
  received_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  action TEXT CHECK (action IN ('retry', 'delete')),
  PRIMARY KEY (account_id, bucket, key)
);
`;
