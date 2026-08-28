// THE authoritative movement function.
//
// The server runs stepPlayer() to advance truth. The client runs the *same*
// function on the *same* input to predict locally. If these two ever diverge,
// prediction breaks and players rubber-band — so no movement rule may be
// duplicated anywhere else in the codebase. Change physics here or nowhere.
//
// Both sides step at a fixed TICK_DT and produce exactly one input per tick, so
// delta-time is never transmitted and a client cannot advance itself by lying
// about how much time passed.

import * as C from './constants.js';
import { depenetrate, moveAxis, overlapsBox } from './collide.js';
import { WEAPON_IDS } from './weapons.js';

const EPS_GAIN = 1e-4;

/** Half-height at a given crouch amount (0 = standing, 1 = fully ducked).
 *  Exported for the renderer, which has a crouch amount off the wire rather than a
 *  whole player state and would otherwise allocate a triple per avatar per frame. */
export const halfHAt = (crouch) =>
  C.PLAYER_HALF_H + (C.CROUCH_HALF_H - C.PLAYER_HALF_H) * crouch;

/**
 * The body's collision half-extents right now. Everything that needs a player's
 * size calls this — movement, the hitscan hitbox, the projectile blast box, the
 * drawn avatar — so a crouching player's silhouette, hitbox and collider are the
 * same object and cannot disagree about whether their head is behind cover.
 */
export const halfOf = (s) => [C.PLAYER_HALF_W, halfHAt(s.crouch ?? 0), C.PLAYER_HALF_W];

/**
 * The head box: centre y, and half-extents on the two axes that differ from the body.
 *
 * Anchored to the TOP of the body box at an ABSOLUTE height, and that is the property
 * that matters rather than a detail — the eye has to stay inside it at every crouch
 * amount. Standing, the head spans y+0.55..y+0.90 and eyeY is y+0.62; fully crouched it
 * spans y+0.20..y+0.55 and eyeY is y+0.30. Scaled with the box the way LEG_FRAC is, a
 * ducked player's head would stop at y+0.34 with their eye at y+0.30 — the camera BELOW
 * the head box — and "aim where their eyes are" would stop meaning headshot on exactly
 * the target you most want it to mean it on.
 *
 * Strictly INSIDE the body box by construction, which is what lets zone classification
 * be free: it can only change what a hit was worth, never whether it connected. Nothing
 * here can make a player harder to hit than they were before zones existed, and
 * verify.mjs asserts that rather than trusting this paragraph.
 */
export const headBoxOf = (s) => ({
  cy: s.y + halfHAt(s.crouch ?? 0) - C.HEAD_HALF_H,
  hx: C.HEAD_HALF_W,
  hy: C.HEAD_HALF_H,
});

/** World y of the top of the legs: at or below this, and above the feet, is a leg hit.
 *  LEG_FRAC of whatever body is left once the head is taken off the top. */
export const legsTopOf = (s) => {
  const h = halfHAt(s.crouch ?? 0);
  return s.y - h + (h - C.HEAD_HALF_H) * 2 * C.LEG_FRAC;
};

/** World y of centre mass — CHEST_FRAC up the torso, the band between the top of the
 *  legs and the bottom of the head. What a bot aims at; see CHEST_FRAC for why not the
 *  eye. Standing that is y+0.22, fully crouched y+0.03. */
export const chestY = (s) => {
  const lo = legsTopOf(s);
  const hi = s.y + halfHAt(s.crouch ?? 0) - C.HEAD_HALF_H * 2;
  return lo + (hi - lo) * C.CHEST_FRAC;
};

export function createPlayerState(spawn) {
  return {
    x: spawn.x,
    y: spawn.y,
    z: spawn.z,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: spawn.yaw,
    pitch: 0,
    grounded: false,
    /** 0..1 blend, not a boolean: the body resizes over ~0.14s and the camera has
     *  to travel with it, so the in-between values are real states, not animation. */
    crouch: 0,
    /** Was the jump button down last tick? Jumping is edge-triggered, so this has to
     *  be part of the simulation state rather than a client-side latch — the server
     *  replays inputs and the client re-predicts from server state, and if only one
     *  of them remembered the button they would disagree about whether a held space
     *  counts as a new jump. */
    jumpHeld: false,
    /** Sprint fuel, in whole units out of C.SPRINT_STAMINA_MAX. Integer for a reason
     *  the constants spell out, and part of the simulation state for the same reason
     *  jumpHeld is: the server replays inputs and the client re-predicts, and a bar
     *  that only one of them remembered would put the two on different speed caps. */
    stamina: C.SPRINT_STAMINA_MAX,
    /** Ticks left before stamina starts coming back. A countdown rather than a
     *  deadline like nextFireAt, because stepPlayer has no clock - only dt. */
    restTicks: 0,
    /** Was this tick a sprinting tick? An OUTPUT of the step, not an input to it:
     *  sprintOk() derives it fresh from the buttons and the bar every tick, so it is
     *  deliberately absent from KINEMATIC - there is nothing to carry across a
     *  reconcile that the next stepPlayer will not immediately recompute.
     *
     *  It lives here anyway because the viewmodel needs it, and the only honest place
     *  to ask "am I sprinting" is the function that decided. The client used to have
     *  to guess from speed alone, which cannot tell a sprint from a run down a slope
     *  and cannot see the two frames where the bar runs flat but the key is still
     *  held. Both sides now read the same bit off the same line. */
    sprinting: false,
    /** Set when the bar hits empty, cleared at SPRINT_MIN_START. Without it a player
     *  who runs flat re-engages sprint for one tick at a time, forever. */
    sprintLock: false,
  };
}

const KINEMATIC = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'yaw', 'pitch', 'grounded', 'crouch',
  'jumpHeld', 'stamina', 'restTicks', 'sprintLock'];

export function copyState(from, to) {
  for (const k of KINEMATIC) to[k] = from[k];
  return to;
}

export const EMPTY_INPUT = { moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0, wep: 0 };

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Never trust the wire. Runs on the server for every inbound input.
 *
 *  This whitelist is the complete set of things a client may assert. `wep` rides
 *  along in every input rather than arriving as its own message, so it inherits
 *  the redundancy and ack machinery for free: a swap is idempotent, ordered, and
 *  cannot be lost. Clamping it to a real index here means an out-of-range weapon
 *  never travels further — whether the index is *legal in this mode* is a separate
 *  question, and the room answers it against the loadout whitelist. */
export function sanitizeInput(raw, fallbackYaw = 0, fallbackWep = 0) {
  const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    seq: Math.max(0, num(raw?.seq) | 0),
    /**
     * What the client believes the SERVER clock read when it made this input — the view
     * time lag compensation rewinds targets to. See MAX_REWIND_MS for the ceiling.
     *
     * Built on client/src/net.js from a value the server itself issued (`st`, stamped on
     * every snapshot) plus how long the client has held it, so the only direction a
     * client can usefully lie in is backwards, and resolveShot clamps that.
     *
     * 0 means "no estimate" and disables the rewind for this shot entirely, which is the
     * correct answer rather than a fallback: a bot's inputs are queued in-process and
     * never crossed a network, so there is nothing to compensate for. Math.floor rather
     * than `| 0` because this is a clock reading and a value past 2^31 must degrade to
     * "no estimate" instead of wrapping to a negative one.
     */
    vt: Math.max(0, Math.floor(num(raw?.vt))),
    moveX: clamp(num(raw?.moveX), -1, 1),
    moveZ: clamp(num(raw?.moveZ), -1, 1),
    yaw: num(raw?.yaw, fallbackYaw),
    pitch: clamp(num(raw?.pitch), -C.PITCH_LIMIT, C.PITCH_LIMIT),
    buttons: num(raw?.buttons) | 0,
    wep: clamp(num(raw?.wep, fallbackWep) | 0, 0, WEAPON_IDS.length - 1),
  };
}

/**
 * Blend the crouch amount toward the button, resizing the body as it goes.
 *
 * Two rules do all the work here:
 *
 * The box is anchored at the FEET while grounded and at the HEAD while airborne.
 * Grounded, that means ducking lowers your head — the point of crouching — and
 * standing raises it. Airborne, it means ducking tucks your feet up to your head,
 * which is the whole of crouch-jumping; anchoring at the feet instead would grow
 * the body downward into the floor and standing up would be permanently refused.
 *
 * Growing into solid geometry is REFUSED, not resolved. Depenetrating a body that
 * grew into a ceiling picks an axis and shoves, and the axis it picks under a thin
 * ledge is up — which is how you end up standing on the ledge you were hiding
 * under. Stay crouched until there is actually room, exactly like every shooter.
 */
function crouchStep(s, input, dt, boxes) {
  const want = input.buttons & C.BTN_CROUCH ? 1 : 0;
  const cur = s.crouch;
  if (want === cur) return;

  const rate = C.CROUCH_RATE * dt;
  const next = want > cur ? Math.min(want, cur + rate) : Math.max(want, cur - rate);
  const h0 = halfHAt(cur);
  const h1 = halfHAt(next);
  const y1 = s.y + (s.grounded ? h1 - h0 : h0 - h1);

  if (h1 > h0) {
    for (const b of boxes) {
      if (overlapsBox(s.x, y1, s.z, C.PLAYER_HALF_W, h1, C.PLAYER_HALF_W, b)) return;
    }
  }
  s.y = y1;
  s.crouch = next;
}

/**
 * Is this tick a sprinting tick? Resolved ONCE per tick and handed to both the cost
 * and the cap, so the two can never disagree about what the player was doing.
 *
 * Every term here is bit-exact on both sides - bits straight off the wire, `grounded`
 * as 0|1, and `wl` from moveX/moveZ, which sanitizeInput clamps identically. The crouch
 * blend is the one exception, so it gets a TOLERANCE rather than `> 0`: crouch travels
 * the wire quantised through r3(), and a branch that swings the cap 15% must not sit on
 * the value the rounding lands near. The blend moves on a lattice of
 * CROUCH_RATE * TICK_DT = 0.1167 and is clamped to exactly 0 at the bottom, so it is
 * either 0 or at least 0.0667 - two orders clear of 1e-3 either way, and nothing can
 * straddle it.
 *
 * For the same reason "actually moving" is `wl`, the INTENT, and never a velocity
 * threshold: velocity arrives quantised too.
 */
function sprintOk(s, input, wl) {
  if (!(input.buttons & C.BTN_SPRINT)) return false;
  if (!s.grounded) return false;
  if (wl <= 1e-6) return false;
  if (input.buttons & C.BTN_WALK) return false;
  if ((s.crouch ?? 0) > 1e-3) return false;
  return !s.sprintLock && s.stamina > 0;
}

/**
 * Top speed multiplier. Crouch and walk take the MORE restrictive of the two rather
 * than multiplying: compounding them lands at 0.19x, which reads as being stuck
 * rather than as being deliberately slow.
 *
 * Sprint is the other direction and it never has to argue with them: sprintOk already
 * refused if either was asked for, so by the time this returns SPRINT_SPEED_MUL there
 * is nothing left to take a minimum against.
 */
function speedMul(s, input, sprinting) {
  if (sprinting) return C.SPRINT_SPEED_MUL;
  const walk = input.buttons & C.BTN_WALK ? C.WALK_SPEED_MUL : 1;
  const duck = 1 + (C.CROUCH_SPEED_MUL - 1) * (s.crouch ?? 0);
  return Math.min(walk, duck);
}

export function stepPlayer(s, input, dt, boxes) {
  s.yaw = input.yaw;
  s.pitch = input.pitch;

  // Resize before anything else reads the body, so one tick uses one size.
  crouchStep(s, input, dt, boxes);
  const half = halfOf(s);

  // Never simulate from inside the level. The client replays from a position that
  // came over the wire quantised, so it can start a tick hairline-deep in a wall;
  // resolving that during the move would eject it to a box face metres away. Both
  // sides call this, so the correction is part of the shared simulation and
  // prediction stays in agreement.
  depenetrate(s, half, boxes);

  // Wish direction. forward = (-sin yaw, 0, -cos yaw), right = (cos yaw, 0, -sin yaw).
  const sy = Math.sin(s.yaw);
  const cy = Math.cos(s.yaw);
  let wx = -sy * input.moveZ + cy * input.moveX;
  let wz = -cy * input.moveZ - sy * input.moveX;
  const wl = Math.hypot(wx, wz);
  if (wl > 1e-6) {
    // Normalise so holding two keys isn't faster than one.
    wx /= wl;
    wz /= wl;
  }

  // Stamina, every tick. The drain only happens inside a sprint but the REGEN only
  // happens outside one, so this cannot live in the acceleration block below. Integer
  // arithmetic throughout, which is what puts both sides on the same side of every
  // threshold on the same tick.
  //
  // Sprint charges only where it applies. sprintOk already requires `grounded`, and the
  // projection cap below cannot accelerate OR slow an airborne player, so a tick in the
  // air buys nothing and is billed nothing. The residual that leaves is small and was
  // measured, not assumed: a perfect bunny-hopper already sustains 4.08 u/s today with
  // no sprint and no stamina - faster than a ground sprint's 3.98 - because airstrafing
  // is deliberate here. Holding sprint through that chain reaches 4.15, a 1.6% edge over
  // the hop alone, for 51 units per 12s. Billing the air would cap that at 4s, at the
  // price of charging every ordinary sprint-jump for speed it never received. The 1.6%
  // is bunny-hop tech, not a hole in the bar, so it is left alone on purpose.
  const sprinting = sprintOk(s, input, wl);
  s.sprinting = sprinting;
  if (sprinting) {
    s.stamina = Math.max(0, s.stamina - C.SPRINT_DRAIN);
    s.restTicks = C.SPRINT_REST_TICKS;
    if (s.stamina === 0) s.sprintLock = true;
  } else if (s.restTicks > 0) {
    s.restTicks--;
  } else {
    s.stamina = Math.min(C.SPRINT_STAMINA_MAX, s.stamina + C.SPRINT_REGEN);
  }
  // Released on the way back UP, never on the way down - which is the whole point of
  // the latch. Running the bar flat costs you the sprint until a quarter of it returns.
  if (s.sprintLock && s.stamina >= C.SPRINT_MIN_START) s.sprintLock = false;

  if (s.grounded) {
    const speed = Math.hypot(s.vx, s.vz);
    if (speed > 0) {
      const scale = Math.max(0, speed - speed * C.FRICTION * dt) / speed;
      s.vx *= scale;
      s.vz *= scale;
    }
  }

  // Accelerate along the wish dir, capped at top speed *projected onto that dir*.
  // Capping the projection rather than total speed is what lets airstrafing work.
  //
  // Crouch and walk lower the cap, they do not scale velocity. So they slow you
  // down through friction over about a third of a second instead of stopping you
  // dead, and — because the cap is what airstrafing exploits — a crouched player in
  // mid-air keeps whatever speed they jumped with. Both are the CS2 feel.
  if (wl > 1e-6) {
    const top = C.MOVE_SPEED * speedMul(s, input, sprinting);
    const accel = s.grounded ? C.GROUND_ACCEL : C.AIR_ACCEL;
    const add = top - (s.vx * wx + s.vz * wz);
    if (add > 0) {
      const a = Math.min(accel * top * dt, add);
      s.vx += a * wx;
      s.vz += a * wz;
    }
  }

  // Jump on the PRESS, not on the hold. Level-triggering it meant a held space
  // re-jumped the instant you landed, forever — you could cross the level bouncing
  // without ever touching the key again, which is what "hold space and it just jumps
  // nonstop" was. CS2 works this way too: one press, one jump, release to jump again.
  const jumpDown = (input.buttons & C.BTN_JUMP) !== 0;
  if (s.grounded && jumpDown && !s.jumpHeld) s.vy = C.JUMP_VEL;
  s.jumpHeld = jumpDown;

  s.vy -= C.GRAVITY * dt;
  if (s.vy < -C.MAX_FALL_SPEED) s.vy = -C.MAX_FALL_SPEED;

  // Vertical first, so `grounded` is fresh when the step-up test needs it.
  if (moveAxis(s, half, 'y', s.vy * dt, boxes)) {
    s.grounded = s.vy < 0;
    s.vy = 0;
  } else {
    s.grounded = false;
  }

  moveHorizontal(s, half, dt, boxes);
  return s;
}

function moveHorizontal(s, half, dt, boxes) {
  const dx = s.vx * dt;
  const dz = s.vz * dt;
  const ox = s.x;
  const oy = s.y;
  const oz = s.z;

  const hitX = moveAxis(s, half, 'x', dx, boxes);
  const hitZ = moveAxis(s, half, 'z', dz, boxes);

  const stop = (bx, bz, by) => {
    s.x = bx;
    s.z = bz;
    s.y = by;
    if (hitX) s.vx = 0;
    if (hitZ) s.vz = 0;
  };

  // Unobstructed, or airborne (no step-up while jumping — that would let you
  // climb walls by hugging them).
  if (!(hitX || hitZ) || !s.grounded) {
    if (hitX) s.vx = 0;
    if (hitZ) s.vz = 0;
    return;
  }

  // Blocked on the ground: retry the same move one step higher.
  const slidX = s.x;
  const slidZ = s.z;
  s.x = ox;
  s.y = oy;
  s.z = oz;

  if (moveAxis(s, half, 'y', C.STEP_HEIGHT, boxes)) {
    stop(slidX, slidZ, oy); // no headroom to step into
    return;
  }

  const hitX2 = moveAxis(s, half, 'x', dx, boxes);
  const hitZ2 = moveAxis(s, half, 'z', dz, boxes);
  const landed = moveAxis(s, half, 'y', -C.STEP_HEIGHT, boxes);

  // Only keep the raised attempt if it actually got further than sliding did.
  if (Math.hypot(s.x - ox, s.z - oz) <= Math.hypot(slidX - ox, slidZ - oz) + EPS_GAIN) {
    stop(slidX, slidZ, oy);
    return;
  }
  if (landed) s.grounded = true;
  if (hitX2) s.vx = 0;
  if (hitZ2) s.vz = 0;
}

// ---------------------------------------------------------------- view helpers
/** Eye height, crouch included. `?? 0` so a partial state off the wire — an older
 *  snapshot, a spectator target that appeared this frame — reads as standing rather
 *  than as NaN, which would put the camera nowhere. */
export const eyeY = (s) =>
  s.y + C.EYE_OFFSET + (C.CROUCH_EYE_OFFSET - C.EYE_OFFSET) * (s.crouch ?? 0);

export function aimDir(yaw, pitch) {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}
