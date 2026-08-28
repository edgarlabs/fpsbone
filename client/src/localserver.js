// The in-page host: server/index.js running inside the browser tab, behind an object that
// looks enough like a WebSocket that client/src/net.js cannot tell the difference.
//
// WHY THIS EXISTS. A static host — Vercel, Netlify, GitHub Pages, an S3 bucket — will serve
// the built client perfectly and cannot run `server/serve.js` at all: there is no long-lived
// process to hold a WebSocket and no port but 443 to reach it on. A client shipped there
// spends forever on "connecting…" because nothing is listening, which is the exact symptom
// this file removes. The simulation is plain JavaScript with no Node in it, so it runs here
// just as well as it runs there.
//
// WHAT YOU GIVE UP, stated once and plainly: there is one host per tab, so the only
// opponents are the AI. Two people on two machines loading the same static URL each get
// their own private match. Playing against another human needs one process both clients can
// reach, which means running server/serve.js somewhere that allows it and pointing the
// client at it with `?server=wss://host` — see the header of main.js.
//
// WHAT YOU DO NOT give up: the rules. This is not a reimplementation or a cut-down
// practice mode. It is the same `createHost` the real server wraps, so hit registration,
// lag compensation, spawn logic, mode controllers, bot AI and the wire format are the ones
// `npm run verify` tests. Prediction and interpolation stay switched on too, and still work,
// because net.js is unchanged — the messages simply have a shorter trip.

import { createHost } from '../../server/index.js';
import * as ranks from './ranks-local.js';

/**
 * performance.now() is milliseconds as a float; the host's accumulator is nanoseconds as a
 * BigInt. Converting here rather than loosening the host means both platforms run the exact
 * same integer arithmetic, so the browser cannot quietly acquire a different rounding story
 * than the server the test suite measures.
 *
 * performance.now() is monotonic — it cannot jump backwards when the system clock is set —
 * which is the property the accumulator needs and the only reason Date.now() is not used.
 */
const nowNs = () => BigInt(Math.round(performance.now() * 1e6));

const OPEN = 1;
const CONNECTING = 0;
const CLOSED = 3;

/** One host per page, built on the first connection rather than at import. A tab that never
 *  connects — a build that was pointed at a real server — must not start a simulation loop
 *  in the background, and this is also what makes a reconnect land in the SAME rooms rather
 *  than a fresh set with the scores reset. */
let host = null;
let looping = false;

function ensureHost() {
  if (host) return host;
  host = createHost({
    nowNs,
    ranks,
    // Quiet by default. The join/leave and bot-count lines are genuinely useful when
    // something is wrong and pure noise when it is not, so they go to console.debug, which
    // a browser hides until you ask for verbose output.
    log: (line) => console.debug(`[local host] ${line}`),
  });
  return host;
}

/**
 * Drive the simulation. The host decides the interval and this only obeys it, exactly as
 * server/serve.js does — a loop that scheduled on its own idea of the tick would put back
 * the drift the accumulator exists to take out.
 *
 * A background tab gets its timers throttled to roughly one a second by every browser. That
 * is not a correctness problem: the accumulator sees the real elapsed time, and the host's
 * own catch-up cap notices the backlog is hopeless and drops it rather than fast-forwarding
 * the match through a minute of simulation. It costs a discontinuity on return, which is the
 * same thing the real server does to a client whose machine slept.
 */
function startLoop() {
  if (looping) return;
  looping = true;
  const tick = () => setTimeout(tick, host.advance());
  tick();
}

/**
 * A WebSocket, near enough.
 *
 * net.js uses six things off a socket — `readyState`, `send`, and the four `on*` handlers —
 * so those are what this provides. It is deliberately NOT a full implementation: no
 * protocols, no buffering, no binary frames. Anything net.js does not touch is absent on
 * purpose, so the next person to read it is not misled into thinking this is general.
 */
export function createLocalSocket() {
  const sock = {
    readyState: CONNECTING,
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    send(payload) {
      if (sock.readyState !== OPEN) return;
      // Straight through, on the caller's stack. There is no wire to be asynchronous
      // about, and net.js already owns the artificial-latency path (`?lag=`) for the
      // cases where a delay is the thing being tested.
      conn.message(payload);
    },
    close() {
      if (sock.readyState === CLOSED) return;
      sock.readyState = CLOSED;
      conn.drop();
      sock.onclose?.({});
    },
  };

  let conn;
  try {
    conn = ensureHost().connect({
      send: (payload) => sock.onmessage?.({ data: payload }),
      isOpen: () => sock.readyState === OPEN,
    });
  } catch (err) {
    // Building the host is the one thing here that can genuinely fail — a browser missing
    // something the simulation needs. Report it the way a socket reports a failure, so the
    // client's existing error path shows it instead of the page dying on import.
    console.error('[local host] failed to start', err);
    sock.readyState = CLOSED;
    setTimeout(() => sock.onerror?.({}), 0);
    return sock;
  }

  // Asynchronously, because net.js assigns `onopen` on the line after it constructs the
  // socket. Firing synchronously here would run the handshake against a handler that does
  // not exist yet, and the client would sit at "connecting…" having never said hello — the
  // very bug this file was written to remove.
  setTimeout(() => {
    sock.readyState = OPEN;
    startLoop();
    sock.onopen?.({});
  }, 0);

  return sock;
}
