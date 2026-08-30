// Single-use authentication for lobby account requests.
//
// WebSocket admission already proves device ownership, but inventory must load before a
// player consumes a match seat. This gives ordinary HTTP requests the same proof: obtain a
// fresh purpose-bound nonce, sign it with the browser's device key, and consume it once.

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { verifyDeviceIdentity } from './identity.js';

export const ACCOUNT_PURPOSES = Object.freeze(['profile', 'equip', 'submit']);
const TTL_MS = 60_000;
const MAX_CHALLENGES = 2048;

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
};

export function createAccountGateway({
  ranks,
  adminToken = '',
  now = () => Date.now(),
  makeToken = randomUUID,
} = {}) {
  const challenges = new Map();

  function sweep(at = now()) {
    for (const [nonce, record] of challenges) {
      if (record.expires <= at) challenges.delete(nonce);
    }
    while (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value);
  }

  function issue(purpose) {
    if (!ACCOUNT_PURPOSES.includes(purpose)) return null;
    sweep();
    const challenge = makeToken();
    const expires = now() + TTL_MS;
    challenges.set(challenge, { purpose, expires });
    return { challenge, expires };
  }

  async function authenticate(purpose, body) {
    const nonce = typeof body?.challenge === 'string' ? body.challenge : '';
    const record = challenges.get(nonce);
    challenges.delete(nonce); // every attempt consumes it, including a forged one
    if (!record || record.expires <= now() || record.purpose !== purpose) {
      throw new Error('challenge_invalid');
    }
    const identity = verifyDeviceIdentity(body, nonce);
    if (!identity?.id) throw new Error('identity_required');
    if (identity.legacy) await ranks.claimLegacy?.(identity.legacy, identity.id);
    return identity;
  }

  function isAdmin(header) {
    if (!adminToken) return false;
    const value = String(header ?? '').replace(/^Bearer\s+/i, '');
    return safeEqual(value, adminToken);
  }

  return {
    issue,
    authenticate,
    isAdmin,
    get pending() { return challenges.size; },
    get reviewEnabled() { return Boolean(adminToken); },
  };
}
