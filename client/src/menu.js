// The lobby shell: profile, match browser, inventory and settings.
//
// It extends the existing `#start` overlay rather than adding a second screen, so
// the same click that dismisses it is the click that grabs pointer lock — and
// `esc` brings the whole thing back mid-match with no extra state to track.
//
// The settings are split into four tabs the way CS2 splits its options — game,
// controls, crosshair, audio — because one flat list of eighteen controls is a list
// nobody reads. Everything applies live. A mode picked in the lobby becomes the next
// handshake's room; Phase 4 does not create that handshake until Join is pressed.

import { MODES, MODE_IDS } from '../../shared/modes.js';
import { MAP } from '../../shared/map.js';
import { WEAPONS } from '../../shared/weapons.js';
import { HERE, fastest, pingGrade } from '../../shared/regions.js';
import { TIERS, MAX_TIER } from '../../shared/ranks.js';
import { XP_TIERS, rankOfXp, toNextRankXp } from '../../shared/progression.js';
import { CH_COLORS } from './settings.js';
import { ACTIONS, keyLabel, refuseReason, rebind } from './binds.js';
import { insigniaPng } from './insignia.js';
import {
  DEFAULT_FINISH, FINISHES, FINISH_IDS, finishOf, sanitizeInventory,
} from '../../shared/cosmetics.js';

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
    screenTabs: $('screen-tabs'),
    openSettings: $('open-settings'),
    tabs: $('tabs'),
    modes: $('modes'),
    regions: $('regions'),
    regionsGrp: $('grp-regions'),
    weps: $('weps'),
    finishes: $('finishes'),
    hands: $('hands'),
    binds: $('binds'),
    bindNote: $('bind-note'),
    chDot: $('ch-dot'),
    chOutline: $('ch-outline'),
    chCol: $('ch-col'),
    play: $('play'),
    leave: $('leave-match'),
    start: $('start'),
    resultOutcome: $('result-outcome'),
    resultMode: $('result-mode'),
    resultKills: $('result-kills'),
    resultDeaths: $('result-deaths'),
    resultRatio: $('result-ratio'),
    resultXp: $('result-xp'),
    resultXpBreakdown: $('result-xp-breakdown'),
    resultBeforeIcon: $('result-rank-before-icon'),
    resultBefore: $('result-rank-before'),
    resultAfterIcon: $('result-rank-after-icon'),
    resultAfter: $('result-rank-after'),
    resultProgressFill: $('result-progress-fill'),
    resultProgressText: $('result-progress-text'),
    resultLobby: $('result-lobby'),
    resultReplay: $('result-replay'),
    lobbyRegion: $('lobby-region'),
    profileName: $('profile-name'),
    profileAccount: $('profile-account'),
    profileRankIcon: $('profile-rank-icon'),
    profileRankName: $('profile-rank-name'),
    profileRankProgress: $('profile-rank-progress'),
    profileRankFill: $('profile-rank-fill'),
    profileCareer: $('profile-career'),
    profileKills: $('profile-kills'),
    profileDeaths: $('profile-deaths'),
    inventoryGun: $('inventory-gun'),
    inventoryName: $('inventory-preview-name'),
    inventoryMeta: $('inventory-preview-meta'),
    identityState: $('identity-state'),
    identityFingerprint: $('identity-fingerprint'),
    recoveryCode: $('recovery-code'),
    recoveryExport: $('recovery-export'),
    recoveryImport: $('recovery-import'),
    recoveryClear: $('recovery-clear'),
    recoveryState: $('recovery-state'),
    inventoryState: $('inventory-state'),
    submissionForm: $('submission-form'),
    submissionTitle: $('submission-title'),
    submissionDescription: $('submission-description'),
    submissionSteel: $('submission-steel'),
    submissionDark: $('submission-dark'),
    submissionTrim: $('submission-trim'),
    submissionSend: $('submission-send'),
    submissionState: $('submission-state'),
    submissionHistory: $('submission-history'),
  };
  const panes = [...document.querySelectorAll('.pane')];
  const screens = [...document.querySelectorAll('.screen')];

  /** Which modes the server can actually host. Until the lightweight /ping probe or
   *  WELCOME lands we assume all of them, so a temporarily unreachable lobby remains usable. */
  let available = new Set(MODE_IDS);
  /**
   * Humans per lobby, by mode id, as last reported by the server.
   *
   * Empty until /ping or WELCOME, and a mode missing from it renders with no count rather than
   * with a zero — "0/10" for a room the server never mentioned would be a claim, and an
   * absent count is the truth. See `setLobby`.
   */
  let lobby = {};
  /** Rich, identity-free room counts: connected people, reserved seats, bots and bodies. */
  let population = { rooms: {} };
  /**
   * The servers this page can offer and their measured pings, as last reported by main.js.
   *
   * Empty until /regions answers, which is deliberately not waited on: the lobby can paint
   * while these measurements fill in, and Join later opens the chosen match socket.
   */
  let regions = [];
  /** Which region the game socket is actually on, or null if something outranked the setting
   *  (a `?server=` override). Not read from `settings` because the setting is a request. */
  let activeRegion = null;
  let playerStats = { career: 0, xp: 0, stats: {}, kills: 0, deaths: 0 };
  let inventoryState = {
    state: 'loading', owned: new Set(sanitizeInventory()), submissions: [],
  };
  let matchState = 'lobby';
  /** The action waiting for a key, or null. */
  let arming = null;

  // ───────────────────────────────────────────────────────────── main screens
  function showScreen(id) {
    disarm();
    for (const tab of els.screenTabs.children) tab.classList.toggle('on', tab.dataset.screen === id);
    for (const screen of screens) screen.classList.toggle('on', screen.dataset.screen === id);
  }
  for (const tab of els.screenTabs.children) {
    tab.addEventListener('click', () => showScreen(tab.dataset.screen));
  }
  els.openSettings.addEventListener('click', () => showScreen('settings'));

  // ───────────────────────────────────────────────────────────── settings tabs
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

  // ───────────────────────────────────────────────────────────────── regions
  /**
   * The server picker: one card per region, with the round trip to it measured from here.
   *
   * The ping is the only reason this list is worth showing. A player who can see 38ms next to
   * ASIA and 210ms next to AMERICA needs no explanation of why one duel felt fair and the
   * other felt rigged — and the number is measured in this browser (client/src/regions.js)
   * rather than claimed from a map, because a ping display that is wrong is worse than none:
   * it moves somebody to a worse server and tells them it was the right call.
   */
  function renderRegions() {
    // ONE SERVER IS NOT A CHOICE. A checkout, or a deploy that never named its peers, gets no
    // picker at all rather than a single card that does nothing when clicked.
    els.regionsGrp.hidden = regions.length < 2;
    if (regions.length < 2) {
      els.regions.replaceChildren();
      return;
    }

    const best = fastest(regions);
    els.regions.replaceChildren(
      ...regions.map((r) => {
        const on = r.id === activeRegion;
        // A region that did not answer. Greyed rather than hidden: "unreachable" is a fact the
        // player is owed, and on a free tier it usually means asleep rather than gone.
        const down = r.state === 'down';
        const full = Number.isFinite(r.humans) && Number.isFinite(r.cap) && r.humans >= r.cap;
        const card = document.createElement('div');
        card.className = `card${on ? ' on' : ''}${down ? ' dis' : ''}${full ? ' full' : ''}`;

        // The number, or what is happening instead of one. `waking…` is its own word because
        // a spun-down free instance takes about a minute to answer, and a card that sat blank
        // for a minute is indistinguishable from a card that is broken.
        const ping = down
          ? '<u class="p-none">unreachable</u>'
          : Number.isFinite(r.ms)
            ? `<u class="p-${pingGrade(r.ms)}">${r.ms}ms</u>`
            : `<u class="p-wait">${r.state === 'waking' ? 'waking…' : '…'}</u>`;

        // FASTEST IS A MARKER, NOT A DECISION — nothing auto-connects. See the comment on
        // `fastest` in shared/regions.js for why choosing for the player is worse than this.
        // THIS PAGE names the server that sent the html, which is not necessarily the one
        // holding the match: pick ASIA from a page served by EUROPE and both are true at once.
        const tags =
          (best && r.id === best.id ? '<em class="best">FASTEST</em>' : '')
          + (r.mine ? '<em class="mine">THIS PAGE</em>' : '');

        // Occupancy is every human on that server across all of its lobbies, because the
        // choice being made here is the server — which mode to join is the row below. An
        // empty region with a beautiful ping is not the better room, so the count sits here.
        const population = Number.isFinite(r.cap)
          ? `${r.humans}/${r.cap} playing`
          : `${r.humans} playing`;
        const where = down
          ? 'no answer — asleep, or not deployed'
          : full
            ? `${r.where} · server full`
          : Number.isFinite(r.humans)
            ? `${r.where} · ${population}`
            : r.where;
        card.innerHTML = `<b><span>${r.label}${tags}</span>${ping}</b><i>${where}</i>`;

        if (!on && !down && !full) {
          card.addEventListener('click', () => {
            // The socket is opened once, at load, against one address — so changing which
            // server that is needs a new page. The ADDRESS is stored alongside the id because
            // an id alone cannot be dialled: hostnames arrive at runtime, so a returning
            // player would otherwise wait on /regions before their socket could open.
            settings.set({ region: r.id, regionHost: r.id === HERE ? '' : r.host });
            // Any of these three left in the url would outrank or contradict what was just
            // stored, so the click would appear to do nothing. Dropping them is the honest
            // reading of "I want this server".
            const u = new URL(location.href);
            for (const k of ['server', 'region', 'regionHost']) u.searchParams.delete(k);
            // Assigning an unchanged href does reload in every browser, but saying it outright
            // costs one line and saves the next reader having to know that.
            if (u.href === location.href) location.reload();
            else location.href = u.href;
          });
        }
        return card;
      }),
    );
  }

  function renderRegionSummary() {
    const current = regions.find((r) => r.id === activeRegion);
    if (!current) {
      const seats = Number.isFinite(population.humans) && Number.isFinite(population.capacity)
        ? ` · ${population.humans}/${population.capacity} online`
        : '';
      els.lobbyRegion.textContent = `${activeRegion ? activeRegion.toUpperCase() : 'THIS SERVER'}${seats}`;
      return;
    }
    const ping = Number.isFinite(current.ms) ? `${current.ms}ms` : current.state === 'waking' ? 'waking…' : 'measuring…';
    const seats = Number.isFinite(current.humans) && Number.isFinite(current.cap)
      ? `${current.humans}/${current.cap} online`
      : 'population pending';
    els.lobbyRegion.textContent = `${current.label} · ${ping} · ${seats}`;
  }

  // ─────────────────────────────────────────────────────────────────── modes
  function renderModes() {
    els.modes.replaceChildren(
      ...MODE_IDS.map((id) => {
        const m = MODES[id];
        const on = settings.mode === id;
        const live = available.has(id);
        const roomPop = population.rooms?.[id];
        const here = Number.isFinite(roomPop?.humans) ? roomPop.humans : lobby[id];
        // The menu prevents the ordinary over-capacity click; the server repeats this gate
        // authoritatively during HELLO to close the race where two clients saw one seat.
        //
        // Your OWN lobby is exempt. It reads 10/10 precisely because you are one of the
        // ten, and greying out the room you are standing in would be nonsense.
        const full = here !== undefined && here >= m.slots && !(matchState === 'joined' && on);
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
        let blurb = !live ? 'not available yet' : full ? 'lobby full — wait for a slot' : m.blurb;
        if (live && roomPop) {
          const players = roomPop.connected ?? 0;
          const bots = roomPop.bots ?? 0;
          const reserved = roomPop.reserved ?? 0;
          if (roomPop.state === 'dormant') {
            blurb = `empty · join to start with ${Math.max(0, m.slots - 1)} bots`;
          } else if (full) {
            blurb = `${players} players${reserved ? ` · ${reserved} reconnecting` : ''} · full`;
          } else {
            blurb = `${players} player${players === 1 ? '' : 's'} · ${bots} bot${bots === 1 ? '' : 's'}`
              + `${reserved ? ` · ${reserved} reconnecting` : ''}`;
          }
        }
        card.innerHTML = `<b>${m.label}${count}</b><i>${MAP.label.toLowerCase()} · ${blurb}</i>`;
        if (live && !on && !full && matchState === 'lobby') {
          card.addEventListener('click', () => {
            settings.set({ mode: id });
            renderModes();
            renderWeapons();
            cbs.onMode?.(id);
          });
        }
        return card;
      }),
    );

    // Capacity is previewed here for a useful button; HELLO repeats the decision on the
    // server because another player may take the last seat between this paint and the click.
    if (matchState === 'lobby') {
      const selected = MODES[settings.mode];
      const roomPop = population.rooms?.[settings.mode];
      const humans = Number.isFinite(roomPop?.humans) ? roomPop.humans : lobby[settings.mode];
      const full = humans !== undefined && humans >= selected.slots;
      const live = available.has(settings.mode);
      const label = els.play.querySelector('span');
      els.play.disabled = full || !live;
      if (label) label.textContent = !live
        ? 'mode unavailable'
        : full
          ? 'server full · try again later'
          : 'join selected match';
    }
  }

  /** The mode decides which weapons exist for you, so this list is derived from it
   *  rather than from the full weapon table. */
  function renderInventoryPreview(id) {
    const w = id ? WEAPONS[id] : null;
    const finishId = cbs.identity?.cosmetics?.finish ?? DEFAULT_FINISH;
    const finish = finishOf(finishId);
    els.inventoryGun.dataset.weapon = id ?? 'random';
    els.inventoryGun.dataset.finish = finishId;
    els.inventoryName.textContent = w?.label ?? 'RANDOM LOADOUT';
    els.inventoryMeta.textContent = w
      ? `${finish.label.toLowerCase()} · ${w.kind} · gameplay stats locked`
      : `${finish.label.toLowerCase()} · a legal loadout is dealt every life`;
  }

  function renderFinishes() {
    const selected = cbs.identity?.cosmetics?.finish ?? DEFAULT_FINISH;
    els.finishes.replaceChildren(...FINISH_IDS.map((id) => {
      const finish = FINISHES[id];
      const owned = inventoryState.owned.has(id);
      const item = document.createElement('button');
      item.type = 'button';
      item.disabled = !owned;
      item.className = `finish-item${selected === id ? ' on' : ''}${owned ? '' : ' locked'}`;
      item.innerHTML = `<i style="--finish:${`#${finish.trim.toString(16).padStart(6, '0')}`}"></i>`
        + `<span><b>${finish.label}</b><small>${finish.rarity} · ${owned ? 'owned' : 'locked'}</small></span>`;
      item.addEventListener('click', async () => {
        if (!owned) return;
        els.inventoryState.textContent = 'saving equipped finish…';
        try {
          await cbs.onFinish?.(id);
          els.inventoryState.textContent = `${inventoryState.owned.size}/${FINISH_IDS.length} owned · marketplace offline`;
          renderFinishes();
          renderInventoryPreview(MODES[settings.mode].randomLoadout ? null : settings.wep);
        } catch {
          els.inventoryState.textContent = 'equip failed · account server unavailable';
        }
      });
      return item;
    }));
  }

  function renderSubmissions() {
    els.submissionSend.disabled = inventoryState.state !== 'ready' || !cbs.identity?.verified;
    const list = Array.isArray(inventoryState.submissions) ? inventoryState.submissions : [];
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'note';
      empty.textContent = inventoryState.state === 'loading'
        ? 'Loading your review trail…'
        : 'No finish concepts submitted yet.';
      els.submissionHistory.replaceChildren(empty);
      return;
    }
    els.submissionHistory.replaceChildren(...list.map((submission) => {
      const row = document.createElement('div');
      row.className = 'submission-row';
      const copy = document.createElement('span');
      const title = document.createElement('b');
      title.textContent = submission.title ?? 'Untitled concept';
      const note = document.createElement('small');
      note.textContent = submission.note || 'Awaiting reviewer note.';
      copy.append(title, note);
      const status = document.createElement('em');
      status.textContent = submission.status ?? 'submitted';
      row.append(copy, status);
      return row;
    }));
  }

  els.submissionForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (inventoryState.state !== 'ready' || !cbs.identity?.verified) return;
    const submission = {
      title: els.submissionTitle.value,
      description: els.submissionDescription.value,
      steel: els.submissionSteel.value,
      dark: els.submissionDark.value,
      trim: els.submissionTrim.value,
    };
    els.submissionSend.disabled = true;
    els.submissionState.textContent = 'Signing and submitting concept…';
    try {
      const result = await cbs.onCommunitySubmit?.(submission);
      inventoryState.submissions = result?.submissions ?? inventoryState.submissions;
      els.submissionTitle.value = '';
      els.submissionDescription.value = '';
      els.submissionState.textContent = 'Submitted. It cannot enter the catalog until reviewed.';
      renderSubmissions();
    } catch (err) {
      const messages = {
        submission_length: 'Use a 3–40 character name and a 20–500 character description.',
        submission_content: 'Links, markup and control characters are not accepted.',
        submission_palette: 'Choose three different six-digit colours.',
        submission_limit: 'Submission limit reached; wait for the current review batch.',
      };
      els.submissionState.textContent = messages[err?.message]
        ?? 'Submission failed. Check the account connection and try again.';
      renderSubmissions();
    }
  });

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
      renderInventoryPreview(null);
      return;
    }

    const loadout = mode.loadout;
    // A saved spawn weapon that this mode does not offer falls back to its first.
    if (!loadout.includes(settings.wep)) settings.set({ wep: loadout[0] });

    els.weps.replaceChildren(
      ...loadout.map((id, i) => {
        const w = WEAPONS[id];
        const item = document.createElement('div');
        item.className = `inventory-item${settings.wep === id ? ' on' : ''}`;
        item.innerHTML = `<span>0${i + 1}</span><b>${w.label}</b><i>${w.kind} · ${w.mag ?? '—'} rd</i>`;
        item.addEventListener('click', () => {
          settings.set({ wep: id });
          renderWeapons();
          cbs.onWeapon?.(id);
        });
        return item;
      }),
    );
    renderInventoryPreview(settings.wep);
  }

  function renderProfile() {
    const xp = Math.max(0, Math.floor(Number(playerStats.xp) || 0));
    const tier = rankOfXp(xp);
    const rank = TIERS[tier];
    const left = toNextRankXp(xp);
    const next = tier < MAX_TIER ? XP_TIERS[tier + 1] : null;
    const floor = XP_TIERS[tier].at;
    const span = next ? Math.max(1, next.at - floor) : 1;
    const progress = next ? Math.max(0, Math.min(1, (xp - floor) / span)) : 1;
    const stats = playerStats.stats ?? {};
    const matches = Math.max(0, Math.floor(Number(stats.matches) || 0));
    const wins = Math.max(0, Math.floor(Number(stats.wins) || 0));
    const kills = Math.max(0, Math.floor(Number(stats.kills) || 0));
    const deaths = Math.max(0, Math.floor(Number(stats.deaths) || 0));
    els.profileName.textContent = cbs.identity?.displayName ?? 'player';
    els.profileRankIcon.src = insigniaPng(tier).url;
    els.profileRankIcon.alt = rank.name;
    els.profileRankName.textContent = `${rank.name} · ${rank.abbr}`;
    els.profileRankProgress.textContent = next ? `${left} XP to ${next.name}` : 'maximum rank achieved';
    els.profileRankFill.style.width = `${Math.round(progress * 100)}%`;
    els.profileCareer.textContent = xp.toLocaleString();
    els.profileKills.textContent = `${wins} / ${matches}`;
    els.profileDeaths.textContent = deaths ? (kills / deaths).toFixed(2) : kills.toFixed(2);
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
  els.leave.addEventListener('click', (e) => {
    e.stopPropagation();
    cbs.onLeave?.();
  });
  els.resultLobby.addEventListener('click', (e) => {
    e.stopPropagation();
    cbs.onResultLobby?.();
  });
  els.resultReplay.addEventListener('click', (e) => {
    e.stopPropagation();
    cbs.onResultReplay?.();
  });
  els.identityFingerprint.textContent = cbs.identity?.verified
    ? cbs.identity.id
    : 'unsigned guest · persistent progression unavailable';
  els.identityState.textContent = cbs.identity?.verified ? 'signed device identity' : 'unsigned guest';
  els.recoveryExport.addEventListener('click', () => {
    const code = cbs.onRecoveryExport?.();
    if (!code) {
      els.recoveryState.textContent = 'This browser could not create a signed recovery key.';
      return;
    }
    els.recoveryCode.value = code;
    els.recoveryCode.focus();
    els.recoveryCode.select();
    els.recoveryState.textContent = 'Recovery code generated. Save it privately; never post or send it.';
  });
  els.recoveryImport.addEventListener('click', async () => {
    const code = els.recoveryCode.value.trim();
    if (!code) {
      els.recoveryState.textContent = 'Paste a recovery code first.';
      return;
    }
    els.recoveryImport.disabled = true;
    els.recoveryState.textContent = 'Checking recovery key…';
    try {
      await cbs.onRecoveryImport?.(code);
    } catch {
      els.recoveryImport.disabled = false;
      els.recoveryState.textContent = 'That recovery code is invalid or incomplete.';
    }
  });
  els.recoveryClear.addEventListener('click', () => {
    els.recoveryCode.value = '';
    els.recoveryState.textContent = 'Recovery field cleared.';
  });

  note(BIND_HELP);
  buildBinds();
  renderRegions();
  renderModes();
  renderWeapons();
  renderFinishes();
  renderProfile();
  refreshAll();

  return {
    /** Lobby, socket handshake, paused match, or results — reflected in footer controls. */
    setMatchState(state) {
      matchState = state;
      const label = els.play.querySelector('span');
      els.play.disabled = state === 'joining' || state === 'results';
      if (label) label.textContent = state === 'joining'
        ? 'joining match…'
        : state === 'joined'
          ? 'resume match'
          : 'join selected match';
      els.leave.hidden = state !== 'joined';
      renderModes();
    },
    /** Paint the server-issued after-action receipt and its exact XP breakdown. */
    showResults(summary) {
      const beforeTier = rankOfXp(summary.xpBefore);
      const afterTier = rankOfXp(summary.xpAfter);
      const before = TIERS[beforeTier];
      const after = TIERS[afterTier];
      const next = afterTier < MAX_TIER ? XP_TIERS[afterTier + 1] : null;
      const progress = next
        ? (summary.xpAfter - XP_TIERS[afterTier].at) / Math.max(1, next.at - XP_TIERS[afterTier].at)
        : 1;
      els.resultOutcome.textContent = summary.outcome;
      els.resultMode.textContent = summary.mode;
      els.resultKills.textContent = String(summary.kills);
      els.resultDeaths.textContent = String(summary.deaths);
      els.resultRatio.textContent = summary.deaths
        ? (summary.kills / summary.deaths).toFixed(2)
        : summary.kills.toFixed(2);
      els.resultXp.textContent = `+${summary.xp}`;
      const award = summary.award ?? {};
      const parts = [
        ['played', award.participation],
        ['human combat', award.humans],
        ['bot combat', award.bots],
        ['assists', award.assists],
        ['objectives', award.objectives],
        ['win', award.win],
      ].filter(([, value]) => Number(value) > 0).map(([label, value]) => `${label} +${value}`);
      if (Number(award.botXpDiscarded) > 0) parts.push(`${award.botXpDiscarded} bot XP capped`);
      els.resultXpBreakdown.textContent = parts.join(' · ') || 'no qualifying participation XP';
      els.resultBeforeIcon.src = insigniaPng(beforeTier).url;
      els.resultBeforeIcon.alt = before.name;
      els.resultBefore.textContent = `${before.name} · ${before.abbr}`;
      els.resultAfterIcon.src = insigniaPng(afterTier).url;
      els.resultAfterIcon.alt = after.name;
      els.resultAfter.textContent = `${after.name} · ${after.abbr}`;
      els.resultProgressFill.style.width = `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
      els.resultProgressText.textContent = next
        ? `${summary.xp} XP earned · ${toNextRankXp(summary.xpAfter)} XP to ${next.name}`
        : `${summary.xp} XP earned · maximum rank achieved`;
      els.start.classList.add('results');
      this.setMatchState('results');
    },
    hideResults() {
      els.start.classList.remove('results');
      showScreen('lobby');
    },
    /**
     * The servers on offer, and which one this page's socket is actually on.
     *
     * Called once after /regions answers. `active` is passed rather than read from `settings`
     * because the setting is a REQUEST: a `?server=` override outranks it, and marking a card
     * the socket is not on would be the picker lying about the state it exists to show.
     */
    setRegions(list, active) {
      if (!Array.isArray(list)) return;
      regions = list;
      activeRegion = active ?? null;
      renderRegions();
      renderRegionSummary();
    },
    /** The region confirmed by the game handshake, which outranks the saved request. */
    setActiveRegion(id) {
      activeRegion = id ?? null;
      renderRegions();
      renderRegionSummary();
    },
    /**
     * Measured pings, merged in by id and repainted.
     *
     * Fed from every change `probeAll` reports rather than once at the end, so five cards fill
     * in as their answers land instead of all at once behind the slowest region — which on a
     * sleeping free instance is a minute of a blank list.
     */
    setPings(results) {
      if (!Array.isArray(results)) return;
      const by = new Map(results.map((r) => [r.id, r]));
      // Merged onto what is already there, not replaced: the probe result carries the timing
      // and the label came from the table, and neither knows the other's half.
      regions = regions.map((r) => ({ ...r, ...(by.get(r.id) ?? {}) }));
      renderRegions();
      renderRegionSummary();
    },
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
    /** Detailed counts share the server's exact admission/backfill calculation. */
    setPopulation(next) {
      if (!next || typeof next !== 'object') return;
      population = next;
      renderModes();
      renderRegionSummary();
    },
    /** Identity proof and storage durability are separate truths. */
    setAccount(account) {
      const durable = account?.durable === true;
      const device = account?.type === 'device';
      els.profileAccount.textContent = device
        ? durable ? 'verified device · progress synced' : 'verified device · local practice'
        : durable ? 'unsigned guest · progress disabled' : 'guest account · local progress only';
      els.profileAccount.classList.toggle('durable', durable);
    },
    setInventoryState(next = {}) {
      if (next.state) inventoryState.state = next.state;
      if (Array.isArray(next.owned)) inventoryState.owned = new Set(sanitizeInventory(next.owned));
      if (Array.isArray(next.submissions)) inventoryState.submissions = next.submissions;
      if (next.equipped) cbs.identity.cosmetics = next.equipped;
      const labels = {
        loading: 'checking ownership…',
        ready: `${inventoryState.owned.size}/${FINISH_IDS.length} owned · marketplace offline`,
        offline: 'ownership service unavailable · marketplace offline',
        local: 'local practice inventory · marketplace offline',
        guest: 'unsigned guest · inventory saving disabled',
      };
      els.inventoryState.textContent = labels[inventoryState.state] ?? labels.offline;
      els.submissionState.textContent = inventoryState.state === 'ready'
        ? 'Signed creator submissions are open.'
        : inventoryState.state === 'loading'
          ? 'Checking verified account…'
          : 'A verified online account is required.';
      renderFinishes();
      renderInventoryPreview(MODES[settings.mode].randomLoadout ? null : settings.wep);
      renderSubmissions();
    },
    /** The career is private owner data; current kills/deaths come from this match's snapshot. */
    setPlayerStats(next) {
      if (!next || typeof next !== 'object') return;
      playerStats = { ...playerStats, ...next };
      renderProfile();
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
