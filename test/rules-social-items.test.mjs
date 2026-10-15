import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, rollDice, movePiece, autoTurn, allianceAction, useItem } from '../engine.mjs';
import { COLORS, STARTS, FINISH, DEFAULT_FUN_RULES, normalizeRules } from '../board.mjs';

const players = [0, 1, 2, 3].map(seat => ({ seat }));
const game = (rules = {}, mode = 'fun') => createGame(players, { mode, rules });
const zeros = () => Object.fromEntries(COLORS.map(color => [color.key, 0]));
const result = (g, seat) => g.players.find(player => player.seat === seat);
const randomIndex = () => 0;

function move(g, seat, from, dice, piece = 0) {
  g.turn = seat;
  g.phase = 'roll';
  g.sixes = 0;
  g.pieces[seat][piece] = from;
  rollDice(g, seat, dice, randomIndex);
  return movePiece(g, seat, piece, randomIndex);
}

function enemyAt(g, progress, seat = 3, count = 1) {
  const p = (progress - STARTS[seat] + 52) % 52;
  assert.ok(p <= 50);
  for (let i = 0; i < count; i++) g.pieces[seat][i] = p;
  return p;
}

function ally(g, from = 0, to = 3) {
  allianceAction(g, from, 'alliance-invite', to);
  allianceAction(g, to, 'alliance-accept', from);
}

test('rules default to the six existing fun features and classic mode disables every feature', () => {
  assert.deepEqual(DEFAULT_FUN_RULES, {
    speed: true, trap: true, safe: true, lucky: true, ice: true, captureEffects: true,
    alliances: false, items: false, captains: false,
  });
  assert.deepEqual(game().rules, DEFAULT_FUN_RULES);
  const classic = game({ alliances: true, items: true }, 'classic');
  assert.deepEqual(classic.rules, Object.fromEntries(Object.keys(DEFAULT_FUN_RULES).map(key => [key, false])));
  assert.deepEqual(classic.hands, Array.from({ length: 4 }, () => []));
});

test('rule normalization rejects unknown fields and non-booleans and snapshots copy the chosen rules', () => {
  for (const invalid of [null, [], 1, 'fun', { speed: 1 }, { speed: 'false' }, { ice: null }, { unknown: true }]) {
    assert.throws(() => normalizeRules('fun', invalid));
    assert.throws(() => createGame(players, { mode: 'fun', rules: invalid }));
  }
  const options = { speed: false, alliances: true };
  const g = game(options);
  options.speed = true;
  options.alliances = false;
  assert.equal(g.rules.speed, false);
  assert.equal(g.rules.alliances, true);
  assert.equal(g.rules.trap, true, 'unspecified switches retain the default');
});

test('disabling speed restores the ordinary landing without the extra two steps', () => {
  const g = game({ speed: false });
  move(g, 0, 5, 2);
  assert.equal(g.pieces[0][0], 7);
  assert.deepEqual(g.lastMove.effects, []);
});

test('disabling traps restores the ordinary colour jump instead of retreating', () => {
  const g = game({ trap: false });
  move(g, 0, 8, 2);
  assert.equal(g.pieces[0][0], 14);
  assert.deepEqual(g.lastMove.path, [10, 14]);
  assert.deepEqual(g.lastMove.effects, []);
});

test('disabling safe islands restores collision and same-colour rewards', () => {
  const g = game({ safe: false });
  enemyAt(g, 2);
  move(g, 0, 1, 1);
  assert.equal(g.pieces[3][0], -1);
  assert.equal(g.pieces[0][0], 6);
  assert.equal(result(g, 0).stats.blue, 1);
  assert.deepEqual(g.lastMove.effects, []);
});

test('disabling lucky or ice removes their random draw while retaining global roll counting', () => {
  const lucky = game({ lucky: false });
  lucky.pieces[0][0] = 10;
  rollDice(lucky, 0, 1, () => assert.fail('disabled lucky must not draw'));
  movePiece(lucky, 0, 0, () => assert.fail('disabled lucky must not draw'));
  assert.equal(lucky.pieces[0][0], 11);
  assert.deepEqual(lucky.lastMove.effects, []);
  const ice = game({ ice: false });
  for (let i = 0; i < 40; i++) rollDice(ice, ice.turn, 1, () => assert.fail('disabled ice must not draw'));
  assert.equal(ice.rollCount, 40);
  assert.equal(ice.iceCell, null);
});

test('disabling capture presentation preserves the authoritative collision and colour statistics', () => {
  const g = game({ captureEffects: false });
  enemyAt(g, 3);
  move(g, 0, 2, 1);
  assert.equal(g.pieces[3][0], -1);
  assert.equal(g.lastMove.captured.length, 1);
  assert.equal(result(g, 0).stats.blue, 1);
  assert.equal(g.rules.captureEffects, false);
});

test('alliances require invitations and acceptance and every participant has at most one ally', () => {
  const g = game({ alliances: true });
  assert.throws(() => allianceAction(g, 3, 'alliance-accept', 0));
  allianceAction(g, 0, 'alliance-invite', 3);
  assert.equal(g.allies[0], null);
  assert.equal(g.allies[3], null);
  assert.ok(g.invitations.some(invitation => invitation.from === 0 && invitation.to === 3));
  allianceAction(g, 3, 'alliance-accept', 0);
  assert.equal(g.allies[0], 3);
  assert.equal(g.allies[3], 0);
  assert.equal(g.invitations.some(invitation => invitation.from === 0 || invitation.to === 3), false);
  const before = structuredClone(g);
  assert.throws(() => allianceAction(g, 0, 'alliance-invite', 2));
  assert.throws(() => allianceAction(g, 2, 'alliance-invite', 3));
  assert.throws(() => allianceAction(g, 0, 'alliance-invite', 0));
  assert.deepEqual(g, before);
});

test('declining an invitation creates no alliance and disabled alliance actions have no effects', () => {
  const g = game({ alliances: true });
  allianceAction(g, 0, 'alliance-invite', 3);
  allianceAction(g, 3, 'alliance-decline', 0);
  assert.equal(g.invitations.length, 0);
  assert.equal(g.allies.every(value => value == null), true);
  const disabled = game();
  const before = structuredClone(disabled);
  assert.throws(() => allianceAction(disabled, 0, 'alliance-invite', 3));
  assert.deepEqual(disabled, before);
});

test('allied planes cannot collide and allied two-plane walls do not block movement', () => {
  const collision = game({ alliances: true });
  ally(collision);
  const p = enemyAt(collision, 3);
  move(collision, 0, 2, 1);
  assert.equal(collision.pieces[3][0], p);
  assert.deepEqual(collision.lastMove.captured, []);
  assert.deepEqual(result(collision, 0).stats, zeros());
  const wall = game({ alliances: true });
  ally(wall);
  const at = enemyAt(wall, 7, 3, 2);
  move(wall, 0, 3, 4);
  assert.equal(wall.pieces[0][0], 9);
  assert.deepEqual(wall.pieces[3].slice(0, 2), [at, at]);
  assert.deepEqual(wall.lastMove.events, []);
});

test('cancelling retracts a pending invitation but cannot peacefully dissolve an accepted alliance', () => {
  const g = game({ alliances: true });
  allianceAction(g, 0, 'alliance-invite', 3);
  allianceAction(g, 0, 'alliance-cancel', 3);
  assert.equal(g.invitations.length, 0);
  assert.equal(g.allies[0], null);
  assert.equal(g.allies[3], null);
  ally(g);
  const before = structuredClone(g);
  assert.throws(() => allianceAction(g, 0, 'alliance-cancel', 3));
  assert.deepEqual(g, before);
  allianceAction(g, 0, 'alliance-betray');
  assert.equal(g.allies[0], null);
  assert.equal(g.allies[3], null);
  assert.equal(g.diceDouble[0], true);
  assert.equal(g.bountyRounds[0], 3);
  assert.equal(g.betrayedBy[3], 0);
});

test('each player may betray once and receives dice double plus two items; betrayed gains hunt card', () => {
  const g = game({ alliances: true, items: true });
  g.hands[0] = [];
  g.hands[3] = [];
  ally(g);
  allianceAction(g, 0, 'alliance-betray', null, randomIndex);
  assert.equal(g.allies[0], null);
  assert.equal(g.allies[3], null);
  assert.equal(g.betrayed[0], true);
  assert.equal(g.diceDouble[0], true);
  assert.equal(g.bountyRounds[0], 3);
  assert.equal(g.betrayedBy[3], 0);
  assert.equal(g.hands[0].length, 2);
  assert.equal(g.hands[3].includes('hunt'), true);
  assert.equal(g.everAllied[0], true);
  assert.equal(g.everAllied[3], true);
  enemyAt(g, 3);
  g.diceDouble[0] = false;
  move(g, 0, 2, 1);
  assert.equal(g.pieces[0][0], 3);
  assert.equal(result(g, 0).stats.blue, 1);
  assert.equal(g.bountyRounds[0], 3);
  assert.throws(() => allianceAction(g, 0, 'alliance-invite', 2));
  const before = structuredClone(g);
  assert.throws(() => allianceAction(g, 0, 'alliance-betray'));
  assert.deepEqual(g, before);
});

test('betrayal dice double applies on next roll and bounty rewards on capturing betrayer piece', () => {
  const g = game({ alliances: true, items: true });
  g.hands[0] = [];
  ally(g);
  allianceAction(g, 0, 'alliance-betray', null, randomIndex);
  assert.equal(g.diceDouble[0], true);
  g.pieces[0][0] = 3;
  g.turn = 0; g.phase = 'roll';
  rollDice(g, 0, 3, randomIndex);
  assert.equal(g.dice, 6, 'dice value should be doubled from 3 to 6');
  assert.equal(g.diceDouble[0], false);
  movePiece(g, 0, 0, randomIndex);
  assert.equal(g.pieces[0][0], 9);
  const h = game({ alliances: true, items: true });
  h.hands[3] = [];
  h.hands[0] = [];
  ally(h);
  allianceAction(h, 0, 'alliance-betray', null, randomIndex);
  assert.equal(h.bountyRounds[0], 3);
  assert.equal(h.betrayedBy[3], 0);
  h.pieces[3][0] = 3;
  h.pieces[0][0] = 44;
  h.turn = 3; h.phase = 'roll';
  rollDice(h, 3, 2, randomIndex);
  movePiece(h, 3, 0, randomIndex);
  assert.equal(h.pieces[0][0], -1, 'betrayer piece should be captured');
  assert.equal(h.hands[3].length, 2, 'capturer has hunt card + 1 bounty reward');
  assert.equal(h.bountyRounds[0], 2, 'bounty decremented after round');
});

test('a betrayal dice double does not trigger special-space chains', () => {
  const g = game({ alliances: true, items: true, speed: true });
  g.hands[0] = [];
  ally(g);
  allianceAction(g, 0, 'alliance-betray', null, randomIndex);
  g.pieces[0][0] = 3;
  g.turn = 0; g.phase = 'roll';
  rollDice(g, 0, 1, randomIndex);
  assert.equal(g.dice, 2, 'dice doubled from 1 to 2');
  assert.equal(g.diceDouble[0], false);
  movePiece(g, 0, 0, randomIndex);
  assert.equal(g.pieces[0][0], 5);
});

test('finishing players leave alliances and invitations and their mines are removed', () => {
  const g = game({ alliances: true, items: true });
  ally(g);
  g.mines.push({ seat: 0, index: 3 });
  g.pieces[0] = [FINISH, FINISH, FINISH, 56];
  rollDice(g, 0, 1, randomIndex); movePiece(g, 0, 3, randomIndex);
  assert.equal(result(g, 0).rank, 1);
  assert.equal(g.allies[0], null);
  assert.equal(g.allies[3], null);
  assert.equal(g.invitations.some(invitation => invitation.from === 0 || invitation.to === 0), false);
  assert.equal(g.mines.some(mine => mine.seat === 0), false);
  assert.deepEqual(g.hands[0], []);
  assert.throws(() => allianceAction(g, 0, 'alliance-invite', 2));
  assert.throws(() => useItem(g, 0, { card: 'stun', targetSeat: 2, targetPiece: 0 }));
});

test('items give each active player exactly three initial cards and rolls do not draw more', () => {
  const g = createGame([{ seat: 0 }, { seat: 3 }], { mode: 'fun', rules: { items: true } });
  assert.deepEqual(g.hands, [['stun', 'mine', 'missile'], [], [], ['stun', 'mine', 'missile']]);
  for (let i = 0; i < 20; i++) rollDice(g, g.turn, 1, randomIndex);
  assert.deepEqual(g.hands, [['stun', 'mine', 'missile'], [], [], ['stun', 'mine', 'missile']]);
  assert.deepEqual(game().hands, [[], [], [], []]);
});

test('stun freezes only the selected enemy plane and does not count as a capture', () => {
  const g = game({ items: true });
  enemyAt(g, 3, 3, 2);
  useItem(g, 0, { card: 'stun', targetSeat: 3, targetPiece: 1 });
  assert.equal(g.frozenPieces[3][1], true);
  assert.equal(g.frozenPieces[3][0], false);
  assert.deepEqual(g.hands[0], ['mine', 'missile']);
  assert.equal(g.itemUsed[0], true);
  assert.deepEqual(result(g, 0).stats, zeros());
  g.turn = 3;
  rollDice(g, 3, 1, randomIndex);
  assert.ok(g.legal.includes(0));
  assert.equal(g.legal.includes(1), false);
});

test('items can be used once before rolling per turn and six repeats do not replenish the allowance', () => {
  const g = game({ items: true });
  g.pieces[0][0] = 3;
  enemyAt(g, 5);
  useItem(g, 0, { card: 'mine', piece: 0 });
  rollDice(g, 0, 6, randomIndex); movePiece(g, 0, 0, randomIndex);
  assert.equal(g.turn, 0);
  assert.throws(() => useItem(g, 0, { card: 'stun', targetSeat: 3, targetPiece: 0 }));
  rollDice(g, 0, 1, randomIndex);
  assert.throws(() => useItem(g, 0, { card: 'stun', targetSeat: 3, targetPiece: 0 }));
  movePiece(g, 0, 0, randomIndex);
  for (let i = 0; i < 3; i++) autoTurn(g, 1, randomIndex);
  assert.equal(g.turn, 0);
  assert.equal(g.itemUsed[0], false);
  useItem(g, 0, { card: 'stun', targetSeat: 3, targetPiece: 0 });
  assert.deepEqual(g.hands[0], ['missile']);
});

test('invalid card ownership, turn and target cannot consume cards or mutate the game', () => {
  for (const [seat, input] of [
    [0, { card: 'invented', targetSeat: 3, targetPiece: 0 }],
    [1, { card: 'stun', targetSeat: 3, targetPiece: 0 }],
    [0, { card: 'stun', targetSeat: 0, targetPiece: 0 }],
    [0, { card: 'stun', targetSeat: 3, targetPiece: 4 }],
    [0, { card: 'missile', piece: 0, targetSeat: 3, targetPiece: 0 }],
  ]) {
    const g = game({ items: true });
    const before = structuredClone(g);
    assert.throws(() => useItem(g, seat, input));
    assert.deepEqual(g, before);
  }
  const disabled = game();
  const before = structuredClone(disabled);
  assert.throws(() => useItem(disabled, 0, { card: 'mine', piece: 0 }));
  assert.deepEqual(disabled, before);
});

test('mine deployment requires a current friendly plane on an enabled ordinary public cell', () => {
  for (const progress of [-1, -2, 2, 7, 10, 11, 51, FINISH]) {
    const g = game({ items: true });
    g.pieces[0][0] = progress;
    const before = structuredClone(g);
    assert.throws(() => useItem(g, 0, { card: 'mine', piece: 0 }));
    assert.deepEqual(g, before);
  }
  const disabledSpeed = game({ items: true, speed: false });
  disabledSpeed.pieces[0][0] = 7;
  useItem(disabledSpeed, 0, { card: 'mine', piece: 0 });
  assert.deepEqual(disabledSpeed.mines, [{ seat: 0, index: 7 }]);
});

test('an enemy triggering a mine returns alone and gives its owner one enemy-colour count', () => {
  const g = game({ items: true });
  g.pieces[0][0] = 3;
  useItem(g, 0, { card: 'mine', piece: 0 });
  move(g, 3, 15, 1);
  assert.equal(g.pieces[3][0], -1);
  assert.equal(g.frozenPieces[3][0], false);
  assert.equal(g.pieces[0][0], 3, 'mine detonation prevents a subsequent collision');
  assert.equal(g.mines.length, 0);
  assert.equal(result(g, 0).stats.blue, 1);
  assert.deepEqual(result(g, 3).stats, zeros(), 'the victim never receives a self-return count');
});

test('safe islands prevent mine detonation while disabling safe restores the mine hit', () => {
  for (const safe of [true, false]) {
    const g = game({ items: true, safe });
    g.mines.push({ seat: 3, index: 2 });
    move(g, 0, 1, 1);
    assert.equal(g.pieces[0][0], safe ? 2 : -1);
    assert.equal(g.mines.length, safe ? 1 : 0);
    assert.equal(result(g, 3).stats.green, safe ? 0 : 1);
    assert.deepEqual(result(g, 0).stats, zeros());
    if (safe) assert.equal(g.lastMove.events.some(event => event.type === 'MINE_HIT'), false);
    else assert.equal(g.lastMove.events[0].type, 'MINE_HIT');
  }
});

test('an active capture directly on ice freezes the plane before its dice double can apply', () => {
  const g = game({ alliances: true });
  ally(g);
  allianceAction(g, 0, 'alliance-betray');
  assert.equal(g.diceDouble[0], true);
  g.iceCell = 6;
  enemyAt(g, 6);
  g.diceDouble[0] = false;
  move(g, 0, 5, 1);
  assert.equal(g.pieces[0][0], 6);
  assert.equal(g.pieces[3][0], -1);
  assert.equal(g.iceCell, null);
  assert.equal(g.frozenPieces[0][0], true);
  assert.equal(result(g, 0).stats.blue, 1);
  assert.deepEqual(g.lastMove.effects, [{ type: 'ice', from: 6, to: 6 }]);
});

test('an allied landing does not detonate a mine and an unrelated enemy can still trigger it', () => {
  const g = game({ items: true, alliances: true });
  ally(g);
  g.pieces[0][0] = 3;
  useItem(g, 0, { card: 'mine', piece: 0 });
  move(g, 3, 15, 1);
  assert.equal(g.pieces[3][0], 16);
  assert.equal(g.mines.length, 1);
  assert.deepEqual(result(g, 0).stats, zeros());
  move(g, 1, 41, 1);
  assert.equal(g.pieces[1][0], -1);
  assert.equal(g.pieces[3][0], 16);
  assert.equal(g.mines.length, 0);
  assert.equal(result(g, 0).stats.red, 1);
});

test('missile removes exactly its selected plane within six forward spaces and clears freeze', () => {
  const g = game({ items: true });
  g.pieces[0][0] = 3;
  const at = enemyAt(g, 5, 3, 2);
  g.frozenPieces[3][1] = true;
  useItem(g, 0, { card: 'missile', piece: 0, targetSeat: 3, targetPiece: 1 });
  assert.equal(g.pieces[0][0], 3);
  assert.deepEqual(g.pieces[3].slice(0, 2), [at, -1]);
  assert.equal(g.frozenPieces[3][1], false);
  assert.equal(result(g, 0).stats.blue, 1);
  assert.deepEqual(result(g, 3).stats, zeros());
  assert.deepEqual(g.hands[0], ['stun', 'mine']);
});

test('missiles reject safe islands, distances outside one-to-six, home-entry wraparound and allied targets', () => {
  for (const [source, target] of [[0, 0], [0, 2], [0, 7], [50, 1]]) {
    const g = game({ items: true });
    g.pieces[0][0] = source;
    enemyAt(g, target);
    const before = structuredClone(g);
    assert.throws(() => useItem(g, 0, { card: 'missile', piece: 0, targetSeat: 3, targetPiece: 0 }));
    assert.deepEqual(g, before);
  }
  const allied = game({ items: true, alliances: true });
  ally(allied);
  allied.pieces[0][0] = 0;
  enemyAt(allied, 3);
  const before = structuredClone(allied);
  assert.throws(() => useItem(allied, 0, { card: 'missile', piece: 0, targetSeat: 3, targetPiece: 0 }));
  assert.throws(() => useItem(allied, 0, { card: 'stun', targetSeat: 3, targetPiece: 0 }));
  assert.deepEqual(allied, before);
  const unsafe = game({ items: true, safe: false });
  unsafe.pieces[0][0] = 0;
  enemyAt(unsafe, 2);
  useItem(unsafe, 0, { card: 'missile', piece: 0, targetSeat: 3, targetPiece: 0 });
  assert.equal(unsafe.pieces[3][0], -1);
});

test('using stun or missile does not consume the betrayal dice double', () => {
  const g = game({ items: true, alliances: true });
  g.hands[0] = ['missile'];
  ally(g);
  allianceAction(g, 0, 'alliance-betray');
  g.pieces[0][0] = 3;
  enemyAt(g, 5);
  useItem(g, 0, { card: 'missile', piece: 0, targetSeat: 3, targetPiece: 0 });
  assert.equal(g.diceDouble[0], true, 'dice double persists after item use');
  assert.equal(result(g, 0).stats.blue, 1);
});

test('finished games reject items and social actions without mutating the final result', () => {
  const g = createGame([{ seat: 0 }, { seat: 3 }], { mode: 'fun', rules: { items: true, alliances: true } });
  g.pieces[0] = [FINISH, FINISH, FINISH, 56];
  rollDice(g, 0, 1, randomIndex); movePiece(g, 0, 3, randomIndex);
  const before = structuredClone(g);
  assert.throws(() => useItem(g, 3, { card: 'mine', piece: 0 }));
  assert.throws(() => allianceAction(g, 3, 'alliance-invite', 0));
  assert.deepEqual(g, before);
});

test('hunt card execution: pending on current turn and executes next turn with correct relative position', () => {
  const g = createGame([{ seat: 0 }, { seat: 3 }], { mode: 'fun', rules: { items: true, alliances: true, safe: true } });
  g.hands[0] = [];
  g.hands[3] = [];
  ally(g);
  allianceAction(g, 0, 'alliance-betray', null, randomIndex);
  assert.equal(g.hands[3].includes('hunt'), true);

  // seat 0 (green, START 0), seat 3 (blue, START 39).
  // Target: seat 0, piece 0 at progress 3 -> physical index (0 + 3) = 3.
  g.pieces[0][0] = 3;
  // Hunter: seat 3, piece 0 at progress 5 -> physical index (39 + 5) % 52 = 44.
  g.pieces[3][0] = 5;

  g.turn = 3; g.phase = 'roll';
  useItem(g, 3, { card: 'hunt', targetSeat: 0, targetPiece: 0 });
  assert.equal(g.huntTargets[3]?.pending, true);

  // Current turn roll: should NOT trigger hunt yet because it's pending
  rollDice(g, 3, 2, randomIndex);
  assert.equal(g.pieces[0][0], 3, 'target piece not hunted on same turn');

  // Move hunter piece to finish its turn
  movePiece(g, 3, 0, randomIndex);

  // Next turn is seat 0's turn. Seat 0 moves. (Has betrayal dice double: 1 * 2 = 2 steps!)
  assert.equal(g.turn, 0);
  rollDice(g, 0, 1, randomIndex);
  movePiece(g, 0, 0, randomIndex);
  assert.equal(g.pieces[0][0], 5);

  // Now it's seat 3's next turn!
  assert.equal(g.turn, 3);
  assert.equal(g.phase, 'roll');
  // Target is at progress 5 for seat 0 -> physical index = (0 + 5) = 5.
  // Relative for seat 3: (5 - 39 + 52) % 52 = 18.
  rollDice(g, 3, 3, randomIndex);
  assert.equal(g.pieces[0][0], -1, 'target piece should be returned to airport');
  assert.equal(g.pieces[3][0], 18, 'hunter piece should jump to target relative position');
});
