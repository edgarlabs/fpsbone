// The arena, authored as plain data. No editor, no asset pipeline: every solid in
// the level is an axis-aligned box, which is also exactly what the collision code
// consumes. Read by the server (collision) and the client (collision + render).
//
// Convention: x/y/z are the box CENTRE, w/h/d are FULL extents.
// Floor top sits at y = 0, so a player's centre rests at PLAYER_HALF_H.
//
// ── the shape of the place, and why
//
// 64 units square, up from 44. The old arena was a courtyard with cover in it: every
// fight happened at roughly the same range, which is fine when the game has a rifle and
// a pistol and actively wrong once it has a sniper, a shotgun and a smoke. A weapon is
// only a choice if the map contains a place it is the right answer to. So this one is
// built out of three kinds of space:
//
//   * Two LANES down the east and west edges, walled off from the middle. Nine units
//     wide and up to fifty long — the sniper's ground, and the only place in the map
//     where 200u of range means anything.
//   * MID, a raised plateau in the centre with stairs at both ends. Its top is at 2.8
//     and the walls that screen it are 4.0, so a standing eye at 4.32 sees over them
//     from up there and is blocked by them from the floor. That one number pair is the
//     whole reason to contest the middle.
//   * The DOORWAYS through those walls, four units wide. A smoke's cloud is 3.8 in
//     radius, which screens a four-unit gap completely and with something to spare —
//     the gaps are that width because the smoke is that size, not by coincidence.
//
// ── the other number the geometry is built around: how high a player can get
//
// 2.24 units, and 2.17 of that is measured rather than computed. Not the 1.54u jump apex —
// ducking in mid-air lifts the feet another 0.7u (see JUMP_VEL in constants.js), and it is
// the ducked figure that decides whether a crate is a step. Every height here was
// originally chosen against a 0.80u jump and the bare apex at that, which was wrong twice
// over: the real reach was already 1.44u, and two of the crates below were quietly ladders
// onto a divider top in the shipped map. verify.mjs Part A now audits against the ducked
// reach, and against how far the arc carries sideways while it is up there.
//
// Everything is placed in 180° rotational pairs about the origin: whatever is at (x, z)
// is also at (-x, -z). That is a fairness property rather than a stylistic one, and it
// is what will let the team modes in M7 split the spawn list down the middle and know
// that neither side was handed the better half of the map.

import { PLAYER_HALF_H } from './constants.js';

const box = (x, y, z, w, h, d, c) => ({ x, y, z, w, h, d, c });

/** Arena extent and wall height, exported because two other files need to size
 *  themselves to the map rather than to a number somebody typed twice: the renderer's
 *  shadow frustum has to cover it, and fuzz.mjs asserts nobody ever gets above it. */
export const ARENA = 64;
export const WALL_H = 9;
/** Public identity for the one authored battleground. Kept beside the geometry so the
 * lobby and the renderer cannot quietly give the same place two different names. */
export const MAP = Object.freeze({
  id: 'foundry-64',
  label: 'FOUNDRY 64',
  location: 'coastal reclamation yard',
});
const HALF = ARENA / 2;

const boxes = [];

/**
 * Place a solid, and place its opposite number.
 *
 * A 180° rotation about the y axis maps (x, z) to (-x, -z) and leaves the extents
 * alone, which is why this can be a two-line function and why every solid in the map
 * can be authored exactly once. Anything centred on the origin would map to itself and
 * so must be pushed directly instead — there is one such thing, the mid plateau.
 */
function pair(x, y, z, w, h, d, c) {
  boxes.push(box(x, y, z, w, h, d, c));
  boxes.push(box(-x, y, -z, w, h, d, c));
}

// -------------------------------------------------------------- floor + shell
boxes.push(box(0, -0.5, 0, ARENA, 1, ARENA, 'floor'));
boxes.push(box(0, WALL_H / 2, -HALF, ARENA, WALL_H, 1, 'wallA'));
boxes.push(box(0, WALL_H / 2, HALF, ARENA, WALL_H, 1, 'wallA'));
boxes.push(box(-HALF, WALL_H / 2, 0, 1, WALL_H, ARENA, 'wallA'));
boxes.push(box(HALF, WALL_H / 2, 0, 1, WALL_H, ARENA, 'wallA'));

// -------------------------------------------------------------- stairs
// A solid staircase: step i is a full-height block, so the collision code sees a
// series of ledges. `rise` must stay under STEP_HEIGHT or it becomes unwalkable.
//
// These are coloured 'stair', not 'wallB', for a gameplay reason rather than a
// decorative one. Cover is 1.2–3.2u tall and cannot be climbed; a staircase rises
// under 0.3u per step and can. If both wear the same colour, walking into a staircase
// and rising to y=3.9 is indistinguishable from climbing a wall, so the colour is worth
// keeping on readability grounds alone.
//
// It is NOT, however, the explanation for the climbing that playtests reported.
// That was a genuine physics bug in the client/server seam — the contact skin in
// shared/collide.js was smaller than the snapshot position rounding, so a body
// resting against a wall arrived on the client inside it and the next predicted tick
// resolved gravity against the wall's top face. Fixed there; guarded by verify.mjs
// Part C. An earlier session recoloured this geometry, concluded "the physics was
// never wrong", and shipped the bug twice more. If climbing is reported again, look
// at the seam, not at these colours.
function stairs(startX, startZ, dirX, dirZ, steps, width, rise, run) {
  for (let i = 0; i < steps; i++) {
    const h = (i + 1) * rise;
    const along = i * run + run / 2;
    boxes.push(
      box(
        startX + dirX * along,
        h / 2,
        startZ + dirZ * along,
        dirX !== 0 ? run : width,
        h,
        dirZ !== 0 ? run : width,
        'stair',
      ),
    );
  }
}

/** A staircase and its opposite number. Both the start and the direction rotate. */
function stairPair(startX, startZ, dirX, dirZ, steps, width, rise, run) {
  stairs(startX, startZ, dirX, dirZ, steps, width, rise, run);
  stairs(-startX, -startZ, -dirX, -dirZ, steps, width, rise, run);
}

// -------------------------------------------------------------- mid
// The plateau. Solid rather than a slab on legs: a 14×11 catwalk with an open
// underside would make the middle of the map a place you can be shot from below while
// standing on it, and mid is meant to be the strong position, not the exposed one.
const MID_TOP = 2.8;
boxes.push(box(0, MID_TOP / 2, 0, 14, MID_TOP, 11, 'wallA'));

// Ten steps of 0.28 — comfortably under STEP_HEIGHT — arriving exactly flush with the
// plateau top. `startZ` is set so the last step's far face meets the plateau's near
// face: any gap here is a staircase that leads to a wall you cannot climb.
stairPair(0, -12.2, 0, 1, 10, 6, 0.28, 0.67);

// Chest-high cover on the plateau, so holding it is a position rather than a diorama.
// 1.0 tall on a 2.8 floor: a standing eye clears it and a crouched one does not.
pair(-4.5, MID_TOP + 0.5, 0, 2.5, 1, 3.5, 'wallB');

// -------------------------------------------------------------- lane dividers
// The two long walls that make the lanes lanes. 4.0 tall, which is the load-bearing
// number in the whole map: it is above a standing eye on the floor (1.52) and below a
// standing eye on the plateau (4.32) and on the lane perch (4.52).
//
// Was 3.4, raised with the jump. The pair of numbers that has to hold is not the wall
// height on its own but the wall height minus the tallest thing beside it: a player can
// reach 2.24u of ledge, so anything within a jump of a divider has to be 1.76 or shorter,
// and the five pieces that were 1.8–2.3 came down to 1.7 to keep a real margin. The
// alternative — leaving the walls at 3.4 — needed cover under 1.16, which is shorter than
// a standing player and so no cover at all.
//
// Three segments each, leaving two four-unit doorways per side — the smoke gaps — and
// open ground beyond z = ±22 so there is a way round the back as well as through.
for (const z of [-16, 0, 16]) {
  pair(-13.5, 2.0, z, 1.2, 4, 12, 'wallA');
}

// -------------------------------------------------------------- mid gantry
// The visual overhaul gives mid a suspended steel service bridge readable from every
// approach. It could have been client-only because nobody can reach it, but bullets can:
// visible structure that a shot passes through is dishonest in an FPS. These two boxes
// therefore join the authoritative collision map. There are deliberately no uprights
// down to the divider walls: even one interrupted the raised-mid sightline whose whole
// purpose is tested below in verify.mjs.
boxes.push(box(0, 7.25, 0, 28, 0.7, 0.8, 'gantry'));
boxes.push(box(0, 6.55, 0, 9, 0.65, 0.7, 'gantry'));

// -------------------------------------------------------------- lane perches
// A raised platform in each lane, hard against the outer wall, reached by its own
// staircase. Top at 3.0, so like the plateau it sees over the dividers — the lane is
// not just a corridor, it is a corridor with a place to shoot down it from.
//
// The slab is 3.0 thick rather than 0.5 on posts, because a lane you can walk under is
// a lane a sniper cannot hold.
pair(-27.5, 1.5, 0, 8, 3, 9, 'wallA');
stairPair(-27.5, -11.2, 0, 1, 10, 5, 0.3, 0.67);
// And a lip along the inner edge, to peek over rather than stand exposed on top of.
pair(-24.25, 3.5, 0, 1.5, 1, 5, 'wallB');

// -------------------------------------------------------------- back-wall ties
// Two walls per side that run into the perimeter, breaking up the strip of open floor
// that otherwise hugs it.
//
// This is here because of a measurement, not a hunch: before these existed the longest
// clear sightline in the arena was 62 units corner to corner along the south wall,
// behind every piece of cover in the map. The lanes are supposed to be the long shot;
// a coverless strip running the full width behind everything is a better one, which
// made the lanes pointless. Four of these cut the back edges into runs of about 20.
//
// 4.0, the same as the dividers — a wall is one height in this map. Placed so no crate is
// within a player's 2.24u reach of the top: the nearest is 1.7 with a 2.3u rise, and
// needing more rise than a ducking jump can find is what keeps them from being ladders.
for (const [x, z] of [[-9, -30], [16, -30]]) {
  pair(x, 2.0, z, 1.2, 4, 4, 'wallA');
}

// -------------------------------------------------------------- cover
// [centreX, centreZ, width, height, depth] — all rest on the floor, all placed in
// rotational pairs. Heights vary on purpose: 1.4 is something to lie behind, 1.7–2.3
// is something to break a sightline, 2.6 is something you have to commit to going
// round.
//
// Two ceilings, not one, and the difference is what a player can reach: 2.24u of ledge,
// ducked.
//
//   * Out in the open, 2.6. A 2.24u reach from a 2.6 top gets you to 4.84, which is above
//     anything except the 9u shell, so a tall crate with nothing near it leads nowhere.
//     The tallest two are in the corners where the nearest wall is six units away.
//   * Within reach of a 4.0 wall, 1.7 — a 2.3u rise, which is more than a ducking jump
//     can find. This is the constraint that used to be written as "keep cover at 2.6 and
//     under", and that was never enough: a 2.3 crate beside a 3.4 wall is a 1.1u rise,
//     and the shipped map had two of those. They were reachable. Nobody noticed because
//     the audit measured the jump apex instead of what a ducking player can climb.
//
// A piece with a real gap to the wall is judged on the gap as well, because height is only
// half of it: the arc has to carry you sideways while you are still above the rise. What
// counts there is how far the BODY centre travels, not the clearance between the two
// boxes — a player is 0.8u wide and takes off overhanging one ledge to land overhanging the
// other, so a 2.42u gap is a 1.30u jump. Measuring the clearance instead is what let two
// crates ship as ladders. It is the travel figure that leaves (-20, 12) at 1.8 alone: 2.10u
// of it against a 1.75u run-out.
//
// 1.7 still hides a standing player (eye 1.52), which is the job these pieces have. What
// it no longer does is hide one on tiptoe, and that is the price of the higher jump.
for (const [x, z, w, h, d] of [
  // the lanes — offset from each other so a long shot down either one is still
  // possible, but never down the middle of it
  [-22, -19, 4.5, 2.2, 4],
  [-22.5, -9, 3, 1.6, 5],
  // 1.7, like every other piece that has a wall within a jump of it. This one is the
  // reason the rule is written in terms of travel rather than clearance: it stands 2.42u
  // clear of the divider's south end, which looks like plenty against a 2.10u run-out, and
  // is not — a player is 0.8u wide, so they take off overhanging one ledge and land
  // overhanging the other and only ever cross 1.30u of air. It was 2.2, then 2.0 on the
  // strength of the clearance figure, and both were ladders. At 1.7 the rise is 2.3, which
  // is past what a ducking jump can climb from any distance at all.
  [-18.5, -25, 5, 1.7, 3],
  [-20, 12, 6, 1.8, 3],
  [-29, -20, 4, 1.4, 4],

  // the approach to mid, either side of the plateau. The first was 2.2 and butts against
  // the divider — one of the two that were ladders.
  [-9.5, -16, 3, 1.7, 5],
  [0, -19, 9, 1.4, 2],
  [-8, 8, 4, 1.8, 4],

  // the back ends, where the spawns are. The first was 2.3, 1.5u from a back-wall tie.
  [-6.5, -25, 5, 1.7, 3],
  [5, -28, 4, 1.8, 3],

  // Three pieces that exist to break long lines rather than to be fought over, each
  // one measured into place. A long thin wall with nothing beside it hands you a
  // corridor as long as the wall, and the dividers are fifty units of long thin wall:
  //   * (-1, -22) blocks the band just outside the dividers' south ends, which was a
  //     clear 62u east-west shot straight across the arena behind the plateau.
  //   * the other two butt against the west divider's faces, one per side, because the
  //     three-unit strips flanking it ran the full 62u north-south. Cover touching a
  //     wall is the cheapest way to break a line parallel to it.
  // The two that touch a divider are 1.7 for that reason — flush against a wall is
  // exactly where the rise has to beat the reach, and (-11.65, 4) at 2.0 was the second
  // of the two ladders.
  [-1, -22, 6, 2.2, 3],
  [-15.6, -16, 3, 1.7, 3],
  [-11.65, 4, 2.5, 1.7, 4],

  // corners. The stub is long and thin rather than a crate: it makes a genuine blind
  // corner with a gap behind it, which is the only close-quarters geometry in the map
  // and so the only place a shotgun is the right weapon. You can climb the cluster and
  // then the stub, which is intended — it is two deliberate hops for a view over the
  // lane, and the nearest wall top is six units away so it leads nowhere else. These are
  // the two pieces the 2.6 open-ground ceiling was written for.
  [-28, -27, 5, 2.5, 5],
  [-19.5, -28.5, 8, 2.6, 1.2],
]) {
  pair(x, h / 2, z, w, h, d, 'wallB');
}

export const WORLD_BOXES = boxes;

// -------------------------------------------------------------- spawns
// Twelve, in rotational pairs, verified clear of every solid above by verify.mjs Part A
// rather than by eye. Yaw faces the arena centre: forward is (-sin yaw, 0, -cos yaw),
// so yaw = atan2(x, z) looks at the origin.
//
// The list is also what bots roam between (server/ai.js builds its waypoints from it),
// which is the other reason it grew with the map: eight points spread over 64 units
// left most of the arena unvisited, and a bigger map with the same waypoints is just a
// bigger empty room.
export const SPAWNS = [
  [-22, -27],
  [22, 27],
  [0, -29],
  [0, 29],
  [22, -27],
  [-22, 27],
  [-29, -14],
  [29, 14],
  [-5, -14],
  [5, 14],
  [-29, 21],
  [29, -21],
].map(([x, z]) => ({ x, y: PLAYER_HALF_H, z, yaw: Math.atan2(x, z) }));

/**
 * The same spawns, split into two bases for the team modes — "spawn in your base",
 * which is what `tdm`'s blurb promises.
 *
 * Split on the SIGN OF Z, which is what makes each half a place rather than a scattering:
 * the twelve points above are laid out as mirrored pairs across the map, so everything
 * with a negative z sits at one end and everything positive at the other. Six a side,
 * for a team of five — one spare, so the furthest-from-an-enemy pick below still has a
 * choice to make when a full team is alive.
 *
 * Derived rather than written out again. A hand-copied second list is a list that stops
 * agreeing with SPAWNS the first time somebody moves a point, and the failure mode is a
 * team spawning inside the other team's base with no error anywhere.
 *
 * Indexed by team NUMBER MINUS ONE — teams are 1 and 2 on the wire, because 0 means no
 * team — so read it as `TEAM_SPAWNS[p.team - 1]`.
 */
export const TEAM_SPAWNS = [
  SPAWNS.filter((s) => s.z < 0),
  SPAWNS.filter((s) => s.z > 0),
];

/**
 * Arena objective sites. Team 1 attacks from the negative-z base and team 2 defends
 * these two pads in the positive-z half. They are shared data because the server uses
 * the exact circles for plant/defuse admission while the client paints those circles
 * on the floor; two hand-copied coordinates would eventually turn the visible pad into
 * a lie.
 *
 * Each full circle was audited clear of every solid, not merely its centre. A player
 * can therefore stand anywhere the paint says is valid without clipping a crate.
 */
export const OBJECTIVE_SITES = Object.freeze([
  Object.freeze({ id: 'A', x: -21, z: 20, radius: 2.4 }),
  Object.freeze({ id: 'B', x: 27, z: 14, radius: 2.4 }),
]);
