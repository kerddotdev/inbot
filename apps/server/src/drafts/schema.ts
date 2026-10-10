export const draftsSchema = `
CREATE TABLE drafts (
  draft_id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL REFERENCES inboxes(inbox_id) ON DELETE CASCADE,
  client_id TEXT,
  data TEXT NOT NULL,
  send_at REAL,
  send_status TEXT CHECK (send_status IN ('scheduled', 'sending', 'failed')),
  approval_state TEXT NOT NULL CHECK (approval_state IN ('pending', 'approved', 'rejected')),
  updated_at TEXT NOT NULL,
  UNIQUE (inbox_id, client_id)
);
CREATE INDEX drafts_due ON drafts (send_status, approval_state, send_at);
CREATE INDEX drafts_page ON drafts (updated_at, draft_id);
CREATE TABLE draft_send_replays (
  inbox_id TEXT NOT NULL REFERENCES inboxes(inbox_id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  message_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  PRIMARY KEY (inbox_id, idempotency_key)
);
CREATE TABLE approval_requests (
  inbox_id TEXT NOT NULL REFERENCES inboxes(inbox_id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  PRIMARY KEY (inbox_id, idempotency_key)
);
`;
