// Per-frame screen-space trace of the support fist through a whole stoppage.
// Answers exactly the two things the change has to get right: can you see the fist
// hitting the gun, and does it ever sit on the crosshair.
import { withPage } from './cdp.mjs';
import { page, JAM_GUNS, NAME } from './vm2.mjs';

const script = page([
  '  const now=performance.now(), out={};',
  `  for(const w of [${JAM_GUNS}]){ settle(w); const rows=[];`,
  '    for(let k=0;k<=20;k++){ const pp=k/20;',
  '      d.viewmodel.update(16.7,now,0,false,0,0,0,1400*(1-pp));',
  '      const m=measure(); const f=m&&m.sup;',
  '      if(m&&m.n<2) throw new Error("lost a fist at w="+w+" p="+pp+" (NaN pose?)");',
  '      rows.push(f?{p:+pp.toFixed(2),x:+f.x.toFixed(2),y:+f.y.toFixed(2),z:+f.depth.toFixed(3),',
  '        seen:+f.seen.toFixed(2),cov:Math.round(100*m.cov),xh:m.xhair,mid:m.mid?1:0,',
  '        gun:Math.round(100*m.vis.gun),arm:Math.round(100*m.vis.supArm),',
  '        fist:Math.round(100*m.vis.supFist)}:null); }',
  '    out[w]=rows; }',
  '  return out;',
]);
const r = await withPage('http://localhost:5173/?mode=dm', async ({ evaluate }) => {
  await evaluate("document.getElementById('start')?.click(); 1");
  await evaluate('new Promise(r => setTimeout(r, 4000))');
  return evaluate(script);
});
const f2 = (v) => v.toFixed(2);
let worstSeen = 1, xhairFrames = 0, midFrames = 0;
for (const [w, rows] of Object.entries(r)) {
  // The working window: outside it `tip` is ramping and the pose is the rest pose.
  const win = rows.filter((q) => q.p >= 0.16 && q.p <= 0.88);
  const minSeen = Math.min(...win.map((q) => q.seen));
  const trav = Math.max(...win.map((q) => q.y)) - Math.min(...win.map((q) => q.y));
  worstSeen = Math.min(worstSeen, minSeen);
  xhairFrames += rows.filter((q) => q.xh > 0).length;
  midFrames += rows.filter((q) => q.mid).length;
  console.log(`${NAME[w].padEnd(8)} fistY ${f2(Math.min(...win.map((q) => q.y)))}..${f2(Math.max(...win.map((q) => q.y)))}`
    + `  travel ${trav.toFixed(2)}  visible ${(100 * minSeen).toFixed(0)}%..${(100 * Math.max(...win.map((q) => q.seen))).toFixed(0)}%`
    + `  |x|max ${f2(Math.max(...win.map((q) => Math.abs(q.x))))}`
    + `  xhair ${rows.filter((q) => q.xh > 0).length}/${rows.length}f (max ${Math.max(...rows.map((q) => q.xh))}/9)`
    + `  centre ${rows.filter((q) => q.mid).length}f  cov ${Math.max(...rows.map((q) => q.cov))}%`);
  // Whose screen is it. A fist that measures 100% inside the frame can still be a sliver on
  // the tip of a forearm that has swallowed the gun, and only this line says so.
  console.log(`         gun seen ${Math.min(...win.map((q) => q.gun))}%..${Math.max(...win.map((q) => q.gun))}%`
    + `   support arm ${Math.min(...win.map((q) => q.arm))}%..${Math.max(...win.map((q) => q.arm))}%`
    + `   support fist ${Math.min(...win.map((q) => q.fist))}%..${Math.max(...win.map((q) => q.fist))}%`);
  if (process.env.V) console.log('   ' + rows.map((q) => `${q.p}|y${q.y} s${q.seen}`).join('  '));
}
console.log(`\nworst visibility in any working frame: ${(100 * worstSeen).toFixed(0)}%   `
  + `frames touching crosshair: ${xhairFrames}   frames covering exact centre: ${midFrames}`);
