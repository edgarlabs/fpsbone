// Passwordless signed device identity.
//
// A P-256 private key stays in this browser. The public key derives the account id and a
// fresh server challenge is signed on every connection, so the id is proof rather than a
// string somebody can copy into a modified HELLO. A recovery code is the same keypair in
// portable form; whoever has it owns the account, which is why the UI treats it like a
// password and never displays it until asked.

import { sanitizeCosmetics } from '../../shared/cosmetics.js';

const KEY = 'fpsbone.identity';
const RECOVERY_PREFIX = 'FPSB1.';
const CURVE = { name: 'ECDSA', namedCurve: 'P-256' };

const bytesToUrl = (bytes) => {
  let raw = '';
  for (const b of new Uint8Array(bytes)) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const urlToBytes = (text) => {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

async function accountId(publicKey) {
  const digest = await crypto.subtle.digest('SHA-256', urlToBytes(publicKey));
  return `device-${bytesToUrl(digest).slice(0, 32)}`;
}

const proofText = (challenge, legacy = '') => `${challenge}\n${legacy}`;

async function importPair(keys) {
  if (!keys || typeof keys.pub !== 'string' || typeof keys.priv !== 'string') throw new Error('bad_keys');
  const publicKey = await crypto.subtle.importKey('spki', urlToBytes(keys.pub), CURVE, true, ['verify']);
  const privateKey = await crypto.subtle.importKey('pkcs8', urlToBytes(keys.priv), CURVE, true, ['sign']);
  const test = new TextEncoder().encode('fpsbone identity check');
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, test);
  if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, test)) {
    throw new Error('key_mismatch');
  }
  return { publicKey, privateKey };
}

async function mintKeys() {
  const pair = await crypto.subtle.generateKey(CURVE, true, ['sign', 'verify']);
  return {
    pub: bytesToUrl(await crypto.subtle.exportKey('spki', pair.publicKey)),
    priv: bytesToUrl(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
  };
}

function storedShape(identity) {
  return {
    id: identity.id,
    legacy: identity.legacy ?? null,
    displayName: identity.displayName,
    cosmetics: sanitizeCosmetics(identity.cosmetics),
    keys: identity.keys,
  };
}

function persist(identity) {
  try { localStorage.setItem(KEY, JSON.stringify(storedShape(identity))); } catch {
    // Private browsing / disabled storage leaves a signed identity for this session only.
  }
}

export async function getIdentity() {
  const override = new URLSearchParams(location.search).get('name');
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { /* mint below */ }

  const displayName = (override || saved?.displayName
    || `player${Math.floor(100 + Math.random() * 900)}`).slice(0, 16);
  const cosmetics = sanitizeCosmetics(saved?.cosmetics);

  if (!globalThis.crypto?.subtle) {
    return {
      id: saved?.id ?? `local-${Math.random().toString(36).slice(2, 10)}`,
      legacy: null,
      displayName,
      cosmetics,
      keys: null,
      verified: false,
      prove: null,
    };
  }

  let keys = saved?.keys;
  try { await importPair(keys); } catch { keys = await mintKeys(); }
  const id = await accountId(keys.pub);
  // First signed launch carries the old Phase-5 id once. The server moves that ledger to
  // the derived id and deletes the bearer-keyed row, so the bridge closes behind itself.
  const legacy = /^local-[a-z0-9]{6,24}$/.test(saved?.legacy ?? '')
    ? saved.legacy
    : /^local-[a-z0-9]{6,24}$/.test(saved?.id ?? '') ? saved.id : null;
  const pair = await importPair(keys);
  const identity = {
    id,
    legacy,
    displayName,
    cosmetics,
    keys,
    verified: true,
    async prove(challenge) {
      if (typeof challenge !== 'string' || !challenge) throw new Error('bad_challenge');
      const data = new TextEncoder().encode(proofText(challenge, legacy ?? ''));
      const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, data);
      return { v: 1, alg: 'ES256', key: keys.pub, sig: bytesToUrl(sig) };
    },
  };
  persist(identity);
  return identity;
}

export function setIdentityCosmetics(identity, next) {
  identity.cosmetics = sanitizeCosmetics(next);
  persist(identity);
  return identity.cosmetics;
}

/** Portable account ownership. Treat the returned code exactly like a password. */
export function exportRecoveryCode(identity) {
  if (!identity?.verified || !identity.keys) return null;
  const payload = new TextEncoder().encode(JSON.stringify({ v: 1, ...identity.keys }));
  return `${RECOVERY_PREFIX}${bytesToUrl(payload)}`;
}

/** Validate a recovery keypair, install it, and return the recovered account id. */
export async function importRecoveryCode(code, current = {}) {
  if (typeof code !== 'string' || !code.trim().startsWith(RECOVERY_PREFIX)) throw new Error('bad_recovery');
  if (code.trim().length > 4096) throw new Error('bad_recovery');
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(urlToBytes(code.trim().slice(RECOVERY_PREFIX.length))));
  } catch { throw new Error('bad_recovery'); }
  if (payload?.v !== 1) throw new Error('bad_recovery');
  const keys = { pub: payload.pub, priv: payload.priv };
  await importPair(keys);
  const identity = {
    id: await accountId(keys.pub),
    legacy: null,
    displayName: current.displayName ?? 'player',
    cosmetics: sanitizeCosmetics(current.cosmetics),
    keys,
  };
  persist(identity);
  return identity.id;
}
