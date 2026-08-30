// Socket wrapper. Also the home of the artificial-latency path, which is not a
// debug nicety but a requirement: on localhost, absent interpolation and broken
// prediction both look perfect. `?lag=150&jitter=30` is the only thing that
// actually exercises them.

import * as C from '../../shared/constants.js';
import { MSG, encode, decode } from '../../shared/protocol.js';

export function createNet({
  url,
  identity,
  mode,
  lag = 0,
  jitter = 0,
  scheduleRetry = (fn, ms) => setTimeout(fn, ms),
  cancelRetry = (timer) => clearTimeout(timer),
  // How to obtain a socket. Defaults to a real one; the static build passes the in-page
  // host from localserver.js instead. Injected rather than branched on here because this
  // module has no business knowing there is more than one kind of host — everything below
  // this line is identical either way, prediction and lag compensation included.
  openSocket = (u) => new WebSocket(u),
}) {
  let requestedMode = mode;
  /** `lobby` carries how full every room is. Its own kind rather than a field on
   *  `snapshot` because it arrives on a join or a drop, not per tick, and the menu that
   *  wants it is on screen precisely when snapshots are not being drawn.
   *
   *  `roster` is the same argument applied inside one room: names, ranks and badge shelves
   *  arrive on a join, a drop or a promotion, so they are not in the twenty-a-second
   *  snapshot. The scoreboard reads both — this for who somebody is, the snapshot for how
   *  they are doing and what their ping is right now. */
  const handlers = {
    welcome: [], reject: [], snapshot: [], status: [], lobby: [], population: [], roster: [],
  };
  const emit = (k, v) => handlers[k].forEach((f) => f(v));

  // `lag` is a round-trip figure, so half of it is applied in each direction.
  const oneWay = Math.max(0, lag) / 2;
  const jit = Math.max(0, jitter) / 2;
  const delay = (fn) => {
    if (oneWay <= 0 && jit <= 0) return fn();
    setTimeout(fn, Math.max(0, oneWay + (Math.random() * 2 - 1) * jit));
  };

  let ws = null;
  let open = false;
  let resumeToken = null;
  let retryTimer = null;
  let retryCount = 0;
  let rejected = false;
  let wanted = false;
  let connectionSerial = 0;

  const sentAt = new Map(); // seq -> local send time
  let rtt = 0;
  /**
   * The newest snapshot's sim time and the local instant it arrived — the pair that lets
   * `viewMs` name a moment on the SERVER's clock without ever synchronising to it.
   *
   * Only the pair is meaningful; neither number means anything alone. Keeping the local
   * arrival time is what makes the answer a moving clock rather than a stale stamp.
   */
  let srvMs = 0;
  let srvAt = 0;
  let snapCount = 0;
  let windowStart = performance.now();
  let snapRate = 0;

  function rawSend(obj) {
    if (!open) return;
    const payload = encode(obj);
    delay(() => {
      if (ws?.readyState === (ws?.OPEN ?? WebSocket.OPEN)) ws.send(payload);
    });
  }

  function handle(m, serial = connectionSerial) {
    if (m.t === MSG.CHALLENGE && typeof m.n === 'string') {
      // Persistent identity is challenge-response, never a reusable id string. An older
      // browser without WebCrypto may still enter as a guest, but receives no durable row.
      Promise.resolve(identity.prove?.(m.n) ?? null).then((auth) => {
        if (serial !== connectionSerial || !open) return;
        rawSend({
          t: MSG.HELLO,
          name: identity.displayName,
          cosmetics: identity.cosmetics,
          id: identity.id,
          ...(identity.legacy ? { legacy: identity.legacy } : {}),
          ...(auth ? { auth } : {}),
          mode: requestedMode,
          ...(resumeToken ? { resume: resumeToken } : {}),
        });
      }).catch(() => {
        if (serial === connectionSerial) {
          emit('status', 'identity_error');
          ws?.close?.(4003, 'identity_error');
        }
      });
      return;
    }
    // This reaches browser JavaScript before returning, so it measures the player's route
    // through the proxy rather than Render edge↔server or snapshot↔next-input scheduling.
    // `rawSend` also keeps the artificial-latency path honest in both directions.
    if (m.t === MSG.PING && typeof m.n === 'string') {
      rawSend({ t: MSG.PONG, n: m.n });
      return;
    }
    if (m.t === MSG.WELCOME) {
      if (typeof m.resume === 'string' && m.resume) resumeToken = m.resume;
      retryCount = 0;
      if (m.pop && typeof m.pop === 'object') emit('population', m.pop);
      return emit('welcome', m);
    }
    if (m.t === MSG.REJECT) {
      rejected = true;
      wanted = false;
      if (m.lob && typeof m.lob === 'object') emit('lobby', m.lob);
      if (m.pop && typeof m.pop === 'object') emit('population', m.pop);
      emit('reject', m);
      ws?.close?.(4003, m.reason ?? 'rejected');
      return;
    }
    // Occupancy. The initial figures ride on WELCOME instead, so a client greys out a full
    // lobby from its first frame rather than after the first join anywhere on the server;
    // both carry the same shape, and main.js points both at one handler.
    if (m.t === MSG.LOBBY) {
      if (m.pop && typeof m.pop === 'object') emit('population', m.pop);
      return emit('lobby', m.rooms);
    }
    // Who is in this room and what they wear. Rare, unprompted, and REPLACES rather than
    // merges: the server sends the whole room every time, so a player who left is gone by
    // absence and there is no removal message to miss.
    if (m.t === MSG.ROSTER) return emit('roster', m.players);
    if (m.t !== MSG.SNAPSHOT) return;

    // Input-to-ack latency. Reads slightly above true network RTT because it
    // includes up to one snapshot interval of server-side buffering — which is
    // the number that actually governs how the game feels.
    const t0 = sentAt.get(m.ack);
    if (t0 !== undefined) {
      const sample = performance.now() - t0;
      rtt = rtt ? rtt * 0.8 + sample * 0.2 : sample;
      for (const k of sentAt.keys()) if (k <= m.ack) sentAt.delete(k);
    }

    // Sim time of the state this snapshot DESCRIBES, which is one tick behind the tick
    // it is stamped with: room.step() stamps its history at `now()` and then increments,
    // and index.js builds the snapshot after that increment. Derived rather than sent as
    // a second field, because `tick` already carries it — and verify.mjs asserts the
    // one-tick relationship directly, so a change to the server's loop order fails a
    // test instead of quietly costing every player a tick of lag compensation.
    srvMs = ((m.tick - 1) * 1000) / C.TICK_HZ;
    srvAt = performance.now();
    snapCount++;
    const now = performance.now();
    if (now - windowStart >= 1000) {
      snapRate = (snapCount * 1000) / (now - windowStart);
      snapCount = 0;
      windowStart = now;
    }

    emit('snapshot', m);
  }

  function dial() {
    const serial = ++connectionSerial;
    const socket = openSocket(url);
    ws = socket;
    socket.onopen = () => {
      if (serial !== connectionSerial) return;
      open = true;
      emit('status', 'connected');
      // HELLO waits for the host's fresh challenge. The requested mode, identity proof
      // and resume token travel together in that response.
    };
    socket.onclose = () => {
      if (serial !== connectionSerial) return;
      open = false;
      if (rejected) {
        emit('status', 'rejected');
        return;
      }
      if (!wanted) {
        emit('status', 'idle');
        return;
      }
      emit('status', 'reconnecting');
      const wait = Math.min(5000, 750 * (2 ** Math.min(retryCount++, 3)));
      cancelRetry(retryTimer);
      retryTimer = scheduleRetry(dial, wait);
    };
    socket.onerror = () => {
      if (serial === connectionSerial) emit('status', 'error');
    };
    socket.onmessage = (e) => {
      if (serial !== connectionSerial) return;
      const raw = e.data;
      delay(() => {
        if (serial !== connectionSerial) return;
        const m = decode(raw);
        if (m) handle(m, serial);
      });
    };
  }

  return {
    on(kind, fn) {
      handlers[kind].push(fn);
    },
    connect() {
      if (wanted || open) return;
      wanted = true;
      rejected = false;
      cancelRetry(retryTimer);
      sentAt.clear();
      rtt = 0;
      srvMs = 0;
      srvAt = 0;
      dial();
    },
    /** Begin the next seat request with the mode selected in the lobby. */
    setMode(id) {
      if (typeof id === 'string' && id) requestedMode = id;
    },
    /**
     * An intentional departure. Invalidating the serial before closing makes the close
     * callback a no-op locally, while code 1000 tells the host not to reserve the seat.
     */
    disconnect() {
      wanted = false;
      rejected = false;
      cancelRetry(retryTimer);
      retryTimer = null;
      resumeToken = null;
      open = false;
      const socket = ws;
      ws = null;
      connectionSerial++;
      try { socket?.close?.(1000, 'left_match'); } catch { /* already gone */ }
      emit('status', 'idle');
    },
    get connected() {
      return open;
    },
    get active() {
      return wanted;
    },
    get rtt() {
      return rtt;
    },
    get snapRate() {
      return snapRate;
    },

    /**
     * When this client's screen is, in server sim time. Goes out on every input as `vt`
     * and is the whole of what the server needs to rewind targets to what was drawn —
     * see `rewindTimeFor` in server/hitscan.js.
     *
     * Newest snapshot's sim time plus however long we have been holding it. That is the
     * server clock advanced by local elapsed time, which is exactly what interp.js means
     * by "now": it buffers snapshots against LOCAL receive time and draws at
     * `local now - INTERP_DELAY_MS`, so adding the same local delta to the same
     * snapshot's server time names the same instant on the other clock. The server
     * subtracts INTERP_DELAY_MS itself rather than trusting this to.
     *
     * The one-way network delay is deliberately NOT added. It would make the number a
     * guess about the future, and it does not need to be: the server compares against
     * its own `now`, which has already moved on by the trip.
     *
     * 0 before the first snapshot, which reads as "no estimate" on the far side and
     * resolves against the present exactly as v1 did.
     */
    viewMs() {
      if (!srvAt) return 0;
      return Math.max(0, Math.round(srvMs + (performance.now() - srvAt)));
    },
    sendInputs(inputs) {
      if (!inputs.length) return;
      sentAt.set(inputs[inputs.length - 1].seq, performance.now());
      if (sentAt.size > 240) sentAt.delete(sentAt.keys().next().value);
      rawSend({ t: MSG.INPUT, inputs });
    },
  };
}
