export const inboundSchema = `
CREATE TABLE inbound_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  identity TEXT NOT NULL
);
CREATE TABLE inbound_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  account_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  inbound_queue_id TEXT NOT NULL,
  events_queue_id TEXT NOT NULL
);
CREATE TABLE inbound_objects (
  account_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'committed', 'quarantined')),
  reason_code TEXT,
  first_seen TEXT NOT NULL,
  pending_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, bucket, key)
);
CREATE TABLE buffer_quarantine (
  account_id TEXT NOT NULL,
  queue_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  PRIMARY KEY (account_id, queue_id, message_id)
);
`;
