// Client-side prediction and reconciliation for the local player.
//
// Every input is applied immediately through the shared stepPlayer() so your own
// movement has zero perceived latency. When a snapshot arrives, we snap to
// authority and replay everything the server hasn't consumed yet.

import * as C from '../../shared/constants.js';
import { WORLD_BOXES } from '../../shared/map.js';
import { createPlayerState, stepPlayer } from '../../shared/movement.js';

/** Corrections larger than this are shown immediately rather than smoothed —
 *  something real happened (teleport, respawn, heavy packet loss). */
const SMOOTH_MAX = 1.5;
/** e-folds per second for easing out a correction. */
const SMOOTH_RATE = 14;
const MAX_PENDING = 240;

export function createPredictor(spawn) {
  const state = createPlayerState(spawn);
  const pending = [];
  const error = { x: 0, y: 0, z: 0 };
  let seq = 0;

  return {
    state,
    /** Render offset that eases a correction out over a few frames instead of
     *  snapping. Camera draws at state + error. */
    error,

    get pendingCount() {
      return pending.length;
    },

    push(input) {
      const rec = { seq: ++seq, ...input };
      pending.push(rec);
      stepPlayer(state, rec, C.TICK_DT, WORLD_BOXES);
      if (pending.length > MAX_PENDING) pending.shift();
      return rec;
    },

    recent(n) {
      return pending.slice(-n);
    },

    teleport(auth) {
      Object.assign(state, createPlayerState({ x: auth.x, y: auth.y, z: auth.z, yaw: auth.yaw }));
      state.pitch = auth.pitch ?? 0;
      pending.length = 0;
      error.x = error.y = error.z = 0;
    },

    /**
     * Hold at an authoritative position without touching the view angles. Used
     * while dead: the body is frozen server-side, but you can still look around.
     * Clearing `pending` is the point — otherwise every snapshot would replay
     * buffered inputs away from the death spot and snap back.
     */
    pin(auth) {
      state.x = auth.x;
      state.y = auth.y;
      state.z = auth.z;
      state.crouch = auth.cr ?? 0;
      state.vx = state.vy = state.vz = 0;
      state.grounded = false;
      pending.length = 0;
      error.x = error.y = error.z = 0;
    },

    /**
     * `self` carries velocity and grounded state for our own player, which the
     * broadcast snapshot omits. Without it replay restarts from the wrong
     * velocity and drifts on every single tick — this is the difference between
     * prediction that works and prediction that jitters constantly.
     */
    reconcile(auth, ack, self) {
      const px = state.x;
      const py = state.y;
      const pz = state.z;

      state.x = auth.x;
      state.y = auth.y;
      state.z = auth.z;
      // Crouch is part of the simulation state, not a display value: the replay
      // below sizes the body from it, and a body sized wrong walks through
      // different geometry than the server did. Reset it here for the same reason
      // velocity is reset — start the replay from authority, not from a guess.
      if (auth.cr !== undefined) state.crouch = auth.cr;
      if (self) {
        state.vx = self.vx;
        state.vy = self.vy;
        state.vz = self.vz;
        state.grounded = !!self.g;
        // Same reasoning as crouch: an edge-triggered jump means "was it already
        // held" is state the replay depends on, not a display value.
        state.jumpHeld = !!self.jh;
        // Stamina and its two latches, for the same reason again: the replay reads them
        // to decide the speed cap. The ?? defaults are not decoration — `state.stamina =
        // self.st` on an older server turns undefined into NaN, which the arithmetic
        // below carries straight into position with no error anywhere to notice it.
        state.stamina = self.st ?? C.SPRINT_STAMINA_MAX;
        state.restTicks = self.rt ?? 0;
        state.sprintLock = !!self.sl;
      }

      while (pending.length && pending[0].seq <= ack) pending.shift();
      for (const inp of pending) stepPlayer(state, inp, C.TICK_DT, WORLD_BOXES);

      const dx = px - state.x;
      const dy = py - state.y;
      const dz = pz - state.z;
      if (Math.hypot(dx, dy, dz) < SMOOTH_MAX) {
        error.x = dx;
        error.y = dy;
        error.z = dz;
      } else {
        error.x = error.y = error.z = 0;
      }
    },

    decayError(dtMs) {
      const k = Math.exp((-dtMs / 1000) * SMOOTH_RATE);
      error.x *= k;
      error.y *= k;
      error.z *= k;
    },
  };
}
