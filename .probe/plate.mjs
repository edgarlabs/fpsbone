// Is the rank plate actually on screen, above the head, and gone when something is in front
// of it — measured in pixels, in the real engine.
//
// verify.mjs Part J pins everything about the plate that is arithmetic: the crown clearance at
// every crouch depth, the billboard yaw over 322 camera bearings, one owner for `visible`. All
// of that runs on a stubbed avatar with no GPU in it, and none of it can see the property the
// feature was actually built on — that occlusion is the DEPTH BUFFER and nothing else. There is
// no ray test, no visibility flag and no server help behind a plate disappearing behind cover.
// `plate.visible` stays true the whole time; the pixels simply lose the depth test.
//
// So the measurement has to be pixels, and the trick is isolating them:
//
//   render the frame as it is → hide ONE plate → render again → count what changed.
//
// Everything else in those two frames is identical, so the difference IS that plate, after fog,
// after the depth buffer, after every wall and every other body in the way. Nothing is asked
// about or inferred; the count is whatever the GPU already decided.
//
// Four questions, in the order they are worth asking:
//
//   drawn      over a sweep of live frames, how many pixels each visible plate gets. A plate
//              nobody can see is the failure this catches. Which plates are in view is luck —
//              it depends where the bots wandered — so this says how often, not how big.
//   size       how big, deliberately: one plate, with the camera doing the moving, so range is
//              chosen rather than waited for. A quad sized in the WORLD halves its height for
//              twice the distance, and that is the check — up to the point where the plate is a
//              few pixels tall and whole-pixel quantisation puts a floor under the count.
//   placed     for the best-framed sample, where those pixels are relative to the body's own
//              topmost pixel — the plate has to sit ABOVE the head, not across the face.
//   hidden     the two occluders, separately. A wall, classified by the real rayWorld against
//              the real WORLD_BOXES, which is the case a ray test could also have handled; and
//              a BODY moved onto the line of sight, which is the case it could not — rayWorld
//              sees only map boxes, so a plate over an enemy behind another enemy is the whole
//              reason the depth buffer does this job.
//
// Two things this probe needs that the viewmodel probes did not, both because a plate lives on
// somebody ELSE's head:
//
//   heads         a plate needs somebody to sit above, and this probe used to have to ask for
//                 bots itself: a fresh profile defaulted to VS AI off, so it joined an empty
//                 room and the first run of this file measured nobody and reported clean. The
//                 lobby now backfills — one human in a ten-slot room means nine bots, with
//                 nothing requested — so connecting IS the population step. It still refuses
//                 to report until heads actually arrive, because a probe that passes on an
//                 empty room is the failure this note exists to remember.
//   aim           the local player faces wherever the spawn put them. A plate off screen cannot
//                 be measured at all, and — worse — every sample that would have tested the
//                 WALL case is exactly the one that is out of frame. So each measurement aims
//                 the camera at the plate it is about to measure. That biases nothing: the depth
//                 test does not care where you are looking, only what is between.
import { withPage } from './cdp.mjs';

// vite.config.js roots the dev server at client/ and allows reading one level up, so shared/
// is outside the served root and reachable only through Vite's /@fs/ escape hatch. Taken from
// this file's own URL rather than from cwd, so the probe runs the same from anywhere — and from
// `pathname` rather than fileURLToPath because a URL path is already forward-slashed, which is
// the form /@fs/ wants on Windows too.
const FS = decodeURIComponent(new URL('..', import.meta.url).pathname);

const SETUP = `(async () => {
  const d = window.__dbg, { renderer, scene, camera } = d.view;
  const gl = renderer.getContext();
  const V = camera.position.constructor;
  const { rayWorld } = await import('/@fs${FS}shared/collide.js');
  const { WORLD_BOXES } = await import('/@fs${FS}shared/map.js');
  const C = await import('/@fs${FS}shared/constants.js');

  // A plate is the only textured thing in the scene — render.js:1-6 says the style is
  // untextured boxes and capsules, and the CanvasTexture is the first exception to it. Matching
  // on that rather than on tree position, for vm2.mjs's reason: any reshuffle of the rig moves
  // an index, and a probe that silently measures the wrong node is worse than one that throws.
  const plates = () => {
    const out = [];
    scene.traverse((o) => {
      if (o.isMesh && o.material && o.material.map && o.geometry.type === 'PlaneGeometry') {
        out.push(o);
      }
    });
    return out;
  };
  const px = (v) => {
    const c = v.clone().project(camera);
    return { x: (c.x * 0.5 + 0.5) * gl.drawingBufferWidth,
             y: (c.y * 0.5 + 0.5) * gl.drawingBufferHeight, z: c.z, on: Math.abs(c.x) <= 1 && Math.abs(c.y) <= 1 && c.z < 1 };
  };

  // Pixels belonging to exactly one object, by difference. readPixels' origin is bottom-left,
  // so a larger y is higher up the screen — which is the direction "above the head" is in.
  const shot = (w, h, x0, y0) => {
    const buf = new Uint8Array(w * h * 4);
    renderer.autoClear = true;
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  };
  const diff = (A, B, w, h, x0, y0) => {
    let n = 0, lo = 1e9, hi = -1e9, xlo = 1e9, xhi = -1e9, cx = 0, cy = 0;
    for (let i = 0; i < w * h; i++) {
      const j = i * 4;
      if (A[j] === B[j] && A[j + 1] === B[j + 1] && A[j + 2] === B[j + 2]) continue;
      const ix = i % w, iy = (i - ix) / w;
      n++; cx += x0 + ix; cy += y0 + iy;
      if (y0 + iy < lo) lo = y0 + iy;
      if (y0 + iy > hi) hi = y0 + iy;
      if (x0 + ix < xlo) xlo = x0 + ix;
      if (x0 + ix > xhi) xhi = x0 + ix;
    }
    return n ? { n, lo, hi, xlo, xhi, cx: cx / n, cy: cy / n } : { n: 0 };
  };
  // A window around the plate, big enough to hold a five-star plate close up and small enough
  // that reading it back is cheap at 60Hz.
  const win = (p, pad) => {
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    const s = px(p.getWorldPosition(new V()));
    if (!s.on) return null;
    const x0 = Math.max(0, Math.round(s.x) - pad), y0 = Math.max(0, Math.round(s.y) - pad);
    const w = Math.min(W - x0, pad * 2), h = Math.min(H - y0, pad * 2);
    return w > 4 && h > 4 ? { x0, y0, w, h, s } : null;
  };
  const pixOf = (p, pad = 30) => {
    scene.updateMatrixWorld(true);
    const q = win(p, pad);
    if (!q) return null;
    const A = shot(q.w, q.h, q.x0, q.y0);
    const was = p.visible;
    p.visible = false;
    const B = shot(q.w, q.h, q.x0, q.y0);
    p.visible = was;
    return { ...diff(A, B, q.w, q.h, q.x0, q.y0), sx: q.s.x, sy: q.s.y };
  };
  // The same difference, taken against the whole avatar hidden, which gives the body's own
  // pixels — the only honest reference for "above the head" that does not restate a constant
  // from render.js in this file.
  const bodyTop = (p, pad = 60) => {
    scene.updateMatrixWorld(true);
    const g = p.parent;
    const q = win(p, pad);
    if (!q) return null;
    const A = shot(q.w, q.h, q.x0, q.y0);
    const wasP = p.visible;
    p.visible = false;
    const noPlate = shot(q.w, q.h, q.x0, q.y0);
    const wasG = g.visible;
    g.visible = false;
    const none = shot(q.w, q.h, q.x0, q.y0);
    g.visible = wasG;
    p.visible = wasP;
    return { plate: diff(A, noPlate, q.w, q.h, q.x0, q.y0),
             body: diff(noPlate, none, q.w, q.h, q.x0, q.y0) };
  };
  const dist = (p) => camera.position.distanceTo(p.getWorldPosition(new V()));
  // The same difference trick pointed at any object: what does hiding g change, inside the window
  // around p. Used on the OCCLUDER, because a body that draws nothing where it was put has not
  // tested occlusion at all — and without measuring it, that case is indistinguishable from a
  // depth test that failed. One run reported exactly that shape, and this is what it took to
  // tell the two apart.
  const footOf = (g, p, pad = 30) => {
    scene.updateMatrixWorld(true);
    const q = win(p, pad);
    if (!q) return null;
    const A = shot(q.w, q.h, q.x0, q.y0);
    const was = g.visible;
    g.visible = false;
    const B = shot(q.w, q.h, q.x0, q.y0);
    g.visible = was;
    return diff(A, B, q.w, q.h, q.x0, q.y0);
  };
  // Point the camera at one plate, for the length of one measurement. The frame loop writes the
  // camera from the predictor every frame, so this lasts until the next rAF and no longer — and
  // the renders that matter happen synchronously inside pixOf, before that.
  const aimAt = (p) => {
    camera.lookAt(p.getWorldPosition(new V()));
    camera.updateMatrixWorld(true);
  };
  // Stand off at a given distance ALONG THE SIGHTLINE the camera already has. The direction is
  // deliberately unchanged: the billboard's yaw was resolved against the real camera position
  // one frame ago, so sliding in and out along that same line keeps the plate face-on, while
  // stepping sideways would foreshorten it and blame the geometry for the probe's own move.
  // Same lifetime as aimAt — the frame loop rewrites the camera from the predictor next rAF.
  // Whether any bot is in the open is luck: they wander, the local player stands on its spawn,
  // and one run had all 122 samples wholly behind geometry — three sections reported "nothing to
  // measure", which is honest but useless. So wait for it. Poll frames until some plate is both
  // unblocked and drawing pixels, and hand that one back; a run where nothing ever comes into the
  // open says so rather than reporting a clean nothing.
  //
  // Waiting rather than walking the camera somewhere clear, deliberately: the billboard's yaw was
  // resolved against the real camera position by the frame loop, so any move OFF that sightline
  // views the plate edge-on and measures the probe's own detour. Along the line is free; across it
  // is not.
  const waitClear = async (maxFrames) => {
    for (let i = 0; i < maxFrames; i++) {
      // Every plate each frame, and the NEAREST of whatever is clear. Not the first one found —
      // that handed the placement check a plate at 37u whose body was four pixels. Not the one
      // drawing the most pixels either: a five-star badge at 36u outdraws a one-chevron at 10u, so
      // pixel count ranks tiers, not framing. Distance is the one criterion that is tier-blind, and
      // it is what makes the body big enough to measure the plate against.
      let best = null;
      for (const p of plates()) {
        if (!p.visible) continue;
        aimAt(p);
        if (blockedRays(p) !== 0) continue;
        const m = pixOf(p);
        if (!m || !m.n) continue;
        const d = dist(p);
        if (!best || d < best.d) best = { p, d, n: m.n, waited: i };
      }
      if (best) return best;
      await new Promise((r) => requestAnimationFrame(r));
    }
    return null;
  };
  const standOff = (p, d) => {
    const t = p.getWorldPosition(new V());
    const o = camera.position;
    const dx = o.x - t.x, dy = o.y - t.y, dz = o.z - t.z;
    const L = Math.hypot(dx, dy, dz);
    camera.position.set(t.x + (dx / L) * d, t.y + (dy / L) * d, t.z + (dz / L) * d);
    aimAt(p);
  };
  // Wall occlusion as the map itself sees it: the real rayWorld over the real WORLD_BOXES,
  // which is exactly the test the plan considered and rejected — kept here as the classifier,
  // not as the mechanism.
  const oneRay = (t) => {
    const o = camera.position;
    const dx = t.x - o.x, dy = t.y - o.y, dz = t.z - o.z;
    const L = Math.hypot(dx, dy, dz);
    return rayWorld(o.x, o.y, o.z, dx / L, dy / L, dz / L, WORLD_BOXES, L) < L - 1e-3;
  };
  const wallBlocked = (p) => oneRay(p.getWorldPosition(new V()));
  // The same question asked five times — the four corners of the quad and its centre — because a
  // plate is an AREA and one ray is a point. This is the plan's stated reason for not gating the
  // plate on a ray test, and here it is measurable rather than arguable: a sample whose centre
  // ray is blocked while a corner is clear SHOULD be drawing pixels, and a ray gate would have
  // hidden it. localToWorld puts the corners through the billboard's own matrix, so they are
  // the corners as drawn, at whatever yaw and width this tier ended up with. No backticks in
  // here: this whole block is a template literal, and one would end it mid-comment.
  const blockedRays = (p) => {
    scene.updateMatrixWorld(true);
    const { width, height } = p.geometry.parameters;
    let n = 0;
    for (const c of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]]) {
      if (oneRay(p.localToWorld(new V(c[0] * width * 0.5, c[1] * height * 0.5, 0)))) n++;
    }
    return n;
  };
  window.__plate = { plates, pixOf, bodyTop, footOf, dist, wallBlocked, blockedRays, aimAt,
                     standOff, waitClear, px, V, C, camera, scene };
  return { n: plates().length, w: gl.drawingBufferWidth, h: gl.drawingBufferHeight };
})()`;

// WAIT for the house the server already filled. There is no request to make any more: the
// room seats ten and the backfill in server/index.js hands every slot the one human did not
// take to a bot, so the avatars are on their way before this runs. Bots are still better than
// a second browser here — their careers are seeded across the whole ladder (room.js:322), so
// the plates on screen are a MIX of tiers rather than six copies of one.
const POPULATE = `(async () => {
  const P = window.__plate;
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    if (P.plates().length >= 3) break;
  }
  const ps = P.plates();
  return { n: ps.length, widths: [...new Set(ps.map((p) => +p.geometry.parameters.width.toFixed(4)))] };
})()`;

const SWEEP = `(async () => {
  const P = window.__plate;
  const rows = [];
  for (let f = 0; f < 900; f++) {
    await new Promise((r) => requestAnimationFrame(r));
    if (f % 9) continue;
    for (const p of P.plates()) {
      if (!p.visible) continue;
      P.aimAt(p);
      const m = P.pixOf(p);
      if (!m) continue;
      rows.push({ f, n: m.n, d: +P.dist(p).toFixed(2), wall: P.wallBlocked(p),
                  blk: P.blockedRays(p), pw: +p.geometry.parameters.width.toFixed(4) });
    }
  }
  return rows;
})()`;

// A body moved onto the line of sight, which is the case no ray against the map can see. The
// occluder is a real player avatar, already in the scene, with its own real box — only its
// position is set, and only for the two renders that measure it.
const BODY = `(async () => {
  const P = window.__plate;
  const { V, camera } = P;
  const got = await P.waitClear(1200);
  if (!got) return { err: 'no plate came into the open inside 20s, so nothing could be put in front of one' };
  const { p } = got;
  P.aimAt(p);
  const b0 = P.pixOf(p) || { n: 0 };
  const before = b0.n;
  const d = P.dist(p);
  const others = [...new Set(P.plates().map((q) => q.parent))].filter((g) => g !== p.parent);
  if (!others.length) return { err: 'only one avatar in the scene' };

  // A corpse mid-fade is TRANSPARENT — setAvatarOpacity (render.js:97) flips the flag on the body
  // materials the moment opacity leaves 1, and render.js:1650 is the only thing that does it. A
  // transparent occluder cannot occlude: it draws in the sorted transparent pass, so the FARTHER
  // plate is painted first and the corpse blends over it. Correct rendering, useless occluder —
  // and it is what one run of this step was silently measuring, a body drawing 152 px of its own
  // with the plate still at full count, reported as if the depth test had failed. So the occluder
  // has to be opaque, and the ones that are not are named rather than passed over. The plate and
  // the spawn ring are transparent by design and are not the body; they are excluded by geometry.
  const bodyOpacity = (g) => {
    let minOp = 1, anyTr = false, n = 0;
    g.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const t = o.geometry.type;
      if (t === 'PlaneGeometry' || t === 'RingGeometry') return;
      n++;
      minOp = Math.min(minOp, o.material.opacity ?? 1);
      if (o.material.transparent) anyTr = true;
    });
    return { minOp, anyTr, n };
  };

  const target = p.getWorldPosition(new V());
  const o = camera.position.clone();
  // On the sightline, so the body's origin projects exactly onto the plate, and CLOSE to the
  // camera rather than most of the way to the plate. Two thirds of the way looks like the natural
  // choice and is not: at 19u a torso is about 0.4u wide, which is seven pixels, against a badge
  // ten pixels wide at 28u — the rows covered, the columns did not, and the plate leaked round the
  // edges of its own occluder for a measured 12 px. Angular size is what occlusion needs, so the
  // body is put a few metres from the camera where it is far bigger than the plate, still on the
  // same line and still unambiguously in front of it.
  const near = Math.min(0.66 * d, 4);
  const f = near / d;
  const at = new V(o.x + (target.x - o.x) * f, o.y + (target.y - o.y) * f, o.z + (target.z - o.z) * f);
  const skipped = [];
  for (const g of others) {
    const op = bodyOpacity(g);
    if (op.anyTr || op.minOp < 1 - 1e-6) {
      skipped.push('a corpse at opacity ' + op.minOp.toFixed(2));
      continue;
    }
    const keep = g.position.clone();
    g.position.copy(at);
    // Did it move at all? A group with matrixAutoUpdate off would ignore this and render exactly
    // where it was, and the whole step would then be measuring an occluder that is not there.
    P.scene.updateMatrixWorld(true);
    const landed = g.getWorldPosition(new V());
    const slip = +Math.hypot(landed.x - at.x, landed.y - at.y, landed.z - at.z).toFixed(3);
    // What the occluder itself draws, in the same window. A body that puts no pixels there has
    // not tested occlusion, and saying so is the difference between a result and a guess.
    const own = P.footOf(g, p);
    const during = P.pixOf(p);
    const stillVisible = p.visible;
    g.position.copy(keep);
    const after = P.pixOf(p);
    if (own && own.n > 0) {
      // And it has to cover the box the plate is IN — both axes. One run found an opaque body that
      // drew 119 px with its centroid 20 rows BELOW the plate, in front of the chest rather than
      // the badge, and scored that as the depth test failing. Another covered every row and only
      // seven of the plate's ten columns, and scored a 12 px leak the same way. A body in front of
      // the head is the claim; the bounding box is what tells that apart from a near miss.
      const covers = own.lo <= b0.lo && own.hi >= b0.hi && own.xlo <= b0.xlo && own.xhi >= b0.xhi;
      if (!covers) {
        skipped.push('a body drawing ' + own.n + ' px over x ' + own.xlo + '-' + own.xhi + ', y '
          + own.lo + '-' + own.hi + ', which misses the plate at x ' + b0.xlo + '-' + b0.xhi
          + ', y ' + b0.lo + '-' + b0.hi);
        continue;
      }
      return { d: +d.toFixed(2), before, during: during ? during.n : null,
               after: after ? after.n : null, stillVisible, ownN: own.n, minOp: op.minOp,
               tried: skipped.length + 1, of: others.length, skipped, slip,
               // Both centroids AND both bounding boxes, so "in front of it" is measured rather
               // than asserted: the occluder's pixels have to cover the plate's on both axes.
               plateAt: [+b0.cx.toFixed(0), +b0.cy.toFixed(0)],
               ownAt: [+own.cx.toFixed(0), +own.cy.toFixed(0)],
               plateBox: [b0.xlo, b0.xhi, b0.lo, b0.hi], ownBox: [own.xlo, own.xhi, own.lo, own.hi],
               occluderAt: +Math.hypot(at.x - o.x, at.y - o.y, at.z - o.z).toFixed(2) };
    }
    skipped.push('an opaque body that drew 0 px where it was put');
  }
  return { err: 'no usable occluder among ' + others.length + ' candidates (' + skipped.join('; ')
    + '), so occlusion by a body went UNTESTED' };
})()`;

// Pixels against distance, on one plate, with the camera doing the moving. The live sweep above
// says how often a plate is on screen in a real match, which is luck; this says how BIG it is at
// a given range, which is the number the design rests on. A world-sized quad has to fall off as
// 1/d² in area, so px·d² is the invariant to watch — if it holds, the plate is genuinely in the
// world and not pinned to the screen, and the count at 20u is directly comparable to the claim
// in render.js:162. Every rung is re-checked for occlusion, and a blocked rung is reported as
// blocked rather than as a small plate.
const LADDER = `(async () => {
  const P = window.__plate;
  const got = await P.waitClear(1200);
  if (!got) return { err: 'no plate came into the open inside 20s, so range went unmeasured' };
  const { p } = got;
  const keep = P.camera.position.clone();
  const pw = +p.geometry.parameters.width.toFixed(4);
  const rows = [];
  for (const d of [4, 6, 8, 12, 16, 20, 26, 32, 40]) {
    P.standOff(p, d);
    const blk = P.blockedRays(p);
    // A window wide enough for the whole plate at this range, or the count is a crop of it.
    const m = P.pixOf(p, Math.min(240, Math.max(30, Math.round(520 / d))));
    rows.push({ d, blk, n: m ? m.n : null, rows: m && m.n ? m.hi - m.lo + 1 : 0 });
  }
  P.camera.position.copy(keep);
  return { pw, rows };
})()`;

const PLACE = `(async () => {
  const P = window.__plate;
  const got = await P.waitClear(1200);
  if (!got) return { err: 'no plate came into the open inside 20s, so placement went unmeasured' };
  const { p } = got;
  const keep = P.camera.position.clone();
  // Close in, along the sightline. At 32u the plate is two pixel rows tall and the clearance above
  // the head is a fifth of a pixel — a gap that reads as 1 px whatever it really is. Moving IN
  // cannot introduce an occluder, because the new segment is a subset of a line already measured
  // clear, so this buys resolution for free. 4u puts the plate at ~16 rows and the body at ~150.
  P.standOff(p, 4);
  const d = P.dist(p);
  const blk = P.blockedRays(p);
  // Pad by range: the body's own topmost pixel and its centroid are only honest if the whole body
  // is inside the window, and a body at 4u fills eight times the box a body at 32u does.
  const m = P.bodyTop(p, Math.min(240, Math.max(60, Math.round(700 / d))));
  P.camera.position.copy(keep);
  if (blk) return { err: 'the plate was occluded after closing in, so placement went unmeasured' };
  if (!m || !m.plate.n || !m.body.n) return { err: 'plate and body were not both drawn in one window' };
  const { plate, body } = m;
  const plateRows = plate.hi - plate.lo + 1;
  const plateH = p.geometry.parameters.height;
  // Is the body drawn to its full height, or is this a bot behind cover with only its head out?
  // The question matters because the gap below is measured against the body's topmost VISIBLE
  // pixel, and if the crown is the thing behind the wall then that pixel is not the crown and the
  // number means nothing. The plate's own geometry gives the scale for free — both are quads in the
  // same world at the same range — so the expected ratio is exact rather than a guess.
  const wantRows = ((2 * P.C.PLAYER_HALF_H) / plateH) * plateRows;
  // The plate is its own ruler: it is plateH world units tall and plateRows pixels tall, so every
  // pixel in this window is worth plateH/plateRows world units. That turns the gap into a length
  // without knowing the FOV, the resolution, or the range.
  const uPerPx = plateH / plateRows;
  const gapPx = plate.lo - body.hi;
  // Sideways placement against the body's AXIS, not against its pixel centroid. The centroid is
  // dragged several pixels by whichever arm is holding the gun out, so it is not the midline of the
  // head; the group's origin projected to screen is, exactly. Both are reported, because the
  // difference between them is the arm and it is worth seeing rather than averaging away.
  const axis = P.px(p.parent.getWorldPosition(new P.V()));
  return { d: +d.toFixed(2), plateN: plate.n, bodyN: body.n,
           gap: +gapPx.toFixed(1), gapU: +(gapPx * uPerPx).toFixed(3),
           dx: +(plate.cx - axis.x).toFixed(1), dxBlob: +(plate.cx - body.cx).toFixed(1),
           plateRows, bodyRows: body.hi - body.lo + 1, wantRows: +wantRows.toFixed(0),
           // What the source asks for, computed rather than restated: the plate's bottom edge in
           // group space against an uncrouched crown. Crouching only lowers the crown, so this is
           // the worst case, and it is the number the measured gap has to agree with.
           designU: +(p.position.y - plateH / 2 - P.C.PLAYER_HALF_H).toFixed(3),
           plateY: +p.position.y.toFixed(3), plateH: +plateH.toFixed(3), waited: got.waited };
})()`;

const r = await withPage('http://localhost:5173/?mode=dm', async ({ evaluate }) => {
  await evaluate("document.getElementById('start')?.click(); 1");
  await evaluate('new Promise((r) => setTimeout(r, 5000))');
  const found = await evaluate(SETUP);
  const filled = await evaluate(POPULATE);
  const sweep = await evaluate(SWEEP);
  const ladder = await evaluate(LADDER);
  const place = await evaluate(PLACE);
  const body = await evaluate(BODY);
  return { found, filled, sweep, ladder, place, body };
});

const { found, filled, sweep, ladder, place, body } = r;
console.log(`\n${found.w}x${found.h} frame, so a 1080p screen shows ${(1080 / found.h).toFixed(1)}x these pixel counts`);
console.log(`plates on join: ${found.n} → after asking for bots: ${filled.n}`);
console.log(`  ${filled.widths.length} distinct plate widths built: ${filled.widths.join(', ')} world units`
  + ' — the per-tier geometry, read off the scene graph');
if (!filled.n) {
  console.log('\nNOTHING TO MEASURE — no avatar ever carried a plate, so every section below'
    + ' would report clean without having looked at anything. Stopping here.');
  process.exit(1);
}

const drawn = sweep.filter((q) => q.n > 0);
const clear = sweep.filter((q) => q.blk === 0);
const walled = sweep.filter((q) => q.wall);
const pct = (a, b) => `${b ? ((100 * a) / b).toFixed(0) : 0}%`;

console.log('\ndrawn — every visible plate over ~15s of live frames, camera aimed at each');
console.log(`  ${sweep.length} samples, ${drawn.length} with pixels on screen (${pct(drawn.length, sweep.length)})`);
if (!sweep.length) console.log('  NO SAMPLES — nothing below this line was measured');
if (drawn.length) {
  const ds = drawn.map((q) => q.d), ns = drawn.map((q) => q.n);
  // No per-distance average off this sample: it mixes tiers, and a five-star plate at 40u
  // outdraws a one-chevron plate at 20u. Size against range is the ladder's question, on one
  // plate, which is the section below.
  console.log(`  ${Math.min(...ds)}–${Math.max(...ds)}u away, ${Math.min(...ns)}–${Math.max(...ns)} px`
    + `, across ${[...new Set(drawn.map((q) => q.pw))].length} different tiers`);
}

console.log('\nsize against range — one plate, camera standing off along its own sightline');
if (ladder.err) console.log(`  ${ladder.err}`);
else {
  const narrow = Math.min(...filled.widths);
  console.log(`  a ${ladder.pw}u-wide plate — `
    + (ladder.pw <= narrow + 1e-9
      ? 'the narrowest in the room, so the worst case for legibility'
      : `${(ladder.pw / narrow).toFixed(1)}x the narrowest in the room`));
  for (const q of ladder.rows) {
    console.log(`    ${String(q.d).padStart(3)}u  `
      + (q.blk
        ? `blocked on ${q.blk} of 5 rays — ${q.n} px, which is occlusion and not size`
        : `${String(q.n).padStart(4)} px over ${String(q.rows).padStart(2)} rows`
          + `   ≈ ${(q.n * (1080 / found.h) ** 2).toFixed(0)} px on a 1080p screen`));
  }
  const clean = ladder.rows.filter((q) => !q.blk && q.n);
  const at = (d) => clean.find((q) => q.d === d);
  // Height, not area, and only where the far rung still has rows to lose: a bounding box
  // three pixels tall cannot report a halving it does not have room for.
  const pairs = clean.map((a) => [a, at(a.d * 2)]).filter(([, b]) => b && b.rows >= 3);
  for (const [a, b] of pairs) {
    // A bounding box is counted in whole rows, so any prediction it is asked to match can be a
    // row out and still be exactly right. Only more than that is a miss.
    const want = a.rows / 2;
    const off = Math.abs(b.rows - want);
    console.log(`  ${a.d}u → ${b.d}u: ${a.rows} → ${b.rows} rows, halving wants ${want.toFixed(1)}`
      + (off <= 1 ? ' — inside one pixel row of it' : ` — OFF by ${off.toFixed(1)} rows`));
  }
  if (!pairs.length) console.log('  no doubling pair survived unblocked, so this says nothing');
  const small = clean.reduce((a, q) => (q.n < a.n ? q : a));
  const inv = clean.map((q) => q.n * q.d * q.d);
  const lo = Math.min(...inv), hi = Math.max(...inv);
  console.log(`  px·d² over the ${clean.length} clear rungs: ${lo.toFixed(0)}–${hi.toFixed(0)}`
    + `, ${((hi / lo - 1) * 100).toFixed(0)}% spread. It rises with range rather than staying`
    + ` flat, and the floor is why: the smallest reading was ${small.n} px over ${small.rows}`
    + ` rows at ${small.d}u, where a mark thinner than one pixel still tints a whole one.`);
  console.log('  So the near rungs carry the world-sizing check and the far ones are a floor'
    + ' in the measurement, not extra size on screen.');
}

console.log('\nhidden by a wall — rayWorld against WORLD_BOXES, five rays per plate');
const nz = (xs) => xs.filter((q) => q.n > 0);
const full = sweep.filter((q) => q.blk === 5);
const part = sweep.filter((q) => q.blk > 0 && q.blk < 5);
console.log(`  nothing on any of the five rays: ${clear.length} samples, ${nz(clear).length} drew pixels (${pct(nz(clear).length, clear.length)})`);
console.log(`  wholly behind geometry, all five blocked: ${full.length} samples, ${nz(full).length} drew pixels (${pct(nz(full).length, full.length)})`);
console.log(`  partly behind it: ${part.length} samples, ${nz(part).length} drew pixels — correct, and one`
  + ` centre ray would have wrongly hidden ${part.filter((q) => q.wall && q.n > 0).length} of them`);
const leak = nz(full).sort((a, b) => b.n - a.n)[0];
if (leak) {
  console.log(`  worst leak: ${leak.n} px at ${leak.d}u — pixels from a plate with all five`
    + ' rays blocked, which is a plate showing through a wall');
} else if (!full.length) {
  console.log('  UNTESTED — no sample was wholly behind geometry, so this case says nothing');
} else {
  console.log(`  none of those ${full.length} put a single pixel through a wall, and \`visible\` was`
    + ' true throughout');
}

console.log('\nplaced — the plate\'s own pixels against the body\'s own, in one window');
if (place.err) console.log(`  ${place.err}`);
else {
  console.log(`  at ${place.d}u: plate ${place.plateN} px over ${place.plateRows} rows, body`
    + ` ${place.bodyN} px over ${place.bodyRows} rows`);
  // A body drawn to less than half the height its own plate implies is a body behind cover, and
  // the gap below would then be measured to the top of a wall rather than to the top of a head.
  // A floor, not a target: everything parented to the group counts as body here, the spawn ring
  // on the ground included, so the count can overshoot without anything being wrong.
  const whole = place.bodyRows >= place.wantRows * 0.5;
  console.log(`  a body that tall is at least ${place.wantRows} rows at this range, so it is`
    + ` ${whole ? 'drawn whole and the crown is its own topmost pixel'
      : 'PARTLY HIDDEN — the gap below is to the top of what is visible, not to the crown'}`);
  console.log(`  ${place.gap >= 0 ? 'clear of the head by' : 'OVERLAPPING the head by'} ${Math.abs(place.gap)} px`
    + ` = ${Math.abs(place.gapU)}u, and ${Math.abs(place.dx)} px`
    + ` ${place.dx >= 0 ? 'right' : 'left'} of the body's own axis`
    + ` (${Math.abs(place.dxBlob)} px off its pixel centroid, which the gun arm drags sideways)`);
  // The measured gap against the source's own arithmetic. The computed figure is a MINIMUM, not a
  // prediction: the plate hangs off the body while the head pitches with the bot's aim, so a head
  // tilted down drops its crown out from under a plate that has not moved. Below it is the bug.
  const onePx = place.plateH / place.plateRows;
  console.log(`  the plate's bottom edge sits ${place.designU}u above an UNPITCHED, uncrouched crown`
    + ` (plate centre ${place.plateY}u, ${place.plateH}u tall), which is the smallest gap there`
    + ` should ever be — the head pitches with the bot's aim and the plate does not.`);
  console.log(`  measured ${place.gapU}u: ${place.gapU < place.designU - onePx
    ? 'CLOSER to the crown than the geometry allows'
    : place.gapU <= place.designU + onePx
      ? 'that clearance exactly, inside one pixel — a level head'
      : 'wider, which is a head pitched away from level'}`);
}

console.log('\nhidden by another body — the case a ray against the map cannot see');
if (body.err) console.log(`  ${body.err}`);
else {
  const box = (b) => `x ${b[0]}-${b[1]}, y ${b[2]}-${b[3]}`;
  console.log(`  plate at ${body.d}u drew ${body.before} px with the line of sight clear`
    + `, centred (${body.plateAt.join(', ')}) over ${box(body.plateBox)}`);
  console.log(`  an opaque body moved to ${body.occluderAt}u in front of it drew ${body.ownN} px of`
    + ` its own, centred (${body.ownAt.join(', ')}) over ${box(body.ownBox)}`);
  const covers = body.ownBox[0] <= body.plateBox[0] && body.ownBox[1] >= body.plateBox[1]
    && body.ownBox[2] <= body.plateBox[2] && body.ownBox[3] >= body.plateBox[3];
  console.log(`  that box ${covers ? 'encloses' : 'DOES NOT enclose'} the plate's`
    + `, at opacity ${body.minOp.toFixed(2)}, and the group landed ${body.slip}u from where it was put`);
  if (body.skipped.length) console.log(`  ${body.skipped.length} of ${body.of} candidates rejected`
    + ` before it: ${body.skipped.join('; ')}`);
  console.log(`  the plate behind it: ${body.during} px, and \`plate.visible\` was still ${body.stillVisible}`);
  console.log(`  body moved back: ${body.after} px`);
  console.log(`  → ${body.during === 0 && body.before > 0 && body.after > 0
    ? 'the depth buffer removed it and gave it back, with nothing touching `visible`'
    : 'NOT the expected before/during/after shape'}`);
}
