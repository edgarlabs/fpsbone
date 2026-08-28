// A stoppage that starts while scoped, measured in the real engine.
//
// verify.mjs pins this from lifted expressions: the latch in input.js drops on the rising
// edge, and `wantAlt` cannot hold an alt pose while `jamP >= 0`. Both are statements about
// numbers. What they are FOR is a picture — the clearing punch, drawn, on screen — and the
// only place that exists is a real three.js scene with the real rig in it.
//
// Three passes over the same 1400ms, all on the sniper, the one weapon that scopes:
//
//   scoped     the bug. Scope settled, no stoppage: the weapon is hidden outright, which
//              is correct and is also why a jam behind it was invisible.
//   latched    a stoppage with `scopeStep` left at 1 — the belt-and-braces case, where the
//              latch is imagined to have failed and only viewmodel.js drops the blend.
//   dropped    a stoppage with the latch down, which is what actually ships.
import { withPage } from './cdp.mjs';
import { page } from './vm2.mjs';

const SNIPER = 3;
const JAM_MS = 1400;

const script = page([
  // Settle the scope first, then run the stoppage from there — the question is what a
  // player who was already looking down the scope sees, not what a fresh frame shows.
  '  const run = (step, jam, frames) => { const now = performance.now(), out = [];',
  '    for (let i = 0; i < frames; i++) {',
  `      const ms = jam ? Math.max(0, ${JAM_MS} - (i * 1000) / 60) : 0;`,
  '      d.viewmodel.update(1000 / 60, now + i * 16.7, 0, false, 0, 0, step, ms);',
  '      const m = measure();',
  '      out.push({ t: +((i * 1000) / 60).toFixed(0), scopeK: +d.viewmodel.scopeAmount.toFixed(3),',
  '                 none: !m, gun: m ? m.vis.gun : 0, supVis: m ? m.vis.supFist : 0, cov: m ? m.cov : 0,',
  '                 sup: m && m.sup ? { seen: +m.sup.seen.toFixed(2), x: +m.sup.x.toFixed(2),',
  '                 y: +m.sup.y.toFixed(2) } : null });',
  '    } return out; };',
  `  settle(${SNIPER});`,
  // 60 frames of settled scope is a full second — altK is a 13/s exponential, so this is
  // pinned at 1 long before the end of it.
  '  const scoped = run(1, false, 60);',
  '  const latched = run(1, true, 84);',
  `  settle(${SNIPER}); run(1, false, 60);`,
  '  const dropped = run(0, true, 84);',
  // And a control: the same stoppage on a weapon that was never scoped. The property is
  // not `the gun is drawn` -- it is that a stoppage which began behind the glass ends up
  // indistinguishable from any other stoppage.
  `  settle(${SNIPER});`,
  '  const hipfire = run(0, true, 84);',
  '  return { scoped, latched, dropped, hipfire };',
]);

const r = await withPage('http://localhost:5173/?mode=dm', async ({ evaluate }) => {
  await evaluate("document.getElementById('start')?.click(); 1");
  await evaluate('new Promise(r => setTimeout(r, 4000))');
  return evaluate(script);
});

const pct = (v) => `${(v * 100).toFixed(0)}%`;
for (const [name, rows] of Object.entries(r)) {
  const drawn = rows.filter((q) => q.gun > 0);
  const fist = rows.filter((q) => q.supVis > 0);
  const first = drawn[0];
  const none = rows.filter((q) => q.none);
  console.log(`\n${name}`);
  console.log(`  nothing in the scene at all on ${none.length}/${rows.length} frames`);
  console.log(`  gun drawn on ${drawn.length}/${rows.length} frames`
    + (first ? `, first at ${first.t}ms (scopeK ${first.scopeK})` : ''));
  console.log(`  support fist visible on ${fist.length}/${rows.length} frames`
    + (fist.length ? `, ${pct(Math.min(...fist.map((q) => q.supVis)))}–${pct(Math.max(...fist.map((q) => q.supVis)))} of screen` : ''));
  if (fist.length) {
    const off = fist.filter((q) => Math.abs(q.sup.x) > 1 || Math.abs(q.sup.y) > 1);
    console.log(`  fist centre outside the frame on ${off.length} of those`);
  }
  const marks = [0, 300, 420, 700, 1000, 1390];
  for (const t of marks) {
    const q = rows.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
    console.log(`    t=${String(q.t).padStart(4)}ms  scopeK ${q.scopeK.toFixed(3)}  `
      + `gun ${pct(q.gun)}  supFist ${pct(q.supVis)}`
      + (q.sup ? ` at (${q.sup.x.toFixed(2)}, ${q.sup.y.toFixed(2)}) ${pct(q.sup.seen)} on screen` : ''));
  }
}


// The two runs cannot match from t=0: the glass has to fade. What matters is how few frames
// that costs, and that what is left after it is the same picture and not a near miss.
// The metric samples a 20x20 grid, so one cell is 0.25% of the screen -- the floor on any
// difference it can report, and the unit the residual zoom is worth quoting in.
const CELL = 1 / 400;
const q0 = r.dropped, ctl = r.hipfire;
const gap = (k) => Math.max(Math.abs(q0[k].gun - ctl[k].gun),
  Math.abs(q0[k].supVis - ctl[k].supVis), Math.abs(q0[k].cov - ctl[k].cov));
const off = q0.map((q, k) => k).filter((k) => q0[k].none !== ctl[k].none || gap(k) > 1e-9);
const blind = q0.filter((q) => q.none);
const drawnOff = off.filter((k) => !q0[k].none);
const worst = drawnOff.length ? Math.max(...drawnOff.map(gap)) : 0;
const last = off.length ? Math.max(...off) : -1;
console.log(`
dropped vs the never-scoped control:`);
console.log(`  nothing drawn for the first ${blind.length} frames`
  + `${blind.length ? ` (through t=${blind[blind.length - 1].t}ms, scopeK ${blind[blind.length - 1].scopeK})` : ''}`);
console.log(`  drawn but not yet identical on ${drawnOff.length} frames, worst difference `
  + `${(worst / CELL).toFixed(1)} of 400 grid cells (${pct(worst)} of screen) -- the FOV still unzooming`);
console.log(`  the same picture from t=${q0[last + 1].t}ms onward: `
  + `${q0.length - last - 1} of ${q0.length} frames, ${pct((q0.length - last - 1) / q0.length)} of the stoppage`);