import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../server.mjs';
import { createGame } from '../engine.mjs';

const quietRules = { captains: true, speed: false, trap: false, safe: false, lucky: false, ice: false, captureEffects: false };
const guard = state => ({ revision: state.revision, turn: state.game.turn, phase: state.game.phase });

async function fixture(t, options = {}) {
  const server = createServer(options);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const streams = [];
  t.after(async () => { for (const stream of streams) await stream.close(); await new Promise(resolve => server.close(resolve)); });
  async function raw(route, body) {
    const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  async function post(route, body, expected = 200) {
    const response = await raw(route, body); assert.equal(response.status, expected, JSON.stringify(response.data)); return response.data;
  }
  const create = () => post('/api/rooms', { name: '房主' }, 201);
  const join = (room, name = '玩家') => post(`/api/rooms/${room.roomId}/join`, { name });
  const action = (room, type, params = {}, expected = 200) => post(`/api/rooms/${room.roomId}/action`, { token: room.token, type, ...params }, expected);
  async function state(room) { const response = await fetch(`${base}/api/rooms/${room.roomId}?token=${room.token}`); assert.equal(response.status, 200); return response.json(); }
  async function events(room) {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/rooms/${room.roomId}/events?token=${room.token}`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(), decoder = new TextDecoder(), queue = [], waiters = [];
    let pending = '', ended = false;
    const task = (async () => {
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          pending += decoder.decode(chunk.value, { stream: true });
          let boundary;
          while ((boundary = pending.indexOf('\n\n')) >= 0) {
            const packet = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
            const type = /^event: (.+)$/m.exec(packet)?.[1], data = /^data: (.+)$/m.exec(packet)?.[1];
            if (!type || !data) continue;
            const event = { type, data: JSON.parse(data) }, waiter = waiters.shift();
            if (waiter) waiter(event); else queue.push(event);
          }
        }
      } catch (error) { if (error.name !== 'AbortError') throw error; }
      finally { ended = true; for (const resolve of waiters.splice(0)) resolve(null); }
    })();
    const stream = {
      async next() {
        if (queue.length) return queue.shift(); if (ended) return null;
        let timeout;
        return Promise.race([
          new Promise(resolve => waiters.push(resolve)),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('captain SSE timed out')), 2500); }),
        ]).finally(() => clearTimeout(timeout));
      },
      async revision(revision) {
        for (let i = 0; i < 35; i++) {
          const event = await this.next(); if (!event) throw new Error('SSE ended');
          if (event.type === 'state' && event.data.revision >= revision) return event.data;
        }
        throw new Error('SSE revision was not delivered');
      },
      async close() { controller.abort(); await task; },
    };
    streams.push(stream); return stream;
  }
  async function lobby(keys = ['flash', 'shield']) {
    const host = await create(); await action(host, 'capacity', { capacity: keys.length });
    const members = [host]; for (let i = 1; i < keys.length; i++) members.push(await join(host, `玩家${i}`));
    await action(host, 'mode', { mode: 'fun' }); await action(host, 'rules', { rules: quietRules });
    for (let seat = 0; seat < keys.length; seat++) await action(members[seat], 'captain', { captain: keys[seat] });
    return { host, members };
  }
  return { base, raw, post, create, join, action, state, events, lobby };
}

test('captain-server: lobby selection belongs to the seated player and is required before start', async t => {
  const f = await fixture(t), host = await f.create();
  await f.action(host, 'capacity', { capacity: 2 }); const guest = await f.join(host);
  await f.action(host, 'captain', { captain: 'flash' }, 409);
  await f.action(host, 'mode', { mode: 'fun' });
  const enabled = (await f.action(host, 'rules', { rules: { captains: true, items: false, alliances: false } })).state;
  assert.equal(enabled.rules.items, true); assert.equal(enabled.rules.alliances, true);
  await f.action(host, 'start', {}, 409);
  await f.action(host, 'captain', { captain: 'unknown' }, 400);
  await f.action(host, 'captain', { captain: 'flash', targetSeat: 1 });
  assert.equal((await f.state(guest)).players.find(player => player.seat === 1).captain, null);
  await f.action(host, 'start', {}, 409);
  await f.action(guest, 'captain', { captain: 'flash' });
  const lobbySpectator = await f.join(host, '候机观战'); await f.action(lobbySpectator, 'spectate');
  await f.action(lobbySpectator, 'captain', { captain: 'shield' }, 403);
  const started = (await f.action(host, 'start')).state;
  assert.deepEqual(started.game.captains.slice(0, 2).map(captain => captain.key), ['flash', 'flash']);
  const spectator = await f.join(host, '观战'); await f.action(spectator, 'captain', { captain: 'shield' }, 409);
  await f.action(guest, 'captain', { captain: 'shield' }, 409);
});

test('captain-server: strict phase guards, identity and invalid targets reject without mutation or deadline extension', async t => {
  const f = await fixture(t, { gameFactory(players, options) { const g = createGame(players, options); g.pieces[0][0] = 3; return g; } });
  const { host, members: [, guest] } = await f.lobby(['shield', 'flash']);
  const started = (await f.action(host, 'start')).state, spectator = await f.join(host, '观战');
  const current = await f.state(host);
  for (const params of [{ piece: 0 }, { ...guard(current), revision: current.revision - 1, piece: 0 }, { ...guard(current), phase: 'move', piece: 0 }, { ...guard(current), turn: 1, piece: 0 }, { ...guard(current), piece: 9 }]) {
    await f.action(host, 'use-skill', params, 409); assert.deepEqual(await f.state(host), current);
  }
  await f.action(guest, 'use-skill', { ...guard(current), piece: 0 }, 409);
  await f.action(spectator, 'use-skill', { ...guard(current), piece: 0 }, 403);
  assert.deepEqual(await f.state(host), current);
  assert.equal(current.game.deadline, started.game.deadline);
  const used = (await f.action(host, 'use-skill', { ...guard(current), piece: 0, used: false, steps: 99, to: 57, shields: [] })).state;
  assert.equal(used.game.captains[0].used, false); assert.equal(used.game.captains[0].uses, 1); assert.equal(used.game.shields[0][0], true);
  assert.equal(used.game.deadline, current.game.deadline); assert.equal(used.game.pieces[0][0], 3);
  await f.action(host, 'use-skill', { ...guard(used), piece: 0, used: false }, 409);
  await f.action(host, 'afk', { targetSeat: 0, afk: true });
  const afk = await f.state(host); await f.action(host, 'use-skill', { ...guard(afk), piece: 0 }, 409);
  assert.deepEqual(await f.state(host), afk);
});

test('captain-server: flash activation and its resolved move synchronize to players and spectators', async t => {
  const f = await fixture(t, { randomDice: () => 1, randomIndex: () => 0, gameFactory(players, options) { const g = createGame(players, options); g.pieces[0][0] = 3; return g; } });
  const { host, members: [, guest] } = await f.lobby(); await f.action(host, 'start'); const spectator = await f.join(host, '观战');
  const subscriptions = await Promise.all([host, guest, spectator].map(room => f.events(room)));
  const rolled = (await f.action(host, 'roll')).state;
  const armed = (await f.action(host, 'use-skill', guard(rolled))).state;
  assert.equal(armed.game.deadline, rolled.game.deadline); assert.equal(armed.game.captains[0].flashReady, true);
  for (const stream of subscriptions) assert.deepEqual((await stream.revision(armed.revision)).game, armed.game);
  const moved = (await f.action(host, 'move', { piece: 0, to: 57, steps: 50 })).state;
  assert.equal(moved.game.pieces[0][0], 7); assert.equal(moved.game.captains[0].flashReady, false);
  for (const stream of subscriptions) assert.deepEqual((await stream.revision(moved.revision)).game, moved.game);
  const reconnect = await f.events(guest); assert.deepEqual((await reconnect.next()).data.game, moved.game);
});

test('captain-server: flash raw six and seven actual steps synchronize while forged dice and steps are ignored', async t => {
  const f = await fixture(t, { randomDice: () => 6, randomIndex: () => 0, gameFactory(players, options) {
    const g = createGame(players, options); g.pieces[0][0] = 4; return g;
  } });
  const { host, members: [, guest] } = await f.lobby(); await f.action(host, 'start');
  const spectator = await f.join(host, '观战'), subscriptions = await Promise.all([host, guest, spectator].map(room => f.events(room)));
  const rolled = (await f.action(host, 'roll', { dice: 1, steps: 99, captain: 'shield', rollBonus: 99 })).state;
  assert.equal(rolled.game.dice, 6); assert.equal(rolled.game.steps, 7); assert.equal(rolled.game.captains[0].key, 'flash');
  assert.equal(rolled.game.captains[0].used, false);
  for (const stream of subscriptions) assert.deepEqual((await stream.revision(rolled.revision)).game, rolled.game);
  const moved = (await f.action(host, 'move', { piece: 0, dice: 1, steps: 99, to: 57, captain: 'gambler' })).state;
  assert.equal(moved.game.pieces[0][0], 11); assert.equal(moved.game.turn, 0); assert.equal(moved.game.sixes, 1);
  assert.equal(moved.game.captains[0].used, false);
  for (const stream of subscriptions) assert.deepEqual((await stream.revision(moved.revision)).game, moved.game);
  const repeated = (await f.action(host, 'roll')).state;
  assert.equal(repeated.game.dice, 6); assert.equal(repeated.game.steps, 7); assert.equal(repeated.game.sixes, 2);
});

test('captain-server: refresh, SSE reconnect and takeover retain a pending flash six and seven-step move', async t => {
  const f = await fixture(t, { randomDice: () => 6, randomIndex: () => 0, gameFactory(players, options) {
    const g = createGame(players, options); g.pieces[0][0] = 4; g.frozenPieces[0][0] = true; return g;
  } });
  const { host, members: [, guest] } = await f.lobby(); await f.action(host, 'start');
  const device = await f.join(host, '新设备'), oldStream = await f.events(host);
  const rolled = (await f.action(host, 'roll')).state;
  const armed = (await f.action(host, 'use-skill', guard(rolled))).state;
  assert.equal(armed.game.dice, 6); assert.equal(armed.game.steps, 7); assert.ok(armed.game.legal.includes(0));
  assert.equal(armed.game.frozenPieces[0][0], true); assert.equal(armed.game.captains[0].flashReady, true);
  assert.deepEqual((await f.state(host)).game, armed.game);
  await oldStream.close(); const reconnect = await f.events(host);
  assert.deepEqual((await reconnect.next()).data.game, armed.game);
  const takeover = (await f.action(device, 'takeover', { code: armed.you.takeoverCode })).state;
  assert.equal(takeover.you.seat, 0); assert.deepEqual(takeover.game, armed.game);
  assert.deepEqual((await f.state(device)).game, armed.game);
  const newStream = await f.events(device); assert.deepEqual((await newStream.next()).data.game, armed.game);
  await f.action(host, 'move', { piece: 0, dice: 6, steps: 7 }, 403);
  assert.deepEqual((await f.state(device)).game, armed.game);
  const moved = (await f.action(device, 'move', { piece: 0, dice: 1, steps: 1, to: 57 })).state;
  assert.equal(moved.game.pieces[0][0], 14); assert.equal(moved.game.frozenPieces[0][0], false);
  assert.equal(moved.game.turn, 0); assert.equal(moved.game.captains[0].flashReady, false);
  assert.equal(moved.game.captains[0].used, false); assert.equal(moved.game.captains[0].uses, 2);
  assert.deepEqual((await newStream.revision(moved.revision)).game, moved.game);
  assert.deepEqual((await f.state(guest)).game, moved.game);
});

test('captain-server: theft broadcasts counts while only owner and victim receive their changed private hands', async t => {
  const f = await fixture(t, { randomDice: () => 2, randomIndex: () => 0, gameFactory(players, options) {
    const g = createGame(players, options); g.pieces[0][0] = 20; g.pieces[1] = [9, 13, -1, -1];
    g.hands[0] = ['mine']; g.hands[1] = ['stun', 'missile']; return g;
  } });
  const { host, members: [, guest] } = await f.lobby(['betrayer', 'shield']); await f.action(host, 'start'); const spectator = await f.join(host, '观战');
  const subscriptions = await Promise.all([host, guest, spectator].map(room => f.events(room)));
  await f.action(host, 'roll'); const moved = (await f.action(host, 'move', { piece: 0 })).state;
  const views = await Promise.all(subscriptions.map(stream => stream.revision(moved.revision)));
  assert.deepEqual(views[0].you.hand, ['mine', 'stun']); assert.deepEqual(views[1].you.hand, ['missile']); assert.deepEqual(views[2].you.hand, []);
  assert.deepEqual(moved.game.handCounts.slice(0, 2), [2, 1]); assert.equal(Object.hasOwn(moved.game, 'hands'), false);
  for (const view of views) { assert.deepEqual(view.game, moved.game); assert.equal(Object.hasOwn(view.game, 'hands'), false); }
  const theft = moved.game.keyEvents.filter(event => event.type === 'ITEM_STOLEN');
  assert.equal(theft.length, 1); assert.doesNotMatch(JSON.stringify(theft), /stun|mine|missile|定身|地雷|导弹/);
  assert.deepEqual((await f.state(guest)).you.hand, ['missile']);
});

test('captain-server: refresh, real SSE reconnect and role takeover preserve seat skills and private resources', async t => {
  const f = await fixture(t, { gameFactory(players, options) {
    const g = createGame(players, options); g.pieces[0] = [4, -1, 6, -1]; g.reserveSteps[0][1] = true;
    g.frozenPieces[0][2] = true; g.hands[0] = ['stun']; return g;
  } });
  const { host, members: [, guest] } = await f.lobby(['shield', 'avenger']); await f.action(host, 'start');
  const device = await f.join(host, '新设备'), oldStream = await f.events(host);
  const before = await f.state(host); const protectedState = (await f.action(host, 'use-skill', { ...guard(before), piece: 0 })).state;
  assert.deepEqual((await f.state(host)).game, protectedState.game);
  await oldStream.close(); const reconnected = await f.events(host);
  assert.deepEqual((await reconnected.next()).data.game, protectedState.game);
  const takeover = (await f.action(device, 'takeover', { code: protectedState.you.takeoverCode })).state;
  assert.equal(takeover.you.seat, 0); assert.equal(takeover.you.host, true); assert.deepEqual(takeover.you.hand, ['stun']);
  assert.deepEqual(takeover.game, protectedState.game);
  assert.equal(takeover.game.captains[0].used, false); assert.equal(takeover.game.captains[0].uses, 1);
  assert.equal(takeover.game.shields[0][0], true); assert.equal(takeover.game.reserveSteps[0][1], true);
  assert.equal(takeover.game.frozenPieces[0][2], true);
  await f.action(host, 'use-skill', { ...guard(takeover), piece: 2 }, 403);
  assert.equal(Object.hasOwn((await f.state(guest)).game, 'hands'), false);
  assert.deepEqual((await f.state(device)).game, protectedState.game);
});

test('captain-server: reroll uses server randomness, final six rights and the original one-card-per-round limit', async t => {
  const dice = [6, 2];
  const f = await fixture(t, { randomDice: () => dice.shift() ?? 2, randomIndex: () => 5, gameFactory(players, options) {
    const g = createGame(players, options); g.pieces[0][0] = 3; g.pieces[1][0] = 44; return g;
  } });
  const { host, members: [, guest] } = await f.lobby(['gambler', 'flash']); await f.action(host, 'start');
  const hs = await f.events(host), gs = await f.events(guest);
  await f.action(host, 'use-item', { card: 'mine', piece: 0 }); const rolled = (await f.action(host, 'roll')).state;
  assert.equal(rolled.game.dice, 6);
  const rerolled = (await f.action(host, 'use-skill', { ...guard(rolled), dice: 6, steps: 100, used: false })).state;
  assert.equal(rerolled.game.dice, 2); assert.equal(rerolled.game.steps, 2); assert.equal(rerolled.game.rollCount, 2);
  assert.equal(rerolled.game.sixes, 0); assert.equal(rerolled.game.itemUsed[0], true); assert.equal(rerolled.game.deadline, rolled.game.deadline);
  for (const stream of [hs, gs]) assert.deepEqual((await stream.revision(rerolled.revision)).game, rerolled.game);
  await f.action(host, 'use-skill', { ...guard(rerolled), used: false }, 409);
  assert.deepEqual(await f.state(host), rerolled);
  const moved = (await f.action(host, 'move', { piece: 0 })).state; assert.equal(moved.game.turn, 1);
  assert.equal(moved.game.pieces[0][0], 5);
  assert.equal(moved.game.captains[0].used, false); assert.equal(moved.game.captains[0].uses, 1);
  assert.deepEqual((await gs.revision(moved.revision)).game, moved.game);
});

test('captain-server: unplayable gambler rolls can be accepted and timeout fallback cannot strand the game', async t => {
  for (const automatic of [false, true]) {
    const f = await fixture(t, { randomDice: () => 3, turnMs: automatic ? 180 : 90_000 });
    const { host, members: [, guest] } = await f.lobby(['gambler', 'flash']); await f.action(host, 'start');
    const gs = await f.events(guest); const rolled = (await f.action(host, 'roll')).state;
    assert.equal(rolled.game.phase, 'move'); assert.deepEqual(rolled.game.legal, []);
    let advanced;
    if (automatic) {
      for (let i = 0; i < 20; i++) { const event = await gs.next(); if (event.type === 'state' && event.data.game.turn === 1) { advanced = event.data; break; } }
      assert.ok(advanced, 'real turn timeout must accept an unplayable gambler roll');
      assert.ok(advanced.game.keyEvents.some(event => event.type === 'AUTO_TURN'));
    } else {
      advanced = (await f.action(host, 'accept-roll', guard(rolled))).state;
      assert.equal(advanced.game.turn, 1); assert.deepEqual((await gs.revision(advanced.revision)).game, advanced.game);
      await f.action(host, 'accept-roll', guard(rolled), 409);
      assert.deepEqual(await f.state(host), advanced);
    }
    assert.equal(advanced.game.rollCount, 1); assert.equal(advanced.game.captains[0].used, false);
    assert.deepEqual(advanced.game.pieces[0], [-1, -1, -1, -1]);
  }
});

test('captain-server: simultaneous guarded skill requests apply once and do not extend the phase deadline', async t => {
  const f = await fixture(t, { gameFactory(players, options) { const g = createGame(players, options); g.pieces[0][0] = 3; return g; } });
  const { host } = await f.lobby(['shield', 'flash']); const started = (await f.action(host, 'start')).state;
  const body = { token: host.token, type: 'use-skill', ...guard(started), piece: 0 };
  const responses = await Promise.all([f.raw(`/api/rooms/${host.roomId}/action`, body), f.raw(`/api/rooms/${host.roomId}/action`, body)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const final = await f.state(host); assert.equal(final.revision, started.revision + 1);
  assert.equal(final.game.captains[0].used, false); assert.equal(final.game.captains[0].uses, 1);
  assert.equal(final.game.shields[0][0], true);
  assert.equal(final.game.keyEvents.filter(event => event.type === 'SHIELD_SET').length, 1);
  assert.equal(final.game.deadline, started.game.deadline);
});
