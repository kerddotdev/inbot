export const outboxSchema = `
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL,
  idempotency_key TEXT,
  fingerprint TEXT NOT NULL,
  provider_message TEXT NOT NULL CHECK (json_valid(provider_message)),
  state TEXT NOT NULL CHECK (state IN ('queued', 'sending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL,
  last_error_code TEXT,
  provider_message_id TEXT,
  message_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (inbox_id, message_id) REFERENCES messages(inbox_id, message_id) ON DELETE CASCADE,
  UNIQUE (inbox_id, idempotency_key)
);
CREATE INDEX outbox_due ON outbox(state, next_attempt_at);
CREATE INDEX outbox_lease ON outbox(state, updated_at);
CREATE INDEX outbox_provider ON outbox(provider_message_id);

CREATE TABLE outbound_idempotency (
  inbox_id TEXT NOT NULL REFERENCES inboxes(inbox_id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  message_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (inbox_id, idempotency_key)
);
CREATE INDEX outbound_idempotency_message ON outbound_idempotency(inbox_id, message_id);

CREATE TABLE delivery_events (
  inbox_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL,
  recipient TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  PRIMARY KEY (inbox_id, event_id),
  FOREIGN KEY (inbox_id, message_id) REFERENCES messages(inbox_id, message_id) ON DELETE CASCADE
);
`;
