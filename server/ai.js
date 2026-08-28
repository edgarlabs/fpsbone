// Bot brains. One per AI player, asked for exactly one input per simulation tick.
//
// The whole design is in the return type: `think` hands back the same object shape a
// browser sends, and Room feeds it through `queueInput` — so it goes through
// `sanitizeInput`, gets a sequence number, gets clamped, and is consumed by the same
// loop as a human's. A bot has no privileged path into the simulation. It cannot
// teleport, fire faster than its weapon allows, or hold a weapon the mode did not
// deal it, because none of those are decisions this file gets to make.
//
// There is no navmesh and no pathfinding. A bot walks at a waypoint, and when
// walking straight at it stops working — which is what cover is for — it notices it
// has stopped moving and picks another. That is cheap and on a 64-unit arena of convex
// boxes it reads as a player who lost interest in where they were going. Anything
// better would be a pathfinder, and a pathfinder is a bigger thing than this game
// needs.
//
// What a bot is allowed to KNOW is the other half of the design, and it is the half that
// used to be wrong. "it barely miss and it even know you are coming its like in any fps game
// we call them cheaters wallhacking" was two separate leaks with one symptom:
//
//   1. Perception was a ray test and nothing else. A bot picked the nearest enemy on a clear
//      line whether or not it was facing that way, then aimed at and walked at that enemy's
//      LIVE position for as long as the line stayed clear — through walls, since a wall only
//      ever cost it a thousand points of target score. So it faced you before you rounded
//      the corner and it tracked you while you were behind cover. That is a wallhack; it was
//      not described as one loosely.
//   2. Aim error was 0.03 radians of drift, and a body subtends 0.040 at ten units. The
//      error was smaller than the target across the whole band a bot chooses to fight in, so
//      inside that band it could not miss. See AIM_ERR_NEW.
//
// Now a bot knows only what it has seen inside FOV_HALF or heard inside HEAR_RANGE, it
// remembers rather than tracks (see `belief`), and it never pulls the trigger on a memory.
//
// The one thing the waypoint mechanism cannot do is get a bot out of a corner it is walking
// into for a reason other than a waypoint. See CHASE_BLOCK_MS — that took two bots
// standing against a wall for twenty-seven seconds to notice, so if a bot is ever seen
// parked somewhere again, the question to ask is what it thinks it is walking towards.

import * as C from '../shared/constants.js';
import { WORLD_BOXES, SPAWNS } from '../shared/map.js';
import { rayWorld } from '../shared/collide.js';
import { chestY, eyeY } from '../shared/movement.js';
import { PROJECTILES } from '../shared/projectile.js';
import { hasHeavy, idAt, isAuto, isUtil, weaponAt } from '../shared/weapons.js';

/**
 * How fast a bot turns, radians per second.
 *
 * One of two difficulty dials, and the one that decides whether a bot can point at you
 * before you point at it. Left unlimited, a bot snaps to a perfect solution the tick you
 * become visible and no amount of added spread makes it beatable.
 *
 * The other dial is AIM_ERR_NEW, which decides whether it hits what it is already pointing
 * at. This comment used to say turn rate was the only one that mattered, and that was the
 * mistake: the error was set below the size of a body and therefore was not a dial at all.
 */
const TURN_RATE = 5.2;

/** Dead time between seeing a target and shooting at it. Without it, stepping into a
 *  bot's view is instant death from across the arena. */
const REACTION_MS = 220;

/**
 * Half-angle of a bot's vision, radians.
 *
 * The single change that stops a bot reading as a wallhacker. `visible()` answers whether a
 * RAY is clear, which is a question about the map — it says nothing about whether the bot is
 * facing that way, and a bot that acts on it alone knows what is behind its own head.
 *
 * 60 degrees each side, so 120 across. Deliberately WIDER than the client's own FOV slider
 * can go (it clamps at 110): a bot has no screen edge to catch movement at and no mouse to
 * flick with, so a cone tighter than the picture a human gets would make bots blind rather
 * than fair. Horizontal only — see inCone().
 */
const FOV_HALF = 1.047;

/** Furthest a bot picks anybody out at all. The arena is 64 units across, so on a clear line
 *  this is most of it: the real limiters are the cone and the walls, not the range. Every
 *  gun's own `range` is 110 units or more, so this is the binding one for bots. */
const VIEW_RANGE = 55;

/**
 * How long a bot keeps acting on where it last SAW you.
 *
 * The other half of not wallhacking. A bot no longer has any way to know where a hidden
 * target is, so it has to remember instead: the aim stays on the spot you went out of sight
 * at, and it walks there. Break the line and move and it arrives at an empty doorway.
 *
 * Long enough to be worth walking across a lane for, short enough that a bot does not stand
 * guard over a memory while somebody shoots it in the back.
 */
const MEMORY_MS = 2500;

/**
 * Hearing, and how wrong it is.
 *
 * Not a nicety. With sight cut to a 120-degree cone, a purely visual bot is one you can
 * shoot in the back indefinitely, and a room of them stops finding itself at all — which
 * would replace "they cheat" with "they are broken". Hearing is also the honest version of
 * the thing being taken away: a human who gets shot at knows roughly where from, and does
 * not know exactly.
 *
 * NOISE_SLOP is how wrong the guess is, in units, and it is deterministic per bot and per
 * noise rather than re-rolled every tick — a bot walks at one wrong spot instead of
 * vibrating between a new one each frame. A heard position never lets a bot shoot: see
 * `fresh`.
 */
const HEAR_RANGE = 34;
const NOISE_SLOP = 3.5;

/**
 * Aim error, in radians. A drift rather than per-shot scatter, and now large enough to matter.
 *
 * A drift because the weapon's own `spread` already scatters rounds, and stacking a second
 * random offset on top just makes a bot that misses for no visible reason. A drift means a
 * bot's aim is momentarily off and then momentarily on, which is what a human's is.
 *
 * The magnitude was the bug, and "it barely miss" was an accurate read of it. The number to
 * beat is not a feeling, it is the angle a body subtends: PLAYER_HALF_W is 0.4, so a target
 * is atan2(0.4, dist) wide — 0.040 rad at ten units, which is the middle of the HOLD_NEAR to
 * HOLD_FAR band a bot deliberately fights in. The old flat 0.03 was under that everywhere
 * inside its own preferred range, so it could not produce a miss; all it ever did was delay
 * a shot by a few ticks, because the trigger gate below waits for the aim to settle on
 * whatever the intended angle is.
 *
 *   NEW      0.055  on a fresh contact. 1.4x a body at ten units, so it misses.
 *   SETTLED  0.012  after SETTLE_MS of UNBROKEN view. Well inside, so it hits.
 *   TRACK    0.035  added on top, at full lateral speed across the sightline.
 *
 * The shape matters more than any one number: a bot that has held you in view for a second
 * is dangerous, one that just found you is not, and one tracking a strafing target is worse
 * again. Close range stays lethal on purpose — at three units a body subtends 0.13 rad and
 * no combination of these gets near it — because the answer to a bot in your face should be
 * that you lost that fight, not that it politely missed.
 */
const AIM_ERR_NEW = 0.055;
const AIM_ERR_SETTLED = 0.012;
const SETTLE_MS = 900;
const AIM_ERR_TRACK = 0.035;

/** The range band a bot tries to fight from. It closes outside this and backs off
 *  inside it, which is most of what stops bots from ending every engagement nose to
 *  nose in the middle of the map. */
const HOLD_NEAR = 6;
const HOLD_FAR = 14;
/**
 * How much of its movement a bot gives up while its trigger is down.
 *
 * Firing costs accuracy now — `spreadMul` in shared/weapons.js reads the body holding the
 * gun, and it reads a bot's body through exactly the same tryFire a player's input goes
 * through. There is no bot-only path here and there must not be one; the honest way for a
 * bot to shoot straight is the same as the player's, which is to settle first.
 *
 * Not zero, because "a bot that walks straight at you is a bot you cannot miss" still
 * holds and standing perfectly still to shoot is its own kind of free kill. 0.3 across
 * both axes is a bot that slows to a counter-strafe: about a 1.4x cone in the hold band
 * against the 8.9x a sprinting player now eats.
 */
const FIRE_SETTLE = 0.3;

/** Furthest a bot will throw at somebody. Well inside a flat throw's reach (a
 *  snowball at 22 m/s under 14 gravity carries about 34u), because a throw that has
 *  to be lofted to arrive is a throw the target walks out from under. */
const THROW_RANGE = 26;

/** Stuck detection: how often progress is checked, and how far a bot that wanted to
 *  move must have travelled in that time to count as moving. */
const STUCK_MS = 420;
const STUCK_DIST = 0.35;

/**
 * How long a bot that walked into something stops walking at a target it cannot see.
 *
 * This exists because the stuck recovery below could not actually recover a chasing
 * bot, and the arena grew two fifty-unit walls that made that matter. A bot with a
 * hidden target walks dead straight at it — `moveX` is zero unless the target is
 * visible — so pressed against a divider with an enemy on the far side, the recovery's
 * strafe flip went into a variable nothing read and its `wp = null` cleared a waypoint
 * nothing was walking to. What was left was a 90ms hop, once every STUCK_MS, forever:
 * measured at 27 of 45 seconds in one 2-unit cell, by two bots at once at mirrored
 * positions against the two dividers.
 *
 * Roaming is the one mechanism in this file that does get a bot out of a corner,
 * because a roam waypoint can be somewhere else entirely rather than 0.4u further into
 * a wall. So for a moment after walking into something, an unseen target stops being
 * somewhere to go. Long enough to commit to leaving, short enough that a bot which
 * merely clipped a crate on the way to a fight still arrives at it.
 */
const CHASE_BLOCK_MS = 1200;

/** How close counts as having arrived at a waypoint. */
const REACHED = 2.2;

/** How old a belief has to be before standing on top of it counts as having checked it and
 *  found nothing. Long enough to have walked there rather than merely been there. */
const STALE_MS = 500;

/**
 * Where a bot with nobody to shoot at goes.
 *
 * The spawn points plus the arena centre. Spawns because the map already guarantees
 * they are clear of geometry — an unreachable waypoint would have a bot grinding into
 * a wall until the stuck check saved it — and the centre because without it bots
 * orbit the perimeter and the middle of the map goes unused.
 */
const ROAM = [...SPAWNS.map((s) => ({ x: s.x, z: s.z })), { x: 0, z: 0 }];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** Shortest way round to an angle difference. */
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Does a sightline pass through a smoke cloud?
 *
 * Closest approach of the SEGMENT to the cloud's centre, against its radius — a segment
 * rather than an infinite ray because a cloud behind you does not blind you and one
 * beyond your target does not hide them.
 *
 * This exists so smoke is real. A cloud that only the client drew would be a cloud bots
 * shoot you through while you cannot see them, which is worse than having no smoke in
 * the game at all: the player would learn that using one is a way of losing.
 */
function throughSmoke(from, to, clouds) {
  const bx = to.x - from.x;
  const by = to.y - from.y;
  const bz = to.z - from.z;
  const bb = bx * bx + by * by + bz * bz;
  if (bb < 1e-6) return false;
  for (const c of clouds) {
    const ax = c.x - from.x;
    const ay = c.y - from.y;
    const az = c.z - from.z;
    // Where along the segment the nearest point to the centre falls, clamped to the
    // ends so a cloud off either side of the line is measured from the endpoint.
    const t = clamp((ax * bx + ay * by + az * bz) / bb, 0, 1);
    const cx = ax - bx * t;
    const cy = ay - by * t;
    const cz = az - bz * t;
    if (cx * cx + cy * cy + cz * cz <= c.r * c.r) return true;
  }
  return false;
}

/** Is there clear air between two eyes? Distance to geometry along the ray against
 *  distance to the target: anything shorter is a wall in between. Smoke counts as
 *  opaque, which is the whole reason the clouds are server state. */
function visible(from, to, clouds = null) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  if (rayWorld(from.x, from.y, from.z, dx / len, dy / len, dz / len, WORLD_BOXES, len)
    < len - 0.05) {
    return false;
  }
  return !(clouds?.length && throughSmoke(from, to, clouds));
}

/**
 * Is `to` inside the cone this player is facing?
 *
 * Horizontal only, and on purpose: the arena is one storey with crates on it, and a vertical
 * cone would make bots unable to see somebody standing on a box in front of them. "It knew I
 * was behind it" is the complaint; "it could not see me on a crate" is not.
 */
function inCone(p, to) {
  const dx = to.x - p.x;
  const dz = to.z - p.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return true;
  // forward = (-sin yaw, -cos yaw), so this dot product is the cosine of the angle off it.
  return (-Math.sin(p.yaw) * dx - Math.cos(p.yaw) * dz) / len >= Math.cos(FOV_HALF);
}

/**
 * Extra elevation a thrown weapon needs to actually arrive where the bot is looking.
 *
 * Aiming a grenade straight at a body puts it in the floor short of them, so this
 * solves for the miss and corrects it. Where a throw along the current aim would
 * land is exact — same speed, same gravity, same 2.2 upward bias `createProjectile`
 * gives every throw. The correction is first-order: raising the aim by ε radians
 * raises the impact point by about ε·dist, because `speed · cos(pitch) · time` is
 * `dist` by construction. One pass is plenty at arena ranges, and the result is
 * clamped because a solution that wants three quarters of a radian of loft is a
 * throw that should not be attempted at all.
 *
 * @param dist horizontal distance to the target.
 * @param dy   how far above the thrower's eye the target's eye is.
 */
function loft(kind, dist, dy, pitch) {
  const cfg = PROJECTILES[kind];
  if (!cfg || dist < 0.5) return 0;
  const cp = Math.max(0.2, Math.cos(pitch));
  const t = dist / (cfg.speed * cp);
  const lands = (cfg.speed * Math.sin(pitch) + 2.2) * t - 0.5 * cfg.gravity * t * t;
  return clamp((dy - lands) / dist, -0.5, 0.9);
}

/**
 * Which of the weapons this bot was dealt suits the range.
 *
 * The `+6` for whatever is already in hand is not a nicety — it is what makes the
 * function usable at all. Every swap sets `switchUntil` and blocks firing for
 * SWITCH_MS, so a bot that re-picks each tick between two near-equal options never
 * finishes drawing either and stands there unarmed for the whole match.
 */
function pickWeapon(p, dist) {
  let best = p.wep;
  let bestScore = -Infinity;
  for (const idx of p.loadout) {
    const w = weaponAt(idx);
    let s;
    if (w.kind === 'melee') s = dist < w.range ? 40 : 0;
    else if (w.mag !== null && p.ammo[idx] <= 0) s = 5; // empty: only if nothing else
    // Utility is scored below an empty magazine, which is to say never chosen. A
    // flashbang has to be thrown *before* the fight and a smoke has to be thrown at a
    // sightline rather than at a person, and neither of those is a decision this brain
    // is equipped to make — a bot that answers a firefight with a smoke grenade is a
    // bot that dies holding it.
    else if (isUtil(idAt(idx))) s = -1;
    else if (w.kind === 'projectile') s = dist < THROW_RANGE ? 55 : 20;
    else s = dist <= w.range ? 70 + w.dmg / 10 : 10;
    if (idx === p.wep) s += 6;
    if (s > bestScore) {
      bestScore = s;
      best = idx;
    }
  }
  return best;
}

/**
 * A bot's whole mind.
 *
 * @param seed the bot's player id, used only to give each one its own wobble phase
 *        and opening strafe direction. Without it a room of bots leans the same way
 *        at the same moment and reads as one organism with several bodies.
 */
export function createBrain(seed = 0) {
  let seq = 0;
  const phase = (seed * 2.399963) % (Math.PI * 2);

  /**
   * Everything this bot believes about where an enemy is, or null for "no idea".
   *
   * The whole fix lives in one field name. `x/y/z` is where the target WAS when the bot last
   * had information about it — a sighting or a gunshot — and NOT where it is now. Nothing
   * downstream of here reads `room.players` for a position, so there is no path by which a
   * hidden body can move a bot's aim.
   *
   *   fresh  true only on a tick the bot can actually see them. It gates the trigger, so a
   *          bot never shoots at a memory, and it gates strafing, so a bot walking at a
   *          remembered spot is walking rather than duelling.
   *   since  when the current unbroken look began. Both REACTION_MS and the settle measure
   *          from it, so breaking line of sight and re-peeking costs a bot both again — that
   *          is the counterplay, and it is why it restarts rather than decaying.
   *   at     when the position was last true. MEMORY_MS measures from it.
   */
  let belief = null;

  let wp = null;
  let strafe = seed % 2 ? 1 : -1;
  let strafeUntil = 0;
  let jumpUntil = 0;
  /** While `now` is under this, an unseen target is not somewhere to walk. See
   *  CHASE_BLOCK_MS. */
  let chaseBlockUntil = 0;

  /**
   * Trigger state, for the weapons that need the trigger released between rounds.
   *
   * A bot used to hold BTN_FIRE for as long as it wanted to shoot, which was correct
   * when every weapon was automatic. Now that a pistol fires once per press (see
   * `fireHeld` in server/room.js), holding it means firing exactly one round and then
   * standing there aiming — so a bot has to click, and this is the click.
   *
   * `clickAt` paces the clicks a little slower than the weapon's own cadence and with
   * some scatter, rather than releasing for exactly one tick and pressing again. A bot
   * that clicks at precisely the legal maximum is a bot that spends the whole match
   * out-tapping every human in the room.
   */
  let triggerDown = false;
  let clickAt = 0;

  let checkAt = 0;
  let markX = 0;
  let markZ = 0;

  /**
   * The nearest enemy this bot can actually see: inside the cone, inside VIEW_RANGE, on a
   * clear ray, not behind smoke. All four, every tick.
   *
   * This used to score a hidden enemy at `-distance` and a visible one at `1000 - distance`,
   * which reads as a preference and behaves as a wallhack: with nobody in sight it returned
   * the nearest body through the wall, and everything downstream then aimed at it. There is
   * no hidden candidate to weigh against a visible one any more, so there is no score —
   * except for the incumbent, who counts as `STICK` units nearer.
   *
   * That bonus is the same trick pickWeapon() uses and it is there for the same reason: two
   * enemies at similar range would otherwise swap the aim every tick, and a bot mid-swing
   * never satisfies the trigger gate. It replaces a retarget timer, which could not tell
   * "still shooting at the same person" from "has not noticed the other one yet".
   */
  const STICK = 5;
  function spot(room, p, eye, stickId) {
    let best = null;
    let bestScore = Infinity;
    for (const v of room.players.values()) {
      if (v === p || !v.alive) continue;
      if (!room.ctl.canDamage(room, p, v)) continue;
      const d = Math.hypot(v.x - p.x, v.y - p.y, v.z - p.z);
      if (d > VIEW_RANGE) continue;
      const score = d - (v.id === stickId ? STICK : 0);
      if (score >= bestScore) continue;
      if (!inCone(p, v)) continue;
      if (!visible(eye, { x: v.x, y: eyeY(v), z: v.z }, room.clouds)) continue;
      bestScore = score;
      best = v;
    }
    return best;
  }

  /**
   * The most recent gunshot this bot could have heard, or null.
   *
   * Through walls, deliberately — that is what sound does, and it is the only reason a bot
   * with a 120-degree cone ever turns round. `lastShotAt` is stamped in room.js where a
   * round actually leaves the barrel, so a click on an empty magazine is silent and a knife
   * always is.
   *
   * A tick late by construction: thinkBots() runs at the top of step() and tryFire() near
   * the bottom, so the earliest a bot can react to a shot is the tick after it. One tick is
   * 17ms against a REACTION_MS of 220, so it is left alone rather than reordered.
   */
  /**
   * The height on `v` this bot should point at: centre mass, or the eye when centre mass
   * is behind something.
   *
   * `spot` has already established the eye is visible, so the fallback is always a point
   * with a clear line to it. The fallback is the reason this is a second ray rather than
   * just `chestY`: cover in this map tops out at 1.4 and 1.5 in eight places, which is
   * over a standing chest at 1.125 and under a standing eye at 1.52 — precisely the peek
   * every player takes. Aiming at a chest it cannot see would be a bot emptying a
   * magazine into the top of a crate.
   *
   * The trade is that a target who is only showing their head gets shot in the head, and
   * that is the correct answer: it is what a player aiming at the same silhouette would
   * do, and the exposure is the target's choice rather than the bot's.
   */
  function aimY(eye, v, clouds) {
    const cy = chestY(v);
    return visible(eye, { x: v.x, y: cy, z: v.z }, clouds) ? cy : eyeY(v);
  }

  function listen(room, p, now) {
    let best = null;
    let bestAt = now - MEMORY_MS;
    for (const v of room.players.values()) {
      if (v === p || !v.alive) continue;
      if (!room.ctl.canDamage(room, p, v)) continue;
      if (v.lastShotAt <= bestAt) continue;
      if (Math.hypot(v.x - p.x, v.y - p.y, v.z - p.z) > HEAR_RANGE) continue;
      bestAt = v.lastShotAt;
      best = v;
    }
    return best;
  }

  return {
    /**
     * One tick of intent.
     *
     * @param p the bot's own player record — read, never written. Everything this
     *          returns is a request the room is free to refuse.
     * @returns an input in exactly the shape a client sends.
     */
    think(room, p, now) {
      const eye = { x: p.x, y: eyeY(p), z: p.z };

      // ── perceive
      // The only two places a bot learns anything. Everything below reads `belief` and
      // nothing below reads a live position, which is the property that had to be true.
      const target = spot(room, p, eye, belief?.id ?? 0);
      if (target) {
        // A new contact, or the same one re-acquired after losing it: `since` restarts, so the
        // reaction delay and the settle are both paid again. That is the counterplay to a bot
        // holding an angle — go away and come back and it is a fresh contact.
        if (belief?.id !== target.id || !belief.fresh) {
          belief = { id: target.id, x: 0, y: 0, z: 0, at: now, fresh: true, since: now };
        }
        belief.x = target.x;
        belief.y = aimY(eye, target, room.clouds);
        belief.z = target.z;
        belief.at = now;
      } else {
        if (belief) belief.fresh = false;
        // Nothing in sight, so the only other way to find out is to hear it. Worth strictly
        // less than a sighting: the position is wrong by up to NOISE_SLOP, and `fresh` stays
        // false, so it is somewhere to look rather than something to shoot at.
        //
        // Guarded on the age of what we already believe, so a shot across the map cannot
        // overwrite the doorway somebody just stepped out of.
        const heard = now - (belief?.at ?? -Infinity) > 300 ? listen(room, p, now) : null;
        if (heard) {
          belief = {
            id: heard.id,
            x: heard.x + Math.sin(heard.lastShotAt * 0.013 + phase) * NOISE_SLOP,
            // Centre mass flat, with no ray: nothing about a bot that heard a shot is
            // visible, so there is nothing to check a line of sight against. It never
            // shoots at a memory anyway — `shoot` below gates on `seen` — so this only
            // decides where it is looking while it walks over to find out.
            y: chestY(heard),
            z: heard.z + Math.cos(heard.lastShotAt * 0.011 + phase) * NOISE_SLOP,
            at: heard.lastShotAt,
            fresh: false,
            since: now,
          };
        }
        if (belief && now - belief.at > MEMORY_MS) belief = null;
      }
      // Walked to where the memory said and found nobody there: the memory is spent. Without
      // this a bot stands on the spot you vanished from until MEMORY_MS runs out, which looks
      // less like a wallhack and more like a malfunction.
      //
      // Gated on the information being stale, not just on standing near it. A gunshot from
      // somebody right behind you puts a believed position within REACHED immediately, and
      // without STALE_MS the bot would discard it on the tick it arrived and never turn round
      // — which is the one thing hearing exists to make it do.
      if (belief && !belief.fresh && now - belief.at > STALE_MS
        && Math.hypot(belief.x - p.x, belief.z - p.z) < REACHED) {
        belief = null;
      }

      let wep = p.wep;
      let wantYaw = p.yaw;
      let wantPitch = 0;
      let moveX = 0;
      let moveZ = 0;
      let buttons = 0;
      let shoot = false;
      let dist = Infinity;
      const seen = belief?.fresh === true;

      /** Walk at a roam waypoint, taking a fresh one on arrival or when the stuck check
       *  below has thrown the last one away. Two callers: a bot with nobody to shoot at,
       *  and a bot that has just given up walking at somebody it cannot see. */
      const roam = () => {
        if (!wp || Math.hypot(wp.x - p.x, wp.z - p.z) < REACHED) {
          wp = ROAM[Math.floor(Math.random() * ROAM.length)];
        }
        wantYaw = Math.atan2(-(wp.x - p.x), -(wp.z - p.z));
        wantPitch = 0;
        moveZ = 1;
      };

      if (belief) {
        // Off the BELIEF, not off `target` — which is null half the time this branch runs, and
        // is the whole difference between a bot that remembers and a bot that tracks.
        const dx = belief.x - p.x;
        const dz = belief.z - p.z;
        const dy = belief.y - eye.y;
        const flat = Math.max(0.1, Math.hypot(dx, dz));
        dist = Math.hypot(dx, dy, dz);

        wep = pickWeapon(p, dist);
        const w = weaponAt(wep);

        // forward = (-sin yaw, -cos yaw), so this is the yaw that looks at them.
        wantYaw = Math.atan2(-dx, -dz);
        wantPitch = Math.atan2(dy, flat);
        if (w.kind === 'projectile') wantPitch += loft(w.proj, flat, dy, wantPitch);

        // Aim error, applied to the INTENDED angle. The trigger gate below measures against
        // this rather than against the truth, so a bot commits to being wrong instead of
        // holding fire until it happens to be right — which is what the old gate did, and is
        // why the old wobble delayed shots instead of causing misses.
        let err = AIM_ERR_NEW
          + (AIM_ERR_SETTLED - AIM_ERR_NEW) * clamp((now - belief.since) / SETTLE_MS, 0, 1);
        if (seen) {
          // Lateral speed across the sightline, normalised on a run: the perpendicular of
          // the horizontal unit vector to the target, dotted with their velocity. Tracking
          // somebody who is strafing is the hard half of aiming, and a bot got it for free.
          err += AIM_ERR_TRACK
            * clamp(Math.abs((target.vx * -dz + target.vz * dx) / flat) / C.MOVE_SPEED, 0, 1);
        }
        const ts = now / 1000;
        wantYaw += Math.sin(ts * 2.1 + phase) * err;
        wantPitch += Math.sin(ts * 1.7 + phase * 1.7) * err * 0.6;

        // The reach it is actually shooting for. A throwable's `range` is 0 — that
        // field describes a hitscan trace, and reading it here would mean a bot never
        // threw anything.
        const reach = w.kind === 'projectile' ? THROW_RANGE : w.range;
        // `seen`, never a memory. A bot that fires at where you were is a bot shooting through
        // a wall — the wallhack with the aim taken out and the trigger left in.
        //
        // DECIDED BEFORE THE MOVEMENT BELOW, which is the whole reason it moved up here
        // from under it: firing now costs accuracy, so the movement has to know whether
        // this tick is a shooting tick. The condition itself is unchanged.
        shoot = seen && dist <= reach && now - belief.since >= REACTION_MS;

        // Hold the band, and never stop moving sideways: a bot that walks straight at
        // you is a bot you cannot miss. Out of sight, close the distance instead —
        // that is the bot going to look for whoever it lost.
        //
        // Unless closing the distance is what just failed. Walking at a hidden target is
        // the one thing this file does with no sideways component at all, so it is also
        // the one thing a wall can stop dead; while the stuck check is complaining, the
        // bot goes somewhere of its own choosing instead. Aim goes with it, since
        // movement is in the bot's own frame — and there is nothing to aim at anyway,
        // because whatever it would be pointing at is behind the wall it just walked
        // into.
        if (!seen && now < chaseBlockUntil) {
          roam();
        } else {
          if (now >= strafeUntil) {
            strafe = Math.random() < 0.5 ? 1 : -1;
            strafeUntil = now + 500 + Math.random() * 900;
          }
          // Both axes, not just the strafe: at dist > HOLD_FAR the advance is what is
          // carrying the speed, and damping the sideways component alone would leave a
          // bot walking into a duel at full pace with a sevenfold cone.
          const settle = shoot ? FIRE_SETTLE : 1;
          moveX = seen ? strafe * 0.85 * settle : 0;
          moveZ = (!seen || dist > HOLD_FAR ? 1 : dist < HOLD_NEAR ? -0.6 : 0) * settle;
        }
      } else {
        roam();
      }

      // ── aim
      // Rate-limited, which is also why movement stays in the bot's own frame: it is
      // walking where it was looking a moment ago, exactly like a player mid-turn.
      const step = TURN_RATE * C.TICK_DT;
      const yaw = p.yaw + clamp(wrap(wantYaw - p.yaw), -step, step);
      const pitch = clamp(p.pitch + clamp(wantPitch - p.pitch, -step, step), -C.PITCH_LIMIT, C.PITCH_LIMIT);

      if (shoot) {
        // Only pull the trigger once the aim is inside the angle the target actually
        // subtends. Firing while still swinging onto someone is how a bot empties a
        // magazine into the wall beside them.
        const tol = Math.atan2(C.PLAYER_HALF_W, Math.max(1, dist));
        if (Math.abs(wrap(wantYaw - yaw)) < tol && Math.abs(wantPitch - pitch) < tol) {
          if (isAuto(idAt(wep))) {
            buttons |= C.BTN_FIRE;
          } else if (!triggerDown && now >= clickAt) {
            // One press, then off until the weapon is ready again and a little past it.
            buttons |= C.BTN_FIRE;
            clickAt = now + weaponAt(wep).intervalMs + 60 + Math.random() * 200;
          }
          // The knife's heavy stab, at the range it is worth committing to. Two hits
          // instead of four, and it is the reason to fear a bot with a knife.
          if (hasHeavy(idAt(wep)) && dist < 1.9) buttons |= C.BTN_ALT;
        }
      }

      // ── reload
      const w = weaponAt(wep);
      if (w.mag !== null) {
        const left = p.ammo[wep];
        if (left <= 0 || (!seen && left < w.mag * 0.35)) buttons |= C.BTN_RELOAD;
      }

      // ── stuck
      if (now >= checkAt) {
        if ((moveX || moveZ) && Math.hypot(p.x - markX, p.z - markZ) < STUCK_DIST) {
          // Walked into something. Nothing to ask for a route, so: hop, lean the other
          // way, stop believing in the waypoint that led here, and — for a moment —
          // stop believing in a target that cannot be seen either. That last one is the
          // part that matters against a long wall; the other three all quietly do
          // nothing to a bot in the middle of a chase.
          jumpUntil = now + 90;
          strafe = -strafe;
          strafeUntil = now + 700;
          chaseBlockUntil = now + CHASE_BLOCK_MS;
          wp = null;
        }
        checkAt = now + STUCK_MS;
        markX = p.x;
        markZ = p.z;
      }
      // Held for a few ticks and then released. Jumping is edge-triggered off
      // `jumpHeld`, so holding it forever would buy exactly one jump ever.
      if (now < jumpUntil) buttons |= C.BTN_JUMP;

      // What we are about to send is what the trigger will be holding next tick.
      triggerDown = (buttons & C.BTN_FIRE) !== 0;

      return { seq: ++seq, moveX, moveZ, yaw, pitch, buttons, wep };
    },
  };
}
