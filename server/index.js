// The game host: rooms, the handshake, the snapshot fan-out and the fixed-timestep loop.
//
// PLATFORM-AGNOSTIC ON PURPOSE, and that is the whole design of this file. Nothing here
// imports `ws`, touches the filesystem or reads `process` — the three things that tie a
// host to Node. They arrive instead as the two injections `createHost` takes:
//
//   nowNs   a monotonic clock in nanoseconds, as a BigInt
//   ranks   the career store: { careerOf, badgesOf, setCareer }
//
// and a transport supplies sockets by calling `connect()`. There are two callers:
//
//   server/serve.js            Node — `ws` sockets, hrtime, the ranks.json store
//   client/src/localserver.js  the browser — in-page sockets, performance.now(), localStorage
//
// The second one is why the seam exists. Vercel and every other static host can serve the
// built client but cannot run a long-lived WebSocket process, so the browser build runs
// this same host inside the page. Duplicating the handshake and the snapshot builder to
// get that would have meant two implementations of the wire drifting apart; injecting a
// clock and a store means there is one, and `npm run verify` tests the one that ships.
//
// Fixed-timestep accumulator driven by `nowNs` — plain setInterval drifts, and that drift
// shows up as inconsistent movement speed. The arithmetic is BigInt nanoseconds on both
// platforms, so neither gets a different rounding story than the other.
//
// Every mode with a working controller gets its own Room, and all of them tick in the one
// loop below. Switching mode is a client reload, not a host restart.

import * as C from '../shared/constants.js';
import { MSG, encode, decode } from '../shared/protocol.js';
import { MODES, MODE_IDS, DEFAULT_MODE } from '../shared/modes.js';
import { hasController } from './modes/index.js';
import { Room } from './room.js';

const sanitizeName = (n) =>
  ((typeof n === 'string' ? n : '').replace(/[^\w \-]/g, '').trim().slice(0, 16) || 'player');

/**
 * The account a career is filed under, sanitized the way a name is and for a stricter
 * reason: this one becomes a KEY IN PERSISTENT STORAGE.
 *
 * A name is display data that a client can make ugly. An id is a path into persistent
 * storage, so the charset is a whitelist and not a blacklist — word characters, dash and
 * colon, which covers today's `local-xxxxxxxx` and tomorrow's `eip155:1:0x...` when
 * identity.js starts returning a wallet address. Anything outside it is dropped rather
 * than rejected, and an id that sanitizes down to nothing means anonymous.
 *
 * Null, not 'anonymous', for the empty case: a shared fallback key would file every
 * id-less client's kills into one growing career that they would all then be shown.
 */
const sanitizeAccount = (v) =>
  ((typeof v === 'string' ? v : '').replace(/[^\w:-]/g, '').slice(0, 64) || null);

const r3 = (v) => Math.round(v * 1000) / 1000;

const STEP_NS = BigInt(Math.round(1e9 / C.TICK_HZ));
const MAX_CATCHUP = 8;

/** A career store that keeps nothing, for a host built without one. Same three functions
 *  the real stores expose, so nothing below needs a branch: a host with no store is one
 *  where every account reads back empty and every write goes nowhere. */
const NO_RANKS = { careerOf: () => 0, badgesOf: () => ({}), setCareer: () => {} };

/**
 * Build a host. Nothing starts on its own — the caller owns the loop and calls `advance()`.
 *
 * @param {object}   opts
 * @param {function} opts.nowNs   monotonic clock, nanoseconds as a BigInt
 * @param {object}   [opts.ranks] career store; omitted means careers are not kept
 * @param {function} [opts.log]   where the join/leave lines go
 */
export function createHost({ nowNs, ranks = NO_RANKS, log = () => {} }) {
  // modeId -> { room, clients: Map<playerId, client> }
  //
  // Sockets are tracked per room rather than in one global map because each Room
  // allocates player ids from 1, so ids are only unique within a room.
  //
  // `clients.size` is the HUMAN population of the room, and the backfill below is built
  // on it: everything in `room.players` that is not one of these is a bot.
  const rooms = new Map();

  for (const id of MODE_IDS) {
    if (!hasController(MODES[id].ctl)) continue;
    const room = new Room(id);
    // The one wire between the simulation and the store, installed from this side so a
    // Room built anywhere else — the test suite builds four — persists nothing.
    room.onCareer = ranks.setCareer;
    rooms.set(id, { room, clients: new Map() });
  }

  const AVAILABLE = [...rooms.keys()];
  const pending = MODE_IDS.filter((id) => !rooms.has(id));

  /** An unknown or not-yet-implemented mode gets the default rather than a refused
   *  connection — the client learns which it actually joined from WELCOME. */
  const pickRoom = (want) => (rooms.has(want) ? want : DEFAULT_MODE);

  /**
   * BACKFILL: bots fill exactly the slots the humans have not.
   *
   * A lobby seats `mode.slots` bodies, so the AI population is `slots - humans` and
   * nobody chooses it. One player in a deathmatch is one player and nine bots; a second
   * player takes one of those places, leaving eight; the tenth turns the room into pure
   * player-versus-player without anything being reconfigured, and a player who leaves
   * hands their slot straight back to a bot so the match never thins out mid-fight.
   *
   * THE EMPTY ROOM IS THE ONE SPECIAL CASE, and it is zero rather than a full house:
   * `slots - 0` would leave every mode on the server permanently simulating ten bots in
   * an arena nobody is looking at. No humans, no bodies.
   *
   * Nothing here refuses an eleventh player. `Math.max(0, ...)` means an over-capacity
   * room simply runs with no bots — the menu greys a full lobby out beforehand, which is
   * the honest place to say no, and bouncing somebody at the handshake would leave them
   * with nowhere to go at all.
   *
   * Called on every join and every leave, and idempotent: the usual outcome is that the
   * count already matches and `setBots` does nothing.
   */
  function syncBots(slot) {
    const humans = slot.clients.size;
    const want = humans ? Math.max(0, slot.room.mode.slots - humans) : 0;
    const before = slot.room.bots.size;
    const after = slot.room.setBots(want);
    // Team modes need their sides evened afterwards. `setBots` drops the NEWEST bot to
    // make room for an arriving human, and newest says nothing about which side it was
    // on — so a 5v5 room that gains a player lands on 6v4 as often as 5v5 until this
    // runs. It is a no-op for a free-for-all, which has no sides to even.
    slot.room.ctl.rebalance(slot.room);
    if (after !== before) {
      log(`  bots ${slot.room.modeId}: ${before} -> ${after}  (${humans} human)`);
    }
  }

  /**
   * How full every lobby is, as `{ modeId: humans }`.
   *
   * HUMANS ONLY, and that is the whole point of the number: a room holding one player and
   * nine bots has nine seats free, and a count of BODIES would report it as full and grey
   * out the one lobby somebody could actually walk into.
   */
  const lobbyState = () => {
    const out = {};
    for (const [modeId, slot] of rooms) out[modeId] = slot.clients.size;
    return out;
  };

  /**
   * Tell every connected client, in every room, how full the lobbies now are.
   *
   * Everyone rather than the room that changed, because the menu greys out lobbies OTHER
   * than the one you are in — a player reading the keybinds in deathmatch is exactly who
   * needs to know that team DM just filled up. Encoded once and sent many times; it fires
   * on a join or a drop, thousands of ticks apart, never per tick.
   */
  function pushLobby() {
    const payload = encode({ t: MSG.LOBBY, rooms: lobbyState() });
    for (const slot of rooms.values()) {
      for (const client of slot.clients.values()) {
        if (client.isOpen()) client.send(payload);
      }
    }
  }

  function broadcast(slot) {
    if (!slot.clients.size) {
      // Nobody here. Still drain, or the first player to join a quiet room would
      // receive every event that accumulated while it was empty.
      slot.room.drainEvents();
      return;
    }

    const msg = slot.room.snapshotBase();
    const ev = slot.room.drainEvents();
    if (ev.length) msg.ev = ev;

    for (const [id, client] of slot.clients) {
      if (!client.isOpen()) continue;
      const p = slot.room.players.get(id);

      // Two per-recipient fields:
      //   ack  — newest input consumed from them; they replay everything after it.
      //   self — their own velocity and grounded flag, which the shared player list
      //          omits. Reconciliation replays from this; without it the client
      //          restarts each replay from the wrong velocity and jitters forever.
      //
      // Ammunition, reload and swap timers ride here too. They are private to one
      // player and would otherwise cost a field on every entry in the player list.
      // `w` is the authoritative weapon: a client that asked for something outside
      // the mode's loadout finds out here that it was not granted.
      msg.ack = p?.lastSeq ?? 0;
      msg.self = p
        ? {
            vx: r3(p.vx),
            vy: r3(p.vy),
            vz: r3(p.vz),
            g: p.grounded ? 1 : 0,
            // Jumping is edge-triggered, so whether the button was already down is
            // simulation state. It has to travel or the replay below starts from the
            // client's own latch instead of authority, and the two disagree about
            // whether a held space is a fresh jump.
            jh: p.jumpHeld ? 1 : 0,
            // Stamina, and the two pieces of memory that go with it. Sent RAW, with no r3()
            // anywhere near them: these are whole integer units precisely so that JSON
            // carries them bit-exact. Rounding a float here would let the client and the
            // host cross the empty and the 25% thresholds on different ticks, and one tick
            // of disagreement about the speed cap diverges the whole replay below.
            st: p.stamina,
            rt: p.restTicks,
            sl: p.sprintLock ? 1 : 0,
            w: p.wep,
            // The weapons this player was dealt, in slot order. It rides here rather
            // than in a one-off message because it changes on every respawn in
            // deathmatch: repeating it in each snapshot means a dropped packet costs
            // nothing and there is no join order to get wrong.
            ld: p.loadout,
            am: p.ammo[p.wep],
            rl: Math.max(0, Math.round(p.reloadUntil - slot.room.now())),
            // Ms left on a jam in the weapon actually held, 0 otherwise. The EV.JAM event
            // starts the animation; this is what keeps the readout honest afterwards, and
            // it is per-weapon on the host, so swapping to a clean gun clears the HUD
            // without the client having to track which of them was stuck.
            jm: Math.max(0, Math.round(p.jammedUntil[p.wep] - slot.room.now())),
            // Career kills, this player's own. The shared player list carries only the derived
            // tier, on purpose — a career total is nobody else's business — but the OWNER needs
            // the raw count, because a rank name with no distance to the next one gives a player
            // nothing to aim at. Raw for the same reason the stamina above is raw: it is an
            // integer, and r3() on an integer only invites someone to make it a float later.
            cv: p.career,
            // Badge counts, `{ track: count }`, and PRIVATE for exactly the reason `cv` above
            // is: what you have done with each weapon over a career is nobody else's business,
            // and the public player list already carries the one derived number — the rank
            // tier — that other people have a use for.
            //
            // Sent every snapshot rather than pushed on change. It costs about fifty bytes
            // against a snapshot budget already in the tens of kilobytes a second, and it buys
            // the property the card renderer depends on: the counts a client holds are always
            // the counts the host holds, so a dropped packet costs nothing and there is no
            // join order to get wrong. `ld` above rides here on the same argument.
            //
            // Omitted entirely while empty, so a brand-new player's snapshot is byte-identical
            // to what it was before this field existed.
            ...(Object.keys(p.badges).length ? { bd: p.badges } : {}),
          }
        : null;

      client.send(encode(msg));
    }
  }

  /**
   * Seat a transport's socket.
   *
   * `client` is the whole of what a transport has to provide: `send(payload)` and
   * `isOpen()`. Returns the two things the transport drives back — a message sink, and
   * the teardown to run on close or error, which is idempotent so both can call it.
   */
  function connect(client) {
    let id = null;
    let slot = null;

    function message(raw) {
      const m = decode(raw);
      if (!m) return;

      if (m.t === MSG.HELLO) {
        if (id !== null) return; // one handshake per socket
        const modeId = pickRoom(m.mode);
        slot = rooms.get(modeId);
        const account = sanitizeAccount(m.id);
        id = slot.room.add(sanitizeName(m.name), m.cosmetics ?? {}, account);
        // Load the career onto the player right after `add`, which starts everyone at 0 —
        // Room has no way to look one up and is not supposed to gain one.
        slot.room.players.get(id).career = ranks.careerOf(account);
        // And the badge counts, from the same store on the same terms. `badgesOf` hands back
        // a copy, because the player object below is about to be incremented on every kill
        // and the store must only ever change through setCareer's monotonic guard.
        slot.room.players.get(id).badges = ranks.badgesOf(account);
        slot.clients.set(id, client);
        client.send(
          encode({
            t: MSG.WELCOME,
            id,
            tick: slot.room.tick,
            tickHz: C.TICK_HZ,
            snapshotHz: C.SNAPSHOT_HZ,
            mode: modeId,
            avail: AVAILABLE,
            // How full every lobby is, right now. It rides on WELCOME rather than
            // arriving as the first MSG.LOBBY push so that the mode picker is never
            // briefly showing every room as empty; the pushes carry every change after
            // this one, in the same shape, so the client reads both with one handler.
            lob: lobbyState(),
          }),
        );
        log(
          `+ ${slot.room.players.get(id).name} (#${id}) -> ${modeId} — ${slot.room.players.size} in room`,
        );
        // Backfill immediately, so this player's first snapshot already has the room
        // filled rather than showing an empty arena for a beat. Placed after `add`, so
        // the spawn picker puts the bots away from them — and after `clients.set` above,
        // because the count of humans is what decides how many bots there are.
        syncBots(slot);
        // And tell everybody, this client included, that a seat just went.
        pushLobby();
        return;
      }

      if (id === null) return; // must say hello first
      if (m.t === MSG.INPUT && Array.isArray(m.inputs)) slot.room.queueInput(id, m.inputs);
      // INPUT is the only thing a seated client can send. There is deliberately no
      // message for the bot count any more: it is `slots - humans`, which is the server's
      // arithmetic and not a preference, so there is nothing for a client to ask for.
    }

    const drop = () => {
      if (id === null) return;
      const name = slot.room.players.get(id)?.name ?? '?';
      slot.room.remove(id);
      slot.clients.delete(id);
      log(`- ${name} — ${slot.room.players.size} in room`);
      // A bot takes the freed slot, so the match does not thin out around whoever is
      // left — and once the LAST human leaves, `syncBots` empties the room outright
      // rather than leaving ten bots fighting over an arena with no audience.
      syncBots(slot);
      pushLobby();
      id = null;
      slot = null;
    };

    return { message, drop };
  }

  /** Every room steps in this one loop, so they share a tick count — reading it off
   *  any single room gives the same number as any other. */
  const clock = rooms.get(DEFAULT_MODE) ?? [...rooms.values()][0];
  let acc = 0n;
  let last = nowNs();

  /**
   * Step whatever wall-clock time has actually passed, then broadcast if a snapshot fell
   * due inside it. Returns the milliseconds the caller should wait before calling again.
   *
   * The caller schedules; this decides. A transport that scheduled on its own idea of the
   * interval would put back exactly the drift the accumulator exists to take out.
   */
  function advance() {
    const now = nowNs();
    acc += now - last;
    last = now;

    let steps = 0;
    let snapDue = false;
    while (acc >= STEP_NS && steps < MAX_CATCHUP) {
      for (const slot of rooms.values()) slot.room.step();
      acc -= STEP_NS;
      steps++;
      if (clock.room.tick % C.TICKS_PER_SNAPSHOT === 0) snapDue = true;
    }
    // Fell far enough behind that catching up tick-by-tick would spiral. Drop the
    // backlog instead and accept a discontinuity.
    if (steps === MAX_CATCHUP && acc >= STEP_NS * BigInt(MAX_CATCHUP)) acc = 0n;

    if (snapDue) for (const slot of rooms.values()) broadcast(slot);

    const waitMs = Number((STEP_NS - acc) / 1000000n);
    return Math.max(0, Math.min(waitMs, 4));
  }

  return { available: AVAILABLE, pending, connect, advance, rooms, occupancy: lobbyState };
}
