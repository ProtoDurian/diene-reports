-- When did GitHub last confirm this repo's visibility (OIDC token on a CI run, or the visibility cron / inline re-check)?
ALTER TABLE repos ADD COLUMN vis_checked_at INTEGER NOT NULL DEFAULT 0;
UPDATE repos SET vis_checked_at = updated_at;
