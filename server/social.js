// Lightweight lobby presence, friends, parties and matchmaking.
//
// Nothing here creates a game seat. A match result is only an invitation to open the
// ordinary game WebSocket; server/index.js still performs the final, atomic capacity check.
// Sessions are deliberately memory-only and short lived: they are presence, not accounts.

import { createHash, randomUUID } from 'node:crypto';

const SESSION_MS = 45_000;
const MATCH_MS = 20_000;
const MAX_PARTY = 5;

const cleanName = (value) => String(value ?? 'player').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20) || 'player';
const cleanCode = (value) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
const codeOf = (account) => createHash('sha256').update(`fpsbone-social:${account}`).digest('hex').slice(0, 8).toUpperCase();

export function createSocialService({ host, now = () => Date.now(), makeToken = randomUUID } = {}) {
  const sessions = new Map();
  const byAccount = new Map();
  const friends = new Map();
  const requests = new Map();
  const partyInvites = new Map();
  const parties = new Map();
  const memberParty = new Map();
  const queue = [];
  const matches = new Map();

  const setOf = (map, key) => {
    if (!map.has(key)) map.set(key, new Set());
    return map.get(key);
  };
  const sessionOf = (account) => sessions.get(byAccount.get(account));
  const partyOf = (account) => parties.get(memberParty.get(account));

  function leaveQueue(partyId) {
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].party === partyId) queue.splice(i, 1);
  }

  function leaveParty(account) {
    const party = partyOf(account);
    if (!party) return;
    leaveQueue(party.id);
    party.members.delete(account);
    memberParty.delete(account);
    if (!party.members.size) parties.delete(party.id);
    else if (party.leader === account) party.leader = party.members.values().next().value;
  }

  function sweep() {
    const at = now();
    for (const [token, session] of sessions) {
      if (at - session.seen <= SESSION_MS) continue;
      sessions.delete(token);
      if (byAccount.get(session.account) === token) byAccount.delete(session.account);
    }
    for (const [account, match] of matches) if (match.expires <= at) matches.delete(account);
    for (let i = queue.length - 1; i >= 0; i--) {
      const party = parties.get(queue[i].party);
      if (!party || [...party.members].some((account) => !sessionOf(account))) queue.splice(i, 1);
    }
  }

  function runQueue() {
    sweep();
    const roomCounts = host?.occupancy?.() ?? {};
    let regional = Number(host?.humans) || 0;
    const held = {};
    for (let i = 0; i < queue.length;) {
      const item = queue[i];
      const party = parties.get(item.party);
      if (!party) { queue.splice(i, 1); continue; }
      const size = party.members.size;
      let mode = null;
      let tickets = null;
      for (const id of item.modes) {
        if (host?.reserveMatch) {
          tickets = host.reserveMatch(id, size, MATCH_MS);
          if (tickets) { mode = id; break; }
          continue;
        }
        const slot = host?.rooms?.get?.(id);
        const cap = Number(slot?.room?.mode?.slots) || 0;
        const regionalCap = Number(host?.regionCap) || 20;
        if (cap > 0 && regional + size <= regionalCap
            && (Number(roomCounts[id]) || 0) + (held[id] || 0) + size <= cap) {
          mode = id;
          tickets = Array(size).fill(null);
          held[id] = (held[id] || 0) + size;
          regional += size;
          break;
        }
      }
      if (!mode) { i++; continue; }
      const expires = now() + MATCH_MS;
      [...party.members].forEach((account, index) => {
        matches.set(account, { mode, expires, ...(tickets[index] ? { ticket: tickets[index] } : {}) });
      });
      queue.splice(i, 1);
    }
  }

  function publicState(account) {
    runQueue();
    const me = sessionOf(account);
    if (!me) throw new Error('social_session_invalid');
    const party = partyOf(account);
    const queued = party ? queue.find((item) => item.party === party.id) : null;
    const presentFriend = (id) => {
      const s = sessionOf(id);
      return { code: codeOf(id), name: s?.name ?? 'offline player', online: Boolean(s), status: s?.status ?? 'offline' };
    };
    return {
      self: { code: codeOf(account), name: me.name, status: me.status },
      friends: [...(friends.get(account) ?? [])].map(presentFriend),
      requests: [...(requests.get(account) ?? [])].map(presentFriend),
      invites: [...(partyInvites.get(account) ?? [])].map(presentFriend),
      party: party ? {
        leader: codeOf(party.leader),
        members: [...party.members].map((id) => presentFriend(id)),
      } : null,
      queue: queued ? { modes: queued.modes, since: queued.since } : null,
      match: matches.get(account) ?? null,
      limits: { party: MAX_PARTY },
    };
  }

  function open(account, name) {
    sweep();
    const old = byAccount.get(account);
    if (old) sessions.delete(old);
    const token = makeToken();
    sessions.set(token, { account, name: cleanName(name), seen: now(), status: 'lobby' });
    byAccount.set(account, token);
    return { token, state: publicState(account) };
  }

  function authenticate(token) {
    sweep();
    const session = sessions.get(String(token ?? ''));
    if (!session) throw new Error('social_session_invalid');
    session.seen = now();
    return session;
  }

  function state(token) {
    const session = authenticate(token);
    return publicState(session.account);
  }

  function action(token, raw = {}) {
    const session = authenticate(token);
    const account = session.account;
    const actionName = String(raw.action ?? '');
    const code = cleanCode(raw.code);
    const known = new Set([
      ...byAccount.keys(),
      ...(friends.get(account) ?? []),
      ...(requests.get(account) ?? []),
      ...(partyInvites.get(account) ?? []),
    ]);
    const target = [...known].find((id) => codeOf(id) === code);

    if (actionName === 'presence') {
      session.status = ['lobby', 'queued', 'playing'].includes(raw.status) ? raw.status : 'lobby';
      if (session.status === 'playing') matches.delete(account);
    } else if (actionName === 'friend_request') {
      if (!target || target === account) throw new Error('social_player_unavailable');
      if (!friends.get(account)?.has(target)) setOf(requests, target).add(account);
    } else if (actionName === 'friend_accept') {
      if (!target || !requests.get(account)?.has(target)) throw new Error('social_request_missing');
      requests.get(account).delete(target);
      setOf(friends, account).add(target);
      setOf(friends, target).add(account);
    } else if (actionName === 'friend_remove') {
      if (!target) throw new Error('social_player_unavailable');
      friends.get(account)?.delete(target);
      friends.get(target)?.delete(account);
    } else if (actionName === 'party_invite') {
      if (!target || !friends.get(account)?.has(target)) throw new Error('social_friend_required');
      let party = partyOf(account);
      if (!party) {
        party = { id: makeToken(), leader: account, members: new Set([account]) };
        parties.set(party.id, party);
        memberParty.set(account, party.id);
      }
      if (party.leader !== account) throw new Error('social_leader_required');
      if (party.members.size >= MAX_PARTY) throw new Error('social_party_full');
      setOf(partyInvites, target).add(account);
    } else if (actionName === 'party_accept') {
      if (!target || !partyInvites.get(account)?.has(target)) throw new Error('social_invite_missing');
      const party = partyOf(target);
      if (!party || party.members.size >= MAX_PARTY) throw new Error('social_party_full');
      leaveParty(account);
      party.members.add(account);
      memberParty.set(account, party.id);
      partyInvites.get(account).clear();
    } else if (actionName === 'party_leave') {
      leaveParty(account);
    } else if (actionName === 'queue') {
      let party = partyOf(account);
      if (!party) {
        party = { id: makeToken(), leader: account, members: new Set([account]) };
        parties.set(party.id, party);
        memberParty.set(account, party.id);
      }
      if (party.leader !== account) throw new Error('social_leader_required');
      if ([...party.members].some((id) => !sessionOf(id))) throw new Error('social_party_offline');
      const available = new Set(host?.available ?? []);
      const modes = [...new Set((Array.isArray(raw.modes) ? raw.modes : []).filter((id) => available.has(id)))];
      if (!modes.length) throw new Error('social_mode_invalid');
      leaveQueue(party.id);
      matches.delete(account);
      queue.push({ party: party.id, modes, since: now() });
      for (const id of party.members) sessionOf(id).status = 'queued';
    } else if (actionName === 'cancel') {
      const party = partyOf(account);
      if (!party || party.leader !== account) throw new Error('social_leader_required');
      leaveQueue(party.id);
      for (const id of party.members) {
        const s = sessionOf(id); if (s) s.status = 'lobby';
        matches.delete(id);
      }
    } else {
      throw new Error('social_action_invalid');
    }
    runQueue();
    return publicState(account);
  }

  return { open, state, action, get sessions() { return sessions.size; }, codeOf };
}
