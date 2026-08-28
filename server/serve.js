// The Node entry point: a real WebSocket server wrapped around the host in ./index.js,
// and — on the same port — the static server for the built client.
//
// Everything platform-specific lives here and nowhere else — the `ws` library, the hrtime
// clock, and the ranks.json store on disk. The host itself knows about none of them, which
// is what lets client/src/localserver.js run the same host in a browser with no server at
// all. See the header of ./index.js for the shape of that seam.
//
//   npm run server      this file
//   npm run dev         this file plus vite (vite serves the page, this serves the game)
//   npm run dev:lan     the same, with vite reachable from other devices on the network
//   npm start           this file alone, serving dist/ as well — what a deploy runs
//
// ONE PORT, TWO PROTOCOLS, and that is the whole reason the http server is here. A WebSocket
// starts life as an HTTP request carrying `Upgrade: websocket`, so a single listener can hand
// those to `ws` and answer everything else with a file. Three things fall out of it that are
// each worth more than the twenty lines it costs:
//
//   one deploy      A host that runs this process serves the client and the game together.
//                   There is no second service to stand up, no CORS, and no URL to paste.
//   no mixed content  A page served over https gets a wss socket back from the same origin.
//                   A browser refuses ws:// from an https: page outright, so a client on one
//                   host and a game server on another is the arrangement that needs work,
//                   not this one.
//   one env var     Cloud hosts hand a process the port to listen on in PORT and route 443
//                   to it. Reading it is the difference between deployable and not.
//
// The client still has to be told to dial back here rather than run its own in-page host, and
// that is a build-time value: `VITE_SERVER=origin npm run build`. See the host block at the
// top of client/src/main.js for the three ways that decision can be made.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as C from '../shared/constants.js';
import { createHost } from './index.js';
// The only filesystem-touching module under server/, and imported here and nowhere
// else — see the header of ranks.js for why room.js must not reach it.
import * as ranks from './ranks.js';

/** A cloud host names the port; a checkout does not, and gets the one the client's dev
 *  default already dials. */
const PORT = Number(process.env.PORT) || C.NET_PORT;

/** Where `vite build` puts the client. Absolute, because a deploy's working directory is
 *  nobody's promise. */
const WEB_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.map': 'application/json; charset=utf-8',
};

const host = createHost({
  nowNs: process.hrtime.bigint,
  ranks,
  log: (line) => console.log(line),
});

/**
 * Resolve a request path to a file inside WEB_ROOT, or null.
 *
 * The `startsWith` check is the point of the function and not a formality: without it
 * `GET /../../ranks.json` is a request this process would happily answer. `normalize`
 * collapses the traversal first, and anything that still lands outside the root is refused
 * rather than clamped, because a path that tried is not a path to guess the intent of.
 */
function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const rel = normalize(clean === '/' ? 'index.html' : clean.replace(/^\/+/, ''));
  const abs = join(WEB_ROOT, rel);
  if (abs !== WEB_ROOT && !abs.startsWith(WEB_ROOT + sep)) return null;
  return abs;
}

async function serveStatic(req, res) {
  // A health path, because most hosts want one and every one of them wants it to be cheap.
  // It answers before the filesystem is touched, so it stays up even with no dist/ built.
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`ok ${host.available.join(',')}`);
    return;
  }

  const abs = resolveFile(req.url ?? '/');
  if (!abs) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const body = await readFile(abs);
    res.writeHead(200, {
      'content-type': MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream',
      // The bundle's name carries its own hash, so it can be cached hard; index.html names
      // it and must not be, or a deploy would keep handing out the previous build.
      'cache-control': abs.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    res.end(body);
  } catch {
    // Nothing there. In a dev run that is every page request — vite is serving the client on
    // its own port and this process is only here for the socket — so the message says which
    // of the two situations it is rather than a bare 404.
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('no client build here — run `npm run build`, or use `npm run dev` and load vite');
  }
}

const server = createServer((req, res) => {
  serveStatic(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

// Attached to the http server rather than given a port of its own: `ws` then only claims
// requests carrying the upgrade header and leaves the rest to the handler above.
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  // The two calls the host needs from a transport. `readyState` is compared against the
  // socket's own OPEN rather than the class constant, which is what ws documents.
  const conn = host.connect({
    send: (payload) => ws.send(payload),
    isOpen: () => ws.readyState === ws.OPEN,
  });

  ws.on('message', (raw) => conn.message(raw));
  ws.on('close', conn.drop);
  ws.on('error', conn.drop);
});

server.listen(PORT, () => {
  console.log(
    `fpsbone server on port ${PORT}  (${C.TICK_HZ}Hz sim, ${C.SNAPSHOT_HZ}Hz snapshots)`,
  );
  console.log(`  game    ws://localhost:${PORT}`);
  console.log(`  client  http://localhost:${PORT}/  (from dist/, if built)`);
  console.log(
    `  modes live: ${host.available.join(', ')}`
    + `${host.pending.length ? `  |  pending: ${host.pending.join(', ')}` : ''}`,
  );
});

/** The host decides the interval; this only obeys it. `advance()` returns the wait because
 *  the accumulator inside it is the thing that knows how much of a step is already banked. */
function loop() {
  setTimeout(loop, host.advance());
}
loop();
