// Scene construction and avatar management.
//
// The combatants remain clean box-and-capsule silhouettes; FOUNDRY 64 adds restrained
// procedural surface grain, authored markings and an industrial skyline around them.
// One directional key, hemisphere fill and fog preserve strong face separation so that
// environment detail never costs player readability.

import * as THREE from 'three';
import * as C from '../../shared/constants.js';
import { ARENA } from '../../shared/map.js';
import { buildEnvironment } from './environment.js';
import { halfHAt, eyeY } from '../../shared/movement.js';
// The rank device, drawn once and worn twice: this file puts it over a head, and
// hud.js puts the same canvas in the scoreboard's rank gutter. See insignia.js for
// why it is not drawn in two places.
import { insigniaCanvas, FIELD_H } from './insignia.js';
import { createProjectile, stepProjectile } from '../../shared/projectile.js';
import { JAM_CLEAR_MS, cycleMsOf, idAt } from '../../shared/weapons.js';
import { DEFAULT_FINISH, finishOf, sanitizeCosmetics } from '../../shared/cosmetics.js';
import { operatorFor } from '../../shared/operators.js';
// The rig — proportions, the arm solve, and every hold — lives in its own module with no
// three.js in it, so `npm run verify` can import it in plain Node and MEASURE that the
// hands land on the weapon. That is the entire reason it is not in this file: the previous
// arms were hand-posed Euler angles with a gun box parented next to them, nothing checked
// that the two met, and they did not. "the bots look weird they dont look like carying the
// gone but just them hands floating" is what that looks like from the outside.
import {
  RIG,
  corpseDrop,
  solveHand,
  rotateXYZ,
  ELBOW_HINT,
  holdOf,
  IDLE_HAND,
  HEFT,
  DEAD_HAND,
  DEAD_GUN,
  deadGunZ,
  JAM_HAND,
  CYCLE_HAND,
  ARM_UPPER,
  ARM_FORE,
} from './rig.js';

// Death animation timings. A corpse that vanishes the frame it dies gives you
// nothing to confirm the kill against, and it deletes the one piece of information
// a body carries: where the fight happened.
const TOPPLE_MS = 420;
const FADE_MS = 420;
const easeOut = (k) => 1 - (1 - k) ** 3;

/** Default viewmodel field of view, separate from the player's world FOV and
 *  adjustable in settings. CS2 exposes this as `viewmodel_fov` for the same reason:
 *  the weapon should not stretch when a player widens their view, and must not zoom
 *  with a scope.
 *
 *  50 is not arbitrary. Rigs now sit further from the eye so the whole weapon is in
 *  front of the camera, which shrinks them; a narrower FOV than the world's 85 scales
 *  them back up by almost exactly the same factor, so the framing that was already
 *  tuned survives the move. `settings.vmFov` defaults to this value. */
const VM_FOV = 50;

/** Scratch for `eyeY`, which takes a whole player state. Keeps the crouch eye
 *  height coming from the one function the camera uses, without allocating an
 *  object per avatar per frame. */
const eyeProbe = { y: 0, crouch: 0 };

/** Scratch for building an impact's local frame — a normal and two directions
 *  across the surface. Reused because an impact can be spawned several times in one
 *  frame and none of this outlives the call. */
const iN = new THREE.Vector3();
const iT1 = new THREE.Vector3();
const iT2 = new THREE.Vector3();
const iV = new THREE.Vector3();
/** Scratch colour, for the fireball cooling from orange to ember. */
const cScratch = new THREE.Color();

function setAvatarOpacity(a, o) {
  if (a.opacity === o) return;
  a.opacity = o;
  for (const m of a.materials) {
    const blend = o < 1;
    // Switching blend mode recompiles the shader, so only touch it on the two
    // frames where it actually changes.
    if (m.transparent !== blend) {
      m.transparent = blend;
      m.needsUpdate = true;
    }
    m.opacity = o;
  }
}

/** In the team modes an avatar's colour is the single most load-bearing piece of
 *  information on screen — it decides whether to shoot. In free-for-all everyone
 *  stays `accent`, since there is nothing to distinguish. */
function setAvatarTeam(a, team) {
  if (a.team === team) return;
  a.team = team;
  const op = operatorFor(team, a.id);
  a.operator = op.id;
  a.uniformMat.color.setHex(op.primary);
  a.armorMat.color.setHex(op.secondary);
  a.clothMat.color.setHex(op.cloth);
  a.gearMat.color.setHex(op.gear);
  a.skinMat.color.setHex(op.skin);
  a.operatorAccentMat.color.setHex(op.accent);
  for (const g of a.sentinelKit) g.visible = op.id === 'sentinel';
  for (const g of a.raiderKit) g.visible = op.id === 'raider';
}

function setAvatarFinish(a, id = DEFAULT_FINISH) {
  const normalized = sanitizeCosmetics({ finish: id }).finish ?? DEFAULT_FINISH;
  if (a.finish === normalized) return;
  const f = finishOf(normalized);
  a.finish = normalized;
  a.weaponMat.color.setHex(f.steel);
  a.weaponDarkMat.color.setHex(f.dark);
  a.weaponTrimMat.color.setHex(f.trim);
}

/** Show or hide the spawn-protection ring. Toggled off `sp` in the snapshot, so it
 *  appears and disappears on exactly the ticks the server changes its mind — there is
 *  no client-side timer to drift out of step with the one that decides the damage. */
function setAvatarShield(a, on) {
  if (a.shielded === on) return;
  a.shielded = on;
  a.shield.visible = on;
}

// ─── The rank plate ────────────────────────────────────────────────────────────────────
//
// A count of insignia marks floating over each player's head. `shared/ranks.js` argues why
// it is a COUNT and not a name; this is how the count gets drawn.
//
// This remains the only texture carried by a combatant. The world now owns low-contrast
// procedural grain and signs, but a rank needs a dedicated raster for a different reason:
// there is no way to build five stars out of lit boxes that survives being three pixels tall.
//
// Three choices in it are load-bearing, and each one replaced something that looked simpler:
//
//   A `Mesh` with its OWN PlaneGeometry, never a `THREE.Sprite`. Sprite is the obvious
//   choice for a billboard and it is the one thing that cannot be used here: every Sprite
//   in three.js shares a single module-level geometry, and the cull at the bottom of
//   `syncAvatars` disposes geometry by walking the avatar's group — so the first player to
//   leave a match would free the geometry out from under every other player's plate.
//
//   Yaw-only billboarding, not `lookAt`. Pitching the plate to face a camera above it means
//   that looking down on somebody lays their rank flat across the top of their skull.
//   Turning it about Y alone keeps it upright, which is how a badge reads.
//
//   `depthTest` left at its default `true`. That is the entire occlusion mechanism, and it
//   is better than the ray test this was going to be: the depth buffer already holds every
//   wall AND every body, so a plate behind cover disappears per-pixel and a plate behind
//   another player disappears too. `rayWorld` in shared/collide.js sees only `boxes`, so it
//   could not do the second at all, and a single ray to a single point pops the whole plate
//   on and off at a wall corner. `depthTest: false` would put a marker over every enemy
//   through walls — the exact trade server/room.js already refuses in as many words.

/** Clear air between the crown and the bottom edge of the badge, in `group` space where the
 *  crown is exactly `halfHAt(cr)`. Placed by that EDGE rather than by its centre, so the badge
 *  keeps the same gap over the head no matter what is drawn on it. */
const PLATE_CLEAR = 0.05;
/** Past this the marks inside the field are under a pixel and only the silhouette is left, so
 *  the badge stops being worth a draw call. The arena is 64u on a side, so this still covers
 *  every fight worth having while stopping short of the far wall. */
const PLATE_CULL = 40;


/** `{tex, w, h}` per tier index, built on first sight of a rank and never disposed. A texture
 *  per RANK is bounded at twenty-one whatever the server count is, unlike a texture per player,
 *  and the same one serves every avatar wearing that rank. Nothing frees these, which is
 *  exactly why the cull can dispose an avatar's material without touching them. */
const plateTex = new Map();

function plateTexOf(tier) {
  const cached = plateTex.get(tier);
  if (cached) return cached;
  const { cv, w, h } = insigniaCanvas(tier);
  const tex = new THREE.CanvasTexture(cv);
  // The renderer sets no tone mapping and no output colour space of its own, so the canvas
  // needs saying explicitly or the ink comes out lifted.
  tex.colorSpace = THREE.SRGBColorSpace;
  // Trilinear with mipmaps, because this is drawn at anything from thirty pixels across down to
  // seven: nearest sampling makes a distant badge flicker between stripes as either player
  // walks, which is worse than not drawing it.
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  const e = { tex, w, h };
  plateTex.set(tier, e);
  return e;
}

/**
 * Point this avatar's plate at the rank in `tier`, or at nothing.
 *
 * Tier 0 now draws the recruit shield from insignia.js. The server still omits `rk` at zero
 * because the client already defaults an absent tier to Private; omission saves the common
 * wire field without making the common rank visually blank.
 *
 * The geometry is rebuilt on a change of rank rather than sized once at build time, because the
 * badge's WIDTH follows the device — a patch is square where a row of pins is up to twice as
 * wide as it is tall. Its HEIGHT never changes, which is what lets `aimPlate` clear the crown
 * with a constant. A rank changes a handful of times across a whole career, so the cost is
 * nothing, and the old geometry is disposed here rather than left for the cull, which only runs
 * on leaving.
 *
 * Deliberately does NOT touch `plate.visible`. That belongs to `aimPlate`, which resolves it
 * every frame from distance and from being alive; two owners of one flag and an early-out on an
 * unchanged rank is how a plate ends up stuck off after a respawn.
 */
function setAvatarPlate(a, tier) {
  if (a.rank === tier) return;
  a.rank = tier;
  a.plateOn = tier >= 0;
  if (!a.plateOn) return;
  const { tex, w, h } = plateTexOf(tier);
  a.plateMat.map = tex;
  a.plateMat.needsUpdate = true;
  a.plate.geometry.dispose();
  a.plate.geometry = new THREE.PlaneGeometry(w, h);
}

/**
 * Sit the plate over the crown and turn it to face the camera, or hide it.
 *
 * Runs every frame for every live avatar, so it allocates nothing — no Vector3, no matrix,
 * two subtractions and an atan2.
 *
 * Yaw only, and toward the camera's POSITION rather than parallel to the screen: a plate at
 * the edge of the frame should turn to face you, which is what the position gives and the
 * view direction does not. The group's own yaw comes back out again because the plate hangs
 * off `group` — parenting there is what keeps the plate on the head through a duck, a turn
 * and a topple, and this one subtraction is the whole price of it.
 */
function aimPlate(a, cam) {
  if (!a.plateOn) {
    a.plate.visible = false;
    return;
  }
  const dx = cam.position.x - a.group.position.x;
  const dz = cam.position.z - a.group.position.z;
  if (dx * dx + dz * dz > PLATE_CULL * PLATE_CULL) {
    a.plate.visible = false;
    return;
  }
  // The crown is exactly `halfHAt(cr)` above the body centre: `duck.scale.y` is
  // halfHAt(cr) / PLAYER_HALF_H and the rig's own crown sits at PLAYER_HALF_H, so the two
  // cancel out. Read back off the avatar rather than from the snapshot, so it can never
  // disagree with the duck scale that was applied for this same frame — and clamped,
  // because `a.crouch` is seeded to -1 to force the first sync through.
  // Placed by its BOTTOM edge and centred up from there: every badge is drawn into the same
  // FIELD_H-tall field regardless of how many marks it holds, so PLATE_CLEAR is the gap above
  // the skull and the half-height is a constant, and a chevron stack clears the head by the
  // same margin as a single bar.
  a.plate.position.y = halfHAt(Math.max(0, a.crouch)) + PLATE_CLEAR + FIELD_H / 2;
  a.plate.rotation.y = Math.atan2(dx, dz) - a.group.rotation.y;
  a.plate.visible = true;
}

/** The snowball's colour, matched to the viewmodel's `snow` material so the thing in your
 *  own hand and the thing in everyone else's are the same object. */
const SNOW_COLOR = 0xeef3f9;

/**
 * Build one weapon's boxes and hang them off the shoulder group.
 *
 * Parented to `shoulders`, not to a hand, and that is deliberate: the group's ORIGIN is the
 * trigger hand (see HOLDS), so placing the group at the trigger hand's target and solving
 * the arm to the same point puts the hand on the grip by construction. Parenting to the
 * forearm instead would mean the weapon inherits the arm's solved rotation and would have
 * to be un-rotated back out again — the sort of arithmetic that produced the floating gun
 * this replaces.
 *
 * Per avatar rather than shared: every box is on that avatar's own body material, which is
 * what a team recolour and the corpse fade drive, and the cull disposes geometry by walking
 * the group — shared geometry would be freed out from under the next avatar.
 */
function buildWeapon(a, id) {
  const g = new THREE.Group();
  for (const [i, [w, h, d, x, y, z, tag, rx = 0, ry = 0, rz = 0]] of holdOf(id).parts.entries()) {
    const weaponMat = i === 0 ? a.weaponMat : i % 3 === 0 ? a.weaponTrimMat : a.weaponDarkMat;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), tag === 'snow' ? a.snowMat : weaponMat);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    // Only the receiver-sized boxes cast. A shadow pass over the slivers — barrels, sights
    // — draws a silhouette indistinguishable from the one the big box draws by itself.
    mesh.castShadow = w * h * d > 0.0006;
    g.add(mesh);
  }
  a.shoulders.add(g);
  return g;
}

/**
 * Put the right weapon in this avatar's hands.
 *
 * This is the fix for the reported "sometimes you go to snow but it still has gun": every
 * avatar used to draw ONE hardcoded rifle box regardless of what the player was holding, so
 * in the snowball mode — where nobody can even select a gun — every body still had a rifle.
 * The weapon index is on the wire for every player, so there was never any need to guess.
 *
 * Rigs are built on first use and kept, hidden, for the rest of the avatar's life. A player
 * cycles through at most their loadout, so this settles at two or three small groups; the
 * alternative is rebuilding geometry on every weapon switch of every visible player.
 */
function setAvatarWeapon(a, w) {
  const id = idAt(w);
  if (a.wep === id) return;
  a.wep = id;
  a.hold = holdOf(id);
  // The weight effects, resolved once per switch rather than per frame. All four come from
  // one number (`heftOf`, derived from deploy time), so they cannot disagree about which
  // weapon is the heavy one.
  a.sag = HEFT.sag(id);
  a.kickAmt = HEFT.kick(id);
  a.follow = HEFT.follow(id);
  a.trail = HEFT.trail(id);
  a.cycleMs = cycleMsOf(id);
  if (!a.rigs.has(id)) a.rigs.set(id, buildWeapon(a, id));
  for (const [k, g] of a.rigs) g.visible = k === id;
  a.gun = a.rigs.get(id);
  // A stroke in flight belongs to the weapon that started it. Carrying its phase onto a
  // different weapon would drive a pump animation on a pistol.
  a.cycleAt = 0;
}

/** One shot, seen from outside: an impulse into the recoil spring, and the action starts
 *  its stroke if this weapon has one. Both are visual only — the server owns the shot. */
function avatarShot(a, w, now) {
  setAvatarWeapon(a, w);
  a.kickVel += a.kickAmt;
  if (a.cycleMs > 0) a.cycleAt = now;
}

/** Write a solved arm onto its two joints. `elbow` is the hinge angle straight out of the
 *  law of cosines, and it goes on rotation.x unchanged — `armFK` is written against exactly
 *  this convention, which is what lets verify.mjs check the hand lands on the grip. */
function applyArm(j, s) {
  j.arm.rotation.set(s.x, s.y, s.z);
  j.elbow.rotation.x = s.elbow;
}

/** `beat`: a half-sine bump inside a window of a 0..1 phase, and zero outside it. The
 *  windows, not the shape, are what have to agree with `audio.jam()` and the viewmodel. */
const beatIn = (p, lo, hi) => (p <= lo || p >= hi ? 0 : Math.sin(((p - lo) / (hi - lo)) * Math.PI));

/** `smoothstep` across a window of a 0..1 phase: 0 before it, 1 after it, eased between.
 *  The viewmodel builds a stroke out of two of these, one rising and one falling, so this
 *  is here to reproduce that curve rather than approximate it. */
const rampIn = (p, lo, hi) => {
  const k = Math.max(0, Math.min(1, (p - lo) / (hi - lo)));
  return k * k * (3 - 2 * k);
};

/**
 * Pose one live avatar's arms, weapon and aim.
 *
 * Everything above the waist, every frame, in one place — because all of it competes for
 * the same two hands and resolving that in one pass is the only way the hands stay on the
 * weapon. The order is: decide where the WEAPON is (weight, recoil, turn lag), then put the
 * hands where the weapon now is, then let the jam or the action stroke pull the off hand off
 * it. Hands follow the weapon, never the other way round.
 *
 * This is the "similar physics of cs2 holding guns and its effect depends on weight" ask.
 * Four weight cues, all from `heftOf`:
 *   - the muzzle SAGS, further the heavier it is;
 *   - a shot SHOVES the hold back and up, harder the heavier it is;
 *   - the weapon FOLLOWS the head's aim instead of matching it, slower the heavier it is;
 *   - and it TRAILS behind a turn.
 * The last two are the legible ones. A light pistol snaps where its owner is looking; an lmg
 * arrives late, and you can see the difference across a map without seeing the weapon.
 *
 * @param pitch camera pitch from the snapshot, radians.
 * @param yaw   body yaw from the snapshot, for the turn lag.
 * @param jamMs remaining stoppage from the snapshot's `jm`, 0 for a working weapon. Off the
 *   server countdown, not a local timer, so the punching stops on the tick the gun fires.
 */
function poseUpper(a, pitch, yaw, jamMs, now, dtMs) {
  const dt = Math.min(0.1, Math.max(0.001, dtMs / 1000));

  // Aim, arriving late by weight. `1 - e^(-dt/tau)` rather than a fixed fraction per frame,
  // so a 30fps client and a 240fps one see the same lag rather than the same stiffness.
  a.aim += (pitch * AIM_PITCH - a.aim) * (1 - Math.exp(-dt / a.follow));
  a.shoulders.rotation.x = a.aim;

  // The recoil spring: an impulse in `avatarShot`, damped back to rest here. Same form as
  // the viewmodel's, so a shot watched from outside settles on the same curve as one felt.
  a.kickVel += (-a.kick * 260 - a.kickVel * 22) * dt;
  a.kick += a.kickVel * dt;

  // How fast the body is turning, smoothed — snapshots land at 20Hz and the raw difference
  // between two of them is a staircase. Shortest-angle, or a player crossing +/-PI would
  // register a 360deg/frame spin and throw the weapon sideways.
  let dy = yaw - a.yawPrev;
  if (dy > Math.PI) dy -= 2 * Math.PI;
  else if (dy < -Math.PI) dy += 2 * Math.PI;
  a.yawPrev = yaw;
  a.turn += (dy / dt - a.turn) * Math.min(1, dt * 12);

  const hold = a.hold;

  // The action's stroke, if one is running: back, a beat at the rear while the case clears,
  // then home. Both midpoints, both ramp widths and the curve itself come from
  // `CYCLE_HAND.at` — the same numbers the viewmodel poses the player's own hands from and
  // the sound is scheduled against, so this is that gesture seen from outside rather than a
  // second one that resembles it. The pause between the two halves is what makes it read as
  // a mechanism instead of a wobble.
  let stroke = 0;
  if (a.cycleAt) {
    const cp = (now - a.cycleAt) / a.cycleMs;
    if (cp >= 1) a.cycleAt = 0;
    else {
      const [back, home] = CYCLE_HAND.at;
      const r = CYCLE_HAND.ramp;
      stroke = rampIn(cp, back - r, back + r) - rampIn(cp, home - r, home + r);
    }
  }

  // Where the weapon points. Sag is a constant droop; recoil lifts the muzzle; the turn lag
  // is clamped because `trail` is per rad/s and a flick can exceed 3 rad/s, which unclamped
  // would swing an lmg 30deg off the body's facing.
  const wrx = -a.sag + a.kick * 0.8 - 0.05 * stroke;
  const wry = Math.max(-0.35, Math.min(0.35, -a.turn * a.trail));

  // The trigger hand IS the weapon's origin, so this one position places both.
  const gx = hold.grip[0];
  const gy = hold.grip[1] + a.kick * 0.1;
  // Back, not just up. The viewmodel got the same correction for the same reason: recoil
  // that only pitches the weapon up reads as a flinch, and a body that never moves back
  // under a heavy gun does not look like it is carrying anything.
  const gz = hold.grip[2] + a.kick * 0.45;

  // The off hand, placed by ROTATING the grip-to-forend offset by the weapon's own rotation
  // rather than by a second hand-tuned target. That is what keeps it on the barrel through
  // sag, recoil and turn lag instead of a few centimetres off it.
  let sx;
  let sy;
  let sz;
  if (hold.support) {
    const d = rotateXYZ(
      wrx, wry, 0,
      hold.support[0] - hold.grip[0],
      hold.support[1] - hold.grip[1],
      hold.support[2] - hold.grip[2],
    );
    sx = gx + d.x;
    sy = gy + d.y;
    sz = gz + d.z;
  } else {
    // One-handed: knife and everything thrown. The free hand gets a pose of its own instead
    // of being left wherever the last weapon put it — that is how a character ends up
    // cupping thin air beside a knife.
    const rest = hold.idle ?? IDLE_HAND;
    sx = rest[0];
    sy = rest[1];
    sz = rest[2];
  }

  // The action stroke drags the off hand back along the weapon. Applied to the hand rather
  // than to a moving part, because at the range a remote player is seen from the hand IS the
  // animation — a 2cm bolt handle is nothing and a 16cm hand stroke is unmistakable.
  sx += CYCLE_HAND.back[0] * stroke;
  sy += CYCLE_HAND.back[1] * stroke;
  sz += CYCLE_HAND.back[2] * stroke;

  // The stoppage. Same two strike windows as `audio.jam()` and the viewmodel's own hands —
  // the same gesture seen from outside, so a player who has felt it recognises it on someone
  // else and knows they have an opening.
  const jp = jamMs > 0 ? Math.min(1, 1 - jamMs / JAM_CLEAR_MS) : -1;
  if (jp >= 0) {
    const strike = Math.max(beatIn(jp, 0.22, 0.38), beatIn(jp, 0.47, 0.63));
    // Ramp in and out so the hand LEAVES the weapon and rejoins it rather than teleporting
    // off it, and so the wind-up gives way to the strike instead of averaging with it.
    const engage = Math.min(1, jp / 0.14, (1 - jp) / 0.14);
    const wind = engage * (1 - strike);
    sx += JAM_HAND.away[0] * wind + JAM_HAND.into[0] * strike;
    sy += JAM_HAND.away[1] * wind + JAM_HAND.into[1] * strike;
    sz += JAM_HAND.away[2] * wind + JAM_HAND.into[2] * strike;
  }

  applyArm(a.armR, solveHand(1, [gx, gy, gz], ELBOW_HINT.trigger));
  applyArm(
    a.armL,
    solveHand(-1, [sx, sy, sz], hold.support ? ELBOW_HINT.support : ELBOW_HINT.idle),
  );
  a.gun.position.set(gx, gy, gz);
  a.gun.rotation.set(wrx, wry, 0);
}

/**
 * Pose the upper body of a corpse, `k` of the way through the topple.
 *
 * Blended in TASK space — the hand targets are interpolated and then solved — not by lerping
 * the solved Euler angles. Angles taking the short way round between two poses is how an
 * elbow ends up passing through a ribcage; positions cannot do that.
 *
 * The weapon leaves the hands as the body goes over, which is the other half of "even when
 * death they float". A corpse still gripping a rifle at chest height is a body that has died
 * without anything else in the scene agreeing that it did.
 */
function poseDeadUpper(a, k) {
  const hold = a.hold;
  /** Lerp two `[x,y,z]`s by the topple amount. Allocates, and only for the 420ms a body is
   *  actually going over — a settled corpse is skipped entirely by the caller. */
  const L = (from, to) => [
    from[0] + (to[0] - from[0]) * k,
    from[1] + (to[1] - from[1]) * k,
    from[2] + (to[2] - from[2]) * k,
  ];
  const rest = hold.support ?? hold.idle ?? IDLE_HAND;
  // The elbow hints blend too, from "braced on a weapon" to "lying at the side". Without it
  // the arms reach their final position with the elbows still winged out.
  const liveHint = hold.support ? ELBOW_HINT.support : ELBOW_HINT.idle;
  applyArm(
    a.armR,
    solveHand(1, L(hold.grip, DEAD_HAND.trigger), L(ELBOW_HINT.trigger, ELBOW_HINT.dead)),
  );
  applyArm(a.armL, solveHand(-1, L(rest, DEAD_HAND.support), L(liveHint, ELBOW_HINT.dead)));

  // The aim relaxes out of the shoulders, and the weapon slides down to the ground beside
  // the body. Both start from the live rest pose, so there is no pop at the instant of death.
  a.shoulders.rotation.x = a.aim * (1 - k);
  // Everything but the depth slides to a fixed spot; the depth slides to wherever THIS
  // weapon's lowest corner sits on the ground, which is the difference between a rifle lying
  // in the snow and a rifle half inside it.
  const gp = L(hold.grip, [DEAD_GUN.pos[0], DEAD_GUN.pos[1], deadGunZ(hold)]);
  a.gun.position.set(gp[0], gp[1], gp[2]);
  const gr = L([-a.sag, 0, 0], DEAD_GUN.rot);
  a.gun.rotation.set(gr[0], gr[1], gr[2]);
}

/** Radians of gait phase per world unit travelled. Two full strides per 2.2u, which is
 *  the cadence the footstep sound already uses (main.js advances a step every 2.4u), so
 *  the feet land roughly when a footstep plays instead of drifting against it. */
const STRIDE_PER_UNIT = 2.9;
/** Peak hip swing at a full run, radians. Past ~0.8 the legs scissor wider than a
 *  0.8u-wide collider and the figure reads as skating rather than running. */
const SWING_MAX = 0.72;
/**
 * How much of the camera's pitch the head and the weapon each take.
 *
 * They have to be fractions, and they have to be different. The camera pitches the full
 * ±90°: all of it on the neck is an owl, all of it on the shoulders is a rifle aimed
 * straight up out of a body still facing forward. Split, the head leads and the weapon
 * follows, which is both what a person does and enough to read someone's aim off.
 */
const HEAD_PITCH = 0.62;
const AIM_PITCH = 0.5;

/**
 * Advance one avatar's walk cycle.
 *
 * Driven by distance travelled between frames rather than by a velocity on the wire.
 * Snapshots carry position only, and deriving the speed here has a property a wire
 * velocity would not: the phase advances with the distance actually covered, so a
 * player being interpolated, rewound or corrected never has their feet slide against
 * the ground they are crossing. Standing still costs nothing — `swing` eases to zero
 * and the legs settle straight rather than freezing mid-step.
 *
 * @param dtMs frame time. Clamped, because a tabbed-out client comes back with a
 *        multi-second gap and would otherwise spin the legs through dozens of strides.
 */
function stepGait(a, x, z, dtMs) {
  if (a.px === null) {
    a.px = x;
    a.pz = z;
  }
  const moved = Math.hypot(x - a.px, z - a.pz);
  a.px = x;
  a.pz = z;

  const dt = Math.min(100, Math.max(1, dtMs)) / 1000;
  // Scaled against a fraction of the run speed, so a walk (0.52x) and a crouch-walk
  // (0.36x) still get most of a stride rather than a twitch.
  //
  // Sprint deliberately does NOT raise this clamp, and the reason is a measurement rather
  // than taste: against this divisor a settled walk is 0.85, a run is 1.64 and a sprint is
  // 1.86 — an ordinary run already saturates it by 64%. Letting a sprint through therefore
  // means letting a run through too, which re-tunes how every existing run looks in order
  // to add one state. Leg CADENCE is where sprint already reads correctly: `a.stride` below
  // accumulates distance, so a sprinter's legs cycle 15% faster today with no change here.
  // Amplitude saturated at a run is the right answer — you cannot swing a leg further than
  // all the way. Same reasoning covers the 2cm body bob at the end of this function.
  const target = Math.min(1, moved / dt / (C.MOVE_SPEED * 0.55));
  a.swing += (target - a.swing) * Math.min(1, dt * 9);
  a.stride += moved * STRIDE_PER_UNIT;

  const s = Math.sin(a.stride) * SWING_MAX * a.swing;
  for (let i = 0; i < a.legs.length; i++) {
    const { hip, knee } = a.legs[i];
    const dir = i === 0 ? 1 : -1;
    hip.rotation.x = s * dir;
    // A knee only folds one way. Taking the negative half of a sine offset behind the
    // hip gives the trailing leg its bend and leaves the leading one straight, which is
    // the difference between walking and a pair of scissors.
    knee.rotation.x = -Math.max(0, -Math.sin(a.stride + 0.9) * dir) * 1.15 * a.swing;
  }
  // The whole body rises and falls twice per stride, at double the leg frequency. Small
  // — 2cm — but it is most of what separates a walk from a slide.
  a.duck.position.y = Math.abs(Math.sin(a.stride)) * 0.02 * a.swing;
}

/**
 * Match the drawn body to the collider at this crouch amount.
 *
 * Not decoration. `halfOf` in shared/movement.js sizes the collision box, the
 * hitscan hitbox and the projectile blast box from the same crouch value; an avatar
 * that ignored it would be drawn standing over a hitbox that is 0.35u shorter, so
 * shots aimed at a visible head would pass through nothing and the ducked player
 * would look like they were cheating.
 */
function setAvatarCrouch(a, cr) {
  if (a.crouch === cr) return;
  a.crouch = cr;
  a.duck.scale.y = halfHAt(cr) / C.PLAYER_HALF_H;
  eyeProbe.crouch = cr;
  a.pivot.position.y = eyeY(eyeProbe);
}

function reviveAvatar(a) {
  a.deadAt = 0;
  a.tilt.rotation.set(0, 0, 0);
  a.tilt.position.y = 0;
  setAvatarOpacity(a, 1);
  // The recoil spring and the aim lag are wound back too. A body that died mid-burst would
  // otherwise respawn still settling from the last shot of a previous life.
  a.kick = 0;
  a.kickVel = 0;
  a.cycleAt = 0;
  a.turn = 0;
  // Restart the gait from a standing pose. Without this a player who died mid-run
  // respawns with one leg still forward and the body 2cm up on the last bob, then walks
  // out of it — and `px`/`pz` would still hold where they died, so the first frame after
  // a respawn across the map would read as one enormous step and spin the phase.
  a.px = null;
  a.pz = null;
  a.pt = 0;
  a.stride = 0;
  a.swing = 0;
  a.duck.position.y = 0;
  for (const { hip, knee } of a.legs) {
    hip.rotation.x = 0;
    knee.rotation.x = 0;
  }
}

function makeAvatar(id) {
  const group = new THREE.Group();
  const material = (color) => new THREE.MeshLambertMaterial({ color, flatShading: true });
  const uniformMat = material(0x315f82);
  const armorMat = material(0x1d3548);
  const clothMat = material(0x5e7682);
  const gearMat = material(0x18232b);
  const skinMat = material(0xa97856);
  const operatorAccentMat = material(0x58c8c7);
  const weaponMat = material(0x3a4351);
  const weaponDarkMat = material(0x252c38);
  const weaponTrimMat = material(0x357e69);
  // Its own material, because the one thing in the game that is not gunmetal must not be
  // repainted by a team colour. Created up front rather than on the first snowball so it is
  // already in `materials` when the corpse fade starts driving opacity.
  const snowMat = new THREE.MeshLambertMaterial({ color: SNOW_COLOR, flatShading: true });

  // The death topple and drop live on this group so they compose with the yaw on
  // `group` instead of fighting it for Euler order. Identity while alive.
  const tilt = new THREE.Group();
  group.add(tilt);

  // Crouch scales this group, and only it, so ducking shrinks the body without
  // squashing the head — the head is the thing you read a remote player's aim off, and
  // it has to keep its proportions at every height.
  const duck = new THREE.Group();
  tilt.add(duck);

  // Every part below is on the ONE body material, so a team recolour repaints the whole
  // silhouette in a single write and the corpse fade drives one opacity. `castShadow` is
  // set only on the parts big enough to matter — torso, thighs, head, gun. A shadow map
  // pass over fourteen little boxes per player costs real time and draws a silhouette
  // indistinguishable from the four large ones.
  const part = (parent, w, h, d, x, y, z, m = uniformMat, shadow = false) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = shadow;
    parent.add(mesh);
    return mesh;
  };
  /** A joint: an empty at the pivot point, so rotating it swings everything below. */
  const joint = (parent, x, y, z) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    parent.add(g);
    return g;
  };

  part(duck, RIG.pelvisW, RIG.pelvisH, RIG.pelvisD, 0, RIG.pelvisY, 0, armorMat);
  part(duck, RIG.torsoW, RIG.torsoH, RIG.torsoD, 0, RIG.torsoY, 0, uniformMat, true);
  part(duck, RIG.neckW, RIG.neckH, RIG.neckW, 0, RIG.neckY, 0, skinMat);

  // Close-fitting faction gear adds identity without lying about the server hitbox.
  // Sentinel wears a squared plate carrier; Raider wears a lighter crossed harness.
  const sentinelBody = new THREE.Group();
  const raiderBody = new THREE.Group();
  duck.add(sentinelBody, raiderBody);
  part(sentinelBody, RIG.torsoW + 0.035, RIG.torsoH * 0.55, RIG.torsoD + 0.055,
    0, RIG.torsoY + 0.07, -0.012, armorMat, true);
  part(sentinelBody, RIG.torsoW * 0.34, 0.055, RIG.torsoD + 0.07,
    0, RIG.torsoY - 0.13, -0.01, operatorAccentMat);
  part(raiderBody, 0.075, RIG.torsoH * 0.9, RIG.torsoD + 0.045,
    -0.12, RIG.torsoY, -0.02, gearMat);
  part(raiderBody, 0.075, RIG.torsoH * 0.9, RIG.torsoD + 0.045,
    0.12, RIG.torsoY, -0.02, gearMat);
  part(raiderBody, RIG.torsoW + 0.025, 0.07, RIG.torsoD + 0.05,
    0, RIG.torsoY - 0.17, -0.01, operatorAccentMat);

  // Legs. Hip and knee are real joints because the walk cycle swings them — a figure
  // that slides across the floor with rigid legs is the single thing that reads most
  // strongly as "not a person", whatever else is right about the shape.
  const legs = [];
  for (const side of [1, -1]) {
    const hip = joint(duck, side * RIG.hipX, RIG.hipY, 0);
    part(hip, RIG.thighW, RIG.thighH, RIG.thighD, 0, -RIG.thighH / 2, 0, clothMat, true);
    const knee = joint(hip, 0, -RIG.thighH, 0);
    part(knee, RIG.shinW, RIG.shinH, RIG.shinD, 0, -RIG.shinH / 2, 0, clothMat);
    part(knee, RIG.shinW + 0.035, 0.11, RIG.shinD + 0.035, 0, -0.08, -0.025, gearMat);
    // Toes forward, so which way a body is facing survives even from directly above.
    part(knee, RIG.footW, RIG.footH, RIG.footD, 0, -RIG.shinH - RIG.footH / 2, RIG.footZ, gearMat);
    legs.push({ hip, knee });
  }

  // Arms and weapon hang off one shoulder group, and the weapon is INSIDE it rather
  // than on the aim pivot with the head. That is the whole reason this group exists: a
  // gun parented to the head and arms parented to the body come apart the moment
  // someone aims up, and a rifle floating away from its own hands is worse than no
  // arms at all. One parent, one rotation, they move together by construction.
  const shoulders = joint(duck, 0, RIG.shoulderY, 0);
  // Both arms are kept: every frame solves both to real grip points, and which one is the
  // trigger hand matters — it is the one the weapon group hangs on, and the other is the one
  // free to work the action or punch a stoppage. No rest pose is baked in here, because
  // there is no longer any such thing: the pose is whatever the hold, the weight and the
  // recoil say it is this frame. Baked angles plus a separately-placed gun box is exactly
  // the arrangement that produced hands floating beside a weapon they were not holding.
  const arms = {};
  for (const side of [1, -1]) {
    const arm = joint(shoulders, side * RIG.shoulderX, 0, 0);
    part(arm, RIG.upperW, ARM_UPPER, RIG.upperD, 0, -ARM_UPPER / 2, 0, uniformMat);
    const elbow = joint(arm, 0, -ARM_UPPER, 0);
    part(elbow, RIG.foreW, ARM_FORE, RIG.foreD, 0, -ARM_FORE / 2, 0, clothMat);
    part(elbow, RIG.foreW * 1.12, 0.1, RIG.foreD * 1.12, 0, -ARM_FORE - 0.05, 0, gearMat);
    arms[side] = { arm, elbow };
  }

  // Yaw lives on the group, pitch on this pivot — so you can read where a remote
  // player is actually aiming. Only the head rides it, and at a fraction of the angle:
  // a head that pitches the full ±90° the camera does is an owl, not a person.
  const pivot = new THREE.Group();
  pivot.position.y = C.EYE_OFFSET;
  tilt.add(pivot);

  const visorMat = new THREE.MeshBasicMaterial({ color: C.PALETTE.visor });
  part(pivot, RIG.headW, RIG.headH, RIG.headD, 0, RIG.headY - C.EYE_OFFSET, 0, skinMat, true);
  part(
    pivot,
    RIG.visorW,
    RIG.visorH,
    0.05,
    0,
    RIG.visorY - C.EYE_OFFSET,
    -RIG.headD / 2 - 0.01,
    visorMat,
  );

  const sentinelHead = new THREE.Group();
  const raiderHead = new THREE.Group();
  pivot.add(sentinelHead, raiderHead);
  const headY = RIG.headY - C.EYE_OFFSET;
  part(sentinelHead, RIG.headW + 0.075, 0.13, RIG.headD + 0.07,
    0, headY + RIG.headH * 0.38, 0.015, armorMat, true);
  part(sentinelHead, RIG.headW + 0.095, 0.065, RIG.headD + 0.09,
    0, headY + RIG.headH * 0.16, 0.02, armorMat);
  part(raiderHead, RIG.headW + 0.06, 0.075, RIG.headD + 0.055,
    0, headY + RIG.headH * 0.42, 0.01, clothMat, true);
  part(raiderHead, RIG.headW * 0.9, 0.075, 0.12,
    0, headY - 0.085, -RIG.headD / 2 - 0.025, gearMat);

  // Spawn-protection marker: a flat ring on the floor at the player's feet, hidden
  // until the snapshot says they are protected.
  //
  // A ring rather than a bubble around the body. A bubble is the obvious choice and it
  // is the wrong one here: it would have to be big enough to enclose a 1.8u capsule,
  // which means at any normal fighting distance it covers the head and torso you are
  // trying to shoot — so the moment protection ends you are aiming through a ghost of
  // it. On the floor it is unmistakable, never occludes the target, and it survives the
  // one case that matters most: a protected player behind cover still shows the ring.
  //
  // Outside `duck`, so crouching does not squash it, and outside `pivot`, so it stays
  // flat on the ground whatever the player is looking at. On `group`, so it follows
  // position and yaw only — and yaw on a ring is invisible, which is the point.
  const shieldMat = new THREE.MeshBasicMaterial({
    color: C.PALETTE.shield,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
    // Drawn without writing depth so it never z-fights the floor it lies on, and so a
    // second protected player behind this one is not punched out of the frame.
    depthWrite: false,
  });
  const shield = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.62, 24), shieldMat);
  shield.rotation.x = -Math.PI / 2;
  // Feet, plus a hair: the body centre sits PLAYER_HALF_H above the floor, and 1cm of
  // lift is cheaper than any depth-bias trick for keeping it out of the floor plane.
  shield.position.y = -C.PLAYER_HALF_H + 0.01;
  shield.visible = false;
  group.add(shield);

  // Rank plate. The same parenting argument as the shield, arrived at from four different
  // directions: on `group` so it follows position and yaw, outside `duck` so a crouch does
  // not squash the insignia, outside `pivot` so looking up does not tip it flat, and outside
  // `tilt` so a corpse's topple does not swing it out sideways. Where it sits above the head
  // and which way it faces are set every frame by `aimPlate`.
  //
  // Own material per avatar, following the shield exactly: a material shared by rank would be
  // disposed for everybody at that rank the moment one of them left the match. The TEXTURE is
  // shared and that is safe — it is cached by tier at module scope and never disposed, so
  // there is nothing there for the cull to free.
  const plateMat = new THREE.MeshBasicMaterial({
    transparent: true,
    // No depth write, and for the shield's reason: the plate is mostly empty, and writing
    // depth for its blank corners would punch a rectangular hole in whatever is behind the
    // head. depthTest stays ON — see the block above `setAvatarPlate`, it is the occlusion.
    depthWrite: false,
    // Both faces, so a sign error in the billboard yaw shows up as a mirrored badge rather
    // than as nothing at all — five stars still read as five either way round.
    side: THREE.DoubleSide,
  });
  // A real geometry rather than a placeholder, so the first `setAvatarPlate` has something to
  // dispose and the cull's traverse has something to walk even on a player who never ranks
  // up. Square is arbitrary: nothing is drawn until a tier arrives and resizes it.
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(FIELD_H, FIELD_H), plateMat);
  plate.visible = false;
  group.add(plate);

  return {
    id,
    group,
    tilt,
    duck,
    pivot,
    // The walk cycle drives these; the aim drives `shoulders`.
    legs,
    shoulders,
    /** `{arm, elbow}` per side, keyed +1 trigger / -1 support. Both solved every frame. */
    armR: arms[1],
    armL: arms[-1],
    /** Weapon rigs, built on demand and kept hidden once built, keyed by weapon id. `gun` is
     *  whichever one is currently shown; `wep`/`hold` are its id and its hold. */
    rigs: new Map(),
    gun: null,
    wep: null,
    hold: null,
    // Weight, resolved on each weapon switch by `setAvatarWeapon`. Seeded so a pose taken
    // before the first snapshot is a legal one rather than a NaN.
    sag: 0,
    kickAmt: 0,
    follow: 0.05,
    trail: 0.1,
    cycleMs: 0,
    /** Recoil spring: `kickVel` gets the impulse, `kick` is what the pose reads. */
    kick: 0,
    kickVel: 0,
    /** Pitch the WEAPON has reached, which lags the pitch the head is already at. */
    aim: 0,
    /** Smoothed turn rate and the yaw it is differenced from, for the weapon's turn lag. */
    turn: 0,
    yawPrev: 0,
    /** `performance.now()` the action started its stroke, 0 when it is not running. */
    cycleAt: 0,
    /** How far this body rolls as it goes over, radians. Deterministic per player id, so a
     *  corpse looks the same to everyone watching and two bodies never land identically.
     *  Free of the drop: with the topple on X, the resting height comes out as -z of the
     *  unrotated point whatever the roll is, so this cannot bury or float a body. */
    roll: (((id * 2654435761) % 977) / 977 - 0.5) * 0.9,
    uniformMat,
    armorMat,
    clothMat,
    gearMat,
    skinMat,
    operatorAccentMat,
    weaponMat,
    weaponDarkMat,
    weaponTrimMat,
    sentinelKit: [sentinelBody, sentinelHead],
    raiderKit: [raiderBody, raiderHead],
    operator: null,
    finish: null,
    snowMat,
    materials: [uniformMat, armorMat, clothMat, gearMat, skinMat, operatorAccentMat,
      weaponMat, weaponDarkMat, weaponTrimMat, visorMat, snowMat],
    // Not in `materials`: that list is "everything the corpse fade drives", and the
    // shield has its own fixed opacity. Disposed explicitly in syncAvatars' cull.
    shieldMat,
    shield,
    shielded: false,
    // Not in `materials` either, and for the same reason the shield is not: that list is
    // everything the corpse fade drives, and a plate over a fading body is hidden outright
    // rather than faded down. Disposed explicitly in syncAvatars' cull.
    plateMat,
    plate,
    /** The tier currently drawn. -1 rather than 0 so the first sync installs Private's recruit
     *  shield instead of treating the initial tier as already applied. */
    rank: -1,
    plateOn: false,
    team: -1,
    // -1 rather than 0 so the first sync always applies, whatever height it is.
    crouch: -1,
    deadAt: 0,
    opacity: 1,
    // Gait state. `null` rather than 0 so the first sync seeds the position instead of
    // reading a stride from wherever the avatar happened to be created.
    px: null,
    pz: null,
    pt: 0,
    /** Accumulated gait phase, in radians, advanced by distance travelled. */
    stride: 0,
    /** Eased 0..1 "how much of a walk is this", so stopping settles instead of snapping
     *  the legs straight mid-step. */
    swing: 0,
  };
}

export function createScene(canvas, baseFov = 85) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // Standard materials and ACES both preserve richer surfaces than the old Lambert pass,
  // but together they originally crushed the arena's midtones. 1.28 keeps the sky and
  // safety paint below clipping while lifting shaded concrete into readable daylight.
  renderer.toneMappingExposure = 1.28;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(C.PALETTE.bg);
  // On a light background fog *lightens* distant geometry, which is what haze
  // actually does outdoors. Pushed much further out than the dark build needed —
  // there, fog hid the far wall; here it only has to give depth.
  //
  // Scaled off the arena rather than typed, because the two numbers only make sense
  // relative to how far you can actually see: the longest sightline in the map is about
  // 0.7 × ARENA, so fog starting at 0.75 × ARENA never washes out something you are
  // aiming at, and full opacity at 2.4 × ARENA leaves the far corner (0.7 × the
  // diagonal away) hazed but perfectly readable. When the arena grew from 44 to 64
  // these were 34 and 110, which put a quarter of the fog ramp inside the sniper's
  // working range.
  scene.fog = new THREE.Fog(C.PALETTE.bg, ARENA * 0.75, ARENA * 2.4);

  const camera = new THREE.PerspectiveCamera(baseFov, 1, 0.05, 300);
  camera.rotation.order = 'YXZ'; // yaw then pitch — the only sane order for an FPS
  scene.add(camera);

  // ---- viewmodel pass -------------------------------------------------------
  // The weapon gets its own scene and camera, drawn second with the depth buffer
  // cleared. This is the standard shooter arrangement and it fixes three things at
  // once that a camera-parented viewmodel cannot:
  //
  //   * Clipping. The rifle is ~0.66u long and rests 0.2u from the eye, so its stock
  //     sat behind the main camera's 0.05 near plane. Front faces got cut, backfaces
  //     are culled, and what you saw was the hollow inside of the receiver — "you can
  //     see the inside of the gun". Near 0.002 here is closer than any part of any rig.
  //   * The whole weapon being visible. The stock was not merely clipped, it was
  //     behind the camera entirely and could never be drawn. That matters beyond
  //     looks: skins are meant to be sellable, and half a gun cannot show one off.
  //   * Poking through walls. A separate pass has its own depth buffer, so the world
  //     can never be in front of the weapon — press into a wall and the gun stays
  //     solid instead of the wall eating it.
  //
  // The camera stays at the origin with no rotation: every rig offset is already
  // expressed in camera space, so this scene *is* camera space and nothing has to
  // track the view. Its FOV is deliberately independent of the player's — the world
  // FOV slider and the sniper's zoom must not stretch the weapon.
  const vmScene = new THREE.Scene();
  const vmCamera = new THREE.PerspectiveCamera(VM_FOV, 1, 0.002, 6);
  vmScene.add(vmCamera);

  // View-fixed lighting, which is why it is not simply a copy of the sun. In camera
  // space a fixed direction means the weapon's faces keep the same brightness as you
  // turn — steady, readable, and what every shooter does with a viewmodel. Tracking
  // the world sun instead would strobe the gun's shading every time you looked around.
  vmScene.add(new THREE.HemisphereLight(0xdfe8f5, 0x9aa2b0, 0.7));
  const vmKey = new THREE.DirectionalLight(0xfff6e8, 1.05);
  vmKey.position.set(-0.6, 1, 0.55); // upper-left-front, so the near side catches light
  vmScene.add(vmKey);

  // The ground term is the important half. With a near-black bounce every
  // downward-facing face fell to a void, which is most of what read as "too dark".
  scene.add(new THREE.HemisphereLight(0xf2f7ff, 0xaab3b5, 0.9));

  // Intensities come down as the albedos go up: the sum of hemisphere and sun on a
  // sun-facing face has to stay near 1.55, or lit faces clip to white and the
  // per-face brightness spread that carries the whole look disappears.
  const sun = new THREE.DirectionalLight(0xfff1d2, 1.25);
  // Direction is what matters for shading — a directional light points from its
  // position at the origin — so this is deliberately far enough out that the whole
  // arena fits between its near and far planes. Scaling the vector moves the shadow
  // frustum without changing a single face's brightness.
  sun.position.set(34, 58, 24);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0006;
  // The orthographic shadow frustum has to contain the arena as the light sees it, and
  // the worst case is the diagonal: half of it is 0.71 × ARENA, so anything less
  // silently stops casting in the corners. It was a flat 30 against a 44u arena, which
  // only just covered that one and covers none of this one — the symptom is shadows
  // that vanish as you walk toward a wall, which reads as a lighting glitch rather
  // than as a frustum. Texels get larger as this grows (0.047u here), which is still
  // several times finer than the 0.8u-wide thing whose shadow matters most.
  const extent = ARENA * 0.75;
  sun.shadow.camera.left = -extent;
  sun.shadow.camera.right = extent;
  sun.shadow.camera.top = extent;
  sun.shadow.camera.bottom = -extent;
  sun.shadow.camera.near = 1;
  // Far enough to reach the corner furthest from the light: |sun - (-32, 0, -32)|.
  sun.shadow.camera.far = 140;
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun);

  buildEnvironment(scene);

  const avatars = new Map();

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    vmCamera.aspect = w / h;
    vmCamera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  // ---- projectiles ----------------------------------------------------------
  // Pooled by id, and *simulated* locally rather than placed straight from the
  // snapshot.
  //
  // Snapshots arrive 20 times a second, so a grenade drawn from them alone moved in
  // 50 ms steps: at 144 Hz that is the same position for seven frames and then a jump,
  // which reads as the whole game stuttering. shared/projectile.js is shared for
  // exactly this reason — running the server's own stepper between snapshots gives
  // every frame its own position, bounces included.
  //
  // Each snapshot then resets the simulation to authority and hands the visible
  // difference to `ex/ey/ez`, which decays over a few frames. Same
  // correction-smoothing predict.js does for the local player: a bounce the client
  // called a tick early becomes a nudge instead of a pop.
  const projGeo = new THREE.IcosahedronGeometry(1, 0);
  const projMats = {
    grenade: new THREE.MeshLambertMaterial({ color: 0x4f5a3c, flatShading: true }),
    snowball: new THREE.MeshLambertMaterial({ color: 0xeef3f9, flatShading: true }),
    // The two utility canisters, coloured to match their viewmodels — a thrown object
    // you cannot identify in the air is a throw you cannot react to, and reacting to
    // someone else's flashbang (turn away) versus their smoke (push it) are opposite
    // decisions you get about a second to make.
    flash: new THREE.MeshLambertMaterial({ color: 0xb9c2ce, flatShading: true }),
    smoke: new THREE.MeshLambertMaterial({ color: 0x6f7a5c, flatShading: true }),
  };
  const projPool = [];
  const projLive = new Map(); // id → { mesh, sim, ex, ey, ez }
  let predictedProjectileId = 0;
  /** Error decay, 1/s. */
  const PROJ_SMOOTH = 16;
  /** Disagreement past which smoothing would be a lie — snap instead. */
  const PROJ_SNAP = 1.2;

  function projMesh() {
    for (const m of projPool) if (!m.visible) return m;
    const m = new THREE.Mesh(projGeo, projMats.grenade);
    m.frustumCulled = false;
    scene.add(m);
    projPool.push(m);
    return m;
  }

  function beginProjectile(key, sim, predicted = false, born = performance.now()) {
    const mesh = projMesh();
    mesh.material = projMats[sim.kind] ?? projMats.grenade;
    mesh.scale.setScalar(sim.kind === 'snowball' ? 0.1 : 0.12);
    mesh.position.set(sim.x, sim.y, sim.z);
    mesh.visible = true;
    const p = {
      mesh, sim,
      ex: 0, ey: 0, ez: 0,
      px: sim.x, py: sim.y, pz: sim.z,
      spin: 0, predicted, born,
    };
    projLive.set(key, p);
    return p;
  }

  // ---- bursts ---------------------------------------------------------------
  // A grenade and a snowball both "end", and that is the only thing they have in
  // common. One is a detonation — flash, fireball, ground shockwave, casing fragments,
  // smoke that hangs. The other is a handful of packed powder coming apart. Both used
  // to be the same expanding sphere in two different colours, which is why neither
  // read as itself.
  //
  // One pooled cluster carries every part any kind needs; a kind leaves the parts it
  // has no use for at `null` and they are never shown. Everything is driven off a
  // single age in milliseconds, so an effect costs no allocation and no per-part
  // timers, and the whole shape of it is legible in the table below.
  const SMOKE = 7;
  const SHARDS = 14;
  /** Debris gravity. Cosmetic and deliberately not the simulation's: fragments have
   *  to settle inside the effect's own lifetime. */
  const CHIP_G = 17;

  const BURST_KINDS = {
    grenade: {
      ms: 950,
      // The muzzle-bright core. Very short: this is the part that says "detonation"
      // rather than "fire", and holding it any longer turns it into a lamp.
      flash: { hex: 0xfff4d2, from: 0.5, peak: 1.7, ms: 120, opacity: 1 },
      // The fireball proper, cooling from orange to a dark ember as it expands.
      ball: { hex: 0xff9a2e, cool: 0x6d2a0c, from: 0.45, peak: 2.4, ms: 320, opacity: 0.95 },
      // Ground shockwave, sized to the actual blast radius so what you see is what
      // the server damaged.
      ring: { hex: 0xffd9a0, from: 0.12, peak: 4.6, ms: 380, opacity: 0.85, delay: 40 },
      smoke: {
        hex: 0x43443f, count: SMOKE, from: 0.3, peak: 1.6, ms: 950,
        speed: 3.4, rise: 2.1, drag: 2.6, opacity: 0.55,
      },
      shard: {
        hex: 0x2b2c2f, count: 12, size: 0.055, ms: 640,
        speed: 10, spread: 1, gravity: CHIP_G, glow: 0xffae52,
      },
      // Lambert world geometry means one real light does more for the bang than any
      // amount of extra geometry: walls near the blast actually brighten.
      light: { hex: 0xffb066, intensity: 30, dist: 17, ms: 240 },
      mark: null,
    },
    snowball: {
      ms: 780,
      flash: null, // snow does not flash
      // Powder, thrown out of the break rather than expanding like a fireball.
      ball: { hex: 0xf4f9ff, from: 0.22, peak: 1.1, ms: 300, opacity: 0.9 },
      ring: { hex: 0xffffff, from: 0.1, peak: 1.5, ms: 320, opacity: 0.45, delay: 0 },
      smoke: {
        hex: 0xe8f1fb, count: 5, from: 0.22, peak: 0.8, ms: 700,
        speed: 2.2, rise: 0.7, drag: 3.4, opacity: 0.5,
      },
      // The part that makes it read as *breaking*: hard little shards, not a puff.
      shard: {
        hex: 0xf2f7ff, count: SHARDS, size: 0.05, ms: 700,
        speed: 5.6, spread: 1.15, gravity: 13, glow: null,
      },
      light: null,
      // What is left on the wall afterwards, for the moment or two before it fades.
      mark: { hex: 0xf7fbff, peak: 0.36, ms: 700, opacity: 0.8 },
    },

    // A flashbang, which is a light source that happens to be a grenade. Everything
    // here is white and there is deliberately no low end and no fireball: the effect
    // has to read as *brightness* rather than as a small explosion, because the thing
    // it is announcing is the white-out that hud.blind() is about to put on the screen
    // of everyone who was looking at it.
    flash: {
      ms: 760,
      // Far bigger and longer than the grenade's core. On a grenade the flash says
      // "detonation"; here it IS the weapon.
      flash: { hex: 0xffffff, from: 0.55, peak: 3.4, ms: 260, opacity: 1 },
      ball: { hex: 0xf4f7ff, cool: 0x9db4d6, from: 0.5, peak: 2, ms: 320, opacity: 0.85 },
      ring: { hex: 0xffffff, from: 0.14, peak: 5.4, ms: 320, opacity: 0.9, delay: 20 },
      smoke: {
        hex: 0xd8dee8, count: 4, from: 0.3, peak: 1.1, ms: 620,
        speed: 3, rise: 1.6, drag: 3, opacity: 0.32,
      },
      // The casing coming apart. Few and small — this is a detail, not the event.
      shard: {
        hex: 0x9aa3b2, count: 5, size: 0.03, ms: 460,
        speed: 8.5, spread: 1, gravity: CHIP_G, glow: 0xffffff,
      },
      // Twice the grenade's reach and much brighter. A flashbang lights the room it
      // goes off in, and with Lambert geometry that one light does more to sell it
      // than any amount of extra billboard.
      light: { hex: 0xffffff, intensity: 62, dist: 26, ms: 300 },
      mark: null,
    },
    // A smoke canister popping. Deliberately the smallest effect in the table: the
    // cloud that follows is the weapon, and it is drawn by syncClouds rather than here.
    // All this has to do is show where the cloud is about to come from.
    smoke: {
      ms: 900,
      flash: null,
      ball: { hex: 0xd9dee6, from: 0.28, peak: 1.5, ms: 480, opacity: 0.55 },
      ring: null,
      smoke: {
        hex: 0xccd3dd, count: SMOKE, from: 0.3, peak: 2, ms: 900,
        speed: 2.6, rise: 1.2, drag: 2.2, opacity: 0.5,
      },
      shard: {
        hex: 0x5a6350, count: 3, size: 0.028, ms: 520,
        speed: 4.6, spread: 1.1, gravity: CHIP_G, glow: null,
      },
      light: null,
      mark: null,
    },
  };

  const shardGeo = new THREE.TetrahedronGeometry(1, 0);
  const ringGeo = new THREE.RingGeometry(0.82, 1, 32);
  const markGeo = new THREE.CircleGeometry(1, 20);
  const softMat = (hex = 0xffffff) =>
    new THREE.MeshBasicMaterial({
      color: hex,
      transparent: true,
      opacity: 0,
      depthWrite: false, // additive-ish parts must not occlude each other
      side: THREE.DoubleSide,
    });

  const bursts = [];
  for (let i = 0; i < 5; i++) {
    const add = (mesh) => {
      mesh.frustumCulled = false;
      mesh.visible = false;
      scene.add(mesh);
      return mesh;
    };
    // One material per part group rather than per mesh: every smoke puff in a cluster
    // shares a colour and an opacity, so it can share the shader with them too.
    const smokeMat = softMat();
    const shardMat = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      flatShading: true,
      transparent: true,
      opacity: 0,
    });
    const light = new THREE.PointLight(0xffffff, 0, 12, 2);
    light.visible = false;
    scene.add(light);

    bursts.push({
      k: null,
      born: 0,
      until: 0,
      flash: add(new THREE.Mesh(projGeo, softMat())),
      ball: add(new THREE.Mesh(projGeo, softMat())),
      ring: add(new THREE.Mesh(ringGeo, softMat())),
      mark: add(new THREE.Mesh(markGeo, softMat())),
      smokeMat,
      smoke: Array.from({ length: SMOKE }, () => ({
        mesh: add(new THREE.Mesh(projGeo, smokeMat)),
        vx: 0, vy: 0, vz: 0,
      })),
      shardMat,
      shards: Array.from({ length: SHARDS }, () => ({
        mesh: add(new THREE.Mesh(shardGeo, shardMat)),
        vx: 0, vy: 0, vz: 0, spin: 0,
      })),
      light,
    });
  }
  let burstCursor = 0;

  /** Swell-and-fade for one of the single-mesh parts. `k` is age/lifetime. */
  function swell(mesh, cfg, age) {
    const k = (age - (cfg.delay ?? 0)) / cfg.ms;
    if (k < 0 || k >= 1) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;
    const e = 1 - (1 - k) ** 2.2; // fast out, easing into its final size
    mesh.scale.setScalar(cfg.peak * (cfg.from + (1 - cfg.from) * e));
    mesh.material.opacity = cfg.opacity * (1 - k) ** 1.6;
  }

  // ---- impacts --------------------------------------------------------------
  // A shot that stops on a wall has to leave something behind. Without this you could
  // empty a magazine into cover, or slash it, and nothing anywhere acknowledged it —
  // the geometry read as something the shot passed straight through. The server has
  // always stopped shots at walls; what was missing was any sign of it.
  //
  // Each impact is a cluster: chips thrown back out of the surface under gravity, and
  // a puff at the point of contact that swells and thins. Pooled per cluster, so a
  // burst of fire recycles the oldest one instead of allocating.
  const IMPACT_MS = 420;
  const CHIPS = 5;
  // Debris gravity is CHIP_G, up with the burst table — impacts and explosions throw
  // the same kind of junk around and it has to fall at the same rate.
  //
  // `mark` is the decal the hit leaves behind, and it is the part with a life of its
  // own: the chips and the puff are gone in IMPACT_MS, but a bullet scar, a blade
  // scratch or a smear of blood stays for `mark.ms` — "it doesnt need to stay the whole
  // game it can just disappear in few seconds". A flat oriented disc laid on the surface
  // along the same normal the debris leaves by, so it sits ON the wall rather than
  // hovering. `long` stretches it across the surface into a streak — a graze rather than
  // a dot — which is what tells a blade scratch and a spray of blood apart from a round
  // bullet hole.
  const IMPACT_KINDS = {
    bullet: {
      chip: 0xbdb6a8, puff: 0xe4e0d6, size: 0.028, speed: 3.6, spread: 0.5, puff0: 0.1,
      mark: { hex: 0x201a14, r: 0.075, long: 1, ms: 4000 },
    },
    slash: {
      chip: 0xd6dde6, puff: 0xeaf0f7, size: 0.022, speed: 2.5, spread: 1.15, puff0: 0.085,
      mark: { hex: 0x3a4653, r: 0.05, long: 3.4, ms: 3200 },
    },
    body: {
      chip: 0xa8443a, puff: 0xb35247, size: 0.019, speed: 2.1, spread: 0.75, puff0: 0.07,
      mark: { hex: 0x7c0f0a, r: 0.11, long: 1.5, ms: 4800 },
    },
  };
  const impacts = [];
  for (let i = 0; i < 10; i++) {
    // One material per cluster, not per chip: every chip in an impact shares a colour
    // and an opacity, so they can share the material and the shader with it.
    const mat = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      flatShading: true,
      transparent: true,
      opacity: 0,
    });
    const puffMat = softMat();
    const chips = [];
    for (let c = 0; c < CHIPS; c++) {
      const mesh = new THREE.Mesh(projGeo, mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      scene.add(mesh);
      chips.push({ mesh, vx: 0, vy: 0, vz: 0 });
    }
    const puff = new THREE.Mesh(projGeo, puffMat);
    puff.frustumCulled = false;
    puff.visible = false;
    scene.add(puff);
    impacts.push({ chips, puff, mat, puffMat, k: IMPACT_KINDS.bullet, born: 0, until: 0 });
  }
  let impactCursor = 0;

  // ---- decals ---------------------------------------------------------------
  // The mark a hit leaves on the surface, and it gets its own pool rather than riding
  // on the impact cluster above. That is a capacity decision, not tidiness: a decal
  // lives for seconds and a cluster of debris for 420ms, so sharing the 10 clusters
  // would have the machine gun — 105ms between rounds — recycling a four-second bullet
  // scar barely one second in. Sized so a full magazine of anything in the game is
  // still on the wall when the next one starts.
  const DECALS = 64;
  const decals = [];
  for (let i = 0; i < DECALS; i++) {
    // One material each: they fade on independent clocks, so they cannot share opacity.
    const mat = softMat();
    const mesh = new THREE.Mesh(markGeo, mat);
    mesh.frustumCulled = false;
    mesh.visible = false;
    scene.add(mesh);
    decals.push({ mesh, mat, born: 0, until: 0 });
  }
  let decalCursor = 0;

  // ---- smoke clouds ---------------------------------------------------------
  // A cloud is world state, not an effect: the server keeps it in `room.clouds`, puts it
  // in every snapshot as `sm`, and tests sightlines against it — bots included. So this
  // has one job and it is not decoration. What is drawn has to agree with what blocks,
  // or a player learns that throwing a smoke is a way of hiding from nobody.
  //
  // Drawn as a cluster of overlapping spheres rather than one big one. A single
  // translucent ball reads as a bubble — you see its silhouette, which is the opposite
  // of smoke; a dozen overlapping ones build up to opaque through the middle and fray at
  // the edge, which is what a cloud looks like. They are DoubleSide on purpose: standing
  // inside one, the front faces are all behind you, and a smoke you can see out of from
  // the inside is the same bug as one that does not block at all.
  const CLOUD_PUFFS = 11;
  const cloudGeo = new THREE.IcosahedronGeometry(1, 2);
  /**
   * Where each puff sits inside a unit cloud, and how big it is.
   *
   * Fixed rather than rolled per cloud: a layout re-rolled each frame boils, and one
   * rolled per cloud costs a random-number generator's worth of nothing for a difference
   * nobody can see through smoke.
   *
   * `offset + size` is kept under 1 deliberately, so the drawn cloud is a little SMALLER
   * than the sphere the server blocks vision with. That asymmetry is the safe direction:
   * anybody who looks hidden is hidden. The reverse would have players standing in what
   * they can see is cover and being shot through it.
   */
  const CLOUD_LAYOUT = Array.from({ length: CLOUD_PUFFS }, (_, i) => {
    // Golden angle around, evenly spaced in height: a spread with no visible ring or
    // seam, from eleven puffs and no randomness.
    const a = i * 2.39996;
    const h = (i / (CLOUD_PUFFS - 1)) * 2 - 1;
    const r = 0.42 * Math.sqrt(Math.max(0, 1 - h * h));
    return {
      x: Math.cos(a) * r,
      y: h * 0.4,
      z: Math.sin(a) * r,
      s: 0.4 + 0.12 * Math.sin(i * 1.7),
      ph: a,
    };
  });
  /** How long a cloud takes to billow up to full size, and to fade once the server has
   *  dropped it. It leaves the snapshot the instant it expires, so the fade is the
   *  client's own — a cloud that vanished between two frames would look like a bug. */
  const CLOUD_IN_MS = 750;
  const CLOUD_OUT_MS = 560;
  const CLOUD_OPACITY = 0.5;

  const cloudPool = [];
  const cloudLive = new Map(); // cloud id → rig

  function cloudRig() {
    for (const c of cloudPool) if (!c.used) return c;
    // One material per cloud: opacity is animated per cloud, so the puffs of one cloud
    // can share a material with each other but not with another cloud's.
    const mat = new THREE.MeshBasicMaterial({
      color: 0xc9d0da,
      transparent: true,
      opacity: 0,
      depthWrite: false, // overlapping puffs must blend, not occlude each other
      side: THREE.DoubleSide,
    });
    const rig = {
      used: false,
      mat,
      puffs: CLOUD_LAYOUT.map(() => {
        const m = new THREE.Mesh(cloudGeo, mat);
        m.frustumCulled = false;
        m.visible = false;
        scene.add(m);
        return m;
      }),
      x: 0, y: 0, z: 0, r: 1,
      /** The radius the cloud is DRAWN at right now — `r` shrunk by CLOUD_DRAWN and by
       *  however far the billow has got. Kept per cloud because it is what `smokeWake`
       *  clips a bullet's path against, and a cloud one frame old is not full size. */
      drawnR: 0,
      born: 0,
      /** When it left the snapshot, or 0 while the server still has it. */
      goneAt: 0,
    };
    cloudPool.push(rig);
    return rig;
  }

  // ---- bullets through smoke ------------------------------------------------
  // "just like in cs2 you can shoot on the smoke and you can see details a bit on the
  // bullet way you get me right when you shoot on the smoke similar to cs2."
  //
  // The tracer itself is drawn in viewmodel.js and is already there — but inside a cloud
  // it is invisible, and not for a fixable reason. Eleven puffs at CLOUD_OPACITY 0.5
  // build to about 0.999 coverage through the middle, and roughly half of them sort in
  // FRONT of any point on the path, so a 0.95-opacity hairline comes through at a few
  // percent. Turning the cloud down to let the tracer show would undo the thing the cloud
  // is for.
  //
  // So this draws the path a second time, as its own object, clipped to the span that is
  // actually inside a cloud and rendered ON TOP of it. Additive rather than opaque: what
  // a round does to smoke is disturb and light it, so the streak brightens the grey it
  // crosses instead of cutting a hole through it — and additive over nothing is nothing,
  // which is why this can be drawn without checking whether the camera is inside.
  //
  // It swells as it fades, because the read is not the bullet (long gone) but the wake it
  // left, and a wake that thins without spreading looks like a wire being switched off.
  const WAKE_MS = 460;
  const WAKE_R0 = 0.035;
  const WAKE_R1 = 0.2;
  /** How far the DRAWN cloud reaches, as a fraction of the radius the server blocks with.
   *  Derived from the layout rather than guessed: a wake clipped to the server's sphere
   *  would poke out of both ends of the smaller cloud that is actually on screen. */
  const CLOUD_DRAWN = Math.max(...CLOUD_LAYOUT.map((L) => Math.hypot(L.x, L.y, L.z) + L.s));
  /** Most spans one shot can light up. A round crossing two overlapping clouds gets two
   *  streaks; the cap is what stops a shotgun's eight pellets through a double smoke from
   *  eating the whole pool on one trigger pull. */
  const WAKE_PER_SHOT = 3;
  const wakeGeo = new THREE.BoxGeometry(1, 1, 1);
  const wakes = [];
  for (let i = 0; i < 16; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xfff0d2,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(wakeGeo, mat);
    mesh.frustumCulled = false;
    mesh.visible = false;
    // After the clouds, which sit at the default 0. Depth TESTING stays on, so a wake is
    // still cut off by a wall the round stopped at; it is only the cloud it ignores.
    mesh.renderOrder = 2;
    scene.add(mesh);
    wakes.push({ mesh, mat, len: 0, born: 0, until: 0 });
  }
  let wakeCursor = 0;

  /** Effect integration needs a delta, and `tickEffects` is handed only a timestamp.
   *  Deriving it here keeps the frame loop's call unchanged. */
  let lastEffectAt = 0;
  return {
    renderer,
    scene,
    camera,
    /** Where the viewmodel hangs. This is camera space, so rig offsets go in
     *  unchanged — but it is a different scene with a much nearer near plane and its
     *  own depth buffer, which is what stops the weapon clipping and stops the world
     *  drawing over it. */
    vmRoot: vmCamera,
    resize,

    /** Zoom. Called every frame with an already-eased value, so it must stay cheap
     *  — the early-out matters: updateProjectionMatrix on an unchanged FOV is pure
     *  waste at 144 Hz. */
    setFov(deg) {
      if (Math.abs(camera.fov - deg) < 0.01) return;
      camera.fov = deg;
      camera.updateProjectionMatrix();
    },

    /** Viewmodel FOV — the weapon's own framing, unaffected by world FOV or zoom.
     *  Narrower fills more of the screen with the gun; wider pushes it away and
     *  shows more of it. Same early-out as setFov, for the same reason. */
    setVmFov(deg) {
      if (Math.abs(vmCamera.fov - deg) < 0.01) return;
      vmCamera.fov = deg;
      vmCamera.updateProjectionMatrix();
    },

    /** @param corpseMs how long a body lies there before fading, from the mode. */
    syncAvatars(states, selfId, now, corpseMs, roster = null) {
      for (const [id, p] of states) {
        if (id === selfId) continue; // we're inside our own head
        let a = avatars.get(id);
        if (!a) {
          a = makeAvatar(id);
          scene.add(a.group);
          avatars.set(id, a);
          // Seed the turn rate from where they actually are, or the first frame differences
          // this player's yaw against 0 and reads as a spin from due north.
          a.yawPrev = p.yaw;
        }
        setAvatarTeam(a, p.tm ?? 0);
        setAvatarFinish(a, roster?.get?.(id)?.fn);
        a.group.position.set(p.x, p.y, p.z);
        a.group.rotation.y = p.yaw;
        // Whatever they are holding, before anything poses the hands around it. On the wire
        // for every player, so there is nothing to guess and no reason for a snowball mode
        // to have rifles in it.
        setAvatarWeapon(a, p.w);
        const dtMs = a.pt ? now - a.pt : 16;
        a.pt = now;

        if (p.a === 1) {
          if (a.deadAt) reviveAvatar(a);
          setAvatarCrouch(a, p.cr ?? 0);
          setAvatarShield(a, (p.sp ?? 0) > 0);
          // After the crouch, never before it: `aimPlate` reads the duck height back off the
          // avatar, so the order here is what keeps the plate on the crown of a body that
          // ducked this frame instead of a frame behind it.
          setAvatarPlate(a, p.rk ?? 0);
          aimPlate(a, camera);
          // Pitch is split between the head and the shoulders, at a fraction each. The
          // camera pitches the full ±90°; a person does not, and putting all of it on
          // one joint gave either an owl's neck or a rifle pointing at the sky from a
          // body facing forward. Together they still add up to a readable aim. The head
          // takes its share immediately and the shoulders take theirs late, by weight —
          // which is `poseUpper`'s job, along with the hands and the weapon.
          a.pivot.rotation.x = p.pitch * HEAD_PITCH;
          poseUpper(a, p.pitch, p.yaw, p.jm ?? 0, now, dtMs);
          stepGait(a, p.x, p.z, dtMs);
          a.group.visible = true;
          continue;
        }

        // Dead. The server has frozen the body, so this is all render-side: topple
        // it over, settle it onto the ground, and hold it there.
        if (!a.deadAt) a.deadAt = now;
        setAvatarShield(a, false); // a corpse is not protected, whatever the last live frame said
        // And no rank on a corpse. A badge hovering upright over a body that has toppled onto
        // its back is the same class of bug as a spawn ring on a dead player, which is why it
        // is turned off on the line below it rather than somewhere else.
        a.plate.visible = false;
        const t = now - a.deadAt;
        const k = easeOut(Math.min(1, t / TOPPLE_MS));
        // A body relaxes as it goes over. Easing whatever crouch it died in out
        // across the topple means the corpse lies at full length and there is no
        // pop at the instant of death — and it keeps the drop below honest, since
        // the two have to resolve together or the body lands buried or floating.
        const cr = (p.cr ?? 0) * (1 - k);
        setAvatarCrouch(a, cr);
        // Falls backward, away from the shooter, with a roll of its own so two bodies never
        // land in the same shape. The drop is the distance from the standing centre to where
        // the BACK of a supine box figure rests — it used to be a capsule's radius, which
        // left every corpse in the game hanging 22cm in the air.
        a.tilt.rotation.set((Math.PI / 2) * k, 0, a.roll * k);
        a.tilt.position.y = -corpseDrop(cr) * k;
        if (k < 1) {
          // Everything the living body was doing unwinds across the same topple: the hands
          // let go, the legs stop mid-stride, and the run's vertical bob settles out. A
          // corpse frozen in a running pose was the rest of "even when death they float".
          poseDeadUpper(a, k);
          a.duck.position.y *= 1 - k;
          for (const { hip, knee } of a.legs) {
            hip.rotation.x *= 1 - k;
            knee.rotation.x *= 1 - k;
          }
        }

        // Nothing tells the client when a remote player *will* respawn, only that
        // they have. Timing the fade off the mode's respawn delay means the corpse
        // has already gone by the time the body reappears, so the swap is never
        // visible. This has to come from the mode: it was hardcoded at 2200 ms, and
        // deathmatch now respawns at 5000, which would have made every corpse
        // vanish 2.8 s early.
        const fadeStart = Math.max(0, corpseMs - FADE_MS);
        const o = t <= fadeStart ? 1 : Math.max(0, 1 - (t - fadeStart) / FADE_MS);
        setAvatarOpacity(a, o);
        a.group.visible = o > 0.01;
      }

      for (const [id, a] of avatars) {
        if (states.has(id) && id !== selfId) continue;
        scene.remove(a.group);
        a.group.traverse((o) => o.geometry?.dispose());
        for (const m of a.materials) m.dispose();
        a.shieldMat.dispose();
        // The plate's own material. Its GEOMETRY needs no line here: the traverse above frees
        // it, and that is only correct because the plate is a Mesh carrying a PlaneGeometry of
        // its own. Anyone tempted to make it a THREE.Sprite should read why it is not one.
        a.plateMat.dispose();
        avatars.delete(id);
      }
    },

    /**
     * A remote player fired: kick their weapon and work their action.
     *
     * Driven off EV.SHOT rather than off the snapshot, because a shot is an instant and a
     * snapshot is a 50ms window — a burst would land as one nudge instead of three, and the
     * bolt stroke would start up to a snapshot late. The weapon index comes from the event
     * for the same reason: the event can arrive before the snapshot that changes `w`.
     *
     * Silently ignores a player with no avatar yet. That is the frame between joining and
     * the first snapshot, and there is nothing to animate.
     */
    avatarShot(id, w, now) {
      const a = avatars.get(id);
      if (a) avatarShot(a, w, now);
    },

    /** Start our own cosmetic copy at click time. The server still decides whether the
     * throw exists and where it bursts; this only covers the round trip before its first
     * snapshot. When authority arrives, syncProjectiles adopts this mesh and corrects it. */
    predictProjectile(kind, owner, x, y, z, dir, now, lob = false) {
      const sim = createProjectile(kind, owner, x, y, z, dir, now, lob);
      sim.diesAt = Infinity;
      beginProjectile(`pred:${++predictedProjectileId}`, sim, true, now);
    },

    /**
     * Reconcile the locally simulated projectiles against the latest snapshot.
     *
     * Snapshots carry position and velocity, so a projectile the client has never seen
     * continues its arc on the very first frame rather than freezing at release while
     * it waits for a second position sample. Everything already in the air is corrected: authority
     * goes into the simulation, and the visible difference is parked in `ex/ey/ez` so
     * it decays instead of popping.
     *
     * @param list `proj` from the snapshot, or undefined when nothing is in the air.
     */
    syncProjectiles(list) {
      const now = performance.now();
      for (const [id, p] of projLive) {
        if (!list?.some((q) => q.i === id)) {
          // A locally predicted throw is expected to be absent while the input and first
          // snapshot cross the network. Keep it for one second; authority normally adopts
          // it much sooner, and a rejected throw then disappears without ever exploding.
          if (p.predicted && now - p.born < 1000) continue;
          p.mesh.visible = false;
          projLive.delete(id);
        }
      }
      if (!list) return;
      for (const q of list) {
        let p = projLive.get(q.i);
        if (!p) {
          // Adopt the oldest unmatched local copy of the same kind. Reusing its mesh is
          // what makes prediction continuous rather than a fake grenade disappearing as
          // the real one pops into existence beside it.
          const guessed = [...projLive].find(([, v]) =>
            v.predicted && v.sim.kind === q.k && v.sim.owner === q.o);
          if (guessed) {
            projLive.delete(guessed[0]);
            p = guessed[1];
            p.predicted = false;
            projLive.set(q.i, p);
          } else {
            // Only the fields shared/projectile.js touches. The fuse remains the server's
            // business: BURST removes this mesh at the authoritative instant.
            p = beginProjectile(q.i, {
              kind: q.k, owner: q.o, x: q.x, y: q.y, z: q.z,
              vx: Number.isFinite(q.vx) ? q.vx : 0,
              vy: Number.isFinite(q.vy) ? q.vy : 0,
              vz: Number.isFinite(q.vz) ? q.vz : 0,
              diesAt: Infinity, done: false,
            });
          }
        }

        const s = p.sim;
        const dx = q.x - s.x;
        const dy = q.y - s.y;
        const dz = q.z - s.z;

        // New servers send velocity directly. Keep the position-pair fallback so a
        // client refreshing during a rolling deploy remains playable against an older
        // host for the few minutes before Render replaces it.
        //
        // This used to read `(q.x - (s.x - p.ex)) / dt`, using the local sim's current
        // position as the older sample. That is the one position guaranteed to be wrong
        // for the purpose: the sim has already integrated a snapshot's worth of travel,
        // so a sim tracking authority perfectly gave `q.x - s.x === 0` and the inferred
        // velocity was ZERO. The projectile then sat still for a snapshot, arrived
        // 1.2 m behind on the next one, got its real velocity back, and stalled again —
        // alternating 0, v, 0, v at 20 Hz. That was the "grenade ticks like it is
        // lagging" report: not the network, an arithmetic error in the estimator.
        const dt = C.TICKS_PER_SNAPSHOT * C.TICK_DT;
        s.vx = Number.isFinite(q.vx) ? q.vx : (q.x - p.px) / dt;
        s.vy = Number.isFinite(q.vy) ? q.vy : (q.y - p.py) / dt;
        s.vz = Number.isFinite(q.vz) ? q.vz : (q.z - p.pz) / dt;
        p.px = q.x;
        p.py = q.y;
        p.pz = q.z;

        if (dx * dx + dy * dy + dz * dz > PROJ_SNAP * PROJ_SNAP) {
          // Too far to smooth — a fresh throw, or a bounce the local sim missed
          // entirely. Take authority as-is.
          p.ex = p.ey = p.ez = 0;
        } else {
          // Park the visible disagreement in the error term so the drawn position does
          // not jump on the snapshot; `tickEffects` decays it away over a few frames.
          p.ex += s.x - q.x;
          p.ey += s.y - q.y;
          p.ez += s.z - q.z;
        }

        s.x = q.x;
        s.y = q.y;
        s.z = q.z;
        s.done = false;
      }
    },

    /**
     * Reconcile the drawn smoke clouds against the latest snapshot.
     *
     * Unlike projectiles there is nothing to simulate: a cloud does not move, so the
     * snapshot is the whole truth about it and this only has to decide what is arriving,
     * what is still here, and what has gone. Position and radius are re-read every time
     * rather than only on creation — it costs nothing and it means a server that ever
     * grows or drifts a cloud needs no change here.
     *
     * @param list `sm` from the snapshot, or undefined when nothing is out.
     * @param now  the frame's timestamp, for the bloom and the fade.
     */
    syncClouds(list, now) {
      for (const [id, c] of cloudLive) {
        const q = list?.find((s) => s.i === id);
        if (q) {
          // Still out. Also un-retires a cloud whose id came back, which only happens
          // across a reconnect into a fresh room — but a cloud stuck mid-fade forever
          // would be a leak of one rig per occurrence.
          c.goneAt = 0;
          c.x = q.x;
          c.y = q.y;
          c.z = q.z;
          c.r = q.r;
        } else if (!c.goneAt) {
          c.goneAt = now;
        }
      }
      for (const q of list ?? []) {
        if (cloudLive.has(q.i)) continue;
        const c = cloudRig();
        c.used = true;
        c.born = now;
        c.goneAt = 0;
        c.x = q.x;
        c.y = q.y;
        c.z = q.z;
        c.r = q.r;
        // The drawn extent, which is what a bullet's wake gets clipped to. Written here
        // as well as in tickEffects so a cloud that is shot through on the very frame it
        // arrives is not clipped against zero.
        c.drawnR = q.r * CLOUD_DRAWN * 0.35;
        cloudLive.set(q.i, c);
      }
    },

    /**
     * Light up the span of a shot that passed through smoke.
     *
     * Called for every trace, and does nothing at all when nothing was crossed — which is
     * the common case and costs one sphere test per live cloud. Clipped per cloud rather
     * than drawn end to end so a round that clears a smoke and travels on does not leave a
     * streak hanging in clear air past it.
     *
     * @param from muzzle, @param to wherever the round stopped.
     */
    smokeWake(from, to, now) {
      if (!cloudLive.size) return;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dz = to.z - from.z;
      const len2 = dx * dx + dy * dy + dz * dz;
      if (len2 < 1e-6) return;

      let drawn = 0;
      for (const c of cloudLive.values()) {
        if (drawn >= WAKE_PER_SHOT) break;
        const rr = c.drawnR;
        if (!(rr > 0.01)) continue;
        // Segment against sphere, in the segment's own 0..1 parameter. `b` and `d` are the
        // usual quadratic terms; a negative discriminant is a miss and needs no sqrt.
        const ox = from.x - c.x;
        const oy = from.y - c.y;
        const oz = from.z - c.z;
        const b = ox * dx + oy * dy + oz * dz;
        const d = b * b - len2 * (ox * ox + oy * oy + oz * oz - rr * rr);
        if (d <= 0) continue;
        const sq = Math.sqrt(d);
        const t0 = Math.max(0, (-b - sq) / len2);
        const t1 = Math.min(1, (-b + sq) / len2);
        const span = (t1 - t0) * Math.sqrt(len2);
        // A round that clipped the very edge of a cloud. A 20cm streak is a speck, not a
        // path through anything, and drawing it costs a pool slot a real crossing wants.
        if (span < 0.25) continue;

        wakeCursor = (wakeCursor + 1) % wakes.length;
        const w = wakes[wakeCursor];
        const ax = from.x + dx * t0;
        const ay = from.y + dy * t0;
        const az = from.z + dz * t0;
        const bx = from.x + dx * t1;
        const by = from.y + dy * t1;
        const bz = from.z + dz * t1;
        w.len = Math.hypot(bx - ax, by - ay, bz - az);
        w.mesh.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
        w.mesh.lookAt(bx, by, bz);
        w.mesh.visible = true;
        w.born = now;
        w.until = now + WAKE_MS;
        drawn++;
      }
    },

    /**
     * A projectile ended here.
     *
     * A grenade detonates and a snowball breaks, and those are not the same event with
     * two colours — see BURST_KINDS for what each one is actually made of.
     *
     * @param n surface normal from the server, or null when the fuse simply ran out in
     *   mid-air. It orients the ground ring, the wall mark and the direction debris
     *   leaves in, so snow sprays out of the wall it broke on rather than straight up.
     */
    burst(kind, x, y, z, now, n = null) {
      const k = BURST_KINDS[kind] ?? BURST_KINDS.grenade;
      burstCursor = (burstCursor + 1) % bursts.length;
      const b = bursts[burstCursor];
      b.k = k;
      b.born = now;
      b.until = now + k.ms;

      // The surface frame. Without a normal, treat it as ground: an air burst has no
      // surface, and up is the only direction that is never wrong.
      iN.set(n?.[0] ?? 0, n?.[1] ?? 1, n?.[2] ?? 0);
      if (iN.lengthSq() < 1e-8) iN.set(0, 1, 0);
      iN.normalize();
      iT1.set(0, 1, 0);
      if (Math.abs(iN.y) > 0.9) iT1.set(1, 0, 0);
      iT1.crossVectors(iN, iT1).normalize();
      iT2.crossVectors(iN, iT1);

      for (const part of [b.flash, b.ball, b.ring, b.mark]) {
        part.visible = false;
        part.material.opacity = 0;
      }

      if (k.flash) {
        b.flash.material.color.setHex(k.flash.hex);
        b.flash.position.set(x, y, z);
      }
      if (k.ball) {
        b.ball.material.color.setHex(k.ball.hex);
        b.ball.position.set(x, y, z);
      }
      if (k.ring) {
        b.ring.material.color.setHex(k.ring.hex);
        // Lifted off the surface it lies on, or it z-fights the floor for its whole
        // life. `lookAt` along the normal is what makes the same ring work on a wall.
        b.ring.position.set(x, y, z).addScaledVector(iN, 0.03);
        b.ring.lookAt(b.ring.position.x + iN.x, b.ring.position.y + iN.y, b.ring.position.z + iN.z);
      }
      if (k.mark) {
        b.mark.material.color.setHex(k.mark.hex);
        b.mark.scale.setScalar(k.mark.peak);
        b.mark.position.set(x, y, z).addScaledVector(iN, 0.02);
        b.mark.lookAt(b.mark.position.x + iN.x, b.mark.position.y + iN.y, b.mark.position.z + iN.z);
      }

      // Smoke. Thrown out along the surface and lifted, so a blast against a wall
      // billows away from it instead of through it.
      b.smokeMat.color.setHex(k.smoke.hex);
      b.smokeMat.opacity = k.smoke.opacity;
      for (let i = 0; i < b.smoke.length; i++) {
        const s = b.smoke[i];
        if (i >= k.smoke.count) {
          s.mesh.visible = false;
          continue;
        }
        const a = (i / k.smoke.count + Math.random() * 0.3) * Math.PI * 2;
        const mag = k.smoke.speed * (0.5 + Math.random() * 0.7);
        iV.copy(iT1)
          .multiplyScalar(Math.cos(a))
          .addScaledVector(iT2, Math.sin(a))
          .addScaledVector(iN, 0.35)
          .normalize()
          .multiplyScalar(mag);
        s.vx = iV.x;
        s.vy = iV.y + k.smoke.rise;
        s.vz = iV.z;
        s.mesh.position.set(x, y, z).addScaledVector(iN, 0.05);
        s.mesh.visible = true;
      }

      // Fragments. Snow shards and casing splinters differ only in the numbers.
      b.shardMat.color.setHex(k.shard.hex);
      b.shardMat.emissive?.setHex(k.shard.glow ?? 0x000000);
      b.shardMat.opacity = 1;
      for (let i = 0; i < b.shards.length; i++) {
        const s = b.shards[i];
        if (i >= k.shard.count) {
          s.mesh.visible = false;
          continue;
        }
        const a = (i / k.shard.count + Math.random() * 0.2) * Math.PI * 2;
        const rise = 0.25 + Math.random() * 0.9;
        iV.copy(iN)
          .multiplyScalar(rise)
          .addScaledVector(iT1, Math.cos(a) * k.shard.spread)
          .addScaledVector(iT2, Math.sin(a) * k.shard.spread)
          .normalize()
          .multiplyScalar(k.shard.speed * (0.5 + 0.6 * Math.random()));
        s.vx = iV.x;
        s.vy = iV.y;
        s.vz = iV.z;
        s.spin = 8 + Math.random() * 14;
        s.mesh.position.set(x, y, z).addScaledVector(iN, 0.04);
        s.mesh.scale.setScalar(k.shard.size * (0.6 + Math.random() * 0.8));
        s.mesh.rotation.set(a, rise * 4, 0);
        s.mesh.visible = true;
      }

      if (k.light) {
        b.light.color.setHex(k.light.hex);
        b.light.distance = k.light.dist;
        b.light.intensity = k.light.intensity;
        b.light.position.set(x, y, z);
        b.light.visible = true;
      } else {
        b.light.visible = false;
        b.light.intensity = 0;
      }
    },

    /**
     * A shot or a swing landed on something solid.
     *
     * @param kind 'bullet' | 'slash' | 'body'.
     * @param at where it landed.
     * @param from where it came from. Reversed, this stands in for the surface
     *   normal. The true normal would mean putting the hit face on the wire, and the
     *   direction a shot arrived from is within a right angle of the normal for
     *   anything you can actually hit — debris only has to leave the surface
     *   convincingly, not correctly.
     */
    impact(kind, at, from, now) {
      const k = IMPACT_KINDS[kind] ?? IMPACT_KINDS.bullet;
      impactCursor = (impactCursor + 1) % impacts.length;
      const im = impacts[impactCursor];
      im.k = k;
      im.born = now;
      im.until = now + IMPACT_MS;
      im.mat.color.setHex(k.chip);
      im.mat.opacity = 1;
      im.puffMat.color.setHex(k.puff);
      im.puffMat.opacity = 0.75;

      // Out of the surface, back toward whoever fired.
      iN.set(at.x - from.x, at.y - from.y, at.z - from.z);
      if (iN.lengthSq() < 1e-8) iN.set(0, 1, 0);
      iN.normalize().negate();
      // Two directions across the surface. Crossed against whichever axis the normal
      // is least aligned with, so the pair can never collapse to zero length.
      iT1.set(0, 1, 0);
      if (Math.abs(iN.y) > 0.9) iT1.set(1, 0, 0);
      iT1.crossVectors(iN, iT1).normalize();
      iT2.crossVectors(iN, iT1);

      im.puff.position.set(at.x, at.y, at.z).addScaledVector(iN, k.puff0 * 0.4);
      im.puff.scale.setScalar(k.puff0 * 0.6);
      im.puff.visible = true;

      // The decal, from its own pool. Laid flat on the surface along the normal and
      // lifted a hair off it so it does not z-fight the wall, then stretched into a
      // streak by `long` across one surface axis — a round pock for a bullet, a long
      // scratch for a blade, a wider splash for blood. It lives seconds, long past the
      // cluster above, so the scar is still there when the chips have settled and gone.
      if (k.mark) {
        decalCursor = (decalCursor + 1) % decals.length;
        const d = decals[decalCursor];
        d.mat.color.setHex(k.mark.hex);
        d.mat.opacity = 1;
        d.born = now;
        d.until = now + k.mark.ms;
        d.mesh.position.set(at.x, at.y, at.z).addScaledVector(iN, 0.015);
        d.mesh.lookAt(d.mesh.position.x + iN.x, d.mesh.position.y + iN.y, d.mesh.position.z + iN.z);
        // Turn the disc a random amount about the normal so repeated hits on one wall do
        // not lay their streaks in lockstep, then stretch it along its own local X.
        d.mesh.rotateZ(Math.random() * Math.PI);
        d.mesh.scale.set(k.mark.r * k.mark.long, k.mark.r, 1);
        d.mesh.visible = true;
      }

      for (let i = 0; i < im.chips.length; i++) {
        const c = im.chips[i];
        // Fanned around the normal and jittered, so the same wall shot twice does not
        // throw the identical spray both times.
        const a = (i / CHIPS + Math.random() * 0.25) * Math.PI * 2;
        const rise = 0.4 + Math.random() * 0.7;
        iV.copy(iN)
          .multiplyScalar(rise)
          .addScaledVector(iT1, Math.cos(a) * k.spread)
          .addScaledVector(iT2, Math.sin(a) * k.spread)
          .normalize()
          .multiplyScalar(k.speed * (0.65 + 0.35 * rise));
        c.vx = iV.x;
        c.vy = iV.y;
        c.vz = iV.z;
        // Nudged off the surface, or half of every chip starts inside the wall and
        // z-fights its way out.
        c.mesh.position.set(at.x, at.y, at.z).addScaledVector(iN, 0.012);
        c.mesh.scale.setScalar(k.size * (0.7 + 0.5 * rise));
        c.mesh.rotation.set(a, rise * 3, 0);
        c.mesh.visible = true;
      }
    },

    /** Advance the effects. Separate from render() so it gets a timestamp. */
    tickEffects(now) {
      const dt = lastEffectAt ? Math.min(0.05, (now - lastEffectAt) / 1000) : 1 / 60;
      lastEffectAt = now;

      // Projectiles carry their own simulation between snapshots — see
      // syncProjectiles for why, and for how authority gets back in.
      for (const p of projLive.values()) {
        const s = p.sim;
        if (!s.done) stepProjectile(s, dt, WORLD_BOXES, 0);
        const decay = Math.exp(-PROJ_SMOOTH * dt);
        p.ex *= decay;
        p.ey *= decay;
        p.ez *= decay;
        p.mesh.position.set(s.x + p.ex, s.y + p.ey, s.z + p.ez);
        // Tumble at the speed it is travelling, so a grenade rolling along the floor
        // rolls, and one that has come to rest stops.
        const w = Math.hypot(s.vx, s.vy, s.vz) * dt;
        p.spin += w;
        p.mesh.rotation.set(p.spin * 1.6, p.spin * 1.1, 0);
      }

      // Clouds: billow in, churn while they are out, fade when the server drops them.
      // The churn is what stops a cloud reading as a static prop — two slow sines per
      // puff, out of phase with each other, which is cheaper than it looks and is the
      // difference between smoke and a pile of grey balls.
      for (const [id, c] of cloudLive) {
        if (c.goneAt && now - c.goneAt >= CLOUD_OUT_MS) {
          for (const m of c.puffs) m.visible = false;
          c.mat.opacity = 0;
          c.used = false;
          cloudLive.delete(id);
          continue;
        }
        const bloom = Math.min(1, (now - c.born) / CLOUD_IN_MS);
        const fade = c.goneAt ? 1 - Math.min(1, (now - c.goneAt) / CLOUD_OUT_MS) : 1;
        // Eased so it expands quickly and settles, rather than arriving at a constant
        // rate like something inflating.
        const grow = 0.35 + 0.65 * (1 - (1 - bloom) ** 2.4);
        c.mat.opacity = CLOUD_OPACITY * bloom * fade;
        c.drawnR = c.r * grow * CLOUD_DRAWN;
        for (let i = 0; i < c.puffs.length; i++) {
          const L = CLOUD_LAYOUT[i];
          const m = c.puffs[i];
          const churn = Math.sin(now * 0.00065 + L.ph) * 0.05;
          const roll = Math.cos(now * 0.00051 + L.ph * 1.7) * 0.05;
          m.position.set(
            c.x + (L.x + roll) * c.r * grow,
            c.y + (L.y + churn) * c.r * grow,
            c.z + (L.z - roll) * c.r * grow,
          );
          m.scale.setScalar(L.s * c.r * grow);
          m.rotation.y = now * 0.00018 + L.ph;
          m.visible = c.mat.opacity > 0.004;
        }
      }

      // Bullet wakes through smoke. Swell and fade together: the streak is what the round
      // left behind, so it spreads as it goes rather than simply dimming in place. Eased
      // so most of the spread happens early, which is when a disturbance in smoke actually
      // moves — a linear swell reads as something being inflated.
      for (const w of wakes) {
        if (!w.until) continue;
        if (now >= w.until) {
          w.mesh.visible = false;
          w.mat.opacity = 0;
          w.until = 0;
          continue;
        }
        const k = (now - w.born) / WAKE_MS;
        const r = WAKE_R0 + (WAKE_R1 - WAKE_R0) * (1 - (1 - k) ** 2.2);
        w.mesh.scale.set(r, r, w.len);
        // Squared, so it is bright for the first moment and then gets out of the way. The
        // cloud has to go back to being a cloud, or a firefight through one ends with the
        // smoke lit up like a lampshade.
        w.mat.opacity = 0.85 * (1 - k) ** 2;
      }

      for (const b of bursts) {
        if (!b.until) continue;
        const k = b.k;

        if (now >= b.until) {
          for (const part of [b.flash, b.ball, b.ring, b.mark]) {
            part.visible = false;
            part.material.opacity = 0;
          }
          for (const s of b.smoke) s.mesh.visible = false;
          for (const s of b.shards) s.mesh.visible = false;
          b.smokeMat.opacity = 0;
          b.shardMat.opacity = 0;
          b.light.visible = false;
          b.light.intensity = 0;
          b.until = 0;
          continue;
        }

        const age = now - b.born;
        if (k.flash) swell(b.flash, k.flash, age);
        if (k.ball) {
          swell(b.ball, k.ball, age);
          // A fireball cools as it expands. Without this the orange stays the same
          // orange all the way out and the whole thing reads as a light being switched
          // off rather than as something burning.
          if (k.ball.cool) {
            b.ball.material.color
              .setHex(k.ball.hex)
              .lerp(cScratch.setHex(k.ball.cool), Math.min(1, age / k.ball.ms));
          }
        }
        if (k.ring) swell(b.ring, k.ring, age);
        if (k.mark) {
          // The mark does not grow — it is a stain, and it only fades.
          const t = age / k.mark.ms;
          b.mark.visible = t < 1;
          b.mark.material.opacity = t < 1 ? k.mark.opacity * (1 - t) ** 1.5 : 0;
        }

        const st = age / k.smoke.ms;
        if (st < 1) {
          const drag = Math.exp(-k.smoke.drag * dt);
          const grow = k.smoke.from + (1 - k.smoke.from) * (1 - (1 - st) ** 2);
          for (let i = 0; i < k.smoke.count; i++) {
            const s = b.smoke[i];
            s.vx *= drag;
            s.vy *= drag;
            s.vz *= drag;
            s.mesh.position.x += s.vx * dt;
            s.mesh.position.y += s.vy * dt;
            s.mesh.position.z += s.vz * dt;
            // Slightly different size per puff, or seven identical spheres read as one
            // faceted blob.
            s.mesh.scale.setScalar(k.smoke.peak * grow * (0.7 + 0.15 * (i % 3)));
          }
          b.smokeMat.opacity = k.smoke.opacity * (1 - st) ** 1.7;
        } else if (b.smokeMat.opacity) {
          for (const s of b.smoke) s.mesh.visible = false;
          b.smokeMat.opacity = 0;
        }

        const ht = age / k.shard.ms;
        if (ht < 1) {
          for (let i = 0; i < k.shard.count; i++) {
            const s = b.shards[i];
            s.vy -= k.shard.gravity * dt;
            s.mesh.position.x += s.vx * dt;
            s.mesh.position.y += s.vy * dt;
            s.mesh.position.z += s.vz * dt;
            s.mesh.rotation.x += s.spin * dt;
            s.mesh.rotation.z += s.spin * 0.7 * dt;
          }
          b.shardMat.opacity = (1 - ht) ** 1.4;
        } else if (b.shardMat.opacity) {
          for (const s of b.shards) s.mesh.visible = false;
          b.shardMat.opacity = 0;
        }

        if (k.light) {
          const lt = age / k.light.ms;
          if (lt >= 1) {
            b.light.visible = false;
            b.light.intensity = 0;
          } else {
            b.light.intensity = k.light.intensity * (1 - lt) ** 2;
          }
        }
      }

      for (const im of impacts) {
        if (!im.until) continue;
        if (now >= im.until) {
          for (const c of im.chips) c.mesh.visible = false;
          im.puff.visible = false;
          im.mat.opacity = 0;
          im.puffMat.opacity = 0;
          im.until = 0;
          continue;
        }
        const age = (now - im.born) / IMPACT_MS;
        // Chips are integrated rather than tweened, because gravity is what makes
        // debris read as debris: it leaves fast, slows, and drops.
        for (const c of im.chips) {
          c.vy -= CHIP_G * dt;
          c.mesh.position.x += c.vx * dt;
          c.mesh.position.y += c.vy * dt;
          c.mesh.position.z += c.vz * dt;
          c.mesh.rotation.x += c.vx * dt * 7;
          c.mesh.rotation.y += c.vz * dt * 7;
        }
        im.mat.opacity = (1 - age) ** 1.5;
        im.puff.scale.setScalar(im.k.puff0 * (0.6 + age * 1.9));
        im.puffMat.opacity = 0.75 * (1 - age) ** 2;
      }

      // Decals, on their own much longer clocks. Held at full for the first half of
      // their life and faded over the second: a mark that starts fading the instant it
      // lands reads as a rendering glitch, while one that sits and then goes reads as a
      // scar the round actually left.
      for (const d of decals) {
        if (!d.until) continue;
        if (now >= d.until) {
          d.mesh.visible = false;
          d.mat.opacity = 0;
          d.until = 0;
          continue;
        }
        const a = (now - d.born) / (d.until - d.born);
        d.mat.opacity = a < 0.5 ? 1 : 2 * (1 - a);
      }
    },

    render() {
      renderer.render(scene, camera);
      // Second pass for the weapon. `autoClear` off keeps the world we just drew;
      // clearing only depth means the weapon is composited on top of it and can never
      // be occluded by geometry — so walking into a wall no longer swallows the gun.
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(vmScene, vmCamera);
      renderer.autoClear = true;
    },
  };
}
