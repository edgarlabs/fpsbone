// Every mode, over a real socket, against a real host — localhost or the deploy.
//
// WHY THIS EXISTS SEPARATELY FROM verify.mjs. That suite drives the host in-process on a
// stopped clock, which is the right way to test a rule and no way at all to test a deploy:
// it never opens a socket, never asks a web server for a file, and would pass just as
// happily against a build that puts every player in a private room. This one only ever
// talks to something over the network, so what it proves is that the thing you are pointing
// it at can actually let two people meet — in EVERY mode, not just deathmatch, because a
// mode's slot count and its team controller are per-mode code and dm is no evidence about
// the other three.
//
//   npm run probe:modes                         a server on this machine, port 8080
//   npm run probe:modes -- http://127.0.0.1:8123    somewhere else
//   npm run probe:modes -- https://fpsbone.onrender.com   the deploy; wss: is implied
//
// Two clients per mode is the smallest population that can prove anything: one human alone
// cannot tell a shared room from a private one, and the whole bug this guards against looks
// exactly like a working game until a second person shows up.

import { WebSocket } from 'ws';
import { MSG, decode, encode } from './shared/protocol.js';
import { MODES } from './shared/modes.js';
import * as C from './shared/constants.js';

const base = (process.argv[2] ?? `http://127.0.0.1:${C.NET_PORT}`).replace(/\/+$/, '');
const wsBase = base.replace(/^http/, 'ws'); // https → wss, which an https page also requires
const results = [];
const say = (ok, label, detail) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

/** Resolves on WELCOME and keeps recording; the fields it gathers are only read from the
 *  snapshots that show the OTHER human, because that is the only window in which "two
 *  humans means eight bots" is a claim about anything. */
function join(name, mode) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase);
    const rec = { ws, name, mode, id: null, bots: 0, bodies: 0, sawOther: 0, teams: null, lob: null };
    const t = setTimeout(() => reject(new Error(`${name} never got a WELCOME from ${wsBase}`)), 20000);
    ws.on('error', reject);
    ws.on('open', () => ws.send(encode({ t: MSG.HELLO, name, cosmetics: {}, id: null, mode })));
    ws.on('message', (raw) => {
      const m = decode(raw);
      if (!m) return;
      if (m.t === MSG.WELCOME) { clearTimeout(t); rec.id = m.id; rec.lob = m.lob?.rooms ?? null; resolve(rec); }
      if (m.t === MSG.LOBBY) rec.lob = m.rooms ?? rec.lob;
      if (m.t === MSG.SNAPSHOT && Array.isArray(m.players)) {
        // The wire never labels a bot; the BOT name prefix is what the killfeed reads too.
        const isBot = (p) => typeof p.n === 'string' && p.n.startsWith('BOT ');
        if (m.players.some((p) => p.id !== rec.id && !isBot(p))) {
          rec.bots = m.players.filter(isBot).length;
          rec.bodies = m.players.length;
          rec.sawOther++;
          // `tm`, not `team` — the snapshot field is short. Reading the long name here
          // silently reports 0v0 and looks like a balancing bug in the server.
          if (MODES[mode].teams) {
            rec.teams = [1, 2].map((n) => m.players.filter((p) => p.tm === n).length).join('v');
          }
        }
      }
    });
  });
}

console.log(`probing ${base}\n`);

const health = await fetch(`${base}/healthz`);
const body = (await health.text()).trim();
say(health.ok, 'healthz answers', `${health.status} "${body}"`);
const live = body.replace(/^ok /, '').split(',').filter((m) => MODES[m]);
say(live.length > 1, 'and names more than one live mode', live.join(', '));

const page = await fetch(`${base}/`);
const html = await page.text();
say(page.ok && html.includes('<canvas'), 'the client is served from the same origin as the game',
    `${page.status}, ${html.length}b — same origin means wss: from an https: page, which is the only kind a browser will open`);


// ─────────────────────────────────────────── the two endpoints the region menu is built on
//
// Measured against a real server rather than grepped for, because every part of this is a
// property of the RESPONSE and not of the source: a caching proxy in front of the deploy, a
// host that rewrites headers, or a CDN that answers /ping itself would each read as a working
// server here and as a 0ms ocean in the menu.
{
  const t0 = Date.now();
  const res = await fetch(`${base}/ping`, { cache: 'no-store' });
  const dt = Date.now() - t0;
  const j = res.ok ? await res.json() : null;
  say(res.ok && j !== null, '/ping answers with json', `${res.status} in ${dt}ms — ${JSON.stringify(j)}`);
  // The header the whole feature rests on. Without it the browser serves the second and third
  // samples out of its own cache and every region on earth reports as being in the next room.
  say((res.headers.get('cache-control') ?? '').includes('no-store'),
      'and forbids caching, which is what stops a cached 200 reporting a 0ms ocean',
      `cache-control: ${res.headers.get('cache-control') ?? '(none)'}`);
  // A page served by ONE region has to ask EVERY region how far away it is, and those are
  // cross-origin. Without this header the browser hands the page an opaque failure and every
  // region except its own reads as unreachable.
  say(res.headers.get('access-control-allow-origin') === '*',
      'and allows a cross-origin read, without which four of five cards say unreachable',
      `access-control-allow-origin: ${res.headers.get('access-control-allow-origin') ?? '(none)'}`);
  say(typeof j?.humans === 'number' && j?.lob && typeof j.lob === 'object',
      'carrying the occupancy the card shows beside the ping',
      `${j?.humans} playing, lobbies ${JSON.stringify(j?.lob)}`);
  // Two facts, one request: an empty region with a beautiful ping is not the better room.
  say(Object.keys(j?.lob ?? {}).length > 1,
      'for every lobby and not only the default one', Object.keys(j?.lob ?? {}).join(', '));

  const reg = await fetch(`${base}/regions`, { cache: 'no-store' });
  const table = reg.ok ? await reg.json() : null;
  say(reg.ok && Array.isArray(table?.regions), '/regions answers with a table',
      `${reg.status} — self=${JSON.stringify(table?.self)}, ${table?.regions?.length ?? 0} region(s)`);
  say(reg.headers.get('access-control-allow-origin') === '*',
      'and is readable cross-origin too, since one page reads the table and pings all of it');
  // Not a failure: a single-region deploy legitimately has an empty table, and the menu hides
  // the picker rather than showing one card. Said out loud because the difference between
  // "configured and working" and "configured and silently alone" is invisible otherwise.
  const named = (table?.regions ?? []).map((r) => `${r.id} ${r.host}`).join('  ');
  console.log(table?.regions?.length
    ? `      regions offered: ${named}${table.self ? `  (this one is ${table.self})` : ''}`
    : '      regions offered: none — FPSBONE_REGIONS/FPSBONE_PEER_* unset, so the menu hides '
      + 'the picker and offers this server alone');
  // Every host in the table has to be one a browser can actually turn into a socket.
  const badHost = (table?.regions ?? []).filter((r) => !/^https?:\/\/[^/]+$/.test(String(r.host)));
  say(badHost.length === 0, 'and every address in it is a bare http(s) origin a socket can be built from',
      badHost.length ? badHost.map((r) => `${r.id}=${r.host}`).join(' ') : 'endpoints get appended to these');
}

for (const mode of live) {
  const slots = MODES[mode].slots;
  const label = MODES[mode].label.padEnd(12);
  const a = await join(`probe-a-${mode}`, mode);
  const b = await join(`probe-b-${mode}`, mode);
  await new Promise((r) => setTimeout(r, 2200)); // a couple of seconds of snapshots to read

  say(a.sawOther > 0 && b.sawOther > 0, `${label} two clients land in ONE room`,
      `a saw the other in ${a.sawOther} snapshots, b in ${b.sawOther}`);
  say(a.bots === slots - 2 && b.bots === slots - 2 && a.bodies === slots,
      `${label} ${slots} slots → 2 humans + ${slots - 2} bots`,
      `a bots=${a.bots} bodies=${a.bodies} | b bots=${b.bots} bodies=${b.bodies}`);
  if (MODES[mode].teams) {
    const want = `${MODES[mode].teamSize}v${MODES[mode].teamSize}`;
    say(a.teams === want, `${label} sides come out ${want}`, `alpha/bravo = ${a.teams}`);
  }
  say((a.lob?.[mode] ?? 0) >= 1 && Object.keys(a.lob ?? {}).length > 1,
      `${label} occupancy reported for every lobby`, JSON.stringify(a.lob));

  a.ws.close();
  b.ws.close();
  await new Promise((r) => setTimeout(r, 900)); // let the room empty before the next mode
}

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} passed across ${live.length} modes — ${live.join(', ')}`);
process.exit(pass === results.length ? 0 : 1);
