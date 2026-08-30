// Signed device identities for the public host.
//
// The browser owns a P-256 keypair. Every socket receives a fresh challenge and signs
// that challenge together with the legacy account it wants migrated. The account id is
// derived from the public key; no client-supplied storage key is ever trusted again.

import { createHash, createPublicKey, verify } from 'node:crypto';

const B64URL = /^[A-Za-z0-9_-]+$/;
const LEGACY = /^local-[a-z0-9]{6,24}$/;

export function deviceAccountId(publicKey) {
  const der = Buffer.from(publicKey, 'base64url');
  return `device-${createHash('sha256').update(der).digest('base64url').slice(0, 32)}`;
}

export function proofText(challenge, legacy = '') {
  return `${challenge}\n${legacy}`;
}

/** Return a verified identity, null for an unsigned guest, and throw for a forged proof. */
export function verifyDeviceIdentity(message, challenge) {
  const auth = message?.auth;
  if (!auth) return null;
  if (auth.v !== 1 || auth.alg !== 'ES256'
      || typeof auth.key !== 'string' || auth.key.length < 80 || auth.key.length > 256
      || typeof auth.sig !== 'string' || auth.sig.length < 64 || auth.sig.length > 160
      || !B64URL.test(auth.key) || !B64URL.test(auth.sig)) {
    throw new Error('bad_identity_shape');
  }
  const legacy = typeof message.legacy === 'string' && LEGACY.test(message.legacy)
    ? message.legacy
    : '';
  try {
    const signature = Buffer.from(auth.sig, 'base64url');
    if (signature.length !== 64) throw new Error('bad_identity_signature');
    const key = createPublicKey({
      key: Buffer.from(auth.key, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    if (key.asymmetricKeyType !== 'ec'
        || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('bad_identity_key');
    }
    const valid = verify(
      'sha256',
      Buffer.from(proofText(challenge, legacy)),
      { key, dsaEncoding: 'ieee-p1363' },
      signature,
    );
    if (!valid) throw new Error('bad_identity_signature');
    return { id: deviceAccountId(auth.key), legacy: legacy || null, type: 'device' };
  } catch (err) {
    if (err?.message === 'bad_identity_signature') throw err;
    throw new Error('bad_identity_key');
  }
}
