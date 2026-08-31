// Mode controllers — the eight hooks that keep `Room` mode-agnostic.
//
// The alternative was a switch statement inside Room for every rule that differs
// between deathmatch and a bomb round. That grows without bound and puts arena
// logic in the path of a deathmatch tick. Instead Room calls out at six points and
// knows nothing about what happens there.
//
//   onJoin(room, p)            Room.add          assign team, seed loadout
//   spawnFor(room, p)          Room.respawn      base spawn vs pickSpawn()
//   canDamage(room, atk, vic)  Room.tryFire      friendly-fire gate
//   onKill(room, killer, vic)  Room.tryFire      scoring, respawn scheduling
//   tick(room)                 end of Room.step  timers, rounds, win checks
//   state()                    Room.snapshotBase the HUD blob
//   botInput(room,p,now,inp)   Room.thinkBots     objective intent, same input path
//   rebalance(room)            server/index.js   even the sides up after a join or drop
//
// `rebalance` is the one hook a Room never calls. It belongs to the HOST, which is what
// owns the bot backfill: adding a human takes a slot back from a bot, and the bot that
// leaves is picked by age rather than by side, so a team mode needs a chance to even the
// count afterwards. A free-for-all has nothing to even and does not implement it.
//
// Every hook is optional. `defaults` below supplies the free-for-all behaviour for
// any a controller declines to implement, so a new controller only writes what it
// actually changes.

import { createFfa } from './ffa.js';
import { createTdm } from './tdm.js';
import { createArena } from './arena.js';

/**
 * Only controllers that actually exist are registered. A mode in shared/modes.js
 * whose controller is missing is reported as unavailable to clients rather than
 * being quietly served by a stand-in — a `tdm` room that was secretly free-for-all
 * would be a worse outcome than one that says "not yet".
 */
const CONTROLLERS = {
  ffa: createFfa,
  tdm: createTdm,
  arena: createArena,
};

const defaults = {
  onJoin() {},
  spawnFor(room) {
    return room.pickSpawn();
  },
  canDamage() {
    return true;
  },
  onKill() {},
  tick() {},
  state() {
    return null;
  },
  botInput(_room, _p, _now, input) {
    return input;
  },
  rebalance() {},
};

export const hasController = (ctl) => Object.hasOwn(CONTROLLERS, ctl);

export function createController(room) {
  const make = CONTROLLERS[room.mode.ctl];
  if (!make) throw new Error(`no controller "${room.mode.ctl}" for mode "${room.modeId}"`);
  return { ...defaults, ...make(room) };
}
