// Thrown projectiles — grenades and snowballs. One system, two configs.
//
// Lives in shared/ for the same reason movement.js does: the client draws these from
// snapshots that arrive 100ms in the past, so it has to advance them itself to put
// them where they actually are. Running the server's own stepping function is the
// only way that agrees.
//
// World collision only. Player hits stay server-side, where the player list and the
// authority to apply damage both live.

import { moveAxis, overlapsBox } from './collide.js';
import { halfOf } from './movement.js';

/** Projectile kinds, keyed by the `proj` field in shared/weapons.js. */
export const PROJECTILES = {
  grenade: {
    /** Bounces and cooks off on a timer, so it can be banked around cover. */
    fuseMs: 1500,
    speed: 18,
    gravity: 20,
    /** Fraction of speed kept per bounce. Low enough that it settles rather than
     *  skittering across the whole arena. */
    restitution: 0.32,
    radius: 0.11,
    /** Damage at the centre, falling linearly to zero at `blast`. */
    dmg: 110,
    blast: 4.6,
    bounces: true,
    /** Whether a body stops it. True for anything that damages what it touches; false
     *  for utility, which bounces off people as if they were furniture — a flashbang
     *  that detonates on contact is a flashbang you cannot throw past a teammate. */
    hitsPlayers: true,
    /** Explodes when the fuse runs out, wherever it happens to be. */
    onImpact: 'bounce',
    /** Right-click underhand. Half the speed and twice the lift, so it clears the
     *  wall in front of you and lands a few metres out instead of across the arena
     *  — the throw you want when you are hiding behind the thing you are bombing. */
    lob: { speedMul: 0.5, rise: 4.8 },
  },
  snowball: {
    fuseMs: 3000,
    speed: 22,
    gravity: 14, // floatier than a grenade, so leading a target is learnable
    restitution: 0,
    radius: 0.1,
    dmg: 34,
    blast: 0, // direct hits only
    bounces: false,
    hitsPlayers: true,
    onImpact: 'burst',
    lob: { speedMul: 0.62, rise: 4.2 },
  },

  // ── utility
  // Neither of these takes a hit point off anybody. What they do instead is in
  // `effect`, and the server reads that field to decide what happens when the fuse
  // runs out — see resolveProjectile in server/room.js.
  flash: {
    // Shorter fuse than a grenade: a flashbang is thrown to go off *now*, around the
    // corner you are about to walk through, and one that gives you an extra half
    // second to look away is one nobody bothers throwing.
    fuseMs: 1250,
    speed: 19,
    gravity: 20,
    restitution: 0.28,
    radius: 0.1,
    dmg: 0,
    blast: 0,
    bounces: true,
    hitsPlayers: false,
    onImpact: 'bounce',
    /** Blinds whoever can see it. Read by the server, which owns both the line-of-sight
     *  test and the per-victim duration — a client deciding how blind it is would be a
     *  client that decides not to be. */
    effect: 'blind',
    /** Past this many metres the bang does nothing at all. */
    blindRange: 16,
    /** Blindness at point-blank with the flash dead centre in your view, in ms. Falls
     *  off with distance and with how far off-centre it went off.
     *
     *  Was 2900, and the report was "the flashbang doesnt flash you white enough it
     *  should be as high white like you get flashbang when you woke up and its dark like
     *  you open your phone that bright". Brightness itself was never the problem — the
     *  wash has been fully opaque white all along — the problem was arithmetic. The
     *  duration is scaled by `(1 - dist/range) * facing²`, so the *typical* flash was a
     *  fraction of the headline number: caught dead-on at 6m it ran 1810ms, of which the
     *  hold at full white was a third, so the whole white-out was about 600ms. That is
     *  short enough to read as a screen glitch rather than as being blinded. Raised so a
     *  proper flash is a few seconds of not being able to play, which is the point of
     *  throwing one, and the client now holds the white for a longer fraction on top. */
    blindMs: 4800,
    lob: { speedMul: 0.55, rise: 4.6 },
  },
  smoke: {
    // Lands, then blooms. The fuse is only how long it spends in the air.
    fuseMs: 1100,
    speed: 17,
    gravity: 20,
    // Barely bounces — a smoke that skitters is a smoke that ends up somewhere nobody
    // meant to screen.
    restitution: 0.18,
    radius: 0.11,
    dmg: 0,
    blast: 0,
    bounces: true,
    hitsPlayers: false,
    onImpact: 'bounce',
    /** Leaves a cloud behind at the point it ended. */
    effect: 'cloud',
    /** Cloud radius in metres, and how long it hangs. Big enough to screen the width
     *  of a doorway and to break a sightline down one of the long approaches. */
    cloudRadius: 3.8,
    cloudMs: 15000,
    lob: { speedMul: 0.55, rise: 4.2 },
  },
};

let nextId = 1;

/**
 * @param owner  player id, so a thrower is not hit by their own throw on frame one
 * @param dir    unit forward vector from the thrower's view
 * @param lob    right-click underhand — see `lob` in the config above. Both sides
 *               pass the same flag from the same input, so the client's cosmetic
 *               copy of your own throw still lands where the server's does.
 */
export function createProjectile(kind, owner, x, y, z, dir, now, lob = false) {
  const cfg = PROJECTILES[kind];
  const L = lob && cfg.lob ? cfg.lob : null;
  const speed = cfg.speed * (L ? L.speedMul : 1);
  return {
    id: nextId++,
    kind,
    owner,
    x,
    y,
    z,
    vx: dir.x * speed,
    // A slight upward bias: throwing dead flat at a target's feet is never what the
    // player means, and an arc is what makes a thrown weapon feel thrown.
    vy: dir.y * speed + (L ? L.rise : 2.2),
    vz: dir.z * speed,
    bornAt: now,
    diesAt: now + cfg.fuseMs,
    /** Set when it should be removed and resolved. */
    done: false,
    /** True if it ended by touching something rather than by the fuse. */
    impact: false,
    /** Surface normal of the last contact, or all zero for none yet. Cosmetic: it is
     *  what lets the client spray snow back out of the wall a snowball hit instead of
     *  puffing it straight up. */
    nx: 0,
    ny: 0,
    nz: 0,
  };
}

/**
 * Advance one projectile. Returns true if it is finished this step.
 *
 * Uses the same axis-separated moveAxis as the player, so a projectile cannot tunnel
 * through a wall the player would be stopped by, and the two agree about where
 * surfaces are.
 */
export function stepProjectile(pr, dt, boxes, now) {
  const cfg = PROJECTILES[pr.kind];
  const half = [cfg.radius, cfg.radius, cfg.radius];

  pr.vy -= cfg.gravity * dt;

  const hitY = moveAxis(pr, half, 'y', pr.vy * dt, boxes);
  const hitX = moveAxis(pr, half, 'x', pr.vx * dt, boxes);
  const hitZ = moveAxis(pr, half, 'z', pr.vz * dt, boxes);

  if (hitX || hitY || hitZ) {
    // Which way the surface faces, taken from the axes that stopped it. Recorded
    // before the bounce flips the velocity, or the sign comes out backwards.
    pr.nx = hitX ? (pr.vx > 0 ? -1 : 1) : 0;
    pr.ny = hitY ? (pr.vy > 0 ? -1 : 1) : 0;
    pr.nz = hitZ ? (pr.vz > 0 ? -1 : 1) : 0;

    if (!cfg.bounces) {
      pr.done = true;
      pr.impact = true;
      return true;
    }
    // Reflect only the axes that actually hit, which is what makes a grenade roll
    // along a floor instead of stopping dead on it.
    if (hitX) pr.vx *= -cfg.restitution;
    if (hitZ) pr.vz *= -cfg.restitution;
    if (hitY) {
      pr.vy *= -cfg.restitution;
      // Friction on contact with the ground, or it slides forever.
      pr.vx *= 0.72;
      pr.vz *= 0.72;
    }
  }

  if (now >= pr.diesAt) {
    pr.done = true;
    return true;
  }
  return false;
}

/** Does this projectile overlap a player's body box right now? */
export function hitsBody(pr, p) {
  const cfg = PROJECTILES[pr.kind];
  // halfOf so a ducked player is a smaller target here too — a snowball that sails
  // over someone's head must not still register as a direct hit.
  const [hx, hy, hz] = halfOf(p);
  return overlapsBox(pr.x, pr.y, pr.z, cfg.radius, cfg.radius, cfg.radius, {
    x: p.x,
    y: p.y,
    z: p.z,
    w: hx * 2,
    h: hy * 2,
    d: hz * 2,
  });
}

/**
 * Blast damage at a distance. Linear falloff to zero at the blast radius; a
 * zero-radius projectile does full damage on contact and nothing otherwise.
 */
export function blastDamage(kind, dist) {
  const cfg = PROJECTILES[kind];
  if (!cfg.blast) return cfg.dmg;
  if (dist >= cfg.blast) return 0;
  return cfg.dmg * (1 - dist / cfg.blast);
}
