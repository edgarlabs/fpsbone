// What the SHIPPED reload already looks like on the same weapon, for scale.
// The pistol's support hand sits 22cm from the eye, so any pose that brings it out from
// behind the gun makes it about a third of the frame tall. Whether that is a regression or
// just what this rig looks like up close is a question only the shipped animation answers.
import { withPage } from './cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { NAME } from './vm2.mjs';

const W = Number(process.env.W || 1);
const MS = Number(process.env.MS || 1200);
const PHASES = [0.15, 0.35, 0.55, 0.8];
mkdirSync('.probe/shots', { recursive: true });

await withPage('http://localhost:5173/?mode=dm', async ({ evaluate, send }) => {
  await evaluate("document.getElementById('start')?.click(); 1");
  await evaluate('new Promise(r => setTimeout(r, 4000))');
  await evaluate(`(() => { const d = window.__dbg, vm = d.viewmodel, real = vm.update.bind(vm);
    window.__forceRl = null;
    if (!vm.__realSet) vm.__realSet = vm.setWeapon.bind(vm);
    vm.__realSet(${W}); vm.setWeapon = () => {};
    vm.update = (dt, now, sp, alt, rl, cr, sc, jm) =>
      real(dt, now, 0, false, window.__forceRl == null ? rl : window.__forceRl, 0, 0, 0);
    return 1; })()`);
  await evaluate('new Promise(r => setTimeout(r, 400))');
  for (const p of PHASES) {
    await evaluate(`window.__forceRl = ${MS * (1 - p)}; 1`);
    await evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    const s = await send('Page.captureScreenshot', { format: 'png' });
    const name = `.probe/shots/reload-${NAME[W]}-p${String(Math.round(p * 100)).padStart(2, '0')}.png`;
    writeFileSync(name, Buffer.from(s.result.data, 'base64'));
    console.log(name);
  }
});
