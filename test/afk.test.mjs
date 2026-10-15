import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, rollDice, movePiece, autoTurn, allianceAction, useItem, setAfk, skipAfk } from '../engine.mjs';
import { FINISH } from '../board.mjs';

const players = [0, 1, 2, 3].map(seat => ({ seat }));
const game = (mode = 'fun', active = players) => createGame(active, { mode, rules: { items: true, alliances: true } });
const player = (g, seat) => g.players.find(entry => entry.seat === seat);
const afkEvents = g => g.keyEvents.filter(event => event.type.startsWith('AFK_'));
const retained = g => structuredClone({
  pieces: g.pieces, frozenPieces: g.frozenPieces, allies: g.allies, invitations: g.invitations,
  betrayed: g.betrayed, ambush: g.ambush, hands: g.hands, mines: g.mines,
  stats: g.players.map(entry => entry.stats), rollCount: g.rollCount, iceCell: g.iceCell,
  lastMove: g.lastMove, moveNumber: g.moveNumber, rankings: g.rankings,
});

test('afk: classic and fun start available and a new game does not inherit old seat flags', () => {
  for (const mode of ['classic', 'fun']) {
    const g = game(mode);
    assert.deepEqual(g.players.map(entry => entry.afk), [false, false, false, false]);
    setAfk(g, 0, true);
    const next = game(mode, g.players);
    assert.deepEqual(next.players.map(entry => entry.afk), [false, false, false, false]);
    assert.equal(player(g, 0).afk, true);
    assert.deepEqual(afkEvents(next), []);
  }
});

test('afk: toggle is reversible and idempotent without extending deadline or changing gameplay', () => {
  for (const mode of ['classic', 'fun']) {
    const g = game(mode);
    g.deadline = Date.now() + 12345;
    g.pieces[0][0] = 3;
    const before = retained(g), deadline = g.deadline;
    setAfk(g, 0, true);
    assert.equal(player(g, 0).afk, true);
    assert.equal(g.deadline, deadline);
    assert.deepEqual(retained(g), before);
    assert.equal(afkEvents(g).at(-1).type, 'AFK_ON');
    const unchanged = structuredClone(g);
    setAfk(g, 0, true);
    assert.deepEqual(g, unchanged, 'repeating the same availability cannot add logs, events or IDs');
    setAfk(g, 0, false);
    assert.equal(player(g, 0).afk, false);
    assert.equal(g.deadline, deadline);
    assert.deepEqual(retained(g), before);
    assert.deepEqual(afkEvents(g).map(event => event.type), ['AFK_ON', 'AFK_OFF']);
  }
});

test('afk: invalid targets, values, ranked seats and finished games reject before mutation', () => {
  const g = game('fun', [{ seat: 0 }, { seat: 3 }]);
  for (const [seat, flag] of [[1, true], [null, true], ['0', true], [0.5, true], [4, true], [0, 1], [0, 'true'], [0, null], [0, undefined]]) {
    const before = structuredClone(g);
    assert.throws(() => setAfk(g, seat, flag));
    assert.deepEqual(g, before);
  }
  player(g, 3).rank = 1;
  const ranked = structuredClone(g);
  assert.throws(() => setAfk(g, 3, true));
  assert.deepEqual(g, ranked);
  g.status = 'finished';
  const finished = structuredClone(g);
  assert.throws(() => setAfk(g, 0, true));
  assert.deepEqual(g, finished);
});

test('afk: manual dice, moves, cards and alliance actions remain blocked until cancellation', () => {
  const g = game();
  g.pieces[0][0] = 3;
  g.pieces[1][0] = 44;
  setAfk(g, 0, true);
  const before = structuredClone(g);
  for (const reject of [
    () => rollDice(g, 0, 1),
    () => useItem(g, 0, { card: 'mine', piece: 0 }),
    () => allianceAction(g, 0, 'alliance-invite', 1),
  ]) { assert.throws(reject); assert.deepEqual(g, before); }
  setAfk(g, 0, false);
  rollDice(g, 0, 1);
  assert.equal(g.phase, 'move');
  setAfk(g, 0, true);
  const pending = structuredClone(g);
  assert.throws(() => movePiece(g, 0, 0));
  assert.deepEqual(g, pending);
  setAfk(g, 0, false);
  movePiece(g, 0, 0);
  assert.equal(g.pieces[0][0], 4);
});

test('afk: skipping a roll consumes no dice or20th-roll ice and retains every previous board fact', () => {
  for (const mode of ['classic', 'fun']) {
    const g = game(mode);
    g.pieces[0][0] = 3;
    g.frozenPieces[0][0] = true;
    g.rollCount = 19;
    g.iceCell = 9;
    if (mode === 'fun') allianceAction(g, 0, 'alliance-invite', 3);
    setAfk(g, 0, true);
    const before = retained(g);
    skipAfk(g, 1, 0, 'roll');
    assert.equal(g.turn, 1);
    assert.equal(g.phase, 'roll');
    assert.equal(g.dice, null);
    assert.equal(g.sixes, 0);
    assert.deepEqual(g.legal, []);
    assert.deepEqual(retained(g), before);
    assert.equal(player(g, 0).afk, true);
    assert.equal(afkEvents(g).at(-1).type, 'AFK_SKIP');
    assert.match(afkEvents(g).at(-1).text, /掷骰阶段/);
  }
});

test('afk: skipping a pending second-six move discards it and repeat entitlement but preserves prior move', () => {
  for (const mode of ['classic', 'fun']) {
    const g = game(mode);
    g.pieces[0][0] = 3;
    rollDice(g, 0, 6);
    movePiece(g, 0, 0);
    assert.equal(g.turn, 0);
    rollDice(g, 0, 6);
    assert.equal(g.phase, 'move');
    assert.equal(g.sixes, 2);
    g.frozenPieces[0][1] = true;
    setAfk(g, 0, true);
    const before = retained(g);
    skipAfk(g, 1, 0, 'move');
    assert.equal(g.turn, 1);
    assert.equal(g.phase, 'roll');
    assert.equal(g.dice, null);
    assert.equal(g.sixes, 0);
    assert.deepEqual(g.legal, []);
    assert.deepEqual(retained(g), before);
    assert.equal(afkEvents(g).at(-1).type, 'AFK_SKIP');
    assert.match(afkEvents(g).at(-1).text, /走棋阶段/);
  }
});

test('afk: illegal or stale skips from spectators, ranked or AFK actors cannot mutate the turn', () => {
  const g = game();
  setAfk(g, 0, true);
  setAfk(g, 3, true);
  player(g, 2).rank = 1;
  const before = structuredClone(g);
  for (const [actor, turn, phase] of [[null, 0, 'roll'], [4, 0, 'roll'], [0, 0, 'roll'], [2, 0, 'roll'], [3, 0, 'roll'], [1, 1, 'roll'], [1, '0', 'roll'], [1, 0, 'move'], [1, 0, 'other'], [1, 0, null]]) {
    assert.throws(() => skipAfk(g, actor, turn, phase));
    assert.deepEqual(g, before);
  }
  setAfk(g, 0, false);
  const available = structuredClone(g);
  assert.throws(() => skipAfk(g, 1, 0, 'roll'));
  assert.deepEqual(g, available, 'available seats cannot be skipped');
});

test('afk: skips ignore completed seats while AFK seats still participate in later rotation', () => {
  const g = game('classic');
  player(g, 1).rank = 1;
  setAfk(g, 0, true);
  skipAfk(g, 2, 0, 'roll');
  assert.equal(g.turn, 2);
  rollDice(g, 2, 1);
  rollDice(g, 3, 1);
  assert.equal(g.turn, 0, 'availability does not permanently remove an unfinished seat from rotation');
  const before = structuredClone(g);
  assert.throws(() => rollDice(g, 0, 1));
  assert.deepEqual(g, before);
  autoTurn(g, 1);
  assert.equal(g.turn, 2);
  assert.equal(player(g, 0).afk, true);
});

test('afk: trusted automation handles AFK roll and move phases, and all ranked seats clear the flag', () => {
  const frozen = game();
  frozen.pieces[0] = [5, 4, -1, -1];
  frozen.frozenPieces[0][0] = true;
  setAfk(frozen, 0, true);
  autoTurn(frozen, 1, () => 0);
  assert.equal(frozen.lastMove.piece, 1);
  assert.equal(frozen.pieces[0][0], 5);
  assert.equal(frozen.frozenPieces[0][0], true);
  assert.equal(frozen.pieces[0][1], 5);
  assert.equal(player(frozen, 0).afk, true);
  assert.equal(frozen.rollCount, 1);
  const pending = game();
  pending.pieces[0][0] = 4;
  rollDice(pending, 0, 1);
  setAfk(pending, 0, true);
  autoTurn(pending, 6, () => 0);
  assert.equal(pending.pieces[0][0], 5);
  assert.equal(pending.rollCount, 1, 'automating a pending move does not roll again');
  assert.equal(player(pending, 0).afk, true);
  for (const mode of ['classic', 'fun']) {
    const g = game(mode, [{ seat: 0 }, { seat: 1 }]);
    g.pieces[0] = [FINISH, FINISH, FINISH, FINISH - 1];
    setAfk(g, 0, true);
    setAfk(g, 1, true);
    autoTurn(g, 1);
    assert.equal(g.status, 'finished');
    assert.deepEqual(g.players.map(entry => entry.afk), [false, false]);
    assert.deepEqual(g.players.map(entry => entry.rank), [1, 2]);
  }
});
