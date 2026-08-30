// Approved display-only cosmetics shared by the browser and the authoritative host.
//
// A client may ASK for one of these ids. It cannot send colours, materials, damage,
// rarity or ownership claims: the host reduces the request back to this allow-list and
// the renderer looks the id up again locally. Future community/NFT finishes enter here
// only after review.

export const DEFAULT_FINISH = 'standard';

export const FINISHES = Object.freeze({
  standard: Object.freeze({
    label: 'STANDARD ISSUE',
    blurb: 'Factory gunmetal with unit-green furniture.',
    rarity: 'issued',
    source: 'base',
    issued: true,
    approved: true,
    steel: 0x3a4351,
    dark: 0x252c38,
    trim: 0x357e69,
  }),
  foundry: Object.freeze({
    label: 'FOUNDRY SIGNAL',
    blurb: 'Heat-darkened steel with hazard-orange controls.',
    rarity: 'field',
    source: 'base',
    issued: true,
    approved: true,
    steel: 0x35434a,
    dark: 0x171f24,
    trim: 0xd07726,
  }),
  arctic: Object.freeze({
    label: 'ARCTIC GRID',
    blurb: 'Cold ceramic panels over a graphite frame.',
    rarity: 'field',
    source: 'base',
    issued: true,
    approved: true,
    steel: 0x7793a2,
    dark: 0x273943,
    trim: 0x82d6dc,
  }),
  ember: Object.freeze({
    label: 'EMBER PROTOCOL',
    blurb: 'Charred alloy with a hot rescue-orange signal line.',
    rarity: 'promotional',
    source: 'promo',
    issued: false,
    approved: true,
    steel: 0x563832,
    dark: 0x211919,
    trim: 0xff754f,
  }),
  nightshift: Object.freeze({
    label: 'NIGHT SHIFT',
    blurb: 'Deep indigo plates with a restrained violet identification strip.',
    rarity: 'promotional',
    source: 'promo',
    issued: false,
    approved: true,
    steel: 0x303955,
    dark: 0x121725,
    trim: 0x9579ff,
  }),
});

export const FINISH_IDS = Object.freeze(Object.keys(FINISHES));
export const ISSUED_FINISH_IDS = Object.freeze(
  FINISH_IDS.filter((id) => FINISHES[id].approved && FINISHES[id].issued),
);

export function finishOf(id) {
  return typeof id === 'string' && Object.hasOwn(FINISHES, id)
    ? FINISHES[id]
    : FINISHES[DEFAULT_FINISH];
}

/** Reduce an untrusted saved/HELLO cosmetic object to approved ids only. */
export function sanitizeCosmetics(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const id = typeof raw.finish === 'string' ? raw.finish : DEFAULT_FINISH;
  if (!Object.hasOwn(FINISHES, id) || id === DEFAULT_FINISH) return {};
  return { finish: id };
}

/** Approved ids an account owns. Issued finishes are always present; grants only add. */
export function sanitizeInventory(raw) {
  const owned = new Set(ISSUED_FINISH_IDS);
  if (Array.isArray(raw)) {
    for (const id of raw) {
      if (typeof id === 'string' && FINISHES[id]?.approved) owned.add(id);
    }
  }
  return FINISH_IDS.filter((id) => owned.has(id));
}

/** Apply catalog approval and account ownership together. Standard issue stays `{}`. */
export function sanitizeOwnedCosmetics(raw, inventory) {
  const clean = sanitizeCosmetics(raw);
  const id = clean.finish ?? DEFAULT_FINISH;
  const owned = new Set(sanitizeInventory(inventory));
  return id !== DEFAULT_FINISH && owned.has(id) ? { finish: id } : {};
}
