-- Run ONCE on a database that already has 001_profile.sql applied (new databases get all of this from schema.sql):
--   npx wrangler d1 execute boxing --remote --file=migrations/002_admin_security.sql
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';       -- 'admin' can only be granted with a direct database command, never through the API
ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN stage_lv INTEGER NOT NULL DEFAULT 0;     -- stage ticket: the stage the player started (server-issued, checked when a clear is recorded)
ALTER TABLE users ADD COLUMN stage_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN stage_res INTEGER NOT NULL DEFAULT 0;    -- 1 once this ticket's win/loss has been counted
CREATE TABLE IF NOT EXISTS audit (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  admin  TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_at ON audit (at DESC);
