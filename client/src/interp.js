// Entity interpolation for remote players.
//
// Remote players are drawn at (now - INTERP_DELAY_MS), between the two snapshots
// that bracket that instant. Rendering at the newest snapshot instead guarantees a
// visible stutter every time a packet arrives late.
//
// Timing uses local receive time rather than a synchronised server clock. That
// removes clock sync entirely; the cost is that receive jitter shows up as slight
// variation in apparent speed, which is a good trade at this scale.

import * as C from '../../shared/constants.js';

const MAX_BUFFER = 32;
/** Farther than this between consecutive snapshots is not movement — it's a
 *  respawn. Interpolating across it would show a long slide. */
const TELEPORT_DIST = 6;

function lerpAngle(a, b, f) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * f;
}

export function createInterpolator() {
  const buf = [];

  return {
    push(snapshot, tLocal) {
      const byId = new Map();
      for (const p of snapshot.players) byId.set(p.id, p);
      buf.push({ t: tLocal, byId });
      if (buf.length > MAX_BUFFER) buf.shift();
    },

    /** Map of id -> interpolated player state, or null before the first snapshot. */
    sample(now) {
      if (buf.length === 0) return null;
      const target = now - C.INTERP_DELAY_MS;

      if (buf.length === 1 || target <= buf[0].t) return new Map(buf[0].byId);
      const newest = buf[buf.length - 1];
      if (target >= newest.t) return new Map(newest.byId);

      let a = buf[0];
      let b = buf[1];
      for (let i = 1; i < buf.length; i++) {
        if (buf[i].t >= target) {
          a = buf[i - 1];
          b = buf[i];
          break;
        }
      }

      const span = b.t - a.t;
      const f = span > 0 ? (target - a.t) / span : 0;
      const out = new Map();

      for (const [id, pb] of b.byId) {
        const pa = a.byId.get(id);
        if (!pa) {
          out.set(id, pb); // appeared this snapshot; nothing to blend from
          continue;
        }
        if (Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z) > TELEPORT_DIST) {
          out.set(id, pb);
          continue;
        }
        out.set(id, {
          ...pb,
          x: pa.x + (pb.x - pa.x) * f,
          y: pa.y + (pb.y - pa.y) * f,
          z: pa.z + (pb.z - pa.z) * f,
          yaw: lerpAngle(pa.yaw, pb.yaw, f),
          pitch: pa.pitch + (pb.pitch - pa.pitch) * f,
          // Crouch blends with position, or a remote player's body would snap
          // between two heights at 20 Hz while sliding smoothly at 60.
          cr: (pa.cr ?? 0) + ((pb.cr ?? 0) - (pa.cr ?? 0)) * f,
        });
      }
      return out;
    },
  };
}
