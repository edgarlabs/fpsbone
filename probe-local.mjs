// Probe: drive client/src/localserver.js the way a browser would, in Node.
//
// This is the static-deploy path end to end — the in-page host, the localStorage career
// store, and the fake socket net.js talks to — exercised without a browser. It exists
// because "the build succeeded" says nothing about whether the thing connects: the bug
// being fixed here was a client that sat on "connecting…" forever, and the only proof
// against it is a WELCOME and then snapshots actually arriving.

// ── browser globals localserver.js and ranks-local.js reach for at import time
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
globalThis.addEventListener = () => {};
globalThis.document = { visibilityState: 'visible' };

const { createLocalSocket } = await import('./client/src/localserver.js');
const { MSG, encode } = await import('./shared/protocol.js');

let pass = 0;
let fail = 0;
const ok = (cond, what, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${what}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; console.log(`FAIL  ${what}${detail ? `  — ${detail}` : ''}`); }
};

// ── connect exactly as net.js does: construct, then assign handlers on the next lines
const sock = createLocalSocket();
const got = [];
let opened = false;
sock.onopen = () => { opened = true; };
sock.onmessage = (e) => got.push(JSON.parse(e.data));
sock.onerror = () => { console.log('FAIL  socket reported an error'); fail++; };

ok(sock.readyState === 0, 'socket starts in CONNECTING, like a real one', `readyState=${sock.readyState}`);

// The open is deferred by a timer, which is the whole point — net.js assigns onopen after
// construction, so a synchronous open would hand the handshake to a handler that is not
// there yet. Waiting proves the deferral is real.
await new Promise((r) => setTimeout(r, 20));
ok(opened, 'onopen fired after the handlers were assigned');
ok(sock.readyState === 1, 'and the socket is OPEN', `readyState=${sock.readyState}`);

// ── the handshake net.js sends on open
sock.send(encode({
  t: MSG.HELLO,
  name: 'probe',
  cosmetics: {},
  id: 'local-probe01',
  mode: 'dm',
}));

// Ownership authorization is deliberately async on the public host because it may read the
// shared database. The local implementation returns immediately, but the common handshake
// still crosses that promise boundary; give its microtask a turn just as a real socket would.
await new Promise((r) => setTimeout(r, 20));

const welcome = got.find((m) => m.t === MSG.WELCOME);
ok(!!welcome, 'WELCOME came back after the authorized handshake');
ok(welcome?.id >= 1, 'and seated us with a player id', `id=${welcome?.id}`);
ok(Array.isArray(welcome?.avail) && welcome.avail.length > 0,
   'and reported the modes that have controllers', `avail=${welcome?.avail?.join(',')}`);
ok(welcome?.tickHz === 60 && welcome?.snapshotHz === 20,
   'at the real tick and snapshot rates', `${welcome?.tickHz}Hz / ${welcome?.snapshotHz}Hz`);
ok(welcome?.lob && typeof welcome.lob === 'object' && welcome.lob.dm === 1,
   'and told us how full every lobby is, counting us in the one we joined',
   `lob=${JSON.stringify(welcome?.lob)}`);

// ── let the simulation run, then look at what it sent
got.length = 0;
const RUN_MS = 1000;
await new Promise((r) => setTimeout(r, RUN_MS));

const snaps = got.filter((m) => m.t === MSG.SNAPSHOT);
ok(snaps.length > 0, 'snapshots arrive without any further prompting', `${snaps.length} in ${RUN_MS}ms`);
// 20Hz nominal. Node timers are coarse, so the bar is "clearly running", not "exact".
ok(snaps.length >= 12, 'at roughly the 20Hz the protocol specifies',
   `${(snaps.length * 1000 / RUN_MS).toFixed(1)}Hz measured against 20Hz nominal`);

const s0 = snaps[0];
ok(typeof s0?.tick === 'number' && s0.tick > 0, 'stamped with an advancing tick', `tick=${s0?.tick}`);
ok(snaps.at(-1).tick > s0.tick, 'and the tick actually advances across the run',
   `${s0?.tick} -> ${snaps.at(-1).tick}`);

// The per-recipient blob is the part a static build would most plausibly lose, because it is
// the one thing broadcast() builds per socket rather than once.
const self = s0?.self;
ok(!!self, 'the private `self` blob is present');
ok(self && ['vx', 'vy', 'vz', 'g', 'st', 'rt', 'sl', 'w', 'ld', 'am'].every((k) => k in self),
   'carrying every field predict.js reconciles from',
   self ? `keys: ${Object.keys(self).join(',')}` : 'n/a');
ok(Number.isInteger(self?.st), 'with stamina as a raw integer, not a rounded float', `st=${self?.st}`);

// ── backfill: the HELLO asked for no bots, because there is no longer a field to ask in.
// One human in a ten-slot room is nine bots, and this is the static build's own copy of
// that rule — a localserver.js that had drifted from server/index.js would show up here as
// an empty map you are alone in.
const players = s0?.p ?? s0?.players ?? [];
const { MODES } = await import('./shared/modes.js');
const slots = MODES.dm.slots;
ok(players.length === slots, 'the room backfilled itself to a full lobby, unasked',
   `${players.length} bodies in the snapshot, ${slots} slots`);

// ── the career store wrote through to "localStorage"
const stored = mem.get('fpsbone.careers.v1');
ok(mem.size === 0 || typeof stored === 'string',
   'the career store is wired without throwing',
   mem.size === 0 ? 'nothing to persist yet (no kills) — correct' : `stored: ${stored}`);

// ── teardown
sock.close();
ok(sock.readyState === 3, 'close() puts the socket in CLOSED', `readyState=${sock.readyState}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
