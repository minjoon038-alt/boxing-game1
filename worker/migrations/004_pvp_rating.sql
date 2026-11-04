-- Run ONCE on a database that already has 001-003 applied (new databases get this from schema.sql):
--   npx wrangler d1 execute boxing --remote --file=migrations/004_pvp_rating.sql
-- PvP rating (ELO, ranked matches only), levels / experience (every fight and every cleared stage), normal-match record.
ALTER TABLE users ADD COLUMN elo   INTEGER NOT NULL DEFAULT 1000;
ALTER TABLE users ADD COLUMN pvp_w INTEGER NOT NULL DEFAULT 0;   -- ranked wins / losses
ALTER TABLE users ADD COLUMN pvp_l INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN n_w   INTEGER NOT NULL DEFAULT 0;   -- normal-match wins / losses
ALTER TABLE users ADD COLUMN n_l   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN xp    INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS users_elo ON users (elo DESC, key ASC);
ALTER TABLE matches ADD COLUMN mode TEXT    NOT NULL DEFAULT 'ranked';   -- 'ranked' | 'normal'
ALTER TABLE matches ADD COLUMN e1   INTEGER NOT NULL DEFAULT 0;          -- host / guest rating before the fight
ALTER TABLE matches ADD COLUMN e2   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE matches ADD COLUMN d1   INTEGER NOT NULL DEFAULT 0;          -- rating change that was actually applied (0 when none)
ALTER TABLE matches ADD COLUMN d2   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE matches ADD COLUMN xp1  INTEGER NOT NULL DEFAULT 0;          -- experience that was actually given
ALTER TABLE matches ADD COLUMN xp2  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE matches ADD COLUMN pct  INTEGER NOT NULL DEFAULT 100;        -- how much of the normal reward was given (repeat pairings get less)
ALTER TABLE matches ADD COLUMN lft  TEXT    NOT NULL DEFAULT '';         -- role that left during the fight (an AI took over for it)
ALTER TABLE matches ADD COLUMN ms   INTEGER NOT NULL DEFAULT 0;          -- server-measured length of the fight
CREATE INDEX IF NOT EXISTS matches_pair ON matches (p1, p2, at);
INSERT OR IGNORE INTO meta (k, v) VALUES ('pvp_version', 1);
UPDATE matches SET status = 'rated' WHERE status = 'agreed';
-- players who already cleared stages get the experience those clears are worth (30 + 5 per stage number, each stage once)
UPDATE users SET xp = 30 * best + 5 * best * (best + 1) / 2 WHERE best > 0;
