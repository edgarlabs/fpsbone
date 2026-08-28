// Headless test client. Connects, walks a slow circle, and periodically jumps and
// fires — so netcode can be exercised with only one browser window open.
//
//   node server/bot.js                       one bot named "bot", default mode
//   node server/bot.js dummy 3               three bots: dummy1, dummy2, dummy3
//   node server/bot.js --mode tdm --fill 9   nine bots in team deathmatch
//
// The mode matters: every mode is a separate Room, so a bot that does not ask for
// yours joins a different match and you will never see it. Bots also spread
// themselves across the mode's loadout, which is the cheapest way to see several
// weapons firing at once.

import WebSocket from 'ws';
import * as C from '../shared/constants.js';
import { MSG, INPUT_REDUNDANCY, encode, decode } from '../shared/protocol.js';
import { MODES, DEFAULT_MODE, isMode } from '../shared/modes.js';
import { indexOf } from '../shared/weapons.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
/** Positional args, so the old `bot.js dummy 3` form still works. */
const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));

const baseName = flag('name', positional[0] ?? 'bot');
const count = Math.max(1, Math.min(16, Number(flag('fill', positional[1])) || 1));
const modeId = flag('mode', DEFAULT_MODE);

if (!isMode(modeId)) {
  console.error(`unknown mode "${modeId}" — one of: ${Object.keys(MODES).join(', ')}`);
  process.exit(1);
}
const loadout = MODES[modeId].loadout.map(indexOf);

function spawnBot(name, phase, wep) {
  const ws = new WebSocket(`ws://localhost:${C.NET_PORT}`);
  let seq = 0;
  let yaw = phase;
  let ticks = 0;
  let timer = null;
  const pending = [];

  ws.on('open', () => ws.send(encode({ t: MSG.HELLO, name, cosmetics: {}, mode: modeId })));

  ws.on('message', (raw) => {
    const m = decode(raw);
    if (m?.t !== MSG.WELCOME || timer) return;
    console.log(`${name} connected as #${m.id} in ${m.mode}`);

    // One input per simulation tick, batched out at the snapshot rate — the same
    // cadence the real client uses.
    timer = setInterval(() => {
      for (let i = 0; i < C.TICKS_PER_SNAPSHOT; i++) {
        ticks++;
        yaw += 0.018;
        let buttons = 0;
        if (ticks % 150 === 0) buttons |= C.BTN_JUMP;
        if (ticks % 40 < 3) buttons |= C.BTN_FIRE;
        // Reload occasionally, or a bot with a 5-round magazine goes quiet for the
        // rest of the session once it has emptied it.
        if (ticks % 240 < 4) buttons |= C.BTN_RELOAD;
        pending.push({ seq: ++seq, moveX: 0, moveZ: 1, yaw, pitch: 0, buttons, wep });
      }
      while (pending.length > INPUT_REDUNDANCY + C.TICKS_PER_SNAPSHOT) pending.shift();
      if (ws.readyState === ws.OPEN) ws.send(encode({ t: MSG.INPUT, inputs: pending.slice() }));
    }, 1000 / C.SNAPSHOT_HZ);
  });

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  ws.on('close', stop);
  ws.on('error', (e) => {
    stop();
    console.error(`${name}: ${e.message}`);
  });
}

console.log(`spawning ${count} bot(s) into ${modeId} — loadout [${MODES[modeId].loadout.join(', ')}]`);
for (let i = 0; i < count; i++) {
  spawnBot(
    count === 1 ? baseName : `${baseName}${i + 1}`,
    (i * Math.PI * 2) / count,
    loadout[i % loadout.length],
  );
}
