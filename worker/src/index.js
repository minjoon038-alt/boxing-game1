// UPBOX accounts + ranking API for Cloudflare Workers + D1.
//   POST /api/cg      log in with a CrazyGames account (the game sends the SDK's user token; the account is created on the first visit)
//   POST /api/signup  /api/login  /api/char  /api/stage  /api/best  /api/ranking  /api/profile  /api/result  /api/password  /api/delete     (GET /api/health for a quick check)
//   POST /api/admin/*  (stats, users, user, ban, setbest, setrecord, resetpw, delete, log) - only for accounts whose role is 'admin' in the database
// CrazyGames accounts are stored with key 'cg:<userId>' (the CrazyGames user id never changes; the username can) and have no password.

const CHARS = ['outfighter', 'infighter', 'slugger'];
const ID_RE = /^[A-Za-z0-9_가-힣]{3,12}$/;           // 3-12 chars: letters, digits, _, Hangul
const MAX_LEVEL = 99;
const PBKDF2_ITER = 30000;                                   // stored per account, so it can be raised later without breaking old accounts
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_SESSIONS = 5;                                      // per account (oldest are dropped)
const MAX_BODY = 4096;
const LOGIN_FAILS = { max: 8, windowMs: 10 * 60 * 1000 };    // wrong passwords per (ip, account)
const SIGNUPS = { max: 15, windowMs: 60 * 60 * 1000 };       // sign-ups per ip
const ADMIN_SESSION_MS = 12 * 3600 * 1000;                   // admin actions need a login that is at most this old
// Stage ticket: the game asks for a ticket when a stage starts; a clear / win is only accepted with a ticket that is at least
// MIN_CLEAR_MS old (a real fight takes longer than that) and at most TICKET_MAX_MS old. Overridable with the MIN_CLEAR_MS variable (tests).
const MIN_CLEAR_MS = 6000, TICKET_MAX_MS = 6 * 3600 * 1000;
const CG_KEY_RE = /^cg:[A-Za-z0-9_-]{1,64}$/;
const targetKey = t => ID_RE.test(t) ? t.toLowerCase() : CG_KEY_RE.test(t) ? t : null;   // an admin target: a normal id or a CrazyGames account key

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const randHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const enc = new TextEncoder();

async function pbkdf2(pw, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: iter }, key, 256));
}
function sameText(a, b) {                                    // constant-time compare
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const field = (data, name) => (data && data[name] != null ? String(data[name]) : '');

// ---------- CrazyGames user token (JWT, RS256) ----------
// The game gets the token from the CrazyGames SDK (user.getUserToken) and sends it here; it is checked against CrazyGames' published keys.
// CG_GAME_ID (optional variable): when set, tokens issued for another game are refused.
// CG_DEV_INSECURE=1 (local tests ONLY, never in production): accepts the SDK's local demo tokens, which are not signed by CrazyGames.
const CG_JWKS_URL = 'https://userportal.crazygames.com/.well-known/jwks.json';
const JWKS = { keys: null, at: 0, tried: 0 };
const b64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
async function cgKeys(refresh) {
  const now = Date.now();
  if (JWKS.keys && !refresh && now - JWKS.at < 3600 * 1000) return JWKS.keys;
  if (refresh && now - JWKS.tried < 5 * 60 * 1000) return JWKS.keys || [];        // re-fetch for an unknown key at most every 5 minutes
  JWKS.tried = now;
  const r = await fetch(CG_JWKS_URL, { cf: { cacheTtl: 3600 } });
  if (!r.ok) throw new Error('jwks ' + r.status);
  const j = await r.json();
  JWKS.keys = Array.isArray(j.keys) ? j.keys : []; JWKS.at = now;
  return JWKS.keys;
}
async function verifyCg(token, env) {
  const p = String(token || '').split('.');
  if (p.length !== 3 || String(token).length > 8192) return null;
  let head, body;
  try { head = JSON.parse(new TextDecoder().decode(b64u(p[0]))); body = JSON.parse(new TextDecoder().decode(b64u(p[1]))); } catch { return null; }
  let ok = false;
  if (head && head.alg === 'RS256') {
    for (const refresh of [false, true]) {
      let keys = [];
      try { keys = await cgKeys(refresh); } catch (e) { console.error('jwks', e && e.message || e); }
      const jwk = keys.find(k => k.kid === head.kid && k.kty === 'RSA');
      if (!jwk) continue;
      try {
        const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
        ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(p[2]), enc.encode(p[0] + '.' + p[1]));
      } catch { ok = false; }
      if (ok) break;
    }
  }
  if (!ok && env.CG_DEV_INSECURE !== '1') return null;
  if (!body || body.userId == null || !/^[A-Za-z0-9_-]{1,64}$/.test(String(body.userId))) return null;
  if (ok && !(typeof body.exp === 'number' && body.exp * 1000 > Date.now() - 60 * 1000)) return null;     // expired (one minute of clock leeway)
  if (env.CG_GAME_ID && String(body.gameId) !== String(env.CG_GAME_ID)) return null;
  const name = String(body.username || '').replace(/[^A-Za-z0-9._]/g, '').slice(0, 20) || 'Player';
  return { userId: String(body.userId), name };
}

// ---------- rate limiting ----------
async function isLimited(db, k, rule, now) {
  const r = await db.prepare('SELECT n, first_at FROM throttle WHERE k = ?').bind(k).first();
  return !!r && now - r.first_at < rule.windowMs && r.n >= rule.max;
}
async function countHit(db, k, rule, now) {
  await db.prepare(
    `INSERT INTO throttle (k, n, first_at) VALUES (?1, 1, ?2)
     ON CONFLICT(k) DO UPDATE SET
       n = CASE WHEN ?2 - first_at >= ?3 THEN 1 ELSE n + 1 END,
       first_at = CASE WHEN ?2 - first_at >= ?3 THEN ?2 ELSE first_at END`
  ).bind(k, now, rule.windowMs).run();
}

// ---------- sessions ----------
async function newToken(db, key, now) {
  const token = randHex(24);
  await db.prepare('INSERT INTO sessions (token, key, created) VALUES (?, ?, ?)').bind(token, key, now).run();
  await db.prepare(
    'DELETE FROM sessions WHERE key = ?1 AND token IN (SELECT token FROM sessions WHERE key = ?1 ORDER BY created DESC LIMIT -1 OFFSET ?2)'
  ).bind(key, MAX_SESSIONS).run();
  return token;
}
async function userByToken(db, token, now) {
  if (!token) return null;
  return await db.prepare(
    'SELECT u.* FROM sessions s JOIN users u ON u.key = s.key WHERE s.token = ? AND s.created > ? AND u.banned = 0'
  ).bind(token, now - SESSION_MS).first();
}
// admin = a valid, recent (<= ADMIN_SESSION_MS) login of an account whose role is 'admin'. The role lives only in the database
async function adminByToken(db, token, now) {
  if (!token) return null;
  return await db.prepare(
    "SELECT u.* FROM sessions s JOIN users u ON u.key = s.key WHERE s.token = ? AND s.created > ? AND u.role = 'admin' AND u.banned = 0"
  ).bind(token, now - ADMIN_SESSION_MS).first();
}
async function housekeeping(db, now) {                       // cheap clean-up, run on logins
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE created < ?').bind(now - SESSION_MS),
    db.prepare('DELETE FROM throttle WHERE first_at < ?').bind(now - 24 * 3600 * 1000),
  ]);
}

// ---------- ranking: highest cleared stage first; on a tie the player who reached it EARLIER ranks higher ----------
async function rankOf(db, u) {
  if (!u || u.best < 1) return 0;
  const r = await db.prepare(
    `SELECT COUNT(*) AS c FROM users WHERE best >= 1 AND banned = 0 AND (best > ?1 OR (best = ?1 AND (best_at < ?2 OR (best_at = ?2 AND key < ?3))))`
  ).bind(u.best, u.best_at, u.key).first();
  return r.c + 1;
}
// current-password check for the sensitive endpoints (change password / delete account). Wrong guesses count against the same
// per-(ip, account) limit as logins, so these endpoints cannot be used to brute-force a password around the login limit
async function checkPassword(db, u, pw, ip, now) {
  const tk = 'l:' + ip + ':' + u.key;
  if (await isLimited(db, tk, LOGIN_FAILS, now)) return 'too_many';
  const hash = await pbkdf2(pw.slice(0, 100), u.salt, u.iter);
  if (!sameText(hash, u.hash)) { await countHit(db, tk, LOGIN_FAILS, now); return 'bad_password'; }
  return null;
}
const rankVersion = async db => (await db.prepare("SELECT v FROM meta WHERE k = 'rank_version'").first())?.v ?? 1;

// ---------- admin: every request re-checks the role in the database; every change is written to the audit log ----------
async function handleAdmin(act, data, env) {
  const db = env.DB, now = Date.now();
  const admin = await adminByToken(db, field(data, 'token'), now);
  if (!admin) return { ok: false, error: 'forbidden' };
  const log = (action, target, detail) => db.prepare('INSERT INTO audit (at, admin, action, target, detail) VALUES (?, ?, ?, ?, ?)').bind(now, admin.id, action, target, detail ? JSON.stringify(detail) : '');
  const bump = () => db.prepare("UPDATE meta SET v = v + 1 WHERE k = 'rank_version'");
  const num = (name, max) => { const v = parseInt(field(data, name), 10); return Number.isFinite(v) && v >= 0 && v <= max ? v : null; };
  const page = (maxLimit) => { const l = num('limit', maxLimit) || 20, o = num('offset', 1e9) || 0; return [l, o]; };
  const tid = field(data, 'target');
  const NO_TARGET = ['stats', 'users', 'log', 'matches'];
  const tk = targetKey(tid);
  const target = NO_TARGET.includes(act) ? null : (tk ? await db.prepare('SELECT * FROM users WHERE key = ?').bind(tk).first() : null);
  if (!NO_TARGET.includes(act)) {
    if (!target) return { ok: false, error: 'no_such_user' };
    if (target.role === 'admin' && act !== 'user') return { ok: false, error: 'protected' };     // admin accounts cannot be changed through the API
  }
  const pub = u => ({ key: u.key, cg: u.key.startsWith('cg:'), id: u.id, char: u.char, best: u.best, wins: u.wins, losses: u.losses, created: u.created, banned: !!u.banned, admin: u.role === 'admin' });

  switch (act) {
    case 'stats': {
      const r = await db.prepare('SELECT COUNT(*) AS users, SUM(best >= 1 AND banned = 0) AS ranked, SUM(banned) AS banned, SUM(created > ?) AS new24h, SUM(wins) AS wins, SUM(losses) AS losses FROM users').bind(now - 24 * 3600 * 1000).first();
      return { ok: true, users: r.users, ranked: r.ranked || 0, banned: r.banned || 0, new24h: r.new24h || 0, wins: r.wins || 0, losses: r.losses || 0, version: await rankVersion(db) };
    }
    case 'users': {
      const [limit, offset] = page(50);
      const q = field(data, 'q').toLowerCase().replace(/[\\%_]/g, c => '\\' + c).slice(0, 20);
      const order = { best: 'best DESC, best_at ASC, key ASC', wins: 'wins DESC, key ASC', name: 'key ASC' }[field(data, 'sort')] || 'created DESC, key ASC';
      const [rows, total] = await Promise.all([
        db.prepare(`SELECT * FROM users WHERE (key LIKE ?1 ESCAPE '\\' OR lower(id) LIKE ?1 ESCAPE '\\') ORDER BY ${order} LIMIT ?2 OFFSET ?3`).bind('%' + q + '%', limit, offset).all(),
        db.prepare("SELECT COUNT(*) AS c FROM users WHERE (key LIKE ?1 ESCAPE '\\' OR lower(id) LIKE ?1 ESCAPE '\\')").bind('%' + q + '%').first(),
      ]);
      return { ok: true, total: total.c, list: rows.results.map(pub) };
    }
    case 'user': {
      const sess = await db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE key = ? AND created > ?').bind(target.key, now - SESSION_MS).first();
      return { ok: true, user: { ...pub(target), rank: target.banned ? 0 : await rankOf(db, target), sessions: sess.c, stage_lv: target.stage_lv, stage_at: target.stage_at } };
    }
    case 'ban': {
      const on = data.banned === true || data.banned === 'true';
      const reason = field(data, 'reason').slice(0, 100);
      const stmts = [db.prepare('UPDATE users SET banned = ? WHERE key = ?').bind(on ? 1 : 0, target.key), log(on ? 'ban' : 'unban', target.id, reason ? { reason } : null)];
      if (on) stmts.push(db.prepare('DELETE FROM sessions WHERE key = ?').bind(target.key));      // logged out everywhere right away
      if (target.best >= 1) stmts.push(bump());                                                  // banned players leave the ranking (and come back when unbanned)
      await db.batch(stmts);
      return { ok: true };
    }
    case 'setbest': {
      const v = num('best', MAX_LEVEL);
      if (v === null) return { ok: false, error: 'invalid_level' };
      await db.batch([db.prepare('UPDATE users SET best = ?, best_at = ? WHERE key = ?').bind(v, v === target.best ? target.best_at : now, target.key), log('setbest', target.id, { from: target.best, to: v }), bump()]);
      return { ok: true };
    }
    case 'setrecord': {
      const w = num('wins', 1e6), l = num('losses', 1e6);
      if (w === null || l === null) return { ok: false, error: 'invalid_record' };
      await db.batch([db.prepare('UPDATE users SET wins = ?, losses = ? WHERE key = ?').bind(w, l, target.key), log('setrecord', target.id, { from: [target.wins, target.losses], to: [w, l] })]);
      return { ok: true };
    }
    case 'resetpw': {
      const npw = field(data, 'npw');
      if (npw.length < 4 || npw.length > 100) return { ok: false, error: 'short_pw' };
      const salt = randHex(16), hash = await pbkdf2(npw, salt, PBKDF2_ITER);
      await db.batch([db.prepare('UPDATE users SET salt = ?, hash = ?, iter = ? WHERE key = ?').bind(salt, hash, PBKDF2_ITER, target.key), db.prepare('DELETE FROM sessions WHERE key = ?').bind(target.key), log('resetpw', target.id, null)]);
      return { ok: true };
    }
    case 'delete': {
      const stmts = [db.prepare('DELETE FROM sessions WHERE key = ?').bind(target.key), db.prepare('DELETE FROM users WHERE key = ?').bind(target.key), log('delete', target.id, { best: target.best, wins: target.wins, losses: target.losses })];
      if (target.best >= 1) stmts.push(bump());
      await db.batch(stmts);
      return { ok: true };
    }
    case 'matches': {
      const [limit, offset] = page(100);
      const rows = await db.prepare('SELECT at, p1, p2, winner, status FROM matches ORDER BY id DESC LIMIT ? OFFSET ?').bind(limit, offset).all();
      return { ok: true, list: rows.results };
    }
    case 'log': {
      const [limit, offset] = page(100);
      const rows = await db.prepare('SELECT at, admin, action, target, detail FROM audit ORDER BY id DESC LIMIT ? OFFSET ?').bind(limit, offset).all();
      return { ok: true, list: rows.results };
    }
    default:
      return { ok: false, error: 'not_found' };
  }
}

async function handle(path, data, env, ip) {
  if (path.startsWith('/api/admin/')) return handleAdmin(path.slice('/api/admin/'.length), data, env);
  const db = env.DB, now = Date.now();
  const minClear = env.MIN_CLEAR_MS !== undefined ? Number(env.MIN_CLEAR_MS) : MIN_CLEAR_MS;
  const id = field(data, 'id'), pw = field(data, 'pw'), key = id.toLowerCase();

  switch (path) {
    // CrazyGames account: verified user token -> our account (created on the first visit, username kept up to date). Guests never come here.
    // best / char: the guest progress saved on this device before the player logged in; it is carried over once, when the account is created.
    case '/api/cg': {
      const cg = await verifyCg(field(data, 'cg'), env);
      if (!cg) return { ok: false, error: 'bad_cg_token' };
      const ckey = 'cg:' + cg.userId;
      let u = await db.prepare('SELECT * FROM users WHERE key = ?').bind(ckey).first();
      if (!u) {
        const imp = Math.max(0, Math.min(MAX_LEVEL, parseInt(field(data, 'best'), 10) || 0));
        const ch = CHARS.includes(field(data, 'char')) ? field(data, 'char') : 'outfighter';
        const r = await db.prepare("INSERT OR IGNORE INTO users (key, id, salt, hash, iter, created, best, best_at, char) VALUES (?, ?, '', '', 0, ?, ?, ?, ?)")
          .bind(ckey, cg.name, now, imp, imp ? now : 0, ch).run();
        if (r.meta.changes && imp) {
          await db.batch([
            db.prepare("INSERT INTO audit (at, admin, action, target, detail) VALUES (?, 'system', 'import', ?, ?)").bind(now, cg.name + ' (' + ckey + ')', JSON.stringify({ best: imp })),
            db.prepare("UPDATE meta SET v = v + 1 WHERE k = 'rank_version'"),
          ]);
        }
        u = await db.prepare('SELECT * FROM users WHERE key = ?').bind(ckey).first();
      } else if (u.id !== cg.name && !u.banned) {
        await db.prepare('UPDATE users SET id = ? WHERE key = ?').bind(cg.name, ckey).run();
        if (u.best >= 1) await db.prepare("UPDATE meta SET v = v + 1 WHERE k = 'rank_version'").run();
        u.id = cg.name;
      }
      if (!u) return { ok: false, error: 'server_error' };
      if (u.banned) return { ok: false, error: 'banned' };
      await housekeeping(db, now);
      return { ok: true, id: u.id, best: u.best, char: CHARS.includes(u.char) ? u.char : 'outfighter', token: await newToken(db, u.key, now) };
    }

    case '/api/signup': {
      if (!ID_RE.test(id)) return { ok: false, error: 'invalid_id' };
      if (pw.length < 4 || pw.length > 100) return { ok: false, error: 'short_pw' };
      if (await isLimited(db, 's:' + ip, SIGNUPS, now)) return { ok: false, error: 'too_many' };
      if (await db.prepare('SELECT 1 FROM users WHERE key = ?').bind(key).first()) return { ok: false, error: 'taken' };
      const salt = randHex(16), hash = await pbkdf2(pw, salt, PBKDF2_ITER);
      try {
        await db.prepare('INSERT INTO users (key, id, salt, hash, iter, created) VALUES (?, ?, ?, ?, ?, ?)').bind(key, id, salt, hash, PBKDF2_ITER, now).run();
      } catch (e) { return { ok: false, error: 'taken' }; }          // someone registered the same id at the same moment
      await countHit(db, 's:' + ip, SIGNUPS, now);
      return { ok: true, id, best: 0, char: 'outfighter', token: await newToken(db, key, now) };
    }

    case '/api/login': {
      const tk = 'l:' + ip + ':' + key;
      if (await isLimited(db, tk, LOGIN_FAILS, now)) return { ok: false, error: 'too_many' };
      const u = ID_RE.test(id) ? await db.prepare('SELECT * FROM users WHERE key = ?').bind(key).first() : null;
      // always do the hashing work, so a missing account takes as long as a wrong password
      const hash = await pbkdf2(pw.slice(0, 100), u ? u.salt : 'x'.repeat(32), u ? u.iter : PBKDF2_ITER);
      if (!u || !sameText(hash, u.hash)) { await countHit(db, tk, LOGIN_FAILS, now); return { ok: false, error: 'bad_credentials' }; }
      if (u.banned) return { ok: false, error: 'banned' };
      await housekeeping(db, now);
      return { ok: true, id: u.id, admin: u.role === 'admin', best: u.best, char: CHARS.includes(u.char) ? u.char : 'outfighter', token: await newToken(db, u.key, now) };
    }

    case '/api/char': {
      const u = await userByToken(db, field(data, 'token'), now);
      if (!u) return { ok: false, error: 'bad_token' };
      const ch = field(data, 'char');
      if (!CHARS.includes(ch)) return { ok: false, error: 'bad_char' };
      if (u.char !== ch) await db.prepare('UPDATE users SET char = ? WHERE key = ?').bind(ch, u.key).run();
      return { ok: true, char: ch };
    }

    case '/api/profile': {
      const u = await userByToken(db, field(data, 'token'), now);
      if (!u) return { ok: false, error: 'bad_token' };
      const total = await db.prepare('SELECT COUNT(*) AS c FROM users WHERE best >= 1 AND banned = 0').first();
      return { ok: true, id: u.id, char: CHARS.includes(u.char) ? u.char : 'outfighter', best: u.best, rank: await rankOf(db, u), total: total.c,
               created: u.created || 0, wins: u.wins || 0, losses: u.losses || 0, admin: u.role === 'admin' };
    }

    // a finished fight against the CPU (multiplayer matches are not counted). Shown on the profile only - it does not touch the ranking
    case '/api/result': {
      const u = await userByToken(db, field(data, 'token'), now);
      if (!u) return { ok: false, error: 'bad_token' };
      const won = data.won === true || data.won === 'true' || data.won === 1;
      // one result per stage ticket (the ticket is issued when the stage starts), and a win cannot come sooner than a real fight takes
      if (!u.stage_at || u.stage_res || now - u.stage_at > TICKET_MAX_MS) return { ok: false, error: 'no_ticket' };
      if (won && now - u.stage_at < minClear) return { ok: false, error: 'too_fast' };
      const r = await db.prepare(`UPDATE users SET stage_res = 1, ${won ? 'wins = wins + 1' : 'losses = losses + 1'} WHERE key = ? AND stage_at = ? AND stage_res = 0`).bind(u.key, u.stage_at).run();
      return r.meta.changes ? { ok: true } : { ok: false, error: 'no_ticket' };
    }

    case '/api/password': {
      const u = await userByToken(db, field(data, 'token'), now);
      if (!u) return { ok: false, error: 'bad_token' };
      const npw = field(data, 'npw');
      if (npw.length < 4 || npw.length > 100) return { ok: false, error: 'short_pw' };
      const bad = await checkPassword(db, u, pw, ip, now);
      if (bad) return { ok: false, error: bad };
      const salt = randHex(16), hash = await pbkdf2(npw, salt, PBKDF2_ITER), token = field(data, 'token');
      await db.batch([
        db.prepare('UPDATE users SET salt = ?, hash = ?, iter = ? WHERE key = ?').bind(salt, hash, PBKDF2_ITER, u.key),
        db.prepare('DELETE FROM sessions WHERE key = ? AND token != ?').bind(u.key, token),     // every other device must log in again with the new password
      ]);
      return { ok: true };
    }

    case '/api/delete': {
      const u = await userByToken(db, field(data, 'token'), now);
      if (!u) return { ok: false, error: 'bad_token' };
      const bad = await checkPassword(db, u, pw, ip, now);
      if (bad) return { ok: false, error: bad };
      const stmts = [db.prepare('DELETE FROM sessions WHERE key = ?').bind(u.key), db.prepare('DELETE FROM users WHERE key = ?').bind(u.key)];
      if (u.best >= 1) stmts.push(db.prepare("UPDATE meta SET v = v + 1 WHERE k = 'rank_version'"));   // open ranking screens refresh
      await db.batch(stmts);
      return { ok: true };
    }

    // the game calls this when a stage starts. Too-frequent calls are answered without touching the database
    case '/api/stage': {
      const u = await userByToken(db, field(data, 'token'), now);
      if (!u) return { ok: false, error: 'bad_token' };
      const lv = parseInt(field(data, 'level'), 10);
      if (!(lv >= 1 && lv <= MAX_LEVEL && lv <= u.best + 2)) return { ok: false, error: 'invalid_level' };
      if (now - u.stage_at < Math.min(1500, minClear)) return { ok: true };
      await db.prepare('UPDATE users SET stage_lv = ?, stage_at = ?, stage_res = 0 WHERE key = ?').bind(lv, now, u.key).run();
      return { ok: true };
    }

    case '/api/best': {
      const u = await userByToken(db, field(data, 'token'), now);
      if (!u) return { ok: false, error: 'bad_token' };
      const level = parseInt(field(data, 'level'), 10) || 0;
      let best = u.best, at = u.best_at;
      if (level > best) {
        // stages are cleared one after another, so an honest client can only raise its record by exactly +1 at a time
        if (level > best + 1 || level > MAX_LEVEL) return { ok: false, error: 'invalid_level', best };
        // ... and only with a ticket for this (or a later) stage that is old enough to be a real fight
        if (u.stage_lv < level || now - u.stage_at > TICKET_MAX_MS) return { ok: false, error: 'no_ticket', best };
        if (now - u.stage_at < minClear) return { ok: false, error: 'too_fast', best };
        // compare-and-set: two requests for the same stage cannot both raise the record
        const r = await db.prepare('UPDATE users SET best = ?, best_at = ? WHERE key = ? AND best = ?').bind(level, now, u.key, best).run();
        if (r.meta.changes) {
          best = level; at = now;
          await db.prepare("UPDATE meta SET v = v + 1 WHERE k = 'rank_version'").run();
        } else {
          const fresh = await db.prepare('SELECT best, best_at FROM users WHERE key = ?').bind(u.key).first();
          best = fresh.best; at = fresh.best_at;
        }
      }
      return { ok: true, best, rank: await rankOf(db, { key: u.key, best, best_at: at }), version: await rankVersion(db) };
    }

    case '/api/ranking': {
      // The ranking screen polls every few seconds. If the client already has the current version, answer with just that
      // (one tiny read) instead of recomputing the list and ranks - this keeps the free D1 read quota from running out.
      const since = parseInt(field(data, 'since'), 10);
      if (Number.isFinite(since)) {
        const v = await rankVersion(db);
        if (v === since) return { ok: true, version: v, same: true };
      }
      let limit = 10;
      const ls = field(data, 'limit');
      if (ls !== '') { const l = parseInt(ls, 10); if (l >= 0 && l <= 50) limit = l; }
      const [rows, total, version] = await Promise.all([
        limit ? db.prepare('SELECT key, id, best FROM users WHERE best >= 1 AND banned = 0 ORDER BY best DESC, best_at ASC, key ASC LIMIT ?').bind(limit).all() : { results: [] },
        db.prepare('SELECT COUNT(*) AS c FROM users WHERE best >= 1 AND banned = 0').first(),
        rankVersion(db),
      ]);
      const u = await userByToken(db, field(data, 'token'), now);
      const list = rows.results.map((r, i) => ({ rank: i + 1, id: r.id, best: r.best, ...(u && r.key === u.key ? { me: true } : {}) }));
      let me = null;
      if (u) me = { rank: await rankOf(db, u), id: u.id, best: u.best };
      return { ok: true, version, total: total.c, list, me };
    }

    default:
      return { ok: false, error: 'not_found' };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method === 'GET' && url.pathname === '/api/health') return json({ ok: true, service: 'upbox-api' });
    if (request.method !== 'POST' || !url.pathname.startsWith('/api/')) return json({ ok: false, error: 'not_found' }, 404);
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY) return json({ ok: false, error: 'too_large' }, 413);
      let data = null;
      try { data = JSON.parse(raw); } catch { /* treated as empty */ }
      const ip = request.headers.get('CF-Connecting-IP') || 'local';
      return json(await handle(url.pathname, data && typeof data === 'object' ? data : {}, env, ip));
    } catch (e) {
      console.error('api error', e && e.stack || e);
      return json({ ok: false, error: 'server_error' }, 500);
    }
  },
};
