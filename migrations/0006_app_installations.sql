-- GitHub App installation id per repo owner (org or user), found via the app JWT. NULL = the app is not installed there (asked again after an hour).
CREATE TABLE app_installations (
  owner           TEXT PRIMARY KEY COLLATE NOCASE,
  installation_id INTEGER,
  checked_at      INTEGER NOT NULL
);
