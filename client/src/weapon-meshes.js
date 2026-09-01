// Detailed weapon geometry shared by the first-person viewmodel and remote avatars.
//
// The gameplay rigs still own grip, muzzle, recoil and animation coordinates. These
// meshes replace only their old collection of overlapping primitive boxes. Keeping
// that boundary means a visual upgrade cannot silently move a muzzle or change where
// another player's hands land.

import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

import gauge12 from '../assets/weapons/byzmod3d/12_gauge.obj?raw';
import ak47 from '../assets/weapons/byzmod3d/ak47.obj?raw';
import colt1911 from '../assets/weapons/byzmod3d/colt_1911.obj?raw';
import kar98k from '../assets/weapons/byzmod3d/kar98k.obj?raw';
import karambit from '../assets/weapons/byzmod3d/karambit.obj?raw';
import m16 from '../assets/weapons/byzmod3d/m16.obj?raw';
import magnum44 from '../assets/weapons/byzmod3d/magnum_44.obj?raw';
import pistol from '../assets/weapons/byzmod3d/pistol.obj?raw';
import stg44 from '../assets/weapons/byzmod3d/stg44.obj?raw';

import flamethrower from '../assets/weapons/kenney/flamethrower.obj?raw';
import grenade from '../assets/weapons/kenney/grenade.obj?raw';
import flash from '../assets/weapons/kenney/grenadeFlash.obj?raw';
import smoke from '../assets/weapons/kenney/grenadeSmoke.obj?raw';
import knifeSharp from '../assets/weapons/kenney/knife_sharp.obj?raw';
import knifeSmooth from '../assets/weapons/kenney/knife_smooth.obj?raw';
import knifeRoundSharp from '../assets/weapons/kenney/knifeRound_sharp.obj?raw';
import knifeRoundSmooth from '../assets/weapons/kenney/knifeRound_smooth.obj?raw';
import machinegun from '../assets/weapons/kenney/machinegun.obj?raw';
import machinegunLauncher from '../assets/weapons/kenney/machinegunLauncher.obj?raw';
import sniper from '../assets/weapons/kenney/sniper.obj?raw';
import uzi from '../assets/weapons/kenney/uzi.obj?raw';
import uziLong from '../assets/weapons/kenney/uziLong.obj?raw';
import uziSilencer from '../assets/weapons/kenney/uziSilencer.obj?raw';

/**
 * Every arsenal entry selects a genuinely different source silhouette. `rotateX` is
 * only needed by knife assets authored blade-up instead of muzzle-forward.
 */
export const WEAPON_MESH_SOURCES = {
  knife:          { raw: knifeSharp, rotateX: -Math.PI / 2, kind: 'blade', grip: [.5, .5, .82] },
  pistol:         { raw: pistol, grip: [.5, .58, .88] },
  rifle:          { raw: m16, grip: [.5, .58, .7] },
  sniper:         { raw: sniper, rotateY: Math.PI, grip: [.5, .58, .82] },
  grenade:        { raw: grenade, kind: 'utility' },
  smg:            { raw: uzi, rotateY: Math.PI, grip: [.5, .58, .58] },
  lmg:            { raw: machinegun, rotateY: Math.PI, grip: [.5, .58, .76], viewScale: .68 },
  semi:           { raw: kar98k, rotateY: Math.PI, grip: [.5, .58, .72] },
  shotgun:        { raw: gauge12, grip: [.5, .58, .64] },
  flash:          { raw: flash, kind: 'utility' },
  smoke:          { raw: smoke, kind: 'utility' },
  rifle_havoc:    { raw: ak47, grip: [.5, .58, .7], viewScale: .78 },
  rifle_falcon:   { raw: stg44, grip: [.5, .58, .68] },
  smg_kite:       { raw: uziLong, rotateY: Math.PI, grip: [.5, .58, .58] },
  smg_banshee:    { raw: uziSilencer, rotateY: Math.PI, grip: [.5, .58, .58] },
  pistol_wisp:    { raw: colt1911, grip: [.5, .58, .88] },
  pistol_rook:    { raw: magnum44, grip: [.5, .58, .86] },
  lmg_atlas:      { raw: machinegunLauncher, rotateY: Math.PI, grip: [.5, .58, .76], viewScale: .68 },
  lmg_colossus:   { raw: flamethrower, rotateY: Math.PI, grip: [.5, .58, .72], viewScale: .64 },
  knife_karambit: { raw: karambit, rotateX: -Math.PI / 2, kind: 'blade', grip: [.5, .5, .76] },
  knife_tanto:    { raw: knifeSmooth, rotateX: -Math.PI / 2, kind: 'blade', grip: [.5, .5, .82] },
  knife_bowie:    { raw: knifeRoundSharp, rotateX: -Math.PI / 2, kind: 'blade', grip: [.5, .5, .76] },
  knife_kukri:    { raw: knifeRoundSmooth, rotateX: -Math.PI / 2, kind: 'blade', grip: [.5, .5, .76] },
};

const loader = new OBJLoader();

/** Imported silhouettes fill their boxes differently; bulky receiver models need a
 * smaller first-person presentation while remaining full size on remote avatars. */
export const firstPersonScaleOf = (id) => WEAPON_MESH_SOURCES[id]?.viewScale ?? 1;
const templates = new Map();

function templateFor(id) {
  if (templates.has(id)) return templates.get(id);
  const source = WEAPON_MESH_SOURCES[id];
  if (!source) return null;
  const object = loader.parse(source.raw);
  const root = new THREE.Group();
  root.add(object);
  root.name = `mesh:${id}`;
  // Put source-axis correction on a child. The outer root is what receives the fitted
  // scale below, so its x/y/z always mean FPSBone x/y/z even when a knife arrived with
  // its blade authored along Y.
  object.rotation.x = source.rotateX ?? 0;
  object.rotation.y = source.rotateY ?? 0;
  object.rotation.z = source.rotateZ ?? 0;
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const vertexCount = (() => {
    let n = 0;
    root.traverse((o) => { if (o.isMesh) n += o.geometry.attributes.position?.count ?? 0; });
    return n;
  })();
  const value = { root, box, size, center, vertexCount, source };
  templates.set(id, value);
  return value;
}

const materialName = (m) => String(m?.name ?? '').toLowerCase();

/** Select a small, stable set of finish channels while preserving the OBJ's face groups. */
function roleFor(source, material, index) {
  const name = materialName(material);
  if (source.kind === 'utility') {
    if (name.includes('olive')) return 'army';
    if (name.includes('gold')) return 'trim';
    return index % 3 === 0 ? 'dark' : 'steel';
  }
  if (source.kind === 'blade') {
    if (name.includes('warm') || name.includes('material.004')) return 'trim';
    if (name.includes('gray3') || name.includes('gray4') || name.includes('material.003')) return 'dark';
    return index % 3 === 1 ? 'dark' : index % 3 === 2 ? 'trim' : 'blade';
  }
  if (name.includes('warm') || name.includes('wood') || name.includes('brick')
      || name.includes('cobalt') || name.includes('frontcolor')) return 'trim';
  if (name.includes('gray8') || name.includes('material.002')) return 'dark';
  if (name.includes('gray3') || name.includes('gray4') || name.includes('material.004')) return 'trim';
  return index % 3 === 1 ? 'dark' : index % 3 === 2 ? 'trim' : 'steel';
}

/**
 * Clone and fit one imported model into an authored gameplay rig's measured bounds.
 * Non-uniform fitting is intentional: the two source libraries use different unit and
 * axis conventions, while the authored bounds are already tested against the camera,
 * hands and muzzle. It fixes those conventions once without altering the gameplay rig.
 */
export function buildDetailedWeapon(
  id, target, materials, { castShadow = false, anchor = null, scale = 1 } = {},
) {
  const template = templateFor(id);
  if (!template) return null;

  const g = template.root.clone(true);
  const targetSize = new THREE.Vector3(
    target.x1 - target.x0,
    target.y1 - target.y0,
    target.z1 - target.z0,
  );
  const targetCenter = new THREE.Vector3(
    (target.x0 + target.x1) * 0.5,
    (target.y0 + target.y1) * 0.5,
    (target.z0 + target.z1) * 0.5,
  );
  const safe = (n) => Math.max(1e-6, n);
  g.scale.set(
    (targetSize.x / safe(template.size.x)) * scale,
    (targetSize.y / safe(template.size.y)) * scale,
    (targetSize.z / safe(template.size.z)) * scale,
  );
  if (anchor && template.source.grip) {
    const f = template.source.grip;
    const sourceGrip = new THREE.Vector3(
      template.box.min.x + template.size.x * f[0],
      template.box.min.y + template.size.y * f[1],
      template.box.min.z + template.size.z * f[2],
    );
    g.position.set(
      anchor[0] - sourceGrip.x * g.scale.x,
      anchor[1] - sourceGrip.y * g.scale.y,
      anchor[2] - sourceGrip.z * g.scale.z,
    );
  } else {
    g.position.set(
      targetCenter.x - template.center.x * g.scale.x,
      targetCenter.y - template.center.y * g.scale.y,
      targetCenter.z - template.center.z * g.scale.z,
    );
  }

  let meshCount = 0;
  g.traverse((o) => {
    if (!o.isMesh) return;
    meshCount += 1;
    // Each instance owns its geometry because avatar culling disposes it. This avoids
    // one departing player freeing buffers still used by everybody else.
    o.geometry = o.geometry.clone();
    const original = Array.isArray(o.material) ? o.material : [o.material];
    const mapped = original.map((m, i) => materials[roleFor(template.source, m, i)] ?? materials.steel);
    o.material = Array.isArray(o.material) ? mapped : mapped[0];
    o.castShadow = castShadow && template.vertexCount < 5000;
    o.receiveShadow = false;
    o.frustumCulled = false;
  });
  g.userData.weaponMesh = true;
  g.userData.weaponId = id;
  g.userData.vertexCount = template.vertexCount;
  g.userData.meshCount = meshCount;
  return g;
}

export function weaponMeshStats(id) {
  const t = templateFor(id);
  return t ? { vertexCount: t.vertexCount, meshCount: (() => {
    let n = 0;
    t.root.traverse((o) => { if (o.isMesh) n += 1; });
    return n;
  })() } : null;
}

/** Bounds for the third-person rig's `[w,h,d,x,y,z,...rotation]` part format. */
export function boundsOfBoxParts(parts) {
  const box = {
    x0: Infinity, x1: -Infinity,
    y0: Infinity, y1: -Infinity,
    z0: Infinity, z1: -Infinity,
  };
  for (const [w, h, d, x, y, z, , rx = 0, ry = 0, rz = 0] of parts) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ'));
    const ax = new THREE.Vector3(w * 0.5, 0, 0).applyQuaternion(q);
    const ay = new THREE.Vector3(0, h * 0.5, 0).applyQuaternion(q);
    const az = new THREE.Vector3(0, 0, d * 0.5).applyQuaternion(q);
    const hx = Math.abs(ax.x) + Math.abs(ay.x) + Math.abs(az.x);
    const hy = Math.abs(ax.y) + Math.abs(ay.y) + Math.abs(az.y);
    const hz = Math.abs(ax.z) + Math.abs(ay.z) + Math.abs(az.z);
    box.x0 = Math.min(box.x0, x - hx);
    box.x1 = Math.max(box.x1, x + hx);
    box.y0 = Math.min(box.y0, y - hy);
    box.y1 = Math.max(box.y1, y + hy);
    box.z0 = Math.min(box.z0, z - hz);
    box.z1 = Math.max(box.z1, z + hz);
  }
  return box;
}
