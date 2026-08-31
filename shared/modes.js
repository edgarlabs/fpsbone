// Mode descriptors — the data both sides need about a match.
//
// Three server controllers (server/modes/{ffa,tdm,arena}.js) cover five modes,
// because dm, sniper and snow differ only in the data held here. Adding a
// variant of an existing controller is an entry in this table and nothing else.
//
// `ctl` names the controller. `loadout` is the whitelist the server enforces —
// a client asking for a weapon outside it gets the first entry instead, which is
// why the intended default weapon is listed first.

/**
 * Everything a full-loadout mode offers.
 *
 * The first entry is load-bearing: a client asking for a weapon the mode does not offer
 * gets this one instead, so the rifle stays at the front.
 *
 * The complete approved arsenal is here rather than a curated five. In a mode that lets
 * you pick, slot 1 cycles the primaries and slot 4 cycles the four throwables — which
 * is the point of having them. In deathmatch, where `randomLoadout` turns this list into
 * a pool, it means a life is one primary, the pistol, the knife and one thing to throw,
 * dealt fresh: see `rollLoadout`, which deals per SLOT precisely so a random hand is
 * always a playable one instead of three pistols and no rifle.
 */
const FULL = [
  'rifle',
  'rifle_havoc',
  'rifle_falcon',
  'smg',
  'smg_kite',
  'smg_banshee',
  'lmg',
  'lmg_atlas',
  'lmg_colossus',
  'semi',
  'sniper',
  'shotgun',
  'pistol',
  'pistol_wisp',
  'pistol_rook',
  'knife',
  'knife_karambit',
  'knife_tanto',
  'knife_bowie',
  'knife_kukri',
  'grenade',
  'flash',
  'smoke',
];

export const MODES = {
  dm: {
    label: 'DEATHMATCH',
    blurb: 'random loadout, everyone for themselves',
    ctl: 'ffa',
    teams: false,
    slots: 10,
    loadout: FULL,
    // The playtest asked for deathmatch guns to be dealt rather than chosen. With
    // this set the mode's `loadout` stops being what you carry and becomes the pool
    // one weapon per slot is drawn from — re-drawn on every respawn, so a life is a
    // hand you are dealt and have to play.
    randomLoadout: true,
    // 5 s, per the playtest note: long enough to read who killed you, short
    // enough that spectating would be busywork.
    respawnMs: 5000,
    killLimit: 25,
    timeMs: 600000,
    spectate: 'none',
  },
  sniper: {
    label: 'SNIPER MATCH',
    blurb: 'knife and sniper only',
    ctl: 'ffa',
    teams: false,
    slots: 10,
    loadout: ['sniper', 'knife', 'knife_karambit', 'knife_tanto', 'knife_bowie', 'knife_kukri'],
    respawnMs: 5000,
    killLimit: 15,
    timeMs: 480000,
    spectate: 'none',
  },
  snow: {
    label: 'SNOWBALL',
    blurb: 'no guns, just snow',
    ctl: 'ffa',
    teams: false,
    slots: 10,
    loadout: ['snowball'],
    respawnMs: 3000,
    killLimit: 20,
    timeMs: 420000,
    spectate: 'none',
  },
  tdm: {
    label: 'TEAM DM',
    blurb: '5v5, spawn in your base',
    ctl: 'tdm',
    teams: true,
    slots: 10,
    loadout: FULL,
    teamSize: 5,
    respawnMs: 5000,
    killLimit: 50,
    timeMs: 600000,
    spectate: 'none',
  },
  arena: {
    label: 'ARENA',
    blurb: 'plant or defuse — one life a round',
    ctl: 'arena',
    teams: true,
    slots: 10,
    loadout: FULL,
    teamSize: 5,
    // null means no respawn until the round ends. Every consumer of respawnMs has
    // to handle that, including the client's corpse fade.
    respawnMs: null,
    roundMs: 115000,
    fuseMs: 40000,
    plantMs: 3200,
    defuseMs: 5000,
    winRounds: 7,
    spectate: 'team',
  },
};

/**
 * LOBBY CAPACITY — the one number the backfill is built on.
 *
 * A room seats `slots` bodies. Whatever is not a human is a bot, so the AI population
 * is `slots - humans` and nobody chooses it: one player in a deathmatch gets nine
 * opponents, a second player takes one of their places, and the tenth turns the room
 * into pure PvP without anything having to be reconfigured. An EMPTY room is the one
 * special case and it is zero, not ten — a lobby nobody is in must not sit there
 * simulating nine bots for an audience of none. See `syncBots` in server/index.js.
 *
 * It is data here rather than a constant in server/ code because the CLIENT needs it
 * too: the mode picker greys out a lobby that is full, and it can only do that if it
 * knows what full means for each one.
 *
 * For a team mode it must equal `teamSize * 2` — five a side is ten bodies — and
 * verify.mjs asserts exactly that, so the two numbers cannot drift apart in an edit.
 *
 * It is both the BACKFILL TARGET and the authoritative human gate. The menu greys a full
 * lobby out for the ordinary path, and the server refuses a raced or hand-written eleventh
 * handshake. One player plus nine bots and ten players plus zero bots are both ten stable
 * bodies; an arriving human replaces its bot before the simulation advances or broadcasts.
 */
export const MODE_IDS = Object.keys(MODES);
export const DEFAULT_MODE = 'dm';

/**
 * What the two sides of a team mode are called.
 *
 * Keyed by the `tm` that travels in every snapshot, where 0 means no team at all — so
 * an FFA player indexes to undefined here, which is correct and is what the callers
 * test for. The client already paints these two: the scoreboard wears `tA`/`tB` and
 * the avatars are tinted by `setAvatarTeam`. This is only the wording, kept beside the
 * table that decides a mode has teams in the first place.
 */
export const TEAM_NAMES = { 1: 'ALPHA', 2: 'BRAVO' };

export const isMode = (id) => Object.hasOwn(MODES, id);
export const modeOf = (id) => MODES[id] ?? MODES[DEFAULT_MODE];

/** How long a corpse should lie there. Arena has no respawn timer, so a body has
 *  to be given a lifetime of its own or it would sit until the round ended. */
export const CORPSE_MS = (mode) => mode.respawnMs ?? 6000;
