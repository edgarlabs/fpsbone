// Signed lobby account requests. These load inventory and submit cosmetic concepts without
// opening a match WebSocket or consuming one of the region's twenty player seats.

export function accountOrigin(socketUrl, page = location.href) {
  try {
    const url = new URL(socketUrl, page);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    else if (url.protocol === 'wss:') url.protocol = 'https:';
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.origin;
  } catch { return null; }
}

export function createAccountClient({ origin, identity, fetcher = fetch } = {}) {
  if (!origin || !identity?.verified || typeof identity.prove !== 'function') return null;

  async function signed(purpose, path, extra = {}) {
    const challengeRes = await fetcher(
      `${origin}/api/account/challenge?purpose=${encodeURIComponent(purpose)}`,
      { cache: 'no-store' },
    );
    const challengeBody = await challengeRes.json().catch(() => ({}));
    if (!challengeRes.ok || typeof challengeBody.challenge !== 'string') {
      throw new Error(challengeBody.error ?? 'account_unavailable');
    }
    const auth = await identity.prove(challengeBody.challenge);
    const response = await fetcher(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        challenge: challengeBody.challenge,
        legacy: identity.legacy ?? undefined,
        auth,
        ...extra,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? 'account_request_failed');
    return body;
  }

  return {
    profile: () => signed('profile', '/api/account/profile'),
    equip: (finish) => signed('equip', '/api/account/equip', { finish }),
    submit: (submission) => signed('submit', '/api/account/submissions', { submission }),
  };
}
