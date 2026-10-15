import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, rollDice, movePiece, allianceAction, useItem, useSkill } from '../engine.mjs';
import { STARTS } from '../board.mjs';

const GREEN = 0;
const RED = 1;
const randomIndex = () => 0;
const quietRules = { captains: true, speed: false, trap: false, safe: false, lucky: false, ice: false };
const game = () => createGame([0, 1, 2, 3].map(seat => ({ seat, captain: 'shield' })), { mode: 'fun', rules: quietRules });
const stats = (g, seat) => g.players.find(player => player.seat === seat).stats;

function atRedProgress(g, seat, progress, count = 1) {
  const physical = (STARTS[RED] + progress) % 52;
  const ownProgress = (physical - STARTS[seat] + 52) % 52;
  assert.ok(ownProgress <= 50, 'fixture must use a public outer-ring cell');
  for (let piece = 0; piece < count; piece++) g.pieces[seat][piece] = ownProgress;
  return ownProgress;
}

function moveRed(g, from, dice) {
  g.turn = RED;
  g.phase = 'roll';
  g.pieces[RED][0] = from;
  rollDice(g, RED, dice, randomIndex);
  movePiece(g, RED, 0, randomIndex);
}

function allyRedGreen(g) {
  allianceAction(g, RED, 'alliance-invite', GREEN);
  allianceAction(g, GREEN, 'alliance-accept', RED);
}

function plantGreenMine(g, redProgress) {
  const progress = atRedProgress(g, GREEN, redProgress);
  g.turn = GREEN;
  useItem(g, GREEN, { card: 'mine', piece: 0 }, randomIndex);
  g.pieces[GREEN][0] = (progress + 1) % 51;
  return (STARTS[RED] + redProgress) % 52;
}

test('combat regression: enabling captain-linked alliances alone does not protect a red-green collision', () => {
  const g = game();
  assert.equal(g.rules.alliances, true);
  assert.equal(g.allies[RED], null);
  atRedProgress(g, GREEN, 5);
  moveRed(g, 4, 1);
  assert.equal(g.pieces[RED][0], 5);
  assert.equal(g.pieces[GREEN][0], -1);
  assert.equal(stats(g, RED).green, 1);
  assert.equal(g.lastMove.captured[0].seat, GREEN);
});

test('combat regression: accepted red-green allies coexist and betrayal immediately enables collision', () => {
  const g = game();
  allyRedGreen(g);
  const greenProgress = atRedProgress(g, GREEN, 5);
  moveRed(g, 4, 1);
  assert.equal(g.pieces[GREEN][0], greenProgress);
  assert.equal(g.pieces[RED][0], 5);
  assert.equal(stats(g, RED).green, 0);
  allianceAction(g, RED, 'alliance-betray');
  assert.equal(g.diceDouble[RED], true);
  assert.equal(g.bountyRounds[RED], 3);
  assert.equal(g.betrayedBy[GREEN], RED);
  g.diceDouble[RED] = false;
  g.pieces[RED][0] = 4;
  g.turn = RED; g.phase = 'roll';
  rollDice(g, RED, 1, randomIndex);
  movePiece(g, RED, 0, randomIndex);
  assert.equal(g.pieces[GREEN][0], -1);
  assert.equal(stats(g, RED).green, 1);
  assert.equal(g.pieces[RED][0], 5);
});

test('combat regression: a red exact landing breaks a green wall with captain-linked rules enabled', () => {
  const g = game();
  atRedProgress(g, GREEN, 5, 2);
  moveRed(g, 2, 3);
  assert.equal(g.pieces[RED][0], -1);
  assert.deepEqual(g.pieces[GREEN].slice(0, 2), [-1, -1]);
  assert.equal(stats(g, RED).green, 2);
  assert.equal(stats(g, RED).red, 1);
  assert.equal(g.lastMove.events.find(event => event.type === 'WALL_BREAK').at, 5);
});

test('combat regression: a red move beyond a green wall bounces even when alliances are available', () => {
  const g = game();
  const greenProgress = atRedProgress(g, GREEN, 5, 2);
  moveRed(g, 2, 4);
  assert.equal(g.pieces[RED][0], 3);
  assert.deepEqual(g.lastMove.path, [4, 3]);
  assert.deepEqual(g.pieces[GREEN].slice(0, 2), [greenProgress, greenProgress]);
  assert.equal(g.lastMove.events[0].type, 'WALL_BOUNCE');
  assert.equal(stats(g, RED).green, 0);
  assert.equal(stats(g, RED).red, 0);
});

test('combat regression: allied green walls allow red landings and crossings, then betrayal restores the wall', () => {
  for (const dice of [3, 4]) {
    const g = game();
    allyRedGreen(g);
    const greenProgress = atRedProgress(g, GREEN, 5, 2);
    const reference = game();
    moveRed(reference, 2, dice);
    moveRed(g, 2, dice);
    assert.equal(g.pieces[RED][0], reference.pieces[RED][0]);
    assert.deepEqual(g.pieces[GREEN].slice(0, 2), [greenProgress, greenProgress]);
    assert.equal(g.lastMove.events.some(event => event.type.startsWith('WALL_')), false);
    allianceAction(g, RED, 'alliance-betray');
    g.diceDouble[RED] = false;
    moveRed(g, 2, dice);
    assert.equal(g.lastMove.events[0].type, dice === 3 ? 'WALL_BREAK' : 'WALL_BOUNCE');
  }
});

test('combat regression: a real green mine on a red same-colour jump launch detonates before jumping', () => {
  const g = game();
  plantGreenMine(g, 6);
  moveRed(g, 5, 1);
  assert.equal(g.pieces[RED][0], -1);
  assert.deepEqual(g.lastMove.path, [6]);
  assert.equal(g.lastMove.events[0].type, 'MINE_HIT');
  assert.equal(g.lastMove.returnReason, 'mine');
  assert.equal(g.mines.length, 0);
  assert.equal(stats(g, GREEN).red, 1);
});

test('combat regression: a real green mine on the red flight launch detonates before flight', () => {
  const g = game();
  plantGreenMine(g, 18);
  moveRed(g, 17, 1);
  assert.equal(g.pieces[RED][0], -1);
  assert.deepEqual(g.lastMove.path, [18]);
  assert.equal(g.lastMove.events[0].type, 'MINE_HIT');
  assert.equal(g.mines.length, 0);
  assert.equal(stats(g, GREEN).red, 1);
});

test('combat regression: a real allied mine permits a red jump and becomes hostile immediately after betrayal', () => {
  const g = game();
  allyRedGreen(g);
  const index = plantGreenMine(g, 6);
  moveRed(g, 5, 1);
  assert.equal(g.pieces[RED][0], 10);
  assert.equal(g.mines[0].index, index);
  assert.equal(stats(g, GREEN).red, 0);
  allianceAction(g, RED, 'alliance-betray');
  assert.equal(g.diceDouble[RED], true);
  g.diceDouble[RED] = false;
  moveRed(g, 5, 1);
  assert.equal(g.pieces[RED][0], -1);
  assert.equal(g.mines.length, 0);
  assert.equal(stats(g, GREEN).red, 1);
});

test('combat regression: a shield consumes an enemy jump-cell mine and lets the surviving red plane jump', () => {
  const g = game();
  plantGreenMine(g, 6);
  g.turn = RED;
  g.pieces[RED][0] = 5;
  useSkill(g, RED, { piece: 0 }, randomIndex);
  moveRed(g, 5, 1);
  assert.equal(g.pieces[RED][0], 10);
  assert.equal(g.shields[RED][0], false);
  assert.equal(g.mines.length, 0);
  assert.deepEqual(g.lastMove.path, [6, 10]);
  assert.equal(g.lastMove.events[0].type, 'SHIELD_BLOCK');
  assert.equal(g.lastMove.selfReturned, false);
  assert.equal(stats(g, GREEN).red, 0);
});

test('combat regression: an exact green-wall break ignores the red shield but respects each enemy shield', () => {
  const g = game();
  const greenProgress = atRedProgress(g, GREEN, 5, 2);
  useSkill(g, GREEN, { piece: 0 }, randomIndex);
  g.turn = RED;
  g.pieces[RED][0] = 2;
  useSkill(g, RED, { piece: 0 }, randomIndex);
  moveRed(g, 2, 3);
  assert.equal(g.pieces[RED][0], -1);
  assert.deepEqual(g.pieces[GREEN].slice(0, 2), [greenProgress, -1]);
  assert.equal(g.shields[RED][0], false);
  assert.equal(g.shields[GREEN][0], false);
  assert.equal(stats(g, RED).green, 1);
  assert.equal(stats(g, RED).red, 1);
  assert.deepEqual(g.lastMove.events.map(event => event.type), ['SHIELD_BLOCK', 'WALL_BREAK']);
});

test('combat regression: a red jump crosses a green wall and mine but still breaks a wall on its landing', () => {
  const g = game();
  const greenWall = atRedProgress(g, GREEN, 8, 2);
  g.pieces[GREEN][2] = STARTS[RED] + 9;
  useItem(g, GREEN, { card: 'mine', piece: 2 }, randomIndex);
  g.pieces[GREEN][2] = 25;
  moveRed(g, 5, 1);
  assert.equal(g.pieces[RED][0], 10);
  assert.deepEqual(g.pieces[GREEN].slice(0, 2), [greenWall, greenWall]);
  assert.equal(g.mines.length, 1, 'airborne intermediate cells do not trigger mines');
  atRedProgress(g, GREEN, 10, 2);
  moveRed(g, 5, 1);
  assert.equal(g.pieces[RED][0], -1);
  assert.deepEqual(g.pieces[GREEN].slice(0, 2), [-1, -1]);
  assert.equal(g.lastMove.events[0].type, 'WALL_BREAK');
  assert.equal(g.lastMove.events[0].at, 10);
  assert.equal(g.mines.length, 1);
});

test('combat regression: the final red jump landing also checks an enemy mine', () => {
  const g = game();
  plantGreenMine(g, 10);
  moveRed(g, 5, 1);
  assert.equal(g.pieces[RED][0], -1);
  assert.deepEqual(g.lastMove.path, [6, 10]);
  assert.equal(g.lastMove.events[0].type, 'MINE_HIT');
  assert.equal(g.lastMove.events[0].at, 10);
  assert.equal(stats(g, GREEN).red, 1);
});
