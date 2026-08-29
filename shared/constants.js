// Every tunable the simulation depends on. Imported by BOTH client and server —
// keep this file free of any dependency so it loads in Node and the browser alike.

// ---------------------------------------------------------------- timing
export const TICK_HZ = 60;
export const TICK_DT = 1 / TICK_HZ;
export const SNAPSHOT_HZ = 20;
export const TICKS_PER_SNAPSHOT = Math.round(TICK_HZ / SNAPSHOT_HZ); // 3

// Admission is about PEOPLE, never the bots that backfill a room. A regional process may
// host several ten-seat modes, but on the free deployment we deliberately stop at twenty
// simultaneous human seats so the 60 Hz simulation retains headroom.
export const REGION_HUMAN_CAP = 20;

// An abnormal socket loss keeps its seat briefly. Long enough for a mobile-network handoff
// or a proxy hiccup, short enough that a genuinely departed player does not block a full
// room. A normal close (leaving or reloading) frees the seat immediately.
export const RECONNECT_GRACE_MS = 10000;

/** How far in the past remote players are rendered. Two snapshots of slack, so
 *  a single dropped packet doesn't produce a visible hitch. */
export const INTERP_DELAY_MS = 100;

/** Ceiling on inputs consumed per player per tick. Without this a client can
 *  flood inputs and advance itself faster than real time. */
export const MAX_INPUTS_PER_TICK = 5;

/** Rewind window kept per player, for lag-compensated hit detection (M4). */
export const HISTORY_MS = 1000;

/**
 * The furthest back a shot may be resolved, in ms.
 *
 * Lag compensation rewinds every target to the shooter's view time, and the shooter is
 * the one telling us what that time was (`vt` in sanitizeInput). This is the ceiling on
 * how much it can be worth to lie about it: a client that reports a stale view gets at
 * most this much rewind, which caps "he shot me after I was behind the wall" at a fifth
 * of a second no matter what an edited client claims. Every shooter with lag
 * compensation accepts that trade; what it must not do is accept an unbounded one.
 *
 * Comfortably inside HISTORY_MS, so the recorded window is always long enough to answer
 * a rewind from and the clamp is the only thing that ever limits it.
 */
export const MAX_REWIND_MS = 200;

// ---------------------------------------------------------------- player body
export const PLAYER_HALF_W = 0.4;
export const PLAYER_HALF_H = 0.9;
/** Eye height measured from the body centre, not the feet. */
export const EYE_OFFSET = 0.62;

// ---------------------------------------------------------------- hit zones
// WHERE on a body a bullet landed, which is a different question from how big the body
// is. The geometry is `headBoxOf` and `legsTopOf` in shared/movement.js, next to
// `halfOf` for the same reason everything else about a player's size lives there; what
// each zone is worth is HIT_ZONE_MUL in shared/weapons.js.

/**
 * The head, as half-extents. NARROWER than the body on purpose, and that is the entire
 * skill gate: PLAYER_HALF_W is 0.4 so a body is 0.8u wide, while a head is 0.36u — 45%
 * of the width and about 8% of the standing silhouette's area. A head the width of the
 * shoulders would hand out the headshot multiplier for aiming at a torso.
 */
export const HEAD_HALF_W = 0.18;
export const HEAD_HALF_H = 0.175;

/**
 * Fraction of the body BELOW the head that counts as legs.
 *
 * A fraction rather than an absolute height because legs are the part of a body that
 * folds when you duck — the skull is not, which is why HEAD_HALF_H is absolute instead.
 * Standing that is 0.60u of a 1.8u body; fully crouched, 0.31u of 1.1u.
 */
export const LEG_FRAC = 0.41;
/**
 * Where centre mass is, as a fraction up the body left over once the head and the legs
 * are taken off it. What a bot aims at, and the only reason it needs a name.
 *
 * Bots aimed at `eyeY` — dead inside the head box that now exists. AIM_ERR_SETTLED is
 * 0.012 rad and a head subtends 0.018 rad at ten units, so a settled bot's wobble was
 * SMALLER than the target it was centred on: every rifle, pistol, semi and lmg shot a
 * settled bot landed would have been a x4 one-tap kill. Not a bot problem to shrug at —
 * "for BOT it is no problem since it is a bot" was about the missing systems, not about
 * bots turning into aimbots the moment they arrived.
 *
 * 0.62 puts the aim point 0.40u under a standing eye: comfortably clear of the head at
 * duelling range, comfortably clear of the legs, and still inside the head's wobble at
 * forty units and beyond, so a bot lands the occasional headshot the way a player does.
 * Expressed against the head and the legs rather than as an absolute height so it stays
 * between them if either of those is ever retuned.
 */
export const CHEST_FRAC = 0.62;

// Crouching. The body genuinely shrinks — collision, hitbox and avatar all read the
// same half-height — so ducking behind the 1.2u cover boxes actually breaks line of
// sight instead of only lowering the camera.
//
// The centre stays put and the box shrinks around it, which means a crouching player
// hovers 0.35u above the floor until gravity closes the gap on the next tick. That is
// one frame of a 0.35u drop and invisible in play, and it is the cheap half of the
// trade: keeping the feet planted instead would push the head *down* through nothing
// while the crouch->stand test has to check for floor as well as ceiling.
export const CROUCH_HALF_H = 0.55;
/** Eye offset while fully crouched, from the (unchanged) body centre. */
export const CROUCH_EYE_OFFSET = 0.3;
/** Crouch blend rate, in units of the 0..1 crouch amount per second. ~0.14s down. */
export const CROUCH_RATE = 7.0;
/** Speed multiplier at full crouch. CS2 crouch-walk is roughly a third of a run. */
export const CROUCH_SPEED_MUL = 0.36;
/** Speed multiplier while walking (Shift, held). Slower, and that is all it is today:
 *  the footstep cadence in main.js is distance-driven so walking is RARER rather than
 *  quieter, and nothing anywhere reads velocity for accuracy. The doc used to claim
 *  "quiet, accurate, and slower" and only the last word was true. */
export const WALK_SPEED_MUL = 0.52;
/**
 * Speed multiplier while looking down a scope, and CS2's number rather than a taste one.
 *
 * The AWP moves at 200 of CS2's 250 unscoped and at 100 scoped -- so scoping costs half
 * of an already-reduced walk, and 100/250 is 0.4. That single trade is most of what makes
 * a sniper a sniper: the gun that kills in one shot is the gun that cannot reposition
 * while it is aimed, and a scoped player who wants to move has to give up the scope to do
 * it. Without it a sniper is a rifle with a magnifier on.
 *
 * Taken as a MINIMUM against crouch and walk in `speedMul`, not multiplied by them, for
 * the reason the comment there gives: compounding 0.4 into 0.36 lands at 0.14, which
 * reads as being stuck rather than as being deliberately slow.
 */
export const SCOPE_SPEED_MUL = 0.4;

/**
 * The highest zoom step any scope may claim, which is what `sanitizeInput` clamps to.
 *
 * A ceiling here rather than a per-weapon lookup in the sanitiser: the sanitiser runs
 * before anything has decided which weapon this input is even holding, and the consumer
 * narrows the value to the weapon's own `zoomFovs` anyway (see `scopeStepOf`). Two is
 * what the sniper has; the slack is so a third zoom is a weapon-table edit and not a
 * protocol one.
 */
export const MAX_SCOPE_STEP = 3;

// ---------------------------------------------------------------- movement
// Tuned down from 4.8 after a playtest reported the game "was so fast". The arena is
// only 44 units across, so 4.8 crossed it in nine seconds and left no room to read a
// fight before you were through it.
export const MOVE_SPEED = 4.2;
export const GROUND_ACCEL = 8.0;
export const AIR_ACCEL = 1.2;
export const FRICTION = 9.0;

// ---------------------------------------------------------------- sprint
// 1.15 is not a taste decision, it is the ceiling the MAP allows. The arena audit in
// verify.mjs certifies that no solid is a step onto a freestanding 4u wall top, and its
// runOut() scales with the horizontal speed carried into a jump. The margin at a plain
// run is 0.350u, and sprint spends it:
//
//   1.00x  +0.350u   1.15x  +0.088u   1.20x  0.000u   1.40x  -0.350u, SIX ladders
//
// Gating sprint to `grounded` does not buy headroom. The cap is a projection cap, so an
// airborne sprinter is neither accelerated nor slowed (`add > 0` fails) and momentum
// carries the whole 0.72s arc -- which is exactly what reaches the wall top. The audit
// is scaled by this constant, so raising it past 1.20 fails the suite instead of
// quietly shipping a way onto the roof.
export const SPRINT_SPEED_MUL = 1.15;

// Stamina is INTEGER units, not seconds, and that is a correctness requirement rather
// than a style choice. The per-recipient `self` blob rounds floats through r3() at up to
// 0.0005 error, which velocity tolerates because it feeds a continuous integrator.
// Stamina does not: it feeds THRESHOLD comparisons that swing the speed cap by 15%. One
// tick of drain is 1/240th of the bar, so 0.0005 of float error is 12% of a tick and the
// tick on which the client believes the bar hits zero can be one tick off the server
// -- after which the replay runs from a different velocity and never comes back.
// Integers survive JSON bit-exact, so both sides cross every threshold on the same tick.
//
// MAX must stay divisible by both rates, or a duration stops being a whole number of
// ticks and the suite says so. 720 = 3 x 240 = 2 x 360.
export const SPRINT_STAMINA_MAX = 720;
/** Units drained per sprinting tick. 720/3 = 240 ticks = 4.000s from full to empty. */
export const SPRINT_DRAIN = 3;
/** Units regained per resting tick. 720/2 = 360 ticks = 6.000s from empty to full. */
export const SPRINT_REGEN = 2;
/** Ticks after sprinting stops before regen starts. 60 = 1.000s. */
export const SPRINT_REST_TICKS = 60;
/** Sprint cannot re-engage below this once exhausted -- 25% of MAX. Hysteresis, so a
 *  player who runs the bar flat cannot stutter-sprint one tick at a time at 1%. */
export const SPRINT_MIN_START = 180;
// Jump arc: height = JUMP_VEL^2 / 2G = 1.54u, airtime = 2*JUMP_VEL/G = 0.72s.
//
// Was 6.2, for a 0.80u apex, and the report was "the jump is so low you can[t] even jump
// on some low objects lol" — correctly: the shortest piece of cover in the map is 1.4
// tall, so a plain jump could not mount a single solid in the arena. It now clears 1.4
// with 0.14u to spare, which is 0.22s of airtime spent above the crate.
//
// Ducking in mid-air is worth another 0.7u on top of the arc, because the body shrinks
// 0.35u and crouchStep() keeps the HEAD still rather than the feet, so the feet come up
// by twice the shrink. That is the CS2 crouch-jump and it is deliberate, but it means the
// height a player can reach is 2.24u on paper — 2.17u simulated through movement.js, the
// difference being the 0.14s the crouch takes to blend — and not the 1.54 above. The map's
// cover heights are chosen against that number, not against the apex. See map.js, and
// verify.mjs Part A, which used to audit against the apex alone and so passed while two
// crates in the shipped map were already ladders onto a divider top.
//
// Gravity is unchanged at 24. Raising it alongside the jump would hold the 0.52s airtime,
// but it also steepens every fall in the game to buy back hang time that at 0.72s is
// still short of CS2's.
export const GRAVITY = 24.0;
export const JUMP_VEL = 8.6;
export const MAX_FALL_SPEED = 60.0;
/** Max ledge height walked over without jumping. Stair risers must be under this. */
export const STEP_HEIGHT = 0.35;

export const PITCH_LIMIT = Math.PI / 2 - 0.02;

// ---------------------------------------------------------------- combat
export const MAX_HP = 100;

/**
 * How long a freshly-spawned player cannot be hurt, in ms.
 *
 * "we should have like death protection seconds after spawn in that way you cant just
 * die after spawn lol" — and in a deathmatch on a 44-unit arena that is not a small
 * problem. Eight spawn points and ten players means you regularly arrive inside
 * somebody's line of fire with no idea which way the fight is, and dying before the
 * first frame you could have reacted to is the one death that teaches nothing.
 *
 * Two seconds is deliberate: long enough to read the room, turn, and pick a direction,
 * short enough that it is over before you could cross the map with it. It is a shared
 * constant rather than a server one because the client draws the shield and has to stop
 * drawing it at exactly the same moment the server stops honouring it.
 */
export const SPAWN_PROTECT_MS = 2000;

// Damage, fire rate, range and spread used to live here as one global set. They are
// now per-weapon in shared/weapons.js, and respawn timing is per-mode in
// shared/modes.js. They are deliberately NOT re-exported as aliases: a weapon rule
// with two homes is a weapon rule that drifts.

/**
 * Most AI opponents a room will hold.
 *
 * Nine, so a full room of bots is 9 + you — the size the eight spawn points and this
 * arena were tuned for. It is a shared constant rather than a server one because the
 * client's own slider has to be clamped to the same number: a menu offering twenty
 * bots for a server that seats nine is a menu that lies.
 */
export const MAX_BOTS = 9;

// ---------------------------------------------------------------- input bits
export const BTN_JUMP = 1 << 0;
export const BTN_FIRE = 1 << 1;
/** Plant / defuse. Held, not tapped — the objective modes time how long. */
export const BTN_USE = 1 << 2;
export const BTN_RELOAD = 1 << 3;
// Crouch and walk are HELD modifiers and they change movement, so unlike the scope
// they cannot be client-only: the server's copy of stepPlayer needs them or
// prediction diverges the moment you duck.
export const BTN_CROUCH = 1 << 4;
export const BTN_WALK = 1 << 5;
/** Right mouse. What it does is per-weapon (`alt` in shared/weapons.js) — for most
 *  weapons, nothing at all. It reaches the server because a lobbed throw leaves the
 *  hand on a different arc, and only the server creates projectiles. */
export const BTN_ALT = 1 << 6;
/** Sprint. Level-triggered like crouch and walk, for the reason given above them: the
 *  server runs the same stepPlayer and needs the bit or prediction diverges the moment
 *  you sprint. The tap-versus-hold discrimination is entirely client-side -- input.js
 *  decides which of BTN_WALK and BTN_SPRINT to assert, and the server never learns that
 *  one key produced both. */
export const BTN_SPRINT = 1 << 7;

// ---------------------------------------------------------------- palette
// Defined once; everything on screen is one of these. Daylight, not night —
// a dark arena reads as murky rather than atmospheric, and it hides the one
// thing a player most needs to see: which geometry is climbable.
//
// These are ALBEDOS, not final pixels. three.js converts them sRGB→linear, then
// lighting multiplies by roughly 1.55 on a sun-facing face and 0.62 on a shaded
// one. So a mid-grey here renders ~0xE6 on top and ~0x98 on the sides, and that
// per-face spread *is* the art style. Push these much past 0xC0 and the lit faces
// clip to white, the spread collapses, and the whole look goes flat.
export const PALETTE = {
  bg: 0xc3d0e2, // sky + fog; unlit, so it renders as-is
  floor: 0x8e99a9, // the ground sits below the walls in value, or nothing grounds
  wallA: 0xbcc4d1, // primary structure: outer walls, platform slabs
  wallB: 0x9aa5b6, // cover you cannot climb
  stair: 0x76839a, // cover you CAN climb — deliberately its own value
  accent: 0xc93a24, // enemies, in the modes without teams
  self: 0x0f7f68, // you
  visor: 0x1b2130, // the one dark colour left; avatars need a readable face
  // Team colours never share a frame with `accent`, so the closeness of teamB to
  // it costs nothing. What they must do is separate from each other at distance
  // and under fog, which is why one is cool and one is warm rather than two hues.
  teamA: 0x2f6fb5,
  teamB: 0xd07a1e,
  // Spawn protection, on both the HUD readout and the ring around a protected avatar.
  // Kept out of the team/accent family on purpose: it has to read as a *state* rather
  // than as another side, so it is the one saturated cyan in the file and nothing else
  // in the scene competes with it. Mirrored as `--sp-col` in client/index.html.
  shield: 0x3cc8e6,
};

export const NET_PORT = 8080;
