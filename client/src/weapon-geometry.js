// Shared low-poly geometry for the authored FPSBone viewmodels.
//
// The arsenal is intentionally procedural: Creator Studio can eventually export these
// exact meshes, but the game remains small and every silhouette stays under our control.
// A part may opt into a shaped side profile with its final array field. Unmarked parts
// keep the compact legacy format, so weapon stats, reload indices, and verification data
// do not need to know anything about rendering.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

const PROFILES = {
  // [normalised y, normalised z]. All profiles are convex so the two end caps can use
  // a fan without pulling in a triangulation dependency.
  receiver: [
    [-0.42, -0.5], [0.34, -0.5], [0.5, -0.3],
    [0.43, 0.34], [0.22, 0.5], [-0.42, 0.5],
  ],
  slide: [
    [-0.46, -0.5], [0.3, -0.5], [0.5, -0.35],
    [0.44, 0.5], [-0.38, 0.5],
  ],
  handguard: [
    [-0.42, -0.5], [0.34, -0.5], [0.5, -0.32],
    [0.5, 0.34], [0.3, 0.5], [-0.42, 0.5],
  ],
  stock: [
    [-0.5, -0.5], [0.3, -0.5], [0.5, -0.18],
    [0.2, 0.5], [-0.36, 0.5],
  ],
  grip: [
    [-0.5, -0.5], [0.5, -0.5], [0.34, 0.5], [-0.28, 0.5],
  ],
  mag: [
    [-0.5, -0.5], [0.42, -0.5], [0.5, 0.32], [-0.3, 0.5],
  ],
  blade: [
    [-0.3, 0.5], [0.42, 0.5], [0.5, -0.12],
    [0.02, -0.5], [-0.12, -0.46],
  ],
  kukri: [
    [-0.22, 0.5], [0.28, 0.5], [0.36, 0.14],
    [0.5, -0.18], [0.34, -0.42], [-0.02, -0.5], [-0.18, -0.34],
  ],
};

/** Extrude a low-poly side outline across the weapon's width (the X axis). */
function profilePrism(width, height, depth, profile) {
  const outline = PROFILES[profile] ?? PROFILES.receiver;
  const positions = [];
  const triangles = [];
  const n = outline.length;
  for (const x of [-width * 0.5, width * 0.5]) {
    for (const [ny, nz] of outline) positions.push(x, ny * height, nz * depth);
  }
  // End caps. Opposite winding keeps both faces lit correctly with normal culling.
  for (let i = 1; i < n - 1; i++) triangles.push(0, i + 1, i);
  for (let i = 1; i < n - 1; i++) triangles.push(n, n + i, n + i + 1);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    triangles.push(i, j, n + j, i, n + j, n + i);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(triangles);
  geometry.computeVertexNormals();
  return geometry;
}

/** Build one geometry from the compact part tuple used in viewmodel.js. */
export function weaponPartGeometry(part) {
  if (part[1] === 'sphere') return new THREE.IcosahedronGeometry(part[2], 2);
  const [w, h, d] = part.slice(1, 4);
  const shape = part[10];
  if (shape === 'pin-x') {
    const geometry = new THREE.CylinderGeometry(h * 0.5, h * 0.5, w, 8, 1);
    geometry.rotateZ(Math.PI / 2);
    return geometry;
  }
  if (shape === 'ring') {
    const geometry = new THREE.TorusGeometry(Math.max(h, d) * 0.32, w * 0.5, 5, 12);
    geometry.rotateY(Math.PI / 2);
    return geometry;
  }
  if (shape === 'karambit') {
    // One uninterrupted faceted hook. The old version used three rotated blade boxes,
    // leaving visible air gaps exactly where a curved blade should carry its strength.
    const geometry = new THREE.TorusGeometry(d * 0.34, w * 0.58, 4, 14, Math.PI * 1.34);
    geometry.rotateY(Math.PI / 2);
    geometry.rotateX(-0.3);
    geometry.scale(1, 1.16, 1);
    return geometry;
  }
  if (PROFILES[shape]) return profilePrism(w, h, d, shape);
  const roundBarrel = shape === 'cylinder' || (
    d > Math.max(w, h) * 3.4
    && Math.abs(w - h) < Math.max(w, h) * 0.35
  );
  if (roundBarrel) {
    const geometry = new THREE.CylinderGeometry(Math.max(w, h) * 0.5, Math.max(w, h) * 0.5, d, 10, 1);
    geometry.rotateX(Math.PI / 2);
    return geometry;
  }
  return new RoundedBoxGeometry(w, h, d, 2, Math.min(w, h, d) * 0.14);
}

const part = (role, w, h, d, x, y, z, shape, rx = 0, ry = 0, rz = 0) =>
  [role, w, h, d, x, y, z, rx, ry, rz, shape];

/**
 * Surface-connected mechanical detail derived from each gun's receiver.
 *
 * These are not random decorations. Every piece touches a declared surface: ejection
 * port, controls and pins sit on the right receiver wall; the rail sits on its roof;
 * the trigger and guard grow from its underside. The family additions then describe
 * how that action works (slide serrations, bolt handle, belt feed, pump ribs, etc.).
 */
export function weaponDetailParts(spec) {
  if (spec.anim || !spec.parts?.length || spec.parts[0][1] === 'sphere') return [];
  const id = spec.id ?? '';
  const base = spec.parts[0];
  const [w, h, d, x, y, z] = base.slice(1, 7);
  const right = x + w * 0.5 + 0.003;
  const left = x - w * 0.5 - 0.003;
  const roof = y + h * 0.5;
  const floor = y - h * 0.5;
  const short = id.startsWith('pistol');
  const heavy = id.startsWith('lmg');
  const details = [
    // Inset ejection port and the bolt visible inside it.
    part('dark', 0.008, h * 0.3, d * 0.23, right, y + h * 0.08, z - d * 0.05),
    part('steel', 0.012, h * 0.08, d * 0.13, right + 0.006, y + h * 0.08, z - d * 0.05),
    // Two receiver pins and a selector. Cylinders are laid across X, flush to the wall.
    part('trim', w + 0.012, 0.013, 0.013, x, y - h * 0.15, z + d * 0.18, 'pin-x'),
    part('dark', w + 0.014, 0.012, 0.012, x, y + h * 0.18, z - d * 0.2, 'pin-x'),
    // Trigger and guard. Both meet the receiver floor instead of floating below it.
    part('dark', 0.012, 0.052, 0.014, x, floor - 0.022, z + d * 0.16, undefined, 0.35),
    part('dark', 0.012, 0.012, 0.07, x, floor - 0.05, z + d * 0.16),
  ];

  if (short) {
    const grip = spec.parts[spec.mag];
    if (grip && grip[1] !== 'sphere') {
      const [gw, gh, gd, gx, gy, gz] = grip.slice(1, 7);
      details.push(
        part('trim', 0.006, gh * 0.5, gd * 0.58, gx + gw * 0.5 + 0.002, gy, gz),
        part('trim', 0.006, gh * 0.5, gd * 0.58, gx - gw * 0.5 - 0.002, gy, gz),
      );
    }
    // Front and rear sights are seated directly on the slide.
    details.push(
      part('dark', w * 0.34, 0.022, 0.02, x, roof + 0.009, z - d * 0.39),
      part('dark', w * 0.65, 0.018, 0.026, x, roof + 0.007, z + d * 0.34),
    );
    // Three shallow serrations cut the rear outline. They sit only a few millimetres
    // proud, so they read as machining rather than floating black tiles.
    for (let i = 0; i < 3; i++) {
      details.push(part('dark', 0.007, h * 0.43, 0.012, right + 0.004, y + h * 0.06, z + d * (0.18 + i * 0.11), undefined, 0.16));
    }
  } else {
    // Paired inset armour panels make both handedness settings equally authored. The
    // panels overlap the receiver wall by two millimetres, so there is no daylight gap.
    details.push(
      part('trim', 0.007, h * 0.36, d * 0.26, right - 0.002, y - h * 0.02, z - d * 0.08),
      part('trim', 0.007, h * 0.36, d * 0.26, left + 0.002, y - h * 0.02, z - d * 0.08),
      // The muzzle collar meets the declared muzzle point and gives the barrel an
      // intentional end instead of letting a skinny cylinder simply stop.
      part('dark', 0.045, 0.045, 0.055, spec.muzzle[0], spec.muzzle[1], spec.muzzle[2] + 0.02, 'cylinder'),
    );
    // A continuous rail spine plus seated cross-slots. The spine is important: without
    // it the little rail blocks appear to hover over the receiver.
    details.push(part('dark', w * 0.5, 0.012, d * 0.68, x, roof + 0.006, z - d * 0.04));
    for (let i = -2; i <= 2; i++) {
      details.push(part('steel', w * 0.74, 0.015, 0.018, x, roof + 0.015, z + i * d * 0.115));
    }
    // Folded iron sights, each planted on the rail spine.
    details.push(
      part('dark', w * 0.72, 0.04, 0.018, x, roof + 0.028, z - d * 0.39),
      part('dark', w * 0.66, 0.032, 0.018, x, roof + 0.024, z + d * 0.36),
    );
  }

  if (id === 'sniper') {
    // Bolt body, handle and knob remain connected to the receiver's right wall.
    details.push(
      part('steel', 0.05, 0.018, 0.018, right + 0.018, y + h * 0.18, z + d * 0.2, 'pin-x'),
      part('dark', 0.018, 0.018, 0.055, right + 0.042, y + h * 0.05, z + d * 0.2, undefined, -0.42),
      ['dark', 'sphere', 0.016, right + 0.042, y - h * 0.13, z + d * 0.22],
    );
  } else if (heavy) {
    // Feed-cover latch and linked rounds meeting the ammunition box/receiver seam.
    details.push(
      part('trim', 0.016, 0.035, d * 0.22, right + 0.006, y + h * 0.26, z),
      part('brass', 0.014, 0.014, 0.065, right + 0.012, floor - 0.01, z - d * 0.05, 'cylinder'),
    );
  } else if (id === 'shotgun') {
    // Pump ribs wrap the existing fore-end instead of adding another floating body.
    for (let i = -2; i <= 2; i++) {
      details.push(part('dark', w * 0.86, 0.012, 0.018, x, floor - 0.004, z - d * (0.45 + i * 0.07)));
    }
  } else {
    // Charging handle rooted in the receiver wall.
    details.push(part('dark', 0.038, 0.016, 0.016, right + 0.013, y + h * 0.23, z + d * 0.21, 'pin-x'));
  }
  return details;
}
