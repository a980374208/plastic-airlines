import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, rollDice, movePiece, autoTurn, allianceAction, useItem } from '../engine.mjs';
import { STARTS, FINISH } from '../board.mjs';

const players = [0, 1, 2, 3].map(seat => ({ seat }));
const game = (mode = 'fun', rules = {}, active = players) => createGame(active, { mode, rules });
const types = g => g.keyEvents.map(event => event.type);

function assertEvents(g) {
  assert.ok(Array.isArray(g.keyEvents));
  for (const event of g.keyEvents) {
    assert.deepEqual(Object.keys(event).sort(), ['at', 'id', 'text', 'type']);
    assert.ok(Number.isInteger(event.id) && event.id > 0);
    assert.ok(Number.isFinite(event.at));
    assert.ok(typeof event.text === 'string' && event.text.trim());
    assert.ok(typeof event.type === 'string' && event.type);
  }
  assert.equal(new Set(g.keyEvents.map(event => event.id)).size, g.keyEvents.length);
  assert.ok(g.keyEvents.every((event, index, events) => index === 0 || event.id > events[index - 1].id));
  assert.equal(g.keyEvents.at(-1)?.id ?? 0, g.eventNumber);
}

function move(g, from, dice, randomIndex = () => 0) {
  g.pieces[0][0] = from;
  rollDice(g, 0, dice, randomIndex);
  movePiece(g, 0, 0, randomIndex);
  assertEvents(g);
  return g;
}

function enemyAt(g, progress, seat = 3, count = 1) {
  const at = (progress - STARTS[seat] + 52) % 52;
  assert.ok(at <= 50);
  for (let piece = 0; piece < count; piece++) g.pieces[seat][piece] = at;
}

test('key-events: each new game starts with an independent structured START history', () => {
  for (const mode of ['classic', 'fun']) {
    const first = game(mode), second = game(mode);
    assertEvents(first);
    assert.deepEqual(types(first), ['START']);
    assert.equal(first.eventNumber, 1);
    assert.match(first.keyEvents[0].text, /准备起航/);
    assert.notEqual(first.keyEvents, first.log);
    assert.notEqual(first.keyEvents, second.keyEvents);
    assert.notEqual(first.keyEvents[0], first.log[0]);
    first.keyEvents[0].text = 'only this history changes';
    assert.match(first.log[0].text, /准备起航/);
    assert.match(second.keyEvents[0].text, /准备起航/);
  }
});

test('key-events: ordinary rolls and moves do not dilute key history and rejected actions write nothing', () => {
  const g = game('classic');
  const initial = structuredClone(g.keyEvents);
  for (let i = 0; i < 60; i++) rollDice(g, g.turn, 1);
  assert.equal(g.log.length, 30, 'routine log still has its existing independent retention limit');
  assert.deepEqual(g.keyEvents, initial, 'routine rolls cannot evict the START history');
  g.pieces[g.turn][0] = 4;
  rollDice(g, g.turn, 1);
  movePiece(g, g.turn, 0);
  assert.deepEqual(g.keyEvents, initial, 'an uneventful ordinary move stays in the routine log');
  const before = structuredClone(g);
  for (const reject of [
    () => rollDice(g, (g.turn + 1) % 4, 1),
    () => rollDice(g, g.turn, 7),
    () => movePiece(g, g.turn, 0),
    () => allianceAction(g, g.turn, 'alliance-invite', (g.turn + 1) % 4),
    () => useItem(g, g.turn, { card: 'invented' }),
  ]) {
    assert.throws(reject);
    assert.deepEqual(g, before, 'illegal actions cannot add misleading history or advance IDs');
  }
  assertEvents(g);
});

test('key-events: captures, wall outcomes and a mine hit record their actual event types', () => {
  for (const [type, from, dice, at, count] of [
    ['CAPTURE', 2, 1, 3, 1],
    ['WALL_BREAK', 18, 3, 21, 2],
    ['WALL_BOUNCE', 18, 4, 21, 2],
  ]) {
    const g = game('classic');
    enemyAt(g, at, 3, count);
    move(g, from, dice);
    assert.ok(types(g).includes(type), type + ' is durable history rather than only lastMove');
    if (type === 'CAPTURE') assert.equal(g.lastMove.captured.length, 1);
    else assert.ok(g.lastMove.events.some(event => event.type === type));
  }
  const speedCapture = game();
  enemyAt(speedCapture, 9);
  move(speedCapture, 5, 2);
  assert.deepEqual(types(speedCapture), ['START', 'CAPTURE'], 'one compound move records a single fact using capture priority');
  assert.match(speedCapture.keyEvents.at(-1).text, /加速前进 2 格/);
  assert.match(speedCapture.keyEvents.at(-1).text, /撞回 1 架飞机/);
  const mine = game('fun', { items: true });
  mine.mines.push({ seat: 1, index: 3 });
  move(mine, 2, 1);
  assert.equal(mine.lastMove.returnReason, 'mine');
  assert.ok(types(mine).includes('MINE_HIT'));
});

test('key-events: fixed specials, ice generation, freezing and selected-plane thawing persist as typed key facts', () => {
  for (const [type, from, dice] of [['SPEED', 5, 2], ['TRAP', 8, 2], ['SAFE', 1, 1], ['LUCKY', 10, 1]]) {
    const g = move(game(), from, dice);
    assert.ok(types(g).includes(type), type + ' has a durable key record');
  }
  for (const [wall, randomIndex, to, wording] of [
    [12, 5, 11, /幸运格随机前进 3 格，实际停留原格/],
    [14, 5, 13, /幸运格随机前进 3 格，实际前进 2 格/],
    [9, 0, 10, /幸运格随机后退 3 格，实际后退 1 格/],
  ]) {
    const blocked = game();
    enemyAt(blocked, wall, 3, 2);
    move(blocked, 10, 1, () => randomIndex);
    assert.equal(blocked.pieces[0][0], to);
    assert.equal(blocked.keyEvents.at(-1).type, 'LUCKY');
    assert.match(blocked.keyEvents.at(-1).text, wording, 'key fact distinguishes the lucky draw from the wall-limited actual movement');
    assert.match(blocked.log.at(-1).text, wording);
  }
  const generated = game();
  generated.rollCount = 19;
  rollDice(generated, 0, 1, () => 0);
  assert.equal(generated.rollCount, 20);
  assert.ok(Number.isInteger(generated.iceCell));
  assert.ok(types(generated).includes('ICE_GENERATED'));
  assertEvents(generated);
  const frozen = game();
  frozen.iceCell = 6;
  move(frozen, 5, 1);
  assert.equal(frozen.frozenPieces[0][0], true);
  assert.ok(types(frozen).includes('FROZEN'));
  for (const seat of [1, 2, 3]) rollDice(frozen, seat, 1);
  const beforeThaw = frozen.keyEvents.length;
  rollDice(frozen, 0, 6);
  assert.equal(frozen.frozenPieces[0][0], true);
  assert.equal(frozen.keyEvents.length, beforeThaw, 'a six alone does not record a thaw');
  movePiece(frozen, 0, 0);
  assert.equal(frozen.frozenPieces[0][0], false);
  assert.equal(frozen.keyEvents.length, beforeThaw + 1);
  assert.equal(frozen.keyEvents.at(-1).type, 'THAWED');
  assert.match(frozen.keyEvents.at(-1).text, /解除冰冻/);
  assertEvents(frozen);
});

test('key-events: alliance decisions, betrayal bonus and each played item retain public outcomes', () => {
  const social = game('fun', { alliances: true });
  allianceAction(social, 0, 'alliance-invite', 1);
  allianceAction(social, 1, 'alliance-decline', 0);
  allianceAction(social, 0, 'alliance-invite', 1);
  allianceAction(social, 0, 'alliance-cancel', 1);
  allianceAction(social, 0, 'alliance-invite', 1);
  allianceAction(social, 1, 'alliance-accept', 0);
  allianceAction(social, 0, 'alliance-betray', null, () => 0);
  assert.deepEqual(types(social).slice(1), ['ALLIANCE_INVITE', 'ALLIANCE_DECLINE', 'ALLIANCE_INVITE', 'ALLIANCE_CANCEL', 'ALLIANCE_INVITE', 'ALLIANCE_ACCEPT', 'BETRAYAL', 'BETRAYAL_VICTIM']);
  assert.equal(social.diceDouble[0], true);
  assert.equal(social.bountyRounds[0], 3);
  assert.equal(social.betrayedBy[1], 0);
  for (const [card, type] of [['stun', 'STUN'], ['mine', 'MINE_SET'], ['missile', 'MISSILE']]) {
    const g = game('fun', { items: true });
    g.pieces[0][0] = 3;
    enemyAt(g, 5, 1);
    useItem(g, 0, { card, piece: 0, targetSeat: 1, targetPiece: 0 });
    assert.ok(types(g).includes(type), 'played ' + card + ' records its public result');
    assertEvents(g);
  }
});

test('key-events: arrivals, ranks, finish and automatic turns persist without a six-repeat forfeit', () => {
  for (const mode of ['classic', 'fun']) {
    const g = game(mode, {}, [{ seat: 0 }, { seat: 1 }]);
    g.pieces[0] = [FINISH, FINISH, FINISH, FINISH - 1];
    rollDice(g, 0, 1);
    movePiece(g, 0, 3);
    assert.equal(g.status, 'finished');
    for (const type of ['ARRIVAL', 'RANK', 'FINISH']) assert.ok(types(g).includes(type), mode + ' records ' + type);
    assertEvents(g);
  }
  const repeated = game('classic');
  for (let i = 0; i < 4; i++) { rollDice(repeated, 0, 6); movePiece(repeated, 0, i); }
  assert.equal(repeated.turn, 0);
  assert.equal(repeated.moveNumber, 4);
  assert.deepEqual(types(repeated), ['START'], 'ordinary six repeats never create a forfeited-roll fact');
  assertEvents(repeated);
  const automatic = game('classic');
  autoTurn(automatic, 1);
  assert.ok(types(automatic).includes('AUTO_TURN'));
  assertEvents(automatic);
});

test('key-events: monotonic IDs preserve same-millisecond repeated facts and retain exactly the latest50', t => {
  const at = 123456789;
  t.mock.method(Date, 'now', () => at);
  const g = game('fun', { alliances: true });
  for (let i = 0; i < 30; i++) {
    allianceAction(g, 0, 'alliance-invite', 1);
    allianceAction(g, 0, 'alliance-cancel', 1);
  }
  assert.equal(g.eventNumber, 61);
  assert.equal(g.keyEvents.length, 50);
  assert.deepEqual(g.keyEvents.map(event => event.id), Array.from({ length: 50 }, (_, i) => i + 12));
  assert.ok(g.keyEvents.every(event => event.at === at));
  assert.equal(types(g).filter(type => type === 'ALLIANCE_INVITE').length, 25);
  assert.equal(types(g).filter(type => type === 'ALLIANCE_CANCEL').length, 25);
  assertEvents(g);
});
