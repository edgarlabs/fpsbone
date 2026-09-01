// Keyboard, mouse look, pointer lock. Produces one sanitised intent object per
// simulation tick — never a position.

import * as C from '../../shared/constants.js';
import {
  RECOIL_HOLD_MS,
  RECOIL_RECOVER,
  hasHeavy,
  idAt,
  recoilMaxOf,
  recoilOf,
  recoilSideStep,
  scopes,
  slotPick,
  zoomStepCount,
} from '../../shared/weapons.js';
import { ACTION_IDS, ALIASES, twinOf } from './binds.js';

/** Mouse sensitivity at the settings slider's 1.00. The slider scales this. */
const BASE_SENS = 0.0022;

/** How long a burst survives a pause before the pattern starts over, in ms. Long
 *  enough that a rifle's own 130ms cadence never resets mid-spray, short enough that
 *  a deliberate tap is always the first shot of a fresh pattern. */
const BURST_GAP_MS = 340;

/**
 * Keys the browser owns outright, which is why Ctrl is NOT a default crouch bind.
 *
 * Ctrl+W closes the tab. Ctrl+S opens a save dialog. Ctrl+N, Ctrl+T, Ctrl+Shift+Q —
 * all handled by browser chrome above the page, where `preventDefault` has no reach.
 * A shooter binds crouch next to the movement keys, so "Ctrl for crouch" plus "W for
 * forward" is not an edge case in a browser, it is the single most common thing a
 * player will do, and it ends the match.
 *
 * There is exactly one legitimate escape: the Keyboard Lock API, which routes every
 * physical key to the page instead of to the browser. It requires fullscreen and is
 * Chromium-only, so it is requested opportunistically — when it is held, Ctrl becomes
 * a real crouch bind and the CS2 layout works properly; when it is not, C is the
 * crouch key and Ctrl is never read at all. Degrading is the point: no configuration
 * of this game should be able to close the tab you are playing in.
 *
 * Fullscreen is requested on the DOCUMENT, never on the canvas. A fullscreen element
 * is the only thing the browser renders — its siblings are painted over by the
 * backdrop — and `#hud` is a sibling of `#game`, not a child of it. Fullscreening the
 * canvas therefore took the entire HUD off screen the instant play started: no
 * crosshair, no scope, no hitmarker, no damage vignette and no death overlay, all of
 * which are DOM. Everything looked correctly implemented because it was; it simply
 * was not being drawn. Fullscreening the root keeps the whole page, canvas and
 * overlay together, and satisfies the keyboard grab just as well.
 */
async function grabKeyboard() {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.();
    await navigator.keyboard?.lock?.();
    return !!navigator.keyboard?.lock;
  } catch {
    return false;
  }
}

export function createInput(canvas, settings, hooks = {}) {
  const keys = new Set();
  let yaw = 0;
  let pitch = 0;
  let firing = false;
  /**
   * A press of the trigger that has not been sampled yet.
   *
   * `firing` is the button's CURRENT state, and sampling it alone quietly loses clicks:
   * sample() runs on the 16.7ms simulation step, so a click whose press and release both
   * land between two steps reads as false at both of them and never becomes a shot. On a
   * held firearm that does not matter, but quick taps on any attack still must not vanish
   * just because they landed between simulation samples.
   *
   * So a press is remembered until exactly one sample has carried it. That cannot fire
   * faster than the weapon allows — the server still owns `nextFireAt` — and it cannot
   * turn an edge-triggered knife swing or throw into a repeating action either, because
   * the latch lasts one sample and the tick after it reports the released button that
   * the server is waiting for.
   */
  let clickLatch = false;
  /** Right-click attacks must survive until the next fixed input sample just like a
   * fast left click does. This is separate from `alt`, which is the current held state:
   * a quick knife stab can be pressed and released between two 60Hz samples. */
  let altFireLatch = false;
  /** Right mouse held. What it MEANS is the weapon's business, not this module's. */
  let alt = false;
  /**
   * Which zoom step a scoped weapon is latched at: 0 unscoped, 1..N into the weapon's
   * own `zoomFovs`.
   *
   * A LATCH, not the button — this is the whole of "you have to hold cmon bruh it
   * should be like awp in cs2 where you can do double scope aswell just one clicking no
   * holding the right click". Right-click on a scoped weapon advances this and wraps
   * back to unscoped, so one click opens the first zoom, the next closes it down to the
   * second, and the third puts the scope away. Nothing has to stay held, which is the
   * point: the hand that was pinning the button down is the hand that has to aim.
   *
   * Weapons whose right-click is a lob or a heavy attack never touch this and keep the
   * held `alt` above — those two genuinely are held buttons.
   */
  let scopeStep = 0;
  /**
   * Shift is two verbs, decided by how long it is held. Tap it and sprint arms; hold it
   * and you walk quietly. The server never learns which happened: it sees BTN_WALK and
   * BTN_SPRINT, both level-triggered, exactly like every other movement modifier. The
   * discrimination is entirely here, in the same shape as `scopeStep` above.
   *
   * Sprint is a LATCH and not a held button, for the reason the user gave for the scope:
   * the hand pinning a key down is the hand that should be aiming. So it toggles, and
   * like the scope it has to be dropped from every edge that invalidates it rather than
   * releasing itself.
   *
   * BTN_WALK is emitted only AFTER the hold threshold, never on the press. Asserting it
   * immediately and retracting it on a tap looks tidier and is worse twice over: friction
   * is 0.85 a tick, so 3.73 u/s falls to 2.18 in four ticks and every sprint would open
   * with a third of a second of being SLOWER than a plain run; and a client that simply
   * omitted the bit during that window would get instant sprint, which builds an
   * advantage into cheating. Deferring costs a hold 150ms of quiet it will not miss over
   * seconds, and makes the honest and the dishonest client emit identical bits.
   */
  const TAP_MS = 150;
  let walkDownAt = 0;
  let sprintArmed = false;
  /** Does the weapon in hand have a stoppage? Mirrored from the server every snapshot,
   *  because both things this gates — the zoom and the mouse speed — have to agree with
   *  the hands the viewmodel is drawing, and the server owns those. */
  let jammed = false;
  /** Whether the body this input is driving is alive. A corpse looks where it fell: it
   *  may not turn, scope, or sprint — see setAlive and the mousemove handler. */
  let alive = true;
  let locked = false;
  let onLockChange = () => {};
  /** True only while the Keyboard Lock API is actually holding the keyboard. Gates
   *  the Ctrl crouch bind — see grabKeyboard above. */
  let kbLocked = false;

  let sens = BASE_SENS * settings.sens;
  /** Scope sensitivity as a fraction of the base — CS2's zoom_sensitivity_ratio. */
  let zoomSens = settings.zoomSens;
  /** action id → KeyboardEvent.code. Owned by settings; this module only reads it. */
  let binds = settings.binds;
  /** Every code any action answers to, for deciding what to swallow from the browser. */
  let bound = new Set();
  /** Weapon indices this mode allows, in slot order. Number keys index into it. */
  let loadout = [];
  let wep = 0;

  // ── recoil
  // The punch is kept apart from the aim rather than added into it, so recovery can
  // give the aim back exactly as it was. Mouse movement goes into `yaw`/`pitch`; the
  // punch rides on top and decays to nothing; the sum is what gets sent, which is why
  // the shot goes where the kicked crosshair is pointing and not where it used to be.
  let punchYaw = 0;
  let punchPitch = 0;
  /** Shots fired in the current burst, for the pattern's ramp. */
  let burst = 0;
  let lastShotAt = -Infinity;

  /** Rebuild the swallow set. Cheap, and only runs when the binds change, so the
   *  keydown handler stays a set lookup instead of a scan over eleven actions. */
  function indexBinds() {
    bound = new Set();
    for (const id of ACTION_IDS) {
      for (const code of codesFor(id)) bound.add(code);
    }
  }

  /** Every physical key that triggers `action`: its bind, that bind's other side if
   *  it is a sided key, and any fixed alias. */
  function codesFor(action) {
    const out = [];
    const code = binds[action];
    if (code) {
      out.push(code);
      const twin = twinOf(code);
      if (twin) out.push(twin);
    }
    for (const alias of ALIASES[action] ?? []) out.push(alias);
    return out;
  }

  /** Is `action` being held right now? */
  const down = (action) => codesFor(action).some((c) => keys.has(c));

  indexBinds();

  /** Are we looking down a scope right now? The LATCH decides, not the button — this
   *  is the single question the mouse asks, and the viewmodel and camera ask the same
   *  one of the same state, so a knife can never end up zoomed. */
  const scoping = () => scopeStep > 0 && scopes(idAt(wep));

  /**
   * Put the scope away.
   *
   * Called from every edge that invalidates a zoom rather than from one place, because
   * a latch has a failure mode a held button does not: the button releases itself when
   * your hand leaves the mouse, and a latch does not. Swap weapons while scoped and the
   * rifle you just drew would have inherited the sniper's zoom; die scoped and you
   * would respawn looking down a scope that is not there. Each of those is one call.
   */
  function unscope() {
    scopeStep = 0;
  }

  /**
   * Disarm sprint.
   *
   * The same list of edges unscope() is called from, and not one more. Pointer lock and
   * blur because `keys.clear()` there skips the keyup that would otherwise resolve the
   * hold; death because respawning into an automatic sprint is not something anybody
   * asked for; a rebind because walk may have just moved off Shift entirely.
   *
   * Deliberately NOT called on a weapon switch, setWeapon or setJammed. Sprint is not a
   * weapon state and has no interaction with a stoppage — you can shoot while sprinting,
   * stamina is the only limiter — so wiring one in later would be a change of design,
   * not a missing case.
   */
  function dropSprint() {
    sprintArmed = false;
    // 0 reads as "held since the epoch", so if a walk key somehow survives this it
    // resolves as a hold. That is the safe direction: quiet, not fast.
    walkDownAt = 0;
  }

  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    if (!locked) {
      // Don't keep walking or shooting after the cursor is released.
      keys.clear();
      firing = false;
      clickLatch = false;
      altFireLatch = false;
      alt = false;
      // Both latches, and neither drops itself: releasing the mouse does not release a
      // toggle, and keys.clear() above skips the keyup that would have resolved the hold.
      unscope();
      dropSprint();
    }
    onLockChange(locked);
  });

  // Leaving fullscreen releases the keyboard grab, with or without our involvement —
  // Esc does it. Ctrl has to stop being read at that exact moment, or the bind that
  // was safe a frame ago is closing the tab again.
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
      kbLocked = false;
      keys.delete('ControlLeft');
      keys.delete('ControlRight');
    }
  });

  document.addEventListener('mousemove', (e) => {
    if (!locked) return;
    // A CORPSE DOES NOT TURN ITS HEAD. "you can still move your camera when you die it
    // makes no sense you are dead" — and this handler was the last thing on a dead player
    // that still answered the mouse. main.js zeroes the fixed-step accumulator while dead,
    // so nothing is being simulated and no input is sent; the view was moving purely
    // because these three lines run off the mouse event and not off the simulation.
    //
    // Deliberately here and not in main.js's camera block. `yaw` and `pitch` are what a
    // respawn is aligned against (setView) and what the recoil punch is added to, so
    // freezing the VALUE keeps every reader of it consistent, where freezing only what the
    // camera reads would leave the view still and the aim quietly drifting behind it.
    //
    // The death drop still plays. main.js pitches and rolls the camera off these values
    // rather than into them, so the fall now animates over a fixed base — which is the
    // point of it.
    if (!alive) return;
    // A scope must slow the mouse by roughly the factor it narrows the view, or a
    // zoomed sniper is unaimable. Only a scope: this used to key off the button
    // alone, which made the mouse sluggish whenever you held right-click with a
    // knife — a weapon with nothing to aim. How much it slows is the player's
    // choice, since which factor feels right depends on the mouse under their hand.
    const s = sens * (scoping() ? zoomSens : 1);
    yaw -= e.movementX * s;
    pitch -= e.movementY * s;
    pitch = Math.max(-C.PITCH_LIMIT, Math.min(C.PITCH_LIMIT, pitch));
  });

  document.addEventListener('mousedown', (e) => {
    if (!locked) return;
    if (e.button === 0) {
      firing = true;
      // Remember the press so a click too short to be caught by a sample still fires.
      clickLatch = true;
      hooks.onAttack?.(wep, alt, performance.now());
    }
    if (e.button === 2) {
      // The raw button stays for the verbs that really are held — a lobbed grenade
      // and the knife's heavy stab both want to know the button is DOWN, and both are
      // read off BTN_ALT on the server.
      alt = true;
      // In every conventional FPS, right-clicking a knife IS the heavy attack. It is
      // not a modifier the player must hold while also pressing left-click.
      if (alive && !jammed && hasHeavy(idAt(wep))) {
        clickLatch = true;
        altFireLatch = true;
        hooks.onAttack?.(wep, true, performance.now());
      }
      // A scope is the exception, and this is the whole of it: the DOWN EDGE advances a
      // latch instead of the button being sampled. unscoped → first zoom → second zoom
      // → unscoped, so the same click that opens the scope eventually closes it and
      // nothing has to stay pressed. Modulo (steps + 1) because unscoped is a step too.
      //
      // Gated on `alive` for the same reason the trigger is: a corpse may still turn its
      // head, but scoping through the death cam is not a thing a dead player does.
      //
      // And on `jammed`, because the off hand is off the fore-end and up on the receiver
      // for the length of a stoppage. Refusing the click matters as much as dropping the
      // latch does: without it, one right-click during the 1.4 seconds puts the eye back
      // in a scope that hides the viewmodel outright, and the punch you are waiting to
      // see plays behind an opaque overlay.
      if (alive && !jammed && scopes(idAt(wep))) {
        scopeStep = (scopeStep + 1) % (zoomStepCount(idAt(wep)) + 1);
      }
    }
  });
  document.addEventListener('mouseup', (e) => {
    if (e.button === 0) firing = false;
    if (e.button === 2) alt = false;
  });
  // Right-click is a game button, so it must not also open the context menu.
  document.addEventListener('contextmenu', (e) => {
    if (locked) e.preventDefault();
  });

  document.addEventListener(
    'wheel',
    (e) => {
      if (!locked || !loadout.length) return;
      e.preventDefault();
      const at = Math.max(0, loadout.indexOf(wep));
      const next = (at + (e.deltaY > 0 ? 1 : loadout.length - 1)) % loadout.length;
      wep = loadout[next];
      // A zoom belongs to the weapon that owns the scope, not to the player.
      unscope();
    },
    { passive: false },
  );

  window.addEventListener('keydown', (e) => {
    // A key arriving with a browser modifier held is not a game bind — it is half of
    // a shortcut the browser is about to act on. Registering it anyway is how Ctrl+S
    // used to walk you backwards into the open while a save dialog stole the focus.
    // Under keyboard lock there is no browser shortcut to be half of, so Ctrl+key is
    // ours and this guard lifts.
    if ((e.ctrlKey || e.metaKey || e.altKey) && !kbLocked) return;
    // Space scrolls the page and Tab moves focus even before pointer lock, so those
    // two are always swallowed; the rest of the bind list only once we own the mouse,
    // which leaves the menu's own keyboard navigation alone.
    if (e.code === 'Space' || e.code === 'Tab' || (locked && bound.has(e.code))) {
      e.preventDefault();
    }
    if (keys.has(e.code)) return; // ignore auto-repeat
    // Sampled either side of the mutation, because the question is whether the ACTION
    // changed, not whether this key did: Shift is a sided key and down() ORs over both
    // halves, so pressing the second one is not a new press of walk.
    const walkWas = down('walk');
    keys.add(e.code);
    if (!walkWas && down('walk')) walkDownAt = performance.now();

    if (!locked) return;
    // Weapon slots, CS2 layout: 1 primary, 2 secondary, 3 knife, 4 thrown. Selection
    // goes through the weapon's own `slot` rather than through its position in the
    // mode's loadout, so 3 is the knife in every mode and with every loadout.
    // Pressing an occupied slot again cycles within it.
    if (e.code.startsWith('Digit')) {
      const pick = slotPick(loadout, Number(e.code.slice(5)), wep);
      if (pick >= 0 && pick !== wep) {
        wep = pick;
        unscope();
      }
    }
  });
  window.addEventListener('keyup', (e) => {
    const walkWas = down('walk');
    keys.delete(e.code);
    // A release that came fast enough to be a tap toggles sprint. A slower one was a
    // walk, and has already been emitting BTN_WALK for a while — it must not also arm.
    if (walkWas && !down('walk') && performance.now() - walkDownAt < TAP_MS) {
      sprintArmed = !sprintArmed;
    }
  });
  // A modifier going down can swallow the keyup for anything already held (the
  // browser takes focus mid-combo), which would leave a key stuck on forever.
  window.addEventListener('blur', () => {
    keys.clear();
    firing = false;
    clickLatch = false;
    altFireLatch = false;
    alt = false;
    unscope();
    dropSprint();
  });

  const held = (...codes) => codes.some((c) => keys.has(c));

  return {
    get locked() {
      return locked;
    },
    /** Is sprint toggled on? The HUD reads this to say "armed" while the bar is still
     *  below a quarter — the lockout releases with no keypress, so without a readout a
     *  player has no way to know why the speed came back on its own. */
    get sprintArmed() {
      return sprintArmed;
    },
    get scoreboard() {
      return down('scores');
    },
    /** Right mouse, raw. The viewmodel needs it for weapons whose alt is not a
     *  scope — a lobbed grenade changes the pose without changing the camera. */
    get alt() {
      return alt;
    },
    /** Are we looking down glass? What the camera zoom, the scope overlay and the mouse
     *  gain all read. False for every weapon without a scope no matter what the mouse is
     *  doing. The STEP behind it now travels — see `sc` in `sample` — so this is a local
     *  view of shared simulation state rather than the only copy of it. */
    get scoping() {
      return scoping();
    },
    /**
     * Which zoom step the scope is latched at: 0 unscoped, 1 first zoom, 2 second.
     *
     * The viewmodel needs the STEP and not just the boolean, because a double scope has
     * two different fields of view and "am I scoped" cannot tell them apart. Reads 0 for
     * any weapon without a scope, so a caller never has to check first.
     */
    get scopeStep() {
      return scopes(idAt(wep)) ? scopeStep : 0;
    },
    get weapon() {
      return wep;
    },
    /** Inspect held. Inspect loops for as long as this is true rather than firing
     *  once — holding a key and having the animation quit under you is the bug. */
    get inspectHeld() {
      return down('inspect');
    },
    /** Whether Ctrl is a usable crouch bind right now. The menu reads it to show
     *  the truth about the controls instead of a bind that silently does nothing. */
    get keyboardLocked() {
      return kbLocked;
    },
    /** How far the aim is currently kicked, in radians. The crosshair opens up by
     *  this much — an honest readout, since it is the same offset the shot uses. */
    get punchAmount() {
      return Math.hypot(punchYaw, punchPitch);
    },

    /**
     * Where you are looking RIGHT NOW, including recoil — the live angles, not the ones
     * the last simulation tick happened to catch.
     *
     * This exists so the camera can be drawn from the mouse instead of from the
     * prediction. `sample()` is the wire's view of the aim and runs on the 16.7ms tick;
     * the mouse does not. Drawing the camera from the tick meant a frame could show aim
     * that was up to a full tick stale, and — worse — that on a monitor faster than 60Hz
     * the view could only change 60 times a second however fast you moved the mouse,
     * because the value it was reading only changed that often. Mouse motion arriving
     * between two ticks simply did not exist until the next one.
     *
     * The angles themselves are identical to what `sample()` sends: `stepPlayer` assigns
     * `s.yaw = input.yaw` unchanged, so this is the same number a tick earlier rather
     * than a second, competing opinion about where you are aiming. The server stays
     * authoritative over everything that is actually a simulation — position, collision,
     * whether a shot connected — and none of that is what a mouse moves.
     *
     * Pitch is clamped exactly as `sample()` clamps it, so the top of the view is in the
     * same place on the frame it is drawn as on the tick it is sent.
     */
    get lookYaw() {
      return yaw + punchYaw;
    },
    get lookPitch() {
      return Math.max(-C.PITCH_LIMIT, Math.min(C.PITCH_LIMIT, pitch + punchPitch));
    },

    /**
     * A shot of ours landed. Kicks the aim.
     *
     * Called from the SHOT event rather than from the mouse: the server decides
     * whether a click became a bullet (ammunition, cadence, a swap still in progress),
     * and only a bullet may move the aim. Clicking an empty magazine used to be the
     * kind of thing that would punch the view in a naive implementation.
     *
     * @param idx weapon index, as carried on the wire.
     */
    punch(idx) {
      const r = recoilOf(idAt(idx));
      if (!r) return;
      const now = performance.now();
      // A pause resets the pattern, which is what makes tapping a real technique
      // rather than a slower spray.
      burst = now - lastShotAt > BURST_GAP_MS ? 0 : burst + 1;
      lastShotAt = now;

      const t = Math.min(1, burst / r.ramp);
      // Vertical eases off as the burst goes on while the shared authored side pattern
      // moves immediately from the first round. The tiny random term keeps two sprays
      // from drawing the exact same pixels; it is only 12% of `side`, so the fixed
      // sequence remains the thing a player learns and counters.
      punchPitch += r.up * (1 - 0.35 * t);
      punchYaw += recoilSideStep(idAt(idx), burst) + r.side * (Math.random() - 0.5) * 0.12;

      // The ceiling. Without it the pattern climbs for as long as the magazine lasts
      // and a hundred-round belt ends up pointed at the sky; with it, a spray reaches
      // the top of its pattern and stays there, which is the thing you learn to pull
      // down through. Clamped as a vector rather than per axis so the cap is the same
      // total offset however the wander happens to have split it.
      const max = recoilMaxOf(idAt(idx));
      const mag = Math.hypot(punchYaw, punchPitch);
      if (mag > max) {
        const k = max / mag;
        punchYaw *= k;
        punchPitch *= k;
      }
    },

    onLockChange(fn) {
      onLockChange = fn;
    },
    async lock() {
      // Fullscreen and the keyboard grab come first: both need a user gesture, and
      // this is called from the Play click. Pointer lock last, so a rejected
      // fullscreen request still leaves a playable mouse.
      kbLocked = await grabKeyboard();
      canvas.requestPointerLock?.();
    },
    /** Release every browser-level capture before returning to lobby or results. */
    release() {
      try { document.exitPointerLock?.(); } catch { /* already released */ }
      try { navigator.keyboard?.unlock?.()?.catch?.(() => {}); } catch { /* unsupported */ }
      try { document.exitFullscreen?.()?.catch?.(() => {}); } catch { /* already windowed */ }
    },
    setSens(mult) {
      sens = BASE_SENS * mult;
    },
    setZoomSens(mult) {
      zoomSens = mult;
    },
    /** Adopt a new bind map. Held keys are cleared: a key that was forward a moment
     *  ago and is now unbound would otherwise stay pressed with nothing to release
     *  it, and you would walk into the wall until you happened to tap it again. */
    setBinds(map) {
      binds = map;
      indexBinds();
      keys.clear();
      dropSprint();
    },
    /** @param indices weapon indices the mode allows, in slot order. */
    setLoadout(indices) {
      loadout = indices;
      if (!loadout.includes(wep)) wep = loadout[0] ?? 0;
      unscope();
    },
    setWeapon(idx) {
      if (loadout.includes(idx) && idx !== wep) {
        wep = idx;
        unscope();
      }
    },
    /**
     * Tell the input whether the body it drives is alive.
     *
     * This is the whole of "when you die you can still scope like bruh". Death used to
     * be invisible to this module: the scope was the right mouse button, the button
     * still worked with the death cam up, so a corpse could zoom. Dropping the latch on
     * the falling edge closes the scope the instant you die, and refusing to advance it
     * while dead keeps it closed — so a spectating player has the plain death cam and
     * respawns unscoped, whatever they were doing when they got shot.
     */
    setAlive(v) {
      const was = alive;
      alive = !!v;
      if (was && !alive) {
        unscope();
        dropSprint();
      }
    },
    /**
     * Tell the input whether the weapon in hand is jammed.
     *
     * A stoppage is one of the edges unscope() exists for, and the one that was missed.
     * A scoped weapon is hidden outright while the FOV is narrowed — it has to be, or the
     * magnified receiver covers the middle of the screen — so a sniper that jammed while
     * scoped showed nothing at all: no gun, no hands, no punch, just 1.4 seconds of dead
     * trigger behind the glass. That is the "i dont know whats going on" the clearing
     * animation was rewritten for, in the one state where the animation was not drawn.
     *
     * Dropping the latch also keeps the mouse honest. `scoping()` is what scales the
     * sensitivity, so leaving it set while the viewmodel had relaxed the zoom would give
     * a player zoom sensitivity at their own field of view.
     *
     * Fed from the authoritative countdown every snapshot, like setAlive: a jam is rolled
     * on the server and the client is never told to expect one.
     */
    setJammed(v) {
      const was = jammed;
      jammed = !!v;
      if (!was && jammed) unscope();
    },
    /** Align the view with an authoritative yaw (used on spawn/respawn). */
    setView(y, p = 0) {
      yaw = y;
      pitch = p;
      // A new life starts unscoped as well as level — see setAlive.
      unscope();
      // A new life starts with a level aim. Recoil does not decay while dead — nothing
      // is being simulated — so without this you would respawn still looking wherever
      // the last burst had pushed you.
      punchYaw = 0;
      punchPitch = 0;
      burst = 0;
      lastShotAt = -Infinity;
    },

    /**
     * @param vt when this client's screen is, on the server's clock — `net.viewMs()`.
     *        Passed in rather than read here because this module owns the hands and the
     *        mouse and knows nothing about a socket. 0 disables lag compensation for the
     *        shot, which is the correct default for anything with no snapshot yet.
     */
    sample(vt = 0) {
      let moveX = 0;
      let moveZ = 0;
      if (down('forward')) moveZ += 1;
      if (down('back')) moveZ -= 1;
      if (down('right')) moveX += 1;
      if (down('left')) moveX -= 1;

      let buttons = 0;
      if (down('jump')) buttons |= C.BTN_JUMP;
      // The button as it is now, OR a press since the last sample that nothing has
      // carried yet. Consumed here so it rides exactly one input: the sample after this
      // one sees a released trigger, which edge-triggered melee and throwables need.
      if (firing || clickLatch) buttons |= C.BTN_FIRE;
      clickLatch = false;
      if (alt || altFireLatch) buttons |= C.BTN_ALT;
      altFireLatch = false;
      if (down('reload')) buttons |= C.BTN_RELOAD;
      if (down('use')) buttons |= C.BTN_USE;
      // C is the default crouch key. Ctrl crouches too, but ONLY while the Keyboard
      // Lock API is holding the keyboard — without it, Ctrl+W closes the tab and
      // Ctrl+S opens a save dialog, and no amount of preventDefault takes either
      // back. So the CS2 bind exists where it can work and is absent where it would
      // end the match, rather than being offered everywhere and breaking most places.
      // The settings panel refuses Ctrl as a bind for the same reason.
      if (down('crouch') || (kbLocked && held('ControlLeft', 'ControlRight'))) {
        buttons |= C.BTN_CROUCH;
      }
      // Walk only once the hold has actually lasted — see TAP_MS. Sprint is the latch.
      // Both bits can be set at once and that is fine: sprintOk() in shared/movement.js
      // refuses outright when BTN_WALK is present, so holding Shift with sprint still
      // armed walks. Walk and crouch always win.
      if (down('walk') && performance.now() - walkDownAt >= TAP_MS) buttons |= C.BTN_WALK;
      if (sprintArmed) buttons |= C.BTN_SPRINT;

      // Recoil recovery, on the simulation tick rather than the frame: this is part of
      // the aim that goes on the wire, and everything on the wire runs off one clock.
      //
      // Held off for RECOIL_HOLD_MS after each shot, and that hold is the whole reason
      // recoil is now something you can feel. Recovery used to run every tick, so a
      // rifle's 0.032 rad kick had already given back 40% of itself before the next
      // round arrived 130ms later: the punch converged at about 0.05 rad and a full
      // magazine climbed three degrees, which is indistinguishable from nothing. Now the
      // kicks stack while the trigger is down, up to the weapon's `max`, and the whole
      // pattern comes back the moment you stop shooting.
      if (performance.now() - lastShotAt >= RECOIL_HOLD_MS) {
        const decay = Math.exp(-RECOIL_RECOVER * C.TICK_DT);
        punchYaw *= decay;
        punchPitch *= decay;
      }

      // The punched aim IS the aim. Clamped exactly as sanitizeInput clamps it on the
      // far side, so the prediction and the server agree about where a kick that has
      // driven the view into the ceiling actually points.
      const pitchOut = Math.max(-C.PITCH_LIMIT, Math.min(C.PITCH_LIMIT, pitch + punchPitch));
      // `sc` is the scope, and it now GOES ON THE WIRE. It used to be a purely local
      // latch that never left the browser, which meant the
      // server, the thing that decides whether a bullet hit, could not know whether the
      // player was looking through glass. So the scope had no consequences it could not
      // have had without existing: no cost to hipfiring, no reward for having settled, no
      // slowdown while zoomed. See `scope` in shared/movement.js.
      //
      // A LEVEL and not the toggle that produced it, because `sanitizeInput` clamps a
      // level and a dropped edge is unrecoverable: a lost "scope up" would leave the two
      // sides disagreeing forever with nothing on either side able to notice. Narrowed
      // through `scopes()` here as well as on the far side, so a step left over from a
      // sniper cannot ride out on the input that swapped to a rifle.
      const sc = scopes(idAt(wep)) ? scopeStep : 0;
      return { moveX, moveZ, yaw: yaw + punchYaw, pitch: pitchOut, buttons, wep, vt, sc };
    },
  };
}
