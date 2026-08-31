// Arena: one life, two sites, first to seven rounds.
//
// Team 1 (ALPHA) attacks and team 2 (BRAVO) defends for the whole match. Any living
// attacker may plant; there is deliberately no invisible "bomb carrier" yet. Adding a
// carried/drop-able objective later is a content extension, while inventing one now would
// make the first playable version depend on a model, pickup wire and inventory slot it does
// not otherwise need.
//
// `ap` in state is a percentage, `bp` is the planted site number (1=A, 2=B), and `ak`
// is `p` or `d`. Those compact fields ride in a 20 Hz snapshot, so their names matter.

import * as C from '../../shared/constants.js';
import { OBJECTIVE_SITES } from '../../shared/map.js';
import { EV } from '../../shared/protocol.js';
import { createTdm } from './tdm.js';

const ROUND_OVER_MS = 5000;
const MATCH_OVER_MS = 8000;
const USE_SPEED = 0.35;

const REASON = Object.freeze({
  eliminated: 'elimination',
  detonated: 'detonated',
  defused: 'defused',
  time: 'time',
  draw: 'draw',
});

const inSite = (p, site) => Math.hypot(p.x - site.x, p.z - site.z) <= site.radius;

export function createArena(room) {
  // Reuse the already-tested side assignment, base spawns, friendly-fire gate and bot-only
  // rebalance. Its score/timer closure stays dormant because Arena supplies its own hooks.
  const teams = createTdm(room);
  const mode = room.mode;

  let phase = 'live';
  let round = 1;
  let score = [0, 0];
  let endsAt = mode.roundMs;
  let resetAt = 0;
  let winner = 0;
  let roundWinner = 0;
  let reason = '';
  let planted = null;
  let action = null;

  function clearWorld() {
    room.projectiles.length = 0;
    room.clouds.length = 0;
  }

  function alive(team) {
    let n = 0;
    for (const p of room.players.values()) if (p.alive && p.team === team) n++;
    return n;
  }

  function endMatch(now, team) {
    phase = 'over';
    winner = team;
    resetAt = now + MATCH_OVER_MS;
    action = null;
    room.settleMatch({ winnerTeam: team });
    room.events.push({ e: EV.MATCH, ph: phase, w: 0, wt: team });
  }

  function endRound(now, team, why) {
    if (phase !== 'live') return;
    roundWinner = team;
    reason = why;
    action = null;
    if (team) score[team - 1]++;
    if (team && score[team - 1] >= mode.winRounds) {
      endMatch(now, team);
      return;
    }
    phase = 'round_over';
    resetAt = now + ROUND_OVER_MS;
    room.events.push({ e: EV.MATCH, ph: phase, w: 0, wt: team, rr: why, rn: round });
  }

  function startRound(now) {
    phase = 'live';
    round++;
    roundWinner = 0;
    reason = '';
    planted = null;
    action = null;
    endsAt = now + mode.roundMs;
    clearWorld();
    for (const p of room.players.values()) {
      p.respawnAt = now;
      room.respawn(p);
    }
    room.events.push({ e: EV.MATCH, ph: phase, w: 0, rn: round });
  }

  function resetMatch(now) {
    phase = 'live';
    round = 1;
    score = [0, 0];
    winner = 0;
    roundWinner = 0;
    reason = '';
    planted = null;
    action = null;
    endsAt = now + mode.roundMs;
    clearWorld();
    room.beginProgressionMatch();
    for (const p of room.players.values()) {
      p.kills = 0;
      p.deaths = 0;
      p.respawnAt = now;
      room.respawn(p);
    }
    room.events.push({ e: EV.MATCH, ph: phase, w: 0, rn: round });
  }

  function eligible(p, kind, site, now) {
    if (!p?.alive || now > p.useUntil || !inSite(p, site)) return false;
    if (Math.hypot(p.vx, p.vz) > USE_SPEED) return false;
    return kind === 'p' ? p.team === 1 && !planted : p.team === 2 && planted?.site === site;
  }

  function objective(now) {
    const kind = planted ? 'd' : 'p';
    const sitePool = planted ? [planted.site] : OBJECTIVE_SITES;
    let actor = null;
    let site = null;
    // Preserve a valid holder before scanning for a new one. Otherwise a lower-id
    // teammate stepping onto the pad can reset somebody else's nearly complete use.
    if (action?.kind === kind) {
      const incumbent = room.players.get(action.actor);
      if (eligible(incumbent, kind, action.site, now)) {
        actor = incumbent;
        site = action.site;
      }
    }
    for (const p of room.players.values()) {
      if (actor) break;
      const found = sitePool.find((candidate) => eligible(p, kind, candidate, now));
      if (!found) continue;
      actor = p;
      site = found;
      break;
    }

    if (!actor) {
      action = null;
      return;
    }
    if (!action || action.kind !== kind || action.actor !== actor.id || action.site !== site) {
      action = { kind, actor: actor.id, site, startedAt: now };
      return;
    }

    const need = kind === 'p' ? mode.plantMs : mode.defuseMs;
    if (now - action.startedAt < need) return;
    room.creditObjective(actor.id);
    if (kind === 'p') {
      planted = { site, at: now, blowsAt: now + mode.fuseMs, by: actor.id };
      action = null;
    } else {
      endRound(now, 2, REASON.defused);
    }
  }

  function onKill(_room, killer, victim) {
    victim.deaths++;
    victim.respawnAt = Infinity;
    if (!killer || killer === victim || killer.team === victim.team) return;
    killer.kills++;
  }

  function tick() {
    const now = room.now();
    if (phase === 'over') {
      for (const p of room.players.values()) if (!p.alive) p.respawnAt = resetAt;
      if (now >= resetAt) resetMatch(now);
      return;
    }
    if (phase === 'round_over') {
      for (const p of room.players.values()) if (!p.alive) p.respawnAt = resetAt;
      if (now >= resetAt) startRound(now);
      return;
    }

    const attackers = alive(1);
    const defenders = alive(2);
    // Once the round clock reaches zero, a new plant cannot begin or complete. The fuse
    // replaces the round clock only after a plant has already succeeded.
    if (!planted && now >= endsAt) {
      endRound(now, 2, REASON.time);
      return;
    }

    objective(now);
    if (phase !== 'live') return;

    if (!attackers && !defenders && !planted) {
      endRound(now, 0, REASON.draw);
      return;
    }
    if (!defenders) {
      endRound(now, 1, REASON.eliminated);
      return;
    }
    // A planted charge remains live after the attackers die; defenders still have to
    // defuse it. Before the plant, eliminating every attacker ends the round immediately.
    if (!attackers && !planted) {
      endRound(now, 2, REASON.eliminated);
      return;
    }
    if (planted && now >= planted.blowsAt) {
      endRound(now, 1, REASON.detonated);
      return;
    }
  }

  function state() {
    const now = room.now();
    const deadline = phase === 'live'
      ? (planted?.blowsAt ?? endsAt)
      : resetAt;
    const md = {
      ar: 1,
      ph: phase,
      tl: Math.round(Math.max(0, deadline - now) / 1000),
      ts: score,
      rn: round,
      wr: mode.winRounds,
      w: 0,
    };
    if (winner) md.wt = winner;
    if (planted) md.bp = OBJECTIVE_SITES.indexOf(planted.site) + 1;
    if (roundWinner) md.rw = roundWinner;
    if (reason) md.rr = reason;
    if (action) {
      const need = action.kind === 'p' ? mode.plantMs : mode.defuseMs;
      md.ak = action.kind;
      md.ai = action.actor;
      md.as = OBJECTIVE_SITES.indexOf(action.site) + 1;
      md.ap = Math.min(100, Math.round(((now - action.startedAt) / need) * 100));
    }
    return md;
  }

  return {
    onJoin: teams.onJoin,
    spawnFor: teams.spawnFor,
    rebalance: teams.rebalance,
    canDamage(_room, attacker, victim) {
      return phase === 'live' && teams.canDamage(room, attacker, victim);
    },
    onKill,
    tick,
    state,
    botInput(_room, p, _now, input) {
      if (phase !== 'live') return input;
      const site = planted?.site ?? OBJECTIVE_SITES.find((candidate) => inSite(p, candidate));
      const shouldUse = site && ((p.team === 1 && !planted) || (p.team === 2 && planted));
      if (!shouldUse || !inSite(p, site)) return input;
      return {
        ...input,
        moveX: 0,
        moveZ: 0,
        buttons: input.buttons | C.BTN_USE,
      };
    },
  };
}
