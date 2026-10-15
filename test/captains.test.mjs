import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, rollDice, movePiece, autoTurn, useItem, useSkill, acceptRoll, allianceAction, setAfk, skipAfk } from '../engine.mjs';
import { CAPTAINS, FINISH, TAKEOFF, normalizeRules } from '../board.mjs';

const quietRules = { captains: true, speed: false, trap: false, safe: false, lucky: false, ice: false, captureEffects: false };
const zero = () => 0;
const game = (keys = ['flash', 'shield'], rules = {}) => createGame(keys.map((captain, seat) => ({ seat, captain })), { mode: 'fun', rules: { ...quietRules, ...rules } });
const result = (g, seat) => g.players.find(player => player.seat === seat);
function turn(g, seat) { g.turn = seat; g.phase = 'roll'; g.dice = null; g.legal = []; g.sixes = 0; }
function rejected(g, action) { const before = structuredClone(g); assert.throws(action); assert.deepEqual(g, before, 'rejected action must be atomic'); }
function hitAvenger(g) {
  g.pieces[0][0] = 4;
  g.pieces[1][0] = 42; // red progress 43 shares green progress 4.
  turn(g, 1);
  rollDice(g, 1, 1); movePiece(g, 1, 0, zero);
  assert.equal(g.pieces[0][0], -1);
}

test('captains: rule dependencies are explicit and classic keeps all optional rules disabled', () => {
  assert.deepEqual(CAPTAINS.map(captain => captain.key), ['flash', 'shield', 'betrayer', 'avenger', 'gambler']);
  const fun = normalizeRules('fun', { captains: true, items: false, alliances: false });
  assert.equal(fun.captains, true); assert.equal(fun.items, true); assert.equal(fun.alliances, true);
  assert.equal(normalizeRules('fun').captains, false);
  assert.ok(Object.values(normalizeRules('classic', { captains: true })).every(value => value === false));
});

test('captains: all five selections are valid, duplicates are allowed and missing selections reject', () => {
  for (const { key, maxUses } of CAPTAINS) {
    const g = game([key, key]);
    assert.equal(g.captains[0].key, key); assert.equal(g.captains[1].key, key);
    assert.equal(g.captains[2], null); assert.equal(g.captains[3], null);
    assert.equal(g.captains[0].used, false);
    for (const seat of [0, 1]) {
      assert.equal(g.captains[seat].uses, maxUses);
      assert.equal(g.captains[seat].maxUses, maxUses);
    }
  }
  for (const captain of [undefined, null, '', 'invented']) {
    assert.throws(() => createGame([{ seat: 0, captain }, { seat: 1, captain: 'flash' }], { mode: 'fun', rules: quietRules }));
  }
});

test('captains: disabled games retain the old shape and cannot invoke passives or actives', () => {
  for (const mode of ['classic', 'fun']) {
    const g = createGame([{ seat: 0, captain: 'gambler' }, { seat: 1, captain: 'shield' }], { mode, rules: { captains: false } });
    assert.equal(Object.hasOwn(g, 'captains'), false);
    assert.equal(Object.hasOwn(g, 'steps'), false);
    rejected(g, () => useSkill(g, 0));
    rollDice(g, 0, 1, zero);
    assert.equal(g.turn, 1);
    assert.equal(g.rollCount, 1);
  }
});

test('captains: flash adds three after the normal move without chaining its special landing', () => {
  const g = game(['flash', 'shield'], { speed: true });
  g.pieces[0][0] = 3;
  rollDice(g, 0, 1); useSkill(g, 0); movePiece(g, 0, 0, zero);
  assert.equal(g.pieces[0][0], 7, 'landing on speed by flash cannot trigger another +2');
  assert.equal(g.captains[0].used, false); assert.equal(g.captains[0].uses, 2); assert.equal(g.captains[0].flashReady, false);
  assert.equal(g.turn, 1);
  assert.ok(g.lastMove.events.some(event => event.type === 'SKILL_FLASH'));
});

test('captains: flash stops before a wall and does not break it', () => {
  const g = game(); g.pieces[0][0] = 3; g.pieces[1] = [45, 45, -1, -1];
  rollDice(g, 0, 1); useSkill(g, 0); movePiece(g, 0, 0, zero);
  assert.equal(g.pieces[0][0], 5); assert.deepEqual(g.pieces[1].slice(0, 2), [45, 45]);
  assert.deepEqual(g.lastMove.captured, []); assert.equal(result(g, 0).stats.red, 0);
});

test('captains: flash cannot arm an airport-only move and invalid activation spends nothing', () => {
  const g = game(); rejected(g, () => useSkill(g, 0));
  rollDice(g, 0, 2); rejected(g, () => useSkill(g, 0));
  assert.equal(g.captains[0].used, false); movePiece(g, 0, 0);
  assert.equal(g.pieces[0][0], TAKEOFF);
});

test('captains: flash adds one actual step only for a raw six', () => {
  for (const dice of [1, 2, 3, 4, 5, 6]) {
    const g = game(); g.pieces[0][0] = 4;
    rollDice(g, 0, dice);
    assert.equal(g.dice, dice); assert.equal(g.steps, dice === 6 ? 7 : dice);
    assert.equal(g.captains[0].used, false, 'the passive must not spend the active');
  }
});

test('captains: other captains and disabled classic or fun games retain six-step movement', () => {
  for (const key of ['shield', 'betrayer', 'avenger', 'gambler']) {
    const g = game([key, 'flash']); g.pieces[0][0] = 5;
    rollDice(g, 0, 6); assert.equal(g.dice, 6); assert.equal(g.steps, 6);
    movePiece(g, 0, 0, zero); assert.equal(g.pieces[0][0], 11); assert.equal(g.turn, 0);
  }
  for (const [mode, captains] of [['classic', true], ['fun', false]]) {
    const g = createGame([{ seat: 0, captain: 'flash' }, { seat: 1, captain: 'shield' }], { mode, rules: { ...quietRules, captains } });
    g.pieces[0][0] = 5; rollDice(g, 0, 6);
    assert.equal(g.dice, 6); assert.equal(Object.hasOwn(g, 'steps'), false);
    movePiece(g, 0, 0, zero); assert.equal(g.pieces[0][0], 11); assert.equal(g.turn, 0);
  }
});

test('captains: flash raw six launches only to the apron and its next six enters the ring with seven steps', () => {
  const g = game(); rollDice(g, 0, 6);
  assert.equal(g.steps, 7); assert.deepEqual(g.legal, [0, 1, 2, 3]);
  movePiece(g, 0, 0, zero); assert.equal(g.pieces[0][0], TAKEOFF); assert.equal(g.turn, 0);
  rollDice(g, 0, 6); assert.equal(g.steps, 7); movePiece(g, 0, 0, zero);
  assert.equal(g.pieces[0][0], 7); assert.equal(g.turn, 0); assert.equal(g.sixes, 2);
});

test('captains: flash raw six can thaw only the selected plane while raw five cannot thaw it', () => {
  const g = game(); g.pieces[0] = [4, 7, -1, -1]; g.frozenPieces[0][0] = true;
  rollDice(g, 0, 5); assert.equal(g.steps, 5); assert.equal(g.legal.includes(0), false); assert.ok(g.legal.includes(1));
  rejected(g, () => movePiece(g, 0, 0, zero));
  turn(g, 0); rollDice(g, 0, 6); assert.equal(g.steps, 7); assert.ok(g.legal.includes(0));
  movePiece(g, 0, 2, zero); assert.equal(g.pieces[0][2], TAKEOFF); assert.equal(g.frozenPieces[0][0], true);
  rollDice(g, 0, 6); movePiece(g, 0, 0, zero);
  assert.equal(g.pieces[0][0], 11); assert.equal(g.frozenPieces[0][0], false); assert.equal(g.turn, 0);
});

test('captains: flash six passive stacks with the active and exhausts after three uses', () => {
  const g = game(); g.pieces[0][0] = 4; rollDice(g, 0, 6);
  assert.equal(g.steps, 7); useSkill(g, 0); movePiece(g, 0, 0, zero);
  assert.equal(g.pieces[0][0], 14); assert.deepEqual(g.lastMove.path, [11, 14]);
  assert.ok(g.lastMove.events.some(event => event.type === 'SKILL_FLASH'));
  assert.equal(g.captains[0].used, false); assert.equal(g.captains[0].uses, 2); assert.equal(g.turn, 0);
  rollDice(g, 0, 6); assert.equal(g.steps, 7);
  useSkill(g, 0); movePiece(g, 0, 0, zero);
  assert.equal(g.captains[0].uses, 1); assert.equal(g.captains[0].used, false);
  rollDice(g, 0, 6); assert.equal(g.steps, 7);
  useSkill(g, 0); movePiece(g, 0, 0, zero);
  assert.equal(g.captains[0].uses, 0); assert.equal(g.captains[0].used, true);
  rollDice(g, 0, 6); assert.equal(g.steps, 7); rejected(g, () => useSkill(g, 0));
});

test('captains: flash seven actual steps break a wall at distance seven and bounce at distance six', () => {
  for (const [from, outcome] of [[3, 'break'], [4, 'bounce']]) {
    const g = game(); g.pieces[0][0] = from; g.pieces[1] = [49, 49, -1, -1]; // physical green progress 10.
    rollDice(g, 0, 6); assert.equal(g.steps, 7); movePiece(g, 0, 0, zero);
    if (outcome === 'break') {
      assert.equal(g.pieces[0][0], -1); assert.deepEqual(g.pieces[1].slice(0, 2), [-1, -1]);
      assert.equal(result(g, 0).stats.red, 2); assert.equal(result(g, 0).stats.green, 1);
      assert.ok(g.lastMove.events.some(event => event.type === 'WALL_BREAK'));
    } else {
      assert.equal(g.pieces[0][0], 8); assert.deepEqual(g.lastMove.path, [9, 8]);
      assert.deepEqual(g.pieces[1].slice(0, 2), [49, 49]); assert.equal(result(g, 0).stats.green, 0);
      assert.ok(g.lastMove.events.some(event => event.type === 'WALL_BOUNCE'));
    }
    assert.equal(g.turn, 0);
  }
});

test('captains: flash seven-step finish overshoot rebounds and an exact finish ranks without an extra roll', () => {
  const g = game(); g.pieces[0][0] = 54;
  rollDice(g, 0, 6); assert.equal(g.steps, 7); movePiece(g, 0, 0, zero);
  assert.equal(g.pieces[0][0], 53); assert.equal(g.turn, 0); assert.equal(result(g, 0).rank, null);
  const h = game(['flash', 'shield', 'gambler']); h.pieces[0] = [FINISH, FINISH, FINISH, 50];
  rollDice(h, 0, 6); assert.equal(h.steps, 7); movePiece(h, 0, 3, zero);
  assert.equal(result(h, 0).rank, 1); assert.equal(h.status, 'playing'); assert.equal(h.turn, 1); assert.equal(h.sixes, 0);
  rejected(h, () => rollDice(h, 0, 6));
  rollDice(h, 1, 1); assert.equal(h.turn, 2); rollDice(h, 2, 1); acceptRoll(h, 2);
  assert.equal(h.turn, 1, 'round rotation must skip the finished flash player');
});

test('captains: automatic flash six movement applies seven steps and never spends the optional active', () => {
  const g = game(); g.pieces[0][0] = 4; setAfk(g, 0, true); autoTurn(g, 6, zero);
  assert.equal(g.pieces[0][0], 11); assert.equal(g.turn, 0); assert.equal(g.captains[0].used, false);
  assert.ok(g.keyEvents.some(event => event.type === 'AUTO_TURN'));
  const h = game(); autoTurn(h, 6, zero); assert.equal(h.pieces[0][0], TAKEOFF);
  autoTurn(h, 6, zero); assert.equal(h.pieces[0][0], 7); assert.equal(h.sixes, 2); assert.equal(h.captains[0].used, false);
});

test('captains: flash arrival uses normal ranking and a completed player never receives a sixth-point extra turn', () => {
  const g = game(['flash', 'shield', 'gambler']);
  g.pieces[0] = [FINISH, FINISH, FINISH, 47];
  rollDice(g, 0, 6); useSkill(g, 0); movePiece(g, 0, 3, zero);
  assert.equal(g.pieces[0][3], FINISH); assert.equal(result(g, 0).rank, 1);
  assert.equal(g.status, 'playing'); assert.equal(g.turn, 1); assert.equal(g.sixes, 0);
  assert.equal(g.captains[0].flashReady, false);
});

test('captains: shield absorbs one collision without a capture, revenge source or score', () => {
  const g = game(['shield', 'flash']); g.pieces[0][0] = 4;
  useSkill(g, 0, { piece: 0 }); g.pieces[1][0] = 42; turn(g, 1);
  rollDice(g, 1, 1); movePiece(g, 1, 0, zero);
  assert.equal(g.pieces[0][0], 4); assert.equal(g.shields[0][0], false);
  assert.equal(g.reserveSteps[0][0], false); assert.deepEqual(g.lastMove.captured, []);
  assert.equal(result(g, 1).stats.green, 0);
  assert.ok(g.lastMove.events.some(event => event.type === 'SHIELD_BLOCK'));
});

test('captains: safe-island coexistence leaves shields intact because no collision occurs', () => {
  const g = game(['shield', 'flash'], { safe: true }); g.pieces[0][0] = 2;
  useSkill(g, 0, { piece: 0 }); g.pieces[1][0] = 40; turn(g, 1);
  rollDice(g, 1, 1); movePiece(g, 1, 0, zero);
  assert.equal(g.pieces[0][0], 2); assert.equal(g.shields[0][0], true);
  assert.equal(g.pieces[1][0], 41); assert.deepEqual(g.lastMove.captured, []);
  assert.equal(g.lastMove.events.some(event => event.type === 'SHIELD_BLOCK'), false);
});

test('captains: shield blocks a missile while the attacker still spends the card and round allowance', () => {
  const g = game(['shield', 'flash']); g.pieces[0][0] = 4;
  useSkill(g, 0, { piece: 0 }); g.pieces[1][0] = 41; turn(g, 1);
  useItem(g, 1, { card: 'missile', piece: 0, targetSeat: 0, targetPiece: 0 }, zero);
  assert.equal(g.pieces[0][0], 4); assert.equal(g.shields[0][0], false);
  assert.equal(result(g, 1).stats.green, 0); assert.deepEqual(g.lastMove.captured, []);
  assert.deepEqual(g.hands[1], ['stun', 'mine']); assert.equal(g.itemUsed[1], true);
});

test('captains: shield absorbs a mine without a return or owner score and the triggered mine disappears', () => {
  const g = game(['shield', 'flash']); g.pieces[0][0] = 3;
  useSkill(g, 0, { piece: 0 }); g.mines.push({ seat: 1, index: 4 });
  rollDice(g, 0, 1); movePiece(g, 0, 0, zero);
  assert.equal(g.pieces[0][0], 4); assert.equal(g.shields[0][0], false);
  assert.equal(g.lastMove.selfReturned, false); assert.equal(g.reserveSteps[0][0], false);
  assert.equal(result(g, 1).stats.green, 0); assert.deepEqual(g.mines, []);
});

test('captains: shield cannot save its owner from an intentional wall break', () => {
  const g = game(['shield', 'flash']); g.pieces[0][0] = 3; g.pieces[1] = [43, 43, -1, -1];
  useSkill(g, 0, { piece: 0 }); rollDice(g, 0, 1); movePiece(g, 0, 0, zero);
  assert.equal(g.pieces[0][0], -1); assert.deepEqual(g.pieces[1].slice(0, 2), [-1, -1]);
  assert.equal(g.shields[0][0], false); assert.equal(g.reserveSteps[0][0], true);
  assert.equal(result(g, 0).stats.red, 2); assert.equal(result(g, 0).stats.green, 1);
});

test('captains: shield reserve survives launch and adds one only when the apron enters the ring', () => {
  const g = game(['shield', 'flash']); hitAvenger(g);
  assert.equal(g.reserveSteps[0][0], true);
  turn(g, 0); rollDice(g, 0, 2); movePiece(g, 0, 0, zero);
  assert.equal(g.pieces[0][0], TAKEOFF); assert.equal(g.reserveSteps[0][0], true);
  turn(g, 0); rollDice(g, 0, 3); movePiece(g, 0, 0, zero);
  assert.equal(g.pieces[0][0], 4); assert.equal(g.reserveSteps[0][0], false);
  turn(g, 0); rollDice(g, 0, 3); movePiece(g, 0, 0, zero);
  assert.equal(g.pieces[0][0], 7, 'the reserve cannot apply repeatedly');
});

test('captains: shield target validation rejects airport, apron, finished and invalid indexes atomically', () => {
  for (const progress of [-1, TAKEOFF, FINISH]) {
    const g = game(['shield', 'flash']); g.pieces[0][0] = progress;
    rejected(g, () => useSkill(g, 0, { piece: 0 }));
  }
  const g = game(['shield', 'flash']); g.pieces[0][0] = 51;
  for (const piece of [-1, 4, null, '0']) rejected(g, () => useSkill(g, 0, { piece }));
  useSkill(g, 0, { piece: 0 }); assert.equal(g.shields[0][0], true);
  assert.equal(g.captains[0].uses, 1); assert.equal(g.captains[0].used, false);
  rejected(g, () => useSkill(g, 0, { piece: 0 }));
  g.pieces[0][1] = 10;
  useSkill(g, 0, { piece: 1 }); assert.equal(g.shields[0][1], true);
  assert.equal(g.captains[0].uses, 0); assert.equal(g.captains[0].used, true);
  g.pieces[0][2] = 20;
  rejected(g, () => useSkill(g, 0, { piece: 2 }));
});

test('captains: allied swap converts physical positions and preserves each plane identity and effects', () => {
  const g = game(['betrayer', 'shield'], { speed: true, lucky: true });
  g.pieces[0][0] = 4; g.pieces[1][1] = 11; // physical 24 is a lucky space.
  g.frozenPieces[0][0] = true; g.shields[1][1] = true; g.reserveSteps[0][0] = true;
  allianceAction(g, 0, 'alliance-invite', 1); allianceAction(g, 1, 'alliance-accept', 0);
  g.mines.push({ seat: 1, index: 4 });
  const statuses = structuredClone({ frozen: g.frozenPieces, shields: g.shields, reserves: g.reserveSteps });
  useSkill(g, 0, { piece: 0, targetSeat: 1, targetPiece: 1 }, undefined, zero);
  assert.equal(g.pieces[0][0], 24); assert.equal(g.pieces[1][1], 43);
  assert.deepEqual({ frozen: g.frozenPieces, shields: g.shields, reserves: g.reserveSteps }, statuses);
  assert.deepEqual(g.lastMove.captured, []); assert.deepEqual(g.lastMove.effects, []);
  assert.equal(g.mines.length, 1); assert.equal(g.turn, 0); assert.equal(g.phase, 'roll');
});

test('captains: swap refuses non-allies, private positions and unmappable ring cells without spending', () => {
  const g = game(['betrayer', 'shield']); g.pieces[0][0] = 4; g.pieces[1][0] = 3;
  rejected(g, () => useSkill(g, 0, { piece: 0, targetSeat: 1, targetPiece: 0 }));
  allianceAction(g, 0, 'alliance-invite', 1); allianceAction(g, 1, 'alliance-accept', 0);
  for (const progress of [-1, TAKEOFF, 51, FINISH, 38]) {
    g.pieces[1][0] = progress;
    rejected(g, () => useSkill(g, 0, { piece: 0, targetSeat: 1, targetPiece: 0 }));
  }
});

test('captains: betrayer steals at most one card for a multi-landing multi-plane attack', () => {
  const g = game(['betrayer', 'shield']); g.pieces[0][0] = 20; g.pieces[1] = [9, 13, -1, -1];
  g.hands[0] = ['mine']; g.hands[1] = ['stun', 'missile'];
  rollDice(g, 0, 2); movePiece(g, 0, 0, zero);
  assert.equal(g.lastMove.captured.length, 2); assert.deepEqual(g.hands[0], ['mine', 'stun']);
  assert.deepEqual(g.hands[1], ['missile']);
  assert.equal(g.lastMove.events.filter(event => event.type === 'ITEM_STOLEN').length, 1);
  const theft = g.keyEvents.find(event => event.type === 'ITEM_STOLEN');
  assert.ok(theft); assert.doesNotMatch(theft.text, /stun|mine|missile|定身|地雷|导弹/);
});

test('captains: full hands, empty victims, shield absorption and safe coexistence do not steal cards', () => {
  for (const scenario of ['full', 'empty', 'shield', 'safe']) {
    const g = game(['betrayer', 'shield'], { safe: scenario === 'safe' });
    const landing = scenario === 'safe' ? 2 : 4;
    g.pieces[0][0] = landing - 1; g.pieces[1][0] = (landing - 13 + 52) % 52;
    if (scenario !== 'full') g.hands[0] = [];
    if (scenario === 'empty') g.hands[1] = [];
    if (scenario === 'shield') g.shields[1][0] = true;
    const cards = structuredClone(g.hands);
    rollDice(g, 0, 1); movePiece(g, 0, 0, zero);
    assert.deepEqual(g.hands, cards, scenario);
    assert.equal(g.lastMove.events.some(event => event.type === 'ITEM_STOLEN'), false);
  }
});

test('captains: betrayal passive works on wall, missile and off-turn mine attacks once each', () => {
  for (const attack of ['wall', 'missile', 'mine']) {
    const g = game(['betrayer', 'flash']); g.hands[0] = ['mine', 'missile']; g.hands[1] = ['stun', 'mine'];
    if (attack === 'wall') {
      g.pieces[0][0] = 3; g.pieces[1] = [43, 43, -1, -1];
      rollDice(g, 0, 1); movePiece(g, 0, 0, zero);
    } else if (attack === 'missile') {
      g.pieces[0][0] = 3; g.pieces[1][0] = 43;
      useItem(g, 0, { card: 'missile', piece: 0, targetSeat: 1, targetPiece: 0 }, zero);
    } else {
      g.pieces[0][0] = 4; useItem(g, 0, { card: 'mine', piece: 0 }, zero);
      g.pieces[1][0] = 42; turn(g, 1); rollDice(g, 1, 1); movePiece(g, 1, 0, zero);
    }
    assert.deepEqual(g.hands[1], ['mine'], attack);
    assert.ok(g.hands[0].includes('stun'), attack);
    assert.equal(g.keyEvents.filter(event => event.type === 'ITEM_STOLEN').length, 1, attack);
  }
});

test('captains: avenger records a real aircraft attacker and next-round +2 preserves raw launch and thaw rules', () => {
  const g = game(['avenger', 'flash']); hitAvenger(g);
  assert.deepEqual(g.captains[0].attackers, [{ seat: 1, piece: 0 }]);
  g.pieces[0][1] = 3; g.pieces[0][2] = 8; g.frozenPieces[0][2] = true;
  rollDice(g, 0, 4); assert.equal(g.dice, 4); assert.equal(g.steps, 6);
  assert.ok(g.legal.includes(0)); assert.ok(g.legal.includes(1)); assert.equal(g.legal.includes(2), false);
  movePiece(g, 0, 1, zero); assert.equal(g.pieces[0][1], 9); assert.equal(g.turn, 1);
});

test('captains: avenger +2 uses actual wall distance and raw six alone grants the extra roll', () => {
  const g = game(['avenger', 'flash']); hitAvenger(g); g.pieces[0][1] = 3; g.pieces[1] = [44, 44, -1, -1];
  rollDice(g, 0, 3); assert.equal(g.steps, 5); movePiece(g, 0, 1, zero);
  assert.equal(g.pieces[0][1], 1, 'actual five steps bounce at distance two');
  assert.equal(g.turn, 1);
  const h = game(['avenger', 'flash']); hitAvenger(h); h.pieces[0][1] = 3;
  rollDice(h, 0, 6); assert.equal(h.steps, 8); movePiece(h, 0, 1, zero);
  assert.equal(h.turn, 0); rollDice(h, 0, 2); assert.equal(h.steps, 2, 'repeat six is not another first roll');
});

test('captains: avenger tracks missile source but ignores shielded attacks and deduplicates attackers', () => {
  const g = game(['avenger', 'flash']); g.pieces[0][0] = 4; g.pieces[1][2] = 41; turn(g, 1);
  useItem(g, 1, { card: 'missile', piece: 2, targetSeat: 0, targetPiece: 0 }, zero);
  assert.deepEqual(g.captains[0].attackers, [{ seat: 1, piece: 2 }]);
  const h = game(['avenger', 'flash']); h.pieces[0][0] = 4; h.shields[0][0] = true;
  h.pieces[1][0] = 42; turn(h, 1); rollDice(h, 1, 1); movePiece(h, 1, 0, zero);
  assert.deepEqual(h.captains[0].attackers, []); assert.equal(h.captains[0].bonusReady, 0);
  g.pieces[0][0] = 4; g.pieces[1][2] = 42; turn(g, 1); rollDice(g, 1, 1); movePiece(g, 1, 2, zero);
  assert.deepEqual(g.captains[0].attackers, [{ seat: 1, piece: 2 }]);
});

test('captains: revenge lock accepts only a former attacker and replaces the next outer-ring move', () => {
  const g = game(['avenger', 'flash']); hitAvenger(g); g.pieces[0][1] = 20;
  rejected(g, () => useSkill(g, 0, { targetSeat: 1, targetPiece: 1 }));
  useSkill(g, 0, { targetSeat: 1, targetPiece: 0 }); rollDice(g, 0, 1); movePiece(g, 0, 1, zero);
  assert.equal(g.pieces[0][1], 4); assert.equal(g.pieces[1][0], -1);
  assert.equal(g.captains[0].revengeTarget, null); assert.equal(result(g, 0).stats.red, 1);
  assert.ok(g.lastMove.events.some(event => event.type === 'REVENGE_CHASE'));
});

test('captains: returned former attackers can be marked and completed targets cannot be marked', () => {
  const g = game(['avenger', 'flash', 'shield']);
  g.captains[0].attackers.push({ seat: 1, piece: 0 });
  useSkill(g, 0, { targetSeat: 1, targetPiece: 0 });
  assert.deepEqual(g.captains[0].revengeTarget, { seat: 1, piece: 0 });
  const h = game(['avenger', 'flash', 'shield']); h.captains[0].attackers.push({ seat: 1, piece: 0 });
  result(h, 1).rank = 1; rejected(h, () => useSkill(h, 0, { targetSeat: 1, targetPiece: 0 }));
});

test('captains: unavailable revenge target or an apron move keeps the lock for a future valid chase', () => {
  for (const scenario of ['airport', 'target-returned', 'allied', 'unmappable']) {
    const g = game(['avenger', 'flash']); hitAvenger(g);
    useSkill(g, 0, { targetSeat: 1, targetPiece: 0 });
    const lock = structuredClone(g.captains[0].revengeTarget);
    let piece = 0;
    if (scenario !== 'airport') { piece = 1; g.pieces[0][1] = 3; }
    if (scenario === 'target-returned') g.pieces[1][0] = -1;
    if (scenario === 'allied') { allianceAction(g, 0, 'alliance-invite', 1); allianceAction(g, 1, 'alliance-accept', 0); }
    if (scenario === 'unmappable') g.pieces[1][0] = 38; // physical 51 is outside green's ring route.
    rollDice(g, 0, 2); movePiece(g, 0, piece, zero);
    assert.deepEqual(g.captains[0].revengeTarget, lock, scenario);
    assert.equal(g.lastMove.events.some(event => event.type === 'REVENGE_CHASE'), false, scenario);
  }
});

test('captains: revenge destination respects safe islands, shields and walls without triggering colour rewards', () => {
  for (const protection of ['safe', 'shield', 'wall']) {
    const g = game(['avenger', 'flash'], { safe: protection === 'safe' });
    g.captains[0].attackers.push({ seat: 1, piece: 0 }); g.pieces[0][0] = 20;
    const destination = protection === 'safe' ? 2 : 4;
    g.pieces[1][0] = (destination - 13 + 52) % 52;
    if (protection === 'shield') g.shields[1][0] = true;
    if (protection === 'wall') g.pieces[1][1] = g.pieces[1][0];
    useSkill(g, 0, { targetSeat: 1, targetPiece: 0 }); rollDice(g, 0, 1); movePiece(g, 0, 0, zero);
    if (protection === 'wall') {
      assert.equal(g.pieces[0][0], -1); assert.equal(g.lastMove.captured.length, 2);
    } else {
      assert.equal(g.pieces[0][0], destination); assert.notEqual(g.pieces[1][0], -1);
      assert.deepEqual(g.lastMove.captured, []); assert.equal(result(g, 0).stats.red, 0);
    }
  }
});

test('captains: gambler reroll keeps only final dice repeat entitlement and is limited to one use', () => {
  for (const [initial, replacement, expectedTurn] of [[6, 2, 1], [2, 6, 0], [6, 6, 0]]) {
    const g = game(['gambler', 'flash']); g.pieces[0][0] = 3;
    rollDice(g, 0, initial, zero); useSkill(g, 0, {}, () => replacement, zero);
    assert.equal(g.dice, replacement); assert.equal(g.steps, replacement); assert.equal(g.rollCount, 2);
    assert.equal(g.sixes, replacement === 6 ? 1 : 0);
    rejected(g, () => useSkill(g, 0, {}, () => 6, zero)); movePiece(g, 0, 0, zero);
    assert.equal(g.turn, expectedTurn);
  }
});

test('captains: gambler raw ones draw for both actual rolls, retain the old draw and obey the three-card limit', () => {
  const g = game(['gambler', 'flash']); g.hands[0] = [];
  rollDice(g, 0, 1, zero); assert.deepEqual(g.hands[0], ['stun']);
  useSkill(g, 0, {}, () => 1, () => 2); assert.deepEqual(g.hands[0], ['stun', 'missile']);
  assert.equal(g.turn, 1); assert.equal(g.rollCount, 2);
  const h = game(['gambler', 'flash']); h.hands[0] = ['stun', 'mine'];
  rollDice(h, 0, 1, () => 2); assert.deepEqual(h.hands[0], ['stun', 'mine', 'missile']);
  useSkill(h, 0, {}, () => 1, zero); assert.equal(h.hands[0].length, 3);
});

test('captains: gambler can accept an unplayable first roll or reroll it without phantom movement', () => {
  const g = game(['gambler', 'flash']); rollDice(g, 0, 3);
  assert.equal(g.turn, 0); assert.equal(g.phase, 'move'); assert.deepEqual(g.legal, []);
  const before = structuredClone(g.pieces); acceptRoll(g, 0);
  assert.equal(g.turn, 1); assert.equal(g.rollCount, 1); assert.deepEqual(g.pieces, before);
  assert.equal(g.captains[0].used, false);
  const h = game(['gambler', 'flash']); rollDice(h, 0, 3); useSkill(h, 0, {}, () => 2, zero);
  assert.equal(h.turn, 0); assert.deepEqual(h.legal, [0, 1, 2, 3]); movePiece(h, 0, 0, zero);
  assert.equal(h.pieces[0][0], TAKEOFF); assert.equal(h.rollCount, 2);
});

test('captains: reroll contributes to the shared twentieth-roll ice refresh and keeps the item limit', () => {
  const g = game(['gambler', 'flash'], { ice: true }); g.pieces[0][0] = 3; g.pieces[1][0] = 44; g.rollCount = 18;
  useItem(g, 0, { card: 'mine', piece: 0 }, zero);
  rollDice(g, 0, 6, zero); assert.equal(g.rollCount, 19); assert.equal(g.iceCell, null);
  useSkill(g, 0, {}, () => 6, zero); assert.equal(g.rollCount, 20); assert.notEqual(g.iceCell, null);
  assert.equal(g.itemUsed[0], true); movePiece(g, 0, 0, zero);
  rejected(g, () => useItem(g, 0, { card: 'stun', targetSeat: 1, targetPiece: 0 }, zero));
});

test('captains: enabled skills preserve unlimited sixes and never refresh a used active or item on a repeat', () => {
  const g = game(['flash', 'shield']); g.pieces[0][0] = 3;
  useItem(g, 0, { card: 'mine', piece: 0 }, zero);
  for (let i = 0; i < 5; i++) {
    rollDice(g, 0, 6, zero);
    assert.equal(g.steps, 7, 'every consecutive raw six keeps the flash passive');
    if (i < 3) useSkill(g, 0);
    movePiece(g, 0, 0, zero);
    assert.equal(g.turn, 0); assert.equal(g.sixes, i + 1);
    assert.equal(g.captains[0].used, i >= 2); assert.equal(g.captains[0].uses, Math.max(0, 2 - i)); assert.equal(g.itemUsed[0], true);
  }
  assert.equal(g.rollCount, 5);
});

test('captains: AFK skip drops a prepared flash but preserves the spent active and pending revenge bonus', () => {
  const g = game(['flash', 'avenger']); g.pieces[0][0] = 3;
  rollDice(g, 0, 1); useSkill(g, 0); setAfk(g, 0, true); skipAfk(g, 1, 0, 'move');
  assert.equal(g.pieces[0][0], 3); assert.equal(g.captains[0].used, false); assert.equal(g.captains[0].uses, 2); assert.equal(g.captains[0].flashReady, false);
  g.captains[1].bonusReady = 2; setAfk(g, 1, true); setAfk(g, 0, false); skipAfk(g, 0, 1, 'roll');
  setAfk(g, 1, false); g.pieces[0][1] = 3; rollDice(g, 0, 1); movePiece(g, 0, 1, zero);
  rollDice(g, 1, 1); assert.equal(g.steps, 3, 'skipping without an actual roll cannot consume the pending bonus');
});

test('captains: automatic turns accept unplayable gambler dice and never spend an optional active', () => {
  const g = game(['gambler', 'flash']); autoTurn(g, 3, zero);
  assert.equal(g.turn, 1); assert.equal(g.rollCount, 1); assert.equal(g.captains[0].used, false);
  const h = game(['gambler', 'flash']); rollDice(h, 0, 3); autoTurn(h, 6, zero);
  assert.equal(h.turn, 1); assert.equal(h.rollCount, 1); assert.equal(h.captains[0].used, false);
  const k = game(['flash', 'shield']); k.pieces[0][0] = 3; setAfk(k, 0, true); autoTurn(k, 1, zero);
  assert.equal(k.pieces[0][0], 4); assert.equal(k.captains[0].used, false);
});

test('captains: AFK, ranked, spectator and off-turn actors cannot use skills or accept pending rolls', () => {
  const g = game(['gambler', 'shield']); rollDice(g, 0, 3);
  for (const seat of [null, 2, 1]) rejected(g, () => useSkill(g, seat, {}, () => 2, zero));
  for (const seat of [null, 2, 1]) rejected(g, () => acceptRoll(g, seat));
  setAfk(g, 0, true); rejected(g, () => useSkill(g, 0, {}, () => 2, zero)); rejected(g, () => acceptRoll(g, 0));
  setAfk(g, 0, false); result(g, 0).rank = 1;
  rejected(g, () => useSkill(g, 0, {}, () => 2, zero)); rejected(g, () => acceptRoll(g, 0));
});

test('captains: completing the final plane clears transient skill state and new games start fresh', () => {
  const g = game(['shield', 'avenger', 'gambler']);
  g.pieces[0] = [FINISH, FINISH, FINISH, 56]; useSkill(g, 0, { piece: 3 });
  g.reserveSteps[0][3] = true; g.captains[0].revengeTarget = { seat: 1, piece: 0 };
  rollDice(g, 0, 1); movePiece(g, 0, 3, zero);
  assert.equal(result(g, 0).rank, 1); assert.ok(g.shields[0].every(value => value === false));
  assert.ok(g.reserveSteps[0].every(value => value === false)); assert.equal(g.captains[0].revengeTarget, null);
  const fresh = game(['shield', 'avenger', 'gambler']);
  assert.equal(fresh.captains[0].used, false); assert.ok(fresh.shields.flat().every(value => value === false));
  assert.ok(fresh.reserveSteps.flat().every(value => value === false)); assert.deepEqual(fresh.captains[1].attackers, []);
});

test('captains: gambler reroll can be used 2 times across turns and rejects on third', () => {
  const g = game(['gambler', 'flash']); g.pieces[0][0] = 3;
  for (let i = 0; i < 2; i++) {
    turn(g, 0);
    rollDice(g, 0, 2, zero);
    useSkill(g, 0, {}, () => 4, zero);
    assert.equal(g.dice, 4);
    assert.equal(g.captains[0].uses, 1 - i);
    assert.equal(g.captains[0].used, i === 1);
    movePiece(g, 0, 0, zero);
  }
  turn(g, 0);
  rollDice(g, 0, 2, zero);
  rejected(g, () => useSkill(g, 0, {}, () => 4, zero));
});
