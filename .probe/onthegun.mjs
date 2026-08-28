// Is the fist actually ON the gun, or just somewhere on the screen?
//
// Coverage says how much fist and how much gun you get; it cannot say whether the two are
// in the same place. A screenshot of the rifle at p=0.20 showed the fist top-left and the
// gun bottom-right, which every number so far had scored as a success.
import { withPage } from './cdp.mjs';
import { page, JAM_GUNS, NAME } from './vm2.mjs';

const script = page([
  '  const supHand = (rig) => { const h=[]; rig.traverse(o=>{ if(o.userData&&o.userData.wrist) h.push(o); });',
  '    h.sort((a,b)=>a.userData.wrist.z-b.userData.wrist.z); return h[0]; };',
  '  const nd = (v,inv,proj) => { const q=v.clone().applyMatrix4(inv).applyMatrix4(proj); return [+q.x.toFixed(2),+q.y.toFixed(2)]; };',
  '  const now=performance.now(), out={};',
  `  for(const w of [${JAM_GUNS}]){ settle(w); const rows=[];`,
  '    for(let k=0;k<=20;k++){ const pp=k/20;',
  '      d.viewmodel.update(16.7,now,0,false,0,0,0,1400*(1-pp));',
  '      const rig=rigsRoot.children.find(c=>c.visible); vmc.updateMatrixWorld(true);',
  '      const inv=new M().copy(vmc.matrixWorld).invert(), proj=vmc.projectionMatrix;',
  '      const sh=supHand(rig), fist=sh.children[0];',
  // where the fist is, and where the point on the gun it is supposed to be hitting is
  '      const fc=new V(); fist.getWorldPosition(fc);',
  '      const sp=new V().fromArray(d.viewmodel.__strike||[0,0,0]); rig.localToWorld(sp);',
  // and the gun itself: centroid of every non-hand mesh, area-weighted by silhouette
  // How far the fist's centre is from the NEAREST point of the gun's on-screen silhouette.
  // A centroid cannot answer "is the hand on the gun": a rifle's visible centroid sits at
  // x=-0.24 while the receiver runs from -0.7 to +0.2, so a fist right on the receiver
  // measures a third of a frame away from the centroid of the thing it is touching.
  '      const segD=(px,py,a,b)=>{ const dx=b[0]-a[0], dy=b[1]-a[1], L2=dx*dx+dy*dy;',
  '        let t=L2>0?((px-a[0])*dx+(py-a[1])*dy)/L2:0; t=Math.max(0,Math.min(1,t));',
  '        return Math.hypot(px-(a[0]+dx*t), py-(a[1]+dy*t)); };',
  '      let gTop=-9, near=Infinity, gx=0, gy=0, ga=0, zLim=-vmc.near*1.001;',
  '      const fq=fc.clone().applyMatrix4(inv).applyMatrix4(proj);',
  '      rig.traverse(o=>{ if(!o.visible||!o.geometry) return; if(handOf(o,rig)) return;',
  '        let vv=true; for(let n=o;n&&n!==rig;n=n.parent) if(!n.visible) vv=false; if(!vv) return;',
  '        const h=silhouette(o,inv,proj,zLim); if(!h) return; const c=clipFrame(h); const a=area(c); if(a<1e-9) return;',
  '        for(const q of c) if(q[1]>gTop) gTop=q[1];',
  '        let cx=0,cy=0; for(const q of c){cx+=q[0];cy+=q[1];} cx/=c.length; cy/=c.length;',
  '        gx+=cx*a; gy+=cy*a; ga+=a;',
  '        if(inside(c,fq.x,fq.y)) { near=0; return; }',
  '        for(let i=0;i<c.length;i++) near=Math.min(near, segD(fq.x,fq.y,c[i],c[(i+1)%c.length])); });',
  '      rows.push({p:+pp.toFixed(2), fist:nd(fc,inv,proj), near:+near.toFixed(2),',
  '        gun: ga>0?[+(gx/ga).toFixed(2),+(gy/ga).toFixed(2)]:null, top:+gTop.toFixed(2)}); }',
  '    out[w]=rows; }',
  '  return out;',
]);
const r = await withPage('http://localhost:5173/?mode=dm', async ({ evaluate }) => {
  await evaluate("document.getElementById('start')?.click(); 1");
  await evaluate('new Promise(r => setTimeout(r, 4000))');
  return evaluate(script);
});
const D = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : NaN);
for (const [w, rows] of Object.entries(r)) {
  const win = rows.filter((q) => q.p >= 0.16 && q.p <= 0.88);
  const n = win.map((q) => q.near);
  console.log(`${NAME[w].padEnd(8)} fist to nearest point of the gun on screen `
    + `${Math.min(...n).toFixed(2)}..${Math.max(...n).toFixed(2)} half-frames`
    + `   (touching on ${win.filter((q) => q.near === 0).length}/${win.length} frames)`);
  for (const q of win.filter((_, i) => i % 3 === 0)) {
    console.log(`     p=${String(q.p).padEnd(4)} fist ${JSON.stringify(q.fist).padEnd(14)}`
      + ` gunTop y=${String(q.top).padEnd(6)} nearest ${q.near.toFixed(2)}`);
  }
}
