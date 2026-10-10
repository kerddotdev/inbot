export const eventsSchema = `
CREATE TABLE event_log (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  inbox_id TEXT,
  event_type TEXT NOT NULL,
  labels TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  invalid INTEGER NOT NULL DEFAULT 0 CHECK (invalid IN (0, 1))
);
CREATE INDEX event_log_scope ON event_log (inbox_id, sequence);
CREATE INDEX event_log_retention ON event_log (created_at);
CREATE TRIGGER redact_deleted_message_events BEFORE DELETE ON messages BEGIN
  UPDATE event_log SET payload = json_remove(
    CASE WHEN json_extract(payload, '$.message.message_id') = OLD.message_id THEN
      json_remove(payload, '$.message.text', '$.message.html', '$.message.extracted_text',
        '$.message.extracted_html', '$.message.preview', '$.message.subject',
        '$.message.headers', '$.message.attachments')
    ELSE payload END,
    '$.thread.subject', '$.thread.preview', '$.thread.attachments')
  WHERE inbox_id = OLD.inbox_id AND invalid = 0 AND
    CASE WHEN json_valid(payload) THEN
      json_extract(payload, '$.message.thread_id') = OLD.thread_id
    ELSE 0 END;
END;
CREATE TABLE webhooks (
  webhook_id TEXT PRIMARY KEY,
  api_key_id TEXT,
  inbox_id TEXT,
  inbox_ids TEXT,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  event_types TEXT NOT NULL,
  headers TEXT NOT NULL,
  client_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  failure_count INTEGER NOT NULL DEFAULT 0,
  disabled_reason TEXT,
  last_error_code TEXT,
  last_success_at TEXT,
  cursor INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE webhook_deliveries (
  webhook_id TEXT NOT NULL REFERENCES webhooks(webhook_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL REFERENCES event_log(sequence) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'delivered', 'cancelled', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_until INTEGER,
  claim_id TEXT,
  PRIMARY KEY (webhook_id, sequence)
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (state, next_attempt_at);
ALTER TABLE outbox ADD COLUMN source_draft_id TEXT;
`;
