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

export const rejectionMetadataSchema = `
CREATE TABLE inbound_list_rejections_v14 (
  rejection_id TEXT NOT NULL UNIQUE,
  inbox_id TEXT NOT NULL REFERENCES inboxes(inbox_id) ON DELETE CASCADE,
  payload_hash TEXT NOT NULL,
  reason_code TEXT NOT NULL CHECK (reason_code IN ('blocked_sender', 'sender_not_allowed')),
  received_at TEXT NOT NULL,
  sender_address TEXT,
  rules TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (inbox_id, payload_hash)
);
INSERT INTO inbound_list_rejections_v14
  (rejection_id, inbox_id, payload_hash, reason_code, received_at)
  SELECT lower(hex(randomblob(16))), inbox_id, payload_hash, reason_code, received_at
  FROM inbound_list_rejections;
DROP TABLE inbound_list_rejections;
ALTER TABLE inbound_list_rejections_v14 RENAME TO inbound_list_rejections;
CREATE INDEX inbound_rejections_page ON inbound_list_rejections(received_at DESC, rejection_id DESC);
CREATE INDEX inbound_rejections_inbox_page ON inbound_list_rejections(inbox_id, received_at DESC, rejection_id DESC);
CREATE TABLE inbound_list_rejection_receipts (
  inbox_id TEXT NOT NULL REFERENCES inboxes(inbox_id) ON DELETE CASCADE,
  payload_hash TEXT NOT NULL,
  reason_code TEXT NOT NULL CHECK (reason_code IN ('blocked_sender', 'sender_not_allowed')),
  PRIMARY KEY (inbox_id, payload_hash)
);
`;
