// The career store: how many kills each account has ever scored, kept across matches
// AND across server restarts, which is the only part of this game's state that outlives
// the process.
//
// THIS IS THE ONLY FILESYSTEM ACCESS ANYWHERE UNDER server/, and it must stay that way.
// It is imported by server/index.js and by nothing else — deliberately not by room.js,
// which verify.mjs constructs Rooms out of in four separate places. A Room that reached
// the disk even transitively would make `npm run verify` read and rewrite this file as a
// side effect of running the test suite, so a player's career would be at the mercy of
// whatever a test happened to simulate. Room keeps `p.career` as a plain integer and
// hands changes back through the `onCareer` callback that index.js installs; the wiring
// runs one way, from here outward.
//
// A career keyed on a client-supplied id is SPOOFABLE, and it is worth being plain about
// which half of that matters. Accumulation is server-authoritative — you cannot invent
// kills, only claim someone else's ledger — and client/src/identity.js already names the
// seam where that stops being true ("later this returns a wallet address plus a signature
// the server can verify"). Until that seam gains signature checking, treat a rank as a
// display of a claim rather than proof of one. What the spoofability DOES demand today is
// the account cap below: an unverified id is an unbounded map key, and a map key that
// reaches the disk is a way to fill it.
//
// THE FILE HAS TWO LEGAL SHAPES, and will for as long as any ranks.json in the world still
// holds the first one. `{"id": 93}` is the original schema, a career and nothing else;
// `{"id": {"k": 93, "b": {"hs": 12}}}` is the same career plus per-badge counts. Both parse;
// only the second is ever written, so the first kill after an upgrade migrates the file in
// place. There is no version field and no migration step, because a bare number IS
// unambiguous — see readRecord.

import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { TRACK_KEYS } from '../shared/badges.js';

/**
 * FPSBONE_RANKS redirects the store, and exists so that verify.mjs can exercise this
 * file — the boot parse, the cap, the eviction order — without the suite ever opening a
 * real player's career. That is the same quarantine the header argues for one level up:
 * there, a Room must not be able to reach the disk; here, a test must not be able to
 * reach THIS disk. A suite that has to back up and restore the live file to be safe is
 * one crash away from not restoring it.
 */
const FILE = process.env.FPSBONE_RANKS || fileURLToPath(new URL('../ranks.json', import.meta.url));
const TMP = `${FILE}.tmp`;

/** Bounded, because the keys arrive unverified from clients. Insertion order in a Map is
 *  the LRU order for free, so eviction is the first key and a touch is delete-then-set. */
const MAX_ACCOUNTS = 5000;

/** accountId -> `{ k: career kills, b: { track: count } }`. */
const store = new Map();

/**
 * Read one file entry into a record, or null for something unusable.
 *
 * A bare number reads as a career with no badges, which is exactly what it means: those
 * kills were scored before badges existed, and there is no honest way to attribute them to
 * a weapon after the fact. Better a player keeps their rank and starts every badge at zero
 * than that the file invents a distribution nobody earned.
 *
 * Badge keys are WHITELISTED against TRACK_KEYS. This is the same unverified surface
 * MAX_ACCOUNTS exists for, one level down: the account ids come from clients, and the badge
 * keys inside an account come from whatever was last written to a file on disk. Filtering
 * on the way in means a hand-edited or half-migrated store cannot grow a key set that then
 * gets written back out and read in again forever.
 */
function readRecord(v) {
  if (Number.isFinite(v) && v >= 0) return { k: Math.floor(v), b: {} };
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (!(Number.isFinite(v.k) && v.k >= 0)) return null;
  const b = {};
  if (v.b && typeof v.b === 'object') {
    for (const key of TRACK_KEYS) {
      const n = v.b[key];
      if (Number.isFinite(n) && n > 0) b[key] = Math.floor(n);
    }
  }
  return { k: Math.floor(v.k), b };
}

let dirty = false;
let timer = null;

// Long enough that a busy room writes a handful of times a minute instead of on every
// kill, and short enough that a hard kill -- which no handler below can catch -- costs a
// player seconds of progress rather than a session of it.
//
// Never on the kill itself. server/index.js drives the simulation from a setTimeout loop
// at <=4ms, and it already has a branch for falling behind that drops its whole backlog;
// a synchronous file write on the same thread is exactly the kind of stall that gets it
// there. Debounced, off the hot path, and flushed for real on the way out.
const WRITE_DELAY_MS = 8000;

try {
  const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
  // The file is written atomically below, so a truncated one should be impossible — but
  // "should be impossible" is not a reason to fail to boot. A corrupt or half-written
  // store yields an EMPTY store and a running server, which loses careers; throwing here
  // would lose the server, which loses the game. Nothing is written back until an actual
  // kill marks it dirty, so a merely unreadable file is not immediately overwritten.
  if (parsed && typeof parsed === 'object') {
    for (const [k, v] of Object.entries(parsed)) {
      const rec = typeof k === 'string' ? readRecord(v) : null;
      if (rec) store.set(k, rec);
    }
  }
  console.log(`  careers: ${store.size} account(s) loaded`);
} catch (err) {
  // ENOENT on a fresh install is the ordinary case and not worth a warning; anything else
  // is worth one, because it means careers are silently not being kept.
  if (err.code !== 'ENOENT') console.warn(`  careers: ${FILE} unreadable (${err.code ?? err.message}) — starting empty`);
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

function schedule() {
  dirty = true;
  if (timer) return;
  // unref'd: a pending write must not be the reason the process stays alive. The exit
  // handlers below are what guarantee it actually lands.
  timer = setTimeout(flush, WRITE_DELAY_MS);
  timer.unref?.();
}

// A WRITE THAT FAILED IS NOT A WRITE THAT SHOULD BE FORGOTTEN, and the failure is not
// hypothetical: on Windows, anything holding the store open for the moment it takes a virus
// scanner to look at a JSON file that just appeared turns the rename onto it into
// ERROR_SHARING_VIOLATION, which libuv reports as EBUSY. `npm run verify` caught this
// exactly once in three runs and the four careers checks that read the file back went red
// with it, which is the only reason anybody found out — a real player would have been told
// by one line of console output that their afternoon was gone.
//
// So: a few attempts, backing off, and the waits are the point of the table rather than a
// detail of it. They are paid ONLY after a write has already failed, so the hot path this
// file's header defends is untouched; a hundred milliseconds of stall in the rare case that
// the filesystem is arguing with something is a better trade than a lost career.
const RETRY_MS = [0, 5, 20, 80];

/** Sleep on this thread, which is a thing to do exactly once: after a failed write, where
 *  the alternative is to hand the career back to whoever is holding the file. */
function stall(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Temp-then-rename, so a reader never sees a half-written file — the guarantee the boot
 *  parse above is allowed to rely on. */
export function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!dirty) return;
  dirty = false;
  // Always the new shape, which is what migrates a legacy file. `b` is omitted when
  // empty rather than written as `{}` — most accounts on a fresh upgrade have no badges
  // yet, and eight bytes each across five thousand of them is worth not spending.
  const out = {};
  for (const [id, r] of store) out[id] = Object.keys(r.b).length ? { k: r.k, b: r.b } : { k: r.k };
  const text = JSON.stringify(out);
  let last = null;
  for (const wait of RETRY_MS) {
    stall(wait);
    try {
      writeFileSync(TMP, text);
      renameSync(TMP, FILE);
      return;
    } catch (err) {
      last = err;
      // The half-written temp goes, always. It is the file the boot parse is allowed to
      // assume cannot exist, and a failed rename is precisely when it does.
      try { unlinkSync(TMP); } catch { /* nothing to clean up */ }
    }
  }
  console.warn(`  careers: write failed ${RETRY_MS.length}x (${last.code ?? last.message}) — kept`);
  // And the work goes BACK on the queue. `dirty` was cleared on the way in so that a write
  // in flight cannot be scheduled on top of itself; leaving it cleared here is what would
  // turn a scanner blinking into a career that never lands, since nothing else retries —
  // the next attempt would wait for a kill that a player who just quit will never score.
  schedule();
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
 * A COPY, deliberately. The caller is server/index.js, handing this straight to a Room
 * player that will increment it on every kill — and a Room mutating the store in place
 * would put counts on disk that setCareer's monotonic guard below never saw, which is the
 * one thing that guard exists to prevent.
 */
export function badgesOf(id) {
  if (!id) return {};
  touch(id);
  return { ...(store.get(id)?.b ?? {}) };
}

/** Record a career total. Called from the Room's `onCareer` hook, which only fires for a
 *  player that has an account — bots and anonymous clients never reach here. */
export function setCareer(id, kills, badges) {
  if (!id || !Number.isFinite(kills)) return;
  touch(id);
  const rec = store.get(id) ?? { k: 0, b: {} };
  rec.k = Math.max(rec.k, Math.floor(kills));
  // Per key, and monotonic per key for the same reason the kill count is: this arrives from
  // a Room, and a Room that was handed a stale badge map — a second window on the same
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

/** Test seam: verify.mjs needs to see the cap and the LRU order without 5000 sockets. */
export function _stats() {
  return { size: store.size, cap: MAX_ACCOUNTS, oldest: store.keys().next().value ?? null, dirty };
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { flush(); process.exit(0); });
}
process.on('exit', flush);
