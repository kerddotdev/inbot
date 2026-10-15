export const credentialRequestsSchema = `
CREATE TABLE IF NOT EXISTS credential_requests (
  request_id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL REFERENCES inboxes(inbox_id) ON DELETE CASCADE,
  api_key_id TEXT,
  name TEXT NOT NULL,
  url TEXT,
  username TEXT,
  fields TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'fulfilled', 'declined', 'expired')),
  credential_id TEXT REFERENCES credentials(credential_id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS credential_requests_key_page ON credential_requests (api_key_id, created_at, request_id);
CREATE INDEX IF NOT EXISTS credential_requests_expiry ON credential_requests (expires_at) WHERE state = 'pending';
`;
