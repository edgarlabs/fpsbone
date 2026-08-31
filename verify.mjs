// Headless verification of the combat chain and a live two-client session.
//
//   npm run verify        (needs the server up — `npm run dev` or `npm run server`)
//
// Part A drives a Room directly: two players pinned on a verified-clear firing
// line, one shooting the other until death, then past the respawn timer. This
// checks the damage → death → respawn chain.
// Part B repeats the duel once per weapon in the deathmatch loadout, checking that
// each weapon's own damage, fire rate and range are what shared/weapons.js says —
// and that a mode refuses a weapon outside its loadout. It closes on the four systems
// that decide whether aim is worth anything: the head/body/legs boxes, the distance
// curve, the cone that opens up when you move, and the rewind that lets a shot at a
// moving target land where the shooter actually saw them.
// Part C walks into a wall, quantises the result as the wire does, and replays a
// tick the way the client does — the seam that put players on top of walls.
// Part D covers crouch and what right-click means: a body whose height changes has
// to change it in the collider, the hitbox and the wire together, and right-click
// has to be a property of the weapon rather than a mode of the player.
// Part E checks the keybind rules — that no key ends up doing two jobs, that the
// keys the browser owns are refused, and that saving a rebind cannot undo it.
// Part F runs a room of nothing but bots for forty-five seconds: they have to move,
// shoot when given a clear look at somebody, hit each other, stay out of the geometry,
// and never leak the fact that they are bots onto the wire. It also audits what a bot is
// allowed to KNOW — "it barely miss and it even know you are coming its like in any fps
// game we call them cheaters wallhacking" — by scoring every bot's aim against what it
// could honestly have perceived, with a null model to say how much of that is just the
// shape of the arena.
// Part G is pure geometry: that the hands land ON the weapon from outside and that a corpse
// and the weapon it dropped both land ON the floor, and — lifted out of viewmodel.js, which
// cannot be imported — that the recoil shoves back rather than only up, that the inspect
// frames the weapon without putting it through the camera, and that the bolt reaches the
// rear at the same instant in both views and in the sound.
// Part H is the career ladder: that a rank means the same thing on both sides of the wire,
// that a kill credits exactly one account, that a bot wears a rank without keeping a
// ledger, and that a career file truncated by a crash mid-write costs the careers in it
// rather than stopping the server from booting.
// Part J is the rank where a player sees it: the plate over the head and the readout in
// the corner. render.js and hud.js cannot be imported — three.js and `document` — so both
// are lifted out as text and run, the same way Part D lifts the bob.
// Part K is the per-category badges: the table both ends read, the kill that becomes a count
// inside the Room, the two shapes ranks.json is allowed to have, and the diff the client
// shows a card from — plus the one line that stops a dead player turning their head.
// Part M is the lobby: ten slots a room, bots filling exactly what the players leave
// empty, the occupancy that greys a full lobby out on the menu, and the two sides of a
// team mode — who spawns where, who may shoot whom, and whose number goes up.
// Part L is the killmark: the six-leg ladder in shared/spree.js, the four seconds main.js
// measures it over, and the class string hud.js turns that into. The only counter in the
// game with no server copy, so it is the only one where the suite IS the second opinion.
// Part Q is FOUNDRY 64's environment contract: one public map name, readable zones,
// authoritative overhead collision, procedural assets and batched static geometry. It
// protects the visual overhaul from turning back into a grey box or into phantom cover.
// Part R is operator and cosmetic identity: two faction-readable bodies, a fixed approved
// finish catalog, authoritative sanitizing and a static roster wire that never bloats the
// movement snapshot or lets a cosmetic become a gameplay stat.
// Part S is account ownership: a fresh server challenge, a P-256 proof, a public-key-derived
// storage id, one-way migration from the old browser id, and a recovery code the user can
// carry without adding a password database or wallet dependency.
// Part T is the inventory and creator pipeline: issued versus granted ownership, a second
// admission check, one-use signed account actions, bounded palette-only submissions and a
// review surface that stays locked until its private operator token is configured.
// Part V is Arena's round contract: two honest floor sites, a continuous server-measured
// use hold, one life, plant/defuse/fuse/elimination outcomes, bot participation and one
// match settlement after the seventh round.
//
// Part I opens two real sockets and confirms each client sees the other — and each
// other's bots, since the room is shared and the count is a live request.
//
// Worth running after any change to server/hitscan.js, server/room.js or
// shared/weapons.js — those three between them decide every number a player feels.
// Part G is the one to run after client/src/rig.js or client/src/viewmodel.js.
// Part K is the one to run after shared/badges.js or server/ranks.js — a badge table and a
// career file are the two things here that outlive the process.

import { WebSocket } from 'ws';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as C from './shared/constants.js';
import { createSocialService } from './server/social.js';
import { ARENA, MAP, OBJECTIVE_SITES, SPAWNS, TEAM_SPAWNS, WORLD_BOXES } from './shared/map.js';
import { ENVIRONMENT_ID, ZONE_LABELS } from './client/src/environment.js';
import { rayWorld, overlapsBox, depenetrate, EPS } from './shared/collide.js';
import {
  createPlayerState, stepPlayer, sanitizeInput, EMPTY_INPUT, halfOf, halfHAt, eyeY, aimDir,
  chestY, headBoxOf, legsTopOf,
} from './shared/movement.js';
import { MODES, MODE_IDS, TEAM_NAMES, DEFAULT_MODE } from './shared/modes.js';
import {
  REGIONS, REGION_IDS, HERE, isRegion, fastest, parseRegions, regionsFromEnv, wsOrigin, pingGrade,
  publicOrigin,
} from './shared/regions.js';
import { socketFor } from './client/src/regions.js';
import { createNet } from './client/src/net.js';
import { TIERS, MAX_TIER, rankOf, toNextRank } from './shared/ranks.js';
import {
  XP_TIERS, XP_RULES, matchXp, rankOfXp, toNextRankXp,
} from './shared/progression.js';
import {
  STARTER_CREDITS, CREDIT_RULES, MARKET_ITEMS, matchCredits, publicMarket,
} from './shared/economy.js';
import {
  BADGES, TRACK_KEYS, SPECIAL_KEYS, TIER_NAMES, MAX_BADGE_TIER, MAX_LEVEL, MAX_STEP,
  labelOf, tierName, tierOf, badgeOf, levelOf, stepOf, toNextStep, tracksFor, publicTiers,
} from './shared/badges.js';
import {
  SPREE_LEGS, SPREE_MS, SPREE_NAMES, legsOf, spreeName, wingsOf,
} from './shared/spree.js';
import {
  WEAPON_IDS, WEAPONS, SWITCH_MS, switchMsOf, JAM_CLEAR_MS, jamChanceOf, zoomStepsOf,
  cycleMsOf, heftOf, SCOPE_SETTLE_MS,
  HIT_ZONE, HIT_ZONE_MUL, falloffMul, shotDamage, spreadMul, holdBandOf,
  hasHeavy, idAt, indexOf, isAuto, isUtil, pelletsOf, rollLoadout, scopes, shotStats, slotOf, slotPick, weaponAt,
} from './shared/weapons.js';
import {
  RIG, ARM_UPPER, ARM_FORE, ARM_REACH, rigExtent, corpseDrop, solveHand, armFK, rotateXYZ,
  HOLDS, holdOf, ELBOW_HINT, IDLE_HAND, READY_HAND, JAM_HAND, CYCLE_HAND, HEFT,
  DEAD_HAND, DEAD_GUN, deadGunZ, thrown, HITBOX_HALF_W,
} from './client/src/rig.js';
import {
  ACTION_IDS, DEFAULT_BINDS, RISKY,
  keyLabel, normalizeBinds, rebind, refuseReason, twinOf,
} from './client/src/binds.js';
import { PROJECTILES, createProjectile, stepProjectile } from './shared/projectile.js';
import { createInterpolator } from './client/src/interp.js';
import { resolveShot, rewind, rewindTimeFor } from './server/hitscan.js';
import { Room, r3 } from './server/room.js';
// The host, not just a Room: the backfill rule and the lobby pushes live in there, and a
// Room on its own knows nothing about how many humans are connected to it.
import { createHost } from './server/index.js';
import { deviceAccountId, proofText, verifyDeviceIdentity } from './server/identity.js';
import { createAccountGateway } from './server/account-api.js';
import { accountOrigin } from './client/src/account-client.js';
import { MSG, REJECT, encode, decode } from './shared/protocol.js';
import { EV } from './shared/protocol.js';
import {
  DEFAULT_FINISH, FINISHES, FINISH_IDS, ISSUED_FINISH_IDS, finishOf, sanitizeCosmetics,
  sanitizeInventory, sanitizeOwnedCosmetics,
} from './shared/cosmetics.js';
import { OPERATORS, OPERATOR_IDS, operatorIdFor, operatorFor } from './shared/operators.js';

const pass = [];
const fail = [];
const ok = (cond, label, detail = '') => {
  (cond ? pass : fail).push(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const evName = (e) => Object.keys(EV).find((k) => EV[k] === e) ?? e;

const STEP_MS = 1000 / C.TICK_HZ;
const DM = MODES[DEFAULT_MODE];

// ───────────────────────────────────────────────── Part A: combat chain
console.log('=== Part A — combat chain (in-process Room) ===\n');

// Find a spot where two players GAP apart on x have clear line of sight and
// neither is inside geometry. Searched rather than hardcoded so this stays valid
// if the arena is edited. MELEE_GAP is checked in the same pass because the knife
// tests reuse this line at knife range.
const GAP = 8;
const MELEE_GAP = 1.6;
const H = [C.PLAYER_HALF_W, C.PLAYER_HALF_H, C.PLAYER_HALF_W];
const clearAt = (x, z) => !WORLD_BOXES.some((b) => overlapsBox(x, C.PLAYER_HALF_H, z, ...H, b));

let line = null;
// Bounded by the arena rather than by a pair of literals. The comment above has always
// claimed this search survives the arena being edited, and with a hardcoded ±20 it did
// not — it searched the middle third of a 64u map and would have reported "no clear
// firing line in arena" while sitting inside the one structure in the centre of it.
const R = ARENA / 2 - 1;
for (let z = -R; z <= R && !line; z += 1) {
  for (let x = -R; x + GAP <= R; x += 1) {
    const ey = C.PLAYER_HALF_H + C.EYE_OFFSET;
    if (!clearAt(x, z) || !clearAt(x + GAP, z) || !clearAt(x + MELEE_GAP, z)) continue;
    // Aim +x. Nothing may block before the target.
    if (rayWorld(x, ey, z, 1, 0, 0, WORLD_BOXES, GAP + 1) <= GAP) continue;
    line = { x, z };
    break;
  }
}
ok(!!line, 'found a clear firing line', line ? `shooter at x=${line.x} z=${line.z}, target ${GAP}u east` : 'none in arena');
if (!line) {
  console.log(fail.join('\n'));
  process.exit(1);
}

const YAW_EAST = -Math.PI / 2; // forward = (-sin yaw, 0, -cos yaw) = (1,0,0)

// ── the map itself
//
// This block exists because the arena was rebuilt by hand and two of its twelve spawn
// points landed inside a crate. Nothing caught it: `pickSpawn` happily returns an
// embedded spawn, `depenetrate` shoves the body out on the next tick, and the only
// symptom is players occasionally appearing a metre from where they should — which is
// indistinguishable from ordinary netcode slop and so would never have been reported as
// a map bug. Geometry is data, and data this load-bearing gets asserted.
{
  const JUMP_H = (C.JUMP_VEL * C.JUMP_VEL) / (2 * C.GRAVITY);
  const solid = WORLD_BOXES.filter((b) => b.c !== 'floor');
  const overlap = (a, b) =>
    Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 1e-9 &&
    Math.abs(a.y - b.y) < (a.h + b.h) / 2 - 1e-9 &&
    Math.abs(a.z - b.z) < (a.d + b.d) / 2 - 1e-9;

  const embedded = SPAWNS.filter((s) => !clearAt(s.x, s.z));
  ok(embedded.length === 0, 'every spawn point is clear of geometry',
     embedded.length ? embedded.map((s) => `(${s.x},${s.z})`).join(' ') : `${SPAWNS.length} spawns`);

  // A crate merged into a staircase makes the steps it covers unclimbable, and the
  // staircase still *looks* fine — you simply stop halfway up for no visible reason.
  const clash = [];
  for (const s of WORLD_BOXES.filter((b) => b.c === 'stair')) {
    for (const o of solid) if (o.c !== 'stair' && overlap(s, o)) clash.push(`${o.c}(${o.x},${o.z})`);
  }
  ok(clash.length === 0, 'no cover is merged into a staircase', clash.join(' ') || 'stairs are clear');

  // Every solid has a partner at (-x, -z). The map is authored in rotational pairs so
  // that neither half is better than the other; one stray push() breaks that silently,
  // and it is the property the team modes in M7 will be relying on.
  const lone = solid.filter((a) => !solid.some((b) =>
    Math.abs(b.x + a.x) < 1e-9 && Math.abs(b.z + a.z) < 1e-9 &&
    Math.abs(b.y - a.y) < 1e-9 && b.w === a.w && b.h === a.h && b.d === a.d));
  ok(lone.length === 0, 'the arena is symmetric under a 180° rotation',
     lone.length ? lone.map((b) => `${b.c}(${b.x},${b.z})`).join(' ') : `${solid.length} solids paired`);

  // Nothing may be a step onto a wall. A player who reaches the top of a 4.0u divider
  // overlooks the whole map from a 1.2u-wide perch that is awkward to shoot back at, and
  // they get there by jumping off a crate that was placed a little too close and a little
  // too tall.
  //
  // This check used to compare the rise against JUMP_H — the arc's apex — and it passed
  // on a map that had two of those crates in it. It was wrong by most of a metre, because
  // crouching in mid-air lifts the FEET: crouchStep() holds the head still while the body
  // shrinks, so the feet come up by twice the shrink and a ducking player lands on
  // apex + 0.70. That is the CS2 crouch-jump, it is deliberate, and it is what decides
  // whether a crate is a step. Two numbers replace the one:
  //
  //   REACH   the tallest ledge a jump can mount at all. Simulating shared/movement.js
  //           measures 2.17u against the 2.24u computed here — the formula is the
  //           conservative one, which is the direction to be wrong in.
  //   runOut  a rise is only half the question. Being 2.0u up is no use two metres
  //           sideways of the wall, so this asks how far you can travel while your ducked
  //           feet are still above the rise. Solving rise - LIFT = vt - gt²/2 for the later
  //           root gives the airtime left at that height; MOVE_SPEED carries you for it.
  //   travel  and what has to beat that is not the clearance between the two boxes. A
  //           player is 0.8u wide, and both ends of the jump allow half of that in
  //           overhang: they leave from a centre that is already past the crate's edge and
  //           land on a centre that has only just crossed the wall's. So 2·PLAYER_HALF_W
  //           comes off each axis, which turns the 2.42u gap at (-18.5,-25) into a 1.30u
  //           jump. Measuring the clearance is exactly the mistake that let the shipped
  //           ladder through a second time: at the old jump that pair reads 1.90u of
  //           clearance against a 1.75u run-out and passes, while the 1.10u a body
  //           actually crosses is well inside it.
  const LIFT = 2 * (C.PLAYER_HALF_H - C.CROUCH_HALF_H);
  const REACH = JUMP_H + LIFT;
  // Sprint speed, not run speed. This is what makes SPRINT_SPEED_MUL machine-enforced:
  // the cap is a cap on the projection onto the wish dir, so `if (add > 0)` in
  // movement.js means an airborne sprinter is neither accelerated nor slowed, and carries
  // the whole arc at sprint speed. Measured against this very audit:
  //
  //     1.00x  4.20 cap  +0.350u tightest   0 ladders   (before sprint existed)
  //     1.15x  4.83 cap  +0.088u tightest   0 ladders   <- shipped
  //     1.20x  5.04 cap   0.000u tightest   0 ladders   the exact edge
  //     1.40x  5.88 cap  -0.350u tightest   6 ladders
  //
  // All six failures at 1.40 are one relationship mirrored across the map's rotational
  // pairs: wallB@1.8 -> wallA@4.0, a 2.20u rise where the body crosses 2.100u against a
  // 2.450u sprint-jump. Raising the constant past 1.20 therefore turns this assert red
  // instead of shipping a silent boost, which is the entire reason it is scaled here.
  const HORIZ = C.MOVE_SPEED * C.SPRINT_SPEED_MUL;
  const runOut = (rise) => {
    const need = rise - LIFT;
    if (need <= 0) return (HORIZ * 2 * C.JUMP_VEL) / C.GRAVITY; // whole airtime
    const disc = C.JUMP_VEL * C.JUMP_VEL - 2 * C.GRAVITY * need;
    return disc <= 0 ? 0 : (HORIZ * (C.JUMP_VEL + Math.sqrt(disc))) / C.GRAVITY;
  };
  const tops = solid.map((b) => ({ ...b, top: b.y + b.h / 2 }));
  const boosts = [];
  let tightest = Infinity;
  for (const hi of tops) {
    // Freestanding walls only, and both halves of that matter. `top >= 3.3` leaves out the
    // 2.8 plateau and the 3.0 lane perch, and `h >= 2.5` leaves out the 1u lip on the
    // perch and the 1u cover on the plateau, whose tops are above 3.3. Those are platforms
    // and cover on a platform: standing on them is fine, they can be shot at from
    // everywhere, and climbing onto cover is the thing the higher jump exists for. A 1.2u
    // divider top is none of those things.
    if (hi.top < 3.3 || hi.h > 5 || hi.h < 2.5) continue;
    for (const lo of tops) {
      if (lo === hi || lo.top >= hi.top) continue;
      const rise = hi.top - lo.top;
      if (rise > REACH) continue; // out of reach from any distance, so the gap is moot
      const gx = Math.abs(hi.x - lo.x) - (hi.w + lo.w) / 2 - 2 * C.PLAYER_HALF_W;
      const gz = Math.abs(hi.z - lo.z) - (hi.d + lo.d) / 2 - 2 * C.PLAYER_HALF_W;
      const margin = Math.hypot(Math.max(0, gx), Math.max(0, gz)) - runOut(rise);
      tightest = Math.min(tightest, margin);
      if (margin <= 0) {
        boosts.push(`${lo.c}@${lo.top}(${lo.x},${lo.z}) → ${hi.c}@${hi.top}(${hi.x},${hi.z}) rise ${rise.toFixed(2)}u`);
      }
    }
  }
  ok(boosts.length === 0, `no solid is a step onto a wall for a ${REACH.toFixed(2)}u ducked jump`,
     boosts.slice(0, 3).join(' ') ||
     `tightest ${Number.isFinite(tightest) ? `${tightest.toFixed(2)}u clear` : 'nothing in reach'}`);

  // The plateau's whole reason to exist: its top must see over the dividers that a
  // player on the floor cannot. If either height drifts, mid stops being worth taking
  // and nothing else in the map announces that it has stopped mattering.
  const ey = C.PLAYER_HALF_H + C.EYE_OFFSET;
  const fromFloor = rayWorld(-8, ey, 0, -1, 0, 0, WORLD_BOXES, 200);
  const fromMid = rayWorld(-6, 2.8 + ey, 0, -1, 0, 0, WORLD_BOXES, 200);
  ok(fromFloor < 8 && fromMid > 20, 'the middle platform sees over the walls that screen the floor',
     `floor eye ${fromFloor.toFixed(1)}u, platform eye ${fromMid.toFixed(1)}u`);

  // Long sightlines are the point of the lanes; a long sightline across the whole
  // arena is not, and the two are easy to confuse when placing walls by hand. The
  // first build of this map had a clear 62u shot corner to corner behind every piece
  // of cover in it, which made the lanes pointless.
  const dirs = Array.from({ length: 8 }, (_, i) => [Math.sin(i * Math.PI / 4), Math.cos(i * Math.PI / 4)]);
  let longest = 0;
  for (let x = -R; x <= R; x += 1) {
    for (let z = -R; z <= R; z += 1) {
      if (!clearAt(x, z)) continue;
      for (const [dx, dz] of dirs) longest = Math.max(longest, rayWorld(x, ey, z, dx, 0, dz, WORLD_BOXES, 200));
    }
  }
  ok(longest > 30 && longest < ARENA * 0.8, 'the longest sightline is a lane, not the whole arena',
     `${longest.toFixed(1)}u (want 30 … ${(ARENA * 0.8).toFixed(0)})`);
}

/**
 * Pitch from the pinned shooter's eye to world height `y` on a target `gap` away.
 *
 * Zones turned "where did you aim" into a question these tests have to answer. Both
 * bodies are pinned at the same feet height, so `pitch: 0` — the harness default, and
 * what every test here used before there were zones — fires level from an eye at 1.52
 * into a head box that starts at 1.45: a 4x one-tap, every time. That is correct game
 * behaviour and the reason a CS2 player holds their crosshair at head height, but a test
 * measuring what one hit of a weapon's own `dmg` is worth has to say BODY or it measures
 * the multiplier instead.
 */
const EYE_Y = C.PLAYER_HALF_H + C.EYE_OFFSET;
const pitchTo = (y, gap = GAP) => Math.atan2(y - EYE_Y, gap);
/** The pinned target, in the shape the geometry helpers want. */
const PINNED = { x: 0, y: C.PLAYER_HALF_H, z: 0, crouch: 0 };
/** Skull centre, chest, and mid-shin of a standing target — one aim point per zone. */
const AIM_HEAD = headBoxOf(PINNED).cy;
const AIM_BODY = chestY(PINNED);
const AIM_LEGS = legsTopOf(PINNED) * 0.5;

/**
 * Two players on the cleared line, the west one holding fire for `ms`.
 *
 * The weapon is drawn *before* the measured window: switching costs `switchMsOf(wep)`
 * during which firing is blocked, and folding that into the window would make
 * every fire-rate figure wrong by a different amount per weapon.
 *
 * Two mechanics are pinned off unless asked for, because both are new and both would
 * otherwise corrupt every figure here: `jams` leaves the stoppage roll live (default is
 * never), and `pin()` expires spawn protection on both players every tick.
 */
function duel({
  modeId = DEFAULT_MODE, wep = 'rifle', gap = GAP, ms = 2000, jams = false,
  // Where the shooter is looking, and where the pair stand. `pitch: 0` is level, which
  // is a headshot — see `pitchTo`. `at` moves the whole duel onto a different verified-
  // clear spot, which is what the distance-curve tests need: the 8u line is inside every
  // weapon's full-damage band, so nothing measured on it can see a falloff at all.
  pitch = 0, at = null,
  // Whether the glass is up, defaulting to UP for any weapon that has any — because the
  // shot these tests measure is the shot a player would actually take, and for a sniper
  // that is a scoped one.
  //
  // Load-bearing, not tidiness. The scope is simulation state now (`sc` on the input,
  // `scope`/`scopeMs` on the body — see shared/movement.js), and an input that omits it
  // asserts a shot from the HIP, which `spreadMul` widens forty-fold. Every sniper figure
  // in this file was measured through settled glass; without this line they would be
  // re-measured at random through a 0.032rad cone, and a suite that flakes is a suite
  // nobody reads. The warm-up below runs an order of magnitude longer than the settle
  // window, so the cone is fully closed before the first measured tick.
  //
  // Pass 0 to take the hip shot on purpose.
  sc = null,
} = {}) {
  const home = at ?? line;
  const room = new Room(modeId);
  // Stoppages off unless a test asks for them. A jam is a 1-in-100 event that costs
  // 700ms of not firing, so leaving it live would make every fire-rate figure below
  // fail at random a few runs in a hundred — and a suite that cries wolf is a suite
  // nobody reads. The jam's own behaviour is tested with this pinned the other way.
  room.rand = jams ? () => 0 : () => 1;
  const idA = room.add('shooter', {});
  const idB = room.add('target', {});
  const A = room.players.get(idA);
  const B = room.players.get(idB);
  room.drainEvents(); // discard the two join spawns

  const wi = indexOf(wep);
  // Whether the trigger may be held. Read from the weapon rather than passed in, so
  // that a weapon changing its mind about being automatic changes these tests with it.
  const auto = isAuto(wep);
  // Deathmatch deals a random hand, and every test here needs to name the weapon
  // under examination. Granting the shooter the mode's whole pool is the narrowest
  // way to opt out of the deal: `applyWeapon` still gates the switch, it just gates
  // it against the pool the deal would otherwise have drawn from. Modes that do not
  // deal already grant exactly this, so nothing changes for them — including the
  // whitelist test below, which still gets a real refusal.
  A.allowed = room.allowed;
  const pin = () => {
    A.x = home.x; A.y = C.PLAYER_HALF_H; A.z = home.z; A.vx = A.vy = A.vz = 0; A.grounded = true;
    // Spawn protection expired, every tick, on both. A fresh spawn is invulnerable for
    // SPAWN_PROTECT_MS, which is longer than most windows measured here — with the
    // shield up, `pistol does 34 per hit` reports zero hits and blames the pistol.
    // Cleared in `pin` rather than once at the top because respawning re-arms it, and
    // several tests below kill the target and keep shooting.
    A.protectedUntil = 0;
    B.protectedUntil = 0;
    if (B.alive) {
      B.x = home.x + gap; B.y = C.PLAYER_HALF_H; B.z = home.z;
      B.vx = B.vy = B.vz = 0; B.grounded = true;
    }
  };

  // Read off the weapon rather than defaulted to a number, so a weapon that gains or
  // loses a scope changes these tests with it instead of silently measuring the wrong cone.
  const glass = sc ?? (scopes(wep) ? 1 : 0);

  let seq = 0;
  const send = (buttons) =>
    room.queueInput(idA, [{
      seq: ++seq, moveX: 0, moveZ: 0, yaw: YAW_EAST, pitch, buttons, wep: wi, sc: glass,
    }]);

  /** Step `n` ticks holding `buttons`, collecting events and B's health. */
  const events = [];
  const hpTrace = [];
  const run = (n, buttons) => {
    for (let i = 0; i < n; i++) {
      pin();
      send(buttons);
      room.step();
      events.push(...room.drainEvents());
      hpTrace.push(B.hp);
    }
  };

  /**
   * Step `n` ticks working the attack button the way this weapon has to be worked.
   *
   * Every firearm is held down and repeats at its own cadence; melee and throwables are
   * clicked because they fire on the button's falling-to-rising edge and a held button
   * is therefore exactly one action.
   *
   * `extra` is held throughout, for the tests that need right-click down at the same
   * time — releasing left-click between shots must not release that too.
   */
  const trigger = (n, extra = 0) => {
    for (let i = 0; i < n; i++) {
      pin();
      send(extra | (firesOn(i, auto) ? C.BTN_FIRE : 0));
      room.step();
      events.push(...room.drainEvents());
      hpTrace.push(B.hp);
    }
  };

  // The weapon's OWN deploy time, not the global fallback. Deploy times are per-weapon
  // now and the slowest is nearly double the fallback, so warming up for 550ms would
  // leave the sniper and the machine gun still gated when the measured window opens —
  // and a fire-rate test that starts inside the switch clamp measures the clamp.
  const warm = Math.ceil(switchMsOf(wep) / STEP_MS) + 4;
  run(warm, 0);
  events.length = 0;
  hpTrace.length = 0;

  const ticks = Math.round(ms / STEP_MS);
  trigger(ticks);

  return { room, idA, idB, A, B, events, hpTrace, ticks, wi, pin, run, trigger, auto, glass };
}

/**
 * Whether the harness is asserting fire on tick `i`.
 *
 * Automatic weapons hold. The rest click as fast as a hand can be asked to: down on
 * even ticks, up on odd, one press every 33ms — far quicker than any weapon's own
 * interval, so what the fire-rate tests measure is still the clamp and not the
 * clicking. `shotsIn` walks this same pattern, which is what keeps the expectation
 * honest for intervals that are an odd number of ticks and so land on a tick where
 * the button is up.
 */
const firesOn = (i, auto) => auto || i % 2 === 0;

/**
 * Shots a weapon gets off in `ticks`, given that the fire clamp is checked against the
 * simulation clock and so quantises to whole ticks.
 *
 * Capped by the magazine, because for a fast enough weapon the magazine is the binding
 * constraint and not the cadence. The pistol is the case that proved it: at 110ms a 2s
 * window has room for 15 clicked rounds and the magazine holds 12, so an uncapped
 * expectation reports the pistol as firing too slowly when what it actually did was run
 * dry and start reloading. `mag: null` — the knife — has nothing to run out of.
 */
const shotsIn = (w, ticks) => {
  const iv = Math.ceil(w.intervalMs / STEP_MS);
  const cap = w.mag ?? Infinity;
  if (w.auto) return Math.min(cap, 1 + Math.floor((ticks - 1) / iv));
  let n = 0;
  let ready = 0;
  for (let i = 0; i < ticks; i++) {
    if (!firesOn(i, false) || i < ready) continue;
    n++;
    if (n >= cap) break;
    ready = i + iv;
  }
  return n;
};

const RIFLE = WEAPONS.rifle;
// Aimed at the CHEST. Everything below counts hits of exactly RIFLE.dmg, and level is a
// headshot now — four 25s or one 100, and the whole chain reads differently.
const d = duel({ wep: 'rifle', ms: 2000, pitch: pitchTo(AIM_BODY) });
const { room, idA, idB, A, B } = d;
const events = d.events;

const hits = events.filter((e) => e.e === EV.HIT);
const shots = events.filter((e) => e.e === EV.SHOT);
const kills = events.filter((e) => e.e === EV.KILL);

ok(shots.length === shotsIn(RIFLE, d.ticks), 'fire-rate clamp held',
   `${shots.length} shots in 2s at ${RIFLE.intervalMs}ms (expected ${shotsIn(RIFLE, d.ticks)}); BTN_FIRE asserted on all ${d.ticks} ticks`);
ok(hits.length === Math.ceil(C.MAX_HP / RIFLE.dmg), 'hits registered server-side',
   `${hits.length} hits × ${RIFLE.dmg} dmg`);
ok(kills.length === 1, 'exactly one kill', `${kills.length}`);
ok(kills[0]?.by === idA && kills[0]?.on === idB, 'kill attributed correctly',
   kills[0] ? `by #${kills[0].by} on #${kills[0].on}` : 'no kill event');
ok(kills[0]?.w === indexOf('rifle'), 'kill event names the weapon used', `w=${kills[0]?.w}`);
ok(B.alive === false && B.hp === 0, 'target is dead', `alive=${B.alive} hp=${B.hp}`);
ok(A.kills === 1 && B.deaths === 1, 'scoreboard updated', `A.kills=${A.kills} B.deaths=${B.deaths}`);

// HP must step down by exactly the weapon's damage, never skip or go negative.
const steps = [...new Set(d.hpTrace)];
const monotonic = d.hpTrace.every((v, i) => i === 0 || v <= d.hpTrace[i - 1]);
ok(monotonic, 'health only ever decreased', `trace: ${steps.join(' → ')}`);
ok(steps.every((v) => v >= 0 && v % RIFLE.dmg === 0), 'health landed on exact damage multiples', steps.join(','));

// Now run past the respawn timer. The delay is the mode's, not a global constant —
// deathmatch waits 5s, snowball 3s, and arena never respawns mid-round at all.
const before = events.length;
d.run(Math.ceil(DM.respawnMs / STEP_MS) + 10, 0);
const respawns = events.slice(before).filter((e) => e.e === EV.SPAWN && e.id === idB);
ok(respawns.length === 1, `target respawned once after ${DM.respawnMs}ms`, `${respawns.length} spawn events`);
ok(B.alive === true && B.hp === C.MAX_HP, 'respawned at full health', `alive=${B.alive} hp=${B.hp}`);
ok(typeof respawns[0]?.yaw === 'number', 'spawn event carries yaw for the client to orient with',
   respawns[0] ? `yaw=${respawns[0].yaw}` : 'missing');
ok(respawns[0] && clearAt(respawns[0].x, respawns[0].z), 'respawn point is clear of geometry',
   respawns[0] ? `(${respawns[0].x}, ${respawns[0].z})` : 'n/a');
ok(B.ammo.every((n, i) => n === (weaponAt(i).mag ?? 0)), 'respawn refilled every magazine', B.ammo.join(','));

console.log([...pass, ...fail].join('\n'));
console.log(`\nevent tally: ${JSON.stringify(
  events.reduce((acc, e) => ((acc[evName(e.e)] = (acc[evName(e.e)] ?? 0) + 1), acc), {}),
)}`);

// ─────────────────────────────────────────── Part B: per-weapon behaviour
console.log('\n=== Part B — weapons (in-process Room) ===\n');

const pB = [];
const fB = [];
const okB = (cond, label, detail = '') => {
  (cond ? pB : fB).push(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// Every hitscan weapon the default mode offers, at a range it should reach, aimed at the
// chest — these measure a weapon's own per-hit damage, and the zone multipliers get
// their own section at the end of this part.
for (const id of DM.loadout) {
  const w = WEAPONS[id];
  if (w.kind === 'projectile') {
    // Throws now fly, so this asserts the chain rather than its absence: a SHOT for
    // the throw, and a BURST when the thing lands or cooks off. Aimed at a target
    // 8 units away, which is inside a grenade's blast and a snowball's flight.
    const r = duel({ wep: id, ms: 2600 });
    const shots = r.events.filter((e) => e.e === EV.SHOT);
    const bursts = r.events.filter((e) => e.e === EV.BURST);
    okB(shots.length > 0, `${id} threw something`, `${shots.length} shots`);
    okB(bursts.length > 0, `${id} burst on impact or fuse`, `${bursts.length} bursts`);
    okB(
      bursts.every((b) => b.k === w.proj),
      `${id} bursts report their own kind`,
      bursts.map((b) => b.k).join(',') || 'none',
    );
    const hits = r.events.filter((e) => e.e === EV.HIT);
    if (isUtil(id)) {
      // Utility is the one kind of throw that must NOT take hit points off. Asserted
      // rather than skipped, because "flashbang" and "grenade" differ by exactly this:
      // a flash that does damage is a grenade with a bright animation, and it would
      // quietly become the best grenade in the game since it also blinds.
      okB(hits.length === 0, `${id} does no damage, which is what makes it utility`,
          `${hits.length} hits`);
    } else {
      // A throw that lands near a target must actually take hit points off, or the
      // weapon is decorative.
      okB(hits.length > 0, `${id} damaged the target`, `${hits.length} hits`);
    }
    continue;
  }

  const gap = w.kind === 'melee' ? MELEE_GAP : GAP;
  const r = duel({ wep: id, gap, ms: 2000, pitch: pitchTo(AIM_BODY, gap) });
  const s = r.events.filter((e) => e.e === EV.SHOT);
  const h = r.events.filter((e) => e.e === EV.HIT);
  const expect = shotsIn(w, r.ticks);

  okB(s.length === expect, `${id} fire rate is ${w.intervalMs}ms`, `${s.length} shots in 2s, expected ${expect}`);

  const pellets = pelletsOf(id);
  if (pellets > 1) {
    // A shotgun does not get the one-hit-per-round arithmetic, and that is the point of
    // it. Eight independent traces leave the same eye and their damage is tallied per
    // victim and applied once, so one blast is one HIT event carrying whatever fraction
    // of the eight connected — which is what makes the falloff geometry rather than a
    // curve, and is why a hitmarker means "the blast landed" instead of firing eight
    // times on the same tick.
    const dealt = C.MAX_HP - (h[0]?.hp ?? C.MAX_HP);
    // EV.HIT carries REMAINING health, clamped at zero, so a lethal blast reads as
    // exactly MAX_HP however many pellets actually connected. Seven of eight at 8u is
    // 119 damage, which is why this range cannot measure the tally exactly — what it
    // can prove is that the figure is one of the two shapes a tally may have, and never
    // more than the eight pellets could account for.
    const lethal = h[0]?.hp === 0;
    okB(h.length <= s.length, `${id} raises one hit per blast, not one per pellet`,
        `${h.length} hits from ${s.length} blasts`);
    okB(h.length > 0 && dealt >= w.dmg && dealt <= pellets * w.dmg
        && (lethal ? dealt === C.MAX_HP : dealt % w.dmg === 0),
        `${id} deals a whole number of its ${w.dmg}-damage pellets in one blast`,
        lethal
          ? `${dealt} — clamped at MAX_HP, so at least ${Math.ceil(dealt / w.dmg)} of ${pellets} connected`
          : `${dealt} = ${dealt / w.dmg} of ${pellets} pellets`);
    // The extra endpoints ride along on the same event so the client can draw the
    // spread. Without them it draws one tracer for a weapon that fired eight, and the
    // wall keeps a single hole.
    okB(s.every((e) => e.p?.length === pellets - 1), `${id} sends its other ${pellets - 1} pellets on the wire`,
        s.map((e) => e.p?.length ?? 0).join(','));
    okB(s.every((e) => (e.p ?? []).every((q) => q.length === 3 || q.length === 4)),
        'each one as a point, plus what it hit when it hit something',
        JSON.stringify(s[0]?.p?.slice(0, 3) ?? []));
  } else {
    okB(h.length === Math.ceil(C.MAX_HP / w.dmg), `${id} does ${w.dmg} per hit`,
        `${h.length} hits to kill, expected ${Math.ceil(C.MAX_HP / w.dmg)}`);
    // A single-projectile weapon must not be quietly sending a spread it does not have.
    okB(s.every((e) => e.p === undefined), `${id} sends no extra pellets`,
        `${s.filter((e) => e.p).length} shots carried a spread`);
  }
  okB(r.B.alive === false, `${id} killed the target`, `hp=${r.B.hp}`);
  okB(s.length <= (w.mag ?? Infinity), `${id} never fired more than a magazine without reloading`,
      `${s.length} shots, mag ${w.mag ?? '—'}`);
}

// Held-repeat versus edge-triggered attacks, asserted directly rather than inferred
// from a rate. Every firearm must keep shooting while left-click is held, but only at
// its own authoritative interval. Melee and throwables remain one action per press.
{
  const ticks = Math.round(2000 / STEP_MS);
  for (const id of WEAPON_IDS) {
    const w = WEAPONS[id];
    const r = duel({ modeId: id === 'snowball' ? 'snow' : DEFAULT_MODE, wep: id, ms: 0 });
    const mark = r.events.length;
    // Held down for the whole two seconds, which is the thing being tested.
    r.run(ticks, C.BTN_FIRE);
    const fired = r.events.slice(mark).filter((e) => e.e === EV.SHOT).length;

    if (w.auto) {
      okB(fired === shotsIn(w, ticks), `${id} is automatic: holding keeps it firing`,
          `${fired} shots while held, expected ${shotsIn(w, ticks)}`);
    } else {
      okB(fired === 1, `${id} is edge-triggered: holding fires exactly one`,
          `${fired} shots in ${Math.round(ticks * STEP_MS)}ms of held trigger`);
    }
  }
}

// Utility does its work to somebody else's screen, so "did it damage the target" is
// the wrong question and the loop above deliberately does not ask it. These are the
// right ones. Both effects are server-authoritative — the flash decides who was
// looking, and the cloud goes in the snapshot so that bots and the renderer agree
// about where you cannot be seen — which is precisely why they can be tested at all.
{
  const FL = PROJECTILES.flash;
  const r = duel({ wep: 'flash', ms: 2600 });
  const blinds = r.events.filter((e) => e.e === EV.BLIND);
  const bursts = r.events.filter((e) => e.e === EV.BURST);

  okB(blinds.length > 0, 'a flashbang blinds somebody', `${blinds.length} blind events`);
  okB(blinds.every((e) => e.by === r.idA), 'and credits whoever threw it',
      blinds.map((e) => `#${e.by}→#${e.on}`).join(' ') || 'none');
  // Below the server's own floor a blind is a flicker that reads as a rendering
  // glitch, so it is not worth an event — and one that did go out has to be worth
  // reacting to.
  okB(blinds.every((e) => e.ms >= 130 && e.ms <= FL.blindMs), 'for a duration inside its own range',
      `${blinds.map((e) => e.ms).join(',')}ms of ${FL.blindMs}ms max`);
  okB(bursts.every((b) => b.k === 'flash'), 'and the burst names itself, so the client picks the white one',
      bursts.map((b) => b.k).join(',') || 'none');
  okB(r.room.clouds.length === 0, 'a flashbang leaves no smoke behind', `${r.room.clouds.length} clouds`);
}

{
  const SM = PROJECTILES.smoke;
  const r = duel({ wep: 'smoke', ms: 2600 });
  okB(r.events.filter((e) => e.e === EV.BLIND).length === 0,
      'a smoke blinds nobody — it screens, which is not the same thing', 'no BLIND events');
  okB(r.room.clouds.length > 0, 'a smoke leaves a cloud on the room', `${r.room.clouds.length} clouds`);

  // On the wire, because a cloud only blocks sight if everyone agrees where it is: the
  // client draws it from here and server/ai.js tests bot sightlines against the same
  // list. A cloud that lived only on the server would be one the renderer never drew.
  const snap = r.room.snapshotBase();
  const c = snap.sm?.[0];
  okB(Array.isArray(snap.sm) && snap.sm.length === r.room.clouds.length,
      'and puts it in the snapshot rather than in a one-off event',
      `sm=${JSON.stringify(snap.sm)}`);
  okB(c && typeof c.i === 'number' && typeof c.r === 'number' && c.r > 0,
      'each cloud on the wire carries an id and a radius', c ? JSON.stringify(c) : 'none');
  okB(c && Math.abs(c.r - SM.cloudRadius) < 0.001, `the radius is the weapon's own ${SM.cloudRadius}u`,
      `r=${c?.r}`);

  // And it goes out. A cloud that never expires is permanent cover.
  r.room.expireClouds(r.room.now() + SM.cloudMs + 1);
  okB(r.room.clouds.length === 0, `the cloud clears after ${SM.cloudMs}ms`,
      `${r.room.clouds.length} left`);
}

// Snowball is not in the deathmatch loadout, so the loop above never reaches it —
// and it is the only weapon in snowball fight, which makes it the one weapon whose
// failure takes a whole mode down with it. Direct-hit only (blast 0), so this also
// covers the no-radius branch of the damage path.
{
  const SNOW = PROJECTILES.snowball;
  const r = duel({ modeId: 'snow', wep: 'snowball', ms: 2600 });
  const bursts = r.events.filter((e) => e.e === EV.BURST);
  const hits = r.events.filter((e) => e.e === EV.HIT);
  okB(r.events.some((e) => e.e === EV.SHOT), 'snowball threw something', 'SHOT emitted');
  okB(bursts.length > 0, 'snowball burst on impact', `${bursts.length} bursts`);
  okB(hits.length === Math.ceil(C.MAX_HP / SNOW.dmg), `snowball takes ${Math.ceil(C.MAX_HP / SNOW.dmg)} hits to kill`,
      `${hits.length} hits`);
  // EV.HIT carries REMAINING health, not damage dealt, so per-hit damage is the
  // difference between consecutive events. The killing blow is clamped at 0 hp and
  // so reads low — every hit before it must be the full figure.
  const deltas = [];
  let prev = C.MAX_HP;
  for (const h of hits) {
    deltas.push(prev - h.hp);
    prev = h.hp;
  }
  okB(
    deltas.slice(0, -1).every((d) => Math.abs(d - SNOW.dmg) < 0.001) && deltas.at(-1) <= SNOW.dmg + 0.001,
    `snowball does ${SNOW.dmg} per direct hit`,
    deltas.join(',') || 'no hits',
  );
}

// Range. The knife's 2.2u reach is the whole difference between melee and hitscan,
// and it is enforced in exactly one place (weapon.range in resolveShot).
{
  const r = duel({ wep: 'knife', gap: GAP, ms: 2000 });
  const h = r.events.filter((e) => e.e === EV.HIT);
  okB(h.length === 0, `knife cannot reach ${GAP}u (range ${WEAPONS.knife.range})`, `${h.length} hits`);
  okB(r.events.some((e) => e.e === EV.SHOT), 'knife still swings when out of range', 'SHOT emitted');
  // A swing that reached nothing must say so, or the client draws chips and a puff
  // hanging in mid-air two metres in front of your face.
  okB(r.events.filter((e) => e.e === EV.SHOT).every((e) => e.h === undefined),
      'a swing through empty air reports hitting nothing',
      r.events.filter((e) => e.e === EV.SHOT).map((e) => e.h ?? '-').join(','));
}

// What a shot ended ON. "i cant slash the objects no slash no bullet ... everything
// inside of collide it just pass through everything" — the geometry always stopped
// shots, but nothing on the wire said so, so nothing was ever drawn and the world
// read as something rounds passed straight through. One field, three values.
{
  const shooter = { x: line.x, y: C.PLAYER_HALF_H, z: line.z, yaw: YAW_EAST, pitch: 0, alive: true, crouch: 0 };
  const target = { x: line.x + GAP, y: C.PLAYER_HALF_H, z: line.z, yaw: 0, pitch: 0, alive: true, crouch: 0 };

  // A body in the way outranks the wall behind it.
  const onBody = resolveShot(shooter, [shooter, target], WEAPONS.rifle);
  okB(onBody.on === 2, 'a shot that stops on a player reports 2', `on=${onBody.on} at ${onBody.dist.toFixed(2)}u`);

  // Nothing but geometry down the line. The arena is walled, so a rifle's 200u
  // reaches the perimeter — that has to come back as a hit, not as a miss.
  const onWall = resolveShot(shooter, [shooter], WEAPONS.rifle);
  okB(!onWall.victim && onWall.on === 1, 'a shot that stops on world geometry reports 1',
      `on=${onWall.on} at ${onWall.dist.toFixed(2)}u of ${WEAPONS.rifle.range}u`);
  okB(onWall.dist < WEAPONS.rifle.range - 1e-4, 'and stopped short of its own range',
      `${onWall.dist.toFixed(3)}u < ${WEAPONS.rifle.range}u`);

  // The miss. rayWorld hands back the range it was given when it meets nothing, so
  // "reached full range" is the only signal a miss has — this is the check that keeps
  // the two apart, and the reason the comparison carries an epsilon.
  const SHORT = { range: 0.5, spread: 0, dmg: 1, kind: 'hitscan' };
  const onAir = resolveShot(shooter, [shooter, target], SHORT);
  okB(onAir.on === 0 && !onAir.victim, 'a shot that reaches nothing reports 0',
      `on=${onAir.on} at ${onAir.dist.toFixed(2)}u of ${SHORT.range}u`);
  okB(Math.abs(onAir.dist - SHORT.range) < 1e-9, 'a miss reports the full range as its distance',
      `${onAir.dist}`);

  // And the flag survives the trip: the SHOT event has to carry it, since that is the
  // only thing the client sees.
  const r = duel({ wep: 'knife', gap: MELEE_GAP, ms: 500 });
  const swings = r.events.filter((e) => e.e === EV.SHOT);
  okB(swings.length > 0 && swings.every((e) => e.h === 2), 'SHOT carries what it landed on',
      swings.map((e) => e.h ?? '-').join(','));
}

// Loadout whitelist. Sniper match offers only sniper and knife, so a client asking
// for a rifle must keep what it had — this is the one gate stopping any client from
// picking any weapon in any mode.
{
  const r = duel({ modeId: 'sniper', wep: 'rifle', ms: 500 });
  const sniperMode = MODES.sniper;
  okB(r.A.wep === indexOf(sniperMode.loadout[0]),
      'a weapon outside the mode loadout is refused',
      `asked for rifle (#${indexOf('rifle')}), holding #${r.A.wep}`);
  const s = r.events.filter((e) => e.e === EV.SHOT);
  okB(s.length === shotsIn(WEAPONS[sniperMode.loadout[0]], r.ticks),
      'the refused client fires its granted weapon instead', `${s.length} shots`);
}

// Dealt loadouts. "in death match guns should be random what you get primary
// secondary and so on" — so in dm the mode's `loadout` is a POOL and each player is
// dealt one weapon per slot out of it. The risk in a random loadout is dealing an
// unplayable hand, so the assertions are about the shape of the deal rather than
// about which weapons came up: one per slot, in slot order, all from the pool.
{
  const pool = DM.loadout;
  const slots = [...new Set(pool.map((id) => WEAPONS[id].slot))].sort((a, b) => a - b);

  okB(DM.randomLoadout === true, 'deathmatch deals its loadout rather than offering it',
      `randomLoadout=${DM.randomLoadout}`);

  const roll = rollLoadout(pool);
  okB(roll.length === slots.length, 'a deal fills every slot in the pool exactly once',
      `${roll.length} weapons for slots [${slots}]: ${roll.join(',')}`);
  okB(roll.every((id) => pool.includes(id)), 'every dealt weapon came from the pool', roll.join(','));
  okB(
    roll.map((id) => WEAPONS[id].slot).join() === slots.join(),
    'the deal is in slot order, so 1 is the primary and 3 is the knife',
    roll.map((id) => `${WEAPONS[id].slot}:${id}`).join(' '),
  );

  // Both ends of the roll, with the randomness injected — the guard against a
  // generator that returns exactly 1.0 is otherwise unreachable, and an out-of-range
  // index there would deal `undefined` into a player's hand.
  okB(rollLoadout(pool, () => 0).join() === 'rifle,pistol,knife,grenade',
      'a lowest roll deals the first weapon in each slot', rollLoadout(pool, () => 0).join(','));
  okB(rollLoadout(pool, () => 1).every(Boolean),
      'a roll of exactly 1.0 stays inside every bucket', rollLoadout(pool, () => 1).join(','));

  // The deal reaching a player, and narrowing what they may hold. `room.allowed` is
  // the pool in this mode; `p.allowed` is the hand.
  const room2 = new Room(DEFAULT_MODE);
  const p = room2.players.get(room2.add('dealt', {}));
  okB(p.loadout.length === slots.length, 'a joining player is dealt a hand',
      p.loadout.map((i) => WEAPON_IDS[i]).join(','));
  okB(p.wep === p.loadout[0], 'and comes up holding its first slot', `#${p.wep}`);
  okB(p.allowed.size < room2.allowed.size,
      'the hand is narrower than the pool it was drawn from',
      `${p.allowed.size} of ${room2.allowed.size}`);
  okB([...p.allowed].every((i) => room2.allowed.has(i)), 'and is a subset of it',
      [...p.allowed].join(','));

  // Re-dealt on every life, which is the half of this that a single join cannot show.
  // Deathmatch's pool holds two primaries, so 40 lives seeing only one of them is a
  // 1-in-2^39 coincidence — safe to read as "the hand never actually re-rolled".
  const primaries = new Set();
  for (let i = 0; i < 40; i++) {
    room2.respawn(p);
    primaries.add(p.loadout[0]);
    if (p.wep !== p.loadout[0] || p.ammo[p.wep] !== (weaponAt(p.wep).mag ?? 0)) primaries.add(-1);
  }
  okB(primaries.size >= 2 && !primaries.has(-1), 'respawning deals a fresh hand, loaded',
      `${primaries.size} distinct primaries over 40 lives: ${[...primaries].map((i) => WEAPON_IDS[i]).join(',')}`);
  room2.drainEvents();
}

// Magazine and reload. Seeded to one round so the cycle completes in a short run
// rather than needing a full magazine's worth of fire-interval.
{
  const r = duel({ modeId: 'sniper', wep: 'sniper', ms: 0 });
  const wi = indexOf('sniper');
  const w = WEAPONS.sniper;
  r.A.ammo[wi] = 1;

  r.run(1, C.BTN_FIRE);
  okB(r.A.ammo[wi] === 0, 'firing spent the round', `ammo=${r.A.ammo[wi]}`);
  okB(r.A.reloadUntil > r.room.now(), 'the last round auto-started a reload',
      `${Math.round(r.A.reloadUntil - r.room.now())}ms left`);

  // Mid-reload the weapon must not fire, however hard the button is worked. `trigger`
  // follows the weapon's declared behavior, which now means holding the sniper: without
  // the reload gate it would fire the moment its cadence allowed, so this test can fail.
  const mid = r.events.length;
  r.trigger(Math.floor(w.reloadMs / STEP_MS) - 2);
  okB(r.events.slice(mid).every((e) => e.e !== EV.SHOT), 'reloading blocks firing',
      `${r.events.slice(mid).filter((e) => e.e === EV.SHOT).length} shots during reload`);

  r.run(6, 0);
  okB(r.A.ammo[wi] === w.mag, `reload refilled to ${w.mag}`, `ammo=${r.A.ammo[wi]}`);
  okB(r.A.reloadUntil === 0, 'reload state cleared', `reloadUntil=${r.A.reloadUntil}`);
}

// Switch delay. Drawing a weapon has to cost something, or cycling weapons is a
// free way to dodge every fire-rate clamp in the game.
{
  const r = duel({ wep: 'pistol', ms: 0 });
  const rifleI = indexOf('rifle');
  let seq = 10000;
  const swap = (buttons) =>
    r.room.queueInput(r.idA, [{ seq: ++seq, moveX: 0, moveZ: 0, yaw: YAW_EAST, pitch: 0, buttons, wep: rifleI }]);

  const mark = r.events.length;
  // The RIFLE's deploy time, because the rifle is what is being drawn — `applyWeapon`
  // charges the incoming weapon's own figure. Reading the pistol's, or the fallback,
  // would stop the loop early and pass on a swap clamp that had been shortened.
  const drawMs = switchMsOf('rifle');
  for (let i = 0; i < Math.floor(drawMs / STEP_MS) - 1; i++) {
    r.pin();
    // Worked rather than held, for the same reason as the reload gate: the rifle being
    // drawn is automatic, but the pistol being put away is not, and a held button would
    // pass this test on either side of a broken switch clamp.
    swap(i % 2 === 0 ? C.BTN_FIRE : 0);
    r.room.step();
    r.events.push(...r.room.drainEvents());
  }
  okB(r.A.wep === rifleI, 'the swap was granted', `holding #${r.A.wep}`);
  okB(r.events.slice(mark).every((e) => e.e !== EV.SHOT), `switching blocks firing for ${drawMs}ms`,
      `${r.events.slice(mark).filter((e) => e.e === EV.SHOT).length} shots mid-swap`);
  // It is the incoming weapon's figure and not the outgoing one's. The pistol is 420ms
  // and the rifle 650, so a regression to "charge what you put away" would have let a
  // shot out 230ms into the window above — this names the number that would have.
  okB(drawMs > switchMsOf('pistol'), 'the rifle costs more to draw than the pistol did to stow',
      `${drawMs}ms drawing vs ${switchMsOf('pistol')}ms stowing`);
  // And the clamp lifts. A gate that never opens passes every test above.
  const mark2 = r.events.length;
  for (let i = 0; i < 4; i++) {
    r.pin();
    swap(C.BTN_FIRE);
    r.room.step();
    r.events.push(...r.room.drainEvents());
  }
  okB(r.events.slice(mark2).some((e) => e.e === EV.SHOT), 'and lifts the moment it expires',
      `${r.events.slice(mark2).filter((e) => e.e === EV.SHOT).length} shots in the 4 ticks after`);
}

// The deploy-time table itself. Per-weapon draw times are data, and the failure mode of
// a data table keyed by string is a key that matches nothing: `switchMsOf` returns the
// fallback rather than throwing, so a misspelled weapon just quietly draws at the wrong
// speed. That is invisible in play and invisible in review, which is what makes it worth
// a test — the table shipped once with `flashbang` in it, and the weapon is `flash`.
{
  const missing = WEAPON_IDS.filter((id) => switchMsOf(id) === SWITCH_MS);
  okB(missing.length === 0, 'every weapon names its own deploy time',
      missing.length ? `on the ${SWITCH_MS}ms fallback: ${missing.join(', ')}` : 'no fallbacks in use');

  // The ceiling, and the reason it is a ceiling: the answer to a jammed rifle is your
  // pistol, so drawing one has to be cheaper than waiting out the stoppage.
  okB(switchMsOf('pistol') < JAM_CLEAR_MS, 'a pistol can still be drawn faster than a jam clears',
      `${switchMsOf('pistol')}ms draw vs ${JAM_CLEAR_MS}ms stoppage`);

  // Ordered by what you are picking up, not typed to taste.
  const asc = ['knife', 'pistol', 'smg', 'rifle', 'sniper', 'lmg'];
  okB(asc.every((id, i) => i === 0 || switchMsOf(id) > switchMsOf(asc[i - 1])),
      'heavier weapons take longer to bring up', asc.map((id) => `${id} ${switchMsOf(id)}`).join(', '));

  // Every deploy time has to leave room for the draw animation to read as one. The
  // client plays the cocking stroke across 32% of the swap; under about 80ms that is a
  // flicker rather than a gesture, which was the whole complaint the table answers.
  const tightest = Math.min(...WEAPON_IDS.map((id) => switchMsOf(id) * 0.32));
  okB(tightest >= 80, 'the shortest swap still has room to show a draw',
      `${Math.round(tightest)}ms of cocking stroke at its tightest`);
}

// Spawn protection. "we should have like death protection seconds after spawn in that way
// you cant just die after spawn" — and the half of it that is not obvious is the giving
// up: a shield you keep while shooting is spawn camping with extra steps.
{
  const r = duel({ wep: 'rifle', ms: 0 });
  // Straight out of respawn, shield untouched — `pin` clears it for every other test
  // here, so this one has to re-arm it deliberately.
  r.B.protectedUntil = r.room.now() + C.SPAWN_PROTECT_MS;
  const mark = r.events.length;
  for (let i = 0; i < 20; i++) {
    r.A.x = line.x; r.A.y = C.PLAYER_HALF_H; r.A.z = line.z;
    r.B.x = line.x + GAP; r.B.y = C.PLAYER_HALF_H; r.B.z = line.z;
    r.A.protectedUntil = 0; // the shooter's own shield is not what is under test
    r.room.queueInput(r.idA, [{ seq: 5000 + i, moveX: 0, moveZ: 0, yaw: YAW_EAST, pitch: 0, buttons: C.BTN_FIRE, wep: r.wi }]);
    r.room.step();
    r.events.push(...r.room.drainEvents());
  }
  const guarded = r.events.slice(mark);
  okB(guarded.some((e) => e.e === EV.SHOT), 'a protected player can still be shot AT',
      `${guarded.filter((e) => e.e === EV.SHOT).length} rounds went downrange`);
  okB(guarded.every((e) => e.e !== EV.HIT), 'but none of it lands',
      `hp=${r.B.hp}, ${guarded.filter((e) => e.e === EV.HIT).length} hits`);
  okB(r.B.hp === C.MAX_HP && r.B.alive, 'so a fresh spawn cannot be killed on arrival',
      `${C.SPAWN_PROTECT_MS}ms of cover`);

  // The shield reaches the client as a duration, because the client cannot convert a
  // server deadline: `protectedUntil` is on the tick clock, performance.now() is not.
  const wire = r.room.snapshotBase().players.find((q) => q.id === r.idB);
  okB(typeof wire.sp === 'number' && wire.sp > 0 && wire.sp <= C.SPAWN_PROTECT_MS,
      'and the HUD is told how much of it is left, in ms remaining', `sp=${wire.sp}`);

  // Firing gives it up. Without this the shield is strictly better than no shield for
  // the aggressor — two seconds of shooting people who cannot shoot back.
  //
  // B is handed the weapon directly rather than by asking for it on the input: asking
  // would make `applyWeapon` charge a deploy time, and the swap gate would then swallow
  // the very shot this is trying to fire.
  r.B.protectedUntil = r.room.now() + C.SPAWN_PROTECT_MS;
  r.B.wep = indexOf('rifle');
  r.B.ammo[r.B.wep] = WEAPONS.rifle.mag;
  r.B.switchUntil = 0;
  r.B.nextFireAt = 0;
  r.B.fireHeld = false;
  r.room.queueInput(r.idB, [{ seq: 1, moveX: 0, moveZ: 0, yaw: YAW_EAST, pitch: 0, buttons: C.BTN_FIRE, wep: r.B.wep }]);
  r.room.step();
  const shot = r.room.drainEvents().some((e) => e.e === EV.SHOT && e.id === r.idB);
  okB(shot, 'the protected player got a round off', 'the premise of the next check');
  okB(r.B.protectedUntil === 0, 'and shooting from behind the shield drops it',
      'a camper who cannot be killed is the thing this was added to stop');
  const idle = duel({ wep: 'rifle', ms: 0 });
  idle.B.protectedUntil = idle.room.now() + C.SPAWN_PROTECT_MS;
  for (let i = 0; i < 10; i++) idle.room.step();
  okB(idle.B.protectedUntil > 0, 'and standing still does not',
      `${Math.round(idle.B.protectedUntil - idle.room.now())}ms still on the clock`);
}

// Jamming. "we should add a random gun jamming where the character will try to unjam it
// but punching the gun using its other hand". Rolled with the room's `rand` pinned, so
// what is measured is the mechanic and not the dice.
{
  const r = duel({ wep: 'rifle', ms: 0, jams: true }); // rand() === 0: jams every round
  const mark = r.events.length;
  r.trigger(2);
  const ev = r.events.slice(mark);
  okB(ev.filter((e) => e.e === EV.SHOT).length === 1, 'the round that jams still leaves the barrel',
      'a stoppage costs you the NEXT shot, which is the forgiving direction');
  const jam = ev.find((e) => e.e === EV.JAM);
  okB(!!jam && jam.ms === JAM_CLEAR_MS, 'and the stoppage is announced with its duration',
      `EV.JAM ms=${jam?.ms}`);
  okB(jam?.id === r.idA, 'attributed to the player whose gun it is', `id=${jam?.id}`);

  // The gate, measured against the deadline the room actually recorded rather than a
  // predicted tick count. A count is off by one at the boundary: the gate is
  // `now < jammedUntil`, so the tick that lands exactly on the deadline fires, and a
  // test expecting silence there reports a leak that is really the stoppage ending on
  // time. Stepping to the first round instead measures the two things worth knowing —
  // that nothing came out early, and that it came out the moment it was allowed to.
  const until = r.A.jammedUntil[r.wi];
  const jammedAt = until - JAM_CLEAR_MS;
  let firedAt = -1;
  for (let i = 0; i < 200 && firedAt < 0; i++) {
    const mark2 = r.events.length;
    r.trigger(1);
    if (r.events.slice(mark2).some((e) => e.e === EV.SHOT)) firedAt = r.room.now();
  }
  okB(firedAt >= until, `nothing left the barrel for the whole ${JAM_CLEAR_MS}ms stoppage`,
      `first round at +${Math.round(firedAt - jammedAt)}ms`);
  // Within a tick, not on the tick. JAM_CLEAR_MS is exactly 84 ticks, so the deadline
  // lands on a tick boundary and float accumulation of a 16.666…ms step decides by about
  // 1e-13 whether that tick or the next one is the first to fire. A player cannot feel
  // 1e-13; a test that demanded the exact tick would be asserting the rounding.
  okB(firedAt >= 0 && firedAt - until <= STEP_MS + 1e-9,
      'and it works again within a tick of the hands clearing it',
      `+${(firedAt - until).toFixed(1)}ms on a ${STEP_MS.toFixed(1)}ms tick grid`);

  // The counterplay, and the reason the deploy-time ceiling above exists: a jam belongs
  // to the WEAPON, so your sidearm is the answer to a stuck rifle.
  const r2 = duel({ wep: 'rifle', ms: 0, jams: true });
  r2.trigger(2);
  const rifleI = indexOf('rifle');
  const pistolI = indexOf('pistol');
  okB(r2.A.jammedUntil[rifleI] > r2.room.now(), 'the jam is recorded against the weapon in hand',
      `${Math.round(r2.A.jammedUntil[rifleI] - r2.room.now())}ms left on slot ${rifleI}`);
  okB(r2.A.jammedUntil[pistolI] === 0, 'and not against the player',
      'swapping to a working weapon is the whole counterplay');

  // Reload was the third answer to a stoppage, and the cheapest. Two gates ago the
  // pistol's magazine change was 1200ms against a 1400ms jam, so pressing R cleared a
  // pistol jam FASTER than clearing it did — and did it while replacing the punch on
  // screen with the reload's gun-down pose, which is the animation the whole clearing
  // gesture was rewritten to stop hiding.
  //
  // Asserted on the pistol specifically, because the pistol is the weapon where the
  // numbers made it an outright win rather than merely a legal move.
  {
    const rj = duel({ wep: 'pistol', ms: 0, jams: true });
    rj.trigger(2);
    const pi = indexOf('pistol');
    okB(rj.A.jammedUntil[pi] > rj.room.now(), 'a pistol jams like anything else with an action',
        `${Math.round(rj.A.jammedUntil[pi] - rj.room.now())}ms left`);
    okB(WEAPONS.pistol.reloadMs < JAM_CLEAR_MS,
        'and its magazine change is still shorter than the stoppage',
        `${WEAPONS.pistol.reloadMs}ms reload vs ${JAM_CLEAR_MS}ms jam — which is why the gate exists`);
    const before = rj.A.ammo[pi];
    rj.run(4, C.BTN_RELOAD);
    okB(rj.A.reloadUntil === 0 && rj.A.reloadWep === -1,
        'so pressing R on a jammed weapon is refused outright',
        'the two answers to a stoppage are waiting it out and drawing something else');
    okB(rj.A.ammo[pi] === before, 'and hands you no rounds for having tried',
        `${rj.A.ammo[pi]}/${WEAPONS.pistol.mag}`);
    // The stoppage still ends on its own clock, so the gate has not made a jam permanent
    // for a player who reaches for the wrong key.
    for (let i = 0; i < 200 && rj.A.jammedUntil[pi] > rj.room.now(); i++) rj.run(1, C.BTN_RELOAD);
    okB(rj.A.jammedUntil[pi] <= rj.room.now(), 'the stoppage still clears on its own clock',
        'holding the wrong key must not extend it');
    rj.run(2, C.BTN_RELOAD);
    okB(rj.A.reloadUntil > rj.room.now(), 'and the same key works the moment it has',
        `${Math.round(rj.A.reloadUntil - rj.room.now())}ms of reload left`);
  }

  // The one case that gate would otherwise break. A jam is rolled BEFORE the dry-fire
  // auto-reload — it has to be, because a stoppage costs you the next round and not the
  // one you just fired — so the round that empties the magazine can also be the round that
  // jams, and the gate would eat the reload that was supposed to follow it. `finishJam`
  // picks it up on the tick the stoppage ends.
  {
    const re = duel({ wep: 'rifle', ms: 0, jams: true });
    re.A.ammo[re.wi] = 1; // the last round in the magazine, and it is about to stick
    re.trigger(2);
    okB(re.A.ammo[re.wi] === 0 && re.A.jammedUntil[re.wi] > re.room.now(),
        'a magazine can end on the round that jams', 'empty and stuck at the same moment');
    okB(re.A.reloadUntil === 0, 'and the reload that would have followed is held off, not lost',
        `jamWep=${re.A.jamWep}`);
    // Stepped with NO buttons: the only thing that may start this reload is the clock.
    // Holding the trigger would start it too, through tryFire's own empty-magazine path,
    // and would prove nothing about whether the stoppage ending does.
    const until = re.A.jammedUntil[re.wi];
    let leaked = false;
    for (let i = 0; i < 200 && re.room.now() < until; i++) {
      re.run(1, 0);
      if (re.A.reloadUntil > 0) leaked = true;
    }
    okB(!leaked, `and stays held off for the whole ${JAM_CLEAR_MS}ms`,
        'a reload running behind a stoppage is the escape the gate just closed');
    re.run(2, 0);
    okB(re.A.reloadUntil > re.room.now(),
        'then starts on its own the moment the hands are free',
        `${Math.round(re.A.reloadUntil - re.room.now())}ms — nobody is left holding an empty gun`);
    okB(re.A.jamWep === -1, 'and the stoppage is only noticed ending once',
        'jamWep is a one-shot edge, not a flag');
  }

  // ...but not behind your back. Stoppages are per-weapon deadlines that keep running
  // while you hold something else, which is the entire counterplay; a rifle that quietly
  // reloaded itself while the pistol was up would be handing that back for free.
  {
    const rb = duel({ wep: 'rifle', ms: 0, jams: true });
    rb.A.ammo[rb.wi] = 1;
    rb.trigger(2);
    // Set directly rather than swapped into, and deliberately: going through applyWeapon
    // would also set `switchUntil`, which blocks beginReload on its own and would leave
    // the test passing for the wrong reason. This way the weapon check is the only thing
    // that can hold the reload off.
    rb.A.wep = indexOf('pistol');
    // And stepped with no input at all, not through `run`. The harness's `send` carries
    // `wep: wi` on every tick, so anything that queues an input puts the rifle straight
    // back in hand — which is a fine thing for the other tests and the whole of what this
    // one is trying to avoid. With nothing queued the room takes the starvation path,
    // which moves the body and runs the clocks but never touches the weapon.
    const step = (n) => { for (let i = 0; i < n; i++) { rb.pin(); rb.room.step(); } };
    const until = rb.A.jammedUntil[rb.wi];
    for (let i = 0; i < 200 && rb.room.now() < until; i++) step(1);
    step(3);
    okB(rb.A.reloadUntil === 0 && rb.A.ammo[rb.wi] === 0,
        'a weapon you are not holding does not reload itself when its stoppage ends',
        'swapping away cancels a reload; it must not silently start one either');
  }

  // Nothing without a mechanical action can jam — the knife and the throwables.
  const cannot = WEAPON_IDS.filter((id) => jamChanceOf(id) === 0);
  okB(cannot.includes('knife') && ['grenade', 'snowball', 'flash', 'smoke'].every((id) => cannot.includes(id)),
      'a knife and a snowball have no action to fail', `never jam: ${cannot.join(', ')}`);
  const guns = WEAPON_IDS.filter((id) => WEAPONS[id].kind === 'hitscan');
  okB(guns.every((id) => jamChanceOf(id) > 0), 'and every gun can',
      guns.map((id) => `${id} ${(jamChanceOf(id) * 100).toFixed(1)}%`).join(', '));

  // Public on the wire, not private to its owner: the opening a stoppage creates is for
  // the other player, and it drives the off-hand punch on the remote avatar.
  const wire = r2.room.snapshotBase().players.find((q) => q.id === r2.idA);
  okB(typeof wire.jm === 'number' && wire.jm > 0 && wire.jm <= JAM_CLEAR_MS,
      'the stoppage goes out to everyone as ms remaining', `jm=${wire.jm}`);
  const clean = duel({ wep: 'rifle', ms: 0 }).room.snapshotBase().players[0];
  okB(clean.jm === undefined, 'and is absent entirely on a working weapon',
      'omitted rather than zeroed — it is on every player in every snapshot');
}

// The mode blob the HUD reads. Empty here means the timer and score target never
// reach the client, and the match bar sits blank all game.
{
  const r = duel({ ms: 0 });
  const snap = r.room.snapshotBase();
  okB(snap.md && snap.md.ph === 'live', 'snapshot carries mode state', JSON.stringify(snap.md));
  okB(snap.md?.kl === DM.killLimit, 'mode state reports the score target', `kl=${snap.md?.kl}`);
  okB(snap.players.every((p) => typeof p.w === 'number' && typeof p.tm === 'number'),
      'snapshot players carry weapon and team', JSON.stringify(snap.players[0]));
}


// ──────────────────── hit zones, distance, movement, and the rewind that ties them
// "no matter how good you are some guns will get outgun by pistol which makes no sense —
// we dont have hitboxes like head/body stuff, no distance falloff damage ... while pistol
// you just sprint while shooting ... you cant even hit good with sniper when they move."
//
// Four systems, and none of them is worth anything alone: a zone multiplier that never
// reaches applyDamage, a falloff curve nothing calls, a cone the client draws and the
// server ignores, and a position history with no consumer are all just table entries. So
// each is checked twice — against the shared table directly, and end-to-end through a
// real Room where a HIT event has to come out carrying the right number.

// ---- the boxes themselves
{
  const bodies = [
    ['standing', { x: 0, y: C.PLAYER_HALF_H, z: 0, crouch: 0 }],
    ['crouched', { x: 0, y: C.CROUCH_HALF_H, z: 0, crouch: 1 }],
  ];
  for (const [name, s] of bodies) {
    const [hx, hy] = halfOf(s);
    const foot = s.y - hy;
    const crown = s.y + hy;
    const head = headBoxOf(s);
    const legs = legsTopOf(s);
    // THE invariant of the whole zone system: a zone may change what a hit was WORTH and
    // may never change WHETHER it happened. That holds only while the head box is inside
    // the body box, because hitscan.js still tests the body box and nothing else for
    // hittability — a skull poking out of it would be a volume the ray never gets asked
    // about, and a skull wider than the shoulders would make the silhouette grow.
    okB(head.cy - head.hy > foot && head.cy + head.hy <= crown + 1e-9 && head.hx < hx,
        `${name} head box sits inside the body box`,
        `head ${(head.cy - head.hy).toFixed(3)}..${(head.cy + head.hy).toFixed(3)} hx ${head.hx}`
        + ` inside body ${foot.toFixed(3)}..${crown.toFixed(3)} hx ${hx}`);
    // Where a CS2 player parks their crosshair has to be a headshot at BOTH heights, or
    // ducking becomes a way to opt out of being one-tapped.
    okB(eyeY(s) >= head.cy - head.hy && eyeY(s) <= head.cy + head.hy,
        `${name} eye line is inside the head box`, `eye ${eyeY(s).toFixed(3)}`);
    okB(legs > foot && legs < head.cy - head.hy,
        `${name} legs are a band above the feet, below the skull`, `legsTop ${legs.toFixed(3)}`);
    // The bot aim point. If this drifted into the head box every bot with a rifle would
    // one-tap on sight, since AIM_ERR_SETTLED is smaller than a head at duelling range.
    okB(chestY(s) > legs && chestY(s) < head.cy - head.hy,
        `${name} bot aim point is chest — not head, not legs`, `chest ${chestY(s).toFixed(3)}`);
  }
  okB(HIT_ZONE_MUL[HIT_ZONE.HEAD] === 4 && HIT_ZONE_MUL[HIT_ZONE.BODY] === 1
      && HIT_ZONE_MUL[HIT_ZONE.LEGS] === 0.85,
      'zone multipliers are 4x head, 1x body, 0.85x legs', HIT_ZONE_MUL.join(' / '));
}

// ---- the multipliers, out of a real Room
{
  // The same duel three times with nothing changed but the pitch. Damage read off the HIT
  // event rather than out of shotDamage, because a multiplier that lives in weapons.js and
  // never reaches applyDamage is a comment. This also settles the falloff wiring: zone and
  // distance are applied in the SAME expression in shotDamage, so a zone arriving intact
  // proves that expression is the one room.js calls.
  const aims = [
    ['head', AIM_HEAD, HIT_ZONE.HEAD],
    ['body', AIM_BODY, HIT_ZONE.BODY],
    ['legs', AIM_LEGS, HIT_ZONE.LEGS],
  ];
  for (const id of DM.loadout) {
    const w = WEAPONS[id];
    // Hitscan singles only. The knife is exempt from zones by design (a stab is a stab),
    // the shotgun's eight traces land in different zones on purpose, and a grenade has no
    // ray to classify.
    if (w.kind !== 'hitscan' || pelletsOf(id) > 1) continue;
    for (const [zname, y, zone] of aims) {
      const r = duel({ wep: id, ms: 400, pitch: pitchTo(y) });
      const h = r.events.filter((e) => e.e === EV.HIT);
      const dealt = C.MAX_HP - (h[0]?.hp ?? C.MAX_HP);
      // Clamped, because a headshot with anything but the smg overkills and EV.HIT carries
      // REMAINING health: 58 x 4 reads as exactly MAX_HP.
      const want = Math.min(C.MAX_HP, Math.max(1, Math.round(w.dmg * HIT_ZONE_MUL[zone])));
      okB(h.length > 0 && dealt === want, `${id} ${zname} shot does ${want}`,
          `${dealt} from ${h.length} hits`);
      // The zone rides out on the event because the client draws a different hitmarker for
      // it — without this the 4x is invisible to the player who earned it.
      okB(h.length > 0 && (h[0].z ?? HIT_ZONE.BODY) === zone,
          `${id} ${zname} shot reports its zone on the wire`,
          `z=${h[0]?.z ?? 'omitted (body)'}`);
    }
  }
  // The knife is the exemption, asserted rather than assumed: a melee weapon that took the
  // 4x would be a 360-damage stab, and a heavy one at that.
  const kh = duel({ wep: 'knife', gap: MELEE_GAP, ms: 600, pitch: pitchTo(AIM_HEAD, MELEE_GAP) });
  const khh = kh.events.filter((e) => e.e === EV.HIT);
  okB(khh.length > 0 && C.MAX_HP - khh[0].hp === WEAPONS.knife.dmg,
      'a knife to the head is still a knife', `${C.MAX_HP - (khh[0]?.hp ?? C.MAX_HP)} damage`);
}

// ---- the distance curve
{
  const curved = WEAPON_IDS.filter((id) => WEAPONS[id].falloff);
  okB(curved.length > 0, 'some weapons bleed damage with distance', curved.join(', '));
  for (const id of curved) {
    const w = WEAPONS[id];
    const f = w.falloff;
    okB(falloffMul(w, 0) === 1 && falloffMul(w, f.start) === 1,
        `${id} is at full damage out to ${f.start}u`, `${falloffMul(w, f.start)} at the knee`);
    okB(Math.abs(falloffMul(w, w.range) - f.min) < 1e-9,
        `${id} bottoms out at ${Math.round(f.min * 100)}% at its ${w.range}u limit`,
        falloffMul(w, w.range).toFixed(4));
    // Monotone, and it holds the floor past the limit rather than going negative. `range`
    // is a hard stop in resolveShot, but shotDamage is also read by tests and by anything
    // that wants to show a player what a gun does at a distance.
    let prev = Infinity;
    let mono = true;
    for (let dd = 0; dd <= w.range * 1.5; dd += w.range / 40) {
      const m = falloffMul(w, dd);
      if (m > prev + 1e-9 || m < f.min - 1e-9 || m > 1 + 1e-9) mono = false;
      prev = m;
    }
    okB(mono, `${id} falls monotonically and never below its floor`, `floor ${f.min}`);
    okB(shotDamage(w, w.range) < shotDamage(w, f.start), `${id} does less at range than up close`,
        `${shotDamage(w, f.start)} → ${shotDamage(w, w.range)}`);
  }
  // The three that deliberately have no curve, and each for its own reason: a sniper that
  // did 60 across the map would be a worse rifle, the shotgun's falloff is already its
  // pellet geometry, and a knife's range is 2.2u.
  for (const id of ['sniper', 'shotgun', 'knife']) {
    okB(!WEAPONS[id].falloff && falloffMul(WEAPONS[id], WEAPONS[id].range) === 1,
        `${id} has no distance curve, by design`, `flat across ${WEAPONS[id].range}u`);
  }
  const SN = WEAPONS.sniper;
  okB(shotDamage(SN, 5) === C.MAX_HP && shotDamage(SN, SN.range) === C.MAX_HP,
      'the sniper does 100 at any range it reaches', `${shotDamage(SN, SN.range)} at ${SN.range}u`);
  // "some guns will get outgun by pistol which makes no sense." The sidearm now needs the
  // same four body hits as the rifle but has the slightly slower legal cadence, so the draw
  // speed remains its advantage without making it the best primary up close.
  const P = WEAPONS.pistol;
  const R = WEAPONS.rifle;
  const stk = (w, dd) => Math.ceil(C.MAX_HP / shotDamage(w, dd));
  okB(shotDamage(P, 5) === shotDamage(R, 5), 'the pistol no longer hits harder than the rifle up close',
      `${shotDamage(P, 5)} vs ${shotDamage(R, 5)} at 5u`);
  const ttk = (w, dd) => (stk(w, dd) - 1) * w.intervalMs;
  okB(ttk(P, 5) > ttk(R, 5), 'and its four-hit body kill is a little slower than the rifle',
      `${ttk(P, 5)}ms pistol vs ${ttk(R, 5)}ms rifle`);
  okB(stk(P, 100) > stk(R, 100), 'and needs more shots than the rifle across the arena',
      `${stk(P, 100)} vs ${stk(R, 100)} shots at 100u`);
  let cross = null;
  for (let dd = 0; dd <= P.range; dd += 0.5) {
    if (shotDamage(P, dd) < shotDamage(R, dd)) { cross = dd; break; }
  }
  okB(cross !== null && cross > P.falloff.start && cross < R.range,
      'and the crossover is a distance a player can learn', cross === null ? 'never crosses' : `${cross}u`);
  okB(Math.ceil(C.MAX_HP / P.dmg) === Math.ceil(C.MAX_HP / R.dmg),
      'shots-to-kill are level up close, so the trade is range and not damage',
      `${Math.ceil(C.MAX_HP / P.dmg)} pistol vs ${Math.ceil(C.MAX_HP / R.dmg)} rifle`);
}

// ---- the curve, out of a real Room
{
  // The 8u duel line cannot see a falloff: every knee in the table is past it. So find a
  // longer lane the same way the 8u one was found — searched, not hardcoded, so it survives
  // the arena being edited — and shoot down it.
  const findLane = () => {
    for (const g of [40, 32, 24, 20, 16]) {
      const d = aimDir(YAW_EAST, pitchTo(AIM_BODY, g));
      for (let z = -ARENA / 2 + 2; z <= ARENA / 2 - 2; z += 1) {
        for (let x = -ARENA / 2 + 2; x + g <= ARENA / 2 - 2; x += 1) {
          if (!clearAt(x, z) || !clearAt(x + g, z)) continue;
          // The clearance ray is the SHOT's own direction, not a horizontal stand-in: a
          // chest shot descends 0.4u, and a crate whose top sits just under eye height
          // would pass a level check and eat the bullet.
          if (rayWorld(x, EYE_Y, z, d.x, d.y, d.z, WORLD_BOXES, g + 2) <= g) continue;
          return { x, z, gap: g };
        }
      }
    }
    return null;
  };
  const lane = findLane();
  okB(lane !== null && lane.gap > WEAPONS.pistol.falloff.start,
      'there is a lane long enough to see a falloff on',
      lane ? `${lane.gap}u at (${lane.x}, ${lane.z})` : 'none found');
  if (lane) {
    const shoot = (wep) => {
      const r = duel({ wep, gap: lane.gap, ms: 500, pitch: pitchTo(AIM_BODY, lane.gap), at: lane });
      const h = r.events.filter((e) => e.e === EV.HIT);
      return { hits: h.length, dealt: C.MAX_HP - (h[0]?.hp ?? C.MAX_HP) };
    };
    const far = shoot('pistol');
    // The ray enters the front face, so the distance the curve is read at is the gap less
    // the body's own half-width — within a thousandth of the pitch's hypotenuse, hence the
    // 1-point tolerance rather than an exact figure.
    const want = shotDamage(WEAPONS.pistol, lane.gap - C.PLAYER_HALF_W);
    okB(far.hits > 0 && Math.abs(far.dealt - want) <= 1,
        `a pistol at ${lane.gap}u does about ${want}, not its full ${WEAPONS.pistol.dmg}`,
        `${far.dealt} dealt, table says ${want}`);
    okB(far.hits > 0 && far.dealt < WEAPONS.pistol.dmg,
        'so the sidearm that used to trade evenly across the map no longer does',
        `${far.dealt} vs ${WEAPONS.pistol.dmg} at point blank`);
    const snipe = shoot('sniper');
    okB(snipe.hits > 0 && snipe.dealt === WEAPONS.sniper.dmg,
        `and the sniper still does its full ${WEAPONS.sniper.dmg} at the same ${lane.gap}u`,
        `${snipe.dealt} dealt`);
  }
}

// ---- the cone that opens up when you move
{
  const at = (vx, opts = {}) => ({ vx, vz: 0, grounded: true, crouch: 0, ...opts });
  const still = at(0);
  const walk = at(C.MOVE_SPEED * 0.5);
  const run = at(C.MOVE_SPEED);
  const sprint = at(C.MOVE_SPEED * C.SPRINT_SPEED_MUL);
  const air = at(0, { grounded: false });
  const duck = at(0, { crouch: 1 });
  // Exactly 1, not approximately: main.js adds `spread * (spreadMul(s) - 1)` to the
  // crosshair bloom, so anything else here would leave the resting crosshair permanently
  // bloomed for a player who is standing perfectly still.
  okB(spreadMul(still) === 1, 'standing still costs exactly nothing', `${spreadMul(still)}`);
  okB(spreadMul(duck) < 1, 'crouching draws it tighter than standing',
      `${spreadMul(duck).toFixed(3)}x`);
  okB(spreadMul(walk) > 1 && spreadMul(run) > spreadMul(walk) && spreadMul(sprint) > spreadMul(run),
      'and it costs more the faster you go',
      [still, walk, run, sprint].map((s) => `${spreadMul(s).toFixed(2)}x`).join(' → '));
  // Quadratic in speed, so a slow walk is nearly free and a sprint is not — the same shape
  // CS2 uses, and the reason counter-strafing is a skill rather than a chore.
  okB(spreadMul(run) - 1 > 3.5 * (spreadMul(walk) - 1),
      'the penalty is quadratic in speed, so a creep costs almost nothing',
      `walk +${(spreadMul(walk) - 1).toFixed(2)} vs run +${(spreadMul(run) - 1).toFixed(2)}`);
  okB(spreadMul(air) > spreadMul(run), 'and leaving the ground costs more than running flat out',
      `${spreadMul(air).toFixed(2)}x airborne vs ${spreadMul(run).toFixed(2)}x running`);
  // "while pistol you just sprint while shooting." At a standstill the pistol's cone is a
  // fraction of a body at duelling range, which is what makes it a precision sidearm. At a
  // sprint it is wider than the body it is pointed at, which is the whole answer.
  const REF = 20;
  const tight = REF * WEAPONS.pistol.spread * spreadMul(still);
  const loose = REF * WEAPONS.pistol.spread * spreadMul(sprint);
  okB(tight < C.PLAYER_HALF_W && loose > C.PLAYER_HALF_W,
      `a sprinting pistol's cone at ${REF}u is wider than the body it is aimed at`,
      `${tight.toFixed(2)}u standing, ${loose.toFixed(2)}u sprinting, against a ${C.PLAYER_HALF_W}u half-width`);
  // Applied to the weapon rather than to the player, so a tight gun stays the tighter gun.
  okB(WEAPONS.sniper.spread * spreadMul(sprint) < WEAPONS.smg.spread * spreadMul(still),
      'the multiplier scales each cone, it does not flatten them all together',
      `sniper sprinting ${(WEAPONS.sniper.spread * spreadMul(sprint)).toFixed(4)} rad`
      + ` vs smg standing ${WEAPONS.smg.spread} rad`);
}

// ---- the cone the glass closes
{
  // "i notice how crazy hard to play with sniper can you tell me why and what should we
  // improve i think we should copy how sniper behaves uin cs2."
  //
  // Three of CS2's rules about an AWP were missing, and this block is the biggest of them:
  // fpsbone's sniper was PINPOINT FROM THE HIP. `spread` was the weapon's only accuracy
  // number, so a snap shot at a running target went out through a 0.0008rad cone, a fifth
  // of a degree, which made the scope a pure liability. It cost the player their peripheral
  // vision and (now) their speed, and bought back nothing they did not already have. In CS2
  // an unscoped AWP is close to useless, and scoping resolves the cone over roughly
  // 150-200ms, which is what makes a quick-scope a gamble rather than a free shot.
  //
  // Every number here is asserted as a PROPERTY rather than a constant: HIP_SPREAD,
  // SCOPE_SETTLE_MS and SCOPE_STEP_SPREAD are private to shared/weapons.js on purpose, and
  // a test that pinned the literals would need editing every time the gun is tuned, which
  // is how a suite stops meaning anything.
  const glass = (scope, scopeMs) => ({ vx: 0, vz: 0, grounded: true, crouch: 0, scope, scopeMs });
  // Standing still, on the ground, not crouched, so the body term is exactly 1 and every
  // number below is the scope's own contribution.
  const mul = (scope, scopeMs) => spreadMul(glass(scope, scopeMs), 'sniper');
  const hip = mul(0, 0);

  // How long the glass takes to close, discovered rather than declared.
  let settleMs = -1;
  for (let t = 0; t <= 2000 && settleMs < 0; t++) if (mul(1, t) === 1) settleMs = t;
  okB(settleMs >= 80 && settleMs <= 200,
      'the scope resolves over the same window CS2 uses, not instantly and not eventually',
      `${settleMs}ms to fully settled`);

  okB(hip > 20, 'a sniper fired from the hip is not a sniper',
      `${hip.toFixed(0)}x the cone the table promises`);
  // Exactly 1, not approximately: the settled cone has to be the weapon's own number, or
  // every aimed sniper shot in the game is quietly wider than shared/weapons.js says.
  okB(mul(1, settleMs) === 1 && mul(1, settleMs * 5) === 1,
      'and through settled glass it is exactly the number in the table, and stays there',
      `${mul(1, settleMs)}x at ${settleMs}ms and ${mul(1, settleMs * 5)}x long after`);
  // The instant the glass comes up is the instant it is widest, which is what stops the
  // scope from being a free upgrade a hand can flick on at the last moment.
  okB(Math.abs(mul(1, 0) - hip) < 1e-9,
      'the frame the scope opens is no better than no scope at all',
      `${mul(1, 0).toFixed(0)}x scoped-this-frame against ${hip.toFixed(0)}x from the hip`);

  // Monotone, and quadratic in the time remaining, so the last half of the window is nearly
  // free and the first half is not. Same shape as the movement penalty above and for the
  // same reason: it has to reward waiting a little without demanding a full second.
  const walk = [];
  for (let t = 0; t <= settleMs; t += 10) walk.push(mul(1, t));
  okB(walk.every((v, i) => i === 0 || v < walk[i - 1]),
      'and it closes smoothly the whole way, never widening again',
      `${walk.length} samples from ${walk[0].toFixed(1)}x down to ${walk[walk.length - 1].toFixed(2)}x`);
  const half = mul(1, settleMs / 2);
  okB(half - 1 < 0.35 * (hip - 1),
      'most of the cone is gone by the halfway mark, so a hurried shot is punished not refused',
      `${half.toFixed(1)}x at ${settleMs / 2}ms, which is `
      + `${(100 * (half - 1) / (hip - 1)).toFixed(0)}% of the way back to the hip`);
  // The double scope, and CS2 widens its indicator on the second step too, because the far
  // zoom magnifies the same wobble.
  const far = mul(2, settleMs);
  okB(far > 1 && far < hip,
      'the far zoom is a little wider than the near one, and never wider than the hip',
      `step 1 ${mul(1, settleMs).toFixed(2)}x, step 2 ${far.toFixed(2)}x, hip ${hip.toFixed(0)}x`);

  // What all of that means where the player stands. At duelling range a hip shot's cone is
  // wider than the body it is pointed at; a settled one is a fraction of a head.
  const REF = 20;
  const SN = WEAPONS.sniper;
  const loose = REF * SN.spread * hip;
  const tight = REF * SN.spread * mul(1, settleMs);
  okB(loose > C.PLAYER_HALF_W && tight < C.PLAYER_HALF_W / 4,
      `a no-scope at ${REF}u can miss a body it is aimed dead centre at, and an aimed shot cannot`,
      `${loose.toFixed(2)}u from the hip against a ${C.PLAYER_HALF_W}u half-width, `
      + `${(tight * 100).toFixed(1)}cm scoped`);

  // The body terms still multiply through the glass, so a scoped player who is moving pays
  // for both. Written as the composition rather than as a second literal, because the bug
  // worth catching is a `return` that REPLACED the body term instead of scaling it.
  const runner = { ...glass(1, settleMs), vx: C.MOVE_SPEED * C.SCOPE_SPEED_MUL };
  const bare = spreadMul({ ...runner, scope: 0, scopeMs: 0 }, 'rifle');
  okB(spreadMul(runner, 'sniper') > 1 && Math.abs(spreadMul(runner, 'sniper') - bare) < 1e-9,
      'and moving still costs what moving costs, on top of whatever the glass is doing',
      `${spreadMul(runner, 'sniper').toFixed(3)}x scoped and walking`);

  // A weapon with no scope cannot be affected by one, however hard a client asserts it.
  const liars = [0, 1, 2, C.MAX_SCOPE_STEP].map((sc) => spreadMul(glass(sc, 0), 'rifle'));
  okB(liars.every((v) => v === 1), 'a rifle claiming to be scoped is still just a rifle',
      liars.map((v) => `${v}x`).join(' '));
  // And a call that names no weapon is the body alone, which is what every caller in this
  // file did before the scope existed and what main.js still hands the crosshair bloom.
  const legacy = [0, 1, 2].map((sc) => spreadMul(glass(sc, 0)));
  okB(legacy.every((v) => v === 1), 'and a call that names no weapon is the body alone, as it was',
      legacy.map((v) => `${v}x`).join(' '));

  // The range band the bots read, declared on the weapon so ai.js never has to know what a
  // sniper is. shared/weapons.js throws at import on a band it cannot use, so what is left
  // to check here is that the sniper has one and that nothing else quietly grew one.
  const band = holdBandOf('sniper');
  okB(Array.isArray(band) && band[0] > 0 && band[1] > band[0] && band[1] <= SN.range,
      'the sniper declares the range it wants to be fought at, inside the range it reaches',
      `${band ? band[0] : '?'}-${band ? band[1] : '?'}u of a ${SN.range}u reach`);
  const others = WEAPON_IDS.filter((id) => id !== 'sniper' && holdBandOf(id));
  okB(others.length === 0 && holdBandOf('rifle') === null,
      'and it is the only weapon that asks, so every other bot keeps the default',
      others.length ? `also ${others.join(',')}` : 'sniper alone');
  // The band has to sit OUTSIDE knife range, which is the whole point of it: nine bots
  // holding a 100-damage one-shot inside 14u was the difficulty being complained about.
  okB(band[0] > 14, 'and it stands the bots off well past the range a knife closes',
      `${band[0]}u minimum against the 14u the default band held at`);
}

// ---- the glass as simulation state
{
  // The scope used to live entirely in the browser: input.js latched it, the camera zoomed,
  // and nothing ever left the tab. That is why the cone above could not exist, because the
  // server had no idea whether a shot came through glass, and it is why a scoped player
  // could sprint. Both are the same fix: `sc` on the input, `scope` and `scopeMs` on the
  // body, accumulated inside `stepPlayer` where prediction and authority run the same code.
  const FLOOR = [{ x: 0, y: -50, z: 0, w: 400, h: 100, d: 400 }];
  const wi = indexOf('sniper');
  const ri = indexOf('rifle');
  const inp = (sc, buttons = 0, wep = wi, moveZ = 0) =>
    ({ seq: 1, moveX: 0, moveZ, yaw: 0, pitch: 0, buttons, wep, sc });
  const born = () => createPlayerState({ x: 0, y: C.PLAYER_HALF_H, z: 0, yaw: 0 });

  const fresh = born();
  okB(fresh.scope === 0 && fresh.scopeMs === 0,
      'a fresh body is out of the scope rather than undefined',
      `scope=${fresh.scope} scopeMs=${fresh.scopeMs}`);

  // sanitizeInput is the only door a client's claim comes through, and `sc` is a LEVEL: a
  // dropped toggle edge would leave the two sides permanently disagreeing about what the
  // player is looking through, with no way for either to notice.
  const sane = (raw) => sanitizeInput(raw).sc;
  okB(sane({}) === 0 && sane({ sc: 99 }) === C.MAX_SCOPE_STEP && sane({ sc: -5 }) === 0
      && sane({ sc: 1.7 }) === 1 && sane({ sc: 'sniper' }) === 0 && sane({ sc: NaN }) === 0,
      'the wire may assert a zoom step, and only a whole one inside the ceiling',
      `{} to ${sane({})}, 99 to ${sane({ sc: 99 })}, -5 to ${sane({ sc: -5 })}, `
      + `1.7 to ${sane({ sc: 1.7 })}, "sniper" to ${sane({ sc: 'sniper' })}`);
  okB(Object.hasOwn(EMPTY_INPUT, 'sc') && EMPTY_INPUT.sc === 0,
      'and the filler a starved connection is stepped with names it, so a gap is unscoped',
      'EMPTY_INPUT carries sc: 0 rather than leaving it undefined');

  // Accumulated from dt, never from a wall clock, which is the same argument `restTicks`
  // makes: a Date.now() here would make the cone a different width on each side of the wire.
  //
  // N held ticks buy N-1 of window, not N, and that off-by-one is the point rather than a
  // rounding artefact: the tick the step CHANGES banks nothing, so the first frame through
  // fresh glass is the full hip cone. A player who scopes and fires on the same frame is
  // paying the no-scope price, which is exactly the quick-scope this whole model closes.
  //
  // Stay one tick inside the configured ceiling so this measures accrual rather than clamp.
  const HELD = Math.max(2, Math.floor(SCOPE_SETTLE_MS / (C.TICK_DT * 1000)));
  const up = born();
  for (let i = 0; i < HELD; i++) stepPlayer(up, inp(1), C.TICK_DT, FLOOR);
  okB(up.scope === 1 && Math.abs(up.scopeMs - (HELD - 1) * C.TICK_DT * 1000) < 1e-6,
      'holding the scope accumulates the settle window one dt at a time, starting from zero',
      `scope=${up.scope} scopeMs=${up.scopeMs.toFixed(2)} after ${HELD} ticks `
      + `— the ${(C.TICK_DT * 1000).toFixed(2)}ms the glass came up on is not credited`);
  const opened = born();
  stepPlayer(opened, inp(1), C.TICK_DT, FLOOR);
  okB(opened.scope === 1 && opened.scopeMs === 0
      && spreadMul(opened, 'sniper') === spreadMul({ ...opened, scope: 0 }, 'sniper'),
      'so a shot fired on the very frame the glass arrives is fired through the hip cone',
      `scopeMs=${opened.scopeMs} — ${spreadMul(opened, 'sniper').toFixed(1)}x, `
      + `the same as no scope at all`);

  // THE WINDOW IS BOUNDED AT BOTH ENDS, and the ceiling is the half that is easy to forget:
  // without it a player who held an angle for ten seconds would carry ten seconds of credit
  // into a sprint and arrive across the map still perfectly settled, because the decay below
  // runs at the same rate it accrued at. Bounded, the trade is legible in both directions —
  // one window to earn the shot, one window to give it away.
  const pegged = born();
  for (let i = 0; i < 240; i++) stepPlayer(pegged, inp(1), C.TICK_DT, FLOOR);
  okB(pegged.scopeMs === SCOPE_SETTLE_MS && spreadMul(pegged, 'sniper') === 1,
      'a scope held for four seconds banks the window and not a millisecond more',
      `scopeMs=${pegged.scopeMs} after 240 still ticks, against a ${SCOPE_SETTLE_MS}ms window `
      + `— ${spreadMul(pegged, 'sniper').toFixed(2)}x, the bare zoom with no cone left on it`);

  // AND IT ONLY RUNS FORWARD WHILE THE PLAYER IS STANDING STILL. This is the whole of the
  // sniper fix: the difficulty used to sit in an invisible stopwatch that a player could
  // satisfy while sprinting, so the cone was 80cm wide at 25m for the first eighth of a
  // second of every scope — against a standing pistol's 10cm — and then pinpoint forever
  // after, running or not. Time was the wrong axis. CS2 spends scoped inaccuracy on MOVEMENT,
  // and so does this now: hold still and the glass closes, ask to move and it opens again.
  //
  // Keyed on the INTENT and never on velocity, for the reason `sprintOk` gives: velocity
  // crosses the wire quantised through r3(), `moveX`/`moveZ` are clamped identically by
  // sanitizeInput on both sides, and only one of those two is bit-exact under replay.
  const given = born();
  for (let i = 0; i < 240; i++) stepPlayer(given, inp(1), C.TICK_DT, FLOOR);
  const cone0 = spreadMul(given, 'sniper');
  const TOGO = Math.ceil(SCOPE_SETTLE_MS / (C.TICK_DT * 1000));
  for (let i = 0; i < TOGO; i++) stepPlayer(given, inp(1, 0, wi, 1), C.TICK_DT, FLOOR);
  okB(given.scope === 1 && given.scopeMs === 0 && spreadMul(given, 'sniper') > cone0 * 20,
      'and a settled scope is given back by walking, at the rate it was earned',
      `${TOGO} ticks of moveZ=1 took ${SCOPE_SETTLE_MS}ms of credit back to `
      + `${given.scopeMs}ms — ${cone0.toFixed(2)}x to ${spreadMul(given, 'sniper').toFixed(2)}x, `
      + `still scoped the whole way`);

  // The floor, so the decay cannot go negative and hand a moving player a NEGATIVE green
  // term — which `scopeSpread` squares, so it would come back out as a cone that TIGHTENS
  // the longer you run.
  const run = born();
  for (let i = 0; i < 60; i++) stepPlayer(run, inp(1, 0, wi, 1), C.TICK_DT, FLOOR);
  okB(run.scopeMs === 0 && spreadMul(run, 'sniper') === spreadMul({ ...run, scope: 0 }, 'sniper'),
      'a scope that has only ever moved sits on the floor rather than below it',
      `scopeMs=${run.scopeMs} after a second of walking — ${spreadMul(run, 'sniper').toFixed(1)}x, `
      + `the hip cone, which is what a run-and-flick is worth`);

  // What the rule is actually FOR, in centimetres at the range the duel happens at. A player
  // is PLAYER_HALF_W*2 wide; the cone has to be inside that for the shot to be a shot rather
  // than a coin toss, and the fresh scope this replaced was not.
  const cm = (b) => Math.tan(WEAPONS.sniper.spread * spreadMul(b, 'sniper')) * 25 * 200;
  const WIDE = C.PLAYER_HALF_W * 2 * 100;
  okB(cm(pegged) < WIDE / 4 && cm(born()) > WIDE && cm(run) > WIDE,
      'so a still sniper can hit a man at 25m and a running one cannot, which is the point',
      `${cm(pegged).toFixed(1)}cm settled against a ${WIDE.toFixed(0)}cm target, `
      + `${cm(run).toFixed(0)}cm running, ${cm(born()).toFixed(0)}cm from the hip`);

  // Any CHANGE of step restarts the window, in both directions. Stepping in must not inherit
  // the near zoom's settle, and coming out and going back in must not either, or anyone who
  // scoped once at the start of a round would carry a free pinpoint no-scope for the rest.
  const stepped = born();
  for (let i = 0; i < 12; i++) stepPlayer(stepped, inp(1), C.TICK_DT, FLOOR);
  stepPlayer(stepped, inp(2), C.TICK_DT, FLOOR);
  okB(stepped.scope === 2 && stepped.scopeMs === 0,
      'stepping to the far zoom starts its window from nothing',
      `scope=${stepped.scope} scopeMs=${stepped.scopeMs}`);
  stepPlayer(stepped, inp(0), C.TICK_DT, FLOOR);
  okB(stepped.scope === 0 && stepped.scopeMs === 0, 'and dropping it clears both',
      `scope=${stepped.scope} scopeMs=${stepped.scopeMs}`);
  const BACK = 3;
  for (let i = 0; i < BACK; i++) stepPlayer(stepped, inp(1), C.TICK_DT, FLOOR);
  okB(Math.abs(stepped.scopeMs - (BACK - 1) * C.TICK_DT * 1000) < 1e-6,
      'so a second scope pays the window again rather than inheriting the first',
      `scopeMs=${stepped.scopeMs.toFixed(2)} after ${BACK} ticks back in, against the `
      + `${((HELD - 1) * C.TICK_DT * 1000).toFixed(2)} it had banked before it dropped`);

  // Narrowed against the WEAPON here rather than in sanitizeInput, which has not resolved a
  // loadout yet. A rifle asserting a scope reads 0; a sniper asserting a third zoom reads
  // its second, because two is all it has.
  const liar = born();
  for (let i = 0; i < 6; i++) stepPlayer(liar, inp(2, 0, ri), C.TICK_DT, FLOOR);
  okB(liar.scope === 0 && liar.scopeMs === 0,
      'a rifle cannot be scoped however hard the client asserts it',
      `scope=${liar.scope} after 6 ticks of sc:2 on a rifle`);
  const greedy = born();
  for (let i = 0; i < 6; i++) stepPlayer(greedy, inp(C.MAX_SCOPE_STEP, 0, wi), C.TICK_DT, FLOOR);
  okB(greedy.scope === zoomStepsOf('sniper').length,
      'and a claim past the last zoom reads as the last zoom',
      `sc:${C.MAX_SCOPE_STEP} reads as step ${greedy.scope} of ${zoomStepsOf('sniper').length}`);

  // The speed cap, and the sprint refusal underneath it. CS2 walks an AWP at 100 of 250,
  // which is the whole reason a sniper holds an angle instead of running one down, and
  // fpsbone charged nothing at all for having the glass up.
  const race = (sc, buttons = 0) => {
    const s = born();
    for (let i = 0; i < 240; i++) stepPlayer(s, inp(sc, buttons, wi, 1), C.TICK_DT, FLOOR);
    return s;
  };
  // Two pairs, and the split matters. The CAP is measured against a WALK, because a scoped
  // body cannot sprint at all — comparing it to a sprint would fold the refusal below into
  // the ratio and neither number would mean anything. The sprint pair exists to measure that
  // refusal, through the stamina bar.
  const walk = race(0);
  const shut = race(1);
  const open = race(0, C.BTN_SPRINT);
  const held = race(1, C.BTN_SPRINT);
  const speed = (s) => Math.hypot(s.vx, s.vz);
  okB(walk.grounded && shut.grounded && open.grounded,
      'the bodies are on the floor, so the caps below are real rather than an airborne tie',
      `grounded ${walk.grounded} / ${shut.grounded} / ${open.grounded}`);
  // Asserted as a RATIO of the same body unscoped, not against `MOVE_SPEED * SCOPE_SPEED_MUL`
  // directly. Friction is subtracted every tick after the acceleration is added, so a walk
  // converges to a steady state a fixed fraction below whatever cap it is chasing — 3.733 of
  // a nominal 4.2 here — and an equality against the nominal would fail on a body that is
  // obeying the cap perfectly. The ratio is exact, and it is the number CS2 states.
  okB(speed(shut) <= C.MOVE_SPEED * C.SCOPE_SPEED_MUL + 1e-9
      && Math.abs(speed(shut) / speed(walk) - C.SCOPE_SPEED_MUL) < 1e-6,
      'a scoped player walks at the fraction of his own walk the glass sets, and no faster',
      `${speed(shut).toFixed(3)}u/s of the ${speed(walk).toFixed(3)} he walks unscoped `
      + `— ${(speed(shut) / speed(walk)).toFixed(4)} against the ${C.SCOPE_SPEED_MUL} asked for, `
      + `under the ${(C.MOVE_SPEED * C.SCOPE_SPEED_MUL).toFixed(3)} ceiling`);
  okB(speed(shut) > 1 && speed(open) > speed(shut) * 2.5,
      'and it is a walk rather than a stop — the same body running is well over twice as fast',
      `${speed(open).toFixed(3)}u/s sprinting unscoped against ${speed(shut).toFixed(3)} scoped`);
  // The glass caps the body even while it is asking to sprint, which is the case a Math.min
  // over three multipliers has to get right and the one a player will actually produce:
  // nobody lets go of shift to scope.
  okB(Math.abs(speed(held) - speed(shut)) < 1e-9,
      'and asking to sprint through the glass buys not one unit per second of it',
      `${speed(held).toFixed(3)}u/s with shift held, ${speed(shut).toFixed(3)} without`);
  // The sprint refusal, observed through the bar rather than asserted about a private helper:
  // a body that is genuinely sprinting drains stamina, and one `sprintOk` refused never
  // touches it. So this is also the check that the refusal is not merely being masked by the
  // Math.min on the speed.
  okB(open.stamina < C.SPRINT_STAMINA_MAX && held.stamina === C.SPRINT_STAMINA_MAX,
      'holding BTN_SPRINT through a scope is not sprinting, and does not spend the bar for it',
      `unscoped drained to ${open.stamina}, scoped still ${held.stamina} of ${C.SPRINT_STAMINA_MAX}`);
}

// ---- the glass, and the three ways it was left standing over a weapon that has none
//
// `scopeStep` narrows the scope against the weapon in the INPUT, and the room has two
// paths that put a weapon in that field which is not the weapon in the player's hand: a
// swap it refuses, and the starvation filler, which repeats the last input a player sent.
// Both shipped, and the second one had a symptom in the game: a bot that died holding the
// sniper came back holding a shotgun WITH THE SCOPE UP — the filler restated the dead
// man's `wep: sniper, sc: 1` on the respawn tick, `scopeStep` raised the glass off it, and
// `applyWeapon` is not on the filler path so the shotgun stayed in hand. The body then
// walked at 40% speed, could not sprint, and had nothing on screen to explain either.
//
// Found from outside as a rate — one or two ticks in ten thousand, which is exactly why
// the Part F check for it failed one run in three and passed the others. These are the
// same invariant asserted deterministically, in the three places it can break.
{
  const room = new Room('sniper');
  const id = room.add('stall', {});
  const p = room.players.get(id);
  room.drainEvents();
  const SNI = indexOf('sniper');
  const KNI = indexOf('knife');
  let seq = 0;
  /** A tick with an input, or — with no argument — a tick that starves and fills. */
  const tick = (patch) => {
    if (patch) {
      room.queueInput(id, [{ seq: ++seq, moveX: 0, moveZ: 0, yaw: p.yaw, pitch: 0,
                             buttons: 0, wep: p.wep, ...patch }]);
    }
    room.step();
    room.drainEvents();
  };

  tick({ wep: SNI, sc: 1 });
  okB(p.wep === SNI && p.scope === 1, 'a scoped weapon asked for the glass gets it',
      `holding ${WEAPON_IDS[p.wep]} at step ${p.scope}`);
  const settled = p.scopeMs;
  tick();
  okB(p.scope === 1 && p.scopeMs > settled,
      'and a connection that stalls keeps the glass up, and keeps it settling',
      `${r3(settled)}ms before the stall, ${r3(p.scopeMs)}ms after a filler tick`);

  // The swap. Down through the input, then starved — the filler must not put back the
  // scope of a weapon that is no longer in this hand.
  tick({ wep: KNI, sc: 1 });
  okB(p.wep === KNI && p.scope === 0, 'swapping to a weapon with no glass lowers it',
      `holding ${WEAPON_IDS[p.wep]} at step ${p.scope}`);
  tick();
  tick();
  okB(p.wep === KNI && p.scope === 0,
      'and a stall does not raise it again off the weapon the player used to hold',
      `${WEAPON_IDS[p.wep]}, scope ${p.scope} after two filler ticks`);

  // The refused swap. `applyWeapon` grants a change only out of `p.allowed`, so a weapon
  // this mode never dealt is not a cheat — it is an ordinary input the room says no to.
  // Said no to AFTER `stepPlayer` had already read it, which is what made it a bug.
  const other = new Room('snow');
  const oid = other.add('asker', {});
  const q = other.players.get(oid);
  other.drainEvents();
  okB(!q.allowed.has(SNI) && !scopes(idAt(q.wep)),
      'a snowball fight deals no scoped weapon at all, which is the premise of the next check',
      `holding ${WEAPON_IDS[q.wep]}, allowed ${[...q.allowed].map((i) => WEAPON_IDS[i]).join(',')}`);
  const held = q.wep;
  for (let i = 1; i <= 4; i++) {
    other.queueInput(oid, [{ seq: i, moveX: 0, moveZ: 0, yaw: q.yaw, pitch: 0,
                             buttons: 0, wep: SNI, sc: 1 }]);
    other.step();
    other.drainEvents();
  }
  okB(q.wep === held && q.scope === 0 && q.scopeMs === 0,
      'asking for a weapon the loadout refuses cannot raise a scope over the one in hand',
      `still ${WEAPON_IDS[q.wep]}, scope ${q.scope} after 4 ticks of asking for the sniper`);

  // The respawn, which is the one that shipped. Killed while scoped, and then not sending
  // anything — a browser mid-death-cam sends nothing, so the filler is the whole of what
  // the fresh body is stepped with on the tick it comes back.
  tick({ wep: SNI, sc: 1 });
  tick({ wep: SNI, sc: 1 });
  okB(p.scope === 1, 'scoped again, and about to be killed for it', `step ${p.scope}`);
  room.applyDamage(null, p, C.MAX_HP, -1);
  okB(!p.alive, 'the scoped body is down', `hp ${p.hp}`);
  let respawned = -1;
  for (let i = 0; i < C.TICK_HZ * 12 && respawned < 0; i++) {
    tick();                          // nothing sent, all the way through the death cam
    if (p.alive) respawned = i;
  }
  okB(respawned >= 0, 'and comes back without the player having sent a thing',
      `alive again ${respawned + 1} ticks later, holding ${WEAPON_IDS[p.wep]}`);
  okB(p.scope === 0 && p.scopeMs === 0,
      'and it comes back with the glass DOWN, not with a dead man\u2019s scope over a fresh hand',
      `scope ${p.scope}, ${r3(p.scopeMs)}ms — this read 1 before the filler stopped repeating \`wep\``);
  // And the fresh body moves like one. A leaked scope reads as a number in a probe; what a
  // player felt was a spawn that walked at 40% and would not sprint however hard they held
  // shift. So this is asserted where they felt it — as speed, against the cap a scope imposes.
  for (let i = 0; i < 150; i++) tick({ wep: p.wep, sc: 0, moveZ: 1, buttons: C.BTN_SPRINT });
  const fresh = Math.hypot(p.vx, p.vz);
  okB(fresh > C.MOVE_SPEED * C.SCOPE_SPEED_MUL * 1.5,
      'so a fresh spawn runs like a fresh spawn rather than crawling at a scope it never raised',
      `${fresh.toFixed(3)}u/s against the ${(C.MOVE_SPEED * C.SCOPE_SPEED_MUL).toFixed(3)} a scope caps at`);

  // The other half of the same rule, and the reason `respawn` empties the queue rather than
  // trusting the tick that cleared it while dead: `step` clears a corpse's inputs on every
  // tick it stays down, but the tick it comes BACK it respawns first and consumes second, so
  // anything that arrived in the gap is a dead man's intent applied to a live body — aimed
  // where the corpse was aiming, walking where the corpse was walking, in a body that has
  // just been teleported somewhere else entirely.
  room.applyDamage(null, p, C.MAX_HP, -1);
  tick();
  p.respawnAt = room.now();          // due on the very next step
  const before = p.lastSeq;
  room.queueInput(id, [{ seq: before + 50, moveX: 1, moveZ: 1, yaw: p.yaw + 2, pitch: 0,
                         buttons: C.BTN_SPRINT, wep: p.wep, sc: 0 }]);
  room.step();
  room.drainEvents();
  okB(p.alive && p.lastSeq === before && Math.hypot(p.vx, p.vz) === 0,
      'and nothing queued by the corpse is applied to the body that replaces it',
      `alive, still on seq ${p.lastSeq}, standing at ${r3(Math.hypot(p.vx, p.vz))}u/s`);
}

// ---- the rewind, first on its own terms
{
  const now = 1000;
  okB(rewindTimeFor(0, now) === 0, 'no view stamp means no rewind at all',
      'which is what a bot sends, and a bot never crossed a network');
  okB(rewindTimeFor(now, now) === now - C.INTERP_DELAY_MS,
      `a current stamp rewinds by exactly INTERP_DELAY_MS (${C.INTERP_DELAY_MS}ms)`,
      `${rewindTimeFor(now, now)}`);
  // The clamp is the security boundary, and it is why the stamp is server-issued. A client
  // can only usefully lie backwards — to shoot where somebody used to be — and this bounds
  // what that buys. Lying forwards asks to be rewound into the future, which is just the
  // old uncompensated behaviour.
  okB(rewindTimeFor(now + 5000, now) === now,
      'a stamp from the future clamps to the present', `${rewindTimeFor(now + 5000, now)}`);
  okB(rewindTimeFor(1, now) === now - C.MAX_REWIND_MS,
      `and one from the distant past clamps at MAX_REWIND_MS (${C.MAX_REWIND_MS}ms)`,
      `${rewindTimeFor(1, now)} — this clamp is the security boundary`);
  okB(C.MAX_REWIND_MS >= C.INTERP_DELAY_MS,
      'the clamp leaves room for the interpolation delay it exists to undo',
      `${C.MAX_REWIND_MS}ms of rewind for ${C.INTERP_DELAY_MS}ms of delay`);

  // Interpolated between samples, not snapped to the nearest. Snapping would quantise
  // every target to 7cm of jitter at walking speed — a smaller copy of the exact problem
  // the rewind exists to remove.
  const p = {
    x: 9, y: 9, z: 9, crouch: 0,
    history: [
      { t: 100, x: 0, y: 1, z: 0, cr: 0 },
      { t: 200, x: 2, y: 1, z: 4, cr: 1 },
    ],
  };
  const mid = rewind(p, 150);
  okB(Math.abs(mid.x - 1) < 1e-9 && Math.abs(mid.z - 2) < 1e-9 && Math.abs(mid.crouch - 0.5) < 1e-9,
      'a rewind between two samples interpolates place and stance together',
      `x=${mid.x} z=${mid.z} crouch=${mid.crouch}`);
  okB(rewind(p, 0) === p && rewind(p, 400) === p,
      'and falls through to the live body when there is nothing to rewind to',
      'at=0, and at newer than the newest sample');
  const old = rewind(p, 10);
  okB(old.x === 0 && old.z === 0, 'older than the whole ring gives the oldest sample on record',
      `x=${old.x} z=${old.z}`);
}

// ---- the rewind, against a moving target
{
  // "you cant even hit good with sniper when they move it is so damn hard even tho it is
  // 100 damage it still make no sense if it cannot hit."
  //
  // Every remote player is drawn INTERP_DELAY_MS in the past — that is what makes other
  // people move smoothly instead of teleporting between snapshots — so a shot placed dead
  // centre on what the shooter SEES is a shot at where they were. At MOVE_SPEED that is
  // 0.42u against a body 0.80u wide, before one millisecond of ping. This is that miss,
  // measured, and then the identical shot with the rewind switched on.
  const LEAD = Math.round(C.INTERP_DELAY_MS / STEP_MS);
  const perTick = C.MOVE_SPEED / C.TICK_HZ;
  const attempt = (compensate) => {
    const room = new Room(DEFAULT_MODE);
    room.rand = () => 1;
    const idA = room.add('shooter', {});
    const idB = room.add('mover', {});
    const A = room.players.get(idA);
    const B = room.players.get(idB);
    room.drainEvents();
    A.allowed = room.allowed;
    const wi = indexOf('sniper');
    // Long enough for the deploy clamp to expire, and the target is parked for all of it —
    // so the history the rewind reads is a straight line through the shooter's aim, and
    // only then does the target start walking across it.
    const warm = Math.ceil(switchMsOf('sniper') / STEP_MS) + 4;
    const total = warm + LEAD + 1;
    let seq = 0;
    let hit = null;
    let liveOffset = 0;
    for (let t = 0; t < total; t++) {
      A.x = line.x; A.y = C.PLAYER_HALF_H; A.z = line.z;
      A.vx = A.vy = A.vz = 0; A.grounded = true; A.protectedUntil = 0;
      B.x = line.x + GAP; B.y = C.PLAYER_HALF_H;
      B.z = line.z + perTick * Math.max(0, t - warm);
      B.vx = B.vy = B.vz = 0; B.grounded = true; B.protectedUntil = 0;
      liveOffset = B.z - line.z;
      room.queueInput(idA, [{
        seq: ++seq, moveX: 0, moveZ: 0, yaw: YAW_EAST, pitch: pitchTo(AIM_BODY),
        buttons: t === total - 1 ? C.BTN_FIRE : 0, wep: wi,
        // Scoped, for the whole run, and that is what makes the miss below mean something.
        // The cone is the sniper's own 0.0008rad only through settled glass; asserted from
        // the hip it is forty times that, wide enough for a shot the rewind should have
        // missed to connect by luck a third of the time. The warm-up above is ~1s against a
        // 200ms settle, so by the tick that fires the glass is fully closed — and the shot
        // that lands with `vt` set now additionally proves `sc` survived sanitizeInput and
        // reached resolveShot, since a dropped one would reopen the cone.
        sc: 1,
        // The stamp a client would send: the server's own clock as of the frame the shooter
        // was looking at. `room.now()` is the same `now` tryFire will read, which models a
        // zero-ping client — the honest best case for the mechanism, and the one where a
        // miss can only be the mechanism's fault.
        vt: compensate ? room.now() : 0,
      }]);
      room.step();
      const ev = room.drainEvents().find((e) => e.e === EV.HIT);
      if (ev) hit = ev;
    }
    return { hit, lead: liveOffset };
  };
  const off = attempt(false);
  const on = attempt(true);
  okB(off.lead > C.PLAYER_HALF_W,
      'a target at walking pace ends up further from where it is drawn than the body is wide',
      `${off.lead.toFixed(3)}u of lead against a ${C.PLAYER_HALF_W}u half-width`);
  okB(off.hit === null,
      'so without the rewind, a shot dead centre on what the shooter sees misses',
      off.hit ? `it connected anyway for ${C.MAX_HP - off.hit.hp}` : 'clean miss');
  okB(on.hit !== null, 'and with the rewind, the identical shot connects',
      on.hit ? `hp ${on.hit.hp} left` : 'still missed — the rewind is not reaching resolveShot');
  okB(on.hit !== null && C.MAX_HP - on.hit.hp === WEAPONS.sniper.dmg,
      `for the ${WEAPONS.sniper.dmg} the table promises`,
      on.hit ? `${C.MAX_HP - on.hit.hp} damage, zone ${on.hit.z ?? 0}` : 'n/a');
  okB(on.hit !== null && (on.hit.z ?? HIT_ZONE.BODY) === HIT_ZONE.BODY,
      'and the rewound body is measured for its zone too, not just for whether it was there',
      `z=${on.hit?.z ?? 'omitted (body)'}`);
}

// ---- the clock the client reads its view stamp off
{
  // client/src/net.js derives the stamp it sends from `snap.tick - 1`, and this is the
  // relationship that makes the minus one correct: index.js builds the snapshot AFTER the
  // step that stamped the history, so the tick on the wire is one ahead of the sim time the
  // state it carries describes. Asserted here rather than putting a second time field on
  // the protocol — a duplicate would be a second source of truth to keep in sync, and this
  // is the file that would have caught it drifting.
  const r = duel({ ms: 0 });
  r.run(12, 0);
  const snap = r.room.snapshotBase();
  okB(typeof snap.tick === 'number',
      'the snapshot carries the tick the client sets its clock by', `tick=${snap.tick}`);
  const srvMs = ((snap.tick - 1) * 1000) / C.TICK_HZ;
  const stamps = [...r.room.players.values()].map((p) => p.history[p.history.length - 1]?.t);
  okB(stamps.length > 0 && stamps.every((t) => t === srvMs),
      'and tick minus one is exactly the sim time its history was stamped at',
      `snapshot says ${srvMs}, history says ${stamps.join(', ')}`);
  // The round trip the client actually performs, with the holding time set to zero: the
  // stamp it sends back has to name a moment the rewind can still reach.
  const vt = srvMs;
  const at = rewindTimeFor(vt, r.room.now());
  const oldest = [...r.room.players.values()][0].history[0].t;
  okB(at >= oldest && at < r.room.now(),
      'a stamp built that way lands inside the history ring, not off the end of it',
      `rewind to ${at.toFixed(1)}ms, ring covers ${oldest.toFixed(1)}..${r.room.now().toFixed(1)}ms`);
}

console.log([...pB, ...fB].join('\n'));

// ──────────────────────────── Part C: prediction round-trip (the climb bug)
// Twice now a playtest has reported walking into a wall and ending up standing on
// top of it. The cause was never in stepPlayer — which is why 1.6M fuzzed ticks
// came back clean — but in the seam between the server and the client:
//
//   1. the server leaves a body resting a hair off the wall (the EPS skin),
//   2. the snapshot rounds its position (r3, max error 0.0005),
//   3. if the skin is smaller than that error the body arrives *inside* the wall,
//   4. predict.reconcile assigns that position verbatim and replays a tick, and
//      gravity — a downward move — resolves against the box's TOP face.
//
// A 7-unit correction blows past predict.js's SMOOTH_MAX, so it snaps: you are
// simply on the roof. Nothing else in this file crosses the wire quantisation, so
// without this section the whole failure mode is invisible to `npm run verify`.
console.log('\n=== Part C — prediction round-trip (wall climb regression) ===\n');

const pC = [];
const fC = [];
const okC = (cond, label, detail = '') => {
  (cond ? pC : fC).push(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

{
  const inside = (s) => WORLD_BOXES.some((b) => overlapsBox(s.x, s.y, s.z, ...H, b));
  // The tallest perimeter wall: the one whose top surface is far enough above the
  // floor that being placed on it is unmistakable rather than a rounding artefact.
  const wall = WORLD_BOXES.find((b) => b.z < -20 && b.h > 5);
  okC(!!wall, 'found a tall wall to walk into', wall ? `top at y=${wall.y + wall.h / 2}` : 'none');

  // Hold forward into the wall, quantise as the wire does, then replay one tick the
  // way predict.js does. Swept along the wall because the failure depended on the
  // exact bit pattern of the rounded coordinate — a single sample missed it.
  //
  // The line swept along is searched for, not written down. It used to be a literal
  // x ∈ [-18, 18] at z = -19, and when the arena was rebuilt 47 of those 120 samples
  // started inside a crate — which does not fail loudly, it quietly makes `embedded`
  // count geometry the test put the body in rather than anything the wire did to it.
  // Widest clear band wins, so it keeps finding a useful sweep as the map changes.
  let band = { n: 0, z: 0, x0: 0 };
  for (let z = -R; z <= R; z += 0.5) {
    let run = null;
    const close = (x) => {
      if (run === null) return;
      if (x - run > band.n) band = { n: x - run, z, x0: run };
      run = null;
    };
    for (let x = -R; x <= R; x += 0.5) {
      if (clearAt(x, z)) run ??= x;
      else close(x - 0.5);
    }
    close(R);
  }
  okC(band.n >= 8, 'found a clear line to sweep along', `${band.n.toFixed(1)}u wide at z=${band.z}`);

  const SAMPLES = 120;
  const push = { moveX: 0, moveZ: 1, yaw: 0, pitch: 0, buttons: 0, wep: 0 };
  let embedded = 0;
  let launched = 0;
  let worstRise = 0;

  for (let i = 0; i < SAMPLES; i++) {
    const s = createPlayerState({ x: band.x0 + (i * band.n) / SAMPLES, y: C.PLAYER_HALF_H, z: band.z, yaw: 0 });
    for (let t = 0; t < 200; t++) stepPlayer(s, push, C.TICK_DT, WORLD_BOXES);

    const c = createPlayerState({ x: r3(s.x), y: r3(s.y), z: r3(s.z), yaw: 0 });
    c.vx = s.vx; c.vy = s.vy; c.vz = s.vz; c.grounded = s.grounded;
    if (inside(c)) embedded++;

    const y0 = c.y;
    stepPlayer(c, push, C.TICK_DT, WORLD_BOXES);
    const rise = c.y - y0;
    if (rise > C.STEP_HEIGHT) launched++;
    worstRise = Math.max(worstRise, rise);
  }

  okC(embedded === 0, 'wire rounding never embeds a body resting against solid geometry',
      `${embedded}/${SAMPLES} embedded`);
  okC(launched === 0, 'replaying from a quantised position never climbs what it rests on',
      `${launched}/${SAMPLES} launched, worst single-tick rise ${worstRise.toFixed(4)}u (step limit ${C.STEP_HEIGHT})`);

  // The invariant behind the fix, asserted directly so a future edit to either
  // number fails here with the reason rather than as a mysterious teleport.
  okC(EPS > 0.0005, 'the contact skin exceeds the wire rounding error',
      `EPS=${EPS} vs max r3 error 0.0005`);

  // depenetrate() is the last line of defence: whatever puts a body inside geometry,
  // one call must get it out, and must not resolve an overlap by launching it upward
  // when a sideways nudge is shorter.
  const stuck = createPlayerState({ x: 0, y: C.PLAYER_HALF_H, z: wall ? wall.z + wall.d / 2 : -21.4, yaw: 0 });
  const yBefore = stuck.y;
  okC(inside(stuck), 'test body starts genuinely inside the wall', `z=${stuck.z.toFixed(3)}`);
  depenetrate(stuck, H, WORLD_BOXES);
  okC(!inside(stuck), 'depenetrate pushed it clear in one call',
      `z ${stuck.z.toFixed(3)}, y ${stuck.y.toFixed(3)}`);
  okC(Math.abs(stuck.y - yBefore) < 1e-9, 'depenetrate chose the horizontal axis, not upward',
      `y moved ${(stuck.y - yBefore).toFixed(6)}`);
}


/** A bare floor, 400u square, with nothing on it. Speed and flight measurements run
 *  here rather than in the arena, where a wall would end the run early and turn a
 *  measurement of the movement rules into a measurement of the level.
 *
 *  The stamina round-trips below need it for a second reason, worth stating because the
 *  arena looks like the more honest choice and is not. Their position bound exists to
 *  catch a dropped stamina field: one tick at the wrong speed cap is 0.010u, so the
 *  bound has to sit below that. On WORLD_BOXES it cannot -- the wire hands the replay a
 *  position already rounded to 0.0005u, and near a step that half-millimetre decides
 *  whether the body climbs, which lands the baseline divergence at 0.020u and buries the
 *  very signal the assert is for. Geometry against the movement rules is fuzz.mjs's job,
 *  over millions of ticks at full float precision with no wire in the way. */
const FLAT = [{ x: 0, y: -50, z: 0, w: 400, h: 100, d: 400 }];

// Stamina across the wire. It is simulation state the replay reads to choose a speed cap, so
// it has to survive snapshot → self blob → reconcile → replay bit-exact. The failure mode is
// not a wrong number on screen; it is that one tick of cap disagreement makes the client's
// predicted position drift from the server's and never come back, which reads as jitter with
// no obvious cause. crouch and jumpHeld are the precedent for all of this.
{
  // The client runs ahead of the server by whatever the round trip costs. Reconcile assigns
  // authority for a tick already acknowledged and then re-simulates everything since, so the
  // question is whether that replay lands on the same numbers the server will reach.
  const LAG = 8;
  // On FLAT, and the collision set is the load-bearing part of this line rather than a
  // detail. Stepped through WORLD_BOXES this same body is inside the 14x2.8x11 block at
  // map centre: it never grounds, `sprintOk` refuses on `!s.grounded` every tick, and
  // stamina sits at MAX for the whole run -- so every zero-error assert below compares two
  // constants and passes no matter what the code under test does. That is what this block
  // did before the coverage assert after the authority loop existed to forbid it.
  const born = () => createPlayerState({ x: 0, y: C.PLAYER_HALF_H, z: 0, yaw: 0 });
  const TICKS = 60 * 14; // long enough to cross empty, the rest delay and a lockout release

  // One input stream, driven so it actually visits the interesting states rather than
  // holding one of them: sprint through empty, let it recover, sprint again, and jump.
  const inputs = [];
  for (let t = 0; t < TICKS + LAG; t++) {
    let buttons = 0;
    if (t < 340 || (t > 480 && t < 620) || t > 700) buttons |= C.BTN_SPRINT;
    // Jumps, but none inside the first sprint window. Airborne ticks do not drain — a
    // deliberate rule, since bunny-hopping already out-runs a ground sprint — so a jump every
    // 97 ticks eats 43 ticks of drain and the bar bottoms out around 83 instead of reaching
    // empty. The window that has to hit empty stays on the floor; the jumps that exercise the
    // same cap in the air come after it, which is the order the coverage assert enforces.
    if (t % 97 === 0 && t > 340) buttons |= C.BTN_JUMP;
    if (t > 380 && t < 430) buttons |= C.BTN_CROUCH;
    inputs.push({ moveX: 0, moveZ: 1, yaw: 0.4, pitch: 0, buttons, wep: 0, seq: t });
  }

  // Authority, recorded tick by tick so a prediction can be checked against the tick it
  // was actually predicting.
  const srv = born();
  const auth = [];
  for (let t = 0; t < inputs.length; t++) {
    stepPlayer(srv, inputs[t], C.TICK_DT, FLAT);
    auth.push({ x: srv.x, y: srv.y, z: srv.z, vx: srv.vx, vy: srv.vy, vz: srv.vz,
                grounded: srv.grounded, crouch: srv.crouch, jumpHeld: srv.jumpHeld,
                stamina: srv.stamina, restTicks: srv.restTicks, sprintLock: srv.sprintLock });
  }

  // Coverage, asserted rather than assumed. A "worst error 0" is only worth something if
  // the field it watches actually moved -- so the authority stream itself has to be shown
  // to visit empty, the regen delay, the lockout and a refill before any agreement between
  // the two sides means anything at all.
  const stams = auth.map((a) => a.stamina);
  const emptyAt = stams.indexOf(0);
  const cov = {
    lo: Math.min(...stams), hi: Math.max(...stams), n: new Set(stams).size,
    ground: auth.filter((a) => a.grounded).length,
    rest: auth.filter((a) => a.restTicks > 0).length,
    lock: auth.filter((a) => a.sprintLock).length,
    back: emptyAt < 0 ? 0 : Math.max(...stams.slice(emptyAt)),
  };
  okC(cov.lo === 0 && cov.back >= C.SPRINT_MIN_START && cov.n > 100 && cov.rest > 0
      && cov.lock > 0 && cov.lock < auth.length && cov.ground > auth.length * 0.5,
      'the body under test really does sprint itself empty and recover',
      `stamina ${cov.lo}..${cov.hi} over ${cov.n} distinct values, refilled to ${cov.back} `
      + `after empty at t=${emptyAt}, ${cov.lock} ticks locked out and ${cov.rest} in the `
      + `regen delay, grounded on ${cov.ground}/${auth.length}`);

  // The wire, modelled exactly as server/index.js builds it: r3() on the continuous fields,
  // verbatim on the integers.
  const wire = (a) => ({
    snap: { x: r3(a.x), y: r3(a.y), z: r3(a.z), cr: r3(a.crouch) },
    self: { vx: r3(a.vx), vy: r3(a.vy), vz: r3(a.vz), g: a.grounded ? 1 : 0,
            jh: a.jumpHeld ? 1 : 0, st: a.stamina, rt: a.restTicks, sl: a.sprintLock ? 1 : 0 },
  });

  let worstStamina = 0, worstPos = 0, restMiss = 0, lockMiss = 0;
  for (let t = 0; t + LAG < inputs.length; t++) {
    const { snap, self } = wire(auth[t]);
    // predict.js reconcile(), field for field.
    const cli = born();
    cli.x = snap.x; cli.y = snap.y; cli.z = snap.z;
    cli.crouch = snap.cr;
    cli.vx = self.vx; cli.vy = self.vy; cli.vz = self.vz;
    cli.grounded = !!self.g;
    cli.jumpHeld = !!self.jh;
    cli.stamina = self.st ?? C.SPRINT_STAMINA_MAX;
    cli.restTicks = self.rt ?? 0;
    cli.sprintLock = !!self.sl;
    cli.yaw = inputs[t].yaw;
    for (let k = t + 1; k <= t + LAG; k++) stepPlayer(cli, inputs[k], C.TICK_DT, FLAT);

    const a = auth[t + LAG];
    worstStamina = Math.max(worstStamina, Math.abs(cli.stamina - a.stamina));
    worstPos = Math.max(worstPos, Math.hypot(cli.x - a.x, cli.y - a.y, cli.z - a.z));
    if (cli.restTicks !== a.restTicks) restMiss++;
    if (cli.sprintLock !== a.sprintLock) lockMiss++;
  }

  okC(worstStamina === 0, 'stamina survives the wire and an 8-tick replay with zero error',
      `worst |client − server| ${worstStamina} of ${C.SPRINT_STAMINA_MAX} over ${TICKS} ticks`);
  okC(restMiss === 0 && lockMiss === 0,
      'and so do the two latches the bar carries with it',
      `${restMiss} restTicks and ${lockMiss} sprintLock mismatches`);
  // Position is allowed the r3 rounding it was handed and nothing more. A dropped stamina
  // field shows up here as centimetres, not as a rounding error — one tick at the wrong cap
  // is 0.010u, twenty times this bound.
  okC(worstPos < 0.002, 'so the predicted position stays inside the wire rounding it started from',
      `worst divergence ${(worstPos * 1000).toFixed(3)}mm after ${LAG} replayed ticks`);

  // The three legs of the contract, checked in the source rather than inferred, because a
  // missing one costs permanent jitter and no error anywhere.
  const mvSrc = readFileSync(new URL('./shared/movement.js', import.meta.url), 'utf8');
  const kin = mvSrc.match(/const KINEMATIC = \[([\s\S]*?)\]/)?.[1] ?? '';
  const svSrc = readFileSync(new URL('./server/index.js', import.meta.url), 'utf8');
  const prSrc = readFileSync(new URL('./client/src/predict.js', import.meta.url), 'utf8');
  const fields = ['stamina', 'restTicks', 'sprintLock'];
  okC(fields.every((f) => kin.includes(`'${f}'`)), 'all three fields are listed in KINEMATIC',
      fields.filter((f) => !kin.includes(`'${f}'`)).join(',') || kin.replace(/\s+/g, ' ').trim());
  okC(['st:', 'rt:', 'sl:'].every((k) => svSrc.includes(k)),
      'the self blob sends all three to the player they belong to',
      ['st:', 'rt:', 'sl:'].filter((k) => !svSrc.includes(k)).join(',') || 'st, rt, sl');
  okC(fields.every((f) => prSrc.includes(`state.${f}`)), 'and reconcile restores all three',
      fields.filter((f) => !prSrc.includes(`state.${f}`)).join(',') || 'all present');
  // Sent raw. r3() on any of them is the bug these asserts exist to catch.
  okC(!/\br3\(p\.(stamina|restTicks|sprintLock)\)/.test(svSrc),
      'and sends them raw, never through r3()',
      'integers survive JSON exactly; a rounded float would not');
  // Defaults, not bare assignment: an older server omits the field, and `state.stamina =
  // self.st` would quietly turn undefined into NaN and carry it into position.
  okC(/state\.stamina = self\.st \?\?/.test(prSrc) && /state\.restTicks = self\.rt \?\?/.test(prSrc),
      'reconcile defaults them rather than assigning undefined',
      'a missing field must mean a full bar, not NaN');

  // And the reason the bar is counted in whole units at all, as a number rather than a claim:
  // had it been the 0..1 fraction a HUD would want, r3()'s 0.0005 error would be this much of
  // a single tick's drain — enough for the two sides to cross empty on different ticks.
  const share = 0.0005 / (C.SPRINT_DRAIN / C.SPRINT_STAMINA_MAX);
  okC(share > 0.05, 'a normalised float bar would not have survived the same wire',
      `r3 error is ${(share * 100).toFixed(0)}% of one tick's drain as a 0..1 fraction, `
      + `against exactly 0 for ${C.SPRINT_DRAIN} of ${C.SPRINT_STAMINA_MAX} whole units`);
}

// And the same field through the REAL reconcile, at the latency the client ships a switch for.
//
// Everything above transcribes predict.js field for field, which cannot catch reconcile doing
// something the transcription does not — an assignment in the wrong order, a field restored
// under a guard, a `pending` shift that consumes the wrong inputs. So this block imports the
// actual predictor and drives it.
//
// The latency is the one net.js documents as the only setting that exercises this at all:
// `?lag=150&jitter=30`. That is 75±15ms each way, so the client is nine-ish inputs ahead of
// anything it has been told about and the number is different on every snapshot — which is the
// part a fixed LAG cannot test, because a constant offset lets a wrong replay length be
// consistently wrong and still land on the right answer.
//
// Why it needs a number rather than a look: nine ticks at the wrong speed cap is 0.09u, and
// reconcile eases out any correction under SMOOTH_MAX over a few frames. A dropped stamina
// field would therefore be invisible on screen while the two sides simulated different
// physics — a silent desync, which is the thing this asserts against.
//
// This one runs on WORLD_BOXES rather than FLAT, and not by preference: predict.js hardcodes
// WORLD_BOXES at :37 and :107, so authority has to be stepped through the same set or the two
// sides are simulating different levels. That is also why it spawns from SPAWNS[0] — the
// origin is inside the block at map centre, where a body never grounds and so never sprints.
{
  const { createPredictor } = await import('./client/src/predict.js');
  const prSrc2 = readFileSync(new URL('./client/src/predict.js', import.meta.url), 'utf8');
  const SMOOTH_MAX = Number(/const SMOOTH_MAX = ([\d.]+);/.exec(prSrc2)?.[1]);
  const SPAWN = SPAWNS[0];
  const LAG_MS = 150;
  const JITTER_MS = 30;
  const LAG = (LAG_MS / 1000) * C.TICK_HZ;              // 9 ticks of round trip
  const JIT = (JITTER_MS / 1000) * C.TICK_HZ;           // ±1.8 of them, net.js halves both
  const TICKS = 60 * 20;

  // Inputs that visit the states worth visiting instead of holding one: sprint into empty,
  // rest, sprint again on a partial bar, jump mid-sprint, duck mid-sprint, and walk while
  // still armed. Yaw moves so the replay is not a straight line, which is what makes a
  // wrong-length replay show up in position at all.
  const inputs = [];
  for (let t = 0; t < TICKS; t++) {
    let buttons = 0;
    if (t < 320 || (t > 500 && t < 700) || t > 780) buttons |= C.BTN_SPRINT;
    if (t % 89 === 0) buttons |= C.BTN_JUMP;
    if (t > 900 && t < 960) buttons |= C.BTN_CROUCH;
    if (t > 1000 && t < 1060) buttons |= C.BTN_WALK;
    inputs.push({ moveX: 0, moveZ: 1, yaw: SPAWN.yaw + Math.sin(t / 40) * 0.6,
                  pitch: 0, buttons, wep: 0 });
  }

  // Authority. The predictor numbers its own inputs from 1, so auth[t] is the state after
  // consuming seq t+1 — the bookkeeping this whole test turns on.
  const srv = createPlayerState(SPAWN);
  const auth = [];
  for (let t = 0; t < TICKS; t++) {
    stepPlayer(srv, { ...inputs[t], seq: t + 1 }, C.TICK_DT, WORLD_BOXES);
    auth.push({ x: srv.x, y: srv.y, z: srv.z, cr: srv.crouch, vx: srv.vx, vy: srv.vy, vz: srv.vz,
                g: srv.grounded, jh: srv.jumpHeld,
                st: srv.stamina, rt: srv.restTicks, sl: srv.sprintLock });
  }

  // Same coverage gate as the block above, for the same reason: this one is driving the real
  // reconcile, so a stamina field it silently failed to restore would still read as zero
  // error if the bar had never left MAX.
  const stams = auth.map((a) => a.st);
  const emptyAt = stams.indexOf(0);
  const cov = {
    lo: Math.min(...stams), hi: Math.max(...stams), n: new Set(stams).size,
    ground: auth.filter((a) => a.g).length,
    rest: auth.filter((a) => a.rt > 0).length,
    lock: auth.filter((a) => a.sl).length,
    back: emptyAt < 0 ? 0 : Math.max(...stams.slice(emptyAt)),
  };
  okC(cov.lo === 0 && cov.back >= C.SPRINT_MIN_START && cov.n > 100 && cov.rest > 0
      && cov.lock > 0 && cov.lock < auth.length && cov.ground > auth.length * 0.5,
      'the body it replays empties the bar and refills it, rather than holding MAX',
      `stamina ${cov.lo}..${cov.hi} over ${cov.n} distinct values, back to ${cov.back} after `
      + `empty at t=${emptyAt}, ${cov.lock} ticks locked out, ${cov.rest} resting, grounded `
      + `on ${cov.ground}/${auth.length}`);

  // Deterministic jitter. A suite that reruns with different numbers cannot be used to decide
  // whether a change made things worse, so this is a fixed sequence rather than Math.random —
  // and it is re-seeded per run, so the control below gets the identical arrival pattern.
  const SEED = 0x2f6e2b1;

  // `carry` is the switch that makes the position bound mean something. With it, the self blob
  // is what server/index.js actually sends; without it, the three integers are omitted, which
  // is precisely the regression this block exists to catch. Everything else is identical.
  const drive = (carry) => {
    let seed = SEED;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pr = createPredictor(SPAWN);
    const r = { st: 0, pos: 0, rt: 0, sl: 0, recon: 0, maxP: 0, minP: Infinity,
                maxR: 0, minR: Infinity, lags: new Set() };
    let ackSeq = 0;
    for (let t = 0; t < TICKS; t++) {
      pr.push(inputs[t]);
      // A snapshot lands on the 20Hz cadence, aged by a round trip that is a different number
      // of ticks each time. The client has no say in which one it gets.
      if (t % C.TICKS_PER_SNAPSHOT === 0) {
        const lag = Math.round(LAG + (rand() * 2 - 1) * JIT);
        // Clamped forward, because the server's ack is the highest sequence it has SEEN — it
        // cannot go backwards, and at this jitter neither can the arrival order (snapshots are
        // 3 ticks apart and the delay varies by under 2). A model that let it run backwards
        // would be testing packet reordering, a different setting and a different bug.
        const next = Math.max(ackSeq, t + 1 - lag);
        if (next >= 1) {
          ackSeq = next;
          const a = auth[ackSeq - 1];
          // Quantised exactly as server/index.js builds it: r3 on the continuous fields, the
          // three integers verbatim.
          const self = { vx: r3(a.vx), vy: r3(a.vy), vz: r3(a.vz),
                         g: a.g ? 1 : 0, jh: a.jh ? 1 : 0 };
          if (carry) { self.st = a.st; self.rt = a.rt; self.sl = a.sl; }
          pr.reconcile({ x: r3(a.x), y: r3(a.y), z: r3(a.z), cr: r3(a.cr) }, ackSeq, self);
          r.recon++;
          r.lags.add(t + 1 - ackSeq);
          r.maxR = Math.max(r.maxR, t + 1 - ackSeq);
          r.minR = Math.min(r.minR, t + 1 - ackSeq);
          r.maxP = Math.max(r.maxP, pr.pendingCount);
          r.minP = Math.min(r.minP, pr.pendingCount);
        }
      }
      // Whatever it just did, the predicted state must be the state the server will reach on
      // this tick — that is the whole contract, and it is checked on every tick rather than
      // only on the ones a snapshot arrived for.
      const a = auth[t];
      r.st = Math.max(r.st, Math.abs(pr.state.stamina - a.st));
      r.pos = Math.max(r.pos, Math.hypot(pr.state.x - a.x, pr.state.y - a.y, pr.state.z - a.z));
      if (pr.state.restTicks !== a.rt) r.rt++;
      if (pr.state.sprintLock !== a.sl) r.sl++;
    }
    return r;
  };

  const live = drive(true);
  const bare = drive(false);

  okC(live.recon > 300 && live.lags.size >= 3 && live.minR >= 1,
      'the real predictor runs at 150ms and 30ms of jitter, not at a fixed offset',
      `${live.recon} reconciles over ${TICKS} ticks, replay ${live.minR}–${live.maxR} inputs `
      + `long across ${live.lags.size} distinct round trips`);
  okC(live.st === 0 && live.rt === 0 && live.sl === 0,
      'and predicts the server’s stamina on every tick, not only the ones it heard about',
      `worst |client − server| ${live.st} of ${C.SPRINT_STAMINA_MAX}, `
      + `${live.rt} restTicks and ${live.sl} sprintLock mismatches over ${TICKS} ticks`);
  // The control is what licenses the bound below. Position on WORLD_BOXES cannot be held to the
  // 0.002u the FLAT block manages: the wire hands the replay a position already rounded to
  // 0.0005u, and beside a step that half-millimetre decides whether the body climbs. So the
  // number worth asserting is not an absolute — it is the gap between carrying the three
  // integers and dropping them, over identical inputs and an identical arrival pattern.
  // Of the two halves, the bar is the load-bearing one and the millimetres are corroboration:
  // WORLD_BOXES clamps a client running the wrong cap into the same wall the server hits, so
  // position understates the disagreement here in a way it would not on open floor. Full-scale
  // stamina error is the unambiguous half, and it cannot be reached by accident.
  okC(bare.st >= C.SPRINT_STAMINA_MAX / 2 && bare.pos > live.pos * 2,
      'and simulates a different bar entirely the moment the self blob stops carrying it',
      `bar off by up to ${bare.st} of ${C.SPRINT_STAMINA_MAX} and ${bare.rt} restTicks ticks `
      + `wrong, position ${(live.pos * 1000).toFixed(1)}mm carried against `
      + `${(bare.pos * 1000).toFixed(1)}mm omitted (${(bare.pos / live.pos).toFixed(1)}×)`);
  okC(live.pos < SMOOTH_MAX / 20,
      'so what it draws is inside the rounding, with nothing left for the smoothing to hide',
      `worst ${(live.pos * 1000).toFixed(1)}mm, against the ${SMOOTH_MAX * 1000}mm reconcile `
      + 'would have eased out in silence');
  // A queue that grows is an ack that is not landing, which reads as prediction working right
  // up until MAX_PENDING starts dropping inputs and the two sides simulate different games.
  okC(live.maxP <= Math.ceil(LAG + JIT),
      'and leaves exactly a round trip unacknowledged rather than a growing backlog',
      `${live.minP}–${live.maxP} inputs pending against MAX_PENDING 240`);
}

// The scope across the wire, which is the same contract the stamina block above proves and
// the same failure if it is broken — except that this field decides how WIDE a bullet's cone
// is, so a replay that ages it wrongly does not jitter, it silently lies to the shooter about
// whether his shot was pinpoint. `stepPlayer` ADDS to scopeMs, and reconcile replays every
// unacked input, so a client that replayed from its own running total would settle the glass
// roughly a round trip early on every single snapshot: a quick-scope that the shooter's screen
// scores and the server records as a 40x hip shot into the wall behind.
{
  const wi = indexOf('sniper');
  const LAG = 8;
  const born = () => createPlayerState({ x: 0, y: C.PLAYER_HALF_H, z: 0, yaw: 0 });
  const TICKS = 60 * 8;

  // One stream that visits every state the field has: unscoped, the near zoom held long past
  // the settle, a step up to the far zoom, a drop back out, and a re-scope — mostly while
  // walking, because the step ALSO caps the speed and the position error below is what proves
  // it.
  //
  // MOSTLY, and the exception is load-bearing. The settle only runs forward while the player
  // is asking to move nowhere, so a stream that walks for all eight seconds never once closes
  // the cone and the coverage assert below fails — which is exactly how it failed when the
  // rule changed, rather than passing over a body that had quietly stopped visiting half the
  // states it claims to. PLANT covers the middle of the near-zoom stretch: a stop long enough
  // to bank the full window, which is what a player actually does before taking the shot.
  const PLANT = [100, 180];
  const inputs = [];
  for (let t = 0; t < TICKS + LAG; t++) {
    let sc = 0;
    if (t >= 60 && t < 200) sc = 1;
    else if (t >= 200 && t < 260) sc = 2;
    else if (t >= 300 && t < 340) sc = 1;          // a re-scope, so a stale window would show
    else if (t >= 400) sc = t % 7 === 0 ? 0 : 1;   // and a flicker no human could produce
    const still = t >= PLANT[0] && t < PLANT[1];
    inputs.push({ moveX: 0, moveZ: still ? 0 : 1, yaw: 0.4, pitch: 0,
                  buttons: still ? 0 : C.BTN_SPRINT, wep: wi, sc, seq: t });
  }

  const srv = born();
  const auth = [];
  for (let t = 0; t < inputs.length; t++) {
    stepPlayer(srv, inputs[t], C.TICK_DT, FLAT);
    auth.push({ x: srv.x, y: srv.y, z: srv.z, vx: srv.vx, vy: srv.vy, vz: srv.vz,
                grounded: srv.grounded, crouch: srv.crouch, jumpHeld: srv.jumpHeld,
                stamina: srv.stamina, restTicks: srv.restTicks, sprintLock: srv.sprintLock,
                scope: srv.scope, scopeMs: srv.scopeMs });
  }

  // Coverage first, for the same reason the stamina block asserts it: a zero-error result over
  // a body that was never scoped is two constants agreeing.
  // Measured against the same body's WEAPONLESS spread rather than against 1, because this
  // body is walking: the movement term is in both numbers and only their ratio is the glass.
  const steps = new Set(auth.map((a) => a.scope));
  const glassOf = (a) => spreadMul(a, 'sniper') / spreadMul(a);
  const settled = auth.filter((a) => a.scope > 0 && glassOf(a) === 1).length;
  const midway = auth.filter((a) => a.scope > 0 && glassOf(a) > 1.5).length;
  const resets = auth.filter((a, i) => i > 0 && a.scopeMs === 0 && a.scope !== auth[i - 1].scope).length;
  okC(steps.size === 3 && settled > 60 && midway > 20 && resets >= 5,
      'the body under test scopes, settles, steps up, drops out and scopes again',
      `steps {${[...steps].join(',')}} over ${auth.length} ticks, ${settled} of them fully `
      + `settled and ${midway} mid-window, ${resets} windows restarted`);

  // The wire exactly as server/index.js builds it — and the rounding is the interesting part.
  // `sm` is sent as a whole millisecond, so unlike stamina this field does NOT survive the
  // trip bit-exact. That is deliberate: half a millisecond of a 120ms window is worth less
  // than the float it would cost, and the assert below measures what it is worth in cone.
  const wire = (a) => ({
    snap: { x: r3(a.x), y: r3(a.y), z: r3(a.z), cr: r3(a.crouch) },
    self: { vx: r3(a.vx), vy: r3(a.vy), vz: r3(a.vz), g: a.grounded ? 1 : 0,
            jh: a.jumpHeld ? 1 : 0, st: a.stamina, rt: a.restTicks, sl: a.sprintLock ? 1 : 0,
            ...(a.scope ? { sc: a.scope, sm: Math.round(a.scopeMs) } : {}) },
  });

  // The omission is part of the contract, not an implementation detail: an unscoped player is
  // every player most of the time, and reconcile has to read a MISSING field as zero rather
  // than as undefined, or a body carries NaN into a cone width.
  const quiet = auth.find((a) => a.scope === 0);
  const loud = auth.find((a) => a.scope === 2);
  okC(!Object.hasOwn(wire(quiet).self, 'sc') && !Object.hasOwn(wire(quiet).self, 'sm')
      && wire(loud).self.sc === 2 && Number.isInteger(wire(loud).self.sm),
      'an unscoped tick sends no scope fields at all, and a scoped one sends whole milliseconds',
      `unscoped self blob is ${JSON.stringify(wire(quiet).self).length} bytes, `
      + `scoped adds sc:${wire(loud).self.sc} sm:${wire(loud).self.sm}`);

  let stepMiss = 0, worstMs = 0, worstCone = 0, worstRel = 0, worstPos = 0;
  for (let t = 0; t + LAG < inputs.length; t++) {
    const { snap, self } = wire(auth[t]);
    const cli = born();
    cli.x = snap.x; cli.y = snap.y; cli.z = snap.z;
    cli.crouch = snap.cr;
    cli.vx = self.vx; cli.vy = self.vy; cli.vz = self.vz;
    cli.grounded = !!self.g; cli.jumpHeld = !!self.jh;
    cli.stamina = self.st ?? C.SPRINT_STAMINA_MAX;
    cli.restTicks = self.rt ?? 0;
    cli.sprintLock = !!self.sl;
    // The two lines under test, transcribed from predict.js reconcile().
    cli.scope = self.sc ?? 0;
    cli.scopeMs = self.sm ?? 0;
    cli.yaw = inputs[t].yaw;
    for (let k = t + 1; k <= t + LAG; k++) stepPlayer(cli, inputs[k], C.TICK_DT, FLAT);

    const a = auth[t + LAG];
    if (cli.scope !== a.scope) stepMiss++;
    worstMs = Math.max(worstMs, Math.abs(cli.scopeMs - a.scopeMs));
    const dCone = Math.abs(spreadMul(cli, 'sniper') - spreadMul(a, 'sniper'));
    worstCone = Math.max(worstCone, dCone);
    worstRel = Math.max(worstRel, dCone / spreadMul(a, 'sniper'));
    worstPos = Math.max(worstPos, Math.hypot(cli.x - a.x, cli.y - a.y, cli.z - a.z));
  }

  okC(stepMiss === 0, 'the zoom step survives the wire and an 8-tick replay exactly',
      `${stepMiss} mismatches over ${TICKS} reconciles`);
  // Bounded by the rounding it was handed, and no more. Anything larger means the replay is
  // accumulating from its own total instead of from authority — which at this lag would read
  // as 8 ticks, 133ms, two thirds of the whole settle window.
  okC(worstMs <= 0.5 + 1e-9,
      'and the settle window arrives inside the half-millisecond the rounding costs',
      `worst |client - server| ${worstMs.toFixed(4)}ms, against the `
      + `${(LAG * C.TICK_DT * 1000).toFixed(0)}ms a replay from its own total would gain`);
  // And what that half-millisecond is WORTH, in the only unit that decides a duel. The cone
  // is steepest at the top of the window, so the worst multiplier disagreement lands there;
  // converted to a radius at a realistic sniping distance it has to be small against the body
  // it is aimed at, not merely small as a number.
  const cm = (mul) => weaponAt(indexOf('sniper')).spread * mul * 20 * 100;
  okC(worstRel < 0.02 && cm(worstCone) < 1,
      'so the cone the client draws and the cone the server fires agree to within a percent',
      `worst ${(worstRel * 100).toFixed(2)}% — ${cm(worstCone).toFixed(2)}cm of radius at 20u, `
      + `against the ${(C.PLAYER_HALF_W * 2 * 100).toFixed(0)}cm of body being aimed at`);
  // Position, because the step also sets a speed cap: a dropped `sc` is not a cosmetic
  // mistake, it is the client walking at 4.2 while the server walks it at 1.68.
  okC(worstPos < 0.002, 'and the predicted position stays inside the wire rounding it started from',
      `worst divergence ${(worstPos * 1000).toFixed(3)}mm after ${LAG} replayed ticks`);

  // The legs of the contract, in the source, for the same reason as the stamina block: a
  // missing one costs a lie about accuracy and no error anywhere.
  const mvSrc = readFileSync(new URL('./shared/movement.js', import.meta.url), 'utf8');
  const kin = mvSrc.match(/const KINEMATIC = \[([\s\S]*?)\]/)?.[1] ?? '';
  const svSrc = readFileSync(new URL('./server/index.js', import.meta.url), 'utf8');
  const prSrc = readFileSync(new URL('./client/src/predict.js', import.meta.url), 'utf8');
  okC(kin.includes("'scope'") && kin.includes("'scopeMs'"),
      'both scope fields are listed in KINEMATIC, so a respawn and a pin clear them',
      kin.replace(/\s+/g, ' ').trim());
  okC(/sc: p\.scope/.test(svSrc) && /sm: Math\.round\(p\.scopeMs\)/.test(svSrc)
      && /\.\.\.\(p\.scope \?/.test(svSrc),
      'the self blob sends both to the player they belong to, and omits them while zero',
      'sc: p.scope, sm: Math.round(p.scopeMs), inside a p.scope guard');
  okC(/state\.scope = self\.sc \?\? 0/.test(prSrc) && /state\.scopeMs = self\.sm \?\? 0/.test(prSrc),
      'and reconcile restores both from authority, defaulting a missing field to zero',
      'never `= self.sc` bare, which would carry undefined into a cone width');
  // And the respawn path, which is the one place the field is cleared rather than copied.
  okC(/state\.scope = 0;/.test(prSrc) && /state\.scopeMs = 0;/.test(prSrc),
      'a pinned body comes back out of the scope rather than resuming the one it died in',
      'predict.js pin() zeroes both');
  // Bots run the same input shape through the same door, so the field cannot be a client-only
  // convention that ai.js quietly omits.
  const aiSrc = readFileSync(new URL('./server/ai.js', import.meta.url), 'utf8');
  okC(/\bsc\b/.test(aiSrc) && /scopes\(/.test(aiSrc),
      'and the bots assert it on their own inputs rather than firing through glass they lack',
      'server/ai.js reads scopes() and returns sc');
}

console.log([...pC, ...fC].join('\n'));

// ────────────────── Part D: crouch, and what right-click is allowed to mean
// Two playtest complaints, one section, because both are the same shape of mistake:
// a rule that belongs to one thing was written as a mode of everything.
//
// Crouch changes the body's height, and four systems have to agree about it — the
// collider, the hitscan hitbox, the projectile blast box and the drawn avatar. The
// moment one of them reads the standing 0.9 you get a player you can see but cannot
// shoot, so the checks here are all about the height being ONE number.
//
// Right-click was a global mode read separately by the viewmodel, the camera and the
// mouse, which is how a knife came to have a scope. It is now a single `alt` field
// those three all read; asserting the field is asserting all three.
console.log('\n=== Part D — crouch and the right-click verb ===\n');

const pD = [];
const fD = [];
const okD = (cond, label, detail = '') => {
  (cond ? pD : fD).push(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// The height itself.
{
  okD(C.CROUCH_HALF_H < C.PLAYER_HALF_H, 'a crouched body is shorter than a standing one',
      `${C.CROUCH_HALF_H * 2}u vs ${C.PLAYER_HALF_H * 2}u tall`);
  okD(halfHAt(0) === C.PLAYER_HALF_H && halfHAt(1) === C.CROUCH_HALF_H,
      'the blend ends exactly on the two constants', `${halfHAt(0)} / ${halfHAt(1)}`);
  okD(halfOf({ crouch: 1 })[1] === halfHAt(1) && halfOf({})[1] === C.PLAYER_HALF_H,
      'halfOf reads the crouch amount, and treats a state without one as standing',
      `halfOf({})=${halfOf({})[1]}`);
}

// Ducking lowers the head, not the feet — and standing up under a ledge is refused.
{
  const duckIn = { moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: C.BTN_CROUCH, wep: 0 };
  const standUp = { ...duckIn, buttons: 0 };
  const feetOf = (s) => s.y - halfOf(s)[1];

  const s = createPlayerState({ x: line.x, y: C.PLAYER_HALF_H, z: line.z, yaw: 0 });
  // Settle first, so the figure below is a resting foot height and not a falling one.
  for (let i = 0; i < 8; i++) stepPlayer(s, standUp, C.TICK_DT, WORLD_BOXES);
  const feet0 = feetOf(s);
  const eye0 = eyeY(s);

  let down = 0;
  while (s.crouch < 1 && down < 240) {
    stepPlayer(s, duckIn, C.TICK_DT, WORLD_BOXES);
    down++;
  }
  okD(s.crouch === 1, 'the crouch blend reaches a full duck',
      `${down} ticks = ${Math.round(down * C.TICK_DT * 1000)}ms at CROUCH_RATE ${C.CROUCH_RATE}`);
  okD(halfOf(s)[1] === C.CROUCH_HALF_H, 'and the collider is the crouched height', `${halfOf(s)[1]}`);
  // The anchoring rule, asserted rather than described: grounded, the box grows and
  // shrinks from the feet. Anchoring it at the centre instead would sink the feet
  // 0.35u into the floor, and every stand-up would then be refused for lack of
  // headroom that was never actually missing.
  okD(Math.abs(feetOf(s) - feet0) < 1e-6, 'ducking lowered the head and left the feet where they were',
      `feet moved ${(feetOf(s) - feet0).toExponential(1)}u`);
  okD(eyeY(s) < eye0 - 0.25, 'the camera came down with the body',
      `eye ${eye0.toFixed(2)}u → ${eyeY(s).toFixed(2)}u`);

  // Standing up under a low ceiling must never grow the body THROUGH the ledge —
  // depenetrating a body that did picks the up axis and puts you on top of the thing
  // you were hiding under. Nothing in the arena is a crawlspace, so the ledge is
  // synthesised: underside at 1.3u, which clears a 1.1u duck and not a 1.8u stand.
  // No `c` key, because this box exists only to be collided with and is never drawn.
  const LOW = { x: s.x, y: 1.5, z: s.z, w: 4, h: 0.4, d: 4 };
  const CEIL = LOW.y - LOW.h / 2;
  const withLedge = [...WORLD_BOXES, LOW];
  const headOf = (t) => t.y + halfOf(t)[1];
  for (let i = 0; i < 90; i++) stepPlayer(s, standUp, C.TICK_DT, withLedge);
  // It rises into whatever headroom there is and stops, which is why this checks the
  // head against the ceiling rather than checking that crouch stayed pinned at 1 —
  // filling the available space is right, growing past it is the bug.
  okD(s.crouch > 0, 'releasing crouch under a low ceiling cannot stand all the way up',
      `stalled at crouch=${s.crouch.toFixed(3)}, ${(C.PLAYER_HALF_H * 2).toFixed(1)}u needed and ${CEIL}u available`);
  okD(headOf(s) <= CEIL + 1e-9, 'the head stopped at the ledge rather than growing through it',
      `head at ${headOf(s).toFixed(3)}u, ledge underside at ${CEIL}u`);
  okD(Math.abs(feetOf(s) - feet0) < 1e-6, 'and the body was not shoved up onto the ledge',
      `feet at y=${feetOf(s).toFixed(4)}`);

  // A refusal that never lifts is just a broken crouch. Step clear — line.x + GAP is
  // already verified clear of geometry — and the same release must work.
  s.x = line.x + GAP;
  let up = 0;
  while (s.crouch > 0 && up < 240) {
    stepPlayer(s, standUp, C.TICK_DT, withLedge);
    up++;
  }
  okD(s.crouch === 0, 'clear of the ledge, the same release stands up', `${up} ticks`);
  okD(Math.abs(feetOf(s) - feet0) < 1e-6, 'standing raised the head rather than sinking the feet',
      `feet moved ${(feetOf(s) - feet0).toExponential(1)}u`);
}

// Speed. Crouch and walk lower the top-speed CAP, and take the more restrictive of
// the two rather than multiplying — compounding them lands at 0.19x, which reads as
// being stuck rather than as being deliberately slow.
{
  const topSpeed = (buttons) => {
    const p = createPlayerState({ x: 0, y: C.PLAYER_HALF_H, z: 0, yaw: 0 });
    const inp = { moveX: 0, moveZ: 1, yaw: 0, pitch: 0, buttons, wep: 0 };
    for (let i = 0; i < 240; i++) stepPlayer(p, inp, C.TICK_DT, FLAT);
    return Math.hypot(p.vx, p.vz);
  };
  // Ratios, not absolutes. Sustained ground speed settles where friction and
  // acceleration balance, which is GROUND_ACCEL/FRICTION = 0.89 of MOVE_SPEED — a
  // property of the movement model, not of these multipliers. The ratios are what
  // the constants actually promise.
  const run = topSpeed(0);
  const walk = topSpeed(C.BTN_WALK);
  const duck = topSpeed(C.BTN_CROUCH);
  const both = topSpeed(C.BTN_CROUCH | C.BTN_WALK);

  okD(run > 3, 'a plain run reaches a sensible speed', `${run.toFixed(2)} u/s (cap ${C.MOVE_SPEED})`);
  okD(Math.abs(walk / run - C.WALK_SPEED_MUL) < 0.01, 'Shift walks at WALK_SPEED_MUL',
      `${walk.toFixed(2)} u/s = ${(walk / run).toFixed(3)}x`);
  okD(Math.abs(duck / run - C.CROUCH_SPEED_MUL) < 0.01, 'a full duck moves at CROUCH_SPEED_MUL',
      `${duck.toFixed(2)} u/s = ${(duck / run).toFixed(3)}x`);
  okD(Math.abs(both - duck) < 1e-9, 'crouch and walk together take the slower one, not the product',
      `${(both / run).toFixed(3)}x; the product would be ${(C.WALK_SPEED_MUL * C.CROUCH_SPEED_MUL).toFixed(3)}x`);

  // Sprint is the same shape in the other direction, and takes the same ratio treatment.
  const sp = topSpeed(C.BTN_SPRINT);
  okD(Math.abs(sp / run - C.SPRINT_SPEED_MUL) < 0.01, 'a tapped Shift sprints at SPRINT_SPEED_MUL',
      `${sp.toFixed(2)} u/s = ${(sp / run).toFixed(3)}x`);
  // Walk and crouch WIN. sprintOk refuses outright when either bit is set rather than
  // taking a minimum afterwards, so these are exact rather than merely close.
  const spWalk = topSpeed(C.BTN_SPRINT | C.BTN_WALK);
  const spDuck = topSpeed(C.BTN_SPRINT | C.BTN_CROUCH);
  okD(Math.abs(spWalk - walk) < 1e-9, 'sprint and walk together is a walk, not a sprint',
      `${spWalk.toFixed(2)} u/s against a walk's ${walk.toFixed(2)}`);
  okD(Math.abs(spDuck - duck) < 1e-9, 'sprint and crouch together is a duck, not a sprint',
      `${spDuck.toFixed(2)} u/s against a duck's ${duck.toFixed(2)}`);

  // The bit the gun reads. `s.sprinting` exists so the viewmodel does not have to guess a
  // sprint from `speed`, which cannot tell one from a run down a slope; the value is only
  // worth anything if it is the SAME decision the speed cap and the bar were made from, so
  // that is what is measured rather than the assignment being read.
  //
  // A sprinting tick is exactly a tick that spends the bar: both come off the one
  // `sprinting` local. So the flag is checked against the drain, over a program that visits
  // both states in both directions and includes the two ways to be refused (walk, crouch)
  // and the two ways to run out (empty, latched).
  {
    const b = createPlayerState({ x: 0, y: C.PLAYER_HALF_H, z: 0, yaw: 0 });
    let ticks = 0;
    let drainMiss = 0;
    let onTicks = 0;
    let offTicks = 0;
    let refused = 0;
    for (let t = 0; t < 1400; t++) {
      // Sprint held for most of it, so the bar empties, latches, refills and goes again;
      // walk over one window and crouch over another, which sprintOk refuses outright.
      let buttons = 0;
      if (t < 400 || (t > 560 && t < 900) || t > 1000) buttons |= C.BTN_SPRINT;
      if (t > 300 && t < 360) buttons |= C.BTN_WALK;
      if (t > 1100 && t < 1160) buttons |= C.BTN_CROUCH;
      const before = b.stamina;
      const held = !!(buttons & C.BTN_SPRINT);
      stepPlayer(b, { moveX: 0, moveZ: 1, yaw: 0, pitch: 0, buttons, wep: 0 }, C.TICK_DT, FLAT);
      const spent = b.stamina < before;
      if (b.sprinting !== spent) drainMiss++;
      if (b.sprinting) onTicks++; else offTicks++;
      if (held && !b.sprinting) refused++;
      ticks++;
    }
    okD(drainMiss === 0 && onTicks > 200 && offTicks > 200 && refused > 100,
        'the sprinting bit the gun reads is the same decision the bar and the cap were made from',
        `${drainMiss} disagreements over ${ticks} ticks — ${onTicks} sprinting, `
          + `${offTicks} not, ${refused} of those with the key still held`);
    // And it is recomputed, not remembered. It is deliberately absent from KINEMATIC, so a
    // reconcile leaves whatever the last local step wrote there; the next step has to
    // overwrite it rather than trust it, or a sprint that ended during a rollback sticks.
    b.sprinting = true;
    stepPlayer(b, { moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0, wep: 0 }, C.TICK_DT, FLAT);
    okD(b.sprinting === false,
        'and it is an output of the step rather than state, so a stale one cannot survive a tick',
        'forced true by hand, then false again after one standing-still step — which is why it '
          + 'is left out of KINEMATIC instead of copied across a reconcile');
  }
}

// Stamina. The bar is in whole integer units rather than seconds, and that is a correctness
// requirement rather than a style: server/index.js rounds the `self` blob through r3(), whose
// 0.0005 error velocity absorbs because it feeds a continuous integrator. Stamina feeds
// THRESHOLD comparisons that swing the speed cap by 15%, and one tick of drain is 1/240 of
// the bar — so a rounded float lets the client and the server cross zero on different ticks,
// and one tick of cap disagreement diverges the rest of the replay. Integers survive JSON
// bit-exact. These asserts are what stops someone tidying the constants into seconds later.
{
  const whole = (n, d) => Number.isInteger(n / d);
  okD(Number.isInteger(C.SPRINT_STAMINA_MAX) && Number.isInteger(C.SPRINT_DRAIN)
      && Number.isInteger(C.SPRINT_REGEN) && Number.isInteger(C.SPRINT_REST_TICKS)
      && Number.isInteger(C.SPRINT_MIN_START),
      'every stamina constant is a whole number of units or ticks',
      `max ${C.SPRINT_STAMINA_MAX} drain ${C.SPRINT_DRAIN} regen ${C.SPRINT_REGEN} `
      + `rest ${C.SPRINT_REST_TICKS} floor ${C.SPRINT_MIN_START}`);
  okD(whole(C.SPRINT_STAMINA_MAX, C.SPRINT_DRAIN) && whole(C.SPRINT_STAMINA_MAX, C.SPRINT_REGEN),
      'both rates divide the bar evenly, so neither end lands mid-tick',
      `${C.SPRINT_STAMINA_MAX}/${C.SPRINT_DRAIN} = ${C.SPRINT_STAMINA_MAX / C.SPRINT_DRAIN} ticks, `
      + `${C.SPRINT_STAMINA_MAX}/${C.SPRINT_REGEN} = ${C.SPRINT_STAMINA_MAX / C.SPRINT_REGEN} ticks`);

  // Durations driven through the real stepPlayer at a fixed dt, rather than divided back out
  // of the constants — the same numbers arrived at two independent ways.
  const born = () => createPlayerState({ x: 0, y: C.PLAYER_HALF_H, z: 0, yaw: 0 });
  const push = (buttons, mz = 1) => ({ moveX: 0, moveZ: mz, yaw: 0, pitch: 0, buttons, wep: 0 });
  const drive = (p, buttons, n, mz = 1) => {
    for (let i = 0; i < n; i++) stepPlayer(p, push(buttons, mz), C.TICK_DT, FLAT);
    return p;
  };

  // Tick one is spent landing — createPlayerState starts airborne and sprintOk requires
  // ground — so the drain is counted over the ticks that actually spend something.
  const d = born();
  let ticks = 0, drained = 0;
  while (d.stamina > 0 && ticks < 3000) {
    const before = d.stamina;
    drive(d, C.BTN_SPRINT, 1);
    if (d.stamina < before) drained++;
    ticks++;
  }
  okD(Math.abs(drained * C.TICK_DT - 4) < 1e-9, 'a full bar is exactly 4.0s of sprinting',
      `${drained} draining ticks = ${(drained * C.TICK_DT).toFixed(4)}s`);
  okD(d.sprintLock, 'reaching empty latches the lockout', `stamina ${d.stamina}`);

  // Standing still: the rest delay, then the refill. Both measured, not restated.
  let rest = 0;
  while (d.restTicks > 0 && rest < 3000) { drive(d, 0, 1, 0); rest++; }
  okD(Math.abs(rest * C.TICK_DT - 1) < 1e-9 && d.stamina === 0,
      'regen waits exactly 1.0s after the last sprinting tick',
      `${rest} ticks = ${(rest * C.TICK_DT).toFixed(4)}s, stamina still ${d.stamina}`);
  let refill = 0;
  while (d.stamina < C.SPRINT_STAMINA_MAX && refill < 3000) { drive(d, 0, 1, 0); refill++; }
  okD(Math.abs(refill * C.TICK_DT - 6) < 1e-9, 'empty to full is exactly 6.0s',
      `${refill} ticks = ${(refill * C.TICK_DT).toFixed(4)}s`);

  // Holding the key down does not buy sustained sprint, it buys a sawtooth — which is the
  // actual answer to "otherwise mfs will just keep sprinting". Drain, rest 1.0s, regen to a
  // quarter, and around again: a 210-tick cycle with only 60 sprinting ticks in it. Note the
  // lock releasing re-engages sprint with NO new keypress, which is why the HUD has to show
  // "armed but blocked" rather than leaving the player wondering.
  const e = born();
  drive(e, C.BTN_SPRINT, 1); // land first — tick one is airborne and spends nothing
  let sprintTicks = 0, lockedDrain = 0, run = 0, longest = 0;
  const released = [], HOLD = 60 * 30;
  for (let i = 0; i < HOLD; i++) {
    // Sampled BEFORE the step. Reading the latch afterwards conflates the tick that spends
    // the last of the bar with a tick that spent it while already locked, and they are
    // opposites: the first is the drain working, the second would be the lockout failing.
    const st0 = e.stamina, locked0 = e.sprintLock;
    drive(e, C.BTN_SPRINT, 1);
    if (e.stamina < st0) {
      sprintTicks++;
      run++;
      if (locked0) lockedDrain++;
    } else {
      longest = Math.max(longest, run);
      run = 0;
    }
    if (locked0 && !e.sprintLock) released.push(e.stamina);
  }
  okD(lockedDrain === 0, 'no tick that began locked out ever spends stamina',
      `${lockedDrain} of ${HOLD} ticks over ${released.length} lockout cycles`);
  okD(released.length > 0 && released.every((v) => v === C.SPRINT_MIN_START),
      'the lockout releases at SPRINT_MIN_START every time, never early',
      `${released.length} releases, all at ${[...new Set(released)].join(',')} of `
      + `${C.SPRINT_STAMINA_MAX} (${((C.SPRINT_MIN_START / C.SPRINT_STAMINA_MAX) * 100).toFixed(0)}%)`);
  const cycle = C.SPRINT_MIN_START / C.SPRINT_DRAIN + C.SPRINT_REST_TICKS
    + C.SPRINT_MIN_START / C.SPRINT_REGEN;
  const duty = sprintTicks / HOLD;
  okD(duty < 0.45, 'a player who just holds the key sprints for a minority of the time',
      `${(duty * 100).toFixed(1)}% of 30s; the steady cycle is `
      + `${C.SPRINT_MIN_START / C.SPRINT_DRAIN} sprinting + ${C.SPRINT_REST_TICKS} resting + `
      + `${C.SPRINT_MIN_START / C.SPRINT_REGEN} refilling = ${cycle} ticks `
      + `(${((C.SPRINT_MIN_START / C.SPRINT_DRAIN / cycle) * 100).toFixed(1)}% at the limit)`);
  okD(longest === C.SPRINT_STAMINA_MAX / C.SPRINT_DRAIN,
      'the one long sprint is the first one, off a bar you actually filled',
      `${longest} ticks = ${(longest * C.TICK_DT).toFixed(2)}s from full, then `
      + `${C.SPRINT_MIN_START / C.SPRINT_DRAIN}-tick bursts off a quarter bar`);

  // And the things sprint must NOT do.
  const idle = drive(born(), C.BTN_SPRINT, 240, 0);
  okD(idle.stamina === C.SPRINT_STAMINA_MAX,
      'holding sprint with no movement key costs nothing',
      `stamina ${idle.stamina} after 4s of standing still on the key`);
  const q = drive(born(), C.BTN_SPRINT, 240);
  const vGround = Math.hypot(q.vx, q.vz), stBefore = q.stamina;
  drive(q, C.BTN_SPRINT | C.BTN_JUMP, 1);
  let air = 0, airDrain = 0;
  while (!q.grounded && air < 300) {
    const before = q.stamina;
    drive(q, C.BTN_SPRINT, 1);
    if (q.stamina < before) airDrain++;
    air++;
  }
  okD(airDrain === 0, 'sprint bills nothing while airborne, because it buys nothing there',
      `${air} airborne ticks, ${airDrain} drained (stamina ${stBefore} to ${q.stamina})`);
  okD(Math.abs(Math.hypot(q.vx, q.vz) - vGround) < 1e-9,
      'a sprinter who jumps keeps every bit of the speed they left with',
      `${vGround.toFixed(3)} to ${Math.hypot(q.vx, q.vz).toFixed(3)} u/s over ${air} ticks`);
}

// What a sprint FEELS like — the three places speed is turned into something a player
// perceives, pinned as numbers because "it looks fine" is not a regression test.
//
// None of the three files here can be imported: main.js, viewmodel.js and render.js all
// build a WebGL scene at module scope. So each expression is lifted out of its source and
// run in isolation — which means these asserts fail if the expression is EDITED, not merely
// if it starts behaving differently, and that is the intent. A future change to one of them
// should be a decision rather than an accident.
{
  // A lift that stops matching has to FAIL this suite, never crash it. The first draft of
  // this block let a missed regex through as undefined, and the TypeError landed inside a
  // detail string — which took Part D and everything after it down with it and reported not
  // one result. So a miss is reported here, at the lift, and the asserts that depend on it
  // are skipped rather than cascading: one failure naming the moved expression is worth more
  // than five derived from a hole. The check count dropping is part of the signal.
  const lift = (src, re, what, ...params) => {
    const m = re.exec(src)?.[1];
    okD(!!m, `the ${what} expression is still where this suite looks for it`,
        m ? m.replace(/\s+/g, ' ') : `no match — ${what} was moved or rewritten, so nothing `
        + 'below could be measured');
    return m ? new Function(...params, `return ${m};`) : null;
  };

  const topSpeed = (buttons) => {
    const p = createPlayerState({ x: 0, y: C.PLAYER_HALF_H, z: 0, yaw: 0 });
    const inp = { moveX: 0, moveZ: 1, yaw: 0, pitch: 0, buttons, wep: 0 };
    for (let i = 0; i < 240; i++) stepPlayer(p, inp, C.TICK_DT, FLAT);
    return Math.hypot(p.vx, p.vz);
  };
  const V = {
    duck: topSpeed(C.BTN_CROUCH),
    walk: topSpeed(C.BTN_WALK),
    run: topSpeed(0),
    sprint: topSpeed(C.BTN_SPRINT),
  };

  // ── footstep volume (client/src/main.js)
  //
  // The bug this fixes: the accumulator makes a walk RARER, and every step was the same
  // loudness, so "walk quietly" was a claim the audio never backed at all.
  const mainSrc = readFileSync(new URL('./client/src/main.js', import.meta.url), 'utf8');
  const gain = lift(mainSrc, /audio\.step\((Math\.max\([^;]*?)\);/, 'footstep gain', 'C', 'speed');
  if (gain) {
    const g = Object.fromEntries(Object.entries(V).map(([k, v]) => [k, gain(C, v)]));
    okD(g.walk < g.run * 0.6 && g.sprint > g.run,
        'a walk is genuinely quieter than a run, and a sprint is genuinely louder',
        Object.entries(g).map(([k, v]) => `${k} ${v.toFixed(2)}`).join('  '));
    // Monotone, so there is no speed at which going faster gets you quieter. Swept rather
    // than reasoned about, because the expression is a clamp inside a clamp and the failure
    // mode of getting those the wrong way round is a band, not a wrong endpoint.
    let dips = 0;
    for (let v = 0; v <= 12; v += 0.01) if (gain(C, v + 0.01) < gain(C, v) - 1e-12) dips++;
    okD(dips === 0, 'and nothing between a standstill and 12 u/s gets quieter by speeding up',
        `${dips} non-monotone samples over 1200`);
    // Bounded at both ends. audio.js multiplies a fixed peak by this, so an unbounded value
    // is a burst loud enough to hurt — and a launch or a boost can hand it any speed at all.
    let lo = Infinity, hi = 0;
    for (let v = 0; v <= 200; v += 0.05) { const q = gain(C, v); if (q < lo) lo = q; if (q > hi) hi = q; }
    okD(lo >= 0.3 && hi <= C.SPRINT_SPEED_MUL + 1e-9,
        'and no speed at all makes the step silent or makes it shout',
        `${lo.toFixed(2)}..${hi.toFixed(2)} across 0-200 u/s, ceiling SPRINT_SPEED_MUL `
        + `${C.SPRINT_SPEED_MUL}`);
  }
  // A duck never reaches that call: the gate above it is `speed > 1.5` and a crouch-walk
  // settles below it. So crouching is silent rather than quiet, which is worth pinning
  // because it is the difference between a stealth option and a volume knob.
  const GATE = Number(/speed > ([\d.]+)\)/.exec(mainSrc)?.[1]);
  okD(V.duck < GATE && V.walk > GATE,
      'a crouch-walk makes no footsteps at all, where a walk makes quiet ones',
      `duck ${V.duck.toFixed(3)} u/s under the ${GATE} gate, walk ${V.walk.toFixed(3)} over it`);
  okD(/burst\(0\.09 \* gain/.test(readFileSync(new URL('./client/src/audio.js', import.meta.url), 'utf8')),
      'and the gain reaches the oscillator rather than being computed and dropped',
      'audio.step multiplies its peak by it');

  // ── viewmodel bob (client/src/viewmodel.js)
  //
  // The old clamp saturated at exactly 1, which is just below a settled sprint — so the bob
  // flattened at the moment sprint engaged, killing the transition it exists to sell.
  const vmSrc = readFileSync(new URL('./client/src/viewmodel.js', import.meta.url), 'utf8');
  const bob = lift(vmSrc, /const walk = (Math\.min\([^;]*?);/, 'viewmodel bob', 'C', 'speed');
  if (bob) {
    // The property is that a settled sprint is no longer CLIPPED — not that a sprint bobs
    // more than a run, which was already true under the old ceiling and so passes on the
    // unfixed code. That distinction is the whole bug: the ceiling of 1 sat between a run
    // (0.889) and a sprint (1.022), so it bit at exactly the moment sprint engaged and
    // nowhere else, flattening the one transition the bob exists to sell.
    const trueRatio = V.sprint / C.MOVE_SPEED;
    okD(Math.abs(bob(C, V.sprint) - trueRatio) < 1e-9 && bob(C, V.sprint) > bob(C, V.run),
        'a settled sprint is no longer clipped by the bob ceiling, which is what flattened it',
        `sprint term ${bob(C, V.sprint).toFixed(4)} against a true ratio of `
        + `${trueRatio.toFixed(4)}; a ceiling of 1 cuts it to `
        + `${Math.min(1, trueRatio).toFixed(4)} while leaving a run at `
        + `${bob(C, V.run).toFixed(4)} untouched`);
    okD(bob(C, 400) <= C.SPRINT_SPEED_MUL + 1e-9,
        'and is still bounded, so a launch cannot swing the weapon off screen',
        `${bob(C, 400).toFixed(3)} at 400 u/s`);
  }

  // ── remote leg swing (client/src/render.js)
  //
  // This one asserts a NON-change, and pins the measurement the decision rests on. The
  // clamp is not raised for sprint because an ordinary run already exceeds it by 62%:
  // letting a sprint through means letting a run through, which re-tunes every existing
  // run in order to add one state. If that stops being true, the comment in render.js is
  // stale and the decision deserves revisiting — so this fails rather than drifting quietly.
  const rdSrc = readFileSync(new URL('./client/src/render.js', import.meta.url), 'utf8');
  const swing = lift(rdSrc, /const target = (Math\.min\([^;]*?);/, 'remote leg swing',
                     'C', 'moved', 'dt');
  const raw = (v) => v / (C.MOVE_SPEED * 0.55);
  okD(raw(V.run) > 1 && raw(V.walk) < 1,
      'the remote leg swing is already maxed out by a plain run, which is why sprint leaves it alone',
      `walk ${raw(V.walk).toFixed(2)}, run ${raw(V.run).toFixed(2)}, sprint `
      + `${raw(V.sprint).toFixed(2)} — clamped at 1, so raising it for sprint would raise `
      + `the run by ${((raw(V.run) - 1) * 100).toFixed(0)}% too`);
  if (swing) {
    okD(swing(C, V.run * 0.1, 0.1) === swing(C, V.sprint * 0.1, 0.1),
        'so a sprinter and a runner swing their legs through the same arc, by choice',
        `both ${swing(C, V.run * 0.1, 0.1).toFixed(3)}`);
  }
  // The ceiling itself, by value. Comparing two already-clamped speeds cannot notice a raise
  // from 1 to 1.15 — both still clamp — so the number is asserted directly. This is the same
  // machine-enforcement SPRINT_SPEED_MUL gets from runOut() in Part A: a future re-tune is
  // welcome, but it has to come with reading why this was left alone.
  const swCeil = /const target = Math\.min\(([^,]+),/.exec(rdSrc)?.[1]?.trim();
  okD(swCeil === '1', 'and that ceiling is still 1, left there on purpose rather than by neglect',
      `Math.min(${swCeil}, …) — a run already needs ${raw(V.run).toFixed(2)}, so any raise `
      + 'buys sprint nothing that it does not also spend on every run in the game');
  // And the half that DOES differentiate a sprint, so nobody "fixes" the above by touching
  // it: stride accumulates distance, so cadence scales with speed on its own.
  const strideSrc = /a\.stride \+= (moved \* STRIDE_PER_UNIT);/.exec(rdSrc)?.[1];
  okD(!!strideSrc,
      'because leg CADENCE differentiates it instead, off distance travelled',
      `a.stride += ${strideSrc} — a sprinter cycles `
      + `${((V.sprint / V.run - 1) * 100).toFixed(0)}% faster with no clamp involved`);
}

// A crouching player is a genuinely smaller target.
{
  // A standing player's eyes sit at 1.52u and a ducked head tops out at 1.10u, so a
  // dead-level shot passes clean over a crouched target and hits a standing one. This
  // is exactly the mismatch that made hitscan.js read halfOf instead of the standing
  // constant: draw a full-height avatar over a shorter hitbox and shots aimed at a
  // visible head hit nothing at all.
  const LEVEL = { range: 200, spread: 0 }; // resolveShot reads only these two
  const shooter = { x: line.x, y: C.PLAYER_HALF_H, z: line.z, yaw: YAW_EAST, pitch: 0, alive: true, crouch: 0 };
  const targetAt = (crouch) => ({
    x: line.x + GAP,
    y: halfHAt(crouch), // feet on the floor at whatever height it currently is
    z: line.z,
    yaw: 0,
    pitch: 0,
    alive: true,
    crouch,
  });

  const stood = resolveShot(shooter, [shooter, targetAt(0)], LEVEL);
  const ducked = resolveShot(shooter, [shooter, targetAt(1)], LEVEL);
  okD(!!stood.victim, 'a level shot hits a standing target', `at ${stood.dist.toFixed(2)}u`);
  okD(!ducked.victim, 'the same shot passes over a crouched one',
      `eye at ${eyeY(shooter).toFixed(2)}u, ducked head at ${(halfHAt(1) * 2).toFixed(2)}u`);
}

// Crouch on the wire. It has to reach the client, because it decides both the drawn
// height and what a bullet can reach — a client that guessed would draw a standing
// body over a hitbox the server treats as ducked.
{
  const ducker = (ticks) => {
    const room = new Room(DEFAULT_MODE);
    const id = room.add('ducker', {});
    const p = room.players.get(id);
    room.drainEvents();
    for (let i = 0; i < ticks; i++) {
      room.queueInput(id, [{ seq: i + 1, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: C.BTN_CROUCH, wep: 0 }]);
      room.step();
    }
    return { p, wire: room.snapshotBase().players.find((q) => q.id === id) };
  };

  const full = ducker(20);
  okD(full.p.crouch === 1, 'BTN_CROUCH survives sanitizeInput and reaches the simulation',
      `crouch=${full.p.crouch}`);
  okD(full.wire?.cr === 1, 'the snapshot carries the crouch amount', `cr=${full.wire?.cr}`);

  // Mid-blend is the case worth checking: 0 and 1 survive any encoding, and the
  // in-between values are what the avatar and the hitbox are sized from for the
  // ~140ms the duck takes. Same quantisation guard as Part C, on the other field
  // that decides where a body is.
  const mid = ducker(3);
  okD(mid.p.crouch > 0 && mid.p.crouch < 1, 'caught the duck mid-blend', `crouch=${mid.p.crouch.toFixed(4)}`);
  okD(Math.abs(halfHAt(mid.wire.cr) - halfHAt(mid.p.crouch)) < EPS,
      'a mid-blend height survives wire rounding by more than the contact skin',
      `${halfHAt(mid.p.crouch).toFixed(6)} → ${halfHAt(mid.wire.cr).toFixed(6)}, EPS ${EPS}`);
}

// What right-click does, per weapon.
{
  // "you cannot just right click any weapon and scope" — the playtest note that
  // produced `alt`. Data assertions on purpose: the bug was one global mode read by
  // three systems, and the fix was one field they all read.
  const undeclared = WEAPON_IDS.filter((id) => !('alt' in WEAPONS[id]));
  okD(undeclared.length === 0, 'every weapon states what right-click does',
      undeclared.join(',') || `all ${WEAPON_IDS.length} declare \`alt\``);

  const scoped = WEAPON_IDS.filter((id) => WEAPONS[id].alt === 'scope');
  // `zoomFovs`, plural: the double scope made this an array of steps, and a test still
  // reading the old singular field finds nothing on any weapon and reports the two as
  // disagreeing when they agree perfectly.
  const zoomed = WEAPON_IDS.filter((id) => zoomStepsOf(id).length > 0);
  const lobbed = WEAPON_IDS.filter((id) => WEAPONS[id].alt === 'lob');
  const thrown = WEAPON_IDS.filter((id) => WEAPONS[id].kind === 'projectile');

  okD(scoped.length === 1 && scoped[0] === 'sniper', 'exactly one weapon scopes', `[${scoped}]`);
  okD(scoped.join() === zoomed.join(), 'alt:scope and zoomFovs can never disagree',
      `scope [${scoped}] vs zoomFovs [${zoomed}]`);
  // The double scope itself — "you can do double scope aswell just one clicking". Two
  // steps, and the second has to be narrower than the first or the second click is a
  // click that does nothing.
  const steps = zoomStepsOf('sniper');
  okD(steps.length === 2, 'the sniper has two zoom steps to cycle', `[${steps}]`);
  okD(steps.every((f, i) => i === 0 || f < steps[i - 1]), 'and each one is narrower than the last',
      `${steps.join('° → ')}°`);
  // Compared against the NARROWEST unscoped view a player can choose (the fov setting
  // clamps to 70–110), not against the default: a first step that only zooms for players
  // on a wide FOV is a scope that does nothing for the players who set 70.
  okD(steps[0] < 70, 'the first step zooms even for a player on the narrowest FOV setting',
      `${steps[0]}° vs a 70–110° unscoped range`);
  // Derived from `kind` rather than listed, so adding a throwable cannot leave it as
  // the one thing in slot 4 with no underhand. `throwProjectile` gates the lob on
  // `alt === 'lob'` precisely so this stays a property of the table.
  okD(lobbed.join() === thrown.join(), 'every throwable lobs, and nothing else does',
      `lob [${lobbed}] vs projectile [${thrown}]`);
  okD(WEAPON_IDS.every((id) => scopes(id) === (WEAPONS[id].alt === 'scope')),
      'scopes() agrees with the table for every weapon',
      WEAPON_IDS.map((id) => `${id}:${scopes(id) ? 'y' : 'n'}`).join(' '));
  okD(!scopes('knife') && !scopes('pistol') && !scopes('rifle'),
      'right-clicking a knife does nothing at all', 'knife, pistol and rifle do not scope');
  // The other half of the complaint — "grenade right click is fine but the problem
  // is its on the middle". A non-scope alt must carry no zoom, because zoom is what
  // pulled the weapon to the centre of the screen.
  okD(lobbed.every((id) => zoomStepsOf(id).length === 0), 'a lob carries no zoom of its own',
      lobbed.map((id) => `${id}:${zoomStepsOf(id).length || 'none'}`).join(' '));
}

// The other verb right-click can have: a heavier attack. "the knife if left click
// slash right click some better knife you know like cs2" — so doing *nothing* was
// never the fix for the scoping knife, and these assert the trade rather than the
// absence. Same discipline as the block above: one field, read from one place.
{
  const heavies = WEAPON_IDS.filter((id) => WEAPONS[id].alt === 'heavy');
  const blocks = WEAPON_IDS.filter((id) => WEAPONS[id].heavy);
  okD(heavies.length === 5 && heavies.every((id) => WEAPONS[id].family === 'knife'),
      'all five knives, and only knives, have a heavy attack', `[${heavies}]`);
  okD(heavies.join() === blocks.join(), 'alt:heavy and a heavy stat block can never disagree',
      `alt [${heavies}] vs block [${blocks}]`);
  okD(WEAPON_IDS.every((id) => hasHeavy(id) === (WEAPONS[id].alt === 'heavy' && !!WEAPONS[id].heavy)),
      'hasHeavy() agrees with the table for every weapon',
      WEAPON_IDS.map((id) => `${id}:${hasHeavy(id) ? 'y' : 'n'}`).join(' '));
  okD(!scopes('knife') && hasHeavy('knife'), 'right-clicking the knife stabs rather than scopes',
      `alt=${WEAPONS.knife.alt}`);

  // shotStats is what makes the heavy attack invisible to everything downstream: one
  // weapon-shaped object, so resolveShot, the fire clamp and the damage all read the
  // same numbers and none of them knows a button was held.
  const light = shotStats('knife', false);
  const heavy = shotStats('knife', true);
  okD(light === WEAPONS.knife, 'without the button, a weapon is itself', 'same object');
  okD(heavy.dmg > light.dmg && heavy.intervalMs > light.intervalMs,
      'the heavy attack hits harder and slower — the whole trade',
      `${light.dmg}@${light.intervalMs}ms → ${heavy.dmg}@${heavy.intervalMs}ms`);
  okD(heavy.range >= light.range, 'and reaches no shorter', `${light.range}u → ${heavy.range}u`);
  okD(heavy.kind === 'melee' && heavy.mag === null,
      'the merge keeps it a knife rather than turning it into a gun',
      `kind=${heavy.kind} mag=${heavy.mag}`);
  okD(Math.ceil(C.MAX_HP / heavy.dmg) === 2 && Math.ceil(C.MAX_HP / light.dmg) === 2,
      'both are two-hit kills, so the heavy buys reach and damage rather than a one-shot',
      `${Math.ceil(C.MAX_HP / light.dmg)} light / ${Math.ceil(C.MAX_HP / heavy.dmg)} heavy`);
  okD(shotStats('rifle', true) === WEAPONS.rifle, 'a weapon with no heavy block ignores the button',
      'rifle unchanged');
}

// The CS2 number-key layout: 1 primary, 2 secondary, 3 knife, 4 thrown. Asserted as
// data because the point of the layout is muscle memory — 3 has to be the knife
// whatever else a random deal put in your hands.
{
  const unslotted = WEAPON_IDS.filter((id) => !slotOf(id));
  okD(unslotted.length === 0, 'every weapon sits in a number-key slot',
      unslotted.join(',') || WEAPON_IDS.map((id) => `${slotOf(id)}:${id}`).join(' '));
  okD(slotOf('knife') === 3, 'the knife is slot 3', `slot ${slotOf('knife')}`);
  okD(slotOf('pistol') === 2, 'the pistol is slot 2', `slot ${slotOf('pistol')}`);
  okD(slotOf('rifle') === 1 && slotOf('sniper') === 1, 'both primaries share slot 1',
      `rifle ${slotOf('rifle')}, sniper ${slotOf('sniper')}`);
  okD(slotOf('grenade') === 4 && slotOf('snowball') === 4, 'the throwables share slot 4',
      `grenade ${slotOf('grenade')}, snowball ${slotOf('snowball')}`);

  // Selection goes through the slot, not through a position in the loadout list.
  const hand = DM.loadout.map(indexOf);
  okD(slotPick(hand, 3) === indexOf('knife'), '3 selects the knife out of a full hand',
      `#${slotPick(hand, 3)}`);
  // Slot 1 holds every primary in the full list, so pressing it cycles through them
  // rather than snapping back to the first — a dead key would be the alternative.
  // Walked the whole ring rather than assuming two, because the ring grew from two to
  // six when the rest of the arsenal landed and a hardcoded length would have started
  // reporting a working key as broken.
  const inOne = hand.filter((i) => slotOf(WEAPON_IDS[i]) === 1);
  const ring = [];
  let at = -1;
  for (let n = 0; n < inOne.length; n++) {
    at = slotPick(hand, 1, at);
    ring.push(at);
  }
  okD(new Set(ring).size === inOne.length && slotPick(hand, 1, ring.at(-1)) === ring[0],
      '1 cycles through every primary in the hand and wraps',
      ring.map((i) => WEAPON_IDS[i]).join(' → '));
  okD(slotPick([indexOf('knife')], 1) === -1, 'a slot you are carrying nothing for selects nothing',
      `${slotPick([indexOf('knife')], 1)}`);
}

// The heavy attack in a live room: its own damage, its own cadence, and — the part
// worth a test of its own — no way to borrow one and pay for the other.
{
  const HV = shotStats('knife', true);
  const ticks = Math.round(2000 / STEP_MS);
  const r = duel({ wep: 'knife', gap: MELEE_GAP, ms: 0 });
  const mark = r.events.length;
  // Left-click worked, right-click held down throughout: the stab is chosen by ALT, so
  // releasing fire between swings must not release the choice with it.
  r.trigger(ticks, C.BTN_ALT);
  const ev = r.events.slice(mark);
  const s = ev.filter((e) => e.e === EV.SHOT);
  const h = ev.filter((e) => e.e === EV.HIT);

  okD(s.length === shotsIn(HV, ticks), `the heavy stab swings at ${HV.intervalMs}ms`,
      `${s.length} in 2s, expected ${shotsIn(HV, ticks)}`);
  okD(s.every((e) => e.a === 1), 'every heavy swing is flagged on the wire',
      'the client cannot read the animation off its own mouse — the button can change in flight');
  okD(h.length === Math.ceil(C.MAX_HP / HV.dmg), `and does ${HV.dmg} per hit`,
      `${h.length} hits to kill`);
  okD(C.MAX_HP - (h[0]?.hp ?? C.MAX_HP) === HV.dmg, 'the first hit took exactly the heavy figure',
      `${C.MAX_HP - (h[0]?.hp ?? C.MAX_HP)} dmg`);
  okD(r.B.alive === false, 'the heavy stab killed the target', `hp=${r.B.hp}`);
}

// The exploit the fire clamp has to close. Two attacks with different cadences mean
// "how long since the last shot" is the wrong question: measured against the LIGHT
// interval, a heavy stab could be followed by a light slash 480ms later — the heavy
// attack's 90 damage at the light attack's rate, for free. The clamp is a deadline
// instead, so what you pay is set by the attack you actually made.
{
  const light = shotStats('knife', false);
  const heavy = shotStats('knife', true);
  const lightTicks = Math.ceil(light.intervalMs / STEP_MS);
  const heavyTicks = Math.ceil(heavy.intervalMs / STEP_MS);

  const r = duel({ wep: 'knife', gap: MELEE_GAP, ms: 0 });
  r.trigger(1, C.BTN_ALT);
  const stab = r.events.filter((e) => e.e === EV.SHOT);
  okD(stab.length === 1 && stab[0].a === 1, 'one heavy stab landed', `${stab.length} swings`);

  // Release right-click and work left. Nothing may come out until the STAB's interval
  // has run, not the slash's — and it has to be worked rather than held, or the knife
  // being non-automatic would produce the same silence with no clamp at all.
  const mark = r.events.length;
  r.trigger(lightTicks + 4);
  const early = r.events.slice(mark).filter((e) => e.e === EV.SHOT);
  okD(early.length === 0, 'a light slash cannot cash in on the heavy attack\'s cooldown',
      `${early.length} free slashes in the ${Math.round((lightTicks + 4) * STEP_MS)}ms after a ${heavy.intervalMs}ms stab`);

  // And the deadline does expire — a clamp that never lifts is just a broken knife.
  const mark2 = r.events.length;
  r.trigger(heavyTicks - lightTicks + 2);
  const late = r.events.slice(mark2).filter((e) => e.e === EV.SHOT);
  okD(late.length >= 1 && !late[0].a, `and past ${heavy.intervalMs}ms the slash comes out`,
      `${late.length} swings, first flagged a=${late[0]?.a ?? 'none'}`);
}

// Holding right-click on a weapon with no alt must be inert server-side. The bit
// reaches the server because a lobbed throw needs it, and it must not quietly change
// anything else on the way past.
{
  const ticks = Math.round(1200 / STEP_MS);
  const r = duel({ wep: 'rifle', ms: 0 });
  const mark = r.events.length;
  r.trigger(ticks, C.BTN_ALT);
  const s = r.events.slice(mark).filter((e) => e.e === EV.SHOT);
  okD(s.length === shotsIn(RIFLE, ticks), 'holding right-click changes nothing about a rifle',
      `${s.length} shots, same as the ${shotsIn(RIFLE, ticks)} expected without it`);
}

// The lob arc. Both halves matter: the speed drop is what keeps a grenade from
// crossing the arena, and the extra lift is what clears the wall you are behind.
{
  const dir = { x: 1, y: 0, z: 0 };
  const flight = (pr) => {
    let apex = pr.y;
    for (let i = 0; i < 600 && !pr.done; i++) {
      stepProjectile(pr, C.TICK_DT, FLAT, i * STEP_MS);
      apex = Math.max(apex, pr.y);
    }
    return { range: Math.abs(pr.x), apex };
  };
  const thrown = (kind, lob) => createProjectile(kind, 1, 0, 1.5, 0, dir, 0, lob);

  for (const kind of ['grenade', 'snowball']) {
    const flat = thrown(kind, false);
    const lob = thrown(kind, true);
    okD(Math.hypot(lob.vx, lob.vz) < Math.hypot(flat.vx, flat.vz), `a lobbed ${kind} leaves the hand slower`,
        `${Math.hypot(lob.vx, lob.vz).toFixed(1)} vs ${Math.hypot(flat.vx, flat.vz).toFixed(1)} u/s`);
    okD(lob.vy > flat.vy, `a lobbed ${kind} leaves the hand higher`,
        `vy ${lob.vy.toFixed(1)} vs ${flat.vy.toFixed(1)} u/s`);

    // Fresh projectiles, because flight() consumes the ones it is given.
    const F = flight(thrown(kind, false));
    const L = flight(thrown(kind, true));
    okD(L.range < F.range, `a lobbed ${kind} lands short of a flat throw`,
        `${L.range.toFixed(1)}u vs ${F.range.toFixed(1)}u`);
    okD(L.apex > F.apex, `and goes over the top on the way there`,
        `apex ${L.apex.toFixed(2)}u vs ${F.apex.toFixed(2)}u`);
  }

  const room = new Room(DEFAULT_MODE);
  room.projectiles = [thrown('grenade', false)];
  const wire = room.snapshotBase().proj?.[0];
  okD(wire?.o === 1 && [wire?.vx, wire?.vy, wire?.vz].every(Number.isFinite)
      && Math.hypot(wire.vx, wire.vy, wire.vz) > 1,
      'the first projectile snapshot carries its authoritative velocity',
      `owner ${wire?.o}, v=(${wire?.vx},${wire?.vy},${wire?.vz}) — the browser need not wait for two positions before moving it`);
  const renderSrc = readFileSync(new URL('./client/src/render.js', import.meta.url), 'utf8');
  okD(renderSrc.includes("import { ARENA, WORLD_BOXES } from '../../shared/map.js';")
      && renderSrc.includes('stepProjectile(s, dt, WORLD_BOXES, 0)'),
      'the renderer imports the collision world used by live projectile frames',
      'an undefined WORLD_BOXES would stop requestAnimationFrame on the first throwable');
  okD(renderSrc.includes('vx: Number.isFinite(q.vx) ? q.vx : 0')
      && renderSrc.includes('s.vx = Number.isFinite(q.vx) ? q.vx'),
      'and the renderer starts and reconciles flight from that velocity',
      'a newly released grenade advances on its first drawn frame instead of freezing until the next snapshot');
  const mainThrowSrc = readFileSync(new URL('./client/src/main.js', import.meta.url), 'utf8');
  okD(renderSrc.includes('predictProjectile(kind, owner, x, y, z, dir, now, lob = false)')
      && renderSrc.includes('v.predicted && v.sim.kind === q.k && v.sim.owner === q.o')
      && mainThrowSrc.includes('view.predictProjectile('),
      'the client launches a cosmetic grenade immediately and authority adopts the same mesh',
      'click-time flight covers the round trip; the server still owns the burst, damage and final position');
  const viewmodelThrowSrc = readFileSync(new URL('./client/src/viewmodel.js', import.meta.url), 'utf8');
  okD(mainThrowSrc.includes('onThrowRelease: (id, at)')
      && mainThrowSrc.includes('action.heavy,')
      && viewmodelThrowSrc.includes("hooks.onThrowRelease?.(currentId, now)")
      && !mainThrowSrc.includes('setTimeout(() => {\n        if (predictedAction !== action) return;'),
      'the visible hand-release frame launches the predicted grenade directly',
      'no independent timer can stall behind the animation while the authoritative fuse keeps burning');
}

// The other thing right-click must not mean: a scope, while the action is stuck.
//
// A scoped weapon is drawn as NOTHING — `g.visible = scopeK < 0.5`, because narrowing
// the FOV magnifies the viewmodel along with the world, and a magnified receiver covers
// the middle of the screen under an overlay that is opaque by then anyway. So a sniper
// that jammed while scoped showed no gun, no hands and no clearing punch: 1.4 seconds of
// dead trigger behind the glass, in precisely the state the punch exists to explain.
//
// Both halves of the fix are client-side and neither is geometry, so they are here rather
// than in Part G: input.js drops the latch that holds the zoom, viewmodel.js refuses to
// hold an alt pose through a stoppage, and the property is that the two agree.
{
  // input.js is driven through its own listeners rather than around them. A latch's
  // failure mode is exactly that nothing releases it — that is what separates it from the
  // held button it replaced — so a test that called an exported helper would not be
  // testing the thing that broke. Node has neither `document` nor `window`, so this is an
  // install-and-remove rather than a save-and-restore.
  const handlers = new Map();
  const canvas = {};
  const doc = {
    addEventListener: (k, f) => handlers.set(k, f),
    pointerLockElement: null,
    fullscreenElement: null,
  };
  globalThis.document = doc;
  globalThis.window = { addEventListener: (k, f) => handlers.set(`window:${k}`, f) };
  const { createInput } = await import('./client/src/input.js');
  const ZOOM_SENS = 0.4;
  const input = createInput(canvas, { sens: 1, zoomSens: ZOOM_SENS, binds: DEFAULT_BINDS });

  input.setLoadout([indexOf('sniper'), indexOf('pistol')]);
  doc.pointerLockElement = canvas;
  handlers.get('pointerlockchange')();
  const rmb = () => handlers.get('mousedown')({ button: 2 });
  /** One mouse movement, as the browser delivers it. Returns how far the view turned. */
  const drag = (dx) => {
    const was = input.lookYaw;
    handlers.get('mousemove')({ movementX: dx, movementY: 0 });
    return Math.abs(input.lookYaw - was);
  };
  const steps = zoomStepsOf('sniper').length;

  okD(input.locked && handlers.has('mousedown'), 'the input module runs headless on a stub DOM',
      `${handlers.size} listeners, pointer lock held`);
  rmb();
  okD(input.scopeStep === 1 && input.scoping, 'one right-click latches the sniper into its first zoom',
      `step ${input.scopeStep} of ${steps}`);
  // Measured before the jam, because a stoppage is about to take the zoom away and half
  // the point is that the mouse goes with it.
  const zoomed = drag(100);

  input.setJammed(true);
  okD(input.scopeStep === 0 && !input.scoping, 'a stoppage drops the latch on its rising edge',
      `step ${input.scopeStep}`);
  rmb();
  rmb();
  rmb();
  okD(input.scopeStep === 0, 'and right-clicking through one cannot put the eye back in the scope',
      `3 clicks during the ${JAM_CLEAR_MS}ms, still step 0`);
  const hipfire = drag(100);
  okD(hipfire > 0 && Math.abs(zoomed / hipfire - ZOOM_SENS) < 1e-12,
      'so the mouse comes back to its own speed with the view, not the scope’s',
      `${zoomed.toFixed(4)} vs ${hipfire.toFixed(4)} rad per 100px = zoomSens ${ZOOM_SENS}`);

  input.setJammed(false);
  rmb();
  okD(input.scopeStep === 1, 'and the scope answers the next click once the action is clear',
      `step ${input.scopeStep}`);
  for (let i = 0; i < steps; i++) rmb();
  okD(input.scopeStep === 0, 'the double scope still cycles all the way back to unscoped',
      `${steps + 1} clicks per cycle`);


  // ---- and the one line in main.js that connects the two --------------------------------
  // Lifted and run against the real input above, because the interesting part of it is
  // not `setJammed` — it is the per-weapon guard. A stoppage is per-weapon on the server,
  // so a player who puts the jammed rifle away and draws the pistol must get the scope
  // back immediately rather than for the rest of the 1400ms. Part B pins what the server
  // puts on the wire (`jm` in ms remaining, and OMITTED rather than zeroed on a working
  // weapon); this pins what the client does with it.
  const mainSrc = readFileSync(new URL('./client/src/main.js', import.meta.url), 'utf8');
  const wiring = /(jamMs = m\.self\.w[\s\S]*?input\.setJammed\([^\n]*\);)/.exec(mainSrc);
  if (!wiring) throw new Error('could not read the jam wiring out of main.js');
  const onSnapshot = new Function('m', 'input', `let jamMs; ${wiring[1]} return jamMs;`);
  const sniperI = indexOf('sniper');
  const pistolI = indexOf('pistol');

  onSnapshot({ self: { w: sniperI } }, input);
  rmb();
  const inHand = onSnapshot({ self: { w: sniperI, jm: 900 } }, input);
  okD(inHand === 900 && input.scopeStep === 0 && input.weapon === sniperI,
      'a snapshot reporting a stoppage on the weapon in hand takes the scope down',
      `jm 900 → jamMs ${inHand}, step ${input.scopeStep}`);

  onSnapshot({ self: { w: sniperI } }, input);
  rmb();
  const away = onSnapshot({ self: { w: pistolI, jm: 900 } }, input);
  okD(away === 0 && input.scopeStep === 1,
      'and one on a weapon that has since been put away leaves it alone',
      `jm 900 on slot ${pistolI} while holding ${sniperI} → jamMs ${away}, step ${input.scopeStep}`);

  const clear = onSnapshot({ self: { w: sniperI } }, input);
  okD(clear === 0 && input.scopeStep === 1,
      'a working weapon omits the field entirely and the scope survives the snapshot',
      `no jm → jamMs ${clear}, step ${input.scopeStep}`);

  // Knife controls follow the established FPS contract: left-click light, right-click
  // heavy. The old input only sent BTN_ALT on right-click, so nothing happened until the
  // player also pressed left — a modifier chord disguised as an attack button.
  handlers.get('mouseup')({ button: 2 });
  const knifeI = indexOf('knife');
  input.setLoadout([knifeI]);
  input.setWeapon(knifeI);
  rmb();
  handlers.get('mouseup')({ button: 2 });
  const stab = input.sample();
  const released = input.sample();
  okD((stab.buttons & (C.BTN_FIRE | C.BTN_ALT)) === (C.BTN_FIRE | C.BTN_ALT),
      'right-clicking a knife directly sends one heavy attack',
      `buttons ${stab.buttons}: fire+alt together, without a left-click chord`);
  okD(!(released.buttons & C.BTN_FIRE),
      'and holding or releasing right-click does not repeat the stab',
      'one click is one edge-triggered heavy swing');

  // ---- Shift: two verbs off one key ------------------------------------------------------
  // The server only ever sees the same two level-triggered bits, so the entire tap/hold
  // discrimination lives in this module and this is the only place it can be checked. Driven
  // through the real listeners for the reason the scope above is: a latch's failure mode is
  // that nothing releases it.
  //
  // TAP_MS is lifted rather than transcribed — a copy of the threshold compared against
  // itself would pass at any value, including a value nobody can tap under.
  const inpSrc = readFileSync(new URL('./client/src/input.js', import.meta.url), 'utf8');
  const TAP_MS = Number(/const TAP_MS = (\d+);/.exec(inpSrc)?.[1]);
  okD(TAP_MS >= 100 && TAP_MS <= 250, 'the tap window is short enough to be a tap and long enough to hit',
      `TAP_MS ${TAP_MS}ms, lifted from input.js`);

  // performance.now() is stubbed because 150ms of real time cannot be asserted about; it is
  // restored in the finally. input.js resolves the global on every call, so this reaches an
  // already-imported module without it having to know.
  const realPerf = globalThis.performance;
  let clock = 1000;
  globalThis.performance = { now: () => clock };
  try {
    const kd = (code) => handlers.get('window:keydown')({ code, preventDefault() {} });
    const ku = (code) => handlers.get('window:keyup')({ code, preventDefault() {} });
    const bits = () => input.sample().buttons;
    const walking = () => !!(bits() & C.BTN_WALK);
    const sprinting = () => !!(bits() & C.BTN_SPRINT);
    const SHIFT = DEFAULT_BINDS.walk;
    // The scope tests above left BTN_ALT set, so a raw buttons number here would read as
    // noise; name the three bits this block is actually about.
    const shown = () => Object.entries({ walk: C.BTN_WALK, sprint: C.BTN_SPRINT, alt: C.BTN_ALT })
      .filter(([, m]) => bits() & m).map(([k]) => k).join('+') || 'none';

    // Forward stays down throughout: the last assert here runs what sample() produced
    // through the real stepPlayer, and sprintOk needs a movement intent to answer at all.
    kd(DEFAULT_BINDS.forward);
    okD(input.sample().moveZ === 1, 'the stub keyboard reaches the movement axes',
        `moveZ ${input.sample().moveZ}`);

    // A tap. Nothing about it may look like a walk, at any point in it.
    kd(SHIFT);
    const onThePress = walking();
    clock += TAP_MS - 70;
    const stillNot = walking();
    ku(SHIFT);
    okD(!onThePress && !stillNot,
        'a tap never emits one tick of walk, not even the tick it was pressed on',
        'BTN_WALK is deferred past TAP_MS, so an honest client and one that omits the bit '
        + 'during the window send identical bits — the other order pays for cheating');
    okD(input.sprintArmed && sprinting(), 'and it arms sprint', `buttons: ${shown()}`);

    // A second tap is the only thing that puts it away again.
    clock += 500;
    kd(SHIFT);
    clock += TAP_MS - 70;
    ku(SHIFT);
    okD(!input.sprintArmed && !sprinting(), 'tapping again disarms it', `buttons: ${shown()}`);

    // A hold. Quiet, on time, and no sprint at the end of it.
    clock += 500;
    kd(SHIFT);
    clock += TAP_MS - 1;
    const justBefore = walking();
    clock += 2;
    const justAfter = walking();
    okD(!justBefore && justAfter, 'a hold starts walking once it has lasted, and not before',
        `${TAP_MS - 1}ms → no walk, ${TAP_MS + 1}ms → walk`);
    clock += 1000;
    ku(SHIFT);
    okD(!input.sprintArmed, 'and releasing a hold does not arm sprint',
        'it had been walking for a second — arming here is the bug where a slow release sprints');

    // Shift is a sided key and down('walk') answers to both halves, so a timer keyed on the
    // raw code would read L-down → R-down → L-up as a 20ms tap and hand out a free sprint
    // in the middle of a walk.
    clock += 500;
    kd('ShiftLeft');
    clock += 400;
    kd('ShiftRight');
    clock += 20;
    ku('ShiftLeft');
    okD(!input.sprintArmed && walking(),
        'swapping from one Shift to the other mid-walk is not a tap',
        'both edges sample the walk ACTION, not the key that moved');
    ku('ShiftRight');
    okD(!input.sprintArmed && !walking(), 'and letting go of the second one ends the walk',
        `buttons: ${shown()}`);

    // Armed sprint plus a held Shift, end to end: the bits sample() really produced, through
    // the real stepPlayer, against a walk driven the ordinary way.
    clock += 500;
    kd(SHIFT); clock += TAP_MS - 70; ku(SHIFT);   // arm
    clock += 500;
    kd(SHIFT); clock += 1000;                     // and now hold it as well
    const both = bits();
    const drive = (buttons) => {
      const s = createPlayerState({ x: 0, y: C.PLAYER_HALF_H, z: 0, yaw: 0 });
      for (let i = 0; i < 240; i++) {
        stepPlayer(s, { moveX: 0, moveZ: 1, yaw: 0, pitch: 0, buttons, wep: 0 }, C.TICK_DT, FLAT);
      }
      return Math.hypot(s.vx, s.vz);
    };
    const paired = drive(both);
    const plain = drive(C.BTN_WALK);
    okD(!!(both & C.BTN_WALK) && !!(both & C.BTN_SPRINT),
        'holding Shift with sprint still armed sends both bits at once',
        'the client reports and does not arbitrate — sprintOk() in movement.js decides');
    okD(paired === plain, 'and the pair moves at exactly a walk, because walk always wins',
        `${paired.toFixed(4)} u/s against a plain walk's ${plain.toFixed(4)}, bit for bit`);
    ku(SHIFT);

    // The edges: every case where the key stops being held without a keyup this module ever
    // sees. A latch left set in any of them is still set in the next life.
    const arm = () => {
      clock += 500;
      if (!input.sprintArmed) { kd(SHIFT); clock += TAP_MS - 70; ku(SHIFT); }
      return input.sprintArmed;
    };
    okD(arm(), 'sprint arms again for the edge cases below', 'precondition');
    doc.pointerLockElement = null;
    handlers.get('pointerlockchange')();
    const afterUnlock = input.sprintArmed;
    doc.pointerLockElement = canvas;
    handlers.get('pointerlockchange')();
    okD(!afterUnlock, 'releasing the mouse disarms sprint',
        'the keys.clear() there skips the keyup that would have resolved the hold');

    arm();
    handlers.get('window:blur')();
    okD(!input.sprintArmed, 'and so does losing focus', 'same missing keyup as pointer lock');

    arm();
    input.setAlive(false);
    okD(!input.sprintArmed, 'and dying', 'nobody asked to respawn already sprinting');
    input.setAlive(true);

    arm();
    input.setBinds({ ...DEFAULT_BINDS, walk: 'AltLeft' });
    okD(!input.sprintArmed, 'and rebinding, because walk may have just left Shift entirely',
        'the key that would release the latch is no longer the key that set it');
    input.setBinds(DEFAULT_BINDS);

    // And the two it must NOT answer to. You can shoot while sprinting — stamina is the
    // whole limiter — so wiring a stoppage or a swap in here later would be a change of
    // design rather than a missing case, and this is where that argument is kept.
    arm();
    input.setJammed(true);
    const throughJam = input.sprintArmed;
    input.setJammed(false);
    input.setWeapon(indexOf('pistol'));
    okD(throughJam && input.sprintArmed,
        'a stoppage and a weapon switch both leave sprint alone',
        'sprint is not a weapon state and has no jam interaction');
    ku(DEFAULT_BINDS.forward);
  } finally {
    globalThis.performance = realPerf;
  }
  delete globalThis.document;
  delete globalThis.window;

  // ---- and the viewmodel half, lifted rather than transcribed --------------------------
  // Four shipped statements stand between that latch and the pixel. A copy of an
  // expression compared against itself asserts nothing, so what is checked is the
  // property: no verb can hold its alt pose through a stoppage, and the weapon comes back
  // fast enough to be worth looking at.
  const vmSrc = readFileSync(new URL('./client/src/viewmodel.js', import.meta.url), 'utf8');
  const shipped = (label, re) => {
    const all = vmSrc.match(new RegExp(re.source, 'g')) ?? [];
    if (all.length !== 1) throw new Error(`${label}: ${all.length} matches in viewmodel.js, wanted 1`);
    return re.exec(vmSrc)[1];
  };
  const wantAltOf = new Function('up', 'alt', 'reloadP', 'jamP',
      `return ${shipped('wantAlt', /const wantAlt = ([\s\S]*?);/)};`);
  const blend = new Function('altK', 'wantAlt', 'dt',
      `${shipped('the alt blend', /(altK \+= [^\n]*?;)/)} return altK;`);
  // `wantAlt` and not `altK`, which is the sniper fix itself: the glass is now the RAW
  // intent, 1 or 0 and nothing in between, rather than the eased pose blend. The lift is
  // pinned to that so the day somebody puts the ease back the suite throws instead of
  // quietly re-measuring a fade.
  const scopeKOf = new Function('scopes', 'currentId', 'wantAlt',
      `let scopeK; ${shipped('scopeK', /(scopeK = scopes\(currentId\) \? wantAlt : 0;)/)} return scopeK;`);
  const drawn = new Function('scopeK',
      `const g = {}; ${shipped('g.visible', /(g\.visible = scopeK < [0-9.]+;)/)} return g.visible;`);
  // Which zoom, as opposed to whether. Snapped to a table entry, so a double scope's second
  // click is also instant instead of a 230ms crawl inward with the gain already at the far
  // zoom's ratio.
  const zoomOf = new Function('steps', 'scopedStep',
      `let zoomFovK = -1; ${shipped('zoomFovK', /(zoomFovK = steps\[scopedStep - 1\];)/)} return zoomFovK;`);

  // Every verb, every phase of a stoppage, with and without a reload over the top of it.
  // `jamP` runs 0..1 across the 1400ms and is -1 the rest of the time, so `>= 0` is the
  // whole of "stuck".
  let held = 0;
  let raised = 0;
  let cases = 0;
  for (const up of [true, false]) {
    for (const alt of ['scope', 'lob', 'heavy', null]) {
      for (const reloadP of [-1, 0, 0.5]) {
        for (const jamP of [-1, 0, 0.5, 1]) {
          const w = wantAltOf(up, alt, reloadP, jamP);
          cases++;
          if (jamP >= 0 && w !== 0) held++;
          if (jamP < 0 && w === 1) raised++;
        }
      }
    }
  }
  okD(held === 0 && raised > 0, 'no right-click verb can hold its pose through a stoppage',
      `0 of ${cases} combinations, and ${raised} of them still raise the pose with the action clear`);

  // From a settled scope, at five frame rates, with `up` left TRUE: the latch above has
  // already dropped it, and the point of the `jamP` term is that the weapon comes back
  // even if something one day forgets to.
  //
  // What is measured is no longer "fast enough" but IMMEDIATE, and that is the sniper fix
  // itself. `scopeK` used to be `altK`, easing at 13/s — about 230ms to clear — while MOUSE
  // GAIN is a step function on the same latch: it returned to 1x on the frame of the click
  // while the picture was still magnified, which is a whip on every shot and was the largest
  // part of "crazy hard to play". 1000Hz is still in the sweep because `dt * 13` decays a
  // coarse frame FASTER than a fine one, so the finest frame is the old code's worst case —
  // and it is the frame rate that now proves the most, because `altK` is still 0.99 of the
  // way in on the frame where the glass has already gone.
  //
  // Timed against the animation's own beats rather than a round number of milliseconds.
  // `beat(p, a, b)` is a sine hump: the first strike winds up at `a`, lands at the middle
  // and is spent by `b`. Both fractions are read off the shipped line, so retiming the
  // punch retimes the test with it.
  const hit1 = /const hit1 = beat\(p, ([0-9.]+), ([0-9.]+)\);/.exec(vmSrc);
  if (!hit1) throw new Error('could not read the first strike out of viewmodel.js');
  const windUp = Number(hit1[1]) * JAM_CLEAR_MS;
  const lands = ((Number(hit1[1]) + Number(hit1[2])) / 2) * JAM_CLEAR_MS;

  let slowestBack = 0;
  let slowestGone = 0;
  let slowAt = '';
  let residual = 0;
  // What the OLD line would have drawn on the frame the new one is already clear on: the
  // eased pose blend, sampled at the same instant. This is the size of the bug, in the
  // units the player saw it in.
  let poseStillIn = 0;
  let frames = 0;
  for (const hz of [30, 60, 120, 240, 1000]) {
    const dt = 1 / hz;
    const target = wantAltOf(true, 'scope', -1, 0.5);
    let altK = 1;
    let back = 0;
    let gone = 0;
    for (let i = 1; i * dt * 1000 <= JAM_CLEAR_MS; i++) {
      altK = blend(altK, target, dt);
      // `target`, not `altK` — the shipped line reads the intent. Passing the blend here
      // would test a version of the file that no longer exists.
      const scopeK = scopeKOf(scopes, 'sniper', target);
      if (!back && drawn(scopeK)) {
        back = i * dt * 1000;
        residual = Math.max(residual, scopeK);
        poseStillIn = Math.max(poseStillIn, altK);
      }
      // The overlay opacity IS scopeK — hud.scope() is handed `viewmodel.scopeAmount` and
      // rounds it to two places, so below 0.005 there is nothing left of the glass.
      if (!gone && scopeK < 0.005) gone = i * dt * 1000;
      frames++;
    }
    slowestBack = Math.max(slowestBack, back);
    slowestGone = Math.max(slowestGone, gone);
    if (back >= slowestBack) slowAt = `${hz}Hz`;
  }
  // One frame at 30Hz, which is the coarsest in the sweep: there is no faster answer a
  // frame-driven value can give than "the next frame".
  const oneFrame = 1000 / 30 + 0.001;
  okD(slowestBack > 0 && slowestBack <= oneFrame && slowestGone <= oneFrame && residual === 0,
      'the glass goes and the weapon comes back on the FIRST frame of a stoppage, at every frame rate',
      `worst ${slowestBack.toFixed(1)}ms (${slowAt}) over ${frames} frames from 30Hz to 1000Hz, `
      + `overlay ${residual.toFixed(2)} — against a wind-up that starts at ${windUp.toFixed(0)}ms `
      + `and a strike that lands at ${lands.toFixed(0)}ms of the ${JAM_CLEAR_MS}ms stoppage`);
  okD(poseStillIn > 0.9,
      'and the eased pose the overlay used to ride is still nearly all the way in at that moment',
      `altK ${poseStillIn.toFixed(3)} on the frame the glass is already gone — the ${(poseStillIn * 100).toFixed(0)}% `
      + 'of opaque scope the old line drew over a view whose mouse gain had already stepped back to 1x');
  // No ease anywhere near either value, checked in the source. Both are assignments now, and
  // a `+=` on either is the whole bug coming back.
  okD(!/scopeK \+=/.test(vmSrc) && !/zoomFovK \+=/.test(vmSrc),
      'neither the glass nor its zoom is eased anywhere in the file',
      'scopeK and zoomFovK are assigned, never blended — the pose blend is altK alone');

  // And the zoom itself snaps to a table entry rather than crawling toward one, which is
  // what makes the second click of a double scope instant too.
  const zsteps = zoomStepsOf('sniper');
  okD(zoomOf(zsteps, 1) === zsteps[0] && zoomOf(zsteps, 2) === zsteps[1],
      'each click of the double scope lands exactly on its own zoom, on the frame of the click',
      `step 1 → ${zoomOf(zsteps, 1)}°, step 2 → ${zoomOf(zsteps, 2)}°, table [${zsteps}]`);
}

console.log([...pD, ...fD].join('\n'));

// ────────────────────────────────── Part E: settings, keybinds, slot numbering
//
// `client/src/binds.js` is pure — no DOM, no storage — precisely so the rules that
// decide what happens when two actions want the same key can be checked here rather
// than by clicking around a settings panel. The interesting property is not any one
// swap; it is that `normalizeBinds` is the identity on `rebind`'s output. Settings are
// re-validated on every write, so if those two disagreed, the panel would silently
// undo the rebind the player just made, and only sometimes.
console.log('\n=== Part E — settings and keybinds ===\n');

const pE = [];
const fE = [];
const okE = (cond, label, detail = '') => {
  (cond ? pE : fE).push(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

{
  const sameBinds = (a, b) => ACTION_IDS.every((k) => a[k] === b[k]);
  const show = (b) => ACTION_IDS.map((k) => `${k}=${b[k] || '·'}`).join(' ');
  const bound = (b) => ACTION_IDS.map((k) => b[k]).filter(Boolean);
  const noDupes = (b) => new Set(bound(b)).size === bound(b).length;

  okE(sameBinds(normalizeBinds(DEFAULT_BINDS), DEFAULT_BINDS),
      'the default binds are already normal', show(DEFAULT_BINDS));
  okE(normalizeBinds({}).forward === 'KeyW',
      'a missing bind falls back to its default',
      'storage written before binds existed has none of them');
  okE(normalizeBinds({ crouch: 'ControlLeft' }).crouch === '',
      'a browser-owned key in storage is dropped, not honoured',
      'hand-edited settings must not be able to close the tab');

  // Ctrl is the whole reason the refusal exists — see the RISKY note in binds.js.
  okE(/browser/.test(refuseReason('ControlLeft') ?? ''), 'ctrl is refused with a reason a player can read',
      refuseReason('ControlLeft'));
  okE([...RISKY].every((c) => refuseReason(c)), 'every key the browser owns is refused',
      `${RISKY.size} codes`);
  okE(refuseReason('KeyQ') === null, 'an ordinary key is not refused');
  okE(twinOf('ShiftLeft') === 'ShiftRight' && twinOf('KeyW') === null,
      'a sided bind answers to both sides', 'walk on left shift must work on right shift');

  const swap = rebind(DEFAULT_BINDS, 'jump', 'KeyC');
  okE(swap.jump === 'KeyC' && swap.crouch !== 'KeyC', 'a rebind takes the key off whoever held it',
      `crouch=${swap.crouch || 'unbound'}`);
  okE(swap.crouch === '', 'with no free default, the displaced action comes back unbound',
      'space is jump\'s default and jump has moved off it');
  okE(sameBinds(normalizeBinds(swap), swap), 'and settings does not rewrite that', show(swap));

  // Give jump a spare key first so Space is free, then take that spare away again:
  // the displaced action should walk back to its own default rather than stay empty.
  let back = rebind(DEFAULT_BINDS, 'jump', 'KeyV');
  back = rebind(back, 'crouch', 'KeyV');
  okE(back.jump === 'Space', 'a displaced action reclaims its default when it is free', show(back));
  okE(sameBinds(normalizeBinds(back), back), 'and settings does not rewrite that either');

  // The case the first version of `rebind` got wrong: the displaced action's default
  // is itself in use, so handing it back would put two actions on one key — and
  // `normalizeBinds` would then resolve the clash by undoing the player's new bind.
  let tangle = rebind(DEFAULT_BINDS, 'jump', 'KeyC');
  tangle = rebind(tangle, 'crouch', 'Space');
  tangle = rebind(tangle, 'walk', 'KeyC');
  okE(noDupes(tangle), 'no key is ever left doing two jobs', show(tangle));
  okE(tangle.jump === '', 'a displaced action is never handed a key already in use',
      'space belongs to crouch now');
  okE(sameBinds(normalizeBinds(tangle), tangle) && normalizeBinds(tangle).walk === 'KeyC',
      'normalising a rebind is the identity, so the newest bind always survives',
      show(normalizeBinds(tangle)));

  okE([keyLabel('KeyW'), keyLabel('Digit3'), keyLabel('Space'), keyLabel('ShiftLeft'), keyLabel('')]
      .join('/') === 'W/3/space/l-shift/—',
      'keys are labelled the way a player would name them',
      'the bind hint under the title is generated from these');

  // The HUD strip numbers by the weapon's own slot, not by position in the loadout.
  // Those coincide for a dealt hand and diverge in sniper match, whose loadout has one
  // sniper and five knife shapes — position would label them 2..6 while 3 is the key
  // that cycles through every knife.
  const strip = MODES.sniper.loadout.map((id) => ({ id, slot: WEAPONS[id].slot }))
    .sort((a, b) => a.slot - b.slot);
  const knifeStrip = strip.filter((s) => s.slot === 3);
  okE(strip[0]?.id === 'sniper' && strip[0]?.slot === 1 && knifeStrip.length === 5
      && knifeStrip.every((s) => WEAPONS[s.id].family === 'knife'),
      'the slot strip is numbered by slot, not by loadout position',
      strip.map((s) => `${s.slot} ${s.id}`).join(', '));
  const sniperHand = MODES.sniper.loadout.map(indexOf);
  const knifeRing = [];
  let knifeAt = -1;
  for (let i = 0; i < knifeStrip.length; i++) {
    knifeAt = slotPick(sniperHand, 3, knifeAt);
    knifeRing.push(knifeAt);
  }
  okE(new Set(knifeRing).size === knifeStrip.length
      && slotPick(sniperHand, 3, knifeRing.at(-1)) === knifeRing[0],
      'and key 3 cycles through every knife model and wraps',
      knifeRing.map((id) => WEAPON_IDS[id]).join(' → '));
}

console.log([...pE, ...fE].join('\n'));

// ─────────────────────────────────────────────── Part F: AI opponents
console.log('\n=== Part F — AI opponents (in-process Room) ===\n');

const pF = [];
const fF = [];
const okF = (cond, label, detail = '') => {
  (cond ? pF : fF).push(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

{
  // Population control first, on a room with nobody watching. `setBots` runs on every
  // join, every leave and every drag of the slider, so it has to be a level that can
  // be set repeatedly rather than a door that can only be opened.
  const room = new Room(DEFAULT_MODE);
  okF(room.setBots(4) === 4 && room.players.size === 4,
      'setBots seats the number of bots asked for', `${room.bots.size} bots, ${room.players.size} players`);
  okF(room.setBots(4) === 4 && room.players.size === 4,
      'and asking again for the same number changes nothing', 'idempotent — it is called on every join and leave');
  okF(room.setBots(999) === C.MAX_BOTS,
      'a count past MAX_BOTS is clamped rather than honoured', `asked 999, seated ${room.bots.size}`);

  // Trimming has to take the newest, or turning the slider down deletes whichever bot
  // you have spent the last minute fighting.
  const oldest = [...room.bots][0];
  room.setBots(2);
  okF(room.bots.size === 2 && room.bots.has(oldest),
      'trimming removes the newest bots, not the oldest', `kept #${[...room.bots]}`);
  okF(room.players.size === 2, 'a removed bot leaves the player list with it', `${room.players.size} players`);
  okF(room.setBots(0) === 0 && room.players.size === 0,
      'zero empties the room completely', 'a server nobody is connected to must not sit there simulating AI');
}

{
  // Now a real match: nothing but bots, long enough that everything below is a property
  // a human would notice within a minute of walking in — a bot rooted to its spawn, a
  // bot that never shoots, a bot standing inside a crate.
  //
  // Ninety seconds, not the forty-five it was, and not the twenty before that. The window is a
  // function of the map: the arena is 64 units across, a bot crosses it in about nine seconds,
  // and it then has to get an unobstructed eye on a moving target through two lanes' worth of
  // cover. What twenty seconds bought was a room where the shooting had barely started — and
  // the assertion that suffered for it, 'every bot fired', has since been replaced by one that
  // does not depend on the clock at all (see LOOK_GATE). What still does depend on it is `hits`
  // and `kills`: those need enough encounters to have happened at all, and on this arena twenty
  // seconds is not reliably enough of them.
  //
  // Forty-five was, for those. It was not enough for the HEARD bucket of the perception audit
  // below, which is the smallest of the four and was being read as a rate at a few hundred
  // ticks — see the comment on that check for the measurements. Ninety costs 1.8s of a 13s
  // suite and turns a comparison that failed one honest run in twelve into one with seven
  // points of margin under the worst of sixteen runs.
  const SECONDS = 90;
  const TICKS = C.TICK_HZ * SECONDS;
  const N = 5;
  const room = new Room(DEFAULT_MODE);
  room.setBots(N);
  room.drainEvents(); // discard the join spawns

  const bots = [...room.players.values()];
  okF(bots.every((p) => p.name.startsWith('BOT ')),
      'every bot is named so the killfeed says who shot you', bots.map((p) => p.name).join(', '));
  okF(bots.every((p) => p.bot && typeof p.bot.think === 'function'),
      'and every one of them has a brain attached');

  // Being a bot must not reach the wire. A `bot` field on a snapshot is a field a
  // cheating client reads to tell which opponents are worth aiming at.
  const wire = room.snapshotBase();
  okF(wire.players.length === N && wire.players.every((e) => !('bot' in e)),
      'nothing on the wire says which players are bots', `snapshot fields: ${Object.keys(wire.players[0]).join(',')}`);

  const travel = new Map(bots.map((p) => [p.id, 0]));
  const swaps = new Map(bots.map((p) => [p.id, 0]));
  const at = new Map(bots.map((p) => [p.id, { x: p.x, z: p.z, w: p.wep }]));
  const shooters = new Set();
  const inside = [];

  // What each bot has had a clear look at, recomputed from outside the brain, because
  // "did every bot shoot?" is not answerable without it. See LOOK_GATE, and `perceived`
  // below for what "clear" now means.
  const look = new Map(bots.map((p) => [p.id, 0]));
  const looking = new Map(bots.map((p) => [p.id, 0]));
  /** Continuous seconds of clear view of an enemy after which not firing is a bug.
   *  REACTION_MS is 0.22s and a worst-case 180° turn at TURN_RATE is 0.60s, so this is
   *  a bit under twice what a bot needs. Continuous, not cumulative: a bot may only fire
   *  once it has held one target in view for its reaction time, so ten tenth-second
   *  glimpses are a second of line-of-sight and correctly zero shots. */
  const LOOK_GATE = 1.2;
  /**
   * Line of sight, recomputed from outside the brain — but under the SAME rules the brain
   * has, which is the part this used to get wrong. It was a bare `rayWorld` with no field of
   * view, and that is precisely the wallhack "it even know you are coming" was about:
   * measured that way a bot standing with its back to somebody counts as having a clear look
   * at them, so LOOK_GATE would demand it open fire on a target behind its own head.
   *
   * `throughSmoke`, `visible` and `inCone` are lifted out of server/ai.js as text and run
   * here, the same way Part G lifts the pose branches, because a transcription of them into
   * this file would only ever prove that the copy agrees with itself. Widen the cone in ai.js
   * and every check below widens with it; take the cone out and Part F goes red rather than
   * quietly measuring something else.
   */
  const aiSrc = readFileSync(new URL('./server/ai.js', import.meta.url), 'utf8');
  const fnText = (name) => {
    const at = aiSrc.indexOf('\nfunction ' + name + '(');
    if (at < 0) throw new Error('could not find ' + name + '() in server/ai.js');
    const i = aiSrc.indexOf('{', at);
    let depth = 0;
    for (let j = i; j < aiSrc.length; j++) {
      if (aiSrc[j] === '{') depth++;
      else if (aiSrc[j] === '}' && --depth === 0) return aiSrc.slice(at + 1, j + 1);
    }
    throw new Error('unbalanced brace in ' + name + '()');
  };
  const aiNum = (name) => {
    const m = new RegExp('const ' + name + ' = (-?[0-9.]+)').exec(aiSrc);
    if (!m) throw new Error('could not read ' + name + ' from server/ai.js');
    return Number(m[1]);
  };
  const FOV_HALF = aiNum('FOV_HALF');
  const MEMORY_MS = aiNum('MEMORY_MS');
  const HEAR_RANGE = aiNum('HEAR_RANGE');
  const eyes = new Function('rayWorld', 'WORLD_BOXES', 'FOV_HALF', [
    'const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);',
    fnText('throughSmoke'), fnText('visible'), fnText('inCone'),
    'return { visible, inCone };',
  ].join('\n'))(rayWorld, WORLD_BOXES, FOV_HALF);

  /** Every enemy `p` can honestly perceive this instant, as a Set of player ids. A superset
   *  of what `spot()` accepts, which also wants VIEW_RANGE and the mode’s own
   *  `canDamage` — so "the brain saw somebody" always implies a hit in here. */
  const perceived = (p) => {
    const eye = { x: p.x, y: eyeY(p), z: p.z };
    const out = new Set();
    for (const v of room.players.values()) {
      if (v === p || !v.alive) continue;
      const t = { x: v.x, y: eyeY(v), z: v.z };
      if (eyes.inCone(p, t) && eyes.visible(eye, t, room.clouds)) out.add(v.id);
    }
    return out;
  };
  const canSee = (p) => perceived(p).size > 0;

  /** Angle in 3D between where `p` is looking and the direction to a point. */
  const aimOff = (p, t) => {
    const cp = Math.cos(p.pitch);
    const fx = -Math.sin(p.yaw) * cp;
    const fy = Math.sin(p.pitch);
    const fz = -Math.cos(p.yaw) * cp;
    const dx = t.x - p.x;
    const dy = t.y - eyeY(p);
    const dz = t.z - p.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    return Math.acos(Math.max(-1, Math.min(1, (fx * dx + fy * dy + fz * dz) / len)));
  };

  /**
   * Could `p` have HEARD `v`? The same condition `listen()` in ai.js applies, per enemy
   * rather than picking the loudest: a round that left a barrel inside HEAR_RANGE within
   * MEMORY_MS. Through walls, deliberately — that is what sound does, and it is the only
   * reason a bot with a 120-degree cone ever turns round.
   *
   * This is a perception channel, so an enemy who just fired is not a hidden one, and the
   * audit below has to know that or it convicts the brain of the thing hearing exists to
   * do. Taking the loudest one only, as the brain does, would be closer to the brain and
   * wrong for the audit: the point of the unseen set is that NOTHING in the bot could
   * account for aim landing there, so every enemy that made a sound has to leave it.
   */
  const audible = (p, v, now) => v.lastShotAt > now - MEMORY_MS
    && room.ctl.canDamage(room, p, v)
    && Math.hypot(v.x - p.x, v.y - p.y, v.z - p.z) <= HEAR_RANGE;

  let hits = 0;
  let kills = 0;
  /** Of those hits, the ones the 4x multiplier applied to. See the headshot-share
   *  assertion below for why this is counted rather than assumed. */
  let headHits = 0;
  let crash = null;

  /**
   * The wallhack audit.
   *
   * Every tick, for every bot, take the enemy closest to its aim line and ask what the bot
   * could honestly know about that one: SEEN (in the cone on a clear line now), REMEMBERED
   * (not now, but seen within MEMORY_MS, so a stale belief accounts for it), HEARD (fired a
   * round inside HEAR_RANGE within MEMORY_MS, so `listen()` accounts for it) or UNSEEN — none
   * of the three, so nothing in the brain should be pointing there. A "lock" is holding the
   * enemy inside LOCK_TOL.
   *
   * UNSEEN cannot be read against zero. Bots face along the lanes they walk and enemies
   * stand in those lanes, so a good part of it is the map and not knowledge — measured here,
   * about a fifth of all ticks. The control for it is the SAME aim lines scored against where
   * everybody stood a few seconds ago: same map, same lanes, same players, same bots facing
   * the same way, and causally unrelated to where anyone is now. Knowledge is the unseen rate
   * ABOVE its own control, and that difference is the only thing asserted on, because the
   * absolute number is a property of the geometry and would move if somebody shifted a crate.
   * Four lags rather than one: a single lag is a null estimated off as few samples as the
   * thing it is compared against, and the difference between them rattled by five points run
   * to run.
   *
   * For scale, the whole point of the exercise. Against a brain with the cone and the
   * visibility gate taken back out of `spot()` — which is what shipped, and what got called
   * cheating — this reads 79.9% and 77.9% unseen against 30.1% and 33.6% controls: fifty and
   * forty-four points of pure knowledge. Against what is here now it reads within a point or
   * two of its control in either direction, six runs out of six. The tolerance below is set
   * far enough above the honest spread to be quiet and an order of magnitude under the
   * cheating one.
   *
   * There was a PAIRED version of this and it is worth saying why there is not one now, since
   * it is the obvious thing to reach for. The idea: each tick, measure the aim against the
   * nearest enemy the bot cannot perceive, and against where that same enemy stood seconds
   * earlier — same bot, same tick, same aim line, same enemy, so the only difference between
   * the two numbers is which moment the position came from, and a bot with no read on a hidden
   * target is equally far from both. Pairing kills the run-to-run noise that a rate has.
   *
   * It took five corrections to stop it convicting a brain that does not cheat. It picked the
   * enemy by its LIVE offset and compared that minimum against an ordinary draw. Membership
   * used the cone, which is a test on the aim line itself, so the live positions were within
   * sixty degrees of the aim by construction and the stale ones were free. The stale snapshots
   * held the dead, and a corpse lies where it fell while a respawn stands in a corner. The two
   * minima ran over different numbers of people, because an enemy alive now was not always
   * alive then. And membership was judged on the live position only — hidden means round a
   * corner, which here means farther off, and a farther point subtends a smaller angle from
   * any aim line whatsoever, which was worth four hundredths of a radian to the live side
   * before a bot did anything at all.
   *
   * A sixth thing was not a bug in the measurement: HEARING. A bot that hears a shot inside
   * HEAR_RANGE turns toward a position wrong by up to NOISE_SLOP, and that is a real
   * correlation between aim and where a hidden enemy actually is — an honest one, and the only
   * reason a cone-limited bot ever turns round. Reading it as cheating is how you end up
   * deleting the feature that makes the bots beatable. Hence HEARD as a category of its own:
   * gunfire leaves the unseen set, and it is checked below that the channel does something.
   *
   * With all six fixed the paired means came out equal, and then the same statistic was run
   * against the cheating brain and came out equal there too — 0.808 against 0.836, and 0.750
   * against 0.752, on a brain locked onto people through walls four ticks in five. The reason
   * is the exclusion that makes it fair: in a firefight nearly everybody has fired inside
   * HEAR_RANGE recently, so the enemies left in the set are the far peripheral ones no brain
   * was ever pointing at, and a minimum over those is a fact about the building. A statistic
   * that reads the same for both brains is not evidence, so it is gone rather than reported
   * next to numbers that are — but it took a day to build and it would be built again by the
   * next person, so the dead end is written down instead of the code.
   */
  const LOCK_TOL = 0.087; // 5 degrees: "pointed at"
  const LAGS = [120, 240, 360, 480]; // 2s, 4s, 6s, 8s
  const lock = { seen: 0, remembered: 0, heard: 0, unseen: 0 };
  const opp = { seen: 0, remembered: 0, heard: 0, unseen: 0 };
  let ctlLock = 0;
  let ctlN = 0;
  /** `bot>enemy` -> sim time of the last tick that bot could really see that enemy. */
  const lastLook = new Map();
  const ring = [];
  /** Shots fired on a tick when the shooter could see nobody, either side of the step. */
  let blindShots = 0;
  let judgedShots = 0;
  /** Perception as of the END of the previous tick, which is what the brain had when it
   *  thought THIS tick: thinkBots() runs at the top of step(), before anybody moves. */
  let sawBefore = new Map();
  /** Every shot whose range is known, for the miss figures. */
  const byRange = [];
  /** One row per living player per tick: whether it holds a scoped weapon and what it is
   *  doing with the glass, for the bot-scope checks after the loop. */
  const glass = [];

  try {
    for (let i = 0; i < TICKS; i++) {
      const pre = new Map([...room.players.values()].map((q) => [q.id, { x: q.x, y: eyeY(q), z: q.z }]));
      room.step();
      const now = room.now();
      const fired = new Map();
      for (const ev of room.drainEvents()) {
        if (ev.e === EV.SHOT) { shooters.add(ev.id); fired.set(ev.id, { hit: false }); }
        else if (ev.e === EV.HIT) {
          hits++;
          if (ev.z === HIT_ZONE.HEAD) headHits++;
          const r = fired.get(ev.by);
          const a = pre.get(ev.by);
          const b = pre.get(ev.on);
          if (r && a && b) { r.hit = true; r.dist = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
        } else if (ev.e === EV.KILL) kills++;
      }

      const sawNow = new Map();
      for (const q of room.players.values()) if (q.alive) sawNow.set(q.id, perceived(q));

      // A shot is judged against the two instants that bracket the decision: what the shooter
      // could see when it thought (pre-step, since thinkBots runs first) and what it can see
      // now. Both, because 17ms of movement sits between them, and a target that steps behind
      // a crate inside that window is not the brain having fired blind.
      for (const [id, r] of fired) {
        const q = room.players.get(id);
        if (!q) continue;
        judgedShots++;
        if (!(sawBefore.get(id)?.size || sawNow.get(id)?.size)) blindShots++;
        // Range of the shot: to whoever it hit, else to the visible enemy it was most nearly
        // aimed at. Nearest in ANGLE, not in space — a bot spraying at somebody down a long
        // lane past a closer bystander is shooting at the far one, and charging that miss to
        // the near band would flatter the close-range figure.
        let d = r.dist ?? Infinity;
        if (d === Infinity) {
          let bestOff = 0.35;
          for (const vid of sawNow.get(id) ?? []) {
            const v = room.players.get(vid);
            if (!v) continue;
            const t = { x: v.x, y: eyeY(v), z: v.z };
            const off = aimOff(q, t);
            if (off < bestOff) { bestOff = off; d = Math.hypot(t.x - q.x, t.y - eyeY(q), t.z - q.z); }
          }
        }
        if (d < Infinity) byRange.push({ hit: r.hit, dist: d });
      }
      for (const p of room.players.values()) {
        const q = at.get(p.id);
        // A respawn is a teleport, not a walk, so anything further than one tick of
        // sprinting is not distance travelled and must not be counted as such.
        const d = Math.hypot(p.x - q.x, p.z - q.z);
        const step = C.MOVE_SPEED * C.SPRINT_SPEED_MUL * C.TICK_DT * 2;
        if (d <= step) travel.set(p.id, travel.get(p.id) + d);
        if (p.wep !== q.w) swaps.set(p.id, swaps.get(p.id) + 1);
        q.x = p.x; q.z = p.z; q.w = p.wep;

        if (p.alive && canSee(p)) {
          const run = looking.get(p.id) + 1;
          looking.set(p.id, run);
          if (run > look.get(p.id)) look.set(p.id, run);
        } else {
          looking.set(p.id, 0);
        }

        if (p.alive && WORLD_BOXES.some((b) => overlapsBox(p.x, p.y, p.z, ...halfOf(p), b))) {
          inside.push(`#${p.id} at ${r3(p.x)},${r3(p.y)},${r3(p.z)} on tick ${i}`);
        }
      }

      // Living players only. A corpse sits where it fell and a respawn stands in a corner,
      // and neither is where a walking player is — a null model stocked with them puts its
      // sample somewhere live positions never are, which reads as a signal that is not there.
      ring.push(new Map([...room.players.values()]
        .filter((q) => q.alive)
        .map((q) => [q.id, { x: q.x, y: eyeY(q), z: q.z }])));
      const stales = LAGS.map((n) => (ring.length > n ? ring[ring.length - 1 - n] : null)).filter(Boolean);
      for (const p of room.players.values()) {
        if (!p.alive) continue;
        for (const vid of sawNow.get(p.id) ?? []) lastLook.set(p.id + '>' + vid, now);
        let best = null;
        for (const v of room.players.values()) {
          if (v === p || !v.alive) continue;
          const at2 = lastLook.get(p.id + '>' + v.id);
          const live = sawNow.get(p.id)?.has(v.id);
          const recalled = at2 !== undefined && now - at2 <= MEMORY_MS;
          const noise = audible(p, v, now);
          // Three ways to know where somebody is, in descending order of how much they are
          // worth: a clear look now, a look inside MEMORY_MS, a shot inside HEAR_RANGE. What
          // is left over is an enemy no part of the brain has any business pointing at.
          const kind = live ? 'seen' : recalled ? 'remembered' : noise ? 'heard' : 'unseen';
          const off = aimOff(p, { x: v.x, y: eyeY(v), z: v.z });
          if (best && off >= best.off) continue;
          best = { off, kind, id: v.id };
        }
        if (best) {
          opp[best.kind]++;
          if (best.off < LOCK_TOL) lock[best.kind]++;
        }
        // The null model: this same aim line against where everybody stood a while ago.
        for (const stale of stales) {
          let c = Infinity;
          for (const [vid, t] of stale) if (vid !== p.id) c = Math.min(c, aimOff(p, t));
          if (c < Infinity) { ctlN++; if (c < LOCK_TOL) ctlLock++; }
        }
      }
      // The glass, watched from OUTSIDE the brain. `sc` is the one field a bot asserts that
      // costs it something — it caps the bot's own speed and widens its own cone until the
      // window closes — so a brain that raised it at the wrong moment would be handing the
      // player free kills, and one that never raised it at all would leave nine sniper bots
      // firing 40x hip shots and reading as "the bots cannot aim". Both are silent: `sc` goes
      // through `sanitizeInput` like any other field and a wrong value is legal.
      for (const p of room.players.values()) {
        if (!p.alive) continue;
        let d = Infinity;
        for (const vid of sawNow.get(p.id) ?? []) {
          const v = room.players.get(vid);
          if (v) d = Math.min(d, Math.hypot(v.x - p.x, v.z - p.z));
        }
        glass.push({ has: scopes(idAt(p.wep)), scope: p.scope ?? 0, ms: p.scopeMs ?? 0,
                     seen: d < Infinity, dist: d, speed: Math.hypot(p.vx, p.vz) });
      }
      sawBefore = sawNow;
    }
  } catch (e) {
    crash = e;
  }

  okF(!crash, `${SECONDS}s of AI ticks without throwing`,
      crash ? crash.stack.split('\n').slice(0, 2).join(' | ') : `${TICKS} ticks × ${N} bots`);
  okF([...travel.values()].every((d) => d > 12),
      'every bot walked a real distance instead of standing on its spawn',
      [...travel.values()].map((d) => r3(d)).join(', '));

  // This used to be `shooters.size === N` inside a fixed window, and that was a test of
  // encounter luck rather than of the trigger. Measured on this arena: five bots in 64
  // units square with 92 solids in it have somebody in view for two to ten seconds of
  // any forty-five, and first shots land anywhere from 0.4s to 39s. A bot that never
  // fires because nobody ever walked in front of it is a big map, not a bug — and no
  // window is long enough to make that assertion honest, it just makes verify slow and
  // flaky at the same time.
  //
  // So the assertion is the causal one instead: a bot that had a clear, unbroken look at
  // an enemy and did not shoot is broken, whatever the encounter rate. That does still
  // catch what this check is for — the semi-auto regression, where a bot held the
  // trigger down with a pistol and therefore fired exactly one round per life. `hits`
  // and `kills` below keep it from passing vacuously.
  const mute = bots.filter((p) => look.get(p.id) / C.TICK_HZ >= LOOK_GATE && !shooters.has(p.id));
  okF(mute.length === 0, `every bot that got a clear ${LOOK_GATE}s look at somebody fired`,
      mute.length
        ? `${mute.map((p) => p.name).join(', ')} held fire`
        : bots.map((p) => `${(look.get(p.id) / C.TICK_HZ).toFixed(1)}s${shooters.has(p.id) ? '→shot' : ''}`).join(', '));
  okF(hits > 0, 'and the shooting connected', `${hits} hits landed`);

  // The bot half of the 4x headshot. "for BOT it is no problem since it is a bot but for
  // real players these details kinda mess up with your touch" — true of falloff and of the
  // movement cone, and the exact opposite of true here. A bot aimed at the EYE line, which
  // is inside the new head box, and its settled aim error is smaller than a head subtends
  // at duelling range: every rifle, pistol, semi and lmg round it landed would have been a
  // one-tap. ai.js aims at chestY for that reason, and this is the check that says so
  // — measured off the same run rather than argued from the constant, because the aim
  // point is one line in one file and nothing else would notice it moving back.
  //
  // The gate is 40% rather than something tighter on purpose. The cone is genuinely random
  // and a run lands only a few dozen hits, so the observed share swings between about 3 and
  // 12 percent from run to run — a 20% gate would fail a few times in a hundred for no
  // reason at all. What it has to separate is those figures from the ~79% the arithmetic
  // below says an eye-aimed bot would score, and 40% sits in the gap with room either side.
  const headShare = hits ? headHits / hits : 0;
  okF(hits > 0 && headShare < 0.4,
      'and it is mostly landing on bodies, not skulls — a bot is not an aimbot',
      `${headHits} of ${hits} hits were headshots (${(headShare * 100).toFixed(1)}%)`);
  // The same claim argued from ai.js's own numbers, because the count above is not enough
  // on its own: the cone is genuinely random, so one run's headshot tally is a coin flip and
  // a suite that cries wolf is a suite nobody reads. The dials are private to ai.js, so they
  // are lifted out as text the way Part G lifts viewmodel.js.
  //
  // Read as the vertical REACH of a settled bot's wobble, which bounds the cone rather than
  // modelling it: an interval that never touches the head box is a cone that never does.
  const settled = aiNum('AIM_ERR_SETTLED');
  const holdMid = (aiNum('HOLD_NEAR') + aiNum('HOLD_FAR')) / 2;
  okF(Number.isFinite(settled) && Number.isFinite(holdMid) && settled > 0 && holdMid > 0,
      'ai.js still names its settled aim error and the band it chooses to fight in',
      `AIM_ERR_SETTLED ${settled} rad over a hold band centred at ${holdMid}u`);
  const skull = headBoxOf(PINNED);
  const wobble = Math.tan(settled) * holdMid;
  const inSkull = (aimAt) => {
    const lo = aimAt - wobble;
    const hi = aimAt + wobble;
    const overlap = Math.min(hi, skull.cy + skull.hy) - Math.max(lo, skull.cy - skull.hy);
    return Math.max(0, overlap) / (hi - lo);
  };
  okF(inSkull(chestY(PINNED)) === 0,
      'and a settled bot aimed at the chest cannot wobble onto a head at that range',
      `${(wobble * 2).toFixed(3)}u of reach starting ${(skull.cy - skull.hy - chestY(PINNED)).toFixed(3)}u below the jaw`);
  // The other half of the same arithmetic, and the reason ai.js moved: the eye line it used
  // to aim at is INSIDE the head box, so most of that same wobble was a 4x one-tap.
  okF(inSkull(eyeY(PINNED)) > 0.5,
      'whereas the eye line it used to aim at would have made most of that wobble a one-tap',
      `${(inSkull(eyeY(PINNED)) * 100).toFixed(0)}% of the reach lands in the skull from the eye,`
      + ` ${(inSkull(chestY(PINNED)) * 100).toFixed(0)}% from the chest`);
  okF(/const cy = chestY\(v\)/.test(aiSrc) && /belief\.y = aimY\(/.test(aiSrc),
      'and the aim point in ai.js is still the chest, with the eye kept only as the fallback',
      'a one-line edit back to eyeY undoes every figure above, and nothing else in this file would notice');

  okF(kills > 0, 'bots kill each other, so a room with only AI in it still plays a match',
      `${kills} kills in ${SECONDS}s`);

  // ── "it even know you are coming". Three readings off the same audit.
  const pcF = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');
  const rate = (k) => (opp[k] ? lock[k] / opp[k] : 0);
  const ctlRate = ctlN ? ctlLock / ctlN : 0;
  const audit = `seen ${pcF(lock.seen, opp.seen)} · remembered ${pcF(lock.remembered, opp.remembered)}`
    + ` · heard ${pcF(lock.heard, opp.heard)}`
    + ` · unseen ${pcF(lock.unseen, opp.unseen)} vs a ${pcF(ctlLock, ctlN)} control`;

  // Non-vacuity first: everything below is about aim NOT landing on people, and it would
  // all pass on a bot that stared at the floor.
  okF(rate('seen') > 0.6, 'a bot points at the enemy it can actually see', audit);

  // The wallhack itself, and the one number here worth arguing about. Not "the unseen lock
  // rate is small" — see above for why that is the arena talking — but "the aim is no closer
  // to an enemy it cannot perceive than to where that same enemy stood seconds ago". No
  // closer means the aim carries no information about anybody the bot has not seen or heard,
  // and no information is the whole of the fix.
  const edge = rate('unseen') - ctlRate;
  okF(opp.unseen > 500 && edge <= 0.06,
      'and its aim says nothing at all about an enemy it can neither see nor hear',
      `${audit} — knowledge would show up as unseen ABOVE control, and it is`
        + ` ${(100 * Math.abs(edge)).toFixed(1)} points ${edge > 0 ? 'above' : 'below'}`
        + ' (the same brain with the gates out of spot(): 50 points above)');

  // That hearing is a channel and not decoration. It is the one thing that lets a bot with a
  // 120-degree cone turn round, and without this check somebody deletes listen() to make the
  // line above prettier and the bots go deaf — which reads as broken long before it reads as
  // fair. A heard position is wrong by up to NOISE_SLOP, so this is well short of a lock and
  // has to be: it is somewhere to look, not something to shoot at.
  //
  // WITH A MARGIN, AND OVER 90s RATHER THAN 45, because this was a bare inequality between two
  // rates and it failed an honest run about one time in twelve — heard 15.4% against unseen
  // 17.0%, which reads as the bots having gone deaf and is nothing of the kind. HEARD is the
  // smallest of the four buckets by a wide margin (gunfire has to land inside HEAR_RANGE from
  // somebody the bot cannot also see) so it is the noisiest number in the audit, and at 45s of
  // dm the gap ran anywhere from +45 points down to −1.6 across fifteen runs.
  //
  // Doubling the window is what fixed it and the reason it works is `dealLoadout`: dm re-rolls
  // a hand on every respawn, so more seconds are more INDEPENDENT encounters rather than more
  // of the same one. Measured over sixteen 90s runs the gap came in at +12.7 to +31.8 points,
  // median +21.6, on samples of 3400-5700 heard ticks — so the five points asserted here sit
  // seven and a half points under the worst observed run, and the check is strictly stronger
  // than the inequality it replaces. It costs 1.8s of the suite's 13.
  const gap = rate('heard') - rate('unseen');
  okF(opp.heard > 2000 && gap > 0.05,
      'it turns toward gunfire it heard through a wall, which is the honest version of that',
      `${pcF(lock.heard, opp.heard)} of ${opp.heard} ticks facing an enemy it only heard, `
        + `against ${pcF(lock.unseen, opp.unseen)} of ${opp.unseen} for one it had no line on at `
        + `all — a gap of ${(gap * 100).toFixed(1)} points against the 5 asked for; a deaf brain `
        + 'would put these two buckets on top of each other, which is exactly what deleting '
        + 'listen() from ai.js does');

  // The trigger. Aim can drift onto a hidden target harmlessly; a round leaving the barrel
  // at one is the wallhack with the aim taken out and the trigger left in, which is exactly
  // what shooting at `belief` rather than at `fresh` would be.
  okF(blindShots === 0, 'and it never fires a shot with nobody in sight',
      `${judgedShots} shots judged, ${blindShots} with an empty cone on both sides of the step`);

  // ── "it barely miss". The number a bot has to beat is not a feeling: PLAYER_HALF_W is 0.4,
  // so a body is atan2(0.4, dist) wide, and an aim error under that cannot produce a miss.
  // These read the dials out of ai.js rather than restating them, so retuning either one
  // re-decides the check instead of quietly invalidating it.
  const AIM_ERR_NEW = aiNum('AIM_ERR_NEW');
  const AIM_ERR_SETTLED = aiNum('AIM_ERR_SETTLED');
  const AIM_ERR_TRACK = aiNum('AIM_ERR_TRACK');
  const HOLD_FAR = aiNum('HOLD_FAR');
  const body = (d) => Math.atan2(C.PLAYER_HALF_W, d);
  okF(AIM_ERR_NEW > body(HOLD_FAR),
      'a bot that has just found you aims wider than you are, so its first burst can miss',
      `${r3(AIM_ERR_NEW)} rad of drift against a body ${r3(body(HOLD_FAR))} rad wide at HOLD_FAR ${HOLD_FAR}u`);
  okF(AIM_ERR_SETTLED < body(HOLD_FAR),
      'and one that has held you in view for SETTLE_MS aims inside you, so watching you pays',
      `settles to ${r3(AIM_ERR_SETTLED)} rad, still inside ${r3(body(HOLD_FAR))}`);
  okF(body(3) > AIM_ERR_NEW + AIM_ERR_TRACK,
      'while at three units nothing in the dials adds up to a body, so close range stays lethal',
      `${r3(body(3))} rad of target against ${r3(AIM_ERR_NEW + AIM_ERR_TRACK)} rad of worst-case error`);

  // And the same thing measured rather than derived. Long shots have to mostly miss, and a
  // round that connects has to have been fired from closer than one that did not.
  //
  // The second of those is a mean over every shot rather than a rate inside a bucket, and it
  // is deliberately not `hitRate(near) > hitRate(far)`: bots choose to fight at HOLD_NEAR to
  // HOLD_FAR but most rounds still go down long lanes, so a 45s window puts only a dozen or
  // two shots inside the band and a rate off twelve shots is not a measurement. The mean
  // range uses all of them.
  const far = byRange.filter((x) => x.dist >= HOLD_FAR);
  const near = byRange.filter((x) => x.dist < HOLD_FAR);
  const hitRate = (a) => (a.length ? a.filter((x) => x.hit).length / a.length : 0);
  const mean = (a) => (a.length ? a.reduce((t, x) => t + x.dist, 0) / a.length : 0);
  const landed = byRange.filter((x) => x.hit);
  const wide = byRange.filter((x) => !x.hit);
  const spread = `${near.length} shots inside ${HOLD_FAR}u at ${pcF(near.filter((x) => x.hit).length, near.length)}`
    + `, ${far.length} beyond it at ${pcF(far.filter((x) => x.hit).length, far.length)}`;
  okF(far.length >= 20 && hitRate(far) < 0.6,
      'shots past the band a bot holds mostly miss, which they could not before', spread);
  okF(landed.length >= 10 && wide.length >= 10 && mean(landed) < mean(wide),
      'and a round that connected was fired from closer than one that went wide',
      `${landed.length} hits at a mean ${r3(mean(landed))}u, ${wide.length} misses at ${r3(mean(wide))}u — ${spread}`);
  okF(!inside.length, 'no bot ever ended a tick inside the map',
      inside[0] ?? `${TICKS * N} position samples clear`);

  // The subtle one. `applyWeapon` pushes `switchUntil` forward on every granted change
  // and `tryFire` refuses to fire until it passes — so a bot that re-picked its weapon
  // every tick would hold a gun it never gets to shoot. Hence the bonus for whatever is
  // already in hand, and hence this check: a ditherer would swap on most of 1200 ticks.
  okF([...swaps.values()].every((n) => n <= SECONDS * 2),
      'no bot dithers between weapons, which would leave it permanently mid-draw',
      `${[...swaps.values()].join(', ')} swaps over ${SECONDS}s`);

  // A brain's output is fed through `queueInput` exactly as a browser's is, so it is
  // subject to `sanitizeInput` — which means an intent outside what a client may assert
  // is not a cheat, it is a bot silently having its input clamped and misbehaving.

  // ---- what a bot holding something else does with the glass
  //
  // The NEGATIVE half of the bot-scope coverage, and this is the room for it: a dm loadout
  // deals from every slot, so these ticks are five bots carrying shotguns, lmgs and knives.
  // A brain that returned `sc: 1` unconditionally would be caught here and nowhere else.
  // The positive half needs a room where a sniper is guaranteed to be in somebody's hands,
  // which dm cannot promise — one primary of six — so it has a room of its own below.
  okF(glass.filter((g) => !g.has).every((g) => g.scope === 0),
      'a bot holding an unscoped weapon is never scoped, whatever its brain asks for',
      `${glass.filter((g) => !g.has && g.scope > 0).length} of `
      + `${glass.filter((g) => !g.has).length} unscoped-weapon ticks carried a scope, `
      + `against ${glass.filter((g) => g.has).length} that this room happened to deal a scope to`);

  const p0 = bots[0];
  const intent = p0.bot.think(room, p0, room.now());
  okF(p0.loadout.includes(intent.wep), 'a bot only ever asks for a weapon it was dealt',
      `wants ${WEAPON_IDS[intent.wep]}, holds [${p0.loadout.map((i) => WEAPON_IDS[i])}]`);
  okF(Math.abs(intent.moveX) <= 1 && Math.abs(intent.moveZ) <= 1
      && Math.abs(intent.pitch) <= C.PITCH_LIMIT + 1e-9,
      'and its intent is inside what the input sanitiser would allow',
      `move ${r3(intent.moveX)},${r3(intent.moveZ)} pitch ${r3(intent.pitch)}`);
}


// ---- a room of nothing but snipers, which is where the glass can be measured
//
// "i notice how crazy hard to play with sniper" was three separate things, and one of them was
// the bots: nine of them holding a 100-damage one-shot and closing to knife range, where a
// human's scope is a pure liability and their settled aim error sits well inside the angle a
// body subtends. The fix was to declare on the weapon the range it wants to be fought at —
// `hold: [18, 40]` — and to penalise picking it inside that, so a rushed bot draws its knife.
//
// This has to be its own room because dm cannot promise a sniper: it deals one primary of six
// per bot, so a run where nobody was dealt one is a 40% coin flip and the checks below would
// pass vacuously two runs in five. The `sniper` mode's loadout IS the sniper, which is also
// the mode a player picks when this is the gun they came for.
{
  const SECONDS = 25;
  const TICKS = C.TICK_HZ * SECONDS;
  const N = 5;
  const pcF = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');
  const room = new Room('sniper');
  room.setBots(N);
  room.drainEvents();

  const bots = [...room.players.values()];
  okF(bots.every((p) => scopes(idAt(p.wep)) || idAt(p.wep) === 'knife'),
      'the sniper mode deals nothing but the sniper and the knife, so the glass is on the table',
      bots.map((p) => idAt(p.wep)).join(', '));

  const band = holdBandOf('sniper');
  const glass = [];
  /** Angle between where a bot is looking and a point, for picking out its actual target. */
  const aimOffF = (p, t) => {
    const cp = Math.cos(p.pitch);
    const fx = -Math.sin(p.yaw) * cp;
    const fy = Math.sin(p.pitch);
    const fz = -Math.cos(p.yaw) * cp;
    const dx = t.x - p.x;
    const dy = t.y - eyeY(p);
    const dz = t.z - p.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    return Math.acos(Math.max(-1, Math.min(1, (fx * dx + fy * dy + fz * dz) / len)));
  };
  let crash = null;
  try {
    for (let i = 0; i < TICKS; i++) {
      room.step();
      for (const p of room.players.values()) {
        if (!p.alive || !scopes(idAt(p.wep))) continue;
        // The range to whoever the bot is AIMED at, not to whoever is nearest — and the
        // difference is the whole measurement. ai.js decides `sc` on the distance to the
        // enemy it picked, so a third bot creeping up behind is not the brain choosing to
        // scope a knife fight; scored against nearest-in-space this reads anywhere from 1%
        // to 20% run to run and means nothing either way. Nearest in ANGLE is the target.
        let d = Infinity;
        let best = Infinity;
        for (const v of room.players.values()) {
          if (v === p || !v.alive) continue;
          const off = aimOffF(p, { x: v.x, y: eyeY(v), z: v.z });
          if (off < best) { best = off; d = Math.hypot(v.x - p.x, v.z - p.z); }
        }
        // `wl` is the brain's own asking, off the input the room queued for it: the settle
        // keys on the INTENT, so speed alone can no longer tell a bot that PLANTED itself
        // from one the glass merely slowed, and the two want opposite assertions.
        const q = p.lastInput;
        glass.push({ scope: p.scope ?? 0, ms: p.scopeMs ?? 0, dist: d,
                     wl: q ? Math.hypot(q.moveX ?? 0, q.moveZ ?? 0) : 0,
                     speed: Math.hypot(p.vx, p.vz), grounded: p.grounded });
      }
    }
  } catch (e) { crash = e; }
  okF(!crash, `${SECONDS}s of sniper-mode AI ticks without throwing`,
      crash ? String(crash.stack ?? crash).split('\n').slice(0, 3).join(' | ') : `${glass.length} samples`);

  const up = glass.filter((g) => g.scope > 0);
  okF(glass.length > 1000 && up.length > 50,
      'a bot holding a scoped weapon actually raises the glass rather than hip-firing a sniper',
      `${up.length} scoped of ${glass.length} sniper-holding ticks (${pcF(up.length, glass.length)})`);
  // The rule ITSELF, lifted out of server/ai.js and evaluated, rather than inferred from how
  // often a scoped bot happened to be standing close.
  //
  // That rate was tried first and it is not a measurement. Bots stand off at the band because
  // `moveZ` sends them there, so a brain that raised the scope UNCONDITIONALLY still shows
  // only a few percent of close-range scoped ticks — 0.4%, 3.6% and 10.4% over three runs —
  // while the honest brain shows 1.5%, 5.5% and 0.3%. The distributions overlap completely.
  // A statistic that fails an honest run one time in three is worse than no check at all, so
  // what is asserted here is the shipped expression, at distances chosen to sit either side
  // of the band it reads off the weapon.
  const aiTxt = readFileSync(new URL('./server/ai.js', import.meta.url), 'utf8');
  const scRe = /(sc = scopes\(idAt\(wep\)\)[^\n]*?;)/;
  const scHits = aiTxt.match(new RegExp(scRe.source, 'g')) ?? [];
  if (scHits.length !== 1) throw new Error(`the bot scope rule: ${scHits.length} matches in ai.js, wanted 1`);
  const scOf = new Function('scopes', 'idAt', 'wep', 'dist', 'band', 'reach',
      `let sc = 0; ${scRe.exec(aiTxt)[1]} return sc;`);
  const bandOf = (i) => holdBandOf(idAt(i)) ?? [6, 14];
  const SNR = weaponAt(indexOf('sniper')).range;
  const askAt = (id, dist, reach = weaponAt(indexOf(id)).range) =>
    scOf(scopes, idAt, indexOf(id), dist, bandOf, reach);
  const inside = askAt('sniper', band[0] - 4);
  const atBand = askAt('sniper', (band[0] + band[1]) / 2);
  const past = askAt('sniper', SNR + 10);
  okF(inside === 0 && atBand === 1 && past === 0,
      'the brain raises the glass only inside the band the weapon declares, and inside its reach',
      `${band[0] - 4}u reads ${inside}, ${(band[0] + band[1]) / 2}u reads ${atBand}, `
      + `${SNR + 10}u (past the ${SNR}u reach) reads ${past}`);
  okF([0, band[0] - 1, band[0], band[1], SNR].every((d) => askAt('rifle', d) === 0),
      'and never on a weapon that has no glass to raise, at any range at all',
      'a rifle reads 0 from point blank to the edge of its reach');
  // The boundary, exactly where the weapon puts it, so moving `hold` moves this with it.
  okF(askAt('sniper', band[0] - 1e-6) === 0 && askAt('sniper', band[0]) === 1,
      'and the near edge of the band is the edge, not a suggestion',
      `${band[0]}u reads 1, a hair under it reads 0`);
  // A RAISED SCOPE PLANTS THE BOT, which is the AI half of the sniper fix and the thing this
  // suite caught when the rule changed: `scopeStep` settles the cone on the movement intent,
  // so ai.js's old `FIRE_SETTLE` damping — 0.3 of a step, still a step — meant no bot sniper
  // would ever have fired through anything tighter than a metre again. Measured on the intent
  // and not on the speed, because a body bleeding off friction is still a planted body.
  const held = up.filter((g) => g.ms >= SCOPE_SETTLE_MS);
  const planted = held.filter((g) => g.wl === 0).length;
  okF(held.length > 100 && planted > held.length * 0.95,
      'a bot that has earned the cone earned it by standing still, not by being slowed',
      `${planted} of ${held.length} fully settled scoped ticks asked to move nowhere `
      + `(${pcF(planted, held.length)})`);

  // The cap, on a bot, through the same `speedMul` a player goes through — which is the whole
  // reason `sc` rides on the input instead of being a camera trick in the browser.
  //
  // Read at the 95th percentile and not as a maximum, and that is not a fudge. `stepPlayer`
  // accelerates up to `top` PROJECTED ON THE WISH DIRECTION — Quake's rule, which CS2 also
  // inherits — so a body that turns carries the speed it already had across into the new
  // direction and its total can sit above `top` for as long as friction takes to bleed it.
  // That is the movement model, identical scoped or not, and a maximum over 25s of five bots
  // turning corners measures it rather than the cap. The percentile lands on the steady state,
  // which is what the cap actually governs, and the RATIO of the two percentiles is
  // SCOPE_SPEED_MUL to within a few percent — which is the number CS2 states, off a bot.
  const pct = (a, q) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length * q)] : 0);
  const walking = glass.filter((g) => g.grounded && g.scope === 0).map((g) => g.speed);
  // Filtered on `wl` and no longer on a settled `ms`: the ticks that used to be both scoped
  // and at speed are now exactly the ticks a bot plants for, so the old filter sampled the
  // plant and read the cap as 0.14 of the walk. A scoped bot still MOVES — across the band,
  // or toward a position it only heard — and those ticks are where the cap lives.
  const glassed = glass.filter((g) => g.grounded && g.scope > 0 && g.wl > 0).map((g) => g.speed);
  const p95 = pct(glassed, 0.95);
  const p95u = pct(walking, 0.95);
  okF(glassed.length > 500 && walking.length > 500 && p95 <= C.MOVE_SPEED * C.SCOPE_SPEED_MUL
      && Math.abs(p95 / p95u - C.SCOPE_SPEED_MUL) < 0.05,
      'a scoped bot is slowed by its own glass in the same proportion a scoped player is',
      `${p95.toFixed(3)}u/s at the 95th percentile of ${glassed.length} settled scoped ticks, `
      + `against ${p95u.toFixed(3)} over ${walking.length} unscoped — ratio `
      + `${(p95 / p95u).toFixed(3)} against the ${C.SCOPE_SPEED_MUL} asked for, under the `
      + `${(C.MOVE_SPEED * C.SCOPE_SPEED_MUL).toFixed(3)} cap`);
  // And it holds it. A brain that toggled `sc` every tick would sit permanently at the top of
  // the settle window, which is worse than never scoping: the speed cap with none of the cone.
  //
  // POOLED OVER THREE ROOMS, and that is a correction rather than a convenience. One room is
  // one draw of five brains and five spawns, and the rate it produces ranges from 11.5% to
  // 59.2% across 160 measured rooms — three of those 160 came in at or under the 15% asserted
  // here, so this check failed an honest run about one time in fifty and the failure said
  // nothing. Pooling the ticks of three independent rooms is the same argument the badge shelf
  // makes about forty lobbies: the floor becomes a claim about the BRAIN instead of about a
  // draw. Pooled, the worst of 53 trials was 17.3% and the median 27.5%.
  //
  // The rate itself stays a rate, and deliberately. Per-BURST was the sharper statement and it
  // was measured first: of 954 scope-holds that ran long enough to settle four times over, 244
  // never closed the cone once, in 59 rooms out of 60. That is not a defect — a scoped bot
  // still WALKS, across the band or toward a position it only heard, and `scopeMs` bleeds back
  // down while it does. So the honest floor is over ticks, not over holds.
  const pooled = [[up.length, held.length]];
  for (let extra = 0; extra < 2; extra++) {
    const r2 = new Room('sniper');
    r2.setBots(N);
    r2.drainEvents();
    let seen = 0;
    let full = 0;
    for (let i = 0; i < TICKS; i++) {
      r2.step();
      for (const p of r2.players.values()) {
        if (!p.alive || !scopes(idAt(p.wep)) || (p.scope ?? 0) === 0) continue;
        seen++;
        if ((p.scopeMs ?? 0) >= SCOPE_SETTLE_MS) full++;
      }
    }
    pooled.push([seen, full]);
  }
  const seenAll = pooled.reduce((a, [n]) => a + n, 0);
  const settled = pooled.reduce((a, [, n]) => a + n, 0);
  okF(seenAll > 1000 && settled > seenAll * 0.15,
      'and holds the glass long enough for the cone to actually close behind it',
      `${settled} of ${seenAll} scoped ticks past a full ${SCOPE_SETTLE_MS}ms of settle `
      + `(${pcF(settled, seenAll)}) across ${pooled.length} rooms — `
      + `${pooled.map(([n, f]) => pcF(f, n)).join(', ')} — longest single settle `
      + `${Math.round(up.reduce((m, g) => Math.max(m, g.ms), 0))}ms, which saturates at `
      + `${SCOPE_SETTLE_MS} because scopeMs is a meter that bleeds back down, not a stopwatch`);
  // Both zoom steps are the client's to cycle; a bot asks for the near one and stays there,
  // which is worth asserting because a brain that asked for step 2 would be paying a 1.35x
  // cone for a zoom no server-side code reads.
  okF(up.every((g) => g.scope === 1),
      'a bot uses the near zoom only, and does not pay the far one for a zoom it cannot see',
      `steps used: {${[...new Set(up.map((g) => g.scope))].join(',')}}`);
}

console.log([...pF, ...fF].join('\n'));

// ──────────────── Part G: how a weapon is held, from outside and from behind it
//
// "the bots look weird they dont look like carying the gone but just them hands floating",
// "even when death they float" and "the inspect when you press F inspect goes to your face"
// are one class of bug: a pose whose arithmetic is a few centimetres out. A screenshot does
// not settle those and one subtraction does.
//
// client/src/rig.js is deliberately three.js-free so it can be imported straight into this
// file. client/src/viewmodel.js cannot be — it builds meshes at module scope — so the
// numbers that matter are lifted out of its SOURCE and evaluated here, branch bodies and
// all. That is uglier than an import and it is the point: a reimplementation of the pose
// maths in this file would only ever prove that the copy here agrees with itself.
console.log('\n=== Part G — rig geometry, first and third person ===\n');

const pG = [];
const fG = [];
const okG = (cond, label, detail = '') => {
  (cond ? pG : fG).push(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// ─────────────────────────────── third person: the hands are ON the weapon
{
  /** Solve one hand and measure how far it actually ended up from where it was sent. */
  const reachTo = (side, t, hint) => {
    const s = solveHand(side, t, hint);
    const h = armFK(ARM_UPPER, ARM_FORE, s.x, s.y, s.z, s.elbow);
    // solveHand takes shoulder space; armFK answers relative to the joint itself.
    const rx = t[0] - side * RIG.shoulderX;
    return { over: s.over, err: Math.hypot(h.x - rx, h.y - t[1], h.z - t[2]) };
  };

  const targets = [];
  for (const id of WEAPON_IDS) {
    const h = holdOf(id);
    targets.push([`${id} trigger`, 1, h.grip, ELBOW_HINT.trigger]);
    targets.push([
      `${id} off`, -1,
      h.support ?? h.idle ?? IDLE_HAND,
      h.support ? ELBOW_HINT.support : ELBOW_HINT.idle,
    ]);
  }
  targets.push(['ready hand', -1, READY_HAND, ELBOW_HINT.idle]);
  targets.push(['dead trigger', 1, DEAD_HAND.trigger, ELBOW_HINT.dead]);
  targets.push(['dead off', -1, DEAD_HAND.support, ELBOW_HINT.dead]);

  // The off hand does not stay on the forend: it strokes the action back and it leaves the
  // weapon entirely to punch a stoppage clear. render.js adds those offsets to the support
  // target, each scaled by its own curve in 0..1 — the stroke by `pull`, and the jam by
  // `wind` and `strike`, which are never both full. So the reachable set is the convex hull
  // of one stroke offset combined with one jam offset, and "inside arm's reach" is a ball.
  // Checking the six vertices of that product therefore PROVES the interior, and there is no
  // sampling rate to get wrong. Only the product: two strokes at once, or `away` and `into`
  // together, are not poses the game can produce, and demanding reach for them would be
  // demanding it for a hand 6cm further out than any frame ever puts one.
  const STROKES = [[0, 0, 0], CYCLE_HAND.back];
  const GESTURES = [[0, 0, 0], JAM_HAND.away, JAM_HAND.into];
  for (const id of WEAPON_IDS) {
    const h = holdOf(id);
    if (!h.support) continue;
    for (const a of STROKES) {
      for (const b of GESTURES) {
        targets.push([
          `${id} off + gesture`, -1,
          [h.support[0] + a[0] + b[0], h.support[1] + a[1] + b[1], h.support[2] + a[2] + b[2]],
          ELBOW_HINT.support,
        ]);
      }
    }
  }

  let worstOver = 0;
  let overAt = '';
  let worstErr = 0;
  let errAt = '';
  for (const [what, side, t, hint] of targets) {
    const r = reachTo(side, t, hint);
    if (r.over > worstOver) { worstOver = r.over; overAt = what; }
    if (r.err > worstErr) { worstErr = r.err; errAt = what; }
  }
  okG(worstOver === 0, 'every hand target is inside the arm that reaches for it',
      `${targets.length} targets over ${WEAPON_IDS.length} weapons; worst overreach `
      + `${(worstOver * 1000).toFixed(2)}mm${overAt ? ` at ${overAt}` : ''} `
      + `(reach ${(ARM_REACH * 100).toFixed(1)}cm)`);
  okG(worstErr < 1e-4, 'and the solved arm actually puts the hand there',
      `worst FK round-trip ${(worstErr * 1e6).toFixed(1)}um at ${errAt}`);

  // The drawn figure against the box that takes the hits. A shoulder wider than the
  // collider is a limb you can see but cannot shoot.
  const ext = rigExtent();
  okG(ext.halfW <= HITBOX_HALF_W + 1e-9,
      'the drawn figure fits inside the collider it is hit through',
      `halfW ${(ext.halfW * 100).toFixed(1)}cm vs hitbox ${(HITBOX_HALF_W * 100).toFixed(1)}cm`);

  // A corpse resting flush. The topple is `rotation.set(PI/2, 0, roll)` in XYZ order, so
  // the roll happens first and leaves z alone, then the quarter turn about x maps local +z
  // to -y: the body lands on whatever stuck out BEHIND it and the roll cannot lift or sink
  // it. `backZ` is the heels. This is the check the shipped bug would have failed — the drop
  // was a capsule's radius, 0.4, against a box figure whose heels reach 0.18.
  let worstGap = 0;
  for (let i = 0; i <= 40; i++) {
    const cr = i / 40;
    worstGap = Math.max(worstGap, Math.abs(halfHAt(cr) - corpseDrop(cr) - ext.backZ));
  }
  okG(worstGap < 1e-12, 'a corpse rests exactly on the floor, from any crouch it toppled from',
      `worst gap ${(worstGap * 1000).toExponential(1)}mm; the capsule radius this replaced `
      + `left ${((HITBOX_HALF_W - ext.backZ) * 100).toFixed(0)}cm of daylight`);

  // Nothing a corpse is still carrying may end up under the floor, and after the quarter turn
  // "under the floor" means "further back than the heels". The hands only have to clear that
  // plane; the weapon has to come to REST on it, which is why the depth it settles at is
  // measured per weapon from the boxes it is drawn from rather than hand-tuned once. A single
  // number cannot do it: what hangs lowest is the weapon's own width, 2.6cm on a knife and
  // 5.5cm on an lmg.
  let deepest = -Infinity;
  let deepAt = '';
  const claim = (z, what) => { if (z > deepest) { deepest = z; deepAt = what; } };
  claim(DEAD_HAND.trigger[2], 'trigger hand');
  claim(DEAD_HAND.support[2], 'off hand');
  let worstRest = 0;
  let restAt = 'every weapon';
  for (const id of WEAPON_IDS) {
    const hold = holdOf(id);
    const z = deadGunZ(hold);
    let low = -Infinity;
    for (const p of hold.parts) {
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          for (const sz of [-1, 1]) {
            const local = rotateXYZ(
              p[7] ?? 0, p[8] ?? 0, p[9] ?? 0,
              sx * p[0] * 0.5, sy * p[1] * 0.5, sz * p[2] * 0.5,
            );
            const r = rotateXYZ(
              DEAD_GUN.rot[0], DEAD_GUN.rot[1], DEAD_GUN.rot[2],
              p[3] + local.x, p[4] + local.y, p[5] + local.z,
            );
            low = Math.max(low, z + r.z);
          }
        }
      }
    }
    claim(low, `${id} dropped`);
    if (Math.abs(low - ext.backZ) > worstRest) {
      worstRest = Math.abs(low - ext.backZ);
      restAt = id;
    }
  }
  okG(deepest <= ext.backZ + 1e-9,
      'and nothing it dropped or let go of ends up below that floor',
      `deepest ${(deepest * 100).toFixed(1)}cm (${deepAt}) against heels at `
      + `${(ext.backZ * 100).toFixed(1)}cm`);
  okG(worstRest < 1e-9,
      'the weapon it dropped lies ON that floor rather than hovering or half inside it',
      `worst ${(worstRest * 1000).toExponential(1)}mm off contact (${restAt}); before it was `
      + `rolled onto its side a dropped lmg buried 17cm of receiver`);

  // Weight. Every third-person weight cue is one function of `heftOf` and nothing else, so
  // a weapon that takes longer to bring up is automatically the one that sags further and
  // swings later — there is no second table that can fall out of step with the first.
  const byHeft = [...WEAPON_IDS].sort((a, b) => heftOf(a) - heftOf(b));
  const mono = Object.entries(HEFT).filter(([, f]) => byHeft.some((id, i) =>
    i > 0 && f(id) < f(byHeft[i - 1]) - 1e-12));
  okG(mono.length === 0, 'every weight cue rises with the weapon\'s own heft',
      `${byHeft[0]} ${heftOf(byHeft[0]).toFixed(2)} → ${byHeft.at(-1)} `
      + `${heftOf(byHeft.at(-1)).toFixed(2)}; sag `
      + `${HEFT.sag(byHeft[0]).toFixed(3)}→${HEFT.sag(byHeft.at(-1)).toFixed(3)}rad, kick `
      + `${HEFT.kick(byHeft[0]).toFixed(2)}→${HEFT.kick(byHeft.at(-1)).toFixed(2)}`);
  okG(WEAPON_IDS.every((id) => heftOf(id) >= 0 && heftOf(id) <= 1),
      'and heft is normalised, so no cue can be scaled past what it was tuned for',
      WEAPON_IDS.map((id) => heftOf(id).toFixed(2)).join(' '));

  // The action a weapon has to work between shots has to FIT between shots, or the
  // animation is still running when the next round goes off.
  const cyc = WEAPON_IDS.filter((id) => cycleMsOf(id) > 0);
  okG(cyc.length > 0 && cyc.every((id) => cycleMsOf(id) <= WEAPONS[id].intervalMs * 0.8),
      'a worked action finishes well inside the weapon\'s own fire interval',
      cyc.map((id) => `${id} ${cycleMsOf(id)}/${WEAPONS[id].intervalMs}ms `
        + `(${((cycleMsOf(id) / WEAPONS[id].intervalMs) * 100).toFixed(0)}%)`).join(', '));
  okG(cyc.every((id) => WEAPONS[id].kind === 'hitscan' && !thrown(id)),
      'and only firearms with a manually worked action declare one',
      `[${cyc.join(', ')}]`);
}

// ───────────────────── first person: lifted out of viewmodel.js and replayed
{
  const vmSrc = readFileSync(new URL('./client/src/viewmodel.js', import.meta.url), 'utf8');
  const rnSrc = readFileSync(new URL('./client/src/render.js', import.meta.url), 'utf8');

  /** Brace-match a `{...}` starting at or after `from` and evaluate it. */
  const braced = (src, from) => {
    const i = src.indexOf('{', from);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
    }
    throw new Error(`unbalanced brace at ${from}`);
  };
  const liftObj = (src, name) => {
    const at = src.indexOf(`const ${name} = {`);
    if (at < 0) throw new Error(`could not find ${name}`);
    return new Function(`return ${braced(src, at)}`)();
  };
  const liftFn = (src, name, ...params) => {
    const at = src.indexOf(`function ${name}(`);
    if (at < 0) throw new Error(`could not find ${name}()`);
    return new Function(...params, braced(src, at + name.length + 9));
  };
  const num = (src, name) => {
    const m = new RegExp(`const ${name} = (-?[0-9.]+)`).exec(src);
    if (!m) throw new Error(`could not read ${name}`);
    return Number(m[1]);
  };
  /** One pose branch, as a callable. `with` is what lets the branch body run against a
   *  supplied scope untouched, which is the only way to test the shipped statements rather
   *  than a transcription of them. */
  const liftBranch = (marker) => {
    const at = vmSrc.indexOf(marker);
    if (at < 0) throw new Error(`could not find branch ${marker}`);
    const open = vmSrc.lastIndexOf('{', at);
    const body = braced(vmSrc, open);
    return new Function('ctx', `with (ctx) ${body}`);
  };

  const RIGS = liftObj(vmSrc, 'RIGS');
  const boxOf = liftFn(vmSrc, 'boxOf', 'spec');
  const rearOf = liftFn(vmSrc, 'rearOf', 'spec');

  // A different stat line with the same outline is not a different weapon in the hand.
  // Fingerprint authored geometry (including rotations) independently of material so a
  // recolour cannot satisfy this test.
  const silhouette = (parts, firstPerson = false) => JSON.stringify(parts.map((p) =>
    firstPerson
      ? p[1] === 'sphere' ? ['sphere', ...p.slice(2)] : p.slice(1)
      : [p[0], p[1], p[2], p[3], p[4], p[5], ...(p.slice(7))]));
  for (const ids of [
    ['rifle', 'rifle_havoc', 'rifle_falcon'],
    ['smg', 'smg_kite', 'smg_banshee'],
    ['pistol', 'pistol_wisp', 'pistol_rook'],
    ['lmg', 'lmg_atlas', 'lmg_colossus'],
  ]) {
    okG(new Set(ids.map((id) => silhouette(RIGS[id].parts, true))).size === ids.length,
        `${ids.map((id) => WEAPONS[id].label).join(', ')} have independently authored first-person silhouettes`,
        ids.map((id) => `${id}:${RIGS[id].parts.length} parts`).join(' · '));
    okG(new Set(ids.map((id) => silhouette(holdOf(id).parts))).size === ids.length,
        `and the ${WEAPONS[ids[0]].family} variants stay distinct in other players' hands`,
        ids.map((id) => `${id}:${holdOf(id).parts.length} parts`).join(' · '));
  }
  const knifeIds = ['knife', 'knife_karambit', 'knife_tanto', 'knife_bowie', 'knife_kukri'];
  okG(new Set(knifeIds.map((id) => RIGS[id].anim)).size === knifeIds.length,
      'all five knives select their own attack choreography',
      knifeIds.map((id) => `${id}:${RIGS[id].anim}`).join(' · '));
  okG(knifeIds.every((id) => vmSrc.includes(`current.spec.anim === '${RIGS[id].anim}'`)
      || id === 'knife'),
      'the viewmodel contains a deliberate motion branch for every special knife',
      'karambit hook · tanto thrust · bowie sweep/chop · kukri diagonal cleave · combat alternating cut');

  // Every decorative box must belong to the assembly. A sight may sit a few millimetres
  // above a rail, but a barrel, stock or magazine separated by open air is the exact
  // "floating parts" failure this guards against.
  const partBox = (p) => {
    if (p[1] === 'sphere') return {
      x0: p[3] - p[2], x1: p[3] + p[2], y0: p[4] - p[2], y1: p[4] + p[2], z0: p[5] - p[2], z1: p[5] + p[2],
    };
    const h = [p[1] / 2, p[2] / 2, p[3] / 2];
    const corners = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const c = rotateXYZ(p[7] ?? 0, p[8] ?? 0, p[9] ?? 0, sx * h[0], sy * h[1], sz * h[2]);
      corners.push([p[4] + c.x, p[5] + c.y, p[6] + c.z]);
    }
    return {
      x0: Math.min(...corners.map((c) => c[0])), x1: Math.max(...corners.map((c) => c[0])),
      y0: Math.min(...corners.map((c) => c[1])), y1: Math.max(...corners.map((c) => c[1])),
      z0: Math.min(...corners.map((c) => c[2])), z1: Math.max(...corners.map((c) => c[2])),
    };
  };
  const boxGap = (a, b) => Math.hypot(
    Math.max(0, a.x0 - b.x1, b.x0 - a.x1),
    Math.max(0, a.y0 - b.y1, b.y0 - a.y1),
    Math.max(0, a.z0 - b.z1, b.z0 - a.z1),
  );
  const floating = [];
  for (const id of WEAPON_IDS.filter((wid) => WEAPONS[wid].kind === 'hitscan')) {
    const boxes = RIGS[id].parts.map(partBox);
    const joined = new Set([0]);
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < boxes.length; i++) if (!joined.has(i)
        && [...joined].some((j) => boxGap(boxes[i], boxes[j]) <= 0.018)) {
        joined.add(i); changed = true;
      }
    }
    if (joined.size !== boxes.length) floating.push(`${id}:${boxes.map((_, i) => i).filter((i) => !joined.has(i)).join(',')}`);
  }
  okG(floating.length === 0, 'every first-person gun is one connected assembly with no floating parts',
      floating.length ? floating.join(' · ') : 'all barrels, magazines, sights and stocks meet the weapon they belong to');

  const remotePartBox = (p) => {
    const h = [p[0] / 2, p[1] / 2, p[2] / 2];
    const corners = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const c = rotateXYZ(p[7] ?? 0, p[8] ?? 0, p[9] ?? 0, sx * h[0], sy * h[1], sz * h[2]);
      corners.push([p[3] + c.x, p[4] + c.y, p[5] + c.z]);
    }
    return {
      x0: Math.min(...corners.map((c) => c[0])), x1: Math.max(...corners.map((c) => c[0])),
      y0: Math.min(...corners.map((c) => c[1])), y1: Math.max(...corners.map((c) => c[1])),
      z0: Math.min(...corners.map((c) => c[2])), z1: Math.max(...corners.map((c) => c[2])),
    };
  };
  const remoteFloating = [];
  for (const id of WEAPON_IDS.filter((wid) => WEAPONS[wid].kind === 'hitscan')) {
    const boxes = holdOf(id).parts.map(remotePartBox);
    const joined = new Set([0]);
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < boxes.length; i++) if (!joined.has(i)
        && [...joined].some((j) => boxGap(boxes[i], boxes[j]) <= 0.025)) {
        joined.add(i); changed = true;
      }
    }
    if (joined.size !== boxes.length) remoteFloating.push(`${id}:${boxes.map((_, i) => i).filter((i) => !joined.has(i)).join(',')}`);
  }
  okG(remoteFloating.length === 0, 'third-person guns remain connected assemblies from every viewing angle',
      remoteFloating.length ? remoteFloating.join(' · ') : 'no opponent carries disconnected weapon pieces');

  const buriedArms = [];
  for (const id of WEAPON_IDS.filter((wid) => WEAPONS[wid].kind === 'hitscan')) {
    const receiver = partBox(RIGS[id].parts[0]);
    for (const [gx, gy, _gz, arm] of RIGS[id].grips) {
      const beside = Math.abs(gx) >= Math.min(Math.abs(receiver.x0), receiver.x1) * 0.75;
      const below = gy <= receiver.y0 - 0.015;
      if (!beside || !below) buriedArms.push(`${id}:${arm ? 'support' : 'trigger'}`);
    }
  }
  okG(buriedArms.length === 0, 'firearm wrists stay below and beside the receiver instead of passing through it',
      buriedArms.length ? buriedArms.join(' · ') : 'both forearms approach external grip surfaces on every gun');
  const REAR_CLEAR = num(vmSrc, 'REAR_CLEAR');
  const POSE_ROOM = num(vmSrc, 'POSE_ROOM');
  const INSPECT_TURN = num(vmSrc, 'INSPECT_TURN');
  const INSPECT_FILL = num(vmSrc, 'INSPECT_FILL');
  const KICK_BACK = num(vmSrc, 'KICK_BACK');
  const KICK_UP = num(vmSrc, 'KICK_UP');
  const KICK_PITCH = num(vmSrc, 'KICK_PITCH');
  const SPRINT_IN_RATE = num(vmSrc, 'SPRINT_IN_RATE');
  const SPRINT_OUT_RATE = num(vmSrc, 'SPRINT_OUT_RATE');
  const SPRINT_FIRE_TAIL = num(vmSrc, 'SPRINT_FIRE_TAIL');
  const SPRINT_FIRE_MAX = num(vmSrc, 'SPRINT_FIRE_MAX');
  /** The shipped carry, lifted rather than transcribed — it is self-contained for
   *  exactly this reason. */
  const sprintCarry = liftFn(vmSrc, 'sprintCarry', 'k', 'sway', 'side');
  const ZERO_CARRY = sprintCarry(0, 0, 1);
  const VM_FOV = num(rnSrc, 'VM_FOV');
  // The recoil spring's own constants, off the line that integrates it.
  const spring = /kickVel \+= \(-kick \* ([0-9.]+) - kickVel \* ([0-9.]+)\) \* dt/.exec(vmSrc);
  if (!spring) throw new Error('could not read the recoil spring');
  const [K, DAMP] = [Number(spring[1]), Number(spring[2])];

  const seg = (t, a, b) => Math.min(1, Math.max(0, (t - a) / (b - a)));
  const smooth = (k) => k * k * (3 - 2 * k);

  /** Everything buildRig() derives, recomputed from the lifted rig table. */
  const build = (id) => {
    const spec = RIGS[id];
    const dz = Math.min(0, -(REAR_CLEAR + POSE_ROOM) - spec.rest[2] - rearOf(spec));
    const b = boxOf(spec);
    const corners = [];
    for (const p of spec.parts) {
      const sph = p[1] === 'sphere';
      const o = sph ? [p[3], p[4], p[5] + dz] : [p[4], p[5], p[6] + dz];
      const h = sph ? [p[2], p[2], p[2]] : [p[1] * 0.5, p[2] * 0.5, p[3] * 0.5];
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          for (const sz of [-1, 1]) {
            const c = sph
              ? { x: sx * h[0], y: sy * h[1], z: sz * h[2] }
              : rotateXYZ(p[7] ?? 0, p[8] ?? 0, p[9] ?? 0, sx * h[0], sy * h[1], sz * h[2]);
            corners.push([o[0] + c.x, o[1] + c.y, o[2] + c.z]);
          }
        }
      }
    }
    return {
      spec, dz, corners,
      limitZ: -REAR_CLEAR - (rearOf(spec) + dz),
      center: [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2 + dz],
      half: [(b.x1 - b.x0) * 0.5, (b.y1 - b.y0) * 0.5, (b.z1 - b.z0) * 0.5],
    };
  };

  /** The spring, integrated as update() does it but at a fixed 1/300s. A coarser step only
   *  ever DAMPS a spring, so every peak here is an upper bound on what a real frame sees. */
  const kickTrace = (impulse, intervalMs, shots) => {
    const dt = 1 / 300;
    const out = [];
    let k = 0;
    let v = 0;
    let t = 0;
    let fired = 0;
    let next = 0;
    while (t < (intervalMs * (shots + 2)) / 1000) {
      if (fired < shots && t >= next) { v += impulse; fired++; next += intervalMs / 1000; }
      v += (-k * K - v * DAMP) * dt;
      k += v * dt;
      out.push({ ms: t * 1000, k });
      t += dt;
    }
    return out;
  };

  const tanY = Math.tan(((VM_FOV / 2) * Math.PI) / 180);
  /** What the camera can say about one drawn frame: how close the weapon comes to the eye,
   *  how far the weapon's centre is from it, and how far out toward the frame edge its
   *  furthest corner reaches (1 = the edge). */
  const look = (rig, pos, rot, tanX) => {
    let near = Infinity;
    let edge = 0;
    for (const c of rig.corners) {
      const r = rotateXYZ(rot[0], rot[1], rot[2], c[0], c[1], c[2]);
      const z = pos[2] + r.z;
      near = Math.min(near, -z);
      const d = Math.max(1e-4, -z);
      edge = Math.max(edge, Math.abs(pos[0] + r.x) / (d * tanX), Math.abs(pos[1] + r.y) / (d * tanY));
    }
    const c = rotateXYZ(rot[0], rot[1], rot[2], rig.center[0], rig.center[1], rig.center[2]);
    return { near, edge, centerD: -(pos[2] + c.z) };
  };

  const GUNS = WEAPON_IDS.filter((id) => RIGS[id] && !RIGS[id].anim);

  // ---- the shove. "i hate the blowback it is all upside instead of up and back" -------
  // The rest branch's own two statements, evaluated with a spring peak fed in: the recoil
  // has to move the weapon BACK past the eye line, not just pitch the muzzle up, and the
  // rearward travel has to fit in POSE_ROOM under sustained fire or the top of every burst
  // is quietly flattened by place()'s clamp.
  {
    const restBody = vmSrc.slice(vmSrc.indexOf('// ---- at rest, taking the recoil'));
    const args = /place\(([\s\S]*?)\);/.exec(restBody)[1];
    const rot = /g\.rotation\.set\(([\s\S]*?)\);/.exec(restBody)[1];
    const at = new Function(
      'x', 'y', 'z', 'bobX', 'bobY', 'kickBack', 'kickUp', 'kickPitch', 'carry',
      `return { p: [${args}], r: [${rot}] };`,
    );

    let worstRoom = 0;
    let roomAt = '';
    let worstAngle = 0;
    let angleAt = '';
    const rows = [];
    for (const id of GUNS) {
      const rig = RIGS[id];
      const r = build(id);
      const w = WEAPONS[id];
      const room = r.limitZ - rig.rest[2];
      const one = Math.max(...kickTrace(rig.kick, w.intervalMs, 1).map((s) => s.k));
      const many = Math.max(...kickTrace(rig.kick, w.intervalMs, isAuto(id) ? 12 : 5).map((s) => s.k));
      // Zeroed: this block is about the recoil, and the carry is provably out of the way
      // by the time a burst stacks — which the sprint block below is what proves.
      const f = at(rig.rest[0], rig.rest[1], rig.rest[2], 0, 0,
        one * KICK_BACK, one * KICK_UP, one * KICK_PITCH, ZERO_CARRY);
      // At the hands, which is where the weapon is felt: the grip sits this far in front of
      // the origin the pitch turns about, so the pitch lifts it by sin(pitch) * that.
      const grip = -(rig.grips[0][2] + r.dz);
      const back = f.p[2] - rig.rest[2];
      const up = f.p[1] - rig.rest[1] + Math.sin(f.r[0]) * grip;
      const angle = (Math.atan2(up, back) * 180) / Math.PI;
      if (angle > worstAngle) { worstAngle = angle; angleAt = id; }
      const use = (many * KICK_BACK) / room;
      if (use > worstRoom) { worstRoom = use; roomAt = id; }
      rows.push(`${id} ${(back * 100).toFixed(1)}back/${(up * 100).toFixed(1)}up cm ${angle.toFixed(0)}deg`);
    }
    okG(worstAngle < 45, 'recoil shoves the weapon back at the hands rather than only up',
        `worst ${worstAngle.toFixed(0)}deg from horizontal (${angleAt}); ${rows.join(', ')}`);
    okG(worstRoom <= 1, 'and sustained fire still fits the pose room, so no burst is clipped',
        `worst ${(worstRoom * 100).toFixed(1)}% of ${(POSE_ROOM * 100).toFixed(0)}cm (${roomAt})`);
  }

  // ---- the sprint carry. "the gun should look like im sprinting ... unless i am shooting" -
  // Four things have to hold, and the source shows none of them.
  //
  //   1. It has to be BIG. The complaint was that sprint was invisible, and the thing it
  //      was invisible against is the walk bob — so the bob's own shipped amplitude is the
  //      yardstick here rather than a number chosen to look right in a diff.
  //   2. It has to MOVE with the stride. A fixed offset reads as a different gun, not as
  //      running; the roll has to swing.
  //   3. It cannot fight place()'s clamp. The carry and the recoil overlap for the ~115ms
  //      after the first round of a burst, so the ease-out and the spring are integrated
  //      TOGETHER here — separately, each one passes and the sum is what clips.
  //   4. Lowering and canting a 70cm rifle throws the stock outward and the muzzle across
  //      the view. Neither end may reach the eye, and the weapon has to stay LOOKED AT —
  //      on every weapon, in both hands, at every point in the stride. The first attempt at
  //      this pose failed here and nowhere else, which is the whole reason this check reads
  //      the frustum instead of the pose.
  {
    const restBody = vmSrc.slice(vmSrc.indexOf('// ---- at rest, taking the recoil'));
    const at = new Function(
      'x', 'y', 'z', 'bobX', 'bobY', 'kickBack', 'kickUp', 'kickPitch', 'carry',
      `return { p: [${/place\(([\s\S]*?)\);/.exec(restBody)[1]}], `
        + `r: [${/g\.rotation\.set\(([\s\S]*?)\);/.exec(restBody)[1]}] };`,
    );
    // The bob's whole vertical amplitude, off the line that draws it.
    const bobAmp = Number(/Math\.abs\(Math\.sin\(sway\)\) \* ([0-9.]+) \* walk/.exec(vmSrc)[1]);
    const PH = 36; // samples across one stride cycle
    const phase = (i) => (i / PH) * Math.PI * 2;
    const deg = (r) => (r * 180) / Math.PI;

    // ---- 1 and 2: is it actually visible, and does it run --------------------------
    let loY = 0;
    let hiRoll = -Infinity;
    let loRoll = Infinity;
    for (let i = 0; i < PH; i++) {
      const c = sprintCarry(1, phase(i), 1);
      loY = Math.min(loY, c.y);
      hiRoll = Math.max(hiRoll, c.roll);
      loRoll = Math.min(loRoll, c.roll);
    }
    okG(Math.abs(loY) > bobAmp * 4,
        'the sprint carry outweighs the bob that sprint used to be invisible against',
        `${(Math.abs(loY) * 100).toFixed(1)}cm of drop against the bob's whole `
          + `${(bobAmp * 100).toFixed(2)}cm — ${(Math.abs(loY) / bobAmp).toFixed(1)}x`);
    okG(deg(hiRoll - loRoll) > 8,
        'and rocks with the stride, so it reads as running rather than as a second gun',
        `cant ${deg(loRoll).toFixed(0)}..${deg(hiRoll).toFixed(0)}deg, `
          + `${deg(hiRoll - loRoll).toFixed(1)}deg of swing`);

    // ---- 3: the clamp, with the recoil underneath ----------------------------------
    // sprintK decays from 1 at the shot — the worst case, a player who was in the carry on
    // the frame before the trigger. Integrated on the spring's own 1/300s step, and a
    // smaller step decays an exponential SLOWER than update()'s per-frame
    // Math.min(1, dt*rate), so every k here is an upper bound on what a real frame holds.
    let worstClamp = -Infinity;
    let clampAt = '';
    let clampCost = 0; // how much of that margin is the CARRY's, not the recoil's
    for (const id of GUNS) {
      const rig = RIGS[id];
      const r = build(id);
      for (const side of [1, -1]) {
        for (const st of kickTrace(rig.kick, WEAPONS[id].intervalMs, isAuto(id) ? 12 : 5)) {
          const k = Math.exp(-(st.ms / 1000) * SPRINT_OUT_RATE);
          for (let i = 0; i < PH; i++) {
            const c = sprintCarry(k, phase(i), side);
            const f = at(rig.rest[0] * side, rig.rest[1], rig.rest[2], 0, 0,
                         st.k * KICK_BACK, st.k * KICK_UP, st.k * KICK_PITCH, c);
            const over = f.p[2] - r.limitZ;
            if (over > worstClamp) {
              worstClamp = over;
              clampAt = `${id} at ${st.ms | 0}ms`;
              clampCost = f.p[2] - at(rig.rest[0] * side, rig.rest[1], rig.rest[2], 0, 0,
                st.k * KICK_BACK, st.k * KICK_UP, st.k * KICK_PITCH, ZERO_CARRY).p[2];
            }
          }
        }
      }
    }
    okG(worstClamp < 0,
        'and never joins the recoil in fighting place()\'s clamp on the way out of a shot',
        `worst ${(-worstClamp * 1000).toFixed(2)}mm of room to spare (${clampAt}), of which `
          + `the carry costs ${(clampCost * 1000).toFixed(2)}mm — the machine gun already spends `
          + `98.8% of POSE_ROOM on its own, and the reason the carry can be added on top of `
          + `that at all is that SPRINT_OUT_RATE has taken it to `
          + `${(Math.exp(-(Number(/([0-9]+)ms/.exec(clampAt)[1]) / 1000) * SPRINT_OUT_RATE) * 100).toFixed(1)}% `
          + `by the time the spring peaks`);

    // ---- 4: the eye and the frame --------------------------------------------------
    // Every rig, not just the guns: a knife at a run gets the same carry. Crouch is left at
    // zero because it is the only reachable value — sprintOk() refuses a crouched sprint,
    // so a carried weapon is never also a crouched one.
    // How MUCH of the weapon the frame holds, as a fraction of its corner cloud. Not the
    // rig's centre and not its furthest corner: at VM_FOV = 50 the frame is about 23cm tall
    // where a weapon rests, and both of those degenerate. The pistol's box centre is already
    // 4% outside the frame AT REST — measuring the centre would have called the rest pose
    // itself a failure — and every rig has some corner outside the frame at rest, because a
    // weapon held at the edge of vision is what a viewmodel IS.
    //
    // So the rest pose is the baseline and the carry is scored against it: whatever fraction
    // of the weapon you can see standing still, you must still be able to see most of
    // running. The pose that shipped before this check kept 0% of SEVEN of the twelve rigs.
    // 4:3 is the narrowest aspect anyone plays on, so it is the one that pushes a weapon out
    // of frame soonest — measure the framing there, not on a widescreen.
    const tanX = tanY * (4 / 3);
    const inFrame = (r, pos, rot) => {
      let n = 0;
      for (const c of r.corners) {
        const q = rotateXYZ(rot[0], rot[1], rot[2], c[0], c[1], c[2]);
        const d = -(pos[2] + q.z);
        if (d > 0.001 && Math.abs(pos[0] + q.x) <= d * tanX && Math.abs(pos[1] + q.y) <= d * tanY) n++;
      }
      return n / r.corners.length;
    };
    let nearest = Infinity;
    let nearAt = '';
    let worstKept = Infinity;
    let keptAt = '';
    const keptRows = [];
    for (const id of WEAPON_IDS.filter((w) => RIGS[w])) {
      const rig = RIGS[id];
      const r = build(id);
      let rest = 0;
      let run = Infinity;
      for (const side of [1, -1]) {
        rest = Math.max(rest, inFrame(r, [rig.rest[0] * side, rig.rest[1], rig.rest[2]], [0, 0, 0]));
        for (let i = 0; i < PH; i++) {
          const c = sprintCarry(1, phase(i), side);
          const pos = [rig.rest[0] * side + c.x, rig.rest[1] + c.y,
                       Math.min(rig.rest[2] + c.z, r.limitZ)];
          const rot = [c.pitch, c.yaw, c.roll];
          if (look(r, pos, rot, tanX).near < nearest) { nearest = look(r, pos, rot, tanX).near; nearAt = id; }
          run = Math.min(run, inFrame(r, pos, rot));
        }
      }
      const kept = rest > 0 ? run / rest : 1;
      if (kept < worstKept) { worstKept = kept; keptAt = id; }
      keptRows.push(`${id} ${(kept * 100) | 0}%`);
    }
    okG(nearest > 0.02, 'the carry never swings any part of the weapon into the camera',
        `nearest ${(nearest * 100).toFixed(1)}cm (${nearAt})`);
    okG(worstKept > 0.5,
        'and every weapon is still mostly on screen while it is carried',
        `worst ${(worstKept * 100) | 0}% of what the rest pose shows kept (${keptAt}); `
          + keptRows.sort().join(', '));

    // ---- the wiring ------------------------------------------------------------------
    // Everything above measures a pose. None of it is drawn if the bit never arrives, and
    // that failure is silent: a gun that simply never carries looks exactly like the
    // complaint that started this. Read by position rather than by name, because the bug
    // worth catching is an argument landing in the wrong slot.
    const vmMain = readFileSync(new URL('./client/src/main.js', import.meta.url), 'utf8');
    const between = (src, open, close) => {
      const a = src.indexOf(open);
      return src.slice(a + open.length, src.indexOf(close, a));
    };
    const commas = (t) => t.split(',').map((w) => w.trim().split('=')[0].trim());
    const names = commas(between(vmSrc.slice(vmSrc.indexOf('update(dtMs')), '(', ')'));
    const args = commas(between(vmMain, 'viewmodel.update(', ');'));
    const slot = names.indexOf('sprinting');
    okG(slot >= 0 && args[slot] === 's.sprinting',
        "and the shared step's own bit is what main.js hands the gun, in the slot that reads it",
        `argument ${slot + 1} of ${args.length} is "${args[slot]}" against parameter `
          + `"${names[slot]}" — handing it "speed" instead is the bug this catches, and it `
          + `would pass every pose check above`);
    // And the parameter is what gates the blend, not a second local guess beside it.
    const chain = ['const wantSprint = sprinting &&',
                   'sprintK += (wantSprint - sprintK)',
                   'sprintCarry(sprintK * (1 - altK)'];
    okG(chain.every((t) => vmSrc.includes(t)),
        'and that parameter is what drives the blend, which is what draws the carry',
        'sprinting -> wantSprint -> sprintK -> sprintCarry(), with no second predicate in '
          + 'between, and the ADS blend multiplied out so the two never draw a hybrid pose');

    // ---- "unless i am shooting" -----------------------------------------------------
    // The hold has to cover the weapon's OWN cadence. Shorter than the interval and a
    // sustained string dips the gun between its own rounds, which is a twitch in the middle
    // of every burst rather than a carry.
    let worstHold = Infinity;
    let holdAt = '';
    const holdRows = [];
    for (const id of WEAPON_IDS) {
      const iv = WEAPONS[id].intervalMs;
      const hold = Math.min(SPRINT_FIRE_MAX, iv + SPRINT_FIRE_TAIL);
      if (hold - iv < worstHold) { worstHold = hold - iv; holdAt = id; }
      holdRows.push(`${id} ${iv}+${hold - iv}`);
    }
    okG(worstHold > 0,
        'a shot holds the weapon up for longer than its own cadence, so no string dips',
        `thinnest margin ${worstHold}ms (${holdAt}); ${holdRows.join(', ')}`);
    // Up fast, down slow. The way down is a decision; the way up answers a trigger.
    const t90 = (rate) => (Math.log(10) / rate) * 1000;
    okG(SPRINT_OUT_RATE > SPRINT_IN_RATE * 1.5,
        'and comes up faster than it went down',
        `${t90(SPRINT_OUT_RATE).toFixed(0)}ms to 90% up against `
          + `${t90(SPRINT_IN_RATE).toFixed(0)}ms down`);
    // What is LEFT of the carry by the time the next rounds leave the barrel on the fastest
    // weapon in the game. Not "is it fully out by then" — at an 80ms interval nothing eases
    // out inside one round without snapping — but the residual has to be falling fast enough
    // that a spray is aimed from the aim line and not from the carry.
    const fastest = Math.min(...GUNS.map((id) => WEAPONS[id].intervalMs));
    const resid = (ms) => Math.exp(-(ms / 1000) * SPRINT_OUT_RATE);
    okG(resid(fastest) < 0.25 && resid(fastest * 2) < 0.06,
        'and is off the aim line by the second round of the fastest spray in the game',
        `${(resid(fastest) * 100) | 0}% of the carry left on round 2 and `
          + `${(resid(fastest * 2) * 100).toFixed(1)}% on round 3, at ${fastest}ms`);
  }

  // ---- working the action. "you dont reload each time it shots but you cocking the gun" --
  // Replayed with its own recoil underneath, because the shot and the stroke start on the
  // same frame: the spring is at its highest while the hand is going back, and the two
  // together are what could push the weapon into the camera.
  {
    const branch = liftBranch('// ---- working the action');
    let worstClamp = 0;
    let nearest = Infinity;
    let nearAt = '';
    for (const id of GUNS) {
      const cycMs = cycleMsOf(id);
      if (!cycMs) continue;
      const rig = RIGS[id];
      const r = build(id);
      for (const side of [1, -1]) {
        for (const s of kickTrace(rig.kick, WEAPONS[id].intervalMs, 3)) {
          if (s.ms > cycMs) continue;
          let raw = 0;
          const g = { rotation: { set: (a, b, c) => { g.rot = [a, b, c]; } } };
          branch({
            cycleT: s.ms / cycMs, x: rig.rest[0] * side, y: rig.rest[1], z: rig.rest[2],
            bobX: 0, bobY: 0, side, current: r, support: null, g, seg, smooth,
            // The stroke's two beats come from rig.js, shared with the remote avatar's hand
            // and the sound, so the branch is fed the same constant the game feeds it.
            CYCLE_AT: CYCLE_HAND.at, CYCLE_RAMP: CYCLE_HAND.ramp,
            kickBack: s.k * KICK_BACK, kickUp: s.k * KICK_UP, kickPitch: s.k * KICK_PITCH,
            place: (px, py, pz) => { raw = pz; g.pos = [px, py, Math.min(pz, r.limitZ)]; },
          });
          worstClamp = Math.max(worstClamp, raw - r.limitZ);
          const L = look(r, g.pos, g.rot, tanY * (16 / 9));
          if (L.near < nearest) { nearest = L.near; nearAt = id; }
        }
      }
    }
    okG(worstClamp <= 0,
        'the bolt stroke never fights place()\'s clamp for the recoil\'s pose room',
        `worst overshoot ${(worstClamp * 1000).toFixed(2)}mm`);
    okG(nearest > 0.02, 'and never brings the weapon into the camera while it does it',
        `nearest ${(nearest * 100).toFixed(1)}cm (${nearAt})`);
  }

  // ---- the inspect. "it should go far so we can see the full view of the gun" -----------
  // Two properties, and the bug was that neither held. The weapon has to be FRAMED at the
  // hold — every corner of it inside the viewport, on whatever aspect the player has — and
  // it must never come nearer to the eye than the rest pose already does, which is what
  // "goes to your face" was: the rig origin sits up to 55cm in front of the box's centre,
  // so turning about the origin swept the front half through the eye.
  {
    const branch = liftBranch('// ---- inspect ------');
    let worstHold = 0;
    let holdAt = '';
    let minNear = Infinity;
    let nearAt = '';
    let worstPush = Infinity;
    let pushAt = '';
    let bestPush = 0;
    let worstJump = 0;
    let jumpAt = 'nothing moved';
    for (const [aw, ah] of [[16, 9], [4, 3], [21, 9]]) {
      const tanX = tanY * (aw / ah);
      for (const id of WEAPON_IDS) {
        if (!RIGS[id]) continue;
        const rig = RIGS[id];
        const r = build(id);
        for (const side of [1, -1]) {
          const frame = (p) => {
            let fade = 1;
            const g = { rotation: { set: (a, b, c) => { g.rot = [a, b, c]; } } };
            branch({
              inspectT: p, x: rig.rest[0] * side, y: rig.rest[1], z: rig.rest[2],
              bobX: 0, bobY: 0, side, current: r, g, seg, smooth, rotateXYZ,
              INSPECT_TURN, INSPECT_FILL, setArmFade: (v) => { fade = v; },
              vmRoot: { fov: VM_FOV, aspect: aw / ah },
              place: (px, py, pz) => { g.pos = [px, py, Math.min(pz, r.limitZ)]; },
            });
            return { ...look(r, g.pos, g.rot, tanX), pos: g.pos, rot: g.rot, fade };
          };
          const rest = frame(0);
          const endsOn = frame(1);
          const jump = Math.max(
            ...[0, 1, 2].map((i) => Math.abs(rest.pos[i] - endsOn.pos[i])),
            ...[0, 1, 2].map((i) => Math.abs(rest.rot[i] - endsOn.rot[i])),
          );
          if (jump > worstJump) { worstJump = jump; jumpAt = id; }
          for (let i = 0; i <= 400; i++) {
            const f = frame(i / 400);
            if (f.near < minNear) { minNear = f.near; nearAt = `${id} ${aw}:${ah}`; }
            // "it should go far so we can see the full view of the gun" — so the weapon has
            // to move AWAY from the eye and stay away for the whole sweep. This is the exact
            // thing the shipped pose got backwards: it turned the weapon about the rig origin,
            // which for a rifle sits up to 55cm in front of the box's centre, so the front
            // half swept through the face on the way round.
            //
            // Measured at the centre rather than at the nearest corner because a turn about
            // the hold tips one corner or another a few millimetres nearer even while the
            // whole weapon recedes; what the corners have to keep is the clearance asserted
            // above, and they keep 5cm more of it than they need.
            const push = f.centerD - rest.centerD;
            if (push < worstPush) { worstPush = push; pushAt = `${id} ${aw}:${ah}`; }
            if (push > bestPush) bestPush = push;
          }
          // At the hold — the plateau of all three curves — the whole weapon has to be in
          // shot, since that is the frame the player pressed F to look at.
          const held = frame(0.55);
          if (held.edge > worstHold) { worstHold = held.edge; holdAt = `${id} ${aw}:${ah}`; }
        }
      }
    }
    okG(worstHold <= 1,
        'the inspect frames the whole weapon at the hold, on every aspect ratio',
        `furthest corner ${(worstHold * 100).toFixed(0)}% of the way to the frame edge (${holdAt}), `
        + `target fill ${(INSPECT_FILL * 100).toFixed(0)}%`);
    okG(minNear >= REAR_CLEAR - 1e-9,
        'and keeps the whole weapon the rest pose\'s own clearance off the eye throughout',
        `nearest corner ${(minNear * 100).toFixed(1)}cm (${nearAt}) against REAR_CLEAR `
        + `${(REAR_CLEAR * 100).toFixed(1)}cm`);
    okG(worstPush >= -1e-9,
        'and it takes the weapon away from the eye to do it, never toward it',
        `closest approach ${(worstPush * 1000).toFixed(2)}mm nearer than rest`
        + `${pushAt ? ` (${pushAt})` : ''}; furthest ${(bestPush * 100).toFixed(1)}cm further out`);
    okG(worstJump < 1e-4,
        'and it starts and ends on the rest pose, so nothing snaps on the last frame',
        `worst discontinuity ${(worstJump * 1e6).toFixed(1)}um / urad (${jumpAt})`);
  }

  // ---- one gesture, two views ----------------------------------------------------------
  // The player's own hands, the remote avatar's hand and the two beats of the sound all
  // read CYCLE_HAND.at. Lifting both curves and comparing them is what makes that a fact
  // rather than an intention: the shape may differ (one is smoothed, one is a ramp) but a
  // watcher has to see the bolt reach the rear when the shooter hears it get there.
  {
    // Anchored inside the cycle branch: `pull` is also the name of the deploy's cocking
    // beat further up the same chain.
    const cycleBody = vmSrc.slice(vmSrc.indexOf('// ---- working the action'));
    const pull = new Function('cp', 'seg', 'smooth', 'CYCLE_AT', 'CYCLE_RAMP',
      // Parenthesised: the shipped expression starts on the line after its `=`, and a bare
      // `return` followed by a newline is `return undefined`.
      `return (${/const pull =([\s\S]*?);/.exec(cycleBody)[1]});`);
    const rampIn = new Function(`return ${/const rampIn = ([\s\S]*?\n};)/.exec(rnSrc)[1]}`)();
    const remote = new Function('cp', 'rampIn', 'CYCLE_HAND',
      `const [back, home] = CYCLE_HAND.at; const r = CYCLE_HAND.ramp;
       return ${/stroke = (rampIn\([\s\S]*?);/.exec(rnSrc)[1]};`);
    let worst = 0;
    let peakSelf = 0;
    let peakOther = 0;
    for (let i = 0; i <= 1000; i++) {
      const cp = i / 1000;
      const a = pull(cp, seg, smooth, CYCLE_HAND.at, CYCLE_HAND.ramp);
      const b = remote(cp, rampIn, CYCLE_HAND);
      worst = Math.max(worst, Math.abs(a - b));
      if (a > 0.999 && !peakSelf) peakSelf = cp;
      if (b > 0.999 && !peakOther) peakOther = cp;
    }
    okG(worst < 1e-9 && peakSelf > 0 && peakSelf === peakOther,
        'the bolt reaches the rear at the same moment in both views and in the sound',
        `max |first-person − third-person| ${worst.toExponential(1)} over the stroke; `
        + `rear at ${(peakSelf * 100).toFixed(1)}% of ${cycleMsOf('sniper')}ms = `
        + `${(peakSelf * cycleMsOf('sniper')).toFixed(0)}ms, beats at `
        + `${CYCLE_HAND.at.map((f) => `${(f * cycleMsOf('sniper')).toFixed(0)}ms`).join(' / ')}`);
  }
}

console.log([...pG, ...fG].join('\n'));

// ────────────────────────────── Part H: the career ladder and the store behind it
//
// Two things, separated on purpose. `shared/ranks.js` is a pure table plus a lookup, and
// is checked here exhaustively because it is the one file both sides read: a boundary that
// disagreed between browser and server would put a different badge over a head than on
// the scoreboard, and no amount of network testing would find it.
//
// `server/ranks.js` is the disk, and what is checked there is the failure it exists to
// survive — a file truncated by a crash mid-write, which the naive version turns into a
// server that will not boot at all. The suite drives it through FPSBONE_RANKS so that
// running these checks can never open a real player's career.
console.log('\n=== Part H — the career ladder ===\n');

const pH = [];
const fH = [];
const okH = (cond, label, detail = '') => {
  (cond ? pH : fH).push(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// ─────────────────────────────── the table itself
{
  okH(TIERS.length === 21 && MAX_TIER === 20,
      'the ladder is twenty-one tiers deep, private through five stars',
      `${TIERS[0].name} (${TIERS[0].abbr}) up to ${TIERS[MAX_TIER].name} (${TIERS[MAX_TIER].abbr})`);

  const bad = TIERS.filter((t, i) => i > 0 && t.at <= TIERS[i - 1].at);
  okH(bad.length === 0 && TIERS[0].at === 0,
      'every rung is strictly harder to reach than the one below it',
      bad.length ? `${bad.length} non-increasing: ${bad.map((t) => t.abbr).join(', ')}`
        : TIERS.map((t) => t.at).join(' '));

  // The half the user asked for by name — "up to 5 STAR". Both halves are asserted: that
  // the top five carry one through five stars in order, and that nothing below them
  // carries a star at all. A ladder where a sergeant wore one would make the top of it
  // mean nothing, and it is exactly the edit a later re-tune makes without noticing.
  const stars = TIERS.filter((t) => t.band === 'star');
  const starIdx = TIERS.map((t, i) => (t.band === 'star' ? i : -1)).filter((i) => i >= 0);
  okH(stars.length === 5 && starIdx.join() === '16,17,18,19,20'
      && stars.every((t, i) => t.pips === i + 1),
      'exactly the top five tiers are the star generals, one star through five',
      stars.map((t) => `${t.abbr} ${t.pips}`).join('  '));

  // Why the ladder is banded at all, rather than one long run of chevrons. Nine stacked
  // marks is not a shape anyone can count at eight pixels, and reading it as a count is
  // the entire argument for insignia over names — so the cap is asserted, not just meant.
  const over = TIERS.filter((t) => !(Number.isInteger(t.pips) && t.pips >= 1 && t.pips <= 5));
  const bands = [...new Set(TIERS.map((t) => t.band))];
  okH(over.length === 0 && bands.length === 5,
      'and no single insignia asks a player to count past five marks',
      over.length ? over.map((t) => `${t.abbr}=${t.pips}`).join(', ')
        : bands.map((b) => `${b} ${TIERS.filter((t) => t.band === b).length}`).join(', '));

  const dupN = TIERS.length - new Set(TIERS.map((t) => t.name)).size;
  const dupA = TIERS.length - new Set(TIERS.map((t) => t.abbr)).size;
  const dupI = TIERS.length - new Set(TIERS.map((t) => `${t.band}${t.pips}`)).size;
  okH(dupN === 0 && dupA === 0 && dupI === 0,
      'no two tiers share a name, an abbreviation, or an insignia',
      dupI ? `${dupI} insignia collision(s) — two ranks would draw identically`
        : 'all 21 tell apart by badge alone, with no text needed');
}

// ─────────────────────────────── rankOf, at and around every boundary
{
  // Exhaustive over the whole live range plus overshoot. The function is a loop over a
  // table, so the only interesting inputs are the 21 places it changes its answer.
  let mono = true;
  let prev = 0;
  for (let k = 0; k <= 2000; k++) {
    const r = rankOf(k);
    if (r < prev) mono = false;
    prev = r;
  }
  okH(mono && rankOf(0) === 0 && rankOf(99999) === MAX_TIER,
      'a career only ever moves up the ladder, and tops out instead of running off it',
      `0 gives ${TIERS[0].abbr}, ${TIERS[MAX_TIER].at} gives ${TIERS[MAX_TIER].abbr}, `
      + `99999 gives ${TIERS[rankOf(99999)].abbr}`);

  // The boundary is INCLUSIVE: `at` is the first career that has earned the tier, not the
  // last that has not. A `>` where the code has `>=` shifts every rank in the game by one
  // kill, and is invisible unless the exact value is checked.
  const offByOne = TIERS.map((t, i) => ({ i, t }))
    .filter(({ i, t }) => rankOf(t.at) !== i || (i > 0 && rankOf(t.at - 1) !== i - 1));
  okH(offByOne.length === 0,
      'each threshold is the first kill that earns the tier, not the one after it',
      offByOne.length
        ? offByOne.map(({ i, t }) => `${t.abbr}@${t.at} gave ${rankOf(t.at)} not ${i}`).join(', ')
        : `all 21 exact; ${TIERS[5].at - 1} gives ${TIERS[rankOf(TIERS[5].at - 1)].abbr} and `
          + `${TIERS[5].at} gives ${TIERS[rankOf(TIERS[5].at)].abbr}`);

  // Junk in has to give a Private, not a throw. The number reaching rankOf has come off a
  // JSON file on disk, and snapshotBase calls it once per player per broadcast — a throw
  // there takes the room down, so the guard is load-bearing rather than defensive habit.
  const junk = [NaN, Infinity, -Infinity, undefined, null, -5, '40', {}];
  let threw = null;
  const got = junk.map((v) => {
    try { return rankOf(v); } catch (e) { threw = `${v}: ${e.message}`; return 'THREW'; }
  });
  okH(threw === null && got.every((r) => Number.isInteger(r) && r >= 0 && r <= MAX_TIER),
      'and a corrupt career reads as a private rather than taking the snapshot down',
      threw ?? 'NaN, both infinities, undefined, null, -5, a string and an object all give '
        + `tier ${[...new Set(got)].join(',')}`);

  const gaps = TIERS.map((t, i) => (i < MAX_TIER
    ? toNextRank(t.at) === TIERS[i + 1].at - t.at
    : toNextRank(t.at) === 0));
  okH(gaps.every(Boolean) && toNextRank(TIERS[MAX_TIER].at) === 0 && toNextRank(2) === 1,
      'the HUD can tell a player how many kills the next rank is away',
      `a fresh account needs ${toNextRank(0)}, two kills in needs ${toNextRank(2)}, `
      + `and the top rank needs ${toNextRank(TIERS[MAX_TIER].at)} because it is the top`);
}

// ─────────────────────────────── the two ranks.js files, and which may touch a disk
{
  const rkSrc = readFileSync(new URL('./shared/ranks.js', import.meta.url), 'utf8');
  const imports = [...rkSrc.matchAll(/^\s*(?:import|require)\b.*$/gm)].map((m) => m[0].trim());
  okH(imports.length === 0,
      'the ladder both sides read imports nothing at all, so it cannot fork',
      imports.length ? imports.join(' | ')
        : 'zero imports — the same rule shared/constants.js states in its own header');

  // The quarantine, as a fact about the files rather than a comment inside them. This
  // suite builds Rooms in four places; if server/room.js could reach the filesystem even
  // through one more hop, running the tests would rewrite real players' careers as a side
  // effect. A silent, permanent, off-target write is the failure worth a machine.
  // `serve.js` is the Node entry point and the only file under server/ that may reach the
  // store. `index.js` is the host it wraps, and it is now ON the quarantined list rather
  // than being the exception to it — a Room-building file that cannot reach a disk at all
  // is strictly stronger than one trusted to only do it from the top. That tightening is
  // also what makes a static deploy possible; the assert below is the other half of it.
  const under = ['room.js', 'index.js', 'hitscan.js', 'ai.js', 'modes/index.js', 'modes/ffa.js'];
  const read = (f) => {
    try { return readFileSync(new URL(`./server/${f}`, import.meta.url), 'utf8'); }
    catch { return ''; }
  };
  const everything = [...under, 'serve.js'];
  const fsUsers = everything.filter((f) => /from\s+'node:fs'|require\('fs'\)|from\s+'fs'/.test(read(f)));
  const importers = everything.filter((f) => /from\s+'\.\/ranks\.js'/.test(read(f)));
  okH(fsUsers.length === 0 && importers.join() === 'serve.js',
      'and only the entry point can reach the disk, so building a Room never writes one',
      `node:fs under server/: ranks.js only${fsUsers.length ? ` PLUS ${fsUsers.join(', ')}` : ''}; `
      + `imports server/ranks.js: ${importers.join(', ') || 'nobody'}`);

  // And the host stays runnable in a browser, which is the load-bearing fact behind the
  // static build: client/src/localserver.js imports server/index.js straight into the page,
  // so a `ws`, `node:` or `process` reference appearing in it is not a test failure with a
  // workaround — it breaks `vite build`, or ships a bundle that dies on load and puts the
  // client back on "connecting…" forever, which is the bug that seam was cut to fix. The
  // three things that tie a host to Node arrive as injections instead.
  const hostSrc = read('index.js');
  const nodeisms = [
    ['ws', /from\s+'ws'/],
    ['node: builtins', /from\s+'node:/],
    ['process', /\bprocess\./],
  ].filter(([, re]) => re.test(hostSrc)).map(([what]) => what);
  okH(nodeisms.length === 0,
      'and the host itself stays browser-safe, which is what lets a static deploy play at all',
      nodeisms.length ? `server/index.js reaches for ${nodeisms.join(', ')}`
        : 'no ws, no node: builtins, no process — the clock and the career store are injected');

  // room.js must import the TABLE, not the STORE. Both are called ranks.js, one directory
  // apart, and an editor's auto-import is a single keystroke from turning the assert above
  // red for a reason nobody would guess from its message — so name the right line here.
  const roomSrc = readFileSync(new URL('./server/room.js', import.meta.url), 'utf8');
  const shared = /from\s*'\.\.\/shared\/ranks\.js'/.test(roomSrc);
  okH(shared && /this\.onCareer/.test(roomSrc) && /onCareer\?\.\(/.test(roomSrc),
      'room.js reads the shared table and hands careers out through a callback instead',
      `shared table imported: ${shared}; onCareer declared and called with ?. so a Room `
      + 'built by this suite counts in memory and persists nothing');
}

// ─────────────────────────────── the wire: a tier, omitted when it is zero
{
  const room = new Room(DEFAULT_MODE);
  const a = room.add('rookie', {}, 'acct-a');
  const b = room.add('veteran', {}, 'acct-b');
  const pa = room.players.get(a);
  const pb = room.players.get(b);
  const at = (id) => room.snapshotBase().players.find((q) => q.id === id);

  okH(at(a).rk === undefined && at(b).rk === undefined,
      'a fresh account carries no rank field at all, rather than a zero',
      'tier 0 is where every new player sits, so the common case costs nothing on a 20Hz '
      + 'broadcast — the same omit-when-zero rule sp and jm already follow');

  pb.career = TIERS[16].at;
  okH(at(b).rk === 16 && at(a).rk === undefined,
      'and a career that has earned a tier puts exactly that tier on the wire',
      `career ${pb.career} gives rk ${at(b).rk}, ${TIERS[at(b).rk].name}, and the other `
      + 'player is still unaffected');

  const snap = at(b);
  const leaked = Object.entries(snap).filter(([, v]) => v === 'acct-b' || v === pb.career);
  okH(leaked.length === 0 && snap.rk === 16,
      'but never the account id or the raw kill count, only the derived tier',
      leaked.length ? `LEAKED ${leaked.map(([k]) => k).join(', ')}`
        : 'an id is a bearer token until the identity seam can verify a signature, and a '
          + 'career total is not the rest of the room’s business');

  // The award itself. On the kill path in room.js rather than in a mode controller,
  // because ffa.js clears p.kills every match and modes/index.js defaults onKill to a
  // no-op — a mode added later that forgot it would keep scoring and quietly stop
  // counting careers.
  const seen = [];
  room.onCareer = (acct, k) => seen.push([acct, k]);
  pa.career = 0;
  const kill = (attacker, victim) => {
    victim.hp = C.MAX_HP;
    victim.alive = true;
    victim.protectedUntil = 0;
    room.applyDamage(attacker, victim, 9999, 0);
  };
  kill(pa, pb);
  const afterReal = [pa.career, seen.length];
  kill(pa, pa);            // your own grenade
  kill(null, pb);          // fell out of the world
  okH(afterReal[0] === 1 && afterReal[1] === 1 && pa.career === 1 && seen.length === 1
      && seen[0][0] === 'acct-a' && seen[0][1] === 1,
      'a kill credits the killer once, and a suicide or a fall credits nobody',
      `career ${pa.career} after one real kill, one self-kill and one death with no `
      + `attacker; the store was told ${seen.length} time(s): ${JSON.stringify(seen)}`);

  // The gate that keeps bots out of the store. They get a rank so that solo play does not
  // look like a broken ladder, and no ledger, because the next bot to take the seat reuses
  // the id.
  const bot = room.addBot('BOT tester');
  const pbot = room.players.get(bot);
  const before = seen.length;
  pbot.career = 5000;
  kill(pbot, pb);
  okH(pbot.account === null && seen.length === before && at(bot).rk === MAX_TIER,
      'and a bot wears a rank but never writes one, having no account to write it under',
      `account ${pbot.account}, rk ${at(bot).rk} on the wire, and the store was told `
      + `nothing (${before} to ${seen.length})`);

  // Seeded from the id, on the same argument createBrain(id) is seeded on two lines above
  // it. A RAMP is the failure worth naming: `id * k % 21` marches bots 1, 2, 3... straight
  // up the ladder, which reads on screen as a difficulty curve the game does not have.
  //
  // Monotonicity alone does NOT catch that, and finding out the hard way is why the test
  // below is the shape it is: the modulo WRAPS, so the ramp climbs, resets to Private and
  // climbs again — never ascending end to end, and still four bots in a row visibly going
  // up. What survives the wrap is the STRIDE, so the stride is what gets measured. A
  // seeding worth having repeats no step often enough to be seen as one.
  const r2 = new Room(DEFAULT_MODE);
  const seeds = [];
  for (let i = 0; i < 12; i++) seeds.push(rankOf(r2.players.get(r2.addBot(`BOT ${i}`)).career));
  const asc = seeds.every((v, i) => i === 0 || v >= seeds[i - 1]);
  const steps = seeds.slice(1).map((v, i) => v - seeds[i]);
  const tally = new Map();
  for (const d of steps) tally.set(d, (tally.get(d) ?? 0) + 1);
  const commonest = Math.max(...tally.values());
  const r3b = new Room(DEFAULT_MODE);
  const again = [];
  for (let i = 0; i < 12; i++) again.push(rankOf(r3b.players.get(r3b.addBot(`BOT ${i}`)).career));
  okH(new Set(seeds).size >= 6 && !asc && commonest * 2 <= steps.length
      && again.join() === seeds.join(),
      'a room of bots shows a spread of ranks, the same spread every time, in no pattern',
      `${new Set(seeds).size} distinct tiers over 12 bots: ${seeds.map((s) => TIERS[s].abbr).join(' ')}`
      + ` — the commonest step between neighbours is ${commonest} of ${steps.length}`
      + `${asc ? ', and the whole run ASCENDS' : ''}`);
}

// ─────────────────────────────── the store on disk, and the file that would not boot
{
  // A real save and load, through the module's own API, against a temp file — never the
  // repo's own ranks.json. FPSBONE_RANKS exists for this: a suite that had to back up and
  // restore the live store to be safe would be one crash away from not restoring it.
  const STORE = join(tmpdir(), `fpsbone-ranks-verify-${process.pid}.json`);
  process.env.FPSBONE_RANKS = STORE;
  const wipe = () => {
    for (const f of [STORE, `${STORE}.tmp`]) {
      try { unlinkSync(f); } catch { /* already gone */ }
    }
  };
  // Each probe module keeps its own store in module state and registers its own exit
  // flush, so a dirty one writes on the way out — after any cleanup here. This handler is
  // registered last and therefore runs last.
  process.on('exit', wipe);

  /** A fresh module instance per case: the file is read once, at import. */
  let probeN = 0;
  const load = async (text) => {
    wipe();
    if (text !== null) writeFileSync(STORE, text);
    return import(`./server/ranks.js?probe=${probeN++}`);
  };

  const good = await load('{"acct-x":140,"acct-y":3}');
  const round = [good.careerOf('acct-x'), good.careerOf('acct-y'), good.careerOf('acct-z')];
  good.setCareer('acct-z', 900);
  good.flush();
  const back = JSON.parse(readFileSync(STORE, 'utf8'));
  okH(round.join() === '140,3,0' && back['acct-z']?.k === 900 && back['acct-x']?.k === 140,
      'a career survives being written to disk and read back, and an unknown one is zero',
      `loaded ${round.join(', ')} — ${TIERS[rankOf(round[0])].abbr}, `
      + `${TIERS[rankOf(round[1])].abbr}, ${TIERS[rankOf(round[2])].abbr} — and wrote back `
      + `${JSON.stringify(back)}`);

  okH(!existsSync(`${STORE}.tmp`),
      'and it is written temp-then-renamed, so no reader ever sees half a file',
      'the temp path is gone after flush, which is what lets the boot parse treat a '
      + 'truncated file as impossible-but-survivable rather than as normal');

  // A FAILED WRITE, forced rather than waited for. A directory sitting where the temp file
  // goes makes writeFileSync fail the same way on every platform, and it stands in for the
  // failure that actually happens: on Windows a scanner holding the store open for a moment
  // turns the rename onto it into EBUSY, which is how this suite found the bug — four
  // careers checks went red together in one run out of three. The warning is not the thing
  // that matters. What matters is that the career is STILL IN HAND afterwards and something
  // is scheduled to try again, because the alternative is one console line telling a player
  // their afternoon is gone.
  const held = await load('{"keep":10}');
  mkdirSync(`${STORE}.tmp`);
  const warned = [];
  const realWarn = console.warn;
  let threw = null;
  try {
    console.warn = (m) => warned.push(String(m));
    held.setCareer('keep', 42);
    held.flush();
  } catch (e) {
    threw = e.message;
  } finally {
    console.warn = realWarn;
  }
  const kept = held._stats().dirty;
  rmdirSync(`${STORE}.tmp`);
  held.flush();                             // the retry, now that the path is free again
  const landed = existsSync(STORE) ? JSON.parse(readFileSync(STORE, 'utf8')) : null;
  okH(threw === null && kept === true && landed?.keep?.k === 42 && warned.length === 1,
      'a write that cannot land keeps the career and stays dirty, instead of dropping it',
      threw ? `THREW OUT OF flush: ${threw} — a disk that argues would take the server with it`
        : `the store stayed dirty=${kept} through a blocked write, said so once `
          + `(${JSON.stringify(warned[0]?.trim() ?? null)}), and the same career landed as `
          + `${JSON.stringify(landed?.keep ?? null)} on the next flush — a transient failure `
          + 'costs seconds, not a career, and nothing else in the process retries');

  let crashed = null;
  let empty = null;
  try {
    const trunc = await load('{"acct-x":140,"acct-y":');
    empty = [trunc.careerOf('acct-x'), trunc._stats().size, trunc._stats().dirty];
  } catch (e) { crashed = e.message; }
  okH(crashed === null && empty !== null && empty[0] === 0 && empty[1] === 0 && empty[2] === false,
      'a file truncated mid-write costs the careers in it, and does not stop the server',
      crashed ? `THREW AT IMPORT: ${crashed} — the server would not boot`
        : `the store came up empty at ${empty[1]} accounts and CLEAN rather than dirty, so `
          + 'a merely unreadable file is not immediately overwritten on top of');

  const arr = await load('["not", "an", "object"]');
  // `rec` is the second legal shape and has to survive; `obj` is an object with no career
  // in it and must not. Both are here because the file gained a shape (Part K covers it),
  // and a fixture carrying only the old one would stop testing the discrimination at all.
  const kinds = await load('{"ok":7,"neg":-4,"nan":"x","obj":{"n":1},"rec":{"k":11}}');
  okH(arr._stats().size === 0 && kinds.careerOf('ok') === 7 && kinds.careerOf('rec') === 11
      && kinds._stats().size === 2 && kinds.careerOf('neg') === 0,
      'and every entry is checked on the way in, not only the file around them',
      `an array yields ${arr._stats().size} accounts; of ok, neg, nan, obj and rec only `
      + `${kinds._stats().size} survived — a career is a finite non-negative number, or a `
      + 'record carrying one, and anything else is not a career');

  const cap = await load('{}');
  for (let i = 0; i < 5200; i++) cap.setCareer(`spam-${i}`, 1);
  const st = cap._stats();
  okH(st.size === st.cap && st.size === 5000 && cap.careerOf('spam-0') === 0
      && cap.careerOf('spam-5199') === 1,
      'the account map is capped, because an unverified client id is a way to fill a disk',
      `5200 ids in, ${st.size} kept against a cap of ${st.cap}; the oldest was evicted `
      + `(spam-0 reads ${cap.careerOf('spam-0')}) and the newest kept (spam-5199 reads `
      + `${cap.careerOf('spam-5199')})`);

  const lru = await load('{"old":1,"mid":2,"new":3}');
  lru.careerOf('old');                      // reading counts as use
  okH(lru._stats().oldest === 'mid' && lru.careerOf('old') === 1,
      'and reading a career counts as using it, so a returning player does not age out',
      `after touching "old" the eviction candidate is "${lru._stats().oldest}" — a player `
      + 'who has not scored yet still has an account worth keeping');

  wipe();
  delete process.env.FPSBONE_RANKS;
}

console.log([...pH, ...fH].join('\n'));


// ───────────────────────── Part J: the rank where a player can actually see it
//
// Part H proves the ladder is the same on both sides of the wire. That is the half nobody
// looks at. This is the half the feature was asked for — "your rank should display at the
// top of your character head up to 5 STAR" — and none of it can be imported: `render.js`
// pulls in three.js and `hud.js` reaches for `document`, so both are lifted out as text and
// run here, the same way Part D lifts the bob and the leg swing.
//
// The properties worth pinning are the ones where the obvious code is wrong:
//
//   A plate has to be a Mesh with its own geometry. `THREE.Sprite` is the natural way to
//   write a billboard and every Sprite in three.js shares one module-level geometry, which
//   the avatar cull disposes by walking the group — so the first player to leave a match
//   would blank every other player's plate at once. Nothing in a screenshot shows that.
//
//   The plate has to face the camera from any body yaw, which is one atan2 and a
//   subtraction, and a sign error in either reads as "the rank is invisible sometimes".
//
//   The marks have to stay the same SIZE across the ladder. Fitting five stars into a
//   one-chevron plate is the simplifying change waiting to be made here, and it draws a
//   five-star general's insignia smaller than a private's.
//
//   Exactly one thing per frame may own `plate.visible`. Two owners plus an early-out on an
//   unchanged rank is how a plate ends up stuck off after a respawn — a bug that needs a
//   death, a respawn and a rank that did not change in between to reproduce by hand.
console.log('\n=== Part J — the rank on screen ===\n');

const pJ = [];
const fJ = [];
const okJ = (cond, label, detail = '') => {
  (cond ? pJ : fJ).push(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const rdJ = readFileSync('client/src/render.js', 'utf8');
/** The same source with the prose taken out.
 *
 * The text checks below ask what the CODE does, and two of them are about something this
 * file argues for at length in a comment: never a THREE.Sprite, depthTest stays on. Grepping
 * the raw source finds the argument and reads it as the mistake — a test that would fail
 * hardest on the file which documents itself best. */
const bareJ = rdJ
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
const hudJ = readFileSync('client/src/hud.js', 'utf8');
/** The rank device's own module. It used to be a section of render.js, and it moved out
 *  the day the scoreboard started wearing the same drawing -- see the header of
 *  insignia.js. Read as text like every other client file here, for the reason Part D
 *  explains: none of them can be imported. */
const insJ = readFileSync('client/src/insignia.js', 'utf8');
const idxJ = readFileSync('server/index.js', 'utf8');

/** Lift a whole function BODY out of a client module and make it callable.
 *
 * Part D's `lift` takes a single expression; a plate needs the statements around one. Same
 * contract in the way that matters: a regex that stops matching FAILS here and returns null,
 * so the checks below are skipped with a named reason instead of throwing from inside a
 * detail string and taking the rest of the part down with them. */
const liftFn = (src, name, params, extra = '') => {
  const re = new RegExp(`\\nfunction ${name}\\(([^)]*)\\) \\{\\n([\\s\\S]*?)\\n\\}\\n`);
  const m = re.exec(src);
  okJ(!!m, `${name}() is still where this suite looks for it`,
      m ? `lifted ${m[2].split('\n').length} lines` : `no match — ${name} was renamed or `
      + 'reshaped, so nothing below it could be measured');
  if (!m) return null;
  return new Function(...params, `${extra}\n${m[2]}`);
};

/** The plate constants, read out of the module rather than restated here. Restating them
 *  would make every check below pass against a source that no longer says the same thing. */
const constJ = (name) => {
  const m = new RegExp(`\\nconst ${name} = ([-\\d.]+);`).exec(`${rdJ}${insJ}`);
  return m ? Number(m[1]) : NaN;
};
const PLATE = {
  H: constJ('FIELD_H'),
  CLEAR: constJ('PLATE_CLEAR'),
  CULL: constJ('PLATE_CULL'),
  PX: constJ('FIELD_PX'),
  W_MAX: constJ('FIELD_W_MAX'),
  MARGIN: constJ('MARK_MARGIN'),
};

/** Drive a block of checks that runs lifted client code, and turn a throw into a red check.
 *
 * `liftFn` covers a regex that stops matching. It does not cover the other half: a regression
 * in the code being lifted does not politely return a wrong number, it THROWS — from inside a
 * `new Function` with no stack worth reading. Unprotected that takes the rest of this part and
 * the whole of Part I with it, and a suite that dies partway is easy to read as a suite that
 * never ran. Two deliberate regressions found this: pinning the plate at standing height (`C`
 * is not in the lifted scope) and dropping the top-of-ladder guard (`TIERS[21].name`). Both
 * are precisely what the checks inside these blocks exist to catch, so both have to come out
 * red rather than as an exit code. */
const driveJ = (what, fn) => {
  try {
    fn();
  } catch (e) {
    okJ(false, `${what} could not be driven at all`,
        `threw: ${e?.message ?? e} — a lifted function that throws is a regression in the `
        + 'source it was lifted from, and it is reported here rather than allowed to end the run');
  }
};


// ─────────────────────────────── how it is built, and what the cull does with it
{
  okJ(!/THREE\.Sprite|SpriteMaterial/.test(bareJ)
      && /new THREE\.Mesh\(new THREE\.PlaneGeometry\(FIELD_H, FIELD_H\), plateMat\)/.test(bareJ),
      'the plate is a mesh with a geometry of its own, and no sprite exists in the renderer',
      'the cull disposes geometry by walking the avatar group, and three.js gives every '
      + 'Sprite the SAME geometry object — one player leaving would blank all the rest');

  // Two halves of one rule, and the second is the one that leaks silently.
  const disposed = /a\.plateMat\.dispose\(\);/.test(bareJ);
  const matsList = /materials: \[([^\]]*)\]/.exec(bareJ)?.[1] ?? '';
  okJ(disposed && !matsList.includes('plateMat'),
      'its material is freed on the way out, and is not in the list the corpse fade drives',
      `materials: [${matsList}] — a plate is hidden on death rather than faded, and a `
      + 'material left out of both that list and the cull is a leak per player per match');

  const parent = /\n  group\.add\(plate\);/.test(bareJ)
    && !/(duck|pivot|tilt)\.add\(plate\)/.test(bareJ);
  okJ(parent, 'it hangs off the group, and off none of the three nodes that would move it',
      'duck scales with the crouch, pivot carries the head pitch, and tilt is what topples '
      + 'a corpse — a plate on any of them ducks, tips or falls over with the body');

  // The material literal, by text. depthTest is the occlusion mechanism, and the way it
  // breaks is somebody ADDING a line, which no behavioural check on a headless box can see.
  const lit = /const plateMat = new THREE\.MeshBasicMaterial\(\{([\s\S]*?)\n  \}\);/.exec(bareJ)?.[1] ?? '';
  okJ(lit.includes('depthWrite: false') && !/depthTest/.test(lit),
      'depth testing is left alone, which is the whole of how a plate hides behind cover',
      lit.includes('depthWrite: false')
        ? 'no depthTest line at all, so it keeps the default true — the depth buffer already '
          + 'holds every wall and every body, which a ray against shared/collide.js cannot'
        : `the literal reads: ${lit.replace(/\s+/g, ' ').trim()}`);
}

// ─────────────────────────────── aimPlate, lifted out and driven
driveJ('the plate aim', () => {
    const aim = liftFn(rdJ, 'aimPlate', ['a', 'cam'],
      `const halfHAt = arguments[2], PLATE_CLEAR = ${PLATE.CLEAR}, FIELD_H = ${PLATE.H}, PLATE_CULL = ${PLATE.CULL};`);

    const avatar = (yaw, cr, x = 0, z = 0) => ({
      plateOn: true,
      crouch: cr,
      group: { position: { x, y: C.PLAYER_HALF_H, z }, rotation: { y: yaw } },
      plate: { position: { x: 0, y: 0, z: 0 }, rotation: { y: 0 }, visible: false },
    });
    const cam = (x, z) => ({ position: { x, y: C.EYE_OFFSET, z } });
    // A throw out of the lifted body is a wrong ANSWER, not an accident — it is what a
    // regression in aimPlate actually does, and two of the ones this suite is built to catch
    // fail exactly that way. Poisoning the plate keeps the failure attached to the check that
    // asked the question; driveJ is only the net for what this does not reach, and its label
    // names no property. NaN fails every comparison below, and inverting `visible` fails the
    // two checks that read it whichever way round they were expecting it.
    const threw = [];
    const run = (a, c) => {
      try {
        aim(a, c, halfHAt);
      } catch (e) {
        threw.push(`${e?.message ?? e}`);
        a.plate.position.y = NaN;
        a.plate.rotation.y = NaN;
        a.plate.visible = !a.plateOn;
      }
      return a.plate;
    };

    if (aim) {
      // Every crouch the blend can actually produce, at its own lattice of CROUCH_RATE * TICK_DT.
      const crs = [];
      for (let cr = 0; cr <= 1.0001; cr += C.CROUCH_RATE * C.TICK_DT) crs.push(Math.min(1, cr));
      const heights = crs.map((cr) => run(avatar(0, cr), cam(0, 6)).position.y);
      const clear = crs.every((cr, i) => heights[i] > halfHAt(cr) + 1e-9);
      const lifts = crs.map((cr, i) => heights[i] - halfHAt(cr));
      okJ(clear && Math.max(...lifts) - Math.min(...lifts) < 1e-9,
          'the plate clears the crown by the same margin at every crouch depth',
          `${lifts[0].toFixed(3)}u above the head standing and ${lifts[lifts.length - 1].toFixed(3)}u `
          + `fully ducked, over ${crs.length} reachable crouch values — the crown in group space `
          + 'is exactly halfHAt(cr), because duck.scale.y and the rig\'s own crown cancel');

      const stand = run(avatar(0, 0), cam(0, 6)).position.y;
      const duck = run(avatar(0, 1), cam(0, 6)).position.y;
      okJ(duck < stand - 0.3,
          'and it rides the duck down, so a crouching player\'s rank comes with their head',
          `${stand.toFixed(3)}u standing against ${duck.toFixed(3)}u ducked — a plate pinned at a `
          + 'fixed height would float a third of a metre over a crouching body');

      // The one that a sign error breaks, over a grid of body yaws and camera bearings. The
      // plate's normal is +Z rotated by its world yaw; it has to point AT the camera, which is
      // a dot product and not an angle comparison, so a half-turn cannot hide in a wrap.
      const worst = [];
      for (let by = -Math.PI; by < Math.PI; by += Math.PI / 7) {
        for (let cb = -Math.PI; cb < Math.PI; cb += Math.PI / 11) {
          const a = avatar(by, 0, 2, -3);
          const d = 9;
          const c = cam(2 + Math.sin(cb) * d, -3 + Math.cos(cb) * d);
          const pl = run(a, c);
          const wy = a.group.rotation.y + pl.rotation.y;
          // Normal, and the unit vector from the plate to the camera.
          const nx = Math.sin(wy);
          const nz = Math.cos(wy);
          worst.push(nx * Math.sin(cb) + nz * Math.cos(cb));
        }
      }
      const min = Math.min(...worst);
      okJ(min > 1 - 1e-9,
          'and it turns to face the camera from every body yaw, not only from behind',
          `over ${worst.length} yaw and bearing pairs the plate normal points at the camera to `
          + `within ${((1 - min) * 1e9).toFixed(2)}e-9 — the group's own yaw is subtracted back `
          + 'out, and a sign slip there reads as "the rank is invisible sometimes"');

      const near = run(avatar(0, 0, 0, 0), cam(0, PLATE.CULL - 1)).visible;
      const far = run(avatar(0, 0, 0, 0), cam(0, PLATE.CULL + 1)).visible;
      // px per world unit on 1080p at the game's FOV, which is what sets the number.
      // FOV is a player SETTING (client/src/settings.js defaults it to 85) rather than a
      // shared constant, so the default is read out of there instead of restated as a number.
      const fovJ = Number(/ fov: (\d+),/.exec(readFileSync('client/src/settings.js', 'utf8'))?.[1]);
      const px = (d) => (1080 / (2 * d * Math.tan((fovJ * Math.PI) / 360))) * PLATE.H;
      okJ(near && !far,
          'a body past the cull distance draws nothing, because there is nothing left to read',
          `drawn at ${PLATE.CULL - 1}u and not at ${PLATE.CULL + 1}u, where the whole plate is `
          + `${px(PLATE.CULL).toFixed(1)} pixels tall on a 1080p screen and a mark is under two`);

      const off = avatar(0, 0);
      off.plateOn = false;
      okJ(run(off, cam(0, 4)).visible === false,
          'and a rank that draws nothing is hidden outright rather than drawn blank',
          'a Private is tier 0 and gets no plate at all — the same omit-at-zero decision '
          + 'snapshotBase makes on the wire, made again on the side that draws it');

      // The NaN above turns every check red without saying why, and the why is the only thing
      // a throw carries that a wrong number does not.
      okJ(threw.length === 0, 'and the lifted body ran clean on every one of those calls',
          threw.length ? `THREW ON ${threw.length} of them — first: ${threw[0]}`
            : 'no throw over the crouch sweep, the yaw grid and both cull distances');
    }
});

// ─────────────────────────────── the devices, and what tells them apart
driveJ('the plate devices', () => {
    // `deviceOf` is the whole of the redesign — "real rank doesnt look like that! it look
    // ass!" — so it is LIFTED and every tier is run through it, rather than the mapping
    // being restated here where a copy could agree with a source that had changed.
    //
    // What the OLD strip guaranteed and this no longer does: one mark, one fixed width, for
    // every rank. That was measured here and it was the wrong thing to measure — it is why a
    // sergeant major came out as six identical bars in a row and a colonel as three oak
    // leaves, neither of which is a rank anybody wears. Real insignia is not a count of
    // identical marks; it is a family (cloth patch or metal pin) carrying a SHAPE. So the
    // properties below are the ones the new drawing actually promises.
    const dev = liftFn(insJ, 'deviceOf', ['band', 'pips'],
      `const GOLD = 'GOLD', SILVER = 'SILVER';`);
    const fw = liftFn(insJ, 'fieldWidth', ['dev'],
      `const FIELD_H = ${PLATE.H}, FIELD_W1 = ${constJ('FIELD_W1')}, `
      + `FIELD_W_STEP = ${constJ('FIELD_W_STEP')}, FIELD_W_MAX = ${PLATE.W_MAX};`);
    if (!dev || !fw) return;

    const RANKED = TIERS.map((t, i) => ({ ...t, i }));
    const devs = RANKED.map((t) => ({ ...t, d: dev(t.band, t.pips) }));

    // 1. Every device resolves to something drawable, with nothing falling through. A stack
    //    needs at least one mark; a row needs a glyph that PINS actually has.
    const pins = new Set([...(/\nconst PINS = \{([\s\S]*?)\n\};/.exec(insJ)?.[1] ?? '')
      .matchAll(/\n  (\w+)\(c\) \{/g)].map((m) => m[1]));
    const undrawable = devs.filter(({ d }) => (d.stack
      ? !(d.chev > 0 || d.rock > 0 || d.star > 0)
      : !(d.n > 0 && pins.has(d.glyph))));
    okJ(pins.size > 0 && undrawable.length === 0,
        'every rank on the ladder resolves to a device that can actually be drawn',
        undrawable.length
          ? `NOTHING TO DRAW FOR ${undrawable.map((t) => t.abbr).join(', ')}`
          : `pins: ${[...pins].join(', ')} — Private has its recruit shield and the remaining `
            + 'enlisted tiers use stacked cloth, so no rank falls back to a default shape');

    // 2. No two ranks draw the same badge. This is the property the whole insignia exists for
    //    and the one the old design broke twice — CPT drew three bars where a captain wears
    //    two, and COL drew three oak leaves where a colonel wears an eagle, so each collided
    //    with the tier below it. Colour counts as a difference: gold against silver at the
    //    same shape is a warm/cool comparison, which survives being eight pixels tall in a
    //    way that counting edges does not.
    const keyOf = (d) => (d.stack
      ? `stack ${d.chev}/${d.rock}/${d.star}`
      : `row ${d.glyph} x${d.n} ${d.metal}`);
    const seen = new Map();
    const clash = [];
    for (const t of devs) {
      const k = keyOf(t.d);
      if (seen.has(k)) clash.push(`${t.abbr} == ${seen.get(k)} (${k})`);
      else seen.set(k, t.abbr);
    }
    okJ(clash.length === 0, 'and no two of them draw the same badge, so the rank IS the badge',
        clash.length ? `COLLISION: ${clash.join('; ')}`
          : `${seen.size} distinct devices over ${devs.length} ranks — including the two pairs `
            + 'that differ by metal alone, 2LT/1LT and MAJ/LTC');

    // 3. One HEIGHT for every badge. aimPlate clears the crown with a constant, so a badge
    //    that changed height with the rank would sit on one player's skull and float over
    //    another's — and the taller badge would read as the bigger rank rather than the
    //    higher one. Only the WIDTH follows the device, and it has to stay inside the body
    //    it hangs over or a general's stars are wider than the general.
    const widths = devs.map((t) => fw(t.d));
    const px = (u) => (1080 / (2 * PLATE.CULL / 2 * Math.tan((85 * Math.PI) / 360))) * u;
    okJ(Math.max(...widths) <= PLATE.W_MAX + 1e-9 && Math.max(...widths) < C.PLAYER_HALF_W * 2,
        'every badge is the same height, and the widest still fits over the body wearing it',
        `all ${PLATE.H}u tall = ${px(PLATE.H).toFixed(1)}px at ${PLATE.CULL / 2}m; widths `
        + `${Math.min(...widths).toFixed(3)}..${Math.max(...widths).toFixed(3)}u against a `
        + `${(C.PLAYER_HALF_W * 2).toFixed(2)}u body`);

    // 4. The stack is the enlisted family and it must not run away with itself. Real chevrons
    //    stop at three and rockers at three; the star and the wreath in the void are what
    //    carry the top two tiers. Six marks is the most any badge asks anyone to see, and it
    //    is the count that the pitch below was solved for.
    const most = Math.max(...devs.filter((t) => t.d.stack)
      .map(({ d }) => d.chev + d.rock + Math.min(1, d.star)));
    okJ(most <= 7, 'and no cloth badge stacks more marks than its own height can resolve',
        `worst ${most} marks — three chevrons, three rockers and a device in the void, which `
        + 'is exactly what a sergeant major wears');
});

// ─────────────────────────────── one drawing, two consumers
//
// The scoreboard wears the rank device now — "not text RANK but its RANK logo" — and the
// comment it replaced was not wrong about the risk: an insignia drawn a second time for a
// table is a second thing that can disagree with the plate over the player's head, and it
// would disagree quietly, in a game where the two are never on screen together.
//
// The answer is structural rather than careful. insignia.js owns the drawing and knows nothing
// about where it lands; render.js wraps the canvas in a texture and hud.js encodes the same
// canvas as a PNG. So the checks here are about the SHAPE of that arrangement: that the drawing
// exists in exactly one file, and that both consumers reach for it rather than for a copy.
{
  const idxJ0 = readFileSync('client/index.html', 'utf8');
  const drawn = (src) => /function (stackTex|rowTex)\(/.test(src) || /const PINS = \{/.test(src);
  okJ(drawn(insJ) && !drawn(rdJ) && !drawn(hudJ),
      'the rank device is drawn in exactly one file, and neither consumer holds a copy of it',
      `insignia.js draws it; render.js is ${rdJ.split('\n').length} lines and hud.js `
      + `${hudJ.split('\n').length}, and neither contains stackTex, rowTex or PINS — a second `
      + 'drawing is the one bug this whole arrangement exists to make impossible');

  okJ(/import \{ insigniaCanvas, FIELD_H \} from '\.\/insignia\.js';/.test(rdJ)
      && /import \{ insigniaPng \} from '\.\/insignia\.js';/.test(hudJ)
      && /export function insigniaCanvas\(tier\)/.test(insJ)
      && /export function insigniaPng\(tier\)/.test(insJ),
      'and both of them import it: the world plate as a canvas, the scoreboard as a PNG',
      'one export each and no THREE inside insignia.js, which is what lets the same drawing '
      + 'be a GPU texture over a head and a background-image in a table cell');

  const bareIns = insJ
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
  // THE BOX THE DEVICE LANDS IN, against the bounds of the drawing itself. `contain` fits the
  // image inside the box without cropping it, which means a box narrower than the widest
  // device's aspect clamps that device by WIDTH and draws it shorter than every other rank —
  // and the rank it would shrink is the five-star General of the Army, the one that must not
  // come out smaller than a corporal's. One height for every badge is the promise the plate
  // makes and the reason fieldWidth has a ceiling; this is the same promise in a table cell.
  const boxM = /#board td\.rank \.rki \{[\s\S]*?width: (\d+)px; height: (\d+)px;/.exec(idxJ0);
  const boxAspect = boxM ? Number(boxM[1]) / Number(boxM[2]) : NaN;
  const widest = PLATE.W_MAX / PLATE.H;
  okJ(!!boxM && boxAspect >= widest,
      'the scoreboard gutter is wide enough that no rank is clamped, so one height means one height',
      boxM ? `${boxM[1]}x${boxM[2]}px = ${boxAspect.toFixed(2)} against a widest device of `
        + `FIELD_W_MAX/FIELD_H = ${widest.toFixed(2)} — the two numbers in the stylesheet are `
        + 'held against the drawing\u2019s own bounds, so widening a device without widening the '
        + 'cell fails here rather than silently shrinking a general'
        : 'no match — the .rki box was reshaped, so nothing about its aspect is measured');

  okJ(!/\bTHREE\b/.test(bareIns) && !/import .* from 'three'/.test(insJ),
      'the drawing knows nothing about three.js, so nothing about it is renderer-shaped',
      'plateTexOf in render.js is where a canvas becomes a texture; the day this file needs a '
      + 'THREE import is the day it has stopped being a drawing — and this reads the code with '
      + 'the prose taken out, because the header of that file has to be allowed to say the word');

  // ── the PNG itself, against a canvas that records rather than rasterises.
  //
  // insignia.js cannot be imported without a `document`, so one is provided: a 2D context that
  // answers every call the drawing makes and counts them. What is being measured is not the
  // pixels — nothing here can see pixels — but the three promises the scoreboard leans on:
  // every valid rank produces a device, junk does not, and asking twice costs nothing.
  const calls = [];
  const ctx2d = new Proxy({}, {
    get: (_t, k) => (k === 'fillStyle' || k === 'strokeStyle' || k === 'lineWidth'
      || k === 'lineJoin' ? '' : (...a) => { calls.push(`${String(k)}(${a.length})`); }),
    set: () => true,
  });
  const made = [];
  globalThis.document = {
    createElement: () => {
      const cv = {
        width: 0, height: 0,
        getContext: () => ctx2d,
        toDataURL: () => `data:image/png;base64,CV${made.length}`,
      };
      made.push(cv);
      return cv;
    },
    head: { appendChild: () => {} },
  };
  const ins = await import('./client/src/insignia.js');

  const threw = [];
  const png = (t) => {
    try {
      return ins.insigniaPng(t);
    } catch (e) {
      threw.push(`${t}: ${e?.message ?? e}`);
      return undefined;
    }
  };
  const all = TIERS.map((_, t) => png(t));
  const nothing = [999, -1, undefined, null, NaN].map(png);
  const coerced = [1.5, '16'].map(png);
  okJ(!threw.length
      && all.every((e) => e && /^data:image\/png/.test(e.url) && e.h > 0)
      && nothing.every((e) => e === null)
      && coerced[0] === all[1] && coerced[1] === all[16],
      'every rank including Private encodes to a PNG, while junk encodes to nothing',
      threw.length ? `THREW ON ${threw.join('; ')}`
        : `${all.length} devices drawn over ${calls.length} canvas calls, including the recruit `
          + 'shield at tier zero; 999, -1, undefined, null and NaN all come back null, and 1.5 '
          + 'and "16" land on tier 1 and tier 16 rather than anywhere new');

  const drawnCount = made.length;
  const again = TIERS.map((_, t) => png(t));
  okJ(made.length === drawnCount && again.every((e, t) => e === all[t]),
      'and the same rank asked for twice is the same object, drawn once',
      `${drawnCount} canvases for ${TIERS.length} ranks, and a second pass over the whole `
      + 'ladder made none — the board rebuilds while TAB is held, and rasterising a chevron per '
      + 'frame per row is the cost that cache exists to refuse');

  const urls = new Set(all.map((e) => e.url));
  okJ(urls.size === TIERS.length,
      'and no two ranks share a cache entry, so no player wears somebody else\u2019s insignia',
      `${urls.size} distinct entries for ${TIERS.length} ranks — the cache is keyed by tier, `
      + 'which is the only thing the drawing depends on');

  delete globalThis.document;
}

// ─────────────────────────────── tier zero, the dead, and who owns `visible`
{
  const setFn = /\nfunction setAvatarPlate\(a, tier\) \{\n([\s\S]*?)\n\}\n/.exec(rdJ)?.[1] ?? '';
  okJ(/a\.plateOn = tier >= 0;/.test(setFn),
      'a Private wears the invented recruit shield even though the wire omits rk at tier 0',
      'the absent wire field still defaults to zero, while the client gives that real tier a '
      + 'device rather than confusing it with failed artwork');

  // THE latch bug, pinned by absence. setAvatarPlate early-outs on an unchanged rank, so if
  // it also owned `visible` then dying, respawning at the same rank and walking back into
  // view would leave the plate off for the rest of the life.
  okJ(setFn.length > 0 && !/\.visible/.test(setFn),
      'and nothing but aimPlate ever touches plate.visible, so it has one owner per frame',
      'setAvatarPlate early-outs on an unchanged rank; a second owner there means a player '
      + 'who dies and respawns at the same rank never gets their plate back');

  // The dead branch. Anchored to the shield line above it, so this cannot pass on a
  // `visible = false` that lives somewhere else entirely.
  const dead = /setAvatarShield\(a, false\); \/\/ a corpse([\s\S]{0,400})/.exec(rdJ)?.[1] ?? '';
  okJ(/a\.plate\.visible = false;/.test(dead),
      'a corpse wears no rank, however it landed',
      'the badge is turned off on the line under the spawn ring, because an upright plate '
      + 'over a body toppled onto its back is the same class of bug that block exists to fix');
}

// ─────────────────────────────── the readout in the corner, lifted and run
driveJ('the rank readout', () => {
    const m = /\n    rank\(career\) \{\n([\s\S]*?)\n    \},\n/.exec(hudJ);
    okJ(!!m, 'the HUD rank readout is still where this suite looks for it',
        m ? `lifted ${m[1].split('\n').length} lines` : 'no match — hud.rank was reshaped');
    if (m) {
      const out = {};
      const els = {
        rkName: { set textContent(v) { out.name = v; } },
        rkNext: { set textContent(v) { out.next = v; } },
        rank: { classList: { add(c) { out.cls = c; } } },
      };
      const body = new Function('career', 'els', 'TIERS', 'MAX_TIER', 'rankOf', 'toNextRank',
        `let shownCareer = -1;\n${m[1]}`);
      // Same reasoning as the plate: dropping the top-of-ladder guard does not print the wrong
      // rank, it throws on TIERS[21].name, and that has to land on the check below rather than
      // on the exit code. A throw leaves `out` untouched, so the boundary sweep reads undefined
      // and fails on its own; `read` returns null so the string checks cannot be satisfied by
      // whatever a placeholder happened to spell.
      const threw = [];
      const say = (cv) => {
        try {
          body(cv, els, TIERS, MAX_TIER, rankOfXp, toNextRankXp);
          return true;
        } catch (e) {
          threw.push(`${cv}: ${e?.message ?? e}`);
          return false;
        }
      };
      const read = (cv) => {
        out.name = out.next = out.cls = undefined;
        return say(cv) ? `${out.name} · ${out.next}` : null;
      };

      const fresh = read(0);
      okJ(fresh === `Private · ${XP_TIERS[1].at} XP to ${TIERS[1].name}` && out.cls === 'on',
          'the corner names your rank and how far the next one is',
          `"${fresh}" — this is the only place the NAMES appear, because twenty-one of them are `
          + 'unreadable at the four pixels a plate gets in a fight, and the only place the '
          + 'distance appears at all: a bare label gives a player nothing to play toward');

      const top = read(XP_TIERS[MAX_TIER].at + 500);
      okJ(top !== null && !/undefined|NaN/.test(top) && top !== fresh,
          'and the top of the ladder reads as the top, not as a distance to a rank above it',
          `"${top}" — TIERS[tier + 1] is off the end of the table there, and the unguarded `
          + 'version of this line puts the word undefined in the corner of the screen');

      // Every threshold and every step either side of it, against the shared table. The corner
      // and the plate reading different ranks for the same career is the one failure
      // shared/ranks.js exists to prevent, and this is the corner half of it.
      const wrong = [];
      for (let i = 0; i <= MAX_TIER; i++) {
        for (const cv of [XP_TIERS[i].at - 1, XP_TIERS[i].at, XP_TIERS[i].at + 1]) {
          if (cv < 0) continue;
          out.name = undefined;
          say(cv);
          if (out.name !== TIERS[rankOfXp(cv)].name) wrong.push(`${cv}→${out.name}`);
        }
      }
      okJ(wrong.length === 0,
          'and it agrees with rankOf on every boundary and both steps around it',
          wrong.length ? `DISAGREES AT ${wrong.slice(0, 6).join(', ')}`
            : `${(MAX_TIER + 1) * 3 - 1} careers checked against the shared table, which is the `
              + 'same function the plate over the head reads');

      okJ(threw.length === 0, 'and the readout ran clean on every career it was handed',
          threw.length ? `THREW ON ${threw.length} of them — first: ${threw[0]}`
            : 'no throw from a fresh career to five hundred past the top of the ladder');
    }

    // The scoreboard rank gutter, as the two lifted pieces that build it: the merge that picks
    // WHICH tier a row wears, and the cell that turns that tier into the device. `rk` arrives on
    // BOTH wires — MSG.ROSTER carries it per career and the snapshot carries it per tick — so the
    // merge is worth a check of its own, and an index the client's table does not have still has
    // to come out blank rather than as the word undefined.
    const gut = /\n\s*const tier = (who[^\n]*);/.exec(hudJ);
    okJ(!!gut, 'the scoreboard rank gutter is still where this suite looks for it',
        gut ? gut[1].replace(/\s+/g, ' ') : 'no match — the gutter was rewritten');
    const insigniaFn = liftFn(hudJ, 'insigniaCell',
        ['tier', 'insigniaPng', 'esc', 'TIERS', 'insHave', 'document'], 'let insSheet = null;');
    const rankFn = liftFn(hudJ, 'rankCell',
        ['tier', 'MAX_TIER', 'TIERS', 'insigniaCell', 'esc']);
    if (gut && insigniaFn && rankFn) {
      const tierOf = new Function('who', 'p', `return ${gut[1]};`);
      // A stand-in for the drawing: the real one is run a few blocks up against a stubbed
      // canvas. What is measured here is the gutter's own decisions, and those are the same
      // whether the device is 40 bytes or 4 kilobytes.
      const pngFake = (v) => {
        const t = v | 0;
        return t < 0 || t >= TIERS.length ? null : { url: `data:image/png;base64,R${t}` };
      };
      const doc = { createElement: () => ({ sheet: { insertRule: () => {} } }), head: { appendChild: () => {} } };
      const id = (x) => String(x);
      const insignia = (tier) => insigniaFn(tier, pngFake, id, TIERS, new Set(), doc);
      const cellOf = (who, p) => rankFn(tierOf(who, p), MAX_TIER, TIERS, insignia, id);

      // THE MERGE, and which wire wins. Both numbers come off `rankOf` on the same career, so
      // they agree in every ordinary case — but the roster is the message that carries who
      // somebody IS, and the snapshot's copy exists for the plate. The precedence has to be
      // the roster, and the fallback has to exist: there is one tick between a join bumping
      // the revision and the push going out, and a board opened inside it would be rankless.
      okJ(tierOf({ rk: 20 }, { rk: 3 }) === 20 && tierOf(undefined, { rk: 20 }) === 20
          && cellOf({ rk: 20 }, { rk: 3 }).includes('t20'),
          'the roster outranks the snapshot for the gutter, and the snapshot is still the fallback',
          `roster 20 over snapshot 3 → tier ${tierOf({ rk: 20 }, { rk: 3 })}, no roster row at all `
          + `→ tier ${tierOf(undefined, { rk: 20 })}, which the cell wears as `
          + `${cellOf({ rk: 20 }, { rk: 3 })}`);

      // A throw is reported as the text it would have rendered, because that is what it costs:
      // an exception thrown building one row takes the whole scoreboard, not one gutter.
      const bad = [];
      const junkish = (out) => out.some((s2) => /undefined|NaN|null/.test(s2));
      const shown = (rk) => {
        try {
          return cellOf(undefined, { rk });
        } catch (e) {
          bad.push(`${rk}: ${e?.message ?? e}`);
          return `${e?.message ?? e}`;
        }
      };
      const edge = [999, -1, 0, undefined, null].map((v) => shown(v));
      const coerced = [1.5, '16'].map((v) => shown(v));
      okJ(!bad.length
          && edge.slice(1).every((s2) => /class="rki t0"/.test(s2))
          && edge[0].includes(`class="rki t${MAX_TIER}"`)
          && coerced[0].includes('class="rki t1"') && coerced[1].includes('class="rki t0"')
          && !junkish([...edge, ...coerced, shown(20)])
          && shown(20).includes(TIERS[20].name) && !shown(20).includes('<b'),
          'every player has one visible rank insignia and no redundant abbreviation',
          bad.length ? `THREW ON ${bad.join('; ')}`
          : `tier 20 shows ${shown(20)}; Private shows ${shown(0)} — the full name remains `
          + 'in the icon tooltip');
    }
});

// ─────────────────────────────── the wire, on the two legs Part H does not cover
driveJ('the wire', () => {
    const selfBlob = /msg\.self = p\n\s*\? \{([\s\S]*?)\n\s*\}\n\s*: null;/.exec(idxJ)?.[1] ?? '';
    okJ(/\n\s*cv: p\.career,/.test(selfBlob) && !/cv: r3\(/.test(selfBlob),
        'the owner is sent their raw career, and it never goes through r3 on the way',
        selfBlob.includes('cv: p.career')
          ? 'a career is a whole number of kills; rounding an integer only invites the next '
            + 'reader to make it a float, which is exactly what the stamina beside it survived'
          : `no cv in the self blob — the HUD would have nothing to count from`);

    // And that a tier survives interpolation. interp.js spreads the newer snapshot before
    // re-lerping the continuous fields, so a discrete value rides through — but "rides
    // through" is a claim about a spread that a later edit can quietly enumerate away.
    const interp = createInterpolator();
    const snap = (rk, x) => ({ players: [{ id: 1, x, y: 1, z: 0, yaw: 0, pitch: 0, a: 1, rk }] });
    interp.push(snap(16, 0), 0);
    interp.push(snap(17, 4), 50);
    const mid = interp.sample(C.INTERP_DELAY_MS + 25)?.get(1);
    okJ(mid && mid.rk === 17 && Number.isInteger(mid.rk) && mid.x > 0 && mid.x < 4,
        'and a tier rides through interpolation as a tier while the body is still being lerped',
        mid ? `rk ${mid.rk} at x ${mid.x.toFixed(2)} between 0 and 4 — snapping a rank at 20Hz `
          + 'is right for a value that changes a few times a career, and a lerped one would '
          + `read as ${((16 + 17) / 2).toFixed(1)}, which is not a rank`
          : 'the interpolator returned nothing for the player');
});

console.log([...pJ, ...fJ].join(String.fromCharCode(10)));


// ────────────────────────────────── Part K: the badges, and the kill that shows one
//
// "i dont even know if we headshot someone ... maybe something like badge that levels up
// overtime like headshot kill badge, kill badge, knife pistol whatever badges ... so each
// kill it shows your badge."
//
// Three layers, and each can break without the other two noticing.
//
//   shared/badges.js is the table both ends read, and it throws at IMPORT for most of what
//   could be wrong with it — so the checks here are deliberately the ones that loop cannot
//   make: that a weapon track's label still comes FROM the weapon table rather than being
//   restated beside it, that no two tracks draw the same card, and that the loop itself has
//   not been deleted by the same edit that broke what it guards.
//
//   The Room is where a kill becomes a count, inside the guard the career increment already
//   sits in. The interesting half is what must NOT move: a body shot may not touch the
//   headshot track, and a kill credited to nobody may not touch anything at all while STILL
//   putting the zone on the wire — the killfeed is public, the ledger is not.
//
//   The client counts nothing. It diffs two authoritative snapshots, and the whole promotion
//   mechanic hangs off that diff firing exactly once per threshold crossed. main.js and
//   hud.js cannot be imported, so both are lifted out as text the way Part J lifts the plate.
console.log('\n=== Part K — the badges ===\n');

const pK = [];
const fK = [];
const okK = (cond, label, detail = '') => {
  (cond ? pK : fK).push(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const KILLABLE = WEAPON_IDS.filter((id) => !isUtil(id));

/** Run a block that drives lifted client code, and turn a throw into a red check rather
 *  than into an exit code — Part J's `driveJ`, for the reason it gives there. */
const driveK = (what, fn) => {
  try {
    fn();
  } catch (e) {
    okK(false, `${what} could not be driven at all`,
        `threw: ${e?.message ?? e} — a lifted function that throws is a regression in the `
        + 'source it came out of, and it is reported here rather than allowed to end the run');
  }
};

// ─────────────────────────────── the table
{
  okK(TIER_NAMES.length === 5 && MAX_BADGE_TIER === 5 && new Set(TIER_NAMES).size === 5
      && MAX_LEVEL === 10 && MAX_STEP === 50,
      'five badges, ten levels inside each, fifty steps in a ladder',
      `${TIER_NAMES.join(' → ')} — and ${MAX_STEP} steps, because "the max of badge level is `
      + '10 so the requirements can be like high sky"');

  // The expected count is derived from the arsenal rather than written down, so adding a
  // weapon moves this check instead of leaving it passing against a stale twelve.
  okK(TRACK_KEYS.length === KILLABLE.length + SPECIAL_KEYS.length,
      'one track per killable weapon, plus the two that are not a weapon',
      `${TRACK_KEYS.length} tracks = ${KILLABLE.length} weapons that can kill + `
      + `${SPECIAL_KEYS.join('/')} — and ${WEAPON_IDS.length - KILLABLE.length} util weapons `
      + 'with no track, because a flashbang has never killed anybody');

  const missing = KILLABLE.filter((id) => !BADGES[id]);
  const spurious = WEAPON_IDS.filter((id) => isUtil(id) && BADGES[id]);
  okK(missing.length === 0 && spurious.length === 0,
      'and the two sets are exactly each other, not merely the same size',
      missing.length || spurious.length
        ? `missing: ${missing.join(', ') || 'none'}; spurious: ${spurious.join(', ') || 'none'}`
        : 'a weapon added without a badge would show no card while every other one does, '
          + 'which is a silence rather than an error');

  // The card is the only place a track is named, so two tracks that print the same words
  // are two tracks a player cannot tell apart — and one of them will look broken.
  const labels = TRACK_KEYS.map((k) => labelOf(k));
  okK(new Set(labels).size === labels.length && labels.every((l) => l.length > 0),
      'no two tracks print the same label, and none prints an empty one',
      labels.join(' / '));

  // Labels come from the weapon table, and the check is on the SOURCE as well as the values:
  // a restated label that happens to match today passes any value comparison and then
  // silently disagrees the first time a weapon is renamed.
  const bdSrc = readFileSync(new URL('./shared/badges.js', import.meta.url), 'utf8');
  const rows = /export const BADGES = \{([\s\S]*?)\n\};/.exec(bdSrc)?.[1] ?? '';
  const restated = KILLABLE.filter((id) => new RegExp(`\\n  ${id}:[^\\n]*label:`).test(rows));
  const fromTable = KILLABLE.filter((id) => labelOf(id) === WEAPONS[id].label);
  okK(rows.length > 0 && restated.length === 0 && fromTable.length === KILLABLE.length,
      'a weapon badge takes its name from the weapon table instead of restating it',
      restated.length ? `restated on: ${restated.join(', ')}`
        : `all ${KILLABLE.length} read WEAPONS[key].label — lmg prints `
          + `"${labelOf('lmg')}", which is where the weapon strip gets it too`);

  const notOne = TRACK_KEYS.filter((k) => BADGES[k].at[0] !== 1);
  okK(notOne.length === 0,
      'every track begins at one, so no kill is ever unbadged',
      notOne.length ? notOne.map((k) => `${k}@${BADGES[k].at[0]}`).join(', ')
        : '"so each kill it shows your badge" is only true if the first kill on a track '
          + 'already has a step to show — your first knife kill makes you a knife Marksman 1');

  // THE CHECK THAT MAKES GENERATING SIX HUNDRED NUMBERS SAFE. The table states twelve
  // ceilings and derives the rest from one authored curve, which is the only way twelve
  // fifty-step ladders are reviewable at all — but a curve is only as good as the numbers
  // that come out of it, so every step of every track is checked rather than a sample. A
  // rounding collision would leave a level that no count can ever be on.
  const bad = TRACK_KEYS.filter((k) => {
    const at = BADGES[k].at;
    return at.length !== MAX_STEP
      || at.some((n, i) => !Number.isInteger(n) || (i > 0 && n <= at[i - 1]));
  });
  okK(bad.length === 0,
      `and ${MAX_STEP} strictly increasing whole numbers on each of them`,
      bad.length ? bad.map((k) => `${k}: ${BADGES[k].at.join(' ')}`).slice(0, 2).join('; ')
        : `${TRACK_KEYS.length * MAX_STEP} generated thresholds, all integers and all `
          + 'distinct — the generator floors each step at the one below it, so a low ceiling '
          + `like ${labelOf('knife')} (${BADGES.knife.top}) cannot round two steps together`);

  const offTop = TRACK_KEYS.filter((k) => BADGES[k].at[MAX_STEP - 1] !== BADGES[k].top);
  const hardest = TRACK_KEYS.reduce((a, b) => (BADGES[a].top > BADGES[b].top ? a : b));
  const easiest = TRACK_KEYS.reduce((a, b) => (BADGES[a].top < BADGES[b].top ? a : b));
  okK(offTop.length === 0,
      'and each one ends exactly on the ceiling it states, not near it',
      offTop.length
        ? offTop.map((k) => `${k} ends ${BADGES[k].at[MAX_STEP - 1]} not ${BADGES[k].top}`).join(', ')
        : `${labelOf(hardest)} tops out at ${BADGES[hardest].top.toLocaleString('en-US')}, `
          + `${labelOf(easiest)} at ${BADGES[easiest].top} — the stated ceiling is the one `
          + 'number a person reviewing this table actually reads, so it has to be the truth');

  // The pacing the whole redesign is for: "if you get it easy then i dont think i can flex
  // that if someone can just take few hours to get those". Asserted on the real save file's
  // count so it cannot quietly regress back to a ladder an evening clears.
  const s108 = stepOf(108, 'kills');
  const b108 = badgeOf(s108);
  okK(b108 === 2 && BADGES.kills.top === 15000,
      'and 108 kills is early Sharpshooter, not most of the way up the ladder',
      `108 → ${tierName(b108)} ${levelOf(s108)}, step ${s108} of ${MAX_STEP}; the old five-tier `
      + `table read that same count as Expert 3-of-5. The top is now `
      + `${BADGES.kills.top.toLocaleString('en-US')}, which is ~190 hours at the ~80 kills/hour `
      + 'this gets played at');

  // The import-time loop is what makes all of the above true for a weapon added NEXT year,
  // when nobody is reading this file. It is the check that has to survive being tidied away.
  const guards = /for \(const id of WEAPON_IDS\) \{[\s\S]*?can kill but has no badge track/.test(bdSrc)
    && /for \(const key of TRACK_KEYS\) \{[\s\S]*?not strictly increasing integers/.test(bdSrc)
    && /tops out at .*?not its stated/.test(bdSrc);
  okK(guards, 'the table still checks itself at import, where the dev server hits it too',
      guards ? 'a weapon added with no badge, or a ceiling the curve misses, fails loudly at '
        + 'boot instead of quietly at play — and it has to, because the thresholds are generated'
        : 'the invariant loops are gone — every check above now only covers today\'s table');
}

// ─────────────────────────────── stepOf, its decomposition, and toNextStep
{
  // Exhaustive over every place stepOf changes its answer, on all twelve tracks.
  const off = [];
  for (const key of TRACK_KEYS) {
    const at = BADGES[key].at;
    at.forEach((n, i) => {
      if (stepOf(n, key) !== i + 1) off.push(`${key}@${n} gave ${stepOf(n, key)} not ${i + 1}`);
      if (stepOf(n - 1, key) !== i) off.push(`${key}@${n - 1} gave ${stepOf(n - 1, key)} not ${i}`);
    });
  }
  okK(off.length === 0,
      'reaching the number IS the step, on every threshold of every track',
      off.length ? off.slice(0, 4).join('; ')
        : `${TRACK_KEYS.length * MAX_STEP * 2} boundary points exact — an exclusive comparison `
          + 'here would make the 60th kill say "1 to go" and the 61st promote you, which reads '
          + 'as an off-by-one every single time');

  // THE DECOMPOSITION IS THE MECHANIC THE USER ASKED FOR: "the first badge has levels first
  // level of it needs this amount up to 10 then once you reach the level 10 next is promotion
  // to another badge". One monotone step carries both, so the store and the wire never have
  // to hold two numbers that could disagree — which only works if it splits back exactly.
  const dec = [];
  for (let s = 1; s <= MAX_STEP; s++) {
    const b = badgeOf(s);
    const l = levelOf(s);
    if (b < 1 || b > MAX_BADGE_TIER) dec.push(`step ${s} gave badge ${b}`);
    if (l < 1 || l > MAX_LEVEL) dec.push(`step ${s} gave level ${l}`);
    if ((b - 1) * MAX_LEVEL + l !== s) dec.push(`step ${s} split to ${b}/${l}`);
  }
  const zeroSplit = badgeOf(0) === 0 && levelOf(0) === 0;
  okK(dec.length === 0 && zeroSplit,
      `every one of the ${MAX_STEP} steps splits into a badge and a level and back again`,
      dec.length ? dec.slice(0, 4).join('; ')
        : `step 1 is ${tierName(badgeOf(1))} ${levelOf(1)}, step 10 is ${tierName(badgeOf(10))} `
          + `${levelOf(10)}, step 11 is ${tierName(badgeOf(11))} ${levelOf(11)}, step ${MAX_STEP} `
          + `is ${tierName(badgeOf(MAX_STEP))} ${levelOf(MAX_STEP)}; step 0 splits to 0/0, which `
          + 'is how a track nobody has scored on shows nothing rather than Marksman 0');

  let mono = true;
  for (const key of TRACK_KEYS) {
    let prev = 0;
    for (let n = 0; n <= BADGES[key].top + 50; n++) {
      const s = stepOf(n, key);
      if (s < prev) mono = false;
      prev = s;
    }
  }
  const caps = TRACK_KEYS.every((k) => stepOf(1e9, k) === MAX_STEP && tierOf(1e9, k) === MAX_BADGE_TIER);
  const zeros = TRACK_KEYS.every((k) => stepOf(0, k) === 0 && tierOf(0, k) === 0);
  okK(mono && caps && zeros,
      'a track only climbs, starts below the first step, and tops out instead of running off',
      `monotone over every count from 0 to each ceiling — ${(TRACK_KEYS.reduce((a, k) => a + BADGES[k].top, 0)).toLocaleString('en-US')} `
      + `counts checked one at a time; 0 gives step 0 on all ${TRACK_KEYS.length}; a billion `
      + `gives step ${MAX_STEP}, ${tierName(MAX_BADGE_TIER)} ${MAX_LEVEL}`);

  // `tierOf` is kept as the badge-only reading, for callers that never show a level. It has
  // to agree with the long way round, or two parts of the HUD draw different emblems.
  const agree = TRACK_KEYS.every((k) => [0, 1, 44, 45, 59, 60, 108, 1e6]
    .every((n) => tierOf(n, k) === badgeOf(stepOf(n, k))));
  okK(agree, 'and tierOf is exactly badgeOf(stepOf(...)), so nothing reads the ladder twice',
      'the server and anything that only needs an emblem call the short one; the card calls '
      + 'stepOf once and splits it');

  // Junk has been through a JSON file on disk. It must read as an empty track rather than
  // take a HUD frame or a snapshot down with it.
  const junk = [stepOf(NaN, 'rifle'), stepOf(undefined, 'rifle'), stepOf(null, 'rifle'),
    stepOf('12', 'rifle'), stepOf(-5, 'rifle'), stepOf(40, 'nope'), stepOf(40, undefined)];
  okK(junk.every((t) => t === 0),
      'and junk reads as an empty track rather than throwing',
      `NaN, undefined, null, "12", -5, an unknown key and no key all give ${junk.join('/')}`);

  const nextOff = [];
  for (const key of TRACK_KEYS) {
    const at = BADGES[key].at;
    if (toNextStep(0, key) !== 1) nextOff.push(`${key} from 0 wants ${toNextStep(0, key)}`);
    for (let i = 1; i < at.length; i++) {
      if (toNextStep(at[i] - 1, key) !== 1) nextOff.push(`${key}@${at[i] - 1}`);
      if (toNextStep(at[i - 1], key) !== at[i] - at[i - 1]) nextOff.push(`${key}@${at[i - 1]}`);
    }
    if (toNextStep(at[MAX_STEP - 1], key) !== 0) nextOff.push(`${key} at the top wants ${toNextStep(at[MAX_STEP - 1], key)}`);
    if (toNextStep(at[MAX_STEP - 1] + 999, key) !== 0) nextOff.push(`${key} past the top`);
  }
  okK(nextOff.length === 0,
      'the number on the card counts down to the next step and reads zero only at the top',
      nextOff.length ? nextOff.slice(0, 4).join('; ')
        : 'with fifty steps the next one is always close enough to chase, which is the point '
          + `of printing it — from ${BADGES.kills.at[9]} kills it is `
          + `${toNextStep(BADGES.kills.at[9], 'kills')} more to ${tierName(2)} 1`);

  // Promotion versus level-up on the real ELIMINATIONS numbers, because the two drive
  // different cards: one pops and queues for 2.6 s, the other lights a pip for 1.6 s.
  const promo = (from, to, key = 'kills') => badgeOf(stepOf(to, key)) > badgeOf(stepOf(from, key));
  const lvl = (from, to, key = 'kills') => stepOf(to, key) > stepOf(from, key);
  const kAt = BADGES.kills.at;
  const cross = promo(kAt[9], kAt[10]) && lvl(kAt[9], kAt[10]);
  const inside = !promo(kAt[8], kAt[9]) && lvl(kAt[8], kAt[9]);
  const neither = !promo(kAt[10], kAt[10] + 1) && !lvl(kAt[10], kAt[10] + 1);
  okK(cross && inside && neither,
      'crossing into a new badge is a promotion, a new level inside one is not, and an '
      + 'ordinary kill is neither',
      `${kAt[9]}→${kAt[10]} is ${tierName(1)} ${MAX_LEVEL} → ${tierName(2)} 1, a promotion; `
      + `${kAt[8]}→${kAt[9]} is a level-up and NOT a promotion; ${kAt[10]}→${kAt[10] + 1} is `
      + 'neither. Five promotions per track in a whole career is what makes the pop worth '
      + 'having, and forty-nine level-ups is what makes it worth showing a pip');
}

// ─────────────────────────────── what one kill is worth
{
  const head = tracksFor('rifle', HIT_ZONE.HEAD);
  const body = tracksFor('rifle', HIT_ZONE.BODY);
  const legs = tracksFor('rifle', HIT_ZONE.LEGS);
  okK(head.join() === 'hs,rifle,kills' && body.join() === 'rifle,kills'
      && legs.join() === 'rifle,kills',
      'a headshot earns the headshot track, and the other two zones do not',
      `head ${head.join('+')}; body ${body.join('+')}; legs ${legs.join('+')} — legs are `
      + `worth ${HIT_ZONE_MUL[HIT_ZONE.LEGS]}x and are not an achievement`);

  okK(head[0] === 'hs' && head[head.length - 1] === 'kills',
      'and they come back most specific first, which is the order the card picks in',
      'the running total moves on every kill and so says the least about this one; it is '
      + 'the track shown when nothing more interesting moved');

  const none = tracksFor('', HIT_ZONE.BODY);
  const util = tracksFor('flash', HIT_ZONE.BODY);
  const special = tracksFor('kills', HIT_ZONE.HEAD);
  okK(none.join() === 'kills' && util.join() === 'kills' && special.join() === 'hs,kills',
      'a kill with no weapon, a util weapon, or a track name earns the total and no more',
      `'' gives ${none.join('+')}; flash gives ${util.join('+')}; "kills" gives `
      + `${special.join('+')} — nothing double-counts and nothing invents a weapon`);

  // Every killable weapon has to route to its OWN track. A silent fallback here is how one
  // gun's kills end up on another gun's badge.
  const wrong = KILLABLE.filter((id) => !tracksFor(id, HIT_ZONE.BODY).includes(id));
  okK(wrong.length === 0, 'and each of the ten weapons that can kill earns its own track',
      wrong.length ? wrong.join(', ') : KILLABLE.join(' '));
}

// ─────────────────────────────── a kill out of a real Room
{
  /** One kill, and everything it moved. `duel({ms: 0})` warms and pins without firing, so
   *  the account can be attached before the first shot — a career is only credited to a
   *  player who had one at the moment they pulled the trigger. */
  const oneKill = ({ wep = 'rifle', aim = AIM_HEAD, account = 'acct-k' } = {}) => {
    const r = duel({ wep, ms: 0, pitch: pitchTo(aim) });
    const hook = [];
    r.room.onCareer = (acct, k, b) => hook.push({ acct, k, b: { ...b } });
    if (account) r.A.account = account;
    // Two ticks per pass is one full click, which works the trigger the same way for an
    // automatic weapon and for a semi — and it stops at the FIRST kill, so what is measured
    // is one kill's worth of credit rather than however many fit in a fixed window.
    let guard = 0;
    while (!r.events.some((e) => e.e === EV.KILL) && guard++ < 300) r.trigger(2);
    return {
      kill: r.events.find((e) => e.e === EV.KILL) ?? null,
      badges: { ...r.A.badges },
      victim: { ...r.B.badges },
      career: r.A.career,
      hook,
    };
  };

  const hs = oneKill({ wep: 'rifle', aim: AIM_HEAD });
  okK(hs.kill?.z === HIT_ZONE.HEAD
      && JSON.stringify(hs.badges) === JSON.stringify({ hs: 1, rifle: 1, kills: 1 }),
      'a rifle headshot puts the zone on the wire and moves three tracks',
      `kill ${JSON.stringify(hs.kill)} → ${JSON.stringify(hs.badges)} — the zone is what the `
      + 'killfeed marks and the card colours, and without it the one shot that decided the '
      + 'fight is the only one nothing says anything about');

  const bd = oneKill({ wep: 'rifle', aim: AIM_BODY });
  okK(bd.kill && !('z' in bd.kill)
      && JSON.stringify(bd.badges) === JSON.stringify({ rifle: 1, kills: 1 }),
      'a body shot omits the zone entirely and never touches the headshot track',
      `kill ${JSON.stringify(bd.kill)} → ${JSON.stringify(bd.badges)} — omit-when-zero, the `
      + 'same convention sp, jm and rk already follow, so a client that has never heard of '
      + 'zones reads exactly what it read before');

  const lg = oneKill({ wep: 'pistol', aim: AIM_LEGS });
  okK(lg.kill?.z === HIT_ZONE.LEGS
      && JSON.stringify(lg.badges) === JSON.stringify({ pistol: 1, kills: 1 }),
      'a legs kill is marked on the wire but earns no headshot, and files under its weapon',
      `kill ${JSON.stringify(lg.kill)} → ${JSON.stringify(lg.badges)}`);

  okK(hs.hook.length === 1 && hs.hook[0].acct === 'acct-k' && hs.hook[0].k === 1
      && JSON.stringify(hs.hook[0].b) === JSON.stringify(hs.badges),
      'the room hands the counts out through the one hook it already had for the career',
      `${JSON.stringify(hs.hook)} — one call carrying both rather than a second seam; `
      + 'room.js still never touches the disk');

  okK(JSON.stringify(hs.victim) === '{}' && JSON.stringify(bd.victim) === '{}',
      'and dying moves nothing at all on the player who died',
      'a badge is a count of kills scored, and the only symmetric mistake available here '
      + 'is crediting both ends of one');

  const anon = oneKill({ wep: 'rifle', aim: AIM_HEAD, account: null });
  okK(anon.kill?.z === HIT_ZONE.HEAD && JSON.stringify(anon.badges) === '{}'
      && anon.hook.length === 0 && anon.career === 0,
      'a client with no account still shows the room a headshot and still keeps no ledger',
      `kill ${JSON.stringify(anon.kill)}, badges ${JSON.stringify(anon.badges)}, `
      + `${anon.hook.length} hook call(s) — the killfeed is public and the store is not, `
      + 'which is also what keeps bots out of it');

  // Your own grenade, and falling out of the world. Both arrive through applyDamage — the
  // one door every kill in the game goes through — so both are driven straight at it rather
  // than waiting for the arena to produce them.
  {
    const room = new Room(DEFAULT_MODE);
    const ia = room.add('self', {}, 'acct-self');
    const ib = room.add('faller', {}, 'acct-fall');
    const A = room.players.get(ia);
    const B = room.players.get(ib);
    A.protectedUntil = 0;
    B.protectedUntil = 0;
    room.drainEvents();                       // discard the two join spawns
    const hook = [];
    room.onCareer = (acct, k, b) => hook.push({ acct, k, b: { ...b } });

    room.applyDamage(A, A, 500, indexOf('grenade'), HIT_ZONE.BODY);
    room.applyDamage(null, B, 500, -1, HIT_ZONE.HEAD);
    const dead = room.drainEvents().filter((e) => e.e === EV.KILL);

    okK(dead.length === 2 && hook.length === 0
        && JSON.stringify(A.badges) === '{}' && JSON.stringify(B.badges) === '{}'
        && A.career === 0 && B.career === 0,
        'your own grenade and a fall out of the world are deaths that earn nobody anything',
        `${dead.length} kills on the wire, ${hook.length} hook calls, badges `
        + `${JSON.stringify(A.badges)}/${JSON.stringify(B.badges)} — the same two exemptions `
        + 'the career increment and the spawn shield already share, and they have to stay '
        + 'shared or a player farms their own grenade');

    // `wep: -1` is a kill credited to no weapon. `idAt(-1)` answers 'rifle', which is the
    // right default for a viewmodel and the wrong one for a ledger — so this is the check
    // that the ledger does not go through it.
    A.alive = true; A.hp = C.MAX_HP; A.protectedUntil = 0;
    B.alive = true; B.hp = C.MAX_HP; B.protectedUntil = 0;
    room.applyDamage(A, B, 500, -1, HIT_ZONE.BODY);
    room.drainEvents();
    okK(JSON.stringify(A.badges) === JSON.stringify({ kills: 1 }),
        'and a kill credited to no weapon earns the total, not whatever idAt falls back to',
        `${JSON.stringify(A.badges)} — a fallback here would file it under `
        + `"${idAt(-1)}", a weapon the player may not even be holding`);
  }
}

// ─────────────────────────────── the store, on both shapes the file is allowed to have
{
  // Its own temp path, so nothing here can reach the career the user is actually playing.
  const STORE = join(tmpdir(), `fpsbone-badges-verify-${process.pid}.json`);
  process.env.FPSBONE_RANKS = STORE;
  const wipe = () => {
    for (const f of [STORE, `${STORE}.tmp`]) {
      try { unlinkSync(f); } catch { /* already gone */ }
    }
  };
  process.on('exit', wipe);

  /** A fresh module instance per case: the file is read once, at import — and the path is
   *  captured then too, so a probe's own exit-flush can only ever reach this temp path. */
  let probeK = 0;
  const load = async (text) => {
    wipe();
    if (text !== null) writeFileSync(STORE, text);
    return import(`./server/ranks.js?badges=${probeK++}`);
  };

  // The shape every ranks.json in the world holds today. It has to keep the career and start
  // every badge at zero — there is no honest way to attribute last week's kills to a weapon
  // after the fact, and inventing a distribution is worse than having none.
  const legacy = await load('{"old-hand":93}');
  const before = [legacy.careerOf('old-hand'), JSON.stringify(legacy.badgesOf('old-hand'))];
  legacy.setCareer('old-hand', 94, { hs: 1, rifle: 1, kills: 94 });
  legacy.flush();
  const moved = JSON.parse(readFileSync(STORE, 'utf8'));
  okK(before[0] === 93 && before[1] === '{}'
      && moved['old-hand']?.k === 94 && moved['old-hand']?.b?.rifle === 1,
      'a bare-number career loads as itself, and the first kill migrates the file in place',
      `93 loaded with ${before[1]} badges, then wrote ${JSON.stringify(moved)} — the career `
      + 'carried across rather than reset, which is the one thing this change could have '
      + 'cost a player who already had one');

  const v2 = await load('{"a":{"k":40,"b":{"hs":12,"rifle":25}}}');
  const round = [v2.careerOf('a'), JSON.stringify(v2.badgesOf('a'))];
  v2.setCareer('a', 41, { hs: 13, rifle: 25, kills: 41 });
  v2.flush();
  const back = JSON.parse(readFileSync(STORE, 'utf8'));
  okK(round[0] === 40 && round[1] === '{"hs":12,"rifle":25}'
      && back.a.k === 41 && back.a.b.hs === 13 && back.a.b.kills === 41,
      'and the new shape round-trips through a write and a read unchanged',
      `read ${round[1]}, wrote ${JSON.stringify(back.a)}`);

  // Keys INSIDE an account come from whatever was last written to a file on disk — the same
  // unverified surface MAX_ACCOUNTS exists for, one level down. An unbounded key set that
  // gets written back out and read in again is unbounded forever.
  const junk = await load('{"j":{"k":5,"b":{"hs":3,"bogus":99,"pistol":-2,"smg":"x","lmg":null}},'
    + '"noK":{"b":{"hs":1}},"arr":[1,2],"neg":{"k":-1},"str":"nope"}');
  const kept = junk.badgesOf('j');
  okK(JSON.stringify(kept) === '{"hs":3}' && junk._stats().size === 1
      && junk.careerOf('noK') === 0,
      'unknown badge keys and unusable counts are dropped on the way in, not on the way out',
      `hs/bogus/pistol/smg/lmg reduced to ${JSON.stringify(kept)}; of j, noK, arr, neg and `
      + `str only ${junk._stats().size} account survived — a record needs a finite `
      + 'non-negative `k` or it is not a career');

  const noB = await load('{"z":{"k":7}}');
  noB.setCareer('z', 8);
  noB.flush();
  const thin = readFileSync(STORE, 'utf8');
  okK(thin === '{"z":{"k":8}}',
      'an account with no badges yet writes no badge object at all',
      `${thin} — most accounts on a fresh upgrade have none, and eight bytes each across `
      + 'five thousand of them is worth not spending');

  // A Room is handed a COPY of the counts and increments it for a whole match. Two windows
  // on one account, or a reconnect that raced a flush, is how a stale copy comes back — and
  // it must not be able to walk a count backwards.
  const mono = await load('{"m":{"k":50,"b":{"hs":20,"rifle":30}}}');
  const handed = mono.badgesOf('m');
  handed.hs = 999;
  const afterMut = JSON.stringify(mono.badgesOf('m'));
  mono.setCareer('m', 10, { hs: 5, rifle: 31 });
  const guarded = JSON.stringify(mono.badgesOf('m'));
  okK(afterMut === '{"hs":20,"rifle":30}' && mono.careerOf('m') === 50
      && guarded === '{"hs":20,"rifle":31}',
      'the store hands out a copy, and every count only ever climbs — per key',
      `mutating what badgesOf returned left ${afterMut}; a stale blob claiming hs 5 and `
      + `career 10 left ${guarded} at career ${mono.careerOf('m')}, so the one track that `
      + 'really did move still moved');

  wipe();
  delete process.env.FPSBONE_RANKS;
}

// ─────────────────────────────── the diff the client shows a card from
//
// The client counts nothing: it diffs two authoritative snapshots. So the only thing that can
// be wrong here is the diff, and the two ways it goes wrong are both silent. Baselining
// against zero fires twelve promotion cards at a returning player for kills they scored last
// week; not baselining at all shows nothing on a first-ever kill.
driveK('the badge diff', () => {
  const mainK = readFileSync(new URL('./client/src/main.js', import.meta.url), 'utf8');
  const grabK = (re, what) => {
    const m = re.exec(mainK);
    okK(!!m, `${what} is still where this suite looks for it in main.js`,
        m ? `lifted ${m[0].trim().split('\n').length} lines` : 'no match — renamed or reshaped');
    return m ? m[0] : '';
  };
  const src = grabK(/const cardRank = [^\n]+\n/, 'the card order')
    + grabK(/function foldBadges\(bd\) \{[\s\S]*?\n\}\n/, 'foldBadges')
    + grabK(/function showBadges\(now\) \{[\s\S]*?\n\}\n/, 'showBadges');

  const shown = [];
  const chimed = [];
  const mkSim = () => new Function('TRACK_KEYS', 'stepOf', 'badgeOf', 'levelOf', 'hud', 'audio', `
    let badgeCounts = null;
    let badgeCards = [];
${src}
    return {
      // Exactly the two lines main.js runs where it folds the private self blob.
      fold: (bd) => {
        if (badgeCounts === null) badgeCounts = { ...(bd ?? {}) };
        else foldBadges(bd ?? {});
      },
      kill: showBadges,
      pending: () => badgeCards.length,
    };
  `)(TRACK_KEYS, stepOf, badgeOf, levelOf,
    { badge: (now, c) => shown.push(c) },
    { badge: (up, lv) => chimed.push(up ? 'up' : lv ? 'lv' : '-') });
  const sim = mkSim();
  const tok = (c) => (c.promoted ? 'up' : c.levelUp ? 'lv' : '-');
  const say = () => shown.map((c) => `${c.key}:${c.count}:${tok(c)}`).join(' ');

  // COUNTS COME OUT OF THE TABLE, NOT WRITTEN DOWN. The thresholds are generated from a
  // curve now, so a literal 60 here would be checking last month's ladder and passing.
  //
  // Two of the steps below are certain from the decomposition alone, whatever the numbers
  // turn out to be: `at[MAX_LEVEL - 1]` is step 10 and `at[MAX_LEVEL]` is step 11, so
  // reaching the first is a level-up inside badge 1 and reaching the second is a promotion
  // out of it. Those two are asserted as literals. Everywhere the point is WHICH TRACK's
  // card is shown rather than which flag it carries, the flag is read back out of the table
  // — pinning that to hand-computed numbers off a generated curve would only test my
  // arithmetic. The promotion-versus-level-up rule itself is checked further up, on `kills`.
  const flag = (key, from, to) => {
    const a = stepOf(from, key);
    const b = stepOf(to, key);
    return badgeOf(b) > badgeOf(a) ? 'up' : b > a ? 'lv' : '-';
  };
  const rAt = BADGES.rifle.at;
  const hAt = BADGES.hs.at;
  const nAt = BADGES.sniper.at;
  const L = MAX_LEVEL - 1; // at[9] — step 10, the last level of the first badge
  const P = MAX_LEVEL; //     at[10] — step 11, the first count inside the second
  // `kills` walks inside step 41, high on the ladder where the gaps are hundreds wide, so
  // the running total never crosses a threshold of its own and adds a card nothing asked for.
  const K = BADGES.kills.at[40] + 1;

  // A returning player, mid-career. The first blob is a baseline and must show nothing.
  sim.fold({ kills: K, rifle: rAt[L] - 2, hs: hAt[L] - 2, sniper: nAt[P] - 1 });
  const atJoin = sim.pending();
  sim.kill(0);
  okK(atJoin === 0 && shown.length === 0 && chimed.length === 0,
      'arriving with a career shows no card, because nothing was earned by arriving',
      'diffing a full set of counts against zero would pop a promotion for every track a '
      + 'returning player already had — twelve cards for kills scored last week');

  // An ordinary body kill: the weapon speaks, not the running total.
  const r1 = rAt[L] - 1;
  sim.fold({ kills: K + 1, rifle: r1, hs: hAt[L] - 2, sniper: nAt[P] - 1 });
  sim.kill(0);
  okK(say() === `rifle:${r1}:${flag('rifle', rAt[L] - 2, r1)}`
      && chimed.join() === flag('rifle', rAt[L] - 2, r1),
      'an ordinary kill shows one card, on the most specific track that moved',
      `${say()} — kills moved too, and showing both would bury the interesting one under a `
      + 'total that moves on every single kill');

  // A headshot outranks the weapon.
  shown.length = 0; chimed.length = 0;
  const h1 = hAt[L] - 1;
  sim.fold({ kills: K + 2, rifle: r1, hs: h1, sniper: nAt[P] - 1 });
  sim.kill(0);
  okK(say() === `hs:${h1}:${flag('hs', hAt[L] - 2, h1)}`,
      'and a headshot kill shows the headshot', say());

  // A level-up inside a badge, then the promotion out of it, then the kill after. The middle
  // one is the card that pops and queues; the other two take the routine 1.6 s.
  shown.length = 0; chimed.length = 0;
  sim.fold({ kills: K + 3, rifle: rAt[L], hs: h1, sniper: nAt[P] - 1 });
  sim.kill(0);
  const atLv = say();
  shown.length = 0;
  sim.fold({ kills: K + 4, rifle: rAt[P], hs: h1, sniper: nAt[P] - 1 });
  sim.kill(0);
  const atUp = say();
  shown.length = 0;
  sim.fold({ kills: K + 5, rifle: rAt[P] + 1, hs: h1, sniper: nAt[P] - 1 });
  sim.kill(0);
  const afterUp = say();
  okK(atLv === `rifle:${rAt[L]}:lv` && atUp === `rifle:${rAt[P]}:up`
      && afterUp === `rifle:${rAt[P] + 1}:${flag('rifle', rAt[P], rAt[P] + 1)}`
      && !afterUp.endsWith(':up') && chimed.join() === 'lv,up,-',
      'a new level lights a pip, the badge above it pops, and neither is re-reported after',
      `${atLv} → ${atUp} → ${afterUp}; ${rAt[P]} rifle kills is ${tierName(2)} 1, and `
      + `${rAt[L]} is ${tierName(1)} ${MAX_LEVEL} — a promotion re-reported on every kill `
      + 'afterwards is the failure mode a count-based check would never see, and with fifty '
      + 'steps instead of five there are ten times as many chances to hit it');

  // Two tracks crossing into a new badge on one kill.
  shown.length = 0; chimed.length = 0;
  sim.fold({ kills: K + 6, rifle: rAt[P] + 1, hs: hAt[P], sniper: nAt[P] });
  sim.kill(0);
  okK(say() === `hs:${hAt[P]}:up sniper:${nAt[P]}:up` && chimed.join() === 'up',
      'two promotions on one kill are two cards, most specific first, and one chime',
      `${say()} — hud.badge queues promotions rather than replacing them, so they read as `
      + 'two events rather than one card that changed its mind');

  // A first-ever player: the field is omitted entirely while every count is zero, so the
  // baseline for a new account is an ABSENT blob rather than a missing one.
  const fresh = mkSim();
  shown.length = 0; chimed.length = 0;
  fresh.fold(undefined);
  fresh.fold({ kills: 1, knife: 1 });
  fresh.kill(0);
  okK(say() === 'knife:1:up kills:1:up' && chimed.join() === 'up',
      'and a first-ever kill promotes on both tracks it opened',
      `${say()} — at[0] is 1 on every track, which is what makes a brand-new player's very `
      + 'first kill a promotion instead of a blank card');

  // A count that goes DOWN is a stale blob racing a reconnect. There is no card in it.
  shown.length = 0; chimed.length = 0;
  sim.fold({ kills: 50, rifle: 10, hs: 5, sniper: 2 });
  sim.kill(0);
  okK(shown.length === 0 && chimed.length === 0,
      'a blob that walks a count backwards shows nothing, because the store is monotonic',
      'setCareer guards every key with Math.max, so a drop is a stale message rather than '
      + 'a thing that happened');
});

// ─────────────────────────────── the card itself
driveK('the badge card', () => {
  const hudK = readFileSync(new URL('./client/src/hud.js', import.meta.url), 'utf8');
  const grabH = (re, what) => {
    const m = re.exec(hudK);
    okK(!!m, `${what} is still where this suite looks for it in hud.js`,
        m ? `lifted ${m[0].trim().split('\n').length} lines` : 'no match — renamed or reshaped');
    return m ? m[0] : '';
  };

  // A DOM stub that records what was written and which classes are on. `document` is the
  // reason hud.js cannot be imported, and these seven nodes are all the card touches.
  const mk = () => {
    const on = new Set();
    const node = {
      textContent: '', offsetWidth: 1, _on: on, children: [], _attr: {},
      setAttribute: (k, v) => { node._attr[k] = v; },
      classList: {
        toggle: (n, f) => { if (f === undefined ? on.has(n) : !f) on.delete(n); else on.add(n); },
        add: (n) => on.add(n),
        remove: (...ns) => ns.forEach((n) => on.delete(n)),
      },
    };
    // `showBadge` assigns `className` outright, because one element serves all twelve tracks
    // and all five badges. Modelled here as the wipe-and-replace the browser does, not as an
    // add: a stub that let a `b3` survive underneath a `b4` card would pass a check that the
    // real page fails, and the failure would be the emblem drawn in the wrong metal.
    Object.defineProperty(node, 'className', {
      get: () => [...on].join(' '),
      set: (v) => { on.clear(); for (const t of String(v).split(/\s+/)) if (t) on.add(t); },
    });
    return node;
  };
  const els = {
    badge: mk(), bdGlyph: mk(), bdLabel: mk(), bdTier: mk(),
    bdPips: mk(), bdLevel: mk(), bdCount: mk(),
    hitmark: { style: {} }, vignette: { style: {} },
    // Never read here -- the chain's window stays 0 -- but present so that a `tick` which
    // starts touching them is a red check in Part L rather than a throw in this one.
    killmark: mk(), kmBar: mk(), kmFill: { style: {} }, kmSecs: mk(),
  };
  els.bdPips.children = Array.from({ length: MAX_LEVEL }, () => mk());

  const card = new Function('els', 'MAX_STEP', 'labelOf', 'tierName', 'badgeOf', 'levelOf',
    'stepOf', 'toNextStep', `
    let hitUntil = 0;
    let hurtUntil = 0;
    // hud.tick expires the killmark in the same pass it expires the card, so lifting the
    // card drags the chain's four variables in with it. Lifted rather than restated, because
    // the whole point of taking tick as text is that this file does not get a vote on what
    // is inside it -- and with kmUntil never leaving 0 here, the branch is inert either way.
${grabH(/  let kmUntil = 0;[\s\S]*?  let shownKmSecs = '';/, 'the killmark state, which hud.tick shares')}
${grabH(/  let badgeUntil = 0;[\s\S]*?const BADGE_QUEUE_MAX = \d+;/, 'the card state')}
${grabH(/  function showBadge\(card, now\) \{[\s\S]*?\n  \}\n/, 'showBadge')}
${grabH(/  function nounFor\(key, n\) \{[\s\S]*?\n  \}\n/, 'nounFor')}
    const api = {
${grabH(/    badge\(now, card\) \{[\s\S]*?\n    \},/, 'hud.badge')}
${grabH(/    tick\(now\) \{[\s\S]*?\n    \},/, 'hud.tick')}
    };
    api.read = () => ({
      label: els.bdLabel.textContent,
      tier: els.bdTier.textContent,
      level: els.bdLevel.textContent,
      glyph: els.bdGlyph._attr.href,
      // '+' is the pip this kill just lit, '#' one already filled, '.' one still to earn.
      pips: els.bdPips.children
        .map((p) => (p._on.has('n') ? '+' : p._on.has('f') ? '#' : '.')).join(''),
      count: els.bdCount.textContent,
      cls: [...els.badge._on].sort().join(' '),
      until: badgeUntil,
      queued: badgeQueue.length,
    });
    return api;
  `)(els, MAX_STEP, labelOf, tierName, badgeOf, levelOf, stepOf, toNextStep);

  card.badge(1000, { key: 'knife', count: 1, promoted: true, levelUp: true });
  const first = card.read();
  okK(first.label === WEAPONS.knife.label && first.tier === TIER_NAMES[0] && first.level === 'LEVEL 1'
      && first.pips === `+${'.'.repeat(MAX_LEVEL - 1)}` && first.glyph === '#g-knife'
      && first.count === `1 ${WEAPONS.knife.label.toLowerCase()} kill · ${BADGES.knife.at[1] - 1} to ${TIER_NAMES[0]} 2`
      && first.cls === 'b1 on up',
      'a first-ever knife kill reads as one lit pip, a Marksman 1, and a knife in the emblem',
      `${first.label} / ${first.tier} ${first.level} / ${first.pips} / "${first.count}" / `
      + `glyph ${first.glyph} — singular, because every track starts at 1 and so the very `
      + 'first card a new player ever sees says one');

  // Mid-ladder, inside the third badge: a level-up rather than a promotion, which is what
  // forty-nine kills out of every fifty steps actually are.
  const lAt = BADGES.lmg.at;
  card.badge(5000, { key: 'lmg', count: lAt[24], promoted: false, levelUp: true });
  const mid = card.read();
  okK(mid.label === WEAPONS.lmg.label && mid.tier === TIER_NAMES[2] && mid.level === 'LEVEL 5'
      && mid.pips === `####+${'.'.repeat(MAX_LEVEL - 5)}` && mid.glyph === '#g-lmg'
      && mid.count === `${lAt[24]} ${WEAPONS.lmg.label.toLowerCase()} kills · `
        + `${lAt[25] - lAt[24]} to ${TIER_NAMES[2]} 6`
      && mid.cls === 'b3 lv on',
      'and a mid-ladder level-up lights the pip it just earned without the promotion pop',
      `${mid.pips} ${mid.tier} ${mid.level} — "${mid.count}", class "${mid.cls}": b3 is the `
      + 'silver the rank plates use, and `lv` colours the one new pip and nothing else');

  card.badge(9000, { key: 'kills', count: BADGES.kills.at[MAX_STEP - 1], promoted: true, levelUp: true });
  const top = card.read();
  okK(top.pips === '+'.padStart(MAX_LEVEL, '#') && top.tier === TIER_NAMES[4]
      && top.level === `LEVEL ${MAX_LEVEL}` && top.count.endsWith('top badge')
      && top.cls.split(' ').includes('b5'),
      'the top of a track fills every pip and stops asking for more',
      `"${top.count}" — a countdown that kept going past step ${MAX_STEP} would be counting `
      + `toward a level that does not exist, and ${BADGES.kills.at[MAX_STEP - 1].toLocaleString('en-US')} `
      + 'kills is the whole point of the re-cut');

  const hAt2 = BADGES.hs.at;
  card.badge(13000, { key: 'hs', count: hAt2[13], promoted: false, levelUp: false });
  const headCard = card.read();
  okK(headCard.cls === 'b2 hs on' && headCard.label === 'HEADSHOT' && headCard.glyph === '#g-hs'
      && headCard.level === 'LEVEL 4'
      && headCard.count === `${hAt2[13]} headshots · ${hAt2[14] - hAt2[13]} to ${TIER_NAMES[1]} 5`,
      'the headshot track carries its own class, so the card is the colour of the marker',
      `classes "${headCard.cls}" — the same gold the hitmarker uses, so the badge and the `
      + 'shot that earned it read as one thing. `hs` and `b2` sit side by side because they '
      + 'are different axes: one colours the words, the other the metal');

  // A routine card must not cut a promotion short, and neither may another promotion. Both
  // are about the same 2.6 seconds being the only time the ladder is legible.
  card.badge(20000, { key: 'hs', count: hAt2[30], promoted: true, levelUp: true });
  const held = card.read();
  card.badge(20100, { key: 'rifle', count: 62, promoted: false, levelUp: false });
  const survived = card.read();
  card.badge(20200, { key: 'sniper', count: 10, promoted: true, levelUp: true });
  const queued = card.read();
  okK(held.tier === TIER_NAMES[3] && survived.label === 'HEADSHOT'
      && survived.until === held.until && queued.label === 'HEADSHOT' && queued.queued === 1,
      'a promotion is not swept away by the next routine kill, and the next promotion waits',
      'an ordinary rifle card and then a sniper promotion arrived, and the screen still reads '
      + `${queued.label} with ${queued.queued} queued`);

  card.tick(20500);
  const midHold = card.read();
  card.tick(23000);
  const handedOver = card.read();
  card.tick(26000);
  const cleared = card.read();
  okK(midHold.label === 'HEADSHOT' && handedOver.label === WEAPONS.sniper.label
      && handedOver.queued === 0 && !cleared.cls.split(' ').includes('on'),
      'and the queue drains through the same tick that expires the hitmarker',
      `held → ${handedOver.label} → ${cleared.cls ? `class "${cleared.cls}"` : 'nothing'} — `
      + 'one expiry path for every transient on the HUD, rather than a timer per card');

  // A promotion MAY replace a routine card: it is strictly better news about the same kill.
  card.badge(30000, { key: 'rifle', count: 63, promoted: false, levelUp: false });
  card.badge(30200, { key: 'hs', count: hAt2[MAX_LEVEL], promoted: true, levelUp: true });
  const replaced = card.read();
  okK(replaced.label === 'HEADSHOT' && replaced.cls.split(' ').includes('up')
      && !replaced.cls.split(' ').includes('lv'),
      'but a promotion does replace a routine card, being better news about the same kill',
      `the screen reads ${replaced.label} with classes "${replaced.cls}" — `
      + '`up` and never both, because a promotion is a level-up too and two treatments at '
      + 'once would animate the card against itself');

  for (let i = 0; i < 9; i++) {
    card.badge(40000 + i, { key: 'hs', count: 30 + i, promoted: true, levelUp: true });
  }
  okK(card.read().queued === 3,
      'and the queue is capped, so a spawn-rush cannot bury the player in cards',
      `nine promotions in gave ${card.read().queued} queued — eight seconds of cards between `
      + 'a player and their next fight is not a reward');

  // THE SPRITE THE CARD POINTS AT. `showBadge` builds the href from the track key, which is
  // what keeps the twelve emblems from needing a lookup table — and also means a missing id
  // in the sprite fails as an EMPTY EMBLEM, with no console error and nothing in this suite
  // to catch it. So the ids are checked against the same TRACK_KEYS the href is built from.
  const htmlK = readFileSync(new URL('./client/index.html', import.meta.url), 'utf8');
  const noGlyph = TRACK_KEYS.filter((k) => !htmlK.includes(`id="g-${k}"`));
  const pipCount = (/<div id="bd-pips">([\s\S]*?)<\/div>/.exec(htmlK)?.[1].match(/<i>/g) ?? []).length;
  okK(noGlyph.length === 0 && pipCount === MAX_LEVEL,
      `all ${TRACK_KEYS.length} tracks have a glyph in the sprite, and the card has `
      + `${MAX_LEVEL} pips to fill`,
      noGlyph.length ? `no sprite for: ${noGlyph.join(', ')} — those cards draw an empty emblem`
        : `every id="g-<key>" present and ${pipCount} <i> in #bd-pips; showBadge fills them `
          + 'from children.length, so a row of five would silently cap every card at level 5');
});

// ─────────────────────────────── the corpse that stopped looking around
{
  // "i notice you can sleep move your camera when you die it makes no sense you are dead."
  //
  // Two halves, checked against different text on purpose. What the code DOES is read with
  // the prose stripped out, the way Part J's `bareJ` is — a grep of the raw file finds the
  // paragraph arguing FOR the rule and reads it as the rule. Whether the OLD claim is gone
  // has to be checked against the raw file, because that claim was itself a comment, and a
  // stale comment asserting the opposite of the code is how the next reader puts the bug
  // back on purpose.
  const rawK = readFileSync(new URL('./client/src/input.js', import.meta.url), 'utf8');
  const bareK = rawK
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');

  const mm = /addEventListener\('mousemove', \(e\) => \{([\s\S]*?)\n  \}\);/.exec(bareK)?.[1] ?? '';
  const gate = mm.indexOf('if (!alive) return;');
  const turns = mm.search(/yaw\s*-=/);
  okK(mm.length > 0 && gate >= 0 && turns >= 0 && gate < turns,
      'the mousemove handler refuses to turn a corpse before it touches yaw at all',
      mm.length === 0 ? 'the handler could not be found — it was reshaped'
        : `the alive gate is at character ${gate} of the handler and the first write to yaw `
          + `at ${turns} — gating the stored value rather than what the camera reads is what `
          + 'keeps setView and the recoil punch agreeing with it');

  okK(!/dead players may still look around/i.test(rawK),
      'and the comment that used to state the opposite rule is gone',
      'a file that argues for behaviour it no longer has is worse than one with no comment: '
      + 'the next reader takes the prose as the intent and restores the bug');

  // The freeze must not leak into the next life. `setView` is what a respawn aligns the view
  // with, and it writes yaw and pitch directly rather than through the handler.
  const sv = /setView\(([\s\S]*?)\n    \}/.exec(rawK)?.[1] ?? '';
  okK(/yaw = /.test(sv) && /pitch = /.test(sv),
      'a respawn still sets the view outright, so a frozen corpse does not freeze the next life',
      sv.length ? 'setView assigns both, and EV.SPAWN calls it with the server\'s yaw'
        : 'setView could not be found');
}

console.log([...pK, ...fK].join('\n'));

// ────────────────────── Part L: the timed kill chain and the mark that displays it
//
// "if you kill one up to six during the game ... once it full the six kills it just
// continuiously in multikill theres a seconds when it will be in multikill the concept
// similar to crossfire" — and then, twice: "look it up".
//
// This is the one counter in the game with NO server behind it, which inverts where the
// risk lives. Part K can lean on shared/badges.js throwing at import and on a real Room
// deciding what a kill was worth; here the ladder is four constants and the state machine
// is one client-side map in main.js, so every rule that matters is in lifted client text.
//
// Three things can break independently.
//
//   shared/spree.js is the ladder, and it is shared for exactly this reason — a rule that
//   lives in a view file is a rule no suite can reach. It self-checks the name/leg count at
//   import; what it cannot check is that the cap actually caps and that junk reads as no
//   chain rather than as NaN in a class name.
//
//   main.js owns WHEN the timed chain grows, and the two ways it goes wrong are both invisible
//   in play. Letting weapon/zone reset the count loses rays on a headshot; forgetting the
//   deadline lets the next fight inherit the last one. The grenade exemption matters too.
//   room.js broadcasts that suicide as a KILL with `by` set to the victim, so the client has
//   to restate a rule the ledger already enforces — and the only place that is written down
//   is the `if` this part lifts.
//
//   hud.js owns the drawing, and its whole job is a class string: `k{legs} w{wings}`, plus
//   `full` at the cap and `new` on the one leg that just lit. It also runs the bar off its
//   OWN clock, which is the check worth having — the fraction is computed from the window
//   the kill opened rather than from SPREE_MS, so a boosted window would still drain right.
console.log('\n=== Part L — the killmark ===\n');

const pL = [];
const fL = [];
const okL = (cond, label, detail = '') => {
  (cond ? pL : fL).push(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

/** Part K's `driveK`, for the reason it gives there: a lifted function that throws is a
 *  regression in its source, reported as one red check rather than as an exit code. */
const driveL = (what, fn) => {
  try {
    fn();
  } catch (e) {
    okL(false, `${what} could not be driven at all`, `threw: ${e?.message ?? e}`);
  }
};

// ─────────────────────────────── the ladder
{
  okL(SPREE_LEGS === 6 && SPREE_NAMES.join('|')
      === '|DOUBLE KILL|TRIPLE KILL|QUAD KILL|MULTI KILL|MULTI KILL'
      && spreeName(99) === 'MULTI KILL',
      'double, triple and quad are distinct; the fifth kill onward stays MULTI KILL',
      `${SPREE_NAMES.slice(1).join(' → ')} — CrossFire's own cap: "Even when a player `
      + 'achieves a 7 Kill Streak or higher, it still only shows the 6-legged star"');

  okL(SPREE_NAMES[0] === '' && spreeName(1) === '' && spreeName(0) === '',
      'one kill lights a leg and says nothing at all',
      'the commonest event in the game, and a game that shouts at one kill has nothing left '
      + 'to say at six — the mark and the sound agree on this, audio.spree is silent below 2');

  const legs = Array.from({ length: 40 }, (_, i) => legsOf(i));
  const mono = legs.every((v, i) => i === 0 || v >= legs[i - 1]);
  const capped = legs.slice(SPREE_LEGS).every((v) => v === SPREE_LEGS);
  okL(mono && capped && legs[0] === 0 && legs[1] === 1 && legs[SPREE_LEGS] === SPREE_LEGS,
      'legsOf climbs one per kill to six and then stops, for a chain of any length',
      `a chain of 39 is still ${legsOf(39)} legs — the seventh kill refreshes the window and `
      + 'changes nothing on screen, which is why the sound has to carry it instead');

  const junk = [NaN, Infinity, -Infinity, -1, 0, 0.5, undefined, null, '3', {}]
    .map((v) => legsOf(v));
  okL(junk.slice(0, 7).every((v) => v === 0) && junk.every((v) => Number.isInteger(v)),
      'and junk reads as no chain rather than as NaN in a class name',
      `${junk.join(',')} — a killmark that silently stops drawing is a bug nobody reports, `
      + 'because nobody is sure it was ever there');

  okL(SPREE_MS >= 2500 && SPREE_MS <= 6000 && Number.isInteger(SPREE_MS),
      `the window is ${SPREE_MS}ms, which is a decision and is documented as one`,
      "CrossFire does not publish its base timer — the wiki gives only the boosted ceiling "
      + '(27.9s) — so this is chosen against this game\'s pace: a rifle kills in ~250ms and '
      + `crossing the map takes 2-3s, so ${SPREE_LEGS} legs is ~${(SPREE_MS * SPREE_LEGS) / 1000}s of continuous fighting`);

  const wings = [0, 1, 2, 3, 4, 5].map((t) => wingsOf(t));
  okL(wings.join() === '0,0,1,2,3,4' && wingsOf(99) === 4
      && [NaN, undefined, -3, null].every((v) => wingsOf(v) === 0),
      'wings run 0..4 off a badge tier of 0..5, and Marksman gets none',
      'a bare mark has to mean something or the wings mean nothing — and this is the ONE '
      + 'place the two ladders touch, one-way: the badge decorates the mark, never the reverse');

  const src = readFileSync(new URL('./shared/spree.js', import.meta.url), 'utf8');
  okL(/if \(SPREE_NAMES\.length !== SPREE_LEGS\)[\s\S]*?throw new Error/.test(src),
      'the ladder still checks its own shape at import, where the dev server hits it too',
      'a chain that reached a leg with no name would render an empty word under a full star');
}

// ─────────────────────────────── when a chain grows, and when it does not
//
// Lifted whole out of the EV.KILL case, because the rules ARE the four lines in it and a
// transcription of them into this file would only ever prove that the transcription works.
// The case is pulled as text between its label and its `break`, then closed over stubs for
// everything main.js has that this file does not.
driveL('the timed kill chain', () => {
  const mainL = readFileSync(new URL('./client/src/main.js', import.meta.url), 'utf8');
  const grabL = (re, what) => {
    const m = re.exec(mainL);
    okL(!!m, `${what} is still where this suite looks for it in main.js`,
        m ? `lifted ${m[0].trim().split('\n').length} lines` : 'no match — renamed or reshaped');
    return m ? m[0] : '';
  };
  const state = grabL(/const killChains = new Map\(\);\n/, 'the per-killer chain state');
  const glyph = grabL(/function killGlyph\(wIdx, zone\) \{[\s\S]*?\n\}\n/, 'killGlyph');
  const body = grabL(/(?<=case EV\.KILL:\n)[\s\S]*?\n      break;/, 'the EV.KILL case body');

  let log = [];
  const sim = new Function('EV', 'TRACK_KEYS', 'SPREE_MS', 'wingsOf', 'tierOf', 'idAt', 'sink', `
    const selfId = 7;
    let badgeCounts = { kills: 0 };
    let killer = null;
    const nameOf = (id) => 'p' + id;
    const showBadges = () => {};
    const hud = { feed: () => {}, damaged: () => {}, killmark: (now, m) => sink().push(m),
                  killmarkClear: () => sink().push('clear') };
    const audio = { kill: () => {}, died: () => {}, hit: () => {}, hurt: () => {},
                    spree: (n) => sink().push('sound:' + n) };
${state}
${glyph}
    return {
      kill: (now, ev) => { switch (ev.e) { case EV.KILL:
${body}
      } },
      read: () => ({ chain: killChains.get(7), killer }),
      setCareer: (n) => { badgeCounts = { kills: n }; },
    };
  `)(EV, TRACK_KEYS, SPREE_MS, wingsOf, tierOf, idAt, () => log);

  const K = (now, over) => sim.kill(now, { e: EV.KILL, by: 7, on: 9, w: indexOf('rifle'), ...over });
  const marks = () => log.filter((m) => typeof m === 'object');

  // ── inside the window it climbs; a kill at or beyond the exact deadline starts at one.
  const t1 = 1000 + SPREE_MS - 1;
  const t2 = t1 + SPREE_MS - 1;
  K(1000);
  K(t1);
  const inside = sim.read().chain?.n;
  K(t2);
  const atEdge = sim.read().chain?.n;
  K(t2 + SPREE_MS);
  okL(inside === 2 && atEdge === 3 && sim.read().chain?.n === 1,
      'kills inside the display window add rays, and a late kill starts again at one',
      `1 → ${inside} → ${atEdge}, then ${sim.read().chain?.n} at the exact deadline — weapon `
      + 'and hit zone are absent from the reset condition');

  // ── the cap: the count keeps going, the drawing does not
  sim.kill(t2 + SPREE_MS + 1, { e: EV.KILL, by: 9, on: 7, w: indexOf('rifle') });
  log = [];
  let t = 50_000;
  for (let i = 0; i < 9; i += 1) { K(t); t += 100; }
  const drawn = marks().map((m) => legsOf(m.n));
  okL(sim.read().chain?.n === 9 && drawn.join() === '1,2,3,4,5,6,6,6,6'
      && marks().map((m) => m.n).join() === '1,2,3,4,5,6,7,8,9',
      'a ninth kill in one life still counts nine and still draws six legs',
      `legs drawn: ${drawn.join(',')} — main.js keeps the TRUE count while legsOf is the `
      + 'only thing that clamps, and it clamps '
      + 'inside the two places that draw and sound rather than at the counter');

  // ── death ends it on the instant
  log = [];
  K(60_000);
  K(60_100);
  sim.kill(60_200, { e: EV.KILL, by: 9, on: 7, w: indexOf('rifle') });
  const afterDeath = sim.read();
  okL(afterDeath.chain === undefined && log.includes('clear')
      && afterDeath.killer?.name === 'p9',
      'dying resets the timed chain on the instant',
      'the next life starts from one ray even if the previous life filled the crest');

  // ── the two kills that are not kills, each laid on top of a LIVE chain so a missing
  //    exemption shows up as a leg rather than being hidden by an already-empty counter
  K(70_000);
  log = [];
  sim.kill(70_100, { e: EV.KILL, by: 7, on: 7, w: indexOf('grenade') });
  const suicideLog = [...log];
  const suicide = sim.read();
  K(75_000);
  log = [];
  sim.kill(75_100, { e: EV.KILL, by: 0, on: 7, w: indexOf('rifle') });
  okL(suicideLog.join() === 'clear' && suicide.chain === undefined
      && log.join() === 'clear' && sim.read().chain === undefined,
      'your own grenade and a fall out of the world earn no leg and no sound',
      `the grenade logged [${suicideLog.join(' ')}] and the world death [${log.join(' ')}] — the `
      + 'same two exemptions server/room.js:738 puts on the career ledger, restated here '
      + 'because room.js broadcasts a self-kill as a KILL with `by` set to the victim, and this '
      + 'counter is the only one in the game with no server copy to check it against');

  // ── what goes in the middle of the mark
  log = [];
  K(90_000, { z: HIT_ZONE.HEAD });
  for (const id of WEAPON_IDS) K(90_000, { w: indexOf(id) });
  const seen = marks().map((m) => m.glyph);
  const want = ['#g-hs', ...WEAPON_IDS.map((id) => (TRACK_KEYS.includes(id) ? `#g-${id}` : '#g-kills'))];
  okL(seen.join() === want.join() && seen.includes('#g-kills'),
      'a headshot outranks the weapon, and a weapon with no badge track falls back to the total',
      `${seen.join(' ')} — the headshot override is the order the badge card uses, and the `
      + `fallback is live rather than defensive: ${WEAPON_IDS.filter((id) => !TRACK_KEYS.includes(id)).join(' and ')} `
      + 'are weapons with no track, so they file under the total the way shared/badges.js does');

  log = [];
  K(95_000, { w: 999 });
  okL(marks()[0].glyph === `#g-${idAt(999)}`,
      'and an index off the end of the weapon table takes weapons.js\'s own fallback',
      `#g-${idAt(999)} — idAt already answers a bad index with a real weapon, so killGlyph `
      + 'inherits that rather than second-guessing it; the #g-kills branch is for a weapon '
      + 'that exists and has no badge, which is a different thing');

  // ── the wings come off the career badge, and only off it
  log = [];
  sim.setCareer(0);
  K(100_000);
  sim.setCareer(BADGES.kills.at[MAX_LEVEL]);
  K(100_100);
  sim.setCareer(BADGES.kills.at[MAX_STEP - 1]);
  K(100_200);
  const worn = marks().map((m) => m.wings);
  okL(worn.join() === `0,${wingsOf(2)},${wingsOf(MAX_BADGE_TIER)}` && worn[2] === 4,
      'the mark wears the wings of your ELIMINATIONS badge, from none to four',
      `career 0 / ${BADGES.kills.at[MAX_LEVEL]} / ${BADGES.kills.at[MAX_STEP - 1]} kills wore `
      + `${worn.join(' / ')} wings — read off the kills track and not the weapon, so the mark `
      + 'is never showing a tier some other gun earned');
});

// ─────────────────────────────── the mark itself
//
// One class string does the whole drawing -- `k{legs} w{wings}`, plus `full` at the cap --
// because a `<use>`'d SVG sprite cannot be reached by a descendant selector across its
// shadow tree, so visibility is a cascade off the parent instead of a property on each leg.
// That makes the class the only artifact worth checking, and makes a stale one the only way
// this can go wrong: a `k3` left under a `k4` lights four legs and three at once.
driveL('the killmark', () => {
  const hudL = readFileSync(new URL('./client/src/hud.js', import.meta.url), 'utf8');
  const grabM = (re, what) => {
    const m = re.exec(hudL);
    okL(!!m, `${what} is still where this suite looks for it in hud.js`,
        m ? `lifted ${m[0].trim().split('\n').length} lines` : 'no match — renamed or reshaped');
    return m ? m[0] : '';
  };

  // Part K's node stub, plus the two query methods the star needs. `className` is a
  // wipe-and-replace for the reason it gives there: a stub that let `k3` survive under a
  // `k4` would pass a check the real page fails, and the failure is a nine-legged star.
  const mk = (cls = '') => {
    const on = new Set(cls.split(/\s+/).filter(Boolean));
    const node = {
      textContent: '', offsetWidth: 1, _on: on, style: {}, _attr: {},
      setAttribute: (k, v) => { node._attr[k] = v; },
      classList: {
        toggle: (n, f) => { if (f === undefined ? on.has(n) : !f) on.delete(n); else on.add(n); },
        add: (n) => on.add(n),
        remove: (...ns) => ns.forEach((n) => on.delete(n)),
      },
    };
    Object.defineProperty(node, 'className', {
      get: () => [...on].join(' '),
      set: (v) => { on.clear(); for (const t of String(v).split(/\s+/)) if (t) on.add(t); },
    });
    return node;
  };
  const legNodes = Array.from({ length: SPREE_LEGS }, (_, i) => mk(`km-leg l${i + 1}`));
  const km = mk();
  km.querySelectorAll = (sel) => (sel === '.km-leg' ? legNodes : []);
  km.querySelector = (sel) => legNodes.find((n) => n._on.has(sel.replace('.km-leg.', ''))) ?? null;

  const els = {
    killmark: km, kmGlyph: mk(), kmName: mk(), kmBar: mk(), kmFill: mk(), kmSecs: mk(),
    hitmark: mk(), vignette: mk(), badge: mk(),
  };

  const hud = new Function('els', 'SPREE_LEGS', 'SPREE_MS', 'legsOf', 'spreeName', 'legNodes', `
    let hitUntil = 0;
    let hurtUntil = 0;
    let badgeUntil = 0;
    let badgeUp = false;
    const badgeQueue = [];
    const showBadge = () => {};
${grabM(/  let kmUntil = 0;[\s\S]*?  let shownKmSecs = '';/, 'the killmark state')}
    const api = {
${grabM(/    killmark\(now, \{ n, glyph, wings = 0 \}\) \{[\s\S]*?\n    \},/, 'hud.killmark')}
${grabM(/    killmarkClear\(\) \{[\s\S]*?\n    \},/, 'hud.killmarkClear')}
${grabM(/    tick\(now\) \{[\s\S]*?\n    \},/, 'hud.tick')}
    };
    api.read = () => ({
      cls: [...els.killmark._on].sort().join(' '),
      // One character per leg: '+' the one that just popped, '#' any other. The cascade off
      // the parent class is CSS and cannot run here, so what is asserted is the class it
      // keys off -- 'k4' with '+' on leg 4 IS four legs lit on the page.
      legs: legNodes.map((n) => (n._on.has('new') ? '+' : '#')).join(''),
      glyph: els.kmGlyph._attr.href,
      name: els.kmName.textContent,
      fill: els.kmFill.style.width,
      low: els.kmBar._on.has('low'),
      secs: els.kmSecs.textContent,
      until: kmUntil,
      span: kmUntil - kmFrom,
    });
    return api;
  `)(els, SPREE_LEGS, SPREE_MS, legsOf, spreeName, legNodes);

  // ── one leg, no word
  hud.killmark(1000, { n: 1, glyph: '#g-rifle' });
  const one = hud.read();
  okL(one.cls === 'k1 on w0' && one.legs === `+${'#'.repeat(SPREE_LEGS - 1)}`
      && one.name === '' && one.glyph === '#g-rifle' && one.fill === '100%'
      && one.until === 1000 + SPREE_MS,
      'a first kill is one leg, no name, and a full bar from the frame it happened on',
      `${one.cls} — the bar is drawn full HERE rather than on the next tick, because at 60 Hz `
      + 'that is one frame of a bar starting from wherever the last chain left it');

  // ── the class is rebuilt, so no stale k survives
  hud.killmark(1100, { n: 3, glyph: '#g-hs', wings: 2 });
  const three = hud.read();
  okL(three.cls === 'k3 on w2' && three.legs === '##+###' && three.name === SPREE_NAMES[2],
      'a third kill replaces the class outright and moves the pop to the third leg alone',
      `${three.cls} / ${three.legs} — a k1 left underneath a k3 would light one leg and three, `
      + 'and CSS has no opinion about which of two matching cascades wins');

  // ── the cap
  hud.killmark(1200, { n: SPREE_LEGS, glyph: '#g-kills', wings: 4 });
  const full = hud.read();
  hud.killmark(1300, { n: SPREE_LEGS + 3, glyph: '#g-kills', wings: 4 });
  const past = hud.read();
  okL(full.cls === `full k${SPREE_LEGS} on w4` && full.name === SPREE_NAMES[SPREE_LEGS - 1]
      && past.cls === full.cls && past.name === full.name
      && past.legs === full.legs && past.until === 1300 + SPREE_MS,
      'the sixth leg adds `full`, and a ninth kill draws the same star with the window reset',
      `${past.cls} at nine chained — the mark stops changing and only the window moves, which `
      + 'is the whole reason audio.spree keeps sounding at the cap: it is the channel left');

  okL(full.legs === `${'#'.repeat(SPREE_LEGS - 1)}+`,
      'and the pop is still on exactly one leg at the top of the ladder',
      `${full.legs} — taken off all six before it is added back, because re-adding the class `
      + 'to the SAME leg on a seventh kill coalesces into no change and the pop never replays');

  // ── the bar drains off the window the kill opened, not off SPREE_MS
  hud.killmark(2000, { n: 2, glyph: '#g-smg' });
  hud.tick(2000 + SPREE_MS * 0.5);
  const half = hud.read();
  hud.tick(2000 + SPREE_MS - 1000);
  const oneSec = hud.read();
  hud.tick(2000 + SPREE_MS - 400);
  const nearly = hud.read();
  okL(half.fill === '50%' && !half.low && oneSec.low && nearly.low && half.span === SPREE_MS,
      'the bar drains to a fraction of its own window and enters urgency state in the last second',
      `${half.fill} at halfway, low from ${SPREE_MS - 1000}ms — the span is kmUntil-kmFrom and `
      + 'not SPREE_MS, so the day a window is boosted the bar still drains over all of it '
      + 'instead of emptying early and lying about a chain that is still alive');

  okL(half.secs === `${(SPREE_MS / 2000).toFixed(1)}s` && nearly.secs === '0.4s',
      'and the readout ceils, so it never shows a 0.0 the player could believe in',
      `${half.secs} → ${oneSec.secs} → ${nearly.secs}`);

  // ── it goes away, both ways
  hud.tick(2000 + SPREE_MS);
  const timedOut = hud.read();
  hud.killmark(3000, { n: 4, glyph: '#g-knife' });
  hud.killmarkClear();
  const cleared = hud.read();
  hud.tick(3000 + 1);
  okL(!timedOut.cls.split(' ').includes('on') && timedOut.until === 0
      && !cleared.cls.split(' ').includes('on') && cleared.until === 0
      && hud.read().until === 0,
      'the mark leaves on its own deadline and leaves at once on a death',
      `timed out to "${timedOut.cls}", cleared to "${cleared.cls}" — and a tick after a clear `
      + 'finds no window to expire, so a death cannot be undone by the next frame');

  // ── junk
  const before = hud.read().cls;
  hud.killmark(4000, { n: 0, glyph: '#g-rifle' });
  hud.killmark(4000, { n: NaN, glyph: '#g-rifle' });
  okL(hud.read().cls === before && hud.read().until === 0,
      'and a chain of zero or of nothing draws nothing rather than a k0',
      'legsOf is the gate, in hud.js and in audio.js and in main.js — the one clamp all three '
      + 'share, so a bad count is an absent mark and never a NaN in a class name');
});

// ─────────────────────────────── the sound, and the page it draws on
//
// audio.js CAN be imported -- it takes no DOM -- but every method returns early without an
// AudioContext, so there is nothing to observe by calling one. What is worth checking is the
// table behind it: a leg with no note sets an oscillator to `undefined` Hz, which is silence
// plus console noise rather than a wrong sound, and the gate that keeps a single kill quiet.
{
  const aud = readFileSync(new URL('./client/src/audio.js', import.meta.url), 'utf8');
  const roots = /const SPREE_ROOT = \[([^\]]*)\]/.exec(aud)?.[1]?.split(',').map(Number) ?? [];
  const rungs = roots.slice(2);
  const ratios = rungs.slice(1).map((f, i) => f / rungs[i]);
  okL(roots.length === SPREE_LEGS + 1 && rungs.length === SPREE_LEGS - 1
      && ratios.every((r) => Math.abs(r - 2 ** (3 / 12)) < 0.002)
      && Math.abs(rungs[rungs.length - 1] / rungs[0] - 2) < 0.01,
      'the chain climbs a minor third per leg and lands exactly an octave up',
      `${rungs.join(' → ')} Hz — wide enough that leg 4 and leg 5 are different notes to `
      + 'someone who has never thought about intervals, which matters because the star is '
      + 'bottom-centre and a player mid-fight is looking at the middle of the screen');

  okL(/if \(legs < 2 \|\| !ensure\(\)\) return;/.test(aud)
      && /if \(SPREE_ROOT\.length !== SPREE_LEGS \+ 1\)[\s\S]{0,200}throw new Error/.test(aud),
      'one kill is silent, and a leg with no note behind it cannot ship',
      'the gate matches SPREE_NAMES[0] being the empty string: kill() already speaks for a '
      + 'single kill, so a chain sound there would be indistinguishable from the kill sound '
      + 'and then no sound would mean "chain"');

  okL(/import \{ SPREE_LEGS, legsOf \} from '\.\.\/\.\.\/shared\/spree\.js';/.test(aud),
      'and the sound reads the cap from shared/spree.js rather than restating it',
      'three files clamp this count and all three call legsOf — a 6 written out in audio.js '
      + 'is a 6 that survives raising SPREE_LEGS to seven');
}

// The page is the other half of the class string: hud.js writes `k4`, and if the cascade that
// turns a `k4` into four visible legs is not there, every check above still passes against a
// star nobody can see. Both halves are asserted against the same numbers.
{
  const page = readFileSync(new URL('./client/index.html', import.meta.url), 'utf8');
  const hudSrc = readFileSync(new URL('./client/src/hud.js', import.meta.url), 'utf8');
  const km = /<div id="killmark">[\s\S]*?\n    <\/div>/.exec(page)?.[0] ?? '';
  const legCls = [...km.matchAll(/class="km-leg l(\d+)"/g)].map((m) => Number(m[1]));
  okL(legCls.join() === Array.from({ length: SPREE_LEGS }, (_, i) => i + 1).join()
      && /<use id="km-glyph" href="#g-/.test(km),
      `the star is drawn with ${SPREE_LEGS} legs, numbered l1 up to l${SPREE_LEGS}`,
      legCls.length ? `l${legCls.join(', l')} — one polygon per rung, in order` : 'no legs found');

  const size = /#km-star \{[\s\S]*?width: (\d+)px; height: (\d+)px;/.exec(page);
  const palette = /#killmark \{[\s\S]*?--km-col: ([^;]+);[\s\S]*?\n      \}/.exec(page)?.[1]?.trim();
  okL(size && Number(size[1]) >= 145 && Number(size[2]) >= 80
      && palette === '#2caecb'
      && /#km-bar\.low #km-fill \{ background: var\(--km-edge\)/.test(page),
      'the redesigned crest is larger, cyan instead of damage-red, and its warning stays pale',
      size ? `${size[1]}x${size[2]}px, normal ${palette}, final second uses --km-edge`
        : 'no #km-star dimensions found');

  okL(/id="km-ring"/.test(km) && /id="km-hub"/.test(km)
      && /#km-hub \{ fill: var\(--km-core\); stroke: var\(--km-col\)/.test(page),
      'the weapon sits in a dark double-edged medallion instead of floating inside thin legs',
      'outer pale ring + dark hub + coloured inner edge keep the glyph readable on light and dark cover');

  // The cascade is a triangle, and asserted as one: a `k4` has to light legs 1 through 4 and
  // has to leave 5 and 6 dark. Checking only that each `kN` reaches its OWN leg would pass a
  // page where a four-kill chain drew a single leg, which is the version of this bug that
  // looks like the timer is broken rather than like the stylesheet is.
  const rung = Array.from({ length: SPREE_LEGS }, (_, i) => i + 1);
  const litFor = (n, pfx, cls) => rung.filter((m) => page.includes(`#killmark.${pfx}${n} .${cls}${m}`));
  const legTri = rung.filter((n) => litFor(n, 'k', 'l').join() !== rung.slice(0, n).join());
  okL(legTri.length === 0,
      `every k1..k${SPREE_LEGS} lights exactly the legs below it and none above`,
      legTri.length ? `k${legTri.join(', k')} lights the wrong set`
        : `${rung.map((n) => `k${n}→${litFor(n, 'k', 'l').length}`).join(' ')} — read off the `
          + 'parent because a <use> shadow tree is not reachable by a descendant selector, '
          + 'which is the whole reason this is a class and not a style');

  const wingCls = [...km.matchAll(/class="f(\d+)"/g)].map((m) => Number(m[1]));
  const wingTri = [1, 2, 3, 4]
    .filter((n) => litFor(n, 'w', 'f').slice(0, 4).join() !== [1, 2, 3, 4].slice(0, n).join());
  okL(wingCls.length === 8 && wingCls.filter((n) => n === 1).length === 2 && wingTri.length === 0,
      'four feathers a side, mirrored, and w1..w4 opening them one at a time',
      wingTri.length ? `w${wingTri.join(', w')} opens the wrong set`
        : `${wingCls.length} feather polygons — the right-hand set is the same four under a `
          + 'scale(-1 1), so a wing cannot come out lopsided from an edit to one side');

  const need = ['kills', 'hs', ...TRACK_KEYS].filter((k) => !page.includes(`id="g-${k}"`));
  okL(need.length === 0,
      'and every sprite killGlyph can name exists in the defs at the top of the page',
      need.length ? `missing: ${need.join(',')}` : `all ${TRACK_KEYS.length} track sprites plus `
        + 'the crossed rifles and the head — killGlyph can only emit a TRACK_KEYS id or '
        + '#g-kills, and a href to a missing symbol draws an empty hub with no error');

  okL(page.indexOf('id="killmark"') > page.indexOf('id="dead"'),
      'the killmark still comes after #dead in the document',
      'same reason #badge does: a trade kill has to paint its mark over the death overlay, '
      + 'and with no z-index anywhere in the HUD that is decided by document order alone');

  okL(/class="kf-weapon"[\s\S]*?<use href="#g-\$\{weaponId\}"/.test(hudSrc)
      && /class="kf-head"[\s\S]*?<use href="#g-hs"/.test(hudSrc)
      && /class="kf-streak"[\s\S]*?\$\{esc\(streakLabel\)\}/.test(hudSrc)
      && !/&rsaquo;|>HS<|\$\{esc\(WEAPONS\[idAt\(wep\)\]\.label\)\}/.test(hudSrc),
      'the feed is killer, weapon, optional headshot, victim and chain label — never text arrows',
      'the weapon remains visible on a headshot, while the same timed count names the multi-kill');

  okL(/#feed > div \{[\s\S]*?display: flex/.test(page)
      && /#feed \.kf-weapon \{ width: 43px; height: 22px; \}/.test(page)
      && /#feed \.kf-head \{ width: 18px; height: 18px; color: var\(--head-col\); \}/.test(page)
      && /#feed \.kf-streak \{/.test(page),
      'the CS-style feed has a compact dark row, readable icons and a chain tag',
      'icons replace the old trailing “SNIPER HS” text without losing either fact');
}

console.log([...pL, ...fL].join('\n'));


// ─────────────────── Part M: the lobby, and the sides inside it
console.log('\n=== Part M — lobby slots, backfill, and teams (in-process host) ===\n');

const pM = [];
const fM = [];
const okM = (cond, label, detail = '') => {
  (cond ? pM : fM).push(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

/** A client the host can talk to that records what it was told. Nothing in this part
 *  reads a byte off a real socket — only what the rooms hold afterwards, and the two
 *  messages that carry occupancy. */
function fakeClient(host, mode, name, hello = {}) {
  const inbox = [];
  const closed = [];
  const conn = host.connect({
    send: (p) => inbox.push(decode(p)),
    isOpen: () => true,
    close: (code, reason) => closed.push({ code, reason }),
  });
  conn.start();
  conn.message(encode({ t: MSG.HELLO, name, cosmetics: {}, id: null, mode, ...hello }));
  return {
    conn,
    inbox,
    closed,
    welcome: inbox.find((m) => m.t === MSG.WELCOME),
    reject: inbox.find((m) => m.t === MSG.REJECT),
  };
}

/** Deliver the host challenge to a browser-net test and drain the proof microtask. */
async function challengeBrowser(sock, nonce) {
  sock.onmessage?.({ data: encode({ t: MSG.CHALLENGE, n: nonce }) });
  await Promise.resolve();
}

{
  // ── the shared numbers the whole rule is built out of
  const noSlots = MODE_IDS.filter((id) => !Number.isInteger(MODES[id].slots) || MODES[id].slots < 2);
  okM(noSlots.length === 0, 'every mode declares an integer slot count of at least two',
      noSlots.length ? `missing or bad: ${noSlots.join(',')}`
                     : MODE_IDS.map((id) => `${id} ${MODES[id].slots}`).join(', '));

  // A team mode's capacity and its side size are two statements of one fact, and nothing
  // reconciles them at runtime — a teamSize-5 mode with eight slots would quietly run 4v4
  // while every label on it said five a side.
  const teamModes = MODE_IDS.filter((id) => MODES[id].teams);
  const badSize = teamModes.filter((id) => MODES[id].slots !== MODES[id].teamSize * 2);
  okM(teamModes.length > 0 && badSize.length === 0,
      'and a team mode seats exactly two full sides',
      badSize.length
        ? badSize.map((id) => `${id}: ${MODES[id].slots} slots vs ${MODES[id].teamSize}x2`).join(', ')
        : teamModes.map((id) => `${id} ${MODES[id].teamSize}v${MODES[id].teamSize}`).join(', '));

  // The backfill asks for `slots - humans` bots, so the worst case is one player alone. If
  // that exceeds MAX_BOTS then setBots clamps it and the lone player gets a room that is
  // quietly short of bodies — a failure with nothing visible about it.
  const overMax = MODE_IDS.filter((id) => MODES[id].slots - 1 > C.MAX_BOTS);
  const widest = Math.max(...MODE_IDS.map((id) => MODES[id].slots));
  okM(overMax.length === 0,
      'one player alone can be backfilled to a full lobby without hitting the MAX_BOTS clamp',
      overMax.length ? `${overMax.join(',')} need more than MAX_BOTS=${C.MAX_BOTS}`
                     : `worst case ${widest - 1} bots against MAX_BOTS=${C.MAX_BOTS}`);

  okM(!!TEAM_NAMES[1] && !!TEAM_NAMES[2], 'both sides have a name for the HUD to print',
      `1=${TEAM_NAMES[1]}, 2=${TEAM_NAMES[2]}`);

  // ── the two bases, derived from the map rather than typed out a second time
  okM(TEAM_SPAWNS.length === 2 && TEAM_SPAWNS[0].length === TEAM_SPAWNS[1].length,
      'the two bases hold the same number of spawns',
      `${TEAM_SPAWNS[0].length} and ${TEAM_SPAWNS[1].length}`);
  okM(TEAM_SPAWNS[0].length + TEAM_SPAWNS[1].length === SPAWNS.length,
      'and between them account for every spawn on the map',
      `${TEAM_SPAWNS[0].length}+${TEAM_SPAWNS[1].length} of ${SPAWNS.length}`);
  // A spawn ON the halfway line belongs to neither base and is silently dropped by the
  // sign test that builds these. The count check above would still pass if the two halves
  // happened to stay equal, so the midline is checked on its own.
  okM(SPAWNS.every((s) => s.z !== 0),
      'no spawn sits on the halfway line, where it would belong to neither side',
      `nearest the middle: z=${SPAWNS.map((s) => s.z).sort((a, b) => Math.abs(a) - Math.abs(b))[0]}`);
  okM(TEAM_SPAWNS[0].every((s) => s.z < 0) && TEAM_SPAWNS[1].every((s) => s.z > 0),
      'and each base is wholly on its own half',
      `team 1 z: ${TEAM_SPAWNS[0].map((s) => s.z).join(',')} | team 2 z: ${TEAM_SPAWNS[1].map((s) => s.z).join(',')}`);

  // ── the protocol no longer lets a client ask for bots at all
  okM(!('BOTS' in MSG), 'there is no client message for the bot count any more',
      'bots are the remainder of a lobby, not a request — MSG.BOTS is gone');
  okM(MSG.LOBBY === 'lobby', 'and occupancy has a message of its own', `MSG.LOBBY=${MSG.LOBBY}`);
}

{
  // ── the backfill ladder, driven through the real host on a stopped clock — and driven in
  // EVERY mode the server stands up, not only deathmatch.
  //
  // Testing one mode here was a real hole rather than a tidy shortcut. The backfill lives in
  // server/index.js and is written once for all rooms, but a mode's slot count comes from its
  // own entry in shared/modes.js and a team mode routes every join through a controller that
  // deathmatch does not have. So "one human gets nine bots" being true in dm is not evidence
  // about sniper, snowball or team DM, and a player who picks one of those and finds a thin
  // room is the bug this loop exists to catch.
  const host = createHost({ nowNs: () => 0n });
  const roomOf = (m) => host.rooms.get(m).room;
  const live = MODE_IDS.filter((id) => host.rooms.has(id));
  const pending = MODE_IDS.filter((id) => !host.rooms.has(id));

  okM(live.length === host.available.length && live.length > 1,
      'the ladder below runs in every mode the server stands up, not just ' + DEFAULT_MODE,
      `laddering ${live.join(', ')}${pending.length ? `  |  not built yet: ${pending.join(', ')}` : ''}`);

  okM(live.every((m) => roomOf(m).players.size === 0),
      'a room nobody has joined holds nobody at all, in any of them',
      live.map((m) => `${m} ${roomOf(m).players.size}`).join(' '));

  const upTrace = [];
  const downTrace = [];
  const badUp = [];
  const badGate = [];
  const badDown = [];
  const badEmpty = [];

  for (const mode of live) {
    const SLOTS = MODES[mode].slots;
    const seats = [];
    const join = () => {
      const seat = fakeClient(host, mode, `${mode}${seats.length}`);
      seats.push(seat);
      return seat;
    };

    const up = [];
    for (let humans = 1; humans <= SLOTS; humans++) {
      join();
      const r = roomOf(mode);
      up.push(`${humans}h/${r.bots.size}b`);
      if (r.bots.size !== SLOTS - humans || r.players.size !== SLOTS) badUp.push(`${mode}@${humans}h`);
    }
    upTrace.push(`${mode} ${up.join(' ')}`);

    // The menu prevents the ordinary click; the host closes the race and rejects a direct
    // eleventh handshake. Refusal must not disturb the ten people already playing.
    const refused = fakeClient(host, mode, `${mode}-overflow`);
    const over = roomOf(mode);
    if (refused.welcome || refused.reject?.reason !== REJECT.MODE_FULL
        || refused.closed[0]?.code !== 4003
        || over.bots.size !== 0 || over.players.size !== SLOTS) {
      badGate.push(`${mode}: reject=${refused.reject?.reason}, ${over.players.size} bodies, ${over.bots.size} bots`);
    }

    // ── and back down again
    const down = [];
    while (seats.length) {
      seats.pop().conn.drop();
      const r = roomOf(mode);
      const humans = seats.length;
      down.push(`${humans}h/${r.bots.size}b`);
      const wantBots = humans ? Math.max(0, SLOTS - humans) : 0;
      const wantBodies = humans ? Math.max(SLOTS, humans) : 0;
      if (r.bots.size !== wantBots || r.players.size !== wantBodies) badDown.push(`${mode}@${humans}h`);
    }
    downTrace.push(`${mode} ${down.join(' ')}`);
    if (roomOf(mode).players.size !== 0) badEmpty.push(mode);
  }

  okM(badUp.length === 0, "each human who joins takes a bot's place, and the lobby stays exactly full",
      badUp.length ? `wrong at ${badUp.join(', ')}` : upTrace.join('  |  '));
  okM(badGate.length === 0,
      'an eleventh handshake is refused by the host without disturbing the full room',
      badGate.length ? badGate.join(' | ')
                     : `${live.length} modes held at their declared slot count`);
  okM(badDown.length === 0,
      'and a leaver hands their slot straight back to a bot, so the match never thins out',
      badDown.length ? `wrong at ${badDown.join(', ')}` : downTrace.join('  |  '));
  okM(badEmpty.length === 0, 'the last player out empties the room again',
      badEmpty.length ? `still populated: ${badEmpty.join(', ')}`
                      : 'no humans, no bodies, no simulation, in any mode');
}

{
  // ── occupancy on the wire
  const host = createHost({ nowNs: () => 0n });
  const a = fakeClient(host, DEFAULT_MODE, 'alpha');

  okM(!!a.welcome?.lob && typeof a.welcome.lob === 'object',
      'WELCOME carries how full every lobby is', `lob=${JSON.stringify(a.welcome?.lob)}`);
  okM(a.welcome?.lob?.[DEFAULT_MODE] === 1,
      'counting the joiner themselves, and counting HUMANS rather than bodies',
      `${DEFAULT_MODE}=${a.welcome?.lob?.[DEFAULT_MODE]} with `
      + `${host.rooms.get(DEFAULT_MODE).room.players.size} bodies in the room`);
  const firstPop = a.welcome?.pop;
  okM(firstPop?.humans === 1 && firstPop.connected === 1 && firstPop.reserved === 0
      && firstPop.bots === MODES[DEFAULT_MODE].slots - 1
      && firstPop.rooms?.[DEFAULT_MODE]?.state === 'active',
      'WELCOME also tells the full population truth: player, bots, reservations and room state',
      `pop=${JSON.stringify(firstPop)}`);
  okM(a.welcome?.maxBots === undefined,
      'and no longer advertises a bot ceiling, for a slider that no longer exists');

  // The push is what greys a card out while the menu is open, and it has to reach a client
  // in a DIFFERENT room — that case is the entire reason the message exists.
  a.inbox.length = 0;
  const b = fakeClient(host, 'tdm', 'bravo');
  const push = a.inbox.find((m) => m.t === MSG.LOBBY);
  okM(!!push, 'a join in one room is pushed to a client sitting in another',
      push ? `rooms=${JSON.stringify(push.rooms)}` : 'no MSG.LOBBY reached alpha');
  okM(push?.rooms?.tdm === 1 && push?.rooms?.[DEFAULT_MODE] === 1,
      'and names every room, so one handler can repaint every card',
      `rooms=${JSON.stringify(push?.rooms)}`);
  okM(push?.pop?.rooms?.tdm?.connected === 1 && push.pop.rooms.tdm.bots === 9
      && push.pop.bodies === 20 && push.pop.activeRooms === 2,
      'the same push shows how many players and bots occupy each active match',
      `pop=${JSON.stringify(push?.pop)}`);

  a.inbox.length = 0;
  b.conn.drop();
  const freed = a.inbox.find((m) => m.t === MSG.LOBBY);
  okM(freed?.rooms?.tdm === 0, "a leaver frees the slot on everybody else's menu too",
      `rooms=${JSON.stringify(freed?.rooms)}`);
  okM(freed?.pop?.rooms?.tdm?.state === 'dormant'
      && freed.pop.rooms.tdm.bots === 0 && freed.pop.rooms.tdm.bodies === 0,
      'and reports that the emptied match is dormant rather than simulating ten invisible bots',
      `tdm=${JSON.stringify(freed?.pop?.rooms?.tdm)}`);
}

{
  // ── rolling host telemetry uses the same host that enforces admission and drives ticks
  let now = 0n;
  const host = createHost({ nowNs: () => now });
  const a = fakeClient(host, DEFAULT_MODE, 'metrics-alpha');
  now = BigInt(Math.round(1e9 / C.TICK_HZ)) * 6n;
  host.advance();
  const perf = host.metrics();
  const pop = host.population();
  okM(pop.humans === 1 && pop.bots === 9 && pop.bodies === 10
      && pop.capacity === C.REGION_HUMAN_CAP && pop.dormantRooms === host.available.length - 1,
      'the regional population roll-up agrees with its per-room figures',
      `pop=${JSON.stringify(pop)}`);
  okM(perf.admissions.joins === 1 && perf.simulation.steps > 0
      && perf.snapshots.frames > 0 && perf.snapshots.messages > 0
      && perf.traffic.outboundMessages >= perf.snapshots.messages,
      'telemetry counts admissions, simulation work, snapshots and approximate outbound traffic',
      `metrics=${JSON.stringify(perf)}`);
  okM(Number.isFinite(perf.simulation.tickWorkMs.p95)
      && Number.isFinite(perf.simulation.schedulerLateMs.p95),
      'tick work and scheduler delay expose bounded rolling percentiles',
      `work=${JSON.stringify(perf.simulation.tickWorkMs)}, late=${JSON.stringify(perf.simulation.schedulerLateMs)}`);
  a.conn.drop();

  const menuSrc = readFileSync('client/src/menu.js', 'utf8');
  const netSrc = readFileSync('client/src/net.js', 'utf8');
  const mainSrc = readFileSync('client/src/main.js', 'utf8');
  const lobbyHtml = readFileSync('client/index.html', 'utf8');
  okM(menuSrc.includes('setPopulation(next)') && menuSrc.includes('roomPop.bots')
      && netSrc.includes("emit('population', m.pop)"),
      'the browser receives the rich counts and renders bots beside human occupancy',
      'the mode card no longer hides a bot-filled match behind a humans-only fraction');
  okM(['lobby', 'inventory', 'settings'].every((screen) => lobbyHtml.includes(`data-screen="${screen}"`))
      && lobbyHtml.includes('id="open-settings"') && menuSrc.includes('function showScreen(id)'),
      'phase three exposes separate lobby, inventory and settings screens',
      'the game no longer drops every pre-match control into one direct-start panel');
  okM(lobbyHtml.includes('id="profile-rank-icon"') && lobbyHtml.includes('id="profile-rank-fill"')
      && menuSrc.includes('insigniaPng(tier)') && menuSrc.includes('setPlayerStats(next)')
      && mainSrc.includes('menu.setPlayerStats({ career:'),
      'the lobby profile renders the player’s real career rank, insignia and match stats',
      'rank presentation must be driven by the owner-only snapshot rather than placeholder text');
  okM(lobbyHtml.includes('id="inventory-preview-name"') && lobbyHtml.includes('id="inventory-gun"')
      && menuSrc.includes('function renderInventoryPreview(id)')
      && lobbyHtml.includes('<b>authoritative ownership</b>')
      && lobbyHtml.includes('Alpha credits have no cash value')
      && lobbyHtml.includes('promotional items are permanently non-transferable.'),
      'inventory has a working weapon preview and an explicit closed-alpha economy boundary',
      'reviewed purchases are live while trading, cash-out and NFT claims remain disabled');
  okM(mainSrc.includes('menu.setPopulation(m.pop ?? {})')
      && lobbyHtml.includes('id="lobby-region"') && menuSrc.includes('renderRegionSummary()'),
      'the first lobby paint includes authoritative population plus live region and ping context',
      'players should not need a second server event before seeing what they are joining');
  okM((mainSrc.match(/net\.connect\(\)/g) ?? []).length === 1
      && mainSrc.includes("if (lifecycle !== 'lobby') return;")
      && mainSrc.includes("menu.setMatchState('joining')")
      && !mainSrc.trimEnd().endsWith('net.connect();'),
      'opening the homepage stays in the lobby until Join explicitly requests a seat',
      'the only socket connect belongs to the guarded join lifecycle');
  okM(mainSrc.includes('function leaveMatch()') && mainSrc.includes('net.disconnect()')
      && mainSrc.includes('input.release()') && netSrc.includes("socket?.close?.(1000, 'left_match')"),
      'Leave releases pointer lock and closes the match seat intentionally',
      'a menu departure must not look like a dropped connection that reserves and reconnects');
  okM(mainSrc.includes('function finishMatch(ev, players)')
      && mainSrc.includes('xpAtJoin') && mainSrc.includes('pendingMatchResult')
      && menuSrc.includes('showResults(summary)') && menuSrc.includes('toNextRankXp(summary.xpAfter)')
      && ['results', 'result-outcome', 'result-xp', 'result-lobby', 'result-replay', 'leave-match']
        .every((id) => lobbyHtml.includes(`id="${id}"`)),
      'match end opens a results screen with frozen in-match rank, earned combat XP and replay controls',
      'career progress is revealed after combat instead of visibly ranking up during the firefight');
  okM(menuSrc.includes('cbs.onMode?.(id)') && !menuSrc.includes('location.search = qs.toString()')
      && netSrc.includes('mode: requestedMode') && netSrc.includes('setMode(id)'),
      'choosing a room no longer reloads the page and the next HELLO carries that choice',
      'mode selection must remain a lobby action until Join');
  const regionsSrc = readFileSync('client/src/regions.js', 'utf8');
  const serveSrc = readFileSync('server/serve.js', 'utf8');
  okM(serveSrc.includes('avail: host.available')
      && regionsSrc.includes('avail: Array.isArray(body?.avail) ? body.avail : null')
      && mainSrc.includes('adoptLobbyPopulation(await res.json())'),
      'the lightweight lobby probe carries room availability and population before any socket joins',
      'the menu can describe full or unavailable rooms without spending a player seat');
}

{
  // ── regional admission: two full ten-seat modes consume the free-tier target of twenty
  const host = createHost({ nowNs: () => 0n });
  const live = host.available.slice(0, 3);
  const seats = [];
  for (const mode of live.slice(0, 2)) {
    for (let i = 0; i < MODES[mode].slots; i++) {
      seats.push(fakeClient(host, mode, `${mode}-regional-${i}`));
    }
  }
  const refused = fakeClient(host, live[2], 'regional-overflow');
  okM(host.humans === C.REGION_HUMAN_CAP,
      'the process exposes exactly twenty occupied human seats at the regional limit',
      `${host.humans}/${C.REGION_HUMAN_CAP}`);
  okM(seats.every((s) => s.welcome?.cap === C.REGION_HUMAN_CAP),
      'WELCOME advertises the same regional capacity the host enforces',
      `cap=${seats[0]?.welcome?.cap}`);
  okM(!refused.welcome && refused.reject?.reason === REJECT.SERVER_FULL,
      'player twenty-one is refused as SERVER FULL even when their chosen mode has room',
      `reason=${refused.reject?.reason}, ${live[2]}=${host.occupancy()[live[2]]}`);
  okM(refused.reject?.lob && refused.reject.cap === C.REGION_HUMAN_CAP,
      'the refusal carries current occupancy and capacity so the menu can recover honestly',
      `cap=${refused.reject?.cap}, lob=${JSON.stringify(refused.reject?.lob)}`);
  for (const seat of seats) seat.conn.drop();
}

{
  // ── reconnect reservation: an abnormal drop owns the same seat for ten seconds
  const timers = [];
  const cancelled = new Set();
  let token = 0;
  const host = createHost({
    nowNs: () => 0n,
    makeToken: () => `resume-${++token}`,
    setTimer: (fn) => { timers.push(fn); return fn; },
    clearTimer: (fn) => cancelled.add(fn),
  });
  const mode = DEFAULT_MODE;
  const first = fakeClient(host, mode, 'wanderer');
  const firstId = first.welcome?.id;
  const firstToken = first.welcome?.resume;
  first.conn.drop({ reserve: true });
  const heldRoom = host.rooms.get(mode);

  okM(host.occupancy()[mode] === 1 && heldRoom.reserved.size === 1
      && heldRoom.room.players.size === MODES[mode].slots,
      'an abnormal drop reserves one human seat without adding a replacement bot',
      `${host.occupancy()[mode]} seat, ${heldRoom.reserved.size} reserved, `
      + `${heldRoom.room.bots.size} bots`);

  const resumed = fakeClient(host, mode, 'ignored-on-resume', { resume: firstToken });
  okM(resumed.welcome?.id === firstId && resumed.welcome?.resume !== firstToken
      && heldRoom.reserved.size === 0 && heldRoom.clients.size === 1,
      'the opaque token resumes the same body and is rotated after use',
      `#${firstId} -> #${resumed.welcome?.id}, ${firstToken} -> ${resumed.welcome?.resume}`);
  okM(cancelled.has(timers[0]),
      'a successful resume cancels expiration rather than racing it later');

  // A fake cancelled timer may still be invoked; the identity guard must make it harmless.
  timers[0]?.();
  okM(host.occupancy()[mode] === 1 && host.rooms.get(mode).room.players.has(firstId),
      'a stale expiration callback cannot delete a seat that already resumed');

  resumed.conn.drop();
  okM(host.occupancy()[mode] === 0 && host.rooms.get(mode).room.players.size === 0,
      'a normal close frees the resumed seat immediately and returns the room to empty');

  const expiring = fakeClient(host, mode, 'gone');
  expiring.conn.drop({ reserve: true });
  timers.at(-1)?.();
  okM(host.occupancy()[mode] === 0 && host.rooms.get(mode).room.players.size === 0,
      'an unclaimed reservation expires into a clean dormant room');
}

{
  // ── browser reconnect path: retain the opaque token and stop after a real refusal
  const sockets = [];
  const retries = [];
  const statuses = [];
  const refusals = [];
  const openSocket = () => {
    const sent = [];
    const sock = {
      OPEN: 1,
      readyState: 0,
      sent,
      send: (payload) => sent.push(decode(payload)),
      close() {
        if (sock.readyState === 3) return;
        sock.readyState = 3;
        sock.onclose?.({});
      },
    };
    sockets.push(sock);
    return sock;
  };
  const net = createNet({
    url: 'ws://phase-one.test',
    identity: { id: 'local-phase-one', displayName: 'tester', cosmetics: {} },
    mode: DEFAULT_MODE,
    openSocket,
    scheduleRetry: (fn, ms) => { retries.push({ fn, ms }); return fn; },
    cancelRetry: () => {},
  });
  net.on('status', (s) => statuses.push(s));
  net.on('reject', (m) => refusals.push(m));
  net.connect();
  sockets[0].readyState = sockets[0].OPEN;
  sockets[0].onopen?.({});
  await challengeBrowser(sockets[0], 'phase-one-challenge-1');
  const firstHello = sockets[0].sent.find((m) => m.t === MSG.HELLO);
  sockets[0].onmessage?.({ data: encode({
    t: MSG.WELCOME, id: 7, mode: DEFAULT_MODE, resume: 'seat-token', lob: {},
  }) });
  sockets[0].readyState = 3;
  sockets[0].onclose?.({});

  okM(firstHello && firstHello.resume === undefined && retries.length === 1
      && statuses.includes('reconnecting'),
      'an unexpected browser disconnect schedules a reconnect without inventing a token',
      `statuses=${statuses.join(',')}, retry=${retries[0]?.ms}ms`);

  retries[0].fn();
  sockets[1].readyState = sockets[1].OPEN;
  sockets[1].onopen?.({});
  await challengeBrowser(sockets[1], 'phase-one-challenge-2');
  const resumedHello = sockets[1].sent.find((m) => m.t === MSG.HELLO);
  okM(resumedHello?.resume === 'seat-token',
      'the next browser handshake returns the server-issued resume token',
      `resume=${resumedHello?.resume}`);

  sockets[1].onmessage?.({ data: encode({
    t: MSG.REJECT, reason: REJECT.SERVER_FULL, cap: C.REGION_HUMAN_CAP, lob: {},
  }) });
  okM(refusals[0]?.reason === REJECT.SERVER_FULL && retries.length === 1
      && statuses.at(-1) === 'rejected',
      'a capacity refusal reaches the UI and stops the reconnect loop',
      `reason=${refusals[0]?.reason}, statuses=${statuses.join(',')}`);
}

{
  // ── explicit browser lifecycle: no socket before Join, selected mode in HELLO, no retry on Leave
  const sockets = [];
  const retries = [];
  const statuses = [];
  const openSocket = () => {
    const sock = {
      OPEN: 1,
      readyState: 0,
      sent: [],
      closeArgs: null,
      send: (payload) => sock.sent.push(decode(payload)),
      close(...args) {
        sock.closeArgs = args;
        sock.readyState = 3;
        sock.onclose?.({ code: args[0] });
      },
    };
    sockets.push(sock);
    return sock;
  };
  const net = createNet({
    url: 'ws://phase-four.test',
    identity: { id: 'phase-four-player', displayName: 'tester', cosmetics: {} },
    mode: DEFAULT_MODE,
    openSocket,
    scheduleRetry: (fn, ms) => { retries.push({ fn, ms }); return fn; },
    cancelRetry: () => {},
  });
  net.on('status', (s) => statuses.push(s));

  okM(sockets.length === 0 && net.active === false,
      'constructing the browser network layer does not consume a seat before Join');
  net.setMode('sniper');
  net.connect();
  sockets[0].readyState = sockets[0].OPEN;
  sockets[0].onopen?.({});
  await challengeBrowser(sockets[0], 'phase-four-challenge-1');
  const hello = sockets[0].sent.find((m) => m.t === MSG.HELLO);
  okM(hello?.mode === 'sniper' && net.active === true,
      'Join sends the room selected in the lobby and marks the connection active',
      `HELLO mode=${hello?.mode}`);

  net.disconnect();
  okM(sockets[0].closeArgs?.[0] === 1000 && sockets[0].closeArgs?.[1] === 'left_match'
      && retries.length === 0 && net.active === false && statuses.at(-1) === 'idle',
      'Leave closes normally, clears the connection intent and never schedules a reconnect',
      `close=${JSON.stringify(sockets[0].closeArgs)}, retries=${retries.length}, statuses=${statuses.join(',')}`);

  net.setMode('snow');
  net.connect();
  sockets[1].readyState = sockets[1].OPEN;
  sockets[1].onopen?.({});
  await challengeBrowser(sockets[1], 'phase-four-challenge-2');
  const replayHello = sockets[1].sent.find((m) => m.t === MSG.HELLO);
  okM(replayHello?.mode === 'snow' && sockets.length === 2,
      'the same page can Join again after Leave without carrying the old room or resume token',
      `HELLO mode=${replayHello?.mode}`);
  net.disconnect();
}

{
  // ── dormancy: inactive rooms do not spend 60 Hz ticks, and the last leave resets state
  let now = 0n;
  const host = createHost({ nowNs: () => now });
  const activeMode = DEFAULT_MODE;
  const sleepingMode = host.available.find((id) => id !== activeMode);
  const sleeperBefore = host.rooms.get(sleepingMode).room;
  const activeBefore = host.rooms.get(activeMode).room;
  const idleWait = host.advance();
  okM(idleWait >= 50,
      'a host with no audience backs its scheduler off instead of waking every 4ms',
      `${idleWait}ms idle wait`);
  const seat = fakeClient(host, activeMode, 'clock');
  now = 100000000n;
  host.advance();
  okM(activeBefore.tick > 0 && sleeperBefore.tick === 0,
      'only rooms with a connected audience advance their simulation clock',
      `${activeMode} tick ${activeBefore.tick}, ${sleepingMode} tick ${sleeperBefore.tick}`);
  seat.conn.drop();
  const activeAfter = host.rooms.get(activeMode).room;
  okM(activeAfter !== activeBefore && activeAfter.tick === 0
      && activeAfter.players.size === 0 && activeAfter.projectiles.length === 0
      && activeAfter.clouds.length === 0,
      'the last normal leave replaces the match with a clean dormant room',
      `new room=${activeAfter !== activeBefore}, tick=${activeAfter.tick}`);
}

{
  // ── teams: the sides, and who is allowed to shoot whom
  const host = createHost({ nowNs: () => 0n });
  const room = host.rooms.get('tdm').room;
  let joined = 0;
  const join = () => fakeClient(host, 'tdm', `t${joined++}`);
  const sides = () => {
    const bodies = [0, 0];
    const humans = [0, 0];
    for (const p of room.players.values()) {
      if (p.team !== 1 && p.team !== 2) continue;
      bodies[p.team - 1]++;
      if (!room.bots.has(p.id)) humans[p.team - 1]++;
    }
    return { bodies, humans };
  };

  const SIZE = MODES.tdm.teamSize;
  const trace = [];
  let even = true;
  let spread = true;
  for (let humans = 1; humans <= MODES.tdm.slots; humans++) {
    join();
    const { bodies, humans: h } = sides();
    trace.push(`${humans}h ${bodies[0]}v${bodies[1]}`);
    if (bodies[0] !== SIZE || bodies[1] !== SIZE) even = false;
    // THE BUG THIS CATCHES: balancing on bodies alone holds a clean 5v5 while stacking
    // every human onto one side — five people against five bots at five players — and then
    // jams at 6v4 from six players on, because by then the crowded side holds no bot for
    // `rebalance` to move away.
    if (Math.abs(h[0] - h[1]) > 1) spread = false;
  }
  okM(even, `the sides stay ${SIZE}v${SIZE} at every population from one player to ${MODES.tdm.slots}`,
      trace.join(' '));
  okM(spread, 'and the people are spread across both of them rather than stacked on one',
      `at ${MODES.tdm.slots} players: ${sides().humans[0]} v ${sides().humans[1]} humans`);

  // Everyone has to be standing in their OWN base, bots included — they reach the team
  // controller through the same onJoin a person does, which is why bots need no
  // team-aware code anywhere in the codebase.
  const misplaced = [...room.players.values()].filter((p) => (p.team === 1 ? p.z >= 0 : p.z <= 0));
  okM(misplaced.length === 0, 'and every body spawned in its own half of the map',
      misplaced.length ? `${misplaced.length} bodies in the wrong base`
                       : `${room.players.size} bodies checked`);

  const ps = [...room.players.values()];
  const self = ps[0];
  const mate = ps.find((p) => p !== self && p.team === self.team);
  const foe = ps.find((p) => p.team !== self.team);
  okM(room.ctl.canDamage(room, self, foe) === true, 'you can shoot the other side');
  okM(room.ctl.canDamage(room, self, mate) === false, 'friendly fire is off',
      'server/ai.js gates its target picking on this too, so it is also what stops a bot shooting its own side');
  okM(room.ctl.canDamage(room, self, self) === true,
      'but a grenade at your own feet still kills you',
      'self-damage is not friendly fire — the alternative teaches players to lob straight down');
  okM(room.ctl.canDamage(room, null, self) === true,
      'and damage with nobody behind it is let through', 'a null attacker has no side to be friendly to');

  // ── scoring is a TEAM total
  const before = room.snapshotBase().md.ts.slice();
  room.ctl.onKill(room, self, foe);
  const after = room.snapshotBase().md.ts.slice();
  okM(after[self.team - 1] === before[self.team - 1] + 1
      && after[foe.team - 1] === before[foe.team - 1],
      "a kill scores for the killer's side and nobody else's", `${before} -> ${after}`);

  const beforeTk = room.snapshotBase().md.ts.slice();
  const killsTk = self.kills;
  room.ctl.onKill(room, self, mate);
  okM(JSON.stringify(room.snapshotBase().md.ts) === JSON.stringify(beforeTk)
      && self.kills === killsTk,
      'and a team kill credits nothing at all — not the side, not the shooter',
      `${beforeTk} -> ${room.snapshotBase().md.ts}, shooter still on ${killsTk}`);

  const md = room.snapshotBase().md;
  okM(Array.isArray(md.ts) && md.ts.length === 2 && md.w === 0,
      'the mode state carries both team scores, and holds the player-winner field at zero',
      `md=${JSON.stringify(md)}`);
}

{
  // ── the winning SIDE has to travel in a field of its own. `w` is a player id in every
  // other mode and the client resolves it to a name, so a team number in there would
  // announce that whoever joined second had won.
  const host = createHost({ nowNs: () => 0n });
  fakeClient(host, 'tdm', 'w');
  const room = host.rooms.get('tdm').room;
  const ps = [...room.players.values()];
  const self = ps[0];
  const foe = ps.find((p) => p.team !== self.team);

  room.drainEvents();
  for (let i = 0; i < MODES.tdm.killLimit; i++) room.ctl.onKill(room, self, foe);
  const done = room.drainEvents().find((e) => e.e === EV.MATCH);
  okM(done?.ph === 'over', 'reaching the kill limit ends the match', `ev=${JSON.stringify(done)}`);
  okM(done?.wt === self.team && done?.w === 0,
      'and the winner is announced as a SIDE, with the player-id field left at zero',
      `wt=${done?.wt}, w=${done?.w}`);
  okM(room.snapshotBase().md.wt === self.team,
      'the same side is readable from mode state, for a client that joined after the event',
      `md=${JSON.stringify(room.snapshotBase().md)}`);
}

console.log([...pM, ...fM].join('\n'));

// ─────────────────────────────────────────── Part N: regions, pings, and the deploy
console.log('\n=== Part N ' + '\u2014' + ' regions, ping grading, and the blueprint that has to agree ===\n');

// WHY THIS PART EXISTS. Everything a player sees about regions is downstream of four things
// that are each easy to get wrong and silent when wrong: a region table, a ping grader, an
// environment parser, and a deploy file naming hosts nobody typed. A ping display that is
// wrong is worse than none, because it moves somebody to a worse server and tells them it was
// the right call. So the numbers, the words, and the colours are all pinned here.
const pN = [];
const fN = [];
const okN = (cond, label, detail = '') => {
  (cond ? pN : fN).push(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${'\u2014'} ${detail}` : ''}`);
};

{
  // ---------------------------------------------------------------- the table itself
  okN(REGION_IDS.length >= 2, 'the region table names more than one place',
      `${REGION_IDS.length}: ${REGION_IDS.join(', ')}`);
  // An id travels inside `id=url` pairs in one environment variable, so a `=` or a `,` in one
  // would split a peer address in half and the region would silently vanish from the menu.
  const badId = REGION_IDS.filter((id) => !/^[a-z]{2,4}$/.test(id));
  okN(badId.length === 0,
      'every id is lowercase letters only, because ids ride inside a comma-separated env var',
      badId.length ? `offending: ${badId.join(', ')}` : 'sea, usw, usc, use, eu');
  const unlabelled = REGION_IDS.filter((id) => !REGIONS[id].label || !REGIONS[id].where);
  okN(unlabelled.length === 0,
      'and carries both a menu label and the exact place underneath it',
      unlabelled.length ? unlabelled.join(', ') : 'a card with no `where` is a 40ms surprise');
  okN(!Object.hasOwn(REGIONS, HERE),
      `the "this server" id (${HERE}) is not also a real region, or one would shadow the other`);

  okN(isRegion(HERE) && REGION_IDS.every(isRegion), 'isRegion accepts HERE and every listed id');
  okN(!isRegion('sae') && !isRegion('') && !isRegion(undefined),
      'and refuses a typo, an empty string, and nothing at all');
  // `Object.hasOwn`, not `in`: with `in` this would be a region, and a stored `__proto__`
  // would reach the socket code as a hostname lookup on Object.prototype.
  okN(!isRegion('__proto__') && !isRegion('toString'),
      'and is not fooled by an inherited property name');
}

{
  // ---------------------------------------------------------------- pingGrade
  // The boundaries are where the GAME changes, not where the numbers look tidy, so they are
  // worth pinning exactly: an off-by-one here recolours a card and nothing else complains.
  const cases = [
    [0, 'good'], [59, 'good'], [59.9, 'good'],
    [60, 'fair'], [149, 'fair'],
    [150, 'poor'], [249, 'poor'],
    [250, 'bad'], [1000, 'bad'],
  ];
  const wrong = cases.filter(([ms, want]) => pingGrade(ms) !== want);
  okN(wrong.length === 0, 'pingGrade puts every boundary exactly where the duel changes',
      wrong.length ? wrong.map(([ms, w]) => `${ms} wanted ${w} got ${pingGrade(ms)}`).join('; ')
        : '<60 good, <150 fair, <250 poor, then bad');
  okN(pingGrade(NaN) === 'none' && pingGrade(undefined) === 'none' && pingGrade(null) === 'none',
      'and a region that never answered grades as `none` rather than as fast',
      'NaN is what probeRegion returns for a server that is down');

  const rank = { good: 0, fair: 1, poor: 2, bad: 3 };
  let monotone = true;
  for (let ms = 1; ms <= 400; ms++) {
    if (rank[pingGrade(ms)] < rank[pingGrade(ms - 1)]) monotone = false;
  }
  okN(monotone, 'and never grades a slower ping as better than a faster one', 'swept 0..400ms');
}

{
  // ---------------------------------------------------------------- wsOrigin
  okN(wsOrigin('https://a.example.com') === 'wss://a.example.com',
      'an https region becomes a wss socket, which is the only kind an https page may open');
  okN(wsOrigin('http://localhost:8080') === 'ws://localhost:8080',
      'and a plain http checkout becomes ws, port and all');
  // A global replace would corrupt this, and the failure would be a socket to a host that
  // does not exist rather than an error anybody could read.
  okN(wsOrigin('https://http.example.com') === 'wss://http.example.com',
      'and only the leading scheme is swapped, not every "http" in the address');
}

{
  // ---------------------------------------------------------------- fastest
  const rs = [
    { id: 'sea', ms: 210 }, { id: 'usw', ms: NaN }, { id: 'eu', ms: 38 }, { id: 'usc', ms: 91 },
  ];
  okN(fastest(rs)?.id === 'eu', 'fastest picks the lowest ping', `got ${fastest(rs)?.id}`);
  okN(fastest([{ id: 'a', ms: NaN }, { id: 'b', ms: NaN }]) === null && fastest([]) === null,
      'and reports nothing rather than something when no region answered');
  // Ties go to table order so a repaint does not move the FASTEST marker between two cards
  // that are the same distance away.
  okN(fastest([{ id: 'x', ms: 40 }, { id: 'y', ms: 40 }])?.id === 'x',
      'and a tie goes to whoever is listed first, so the marker does not flicker');
}


{
  // ---------------------------------------------------------------- parseRegions
  const good = parseRegions('usw=https://us.example.com,sea=https://sg.example.com');
  okN(good.regions.length === 2 && good.dropped.length === 0,
      'parseRegions accepts a comma-separated `id=url` spec', JSON.stringify(good.regions.map((r) => r.id)));
  // Table order, not spec order, so reordering a deploy config does not reshuffle the menu.
  okN(good.regions.map((r) => r.id).join(',') === 'sea,usw',
      'and returns them in table order however the env var was written',
      `spec said usw first, got ${good.regions.map((r) => r.id).join(',')}`);
  okN(good.regions[0].label === REGIONS.sea.label && good.regions[0].where === REGIONS.sea.where,
      'carrying the compiled-in label and place, which no deploy config gets to invent');

  okN(parseRegions('sea=https://a.example.com\tusw=https://b.example.com').regions.length === 2,
      'whitespace separates as well as a comma, since env vars get pasted with newlines in them');

  const nope = parseRegions([
    'sae=https://typo.example.com',      // an id the table does not know
    'sea=ftp://wrong.example.com',       // a scheme `new WebSocket` cannot be handed
    'usw=https://host.example.com/game', // a path, which would 404 /ping and /regions
    'eu=notaurlatall',                   // not a url in any reading
  ].join(','));
  okN(nope.regions.length === 0 && nope.dropped.length === 4,
      'and refuses an unknown id, a non-http scheme, a url with a path, and junk',
      `dropped ${nope.dropped.length}: ${nope.dropped.join(' ')}`);
  okN(nope.dropped.every((d) => typeof d === 'string' && d.length > 0),
      'reporting the raw text of each so a server can say what it ignored',
      'silently offering fewer regions than somebody configured is the failure being avoided');

  const dup = parseRegions('sea=https://first.example.com,sea=https://second.example.com');
  okN(dup.regions.length === 1 && dup.regions[0].host === 'https://first.example.com'
      && dup.dropped.length === 1,
      'a duplicate id keeps the first address and reports the second',
      `kept ${dup.regions[0]?.host}, dropped ${dup.dropped.join('')}`);

  okN(parseRegions('sea=https://a.example.com/').regions[0]?.host === 'https://a.example.com',
      'a trailing slash is a bare origin and survives, stored without it',
      'endpoints are appended to this, so the stored form has to be the origin');

  // Unset, in every shape an unset environment variable actually arrives in. Note `0` is NOT
  // in this list on purpose: it stringifies to "0", which is junk rather than absence, and
  // gets reported as dropped like any other unparseable chunk.
  for (const empty of [undefined, null, '', '   ']) {
    const r = parseRegions(empty);
    okN(r.regions.length === 0 && r.dropped.length === 0,
        `an unset spec (${JSON.stringify(empty)}) is no regions and no complaint`);
  }
  okN(parseRegions(0).dropped.length === 1 && parseRegions(0).regions.length === 0,
      'while a spec of `0` is junk rather than absence, and is reported as dropped',
      'the difference matters: one is nothing configured, the other is something wrong');
}

{
  // ---------------------------------------------------------------- regionsFromEnv
  // The whole environment path, tested with a plain object rather than by standing serve.js up
  // with a doctored env — which is the reason it lives in shared/regions.js at all.
  const e = regionsFromEnv({
    FPSBONE_REGION: 'sea',
    RENDER_EXTERNAL_HOSTNAME: 'fpsbone-sea.onrender.com',
    FPSBONE_PEER_USW: 'fpsbone.onrender.com',
  });
  okN(e.region === 'sea', 'regionsFromEnv reads which region this process is', `got ${e.region}`);
  okN(e.regions.length === 2 && e.regions.some((r) => r.id === 'sea') && e.regions.some((r) => r.id === 'usw'),
      'and lists both itself and its peer, which is what stops the page you are on appearing '
      + 'as an unlabelled "THIS SERVER" card next to named ones',
      e.regions.map((r) => `${r.id} ${r.host}`).join('  '));
  // A blueprint injects a bare hostname because that is all `fromService` can give it.
  okN(e.regions.every((r) => r.host.startsWith('https://')),
      'a bare hostname from the host gets https, because that is what those hosts serve',
      e.regions.map((r) => r.host).join('  '));

  okN(regionsFromEnv({ FPSBONE_REGION: 'sae' }).region === null
      && regionsFromEnv({}).region === null,
      'an unknown region id, or none, means this process is simply "here"');
  const bare = regionsFromEnv({});
  okN(bare.regions.length === 0 && bare.dropped.length === 0,
      'and an empty environment offers no regions at all, which is what a checkout is');

  okN(regionsFromEnv({ FPSBONE_REGION: 'sea', FPSBONE_HOST: 'mine.example.com' })
    .regions[0]?.host === 'https://mine.example.com',
      'FPSBONE_HOST names this server anywhere that is not Render');
  okN(regionsFromEnv({
    FPSBONE_REGION: 'sea', FPSBONE_HOST: 'chosen.example.com',
    RENDER_EXTERNAL_HOSTNAME: 'injected.example.com',
  }).regions[0]?.host === 'https://chosen.example.com',
      'and outranks the one the host injected, since it was set on purpose');

  // Precedence, which is the property most likely to be got wrong by a later edit: a person's
  // FPSBONE_REGIONS beats a blueprint's injected var, and both beat this process's own guess.
  const prec = regionsFromEnv({
    FPSBONE_REGION: 'sea',
    FPSBONE_HOST: 'self.example.com',
    FPSBONE_PEER_SEA: 'injected.example.com',
    FPSBONE_REGIONS: 'sea=https://hand.example.com',
  });
  okN(prec.regions.length === 1 && prec.regions[0].host === 'https://hand.example.com',
      'a hand-written address wins over an injected one, and both over the process itself',
      `resolved ${prec.regions[0]?.host}`);

  const junk = regionsFromEnv({ FPSBONE_PEER_XX: 'nowhere.example.com', FPSBONE_PEER_SEA: '' });
  okN(junk.regions.length === 0 && junk.dropped.length === 1,
      'an injected peer for an id the table does not know is dropped, not offered blank',
      `dropped ${junk.dropped.join('')}`);
  okN(regionsFromEnv({ FPSBONE_HOST: 'a.example.com' }).regions.length === 0,
      'and a host with no region set adds nothing, because there is no label to show it under');
}

{
  // ---------------------------------------------------------------- socketFor
  okN(socketFor(HERE, 'https://a.example.com') === null,
      'socketFor returns null for "this server", which is the one case needing no address',
      'null keeps the caller on the path that has always worked');
  okN(socketFor(null, 'https://a.example.com') === null && socketFor('sea', '') === null,
      'and for no region, or a region whose address we do not have');
  okN(socketFor('sea', 'https://sg.example.com') === 'wss://sg.example.com',
      'a chosen region becomes a wss url a browser on an https page will actually open',
      socketFor('sea', 'https://sg.example.com'));
  okN(socketFor('sea', 'http://localhost:8080') === 'ws://localhost:8080',
      'and a local region stays ws, so a checkout can point at itself');
}


{
  // ------------------------------------------------- the stored address, validated on read
  // Lifted out of settings.js rather than imported, because that module reaches for
  // localStorage the moment it loads. This one function is the last thing standing between a
  // hand-edited storage entry and `new WebSocket`, so it is worth the regex.
  const src = readFileSync('client/src/settings.js', 'utf8');
  const from = src.indexOf('function httpOrigin(');
  const to = src.indexOf('\n}', from);
  okN(from > 0 && to > from, 'settings.js still has an httpOrigin validator to lift',
      from > 0 ? `${to - from} chars` : 'NOT FOUND - the checks below are vacuous');
  // `publicOrigin` is passed in rather than stubbed: settings.js calls the shared one, and a
  // stub here would let the two disagree about which addresses are dialable.
  const httpOrigin = new Function('publicOrigin', `${src.slice(from, to + 2)}\nreturn httpOrigin;`)(publicOrigin);

  okN(httpOrigin('https://a.example.com') === 'https://a.example.com'
      && httpOrigin('http://localhost:8080') === 'http://localhost:8080',
      'a stored region address survives if it is a bare http(s) origin');
  // Each of these would be turned into a socket url and handed to `new WebSocket`.
  const refused = [
    'javascript:alert(1)', 'file:///etc/passwd', 'ftp://x.example.com',
    'https://a.example.com/path', 'a.example.com', '', '   ', 'not a url',
  ];
  const leaked = refused.filter((v) => httpOrigin(v) !== '');
  okN(leaked.length === 0,
      'and anything else is thrown away rather than dialled',
      leaked.length ? `LEAKED: ${leaked.join(' ')}` : `refused ${refused.length} shapes`);
  okN([null, undefined, 42, {}, []].every((v) => httpOrigin(v) === ''),
      'including values that are not strings at all, which is what a corrupt entry looks like');
  // An address a card already stored before shared/regions.js learned to complete it. Repaired
  // on read, because a returning player would otherwise dial `wss://fpsbone-sea` at load and sit
  // on "connecting…" forever with nothing on screen suggesting the region itself is fine.
  okN(httpOrigin('https://fpsbone-sea') === 'https://fpsbone-sea.onrender.com',
      'a private hostname already in somebody’s storage is completed rather than dialled as-is',
      'the poisoned entry the broken ASIA card wrote');
  okN(httpOrigin('https://fpsbone-sea.onrender.com') === 'https://fpsbone-sea.onrender.com'
      && httpOrigin('http://localhost:8080') === 'http://localhost:8080',
      'and a stored address that was always fine is left exactly as it was');
}

{
  // ------------------------------------------------- the colours the grades are drawn in
  // A grade with no CSS rule renders as an uncoloured number, which is the one outcome worth
  // less than showing nothing: the player reads three digits and has to interpret them alone.
  const html = readFileSync('client/index.html', 'utf8');
  const menuSrc = readFileSync('client/src/menu.js', 'utf8');

  const grades = new Set([pingGrade(NaN)]);
  for (let ms = 0; ms <= 600; ms++) grades.add(pingGrade(ms));
  const missing = [...grades].filter((g) => !html.includes(`.card u.p-${g}`));
  okN(missing.length === 0,
      'every grade pingGrade can return has a colour in the stylesheet',
      missing.length ? `no rule for: ${missing.join(', ')}` : [...grades].join(', '));
  okN(html.includes('.card u.p-wait') && menuSrc.includes('p-wait'),
      'and so does the "still measuring" state, so a card does not resize when the number lands');
  okN(menuSrc.includes('p-${pingGrade('),
      'the class is built from pingGrade rather than from a second list of boundaries',
      'two lists of the same numbers is one list that will disagree with the other');

  okN(html.includes('id="grp-regions"') && html.includes('id="regions"'),
      'the markup the picker fills exists');
  const grp = html.slice(html.indexOf('id="grp-regions"'), html.indexOf('id="grp-regions"') + 40);
  okN(grp.includes('hidden'),
      'and starts hidden, so a single-server deploy never shows a picker with one card in it',
      grp.trim().split('\n')[0]);

  okN(menuSrc.includes('setRegions(') && menuSrc.includes('setPings('),
      'the menu exposes both halves of the picker: the list, and the numbers as they land');
  const mainSrc = readFileSync('client/src/main.js', 'utf8');
  okN(mainSrc.includes('menu.setRegions(') && mainSrc.includes('menu.setPings('),
      'and main.js actually calls them, which is the wire the feature hangs on');
  okN(mainSrc.includes('loadRegions()') && mainSrc.includes('probeAll('),
      'asking this origin for the table and then timing what it names');

  // A `?server=` left in the url outranks the stored region, so a click that did not remove it
  // would silently do nothing and read as a broken picker.
  okN(menuSrc.includes("'server'") && menuSrc.includes('searchParams.delete'),
      'clicking a region clears the url override that would outrank it');

  // Region above VITE_SERVER in the precedence chain: the bundle says whether there IS a
  // server, the player says WHICH one. Reversed, choosing a region would do nothing on the
  // only kind of build where regions exist at all.
  const chain = mainSrc.slice(mainSrc.indexOf('const url ='), mainSrc.indexOf('const url =') + 220);
  okN(chain.indexOf('regionUrl') > 0 && chain.indexOf('regionUrl') < chain.indexOf('bakedUrl'),
      'and a chosen region outranks the server baked in at build time',
      chain.split('\n').slice(1, 3).join(' ').trim());
}


{
  // ------------------------------------------------- the blueprint, checked against the code
  // A DEPLOY FILE IS SOURCE, and it is the kind whose mistakes only appear in production: a
  // peer named after a region the table does not know, or a service pointing at a name no
  // service has, comes up green and simply has nobody in it. Cheap to check here, expensive
  // to notice there.
  const yml = existsSync('render.yaml') ? readFileSync('render.yaml', 'utf8') : '';
  okN(yml.length > 0, 'render.yaml exists, so the deploy is described in the repo, not a dashboard');

  /** Enough of a YAML reader for one known file: services, their scalars, and their env vars. */
  const services = [];
  let cur = null;
  let key = null;
  for (const line of yml.split('\n')) {
    if (line.startsWith('  - type:')) { cur = { env: {}, from: {} }; services.push(cur); key = null; continue; }
    if (!cur) continue;
    const scalar = line.match(/^    ([A-Za-z]+): (.+)$/);
    if (scalar) { cur[scalar[1]] = scalar[2].replace(/^"(.*)"$/, '$1'); key = null; continue; }
    const k = line.match(/^      - key: (.+)$/);
    if (k) { key = k[1]; continue; }
    const v = line.match(/^        value: (.+)$/);
    if (v && key) { cur.env[key] = v[1].replace(/^"(.*)"$/, '$1'); key = null; continue; }
    const n = line.match(/^          name: (.+)$/);
    if (n && key) { cur.from[key] = n[1]; key = null; }
  }

  okN(services.length >= 2, 'and describes more than one region, which is the whole point of it',
      services.map((s) => `${s.name} in ${s.region}`).join('  '));
  okN(new Set(services.map((s) => s.name)).size === services.length,
      'every service has its own name');
  // Two free services in the same city is two-thirds of the free hours for none of the benefit.
  okN(new Set(services.map((s) => s.region)).size === services.length,
      'and its own region, since a region is fixed when a service is created',
      services.map((s) => s.region).join(', '));
  // Render's five, from its docs. A region name it does not know fails the whole blueprint.
  const RENDER_REGIONS = ['oregon', 'ohio', 'virginia', 'frankfurt', 'singapore'];
  const badRegion = services.filter((s) => !RENDER_REGIONS.includes(s.region));
  okN(badRegion.length === 0, 'named with a region the host actually offers',
      badRegion.length ? badRegion.map((s) => s.region).join(', ') : RENDER_REGIONS.join('/'));

  const ids = services.map((s) => s.env.FPSBONE_REGION);
  okN(ids.every((id) => Object.hasOwn(REGIONS, id)),
      'every service is told a region id the compiled table knows', ids.join(', '));
  okN(new Set(ids).size === ids.length, 'and no two services claim to be the same region');

  // Every service must name every OTHER service, or a player on one has no way to reach the
  // other and the menu shows a picker with one live card in it.
  const peerIds = (s) => Object.keys({ ...s.env, ...s.from })
    .filter((x) => x.startsWith('FPSBONE_PEER_'))
    .map((x) => x.slice('FPSBONE_PEER_'.length).toLowerCase());
  const unknownPeer = services.flatMap(peerIds).filter((id) => !Object.hasOwn(REGIONS, id));
  okN(unknownPeer.length === 0, 'every peer var names a region the table knows',
      unknownPeer.length ? unknownPeer.join(', ') : services.flatMap(peerIds).join(', '));

  const wrong = services.filter((s, i) => {
    const want = ids.filter((_, j) => j !== i).sort().join(',');
    return peerIds(s).sort().join(',') !== want;
  });
  okN(wrong.length === 0,
      'and each service is told about every other one, so either page can reach either server',
      wrong.length ? wrong.map((s) => `${s.name} knows [${peerIds(s)}]`).join('; ')
        : services.map((s) => `${s.name} to ${peerIds(s).join('/')}`).join('  '));

  // `fromService` is what makes this zero-configuration: Render substitutes the real hostname,
  // suffix and all. A name that matches no service in the file substitutes nothing.
  const names = new Set(services.map((s) => s.name));
  const serviceRefs = (s) => Object.entries(s.from).filter(([k]) => k.startsWith('FPSBONE_PEER_'));
  const dangling = services.flatMap(serviceRefs)
    .filter((e) => !names.has(e[1]));
  okN(dangling.length === 0,
      'each peer address is filled in by the host from a service that exists in this file',
      dangling.length ? dangling.map((e) => `${e[0]} to ${e[1]}`).join('; ')
        : 'fromService, so nobody types a hostname and nobody gets the suffix wrong');
  // And it must point at the service that IS that region, not merely at some service.
  const byName = new Map(services.map((s) => [s.name, s]));
  const crossed = services.flatMap(serviceRefs)
    .filter((e) => byName.get(e[1])?.env.FPSBONE_REGION
      !== e[0].slice('FPSBONE_PEER_'.length).toLowerCase());
  okN(crossed.length === 0, 'and points at the service that actually is that region',
      crossed.length ? crossed.map((e) => `${e[0]} to ${e[1]}`).join('; ') : 'each peer matched');

  // THE LINE THAT DECIDES WHETHER PLAYERS CAN MEET. A plain `build` deploys a page that looks
  // identical and puts everyone in a private in-tab room against bots.
  const notServerBuild = services.filter((s) => !String(s.buildCommand).includes('run build:server'));
  okN(notServerBuild.length === 0,
      'every service builds with `build:server`, which is what bakes the socket target in',
      notServerBuild.length ? notServerBuild.map((s) => s.name).join(', ')
        : 'a plain `build` would ship localserver.js to everyone');
  okN(services.every((s) => s.startCommand === 'node server/serve.js'),
      'and starts the server directly rather than rebuilding the client on every wake');
  okN(services.every((s) => s.plan === 'free'), 'and nothing here quietly asks for a paid plan');

  const serveSrc = readFileSync('server/serve.js', 'utf8');
  okN(services.every((s) => s.healthCheckPath === '/healthz') && serveSrc.includes("'/healthz'"),
      'the health check path the blueprint names is one the server answers');

  // The two endpoints the menu depends on, and the header without which the ping is a lie.
  // Proven live against a running server by `npm run probe:modes`; asserted here so a rename
  // cannot pass verify on its way to breaking the picker.
  okN(serveSrc.includes("=== '/ping'") && serveSrc.includes("=== '/regions'"),
      'the server answers both endpoints the browser measures and reads the table from');
  const ping = serveSrc.slice(serveSrc.indexOf("=== '/ping'"), serveSrc.indexOf("=== '/regions'"));
  okN(ping.includes("'cache-control': 'no-store'"),
      'and /ping forbids caching, without which every region on earth reports as 0ms',
      'the bug that looks like a triumph');
  okN(ping.includes('...CORS'),
      'and sends CORS, without which every region but your own reads as unreachable',
      'the menu on one region has to ask all of them');
  const statusAt = serveSrc.indexOf("=== '/status'");
  const status = serveSrc.slice(statusAt, serveSrc.indexOf('const abs =', statusAt));
  okN(status.includes("'cache-control': 'no-store'") && status.includes('host.population()')
      && status.includes('host.metrics()') && status.includes('process.memoryUsage()'),
      'an uncached status endpoint reports population, simulation traffic and process memory');
  okN(status.includes('openSockets') && status.includes('rateLimitedTotal')
      && status.includes('handshakeTimeoutTotal')
      && !status.includes('players') && !status.includes('name') && !status.includes('account'),
      'status includes transport pressure but no player identities or account data');

  // ── THE PRIVATE-NAME TRAP. This is the one that reached production: `fromService … property:
  // host` fills in the peer's PRIVATE NETWORK name — `fpsbone-sea`, no domain — and the spec has
  // no property that returns the public hostname. The client was handed `https://fpsbone-sea`,
  // which resolves nowhere, so ASIA read `unreachable` on a server that was answering in 40ms
  // while AMERICA (whose own address comes from RENDER_EXTERNAL_HOSTNAME, and is real) worked.
  // `publicOrigin` now completes a domainless host, and these check the belt as well as it.
  const tables = services.map((s) => parseRegions(s.env.FPSBONE_REGIONS ?? ''));
  const noTable = services.filter((s) => !(s.env.FPSBONE_REGIONS ?? '').trim());
  okN(noTable.length === 0,
      'every service carries an explicit address table, not only a peer name injected by the host',
      noTable.length ? noTable.map((s) => s.name).join(', ') : 'FPSBONE_REGIONS on all of them');
  const domainless = tables.flatMap((t) => t.regions)
    .filter((r) => !new URL(r.host).hostname.includes('.'));
  okN(domainless.length === 0,
      'and every address in it is one a browser can actually resolve, with a domain on the end',
      domainless.length ? domainless.map((r) => r.host).join(' ') : 'the bug that shipped');
  const junked = tables.flatMap((t) => t.dropped);
  okN(junked.length === 0,
      'and every entry parses, rather than being dropped with a log line nobody reads at boot',
      junked.length ? junked.join(' ') : 'nothing ignored');
  const want = ids.slice().sort().join(',');
  const short = services.filter((_, i) => tables[i].regions.map((r) => r.id).sort().join(',') !== want);
  okN(short.length === 0,
      'and names every region in this file, its own included, so either page can reach either server',
      short.length ? short.map((s, i) => `${s.name} lists [${tables[i].regions.map((r) => r.id)}]`).join('; ')
        : `both tables list ${want}`);
  // A Render-default hostname is `<service name>.onrender.com`, so a renamed service and a
  // stale table are catchable. A custom domain is exempt — it can be anything at all.
  const mismatch = tables.flatMap((t) => t.regions).filter((r) => {
    const h = new URL(r.host).hostname;
    const svc = services.find((s) => s.env.FPSBONE_REGION === r.id);
    return svc && h.endsWith('.onrender.com') && h !== `${svc.name}.onrender.com`;
  });
  okN(mismatch.length === 0,
      'and each address is the host of the service that actually is that region',
      mismatch.length ? mismatch.map((r) => `${r.id} at ${r.host}`).join('; ')
        : 'rename a service and this is the check that catches the stale table');
}


// ── THE CARD THE PLAYER ACTUALLY READS.
// Everything above this line is a coupling: a class name that exists in both files, a call
// that is wired up, a precedence that is in the right order. None of it runs `renderRegions`,
// and the markup is exactly where a mistake is invisible to a test and obvious to a player —
// a grade class spelled by hand instead of derived, an occupancy line that reads `undefined
// playing`, a `down` card that is still clickable and dials a server that never answered.
//
// There is no DOM library in this checkout and installing one to render four cards would be
// the tail wagging the dog, so the function is lifted out of menu.js by text and run against
// a stub that records what it was handed. Lifted rather than copied on purpose: a copy of the
// template in here would keep passing long after menu.js stopped agreeing with it.
{
  const menuSrc = readFileSync('client/src/menu.js', 'utf8');
  const at = menuSrc.indexOf('function renderRegions()');
  let end = -1;
  for (let i = menuSrc.indexOf('{', at), d = 0; i > 0 && i < menuSrc.length; i++) {
    if (menuSrc[i] === '{') d++;
    else if (menuSrc[i] === '}' && --d === 0) { end = i + 1; break; }
  }
  const fnSrc = at < 0 || end < 0 ? '' : menuSrc.slice(at, end);
  okN(fnSrc.includes('card.innerHTML') && fnSrc.endsWith('}'),
      'renderRegions can be lifted whole out of menu.js and run without a browser',
      `${fnSrc.length} chars, braces balanced`);

  // The stub is the whole browser this needs: an element that remembers its class, its html
  // and whether anybody bound a click to it.
  const made = [];
  const mkEl = () => {
    const c = { className: '', innerHTML: '', clicks: [] };
    c.addEventListener = (_ev, fn) => c.clicks.push(fn);
    made.push(c);
    return c;
  };
  const stubSet = { patch: null, set(p) { this.patch = p; return this; } };
  const render = (list, active, href = 'https://here.example/?server=ws%3A%2F%2Fx&region=eu&keep=1') => {
    made.length = 0;
    const grp = { hidden: 'untouched' };
    const box = { kids: 'untouched', replaceChildren: (...k) => { box.kids = k; } };
    const loc = { href, reloaded: false, reload() { this.reloaded = true; } };
    stubSet.patch = null;
    new Function(
      'els', 'regions', 'activeRegion', 'fastest', 'pingGrade', 'settings', 'HERE',
      'document', 'location', 'URL',
      `${fnSrc}${String.fromCharCode(10)}return renderRegions();`,
    )({ regionsGrp: grp, regions: box }, list, active ?? null, fastest, pingGrade, stubSet, HERE,
      { createElement: mkEl }, loc, URL);
    return { grp, box, loc, cards: [...made] };
  };

  // Four regions covering every state a card has a different face for: answered fast and
  // occupied, answered slowly, still waking, and never answered at all.
  const fix = [
    { id: 'sea', label: 'ASIA', where: 'Singapore', host: 'https://a.example', ms: 41, humans: 6, state: 'ok', mine: true },
    { id: 'usw', label: 'AMERICA', where: 'Oregon, USA', host: 'https://b.example', ms: 212, humans: 0, state: 'ok' },
    { id: 'eu', label: 'EUROPE', where: 'Frankfurt, Germany', host: 'https://c.example', ms: NaN, humans: null, state: 'waking' },
    { id: 'use', label: 'AMERICA · EAST', where: 'Virginia, USA', host: 'https://d.example', ms: NaN, humans: null, state: 'down' },
  ];

  // ONE SERVER IS NOT A CHOICE — the hidden flag, from the function rather than from the html.
  const one = render([fix[0]], 'sea');
  okN(one.grp.hidden === true && Array.isArray(one.box.kids) && one.box.kids.length === 0,
      'a single-region deploy draws no picker at all, rather than one card that does nothing',
      `hidden=${one.grp.hidden}, ${one.cards.length} cards built`);
  const none = render([], null);
  okN(none.grp.hidden === true && none.cards.length === 0,
      'and neither does a table that arrived empty');

  const four = render(fix, 'usw');
  okN(four.grp.hidden === false && four.cards.length === 4 && four.box.kids.length === 4,
      'four regions draw four cards and reveal the group', `hidden=${four.grp.hidden}`);
  const [sea, usw, eu, use] = four.cards;

  // The number, and the colour it is wearing. `p-good` is derived from pingGrade in the
  // source, so this asserts the two ends of that agree at the boundary that matters: 41ms is
  // the reassuring colour and 212ms is not.
  okN(sea.innerHTML.includes('<u class="p-good">41ms</u>'),
      'a fast region shows its measured round trip in the colour that means "this will feel fine"',
      sea.innerHTML.slice(sea.innerHTML.indexOf('<u')));
  okN(usw.innerHTML.includes('<u class="p-poor">212ms</u>'),
      'and an ocean away shows the same number in the colour that means "you will be leading targets"');
  okN(eu.innerHTML.includes('<u class="p-wait">waking…</u>'),
      'a sleeping free instance says waking… rather than sitting blank for a minute');
  const pend = render(fix.map((r) => ({ ...r, ms: NaN, state: 'pending' })), 'usw');
  okN(pend.cards.every((c) => c.innerHTML.includes('<u class="p-wait">…</u>')),
      'and a probe still in flight says nothing yet in the same place the number will land');

  // The unreachable card. Three separate things have to be true or it is a trap: it looks
  // disabled, it says why, and it cannot be clicked — a card that dials a server which never
  // answered reloads the page onto a socket that will never open.
  okN(use.className.includes('dis') && use.innerHTML.includes('<u class="p-none">unreachable</u>'),
      'a region that never answered is greyed and named unreachable, not hidden',
      `class="${use.className}"`);
  okN(use.innerHTML.includes('no answer — asleep, or not deployed'),
      'and says which of the two it probably is, because on a free tier it is usually asleep');
  okN(use.clicks.length === 0,
      'and is not clickable, so nobody reloads the page onto a server that did not answer');

  // FASTEST is on exactly one card and it is the lowest number on the screen.
  const marked = four.cards.filter((c) => c.innerHTML.includes('FASTEST'));
  okN(marked.length === 1 && marked[0] === sea,
      'exactly one card is marked FASTEST, and it is the one with the lowest ping');
  okN(sea.innerHTML.includes('<em class="mine">THIS PAGE</em>')
      && four.cards.filter((c) => c.innerHTML.includes('THIS PAGE')).length === 1,
      'and the server that sent the html is named once, on the region it actually is');
  okN(usw.className.includes('on') && usw.clicks.length === 0
      && sea.clicks.length === 1 && eu.clicks.length === 1,
      'the region already connected is marked and unclickable; the others are clickable',
      'clicking the one you are on would reload the page to arrive where you already are');

  // Occupancy, including the case that reads as a bug: zero has to print as zero. `0 playing`
  // is the fact a player chooses on — a beautiful ping to an empty room is not the better room
  // — and a falsy test instead of Number.isFinite would silently drop exactly that card.
  okN(sea.innerHTML.includes('Singapore · 6 playing'),
      'a card carries where the server is and how many people are on it');
  okN(usw.innerHTML.includes('Oregon, USA · 0 playing'),
      'and an empty region says 0 playing rather than falling back to bare geography',
      'the whole point of the count is telling those two apart');
  okN(eu.innerHTML.includes('Frankfurt, Germany') && !eu.innerHTML.includes('playing'),
      'while a region that has not answered yet claims no population at all');
  const junk = new RegExp(['undefined', 'NaN', String.fromCharCode(92, 91) + 'object'].join('|'));
  const dirty = four.cards.filter((c) => junk.test(c.innerHTML));
  okN(dirty.length === 0,
      'and no card leaks undefined, NaN or an object into text a player reads',
      dirty.map((c) => c.innerHTML).join(' | ') || 'all four clean');

  // The click. Two things, and the second is why a working store still produced a card that
  // appeared to do nothing: `?server=` in the url outranks the setting that was just written.
  const pick = render(fix, 'usw');
  pick.cards[0].clicks[0]();
  okN(stubSet.patch?.region === 'sea' && stubSet.patch?.regionHost === 'https://a.example',
      'clicking a region stores the id AND the address, so the next load dials it immediately',
      JSON.stringify(stubSet.patch));
  const after = new URL(pick.loc.href);
  okN(!after.searchParams.has('server') && !after.searchParams.has('region')
      && !after.searchParams.has('regionHost'),
      'and drops the query params that would outrank it, which is what made the click look dead',
      pick.loc.href);
  okN(after.searchParams.get('keep') === '1',
      'while leaving every other param on the url alone');

  const dflt = 'https://here.example/?server=ws%3A%2F%2Fx&region=eu&keep=1';
  const hereList = [
    { id: HERE, label: 'THIS SERVER', where: 'this machine', host: 'https://here.example', mine: false, ms: 3, state: 'ok' },
    fix[1],
  ];
  const back = render(hereList, 'usw');
  back.cards[0].clicks[0]();
  okN(stubSet.patch?.region === HERE && stubSet.patch?.regionHost === '',
      'and choosing the page’s own server stores no address, since that one cannot go stale');
  okN(back.loc.reloaded === true || back.loc.href !== dflt,
      'a pick always reloads, because the socket was opened once at load against one address',
      back.loc.reloaded ? 'reload()' : back.loc.href);
}

{
  // ── AN ADDRESS A BROWSER CAN DIAL, which is not the same thing as a valid url.
  // `publicOrigin` exists because of a live failure, not a hypothetical one: the ASIA card read
  // `unreachable` while Singapore answered in 40ms, because the blueprint had injected the peer's
  // PRIVATE network name and `https://fpsbone-sea` resolves nowhere. Everything here is that bug,
  // pinned from both ends — the shape that broke, and the shapes that must not be touched.
  okN(publicOrigin('https://fpsbone-sea') === 'https://fpsbone-sea.onrender.com',
      'a host with no domain on it is completed, because that is what a blueprint can inject',
      'https://fpsbone-sea → nowhere; this is the bug that shipped');
  okN(publicOrigin('fpsbone-sea') === 'https://fpsbone-sea.onrender.com',
      'and so is the same name arriving with no scheme either');
  okN(publicOrigin('https://fpsbone-sea:10000') === 'https://fpsbone-sea.onrender.com',
      'and the private port goes with it, since the public endpoint is 443',
      'property: hostport hands over name:10000');

  // Everything already routable has to come through untouched, or the repair is a new bug.
  const keep = [
    'https://fpsbone-sea.onrender.com',
    'https://fpsbone.onrender.com',
    'https://play.fpsbone.gg',
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'https://a.example.com',
  ];
  const mangled = keep.filter((v) => publicOrigin(v) !== v);
  okN(mangled.length === 0,
      'an address that already resolves is returned exactly as it was',
      mangled.length ? mangled.map((v) => `${v} → ${publicOrigin(v)}`).join('; ')
        : `${keep.length} shapes untouched, custom domains and localhost included`);
  okN(publicOrigin('http://[::1]:8080') === 'http://[::1]:8080',
      'including an IPv6 literal, which has no dot in it and is not a service name');

  const refuse = ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://x.example.com', '', '   '];
  const leaked2 = refuse.filter((v) => publicOrigin(v) !== '');
  okN(leaked2.length === 0,
      'and nothing that is not an http(s) address comes out of it at all',
      leaked2.length ? `LEAKED: ${leaked2.join(' ')}` : `refused ${refuse.length}`);

  // The whole path, from the var a blueprint writes to the url a WebSocket is handed. This is
  // the assertion that would have failed before the deploy went out.
  const injected = regionsFromEnv({ FPSBONE_REGION: 'usw', FPSBONE_HOST: 'fpsbone.onrender.com', FPSBONE_PEER_SEA: 'fpsbone-sea' });
  const sea2 = injected.regions.find((r) => r.id === 'sea');
  okN(sea2?.host === 'https://fpsbone-sea.onrender.com',
      'a peer injected as a bare service name reaches the client as an address, not a private name',
      JSON.stringify(sea2?.host));
  okN(socketFor('sea', sea2?.host) === 'wss://fpsbone-sea.onrender.com',
      'and the socket built from it is one that can open');
  const handWritten = parseRegions('sea=https://fpsbone-sea,usw=https://fpsbone.onrender.com');
  okN(handWritten.regions.length === 2
      && handWritten.regions.every((r) => new URL(r.host).hostname.includes('.')),
      'and a hand-written table with the same mistake in it is repaired the same way',
      handWritten.regions.map((r) => r.host).join(' '));
}
console.log([...pN, ...fN].join('\n'));
// ─────────────────────────────── Part O: the scoreboard, and the two wires behind it
console.log('\n=== Part O ' + '—' + ' the scoreboard: rank, badge and ping, on the two wires that carry them ===\n');

// WHY THIS PART EXISTS. "when you press TAB when you are ingame i dont see their ping their
// rank their badges" — the board is the one screen where a player reads everybody ELSE, and
// each of those three things now arrives differently. A ping changes every tick and rides the
// snapshot. A rank and a badge shelf change a handful of times a career and ride MSG.ROSTER.
// The row a player reads is built out of both, so the split is what this part measures:
//
//   the per-career wire   carries who somebody is, and TIERS ONLY — never a count, because a
//                         count is private to the player who earned it
//   the per-tick wire     carries measured human ping and omits it for server-local bots
//   the row itself        merges them, and is lifted out of hud.js and run, since three.js and
//                         `document` mean that file cannot be imported (see Part J)
const pO = [];
const fO = [];
const okO = (cond, label, detail = '') => {
  (cond ? pO : fO).push(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${'—'} ${detail}` : ''}`);
};

// ─────────────────────────────── publicTiers: what a stranger is allowed to know
{
  // The counts are the private half of a career — `cv` and `bd` go only to their owner in the
  // `self` blob (Part H). A shelf on the roster is what everyone in the room sees, so the one
  // thing it must never carry is the number behind the emblem.
  const top = (k) => BADGES[k].at[(MAX_BADGE_TIER - 1) * MAX_LEVEL];
  const shelf = { kills: 0, rifle: top('rifle'), hs: BADGES.hs.at[0] - 1, knife: BADGES.knife.at[MAX_LEVEL] };
  const pub = publicTiers(shelf);
  okO(pub.rifle === MAX_BADGE_TIER && pub.knife === 2
      && !('kills' in pub) && !('hs' in pub),
      'publicTiers answers a tier per lit track and omits the tracks that are not lit',
      `${JSON.stringify(shelf)} → ${JSON.stringify(pub)} — omit-when-zero, the same economy `
      + 'sp, jm and rk already use, so a brand new player is {i, n} and nothing else');

  // The privacy assertion, and it is a value test rather than a key test on purpose: every
  // threshold in the table is larger than the tier it grants, so a function that forwarded the
  // count instead of the tier would look identical in shape and leak in every field.
  const huge = Object.fromEntries(TRACK_KEYS.map((k) => [k, 99999]));
  const out = publicTiers(huge);
  const leaked = Object.entries(out).filter(([, v]) => !Number.isInteger(v) || v < 1 || v > MAX_BADGE_TIER);
  okO(leaked.length === 0 && Object.keys(out).length === TRACK_KEYS.length,
      'and no value it emits can be a count, on any track, at any size of career',
      leaked.length ? `LEAKED ${JSON.stringify(leaked)}`
        : `${TRACK_KEYS.length} tracks at 99999 kills each → every value in 1..${MAX_BADGE_TIER}`);

  const junk = [undefined, null, {}, { nonsense: 500 }, { kills: -1 }, { kills: '60' }];
  const threw = [];
  const shapes = junk.map((v) => {
    try {
      return JSON.stringify(publicTiers(v));
    } catch (e) {
      threw.push(`${JSON.stringify(v)}: ${e?.message ?? e}`);
      return 'THREW';
    }
  });
  okO(threw.length === 0 && shapes.slice(0, 5).every((s) => s === '{}'),
      'and a missing, empty or nonsense shelf comes back empty rather than throwing',
      threw.length ? `THREW ON ${threw.join('; ')}` : shapes.join(' '));
}

// ─────────────────────────────── the shelf a bot wears, and the row the room hands out
{
  // Forty lobbies' worth, because a shelf is drawn from an id and one lobby is nine ids: a
  // rule that holds for nine and fails for the tenth is a bug somebody meets in their second
  // match. Driven through `setBots` rather than by calling the seed function, which is not
  // exported and should not be — what is under test is the shelf a player actually sees.
  const shelves = [];
  const rows = [];
  for (let pass = 0; pass < 40; pass++) {
    const room = new Room(DEFAULT_MODE);
    room.setBots(MODES[DEFAULT_MODE].slots - 1);
    for (const id of room.bots) shelves.push({ id, bg: room.players.get(id).badges });
    rows.push(...room.rosterState());
  }

  // ON A TIER BOUNDARY, exactly the claim `botBadges` documents. The thresholds are the values
  // `stepOf` is inclusive at, so a bot seeded one short of one would wear the tier below the
  // one it was drawn for — the off-by-one in that comparison, visible on a scoreboard with no
  // test involved, which is precisely why the seeds are aligned to it.
  const off = [];
  const tiers = new Set();
  for (const { id, bg } of shelves) {
    for (const [k, n] of Object.entries(bg)) {
      const t = tierOf(n, k);
      tiers.add(t);
      if (BADGES[k].at[(t - 1) * MAX_LEVEL] !== n) off.push(`#${id} ${k}=${n} reads tier ${t}`);
    }
  }
  okO(off.length === 0 && shelves.length > 300,
      'every bot in forty lobbies is seeded exactly ON a badge threshold, never one short of it',
      off.length ? `OFF BOUNDARY: ${off.slice(0, 4).join(', ')}`
        : `${shelves.length} shelves, tiers ${[...tiers].sort((a, b) => a - b).join('/')} all present`);

  // TWO TO FOUR TRACKS, which is a claim about the ROTATION and not about the badges: one
  // track cannot take turns with itself, and the slot on the board is a slot precisely because
  // a shelf has several things in it. A collision used to shorten the shelf instead of
  // redrawing, and it caught about one bot in fourteen.
  const sizes = shelves.map(({ bg }) => Object.keys(bg).length);
  const hist = {};
  for (const n of sizes) hist[n] = (hist[n] ?? 0) + 1;
  okO(Math.min(...sizes) >= 2 && Math.max(...sizes) <= 4,
      'and wears between two and four of them, so the one rotating slot has something to rotate',
      `sizes ${JSON.stringify(hist)} — a one-track shelf is a static chip in a column whose `
      + 'whole job is to turn over, and twelve is a slot machine');

  // SEEDED FROM THE ID AND NOTHING ELSE, which is what makes a bot wear the same thing in
  // every lobby it is ever drawn into. Proved by lifting the seed function out of room.js as
  // text and calling it with only an id — if the shelves in a real room match a copy that has
  // no room, no tick and no join order to read, then nothing but the id went into them.
  const roomSrc = readFileSync('server/room.js', 'utf8');
  const seedSrc = /\r?\nconst botBadges = \(id\) => \{\r?\n([\s\S]*?)\r?\n\};\r?\n/.exec(roomSrc);
  okO(!!seedSrc, 'the bot shelf seed is still where this suite looks for it',
      seedSrc ? `lifted ${seedSrc[1].split('\n').length} lines out of room.js`
        : 'no match — botBadges was renamed or reshaped, so nothing below it is measured');
  if (seedSrc) {
    const seed = new Function('id', 'TRACK_KEYS', 'MAX_BADGE_TIER', 'MAX_LEVEL', 'BADGES', seedSrc[1]);
    const disagree = shelves.filter(({ id, bg }) =>
      JSON.stringify(bg) !== JSON.stringify(seed(id, TRACK_KEYS, MAX_BADGE_TIER, MAX_LEVEL, BADGES)));
    okO(disagree.length === 0,
        'a shelf is a pure function of the id, so a bot wears the same thing in every lobby',
        disagree.length ? `${disagree.length} of ${shelves.length} differ — first #${disagree[0].id}: `
          + `${JSON.stringify(disagree[0].bg)}`
          : `${shelves.length} shelves reproduced from the id alone — no room state, no tick, `
            + 'no join order, the same argument the career and the brain are seeded on');
  }

  // ── the row itself
  const FIELDS = ['i', 'n', 'rk', 'bg'];
  const strange = rows.flatMap((r) => Object.keys(r).filter((k) => !FIELDS.includes(k)));
  okO(strange.length === 0 && rows.length > 300,
      'a roster row is an id, a name, and the two things that are omitted when they are zero',
      strange.length ? `UNEXPECTED FIELDS: ${[...new Set(strange)].join(', ')}`
        : `${rows.length} rows, fields ${FIELDS.join('/')}`);

  // THE BOT FLAG THAT IS NOT THERE, on the new wire as well as the old one. Part I asserts
  // this of the snapshot; MSG.ROSTER is a second message carrying identity and it would have
  // been the natural place to put one, since it is where a name already lives.
  const flags = rows.filter((r) => Object.keys(r).some((k) => /^(bot|ai|b)$/.test(k)));
  okO(flags.length === 0,
      'and it never marks which rows are bots, for the reason room.js gives at BOT_NAMES',
      'a client written against that flag outlines the humans and ignores everything else — '
      + 'the BOT name prefix is the whole mechanism, and it is a string a player can read too');

  const counted = rows.filter((r) => r.bg && Object.values(r.bg).some((v) => v > MAX_BADGE_TIER));
  okO(counted.length === 0,
      'and carries tiers rather than counts, so a stranger learns the emblem and not the ledger',
      counted.length ? `LEAKED ${JSON.stringify(counted[0])}`
        : `${rows.filter((r) => r.bg).length} shelves on the wire, every value in 1..${MAX_BADGE_TIER}`);
}

// ─────────────────────────────── rosterRev: the integer that decides when to send it
{
  // A REVISION AND NOT A DIRTY FLAG, because one room has several clients: a flag cleared by
  // the first send is a flag the second client never sees. What this measures is the other
  // half — that the number moves on exactly the edges that change a row, and on nothing else.
  const room = new Room(DEFAULT_MODE);
  const at0 = room.rosterRev;
  const ia = room.add('alpha', {}, 'acct-o-a');
  const at1 = room.rosterRev;
  const ib = room.add('bravo', {}, 'acct-o-b');
  const at2 = room.rosterRev;
  room.remove(ib);
  const at3 = room.rosterRev;
  okO(at1 > at0 && at2 > at1 && at3 > at2,
      'a join and a drop each move the revision, so the board is never a name out of date',
      `${at0} → ${at1} → ${at2} → ${at3} across two joins and a drop — and bumped by `
      + '`add` and `remove` themselves rather than by four call sites, one of which is in '
      + 'another file');

  // ── the kill that moves an emblem, and the kill that moves nothing
  const A = room.players.get(ia);
  const B = room.players.get(room.add('victim', {}, null));
  A.protectedUntil = 0;
  B.protectedUntil = 0;
  room.drainEvents();

  // A career and a shelf parked well inside their tiers, so the increment lands nowhere near
  // a boundary. `flat` is found rather than typed: the rank thresholds are close together low
  // down and a hardcoded career would quietly start straddling one when the table is retuned.
  let flat = 4;
  while (flat < 500 && rankOf(flat + 1) !== rankOf(flat)) flat++;
  const inside = (k) => Math.round((BADGES[k].at[0] + BADGES[k].at[MAX_LEVEL]) / 2);
  A.career = flat;
  A.badges = Object.fromEntries(TRACK_KEYS.map((k) => [k, inside(k)]));
  const before = room.rosterRev;
  room.applyDamage(A, B, 500, indexOf('rifle'), HIT_ZONE.HEAD);
  room.drainEvents();
  const quiet = room.rosterRev;
  okO(quiet === before && A.career === flat + 1,
      'a kill that moves a count without moving an emblem costs the room no push at all',
      `career ${flat} → ${A.career}, revision ${before} → ${quiet} — this is the whole reason `
      + 'the kill path compares tiers before and after instead of bumping on every kill: at '
      + 'twenty snapshots a second a push per kill is the rate the split exists to avoid');

  // And the promotion. One short of a rifle threshold, so the same headshot that changed
  // nothing above now changes an emblem — which is a row on somebody else's board. The career
  // goes back to `flat` first, so the rank cannot be what moves the revision here.
  A.alive = true; A.hp = C.MAX_HP; A.protectedUntil = 0;
  B.alive = true; B.hp = C.MAX_HP; B.protectedUntil = 0;
  A.career = flat;
  A.badges.rifle = BADGES.rifle.at[MAX_LEVEL] - 1;
  const was = tierOf(A.badges.rifle, 'rifle');
  room.applyDamage(A, B, 500, indexOf('rifle'), HIT_ZONE.BODY);
  room.drainEvents();
  okO(room.rosterRev > quiet && tierOf(A.badges.rifle, 'rifle') === was + 1,
      'and the one that crosses a threshold moves it, because that is a row that changed',
      `rifle ${BADGES.rifle.at[MAX_LEVEL] - 1} → ${A.badges.rifle}, tier ${was} → `
      + `${tierOf(A.badges.rifle, 'rifle')}, revision ${quiet} → ${room.rosterRev}`);

  // The rank half of the same test, on the wire the roster and the snapshot share. Both read
  // `rankOf` on the same career, and the plate over the head reads it a third time — the one
  // failure shared/ranks.js exists to prevent is those three disagreeing.
  A.career = TIERS[2].at - 1;
  const rankWas = room.rosterRev;
  A.alive = true; A.hp = C.MAX_HP; A.protectedUntil = 0;
  B.alive = true; B.hp = C.MAX_HP; B.protectedUntil = 0;
  room.applyDamage(A, B, 500, indexOf('knife'), HIT_ZONE.BODY);
  room.drainEvents();
  const row = room.rosterState().find((r) => r.i === ia);
  const snapRow = room.snapshotBase().players.find((r) => r.id === ia);
  okO(room.rosterRev > rankWas && row?.rk === rankOf(A.career) && snapRow?.rk === row?.rk,
      'a promotion moves it too, and both wires then report the same rank for the same career',
      `career ${A.career} → roster rk=${row?.rk}, snapshot rk=${snapRow?.rk}, `
      + `rankOf says ${rankOf(A.career)} (${TIERS[rankOf(A.career)]?.name})`);
}

// ─────────────────────────────── pg: the one roster-ish field that belongs in the snapshot
{
  const room = new Room(DEFAULT_MODE);
  room.setBots(4);
  const ih = room.add('unmeasured', {}, null);
  const human = room.players.get(ih);

  const rowsAt = (tick) => {
    room.tick = tick;
    const by = new Map(room.snapshotBase().players.map((r) => [r.id, r]));
    return by;
  };

  // NOBODY HAS MEASURED THIS ONE, and that is a different statement from "the round trip is
  // zero". A socket in the first second of its life has had no pong back yet, and the in-page
  // host measures nothing at all — so the field is absent and hud.js draws an en dash. A `0`
  // on the wire would be a claim, and "0ms" on a board is a claim nobody can act on.
  const fresh = rowsAt(0).get(ih);
  okO(human.ping === 0 && !('pg' in fresh),
      'a player nobody has timed yet carries no ping field at all, rather than a ping of zero',
      `${JSON.stringify(fresh.n)} → ${JSON.stringify(Object.keys(fresh).filter((k) => k === 'pg'))} `
      + '— omit-when-zero, and the absence is what the en dash in the ping column means');

  human.ping = 84.6;
  okO(rowsAt(0).get(ih)?.pg === 85,
      'and one that has been timed carries whole milliseconds, because tenths are not read',
      '84.6 → 85 — no r3() here: a float invites somebody to average it, and the width of the '
      + 'column is three digits either way');

  // ── bots have no internet route: the brain is already inside this Room
  const botIds = [...room.bots];
  const botRows = rowsAt(400);
  const botPings = botIds.map((id) => ({ state: room.players.get(id).ping, wire: botRows.get(id)?.pg }));
  okO(botPings.every((p) => p.state === 0 && p.wire === undefined),
      'bots carry no ping in simulation state or on the wire',
      `${botPings.length} bots all read {state:0, wire:absent} — a server-local AI has no `
      + 'internet route, so a plausible number would be fiction and 0ms would still be a claim');
}

// ─────────────────────────────── the push, through the real host and a stopped clock
{
  // What is under test here is a rate: MSG.ROSTER has to reach every client whose room changed,
  // once, and must NOT ride along with the twenty snapshots a second going the same way. The
  // host decides that with one integer compare per broadcast, which is the only reason the
  // question can be asked at snapshot rate at all.
  let ns = 0n;
  const STEP_NS = BigInt(Math.round(1e9 / C.TICK_HZ));
  const host = createHost({ nowNs: () => ns });
  const seat = (name, rtt) => {
    const inbox = [];
    const wire = { send: (p) => inbox.push(decode(p)), isOpen: () => true };
    if (rtt !== undefined) wire.rtt = () => rtt;
    const conn = host.connect(wire);
    conn.message(encode({ t: MSG.HELLO, name, cosmetics: {}, id: null, mode: DEFAULT_MODE }));
    return { conn, inbox, of: (t) => inbox.filter((m) => m.t === t) };
  };
  // Whole snapshots, so the count below is a count of broadcasts rather than of ticks.
  const pump = (snaps) => {
    for (let i = 0; i < snaps * C.TICKS_PER_SNAPSHOT; i++) {
      ns += STEP_NS;
      host.advance();
    }
  };

  const alpha = seat('alpha', 96);
  pump(10);
  const first = alpha.of(MSG.ROSTER);
  okO(first.length === 1 && alpha.of(MSG.SNAPSHOT).length >= 8,
      'a client is sent the roster once for its join, not once per snapshot',
      `${first.length} roster message(s) against ${alpha.of(MSG.SNAPSHOT).length} snapshots — `
      + 'the revision is compared, not the room, so the answer costs one integer compare at '
      + '20Hz and the message goes out about twice a match');
  okO(first[0]?.players?.length === MODES[DEFAULT_MODE].slots
      && first[0].players.some((r) => r.n === 'alpha'),
      'and it names everybody in the room, the bots that filled it included',
      `${first[0]?.players?.length} rows for a ${MODES[DEFAULT_MODE].slots}-slot lobby: `
      + `${(first[0]?.players ?? []).map((r) => r.n).join(', ')}`);

  // THE SEATED CLIENT, which is the half a dirty flag would have broken: bravo's join changes
  // alpha's board, and alpha is not the client that joined.
  const bravo = seat('bravo', 12);
  pump(6);
  const second = alpha.of(MSG.ROSTER);
  okO(second.length === 2 && second[1].players.some((r) => r.n === 'bravo'),
      'and somebody else arriving pushes a fresh one to the client already sitting there',
      `alpha now holds ${second.length} rosters, the second of which has bravo in it — a dirty `
      + 'flag cleared by the first send is a flag the second client never sees, which is the '
      + 'whole reason this is a revision');

  // ── the transport seam, from the application-level browser round trip to a row
  const mine = alpha.of(MSG.SNAPSHOT).slice(-1)[0]?.players
    ?.find((r) => r.n === 'alpha');
  const theirs = alpha.of(MSG.SNAPSHOT).slice(-1)[0]?.players?.find((r) => r.n === 'bravo');
  okO(mine?.pg === 96 && theirs?.pg === 12,
      'the round trip a transport measured reaches every other player’s row for that body',
      `alpha reads ${mine?.pg}ms for itself and ${theirs?.pg}ms for bravo — measured by the `
      + 'server around a nonce echoed through browser JavaScript rather than reported as a '
      + 'duration by the client, because other players can read this number too');

  // A transport with no clock in it at all — which is exactly client/src/localserver.js, the
  // in-page host, where the only human is on the same thread as the room.
  const quiet = seat('offline', undefined);
  pump(4);
  const own = quiet.of(MSG.SNAPSHOT).slice(-1)[0]?.players?.find((r) => r.n === 'offline');
  okO(own && !('pg' in own),
      'and a transport that measures nothing leaves the field off rather than inventing a zero',
      '`rtt` is optional on the connect contract: the in-page host has no round trip to '
      + 'measure, so its human reads an en dash while the bots beside it read their seeds');

  // ── THE PING COLUMN ITSELF. The transport value above is now an APPLICATION round trip:
  // serve.js sends an unpredictable token, client/src/net.js answers it immediately from
  // JavaScript, and only the matching token stops the server's monotonic timer. That avoids both
  // previous false answers: a WebSocket control pong stopped at Render's edge, while a snapshot
  // echo waited for the next 50ms input batch and counted scheduling as internet latency.
  const hostSrc = readFileSync('server/index.js', 'utf8');
  const netSrc = readFileSync('client/src/net.js', 'utf8');
  const serveSrc = readFileSync('server/serve.js', 'utf8');
  const protocolSrc = readFileSync('shared/protocol.js', 'utf8');
  okO(/PING:\s*'ping'/.test(protocolSrc) && /PONG:\s*'pong'/.test(protocolSrc)
      && /m\.t === MSG\.PING[\s\S]*?rawSend\(\{ t: MSG\.PONG, n: m\.n \}\)/.test(netSrc),
      'the browser immediately echoes the application ping instead of waiting for an input batch',
      'MSG.PING reaches handle() and MSG.PONG leaves through rawSend(), including artificial lag');
  okO(/nonce = randomUUID\(\)/.test(serveSrc)
      && /ws\.send\(encode\(\{ t: MSG\.PING, n: nonce \}\)\)/.test(serveSrc)
      && /m\.n !== nonce/.test(serveSrc) && /performance\.now\(\) - sentAt/.test(serveSrc),
      'the server owns both ends of the timer and only the unpredictable token it sent can stop it',
      'a client returns a nonce, never a duration; a guessed, stale or mismatched pong is ignored');
  okO(!/samplePing|PING_RING|PING_SAMPLE_MS|m\.st\b/.test(hostSrc)
      && /p\.ping = client\.rtt\?\.\(\) \?\? 0/.test(hostSrc),
      'the scoreboard reads that direct transport measurement with no snapshot/input fallback',
      'the removed fallback was the 0–50ms scheduler bias that made different regions look alike');
}

// ─────────────────────────────── the row a player actually reads, lifted out of hud.js
{
  // hud.js cannot be imported — `document` at module scope — so the two functions that build
  // the board are cut out as text and run, the same way Part J lifts the plate and the rank
  // readout. A lift that stops matching FAILS loudly rather than silently testing nothing,
  // which is the only reason this is worth more than reading the file.
  const braced = (src, from) => {
    let depth = 0;
    for (let i = from; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(from, i + 1);
    }
    return null;
  };

  const escSrc = /\r?\nconst esc = ([\s\S]*?);\r?\n/.exec(hudJ);
  const sig = /\n {4}scoreboard\(([^)]*)\) \{/.exec(hudJ);
  const boardSrc = sig ? braced(hudJ, sig.index + sig[0].length - 1) : null;
  // The two rank-cell layers and the map from ping grade to lit bars are module-level. Lift
  // them with the board so this drives the markup that ships rather than a paraphrase.
  const cellAt = hudJ.indexOf('function insigniaCell(');
  const cellSrc = cellAt < 0 ? null : hudJ.slice(cellAt, hudJ.indexOf('{', cellAt))
    + braced(hudJ, hudJ.indexOf('{', cellAt));
  const rankAt = hudJ.indexOf('function rankCell(');
  const rankSrc = rankAt < 0 ? null : hudJ.slice(rankAt, hudJ.indexOf('{', rankAt))
    + braced(hudJ, hudJ.indexOf('{', rankAt));
  const barsSrc = /\nconst SIGNAL_BARS = (\{[^}]*\});/.exec(hudJ);

  okO(!!escSrc && !!boardSrc && !!cellSrc && !!rankSrc && !!barsSrc,
      'the scoreboard and its visible rank cell can be lifted whole out of hud.js and run',
      escSrc && boardSrc && cellSrc && rankSrc && barsSrc
        ? `scoreboard ${boardSrc.length} chars, insigniaCell ${cellSrc.length} chars, `
          + `rankCell ${rankSrc.length} chars, braces balanced`
        : 'no match — one of them was renamed or reshaped, so nothing below it is measured');

  if (escSrc && boardSrc && cellSrc && rankSrc && barsSrc) {
    const BARS = new Function(`return ${barsSrc[1]};`)();
    // Every closure variable becomes a parameter, and `boardHtml` is declared in the wrapper
    // rather than in the body so it survives between calls — the early-out below is a claim
    // about the SECOND call with the same rows, and a body that redeclared it would pass by
    // never having remembered anything.
    const make = new Function('els', 'TIERS', 'MAX_TIER', 'pingGrade',
      'TEAM_NAMES', 'insigniaPng', 'document',
      `const esc = ${escSrc[1]};\n`
      + `const SIGNAL_BARS = ${barsSrc[1]};\n`
      + `const insHave = new Set();\nlet insSheet = null;\n${cellSrc}\n${rankSrc}\n`
      + `let boardHtml = '';\nlet boardTally = '';\n`
      + `return ({ scoreboard(${sig[1]}) ${boardSrc} }).scoreboard;`);

    let html = '';
    let writes = 0;
    let shown = null;
    let cap = '';
    let tally = '';
    let tallyWrites = 0;
    const els = {
      board: { classList: { toggle: (_c, on) => { shown = on; } } },
      boardCap: { set textContent(v) { cap = v; }, get textContent() { return cap; } },
      boardTally: { set innerHTML(v) { tally = v; tallyWrites++; }, get innerHTML() { return tally; } },
      boardRows: { set innerHTML(v) { html = v; writes++; }, get innerHTML() { return html; } },
    };
    // The device arrives as a data URL out of insignia.js, which needs a canvas — Part J runs
    // the real one against a stubbed 2D context. What matters HERE is what the row does with
    // it: one rule per rank ever seen, written once, and a cell that names the rank it drew.
    const rules = [];
    const pngFake = (tier) => (tier >= 0 && tier < TIERS.length
      ? { url: `data:image/png;base64,RANK${tier}`, w: 128, h: 33 } : null);
    const docFake = {
      createElement: () => ({ sheet: { insertRule: (r) => rules.push(r) } }),
      head: { appendChild: () => {} },
    };
    const board = make(els, TIERS, MAX_TIER, pingGrade, TEAM_NAMES, pngFake, docFake);

    // A cast with something to say in every column: a ranked leader, a shelf of three tracks
    // to rotate through, a player with nothing at all, two teams, and a name with markup in it.
    const snap = [
      { id: 1, n: 'snapname', k: 9, d: 2, rk: 4, pg: 42, tm: 1 },
      { id: 2, n: 'ranked', k: 9, d: 1, rk: 20, pg: 240, tm: 2 },
      { id: 3, n: 'BOT Ivy', k: 3, d: 3, pg: 18, tm: 1 },
      { id: 4, n: 'nothing', k: 0, d: 7, tm: 2 },
    ];
    const roster = new Map([
      [1, { i: 1, n: '<script>x</script>', rk: 4, bg: { rifle: 2, hs: 5, knife: 1 } }],
      [2, { i: 2, n: 'ranked', rk: 20 }],
      [3, { i: 3, n: 'BOT Ivy', bg: { sniper: 3 } }],
      [4, { i: 4, n: 'nothing' }],
    ]);
    const draw = (now = 0, show = true, caption = 'deathmatch', teams = null) => {
      board(now, show, snap, roster, 2, caption, teams);
      return html;
    };

    const first = draw();
    const rows = first.split('</tr>').filter(Boolean).map((s) => `${s}</tr>`);
    const rowWith = (needle) => rows.find((r) => r.includes(needle)) ?? '';

    okO(rows.length === 4 && writes === 1 && shown === true && cap === 'deathmatch',
        'four players in the room draw four rows, once, under the caption they were given',
        `${rows.length} rows, ${writes} write(s) to the table body, caption "${cap}"`);

    // THE RANK. The device used over a body is the whole cell; its title keeps the full name.
    // Private's invented recruit shield prevents tier zero looking broken.
    const ga = rowWith('ranked');
    okO(new RegExp(`<td class="rank"><i class="rki t20" title="${TIERS[20].name}"></i></td>`).test(ga)
        && rowWith('nothing').includes('<td class="rank"><i class="rki t0" title="Private"></i></td>')
        && !rows.some((r) => (/<td class="rank">.*?<\/td>/.exec(r)?.[0] ?? '').includes('<b')),
        'every row shows only its rank insignia, including Private',
        `${(/<td class="rank">.*?<\/td>/.exec(ga) ?? [''])[0]} against `
        + `${(/<td class="rank">.*?<\/td>/.exec(rowWith('nothing')) ?? [''])[0]}`);

    // One rule per rank ever seen, inserted once. Every tier carries a device now, and a
    // board redrawn four times must not insert eight rules: the sheet is the cache.
    const tiersSeen = [...new Set([...roster.values()].map((r) => r.rk ?? 0))];
    okO(rules.length === tiersSeen.length
        && rules.every((r) => /^#board td\.rank \.rki\.t\d+\{background-image:url\("data:image\/png/.test(r)),
        'and the device is one CSS rule per tier, written on demand and never twice',
        `${rules.length} rule(s) for ${tiersSeen.length} ranked player(s): `
        + `${rules.map((r) => (/\.rki\.(t\d+)/.exec(r) ?? [])[1]).join(', ')} — a data URL repeated `
        + 'on every row of a table rebuilt while TAB is held is markup nobody needs to diff');

    // THE GRADE COMES OFF `pingGrade`, not out of a literal here, because the claim is that the
    // row and the region card share ONE definition of these colours. A board carrying its own
    // copy of the thresholds would drift from the menu the first time either of them moved, and
    // the drift would be invisible: both still print three digits, in two different inks.
    const pgOf = (row) => (/<td class="pg p-([a-z]+)"><i class="sig l(\d)"><\/i><b>([^<]*)</
      .exec(row) ?? []).slice(1).join(':');
    const want = (ms) => `${pingGrade(ms)}:${BARS[pingGrade(ms)]}:${ms > 0 ? ms : '–'}`;
    const cells = [pgOf(ga), pgOf(rowWith('BOT Ivy')), pgOf(rowWith('nothing'))];
    okO(cells[0] === want(240) && cells[1] === want(18) && cells[2] === want(NaN),
        'a ping is printed with the grade colour pingGrade gives it, and an unmeasured one is a dash',
        `240 → ${cells[0]}, 18 → ${cells[1]}, no field at all → ${cells[2]} — a 0 would be a `
        + 'claim about a round trip nobody has taken yet, so the field is omitted and the column '
        + 'says so with a dash rather than with a number');

    // THE BARS, which are the part a player reads without comparing three digits to a number
    // they remember. The count comes off the same grade as the colour, so a green ping cannot
    // show two bars — and the map has to answer every grade `pingGrade` can produce or a valid
    // connection lights none of them and looks broken.
    const gradeNames = [...new Set(['none', 'good', 'fair', 'poor', 'bad',
      ...[NaN, 0, 59, 60, 149, 150, 249, 250, 4000].map(pingGrade)])];
    const barless = gradeNames.filter((g) => !(g in BARS));
    const idxH = readFileSync('client/index.html', 'utf8');
    const litless = [...new Set(Object.values(BARS))]
      .filter((n) => n > 0 && !idxH.includes(`.sig.l${n}::before`));
    okO(!barless.length && !litless.length && BARS.none === 0 && BARS.good === 4,
        'and every grade lights a number of bars the stylesheet can actually draw',
        barless.length ? `NO BAR COUNT FOR ${barless.join(', ')}`
          : litless.length ? `NO CSS FOR l${litless.join(', l')}`
          : `${gradeNames.map((g) => `${g}=${BARS[g]}`).join(' ')} — an unmeasured ping lights `
            + 'nothing, which is the same claim the en dash makes beside it');

    // And the stylesheet has to answer every name that function can return. A grade with no rule
    // behind it is a ping printed in the table's default ink: the digits still read, and the
    // colour that was the entire reason for grading them silently does not — which is the same
    // class of bug as the empty columns that started this part.
    const grades = gradeNames;
    const unstyled = grades.filter((g) => !idxH.includes(`#board td.p-${g}`));
    okO(unstyled.length === 0 && grades.length === 5,
        'and every grade that function can return has a rule behind it in the stylesheet',
        unstyled.length ? `NO CSS FOR ${unstyled.join(', ')}`
          : `${grades.join('/')} — one selector pairs the board cell with the region card, `
            + '`.card u.p-x, #board td.p-x`, so the two cannot end up two shades of the same claim');

    const shelved = rowWith('&lt;script&gt;');
    okO(!first.includes('class="bgc"') && !first.includes('class="bg b'),
        'the scoreboard carries no badge column or rotating badge chips',
        'rank, player, kills, deaths and ping remain; badge progression stays in its kill card');

    // ── who is who, and what the row is allowed to say about them
    okO(rowWith('ranked').startsWith('<tr class="me tB">')
        && rowWith('BOT Ivy').startsWith('<tr class="tA">'),
        'your own row is marked, and each side carries its own class',
        `${rowWith('ranked').slice(0, 24)}… against ${rowWith('BOT Ivy').slice(0, 22)}… — `
        + 'selfId is passed in rather than read from a module, so the board has no opinion '
        + 'about which client it is running in');

    okO(shelved.includes('&lt;script&gt;') && !first.includes('<script>'),
        'a name is escaped on the way into the row, on the wire that carries the name people chose',
        'MSG.ROSTER carries `n` for every player in the room and a name is the one field a '
        + 'player types — innerHTML on an unescaped one is a script tag every other client runs');

    okO(rowWith('&lt;script&gt;').includes('&lt;script&gt;') && !first.includes('snapname'),
        'the roster’s name wins over the snapshot’s, since it is the wire that carries identity',
        'the snapshot still carries `n` and it is still the fallback for the beat before the '
        + 'first roster lands — a board opened on the first frame of a match is complete');

    // ── the order, and the early-out
    const order = rows.map((r) => (/<td class="who">([^<]*)</.exec(r) ?? [])[1]);
    okO(order.join('|') === ['ranked', '&lt;script&gt;x&lt;/script&gt;', 'BOT Ivy', 'nothing'].join('|'),
        'rows are sorted by kills, then by fewest deaths, then by name',
        `${order.join(' > ')} — two players on nine kills are split by deaths (1 before 2), `
        + 'which is the only tiebreak that means anything on a scoreboard');

    // ── the header band, which is the other half of what "looks like design from 1900s" bought:
    // a bare table had nowhere to put the score, so the score lived only in the middle of the
    // screen. `md.ts` is the mode's own array, so the two cannot disagree about who is winning.
    const ffaTally = tally;
    const twSoFar = tallyWrites;
    draw(0, true, 'team deathmatch', [7, 5]);
    okO(/^\d+ in the room$/.test(ffaTally)
        && tally.includes(`<b class="tA">7</b>`) && tally.includes(`<b class="tB">5</b>`)
        && tally.includes(TEAM_NAMES[1]) && tally.includes(TEAM_NAMES[2])
        && tallyWrites === twSoFar + 1,
        'the header names the match and carries the authoritative score, or the seat count in a FFA',
        `"${ffaTally}" in deathmatch, and 7-5 in a team mode — straight off md.ts rather than `
        + 'counted from the roster, because a side\u2019s score is the mode\u2019s own number and '
        + 'tdm.js is the only thing allowed to have an opinion about it');

    // And it is memoised like the rows are: this runs from the frame loop for as long as TAB is
    // held, and a header rewritten sixty times a second is the same waste in a smaller cell.
    const twBefore = tallyWrites;
    draw(0, true, 'team deathmatch', [7, 5]);
    draw(0, true, 'team deathmatch', [7, 5]);
    okO(tallyWrites === twBefore, 'and a tally that has not changed is not rewritten either',
        `${tallyWrites - twBefore} further write(s) to the header across two more draws`);

    draw();
    const before = writes;
    draw(0);
    draw(0);
    okO(writes === before,
        'and identical rows are not re-parsed, because this runs from the frame loop while TAB is held',
        `${writes - before} further write(s) across two more draws — re-parsing twelve rows of `
        + 'identical HTML sixty times a second is a cost paid on the machines least able to absorb it');

    writes = 0;
    board(0, false, snap, roster, 2, 'hidden');
    okO(writes === 0 && shown === false,
        'and a closed board builds nothing at all, it only stops showing',
        'the early-out is before the sort — a scoreboard nobody is looking at costs one '
        + 'classList toggle per frame');
  }
}

console.log([...pO, ...fO].join('\n'));
// ─────────────────────────────────────────── Part P: account XP
console.log('\n=== Part P — account XP and authoritative match settlement ===\n');
const pP = [], fP = [];
const okP = (cond, label, detail = '') =>
  (cond ? pP : fP).push(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);

{
  const human = matchXp({ participated: true, humanKills: 1 });
  const bot = matchXp({ participated: true, botKills: 1 });
  okP(human.humans === XP_RULES.humanKill && bot.bots === XP_RULES.botKill
      && human.humans === bot.bots * 4,
      'a human elimination is worth four bot eliminations',
      `${human.humans} human XP against ${bot.bots} bot XP`);

  const farm = matchXp({ participated: true, botKills: 100, botHeadshots: 100 });
  okP(farm.bots === XP_RULES.botCap && farm.botXpDiscarded > 0,
      'bot XP has one hard per-match cap, headshots included',
      `${farm.bots} awarded, ${farm.botXpDiscarded} discarded`);

  const idle = matchXp({ participated: false, humanKills: 99, botKills: 99, won: true });
  okP(idle.total === 0, 'an unqualified idle seat earns nothing, even on the winning side',
      `total ${idle.total}`);

  const thresholds = XP_TIERS.every((tier, i) => rankOfXp(tier.at) === i
    && (i === 0 || rankOfXp(tier.at - 1) === i - 1));
  okP(thresholds, 'every XP rank boundary is inclusive and preserves the existing ladder names',
      `${XP_TIERS.length} tiers checked`);

  const room = new Room(DEFAULT_MODE);
  const id = room.add('phase5', {}, 'guest-phase5');
  const player = room.players.get(id);
  player.xp = 0;
  player.career = 20;
  const frozen = room.rosterState().find((row) => row.i === id)?.rk ?? 0;
  player.match.joinedAt = room.now() - XP_RULES.minParticipationSec * 1000;
  Object.assign(player.match, {
    humanKills: 2,
    humanHeadshots: 1,
    botKills: 20,
    botHeadshots: 20,
    assists: 1,
    deaths: 3,
  });
  const saves = [];
  room.onMatch = (account, value) => { saves.push({ account, value }); };
  room.settleMatch({ winnerId: id });
  room.settleMatch({ winnerId: id });
  const receipt = player.pendingResult;
  okP(frozen === 0 && receipt?.rankBefore === 0,
      'career kills can move badges mid-match but the visible account rank stays frozen',
      `public tier ${frozen}, settled from tier ${receipt?.rankBefore}`);
  okP(saves.length === 1 && receipt?.award.total === 710 && player.xp === 710,
      'the server settles a match exactly once and issues the private XP receipt',
      `${saves.length} save, +${receipt?.award.total} XP, account total ${player.xp}`);
  okP(receipt?.stats.matches === 1 && receipt?.stats.wins === 1
      && receipt?.stats.kills === 22 && receipt?.stats.deaths === 3,
      'career stats are updated from the same server ledger as the award',
      JSON.stringify(receipt?.stats));
  room.beginProgressionMatch();
  okP(player.pendingResult === null && player.match.humanKills === 0 && !player.match.settled,
      'the next round clears only the match ledger, never account XP',
      `xp ${player.xp}, receipt ${player.pendingResult}, kills ${player.match.humanKills}`);
}
console.log([...pP, ...fP].join('\n'));
// ─────────────────────────────────────────── Part Q: FOUNDRY 64 environment
console.log('\n=== Part Q — FOUNDRY 64 environment and visual truth ===\n');
const pQ = [], fQ = [];
const okQ = (cond, label, detail = '') =>
  (cond ? pQ : fQ).push(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);

{
  const envSrc = readFileSync('./client/src/environment.js', 'utf8');
  const menuSrc = readFileSync('./client/src/menu.js', 'utf8');
  const renderSrc = readFileSync('./client/src/render.js', 'utf8');
  const gantry = WORLD_BOXES.filter((b) => b.c === 'gantry');
  const midEye = 2.8 + C.PLAYER_HALF_H + C.EYE_OFFSET;
  const luma = (hex) => {
    const r = (hex >> 16) & 255;
    const g = (hex >> 8) & 255;
    const b = hex & 255;
    return r * 0.2126 + g * 0.7152 + b * 0.0722;
  };

  okQ(MAP.id === ENVIRONMENT_ID && MAP.label === 'FOUNDRY 64' && MAP.location.length > 8,
      'the lobby, geometry and renderer share one authored map identity',
      `${MAP.label} · ${MAP.location}`);
  okQ(ZONE_LABELS.join('|') === 'ALPHA|MID|BRAVO' && new Set(ZONE_LABELS).size === 3,
      'the arena has three stable callout zones rather than anonymous grey space',
      ZONE_LABELS.join(' / '));
  okQ(new Set([C.PALETTE.floor, C.PALETTE.wallA, C.PALETTE.wallB, C.PALETTE.stair, C.PALETTE.gantry]).size === 5,
      'floor, concrete, steel cover, climbable stairs and overhead structure have distinct materials',
      'five gameplay surfaces, five albedos');
  const fightingSurfaces = [C.PALETTE.floor, C.PALETTE.wallA, C.PALETTE.wallB].map(luma);
  okQ(Math.min(...fightingSurfaces) > 125 && /toneMappingExposure = 1\.28/.test(renderSrc)
      && /HemisphereLight\(0xf2f7ff, 0xaab3b5, 0\.9\)/.test(renderSrc),
      'the surfaces players fight against stay in daylight, including shadow fill',
      `surface luminance ${fightingSurfaces.map((n) => n.toFixed(0)).join('/')} · exposure 1.28`);
  okQ(gantry.length === 2 && gantry.every((b) => b.y - b.h / 2 > midEye),
      'the visible service bridge is authoritative collision and stays above the raised-mid eye line',
      `${gantry.length} solids, lowest edge ${Math.min(...gantry.map((b) => b.y - b.h / 2)).toFixed(2)}u > mid eye ${midEye.toFixed(2)}u`);
  okQ(/mergeGeometries\(/.test(envSrc) && /new THREE\.InstancedMesh/.test(envSrc),
      'static detail is merged and repeated markings are instanced for low draw-call pressure',
      'geometry batching and GPU instances both present');
  okQ(/buildSky\(scene\)/.test(envSrc) && /buildFloorLanguage\(scene\)/.test(envSrc)
      && /buildWayfinding\(scene\)/.test(envSrc) && /buildSkyline\(scene\)/.test(envSrc),
      'the environment includes atmosphere, navigation paint, callout signs and an exterior skyline',
      'four independent readability layers');
  okQ(!/TextureLoader|fetch\(|https?:\/\//.test(envSrc),
      'the map owns its procedural assets and needs no remote texture host',
      'cold starts and offline practice render the same environment');
  okQ(menuSrc.includes("import { MAP } from '../../shared/map.js'")
      && menuSrc.includes('MAP.label.toLowerCase()'),
      'every lobby card names the battleground before a player joins',
      MAP.label.toLowerCase());
}
console.log([...pQ, ...fQ].join('\n'));
// ─────────────────────────────────────────── Part R: operators and approved finishes
console.log('\n=== Part R — operator identity and approved cosmetics ===\n');
const pR = [], fR = [];
const okR = (cond, label, detail = '') =>
  (cond ? pR : fR).push(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);

{
  const renderSrc = readFileSync('./client/src/render.js', 'utf8');
  const vmSrc = readFileSync('./client/src/viewmodel.js', 'utf8');
  const menuSrc = readFileSync('./client/src/menu.js', 'utf8');
  const htmlSrc = readFileSync('./client/index.html', 'utf8');
  const forbidden = ['damage', 'dmg', 'range', 'spread', 'speed', 'hp', 'armor'];

  okR(FINISH_IDS.length >= 5 && FINISH_IDS[0] === DEFAULT_FINISH
      && FINISH_IDS.every((id) => FINISHES[id].approved)
      && ISSUED_FINISH_IDS.every((id) => FINISHES[id].source === 'base')
      && FINISH_IDS.some((id) => !FINISHES[id].issued),
      'the reviewed catalog distinguishes standard-issue finishes from locked grants',
      `issued ${ISSUED_FINISH_IDS.join(', ')} · catalog ${FINISH_IDS.join(', ')}`);
  okR(FINISH_IDS.every((id) => forbidden.every((key) => !(key in FINISHES[id]))),
      'no finish declares a gameplay stat',
      `${forbidden.join('/')} absent from every cosmetic`);
  okR(JSON.stringify(sanitizeCosmetics({ finish: 'arctic', damage: 999, owner: 'forged' }))
        === JSON.stringify({ finish: 'arctic' })
      && Object.keys(sanitizeCosmetics({ finish: 'not-approved', dmg: 999 })).length === 0
      && Object.keys(sanitizeCosmetics(null)).length === 0,
      'untrusted cosmetic data is reduced to one approved id or standard issue',
      'forged ownership, colour and stat fields discarded');
  okR(finishOf('__missing__') === FINISHES[DEFAULT_FINISH],
      'an unknown finish visibly falls back instead of disappearing');

  okR(OPERATOR_IDS.length === 2 && new Set(OPERATOR_IDS).size === 2,
      'the combat roster has exactly two operator factions', OPERATOR_IDS.join(' / '));
  okR(operatorIdFor(1, 2) === 'sentinel' && operatorIdFor(2, 1) === 'raider'
      && operatorIdFor(0, 1) !== operatorIdFor(0, 2),
      'team modes assign fixed readable factions and free-for-all uses both bodies');
  okR(OPERATOR_IDS.every((id) => {
    const op = OPERATORS[id];
    return new Set([op.primary, op.secondary, op.cloth, op.gear, op.accent]).size === 5;
  }) && operatorFor(1).primary !== operatorFor(2).primary,
      'each operator has a layered palette and the two primary colours remain distinct');

  const room = new Room(DEFAULT_MODE);
  const approvedId = room.add('approved', { finish: 'arctic', damage: 999, color: '#fff' });
  const refusedId = room.add('refused', { finish: 'hacker-gold', damage: 999 });
  const approved = room.players.get(approvedId);
  const refused = room.players.get(refusedId);
  const roster = room.rosterState();
  const snapshot = room.snapshotBase();
  okR(JSON.stringify(approved.cosmetics) === JSON.stringify({ finish: 'arctic' })
      && Object.keys(refused.cosmetics).length === 0,
      'the authoritative room sanitizes both accepted and refused requests on admission');
  okR(roster.find((r) => r.i === approvedId)?.fn === 'arctic'
      && roster.find((r) => r.i === refusedId)?.fn === undefined,
      'the approved finish rides once with static identity and default issue costs no field');
  okR(snapshot.players.every((p) => !('fn' in p) && !('cosmetics' in p)),
      'cosmetics never bloat the 20Hz movement snapshot');

  okR(/sentinelKit/.test(renderSrc) && /raiderKit/.test(renderSrc)
      && /operatorFor\(team, a\.id\)/.test(renderSrc),
      'the third-person renderer switches geometry as well as colour between factions');
  okR(/a\.weaponMat/.test(renderSrc) && !/a\.bodyMat/.test(renderSrc)
      && /setAvatarFinish/.test(renderSrc),
      'remote weapons have finish materials separate from their operator uniform');
  okR(/setFinish\(id\)/.test(vmSrc) && /finishMats/.test(vmSrc),
      'the first-person weapon consumes the same approved finish channels');
  okR(menuSrc.includes('renderFinishes') && menuSrc.includes('cbs.onFinish?.(id)')
      && htmlSrc.includes('id="finishes"') && htmlSrc.includes('id="market-items"'),
      'inventory equips reviewed finishes and keeps the approved marketplace in the same workbench');
  okR(!/ethers|web3|walletconnect|solana|metamask/i.test(menuSrc),
      'the inventory adds no wallet or chain dependency before ownership verification exists');
}
console.log([...pR, ...fR].join('\n'));
// ─────────────────────────────────────────── Part S: signed device accounts
console.log('\n=== Part S — signed device accounts and recovery ===\n');
const pS = [], fS = [];
const okS = (cond, label, detail = '') =>
  (cond ? pS : fS).push(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);

{
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const account = deviceAccountId(publicDer);
  const legacy = 'local-abc12345';
  const signedHello = (challenge, migrate = legacy) => ({
    t: MSG.HELLO,
    name: 'signed tester',
    mode: DEFAULT_MODE,
    id: 'device-client-cannot-choose-this',
    cosmetics: {},
    ...(migrate ? { legacy: migrate } : {}),
    auth: {
      v: 1,
      alg: 'ES256',
      key: publicDer,
      sig: sign(
        'sha256',
        Buffer.from(proofText(challenge, migrate ?? '')),
        { key: privateKey, dsaEncoding: 'ieee-p1363' },
      ).toString('base64url'),
    },
  });

  const valid = verifyDeviceIdentity(signedHello('fresh-challenge'), 'fresh-challenge');
  okS(valid?.id === account && valid?.type === 'device' && valid?.legacy === legacy,
      'a valid P-256 proof derives the storage account from its public key',
      account);
  const webPair = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  const webKey = Buffer.from(
    await globalThis.crypto.subtle.exportKey('spki', webPair.publicKey),
  ).toString('base64url');
  const webChallenge = 'browser-webcrypto-challenge';
  const webSignature = Buffer.from(await globalThis.crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    webPair.privateKey,
    Buffer.from(proofText(webChallenge)),
  )).toString('base64url');
  const webIdentity = verifyDeviceIdentity({
    auth: { v: 1, alg: 'ES256', key: webKey, sig: webSignature },
  }, webChallenge);
  okS(webIdentity?.id === deviceAccountId(webKey),
      'a real browser-format WebCrypto signature verifies on the Node host');
  let replayRefused = false;
  try { verifyDeviceIdentity(signedHello('first-challenge'), 'different-challenge'); } catch {
    replayRefused = true;
  }
  okS(replayRefused,
      'a captured proof cannot be replayed on the next socket challenge');
  const changedLegacy = signedHello('migration-challenge');
  changedLegacy.legacy = 'local-other123';
  let migrationTamperRefused = false;
  try { verifyDeviceIdentity(changedLegacy, 'migration-challenge'); } catch {
    migrationTamperRefused = true;
  }
  okS(migrationTamperRefused,
      'the legacy account being migrated is covered by the signature');
  okS(verifyDeviceIdentity({ t: MSG.HELLO }, 'guest-challenge') === null,
      'an unsigned browser is explicitly a guest rather than a fake account');
  let malformedRefused = false;
  try {
    verifyDeviceIdentity({ auth: { v: 1, alg: 'ES256', key: 'x'.repeat(500), sig: 'bad' } }, 'x');
  } catch { malformedRefused = true; }
  okS(malformedRefused,
      'oversized or malformed identity material is rejected before crypto parsing');

  const makeRanks = () => {
    const profiles = [];
    const claims = [];
    return {
      profiles,
      claims,
      profileOf(id) {
        profiles.push(id);
        return { xp: 0, career: 0, badges: {}, stats: {} };
      },
      claimLegacy(from, to) { claims.push([from, to]); },
      setCareer: () => {},
      settleMatch: () => {},
      storageState: () => ({ kind: 'test', durable: true }),
    };
  };
  const openClient = (host) => {
    const inbox = [];
    const closed = [];
    const conn = host.connect({
      send: (payload) => inbox.push(decode(payload)),
      isOpen: () => true,
      close: (code, reason) => closed.push({ code, reason }),
    });
    conn.start();
    return { conn, inbox, closed, challenge: inbox.find((m) => m.t === MSG.CHALLENGE)?.n };
  };

  const signedRanks = makeRanks();
  let signedToken = 0;
  const signedHost = createHost({
    nowNs: () => 0n,
    ranks: signedRanks,
    makeToken: () => `signed-token-${++signedToken}`,
    resolveIdentity: verifyDeviceIdentity,
  });
  const signed = openClient(signedHost);
  await signed.conn.message(encode(signedHello(signed.challenge)));
  const signedWelcome = signed.inbox.find((m) => m.t === MSG.WELCOME);
  okS(signedWelcome?.account?.type === 'device'
      && signedRanks.profiles[0] === account
      && JSON.stringify(signedRanks.claims[0]) === JSON.stringify([legacy, account]),
      'the host files progression only under the verified account and migrates its old row',
      `account=${signedRanks.profiles[0]}, type=${signedWelcome?.account?.type}`);

  const forgedRanks = makeRanks();
  let forgedToken = 0;
  const forgedHost = createHost({
    nowNs: () => 0n,
    ranks: forgedRanks,
    makeToken: () => `forged-token-${++forgedToken}`,
    resolveIdentity: verifyDeviceIdentity,
  });
  const forged = openClient(forgedHost);
  await forged.conn.message(encode(signedHello('somebody-elses-challenge')));
  okS(forged.inbox.some((m) => m.t === MSG.REJECT && m.reason === REJECT.IDENTITY_INVALID)
      && forgedRanks.profiles.length === 0 && forgedHost.humans === 0,
      'a forged identity is refused before it can claim a seat or read a profile');

  const guestRanks = makeRanks();
  let guestToken = 0;
  const guestHost = createHost({
    nowNs: () => 0n,
    ranks: guestRanks,
    makeToken: () => `guest-token-${++guestToken}`,
    resolveIdentity: verifyDeviceIdentity,
  });
  const guest = openClient(guestHost);
  await guest.conn.message(encode({
    t: MSG.HELLO,
    name: 'guest',
    mode: DEFAULT_MODE,
    id: 'device-forged-storage-key',
    legacy,
    cosmetics: {},
  }));
  const guestWelcome = guest.inbox.find((m) => m.t === MSG.WELCOME);
  okS(guestWelcome?.account?.type === 'guest' && guestRanks.profiles[0] === null
      && guestRanks.claims.length === 0 && guestHost.humans === 1,
      'unsigned clients may play, but cannot select or migrate a durable progression row');

  const identitySrc = readFileSync('./client/src/identity.js', 'utf8');
  const netSrc = readFileSync('./client/src/net.js', 'utf8');
  const menuSrc = readFileSync('./client/src/menu.js', 'utf8');
  const htmlSrc = readFileSync('./client/index.html', 'utf8');
  okS(netSrc.includes('MSG.CHALLENGE') && netSrc.includes('identity.prove?.(m.n)')
      && !/onopen\s*=\s*\(\)\s*=>\s*rawSend\(\{\s*t:\s*MSG\.HELLO/.test(netSrc),
      'the browser waits for a fresh challenge before sending its HELLO');
  okS(identitySrc.includes("generateKey(CURVE") && identitySrc.includes("crypto.subtle.sign")
      && identitySrc.includes('exportRecoveryCode') && identitySrc.includes('importRecoveryCode'),
      'the browser mints a non-password signing key and supports portable recovery');
  okS(htmlSrc.includes('data-pane="account"') && htmlSrc.includes('id="recovery-code"')
      && htmlSrc.includes('Anyone holding this code owns the account.'),
      'Account settings explain recovery and keep the private code hidden until requested');
  okS(!/from\s+['"][^'"]*(ethers|web3|walletconnect|metamask)/i.test(identitySrc),
      'account ownership adds no wallet SDK or password service dependency');
}
console.log([...pS, ...fS].join('\n'));
// ─────────────────────────────────────────── Part T: authoritative inventory and creator queue
console.log('\n=== Part T — authoritative inventory and creator queue ===\n');
const pT = [], fT = [];
const okT = (cond, label, detail = '') =>
  (cond ? pT : fT).push(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);

{
  const promo = FINISH_IDS.find((id) => !FINISHES[id].issued);
  const baseInventory = sanitizeInventory(['unknown', 3, null]);
  const grantedInventory = sanitizeInventory([promo, promo, 'unknown']);
  okT(baseInventory.length === ISSUED_FINISH_IDS.length
      && ISSUED_FINISH_IDS.every((id) => baseInventory.includes(id)),
      'every account receives only the issued set by default', baseInventory.join(', '));
  okT(!sanitizeOwnedCosmetics({ finish: promo }, baseInventory).finish
      && sanitizeOwnedCosmetics({ finish: promo }, grantedInventory).finish === promo,
      'catalog approval alone cannot equip a locked finish; an account grant can');

  let clock = 1_000;
  let tokenNo = 0;
  const claims = [];
  const gateway = createAccountGateway({
    ranks: { async claimLegacy(from, to) { claims.push([from, to]); } },
    adminToken: 'private-review-token',
    now: () => clock,
    makeToken: () => `account-nonce-${++tokenNo}`,
  });
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const legacy = 'local-phase9test';
  const accountBody = (challenge, withLegacy = true) => ({
    challenge,
    ...(withLegacy ? { legacy } : {}),
    auth: {
      v: 1,
      alg: 'ES256',
      key: publicDer,
      sig: sign('sha256', Buffer.from(proofText(challenge, withLegacy ? legacy : '')),
        { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'),
    },
  });
  const issued = gateway.issue('profile');
  const verified = await gateway.authenticate('profile', accountBody(issued.challenge));
  let replayDenied = false;
  try { await gateway.authenticate('profile', accountBody(issued.challenge)); } catch {
    replayDenied = true;
  }
  okT(verified.id === deviceAccountId(publicDer) && claims.length === 1 && replayDenied,
      'a signed account action consumes one purpose-bound challenge exactly once');
  const wrongPurpose = gateway.issue('profile');
  let purposeDenied = false;
  try { await gateway.authenticate('equip', accountBody(wrongPurpose.challenge)); } catch {
    purposeDenied = true;
  }
  okT(purposeDenied && gateway.pending === 0,
      'a profile proof cannot be replayed as an equip or submission action');
  const expiring = gateway.issue('submit');
  clock = expiring.expires + 1;
  let expiredDenied = false;
  try { await gateway.authenticate('submit', accountBody(expiring.challenge)); } catch {
    expiredDenied = true;
  }
  okT(expiredDenied && gateway.isAdmin('Bearer private-review-token')
      && !gateway.isAdmin('Bearer private-review-token-x'),
      'expired proofs fail and review access requires the exact configured bearer secret');

  const granted = new Set();
  const authorityRanks = {
    claimLegacy: async () => {},
    profileOf: () => ({ career: 0, badges: {}, xp: 0, stats: {},
      inventory: sanitizeInventory([...granted]), equipped: {} }),
    async authorizeCosmetics(id, raw) {
      const inventory = sanitizeInventory([...granted]);
      return {
        profile: { career: 0, badges: {}, xp: 0, stats: {}, inventory, equipped: {} },
        cosmetics: sanitizeOwnedCosmetics(raw, inventory),
      };
    },
    setCareer: () => {}, settleMatch: () => {},
    storageState: () => ({ kind: 'test', durable: true }),
  };
  let hostToken = 0;
  const authorityHost = createHost({
    nowNs: () => 0n, ranks: authorityRanks, makeToken: () => `phase9-host-${++hostToken}`,
    resolveIdentity: () => ({ id: deviceAccountId(publicDer), type: 'device' }),
  });
  const connectWith = async (name) => {
    const inbox = [];
    const conn = authorityHost.connect({
      send: (payload) => inbox.push(decode(payload)), isOpen: () => true, close: () => {},
    });
    conn.start();
    await conn.message(encode({ t: MSG.HELLO, name, mode: DEFAULT_MODE,
      cosmetics: { finish: promo } }));
    return { inbox, welcome: inbox.find((m) => m.t === MSG.WELCOME) };
  };
  const refused = await connectWith('locked requester');
  granted.add(promo);
  const allowed = await connectWith('granted owner');
  const roster = authorityHost.rooms.get(DEFAULT_MODE).room.rosterState();
  okT(!roster.find((row) => row.i === refused.welcome.id)?.fn
      && roster.find((row) => row.i === allowed.welcome.id)?.fn === promo
      && !refused.welcome.inventory.owned.includes(promo)
      && allowed.welcome.inventory.owned.includes(promo),
      'the match host rechecks ownership and sends the same authoritative inventory in WELCOME');

  const ranksSrc = readFileSync('./server/ranks.js', 'utf8');
  const serveSrc = readFileSync('./server/serve.js', 'utf8');
  const reviewSrc = readFileSync('./client/src/review.js', 'utf8');
  const reviewHtml = readFileSync('./client/review.html', 'utf8');
  const lobbyHtml = readFileSync('./client/index.html', 'utf8');
  okT(ranksSrc.includes('procedural_palette_v1') && ranksSrc.includes('submission_palette')
      && ranksSrc.includes('MAX_SUBMISSIONS_PER_ACCOUNT')
      && !reviewHtml.includes('type="file"'),
      'community concepts are bounded palettes and text, never executable files or remote URLs');
  okT(serveSrc.includes("process.env.FPSBONE_ADMIN_TOKEN")
      && serveSrc.includes("review_not_configured")
      && reviewSrc.includes('authorization: `Bearer ${token}`')
      && lobbyHtml.includes('it does not publish automatically'),
      'review is private, disabled without a secret, and approval cannot publish by itself');
  okT(lobbyHtml.includes('.inventory-grid { min-height: 430px')
      && lobbyHtml.includes('.screen[data-screen="inventory"].on { display: block;'),
      'the creator workbench flows below the inventory instead of covering the finish list');
  okT(accountOrigin('wss://fpsbone-sea.onrender.com/socket', 'https://game.invalid')
        === 'https://fpsbone-sea.onrender.com'
      && accountOrigin('ws://localhost:8787', 'http://localhost:5173') === 'http://localhost:8787',
      'lobby account calls follow the selected game region over HTTP without taking a seat');
}
console.log([...pT, ...fT].join('\n'));
// ─────────────────────────────────────────── Part U: closed alpha economy
console.log('\n=== Part U — closed alpha marketplace and economy ===\n');
const pU = [], fU = [];
const okU = (cond, label, detail = '') =>
  (cond ? pU : fU).push(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);

{
  const idle = matchCredits({ participated: false, won: true, match: { humanKills: 99 } });
  const earned = matchCredits({
    participated: true, won: true,
    match: { humanKills: 2, botKills: 99, assists: 3, objectives: 1 },
  });
  okU(idle.total === 0 && earned.total === CREDIT_RULES.participation
      + 2 * CREDIT_RULES.humanKill + CREDIT_RULES.botCap
      + 3 * CREDIT_RULES.assist + CREDIT_RULES.objective + CREDIT_RULES.win,
      'credits come only from qualifying server-owned match facts',
      `idle ${idle.total}, earned ${earned.total}`);
  okU(earned.bots === CREDIT_RULES.botCap
      && CREDIT_RULES.humanKill > CREDIT_RULES.botKill,
      'bot farming is capped and a human elimination remains more valuable',
      `${CREDIT_RULES.humanKill} human, ${CREDIT_RULES.botKill} bot, ${CREDIT_RULES.botCap} bot cap`);

  const catalog = publicMarket([]);
  okU(STARTER_CREDITS > 0 && catalog.length === Object.keys(MARKET_ITEMS).length
      && catalog.every((item) => FINISHES[item.finish]?.approved
        && !FINISHES[item.finish].issued && item.price > 0
        && item.transferable === false && item.provenance === 'approved_catalog'),
      'the alpha catalog contains only approved locked cosmetics with non-transferable provenance',
      catalog.map((item) => `${item.finish}:${item.price}`).join(', '));
  okU(catalog.every((item) => !['damage', 'dmg', 'range', 'spread', 'speed', 'hp', 'armor']
    .some((key) => key in item)),
      'market items cannot carry gameplay statistics');

  let accountClock = 10_000;
  let accountNonce = 0;
  const economyGateway = createAccountGateway({
    ranks: { claimLegacy: async () => {} }, now: () => accountClock,
    makeToken: () => `economy-nonce-${++accountNonce}`,
  });
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const purchaseChallenge = economyGateway.issue('purchase');
  const purchaseBody = {
    challenge: purchaseChallenge.challenge,
    auth: {
      v: 1, alg: 'ES256', key: publicDer,
      sig: sign('sha256', Buffer.from(proofText(purchaseChallenge.challenge, '')),
        { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'),
    },
  };
  const purchaseIdentity = await economyGateway.authenticate('purchase', purchaseBody);
  let replayDenied = false;
  try { await economyGateway.authenticate('purchase', purchaseBody); } catch { replayDenied = true; }
  okU(purchaseIdentity.id === deviceAccountId(publicDer) && replayDenied,
      'a purchase needs its own fresh signed challenge and cannot be replayed');

  const economyFile = join(tmpdir(), `fpsbone-economy-${process.pid}-${Date.now()}.json`);
  const oldRanksFile = process.env.FPSBONE_RANKS;
  const oldDatabase = process.env.DATABASE_URL;
  process.env.FPSBONE_RANKS = economyFile;
  delete process.env.DATABASE_URL;
  const economyRanks = await import(`./server/ranks.js?economy=${Date.now()}`);
  const buyer = `device-${'a'.repeat(32)}`;
  const poorBuyer = `device-${'b'.repeat(32)}`;
  const firstItem = catalog.find((item) => item.price <= STARTER_CREDITS);
  const bought = await economyRanks.purchaseFinish(buyer, firstItem.finish);
  let duplicateDenied = false;
  try { await economyRanks.purchaseFinish(buyer, firstItem.finish); } catch (err) {
    duplicateDenied = err?.message === 'already_owned';
  }
  let overspendDenied = false;
  const expensive = catalog.find((item) => item.price > STARTER_CREDITS);
  try { await economyRanks.purchaseFinish(poorBuyer, expensive.finish); } catch (err) {
    overspendDenied = err?.message === 'insufficient_credits';
  }
  okU(bought.profile.credits === STARTER_CREDITS - firstItem.price
      && bought.profile.inventory.includes(firstItem.finish) && duplicateDenied && overspendDenied,
      'a purchase deducts once, unlocks once, and refuses double ownership or overspending',
      `${STARTER_CREDITS} → ${bought.profile.credits}, ${firstItem.finish} owned`);

  const result = {
    id: 'economy-receipt-one', participated: true, won: false,
    match: { humanKills: 1, botKills: 2, assists: 0, objectives: 0 },
  };
  const award = matchCredits(result).total;
  await economyRanks.settleMatch(buyer, { career: 1, xp: 100, stats: {}, result });
  const paidOnce = economyRanks.profileOf(buyer);
  await economyRanks.settleMatch(buyer, { career: 1, xp: 100, stats: {}, result });
  const paidTwice = economyRanks.profileOf(buyer);
  okU(paidOnce.credits === bought.profile.credits + award
      && paidTwice.credits === paidOnce.credits
      && paidTwice.transactions.filter((tx) => tx.kind === 'match').length === 1,
      'the same match receipt cannot pay credits twice',
      `${bought.profile.credits} + ${award} = ${paidTwice.credits}`);
  economyRanks.flush();
  if (existsSync(economyFile)) unlinkSync(economyFile);
  if (existsSync(`${economyFile}.tmp`)) unlinkSync(`${economyFile}.tmp`);
  if (oldRanksFile === undefined) delete process.env.FPSBONE_RANKS;
  else process.env.FPSBONE_RANKS = oldRanksFile;
  if (oldDatabase === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = oldDatabase;

  const ranksSrc = readFileSync('./server/ranks.js', 'utf8');
  const serveSrc = readFileSync('./server/serve.js', 'utf8');
  const mainSrc = readFileSync('./client/src/main.js', 'utf8');
  const menuSrc = readFileSync('./client/src/menu.js', 'utf8');
  const lobbyHtml = readFileSync('./client/index.html', 'utf8');
  okU(ranksSrc.includes('FOR UPDATE') && ranksSrc.includes("source)\n       VALUES ($1, $2, 'purchase')")
      && ranksSrc.includes("ON CONFLICT (id) DO NOTHING RETURNING id")
      && ranksSrc.includes("kind, item_id, amount, counterparty, royalty"),
      'PostgreSQL serializes purchases, records provenance and idempotently pays receipts');
  okU(serveSrc.includes("'/api/account/purchase'") && mainSrc.includes('accountApi.purchase(finish)')
      && menuSrc.includes('renderMarketplace') && lobbyHtml.includes('id="market-balance"')
      && lobbyHtml.includes('no cash value') && lobbyHtml.includes('non-transferable'),
      'the signed marketplace is wired through the lobby and plainly labels its alpha limits');
  okU(!/ethers|web3|walletconnect|solana|metamask/i.test(`${serveSrc}\n${mainSrc}\n${menuSrc}`),
      'real-money, wallet and blockchain behavior stays disabled until a provider and rules exist');
}
console.log([...pU, ...fU].join('\n'));
// ─────────────────────────────────────────── Part V: Arena rounds and objectives
console.log('\n=== Part V — Arena rounds, objectives, and one-life play ===\n');
const pV = [], fV = [];
const okV = (cond, label, detail = '') =>
  (cond ? pV : fV).push(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);

function arenaPair(accounts = false) {
  const room = new Room('arena');
  const a = room.players.get(room.add('attacker', {}, accounts ? 'arena-a' : null));
  const d = room.players.get(room.add('defender', {}, accounts ? 'arena-d' : null));
  room.drainEvents();
  return { room, a, d };
}

function arenaAdvance(room, ms) {
  room.tick += Math.ceil(ms / STEP_MS);
  room.ctl.tick(room);
}

function beginUse(room, p, site) {
  p.x = site.x;
  p.z = site.z;
  p.vx = 0;
  p.vz = 0;
  p.useUntil = Infinity;
  room.ctl.tick(room);
}

{
  const blocked = [];
  for (const site of OBJECTIVE_SITES) {
    const hit = WORLD_BOXES.find((b) => b.y + b.h * 0.5 > 0.05
      && overlapsBox(
        site.x, C.PLAYER_HALF_H, site.z,
        site.radius + C.PLAYER_HALF_W, C.PLAYER_HALF_H,
        site.radius + C.PLAYER_HALF_W, b,
      ));
    if (hit) blocked.push(site.id);
  }
  okV(OBJECTIVE_SITES.length === 2 && OBJECTIVE_SITES.map((s) => s.id).join('') === 'AB'
      && OBJECTIVE_SITES.every((s) => s.z > 0) && blocked.length === 0,
      'A and B are clear, authoritative pads in the defenders’ half',
      blocked.length ? `blocked: ${blocked.join(',')}` : OBJECTIVE_SITES.map((s) => `${s.id}(${s.x},${s.z})`).join(' '));

  const { room, a, d } = arenaPair();
  const mate = room.players.get(room.add('wing', {}));
  okV(a.team === 1 && d.team === 2 && a.z < 0 && d.z > 0,
      'the attackers and defenders join opposite bases',
      `${a.name}=team${a.team}@${a.z}, ${d.name}=team${d.team}@${d.z}`);
  okV(room.ctl.canDamage(room, a, d) && !room.ctl.canDamage(room, a, mate)
      && room.ctl.canDamage(room, a, a),
      'live enemies can fight, friendly fire stays off, and self-damage remains real');

  d.alive = false;
  room.ctl.onKill(room, a, d);
  room.ctl.tick(room);
  const killed = room.snapshotBase().md;
  okV(!d.alive || d.respawnAt === Infinity,
      'a death has no mid-round respawn', `respawnAt=${d.respawnAt}`);
  okV(killed.ph === 'round_over' && killed.ts[0] === 1 && killed.rr === 'elimination',
      'eliminating the defenders awards the attackers one round', JSON.stringify(killed));
  okV(!room.ctl.canDamage(room, a, d),
      'damage is closed during the round result screen');
  arenaAdvance(room, 5000);
  const next = room.snapshotBase().md;
  okV(next.ph === 'live' && next.rn === 2 && a.alive && d.alive
      && room.projectiles.length === 0 && room.clouds.length === 0,
      'the next round respawns both sides together and clears old utility', JSON.stringify(next));
}

{
  const { room, a, d } = arenaPair(true);
  const site = OBJECTIVE_SITES[0];
  beginUse(room, a, site);
  arenaAdvance(room, MODES.arena.plantMs / 2);
  a.x += site.radius + 1;
  room.ctl.tick(room);
  okV(room.snapshotBase().md.ap === undefined && room.snapshotBase().md.bp === undefined,
      'leaving the pad interrupts a partial plant instead of banking it');

  beginUse(room, a, site);
  arenaAdvance(room, MODES.arena.plantMs);
  const planted = room.snapshotBase().md;
  okV(planted.bp === 1 && planted.tl === Math.round(MODES.arena.fuseMs / 1000)
      && a.match.objectives === 1,
      'a continuous server-timed hold plants A and earns one objective credit', JSON.stringify(planted));

  // Killing every attacker no longer ends a planted round. The defender must use the pad.
  a.alive = false;
  room.ctl.onKill(room, d, a);
  room.ctl.tick(room);
  okV(room.snapshotBase().md.ph === 'live' && room.snapshotBase().md.bp === 1,
      'a planted charge stays live after the attackers are eliminated');

  beginUse(room, d, site);
  arenaAdvance(room, MODES.arena.defuseMs);
  const defused = room.snapshotBase().md;
  okV(defused.ph === 'round_over' && defused.ts[1] === 1 && defused.rr === 'defused'
      && d.match.objectives === 1,
      'a continuous defender hold defuses and scores the round', JSON.stringify(defused));
}

{
  const { room, a } = arenaPair();
  const site = OBJECTIVE_SITES[1];
  beginUse(room, a, site);
  arenaAdvance(room, MODES.arena.plantMs);
  arenaAdvance(room, MODES.arena.fuseMs);
  const blown = room.snapshotBase().md;
  okV(blown.ph === 'round_over' && blown.ts[0] === 1 && blown.rr === 'detonated',
      'an undefused charge awards the attackers on the fuse clock', JSON.stringify(blown));
}

{
  const { room } = arenaPair();
  arenaAdvance(room, MODES.arena.roundMs);
  const timed = room.snapshotBase().md;
  okV(timed.ph === 'round_over' && timed.ts[1] === 1 && timed.rr === 'time',
      'the defenders win when the round clock expires without a plant', JSON.stringify(timed));
}

{
  const { room, a } = arenaPair();
  const site = OBJECTIVE_SITES[0];
  a.x = site.x;
  a.z = site.z;
  a.vx = a.vz = 0;
  room.queueInput(a.id, [{ seq: 1, moveX: 0, moveZ: 0, yaw: a.yaw, pitch: 0,
    buttons: C.BTN_USE, wep: a.wep, sc: 0 }]);
  for (let i = 0; i < 24; i++) room.step();
  const released = room.snapshotBase().md;
  okV(released.bp === undefined && released.ap === undefined && a.useUntil < room.now(),
      'one use packet cannot survive starvation and finish an objective',
      `now=${Math.round(room.now())}, lease=${Math.round(a.useUntil)}`);
}

{
  const room = new Room('arena');
  const bot = room.players.get(room.addBot('BOT Objective'));
  const site = OBJECTIVE_SITES[0];
  bot.x = site.x;
  bot.z = site.z;
  const input = room.ctl.botInput(room, bot, room.now(), {
    seq: 1, moveX: 1, moveZ: 1, yaw: 0, pitch: 0, buttons: 0, wep: bot.wep, sc: 0,
  });
  okV((input.buttons & C.BTN_USE) !== 0 && input.moveX === 0 && input.moveZ === 0,
      'a bot on an objective stops and uses the same BTN_USE a person sends');
}

{
  const { room, a, d } = arenaPair(true);
  const receipts = [];
  room.onMatch = (account, data) => receipts.push({ account, data });
  for (let round = 1; round <= MODES.arena.winRounds; round++) {
    d.alive = false;
    room.ctl.onKill(room, a, d);
    room.ctl.tick(room);
    if (round < MODES.arena.winRounds) arenaAdvance(room, 5000);
  }
  const final = room.snapshotBase().md;
  okV(final.ph === 'over' && final.wt === 1 && final.ts[0] === MODES.arena.winRounds
      && receipts.length === 2 && receipts.every((r) => r.data.result.mode === 'arena'),
      'the seventh round settles one Arena match for both accounts',
      `${JSON.stringify(final)}, receipts=${receipts.length}`);
  okV(a.pendingResult?.won === true && d.pendingResult?.won === false
      && !room.ctl.canDamage(room, a, d),
      'the final receipt identifies the winning side and closes combat');
}

{
  const hudSrc = readFileSync('./client/src/hud.js', 'utf8');
  const mainSrc = readFileSync('./client/src/main.js', 'utf8');
  const environmentSrc = readFileSync('./client/src/environment.js', 'utf8');
  okV(hudSrc.includes("md.ak === 'p' ? 'planting' : 'defusing'")
      && hudSrc.includes("site ${site} · charge planted")
      && environmentSrc.includes('OBJECTIVE_SITES'),
      'the HUD names plant, defuse and fuse states over the shared painted sites');
  okV(mainSrc.includes("mode.spectate === 'team'")
      && mainSrc.includes('view.syncAvatars(states, hiddenId'),
      'an eliminated Arena player follows a living teammate instead of staring at a corpse');
  const menuSrc = readFileSync('./client/src/menu.js', 'utf8');
  okV(menuSrc.includes("[kb('use'), 'plant <em>/</em> defuse']"),
      'the live lobby key reference tells players that E plants and defuses');
}

console.log([...pV, ...fV].join('\n'));
// ─────────────────────────────────────────── Part W: social lobby and matchmaking
console.log('\n=== Part W — social presence, parties, and matchmaking ===\n');
const pW = [], fW = [];
const okW = (cond, label, detail = '') => {
  (cond ? pW : fW).push(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

{
  let humans = 0;
  const roomHumans = { dm: 0, arena: 0 };
  const fakeHost = {
    available: ['dm', 'arena'], regionCap: 20,
    rooms: new Map([
      ['dm', { room: { mode: { slots: 10 } } }],
      ['arena', { room: { mode: { slots: 10 } } }],
    ]),
    occupancy: () => ({ ...roomHumans }),
    get humans() { return humans; },
  };
  let serial = 0;
  const social = createSocialService({ host: fakeHost, now: () => 1000, makeToken: () => `social-${++serial}` });
  const alpha = social.open('account-alpha', 'Alpha');
  const bravo = social.open('account-bravo', 'Bravo');
  const charlie = social.open('account-charlie', 'Charlie');
  okW(alpha.state.self.code.length === 8 && !alpha.state.self.code.includes('account'),
    'friend codes are public aliases rather than account identifiers', alpha.state.self.code);
  okW(humans === 0 && social.sessions === 3,
    'opening social presence consumes no game seats', `${social.sessions} presence / ${humans} seats`);

  social.action(alpha.token, { action: 'friend_request', code: bravo.state.self.code });
  let bravoState = social.state(bravo.token);
  okW(bravoState.requests.some((person) => person.code === alpha.state.self.code),
    'an online player receives a friend request by public code');
  social.action(bravo.token, { action: 'friend_accept', code: alpha.state.self.code });
  okW(social.state(alpha.token).friends.some((person) => person.code === bravo.state.self.code),
    'accepting creates the friendship on both sides');

  social.action(alpha.token, { action: 'party_invite', code: bravo.state.self.code });
  social.action(bravo.token, { action: 'party_accept', code: alpha.state.self.code });
  const party = social.state(alpha.token).party;
  okW(party?.members.length === 2 && party.leader === alpha.state.self.code,
    'friends can form a two-player party with an explicit leader');
  let followerBlocked = false;
  try { social.action(bravo.token, { action: 'queue', modes: ['dm'] }); } catch (err) {
    followerBlocked = err.message === 'social_leader_required';
  }
  okW(followerBlocked, 'only the party leader can start matchmaking');

  const matched = social.action(alpha.token, { action: 'queue', modes: ['dm'] });
  bravoState = social.state(bravo.token);
  okW(matched.match?.mode === 'dm' && bravoState.match?.mode === 'dm',
    'a party is matched together when the regional room has enough seats');

  humans = 19;
  roomHumans.dm = 10;
  const waiting = social.action(charlie.token, { action: 'queue', modes: ['dm'] });
  okW(waiting.queue?.modes[0] === 'dm' && !waiting.match,
    'a full room remains queued instead of bypassing capacity');
  const cancelled = social.action(charlie.token, { action: 'cancel' });
  okW(!cancelled.queue && !cancelled.match, 'the queue can be cancelled without opening a socket');

  const accountApiSource = readFileSync('./server/account-api.js', 'utf8');
  const clientApiSource = readFileSync('./client/src/account-client.js', 'utf8');
  okW(accountApiSource.includes("'social'") && clientApiSource.includes("signed('social'"),
    'opening presence requires the same signed device proof as the account APIs');
  const menuSource = readFileSync('./client/src/menu.js', 'utf8');
  okW(menuSource.includes("performSocial('queue'") && menuSource.includes("performSocial('cancel')"),
    'the lobby UI exposes queue start and cancellation');

  let hostSerial = 0;
  const heldHost = createHost({
    nowNs: () => 0n,
    makeToken: () => `held-${++hostSerial}`,
    setTimer: () => ({ timer: hostSerial }),
    clearTimer: () => {},
  });
  const held = heldHost.reserveMatch('dm', 10);
  okW(held?.length === 10 && heldHost.occupancy().dm === 10,
    'the game host atomically reserves a whole party against the visible room count');
  const wire = [];
  const admitted = heldHost.connect({
    send: (payload) => wire.push(decode(payload)), isOpen: () => true, close: () => {}, rtt: () => 0,
  });
  admitted.start();
  await admitted.message(encode({ t: MSG.HELLO, name: 'ticket owner', mode: 'arena', match: held[0] }));
  okW(wire.some((message) => message?.t === MSG.WELCOME && message.mode === 'dm'),
    'a valid ticket locks HELLO to its reserved mode rather than the client request');
  const replayWire = [];
  const replay = heldHost.connect({
    send: (payload) => replayWire.push(decode(payload)), isOpen: () => true, close: () => {}, rtt: () => 0,
  });
  replay.start();
  await replay.message(encode({ t: MSG.HELLO, name: 'ticket copier', mode: 'dm', match: held[0] }));
  okW(replayWire.some((message) => message?.t === MSG.REJECT && message.reason === REJECT.MODE_FULL),
    'a consumed ticket cannot clone its held seat when the room is reserved full');
}
console.log([...pW, ...fW].join('\n'));
// ─────────────────────────────────────────── Part I: two live clients
console.log('\n=== Part I — two live clients over the wire ===\n');

const p2 = [];
const f2 = [];
const ok2 = (cond, label, detail = '') => {
  (cond ? p2 : f2).push(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

function client(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${C.NET_PORT}`);
    const rec = {
      name, id: null, mode: null, avail: [], lob: null,
      snaps: 0, sawOther: 0, selfField: 0, wField: 0, mdField: 0, ldField: 0,
      botField: 0,
      /**
       * Bots and bodies as of the newest snapshot that showed BOTH PEOPLE — which is the
       * only window in which "two humans means eight bots" is a claim about anything.
       *
       * Not the last snapshot, and not the most ever seen. The figure moves at BOTH ends of
       * the run, truthfully each time: the room is briefly nine bots deep while the other
       * client is still handshaking, and it goes straight back to nine the moment whichever
       * client reaches its sixtieth snapshot first closes its socket. Both of those are
       * outside the two-human window, and reading the last snapshot instead of this made the
       * suite fail about one run in four with `alpha saw 9` — a photograph of the teardown,
       * not of the rule. Gating on a second PERSON being visible is what makes it settled.
       */
      bothBots: 0, bothBodies: 0, bothSeen: 0,
      /** MSG.LOBBY pushes. One has to arrive when the other client joins, or a menu
       *  left open would never notice the room filling up. */
      lobbyPushes: 0, lastLobby: null,
      /**
       * The occupancy figure out of EVERY push, in order — and the reason it is a list
       * rather than just the final one is a race that made this suite flaky.
       *
       * Both clients resolve after 60 snapshots and close, a beat apart. Whichever closes
       * first is a DROP, so the server pushes again, truthfully, to say one human is left —
       * and if that lands before the other client's socket goes, its LAST push reports 1
       * rather than 2. The run where this file said 2 was the run where the closes happened
       * to land in the other order. The property being tested is that a push reported both
       * humans while both were in the room, which is a question about the sequence and not
       * about whichever end of it a teardown left behind.
       */
      lobbySeen: [],
      ld: null,
      seenIds: new Set(), ws,
    };
    let seq = 0;
    const t = setTimeout(() => reject(new Error(`${name} timed out`)), 12000);

    ws.on('open', () => {});
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const m = decode(raw);
      if (!m) return;
      if (m.t === MSG.CHALLENGE) {
        ws.send(encode({ t: MSG.HELLO, name, cosmetics: {}, mode: DEFAULT_MODE }));
        return;
      }
      if (m.t === MSG.WELCOME) {
        rec.id = m.id;
        rec.mode = m.mode;
        rec.avail = m.avail ?? [];
        rec.lob = m.lob ?? null;
        rec.maxBotsField = m.maxBots;
        // Walk forward so positions actually change on the other client.
        rec.timer = setInterval(() => {
          const batch = [];
          for (let i = 0; i < C.TICKS_PER_SNAPSHOT; i++) {
            batch.push({ seq: ++seq, moveX: 0, moveZ: 1, yaw: 0.7, pitch: 0, buttons: 0 });
          }
          ws.send(encode({ t: MSG.INPUT, inputs: batch }));
        }, 1000 / C.SNAPSHOT_HZ);
        return;
      }
      if (m.t === MSG.LOBBY) {
        rec.lobbyPushes++;
        rec.lastLobby = m.rooms;
        rec.lobbySeen.push(m.rooms?.[DEFAULT_MODE]);
        return;
      }
      if (m.t !== MSG.SNAPSHOT) return;
      rec.snaps++;
      if (m.self) rec.selfField++;
      if (m.self && typeof m.self.w === 'number' && typeof m.self.am === 'number') rec.wField++;
      // The dealt hand rides in `self` on every snapshot rather than in a one-off
      // message, precisely so it cannot be missed or arrive out of order. This is the
      // only part of the suite that sees a real `self` blob, so it is the only place
      // that check can be made.
      if (Array.isArray(m.self?.ld) && m.self.ld.length) {
        rec.ldField++;
        rec.ld = m.self.ld;
      }
      if (m.md) rec.mdField++;
      for (const p of m.players) rec.seenIds.add(p.id);
      if (m.players.some((p) => p.id !== rec.id)) rec.sawOther++;

      // Bots are ordinary players on the wire, so the only thing that identifies one
      // here is its name — which is the point, and is checked both ways: the count has
      // to be visible, and the `bot` field has to be absent.
      const looksBot = (p) => typeof p.n === 'string' && p.n.startsWith('BOT ');
      // A second PERSON — not us, and not one of the bodies the backfill put there. Only
      // then do the counts mean what the assertion says they mean; see `bothBots` above.
      if (m.players.some((p) => p.id !== rec.id && !looksBot(p))) {
        rec.bothBots = m.players.filter(looksBot).length;
        rec.bothBodies = m.players.length;
        rec.bothSeen++;
      }
      if (m.players.some((p) => 'bot' in p)) rec.botField++;

      if (rec.snaps >= 60) {
        clearTimeout(t);
        clearInterval(rec.timer);
        ws.close();
        resolve(rec);
      }
    });
  });
}

try {
  // Neither client asks for anything but a mode — there is no longer a field to ask in.
  // Two humans in a ten-slot deathmatch is eight bots, decided entirely server-side, and
  // that is what both of them have to be looking at by the end of the run.
  const [a, b] = await Promise.all([client('alpha'), client('bravo')]);
  ok2(a.id !== null && b.id !== null && a.id !== b.id, 'both clients got distinct ids', `#${a.id} and #${b.id}`);
  ok2(a.mode === DEFAULT_MODE && b.mode === DEFAULT_MODE, 'welcome reports the mode joined', `${a.mode} / ${b.mode}`);
  ok2(a.avail.includes(DEFAULT_MODE), 'welcome lists the modes the server can host', `[${a.avail}]`);
  ok2(a.sawOther > 50 && b.sawOther > 50, 'each client saw the other in its snapshots',
      `alpha ${a.sawOther}/${a.snaps}, bravo ${b.sawOther}/${b.snaps}`);
  ok2(a.seenIds.has(b.id) && b.seenIds.has(a.id), 'the ids each saw are actually the other player',
      `alpha saw [${[...a.seenIds]}], bravo saw [${[...b.seenIds]}]`);
  ok2(a.selfField === a.snaps && b.selfField === b.snaps, 'every snapshot carried the per-recipient self field',
      `alpha ${a.selfField}/${a.snaps}, bravo ${b.selfField}/${b.snaps}`);
  ok2(a.wField === a.snaps && b.wField === b.snaps, 'self field carried weapon and ammunition',
      `alpha ${a.wField}/${a.snaps}, bravo ${b.wField}/${b.snaps}`);
  ok2(a.mdField === a.snaps && b.mdField === b.snaps, 'every snapshot carried mode state',
      `alpha ${a.mdField}/${a.snaps}, bravo ${b.mdField}/${b.snaps}`);
  ok2(a.ldField === a.snaps && b.ldField === b.snaps, 'every snapshot carried the dealt loadout',
      `alpha ${a.ldField}/${a.snaps}, bravo ${b.ldField}/${b.snaps}`);
  // The client adopts this verbatim and hands it to the number keys, so a hand that
  // is short a slot or holds a weapon the mode never offered is a dead key or a gun
  // that should not exist.
  const poolIdx = DM.loadout.map(indexOf);
  ok2(
    [a, b].every((c) => c.ld?.length === new Set(DM.loadout.map(slotOf)).size
      && c.ld.every((i) => poolIdx.includes(i))),
    'the loadout on the wire is a full hand drawn from the mode pool',
    [a, b].map((c) => `${c.name}: ${(c.ld ?? []).map((i) => WEAPON_IDS[i]).join('+')}`).join(', '),
  );
  // THE BACKFILL, over a real socket. Part M proves the rule against the host in-process;
  // this is the same rule surviving two actual WebSockets, two handshakes and the snapshot
  // encoder — and it is the check that would have caught the old client still sending a
  // bot count that the server no longer reads.
  const SLOTS = DM.slots;
  ok2(a.bothBots === SLOTS - 2 && b.bothBots === SLOTS - 2,
      `two players in a ${SLOTS}-slot lobby leaves exactly ${SLOTS - 2} bots, asked for by nobody`,
      `alpha saw ${a.bothBots}, bravo saw ${b.bothBots}, across ${a.bothSeen}/${b.bothSeen} two-human snapshots`);
  ok2(a.bothBodies === SLOTS && b.bothBodies === SLOTS,
      'and the lobby is full rather than merely populated',
      `alpha ${a.bothBodies} bodies, bravo ${b.bothBodies}`);
  ok2(a.lob?.[DEFAULT_MODE] >= 1 && b.lob?.[DEFAULT_MODE] >= 1,
      'welcome told each client how full the lobbies were',
      `alpha lob=${JSON.stringify(a.lob)}, bravo lob=${JSON.stringify(b.lob)}`);
  ok2(a.maxBotsField === undefined && b.maxBotsField === undefined,
      'and no longer advertises a bot ceiling for a slider that no longer exists');
  // Whichever of the two handshook first must have been told about the other arriving.
  // Both is not guaranteed — they connect concurrently — so the assertion is on the pair.
  ok2(a.lobbyPushes + b.lobbyPushes > 0,
      'and a join was pushed to the client that was already seated, unprompted',
      `alpha ${a.lobbyPushes} pushes, bravo ${b.lobbyPushes}`);
  // Some push, not the last one — see `lobbySeen` above for why the final push legitimately
  // reports 1. Two is the whole point of the check: the room holds ten bodies at this moment
  // and the number on the wire has to be the two PEOPLE, because a count of bodies would grey
  // out a lobby with eight free seats in it.
  ok2([...a.lobbySeen, ...b.lobbySeen].includes(2),
      'reporting both humans in the room, and not the bots beside them',
      `pushed alpha [${a.lobbySeen}], bravo [${b.lobbySeen}] for ${DEFAULT_MODE}`);
  ok2(a.botField === 0 && b.botField === 0,
      'and no snapshot ever told a client which players were bots',
      'only the BOT name prefix, which is what the killfeed reads');
  console.log([...p2, ...f2].join('\n'));
} catch (e) {
  // Stack frames, not only the message: a socket or assertion failure in here can throw
  // with an empty message, and a blank detail line says nothing about where it came from.
  // Part F already reports its crashes this way.
  console.log(`FAIL  two-client session — ${e.message || e}`);
  console.log((e.stack ?? '').split(String.fromCharCode(10)).slice(0, 4)
    .map((s) => '      ' + s.trim()).join(String.fromCharCode(10)));
  f2.push('two-client session');
}

const total = fail.length + fB.length + fC.length + fD.length + fE.length + fF.length
  + fG.length + fH.length + fJ.length + fK.length + fL.length + fM.length + fN.length
  + fO.length + fP.length
  + fQ.length + fR.length + fS.length + fT.length + fU.length + fV.length
  + fW.length
  + f2.length;
console.log(
  `\n${total === 0 ? 'ALL PASS' : `${total} FAILURE(S)`} — ${pass.length + pB.length + pC.length + pD.length + pE.length + pF.length + pG.length + pH.length + pJ.length + pK.length + pL.length + pM.length + pN.length + pO.length + pP.length + pQ.length + pR.length + pS.length + pT.length + pU.length + pV.length + pW.length + p2.length} checks passed`,
);
process.exit(total === 0 ? 0 : 1);
