// FOUNDRY 64's visual layer.
//
// Collision remains the plain, shared WORLD_BOXES data. Everything here is either:
//   * the visible skin of one of those boxes,
//   * fully contained inside an existing solid,
//   * above the highest reachable surface, or
//   * outside the arena shell.
// That rule matters more than decoration: a prop that looks solid but can be walked or
// shot through is misinformation in an FPS. This module makes the map look authored
// without changing one server-side collision, spawn or sightline.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import * as C from '../../shared/constants.js';
import { ARENA, MAP, WORLD_BOXES } from '../../shared/map.js';

export const ENVIRONMENT_ID = MAP.id;
export const ZONE_LABELS = Object.freeze(['ALPHA', 'MID', 'BRAVO']);

const STEEL = 0x39535c;
const STEEL_LIGHT = 0x82969b;
const SAFETY = 0xe3a33f;
const SAFETY_DARK = 0x6b3f18;
const PAINT = 0xd9e4e5;
const TEAM_A = 0x2f7fc4;
const TEAM_B = 0xd47b2b;
const GLASS = 0x72b8cb;

function material(color, options = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: options.roughness ?? 0.82,
    metalness: options.metalness ?? 0.04,
    flatShading: true,
    ...options,
  });
}

function boxGeometry({ x, y, z, w, h, d }) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

function mergedBoxes(scene, specs, mat, { shadows = true } = {}) {
  if (!specs.length) return null;
  const geos = specs.map(boxGeometry);
  const merged = mergeGeometries(geos, false);
  geos.forEach((g) => g.dispose());
  const mesh = new THREE.Mesh(merged, mat);
  mesh.castShadow = shadows;
  mesh.receiveShadow = shadows;
  scene.add(mesh);
  return mesh;
}

/** Deterministic concrete grain. It is intentionally low contrast: texture supplies scale
 * and wear while silhouettes, player colours and crosshairs remain the loudest things. */
function grainTexture(seed, contrast = 18) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(size, size);
  let state = seed >>> 0;
  for (let i = 0; i < image.data.length; i += 4) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const n = 238 + (((state >>> 24) / 255 - 0.5) * contrast);
    image.data[i] = n;
    image.data[i + 1] = n;
    image.data[i + 2] = n;
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  // Sparse aggregate flecks prevent the surface reading as television noise.
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = '#39474b';
  for (let i = 0; i < 22; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const x = (state >>> 16) % size;
    state = (state * 1664525 + 1013904223) >>> 0;
    const y = (state >>> 16) % size;
    ctx.fillRect(x, y, 1 + (i % 3), 1);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.anisotropy = 4;
  return tex;
}

function levelMaterials() {
  const floorMap = grainTexture(0xf064, 22);
  floorMap.repeat.set(24, 24);
  return {
    floor: material(C.PALETTE.floor, { roughness: 0.98, map: floorMap }),
    wallA: material(C.PALETTE.wallA, { roughness: 0.94, map: grainTexture(0xa11ce, 16) }),
    wallB: material(C.PALETTE.wallB, { roughness: 0.66, metalness: 0.2, map: grainTexture(0xb0b, 12) }),
    stair: material(C.PALETTE.stair, { roughness: 0.78, metalness: 0.08, map: grainTexture(0x57a17, 15) }),
    gantry: material(C.PALETTE.gantry, { roughness: 0.55, metalness: 0.42 }),
  };
}

function buildCollisionSkin(scene) {
  const groups = new Map();
  for (const b of WORLD_BOXES) {
    if (!groups.has(b.c)) groups.set(b.c, []);
    groups.get(b.c).push(b);
  }
  const mats = levelMaterials();
  for (const [key, specs] of groups) mergedBoxes(scene, specs, mats[key] ?? mats.wallA);
}

function horizontalPlane(scene, geometry, x, z, mat, y = 0.018) {
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, y, z);
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

function buildFloorLanguage(scene) {
  const pale = new THREE.MeshBasicMaterial({ color: PAINT, transparent: true, opacity: 0.58, depthWrite: false });
  const yellow = new THREE.MeshBasicMaterial({ color: SAFETY, transparent: true, opacity: 0.9, depthWrite: false });
  const blue = new THREE.MeshBasicMaterial({ color: TEAM_A, transparent: true, opacity: 0.8, depthWrite: false });
  const orange = new THREE.MeshBasicMaterial({ color: TEAM_B, transparent: true, opacity: 0.8, depthWrite: false });

  // Dashed lane centre lines. The two long runs make east/west orientation readable even
  // while sprinting and point directly toward the sniper perches.
  const dashGeo = new THREE.PlaneGeometry(0.16, 2.1);
  const dashes = new THREE.InstancedMesh(dashGeo, pale, 22);
  const matrix = new THREE.Matrix4();
  const flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0, 'YXZ'));
  const one = new THREE.Vector3(1, 1, 1);
  let n = 0;
  for (const x of [-26.5, 26.5]) {
    for (let z = -25; z <= 25; z += 5) {
      matrix.compose(new THREE.Vector3(x, 0.021, z), flat, one);
      dashes.setMatrixAt(n++, matrix);
    }
  }
  dashes.count = n;
  dashes.frustumCulled = false;
  scene.add(dashes);

  // Team-base rings and the neutral mid ring are navigation, not objective UI. They remain
  // useful in every mode and never imply that a deathmatch player must stand inside one.
  horizontalPlane(scene, new THREE.RingGeometry(5.2, 5.45, 48), 0, -25.5, blue);
  horizontalPlane(scene, new THREE.RingGeometry(5.2, 5.45, 48), 0, 25.5, orange);
  horizontalPlane(scene, new THREE.RingGeometry(9.4, 9.62, 64), 0, 0, pale);

  // Hazard bars announce every one of the four smoke-sized lane doors. They sit flat on
  // real floor, so they add no fake step or edge to prediction.
  const hazardGeo = new THREE.PlaneGeometry(0.38, 2.8);
  const hazards = new THREE.InstancedMesh(hazardGeo, yellow, 24);
  n = 0;
  for (const x of [-13.5, 13.5]) {
    for (const z of [-8, 8]) {
      for (let i = -2; i <= 2; i++) {
        matrix.compose(
          new THREE.Vector3(x + i * 0.62, 0.024, z),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, Math.PI / 4, 0, 'YXZ')),
          one,
        );
        hazards.setMatrixAt(n++, matrix);
      }
    }
  }
  hazards.count = n;
  hazards.frustumCulled = false;
  scene.add(hazards);
}

function signTexture(title, subtitle, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#14272d';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = color;
  ctx.lineWidth = 16;
  ctx.strokeRect(14, 14, canvas.width - 28, canvas.height - 28);
  ctx.fillStyle = color;
  ctx.font = '900 116px Arial Black, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, canvas.width / 2, 108);
  ctx.fillStyle = '#dce7e7';
  ctx.font = '700 30px Arial, sans-serif';
  ctx.letterSpacing = '8px';
  ctx.fillText(subtitle, canvas.width / 2, 197);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function wallSign(scene, { title, subtitle, color, x, y, z, ry = 0, w = 6.8, h = 2.25 }) {
  const mat = new THREE.MeshBasicMaterial({
    map: signTexture(title, subtitle, color),
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  mesh.position.set(x, y, z);
  mesh.rotation.y = ry;
  scene.add(mesh);
}

function buildWayfinding(scene) {
  // Four wall-mounted signs: the wall is already solid exactly where each plane sits.
  wallSign(scene, { title: 'ALPHA', subtitle: 'WEST LONG', color: '#59a9df', x: -31.48, y: 4.7, z: 8, ry: Math.PI / 2 });
  wallSign(scene, { title: 'BRAVO', subtitle: 'EAST LONG', color: '#ef9a46', x: 31.48, y: 4.7, z: -8, ry: -Math.PI / 2 });
  wallSign(scene, { title: 'F64', subtitle: 'RECLAMATION YARD', color: '#e5aa48', x: -10, y: 5.5, z: -31.48 });
  wallSign(scene, { title: 'MID', subtitle: 'CONTROL DECK', color: '#d9e4e5', x: 10, y: 5.5, z: 31.48, ry: Math.PI });
}

function buildStructuralDetail(scene) {
  const trimMat = material(STEEL, { roughness: 0.55, metalness: 0.42 });
  const lightSteel = material(STEEL_LIGHT, { roughness: 0.64, metalness: 0.3 });
  const safetyMat = material(SAFETY_DARK, { roughness: 0.7, metalness: 0.14 });

  // Outer-wall ribs sit wholly inside the one-unit shell. Their changing rhythm gives
  // movement parallax without introducing a ledge the collision server does not know.
  const ribs = [];
  for (let p = -27; p <= 27; p += 6) {
    ribs.push({ x: p, y: 4.5, z: -31.73, w: 0.28, h: 9, d: 0.42 });
    ribs.push({ x: p, y: 4.5, z: 31.73, w: 0.28, h: 9, d: 0.42 });
    ribs.push({ x: -31.73, y: 4.5, z: p, w: 0.42, h: 9, d: 0.28 });
    ribs.push({ x: 31.73, y: 4.5, z: p, w: 0.42, h: 9, d: 0.28 });
  }
  mergedBoxes(scene, ribs, trimMat);

  // Steel caps and corner braces turn every existing wallB box into deliberate modular
  // cover. All pieces are inset into the cover volume, so collision is still exact.
  const caps = [];
  const braces = [];
  for (const b of WORLD_BOXES.filter((q) => q.c === 'wallB')) {
    caps.push({ x: b.x, y: b.y + b.h / 2 - 0.035, z: b.z, w: b.w, h: 0.07, d: b.d });
    const insetX = Math.max(0, b.w / 2 - 0.075);
    const insetZ = Math.max(0, b.d / 2 - 0.075);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      braces.push({ x: b.x + sx * insetX, y: b.y, z: b.z + sz * insetZ, w: 0.15, h: b.h, d: 0.15 });
    }
  }
  mergedBoxes(scene, caps, lightSteel);
  mergedBoxes(scene, braces, trimMat);

  // Divider top caps and orange door jambs live inside the 4u walls. The jambs make all
  // four tactically important doorways visible through smoke and peripheral vision.
  const dividerCaps = [];
  const jambs = [];
  for (const b of WORLD_BOXES.filter((q) => q.c === 'wallA' && q.w === 1.2 && q.h === 4 && q.d === 12)) {
    dividerCaps.push({ x: b.x, y: b.y + b.h / 2 - 0.05, z: b.z, w: b.w, h: 0.1, d: b.d });
    for (const end of [-1, 1]) jambs.push({
      x: b.x,
      y: 2,
      z: b.z + end * (b.d / 2 - 0.07),
      w: b.w,
      h: 4,
      d: 0.14,
    });
  }
  mergedBoxes(scene, dividerCaps, trimMat);
  mergedBoxes(scene, jambs, safetyMat);

  const gantry = new THREE.Mesh(
    new THREE.PlaneGeometry(8.4, 0.9),
    new THREE.MeshBasicMaterial({ map: signTexture('MID', 'F64 CONTROL', '#e5aa48'), side: THREE.DoubleSide, toneMapped: false }),
  );
  gantry.position.set(0, 6.55, 0.41);
  scene.add(gantry);
}

function buildSky(scene) {
  const geo = new THREE.SphereGeometry(ARENA * 3.5, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      zenith: { value: new THREE.Color(0x70a6c2) },
      horizon: { value: new THREE.Color(0xe6ece8) },
      sunColor: { value: new THREE.Color(0xffd59b) },
      sunDir: { value: new THREE.Vector3(0.46, 0.78, 0.32).normalize() },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vDir;
      uniform vec3 zenith;
      uniform vec3 horizon;
      uniform vec3 sunColor;
      uniform vec3 sunDir;
      void main() {
        float h = smoothstep(-0.08, 0.78, max(vDir.y, -0.08));
        vec3 col = mix(horizon, zenith, h);
        float sun = pow(max(dot(normalize(vDir), sunDir), 0.0), 320.0);
        col += sunColor * sun * 1.7;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.renderOrder = -1000;
  scene.add(sky);
}

function buildSkyline(scene) {
  const concrete = material(0x56666a, { roughness: 0.95 });
  const dark = material(0x25383d, { roughness: 0.72, metalness: 0.24 });
  const glass = material(GLASS, { roughness: 0.3, metalness: 0.22, emissive: 0x173741, emissiveIntensity: 0.25 });

  // Everything begins outside ±32.5. The skyline gives each compass direction its own
  // memory: refinery north, water tanks south, compact works east/west.
  mergedBoxes(scene, [
    { x: -19, y: 8, z: -42, w: 8, h: 16, d: 7 },
    { x: -6, y: 5.5, z: -41, w: 11, h: 11, d: 6 },
    { x: 18, y: 7, z: -44, w: 12, h: 14, d: 8 },
    { x: -17, y: 4, z: 42, w: 15, h: 8, d: 7 },
    { x: 17, y: 5, z: 44, w: 12, h: 10, d: 9 },
    { x: -42, y: 6, z: -16, w: 8, h: 12, d: 14 },
    { x: 43, y: 4.5, z: 18, w: 9, h: 9, d: 16 },
  ], concrete);
  mergedBoxes(scene, [
    { x: -21, y: 17, z: -42, w: 2.2, h: 18, d: 2.2 },
    { x: 19, y: 19, z: -44, w: 2.6, h: 24, d: 2.6 },
    { x: -12, y: 10, z: 43, w: 0.7, h: 12, d: 0.7 },
    { x: 38, y: 10, z: -20, w: 1.2, h: 16, d: 1.2 },
  ], dark);
  mergedBoxes(scene, [
    { x: -6, y: 7.3, z: -37.97, w: 7, h: 1.5, d: 0.08 },
    { x: 17, y: 7, z: 39.47, w: 7, h: 1.2, d: 0.08 },
  ], glass, { shadows: false });

  // Cylindrical storage tanks make the south horizon unmistakable without adding enough
  // individual meshes to hurt low-end hardware.
  const tankMat = material(0x74868a, { roughness: 0.68, metalness: 0.3 });
  for (const x of [-8, 1, 10]) {
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(3.1, 3.1, 7.5, 14), tankMat);
    tank.position.set(x, 3.75, 42);
    tank.castShadow = tank.receiveShadow = true;
    scene.add(tank);
  }
}

/** Build the complete static environment. Kept to a small set of merged meshes: the new
 * detail is paid for mostly in vertices, not draw calls, and never adds server work. */
export function buildEnvironment(scene) {
  buildSky(scene);
  buildCollisionSkin(scene);
  buildFloorLanguage(scene);
  buildStructuralDetail(scene);
  buildWayfinding(scene);
  buildSkyline(scene);
}
