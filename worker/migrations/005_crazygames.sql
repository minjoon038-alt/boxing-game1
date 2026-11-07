-- CrazyGames accounts. Run ONCE on a database that already has 001-003 applied:
--   npx wrangler d1 execute boxing --remote --file=migrations/005_crazygames.sql
-- Nothing changes in the table: a CrazyGames account is a normal row whose key is 'cg:<CrazyGames userId>' (no password; salt/hash are empty).
-- This index lets the admin page search accounts by their shown name (CrazyGames usernames are not the key).
CREATE INDEX IF NOT EXISTS users_name ON users (lower(id));
