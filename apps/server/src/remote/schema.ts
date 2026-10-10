export const remoteSchema = `
CREATE TABLE remote_access (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  desired TEXT NOT NULL CHECK (desired IN ('enabled', 'disabling')),
  hostname TEXT NOT NULL,
  account_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  zone_name TEXT NOT NULL,
  tunnel_name TEXT NOT NULL,
  tunnel_intent INTEGER NOT NULL DEFAULT 0,
  tunnel_id TEXT,
  dns_intent INTEGER NOT NULL DEFAULT 0,
  dns_id TEXT,
  token TEXT,
  reason TEXT
);
`;
