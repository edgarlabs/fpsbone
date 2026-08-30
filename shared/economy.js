// Closed alpha economy. Credits are earned only from an authoritative match receipt and
// spent only by the account service. They have no cash value, cannot be transferred, and
// are deliberately unrelated to XP so balance changes remain auditable.

export const STARTER_CREDITS = 200;

export const CREDIT_RULES = Object.freeze({
  participation: 10,
  humanKill: 5,
  botKill: 1,
  botCap: 10,
  assist: 2,
  objective: 5,
  win: 10,
});

export const MARKET_ITEMS = Object.freeze({
  ember: Object.freeze({
    finish: 'ember', price: 150, creator: null, royaltyBps: 0,
    transferable: false, provenance: 'approved_catalog',
  }),
  nightshift: Object.freeze({
    finish: 'nightshift', price: 240, creator: null, royaltyBps: 0,
    transferable: false, provenance: 'approved_catalog',
  }),
});

const whole = (value) => Math.max(0, Math.floor(Number(value) || 0));

/** Currency receipt derived from the same server-owned facts as XP. */
export function matchCredits(result = {}) {
  if (result.participated !== true) return Object.freeze({
    participation: 0, humans: 0, bots: 0, assists: 0, objectives: 0, win: 0, total: 0,
  });
  const match = result.match ?? result;
  const participation = CREDIT_RULES.participation;
  const humans = whole(match.humanKills) * CREDIT_RULES.humanKill;
  const bots = Math.min(CREDIT_RULES.botCap, whole(match.botKills) * CREDIT_RULES.botKill);
  const assists = whole(match.assists) * CREDIT_RULES.assist;
  const objectives = whole(match.objectives) * CREDIT_RULES.objective;
  const win = result.won === true ? CREDIT_RULES.win : 0;
  return Object.freeze({
    participation, humans, bots, assists, objectives, win,
    total: participation + humans + bots + assists + objectives + win,
  });
}

export function marketItem(id) {
  return typeof id === 'string' ? MARKET_ITEMS[id] ?? null : null;
}

export function publicMarket(inventory = []) {
  const owned = new Set(Array.isArray(inventory) ? inventory : []);
  return Object.values(MARKET_ITEMS).map((item) => ({ ...item, owned: owned.has(item.finish) }));
}
