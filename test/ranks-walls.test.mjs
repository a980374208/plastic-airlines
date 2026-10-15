import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, rollDice, movePiece, autoTurn } from '../engine.mjs';
import { COLORS, STARTS, FINISH, TAKEOFF } from '../board.mjs';

const seats = [0, 1, 2, 3];
const emptyStats = () => Object.fromEntries(COLORS.map(color => [color.key, 0]));
const player = (game, seat) => game.players.find(value => value.seat === seat);
const game = (mode = 'classic', active = seats) => createGame(active.map(seat => ({ seat })), { mode });

function move(g, seat, from, dice, piece = 0) {
  g.turn = seat;
  g.phase = 'roll';
  g.sixes = 0;
  g.pieces[seat][piece] = from;
  rollDice(g, seat, dice);
  return movePiece(g, seat, piece);
}

function opponentAt(g, movingSeat, progress, other, count = 2, firstPiece = 0) {
  const p = (STARTS[movingSeat] + progress - STARTS[other] + 52) % 52;
  assert.ok(p <= 50, 'the fixture must place every opponent on its public ring');
  for (let i = 0; i < count; i++) g.pieces[other][firstPiece + i] = p;
  return p;
}

function assertNoStats(g) {
  for (const value of g.players) assert.deepEqual(value.stats, emptyStats());
}

for (const mode of ['classic', 'fun']) {
  test(`${mode}: four players finish in order and only the last remaining player ends the game`, () => {
    const g = game(mode);
    for (const seat of [0, 1, 2]) g.pieces[seat] = [FINISH, FINISH, FINISH, 56];
    for (const seat of [0, 1, 2]) {
      rollDice(g, seat, 1);
      movePiece(g, seat, 3);
      assert.equal(player(g, seat).rank, seat + 1);
      assert.equal(g.winner, 0, 'winner remains the first finisher');
      assert.equal(g.status, seat < 2 ? 'playing' : 'finished');
      assert.deepEqual(g.rankings, seat < 2 ? seats.slice(0, seat + 1) : seats);
      assert.equal(g.phase, 'roll');
      assert.deepEqual(g.legal, []);
      if (seat < 2) assert.equal(g.turn, seat + 1);
    }
    assert.equal(player(g, 3).rank, 4);
    assert.deepEqual(g.pieces[3], [-1, -1, -1, -1], 'automatic last rank does not invent arrivals');
    assert.equal(g.deadline, null);
    for (const seat of seats) assert.throws(() => rollDice(g, seat, 1));
    assert.deepEqual(autoTurn(g, 6), g);
  });

  test(`${mode}: two players still finish when the first player arrives`, () => {
    const g = game(mode, [1, 3]);
    g.pieces[1] = [FINISH, FINISH, FINISH, 56];
    rollDice(g, 1, 1);
    movePiece(g, 1, 3);
    assert.equal(g.status, 'finished');
    assert.equal(g.winner, 1);
    assert.deepEqual(g.rankings, [1, 3]);
    assert.equal(player(g, 1).rank, 1);
    assert.equal(player(g, 3).rank, 2);
  });

  test(`${mode}: a finishing six loses its extra roll and rotation skips every ranked seat`, () => {
    const g = game(mode);
    g.pieces[0] = [FINISH, FINISH, FINISH, 51];
    rollDice(g, 0, 6);
    movePiece(g, 0, 3);
    assert.equal(player(g, 0).rank, 1);
    assert.equal(g.turn, 1);
    assert.equal(g.sixes, 0);
    for (const seat of [1, 2, 3]) rollDice(g, seat, 1);
    assert.equal(g.turn, 1, 'completed seat 0 is skipped when rotation wraps');
    g.pieces[2] = [FINISH, FINISH, FINISH, 56];
    rollDice(g, 1, 1);
    rollDice(g, 2, 1);
    movePiece(g, 2, 3);
    assert.equal(player(g, 2).rank, 2);
    assert.equal(g.turn, 3);
    rollDice(g, 3, 1);
    assert.equal(g.turn, 1);
    rollDice(g, 1, 1);
    assert.equal(g.turn, 3, 'rotation also skips a ranked interior seat');
  });

  test(`${mode}: ranked players reject direct actions and stale automatic turns cannot move them`, () => {
    const g = game(mode);
    g.pieces[0] = [FINISH, FINISH, FINISH, 56];
    rollDice(g, 0, 1);
    movePiece(g, 0, 3);
    const finishedPieces = [...g.pieces[0]];
    const finishedStats = structuredClone(player(g, 0).stats);
    g.turn = 0;
    assert.throws(() => rollDice(g, 0, 6));
    g.phase = 'move';
    g.legal = [0];
    g.sixes = 2;
    assert.throws(() => movePiece(g, 0, 0));
    autoTurn(g, 2);
    assert.deepEqual(g.pieces[0], finishedPieces);
    assert.deepEqual(player(g, 0).stats, finishedStats);
    assert.equal(player(g, 0).rank, 1);
    assert.notEqual(g.turn, 0);
    assert.notEqual(g.lastMove.seat, 0, 'the automatic action must belong to an unfinished player');
  });

  test(`${mode}: fewer steps than the nearest wall preserve normal movement`, () => {
    const g = game(mode);
    const at = opponentAt(g, 0, 7, 3);
    move(g, 0, 3, 1);
    assert.equal(g.pieces[0][0], 4);
    assert.deepEqual(g.pieces[3].slice(0, 2), [at, at]);
    assert.deepEqual(g.lastMove.events, []);
    assertNoStats(g);
  });

  test(`${mode}: exact steps break a two-plane wall, return all participants and count only one self-return`, () => {
    const g = game(mode);
    opponentAt(g, 0, 7, 3);
    move(g, 0, 3, 4);
    assert.equal(g.pieces[0][0], -1);
    assert.deepEqual(g.pieces[3].slice(0, 2), [-1, -1]);
    assert.equal(g.lastMove.events[0].type, 'WALL_BREAK');
    assert.equal(g.lastMove.captured.length, 2);
    assert.equal(g.lastMove.selfReturned, true);
    assert.equal(g.lastMove.selfReturnFrom, 7);
    assert.deepEqual(g.lastMove.effects, [], 'the wall wins over a speed cell on its square');
    assert.deepEqual(player(g, 0).stats, { green: 1, red: 0, yellow: 0, blue: 2 });
    assert.deepEqual(player(g, 3).stats, emptyStats(), 'being returned is not a capture statistic');
  });

  test(`${mode}: excess steps bounce from the square before the nearest wall without rewards`, () => {
    const g = game(mode);
    const at = opponentAt(g, 0, 7, 3);
    move(g, 0, 3, 6);
    assert.equal(g.pieces[0][0], 4, '(wall 7 - 1) - (6 steps - distance 4) = 4');
    assert.deepEqual(g.pieces[3].slice(0, 2), [at, at]);
    assert.deepEqual(g.lastMove.events.map(event => event.type), ['WALL_BOUNCE']);
    assert.deepEqual(g.lastMove.effects, []);
    assertNoStats(g);
  });
}

test('new games have independent colour counters, empty rankings and reset previous results', () => {
  const first = game();
  assert.deepEqual(first.rankings, []);
  for (const value of first.players) {
    assert.equal(value.rank, null);
    assert.deepEqual(value.stats, emptyStats());
  }
  player(first, 0).stats.red = 7;
  assert.equal(player(first, 1).stats.red, 0);
  const fresh = createGame(first.players, { mode: 'fun' });
  assertNoStats(fresh);
  assert.deepEqual(fresh.rankings, []);
});

test('a three-player game ranks its final player immediately after the second arrival', () => {
  const g = game('fun', [0, 2, 3]);
  for (const seat of [0, 2]) g.pieces[seat] = [FINISH, FINISH, FINISH, 56];
  rollDice(g, 0, 1); movePiece(g, 0, 3);
  assert.equal(g.status, 'playing');
  rollDice(g, 2, 1); movePiece(g, 2, 3);
  assert.equal(g.status, 'finished');
  assert.deepEqual(g.rankings, [0, 2, 3]);
  assert.equal(player(g, 3).rank, 3);
});

test('finished and private-home planes never participate in capture or wall formation', () => {
  const g = game();
  player(g, 3).rank = 1;
  g.rankings = [3];
  g.winner = 3;
  opponentAt(g, 0, 7, 3);
  g.pieces[1] = [FINISH, FINISH, 52, TAKEOFF];
  move(g, 0, 3, 4);
  assert.equal(g.pieces[0][0], 7);
  assert.deepEqual(g.lastMove.events, []);
  assert.deepEqual(g.lastMove.captured, []);
  assertNoStats(g);
});

test('ordinary captures count the victims colour and never increase the victims statistics', () => {
  for (const mode of ['classic', 'fun']) {
    const g = game(mode);
    opponentAt(g, 0, 3, 3, 1);
    move(g, 0, 2, 1);
    assert.equal(g.pieces[3][0], -1);
    assert.deepEqual(player(g, 0).stats, { green: 0, red: 0, yellow: 0, blue: 1 });
    assert.deepEqual(player(g, 3).stats, emptyStats());
  }
});

test('capture statistics include both the initial speed landing and its extra landing', () => {
  const g = game('fun');
  opponentAt(g, 0, 7, 3, 1);
  opponentAt(g, 0, 9, 1, 1);
  move(g, 0, 5, 2);
  assert.equal(g.pieces[0][0], 9);
  assert.deepEqual(player(g, 0).stats, { green: 0, red: 1, yellow: 0, blue: 1 });
  assert.deepEqual(player(g, 1).stats, emptyStats());
  assert.deepEqual(player(g, 3).stats, emptyStats());
});

test('trap captures on the active landing count while captures caused by retreat do not', () => {
  const g = game('fun');
  opponentAt(g, 0, 10, 3, 1);
  opponentAt(g, 0, 7, 1, 1);
  move(g, 0, 8, 2);
  assert.deepEqual(g.lastMove.captured.map(value => value.seat), [3, 1]);
  assert.equal(g.pieces[0][0], 7);
  assert.deepEqual(player(g, 0).stats, { green: 0, red: 0, yellow: 0, blue: 1 });
  assert.deepEqual(player(g, 1).stats, emptyStats());
});

test('safe coexistence and friendly stacks contribute no capture statistics', () => {
  const g = game('fun');
  opponentAt(g, 0, 2, 3, 2);
  g.pieces[0][1] = 2;
  move(g, 0, 1, 1);
  assert.equal(g.pieces[0][0], 2);
  assert.equal(g.pieces[0][1], 2);
  assert.deepEqual(g.lastMove.captured, []);
  assert.deepEqual(g.lastMove.events, []);
  assertNoStats(g);
});

test('three stacked opponents are a wall and self-return counts once regardless of its size', () => {
  const g = game('fun');
  opponentAt(g, 0, 7, 3, 3);
  move(g, 0, 3, 4);
  assert.equal(g.pieces[0][0], -1);
  assert.deepEqual(g.pieces[3].slice(0, 3), [-1, -1, -1]);
  assert.deepEqual(player(g, 0).stats, { green: 1, red: 0, yellow: 0, blue: 3 });
  assert.equal(g.lastMove.events.length, 1);
});

test('wall breaking returns every enemy on the wall square and counts each corresponding colour', () => {
  const g = game();
  opponentAt(g, 0, 20, 1, 2);
  opponentAt(g, 0, 20, 2, 1);
  move(g, 0, 16, 4);
  assert.equal(g.pieces[0][0], -1);
  assert.deepEqual(g.pieces[1].slice(0, 2), [-1, -1]);
  assert.equal(g.pieces[2][0], -1);
  assert.deepEqual(player(g, 0).stats, { green: 1, red: 2, yellow: 1, blue: 0 });
});

test('two different enemy colours sharing a square do not form a same-colour wall', () => {
  const g = game();
  opponentAt(g, 0, 20, 1, 1);
  opponentAt(g, 0, 20, 2, 1);
  move(g, 0, 16, 4);
  assert.equal(g.pieces[0][0], 20);
  assert.deepEqual(g.lastMove.events, []);
  assert.deepEqual(player(g, 0).stats, { green: 0, red: 1, yellow: 1, blue: 0 });
});

test('the nearest forward wall wins and a rear obstacle stops the one-time bounce before itself', () => {
  const g = game('fun');
  const forward = opponentAt(g, 0, 7, 3, 2);
  const farther = opponentAt(g, 0, 9, 3, 2, 2);
  const rear = opponentAt(g, 0, 3, 2, 2);
  move(g, 0, 5, 6);
  assert.equal(g.pieces[0][0], 4, 'retreat from 6 stops before the rear wall at 3');
  assert.deepEqual(g.pieces[3], [forward, forward, farther, farther]);
  assert.deepEqual(g.pieces[2].slice(0, 2), [rear, rear]);
  assert.deepEqual(g.lastMove.events.map(value => value.type), ['WALL_BOUNCE']);
  assertNoStats(g);
});

test('bounce cannot go behind the players own start or return a plane to its airport', () => {
  for (const from of [0, TAKEOFF]) {
    const g = game('fun');
    opponentAt(g, 0, 1, 3, 2);
    move(g, 0, from, 6);
    assert.equal(g.pieces[0][0], 0);
    assert.equal(g.lastMove.events[0].type, 'WALL_BOUNCE');
    assertNoStats(g);
  }
});

test('a players own two-plane wall allows their planes through in either mode', () => {
  for (const mode of ['classic', 'fun']) {
    const g = game(mode);
    g.pieces[0][1] = g.pieces[0][2] = 7;
    move(g, 0, 3, 4);
    assert.equal(g.pieces[0][0], mode === 'fun' ? 9 : 7);
    assert.deepEqual(g.pieces[0].slice(1, 3), [7, 7]);
    assert.deepEqual(g.lastMove.events, []);
    assertNoStats(g);
  }
});

test('safe-island stacks cannot block either pass-through or direct landings in fun mode', () => {
  for (const dice of [1, 2]) {
    const g = game('fun');
    const at = opponentAt(g, 0, 2, 3, 3);
    move(g, 0, 1, dice);
    assert.equal(g.pieces[0][0], 1 + dice);
    assert.deepEqual(g.pieces[3].slice(0, 3), [at, at, at]);
    assert.deepEqual(g.lastMove.events, []);
    assertNoStats(g);
  }
  const classic = game();
  opponentAt(classic, 0, 2, 3, 2);
  move(classic, 0, 1, 1);
  assert.equal(classic.lastMove.events[0].type, 'WALL_BREAK', 'classic mode has no safe-island exemption');
});

test('speed extra steps stop before a wall both en route and at their intended destination', () => {
  for (const wall of [8, 9]) {
    const g = game('fun');
    const at = opponentAt(g, 0, wall, 3, 2);
    move(g, 0, 5, 2);
    assert.equal(g.pieces[0][0], wall - 1);
    assert.deepEqual(g.pieces[3].slice(0, 2), [at, at]);
    assert.deepEqual(g.lastMove.effects, [{ type: 'speed', from: 7, to: wall - 1 }]);
    assert.deepEqual(g.lastMove.events, [], 'bonus speed cannot break or bounce off a wall');
    assertNoStats(g);
  }
});

test('trap retreat stops before a rear wall without breaking it or giving statistics', () => {
  const g = game('fun');
  const at = opponentAt(g, 0, 8, 3, 2);
  move(g, 0, 9, 1);
  assert.equal(g.pieces[0][0], 9);
  assert.deepEqual(g.pieces[3].slice(0, 2), [at, at]);
  assert.deepEqual(g.lastMove.effects, [{ type: 'trap', from: 10, to: 9 }]);
  assert.deepEqual(g.lastMove.events, []);
  assertNoStats(g);
});

test('a wall on a trap square resolves before that squares retreat effect', () => {
  const g = game('fun');
  opponentAt(g, 0, 10, 3, 2);
  move(g, 0, 8, 2);
  assert.equal(g.pieces[0][0], -1);
  assert.equal(g.lastMove.events[0].type, 'WALL_BREAK');
  assert.deepEqual(g.lastMove.effects, []);
  assert.deepEqual(player(g, 0).stats, { green: 1, red: 0, yellow: 0, blue: 2 });
});

test('same-colour jumps may fly over walls but break an enemy wall at their landing', () => {
  const over = game();
  const at = opponentAt(over, 0, 24, 1, 2);
  move(over, 0, 20, 2);
  assert.equal(over.pieces[0][0], 26);
  assert.deepEqual(over.pieces[1].slice(0, 2), [at, at]);
  assertNoStats(over);
  const landing = game();
  opponentAt(landing, 0, 26, 1, 2);
  move(landing, 0, 20, 2);
  assert.equal(landing.pieces[0][0], -1);
  assert.equal(landing.lastMove.events[0].type, 'WALL_BREAK');
  assert.deepEqual(player(landing, 0).stats, { green: 1, red: 2, yellow: 0, blue: 0 });
});

test('flight preserves airborne crossing and applies wall priority only at its landing', () => {
  const over = game('fun');
  const at = opponentAt(over, 0, 24, 1, 2);
  move(over, 0, 16, 2);
  assert.equal(over.pieces[0][0], 30);
  assert.deepEqual(over.pieces[1].slice(0, 2), [at, at]);
  const landing = game('fun');
  opponentAt(landing, 0, 30, 1, 2);
  move(landing, 0, 16, 2);
  assert.equal(landing.pieces[0][0], -1);
  assert.equal(landing.lastMove.events[0].type, 'WALL_BREAK');
  assert.deepEqual(player(landing, 0).stats, { green: 1, red: 2, yellow: 0, blue: 0 });
});

test('a bounce landing still captures an isolated enemy without counting that passive return', () => {
  for (const mode of ['classic', 'fun']) {
    const g = game(mode);
    opponentAt(g, 0, 8, 3, 2);
    opponentAt(g, 0, 5, 2, 1);
    move(g, 0, 4, 6);
    assert.equal(g.pieces[0][0], 5);
    assert.equal(g.pieces[2][0], -1);
    assert.deepEqual(g.lastMove.captured.map(value => value.seat), [2]);
    assert.deepEqual(g.lastMove.events.map(value => value.type), ['WALL_BOUNCE']);
    assertNoStats(g);
  }
});
