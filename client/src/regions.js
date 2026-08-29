// Measuring how far away each server is, from the browser, without lying about it.
//
// The number this file produces is the only reason regions are worth offering: a player who
// can see 38ms next to ASIA and 210ms next to AMERICA needs no explanation of why one duel
// felt fair and the other felt rigged. Everything below is in service of that number being
// true, because a ping display that is wrong is worse than none — it moves people to a worse
// server and tells them it was the right call.
//
// WHY HTTP AND NOT THE GAME SOCKET. A WebSocket round trip is what the match will actually
// experience, so it is the more honest instrument, and it is also unusable here: opening one
// per region means a handshake per region, a room join per region, and — on a host that spins
// idle services down — waking every server in the world every time somebody opens the menu.
// A warm-connection GET of /ping travels the same fibre through the same peering and lands
// within a few ms of the socket's own round trip, which is far inside the precision anyone
// acts on. What it cannot see is the server being too slow to answer in time; that is a
// different measurement and belongs beside the snapshot clock, not here.
//
// THE FIRST SAMPLE IS ALWAYS A LIE, and discarding it is most of the accuracy. It carries DNS,
// the TCP handshake, and a TLS negotiation — two more round trips before a byte of payload —
// and on a free host it may also carry a cold start of a minute. Reporting it would tell a
// player their neighbour's server is in another galaxy. So: one throwaway, then samples on the
// warm connection, and the median is the answer. The minimum advertised the luckiest packet
// rather than the connection a whole match has to live with; the median rejects one scheduling
// hitch without pretending ordinary queueing never happens.

import { HERE, REGIONS, fastest, pingGrade, wsOrigin } from '../../shared/regions.js';

/** Discarded — the connection-setup sample. */
const WARMUP = 1;
/** Kept. Three is the smallest set where a median rejects one lucky or unlucky packet. */
const SAMPLES = 3;
/** A cold free-tier instance gets one long wake-up request. Once awake, an individual sample
 * should never take more than five seconds; four separate 70s limits made a dead card wait up
 * to 280 seconds before it admitted the server was unreachable. */
const WARM_TIMEOUT_MS = 70000;
const SAMPLE_TIMEOUT_MS = 5000;
/** Past this, the first sample was a wake-up rather than a handshake, and the player is owed
 *  that fact — their first match on this region starts after a stall nobody warned them of. */
const WOKE_MS = 2500;

/**
 * The regions this page can offer, in menu order, asked of the server that served the page.
 *
 * Its own origin always appears. On a checkout or a single-region deploy that is the entire
 * list and no request is needed to know it — which is why this resolves to something useful
 * even when /regions is missing, as it is on any build older than this file.
 */
export async function loadRegions() {
  const here = {
    id: HERE,
    label: 'THIS SERVER',
    where: location.host || 'this machine',
    host: location.origin,
    mine: true,
  };

  let self = null;
  let listed = [];
  try {
    const res = await fetch('/regions', { cache: 'no-store' });
    if (res.ok) {
      const body = await res.json();
      self = typeof body?.self === 'string' ? body.self : null;
      listed = Array.isArray(body?.regions) ? body.regions : [];
    }
  } catch {
    // No /regions endpoint, or nothing serving HTTP at all (a dev page on vite talking to a
    // socket elsewhere). One server, and it is the one that answered.
  }

  const out = [];
  for (const r of listed) {
    if (!Object.hasOwn(REGIONS, r?.id) || typeof r.host !== 'string') continue;
    // The server we are already talking to, under its own name. Marked rather than skipped:
    // the player should see which of the five they are on, not find their own region missing.
    out.push({ ...REGIONS[r.id], id: r.id, host: r.host, mine: r.id === self });
  }
  // Only offer the bare origin when it is not already in the list under a region name, or the
  // same box appears twice and its two cards disagree by a millisecond or two.
  if (!out.some((r) => r.mine)) out.unshift(here);
  return out;
}

/**
 * Time one region. Resolves to `{ id, ms, humans, lob, state, woke }` and never rejects — a
 * region that cannot be reached is a result, not an error, and the menu has a word for it.
 *
 * `onProgress` fires once, when the throwaway sample is still outstanding after WOKE_MS, so a
 * card can say `waking…` instead of sitting blank for a minute on a sleeping free instance.
 */
export async function probeRegion(region, onProgress) {
  const url = `${region.host}/ping`;
  const times = [];
  let body = null;
  let woke = false;

  const slow = setTimeout(() => onProgress?.({ ...region, state: 'waking' }), WOKE_MS);
  try {
    for (let i = 0; i < WARMUP + SAMPLES; i++) {
      const ctl = new AbortController();
      const bail = setTimeout(
        () => ctl.abort(),
        i < WARMUP ? WARM_TIMEOUT_MS : SAMPLE_TIMEOUT_MS,
      );
      const t0 = performance.now();
      // `no-store` is not a nicety: a cached 200 returns in under a millisecond and would
      // report every region on earth as being in the next room.
      let res;
      try {
        res = await fetch(url, { cache: 'no-store', signal: ctl.signal });
      } finally {
        clearTimeout(bail);
      }
      const dt = performance.now() - t0;
      if (!res.ok) throw new Error(`${res.status}`);
      body = await res.json();
      if (i < WARMUP) {
        if (dt > WOKE_MS) woke = true;
        continue;
      }
      times.push(dt);
    }
  } catch {
    clearTimeout(slow);
    return { ...region, ms: NaN, humans: null, lob: null, state: 'down', woke };
  }
  clearTimeout(slow);

  const ordered = [...times].sort((a, b) => a - b);
  const ms = Math.round(ordered[Math.floor(ordered.length / 2)]);
  return {
    ...region,
    ms,
    humans: Number.isFinite(body?.humans) ? body.humans : null,
    lob: body?.lob ?? null,
    state: 'ok',
    woke,
    grade: pingGrade(ms),
  };
}

/**
 * Probe every region at once and report each as it lands.
 *
 * Concurrent because they are different machines and serialising would make the last card in
 * the list wait for a sleeping instance ahead of it. `onEach` is called with the whole result
 * list every time one changes, so the caller can repaint without keeping its own copy.
 */
export function probeAll(regions, onEach) {
  const byId = new Map(regions.map((r) => [r.id, { ...r, ms: NaN, state: 'pending' }]));
  const emit = () => onEach?.([...byId.values()]);
  emit();

  return Promise.all(regions.map(async (r) => {
    const result = await probeRegion(r, (p) => {
      // Only a progress note, and only if nothing final has landed for this region yet.
      if (byId.get(p.id)?.state === 'pending') { byId.set(p.id, { ...byId.get(p.id), state: p.state }); emit(); }
    });
    byId.set(r.id, result);
    emit();
    return result;
  })).then((rs) => rs);
}

/**
 * The socket address for a chosen region, or null to mean "the server that served this page".
 *
 * Null rather than a computed same-origin url so the caller keeps its existing behaviour for
 * the default case — the one path that has always worked and needs no region table to work.
 */
export function socketFor(regionId, host) {
  if (!regionId || regionId === HERE || !host) return null;
  return wsOrigin(host);
}

// Re-exported so a caller that only needs to name the default, or grade a number it already
// has, does not have to reach past this module into shared/.
export { HERE, fastest, pingGrade };
