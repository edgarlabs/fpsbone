// Why the fist measures so little of the screen: how big its silhouette is, how much of
// that survives the frame, and how much survives being drawn over.
import { withPage } from './cdp.mjs';
import { page, NAME } from './vm2.mjs';
const W = Number(process.env.W || 2);
const script = page([
  `  window.__jamTune=${process.env.TUNE || 'null'};`,
  `  const now=performance.now(); settle(${W}); const rows=[];`,
  '  for(let k=0;k<=20;k++){ const pp=k/20;',
  `    d.viewmodel.update(16.7,now,0,false,0,0,0,1400*(1-pp));`,
  '    const m=measure(), f=m.sup;',
  // What is drawn over the fist, by class, cell by cell.
  '    const fr=frame(); const fh=fr.parts.filter(q=>q.cls==="supFist");',
  '    const over={}; let cells=0, mine=0;',
  '    const G=40; for(let i=0;i<G;i++) for(let j=0;j<G;j++){',
  '      const x=-1+2*(i+0.5)/G, y=-1+2*(j+0.5)/G;',
  '      if(!fh.some(q=>inside(q.h,x,y))) continue; cells++;',
  '      let best=null,bt=Infinity; for(const q of fr.parts){ if(!inside(q.h,x,y)) continue;',
  '        const t=rayT(q,x,y,fr.tanX,fr.tanY); if(t<bt){bt=t;best=q;} }',
  '      if(best.cls==="supFist") mine++; else over[best.cls]=(over[best.cls]||0)+1; }',
  '    rows.push({p:+pp.toFixed(2),y:+f.y.toFixed(2),area:+(100*f.px/4).toFixed(1),',
  '      seen:+f.seen.toFixed(2),vis:+(100*m.vis.supFist).toFixed(1),',
  '      cells,mine,over,gun:+(100*m.vis.gun).toFixed(1),arm:+(100*m.vis.supArm).toFixed(1)}); }',
  '  window.__jamTune=null; return rows;',
]);
const r = await withPage('http://localhost:5173/?mode=dm', async ({ evaluate }) => {
  await evaluate("document.getElementById('start')?.click(); 1");
  await evaluate('new Promise(r => setTimeout(r, 4000))');
  return evaluate(script);
});
console.log(`${NAME[W]}   p     fistY  silhouette  inFrame  visible   unoccluded/covered   drawn over by        gun   arm`);
for (const q of r) {
  const ov = Object.entries(q.over).map(([k, v]) => `${k} ${(100 * v / q.cells).toFixed(0)}%`).join(' ') || '-';
  console.log(`     ${String(q.p).padEnd(5)} ${String(q.y).padStart(6)} ${String(q.area).padStart(9)}% `
    + `${(100 * q.seen).toFixed(0).padStart(7)}% ${String(q.vis).padStart(7)}%   ${String(q.mine).padStart(4)}/${String(q.cells).padEnd(4)}   ${ov.padEnd(20)} ${String(q.gun).padStart(5)}% ${String(q.arm).padStart(5)}%`);
}
