// Weapon definitions as data, imported by BOTH sides: the server for damage, fire
// rate and range, the client for the viewmodel, HUD and audio. Keeping them in one
// table is the same discipline shared/movement.js follows — there is no second
// place for a weapon rule to live and drift out of step.
//
// Weapons cross the wire as an INDEX into WEAPON_IDS, so sanitizeInput can clamp it
// to a valid range exactly like it clamps moveX. A client cannot name a weapon that
// does not exist, and the mode's loadout decides which it may actually hold.

import * as C from './constants.js';

/** Wire order. Append only — inserting shifts every connected client's index. */
export const WEAPON_IDS = [
  'knife',
  'pistol',
  'rifle',
  'sniper',
  'grenade',
  'snowball',
  // Appended, in this order, when the arsenal grew from four weapons to ten. The six
  // above keep the indices they shipped with; anything new goes on the end forever.
  'smg',
  'lmg',
  'semi',
  'shotgun',
  'flash',
  'smoke',
];

/**
 * The three places a bullet can land on a body. Crosses the wire on EV.HIT as `z`, so
 * the client can say WHICH it was rather than only that something connected.
 *
 * BODY is 0 because it is the ordinary case and the field is omitted when zero — one
 * HIT event goes out for every round that connects in the room, and the common one
 * should not pay for the rare one.
 */
export const HIT_ZONE = { BODY: 0, HEAD: 1, LEGS: 2 };

/**
 * What each zone multiplies a weapon's damage by, indexed by HIT_ZONE.
 *
 * "we dont have hitboxes like head/body stuff" — one flat number for a body was the
 * whole of it, so where you aimed on a target could not matter and the only thing
 * separating two weapons was how fast they emptied.
 *
 * HEAD is 4x, which is CS2's number and is deliberately enormous: with a 25-damage
 * rifle it is a one-tap, and a one-tap is what makes aiming at a head worth the risk of
 * missing a body you would otherwise have hit. It is affordable only because the head
 * box is small — see HEAD_HALF_W, 45% of the body's width — so this multiplier is paid
 * out for precision rather than for pointing in the right direction.
 *
 * LEGS is 0.85 and is the honest cost of the above: the sniper's 100 stops being a
 * guaranteed one-shot, because 85 to a leg is a target that walks away. That is the
 * trade CS2 makes with the AWP and it is what makes a body shot a thing you aimed for.
 *
 * MELEE IS EXEMPT, in `shotDamage` rather than here. A knife does not have a headshot —
 * it has a heavy stab, which is already the knife's answer to "commit for more damage",
 * and a 220-damage slash to the top of a head would be a joke at the game's expense.
 */
export const HIT_ZONE_MUL = [1, 4, 0.85];

// ── accuracy, and what it costs to move
//
// "while pistol you just sprint while shooting" — nothing anywhere read velocity for
// accuracy, so a full sprint fired with exactly the cone of a player stood perfectly
// still. That is the single biggest reason the pistol outgunned real weapons: it had a
// rifle's precision for free while moving faster than one.
//
// The multiplier is applied to `spread` in resolveShot and drawn on the crosshair by
// hud.bloom, so what the cone does and what you see it do come from this one function.

/**
 * Spread multiplier at a full run, on top of 1. SQUARED against speed rather than
 * linear, which is what makes the curve teachable: a slow creep is nearly free, a walk
 * costs some, and a sprint is ruinous. Linear would tax every small adjustment step by a
 * third and turn every fight into a standing contest.
 *
 *   still            1.00x   (exactly today's behaviour — nothing a stationary player
 *                             does changes, which is why every existing test still holds)
 *   crouched still   0.60x   the reward for planting yourself
 *   walk  (0.52)     2.62x
 *   run   (1.00)     7.00x
 *   sprint(1.15)     8.94x
 *
 * At 8.94x a sprinting pistol throws a 2.0-degree cone: 0.72u of radius at twenty
 * units, against a body 0.80u wide. Sprint-firing now misses about as often as it hits,
 * which is the whole of the complaint answered by one number.
 */
const MOVE_SPREAD = 6;

/**
 * Flat addition while airborne, and the largest of the three because a jumping shot has
 * no business landing. Combined with a run it is 15x — a 3.4-degree cone on a pistol,
 * which is a coinflip at ten units.
 */
const AIR_SPREAD = 8;

/** How much a full crouch tightens the cone. The counterpart to MOVE_SPREAD: if moving
 *  is going to cost accuracy then planting has to buy some, or the only lesson is "do
 *  not move" rather than "stop to shoot". */
const CROUCH_TIGHTEN = 0.4;

// -- the scope, and what it costs not to use one
//
// "i notice how crazy hard to play with sniper ... i think we should copy how sniper
// behaves uin cs2". The gun's cone was NOT what made it hard -- 0.0008 rad is a third of a
// body's width at fifty units and it was that whether the scope was up, half up, or in the
// player's pocket. Which is the real problem, backwards: a sniper that shoots the same from
// the hip as it does through the glass is a sniper with no reason to scope, so the whole
// mechanic the weapon is built around was decoration.
//
// CS2's model, and now this one: perfect through the glass once it has settled, a short
// window after scoping in where it has not, worse on the second zoom, and hopeless from the
// hip. The three numbers below are that model. Only a weapon with `alt: 'scope'` reads any
// of them, so nine weapons out of twelve are untouched by this whole block.

/**
 * How much wider a scoped weapon's cone is when it is fired from the HIP.
 *
 * The AWP's no-scope in CS2 is not a hard shot, it is a lottery, and the ratio there is
 * north of 300x. 40 is deliberately gentler and still says the same thing: 0.0008 rad
 * becomes 0.032, against the 0.040 a body subtends at ten units. So a no-scope in
 * somebody's face is about a coin flip, at twenty units it is a quarter of one, and
 * past that it is not a shot anybody should be taking.
 *
 * This is the number that makes the scope worth opening, and it is why the two below can
 * exist at all: without a hip cone to be better than, "settled" means nothing.
 */
const HIP_SPREAD = 40;

/**
 * How long the glass has to be STILL before the cone is at its tightest, in ms.
 *
 * CS2's quick-scope-versus-slow-scope window: whoever holds the angle has already paid it
 * and whoever swings onto it has not, which is the reason a pre-aimed AWP beats a flick.
 *
 * Eased in QUADRATICALLY (see `scopeSpread`) rather than linearly, so most of the DROP
 * happens in the first half of the window. A linear ramp is the harsher one — it holds
 * the cone near hip width for far longer — and this weapon needed the forgiving curve.
 *
 * 100ms, DOWN FROM 120 after play showed that every other sniper penalty already made the
 * opening unusually unforgiving. At 200
 * the freshly-scoped cone is 80cm across at 25m and a player is 80cm wide, so the first
 * shot of every scope was a coin toss against a standing target; a PISTOL stands at 10cm
 * at the same range and fires every 135ms against this weapon's 1200ms. That is the whole
 * of "you get outgunned by a pistol": not the damage, not the cadence, but a scope that
 * was less accurate than a sidearm for the first eighth of a second it was open, backed by
 * a 1.2s penalty for the miss it caused. 100ms keeps a real settle but gives a planted quick
 * scope its answer one frame earlier on many displays.
 *
 * Exported because `scopeStep` in shared/movement.js clamps the timer to it: the settle
 * now runs DOWN while the player is asking to move, and a decay needs a ceiling to decay
 * from or standing still for a minute would buy a minute of accurate running.
 */
export const SCOPE_SETTLE_MS = 100;

/**
 * What the SECOND zoom costs on top of the first.
 *
 * CS2 does this too -- the scoped inaccuracy indicator visibly widens on a double scope --
 * and it is most of why professional play barely uses one: the extra magnification buys
 * you a bigger picture of a target you are now slightly less likely to hit. Modest on
 * purpose. It should be a reason to prefer the first zoom, not a reason to never use the
 * second.
 */
const SCOPE_STEP_SPREAD = 1.35;

/**
 * The cone multiplier the scope itself contributes: 1 for every weapon without one.
 *
 * Takes the weapon id rather than reading it off the player, because the player state
 * carries an INDEX and a state that has been through a snapshot may not carry the loadout
 * to resolve it against. `spreadMul`'s callers all know which weapon they are asking
 * about; none of them should have to know how a scope is spelled.
 *
 * `s.scopeMs` is the time this scope has been open, accumulated by `stepPlayer` on both
 * sides of the wire — so this is part of the shared simulation and the crosshair, the
 * server's cone and the client's prediction cannot disagree about it. A state with no
 * such field (an older snapshot, a spectator target that appeared this frame) reads 0,
 * which is the honest answer for something we have just started watching: unsettled.
 */
function scopeSpread(s, wepId) {
  if (!wepId || !scopes(wepId)) return 1;
  const step = Math.max(0, Math.min(zoomStepCount(wepId), s.scope ?? 0));
  if (step <= 0) return HIP_SPREAD;
  // 1 at the instant the glass comes up, 0 once the window has run.
  const green = 1 - Math.min(1, (s.scopeMs ?? 0) / SCOPE_SETTLE_MS);
  const zoom = step > 1 ? SCOPE_STEP_SPREAD : 1;
  return (1 + (HIP_SPREAD - 1) * green * green) * zoom;
}

/**
 * How much wider this shooter's cone is right now than the weapon's own `spread`.
 *
 * Reads a player state rather than a set of numbers so the server and the client's
 * crosshair cannot pass it different arguments. `grounded === false` rather than
 * `!s.grounded`: a partial state — a spectator target that appeared this frame, an older
 * snapshot — is missing the field rather than airborne, and the forgiving direction for
 * a missing field is the ground.
 *
 * `wepId` is OPTIONAL, and what it buys is the scope: pass it and a scoped weapon's cone
 * also reflects whether the glass is up and how long it has been (see `scopeSpread`),
 * leave it out and only the body terms apply. Optional rather than required because the
 * body terms are the whole answer for nine of the twelve weapons and every caller that
 * predates the scope model was asking about one of them — a required argument would have
 * turned "the sniper now punishes a no-scope" into a change to every crosshair in the game.
 */
export function spreadMul(s, wepId = null) {
  const v = Math.hypot(s.vx ?? 0, s.vz ?? 0) / C.MOVE_SPEED;
  const air = s.grounded === false ? AIR_SPREAD : 0;
  const body = (1 + MOVE_SPREAD * v * v + air) * (1 - CROUCH_TIGHTEN * (s.crouch ?? 0));
  return body * scopeSpread(s, wepId);
}

/** `mag: null` means the weapon has no magazine at all, which is distinct from a
 *  magazine that happens to be empty. It reaches the HUD as null too, so the ammo
 *  readout renders nothing rather than a misleading 0. */
/**
 * `alt` is what RIGHT-CLICK does, and the absence of it is meaningful: a weapon
 * with no `alt` ignores the button completely.
 *
 * This exists because right-click used to be a global mode rather than a weapon
 * property — the viewmodel pulled *every* weapon to the centre of the screen and
 * the mouse slowed down for *every* weapon, so a knife "scoped". No shooter works
 * that way; the button belongs to the gun, not to the player. Three verbs:
 *
 *   'scope' — optical zoom. Requires a non-empty `zoomFovs`, so the two can never
 *             disagree; the array's length is how many steps a click cycles through.
 *   'lob'   — a short high underhand throw. Does NOT centre the weapon and does
 *             not touch the FOV or the mouse; it only changes the release arc.
 *   'heavy' — a slower, harder attack. Requires a `heavy` block of stat overrides.
 *
 * `slot` is the CS2 number-key layout: 1 primary, 2 secondary, 3 knife, 4 thrown.
 * Selection goes through the slot rather than through a position in the mode's
 * loadout list, so "3 is always the knife" holds no matter what else you are
 * carrying — which is the entire point of muscle memory.
 *
 * `recoil` is present only on weapons that kick, and its absence means exactly that:
 * a thrown snowball does not punch your aim. Four numbers, all radians except `ramp`:
 *
 *   up   — vertical punch per shot. This moves the AIM, not just the picture: the
 *          client adds it to the yaw and pitch it sends, so the shot goes where the
 *          crosshair has been pushed to. Recoil you can see but that does not change
 *          where you hit is a screen-shake, and a screen-shake teaches nothing.
 *   side — how far the pattern wanders sideways once it gets going.
 *   ramp — shots the wander takes to reach full width. The first rounds climb almost
 *          straight up, so tapping stays precise and spraying is a skill you learn
 *          the shape of. That single property is most of what makes a CS rifle a CS
 *          rifle, which is why it is data here rather than a constant somewhere.
 *   max  — the ceiling the accumulated punch saturates at. This is the property that
 *          makes recoil *felt* rather than merely present. With recovery running
 *          between every shot the punch never got past one round's worth — about a
 *          degree and a half on the rifle — and the honest report was "i cant even
 *          feel the recoil". Now the punch holds while the trigger is down (see
 *          RECOIL_HOLD_MS) and stacks up to this cap, so a rifle spray climbs 17° and
 *          you have to pull down through it exactly like CS2. The cap is per weapon
 *          because it is the top of that gun's pattern, and a pattern with no top is
 *          a gun that ends up aimed at the sky.
 *
 * `auto` is whether HOLDING the trigger keeps firing. False means one round per click,
 * enforced on the server off an edge-triggered latch (`fireHeld` in server/room.js) for
 * the same reason jumping is: the client holds the button down for as long as the mouse
 * is down and cannot be the thing that decides a click ended. Every weapon declares it
 * — there is no default — because "which guns are automatic" is the single question
 * that separates a pistol from a rifle and it should be answerable by reading the table.
 *
 * `pellets` fires one shot as N independent traces from the same eye through the same
 * cone, each doing `dmg`. Only the shotgun has it; everything else fires a single
 * trace, which `pellets: 1` says explicitly rather than by omission.
 *
 * `util` marks a thrown weapon that does no damage at all. Bots read it and decline to
 * throw one — a bot that answers a firefight with a smoke grenade is a bot that dies
 * holding it.
 *
 * `jam` is the chance PER ROUND FIRED that the action fails to cycle and the weapon
 * stops until the character clears it by hand. "i think we should add a random gun
 * jamming where the character will try to unjam it but punching the gun using its other
 * hand". Like `recoil`, its absence is meaningful: only guns jam. A knife has no action
 * to fail and a thrown grenade has no action at all, so neither declares one — the ask
 * was "all the guns", and a jammed snowball would be a joke at the game's expense.
 *
 * The numbers are small on purpose, and the useful way to read them is 1/p = rounds
 * between jams: pistol and semi 125, rifle 100, smg 83, lmg and shotgun 71, sniper 200.
 * Against each weapon's magazine that puts a rifle jam every three or four mags, an lmg
 * jam somewhere inside most belts (it is belt-fed, it should be the worst of them), and
 * a sniper jam once in forty magazines — the sniper is lowest because a stoppage on a
 * weapon that already fires once a second is the most expensive one in the game.
 *
 * The roll happens AFTER the round has left the barrel, not instead of it. A stoppage
 * that ate the shot as well as the time would mean a jam at the start of a duel is a
 * duel you never fired in; failing to eject the case you just fired is both the more
 * common real fault and the forgiving direction.
 *
 * `falloff` is how much of `dmg` survives the flight, and its absence is as meaningful
 * as `recoil`'s. "no distance falloff damage" — every weapon did full damage at every
 * range inside its own, so a pistol landing a shot at eighty units hurt exactly as much
 * as one landing at two, and `range` was a binary cliff rather than a curve. Two numbers:
 *
 *   start — full damage out to here. Inside it nothing has changed at all.
 *   min   — the fraction left at the weapon's `range`, falling off linearly between.
 *
 * Multiplied BEFORE the zone multiplier (see `shotDamage`), which is what makes the two
 * systems compose instead of fight: a pistol headshot at point-blank is 120 and a one-tap,
 * the same headshot at 120u is 54 and is not. Distance decides what the weapon is worth
 * and the zone decides what your aim was worth, in that order.
 *
 * THREE WEAPONS DECLINE IT, and each for a stated reason rather than by oversight:
 *
 *   sniper  — 100 at every range is the entire point of the weapon. It is the one gun
 *             whose headline number is a promise, and a curve would quietly break it.
 *   shotgun — its falloff is already the geometry. `spread` is 0.052 and eight pellets
 *             diverge, so a target at 25u eats two or three instead of eight; a damage
 *             curve on top would be charging twice for the same distance.
 *   knife   — reaches 2.2u. There is no distance for it to fall off over.
 */
export const WEAPONS = {
  knife: {
    label: 'KNIFE',
    kind: 'melee',
    dmg: 55,
    intervalMs: 480,
    range: 2.2,
    spread: 0,
    mag: null,
    reloadMs: 0,
    slot: 3,
    auto: false,
    pellets: 1,
    // Right-click is the heavy stab, NOT a scope — scoping a knife was the
    // complaint, but doing nothing at all is not the fix. The CS2 trade: commit to
    // a slow wind-up and you get a two-hit kill instead of a four-hit one.
    alt: 'heavy',
    heavy: { dmg: 90, intervalMs: 1000, range: 2.6 },
  },
  pistol: {
    label: 'PISTOL',
    kind: 'hitscan',
    // Was 34, which is a three-shot kill: 220ms against the rifle's 390ms, the fastest
    // time-to-kill in the table by a wide margin and on the weapon with the second
    // tightest cone. "no matter how good you are some guns will get outgun by pistol
    // which makes no sense."
    //
    // 25 is a four-shot kill in 405ms at the fastest legal click rate, just behind the
    // rifle's 390ms. The sidearm is a strong finish and a fast draw, not the best primary
    // in the room. A close headshot still earns a one-tap through the shared 4x zone rule.
    dmg: 25,
    // The ceiling on the trigger, NOT the cadence — "the pistol is so slow! the pistol
    // firing speed should follow the speed how fast you click". At 260 it was the other
    // way round: 260ms is 231 RPM, slower than any CS2 sidearm, so the interval was the
    // thing setting the rate and clicking faster did nothing at all. 135ms is 444 RPM,
    // around the edge of what a human sustains, so the CLICK is normally the limit and the
    // number here only exists to stop an autoclicker or an edited client running away
    // with it. 135ms keeps a fast human cadence while leaving the rifle a narrow advantage.
    //
    // This deliberately crosses below RECOIL_HOLD_MS (170), and that is the trade rather
    // than an oversight: spam the trigger and the shots land inside the hold window, so
    // the punch stacks to the pistol's `max` and the muzzle climbs; pace them slower
    // than 170ms and recovery runs between rounds and every shot is placed from a
    // settled aim. Fast is available, free is not — which is exactly how a CS2 pistol
    // rewards tapping over spraying.
    intervalMs: 135,
    range: 120,
    // Hard and early, and the single biggest correction in this table. A pistol is a
    // close-range weapon that had a 120u reach at full power; past 12u it now bleeds to
    // 45%, so the shot that used to trade evenly with a rifle across the map does 11.
    falloff: { start: 12, min: 0.45 },
    spread: 0.005,
    mag: 12,
    reloadMs: 1200,
    slot: 2,
    // One round per click. This is a CS2 pistol and it was firing like an SMG when
    // you held the button — the report was "pistol should not fire when you hold
    // left it is one bullet per click since it is not automatic like rifle".
    auto: false,
    pellets: 1,
    alt: null,
    // Snappier than the rifle per shot, and it settles between them at any paced
    // cadence — so a pistol rewards pacing rather than pattern memory. The low cap says
    // the same thing: even spammed there is not much of a pattern here to climb, only
    // about five degrees of it, and then a flick per shot.
    recoil: { up: 0.028, side: 0.011, ramp: 3, max: 0.09 },
    // A simple blowback sidearm, and with the semi the most reliable thing in the
    // table: 125 rounds between stoppages, which is ten magazines.
    jam: 0.008,
  },
  rifle: {
    label: 'RIFLE',
    kind: 'hitscan',
    dmg: 25,
    intervalMs: 130,
    range: 200,
    // The reference weapon, so the gentlest curve of the five that have one: full
    // damage across most of a 64u arena and 75% at the 200u it can technically reach.
    falloff: { start: 45, min: 0.75 },
    spread: 0.006,
    mag: 30,
    reloadMs: 1900,
    slot: 1,
    auto: true,
    pellets: 1,
    alt: null,
    // The one with a learnable spray: eight rounds of climb before the wander opens
    // up, it does not recover between shots at 130ms, and it tops out around 17° —
    // far enough that holding the trigger without pulling down is a wasted magazine.
    recoil: { up: 0.032, side: 0.014, ramp: 8, max: 0.3 },
    // One jam every 100 rounds — three or four magazines, so it is something you
    // have felt without it ever being what the weapon is about.
    jam: 0.01,
  },
  sniper: {
    // 100 is a one-shot body kill. That is the intended feel for sniper match, and
    // it is the most aggressive number in this table — the first dial to turn if
    // the mode plays too harshly.
    label: 'SNIPER',
    kind: 'hitscan',
    dmg: 100,
    intervalMs: 1200,
    range: 250,
    // The cone THROUGH SETTLED GLASS, which is what this number always was and never
    // said: `spreadMul` now multiplies it by 40 from the hip and eases that down over
    // the 100ms after the scope opens (see HIP_SPREAD). So the pinpoint is still here,
    // it just has to be earned by scoping and settling for a beat — the
    // CS2 bargain, and the reason the weapon has a scope at all.
    spread: 0.0008,
    mag: 5,
    reloadMs: 2600,
    slot: 1,
    // Bolt-action in everything but name: one round per click, no exceptions.
    auto: false,
    // ...and now bolt-action in name too. `cycleMs` is how long the hand spends working
    // the action after a shot: it is what the 1200ms interval has always been *made of*
    // and never showed. "you dont reload each time it shots but you cocking the gun thats
    // the missing for sniper each shot."
    //
    // Cosmetic by construction — see `cycleMsOf`. `intervalMs` still owns the cadence, so
    // this number cannot change what the weapon does, only what you see it do.
    cycleMs: 780,
    pellets: 1,
    // Two optical zooms, click-cycled like a CS2 AWP: unscoped → first → second →
    // unscoped. Neither is the old 22° tunnel that made targets vanish on a small
    // mouse move; the first is a gentle magnification you can still track a runner in,
    // the second closes it down for a held long-range shot. `scopes()` keys off the
    // presence of this array, so a weapon either declares its zoom steps or has none.
    zoomFovs: [55, 30],
    alt: 'scope',
    // A single heavy shove that is fully recovered long before the next round is
    // chambered. There is no pattern to learn on a weapon that fires once a second —
    // there is only the shove, and it has to be felt.
    recoil: { up: 0.075, side: 0.014, ramp: 1, max: 0.1 },
    // The lowest in the table. A stoppage on a bolt gun that already fires once a
    // second costs more than on anything else, so it is once in forty magazines.
    jam: 0.005,
    // How far a BOT holds off while carrying this, overriding ai.js's global band.
    //
    // "i notice how crazy hard to play with sniper". This line is most of the answer.
    // The global band is 6 to 14 units, which is knife range, and it is where a bot's
    // settled aim error of 0.012 rad sits well inside the 0.040 a body subtends — so
    // nine bots each holding a one-shot rifle walked into your face and could not miss,
    // while the scope you had just opened was showing you a wall. It was not a sniper
    // duel, it was a knife fight where you were the only one without a knife.
    //
    // 18 to 40 is the range this weapon is FOR: 0.012 rad is 0.22u of error at 18 and
    // 0.48u at 40, against a 0.4u half-width — so a bot still threatens at the near
    // edge and genuinely has to aim at the far one, and both ends are far enough away
    // that opening the glass is the right move rather than a death sentence.
    hold: [18, 40],
  },

  // ── the rest of the arsenal
  // The playtest asked for "types of guns like rifle, semi, machine gun, pistol,
  // shotgun". These are those types, and the point of each one is a different answer
  // to the same question — how do you trade accuracy for volume of fire:
  //
  //   smg     cheap volume up close, useless past the middle of the map
  //   lmg     the most rounds in the game and the widest cone; suppression
  //   semi    one accurate round per click at rifle range; punishes tapping badly
  //   shotgun eight pellets at once, lethal inside 10u and harmless past 30
  //
  // All four sit in slot 1 alongside the rifle and the sniper, so pressing 1 cycles
  // whatever primaries you happen to be carrying.
  smg: {
    label: 'SMG',
    kind: 'hitscan',
    dmg: 18,
    intervalMs: 80,
    range: 110,
    // "useless past the middle of the map" is what the block comment above has always
    // claimed about the smg, and nothing enforced it. Now it does: 40% past 15u, which
    // is 7 damage a round and six seconds of sustained fire to kill anybody.
    falloff: { start: 15, min: 0.40 },
    spread: 0.011,
    mag: 30,
    reloadMs: 1500,
    slot: 1,
    auto: true,
    pellets: 1,
    alt: null,
    // Fast, small kicks that pile up quickly and wander early — the cone opens before
    // the climb finishes, which is why an SMG loses a long-range duel it starts ahead.
    recoil: { up: 0.018, side: 0.016, ramp: 12, max: 0.22 },
    // Cheap and dirty: 83 rounds, the price of the highest rate of fire here.
    jam: 0.012,
  },
  lmg: {
    label: 'MACHINE GUN',
    kind: 'hitscan',
    // Capacity and sustained pressure are the advantage. At 22 damage it needs five body
    // hits, so the hundred-round belt no longer also wins the opening duel against a rifle.
    dmg: 22,
    intervalMs: 110,
    range: 220,
    // Nearly the rifle's curve. Suppression is the point of the weapon and suppression
    // that stops working at range is not suppression.
    falloff: { start: 40, min: 0.70 },
    spread: 0.014,
    mag: 100,
    reloadMs: 4700,
    slot: 1,
    auto: true,
    pellets: 1,
    alt: null,
    // The highest ceiling in the table, over a hundred-round belt. Fired standing it
    // walks off the target entirely; the counterplay is that it takes five seconds to
    // reload, so making one empty is as good as killing it.
    recoil: { up: 0.026, side: 0.021, ramp: 14, max: 0.34 },
    // The worst of them, deliberately — a belt-fed gun carrying a hundred rounds
    // should stop somewhere inside most belts. 71 rounds between jams.
    jam: 0.014,
  },
  semi: {
    label: 'SEMI',
    kind: 'hitscan',
    // Three body hits, or one precise headshot. The old 58 made two body clicks kill in
    // 250ms, faster than every general-purpose automatic with none of their exposure.
    dmg: 45,
    intervalMs: 270,
    range: 240,
    // The flattest curve in the table, because reaching is what a semi is for: 80% at
    // 240u. It stays the most accurate primary, but the new 45 damage always asks for
    // three body hits rather than letting two clicks beat every automatic.
    falloff: { start: 60, min: 0.80 },
    spread: 0.002,
    mag: 10,
    reloadMs: 2100,
    slot: 1,
    auto: false,
    pellets: 1,
    alt: null,
    // A hard shove per round that has mostly recovered by the time the next click is
    // allowed. Three body shots are a kill, so the whole weapon is about whether you can
    // put the follow-ups on target while the first is still pushing you up.
    recoil: { up: 0.052, side: 0.013, ramp: 2, max: 0.14 },
    // As reliable as the pistol: 125 rounds.
    jam: 0.008,
  },
  shotgun: {
    label: 'SHOTGUN',
    kind: 'hitscan',
    // Per PELLET, not per shot. Eight of these is 136 at point-blank, and the spread
    // means a target at 20u eats two or three of them — the falloff is the geometry
    // rather than a damage curve, which is how a shotgun should work.
    dmg: 17,
    intervalMs: 850,
    range: 32,
    // Wide, and the one weapon where the cone is the whole design.
    spread: 0.052,
    mag: 8,
    reloadMs: 2900,
    slot: 1,
    auto: false,
    // Pump. Same contract as the sniper's bolt: cosmetic, and comfortably inside the
    // 850ms interval it is a part of. A pump gun that fires and then just sits there
    // between shots reads as a jam, which is the one thing it must not read as.
    cycleMs: 520,
    pellets: 8,
    alt: null,
    recoil: { up: 0.062, side: 0.022, ramp: 2, max: 0.16 },
    // Shell feed, 71 shells — nine magazines, but a magazine is only eight shells.
    jam: 0.014,
  },

  // Thrown weapons. Damage, blast radius, fuse and flight all live in
  // shared/projectile.js keyed by `proj` — a thrown weapon's damage depends on how
  // far from the blast you were, which this table has no way to express. `dmg: null`
  // rather than 0 so nothing reads a number here and believes it.
  grenade: {
    label: 'GRENADE',
    kind: 'projectile',
    proj: 'grenade',
    dmg: null,
    intervalMs: 900,
    range: 0,
    spread: 0,
    mag: 2,
    reloadMs: 0,
    slot: 4,
    auto: false,
    pellets: 1,
    alt: 'lob',
  },
  snowball: {
    label: 'SNOWBALL',
    kind: 'projectile',
    proj: 'snowball',
    dmg: null,
    intervalMs: 380,
    range: 0,
    spread: 0,
    mag: null,
    reloadMs: 0,
    slot: 4,
    auto: false,
    pellets: 1,
    alt: 'lob',
  },
  // Utility. Neither of these takes a hit point off anybody; what they do is in
  // shared/projectile.js under `effect`, and `util` is how everything else — the bot's
  // weapon scoring above all — knows not to treat them as a way of killing someone.
  flash: {
    label: 'FLASHBANG',
    kind: 'projectile',
    proj: 'flash',
    dmg: null,
    intervalMs: 800,
    range: 0,
    spread: 0,
    mag: 1,
    reloadMs: 0,
    slot: 4,
    auto: false,
    pellets: 1,
    util: true,
    alt: 'lob',
  },
  smoke: {
    label: 'SMOKE',
    kind: 'projectile',
    proj: 'smoke',
    dmg: null,
    intervalMs: 800,
    range: 0,
    spread: 0,
    mag: 1,
    reloadMs: 0,
    slot: 4,
    auto: false,
    pellets: 1,
    util: true,
    alt: 'lob',
  },
};

/** True only for weapons whose right-click is an optical zoom. Read by the
 *  viewmodel (pose + overlay), the camera (FOV) and the mouse (sensitivity), so all
 *  three answer the same question from the same place and cannot drift apart. */
export const scopes = (id) => WEAPONS[id]?.alt === 'scope' && zoomStepsOf(id).length > 0;

/**
 * The zoom levels this weapon's scope cycles through, narrowest last. Empty for
 * everything without a scope, so a caller can `.length` it rather than knowing which
 * weapons have one.
 *
 * A scope is a click-toggle rather than a held button — "it should be like awp in cs2
 * where you can do double scope aswell just one clicking no holding the right click".
 * Holding right-click to stay zoomed is exactly the thing that makes a sniper
 * unplayable: the hand that holds the scope open is the hand that has to stay still,
 * and CS2 has never worked that way. The cycle is unscoped → [0] → [1] → unscoped, so
 * the same button that opens the scope also closes it and no separate key is needed.
 */
export const zoomStepsOf = (id) => WEAPONS[id]?.zoomFovs ?? [];

/** How many scope steps a weapon has, 0 for one without a scope. */
export const zoomStepCount = (id) => zoomStepsOf(id).length;

/** True for weapons whose right-click is a harder attack rather than a pose. */
export const hasHeavy = (id) => WEAPONS[id]?.alt === 'heavy' && !!WEAPONS[id]?.heavy;

/**
 * Does holding the trigger keep this weapon firing?
 *
 * Defaults to FALSE for an unknown id, which is the safe direction: a weapon that has
 * fallen out of the table firing once per click is a bug you can play through, and one
 * that empties itself on a held button is not.
 */
export const isAuto = (id) => WEAPONS[id]?.auto === true;

/** Traces this weapon puts in the air per shot. One for everything but the shotgun. */
export const pelletsOf = (id) => Math.max(1, WEAPONS[id]?.pellets ?? 1);

/** A thrown weapon that does no damage — a flashbang or a smoke. */
export const isUtil = (id) => WEAPONS[id]?.util === true;

/** This weapon's recoil, or null for one that does not kick. Asked as a question with
 *  an answer for every weapon, exactly like `scopes` — so no caller has to keep its
 *  own list of which weapons punch. */
export const recoilOf = (id) => WEAPONS[id]?.recoil ?? null;

/**
 * Chance per round fired that this weapon jams. 0 for anything that is not a gun.
 *
 * Zero rather than a default probability, so the failure mode of a weapon falling out
 * of the table is a gun that never jams rather than one that jams at somebody else's
 * rate. Same shape as `recoilOf`: every weapon has an answer and no caller keeps a list.
 */
export const jamChanceOf = (id) => WEAPONS[id]?.jam ?? 0;

/**
 * How long the character spends working the action after a shot, in ms. 0 for a weapon
 * that feeds itself.
 *
 * This is the missing half of a manually-cycled weapon. A bolt gun's 1200ms interval was
 * already the bolt being worked — the number was there, the gesture was not, so the sniper
 * looked like a rifle with a long cooldown and the only animation it ever played was a
 * magazine change ("you dont reload each time it shots but you cocking the gun").
 *
 * PURELY COSMETIC, and that is enforced below rather than promised here. Nothing on the
 * server reads it: `intervalMs` still decides when the next round may leave the barrel, so
 * this number cannot be tuned into a balance change by accident. What it must never do is
 * outlast the interval it is drawn inside — an animation still playing when the weapon is
 * ready again would show a bolt being worked on a round that has already been fired.
 */
export const cycleMsOf = (id) => WEAPONS[id]?.cycleMs ?? 0;

/**
 * The `[near, far]` range a BOT should try to fight at while holding this weapon, or null
 * for one with no opinion — which is every weapon but the sniper.
 *
 * Lives in the weapon table and not in ai.js on the same argument the rest of this file
 * makes: how far away a gun wants to be used is a fact about the gun. ai.js had one
 * global band for the whole arsenal, which is right for eleven weapons and catastrophic
 * for the twelfth (see the sniper's `hold`). Returning null rather than the global band
 * keeps that default in ai.js where its own reasoning is written down.
 *
 * Sanity-checked at import like `cycleMs`, because a band whose near edge is past its far
 * one makes a bot oscillate instead of hold, and nothing about watching it would say why.
 */
export const holdBandOf = (id) => {
  const b = WEAPONS[id]?.hold;
  return Array.isArray(b) && b.length === 2 && b[0] > 0 && b[1] > b[0] ? [b[0], b[1]] : null;
};

// Checked at import, where the dev server and `npm run verify` both hit it, because the
// failure is a visual desync that is hard to see and easy to introduce by lowering an
// interval. A cycle that runs the whole interval also leaves no still frame between
// shots, so the margin is a fifth rather than a hair.
for (const id of WEAPON_IDS) {
  const cm = cycleMsOf(id);
  if (cm > 0 && cm > WEAPONS[id].intervalMs * 0.8) {
    throw new Error(`${id} cycleMs ${cm} does not fit inside its ${WEAPONS[id].intervalMs}ms interval`);
  }
  // A declared band that `holdBandOf` refuses would be silently ignored, and a bot that
  // quietly falls back to knife range is the exact bug this whole change is undoing.
  if (WEAPONS[id].hold && !holdBandOf(id)) {
    throw new Error(`${id} hold ${JSON.stringify(WEAPONS[id].hold)} is not an ascending [near, far]`);
  }
  // A weapon that wants to be used past its own reach cannot be, and the bot would hold
  // an angle it can never shoot from.
  const band = holdBandOf(id);
  if (band && band[1] > WEAPONS[id].range) {
    throw new Error(`${id} hold far edge ${band[1]} is outside its ${WEAPONS[id].range}u range`);
  }
}

/**
 * How heavy this weapon is, 0 (lightest thing in the game) to 1 (heaviest).
 *
 * Derived from the deploy times rather than declared — see `heftOf`, which has to be
 * defined below SWITCH_OVERRIDES and so lives further down this file with it.
 */

/**
 * How long a jam takes the character to clear, in ms.
 *
 * One number for every weapon, for the same reason RECOIL_RECOVER is: this is the time
 * the player's off hand takes to hit the gun, not a property of the gun. Per-weapon
 * clear times would also be a second place for "how bad is a jam on this weapon" to
 * live, and that question is already answered by `jam` — a weapon that stops more often
 * is already the worse weapon to be holding.
 *
 * The value is set by what it has to communicate rather than by realism, and 700ms did
 * not do it: "i can see the jamming fix but it so fast like bruh". The gesture it has to
 * carry is four separate beats — the dead trigger, two palm strikes on the receiver, and
 * the action finally cycling — and at 700ms each of those got 175ms, which is at or below
 * the ~200ms it takes to recognise a gesture at all. You saw motion, not a malfunction
 * being fixed. 1400ms gives each beat about a third of a second, which is enough to read
 * the strike land and to see the hand return to the grip between them.
 *
 * Doubling it changes one balance property, and it is worth naming rather than burying:
 * every deploy time in SWITCH_OVERRIDES (max 900, the lmg) is now under the stoppage, so
 * bailing out to another weapon always beats waiting — where at 700 the lmg was
 * deliberately on the wrong side of that line. The trade is still real, because you also
 * pay to come back: swap out of a jammed lmg and returning to it costs another 900. What
 * has gone is the case where the answer to a stoppage was "there is no answer".
 *
 * For scale: it is a little over one magazine change, and about ten rifle shots.
 */
export const JAM_CLEAR_MS = 1400;

/**
 * How fast a punched aim returns, as an exponential rate per second.
 *
 * One value for every weapon, because it is a property of the player's arms rather
 * than of the gun. Deliberately slower than the rifle's own cadence: that is what
 * makes rounds accumulate into a climbing pattern instead of each one landing on a
 * fully-recovered aim, and it is the difference between recoil and a flicker.
 */
export const RECOIL_RECOVER = 7;

/**
 * How long after a shot recovery stays switched OFF, in ms.
 *
 * This is the property that turns recoil from a flicker into a pattern, and its absence
 * was the whole of "i cant even feel the recoil". Recovery used to run every tick, so
 * on the rifle each 0.03 rad kick had already decayed 40% before the next round landed
 * and the punch converged on 0.05 rad — three degrees, for a full magazine. Holding the
 * punch while the trigger is down lets the kicks stack to the weapon's `max` instead,
 * and recovery then takes the whole thing back the moment you stop.
 *
 * 170ms very nearly sorts the table by itself, which is why it is one number rather than
 * a per-weapon one: the rifle (130), smg (80) and lmg (105) all fire faster than this and
 * so accumulate, while the semi (250), shotgun (850) and sniper (1200) all fire slower
 * and so recover between rounds. That split is almost exactly the automatic /
 * semi-automatic split, and it falls out rather than being declared twice.
 *
 * The pistol is the one weapon that sits on BOTH sides of the line, and deliberately so.
 * Its interval is 110ms, but it is semi-automatic, so what decides the side is the
 * player's own clicking rather than the gun: spam it and the rounds land inside this
 * window and the punch stacks, pace it past 170ms and every shot is placed from a
 * settled aim. That is the whole reason the interval was allowed below this number when
 * the pistol was sped up — the cadence became the player's to choose, so the recoil
 * follows what they chose.
 */
export const RECOIL_HOLD_MS = 170;

/** The punch ceiling for a weapon with no `max` of its own. Only reached by something
 *  that kicks without declaring a top, which nothing in the table does — it exists so
 *  a future weapon cannot accidentally aim its owner at the sky. */
export const RECOIL_MAX_DEFAULT = 0.2;

/** How far the accumulated punch may climb on this weapon, in radians. */
export const recoilMaxOf = (id) => WEAPONS[id]?.recoil?.max ?? RECOIL_MAX_DEFAULT;

/**
 * Pre-merged heavy variants, so `shotStats` can hand back a weapon-shaped object
 * without allocating one per swing.
 *
 * Merging matters more than it looks: `resolveShot` reads `range` and `spread` off
 * whatever it is given, and the server reads `dmg` and `intervalMs`. Because the
 * heavy stab is a complete weapon entry rather than a special case threaded through
 * both, neither of them needs to know the alt button exists.
 */
const HEAVY = {};
for (const [id, w] of Object.entries(WEAPONS)) {
  if (w.heavy) HEAVY[id] = { ...w, ...w.heavy };
}

/** The stats a shot actually uses. Only weapons with a `heavy` block differ. */
export const shotStats = (id, altHeld) =>
  (altHeld && HEAVY[id]) || WEAPONS[id] || WEAPONS.rifle;

/**
 * Fraction of a weapon's damage left after flying `dist`. 1 for a weapon with no
 * `falloff`, which is how the sniper, the shotgun and the knife opt out.
 *
 * Linear between `start` and the weapon's own `range`, because the curve a player can
 * actually learn is the one they can describe: "half damage across the map" is a rule,
 * and an exponential is a feeling. Clamped at both ends so a pellet that somehow
 * resolves past `range` reads as `min` rather than going negative.
 */
export function falloffMul(w, dist) {
  const f = w?.falloff;
  if (!f) return 1;
  const end = w.range ?? 200;
  if (dist <= f.start) return 1;
  if (dist >= end) return f.min;
  return 1 - (1 - f.min) * ((dist - f.start) / (end - f.start));
}

/**
 * What one trace that connected is actually worth: base damage, scaled by how far it
 * flew, then by where on the body it landed.
 *
 * THE ONE PLACE the two new systems meet, so nothing downstream has to know the order
 * they apply in. Distance first and zone second — see the `falloff` notes above for why
 * that ordering is the point rather than an implementation detail.
 *
 * MELEE IS EXEMPT from the zone multiplier. A knife has a heavy stab, not a headshot;
 * `alt: heavy` is already its way of trading time for damage, and letting HIT_ZONE_MUL
 * turn a 90-damage committed stab into 360 would make the knife the best weapon in the
 * game against anybody tall enough to reach.
 *
 * Rounded to a whole number because hp is one, and floored at 1: a trace that connected
 * has to take something off, or the smg's worst case at maximum range is a weapon that
 * visibly hits and does nothing, which reads as a bug in the hit detection.
 */
export function shotDamage(w, dist, zone = HIT_ZONE.BODY) {
  if (w?.dmg == null) return 0;
  const zm = w.kind === 'melee' ? 1 : (HIT_ZONE_MUL[zone] ?? 1);
  return Math.max(1, Math.round(w.dmg * falloffMul(w, dist) * zm));
}

// A `start` at or past the weapon's own `range` is a falloff that never happens: the
// weapon reads as tuned and behaves as though the field were absent. A `min` outside
// (0, 1] is either a damage bonus at range or a bullet that heals. Both are silent in
// play and both are one typo away, so they are checked at import next to the `cycleMs`
// invariant above rather than trusted.
for (const id of WEAPON_IDS) {
  const f = WEAPONS[id].falloff;
  if (!f) continue;
  const r = WEAPONS[id].range;
  if (!(f.start < r)) throw new Error(`${id} falloff.start ${f.start} is not inside its ${r}u range`);
  if (!(f.min > 0 && f.min <= 1)) throw new Error(`${id} falloff.min ${f.min} is outside (0, 1]`);
}

/** CS2 number-key layout. 0 for anything unslotted, which no number key selects. */
export const slotOf = (id) => WEAPONS[id]?.slot ?? 0;

/**
 * The weapon a number key should select, given what the player is carrying.
 *
 * `from` is the index currently held: pressing a slot that holds more than one
 * weapon cycles within it rather than always snapping to the first. Deathmatch
 * hands out a single random primary, so in practice slot 1 holds one gun — but the
 * full loadout lists both rifle and sniper there, and silently ignoring the second
 * would look like a dead key.
 */
export function slotPick(indices, slot, from = -1) {
  const inSlot = indices.filter((i) => slotOf(idAt(i)) === slot);
  if (!inSlot.length) return -1;
  const at = inSlot.indexOf(from);
  return inSlot[(at + 1) % inSlot.length];
}

/**
 * Deal one weapon per slot out of `pool`, in slot order.
 *
 * Deathmatch hands out a loadout rather than letting you pick one, and this is the
 * dealing. It works per slot rather than picking N weapons at random so the result
 * is always a *playable* set — a primary, a sidearm, the knife, something to throw
 * — instead of, say, three pistols and no rifle. That also keeps the number keys
 * honest: whatever is rolled, 1 is still the primary and 3 is still the knife.
 *
 * @param pool weapon ids the mode allows.
 * @param rand injectable for tests, which need a roll they can predict.
 */
export function rollLoadout(pool, rand = Math.random) {
  const bySlot = new Map();
  for (const id of pool) {
    const s = slotOf(id);
    if (!bySlot.has(s)) bySlot.set(s, []);
    bySlot.get(s).push(id);
  }
  return [...bySlot.keys()]
    .sort((a, b) => a - b)
    .map((s) => {
      const bucket = bySlot.get(s);
      return bucket[Math.min(bucket.length - 1, Math.floor(rand() * bucket.length))];
    });
}

/**
 * Dead time after a swap before the new weapon will fire — the deploy time.
 *
 * This used to be one global 350ms, on the reasoning that a per-weapon draw time was
 * more realism than the game's readability could spend. The report that changed it was
 * "when you switch weapons, i dont see it cocking the gun so it still feel fast": 350ms
 * is not long enough to *show* anything. The holster alone is 38% of it, which left
 * about a tenth of a second for a weapon to come up and be made ready, and an action
 * cycling inside 110ms is a flicker whatever it is drawn as.
 *
 * So it is per-weapon now, and the numbers are ordered by what you are picking up rather
 * than typed to taste — a knife has nothing to rack, a pistol comes out of a holster one
 * handed, a belt-fed machine gun is 8kg of it. `SWITCH_MS` stays as the fallback and as
 * the value the animation scales against when a weapon does not name its own.
 * The ceiling is set by something outside this table: the answer to a jammed rifle is
 * supposed to be your pistol, so drawing one has to be cheaper than waiting out
 * JAM_CLEAR_MS. The pistol's 420 keeps that trade worth making by a wide margin. The
 * machine gun's 900 used to be deliberately the wrong side of that line, back when the
 * stoppage was 700ms; the stoppage is now 1400 (see JAM_CLEAR_MS for why) so every weapon
 * here can be drawn inside one, and what the lmg pays instead is the 900 it costs to come
 * back to. A weapon you cannot bail out of and return to in a hurry is still exactly what
 * its 100-round belt is paying for.
 */
export const SWITCH_MS = 550;
const SWITCH_OVERRIDES = {
  knife: 300,
  pistol: 420,
  grenade: 420,
  snowball: 400,
  // `flash`, not `flashbang` — the id in WEAPON_IDS. A key that matches no weapon is
  // silent: it does not throw, it just leaves that weapon on the 550 fallback, which
  // would have made the flashbang the slowest thing to draw of the four throwables for
  // no reason anybody could have found by playing.
  flash: 420,
  smoke: 420,
  smg: 520,
  semi: 620,
  rifle: 650,
  shotgun: 720,
  sniper: 820,
  lmg: 900,
};
export const switchMsOf = (id) => SWITCH_OVERRIDES[id] ?? SWITCH_MS;

// A misspelled key above cannot be found by playing — the weapon just quietly draws at
// the fallback speed. Checked at import, where `npm run verify` and the dev server both
// hit it long before a player could, rather than left to a reader to spot.
for (const id of Object.keys(SWITCH_OVERRIDES)) {
  if (!WEAPON_IDS.includes(id)) throw new Error(`SWITCH_OVERRIDES has no weapon "${id}"`);
}

/**
 * How heavy this weapon is, 0 (the lightest thing in the game) to 1 (the heaviest).
 *
 * Derived from the deploy times rather than declared, because those already encode the
 * answer — SWITCH_OVERRIDES is ordered by what you are picking up, and verify.mjs asserts
 * that ordering directly. A second hand-written weight table would be a second place for
 * "how heavy is the lmg" to live, and the two would drift the first time one was tuned.
 *
 * This is what weight *does to the body carrying it*: how far the muzzle sags, how hard a
 * shot shoves the shoulders, how far the gun trails behind a turn, how slowly it comes
 * onto a new aim. All third-person — the answer to "the bots ... dont look like carying
 * the gone", where every weapon was carried identically because nothing on the wire said
 * how heavy it was. The viewmodel keeps its own private scale for the draw sound, which is
 * pitch and a different question.
 *
 * The ends come from the table, so adding a heavier weapon renormalises the scale instead
 * of clipping against a literal.
 */
const HEFT_MIN = Math.min(...WEAPON_IDS.map(switchMsOf));
const HEFT_MAX = Math.max(...WEAPON_IDS.map(switchMsOf));
export const heftOf = (id) =>
  Math.max(0, Math.min(1, (switchMsOf(id) - HEFT_MIN) / (HEFT_MAX - HEFT_MIN || 1)));

export const weaponAt = (i) => WEAPONS[WEAPON_IDS[i]] ?? WEAPONS.rifle;
export const idAt = (i) => WEAPON_IDS[i] ?? 'rifle';

export function indexOf(id) {
  const i = WEAPON_IDS.indexOf(id);
  return i < 0 ? WEAPON_IDS.indexOf('rifle') : i;
}
