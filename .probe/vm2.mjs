// Screen-space measurement of the viewmodel, take two.
//
// Differences from vmmetric.mjs, both of which were measurement bugs rather than
// tuning disagreements:
//
//   * Fists are found by GEOMETRY, not by tree position. The old version walked
//     `rig.children.filter(c => c.children.length > 1 && !c.geometry)[0]` and took the
//     last child group as the support hand. Any other multi-child group on a rig lands
//     ahead of the arms in that list, which is the likeliest reason the LMG measured a
//     rest height of -1.34 where the arithmetic says -0.47. A fist is the only
//     BoxGeometry in the scene whose parameters are FIST, so match on that.
//
//   * A fist is scored by how much of it you can SEE, not by whether its centre point
//     is inside the frame. That is the question the change is trying to answer, and a
//     fist is a third of the frame's height at pistol distance, so centre-in-frame is
//     both too strict and too coarse.
//
// Everything the old version got right is kept: convex silhouettes rather than
// axis-aligned boxes, and near-plane clipping in camera space before projection.
export const METRIC = [
  '  const V = vmc.position.constructor, M = vmc.matrixWorld.constructor;',
  '  const FIST = [0.076, 0.07, 0.1];',
  '  const EDGES = []; for(let i=0;i<8;i++) for(const b of [1,2,4]) if(!(i&b)) EDGES.push([i,i|b]);',
  '  const hull = (P) => { P = P.slice().sort((a,b)=>a[0]-b[0]||a[1]-b[1]);',
  '    const cr=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);',
  '    const build=(p)=>{const h=[];for(const q of p){while(h.length>1&&cr(h[h.length-2],h[h.length-1],q)<=0)h.pop();h.push(q);}return h;};',
  '    const lo=build(P), hi=build(P.slice().reverse()); return lo.slice(0,-1).concat(hi.slice(0,-1)); };',
  '  const inside = (h,x,y) => { if(h.length<3) return false;',
  '    for(let i=0;i<h.length;i++){const a=h[i],b=h[(i+1)%h.length];',
  '      if((b[0]-a[0])*(y-a[1])-(b[1]-a[1])*(x-a[0]) < 0) return false;} return true; };',
  '  const area = (h) => { let s=0; for(let i=0;i<h.length;i++){const a=h[i],b=h[(i+1)%h.length]; s+=a[0]*b[1]-b[0]*a[1];} return Math.abs(s)/2; };',
  // Sutherland-Hodgman against the four frame edges, so "how much of it is on screen"
  // is an area ratio and not a sampled guess.
  '  const clipFrame = (h) => { let p=h;',
  '    const planes=[[1,0,1],[-1,0,1],[0,1,1],[0,-1,1]];',
  '    for(const [a,b,c] of planes){ const q=[]; if(!p.length) break;',
  '      for(let i=0;i<p.length;i++){ const u=p[i], v=p[(i+1)%p.length];',
  '        const du=c-(a*u[0]+b*u[1]), dv=c-(a*v[0]+b*v[1]);',
  '        if(du>=0) q.push(u);',
  '        if((du>=0)!==(dv>=0)){ const t=du/(du-dv); q.push([u[0]+(v[0]-u[0])*t, u[1]+(v[1]-u[1])*t]); } }',
  '      p=q; } return p; };',
  // Camera-space corners of one mesh's box, clipped to in-front-of-near.
  '  const camPts = (o,inv,zLim) => {',
  '    if(!o.geometry.boundingBox) o.geometry.computeBoundingBox();',
  '    const b=o.geometry.boundingBox, C=[];',
  '    for(let i=0;i<8;i++){ const v=new V(i&1?b.max.x:b.min.x,i&2?b.max.y:b.min.y,i&4?b.max.z:b.min.z);',
  '      o.localToWorld(v); v.applyMatrix4(inv); C.push(v); }',
  '    const keep=C.filter(v=>v.z<=zLim);',
  '    for(const [i,j] of EDGES){ const a=C[i],c=C[j];',
  '      if((a.z<=zLim)!==(c.z<=zLim)){ const t=(zLim-a.z)/(c.z-a.z);',
  '        keep.push(new V(a.x+(c.x-a.x)*t,a.y+(c.y-a.y)*t,zLim)); } }',
  '    return keep; };',
  '  const silhouette = (o,inv,proj,zLim) => { const keep=camPts(o,inv,zLim); if(keep.length<3) return null;',
  '    const h=hull(keep.map(v=>{const q=v.clone().applyMatrix4(proj); return [q.x,q.y];})); return h.length>2?h:null; };',
  '  const isFist = (o) => { const p=o.geometry&&o.geometry.parameters; return !!p && p.width===FIST[0] && p.height===FIST[1] && p.depth===FIST[2]; };',
  '  const isLimb = (o) => { const p=o.geometry&&o.geometry.parameters; return !!p && p.width===0.072 && p.height===0.072; };',
  '  const handOf = (o,rig) => { for(let n=o.parent;n&&n!==rig;n=n.parent) if(n.userData&&n.userData.wrist) return n; return null; };',
  // Depth of the nearest surface a screen ray meets on one box, exactly. Slab test in the
  // box's own space, which is what a box IS, so no sampling and no per-mesh fudge.
  '  const rayT = (q,x,y,tanX,tanY) => { const m=q.m, ox=m[12],oy=m[13],oz=m[14];',
  '    const cx=x*tanX, cy=y*tanY;',
  '    const d=[m[0]*cx+m[4]*cy-m[8], m[1]*cx+m[5]*cy-m[9], m[2]*cx+m[6]*cy-m[10]];',
  '    const oo=[ox,oy,oz], lo=[q.bb.min.x,q.bb.min.y,q.bb.min.z], hi=[q.bb.max.x,q.bb.max.y,q.bb.max.z];',
  '    let t0=-Infinity, t1=Infinity;',
  '    for(let i=0;i<3;i++){ if(Math.abs(d[i])<1e-12){ if(oo[i]<lo[i]||oo[i]>hi[i]) return Infinity; continue; }',
  '      let a=(lo[i]-oo[i])/d[i], b=(hi[i]-oo[i])/d[i]; if(a>b){const c=a;a=b;b=c;}',
  '      t0=Math.max(t0,a); t1=Math.min(t1,b); if(t0>t1) return Infinity; }',
  '    return t1<0?Infinity:Math.max(0,t0); };',
  '  const frame = () => {',
  '    const rig=rigsRoot.children.find(c=>c.visible); if(!rig) return null;',
  '    vmc.updateMatrixWorld(true);',
  '    const inv=new M().copy(vmc.matrixWorld).invert(), proj=vmc.projectionMatrix, zLim=-vmc.near*1.001;',
  '    const hands=[]; rig.traverse(o=>{ if(o.userData&&o.userData.wrist) hands.push(o); });',
  '    hands.sort((a,b)=>a.userData.wrist.z-b.userData.wrist.z); const supHand=hands[0]||null;',
  '    const hulls=[], fists=[], parts=[];',
  '    rig.traverse(o=>{ if(!o.visible||!o.geometry) return;',
  '      let vis=true; for(let n=o;n&&n!==rig;n=n.parent) if(!n.visible) vis=false; if(!vis) return;',
  '      const h=silhouette(o,inv,proj,zLim); if(!h) return; hulls.push(h);',
  '      const hd=handOf(o,rig), mine=hd&&hd===supHand;',
  '      const cls = isFist(o) ? (mine?"supFist":"trgFist") : isLimb(o) ? (mine?"supArm":"trgArm") : "gun";',
  '      const lf=new M().copy(o.matrixWorld).invert().multiply(vmc.matrixWorld);',
  '      parts.push({h,cls,m:lf.elements,bb:o.geometry.boundingBox});',
  '      if(isFist(o)){ const c=new V(); o.getWorldPosition(c); c.applyMatrix4(inv);',
  '        const depth=-c.z; const q=c.clone().applyMatrix4(proj);',
  '        const a=area(h), on=area(clipFrame(h));',
  '        const wr=o.parent&&o.parent.userData&&o.parent.userData.wrist;',
  '        fists.push({x:q.x,y:q.y,depth,seen:a>1e-9?on/a:0,px:a,grip:wr?wr.z:0}); } });',
  '    const tanY=Math.tan(vmc.fov*Math.PI/360);',
  '    return {hulls,fists,parts,tanY,tanX:tanY*vmc.aspect}; };',
  '  const CH=[[0,0],[0.05,0],[-0.05,0],[0,0.05],[0,-0.05],[0.035,0.035],[-0.035,-0.035],[0.035,-0.035],[-0.035,0.035]];',
  '  const GRID=(()=>{const G=20,a=[];for(let i=0;i<G;i++)for(let j=0;j<G;j++)a.push([-1+2*(i+0.5)/G,-1+2*(j+0.5)/G]);return a;})();',
  '  const covers=(hulls,x,y)=>hulls.some(h=>inside(h,x,y));',
  // Which fist is which is decided by the hand's REST grip, stashed on the group at build
  // time, not by where the fist is now. Ordering by current depth looked equivalent and is
  // not: the support hand comes back over the receiver during a stoppage and ends up nearer
  // the eye than the trigger hand, so a depth sort silently swaps the two mid-gesture.
  '  const measure=()=>{ const f=frame(); if(!f) return null;',
  '    const {hulls,fists,parts,tanX,tanY}=f; let cov=0;',
  '    const vis={gun:0,supFist:0,supArm:0,trgFist:0,trgArm:0};',
  '    for(const [x,y] of GRID){ let best=null, bt=Infinity;',
  '      for(const q of parts){ if(!inside(q.h,x,y)) continue;',
  '        const t=rayT(q,x,y,tanX,tanY); if(t<bt){ bt=t; best=q; } }',
  '      if(best){ cov++; vis[best.cls]++; } }',
  '    for(const k in vis) vis[k]/=GRID.length;',
  '    fists.sort((a,b)=>a.grip-b.grip);',
  '    return {cov:cov/GRID.length, vis, xhair:CH.filter(([x,y])=>covers(hulls,x,y)).length, mid:covers(hulls,0,0),',
  '            n:fists.length, sup:fists[0]||null, trg:fists[fists.length-1]||null}; };',
  '  const settle=(i)=>{d.viewmodel.setWeapon(i);for(let k=0;k<5;k++)d.viewmodel.update(700,performance.now(),0,false,0,0,0,0);};',
].join('\n');

export const JAM_GUNS = [1, 2, 3, 6, 7, 8, 9];
export const NAME = { 1: 'pistol', 2: 'rifle', 3: 'sniper', 6: 'smg', 7: 'lmg', 8: 'semi', 9: 'shotgun' };
export const page = (bodyLines) => ['(() => {',
  '  const d = window.__dbg, vmc = d.view.vmRoot, rigsRoot = vmc.children[0];',
  METRIC, ...bodyLines, '})()'].join('\n');
