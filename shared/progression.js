// Account progression, shared by the match server and every client surface that draws it.
//
// Career badges still count the things a player actually did with each weapon. Rank is a
// different question now: long-term account XP, settled once when a match ends. Keeping the
// formula here means a results screen can explain the exact award without recreating server
// arithmetic, while the server remains the only side allowed to decide the inputs.

import { MAX_TIER, TIERS } from './ranks.js';

/** Existing rank pacing translated from one career kill to one hundred XP. */
export const XP_PER_LEGACY_KILL = 100;
export const XP_TIERS = Object.freeze(TIERS.map((tier) => Object.freeze({
  ...tier,
  at: tier.at * XP_PER_LEGACY_KILL,
})));

export const XP_RULES = Object.freeze({
  participation: 50,
  humanKill: 100,
  humanHeadshot: 20,
  botKill: 25,
  botHeadshot: 5,
  botCap: 250,
  assist: 40,
  objective: 100,
  win: 150,
  /** Standing in a room without playing should not become progression. */
  minParticipationSec: 30,
});

const whole = (value) => Math.max(0, Math.floor(Number(value) || 0));

export function rankOfXp(value) {
  const xp = whole(value);
  for (let i = MAX_TIER; i > 0; i--) if (xp >= XP_TIERS[i].at) return i;
  return 0;
}

export function toNextRankXp(value) {
  const xp = whole(value);
  const next = rankOfXp(xp) + 1;
  return next > MAX_TIER ? 0 : XP_TIERS[next].at - xp;
}

/**
 * Explain one authoritative match award.
 *
 * `participated` is decided by the Room from server time and combat events. The client never
 * sends it, and passing false zeroes the whole award so idling cannot collect the win bonus.
 * Bot contribution includes its headshot bonus inside the same cap; otherwise repeatedly
 * headshotting AI would be an easy way around the farming limit.
 */
export function matchXp(input = {}) {
  const participated = input.participated === true;
  const humanKills = whole(input.humanKills);
  const botKills = whole(input.botKills);
  const humanHeadshots = Math.min(humanKills, whole(input.humanHeadshots));
  const botHeadshots = Math.min(botKills, whole(input.botHeadshots));
  const assistsCount = whole(input.assists);
  const objectivesCount = whole(input.objectives);
  const participation = participated ? XP_RULES.participation : 0;
  const humans = participated
    ? humanKills * XP_RULES.humanKill + humanHeadshots * XP_RULES.humanHeadshot
    : 0;
  const botsRaw = participated
    ? botKills * XP_RULES.botKill + botHeadshots * XP_RULES.botHeadshot
    : 0;
  const bots = Math.min(XP_RULES.botCap, botsRaw);
  const assists = participated ? assistsCount * XP_RULES.assist : 0;
  const objectives = participated ? objectivesCount * XP_RULES.objective : 0;
  const win = participated && input.won === true ? XP_RULES.win : 0;
  return Object.freeze({
    participation,
    humans,
    bots,
    botXpDiscarded: Math.max(0, botsRaw - bots),
    assists,
    objectives,
    win,
    total: participation + humans + bots + assists + objectives + win,
  });
}

export function emptyStats() {
  return {
    matches: 0,
    wins: 0,
    kills: 0,
    deaths: 0,
    headshots: 0,
    humanKills: 0,
    botKills: 0,
    assists: 0,
    objectives: 0,
  };
}

export function cleanStats(value = {}) {
  const out = emptyStats();
  for (const key of Object.keys(out)) out[key] = whole(value?.[key]);
  return out;
}
