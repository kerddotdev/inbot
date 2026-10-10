export const provisionSchema = `
CREATE TABLE domains (
  domain_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  zone_name TEXT NOT NULL,
  feedback_enabled INTEGER NOT NULL DEFAULT 0,
  inbound_enabled INTEGER NOT NULL DEFAULT 1,
  subdomains_enabled INTEGER NOT NULL DEFAULT 0,
  tracking_enabled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'NOT_STARTED',
  phase TEXT NOT NULL DEFAULT 'registered',
  reason TEXT,
  records TEXT NOT NULL DEFAULT '[]',
  apex_snapshot TEXT,
  dns_before TEXT,
  dns_step TEXT,
  selftest_token TEXT,
  selftest_sent_at INTEGER,
  selftest_confirmed_at INTEGER,
  selftest_received_at TEXT,
  verified_event_pending INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE provisioned_resources (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id TEXT NOT NULL REFERENCES domains(domain_id),
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  cloudflare_id TEXT,
  parent_id TEXT,
  owned INTEGER NOT NULL,
  UNIQUE(domain_id, kind, resource_key)
);
CREATE TABLE inbox_routing_rules (
  inbox_id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES domains(domain_id),
  rule_id TEXT,
  desired INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE TRIGGER provision_inbox_created AFTER INSERT ON inboxes BEGIN
  INSERT INTO inbox_routing_rules (inbox_id, domain_id, desired)
  SELECT NEW.inbox_id, domain_id, 1 FROM domains
  WHERE domain = substr(NEW.inbox_id, instr(NEW.inbox_id, '@') + 1)
    AND phase IN ('ready', 'applying')
  ON CONFLICT(inbox_id) DO UPDATE SET desired = 1, next_attempt_at = 0;
END;
CREATE TRIGGER provision_inbox_deleted AFTER DELETE ON inboxes BEGIN
  UPDATE inbox_routing_rules SET desired = 0, next_attempt_at = 0
  WHERE inbox_id = OLD.inbox_id;
END;
`;
