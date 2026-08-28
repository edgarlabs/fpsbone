import { withPage } from './cdp.mjs';
import { WEAPON_IDS } from '../shared/weapons.js';

const out = await withPage('http://localhost:5173/?mode=snow', async ({ evaluate }) => {
  await evaluate(`document.getElementById('start')?.click(); 1`);
  await evaluate(`new Promise(r=>setTimeout(r,2500))`);
  return await evaluate(`(async () => {
    const d = window.__dbg;
    const hand = d.view.vmRoot.children.find(c => c.isGroup);
    const gs = hand.children.filter(c => c.isGroup);
    const rep = {};
    rep.wep = d.input.weapon;
    rep.visibleRig = gs.map((c,i)=>c.visible?i:-1).filter(i=>i>=0);
    rep.visibleMeshes = [];
    d.view.vmRoot.traverse((o) => {
      if (!o.isMesh) return;
      let p = o, on = true;
      while (p) { if (p.visible === false) { on = false; break; } p = p.parent; }
      if (!on) return;
      const g = o.geometry, q = g.parameters || {};
      rep.visibleMeshes.push((g.type === 'IcosahedronGeometry' ? 'SPHERE r'+q.radius : 'BOX '+[q.width,q.height,q.depth].join('x')) + ' #' + o.material.color.getHexString());
    });

    // which audio + tracer paths a throw takes
    const calls = [];
    for (const k of ['shot','swing','toss','thud']) {
      const orig = d.audio[k].bind(d.audio);
      d.audio[k] = (...a) => { calls.push(k+'('+a.map(x=>JSON.stringify(x)).join(',')+')'); return orig(...a); };
    }
    const vt = d.viewmodel.tracer.bind(d.viewmodel);
    let tracers = 0;
    d.viewmodel.tracer = (...a) => { tracers++; return vt(...a); };

    const cv = d.canvas;
    cv.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    await new Promise(r=>setTimeout(r,500));
    cv.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    await new Promise(r=>setTimeout(r,700));
    rep.audioCalls = calls;
    rep.tracersDrawn = tracers;
    return rep;
  })()`);
});
out.visibleRigIds = out.visibleRig.map(i => WEAPON_IDS[i]);
out.wepId = WEAPON_IDS[out.wep];
console.log(JSON.stringify(out, null, 2));
