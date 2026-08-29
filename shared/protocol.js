// Wire format. JSON for now — inspectable in devtools, and at 20 Hz × 8 players the
// bandwidth is irrelevant. This module is the single seam to swap in a packed
// DataView encoding if player counts ever make that matter.

export const MSG = {
  HELLO: 'hello', // C→S  identity handshake
  WELCOME: 'welcome', // S→C  assigned id + tick offset
  INPUT: 'input', // C→S  a batch of recent inputs
  SNAPSHOT: 'snap', // S→C  authoritative world state
  EVENT: 'event', // S→C  discrete things: shots, hits, kills
  /**
   * S→C  how full every lobby is: `{ rooms: { dm: 3, tdm: 7, ... } }`, humans only.
   *
   *  THERE IS NO CLIENT MESSAGE FOR THE BOT COUNT ANY MORE, and that is the point of
   *  this one. Bots are not a preference a player sets, they are whatever is left over
   *  after the humans in a fixed number of slots — so the server decides it alone and
   *  the client is told about occupancy instead of asking for a population.
   *
   *  Pushed to EVERY connected client whenever anyone joins or leaves ANY room, not just
   *  the sender's own: the menu greys out a lobby that is already full, so a client
   *  sitting in deathmatch needs to know that team DM filled up while it was reading the
   *  keybinds. Rare enough to send unprompted — it moves on a join or a drop, thousands
   *  of ticks apart, never per tick.
   *
   *  The initial state rides on WELCOME as `lob` rather than arriving as one of these,
   *  so a client that has only just handshaken is never briefly showing every lobby as
   *  empty. Same shape, so one handler reads both. */
  LOBBY: 'lobby',
  /**
   * S->C  who is in YOUR room and what they are wearing on their sleeve:
   * `{ players: [{ i, n, rk, bg }] }`, everyone in the room, bots included.
   *
   * A SECOND LIST OF PLAYERS, and the split is by RATE rather than by subject. The
   * snapshot carries what changes every tick — position, health, score, ping — and is
   * built and encoded twenty times a second. A name, a rank and a badge shelf change a
   * handful of times per career, and putting them in the snapshot would mean paying for
   * twelve badge tiers per player per tick to send the same bytes over and over. So they
   * ride here, pushed on the edges that can move them: a join, a drop, and a kill that
   * promotes somebody.
   *
   * Rank rides in BOTH, and that is deliberate rather than an oversight — `rk` was in the
   * snapshot before this message existed, the nameplate over a body reads it there, and
   * moving it would cost a frame of a blank rank on every join for nothing. This carries
   * it too so the scoreboard has one row shape to render whether or not a snapshot has
   * landed yet.
   *
   * TIERS, NEVER COUNTS. `bg` is `{ track: tier }` for the tracks a player has actually
   * earned an emblem on — the same public/private line the snapshot's `rk` draws against
   * the private `cv` and `bd`. What you have shot over a career is yours; the metal on
   * your sleeve is what the room can see.
   *
   * NO BOT FLAG, for the reason room.js gives at BOT_NAMES: the moment one goes on the
   * wire, somebody writes a client that outlines the humans. Bots appear here exactly as
   * people do, prefixed name and all, and they carry a seeded ping in the snapshot for
   * the same reason — an absent `pg` would have been that flag by omission. */
  ROSTER: 'roster',
};

export const EV = {
  SHOT: 'shot',
  HIT: 'hit',
  /**
   * Somebody died: `by` killed `on` with weapon index `w`.
   *
   * `z` is the HIT_ZONE of the shot that finished it, OMITTED for a body shot — the same
   * omit-when-zero convention EV.HIT's own `z` uses, and for the same reason: a client that
   * has never heard of zones reads exactly what it read before. It is broadcast rather than
   * sent to the killer alone because a headshot kill is a thing the whole server sees in
   * every game in the genre, and the killfeed is where it goes.
   */
  KILL: 'kill',
  SPAWN: 'spawn',
  /** Match phase changed — a mode ended, reset, or (from M8) started a round. */
  MATCH: 'match',
  /** A projectile ended: exploded, burst on impact, or ran out of fuse. Carries the
   *  kind so the client picks the right effect, and the point so it can draw it where
   *  it actually happened rather than at the last snapshot position. */
  BURST: 'burst',
  /**
   * A flashbang blinded somebody, for `ms` milliseconds.
   *
   * Addressed with `on` and broadcast to everyone, which is the same shape EV.HIT
   * already uses: each client acts on the ones aimed at it and ignores the rest. It
   * has to come from the server because how blind you are depends on line of sight
   * and on how far off-centre the bang was — a client left to work that out for
   * itself is a client that works out zero.
   */
  BLIND: 'blind',
  /**
   * A weapon jammed and is being cleared, for `ms` milliseconds.
   *
   * Broadcast with `id` — whose gun it was — rather than addressed to its owner alone,
   * because everyone needs it: the owner's own hands play the clearing punch, and a
   * nearby player who hears a rifle stop mid-spray and sees its owner hit the receiver
   * has been handed the one opening that jam creates. Hiding it from them would make the
   * mechanic invisible to exactly the person it matters to.
   *
   * It carries the duration for the same reason EV.BLIND does: the animation and the
   * server's gate must end together, and a client that guessed the length would either
   * still be punching a gun that already works or be holding a gun it thinks is fixed.
   */
  JAM: 'jam',
};

export const encode = (obj) => JSON.stringify(obj);

export function decode(raw) {
  try {
    const v = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Inputs are sent as a small trailing window rather than one at a time, so a
 * dropped packet doesn't cost the client a tick of movement — the next packet
 * still carries it. The server ignores any seq it has already consumed.
 *
 * MSG.INPUT also carries `st`: the newest snapshot tick the client has seen, echoed so the
 * server can time the round trip it puts in the scoreboard's ping column. It is a tick
 * number and never a duration — the server owns both ends of that subtraction, so the field
 * is unforgeable in the only direction that matters. Omitted before the first snapshot.
 * See samplePing in server/index.js.
 */
export const INPUT_REDUNDANCY = 4;
