// First-person weapons, hands, recoil, muzzle flash and tracers.
//
// Each weapon is a handful of boxes parented to a `hand` group on the camera. All
// rigs are built once at startup and one is shown at a time — swapping which is
// visible is a flag, not construction, so a weapon change never hitches. The swap the
// player *sees* is an animation over that flag: the old weapon goes down, the flag
// flips at the bottom, the new one comes up (see `request` and HOLSTER_FRAC).
//
// Recoil is a damped spring rather than a canned animation, so rate of fire and
// kick interact for free: hold the trigger on the rifle and the kicks stack.

import * as THREE from 'three';
import * as C from '../../shared/constants.js';
import {
  WEAPON_IDS,
  WEAPONS,
  switchMsOf,
  JAM_CLEAR_MS,
  cycleMsOf,
  idAt,
  scopes,
  hasHeavy,
  zoomStepsOf,
} from '../../shared/weapons.js';
// Euler XYZ applied to a point, the same one three.js uses. Needed here because the
// inspect rotates the weapon about its own centre rather than about the rig origin,
// and that means undoing the rotation of the pivot by hand — see the inspect branch.
import { rotateXYZ, CYCLE_HAND } from './rig.js';
import { DEFAULT_FINISH, finishOf, sanitizeCosmetics } from '../../shared/cosmetics.js';

// A shot has to read at a glance, so it is drawn three ways: a bright beam along
// the path, a line of smoke puffs that lingers after the beam is gone, and the
// muzzle flash. The beam alone was a 70ms hairline — WebGL ignores LineBasicMaterial
// width, so a `THREE.Line` is always one pixel no matter what you ask for. The beam
// is a stretched box instead, which can actually be seen.
const TRACER_COUNT = 24;
const TRACER_MS = 115;
/** Smoke outlives the beam by a lot; it is the part that shows where a shot went. */
const PUFF_MS = 560;
const PUFFS_PER_SHOT = 7;
const PUFF_COUNT = TRACER_COUNT * PUFFS_PER_SHOT;

/** Melee/throw animation length. A damped spring cannot express a swing — it peaked
 *  at 8 degrees, which is why the knife read as a twitch rather than a slash. */
const SWING_MS = 260;
/**
 * How far through a throw the projectile leaves the hand.
 *
 * The whole of ask "grenade/snow ... it doesnt leave the hands lol": the old throw
 * cocked back and drove forward but the ball was a *part of the rig*, so it came all
 * the way home with the hand and was still sitting in the fist at rest. A real throw
 * releases — so past this point in the swing the thrown body is hidden and the hand
 * follows through empty. Placed at the front of the drive, where the hand is already
 * committed forward, so the ball vanishes at full extension rather than snapping out
 * of a hand that has stopped. The world projectile the server spawns is what the
 * player then sees fly; this only has to sell the hand letting go.
 */
const THROW_RELEASE = 0.46;
/** The heavy stab. Slower on purpose and matched to the weapon's own `intervalMs`
 *  ratio: right-click has to *feel* like the commitment it is, or the trade the stats
 *  describe — twice the damage for twice the wait — is invisible to the player. */
const HEAVY_SWING_MS = 560;
/** One turn of the weapon inspect. Loops for as long as F is held. */
const INSPECT_MS = 1500;

// ---- shell casings ---------------------------------------------------------
// "i dont see any bullet trays going out". Every round a gun chambers throws its case
// out of the ejection port, and its absence is the loudest missing detail on an
// otherwise finished-looking weapon: the gun cycles, the flash fires, and nothing
// leaves it.
//
// Cases live in the WORLD scene, not on the viewmodel, and that is the whole point of
// where they are spawned: they must stay where they were ejected while the player keeps
// running, exactly like the tracers do. A casing parented to the hand would ride along
// in front of the camera forever.
const CASE_COUNT = 32;
const CASE_MS = 2600;
/** Gravity on a falling case. Heavier than real brass looks right at this scale —
 *  a case that hangs in the air reads as a floating chip of gold. */
const CASE_G = 15;
/** How fast a case leaves the port, and how much of that is randomised. Out to the
 *  shooter's right and slightly up and back, which is where a right-hand ejection port
 *  actually throws them. */
const CASE_SPEED = 2.1;
/** Where the floor is, in world units — the arena floor box's top plus a hair, so a
 *  resting case sits on the ground rather than half sunk into it. */
const CASE_REST = 0.012;
/** How much of the impact speed a case keeps off the ground, how much of its sideways
 *  speed and tumble survive the bounce, and below what speed it simply stops. A case is
 *  brass on concrete: it takes one small hop and rattles dead, it does not roll away. */
const CASE_BOUNCE = 0.32;
const CASE_FRICTION = 0.55;
const CASE_STOP = 0.9;
/**
 * How far the inspect turns the weapon, in radians. Just past broadside.
 *
 * "the side by side of the gun ... so we can see the full view of the gun" — so the
 * hold is the weapon's PROFILE, square to the eye, which is 90°. The extra 5° is
 * deliberate: at exactly 90° a flat-shaded box weapon projects to an elevation drawing
 * with no depth in it at all, and a few degrees past brings the muzzle end nearer than
 * the stock so the silhouette reads as an object rather than a decal.
 *
 * This was 2.3 — 132°, most of the way to reversed. Past broadside the far side goes
 * away again and the barrel comes back toward the eye, which is the second half of why
 * "inspect goes to your face": the turn itself was aimed at the player. The first half
 * was the pivot, and that is fixed in the branch (see INSPECT_FILL).
 */
const INSPECT_TURN = 1.66;
/**
 * How far toward the edge of the frame the weapon's own edge is allowed to reach at the
 * hold. 0.72 leaves a little over a quarter of the half-frame as margin on the tighter
 * axis.
 *
 * The whole of "it should go far so we can see the full view of the gun". The old
 * inspect turned the rig about its own ORIGIN, which sits behind the receiver — the
 * rifle's centre is 0.32 in front of it and the sniper's 0.56 — so the turn swung the
 * weapon around on a half-metre arm and threw the front half of it through the camera
 * plane. That is not a framing problem, it is a pivot problem, and no amount of pushing
 * the rig away fixes it: the barrel arrives at the eye anyway.
 *
 * So the branch rotates about the weapon's own bounding-box centre, and then solves for
 * the depth at which the whole of it fits:
 *
 *     d = (|offset from screen centre| + reach across the frame) / (tan(half-fov) · FILL)
 *
 * on both axes, taking whichever is tighter, off the viewmodel camera's live fov and
 * aspect. Measured at 50° and 16:9, that pushes the centre out to 82cm on the rifle
 * (+30), 113cm on the sniper (+42), 106cm on the machine gun (+43) and 59cm on the
 * pistol (+30) — and at the hold every weapon's furthest corner then sits between 66%
 * and 76% of the way to the frame edge, with the long ones spanning 52–67% of the
 * screen's width. Nothing is off-frame at the hold on 16:9, 4:3 or 21:9, and no frame of
 * the animation is worse framed than the resting weapon already is.
 *
 * It only ever pushes, and only as the weapon turns (`Math.max(0, need - rest) * turn`),
 * which is what keeps the first and last frame exactly on the rest pose — measured at
 * under a micrometre — and stops a pistol being dragged closer to fill more of a frame
 * it was never too small for.
 */
const INSPECT_FILL = 0.72;
/**
 * Recoil, split three ways: back along the aim line, up, and muzzle pitch.
 *
 * "i hate the blowback it is all upside instead of up and back you get me right?" —
 * and measured, it was. The old pair was `z + kick*0.05` with `rotation.x = kick*0.6`,
 * which at the rifle's own peak spring displacement is 0.7cm of travel against 6.4cm
 * of muzzle rise: the muzzle's recoil path left the aim line at 84° from horizontal,
 * i.e. straight up. These three put it at 47° — 3.1cm back, 3.2cm of rise — which is
 * the diagonal a shoulder-fired weapon actually recoils along.
 *
 * The pitch is still there and still does most of the work at the muzzle, because
 * that is how recoil works: the weapon pivots about the hands and shoves into them.
 * What changed is that the shove is now four times bigger than the rotation's own
 * contribution at the grip, instead of a quarter of it.
 *
 * BACK is bounded, and the bound is why it is 0.21 rather than a rounder number.
 * `place` clamps the rig to POSE_ROOM (6cm) of travel toward the camera, and the
 * heaviest weapon under sustained fire — the machine gun, whose kicks stack at 105ms
 * apart — peaks at 0.282 of spring displacement. 0.282 × 0.21 = 5.9cm, so nothing
 * ever hits the clamp and no weapon's recoil silently flattens at the top of a burst.
 * verify.mjs re-derives that for every weapon; if a new one breaks it, it says so.
 */
const KICK_BACK = 0.21;
const KICK_UP = 0.05;
const KICK_PITCH = 0.3;

/**
 * ---- the sprint carry ------------------------------------------------------------
 * "i have no idea whether im sprinting or not since the gun doesnt even tell me
 *  whether im sprinting  the gun should look like im sprinting ... unless i am shooting."
 *
 * It genuinely did not tell you. Sprint's only effect on the viewmodel was through
 * `walk` = speed / MOVE_SPEED, which a settled run puts at 0.90 and a settled sprint at
 * 1.02 — the bob got 13% bigger. Thirteen percent of a 6mm bob is 0.8mm of extra travel,
 * so the answer to "am I sprinting" was a sub-millimetre difference in an oscillation you
 * are not watching. There is a stamina bar, but a bar is a thing you look away from the
 * fight to read; the gun is already in the middle of the screen.
 *
 * So sprint gets a POSE, not a bigger wiggle: the weapon comes down off the aim line,
 * cants across the body and rocks with the stride. That is what a run looks like, and
 * it is legible from the shape of the silhouette rather than from an amplitude.
 *
 * IN and OUT are deliberately asymmetric. Dropping into the carry is a decision and can
 * take its time; coming back up is the answer to a trigger pull and cannot. 9/s is a
 * 111ms time constant (90% in 256ms); 20/s is 50ms (90% in 115ms).
 */
const SPRINT_IN_RATE = 9;
const SPRINT_OUT_RATE = 20;
/**
 * How long after a shot the weapon stays up, past the weapon's own fire interval.
 *
 * Scaled by the interval rather than fixed, because a fixed window shorter than the
 * cadence dips the gun BETWEEN rounds — the twitch a 200ms window would put in the middle
 * of every 250ms pistol string. Interval + tail means no sustained string can dip, and the
 * tail is what keeps the gun up for a beat after the last round rather than dropping it on
 * the same frame you stop.
 *
 * MAX is a backstop and nothing more. It currently binds on no weapon — the slowest
 * cadence in the game is the sniper's 1200ms, so the largest hold is 1520 — and that is
 * the property verify.mjs checks: the hold must cover every weapon's own interval, or a
 * sustained string of fire dips the gun between its own rounds. The cap is there so a
 * future weapon with a five-second cycle cannot pin the carry off for five seconds, and
 * verify will say which weapon broke it.
 */
const SPRINT_FIRE_TAIL = 320;
const SPRINT_FIRE_MAX = 1600;

/**
 * The carry itself, as position and rotation deltas on whatever pose the weapon is
 * already in. Blended by `k`, mirrored by `side`, and phased on the same `sway` the bob
 * runs on so the rock and the footfalls agree.
 *
 * Self-contained on purpose: verify.mjs lifts this function out of the source and
 * measures the shipped numbers — against place()'s clamp, against the near plane and
 * against the frame edge — so the constants live in here where they can be lifted with
 * it rather than in module scope where a lift would not see them.
 *
 * The sizes are set by the viewmodel camera, and it is narrow: VM_FOV is 50°, so at the
 * quarter-metre a weapon rests at, the whole frame is only about 23cm tall. The first pass at
 * this used a 6cm drop and a 24° cant — figures that read as reasonable next to ADS's 5cm and
 * the knife wind-up's 37° — and it put every weapon in the game completely out of frame. A
 * gun you cannot see is a worse answer to "am I sprinting" than a gun that does not move.
 * verify.mjs now counts how much of each weapon stays inside the frustum, at both hands and
 * every point in the stride, against how much of it the rest pose shows; these numbers are
 * the largest that keep 60% of that on the worst rig in the game, which is the knife.
 *
 *   DROP 0.026   Down off the aim line. Still the largest vertical displacement in the file
 *                — half again what a crouch does, and 4.3x the walk bob's whole amplitude.
 *   IN   0.011   Inward, across the body.
 *   BACK 0.005   Toward the chest. Smallest of the three, because it is the one axis recoil
 *                also owns: place() clamps rearward travel to POSE_ROOM and the machine gun
 *                already spends 5.9cm of the 6cm at the top of a burst.
 *   PITCH -0.145 Muzzle down 8°. Negative is muzzle-down — see KICK_PITCH, which is the
 *                same axis with the opposite sign.
 *   YAW  0.12    Muzzle inward 7°, so the barrel crosses the view instead of pointing where
 *                you are about to shoot.
 *   ROLL 0.17    Canted 10°, top toward the body, and the cue that does most of the work:
 *                a rolled silhouette is a different SHAPE, which survives being small in a
 *                way that a few millimetres of extra bob never did.
 * and the stride, which is what separates a carry from a static offset:
 *   PUMP 0.009   Extra drop on each footfall.
 *   ROCK 0.075   Roll swing, +-4.3° about the cant, one cycle per stride pair, so the gun
 *                rocks between 5° and 14° of cant as you run.
 *   LEAD 0.006   Lateral swing, in step with the pump.
 */
function sprintCarry(k, sway, side) {
  if (k <= 0) return { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 };
  // `sway` is the bob's phase. sin() is the stride — one cycle per left-right pair, which
  // is what the shoulders do — and its magnitude is the footfall, twice per cycle, which
  // is what `bobY` already uses for the same reason.
  const stride = Math.sin(sway);
  const pump = Math.abs(stride);
  return {
    x: k * (-0.011 + Math.cos(sway) * 0.006) * side,
    y: k * (-0.026 - pump * 0.009),
    z: k * 0.005,
    // The muzzle lifts a little on each footfall rather than pumping further down: the
    // weapon is hanging off the hands, so the mass swings behind the step.
    pitch: k * (-0.145 + pump * 0.032),
    yaw: k * (0.12 + stride * 0.026) * side,
    roll: k * (0.17 + stride * 0.075) * side,
  };
}

/**
 * Where a held inspect parks, as a fraction of INSPECT_MS.
 *
 * Chosen from the pose branch's own three curves rather than to taste: `lift` plateaus
 * across 0.14–0.82, `turn` across 0.44–0.62 and `tilt` across 0.5–0.6. 0.55 is the only
 * region where all three are simultaneously at full, which is the frame the animation was
 * built to show off — the flank square to the eye, raised and tipped into the light. Park
 * anywhere else and a held inspect stops mid-rotation, which reads as the animation
 * having hitched rather than as the player holding the weapon up to look at it.
 */
const INSPECT_HOLD_AT = 0.55;
/**
 * How much of a swap is spent putting the old weapon away.
 *
 * The whole swap lasts `switchMsOf(incoming)` because that is exactly how long the
 * server blocks firing for (see `switchUntil` in server/room.js) — an animation that ran
 * shorter would show a ready weapon that refuses to shoot, and one that ran longer would
 * take the trigger away from a player who can already see the sights. The holster is the
 * shorter half: a weapon comes up more deliberately than it goes down.
 *
 * A FRACTION rather than a duration, which is what lets a 300ms knife and a 900ms
 * machine gun share one curve: every beat in the swap — holster, hand-over, cock,
 * settle — is placed at a proportion of the swap, so a heavier weapon plays the same
 * gesture more slowly instead of playing a different one.
 */
const HOLSTER_FRAC = 0.38;
/**
 * When, as fractions of the swap, the off hand works the action.
 *
 * Named rather than typed inline because three things have to agree on it: the pose
 * branch that draws the stroke, and the `onDraw` hook that schedules the sound for the
 * middle of it. A sound landing outside the window it belongs to is worse than no sound,
 * because it makes the animation look wrong rather than sounding wrong.
 */
const COCK_AT = [0.58, 0.9];
/**
 * When, as fractions of `cycleMs`, the bolt is at mid-travel going back and going home,
 * and how much of the cycle each of those movements takes either side of its midpoint.
 *
 * Kept in rig.js beside `CYCLE_HAND.back` because the remote avatar's hand animates off
 * the same pair, and read here for both the `pull` curve of the pose branch below and the
 * two beats handed to `onCycle`. The whole reason to animate a bolt cycle rather than just
 * wait out the fire interval is that you SEE the hand doing what you HEAR — and three sets
 * of numbers that mean the same thing eventually stop agreeing.
 */
const CYCLE_AT = CYCLE_HAND.at;
const CYCLE_RAMP = CYCLE_HAND.ramp;

/**
 * How far the fist lifts off the receiver between the two strikes of a jam-clearing
 * punch, as a fraction of the half-frame.
 *
 * The only free number in that punch. Where the fist goes is a point on the weapon
 * (`strike`), how it travels there is the animation's own `tip`, and which way the
 * forearm points is the shoulder — so all that is left to pick is the amplitude of the
 * wind-up between contacts.
 *
 * A share of the screen and not a distance, because a receiver is 24cm from the eye on a
 * pistol and 56 on a sniper: 10cm of lift is 0.89 of the half-frame on the one and 0.38
 * on the other, so a distance cannot mean the same gesture twice. Measured against the
 * gun, 10cm put the fist 0.8 to 1.3 half-frames above the highest visible part of the
 * weapon on every jamming gun — a hand punching open sky — and swung 33cm of forearm up
 * across the frame with it, from 4% of the screen at rest to 12%.
 *
 * 0.22 is a little over the fist's own radius on screen, which is the least that reads as
 * one thing lifting off another rather than a jitter, and 4cm on a rifle.
 */
const JAM_RAISE = 0.22;

// ---------------------------------------------------------------- timing helpers
// Staged animations are expressed as ranges of one 0..1 progress value rather than as
// separate timers. That is what lets the reload be driven entirely by the server's
// countdown: there is only ever one clock, so no phase can finish early or late.

/** Where `t` sits within [a,b], clamped to 0..1. */
const seg = (t, a, b) => Math.min(1, Math.max(0, (t - a) / (b - a)));
/** Smoothstep. Ease in and out, so a phase boundary is not a visible corner. */
const smooth = (k) => k * k * (3 - 2 * k);
/** One beat inside [a,b]: rises to 1 at the middle, back to 0 at each end, and stays
 *  0 outside. Used for the things that happen *once* — a magazine seating, a slide
 *  being racked. */
const beat = (t, a, b) => Math.sin(Math.PI * seg(t, a, b));

// ---------------------------------------------------------------- arms
// Where a shoulder sits in camera space. Behind the near plane (+z) and well below
// the eye, so forearms enter the frame from the lower corners the way they do in
// every first-person shooter — which is the whole reason you read a viewmodel as a
// person holding something rather than a gun floating in the void.
const SHOULDER = [0.2, -0.34, 0.16];
/** Visible forearm length. Fixed rather than "however far the shoulder is", because
 *  the support hand is nearly twice as far from its shoulder as the trigger hand is
 *  from its own — drawing the true spans gives one normal arm and one gibbon's. The
 *  upper arm is simply off-screen behind the camera, exactly as it is in life. */
const ARM_LEN = 0.33;
const FOREARM_W = 0.072;
const FIST = [0.076, 0.07, 0.1];

// Shared materials — a handful of flat-shaded values, matching the level's logic
// that face brightness alone carries the form. `steel` stays dark deliberately: a
// pale gun against sunlit pale walls loses its silhouette.
const MATS = {
  steel: () => new THREE.MeshLambertMaterial({ color: 0x3a4351, flatShading: true }),
  dark: () => new THREE.MeshLambertMaterial({ color: 0x252c38, flatShading: true }),
  trim: () => new THREE.MeshLambertMaterial({ color: C.PALETTE.self, flatShading: true }),
  blade: () => new THREE.MeshLambertMaterial({ color: 0xb9c2ce, flatShading: true }),
  army: () => new THREE.MeshLambertMaterial({ color: 0x4f5a3c, flatShading: true }),
  // Linked ammunition. Its own colour because it is the one part of a belt-fed weapon
  // that has to read as ammunition rather than as more gun: a brass run hanging out of
  // the feed tray is what says "machine gun" from the first frame you hold it.
  brass: () => new THREE.MeshLambertMaterial({ color: 0xb08d3f, flatShading: true }),
  snow: () => new THREE.MeshLambertMaterial({ color: 0xeef3f9, flatShading: true }),
  // Skin, not a glove. A dark glove on a dark weapon is one silhouette and reads as
  // more gun; bare hands are the cheapest possible signal that a person is holding
  // this. Kept under 0xC0 like every other albedo here so the lit faces do not clip.
  skin: () => new THREE.MeshLambertMaterial({ color: 0xb5865f, flatShading: true }),
  sleeve: () => new THREE.MeshLambertMaterial({ color: 0x4e5647, flatShading: true }),
};

// Rig geometry as data. `parts` are [material, w, h, d, x, y, z] boxes, or
// [material, 'sphere', r, x, y, z]. `rest` is where the rig sits at ease; `muzzle`
// is where tracers and the flash originate, in rig-local space.
//
// `grips` are where hands go, in rig-local space: [x, y, z, arm] with arm 0 for the
// trigger hand (same side as the player's handedness) and 1 for the support hand
// (the other shoulder). One entry means one hand.
//
// `mag` indexes the part that drops out during a reload. Omitted for anything with
// no magazine, which is also exactly the set of weapons with `reloadMs: 0`.
//
// The x in `rest` and in every grip is mirrored for a left-handed player. The WEAPONS
// are symmetric side to side so mirroring the offset is enough — but arms are not,
// which is why two of them are built per rig and swapped by visibility. Negating
// scale.x instead would invert the normals and break the flat shading that gives
// every model in this game its shape.
const RIGS = {
  rifle: {
    rest: [0.105, -0.088, -0.2],
    muzzle: [0, 0.012, -0.49],
    kick: 5.4,
    mag: 2,
    grips: [
      [0.014, -0.062, 0.04, 0],
      [-0.012, -0.05, -0.21, 1],
    ],
    parts: [
      ['steel', 0.075, 0.09, 0.44, 0, 0, 0],
      ['steel', 0.036, 0.036, 0.3, 0, 0.012, -0.34],
      ['trim', 0.055, 0.15, 0.075, 0, -0.1, 0.03],
      ['steel', 0.05, 0.075, 0.16, 0, -0.015, 0.28],
    ],
  },
  pistol: {
    rest: [0.1, -0.1, -0.26],
    muzzle: [0, 0.014, -0.17],
    kick: 3.8,
    mag: 2,
    // Both hands on the grip — the two-handed stance, which is what makes a pistol
    // read as a pistol rather than as a small rifle.
    grips: [
      [0.016, -0.058, 0.052, 0],
      [-0.026, -0.078, 0.036, 1],
    ],
    parts: [
      ['steel', 0.052, 0.072, 0.2, 0, 0, 0],
      ['dark', 0.048, 0.032, 0.22, 0, 0.05, -0.012],
      ['trim', 0.048, 0.12, 0.072, 0, -0.088, 0.052],
      ['steel', 0.024, 0.024, 0.06, 0, 0.014, -0.13],
    ],
  },
  sniper: {
    rest: [0.092, -0.084, -0.16],
    muzzle: [0, 0.01, -0.78],
    kick: 9.2,
    mag: 5,
    grips: [
      [0.014, -0.05, 0.03, 0],
      [-0.014, -0.042, -0.3, 1],
    ],
    parts: [
      ['steel', 0.07, 0.09, 0.55, 0, 0, 0],
      ['steel', 0.03, 0.03, 0.5, 0, 0.01, -0.52],
      ['dark', 0.046, 0.046, 0.24, 0, 0.095, -0.12],
      ['dark', 0.03, 0.05, 0.03, 0, 0.058, -0.02],
      ['dark', 0.03, 0.05, 0.03, 0, 0.058, -0.22],
      ['trim', 0.05, 0.1, 0.07, 0, -0.085, 0.02],
      ['steel', 0.05, 0.09, 0.24, 0, -0.012, 0.36],
    ],
  },
  knife: {
    rest: [0.128, -0.13, -0.29],
    muzzle: [0, 0.05, -0.34],
    kick: 2.4,
    melee: true,
    anim: 'slash',
    grips: [[0.012, -0.006, 0.022, 0]],
    parts: [
      ['blade', 0.016, 0.072, 0.3, 0, 0.028, -0.2],
      ['dark', 0.058, 0.02, 0.03, 0, 0.014, -0.068],
      ['dark', 0.034, 0.044, 0.14, 0, 0, 0.01],
    ],
  },
  grenade: {
    rest: [0.135, -0.14, -0.3],
    muzzle: [0, 0, -0.07],
    kick: 1.6,
    melee: true,
    anim: 'throw',
    grips: [[0.006, -0.026, 0.05, 0]],
    parts: [
      ['army', 'sphere', 0.055, 0, 0, 0],
      ['dark', 0.02, 0.05, 0.02, 0, 0.06, 0],
    ],
  },
  snowball: {
    rest: [0.135, -0.14, -0.3],
    muzzle: [0, 0, -0.07],
    kick: 1.4,
    melee: true,
    anim: 'throw',
    grips: [[0.006, -0.028, 0.052, 0]],
    parts: [['snow', 'sphere', 0.058, 0, 0, 0]],
  },

  // ── the rest of the arsenal
  // Every weapon in WEAPONS needs an entry here or it cannot be drawn: `request` early-
  // outs on a rig it does not have, which means selecting that weapon leaves the
  // PREVIOUS one in your hands — a weapon that fires with someone else's model and
  // someone else's sounds, which is worse than a missing model because nothing tells
  // you it happened.
  //
  // Each silhouette is doing a job. A player has a fraction of a second to know what
  // they are holding, and at this level of detail that has to come from the outline:
  // the SMG is short with the magazine forward, the machine gun has a box under it, the
  // shotgun has two tubes, the semi has an optic. Read together they are also a rough
  // guide to weight — which is what `kick` says numerically, and the two agree.
  smg: {
    rest: [0.1, -0.09, -0.22],
    muzzle: [0, 0.014, -0.33],
    kick: 3.4,
    mag: 2,
    grips: [
      [0.014, -0.056, 0.03, 0],
      [-0.01, -0.05, -0.14, 1],
    ],
    parts: [
      ['steel', 0.07, 0.085, 0.3, 0, 0, 0],
      ['dark', 0.032, 0.032, 0.18, 0, 0.014, -0.23],
      // Magazine forward of the grip, in front of the trigger hand. That is the one
      // detail that reads as "submachine gun" rather than "short rifle" at a glance.
      ['trim', 0.05, 0.13, 0.058, 0, -0.088, -0.05],
      ['dark', 0.046, 0.1, 0.06, 0, -0.07, 0.06],
      ['steel', 0.042, 0.055, 0.1, 0, 0.005, 0.2],
    ],
  },
  lmg: {
    rest: [0.115, -0.098, -0.17],
    muzzle: [0, 0.02, -0.66],
    kick: 7.2,
    mag: 4,
    grips: [
      [0.018, -0.062, 0.08, 0],
      // Support hand out on the handguard, not on the receiver. On a weapon this long
      // a hand tucked in close reads as a rifle held badly; out at -0.29 it reads as
      // somebody bracing something heavy.
      [-0.014, -0.044, -0.29, 1],
    ],
    /**
     * "the machine gun doesnt look like machine gun cmon now."
     *
     * It didn't — it was the rifle's silhouette with a bigger box under it, and a bigger
     * box is not a category, it is a bigger box. What actually separates a belt-fed
     * weapon from a rifle at a glance is four things, and none of them were here: the
     * feed-tray hump on top, a carry handle above it, a ribbed heavy barrel, and a
     * bipod. Those are the parts below, and they are all silhouette rather than detail —
     * at this level of geometry the outline is the only thing a player has time to read.
     *
     * The bipod is deliberately drawn deployed even though you are hipfiring, which no
     * real gunner would do. It is the single most recognisable thing on the weapon and
     * folded along the barrel it disappears into the barrel's own outline. Legs are kept
     * short, 0.12, so they say "bipod" without becoming the model.
     */
    parts: [
      // Receiver. Deeper and taller than the rifle's 0.082×0.1×0.5 — mass is the other
      // half of what the `kick: 7.2` is telling you, and the two have to agree.
      ['steel', 0.088, 0.112, 0.5, 0, 0, 0],
      // Feed-tray cover: the hump a belt runs in under. No rifle in the table has one.
      ['dark', 0.074, 0.038, 0.32, 0, 0.074, -0.05],
      // Carry handle — bar plus the post that holds its rear end up.
      ['dark', 0.022, 0.016, 0.15, 0, 0.126, -0.2],
      ['dark', 0.022, 0.03, 0.022, 0, 0.104, -0.14],
      // The belt box, and it is what `mag` points at: on a machine gun the thing that
      // comes off during a reload is the ammunition box, not a magazine.
      ['trim', 0.108, 0.145, 0.22, 0, -0.108, -0.09],
      // The belt, running out of the box into the right side of the receiver.
      ['brass', 0.08, 0.026, 0.05, 0.05, -0.036, -0.05],
      // Heavy barrel, 0.4 deep against the rifle's 0.3.
      ['steel', 0.038, 0.038, 0.4, 0, 0.02, -0.44],
      // Handguard, under the support hand.
      ['dark', 0.064, 0.058, 0.16, 0, -0.018, -0.3],
      // Cooling ribs on the exposed run of barrel, forward of the handguard.
      ['dark', 0.058, 0.058, 0.016, 0, 0.02, -0.44],
      ['dark', 0.058, 0.058, 0.016, 0, 0.02, -0.52],
      // Bipod: mount, then a leg either side.
      ['dark', 0.036, 0.026, 0.045, 0, -0.006, -0.58],
      ['dark', 0.014, 0.12, 0.014, 0.042, -0.078, -0.585],
      ['dark', 0.014, 0.12, 0.014, -0.042, -0.078, -0.585],
      ['dark', 0.03, 0.05, 0.028, 0, 0.056, -0.62],
      ['dark', 0.05, 0.13, 0.07, 0, -0.096, 0.09],
      ['steel', 0.054, 0.088, 0.2, 0, -0.005, 0.33],
    ],
  },
  semi: {
    rest: [0.1, -0.086, -0.2],
    muzzle: [0, 0.012, -0.52],
    kick: 6.2,
    mag: 2,
    grips: [
      [0.014, -0.06, 0.05, 0],
      [-0.012, -0.05, -0.22, 1],
    ],
    parts: [
      ['steel', 0.072, 0.088, 0.42, 0, 0, 0],
      ['steel', 0.034, 0.034, 0.32, 0, 0.012, -0.35],
      ['trim', 0.05, 0.12, 0.07, 0, -0.09, 0.02],
      // A low optic, deliberately smaller than the sniper's: this weapon does not zoom,
      // and a rig that promises a scope the right button will not give you is a lie the
      // player pays for in a duel.
      ['dark', 0.04, 0.04, 0.15, 0, 0.076, -0.1],
      ['dark', 0.026, 0.03, 0.026, 0, 0.05, -0.03],
      ['steel', 0.05, 0.078, 0.18, 0, -0.012, 0.26],
    ],
  },
  shotgun: {
    rest: [0.108, -0.094, -0.19],
    muzzle: [0, 0.018, -0.6],
    kick: 8.6,
    // No `mag`, and its absence is correct rather than an omission: shells go into a
    // tube one at a time, so there is no magazine to drop. `restoreRig` and the reload
    // animation both test for the field, so what plays is the weapon being worked
    // without anything falling out of it.
    grips: [
      [0.016, -0.058, 0.07, 0],
      [-0.012, -0.048, -0.24, 1],
    ],
    parts: [
      ['steel', 0.078, 0.095, 0.34, 0, 0, 0],
      ['steel', 0.04, 0.04, 0.42, 0, 0.02, -0.36],
      // Barrel over tube, the two-cylinder profile that says pump-action.
      ['dark', 0.036, 0.036, 0.36, 0, -0.03, -0.33],
      ['trim', 0.048, 0.052, 0.13, 0, -0.028, -0.22],
      ['steel', 0.052, 0.088, 0.22, 0, -0.02, 0.24],
    ],
  },

  // Utility. Both are canisters rather than the grenade's sphere, and they differ from
  // each other by material and by where the band sits — the same distinction CS2 makes,
  // and for the same reason: the one moment you need to know which of the two is in your
  // hand is the moment you have no time to look at the HUD.
  flash: {
    rest: [0.135, -0.14, -0.3],
    muzzle: [0, 0, -0.07],
    kick: 1.5,
    melee: true,
    anim: 'throw',
    grips: [[0.006, -0.03, 0.05, 0]],
    parts: [
      ['blade', 0.06, 0.11, 0.06, 0, 0, 0],
      ['dark', 0.04, 0.026, 0.04, 0, 0.068, 0],
      ['trim', 0.066, 0.02, 0.066, 0, 0.024, 0],
    ],
  },
  smoke: {
    rest: [0.135, -0.14, -0.3],
    muzzle: [0, 0, -0.07],
    kick: 1.5,
    melee: true,
    anim: 'throw',
    grips: [[0.006, -0.03, 0.05, 0]],
    parts: [
      ['army', 0.068, 0.1, 0.068, 0, 0, 0],
      ['dark', 0.044, 0.024, 0.044, 0, 0.062, 0],
      ['snow', 0.074, 0.018, 0.074, 0, -0.03, 0],
    ],
  },
};

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const FORWARD_Z = V(0, 0, 1);

/**
 * A box stretched from `a` to `b`, oriented without touching the scene graph.
 *
 * `Object3D.lookAt` would be shorter but it reads the parent's world matrix, so it
 * only gives the right answer if the whole chain above it has been updated — a
 * silent dependency on when this happens to be called. setFromUnitVectors has no
 * such dependency. Polarity does not matter: a centred box looks identical whether
 * its +z or its -z faces the target.
 */
function limb(mat, a, b, w) {
  const dir = b.clone().sub(a);
  const len = dir.length();
  if (len < 1e-5) return null;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, w, len), mat);
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(FORWARD_Z, dir.divideScalar(len));
  return mesh;
}

/**
 * Forearms and fists for one handedness, in rig-local space.
 *
 * Built per rig and per side, then toggled by visibility. The arms are CHILDREN of
 * the weapon rig, which is the whole trick: recoil, the slash arc, the reload tilt
 * and the inspect turn are all rig transforms, so the hands stay welded to the
 * weapon through every one of them without a single line of animation code.
 *
 * Each hand also gets its own group, so an animation can move one arm alone. The
 * reload needs exactly that — the support hand leaves the weapon to swap the magazine
 * while the trigger hand keeps hold of it, which is most of what a reload *looks* like.
 *
 * @param dz the same forward shift applied to the rig's parts, so a grip stays on the
 *   piece of the weapon it was authored against.
 */
function buildArms(spec, side, dz) {
  const g = new THREE.Group();
  const hands = {};
  const [rx, ry, rz] = spec.rest;
  const skin = MATS.skin();
  const sleeve = MATS.sleeve();

  for (const [gx, gy, gz, arm] of spec.grips ?? []) {
    const h = new THREE.Group();
    hands[arm] = h;
    g.add(h);

    const wrist = V(gx * side, gy, gz + dz);
    // Where this hand's fist sits when it is just holding the weapon. Kept because one
    // animation needs to move a hand to a point on the WEAPON rather than by an offset
    // from wherever it happens to grip: see `strike` and the jam branch. `position` is
    // an offset on the group, so aiming the fist at a target means knowing where it
    // starts, and only the builder knows that.
    h.userData.wrist = wrist.clone();
    // The shoulder this hand comes from, expressed relative to the rig's rest pose.
    const shoulder = V(
      SHOULDER[0] * side * (arm === 0 ? 1 : -1) - rx * side,
      SHOULDER[1] - ry,
      SHOULDER[2] - rz,
    );
    const back = shoulder.clone().sub(wrist).normalize();
    // Both kept for the same reason as `wrist`: an animation that moves a fist to a point
    // on the WEAPON has to re-aim the forearm afterwards, and only the builder knows which
    // way it was pointing to begin with. See the jam branch.
    h.userData.shoulder = shoulder.clone();
    h.userData.back = back.clone();

    const fist = new THREE.Mesh(new THREE.BoxGeometry(...FIST), skin);
    fist.position.copy(wrist);
    // Face the fist along the arm, so the knuckles sit across the weapon rather
    // than skewed to the world axes.
    fist.quaternion.setFromUnitVectors(FORWARD_Z, back.clone());
    h.add(fist);

    const from = wrist.clone().addScaledVector(back, FIST[2] * 0.5);
    const to = wrist.clone().addScaledVector(back, FIST[2] * 0.5 + ARM_LEN);
    const arm3 = limb(sleeve, from, to, FOREARM_W);
    if (arm3) h.add(arm3);
  }
  // Handed back so the inspect can fade the arms out. Two materials, both created
  // here, so nothing else on screen changes opacity with them.
  return { g, hands, mats: [skin, sleeve] };
}

/**
 * How far back a rig's rearmost point reaches, in rig-local z.
 *
 * Positive z is BEHIND the camera. The rifle's stock sat at +0.36 and the sniper's at
 * +0.48, against rest positions only 0.2 and 0.16 from the eye — so those parts were
 * not merely clipped by the near plane, they were behind the eye and could never be
 * drawn. Front faces cut away leave backfaces, which are culled, and what is left is
 * the hollow interior: "you can see the inside of the gun". Half a weapon is the other
 * half of the same bug, and it matters beyond looks — a skin nobody can see the back
 * of is not sellable.
 */
function rearOf(spec) {
  let back = 0;
  for (const p of spec.parts) {
    const sphere = p[1] === 'sphere';
    const z = sphere ? p[5] : p[6];
    const hz = sphere ? p[2] : p[3] * 0.5;
    back = Math.max(back, z + hz);
  }
  return back;
}

/**
 * The rig's bounding box, in rig-local space before the forward shift.
 *
 * Needed because the inspect has to rotate the weapon about its own middle instead of
 * about the rig origin. The origin is not the middle of anything — it is wherever the
 * receiver happened to be authored — and the distance between the two is the entire
 * "inspect goes to your face" bug: turning a 0.85m rifle about a point 0.32m behind
 * its centre sweeps the barrel through a 0.32m radius arc, and the eye is inside it.
 *
 * y as well as z, because the magazine hangs well below the bore: pivoting on the bore
 * line would swing a rifle's own box out of frame as it turned.
 */
function boxOf(spec) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const p of spec.parts) {
    const sphere = p[1] === 'sphere';
    const o = sphere ? [p[3], p[4], p[5]] : [p[4], p[5], p[6]];
    const h = sphere ? [p[2], p[2], p[2]] : [p[1] * 0.5, p[2] * 0.5, p[3] * 0.5];
    x0 = Math.min(x0, o[0] - h[0]);
    x1 = Math.max(x1, o[0] + h[0]);
    y0 = Math.min(y0, o[1] - h[1]);
    y1 = Math.max(y1, o[1] + h[1]);
    z0 = Math.min(z0, o[2] - h[2]);
    z1 = Math.max(z1, o[2] + h[2]);
  }
  return { x0, x1, y0, y1, z0, z1 };
}

/**
 * How close to the eye the fist is allowed to be aimed, in metres.
 *
 * A fist is a fixed 7.6cm box, so its share of the screen is decided entirely by how far
 * away it is put, and that share grows without limit as it comes in. At the grip midpoint
 * of a pistol — 22cm from the eye, and 17 once the gun has jolted toward it — one is 0.6 of
 * the half-frame tall and 0.46 wide, against 0.54 of width to place it in. The clamp in
 * frameFist then has to pin it near the middle, so it crossed the aim line on 17 frames of
 * a 21-frame stoppage and covered exact screen centre on 13 of them.
 *
 * 42cm is the near limit of a fist that stays out of the middle: 0.31 wide instead of 0.46,
 * two crosshair frames instead of seventeen and none over the centre, the whole fist inside
 * the frame at every point of the punch, and travel 0.42 of the half-frame against 0.24.
 * It costs the gun almost nothing — 1-2% of the screen hidden by the hand, against 3-7%.
 *
 * Only the pistol and the SMG are close enough to be affected, and for the SMG it is 2cm.
 * Every other jamming weapon's receiver is already 42cm or more from the eye, so for them
 * the grip midpoint stands unchanged.
 */
const STRIKE_NEAR = 0.42;

/** Halfway between the two grips, which is where the receiver is on every two-handed rig
 *  in the table — the trigger hand is behind it and the fore-end is in front. Falls back to
 *  the rig origin for a one-handed rig, which cannot jam. */
function gripMid(spec) {
  const g = spec.grips ?? [];
  const a = g.find((gr) => gr[3] === 0);
  const b = g.find((gr) => gr[3] === 1);
  return a && b ? (a[2] + b[2]) / 2 : 0;
}

/**
 * How much of the frame's edge a fist needs to itself, as a distance at its own depth.
 *
 * Not half of any one edge of the box: the hand turns over during the punch, so the
 * silhouette is somewhere between the half-width and the half-diagonal and moves within
 * that range as it goes. Chosen by measurement rather than derived — at 0.05, the
 * half-longest-edge, the pistol's fist measured 89% inside the frame at its worst; this
 * is the value at which all seven jamming weapons hold 100% across a whole stoppage.
 */
const FIST_R = 0.062;

/**
 * Pull a camera-space point in until a fist drawn there is wholly inside the frame.
 *
 * The jam pose is solved on the SCREEN rather than on the gun because the gun will not
 * hold still. The authored stoppage jolts the weapon, pitches it 0.3rad and rolls it
 * 0.74 at each contact, and a point fixed to the receiver rides every bit of that:
 * measured on the pistol, a target 8.5cm above the slide travels 1.15 of the half-frame
 * between the wind-up and the strike from the gun's own animation alone, and ends up 1.38
 * past the bottom edge. No choice of rig-space offset fixes that, because the rig is the
 * thing that is moving.
 *
 * The limit is a width and not a point because a fist is not small: 0.19 of the half-frame
 * in radius on a sniper, 0.31 on a pistol. So the edge is inset by the footprint above.
 *
 * There is deliberately nothing here about the crosshair, and with the strike point pushed
 * out to STRIKE_NEAR nothing needs to be. The gun's own 29 degrees of jam yaw carries the
 * receiver, and the hand on it, off the aim line by 0.39 to 0.83 of the half-frame against
 * footprints of 0.19 to 0.31; measured across a whole stoppage on all seven jamming
 * weapons, the fist touches the crosshair on 2 frames of 21 and covers exact centre on
 * none. Sliding it clear on purpose was tried before and is worse than leaving it: exact
 * clearance and continuity cannot both hold (a correction that pushes the middle of the
 * screen outward has to be full strength at the boundary it is pushing to, so it either
 * jumps there or stops short), and every ramped version dragged the other weapons across
 * the screen from the side they were already safely on — one put the sniper's fist over the
 * crosshair on 13 frames it had been clear of. A stoppage is also the one time the
 * crosshair is not in use, because the trigger is dead until it clears, and the reticle is
 * a DOM overlay drawn on top of the canvas, so what is lost is the world behind it and not
 * the aim mark itself.
 */
function frameFist(p, tanX, tanY) {
  const d = Math.max(0.05, -p.z);
  const lx = Math.max(0, 1 - FIST_R / (d * tanX)) * d * tanX;
  const ly = Math.max(0, 1 - FIST_R / (d * tanY)) * d * tanY;
  p.x = Math.min(lx, Math.max(-lx, p.x));
  p.y = Math.min(ly, Math.max(-ly, p.y));
}

/** Clearance between the rearmost part and the camera plane, and how much a pose is
 *  then allowed to move the rig back toward the camera on top of that. */
const REAR_CLEAR = 0.03;
const POSE_ROOM = 0.06;

/**
 * How far to slide a rig's own parts forward so all of it clears the camera.
 *
 * Sliding the geometry rather than pushing the whole rig further away is the choice
 * that matters. Backing a rig off preserves the direction from the eye — so the weapon
 * stays where it was on screen — but it also multiplies the distance, and the sniper
 * would have had to travel 3.2× further out and would have come back a third smaller.
 * Translating the parts inside the rig leaves distance, scale and the tuned x/y
 * framing exactly as authored; the barrel simply reaches further into the view, which
 * is how every shooter's viewmodel is built in the first place.
 *
 * Zero for rigs that already clear, so short weapons are left completely alone.
 */
const shiftOf = (spec) =>
  Math.min(0, -(REAR_CLEAR + POSE_ROOM) - spec.rest[2] - rearOf(spec));

function buildRig(spec) {
  const g = new THREE.Group();
  // Applied to every part, every grip and the muzzle alike — a uniform translation of
  // the whole rig's contents, so the model is unchanged and nothing needs re-tuning.
  const dz = shiftOf(spec);
  let mag = null;
  const finishMats = [];
  for (const part of spec.parts) {
    const mat = MATS[part[0]]();
    if (part[0] === 'steel' || part[0] === 'dark' || part[0] === 'trim') {
      finishMats.push({ role: part[0], mat });
    }
    const geo =
      part[1] === 'sphere'
        ? new THREE.IcosahedronGeometry(part[2], 1) // faceted, to match the flat look
        : new THREE.BoxGeometry(part[1], part[2], part[3]);
    const mesh = new THREE.Mesh(geo, mat);
    const off = part[1] === 'sphere' ? part.slice(3) : part.slice(4);
    mesh.position.set(off[0], off[1], off[2] + dz);
    g.add(mesh);
  }
  if (spec.mag !== undefined) {
    mag = { mesh: g.children[spec.mag], base: g.children[spec.mag].position.clone() };
  }
  // Both hands are built now and swapped later. Building on demand would allocate
  // geometry during a settings change, mid-match.
  const arms = { 1: buildArms(spec, 1, dz), '-1': buildArms(spec, -1, dz) };
  arms['-1'].g.visible = false;
  g.add(arms[1].g, arms['-1'].g);

  const box = boxOf(spec);

  g.visible = false;
  return {
    g,
    mag,
    arms,
    rest: spec.rest,
    muzzle: [spec.muzzle[0], spec.muzzle[1], spec.muzzle[2] + dz],
    /** The rig's own middle, and half its extent on each axis. The inspect turns about
     *  the first and frames itself off the second. `center` carries `dz`, so it is in the
     *  same space as everything else the pose branches use; `half` is a size and does
     *  not. */
    center: [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, (box.z0 + box.z1) / 2 + dz],
    half: [(box.x1 - box.x0) / 2, (box.y1 - box.y0) / 2, (box.z1 - box.z0) / 2],
    /** Skin and sleeve materials for both handednesses, for the inspect's fade. */
    armMats: [...arms[1].mats, ...arms['-1'].mats],
    /** Approved finish channels only. Skin, sleeves, blades, brass and snow stay honest. */
    finishMats,
    /** The closest to the camera any pose may bring this rig. Every animated pose
     *  clamps against it, so a new animation cannot silently reintroduce the clipping
     *  — hand-checking each branch every time one changes is not a guarantee. */
    limitZ: -REAR_CLEAR - (rearOf(spec) + dz),
    /**
     * Where the support hand pounds this weapon to clear a stoppage, in rig-local space.
     *
     * The jam gesture used to be written as offsets in metres from wherever the support
     * hand happened to grip, which is why it could not work: the same offsets mean a
     * different thing on a rifle whose fore-end is 66cm from the eye and a pistol whose
     * off hand is on the grip 22cm away, and both of those are only loosely related to
     * where the receiver actually is. Aiming at a point ON THE WEAPON instead makes the
     * gesture correct on every rig for free — the fist lands on the gun because the gun
     * is what it is aimed at.
     *
     * Laterally centred, clear of the top of the whole rig, and midway between the two
     * grips in depth. Two of those three are worth their comments:
     *
     * The grip midpoint is the depth anchor because that is where a receiver is on every
     * two-handed rig in the table — the trigger hand behind it, the fore-end in front
     * — and because it is derived from points the spec already declares rather than from
     * a fraction of the barrel. Both of its neighbours were tried and are worse. A fraction
     * of the muzzle put the anchor 17cm further out on the handguard, and the gesture
     * happens under 29 degrees of the gun's own yaw, which throws a point sideways in
     * proportion to how far in FRONT of the origin it sits: that pushed the sniper's fist
     * half off the left edge. The trigger grip alone went too far the other way. It brought
     * the hand back level with the origin, and the forearm hanging off it — 33cm of it,
     * running back past the eye — swept across the whole frame, covering all of it on 31
     * frames of a stoppage.
     *
     * The height clears the whole rig, not the receiver alone: on a scoped weapon the
     * receiver top is under the optic, so a fist placed there would be hidden by it —
     * which defeats the only purpose this point has, which is being seen.
     *
     * Then the depth is pushed forward if it has to be, to keep the fist from being aimed
     * closer to the eye than STRIKE_NEAR, and pulled back if that would take it past the
     * muzzle. Only the pistol needs either: its receiver is close enough that a fist there
     * is bigger than the room the frame has for it. Four centimetres forward along the
     * slide is still the top of the gun and still under the off hand.
     */
    strike: [
      (box.x0 + box.x1) / 2,
      box.y1 + FIST[1] * 0.5,
      Math.max(
        spec.muzzle[2] + dz,
        Math.min(gripMid(spec) + dz, -STRIKE_NEAR - spec.rest[2]),
      ),
    ],
    /**
     * The meshes that make up a thrown object, or null for anything you keep hold of.
     *
     * On a throw rig every part IS the projectile — a grenade is a sphere and a cap,
     * there is no weapon under it — so the whole part list is the thing that has to
     * disappear at release. The arms are separate children added after the parts, which
     * is what makes the slice safe and is why the hand can follow through empty.
     */
    throwBody: spec.anim === 'throw' ? g.children.slice(0, spec.parts.length) : null,
  };
}

/**
 * @param camera the world camera. Read only, and only to map the muzzle into world
 *   space for tracers — the weapon itself no longer hangs off it.
 * @param scene  the world scene, where tracers and smoke live: they must stay where
 *   they were fired as the view moves.
 * @param vmRoot the viewmodel scene's camera, which sits at the origin unrotated so
 *   that scene *is* camera space. Rig offsets go in unchanged, but with a 0.002 near
 *   plane and a depth buffer of its own — see the pass in render.js.
 * @param hooks  `onDraw(id, weight)` fires the moment a swapped-to weapon becomes
 *   visible, which is where its sound belongs. `onCycle(id, weight, backInMs, homeInMs)`
 *   fires on the shot of a weapon that has to be worked between rounds, carrying the
 *   delay to each half of the stroke — the bolt going back and the bolt going home.
 *   Callbacks rather than an audio import because the viewmodel has no
 *   business knowing what a speaker is, and the timing is internal to the animation —
 *   nothing outside can know when the hands change over.
 */
export function createViewmodel(camera, scene, vmRoot, hooks = {}) {
  // `hand` carries the mirroring and the walk bob; each weapon rig hangs off it and
  // carries only its own rest pose and recoil.
  const hand = new THREE.Group();
  vmRoot.add(hand);

  const rigs = new Map();
  for (const id of WEAPON_IDS) {
    const spec = RIGS[id];
    if (!spec) continue;
    const built = buildRig(spec);
    hand.add(built.g);
    rigs.set(id, { ...built, spec });
  }

  let finishId = DEFAULT_FINISH;
  function applyFinish(id) {
    const normalized = sanitizeCosmetics({ finish: id }).finish ?? DEFAULT_FINISH;
    if (finishId === normalized && id !== undefined) return;
    finishId = normalized;
    const finish = finishOf(normalized);
    for (const rig of rigs.values()) {
      for (const { role, mat } of rig.finishMats) mat.color.setHex(finish[role]);
    }
  }
  applyFinish(DEFAULT_FINISH);

  const flash = new THREE.PointLight(0xffd9a0, 0, 8, 2);
  hand.add(flash);

  // A second flash, in the world. The one above is inside the viewmodel scene and so
  // lights only the weapon; without this, moving the gun to its own pass would have
  // quietly stopped muzzle flashes from lighting the wall you are standing next to.
  const worldFlash = new THREE.PointLight(0xffd9a0, 0, 9, 2);
  scene.add(worldFlash);

  // Tracers and smoke live in world space, not on the camera — they must stay where
  // they were fired as the view moves.
  const tracers = [];
  const beamGeo = new THREE.BoxGeometry(1, 1, 1);
  for (let i = 0; i < TRACER_COUNT; i++) {
    // Unlit: a tracer is a light source, so shading it would make it darker than
    // the wall behind it. Scaled to length on use, hence the unit box.
    const mat = new THREE.MeshBasicMaterial({ color: 0xffb03a, transparent: true, opacity: 0 });
    const mesh = new THREE.Mesh(beamGeo, mat);
    mesh.frustumCulled = false;
    mesh.visible = false;
    scene.add(mesh);
    tracers.push({ mesh, mat, until: 0 });
  }
  let cursor = 0;

  // Smoke: low-poly spheres, unlit, drifting up and swelling as they fade. Reused
  // from a ring buffer so a sustained rifle burst never allocates.
  const puffGeo = new THREE.IcosahedronGeometry(1, 0);
  const puffs = [];
  for (let i = 0; i < PUFF_COUNT; i++) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xccd4de, transparent: true, opacity: 0 });
    const mesh = new THREE.Mesh(puffGeo, mat);
    mesh.frustumCulled = false;
    mesh.visible = false;
    scene.add(mesh);
    puffs.push({ mesh, mat, until: 0, born: 0, grow: 0 });
  }
  let puffCursor = 0;

  // Shell casings. Small brass boxes in the world scene, thrown out of the port under
  // gravity and tumbling. Pooled like everything else here, so a hundred-round belt
  // never allocates.
  const caseGeo = new THREE.BoxGeometry(0.014, 0.014, 0.038);
  const cases = [];
  for (let i = 0; i < CASE_COUNT; i++) {
    // Lambert rather than basic: a case is a lit object and has to catch the light, or
    // it reads as a flat yellow rectangle rather than as brass.
    const mat = new THREE.MeshLambertMaterial({
      color: 0xc9a227,
      flatShading: true,
      transparent: true,
      opacity: 0,
    });
    const mesh = new THREE.Mesh(caseGeo, mat);
    mesh.frustumCulled = false;
    mesh.visible = false;
    scene.add(mesh);
    cases.push({ mesh, mat, vx: 0, vy: 0, vz: 0, spin: 0, until: 0, born: 0 });
  }
  let caseCursor = 0;

  let side = 1; // +1 right-handed, -1 left
  let current = null; // { g, mag, arms, rest, muzzle, limitZ, spec }
  let currentId = null;
  let kick = 0;
  let kickVel = 0;
  let sway = 0;
  /** 0..1 blend into the sprint carry. See sprintCarry() for what it drives. */
  let sprintK = 0;
  /** When the last shot went off, so the carry can get out of its way. A timestamp
   *  rather than a countdown because `fire()` is an edge and update() has a clock —
   *  and because the window it is compared against is the weapon's, not a constant,
   *  so it has to be resolved at read time and not at the shot. */
  let fireAt = -1e9;
  /** 0..1 blend on the held weapon's OWN right-click verb. Zero for a weapon that
   *  has no `alt` at all, which is why a knife no longer reacts to right-click. */
  let altK = 0;
  /** Is the glass up: 1 or 0, and never anything in between. Shaped like `altK` and
   *  named like a blend because it used to be one — see where it is assigned for why an
   *  eased scope and a stepped sensitivity made the sniper unplayable. */
  let scopeK = 0;
  /**
   * The scope's field of view, in degrees. Absolute, not a fraction.
   *
   * Held apart from `scopeK` because a double scope has TWO narrow fields of view and
   * one 0..1 blend cannot express both: stepping from the first zoom to the second
   * happens while `scopeK` is pinned at 1, so if the FOV rode on `scopeK` alone the
   * second click would do nothing at all. This one says WHICH zoom; `scopeK` says whether
   * we are at one. Both are now snapped rather than eased, so a step is a step.
   */
  let zoomFovK = 0;
  let swing = -1; // -1 idle, else 0..1 through a slash or throw
  /** True when the running swing is the heavy variant — a wider, slower arc. */
  let swingHeavy = false;
  /** Which way the next light slash cuts, ±1, flipped on every swing. CS2's knife
   *  alternates; a knife that always cuts the same way reads as one frame played over
   *  and over when you mash the button. */
  let slashDir = 1;
  /** Swap progress, 0..1 across SWITCH_MS, or -1 when nothing is changing hands.
   *  Holstering below HOLSTER_FRAC, drawing above it. */
  let swapT = -1;
  /** Weapon waiting to come up, or null once it has. Held rather than shown
   *  immediately: the point of the animation is that the old weapon goes away first. */
  let pendingId = null;
  let inspectT = -1; // -1 idle, else 0..1 through the inspect flourish
  /** F held. The inspect loops while this is true instead of playing once: holding a
   *  key and having the animation quit under you was the complaint. */
  let inspectHold = false;
  /** Reload progress, 0..1, or -1 when not reloading. Driven by the server's
   *  remaining-time figure rather than a local timer, so the animation cannot finish
   *  before the magazine actually does. */
  let reloadP = -1;
  /** Jam-clearing progress, 0..1, or -1 when the weapon in hand is not jammed. Driven
   *  off the server's countdown for exactly the reason `reloadP` is: the stoppage is a
   *  server gate, and a local timer would let the hands finish hitting a gun the server
   *  still refuses to fire — or worse, stop early and leave you holding a weapon that
   *  looks fixed and is not. */
  let jamP = -1;
  /**
   * Bolt-cycle progress, 0..1 across the weapon's `cycleMs`, or -1 when nothing is
   * being worked. Local, unlike the reload and the jam, and that is safe rather than
   * sloppy: this is not a server gate — the server's own `intervalMs` already refuses
   * the next round, and `cycleMs` is asserted at import to be at most 80% of it, so the
   * stroke provably finishes before the trigger comes back either way.
   *
   * "the sniper why it has only reload ... you dont reload each time it shots but you
   * cocking the gun thats the missing for sniper each shot". A bolt gun's shot is two
   * events, and only the first one was on screen.
   */
  let cycleT = -1;
  /** Current arm opacity, so the fade only touches materials on the frames it changes
   *  — switching a material's blend mode recompiles its shader. */
  let armFade = 1;
  /** Last frame timestamp, so an event-driven call that has no clock of its own — an
   *  ejected case needs a birthday — can borrow one instead of reading a second clock. */
  let lastNow = 0;

  function show(id) {
    const next = rigs.get(id);
    if (!next || next === current) return;
    if (current) {
      current.g.visible = false;
      restoreRig(current);
      setArmFade(1);
    }
    current = next;
    currentId = id;
    current.g.visible = true;
    applyHand();
    // The flash is re-parented rather than repositioned: as a child of the rig it
    // sits at the muzzle in rig-local space and inherits recoil for free. Parented
    // to `hand` it would have needed rest+muzzle recomputed on every swap and would
    // still not have moved with the kick.
    const m = current.muzzle;
    current.g.add(flash);
    flash.position.set(m[0], m[1], m[2]);
    // A swap interrupts recoil, the swing, the inspect and a half-worked action rather
    // than inheriting them — otherwise the new weapon appears already mid-animation.
    kick = 0;
    kickVel = 0;
    swing = -1;
    inspectT = -1;
    cycleT = -1;
    altK = 0;
  }

  /**
   * Fade the forearms and fists, for the inspect.
   *
   * The arms are FOREARMS ONLY — the upper arm is deliberately off-screen behind the
   * camera (see SHOULDER), which is what makes them read as arms at rest: they run out
   * of the bottom corners of the frame and the near plane hides the fact that they stop.
   * The inspect breaks that. It takes the weapon — and the hands welded to it — out of
   * the corner and turns it broadside in the middle of the view, where a 0.43m stub
   * pointing off across the screen is exactly as disconnected as it actually is.
   *
   * So they go with the presentation and come back with it. The alternative was to keep
   * the weapon near the corner, and that is the thing the player asked us to stop doing.
   */
  function setArmFade(o) {
    if (armFade === o || !current) return;
    armFade = o;
    for (const m of current.armMats) {
      const blend = o < 1;
      if (m.transparent !== blend) {
        m.transparent = blend;
        m.depthWrite = !blend;
        m.needsUpdate = true;
      }
      m.opacity = o;
    }
  }

  /**
   * Ask for a weapon. Unlike `show`, the current one is put away first.
   *
   * Called every frame with whatever the player is holding, so the early-outs matter:
   * the target is the weapon we are *heading for*, which is the pending one mid-swap
   * and the current one otherwise.
   */
  function request(id) {
    if (!rigs.has(id)) return;
    if (id === (pendingId ?? currentId)) return;
    if (id === currentId) {
      // Changed your mind mid-holster. Bring the same weapon back up from wherever it
      // has got to rather than stowing it fully and drawing it again — the second half
      // of the animation already does exactly that motion, so jump into it at the
      // matching height.
      pendingId = null;
      if (swapT >= 0 && swapT < HOLSTER_FRAC) {
        const stowed = smooth(seg(swapT, 0, HOLSTER_FRAC));
        swapT = HOLSTER_FRAC + (1 - HOLSTER_FRAC) * (1 - stowed);
      }
      return;
    }
    pendingId = id;
    // Already holstering: keep going and just change what comes up at the end. Only a
    // swap that starts from rest — or from a draw we are cutting short — restarts.
    if (swapT < 0 || swapT >= HOLSTER_FRAC) swapT = 0;
  }

  /** Rough heft, for the draw sound. Derived from recoil rather than declared twice:
   *  the weapons that kick are the heavy ones. */
  function weightOf(rig) {
    return Math.max(0.4, Math.min(1.6, (rig?.spec.kick ?? 5) / 5));
  }

  function applyHand() {
    if (!current) return;
    current.arms[1].g.visible = side === 1;
    current.arms['-1'].g.visible = side === -1;
  }

  /** Undo everything an animation moved *inside* the rig. The rig's own transform is
   *  rewritten every frame so it needs no reset, but the magazine and the support hand
   *  are parts, and a weapon put away mid-reload would otherwise stay dismantled. */
  function restoreRig(rig) {
    if (!rig) return;
    if (rig.mag) {
      rig.mag.mesh.position.copy(rig.mag.base);
      rig.mag.mesh.rotation.set(0, 0, 0);
      rig.mag.mesh.visible = true;
    }
    for (const key of [1, -1]) {
      const h = rig.arms[key].hands[1];
      if (h) {
        h.position.set(0, 0, 0);
        h.rotation.set(0, 0, 0);
      }
    }
  }

  /**
   * World-space muzzle position. The offset is rig-local, so the hand mirror is
   * already baked into the rig's transform and must not be applied a second time.
   *
   * Two hops now that the weapon lives in its own scene: rig space → viewmodel space
   * (which *is* camera space, the vm camera being at the origin unrotated), then
   * camera space → world. Both matrices are refreshed explicitly rather than trusted —
   * the viewmodel scene's are only updated by its own render pass, so a caller asking
   * before that pass would otherwise get last frame's muzzle.
   */
  function muzzleWorld(out) {
    camera.updateWorldMatrix(true, false);
    if (!current) return out.setFromMatrixPosition(camera.matrixWorld);
    const m = current.muzzle;
    out.set(m[0], m[1], m[2]);
    current.g.updateWorldMatrix(true, false);
    out.applyMatrix4(current.g.matrixWorld);
    return out.applyMatrix4(camera.matrixWorld);
  }

  /** Scratch for the jam pose: the wrist it pivots the hand about, the camera-space
   *  points the fist starts from and is aimed at, and the rig rotation that carries it
   *  between the two spaces. Allocated once — they are touched on every frame of a
   *  stoppage, and one stoppage lasts JAM_CLEAR_MS. */
  const jamPivot = new THREE.Vector3();
  const jamRest = new THREE.Vector3();
  const jamAim = new THREE.Vector3();
  const jamBack = new THREE.Vector3();
  const jamRot = new THREE.Quaternion();

  // Scratch vectors for the ejection, allocated once. `eject` runs on every round of
  // automatic fire and must not produce garbage.
  const ejPos = new THREE.Vector3();
  const ejRight = new THREE.Vector3();
  const ejUp = new THREE.Vector3();
  const ejFwd = new THREE.Vector3();

  /**
   * Throw a spent case out of the ejection port.
   *
   * The port is expressed in rig-local space and mapped out through the same two matrix
   * hops as the muzzle, so it inherits the recoil, the sway and the hand mirror for free
   * — the case leaves from wherever the gun actually is on the frame it fired, not from
   * a fixed point in front of the camera.
   *
   * Direction is built from the world camera's own axes rather than from the rig, so a
   * case always leaves to the shooter's right regardless of how the weapon is posed, and
   * mirrors with the hand for a left-handed player.
   */
  function eject(now) {
    if (!current) return;
    camera.updateWorldMatrix(true, false);
    current.g.updateWorldMatrix(true, false);
    const m = current.muzzle;
    // Back from the muzzle toward the breech, and out to the side of the receiver. A
    // third of the way down the barrel is where a port sits on every rig in the table.
    ejPos.set(m[0] + 0.03 * side, m[1] + 0.012, m[2] * 0.34);
    ejPos.applyMatrix4(current.g.matrixWorld).applyMatrix4(camera.matrixWorld);

    const e = camera.matrixWorld.elements;
    ejRight.set(e[0], e[1], e[2]).normalize();
    ejUp.set(e[4], e[5], e[6]).normalize();
    ejFwd.set(-e[8], -e[9], -e[10]).normalize();

    caseCursor = (caseCursor + 1) % cases.length;
    const c = cases[caseCursor];
    const jitter = () => (Math.random() - 0.5) * 0.55;
    // Right and up dominate; a touch backward, because a case clears the port and then
    // falls behind the shooter rather than travelling with the bullet.
    const vx = (1.15 + jitter() * 0.4) * side;
    const vy = 0.85 + jitter() * 0.3;
    const vz = -0.35 + jitter() * 0.3;
    c.vx = (ejRight.x * vx + ejUp.x * vy + ejFwd.x * vz) * CASE_SPEED;
    c.vy = (ejRight.y * vx + ejUp.y * vy + ejFwd.y * vz) * CASE_SPEED;
    c.vz = (ejRight.z * vx + ejUp.z * vy + ejFwd.z * vz) * CASE_SPEED;
    c.mesh.position.copy(ejPos);
    c.mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    c.spin = 11 + Math.random() * 16;
    c.mesh.visible = true;
    c.mat.opacity = 1;
    c.born = now;
    c.until = now + CASE_MS;
  }

  show('rifle');

  return {
    /** @param idx weapon index, as carried on the wire. */
    setWeapon(idx) {
      request(idAt(idx));
    },

    /** An approved catalog id; unknown requests visibly fall back to standard issue. */
    setFinish(id) {
      applyFinish(id);
    },

    /** 'left' | 'right'. Applies immediately, mid-match. */
    setHand(h) {
      side = h === 'left' ? -1 : 1;
      applyHand();
    },

    /**
     * Hide the weapon without stopping anything.
     *
     * For the death drop. The viewmodel renders in its own pass through a camera fixed
     * at the origin, so it does not inherit the world camera's transform — while the
     * body falls and the view rolls over, the gun would sit perfectly level in front of
     * a tipping horizon, which reads as the map falling rather than as you falling.
     * Hands go away with it, which is also right: a corpse is not holding anything.
     *
     * Only the `hand` group is hidden, not the module. Tracers and smoke are children of
     * the WORLD scene and keep running, so rounds fired at you as you go down still land
     * where they were fired.
     */
    setHidden(on) {
      hand.visible = !on;
    },

    /**
     * Whether F is down, pushed every frame rather than pulsed on the press.
     *
     * The inspect used to be started by a one-shot edge, so it ran its 1.5 s and quit
     * whether or not you were still holding the key — "even if you hold F it just stop
     * inspecting". Holding is now the state that keeps it running, and where it stops is
     * INSPECT_HOLD_AT rather than the end of the animation.
     *
     * The press EDGE is still needed, and derived here rather than plumbed in: a fresh
     * press always restarts the animation from zero, which is the spam interrupt — "you
     * can spa F like intercepting the inspect". Without the edge, a second press during
     * an inspect did nothing at all, so mashing F looked identical to holding it.
     */
    setInspect(down) {
      const pressed = down && !inspectHold;
      inspectHold = down;
      if (!pressed || !current) return;
      // Anything that owns the hands wins. A restart here would drop a half-seated
      // magazine, abandon a swing mid-arc, or leave a bolt standing open.
      if (reloadP >= 0 || jamP >= 0 || swing >= 0 || swapT >= 0 || cycleT >= 0) return;
      inspectT = 0;
    },

    fire(heavy = false, now = lastNow) {
      if (!current) return;
      inspectT = -1; // shooting always wins
      // "unless i am shooting". Stamped for every local shot, melee and thrown included:
      // a swing needs the weapon out of the carry exactly as much as a burst does.
      fireAt = now;
      // Melee and thrown weapons play a scripted arc; guns get spring recoil and a
      // muzzle flash. Restarting the arc from 0 means rapid clicks re-swing rather
      // than freezing part-way through.
      if (current.spec.anim) {
        // Flipped before the swing rather than after it, so the first cut of a fresh
        // knife is not always the same one.
        if (current.spec.anim === 'slash' && !heavy) slashDir = -slashDir;
        swing = 0;
        swingHeavy = heavy && hasHeavy(currentId);
      } else {
        kickVel += current.spec.kick;
        flash.intensity = 3.4;
        // A weapon that has to be worked between rounds starts its stroke here, on the
        // shot, rather than being polled out of some state elsewhere: the shot IS the
        // trigger, and an edge is the only place a one-shot gesture can hang off.
        const cyc = cycleMsOf(currentId);
        if (cyc > 0) {
          cycleT = 0;
          // Scheduled with both its delays in one call, for the reason `draw()` and
          // `jam()` both are: the sounds belong to the two ends of the stroke, and a
          // trigger fired from inside the pose branch would drift off them on any frame
          // the animation is not sampled — which is every frame at a low frame rate.
          hooks.onCycle?.(currentId, weightOf(current), cyc * CYCLE_AT[0], cyc * CYCLE_AT[1]);
        }
        // Every round chambered throws its case. `now` comes from the SHOT event that
        // fired it, falling back to the last frame time so a call without one still gets
        // a sane birthday rather than zero.
        eject(now);
      }
    },

    /** Both local and remote shots draw a beam and a trail of smoke along the path. */
    tracer(from, to, now) {
      cursor = (cursor + 1) % TRACER_COUNT;
      const t = tracers[cursor];
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dz = to.z - from.z;
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-3) return;

      // Stretch the unit box along the shot: midpoint, then aim +z down the path.
      t.mesh.position.set(from.x + dx * 0.5, from.y + dy * 0.5, from.z + dz * 0.5);
      t.mesh.lookAt(to.x, to.y, to.z);
      t.mesh.scale.set(0.035, 0.035, len);
      t.mesh.visible = true;
      t.mat.opacity = 0.95;
      t.until = now + TRACER_MS;

      // Smoke along the path. Spaced evenly and jittered off-axis so the trail has
      // some width instead of reading as a dotted line, and skipping the first
      // fraction keeps puffs from being spawned inside the player's own head.
      for (let i = 0; i < PUFFS_PER_SHOT; i++) {
        puffCursor = (puffCursor + 1) % PUFF_COUNT;
        const p = puffs[puffCursor];
        const f = 0.08 + (i / PUFFS_PER_SHOT) * 0.92;
        const j = 0.05;
        p.mesh.position.set(
          from.x + dx * f + (Math.random() - 0.5) * j,
          from.y + dy * f + (Math.random() - 0.5) * j,
          from.z + dz * f + (Math.random() - 0.5) * j,
        );
        // Puffs nearer the muzzle start smaller and grow more, so the trail tapers
        // outward the way a real one does.
        p.grow = 0.06 + f * 0.16;
        p.mesh.scale.setScalar(p.grow * 0.35);
        p.mesh.visible = true;
        p.born = now;
        p.until = now + PUFF_MS;
        p.mat.opacity = 0.5;
      }
    },

    /**
     * @param altHeld  right mouse, raw. What it does is the weapon's business.
     * @param reloadMs milliseconds of reload remaining, 0 when not reloading.
     * @param crouch   0..1 crouch blend, so the weapon settles with the body.
     * @param sprinting straight off the shared step that decided it — see
     *   movement.js's `s.sprinting`. Not re-derived from `speed` here, because speed
     *   cannot tell a sprint from a run down a slope and cannot see the two frames where
     *   the bar runs flat with the key still held.
     * @param scopeStep which zoom a scoped weapon is LATCHED at — 0 unscoped, 1 first,
     *   2 second. A scope is a click-toggle rather than a held button, so it cannot be
     *   read off `altHeld`; a lob and a heavy stab still are, which is why both arrive.
     */
    update(dtMs, now, speed, altHeld, reloadMs = 0, crouch = 0, scopeStep = 0, jamMs = 0,
           sprinting = false) {
      // A frame is a duration and durations do not run backwards. Clamped here as well as
      // at the caller, because of what one negative frame did the last time: `swapT` is
      // "no swap in progress" when it is negative, so a single backwards step during the
      // opening swap parked it below zero — where nothing advances it and `request` will
      // not restart it, since the weapon you asked for is already the pending one. The
      // rest of the match was played holding a weapon you had put away on frame one.
      //
      // Every animation below is a progress value advanced by this number, so one clamp
      // here is what makes all of them monotonic. A rig that has gone missing is not a
      // failure any player can report usefully — it just looks like the wrong gun.
      const step = Math.max(0, dtMs);
      const dt = Math.min(step, 50) / 1000;
      lastNow = now;

      // Spent cases: integrated rather than tweened, because a case reads as brass by
      // the way it leaves fast, arcs, drops and rattles to a stop. Fade over the last
      // third of the life so they thin out instead of blinking off the floor.
      for (const c of cases) {
        if (!c.until) continue;
        if (now >= c.until) {
          c.mesh.visible = false;
          c.mat.opacity = 0;
          c.until = 0;
          continue;
        }
        c.vy -= CASE_G * dt;
        c.mesh.position.x += c.vx * dt;
        c.mesh.position.y += c.vy * dt;
        c.mesh.position.z += c.vz * dt;
        c.mesh.rotation.x += c.spin * dt;
        c.mesh.rotation.z += c.spin * dt * 0.6;
        // Floor. Without it a case is still fully opaque at 1.7s and by then it is tens
        // of metres under the map — you would watch brass sink through the ground. One
        // damped bounce and it lies there for the rest of its life, which is what a case
        // does and what makes the pile at your feet during a spray read as spent rounds.
        if (c.mesh.position.y <= CASE_REST) {
          c.mesh.position.y = CASE_REST;
          if (c.vy < -CASE_STOP) {
            c.vy *= -CASE_BOUNCE;
            c.vx *= CASE_FRICTION;
            c.vz *= CASE_FRICTION;
            c.spin *= CASE_FRICTION;
          } else {
            c.vx = 0;
            c.vy = 0;
            c.vz = 0;
            c.spin = 0;
          }
        }
        const a = (now - c.born) / CASE_MS;
        c.mat.opacity = a < 0.66 ? 1 : (1 - a) / 0.34;
      }

      // Damped spring back to rest.
      kickVel += (-kick * 260 - kickVel * 22) * dt;
      kick += kickVel * dt;

      if (swing >= 0) {
        swing += step / (swingHeavy ? HEAVY_SWING_MS : SWING_MS);
        if (swing >= 1) swing = -1;
      }
      // The bolt stroke. Advanced on its own clock — see `cycleT` — and cleared through
      // `restoreRig` because the branch moves the support hand off the fore-end, and a
      // hand left mid-stroke would stay there for the rest of the life.
      if (cycleT >= 0) {
        cycleT += step / Math.max(1, cycleMsOf(currentId));
        if (cycleT >= 1) {
          cycleT = -1;
          restoreRig(current);
        }
      }
      // The swap, advanced before anything reads it. The hand-over happens exactly at
      // HOLSTER_FRAC: the old rig is at the bottom of its travel there, so swapping
      // which mesh is visible at that instant is invisible, and the draw half of the
      // curve then lifts the new one up from the same place.
      if (swapT >= 0) {
        // Scaled by the INCOMING weapon's deploy time, matching the server's
        // `switchUntil` exactly. Read off `pendingId` while the old weapon is still on
        // screen and off `currentId` once the hand-over has happened, which are the same
        // weapon either side of HOLSTER_FRAC — so the rate does not change mid-swap.
        swapT += step / switchMsOf(pendingId ?? currentId);
        if (pendingId && swapT >= HOLSTER_FRAC) {
          show(pendingId);
          pendingId = null;
          // The cock's sound is scheduled from here rather than fired at the beat,
          // because the beat is inside a pose branch that runs every frame — it has no
          // edge to hang a one-shot on, and testing `pull` against a threshold would
          // retrigger on the way back down. `onDraw` happens exactly once per swap, so
          // the delay from here to the middle of the stroke is handed over with it.
          const mid = (COCK_AT[0] + COCK_AT[1]) / 2 - HOLSTER_FRAC;
          hooks.onDraw?.(
            currentId,
            weightOf(current),
            current.spec.melee ? 0 : switchMsOf(currentId) * mid,
          );
        }
        if (swapT >= 1) swapT = -1;
      }
      if (inspectT >= 0) {
        // Three behaviours off one progress value, which is the whole of ask #15.
        //
        // HOLD parks the animation at INSPECT_HOLD_AT and leaves it there: "when you hold
        // F it should stay on you looking on your gun like cs2 ... you can just see its
        // sideview to see the design of the gun". It used to LOOP instead — reaching 1
        // and starting over — which is a different thing entirely and the reason the
        // report exists: a loop spends most of its time rotating, so the one pose you
        // actually wanted to look at was the one it kept leaving.
        //
        // TAP runs straight through to 1 and stops, because a key released before the
        // park point never reaches it.
        //
        // RELEASING out of the park resumes from where it stopped rather than snapping
        // home, so the weapon unwinds the way it came in.
        if (inspectHold) {
          inspectT = Math.min(INSPECT_HOLD_AT, inspectT + step / INSPECT_MS);
        } else {
          inspectT += step / INSPECT_MS;
          if (inspectT >= 1) inspectT = -1;
        }
      }

      // Reload progress comes from the server's countdown, not a local clock: the
      // reload IS a server timer, and animating off a second one would let the two
      // disagree about when you get your magazine back.
      const total = WEAPONS[currentId]?.reloadMs ?? 0;
      const wasReloading = reloadP >= 0;
      reloadP = reloadMs > 0 && total > 0 ? Math.min(1, 1 - reloadMs / total) : -1;
      // A reload takes the hands off whatever else they were doing. Both of these get
      // put back by the `restoreRig` on the reload's own way out, so dropping them here
      // cannot leave a hand parked mid-gesture.
      if (reloadP >= 0) {
        inspectT = -1;
        cycleT = -1;
      }
      if (wasReloading && reloadP < 0) restoreRig(current);

      // Jam progress, from the server's countdown for the same reason. Restored on the
      // way out like the reload is, because this animation also moves the support hand
      // and a hand left mid-punch would stay there for the rest of the life.
      const wasJammed = jamP >= 0;
      jamP = jamMs > 0 ? Math.min(1, 1 - jamMs / JAM_CLEAR_MS) : -1;
      // You cannot admire a weapon you are hitting. A jam outranks the inspect and the
      // swing for the same reason a reload does — it is the thing the hands are busy with.
      if (jamP >= 0) {
        inspectT = -1;
        swing = -1;
        cycleT = -1;
      }
      if (wasJammed && jamP < 0) restoreRig(current);

      // Right-click. `alt` is per-weapon and its absence is the point: a weapon with
      // no alt gets no blend, so it does not drift to the centre of the screen, does
      // not zoom, and does not slow the mouse. That used to be unconditional, which
      // is how a knife ended up with a scope.
      //
      // Where "is it up" comes from now depends on the verb. A scope is LATCHED — one
      // click opens it, the next steps it down, the next puts it away, and nothing is
      // held; that was the complaint ("you have to hold cmon bruh"). A lob and a heavy
      // stab genuinely are held buttons and still read the raw mouse.
      const alt = WEAPONS[currentId]?.alt ?? null;
      const steps = zoomStepsOf(currentId);
      const scopedStep = alt === 'scope' ? Math.min(scopeStep, steps.length) : 0;
      const up = alt === 'scope' ? scopedStep > 0 : altHeld;
      // A reload and a stoppage both take the hands off the alt, so neither can hold a
      // pose that needs them. The jam term is belt-and-braces against the latch in
      // input.js — which is what actually drops the zoom — but it is not free: the alt
      // blend is also what hides a scoped weapon, so without it a stoppage that began
      // unscoped could still be scoped INTO and vanish mid-punch.
      const wantAlt = up && alt && reloadP < 0 && jamP < 0 ? 1 : 0;
      // Exponential so it is fast to start and settles — a linear ramp reads as
      // mechanical at this duration.
      altK += (wantAlt - altK) * Math.min(1, dt * 13);
      // Three verbs, three poses, and they share nothing but the blend.
      //   adsK   — shoulder the weapon and look down it. Centres, zooms, steadies.
      //   lobK   — an underhand ready. Stays exactly where the weapon already is.
      //   heavyK — a wind-up. Draws the blade back and cocks the wrist, so the player
      //            can see the commitment they are paying for before it lands.
      const adsK = alt === 'scope' ? altK : 0;
      const lobK = alt === 'lob' ? altK : 0;
      const heavyK = alt === 'heavy' ? altK : 0;
      // Only a weapon that actually zooms gets a scope overlay; aiming a pistol must
      // not black out the screen.
      //
      // INSTANT, and not `altK`, which is the single biggest reason the sniper was
      // "crazy hard to play". The overlay and the FOV used to ride the same 13/s ease as
      // the pose — about 230ms to settle — while MOUSE SENSITIVITY is a step function on
      // the latch (see client/src/input.js): it drops to `zoomSens` on the frame of the
      // click. So scoping in zoomed the picture underneath a cursor that had already
      // slowed, and unscoping was worse in the other direction: the latch cleared, gain
      // jumped straight back to 1x, and the view was still magnified for a fifth of a
      // second — a violent whip on every single shot, right at the moment the player was
      // trying to look at what they had just hit.
      //
      // CS2's scope is instantaneous. Snapping the two values that the sensitivity has to
      // agree with is what puts the gain and the magnification on the same frame, and it
      // is what makes a quick-scope a thing a hand can actually do. The POSE still eases
      // on `altK` below, and that costs nothing: `g.visible = scopeK < 0.5` hides the
      // weapon the instant the glass is up, so the only frames where the eased pose is on
      // screen are the ones on the way out, where it reads as the gun coming down off the
      // shoulder — which is exactly what it is.
      scopeK = scopes(currentId) ? wantAlt : 0;

      // Which of the scope's zooms we are at. Snapped for the same reason and to the same
      // frame, so the second click of a double scope is also instant rather than a
      // 230ms crawl inward with the sensitivity already at the far zoom's gain.
      if (scopedStep > 0) {
        zoomFovK = steps[scopedStep - 1];
      } else {
        // Fully out, and there is no longer any ease to protect: `scopeK` is already 0 on
        // this frame, so the remembered zoom can be cleared immediately and the next scope
        // starts from its own first step rather than from the last weapon's second.
        zoomFovK = 0;
      }

      // Named `walk` for the walk/run/still range it was written for; a sprint pushes it
      // just past 1, which is the point. Both the amplitude below and the `sway` frequency
      // on the next line read it, so the bob gets faster as well as bigger. The recovered
      // range is small and honest about it: a settled run sits at 0.90 and a settled sprint
      // at 1.02, so the old clamp was already passing most of the increase — what it did was
      // saturate at exactly the moment sprint engages, flattening the one transition the bob
      // exists to sell. Ceiling at SPRINT_SPEED_MUL rather than removing it, so a launch
      // cannot swing the gun off screen.
      const walk = Math.min(C.SPRINT_SPEED_MUL, speed / C.MOVE_SPEED);
      sway += step * 0.0075 * walk;
      // Bob is suppressed while shouldered, for the same reason the mouse slows down.
      // A lob does not suppress it — you are not steadying anything.
      const bobScale = 1 - adsK * 0.85;
      const bobX = Math.cos(sway) * 0.005 * walk * bobScale;
      const bobY = Math.abs(Math.sin(sway)) * 0.006 * walk * bobScale;

      // ---- into and out of the sprint carry -----------------------------------
      // Everything that owns the hands outranks it. Not for tidiness: the carry is a
      // 24-degree roll added to whatever pose is running, and added to a reload it would
      // seat a magazine sideways, added to a bolt stroke it would work the handle across
      // the body, and added to a swing it would cut at the floor. A gesture is what the
      // hands are doing; sprinting is what the legs are doing, and only the second one
      // gets to color the at-rest pose.
      const handsBusy = swapT >= 0 || reloadP >= 0 || jamP >= 0 || cycleT >= 0
        || inspectT >= 0 || swing >= 0;
      // The weapon's own cadence plus a tail — see SPRINT_FIRE_TAIL.
      const fireHold = Math.min(SPRINT_FIRE_MAX,
        (WEAPONS[currentId]?.intervalMs ?? 0) + SPRINT_FIRE_TAIL);
      // `wantAlt`, not `altK`: gating on the blend would leave the carry easing IN while
      // the alt pose is still easing out, and the two are additive — you would spend
      // 150ms holding a hybrid of a canted run and a shouldered aim, which is neither.
      // The (1 - altK) factor below is the same decision from the other end, so the
      // handover is monotonic in both directions instead of just the one.
      const wantSprint = sprinting && !handsBusy && !wantAlt && now - fireAt >= fireHold ? 1 : 0;
      sprintK += (wantSprint - sprintK)
        * Math.min(1, dt * (wantSprint ? SPRINT_IN_RATE : SPRINT_OUT_RATE));

      if (current) {
        const [rx, ry, rz] = current.rest;
        // Shouldering pulls the weapon to the centre of the view. The lob instead lifts
        // it a little and draws it back toward the shoulder — pointedly NOT toward the
        // centre, which is what made a readied grenade sit in the middle of the screen
        // blocking the throw you were aiming.
        const x = (rx * (1 - adsK) + 0.004 * adsK) * side + lobK * 0.022 * side;
        const y = ry * (1 - adsK) + -0.05 * adsK + lobK * 0.052 - crouch * 0.018;
        const z = rz + lobK * 0.055;

        const g = current.g;
        // Every pose goes through this instead of `g.position.set`, so nothing can push
        // the rig back through the camera plane. The clipping bug was a rest position
        // that let the stock sit behind the eye; a pose offset can do exactly the same
        // thing, and hand-checking each branch below every time one changes is not a
        // guarantee — this is.
        const place = (px, py, pz) => g.position.set(px, py, Math.min(pz, current.limitZ));

        // A scoped weapon is hidden outright. Narrowing the FOV magnifies the
        // viewmodel along with the world, so at full zoom the receiver covers the
        // middle of the screen — exactly where you are trying to look. The scope
        // overlay is opaque by then, so there is nothing to see it disappear.
        g.visible = scopeK < 0.5;

        // Has the thrown object left the hand? Computed here rather than inside the
        // throw branch below so every other state restores it: at rest, mid-swap or
        // part-way through the next windup the ball is back in the fist, and only the
        // stretch of the swing after release is empty-handed.
        if (current.throwBody) {
          const gone = swing >= THROW_RELEASE && current.spec.anim === 'throw';
          for (const m of current.throwBody) m.visible = !gone;
        }

        const support = current.arms[side].hands[1];

        // Recoil, resolved once here rather than in the branch that draws it, because
        // two branches need it: at rest, and while the action is being worked. A bolt
        // gun's stroke starts on the same frame as its shot, so a cycle branch that did
        // not carry the kick would delete the recoil of the two weapons — the sniper and
        // the shotgun — that have the most of it.
        const kickBack = kick * KICK_BACK;
        const kickUp = kick * KICK_UP;
        const kickPitch = kick * KICK_PITCH;

        // The carry, resolved here for the same reason the kick is: two branches draw it,
        // and `side` only exists inside this block. Multiplied down by the alt blend as
        // well as gated on the alt intent — see wantSprint.
        const carry = sprintCarry(sprintK * (1 - altK), sway, side);

        // Only the inspect fades the arms, and anything at all can interrupt it — a
        // reload, a jam, a weapon swap, dying. Restoring it here rather than in each of
        // those means no path can leave the hands half-transparent. `setArmFade` returns
        // immediately when nothing changes, so this costs a comparison a frame.
        if (inspectT < 0) setArmFade(1);

        if (swapT >= 0) {
          // ---- holster and draw ------------------------------------------------
          // One curve for both halves. `down` is how far the weapon is out of the
          // frame: it runs 0→1 while the old one is stowed and 1→0 while the new one
          // comes up, which is why the mesh can be swapped at the join without anything
          // visibly jumping — both rigs are at the bottom of the same travel there.
          //
          // Before this, a swap was a visibility flip: the weapon you asked for was
          // simply in your hands on the next frame while the server still refused to
          // let you fire it for another third of a second. The gap between those two
          // facts is what read as "it just straight up appears".
          const down =
            swapT < HOLSTER_FRAC
              ? smooth(seg(swapT, 0, HOLSTER_FRAC))
              : 1 - smooth(seg(swapT, HOLSTER_FRAC, 0.94));
          // The draw overshoots rest slightly and settles back, which is the part that
          // makes it read as weight arriving in the hands rather than a slide-in.
          const settle = beat(swapT, 0.8, 1);
          // ---- the cock -------------------------------------------------------
          // "when you switch weapons, i dont see it cocking the gun so it still feel
          // fast." The settle above is a weight cue, not an action cue: it says the gun
          // arrived, and says nothing about it being made ready. So the off hand goes to
          // the charging handle once the weapon is most of the way up.
          //
          // `pull` is one beat rather than two curves. A handle that travels back on one
          // easing and returns on another can be caught mid-stroke by a frame drop and
          // read as the hand hovering; a single sine goes out and comes back through the
          // same values and cannot desynchronise from itself.
          //
          // 0.58 to 0.9 of the swap, so it starts while the muzzle is still rising and
          // finishes just before the settle — the order a person does it in. Melee and
          // thrown weapons are excluded below: there is nothing on a knife to rack, and
          // an off hand jerking backwards next to a grenade reads as a second throw.
          const cockable = !current.spec.melee;
          const pull = cockable ? beat(swapT, COCK_AT[0], COCK_AT[1]) : 0;
          place(
            x + bobX + 0.035 * down * side,
            y - bobY - 0.3 * down + 0.012 * settle - 0.01 * pull,
            z + 0.035 * down + 0.014 * pull,
          );
          g.rotation.set(
            -0.95 * down + 0.11 * settle + 0.09 * pull, // muzzle swings down out of the frame
            0.28 * down * side,
            -0.42 * down * side + 0.07 * pull * side,
          );
          if (support) {
            // Back along the weapon's own axis and slightly inboard — the stroke a
            // charging handle actually travels. Written absolutely, not accumulated: the
            // hand's rest is (0,0,0) and `restoreRig` puts it back there, so a `+=` here
            // would creep further out of the model on every frame of every swap.
            support.position.set(0.03 * pull * side, 0.018 * pull, 0.075 * pull);
            support.rotation.set(-0.5 * pull, 0, 0);
          }
        } else if (reloadP >= 0) {
          // ---- reload, staged --------------------------------------------------
          // Five beats off the one progress value: tip the weapon out of the aim line,
          // strip the magazine, hold the well empty, seat a fresh one, rack the action.
          // The previous version moved the weapon and the magazine on two curves of the
          // same shape, so the magazine never actually left — it bobbed in place, which
          // is why it read as a wobble rather than as reloading.
          const p = reloadP;
          // A plateau, not a peak: up over the first sixth, held down through the
          // middle, back over the last seventh. The weapon is *out of the way* for the
          // duration instead of only touching the bottom of an arc.
          const e = smooth(seg(p, 0, 0.16)) - smooth(seg(p, 0.86, 1));
          // How far the magazine is from seated. One figure drives the magazine, the
          // empty-well gap and the support hand, so the hand can never be reaching for
          // a magazine that is somewhere else.
          const magD = p < 0.42 ? smooth(seg(p, 0.12, 0.38)) : 1 - smooth(seg(p, 0.46, 0.7));
          const seat = beat(p, 0.62, 0.74); // the slap as it goes home
          const rack = beat(p, 0.76, 0.94); // the charging handle

          place(
            x + bobX - 0.035 * e * side,
            y - bobY - 0.085 * e - 0.014 * seat,
            z - 0.02 * e,
          );
          g.rotation.set(-0.5 * e + 0.22 * rack, 0.34 * e * side, 0.55 * e * side);

          if (current.mag) {
            const b = current.mag.base;
            // Far enough to leave the frame, and hidden at the extreme so the well is
            // unmistakably empty for a moment. That gap is the whole difference between
            // a reload and a magazine jiggling in its housing.
            current.mag.mesh.position.set(b.x, b.y - 0.42 * magD, b.z + 0.1 * magD);
            current.mag.mesh.rotation.set(1.1 * magD, 0, 0.55 * magD * side);
            current.mag.mesh.visible = magD < 0.9;
          }
          // The support hand goes with the magazine and comes back with it. This is the
          // part a player actually reads as "reloading": one hand stays on the weapon,
          // the other leaves to do the work.
          if (support) {
            support.position.set(-0.05 * magD * side, -0.3 * magD, 0.08 * magD);
            support.rotation.set(0.5 * magD, 0, 0);
          }
        } else if (jamP >= 0) {
          // ---- clearing a jam --------------------------------------------------
          // "the character will try to unjam it but punching the gun using its other
          // hand". So that is literally what this is: the support hand comes off the
          // fore-end, hits the receiver twice, and the second one frees it.
          //
          // The weapon is tipped inboard and toward the eye rather than dropped out of
          // the aim line the way a reload does it. That difference is the point — a
          // reload is a task you step out of the fight to do, a jam is something you are
          // trying to fix without giving up the angle you are holding, and the pose has
          // to read as the second thing or it is just a slower reload.
          const p = jamP;
          // Brought over and held there for the body of the animation, back at the end.
          const tip = smooth(seg(p, 0, 0.14)) - smooth(seg(p, 0.86, 1));
          // The two strikes, at the same fractions audio.jam() puts its thumps at — both
          // read off the one clear time, so the hit and the sound cannot drift apart.
          const hit1 = beat(p, 0.22, 0.38);
          const hit2 = beat(p, 0.47, 0.63);
          // What the gun does when it is struck: a short jolt away from the hand, not a
          // smooth swell. Squared so the impulse is concentrated at the contact instead
          // of spread across the whole approach.
          const jolt = hit1 * hit1 * 0.7 + hit2 * hit2;
          // The action finally cycling, at audio.jam()'s last beat.
          const rack = beat(p, 0.74, 0.92);
          place(
            x + bobX + (-0.06 * tip + 0.022 * jolt) * side,
            y - bobY - 0.03 * tip - 0.028 * jolt,
            z + 0.026 * tip + 0.014 * jolt,
          );
          g.rotation.set(
            -0.2 * tip + 0.3 * jolt + 0.2 * rack,
            // Rolled toward the off hand so the receiver faces it. Without the yaw the
            // hand appears to punch the side of the gun it cannot reach.
            0.5 * tip * side,
            (0.58 * tip + 0.16 * jolt) * side,
          );

          if (support) {
            /**
             * The fist, aimed at the top of the gun.
             *
             * This is the whole of "i cant see it punching the gun". The gesture was
             * there — two strikes on the receiver, 41 degrees of roll to turn it toward
             * the off hand — and it played below the viewport. Measured by projecting the
             * fist into the viewmodel camera across a full stoppage: inside the frame for
             * 29% of it, and 1.53 units of clip space under the bottom edge at the worst.
             * Both strikes, the two frames the animation exists for, peaked at -0.93 and
             * -1.00 — on the edge and just past it.
             *
             * One line did that. The hand was posed by rotating its group, and the group's
             * origin is the RIG origin, not the wrist: the fist sits up to 71cm forward of
             * the pivot, so the -0.7rad wind-up swung it 28cm downward on a lever nobody
             * intended. At rifle distance the bottom of the frame is 21cm below the bore.
             *
             * So the fist is now placed instead of swung. `strike` is a point on the
             * weapon, `wrist` is where the fist rests, and `tip` moves it from one to the
             * other — which cannot leave the gun behind, because the destination is part
             * of the gun. The fist is now inside the frame on every frame of a stoppage on
             * all seven jamming weapons, and takes 1-8% of the screen where it took none.
             */
            const w = support.userData.wrist;
            const swingIn = Math.max(hit1, hit2);
            // Where the fist is and where it is going, both in CAMERA space. vmRoot IS the
            // viewmodel camera and the rigs hang off it unrotated, so a rig point becomes a
            // camera point for one rotation and one add — and once it is there, "inside the
            // frame" and "a fifth of the frame's height above the receiver" are things that
            // can be said about it at all. frameFist is where the first of those gets said.
            jamRot.copy(g.quaternion);
            jamRest.copy(w).applyQuaternion(jamRot).add(g.position);
            jamAim.fromArray(current.strike).applyQuaternion(jamRot).add(g.position);
            // Up off the gun between strikes, all the way down onto it at each contact. The
            // wind-up is the visible half of a punch: without it the two hits are a fist that
            // flickers rather than one that travels. Both half-angles are read live, so a 4:3
            // screen or a custom `vmFov` gets the same gesture rather than the 16:9 one.
            const tanY = Math.max(0.05, Math.tan((vmRoot.fov * Math.PI) / 360));
            const tanX = tanY * Math.max(0.2, vmRoot.aspect);
            jamAim.y += JAM_RAISE * (1 - swingIn) * Math.max(0.05, -jamAim.z) * tanY;
            frameFist(jamAim, tanX, tanY);
            // Rest to target by the tip, then back out of camera space. Starting the blend at
            // the rest point rather than at a framed one is what keeps the pose exact at
            // tip = 0: the hand does not jump when the stoppage begins or ends.
            jamAim.sub(jamRest).multiplyScalar(tip).add(jamRest)
              .sub(g.position).applyQuaternion(jamRot.invert());
            // Re-aim the forearm at the shoulder it grows out of.
            //
            // The sleeve is a 33cm box baked pointing from the wrist to the shoulder, so
            // moving the fist without turning the hand leaves it pointing at where the
            // shoulder was RELATIVE TO THE OLD WRIST — which, once the fist is up on the
            // receiver, is off across the frame. Measured with per-pixel ray-box depth, a
            // hand-picked wind-up angle grew it to a third of the screen and dropped the
            // gun from a 12-17% share to 0-9%: an arm across the frame, punching a weapon
            // that was no longer being drawn. Aiming the forearm back at the shoulder puts
            // it at 4-16% and costs the gun 1-5%, and it leaves no angle to choose —
            // the minimal rotation from the baked direction to the new one is the pose.
            //
            // A forearm running back past the eye is foreshortened to nearly nothing, which
            // is why it costs only 0-4% at rest and why aiming it truly keeps it small. The
            // same fact is also why it still draws over 26-56% of the fist and cannot be
            // made not to: the sleeve leaves the fist's rear face toward a shoulder that is
            // 42cm BEHIND the eye on a pistol, so every part of it is nearer than the fist
            // and its near-clipped projection flares across the fist's own silhouette.
            // Harmless, because the thing covering the hand is the same hand — but it is
            // the reason to read the two together when measuring what a player can see.
            jamBack.copy(support.userData.shoulder).sub(jamAim).normalize();
            support.quaternion.setFromUnitVectors(support.userData.back, jamBack);
            // Turn the hand about its own wrist rather than about the rig origin, by
            // cancelling the displacement the rotation would otherwise give the fist: the
            // fist sits up to 71cm forward of that origin, and the pose it replaced swung
            // 28cm downward on that lever when the bottom of the frame is 21cm below the
            // bore. `position` is then the wrist, which is what the group actually sets.
            support.position.copy(jamAim).sub(jamPivot.copy(w).applyQuaternion(support.quaternion));
          }
        } else if (cycleT >= 0) {
          // ---- working the action ------------------------------------------------
          // "the sniper why it has only reload ... you dont reload each time it shots but
          // you cocking the gun thats the missing for sniper each shot". A bolt gun fires
          // and then has to be cycled by hand before it will fire again, and the wait was
          // already in the game — `intervalMs` is 1200 on the sniper — with nothing on
          // screen during it. A second and a fifth of a static weapon after every shot is
          // most of why it read as "only reload".
          //
          // The recoil runs underneath, unchanged: the shot and the stroke start on the
          // same frame, and the spring is still ringing while the hand goes back.
          const cp = cycleT;
          // The support hand leaves the fore-end for the bolt handle and comes back.
          const reach = smooth(seg(cp, 0, 0.14)) - smooth(seg(cp, 0.84, 1));
          // Back, held at the rear while the case clears, then home — CYCLE_AT are its two
          // midpoints, which is what the sounds and the remote avatar's hand both run off.
          const pull =
            smooth(seg(cp, CYCLE_AT[0] - CYCLE_RAMP, CYCLE_AT[0] + CYCLE_RAMP)) -
            smooth(seg(cp, CYCLE_AT[1] - CYCLE_RAMP, CYCLE_AT[1] + CYCLE_RAMP));
          // The weapon comes off the aim line while the hand is on the bolt — a bolt is
          // worked with the rifle rolled inboard, not held level — and drops as the
          // shoulder takes the weight of it one-handed.
          place(
            x + bobX - 0.03 * reach * side,
            y - bobY + kickUp - 0.022 * reach - 0.012 * pull,
            // Away from the eye, not toward it. Tipping a rifle inboard does draw it back
            // a little, but this branch is already spending the pose room on the recoil —
            // the sniper's own peak is 5.2cm of the 6cm there is — and a 1.4cm draw-in on
            // top of it measured 2.2mm into `place`'s clamp on exactly the frames the
            // kick was at its highest, which would have flattened the top of the recoil.
            // A centimetre the other way also buys the off hand somewhere to be: the
            // stroke goes 16cm to the rear, and the gun getting out of its way is what
            // makes that travel visible instead of the hand vanishing behind the breech.
            z + kickBack - 0.01 * reach,
          );
          g.rotation.set(
            kickPitch - 0.05 * reach - 0.06 * pull,
            0.16 * reach * side,
            (0.3 * reach + 0.06 * pull) * side,
          );

          if (support) {
            // Up and inboard onto the handle, then 16cm straight back and home again.
            // Back is +z: the bolt handle is on the shooter's side of the receiver, which
            // is the one direction a rifle's action is ever worked in.
            support.position.set(
              (0.05 * reach - 0.02 * pull) * side,
              0.075 * reach + 0.02 * pull,
              -0.02 * reach + 0.16 * pull,
            );
            support.rotation.set(0.3 * reach - 0.5 * pull, 0, -0.25 * reach * side);
          }
        } else if (inspectT >= 0) {
          // ---- inspect ---------------------------------------------------------
          // Raise, turn the far side into view, hold it there, settle back. Staged, and
          // deliberately never a whole revolution: the weapon is being *presented*, not
          // barrel-rolled, and a turn that carries on past the far profile spends half
          // its time showing the underside of a receiver nobody paints.
          //
          // INSPECT_TURN is the important number. It stops a little past broadside,
          // which puts the flank that carries a finish square to the eye at the hold and
          // lets the return unwind the way it came — the same reason a player turning a
          // knife over in their hands does not spin it.
          //
          // "the inspect when you press F inspect goes to your face": the turn used to
          // be about the rig's ORIGIN, which sits behind the receiver, so the weapon
          // swung around on a half-metre arm and drove its own front half through the
          // eye. This turns it about its own middle and puts that middle exactly as far
          // out as INSPECT_FILL asks for, so the whole profile is in frame and none of
          // it is ever nearer than the weapon itself.
          const p = inspectT;
          // Up over the first seventh, held for the body of the animation, down at the
          // end. A plateau, so the hold is a hold rather than the top of an arc.
          const lift = smooth(seg(p, 0, 0.14)) - smooth(seg(p, 0.82, 1));
          const turn = smooth(seg(p, 0.1, 0.44)) - smooth(seg(p, 0.62, 0.92));
          // Tips the presented face toward the eye during the hold, so the turn shows a
          // surface rather than an edge-on silhouette.
          const tilt = smooth(seg(p, 0.18, 0.5)) - smooth(seg(p, 0.6, 0.9));

          const erx = -0.4 * lift + 0.28 * tilt;
          const ery = INSPECT_TURN * turn * side;
          const erz = (0.28 * lift + 0.5 * tilt) * side;

          // Where the weapon's own centre goes. At turn = 0 this is exactly where the
          // centre sits at rest — measured to the micrometre at both p=0 and p=1 — so the
          // animation starts and ends on the rest pose with nothing to blend, and the
          // whole push is carried by `turn`, which is the term that needs the room.
          const c = current.center;
          const cx = x + bobX + c[0] - 0.05 * lift * side;
          const cy = y - bobY + c[1] + 0.045 * lift;
          // How far the rig reaches across the frame right now. This is the standard
          // oriented-box projection — the row of R dotted with the half-extents — got by
          // rotating each of the rig's own axes and taking the screen components. Exact
          // at every rotation, which a fixed half-length is not: the same weapon spans
          // its whole length at the hold and almost nothing at the start, and framing it
          // off the length alone either pushes it away before it has turned or fails to
          // account for the tilt once it has.
          const h = current.half;
          const a1 = rotateXYZ(erx, ery, erz, h[0], 0, 0);
          const a2 = rotateXYZ(erx, ery, erz, 0, h[1], 0);
          const a3 = rotateXYZ(erx, ery, erz, 0, 0, h[2]);
          // Both half-angles, read live: a 4:3 screen or a custom `vmFov` frames the
          // weapon for itself rather than for a 16:9 default.
          const tanY = Math.max(0.05, Math.tan((vmRoot.fov * Math.PI) / 360));
          const tanX = tanY * Math.max(0.2, vmRoot.aspect);
          // The depth at which the far edge lands INSPECT_FILL of the way to the frame
          // edge, on whichever axis is tighter. The offset of the weapon from the centre
          // of the screen is part of it: a pistol is short but sits well off to one side,
          // and framing only its length would leave it in the corner of the eye.
          const need = Math.max(
            (Math.abs(cx) + Math.abs(a1.x) + Math.abs(a2.x) + Math.abs(a3.x)) / (tanX * INSPECT_FILL),
            (Math.abs(cy) + Math.abs(a1.y) + Math.abs(a2.y) + Math.abs(a3.y)) / (tanY * INSPECT_FILL),
          );
          const restD = -(z + c[2]);
          const depth = restD + Math.max(0, need - restD) * turn;

          // The pivot is the centre, not the origin, and three.js rotates a group about
          // its origin — so the origin has to be placed at wherever it lands once the
          // centre is nailed down: origin = target − R·centre.
          const rc = rotateXYZ(erx, ery, erz, c[0], c[1], c[2]);
          place(cx - rc.x, cy - rc.y, -depth - rc.z);
          g.rotation.set(erx, ery, erz);

          // The arms go with the turn. They are forearms only — the upper arm is
          // deliberately behind the camera — and that reads fine while the weapon is
          // held in the corner, because the near plane cuts the open ends off. Broadside
          // and pushed out to fill the frame it does not: the stubs come fully into view
          // as two batons lying across the middle of the shot. So they fade out as the
          // weapon turns and are back by the time it is shouldered again.
          setArmFade(1 - turn);
        } else if (swing >= 0) {
          if (current.spec.anim === 'throw') {
            // ---- overhand throw ------------------------------------------------
            // Three beats, and the middle one is the whole fix: cock up and back, whip
            // forward to full extension — which is where THROW_RELEASE empties the hand
            // — then recover. The previous version was one symmetric envelope
            // (`sin(pi*swing)`) that was zero at both ends, so the hand went out and
            // came back holding the grenade the entire time and the throw had no moment
            // of release in it at all.
            //
            // `fwd` peaks exactly at the release, so the ball disappears on the frame
            // the arm is furthest down-range instead of after it has started coming back.
            // The cock UNWINDS as the arm comes over, which is the second half of this
            // line and it was missing. `seg` clamps at 1, so a bare `seg(swing, 0, 0.26)`
            // pins the windup at full for the rest of the swing: the last drawn frame of
            // every throw held the wrist 1.15 rad — 66° — back over the shoulder with the
            // forward whip already recovered to nothing, and then `swing` went to -1 and
            // the next frame was the rest pose. A 66° snap and a 0.1u jump toward the
            // camera, once per grenade. Unwinding it by the release means both terms are
            // 0 when the swing ends, so the pose the animation leaves behind IS rest.
            // The knife's `wind` below has always had this second term; the throw did not.
            const windup = smooth(seg(swing, 0, 0.26)) - smooth(seg(swing, 0.26, THROW_RELEASE));
            const fwd = smooth(seg(swing, 0.22, THROW_RELEASE)) - smooth(seg(swing, THROW_RELEASE, 1));
            place(
              x + bobX,
              y - bobY + 0.13 * windup - 0.06 * fwd,
              // Back toward the shoulder, then well past rest down-range. `place`
              // clamps the near end, so the windup cannot push it into the camera.
              z + 0.1 * windup - 0.3 * fwd,
            );
            // Wrist cocked back over the shoulder, then snapped over the top.
            g.rotation.set(-1.15 * windup + 1.75 * fwd, 0, 0);
          } else if (swingHeavy) {
            // ---- heavy stab ----------------------------------------------------
            // A different motion, not a bigger version of the slash. The light attack
            // is a lateral cut; this pulls back past the shoulder and drives straight
            // down the aim line, which is what makes the two read as distinct attacks
            // rather than one animation played at two speeds. `sq` holds the wind-up:
            // the first 40% is spent drawing back, then it commits.
            const draw = 1 - smooth(seg(swing, 0.35, 0.62));
            const thrust = smooth(seg(swing, 0.35, 0.68)) - smooth(seg(swing, 0.72, 1));
            place(
              x + bobX + (0.075 * draw - 0.02 * thrust) * side,
              y - bobY + 0.05 * draw - 0.02 * thrust,
              z + 0.05 * draw - 0.2 * thrust,
            );
            g.rotation.set(
              -0.9 * draw + 0.35 * thrust,
              (0.55 * draw - 0.12 * thrust) * side,
              (0.7 * draw - 0.15 * thrust) * side,
            );
          } else {
            // ---- light slash ---------------------------------------------------
            // Three beats: wind up, cut, recover — and consecutive slashes alternate
            // direction. The old one had none of that. It started at full speed from
            // rest, always cut the same way, and eased out symmetrically, so mashing the
            // button looked like the knife vibrating in place. A cut reads as a cut
            // because of what happens *before* it: the blade has to visibly go
            // somewhere first, and then the crossing has to be faster than the return.
            //
            // `d` folds the alternation into the hand mirror, so a left-handed player
            // gets the same pair of cuts reflected rather than a different pair.
            const d = slashDir * side;
            // Drawn back over the first fifth, gone by the time the blade is moving.
            const wind = smooth(seg(swing, 0, 0.18)) - smooth(seg(swing, 0.18, 0.34));
            // The crossing, then the recovery. Peaks at the end of the cut, not the
            // middle of the animation — the follow-through is the extreme of the pose.
            const cut = smooth(seg(swing, 0.16, 0.46)) - smooth(seg(swing, 0.5, 1));
            place(
              x + bobX + (0.085 * wind - 0.26 * cut) * d,
              y - bobY + 0.075 * wind - 0.13 * cut,
              z + 0.03 * wind - 0.05 * cut,
            );
            g.rotation.set(
              -0.5 * wind + 0.55 * cut,
              (0.7 * wind - 1 * cut) * d,
              (0.85 * wind - 1.45 * cut) * d,
            );
          }
        } else if (current.spec.anim) {
          // Thrown and melee weapons have no recoil spring. Right-click gives the
          // thrown ones an underhand tip and the knife a held wind-up — the blade sits
          // drawn back for as long as the button is down, so the heavy attack announces
          // itself before it costs you the second it takes to land.
          // The carry rides on top. A knife at a run drops and cants like anything else
          // you are holding while running; `heavyK` and the carry cannot both be up, so
          // the sum is never a wind-up and a run at once.
          place(
            x + bobX + 0.07 * heavyK * side + carry.x,
            y - bobY + 0.045 * heavyK + carry.y,
            z + 0.045 * heavyK + carry.z,
          );
          g.rotation.set(
            -0.55 * lobK - 0.85 * heavyK + carry.pitch,
            0.5 * heavyK * side + carry.yaw,
            (0.18 * lobK + 0.65 * heavyK) * side + carry.roll,
          );
        } else {
          // ---- at rest, taking the recoil --------------------------------------
          // "i hate the blowback it is all upside instead of up and back you get me
          // right?" — and it was. This used to be `z + kick*0.05` with a `kick*0.6`
          // pitch, which on the rifle came to 0.7cm of rearward travel against 6.4cm of
          // muzzle rise: 84° from horizontal, so effectively straight up. The gun barely
          // moved toward the shoulder and instead pivoted about the hands like a lever.
          //
          // The gains now put the shove first — see KICK_BACK. The muzzle still climbs,
          // because a muzzle does climb, but the dominant motion at the hands is back
          // into the shoulder along the bore, which is the direction the force is
          // actually in.
          //
          // And the sprint carry, summed on. It is at zero on any frame the recoil is
          // meaningfully non-zero — a shot forces it out at SPRINT_OUT_RATE and holds it
          // out for the weapon's whole cadence — but the two DO overlap for the ~115ms
          // after the first round of a burst, and that overlap is the only thing in the
          // file that can add to the rearward travel the clamp guards. verify.mjs runs
          // the decay and the spring together for every weapon and both hands to prove
          // the sum never reaches it.
          place(x + bobX + carry.x, y - bobY + kickUp + carry.y, z + kickBack + carry.z);
          g.rotation.set(kickPitch + carry.pitch, carry.yaw, carry.roll);
        }
      }

      flash.intensity = Math.max(0, flash.intensity - dtMs * 0.022);
      // Follow the muzzle with the world flash only while it is actually lit — the
      // matrix work below is not free, and a dark light has nothing to place.
      worldFlash.intensity = flash.intensity * 0.6;
      if (worldFlash.intensity > 0.02) muzzleWorld(worldFlash.position);

      for (const t of tracers) {
        if (!t.until) continue;
        if (now >= t.until) {
          t.mat.opacity = 0;
          t.mesh.visible = false;
          t.until = 0;
        } else {
          t.mat.opacity = 0.95 * ((t.until - now) / TRACER_MS);
        }
      }

      for (const p of puffs) {
        if (!p.until) continue;
        if (now >= p.until) {
          p.mat.opacity = 0;
          p.mesh.visible = false;
          p.until = 0;
          continue;
        }
        const age = (now - p.born) / PUFF_MS; // 0 → 1
        // Swell and thin out together, and drift up a little as it dissipates.
        p.mesh.scale.setScalar(p.grow * (0.35 + age * 0.9));
        p.mesh.position.y += dt * 0.28;
        p.mat.opacity = 0.5 * (1 - age) ** 1.6;
      }
    },

    /** How far the right-click blend has progressed. Zero for weapons with no
     *  right-click at all, so callers need not know which those are. */
    get aimAmount() {
      return altK;
    },

    /** Opacity for the scope overlay: 1 or 0. Still typed as an amount because the HUD
     *  writes it straight into `opacity` and because a future scope that fades is a
     *  change to one assignment rather than to this seam. Zero for weapons without a
     *  scope, so the caller does not have to know which those are. */
    get scopeAmount() {
      return scopeK;
    },

    /** Whether the weapon in hand owns a scope at all — independent of whether it is
     *  raised right now. The HUD needs this to suppress the hipfire crosshair on a
     *  sniper: a scoped weapon is aimed down its scope or not aimed at all. */
    get hasScope() {
      return scopes(currentId);
    },

    /**
     * Field of view this weapon wants right now, given the player's base FOV.
     *
     * Two values rather than one: `scopeK` says whether we are looking through the
     * scope at all, and `zoomFovK` says which of its zooms. Both are needed, because a
     * double scope changes its FOV while `scopeK` is already pinned at 1. Neither eases
     * any more — a scope is instant, like CS2's, and the assignment above says why.
     *
     * `scopeK`, not the raw blend, so a lobbed grenade cannot zoom the camera — and it
     * is zero for every weapon without a scope, which is what makes the whole
     * expression collapse to `baseFov` for nine weapons out of twelve.
     */
    fovFor(baseFov) {
      return baseFov + (zoomFovK - baseFov) * scopeK;
    },

    /** World-space muzzle position, for spawning local tracers. */
    muzzle(out = new THREE.Vector3()) {
      return muzzleWorld(out);
    },
  };
}
