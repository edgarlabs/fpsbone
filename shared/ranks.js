// The career ladder. Imported by BOTH client and server, and — like shared/constants.js
// — with no dependency of any kind, so a boundary can never be read one way in the
// browser and another on the server. A rank that disagrees across the wire is worse than
// no rank at all: the plate over a head would contradict the badge on the scoreboard.
//
// WHY INSIGNIA AND NOT NAMES, over the head.
//
// A plate above a player sizes in world units. At twenty metres, with the game's 85°
// vertical FOV, the visible extent of the world is about 36u tall — so a plate a seventh
// of a metre high lands on roughly four pixels of a 1080p screen. Twenty-one distinct
// rank *names* are unreadable at four pixels, at eight, and at any distance two players
// actually fight across. A COUNT of marks is still a count at eight pixels, because it is
// read as a shape and not as text. The full names go where there is room for them: the
// HUD, and the Tab scoreboard.
//
// So every tier carries a `band` (which mark) and `pips` (how many), and no band ever
// asks for more than five. That is the constraint the split below is built to satisfy:
// ten enlisted tiers do not become ten stacked chevrons, they become five chevrons and
// five rockers. The officer tiers split the same way, bars then oak leaves. The five
// star generals at the top are the ones the whole feature was asked for by name —
// "up to 5 STAR" — and they are the only tiers that carry a star at all.

/** Ordered low to high. `at` is the career-kill count at which the tier begins, and the
 *  list is the single source of both the thresholds and the insignia. */
export const TIERS = [
  { name: 'Private', abbr: 'PVT', band: 'chevron', pips: 1, at: 0 },
  { name: 'Private Second Class', abbr: 'PV2', band: 'chevron', pips: 2, at: 3 },
  { name: 'Private First Class', abbr: 'PFC', band: 'chevron', pips: 3, at: 10 },
  { name: 'Specialist', abbr: 'SPC', band: 'chevron', pips: 4, at: 20 },
  { name: 'Corporal', abbr: 'CPL', band: 'chevron', pips: 5, at: 35 },
  { name: 'Sergeant', abbr: 'SGT', band: 'rocker', pips: 1, at: 55 },
  { name: 'Staff Sergeant', abbr: 'SSG', band: 'rocker', pips: 2, at: 80 },
  { name: 'Sergeant First Class', abbr: 'SFC', band: 'rocker', pips: 3, at: 110 },
  { name: 'Master Sergeant', abbr: 'MSG', band: 'rocker', pips: 4, at: 150 },
  { name: 'Sergeant Major', abbr: 'SGM', band: 'rocker', pips: 5, at: 200 },
  { name: 'Second Lieutenant', abbr: '2LT', band: 'bar', pips: 1, at: 260 },
  { name: 'First Lieutenant', abbr: '1LT', band: 'bar', pips: 2, at: 330 },
  { name: 'Captain', abbr: 'CPT', band: 'bar', pips: 3, at: 410 },
  { name: 'Major', abbr: 'MAJ', band: 'oak', pips: 1, at: 500 },
  { name: 'Lieutenant Colonel', abbr: 'LTC', band: 'oak', pips: 2, at: 600 },
  { name: 'Colonel', abbr: 'COL', band: 'oak', pips: 3, at: 720 },
  { name: 'Brigadier General', abbr: 'BG', band: 'star', pips: 1, at: 860 },
  { name: 'Major General', abbr: 'MG', band: 'star', pips: 2, at: 1020 },
  { name: 'Lieutenant General', abbr: 'LTG', band: 'star', pips: 3, at: 1200 },
  { name: 'General', abbr: 'GEN', band: 'star', pips: 4, at: 1400 },
  { name: 'General of the Army', abbr: 'GA', band: 'star', pips: 5, at: 1650 },
];

export const MAX_TIER = TIERS.length - 1;

/**
 * Which tier a career of `kills` has reached, as an index into TIERS.
 *
 * A linear scan down from the top, not a binary search: twenty-one entries called once
 * per player per snapshot is nothing, and the obvious version is the one a reader can
 * check against the table above.
 *
 * Junk in gives tier 0 rather than a throw. The count reaching here has been through a
 * JSON file that a crash may have truncated mid-write, and a `NaN` career must show as a
 * Private, not take the snapshot builder down with it.
 */
export function rankOf(kills) {
  const k = Number.isFinite(kills) ? kills : 0;
  for (let i = MAX_TIER; i > 0; i--) if (k >= TIERS[i].at) return i;
  return 0;
}

/** Career kills still to go before the next tier, or 0 at the top. For the HUD, which
 *  shows progress — a bare rank name gives a player nothing to aim at. */
export function toNextRank(kills) {
  const k = Math.max(0, Number.isFinite(kills) ? kills : 0);
  const next = rankOf(k) + 1;
  return next > MAX_TIER ? 0 : TIERS[next].at - k;
}
