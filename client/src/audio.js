// Every sound is synthesized — no audio files. A gunshot is a noise burst through
// a collapsing lowpass plus a sine thump, which is genuinely most of the way to a
// convincing report.
//
// The context is created lazily on first user gesture, because browsers refuse to
// start audio before one.

import { SPREE_LEGS, legsOf } from '../../shared/spree.js';

/**
 * The root note for a chain of 2..6, indexed by leg. Legs 0 and 1 are silent, so they
 * are holes in the table rather than numbers.
 *
 * MINOR THIRDS, C5 UP TO C6. The interval is the whole design: a chain has to be
 * countable by ear, because the star is bottom-centre and a player mid-fight is looking
 * at the middle of the screen. Semitones would be indistinguishable in the third of a
 * second this gets; a minor third is wide enough that leg 4 and leg 5 are obviously
 * different notes to someone who has never thought about intervals. Stacked, they spell a
 * diminished chord — unresolved on purpose, because the chain is not finished either, and
 * the run lands exactly an octave up so the top of the ladder sounds like the top.
 */
const SPREE_ROOT = [0, 0, 523.25, 622.25, 739.99, 880, 1046.5];

// A leg with no note would set an oscillator to `undefined` Hz, which is a
// silent-and-console-noisy failure rather than a wrong sound. Checked here so adding a
// seventh leg to shared/spree.js cannot ship without a note to go under it.
if (SPREE_ROOT.length !== SPREE_LEGS + 1) {
  throw new Error(`audio: ${SPREE_ROOT.length - 1} spree roots for ${SPREE_LEGS} legs`);
}

/**
 * One voicing per gun.
 *
 * Every weapon used to fire the identical report, which undid a good deal of the point
 * of having weapon types: sound is how you know what is being fired at you from across
 * the map, and a shotgun that cracks like a pistol is a shotgun you cannot hear coming.
 *
 * The three things that separate them are all here. `cut0 → cut1` over `decay` is the
 * body — a wide, slow sweep is a big gun and a tight fast one is a small gun. `f0 → f1`
 * at `tp` is the thump underneath, which is what you feel rather than hear. `tail` is a
 * second, much longer noise burst for the two weapons that ring off the walls; its
 * absence is why an SMG sounds dry.
 */
const GUNS = {
  pistol: { peak: 0.7, decay: 0.1, cut0: 5200, cut1: 520, q: 1.2, f0: 200, f1: 62, tp: 0.32, td: 0.075 },
  rifle: { peak: 0.85, decay: 0.15, cut0: 5600, cut1: 380, q: 0.9, f0: 150, f1: 46, tp: 0.5, td: 0.11 },
  // Small, fast and dry. Short enough that the 80ms cadence reads as a rip rather than
  // as overlapping reports.
  smg: { peak: 0.6, decay: 0.075, cut0: 6400, cut1: 900, q: 1.4, f0: 240, f1: 90, tp: 0.24, td: 0.05 },
  // The heaviest body in the table and a real thump under it, at 105ms — a machine gun
  // is meant to be the loudest thing in the room.
  lmg: { peak: 0.95, decay: 0.19, cut0: 4800, cut1: 260, q: 0.8, f0: 120, f1: 38, tp: 0.6, td: 0.15, tail: 0.2, tailMs: 0.34 },
  // A hard single crack. Louder per round than the rifle, which is the whole trade.
  semi: { peak: 0.95, decay: 0.16, cut0: 6000, cut1: 320, q: 0.85, f0: 165, f1: 44, tp: 0.58, td: 0.13 },
  sniper: { peak: 1, decay: 0.22, cut0: 7000, cut1: 200, q: 0.7, f0: 110, f1: 30, tp: 0.7, td: 0.2, tail: 0.3, tailMs: 0.7 },
  // Broad and low with almost no crack — the one report in the game with more body
  // than edge, which is exactly how a shotgun differs from a rifle to the ear.
  shotgun: { peak: 1, decay: 0.24, cut0: 3200, cut1: 170, q: 0.6, f0: 95, f1: 32, tp: 0.75, td: 0.26, tail: 0.26, tailMs: 0.5 },
  rifle_havoc: { peak: 0.94, decay: 0.18, cut0: 5100, cut1: 300, q: 0.82, f0: 132, f1: 40, tp: 0.58, td: 0.14 },
  rifle_falcon: { peak: 0.78, decay: 0.12, cut0: 6100, cut1: 520, q: 1.05, f0: 175, f1: 55, tp: 0.42, td: 0.09 },
  smg_kite: { peak: 0.52, decay: 0.058, cut0: 7200, cut1: 1120, q: 1.55, f0: 270, f1: 105, tp: 0.2, td: 0.04 },
  smg_banshee: { peak: 0.72, decay: 0.095, cut0: 5700, cut1: 700, q: 1.2, f0: 205, f1: 70, tp: 0.32, td: 0.07 },
  pistol_wisp: { peak: 0.58, decay: 0.075, cut0: 6500, cut1: 790, q: 1.35, f0: 230, f1: 80, tp: 0.25, td: 0.055 },
  pistol_rook: { peak: 0.9, decay: 0.16, cut0: 4700, cut1: 280, q: 0.8, f0: 125, f1: 38, tp: 0.58, td: 0.13, tail: 0.1, tailMs: 0.24 },
  lmg_atlas: { peak: 0.88, decay: 0.15, cut0: 5200, cut1: 340, q: 0.9, f0: 140, f1: 42, tp: 0.52, td: 0.12, tail: 0.14, tailMs: 0.28 },
  lmg_colossus: { peak: 1, decay: 0.22, cut0: 4200, cut1: 210, q: 0.72, f0: 95, f1: 28, tp: 0.72, td: 0.18, tail: 0.26, tailMs: 0.46 },
};

/** Where the ear ends up at the height of a flashbang, and how it gets back.
 *
 *  "make sure the sound like if you got directly flashbang the sound should be long
 *  enough maybe few seconds you cant hear good enough footsteps or bullet sounds in that
 *  way it kinda you know". Two things do that, and they are separate on purpose: `cut`
 *  takes the top off everything, which is what turns a footstep into a thud you cannot
 *  place, and `duck` turns the whole world down, which is what makes it distant. Muffle
 *  alone leaves a loud, dull world; ducking alone leaves a quiet, crisp one you can still
 *  play in.
 *
 *  `ratio` stretches the ear effect past the eyes: ringing outlasts the white-out, and a
 *  world that comes back the instant the screen clears has no aftermath to it. `hold` is
 *  the fraction spent at the bottom before the recovery starts.
 */
const DEAF = { cut: 380, duck: 0.2, open: 20000, ratio: 1.45, maxMs: 5400, hold: 0.42, onset: 0.05 };

export function createAudio() {
  let ctx = null;
  let master = null;
  /** The bus every voice lands on, and the filter under it. Muffling one node is what
   *  makes a flashbang deafen everything at once rather than needing every sound in the
   *  file to know it might be muffled. `master` stays downstream of both so the volume
   *  slider still works while deafened, and so a sound that wants to bypass the muffle
   *  (the ring itself) can reach it directly. */
  let sfx = null;
  let deaf = null;
  let deafUntil = 0;
  let noiseBuf = null;
  /** Master volume, held here rather than on the gain node because the settings
   *  panel can be dragged before any user gesture has let us build a context. */
  let vol = 0.45;

  function ensure() {
    if (ctx) return ctx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = vol;
    master.connect(ctx.destination);

    // Voices → sfx (duck) → deaf (muffle) → master (volume) → out.
    deaf = ctx.createBiquadFilter();
    deaf.type = 'lowpass';
    deaf.Q.value = 0.0001;   // no resonant peak at the corner: a whistle, not a muffle
    deaf.frequency.value = DEAF.open;
    deaf.connect(master);
    sfx = ctx.createGain();
    sfx.gain.value = 1;
    sfx.connect(deaf);

    const len = Math.floor(ctx.sampleRate * 0.5);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    return ctx;
  }

  /**
   * @param dest which bus to land on. Defaults to `sfx`, so everything is deafenable
   *   without knowing it; the flashbang's own ring passes `master` to bypass the muffle,
   *   because the ring is the thing you hear *instead* of the world and muffling it would
   *   remove the only sound that is supposed to be there.
   */
  function env(node, peak, decay, t0, dest = null) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
    node.connect(g);
    g.connect(dest ?? sfx);
    return g;
  }

  function tone(type, f0, f1, peak, decay, t0, dest = null) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + decay);
    env(o, peak, decay, t0, dest);
    o.start(t0);
    o.stop(t0 + decay + 0.02);
  }

  function burst(peak, decay, cut0, cut1, t0, q = 1, dest = null) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = q;
    lp.frequency.setValueAtTime(cut0, t0);
    lp.frequency.exponentialRampToValueAtTime(Math.max(60, cut1), t0 + decay);
    src.connect(lp);
    env(lp, peak, decay, t0, dest);
    src.start(t0);
    src.stop(t0 + decay + 0.02);
  }

  /**
   * The two halves of an action being worked: brass and spring going back, then the bolt
   * slamming home. Shared by `draw()` and `cycle()`, which are the same mechanism at two
   * speeds — a deploy racks it in a tenth of a second, a bolt gun takes half a second —
   * so the two beats are separate arguments rather than a fixed gap.
   *
   * @param w already-clamped weight; everything is pitched by it, so the sniper's stroke
   *   is a low clack and the pistol's a light snap off the one set of numbers.
   */
  function stroke(w, tBack, tHome, gain = 1) {
    // Back: a dry metallic scrape.
    burst(0.26 * gain, 0.06, 5200 / w, 1500 / w, tBack, 1.8);
    tone('square', 700 / w, 400 / w, 0.045 * gain, 0.05, tBack);
    // Forward: heavier and lower than the pull, and it is the beat the player actually
    // hears as "ready".
    burst(0.34 * gain, 0.08, 2200 / w, 420 / w, tHome, 1.5);
    tone('sine', 150 / w, 60 / w, 0.26 * gain, 0.07, tHome);
    tone('triangle', 560 / w, 260 / w, 0.06 * gain, 0.05, tHome + 0.004);
  }

  return {
    resume() {
      const c = ensure();
      if (c?.state === 'suspended') c.resume();
    },

    /** Master volume, 0 to 1. Takes effect immediately if there is a context and is
     *  remembered for the one we have not been allowed to build yet. */
    setVolume(v) {
      vol = Math.max(0, Math.min(1, v));
      // A short ramp rather than an assignment: stepping a gain node mid-sound
      // clicks, and the slider produces a change per pixel of drag.
      if (master) master.gain.setTargetAtTime(vol, ctx.currentTime, 0.01);
    },

    /**
     * A flashbang went off in your face: take the world's ears away for a while.
     *
     * `ms` is the same duration the server sent for the white-out, so the ear and the eye
     * are scaled by the one number and a flash you half-turned away from is short in both.
     * The ear runs `DEAF.ratio` longer than the eye on purpose — the ringing outlasting
     * the white is what gives it an aftermath instead of an off switch.
     *
     * The ring itself is routed at `master`, downstream of the muffle: it is the sound you
     * hear *instead* of the world, and running it through the same lowpass that is hiding
     * the footsteps would hide it too.
     *
     * A second flash while still deafened does not stack — `cancelScheduledValues` throws
     * away the recovery ramp and the deeper of the two states wins, because two overlapping
     * recoveries on one node resolve to whichever was scheduled last, which for a player
     * being double-flashed would mean the *first* bang deciding when they can hear again.
     */
    deafen(ms) {
      if (!ensure() || !(ms > 0)) return;
      // The muffle closes `DEAF.onset` after the bang, not on it. EV.BURST is dispatched
      // one event ahead of EV.BLIND, so both land in the same frame, and closing the
      // filter on the same instant swallows the crack that is the reason you cannot hear
      // — you would be deafened by a sound you never got to hear. 50ms is long enough for
      // the transient and short enough that nothing else can happen in it.
      const t = ctx.currentTime + DEAF.onset;
      const total = Math.min(DEAF.maxMs, ms * DEAF.ratio) / 1000;
      const bottom = total * DEAF.hold;
      // Only ever go deeper, never shallower: a distant second bang must not shorten the
      // point-blank one you are already sitting inside.
      const end = t + total;
      if (end < deafUntil) return;
      deafUntil = end;

      for (const [param, low, high] of [[deaf.frequency, DEAF.cut, DEAF.open], [sfx.gain, DEAF.duck, 1]]) {
        param.cancelScheduledValues(t);
        param.setValueAtTime(low, t);
        param.setValueAtTime(low, t + bottom);
        // Exponential, because both of these are perceived logarithmically — a linear
        // ramp on a filter corner spends most of its length in the top octave, where
        // nothing about the sound is still changing.
        param.exponentialRampToValueAtTime(high, end);
      }

      // The ring: two close, quiet, very long tones that beat against each other, which is
      // what makes it sit in the head rather than sound like a test tone. Tracks the
      // duration, so a glancing flash rings for a moment and a direct one for seconds.
      const ring = Math.min(total, 4.2);
      tone('sine', 4180, 3900, 0.09, ring, t, master);
      tone('sine', 4460, 4230, 0.055, ring * 0.86, t, master);
    },

    /**
     * A gun went off. `gain` attenuates remote shots with distance; `id` picks the
     * voicing out of GUNS.
     *
     * The default is the rifle rather than a neutral report, so a caller that forgets to
     * pass an id gets a real gun rather than a beep. An unknown id lands there too —
     * this is the one place in the client where a weapon that has slipped out of the
     * table should still make a noise, because a silent shot is invisible.
     */
    shot(gain = 1, id = 'rifle') {
      if (!ensure() || gain <= 0.02) return;
      const g = GUNS[id] ?? GUNS.rifle;
      const t = ctx.currentTime;
      burst(g.peak * gain, g.decay, g.cut0, g.cut1, t, g.q);
      tone('sine', g.f0, g.f1, g.tp * gain, g.td, t);
      // The crack coming back off the walls. Only the heavy weapons get it, and it is
      // what makes a sniper across the map sound like a sniper across the map.
      if (g.tail) burst(g.tail * gain, g.tailMs, 1100, 130, t + 0.03, 1.2);
    },

    /**
     * You connected. `head` lays a second, higher blip on top of the same click.
     *
     * ADDING rather than replacing, deliberately. A headshot is not a different event, it
     * is the same event worth four times as much -- the argument hud.hitmarker makes for
     * using one element with a class -- so the body click still plays and a brighter tick
     * lands over it. That reads as "that one, but better" inside the tenth of a second a
     * duel gives you to notice; a wholly separate sound would have to be learned before it
     * meant anything, and this is feedback that has to work the first time.
     */
    hit(head = false) {
      if (!ensure()) return;
      const t = ctx.currentTime;
      tone('square', 1500, 1100, 0.16, 0.05, t);
      // Short, high, and a hair late, so the two are heard as one accented click rather
      // than as two hits -- two clicks would read as a second bullet landing.
      if (head) tone('square', 2600, 2100, 0.1, 0.035, t + 0.012);
    },

    /** A knife swing. Air, not a report — a resonant whoosh that cuts off. Firing a
     *  gunshot sample for a knife is most of why the knife "didn't work like a
     *  knife": it sounded like a rifle with no bullet. The heavy stab is longer and
     *  lower, matching the wind-up you can see. */
    swing(heavy = false, gain = 1) {
      if (!ensure() || gain <= 0.02) return;
      const t = ctx.currentTime;
      burst(0.34 * gain, heavy ? 0.2 : 0.12, heavy ? 900 : 1500, heavy ? 170 : 340, t, 3.4);
    },

    /**
     * Something left your hand. Air and cloth, and no report of any kind.
     *
     * Everything thrown used to go through `shot()`, which has a voicing for none of them
     * and falls back to the rifle — so throwing a snowball fired a full rifle crack across
     * the room. That is the knife's bug above reached down the other branch: `shot` is what
     * everything not-melee is routed to, and a snowball is not melee, it is `projectile`.
     * Hearing a gunshot come out of your own hand is a large part of what made the
     * snowball read as a gun rather than as a snowball.
     *
     * Softer and duller than a swing: a throw is an arm opening, not a blade being driven
     * through something, and the release is a tick of fabric rather than an impact.
     */
    toss(gain = 1) {
      if (!ensure() || gain <= 0.02) return;
      const t = ctx.currentTime;
      // The arm through the air: wide, dull, and closing fast.
      burst(0.2 * gain, 0.15, 1100, 260, t, 2.6);
      // The release a moment into it — the hand opening, and the sleeve with it.
      burst(0.11 * gain, 0.05, 3000, 900, t + 0.08, 1.1);
    },

    /** A shot or a swing landed on the world. Deliberately quiet: it is confirmation
     *  that the geometry is solid, not an event in its own right. But it has to exist
     *  — silence on a wall hit is what made the world feel like it wasn't there. */
    thud(melee = false, gain = 1) {
      if (!ensure() || gain <= 0.02) return;
      const t = ctx.currentTime;
      if (melee) {
        burst(0.26 * gain, 0.1, 2700, 700, t, 1.7);
        tone('triangle', 330, 150, 0.1 * gain, 0.07, t);
      } else {
        burst(0.3 * gain, 0.085, 3900, 520, t, 1.2);
        tone('sine', 215, 70, 0.14 * gain, 0.065, t);
      }
    },

    /**
     * A weapon jammed, and the hands are clearing it. The whole 700ms gesture, scheduled
     * in one go.
     *
     * Written as one sound rather than as a click plus per-punch calls from the animation
     * for the same reason a gunshot is one call: the sequence is fixed, WebAudio can
     * schedule it more accurately than a frame loop can trigger it, and a visual that
     * drops a frame must not also drop the thump that goes with it. `ms` is the server's
     * own clear time, so the last beat lands as the weapon comes back rather than at a
     * duration this file decided on its own.
     *
     * Four beats, and the shape is the story: a dead click where a shot should have been,
     * two hits on the receiver — the second harder, because the first did not work — and
     * then the action finally cycling. That last one is the only bright sound in it, and
     * it is what tells you the gun is yours again without looking at the HUD.
     */
    jam(ms = 700, gain = 1) {
      if (!ensure() || gain <= 0.02) return;
      const t = ctx.currentTime;
      const s = ms / 1000;
      // The dead trigger: all click, no body. A shot with the low end taken out is
      // exactly what a failure to fire sounds like.
      burst(0.3 * gain, 0.03, 5000, 2400, t, 2.2);
      tone('square', 900, 520, 0.05 * gain, 0.025, t);
      // Two palm strikes on the receiver. Flesh on metal: a dull thump with a short
      // metallic ring over it, and the ring is what stops it sounding like a footstep.
      for (const [at, hard] of [[0.3, 0.8], [0.55, 1]]) {
        const t0 = t + s * at;
        burst(0.34 * gain * hard, 0.07, 1700, 380, t0, 1.6);
        tone('sine', 130 * hard, 52, 0.3 * gain * hard, 0.075, t0);
        tone('triangle', 620, 300, 0.07 * gain * hard, 0.05, t0 + 0.005);
      }
      // The action cycling and the case clearing the port. Bright and short — the one
      // sound in this that means the weapon works again.
      const t1 = t + s * 0.82;
      burst(0.26 * gain, 0.09, 6800, 1500, t1, 1.1);
      tone('triangle', 1500, 760, 0.06 * gain, 0.07, t1);
    },

    /** A projectile ended. The four kinds are not the same sound turned down.
     *
     * A grenade is a crack on top of a long low body — the crack is what carries the
     * distance and the body is what you feel. A snowball is the opposite: a short dry
     * crush with nothing under it, because packed snow breaking has no low end at all.
     * There was previously no sound here whatsoever, which is a large part of why the
     * explosions read as animations rather than as events.
     *
     * The two utility kinds matter for a reason beyond flavour. Both do their real work
     * to somebody else's screen, so the pop is the only warning anyone gets, and the two
     * warnings ask for opposite reactions — turn away from a flash, push through a smoke.
     * If they sounded alike the sound would be worthless.
     */
    explode(kind = 'grenade', gain = 1) {
      if (!ensure() || gain <= 0.02) return;
      const t = ctx.currentTime;
      if (kind === 'snowball') {
        burst(0.4 * gain, 0.13, 5200, 900, t, 1.1);
        tone('triangle', 420, 190, 0.09 * gain, 0.08, t);
        return;
      }
      if (kind === 'flash') {
        // All edge and no body: a very short, very bright crack with nothing under it,
        // because the low end is what makes a sound feel like an explosion and this is
        // not one. Then a metallic ring on top.
        //
        // This is the bang as *heard in the room*, so it is what a bystander who was
        // looking the wrong way gets and nothing more. The long ring and the muffling
        // belong to `deafen()`, driven off EV.BLIND — they are what happens to an ear
        // that was pointed at it, and putting them here would ring the ears of everybody
        // on the map including the people the flash failed against.
        burst(1 * gain, 0.05, 12000, 5200, t, 0.6);
        tone('square', 2600, 2200, 0.1 * gain, 0.5, t + 0.01);
        tone('square', 3900, 3500, 0.06 * gain, 0.62, t + 0.02);
        burst(0.16 * gain, 0.3, 4200, 1800, t + 0.04, 2.4);
        return;
      }
      if (kind === 'smoke') {
        // A soft pop, then a long hiss that sweeps down as the canister empties. The
        // hiss is much longer than any other sound here on purpose: it lasts about as
        // long as the cloud takes to bloom, so the noise stops at roughly the moment
        // the smoke is actually thick enough to hide behind.
        burst(0.5 * gain, 0.1, 2600, 700, t, 1.3);
        tone('sine', 150, 70, 0.16 * gain, 0.1, t);
        burst(0.3 * gain, 1.1, 6200, 1500, t + 0.03, 0.8);
        return;
      }
      // Sharp transient, then the boom, then the tail that makes it sound big.
      burst(1 * gain, 0.09, 8000, 2200, t, 0.7);
      tone('sine', 90, 30, 0.9 * gain, 0.5, t);
      tone('sawtooth', 140, 38, 0.28 * gain, 0.3, t + 0.01);
      burst(0.5 * gain, 0.75, 1300, 120, t + 0.04, 1.1);
    },

    /**
     * Weapon coming out. A short mechanical rustle, not a note.
     *
     * Pitched by weight: the sniper is the slowest, deepest clack, the knife the
     * lightest. This exists because a swap that only changes what is on screen reads as
     * a glitch — the sound is half of what makes it read as putting one thing away and
     * bringing another up.
     *
     * @param cockInMs when the off hand works the action, relative to now; 0 for a
     *   weapon with no action to work. Scheduled here rather than fired from a second
     *   call for the same reason `jam()` schedules its whole gesture at once: the
     *   animation places its stroke at a fraction of the swap, and two independent
     *   triggers would drift apart on exactly the frames that matter — a long deploy on
     *   a slow machine. One `draw()` owns the whole sequence, so it cannot.
     *
     * The stroke is two sounds, not one: brass and spring going back, then the bolt
     * slamming forward. A single click is a switch being flipped; the two-part sound is
     * what makes it a weapon being made ready, which is the entire complaint this
     * answers ("i dont see it cocking the gun so it still feel fast").
     */
    draw(weight = 1, cockInMs = 0) {
      if (!ensure()) return;
      const t = ctx.currentTime;
      const w = Math.max(0.4, Math.min(1.6, weight));
      burst(0.2, 0.07, 3600 / w, 800 / w, t, 2.2);
      tone('square', 260 / w, 150 / w, 0.05, 0.05, t + 0.02);
      if (cockInMs <= 0) return;
      const t0 = t + cockInMs / 1000;
      stroke(w, t0, t0 + 0.085 * w);
    },

    /**
     * Working the action between shots, on a weapon that has to be.
     *
     * The same stroke as a deploy's, and deliberately so — it is the same mechanism —
     * but stretched across the animation instead of snapped, because a bolt cycle takes
     * most of a second and the two beats are half of it apart. Hence both times as
     * arguments: `draw()`'s fixed 85·weight ms gap cannot express a 780ms stroke, and
     * fudging it would put the bolt home while the hand was still pulling it back.
     *
     * Quieter than the deploy's (0.8): this plays after every single shot, and a beat you
     * hear that often has to sit under the report rather than compete with it.
     */
    cycle(weight = 1, backInMs = 0, homeInMs = 0) {
      if (!ensure()) return;
      const t = ctx.currentTime;
      const w = Math.max(0.4, Math.min(1.6, weight));
      stroke(w, t + Math.max(0, backInMs) / 1000, t + Math.max(0, homeInMs) / 1000, 0.8);
    },

    hurt() {
      if (!ensure()) return;
      const t = ctx.currentTime;
      burst(0.55, 0.22, 900, 90, t, 2);
      tone('sine', 90, 40, 0.35, 0.2, t);
    },

    kill() {
      if (!ensure()) return;
      const t = ctx.currentTime;
      tone('triangle', 780, 780, 0.2, 0.07, t);
      tone('triangle', 1180, 1180, 0.2, 0.09, t + 0.075);
    },

    /**
     * A badge card appeared: a tick on an ordinary kill, a two-note lift on a level-up, a
     * three-note climb on a promotion.
     *
     * This plays UNDERNEATH kill(), which fires on the same event, so every branch is
     * deliberately small -- together they are one sound. Sine where kill() is triangle, so
     * the card reads as a second voice rather than as a longer version of the same fanfare,
     * and the ordinary tick is quiet enough to be felt more than heard: it happens on every
     * single kill, and anything louder would be the first thing a player turned off.
     *
     * THREE VOICES BECAUSE THE LADDER HAS FIFTY STEPS. A level-up happens forty-nine times
     * per track, far too often for the promotion fanfare and far too rarely to be the same
     * tick as every other kill -- if the two shared a sound, a player would have no way to
     * hear that they had climbed. So it gets the tick's pitch answered a fifth higher: the
     * ordinary sound plus one, which is what a level is.
     */
    badge(promoted = false, levelUp = false) {
      if (!ensure()) return;
      const t = ctx.currentTime;
      if (!promoted) {
        tone('sine', 1560, 1560, 0.075, 0.06, t);
        if (levelUp) tone('sine', 2340, 2340, 0.07, 0.1, t + 0.075);
        return;
      }
      // Offset past kill()'s two notes rather than laid over them, so a promotion is heard
      // as the thing that FOLLOWED the kill -- which is what it is.
      tone('sine', 880, 880, 0.11, 0.09, t + 0.02);
      tone('sine', 1170, 1170, 0.11, 0.09, t + 0.11);
      tone('sine', 1760, 1760, 0.13, 0.22, t + 0.2);
    },

    /**
     * A leg lit on the killmark: two notes a fifth apart, climbing a minor third per kill.
     *
     * SILENT ON ONE KILL, for the same reason SPREE_NAMES[0] is the empty string. A single
     * kill is the commonest event in the game and kill() already speaks for it; a chain
     * sound that fired on every kill would be indistinguishable from the kill sound, and
     * then there would be no sound that meant "chain". The mark says the same thing
     * visually — one leg, no word — so the two agree.
     *
     * LAID OVER kill(), NOT AFTER IT. The notes land at +30ms and +90ms, inside kill()'s
     * own decay, because a chained kill is not a kill plus an award: it is a bigger kill,
     * and the ear should hear one event. That is the opposite of badge()'s promotion, which
     * deliberately waits until kill() has finished — a promotion IS a separate thing that
     * happened to arrive on the same frame. Square against kill()'s triangle and badge()'s
     * sine keeps all three legible when a promotion and a leg land together.
     *
     * AND IT KEEPS SOUNDING AT SIX. legsOf caps the count, so a seventh chained kill plays
     * exactly what the sixth played — which is right, because at the cap the sound is the
     * only channel left: the star has no seventh leg to grow and the name does not change.
     * The extra shimmer at full is what makes that ceiling audible rather than just flat.
     */
    spree(n) {
      const legs = legsOf(n);
      if (legs < 2 || !ensure()) return;
      const t = ctx.currentTime;
      const root = SPREE_ROOT[legs];
      // Louder as it climbs, but only just: the pitch carries the count, and volume that
      // tracked it as steeply would have UNBELIEVABLE drowning out the gun that earned it.
      const gain = 0.05 + 0.006 * legs;
      tone('square', root, root, gain, 0.05, t + 0.03);
      tone('square', root * 1.5, root * 1.5, gain * 0.85, 0.08, t + 0.09);
      if (legs >= SPREE_LEGS) {
        // Full star. A third voice an octave up, held four times as long as the notes
        // under it, so the top of the ladder rings instead of just clicking higher.
        tone('sine', root * 2, root * 2, 0.07, 0.34, t + 0.16);
        tone('sine', root * 3, root * 3, 0.04, 0.28, t + 0.18);
      }
    },

    died() {
      if (!ensure()) return;
      const t = ctx.currentTime;
      burst(0.7, 0.5, 1600, 70, t, 1.4);
      tone('sawtooth', 220, 44, 0.3, 0.45, t);
    },

    /** @param gain 1 is a run. Scaled by the caller from actual speed, because the
     *         footstep accumulator makes a walk RARER and the volume is what makes it
     *         quieter — see the call site in main.js. */
    step(gain = 1) {
      if (!ensure()) return;
      burst(0.09 * gain, 0.045, 1500, 300, ctx.currentTime, 1);
    },
  };
}
