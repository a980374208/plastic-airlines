import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, rollDice, movePiece, autoTurn } from '../engine.mjs';
import { COLORS, STARTS, FINISH, TAKEOFF, SPECIAL_CELLS, specialCellAt } from '../board.mjs';

const players = [0, 1, 2, 3].map(seat => ({ seat }));
const game = (mode = 'fun') => createGame(players, { mode });
const result = (g, seat) => g.players.find(player => player.seat === seat);
const zeros = () => Object.fromEntries(COLORS.map(color => [color.key, 0]));
const choose = index => max => { assert.ok(index >= 0 && index < max); return index; };

function move(g, seat, from, dice, randomIndex = choose(0), piece = 0) {
  g.turn = seat;
  g.phase = 'roll';
  g.sixes = 0;
  g.pieces[seat][piece] = from;
  rollDice(g, seat, dice, randomIndex);
  return movePiece(g, seat, piece, randomIndex);
}

function enemyAt(g, progress, seat = 3, count = 1) {
  const opponentProgress = (progress - STARTS[seat] + 52) % 52;
  assert.ok(opponentProgress <= 50);
  for (let i = 0; i < count; i++) g.pieces[seat][i] = opponentProgress;
  return opponentProgress;
}

function noStats(g) {
  for (const player of g.players) assert.deepEqual(player.stats, zeros());
}

test('new games have no ice, zero rolls and independent unfrozen flags', () => {
  const g = game();
  assert.equal(g.rollCount, 0);
  assert.equal(g.iceCell, null);
  assert.deepEqual(g.frozenPieces, Array.from({ length: 4 }, () => [false, false, false, false]));
  g.frozenPieces[0][0] = true;
  assert.equal(g.frozenPieces[1][0], false);
  assert.equal(game().frozenPieces[0][0], false);
});

test('four lucky cells occupy symmetric public-ring locations without replacing other specials', () => {
  assert.deepEqual(SPECIAL_CELLS.filter(cell => cell.type === 'lucky').map(cell => cell.index), [11, 24, 37, 50]);
  assert.equal(new Set(SPECIAL_CELLS.map(cell => cell.index)).size, 16);
  for (const start of STARTS) {
    assert.equal(specialCellAt(start + 2), 'safe');
    assert.equal(specialCellAt(start + 7), 'speed');
    assert.equal(specialCellAt(start + 10), 'trap');
    assert.equal(specialCellAt(start + 11), 'lucky');
  }
});

test('every lucky outcome has one of six equally-sized choices and settles once for each colour', () => {
  const deltas = [-3, -2, -1, 1, 2, 3];
  for (let seat = 0; seat < 4; seat++) for (let index = 0; index < deltas.length; index++) {
    const g = game();
    const ranges = [];
    move(g, seat, 10, 1, max => { ranges.push(max); return index; });
    const delta = deltas[index];
    assert.deepEqual(ranges, [6], 'a single uniformly bounded index selects the signed step count');
    assert.equal(g.pieces[seat][0], 11 + delta);
    assert.deepEqual(g.lastMove.path, [11, 11 + delta]);
    assert.deepEqual(g.lastMove.effects, [{ type: 'lucky', from: 11, to: 11 + delta, delta }]);
    assert.deepEqual(g.lastMove.events, []);
    noStats(g);
  }
});

test('lucky forward movement can enter the private home lane without triggering another reward', () => {
  const g = game();
  move(g, 0, 49, 1, choose(5));
  assert.equal(g.pieces[0][0], 53);
  assert.deepEqual(g.lastMove.path, [50, 53]);
  assert.deepEqual(g.lastMove.effects, [{ type: 'lucky', from: 50, to: 53, delta: 3 }]);
});

test('lucky forward movement stops before an enemy wall without breaking or bouncing', () => {
  for (const wall of [12, 14]) {
    const g = game();
    const p = enemyAt(g, wall, 3, 2);
    move(g, 0, 10, 1, choose(5));
    assert.equal(g.pieces[0][0], wall - 1);
    assert.deepEqual(g.pieces[3].slice(0, 2), [p, p]);
    assert.deepEqual(g.lastMove.events, []);
    assert.deepEqual(g.lastMove.effects, [{ type: 'lucky', from: 11, to: wall - 1, delta: 3 }]);
    noStats(g);
  }
});

test('lucky backward movement stops before a rear wall and does not retrigger the final trap', () => {
  const g = game();
  const p = enemyAt(g, 9, 3, 2);
  move(g, 0, 10, 1, choose(0));
  assert.equal(g.pieces[0][0], 10);
  assert.deepEqual(g.pieces[3].slice(0, 2), [p, p]);
  assert.deepEqual(g.lastMove.effects, [{ type: 'lucky', from: 11, to: 10, delta: -3 }]);
  assert.deepEqual(g.lastMove.events, []);
  noStats(g);
});

test('a wall directly on a lucky cell resolves first without drawing a lucky result', () => {
  const g = game();
  enemyAt(g, 11, 3, 2);
  move(g, 0, 10, 1, () => assert.fail('a broken wall cannot also draw a lucky result'));
  assert.equal(g.pieces[0][0], -1);
  assert.equal(g.lastMove.events[0].type, 'WALL_BREAK');
  assert.deepEqual(g.lastMove.effects, []);
  assert.deepEqual(result(g, 0).stats, { green: 1, red: 0, yellow: 0, blue: 2 });
});

test('lucky forward captures count while backward captures leave the passive victim statistics unchanged', () => {
  const forward = game();
  enemyAt(forward, 14, 1, 1);
  move(forward, 0, 10, 1, choose(5));
  assert.equal(forward.pieces[1][0], -1);
  assert.deepEqual(result(forward, 0).stats, { green: 0, red: 1, yellow: 0, blue: 0 });
  assert.deepEqual(result(forward, 1).stats, zeros());
  const backward = game();
  enemyAt(backward, 8, 3, 1);
  move(backward, 0, 10, 1, choose(0));
  assert.equal(backward.pieces[3][0], -1);
  assert.equal(backward.lastMove.captured.length, 1);
  noStats(backward);
});

test('classic mode counts valid rolls but never activates lucky or dynamic ice', () => {
  const g = game('classic');
  for (let i = 0; i < 40; i++) rollDice(g, g.turn, 1, () => assert.fail('classic mode cannot draw an effect'));
  assert.equal(g.rollCount, 40);
  assert.equal(g.iceCell, null);
  move(g, 0, 10, 1, () => assert.fail('classic lucky locations are ordinary cells'));
  assert.equal(g.pieces[0][0], 11);
  assert.deepEqual(g.lastMove.effects, []);
  assert.equal(g.rollCount, 41);
});

test('ice first appears on the twentieth valid global roll and is replaced on the fortieth', () => {
  const g = game();
  const ranges = [];
  const randomIndex = max => { ranges.push(max); return ranges.length === 1 ? 0 : max - 1; };
  for (let i = 0; i < 19; i++) rollDice(g, g.turn, 1, randomIndex);
  assert.equal(g.rollCount, 19);
  assert.equal(g.iceCell, null);
  assert.deepEqual(ranges, []);
  rollDice(g, g.turn, 1, randomIndex);
  const first = g.iceCell;
  assert.equal(g.rollCount, 20);
  assert.equal(specialCellAt(first), null);
  assert.deepEqual(ranges, [36]);
  for (let i = 0; i < 19; i++) rollDice(g, g.turn, 1, randomIndex);
  assert.equal(g.iceCell, first);
  rollDice(g, g.turn, 1, randomIndex);
  assert.equal(g.rollCount, 40);
  assert.notEqual(g.iceCell, first);
  assert.equal(specialCellAt(g.iceCell), null);
  assert.deepEqual(ranges, [36, 35], 'the existing ice cell is excluded from replacement choices');
});

test('ice generation excludes all occupied public cells, fixed specials and its old location', () => {
  const occupied = [0, 1, 3, 4, 5, 6];
  const expected = Array.from({ length: 52 }, (_, i) => i).filter(index => !specialCellAt(index) && !occupied.includes(index) && index !== 8);
  for (let choice = 0; choice < expected.length; choice++) {
    const g = game();
    g.pieces[0] = [0, 1, 3, 4];
    g.pieces[3] = [18, 19, TAKEOFF, FINISH]; // physical 5 and 6 occupy public cells.
    g.iceCell = 8;
    g.rollCount = 39;
    rollDice(g, 0, 1, max => { assert.equal(max, expected.length); return choice; });
    assert.equal(g.iceCell, expected[choice]);
  }
});

test('invalid, out-of-turn, pending-move and ranked-player rolls do not advance the ice counter', () => {
  for (const value of [0, 7, 1.5, NaN, '6']) {
    const g = game();
    g.rollCount = 19;
    const before = structuredClone(g);
    assert.throws(() => rollDice(g, 0, value, () => assert.fail('invalid dice must not draw ice')));
    assert.deepEqual(g, before);
  }
  for (const context of ['other-player', 'pending-move', 'ranked', 'finished']) {
    const g = game();
    g.rollCount = 19;
    if (context === 'pending-move') g.phase = 'move';
    if (context === 'ranked') g.players[0].rank = 1;
    if (context === 'finished') g.status = 'finished';
    const before = structuredClone(g);
    assert.throws(() => rollDice(g, context === 'other-player' ? 1 : 0, 1, () => assert.fail('rejected actions cannot draw ice')));
    assert.deepEqual(g, before);
  }
});

test('automatic rolls count globally but automatic completion of an existing move does not roll twice', () => {
  const automatic = game();
  for (let i = 0; i < 20; i++) autoTurn(automatic, 1, choose(0));
  assert.equal(automatic.rollCount, 20);
  assert.equal(specialCellAt(automatic.iceCell), null);
  const pending = game();
  pending.rollCount = 19;
  pending.pieces[0][0] = 3;
  rollDice(pending, 0, 2, choose(0));
  const ice = pending.iceCell;
  assert.equal(pending.rollCount, 20);
  autoTurn(pending, 1, () => assert.fail('finishing a pending move cannot draw a second ice cell'));
  assert.equal(pending.rollCount, 20);
  assert.equal(pending.iceCell, ice);
  assert.equal(pending.pieces[0][0], 5);
});

test('unlimited repeat sixes all count as rolls and only moving the selected frozen plane thaws it', () => {
  const g = game();
  g.rollCount = 17;
  rollDice(g, 0, 6, choose(0)); movePiece(g, 0, 0, choose(0));
  rollDice(g, 0, 6, choose(0)); movePiece(g, 0, 0, choose(0));
  g.frozenPieces[0][0] = true;
  const last = structuredClone(g.lastMove);
  rollDice(g, 0, 6, choose(0));
  assert.equal(g.rollCount, 20);
  assert.equal(g.turn, 0);
  assert.equal(g.phase, 'move');
  assert.ok(g.legal.includes(0));
  assert.equal(g.frozenPieces[0][0], true);
  assert.deepEqual(g.lastMove, last);
  assert.notEqual(g.iceCell, null);
  movePiece(g, 0, 0, choose(0));
  assert.equal(g.frozenPieces[0][0], false);
  assert.equal(g.turn, 0);
  rollDice(g, 0, 6, choose(0)); movePiece(g, 0, 1, choose(0));
  assert.equal(g.rollCount, 21);
  assert.equal(g.turn, 0);
  assert.equal(g.sixes, 4);
});

test('the first plane landing on ice consumes the cell and immediately stops before a colour jump', () => {
  const g = game();
  g.iceCell = 6;
  move(g, 0, 5, 1);
  assert.equal(g.pieces[0][0], 6);
  assert.equal(g.iceCell, null);
  assert.equal(g.frozenPieces[0][0], true);
  assert.deepEqual(g.lastMove.path, [6]);
  assert.deepEqual(g.lastMove.effects, [{ type: 'ice', from: 6, to: 6 }]);
  assert.equal(g.frozenPieces.flat().filter(Boolean).length, 1);
});

test('ice consumes normal jump and flight landings and stops a jump-assisted flight chain', () => {
  for (const [from, dice, ice, expected] of [[12, 2, 18, [14, 18]], [16, 2, 30, [18, 30]]]) {
    const g = game();
    g.iceCell = ice;
    move(g, 0, from, dice);
    assert.equal(g.pieces[0][0], ice);
    assert.deepEqual(g.lastMove.path, expected);
    assert.equal(g.iceCell, null);
    assert.equal(g.frozenPieces[0][0], true);
    assert.deepEqual(g.lastMove.effects, [{ type: 'ice', from: ice, to: ice }]);
  }
});

test('speed and lucky extra landings neither consume ice nor freeze their moving plane', () => {
  const speed = game();
  speed.iceCell = 9;
  move(speed, 0, 5, 2);
  assert.equal(speed.pieces[0][0], 9);
  assert.equal(speed.iceCell, 9);
  assert.equal(speed.frozenPieces[0][0], false);
  assert.deepEqual(speed.lastMove.effects, [{ type: 'speed', from: 7, to: 9 }]);
  const lucky = game();
  lucky.iceCell = 8;
  move(lucky, 0, 10, 1, choose(0));
  assert.equal(lucky.pieces[0][0], 8);
  assert.equal(lucky.iceCell, 8);
  assert.equal(lucky.frozenPieces[0][0], false);
  assert.deepEqual(lucky.lastMove.effects, [{ type: 'lucky', from: 11, to: 8, delta: -3 }]);
});

test('non-six rolls cannot move a frozen plane and other movable planes remain legal', () => {
  for (const dice of [1, 2, 3, 4, 5]) {
    const g = game();
    g.pieces[0] = [3, 4, -1, -1];
    g.frozenPieces[0][0] = true;
    rollDice(g, 0, dice, choose(0));
    assert.equal(g.legal.includes(0), false);
    assert.equal(g.legal.includes(1), true);
    const before = structuredClone(g);
    assert.throws(() => movePiece(g, 0, 0, choose(0)));
    assert.deepEqual(g, before);
    movePiece(g, 0, 1, choose(0));
    assert.equal(g.frozenPieces[0][0], true);
    assert.equal(g.pieces[0][0], 3);
  }
});

test('six only thaws the selected frozen plane and a six spent on a different plane leaves it frozen', () => {
  const g = game();
  g.pieces[0] = [3, 4, -1, -1];
  g.frozenPieces[0][0] = true;
  rollDice(g, 0, 6, choose(0));
  assert.equal(g.frozenPieces[0][0], true, 'rolling a six alone cannot thaw the plane');
  assert.ok(g.legal.includes(0));
  movePiece(g, 0, 1, choose(0));
  assert.equal(g.frozenPieces[0][0], true);
  rollDice(g, 0, 6, choose(0));
  assert.equal(g.frozenPieces[0][0], true);
  movePiece(g, 0, 0, choose(0));
  assert.equal(g.frozenPieces[0][0], false);
  assert.equal(g.pieces[0][0], 9);
});

test('a consumed ice cell affects one plane while another arrival can capture and clear its freeze', () => {
  const g = game();
  g.iceCell = 3;
  move(g, 0, 2, 1);
  assert.equal(g.frozenPieces[0][0], true);
  move(g, 3, 15, 1);
  assert.equal(g.iceCell, null);
  assert.equal(g.pieces[3][0], 16);
  assert.equal(g.frozenPieces[3][0], false);
  assert.equal(g.pieces[0][0], -1);
  assert.equal(g.frozenPieces[0][0], false);
  assert.deepEqual(result(g, 3).stats, { green: 1, red: 0, yellow: 0, blue: 0 });
});

test('wall breaking clears freeze flags for both the selected plane and every returned wall plane', () => {
  const g = game();
  enemyAt(g, 9, 3, 2);
  g.frozenPieces[0][0] = true;
  g.frozenPieces[3][0] = g.frozenPieces[3][1] = true;
  move(g, 0, 3, 6);
  assert.equal(g.pieces[0][0], -1);
  assert.deepEqual(g.pieces[3].slice(0, 2), [-1, -1]);
  assert.equal(g.frozenPieces.flat().some(Boolean), false);
  assert.equal(g.lastMove.events[0].type, 'WALL_BREAK');
});

test('automatic turns skip frozen planes on non-six and can thaw them on six', () => {
  const g = game();
  g.pieces[0] = [3, 4, -1, -1];
  g.frozenPieces[0][0] = true;
  autoTurn(g, 1, choose(0));
  assert.equal(g.lastMove.piece, 1);
  assert.equal(g.pieces[0][0], 3);
  assert.equal(g.frozenPieces[0][0], true);
  g.turn = 0;
  autoTurn(g, 6, choose(0));
  assert.equal(g.lastMove.piece, 0);
  assert.equal(g.frozenPieces[0][0], false);
  assert.equal(g.pieces[0][0], 9);
});

test('a player whose only route planes are frozen passes on non-six without losing frozen state', () => {
  const g = game();
  g.pieces[0] = [3, FINISH, FINISH, FINISH];
  g.frozenPieces[0][0] = true;
  rollDice(g, 0, 1, choose(0));
  assert.equal(g.phase, 'roll');
  assert.equal(g.turn, 1);
  assert.deepEqual(g.legal, []);
  assert.equal(g.frozenPieces[0][0], true);
  assert.equal(g.rollCount, 1);
});

test('ice-refresh replacement leaves previously frozen planes frozen and finished ranking still ends normally', () => {
  const g = game();
  g.pieces[0] = [3, FINISH, FINISH, FINISH];
  g.frozenPieces[0][0] = true;
  g.rollCount = 39;
  g.iceCell = 9;
  rollDice(g, 0, 1, choose(0));
  assert.equal(g.rollCount, 40);
  assert.notEqual(g.iceCell, 9);
  assert.equal(g.frozenPieces[0][0], true);
  const finishing = createGame([{ seat: 0 }, { seat: 1 }], { mode: 'fun' });
  finishing.pieces[0] = [FINISH, FINISH, FINISH, 51];
  finishing.frozenPieces[0][3] = true;
  move(finishing, 0, 51, 6, choose(0), 3);
  assert.equal(finishing.status, 'finished');
  assert.deepEqual(finishing.rankings, [0, 1]);
  assert.equal(finishing.frozenPieces[0][3], false);
  assert.equal(finishing.deadline, null);
});
