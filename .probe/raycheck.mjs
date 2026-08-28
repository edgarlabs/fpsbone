// Sanity check on the depth test itself before trusting anything it says: at the support
// fist's own centre, the fist must be the nearest thing on its own ray.
import { withPage } from './cdp.mjs';
import { page } from './vm2.mjs';
const script = page([
  '  const now=performance.now(); settle(2);',
  '  d.viewmodel.update(16.7,now,0,false,0,0,0,1400*0.7);',
  '  const fr=frame(), m=measure(), f=m.sup;',
  '  const out={fistNDC:[+f.x.toFixed(3),+f.y.toFixed(3)],fistDepth:+f.depth.toFixed(4),rays:[]};',
  '  for(const q of fr.parts){ const t=rayT(q,f.x,f.y,fr.tanX,fr.tanY);',
  '    out.rays.push({cls:q.cls,inHull:inside(q.h,f.x,f.y),t:isFinite(t)?+t.toFixed(4):null,',
  '      bb:[+q.bb.min.z.toFixed(3),+q.bb.max.z.toFixed(3)]}); }',
  // Where in the fist's own silhouette the sleeve wins, and by how much.
  '  const fist=fr.parts.find(q=>q.cls==="supFist"), arm=fr.parts.find(q=>q.cls==="supArm");',
  '  out.cells=[]; const G=16;',
  '  for(let i=0;i<G;i++) for(let j=0;j<G;j++){ const x=-1+2*(i+0.5)/G, y=-1+2*(j+0.5)/G;',
  '    if(!inside(fist.h,x,y)) continue;',
  '    const tf=rayT(fist,x,y,fr.tanX,fr.tanY), ta=rayT(arm,x,y,fr.tanX,fr.tanY);',
  '    out.cells.push({x:+x.toFixed(2),y:+y.toFixed(2),tf:isFinite(tf)?+tf.toFixed(4):null,',
  '      ta:isFinite(ta)?+ta.toFixed(4):null}); }',
  '  const wr=rigsRoot.children.find(c=>c.visible); out.hulls={fist:fist.h.map(q=>q.map(v=>+v.toFixed(3))),arm:arm.h.map(q=>q.map(v=>+v.toFixed(3)))};',
  '  return out;',
]);
const r = await withPage('http://localhost:5173/?mode=dm', async ({ evaluate }) => {
  await evaluate("document.getElementById('start')?.click(); 1");
  await evaluate('new Promise(r => setTimeout(r, 4000))');
  return evaluate(script);
});
console.log(`support fist centre at NDC ${r.fistNDC}, depth ${r.fistDepth}m`);
for (const q of r.rays) console.log(`  ${q.cls.padEnd(8)} inHull ${String(q.inHull).padEnd(5)} rayDepth ${q.t === null ? 'miss' : q.t}  localZ ${q.bb}`);
console.log();
console.log('cells inside the fist silhouette (fist depth vs sleeve depth):');
for (const c of r.cells) console.log(`  (${c.x},${c.y})  fist ${c.tf === null ? 'miss' : c.tf}   sleeve ${c.ta === null ? 'miss' : c.ta}${c.ta !== null && c.tf !== null && c.ta < c.tf ? '   <-- sleeve in front' : ''}`);
console.log('fist hull ', JSON.stringify(r.hulls.fist));
console.log('sleeve hull', JSON.stringify(r.hulls.arm));
