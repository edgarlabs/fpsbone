// Server-side shot resolution: lag compensation, then the ray, then which part of the
// body it landed on.
//
// v1 raycast against players where they were *right now*, which is honest and wrong.
// Every remote player is drawn INTERP_DELAY_MS in the past — that is what makes other
// people move smoothly instead of teleporting between snapshots — so "where they are
// now" is a place the shooter has never seen them. At MOVE_SPEED and a 100ms delay that
// is 0.42u of lead against a body 0.80u wide, before a single millisecond of ping is
// involved: aim dead centre on a strafing target and you miss more often than you hit.
//
// "you cant even hit good with sniper when they move it is so damn hard even tho it is
// 100 damage it still make no sense if it cannot hit." It was not the sniper. Room has
// recorded a position history per player since v1 and nothing ever read it; `rewind`
// below is the consumer it was written for.

import * as C from '../shared/constants.js';
import { WORLD_BOXES } from '../shared/map.js';
import { rayBox, rayWorld } from '../shared/collide.js';
import { eyeY, aimDir, halfOf, headBoxOf, legsTopOf } from '../shared/movement.js';
import { HIT_ZONE } from '../shared/weapons.js';

/**
 * Random offset inside a cone of half-angle `spread`, applied in the two axes
 * perpendicular to the aim direction.
 *
 * Perturbing yaw and pitch directly would be shorter, but yaw degrees compress
 * toward the poles — the same numeric jitter would produce a narrower cone when
 * looking up or down than when looking level. A tangent basis has no such bias.
 */
function coneDir(yaw, pitch, spread) {
  const d = aimDir(yaw, pitch);
  if (spread <= 0) return d;

  // The camera's own right vector, perpendicular to `d` at every pitch.
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  // up = right × d
  const ux = -rz * d.y;
  const uy = rz * d.x - rx * d.z;
  const uz = rx * d.y;

  const ang = Math.random() * Math.PI * 2;
  // sqrt keeps the samples uniform over the disc instead of clustering at centre.
  const mag = Math.sqrt(Math.random()) * spread;
  const ca = Math.cos(ang) * mag;
  const sa = Math.sin(ang) * mag;

  const x = d.x + rx * ca + ux * sa;
  const y = d.y + uy * sa;
  const z = d.z + rz * ca + uz * sa;
  const len = Math.hypot(x, y, z) || 1;
  return { x: x / len, y: y / len, z: z / len };
}

/**
 * When the shooter's screen was, in server sim time — the moment to rewind everyone else
 * to. 0 means "do not rewind", and 0 is what a bot gets.
 *
 * `vt` is the server's own snapshot stamp echoed back by the client plus however long it
 * has been holding it (see net.js), so the answer is already on this clock; subtracting
 * INTERP_DELAY_MS lands on the frame the shooter was actually looking at rather than the
 * snapshot behind it.
 *
 * THE CLAMP IS THE SECURITY BOUNDARY, and it is why the stamp is server-issued rather
 * than a client clock. A client can only usefully lie in one direction — backwards, to
 * shoot at somewhere a target used to be — and MAX_REWIND_MS bounds how far back that
 * buys anything. Lying forwards asks to be rewound into the future, which clamps to now
 * and is just the old un-compensated behaviour. Bots pass 0 because their inputs never
 * crossed a network and there is nothing to compensate for.
 */
export function rewindTimeFor(vt, now) {
  if (!vt) return 0;
  const at = vt - C.INTERP_DELAY_MS;
  return Math.max(now - C.MAX_REWIND_MS, Math.min(now, at));
}

/**
 * Where a player was at sim time `at`, as a body the geometry helpers can measure.
 *
 * Interpolated between the two bracketing history samples rather than snapped to the
 * nearest, because the samples are 16.7ms apart and snapping would quantise every target
 * to 7cm of jitter at walking speed — reintroducing a smaller copy of the exact problem
 * the rewind exists to remove.
 *
 * `cr` travels with the position for the same reason the position travels at all: a
 * player who ducked after being shot at would otherwise be measured at their old
 * *place* with their new *size*, and a shot that cleared their head would connect with a
 * body that was never there. Falls through to the live player when `at` is 0, when the
 * history is empty, or when `at` is newer than anything recorded — the common cases, and
 * all of them mean "use the present".
 */
export function rewind(p, at) {
  const h = p.history;
  if (!at || !h || h.length === 0 || at >= h[h.length - 1].t) return p;

  for (let i = h.length - 1; i > 0; i--) {
    const b = h[i];
    const a = h[i - 1];
    if (at >= a.t) {
      const span = b.t - a.t;
      const f = span > 0 ? (at - a.t) / span : 0;
      return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        z: a.z + (b.z - a.z) * f,
        crouch: (a.cr ?? 0) + ((b.cr ?? 0) - (a.cr ?? 0)) * f,
      };
    }
  }
  // Older than everything on record: HISTORY_MS has already rolled past it. The oldest
  // sample is the closest honest answer, and the clamp above means this is unreachable
  // for any client whose ping is inside MAX_REWIND_MS.
  const o = h[0];
  return { x: o.x, y: o.y, z: o.z, crouch: o.cr ?? 0 };
}

/**
 * Which part of the body a trace that already connected landed on.
 *
 * `t` is the body-box entry — the first thing the bullet touched — and `b` is the body it
 * touched, rewound. Called only after the body test has passed, which is the whole point:
 * zones can change what a hit was WORTH and can never change whether it happened. The old
 * box is still the only hittability test in this file.
 *
 * The two zones are asked in different ways, each for its own reason:
 *
 *   HEAD is a pass-through test, because the head box sits *inside* the body volume and
 *   is narrower on both horizontal axes. A straight-on shot at head height enters the
 *   body's front face 0.22u in FRONT of the skull, so asking whether the entry point is
 *   inside the head box would answer no to every headshot ever fired. Asking whether the
 *   line passes through the head answers yes to exactly the shots a player would call a
 *   headshot — and to one more, the steep upward shot that enters the chest and leaves
 *   through the crown, which really did pass through the head and can keep the kill.
 *
 *   LEGS is an entry-point test, because legs are a band that partitions the body rather
 *   than a volume inside it: below the line is legs, above it is not, and the first thing
 *   the bullet touched is unambiguous. Asked as a pass-through it would call a shot fired
 *   down onto someone's head from a rooftop a leg hit, since the ray leaves through the
 *   feet.
 *
 * Everything at head height that misses the narrow skull — the outer third of the
 * silhouette — falls through to BODY and is a shoulder. That is the forgiving direction
 * and it is how a real hitbox set behaves.
 */
function zoneOf(ox, oy, oz, d, b, t) {
  const head = headBoxOf(b);
  if (rayBox(ox, oy, oz, d.x, d.y, d.z, b.x, head.cy, b.z, head.hx, head.hy, head.hx) >= 0) {
    return HIT_ZONE.HEAD;
  }
  return oy + d.y * t < legsTopOf(b) ? HIT_ZONE.LEGS : HIT_ZONE.BODY;
}

/**
 * @param weapon  entry from shared/weapons.js — supplies range and spread.
 * @param canHit  (shooter, target) => boolean. The friendly-fire gate. A blocked
 *                target is skipped entirely rather than hit for zero damage, so a
 *                teammate standing in front of you does not eat the bullet that
 *                would otherwise have reached the enemy behind them.
 * @param at      sim time to rewind targets to, from `rewindTimeFor`. 0 tests against
 *                the present, which is what v1 did and what a bot still gets.
 */
export function resolveShot(shooter, players, weapon, canHit = () => true, at = 0) {
  const ox = shooter.x;
  const oy = eyeY(shooter);
  const oz = shooter.z;
  const d = coneDir(shooter.yaw, shooter.pitch, weapon.spread ?? 0);
  const range = weapon.range ?? 200;

  // Level geometry first — nobody shoots through a wall.
  let best = rayWorld(ox, oy, oz, d.x, d.y, d.z, WORLD_BOXES, range);
  let victim = null;
  let zone = HIT_ZONE.BODY;

  for (const p of players) {
    if (p === shooter || !p.alive) continue;
    if (!canHit(shooter, p)) continue;
    // Where the shooter SAW them, not where they are. The shooter itself is never
    // rewound: they are the one player who is predicted locally, and therefore the one
    // player already drawn in the present on their own screen.
    const b = rewind(p, at);
    // halfOf, not the standing constant: a crouching target is genuinely smaller.
    // Reading a fixed height here would leave a phantom 0.35u of head above a
    // ducked player, hittable through the cover they are hiding behind.
    const [hx, hy, hz] = halfOf(b);
    const t = rayBox(
      ox, oy, oz,
      d.x, d.y, d.z,
      b.x, b.y, b.z,
      hx, hy, hz,
    );
    if (t >= 0 && t < best) {
      best = t;
      victim = p;
      zone = zoneOf(ox, oy, oz, d, b, t);
    }
  }

  return {
    victim,
    dist: best,
    /**
     * What the shot ended on: 0 nothing, 1 world geometry, 2 a player.
     *
     * `rayWorld` returns the range it was given when it hits nothing, so a distance
     * short of the range is the test for having actually stopped on something. The
     * client draws its impact off this — a knife swung at empty air must not leave
     * chips hanging two metres in front of your face.
     */
    on: victim ? 2 : best < range - 1e-4 ? 1 : 0,
    /** HIT_ZONE of the victim. Meaningless when there isn't one. */
    zone,
    point: { x: ox + d.x * best, y: oy + d.y * best, z: oz + d.z * best },
  };
}
