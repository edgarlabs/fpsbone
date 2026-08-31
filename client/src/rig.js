// The third-person figure: its proportions, how each weapon is held, and the arm solve
// that puts the hands on it.
//
// This file contains no three.js. That is deliberate and it is the point of the file
// existing: everything here is a number or a closed-form solve, so `npm run verify` can
// import it in a plain Node process and check the geometry — that the hands actually land
// on the grips, that the figure fits its own hitbox, that a body on the floor is lying ON
// the floor. render.js turns the results into Groups and Meshes and does nothing else.
//
// It exists because the previous arms were three hand-tuned Euler angles with a gun box
// parented next to them, and nothing anywhere checked that the two met. They did not:
// `armPitch: -1.55` put both hands about 0.28u BEHIND the body while the gun sat 0.48u in
// front of it, which is exactly what was reported — "the bots look weird they dont look
// like carying the gone but just them hands floating". You cannot tune your way out of
// that class of bug by eye, because the wrong pose and the right pose look equally
// plausible on a stationary figure seen from the front. So the hands are solved to the
// weapon's own grip points instead of posed, and the solve is asserted.

import { halfHAt } from '../../shared/movement.js';
import * as C from '../../shared/constants.js';
import { WEAPON_IDS, familyOf, heftOf, isUtil, scopes } from '../../shared/weapons.js';

/**
 * Body proportions, in world units, relative to the body centre.
 *
 * The figure is 1.8u tall and 0.8u wide because that is the collider: PLAYER_HALF_H is
 * 0.9 and PLAYER_HALF_W is 0.4, and every number below is chosen to fill that box without
 * leaving it. A drawn body that disagrees with its hitbox is the worst kind of lie in a
 * shooter — either you hit air that reads as a miss, or you miss something you visibly
 * hit. `rigExtent()` below recomputes the reach so the fit can be asserted rather than
 * eyeballed, and verify.mjs asserts it.
 */
export const RIG = {
  // Legs, laid out from the sole upward so the feet land exactly on the floor.
  footH: 0.08,
  footW: 0.17,
  footD: 0.26,
  footZ: 0.05, // toes forward: facing stays readable even from straight above
  shinH: 0.36,
  shinW: 0.15,
  shinD: 0.18,
  thighH: 0.38,
  thighW: 0.18,
  thighD: 0.21,
  hipX: 0.12,
  hipY: -0.08, // sole -0.90 + foot 0.08 + shin 0.36 + thigh 0.38

  pelvisW: 0.4,
  pelvisH: 0.16,
  pelvisD: 0.26,
  pelvisY: 0,

  torsoW: 0.46,
  torsoH: 0.52,
  torsoD: 0.28,
  torsoY: 0.34, // spans 0.08 .. 0.60

  neckW: 0.14,
  neckH: 0.06,
  neckY: 0.63,

  headW: 0.3,
  headH: 0.25,
  headD: 0.28,
  headY: 0.775, // crown at 0.90 = PLAYER_HALF_H exactly
  visorW: 0.24,
  visorH: 0.08,
  // The face sits a little above EYE_OFFSET (0.62) because the collider's top is at
  // 0.90 and the head has to reach it — 0.62 lands in the neck. That is a property of
  // the movement constants, not of this rig: the eye height was tuned for what a player
  // can see over, and the hitbox has always run to 0.90 whatever was drawn there.
  visorY: 0.71,

  // The shoulders are deliberately BROAD — 0.63u across, 35% of body height, where a
  // real person is 25%. That is not a mistake and it is the one proportion here that is
  // not anatomical. The hitbox is 2*PLAYER_HALF_W = 0.8u wide and hit detection uses
  // all of it, so a realistically narrow figure would leave a third of its own hitbox
  // as empty air that still registers hits — "I shot right next to him and it counted",
  // which is a worse lie than broad shoulders. The capsule this replaced filled the
  // full 0.8; this fills 0.63 of it and never exceeds it.
  //
  // It has one cost, and it is why the weapon holds below look compact: a 0.5u shoulder
  // separation with 0.58u arms cannot put the support hand a realistic 0.4u out along a
  // rifle, because the reach is spent crossing the body. The holds are laid out for the
  // figure that exists rather than for a photograph of a soldier.
  shoulderX: 0.25,
  shoulderY: 0.52,
  upperW: 0.13,
  upperH: 0.3, // upper arm length: the shoulder-to-elbow segment the solve uses
  upperD: 0.15,
  foreW: 0.12,
  foreH: 0.28, // forearm length, elbow to hand
  foreD: 0.14,
};

/** Arm segment lengths, named for the solve rather than for the boxes drawn on them. */
export const ARM_UPPER = RIG.upperH;
export const ARM_FORE = RIG.foreH;
/** Longest straight-line distance a hand can be from its own shoulder. Every grip in
 *  HOLDS has to be inside this from the shoulder that reaches for it, which is the single
 *  invariant that stops a hand floating off a weapon again. */
export const ARM_REACH = ARM_UPPER + ARM_FORE;

/**
 * How far the figure reaches, so the fit inside the collider can be asserted rather
 * than eyeballed. Returns half-extents from the body centre.
 *
 * Deliberately recomputed from RIG by hand rather than read off a three.js bounding
 * box: a bounding box would need the scene graph built, and the point is to be able to
 * check this in a plain Node process.
 *
 * `backZ` is the one that is easy to get wrong, and was: it is how far the figure sticks
 * out behind itself, which is nothing at all while it is standing up and is the entire
 * question the moment it falls on its back. See `corpseDrop`.
 */
export function rigExtent() {
  const armOuter = RIG.shoulderX + RIG.upperW / 2;
  return {
    halfW: Math.max(armOuter, RIG.pelvisW / 2, RIG.torsoW / 2, RIG.hipX + RIG.thighW / 2),
    soleY: RIG.hipY - RIG.thighH - RIG.shinH - RIG.footH,
    crownY: RIG.headY + RIG.headH / 2,
    // The feet win this, not the torso: the toes are offset 0.05 forward, so the heels
    // reach 0.18 back while the torso only reaches 0.14.
    backZ: Math.max(
      RIG.footZ + RIG.footD / 2,
      RIG.torsoD / 2,
      RIG.pelvisD / 2,
      RIG.headD / 2,
    ),
    frontZ: Math.max(RIG.footD / 2 - RIG.footZ, RIG.torsoD / 2, RIG.headD / 2),
  };
}

/**
 * How far to lower a toppled body so it rests ON the ground instead of floating over it.
 *
 * The death animation rotates the body a quarter turn about X, which maps every point's
 * local +z to -y: a figure on its back is resting on whatever stuck out behind it, which
 * is `backZ` (0.18, the heels) and nothing else. The body centre starts halfHAt(cr) above
 * the floor, so that much has to come off and 0.18 of it goes back on.
 *
 * This used to be `halfHAt(cr) - PLAYER_HALF_W`, which is 0.4 — the radius of a capsule
 * that has not been drawn since the box figure replaced it. A capsule lying down rests on
 * its radius; a box humanoid rests on its heels, and 0.4 vs 0.18 is 22cm of daylight under
 * every corpse in the game. "even when death they float."
 *
 * @param cr crouch amount the body is toppling from, 0..1. The topple eases it out, so
 *   this is called with a falling value and has to stay correct at every step of it.
 */
export const corpseDrop = (cr) => halfHAt(cr) - rigExtent().backZ;

/**
 * Solve a two-segment arm so the hand lands on a point.
 *
 * Closed form, no iteration: an arm is a shoulder that can point anywhere and an elbow
 * that is a hinge, and where the hand ends up is then decided by one number — how far
 * round the shoulder-to-hand axis the elbow is swung. That last freedom is what makes the
 * difference between a hold that reads as carrying a weapon and one that reads as a
 * mannequin, so it is an input (`hint`) rather than something the solve picks: the elbow
 * ends up as close to the hint direction as the geometry allows.
 *
 * Without the hint this was visibly wrong in a specific way. A two-angle solve puts the
 * elbow in the plane containing the arm, so a hand reaching INBOARD (which both hands do
 * on a weapon held to one side) drags the elbow inboard with it and through the torso.
 * The hint pushes it down and out where a person's elbow is.
 *
 * @param l1,l2 upper arm and forearm lengths.
 * @param tx,ty,tz hand target, RELATIVE TO THE SHOULDER JOINT, in the shoulder's parent
 *   space (which is the `shoulders` group, so the aim pitch is already applied to both the
 *   target and the arm and cannot pull them apart).
 * @param hx,hy,hz which way the elbow should point. Magnitude is ignored.
 * @returns `{x, y, z}` Euler angles in XYZ order for the shoulder joint, `elbow` for the
 *   hinge's rotation.x, the solved elbow position `ex,ey,ez` (for tests and for keeping it
 *   out of the torso), and `over` — how far beyond reach the target was, 0 when the hand
 *   made it. A target out of reach is solved as far as the arm goes rather than failing,
 *   because a stretched arm is recoverable and a NaN in a scene graph is not.
 */
export function solveArm(l1, l2, tx, ty, tz, hx, hy, hz) {
  const reach = l1 + l2;
  const fold = Math.abs(l1 - l2);
  const d0 = Math.hypot(tx, ty, tz);
  const over = Math.max(0, d0 - reach);
  // Clamp the distance, then pull the target in along its own direction to match. Solving
  // the clamped target exactly is what keeps the hand on the weapon's axis when it cannot
  // quite get there, instead of drifting off it.
  const d = Math.min(reach - 1e-4, Math.max(fold + 1e-4, d0));
  const s = d0 > 1e-6 ? d / d0 : 0;
  const px = tx * s;
  const py = ty * s;
  const pz = tz * s;

  // Elbow angle straight off the law of cosines. 0 is a straight arm, PI a folded one.
  const cosB = (d * d - l1 * l1 - l2 * l2) / (2 * l1 * l2);
  const beta = Math.acos(Math.max(-1, Math.min(1, cosB)));

  // Where the elbow can be: a circle of radius `r`, `a` along the shoulder-to-hand axis.
  const a = (d * d + l1 * l1 - l2 * l2) / (2 * d);
  const r = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const ux = px / d;
  const uy = py / d;
  const uz = pz / d;
  // The hint, with the part of it that points along the axis removed — only the component
  // across the axis can move the elbow.
  const hdot = hx * ux + hy * uy + hz * uz;
  let nx = hx - hdot * ux;
  let ny = hy - hdot * uy;
  let nz = hz - hdot * uz;
  let nl = Math.hypot(nx, ny, nz);
  if (nl < 1e-6) {
    // Hint parallel to the arm: no preference survives, so take any perpendicular. Picked
    // off whichever world axis the arm is least aligned with, so this cannot degenerate.
    const ax = Math.abs(ux) < 0.9 ? 1 : 0;
    nx = uy * 0 - uz * ax;
    ny = uz * (ax ? 0 : 1) - ux * 0;
    nz = ux * ax - uy * (ax ? 0 : 1);
    nl = Math.hypot(nx, ny, nz) || 1;
  }
  nx /= nl;
  ny /= nl;
  nz /= nl;
  const ex = a * ux + r * nx;
  const ey = a * uy + r * ny;
  const ez = a * uz + r * nz;

  // Build the shoulder's frame from the result. The upper arm is drawn down the joint's
  // local -Y, and the elbow hinge swings the hand toward local -Z, so: local -Y points at
  // the elbow, and local +X is the hinge axis, perpendicular to both bones.
  const dyx = ex / l1;
  const dyy = ey / l1;
  const dyz = ez / l1;
  let vx = px - ex;
  let vy = py - ey;
  let vz = pz - ez;
  const vl = Math.hypot(vx, vy, vz) || 1;
  vx /= vl;
  vy /= vl;
  vz /= vl;
  let axx = dyy * vz - dyz * vy;
  let axy = dyz * vx - dyx * vz;
  let axz = dyx * vy - dyy * vx;
  let al = Math.hypot(axx, axy, axz);
  if (al < 1e-6) {
    // Straight arm: the bones are colinear and there is no hinge plane. Any axis
    // perpendicular to the arm will do, and the hinge angle is 0 anyway.
    axx = 1 - Math.abs(dyx);
    axy = 0;
    axz = Math.abs(dyx);
    al = Math.hypot(axx, axy, axz) || 1;
  }
  axx /= al;
  axy /= al;
  axz /= al;
  // Columns of the rotation: X the hinge axis, Y up the upper arm, Z = X × Y.
  const yx = -dyx;
  const yy = -dyy;
  const yz = -dyz;
  const zx = axy * yz - axz * yy;
  const zy = axz * yx - axx * yz;
  const zz = axx * yy - axy * yx;

  // Euler XYZ out of the frame, matching three.js's own extraction for that order.
  const m13 = zx;
  let rx;
  let rz;
  const ry = Math.asin(Math.max(-1, Math.min(1, m13)));
  if (Math.abs(m13) < 0.9999999) {
    rx = Math.atan2(-zy, zz);
    rz = Math.atan2(-yx, axx);
  } else {
    rx = Math.atan2(axz, yy);
    rz = 0;
  }
  return { x: rx, y: ry, z: rz, elbow: beta, ex, ey, ez, over };
}

/**
 * Rotate a vector by an Euler triple in three.js's 'XYZ' order, i.e. R = Rx * Ry * Rz.
 *
 * Exists so callers can compute where a rotated child ENDS UP without a scene graph. The
 * renderer needs exactly that: the off hand has to stay on the forend while the weapon
 * sags, kicks and lags behind a turn, and the only way to keep it there is to apply the
 * weapon's own rotation to the offset between the two grips. Doing that with the same
 * matrix three.js will use is the difference between a hand ON the barrel and a hand near
 * it — which is the bug this whole file exists to end.
 */
export function rotateXYZ(rx, ry, rz, x, y, z) {
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);
  return {
    x: cy * cz * x + -cy * sz * y + sy * z,
    y: (cx * sz + sx * sy * cz) * x + (cx * cz - sx * sy * sz) * y + -sx * cy * z,
    z: (sx * sz - cx * sy * cz) * x + (sx * cz + cx * sy * sz) * y + cx * cy * z,
  };
}

/**
 * Forward kinematics for the same arm: where does the hand end up?
 *
 * The inverse of `solveArm`, and the reason it exists is that it is the only honest way to
 * check one. verify.mjs solves every grip of every weapon and runs the answer back through
 * this, so "the hands are on the gun" is a measured distance rather than a screenshot.
 */
export function armFK(l1, l2, rx, ry, rz, beta) {
  // Hand in the shoulder's local space before the shoulder rotates: down the upper arm,
  // then the hinge swings the forearm forward (-z).
  const h = l1 + l2 * Math.cos(beta);
  return rotateXYZ(rx, ry, rz, 0, -h, -l2 * Math.sin(beta));
}

/**
 * Where a free hand goes, in `shoulders` space — down beside the hip, a little forward.
 *
 * Used by the knife and the throwables, which are held in one hand. The alternative is an
 * off hand left wherever the last weapon put it, which is how a character ends up
 * cupping thin air next to a knife.
 */
export const IDLE_HAND = [-0.29, -0.55, 0.02];
/** Same, but for a hand that is doing nothing while the OTHER one holds something ready
 *  to throw — brought forward and in, the way a person balances a throw. */
export const READY_HAND = [-0.25, -0.46, -0.16];

/** Which way each elbow is pushed, as `[out, y, z]` — `out` is away from the body's
 *  centre line for whichever arm this is, so one entry serves both sides and cannot be
 *  written backwards for one of them. Down in every case; the rest is what keeps the
 *  elbows out of the ribs, which a plain two-angle solve does not do (see `solveArm`). */
export const ELBOW_HINT = {
  trigger: [0.42, -1, 0.34], // down, out, and back behind the grip
  support: [0.62, -1, -0.3], // down and OUT, hard enough to clear the chest
  idle: [0.08, -1, 0.05], // a hanging arm: almost straight down, barely off the body
  dead: [0.14, -1, 0.02],
};

/**
 * Solve one arm to a target expressed the way HOLDS writes them.
 *
 * The one entry point both render.js and verify.mjs use, so what is drawn and what is
 * tested cannot diverge — the mirroring and the shoulder offset are exactly the kind of
 * two-line arithmetic that gets written twice and flipped once.
 *
 * @param side +1 for the trigger (right) arm, -1 for the support (left) arm.
 * @param t `[x, y, z]` hand target in `shoulders` space, as written in HOLDS. NOT mirrored:
 *   a hold is a specific asymmetric grip, so its coordinates are literal.
 * @param hint `[out, y, z]` from ELBOW_HINT; `out` is mirrored to this side.
 */
export function solveHand(side, t, hint) {
  return solveArm(
    ARM_UPPER, ARM_FORE,
    t[0] - side * RIG.shoulderX, t[1], t[2],
    side * hint[0], hint[1], hint[2],
  );
}

/**
 * How each weapon is held and what it looks like from outside.
 *
 * Coordinates are relative to the TRIGGER HAND, which is also the weapon group's origin.
 * That choice is what keeps this table honest: the grip is not a number that has to agree
 * with another number, it is the origin, so a weapon cannot end up held anywhere except by
 * its grip. `-z` is forward, so a part at negative z is out toward the muzzle and a part at
 * positive z is stock end, behind the hand.
 *
 * `grip` places that origin in `shoulders` space and `support` is where the off hand goes,
 * in the same space — both inside `ARM_REACH` of the shoulder that reaches for them, which
 * is asserted at import below and measured in verify.mjs.
 *
 * `parts` are boxes: `[w, h, d, x, y, z, tag, rx, ry, rz]` in weapon space, with an
 * optional 'snow' tag and optional Euler rotation for angled magazines, blades and stocks.
 * the one thing in the game that is not made of gunmetal. Three or four boxes per weapon:
 * these are seen from several metres away across a map, where the silhouette is everything
 * and a detail is noise. What has to read at that distance is length (a sniper is not a
 * pistol), bulk (an lmg is not an smg), and that the thing is in someone's HANDS.
 */
export const HOLDS = {
  knife: {
    grip: [0.19, -0.13, -0.3],
    support: null,
    parts: [
      [0.026, 0.085, 0.32, 0, 0.035, -0.22],
      [0.075, 0.026, 0.04, 0, 0.01, -0.045],
      [0.046, 0.06, 0.16, 0, -0.005, 0.055],
    ],
  },
  pistol: {
    // Punched out on the centre line with both hands, which is the one hold this figure's
    // proportions can do properly: the gun is small enough that the off hand reaches the
    // same place the trigger hand is.
    grip: [0.09, -0.155, -0.42],
    support: [0.045, -0.175, -0.44],
    parts: [
      [0.045, 0.075, 0.2, 0, 0.025, -0.07],
      [0.042, 0.11, 0.06, 0, -0.06, 0.02],
    ],
  },
  rifle: {
    grip: [0.15, -0.185, -0.17],
    support: [0.075, -0.175, -0.4],
    parts: [
      [0.075, 0.115, 0.34, 0, 0, -0.1],
      [0.032, 0.032, 0.42, 0, 0.005, -0.47],
      [0.055, 0.16, 0.075, 0, -0.12, 0.14, null, -0.24, 0, 0],
      [0.07, 0.13, 0.24, 0, 0, 0.17],
      [0.05, 0.08, 0.13, 0, -0.08, -0.18],
    ],
  },
  sniper: {
    // The longest thing in the game, and it has to read as that from across the map.
    grip: [0.15, -0.185, -0.17],
    support: [0.08, -0.175, -0.42],
    parts: [
      [0.06, 0.11, 0.46, 0, 0, -0.18],
      [0.036, 0.036, 0.44, 0, 0.005, -0.63],
      [0.05, 0.05, 0.22, 0, 0.095, -0.22],
      [0.055, 0.11, 0.2, 0, 0.005, 0.15],
    ],
  },
  smg: {
    grip: [0.15, -0.18, -0.16],
    support: [0.085, -0.175, -0.3],
    parts: [
      [0.065, 0.1, 0.29, 0, 0, -0.12],
      [0.042, 0.042, 0.29, 0, 0.005, -0.41],
      [0.05, 0.16, 0.06, 0, -0.13, -0.1, null, -0.2, 0, 0],
      [0.05, 0.09, 0.07, 0, -0.07, 0.02],
      [0.016, 0.02, 0.25, 0.025, 0, 0.19],
      [0.016, 0.02, 0.25, -0.025, 0, 0.19],
    ],
  },
  lmg: {
    // Belt-fed and it looks it: the widest receiver, the deepest box under it. Weight is
    // the whole identity of this weapon and the silhouette is where it starts.
    grip: [0.155, -0.19, -0.17],
    support: [0.08, -0.185, -0.4],
    parts: [
      [0.075, 0.13, 0.5, 0, 0, -0.18],
      [0.04, 0.04, 0.34, 0, 0.005, -0.6],
      [0.09, 0.18, 0.2, 0, -0.14, -0.12],
      [0.06, 0.11, 0.18, 0, 0.005, 0.16],
    ],
  },
  semi: {
    grip: [0.15, -0.185, -0.17],
    support: [0.078, -0.175, -0.38],
    parts: [
      [0.055, 0.1, 0.4, 0, 0, -0.15],
      [0.03, 0.03, 0.26, 0, 0.005, -0.48],
      [0.045, 0.12, 0.08, 0, -0.105, -0.09],
      [0.05, 0.1, 0.16, 0, 0.005, 0.13],
    ],
  },
  shotgun: {
    grip: [0.15, -0.185, -0.17],
    support: [0.078, -0.175, -0.4],
    parts: [
      [0.06, 0.11, 0.42, 0, 0, -0.16],
      [0.035, 0.035, 0.34, 0, 0.015, -0.54],
      [0.03, 0.03, 0.3, 0, -0.03, -0.52],
      [0.055, 0.11, 0.2, 0, 0.005, 0.15],
    ],
  },
  rifle_havoc: {
    grip: [0.15, -0.19, -0.16], support: [0.075, -0.18, -0.41],
    parts: [
      [0.082, 0.12, 0.35, 0, 0, -0.12], [0.038, 0.038, 0.38, 0, 0.01, -0.48],
      [0.065, 0.2, 0.08, 0, -0.145, -0.1, null, -0.33, 0, 0],
      [0.075, 0.085, 0.24, 0, 0, -0.39], [0.075, 0.115, 0.27, 0, 0, 0.2, null, 0.12, 0, 0],
      [0.025, 0.025, 0.31, 0, 0.07, -0.42],
    ],
  },
  rifle_falcon: {
    grip: [0.145, -0.18, -0.18], support: [0.075, -0.17, -0.36],
    parts: [
      [0.06, 0.095, 0.3, 0, 0, -0.12], [0.032, 0.032, 0.2, 0, 0.008, -0.36],
      [0.046, 0.14, 0.06, 0, -0.11, -0.04, null, -0.12, 0, 0],
      [0.018, 0.022, 0.32, 0.024, 0, 0.19], [0.018, 0.022, 0.32, -0.024, 0, 0.19],
      [0.072, 0.03, 0.05, 0, 0, 0.35], [0.022, 0.1, 0.18, 0, 0.105, -0.12],
    ],
  },
  smg_kite: {
    grip: [0.145, -0.18, -0.18], support: [0.085, -0.17, -0.29],
    parts: [
      [0.055, 0.13, 0.22, 0, 0, -0.08], [0.028, 0.028, 0.12, 0, 0.005, -0.25],
      [0.042, 0.21, 0.052, 0, -0.16, 0.01, null, 0.06, 0, 0],
      [0.055, 0.11, 0.065, 0, -0.08, 0],
      [0.014, 0.018, 0.28, 0.023, 0, 0.15], [0.014, 0.018, 0.28, -0.023, 0, 0.15],
      [0.04, 0.02, 0.06, 0, 0.085, -0.08],
    ],
  },
  smg_banshee: {
    grip: [0.15, -0.185, -0.17], support: [0.08, -0.175, -0.33],
    parts: [
      [0.078, 0.115, 0.3, 0, 0, -0.12], [0.052, 0.052, 0.31, 0, 0.008, -0.42],
      [0.05, 0.18, 0.07, 0, 0.14, -0.14, null, 0.12, 0, 0],
      [0.05, 0.11, 0.065, 0, -0.09, -0.05], [0.035, 0.08, 0.17, 0.052, 0, -0.12],
      [0.06, 0.08, 0.16, 0, 0, 0.12],
      [0.02, 0.075, 0.12, 0, 0.11, -0.15], [0.045, 0.018, 0.08, 0, 0.15, -0.15],
    ],
  },
  pistol_wisp: {
    grip: [0.088, -0.155, -0.43], support: [0.043, -0.175, -0.45],
    parts: [
      [0.042, 0.064, 0.17, 0, 0.02, -0.06], [0.052, 0.052, 0.055, 0, 0.005, -0.17],
      [0.04, 0.19, 0.052, 0, -0.105, 0.02, null, 0.05, 0, 0], [0.018, 0.035, 0.035, 0, 0.09, -0.04],
    ],
  },
  pistol_rook: {
    grip: [0.095, -0.16, -0.4], support: [0.048, -0.18, -0.42],
    parts: [
      [0.07, 0.08, 0.11, 0, 0.02, -0.05], [0.036, 0.036, 0.26, 0, 0.03, -0.24],
      [0.11, 0.11, 0.1, 0, 0.02, -0.08], [0.06, 0.16, 0.075, 0, -0.11, 0.04, null, 0.22, 0, 0],
      [0.05, 0.022, 0.14, 0, 0.08, -0.2],
    ],
  },
  lmg_atlas: {
    grip: [0.155, -0.19, -0.17], support: [0.08, -0.18, -0.41],
    parts: [
      [0.08, 0.12, 0.44, 0, 0, -0.17], [0.038, 0.038, 0.36, 0, 0.006, -0.57],
      [0.14, 0.14, 0.16, 0.05, -0.12, -0.11], [0.056, 0.1, 0.2, 0, 0, 0.16],
      [0.018, 0.11, 0.2, 0, 0.13, -0.16, null, 0, 0, -0.28],
    ],
  },
  lmg_colossus: {
    grip: [0.16, -0.195, -0.16], support: [0.07, -0.18, -0.42],
    parts: [
      [0.11, 0.15, 0.38, 0, 0, -0.1], [0.024, 0.024, 0.62, 0.045, 0.045, -0.55],
      [0.024, 0.024, 0.62, -0.045, 0.045, -0.55], [0.024, 0.024, 0.62, 0, -0.025, -0.55],
      [0.15, 0.19, 0.25, 0, -0.15, -0.12], [0.14, 0.14, 0.025, 0, 0.01, -0.45],
      [0.14, 0.14, 0.025, 0, 0.01, -0.69], [0.07, 0.12, 0.24, 0, 0, 0.2],
    ],
  },
  knife_karambit: {
    grip: [0.19, -0.13, -0.3], support: null,
    parts: [[0.022, 0.09, 0.15, 0, 0.04, -0.12, null, -0.25, 0, 0], [0.022, 0.08, 0.13, 0, 0.09, -0.24, null, -0.65, 0, 0], [0.046, 0.055, 0.15, 0, -0.005, 0.03], [0.07, 0.07, 0.025, 0, -0.005, 0.12]],
  },
  knife_tanto: {
    grip: [0.19, -0.13, -0.3], support: null,
    parts: [[0.03, 0.1, 0.36, 0, 0.045, -0.24], [0.078, 0.028, 0.04, 0, 0.01, -0.045], [0.048, 0.06, 0.17, 0, -0.005, 0.06]],
  },
  knife_bowie: {
    grip: [0.195, -0.135, -0.28], support: null,
    parts: [[0.034, 0.135, 0.42, 0, 0.06, -0.28], [0.1, 0.034, 0.045, 0, 0.01, -0.045], [0.055, 0.07, 0.19, 0, -0.008, 0.07]],
  },
  knife_kukri: {
    grip: [0.19, -0.13, -0.29], support: null,
    parts: [[0.03, 0.1, 0.17, 0, 0.04, -0.17, null, 0.18, 0, 0], [0.038, 0.14, 0.2, 0, 0.095, -0.34, null, 0.45, 0, 0], [0.08, 0.03, 0.04, 0, 0.01, -0.045], [0.052, 0.065, 0.18, 0, -0.006, 0.065]],
  },
  // Thrown weapons are held in one hand, low and cocked slightly back, with the other arm
  // brought forward for the throw. They are also the reason this table covers every weapon
  // rather than the guns: in the snowball mode every player is holding one, and the avatar
  // used to draw a rifle box regardless — "sometimes you go to snow but it still has gun".
  grenade: {
    grip: [0.2, -0.22, -0.26],
    support: null,
    idle: READY_HAND,
    parts: [[0.075, 0.1, 0.075, 0, 0, 0]],
  },
  flash: {
    grip: [0.2, -0.22, -0.26],
    support: null,
    idle: READY_HAND,
    parts: [[0.07, 0.115, 0.07, 0, 0, 0]],
  },
  smoke: {
    grip: [0.2, -0.22, -0.26],
    support: null,
    idle: READY_HAND,
    parts: [[0.082, 0.125, 0.082, 0, 0, 0]],
  },
  snowball: {
    grip: [0.2, -0.22, -0.26],
    support: null,
    idle: READY_HAND,
    parts: [[0.11, 0.11, 0.11, 0, 0, 0, 'snow']],
  },
};

export const holdOf = (id) => HOLDS[id] ?? HOLDS.rifle;

/**
 * Category-specific ready/carry language for remote players.
 *
 * A hold answers where the hands touch a particular weapon. It deliberately does not
 * answer how a soldier carries that category while running or shoulders it to aim. The
 * old renderer used the hold for both questions, leaving every long gun at the same low
 * chest/stomach line. These numbers are offsets from the authored grip, so weapon-specific
 * hand placement remains exact while rifles, pistols, SMGs and machine guns stop sharing
 * one mannequin pose.
 *
 * `readyLift` raises the weapon into a usable firing position. `walkDrop` and `walkPitch`
 * lower its mass while moving. Scope terms only apply to a real optical weapon and bring
 * its stock/optic into the face rather than merely narrowing the owner's camera.
 */
export const HANDLING = {
  knife:    { readyLift: 0.035, readyBack: 0,     readyPitch: 0.12,  walkDrop: 0.075, walkBack: 0,     walkPitch: -0.16, scopeLift: 0,    scopeBack: 0,     scopePitch: 0 },
  pistol:   { readyLift: 0.095, readyBack: -0.01, readyPitch: 0.015, walkDrop: 0.085, walkBack: 0.025, walkPitch: -0.13, scopeLift: 0,    scopeBack: 0,     scopePitch: 0 },
  smg:      { readyLift: 0.105, readyBack: 0,     readyPitch: 0.025, walkDrop: 0.085, walkBack: 0.02,  walkPitch: -0.12, scopeLift: 0,    scopeBack: 0,     scopePitch: 0 },
  rifle:    { readyLift: 0.12,  readyBack: 0.015, readyPitch: 0.03,  walkDrop: 0.09,  walkBack: 0.025, walkPitch: -0.11, scopeLift: 0,    scopeBack: 0,     scopePitch: 0 },
  dmr:      { readyLift: 0.125, readyBack: 0.02,  readyPitch: 0.035, walkDrop: 0.095, walkBack: 0.03,  walkPitch: -0.12, scopeLift: 0,    scopeBack: 0,     scopePitch: 0 },
  sniper:   { readyLift: 0.125, readyBack: 0.025, readyPitch: 0.03,  walkDrop: 0.115, walkBack: 0.035, walkPitch: -0.15, scopeLift: 0.08, scopeBack: 0.035, scopePitch: 0.055 },
  shotgun:  { readyLift: 0.115, readyBack: 0.02,  readyPitch: 0.025, walkDrop: 0.105, walkBack: 0.035, walkPitch: -0.14, scopeLift: 0,    scopeBack: 0,     scopePitch: 0 },
  lmg:      { readyLift: 0.085, readyBack: 0.035, readyPitch: 0.015, walkDrop: 0.075, walkBack: 0.045, walkPitch: -0.17, scopeLift: 0,    scopeBack: 0,     scopePitch: 0 },
  grenade:  { readyLift: 0.035, readyBack: 0,     readyPitch: 0.08,  walkDrop: 0.055, walkBack: 0.015, walkPitch: -0.12, scopeLift: 0,    scopeBack: 0,     scopePitch: 0 },
  snowball: { readyLift: 0.035, readyBack: 0,     readyPitch: 0.08,  walkDrop: 0.055, walkBack: 0.015, walkPitch: -0.12, scopeLift: 0,    scopeBack: 0,     scopePitch: 0 },
  utility:  { readyLift: 0.035, readyBack: 0,     readyPitch: 0.08,  walkDrop: 0.055, walkBack: 0.015, walkPitch: -0.12, scopeLift: 0,    scopeBack: 0,     scopePitch: 0 },
};

/** Resolve a remote weapon's pose without three.js, so reach and category differences can
 * be verified. `move` and `scope` are normalised visual amounts, not simulation state. */
export function handlingPose(id, move = 0, scope = 0) {
  const h = HANDLING[familyOf(id)] ?? HANDLING.rifle;
  const aimed = scopes(id) ? Math.max(0, Math.min(1, scope)) : 0;
  // A scoped body stays shouldered even if interpolation still reports the tail of a step.
  const carried = Math.max(0, Math.min(1, move)) * (1 - aimed * 0.9);
  return {
    y: h.readyLift - h.walkDrop * carried + h.scopeLift * aimed,
    z: h.readyBack + h.walkBack * carried + h.scopeBack * aimed,
    pitch: h.readyPitch + h.walkPitch * carried + h.scopePitch * aimed,
    aimed,
    carried,
  };
}

/**
 * Every weapon has to have a hold, and every hold has to be reachable. Checked at import,
 * where the dev server and verify.mjs both hit it immediately, because both failures are
 * silent in the worst way: a missing entry draws the wrong weapon in everyone's hands, and
 * an out-of-reach grip draws a hand next to the gun instead of on it. Those are the two
 * bugs this file was written to end, so they are checked here rather than left to a reader.
 */
for (const id of WEAPON_IDS) {
  const hold = HOLDS[id];
  if (!hold) throw new Error(`HOLDS has no entry for weapon "${id}"`);
  const targets = [
    ['trigger', 1, hold.grip],
    ['support', -1, hold.support ?? hold.idle ?? IDLE_HAND],
  ];
  for (const [what, side, t] of targets) {
    const d = Math.hypot(t[0] - side * RIG.shoulderX, t[1], t[2]);
    if (d > ARM_REACH) {
      throw new Error(
        `HOLDS.${id} ${what} hand is ${d.toFixed(3)}u from its shoulder, past the ${ARM_REACH.toFixed(2)}u reach`,
      );
    }
  }
}

/**
 * Where the off hand goes when it stops holding the weapon and starts hitting it.
 *
 * Both are offsets from wherever THIS weapon's support hand rests, not absolute positions,
 * because that rest point is different for every weapon — a pistol's off hand is out at
 * -0.44, an smg's at -0.30 — and a gesture written in absolute coordinates would land on
 * the receiver of one weapon and in mid-air beside the next.
 *
 * - `away` the wind-up: the hand comes off the forend, drops and pulls back.
 * - `into` the strike: driven up and back into the receiver, where a stoppage is cleared.
 *
 * The stroke is 19cm of travel from wind-up to strike, which is what makes the gesture
 * legible from across a map. It was worth doing properly because it is now visible for
 * 1400ms — see JAM_CLEAR_MS, which doubled precisely so that a watcher gets the time to
 * read this. "i cant see it punchin the gun to unjam it".
 */
export const JAM_HAND = {
  away: [0.055, -0.125, 0.12],
  into: [0.025, 0.06, 0.07],
};

/**
 * How far the off hand travels to work the action between shots, as an offset from the
 * support rest — straight back along the weapon, which is a pump stroke exactly and a bolt
 * throw closely enough at the distance a remote player is ever seen from.
 *
 * This is the third-person half of "you dont reload each time it shots but you cocking the
 * gun". A sniper that only ever animated on reload told an enemy nothing between shots;
 * now the stroke IS the tell that the shot has been taken and the next one is not ready.
 *
 * `at` is when the bolt is at mid-travel going back and going home, as fractions of
 * `cycleMs`, and `ramp` is how much of the cycle each of those two movements takes either
 * side of its midpoint — so the hand leaves at 0.12, is at the rear by 0.44, starts home
 * at 0.56 and is home by 0.88. Three things read this pair: the viewmodel's own hands, the
 * remote avatar's hand here, and the two beats of the sound. The whole point of animating
 * a cycle rather than just waiting out the fire interval is that you see the hand doing
 * what you hear, and a watcher recognising on someone else the stroke they have felt
 * themselves — which is only true while all three are driven from one set of numbers.
 */
export const CYCLE_HAND = { back: [0.03, 0.02, 0.16], at: [0.28, 0.72], ramp: 0.16 };

/**
 * What a weapon's weight does to the body carrying it.
 *
 * All of it is driven from one number, `heftOf`, which is derived from the deploy times
 * rather than declared — so a weapon that takes longer to bring up is automatically the
 * one that sags further, shoves harder and swings later, and there is no second table to
 * keep in step. This is the "its effect depends on weight" half of the request.
 *
 * - `sag`     radians the muzzle drops. A knife does not sag; a belt-fed gun does.
 * - `kick`    how hard one shot shoves the shoulders back. Scaled well below the
 *             viewmodel's own kick: this is a body seen from outside, and a torso that
 *             moves as much as a first-person weapon reads as a flinch, not a recoil.
 * - `follow`  seconds for the weapon to catch up to where the head is already looking.
 *             The single most legible weight cue in CS2 and the cheapest here: one
 *             exponential per avatar per frame.
 * - `trail`   radians the weapon lags behind a turn, per radian per second of turning.
 */
export const HEFT = {
  sag: (id) => 0.03 + 0.11 * heftOf(id),
  kick: (id) => 0.5 + 2.4 * heftOf(id),
  follow: (id) => 0.035 + 0.115 * heftOf(id),
  trail: (id) => 0.05 + 0.13 * heftOf(id),
};

/**
 * Where the hands and the weapon go on a body that has stopped being a body.
 *
 * A corpse is not a pose, it is the absence of one: the arms stop holding the weapon up
 * and end up at the figure's sides, and the weapon ends up on the ground next to it. Both
 * hands are kept in FRONT of `backZ` on purpose — the body is resting on its heels, so a
 * hand that reached further back than the heels would become the new lowest point and
 * would sink through the floor.
 *
 * The weapon leaving the hands matters as much as the hands relaxing. A corpse still
 * gripping a rifle at shoulder height was half of "even when death they float": the body
 * went down and the hold did not.
 */
export const DEAD_HAND = {
  trigger: [0.31, -0.55, -0.01],
  support: [-0.31, -0.55, -0.01],
};
/**
 * Where the dropped weapon ends up, in `shoulders` space, and how it is turned.
 *
 * The rotation is load-bearing rather than taste, in both of the axes that carry a quarter
 * turn. `rot.x = -1.45` is a shade off -PI/2 because the weapon is modelled down its own
 * -Z, the topple sends the body's -Z straight up, so a weapon left unturned would stand on
 * its stock with the barrel pointing at the sky; laying it over cancels that, and the
 * leftover 0.12 rad plus the yaw keep it from looking placed. `rot.z` then carries a second
 * quarter turn, about the weapon's own barrel, which is what puts it on its SIDE. Without
 * it the gun landed upright on its belly, and a gun's belly is where the magazine is: a
 * dropped lmg had 17cm of receiver box buried under the corpse's contact plane and the rest
 * of it hanging 6cm above the ground. Rolling it over is also just what a dropped rifle
 * does — nothing balances on its magazine.
 *
 * `pos.z` here is only the START of the slide, taken from where the live hold already is;
 * `deadGunZ` decides where it comes to rest, because that depends on the weapon.
 */
export const DEAD_GUN = {
  pos: [0.34, -0.55, 0.12],
  rot: [-1.45, 0.28, 0.12 + Math.PI / 2],
};

/**
 * How high above the corpse's contact plane to leave the weapon it dropped, so the thing
 * RESTS on the ground instead of hovering over it or sinking halfway through it.
 *
 * The body is on its back on its heels, so `backZ` is the floor in this space (see
 * `corpseDrop`) and depth is just +z. A single hand-tuned z cannot be right for every
 * weapon, because what reaches furthest down once the gun is on its side is its own
 * width, and that is 2.6cm on a knife and 5.5cm on an lmg — so the number is measured
 * per weapon from the boxes the weapon is actually drawn from, exactly as `rigExtent`
 * measures the figure rather than trusting a bounding box. The lowest corner then lands
 * ON `backZ`: the same contact plane the heels are resting on, not a guess near it.
 *
 * Memoised by hold — HOLDS is a module-level literal, so the identity is stable and this
 * runs once per weapon for the whole session rather than per corpse per frame.
 *
 * @param hold an entry of HOLDS, i.e. what `holdOf` returned.
 */
const DEAD_Z = new Map();
export function deadGunZ(hold) {
  let z = DEAD_Z.get(hold);
  if (z === undefined) {
    let deepest = -Infinity;
    for (const [w, h, d, cx, cy, cz, _tag, rx = 0, ry = 0, rz = 0] of hold.parts) {
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          for (const sz of [-1, 1]) {
            const local = rotateXYZ(rx, ry, rz, (sx * w) / 2, (sy * h) / 2, (sz * d) / 2);
            const c = rotateXYZ(
              ...DEAD_GUN.rot,
              cx + local.x,
              cy + local.y,
              cz + local.z,
            );
            if (c.z > deepest) deepest = c.z;
          }
        }
      }
    }
    z = rigExtent().backZ - deepest;
    DEAD_Z.set(hold, z);
  }
  return z;
}

/** True for the things you throw rather than fire — they are held differently and they
 *  are the reason a mode with no guns has to have no guns in it. Re-exported so render.js
 *  does not need its own weapons import for one predicate. */
export const thrown = (id) => isUtil(id) || id === 'snowball';

/** Half-width of the collider, so callers can compare the drawn figure against the box
 *  that actually takes the hits without importing constants themselves. */
export const HITBOX_HALF_W = C.PLAYER_HALF_W;
