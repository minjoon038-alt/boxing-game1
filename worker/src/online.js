// Real-time part of the BOXING backend: random matchmaking (Lobby) and match rooms (Room), both Durable Objects spoken to over WebSocket.
//
//   /ws/lobby          Lobby (one global object): {k:'auth',token} -> {k:'ready'}; {k:'queue',ch,mode:'normal'|'ranked'} joins the queue; {k:'cancel'} leaves it.
//                      Ranked needs level RANKED_MIN_LEVEL ({k:'err',error:'low_level'} otherwise). Players are paired with the closest rating (ranked) /
//                      level (normal) - the accepted difference grows while they wait, so a new player meets other new players first.
//                      The Lobby then creates a Room and sends both {k:'matched', room, role:'host'|'guest', mode, opp:{name,ch}}.
//   /ws/room/<id>      Room: {k:'auth',token} -> {k:'joined',role}; when both players are in, both get {k:'go'}. After that the room relays the game
//                      messages between the two players (the host's browser still calculates the fight) and answers {k:'rtt'} pings.
//                      Both players report {k:'result', r:<round>, w:'host'|'guest'}; the room settles the fight (see finish()) and tells both {k:'rated',...}.
//                      If one player leaves during a fight, an AI takes his place in the other player's browser; the player who stayed reports the result and
//                      {k:'left', r}: if the AI loses, the one who left loses; if the AI wins the fight is void. The room only believes {k:'left'} when the
//                      other player's connection to the room really is closed.
//
// (Players normally fight over a direct P2P connection and use the room only to meet and to report the result: from Korea the free plan is routed through
// Los Angeles, a round trip of ~0.4 s. The relay is the automatic fallback when P2P does not connect; "rdy" / "relay" are the messages that arrange that.)
// Cost control (Workers Free plan): both objects use the WebSocket Hibernation API, so an idle lobby / room is not billed for duration;
// incoming messages are the only recurring cost (20 messages = 1 request), so the game sends the host's snapshots at 30 Hz.
// Everything is size- and rate-limited, and a player needs a valid login token (banned accounts are refused).
import { DurableObject } from 'cloudflare:workers';
import { eloChange, scaleElo, pairPercent, levelOf, fightXp, PVP_MIN_MS, RANKED_MIN_LEVEL, MIN_ELO } from './rating.js';

const SESSION_MS = 30 * 24 * 3600 * 1000;
const CHARS = ['outfighter', 'infighter', 'slugger'];
const MAX_LOBBY_SOCKETS = 300;
const RELAY = new Set(['hi', 'char', 'start', 'snap', 'in', 'vote', 'ping', 'pong', 'bye', 'rdy', 'relay']);   // the only game messages a room forwards
const MAX_RELAY_BYTES = 16384, MAX_LOBBY_BYTES = 512;
const MAX_MSG_PER_SEC = 120;
const QUEUE_MAX_MS = 90 * 1000;                                   // a queue entry older than this is dropped (the game gives up after 60 s)
const PAIR_RECHECK_MS = 2000;                                     // while somebody waits, look again this often (the accepted difference grows with time)

const send = (ws, o) => { try { ws.send(JSON.stringify(o)); } catch { /* socket already gone */ } };
const closeQuiet = (ws, code, reason) => { try { ws.close(code, reason); } catch { /* already closed */ } };

// a valid, non-banned login -> { key, id, elo, xp } (same rule as the HTTP API)
async function playerByToken(db, token) {
  if (!token) return null;
  return await db.prepare(
    'SELECT u.key AS key, u.id AS id, u.elo AS elo, u.xp AS xp FROM sessions s JOIN users u ON u.key = s.key WHERE s.token = ? AND s.created > ? AND u.banned = 0'
  ).bind(token, Date.now() - SESSION_MS).first();
}

// per-socket message rate limit (in memory; a burst keeps the object awake, so the counter survives it)
function tooFast(map, ws) {
  const now = Date.now();
  let r = map.get(ws);
  if (!r || now - r.t >= 1000) { r = { t: now, n: 0 }; map.set(ws, r); }
  return ++r.n > MAX_MSG_PER_SEC;
}

// how far apart two queued players may be: ranked by rating (starts at 100, +40 per second waited), normal by level (starts at 3, +1 per 2 seconds)
const skillOf = a => (a.mode === 'ranked' ? a.elo : levelOf(a.xp).level);
const windowOf = (a, now) => { const sec = (now - a.q) / 1000; return a.mode === 'ranked' ? 100 + 40 * sec : 3 + sec / 2; };

export class Lobby extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.rate = new Map(); }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    if (this.ctx.getWebSockets().length >= MAX_LOBBY_SOCKETS) return new Response('busy', { status: 503 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ uid: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > MAX_LOBBY_BYTES) return closeQuiet(ws, 1009, 'too large');
    if (tooFast(this.rate, ws)) return closeQuiet(ws, 1008, 'too fast');
    let m; try { m = JSON.parse(message); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const at = ws.deserializeAttachment() || {};

    if (!at.uid) {                                                  // the first message must be the login
      if (m.k !== 'auth') return closeQuiet(ws, 1008, 'auth first');
      const u = await playerByToken(this.env.DB, String(m.token || ''));
      if (!u) { send(ws, { k: 'err', error: 'bad_token' }); return closeQuiet(ws, 1008, 'bad token'); }
      for (const o of this.ctx.getWebSockets()) {                   // one lobby connection per account: the newer one replaces the older
        const a = o !== ws && o.deserializeAttachment();
        if (a && a.uid === u.key) { send(o, { k: 'err', error: 'replaced' }); closeQuiet(o, 1000, 'replaced'); }
      }
      ws.serializeAttachment({ uid: u.key, name: u.id, elo: u.elo, xp: u.xp, q: 0, ch: 'outfighter', mode: 'normal' });
      return send(ws, { k: 'ready' });
    }

    if (m.k === 'queue') {
      const mode = m.mode === 'ranked' ? 'ranked' : 'normal';
      if (mode === 'ranked' && levelOf(at.xp).level < RANKED_MIN_LEVEL) return send(ws, { k: 'err', error: 'low_level' });
      ws.serializeAttachment({ ...at, q: Date.now(), mode, ch: CHARS.includes(m.ch) ? m.ch : 'outfighter' });
      return this.tryPair();
    }
    if (m.k === 'cancel') ws.serializeAttachment({ ...at, q: 0 });
  }

  // pair players of the same mode whose skill is close enough (closest first, longest-waiting player is host); look again later for the rest
  async tryPair() {
    for (;;) {
      const now = Date.now(), waiting = [];
      for (const w of this.ctx.getWebSockets()) {
        const a = w.deserializeAttachment();
        if (!a || !a.uid || !a.q) continue;
        if (now - a.q > QUEUE_MAX_MS) { w.serializeAttachment({ ...a, q: 0 }); continue; }
        waiting.push({ w, a });
      }
      waiting.sort((x, y) => x.a.q - y.a.q);
      let pair = null;
      for (const host of waiting) {
        let guest = null, best = Infinity;
        for (const g of waiting) {
          if (g === host || g.a.uid === host.a.uid || g.a.mode !== host.a.mode) continue;
          const diff = Math.abs(skillOf(g.a) - skillOf(host.a));
          if (diff <= Math.max(windowOf(host.a, now), windowOf(g.a, now)) && diff < best) { guest = g; best = diff; }
        }
        if (guest) { pair = { host, guest }; break; }
      }
      if (!pair) { if (waiting.length) await this.ctx.storage.setAlarm(now + PAIR_RECHECK_MS); return; }
      const { host, guest } = pair;
      // take both out of the queue BEFORE any await, so a second pass running meanwhile cannot pair the same sockets again
      host.w.serializeAttachment({ ...host.a, q: 0 }); guest.w.serializeAttachment({ ...guest.a, q: 0 });
      const room = crypto.randomUUID().replace(/-/g, '');
      try {
        const r = await this.env.ROOM.get(this.env.ROOM.idFromName(room)).fetch('https://room/init', {
          method: 'POST',
          body: JSON.stringify({ mode: host.a.mode, players: [{ uid: host.a.uid, name: host.a.name, ch: host.a.ch, role: 'host' }, { uid: guest.a.uid, name: guest.a.name, ch: guest.a.ch, role: 'guest' }] }),
        });
        if (!r.ok) throw new Error('init ' + r.status);
      } catch (e) {
        console.error('room init failed', e && e.message || e);
        for (const x of [host, guest]) send(x.w, { k: 'err', error: 'busy' });
        continue;
      }
      send(host.w, { k: 'matched', room, role: 'host', mode: host.a.mode, opp: { name: guest.a.name, ch: guest.a.ch } });
      send(guest.w, { k: 'matched', room, role: 'guest', mode: host.a.mode, opp: { name: host.a.name, ch: host.a.ch } });
    }
  }
  async alarm() { await this.tryPair(); }

  async webSocketClose(ws) { this.rate.delete(ws); closeQuiet(ws, 1000, 'bye'); }
  async webSocketError(ws) { this.rate.delete(ws); }
}

export class Room extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.rate = new Map(); this.chain = Promise.resolve(); }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade') === 'websocket') {
      if (this.ctx.getWebSockets().length >= 2) return new Response('full', { status: 409 });
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ role: null });
      return new Response(null, { status: 101, webSocket: client });
    }
    // only the Lobby (inside the Worker) can reach this: the public route forwards WebSocket upgrades only
    if (url.pathname === '/init' && request.method === 'POST') {
      const data = await request.json();
      if (!data || !Array.isArray(data.players) || data.players.length !== 2) return new Response('bad', { status: 400 });
      await this.ctx.storage.put('players', data.players);
      await this.ctx.storage.put('mode', data.mode === 'ranked' ? 'ranked' : 'normal');
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  }

  peerOf(ws) {
    for (const o of this.ctx.getWebSockets()) { if (o !== ws && (o.deserializeAttachment() || {}).role) return o; }
    return null;
  }
  present(role, except) {                                           // is this player still connected to the room?
    for (const o of this.ctx.getWebSockets()) { if (o !== except && o.readyState === 1 && (o.deserializeAttachment() || {}).role === role) return true; }
    return false;
  }
  enqueue(fn) { this.chain = this.chain.then(fn).catch(e => console.error('room task failed', e && e.message || e)); return this.chain; }   // one at a time, so two reports arriving together cannot interleave

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > MAX_RELAY_BYTES) return closeQuiet(ws, 1009, 'too large');
    if (tooFast(this.rate, ws)) return closeQuiet(ws, 1008, 'too fast');
    let m; try { m = JSON.parse(message); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const at = ws.deserializeAttachment() || {};

    if (!at.role) {                                                 // login: only the two players the Lobby named may join
      if (m.k !== 'auth') return closeQuiet(ws, 1008, 'auth first');
      const u = await playerByToken(this.env.DB, String(m.token || ''));
      const players = await this.ctx.storage.get('players');
      const p = u && players && players.find(x => x.uid === u.key);
      if (!p) { send(ws, { k: 'err', error: 'not_in_room' }); return closeQuiet(ws, 1008, 'not in room'); }
      for (const o of this.ctx.getWebSockets()) {                   // the same player reconnecting replaces the old connection
        const a = o !== ws && o.deserializeAttachment();
        if (a && a.role === p.role) { closeQuiet(o, 1000, 'replaced'); }
      }
      ws.serializeAttachment({ role: p.role, uid: p.uid, name: p.name });
      send(ws, { k: 'joined', role: p.role });
      const peer = this.peerOf(ws);
      if (peer) {
        if (await this.ctx.storage.get('since') === undefined) await this.ctx.storage.put('since', Date.now());     // the clock for the first fight's length starts when both are in
        send(ws, { k: 'go' }); send(peer, { k: 'go' });
      }
      return;
    }

    if (m.k === 'rtt') return send(ws, { k: 'rtt', t: m.t });       // latency probe: answered here, never forwarded
    if (m.k === 'result') return this.enqueue(() => this.onResult(at, m, ws));
    if (m.k === 'left') return this.enqueue(() => this.onLeft(at, m, ws));
    if (RELAY.has(m.k)) { const peer = this.peerOf(ws); if (peer) { try { peer.send(message); } catch { /* peer gone */ } } }
  }

  async onResult(at, m, ws) {
    const r = Number.isInteger(m.r) && m.r >= 0 && m.r < 1000 ? m.r : null;
    if (r === null || (m.w !== 'host' && m.w !== 'guest')) return;
    const st = this.ctx.storage;
    if (await st.get('done:' + r)) return;
    if (await st.get('res:' + r + ':' + at.role)) return;            // the first report of a player counts; changing it later is ignored
    await st.put('res:' + r + ':' + at.role, m.w);
    if (await st.get('first:' + r) === undefined) await st.put('first:' + r, Date.now());
    await this.settle(r, ws);
  }
  // "the other player left during round r and an AI took his place". Only believed when his connection to the room is really closed
  async onLeft(at, m, ws) {
    const r = Number.isInteger(m.r) && m.r >= 0 && m.r < 1000 ? m.r : null;
    if (r === null) return;
    const st = this.ctx.storage, claims = await st.get('claims') || {};
    if (!claims[r]) { claims[r] = at.role; await st.put('claims', claims); }
    await this.settle(r, ws);
  }

  // is round r ready to be counted? Both reported, or one player reported + claims the other left and the other really is gone
  async settle(r, except) {
    const st = this.ctx.storage;
    if (await st.get('done:' + r)) return;
    const a = await st.get('res:' + r + ':host'), b = await st.get('res:' + r + ':guest');
    if (a && b) return this.finish(r, a === b ? a : '', '');
    const only = a ? 'host' : b ? 'guest' : '';
    if (!only) return;
    const claims = await st.get('claims') || {};
    const other = only === 'host' ? 'guest' : 'host';
    if (claims[r] !== only || this.present(other, except)) return;
    // the one who stayed won against the replacement AI -> counts as a win for him and a loss for the one who left. If the AI won the fight is void
    return this.finish(r, (a || b) === only ? only : 'void', other);
  }

  // winRole: 'host' | 'guest' (counted), '' (the two reports disagreed), 'void' (the AI that replaced a leaver won). left: role that left
  async finish(r, winRole, left) {
    const st = this.ctx.storage, now = Date.now();
    const first = await st.get('first:' + r) ?? now, since = await st.get('since');
    await st.put('done:' + r, 1);
    await st.put('since', first);                                    // the next fight is timed from the end of this one
    await st.delete(['res:' + r + ':host', 'res:' + r + ':guest', 'first:' + r]);
    const players = await st.get('players') || [], ranked = (await st.get('mode')) === 'ranked';
    const host = players.find(p => p.role === 'host') || {}, guest = players.find(p => p.role === 'guest') || {};
    const winnerName = winRole === 'host' ? host.name : winRole === 'guest' ? guest.name : '';
    const ms = since === undefined ? 0 : Math.max(0, first - since);
    const minMs = this.env.PVP_MIN_MS !== undefined ? Number(this.env.PVP_MIN_MS) : PVP_MIN_MS;
    const db = this.env.DB;
    let status = winRole === '' ? 'disputed' : winRole === 'void' ? 'void' : 'rated', pct = 100, e1 = 0, e2 = 0, d1 = 0, d2 = 0, x1 = 0, x2 = 0, u1 = null, u2 = null;
    try {
      if (status === 'rated') {
        const rows = (await db.prepare('SELECT key, elo, xp, pvp_w + pvp_l AS games, banned FROM users WHERE key IN (?, ?)').bind(host.uid || '', guest.uid || '').all()).results;
        u1 = rows.find(x => x.key === host.uid); u2 = rows.find(x => x.key === guest.uid);
        if (!u1 || !u2 || u1.banned || u2.banned) status = 'void';                 // an account was deleted / banned during the fight
        else {
          e1 = u1.elo; e2 = u2.elo;
          if (ms < minMs) status = 'fast';
          else {
            const prior = (await db.prepare("SELECT winner FROM matches WHERE status IN ('rated', 'limit') AND at > ?1 AND ((p1 = ?2 AND p2 = ?3) OR (p1 = ?3 AND p2 = ?2)) ORDER BY id").bind(now - 24 * 3600 * 1000, host.name, guest.name).all()).results.map(x => x.winner);
            pct = pairPercent(prior, winnerName);
            if (pct === 0) status = 'limit';
            else {
              const hostWon = winRole === 'host', give = won => Math.max(1, Math.round(fightXp(ranked, won) * pct / 100));
              x1 = give(hostWon); x2 = give(!hostWon);
              if (ranked) {
                [d1, d2] = eloChange(u1.elo, u2.elo, hostWon, u1.games, u2.games);
                [d1, d2] = scaleElo(d1, d2, pct, hostWon);
                d1 = Math.max(MIN_ELO, u1.elo + d1) - u1.elo; d2 = Math.max(MIN_ELO, u2.elo + d2) - u2.elo;      // the rating never drops below the floor
              }
            }
          }
        }
      }
      const stmts = [db.prepare('INSERT INTO matches (at, room, p1, p2, winner, status, mode, e1, e2, d1, d2, xp1, xp2, pct, lft, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(now, this.ctx.id.toString().slice(0, 16), host.name || '', guest.name || '', winnerName || '', status, ranked ? 'ranked' : 'normal', e1, e2, d1, d2, x1, x2, pct, left || '', ms)];
      if (status === 'rated') {
        const upd = (key, d, xp, won) => db.prepare('UPDATE users SET xp = xp + ?1, elo = MAX(?2, elo + ?3), pvp_w = pvp_w + ?4, pvp_l = pvp_l + ?5, n_w = n_w + ?6, n_l = n_l + ?7 WHERE key = ?8')
          .bind(xp, MIN_ELO, d, ranked && won ? 1 : 0, ranked && !won ? 1 : 0, !ranked && won ? 1 : 0, !ranked && !won ? 1 : 0, key);
        stmts.push(upd(host.uid, d1, x1, winRole === 'host'), upd(guest.uid, d2, x2, winRole === 'guest'));
        if (ranked) stmts.push(db.prepare("UPDATE meta SET v = v + 1 WHERE k = 'pvp_version'"));
      }
      await db.batch(stmts);
    } catch (e) { console.error('match record failed', e && e.message || e); return; }
    const mode = ranked ? 'ranked' : 'normal', known = !!u1 && !!u2 && status !== 'void';
    for (const o of this.ctx.getWebSockets()) {                     // tell whoever is still here how the fight was counted
      const role = (o.deserializeAttachment() || {}).role;
      if (!role) continue;
      const u = role === 'host' ? u1 : u2, d = role === 'host' ? d1 : d2, gain = role === 'host' ? x1 : x2;
      send(o, { k: 'rated', r, mode, status, pct, left: !!left, delta: d, gain, elo: known && u ? u.elo + d : 0, xp: known && u ? u.xp + gain : 0 });
    }
  }

  async webSocketClose(ws) { await this.left(ws); }
  async webSocketError(ws) { await this.left(ws); }
  async left(ws) {
    this.rate.delete(ws);
    const at = ws.deserializeAttachment() || {};
    closeQuiet(ws, 1000, 'bye');
    if (!at.role) return;
    const peer = this.peerOf(ws);
    if (peer) send(peer, { k: 'bye' });
    await this.enqueue(async () => {                                // a player who already claimed "the other one left" may be believed now
      const claims = await this.ctx.storage.get('claims') || {};
      for (const r of Object.keys(claims)) await this.settle(+r, ws);
      if (!peer) await this.ctx.storage.deleteAll();                // nobody left: forget the room
    });
  }
}
