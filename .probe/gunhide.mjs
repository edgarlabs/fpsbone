// How much of the gun the punching hand costs, isolated.
//
// "gun seen 6%..8%" during a stoppage against a 12-17% rest baseline is not by itself an
// indictment of the hand: the authored jam pose already yaws the weapon 29 degrees and
// drops it. So measure each frame twice, once with the support hand hidden, and let the
// difference say what the hand is actually covering.
import { withPage } from './cdp.mjs';
import { page, JAM_GUNS, NAME } from './vm2.mjs';

const script = page([
  '  const supHand = (rig) => { const h=[]; rig.traverse(o=>{ if(o.userData&&o.userData.wrist) h.push(o); });',
  '    h.sort((a,b)=>a.userData.wrist.z-b.userData.wrist.z); return h[0]; };',
  '  const now=performance.now(), out={};',
  `  for(const w of [${JAM_GUNS}]){ settle(w); const rows=[];`,
  '    for(let k=0;k<=20;k++){ const pp=k/20;',
  '      d.viewmodel.update(16.7,now,0,false,0,0,0,1400*(1-pp));',
  '      const rig=rigsRoot.children.find(c=>c.visible), sh=supHand(rig);',
  '      const withHand=measure();',
  '      sh.visible=false; const bare=measure(); sh.visible=true;',
  '      rows.push({p:+pp.toFixed(2),gun:withHand.vis.gun,bare:bare.vis.gun,',
  '        fist:withHand.vis.supFist,arm:withHand.vis.supArm}); }',
  '    settle(w); const rest=measure();',
  '    out[w]={rows,rest:rest.vis.gun}; }',
  '  return out;',
]);
const r = await withPage('http://localhost:5173/?mode=dm', async ({ evaluate }) => {
  await evaluate("document.getElementById('start')?.click(); 1");
  await evaluate('new Promise(r => setTimeout(r, 4000))');
  return evaluate(script);
});
const pc = (v) => `${(100 * v).toFixed(0)}%`.padStart(4);
for (const [w, { rows, rest }] of Object.entries(r)) {
  const win = rows.filter((q) => q.p >= 0.16 && q.p <= 0.88);
  const lost = win.map((q) => q.bare - q.gun);
  console.log(`${NAME[w].padEnd(8)} gun at rest ${pc(rest)}   under the jam pose alone `
    + `${pc(Math.min(...win.map((q) => q.bare)))}..${pc(Math.max(...win.map((q) => q.bare)))}`
    + `   hidden by the hand ${pc(Math.min(...lost))}..${pc(Math.max(...lost))}`
    + `   fist ${pc(Math.max(...win.map((q) => q.fist)))}  arm ${pc(Math.max(...win.map((q) => q.arm)))}`);
}
