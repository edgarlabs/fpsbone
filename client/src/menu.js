// The start-screen menu: mode picker, spawn-weapon picker, and the settings panel.
//
// It extends the existing `#start` overlay rather than adding a second screen, so
// the same click that dismisses it is the click that grabs pointer lock — and
// `esc` brings the whole thing back mid-match with no extra state to track.
//
// The settings are split into four tabs the way CS2 splits its options — game,
// controls, crosshair, audio — because one flat list of eighteen controls is a list
// nobody reads. Everything applies live except the game mode: changing mode requires
// a different room, rooms are chosen at handshake time, so that one control reloads
// the page.

import { MODES, MODE_IDS } from '../../shared/modes.js';
import { WEAPONS } from '../../shared/weapons.js';
import { CH_COLORS } from './settings.js';
import { ACTIONS, keyLabel, refuseReason, rebind } from './binds.js';

const $ = (id) => document.getElementById(id);

/** Slider id → the setting it drives, how to show its value, and who to tell.
 *  A table because eleven near-identical `addEventListener` blocks is eleven places
 *  for the same typo, and the two that mattered most (fov, sens) already differed
 *  from each other for no reason. */
const SLIDERS = [
  { el: 's-fov', out: 'o-fov', key: 'fov', fmt: (v) => String(v), cb: 'onFov' },
  { el: 's-vmfov', out: 'o-vmfov', key: 'vmFov', fmt: (v) => String(v), cb: 'onVmFov' },
  { el: 's-sens', out: 'o-sens', key: 'sens', fmt: (v) => v.toFixed(2), cb: 'onSens' },
  { el: 's-zoom', out: 'o-zoom', key: 'zoomSens', fmt: (v) => v.toFixed(2), cb: 'onZoomSens' },
  { el: 's-vol', out: 'o-vol', key: 'vol', fmt: (v) => `${Math.round(v * 100)}%`, cb: 'onVolume' },
  { el: 's-chlen', out: 'o-chlen', key: 'chLen', fmt: (v) => String(v), cb: 'onCross' },
  { el: 's-chgap', out: 'o-chgap', key: 'chGap', fmt: (v) => String(v), cb: 'onCross' },
  { el: 's-chthick', out: 'o-chthick', key: 'chThick', fmt: (v) => String(v), cb: 'onCross' },
];

/** Which settings each "reset" button restores. Grouped so ruining your crosshair
 *  and then resetting it does not also throw away your keys. */
const RESET_GROUPS = {
  'r-cross': ['chLen', 'chGap', 'chThick', 'chDot', 'chOutline', 'chCol'],
  'r-binds': ['binds'],
};

const BIND_HELP =
  'Physical keys, so W is the same key on any layout. <b>Ctrl, alt, meta and the '
  + 'function keys cannot be bound</b> — the browser acts on those above the page, '
  + 'where the game cannot reach them, and Ctrl+W would close the tab mid-match. '
  + 'Ctrl does crouch as a bonus while fullscreen holds the keyboard, on browsers '
  + 'that allow it.';

export function createMenu(settings, cbs) {
  const els = {
    keys: $('keys'),
    tabs: $('tabs'),
    modes: $('modes'),
    weps: $('weps'),
    hands: $('hands'),
    binds: $('binds'),
    bindNote: $('bind-note'),
    chDot: $('ch-dot'),
    chOutline: $('ch-outline'),
    chCol: $('ch-col'),
    play: $('play'),
  };
  const panes = [...document.querySelectorAll('.pane')];

  /** Which modes the server can actually host. Until WELCOME lands we assume all
   *  of them, so the menu is usable while still connecting; the first snapshot
   *  after WELCOME corrects it. */
  let available = new Set(MODE_IDS);
  /**
   * Humans per lobby, by mode id, as last reported by the server.
   *
   * Empty until WELCOME, and a mode missing from it renders with no count rather than
   * with a zero — "0/10" for a room the server never mentioned would be a claim, and an
   * absent count is the truth. See `setLobby`.
   */
  let lobby = {};
  /** The action waiting for a key, or null. */
  let arming = null;

  // ───────────────────────────────────────────────────────────────────── tabs
  for (const tab of els.tabs.children) {
    tab.addEventListener('click', () => {
      disarm();
      for (const t of els.tabs.children) t.classList.toggle('on', t === tab);
      for (const p of panes) p.classList.toggle('on', p.dataset.pane === tab.dataset.tab);
    });
  }

  // ──────────────────────────────────────────────────────────────── bind hint
  /** The one-line reference under the title, built from the live bind map.
   *  Written by hand it drifted immediately — it was still promising a Ctrl crouch
   *  that only works under keyboard lock, and slots 1–5 when there are four. */
  function renderKeys() {
    const b = settings.binds;
    const kb = (...ids) => ids.map((id) => `<kbd>${keyLabel(b[id])}</kbd>`).join('');
    const parts = [
      [kb('forward', 'left', 'back', 'right'), 'move'],
      [kb('jump'), 'jump'],
      [kb('crouch'), 'crouch'],
      [kb('walk'), 'walk <em>(hold)</em> <em>/</em> sprint <em>(tap)</em>'],
      ['<kbd>click</kbd>', 'fire'],
      // Right-click is three different things depending on what you are holding, and
      // naming it "aim" is what made players expect a scope on a knife.
      ['<kbd>right-click</kbd>', 'scope <em>/</em> stab <em>/</em> lob'],
      [kb('reload'), 'reload'],
      [kb('inspect'), 'inspect <em>(hold)</em>'],
      ['<kbd>1</kbd>–<kbd>4</kbd> <em>/</em> <kbd>wheel</kbd>', 'weapon'],
      [kb('scores'), 'scores'],
      ['<kbd>esc</kbd>', 'menu'],
    ];
    els.keys.innerHTML = parts.map(([k, label]) => `<span>${k} ${label}</span>`).join('');
  }

  // ─────────────────────────────────────────────────────────────────── modes
  function renderModes() {
    els.modes.replaceChildren(
      ...MODE_IDS.map((id) => {
        const m = MODES[id];
        const on = settings.mode === id;
        const live = available.has(id);
        const here = lobby[id];
        // FULL MEANS THE CARD IS NOT A BUTTON. The server does not refuse an eleventh
        // player — nothing anywhere throws — so this is the whole of the enforcement, and
        // it is on purpose: a lobby that fills while you are reading the keybinds should
        // grey out in front of you, not reject you after a reload into a black screen.
        //
        // Your OWN lobby is exempt. It reads 10/10 precisely because you are one of the
        // ten, and greying out the room you are standing in would be nonsense.
        const full = here !== undefined && here >= m.slots && !on;
        const card = document.createElement('div');
        card.className = `card${on ? ' on' : ''}${live ? '' : ' dis'}${full ? ' full' : ''}`;
        // Not "coming soon" as decoration: the server registers controllers one at a
        // time, and a mode with no controller would silently hand you deathmatch.
        //
        // The count is HUMANS over slots, never counting the bots that fill the rest —
        // "9/10" on a room holding one player and nine bots would tell you it was nearly
        // full when in fact it is nearly empty, which is the opposite of what the number
        // is for.
        const count = live && here !== undefined ? `<u>${here}/${m.slots}</u>` : '';
        const blurb = !live ? 'not available yet' : full ? 'lobby full — wait for a slot' : m.blurb;
        card.innerHTML = `<b>${m.label}${count}</b><i>${blurb}</i>`;
        if (live && !on && !full) {
          card.addEventListener('click', () => {
            settings.set({ mode: id });
            // The room is picked during the handshake, so a new mode needs a new
            // connection. Reloading is the honest way to get one.
            const qs = new URLSearchParams(location.search);
            qs.set('mode', id);
            location.search = qs.toString();
          });
        }
        return card;
      }),
    );
  }

  /** The mode decides which weapons exist for you, so this list is derived from it
   *  rather than from the full weapon table. */
  function renderWeapons() {
    const mode = MODES[settings.mode];
    // A mode that deals loadouts gives no choice to offer. Showing the picker anyway
    // would be a control that silently does nothing — the pool is worth naming, but
    // as information, not as buttons.
    if (mode.randomLoadout) {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = `dealt at random each life from: ${mode.loadout
        .map((id) => WEAPONS[id].label.toLowerCase())
        .join(', ')}`;
      els.weps.replaceChildren(note);
      return;
    }

    const loadout = mode.loadout;
    // A saved spawn weapon that this mode does not offer falls back to its first.
    if (!loadout.includes(settings.wep)) settings.set({ wep: loadout[0] });

    els.weps.replaceChildren(
      ...loadout.map((id, i) => {
        const chip = document.createElement('div');
        chip.className = `chip${settings.wep === id ? ' on' : ''}`;
        chip.textContent = `${i + 1} ${WEAPONS[id].label}`;
        chip.addEventListener('click', () => {
          settings.set({ wep: id });
          renderWeapons();
          cbs.onWeapon?.(id);
        });
        return chip;
      }),
    );
  }

  // ──────────────────────────────────────────────────────────── chip toggles
  /** A two-chip on/off or either/or control, driven by a data attribute. Used for
   *  gun hand, centre dot and outline — all of which are booleans that read better
   *  as two labelled buttons than as a checkbox in a grid of sliders. */
  function chipGroup(el, attr, current, onPick) {
    const paint = () => {
      for (const chip of el.children) chip.classList.toggle('on', chip.dataset[attr] === current());
    };
    for (const chip of el.children) {
      chip.addEventListener('click', () => {
        onPick(chip.dataset[attr]);
        paint();
      });
    }
    paint();
    return paint;
  }

  const paintHand = chipGroup(els.hands, 'hand', () => settings.hand, (v) => {
    settings.set({ hand: v });
    cbs.onHand?.(settings.hand);
  });

  // THERE IS NO OPPONENTS CONTROL. A PVP / VS AI chip and a bot-count slider used to
  // live here. Bots are now the remainder of a lobby's fixed slots after its humans, so
  // there is nothing to set — what replaced both is the occupancy readout on each mode
  // card in `renderModes`, which reports the answer instead of asking for it.

  const paintDot = chipGroup(els.chDot, 'on', () => (settings.chDot ? '1' : '0'), (v) => {
    settings.set({ chDot: v });
    cbs.onCross?.();
  });
  const paintOutline = chipGroup(els.chOutline, 'on', () => (settings.chOutline ? '1' : '0'), (v) => {
    settings.set({ chOutline: v });
    cbs.onCross?.();
  });

  function renderSwatches() {
    els.chCol.replaceChildren(
      ...CH_COLORS.map((c) => {
        const sw = document.createElement('div');
        sw.className = `sw${settings.chCol === c.id ? ' on' : ''}`;
        sw.style.background = c.hex;
        sw.title = c.id;
        sw.addEventListener('click', () => {
          settings.set({ chCol: c.id });
          renderSwatches();
          cbs.onCross?.();
        });
        return sw;
      }),
    );
  }

  // ───────────────────────────────────────────────────────────────── sliders
  for (const s of SLIDERS) {
    const input = $(s.el);
    const out = $(s.out);
    const paint = () => {
      input.value = String(settings[s.key]);
      out.textContent = s.fmt(settings[s.key]);
    };
    input.addEventListener('input', () => {
      settings.set({ [s.key]: input.value });
      // Repaint from the setting, not from the raw input — `coerce` clamps, and the
      // readout has to show the value that took effect.
      out.textContent = s.fmt(settings[s.key]);
      cbs[s.cb]?.(settings[s.key]);
    });
    s.paint = paint;
    paint();
  }

  // ───────────────────────────────────────────────────────────── keybindings
  /** action id → its button. Built once, because ACTIONS never changes.
   *
   *  Rebuilding the rows on every arm and disarm read as simpler and was subtly
   *  broken: replacing a button between its own mousedown and its click means the
   *  click lands on a node no longer in the document and is lost, so re-arming or
   *  switching to another action silently took two clicks. */
  const bindBtns = new Map();

  function buildBinds() {
    els.binds.replaceChildren(
      ...ACTIONS.map((a) => {
        const row = document.createElement('div');
        row.className = 'bind';

        const label = document.createElement('span');
        label.textContent = a.label;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          arming = arming === a.id ? null : a.id;
          note(arming ? `press a key for <b>${a.label}</b>, or esc to cancel` : BIND_HELP);
          paintBinds();
        });
        bindBtns.set(a.id, btn);

        row.append(label, btn);
        return row;
      }),
    );
  }

  function paintBinds() {
    for (const a of ACTIONS) {
      const btn = bindBtns.get(a.id);
      const code = settings.binds[a.id];
      btn.className = arming === a.id ? 'arm' : code ? '' : 'none';
      btn.textContent = arming === a.id ? '…' : code ? keyLabel(code) : 'unbound';
    }
  }

  function note(html, warn = false) {
    els.bindNote.className = `note${warn ? ' warn' : ''}`;
    els.bindNote.innerHTML = html;
  }

  function disarm() {
    if (!arming) return;
    arming = null;
    note(BIND_HELP);
    paintBinds();
  }

  /**
   * The key capture. Runs in the capture phase and stops propagation, so while a
   * bind is armed the pressed key reaches this and nothing else — including
   * `input.js`, which would otherwise register it as movement.
   *
   * A refused key is refused loudly rather than quietly ignored: the whole reason
   * the game does not bind Ctrl is invisible unless somebody says it out loud, and
   * the player pressing Ctrl right now is exactly the person who needs to hear it.
   */
  window.addEventListener(
    'keydown',
    (e) => {
      if (!arming) return;
      e.preventDefault();
      e.stopPropagation();

      if (e.code === 'Escape') {
        disarm();
        return;
      }

      const why = refuseReason(e.code);
      if (why) {
        note(`<b>${why}.</b> pick another key.`, true);
        return;
      }

      const action = arming;
      arming = null;
      settings.set({ binds: rebind(settings.binds, action, e.code) });
      note(BIND_HELP);
      paintBinds();
      renderKeys();
      cbs.onBinds?.(settings.binds);
    },
    { capture: true },
  );

  // A click outside the bind list gives up on the capture, so an abandoned rebind
  // cannot sit there swallowing the next key you press. Clicks on the list itself are
  // left alone — that is how you switch which action you are binding.
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest?.('.bind')) disarm();
  });

  // ───────────────────────────────────────────────────────────────── resets
  for (const [id, keys] of Object.entries(RESET_GROUPS)) {
    $(id).addEventListener('click', (e) => {
      e.stopPropagation();
      disarm();
      settings.reset(keys);
      refreshAll();
      // Every reset group has a live consumer; telling both is cheaper than
      // working out which group was reset.
      cbs.onCross?.();
      cbs.onBinds?.(settings.binds);
    });
  }

  /** Repaint every control from the settings. Used after a reset, and after the
   *  server corrects the mode. */
  function refreshAll() {
    for (const s of SLIDERS) s.paint();
    paintHand();
    paintDot();
    paintOutline();
    renderSwatches();
    paintBinds();
    renderKeys();
  }

  els.play.addEventListener('click', (e) => {
    // The overlay itself also listens for clicks to start play. Without this the
    // button would trigger both handlers.
    e.stopPropagation();
    cbs.onPlay?.();
  });

  note(BIND_HELP);
  buildBinds();
  renderModes();
  renderWeapons();
  refreshAll();

  return {
    /** Called on WELCOME with the modes the server reported it can host. */
    setAvailable(ids) {
      available = new Set(ids);
      renderModes();
    },
    /**
     * How full every lobby is: `{ dm: 3, tdm: 7, ... }`, humans only.
     *
     * Fed from WELCOME's `lob` and then from every MSG.LOBBY push, which is why this
     * repaints unprompted — the point of the pushes is that a card greys out while the
     * menu is open and nobody has touched anything. Cheap enough to rebuild whole: it
     * fires on a join or a drop, not per frame.
     */
    setLobby(rooms) {
      if (!rooms || typeof rooms !== 'object') return;
      lobby = rooms;
      renderModes();
    },
    /** Reflect the mode the server actually granted, which may not be the one
     *  requested if its controller is not registered yet. */
    setMode(id) {
      if (settings.mode === id) return;
      settings.set({ mode: id });
      renderModes();
      renderWeapons();
    },
    refreshWeapons: renderWeapons,
  };
}
