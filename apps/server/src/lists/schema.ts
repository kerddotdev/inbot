export const listsSchema = `
CREATE TABLE list_entries (
  scope TEXT NOT NULL,
  inbox_id TEXT REFERENCES inboxes(inbox_id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('send', 'receive', 'reply')),
  list_type TEXT NOT NULL CHECK (list_type IN ('allow', 'block')),
  entry TEXT NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('email', 'domain')),
  reason TEXT,
  created_at TEXT NOT NULL,
  CHECK (scope = coalesce(inbox_id, '')),
  PRIMARY KEY (scope, direction, list_type, entry)
);
CREATE TABLE inbound_list_rejections (
  inbox_id TEXT NOT NULL REFERENCES inboxes(inbox_id) ON DELETE CASCADE,
  payload_hash TEXT NOT NULL,
  reason_code TEXT NOT NULL CHECK (reason_code IN ('blocked_sender', 'sender_not_allowed')),
  received_at TEXT NOT NULL,
  PRIMARY KEY (inbox_id, payload_hash)
);
`;
