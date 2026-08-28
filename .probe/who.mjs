// Which part is on the crosshair, and where the strike point actually projects.
// Coverage alone cannot tell a fist over the middle from a forearm sweeping through it,
// and those want opposite fixes.
import { withPage } from './cdp.mjs';
import { page, JAM_GUNS, NAME } from './vm2.mjs';

const script = page([
  '  const supFist = (rig) => { const f=[]; rig.traverse(o=>{ if(isFist(o)) f.push(o); });',
  '    f.sort((a,b)=>a.parent.userData.wrist.z-b.parent.userData.wrist.z); return f[0]; },',
  '   label = (o, sup) => { const q=o.geometry.parameters||{};',
  '    if(isFist(o)){ const c=new V(); o.getWorldPosition(c);',
  '      c.applyMatrix4(new M().copy(vmc.matrixWorld).invert());',
  '      return (o===sup?"SUP":"TRG")+"-FIST d"+(-c.z).toFixed(3); }',
  '    if(q.width===0.072&&q.height===0.072) return "forearm";',
  '    return "part[" + o.parent.children.indexOf(o) + "] " + [q.width,q.height,q.depth].map(v=>v&&v.toFixed(3)).join("x"); };',
  '  const now=performance.now(), out={};',
  `  for(const w of [${JAM_GUNS}]){ settle(w); const rows=[];`,
  '    for(let k=0;k<=20;k++){ const pp=k/20;',
  '      d.viewmodel.update(16.7,now,0,false,0,0,0,1400*(1-pp));',
  '      const rig=rigsRoot.children.find(c=>c.visible); vmc.updateMatrixWorld(true);',
  '      const sup=supFist(rig);',
  '      const inv=new M().copy(vmc.matrixWorld).invert(), proj=vmc.projectionMatrix, zLim=-vmc.near*1.001;',
  '      const hits=[];',
  '      rig.traverse(o=>{ if(!o.visible||!o.geometry) return;',
  '        let vis=true; for(let n=o;n&&n!==rig;n=n.parent) if(!n.visible) vis=false; if(!vis) return;',
  '        const h=silhouette(o,inv,proj,zLim); if(h&&inside(h,0,0)) hits.push(label(o,sup)); });',
  '      if(hits.length) rows.push({p:+pp.toFixed(2),hits}); }',
  '    out[w]=rows; }',
  '  return out;',
]);
const r = await withPage('http://localhost:5173/?mode=dm', async ({ evaluate }) => {
  await evaluate("document.getElementById('start')?.click(); 1");
  await evaluate('new Promise(r => setTimeout(r, 4000))');
  return evaluate(script);
});
for (const [w, rows] of Object.entries(r)) {
  if (!rows.length) { console.log(`${NAME[w].padEnd(8)} centre clear all 21 frames`); continue; }
  console.log(`${NAME[w].padEnd(8)} centre covered on ${rows.length} frames:`);
  for (const q of rows) console.log(`    p=${q.p}  ${q.hits.join(', ')}`);
}
