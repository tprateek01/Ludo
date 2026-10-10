// Vercel serverless function: all game logic + Redis-backed room storage.
// Six-section ring board: 54 ring cells (9 per section). Colour = section.
const COLORS = ['red', 'green', 'yellow', 'blue', 'purple', 'orange'];
const SEATS = { 2: [0, 3], 3: [0, 2, 4], 4: [0, 1, 3, 4], 5: [0, 1, 2, 3, 4], 6: [0, 1, 2, 3, 4, 5] };
const RING = 54, RING_LAST = 52, FINISH = 58, MAX = 6;
const START = c => 9 * COLORS.indexOf(c);
const isSafe = abs => abs % 9 === 0 || abs % 9 === 5;
const TTL = 6 * 3600;

const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const mem = globalThis.__ludoMem || (globalThis.__ludoMem = new Map()); // local dev fallback only

async function redis(cmd) {
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
async function load(code) {
  if (!URL_) return mem.get(code) || null;
  const v = await redis(['GET', 'ludo:' + code]);
  return v ? JSON.parse(v) : null;
}
async function save(code, s, ttl = TTL) {
  if (!URL_) return void mem.set(code, s);
  await redis(['SET', 'ludo:' + code, JSON.stringify(s), 'EX', ttl]);
}

const legal = (s, col, d) => { const o = []; s.pos[col].forEach((p, i) => { if (p < 0 ? d === 6 : p + d <= FINISH) o.push(i); }); return o; };
const newPos = s => { s.pos = {}; s.players.forEach(p => s.pos[p.color] = [-1, -1, -1, -1]); };
const newRoom = (pid, name) => ({ v: 1, gid: Math.random().toString(36).slice(2, 8), status: 'lobby', host: pid, max: 4, players: [{ id: pid, name: clean(name) || 'Player' }], pos: {}, turn: 0, dice: null, msg: '' });
const startGame = s => {
  s.players.forEach((p, i) => p.color = COLORS[SEATS[s.players.length][i]]);
  newPos(s); s.status = 'play'; s.turn = 0; s.dice = null; s.msg = 'Roll the dice!';
};
const clean = x => String(x || '').slice(0, 14).replace(/[<>&"]/g, '');

async function act(b) {
  if (!b.pid) return { error: 'Missing player id' };
  if (b.type === 'create') {
    let code, tries = 0;
    do { code = String(1000 + Math.floor(Math.random() * 9000)); } while (await load(code) && ++tries < 20);
    const s = newRoom(b.pid, b.name);
    await save(code, s);
    return { room: code, state: s };
  }
  const code = String(b.room || '').trim();
  if (b.type === 'enter') { // numeric room code 1000-9999: join it, or create it if nobody has it yet
    if (!/^[1-9]\d{3}$/.test(code)) return { error: 'Room code must be a number from 1000 to 9999.' };
    let ex = await load(code);
    if (!ex || ex.status === 'done') { // finished rooms free their code for reuse
      ex = newRoom(b.pid, b.name);
      await save(code, ex); return { room: code, state: ex };
    }
    b.type = 'join';
  }
  const s = await load(code);
  if (!s) return { error: 'Room not found.' };
  const cur = s.players[s.turn], member = s.players.some(p => p.id === b.pid);
  switch (b.type) {
    case 'join':
      if (!member) {
        if (s.status !== 'lobby') return { error: 'That game already started.' };
        if (s.players.length >= s.max) return { error: `Room is full (${s.max}-player game).` };
        s.players.push({ id: b.pid, name: clean(b.name) || 'Player' });
        if (s.players.length === s.max) startGame(s);
      }
      break;
    case 'setmax': {
      const m = Number(b.max);
      if (s.host !== b.pid || s.status !== 'lobby' || !(m >= 2 && m <= MAX) || m < s.players.length) return { error: 'Cannot change player count', state: s };
      s.max = m; if (s.players.length === s.max) startGame(s);
      break;
    }
    case 'roll': {
      if (s.status !== 'play' || cur.id !== b.pid || s.dice) return { error: 'Not your roll', state: s };
      const d = 1 + Math.floor(Math.random() * 6); s.dice = d;
      s.msg = legal(s, cur.color, d).length ? `${cur.name} rolled ${d}` : `${cur.name} rolled ${d} — no moves`;
      break;
    }
    case 'pass': // any player may skip a turn that truly has no legal moves
      if (!member || s.status !== 'play' || !s.dice || legal(s, cur.color, s.dice).length) return { state: s };
      s.dice = null; s.turn = (s.turn + 1) % s.players.length; s.msg = ''; break;
    case 'move': {
      const d = s.dice, i = b.i;
      if (s.status !== 'play' || cur.id !== b.pid || !d || !legal(s, cur.color, d).includes(i)) return { error: 'Illegal move', state: s };
      const p = s.pos[cur.color][i], np = p < 0 ? 0 : p + d; s.pos[cur.color][i] = np;
      let cap = false, msg = `${cur.name} moved`;
      if (np <= RING_LAST) {
        const abs = (START(cur.color) + np) % RING;
        if (!isSafe(abs)) for (const o of s.players) {
          if (o.color === cur.color) continue;
          s.pos[o.color] = s.pos[o.color].map(q => (q >= 0 && q <= RING_LAST && (START(o.color) + q) % RING === abs) ? (cap = true, -1) : q);
        }
      }
      if (cap) msg = `${cur.name} captured a token! 💥`;
      if (np === FINISH) msg = `${cur.name} got a token home 🏠`;
      s.dice = null; s.msg = msg;
      if (s.pos[cur.color].every(x => x === FINISH)) { s.status = 'done'; s.msg = ''; }
      else if (!(d === 6 || cap || np === FINISH)) s.turn = (s.turn + 1) % s.players.length;
      break;
    }
    default: return { error: 'Unknown action' };
  }
  s.v++; await save(code, s, s.status === 'done' ? 120 : TTL);
  return { room: code, state: s };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!URL_ && process.env.VERCEL) return res.status(500).json({ error: 'Storage not configured. Add Upstash Redis to this Vercel project.' });
    if (req.method === 'GET') {
      const s = await load(String(req.query.room || '').trim());
      if (!s) return res.status(404).json({ error: 'Room not found or expired.' });
      return res.status(200).json(Number(req.query.v) === s.v ? { same: true } : { state: s });
    }
    let b = req.body; if (typeof b === 'string') b = JSON.parse(b || '{}');
    res.status(200).json(await act(b || {}));
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
};
