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
    approved: true,
    steel: 0x7793a2,
    dark: 0x273943,
    trim: 0x82d6dc,
  }),
});

export const FINISH_IDS = Object.freeze(Object.keys(FINISHES));

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

