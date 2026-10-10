export const mailboxSchema = `
CREATE TABLE inboxes (
  inbox_id TEXT PRIMARY KEY,
  display_name TEXT,
  client_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused')),
  metadata TEXT NOT NULL CHECK (json_valid(metadata)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX inboxes_page ON inboxes(created_at, inbox_id);

CREATE TABLE threads (
  thread_id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL REFERENCES inboxes(inbox_id) ON DELETE CASCADE,
  subject TEXT,
  timestamp TEXT NOT NULL,
  timestamp_key TEXT NOT NULL,
  received_timestamp TEXT,
  sent_timestamp TEXT,
  senders TEXT NOT NULL DEFAULT '[]',
  recipients TEXT NOT NULL DEFAULT '[]',
  preview TEXT,
  last_message_id TEXT NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  attachments TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (inbox_id, thread_id)
);
CREATE INDEX threads_page ON threads(inbox_id, timestamp_key, thread_id);
CREATE INDEX threads_org_page ON threads(timestamp_key, thread_id);

CREATE TABLE messages (
  inbox_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('received', 'sent')),
  "from" TEXT NOT NULL,
  reply_to TEXT NOT NULL,
  "to" TEXT NOT NULL,
  cc TEXT NOT NULL,
  bcc TEXT NOT NULL,
  subject TEXT,
  preview TEXT NOT NULL,
  text TEXT,
  html TEXT,
  extracted_text TEXT,
  extracted_html TEXT,
  in_reply_to TEXT,
  "references" TEXT NOT NULL,
  headers TEXT NOT NULL,
  calendar_event_id TEXT,
  size INTEGER NOT NULL CHECK (size >= 0),
  timestamp TEXT NOT NULL,
  timestamp_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (inbox_id, message_id),
  FOREIGN KEY (inbox_id, thread_id) REFERENCES threads(inbox_id, thread_id) ON DELETE CASCADE
);
CREATE INDEX messages_page ON messages(inbox_id, timestamp_key, message_id);
CREATE INDEX messages_thread_page ON messages(inbox_id, thread_id, timestamp_key, message_id);

CREATE TABLE raw_messages (
  inbox_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  content BLOB NOT NULL,
  PRIMARY KEY (inbox_id, message_id),
  FOREIGN KEY (inbox_id, message_id) REFERENCES messages(inbox_id, message_id) ON DELETE CASCADE
);
CREATE TABLE message_labels (
  inbox_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (inbox_id, message_id, label),
  FOREIGN KEY (inbox_id, message_id) REFERENCES messages(inbox_id, message_id) ON DELETE CASCADE
);
CREATE INDEX labels_lookup ON message_labels(inbox_id, label, message_id);

CREATE TABLE attachments (
  attachment_id TEXT NOT NULL,
  inbox_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  filename TEXT,
  content_type TEXT,
  size INTEGER NOT NULL CHECK (size >= 0),
  content_disposition TEXT CHECK (content_disposition IN ('inline', 'attachment')),
  content_id TEXT,
  content BLOB NOT NULL,
  PRIMARY KEY (inbox_id, attachment_id),
  FOREIGN KEY (inbox_id, message_id) REFERENCES messages(inbox_id, message_id) ON DELETE CASCADE
);
CREATE INDEX attachments_message ON attachments(inbox_id, message_id, attachment_id);

CREATE TABLE message_aliases (
  inbox_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  message_id TEXT NOT NULL,
  PRIMARY KEY (inbox_id, alias),
  FOREIGN KEY (inbox_id, message_id) REFERENCES messages(inbox_id, message_id) ON DELETE CASCADE
);
CREATE INDEX aliases_message ON message_aliases(inbox_id, message_id);

CREATE TABLE mailbox_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  search_revision INTEGER NOT NULL DEFAULT 0
);
INSERT INTO mailbox_state (id) VALUES (1);

CREATE VIRTUAL TABLE message_search USING fts5(
  subject, sender, recipients, body
);
CREATE TRIGGER messages_search_insert AFTER INSERT ON messages BEGIN
  INSERT INTO message_search(rowid, subject, sender, recipients, body)
  VALUES (new.rowid, new.subject, new."from",
    (SELECT group_concat(value, ' ') FROM (
      SELECT value FROM json_each(new."to") UNION ALL
      SELECT value FROM json_each(new.cc) UNION ALL
      SELECT value FROM json_each(new.bcc))),
    coalesce(new.extracted_text, new.text, ''));
  UPDATE mailbox_state SET search_revision = search_revision + 1 WHERE id = 1;
END;
CREATE TRIGGER messages_search_delete AFTER DELETE ON messages BEGIN
  DELETE FROM message_search WHERE rowid = old.rowid;
  UPDATE mailbox_state SET search_revision = search_revision + 1 WHERE id = 1;
END;
CREATE TRIGGER messages_search_update
  AFTER UPDATE OF subject, "from", "to", cc, bcc, text, extracted_text ON messages BEGIN
  DELETE FROM message_search WHERE rowid = old.rowid;
  INSERT INTO message_search(rowid, subject, sender, recipients, body)
  VALUES (new.rowid, new.subject, new."from",
    (SELECT group_concat(value, ' ') FROM (
      SELECT value FROM json_each(new."to") UNION ALL
      SELECT value FROM json_each(new.cc) UNION ALL
      SELECT value FROM json_each(new.bcc))),
    coalesce(new.extracted_text, new.text, ''));
  UPDATE mailbox_state SET search_revision = search_revision + 1 WHERE id = 1;
END;

CREATE VIRTUAL TABLE inbox_search USING fts5(inbox_id, display_name);
CREATE TRIGGER inboxes_search_insert AFTER INSERT ON inboxes BEGIN
  INSERT INTO inbox_search(rowid, inbox_id, display_name)
  VALUES (new.rowid, new.inbox_id, new.display_name);
  UPDATE mailbox_state SET search_revision = search_revision + 1 WHERE id = 1;
END;
CREATE TRIGGER inboxes_search_delete AFTER DELETE ON inboxes BEGIN
  DELETE FROM inbox_search WHERE rowid = old.rowid;
  UPDATE mailbox_state SET search_revision = search_revision + 1 WHERE id = 1;
END;
CREATE TRIGGER inboxes_search_update AFTER UPDATE OF display_name ON inboxes BEGIN
  DELETE FROM inbox_search WHERE rowid = old.rowid;
  INSERT INTO inbox_search(rowid, inbox_id, display_name)
  VALUES (new.rowid, new.inbox_id, new.display_name);
  UPDATE mailbox_state SET search_revision = search_revision + 1 WHERE id = 1;
END;
`;
