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
// Public-host careers are keyed only after server/identity.js verifies a fresh signature
// and derives the id from its public key. Unsigned clients still play, but account=null means
// they never become a map key here. The cap below remains defense in depth and keeps old
// file stores bounded while their unsigned browser ids are migrated exactly once.
//
// THE FILE HAS TWO LEGAL SHAPES, and will for as long as any ranks.json in the world still
// holds the first one. `{"id": 93}` is the original schema, a career and nothing else;
// `{"id": {"k": 93, "b": {"hs": 12}, "i": ["ember"], "e": "ember"}}` is the extensible
// record, now including optional grants and equipped finish. Both parse; only the second is
// ever written. There is no version field or destructive migration because a bare number is
// unambiguous and every later field has a safe default — see readRecord.

import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

import { TRACK_KEYS } from '../shared/badges.js';
import {
  DEFAULT_FINISH, FINISHES, FINISH_IDS, sanitizeInventory, sanitizeOwnedCosmetics,
} from '../shared/cosmetics.js';
import { XP_PER_LEGACY_KILL, cleanStats } from '../shared/progression.js';

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

/** Bounded even though public keys are verified. Insertion order in a Map is the LRU order
 *  for free, so eviction is the first key and a touch is delete-then-set. */
const MAX_ACCOUNTS = 5000;
const MAX_HISTORY = 20;
const MAX_SUBMISSIONS_PER_ACCOUNT = 12;
const ACTIVE_SUBMISSION_LIMIT = 5;
export const SUBMISSION_STATUSES = Object.freeze([
  'submitted', 'reviewing', 'approved', 'rejected', 'disabled',
]);
let pool = null;
let storageKind = 'file';

/** accountId -> progression plus granted finish ids (`i`) and equipped finish (`e`). */
const store = new Map();
/** Development/file fallback. PostgreSQL remains the shared source of truth in production. */
const submissions = new Map();

const freshRecord = () => ({
  k: 0, b: {}, x: 0, s: cleanStats(), h: [], i: sanitizeInventory(), e: DEFAULT_FINISH,
});

function cleanEquipped(value, inventory) {
  const id = typeof value === 'string' ? value : value?.finish;
  return sanitizeOwnedCosmetics({ finish: id }, inventory).finish ?? DEFAULT_FINISH;
}

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
  const x = Number.isFinite(v.x) && v.x >= 0
    ? Math.floor(v.x)
    : k * XP_PER_LEGACY_KILL;
  const h = Array.isArray(v.h) ? v.h.filter((entry) => entry && typeof entry === 'object').slice(-MAX_HISTORY) : [];
  const i = sanitizeInventory(v.i);
  return { k, b, x, s: cleanStats(v.s), h, i, e: cleanEquipped(v.e, i) };
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

// Render supplies DATABASE_URL when a PostgreSQL database is linked. Loading the compact
// account table once at boot keeps combat and snapshots entirely in memory; only match-end
// settlement writes to the database. With no URL the same code uses the local JSON store,
// which keeps development and private browser-hosted matches working.
const DATABASE_URL = process.env.DATABASE_URL?.trim();
if (DATABASE_URL) {
  try {
    pool = new Pool({
      connectionString: DATABASE_URL,
      // Render's private same-region URL is plain private networking; the external URL
      // explicitly carries sslmode=require. Following the URL keeps both routes valid.
      ssl: /[?&]sslmode=require(?:&|$)/.test(DATABASE_URL) ? { rejectUnauthorized: false } : false,
      max: 4,
      connectionTimeoutMillis: 8000,
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS player_accounts (
        id TEXT PRIMARY KEY,
        xp BIGINT NOT NULL DEFAULT 0,
        career_kills INTEGER NOT NULL DEFAULT 0,
        badges JSONB NOT NULL DEFAULT '{}'::jsonb,
        stats JSONB NOT NULL DEFAULT '{}'::jsonb,
        match_history JSONB NOT NULL DEFAULT '[]'::jsonb,
        equipped_finish TEXT NOT NULL DEFAULT 'standard',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(
      "ALTER TABLE player_accounts ADD COLUMN IF NOT EXISTS equipped_finish TEXT NOT NULL DEFAULT 'standard'",
    );
    await pool.query(`
      CREATE TABLE IF NOT EXISTS account_inventory (
        account_id TEXT NOT NULL,
        cosmetic_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'grant',
        granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (account_id, cosmetic_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS community_submissions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'submitted'
          CHECK (status IN ('submitted','reviewing','approved','rejected','disabled')),
        reviewer_note TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(
      'CREATE INDEX IF NOT EXISTS community_submissions_account_idx ON community_submissions (account_id, created_at DESC)',
    );
    const loaded = await pool.query(
      'SELECT id, xp, career_kills, badges, stats, match_history, equipped_finish FROM player_accounts ORDER BY updated_at DESC LIMIT $1',
      [MAX_ACCOUNTS],
    );
    for (const row of loaded.rows.reverse()) {
      const rec = readRecord({
        k: Number(row.career_kills),
        b: row.badges,
        x: Number(row.xp),
        s: row.stats,
        h: row.match_history,
        e: row.equipped_finish,
      });
      if (rec) store.set(row.id, rec);
    }
    if (loaded.rows.length) {
      const grants = await pool.query(
        'SELECT account_id, cosmetic_id FROM account_inventory WHERE account_id = ANY($1::text[])',
        [loaded.rows.map((row) => row.id)],
      );
      for (const row of grants.rows) {
        const rec = store.get(row.account_id);
        if (rec) {
          rec.i = sanitizeInventory([...rec.i, row.cosmetic_id]);
          rec.e = cleanEquipped(rec.e, rec.i);
        }
      }
    }
    storageKind = 'postgres';
    console.log(`  accounts: PostgreSQL ready (${loaded.rowCount} loaded)`);
  } catch (err) {
    console.warn(`  accounts: PostgreSQL unavailable (${err.code ?? err.message}) — using file fallback`);
    await pool?.end().catch(() => {});
    pool = null;
  }
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
  if (pool) return;
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
  for (const [id, r] of store) {
    const row = { k: r.k };
    const hasStats = Object.values(r.s).some((n) => n > 0);
    if (r.x !== r.k * XP_PER_LEGACY_KILL && (hasStats || r.h.length)) row.x = r.x;
    if (hasStats) row.s = r.s;
    if (Object.keys(r.b).length) row.b = r.b;
    if (r.h.length) row.h = r.h;
    const grants = sanitizeInventory(r.i).filter((finish) => !FINISHES[finish].issued);
    if (grants.length) row.i = grants;
    if (r.e && r.e !== DEFAULT_FINISH) row.e = cleanEquipped(r.e, r.i);
    out[id] = row;
  }
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

/**
 * One-time bridge from the old unsigned browser id to a signed device account.
 *
 * A destination that already exists always wins and cannot absorb arbitrary legacy rows.
 * The old id was itself the bearer credential in Phase 5, so accepting it once from the
 * freshly signed HELLO is no weaker than the system being retired; deleting it closes that
 * path permanently after the first successful upgrade.
 */
export async function claimLegacy(from, to) {
  if (!from || !to || from === to || store.has(to)) return false;
  const rec = store.get(from);
  let dbMigrated = false;
  if (pool) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const accountMove = await db.query(
        `UPDATE player_accounts SET id = $2, updated_at = NOW()
         WHERE id = $1
           AND NOT EXISTS (SELECT 1 FROM player_accounts WHERE id = $2)`,
        [from, to],
      );
      const inventoryMove = await db.query(
        `INSERT INTO account_inventory (account_id, cosmetic_id, source, granted_at)
         SELECT $2, cosmetic_id, source, granted_at FROM account_inventory WHERE account_id = $1
         ON CONFLICT (account_id, cosmetic_id) DO NOTHING`,
        [from, to],
      );
      await db.query('DELETE FROM account_inventory WHERE account_id = $1', [from]);
      const submissionMove = await db.query(
        'UPDATE community_submissions SET account_id = $2, updated_at = NOW() WHERE account_id = $1',
        [from, to],
      );
      await db.query('COMMIT');
      dbMigrated = accountMove.rowCount > 0 || inventoryMove.rowCount > 0
        || submissionMove.rowCount > 0;
    } catch (err) {
      await db.query('ROLLBACK').catch(() => {});
      console.warn(`  accounts: identity migration failed (${err.code ?? err.message})`);
      return false;
    } finally {
      db.release();
    }
  }
  if (rec) {
    store.delete(from);
    store.set(to, rec);
    if (!pool) schedule();
  }
  return Boolean(rec) || dbMigrated;
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

/** Private account profile. Copies every nested value before a Room can mutate it. */
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

/** Refresh one account at admission/API time so two Render regions share grants immediately. */
export async function profileFresh(id) {
  if (!id || !pool) return profileOf(id);
  const [account, grants] = await Promise.all([
    pool.query(
      `SELECT xp, career_kills, badges, stats, match_history, equipped_finish
       FROM player_accounts WHERE id = $1`,
      [id],
    ),
    pool.query('SELECT cosmetic_id FROM account_inventory WHERE account_id = $1', [id]),
  ]);
  const row = account.rows[0];
  const rec = row ? readRecord({
    k: Number(row.career_kills), b: row.badges, x: Number(row.xp), s: row.stats,
    h: row.match_history, i: grants.rows.map((grant) => grant.cosmetic_id),
    e: row.equipped_finish,
  }) : freshRecord();
  rec.i = sanitizeInventory([...rec.i, ...grants.rows.map((grant) => grant.cosmetic_id)]);
  rec.e = cleanEquipped(rec.e, rec.i);
  touch(id);
  store.set(id, rec);
  return profileOf(id);
}

/** Persist an owned selection. A locked, unknown or unapproved id is refused. */
export async function equipFinish(id, finish) {
  if (!id || typeof finish !== 'string' || !FINISHES[finish]?.approved) return null;
  const profile = await profileFresh(id);
  if (!profile.inventory.includes(finish)) return null;
  const rec = store.get(id) ?? freshRecord();
  rec.i = sanitizeInventory(profile.inventory);
  rec.e = finish;
  store.set(id, rec);
  if (!pool) {
    schedule();
  } else {
    await pool.query(
      `INSERT INTO player_accounts (id, equipped_finish, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET equipped_finish = EXCLUDED.equipped_finish, updated_at = NOW()`,
      [id, finish],
    );
  }
  return profileOf(id);
}

/** Resolve HELLO cosmetics through the same ownership ledger the inventory API exposes. */
export async function authorizeCosmetics(id, raw) {
  if (!id) return { profile: profileOf(null), cosmetics: {} };
  const requested = typeof raw?.finish === 'string' ? raw.finish : null;
  let profile = await profileFresh(id);
  const finish = requested && profile.inventory.includes(requested)
    ? requested
    : (profile.equipped.finish ?? DEFAULT_FINISH);
  if ((profile.equipped.finish ?? DEFAULT_FINISH) !== finish) {
    profile = await equipFinish(id, finish);
  }
  return { profile, cosmetics: sanitizeOwnedCosmetics({ finish }, profile.inventory) };
}

const URLISH = /(?:https?:\/\/|www\.|data:|file:|ftp:)/i;
const COLOR = /^#[0-9a-f]{6}$/i;

export function submissionManifest(raw) {
  const title = typeof raw?.title === 'string' ? raw.title.trim().replace(/\s+/g, ' ') : '';
  const description = typeof raw?.description === 'string'
    ? raw.description.trim().replace(/\s+/g, ' ')
    : '';
  const palette = {
    steel: String(raw?.steel ?? '').toLowerCase(),
    dark: String(raw?.dark ?? '').toLowerCase(),
    trim: String(raw?.trim ?? '').toLowerCase(),
  };
  if (title.length < 3 || title.length > 40 || description.length < 20 || description.length > 500) {
    throw new Error('submission_length');
  }
  if (URLISH.test(`${title} ${description}`) || /[<>\u0000-\u001f]/.test(`${title}${description}`)) {
    throw new Error('submission_content');
  }
  if (!Object.values(palette).every((value) => COLOR.test(value))
      || new Set(Object.values(palette)).size !== 3) {
    throw new Error('submission_palette');
  }
  return { title, description, ...palette, kind: 'procedural_palette_v1' };
}

const publicSubmission = (row) => ({
  id: row.id,
  account: row.account_id ?? row.account,
  title: row.title,
  description: row.description,
  manifest: typeof row.manifest === 'string' ? JSON.parse(row.manifest) : row.manifest,
  status: row.status,
  note: row.reviewer_note ?? row.note ?? '',
  createdAt: row.created_at ?? row.createdAt,
  updatedAt: row.updated_at ?? row.updatedAt,
});

export async function submissionsOf(id) {
  if (!id) return [];
  if (pool) {
    const result = await pool.query(
      `SELECT id, account_id, title, description, manifest, status, reviewer_note,
              created_at, updated_at
       FROM community_submissions WHERE account_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [id, MAX_SUBMISSIONS_PER_ACCOUNT],
    );
    return result.rows.map(publicSubmission);
  }
  return [...submissions.values()].filter((entry) => entry.account === id)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, MAX_SUBMISSIONS_PER_ACCOUNT).map(publicSubmission);
}

/** Accept a bounded palette concept—not a file or URL—under a verified creator account. */
export async function submitCosmetic(id, raw) {
  if (!id) throw new Error('identity_required');
  const manifest = submissionManifest(raw);
  const mine = await submissionsOf(id);
  if (mine.length >= MAX_SUBMISSIONS_PER_ACCOUNT
      || mine.filter((item) => ['submitted', 'reviewing'].includes(item.status)).length
        >= ACTIVE_SUBMISSION_LIMIT) {
    throw new Error('submission_limit');
  }
  const entry = {
    id: randomUUID(), account: id, title: manifest.title, description: manifest.description,
    manifest, status: 'submitted', note: '', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (pool) {
    const result = await pool.query(
      `INSERT INTO community_submissions
         (id, account_id, title, description, manifest, status, reviewer_note)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'submitted', '')
       RETURNING id, account_id, title, description, manifest, status, reviewer_note,
                 created_at, updated_at`,
      [entry.id, id, entry.title, entry.description, JSON.stringify(entry.manifest)],
    );
    return publicSubmission(result.rows[0]);
  }
  submissions.set(entry.id, entry);
  return publicSubmission(entry);
}

export async function reviewSubmissions() {
  if (pool) {
    const result = await pool.query(
      `SELECT id, account_id, title, description, manifest, status, reviewer_note,
              created_at, updated_at
       FROM community_submissions ORDER BY created_at DESC LIMIT 200`,
    );
    return result.rows.map(publicSubmission);
  }
  return [...submissions.values()].sort((a, b) =>
    String(b.createdAt).localeCompare(String(a.createdAt))).map(publicSubmission);
}

export async function reviewSubmission(id, status, note = '') {
  if (typeof id !== 'string' || !SUBMISSION_STATUSES.includes(status)) return null;
  const cleanNote = typeof note === 'string' ? note.trim().slice(0, 300) : '';
  if (URLISH.test(cleanNote) || /[<>\u0000-\u001f]/.test(cleanNote)) return null;
  if (pool) {
    const result = await pool.query(
      `UPDATE community_submissions SET status = $2, reviewer_note = $3, updated_at = NOW()
       WHERE id = $1
       RETURNING id, account_id, title, description, manifest, status, reviewer_note,
                 created_at, updated_at`,
      [id, status, cleanNote],
    );
    return result.rows[0] ? publicSubmission(result.rows[0]) : null;
  }
  const entry = submissions.get(id);
  if (!entry) return null;
  Object.assign(entry, { status, note: cleanNote, updatedAt: new Date().toISOString() });
  return publicSubmission(entry);
}

export async function grantFinish(account, finish, source = 'admin') {
  if (typeof account !== 'string' || !/^device-[A-Za-z0-9_-]{32}$/.test(account)
      || !FINISHES[finish]?.approved || FINISHES[finish].issued) return null;
  if (pool) {
    await pool.query(
      `INSERT INTO account_inventory (account_id, cosmetic_id, source)
       VALUES ($1, $2, $3) ON CONFLICT (account_id, cosmetic_id) DO NOTHING`,
      [account, finish, String(source).slice(0, 32)],
    );
  }
  const rec = store.get(account) ?? freshRecord();
  rec.i = sanitizeInventory([...rec.i, finish]);
  store.set(account, rec);
  if (!pool) schedule();
  return pool ? profileFresh(account) : profileOf(account);
}

export async function revokeFinish(account, finish) {
  if (typeof account !== 'string' || !/^device-[A-Za-z0-9_-]{32}$/.test(account)
      || !FINISHES[finish]?.approved || FINISHES[finish].issued) return null;
  if (pool) await pool.query(
    'DELETE FROM account_inventory WHERE account_id = $1 AND cosmetic_id = $2', [account, finish],
  );
  const rec = store.get(account) ?? freshRecord();
  rec.i = sanitizeInventory(rec.i.filter((id) => id !== finish));
  if (rec.e === finish) rec.e = DEFAULT_FINISH;
  store.set(account, rec);
  if (pool) await pool.query(
    `UPDATE player_accounts SET equipped_finish = 'standard', updated_at = NOW()
     WHERE id = $1 AND equipped_finish = $2`, [account, finish],
  );
  else schedule();
  return pool ? profileFresh(account) : profileOf(account);
}

/** Record a career total. Called from the Room's `onCareer` hook, which only fires for a
 *  player that has an account — bots and anonymous clients never reach here. */
export function setCareer(id, kills, badges) {
  if (!id || !Number.isFinite(kills)) return;
  touch(id);
  const rec = store.get(id) ?? freshRecord();
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

/** Save one server-issued match receipt. This is the only PostgreSQL write path. */
export async function settleMatch(id, value = {}) {
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

  if (!pool) {
    schedule();
    return;
  }
  await pool.query(
    `INSERT INTO player_accounts (id, xp, career_kills, badges, stats, match_history, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET
       xp = GREATEST(player_accounts.xp, EXCLUDED.xp),
       career_kills = GREATEST(player_accounts.career_kills, EXCLUDED.career_kills),
       badges = EXCLUDED.badges,
       stats = EXCLUDED.stats,
       match_history = EXCLUDED.match_history,
       updated_at = NOW()`,
    [id, rec.x, rec.k, JSON.stringify(rec.b), JSON.stringify(rec.s), JSON.stringify(rec.h)],
  );
}

export function storageState() {
  return { kind: storageKind, durable: storageKind === 'postgres' };
}

/** Test seam: verify.mjs needs to see the cap and the LRU order without 5000 sockets. */
export function _stats() {
  return { size: store.size, cap: MAX_ACCOUNTS, oldest: store.keys().next().value ?? null, dirty };
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { flush(); process.exit(0); });
}
process.on('exit', flush);
