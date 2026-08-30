// Free-for-all controller. Backs `dm`, `sniper` and `snow` — those three differ
// only in loadout, respawn delay and score target, all of which are data in
// shared/modes.js. Nothing here reads the mode id.
//
// A match runs `live` until someone reaches killLimit or the clock expires, spends
// a few seconds in `over` showing final scores, then resets and starts again. A
// server that stops playing when the timer runs out is a server nobody can rejoin.

import { EV } from '../../shared/protocol.js';

const OVER_MS = 8000;

export function createFfa(room) {
  const mode = room.mode;

  let phase = 'live';
  let endsAt = mode.timeMs;
  let resetAt = 0;
  let winner = 0;

  function leader() {
    let best = null;
    for (const p of room.players.values()) {
      if (!best || p.kills > best.kills || (p.kills === best.kills && p.deaths < best.deaths)) {
        best = p;
      }
    }
    return best;
  }

  function finish(now) {
    phase = 'over';
    winner = leader()?.id ?? 0;
    resetAt = now + OVER_MS;
    room.settleMatch({ winnerId: winner });
    room.events.push({ e: EV.MATCH, ph: phase, w: winner });
  }

  function reset(now) {
    for (const p of room.players.values()) {
      p.kills = 0;
      p.deaths = 0;
      // Everyone comes back at once, so nobody spends the first seconds of a fresh
      // match dead because of when they happened to die in the last one.
      p.respawnAt = now;
    }
    phase = 'live';
    winner = 0;
    endsAt = now + mode.timeMs;
    room.beginProgressionMatch();
    room.events.push({ e: EV.MATCH, ph: phase, w: 0 });
  }

  return {
    onJoin(_room, p) {
      // No teams. Loadout is whatever the client asked for, already filtered
      // against mode.loadout by Room.
      p.team = 0;
    },

    onKill(_room, killer, victim) {
      const now = room.now();
      // Self-damage has no killer, and a killer must not be credited for a victim
      // who shot themselves — projectiles in M6 make that reachable.
      if (killer && killer !== victim) killer.kills++;
      victim.deaths++;
      victim.respawnAt = now + mode.respawnMs;

      if (phase === 'live' && killer && killer.kills >= mode.killLimit) finish(now);
    },

    tick() {
      const now = room.now();
      if (phase === 'live') {
        if (now >= endsAt) finish(now);
        return;
      }
      // `over`: bodies stay down. Holding respawnAt in the future stops Room from
      // reviving anyone into a match that has already been decided.
      for (const p of room.players.values()) {
        if (!p.alive) p.respawnAt = resetAt;
      }
      if (now >= resetAt) reset(now);
    },

    state() {
      const left = Math.max(0, (phase === 'live' ? endsAt : resetAt) - room.now());
      return {
        ph: phase,
        // Seconds, not milliseconds: the HUD shows m:ss, and this rides in every
        // snapshot at 20 Hz.
        tl: Math.round(left / 1000),
        kl: mode.killLimit,
        w: winner,
      };
    },
  };
}
