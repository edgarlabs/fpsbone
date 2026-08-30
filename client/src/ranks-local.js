// The career store, browser edition: how many kills this account has ever scored, kept
// across matches in localStorage instead of in ranks.json.
//
// This is the browser counterpart of server/ranks.js and deliberately mirrors it function
// for function — `careerOf`, `badgesOf`, `setCareer` — because server/index.js takes the
// store as an injection and must not need a branch for which one it got. Read that file's
// header for why the store is quarantined behind that injection at all: a Room must never
// be able to reach persistence, or `npm run verify` would rewrite a player's career as a
// side effect of running the suite.
//
// WHAT IS DIFFERENT, and it is worth being plain about it: this store is per-browser and
// per-origin. There is no shared ledger, because in the static build there is no server to
// keep one — the host runs inside the page. A career here is a record of what you did on
// this machine, in this browser. Clearing site data clears it, and it does not follow you
// to another device. The Node store is the one that is shared, and it is shared only among
// the clients connected to that one process.
//
// The two legal record shapes are kept as well, for the same reason ranks.js keeps them:
// `93` is the original schema, a career and nothing else, and `{"k":93,"b":{"hs":12}}` is
// the same career plus per-badge counts. Both parse; only the second is written.

import { TRACK_KEYS } from '../../shared/badges.js';
import {
  DEFAULT_FINISH, FINISHES, sanitizeInventory, sanitizeOwnedCosmetics,
} from '../../shared/cosmetics.js';
import { XP_PER_LEGACY_KILL, cleanStats } from '../../shared/progression.js';

const KEY = 'fpsbone.careers.v1';

/** Bounded, exactly as the Node store is. The keys come from identity.js rather than from
 *  a network, so nobody else can grow this one — but a cap that exists on one side of an
 *  injected seam and not the other is a difference waiting to surprise someone. Insertion
 *  order in a Map is the LRU order for free, so eviction is the first key. */
const MAX_ACCOUNTS = 5000;
const MAX_HISTORY = 20;
const freshRecord = () => ({
  k: 0, b: {}, x: 0, s: cleanStats(), h: [], i: sanitizeInventory(), e: DEFAULT_FINISH,
});

/** accountId -> `{ k: career kills, b: { track: count } }`. */
const store = new Map();

/**
 * Read one stored entry into a record, or null for something unusable.
 *
 * A bare number reads as a career with no badges, which is exactly what it means: those
 * kills were scored before badges existed, and there is no honest way to attribute them to
 * a weapon after the fact.
 *
 * Badge keys are WHITELISTED against TRACK_KEYS, because what comes back out of
 * localStorage is whatever was last written there — including by a hand-edited devtools
 * session. Filtering on the way in means a mangled store cannot grow a key set that then
 * gets written back out and read in again forever.
 */
function readRecord(v) {
  if (Number.isFinite(v) && v >= 0) {
    const k = Math.floor(v);
    return { ...freshRecord(), k, x: k * XP_PER_LEGACY_KILL };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (!(Number.isFinite(v.k) && v.k >= 0)) return null;
  const b = {};
  if (v.b && typeof v.b === 'object') {
    for (const key of TRACK_KEYS) {
      const n = v.b[key];
      if (Number.isFinite(n) && n > 0) b[key] = Math.floor(n);
    }
  }
  const k = Math.floor(v.k);
  const x = Number.isFinite(v.x) && v.x >= 0 ? Math.floor(v.x) : k * XP_PER_LEGACY_KILL;
  const h = Array.isArray(v.h) ? v.h.filter((entry) => entry && typeof entry === 'object').slice(-MAX_HISTORY) : [];
  const i = sanitizeInventory(v.i);
  const e = sanitizeOwnedCosmetics({ finish: v.e }, i).finish ?? DEFAULT_FINISH;
  return { k, b, x, s: cleanStats(v.s), h, i, e };
}

let dirty = false;
let timer = null;

// The same debounce the Node store uses, for the same reason: localStorage is synchronous,
// the host drives its simulation from a setTimeout loop at <=4ms, and that loop already has
// a branch for falling behind that drops its whole backlog. A write on every kill is exactly
// the kind of stall that gets it there. Debounced, off the hot path, and flushed for real
// when the page goes away.
const WRITE_DELAY_MS = 8000;

// A private window, a browser with site data blocked, or a full quota all throw here rather
// than returning null. None of them is a reason to fail to boot: an unreadable store yields
// an empty one and a running game, which loses careers, where throwing would lose the game.
try {
  const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  if (parsed && typeof parsed === 'object') {
    for (const [k, v] of Object.entries(parsed)) {
      const rec = typeof k === 'string' ? readRecord(v) : null;
      if (rec) store.set(k, rec);
    }
  }
} catch {
  // Nothing to say about it. The game runs; this session's kills just will not persist.
}

/** Move a key to the young end, and drop the oldest if the cap is exceeded. */
function touch(id) {
  if (store.has(id)) {
    const v = store.get(id);
    store.delete(id);
    store.set(id, v);
    return;
  }
  while (store.size >= MAX_ACCOUNTS) store.delete(store.keys().next().value);
}

/** Write the store out. Always the new shape, which is what migrates a legacy entry; `b`
 *  is omitted while empty rather than written as `{}`. */
export function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!dirty) return;
  dirty = false;
  try {
    const out = {};
    for (const [id, r] of store) {
      const row = { k: r.k };
      const hasStats = Object.values(r.s).some((n) => n > 0);
      if (r.x !== r.k * XP_PER_LEGACY_KILL && (hasStats || r.h.length)) row.x = r.x;
      if (hasStats) row.s = r.s;
      if (Object.keys(r.b).length) row.b = r.b;
      if (r.h.length) row.h = r.h;
      const grants = sanitizeInventory(r.i).filter((finish) => !FINISHES[finish].issued);
      if (grants.length) row.i = grants;
      if (r.e && r.e !== DEFAULT_FINISH) row.e = r.e;
      out[id] = row;
    }
    localStorage.setItem(KEY, JSON.stringify(out));
  } catch {
    // Quota, or a browser refusing storage. Careers stop persisting; play continues.
  }
}

function schedule() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(flush, WRITE_DELAY_MS);
}

/** Move an old unsigned browser career under the signed device id exactly once. */
export function claimLegacy(from, to) {
  if (!from || !to || from === to || store.has(to) || !store.has(from)) return false;
  const rec = store.get(from);
  store.delete(from);
  store.set(to, rec);
  schedule();
  return true;
}

/** A career for an account, or 0 for an anonymous client. Reading counts as use, so a
 *  returning player who has not scored yet does not age out of a full store. */
export function careerOf(id) {
  if (!id) return 0;
  touch(id);
  return store.get(id)?.k ?? 0;
}

/**
 * An account's badge counts, or an empty object for an anonymous client.
 *
 * A COPY, deliberately — the same contract server/ranks.js documents. The caller hands this
 * straight to a Room player that will increment it on every kill, and a Room mutating the
 * store in place would put counts in storage that setCareer's monotonic guard never saw.
 */
export function badgesOf(id) {
  if (!id) return {};
  touch(id);
  return { ...(store.get(id)?.b ?? {}) };
}

export function profileOf(id) {
  if (!id) return {
    xp: 0, career: 0, badges: {}, stats: cleanStats(), history: [],
    inventory: sanitizeInventory(), equipped: {},
  };
  touch(id);
  const rec = store.get(id);
  const inventory = sanitizeInventory(rec?.i);
  return {
    xp: rec?.x ?? 0,
    career: rec?.k ?? 0,
    badges: { ...(rec?.b ?? {}) },
    stats: cleanStats(rec?.s),
    history: [...(rec?.h ?? [])],
    inventory,
    equipped: sanitizeOwnedCosmetics({ finish: rec?.e }, inventory),
  };
}

export function authorizeCosmetics(id, raw) {
  const profile = profileOf(id);
  const requested = typeof raw?.finish === 'string' ? raw.finish : null;
  const finish = requested && profile.inventory.includes(requested)
    ? requested
    : (profile.equipped.finish ?? DEFAULT_FINISH);
  const rec = store.get(id) ?? freshRecord();
  rec.i = sanitizeInventory(profile.inventory);
  rec.e = finish;
  store.set(id, rec);
  schedule();
  return { profile: profileOf(id), cosmetics: sanitizeOwnedCosmetics({ finish }, rec.i) };
}

/** Record a career total. Called from the Room's `onCareer` hook, which only fires for a
 *  player that has an account — bots and anonymous clients never reach here. */
export function setCareer(id, kills, badges) {
  if (!id || !Number.isFinite(kills)) return;
  touch(id);
  const rec = store.get(id) ?? freshRecord();
  rec.k = Math.max(rec.k, Math.floor(kills));
  // Per key, and monotonic per key for the same reason the kill count is: this arrives from
  // a Room, and a Room that was handed a stale badge map — a second tab on the same
  // account, a reconnect that raced a flush — must not be able to walk a count backwards.
  if (badges && typeof badges === 'object') {
    for (const key of TRACK_KEYS) {
      const n = badges[key];
      if (Number.isFinite(n) && n > 0) rec.b[key] = Math.max(rec.b[key] ?? 0, Math.floor(n));
    }
  }
  store.set(id, rec);
  schedule();
}

export function settleMatch(id, value = {}) {
  if (!id) return;
  touch(id);
  const rec = store.get(id) ?? freshRecord();
  rec.k = Math.max(rec.k, Math.floor(Number(value.career) || 0));
  rec.x = Math.max(rec.x, Math.floor(Number(value.xp) || 0));
  rec.s = cleanStats(value.stats);
  if (value.badges && typeof value.badges === 'object') {
    for (const key of TRACK_KEYS) {
      const n = Math.floor(Number(value.badges[key]) || 0);
      if (n > 0) rec.b[key] = Math.max(rec.b[key] ?? 0, n);
    }
  }
  if (value.result && typeof value.result === 'object') {
    rec.h = [...rec.h.filter((entry) => entry?.id !== value.result.id), value.result].slice(-MAX_HISTORY);
  }
  store.set(id, rec);
  schedule();
}

export function storageState() {
  return { kind: 'browser', durable: false };
}

// The browser's version of ranks.js's SIGINT/SIGTERM/exit handlers. `pagehide` is the one
// that actually fires on every path away from the page, including the mobile app switch
// that `beforeunload` misses; the hidden-state check covers a tab being backgrounded and
// then discarded without ever firing pagehide.
addEventListener('pagehide', flush);
addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush();
});
