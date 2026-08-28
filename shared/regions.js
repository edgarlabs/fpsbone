// Which server you play on, and where in the world it is.
//
// WHY REGIONS EXIST. A packet cannot outrun light, and light is slow across an ocean: about
// 65ms Singapore↔Oregon one way through fibre that does not travel in a straight line, so
// ~180ms round trip on a good day. At 60Hz that is eleven ticks of the simulation between
// pressing fire and the server hearing about it, and no amount of prediction hides that when
// two people shoot at each other — the client can guess where YOU are going, never where
// somebody else has already been. The only fix is a shorter cable, which means a server
// closer to you. So: several servers, and the player picks.
//
// A REGION ID IS COMPILED IN, A REGION'S ADDRESS IS NOT, and that split is deliberate. The
// labels below are facts about the world that belong in source. The hostnames are facts about
// one deploy — a host generates them, they differ per account, and a region added on Tuesday
// must not need a rebuild of a bundle that shipped on Monday. So each server is told the
// addresses at runtime (FPSBONE_REGIONS) and hands the table to the client over /regions.
// See `parseRegions` for the format and server/serve.js for where it is read.
//
// Anything not listed here cannot be named by that env var, which is the point: a typo in a
// deploy config gets dropped with a log line rather than becoming a region called "sae" that
// every player sees and nobody can reach.

/**
 * The places a server can be, keyed by the id used in FPSBONE_REGIONS and in `?region=`.
 *
 * `label` is what the menu shows and is deliberately continental rather than exact — a player
 * from Manila picking a server is choosing "near me", not choosing Singapore. `where` carries
 * the exact truth underneath it, because "ASIA · Singapore" is the difference between a
 * 40ms surprise and a 40ms explanation.
 */
export const REGIONS = {
  sea: { label: 'ASIA', where: 'Singapore' },
  usw: { label: 'AMERICA', where: 'Oregon, USA' },
  usc: { label: 'AMERICA · CENTRAL', where: 'Ohio, USA' },
  use: { label: 'AMERICA · EAST', where: 'Virginia, USA' },
  eu: { label: 'EUROPE', where: 'Frankfurt, Germany' },
};

export const REGION_IDS = Object.keys(REGIONS);

/**
 * The server that served this page, whatever and wherever it is.
 *
 * Always offered, and offered first: it is the one address that is certainly right, it needs
 * no configuration to exist, and on a checkout or a single-region deploy it is the only
 * server there is. Its ping is also the only one measured over the connection the page
 * already has open, so it is the most honest number on the screen.
 */
export const HERE = 'here';

/** Let the lowest ping decide? NO — there is no `auto` here, deliberately. Picking for the
 *  player means either stalling the menu until every region has answered, or connecting to one
 *  server and then yanking the page onto another mid-thought. What replaced it is a marker:
 *  the fastest region is labelled as such and the click is still theirs. See `fastest` below. */

export const isRegion = (id) => id === HERE || Object.hasOwn(REGIONS, id);

/** The lowest ping among the regions that answered, or null if none did. Ties go to whoever
 *  the table lists first, which keeps a repaint from reshuffling the marker. */
export function fastest(results) {
  let best = null;
  for (const r of results) {
    if (!Number.isFinite(r.ms)) continue;
    if (!best || r.ms < best.ms) best = r;
  }
  return best;
}

/**
 * Parse FPSBONE_REGIONS — `id=url` pairs, comma or whitespace separated:
 *
 *   sea=https://fpsbone-sea.onrender.com,usw=https://fpsbone-us.onrender.com
 *
 * Returns `{ regions, dropped }`: the entries that survived, in the order the table above
 * declares them so the menu does not reshuffle when a deploy config is reordered, and the
 * raw text of everything thrown away so the server can say what it ignored instead of
 * silently offering fewer regions than somebody configured.
 *
 * Rejected, each for a reason worth more than the leniency:
 *   an unknown id      — it would render as a blank card nobody can label
 *   a non-http scheme  — the client turns http→ws and https→wss and nothing else
 *   a url with a path  — endpoints are appended, so a trailing path silently 404s them all
 *   a duplicate id     — two addresses for one place is a config bug, not a preference
 */
export function parseRegions(spec) {
  const regions = [];
  const dropped = [];
  const seen = new Set();

  for (const chunk of String(spec ?? '').split(/[,\s]+/).filter(Boolean)) {
    const at = chunk.indexOf('=');
    const id = at < 0 ? '' : chunk.slice(0, at).trim();
    const raw = at < 0 ? '' : chunk.slice(at + 1).trim();
    if (!Object.hasOwn(REGIONS, id) || !raw || seen.has(id)) { dropped.push(chunk); continue; }

    let url;
    try {
      url = new URL(raw);
    } catch {
      dropped.push(chunk);
      continue;
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.pathname !== '/') {
      dropped.push(chunk);
      continue;
    }

    seen.add(id);
    regions.push({ id, ...REGIONS[id], host: url.origin });
  }

  regions.sort((a, b) => REGION_IDS.indexOf(a.id) - REGION_IDS.indexOf(b.id));
  return { regions, dropped };
}

/** A hostname or a full url as a url. Hosts that inject their own hostname into the
 *  environment hand over a bare `name.onrender.com`, and https is what they serve. */
const withScheme = (v) => (/^https?:\/\//.test(String(v)) ? String(v) : `https://${v}`);

/**
 * Everything the environment says about regions, in one place: which region this process is,
 * and where the others are.
 *
 * Three sources, because neither a hand-written deploy nor a blueprint-driven one should have
 * to do the other's work:
 *
 *   FPSBONE_REGIONS=sea=https://a,usw=https://b   one var, written by a person, any host
 *   FPSBONE_PEER_SEA=fpsbone-sea.onrender.com     one var per region, filled in by the host
 *   FPSBONE_REGION + FPSBONE_HOST                 this process's own address, so the menu can
 *   (or RENDER_EXTERNAL_HOSTNAME)                 name it by its region instead of "here"
 *
 * The middle shape is not redundancy. A Render blueprint CAN inject another service's hostname
 * (`fromService`) but cannot splice it into a longer string, so a multi-region deploy that
 * configures nothing by hand has to name each peer in a var of its own — which is the whole
 * difference between a blueprint that just works and a deploy that needs a dashboard visit.
 *
 * The third is what stops the page you are actually on from appearing as an unlabelled "THIS
 * SERVER" card next to four named ones: a server knows its region, and hosts tell a process
 * its public hostname, so between them it can list itself.
 *
 * Order is precedence, because `parseRegions` keeps the first address it sees for an id: a
 * hand-written entry beats an injected one, and both beat this process's claim about itself.
 */
export function regionsFromEnv(env = {}) {
  const region = Object.hasOwn(REGIONS, env.FPSBONE_REGION ?? '') ? env.FPSBONE_REGION : null;
  const selfHost = env.FPSBONE_HOST || env.RENDER_EXTERNAL_HOSTNAME || '';

  const parts = [String(env.FPSBONE_REGIONS ?? '')];
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith('FPSBONE_PEER_') || !v) continue;
    parts.push(`${k.slice('FPSBONE_PEER_'.length).toLowerCase()}=${withScheme(v)}`);
  }
  if (region && selfHost) parts.push(`${region}=${withScheme(selfHost)}`);

  return { region, ...parseRegions(parts.filter(Boolean).join(',')) };
}

/**
 * An http(s) origin as the ws(s) origin a WebSocket needs.
 *
 * The swap is not cosmetic: a browser refuses a ws:// socket opened from an https: page as
 * mixed content, with no way for the page to ask again. Deriving the scheme from the region's
 * own url rather than from `location` is what lets a page on https talk to a region on https
 * and a checkout on http talk to localhost.
 */
export const wsOrigin = (httpOrigin) => String(httpOrigin).replace(/^http/, 'ws');

/**
 * Round-trip milliseconds → what to call it, for colouring one badge.
 *
 * The boundaries are where the game changes rather than where the numbers look tidy. Under
 * 60ms a hitscan duel feels like the server agrees with your screen. By 150 you are leading
 * moving targets. Past 250 you are playing a different match to everyone else and the honest
 * thing is to say so in a colour, not to print three digits and let the player wonder.
 */
export function pingGrade(ms) {
  if (!Number.isFinite(ms)) return 'none';
  if (ms < 60) return 'good';
  if (ms < 150) return 'fair';
  if (ms < 250) return 'poor';
  return 'bad';
}
