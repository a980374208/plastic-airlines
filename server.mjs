import http from 'node:http';
import { isIP } from 'node:net';
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame, createStats, rollDice, movePiece, autoTurn, allianceAction, useItem, setAfk, skipAfk, useSkill, acceptRoll } from './engine.mjs';
import { GAME_MODES, DEFAULT_FUN_RULES, normalizeRules, CAPTAINS } from './board.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const BODY_LIMIT = 8 * 1024;
const ROOM_LIMIT = 100;
const SPECTATOR_LIMIT = 16;
const CLIENT_LIMIT = 2;
const IDLE_MS = 2 * 60 * 60 * 1000;
const CONNECT_GRACE_MS = 15_000;
const HOST_GRACE_MS = 30_000;
const TAKEOVER_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TAKEOVER_FAILURE_LIMIT = 5;
const TAKEOVER_WINDOW_MS = 60_000;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp',
};

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function displayName(value) {
  if (typeof value !== 'string') throw new RequestError(400, '请输入昵称');
  const name = Array.from(value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()).slice(0, 20).join('');
  if (!name) throw new RequestError(400, '请输入昵称');
  return name;
}

async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw new RequestError(415, '请使用 JSON 请求');
  }
  if (Number(req.headers['content-length']) > BODY_LIMIT) {
    req.resume();
    throw new RequestError(413, '请求内容过大');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new RequestError(413, '请求内容过大');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new RequestError(400, 'JSON 请求格式不正确'); }
}

function sendJson(res, status, value, head = false) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(head ? undefined : body);
}

export function createServer({ turnMs = 90_000, randomDice = () => randomInt(1, 7), randomIndex = randomInt, gameFactory = createGame, trustLoopbackProxy = false } = {}) {
  if (!Number.isFinite(turnMs) || turnMs <= 0) throw new Error('turnMs must be positive');
  const rooms = new Map();
  const limits = new Map();
  let closed = false;

  function limit(key, max, windowMs) {
    const now = Date.now();
    let entry = limits.get(key);
    if (!entry || now >= entry.until) { entry = { count: 0, until: now + windowMs }; limits.set(key, entry); }
    if (++entry.count > max) throw new RequestError(429, '操作太快，请稍后重试');
  }

  function authorize(room, token) {
    if (typeof token !== 'string' || token.length > 128) throw new RequestError(401, '房间凭证无效，请重新加入');
    const given = Buffer.from(token);
    for (const player of room.players) {
      const expected = Buffer.from(player.token);
      if (given.length === expected.length && timingSafeEqual(given, expected)) return player;
    }
    throw new RequestError(401, '房间凭证无效，请重新加入');
  }

  function newTakeoverCode(room, previous = null) {
    let code;
    do {
      code = Array.from(randomBytes(12), byte => TAKEOVER_ALPHABET[byte & 31]).join('');
    } while (code === previous || room.players.some(p => p.takeoverCode === code));
    return code;
  }

  function normalizeTakeoverCode(value) {
    if (typeof value !== 'string' || value.length > 32) return null;
    const trimmed = value.trim().toUpperCase();
    if (!/^(?:[0-9A-HJKMNP-TV-Z]{12}|[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){2})$/.test(trimmed)) return null;
    return trimmed.replaceAll('-', '');
  }

  function takeover(room, player, code, ip) {
    if (room.game?.status !== 'playing') throw new RequestError(409, '只有进行中的对局可以接管角色');
    if (player.seat !== null) throw new RequestError(403, '请先以观战者身份加入再接管角色');
    const keys = [`takeover:${room.id}:${player.id}`, `takeover-ip:${room.id}:${ip}`];
    const now = Date.now();
    if (keys.some(key => {
      const entry = limits.get(key);
      return entry && entry.until > now && entry.count >= TAKEOVER_FAILURE_LIMIT;
    })) throw new RequestError(429, '接管码尝试次数过多，请一分钟后重试');
    const normalized = normalizeTakeoverCode(code);
    const given = normalized && Buffer.from(normalized);
    const owner = given && room.players.find(p => {
      if (p.seat === null || !room.game.active.includes(p.seat) || !p.takeoverCode) return false;
      const expected = Buffer.from(p.takeoverCode);
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
    if (!owner) {
      for (const key of keys) limit(key, TAKEOVER_FAILURE_LIMIT, TAKEOVER_WINDOW_MS);
      throw new RequestError(403, '接管码无效或已失效，请确认后重试');
    }
    if (room.game.players.find(result => result.seat === owner.seat)?.rank != null) {
      throw new RequestError(409, '该角色已经完成比赛，无需接管');
    }
    const replacementCode = newTakeoverCode(room, owner.takeoverCode);
    player.seat = owner.seat;
    player.captain = room.game.captains?.[owner.seat]?.key ?? owner.captain;
    player.takeoverCode = replacementCode;
    owner.seat = null;
    owner.captain = null;
    owner.takeoverCode = null;
    if (room.hostId === owner.id) {
      clearTimeout(room.hostGraceTimer);
      room.hostGraceTimer = null;
      room.hostId = player.id;
    }
    for (const res of owner.clients) writeEvent(res, 'role-replaced', { message: '你的角色已由其他设备接管，当前已转为观战' });
  }

  function snapshot(room, player) {
    const host = room.hostId === player.id && room.players.includes(player);
    // Results belong to the seat, so a replacement receives the same statistics.
    for (const member of room.players) {
      const result = room.game?.players.find(entry => entry.seat === member.seat);
      member.stats = result ? { ...result.stats } : createStats();
      member.rank = result?.rank ?? null;
      member.afk = result?.afk === true;
    }
    const game = room.game ? structuredClone(room.game) : null;
    if (game) {
      game.handCounts = game.hands.map(hand => hand.length);
      delete game.hands;
    }
    return {
      id: room.id, hostId: room.hostId, capacity: room.capacity, mode: room.mode, rules: { ...room.rules },
      players: room.players.map(({ id, name, seat, online, stats, rank, afk, captain }) => ({ id, name, seat, online, stats: { ...stats }, rank, afk, captain })),
      game,
      you: {
        id: player.id, seat: player.seat, host, takeoverCode: player.takeoverCode,
        hand: room.game && player.seat !== null ? [...room.game.hands[player.seat]] : [],
        ...(host ? { takeoverCodes: room.players.map(p => ({ id: p.id, code: p.takeoverCode })) } : {}),
      },
      revision: room.revision,
    };
  }

  function writeEvent(res, type, data, revision) {
    if (res.destroyed || res.writableEnded) return;
    if (res.writableLength > 256 * 1024) { res.destroy(); return; }
    res.write(`${revision === undefined ? '' : `id: ${revision}\n`}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function broadcast(room) {
    room.revision++;
    for (const player of room.players) {
      const state = snapshot(room, player);
      for (const res of player.clients) writeEvent(res, 'state', state, room.revision);
    }
  }

  function transferHost(room) {
    clearTimeout(room.hostGraceTimer);
    room.hostGraceTimer = null;
    const host = room.players.find(p => p.id === room.hostId);
    if (host?.online) return;
    const next = room.players.find(p => p.online && p.seat !== null) || room.players.find(p => p.online);
    if (next) room.hostId = next.id;
  }

  function scheduleHostTransfer(room) {
    const host = room.players.find(p => p.id === room.hostId);
    if (host?.online || room.hostGraceTimer) return;
    if (!host) { transferHost(room); return; }
    room.hostGraceTimer = setTimeout(() => {
      room.hostGraceTimer = null;
      if (closed || !rooms.has(room.id)) return;
      const previous = room.hostId;
      transferHost(room);
      if (room.hostId !== previous) broadcast(room);
    }, HOST_GRACE_MS);
    room.hostGraceTimer.unref();
  }

  function markOffline(room, player) {
    if (!player.online || !rooms.has(room.id) || !room.players.includes(player)) return;
    player.online = false;
    scheduleHostTransfer(room);
    broadcast(room);
  }

  function removeRoom(room, reason) {
    clearTimeout(room.turnTimer);
    clearTimeout(room.hostGraceTimer);
    rooms.delete(room.id);
    for (const player of room.players) {
      clearTimeout(player.presenceTimer);
      for (const res of player.clients) {
        writeEvent(res, 'gone', { message: reason });
        res.end();
      }
    }
  }

  function scheduleTurn(room) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
    if (!room.game || room.game.status !== 'playing') {
      if (room.game) room.game.deadline = null;
      return;
    }
    room.game.deadline = Date.now() + turnMs;
    room.turnTimer = setTimeout(() => {
      if (closed || !rooms.has(room.id) || room.game?.status !== 'playing') return;
      try {
        autoTurn(room.game, randomDice(), randomIndex);
        scheduleTurn(room);
        broadcast(room);
      } catch (error) {
        console.error('自动回合失败:', error.message);
        room.game.deadline = null;
        broadcast(room);
      }
    }, turnMs);
    room.turnTimer.unref();
  }

  function addPlayer(room, name) {
    const seat = [0, 1, 2, 3].find(n => !room.players.some(p => p.seat === n));
    const canSeat = !room.game && seat !== undefined;
    if (!canSeat && room.players.filter(p => p.seat === null).length >= SPECTATOR_LIMIT) {
      throw new RequestError(409, '观战人数已满');
    }
    const player = { id: randomUUID(), name: displayName(name), token: randomBytes(32).toString('base64url'), seat: canSeat ? seat : null, takeoverCode: canSeat ? newTakeoverCode(room) : null, captain: null, stats: createStats(), rank: null, online: true, clients: new Set(), presenceTimer: null };
    room.players.push(player);
    player.presenceTimer = setTimeout(() => {
      player.presenceTimer = null;
      if (!player.clients.size) markOffline(room, player);
    }, CONNECT_GRACE_MS);
    player.presenceTimer.unref();
    room.lastActivity = Date.now();
    return player;
  }

  function requireHost(room, player) {
    if (room.hostId !== player.id) throw new RequestError(403, '只有房主可以进行此操作');
  }

  function requireLobby(room) {
    if (room.game) throw new RequestError(409, '游戏期间不能更换座位');
  }

  function disconnectPlayer(player, message) {
    clearTimeout(player.presenceTimer);
    player.presenceTimer = null;
    player.online = false;
    for (const res of player.clients) {
      writeEvent(res, 'gone', { message });
      res.end();
    }
    player.clients.clear();
  }

  function act(room, player, body, ip) {
    limit(`action:${room.id}:${player.id}`, 20, 10_000);
    switch (body.type) {
      case 'seat': {
        requireLobby(room);
        if (!Number.isInteger(body.seat) || body.seat < 0 || body.seat > 3) throw new RequestError(400, '座位无效');
        if (room.players.some(p => p.id !== player.id && p.seat === body.seat)) throw new RequestError(409, '该座位已有人');
        if (player.seat !== body.seat) {
          player.takeoverCode = newTakeoverCode(room, player.takeoverCode);
          player.seat = body.seat;
        }
        break;
      }
      case 'spectate':
        requireLobby(room);
        if (player.seat !== null && room.players.filter(p => p.seat === null).length >= SPECTATOR_LIMIT) throw new RequestError(409, '观战人数已满');
        player.seat = null;
        player.captain = null;
        player.takeoverCode = null;
        break;
      case 'takeover':
        takeover(room, player, body.code, ip);
        break;
      case 'mode':
        requireHost(room, player);
        if (room.game) throw new RequestError(409, '对局开始后不能切换模式');
        if (!GAME_MODES.includes(body.mode)) throw new RequestError(400, '模式必须是经典或趣味');
        room.mode = body.mode;
        break;
      case 'rules':
        requireHost(room, player);
        requireLobby(room);
        if (room.mode !== 'fun') throw new RequestError(409, '请先切换到趣味模式再设置规则');
        if (!body.rules || typeof body.rules !== 'object' || Array.isArray(body.rules)) throw new RequestError(400, '规则设置格式无效');
        try { room.rules = normalizeRules('fun', { ...room.rules, ...body.rules }); }
        catch (error) { throw new RequestError(400, error.message); }
        break;
      case 'captain':
        requireLobby(room);
        if (room.mode !== 'fun' || !room.rules.captains) throw new RequestError(409, '请先开启机长技能');
        if (player.seat === null) throw new RequestError(403, '观战玩家不能选择机长');
        if (!CAPTAINS.some(captain => captain.key === body.captain)) throw new RequestError(400, '机长无效');
        player.captain = body.captain;
        break;
      case 'capacity':
        requireHost(room, player);
        requireLobby(room);
        if (![2, 3, 4].includes(body.capacity)) throw new RequestError(400, '人数必须是 2、3 或 4');
        room.capacity = body.capacity;
        break;
      case 'kick': {
        requireHost(room, player);
        if (room.game) throw new RequestError(409, '对局开始后不能踢人，请先结束对局');
        if (typeof body.playerId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(body.playerId)) throw new RequestError(400, '玩家无效');
        if (body.playerId === player.id) throw new RequestError(400, '房主不能踢出自己，请使用离开房间');
        const target = room.players.find(p => p.id === body.playerId);
        if (!target) throw new RequestError(404, '该玩家已离开房间');
        room.players = room.players.filter(p => p !== target);
        disconnectPlayer(target, '你已被房主移出房间');
        break;
      }
      case 'start': {
        requireHost(room, player);
        requireLobby(room);
        const seated = room.players.filter(p => p.seat !== null);
        if (seated.length !== room.capacity) throw new RequestError(409, `需要 ${room.capacity} 位玩家入座才能开始`);
        if (seated.some(p => !p.online)) throw new RequestError(409, '请等待所有玩家上线');
        if (room.mode === 'fun' && room.rules.captains && seated.some(p => !CAPTAINS.some(captain => captain.key === p.captain))) {
          throw new RequestError(409, '请等待每位入座玩家选择机长');
        }
        room.game = gameFactory(seated, { mode: room.mode, rules: room.rules });
        scheduleTurn(room);
        break;
      }
      case 'roll':
        if (!room.game) throw new RequestError(409, '游戏尚未开始');
        if (player.seat === null) throw new RequestError(403, '观战玩家不能掷骰子');
        rollDice(room.game, player.seat, randomDice(), randomIndex);
        scheduleTurn(room);
        break;
      case 'move':
        if (!room.game) throw new RequestError(409, '游戏尚未开始');
        if (player.seat === null) throw new RequestError(403, '观战玩家不能移动棋子');
        if (!Number.isInteger(body.piece) || body.piece < 0 || body.piece > 3) throw new RequestError(400, '棋子无效');
        movePiece(room.game, player.seat, body.piece, randomIndex);
        scheduleTurn(room);
        break;
      case 'afk':
        if (!room.game) throw new RequestError(409, '游戏尚未开始');
        if (room.hostId !== player.id) {
          if (player.seat === null) throw new RequestError(403, '观战玩家不能设置挂机');
          if (body.targetSeat !== player.seat) throw new RequestError(403, '只有房主可以设置其他玩家挂机');
        }
        setAfk(room.game, body.targetSeat, body.afk);
        // Changing availability must not extend the existing phase deadline.
        break;
      case 'skip-afk':
        if (!room.game) throw new RequestError(409, '游戏尚未开始');
        if (player.seat === null) throw new RequestError(403, '观战玩家不能跳过挂机阶段');
        if (!Number.isInteger(body.revision) || body.revision !== room.revision) throw new RequestError(409, '房间状态已改变，请等待最新状态');
        skipAfk(room.game, player.seat, body.turn, body.phase);
        scheduleTurn(room);
        break;
      case 'alliance-invite':
      case 'alliance-accept':
      case 'alliance-decline':
      case 'alliance-cancel':
      case 'alliance-betray':
        if (!room.game) throw new RequestError(409, '游戏尚未开始');
        if (player.seat === null) throw new RequestError(403, '观战玩家不能结盟或背叛');
        allianceAction(room.game, player.seat, body.type, body.targetSeat, randomIndex);
        break;
      case 'use-item':
        if (!room.game) throw new RequestError(409, '游戏尚未开始');
        if (player.seat === null) throw new RequestError(403, '观战玩家不能使用道具');
        useItem(room.game, player.seat, body, randomIndex);
        // Cards and alliance messages share the existing deadline, preventing
        // repeated side actions from extending the turn indefinitely.
        break;
      case 'use-skill':
      case 'accept-roll': {
        if (!room.game) throw new RequestError(409, '游戏尚未开始');
        if (player.seat === null) throw new RequestError(403, '观战玩家不能使用机长技能');
        if (!Number.isInteger(body.revision) || body.revision !== room.revision || body.turn !== room.game.turn || body.phase !== room.game.phase) {
          throw new RequestError(409, '回合阶段已改变，请等待最新状态');
        }
        const previousTurn = room.game.turn, previousPhase = room.game.phase;
        if (body.type === 'use-skill') useSkill(room.game, player.seat, body, randomDice, randomIndex);
        else acceptRoll(room.game, player.seat);
        // Side actions share the deadline. Only accepting an unplayable roll
        // or rerolling into a new turn schedules the next player's timer.
        if (room.game.turn !== previousTurn || room.game.phase !== previousPhase) scheduleTurn(room);
        break;
      }
      case 'end':
        requireHost(room, player);
        room.game = null;
        clearTimeout(room.turnTimer);
        room.turnTimer = null;
        break;
      case 'leave': {
        disconnectPlayer(player, '你已离开房间');
        if (!room.game || player.seat === null) room.players = room.players.filter(p => p !== player);
        transferHost(room);
        if (room.players.length === 0) removeRoom(room, '房间已关闭');
        break;
      }
      default: throw new RequestError(400, '未知操作');
    }
    room.lastActivity = Date.now();
    broadcast(room);
  }

  async function serveStatic(req, res, pathname) {
    if (!['GET', 'HEAD'].includes(req.method)) throw new RequestError(405, '不支持此请求方式');
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { throw new RequestError(400, '路径格式不正确'); }
    if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some(part => part.startsWith('.'))) throw new RequestError(404, '页面不存在');
    let filename;
    if (decoded === '/board.mjs') filename = path.join(ROOT, 'board.mjs');
    else {
      filename = path.resolve(PUBLIC, `.${decoded === '/' ? '/index.html' : decoded}`);
      if (!filename.startsWith(PUBLIC + path.sep)) throw new RequestError(404, '页面不存在');
    }
    try {
      const actual = await realpath(filename);
      if (decoded !== '/board.mjs' && !actual.startsWith((await realpath(PUBLIC)) + path.sep)) throw new RequestError(404, '页面不存在');
      const info = await stat(actual);
      if (!info.isFile()) throw new RequestError(404, '页面不存在');
      const body = req.method === 'HEAD' ? undefined : await readFile(actual);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(actual)] || 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch (error) {
      if (error.status) throw error;
      if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw new RequestError(404, '页面不存在');
      throw error;
    }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      if (pathname === '/health' && ['GET', 'HEAD'].includes(req.method)) {
        sendJson(res, 200, { ok: true, rooms: rooms.size }, req.method === 'HEAD');
        return;
      }
      if (!pathname.startsWith('/api/')) { await serveStatic(req, res, pathname); return; }
      res.setHeader('Cache-Control', 'no-store');
      const remoteIp = req.socket.remoteAddress || 'unknown';
      const realIp = req.headers['x-real-ip'];
      const localProxy = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteIp);
      const ip = trustLoopbackProxy === true && localProxy && typeof realIp === 'string' && isIP(realIp)
        ? realIp : remoteIp;
      limit(`ip:${ip}`, 240, 60_000);
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin) {
          let parsed;
          try { parsed = new URL(origin); } catch { throw new RequestError(403, '请求来源无效'); }
          if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host !== req.headers.host || parsed.origin !== origin) throw new RequestError(403, '不允许跨站操作');
        } else if (req.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, '不允许跨站操作');
      }
      if (pathname === '/api/rooms' && req.method === 'POST') {
        limit(`create:${ip}`, 12, 60_000);
        const body = await readBody(req);
        if (rooms.size >= ROOM_LIMIT) throw new RequestError(503, '房间已满，请稍后再试');
        let id;
        do { id = randomBytes(3).toString('hex'); } while (rooms.has(id));
        const room = { id, hostId: null, capacity: 4, mode: 'classic', rules: { ...DEFAULT_FUN_RULES }, players: [], game: null, revision: 0, lastActivity: Date.now(), turnTimer: null, hostGraceTimer: null };
        const player = addPlayer(room, body.name);
        room.hostId = player.id;
        rooms.set(id, room);
        broadcast(room);
        sendJson(res, 201, { roomId: id, token: player.token, state: snapshot(room, player) });
        return;
      }
      const match = /^\/api\/rooms\/([a-f0-9]{6})(?:\/(join|events|action))?$/.exec(pathname);
      if (!match) throw new RequestError(404, '接口不存在');
      const room = rooms.get(match[1]);
      if (!room) throw new RequestError(404, '房间不存在或已过期');
      const route = match[2];
      if (route === 'join' && req.method === 'POST') {
        limit(`join:${ip}`, 30, 60_000);
        const body = await readBody(req);
        const player = addPlayer(room, body.name);
        scheduleHostTransfer(room);
        broadcast(room);
        sendJson(res, 200, { roomId: room.id, token: player.token, state: snapshot(room, player) });
        return;
      }
      if (route === 'action' && req.method === 'POST') {
        const body = await readBody(req);
        const player = authorize(room, body.token);
        try { act(room, player, body, ip); } catch (error) {
          if (error.status) throw error;
          throw new RequestError(409, error.message);
        }
        sendJson(res, 200, { state: snapshot(room, player) });
        return;
      }
      if ((!route || route === 'events') && req.method === 'GET') {
        const player = authorize(room, url.searchParams.get('token'));
        room.lastActivity = Date.now();
        if (!route) { sendJson(res, 200, snapshot(room, player)); return; }
        if (player.clients.size >= CLIENT_LIMIT) throw new RequestError(429, '此玩家的连接数量已达上限');
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        clearTimeout(player.presenceTimer);
        player.presenceTimer = null;
        if (room.hostId === player.id) {
          clearTimeout(room.hostGraceTimer);
          room.hostGraceTimer = null;
        }
        player.clients.add(res);
        const wasOnline = player.online;
        player.online = true;
        if (!wasOnline) broadcast(room);
        else writeEvent(res, 'state', snapshot(room, player), room.revision);
        req.on('close', () => {
          if (!player.clients.delete(res) || closed || !rooms.has(room.id)) return;
          if (player.clients.size === 0 && player.online) {
            markOffline(room, player);
          }
        });
        return;
      }
      throw new RequestError(405, '不支持此请求方式');
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error.status || 500;
      if (status === 500) console.error('请求失败:', error.message);
      sendJson(res, status, { error: status === 500 ? '服务器暂时无法处理请求' : error.message });
    }
  });

  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (now - room.lastActivity > IDLE_MS) { removeRoom(room, '房间长时间无人活动，已关闭'); continue; }
      for (const player of room.players) for (const res of player.clients) {
        if (res.writableLength > 256 * 1024) res.destroy();
        else res.write(': heartbeat\n\n');
      }
    }
    for (const [key, entry] of limits) if (entry.until < now) limits.delete(key);
  }, 15_000);
  heartbeat.unref();
  const originalClose = server.close.bind(server);
  server.close = function (callback) {
    closed = true;
    clearInterval(heartbeat);
    for (const room of rooms.values()) removeRoom(room, '服务器正在重启，请稍后重新加入');
    return originalClose(callback);
  };
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createServer({ trustLoopbackProxy: process.env.TRUST_LOOPBACK_PROXY === '1' });
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '0.0.0.0';
  server.listen(port, host, () => {
    console.log(`\n========================================`);
    console.log(`✈ 飞行棋服务已成功启动！请在浏览器中打开：`);
    console.log(`  > 本地访问: http://localhost:${port}/`);
    console.log(`  > 本机回环: http://127.0.0.1:${port}/`);
    console.log(`========================================\n`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
