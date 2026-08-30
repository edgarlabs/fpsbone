// Team deathmatch. Two sides of five, spawning in their own base, scoring as a team.
//
// The shape is deliberately the free-for-all controller's — a `live` match that ends on
// a score target or the clock, a few seconds of `over` showing the result, then a reset
// and another one — because a server that stops playing when the timer runs out is a
// server nobody can rejoin. What differs is everything that follows from having sides:
// who you spawn near, who you can shoot, and whose number goes up when you kill someone.
//
// TEAMS ARE 1 AND 2, never 0. Zero means "no team" and is what a free-for-all player
// carries, so it is not usable as an index — `TEAM_SPAWNS` and `score` are both indexed
// by team MINUS ONE, and every read of them goes through that.
//
// Bots need no special handling anywhere in here, and that is the point of assigning
// teams in `onJoin`: a bot reaches this file through `Room.addBot` -> `Room.add` -> the
// same hook a human arrives through, so it gets a side and a base spawn from the same
// code. The one thing bots do get is `rebalance` below, which is allowed to move them
// because they are the only bodies in the room that can be moved without wronging anyone.

import { EV } from '../../shared/protocol.js';
import { TEAM_SPAWNS } from '../../shared/map.js';

const OVER_MS = 8000;

/** Guard on the rebalance loop. Each pass moves one bot and re-counts, so a ten-slot
 *  room converges in a handful of passes; this exists only so that a future bug in the
 *  counting cannot turn a join into an infinite loop inside the tick. */
const MAX_SHUFFLE = 16;

export function createTdm(room) {
  const mode = room.mode;

  let phase = 'live';
  let endsAt = mode.timeMs;
  let resetAt = 0;
  /** Team scores, indexed by team - 1. A TEAM total, not a personal one: `mode.killLimit`
   *  is 50 for tdm precisely because it is measured against this rather than against any
   *  single player's tally. */
  let score = [0, 0];
  /** The winning TEAM, or 0 for a draw or a match still running. Not a player id — see
   *  the note on `w` in `state()` for why the two must never share a field. */
  let winner = 0;

  /**
   * Two counts per side: every body on it, and how many of those are people.
   *
   * Indexed by team - 1, and skipping team 0 — which is what excludes the player currently
   * arriving, since `onJoin` runs before their team is set. So this is always a count of
   * everyone ALREADY placed.
   */
  function census() {
    const bodies = [0, 0];
    const humans = [0, 0];
    for (const p of room.players.values()) {
      if (p.team !== 1 && p.team !== 2) continue;
      bodies[p.team - 1]++;
      if (!room.bots.has(p.id)) humans[p.team - 1]++;
    }
    return { bodies, humans };
  }

  /**
   * Which side this player joins.
   *
   * A PERSON GOES WHERE THE FEWEST PEOPLE ARE. A bot goes where the fewest bodies are.
   * Those are different counts on purpose, and getting it wrong is a bug this mode
   * actually had: balancing everyone on bodies alone kept the sides numerically even while
   * putting every human on one of them — five humans against five bots at five players,
   * and then jammed at 6v4 from six players on, because by then the crowded side held no
   * bot for `rebalance` to move away. Spreading PEOPLE first is what makes a filling
   * deathmatch turn into humans-versus-humans instead of everyone-versus-the-bots.
   *
   * The tie-breaks, in order: bodies, so a side that is a body down gets the next one; then
   * team 1, so the first join into an empty room is deterministic rather than arbitrary.
   */
  function sideFor(p) {
    const { bodies, humans } = census();
    // `room.bots` holds this id already if it is a bot — Room.add registers it before
    // calling this hook, for exactly this line. See the note on `isBot` in server/room.js.
    const key = room.bots.has(p.id) ? bodies : humans;
    if (key[0] !== key[1]) return key[0] < key[1] ? 1 : 2;
    if (bodies[0] !== bodies[1]) return bodies[0] < bodies[1] ? 1 : 2;
    return 1;
  }

  function finish(now) {
    phase = 'over';
    winner = score[0] === score[1] ? 0 : score[0] > score[1] ? 1 : 2;
    resetAt = now + OVER_MS;
    room.settleMatch({ winnerTeam: winner });
    // `w` is a player id in every other mode's MATCH event and the client resolves it to
    // a name, so the winning TEAM travels as its own field and `w` stays 0. A team number
    // in there would render as "player #2 wins".
    room.events.push({ e: EV.MATCH, ph: phase, w: 0, wt: winner });
  }

  function reset(now) {
    for (const p of room.players.values()) {
      p.kills = 0;
      p.deaths = 0;
      // Everyone comes back at once, so nobody spends the first seconds of a fresh match
      // dead because of when they happened to die in the last one.
      p.respawnAt = now;
    }
    score = [0, 0];
    phase = 'live';
    winner = 0;
    endsAt = now + mode.timeMs;
    room.beginProgressionMatch();
    room.events.push({ e: EV.MATCH, ph: phase, w: 0 });
  }

  return {
    onJoin(_room, p) {
      p.team = sideFor(p);
      // `Room.add` picked a spawn from the WHOLE map a moment ago, because it runs before
      // any controller has had a say and has no way to know a team was coming. Put this
      // player where their side actually spawns.
      //
      // It has to happen HERE rather than being left to the first respawn: `add` pushes
      // the EV.SPAWN event on the line after this hook returns, so a player who is not
      // moved now is a player who genuinely started the match in the enemy base.
      const s = room.pickSpawn(TEAM_SPAWNS[p.team - 1]);
      p.x = s.x;
      p.y = s.y;
      p.z = s.z;
      p.yaw = s.yaw;
    },

    /** Base spawn — the same furthest-from-trouble pick every mode makes, restricted to
     *  this player's own half of the map. */
    spawnFor(_room, p) {
      const base = TEAM_SPAWNS[p.team - 1];
      // A team with no base falls back to the whole map rather than throwing inside the
      // respawn path. Unreachable while teams are 1 and 2, which is why it is a fallback
      // and not a check that reports an error.
      return room.pickSpawn(base ?? undefined);
    },

    /**
     * Friendly fire is off.
     *
     * Self-damage is NOT friendly fire and stays on: a grenade at your own feet has to
     * kill you, or the mode teaches players that the safest place to throw one is
     * straight down. `atk === vic` covers that, and a null attacker — world damage with
     * nobody behind it — is let through for the same reason.
     *
     * Read by more than the shot path: server/ai.js gates its target picking on this, so
     * turning friendly fire off here is also what stops bots aiming at their own side.
     */
    canDamage(_room, atk, vic) {
      if (!atk || atk === vic) return true;
      return atk.team !== vic.team;
    },

    onKill(_room, killer, victim) {
      const now = room.now();
      victim.deaths++;
      victim.respawnAt = now + mode.respawnMs;

      // Nothing is credited for a suicide, and nothing for a team kill. `canDamage`
      // already refuses same-team damage, so that second case is reachable only if a
      // rebalance moved one of the two while a projectile was in the air — rare, and
      // cheaper to rule out with a comparison than to reason about.
      if (!killer || killer === victim || killer.team === victim.team) return;

      killer.kills++;
      score[killer.team - 1]++;

      if (phase === 'live' && score[killer.team - 1] >= mode.killLimit) finish(now);
    },

    /**
     * Even the sides out after the room's population changed.
     *
     * WHY THIS IS NEEDED. `sideFor` balances each join on its own, but it balances a human
     * on the HUMAN counts, which is not always the thinner side in bodies — and the
     * backfill in server/index.js then gives a slot back by dropping the newest bot, which
     * knows nothing about teams. Between the two, a join can leave the room at 6v4. This is
     * what turns that back into 5v5.
     *
     * ONLY BOTS MOVE. A human who suddenly finds themselves shooting at the four people
     * they spent the last minute covering has been handed a bug, not a fair match — so an
     * imbalance the bots cannot absorb is left standing. That is reachable only in a
     * lopsided all-human room, which is the players' own arrangement to sort out.
     */
    rebalance() {
      for (let pass = 0; pass < MAX_SHUFFLE; pass++) {
        const { bodies } = census();
        const diff = bodies[0] - bodies[1];
        // A difference of one means an odd number of bodies, which cannot be evened.
        if (Math.abs(diff) < 2) return;

        const from = diff > 0 ? 1 : 2;
        const to = diff > 0 ? 2 : 1;

        // The newest bot on the crowded side, newest for the same reason `setBots` removes
        // newest-first: it is the body that has been in the fight the least, so moving it
        // disturbs the match the least. `room.bots` is insertion-ordered.
        let move = null;
        for (const id of room.bots) {
          const b = room.players.get(id);
          if (b && b.team === from) move = b;
        }
        // Nothing movable on the crowded side. See the note above: humans stay put.
        if (!move) return;

        move.team = to;
        // A living bot is now standing in what just became enemy ground, so put it in its
        // new base immediately. A dead one needs nothing — `spawnFor` reads the new team
        // when its respawn comes due — and reviving it here would pull a body out of the
        // victory screen mid-`over`.
        if (move.alive) room.respawn(move);
      }
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
        // Seconds, not milliseconds: the HUD shows m:ss, and this rides in every snapshot
        // at 20 Hz.
        tl: Math.round(left / 1000),
        kl: mode.killLimit,
        // Zero, always, and deliberately. Every other mode puts a winning PLAYER ID here
        // and the client turns it into a name; teams are numbered 1 and 2, which are also
        // the first two player ids ever handed out, so a team in this field would render
        // as the name of whoever joined first.
        w: 0,
        /** Team scores as `[team1, team2]` — what `kl` above is measured against. */
        ts: score,
        /** The winning side, omitted while there isn't one. The same omit-when-zero rule
         *  the snapshot uses for spawn protection and jams. */
        ...(winner ? { wt: winner } : {}),
      };
    },
  };
}
