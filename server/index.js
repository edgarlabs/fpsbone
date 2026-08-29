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
 * How many snapshot send times a room remembers, for the ping column. In snapshots, not
 * milliseconds: the ring only has to outlive one round trip, and sixty of them is three
 * seconds at SNAPSHOT_HZ — longer than any round trip a playable game has. A client whose
 * echo arrives later than that gets no sample, which is the right answer for a connection
 * that far gone.
 */
const PING_RING = 60;

/**
 * Smallest gap between two ping samples for one player, in ms. Inputs arrive at frame rate,
 * so without this the column would be an average of sixty readings a second — a number that
 * chases every frame hitch on the client instead of the connection underneath it.
 */
const PING_SAMPLE_MS = 250;

/**
 * ROUND TRIP, TIMED BY THE SERVER, off a tick number the client echoes back.
 *
 * `ws.ping()` looks like the tool for this and is the wrong one behind a reverse proxy. On
 * the Render deploy the app's own control frames are answered by Render's edge rather than
 * by the browser: serve.js measured 1ms on sockets whose real round trip, clocked from the
 * far end of the same wire, was 184ms to Oregon and 83ms to Singapore. Every human on the
 * scoreboard wore a ping no human has, while the bots beside them wobbled around a
 * believable 20-60 — the exact inversion of what the seeded bot ping is for.
 *
 * So this measures the path the GAME takes, which is the only path anybody cares about: the
 * server stamps when a snapshot left, the client echoes the newest tick it has seen on its
 * next input, and the difference is a round trip through everything in the middle, edge
 * included.
 *
 * A CLIENT CANNOT TALK ITS PING DOWN WITH THIS. Both ends of the subtraction are read off a
 * clock only the server holds; the one thing a client chooses is WHICH tick it echoes, and
 * every choice available to it is worse for itself — an older tick reads as a longer trip,
 * and a tick it has not been sent is not in the ring and reads as nothing at all. There is
 * no edit that makes the gap smaller, which is the property that made ws.ping() attractive
 * and is kept here without it.
 *
 * It reads a few milliseconds above the wire, because the echo waits for the client's next
 * input send. That is the same bias client/src/net.js documents on its own reading, and for
 * a scoreboard it is the better number: it is the lag the player is actually playing with.
 *
 * `now` is the HOST'S clock and not `Date.now()`, for the same reason the simulation runs on
 * one: a wall clock steps when NTP corrects it, and a step backwards through a subtraction
 * like this one is a negative round trip. It also means the suite can drive this at whatever
 * speed it likes, which is the only way to assert a latency without waiting for one.
 */
function samplePing(slot, id, tick, now) {
  if (!Number.isFinite(tick)) return;
  const left = slot.sentAt.get(tick);
  if (left === undefined) return; // out of the ring, or a tick this server never sent
  const p = slot.room.players.get(id);
  if (!p) return;
  if (p.pingAt && now - p.pingAt < PING_SAMPLE_MS) return;
  const sample = now - left;
  // Smoothed the way the client smooths its own reading, with the same coefficient: one
  // retransmission on a mobile connection should move a column by a few milliseconds rather
  // than spike it to 400 for a second. The first sample stands alone — there is nothing to
  // average it against, and starting from 0 would spend a second climbing to the truth.
  p.ping = p.pingAt ? p.ping * 0.8 + sample * 0.2 : sample;
  p.pingAt = now;
}

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
    // `rosterSent` is the last `room.rosterRev` this room's clients were told about. -1 and
    // not 0 so an empty room's first push is still a push: a Room starts at rev 0, and a
    // sentinel that matched it would mean the first client to join a fresh room learned the
    // roster only when the second one did.
    rooms.set(id, { room, clients: new Map(), rosterSent: -1, sentAt: new Map() });
  }

  /** The host clock in whole milliseconds. Ping arithmetic only — the simulation keeps
   *  using the BigInt nanoseconds, where a rounded millisecond would accumulate drift. */
  const msNow = () => Number(nowNs() / 1000000n);

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

    // WHO IS IN THE ROOM, when that has changed. One integer compare per broadcast, which is
    // what lets the answer be checked twenty times a second and sent about twice a match:
    // `rosterRev` moves on a join, a drop, and a kill that actually promoted somebody.
    //
    // No explicit call on the join path, and that is the point of doing it here. A push
    // written into the handshake would have to be repeated in `drop`, in `syncBots`, and on
    // the promotion inside `damage` — four call sites to keep in step, one of which lives in
    // another file. `Room.add` and `Room.remove` bump the revision themselves, so every edge
    // that can change a row is already covered by the one check below.
    //
    // Encoded once and sent many times, exactly like `pushLobby`.
    if (slot.room.rosterRev !== slot.rosterSent) {
      slot.rosterSent = slot.room.rosterRev;
      const roster = encode({ t: MSG.ROSTER, players: slot.room.rosterState() });
      for (const client of slot.clients.values()) {
        if (client.isOpen()) client.send(roster);
      }
    }

    const msg = slot.room.snapshotBase();
    // WHEN THIS TICK LEFT, so that a client echoing the tick number back turns into a round
    // trip. One entry per snapshot for the whole room, not per client: the broadcast below
    // hands every client the same bytes at the same instant. See samplePing.
    slot.sentAt.set(msg.tick, msNow());
    if (slot.sentAt.size > PING_RING) slot.sentAt.delete(slot.sentAt.keys().next().value);
    const ev = slot.room.drainEvents();
    if (ev.length) msg.ev = ev;

    for (const [id, client] of slot.clients) {
      if (!client.isOpen()) continue;
      const p = slot.room.players.get(id);
      // The transport's measurement — used only until this client's first echo lands, and
      // then never again. A transport measures the hop it owns, which behind a reverse proxy
      // is not the hop to the player; samplePing explains what that cost and what replaced
      // it. A transport with no `rtt()` at all leaves the field at 0 until then, which the
      // snapshot omits rather than sends.
      //
      // Onto the body, for the NEXT snapshot rather than this one — `snapshotBase` above has
      // already been built. That one-snapshot lag is 50ms on a number that moves over
      // seconds, and the alternative is walking every client twice per broadcast to collect
      // pings before building the base that everyone shares.
      if (p && !p.pingAt) p.ping = client.rtt?.() ?? 0;

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
            // The scope, and how long it has been open. Simulation state exactly like `jh`
            // and the stamina trio above, and it has to come back for the same reason:
            // `reconcile` replays every unacked input, and `stepPlayer` ADDS to `scopeMs`
            // rather than deriving it, so a replay that started from the client's own
            // running total would count those inputs twice and age the scope about three
            // times too fast. The settle window is what decides whether a quick-scope
            // lands, so a client whose crosshair thought it was settled while the host
            // knew it was not is exactly the desync that makes a weapon feel broken.
            //
            // `sm` is ROUNDED, unlike the stamina, and the difference is what reads it: no
            // position depends on this number, only a cone width and the ring that draws
            // it, so a third of a millisecond of disagreement inside a 120ms window is
            // invisible. The host's own unrounded copy is what resolves the shot.
            //
            // Both omitted while zero, which is every player not currently scoped —
            // eleven weapons out of twelve and most of the twelfth's airtime — so an
            // ordinary snapshot is byte-identical to what it was before the scope existed.
            ...(p.scope ? { sc: p.scope, sm: Math.round(p.scopeMs) } : {}),
          }
        : null;

      client.send(encode(msg));
    }
  }

  /**
   * Seat a transport's socket.
   *
   * `client` is the whole of what a transport has to provide: `send(payload)` and
   * `isOpen()`, plus an OPTIONAL `rtt()` in whole milliseconds. Returns the two things the
   * transport drives back — a message sink, and the teardown to run on close or error,
   * which is idempotent so both can call it.
   *
   * `rtt` is optional and not required because measuring one is a transport's business and
   * only one transport can: `serve.js` has `ws.ping()` and a `pong` frame answered by the
   * browser's own socket stack, so the number is measured rather than claimed. The in-page
   * host in localserver.js has no wire at all and returns nothing, which reads as zero and
   * shows a scoreboard with no ping column entry for the one player in it — correct, since
   * the round trip really is zero. A transport that omits it entirely still works.
   *
   * IT IS MEASURED SERVER-SIDE ON PURPOSE, and the alternative is worth naming: the client
   * already computes this number for its own HUD (see `rtt` in client/src/net.js) and could
   * simply report it. Then the scoreboard would be showing twelve players' self-reported
   * latency, which is a thing a client can lie about downward for free.
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
      if (m.t === MSG.INPUT && Array.isArray(m.inputs)) {
        slot.room.queueInput(id, m.inputs);
        // The same message carries the newest tick this client has seen, which is what the
        // scoreboard's ping column is measured from — see samplePing.
        samplePing(slot, id, m.st, msNow());
      }
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
