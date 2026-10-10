export const oauthSchema = `
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  consented_at INTEGER
);
CREATE TABLE oauth_grants (
  grant_id TEXT PRIMARY KEY REFERENCES api_keys(api_key_id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL
);
CREATE INDEX oauth_clients_expiry ON oauth_clients(consented_at, created_at);
CREATE INDEX oauth_grants_client ON oauth_grants(client_id);
CREATE TABLE oauth_codes (
  code_hash BLOB PRIMARY KEY CHECK (length(code_hash) = 32),
  grant_id TEXT NOT NULL REFERENCES oauth_grants(grant_id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1))
);
CREATE TABLE oauth_families (
  family_id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES oauth_grants(grant_id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
);
CREATE TABLE oauth_tokens (
  token_hash BLOB PRIMARY KEY CHECK (length(token_hash) = 32),
  family_id TEXT NOT NULL REFERENCES oauth_families(family_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  expires_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1))
);
CREATE INDEX oauth_tokens_family ON oauth_tokens(family_id);
CREATE INDEX oauth_tokens_expiry ON oauth_tokens(kind, expires_at);
CREATE INDEX oauth_families_expiry ON oauth_families(expires_at);
CREATE INDEX oauth_codes_expiry ON oauth_codes(expires_at);
CREATE TABLE oauth_limits (
  operation TEXT PRIMARY KEY,
  window INTEGER NOT NULL,
  count INTEGER NOT NULL
);
`;
