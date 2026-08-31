// Per-category career badges: how many kills you have with each weapon, how many of them
// were headshots, and how many there have been in total — each one climbing a fifty-step
// ladder as the count goes up. Imported by BOTH sides, for the same reason shared/ranks.js
// is: a threshold read one way on the server and another in the browser would show a player
// a badge they had not earned, or hide one they had.
//
// HOW THIS DIFFERS FROM shared/ranks.js, which it deliberately does not extend.
//
// Ranks answer "who is this player" and go over their head, where there is room for a
// count of marks and nothing else. Badges answer "what did that kill just make you" and go
// on your own screen at the moment of a kill, where there IS room for a drawn emblem. So
// the two systems share a vocabulary — both are US Army — and share no code: one ladder is
// 21 tiers off a single number, the other is 50 steps off twelve separate numbers, and
// folding them together would give both the worse half of each.
//
// Unlike ranks.js this file DOES have a dependency: shared/weapons.js, for the labels. A
// badge that says RIFLE when the weapon table says something else is a badge that lies, so
// the weapon tracks read `WEAPONS[key].label` rather than restating it. The precedent is
// shared/movement.js, which imports the same table for the same reason.
//
// KEYS, NOT INDICES, are what persists in ranks.json and what crosses the wire. Weapons
// travel as an index into WEAPON_IDS because sanitizeInput has to clamp them; badge counts
// travel as an object because they outlive the process. An index in a file that a future
// arsenal reorders would silently hand one player another player's badge.

import { WEAPONS, WEAPON_IDS, HIT_ZONE } from './weapons.js';

/**
 * The five badges, low to high. The real US Army weapon-qualification ladder starts at
 * Marksman and stops at Expert; Master and Distinguished are the shooting-competition
 * badges above it. Together they are the five emblems this needed, in the same language as
 * the rank plates, which is the point — the two ladders should read as one career.
 */
export const TIER_NAMES = ['Marksman', 'Sharpshooter', 'Expert', 'Master', 'Distinguished'];

/** Levels inside one badge. Ten of them, then the next badge. */
export const MAX_LEVEL = 10;

/** Steps in a whole ladder: fifty, and the count a track needs to be finished. */
export const MAX_STEP = TIER_NAMES.length * MAX_LEVEL;

/** Retained name for "how many badges there are", which is also the top value of `tierOf`. */
export const MAX_BADGE_TIER = TIER_NAMES.length;

/**
 * THE ELIMINATIONS LADDER, and the shape every other track borrows.
 *
 * Fifty numbers rather than five because five was both too shallow and far too cheap: the
 * old top was 500 kills, which one evening reached the middle of, and a ceiling you clear
 * in an evening is not a thing anybody can flex. The whole point of the redesign is that
 * the top of this list should take a couple of hundred hours.
 *
 * Badge 1 is authored by hand. A generated curve cannot round 1..45 into ten distinct
 * integers — every formula collapses the bottom of the range — and the bottom is the part
 * every new player sees, so it is the part worth choosing rather than computing. From 60 up
 * it is geometric, r = (15000/60)^(1/39), snapped to two significant figures.
 *
 * The pacing that falls out of it, at the ~80 kills/hour this actually gets played at:
 * Marksman finishes in half an hour, Sharpshooter in three, Expert in eleven, Master in
 * forty-five, and Distinguished 10 lands somewhere near a hundred and ninety.
 */
const SHAPE = [
  1, 3, 6, 9, 12, 16, 21, 27, 35, 45, // Marksman
  60, 69, 80, 92, 110, 120, 140, 160, 190, 210, // Sharpshooter
  250, 280, 330, 380, 430, 500, 580, 660, 770, 880, // Expert
  1000, 1200, 1300, 1600, 1800, 2100, 2400, 2700, 3100, 3600, // Master
  4200, 4800, 5500, 6400, 7400, 8500, 9800, 11000, 13000, 15000, // Distinguished
];

/**
 * One track per thing worth counting, and the count that finishes it.
 *
 * TWELVE CEILINGS RATHER THAN SIX HUNDRED THRESHOLDS. Twelve tracks times fifty steps is
 * not a table a person can review, and a mistyped digit in the middle of one would be
 * invisible — so each track states only where it ends and takes its curve from SHAPE.
 *
 * The weapon ceilings sum to a little over twice the ELIMINATIONS ceiling on purpose. You
 * spread kills across the arsenal, so a weapon somebody actually mains is worth far more
 * than a twelfth of their career; scaling each weapon to 1/10th of the total would make
 * every weapon badge finish long before the total one, which is backwards.
 *
 * `hs` is tuned against `kills` rather than against the weapons: at the ~34% headshot rate
 * this gets played at, 6000 headshots arrives *after* 15000 kills, so HEADSHOT stays the
 * last badge anybody finishes. That is deliberate — it is the one track that is about aim.
 */
export const BADGES = {
  kills: { label: 'ELIMINATIONS', top: 15000 },
  hs: { label: 'HEADSHOT', top: 6000 },
  knife: { top: 900 },
  pistol: { top: 3600 },
  rifle: { top: 6000 },
  sniper: { top: 3000 },
  smg: { top: 6000 },
  lmg: { top: 4500 },
  semi: { top: 4500 },
  shotgun: { top: 3000 },
  grenade: { top: 1500 },
  snowball: { top: 900 },
  rifle_havoc: { top: 6000 },
  rifle_falcon: { top: 6000 },
  smg_kite: { top: 6000 },
  smg_banshee: { top: 6000 },
  pistol_wisp: { top: 3600 },
  pistol_rook: { top: 3600 },
  lmg_atlas: { top: 4500 },
  lmg_colossus: { top: 4500 },
  knife_karambit: { top: 900 },
  knife_tanto: { top: 900 },
  knife_bowie: { top: 900 },
  knife_kukri: { top: 900 },
};

/**
 * Two significant figures, and never not larger than the step below it.
 *
 * THE `prev + 1` FLOOR IS WHAT MAKES THE LADDER CORRECT BY CONSTRUCTION rather than by
 * tuning. Rounding a fifty-step curve that ends at 900 produces collisions near the bottom
 * — the knife ladder wants 10.3 and 12.4 two steps apart — and a ladder with a repeated
 * threshold has a level you can never be on. Clamping here means no ceiling, however low,
 * can produce one, so the invariant at the bottom of this file is a confirmation rather
 * than a thing the numbers have to be nursed past.
 *
 * Two significant figures because these numbers are read off a HUD mid-fight. 6400 is a
 * target; 6383 is noise.
 */
function nice(v, prev) {
  let n = Math.round(v);
  if (n >= 10) {
    const mag = 10 ** (Math.floor(Math.log10(n)) - 1);
    n = Math.round(n / mag) * mag;
  }
  return Math.max(prev + 1, n);
}

/**
 * SHAPE re-based onto another ceiling, which preserves its shape at any scale.
 *
 * Done in log space: each step keeps the same *fraction of the way up* that it has on the
 * ELIMINATIONS ladder, so a 900-kill knife ladder has its early levels arriving in minutes
 * and its late ones in weeks exactly like the 15000 one does. Interpolating linearly
 * instead would put knife level 2 at 3 kills and level 50 at 900, with the whole middle
 * bunched at the bottom.
 *
 * `kills` comes back as SHAPE itself: its ceiling *is* SHAPE's last value, so every
 * exponent is 1 and every step is its own number.
 */
function buildLadder(top) {
  const span = Math.log(SHAPE[MAX_STEP - 1]);
  const lt = Math.log(top);
  const at = [];
  for (let i = 0; i < MAX_STEP; i++) {
    at.push(nice(Math.exp((lt * Math.log(SHAPE[i])) / span), i ? at[i - 1] : 0));
  }
  return at;
}

// The weapon tracks take their label from the weapon table. Done here rather than written
// out above so there is exactly one place in the codebase where a weapon is named.
for (const key of Object.keys(BADGES)) {
  if (!BADGES[key].label) BADGES[key].label = WEAPONS[key].label;
  BADGES[key].at = buildLadder(BADGES[key].top);
}

/** Stable key list, for anything that has to iterate — the wire, the store, the tests. */
export const TRACK_KEYS = Object.keys(BADGES);

/** The two tracks that are not a weapon. Every other key is a weapon id. */
export const SPECIAL_KEYS = ['kills', 'hs'];

/**
 * How far up a track a count of `n` has got: 0 for "never scored on this track", 1..50
 * otherwise. This is the one number the whole system turns on — badge and level are both
 * read out of it, so the store and the wire never have to carry two.
 *
 * Inclusive at the boundary, the same rule `rankOf` uses — reaching the number IS the
 * promotion. An exclusive boundary would make the 60th kill say 1 to go and the 61st
 * promote you, which reads as an off-by-one bug every single time.
 *
 * Junk in gives 0 rather than a throw, for the reason rankOf gives: this count has been
 * through a JSON file on disk, and a NaN must show as an empty track rather than take a
 * snapshot or a HUD frame down with it.
 */
export function stepOf(n, key) {
  const at = BADGES[key]?.at;
  if (!at) return 0;
  const c = Number.isFinite(n) ? n : 0;
  for (let i = at.length - 1; i >= 0; i--) if (c >= at[i]) return i + 1;
  return 0;
}

/** Which of the five emblems a step is wearing: 0 below the first, 1..5 otherwise. */
export const badgeOf = (step) =>
  step > 0 ? Math.min(TIER_NAMES.length, Math.ceil(step / MAX_LEVEL)) : 0;

/** Which of the ten levels inside that emblem: 0 below the first, 1..10 otherwise. */
export const levelOf = (step) => (step > 0 ? ((step - 1) % MAX_LEVEL) + 1 : 0);

/**
 * Which badge a count has earned: 0..5.
 *
 * Kept under its old name and its old meaning because most callers only ever want to know
 * which emblem to draw — server-side and anything that does not show a level. The level
 * lives one call further in, at `levelOf(stepOf(n, key))`.
 */
export const tierOf = (n, key) => badgeOf(stepOf(n, key));

/** Kills still to go before the next step on this track, or 0 once the track is finished.
 *  The card shows it for the same reason the rank HUD does: a badge name alone gives
 *  nothing to aim at, and with fifty steps the next one is always close enough to chase. */
export function toNextStep(n, key) {
  const at = BADGES[key]?.at;
  if (!at) return 0;
  const c = Math.max(0, Number.isFinite(n) ? n : 0);
  const s = stepOf(c, key);
  return s >= at.length ? 0 : at[s] - c;
}

/**
 * A career's badge counts as the emblems a ROOM may see: `{ track: tier }`, tracks with no
 * emblem left out entirely.
 *
 * The counts themselves never leave the owner — see the `bd` note in server/index.js —
 * and this is the line between the two. A tier is what somebody wears; a count is how they
 * got there, and one of those is nobody else's business.
 *
 * Empty for a fresh career, which is what makes the roster message free for a new player:
 * an omitted field rather than twelve zeroes.
 */
export function publicTiers(counts) {
  const out = {};
  for (const key of TRACK_KEYS) {
    const t = tierOf(counts?.[key] ?? 0, key);
    if (t > 0) out[key] = t;
  }
  return out;
}

/** The full name of a badge, or '' below the first one. */
export const tierName = (t) => TIER_NAMES[t - 1] ?? '';

/** The label a track shows on the card. '' for a key that names nothing. */
export const labelOf = (key) => BADGES[key]?.label ?? '';

/**
 * The tracks one kill earns, in card-priority order: most specific first.
 *
 * BOTH SIDES CALL THIS. The server increments what it returns; the tests check it against
 * the table. Deriving "a rifle headshot is worth hs + rifle + kills" in two places is how
 * the two ends come to disagree about what a kill was worth.
 *
 * `wepId` may be anything, and anything that names no weapon earns the total and nothing
 * else. That is a real case: a kill credited with no weapon at all passes `''` (see the
 * call in server/room.js, which does NOT use `idAt` for exactly this reason). A util weapon
 * cannot kill, so it has no track, and reaching here with one means something upstream is
 * wrong; it is dropped the same silent way, because a badge is not worth throwing on the
 * kill path over.
 */
export function tracksFor(wepId, zone = HIT_ZONE.BODY) {
  const out = [];
  if (zone === HIT_ZONE.HEAD) out.push('hs');
  if (BADGES[wepId] && !SPECIAL_KEYS.includes(wepId)) out.push(wepId);
  out.push('kills');
  return out;
}

// Checked at import, where the dev server and `npm run verify` both hit it. The failure
// this catches is a weapon added to the arsenal with no badge: nothing throws, nothing
// logs, and the new gun simply never shows a card while every other one does. Same
// discipline as the `falloff` and `cycleMs` loops in shared/weapons.js.
for (const id of WEAPON_IDS) {
  const killable = !WEAPONS[id].util;
  if (killable && !BADGES[id]) throw new Error(`weapon "${id}" can kill but has no badge track`);
  if (!killable && BADGES[id]) throw new Error(`weapon "${id}" cannot kill but has a badge track`);
}
if (SHAPE.length !== MAX_STEP) throw new Error(`SHAPE has ${SHAPE.length} steps, not ${MAX_STEP}`);
// Every generated ladder, not a sample of them. Generating six hundred numbers is only
// safe if all six hundred are checked, and this is the check that makes it safe.
for (const key of TRACK_KEYS) {
  const { at, top } = BADGES[key];
  if (at.length !== MAX_STEP) throw new Error(`badge "${key}" has ${at.length} steps, not ${MAX_STEP}`);
  // Your first rifle kill has to make you a rifle Marksman 1, because the card pops on
  // every kill and a kill with no badge to show is a card with nothing on it.
  if (at[0] !== 1) throw new Error(`badge "${key}" starts at ${at[0]}, but every kill must have a step to show`);
  if (at[MAX_STEP - 1] !== top) throw new Error(`badge "${key}" tops out at ${at[MAX_STEP - 1]}, not its stated ${top}`);
  for (let i = 1; i < at.length; i++) {
    if (!(Number.isInteger(at[i]) && at[i] > at[i - 1])) throw new Error(`badge "${key}" step ${i + 1} is ${at[i]} after ${at[i - 1]}: not strictly increasing integers`);
  }
  if (!SPECIAL_KEYS.includes(key) && !WEAPON_IDS.includes(key)) throw new Error(`badge "${key}" names no weapon`);
}
