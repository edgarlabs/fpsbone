// Minimal CDP driver: launch Chrome, evaluate JS in the page, print results.
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;

export async function withPage(url, fn, { headless = true, flags = [] } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'fpscdp-'));
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--window-size=1280,720',
    ...(headless ? ['--headless=new'] : []),
    ...flags,
    url,
  ];
  const chrome = spawn(CHROME, args, { stdio: 'ignore' });
  try {
    const target = await waitForTarget();
    const ws = new WebSocket(target);
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    let id = 0;
    const waiters = new Map();
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
    });
    const send = (method, params = {}) => new Promise((res) => {
      const mid = ++id;
      waiters.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    const evaluate = async (expr, awaitPromise = true) => {
      const r = await send('Runtime.evaluate', {
        expression: expr, awaitPromise, returnByValue: true, userGesture: true,
      });
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
      return r.result?.result?.value;
    };
    await send('Runtime.enable');
    await send('Page.enable');
    // Navigate explicitly: the URL passed on the command line can land in a different
    // target than the one /json/list hands back first.
    await send('Page.navigate', { url });
    await new Promise((r) => setTimeout(r, 1500));
    const out = await fn({ evaluate, send });
    ws.close();
    return out;
  } finally {
    chrome.kill();
  }
}

async function waitForTarget() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('chrome debug target never appeared');
}
