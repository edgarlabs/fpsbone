// Screenshot the stoppage at chosen points in the animation, per weapon.
// Deterministic: the game's own update is wrapped so it renders the phase asked for on
// every frame, instead of screenshotting whatever moment the real clock happened to be in.
import { withPage } from './cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { JAM_GUNS, NAME } from './vm2.mjs';

const CLEAR = 1400;
const PHASES = [0.0, 0.2, 0.3, 0.44, 0.55, 0.78];   // rest, wind-up, hit1, lift, hit2, rack
const WANT = (process.env.W || JAM_GUNS.join(',')).split(',').map(Number);
mkdirSync('.probe/shots', { recursive: true });

await withPage('http://localhost:5173/?mode=dm', async ({ evaluate, send }) => {
  await evaluate("document.getElementById('start')?.click(); 1");
  await evaluate('new Promise(r => setTimeout(r, 4000))');
  await evaluate(`(() => { const d = window.__dbg, vm = d.viewmodel, real = vm.update.bind(vm);
    window.__forceJam = null;
    vm.update = (dt, now, sp, alt, rl, cr, sc, jm) =>
      real(dt, now, 0, false, 0, 0, 0, window.__forceJam == null ? jm : window.__forceJam);
    return 1; })()`);

  // HIDE=hands drops both arms for the shot. What the weapon alone does during a stoppage
  // is the other half of "i cant see it punching the gun", and it cannot be read off a
  // frame where the arm is in the way.
  if (process.env.HIDE === 'hands') {
    await evaluate(`(() => { const d = window.__dbg, vm = d.viewmodel, real = vm.update.bind(vm);
      const root = d.view.vmRoot.children[0];
      vm.update = (...a) => { const r = real(...a);
        root.traverse((o) => { if (o.userData && o.userData.wrist) o.visible = false; }); return r; };
      return 1; })()`);
  }

  for (const w of WANT) {
    // The game loop calls setWeapon from the server's view of what is held, so a plain
    // setWeapon here is undone on the next frame and every weapon screenshots as the rifle.
    await evaluate(`(() => { const vm = window.__dbg.viewmodel;
      if (!vm.__realSet) vm.__realSet = vm.setWeapon.bind(vm);
      vm.setWeapon = () => {}; vm.__realSet(${w}); window.__forceJam = null; return 1; })()`);
    await evaluate('new Promise(r => setTimeout(r, 700))');
    for (const p of PHASES) {
      await evaluate(`window.__forceJam = ${p === 0 ? 0 : CLEAR * (1 - p)}; 1`);
      await evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
      const s = await send('Page.captureScreenshot', { format: 'png' });
      const name = `.probe/shots/${process.env.HIDE === 'hands' ? 'bare-' : ''}${NAME[w]}-p${String(Math.round(p * 100)).padStart(2, '0')}.png`;
      writeFileSync(name, Buffer.from(s.result.data, 'base64'));
      console.log(name);
    }
  }
  await evaluate('window.__forceJam = null; 1');
});
