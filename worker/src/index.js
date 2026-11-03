// BOXING accounts + ranking API for Cloudflare Workers + D1.
// Same endpoints and JSON shapes as server.ps1 (the local server), so boxing.html works with either:
//   POST /api/signup  /api/login  /api/char  /api/best  /api/ranking     (GET /api/health for a quick check)

const CHARS = ['outfighter', 'infighter', 'slugger'];
const ID_RE = /^[A-Za-z0-9_가-힣]{3,12}$/;           // 3-12 chars: letters, digits, _, Hangul
const MAX_LEVEL = 99;
const PBKDF2_ITER = 30000;                                   // stored per account, so it can be raised later without breaking old accounts
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_SESSIONS = 5;                                      // per account (oldest are dropped)
const MAX_BODY = 4096;
const LOGIN_FAILS = { max: 8, windowMs: 10 * 60 * 1000 };    // wrong passwords per (ip, account)
const SIGNUPS = { max: 15, windowMs: 60 * 60 * 1000 };       // sign-ups per ip

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
    'SELECT u.* FROM sessions s JOIN users u ON u.key = s.key WHERE s.token = ? AND s.created > ?'
  ).bind(token, now - SESSION_MS).first();
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
    `SELECT COUNT(*) AS c FROM users WHERE best >= 1 AND (best > ?1 OR (best = ?1 AND (best_at < ?2 OR (best_at = ?2 AND key < ?3))))`
  ).bind(u.best, u.best_at, u.key).first();
  return r.c + 1;
}
const rankVersion = async db => (await db.prepare("SELECT v FROM meta WHERE k = 'rank_version'").first())?.v ?? 1;

async function handle(path, data, env, ip) {
  const db = env.DB, now = Date.now();
  const id = field(data, 'id'), pw = field(data, 'pw'), key = id.toLowerCase();

  switch (path) {
    case '/api/signup': {
      if (!ID_RE.test(id)) return { ok: false, error: 'invalid_id' };
      if (pw.length < 4 || pw.length > 100) return { ok: false, error: 'short_pw' };
      if (await isLimited(db, 's:' + ip, SIGNUPS, now)) return { ok: false, error: 'too_many' };
      if (await db.prepare('SELECT 1 FROM users WHERE key = ?').bind(key).first()) return { ok: false, error: 'taken' };
      const salt = randHex(16), hash = await pbkdf2(pw, salt, PBKDF2_ITER);
      try {
        await db.prepare('INSERT INTO users (key, id, salt, hash, iter) VALUES (?, ?, ?, ?, ?)').bind(key, id, salt, hash, PBKDF2_ITER).run();
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
      await housekeeping(db, now);
      return { ok: true, id: u.id, best: u.best, char: CHARS.includes(u.char) ? u.char : 'outfighter', token: await newToken(db, u.key, now) };
    }

    case '/api/char': {
      const u = await userByToken(db, field(data, 'token'), now);
      if (!u) return { ok: false, error: 'bad_token' };
      const ch = field(data, 'char');
      if (!CHARS.includes(ch)) return { ok: false, error: 'bad_char' };
      if (u.char !== ch) await db.prepare('UPDATE users SET char = ? WHERE key = ?').bind(ch, u.key).run();
      return { ok: true, char: ch };
    }

    case '/api/best': {
      const u = await userByToken(db, field(data, 'token'), now);
      if (!u) return { ok: false, error: 'bad_token' };
      const level = parseInt(field(data, 'level'), 10) || 0;
      let best = u.best, at = u.best_at;
      if (level > best) {
        // stages are cleared one after another, so an honest client can only raise its record by exactly +1 at a time
        if (level > best + 1 || level > MAX_LEVEL) return { ok: false, error: 'invalid_level', best };
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
      let limit = 10;
      const ls = field(data, 'limit');
      if (ls !== '') { const l = parseInt(ls, 10); if (l >= 0 && l <= 50) limit = l; }
      const [rows, total, version] = await Promise.all([
        limit ? db.prepare('SELECT id, best FROM users WHERE best >= 1 ORDER BY best DESC, best_at ASC, key ASC LIMIT ?').bind(limit).all() : { results: [] },
        db.prepare('SELECT COUNT(*) AS c FROM users WHERE best >= 1').first(),
        rankVersion(db),
      ]);
      const list = rows.results.map((r, i) => ({ rank: i + 1, id: r.id, best: r.best }));
      let me = null;
      const u = await userByToken(db, field(data, 'token'), now);
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
    if (request.method === 'GET' && url.pathname === '/api/health') return json({ ok: true, service: 'boxing-api' });
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
