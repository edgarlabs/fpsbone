# .probe — empirical checks that `npm run verify` cannot do

`npm run verify` drives the server over real sockets. These drive the *browser*, via the
Chrome DevTools Protocol, because the bugs they were written for lived entirely in the
client and were invisible to a server test: a viewmodel that never finished swapping, a
camera reading the wrong variable, and a jam animation that played below the viewport.

They need both dev servers up:

    node server/index.js          # :8080
    npx vite --port 5173 --strictPort

## The two that are assertions

- `verify-snow.mjs` — snow mode really holds a snowball. Asserts on the *rendered* rig
  (a sphere and a sleeve, no gun geometry), the sound played, and the tracer count.
- `verify-look-fast.mjs` — the camera tracks the mouse, not the 60Hz tick. Runs with
  vsync off so rAF outruns the simulation, which is where the old code fell apart and the
  one condition a 60Hz headless run cannot reproduce.

## The driver and the metric

- `cdp.mjs` — launches headless Chrome, evaluates JS in the page.
  Note the explicit `Page.navigate`: the URL on the command line can land in a different
  target than the one `/json/list` hands back first.
- `vm2.mjs` — the shared screen-space metric, injected into the page by the rest of them.
  Projects every visible viewmodel mesh as a convex silhouette (near-plane clipped in
  camera space first), clips to the frame with Sutherland-Hodgman for exact on-screen
  area, and resolves who is in front with a per-pixel ray-box slab test rather than a
  sort. Fists are matched by their box PARAMETERS and sorted by the rest grip stashed on
  the hand group — not by tree position, and not by current depth, because the support
  hand ends up nearer the eye than the trigger hand mid-punch and a depth sort silently
  swaps the two. Exports `JAM_GUNS` (the seven weapons that can jam) and `page()`.

## The measurements behind the jam fix

None of these assert. They print numbers, and they exist so the next change to the pose
can be checked against the same numbers instead of against a screenshot.

- `jamdiag.mjs` — the summary: per weapon, how far the fist travels, what share of it is
  on screen at the worst frame, how far off the aim line it swings, how many frames touch
  the crosshair, and the screen share of gun / arm / fist.
- `pistolnum.mjs` — the raw depths and half-extents that `STRIKE_NEAR` was chosen from.
- `onthegun.mjs` — distance from the fist's centre to the nearest point of the gun's
  on-screen silhouette. Written after a centroid-based version was thrown away: a rifle's
  visible centroid sits at x = -0.24 while its receiver runs from -0.7 to +0.2, so a
  centroid cannot answer "is the hand on the gun".
- `occl.mjs`, `raycheck.mjs` — what is drawn over the fist, per grid cell.
  `raycheck.mjs` is the check that the depth test itself is right.
- `gunhide.mjs` — measures each frame twice, once with the support hand hidden, which is
  how the gun's own share was separated from what the new hand costs it.
- `restvis.mjs`, `who.mjs` — the rest baseline, and which part is on the crosshair.
  Coverage alone cannot tell a fist over the middle from a forearm sweeping through it.
- `jamshot.mjs` — screenshots. `W=1 MS=...` picks the weapon; `HIDE=hands` hides both
  hands, which is how the gun's jam pose was looked at on its own. It stubs
  `viewmodel.setWeapon` after calling through, because the game loop re-sets the weapon
  from the server's view every frame and otherwise every shot comes out as the rifle.
- `reloadshot.mjs` — the same for the shipped reload, as a scale reference.
- `scopejam.mjs` — the one that is about the scope rather than the pose. Four passes over
  the same 1400ms on the sniper: `scoped` (the bug — a settled scope draws no viewmodel at
  all, so measurement returns nothing on 58 of 60 frames), `latched` (a stoppage with the
  zoom latch left up, which viewmodel.js alone still collapses), `dropped` (what ships),
  and `hipfire` (the same stoppage on a weapon never scoped, as a control). It reports how
  many frames the glass costs before `dropped` and `hipfire` are the same picture.

## The rank plate

- `plate.mjs` — is the badge over the head drawn, the right size, above the head, and gone when
  something is in front of it. `verify.mjs` Part J already pins everything about the plate that
  is arithmetic — the crown clearance at every crouch depth, the billboard yaw over 322 camera
  bearings, one owner for `visible` — on a stubbed avatar with no GPU in it. What none of that
  can see is the property the feature was actually built on: occlusion is the DEPTH BUFFER and
  nothing else. There is no ray test and no visibility flag behind a plate disappearing behind
  cover; `plate.visible` stays true the whole time and the pixels simply lose the depth test.

  So it measures pixels, by difference: render the frame, hide ONE plate, render again, count
  what changed. Everything else in those two frames is identical, so the difference IS that
  plate — after fog, after the depth buffer, after every wall and every other body in the way.

  Five things it took before the numbers meant anything, each of them a wrong answer first:

  - **It asks for bots.** `settings.js:42` defaults `vsAi: false`, so a fresh browser profile
    sends a HELLO asking for zero bots and joins an empty room. The first run measured a room
    with nobody in it and reported clean. Every section now names its own absence — UNTESTED, NO
    SAMPLES, NOTHING TO MEASURE — and the runner exits 1 when no plate ever existed.
  - **Five rays, not one.** A centre-ray classifier reported a 17 px "leak" — a plate showing
    through a wall. A plate is an AREA and one ray is a point: the four `localToWorld` corners
    plus the centre separate *wholly* behind geometry (must draw 0) from *partly* in the open
    (must draw, and a ray gate would wrongly hide it). That is the plan's stated reason for not
    gating the plate on a ray test, turned from an argument into a measurement.
  - **It waits for a clear line and never steps off it.** The billboard's yaw was resolved
    against the real camera position by the frame loop, so any move ACROSS the sightline views
    the plate edge-on and measures the probe's own detour. Sliding along the line is free, which
    is how the size ladder and the close-in placement check both work.
  - **The occluder is measured too.** A body that draws nothing where it was put has not tested
    occlusion. A corpse mid-fade is transparent (`render.js:1650`) and blends over the *farther*
    plate rather than hiding it; an opaque body two thirds of the way to a 28u plate covered
    every row of it and only seven of its ten columns. Both scored as a broken depth test until
    the occluder's own opacity, footprint and bounding box were checked against the plate's, and
    the body was moved in close where it is angularly far bigger than the badge.
  - **The plate is its own ruler.** It is 0.2u tall and n pixels tall, so one pixel is worth
    0.2/n world units — which turns the gap above the head into a length with no FOV, no
    resolution and no range anywhere in the arithmetic.

  What it reports: plate size at nine ranges with the halving a world-sized quad owes (and the
  whole-pixel floor that ends it), the wall case split three ways, the gap above the crown in
  world units against the same figure computed from the geometry, and the body case as a
  before / during / after collapse to zero. The clearance is **0.02u, not the 0.12u
  `PLATE_LIFT` suggests** — the constant is measured to the plate's *centre* and the plate is
  0.2u tall, so the badge all but rests on the crown.

## The hook

All of them need a temporary hook at the end of `client/src/main.js`:

    window.__dbg = {
      view, predictor, input, canvas, viewmodel, audio, net,
      get jamMs() { return jamMs; }, get reloadMs() { return reloadMs; },
    };

It is deliberately not in the shipping source. Add it to re-measure, remove it after.

`net` is there for `plate.mjs` alone, which calls `net.setBots(6)` — the same `MSG.BOTS` the VS
AI chip sends — because a plate needs somebody else's head to sit on and a fresh profile joins
an empty room. Bots beat a second browser for it: their careers are seeded across the whole
ladder (`room.js:322`), so the plates on screen are a mix of tiers rather than copies of one.
