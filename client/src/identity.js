// ─────────────────────────────────────────────────────────────────────────────
// THE WEB3 SEAM.
//
// Nothing else in the codebase knows where identity comes from. Today it's a
// random id kept in localStorage. Later this can return a wallet address plus a
// signature the server verifies, and `cosmetics` can be derived from ownership.
//
// The server already treats `cosmetics` as untrusted display-only data, so
// introducing a real chain read is additive: verify the signature, resolve an approved
// catalog id, and keep the server allow-list as the final authority.
// ─────────────────────────────────────────────────────────────────────────────

import { sanitizeCosmetics } from '../../shared/cosmetics.js';

const KEY = 'fpsbone.identity';

export function getIdentity() {
  const override = new URLSearchParams(location.search).get('name');

  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    // corrupt entry — fall through and mint a fresh one
  }

  const identity = saved?.id
    ? saved
    : {
        id: `local-${Math.random().toString(36).slice(2, 10)}`,
        displayName: `player${Math.floor(100 + Math.random() * 900)}`,
        cosmetics: {},
      };

  if (override) identity.displayName = override.slice(0, 16);
  identity.cosmetics = sanitizeCosmetics(identity.cosmetics);

  try {
    localStorage.setItem(KEY, JSON.stringify(identity));
  } catch {
    // private browsing / storage disabled — a per-session identity is fine
  }

  return identity;
}

/** Save an approved cosmetic selection on this device and mutate the live identity. */
export function setIdentityCosmetics(identity, next) {
  identity.cosmetics = sanitizeCosmetics(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(identity));
  } catch {
    // The current session still gets the selection when persistence is unavailable.
  }
  return identity.cosmetics;
}
