-- BOXING accounts + ranking (Cloudflare D1 / SQLite)
CREATE TABLE IF NOT EXISTS users (
  key     TEXT PRIMARY KEY,                 -- lower-cased id (accounts are case-insensitive)
  id      TEXT NOT NULL,                    -- id as typed at sign-up
  salt    TEXT NOT NULL,
  hash    TEXT NOT NULL,                    -- PBKDF2-SHA256 of the password
  iter    INTEGER NOT NULL,                 -- PBKDF2 iterations used for this account
  best    INTEGER NOT NULL DEFAULT 0,       -- highest cleared stage
  best_at INTEGER NOT NULL DEFAULT 0,       -- when that stage was reached (ms) - earlier wins a tie
  char    TEXT NOT NULL DEFAULT 'outfighter',
  created INTEGER NOT NULL DEFAULT 0,       -- sign-up time (ms); 0 = account older than this column
  wins    INTEGER NOT NULL DEFAULT 0,       -- CPU fights won / lost (shown on the profile; has no effect on the ranking)
  losses  INTEGER NOT NULL DEFAULT 0,
  role    TEXT NOT NULL DEFAULT 'user',     -- 'admin' can only be granted with a direct database command, never through the API
  banned  INTEGER NOT NULL DEFAULT 0,
  stage_lv  INTEGER NOT NULL DEFAULT 0,     -- stage ticket: the stage the player started (server-issued, checked when a clear is recorded)
  stage_at  INTEGER NOT NULL DEFAULT 0,
  stage_res INTEGER NOT NULL DEFAULT 0      -- 1 once this ticket's win/loss has been counted
);
CREATE INDEX IF NOT EXISTS users_rank ON users (best DESC, best_at ASC, key ASC);
CREATE INDEX IF NOT EXISTS users_name ON users (lower(id));   -- CrazyGames accounts: key = 'cg:<userId>', id = CrazyGames username, no password

CREATE TABLE IF NOT EXISTS sessions (
  token   TEXT PRIMARY KEY,
  key     TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_key ON sessions (key, created);
CREATE INDEX IF NOT EXISTS sessions_created ON sessions (created);

-- failed-login / sign-up counters (rate limiting)
CREATE TABLE IF NOT EXISTS throttle (
  k        TEXT PRIMARY KEY,
  n        INTEGER NOT NULL,
  first_at INTEGER NOT NULL
);

-- rank_version grows on every ranking change; open ranking screens poll it to know when to refresh
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);
INSERT OR IGNORE INTO meta (k, v) VALUES ('rank_version', 1);

-- every admin action is written here (who, what, on whom)
CREATE TABLE IF NOT EXISTS audit (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  admin  TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_at ON audit (at DESC);

-- finished random-match / room fights (written by the Room when both players report the same winner; 'disputed' when they differ)
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
