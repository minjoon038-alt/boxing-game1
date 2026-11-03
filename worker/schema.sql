-- BOXING accounts + ranking (Cloudflare D1 / SQLite)
CREATE TABLE IF NOT EXISTS users (
  key     TEXT PRIMARY KEY,                 -- lower-cased id (accounts are case-insensitive)
  id      TEXT NOT NULL,                    -- id as typed at sign-up
  salt    TEXT NOT NULL,
  hash    TEXT NOT NULL,                    -- PBKDF2-SHA256 of the password
  iter    INTEGER NOT NULL,                 -- PBKDF2 iterations used for this account
  best    INTEGER NOT NULL DEFAULT 0,       -- highest cleared stage
  best_at INTEGER NOT NULL DEFAULT 0,       -- when that stage was reached (ms) - earlier wins a tie
  char    TEXT NOT NULL DEFAULT 'outfighter'
);
CREATE INDEX IF NOT EXISTS users_rank ON users (best DESC, best_at ASC, key ASC);

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
