import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createServer } from '../server.mjs';
import { createGame } from '../engine.mjs';
import { TAKEOFF, FINISH, COLORS, specialCellAt, DEFAULT_FUN_RULES } from '../board.mjs';

async function fixture(t, options = {}) {
  const server = createServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const subscriptions = [];
  t.after(async () => {
    for (const stream of subscriptions) await stream.close();
    await new Promise(resolve => server.close(resolve));
  });
  async function post(route, body, expected = 200, headers = {}) {
    const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value;
  }
  async function create(name = '机长') { return post('/api/rooms', { name }, 201); }
  async function join(room, name = '乘客') { return post(`/api/rooms/${room.roomId}/join`, { name }); }
  async function action(room, type, more = {}, expected = 200) { return post(`/api/rooms/${room.roomId}/action`, { token: room.token, type, ...more }, expected); }
  async function state(room, expected = 200) {
    const response = await fetch(`${base}/api/rooms/${room.roomId}?token=${room.token}`);
    assert.equal(response.status, expected);
    return response.json();
  }
  async function events(room) {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/rooms/${room.roomId}/events?token=${room.token}`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    const queue = [];
    const waiters = [];
    let ended = false;
    const task = (async () => {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          pending += decoder.decode(chunk.value, { stream: true });
          let boundary;
          while ((boundary = pending.indexOf('\n\n')) >= 0) {
            const packet = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            const type = /^event: (.+)$/m.exec(packet)?.[1];
            const raw = /^data: (.+)$/m.exec(packet)?.[1];
            if (type && raw) {
              const event = { type, data: JSON.parse(raw) };
              const waiter = waiters.shift();
              if (waiter) waiter(event); else queue.push(event);
            }
          }
        }
      } catch (error) { if (error.name !== 'AbortError') throw error; }
      finally { ended = true; for (const resolve of waiters.splice(0)) resolve(null); }
    })();
    const stream = {
      async next() {
        if (queue.length) return queue.shift();
        if (ended) return null;
        let timer;
        const event = await Promise.race([
          new Promise(resolve => waiters.push(resolve)),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SSE event timed out')), 2500); }),
        ]).finally(() => clearTimeout(timer));
        return event;
      },
      async revision(revision) {
        for (let i = 0; i < 20; i++) {
          const event = await this.next();
          if (event?.type === 'state' && event.data.revision >= revision) return event.data;
          if (!event) throw new Error('SSE stream ended unexpectedly');
        }
        throw new Error('SSE revision not observed');
      },
      async close() { controller.abort(); await task; },
    };
    subscriptions.push(stream);
    return stream;
  }
  return { base, post, create, join, action, state, events };
}

function assertHostCodes(state, expected) {
  assert.equal(state.you.host, true);
  assert.deepEqual(state.you.takeoverCodes, expected.map(([player, code]) => ({ id: player.state.you.id, code })));
  const shared = JSON.stringify({ players: state.players, game: state.game });
  for (const [player, code] of expected) {
    assert.equal(shared.includes(player.token), false, 'tokens stay out of shared state');
    if (code !== null) assert.equal(shared.includes(code), false, 'role codes stay out of shared state');
  }
}

function assertNoHostCodes(state) {
  assert.equal(Object.hasOwn(state.you, 'takeoverCodes'), false, 'only the current host receives all role codes');
}

test('two clients share authoritative moves, reconnect and host transfer', async t => {
  const f = await fixture(t, { randomDice: () => 6 });
  const host = await f.create('房主');
  const guest = await f.join(host, '朋友');
  const hs = await f.events(host);
  const gs = await f.events(guest);
  assert.equal((await hs.next()).data.you.host, true);
  assert.equal((await gs.next()).data.you.seat, 1);
  await f.action(guest, 'start', {}, 403);
  await f.action(guest, 'capacity', { capacity: 2 }, 403);
  await f.action(host, 'capacity', { capacity: 2 });
  const started = (await f.action(host, 'start')).state;
  assert.deepEqual(started.game.active, [0, 1]);
  assert.equal(started.game.turn, 0);
  assert.ok(started.game.deadline > Date.now());
  await f.action(guest, 'roll', {}, 409);
  const rolled = (await f.action(host, 'roll')).state;
  assert.equal(rolled.game.dice, 6);
  assert.deepEqual(rolled.game.legal, [0, 1, 2, 3]);
  await f.action(guest, 'move', { piece: 0 }, 409);
  const moved = (await f.action(host, 'move', { piece: 0 })).state;
  assert.equal(moved.game.pieces[0][0], TAKEOFF);
  const hstate = await hs.revision(moved.revision);
  const gstate = await gs.revision(moved.revision);
  assert.equal(hstate.revision, gstate.revision);
  assert.deepEqual(hstate.game, gstate.game);
  assert.equal(hstate.you.id, host.state.you.id);
  assert.equal(gstate.you.id, guest.state.you.id);
  assert.equal(JSON.stringify(hstate).includes(host.token), false);
  assert.equal(JSON.stringify(gstate).includes(guest.token), false);

  await gs.close();
  const offline = await hs.revision(moved.revision + 1);
  assert.equal(offline.players.find(p => p.id === guest.state.you.id).online, false);
  assert.equal(offline.players.find(p => p.id === guest.state.you.id).seat, 1);
  const reconnected = await f.events(guest);
  const resumed = (await reconnected.next()).data;
  assert.equal(resumed.you.id, guest.state.you.id);
  assert.equal(resumed.players.find(p => p.id === resumed.you.id).online, true);
  assert.deepEqual(resumed.game.pieces, moved.game.pieces);
  await hs.close();
  const hostOffline = await reconnected.revision(resumed.revision + 1);
  assert.equal(hostOffline.hostId, host.state.you.id, 'short reconnect keeps ownership');
  const refreshedHost = await f.events(host);
  assert.equal((await refreshedHost.next()).data.you.host, true);
  await f.action(guest, 'seat', { seat: 2 }, 409);
  await f.action(host, 'leave');
  const handedOver = await f.state(guest);
  assert.equal(handedOver.hostId, guest.state.you.id);
  assert.equal(handedOver.you.host, true);
  assertHostCodes(handedOver, [[host, host.state.you.takeoverCode], [guest, guest.state.you.takeoverCode]]);
  assert.equal(handedOver.players.find(p => p.id === host.state.you.id).seat, 0);
  const formerHost = await f.state(host);
  assertNoHostCodes(formerHost);
  assert.equal(JSON.stringify(formerHost).includes(guest.state.you.takeoverCode), false);
  await f.action(guest, 'end');
  assert.equal((await f.state(guest)).game, null);
});

test('2 and 4 launch through the API, synchronize both clients and then change turns', async t => {
  const dice = [2,4];
  let index = 0;
  const f = await fixture(t,{randomDice:()=>dice[index++]});
  const host = await f.create('甲');
  const guest = await f.join(host,'乙');
  const hs = await f.events(host);
  const gs = await f.events(guest);
  await f.action(host,'capacity',{capacity:2});
  await f.action(host,'start');
  for (const [seat,player,value] of [[0,host,2],[1,guest,4]]) {
    const rolled = (await f.action(player,'roll')).state;
    assert.equal(rolled.game.dice,value);
    assert.deepEqual(rolled.game.legal,[0,1,2,3]);
    const moved = (await f.action(player,'move',{piece:0})).state;
    assert.equal(moved.game.pieces[seat][0],TAKEOFF);
    assert.equal(moved.game.turn,1-seat);
    assert.equal(moved.game.phase,'roll');
    assert.deepEqual((await hs.revision(moved.revision)).game,(await gs.revision(moved.revision)).game);
  }
});

test('lobby supports spectator host, arbitrary colors and conflicts', async t => {
  const f = await fixture(t);
  const host = await f.create();
  const guest = await f.join(host);
  await f.action(host, 'capacity', { capacity: 2 });
  await f.action(guest, 'seat', { seat: 0 }, 409);
  const watching = (await f.action(host, 'spectate')).state;
  assert.equal(watching.you.seat, null);
  assert.equal(watching.you.host, true);
  await f.action(guest, 'seat', { seat: 3 });
  const third = await f.join(host, '另一位');
  assert.equal(third.state.you.seat, 0);
  const started = (await f.action(host, 'start')).state;
  assert.deepEqual(started.game.active, [0, 3]);
  await f.action(host, 'roll', {}, 403);
  const newcomer = await f.join(host, '观战者');
  assert.equal(newcomer.state.you.seat, null);
  await f.action(newcomer, 'end', {}, 403);
  await f.action(host, 'end');
  await f.action(guest, 'leave');
  assert.equal((await f.state(host)).players.some(p => p.id === guest.state.you.id), false);
});

test('only the lobby host can kick members, revoke every connection and release a seat', async t => {
  const f = await fixture(t);
  const host = await f.create('房主');
  const guest = await f.join(host, '待移除玩家');
  const spectator = await f.join(host, '待移除观战者');
  await f.action(spectator, 'spectate');
  const hs = await f.events(host);
  const gs = await f.events(guest);
  const secondGuestSession = await f.events(guest);
  const ss = await f.events(spectator);
  for (const stream of [hs, gs, secondGuestSession, ss]) await stream.next();
  const before = await f.state(host);

  await f.action(guest, 'kick', { playerId: host.state.you.id }, 403);
  await f.action(spectator, 'kick', { playerId: guest.state.you.id }, 403);
  for (const playerId of [undefined, null, {}, 'invalid-id']) {
    await f.action(host, 'kick', { playerId }, 400);
  }
  await f.action(host, 'kick', { playerId: '00000000-0000-4000-8000-000000000000' }, 404);
  await f.action(host, 'kick', { playerId: host.state.you.id }, 400);
  assert.deepEqual(await f.state(host), before, 'rejected kicks do not change the room');

  const kicked = (await f.action(host, 'kick', { playerId: guest.state.you.id })).state;
  assert.equal(kicked.players.some(p => p.id === guest.state.you.id), false);
  assertHostCodes(kicked, [[host, host.state.you.takeoverCode], [spectator, null]]);
  assert.deepEqual((await hs.revision(kicked.revision)).players, kicked.players);
  for (const stream of [gs, secondGuestSession]) {
    assert.equal((await stream.next()).type, 'gone');
    assert.equal(await stream.next(), null, 'all kicked sessions end');
  }
  await f.state(guest, 401);
  assert.equal((await fetch(`${f.base}/api/rooms/${host.roomId}/events?token=${guest.token}`)).status, 401);
  await f.action(guest, 'seat', { seat: 1 }, 401);

  const replacement = await f.join(host, '重新加入');
  assert.equal(replacement.state.you.seat, guest.state.you.seat, 'the same IP can rejoin and use the released seat');
  assert.notEqual(replacement.state.you.id, guest.state.you.id);
  assert.notEqual(replacement.token, guest.token);
  assert.notEqual(replacement.state.you.takeoverCode, guest.state.you.takeoverCode);
  await ss.revision(replacement.state.revision);

  const spectatorKicked = (await f.action(host, 'kick', { playerId: spectator.state.you.id })).state;
  assert.equal(spectatorKicked.players.some(p => p.id === spectator.state.you.id), false);
  assertHostCodes(spectatorKicked, [[host, host.state.you.takeoverCode], [replacement, replacement.state.you.takeoverCode]]);
  assert.equal((await ss.next()).type, 'gone');
  assert.equal(await ss.next(), null);
  await f.state(spectator, 401);
});

test('hosts can kick offline lobby members but cannot kick players or spectators during a game', async t => {
  const f = await fixture(t);
  const host = await f.create('房主');
  const offlinePlayer = await f.join(host, '离线玩家');
  const hs = await f.events(host);
  const offlineStream = await f.events(offlinePlayer);
  await hs.next();
  const connected = (await offlineStream.next()).data;
  await offlineStream.close();
  const offline = await hs.revision(connected.revision + 1);
  assert.equal(offline.players.find(p => p.id === offlinePlayer.state.you.id).online, false);
  const removed = (await f.action(host, 'kick', { playerId: offlinePlayer.state.you.id })).state;
  assert.equal(removed.players.length, 1);
  assertHostCodes(removed, [[host, host.state.you.takeoverCode]]);
  await f.state(offlinePlayer, 401);

  const guest = await f.join(host, '玩家');
  const spectator = await f.join(host, '观战者');
  await f.action(spectator, 'spectate');
  await f.events(guest);
  await f.events(spectator);
  await f.action(host, 'capacity', { capacity: 2 });
  const started = (await f.action(host, 'start')).state;
  await f.action(host, 'kick', { playerId: guest.state.you.id }, 409);
  await f.action(host, 'kick', { playerId: spectator.state.you.id }, 409);
  await f.action(guest, 'kick', { playerId: host.state.you.id }, 403);
  await f.action(spectator, 'kick', { playerId: guest.state.you.id }, 403);
  assert.deepEqual(await f.state(host), started, 'rejected in-game kicks preserve the roster and game');
  await f.action(host, 'end');
  const afterEnd = (await f.action(host, 'kick', { playerId: guest.state.you.id })).state;
  assert.equal(afterEnd.players.some(p => p.id === guest.state.you.id), false, 'ending the game restores lobby moderation');
});

test('timeout advances an offline turn', async t => {
  const f = await fixture(t, { turnMs: 35, randomDice: () => 1 });
  const host = await f.create();
  const guest = await f.join(host);
  const stream = await f.events(host);
  await stream.next();
  await f.action(host, 'capacity', { capacity: 2 });
  const started = (await f.action(host, 'start')).state;
  let automatic = await stream.revision(started.revision + 1);
  assert.equal(automatic.game.turn, 1);
  assert.equal(automatic.game.phase, 'roll');
  assert.match(automatic.game.log.map(l => l.text).join(' '), /操作超时/);
  await f.action(guest, 'leave');
  const left = await f.state(host);
  automatic = await stream.revision(left.revision + 1);
  assert.equal(automatic.game.turn, 0);
  assert.equal(automatic.players.find(p => p.id === guest.state.you.id).online, false);
});

test('credentials, origin protection, body limits and static isolation', async t => {
  const f = await fixture(t);
  const host = await f.create('\u0000  <b>小飞侠</b>\u202e  ');
  assert.equal(host.state.players[0].name, '<b>小飞侠</b>');
  await f.post(`/api/rooms/${host.roomId}/action`, { token: 'fake', type: 'start' }, 401);
  await f.post(`/api/rooms/${host.roomId}/action`, { token: host.token, type: 'capacity', capacity: 2 }, 403, { Origin: 'https://attacker.invalid' });
  await f.post(`/api/rooms/${host.roomId}/action`, { token: host.token, type: 'capacity', capacity: 2 }, 200, { Origin: f.base });
  await f.post('/api/rooms', { name: 'x'.repeat(9000) }, 413);
  const health = await fetch(f.base + '/health');
  assert.deepEqual(await health.json(), { ok: true, rooms: 1 });
  assert.equal(health.headers.get('cache-control'), 'no-store');
  const head = await fetch(f.base + '/health', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  for (const route of ['/server.mjs', '/engine.mjs', '/.git/config', '/%2e%2e%5cserver.mjs']) {
    assert.equal((await fetch(f.base + route)).status, 404, route);
  }
});

test('one player cannot keep unlimited SSE sessions', async t => {
  const f = await fixture(t);
  const host = await f.create();
  await f.events(host);
  await f.events(host);
  const rejected = await fetch(`${f.base}/api/rooms/${host.roomId}/events?token=${host.token}`);
  assert.equal(rejected.status, 429);
});

test('untrusted real-IP headers cannot bypass creation limits', async t => {
  const f = await fixture(t);
  for (let i = 1; i <= 12; i++) {
    await f.post('/api/rooms', { name: '玩家' }, 201, { 'X-Real-IP': `192.0.2.${i}` });
  }
  await f.post('/api/rooms', { name: '玩家' }, 429, { 'X-Real-IP': '192.0.2.13' });
});

test('trusted loopback proxy separates IP limits and rejects invalid real-IP headers', async t => {
  const f = await fixture(t, { trustLoopbackProxy: true });
  const headers = { 'X-Real-IP': '192.0.2.1' };
  for (let i = 0; i < 12; i++) await f.post('/api/rooms', { name: '玩家' }, 201, headers);
  await f.post('/api/rooms', { name: '玩家' }, 429, headers);
  await f.post('/api/rooms', { name: '玩家' }, 201, { 'X-Real-IP': '192.0.2.2' });
  await f.post('/api/rooms', { name: '玩家' }, 201, { 'X-Real-IP': '2001:db8::1' });
  const invalidIps = ['unknown', '192.0.2.3, 192.0.2.4', '192.0.2.3:8080', '999.0.0.1'];
  for (let i = 0; i < 12; i++) {
    await f.post('/api/rooms', { name: '玩家' }, 201, { 'X-Real-IP': invalidIps[i % invalidIps.length] });
  }
  await f.post('/api/rooms', { name: '玩家' }, 429);
  await f.post('/api/rooms', { name: '玩家' }, 429, { 'X-Real-IP': '192.0.2.3, 192.0.2.4' });
});

test('HTTPS origins match the preserved Host and cannot use forwarded hosts', async t => {
  const f = await fixture(t, { trustLoopbackProxy: true });
  async function post(headers, expected) {
    const body = JSON.stringify({ name: '玩家' });
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(f.base + '/api/rooms', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers }
      }, resolve);
      request.on('error', reject);
      request.end(body);
    });
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    assert.equal(response.statusCode, expected, Buffer.concat(chunks).toString());
  }
  await post({ Host: 'jbba.top', Origin: 'https://jbba.top' }, 201);
  await post({
    Host: 'jbba.top', Origin: 'https://turn.jbba.top', 'X-Forwarded-Host': 'turn.jbba.top'
  }, 403);
  await post({ Host: 'jbba.top:8445', Origin: 'https://jbba.top:8445' }, 201);
  await post({ Host: 'jbba.top:8445', Origin: 'https://jbba.top' }, 403);
});

test('three and four seats start and rotate independently', async t => {
  const f = await fixture(t, { randomDice: () => 1 });
  const host = await f.create('蓝方');
  const players = [host];
  for (const name of ['绿方', '红方', '黄方']) players.push(await f.join(host, name));
  const streams = [];
  for (const player of players) {
    const stream = await f.events(player);
    assert.equal((await stream.next()).data.you.seat, streams.length);
    streams.push(stream);
  }
  await f.action(host, 'capacity', { capacity: 3 });
  await f.action(host, 'start', {}, 409);
  await f.action(players[3], 'spectate');
  assert.deepEqual((await f.action(host, 'start')).state.game.active, [0, 1, 2]);
  for (const seat of [0, 1, 2]) {
    const next = (await f.action(players[seat], 'roll')).state;
    assert.equal(next.game.turn, (seat + 1) % 3);
  }
  await f.action(host, 'end');
  await f.action(players[3], 'seat', { seat: 3 });
  await f.action(host, 'capacity', { capacity: 4 });
  const started = (await f.action(host, 'start')).state;
  assert.deepEqual(started.game.active, [0, 1, 2, 3]);
  for (const seat of [0, 1, 2, 3]) {
    const next = (await f.action(players[seat], 'roll')).state;
    assert.equal(next.game.dice, 1);
    assert.equal(next.game.phase, 'roll');
    assert.equal(next.game.turn, (seat + 1) % 4);
    for (const stream of streams) {
      const synced = await stream.revision(next.revision);
      assert.equal(synced.revision, next.revision);
      assert.deepEqual(synced.game.active, [0, 1, 2, 3]);
      assert.equal(synced.game.turn, next.game.turn);
    }
  }
});

test('role codes rotate on seat changes and takeover while only the current host sees every code', async t => {
  const f = await fixture(t);
  const host = await f.create('甲');
  const guest = await f.join(host, '乙');
  const spectator = await f.join(host, '观战者');
  await f.action(spectator, 'spectate');
  const hs = await f.events(host);
  const gs = await f.events(guest);
  const ss = await f.events(spectator);
  const initialCode = host.state.you.takeoverCode;
  assert.match(initialCode, /^[0-9A-HJKMNP-TV-Z]{12}$/);
  assert.notEqual(initialCode, guest.state.you.takeoverCode);
  assert.equal(JSON.stringify(guest.state).includes(initialCode), false);
  assert.equal(JSON.stringify(host.state.players).includes(initialCode), false);
  assertHostCodes((await hs.next()).data, [[host, initialCode], [guest, guest.state.you.takeoverCode], [spectator, null]]);
  assertNoHostCodes((await gs.next()).data);
  assertNoHostCodes((await ss.next()).data);

  const guestMoved = (await f.action(guest, 'seat', { seat: 3 })).state;
  assert.notEqual(guestMoved.you.takeoverCode, guest.state.you.takeoverCode);
  assertNoHostCodes(guestMoved);
  assertHostCodes(await hs.revision(guestMoved.revision), [[host, initialCode], [guest, guestMoved.you.takeoverCode], [spectator, null]]);
  const moved = (await f.action(host, 'seat', { seat: 2 })).state;
  assert.notEqual(moved.you.takeoverCode, initialCode);
  assertHostCodes(moved, [[host, moved.you.takeoverCode], [guest, guestMoved.you.takeoverCode], [spectator, null]]);
  assert.equal((await f.action(host, 'seat', { seat: 2 })).state.you.takeoverCode, moved.you.takeoverCode);
  const watching = (await f.action(host, 'spectate')).state;
  assert.equal(watching.you.takeoverCode, null);
  assertHostCodes(watching, [[host, null], [guest, guestMoved.you.takeoverCode], [spectator, null]]);
  const seatedAgain = (await f.action(host, 'seat', { seat: 0 })).state;
  assert.notEqual(seatedAgain.you.takeoverCode, moved.you.takeoverCode);
  assertHostCodes(seatedAgain, [[host, seatedAgain.you.takeoverCode], [guest, guestMoved.you.takeoverCode], [spectator, null]]);
  assert.equal(JSON.stringify(await f.state(guest)).includes(seatedAgain.you.takeoverCode), false);
  assertNoHostCodes(await gs.revision(seatedAgain.revision));
  const spectatorView = await ss.revision(seatedAgain.revision);
  assertNoHostCodes(spectatorView);
  assert.equal(JSON.stringify(spectatorView).includes(guestMoved.you.takeoverCode), false);
  assert.equal(JSON.stringify(spectatorView).includes(seatedAgain.you.takeoverCode), false);

  await f.action(host, 'capacity', { capacity: 2 });
  const started = (await f.action(host, 'start')).state;
  for (const stream of [hs, gs, ss]) await stream.revision(started.revision);
  const replacement = (await f.action(spectator, 'takeover', { code: guestMoved.you.takeoverCode })).state;
  assert.notEqual(replacement.you.takeoverCode, guestMoved.you.takeoverCode);
  assertNoHostCodes(replacement);
  assert.deepEqual(replacement.game, started.game);
  const expectedCodes = [[host, seatedAgain.you.takeoverCode], [guest, null], [spectator, replacement.you.takeoverCode]];
  assertHostCodes(await hs.revision(replacement.revision), expectedCodes);
  assertHostCodes(await f.state(host), expectedCodes);
  assert.equal((await gs.next()).type, 'role-replaced');
  const formerGuest = await gs.revision(replacement.revision);
  assert.equal(formerGuest.you.takeoverCode, null);
  assertNoHostCodes(formerGuest);
  assert.equal(JSON.stringify(formerGuest).includes(replacement.you.takeoverCode), false);
});

test('a new device takes over a selected move without changing game or deadline', async t => {
  const f = await fixture(t, { randomDice: () => 6 });
  const host = await f.create('原机长');
  const guest = await f.join(host, '朋友');
  const hs = await f.events(host);
  const gs = await f.events(guest);
  await hs.next();
  await gs.next();
  await f.action(host, 'capacity', { capacity: 2 });
  await f.action(host, 'start');
  const device = await f.join(host, '新设备');
  assert.equal(device.state.you.seat, null);
  assert.equal(device.state.you.takeoverCode, null);
  const ds = await f.events(device);
  await ds.next();
  const selected = (await f.action(host, 'roll')).state;
  assert.equal(selected.game.phase, 'move');
  assert.equal(selected.game.sixes, 1);
  await hs.revision(selected.revision);
  const oldCode = selected.you.takeoverCode;
  const groupedCode = oldCode.match(/.{4}/g).join('-').toLowerCase();
  const replaced = (await f.action(device, 'takeover', { code: groupedCode })).state;
  assert.deepEqual(replaced.game, selected.game, 'all game fields and original deadline survive');
  assert.equal(replaced.players.length, selected.players.length);
  assert.equal(replaced.players.filter(p => p.seat === null).length, 1, 'one spectator replaces one owner');
  assert.equal(replaced.you.seat, 0);
  assert.equal(replaced.you.host, true);
  assert.notEqual(replaced.you.takeoverCode, oldCode);
  assert.equal((await hs.next()).type, 'role-replaced');
  const oldState = await hs.revision(replaced.revision);
  const otherState = await gs.revision(replaced.revision);
  const newState = await ds.revision(replaced.revision);
  assert.equal(oldState.you.seat, null);
  assert.equal(oldState.you.host, false);
  assert.equal(oldState.you.takeoverCode, null);
  assertNoHostCodes(oldState);
  assertNoHostCodes(otherState);
  assertHostCodes(newState, [[host, null], [guest, guest.state.you.takeoverCode], [device, replaced.you.takeoverCode]]);
  assert.equal(oldState.players.find(p => p.id === host.state.you.id).online, true);
  assert.deepEqual(oldState.game, newState.game);
  assert.deepEqual(otherState.game, newState.game);
  assert.equal(JSON.stringify(oldState).includes(replaced.you.takeoverCode), false);
  assert.equal(JSON.stringify(otherState).includes(replaced.you.takeoverCode), false);
  assert.equal(JSON.stringify(newState.players).includes(replaced.you.takeoverCode), false);
  assert.equal(JSON.stringify(newState.game).includes(replaced.you.takeoverCode), false);
  await f.action(host, 'roll', {}, 403);
  await f.action(host, 'move', { piece: 0 }, 403);
  await f.action(host, 'end', {}, 403);
  await f.action(host, 'takeover', { code: oldCode }, 403);
  const continued = (await f.action(device, 'move', { piece: 0 })).state;
  assert.equal(continued.game.pieces[0][0], TAKEOFF);
  assert.equal(continued.game.turn, 0);
  assert.equal(continued.game.phase, 'roll');
  const reconnect = await f.events(host);
  const originalIdentity = (await reconnect.next()).data;
  assert.equal(originalIdentity.you.id, host.state.you.id);
  assert.equal(originalIdentity.you.seat, null);
  assert.equal(originalIdentity.you.host, false);
  assertNoHostCodes(originalIdentity);
});

test('an offline owner can be replaced and host grace cannot steal the new ownership', async t => {
  const f = await fixture(t, { randomDice: () => 2 });
  const host = await f.create('旧设备');
  const guest = await f.join(host, '朋友');
  const hs = await f.events(host);
  await hs.next();
  await f.events(guest);
  await f.action(host, 'capacity', { capacity: 2 });
  await f.action(host, 'start');
  const spectator = await f.join(host, '接替者');
  const stream = await f.events(spectator);
  await stream.next();
  const selected = (await f.action(host, 'roll')).state;
  await stream.revision(selected.revision);
  await hs.close();
  const offline = await stream.revision(selected.revision + 1);
  assert.equal(offline.players.find(p => p.id === host.state.you.id).online, false);
  const replaced = (await f.action(spectator, 'takeover', { code: selected.you.takeoverCode })).state;
  assert.equal(replaced.hostId, spectator.state.you.id);
  assertHostCodes(replaced, [[host, null], [guest, guest.state.you.takeoverCode], [spectator, replaced.you.takeoverCode]]);
  assert.deepEqual(replaced.game, selected.game);
  assert.equal(replaced.players.find(p => p.id === host.state.you.id).online, false);
  const reconnected = await f.events(host);
  const restored = (await reconnected.next()).data;
  assert.equal(restored.hostId, spectator.state.you.id);
  assert.equal(restored.you.host, false);
  assert.equal(restored.you.seat, null);
  assertNoHostCodes(restored);
  const continued = (await f.action(spectator, 'move', { piece: 0 })).state;
  assert.equal(continued.game.pieces[0][0], TAKEOFF);
  assert.equal(continued.game.turn, 1);
  await f.action(spectator, 'end');
});

test('takeover rejects invalid contexts and limits failed guesses across new identities', async t => {
  const f = await fixture(t, { randomDice: () => 6 });
  const host = await f.create();
  const spectator = await f.join(host, '观战者');
  await f.action(spectator, 'spectate');
  await f.action(spectator, 'takeover', { code: host.state.you.takeoverCode }, 409);
  await f.join(host, '朋友');
  await f.action(host, 'capacity', { capacity: 2 });
  await f.action(host, 'start');
  await f.action(host, 'takeover', { code: host.state.you.takeoverCode }, 403);
  const inputs = [null, ['wrong'], 'IIII-OOOO-UUUU', '000000000000', '1111-1111-1111'];
  let errorMessage;
  for (const code of inputs) {
    const rejected = await f.action(spectator, 'takeover', { code }, 403);
    if (!errorMessage) errorMessage = rejected.error;
    assert.equal(rejected.error, errorMessage, 'all code failures have a generic response');
  }
  await f.action(spectator, 'takeover', { code: host.state.you.takeoverCode }, 429);
  const anotherDevice = await f.join(host, '另一设备');
  await f.action(anotherDevice, 'takeover', { code: host.state.you.takeoverCode }, 429);
  assert.equal((await f.state(host)).you.seat, 0);
  const selected = (await f.action(host, 'roll')).state;
  assert.equal(selected.game.phase, 'move', 'failed takeover does not interrupt ordinary play');
  await f.action(host, 'end');
  await f.action(anotherDevice, 'takeover', { code: host.state.you.takeoverCode }, 409);
});

test('only the lobby host chooses a mode, every client receives it and a running game locks it', async t => {
  const f = await fixture(t, { randomDice: () => 2 });
  const host = await f.post('/api/rooms', { name: '房主', mode: 'fun' }, 201);
  const guest = await f.join(host, '玩家');
  const spectator = await f.join(host, '观战者');
  await f.action(spectator, 'spectate');
  const hs = await f.events(host);
  const gs = await f.events(guest);
  const ss = await f.events(spectator);
  for (const stream of [hs, gs, ss]) assert.equal((await stream.next()).data.mode, 'classic');
  assert.equal(host.state.mode, 'classic', 'a creation payload cannot silently choose a different rule set');
  await f.action(guest, 'mode', { mode: 'fun' }, 403);
  await f.action(spectator, 'mode', { mode: 'fun' }, 403);
  const unchanged = await f.state(host);
  for (const mode of [undefined, null, 'FUN', 'unknown', { mode: 'fun' }]) {
    await f.action(host, 'mode', { mode }, 400);
  }
  assert.deepEqual(await f.state(host), unchanged, 'invalid modes preserve the entire lobby snapshot');
  const selected = (await f.action(host, 'mode', { mode: 'fun' })).state;
  assert.equal(selected.mode, 'fun');
  for (const stream of [hs, gs, ss]) assert.equal((await stream.revision(selected.revision)).mode, 'fun');
  await f.action(host, 'capacity', { capacity: 2 });
  const started = (await f.action(host, 'start', { mode: 'classic' })).state;
  assert.equal(started.mode, 'fun');
  assert.equal(started.game.mode, 'fun', 'the engine receives the authoritative lobby choice');
  await f.action(host, 'mode', { mode: 'classic' }, 409);
  await f.action(guest, 'mode', { mode: 'classic' }, 403);
  assert.deepEqual(await f.state(host), started);
  await f.action(host, 'end');
  const classic = (await f.action(host, 'mode', { mode: 'classic' })).state;
  assert.equal(classic.mode, 'classic');
  assert.equal((await f.action(host, 'start')).state.game.mode, 'classic');
});

test('fun moves are authoritative, synchronized and preserved through device takeover and reconnect', async t => {
  const f = await fixture(t, { randomDice: () => 6 });
  const host = await f.create('原设备');
  const guest = await f.join(host, '朋友');
  const hs = await f.events(host);
  const gs = await f.events(guest);
  await hs.next();
  await gs.next();
  await f.action(host, 'capacity', { capacity: 2 });
  await f.action(host, 'mode', { mode: 'fun' });
  const started = (await f.action(host, 'start')).state;
  const launched = (await f.action(host, 'roll', { dice: 1, mode: 'classic', pieces: [[57, 57, 57, 57]] })).state;
  assert.equal(launched.game.dice, 6, 'clients cannot choose dice or positions');
  assert.equal(launched.game.mode, 'fun');
  const apron = (await f.action(host, 'move', { piece: 0, to: 57, effects: [{ type: 'speed' }] })).state;
  assert.equal(apron.game.pieces[0][0], TAKEOFF);
  assert.equal(apron.game.lastMove.id, 1);
  assert.deepEqual(apron.game.lastMove.effects, []);
  const device = await f.join(host, '新设备');
  const ds = await f.events(device);
  await ds.next();
  const selected = (await f.action(host, 'roll')).state;
  const oldCode = selected.you.takeoverCode;
  const replaced = (await f.action(device, 'takeover', { code: oldCode })).state;
  assert.equal(replaced.mode, 'fun');
  assert.deepEqual(replaced.game, selected.game, 'mode, event id, positions and deadline survive takeover');
  assertHostCodes(replaced, [[host, null], [guest, guest.state.you.takeoverCode], [device, replaced.you.takeoverCode]]);
  const formerHost = await hs.revision(replaced.revision);
  assertNoHostCodes(formerHost);
  assert.equal(formerHost.you.seat, null);
  assert.equal(JSON.stringify(formerHost).includes(replaced.you.takeoverCode), false);
  await f.action(host, 'mode', { mode: 'classic' }, 403);
  await f.action(host, 'move', { piece: 0 }, 403);
  await f.action(host, 'takeover', { code: oldCode }, 403);
  const moved = (await f.action(device, 'move', {
    piece: 0, mode: 'classic', to: 57, path: [57], captured: [{ seat: 1, piece: 0 }], effects: [],
  })).state;
  assert.equal(moved.mode, 'fun');
  assert.equal(moved.game.mode, 'fun');
  assert.equal(moved.game.pieces[0][0], 7);
  assert.deepEqual(moved.game.pieces[1], [-1, -1, -1, -1]);
  assert.deepEqual(moved.game.lastMove.path, [6, 10, 7]);
  assert.deepEqual(moved.game.lastMove.effects, [{ type: 'trap', from: 10, to: 7 }]);
  assert.deepEqual(moved.game.lastMove.captured, []);
  assert.equal(moved.game.lastMove.id, 2);
  assert.equal(moved.game.moveNumber, 2);
  for (const stream of [hs, gs, ds]) {
    const synced = await stream.revision(moved.revision);
    assert.equal(synced.mode, 'fun');
    assert.deepEqual(synced.game, moved.game);
    assert.equal(JSON.stringify(synced.game).includes(replaced.you.takeoverCode), false);
  }
  await gs.close();
  const reconnected = await f.events(guest);
  const restored = (await reconnected.next()).data;
  assert.equal(restored.mode, 'fun');
  assert.deepEqual(restored.game, moved.game, 'reconnect preserves the latest resolved special effect');
  assertNoHostCodes(restored);
  assert.equal(JSON.stringify(restored).includes(replaced.you.takeoverCode), false);
  assert.equal(started.game.mode, 'fun');
});

test('offline automatic turns keep the selected fun mode and broadcast resolved trap events', async t => {
  const f = await fixture(t, { turnMs: 100, randomDice: () => 6 });
  const host = await f.create('房主');
  const guest = await f.join(host, '朋友');
  const hs = await f.events(host);
  await hs.next();
  const gs = await f.events(guest);
  await gs.next();
  await f.action(host, 'capacity', { capacity: 2 });
  await f.action(host, 'mode', { mode: 'fun' });
  const started = (await f.action(host, 'start')).state;
  await hs.close();
  let automatic;
  for (let i = 0; i < 10; i++) {
    const event = await gs.next();
    if (event?.type === 'state' && event.data.game?.moveNumber >= 2) { automatic = event.data; break; }
  }
  assert.ok(automatic, 'spectators and other players receive automatic movement events');
  assert.equal(automatic.mode, 'fun');
  assert.equal(automatic.game.mode, 'fun');
  assert.equal(automatic.game.pieces[0][0], 7);
  assert.equal(automatic.game.lastMove.id, 2);
  assert.deepEqual(automatic.game.lastMove.effects, [{ type: 'trap', from: 10, to: 7 }]);
  assert.match(automatic.game.log.map(entry => entry.text).join(' '), /操作超时/);
  assert.ok(automatic.revision > started.revision);
  assert.equal(automatic.players.find(player => player.id === host.state.you.id).online, false);
  assertNoHostCodes(automatic);
});

for (const mode of ['classic', 'fun']) {
  test(`${mode}: four-client rankings, spectator snapshots and device takeover retain the authoritative result`, async t => {
    let dice = 6;
    const f = await fixture(t, {
      randomDice: () => dice,
      gameFactory(players, options) {
        const g = createGame(players, options);
        g.pieces[0] = [FINISH, FINISH, FINISH, 51];
        g.pieces[1] = [FINISH, FINISH, FINISH, 56];
        g.pieces[2] = [FINISH, FINISH, FINISH, 56];
        g.players[0].stats.red = 2;
        g.players[3].stats.green = 3;
        return g;
      },
    });
    const host = await f.create('第一名');
    const members = [host];
    for (const name of ['第二名', '第三名', '最后一名']) members.push(await f.join(host, name));
    const streams = [];
    for (const member of members) {
      const stream = await f.events(member);
      await stream.next();
      streams.push(stream);
    }
    await f.action(host, 'mode', { mode });
    const started = (await f.action(host, 'start')).state;
    const spectator = await f.join(host, '观战和换设备');
    const ss = await f.events(spectator);
    await ss.next();
    streams.push(ss);
    let latest = started;
    for (const seat of [0, 1]) {
      dice = seat === 0 ? 6 : 1;
      await f.action(members[seat], 'roll');
      latest = (await f.action(members[seat], 'move', { piece: 3, rank: 99, stats: { green: 999 } })).state;
      assert.equal(latest.game.status, 'playing');
      assert.equal(latest.game.turn, seat + 1);
      assert.deepEqual(latest.game.rankings, Array.from({ length: seat + 1 }, (_, i) => i));
      assert.equal(latest.game.players.find(player => player.seat === seat).rank, seat + 1);
      assert.equal(latest.players.find(player => player.seat === seat).rank, seat + 1);
      for (const stream of streams) {
        const synced = await stream.revision(latest.revision);
        assert.deepEqual(synced.game, latest.game);
        assert.deepEqual(synced.players.map(({ seat, rank, stats }) => ({ seat, rank, stats })),
          latest.players.map(({ seat, rank, stats }) => ({ seat, rank, stats })));
      }
      await f.action(members[seat], 'roll', {}, 409);
      await f.action(members[seat], 'move', { piece: 3 }, 409);
      await f.action(spectator, 'takeover', { code: members[seat].state.you.takeoverCode }, 409);
    }
    assert.equal(latest.players.find(player => player.seat === 0).stats.red, 2);
    await streams[1].close();
    streams[1] = await f.events(members[1]);
    const restored = (await streams[1].next()).data;
    assert.deepEqual(restored.game, latest.game, 'reconnect keeps ranks, counters and the running deadline');
    assert.equal(restored.players.find(player => player.seat === 1).rank, 2);
    assert.deepEqual((await f.state(spectator)).game, latest.game, 'a refresh uses the same result snapshot');

    const replacement = (await f.action(spectator, 'takeover', { code: members[3].state.you.takeoverCode })).state;
    assert.equal(replacement.you.seat, 3);
    assert.deepEqual(replacement.game, latest.game);
    assert.equal(replacement.players.find(player => player.seat === 3).stats.green, 3);
    assert.equal(replacement.players.find(player => player.seat === 3).rank, null);
    for (const stream of streams) await stream.revision(replacement.revision);
    dice = 1;
    await f.action(members[2], 'roll');
    const finished = (await f.action(members[2], 'move', { piece: 3 })).state;
    assert.equal(finished.game.status, 'finished');
    assert.deepEqual(finished.game.rankings, [0, 1, 2, 3]);
    assert.equal(finished.game.deadline, null);
    assert.equal(finished.game.winner, 0);
    for (const seat of [0, 1, 2, 3]) {
      const value = finished.players.find(player => player.seat === seat);
      assert.equal(value.rank, seat + 1);
      assert.deepEqual(value.stats, finished.game.players.find(player => player.seat === seat).stats);
    }
    assert.equal(finished.players.find(player => player.id === spectator.state.you.id).rank, 4);
    assert.equal(finished.players.find(player => player.id === spectator.state.you.id).stats.green, 3);
    for (const stream of streams) assert.deepEqual((await stream.revision(finished.revision)).game, finished.game);
    assert.deepEqual((await f.state(host)).game, finished.game);
    await f.action(spectator, 'roll', {}, 409);
    await f.action(spectator, 'move', { piece: 0 }, 409);
  });
}

test('wall break events and colour counters synchronize, reject injected results and survive takeover and reconnect', async t => {
  const zero = Object.fromEntries(COLORS.map(color => [color.key, 0]));
  const f = await fixture(t, {
    randomDice: () => 4,
    gameFactory(players, options) {
      const g = createGame(players, options);
      g.pieces[0][0] = 3;
      g.pieces[1] = [46, 46, -1, -1]; // Both red planes are at green progress 7.
      return g;
    },
  });
  const host = await f.create('原绿方');
  const guest = await f.join(host, '红方');
  await f.action(host, 'capacity', { capacity: 2 });
  await f.action(host, 'mode', { mode: 'fun' });
  await f.action(host, 'start');
  const device = await f.join(host, '新设备');
  const hs = await f.events(host);
  const gs = await f.events(guest);
  const ds = await f.events(device);
  for (const stream of [hs, gs, ds]) await stream.next();
  const rolled = (await f.action(host, 'roll', { dice: 6, actualSteps: 1, mode: 'classic' })).state;
  assert.equal(rolled.game.dice, 4);
  const broken = (await f.action(host, 'move', {
    piece: 0, steps: 6, to: 57, rank: 1, stats: { green: 100 }, events: [], captured: [],
  })).state;
  assert.equal(broken.game.pieces[0][0], -1);
  assert.deepEqual(broken.game.pieces[1].slice(0, 2), [-1, -1]);
  assert.deepEqual(broken.game.lastMove.events.map(event => event.type), ['WALL_BREAK']);
  assert.equal(broken.game.lastMove.selfReturned, true);
  assert.equal(broken.game.lastMove.captured.length, 2);
  assert.equal(broken.game.lastMove.taunt, '此墙不破，我誓不为机！');
  assert.deepEqual(broken.players.find(player => player.seat === 0).stats, { ...zero, green: 1, red: 2 });
  assert.deepEqual(broken.players.find(player => player.seat === 1).stats, zero);
  assert.equal(broken.players.find(player => player.seat === 0).rank, null);
  for (const stream of [hs, gs, ds]) {
    const synced = await stream.revision(broken.revision);
    assert.deepEqual(synced.game, broken.game);
    assert.deepEqual(synced.players.map(player => player.stats), broken.players.map(player => player.stats));
  }
  const replaced = (await f.action(device, 'takeover', { code: broken.you.takeoverCode })).state;
  assert.equal(replaced.you.seat, 0);
  assert.deepEqual(replaced.game, broken.game);
  assert.deepEqual(replaced.players.find(player => player.seat === 0).stats, { ...zero, green: 1, red: 2 });
  await gs.close();
  const reconnect = await f.events(guest);
  const resumed = (await reconnect.next()).data;
  assert.deepEqual(resumed.game, broken.game);
  assert.deepEqual(resumed.players.find(player => player.seat === 0).stats, { ...zero, green: 1, red: 2 });
  assert.deepEqual((await f.state(device)).game, broken.game);
  await f.action(host, 'roll', {}, 403);
});

test('offline timeouts recover stale ranked turns and only operate on unfinished players', async t => {
  const f = await fixture(t, {
    turnMs: 100,
    randomDice: () => 1,
    gameFactory(players, options) {
      const g = createGame(players, options);
      g.pieces[0] = [FINISH, FINISH, FINISH, FINISH];
      g.players[0].rank = 1;
      g.rankings = [0];
      g.winner = 0;
      g.turn = 0; // Exercise recovery from an old timer that still targets a ranked seat.
      g.phase = 'move';
      g.legal = [0];
      g.sixes = 2;
      g.pieces[1] = [FINISH, FINISH, FINISH, 56];
      return g;
    },
  });
  const host = await f.create('已完成的房主');
  const guest = await f.join(host, '待完成');
  await f.join(host, '第三位');
  await f.join(host, '第四位');
  const hs = await f.events(host);
  const gs = await f.events(guest);
  await hs.next();
  await gs.next();
  const started = (await f.action(host, 'start')).state;
  await hs.close();
  let completed;
  for (let i = 0; i < 12; i++) {
    const event = await gs.next();
    if (event?.type === 'state' && event.data.game?.players.find(player => player.seat === 1)?.rank === 2) {
      completed = event.data;
      break;
    }
  }
  assert.ok(completed, 'the next unfinished player completes through the automatic service path');
  assert.equal(completed.game.status, 'playing');
  assert.equal(completed.game.turn, 2);
  assert.deepEqual(completed.game.rankings, [0, 1]);
  assert.deepEqual(completed.game.pieces[0], started.game.pieces[0]);
  assert.deepEqual(completed.game.players[0].stats, started.game.players[0].stats);
  assert.equal(completed.game.lastMove.seat, 1);
  assert.equal(completed.players.find(player => player.seat === 0).online, false);
  assert.equal(completed.players.find(player => player.seat === 0).rank, 1);
  assert.match(completed.game.log.map(entry => entry.text).join(' '), /操作超时/);
});

test('lucky movement is drawn once by the server and broadcasts the same event and capture counters', async t => {
  const f = await fixture(t, {
    randomDice: () => 1,
    randomIndex: max => { assert.equal(max, 6); return 5; },
    gameFactory(players, options) {
      const g = createGame(players, options);
      g.pieces[0][0] = 10;
      g.pieces[1][0] = 1; // red progress 1 is green progress 14
      return g;
    },
  });
  const host = await f.create('幸运机长');
  const guest = await f.join(host, '对手');
  await f.action(host, 'capacity', { capacity: 2 });
  await f.action(host, 'mode', { mode: 'fun' });
  await f.action(host, 'start');
  const spectator = await f.join(host, '观战');
  const hs = await f.events(host);
  const gs = await f.events(guest);
  const ss = await f.events(spectator);
  for (const stream of [hs, gs, ss]) await stream.next();
  await f.action(host, 'roll', { rollCount: 40, iceCell: 11, randomIndex: 0 });
  const lucky = (await f.action(host, 'move', { piece: 0, delta: -3, to: 8, frozenPieces: [[true]], effects: [] })).state;
  assert.equal(lucky.game.pieces[0][0], 14);
  assert.equal(lucky.game.pieces[1][0], -1);
  assert.equal(lucky.game.rollCount, 1);
  assert.equal(lucky.game.iceCell, null);
  assert.equal(lucky.game.frozenPieces.flat().some(Boolean), false);
  assert.deepEqual(lucky.game.lastMove.effects, [{ type: 'lucky', from: 11, to: 14, delta: 3 }]);
  assert.equal(lucky.players.find(player => player.seat === 0).stats.red, 1);
  for (const stream of [hs, gs, ss]) assert.deepEqual((await stream.revision(lucky.revision)).game, lucky.game);
  await gs.close();
  const reconnect = await f.events(guest);
  assert.deepEqual((await reconnect.next()).data.game, lucky.game);
  assert.deepEqual((await f.state(spectator)).game, lucky.game);
});

test('ice generation, consumption and frozen legality survive snapshots, reconnect and device takeover', async t => {
  let dice = 1;
  const f = await fixture(t, {
    randomDice: () => dice,
    randomIndex: () => 3, // Candidates begin 0, 1, 3, 6 after occupied 4/5 are removed.
    gameFactory(players, options) {
      const g = createGame(players, options);
      g.rollCount = 19;
      g.pieces[0][0] = 5;
      g.pieces[0][1] = 4;
      return g;
    },
  });
  const host = await f.create('旧设备');
  const guest = await f.join(host, '另一方');
  await f.action(host, 'capacity', { capacity: 2 });
  await f.action(host, 'mode', { mode: 'fun' });
  await f.action(host, 'start');
  const device = await f.join(host, '新设备');
  const hs = await f.events(host);
  const gs = await f.events(guest);
  const ds = await f.events(device);
  for (const stream of [hs, gs, ds]) await stream.next();
  const generated = (await f.action(host, 'roll', { rollCount: 0, iceCell: 51, frozenPieces: [] })).state;
  assert.equal(generated.game.rollCount, 20);
  assert.equal(generated.game.iceCell, 6);
  assert.equal(specialCellAt(generated.game.iceCell), null);
  for (const stream of [hs, gs, ds]) assert.deepEqual((await stream.revision(generated.revision)).game, generated.game);
  const frozen = (await f.action(host, 'move', { piece: 0, frozenPieces: [], iceCell: 51 })).state;
  assert.equal(frozen.game.pieces[0][0], 6);
  assert.equal(frozen.game.iceCell, null);
  assert.equal(frozen.game.frozenPieces[0][0], true);
  assert.deepEqual(frozen.game.lastMove.effects, [{ type: 'ice', from: 6, to: 6 }]);
  for (const stream of [hs, gs, ds]) assert.deepEqual((await stream.revision(frozen.revision)).game, frozen.game);
  assert.deepEqual((await f.state(host)).game, frozen.game);
  await gs.close();
  const reconnect = await f.events(guest);
  assert.deepEqual((await reconnect.next()).data.game, frozen.game);
  const replaced = (await f.action(device, 'takeover', { code: frozen.you.takeoverCode, frozenPieces: [], rollCount: 0 })).state;
  assert.equal(replaced.you.seat, 0);
  assert.deepEqual(replaced.game, frozen.game);
  for (const stream of [hs, reconnect, ds]) await stream.revision(replaced.revision);
  await f.action(host, 'move', { piece: 0 }, 403);
  await f.action(guest, 'roll');
  const nonSix = (await f.action(device, 'roll')).state;
  assert.deepEqual(nonSix.game.legal, [1]);
  const counter = nonSix.game.rollCount;
  await f.action(device, 'move', { piece: 0, dice: 6, frozenPieces: [] }, 409);
  assert.deepEqual((await f.state(device)).game, nonSix.game);
  const otherPlane = (await f.action(device, 'move', { piece: 1 })).state;
  assert.equal(otherPlane.game.frozenPieces[0][0], true);
  assert.equal(otherPlane.game.pieces[0][0], 6);
  await f.action(guest, 'roll');
  dice = 6;
  const six = (await f.action(device, 'roll')).state;
  assert.equal(six.game.frozenPieces[0][0], true);
  assert.ok(six.game.legal.includes(0));
  const thawed = (await f.action(device, 'move', { piece: 0, frozenPieces: [[true]] })).state;
  assert.equal(thawed.game.frozenPieces[0][0], false);
  assert.equal(thawed.game.pieces[0][0], 12);
  assert.equal(thawed.game.rollCount, counter + 2);
  for (const stream of [hs, reconnect, ds]) assert.deepEqual((await stream.revision(thawed.revision)).game, thawed.game);
});

test('offline automatic service rolls generate ice with the same authoritative snapshot', async t => {
  const f = await fixture(t, {
    turnMs: 100,
    randomDice: () => 1,
    randomIndex: () => 0,
    gameFactory(players, options) {
      const g = createGame(players, options);
      g.rollCount = 19;
      g.pieces[0][0] = 3;
      return g;
    },
  });
  const host = await f.create('离线机长');
  const guest = await f.join(host, '观察者');
  const hs = await f.events(host);
  const gs = await f.events(guest);
  await hs.next();
  await gs.next();
  await f.action(host, 'capacity', { capacity: 2 });
  await f.action(host, 'mode', { mode: 'fun' });
  const started = (await f.action(host, 'start')).state;
  await hs.close();
  let automatic;
  for (let i = 0; i < 10; i++) {
    const event = await gs.next();
    if (event?.type === 'state' && event.data.game?.rollCount >= 20) { automatic = event.data; break; }
  }
  assert.ok(automatic);
  assert.equal(automatic.game.rollCount, 20);
  assert.equal(automatic.game.iceCell, 0);
  assert.equal(automatic.game.pieces[0][0], 4);
  assert.equal(automatic.game.frozenPieces.flat().some(Boolean), false);
  assert.ok(automatic.revision > started.revision);
  assert.match(automatic.game.log.map(entry => entry.text).join(' '), /操作超时/);
});

test('only the fun lobby host patches known boolean rules and the running game keeps that configuration', async t => {
  const f = await fixture(t);
  const host = await f.create('规则房主');
  const guest = await f.join(host, '玩家');
  const spectator = await f.join(host, '观战');
  await f.action(spectator, 'spectate');
  const hs = await f.events(host);
  const gs = await f.events(guest);
  const ss = await f.events(spectator);
  for (const stream of [hs, gs, ss]) await stream.next();
  await f.action(host, 'rules', { rules: { items: true } }, 409);
  await f.action(guest, 'rules', { rules: { items: true } }, 403);
  await f.action(spectator, 'rules', { rules: { items: true } }, 403);
  await f.action(host, 'mode', { mode: 'fun' });
  const before = await f.state(host);
  for (const rules of [null, [], 1, { speed: 1 }, { lucky: 'true' }, { unknown: true }]) {
    await f.action(host, 'rules', { rules }, 400);
  }
  assert.deepEqual(await f.state(host), before);
  const patch = { speed: false, safe: false, lucky: false, ice: false, alliances: true, items: true };
  const chosen = (await f.action(host, 'rules', { rules: patch })).state;
  assert.deepEqual(chosen.rules, { ...DEFAULT_FUN_RULES, ...patch });
  for (const stream of [hs, gs, ss]) assert.deepEqual((await stream.revision(chosen.revision)).rules, chosen.rules);
  await f.action(host, 'capacity', { capacity: 2 });
  const started = (await f.action(host, 'start', { rules: { items: false, speed: true } })).state;
  assert.deepEqual(started.game.rules, chosen.rules);
  assert.deepEqual(started.game.handCounts, [3, 3, 0, 0]);
  await f.action(host, 'rules', { rules: { speed: true } }, 409);
  assert.deepEqual((await f.state(guest)).game.rules, chosen.rules);
  await f.action(host, 'end');
  await f.action(host, 'mode', { mode: 'classic' });
  const classic = (await f.action(host, 'start')).state;
  assert.equal(Object.values(classic.game.rules).some(Boolean), false);
  assert.deepEqual(classic.game.handCounts, [0, 0, 0, 0]);
  assert.deepEqual(classic.you.hand, []);
});

test('invitation acceptance and betrayal synchronize without client-forged alliances or extended deadlines', async t => {
  let dice = 1;
  const f = await fixture(t, {
    randomDice: () => dice,
    randomIndex: () => 0,
    gameFactory(players, options) {
      const g = createGame(players, options);
      g.pieces[0] = [2, 2, -1, -1];
      g.pieces[1][0] = 42; // red progress 42 shares green progress 3
      return g;
    },
  });
  const host = await f.create('绿方');
  const guest = await f.join(host, '红方');
  await f.action(host, 'capacity', { capacity: 2 });
  await f.action(host, 'mode', { mode: 'fun' });
  await f.action(host, 'rules', { rules: { alliances: true, items: true } });
  const started = (await f.action(host, 'start')).state;
  const spectator = await f.join(host, '观战');
  const hs = await f.events(host);
  const gs = await f.events(guest);
  const ss = await f.events(spectator);
  for (const stream of [hs, gs, ss]) await stream.next();
  await f.action(guest, 'alliance-accept', { targetSeat: 0 }, 409);
  await f.action(spectator, 'alliance-invite', { targetSeat: 0 }, 403);
  const invited = (await f.action(host, 'alliance-invite', { targetSeat: 1, allies: [1, 0], ambush: [true] })).state;
  assert.equal(invited.game.allies.every(value => value == null), true);
  assert.deepEqual(invited.game.invitations, [{ from: 0, to: 1 }]);
  assert.equal(invited.game.deadline, started.game.deadline);
  const accepted = (await f.action(guest, 'alliance-accept', { targetSeat: 0 })).state;
  assert.deepEqual(accepted.game.allies, [1, 0, null, null]);
  assert.equal(accepted.game.invitations.length, 0);
  assert.equal(accepted.game.deadline, started.game.deadline);
  for (const stream of [hs, gs, ss]) assert.deepEqual((await stream.revision(accepted.revision)).game, accepted.game);
  await f.action(host, 'alliance-cancel', { targetSeat: 1 }, 409);
  await f.action(host, 'roll', { allies: [null, null], ambush: [true] });
  const coexist = (await f.action(host, 'move', { piece: 0 })).state;
  assert.equal(coexist.game.pieces[1][0], 42);
  assert.deepEqual(coexist.game.lastMove.captured, []);
  await f.action(guest, 'roll');
  await f.action(guest, 'move', { piece: 0 });
  const beforeBetrayal = await f.state(host);
  const betrayed = (await f.action(host, 'alliance-betray', { allies: [1, 0], betrayed: [false] })).state;
  assert.equal(betrayed.game.allies.every(value => value == null), true);
  assert.equal(betrayed.game.betrayed[0], true);
  assert.equal(betrayed.game.diceDouble[0], true);
  assert.equal(betrayed.game.bountyRounds[0], 3);
  assert.equal(betrayed.game.betrayedBy[1], 0);
  assert.equal(betrayed.game.deadline, beforeBetrayal.game.deadline);
  dice = 2;
  await f.action(host, 'roll');
  const rolled = (await f.action(host, 'move', { piece: 1 })).state;
  assert.equal(rolled.game.dice, 4, 'dice value doubled from 2 to 4');
  assert.equal(rolled.game.diceDouble[0], false);
  for (const stream of [hs, gs, ss]) assert.deepEqual((await stream.revision(rolled.revision)).game, rolled.game);
  await gs.close();
  const reconnect = await f.events(guest);
  assert.deepEqual((await reconnect.next()).data.game, rolled.game);
});

test('remaining cards are private, counts are public and device takeover retains cards and the used-item allowance', async t => {
  const f = await fixture(t, {
    randomDice: () => 6,
    randomIndex: () => 0,
    gameFactory(players, options) {
      const g = createGame(players, options);
      g.pieces[0][0] = 3;
      g.pieces[1][0] = 44;
      return g;
    },
  });
  const host = await f.create('原设备');
  const guest = await f.join(host, '对手');
  await f.action(host, 'capacity', { capacity: 2 });
  await f.action(host, 'mode', { mode: 'fun' });
  await f.action(host, 'rules', { rules: { items: true } });
  const started = (await f.action(host, 'start')).state;
  const device = await f.join(host, '接替设备');
  const hs = await f.events(host);
  const gs = await f.events(guest);
  const ds = await f.events(device);
  for (const stream of [hs, gs, ds]) await stream.next();
  assert.deepEqual(started.you.hand, ['stun', 'mine', 'missile']);
  assert.deepEqual(device.state.you.hand, []);
  assert.deepEqual(started.game.handCounts, [3, 3, 0, 0]);
  assert.equal(Object.hasOwn(started.game, 'hands'), false);
  assert.equal(JSON.stringify(started.players).includes('"hand"'), false);
  await f.action(host, 'use-item', { card: 'invented', hands: [['invented']], targetSeat: 1, targetPiece: 0 }, 409);
  await f.action(host, 'use-item', { card: 'stun', targetSeat: 1, targetPiece: 4 }, 409);
  assert.deepEqual((await f.state(host)).game, started.game);
  await f.action(guest, 'use-item', { card: 'stun', targetSeat: 0, targetPiece: 0 }, 409);
  await f.action(device, 'use-item', { card: 'stun', targetSeat: 1, targetPiece: 0 }, 403);
  const mine = (await f.action(host, 'use-item', { card: 'mine', piece: 0, hands: [['stun']], handCounts: [100] })).state;
  assert.deepEqual(mine.you.hand, ['stun', 'missile']);
  assert.deepEqual(mine.game.handCounts, [2, 3, 0, 0]);
  assert.deepEqual(mine.game.mines, [{ seat: 0, index: 3 }]);
  assert.equal(mine.game.deadline, started.game.deadline);
  for (const [stream, expected] of [[hs, ['stun', 'missile']], [gs, ['stun', 'mine', 'missile']], [ds, []]]) {
    const synced = await stream.revision(mine.revision);
    assert.deepEqual(synced.game, mine.game);
    assert.deepEqual(synced.you.hand, expected);
    assert.equal(Object.hasOwn(synced.game, 'hands'), false);
  }
  const replacement = (await f.action(device, 'takeover', { code: mine.you.takeoverCode })).state;
  assert.deepEqual(replacement.game, mine.game);
  assert.deepEqual(replacement.you.hand, ['stun', 'missile']);
  assert.deepEqual((await hs.revision(replacement.revision)).you.hand, []);
  const formerHost = await f.state(host);
  assert.deepEqual(formerHost.you.hand, []);
  await f.action(host, 'use-item', { card: 'stun', targetSeat: 1, targetPiece: 0 }, 403);
  await f.action(device, 'use-item', { card: 'stun', targetSeat: 1, targetPiece: 0 }, 409);
  await f.action(device, 'roll');
  const repeated = (await f.action(device, 'move', { piece: 0 })).state;
  assert.equal(repeated.game.turn, 0);
  assert.equal(repeated.game.itemUsed[0], true);
  await f.action(device, 'use-item', { card: 'stun', targetSeat: 1, targetPiece: 0 }, 409);
  await gs.close();
  const reconnect = await f.events(guest);
  const restored = (await reconnect.next()).data;
  assert.deepEqual(restored.game, repeated.game);
  assert.deepEqual(restored.you.hand, ['stun', 'mine', 'missile']);
  assert.equal(Object.hasOwn(restored.game, 'hands'), false);
});

test('stun card broadcasts its freeze and an offline automatic turn selects another legal plane', async t => {
  const f = await fixture(t, {
    turnMs: 250,
    randomDice: () => 1,
    randomIndex: () => 0,
    gameFactory(players, options) {
      const g = createGame(players, options);
      g.pieces[0][0] = 3;
      g.pieces[1] = [44, 45, -1, -1];
      return g;
    },
  });
  const host = await f.create('用定身的房主');
  const guest = await f.join(host, '离线方');
  const hs = await f.events(host);
  const gs = await f.events(guest);
  await hs.next();
  await gs.next();
  await f.action(host, 'capacity', { capacity: 2 });
  await f.action(host, 'mode', { mode: 'fun' });
  await f.action(host, 'rules', { rules: { items: true } });
  const started = (await f.action(host, 'start')).state;
  const stunned = (await f.action(host, 'use-item', { card: 'stun', targetSeat: 1, targetPiece: 0 })).state;
  assert.equal(stunned.game.frozenPieces[1][0], true);
  assert.equal(stunned.game.frozenPieces[1][1], false);
  assert.deepEqual(stunned.you.hand, ['mine', 'missile']);
  assert.deepEqual(stunned.game.handCounts, [2, 3, 0, 0]);
  assert.equal(stunned.game.deadline, started.game.deadline);
  assert.equal(stunned.game.lastMove.events[0].type, 'STUN');
  for (const stream of [hs, gs]) assert.deepEqual((await stream.revision(stunned.revision)).game, stunned.game);
  await f.action(host, 'roll');
  const guestTurn = (await f.action(host, 'move', { piece: 0 })).state;
  assert.equal(guestTurn.game.turn, 1);
  await gs.close();
  let automatic;
  for (let i = 0; i < 12; i++) {
    const event = await hs.next();
    if (event?.type === 'state' && event.data.game?.lastMove?.seat === 1 && event.data.game.lastMove.kind !== 'item') {
      automatic = event.data;
      break;
    }
  }
  assert.ok(automatic, 'the frozen first plane cannot block the offline automatic service');
  assert.equal(automatic.game.lastMove.piece, 1);
  assert.equal(automatic.game.pieces[1][0], 44);
  assert.equal(automatic.game.frozenPieces[1][0], true);
  assert.equal(automatic.game.turn, 0);
  assert.deepEqual(automatic.players.map(player => player.stats), stunned.players.map(player => player.stats));
});

test('key-events: HTTP and SSE keep identical public history across refresh, reconnect and role takeover', async t => {
  const f = await fixture(t, {
    randomDice: () => 1,
    randomIndex: () => 0,
    gameFactory(players, options) {
      const g = createGame(players, options);
      g.pieces[0][0] = 2;
      g.pieces[1][0] = 42;
      return g;
    },
  });
  const host = await f.create('原机长');
  const guest = await f.join(host, '对手机长');
  await f.action(host, 'capacity', { capacity: 2 });
  await f.action(host, 'mode', { mode: 'fun' });
  await f.action(host, 'rules', { rules: { items: true } });
  const started = (await f.action(host, 'start')).state;
  assert.deepEqual(started.game.keyEvents.map(event => event.type), ['START']);
  const device = await f.join(host, '接替设备');
  const hs = await f.events(host), gs = await f.events(guest), ds = await f.events(device);
  for (const stream of [hs, gs, ds]) await stream.next();
  const rejectedBefore = await f.state(host);
  await f.action(guest, 'roll', {}, 409);
  await f.action(device, 'move', { piece: 0 }, 403);
  assert.deepEqual((await f.state(host)).game.keyEvents, rejectedBefore.game.keyEvents);
  const rolled = (await f.action(host, 'roll', { keyEvents: [{ id: 999, type: 'CAPTURE', text: 'invented', at: 0 }], eventNumber: 999 })).state;
  assert.deepEqual(rolled.game.keyEvents, started.game.keyEvents, 'client history fields cannot forge public facts');
  const captured = (await f.action(host, 'move', { piece: 0 })).state;
  assert.ok(captured.game.keyEvents.some(event => event.type === 'CAPTURE'));
  assert.equal(captured.game.eventNumber, captured.game.keyEvents.at(-1).id);
  const history = structuredClone(captured.game.keyEvents);
  for (const [stream, hand] of [[hs, ['stun', 'mine', 'missile']], [gs, ['stun', 'mine', 'missile']], [ds, []]]) {
    const synced = await stream.revision(captured.revision);
    assert.deepEqual(synced.game.keyEvents, history);
    assert.equal(synced.game.eventNumber, captured.game.eventNumber);
    assert.equal(Object.hasOwn(synced.game, 'hands'), false);
    assert.deepEqual(synced.you.hand, hand);
  }
  const refreshed = await f.state(guest);
  assert.deepEqual(refreshed.game.keyEvents, history, 'refresh GET retains the full key history');
  await gs.close();
  const reconnect = await f.events(guest);
  assert.deepEqual((await reconnect.next()).data.game.keyEvents, history, 'new real SSE connection restores history');
  const replaced = (await f.action(device, 'takeover', { code: captured.you.takeoverCode })).state;
  assert.deepEqual(replaced.game.keyEvents, history);
  assert.equal(replaced.game.eventNumber, captured.game.eventNumber);
  assert.deepEqual(replaced.you.hand, ['stun', 'mine', 'missile']);
  for (const stream of [hs, reconnect, ds]) {
    const synced = await stream.revision(replaced.revision);
    assert.deepEqual(synced.game.keyEvents, history);
    assert.equal(Object.hasOwn(synced.game, 'hands'), false);
  }
  const previous = await f.state(host);
  assert.equal(previous.you.seat, null);
  assert.deepEqual(previous.you.hand, []);
  const shared = JSON.stringify({ history: replaced.game.keyEvents, players: replaced.players, game: replaced.game });
  for (const player of [host, guest, device]) assert.equal(shared.includes(player.token), false);
  assert.equal(shared.includes(captured.you.takeoverCode), false);
  assert.equal(shared.includes('"hands"'), false);
});

function assertAfkSnapshot(state) {
  for (const member of state.players) {
    const result = state.game?.players.find(entry => entry.seat === member.seat);
    assert.equal(member.afk, result?.afk === true, 'public availability belongs to the current seat');
  }
}

function afkRetained(game) {
  return structuredClone({
    pieces: game.pieces, frozenPieces: game.frozenPieces, allies: game.allies, invitations: game.invitations,
    betrayed: game.betrayed, ambush: game.ambush, handCounts: game.handCounts, mines: game.mines,
    stats: game.players.map(player => player.stats), rollCount: game.rollCount, iceCell: game.iceCell,
    lastMove: game.lastMove, moveNumber: game.moveNumber, rankings: game.rankings,
  });
}

test('afk: self and host controls enforce permissions, input validation and unchanged phase deadlines', async t => {
  const f = await fixture(t);
  const host = await f.create('房主');
  const guest = await f.join(host, '红方');
  const third = await f.join(host, '黄方');
  await f.join(host, '蓝方');
  await f.action(host, 'mode', { mode: 'fun' });
  await f.action(host, 'rules', { rules: { items: true, alliances: true } });
  const started = (await f.action(host, 'start')).state;
  const spectator = await f.join(host, '观战');
  assertAfkSnapshot(started);
  const self = (await f.action(guest, 'afk', { targetSeat: 1, afk: true })).state;
  assert.equal(self.game.players.find(player => player.seat === 1).afk, true);
  assert.equal(self.game.deadline, started.game.deadline);
  const same = (await f.action(guest, 'afk', { targetSeat: 1, afk: true })).state;
  assert.deepEqual(same.game, self.game, 'same flag does not duplicate key facts or extend the clock');
  const resumed = (await f.action(guest, 'afk', { targetSeat: 1, afk: false })).state;
  assert.equal(resumed.game.players.find(player => player.seat === 1).afk, false);
  await f.action(host, 'afk', { targetSeat: 1, afk: true });
  const unavailable = (await f.action(host, 'afk', { targetSeat: 0, afk: true })).state;
  assertAfkSnapshot(unavailable);
  assert.equal(unavailable.game.deadline, started.game.deadline);
  for (const body of [{ targetSeat: 99, afk: true }, { targetSeat: '0', afk: true }, { targetSeat: 0, afk: 'true' }, { afk: true }]) await f.action(host, 'afk', body, 409);
  await f.action(guest, 'afk', { targetSeat: 0, afk: false }, 403);
  await f.action(spectator, 'afk', { targetSeat: 1, afk: false }, 403);
  await f.action(spectator, 'skip-afk', { revision: unavailable.revision, turn: 0, phase: 'roll' }, 403);
  await f.action(guest, 'skip-afk', { revision: unavailable.revision, turn: 0, phase: 'roll' }, 409);
  await f.action(host, 'roll', { automatic: true, afk: false }, 409);
  await f.action(host, 'use-item', { card: 'mine', piece: 0, automatic: true }, 409);
  await f.action(host, 'alliance-invite', { targetSeat: 2, automatic: true }, 409);
  await f.action(third, 'skip-afk', { revision: unavailable.revision - 1, turn: 0, phase: 'roll' }, 409);
  await f.action(third, 'skip-afk', { revision: unavailable.revision, turn: 1, phase: 'roll' }, 409);
  await f.action(third, 'skip-afk', { revision: unavailable.revision, turn: 0, phase: 'move' }, 409);
  assert.deepEqual((await f.state(host)).game, unavailable.game, 'every rejected control leaves gameplay and history intact');
  const recovered = (await f.action(host, 'afk', { targetSeat: 0, afk: false })).state;
  assert.equal(recovered.game.players.find(player => player.seat === 0).afk, false);
  assert.equal(recovered.game.deadline, started.game.deadline);
  assert.equal(recovered.game.keyEvents.at(-1).type, 'AFK_OFF');
});

test('afk: spectator and ranked hosts still manage active players but cannot skip as nonparticipants', async t => {
  const watching = await fixture(t);
  const watcher = await watching.create('观战房主');
  const red = await watching.join(watcher, '红方');
  await watching.action(watcher, 'capacity', { capacity: 2 });
  await watching.action(watcher, 'spectate');
  await watching.join(watcher, '绿方');
  await watching.action(watcher, 'start');
  const set = (await watching.action(watcher, 'afk', { targetSeat: 1, afk: true })).state;
  assert.equal(set.you.seat, null);
  assert.equal(set.you.host, true);
  assertAfkSnapshot(set);
  await watching.action(watcher, 'skip-afk', { revision: set.revision, turn: 0, phase: 'roll' }, 403);
  assert.equal((await watching.action(watcher, 'afk', { targetSeat: 1, afk: false })).state.players.find(player => player.id === red.state.you.id).afk, false);

  const ranked = await fixture(t, { randomDice: () => 1, gameFactory(players, options) {
    const g = createGame(players, options);
    g.pieces[0] = [FINISH, FINISH, FINISH, FINISH - 1];
    return g;
  } });
  const host = await ranked.create('完赛房主');
  await ranked.join(host, '红方'); await ranked.join(host, '黄方'); await ranked.join(host, '蓝方');
  await ranked.action(host, 'start');
  await ranked.action(host, 'roll');
  const arrived = (await ranked.action(host, 'move', { piece: 3 })).state;
  assert.equal(arrived.game.status, 'playing');
  assert.equal(arrived.game.players.find(player => player.seat === 0).rank, 1);
  const managed = (await ranked.action(host, 'afk', { targetSeat: 1, afk: true })).state;
  assertAfkSnapshot(managed);
  await ranked.action(host, 'afk', { targetSeat: 0, afk: true }, 409);
  await ranked.action(host, 'skip-afk', { revision: managed.revision, turn: 1, phase: 'roll' }, 409);
  assert.deepEqual((await ranked.state(host)).game, managed.game);
  assert.equal((await ranked.action(host, 'afk', { targetSeat: 1, afk: false })).state.game.players.find(player => player.seat === 1).afk, false);
});

test('afk: API roll skips preserve19 rolls without rolling or generating ice in either mode', async t => {
  for (const mode of ['classic', 'fun']) {
    const f = await fixture(t, { gameFactory(players, options) { const g = createGame(players, options); g.rollCount = 19; return g; } });
    const host = await f.create(), guest = await f.join(host);
    await f.action(host, 'capacity', { capacity: 2 });
    if (mode === 'fun') await f.action(host, 'mode', { mode });
    await f.action(host, 'start');
    const afk = (await f.action(host, 'afk', { targetSeat: 0, afk: true })).state;
    const skipped = (await f.action(guest, 'skip-afk', { revision: afk.revision, turn: 0, phase: 'roll', rollCount: 20, dice: 6 })).state;
    assert.equal(skipped.game.turn, 1);
    assert.equal(skipped.game.phase, 'roll');
    assert.equal(skipped.game.dice, null);
    assert.equal(skipped.game.rollCount, 19);
    assert.equal(skipped.game.iceCell, null);
    assert.deepEqual(afkRetained(skipped.game), afkRetained(afk.game));
    assert.equal(skipped.game.keyEvents.at(-1).type, 'AFK_SKIP');
    assertAfkSnapshot(skipped);
  }
});

test('afk: API move skips discard a pending second6 without altering prior move, cards or counts', async t => {
  for (const mode of ['classic', 'fun']) {
    const f = await fixture(t, { randomDice: () => 6, gameFactory(players, options) { const g = createGame(players, options); g.pieces[0][0] = 3; return g; } });
    const host = await f.create(), guest = await f.join(host);
    await f.action(host, 'capacity', { capacity: 2 });
    if (mode === 'fun') { await f.action(host, 'mode', { mode }); await f.action(host, 'rules', { rules: { items: true, alliances: true } }); }
    await f.action(host, 'start');
    await f.action(host, 'roll');
    await f.action(host, 'move', { piece: 0 });
    const pending = (await f.action(host, 'roll')).state;
    assert.equal(pending.game.sixes, 2);
    assert.equal(pending.game.phase, 'move');
    const afk = (await f.action(host, 'afk', { targetSeat: 0, afk: true })).state;
    await f.action(host, 'move', { piece: 0, automatic: true }, 409);
    const skipped = (await f.action(guest, 'skip-afk', { revision: afk.revision, turn: 0, phase: 'move' })).state;
    assert.equal(skipped.game.turn, 1);
    assert.equal(skipped.game.dice, null);
    assert.equal(skipped.game.sixes, 0);
    assert.deepEqual(skipped.game.legal, []);
    assert.deepEqual(afkRetained(skipped.game), afkRetained(afk.game));
    assert.equal(skipped.game.rollCount, 2);
  }
});

test('afk: concurrent same-revision skip requests advance the table exactly once', async t => {
  const f = await fixture(t);
  const host = await f.create(), red = await f.join(host), yellow = await f.join(host);
  await f.join(host);
  await f.action(host, 'start');
  const afk = (await f.action(host, 'afk', { targetSeat: 0, afk: true })).state;
  const replies = await Promise.all([red, yellow].map(async actor => {
    const response = await fetch(`${f.base}/api/rooms/${host.roomId}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: actor.token, type: 'skip-afk', revision: afk.revision, turn: 0, phase: 'roll' }) });
    return { status: response.status, body: await response.json() };
  }));
  assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 409]);
  const updated = await f.state(host);
  assert.equal(updated.game.turn, 1);
  assert.equal(updated.game.rollCount, 0);
  assert.equal(updated.game.keyEvents.filter(event => event.type === 'AFK_SKIP').length, 1);
  assert.equal(updated.revision, afk.revision + 1);
  assert.deepEqual(afkRetained(updated.game), afkRetained(afk.game));
});

test('afk: HTTP, SSE, refreshed connection and device takeover retain availability without exposing hands', async t => {
  const f = await fixture(t);
  const host = await f.create('原设备'), guest = await f.join(host, '对手');
  await f.action(host, 'capacity', { capacity: 2 });
  await f.action(host, 'mode', { mode: 'fun' });
  await f.action(host, 'rules', { rules: { items: true } });
  await f.action(host, 'start');
  const device = await f.join(host, '新设备');
  const hs = await f.events(host), gs = await f.events(guest), ds = await f.events(device);
  for (const stream of [hs, gs, ds]) await stream.next();
  const afk = (await f.action(host, 'afk', { targetSeat: 0, afk: true })).state;
  for (const stream of [hs, gs, ds]) {
    const synced = await stream.revision(afk.revision);
    assert.deepEqual(synced.game, afk.game);
    assertAfkSnapshot(synced);
    assert.equal(Object.hasOwn(synced.game, 'hands'), false);
  }
  const refreshed = await f.state(guest);
  assert.deepEqual(refreshed.game, afk.game);
  assertAfkSnapshot(refreshed);
  await gs.close();
  const reconnect = await f.events(guest);
  const restored = (await reconnect.next()).data;
  assert.deepEqual(restored.game, afk.game);
  assertAfkSnapshot(restored);
  const replaced = (await f.action(device, 'takeover', { code: afk.you.takeoverCode })).state;
  assert.deepEqual(replaced.game, afk.game);
  assert.deepEqual(replaced.you.hand, ['stun', 'mine', 'missile']);
  assertAfkSnapshot(replaced);
  for (const stream of [hs, reconnect, ds]) {
    const synced = await stream.revision(replaced.revision);
    assert.deepEqual(synced.game, afk.game);
    assertAfkSnapshot(synced);
    assert.equal(Object.hasOwn(synced.game, 'hands'), false);
  }
  const previous = await f.state(host);
  assert.equal(previous.you.seat, null);
  assert.equal(previous.players.find(player => player.id === previous.you.id).afk, false);
  assert.deepEqual(previous.you.hand, []);
  await f.action(host, 'afk', { targetSeat: 0, afk: false }, 403);
  const active = (await f.action(device, 'afk', { targetSeat: 0, afk: false })).state;
  assert.equal(active.game.players.find(player => player.seat === 0).afk, false);
  assert.equal(active.game.keyEvents.at(-1).type, 'AFK_OFF');
  assert.equal(active.game.deadline, afk.game.deadline);
  const shared = JSON.stringify({ game: active.game, players: active.players });
  for (const member of [host, guest, device]) assert.equal(shared.includes(member.token), false);
  assert.equal(shared.includes(afk.you.takeoverCode), false);
  assert.equal(shared.includes('"hands"'), false);
});

test('afk: the real timeout still moves an online AFK player and preserves its flag and frozen plane', async t => {
  const f = await fixture(t, { turnMs: 450, randomDice: () => 1, randomIndex: () => 0, gameFactory(players, options) {
    const g = createGame(players, options);
    g.pieces[0] = [5, 4, -1, -1];
    g.frozenPieces[0][0] = true;
    return g;
  } });
  const host = await f.create(), guest = await f.join(host);
  const hs = await f.events(host), gs = await f.events(guest);
  await hs.next(); await gs.next();
  await f.action(host, 'capacity', { capacity: 2 });
  await f.action(host, 'mode', { mode: 'fun' });
  await f.action(host, 'rules', { rules: { items: true } });
  const started = (await f.action(host, 'start')).state;
  const afk = (await f.action(host, 'afk', { targetSeat: 0, afk: true })).state;
  assert.equal(afk.game.deadline, started.game.deadline);
  let automatic;
  for (let i = 0; i < 12; i++) {
    const event = await hs.next();
    if (event?.type === 'state' && event.data.game?.lastMove?.seat === 0) { automatic = event.data; break; }
  }
  assert.ok(automatic, 'a trusted timeout bypasses AFK manual-action blocking');
  assert.equal(automatic.game.lastMove.piece, 1);
  assert.equal(automatic.game.pieces[0][0], 5);
  assert.equal(automatic.game.pieces[0][1], 5);
  assert.equal(automatic.game.frozenPieces[0][0], true);
  assert.equal(automatic.game.players.find(player => player.seat === 0).afk, true);
  assert.equal(automatic.game.rollCount, 1);
  assert.equal(automatic.game.turn, 1);
  assert.ok(automatic.game.keyEvents.some(event => event.type === 'AUTO_TURN'));
  assert.deepEqual(automatic.game.handCounts, afk.game.handCounts);
  assert.deepEqual(automatic.players.map(player => player.stats), afk.players.map(player => player.stats));
  assertAfkSnapshot(automatic);
  assert.equal(Object.hasOwn(automatic.game, 'hands'), false);
});

test('unlimited-sixes: four consecutive sixes stay synchronized and do not reset the item limit', async t => {
  for (const mode of ['classic', 'fun']) {
    let dice = 6;
    const f = await fixture(t, { randomDice: () => dice, gameFactory(players, options) {
      const g = createGame(players, options);
      g.pieces[0][0] = 3;
      return g;
    } });
    const host = await f.create(), guest = await f.join(host);
    const hs = await f.events(host), gs = await f.events(guest);
    await hs.next(); await gs.next();
    await f.action(host, 'capacity', { capacity: 2 });
    if (mode === 'fun') {
      await f.action(host, 'mode', { mode });
      await f.action(host, 'rules', { rules: { speed: false, trap: false, safe: false, lucky: false, ice: false, items: true } });
    }
    let current = (await f.action(host, 'start')).state;
    if (mode === 'fun') current = (await f.action(host, 'use-item', { card: 'mine', piece: 0 })).state;
    const itemMove = current.game.moveNumber;
    for (let count = 1; count <= 4; count++) {
      const rolled = (await f.action(host, 'roll')).state;
      assert.equal(rolled.game.turn, 0);
      assert.equal(rolled.game.phase, 'move');
      assert.equal(rolled.game.sixes, count);
      assert.equal(rolled.game.rollCount, count);
      assert.equal(rolled.game.moveNumber, itemMove + count - 1);
      current = (await f.action(host, 'move', { piece: 0 })).state;
      assert.equal(current.game.turn, 0, mode + ' keeps the same player after every six');
      assert.equal(current.game.phase, 'roll');
      assert.equal(current.game.moveNumber, itemMove + count);
      for (const stream of [hs, gs]) assert.deepEqual((await stream.revision(current.revision)).game, current.game);
      assert.ok(current.game.keyEvents.every(event => event.type !== 'TRIPLE_SIX'));
    }
    if (mode === 'fun') {
      const rejection = await f.action(host, 'use-item', { card: 'stun', targetSeat: 1, targetPiece: 0 }, 409);
      assert.match(rejection.error, /本轮已经使用/);
      const unchanged = await f.state(host);
      assert.deepEqual(unchanged.game, current.game);
      assert.deepEqual(unchanged.you.hand, ['stun', 'missile']);
      assert.equal(Object.hasOwn(unchanged.game, 'hands'), false);
    }
    await gs.close();
    const reconnect = await f.events(guest);
    assert.deepEqual((await reconnect.next()).data.game, current.game);
    dice = 2;
    await f.action(host, 'roll');
    const rotated = (await f.action(host, 'move', { piece: 0 })).state;
    assert.equal(rotated.game.turn, 1);
    assert.equal(rotated.game.sixes, 0);
  }
});
