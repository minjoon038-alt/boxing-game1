-- Run ONCE on a database created before profiles existed (new databases get these columns from schema.sql):
--   npx wrangler d1 execute boxing --remote --file=migrations/001_profile.sql
ALTER TABLE users ADD COLUMN created INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN wins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN losses INTEGER NOT NULL DEFAULT 0;
