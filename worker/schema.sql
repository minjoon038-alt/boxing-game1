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
  stage_res INTEGER NOT NULL DEFAULT 0,     -- 1 once this ticket's win/loss has been counted
  elo     INTEGER NOT NULL DEFAULT 1000,    -- PvP rating (ELO, ranked matches only); separate from the stage ranking
  pvp_w   INTEGER NOT NULL DEFAULT 0,       -- ranked wins / losses
  pvp_l   INTEGER NOT NULL DEFAULT 0,
  n_w     INTEGER NOT NULL DEFAULT 0,       -- normal-match wins / losses
  n_l     INTEGER NOT NULL DEFAULT 0,
  xp      INTEGER NOT NULL DEFAULT 0        -- experience (every fight and every cleared stage); the level is calculated from it
);
CREATE INDEX IF NOT EXISTS users_elo ON users (elo DESC, key ASC);
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
INSERT OR IGNORE INTO meta (k, v) VALUES ('pvp_version', 1);   -- grows on every rated PvP fight (the PvP ranking screen polls it)

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
  status TEXT NOT NULL,           -- 'rated' (rewards given) | 'disputed' | 'fast' (too short) | 'limit' (same pair too often / one-sided: no reward) | 'void' (cancelled)
  mode TEXT NOT NULL DEFAULT 'ranked',   -- 'ranked' | 'normal'
  e1 INTEGER NOT NULL DEFAULT 0,  -- host / guest rating before the fight
  e2 INTEGER NOT NULL DEFAULT 0,
  d1 INTEGER NOT NULL DEFAULT 0,  -- rating change that was actually applied (0 when none)
  d2 INTEGER NOT NULL DEFAULT 0,
  xp1 INTEGER NOT NULL DEFAULT 0, -- experience that was actually given
  xp2 INTEGER NOT NULL DEFAULT 0,
  pct INTEGER NOT NULL DEFAULT 100,   -- share of the normal reward that was given (repeat pairings get less)
  lft TEXT NOT NULL DEFAULT '',   -- role that left during the fight (an AI took over for it)
  ms INTEGER NOT NULL DEFAULT 0   -- server-measured length of the fight
);
CREATE INDEX IF NOT EXISTS matches_at ON matches (at DESC);
CREATE INDEX IF NOT EXISTS matches_pair ON matches (p1, p2, at);
