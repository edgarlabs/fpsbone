// DOM overlay. Kept out of WebGL entirely — text, bars and the killfeed are all
// things the browser already lays out better than a canvas would.
//
// Almost everything here is called from the frame loop, so the setters early-out on
// an unchanged value. The alternative — rebuilding the slot strip 60 times a second
// to draw the same five boxes — is the kind of cost that only shows up on the
// machines least able to absorb it.

import * as C from '../../shared/constants.js';
import { WEAPONS, idAt } from '../../shared/weapons.js';
import { TEAM_NAMES } from '../../shared/modes.js';
import { TIERS, MAX_TIER, rankOf, toNextRank } from '../../shared/ranks.js';
import {
  MAX_STEP, TRACK_KEYS, badgeOf, labelOf, levelOf, stepOf, tierName, toNextStep,
} from '../../shared/badges.js';
import { pingGrade } from '../../shared/regions.js';
// The rank device, as the PNG the scoreboard's gutter wears. The SAME canvas render.js
// hangs over the player's head -- see insignia.js for why that matters more than it
// looks like it should.
import { insigniaPng } from './insignia.js';
import { SPREE_LEGS, SPREE_MS, legsOf, spreeName } from '../../shared/spree.js';

const $ = (id) => document.getElementById(id);

/**
 * Crosshair bloom: pixels of extra gap per radian of kicked aim, and a ceiling.
 *
 * Both were retuned when recoil started accumulating. The old 190/16 pair saturated at
 * 0.084 rad, which was above the punch a rifle could actually reach back when recovery
 * ran between every shot — so the ceiling was decoration and the reticle barely moved.
 * The punch now tops out at each weapon's `max`, 0.34 rad on the machine gun, so the
 * scale is flatter and the cap is where that top lands. The ceiling still matters more
 * than the scale: an unbounded gap on a long spray walks the arms off the screen, and a
 * crosshair you cannot see is not feedback.
 */
const BLOOM_PX = 110;
const BLOOM_MAX = 34;

/**
 * The scoped reticle's resting centre gap, in vmin — the reticle it has always been.
 *
 * A BASE that the inaccuracy is ADDED to, not a floor it is clamped against, and the
 * difference is the whole usefulness of the ring. A settled sniper's cone is 0.0008 rad,
 * which is a fifth of a pixel, and a cone a fifth of the way through its settle is about
 * two vmin — under a floor of this size both would render identically and the ring would
 * say nothing for most of the window it exists to show. Added, the gap opens to three
 * times its resting size on the frame the glass comes up and visibly closes from there.
 * `bloom` treats the crosshair's gap the same way for the same reason.
 *
 * 3.15vmin is the 34px this was, expressed in vmin so it holds its proportion of the lens
 * on any display — the ring is measured against the glass, not against the window.
 */
const RING_BASE_VMIN = 3.15;
/** How wide the ring may get before it stops meaning anything. A ring larger than the
 *  lens is a ring drawn under the black, and a player reading "somewhere on the screen"
 *  learns the same thing from a ring at the edge of the glass. */
const RING_MAX_VMIN = 30;
/** Half the lens, in vmin — the `62vmin` in `#scope .lens`. The ring is a fraction of
 *  the field of view and the lens is what that field of view is drawn across, so this
 *  is the number that turns an angle into a distance on the glass. */
const LENS_HALF_VMIN = 31;

/** mm:ss. The match clock is the one number a player checks mid-fight, so it has
 *  to be readable at a glance rather than parsed. */
function clock(secs) {
  const s = Math.max(0, Math.round(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function createHud() {
  const els = {
    start: $('start'),
    startStatus: $('start-status'),
    dead: $('dead'),
    respawnIn: $('respawn-in'),
    killedBy: $('killed-by'),
    hpNum: $('hp-num'),
    hpFill: $('hp-fill'),
    vitals: $('vitals'),
    shield: $('shield'),
    spSecs: $('sp-secs'),
    spFill: $('sp-fill'),
    stamina: $('stamina'),
    rank: $('rank'),
    rkName: $('rk-name'),
    rkNext: $('rk-next'),
    stText: $('st-text'),
    stFill: $('st-fill'),
    hitmark: $('hitmark'),
    vignette: $('vignette'),
    flash: $('flash'),
    cross: $('cross'),
    scope: $('scope'),
    feed: $('feed'),
    board: $('board'),
    boardCap: $('board-cap'),
    boardTally: $('board-tally'),
    boardRows: $('board-rows'),
    wName: $('w-name'),
    wAmmo: $('w-ammo'),
    wSlots: $('w-slots'),
    modeBar: $('mode-bar'),
    mTeams: $('m-teams'),
    mTime: $('m-time'),
    mLabel: $('m-label'),
    badge: $('badge'),
    bdGlyph: $('bd-glyph'),
    bdLabel: $('bd-label'),
    bdTier: $('bd-tier'),
    bdPips: $('bd-pips'),
    bdLevel: $('bd-level'),
    bdCount: $('bd-count'),
    killmark: $('killmark'),
    kmGlyph: $('km-glyph'),
    kmName: $('km-name'),
    kmBar: $('km-bar'),
    kmFill: $('km-fill'),
    kmSecs: $('km-secs'),
    nRtt: $('n-rtt'),
    nSnap: $('n-snap'),
    nPred: $('n-pred'),
  };

  let hitUntil = 0;
  let hurtUntil = 0;
  /**
   * The badge card: when the one on screen expires, whether it is a promotion, and any
   * promotions waiting behind it.
   *
   * An ordinary card is a receipt for the kill you just got, and it is worth replacing the
   * instant the next kill lands -- the count on it is already stale. A promotion is a new
   * emblem, which happens five times per track across a whole career, so it queues instead:
   * it never cuts one short and is never cut short by the routine card behind it. A level-up
   * is one of fifty and takes the ordinary card, which is the whole reason the two are
   * separate flags -- if every step popped, the promotion would stop being an event.
   * The queue is capped because a spawn-rush that promotes three tracks at once should not
   * put eight seconds of cards between the player and their next fight.
   */
  let badgeUntil = 0;
  let badgeUp = false;
  const badgeQueue = [];
  const BADGE_MS = 1600;
  const BADGE_UP_MS = 2600;
  const BADGE_QUEUE_MAX = 3;
  /** The markup the scoreboard last wrote, so a frame that would write the same thing
   *  writes nothing. See `scoreboard`. */
  let boardHtml = '';
  /** And the header band's tally, memoised the same way and for the same reason: it is
   *  rebuilt from the score on every frame the board is held open. */
  let boardTally = '';
  /**
   * The killmark: when the chain on screen runs out, and what its bar is drawing between.
   *
   * `kmUntil` is the deadline the chain dies at and `kmFrom` is the moment the last leg
   * landed, and the bar needs BOTH because it draws a fraction, not a countdown. Storing
   * only the deadline would mean recomputing the span from SPREE_MS on every frame, which
   * is fine until the day the window is boosted for one chain and the bar starts lying.
   *
   * It runs on its own clock and not the badge's. They fire on the same kill, they are read
   * at opposite ends of the screen, and one of them holds a promotion for 2.6 s while the
   * other has a hard four-second deadline the player is timing their next shot against —
   * sharing a timer between those would make the wrong one authoritative.
   */
  let kmUntil = 0;
  let kmFrom = 0;
  let kmLow = false;
  let shownKmSecs = '';
  let netThrottle = 0;
  /** The running wash animation, so a second flash replaces the first rather than
   *  fighting it. Two `#flash` animations at once resolve to whichever the browser
   *  composited last, which is not a decision worth leaving to chance. */
  let washAnim = null;

  // Last-rendered values, so the per-frame setters can skip DOM work.
  let slotKey = '';
  let shownWep = -1;
  let shownAmmo = '';
  let shownSecs = '';
  let shownKiller = '';
  let shownTime = '';
  let shownLabel = '';
  let shownBar = null;
  let shownTeams = null;
  let shownScope = ''; // a composed key now — opacity, the scope flag and the ring size
  let shownBloom = -1;
  // Spawn protection is written every frame while it lasts. Three separate last-drawn
  // values because the visibility, the tenths and the bar percent all change on
  // different frames, and one shared key would repaint all three whenever any moved.
  let shownShieldOn = null;
  let shownShieldT = -1;
  let shownShieldPct = -1;
  let shownStamOn = null;
  let shownStamPct = -1;
  let shownStamBlocked = null;
  // Career, not tier: two careers inside one tier still differ in how far the next one is.
  let shownCareer = -1;

  /**
   * Full-screen colour wash: on instantly, held, then faded out.
   *
   * Driven by a keyframe animation rather than a CSS transition because the two things
   * that use it want wildly different timings — a death flash is over in under a second,
   * a point-blank flashbang holds for nearly three — and a transition can only carry one
   * duration written in the stylesheet.
   *
   * @param col    any CSS colour, including one with alpha.
   * @param holdMs how long it stays at full before it starts going.
   * @param fadeMs how long the fade itself takes.
   * @param fadeEase the fade's curve, as an easing on the MIDDLE keyframe rather than on
   *   the animation. That distinction is the whole reason it is written this way: an
   *   easing passed in the options object warps the animation's overall progress, so it
   *   moves the end of the hold as well and `holdMs` stops meaning holdMs. On the middle
   *   keyframe it applies only to the interval that starts there, which is exactly the
   *   fade. Linear is right for a hit — over before its shape registers — and wrong for a
   *   blind, where the first part of the fade should still read as white.
   */
  /** Put a card on screen now, replacing whatever was there. */
  function showBadge(card, now) {
    const step = stepOf(card.count, card.key);
    const badge = badgeOf(step);
    const level = levelOf(step);
    els.bdLabel.textContent = labelOf(card.key);
    els.bdTier.textContent = tierName(badge);
    els.bdLevel.textContent = `LEVEL ${level}`;
    // The glyph id IS the track key -- see the sprite at the top of index.html -- so there
    // is no lookup table here that could fall out of step with the badge table.
    els.bdGlyph.setAttribute('href', `#g-${card.key}`);
    // Ten pips, `level` of them filled, and `n` on the one this kill just lit. Toggled on
    // the existing ten rather than rebuilt, the same reason every setter in this file
    // early-outs: this runs on a kill, which is the busiest moment the machine has.
    for (let i = 0; i < els.bdPips.children.length; i++) {
      const pip = els.bdPips.children[i];
      pip.classList.toggle('f', i < level);
      pip.classList.toggle('n', !!card.levelUp && i === level - 1);
    }
    const left = toNextStep(card.count, card.key);
    els.bdCount.textContent =
      `${card.count} ${nounFor(card.key, card.count)}` +
      (step >= MAX_STEP || left <= 0
        ? ' · top badge'
        : ` · ${left} to ${tierName(badgeOf(step + 1))} ${levelOf(step + 1)}`);
    // The whole class is rebuilt rather than patched, because one element serves all twelve
    // tracks and all five badges: a `b3` left behind under a `b4` card draws the wrong
    // metal. `b1` is the floor for a count that somehow has no step, so the emblem is never
    // left with an undefined `--bd-metal`.
    els.badge.className = `b${badge || 1}`;
    if (card.key === 'hs') els.badge.classList.add('hs');
    // Read a layout property before the classes that animate go back on, so a second
    // promotion actually replays the pop. Without it the browser coalesces the two class
    // changes into no change at all and the animation never restarts.
    void els.badge.offsetWidth;
    if (card.promoted) els.badge.classList.add('up');
    else if (card.levelUp) els.badge.classList.add('lv');
    els.badge.classList.add('on');
    badgeUp = !!card.promoted;
    badgeUntil = now + (card.promoted ? BADGE_UP_MS : BADGE_MS);
  }

  /** What a count on this track is a count OF, so the card reads as English: "25 rifle
   *  kills", "12 headshots", "40 kills".
   *
   *  Pluralised, because at[0] is 1 on every track: the very first card a new player ever
   *  sees says "1", and "1 knife kills" is the sort of thing that reads as unfinished. */
  function nounFor(key, n) {
    const s = n === 1 ? '' : 's';
    if (key === 'kills') return `kill${s}`;
    if (key === 'hs') return `headshot${s}`;
    return `${labelOf(key).toLowerCase()} kill${s}`;
  }

  function wash(col, holdMs, fadeMs, fadeEase = 'linear') {
    const total = Math.max(1, holdMs + fadeMs);
    // Cancel rather than layer. Both of these end with `fill: 'forwards'` holding the
    // element at zero, and two of those on one element disagree about the final value.
    washAnim?.cancel();
    els.flash.style.background = col;
    washAnim = els.flash.animate(
      [
        { opacity: 1, offset: 0 },
        { opacity: 1, offset: holdMs / total, easing: fadeEase },
        { opacity: 0 },
      ],
      { duration: total, easing: 'linear', fill: 'forwards' },
    );
  }

  return {
    /**
     * Scope opacity, 0..1, driven from the aim blend every frame. The crosshair goes
     * with it: the scope draws its own reticle, and leaving both up put two sets of
     * lines over the same target. Rounded to 2dp before comparing, so a blend that
     * has effectively settled stops writing to the DOM.
     *
     * @param hasScope whether the weapon in hand owns a scope at all — not whether it
     *   is scoped right now. A scoped weapon gets NO crosshair in either state, and the
     *   unscoped half is the half that matters: "sniper should not have its nonscope
     *   crosshair otherwise it makes no sense to scope because it has crosshair". A free
     *   aim reference while hipfiring is exactly the thing scoping is supposed to cost
     *   you, so the sniper is aimed by its scope or not aimed at all.
     *
     * @param coneRad the half-angle the next round can land inside, in radians — the
     *   weapon's own spread times everything the body and the scope are doing to it. This
     *   is CS2's scoped-inaccuracy indicator, and it is the ONLY feedback a scoped player
     *   gets about the settle: without it a quick-scope that missed is indistinguishable
     *   from a hitbox that lied, which is the single most demoralising thing a shooter can
     *   do to somebody. The crosshair cannot do this job — it is hidden for a scoped
     *   weapon on purpose (see above) — so the reticle's own centre gap does it.
     * @param fovDeg the vertical field of view being drawn right now, which is what turns
     *   that angle into a size. A ring of fixed pixels would mean different things at the
     *   two zoom steps: the same cone covers twice as much glass at 30° as at 55°, and
     *   the whole point of the ring is that it is measured in the picture the player is
     *   actually looking at.
     */
    scope(amount, hasScope = false, coneRad = 0, fovDeg = 0) {
      const a = Math.round(amount * 100) / 100;
      // Where the cone lands on the glass. `coneRad` as a fraction of the half-FOV is the
      // fraction of the half-lens it covers; doubled because the gap is a diameter.
      const half = (fovDeg * Math.PI) / 360;
      const frac = a > 0 && half > 0 ? Math.min(1, coneRad / half) : 0;
      const ring = Math.min(RING_MAX_VMIN, RING_BASE_VMIN + frac * LENS_HALF_VMIN * 2);
      // Every input folds into the one early-out key, or toggling a flag at a settled
      // blend would not repaint. The ring is quantised to a tenth of a vmin first — it
      // moves every frame while the scope settles, and a DOM write per frame for a
      // difference nobody can see is the thing this early-out exists to avoid.
      const r = Math.round(ring * 10) / 10;
      const key = `${a}|${hasScope ? 1 : 0}|${r}`;
      if (key === shownScope) return;
      shownScope = key;
      els.scope.style.opacity = String(a);
      els.scope.style.setProperty('--ring', `${r}vmin`);
      els.cross.style.opacity = hasScope || a > 0.5 ? '0' : '';
    },

    /**
     * Open the crosshair by however far recoil has kicked the aim.
     *
     * @param radians the live punch magnitude from the input module — the same offset
     *        the shot itself is fired along, so the reticle is not decorating the
     *        recoil, it is reporting it.
     *
     * Written on `#cross` rather than on `:root` deliberately: the settings panel's
     * preview shares the geometry rule, and a preview that breathes while you are
     * trying to judge a gap setting is worse than one that does not move.
     */
    bloom(radians) {
      // Rounded to whole pixels — sub-pixel arm offsets are a blurry crosshair, and
      // it is also what lets this early-out most frames.
      const px = Math.min(BLOOM_MAX, Math.round(radians * BLOOM_PX));
      if (px === shownBloom) return;
      shownBloom = px;
      els.cross.style.setProperty('--ch-bloom', `${px}px`);
    },

    /**
     * Push the crosshair settings into CSS custom properties on the document root.
     *
     * Not called per frame — only when a setting changes. The properties live on
     * `:root` rather than on `#cross` so the settings panel's preview, which is a
     * different element in a different overlay, is drawn from the same numbers by the
     * same rules. Adjusting a crosshair against a preview that renders differently
     * from the real one is worse than having no preview.
     */
    crosshair(s) {
      const root = document.documentElement.style;
      root.setProperty('--ch-len', `${s.chLen}px`);
      root.setProperty('--ch-gap', `${s.chGap}px`);
      root.setProperty('--ch-thick', `${s.chThick}px`);
      root.setProperty('--ch-col', s.chHex);
      root.setProperty('--ch-dot', s.chDot ? 'block' : 'none');
      root.setProperty('--ch-out', s.chOutline ? '1px' : '0px');
      // The arms get their own outline width so a zero-length arm disappears
      // completely. Sharing one property left a 2×1 sliver of pure outline behind at
      // length 0 — visible, and impossible to explain to whoever set it there.
      root.setProperty('--ch-arm-out', s.chOutline && s.chLen > 0 ? '1px' : '0px');
    },

    setStatus(text) {
      els.startStatus.textContent = text;
    },    showStart(text) {
      if (text) els.startStatus.textContent = text;
      els.start.classList.remove('hidden');
    },
    hideStart() {
      els.start.classList.add('hidden');
    },

    health(hp) {
      const clamped = Math.max(0, Math.min(C.MAX_HP, hp));
      els.hpNum.textContent = String(clamped);
      els.hpFill.style.width = `${(clamped / C.MAX_HP) * 100}%`;
      els.vitals.classList.toggle('hurt', clamped <= 35);
    },

    /**
     * Spawn protection: how much of it is left.
     *
     * Invulnerability you cannot see reads as a bug, not a feature — the player who
     * shoots you and does no damage thinks the game is broken, and the player wearing
     * it does not know when it runs out and so cannot use it for the one thing it is
     * for: picking a direction before the fight starts. So the number is on screen,
     * counting down, and it leaves the instant the server stops honouring it.
     *
     * @param ms remaining protection in ms; 0 or less hides the whole readout.
     */
    shield(ms) {
      const on = ms > 0;
      if (on !== shownShieldOn) {
        shownShieldOn = on;
        els.shield.classList.toggle('on', on);
      }
      if (!on) return;
      // Written every frame, so both halves early-out on their own quantum: tenths for
      // the text, whole percent for the bar. Ceil the tenths — a shield with 0.04s left
      // is still a shield, and flooring it would show "0.0s" while you are safe.
      const tenths = Math.ceil(ms / 100);
      if (tenths !== shownShieldT) {
        shownShieldT = tenths;
        els.spSecs.textContent = (tenths / 10).toFixed(1);
      }
      const pct = Math.round((ms / C.SPAWN_PROTECT_MS) * 100);
      if (pct !== shownShieldPct) {
        shownShieldPct = pct;
        els.spFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
      }
    },

    /**
     * The sprint bar — and the one readout here that has to explain a rule rather than
     * report a number.
     *
     * Sprint is armed by a tap and the arming is remembered, so the latch can be set while
     * the server refuses to honour it. From the player's side that is a key that did
     * nothing. Worse, the refusal lifts on its own the moment stamina climbs back past
     * SPRINT_MIN_START — there is no second keypress to hang an explanation off, so if the
     * HUD says nothing the rule is simply never learnable. `blocked` is the explanation.
     *
     * @param frac stamina as 0..1. It travels the wire as whole units precisely so the two
     *        sides never disagree about it; turning it into a fraction is this readout's
     *        business and must not leak back into the simulation.
     * @param armed the client's own latch, `input.sprintArmed`.
     * @param blocked the server's refusal, `state.sprintLock` — authoritative, not guessed.
     */
    stamina(frac, armed, blocked) {
      const on = !!armed || frac < 1;
      if (on !== shownStamOn) {
        shownStamOn = on;
        els.stamina.classList.toggle('on', on);
      }
      if (!on) return;
      // Same quantum discipline as the shield above: this is called every frame, so the
      // bar early-outs on whole percent and the label on the boolean behind it.
      const pct = Math.round(frac * 100);
      if (pct !== shownStamPct) {
        shownStamPct = pct;
        els.stFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
      }
      const b = !!blocked;
      if (b !== shownStamBlocked) {
        shownStamBlocked = b;
        els.stamina.classList.toggle('blocked', b);
        els.stText.textContent = b ? 'winded' : '';
      }
    },

    /**
     * Your own rank, in words.
     *
     * This is where the NAMES live, and the plate over everybody's head deliberately does not
     * carry them — shared/ranks.js sets out why: twenty-one rank names are unreadable at the
     * four pixels a world-space plate gets at fighting distance, while a count of marks is
     * still a count. So the corner and the plate divide the job. What is on screen at all
     * times is your own, because your own head is the one you never see.
     *
     * Also the only place the distance to the next rank appears. A bare name is a label; a
     * name with "12 to Corporal" after it is something to play toward, and the ladder in
     * shared/ranks.js is steep enough that a player who is never told the number will read
     * the flat stretches as the feature being broken.
     *
     * @param career total career kills, from the private `self` blob. The shared player list
     *        carries only the derived tier on purpose, so this number reaches nobody else.
     */
    rank(career) {
      const cv = Math.max(0, Number.isFinite(career) ? career : 0);
      // Called every snapshot; a career changes a few times an hour. The early-out is on the
      // raw count rather than the tier because the "to next" line moves on every kill.
      if (cv === shownCareer) return;
      shownCareer = cv;
      const tier = rankOf(cv);
      els.rkName.textContent = TIERS[tier].name;
      const left = toNextRank(cv);
      // At the top there is nothing left to earn, so it says so rather than showing "0 to".
      els.rkNext.textContent =
        tier >= MAX_TIER ? 'top of the ladder' : `${left} to ${TIERS[tier + 1].name}`;
      els.rank.classList.add('on');
    },

    /** The whole weapon corner in one call: name, magazine, slot strip, crosshair.
     *  @param wep weapon index currently held — the server-confirmed one, not the
     *         requested one, so a weapon outside the loadout visibly fails.
     *  @param ammo rounds in that weapon's magazine.
     *  @param reloadMs ms left on a reload, 0 if not reloading.
     *  @param loadout weapon indices this mode allows, in slot order.
     *  @param jamMs ms left on a jam in that weapon, 0 if it is working. */
    weapon(wep, ammo, reloadMs, loadout, jamMs = 0) {
      // The strip only changes when the mode does, which is once per connection.
      const key = loadout.join(',');
      if (key !== slotKey) {
        slotKey = key;
        // Numbered by the weapon's own slot and sorted by it, NOT by position in the
        // loadout. Those coincide for a dealt hand and diverge everywhere else: sniper
        // match carries knife + sniper, so counting positions labelled the sniper "2"
        // while the key that actually draws it is 1.
        const strip = loadout
          .map((idx) => ({ idx, w: WEAPONS[idAt(idx)] }))
          .sort((a, b) => a.w.slot - b.w.slot);
        els.wSlots.replaceChildren(
          ...strip.map(({ idx, w }) => {
            const el = document.createElement('span');
            el.textContent = `${w.slot} ${w.label}`;
            el.dataset.wep = String(idx);
            return el;
          }),
        );
        shownWep = -1; // fresh nodes carry no `on` class
      }

      const w = WEAPONS[idAt(wep)];

      if (wep !== shownWep) {
        shownWep = wep;
        els.wName.textContent = w.label;
        for (const el of els.wSlots.children) {
          el.classList.toggle('on', Number(el.dataset.wep) === wep);
        }
      }

      // Magazine. A null `mag` means the weapon has no magazine at all — rendering
      // a 0 there would read as "empty", which is the opposite of the truth.
      //
      // A jam takes the readout ahead of even RELOADING, because it is the more
      // surprising of the two: a player who chose to reload knows why the gun is not
      // firing, and a player whose gun just stopped on its own does not. The hands are
      // already punching it on screen; this is the word for what they are doing.
      const text =
        jamMs > 0
          ? 'JAMMED'
          : reloadMs > 0
            ? 'RELOADING'
            : w.mag == null
              ? ''
              : `<b>${ammo}</b> / ${w.mag}`;
      if (text !== shownAmmo) {
        shownAmmo = text;
        els.wAmmo.innerHTML = text;
        els.wAmmo.classList.toggle('jam', jamMs > 0);
        els.wAmmo.classList.toggle('empty', reloadMs <= 0 && jamMs <= 0 && w.mag != null && ammo === 0);
      }
    },

    /** The match-state bar. `md` is whatever the mode controller's `state()` sent,
     *  so a mode with no state simply leaves the bar hidden. */
    mode(md, label, winnerName) {
      // Called every frame, and `style.visibility =` is a real style write even when
      // the value is unchanged — so it is gated like every other setter here.
      if (shownBar !== !!md) {
        shownBar = !!md;
        els.modeBar.style.visibility = md ? 'visible' : 'hidden';
      }
      if (!md) return;

      const over = md.ph === 'over';
      els.modeBar.classList.toggle('over', over);

      // Team scores. `md.ts` is `[alpha, bravo]` and is absent in a mode without sides,
      // which is what hides the line — a free-for-all shows the clock exactly as before.
      // Keyed on the joined string for the same reason every other setter here is keyed:
      // this runs every frame, and a score changes a few times a minute.
      const teams = md.ts ? `${md.ts[0]}/${md.ts[1]}` : null;
      if (teams !== shownTeams) {
        shownTeams = teams;
        els.mTeams.hidden = !teams;
        if (teams) {
          // `s` and `u` carry the two side colours from the stylesheet, the same pair the
          // scoreboard rows and the player avatars use. Set as markup rather than
          // `textContent` because the two halves have to be coloured differently, and
          // rebuilt whole because it happens on a kill, not on a frame.
          els.mTeams.innerHTML =
            `<s>${TEAM_NAMES[1]} ${md.ts[0]}</s><em>vs</em><u>${md.ts[1]} ${TEAM_NAMES[2]}</u>`;
        }
      }

      const time = over ? 'FINAL' : clock(md.tl);
      if (time !== shownTime) {
        shownTime = time;
        els.mTime.textContent = time;
      }

      const text = over
        ? winnerName
          ? `${winnerName} wins`
          : 'match over'
        : md.kl
          ? `${label} · first to ${md.kl}`
          : label;
      if (text !== shownLabel) {
        shownLabel = text;
        els.mLabel.textContent = text;
      }
    },

    /**
     * You hit somebody. `zone` is a HIT_ZONE — 0 body, 1 head, 2 legs.
     *
     * One element with a class rather than three markers: a headshot is not a different
     * event, it is the same event worth four times as much, and the marker is already the
     * thing that says "you connected". The class carries colour and size, both instant
     * (the transition is on opacity alone) because a marker that grows into a headshot
     * arrives after the duel it was meant to inform.
     */
    hitmarker(now, zone = 0) {
      els.hitmark.classList.toggle('head', zone === 1);
      els.hitmark.classList.toggle('legs', zone === 2);
      els.hitmark.style.opacity = '1';
      hitUntil = now + 110;
    },

    damaged(now) {
      els.vignette.style.opacity = '1';
      hurtUntil = now + 240;
    },

    /**
     * You died. A hard red hit, then the `#dead` overlay's own tint carries it.
     *
     * The report this answers was "when i die i dont know, it just stops then spawn me
     * somewhere theres no way to know" — so the flash is deliberately loud. It is the
     * one frame that has to be impossible to miss even if you were looking at the
     * killfeed when it happened.
     */
    died() {
      wash('rgba(178, 24, 10, 0.78)', 70, 620);
    },

    /**
     * Blinded by a flashbang, for `ms`.
     *
     * "the flashbang doesnt flash you white enough it should be as high white like you get
     * flashbang when you woke up and its dark like you open your phone that bright". Three
     * things were wrong and none of them was the colour's alpha — the wash has always run
     * at opacity 1.
     *
     *   - `#f2f4ff` is 242,244,255: a cold off-white, about 5% short of white on two
     *     channels. Against a pale arena that is the difference between "the screen is
     *     white" and "the screen is washed out". Now pure white.
     *   - The hold was a third of the duration and the rest faded LINEARLY, so the
     *     screen spent most of a flash at a partial opacity you can still fight through.
     *     The hold is now 0.44 and the fade eases, which roughly doubles the time spent
     *     at or near full white for the same duration.
     *   - `blindMs` itself was short once the distance and facing falloff had scaled it.
     *     Raised in projectile.js.
     *
     * The fade still matters and is still most of the duration: it is what tells you the
     * fight is coming back and roughly when, and an instant cut from opaque to clear reads
     * as a dropped frame. It is the *shape* of it that changed.
     */
    blind(ms) {
      wash('#ffffff', ms * 0.44, ms * 0.56, 'ease-in-out');
    },

    /** @param zone HIT_ZONE of the finishing shot, 1 for a head -- compared as a number
     *         for the reason hitmarker does: this file has never imported the enum. */
    feed(killerName, victimName, isSelfKiller, isSelfVictim, wep, zone = 0) {
      const row = document.createElement('div');
      const weaponId = wep == null ? 'kills' : idAt(wep);
      const weaponLabel = wep == null ? 'elimination' : WEAPONS[weaponId].label.toLowerCase();
      const head = zone === 1;
      // CS-style reading order: killer, weapon silhouette, optional headshot silhouette,
      // victim. The weapon and headshot are pictures rather than trailing words, so the
      // feed can be understood in peripheral vision instead of read like a sentence.
      row.innerHTML =
        `<span class="kf-name${isSelfKiller ? ' self' : ''}">${esc(killerName)}</span>`
        + `<span class="kf-action" title="${esc(weaponLabel + (head ? ' headshot' : ''))}">`
        + `<svg class="kf-weapon" viewBox="-42 -24 84 48" aria-hidden="true">`
        + `<use href="#g-${weaponId}"></use></svg>`
        + (head
          ? '<svg class="kf-head" viewBox="-24 -24 48 48" aria-hidden="true"><use href="#g-hs"></use></svg>'
          : '')
        + '</span>'
        + `<span class="kf-name${isSelfVictim ? ' self victim' : ''}">${esc(victimName)}</span>`;
      els.feed.prepend(row);
      while (els.feed.children.length > 5) els.feed.lastChild.remove();
      setTimeout(() => row.remove(), 5200);
    },

    /** @param secondsLeft null in modes with no mid-round respawn (arena).
     *  @param killer `{name, wep}` for the shot that landed, or null for a fall or
     *         any other death with nobody to blame. */
    dead(secondsLeft, killer) {
      els.dead.classList.remove('hidden');

      const secs = secondsLeft == null ? '' : Math.max(0, secondsLeft).toFixed(1);
      if (secs !== shownSecs) {
        shownSecs = secs;
        els.respawnIn.textContent = secs;
      }

      const key = killer ? `${killer.name} ${killer.wep}` : '';
      if (key !== shownKiller) {
        shownKiller = key;
        els.killedBy.innerHTML = killer
          ? `killed by <b>${esc(killer.name)}</b> <span>${esc(WEAPONS[idAt(killer.wep)].label)}</span>`
          : '';
      }
    },
    alive() {
      els.dead.classList.add('hidden');
      shownSecs = '';
      shownKiller = '';
    },

    /**
     * The scoreboard: who is here, how they are doing, their rank and connection.
     *
     * TWO SOURCES, and that is the shape of the whole thing. `players` is the snapshot, which
     * lands twenty times a second and carries what moves — score, team, ping. `roster` is
     * MSG.ROSTER, which lands on a join, a drop or a promotion and carries who somebody is —
     * name and rank. Merged by id, and the snapshot's own `n` and `rk` are the
     * fallback for the beat before the first roster arrives, so a board opened on the very
     * first frame of a match is complete rather than nameless.
     *
     * Rebuilt only when the markup would actually differ, which is the same early-out
     * everything else in this file uses and it earns it more than most: this runs from the
     * frame loop for as long as a key is held, and re-parsing twelve rows of identical HTML
     * sixty times a second is a cost paid on exactly the machines least able to absorb it.
     */
    scoreboard(now, show, players, roster, selfId, caption, teams) {
      els.board.classList.toggle('show', show);
      if (!show) return;
      if (caption) els.boardCap.textContent = caption;
      const sorted = [...players].sort(
        (a, b) => b.k - a.k || a.d - b.d || String(a.n).localeCompare(String(b.n)),
      );
      // THE TALLY in the header band. In a team mode this is the authoritative score out of
      // `md.ts` — the same array the centre readout uses, so the board and the top of the
      // screen cannot disagree about who is winning. In FFA there is no score to name, so it
      // says how many are here, which is the only fact the header can add.
      const tally = Array.isArray(teams)
        ? `<span class="tA">${TEAM_NAMES[1]}</span> <b class="tA">${teams[0] | 0}</b>`
          + `<span class="vs">vs</span>`
          + `<b class="tB">${teams[1] | 0}</b> <span class="tB">${TEAM_NAMES[2]}</span>`
        : `${sorted.length} in the room`;
      if (tally !== boardTally) {
        boardTally = tally;
        els.boardTally.innerHTML = tally;
      }
      const html = sorted
        .map((p, i) => {
          const who = roster?.get?.(p.id);
          const cls = [p.id === selfId ? 'me' : '', p.tm === 1 ? 'tA' : p.tm === 2 ? 'tB' : '']
            .filter(Boolean)
            .join(' ');
          // Rank zero is still a rank. The recruit shield in insignia.js makes Private a real
          // device rather than an abbreviation standing in for missing artwork.
          const tier = who?.rk ?? p.rk ?? 0;
          // THE CONNECTION, as a number and as four bars. The grade behind both comes off
          // `pingGrade`, which is the same function the region cards in the menu grade
          // themselves with, so a player who picked ASIA because it was green does not find
          // a different opinion of green on the scoreboard.
          const grade = pingGrade(p.pg ?? NaN);
          return `<tr class="${cls}">`
            + `<td class="pl">${i + 1}</td>`
            + `<td class="rank">${rankCell(tier)}</td>`
            + `<td class="who">${esc(who?.n ?? p.n)}</td>`
            + `<td class="num k">${p.k}</td><td class="num">${p.d}</td>`
            // A ping of 0 is not a ping of 0. It means nobody has measured one: a bot in the
            // in-page host, or a socket in the first second of its life before the first
            // echo. An en dash says that; a "0ms" would be a claim.
            + `<td class="pg p-${grade}"><i class="sig l${SIGNAL_BARS[grade] ?? 0}"></i>`
            + `<b>${p.pg ? `${p.pg}` : '–'}</b></td>`
            + `</tr>`;
        })
        .join('');
      if (html === boardHtml) return;
      boardHtml = html;
      els.boardRows.innerHTML = html;
    },

    net(now, rtt, snapRate, pending) {
      // Refresh a few times a second, not every frame — otherwise it's unreadable.
      if (now < netThrottle) return;
      netThrottle = now + 220;
      els.nRtt.textContent = rtt ? `${Math.round(rtt)}ms` : '–';
      els.nSnap.textContent = snapRate ? `${snapRate.toFixed(1)}/s` : '–';
      els.nPred.textContent = `${pending} tick${pending === 1 ? '' : 's'}`;
    },

    /**
     * Your own badge on the track a kill just moved.
     *
     * Shown on EVERY kill, which is what was asked for -- "so each kill it shows your
     * badge" -- and is also the only thing that makes the tiers legible at all: a card
     * that appeared only on a promotion would show up four times in an evening, and a
     * player would never learn there were counts behind it.
     *
     * @param card `{key, count, promoted, levelUp}` -- the track, the count AFTER this kill,
     *        whether this kill earned a new emblem, and whether it earned a step of any kind.
     *        main.js derives all of them by diffing the authoritative counts, so nothing here
     *        has to know what a kill was worth.
     */
    badge(now, card) {
      if (!card) return;
      const busy = badgeUntil > now;
      if (card.promoted) {
        // Never truncate a promotion with another promotion. An ordinary card it may
        // replace, because it is strictly better news about the same kill.
        if (busy && badgeUp) {
          if (badgeQueue.length < BADGE_QUEUE_MAX) badgeQueue.push(card);
          return;
        }
        showBadge(card, now);
        return;
      }
      // A promotion on screen already says everything this card would, and louder. Dropped
      // rather than queued: by the time the promotion clears, this count is two kills old.
      if (busy && badgeUp) return;
      showBadge(card, now);
    },

    /**
     * The killmark: one more leg on the star, and the window reset.
     *
     * WHY THIS TAKES A COUNT AND NOT AN INCREMENT. main.js owns the chain, because main.js
     * is the only place that knows when it broke -- a window that ran out, or a death. The
     * HUD given an `add()` would have to keep the count, and then two files would believe
     * different things about the same number the moment one of them missed a frame. Here it
     * is told the whole state and draws it, the same division the badge card uses.
     *
     * @param n     kills in the chain INCLUDING this one, 1 and up. Capped to the star at
     *              six legs by legsOf: a seventh kill refreshes the window and redraws the
     *              same six legs, which is CrossFire's rule.
     * @param glyph a sprite id from the top of index.html -- the weapon, or the head for a
     *              headshot. Passed rather than derived so the HUD needs no weapon table.
     * @param wings 0..4, from the career badge. The badge decorates the mark and never the
     *              other way round.
     */
    killmark(now, { n, glyph, wings = 0 }) {
      const legs = legsOf(n);
      if (!legs) return;
      // Rebuilt, not patched, for the reason showBadge rebuilds its own: `k3` left under a
      // `k4` chain lights four legs and three, and CSS has no opinion about which wins.
      els.killmark.className = `k${legs} w${wings}`;
      if (legs >= SPREE_LEGS) els.killmark.classList.add('full');
      els.kmGlyph.setAttribute('href', glyph);
      els.kmName.textContent = spreeName(legs);
      // The pop belongs to the newest leg alone. Taken off all six first, because the leg
      // that popped last time is still carrying the class and a second `.new` would light
      // two -- and then the reflow, or removing and re-adding it to the SAME leg on a
      // seventh kill is coalesced into no change and the animation never replays.
      for (const leg of els.killmark.querySelectorAll('.km-leg')) leg.classList.remove('new');
      void els.killmark.offsetWidth;
      els.killmark.querySelector(`.km-leg.l${legs}`)?.classList.add('new');
      kmFrom = now;
      kmUntil = now + SPREE_MS;
      // Drawn full immediately rather than waiting for the next tick. At 60 Hz that is one
      // frame, and one frame of a bar starting from wherever it was left is visible.
      els.kmFill.style.width = '100%';
      els.kmBar.classList.remove('low');
      kmLow = false;
      els.killmark.classList.add('on');
    },

    /** The chain is over: a death, or a round ending. Takes the mark off screen at once. */
    killmarkClear() {
      if (!kmUntil) return;
      kmUntil = 0;
      kmFrom = 0;
      els.killmark.classList.remove('on');
    },

    /** Called every frame to expire the transient flashes. */
    tick(now) {
      if (hitUntil && now >= hitUntil) {
        els.hitmark.style.opacity = '0';
        hitUntil = 0;
      }
      if (hurtUntil && now >= hurtUntil) {
        els.vignette.style.opacity = '0';
        hurtUntil = 0;
      }
      if (badgeUntil && now >= badgeUntil) {
        // A queued promotion takes the slot as this one leaves it, so a double promotion
        // reads as two events rather than one card that changed its mind.
        if (badgeQueue.length) showBadge(badgeQueue.shift(), now);
        else {
          els.badge.classList.remove('on');
          badgeUntil = 0;
          badgeUp = false;
        }
      }
      // THE WINDOW, EVERY FRAME. The bar is the only part of this HUD that has to move
      // continuously rather than change on an event, so it is the only one written per
      // frame -- and it still guards the two text writes behind last-drawn values, because
      // at 60 Hz for four seconds that is 240 frames and the tenths only change 40 times.
      if (kmUntil) {
        if (now >= kmUntil) {
          els.killmark.classList.remove('on');
          kmUntil = 0;
          kmFrom = 0;
          shownKmSecs = '';
        } else {
          const left = kmUntil - now;
          els.kmFill.style.width = `${(left / (kmUntil - kmFrom)) * 100}%`;
          // A second left. Late enough to mean "now or never" and early enough to still act
          // on -- half a second is a frame or two of reaction time and no decision.
          const low = left <= 1000;
          if (low !== kmLow) {
            els.kmBar.classList.toggle('low', low);
            kmLow = low;
          }
          // Ceil, so it reads 1.0 while there is still any time at all and never shows a
          // 0.0 the player could believe they have a shot inside.
          const secs = `${(Math.ceil(left / 100) / 10).toFixed(1)}s`;
          if (secs !== shownKmSecs) {
            els.kmSecs.textContent = secs;
            shownKmSecs = secs;
          }
        }
      }
    },
  };
}

/**
 * How many of the four signal bars a ping grade lights.
 *
 * Derived here rather than in the stylesheet because `pingGrade` is the one authority on
 * where the boundaries are: a fifth grade added to `shared/regions.js` would otherwise light
 * zero bars silently, and verify checks that every grade it can return appears in this map.
 */
const SIGNAL_BARS = { good: 4, fair: 3, poor: 2, bad: 1, none: 0 };

/**
 * THE RANK LOGO in the scoreboard's gutter, as one CSS rule per tier written on demand.
 *
 * The device is a PNG of the SAME canvas render.js hangs over the player's head — see
 * insignia.js. Two reasons it arrives as a background-image and not as an `<img src>`: a data
 * URL of a couple of kilobytes repeated on every row of every rebuilt table is a lot of
 * markup to diff sixty times a second, and a rule keyed by tier is written once per rank the
 * player has ever seen and then costs nothing. `#board .rki.tN` is generated, so the tier
 * number IS the cache key and `insHave` is only there to avoid inserting the same rule twice.
 *
 * Private is cached exactly like every other tier; its invented recruit shield is intentional
 * game artwork, not a text fallback for a missing real-world E-1 device.
 */
const insHave = new Set();
let insSheet = null;

function insigniaCell(tier) {
  const png = insigniaPng(tier);
  if (!png) return '';
  const t = tier | 0;
  if (!insHave.has(t)) {
    insHave.add(t);
    if (!insSheet) {
      const el = document.createElement('style');
      document.head.appendChild(el);
      insSheet = el.sheet;
    }
    // Height is fixed by the stylesheet and `contain` fits the width inside it, so a general's
    // five stars and a corporal's two chevrons come out the same height. That is deliberate
    // and it is the same rule the world plate follows.
    insSheet?.insertRule(`#board td.rank .rki.t${t}{background-image:url("${png.url}")}`);
  }
  return `<i class="rki t${t}" title="${esc(TIERS[t]?.name ?? '')}"></i>`;
}

/** A scoreboard rank that is never blank: every tier has an insignia and an abbreviation.
 * The full name remains in the title so the compact column is useful without making General
 * of the Army wider than the player's name. */
function rankCell(tier) {
  const t = Math.max(0, Math.min(MAX_TIER, Number.isFinite(tier) ? tier | 0 : 0));
  const rank = TIERS[t] ?? TIERS[0];
  return `${insigniaCell(t)}<b title="${esc(rank.name)}">${esc(rank.abbr)}</b>`;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
