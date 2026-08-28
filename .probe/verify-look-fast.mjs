import { withPage } from './cdp.mjs';

// Same A/B, but with the compositor's vsync cap removed so rAF runs faster than the 60Hz
// simulation tick — which is the case on any gaming monitor, and the case where the old
// camera fell apart. `camera.rotation.y` is what is drawn now (live mouse);
// `predictor.state.yaw` is what used to be drawn (the fixed 60Hz tick).
const script = `
(async () => {
  const d = window.__dbg;
  if (!d) return { err: 'no __dbg hook' };
  d.canvas.requestPointerLock();
  await new Promise(r => setTimeout(r, 600));
  if (document.pointerLockElement !== d.canvas) return { err: 'pointer lock refused' };

  // measure the display rate we actually got
  let t0 = performance.now(), n = 0;
  while (performance.now() - t0 < 1000) { await new Promise(r => requestAnimationFrame(r)); n++; }
  const hz = n * 1000 / (performance.now() - t0);

  const N = 600;
  let camFrozen = 0, simFrozen = 0;
  const camErr = [], simErr = [];
  let prevCam = d.view.camera.rotation.y, prevSim = d.predictor.state.yaw;
  const camVals = new Set(), simVals = new Set();
  const tStart = performance.now();

  for (let i = 0; i < N; i++) {
    document.dispatchEvent(new MouseEvent('mousemove', { movementX: 8, movementY: 0, bubbles: true }));
    await new Promise(r => requestAnimationFrame(r));
    const want = d.input.lookYaw, cam = d.view.camera.rotation.y, sim = d.predictor.state.yaw;
    if (cam === prevCam) camFrozen++;
    if (sim === prevSim) simFrozen++;
    camVals.add(cam); simVals.add(sim);
    camErr.push(Math.abs(want - cam)); simErr.push(Math.abs(want - sim));
    prevCam = cam; prevSim = sim;
  }
  const secs = (performance.now() - tStart) / 1000;
  return { hz, frames: N, secs, camFrozen, simFrozen, camErr, simErr,
           camDistinct: camVals.size, simDistinct: simVals.size,
           degPerStep: 8 * 0.0022 * 180 / Math.PI };
})()
`;

const res = await withPage('http://localhost:5173/?mode=snow', async ({ evaluate }) => {
  await evaluate(`document.getElementById('start')?.click(); 1`);
  await evaluate(`new Promise(r => setTimeout(r, 3000))`);
  return evaluate(script);
}, { flags: ['--disable-frame-rate-limit', '--disable-gpu-vsync', '--disable-features=CalculateNativeWinOcclusion'] });

if (res.err) { console.log('ERR:', res.err); process.exit(1); }
const deg = (r) => r * 180 / Math.PI;
const st = (a) => { const s=[...a].sort((x,y)=>x-y), p=(q)=>s[Math.min(s.length-1,Math.floor(s.length*q))];
  return `p50=${deg(p(.5)).toFixed(2)}deg p90=${deg(p(.9)).toFixed(2)}deg max=${deg(s[s.length-1]).toFixed(2)}deg`; };

console.log(`display ${res.hz.toFixed(0)}Hz vs 60Hz sim tick | ${res.frames} frames in ${res.secs.toFixed(2)}s, ${res.degPerStep.toFixed(3)}deg of mouse per frame\n`);
console.log(`camera reads the mouse (now):`);
console.log(`   frames that did not move       : ${res.camFrozen}/${res.frames}  (${(100*res.camFrozen/res.frames).toFixed(1)}%)`);
console.log(`   distinct view angles drawn     : ${res.camDistinct}  (${(res.camDistinct/res.secs).toFixed(0)}/s)`);
console.log(`   behind the mouse               : ${st(res.camErr)}`);
console.log(`\ncamera reads the sim tick (before):`);
console.log(`   frames that did not move       : ${res.simFrozen}/${res.frames}  (${(100*res.simFrozen/res.frames).toFixed(1)}%)`);
console.log(`   distinct view angles drawn     : ${res.simDistinct}  (${(res.simDistinct/res.secs).toFixed(0)}/s)`);
console.log(`   behind the mouse               : ${st(res.simErr)}`);
