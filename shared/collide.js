// Axis-aligned collision + raycasting against the static level.
// Deliberately boring: no swept tests, no contact manifolds. Movement is resolved
// one axis at a time, which is what Quake-lineage shooters effectively do — it is
// deterministic, cheap, and easy to keep identical on client and server.

/**
 * Contact skin: how far clear of a surface a resolved body is left.
 *
 * This MUST stay larger than the position quantisation on the wire. Snapshots
 * round positions to 3 decimals (`r3` in server/room.js), an error of up to
 * 0.0005 — so with a 1e-4 skin a body resting flush against a wall arrived on the
 * client *inside* it, and the next predicted tick launched it onto the wall's top
 * surface. 1 mm is invisible to play and five times the rounding error, so the
 * round trip can no longer embed anything.
 */
export const EPS = 1e-3;

const halfOn = (b, axis) => (axis === 'x' ? b.w : axis === 'y' ? b.h : b.d) * 0.5;

export function overlapsBox(px, py, pz, hx, hy, hz, b) {
  return (
    Math.abs(px - b.x) < hx + b.w * 0.5 &&
    Math.abs(py - b.y) < hy + b.h * 0.5 &&
    Math.abs(pz - b.z) < hz + b.d * 0.5
  );
}

/**
 * Advance `state` along one axis, then push back out of anything it entered.
 * `half` is [hx, hy, hz]. Returns true if the move was obstructed.
 *
 * Resolution takes the most restrictive of every box the body ended up inside,
 * rather than the last one iterated — otherwise box order changes the outcome and
 * client and server can disagree.
 *
 * Boxes the body was ALREADY inside before the move are skipped. Snapping those to
 * this axis' face would move the body by the box's whole extent in that direction,
 * and for a downward move the face in question is the box's *top* — which is how a
 * body a hair inside a wall got teleported 7 m onto it. A pre-existing overlap is
 * depenetrate()'s job, not this function's.
 */
export function moveAxis(state, half, axis, amount, boxes) {
  if (amount === 0) return false;

  const [hx, hy, hz] = half;
  const was = state[axis];
  state[axis] = was + amount;

  // The pre-move position: only `axis` changed, so the rest is already current.
  const bx = axis === 'x' ? was : state.x;
  const by = axis === 'y' ? was : state.y;
  const bz = axis === 'z' ? was : state.z;

  const selfHalf = axis === 'x' ? hx : axis === 'y' ? hy : hz;
  let blocked = false;
  let limit = amount > 0 ? Infinity : -Infinity;

  for (const b of boxes) {
    if (!overlapsBox(state.x, state.y, state.z, hx, hy, hz, b)) continue;
    if (overlapsBox(bx, by, bz, hx, hy, hz, b)) continue; // already inside it
    blocked = true;
    const edge =
      amount > 0
        ? b[axis] - halfOn(b, axis) - selfHalf - EPS
        : b[axis] + halfOn(b, axis) + selfHalf + EPS;
    limit = amount > 0 ? Math.min(limit, edge) : Math.max(limit, edge);
  }

  if (blocked) state[axis] = limit;
  return blocked;
}

/**
 * Push a body out of any geometry it is already overlapping, along the SHALLOWEST
 * axis, and report whether anything moved.
 *
 * A body should never be inside the level, but positions make a lossy round trip
 * over the wire, and floating point leaves hairline overlaps at flush contact. The
 * amount matters much less than the direction: ejecting along the shallowest axis
 * moves the body by the sub-millimetre it is actually embedded, where picking the
 * wrong axis moves it by half a wall. Ties go to horizontal, because the failure
 * that players actually notice is being launched upward onto things.
 *
 * One pass. Real penetrations here are sub-millimetre, so pushing out of one box
 * cannot drive the body meaningfully into another.
 */
export function depenetrate(state, half, boxes) {
  const [hx, hy, hz] = half;
  let moved = false;

  for (const b of boxes) {
    if (!overlapsBox(state.x, state.y, state.z, hx, hy, hz, b)) continue;

    const dx = state.x - b.x;
    const dy = state.y - b.y;
    const dz = state.z - b.z;
    const px = hx + b.w * 0.5 - Math.abs(dx); // penetration depth per axis
    const py = hy + b.h * 0.5 - Math.abs(dy);
    const pz = hz + b.d * 0.5 - Math.abs(dz);
    // `|| 1` keeps a dead-centre overlap deterministic instead of Math.sign(0) = 0.
    if (pz <= px && pz <= py) state.z = b.z + Math.sign(dz || 1) * (hz + b.d * 0.5 + EPS);
    else if (px <= py) state.x = b.x + Math.sign(dx || 1) * (hx + b.w * 0.5 + EPS);
    else state.y = b.y + Math.sign(dy || 1) * (hy + b.h * 0.5 + EPS);
    moved = true;
  }

  return moved;
}

/** Ray/AABB slab test. Returns distance along the ray, or -1 for a miss. */
export function rayBox(ox, oy, oz, dx, dy, dz, cx, cy, cz, hx, hy, hz) {
  let tmin = 0;
  let tmax = Infinity;

  for (let a = 0; a < 3; a++) {
    const o = a === 0 ? ox : a === 1 ? oy : oz;
    const d = a === 0 ? dx : a === 1 ? dy : dz;
    const c = a === 0 ? cx : a === 1 ? cy : cz;
    const h = a === 0 ? hx : a === 1 ? hy : hz;

    if (d === 0) {
      if (o < c - h || o > c + h) return -1;
      continue;
    }
    const inv = 1 / d;
    let t1 = (c - h - o) * inv;
    let t2 = (c + h - o) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}

/** Distance to the nearest level geometry along a ray, clamped to `maxDist`. */
export function rayWorld(ox, oy, oz, dx, dy, dz, boxes, maxDist) {
  let best = maxDist;
  for (const b of boxes) {
    const t = rayBox(ox, oy, oz, dx, dy, dz, b.x, b.y, b.z, b.w * 0.5, b.h * 0.5, b.d * 0.5);
    if (t >= 0 && t < best) best = t;
  }
  return best;
}
