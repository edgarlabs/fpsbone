// The two combat silhouettes. They are faction assignments, not purchasable skins:
// team 1 is Sentinel, team 2 is Raider, and free-for-all divides the room by player id.
// This keeps two readable body types while preventing cosmetics from hiding allegiance.

export const OPERATORS = Object.freeze({
  sentinel: Object.freeze({
    id: 'sentinel',
    label: 'SENTINEL',
    role: 'foundry security',
    primary: 0x315f82,
    secondary: 0x1d3548,
    cloth: 0x5e7682,
    gear: 0x18232b,
    accent: 0x58c8c7,
    skin: 0xa97856,
  }),
  raider: Object.freeze({
    id: 'raider',
    label: 'RAIDER',
    role: 'breach unit',
    primary: 0x9a5c28,
    secondary: 0x4a3323,
    cloth: 0x74644b,
    gear: 0x211d1a,
    accent: 0xe2a44d,
    skin: 0x996846,
  }),
});

export const OPERATOR_IDS = Object.freeze(Object.keys(OPERATORS));

export function operatorIdFor(team, playerId = 0) {
  if (team === 1) return 'sentinel';
  if (team === 2) return 'raider';
  return Math.abs(Number(playerId) || 0) % 2 ? 'sentinel' : 'raider';
}

export function operatorFor(team, playerId = 0) {
  return OPERATORS[operatorIdFor(team, playerId)];
}

