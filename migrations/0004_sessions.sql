-- Viewer sign-in (GitHub App user authorization). Only sha256(session id) is stored; tokens are AES-GCM encrypted.
CREATE TABLE sessions (
  id_hash     TEXT PRIMARY KEY,        -- hex sha256 of the session cookie value
  user_id     INTEGER NOT NULL,        -- GitHub user id
  login       TEXT NOT NULL,
  avatar_url  TEXT,
  access_enc  TEXT NOT NULL,           -- v1.<iv>.<ciphertext>
  refresh_enc TEXT,
  access_exp  INTEGER,                 -- epoch ms; NULL = does not expire
  refresh_exp INTEGER,
  expires_at  INTEGER NOT NULL,        -- hard end of the session (30 days)
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);
CREATE INDEX sessions_expires ON sessions (expires_at);

-- cached answer to "may this GitHub user see this repo?" (10 minutes)
CREATE TABLE repo_access (
  user_id    INTEGER NOT NULL,
  repo_id    INTEGER NOT NULL,
  allowed    INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, repo_id)
);
CREATE INDEX repo_access_checked ON repo_access (checked_at);
