import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, rollDice, movePiece, autoTurn } from '../engine.mjs';
import { FINISH, TAKEOFF, TAKEOFFS, STARTS, ROUTE, positionFor, HOME_LANES } from '../board.mjs';

const game = () => createGame([{ seat: 0 }, { seat: 1 }]);
test('the 52 physical cells are unique and each colour enters its own home lane', () => {
  assert.equal(new Set(ROUTE.map(p => p.join(','))).size, 52);
  for (let seat = 0; seat < 4; seat++) {
    assert.deepEqual(positionFor(seat, 51), HOME_LANES[seat][0]);
    assert.deepEqual(positionFor(seat, 56), HOME_LANES[seat][5]);
  }
});
test('2, 4 and 6 launch every colour; only 6 grants another roll', () => {
  for (let seat=0;seat<4;seat++) for (const value of [2,4,6]) {
    const other = (seat+1)%4;
    const g = createGame([{seat},{seat:other}]);
    g.turn = seat;
    rollDice(g,seat,value);
    assert.deepEqual(g.legal,[0,1,2,3]);
    movePiece(g,seat,0);
    assert.equal(g.pieces[seat][0],TAKEOFF);
    assert.equal(g.turn,value===6?seat:other);
    assert.equal(g.phase,'roll');
  }
});
test('1, 3 and 5 cannot launch but still move planes already on the route', () => {
  for (const value of [1,3,5]) {
    const g = game();
    rollDice(g,0,value);
    assert.deepEqual(g.legal,[]);
    assert.equal(g.turn,1);
    const flying = game();
    flying.pieces[0][0] = 0;
    rollDice(flying,0,value);
    assert.deepEqual(flying.legal,[0]);
    assert.equal(flying.phase,'move');
  }
});
test('even dice allow either an airborne plane or an airport plane, excluding finished planes', () => {
  for (const value of [2,4]) {
    const g = game();
    g.pieces[0] = [0,-1,FINISH,-1];
    rollDice(g,0,value);
    assert.deepEqual(g.legal,[0,1,3]);
    movePiece(g,0,1);
    assert.equal(g.pieces[0][1],TAKEOFF);
    assert.equal(g.turn,1);
  }
});
test('turn, phase and plane ownership cannot be bypassed', () => {
  const g = game();
  assert.throws(() => rollDice(g, 1, 6));
  assert.throws(() => movePiece(g, 0, 0));
  rollDice(g, 0, 6);
  assert.throws(() => rollDice(g, 0, 6));
  assert.throws(() => movePiece(g, 0, 9));
});
test('consecutive sixes have no limit and every rolled move remains valid', () => {
  const g = game();
  for (let i=0;i<8;i++) {
    const before = structuredClone(g.pieces);
    rollDice(g,0,6);
    assert.equal(g.turn, 0);
    assert.equal(g.phase, 'move');
    assert.equal(g.sixes, i + 1);
    assert.deepEqual(g.pieces, before, 'a roll cannot undo previous moves');
    movePiece(g,0,i % 4);
    assert.equal(g.moveNumber, i + 1);
    assert.equal(g.turn, 0);
    assert.equal(g.phase, 'roll');
  }
  rollDice(g,0,2); movePiece(g,0,0);
  assert.equal(g.turn, 1);
  assert.equal(g.sixes, 0);
});
test('same-colour jump captures at ordinary and bonus landing cells', () => {
  const g = game();
  g.pieces[0][0] = 20;
  g.pieces[1][0] = 9; // physical index 22
  g.pieces[1][1] = 13; // physical index 26
  rollDice(g,0,2); movePiece(g,0,0);
  assert.equal(g.pieces[0][0], 26);
  assert.deepEqual(g.pieces[1].slice(0,2), [-1,-1]);
  assert.equal(g.lastMove.captured.length, 2);
});
test('flight covers twelve cells and does not continue bonus jumps', () => {
  const g = game();
  g.pieces[0][0] = 16;
  g.pieces[1][0] = 5; // physical index 18
  g.pieces[1][1] = 17; // physical index 30
  rollDice(g,0,2); movePiece(g,0,0);
  assert.equal(g.pieces[0][0], 30);
  assert.deepEqual(g.lastMove.path, [18,30]);
  assert.deepEqual(g.pieces[1].slice(0,2), [-1,-1]);
});
test('all colours can jump onto a flight cell, but a jump from its landing is not a flight', () => {
  for (let seat=0;seat<4;seat++) {
    const g = createGame([{seat},{seat:(seat+1)%4}]);
    g.turn = seat;
    g.pieces[seat][0] = 12;
    rollDice(g,seat,2); movePiece(g,seat,0);
    assert.deepEqual(g.lastMove.path,[14,18,30]);
    assert.equal(g.pieces[seat][0],30);
    assert.match(g.log.at(-1).text,/飞越航线/);
    g.turn = seat;
    g.pieces[seat][0] = 28;
    rollDice(g,seat,2); movePiece(g,seat,0);
    assert.deepEqual(g.lastMove.path,[30,34]);
    assert.doesNotMatch(g.log.at(-1).text,/飞越航线/);
  }
});
test('own home lane never collides with another colour and overshoot bounces', () => {
  const g = game();
  g.pieces[0][0] = 55;
  g.pieces[1][0] = 3;
  rollDice(g,0,5); movePiece(g,0,0);
  assert.equal(g.pieces[0][0], 54);
  assert.equal(g.pieces[1][0], 3);
});
test('all four arrivals finish the game and reject further actions', () => {
  const g = game();
  g.pieces[0] = [FINISH,FINISH,FINISH,56];
  rollDice(g,0,1); movePiece(g,0,3);
  assert.equal(g.status, 'finished');
  assert.equal(g.winner, 0);
  assert.throws(() => rollDice(g,0,6));
});
test('timeout completes a pending move or rolls and moves automatically', () => {
  const g = game();
  autoTurn(g,6);
  assert.equal(g.pieces[0][0],TAKEOFF);
  assert.equal(g.turn,0);
  rollDice(g,0,2);
  autoTurn(g,1);
  assert.equal(g.pieces[0][0],6);
  assert.equal(g.turn,1);
});
test('timeout can launch on 2 and 4 and hands the next turn to the other player', () => {
  for (const value of [2,4]) {
    const g = game();
    autoTurn(g,value);
    assert.equal(g.pieces[0][0],TAKEOFF);
    assert.equal(g.turn,1);
    assert.equal(g.phase,'roll');
  }
});

test('private aprons are distinct from every shared cell and belong to their colour', () => {
  for (let seat = 0; seat < 4; seat++) {
    assert.deepEqual(positionFor(seat, TAKEOFF), TAKEOFFS[seat]);
    assert.equal(ROUTE.some(p => p.join(',') === TAKEOFFS[seat].join(',')), false);
    for (let other = 0; other < 4; other++) {
      if (other === seat) continue;
      for (let progress = 0; progress < FINISH; progress++) {
        assert.notDeepEqual(positionFor(other, progress), TAKEOFFS[seat]);
      }
    }
  }
});

test('a plane leaves its private apron on any roll, counting the adjacent triangle as one', () => {
  for (let seat = 0; seat < 4; seat++) for (const value of [1,2,3,4,5,6]) {
    const g = createGame([{ seat }, { seat: (seat + 1) % 4 }]);
    g.turn = seat;
    g.pieces[seat][0] = TAKEOFF;
    rollDice(g, seat, value);
    assert.ok(g.legal.includes(0));
    movePiece(g, seat, 0);
    assert.equal(g.lastMove.path[0], value);
    assert.ok(g.pieces[seat][0] >= 0);
    assert.equal(g.turn, value === 6 ? seat : (seat + 1) % 4);
    if (value === 1) {
      assert.equal(g.pieces[seat][0], 1);
      assert.deepEqual(positionFor(seat, 1), ROUTE[(STARTS[seat] + 1) % 52]);
    }
  }
});

test('private apron planes cannot be captured when opponents visit adjacent shared cells', () => {
  for (let owner = 0; owner < 4; owner++) for (let other = 0; other < 4; other++) {
    if (owner === other) continue;
    const g = createGame([{ seat: owner }, { seat: other }]);
    g.turn = other;
    g.pieces[owner][0] = TAKEOFF;
    const adjacent = (STARTS[owner] - STARTS[other] + 52) % 52;
    g.pieces[other][0] = adjacent - 1;
    rollDice(g, other, 1);
    movePiece(g, other, 0);
    assert.equal(g.pieces[owner][0], TAKEOFF);
    assert.deepEqual(g.lastMove.captured, []);
  }
});

test('leaving an apron can capture an opponent on the adjacent shared triangle', () => {
  const g = createGame([{ seat: 0 }, { seat: 3 }]);
  g.pieces[0][0] = TAKEOFF;
  g.pieces[3][0] = 14;
  rollDice(g, 0, 1);
  movePiece(g, 0, 0);
  assert.equal(g.pieces[0][0], 1);
  assert.equal(g.pieces[3][0], -1);
  assert.equal(g.lastMove.captured.length, 1);
});
