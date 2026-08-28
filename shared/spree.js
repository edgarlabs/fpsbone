// The killmark: a six-legged star that grows a leg per kill, and dies if you stop killing.
//
// This is CrossFire's killstreak, which is a different animal from shared/badges.js and has
// to stay one. A badge counts every kill you have ever scored and takes months; a killmark
// counts the last four seconds. One is who you are, the other is what is happening right
// now — and the reason both exist is that neither answers the other's question. Six kills
// in a row is a story about this fight. Fifteen thousand kills is a story about the year.
//
// WHY THIS IS SHARED AND NOT CLIENT-ONLY, given nothing on the server reads it: the numbers
// below are the rules of a mechanic, and a rule buried in a view file is a rule nobody can
// test. verify.mjs imports this the same way it imports badges.js. If a future mode ever
// wants to pay out for a six-chain, the ladder is already here rather than in the HUD.
//
// The window is the whole mechanic. Without it the star is a scoreboard and fills itself
// eventually; with it, six legs means six kills inside about twenty seconds of real fight,
// which is not something you can grind.

/**
 * Legs on the star, and so the longest chain the mark can show.
 *
 * SIX, AND IT STOPS AT SIX. A seventh chained kill refreshes the window and changes nothing
 * on screen — the star has no seventh leg and gains no number beside it. That is CrossFire's
 * rule and it is the right one: the mark is a shape you read in the corner of your eye
 * mid-fight, and a shape that keeps mutating past its own frame stops being readable
 * exactly when it matters most. The cap is also what keeps the top of it worth reaching.
 */
export const SPREE_LEGS = 6;

/**
 * How long a chain survives without a kill, in milliseconds.
 *
 * FOUR SECONDS is a decision, not a citation. CrossFire's own base window is not published
 * — the wiki gives only the boosted ceiling (27.9 s, with two rings and every upgradeable
 * VVIP weapon) — so this is the genre's usual figure, chosen against this game's own pace:
 * a rifle kills in about 250 ms of fire, and crossing between two players on these maps
 * takes two to three seconds. Four seconds means a second kill has to already be in front
 * of you. Six legs is therefore twenty seconds of continuous fighting, which nobody gets
 * by accident.
 */
export const SPREE_MS = 4000;

/**
 * What each rung is called. Index 0 is a single kill, which gets no name at all.
 *
 * The first kill is silent on purpose: it is the most common event in the game, and a game
 * that shouts DOUBLE KILL at one kill has nothing left to say at six. One leg lights, no
 * words. The names start where the chain does.
 */
export const SPREE_NAMES = ['', 'DOUBLE KILL', 'TRIPLE KILL', 'MULTI KILL', 'ULTRA KILL', 'UNBELIEVABLE'];

/**
 * Where a chain of `n` kills sits on the star: 0 for no chain, capped at SPREE_LEGS.
 *
 * Junk-tolerant in the same way stepOf is, and for a weaker reason honestly — this count
 * never touches a file, it is a local variable a few frames old. But it is also the only
 * thing standing between a bad number and a NaN in a class name, and a killmark that
 * silently stops drawing is a bug nobody reports because nobody is sure it was ever there.
 */
export function legsOf(n) {
  if (!Number.isFinite(n) || n < 1) return 0;
  return Math.min(SPREE_LEGS, Math.floor(n));
}

/** The name for a chain of `n`, or '' for one kill and for no kill. */
export function spreeName(n) {
  const legs = legsOf(n);
  return legs ? SPREE_NAMES[legs - 1] : '';
}

/**
 * How many wings the mark carries, 0..4, from a career badge tier of 0..5.
 *
 * THIS IS THE ONE PLACE THE TWO LADDERS TOUCH, and it is deliberately a one-way read:
 * the badge decorates the killmark and the killmark can never move the badge. In CrossFire
 * "completing certain Badge ... will upgrade the default killmark by adding wings to both
 * sides of the circle", which is exactly the relationship worth copying — a Distinguished
 * player's mark is visibly a Distinguished player's mark at the instant of any kill, without
 * the mark having to spell out a tier name it has no room for.
 *
 * Marksman gets none. A bare mark has to mean something, or the wings mean nothing.
 */
export function wingsOf(tier) {
  if (!Number.isFinite(tier) || tier < 2) return 0;
  return Math.min(4, Math.floor(tier) - 1);
}

// The ladder has to have a name for every leg, and the cap has to be the last of them —
// a chain that reached a leg with no name would render an empty word under a full star.
if (SPREE_NAMES.length !== SPREE_LEGS) {
  throw new Error(`spree: ${SPREE_NAMES.length} names for ${SPREE_LEGS} legs`);
}
