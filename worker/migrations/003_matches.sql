-- Run ONCE on a database that already has 001 and 002 applied (new databases get this from schema.sql):
--   npx wrangler d1 execute boxing --remote --file=migrations/003_matches.sql
CREATE TABLE IF NOT EXISTS matches (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  room   TEXT NOT NULL,
  p1     TEXT NOT NULL,           -- host (left / blue)
  p2     TEXT NOT NULL,           -- guest (right / red)
  winner TEXT NOT NULL DEFAULT '',  -- '' when the two reports disagreed
  status TEXT NOT NULL            -- 'agreed' | 'disputed'
);
CREATE INDEX IF NOT EXISTS matches_at ON matches (at DESC);
