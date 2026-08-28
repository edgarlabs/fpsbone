// The keybind table: what actions exist, what they default to, and which physical
// keys the browser will not give up.
//
// It is its own module because three places have to agree about it and none of them
// should own it — `input.js` reads binds to build an intent, `menu.js` renders and
// rewrites them, and `settings.js` validates whatever came back out of localStorage.
// A bind list that lived in any one of those would be a bind list the other two
// guessed at.

/**
 * Every rebindable action, in the order the settings panel lists them.
 *
 * `code` is a KeyboardEvent.code — physical position, not the character produced —
 * so W is the same key on AZERTY as on QWERTY. That is also why the labels below
 * come from `keyLabel` rather than from the event's `key`.
 */
export const ACTIONS = [
  { id: 'forward', label: 'move forward', code: 'KeyW' },
  { id: 'back', label: 'move back', code: 'KeyS' },
  { id: 'left', label: 'move left', code: 'KeyA' },
  { id: 'right', label: 'move right', code: 'KeyD' },
  { id: 'jump', label: 'jump', code: 'Space' },
  { id: 'crouch', label: 'crouch', code: 'KeyC' },
  // One key, two verbs: held it walks, tapped it toggles sprint. There is deliberately
  // no separate `sprint` row. A second bindable key could be HELD for sprint, which
  // would hand a player sustained sprint with none of the walk penalty and quietly
  // replace the mechanic that was asked for.
  { id: 'walk', label: 'walk (hold) / sprint (tap)', code: 'ShiftLeft' },
  { id: 'reload', label: 'reload', code: 'KeyR' },
  { id: 'inspect', label: 'inspect weapon', code: 'KeyF' },
  { id: 'use', label: 'plant / defuse', code: 'KeyE' },
  { id: 'scores', label: 'scoreboard', code: 'Tab' },
];

export const ACTION_IDS = ACTIONS.map((a) => a.id);
export const DEFAULT_BINDS = Object.fromEntries(ACTIONS.map((a) => [a.id, a.code]));

/**
 * Extra codes each action answers to, on top of whatever it is bound to.
 *
 * Not rebindable and not shown: they exist so the arrow keys keep working for
 * anyone who reaches for them, without spending a row of the settings panel or a
 * second bind slot per action on it.
 */
export const ALIASES = {
  forward: ['ArrowUp'],
  back: ['ArrowDown'],
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
  // Ctrl is a crouch key ONLY while the Keyboard Lock API is holding the keyboard,
  // which `input.js` gates separately — see the note on RISKY below for why it can
  // never be a plain bind.
  crouch: [],
};

/**
 * Keys the browser owns above the page, where `preventDefault` has no reach.
 *
 * Binding any of these is refused rather than accepted-and-broken. Ctrl+W closes the
 * tab and Ctrl+S opens a save dialog, so "crouch on Ctrl" plus "forward on W" is not
 * an edge case in a browser — it is the most ordinary thing a player will do, and it
 * ends the match. Escape is here for a different reason: it releases pointer lock, so
 * a game that consumed it could never be left.
 */
export const RISKY = new Set([
  'ControlLeft', 'ControlRight',
  'MetaLeft', 'MetaRight',
  'AltLeft', 'AltRight',
  'Escape',
  'F1', 'F3', 'F5', 'F6', 'F7', 'F10', 'F11', 'F12',
]);

/** Why a key was refused, or null if it is bindable. Written for the player, not
 *  for a log — this string goes straight into the settings panel. */
export function refuseReason(code) {
  if (!code) return 'no key';
  if (RISKY.has(code)) {
    return `${keyLabel(code)} belongs to the browser — binding it could close the tab mid-match`;
  }
  return null;
}

const NAMES = {
  Space: 'space',
  Tab: 'tab',
  Escape: 'esc',
  Enter: 'enter',
  Backspace: 'bksp',
  CapsLock: 'caps',
  ShiftLeft: 'l-shift',
  ShiftRight: 'r-shift',
  ControlLeft: 'l-ctrl',
  ControlRight: 'r-ctrl',
  AltLeft: 'l-alt',
  AltRight: 'r-alt',
  MetaLeft: 'meta',
  MetaRight: 'meta',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
};

const TWINS = {
  ShiftLeft: 'ShiftRight',
  ShiftRight: 'ShiftLeft',
  ControlLeft: 'ControlRight',
  ControlRight: 'ControlLeft',
  AltLeft: 'AltRight',
  AltRight: 'AltLeft',
};

/**
 * The other one of a sided key, or null.
 *
 * A bind on left shift answers to right shift too. Nobody who binds walk to shift
 * means "the left one specifically", and a keyboard where the right shift silently
 * does nothing feels broken rather than precise.
 */
export const twinOf = (code) => TWINS[code] ?? null;

/** A physical key code as a player would recognise it. */
export function keyLabel(code) {
  if (!code) return '—';
  if (NAMES[code]) return NAMES[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `num ${code.slice(6).toLowerCase()}`;
  return code;
}

/**
 * Assign `code` to `action`, taking it away from anything else that held it.
 *
 * Silently leaving a key on two actions is the worse option: crouch and jump on the
 * same key is a bug the player cannot see in the list, only feel in the match.
 *
 * The displaced action falls back to its own default, but only if that default is
 * genuinely free — otherwise it is left unbound and the panel shows the gap. Handing
 * it a key somebody else holds would just move the collision somewhere the player is
 * not looking, and an empty row is a problem you can see and fix.
 */
export function rebind(binds, action, code) {
  const next = { ...binds };
  next[action] = code;

  for (const id of ACTION_IDS) {
    if (id === action || next[id] !== code) continue;
    next[id] = '';
    const taken = new Set(ACTION_IDS.map((k) => next[k]).filter(Boolean));
    next[id] = taken.has(DEFAULT_BINDS[id]) ? '' : DEFAULT_BINDS[id];
  }
  return next;
}

/**
 * Rebuild a bind map so it is always complete, always legal, and never has one key
 * doing two jobs. Applied to whatever came back out of storage.
 *
 * A key that is *missing* gets its default — that is the case that matters, because
 * storage written before binds existed has none of them. A key that is present but
 * empty is a deliberate unbind, left alone: `rebind` produces those when it takes an
 * action's key away and finds no free default to hand back, and filling it in here
 * would undo the player's most recent choice.
 *
 * Order matters for the remaining case, a duplicate out of hand-edited storage: the
 * action earlier in `ACTION_IDS` keeps the key and the later one comes back unbound.
 * Deterministic, and visible in the panel rather than felt in the match.
 *
 * `rebind`'s output already satisfies all of this, so normalising it is the identity —
 * which is the property that keeps a fresh rebind from being quietly rewritten on its
 * way through `settings.set`.
 */
export function normalizeBinds(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  const taken = new Set();
  for (const id of ACTION_IDS) {
    const want = typeof src[id] === 'string' ? src[id] : DEFAULT_BINDS[id];
    const code = want && !RISKY.has(want) && !taken.has(want) ? want : '';
    if (code) taken.add(code);
    out[id] = code;
  }
  return out;
}
