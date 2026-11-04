// Real-time part of the BOXING backend: random matchmaking (Lobby) and match rooms (Room), both Durable Objects spoken to over WebSocket.
//
//   /ws/lobby          Lobby (one global object): {k:'auth',token} -> {k:'ready'}; {k:'queue',ch} joins the queue; {k:'cancel'} leaves it.
//                      When two different players are queued the Lobby creates a Room and sends both {k:'matched', room, role:'host'|'guest', opp:{name,ch}}.
//   /ws/room/<id>      Room: {k:'auth',token} -> {k:'joined',role}; when both players are in, both get {k:'go'}. After that the room relays the game
//                      messages between the two players (the host's browser still calculates the fight for now) and answers {k:'rtt'} pings.
//                      Both players report {k:'result', r:<round>, w:'host'|'guest'}; the room writes one row to `matches` when they agree (or marks it disputed).
//
// (Players normally fight over a direct P2P connection and use the room only to meet and to report the result: from Korea the free plan is routed through
// Los Angeles, a round trip of ~0.4 s. The relay is the automatic fallback when P2P does not connect; "rdy" / "relay" are the messages that arrange that.)
// Cost control (Workers Free plan): both objects use the WebSocket Hibernation API, so an idle lobby / room is not billed for duration;
// incoming messages are the only recurring cost (20 messages = 1 request), so the game sends the host's snapshots at 30 Hz.
// Everything is size- and rate-limited, and a player needs a valid login token (banned accounts are refused).
import { DurableObject } from 'cloudflare:workers';

const SESSION_MS = 30 * 24 * 3600 * 1000;
const CHARS = ['outfighter', 'infighter', 'slugger'];
const MAX_LOBBY_SOCKETS = 300;
const RELAY = new Set(['hi', 'char', 'start', 'snap', 'in', 'vote', 'ping', 'pong', 'bye', 'rdy', 'relay']);   // the only game messages a room forwards
const MAX_RELAY_BYTES = 16384, MAX_LOBBY_BYTES = 512;
const MAX_MSG_PER_SEC = 120;

const send = (ws, o) => { try { ws.send(JSON.stringify(o)); } catch { /* socket already gone */ } };
const closeQuiet = (ws, code, reason) => { try { ws.close(code, reason); } catch { /* already closed */ } };

// a valid, non-banned login -> { key, id } (same rule as the HTTP API)
async function playerByToken(db, token) {
  if (!token) return null;
  return await db.prepare(
    'SELECT u.key AS key, u.id AS id FROM sessions s JOIN users u ON u.key = s.key WHERE s.token = ? AND s.created > ? AND u.banned = 0'
  ).bind(token, Date.now() - SESSION_MS).first();
}

// per-socket message rate limit (in memory; a burst keeps the object awake, so the counter survives it)
function tooFast(map, ws) {
  const now = Date.now();
  let r = map.get(ws);
  if (!r || now - r.t >= 1000) { r = { t: now, n: 0 }; map.set(ws, r); }
  return ++r.n > MAX_MSG_PER_SEC;
}

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
      ws.serializeAttachment({ uid: u.key, name: u.id, q: 0, ch: 'outfighter' });
      return send(ws, { k: 'ready' });
    }

    if (m.k === 'queue') {
      ws.serializeAttachment({ ...at, q: Date.now(), ch: CHARS.includes(m.ch) ? m.ch : 'outfighter' });
      return this.tryPair();
    }
    if (m.k === 'cancel') ws.serializeAttachment({ ...at, q: 0 });
  }

  async tryPair() {
    const waiting = [];
    for (const w of this.ctx.getWebSockets()) { const a = w.deserializeAttachment(); if (a && a.uid && a.q) waiting.push({ w, a }); }
    waiting.sort((x, y) => x.a.q - y.a.q);
    if (waiting.length < 2) return;
    const host = waiting[0], guest = waiting.find(x => x.a.uid !== host.a.uid);
    if (!guest) return;
    // take both out of the queue BEFORE any await, so a second 'queue' message arriving meanwhile cannot pair the same sockets again
    host.w.serializeAttachment({ ...host.a, q: 0 }); guest.w.serializeAttachment({ ...guest.a, q: 0 });
    const room = crypto.randomUUID().replace(/-/g, '');
    try {
      const r = await this.env.ROOM.get(this.env.ROOM.idFromName(room)).fetch('https://room/init', {
        method: 'POST',
        body: JSON.stringify({ players: [{ uid: host.a.uid, name: host.a.name, ch: host.a.ch, role: 'host' }, { uid: guest.a.uid, name: guest.a.name, ch: guest.a.ch, role: 'guest' }] }),
      });
      if (!r.ok) throw new Error('init ' + r.status);
    } catch (e) {
      console.error('room init failed', e && e.message || e);
      for (const x of [host, guest]) send(x.w, { k: 'err', error: 'busy' });
      return;
    }
    send(host.w, { k: 'matched', room, role: 'host', opp: { name: guest.a.name, ch: guest.a.ch } });
    send(guest.w, { k: 'matched', room, role: 'guest', opp: { name: host.a.name, ch: host.a.ch } });
  }

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
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  }

  peerOf(ws) {
    for (const o of this.ctx.getWebSockets()) { if (o !== ws && (o.deserializeAttachment() || {}).role) return o; }
    return null;
  }

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
      if (peer) { send(ws, { k: 'go' }); send(peer, { k: 'go' }); }
      return;
    }

    if (m.k === 'rtt') return send(ws, { k: 'rtt', t: m.t });       // latency probe: answered here, never forwarded
    if (m.k === 'result') { this.chain = this.chain.then(() => this.onResult(at, m)).catch(e => console.error('result failed', e && e.message || e)); return this.chain; }   // one at a time, so two reports arriving together cannot interleave
    if (RELAY.has(m.k)) { const peer = this.peerOf(ws); if (peer) { try { peer.send(message); } catch { /* peer gone */ } } }
  }

  // both players report who won; one row is written when they agree (a disagreement is recorded as 'disputed' for the admin to look at)
  async onResult(at, m) {
    const r = Number.isInteger(m.r) && m.r >= 0 && m.r < 1000 ? m.r : null;
    if (r === null || (m.w !== 'host' && m.w !== 'guest')) return;
    const st = this.ctx.storage;
    if (await st.get('done:' + r)) return;
    if (await st.get('res:' + r + ':' + at.role)) return;            // the first report of a player counts; changing it later is ignored
    await st.put('res:' + r + ':' + at.role, m.w);
    const [a, b] = await Promise.all([st.get('res:' + r + ':host'), st.get('res:' + r + ':guest')]);
    if (!a || !b) return;
    await st.put('done:' + r, 1);
    await st.delete(['res:' + r + ':host', 'res:' + r + ':guest']);
    const players = await st.get('players') || [];
    const host = players.find(p => p.role === 'host') || {}, guest = players.find(p => p.role === 'guest') || {};
    const agreed = a === b, winner = agreed ? (a === 'host' ? host.uid : guest.uid) : '';
    try {
      await this.env.DB.prepare('INSERT INTO matches (at, room, p1, p2, winner, status) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(Date.now(), this.ctx.id.toString().slice(0, 16), host.name || '', guest.name || '', winner ? (winner === host.uid ? host.name : guest.name) : '', agreed ? 'agreed' : 'disputed').run();
    } catch (e) { console.error('match insert failed', e && e.message || e); }
  }

  async webSocketClose(ws) { await this.left(ws); }
  async webSocketError(ws) { await this.left(ws); }
  async left(ws) {
    this.rate.delete(ws);
    const at = ws.deserializeAttachment() || {};
    closeQuiet(ws, 1000, 'bye');
    if (!at.role) return;
    const peer = this.peerOf(ws);
    if (peer) { send(peer, { k: 'bye' }); return; }
    await this.ctx.storage.deleteAll();                             // nobody left: forget the room
  }
}
