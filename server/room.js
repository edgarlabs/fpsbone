// Authoritative match state. Owns every player, steps the simulation, and builds
// snapshots. Client-reported positions are never read — only intent.
//
// Room knows about weapons and ammunition, because those decide damage and damage
// is authoritative. It knows nothing about teams, rounds or bombs: those live in
// the mode controller it calls out to at six points (see server/modes/index.js).

import * as C from '../shared/constants.js';
import { WORLD_BOXES, SPAWNS } from '../shared/map.js';
import { createPlayerState, stepPlayer, sanitizeInput, eyeY, aimDir } from '../shared/movement.js';
import { MSG, EV } from '../shared/protocol.js';
import { modeOf } from '../shared/modes.js';
import {
  WEAPON_IDS,
  WEAPONS,
  switchMsOf,
  hasHeavy,
  HIT_ZONE,
  HIT_ZONE_MUL,
  idAt,
  indexOf,
  isAuto,
  jamChanceOf,
  JAM_CLEAR_MS,
  pelletsOf,
  rollLoadout,
  shotDamage,
  shotStats,
  spreadMul,
  weaponAt,
} from '../shared/weapons.js';
import { createController } from './modes/index.js';
import { createBrain } from './ai.js';
import { TIERS } from '../shared/ranks.js';
import {
  XP_PER_LEGACY_KILL,
  XP_RULES,
  cleanStats,
  emptyStats,
  matchXp,
  rankOfXp,
} from '../shared/progression.js';
import { matchCredits } from '../shared/economy.js';
import {
  BADGES, MAX_LEVEL, MAX_BADGE_TIER, TRACK_KEYS, publicTiers, tierOf, tracksFor,
} from '../shared/badges.js';
import { sanitizeCosmetics } from '../shared/cosmetics.js';
import { resolveShot, rewindTimeFor } from './hitscan.js';
import { rayWorld } from '../shared/collide.js';
import {
  PROJECTILES,
  blastDamage,
  createProjectile,
  hitsBody,
  stepProjectile,
} from '../shared/projectile.js';

/**
 * Position quantisation for the wire. Exported so verify.mjs can test the real
 * quantiser rather than a copy of it: this rounding is half of a bug pair that put
 * players on top of walls twice (the other half is the contact skin in
 * shared/collide.js, which must stay larger than this function's 0.0005 max error).
 * If the precision here ever changes, the check moves with it.
 */
export const r3 = (v) => Math.round(v * 1000) / 1000;
const MAX_QUEUED_INPUTS = 60;

/**
 * Buttons a starvation filler tick may keep held (see `step`).
 *
 * Jump is in here and that reads wrong at first glance — it is the whole point.
 * Jumping is edge-triggered off `jumpHeld` in shared/movement.js, so *clearing* the
 * bit is what grants a free jump: the latch drops, and the next real input with
 * space still down looks like a fresh press. Holding space then bunny-hopped
 * forever. Keeping the bit keeps the latch, so one press stays one jump.
 *
 * Crouch and walk are held for the same reason in reverse: they are level-triggered,
 * and dropping them stood a stalled player up out of cover and sped them back to a
 * run, which the client — still predicting a held key — disagreed with every tick.
 *
 * Sprint is that same shape once more. Dropping it during a stall slows an authoritative
 * sprinter to a run while the client, still holding the key, predicts sprint speed — a
 * positional disagreement on every stalled tick. Holding it instead only bleeds stamina,
 * 3 units of 720 a tick, and stamina is authoritative and re-sent in every snapshot, so
 * the client is corrected rather than left to diverge. Bounded and self-correcting beats
 * unbounded and not.
 *
 * Fire, alt, reload and use are all masked off. A stall must never buy an attack.
 */
const FILLER_BUTTONS = C.BTN_JUMP | C.BTN_CROUCH | C.BTN_WALK | C.BTN_SPRINT;

/**
 * A deterministic career for a bot, spread across the whole ladder.
 *
 * Lands exactly ON a tier boundary rather than somewhere inside a band, which is worth a
 * word because it looks like an oversight. A boundary is the value `rankOf` is inclusive
 * at, so ordinary solo play exercises the one comparison in that function most likely to
 * be written `>` by mistake — and any bot showing the tier below the one it was seeded
 * for is that mistake, visible without a test.
 */
const botCareer = (id) => {
  // xorshift on a Knuth multiplication. Adjacent ids must land far apart: bots are seated
  // 1, 2, 3... within a room, and `id * k % TIERS.length` would march them up the ladder
  // in lockstep, which reads as a deliberate difficulty ramp rather than as variety.
  let h = (id * 2654435761) & 0x7fffffff;
  h ^= h >>> 13;
  h = (h * 1103515245) & 0x7fffffff;
  return TIERS[(h >>> 7) % TIERS.length].at;
};

/** Direct Room consumers from before Phase 5 seed career only; hosts always seed real XP. */
const progressionXpOf = (p) => p.bot
  ? p.career * XP_PER_LEGACY_KILL
  : Number.isFinite(p.xp)
  ? p.xp
  : p.career * XP_PER_LEGACY_KILL;

/**
 * A deterministic badge shelf for a bot: `{ track: count }`, two to four tracks lit.
 *
 * The same argument `botCareer` above makes, one level down. Solo-versus-AI is how most of
 * this feature will ever be seen, and a scoreboard where nine bots have a rank and a blank
 * badge column would read as a broken feature rather than as nine humble bots. It is also
 * the only way the rotating slot on that board is ever exercised without a career behind it.
 *
 * ON A TIER BOUNDARY, exactly like `botCareer`, and for exactly its reason: the threshold is
 * the value `stepOf` is inclusive at, so ordinary play exercises the one comparison in that
 * function most likely to have been written `>` — and a bot wearing the tier below the one
 * it was seeded for is that mistake, visible on screen without a test.
 *
 * TWO TO FOUR and never all twelve. A bot with every track lit looks like test data, and the
 * whole point of the slot is that it rotates through a SHELF: one track cannot rotate, and
 * twelve is a slot machine.
 */
const botBadges = (id) => {
  // Same xorshift-on-a-Knuth-multiplication as botCareer, salted per track so the tracks a
  // bot has are not the tracks the bot with the next id has. Adjacent ids landing on
  // adjacent shelves would read as a difficulty ramp, which is the mistake that function
  // documents.
  const hash = (n) => {
    let h = ((id * 2654435761) ^ (n * 40503)) & 0x7fffffff;
    h ^= h >>> 13;
    return (h * 1103515245) & 0x7fffffff;
  };
  const out = {};
  const many = 2 + ((hash(0) >>> 9) % 3);
  // A COLLISION REDRAWS rather than shortening the shelf, which is why this loop counts KEYS
  // and not draws. Two of three draws landing on the same track is a one-in-twelve event and
  // it caught about seven per cent of ids — one bot in every second lobby wearing a single
  // chip in a column whose entire job is to rotate through several. The redraw is bounded and
  // cannot spin: `many` is at most four and there are twelve tracks to find them in.
  for (let i = 0; Object.keys(out).length < many && i < TRACK_KEYS.length * 4; i++) {
    const key = TRACK_KEYS[(hash(i + 1) >>> 7) % TRACK_KEYS.length];
    const tier = 1 + ((hash(i + 17) >>> 11) % MAX_BADGE_TIER);
    // Highest wins on a collision, so a track drawn twice reads as one shelf rather than as
    // whichever iteration happened to run last.
    const at = BADGES[key].at[(tier - 1) * MAX_LEVEL];
    if (at > (out[key] ?? 0)) out[key] = at;
  }
  return out;
};

/**
 * Names for AI players.
 *
 * Every one is prefixed, and that prefix is the entire mechanism for telling bots
 * apart on screen: the killfeed, the scoreboard and the name over a body all read
 * this one string. No `bot` flag goes on the wire, because the moment one does, a
 * client can be written that outlines the humans and ignores everything else.
 */
const BOT_NAMES = [
  'BOT Ivy',
  'BOT Rook',
  'BOT Dell',
  'BOT Kite',
  'BOT Nova',
  'BOT Ash',
  'BOT Quill',
  'BOT Mesa',
  'BOT Wren',
  'BOT Coil',
  'BOT Fen',
  'BOT Vale',
];

export class Room {
  constructor(modeId) {
    this.modeId = modeId;
    this.mode = modeOf(modeId);

    // The loadout whitelist, resolved once to wire indices. A client may ask for
    // any weapon that exists; only these are granted, and the first is the default.
    // In a mode that deals loadouts this is the *pool* rather than the grant — see
    // `dealLoadout`, which narrows it per player.
    this.allowed = new Set(this.mode.loadout.map(indexOf));
    this.defaultWep = indexOf(this.mode.loadout[0]);

    this.players = new Map();
    this.tick = 0;
    this.events = [];
    this.nextId = 1;
    this.spawnCursor = 0;
    /** Live thrown projectiles. Rebuilt each tick rather than spliced. */
    this.projectiles = [];
    /**
     * Live smoke clouds — world state, not an effect.
     *
     * They live on the room and go out in the snapshot because they block sight, and
     * blocking sight is only real if everyone agrees where they are: the client draws
     * them, and server/ai.js tests them when a bot decides whether it can see you. A
     * cloud that existed only on the client would be a cloud bots shoot straight
     * through, which is worse than having no smoke at all.
     */
    this.clouds = [];
    this.nextCloudId = 1;
    /** Ids of the AI players, in the order they joined — so trimming the count
     *  removes the newest and leaves whoever has been in the fight alone. */
    this.bots = new Set();
    /**
     * Bumped whenever a MSG.ROSTER row could have changed: a join, a drop, or a kill that
     * promoted somebody's rank or badge.
     *
     * A REVISION AND NOT A DIRTY FLAG, because there is one room and several clients and a
     * flag would be cleared by whoever read it first. The host keeps the number it last
     * sent per room and compares — one integer compare per broadcast, which is what lets
     * this be checked every tick and sent almost never.
     */
    this.rosterRev = 0;
    this.matchNo = 1;
    this.matchEpoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    /**
     * The room's source of chance. Only the jam roll uses it, and it is a field rather
     * than a bare `Math.random()` call for the same reason `rollLoadout` takes one: a
     * mechanic that fires at random cannot be tested, and a fire-rate test that a 1-in-100
     * stoppage can fail is a test that fails for reasons nobody will trust.
     *
     * Tests pin it — `() => 1` never jams, `() => 0` always does. Nothing in the game
     * assigns it, so play is unaffected.
     */
    this.rand = Math.random;
    /**
     * Called with `(accountId, careerKills, badgeCounts)` whenever a player with an
     * account scores a kill. The one and only way a career leaves this file.
     *
     * Badges ride the same hook rather than getting one of their own: they are incremented
     * on the same line, by the same guard, for the same kill. Two hooks would be two
     * chances for a caller to wire one and forget the other, and a badge count that
     * persists on a different schedule from the career it belongs to is a pair of numbers
     * that can disagree after a crash.
     *
     * A hook rather than a direct call into server/ranks.js, because that module reaches
     * the filesystem and this one must never do so even transitively: verify.mjs builds
     * Rooms in four places, and a Room that wrote to disk would make running the test
     * suite mutate real players' careers. Defaulted to null and read with `?.` — exactly
     * the shape modes/index.js gives `onKill` — so every existing caller, the suite
     * included, gets a Room that counts careers in memory and persists nothing.
     */
    this.onCareer = null;
    /** Match settlement is injected by the host, beside onCareer, so Rooms remain free of IO. */
    this.onMatch = null;

    // Last, so the controller can read mode/allowed off a fully built room.
    this.ctl = createController(this);
  }

  /** Simulation clock, derived from the tick count rather than wall time. */
  now() {
    return (this.tick * 1000) / C.TICK_HZ;
  }

  /**
   * Seat a player and return their id.
   *
   * `isBot` registers this body in `this.bots` BEFORE the controller's `onJoin` hook
   * runs, which is the only reason the flag exists: at that moment `p.bot` is still null
   * — the brain cannot be built until `add` has handed back an id — so without it a hook
   * has no way to tell a backfilled body from a person. A team mode needs exactly that
   * distinction, because it balances the two on different counts: PEOPLE are spread
   * across both sides so that they actually meet each other, while bots only even the
   * numbers up. See `sideFor` in modes/tdm.js.
   */
  add(name, cosmetics, account = null, isBot = false) {
    const id = this.nextId++;
    const spawn = this.pickSpawn();
    const p = {
      id,
      name,
      // HELLO is untrusted. Only a server-approved finish id enters the room.
      cosmetics: sanitizeCosmetics(cosmetics),
      /**
       * The account this player's career is filed under, or null for a bot or a client
       * that sent no id. Third parameter and defaulted, so all five verify.mjs call
       * sites and `addBot` keep working untouched, and a HELLO without an id means
       * "anonymous" rather than a throw.
       *
       * Never echoed back on the wire. The snapshot carries the derived tier and nothing
       * else — an id is a bearer token until the identity seam can verify a signature,
       * and broadcasting everyone's to everyone would hand out the whole room's careers.
       */
      account,
      /**
       * Career kills, as a plain in-memory integer. Seeded by whoever called `add` and
       * incremented here; the disk is somebody else's problem, by design (see onCareer).
       */
      career: 0,
      /** Account XP is what rank now derives from. Old careers migrate at 100 XP per kill. */
      xp: null,
      accountStats: emptyStats(),
      match: {
        joinedAt: this.now(),
        humanKills: 0,
        botKills: 0,
        humanHeadshots: 0,
        botHeadshots: 0,
        assists: 0,
        objectives: 0,
        deaths: 0,
        settled: false,
      },
      pendingResult: null,
      /**
       * Career kills per badge track, `{ track: count }` — `shared/badges.js` owns the
       * keys. Same deal as `career`: a plain in-memory object, seeded by whoever called
       * `add` and incremented here, with the disk somebody else's problem.
       *
       * Absent keys are zero. That keeps a fresh player's object empty rather than twelve
       * zeroes, which matters because this object goes on the wire in the private `self`
       * blob every snapshot — the same omit-when-zero economy `sp`, `jm` and `rk` use.
       */
      badges: {},
      /**
       * Round-trip milliseconds to this player, or 0 when no real network route exists.
       *
       * WRITTEN FROM OUTSIDE, by server/index.js, off the Node transport's application-level
       * browser round trip; the in-page host has no wire and leaves it at zero. It lives here
       * because `snapshotBase` is what puts it on the wire; a parallel map keyed by id in the
       * host would be the same data with one more thing able to fall out of step.
       *
       * NOT SIMULATION STATE. Nothing in `stepPlayer` reads it, it is not in
       * `createPlayerState`, and no replay depends on it — it is a number about the wire,
       * riding on the object the wire is described from.
       */
      ping: 0,
      ...createPlayerState(spawn),
      hp: C.MAX_HP,
      alive: true,
      respawnAt: 0,
      inputs: [],
      lastInput: null,
      /** A short server-clock lease renewed only by a real consumed BTN_USE input.
       *  Objective modes read this instead of `lastInput`, which may be repeated during
       *  packet starvation and must never finish a plant after the key was released. */
      useUntil: 0,
      lastSeq: 0,
      /** When this player may next attack. A deadline rather than a timestamp of the
       *  last shot, because a weapon's two attacks can have different cadences — see
       *  tryFire. */
      nextFireAt: 0,
      /**
       * When this player last fired something loud, for bots to hear.
       *
       * A separate field from `nextFireAt` rather than derived from it, because that one is
       * a deadline whose distance from now is the weapon's cadence — a sniper would be
       * audible for 1200ms and an SMG for 80, which is a property of the fire rate and not
       * of the noise. Melee is deliberately not stamped here: a knife swing is not a
       * gunshot, and a bot that turned round for one would be hearing something the player
       * swinging it is relying on being quiet.
       *
       * Read by server/ai.js and by nothing else. It never reaches the wire.
       */
      lastShotAt: -1e9,
      /**
       * Was the trigger down on the last input we consumed?
       *
       * This is what makes a semi-automatic weapon semi-automatic. The client holds
       * the fire button for as long as the mouse is down and sets the bit on every
       * tick, so "the click ended" is not something it can tell us — exactly the
       * situation jumping is in, and this is `jumpHeld` in shared/movement.js again.
       * Server-side only rather than part of the kinematic state, because fire is not
       * predicted: shots come back as EV.SHOT and the client never simulates one.
       */
      fireHeld: false,
      /**
       * Until when this player cannot be hurt. See C.SPAWN_PROTECT_MS.
       *
       * A deadline rather than a countdown, for the same reason `nextFireAt` is one:
       * nothing has to tick it down, so it cannot drift, and a player who is frozen or
       * idle for a while does not arrive with a stale allowance still in hand.
       *
       * It ends EARLY the moment its owner attacks — see `tryFire`. Without that the
       * protection is not protection but two free seconds of shooting people who can
       * shoot back, and a spawn camper would simply become the invulnerable one.
       */
      protectedUntil: this.now() + C.SPAWN_PROTECT_MS,
      history: [],
      damageBy: new Set(),
      kills: 0,
      deaths: 0,

      team: 0,
      wep: this.defaultWep,
      /** Weapon indices this player may carry, in slot order, and the same set as a
       *  Set for the switch gate. Per player, not per room, because a mode may deal
       *  each player a different hand — see `dealLoadout`. */
      loadout: [],
      allowed: this.allowed,
      // Ammunition per weapon, not per player: switching away from a half-empty
      // magazine and back must not silently refill it.
      ammo: WEAPON_IDS.map((w) => WEAPONS[w].mag ?? 0),
      reloadUntil: 0,
      reloadWep: -1,
      switchUntil: 0,
      /**
       * Until when the weapon in hand is jammed and being cleared by hand.
       *
       * Stored PER WEAPON INDEX rather than as one deadline on the player, because a jam
       * belongs to the gun. Swapping to your pistol has to be a live answer to a jammed
       * rifle — that is the whole counterplay the mechanic creates, and one shared
       * deadline would carry the stoppage across with you and remove it. Coming back to
       * the rifle before the clear is done finds it still jammed, which is the other half
       * of the same rule.
       *
       * A deadline like `nextFireAt` and `protectedUntil`, so nothing ticks it down and
       * it cannot drift.
       */
      jammedUntil: WEAPON_IDS.map(() => 0),
      /** Which weapon has a stoppage whose END has not been acted on yet, or -1. The
       *  falling edge of `jammedUntil` is not otherwise observable — it is a deadline and
       *  nothing ticks it down — and finishJam has to see it exactly once. */
      jamWep: -1,
      /** This player's brain, or null for a human. The only field that distinguishes
       *  the two, and it never leaves the server — `snapshotBase` does not read it. */
      bot: null,
    };
    this.dealLoadout(p);
    this.players.set(id, p);
    this.rosterRev++;
    // Before onJoin, per the note on `isBot` above. A member of this set whose brain is
    // not attached yet is safe: `thinkBots` skips anything without a `bot`, and the gap
    // closes before this method returns.
    if (isBot) this.bots.add(id);
    this.ctl.onJoin(this, p);
    this.events.push({ e: EV.SPAWN, id, x: r3(p.x), y: r3(p.y), z: r3(p.z), yaw: r3(p.yaw) });
    return id;
  }

  /**
   * Decide what this player is carrying, and put the first slot in their hands.
   *
   * A fixed mode grants its whole list, so this is the identity. Deathmatch deals
   * one weapon per slot instead — which is why the whitelist lives on the player
   * rather than on the room, and why it is re-dealt on every respawn.
   */
  dealLoadout(p) {
    const ids = this.mode.randomLoadout ? rollLoadout(this.mode.loadout) : this.mode.loadout;
    p.loadout = ids.map(indexOf);
    p.allowed = new Set(p.loadout);
    p.wep = p.loadout[0] ?? this.defaultWep;
  }

  remove(id) {
    this.players.delete(id);
    this.bots.delete(id);
    this.rosterRev++;
  }

  /**
   * Who is in the room and what they wear, for MSG.ROSTER.
   *
   * Everything here changes a handful of times per career, which is the whole reason it is
   * not in the snapshot: `snapshotBase` runs twenty times a second, and a badge shelf that
   * has not moved since the match started would be re-encoded four hundred times a minute
   * per player to say the same thing. `rosterRev` below is how the host knows when to send
   * this instead of guessing.
   *
   * Bots are in it, unmarked, exactly as people are. See the note at BOT_NAMES.
   */
  rosterState() {
    const players = [];
    for (const p of this.players.values()) {
      const row = { i: p.id, n: p.name };
      // Omit-when-zero, the same economy `sp`, `jm` and `rk` use in the snapshot: a brand
      // new player is `{ i, n }` and nothing else.
      const rk = rankOfXp(progressionXpOf(p));
      if (rk > 0) row.rk = rk;
      const bg = publicTiers(p.badges);
      if (Object.keys(bg).length) row.bg = bg;
      // Static identity belongs here, not in the 20Hz movement snapshot.
      if (p.cosmetics.finish) row.fn = p.cosmetics.finish;
      players.push(row);
    }
    return players;
  }

  /**
   * Seat one AI player.
   *
   * It goes through `add` unchanged — same spawn picker, same dealt loadout, same
   * SPAWN event, same id space. A bot is a player that happens to have a brain
   * attached, not a second kind of entity with its own rules, which is what keeps
   * every mode controller working with bots in the room without knowing they exist.
   */
  addBot(name) {
    // The `true` is what puts this id in `this.bots` early enough for onJoin to see it.
    const id = this.add(name ?? BOT_NAMES[this.bots.size % BOT_NAMES.length], {}, null, true);
    const p = this.players.get(id);
    // Seeded with the id, so each bot moves and aims on its own rhythm rather than
    // the whole room leaning the same way at the same instant.
    p.bot = createBrain(id);
    // And a career, seeded from the id on exactly the argument the brain above is seeded
    // on. Without it every bot in the room is a Private, and since solo-versus-AI is how
    // most of this feature will ever be seen, a working ladder would look like a broken
    // one. Bots hold no account, so nothing here is ever written to disk.
    p.career = botCareer(id);
    p.xp = p.career * XP_PER_LEGACY_KILL;
    // And a shelf, on the same seed. See `botBadges`.
    p.badges = botBadges(id);
    // No ping is invented for AI. Its brain is already in this process, so neither a plausible
    // internet number nor "0ms" describes a route a packet actually travelled. The BOT name
    // prefix identifies it honestly and the scoreboard renders the absent measurement as a dash.
    return id;
  }

  /**
   * Bring the AI population to `want`, adding or dropping as needed.
   *
   * Idempotent, and safe to call every time somebody's request changes — the common
   * case is that the count already matches and nothing happens. Removal takes the
   * newest bots first (`this.bots` is insertion-ordered), so turning the count down
   * mid-match does not delete the bot you are currently fighting.
   */
  setBots(want) {
    const target = Math.max(0, Math.min(C.MAX_BOTS, Math.floor(want) || 0));
    while (this.bots.size < target) this.addBot();
    while (this.bots.size > target) {
      const newest = [...this.bots][this.bots.size - 1];
      this.remove(newest);
    }
    return this.bots.size;
  }

  /**
   * Let every living bot decide what it wants this tick.
   *
   * The result is pushed through `queueInput` like a packet off the network, so it is
   * sanitised, clamped and sequence-checked on the way in. That is the whole security
   * story for bots: there is no path from here into the simulation that a browser does
   * not also have. It runs at the top of `step`, before inputs are drained, so the
   * intent a bot forms this tick is consumed on this tick — queued a tick later, every
   * bot would be reacting to a world one frame stale and aiming permanently behind.
   */
  thinkBots(now) {
    if (!this.bots.size) return;
    for (const id of this.bots) {
      const p = this.players.get(id);
      if (!p?.bot || !p.alive) continue;
      const input = p.bot.think(this, p, now);
      this.queueInput(id, [this.ctl.botInput(this, p, now, input)]);
    }
  }

  queueInput(id, inputs) {
    const p = this.players.get(id);
    if (!p) return;
    for (const raw of inputs) {
      const inp = sanitizeInput(raw, p.yaw, p.wep);
      if (inp.seq <= p.lastSeq) continue; // redundant resend, already applied
      p.inputs.push(inp);
    }
    p.inputs.sort((a, b) => a.seq - b.seq);
    // A client cannot buy itself unlimited future movement by flooding.
    if (p.inputs.length > MAX_QUEUED_INPUTS) {
      p.inputs.splice(0, p.inputs.length - MAX_QUEUED_INPUTS);
    }
  }

  /**
   * Spawn furthest from any living player, with a rotating start so an empty server
   * doesn't hand out the same point every time.
   *
   * `from` narrows the candidates, and narrowing them is the whole of what a base spawn
   * is: a team controller passes its own half of TEAM_SPAWNS and gets the same
   * furthest-from-trouble pick made inside it. Defaulted to every spawn on the map, so
   * free-for-all callers are unaffected.
   *
   * "Furthest from any living PLAYER" stays right for a base too, and deliberately does
   * not become "furthest from any living enemy": inside your own base the other bodies
   * are team-mates, and spreading out from them is what stops five people landing on the
   * same corner — while an enemy who has pushed INTO the base is a living player like any
   * other, so this still puts you down at the far end from them.
   */
  pickSpawn(from = SPAWNS) {
    let best = from[0];
    let bestDist = -1;
    for (let i = 0; i < from.length; i++) {
      const s = from[(i + this.spawnCursor) % from.length];
      let nearest = Infinity;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        nearest = Math.min(nearest, Math.hypot(p.x - s.x, p.z - s.z));
      }
      if (nearest > bestDist) {
        bestDist = nearest;
        best = s;
      }
    }
    this.spawnCursor++;
    return best;
  }

  respawn(p) {
    const spawn = this.ctl.spawnFor(this, p);
    Object.assign(p, createPlayerState(spawn));
    p.hp = C.MAX_HP;
    p.alive = true;
    p.history.length = 0;
    p.damageBy.clear();
    // The same shield the first spawn gets — measured from now, so a respawn into a
    // firefight buys the same two seconds a fresh join does. Ended early by attacking,
    // see tryFire.
    p.protectedUntil = this.now() + C.SPAWN_PROTECT_MS;
    // A new life is a new hand in the modes that deal them, so this comes before the
    // magazines are filled — the weapon you come back holding has to be the weapon
    // whose ammunition is topped up.
    this.dealLoadout(p);
    // Fresh magazines, and no reload or swap left over from before you died.
    for (let i = 0; i < WEAPON_IDS.length; i++) p.ammo[i] = WEAPONS[WEAPON_IDS[i]].mag ?? 0;
    p.reloadUntil = 0;
    p.reloadWep = -1;
    p.switchUntil = 0;
    p.nextFireAt = 0;
    // Every stoppage goes with the corpse. You come back with fresh magazines in clean
    // weapons, and being handed a jam you earned in a previous life is the kind of
    // carry-over nobody would ever read as intentional.
    p.jammedUntil.fill(0);
    p.jamWep = -1;
    // Inputs queued by the previous life go with it, and this line is a fix rather than
    // tidiness. `step` respawns and then consumes, so without it the first thing a fresh
    // body does is act on a tick of intent formed by a corpse — aimed somewhere else,
    // walking somewhere else, and asking for a weapon this hand may no longer be dealt.
    // That last one had a visible symptom: a bot that died holding the sniper came back
    // with a shotgun and the SCOPE STILL UP, because `stepPlayer` read the dead man's
    // `wep` and raised the glass while `applyWeapon` refused the swap — leaving it at
    // 40% speed, unable to sprint, with nothing on screen to explain either.
    p.inputs.length = 0;
    // And the filler has nothing of the corpse's left to repeat either. Without this the
    // first tick of a new life is stepped with the last movement the previous one sent —
    // a fresh body that walks out of its spawn on its own while the player is still
    // watching the death cam.
    p.lastInput = null;
    p.useUntil = 0;
    // `fireHeld` is deliberately NOT cleared. Somebody who died with the button down
    // is still holding it, and a fresh latch would read that as a new click — one free
    // round on respawn from a weapon that is supposed to need a release first.
    this.events.push({ e: EV.SPAWN, id: p.id, x: r3(p.x), y: r3(p.y), z: r3(p.z), yaw: r3(p.yaw) });
  }

  step() {
    const now = this.now();
    this.thinkBots(now);

    for (const p of this.players.values()) {
      if (!p.alive) {
        if (now >= p.respawnAt) this.respawn(p);
        else {
          p.inputs.length = 0;
          continue;
        }
      }

      let consumed = 0;
      while (p.inputs.length && consumed < C.MAX_INPUTS_PER_TICK) {
        const inp = p.inputs.shift();
        if (inp.seq <= p.lastSeq) continue;
        // The loadout narrows the weapon BEFORE the step, not only after it. `applyWeapon`
        // below is the authority on a swap and refuses one this player is not dealt — but
        // `stepPlayer` reads `inp.wep` too, to decide whether a scope may be up at all, so
        // an unnarrowed intent lets the two disagree: the room keeps the shotgun and the
        // simulation raises a sniper's glass over it. One weapon per tick, decided here.
        if (!p.allowed.has(inp.wep)) inp.wep = p.wep;
        stepPlayer(p, inp, C.TICK_DT, WORLD_BOXES);
        p.lastSeq = inp.seq;
        p.lastInput = inp;
        // Renewed by real inputs only. The starvation filler deliberately cannot hold an
        // objective key down forever after a browser stops sending packets.
        p.useUntil = (inp.buttons & C.BTN_USE) !== 0 ? now + 100 : 0;
        consumed++;

        this.applyWeapon(p, inp, now);
        // Edge-triggered fire. The latch is updated here, inside the loop that
        // consumes real inputs, and never by the starvation filler below — the filler
        // masks BTN_FIRE off (see FILLER_BUTTONS), so if it also cleared the latch a
        // player whose packets stalled for one tick would come back holding the button
        // and get a free round out of a semi-automatic weapon. Not clearing it means a
        // stall costs nothing and buys nothing, which is the correct answer for both.
        const fire = (inp.buttons & C.BTN_FIRE) !== 0;
        if (fire) this.tryFire(p, inp, now);
        p.fireHeld = fire;
      }

      // Input starvation: repeat the last known intent so a player whose packets
      // stalled keeps falling and settling rather than freezing mid-air. Only the
      // movement buttons carry over — see FILLER_BUTTONS for why jump is one of
      // them and fire is not.
      if (consumed === 0) {
        // `wep` and `sc` come from the SERVER's own state, never from the stale input, and
        // that is a fix rather than pedantry. A filler is a repeat of somebody's movement,
        // not a repeat of their assertions: `stepPlayer` reads `wep` to decide whether a
        // scope may be up at all, so carrying a dead man's `wep: sniper, sc: 1` through a
        // respawn raised the glass over the rifle the fresh hand was actually dealt — 40%
        // speed, no sprint, and nothing on screen to explain either. Restating what the
        // player is holding also keeps a genuine stall honest in the other direction: a
        // scope that is up stays up and keeps settling, exactly as it would have with the
        // packets arriving, and one that is down cannot come up while nobody is asking.
        const filler = p.lastInput
          ? { ...p.lastInput, buttons: p.lastInput.buttons & FILLER_BUTTONS }
          : { moveX: 0, moveZ: 0, yaw: p.yaw, pitch: p.pitch, buttons: 0 };
        // Kept even though `respawn` now empties the queue and drops `lastInput` too, which
        // closes the same hole from the other end: with those two off, THESE two lines still
        // hold the glass down on a respawn on their own. The filler is the one step in the
        // tick that never reaches `applyWeapon`, so it restates authority itself.
        filler.wep = p.wep;
        filler.sc = p.scope ?? 0;
        stepPlayer(p, filler, C.TICK_DT, WORLD_BOXES);
      }

      // Reloads finish on the clock, not on an input, or a player who stops
      // sending packets mid-reload would never get their magazine back.
      this.finishReload(p, now);
      // Then the stoppage, which can start the reload above on the tick it ends.
      this.finishJam(p, now);

      // `cr` rides along because the rewind measures a BODY, not a point: hitscan.js
      // sizes the box it tests with `halfOf`, and a player who ducked after being shot
      // at would otherwise be measured at their old place with their new height — a
      // shot that cleared their head connecting with a body that was never there.
      // Unrounded, unlike the snapshot's `cr`: this never leaves the server, and the
      // rewind interpolates between consecutive samples 16.7ms apart.
      p.history.push({ t: now, x: p.x, y: p.y, z: p.z, cr: p.crouch });
      const cutoff = now - C.HISTORY_MS;
      while (p.history.length && p.history[0].t < cutoff) p.history.shift();
    }

    this.stepProjectiles(now);
    this.expireClouds(now);
    this.ctl.tick(this);
    this.tick++;
  }

  /** Drop smoke clouds whose time is up. Cheap enough to run unconditionally, and
   *  there are never more than a handful. */
  expireClouds(now) {
    if (!this.clouds.length) return;
    this.clouds = this.clouds.filter((c) => now < c.until);
  }

  /**
   * Advance every live projectile, then resolve whatever finished this tick.
   *
   * Player collision is checked here rather than in shared/projectile.js because it
   * needs the player list and the mode's friendly-fire rule. A projectile ignores its
   * own thrower for a moment after release, or a snowball detonates inside the hand
   * that threw it.
   */
  stepProjectiles(now) {
    if (!this.projectiles.length) return;

    const kept = [];
    for (const pr of this.projectiles) {
      stepProjectile(pr, C.TICK_DT, WORLD_BOXES, now);

      const cfg = PROJECTILES[pr.kind];
      // Utility passes through people. `hitsPlayers` false skips the body test outright
      // rather than testing and doing nothing: a flashbang that stops dead on the first
      // body in its path is one you cannot throw over a team-mate's shoulder, which is
      // most of the throws anybody wants to make with one.
      if (!pr.done && cfg.hitsPlayers) {
        const settled = now - pr.bornAt > 90; // grace period for the thrower
        for (const v of this.players.values()) {
          if (!v.alive) continue;
          if (v.id === pr.owner && !settled) continue;
          if (!hitsBody(pr, v)) continue;
          const owner = this.players.get(pr.owner);
          // A direct hit stops the projectile whether or not it may damage this
          // player — a snowball does not pass through a team-mate.
          pr.done = true;
          pr.impact = true;
          if (owner && !this.ctl.canDamage(this, owner, v)) break;
          if (!cfg.blast) this.applyDamage(owner, v, cfg.dmg, pr.owner === v.id ? -1 : indexOf(pr.kind));
          break;
        }
      }

      if (pr.done) this.resolveProjectile(pr, now);
      else kept.push(pr);
    }
    this.projectiles = kept;
  }

  /** Emit the burst and then do whatever this projectile does: blast damage, a blind,
   *  or leave a cloud behind. */
  resolveProjectile(pr, now) {
    const cfg = PROJECTILES[pr.kind];
    const ev = {
      e: EV.BURST,
      k: pr.kind,
      x: r3(pr.x),
      y: r3(pr.y),
      z: r3(pr.z),
    };
    // Cosmetic detail for the effect, both omitted when they carry nothing:
    //   n — the surface it broke against, so snow sprays out of the wall.
    //   d — it ended on a body rather than on the world, which reads differently.
    if (pr.nx || pr.ny || pr.nz) ev.n = [r3(pr.nx), r3(pr.ny), r3(pr.nz)];
    if (pr.impact) ev.d = 1;
    this.events.push(ev);

    if (cfg.effect === 'blind') {
      this.applyFlash(pr, cfg, now);
      return;
    }
    if (cfg.effect === 'cloud') {
      this.clouds.push({
        id: this.nextCloudId++,
        x: pr.x,
        // Lifted off the ground by most of its own radius, so the cloud is a ball
        // sitting on the floor rather than one buried halfway into it — a smoke you
        // can see over is a smoke that screens nothing.
        y: pr.y + cfg.cloudRadius * 0.6,
        z: pr.z,
        r: cfg.cloudRadius,
        until: now + cfg.cloudMs,
      });
      return;
    }
    if (!cfg.blast) return;

    const owner = this.players.get(pr.owner);
    for (const v of this.players.values()) {
      if (!v.alive) continue;
      // Self-damage is deliberate: it is the only thing that stops a grenade being
      // free to throw at your own feet. Friendly fire still goes through the gate.
      if (v.id !== pr.owner && !(owner && this.ctl.canDamage(this, owner, v))) continue;
      const dist = Math.hypot(pr.x - v.x, pr.y - v.y, pr.z - v.z);
      const dmg = blastDamage(pr.kind, dist);
      if (dmg <= 0) continue;
      // Line of sight, so a grenade on the far side of a wall does not kill through
      // it. Measured to the body centre, which is generous at the edges and exactly
      // what a blast should be.
      const dx = v.x - pr.x;
      const dy = v.y - pr.y;
      const dz = v.z - pr.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      if (rayWorld(pr.x, pr.y, pr.z, dx / len, dy / len, dz / len, WORLD_BOXES, len) < len - 0.05) {
        continue;
      }
      this.applyDamage(owner, v, dmg, indexOf(pr.kind));
    }
  }

  /**
   * Blind everyone who could actually see the bang.
   *
   * Three things scale the duration, and all three have to be decided here rather than
   * on each client: distance, line of sight, and how far off the centre of your view it
   * went off. That last one is the counterplay — turning away from a flash is the entire
   * skill of playing against one — and it only exists if where you were looking is what
   * decides how long you are blind for. A client asked to work out its own blindness
   * would work out zero.
   *
   * No friendly-fire gate and no exception for the thrower. A flashbang blinds whoever
   * is looking at it, and "I flashed my own team" is a mistake the game should let you
   * make, not one it should quietly undo.
   */
  applyFlash(pr, cfg, now) {
    for (const v of this.players.values()) {
      if (!v.alive) continue;
      const ex = pr.x - v.x;
      const ey = pr.y - eyeY(v);
      const ez = pr.z - v.z;
      const dist = Math.hypot(ex, ey, ez) || 1e-4;
      if (dist >= cfg.blindRange) continue;

      // Through a wall is not blinded at all — same ray test the blast radius uses,
      // run from the eye because it is the eye that has to see the light.
      const nx = ex / dist;
      const ny = ey / dist;
      const nz = ez / dist;
      if (rayWorld(v.x, eyeY(v), v.z, nx, ny, nz, WORLD_BOXES, dist) < dist - 0.05) continue;

      // cos of the angle between where they are looking and where the flash is. At or
      // behind 90° the bang is a noise rather than a light, which is what makes looking
      // away work. Squared so the falloff is sharp: it should matter whether you turned
      // properly or only flinched.
      const d = aimDir(v.yaw, v.pitch);
      const facing = (d.x * nx + d.y * ny + d.z * nz);
      if (facing <= 0) continue;

      const ms = Math.round(cfg.blindMs * (1 - dist / cfg.blindRange) * facing * facing);
      // Below this a blind is a flicker that reads as a rendering glitch rather than as
      // something that happened to you, so it is not worth an event.
      if (ms < 130) continue;
      this.events.push({ e: EV.BLIND, on: v.id, by: pr.owner, ms });
    }
  }

  /**
   * One place where hit points come off, so hitscan, blast and direct impacts all
   * score, emit and die the same way. `wep` is the weapon index to credit, or -1 for
   * damage nobody gets credit for.
   *
   * `zone` is cosmetic and only hitscan passes one — the damage has already been scaled
   * by it upstream in `shotDamage`, and a blast has no zone to speak of. It is here so
   * the shooter's hitmarker can say which one it was, and defaults to BODY so the three
   * projectile call sites need no change.
   */
  applyDamage(attacker, v, dmg, wep, zone = HIT_ZONE.BODY) {
    // Spawn protection. Checked here rather than at each of the four call sites — a
    // bullet, a shotgun's eight pellets, a blast and a direct projectile hit all arrive
    // through this one door, and a shield with four gates is a shield with a hole.
    //
    // Self-damage is exempt on purpose: `attacker === v` is your own grenade, and a
    // player who is invulnerable to their own blast can spawn, drop a grenade at their
    // feet and walk out of it. Falling out of the world comes through with no attacker
    // at all and must also still kill, or a protected player who clips out is stuck.
    if (attacker && attacker !== v && this.now() < v.protectedUntil) return;

    if (attacker && attacker !== v) v.damageBy.add(attacker.id);
    v.hp -= dmg;
    const hit = { e: EV.HIT, by: attacker?.id ?? 0, on: v.id, hp: Math.max(0, v.hp) };
    // Omitted for BODY, which is both the common case and HIT_ZONE.BODY's own value, so
    // a client that has never heard of zones reads exactly what it read before.
    if (zone) hit.z = zone;
    this.events.push(hit);
    if (v.hp > 0) return;

    v.hp = 0;
    v.alive = false;
    const kill = { e: EV.KILL, by: attacker?.id ?? 0, on: v.id, w: wep };
    // The zone, on the same omit-when-zero terms as the HIT above. Public, unlike the
    // career counts below: a headshot kill is a thing every shooter in the genre shows the
    // whole server, and the killfeed is where it goes. Without it the one hit that actually
    // decided the fight is the only one the feed says nothing about.
    if (zone) kill.z = zone;
    this.events.push(kill);
    if (v.account) v.match.deaths++;

    // Match XP distinguishes people from AI using the Room's own bot set. The browser
    // never reports either count, so changing a name to or from "BOT" cannot affect XP.
    if (attacker && attacker !== v && attacker.account) {
      const botVictim = this.bots.has(v.id);
      if (botVictim) {
        attacker.match.botKills++;
        if (zone === HIT_ZONE.HEAD) attacker.match.botHeadshots++;
      } else {
        attacker.match.humanKills++;
        if (zone === HIT_ZONE.HEAD) attacker.match.humanHeadshots++;
      }
    }

    // Anyone who damaged a human victim during this life shares assist credit, except
    // the killer. Bot takedowns do not mint assists, keeping AI farming inside one cap.
    if (!this.bots.has(v.id)) {
      for (const helperId of v.damageBy) {
        if (helperId === attacker?.id) continue;
        const helper = this.players.get(helperId);
        if (helper?.account) helper.match.assists++;
      }
    }
    v.damageBy.clear();
    // Career credit, here and not in a mode controller. `p.kills` is the SCOREBOARD
    // count and ffa.js's reset() clears it every match, so it is the wrong number to
    // persist; and modes/index.js defaults `onKill` to a no-op, so a mode added later
    // that forgets to implement it would silently stop counting a career while still
    // reporting kills. This line is on the path every kill in the game takes.
    //
    // Same two exemptions the damage guard above uses, for the same reason: `attacker
    // === v` is your own grenade and no attacker at all is falling out of the world.
    // Neither is a kill you earned. An account being present is what keeps bots — who
    // have one seeded rank and no ledger — out of the store entirely.
    if (attacker && attacker !== v && attacker.account) {
      attacker.career++;
      // Which tracks a kill is worth is `tracksFor`'s call, not this file's, so the server
      // that increments and the client that reads cannot come to disagree about it.
      //
      // Not `idAt(wep)`, which falls back to 'rifle' for an out-of-range index — that is
      // the right default for a viewmodel and the wrong one for a ledger, because it would
      // file a kill credited to no weapon under a weapon the player may not even be
      // holding. An empty string names nothing and earns the total only.
      // The TIER before and after, per track, because MSG.ROSTER carries tiers and a kill
      // that moved a count without moving an emblem must not cost the room a push. The rank
      // is the same question one line up: `rankOf` moves on a couple of dozen kills out of
      // a whole career, so comparing is cheap and pushing on every kill is not.
      let moved = !Number.isFinite(attacker.xp)
        && rankOfXp(attacker.career * XP_PER_LEGACY_KILL)
          !== rankOfXp((attacker.career - 1) * XP_PER_LEGACY_KILL);
      for (const key of tracksFor(wep >= 0 ? idAt(wep) : '', zone)) {
        const was = tierOf(attacker.badges[key] ?? 0, key);
        attacker.badges[key] = (attacker.badges[key] ?? 0) + 1;
        if (tierOf(attacker.badges[key], key) !== was) moved = true;
      }
      if (moved) this.rosterRev++;
      this.onCareer?.(attacker.account, attacker.career, attacker.badges);
    }
    this.ctl.onKill(this, attacker ?? null, v);
  }

  /** Weapon selection and reload intent, both carried in the ordinary input. */
  applyWeapon(p, inp, now) {
    if (inp.wep !== p.wep && p.allowed.has(inp.wep)) {
      p.wep = inp.wep;
      // The INCOMING weapon's deploy time, not the outgoing one's: what costs you the
      // time is bringing the new thing up and making it ready, and a player who reads
      // "swapping to the machine gun is slow" has learned something true.
      p.switchUntil = now + switchMsOf(idAt(p.wep));
      // Swapping cancels a reload rather than completing it in the background —
      // otherwise a quick-swap is a strictly faster reload than reloading.
      p.reloadUntil = 0;
      p.reloadWep = -1;
    }
    if (inp.buttons & C.BTN_RELOAD) this.beginReload(p, now);
  }

  beginReload(p, now) {
    const w = weaponAt(p.wep);
    if (w.mag === null) return; // nothing to reload
    if (p.ammo[p.wep] >= w.mag) return; // already full
    if (p.reloadUntil > now) return; // already reloading
    if (p.switchUntil > now) return; // still drawing the weapon
    // You cannot feed a magazine into a gun with a case stuck in it, and more to the
    // point: a stoppage is supposed to have exactly two answers, and this was a third.
    //
    // The two are named in JAM_CLEAR_MS and SWITCH_MS — wait it out, or draw something
    // else (every deploy time is under the stoppage, which is deliberate). Reload was
    // never meant to be one, and it was the best of the three: the pistol's 1200ms
    // magazine change is SHORTER than the 1400ms stoppage it cancelled, so pressing R
    // beat clearing the jam outright. finishReload's own comment asserted the opposite.
    //
    // It also decided what you saw. `reloadP` outranks `jamP` in the viewmodel's pose
    // ladder, so pressing R on a dead trigger replaced the clearing punch with the
    // reload's gun-down animation — the same "i cant see it punching the gun" that punch
    // was rewritten to fix, re-entered through the one input that skipped it.
    if (p.jammedUntil[p.wep] > now) return;
    p.reloadUntil = now + w.reloadMs;
    p.reloadWep = p.wep;
  }

  /**
   * Notice a stoppage ending, and pick up the auto-reload it was holding off.
   *
   * Only here for one case, and it is the case the gate above would otherwise break: the
   * round that empties the magazine is also a round that can jam, and the jam is rolled
   * BEFORE the dry-fire auto-reload runs — it has to be, because a jam costs you the next
   * round and not this one. So the gate eats that reload, and the promise attached to it
   * — "you are not left holding an empty weapon until you think to press R" — would hold
   * for every magazine except the one that jammed on its last round.
   *
   * On the clock rather than on an input, like finishReload and for the same reason.
   * The weapon check is not paranoia: stoppages are per-weapon deadlines that keep
   * running while you hold something else, so this fires for a rifle you are not holding,
   * and reloading that behind your back is exactly what swapping is supposed to cancel.
   */
  finishJam(p, now) {
    const wep = p.jamWep;
    if (wep < 0 || p.jammedUntil[wep] > now) return;
    p.jamWep = -1;
    if (wep !== p.wep) return;
    const w = weaponAt(wep);
    if (w.mag !== null && p.ammo[wep] === 0) this.beginReload(p, now);
  }

  finishReload(p, now) {
    if (!p.reloadUntil || now < p.reloadUntil) return;
    const w = weaponAt(p.reloadWep);
    if (w.mag !== null) p.ammo[p.reloadWep] = w.mag;
    // A fresh magazine clears a stoppage in the weapon that took it. Unreachable now that
    // beginReload refuses to start while jammed — a jam needs a shot, a shot needs the
    // reload finished, so the two cannot overlap — and kept as the guard on that rather
    // than as the mechanism. If a later change ever does let the two overlap, the failure
    // this stops is finishing a 4.7-second belt change and finding the gun still jammed,
    // which nobody would read as the reload having worked.
    //
    // This comment used to claim reloads were unblocked and all longer than JAM_CLEAR_MS.
    // The second half was false — the pistol's is 1200 against a 1400ms stoppage — and
    // the two halves together were what made pressing R the cheapest way out of a jam.
    p.jammedUntil[p.reloadWep] = 0;
    p.reloadUntil = 0;
    p.reloadWep = -1;
  }

  /**
   * @param inp the input that pulled the trigger. Needed because right-click is a
   *            per-weapon modifier (`alt` in shared/weapons.js): it selects a whole
   *            different attack on the knife, and for throwables it changes the
   *            release arc — neither of which the client may decide.
   */
  tryFire(p, inp, now) {
    if (p.switchUntil > now) return;
    if (p.reloadUntil > now) return;
    // A jammed weapon does not fire, full stop. Ahead of the automatic/semi latch and
    // the cadence gate on purpose: those two decide *when* the next round is allowed,
    // and this decides that there is not going to be one until the hands have fixed it.
    if (p.jammedUntil[p.wep] > now) return;

    const id = idAt(p.wep);
    // One round per click on anything that is not automatic — the pistol, the semi,
    // the shotgun, the sniper and the knife. `fireHeld` is the trigger's state on the
    // previous input, so this rejects every tick of a hold after the first and lets the
    // next press through the moment the button has been off for one tick.
    //
    // It has to be here rather than on the client. The client sets BTN_FIRE for as long
    // as the mouse is down because that is what the button *is*; asking it to send one
    // tick's worth per click would make "how fast does a pistol fire" a client-side
    // decision, and an edited client would answer "as fast as I like".
    if (!isAuto(id) && p.fireHeld) return;

    // Right-click on a heavy-attack weapon is a separate attack with its own damage,
    // reach and cadence. `shotStats` returns one merged weapon entry, so the gate
    // below, `resolveShot` and the damage all read a single consistent set of numbers
    // and nothing downstream has to remember a modifier was held.
    const heavy = hasHeavy(id) && !!(inp.buttons & C.BTN_ALT);
    const w = shotStats(id, heavy);

    // Gated on when the next attack is allowed rather than on how long ago the last
    // one happened, because the two attacks have different intervals. Measuring
    // backwards against the *current* button's interval would let a heavy stab
    // (1000 ms) be followed by a light slash 480 ms later — the heavy attack's damage
    // at the light attack's rate, for free.
    if (now < p.nextFireAt) return;

    if (w.mag !== null && p.ammo[p.wep] <= 0) {
      this.beginReload(p, now);
      return;
    }

    p.nextFireAt = now + w.intervalMs;
    // Loud enough to give your position away. See `lastShotAt` — this is the only write.
    if (w.kind !== 'melee') p.lastShotAt = now;
    if (w.mag !== null) p.ammo[p.wep]--;
    // Attacking gives up the spawn shield, and it is dropped HERE — past every gate, at
    // the point a round is definitely leaving the barrel. Dropping it on the button
    // instead would take it away for a click that hit an empty magazine or a swap still
    // in progress, which is punishing a player for a shot they did not get to fire.
    //
    // Without this the shield is strictly better than no shield for the aggressor: two
    // seconds of shooting people who cannot shoot back is exactly the spawn camping it
    // was added to stop, only now the camper is the one who cannot be killed.
    p.protectedUntil = 0;

    // Did the action fail to cycle behind that round? Rolled here, after the shot is
    // paid for and committed, so a jam costs you the NEXT round rather than this one —
    // see the `jam` notes in shared/weapons.js. Nothing but a gun has a chance above
    // zero, so the knife and the throwables fall through this without a special case.
    //
    // The event is pushed before the shot's own, which is the order they happen in: the
    // round goes, then the case sticks. The client hears both on the same snapshot and
    // plays the shot, then the clearing punch.
    const jamChance = jamChanceOf(id);
    if (jamChance > 0 && this.rand() < jamChance) {
      p.jammedUntil[p.wep] = now + JAM_CLEAR_MS;
      p.jamWep = p.wep;
      this.events.push({ e: EV.JAM, id: p.id, ms: JAM_CLEAR_MS });
    }

    if (w.kind === 'projectile') {
      // Only a weapon whose alt IS a lob may be lobbed. Reading the button alone
      // would give every future throwable an underhand nobody designed for it.
      this.throwProjectile(p, w, now, w.alt === 'lob' && !!(inp.buttons & C.BTN_ALT));
      if (w.mag !== null && p.ammo[p.wep] === 0) this.beginReload(p, now);
      return;
    }

    // Traces this pull of the trigger puts in the air. One for every weapon but the
    // shotgun, which fires eight through the same cone from the same eye. They have to
    // be independent traces rather than one trace doing eight times the damage: the
    // whole point of a shotgun is that the pellets diverge, so at 25u some of them
    // reach the target and some do not, and the falloff is geometry rather than a curve.
    const pellets = pelletsOf(id);
    const canDamage = (atk, vic) => this.ctl.canDamage(this, atk, vic);

    // "while pistol you just sprint while shooting." The cone was the weapon's number
    // and nothing else, so a full sprint was free accuracy and standing still bought
    // nothing. `spreadMul` reads the body that is holding the gun — see the multiplier
    // table in shared/weapons.js — and a still, standing player still gets exactly 1,
    // so nothing about aimed fire has changed.
    //
    // Server-side, from the server's own velocity, because it is the whole point: this
    // is a shot the client does not get to make more accurate than the movement it
    // reported. The client computes the same number from its predicted state purely to
    // size the crosshair.
    //
    // The weapon id goes in as well, and that is the scope: `spreadMul` reads `p.scope`
    // and `p.scopeMs` off the same body and multiplies the cone by up to forty for a shot
    // taken from the hip or a fifth of a second too early. It is the same argument this
    // whole call makes about velocity, applied to the one piece of state that used to
    // never leave the browser at all — a no-scope is now a shot the client cannot make
    // accurate by not telling us about it.
    const sm = spreadMul(p, id);
    const aim = sm === 1 ? w : { ...w, spread: (w.spread ?? 0) * sm };

    // Rewind everyone to the frame this shooter was actually looking at. 0 for a bot,
    // and 0 is the old behaviour — see `rewindTimeFor`.
    const at = rewindTimeFor(inp.vt, now);

    const first = resolveShot(p, this.players.values(), aim, canDamage, at);
    const ev = {
      e: EV.SHOT,
      id: p.id,
      w: p.wep, // the client picks tracer, sound and muzzle flash from this
      x: r3(first.point.x),
      y: r3(first.point.y),
      z: r3(first.point.z),
    };
    // Both fields are omitted when zero, which is the common case: one SHOT goes out
    // for every round every player in the room fires.
    //
    // `h` is what the shot stopped on, so the client can mark the surface — a shot
    // that reached its full range without meeting anything must leave nothing behind.
    if (first.on) ev.h = first.on;
    // `a` is which attack it was. The animation has to come from here rather than
    // from the local mouse: the button can change between sending the input and the
    // shot resolving, and the swing shown must be the swing that was paid for.
    if (heavy) ev.a = 1;

    // Damage is tallied per victim and applied once, not applied per pellet. Two
    // reasons, both about not lying: one blast should raise one hitmarker and one HIT
    // event rather than eight; and a target killed by the third pellet must not have
    // the other five land on a corpse, which would emit five more HITs and hand the
    // kill to whichever pellet happened to be last.
    //
    // The tally carries a zone as well as a total, and keeps the BEST one the target
    // ate rather than the last: eight pellets can land in three different places, and
    // the honest thing to tell a player who put a pellet through someone's head is that
    // they put a pellet through someone's head. `HIT_ZONE_MUL` is the ordering, so a
    // zone added later sorts itself.
    const tally = new Map();
    const score = (shot) => {
      if (!shot.victim) return;
      // Distance and zone, not a flat `w.dmg`. Every pellet is scored on its own flight
      // and its own landing spot, which is what makes a shotgun's spread a damage curve
      // rather than a hit-or-miss.
      const dmg = shotDamage(w, shot.dist, shot.zone);
      const prev = tally.get(shot.victim);
      if (!prev) {
        tally.set(shot.victim, { dmg, zone: shot.zone });
        return;
      }
      prev.dmg += dmg;
      if (HIT_ZONE_MUL[shot.zone] > HIT_ZONE_MUL[prev.zone]) prev.zone = shot.zone;
    };
    score(first);

    if (pellets > 1) {
      // The remaining endpoints ride along on the same event, so the client draws one
      // blast with eight tracers instead of receiving eight separate shots from the
      // same player on the same tick. Omitted entirely for everything else.
      ev.p = [];
      for (let i = 1; i < pellets; i++) {
        const s = resolveShot(p, this.players.values(), aim, canDamage, at);
        score(s);
        const pt = [r3(s.point.x), r3(s.point.y), r3(s.point.z)];
        if (s.on) pt.push(s.on);
        ev.p.push(pt);
      }
    }
    this.events.push(ev);

    // Dry-firing the last round still triggers the reload, so you are not left
    // holding an empty weapon until you think to press R.
    if (w.mag !== null && p.ammo[p.wep] === 0) this.beginReload(p, now);

    for (const [victim, hit] of tally) this.applyDamage(p, victim, hit.dmg, p.wep, hit.zone);
  }

  /** Release a thrown weapon along the player's view direction. */
  throwProjectile(p, w, now, lob = false) {
    const cp = Math.cos(p.pitch);
    const dir = {
      x: -Math.sin(p.yaw) * cp,
      y: Math.sin(p.pitch),
      z: -Math.cos(p.yaw) * cp,
    };
    // Released from the eye, pushed forward past the player's own body box so the
    // first step cannot start it inside its thrower. eyeY, not the standing constant:
    // a crouched player throws from where their head actually is, or the grenade
    // spawns above the cover they are ducking behind.
    const off = C.PLAYER_HALF_W + 0.2;
    const pr = createProjectile(
      w.proj,
      p.id,
      p.x + dir.x * off,
      eyeY(p) + dir.y * off,
      p.z + dir.z * off,
      dir,
      now,
      lob,
    );
    this.projectiles.push(pr);
    // Still a SHOT: it drives the throw animation and the sound. The client skips the
    // tracer for non-hitscan weapons, and the projectile itself is in the snapshot.
    this.events.push({ e: EV.SHOT, id: p.id, w: p.wep, x: r3(pr.x), y: r3(pr.y), z: r3(pr.z) });
  }

  /** Future objective modes call this server-side; no client message can award itself XP. */
  creditObjective(id, count = 1) {
    const p = this.players.get(id);
    if (!p?.account || p.match.settled) return;
    p.match.objectives += Math.max(0, Math.floor(Number(count) || 0));
  }

  /**
   * Close the current XP ledger exactly once and attach a private receipt to each person.
   * Controllers supply only the winner that they already decided authoritatively.
   */
  settleMatch({ winnerId = 0, winnerTeam = 0 } = {}) {
    const now = this.now();
    for (const p of this.players.values()) {
      if (!p.account || p.match.settled) continue;
      p.match.settled = true;
      const combat = p.match.humanKills + p.match.botKills + p.match.assists
        + p.match.objectives + p.match.deaths;
      const participated = combat > 0
        || now - p.match.joinedAt >= XP_RULES.minParticipationSec * 1000;
      const won = winnerTeam > 0 ? p.team === winnerTeam : winnerId > 0 && p.id === winnerId;
      const award = matchXp({ ...p.match, participated, won });
      const before = progressionXpOf(p);
      const rankBefore = rankOfXp(before);
      p.xp = before + award.total;
      const rankAfter = rankOfXp(p.xp);

      const stats = cleanStats(p.accountStats);
      if (participated) {
        stats.matches++;
        if (won) stats.wins++;
        stats.kills += p.match.humanKills + p.match.botKills;
        stats.deaths += p.match.deaths;
        stats.headshots += p.match.humanHeadshots + p.match.botHeadshots;
        stats.humanKills += p.match.humanKills;
        stats.botKills += p.match.botKills;
        stats.assists += p.match.assists;
        stats.objectives += p.match.objectives;
      }
      p.accountStats = stats;
      const result = {
        id: `${this.modeId}-${this.matchEpoch}-${this.matchNo}`,
        mode: this.modeId,
        participated,
        won,
        before,
        after: p.xp,
        rankBefore,
        rankAfter,
        award,
        match: {
          kills: p.match.humanKills + p.match.botKills,
          deaths: p.match.deaths,
          headshots: p.match.humanHeadshots + p.match.botHeadshots,
          humanKills: p.match.humanKills,
          botKills: p.match.botKills,
          assists: p.match.assists,
          objectives: p.match.objectives,
        },
        stats: { ...stats },
      };
      result.creditAward = matchCredits(result);
      p.pendingResult = result;
      if (rankAfter !== rankBefore) this.rosterRev++;
      try {
        this.onMatch?.(p.account, {
          xp: p.xp,
          career: p.career,
          badges: p.badges,
          stats,
          result,
        })?.catch?.(() => {});
      } catch { /* Progress persistence must never stop a live match from resetting. */ }
    }
  }

  /** Start the next controller round with a fresh per-match ledger, not fresh careers. */
  beginProgressionMatch() {
    this.matchNo++;
    for (const p of this.players.values()) {
      p.match = {
        joinedAt: this.now(),
        humanKills: 0,
        botKills: 0,
        humanHeadshots: 0,
        botHeadshots: 0,
        assists: 0,
        objectives: 0,
        deaths: 0,
        settled: false,
      };
      p.pendingResult = null;
    }
  }

  /** Snapshot body shared by all recipients; `ack` and `self` are stamped per
   *  client in server/index.js. */
  snapshotBase() {
    const players = [];
    for (const p of this.players.values()) {
      const player = {
        id: p.id,
        n: p.name,
        x: r3(p.x),
        y: r3(p.y),
        z: r3(p.z),
        yaw: r3(p.yaw),
        pitch: r3(p.pitch),
        hp: p.hp,
        a: p.alive ? 1 : 0,
        k: p.kills,
        d: p.deaths,
        w: p.wep,
        tm: p.team,
        // Crouch. On the wire because it changes a player's height, which decides
        // both what the avatar looks like and what a bullet can reach — a client
        // that guessed at it would draw a standing body the server treats as ducked.
        cr: r3(p.crouch),
      };
      // Spawn protection, as milliseconds still to run. Omitted the moment it lapses,
      // which is almost always — it is two seconds out of a whole life.
      //
      // Sent as a REMAINING duration rather than as the deadline it is stored as,
      // because the client has no way to convert one: `protectedUntil` is on the
      // server's tick clock and `performance.now()` is not, so a deadline would have to
      // be rebased and would be wrong by however far the two clocks sat apart. A
      // duration means the same thing on both sides of the wire.
      const shield = p.protectedUntil - this.now();
      if (p.alive && shield > 0) player.sp = Math.round(shield);
      // Jam on the weapon in hand, same duration-not-deadline rule, same omit-when-zero
      // rule. Public rather than private to its owner on purpose: the whole point of a
      // stoppage is that the other player can see it and push. `EV.JAM` gives them the
      // sound at the instant it happens; this gives the body something to do for the
      // JAM_CLEAR_MS after, and drives the off-hand punch on the remote avatar.
      const jam = p.jammedUntil[p.wep] - this.now();
      if (p.alive && jam > 0) player.jm = Math.round(jam);
      // Career rank, as a tier index. Same omit-when-zero rule as `sp` and `jm` above,
      // and it earns it more than either: tier 0 is where every new account and most bots
      // sit, so the common case costs nothing on a 20Hz broadcast.
      //
      // The INDEX and not the kill count. A count is a career ledger, and this is a
      // public snapshot — a player's total is theirs, while the badge over their head is
      // what the fight needs. It is also why interp.js needs no change: `{ ...pb }` copies
      // a discrete field through untouched, and snapping a value that moves a handful of
      // times per career at 20Hz is exactly right.
      const rk = rankOfXp(progressionXpOf(p));
      if (rk > 0) player.rk = rk;
      // Round-trip milliseconds, and the ONE roster-ish field that belongs in the snapshot
      // rather than in MSG.ROSTER: a ping is a live reading. It moves every second, a
      // scoreboard held open watches it move, and a value pushed on joins alone would be
      // frozen at whatever it was when the last person walked in.
      //
      // Whole milliseconds, no r3(): tenths of a millisecond of round trip is not a number
      // anybody reads, and a float here only invites somebody to average it later.
      //
      // Bots have no network route to measure: their brain runs in this Room. Leave `pg` off
      // rather than inventing an internet number for them or claiming a misleading 0ms.
      const pg = Math.round(p.bot ? 0 : p.ping);
      if (pg > 0) player.pg = pg;
      players.push(player);
    }
    // `proj` is omitted entirely when nothing is in the air, which is the common
    // case — an empty array on every snapshot is pure overhead.
    const snap = { t: MSG.SNAPSHOT, tick: this.tick, players, md: this.ctl.state() };
    if (this.projectiles.length) {
      snap.proj = this.projectiles.map((pr) => ({
        i: pr.id,
        k: pr.kind,
        x: r3(pr.x),
        y: r3(pr.y),
        z: r3(pr.z),
      }));
    }
    // Smoke, same deal — and it is in the snapshot rather than in a one-off event
    // because a client that joins or reconnects mid-cloud has to learn about it. An
    // event would only ever reach whoever was already connected when it landed.
    if (this.clouds.length) {
      snap.sm = this.clouds.map((c) => ({
        i: c.id,
        x: r3(c.x),
        y: r3(c.y),
        z: r3(c.z),
        r: r3(c.r),
      }));
    }
    return snap;
  }

  drainEvents() {
    const ev = this.events;
    this.events = [];
    return ev;
  }
}
