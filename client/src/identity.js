// ─────────────────────────────────────────────────────────────────────────────
// THE WEB3 SEAM.
//
// Nothing else in the codebase knows where identity comes from. Today it's a
// random id kept in localStorage. Later this returns a wallet address plus a
// signature the server can verify, and `cosmetics` becomes on-chain token
// ownership — with no changes to game, render, or network code.
//
// The server already treats `cosmetics` as untrusted display-only data, so
// introducing a real chain read is additive: verify the signature, then start
// trusting the field.
// ─────────────────────────────────────────────────────────────────────────────

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

  try {
    localStorage.setItem(KEY, JSON.stringify(identity));
  } catch {
    // private browsing / storage disabled — a per-session identity is fine
  }

  return identity;
}
