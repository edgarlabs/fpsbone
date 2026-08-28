// Player preferences, persisted locally. Deliberately shaped like identity.js:
// one getter, try/catch around storage so private browsing degrades to a
// per-session value instead of throwing, and query-param overrides for testing.
//
// Nothing here is authoritative. `mode` and `wep` are requests the server may
// refuse (an unimplemented mode, a weapon outside the mode's loadout); everything
// else never leaves the browser at all.

import { MODE_IDS, DEFAULT_MODE } from '../../shared/modes.js';
import { WEAPON_IDS } from '../../shared/weapons.js';
import { HERE, isRegion, publicOrigin } from '../../shared/regions.js';
import { DEFAULT_BINDS, normalizeBinds } from './binds.js';

const KEY = 'fpsbone.settings';

/**
 * Crosshair colour presets, in the order the settings panel shows them.
 *
 * Named presets rather than a colour picker for the same reason CS2 uses them: the
 * useful answers are few, and a hue wheel on a flat-shaded grey map mostly produces
 * crosshairs you cannot see.
 */
export const CH_COLORS = [
  { id: 'green', hex: '#3cff8a' },
  { id: 'cyan', hex: '#4fe8ff' },
  { id: 'yellow', hex: '#ffe24f' },
  { id: 'red', hex: '#ff5a5a' },
  { id: 'white', hex: '#ffffff' },
];

const DEFAULTS = {
  mode: DEFAULT_MODE,
  wep: 'rifle',
  hand: 'right',

  /**
   * Which server, and its address — two fields for one choice, and the second one is what
   * makes the first usable.
   *
   * The id alone cannot be dialled: a region's hostname comes from the server at runtime
   * (see shared/regions.js), so a returning player who picked ASIA would have to wait for a
   * /regions round trip before their socket could open — a stall on every single load, to
   * re-learn something they already chose. Storing the address alongside it means the
   * connection starts immediately and the region table, when it arrives, only has to correct
   * an address that moved.
   *
   * HERE is the default and means "whoever served this page", which is right for a checkout,
   * right for a single-region deploy, and the only answer that needs no configuration at all.
   */
  region: HERE,
  regionHost: '',

  sens: 1,
  fov: 85,

  // WHO YOU FIGHT IS NOT A SETTING. There were `vsAi` and `bots` fields here, and a
  // chip and a slider in the menu behind them. Every lobby now has a fixed number of
  // slots and the server fills whatever the humans leave empty, so the answer is a fact
  // about the room you picked rather than a preference you carry into it — a stored
  // `bots: 4` would only be a number the server ignores. `mode` below is the whole of
  // the choice.

  // Scope sensitivity as a multiplier of the base, i.e. CS2's zoom_sensitivity_ratio.
  // 0.65 is what the scope multiplied by when it was hardcoded in input.js.
  zoomSens: 0.65,
  // Viewmodel FOV, the other half of CS2's viewmodel controls. Matches VM_FOV in
  // render.js, which is now the value this overrides rather than the value in force.
  vmFov: 50,
  vol: 0.45,

  chLen: 9,
  chGap: 4,
  chThick: 2,
  chDot: false,
  chOutline: true,
  chCol: 'green',

  binds: DEFAULT_BINDS,
};

/** Keys that survive a reload. `binds` is an object, so it is written whole. */
const PERSIST = Object.keys(DEFAULTS);
/** Only scalars are worth overriding from a test link. */
const FROM_QS = PERSIST.filter((k) => k !== 'binds');

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const bool = (v) => v === true || v === 'true' || v === 1 || v === '1';

/** A stored region address, or ''. Only a bare http(s) origin survives: the scheme is swapped
 *  for ws(s) and endpoints are appended, so a path would 404 them and any other scheme would
 *  reach `new WebSocket` as something nobody meant to dial.
 *
 *  Run through `publicOrigin` on the way out, which repairs the one address a card could have
 *  stored that no browser can dial: a peer host with no domain on it, injected by a blueprint
 *  before shared/regions.js knew to complete it. Repaired on READ because it is already in
 *  people's storage — a returning player would otherwise dial `wss://fpsbone-sea` forever and
 *  sit on "connecting…" with no way to tell that the region they picked is fine. */
function httpOrigin(v) {
  if (typeof v !== 'string' || !v) return '';
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.pathname === '/'
      ? publicOrigin(u.href)
      : '';
  } catch {
    return '';
  }
}

/** Validated on read, not on write. Storage is shared with whatever the previous
 *  version of this file wrote, so a stale or hand-edited value has to be
 *  survivable rather than merely unlikely. */
function coerce(raw) {
  const s = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const int = (v, d, lo, hi) => Math.round(clamp(n(v, d), lo, hi));
  return {
    mode: MODE_IDS.includes(s.mode) ? s.mode : DEFAULTS.mode,
    wep: WEAPON_IDS.includes(s.wep) ? s.wep : DEFAULTS.wep,
    hand: s.hand === 'left' ? 'left' : 'right',

    // A region id from an older build, a hand-typed `?region=`, or a table that no longer
    // lists it all arrive here the same way, and all fall back to the page's own server —
    // the one address that cannot be stale.
    region: isRegion(s.region) ? s.region : DEFAULTS.region,
    // Kept only if it still parses as a bare http(s) origin. A stored path or a `javascript:`
    // would be turned into a socket url and handed to `new WebSocket`, so this is validated
    // where it is read rather than trusted because we wrote it.
    regionHost: httpOrigin(s.regionHost),

    sens: clamp(n(s.sens, DEFAULTS.sens), 0.3, 3),
    fov: int(s.fov, DEFAULTS.fov, 70, 110),

    zoomSens: clamp(n(s.zoomSens, DEFAULTS.zoomSens), 0.2, 1.5),
    vmFov: int(s.vmFov, DEFAULTS.vmFov, 40, 75),
    vol: clamp(n(s.vol, DEFAULTS.vol), 0, 1),

    chLen: int(s.chLen, DEFAULTS.chLen, 0, 24),
    chGap: int(s.chGap, DEFAULTS.chGap, 0, 16),
    chThick: int(s.chThick, DEFAULTS.chThick, 1, 6),
    chDot: bool(s.chDot),
    chOutline: bool(s.chOutline),
    chCol: CH_COLORS.some((c) => c.id === s.chCol) ? s.chCol : DEFAULTS.chCol,

    // Bind validation lives in binds.js beside the table it validates against —
    // see `normalizeBinds` for what it does with a missing, illegal or duplicated key.
    binds: normalizeBinds(s.binds),
  };
}

export function getSettings() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    // corrupt entry — fall through to defaults
  }

  // Query params override storage and are then persisted like any other change,
  // the same way identity.js treats ?name. A test link is a real preference.
  const qs = new URLSearchParams(location.search);
  const fromQs = {};
  for (const k of FROM_QS) {
    const v = qs.get(k);
    if (v !== null) fromQs[k] = v;
  }

  const settings = {
    ...coerce({ ...saved, ...fromQs }),

    /** The chosen crosshair colour as a hex string, for whoever has to draw it. */
    get chHex() {
      return (CH_COLORS.find((c) => c.id === this.chCol) ?? CH_COLORS[0]).hex;
    },

    /** Merge a change and write it through. */
    set(patch) {
      Object.assign(this, coerce({ ...this, ...patch }));
      try {
        const out = {};
        for (const k of PERSIST) out[k] = this[k];
        localStorage.setItem(KEY, JSON.stringify(out));
      } catch {
        // private browsing / storage disabled — in-memory settings are fine
      }
      return this;
    },

    /** Restore one panel's worth of defaults. Per-group rather than all-or-nothing,
     *  so resetting a crosshair you have ruined does not also throw away your binds. */
    reset(keys) {
      const patch = {};
      for (const k of keys) patch[k] = DEFAULTS[k];
      return this.set(patch);
    },
  };

  return settings.set({});
}
