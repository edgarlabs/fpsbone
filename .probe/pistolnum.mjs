// Numbers for the frameFist doc comment: how big the pistol's fist is at its strike depth,
// and how much of the half-frame the frame has left to place it in.
import { withPage } from './cdp.mjs';
import { page } from './vm2.mjs';
const script = page([
  '  const now=performance.now(), out=[];',
  '  const tanY=Math.tan(vmc.fov*Math.PI/360), tanX=tanY*vmc.aspect;',
  '  for(const w of [1,2,3,6,7,8,9]){ settle(w); const rows=[];',
  '    for(let k=0;k<=20;k++){ const pp=k/20;',
  '      d.viewmodel.update(16.7,now,0,false,0,0,0,1400*(1-pp));',
  '      const m=measure(); if(!m||m.n<2) continue;',
  '      const dep=m.sup.depth;',
  '      rows.push({p:pp,dep,hx:0.062/(dep*tanX),hy:0.062/(dep*tanY),x:m.sup.x,y:m.sup.y}); }',
  '    const win=rows.filter(q=>q.p>=0.16&&q.p<=0.88);',
  '    out.push({w,minDep:Math.min(...win.map(q=>q.dep)),maxDep:Math.max(...win.map(q=>q.dep)),',
  '      maxHx:Math.max(...win.map(q=>q.hx)),maxHy:Math.max(...win.map(q=>q.hy)),',
  '      absX:Math.max(...win.map(q=>Math.abs(q.x)))}); }',
  '  return out;',
]);
const r = await withPage('http://localhost:5173/?mode=dm', async ({ evaluate }) => {
  await evaluate("document.getElementById('start')?.click(); 1");
  await evaluate('new Promise(r => setTimeout(r, 4000))');
  return evaluate(script);
});
const N={1:'pistol',2:'rifle',3:'sniper',6:'smg',7:'lmg',8:'semi',9:'shotgun'};
for (const q of r) console.log(`${N[q.w].padEnd(8)} depth ${q.minDep.toFixed(3)}..${q.maxDep.toFixed(3)}m  fist halfwidth ${q.maxHx.toFixed(2)} halfheight ${q.maxHy.toFixed(2)} of half-frame  room 1-hx=${(1-q.maxHx).toFixed(2)}  |x|max ${q.absX.toFixed(2)}`);
