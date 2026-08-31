// Entry point. Owns the frame loop and wires the pieces together.
//
// Two clocks run here: a fixed 60 Hz simulation step that produces exactly one
// input per tick (so delta-time never goes on the wire), and the render loop,
// which runs as fast as the display allows.
//
// Query params:
//   ?name=foo              display name
//   ?mode=tdm              game mode to join (also a saved setting)
//   ?hand=left&fov=95      settings overrides, persisted like any other change
//   ?lag=150&jitter=30     artificial round-trip latency, in ms
//   ?server=wss://host      play on a real server instead of the in-page one
//   ?local=1                force the in-page host, even in dev

import * as THREE from 'three';
import * as C from '../../shared/constants.js';
import { INPUT_REDUNDANCY, EV, REJECT } from '../../shared/protocol.js';
import { eyeY } from '../../shared/movement.js';
import { SPAWNS } from '../../shared/map.js';
import { MODES, MODE_IDS, TEAM_NAMES, modeOf, CORPSE_MS } from '../../shared/modes.js';
import { WEAPON_IDS, WEAPONS, idAt, indexOf, spreadMul, weaponAt } from '../../shared/weapons.js';
import { TRACK_KEYS, badgeOf, levelOf, stepOf, tierOf } from '../../shared/badges.js';
import { SPREE_MS, wingsOf } from '../../shared/spree.js';
import { cleanStats } from '../../shared/progression.js';
import { DEFAULT_FINISH, sanitizeInventory } from '../../shared/cosmetics.js';
import {
  exportRecoveryCode, getIdentity, importRecoveryCode, setIdentityCosmetics,
} from './identity.js';
import { getSettings } from './settings.js';
import { HERE, loadRegions, probeAll, socketFor } from './regions.js';
import { createMenu } from './menu.js';
import { createInput } from './input.js';
import { createNet } from './net.js';
import { createLocalSocket } from './localserver.js';
import { createPredictor } from './predict.js';
import { createInterpolator } from './interp.js';
import { createScene } from './render.js';
import { createViewmodel } from './viewmodel.js';
import { createHud } from './hud.js';
import { createAudio } from './audio.js';
import { accountOrigin, createAccountClient } from './account-client.js';

const qs = new URLSearchParams(location.search);
const lag = Number(qs.get('lag')) || 0;
const jitter = Number(qs.get('jitter')) || 0;
/** Read before the host block below, because the region stored in it is now one of the
 *  answers to "which server" — see the precedence list there. */
const settings = getSettings();
/**
 * Which host this client talks to. Four answers, in falling order of precedence, and the two
 * in the middle are what make internet multiplayer possible from a build.
 *
 *   ?server=wss://host   this page, this once. The escape hatch, and it beats everything.
 *   the chosen region    a server somewhere else in the world, picked in the menu and stored
 *                        with its address so it can be dialled before any region table has
 *                        loaded — see the `region` field in settings.js. This is the whole of
 *                        what choosing ASIA over AMERICA does.
 *   VITE_SERVER          baked in when the bundle was built. The literal `origin` means
 *                        "whatever host served this page", which is the shape a deploy that
 *                        serves the client AND the WebSocket from one process takes — see
 *                        the header of server/serve.js. Any other value is used verbatim,
 *                        for a client on one host and a game server on another.
 *   nothing              a dev checkout talks to `npm run server` on this machine; a build
 *                        with no server baked in runs the in-page host from localserver.js.
 *
 * WHY A BUILD-TIME VALUE RATHER THAN SNIFFING. There is nothing a page can synchronously
 * observe that distinguishes "served by a host that can hold a WebSocket" from "served out
 * of a bucket that cannot" — the HTML is byte-identical. Guessing would mean a probe with a
 * timeout, which is a stall on every load and a wrong answer on a slow one. Whoever built
 * the bundle knows, so they say.
 *
 * A REGION IS NOT THE SAME KIND OF FACT, which is why it sits above VITE_SERVER rather than
 * inside it: the bundle says whether there is a server at all, and the player says which one.
 * A chosen region also means the game socket is cross-origin — fine for a WebSocket, and the
 * reason /ping and /regions send CORS headers while nothing else does.
 *
 * `?local=1` still forces the in-page host, which is how the bots-only path stays reachable
 * from a real deploy for a quick offline match.
 */
const explicitServer = qs.get('server');
/** Same-origin WebSocket URL: wss: from an https: page, or the browser refuses it as mixed
 *  content. The port rides along in `location.host`, so a non-standard one survives. */
const sameOrigin = () => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
/** The stored region, as a socket url — null for "this server", which is the default and the
 *  only case that needs no address to work. */
const regionUrl = socketFor(settings.region, settings.regionHost);
const baked = import.meta.env.VITE_SERVER;
const bakedUrl = baked ? (baked === 'origin' ? sameOrigin() : baked) : null;
const useLocalHost =
  qs.get('local') === '1'
  || (!explicitServer && !regionUrl && !bakedUrl && !import.meta.env.DEV);
const url =
  explicitServer ?? regionUrl ?? bakedUrl ?? `ws://${location.hostname || 'localhost'}:${C.NET_PORT}`;

/** What to say when there is no connection. The in-page host cannot be restarted out from
 *  under the page and there is no `npm run dev` to check, so telling someone to do either
 *  would be advice for a situation they are not in. */
const DOWN_MSG = useLocalHost
  ? 'match closed — return to the lobby and join again'
  : 'connection lost — reconnecting…';
const UNREACHABLE_MSG = useLocalHost
  ? 'the in-page host failed to start — check the console'
  : 'cannot reach server — is `npm run dev` running?';

/**
 * Tell the player which host they are on, but only when the answer is the surprising one.
 *
 * A lobby served by the in-page host is indistinguishable from a lobby served by a real one:
 * ten slots, a mode picker, an occupancy count that is honest about the room it can see. What
 * it cannot show is that the room is PRIVATE — so somebody who joins deathmatch on a phone and
 * then joins it again on a PC finds a second nine-bot match and reasonably concludes the lobby
 * is broken. It is not; there are simply two servers, one per tab. This is the one place the
 * page can say so, and it is written here because `useLocalHost` above is the whole of the
 * decision and this module makes it.
 *
 * Silent on a real server, where "you can meet other people" needs no explaining.
 */
{
  const el = document.getElementById('host-note');
  if (el && useLocalHost) {
    el.hidden = false;
    el.innerHTML =
      '<b>This page is its own server.</b> It was built with no game server behind it, so the '
      + 'match runs inside your browser: the ten slots are real, the other nine are bots, and '
      + 'nobody can join you — two devices on this URL get two separate rooms. Playing with '
      + 'people needs one server both of you reach. Add <b>?server=wss://your-host</b> to try '
      + 'one now, or rebuild with <b>VITE_SERVER</b> set to make it the default.';
  }
}

const canvas = document.getElementById('game');
const identity = await getIdentity();
const accountApi = useLocalHost ? null : createAccountClient({
  origin: accountOrigin(url),
  identity,
});
let socialToken = null;
let socialMatchJoining = false;
/** What we asked for, kept because the server may seat us somewhere else. */
let requestedMode = settings.mode;

const hud = createHud();
const audio = createAudio();
const view = createScene(canvas, settings.fov);
// The weapon lives in its own render pass — `view.vmRoot` is that pass's camera,
// which is also its camera space, so rig offsets go in unchanged.
const viewmodel = createViewmodel(view.camera, view.scene, view.vmRoot, {
  // Fires when the swap hands over, part-way through the animation — the viewmodel
  // owns that timing, so it has to be the thing that says when.
  onDraw: (id, weight, cockInMs) => audio.draw(weight, cockInMs),
  // Fires on the shot, for a weapon whose action has to be worked before the next one.
  // Both beats come from the animation because it owns where they land in the stroke.
  onCycle: (id, weight, backInMs, homeInMs) => audio.cycle(weight, backInMs, homeInMs),
});
viewmodel.setFinish(identity.cosmetics.finish);
// This is intentionally the authoritative throw path used by 2df5a1e. The later
// click-time prediction path could leave throwables frozen in their release pose while
// the server projectile and fuse continued out of sight.
const input = createInput(canvas, settings);
const interp = createInterpolator();
const net = createNet({
  url,
  // Undefined leaves net.js on its own default, a real WebSocket. Passing the factory is
  // the whole of what switching to the in-page host takes — see localserver.js.
  openSocket: useLocalHost ? createLocalSocket : undefined,
  identity,
  mode: settings.mode,
  lag,
  jitter,
});
const predictor = createPredictor(SPAWNS[0]);

let selfId = null;
/** Has the first authoritative snapshot landed? Nothing simulates before it. */
let primed = false;
let latestPlayers = [];
/**
 * Who is in the room, by id: name, rank tier and badge shelf, from MSG.ROSTER.
 *
 * A SECOND PLAYER LIST, kept apart from `latestPlayers` because the two arrive on completely
 * different schedules — that one is replaced twenty times a second, this one on a join, a
 * drop or a promotion. The scoreboard reads both and the merge happens there.
 *
 * A Map and not an array because every read is by id and there is one read per row per frame
 * the board is open.
 */
let latestRoster = new Map();
let selfHp = C.MAX_HP;
let selfAlive = true;
let footAccum = 0;

// ── mode
/** The mode we are actually in. Provisional until WELCOME confirms it, so the HUD
 *  and the slot strip are populated from the request rather than left blank. */
let mode = modeOf(settings.mode);
/** Weapon indices this mode allows, in slot order. Number keys index into it. */
let loadout = mode.loadout.map(indexOf);
/** Latest `md` blob from the mode controller's `state()`, or null. */
let match = null;
let matchOver = false;
/** The page is a lobby until Join creates a seat. Escape pauses; only Leave releases it. */
let lifecycle = 'lobby';
/** Rank progress is frozen at entry and revealed in the after-action report. */
let careerAtJoin = null;
let currentCareer = 0;
let xpAtJoin = null;
let currentXp = 0;
let currentAccountStats = cleanStats();
let pendingMatchResult = null;
/** Economy receipts repeat in snapshots until the next round. Remember the last one we
 *  painted so a repeated authoritative receipt cannot visually pay twice. */
let lastEconomyReceiptId = null;
let finalMatchStats = { kills: 0, deaths: 0 };
const PROFILE_CACHE_KEY = 'fpsbone.profile.v1';

function cachedCareer() {
  try {
    const rec = JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY) ?? 'null');
    return rec?.id === identity.id && Number.isFinite(rec.career) ? Math.max(0, Math.floor(rec.career)) : 0;
  } catch {
    return 0;
  }
}

function cachedProfile() {
  try {
    const rec = JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY) ?? 'null');
    if (rec?.id !== identity.id) return { xp: 0, stats: cleanStats() };
    return { xp: Math.max(0, Math.floor(Number(rec.xp) || 0)), stats: cleanStats(rec.stats) };
  } catch {
    return { xp: 0, stats: cleanStats() };
  }
}

function cacheCareer(career, xp = currentXp, stats = currentAccountStats) {
  currentCareer = Math.max(0, Math.floor(Number(career) || 0));
  currentXp = Math.max(0, Math.floor(Number(xp) || 0));
  currentAccountStats = cleanStats(stats);
  try {
    localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify({
      id: identity.id,
      career: currentCareer,
      xp: currentXp,
      stats: currentAccountStats,
    }));
  } catch { /* storage optional */ }
}

const cached = cachedProfile();
cacheCareer(cachedCareer(), cached.xp, cached.stats);

// ── badges
/**
 * The authoritative per-track kill counts, as last sent in the private `self` blob, and
 * the cards the newest one earned.
 *
 * `badgeCounts` starts null to mark "no baseline yet". The first `self` we ever see sets it
 * WITHOUT producing cards, which is the whole reason the null exists: a returning player
 * arrives with a full set of counts, and diffing those against zero would fire twelve
 * promotion cards on their first snapshot for kills they scored last week.
 */
let badgeCounts = null;
/** Cards waiting for the EV.KILL that earned them, most specific track first. */
let badgeCards = [];

/** Card order: a headshot speaks for the kill before the weapon does, and the running
 *  total speaks last -- it is the one track that moves on every kill and so says least. */
const cardRank = (key) => (key === 'hs' ? 0 : key === 'kills' ? 2 : 1);

/**
 * The visible kill chains for every killer, so the killfeed and our own rays agree.
 *
 * CLIENT-SIDE, AND NOTHING ABOUT THAT IS A SHORTCUT. Every other counter in this game is
 * server-authoritative because it persists or because two players have to agree on it; a
 * chain does neither. It exists on one screen, and nobody else can see it -- so putting it
 * on the wire would buy a round trip's worth of latency on the one
 * HUD element whose whole job is to be instant, and a `spree` field in the snapshot that
 * every client ignores except its owner.
 *
 * The map is kept HERE and not in hud.js because extending or resetting a chain is a rule,
 * not a drawing. Every EV.KILL reaches every client in the same order, so the top-right feed
 * can label anyone's chain without adding redundant state to the server snapshot.
 */
const killChains = new Map();

/**
 * Which sprite goes in the middle of the mark: the head for a headshot, else the weapon.
 *
 * A HEADSHOT OUTRANKS THE WEAPON, the same order the badge card uses -- and for once the
 * reason is CrossFire's rather than ours: its killmark shows a skull for a head kill in
 * place of whatever gun did it, because the head is the thing worth reporting. Falls back
 * to the crossed rifles for a kill the server credited to no weapon, matching what
 * shared/badges.js does with the same case: file it under the total, not under a guess.
 */
function killGlyph(wIdx, zone) {
  if (zone === 1) return '#g-hs';
  const id = idAt(wIdx);
  return id && TRACK_KEYS.includes(id) ? `#g-${id}` : '#g-kills';
}

// ── death
/** performance.now() when we come back, or null in a mode with no mid-round
 *  respawn (arena). 0 while alive. */
let respawnAt = 0;
let killer = null;
let spectateId = 0;

/**
 * The death drop.
 *
 * `dropAt` is when it started, 0 while alive. Entirely client-side: the server freezes
 * the body the instant it dies (`predictor.pin`) and does not simulate a corpse, so
 * without this the camera stayed at standing eye height and the only sign anything had
 * happened was that the controls stopped answering — "when i die i dont know, it just
 * stops then spawn me somewhere theres no way to know". A camera that falls over is the
 * difference between watching yourself die and deducing it afterwards from the score.
 *
 * `dropFrom` is the eye height it starts from, captured at death rather than assumed,
 * so dying crouched drops from where you actually were. `dropRoll` picks a side, because
 * a body that always folds the same way is a tell you notice by the third death.
 */
let dropAt = 0;
let dropFrom = 0;
let dropRoll = 0;
const DROP_MS = 640;
/** Eye height of a body on the floor. Not zero: the camera is in a head, and a head
 *  lying on the ground still sits a little above it. */
const DROP_EYE = 0.34;
/** How far the view rolls and tilts down over the fall, in radians. */
const DROP_ROLL = 1.12;
const DROP_PITCH = 0.3;

// ── weapon
// The displayed weapon is the locally selected one, so a swap is instant. The
// server is still the authority: `wepSeq` records which input first carried the
// current request, and a correction is only believed once that input is acked —
// otherwise a snapshot already in flight would yank the weapon back the moment
// you pressed the key.
let wepReq = -1;
let wepSeq = 0;
/** Per-weapon ammunition, mirrored from `self.am` as the server confirms each
 *  weapon. Indexing by weapon means an unconfirmed swap shows that weapon's last
 *  known magazine instead of the one you just put away. */
const ammo = WEAPON_IDS.map((w) => WEAPONS[w].mag ?? 0);
let reloadMs = 0;
/** Ms left on a jam in the weapon we are holding, from `self.jm`. Not indexed by
 *  weapon like `ammo` is: the server already answers for whichever weapon is in hand,
 *  and the only thing the client does with it is animate the hands clearing it. */
let jamMs = 0;

const tmpMuzzle = new THREE.Vector3();
const nameOf = (id) => latestPlayers.find((p) => p.id === id)?.n ?? '?';
const sameLoadout = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Loudness for a point in the world: 1 at the ear, 0 at `falloff` metres away.
 *  Impacts attenuate against the impact itself rather than against the shooter — a
 *  round striking the wall beside you is loud whoever fired it. */
function near(pt, falloff) {
  const s = predictor.state;
  return Math.max(0, 1 - Math.hypot(pt.x - s.x, pt.y - eyeY(s), pt.z - s.z) / falloff);
}

/**
 * How far each kind of burst carries, in metres.
 *
 * The order matters more than the numbers. A flashbang is the loudest thing in the game
 * and has to be audible from anywhere, because hearing one land out of sight is the cue
 * to turn away and it is the only cue there is. A grenade is next. A smoke is quiet —
 * you should have to be near it to hear it pop, so a smoke thrown across the map does
 * not announce itself to the people it is meant to blind. Snow barely carries at all.
 */
const BURST_EARSHOT = {
  flash: 95,
  grenade: 70,
  smoke: 34,
  snowball: 26,
};

// ─────────────────────────────────────────────────────────── connection & UI
const menu = createMenu(settings, {
  identity,
  onWeapon: (id) => input.setWeapon(indexOf(id)),
  onFinish: async (id) => {
    if (accountApi) await accountApi.equip(id);
    setIdentityCosmetics(identity, { finish: id });
    viewmodel.setFinish(identity.cosmetics.finish);
    return id;
  },
  onCommunitySubmit: async (submission) => {
    if (!accountApi) throw new Error('account_unavailable');
    return accountApi.submit(submission);
  },
  onMarketPurchase: async (finish) => {
    if (!accountApi) throw new Error('account_unavailable');
    return accountApi.purchase(finish);
  },
  onSocialAction: async (action, extra) => {
    if (!accountApi || !socialToken) throw new Error('social_unavailable');
    const result = await accountApi.socialAction(socialToken, action, extra);
    return result;
  },
  onRecoveryExport: () => exportRecoveryCode(identity),
  onRecoveryImport: async (code) => {
    await importRecoveryCode(code, identity);
    location.reload();
  },
  onHand: (h) => viewmodel.setHand(h),
  onSens: (v) => input.setSens(v),
  onZoomSens: (v) => input.setZoomSens(v),
  onVmFov: (deg) => view.setVmFov(deg),
  onVolume: (v) => audio.setVolume(v),
  onBinds: (b) => input.setBinds(b),
  onCross: () => hud.crosshair(settings),
  // FOV needs no callback: the frame loop reads settings.fov through
  // viewmodel.fovFor every frame, so the slider is live even mid-match.
  onFov: null,
  onMode: selectLobbyMode,
  onPlay: joinOrResume,
  onLeave: leaveMatch,
  onResultLobby: returnToLobby,
  onResultReplay: replayMatch,
});
menu.setPlayerStats({ career: currentCareer, xp: currentXp, stats: currentAccountStats, kills: 0, deaths: 0 });
menu.setMatchState('lobby');

if (accountApi) {
  menu.setInventoryState({ state: 'loading' });
  accountApi.profile().then(({ profile, submissions, market }) => {
    const finish = profile.equipped?.finish ?? DEFAULT_FINISH;
    setIdentityCosmetics(identity, { finish });
    viewmodel.setFinish(identity.cosmetics.finish);
    menu.setInventoryState({
      state: 'ready', owned: profile.inventory, equipped: profile.equipped, submissions,
      credits: market?.credits ?? profile.credits,
      market: market?.items ?? [],
      transactions: market?.transactions ?? profile.transactions ?? [],
    });
    menu.setPlayerStats({
      career: profile.career, xp: profile.xp, stats: profile.stats, kills: 0, deaths: 0,
    });
  }).catch(() => menu.setInventoryState({ state: 'offline' }));

  const adoptSocial = async (state) => {
    menu.setSocialState(state);
    if (!state?.match || lifecycle !== 'lobby' || socialMatchJoining) return;
    socialMatchJoining = true;
    selectLobbyMode(state.match.mode);
    net.setMatchTicket(state.match.ticket);
    joinOrResume();
  };
  accountApi.openSocial(identity.displayName).then(({ token, state }) => {
    socialToken = token;
    adoptSocial(state);
    setInterval(() => {
      if (!socialToken) return;
      accountApi.socialState(socialToken)
        .then(({ state: next }) => adoptSocial(next))
        .catch(() => menu.setSocialState(null));
    }, 4000);
  }).catch(() => menu.setSocialState(null));
} else {
  menu.setInventoryState({
    state: identity.verified ? 'local' : 'guest',
    owned: sanitizeInventory(),
    equipped: identity.cosmetics,
    submissions: [],
  });
}

/**
 * Fill the server picker: ask this origin which regions exist, then time each one.
 *
 * DELIBERATELY AFTER THE SOCKET IS ALREADY OPENING. The connection dials the region stored in
 * settings and must never wait on a fetch — this is measurement for the NEXT choice, not a
 * step on the way into a match, so a slow or missing /regions costs nothing but a hidden
 * picker. Which is exactly the single-server case the menu already handles, so the `catch`
 * needs no message: there is nothing for a player to do about it and nothing to tell them.
 */
let activeGameRegion;
let lobbyRegionId = null;
loadRegions()
  .then((list) => {
    // Refresh a moved hostname for the NEXT connection without putting an HTTP lookup in
    // front of this one. A returning player still joins immediately; if the address ever
    // changes, the newly advertised origin repairs storage in the background.
    if (!explicitServer && settings.region !== HERE) {
      const selected = list.find((r) => r.id === settings.region && r.host);
      if (selected && selected.host !== settings.regionHost) settings.set({ regionHost: selected.host });
    }
    // Which card is the one we are ON, which is not simply `settings.region`. The default
    // `here` means "whoever served this page", and the table may already name that server as
    // a region — leaving five cards unmarked while connected to one of them is the picker
    // getting its own subject wrong. A `?server=` override outranks the setting entirely, and
    // then the honest answer is that none of these is the one.
    const requested = explicitServer
      ? null
      : settings.region === HERE
        ? (list.find((r) => r.mine)?.id ?? HERE)
        : settings.region;
    const active = activeGameRegion === undefined ? requested : activeGameRegion;
    lobbyRegionId = active;
    menu.setRegions(list, active);
    return probeAll(list, (results) => {
      menu.setPings(results);
      const current = results.find((r) => r.id === lobbyRegionId) ?? results.find((r) => r.mine);
      if (current?.lob) adoptLobbyPopulation(current);
    });
  })
  .catch(() => {});

/** Turn the lightweight /ping response into the richer shape the Phase 3 cards already read. */
function adoptLobbyPopulation(source) {
  if (!source?.lob || typeof source.lob !== 'object') return;
  // `/ping` names the live controllers explicitly. Older servers did not, but their lobby
  // object still only contained rooms they could host, so its keys are the safe fallback.
  const hosted = new Set(Array.isArray(source.avail) ? source.avail : Object.keys(source.lob));
  const rooms = {};
  let bots = 0;
  let bodies = 0;
  let activeRooms = 0;
  let dormantRooms = 0;
  for (const id of MODE_IDS) {
    if (!hosted.has(id)) continue;
    const capacity = MODES[id].slots;
    const humans = Math.max(0, Math.floor(Number(source.lob[id]) || 0));
    const roomBots = humans ? Math.max(0, capacity - humans) : 0;
    const state = humans >= capacity ? 'full' : humans ? 'active' : 'dormant';
    rooms[id] = {
      humans, connected: humans, reserved: 0, bots: roomBots,
      bodies: humans + roomBots, capacity, state,
    };
    bots += roomBots;
    bodies += humans + roomBots;
    if (humans) activeRooms++;
    else dormantRooms++;
  }
  menu.setLobby(source.lob);
  menu.setPopulation({
    humans: Math.max(0, Math.floor(Number(source.humans) || 0)),
    connected: Math.max(0, Math.floor(Number(source.humans) || 0)),
    reserved: 0,
    bots,
    bodies,
    capacity: Number.isFinite(source.cap) ? source.cap : C.REGION_HUMAN_CAP,
    activeRooms,
    dormantRooms,
    reservedRooms: 0,
    fullRooms: Object.values(rooms).filter((r) => r.state === 'full').length,
    rooms,
  });
  menu.setAvailable([...hosted]);
}

function httpOrigin(socketUrl) {
  try {
    const u = new URL(socketUrl, location.href);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    return u.origin;
  } catch {
    return null;
  }
}

const lobbyOrigin = useLocalHost
  ? null
  : explicitServer
    ? httpOrigin(explicitServer)
    : regionUrl
      ? httpOrigin(regionUrl)
      : bakedUrl
        ? httpOrigin(bakedUrl)
        : (httpOrigin(url) ?? location.origin);

async function pollLobby() {
  if (!lobbyOrigin || lifecycle === 'joined' || lifecycle === 'joining') return;
  try {
    const res = await fetch(`${lobbyOrigin}/ping`, { cache: 'no-store' });
    if (!res.ok) return;
    adoptLobbyPopulation(await res.json());
  } catch { /* the region card already owns unreachable wording */ }
}

pollLobby();
setInterval(pollLobby, 5000);

viewmodel.setHand(settings.hand);
input.setLoadout(loadout);
input.setWeapon(indexOf(settings.wep));
// The one-time push of everything the menu only sends on change. Without it a saved
// setting would sit in storage, visible on its own slider, and do nothing until the
// player happened to drag it.
input.setZoomSens(settings.zoomSens);
view.setVmFov(settings.vmFov);
audio.setVolume(settings.vol);
hud.crosshair(settings);

function selectLobbyMode(id) {
  requestedMode = id;
  net.setMode(id);
  applyMode(id);
}

function resetMatchClientState() {
  selfId = null;
  primed = false;
  latestPlayers = [];
  latestRoster = new Map();
  match = null;
  matchOver = false;
  careerAtJoin = null;
  xpAtJoin = null;
  pendingMatchResult = null;
  finalMatchStats = { kills: 0, deaths: 0 };
  badgeCounts = null;
  badgeCards = [];
  killChains.clear();
  spectateId = 0;
  hud.killmarkClear();
  hud.alive();
}

function joinOrResume() {
  audio.resume();
  if (lifecycle === 'joined') {
    input.lock();
    return;
  }
  if (lifecycle !== 'lobby') return;
  resetMatchClientState();
  lifecycle = 'joining';
  menu.setMatchState('joining');
  hud.setStatus(`joining ${MODES[requestedMode]?.label ?? requestedMode}…`);
  net.setMode(requestedMode);
  net.connect();
  // Pointer lock must be requested from this click; waiting for WELCOME loses the browser's
  // user gesture. The first authoritative snapshot still gates every simulation step.
  input.lock();
}

function leaveMatch() {
  if (lifecycle !== 'joined' && lifecycle !== 'joining') return;
  lifecycle = 'lobby';
  input.release();
  net.disconnect();
  resetMatchClientState();
  menu.setMatchState('lobby');
  menu.setPlayerStats({ career: currentCareer, xp: currentXp, stats: currentAccountStats, kills: 0, deaths: 0 });
  hud.showStart('left match · seat released');
  pollLobby();
  socialMatchJoining = false;
  if (socialToken) accountApi?.socialAction(socialToken, 'presence', { status: 'lobby' }).catch(() => {});
}

function returnToLobby() {
  menu.hideResults();
  lifecycle = 'lobby';
  menu.setMatchState('lobby');
  menu.setPlayerStats({ career: currentCareer, xp: currentXp, stats: currentAccountStats, kills: 0, deaths: 0 });
  hud.showStart('select a match to join');
  pollLobby();
  socialMatchJoining = false;
  if (socialToken) accountApi?.socialAction(socialToken, 'presence', { status: 'lobby' }).catch(() => {});
}

function replayMatch() {
  menu.hideResults();
  lifecycle = 'lobby';
  menu.setMatchState('lobby');
  joinOrResume();
}

// Clicking the backdrop starts play; clicking inside the panel must not, or
// nudging the sensitivity slider would grab pointer lock and hide the menu.
document.getElementById('start').addEventListener('click', () => {
  if (lifecycle === 'joined') joinOrResume();
});
document.getElementById('menu').addEventListener('click', (e) => e.stopPropagation());

input.onLockChange((locked) => {
  if (locked) hud.hideStart();
  else if (lifecycle === 'joined') hud.showStart('match paused · resume or leave');
  else if (lifecycle === 'results') hud.showStart();
  else if (lifecycle === 'joining') hud.showStart('joining match…');
  else hud.showStart('select a match to join');
});

net.on('status', (s) => {
  if (s === 'connected') hud.setStatus(`securing seat as ${identity.displayName}…`);
  else if (s === 'identity_error') hud.setStatus('DEVICE SIGNATURE FAILED — OPEN ACCOUNT SETTINGS');
  else if (s === 'idle') return;
  else if (s === 'disconnected' || s === 'reconnecting') hud.showStart(DOWN_MSG);
  else if (s === 'rejected') return;
  else hud.setStatus(UNREACHABLE_MSG);
});

// A full card normally cannot be clicked, but only the handshake can close the race for
// the final seat. Keep the player in the menu and say which limit stopped them instead of
// leaving a connected-looking page that will never receive a snapshot.
net.on('reject', (m) => {
  const label = MODES[m.mode]?.label ?? MODES[requestedMode]?.label ?? 'MODE';
  const text = m.reason === REJECT.SERVER_FULL
    ? 'SERVER FULL — PLEASE TRY AGAIN LATER'
    : m.reason === REJECT.MODE_FULL
      ? `${label} FULL — SELECT ANOTHER MODE`
      : m.reason === REJECT.RATE_LIMITED
        ? 'TOO MANY CONNECTION ATTEMPTS — WAIT A MOMENT'
        : m.reason === REJECT.IDENTITY_INVALID
          ? 'ACCOUNT PROOF INVALID — RECOVER OR RESET THIS DEVICE IDENTITY'
        : 'JOIN REFUSED — PLEASE TRY AGAIN';
  hud.setStatus(text);
  lifecycle = 'lobby';
  input.release();
  menu.setMatchState('lobby');
  hud.showStart(text);
  pollLobby();
  socialMatchJoining = false;
  if (socialToken) accountApi?.socialAction(socialToken, 'presence', { status: 'lobby' }).catch(() => {});
});

// How full every lobby is. Arrives twice over: once on WELCOME as `lob` so the menu is
// accurate on its first paint, and then as its own message whenever anyone joins or
// leaves any room. Same shape both times, so one handler serves both.
net.on('lobby', (rooms) => menu.setLobby(rooms));
net.on('population', (population) => menu.setPopulation(population));

net.on('welcome', (m) => {
  lifecycle = 'joined';
  menu.setMatchState('joined');
  selfId = m.id;
  // The server that accepted the game socket gets the final word. This is what prevents a
  // stale ASIA request from staying highlighted while the match is actually in AMERICA.
  activeGameRegion = typeof m.r === 'string' && m.r ? m.r : (useLocalHost ? HERE : null);
  menu.setActiveRegion(activeGameRegion);
  menu.setAvailable(m.avail ?? []);
  menu.setLobby(m.lob ?? {});
  menu.setPopulation(m.pop ?? {});
  menu.setAccount(m.account ?? {});
  socialMatchJoining = false;
  if (socialToken) accountApi?.socialAction(socialToken, 'presence', { status: 'playing' }).catch(() => {});
  if (m.inventory) {
    const finish = m.inventory.equipped?.finish ?? DEFAULT_FINISH;
    setIdentityCosmetics(identity, { finish });
    viewmodel.setFinish(identity.cosmetics.finish);
    menu.setInventoryState({
      state: 'ready', owned: m.inventory.owned, equipped: m.inventory.equipped,
      credits: m.inventory.credits,
    });
  }
  applyMode(m.mode ?? requestedMode);

  hud.setStatus(
    m.mode !== requestedMode
      ? `${MODES[requestedMode]?.label ?? requestedMode} is not running yet — joined ${mode.label}`
      : `connected as ${identity.displayName} · ${mode.label}`,
  );
});

/** Adopt the mode the server actually seated us in. Everything downstream of the
 *  mode — slot strip, number keys, respawn timing, corpse fade — reads from here. */
function applyMode(id) {
  mode = modeOf(id);
  // Clamp the SAVED spawn weapon into what this mode offers, before anything reads it.
  // `menu.setMode` does this as well, but only when the mode actually changes — and the
  // two can already agree while the weapon does not, because the menu sets `settings.mode`
  // the moment you click a chip and the server then seats you in that same mode. On that
  // path the correction was skipped, so `settings.wep` went on naming a weapon this mode
  // does not have: the menu highlighted it, and the next join asked for it again. The
  // weapon actually HELD was never wrong (`input.setLoadout` clamps below), but the stored
  // one is the one that persists, which is why it is fixed here rather than left to the UI.
  if (!mode.loadout.includes(settings.wep)) settings.set({ wep: mode.loadout[0] });
  menu.setMode(id);
  menu.refreshWeapons(); // no-op-ish, but it repaints the chips when setMode early-returned
  loadout = mode.loadout.map(indexOf);
  input.setLoadout(loadout);
  input.setWeapon(indexOf(settings.wep));
}

// Replaces wholesale rather than merging: the server sends the entire room every time, so
// somebody who left is gone by absence and there is no removal message that could be missed.
net.on('roster', (rows) => {
  latestRoster = new Map((rows ?? []).map((r) => [r.i, r]));
});

net.on('snapshot', (m) => {
  const now = performance.now();
  interp.push(m, now);
  latestPlayers = m.players;
  match = m.md ?? null;
  // Undefined when nothing is in the air, which clears any leftover meshes.
  view.syncProjectiles(m.proj);
  // Clouds come down in the snapshot rather than as an event, so a client that joins
  // or reconnects mid-cloud sees the smoke that is already on the ground. Same
  // contract as the projectiles: undefined means there are none, which retires
  // whatever we were drawing.
  view.syncClouds(m.sm, now);

  const mine = m.players.find((p) => p.id === selfId);
  if (mine) {
    const wasAlive = selfAlive;
    selfAlive = mine.a === 1;
    // The input needs to know, not just the renderer: the scope is a latch now, and a
    // latch that nothing tells about dying is a latch a corpse can still click. Fed
    // from the authoritative alive flag every snapshot rather than from the death
    // event, for the same reason the overlay is — a fall or your own grenade has
    // nobody to credit and still has to close the scope.
    input.setAlive(selfAlive);

    if (!primed) {
      predictor.teleport(mine);
      input.setView(mine.yaw, 0);
      primed = true;
    } else if (!selfAlive) {
      // Dead: the server has frozen the body. Hold there and stop predicting, but
      // leave the view angles alone so you can still look around.
      predictor.pin(mine);
    } else {
      predictor.reconcile(mine, m.ack, m.self);
    }

    // Driven off the authoritative alive flag rather than off the kill event, so a
    // death with nobody to credit still raises the overlay.
    if (wasAlive && !selfAlive) {
      respawnAt = mode.respawnMs == null ? null : now + mode.respawnMs;
      // Start the fall from wherever the eye actually was, and flash red. Both belong
      // on this edge rather than on EV.KILL: falling out of the world or being blown up
      // by your own grenade has nobody to credit, and it still has to look like dying.
      dropAt = now;
      dropFrom = eyeY(predictor.state);
      dropRoll = Math.random() < 0.5 ? -1 : 1;
      hud.died();
    } else if (!wasAlive && selfAlive) {
      respawnAt = 0;
      killer = null;
      spectateId = 0;
      dropAt = 0;
      hud.alive();
    }

    if (mine.hp !== selfHp) {
      selfHp = mine.hp;
      hud.health(selfHp);
    }

    // Spawn protection: the server sends the remaining ms in `sp` only while it is
    // honouring the shield, and omits it otherwise — so `?? 0` is "no shield" and the
    // HUD hides itself. Fed every snapshot rather than tracked with a local timer, so
    // the readout goes dark on the same tick a shot drops the shield early, not two
    // seconds later. The 20Hz snapshot granularity means the number steps in ~50ms
    // jumps rather than counting smoothly, which is honest: it is exactly when the
    // server re-checks.
    hud.shield(mine.sp ?? 0);
  }

  if (m.self) {
    // The mode may deal the loadout instead of letting it be picked, and deathmatch
    // re-deals on every respawn — so what we carry is the server's answer, not a
    // local guess. It arrives in the private `self` blob, which makes the slot keys
    // and the HUD strip follow a new hand the moment it is dealt.
    if (m.self.ld && !sameLoadout(m.self.ld, loadout)) {
      loadout = m.self.ld;
      input.setLoadout(loadout);
    }
    if (wepSeq && m.ack >= wepSeq && m.self.w !== wepReq) {
      // The request was refused — the mode does not grant that weapon.
      input.setWeapon(m.self.w);
      wepReq = m.self.w;
      wepSeq = m.ack;
    }
    ammo[m.self.w] = m.self.am;
    // A reload only belongs to the weapon the server has us holding; swapping
    // cancels it, so an unconfirmed swap correctly shows none.
    reloadMs = m.self.w === input.weapon ? m.self.rl : 0;
    // Same rule for the jam, and it matters more here: a jam is per-weapon on the
    // server, so a player who swaps out of a jammed rifle must stop seeing the hands
    // punch it the moment the pistol is up — not for the rest of the stoppage.
    jamMs = m.self.w === input.weapon ? (m.self.jm ?? 0) : 0;
    // The input needs the jam for the same reason it needs `alive`: the scope is a latch,
    // and a scoped weapon is drawn as nothing at all, so a stoppage nobody told the latch
    // about is 1.4 seconds of hands you cannot see punching a gun that is not there.
    input.setJammed(jamMs > 0);
    // The server keeps recording every earned elimination immediately, but Phase 4 freezes
    // its presentation at entry. Rank movement is revealed in the after-action report rather
    // than popping halfway through a firefight; the authoritative total is still cached on
    // every snapshot so a disconnect cannot lose what was earned.
    const authoritativeCareer = Math.max(0, Math.floor(Number(m.self.cv) || 0));
    if (careerAtJoin === null) careerAtJoin = authoritativeCareer;
    const authoritativeXp = Math.max(0, Math.floor(Number(m.self.xp) || 0));
    const authoritativeStats = cleanStats(m.self.ps);
    if (xpAtJoin === null) xpAtJoin = authoritativeXp;
    cacheCareer(authoritativeCareer, authoritativeXp, authoritativeStats);
    if (m.self.mr) {
      pendingMatchResult = m.self.mr;
      if (m.self.mr.id && m.self.mr.id !== lastEconomyReceiptId) {
        lastEconomyReceiptId = m.self.mr.id;
        const credits = Math.max(0, Math.floor(Number(m.self.mr.creditAward?.total) || 0));
        if (credits > 0) menu.setInventoryState({
          creditDelta: credits,
          transaction: {
            id: `match:${m.self.mr.id}`, kind: 'match', amount: credits,
            created_at: new Date().toISOString(),
          },
        });
      }
    }
    finalMatchStats = { kills: mine?.k ?? 0, deaths: mine?.d ?? 0 };
    hud.rank(xpAtJoin);
    menu.setPlayerStats({
      career: careerAtJoin,
      xp: xpAtJoin,
      stats: currentAccountStats,
      ...finalMatchStats,
    });
    // Badge counts, private for the same reason `cv` is, and omitted entirely while every
    // track is zero -- so `?? {}` is a player who has not scored yet, not a missing field.
    //
    // DIFFED rather than read. What the card has to show is which track THIS kill moved,
    // and the only honest source for that is the change between two authoritative counts.
    // Re-deriving it here from `ev.w` and `ev.z` would put the client's opinion of what a
    // kill is worth beside the server's, and the two would eventually disagree -- which is
    // the failure mode shared/badges.js exists to prevent.
    //
    // Done HERE and not in the KILL handler because this blob is folded before `m.ev` in
    // the same message: by the time the kill event arrives the post-kill counts are already
    // in, so the card can show a total that includes the kill that popped it with no extra
    // protocol machinery at all.
    if (badgeCounts === null) badgeCounts = { ...(m.self.bd ?? {}) };
    else foldBadges(m.self.bd ?? {});
  }

  for (const ev of m.ev ?? []) handleEvent(ev, now, m.players);
});

/** Turn a new set of counts into cards, and keep the new counts as the baseline. */
function foldBadges(bd) {
  const cards = [];
  for (const key of TRACK_KEYS) {
    const to = bd[key] ?? 0;
    const from = badgeCounts[key] ?? 0;
    // `<=` and not `!==`: setCareer's guard is monotonic per key, so a count can only ever
    // climb. A drop means a stale blob raced a reconnect, and there is no card in that.
    if (to <= from) continue;
    // Two flags off one diff, because the card treats them differently: a new emblem pops
    // and queues, a new level lights one pip. Derived from the step and not from the count
    // so the boundary rule lives in exactly one place -- shared/badges.js.
    const sTo = stepOf(to, key);
    const sFrom = stepOf(from, key);
    cards.push({
      key,
      count: to,
      badge: badgeOf(sTo),
      level: levelOf(sTo),
      promoted: badgeOf(sTo) > badgeOf(sFrom),
      levelUp: sTo > sFrom,
    });
  }
  badgeCounts = { ...bd };
  // Replaced, never appended. A second fold before the kill event lands would otherwise
  // stack two kills' worth of cards onto one kill; the newer counts are the true ones.
  if (cards.length) badgeCards = cards.sort((a, b) => cardRank(a.key) - cardRank(b.key));
}

/** Spend the cards on the kill that earned them. */
function showBadges(now) {
  const cards = badgeCards;
  badgeCards = [];
  if (!cards.length) return;
  const ups = cards.filter((c) => c.promoted);
  // Every promotion gets its own card -- hud.badge queues them, so two tracks crossing on
  // one kill read as two events rather than one. When nothing was promoted, a single card
  // speaks for the kill: showing all three would bury the interesting one under the total.
  if (ups.length) for (const c of ups) hud.badge(now, c);
  else hud.badge(now, cards[0]);
  // One sound for the kill, chosen by the best news in it. `some` and not `cards[0]`: the
  // card shown is the most specific track, but a level-up on ANY track is worth the note.
  audio.badge(ups.length > 0, cards.some((c) => c.levelUp));
}

function finishMatch(ev, players) {
  if (lifecycle !== 'joined') return;
  const mine = players.find((p) => p.id === selfId);
  let outcome = 'MATCH COMPLETE';
  let winnerLabel = null;
  if (mode.teams) {
    winnerLabel = ev.wt ? TEAM_NAMES[ev.wt] : null;
    outcome = !ev.wt ? 'DRAW' : mine?.tm === ev.wt ? 'VICTORY' : 'DEFEAT';
  } else {
    winnerLabel = ev.w ? nameOf(ev.w) : null;
    outcome = !ev.w ? 'DRAW' : ev.w === selfId ? 'VICTORY' : 'DEFEAT';
  }
  const receipt = pendingMatchResult;
  const matchStats = receipt?.match ?? finalMatchStats;
  const before = Math.max(0, Math.floor(Number(receipt?.before ?? xpAtJoin ?? currentXp) || 0));
  const after = Math.max(before, Math.floor(Number(receipt?.after ?? currentXp) || 0));
  const earned = Math.max(0, Math.floor(Number(receipt?.award?.total ?? after - before) || 0));
  lifecycle = 'results';
  menu.showResults({
    outcome,
    mode: winnerLabel ? `${mode.label} · ${winnerLabel} wins` : mode.label,
    kills: Math.max(0, Math.floor(Number(matchStats.kills) || 0)),
    deaths: Math.max(0, Math.floor(Number(matchStats.deaths) || 0)),
    xp: earned,
    xpBefore: before,
    xpAfter: after,
    award: receipt?.award ?? { total: earned },
    creditAward: receipt?.creditAward ?? { total: 0 },
    authoritative: Boolean(receipt),
  });
  // A finished match is not a pause. Release the human seat immediately; Play Again creates
  // a new admission against the latest capacity instead of riding into the server's reset.
  input.release();
  net.disconnect();
  primed = false;
  menu.setPlayerStats({
    career: currentCareer,
    xp: currentXp,
    stats: receipt?.stats ?? currentAccountStats,
    ...finalMatchStats,
  });
  hud.showStart();
  pollLobby();
}

function handleEvent(ev, now, players) {
  switch (ev.e) {
    case EV.SHOT: {
      const wid = idAt(ev.w);
      const melee = WEAPONS[wid]?.kind === 'melee';
      /** Snowball, grenade, flashbang, smoke: it leaves your hand and the server puts it
       *  in the snapshot as a projectile. Nothing about one is a gunshot, and it used to
       *  get treated as one on both counts below — the report and the tracer — because the
       *  only question asked here was whether it was a knife. */
      const thrownWep = WEAPONS[wid]?.kind === 'projectile';
      /** Only a hitscan weapon actually fires a round. `server/room.js` says as much where
       *  it sends the SHOT for a throw ("the client skips the tracer for non-hitscan
       *  weapons") — this is the client keeping that promise, which it never did. */
      const fired = !melee && !thrownWep;
      const heavy = ev.a === 1;
      const to = { x: ev.x, y: ev.y, z: ev.z };
      let from;

      if (ev.id === selfId) {
        // The heavy flag comes back from the server rather than off the local mouse.
        // The button can change between sending an input and the shot resolving, and
        // the animation has to show the swing that was actually paid for.
        viewmodel.fire(heavy, now);
        // And the aim kicks. Driven from the server's SHOT for the same reason: only a
        // round that was actually fired may move where you are pointing. Weapons with
        // no recoil declared ignore this, so the knife and the throwables need no
        // special case here.
        input.punch(ev.w);
        from = viewmodel.muzzle(tmpMuzzle);
        if (melee) audio.swing(heavy);
        else if (thrownWep) audio.toss();
        else audio.shot(1, wid);
      } else {
        const src = players.find((p) => p.id === ev.id);
        if (!src) break;
        from = { x: src.x, y: eyeY(src), z: src.z };
        // The body that fired reacts: the weapon kicks back in its hands and, on a weapon
        // with an action to work, the off hand cycles it. Off the event rather than the
        // snapshot because a snapshot is a 50 ms window — a three-round burst inside one
        // would land as a single nudge, and a bolt stroke would start a snapshot late.
        view.avatarShot(ev.id, ev.w, now);
        // A swing carries nowhere near as far as a shot, and a throw barely carries at
        // all — it is a sleeve moving, so you have to be almost next to it to hear one.
        if (melee) audio.swing(heavy, near(from, 14));
        else if (thrownWep) audio.toss(near(from, 12));
        else audio.shot(near(from, 55), wid);
      }

      /**
       * Draw one trace: the streak through the air and whatever it ended on.
       *
       * `h` is what the shot ended on: 0 nothing, 1 world geometry, 2 a player.
       * Without this nothing in the world ever reacted to being hit — you could empty
       * a magazine into cover, or slash it, and it "just pass through everything". A
       * body hit already has a hitmarker behind it, so it gets a smaller, softer mark.
       *
       * A knife leaves no tracer, and neither does anything thrown. Drawing one would read
       * as a gunshot — which for the snowball is exactly what it read as: a lit round
       * leaving your hand, on top of a rifle report, held in a rifle.
       *
       * `smokeWake` is the same path a second time, clipped to whatever smoke it crossed
       * and drawn over the cloud instead of under it — "you can shoot on the smoke and you
       * can see details a bit on the bullet way". It is a no-op when there is no cloud, so
       * it costs a sphere test per live smoke on every trace and nothing else.
       */
      const trace = (pt, h) => {
        if (fired) {
          viewmodel.tracer(from, pt, now);
          view.smokeWake(from, pt, now);
        }
        if (h) view.impact(h === 2 ? 'body' : melee ? 'slash' : 'bullet', pt, from, now);
      };

      trace(to, ev.h);
      // A shotgun sends its other seven pellets along on the same event, each
      // `[x, y, z]` with its own `h` appended when it hit something. They have to be
      // drawn: eight holes spreading across the wall is the only thing that shows the
      // player what the weapon actually does, and it is also the honest picture, since
      // the server really did trace eight independent rays.
      for (const q of ev.p ?? []) trace({ x: q[0], y: q[1], z: q[2] }, q[3] ?? 0);

      // One sound for the blast, not one per pellet — eight thuds on the same tick
      // stack into a crunch loud enough to drown the report that caused them. It plays
      // if anything in the volley found geometry, wherever the first trace landed.
      if (ev.h === 1 || (ev.p?.some((q) => q[3] === 1))) audio.thud(melee, near(to, 34));
      break;
    }

    case EV.HIT:
      if (ev.by === selfId) {
        // `ev.z` is the hit zone, omitted by the server for a body shot. Passing it
        // through is the only feedback that makes aiming for a head a decision rather
        // than a rumour — a x4 multiplier the shooter cannot see is a multiplier that
        // may as well not exist.
        hud.hitmarker(now, ev.z ?? 0);
        // The ear gets it too. The marker is 110ms of a small shape in the middle of a
        // firefight, and it is often not where the player is looking; the accent on the
        // click is what makes a headshot register while it is still useful.
        audio.hit(ev.z === 1);
      }
      if (ev.on === selfId) {
        hud.damaged(now);
        audio.hurt();
      }
      break;

    case EV.KILL:
      // Count first so the killfeed and our own crest consume one answer. A headshot and a
      // weapon swap are intentionally absent: only the killer, victim and deadline decide
      // the chain. A suicide or world death earns no chain.
      let chain = 0;
      if (ev.by && ev.by !== ev.on) {
        const prev = killChains.get(ev.by);
        chain = prev && now < prev.until ? prev.n + 1 : 1;
        killChains.set(ev.by, { n: chain, until: now + SPREE_MS });
      }
      hud.feed(
        nameOf(ev.by), nameOf(ev.on), ev.by === selfId, ev.on === selfId,
        ev.w, ev.z ?? 0, chain,
      );
      // The victim's own chain is over. Usually the respawn delay already outlasts the
      // window, but clearing it here keeps the rule true in modes with instant respawns.
      if (ev.on) killChains.delete(ev.on);
      if (ev.by === selfId) {
        audio.kill();
        // "so each kill it shows your badge". The cards were built from the counts folded
        // out of this same message a few lines above, which is why this needs no argument:
        // the server has already decided what the kill was worth.
        showBadges(now);
        // THE CHAIN, DECIDED ABOVE AND NOWHERE ELSE. A weapon change, body kill or headshot
        // changes only the medallion passed below; none can restart the rays.
        //
        // `ev.on !== selfId` IS THE GRENADE EXEMPTION, and it has to be here because this
        // is the one counter in the game the server does not keep. room.js broadcasts the
        // KILL for your own grenade with `by` set to you and then withholds the career
        // credit for it, so the badge card gets no cards and says nothing -- but a chain
        // counted in the browser has no such protection unless it restates the rule. A
        // world death arrives as `by: 0`, which is nobody's id and so already excluded.
        if (ev.on !== selfId) {
          // Wings come off the ELIMINATIONS badge: the one track every kill moves, so the
          // mark is never wearing a tier that some other weapon earned. `?? 0` because the
          // counts are null until the first `self` blob lands, and a first kill on a fresh
          // account arrives before it.
          hud.killmark(now, {
            n: chain,
            glyph: killGlyph(ev.w, ev.z ?? 0),
            wings: wingsOf(tierOf(badgeCounts?.kills ?? 0, 'kills')),
          });
          audio.spree(chain);
        }
      }
      if (ev.on === selfId) {
        audio.died();
        // Dying ends the chain on the instant; a respawn never inherits the old rays.
        killChains.delete(selfId);
        hud.killmarkClear();
        // The playtest note asked for this instead of a spectator camera in the
        // respawn modes: the fight is over in 5 seconds, so show what killed you.
        killer = ev.by && ev.by !== selfId ? { name: nameOf(ev.by), wep: ev.w } : null;
      }
      break;

    case EV.SPAWN:
      if (ev.id === selfId && primed) {
        spectateId = 0;
        predictor.teleport({ x: ev.x, y: ev.y, z: ev.z, yaw: ev.yaw ?? 0, pitch: 0 });
        input.setView(ev.yaw ?? 0, 0);
      }
      break;

    case EV.MATCH:
      matchOver = ev.ph === 'over';
      if (matchOver) finishMatch(ev, players);
      break;

    case EV.BURST:
      // `n` is the surface it broke against, absent when it cooked off in mid-air.
      // The sound carries further than a footstep and nowhere near as far as a rifle:
      // a grenade you cannot hear go off behind you is a grenade you never learn from.
      view.burst(ev.k, ev.x, ev.y, ev.z, now, ev.n);
      audio.explode(ev.k, near({ x: ev.x, y: ev.y, z: ev.z }, BURST_EARSHOT[ev.k] ?? 70));
      break;

    case EV.JAM: {
      // The animation is NOT started here — it runs off `self.jm` in the snapshot, so it
      // cannot get out of step with the gate that is actually stopping the shots. What
      // the event is for is the sound, which has to fire on the instant and has no
      // snapshot-rate quantum to lose.
      if (ev.id === selfId) {
        audio.jam(ev.ms);
        break;
      }
      // Somebody else's gun stopped. Audible, and deliberately: a rifle that goes quiet
      // mid-spray while its owner beats on the receiver is the entire opening the
      // mechanic creates, and it is worth nothing to the person it is an opening for if
      // they cannot hear it. Quieter than a shot and it carries less far — 26u, about
      // half the reach of a rifle report — because it is a hand hitting metal.
      const src = players.find((p) => p.id === ev.id);
      if (src) audio.jam(ev.ms, near({ x: src.x, y: eyeY(src), z: src.z }, 26));
      break;
    }

    case EV.BLIND:
      // Server-authoritative: it already worked out that we were looking at it, through
      // clear air, close enough to matter, and for how long. The client's only job is
      // to put the white up — deciding locally whether you were flashed would mean the
      // shooter and the target could disagree about whether the flash worked.
      //
      // Eyes and ears off the one duration. "if you got directly flashbang the sound
      // should be long enough maybe few seconds you cant hear good enough footsteps or
      // bullet sounds" — so the same falloff that decides how white the screen goes
      // decides how deaf you are, and a flash you turned away from costs you neither.
      if (ev.on === selfId) {
        hud.blind(ev.ms);
        audio.deafen(ev.ms);
      }
      break;
  }
}

// ─────────────────────────────────────────────────────────────── frame loop
const STEP_MS = C.TICK_DT * 1000;
const SEND_MS = 1000 / C.SNAPSHOT_HZ;
const MAX_CATCHUP = 10;

let acc = 0;
/**
 * The previous frame's timestamp, or -1 before the first frame has run.
 *
 * NOT `performance.now()` at module load, which is what it was and which made the FIRST
 * frame delta NEGATIVE. rAF hands a callback the timestamp of the frame it is running
 * inside, and that frame had already begun while this module was still being evaluated —
 * building twelve viewmodel rigs, an avatar rig and the scene takes longer than the gap
 * between a vsync and the script that runs after it. Measured at -116ms on the first
 * frame here, every time, and worse the slower the machine.
 *
 * One backwards frame is not a small error. It runs every animation in the game in
 * reverse for a frame, and one of them never comes back: the viewmodel's swap timer uses
 * a negative `swapT` to mean "no swap in progress", so a single negative delta during the
 * opening swap parked it below zero, where nothing advances it and `request` will not
 * restart it — because as far as it can tell the weapon you asked for is already on its
 * way. The swap never finished. That is why snow mode handed you a RIFLE and left it
 * there for the whole match while the HUD, the server and the throw itself all agreed you
 * were holding a snowball: a gun that throws snowballs.
 */
let last = -1;
let lastSend = 0;
let unsent = false;

function frame(now) {
  requestAnimationFrame(frame);
  if (last < 0) last = now;
  // A frame is a duration. Clamped at both ends: 200ms above so a tabbed-away page does
  // not arrive with a second of animation to play out, and zero below because time does
  // not run backwards no matter what the clock says.
  const dtMs = Math.min(Math.max(now - last, 0), 200);
  last = now;

  if (primed && selfAlive) {
    acc += dtMs;
    let steps = 0;
    while (acc >= STEP_MS && steps < MAX_CATCHUP) {
      // `net.viewMs()` rides on every input, not just the ones that fire: the server
      // reads it off whichever input happened to carry BTN_FIRE, and it costs one
      // integer.
      const rec = predictor.push(input.sample(net.viewMs()));
      // Remember which input first asked for this weapon, so a stale snapshot
      // cannot undo the switch.
      if (rec.wep !== wepReq) {
        wepReq = rec.wep;
        wepSeq = rec.seq;
      }
      acc -= STEP_MS;
      steps++;
      unsent = true;
    }
    // Tabbed away and came back: drop the backlog rather than fast-forwarding.
    if (steps === MAX_CATCHUP) acc = 0;

    // Inputs go out batched at the snapshot rate, with a few extra trailing ticks
    // so a dropped packet doesn't cost movement.
    if (unsent && now - lastSend >= SEND_MS) {
      net.sendInputs(predictor.recent(INPUT_REDUNDANCY + C.TICKS_PER_SNAPSHOT));
      lastSend = now;
      unsent = false;
    }

    predictor.decayError(dtMs);
  } else {
    // Don't bank up ticks while dead or before the first snapshot — otherwise
    // respawning would fast-forward through a couple of seconds of input. Looking around
    // while dead does not need one: the camera reads the mouse directly now, so it works
    // without a corpse being simulated — which is what `predictor.pin` wants, since it
    // clears `pending` on every snapshot and a replayed input would fight it.
    acc = 0;
  }

  const s = predictor.state;
  const e = predictor.error;
  let eye = eyeY(s) + e.y;
  // ---- where the camera looks -------------------------------------------------------
  // Straight off the mouse, every frame, NOT off `predictor.state`.
  //
  // This is the "massive delay" when you move the mouse. Position is predicted, which is
  // why it comes from the simulation: your own movement is a simulation the server also
  // runs, and it has to be replayed against authority when a snapshot lands. Aim is not.
  // Nothing in the client simulates where you are looking — `stepPlayer` copies the angle
  // out of the input unchanged — so reading it back out of the prediction bought exactly
  // nothing and cost a tick.
  //
  // What it cost: the sim only advances inside the fixed-timestep loop above, so a frame
  // that ran no step drew last frame's aim again, one that ran two jumped by two ticks,
  // and above 60Hz most frames ran no step at all — a 144Hz monitor was shown 60 distinct
  // view angles a second. Add the ~8ms average wait for the next tick boundary and mouse
  // motion took up to a frame and a half to reach the screen, in judder rather than in
  // one honest lag. That is not a thing you can call an FPS.
  //
  // The server is unaffected. It still receives the tick-sampled angles from `sample()`,
  // still resolves every shot against them, and still owns the outcome. What changed is
  // that the picture no longer waits for the tick to tell it something the mouse already
  // said.
  let pitch = input.lookPitch;
  let yaw = input.lookYaw;
  let roll = 0;
  if (dropAt) {
    // Ease-out: the fall is fastest at the start, which is what a body dropping does
    // and also what makes the moment of death read as an impact rather than a descent.
    // The roll goes through camera.rotation.z, which under three.js's default XYZ Euler
    // order is applied innermost — so it is a roll about the view axis rather than a
    // twist of the whole world, which is the difference between falling over and the
    // map tipping up.
    const t = Math.min(1, (now - dropAt) / DROP_MS);
    const k = 1 - (1 - t) ** 3;
    eye = dropFrom + (DROP_EYE - dropFrom) * k;
    pitch = Math.max(-C.PITCH_LIMIT, pitch - DROP_PITCH * k);
    roll = dropRoll * DROP_ROLL * k;
  }
  const states = interp.sample(now);
  let hiddenId = selfId;
  let spectating = '';
  // Arena has no mid-round respawn. After the short death fall, follow a living team-mate
  // and hide that avatar from its own eye position. Aim remains under the viewer's mouse,
  // which makes this a useful team camera without giving the corpse any input authority.
  if (!selfAlive && mode.spectate === 'team' && states && now - dropAt >= DROP_MS) {
    const mine = latestPlayers.find((p) => p.id === selfId);
    const valid = (p) => p && p.a === 1 && p.tm === mine?.tm && p.id !== selfId;
    let target = latestPlayers.find((p) => p.id === spectateId && valid(p));
    if (!target) target = latestPlayers.find(valid);
    if (target) {
      spectateId = target.id;
      const watched = states.get(target.id) ?? target;
      hiddenId = target.id;
      spectating = target.n;
      eye = eyeY(watched);
      view.camera.position.set(watched.x, eye, watched.z);
      view.camera.rotation.set(pitch, yaw, 0);
    } else {
      spectateId = 0;
    }
  }
  if (!spectating) {
    view.camera.position.set(s.x + e.x, eye, s.z + e.z);
    view.camera.rotation.set(pitch, yaw, roll);
  }
  if (states && selfId !== null) {
    view.syncAvatars(states, hiddenId, now, CORPSE_MS(mode), latestRoster);
  }
  view.tickEffects(now);

  const speed = Math.hypot(s.vx, s.vz);
  if (s.grounded && speed > 1.5) {
    footAccum += speed * (dtMs / 1000);
    if (footAccum > 2.4) {
      footAccum = 0;
      // Volume, not only cadence. The accumulator above already makes a walk RARER —
      // fewer steps per second — but every step was the same loudness, so "walk quietly"
      // was a claim the audio never backed. Gain scales with actual speed against the run
      // cap the movement rules are built around: a walk lands near 0.47, a run near 0.90,
      // a sprint near 1.02. Ceiling at SPRINT_SPEED_MUL so a launch or a boost cannot make
      // it shout. Floor at 0.35 for the sliver between the 1.5 gate and a settled walk;
      // crouch-walking tops out at 1.365 u/s and so never reaches this branch at all,
      // which is why a duck is silent rather than merely quiet.
      //
      // Local only, and worth being plain about: there are no remote footsteps in this
      // build, so this is feedback for the player making the noise and not yet counterplay
      // for anyone else. Sprint's real cost today is stamina.
      audio.step(Math.max(0.35, Math.min(C.SPRINT_SPEED_MUL, speed / C.MOVE_SPEED)));
    }
  } else {
    footAccum = 0;
  }

  // Stamina is driven from the predictor rather than the snapshot, because it changes every
  // tick and a 20Hz readout of a 60Hz value visibly steps. `sprintLock` is the server's
  // refusal carried in the private self blob, so the bar explains a rule the client did not
  // invent — see hud.stamina for why that explanation has to exist at all.
  hud.stamina(s.stamina / C.SPRINT_STAMINA_MAX, input.sprintArmed, s.sprintLock);

  const wep = input.weapon;
  viewmodel.setWeapon(wep);
  // Put the gun away while the body is on the floor. The viewmodel renders through its
  // own camera at the origin, so it never inherits the roll the death drop applies to
  // the world camera — leave it visible and the weapon hangs perfectly level in front of
  // a horizon that has tipped over, which reads as the map falling rather than as you.
  viewmodel.setHidden(!selfAlive);
  // Held, not consumed. Inspect is a state for as long as F is down and loops until
  // it is released — an animation that quits under a held key is the bug.
  viewmodel.setInspect(input.inspectHeld);
  // `s.sprinting` rather than a second local predicate: the shared step already decided
  // it this tick, for both the server and the predictor, and the gun showing something the
  // simulation did not agree to is the whole class of bug this avoids.
  viewmodel.update(dtMs, now, speed, input.alt, reloadMs, s.crouch, input.scopeStep, jamMs,
    s.sprinting);
  // Zoom follows the scope blend, so it must be applied every frame, not on the
  // mouse event — and the base value is the player's own FOV setting.
  const fovNow = viewmodel.fovFor(settings.fov);
  view.setFov(fovNow);
  // The cone the next round can land in, and the field of view it is being drawn across.
  // `spreadMul` with the weapon id is the whole scope model — the 40x hip penalty and the
  // settle after the glass comes up — read off the same predicted state the shot will be
  // fired from, so the ring is reporting the spread rather than illustrating it. Exactly
  // the argument `hud.bloom` below makes about the crosshair, applied to the one weapon
  // whose crosshair is deliberately absent.
  hud.scope(viewmodel.scopeAmount, viewmodel.hasScope,
    (weaponAt(wep).spread ?? 0) * spreadMul(s, idAt(wep)), fovNow);
  // The crosshair opens with the recoil, which is the only honest thing it can do:
  // the punch is added to the aim we send, so the arms are showing the spread of where
  // the next round can actually go.
  //
  // Plus what the body is doing to it. `spreadMul` is the same function the server
  // multiplies the cone by, reading the same predicted state the shot will be fired
  // from, so the arms are reporting the movement penalty rather than illustrating it.
  // Only the DIFFERENCE from a standstill is added: a still, standing player is
  // exactly 1x, so the resting crosshair is the size it always was, and crouching
  // draws it visibly tighter because 0.6x is genuinely tighter.
  hud.bloom(input.punchAmount + (weaponAt(wep).spread ?? 0) * (spreadMul(s) - 1));

  hud.tick(now);
  hud.net(now, net.rtt, net.snapRate, predictor.pendingCount);
  hud.weapon(wep, ammo[wep], reloadMs, loadout, jamMs);
  // Who won, as a name. A team mode sends the winning SIDE as `wt` and holds `w` at
  // zero, because `w` is a player id in every other mode and `nameOf(2)` would answer
  // with whoever happened to join second. `wt` is checked first for that reason.
  hud.mode(
    match,
    mode.label,
    match?.wt ? (TEAM_NAMES[match.wt] ?? null) : match?.w ? nameOf(match.w) : null,
  );
  hud.scoreboard(
    now,
    input.scoreboard || matchOver,
    latestPlayers,
    latestRoster,
    selfId,
    matchOver ? `${mode.label} · final` : mode.label.toLowerCase(),
    // The authoritative team score, or null in a mode that has no sides. Straight off the
    // match state rather than counted from the roster: a side's score is the mode's own
    // number and `tdm.js` is the only thing allowed to have an opinion about it.
    match?.ts ?? null,
  );
  if (!selfAlive) hud.dead(respawnAt == null ? null : (respawnAt - now) / 1000, killer, spectating);

  view.render();
}

hud.health(C.MAX_HP);
if (lag) console.info(`[fpsbone] simulating ${lag}ms RTT, ${jitter}ms jitter`);
hud.showStart('select a match to join');
requestAnimationFrame(frame);
