// The rest pose's own screen share, per class. The baseline any jam pose has to be judged
// against: what the player normally sees of the gun and of the off hand.
import { withPage } from './cdp.mjs';
import { page, JAM_GUNS, NAME } from './vm2.mjs';
const script = page([
  `  const out=[]; for(const w of [${JAM_GUNS}]){ settle(w); const m=measure();`,
  '    out.push({w,cov:m.cov,vis:m.vis,sup:m.sup&&{x:m.sup.x,y:m.sup.y,seen:m.sup.seen}}); }',
  '  return out;',
]);
const r = await withPage('http://localhost:5173/?mode=dm', async ({ evaluate }) => {
  await evaluate("document.getElementById('start')?.click(); 1");
  await evaluate('new Promise(r => setTimeout(r, 4000))');
  return evaluate(script);
});
const pc = (v) => `${Math.round(100 * v)}%`.padStart(4);
for (const q of r) {
  console.log(`${NAME[q.w].padEnd(8)} cov ${pc(q.cov)}  gun ${pc(q.vis.gun)}  supArm ${pc(q.vis.supArm)}  supFist ${pc(q.vis.supFist)}`
    + `  trgArm ${pc(q.vis.trgArm)}  trgFist ${pc(q.vis.trgFist)}   sup at (${q.sup.x.toFixed(2)},${q.sup.y.toFixed(2)}) seen ${pc(q.sup.seen)}`);
}
