// The rank device itself: the drawing, and nothing that knows where it is drawn.
//
// WHY THIS IS ITS OWN FILE. There are two places a rank has to appear, and they are as far
// apart as two things in this codebase get: a plane over a player's head in WebGL, and a cell
// in the Tab scoreboard's DOM. The scoreboard used to sidestep that by printing the tier's
// three-letter abbreviation instead -- "PVT", "SGM" -- on the honest reasoning that a second
// drawing of the same rank could disagree with the first, and an abbreviation cannot disagree
// with a shape because it makes no claim about one.
//
// The player's answer to that: "not text RANK but its RANK logo". Fair, and the way to give
// them the logo without the drift the abbreviation was avoiding is to have ONE drawing with
// two consumers. Everything below produces a plain 2D canvas. render.js wraps it in a
// THREE.CanvasTexture for the plate; hud.js encodes it once per tier as a PNG and hands it to
// the stylesheet. Neither owns it, neither can quietly diverge from the other, and a change to
// a chevron's thickness moves both in the same commit.
//
// It also means this file imports no THREE and touches no DOM. The only thing it needs from
// outside is the ladder in shared/ranks.js and the character palette in shared/constants.js.
import * as C from '../../shared/constants.js';
import { TIERS } from '../../shared/ranks.js';

// ─── What a real one looks like ─────────────────────────────────────────────────────────
//
// "the rank is poorly design lol real rank doesnt look like that! it look ass!"
//
// It didn't, and the layout was the reason rather than the marks: every tier was a ROW of
// `pips` copies of one glyph. A corporal wore five chevrons side by side like a row of ticks.
// A general wore five stars on a strip 0.86u wide — wider than the body under it, since
// PLAYER_HALF_W is 0.4. Nothing on a uniform is laid out that way.
//
// Three things make the difference, and the first is the one that was missing entirely:
//
//   THE FIELD. Real rank is worn ON something — a patch of dark cloth for enlisted, a dark
//   shoulder mark for officers. That dark ground is most of what makes a badge read as rank
//   at a glance, and it is what the gaps between chevrons are MADE of. Without it the marks
//   floated, each carrying its own pale halo, and at four stripes those halos closed over the
//   gaps and the device turned to mush. Measured, before: the visible gap between adjacent
//   stripes came out at 0.07 of the pitch, because a halo of t/2 eats 0.31 of a pitch whose
//   gap is only 0.38. With a field there is one halo, around the whole badge, and every gap
//   survives at its full width.
//
//   ENLISTED marks STACK. Chevrons nest point-up at the top, rockers arc underneath, and a
//   sergeant major's star sits in the void between the two. The field is a constant square
//   whatever the rank — more stripes means THINNER stripes, never a bigger badge.
//
//   OFFICER marks sit in a ROW: two bars abreast for a captain, a line of stars for a general.
//   On the SAME field, and at the same height. An earlier pass here drew pins to their own
//   smaller cell, on the grounds that a real star is an inch across where a sergeant's patch
//   is three — and that came out at 3.5 × 4.1 pixels at twenty metres against the patch's
//   7.7 × 7.7, which is a lieutenant wearing a quarter of a private's badge. Life size lost
//   to legibility, and the row is allowed to widen instead, to 0.50u at five pins.
//
// What that costs, measured rather than assumed: the field is 7.7 pixels tall at twenty metres,
// so a six-stripe sergeant major's stripes land at 0.7 pixels each and cannot be counted —
// which is also true of the real patch at twenty metres. What survives the distance is the
// FAMILY: a solid block of stripes, a row of upright bars, a leaf, a row of stars. Four
// silhouettes, told apart at seven pixels, with the count inside them read at the distance
// people actually look at each other. That is a deliberate move away from the "countable at
// any range" bar shared/ranks.js sets, and it is the trade the complaint above asks for.

/** The cloth. Dark enough that gold sits on it at full contrast, and a hair lighter than the
 *  keyline below so the two do not flatten into each other. */
const CLOTH = '#2c3a4e';
/** Dark, from the visor — the badge belongs to the character palette, not to a UI palette.
 *  The keyline around the field, under the halo. */
const INK = `#${C.PALETTE.visor.toString(16).padStart(6, '0')}`;
/** And the halo, outside the keyline. Near-white rather than white so it reads as an edge and
 *  not as a glow. One per badge now, not one per stripe: this is what holds the field against
 *  a dark wall, and the dark field is what holds it against a pale sky. */
const HALO = '#f4f7fb';
/** The two metals. Enlisted stripes are gold on the dress uniform; a second lieutenant's bar
 *  and a major's leaf are gold and everything above them is silver, which is the real ladder
 *  and costs one comparison to follow. */
const GOLD = '#c9a227';
const SILVER = '#9fabbb';

/**
 * The device a tier wears, from its `band` and `pips` — the only two things shared/ranks.js
 * promises, so the ladder can be re-cut there without this file knowing.
 *
 * The enlisted mapping is the real US Army one wherever the invented ladder leaves room:
 *
 *   `chevron` 1-5 are PVT to CPL. PV2 through CPL draw one to four chevrons. A real E-1 Private
 *   has no device, but an empty game cell reads as missing artwork, so PVT gets an invented gold
 *   recruit shield. Its silhouette shares no shape with PV2 and keeps tier zero visibly ranked.
 *
 *   `rocker` 1-5 are SGT to SGM and draw three chevrons with rockers under them: one, two,
 *   three, then three plus a star, then three plus a star in a wreath. Which is exactly a
 *   staff sergeant, a sergeant first class, a master sergeant, a sergeant major and a command
 *   sergeant major. Three chevrons ALWAYS, even at one rocker — a rocker tier that dropped to
 *   two chevrons would draw the same device as a chevron tier, and the two families have to
 *   stay tellable apart. The cap at three rockers is what keeps this legible: six stripes is
 *   the most any patch can carry, so the thinnest stripe in the game is a sixth of a field
 *   rather than a tenth.
 *
 * The officer mapping is the real one too, and it is NOT `pips` copies of a glyph — which is
 * what it was, and what made a captain wear three bars and a colonel three oak leaves. Those
 * are the two ranks whose insignia most people can actually name. The real ladder spends its
 * three steps per band on the METAL as often as on the count:
 *
 *   `bar` 1-3 are a gold bar, a silver bar, then TWO silver bars — 2LT, 1LT, captain.
 *   `oak` 1-3 are a gold leaf, a silver leaf, then a silver EAGLE — major, lieutenant colonel,
 *   colonel. A colonel's eagle is its own glyph and worth the twenty lines: it is the one
 *   officer device with a silhouette nothing else on the ladder shares.
 *   `star` 1-5 are one to five silver stars, which is the one band where the count IS the rank.
 *
 * Gold against silver at the same shape and count is a real distinction and it survives being
 * small — warm against cool is a colour comparison, not a counting one, so a lieutenant reads
 * at a distance where their bar's edges do not.
 */
function deviceOf(band, pips) {
  const p = Math.max(1, Math.min(5, pips | 0));
  if (band === 'rocker') {
    return { stack: true, chev: 3, rock: Math.min(3, p), star: p >= 5 ? 2 : p >= 4 ? 1 : 0 };
  }
  if (band === 'bar') {
    return { stack: false, glyph: 'bar', n: p > 2 ? 2 : 1, metal: p === 1 ? GOLD : SILVER };
  }
  if (band === 'oak') {
    if (p > 2) return { stack: false, glyph: 'eagle', n: 1, metal: SILVER };
    return { stack: false, glyph: 'oak', n: 1, metal: p === 1 ? GOLD : SILVER };
  }
  if (band === 'star') return { stack: false, glyph: 'star', n: p, metal: SILVER };
  if (p === 1) return { stack: false, glyph: 'recruit', n: 1, metal: GOLD };
  return { stack: true, chev: p - 1, rock: 0, star: 0 };
}

// ─── the field ────────────────────────────────────────────────────────────────────────────

/** Authored height of a badge, in pixels, and the scale every path below is drawn at: one unit
 *  of path space is one field height. Far more than the seven-to-thirty pixels it is drawn at,
 *  and that is what the mipmaps are for — a six-stripe stack needs the room to come down
 *  cleanly rather than aliasing into a grey block. */
const FIELD_PX = 128;
/** World height of a badge. The SAME for every tier, both families: a badge that changed height
 *  with the rank would have to be re-anchored over the head for each one, and the wearer of the
 *  tallest would look like they were wearing the biggest rank rather than the highest. */
const FIELD_H = 0.26;
/** Width of a one-pin row, and how much each further pin adds, as multiples of the height. The
 *  first is 1 so a single pin sits on a square field exactly like a patch. */
const FIELD_W1 = 1.0;
const FIELD_W_STEP = 0.38;
/** And the ceiling on that, in world units. A general's five stars want 0.75u by the step
 *  above; the body under them is 0.8u wide, so the row is squeezed to fit this instead. */
const FIELD_W_MAX = 0.5;
/** Padding inside the canvas for the halo to live in, and the corner radius, both as fractions
 *  of the field height. `PAD` is exactly half of `HALO_W`, so the halo stroke lands its outer
 *  edge on the canvas edge and not a pixel past it. */
const PAD = 0.035;
const HALO_W = 0.07;
const CORNER = 0.09;

/** Width of the field, in world units, for a device. */
function fieldWidth(dev) {
  if (dev.stack) return FIELD_H;
  return Math.min(FIELD_H * (FIELD_W1 + FIELD_W_STEP * (dev.n - 1)), FIELD_W_MAX);
}

/**
 * The cloth, as a rounded rectangle filling the canvas inside `PAD`, with its halo and keyline.
 *
 * `aspect` is the canvas width in path units — width over height, since the vertical unit is
 * the whole field. Corners are quadratics with the control on the corner itself, which is the
 * same curve `arcTo` would give and costs no extra state.
 */
function drawField(c, aspect) {
  const x0 = PAD;
  const x1 = aspect - PAD;
  const y0 = PAD;
  const y1 = 1 - PAD;
  const r = CORNER;
  c.beginPath();
  c.moveTo(x0 + r, y0);
  c.lineTo(x1 - r, y0);
  c.quadraticCurveTo(x1, y0, x1, y0 + r);
  c.lineTo(x1, y1 - r);
  c.quadraticCurveTo(x1, y1, x1 - r, y1);
  c.lineTo(x0 + r, y1);
  c.quadraticCurveTo(x0, y1, x0, y1 - r);
  c.lineTo(x0, y0 + r);
  c.quadraticCurveTo(x0, y0, x0 + r, y0);
  c.closePath();
  c.lineJoin = 'round';
  c.lineWidth = HALO_W;
  c.strokeStyle = HALO;
  c.stroke();
  c.fillStyle = CLOTH;
  c.fill();
  c.lineWidth = HALO_W * 0.35;
  c.strokeStyle = INK;
  c.stroke();
}

// ─── the marks ────────────────────────────────────────────────────────────────────────────

/** Border of bare cloth left inside the field, so the marks sit ON a patch instead of running
 *  off its edge. Vertical and horizontal, and the real thing has both. */
const MARK_MARGIN = 0.11;
const STRIPE_X0 = MARK_MARGIN;
const STRIPE_X1 = 1 - MARK_MARGIN;
/** A stripe's thickness as a fraction of the pitch between stripes. The rest is the gap, and
 *  the gap is cloth: a patch that is all stripe and no gap reads as one solid block. */
const T_FRAC = 0.62;
/** How far a chevron's arms drop below its apex, as a fraction of the field. FIXED, and not
 *  scaled by the stripe count: the ANGLE is what makes a chevron read as a chevron, and
 *  thinning six of them to fit must not also flatten them into straight lines. Against the
 *  0.39 half-width above this is a 24° arm, which is what the real ones run. Paid once per
 *  BLOCK, so a chevrons-and-rockers device pays it twice — which is most of why six stripes
 *  is the cap. */
const STRIPE_RISE = 0.17;
/** No stripe thicker than this, so the lone chevron on a PV2 is a chevron and not a wedge. */
const STRIPE_T_MAX = 0.19;
/** Gap between the chevron block and the rocker block: just clearance normally, and a real
 *  opening when a star has to sit in it. A sergeant major's patch IS mostly that star, and the
 *  wreathed one needs more room again — sized so the wreath's outer edge lands exactly on the
 *  half-gap and cannot lap over the stripes above and below it, which it did at one shared
 *  void of 0.24. */
const VOID_PLAIN = 0.05;
const VOID_STAR = 0.2;
const VOID_WREATH = 0.26;

/**
 * One stripe, as a closed path in field space with y pointing down.
 *
 * `y` is the apex line and the band hangs below it: the shape occupies y to y+rise+t, so a
 * caller can stack them on a pitch without knowing the geometry. Straight arms make a chevron;
 * one quadratic each side, with its control at the apex, makes a rocker — and the control
 * sitting at exactly `y - rise` is what puts the curve's own apex on `y`, so both shapes have
 * the same top edge and the same total depth and can share one layout.
 *
 * Drawn as a BAND with two edges rather than stroked down the middle, because that is part of
 * what the complaint was about: a real chevron is a thick stripe of cloth of constant width,
 * and a stroked polyline is a wire.
 */
function stripePath(c, y, t, curve) {
  c.beginPath();
  if (curve) {
    c.moveTo(STRIPE_X0, y + STRIPE_RISE);
    c.quadraticCurveTo(0.5, y - STRIPE_RISE, STRIPE_X1, y + STRIPE_RISE);
    c.lineTo(STRIPE_X1, y + STRIPE_RISE + t);
    c.quadraticCurveTo(0.5, y - STRIPE_RISE + t, STRIPE_X0, y + STRIPE_RISE + t);
  } else {
    c.moveTo(STRIPE_X0, y + STRIPE_RISE);
    c.lineTo(0.5, y);
    c.lineTo(STRIPE_X1, y + STRIPE_RISE);
    c.lineTo(STRIPE_X1, y + STRIPE_RISE + t);
    c.lineTo(0.5, y + t);
    c.lineTo(STRIPE_X0, y + STRIPE_RISE + t);
  }
  c.closePath();
}

/** A five-pointed star, points out, one up. The inner radius is the golden ratio's 0.382 of the
 *  outer, which is the proportion a real five-pointed star is cut to — anything fatter reads as
 *  a pentagon and anything thinner as a splat. */
function starPath(c, cx, cy, r) {
  c.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.382 : r;
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr;
    if (i) c.lineTo(x, y);
    else c.moveTo(x, y);
  }
  c.closePath();
}

/**
 * ONE pitch for the whole device, solved so the stack fills the field's inner span exactly.
 *
 * Every stripe in a device is the same thickness on the same pitch, above the void and below
 * it, because they are on a real patch — chevrons and rockers are cut from the same braid.
 * So the span is spent on: (chev-1) + (rock-1) pitches between stripes, one `T_FRAC` pitch for
 * the last stripe of each block, one `STRIPE_RISE` per block, and the void. Solving that for
 * the pitch is the whole layout, and the cap at `STRIPE_T_MAX` is what keeps a one-chevron
 * device from becoming a wedge with the room it has spare.
 */
function stackLayout(chev, rock, star) {
  const span = 1 - 2 * MARK_MARGIN;
  const blocks = rock > 0 ? 2 : 1;
  const gap = rock > 0 ? (star > 1 ? VOID_WREATH : star ? VOID_STAR : VOID_PLAIN) : 0;
  const coef = chev - 1 + (rock > 0 ? rock - 1 : 0) + blocks * T_FRAC;
  const fixed = blocks * STRIPE_RISE + gap;
  const pitch = Math.min((span - fixed) / Math.max(0.01, coef), STRIPE_T_MAX / T_FRAC);
  const t = pitch * T_FRAC;
  const extent = coef * pitch + fixed;
  const top = MARK_MARGIN + (span - extent) / 2;
  const chevBottom = top + (chev - 1) * pitch + t + STRIPE_RISE;
  return { pitch, t, top, chevBottom, rockTop: chevBottom + gap, gap };
}

/** An enlisted patch: chevrons, rockers, and the star in the void between them. */
function stackTex(dev) {
  const cv = document.createElement('canvas');
  cv.width = FIELD_PX;
  cv.height = FIELD_PX;
  const c = cv.getContext('2d');
  // Draw in field space — one unit is the field's height — so every constant above is a
  // fraction of the badge and FIELD_PX can be re-tuned without redrawing anything.
  c.scale(FIELD_PX, FIELD_PX);
  drawField(c, 1);
  const { pitch, t, top, chevBottom, rockTop, gap } = stackLayout(dev.chev, dev.rock, dev.star);
  // No halo and no keyline on the stripes: gold on this cloth is already a hard edge, and a
  // halo per stripe is what closed the gaps up before.
  c.fillStyle = GOLD;
  for (let i = 0; i < dev.chev; i++) {
    stripePath(c, top + i * pitch, t, false);
    c.fill();
  }
  if (dev.rock > 0) {
    // Rockers are chevrons upside down, so they are DRAWN upside down: the flip maps the rocker
    // block onto itself, which means the stack below is laid out by the same arithmetic as the
    // one above and cannot drift away from it.
    const rockBottom = rockTop + (dev.rock - 1) * pitch + t + STRIPE_RISE;
    c.save();
    c.translate(0, rockTop + rockBottom);
    c.scale(1, -1);
    for (let i = 0; i < dev.rock; i++) {
      stripePath(c, rockTop + i * pitch, t, true);
      c.fill();
    }
    c.restore();
  }
  if (dev.star) {
    // In the void between the blocks, which is what VOID_STAR opened up for it.
    const cy = chevBottom + gap / 2;
    starPath(c, 0.5, cy, gap * 0.42);
    c.fill();
    if (dev.star > 1) {
      // The wreath, as a ring around the star. At seven pixels it closes up into a disc behind
      // it, which is the right way for it to fail: a command sergeant major reads as "star, and
      // more". 0.44 plus half the line width is 0.49 of the gap, so it stops inside the void.
      c.beginPath();
      c.arc(0.5, cy, gap * 0.44, 0, Math.PI * 2);
      c.lineWidth = gap * 0.1;
      c.strokeStyle = GOLD;
      c.stroke();
    }
  }
  return { cv, w: FIELD_H, h: FIELD_H };
}

// ─── the pins ─────────────────────────────────────────────────────────────────────────────

/** One pin per band, as a path in a unit cell with y pointing down. Each glyph fills its cell
 *  edge to edge — the cell is sized by `rowTex` and the gaps between pins come from the cell
 *  pitch, not from padding inside the glyph, so a general's stars and a captain's bars are
 *  spaced by the same rule. */
const PINS = {
  /**
   * The game's invented Private device: a compact shield, broad enough to survive at seven
   * pixels and unlike the chevron earned at PV2. E-1 has no real-world pin, but a blank patch
   * looked like failed loading; this explicitly marks the beginning of this game's ladder.
   */
  recruit(c) {
    c.beginPath();
    c.moveTo(0.5, 0.05);
    c.lineTo(0.82, 0.2);
    c.lineTo(0.75, 0.68);
    c.quadraticCurveTo(0.66, 0.86, 0.5, 0.95);
    c.quadraticCurveTo(0.34, 0.86, 0.25, 0.68);
    c.lineTo(0.18, 0.2);
    c.closePath();
  },
  /** A bar. Upright, and two of them abreast is a captain — which is the reason the row family
   *  exists at all rather than everything being stacked. */
  bar(c) {
    c.beginPath();
    c.rect(0.34, 0.05, 0.32, 0.9);
    c.closePath();
  },
  /**
   * An oak leaf, lobed, tip up, on a short stem.
   *
   * This was an ELLIPSE, and the ellipse is the one glyph in the old set with no defence: a
   * major's leaf and a lieutenant colonel's leaf are among the most recognisable pins on the
   * uniform and they came out as pills. Three lobes a side, one quadratic per lobe with the
   * control at the lobe's tip and the endpoint in the notch behind it, then mirrored — so the
   * two halves cannot disagree and the whole outline is eight curves.
   */
  oak(c) {
    c.beginPath();
    c.moveTo(0.5, 0.05);
    c.quadraticCurveTo(0.72, 0.14, 0.61, 0.29);
    c.quadraticCurveTo(0.83, 0.4, 0.63, 0.55);
    c.quadraticCurveTo(0.76, 0.7, 0.55, 0.82);
    c.quadraticCurveTo(0.56, 0.9, 0.52, 0.95);
    c.lineTo(0.48, 0.95);
    c.quadraticCurveTo(0.44, 0.9, 0.45, 0.82);
    c.quadraticCurveTo(0.24, 0.7, 0.37, 0.55);
    c.quadraticCurveTo(0.17, 0.4, 0.39, 0.29);
    c.quadraticCurveTo(0.28, 0.14, 0.5, 0.05);
    c.closePath();
  },
  /**
   * A colonel's eagle, wings spread, three subpaths filled as one: the two wings and the body.
   *
   * Wide and short where the leaf is narrow and tall, which is the whole point of drawing it —
   * at seven pixels the eagle is a horizontal bar of metal and the leaf a vertical one, and
   * that is a difference that survives the distance where feathers do not. The wings are
   * mirrored rather than authored twice, so the two cannot disagree.
   */
  eagle(c) {
    c.beginPath();
    for (const k of [1, -1]) {
      const X = (x) => 0.5 + k * (x - 0.5);
      c.moveTo(X(0.5), 0.38);
      c.quadraticCurveTo(X(0.72), 0.27, X(0.96), 0.25);
      c.quadraticCurveTo(X(0.87), 0.4, X(0.72), 0.46);
      c.quadraticCurveTo(X(0.62), 0.5, X(0.52), 0.53);
      c.closePath();
    }
    c.moveTo(0.5, 0.29);
    c.quadraticCurveTo(0.548, 0.3, 0.546, 0.36);
    c.quadraticCurveTo(0.562, 0.5, 0.556, 0.64);
    c.quadraticCurveTo(0.6, 0.72, 0.58, 0.81);
    c.lineTo(0.42, 0.81);
    c.quadraticCurveTo(0.4, 0.72, 0.444, 0.64);
    c.quadraticCurveTo(0.438, 0.5, 0.454, 0.36);
    c.quadraticCurveTo(0.452, 0.3, 0.5, 0.29);
    c.closePath();
  },
  /** A star, filling its cell. */
  star(c) {
    starPath(c, 0.5, 0.5, 0.5);
  },
};

/**
 * An officer's shoulder mark: `n` pins in a row on the same field as a patch.
 *
 * The cell is square and sized by whichever runs out first — the width the row is allowed or
 * the height inside the margins — so the glyphs never stretch and never overrun the cloth. At
 * one to three pins the width is what the step allows and the height is the binding limit; at
 * four and five the field has hit `FIELD_W_MAX` and the width binds instead, which is where a
 * general's stars start getting smaller rather than the badge getting wider.
 */
function rowTex(dev) {
  const glyph = PINS[dev.glyph] ?? PINS.bar;
  // The canvas is a whole number of pixels, so the ASPECT is taken back off that rounded width
  // rather than from the world size it was asked for. Drawing the field to an aspect the canvas
  // is half a pixel short of puts the right-hand halo through the edge of the texture.
  const cv = document.createElement('canvas');
  cv.width = Math.round((FIELD_PX * fieldWidth(dev)) / FIELD_H);
  cv.height = FIELD_PX;
  const aspect = cv.width / FIELD_PX;
  const w = FIELD_H * aspect;
  const c = cv.getContext('2d');
  c.scale(FIELD_PX, FIELD_PX);
  drawField(c, aspect);
  const lane = aspect - 2 * MARK_MARGIN;
  const cell = Math.min(lane / dev.n, 1 - 2 * MARK_MARGIN);
  const x0 = (aspect - cell * dev.n) / 2;
  const y0 = (1 - cell) / 2;
  c.fillStyle = dev.metal;
  for (let i = 0; i < dev.n; i++) {
    c.save();
    c.translate(x0 + i * cell, y0);
    // Draw in the unit cell, uniformly scaled, so a glyph authored square stays square.
    c.scale(cell, cell);
    glyph(c);
    c.fill();
    c.restore();
  }
  return { cv, w, h: FIELD_H };
}
// --- what the two consumers ask for ------------------------------------------------------

/**
 * The device for a tier, as a 2D canvas plus the world size the plate wants.
 *
 * Not cached here on purpose. The two callers cache what they actually keep -- a GPU texture
 * on one side, a PNG string on the other -- and a canvas held here as well would be a third
 * copy of every rank that nothing ever reads again.
 */
export function insigniaCanvas(tier) {
  const t = Math.max(0, Math.min(TIERS.length - 1, tier | 0));
  const { band, pips } = TIERS[t];
  const dev = deviceOf(band, pips);
  return dev.stack ? stackTex(dev) : rowTex(dev);
}

/** `{url, w, h}` per tier for the DOM: a data URL, its pixel width, and its pixel height. */
const pngCache = new Map();

/**
 * The device for a tier as a PNG data URL, for anything that draws with CSS or an `<img>`.
 *
 * Encoded once per tier and kept, which is what makes it safe to build a stylesheet rule out
 * of: twenty-one ranks is the ceiling however many players are in the room, the encode is a
 * few hundred microseconds on a 128px canvas, and the browser then decodes each URL once no
 * matter how many rows carry it.
 *
 * Tier 0 is a real PNG too. `deviceOf` gives Private the game's recruit shield, so a missing
 * mark can never be confused with the beginning of the ladder.
 */
export function insigniaPng(tier) {
  if ((typeof tier !== 'number' && typeof tier !== 'string') || tier === '') return null;
  const n = Number(tier);
  if (!Number.isFinite(n)) return null;
  const t = n | 0;
  if (t < 0 || t >= TIERS.length) return null;
  const hit = pngCache.get(t);
  if (hit) return hit;
  const { cv } = insigniaCanvas(t);
  const e = { url: cv.toDataURL('image/png'), w: cv.width, h: cv.height };
  pngCache.set(t, e);
  return e;
}

/** The world height of every badge, which is the same for all of them. Exported because the
 *  plate is positioned by its bottom edge and has to know its own half-height. */
export { FIELD_H };
