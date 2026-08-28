// Randomised soak test on the shared movement function, looking for any tick that
// breaks the two invariants a player can feel: you never rise more than STEP_HEIGHT
// without jumping, and you never end a tick overlapping solid geometry.
//
//   npm run fuzz
//
// This drives stepPlayer at full float precision, so it deliberately does NOT
// exercise the wire round-trip — and that is worth knowing, because the wall-climb
// bug lived there and this file came back clean through 1.6M ticks while it was
// live. A clean run here narrows the search to the client/server seam rather than
// clearing the game. verify.mjs Part C covers that seam; keep both.

import * as C from './shared/constants.js';
import { WORLD_BOXES, SPAWNS, WALL_H } from './shared/map.js';
import { overlapsBox } from './shared/collide.js';
import { createPlayerState, stepPlayer, halfOf } from './shared/movement.js';

/** Sized from the live state, not from the standing constant. Once the driver below
 *  starts pressing crouch that distinction is the whole test: a fixed 0.9
 *  half-height reports every ducked body as embedded in the floor it is standing on. */
const inside = (s) => WORLD_BOXES.filter((b) => overlapsBox(s.x, s.y, s.z, ...halfOf(s), b));

// Deterministic PRNG (mulberry32) so any hit is reproducible.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TRIALS = 4000;
const TICKS = 400;

const findings = { teleport: [], embedded: [], airborne: [], crouch: [] };

for (let trial = 0; trial < TRIALS; trial++) {
  const rand = rng(trial * 7919 + 13);
  const spawn = SPAWNS[Math.floor(rand() * SPAWNS.length)];
  const s = createPlayerState({ ...spawn });

  let yaw = rand() * Math.PI * 2;
  let moveX = 0;
  let moveZ = 0;
  let jump = false;
  let crouch = false;
  let walk = false;
  let sprint = false;

  for (let i = 0; i < TICKS; i++) {
    // Change intent occasionally rather than every tick, so the player actually
    // travels and presses against things instead of jittering in place.
    if (rand() < 0.08) {
      moveX = Math.round(rand() * 2 - 1);
      moveZ = Math.round(rand() * 2 - 1);
    }
    if (rand() < 0.05) jump = rand() < 0.5;
    // Crouch and walk flip on a slower schedule than the movement keys, so the
    // crouch blend actually reaches both ends and holds there. The states worth
    // finding are mid-blend and pressed against something, and a button held for a
    // single tick never gets to either.
    if (rand() < 0.03) crouch = rand() < 0.5;
    if (rand() < 0.03) walk = rand() < 0.5;
    // Sprint rides the same slow schedule for the same reason, plus one of its own: the
    // stamina bar is 4s to drain and 6s to refill, so a flag that flipped every tick
    // would hover near full and never reach the exhausted-and-locked-out end at all.
    if (rand() < 0.03) sprint = rand() < 0.5;
    yaw += (rand() - 0.5) * 0.35;

    let buttons = 0;
    if (jump) buttons |= C.BTN_JUMP;
    if (crouch) buttons |= C.BTN_CROUCH;
    if (walk) buttons |= C.BTN_WALK;
    if (sprint) buttons |= C.BTN_SPRINT;

    const beforeY = s.y;
    const wasGrounded = s.grounded;
    stepPlayer(s, { moveX, moveZ, yaw, pitch: 0, buttons, wep: 0 }, C.TICK_DT, WORLD_BOXES);

    const rise = s.y - beforeY;
    // A grounded, non-jumping player may rise at most STEP_HEIGHT in one tick.
    // Standing up raises the body too, but at CROUCH_RATE that is 0.04u a tick —
    // two orders inside this bound, so no allowance is needed for it.
    if (!jump && wasGrounded && rise > C.STEP_HEIGHT + 1e-3) {
      findings.teleport.push({ trial, tick: i, rise, from: beforeY, to: s.y, x: s.x, z: s.z, moveX, moveZ });
    }
    const emb = inside(s);
    if (emb.length) {
      findings.embedded.push({ trial, tick: i, boxes: emb.map((b) => `${b.c}(${b.x},${b.y},${b.z})`), x: s.x, y: s.y, z: s.z });
    }
    // Nobody should ever get on top of the perimeter. Taken from the map's own wall
    // height rather than typed, because this was a literal 8 chosen when the walls were
    // 7 — and when the arena grew and they became 9, an 8 stopped meaning "above the
    // walls" and started meaning "a metre below them", which is a place you can legally
    // stand. The highest surface a player can actually reach is 4.0, so there is plenty
    // of daylight between honest play and this alarm either way.
    if (s.y > WALL_H) {
      findings.airborne.push({ trial, tick: i, y: s.y, x: s.x, z: s.z });
    }
    // The blend is a 0..1 lerp factor that sizes the body. Out of range means a
    // half-height outside the two constants, which is a hitbox nothing agreed to.
    if (!(s.crouch >= 0 && s.crouch <= 1)) {
      findings.crouch.push({ trial, tick: i, crouch: s.crouch });
    }
    if (findings.teleport.length + findings.embedded.length > 40) break;
  }
  if (findings.teleport.length + findings.embedded.length > 40) break;
}

const show = (name, arr) => {
  console.log(`\n=== ${name}: ${arr.length} ===`);
  for (const f of arr.slice(0, 12)) console.log('  ' + JSON.stringify(f));
};

console.log(`fuzzed ${TRIALS} trials x ${TICKS} ticks from ${SPAWNS.length} spawns`);
show('single-tick rise over STEP_HEIGHT (no jump)', findings.teleport);
show('body embedded in geometry', findings.embedded);
show('above the walls (y > ' + WALL_H + ')', findings.airborne);
show('crouch blend outside 0..1', findings.crouch);

const total =
  findings.teleport.length +
  findings.embedded.length +
  findings.airborne.length +
  findings.crouch.length;
console.log(`\n${total === 0 ? 'CLEAN — no violations found' : `${total} violation(s)`}`);
