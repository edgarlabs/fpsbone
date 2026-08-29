// The game host: rooms, the handshake, the snapshot fan-out and the fixed-timestep loop.
//
// PLATFORM-AGNOSTIC ON PURPOSE, and that is the whole design of this file. Nothing here
// imports `ws`, touches the filesystem or reads `process` — the three things that tie a
// host to Node. They arrive instead as injections to `createHost`:
//
//   nowNs   a monotonic clock in nanoseconds, as a BigInt
//   ranks   the career store: { careerOf, badgesOf, setCareer }
//   region  the id this process can truthfully report after accepting a connection
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
// Every mode with a working controller gets its own Room. Active rooms tick in the one loop
// below; empty ones remain dormant. Switching mode is a client reload, not a host restart.

import * as C from '../shared/constants.js';
import { MSG, REJECT, encode, decode } from '../shared/protocol.js';
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
const IDLE_WAIT_MS = 50;

/** A career store that keeps nothing, for a host built without one. Same three functions
 *  the real stores expose, so nothing below needs a branch: a host with no store is one
 *  where every account reads back empty and every write goes nowhere. */
const NO_RANKS = { careerOf: () => 0, badgesOf: () => ({}), setCareer: () => {} };

/** Browser- and Node-safe resume token. The Math.random fallback is reached only by an old
 *  browser running its private in-page host, where the token never crosses a network. */
function defaultToken() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (globalThis.crypto?.getRandomValues) {
    const words = new Uint32Array(4);
    globalThis.crypto.getRandomValues(words);
    return [...words].map((n) => n.toString(16).padStart(8, '0')).join('');
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Build a host. Nothing starts on its own — the caller owns the loop and calls `advance()`.
 *
 * @param {object}   opts
 * @param {function} opts.nowNs   monotonic clock, nanoseconds as a BigInt
 * @param {object}   [opts.ranks] career store; omitted means careers are not kept
 * @param {function} [opts.log]   where the join/leave lines go
 * @param {string}   [opts.region] deployed region id; omitted by the in-page host
 * @param {function} [opts.makeToken] reconnect-token source; injected by deterministic tests
 * @param {function} [opts.setTimer] timer source; injected by deterministic tests
 * @param {function} [opts.clearTimer] timer cancellation; injected by deterministic tests
 */
export function createHost({
  nowNs,
  ranks = NO_RANKS,
  log = () => {},
  region = null,
  makeToken = defaultToken,
  setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimer = (timer) => globalThis.clearTimeout(timer),
} = {}) {
  // modeId -> { room, clients: Map<playerId, client>, reserved: Map<playerId, reservation> }
  //
  // Sockets are tracked per room rather than in one global map because each Room
  // allocates player ids from 1, so ids are only unique within a room.
  //
  // A seat is either connected or briefly reserved after an abnormal drop. Both count
  // toward admission and bot backfill, otherwise a reconnect could turn a ten-body room
  // into eleven while reclaiming the slot it was promised.
  const rooms = new Map();
  const reservations = new Map(); // opaque resume token -> reservation
  const startedNs = nowNs();
  const recentSteps = [];
  const recentSnapshots = [];
  const tickWorkMs = [];
  const schedulerLateMs = [];
  const totals = {
    joins: 0,
    resumes: 0,
    disconnects: 0,
    reservations: 0,
    reservationExpirations: 0,
    serverFull: 0,
    modeFull: 0,
    steps: 0,
    snapshotFrames: 0,
    snapshotMessages: 0,
    outboundMessages: 0,
    outboundBytesApprox: 0,
    droppedCatchups: 0,
  };

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
    rooms.set(id, { room, clients: new Map(), reserved: new Map(), rosterSent: -1 });
  }

  const AVAILABLE = [...rooms.keys()];
  const pending = MODE_IDS.filter((id) => !rooms.has(id));

  /** An unknown or not-yet-implemented mode gets the default rather than a refused
   *  connection — the client learns which it actually joined from WELCOME. */
  const pickRoom = (want) => (rooms.has(want) ? want : DEFAULT_MODE);

  const seatsOf = (slot) => slot.clients.size + slot.reserved.size;
  const humansTotal = () => {
    let n = 0;
    for (const slot of rooms.values()) n += seatsOf(slot);
    return n;
  };

  /** Throw away every transient thing in an empty match, including controller timers and
   *  scores. Replacing the Room is both more complete and less fragile than teaching the
   *  host the private state of every mode controller. */
  function resetRoom(slot) {
    const fresh = new Room(slot.room.modeId);
    fresh.onCareer = ranks.setCareer;
    slot.room = fresh;
    slot.rosterSent = -1;
  }

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
   * Admission below refuses an eleventh player. The clamp remains defensive arithmetic,
   * but a correctly seated room always has exactly `slots` bodies while it is occupied.
   *
   * Called on every join and every leave, and idempotent: the usual outcome is that the
   * count already matches and `setBots` does nothing.
   */
  function syncBots(slot) {
    const humans = seatsOf(slot);
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
   * How full every lobby is, as `{ modeId: occupied human seats }`.
   *
   * HUMANS ONLY, and that is the whole point of the number: a room holding one player and
   * nine bots has nine seats free, and a count of BODIES would report it as full and grey
   * out the one lobby somebody could actually walk into.
   */
  const lobbyState = () => {
    const out = {};
    for (const [modeId, slot] of rooms) out[modeId] = seatsOf(slot);
    return out;
  };

  /** One identity-free source of truth for both the lobby and the operations endpoint. */
  const populationState = () => {
    const out = {
      humans: 0,
      connected: 0,
      reserved: 0,
      bots: 0,
      bodies: 0,
      capacity: C.REGION_HUMAN_CAP,
      activeRooms: 0,
      dormantRooms: 0,
      reservedRooms: 0,
      fullRooms: 0,
      rooms: {},
    };
    for (const [modeId, slot] of rooms) {
      const connected = slot.clients.size;
      const reserved = slot.reserved.size;
      const humans = connected + reserved;
      const bots = slot.room.bots.size;
      const capacity = slot.room.mode.slots;
      const full = humans >= capacity;
      const state = full ? 'full' : connected ? 'active' : reserved ? 'reserved' : 'dormant';
      out.rooms[modeId] = {
        humans, connected, reserved, bots,
        bodies: slot.room.players.size,
        capacity,
        state,
      };
      out.humans += humans;
      out.connected += connected;
      out.reserved += reserved;
      out.bots += bots;
      out.bodies += slot.room.players.size;
      if (connected) out.activeRooms++;
      if (!humans) out.dormantRooms++;
      if (!connected && reserved) out.reservedRooms++;
      if (full) out.fullRooms++;
    }
    return out;
  };

  const keepSample = (list, value, limit = 600) => {
    list.push(value);
    if (list.length > limit) list.splice(0, list.length - limit);
  };
  const percentile = (list, p) => {
    if (!list.length) return 0;
    const sorted = [...list].sort((a, b) => a - b);
    return r3(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]);
  };
  const sampleSummary = (list) => ({
    p50: percentile(list, 0.5),
    p95: percentile(list, 0.95),
    max: list.length ? r3(Math.max(...list)) : 0,
  });
  const recentRate = (list, nowMs, uptimeMs) => {
    while (list.length && nowMs - list[0] > 10000) list.shift();
    const span = Math.min(10000, Math.max(1000, uptimeMs));
    return r3(list.length * 1000 / span);
  };
  const metricsState = () => {
    const now = nowNs();
    const uptimeMs = Math.max(0, Number(now - startedNs) / 1e6);
    const nowMs = Number(now) / 1e6;
    return {
      uptimeSec: r3(uptimeMs / 1000),
      simulation: {
        steps: totals.steps,
        stepHz: recentRate(recentSteps, nowMs, uptimeMs),
        tickWorkMs: sampleSummary(tickWorkMs),
        schedulerLateMs: sampleSummary(schedulerLateMs),
        droppedCatchups: totals.droppedCatchups,
      },
      snapshots: {
        frames: totals.snapshotFrames,
        messages: totals.snapshotMessages,
        hz: recentRate(recentSnapshots, nowMs, uptimeMs),
      },
      traffic: {
        outboundMessages: totals.outboundMessages,
        outboundBytesApprox: totals.outboundBytesApprox,
      },
      admissions: {
        joins: totals.joins,
        resumes: totals.resumes,
        disconnects: totals.disconnects,
        reservations: totals.reservations,
        reservationExpirations: totals.reservationExpirations,
        refused: { serverFull: totals.serverFull, modeFull: totals.modeFull },
      },
    };
  };

  function sendPayload(client, payload, snapshot = false) {
    client.send(payload);
    totals.outboundMessages++;
    totals.outboundBytesApprox += payload.length;
    if (snapshot) totals.snapshotMessages++;
  }

  /**
   * Tell every connected client, in every room, how full the lobbies now are.
   *
   * Everyone rather than the room that changed, because the menu greys out lobbies OTHER
   * than the one you are in — a player reading the keybinds in deathmatch is exactly who
   * needs to know that team DM just filled up. Encoded once and sent many times; it fires
   * on a join or a drop, thousands of ticks apart, never per tick.
   */
  function pushLobby() {
    const payload = encode({ t: MSG.LOBBY, rooms: lobbyState(), pop: populationState() });
    for (const slot of rooms.values()) {
      for (const client of slot.clients.values()) {
        if (client.isOpen()) sendPayload(client, payload);
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
        if (client.isOpen()) sendPayload(client, roster);
      }
    }

    const msg = slot.room.snapshotBase();
    const ev = slot.room.drainEvents();
    if (ev.length) msg.ev = ev;

    for (const [id, client] of slot.clients) {
      if (!client.isOpen()) continue;
      const p = slot.room.players.get(id);
      // The Node transport's application ping reaches browser JavaScript and comes straight
      // back, so unlike a control pong it cannot stop at a reverse-proxy edge, and unlike the
      // old input echo it does not include up to 50ms of batching. A local in-page transport
      // has no `rtt()` and honestly leaves the field unmeasured.
      //
      // Onto the body, for the NEXT snapshot rather than this one — `snapshotBase` above has
      // already been built. That one-snapshot lag is 50ms on a number that moves over
      // seconds, and the alternative is walking every client twice per broadcast to collect
      // pings before building the base that everyone shares.
      if (p) p.ping = client.rtt?.() ?? 0;

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
            // it, so a third of a millisecond of disagreement inside the settle window is
            // invisible. The host's own unrounded copy is what resolves the shot.
            //
            // Both omitted while zero, which is every player not currently scoped —
            // eleven weapons out of twelve and most of the twelfth's airtime — so an
            // ordinary snapshot is byte-identical to what it was before the scope existed.
            ...(p.scope ? { sc: p.scope, sm: Math.round(p.scopeMs) } : {}),
          }
        : null;

      sendPayload(client, encode(msg), true);
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
    let resumeToken = null;
    let greeted = false;

    const sendWelcome = (modeId) => {
      resumeToken = makeToken();
      sendPayload(client,
        encode({
          t: MSG.WELCOME,
          id,
          tick: slot.room.tick,
          tickHz: C.TICK_HZ,
          snapshotHz: C.SNAPSHOT_HZ,
          mode: modeId,
          // Opaque and memory-only. It proves that a reconnect is the socket that held
          // this seat, without treating today's unverified account id as authentication.
          resume: resumeToken,
          // The process that accepted the socket, not the region the browser requested.
          // A stale saved address must not let the menu claim the match is elsewhere.
          r: region,
          avail: AVAILABLE,
          cap: C.REGION_HUMAN_CAP,
          // How full every lobby is, right now. It rides on WELCOME rather than
          // arriving as the first MSG.LOBBY push so that the mode picker is never
          // briefly showing every room as empty; pushes carry every later change.
          lob: lobbyState(),
          pop: populationState(),
        }),
      );
    };

    const reject = (reason, modeId) => {
      sendPayload(client, encode({
        t: MSG.REJECT,
        reason,
        mode: modeId,
        lob: lobbyState(),
        cap: C.REGION_HUMAN_CAP,
        pop: populationState(),
      }));
      client.close?.(4003, reason);
    };

    function message(raw) {
      const m = decode(raw);
      if (!m) return;

      if (m.t === MSG.HELLO) {
        if (greeted) return; // one handshake attempt per socket, accepted or refused
        greeted = true;

        // A valid token outranks the requested mode: it names one exact seat in one exact
        // match. The token exists only while that seat is detached and is consumed here,
        // so it cannot clone a player or resume over a live connection.
        const held = typeof m.resume === 'string' ? reservations.get(m.resume) : null;
        if (held) {
          reservations.delete(held.token);
          held.slot.reserved.delete(held.id);
          clearTimer(held.timer);
          slot = held.slot;
          id = held.id;
          slot.clients.set(id, client);
          slot.rosterSent = -1; // the returning socket has not seen the current roster
          totals.resumes++;
          sendWelcome(slot.room.modeId);
          log(`~ ${slot.room.players.get(id)?.name ?? '?'} (#${id}) resumed ${slot.room.modeId}`);
          return;
        }

        const modeId = pickRoom(m.mode);
        slot = rooms.get(modeId);

        // The regional gate is checked before the room gate so a process at 20/20 tells
        // the truth even when the requested room also happens to be full. Node dispatches
        // handshakes serially, so checking and inserting in this same callback makes the
        // final seat atomic: two callers cannot both observe 19 and become player twenty.
        if (humansTotal() >= C.REGION_HUMAN_CAP) {
          totals.serverFull++;
          reject(REJECT.SERVER_FULL, modeId);
          slot = null;
          return;
        }
        if (seatsOf(slot) >= slot.room.mode.slots) {
          totals.modeFull++;
          reject(REJECT.MODE_FULL, modeId);
          slot = null;
          return;
        }

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
        totals.joins++;
        // Backfill immediately, so this player's WELCOME population and first snapshot
        // already show the full room. After `add`, so bots spawn away from the human; after
        // `clients.set`, because occupied human seats decide how many bots remain.
        syncBots(slot);
        sendWelcome(modeId);
        log(
          `+ ${slot.room.players.get(id).name} (#${id}) -> ${modeId} — ${seatsOf(slot)} human seat(s)`,
        );
        // And tell everybody, this client included, that a seat just went.
        pushLobby();
        return;
      }

      if (id === null) return; // must say hello first
      if (m.t === MSG.INPUT && Array.isArray(m.inputs)) {
        slot.room.queueInput(id, m.inputs);
      }
      // INPUT is the only thing a seated client can send. There is deliberately no
      // message for the bot count any more: it is `slots - humans`, which is the server's
      // arithmetic and not a preference, so there is nothing for a client to ask for.
    }

    const drop = ({ reserve = false } = {}) => {
      if (id === null) return;
      totals.disconnects++;
      const name = slot.room.players.get(id)?.name ?? '?';

      if (reserve && resumeToken && C.RECONNECT_GRACE_MS > 0) {
        totals.reservations++;
        const heldSlot = slot;
        const heldId = id;
        const heldToken = resumeToken;
        heldSlot.clients.delete(heldId);

        // Stop repeating the last movement while the player has no socket. Gravity and
        // the match continue if somebody else is present, but the detached body does not
        // walk itself into a wall for ten seconds.
        const p = heldSlot.room.players.get(heldId);
        if (p) {
          p.inputs.length = 0;
          p.lastInput = null;
          p.fireHeld = false;
          p.vx = 0;
          p.vz = 0;
        }

        const held = { token: heldToken, slot: heldSlot, id: heldId, timer: null };
        heldSlot.reserved.set(heldId, held);
        reservations.set(heldToken, held);
        held.timer = setTimer(() => {
          // A successful resume consumed this record and cancelled the timer. The identity
          // check also protects injected/fake timers whose cancellation is intentionally a
          // no-op in tests.
          if (reservations.get(heldToken) !== held) return;
          reservations.delete(heldToken);
          heldSlot.reserved.delete(heldId);
          heldSlot.room.remove(heldId);
          totals.reservationExpirations++;
          log(`- ${name} reconnect expired — ${seatsOf(heldSlot)} human seat(s) in room`);
          syncBots(heldSlot);
          if (seatsOf(heldSlot) === 0) resetRoom(heldSlot);
          pushLobby();
        }, C.RECONNECT_GRACE_MS);
        log(`~ ${name} reserved for ${C.RECONNECT_GRACE_MS / 1000}s`);
        id = null;
        slot = null;
        resumeToken = null;
        return;
      }

      slot.room.remove(id);
      slot.clients.delete(id);
      log(`- ${name} — ${seatsOf(slot)} human seat(s) in room`);
      // A bot takes the freed slot, so the match does not thin out around whoever is
      // left — and once the LAST human leaves, `syncBots` empties the room outright
      // rather than leaving ten bots fighting over an arena with no audience.
      syncBots(slot);
      if (seatsOf(slot) === 0) resetRoom(slot);
      pushLobby();
      id = null;
      slot = null;
      resumeToken = null;
    };

    return {
      message,
      drop,
      get seated() { return id !== null; },
    };
  }

  /** Snapshot cadence belongs to the host, not to any one room. Empty rooms do not tick,
   *  so using deathmatch as the clock would stop snapshots in sniper whenever deathmatch
   *  slept. Each active Room keeps its own simulation tick; this counter only schedules. */
  let hostTick = 0;
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

    // The socket server wakes independently of this timer, so an idle host needs no 4ms
    // scheduler churn. Reset the accumulator: time during which no room had an audience is
    // not simulation debt for the first player who later arrives.
    let hasAudience = false;
    for (const slot of rooms.values()) {
      if (slot.clients.size) { hasAudience = true; break; }
    }
    if (!hasAudience) {
      acc = 0n;
      return IDLE_WAIT_MS;
    }

    let steps = 0;
    let snapDue = false;
    if (acc >= STEP_NS) keepSample(schedulerLateMs, Number(acc - STEP_NS) / 1e6);
    while (acc >= STEP_NS && steps < MAX_CATCHUP) {
      // No open audience means no work. A wholly empty room has already been reset; a room
      // containing only a ten-second reconnect reservation is frozen until it resumes or
      // expires, preserving the exact match state without burning bot AI on nobody.
      const workStarted = nowNs();
      for (const slot of rooms.values()) if (slot.clients.size) slot.room.step();
      keepSample(tickWorkMs, Math.max(0, Number(nowNs() - workStarted) / 1e6));
      hostTick++;
      acc -= STEP_NS;
      steps++;
      totals.steps++;
      keepSample(recentSteps, Number(nowNs()) / 1e6, 1200);
      if (hostTick % C.TICKS_PER_SNAPSHOT === 0) snapDue = true;
    }
    // Fell far enough behind that catching up tick-by-tick would spiral. Drop the
    // backlog instead and accept a discontinuity.
    if (steps === MAX_CATCHUP && acc >= STEP_NS * BigInt(MAX_CATCHUP)) {
      totals.droppedCatchups++;
      acc = 0n;
    }

    if (snapDue) {
      totals.snapshotFrames++;
      keepSample(recentSnapshots, Number(nowNs()) / 1e6, 240);
      for (const slot of rooms.values()) broadcast(slot);
    }

    const waitMs = Number((STEP_NS - acc) / 1000000n);
    return Math.max(0, Math.min(waitMs, 4));
  }

  return {
    available: AVAILABLE,
    pending,
    connect,
    advance,
    rooms,
    occupancy: lobbyState,
    population: populationState,
    metrics: metricsState,
    get humans() { return humansTotal(); },
  };
}
