import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, rollDice, movePiece, autoTurn } from '../engine.mjs';
import { STARTS, TAKEOFF, FINISH, SPECIAL_CELLS, specialCellAt, positionFor, HOME_LANES } from '../board.mjs';

const players = [{ seat: 0 }, { seat: 1 }, { seat: 2 }, { seat: 3 }];
const funGame = () => createGame(players, { mode: 'fun' });

function move(game, seat, from, dice, piece = 0) {
  game.turn = seat;
  game.pieces[seat][piece] = from;
  rollDice(game, seat, dice);
  return movePiece(game, seat, piece);
}

test('classic is the default and unsupported rule modes cannot enter a game', () => {
  assert.equal(createGame(players).mode, 'classic');
  assert.equal(funGame().mode, 'fun');
  for (const mode of [null, 'FUN', 'other', 1, {}, ['fun']]) {
    assert.throws(() => createGame(players, { mode }));
  }
});

test('the four board sectors expose safe, speed, trap and lucky cells only on the shared ring', () => {
  assert.equal(SPECIAL_CELLS.length, 16);
  assert.equal(new Set(SPECIAL_CELLS.map(cell => cell.index)).size, 16);
  for (const start of STARTS) {
    assert.equal(specialCellAt(start + 2), 'safe');
    assert.equal(specialCellAt(start + 7), 'speed');
    assert.equal(specialCellAt(start + 10), 'trap');
    assert.equal(specialCellAt(start + 11), 'lucky');
    assert.equal(specialCellAt(start), null);
  }
  for (const index of [-2, -1, 52, 57, null, '2', NaN]) assert.equal(specialCellAt(index), null);
});

test('speed cells move every colour two more steps without granting a colour jump', () => {
  for (let seat = 0; seat < 4; seat++) {
    const g = funGame();
    move(g, seat, 5, 2);
    assert.equal(g.pieces[seat][0], 9);
    assert.deepEqual(g.lastMove.path, [7, 9]);
    assert.deepEqual(g.lastMove.effects, [{ type: 'speed', from: 7, to: 9 }]);
    assert.equal(g.turn, (seat + 1) % 4);
  }
});

test('traps override same-colour jumps and stop on the speed cell without a second effect', () => {
  for (let seat = 0; seat < 4; seat++) {
    const g = funGame();
    move(g, seat, 8, 2);
    assert.equal(g.pieces[seat][0], 7);
    assert.deepEqual(g.lastMove.path, [10, 7]);
    assert.deepEqual(g.lastMove.effects, [{ type: 'trap', from: 10, to: 7 }]);
  }
});

test('a normal same-colour jump still works and its final trap landing resolves once', () => {
  for (let seat = 0; seat < 4; seat++) {
    const g = funGame();
    move(g, seat, 3, 3);
    assert.deepEqual(g.lastMove.path, [6, 10, 7]);
    assert.equal(g.pieces[seat][0], 7);
    assert.deepEqual(g.lastMove.effects, [{ type: 'trap', from: 10, to: 7 }]);
  }
});

test('safe islands override same-colour jumps and let different colours share their landing', () => {
  for (let seat = 0; seat < 4; seat++) {
    const other = (seat + 3) % 4;
    const g = funGame();
    g.pieces[other][0] = 15; // The previous colour's progress 15 shares this colour's progress 2.
    move(g, seat, 1, 1);
    assert.equal(g.pieces[seat][0], 2);
    assert.equal(g.pieces[other][0], 15);
    assert.deepEqual(positionFor(seat, 2), positionFor(other, 15));
    assert.deepEqual(g.lastMove.path, [2]);
    assert.deepEqual(g.lastMove.captured, []);
    assert.deepEqual(g.lastMove.effects, [{ type: 'safe', from: 2, to: 2 }]);
    assert.equal(g.lastMove.taunt, '', 'safe coexistence must not announce a capture');
  }
});

test('a plane can leave a shared safe island and capture on the next ordinary cell', () => {
  const g = funGame();
  g.pieces[3][0] = 15; // safe physical 2
  g.pieces[3][1] = 16; // ordinary physical 3
  move(g, 0, 2, 1);
  assert.equal(g.pieces[0][0], 3);
  assert.deepEqual(g.pieces[3].slice(0, 2), [15, -1]);
  assert.deepEqual(g.lastMove.captured, [{ seat: 3, piece: 1, at: 3, from: 16 }]);
  assert.deepEqual(g.lastMove.effects, []);
});

test('speed captures on both landings and records the victims original progress for animation', () => {
  const g = funGame();
  g.pieces[3][0] = 20; // physical 7
  g.pieces[3][1] = 22; // physical 9
  move(g, 0, 5, 2);
  assert.deepEqual(g.pieces[3].slice(0, 2), [-1, -1]);
  assert.deepEqual(g.lastMove.captured, [
    { seat: 3, piece: 0, at: 7, from: 20 },
    { seat: 3, piece: 1, at: 9, from: 22 },
  ]);
  assert.equal(typeof g.lastMove.taunt, 'string');
  assert.ok(g.lastMove.taunt.length > 0, 'the authoritative capture event carries a shared taunt');
});

test('trap captures on its landing and on its retreat, keeping a single special effect', () => {
  const g = funGame();
  g.pieces[3][0] = 23; // physical 10
  g.pieces[3][1] = 20; // physical 7
  move(g, 0, 8, 2);
  assert.deepEqual(g.pieces[3].slice(0, 2), [-1, -1]);
  assert.deepEqual(g.lastMove.captured, [
    { seat: 3, piece: 0, at: 10, from: 23 },
    { seat: 3, piece: 1, at: 7, from: 20 },
  ]);
  assert.equal(g.lastMove.effects.length, 1);
});

test('fun mode keeps ordinary same-colour jumps and direct or jump-assisted flight for all colours', () => {
  for (let seat = 0; seat < 4; seat++) {
    for (const [from, dice, path, to] of [[20, 2, [22, 26], 26], [16, 2, [18, 30], 30], [12, 2, [14, 18, 30], 30]]) {
      const g = funGame();
      move(g, seat, from, dice);
      assert.equal(g.pieces[seat][0], to);
      assert.deepEqual(g.lastMove.path, path);
      assert.deepEqual(g.lastMove.effects, []);
    }
  }
});

test('classic mode disables markers and keeps captures and bonuses on the same physical cells', () => {
  const safe = createGame(players);
  safe.pieces[3][0] = 15;
  move(safe, 0, 1, 1);
  assert.deepEqual(safe.lastMove.path, [2, 6]);
  assert.equal(safe.pieces[3][0], -1);
  assert.deepEqual(safe.lastMove.effects, []);
  assert.equal(safe.lastMove.taunt, '', 'classic captures keep their original presentation');
  const speed = createGame(players);
  move(speed, 0, 5, 2);
  assert.equal(speed.pieces[0][0], 7);
  assert.deepEqual(speed.lastMove.effects, []);
  const trap = createGame(players);
  move(trap, 0, 8, 2);
  assert.deepEqual(trap.lastMove.path, [10, 14]);
  assert.equal(trap.pieces[0][0], 14);
  assert.deepEqual(trap.lastMove.effects, []);
});

test('launching on 2, 4 or 6 goes to the private apron and its exit still counts from the corner', () => {
  for (let seat = 0; seat < 4; seat++) for (const dice of [2, 4, 6]) {
    const g = funGame();
    move(g, seat, -1, dice);
    assert.equal(g.pieces[seat][0], TAKEOFF);
    assert.deepEqual(g.lastMove.effects, []);
    assert.equal(g.turn, dice === 6 ? seat : (seat + 1) % 4);
    move(g, seat, TAKEOFF, 1);
    assert.equal(g.pieces[seat][0], 1);
    assert.deepEqual(g.lastMove.path, [1]);
    assert.deepEqual(g.lastMove.effects, []);
  }
});

test('private aprons and home lanes never acquire ring effects or allow other colours to capture them', () => {
  for (let seat = 0; seat < 4; seat++) {
    const other = (seat + 1) % 4;
    const g = funGame();
    g.pieces[other][0] = TAKEOFF;
    g.pieces[other][1] = 52;
    move(g, seat, 50, 2);
    assert.equal(g.pieces[seat][0], 52);
    assert.deepEqual(positionFor(seat, 52), HOME_LANES[seat][1]);
    assert.deepEqual(g.lastMove.effects, []);
    assert.deepEqual(g.lastMove.captured, []);
    assert.deepEqual(g.pieces[other].slice(0, 2), [TAKEOFF, 52]);
    const bounce = funGame();
    move(bounce, seat, 55, 5);
    assert.equal(bounce.pieces[seat][0], 54);
    assert.deepEqual(bounce.lastMove.effects, []);
  }
});

test('fun ring landings still cannot hit an opponent parked on a private apron or home lane', () => {
  const g = funGame();
  g.pieces[3][0] = TAKEOFF;
  g.pieces[3][1] = 52;
  move(g, 0, 5, 2);
  assert.equal(g.pieces[0][0], 9);
  assert.deepEqual(g.pieces[3].slice(0, 2), [TAKEOFF, 52]);
  assert.deepEqual(g.lastMove.captured, []);
  assert.equal(g.lastMove.taunt, '');
});

test('fun flight still captures on both landing cells, including progress for both return animations', () => {
  const g = funGame();
  g.pieces[1][0] = 5; // physical 18
  g.pieces[1][1] = 17; // physical 30
  move(g, 0, 16, 2);
  assert.deepEqual(g.lastMove.path, [18, 30]);
  assert.deepEqual(g.pieces[1].slice(0, 2), [-1, -1]);
  assert.deepEqual(g.lastMove.captured, [
    { seat: 1, piece: 0, at: 18, from: 5 },
    { seat: 1, piece: 1, at: 30, from: 17 },
  ]);
  assert.ok(g.lastMove.taunt.length > 0);
});

test('fun effects preserve unlimited six repeats and unique move event identifiers', () => {
  const g = funGame();
  rollDice(g, 0, 6);
  movePiece(g, 0, 0);
  assert.equal(g.lastMove.id, 1);
  assert.equal(g.moveNumber, 1);
  rollDice(g, 0, 6);
  movePiece(g, 0, 0);
  assert.equal(g.pieces[0][0], 7);
  assert.equal(g.lastMove.id, 2);
  assert.equal(g.moveNumber, 2);
  assert.equal(g.turn, 0);
  const lastMove = structuredClone(g.lastMove);
  rollDice(g, 0, 6);
  assert.equal(g.turn, 0);
  assert.equal(g.phase, 'move');
  assert.deepEqual(g.lastMove, lastMove, 'a roll alone must not replay a movement animation');
  assert.equal(g.moveNumber, 2);
  movePiece(g, 0, 0);
  assert.equal(g.lastMove.id, 3);
  assert.equal(g.turn, 0);
  rollDice(g, 0, 6); movePiece(g, 0, 1);
  assert.equal(g.lastMove.id, 4);
  assert.equal(g.moveNumber, 4);
  assert.equal(g.turn, 0);
  assert.equal(g.sixes, 4);
});

test('automatic turns use fun effects and a completed player is ranked while the remaining players continue', () => {
  const g = funGame();
  autoTurn(g, 6);
  autoTurn(g, 6);
  assert.equal(g.mode, 'fun');
  assert.equal(g.pieces[0][0], 7);
  assert.deepEqual(g.lastMove.effects, [{ type: 'trap', from: 10, to: 7 }]);
  autoTurn(g, 6);
  autoTurn(g, 6);
  assert.equal(g.moveNumber, 4);
  assert.equal(g.sixes, 4);
  assert.equal(g.turn, 0, 'automation also has no consecutive-six limit');
  const finishing = funGame();
  finishing.pieces[0] = [FINISH, FINISH, FINISH, 56];
  autoTurn(finishing, 1);
  assert.equal(finishing.status, 'playing');
  assert.equal(finishing.winner, 0);
  assert.equal(finishing.players.find(player => player.seat === 0).rank, 1);
  assert.deepEqual(finishing.rankings, [0]);
  assert.equal(finishing.turn, 1);
  assert.deepEqual(finishing.lastMove.effects, []);
  assert.throws(() => rollDice(finishing, 0, 6));
});
