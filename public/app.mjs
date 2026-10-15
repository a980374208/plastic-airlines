import { COLORS, CAPTAINS, FINISH, TAKEOFF, STARTS, specialCellAt, normalizeRules } from '/board.mjs';
import { VIEW_SIZE, visualPositionFor, visualHeadingFor, visualSpaceFor, renderBoardBase } from '/board-view.mjs';

if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(registrations => {
    for (const reg of registrations) reg.unregister();
  }).catch(() => {});
}

const $ = (id) => document.getElementById(id);
const SESSION_KEY = 'fly-together-session';
const NAME_KEY = 'fly-together-name';
const SOUND_KEY = 'fly-together-sound';
const TURN_SOUND_KEY = 'fly-together-turn-sound';
const PIECE_SKIN_KEY = 'fly-together-piece-skin';
const BOARD_SKIN_KEY = 'fly-together-board-skin';
const UNIT = 40;
const SIZE = VIEW_SIZE;
const icon = (name, extra = '') => `<svg class="icon ${extra}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const RULE_NAMES = { speed: '加速 +2', trap: '陷阱 −3', safe: '安全岛', lucky: '幸运 ±1～3', ice: '随机冰冻', captureEffects: '台词与动画', alliances: '结盟与背叛', items: '三张道具卡', captains: '机长技能' };
const CARD_NAMES = { stun: '定身', mine: '地雷', missile: '导弹', hunt: '追杀' };
const KEY_EVENT_NAMES = { START: '开局', CAPTURE: '撞飞', WALL_BREAK: '破墙', WALL_BOUNCE: '反弹', MINE_HIT: '踩雷', SPEED: '加速', TRAP: '陷阱', SAFE: '安全岛', LUCKY: '幸运', FROZEN: '冰冻', THAWED: '解冻', ICE_GENERATED: '冰冻格', AMBUSH: '伏击', STUN: '定身', MINE_SET: '布雷', MISSILE: '导弹', ALLIANCE_INVITE: '邀请结盟', ALLIANCE_ACCEPT: '接受结盟', ALLIANCE_DECLINE: '拒绝结盟', ALLIANCE_CANCEL: '撤回邀请', BETRAYAL: '背叛', ARRIVAL: '抵达', RANK: '名次', FINISH: '结算', AUTO_TURN: '超时托管', AFK_ON: '挂机', AFK_OFF: '取消挂机', AFK_SKIP: '跳过阶段' };
Object.assign(KEY_EVENT_NAMES, { SKILL_FLASH: '闪现', SHIELD_SET: '护盾', SHIELD_BLOCK: '护盾抵挡', ALLY_SWAP: '盟友交换', REVENGE_MARK: '复仇锁定', REVENGE_CHASE: '复仇追击', REVENGE_REWARD: '复仇奖励', REROLL: '赌徒重掷', ITEM_STOLEN: '偷取道具', ITEM_DRAWN: '抽取道具', BETRAYAL_VICTIM: '遭背叛', HUNT_SET: '追杀锁定', HUNT_EXECUTE: '追杀成功', HUNT: '追杀', HUNT_FAILED: '追杀落空', BOUNTY_REWARD: '悬赏奖励' });

const PIECE_SKINS = Object.freeze([
  {
    id: 'classic',
    name: '经典客机',
    tag: '默认',
    type: 'vector',
    desc: '标准民航客机，巡航姿态平稳耐看',
    matchingBoardId: 'classic',
    path: 'M0-10 2.1-3.2 8 2.1V4L2 2.7 1.4 7 4 8.2V9.5L0 8.5-4 9.5V8.2L-1.4 7-2 2.7-8 4V2.1L-2.1-3.2Z'
  },
  {
    id: 'toon_planes',
    name: '经典飞行器',
    tag: '图2卡通',
    type: 'sprite',
    headingOffsets: [90, 90, 90, 90],
    desc: '红黄蓝绿萌趣卡通螺旋桨战机，童年回忆',
    matchingBoardId: 'toon_board'
  },
  {
    id: 'scifi_space',
    name: '科幻太空',
    tag: '图2科幻',
    type: 'sprite',
    headingOffsets: [135, 135, 135, 135],
    desc: '等离子尾焰与超空间穿梭机，未来科技战阵',
    matchingBoardId: 'scifi_board'
  },
  {
    id: 'mythic_beasts',
    name: '幻想生物',
    tag: '图2奇幻',
    type: 'sprite',
    headingOffsets: [0, 0, 0, 0],
    desc: '小火龙、金狮鹫、火凤凰、小翡翠萌龙神兽战队',
    matchingBoardId: 'mythic_board'
  },
  {
    id: 'steampunk',
    name: '蒸汽朋克',
    tag: '图2复古',
    type: 'sprite',
    headingOffsets: [120, 120, 120, 120],
    desc: '黄铜齿轮与烟囱蒸汽驱动，复古重工业浪漫',
    matchingBoardId: 'steampunk_board'
  },
  {
    id: 'chibi_spirits',
    name: '星际萌宠',
    tag: '图3Q萌',
    type: 'sprite',
    headingOffsets: [0, 0, 0, 0],
    desc: '大眼汪汪的四色星球小精灵，治愈系Q萌化身',
    matchingBoardId: 'chibi_board'
  },
  {
    id: 'toy_world',
    name: '玩具世界',
    tag: '图4趣味',
    type: 'sprite',
    headingOffsets: [115, 130, 90, 115],
    desc: '积木飞机、发条小黄鸭、折纸飞机与像素直升机',
    matchingBoardId: 'toy_board'
  },
  {
    id: 'ocean_odyssey',
    name: '海洋奇缘',
    tag: '图4海洋',
    type: 'sprite',
    headingOffsets: [0, 90, 0, 0],
    desc: '红色飞鱼、黄金海马、旋翼章鱼与呆萌小海龟',
    matchingBoardId: 'ocean_board'
  }
]);

const BOARD_SKINS = Object.freeze([
  {
    id: 'classic',
    name: '经典深空',
    tag: '默认',
    desc: '深邃夜空底色，熟悉耐看的经典四色棋盘',
    colors: ['#10d795', '#ff514b', '#ffd42a', '#12afe1'],
    bg: '#0c1d40'
  },
  {
    id: 'toon_board',
    name: '童趣晴空',
    tag: '卡通搭配',
    desc: '明媚晴空与清爽跑道，搭配经典飞行器最佳',
    colors: ['#2ed573', '#ff4757', '#ffa502', '#1e90ff'],
    bg: '#0f2c4f'
  },
  {
    id: 'scifi_board',
    name: '深空星轨',
    tag: '科幻搭配',
    desc: '赛博霓虹星轨矩阵，搭配科幻太空战机最佳',
    colors: ['#00ff88', '#ff006e', '#ffe600', '#00f0ff'],
    bg: '#080a18'
  },
  {
    id: 'mythic_board',
    name: '龙域仙境',
    tag: '奇幻搭配',
    desc: '幽秘神殿与魔法光辉，搭配幻想生物神兽最佳',
    colors: ['#2bcbba', '#eb3b5a', '#f7b731', '#45aaf2'],
    bg: '#141d1a'
  },
  {
    id: 'steampunk_board',
    name: '齿轮工坊',
    tag: '蒸汽搭配',
    desc: '古铜金与机械仪表底色，搭配蒸汽朋克最佳',
    colors: ['#40826d', '#b84a39', '#d4a343', '#3b6978'],
    bg: '#1b1613'
  },
  {
    id: 'chibi_board',
    name: '萌宠梦境',
    tag: 'Q萌搭配',
    desc: '柔和马卡龙梦幻色系，搭配星际萌宠最佳',
    colors: ['#26de81', '#fc5c65', '#fed330', '#45aaf2'],
    bg: '#181b33'
  },
  {
    id: 'toy_board',
    name: '积木乐园',
    tag: '玩具搭配',
    desc: '鲜艳纯真童心积木调色，搭配玩具世界最佳',
    colors: ['#20bf6b', '#eb3b5a', '#f7b731', '#3867d6'],
    bg: '#121f38'
  },
  {
    id: 'ocean_board',
    name: '蔚蓝深海',
    tag: '海洋搭配',
    desc: '水波荡漾与珊瑚海流，搭配海洋奇缘最佳',
    colors: ['#05c46b', '#ff5e57', '#ffc048', '#0fbcf9'],
    bg: '#081c30'
  }
]);

let currentPieceSkin = 'classic';
let currentBoardSkin = 'classic';
let skinDialogTab = 'piece';

let state = null;
let session = null;
let stream = null;
let connected = false;
let busy = false;
let leaving = false;
let lastRevision = -1;
let seatsKey = '';
let boardKey = '';
let logKey = '';
let keyEventsKey = '';
let keyEventsRoom = '';
let keyEventsView = { id: null, offset: 0, scrollTop: 0 };
let toastTimer;
let dialogAction;
let soundEnabled = false;
let turnSoundEnabled = false;
let audioContext;
let diceRolling = false;
let diceTarget = null;
let diceStartedAt = 0;
let diceFaceTimer;
let diceFinishTimer;
let roleDialogMode = null;
let hostListKey = '';
let hostControlsRevoked = false;
let kickConfirmation = null;
let captureMoveId = null;
let captureTimer;
let betrayalConfirmation = null;

function readStorage(storage, key, fallback = '') {
  try { return storage.getItem(key) ?? fallback; } catch { return fallback; }
}
function writeStorage(storage, key, value) {
  try { value === null ? storage.removeItem(key) : storage.setItem(key, value); } catch { /* Private browsing can disable storage. */ }
}
function notify(message, duration = 3500) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, duration);
}
function setEntryError(message = '') {
  $('entry-error').textContent = message;
  $('entry-error').hidden = !message;
}
function playSound(kind = 'roll') {
  if (!soundEnabled) return;
  try {
    audioContext ??= new (window.AudioContext || window.webkitAudioContext)();
    audioContext.resume().catch(() => {});
    const notes = kind === 'win' ? [523, 659, 784, 1047] : kind === 'move' ? [660, 880] : [330, 440, 520];
    notes.forEach((frequency, index) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const start = audioContext.currentTime + index * .075;
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(.045, start + .01);
      gain.gain.exponentialRampToValueAtTime(.001, start + .13);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(start);
      oscillator.stop(start + .14);
    });
  } catch { /* Audio is optional and never blocks game actions. */ }
}
function syncSoundButton() {
  $('sound-toggle').innerHTML = icon(soundEnabled ? 'volume' : 'mute');
  $('sound-toggle').title = soundEnabled ? '关闭音效' : '开启音效';
  $('sound-toggle').setAttribute('aria-label', $('sound-toggle').title);
  $('sound-toggle').setAttribute('aria-pressed', String(soundEnabled));
}
function playTurnSound() {
  if (!turnSoundEnabled) return;
  try {
    audioContext ??= new (window.AudioContext || window.webkitAudioContext)();
    audioContext.resume().catch(() => {});
    const notes = [587.33, 880];
    notes.forEach((frequency, index) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const start = audioContext.currentTime + index * 0.11;
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.09, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.28);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.29);
    });
  } catch { /* Audio is optional and never blocks game actions. */ }
}
function syncTurnSound() {
  const toggle = $('turn-sound-toggle');
  if (toggle) {
    toggle.innerHTML = `<svg class="icon"><use href="#${turnSoundEnabled ? 'i-bell' : 'i-bell-off'}"/></svg>`;
    toggle.title = turnSoundEnabled ? '关闭掷骰提示音' : '开启掷骰提示音';
    toggle.setAttribute('aria-label', toggle.title);
    toggle.setAttribute('aria-pressed', String(turnSoundEnabled));
    toggle.classList.toggle('is-active', turnSoundEnabled);
  }
  const chip = $('turn-sound-chip');
  if (chip) {
    chip.textContent = `提示音: ${turnSoundEnabled ? '开' : '关'}`;
    chip.title = turnSoundEnabled ? '关闭轮到自己掷骰提示音' : '开启轮到自己掷骰提示音';
    chip.classList.toggle('is-active', turnSoundEnabled);
  }
}
function toggleTurnSound() {
  turnSoundEnabled = !turnSoundEnabled;
  writeStorage(localStorage, TURN_SOUND_KEY, String(turnSoundEnabled));
  syncTurnSound();
  if (turnSoundEnabled) {
    playTurnSound();
    notify('已开启轮到自己掷骰提示音');
  } else {
    notify('已关闭掷骰提示音');
  }
}
async function request(path, body) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
    signal: AbortSignal.timeout(15000)
  });
  let data;
  try { data = await response.json(); } catch { throw new Error('服务暂时无法响应，请稍后重试。'); }
  if (!response.ok) {
    const error = new Error(data.error || '操作没有成功，请重试。');
    error.status = response.status;
    throw error;
  }
  return data;
}
function extractedState(data) {
  const candidate = data?.state ?? data;
  return candidate?.you && candidate?.players ? candidate : null;
}
function currentPlayer(seat) { return state?.players.find((player) => player.seat === seat); }
function selectedRules() { return normalizeRules(state?.game?.mode ?? state?.mode ?? 'classic', state?.game?.rules ?? state?.rules ?? {}); }
function seatName(seat) { return currentPlayer(seat)?.name ?? `${COLORS[seat]?.name ?? ''}方`; }
function enabledSpecial(index) { const type = specialCellAt(index); return type && selectedRules()[type] ? type : null; }
function gamePlayer(seat) { return state?.game?.players?.find((player) => player.seat === seat) ?? currentPlayer(seat); }
function playerRank(seat) {
  const rank = gamePlayer(seat)?.rank;
  return Number.isInteger(rank) && rank > 0 ? rank : null;
}
function playerAfk(seat) { return gamePlayer(seat)?.afk === true; }
function captainState(seat) { return state?.game?.captains?.[seat] ?? null; }
function captainInfo(seat) { return CAPTAINS.find(captain => captain.key === (captainState(seat)?.key ?? currentPlayer(seat)?.captain)) ?? null; }
function unfinishedParticipant(seat) { return isPlaying() && state.game.active.includes(seat) && !playerRank(seat); }
function canSetAfk(seat) { return unfinishedParticipant(seat) && (seat === state.you.seat || canManageRoom()); }
function canSkipAfk() { return activeParticipant() && state.you.seat !== state.game.turn && unfinishedParticipant(state.game.turn) && playerAfk(state.game.turn); }
function statSeats(seat) {
  const active = [...(state.game?.active ?? state.players.filter(player => player.seat !== null).map(player => player.seat))].filter(value => Number.isInteger(value) && COLORS[value]).sort((a, b) => a - b);
  return active.includes(seat) ? [seat, ...active.filter(value => value !== seat)] : active;
}
function statsMarkup(seat, extra = '') {
  const stats = gamePlayer(seat)?.stats ?? {};
  return `<span class="player-stats ${extra}" aria-label="本局踩次数">${statSeats(seat).map(other => {
    const color = COLORS[other];
    const count = Number.isInteger(stats[color.key]) && stats[color.key] >= 0 ? stats[color.key] : 0;
    const label = other === seat ? `${color.name}色，自爆回家 ${count} 次` : `撞飞${color.name}色飞机 ${count} 次`;
    return `<span class="player-stat" data-color="${color.key}" title="${label}" aria-label="${label}" style="--stat-color:${color.hex}">${icon('plane')}<span class="stat-count">${count}</span></span>`;
  }).join('')}</span>`;
}
function isPlaying() { return state?.game?.status === 'playing'; }
function myTurn() { return unfinishedParticipant(state.you.seat) && state.you.seat === state.game.turn && !playerAfk(state.you.seat); }
function canWrite() { return !!state && connected && !hostControlsRevoked && !busy && !diceRolling; }
function canMove(piece) { return canWrite() && myTurn() && state.game.phase === 'move' && state.game.legal.includes(piece); }
function didRoll(previous, next) {
  if ((next.rollCount ?? 0) > (previous.rollCount ?? 0)) return true;
  // A dice log identifies a roll even when the resulting face or phase is unchanged.
  const lastRoll = game => game.log?.findLast(entry => /方掷出 [1-6] 点$/.test(entry.text));
  const before = lastRoll(previous), after = lastRoll(next);
  return !!after && (!before || after.at !== before.at || after.text !== before.text);
}
function adoptState(next, { baseline = false } = {}) {
  if (!next || (next.revision != null && next.revision < lastRevision)) return;
  const previous = state;
  const seatChanged = !!previous && previous.you.seat !== next.you.seat;
  state = next;
  if (betrayalConfirmation && (seatChanged || next.id !== betrayalConfirmation.roomId || !activeParticipant() || next.you.seat !== betrayalConfirmation.seat || next.game.allies?.[next.you.seat] !== betrayalConfirmation.ally || next.game.betrayed?.[next.you.seat])) cancelBetrayalConfirmation();
  if (next.revision == null || next.revision > lastRevision) hostControlsRevoked = false;
  setEntryError();
  lastRevision = next.revision ?? lastRevision;
  if (seatChanged) cancelDiceAnimation(next.game?.dice);
  if (previous?.game && next.game) {
    if (next.game.status === 'finished' && previous.game.status !== 'finished') playSound('win');
    else if (!seatChanged && didRoll(previous.game, next.game)) {
      playSound('roll');
      animateDice(next.game.dice);
    }
    else if (JSON.stringify(previous.game.pieces) !== JSON.stringify(next.game.pieces)) playSound('move');
  }
  if (next.game && next.game.status !== 'finished' && next.you?.seat !== null && next.you?.seat !== undefined) {
    const isMyTurnNow = next.game.turn === next.you.seat && next.game.phase === 'roll';
    const wasMyTurnBefore = previous?.game ? (previous.game.turn === previous.you?.seat && previous.game.phase === 'roll') : false;
    if (isMyTurnNow && (!wasMyTurnBefore || seatChanged)) {
      playTurnSound();
    }
  }
  if (!next.game || !previous?.game) cancelDiceAnimation(next.game?.dice);
  document.body.classList.toggle('room-active', !!next.game);
  document.body.classList.toggle('has-game', !!next.game);
  $('home-view').hidden = true;
  $('room-view').hidden = false;
  $('home-button').hidden = false;
  $('connection').hidden = false;
  $('room-id').textContent = state.id;
  document.title = `房间 ${state.id} · 塑料航线`;
  render();
  syncCaptureEffects(previous, next, baseline || seatChanged);
}
function openStream() {
  stream?.close();
  connected = false;
  $('connection').hidden = false;
  renderConnection();
  render();
  let checkingIdentity = false;
  let needsCaptureBaseline = true;
  const ownStream = new EventSource(`/api/rooms/${encodeURIComponent(session.roomId)}/events?token=${encodeURIComponent(session.token)}`);
  stream = ownStream;
  ownStream.addEventListener('state', (event) => {
    if (stream !== ownStream || leaving) return;
    try {
      const next = extractedState(JSON.parse(event.data));
      if (!next) return;
      connected = true;
      adoptState(next, { baseline: needsCaptureBaseline });
      needsCaptureBaseline = false;
    } catch { notify('收到的房间状态无效，正在重新连接。'); }
  });
  ownStream.addEventListener('gone', (event) => {
    if (stream !== ownStream) return;
    let message = '房间已关闭，创建一个新房间继续玩吧。';
    try {
      const payload = JSON.parse(event.data);
      if (typeof payload.message === 'string') message = payload.message;
    } catch { /* Older servers can send an empty gone event. */ }
    resetRoom();
    notify(message, 5500);
  });
  ownStream.addEventListener('role-replaced', (event) => {
    if (stream !== ownStream || leaving) return;
    cancelDiceAnimation(state?.game?.dice);
    clearCaptureEffects();
    cancelBetrayalConfirmation();
    closeRoleDialog();
    hostControlsRevoked = true;
    closeHostDialog();
    cancelKickConfirmation();
    let message = '你的角色已由其他人接管，你已转为观战。';
    try { message = JSON.parse(event.data).message || message; } catch { /* Use the default notice for older servers. */ }
    notify(message, 5500);
    if (state) render();
  });
  ownStream.onerror = () => {
    if (stream !== ownStream || leaving) return;
    connected = false;
    needsCaptureBaseline = true;
    clearCaptureEffects();
    renderConnection();
    render();
    // A missing or invalid room makes EventSource fail without exposing its HTTP status.
    // Check identity after a stream failure, including removal while disconnected.
    // A network error alone never discards the saved room credentials.
    if (!checkingIdentity && session) {
      checkingIdentity = true;
      const restoringSession = session;
      request(`/api/rooms/${encodeURIComponent(restoringSession.roomId)}?token=${encodeURIComponent(restoringSession.token)}`)
        .catch((error) => {
          if (stream === ownStream && session === restoringSession && [401, 403, 404].includes(error.status)) {
            resetRoom();
            notify(error.status === 401 ? '你已离开房间或被房主移出，请重新加入。' : '之前的房间已失效，请重新加入或创建房间。');
          }
        })
        .finally(() => { checkingIdentity = false; });
    }
  };
}
function resetRoom() {
  cancelDiceAnimation();
  clearCaptureEffects();
  captureMoveId = null;
  cancelBetrayalConfirmation();
  closeRoleDialog();
  closeHostDialog();
  cancelKickConfirmation();
  if ($('confirm-dialog').open) $('confirm-dialog').close();
  if ($('fun-intro-dialog').open) $('fun-intro-dialog').close();
  if ($('skin-dialog')?.open) $('skin-dialog').close();
  dialogAction = null;
  hostControlsRevoked = false;
  document.body.classList.remove('room-active', 'has-game', 'fun-mode', 'has-strategy');
  stream?.close();
  stream = null;
  session = null;
  state = null;
  connected = false;
  busy = false;
  leaving = false;
  lastRevision = -1;
  seatsKey = boardKey = logKey = keyEventsKey = keyEventsRoom = '';
  $('key-events-list').replaceChildren();
  $('key-events-panel').hidden = true;
  $('key-events-panel').open = true;
  keyEventsView = { id: null, offset: 0, scrollTop: 0 };
  writeStorage(sessionStorage, SESSION_KEY, null);
  $('home-view').hidden = false;
  $('room-view').hidden = true;
  $('home-button').hidden = true;
  $('end-game').hidden = true;
  $('game-header-tools').hidden = true;
  $('host-tools-button').hidden = true;
  $('afk-tools').hidden = true;
  $('connection').hidden = true;
  setEntryError();
  $('create-room').disabled = false;
  $('join-form').querySelector('button').disabled = false;
  document.title = '塑料航线 · Plastic Airlines';
  const url = new URL(location.href);
  url.searchParams.delete('room');
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}
async function enterRoom(create) {
  if (busy) return;
  const name = $('player-name').value.trim();
  const roomId = $('room-code').value.trim().toLowerCase();
  if (!name) { setEntryError('先取一个昵称，朋友才知道是你。'); $('player-name').focus(); return; }
  if (!create && !/^[a-z0-9]{4,8}$/.test(roomId)) { setEntryError('请输入正确的房间号。'); $('room-code').focus(); return; }
  stream?.close();
  stream = null;
  lastRevision = -1;
  busy = true;
  setEntryError();
  $('create-room').disabled = true;
  $('join-form').querySelector('button').disabled = true;
  $('create-room').querySelector('span').textContent = create ? '正在创建…' : '创建房间';
  try {
    const data = await request(create ? '/api/rooms' : `/api/rooms/${encodeURIComponent(roomId)}/join`, { name });
    if (!data.roomId || !data.token || !extractedState(data)) throw new Error('房间信息不完整，请重试。');
    session = { roomId: data.roomId, token: data.token };
    writeStorage(sessionStorage, SESSION_KEY, JSON.stringify(session));
    writeStorage(localStorage, NAME_KEY, name);
    lastRevision = -1;
    busy = false;
    adoptState(extractedState(data));
    const url = new URL(location.href);
    url.searchParams.set('room', data.roomId);
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    openStream();
    if (create) notify('房间准备好了，邀请朋友一起起飞！');
  } catch (error) {
    setEntryError(error.name === 'TimeoutError' ? '连接超时，请检查网络后重试。' : error.message);
  } finally {
    busy = false;
    $('create-room').disabled = false;
    $('join-form').querySelector('button').disabled = false;
    $('create-room').querySelector('span').textContent = '创建房间';
    if (state) render();
  }
}
async function action(type, details = {}) {
  if (!canWrite() || !session) return false;
  const requestSession = session;
  busy = true;
  if (type === 'takeover' || type === 'end') clearCaptureEffects();
  if (type === 'roll') animateDice();
  if (type === 'leave') leaving = true;
  render();
  try {
    const data = await request(`/api/rooms/${encodeURIComponent(requestSession.roomId)}/action`, { token: requestSession.token, type, ...details });
    if (session !== requestSession) return false;
    if (type === 'leave') { resetRoom(); return true; }
    let next = extractedState(data);
    if (!next) {
      next = extractedState(await request(`/api/rooms/${encodeURIComponent(requestSession.roomId)}?token=${encodeURIComponent(requestSession.token)}`));
      if (session !== requestSession) return false;
    }
    if (next) adoptState(next, { baseline: type === 'takeover' });
    return true;
  } catch (error) {
    if (session !== requestSession) return false;
    if (type === 'roll' && diceTarget === null) cancelDiceAnimation(state?.game?.dice);
    leaving = false;
    const message = error.name === 'TimeoutError' ? '操作超时，房间状态会自动同步。' : error.message;
    if (type === 'takeover' && roleDialogMode === 'takeover' && $('role-dialog').open) setRoleError(message);
    else notify(message);
    if (error instanceof TypeError || error.name === 'TimeoutError') {
      connected = false;
      openStream();
    }
    return false;
  } finally {
    if (session === requestSession) {
      busy = false;
      if (state) render();
    }
  }
}
function renderConnection() {
  $('connection').classList.toggle('offline', !connected);
  $('connection').querySelector('span').textContent = connected ? '实时联机' : '重新连接中';
}
function seatMarkup(seat) {
  const player = currentPlayer(seat);
  const color = COLORS[seat];
  const self = player?.id === state.you.id;
  const isHost = player?.id === state.hostId;
  const rank = playerRank(seat);
  const captain = selectedRules().captains && player ? captainInfo(seat) : null;
  const turn = isPlaying() && state.game.turn === seat && !rank;
  const initial = player ? Array.from(player.name)[0] || '✈' : '';
  const actionButton = !state.game && !player ? `<button class="seat-action" data-seat="${seat}" type="button" aria-label="坐到${color.name}色座位">${state.you.seat === null ? '入座' : '换位'}</button>` : '';
  const captainBadge = selectedRules().captains && player ? `<span class="seat-captain-badge" title="${escapeHTML(captain ? `${captain.name} · ${captain.active}` : '等待选择机长')}">(${captain ? captain.icon : '待选'})</span>` : '';
  return `<div class="seat ${player ? 'occupied' : 'empty'} ${turn ? 'is-turn' : ''}" style="--seat-color:${color.hex}">
    <div class="seat-avatar" aria-label="${escapeHTML(player ? `${player.name}，${color.name}色${player.online ? '' : '，暂时离线'}` : `${color.name}色空座位`)}">
      ${player ? `<span class="seat-initial">${escapeHTML(initial)}</span>` : icon('plus')}
      ${isHost ? '<span class="host-label">房主</span>' : ''}<span class="seat-number">${seat + 1}</span>${player ? `<span class="seat-status ${player.online ? '' : 'offline'}"></span>` : ''}
    </div>
    <div class="seat-meta">${player ? `<span class="seat-name" title="${escapeHTML(player.name)}">${escapeHTML(player.name)}</span>${captainBadge}${self ? '<span class="you-tag">我</span>' : ''}` : actionButton || '<span class="seat-name">等待入座</span>'}</div>
    ${state.game && player ? `${statsMarkup(seat, 'seat-stats')}<span class="seat-rank-slot">${rank ? `<span class="seat-rank" data-rank="${rank}">第${rank}名</span>` : playerAfk(seat) ? '<span class="seat-afk">挂机</span>' : ''}</span>` : ''}
  </div>`;
}
function renderSeats() {
  const key = JSON.stringify([state.players, state.hostId, state.you.id, state.you.seat, state.capacity, state.game?.status, state.game?.turn, state.game?.players, state.game?.active, selectedRules().captains, state.game?.captains]);
  if (key !== seatsKey) {
    const focused = document.activeElement?.dataset?.seat;
    $('seats').innerHTML = [0, 1, 2, 3].map(seatMarkup).join('');
    if (focused != null) $('seats').querySelector(`[data-seat="${focused}"]`)?.focus({ preventScroll: true });
    seatsKey = key;
  }
  $('seats').querySelectorAll('button').forEach((button) => { button.disabled = !canWrite(); });
}
function renderLobby() {
  const seated = state.players.filter((player) => player.seat !== null);
  const captains = selectedRules().captains;
  const waitingCaptains = captains ? seated.filter(player => !captainInfo(player.seat)) : [];
  const allSeated = seated.length === state.capacity && seated.every((player) => player.online);
  const ready = allSeated && !waitingCaptains.length;
  const spectator = state.you.seat === null;
  const disconnected = seated.some((player) => !player.online);
  $('lobby-title').textContent = spectator ? '好戏，就在这一桌' : ready ? '全员就位，准备起飞' : allSeated && waitingCaptains.length ? '选好机长，一起起飞' : '等朋友，一起出发';
  $('lobby-message').textContent = !connected ? '连接恢复后，座位和房间状态会自动同步。' : ready ? (state.you.host ? '所有人都准备好了，点击“开始游戏”开启这一局。' : '一切准备就绪，等待房主开始游戏。') : seated.length > state.capacity ? `本局需要 ${state.capacity} 人，请调整人数或让 ${seated.length - state.capacity} 位朋友离座观战。` : disconnected ? '有朋友暂时离线，等待重新连接。' : allSeated && waitingCaptains.length ? `等待 ${waitingCaptains.map(player => player.name).join('、')} 选择机长。` : `已入座 ${seated.length} / ${state.capacity} 人，分享链接邀请朋友加入。`;
  $('start-game').disabled = !canWrite() || !state.you.host || !ready;
  $('start-game').innerHTML = `${icon('plane')}${busy ? '请稍候…' : state.you.host ? '开始游戏' : '等待房主开始'}`;
  $('spectate-button').hidden = spectator;
  $('spectate-button').disabled = !canWrite();
  $('capacity-options').querySelectorAll('button').forEach((button) => {
    const selected = Number(button.dataset.capacity) === state.capacity;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
    button.disabled = !canWrite() || !state.you.host || selected;
  });
  $('progress-fill').style.width = `${Math.min(100, seated.length / state.capacity * 100)}%`;
  $('progress-label').textContent = `${seated.length} / ${state.capacity} 人已入座${spectator ? ' · 你正在观战' : ''}`;
}
function renderCaptainSelection() {
  const visible = !state.game && selectedRules().captains;
  $('captain-selection').hidden = !visible;
  if (!visible) return;
  const seated = state.you.seat !== null, chosen = seated ? captainInfo(state.you.seat) : null;
  $('captain-selection-status').textContent = !seated ? '观战中，可以查看机长介绍；入座后即可选择。' : chosen ? `已选择 ${chosen.icon} ${chosen.name}，开局前可更换。` : '选择一个喜欢的机长，准备好再出发。';
  const key = JSON.stringify([chosen?.key, seated]);
  if ($('captain-choices').dataset.key !== key) {
    const focused = document.activeElement?.dataset?.captain;
    $('captain-choices').innerHTML = CAPTAINS.map(captain => `<button class="captain-choice ${chosen?.key === captain.key ? 'is-selected' : ''}" type="button" data-captain="${captain.key}" aria-pressed="${chosen?.key === captain.key}"><strong>${captain.icon} ${captain.name}</strong><span>主动 · ${escapeHTML(captain.active)}</span><small>被动 · ${escapeHTML(captain.passive)}</small></button>`).join('');
    if (focused) $('captain-choices').querySelector(`[data-captain="${focused}"]`)?.focus({ preventScroll: true });
    $('captain-choices').dataset.key = key;
  }
  $('captain-choices').querySelectorAll('button').forEach(button => { button.disabled = !canWrite() || !seated || button.dataset.captain === chosen?.key; });
}
function renderMode() {
  const mode = state.game?.mode ?? state.mode ?? 'classic';
  const fun = mode === 'fun';
  document.body.classList.toggle('fun-mode', fun && !!state.game);
  $('mode-options').querySelectorAll('button').forEach(button => {
    const selected = button.dataset.mode === mode;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
    button.disabled = !canWrite() || !state.you.host || hostControlsRevoked || !!state.game || selected;
  });
  const rules = selectedRules();
  const chosen = Object.keys(RULE_NAMES).filter(key => rules[key]).map(key => RULE_NAMES[key]);
  $('mode-description').textContent = fun ? `趣味模式 · ${chosen.length ? chosen.join('、') : '所有附加玩法已关闭'}。` : '经典模式 · 熟悉的同色跳跃和飞行规则。';
  $('mode-permission').textContent = state.you.host ? '开始后模式锁定，本局所有人使用同一规则。' : '当前模式由房主选择，开始后锁定。';
  $('game-mode-summary').textContent = `${fun ? '趣味模式' : '经典模式'} · 本局模式已锁定`;
  $('fun-rules').hidden = !fun || !!state.game;
  $('fun-intro-lobby').hidden = !fun || !!state.game;
  $('fun-intro-button').hidden = !fun || !state.game;
  $('fun-intro-selection').textContent = `本局启用：${chosen.length ? chosen.join('、') : '无附加玩法'}。下列为完整规则，仅启用的附加玩法生效。`;
  if (!fun && $('fun-intro-dialog').open) $('fun-intro-dialog').close();
  $('fun-rules').querySelectorAll('[data-rule]').forEach(input => {
    input.checked = rules[input.dataset.rule];
    input.disabled = !canWrite() || !state.you.host || hostControlsRevoked || !!state.game || rules.captains && ['alliances', 'items'].includes(input.dataset.rule);
  });
  $('captain-rule-note').hidden = !rules.captains;
  $('fun-legend').hidden = !state.game || !fun || !chosen.some(name => name !== RULE_NAMES.captureEffects);
  $('fun-legend').querySelectorAll('[data-legend]').forEach(element => { element.hidden = !rules[element.dataset.legend]; });
  $('legend-rule-description').hidden = !['speed', 'trap', 'safe', 'lucky', 'ice'].some(key => rules[key]);
  $('ice-status').hidden = !rules.ice;
  if (state.game && fun) {
    const rolls = state.game.rollCount ?? 0;
    $('ice-status').textContent = `${Number.isInteger(state.game.iceCell) ? '冰冻格等待首架飞机落入' : '当前没有冰冻格'} · ${20 - rolls % 20} 次掷骰后重新生成`;
  }
}
function selectOptions(id, choices, emptyLabel) {
  const select = $(id);
  const key = JSON.stringify([choices, emptyLabel]);
  if (select.dataset.options === key) return;
  const previous = select.value;
  select.innerHTML = choices.length ? choices.map(choice => `<option value="${escapeHTML(choice.value)}">${escapeHTML(choice.label)}</option>`).join('') : `<option value="">${escapeHTML(emptyLabel)}</option>`;
  if (choices.some(choice => String(choice.value) === previous)) select.value = previous;
  select.dataset.options = key;
}
function activeParticipant() { return unfinishedParticipant(state.you.seat) && !playerAfk(state.you.seat); }
function skillSources(key) {
  const game = state.game, seat = state.you.seat;
  if (!game?.active.includes(seat)) return [];
  const ally = game.allies?.[seat];
  return game.pieces[seat].flatMap((progress, piece) => {
    if (progress < 0 || progress >= FINISH) return [];
    if (key === 'shield' && game.shields?.[seat]?.[piece]) return [];
    if (key === 'betrayer' && (progress > 50 || !Number.isInteger(ally) || playerRank(ally) || (STARTS[seat] + progress - STARTS[ally] + 52) % 52 > 50)) return [];
    return [{ value: piece, label: `${piece + 1} 号 · ${progress > 50 ? '归航道' : `外环第 ${progress + 1} 格`}${game.frozenPieces?.[seat]?.[piece] ? ' · 冰冻' : ''}` }];
  });
}
function skillTargets(key) {
  const game = state.game, seat = state.you.seat;
  if (!game?.active.includes(seat)) return [];
  const planes = key === 'avenger' ? captainState(seat)?.attackers ?? [] : Number.isInteger(game.allies?.[seat]) ? game.pieces[game.allies[seat]].map((progress, piece) => ({ seat: game.allies[seat], piece })) : [];
  return planes.flatMap(plane => {
    const progress = game.pieces?.[plane.seat]?.[plane.piece];
    if (!game.active.includes(plane.seat) || plane.seat === seat || playerRank(plane.seat) || !Number.isInteger(plane.piece) || plane.piece < 0 || plane.piece > 3 || !Number.isInteger(progress) || key === 'avenger' && plane.seat === game.allies?.[seat]) return [];
    if (key === 'betrayer' && (progress < 0 || progress > 50)) return [];
    if (key === 'betrayer' && (STARTS[plane.seat] + progress - STARTS[seat] + 52) % 52 > 50) return [];
    const position = progress === TAKEOFF ? '停机坪' : progress < 0 ? '机场' : progress >= FINISH ? '已抵达' : progress > 50 ? '归航道' : '外环';
    return [{ value: `${plane.seat}:${plane.piece}`, label: `${COLORS[plane.seat].name}色 · ${seatName(plane.seat)} · ${plane.piece + 1} 号${key === 'avenger' ? ` · ${position}` : ''}` }];
  });
}
function skillReady() {
  const captain = captainState(state.you.seat);
  if (!captain || captain.used || (captain.uses != null && captain.uses <= 0) || !myTurn()) return false;
  if (captain.key === 'flash' && captain.flashReady) return false;
  if (captain.key === 'gambler' && captain.rerolledThisTurn) return false;
  const phase = ['flash', 'gambler'].includes(captain.key) ? 'move' : 'roll';
  if (state.game.phase !== phase) return false;
  if (captain.key === 'flash') return state.game.legal.some(piece => state.game.pieces[state.you.seat][piece] !== -1);
  if (captain.key === 'shield') return skillSources(captain.key).length > 0;
  if (captain.key === 'betrayer') return skillSources(captain.key).length > 0 && skillTargets(captain.key).length > 0;
  if (captain.key === 'avenger') return skillTargets(captain.key).length > 0;
  return true;
}
function captainSummary(seat) {
  const captain = captainState(seat), info = captainInfo(seat);
  if (!captain || !info) return '';
  const remaining = captain.uses ?? (captain.used ? 0 : info.maxUses);
  const statuses = [captain.used || remaining <= 0 ? '主动已用完' : `主动余 ${remaining} 次`];
  if (captain.flashReady) statuses.push('闪现待生效');
  if (captain.revengeTarget) statuses.push(`追击${COLORS[captain.revengeTarget.seat].name}方${captain.revengeTarget.piece + 1}号`);
  if (captain.revengeBonus || captain.bonusReady) statuses.push('下次首骰 +2');
  const shields = state.game.shields?.[seat]?.flatMap((flag, piece) => flag ? [piece + 1] : []) ?? [];
  if (shields.length) statuses.push(`${shields.join('、')}号有盾`);
  const reserves = state.game.reserveSteps?.[seat]?.flatMap((flag, piece) => flag ? [piece + 1] : []) ?? [];
  if (reserves.length) statuses.push(`${reserves.join('、')}号保留 1 步`);
  return `${COLORS[seat].name}方 ${info.icon} ${info.name} · ${statuses.join(' · ')}`;
}
function renderCaptains() {
  const game = state.game, seat = state.you.seat, captain = captainState(seat), info = captainInfo(seat);
  $('captain-public').textContent = game.active.map(captainSummary).filter(Boolean).join('；');
  $('captain-name').textContent = info ? `${info.icon} ${info.name}` : '机长技能';
  $('captain-active').textContent = info ? `主动 · ${info.active}` : '观战中，可查看各方机长及技能状态。';
  $('captain-passive').textContent = info ? `被动 · ${info.passive}` : '';
  const key = captain?.key, ready = skillReady();
  const remaining = captain?.uses ?? (captain?.used ? 0 : info?.maxUses ?? 0);
  $('captain-status').textContent = !captain ? '' : playerRank(seat) ? '已完成本局，技能操作已结束。' : playerAfk(seat) ? '挂机中，取消挂机后可使用技能。' : captain.flashReady ? '闪现已准备：选择一架亮起的飞机，本次走棋后生效。' : captain.revengeTarget ? `已锁定 ${seatName(captain.revengeTarget.seat)} 的 ${captain.revengeTarget.piece + 1} 号飞机。己机下一次可追击的外环移动生效；目标返航、完成或变为盟友时锁定保留。` : captain.used || remaining <= 0 ? '本局主动技能已用完，被动仍生效。' : `本局主动技能剩余 ${remaining} 次。`;
  $('captain-form').hidden = !captain || !activeParticipant();
  const sources = ['shield', 'betrayer'].includes(key) ? skillSources(key) : [];
  const targets = ['betrayer', 'avenger'].includes(key) ? skillTargets(key) : [];
  selectOptions('captain-piece', sources, key === 'shield' ? '暂无可保护的己机' : '暂无可交换的外环己机');
  selectOptions('captain-target', targets, key === 'avenger' ? '暂无曾撞过你的敌机' : '暂无可交换的盟友外环飞机');
  $('captain-piece-field').hidden = !['shield', 'betrayer'].includes(key);
  $('captain-target-field').hidden = !['betrayer', 'avenger'].includes(key);
  $('captain-target-field').firstChild.textContent = key === 'betrayer' ? '盟友飞机' : '曾撞过你的敌机';
  for (const id of ['captain-piece', 'captain-target', 'captain-use']) $(id).disabled = !canWrite() || !ready;
  const labels = {
    flash: `闪现 +3 (余 ${remaining} 次)`,
    shield: `加护盾 (余 ${remaining} 次)`,
    betrayer: '与盟友交换位置',
    avenger: '锁定复仇目标',
    gambler: `强制重掷 (余 ${remaining} 次)`
  };
  $('captain-use').textContent = labels[key] ?? '使用主动技能';
  const offered = captain?.key === 'gambler' && !captain.used && remaining > 0 && !captain.rerolledThisTurn && myTurn() && game.phase === 'move' && game.rerollOffered && !game.legal.length;
  $('captain-accept').hidden = !offered;
  $('captain-accept').disabled = !canWrite() || !offered;
  const hints = {
    flash: `掷骰后、选机前使用，全局共 ${info?.maxUses} 次；机场起飞不能闪现。额外最多前进 3 格，遇墙停前，不连锁触发奖励。落点冰冻、回机场或已完成时不追加；跳过阶段不退次数。`,
    shield: `轮到自己且掷骰前，保护一架外环或归航道己机，全局共 ${info?.maxUses} 次。可挡一次敌方撞击、导弹或地雷；自爆破墙仍回机场。`,
    betrayer: `轮到自己且掷骰前，交换双方可互换的外环落点，全局共 ${info?.maxUses} 次。须先结盟，落点不触发奖励，冰冻和护盾仍跟随原飞机。`,
    avenger: `轮到自己且掷骰前，锁定曾撞过自己的敌机，全局共 ${info?.maxUses} 次。双方均在可追击外环时，下一次己方外环移动直接追到它当前格，不触发落点奖励；安全岛、护盾和墙仍有效。`,
    gambler: offered ? `当前没有可移动的飞机：可用重掷（剩余 ${remaining} 次），也可接受当前点数并换人。重掷后必须接受新面；两次投掷均计入冰冻格生成次数。` : `掷骰后、选机前可强制重掷，全局共 ${info?.maxUses} 次（剩余 ${remaining} 次）；必须接受新点数，原结果不再走棋。重掷不恢复本轮道具资格，掷出 1 抽牌时手牌上限 3 张。`
  };
  $('captain-help').textContent = hints[key] ?? '主动技能次数、护盾、保留步数与追击锁定均公开；手牌内容仅本人可见。';
}
function renderAlliances() {
  const game = state.game, seat = state.you.seat;
  const participant = activeParticipant();
  const ally = participant ? game.allies?.[seat] : null;
  const pairs = game.active.filter(other => Number.isInteger(game.allies?.[other]) && other < game.allies[other]);
  $('alliance-public').textContent = pairs.length ? pairs.map(other => `${seatName(other)} ↔ ${seatName(game.allies[other])}`).join(' · ') : '当前没有联盟';
  const revengeTarget = game.revengeTarget?.[seat];
  const statusParts = [];
  if (!participant) {
    statusParts.push(playerRank(seat) ? '你已抵达，联盟操作已结束。' : playerAfk(seat) ? '你已挂机，取消挂机后可继续联盟操作。' : '观战中，可查看公开联盟。');
  } else {
    if (ally != null) statusParts.push(`盟友：${seatName(ally)}${game.betrayed?.[seat] ? ' · 本局背叛次数已用完' : ''}`);
    else if (game.diceDouble?.[seat]) statusParts.push('背叛buff待生效：下一次掷骰点数翻倍。');
    else if (revengeTarget != null) statusParts.push(`复仇待生效：撞飞${COLORS[revengeTarget].name}方飞机可获得两张随机道具。`);
    else if (game.betrayed?.[seat]) statusParts.push('当前没有盟友 · 本局背叛次数已用完');
    else if (game.everAllied?.[seat]) statusParts.push('本局已结盟过，无法再次结盟');
    else statusParts.push('选择一位朋友，等待对方接受邀请。');

    const bounties = game.active.filter(other => (game.bountyRounds?.[other] ?? 0) > 0);
    if (bounties.length) {
      statusParts.push(`⚠️ 叛徒悬赏中：${bounties.map(other => `${COLORS[other].name}方（余 ${game.bountyRounds[other]} 轮，踩中得道具）`).join('、')}`);
    }
    if (game.huntTargets?.[seat]) {
      const ht = game.huntTargets[seat];
      statusParts.push(`🎯 追杀锁定中：已锁定${COLORS[ht.targetSeat].name}方 ${ht.targetPiece + 1} 号飞机，下回合结算。`);
    }
  }
  $('alliance-status').textContent = statusParts.join(' ');
  const invitations = game.invitations ?? [];
  const mine = invitations.filter(invite => invite.from === seat || invite.to === seat);
  $('alliance-invitations').innerHTML = participant ? mine.map(invite => {
    const incoming = invite.to === seat, other = incoming ? invite.from : invite.to;
    const buttons = incoming ? `<button type="button" data-alliance="accept" data-target="${other}">接受</button><button type="button" data-alliance="decline" data-target="${other}">拒绝</button>` : `<button type="button" data-alliance="cancel" data-target="${other}">撤回</button>`;
    return `<div class="alliance-request"><span>${incoming ? `${escapeHTML(seatName(other))}邀请你结盟` : `等待${escapeHTML(seatName(other))}接受`}</span><span class="alliance-request-buttons">${buttons}</span></div>`;
  }).join('') : '';
  $('alliance-invitations').querySelectorAll('button').forEach(button => { button.disabled = !canWrite(); });
  const choices = participant && ally == null ? game.active.filter(other => other !== seat && !playerRank(other) && game.allies?.[other] == null && !game.everAllied?.[other] && !invitations.some(invite => invite.from === seat && invite.to === other)).map(other => ({ value: other, label: `${COLORS[other].name}色 · ${seatName(other)}` })) : [];
  selectOptions('alliance-target', choices, '暂无可邀请玩家');
  $('alliance-actions').hidden = !participant;
  $('alliance-target').parentElement.hidden = ally != null;
  $('alliance-target').disabled = !canWrite() || !choices.length;
  $('alliance-invite').hidden = ally != null;
  $('alliance-invite').disabled = !canWrite() || !choices.length;
  $('alliance-betray').hidden = ally == null;
  $('alliance-betray').disabled = !canWrite() || !!game.betrayed?.[seat];
}
function itemSources(card) {
  const game = state.game, seat = state.you.seat;
  if (!game?.active.includes(seat) || ['stun', 'hunt'].includes(card)) return [];
  return game.pieces[seat].flatMap((progress, piece) => {
    if (progress < 0 || progress > 50) return [];
    const index = (STARTS[seat] + progress) % 52;
    if (card === 'mine' && (enabledSpecial(index) || selectedRules().ice && game.iceCell === index || game.mines?.some(mine => mine.index === index))) return [];
    if (card === 'missile' && !itemTargets(card, piece).length) return [];
    return [{ value: piece, label: `${piece + 1} 号 · 外环第 ${progress + 1} 格` }];
  });
}
function itemTargets(card, sourcePiece) {
  const game = state.game, seat = state.you.seat;
  if (!game?.active.includes(seat)) return [];
  const source = game.pieces[seat][sourcePiece];
  return game.active.flatMap(other => {
    if (other === seat || playerRank(other) || selectedRules().alliances && game.allies?.[seat] === other) return [];
    return game.pieces[other].flatMap((progress, piece) => {
      if (progress < 0 || progress > 50 || card === 'stun' && game.frozenPieces?.[other]?.[piece]) return [];
      const index = (STARTS[other] + progress) % 52;
      const relative = (index - STARTS[seat] + 52) % 52;
      if (card === 'missile' && (!Number.isInteger(source) || source < 0 || source > 50 || relative <= source || relative > Math.min(50, source + 6) || enabledSpecial(index) === 'safe')) return [];
      if (card === 'hunt' && enabledSpecial(index) === 'safe') return [];
      return [{ value: `${other}:${piece}`, label: `${COLORS[other].name}色 · ${seatName(other)} · ${piece + 1} 号` }];
    });
  });
}
function renderItems() {
  const game = state.game, seat = state.you.seat;
  const seated = game.active.includes(seat);
  const hand = seated ? (state.you.hand ?? []).filter(card => Object.hasOwn(CARD_NAMES, card)) : [];
  $('hand-counts').textContent = game.active.map(other => `${COLORS[other].name}方 ${game.handCounts?.[other] ?? 0} 张`).join(' · ');
  $('own-hand').textContent = !seated ? '观战中，其他玩家的手牌内容保密。' : hand.length ? `你的手牌：${hand.map(card => CARD_NAMES[card]).join('、')}` : '你的道具卡已用完';
  $('item-form').hidden = !seated;
  selectOptions('item-card', [...new Set(hand)].map(card => ({ value: card, label: CARD_NAMES[card] })), '暂无道具卡');
  const card = $('item-card').value;
  const sources = itemSources(card);
  selectOptions('item-source', sources, card === 'mine' ? '暂无可埋雷的普通格飞机' : '暂无符合条件的飞机');
  const sourcePiece = $('item-source').value;
  const targets = itemTargets(card, sourcePiece === '' ? NaN : Number(sourcePiece));
  selectOptions('item-target', targets, '暂无符合条件的敌机');
  $('item-source-field').hidden = ['stun', 'hunt'].includes(card) || !card;
  $('item-target-field').hidden = card === 'mine' || !card;
  const ready = myTurn() && game.phase === 'roll' && !game.itemUsed?.[seat] && hand.includes(card);
  for (const id of ['item-card', 'item-source', 'item-target']) $(id).disabled = !canWrite() || !ready;
  $('item-submit').disabled = !canWrite() || !ready || (!['stun', 'hunt'].includes(card) && !sources.length) || (card !== 'mine' && !targets.length);
  const hints = {
    stun: '选择外环敌机，将其冻结；对方需掷出 6 并选择该飞机解冻。',
    mine: '在己机当前普通外环格埋公开地雷；敌机踩中返回机场，己方和盟友免疫。',
    missile: '选择外环己机，击落其前方 6 格内的敌机；盟友和已启用安全岛上的飞机免疫。',
    hunt: '选择外环任一敌机锁定追杀；下一回合若其仍在外环且未入安全格，将跳至其位置将其击落（被背叛者专属）。'
  };
  $('item-help').textContent = !seated ? '只能查看各方剩余张数和公开地雷。' : playerRank(seat) ? '你已完成本局，不能再使用道具。' : playerAfk(seat) ? '你已挂机，取消挂机后可继续使用道具。' : game.itemUsed?.[seat] ? '本轮已使用一张道具，可继续掷骰；轮转回来后恢复使用资格。' : !myTurn() || game.phase !== 'roll' ? `轮到自己且掷骰前可以使用。${hints[card] ?? ''}` : hints[card] ?? '所有道具卡都已使用。';
  $('item-rule-note').textContent = `${selectedRules().captains ? '开局各一张；背叛者可偷牌，赌徒掷 1 可抽牌，手牌最多 3 张。' : '开局各一张，不再补充。'}轮到自己且掷骰前，每轮最多用一张；掷 6 连掷仍算同一轮。`;
}
function renderStrategy() {
  const game = state.game, rules = selectedRules();
  const visible = !!game && (rules.alliances || rules.items || rules.captains);
  if (visible && $('strategy-panel').hidden) $('strategy-panel').open = true;
  $('strategy-panel').hidden = !visible;
  document.body.classList.toggle('has-strategy', visible);
  if (!visible) { $('strategy-panel').open = false; return; }
  $('strategy-title').textContent = rules.captains ? '机长、盟友与道具' : '盟友与道具';
  $('captain-section').hidden = !rules.captains;
  $('alliance-section').hidden = !rules.alliances;
  $('item-section').hidden = !rules.items;
  const incoming = (game.invitations ?? []).filter(invite => invite.to === state.you.seat).length;
  $('strategy-summary').textContent = `${incoming ? `${incoming} 个结盟邀请 · ` : ''}${rules.items && state.you.seat !== null ? `手牌 ${state.you.hand?.length ?? 0} 张` : '查看公开状态'}`;
  if (rules.captains) renderCaptains();
  if (rules.alliances) renderAlliances();
  if (rules.items) renderItems();
  $('mine-status').hidden = !rules.items;
  $('mine-status').textContent = game.mines?.length ? `公开地雷：${game.mines.map(mine => `${COLORS[mine.seat].name}方 · 外环 ${mine.index + 1} 格`).join('；')}` : '棋盘上暂无地雷';
}
function renderRankings() {
  const game = state.game;
  const seats = game?.rankings?.filter(seat => Number.isInteger(seat) && COLORS[seat] && playerRank(seat)) ?? [];
  $('rankings-panel').hidden = !seats.length;
  if (!seats.length) { $('rankings-list').replaceChildren(); return; }
  const finished = game.status === 'finished';
  $('rankings-title').textContent = finished ? '本局名次榜' : '已抵达名次';
  $('rankings-description').textContent = finished ? '只剩最后一位未抵达时，本局结束并排定全部名次。' : '已完成的机队退出回合，其余玩家继续飞行。';
  $('rankings-list').innerHTML = seats.map(seat => {
    const player = currentPlayer(seat);
    const rank = playerRank(seat);
    const color = COLORS[seat];
    return `<li class="ranking-row" data-seat="${seat}" data-rank="${rank}" style="--seat-color:${color.hex}"><span class="ranking-place">第${rank}名</span><span class="ranking-player">${icon('plane')}<span class="ranking-name" title="${escapeHTML(player?.name ?? `${color.name}方`)}">${escapeHTML(player?.name ?? `${color.name}方`)}</span>${seat === state.you.seat ? '<span class="you-tag">我</span>' : ''}</span>${statsMarkup(seat, 'ranking-stats')}</li>`;
  }).join('');
}
function renderTurn() {
  const game = state.game;
  const spectator = state.you.seat === null;
  $('dice-area').hidden = !game;
  $('lobby-progress').hidden = !!game;
  $('move-options').hidden = true;
  $('turn-countdown').hidden = !game || game.status !== 'playing' || !game.deadline;
  if (!game) {
    $('turn-label').textContent = '准备起飞';
    $('turn-title').textContent = spectator ? '观战席已就绪' : '好朋友，快就位';
    $('turn-description').textContent = spectator ? '你可以点击空座位加入本局。' : `你是${COLORS[state.you.seat].name}色，等待大家入座。`;
    return;
  }
  if (game.status === 'finished') {
    const rank = playerRank(state.you.seat);
    $('turn-label').textContent = '航程圆满结束';
    $('turn-title').textContent = rank ? `本局第${rank}名` : '本局名次已排定';
    $('turn-description').textContent = '查看各机队名次和踩次数，下一局再比比好运气。';
    $('board-hint').innerHTML = `${icon('trophy')} ${rank ? `你获得第${rank}名` : '本局已结束'} · 查看下方名次榜`;
    $('roll-button').textContent = '本局已结束';
    $('roll-button').disabled = true;
    renderDice(game.dice);
    return;
  }
  const player = currentPlayer(game.turn);
  const color = COLORS[game.turn];
  $('turn-label').textContent = `第 ${game.turn + 1} 座 · ${color.name}色回合`;
  if (diceRolling) {
    $('turn-title').textContent = '正在摇骰子…';
    $('turn-description').textContent = '骰子正在转动，马上揭晓点数。';
    $('board-hint').textContent = '正在摇骰子，请稍候…';
  } else if (!connected) {
    $('turn-title').textContent = '正在恢复连接…';
    $('turn-description').textContent = '请稍候，连接恢复后可以继续操作。';
    $('board-hint').textContent = '网络连接中断，正在自动重连';
  } else if (playerAfk(game.turn)) {
    const phase = game.phase === 'roll' ? '掷骰阶段' : '走棋阶段';
    $('turn-title').textContent = `${player?.name ?? `${color.name}色玩家`}已挂机`;
    $('turn-description').textContent = `其他未挂机参赛者可跳过其${phase}；超时后系统仍自动走棋。`;
    $('board-hint').textContent = state.you.seat === game.turn ? `你已挂机 · 可取消挂机恢复操作，或由其他参赛者跳过当前${phase}` : canSkipAfk() ? `${player?.name ?? '玩家'}已挂机 · 可跳过其${phase}，或等待超时自动走棋` : `${player?.name ?? '玩家'}已挂机 · 等待参赛者跳过${phase}，或超时自动走棋`;
  } else if (myTurn()) {
    const reroll = game.rerollOffered && !game.legal.length;
    $('turn-title').textContent = game.phase === 'roll' ? '轮到你啦！' : reroll ? '重掷，还是接受？' : '选择一架飞机';
    $('turn-description').textContent = game.phase === 'roll' ? '点击掷骰子，看看好运会带你飞多远。' : reroll ? `掷出了 ${game.dice}，当前没有可移动的飞机；可在机长栏重掷或接受当前点数。` : `掷出了 ${game.dice}，点击棋盘上亮起的飞机移动。`;
    $('board-hint').innerHTML = game.phase === 'roll' ? `你是<strong>${color.name}色</strong> · 现在可以掷骰子` : reroll ? '当前无可移动飞机 · 可在机长栏重掷或接受点数' : '选择一架<strong>亮起的飞机</strong>，准备出发';
  } else {
    $('turn-title').textContent = `${player?.name ?? `${color.name}色玩家`}的回合`;
    $('turn-description').textContent = game.phase === 'roll' ? '等待对方掷骰子，下一份好运正在路上。' : `对方掷出了 ${game.dice}，正在选择飞机。`;
    const rank = playerRank(state.you.seat);
    $('board-hint').textContent = rank ? `你已获得第${rank}名 · 其余机队继续飞行` : spectator ? `正在观战 · 等待${player?.name ?? '玩家'}操作` : playerAfk(state.you.seat) ? `你已挂机 · 等待${player?.name ?? '玩家'}操作，可取消挂机恢复` : `你是${COLORS[state.you.seat].name}色 · 等待${player?.name ?? '玩家'}操作`;
  }
  if (!diceRolling && selectedRules().captains && game.phase === 'move') {
    const bonus = (game.steps ?? game.dice) - game.dice;
    const label = captainState(game.turn)?.key === 'flash' ? '闪现被动' : '复仇';
    $('board-hint').insertAdjacentHTML('beforeend', `<span class="dice-steps">骰面 ${game.dice} 点 · 实际步数 ${game.steps ?? game.dice}${bonus > 0 ? `（${label} +${bonus}）` : ''}</span>`);
  }
  $('roll-button').innerHTML = `${diceRolling ? '摇骰中…' : busy ? '请稍候…' : playerAfk(game.turn) ? '当前玩家已挂机' : myTurn() && game.phase === 'roll' ? '掷骰子' : game.phase === 'move' ? '正在选飞机' : '等待掷骰子'}${icon('arrow')}`;
  $('roll-button').disabled = !canWrite() || !myTurn() || game.phase !== 'roll';
  $('dice').classList.toggle('is-rollable', canWrite() && myTurn() && game.phase === 'roll');
  renderDice(game.dice);
  if (!diceRolling && myTurn() && game.phase === 'move' && game.legal.length) {
    $('move-options').hidden = false;
    const moveKey = JSON.stringify([game.legal, game.reserveSteps?.[state.you.seat]]);
    if ($('move-options').dataset.key !== moveKey) {
      $('move-options').innerHTML = game.legal.map((piece) => `<button class="move-option" type="button" data-piece="${piece}" ${canWrite() ? '' : 'disabled'}>飞机 ${piece + 1}${game.pieces[state.you.seat][piece] === TAKEOFF && game.reserveSteps?.[state.you.seat]?.[piece] ? '（保留 +1）' : ''}</button>`).join('');
      $('move-options').dataset.key = moveKey;
    }
    $('move-options').querySelectorAll('button').forEach((button) => { button.disabled = !canWrite(); });
  }
  updateCountdown();
}
function renderDice(value) {
  if (diceRolling) return;
  paintDice(value);
}
function paintDice(value, decorative = false) {
  const dots = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] }[value] ?? [];
  $('dice').querySelectorAll('.dice-dot').forEach((dot, index) => { dot.style.opacity = dots.includes(index) ? '1' : '0'; });
  $('dice').setAttribute('aria-label', decorative ? '骰子正在转动' : value ? `骰子 ${value} 点` : '等待掷骰子');
}
function animateDice(value = null) {
  if (!diceRolling) {
    diceRolling = true;
    diceTarget = null;
    diceStartedAt = performance.now();
    let face = state?.game?.dice || 1;
    $('dice').classList.remove('settled');
    $('dice').classList.add('rolling');
    $('dice').setAttribute('aria-busy', 'true');
    paintDice(face, true);
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      diceFaceTimer = setInterval(() => {
        face = face % 6 + 1;
        paintDice(face, true);
      }, 42.5);
    }
  }
  if (value !== null) {
    diceTarget = value;
    clearTimeout(diceFinishTimer);
    diceFinishTimer = setTimeout(() => {
      const result = diceTarget;
      cancelDiceAnimation(result);
      $('dice').classList.add('settled');
      if (state) render();
    }, Math.max(100, 500 - (performance.now() - diceStartedAt)));
  }
}
function cancelDiceAnimation(value = null) {
  clearInterval(diceFaceTimer);
  clearTimeout(diceFinishTimer);
  diceRolling = false;
  diceTarget = null;
  $('dice').classList.remove('rolling', 'settled');
  $('dice').removeAttribute('aria-busy');
  paintDice(value);
}
function updateCountdown() {
  if (!state?.game || !isPlaying() || !state.game.deadline) return;
  const seconds = Math.max(0, Math.ceil((state.game.deadline - Date.now()) / 1000));
  $('turn-countdown').innerHTML = `${icon('clock')}${seconds} 秒`;
}
function renderLog() {
  const entries = state.game?.log ?? [];
  const key = JSON.stringify(entries);
  if (key !== logKey) {
    const log = $('activity-log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
    log.innerHTML = entries.length ? entries.slice(-40).map((entry) => `<p>${escapeHTML(entry.text)}</p>`).join('') : '<p class="empty-log">美好的一局，即将开始。</p>';
    if (atBottom) log.scrollTop = log.scrollHeight;
    logKey = key;
  }
  $('spectator-count').textContent = `${state.players.filter((player) => player.seat === null).length} 人观战`;
}
function rememberKeyEventsView() {
  if (!$('key-events-panel').open) return;
  const list = $('key-events-list');
  const anchor = list.scrollTop >= 5 ? [...list.children].find(row => row.offsetTop + row.offsetHeight > list.scrollTop) : null;
  keyEventsView = { id: anchor?.dataset.keyEventId ?? null, offset: anchor ? anchor.offsetTop - list.scrollTop : 0, scrollTop: list.scrollTop };
}
function restoreKeyEventsView() {
  if (!$('key-events-panel').open) return;
  const list = $('key-events-list');
  const anchor = [...list.children].find(row => row.dataset.keyEventId === keyEventsView.id);
  list.scrollTop = keyEventsView.scrollTop < 5 ? 0 : anchor ? anchor.offsetTop - keyEventsView.offset : keyEventsView.scrollTop;
}
function renderKeyEvents() {
  const panel = $('key-events-panel'), list = $('key-events-list');
  panel.hidden = !state.game;
  if (!state.game) {
    keyEventsKey = keyEventsRoom = '';
    keyEventsView = { id: null, offset: 0, scrollTop: 0 };
    list.replaceChildren();
    panel.open = true;
    return;
  }
  if (keyEventsRoom !== state.id) {
    keyEventsRoom = state.id;
    keyEventsKey = '';
    list.replaceChildren();
    list.scrollTop = 0;
    keyEventsView = { id: null, offset: 0, scrollTop: 0 };
    panel.open = true;
  }
  const seen = new Set();
  const entries = (state.game.keyEvents ?? []).filter(entry => {
    if (!entry || !Number.isSafeInteger(entry.id) || entry.id < 1 || seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  }).slice(-50).reverse();
  const key = `ids:${entries.map(entry => entry.id).join(',')}`;
  if (key === keyEventsKey) return;
  rememberKeyEventsView();
  const retained = new Set(entries.map(entry => entry.id));
  const rows = new Map([...list.querySelectorAll('[data-key-event-id]')].map(row => [row.dataset.keyEventId, row]));
  for (const row of [...list.children]) if (!retained.has(Number(row.dataset.keyEventId))) row.remove();
  let before = list.firstElementChild;
  for (const entry of entries) {
    let row = rows.get(String(entry.id));
    if (!row) {
      const date = new Date(entry.at);
      const time = Number.isNaN(date.getTime()) ? '--:--:--' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      row = document.createElement('li');
      row.className = 'key-event-row';
      row.dataset.keyEventId = entry.id;
      row.dataset.keyEventType = entry.type;
      row.innerHTML = `<div class="key-event-meta"><span class="key-event-type">${escapeHTML(KEY_EVENT_NAMES[entry.type] ?? '事件')}</span><time class="key-event-time">${escapeHTML(time)}</time></div><p class="key-event-text">${escapeHTML(entry.text)}</p>`;
    }
    if (row !== before) list.insertBefore(row, before);
    before = row.nextElementSibling;
  }
  if (!entries.length) list.innerHTML = '<li class="key-event-empty">关键时刻会记录在这里。</li>';
  // Keep the same visible record when a newer event is prepended or the oldest expires.
  restoreKeyEventsView();
  const latest = entries[0];
  const preview = latest ? `${KEY_EVENT_NAMES[latest.type] ?? '事件'} · ${latest.text}` : '暂无关键事件';
  $('key-events-preview').textContent = preview;
  $('key-events-preview').title = preview;
  $('key-events-count').textContent = `最近 ${entries.length} 条 · 最多保留 50 条`;
  keyEventsKey = key;
}
function setRoleError(message = '') {
  $('role-error').textContent = message;
  $('role-error').hidden = !message;
}
function displayedRoleCode() {
  return String(state?.you.takeoverCode ?? '').replace(/^(.{4})(.{4})(.{4})$/, '$1-$2-$3');
}
function clearRoleDialog() {
  roleDialogMode = null;
  $('own-role-code').value = '';
  $('takeover-code').value = '';
  setRoleError();
}
function closeRoleDialog() {
  if ($('role-dialog').open) $('role-dialog').close();
  clearRoleDialog();
}
function renderRoleTools() {
  const ownCode = state.you.seat !== null && !!state.you.takeoverCode && !playerRank(state.you.seat);
  const canTakeover = isPlaying() && state.you.seat === null && state.game.active.some(seat => !playerRank(seat));
  $('role-tools').hidden = !ownCode && !canTakeover && !canManageRoom();
  $('role-code-button').hidden = !ownCode;
  $('role-code-button').disabled = busy;
  $('takeover-button').hidden = !canTakeover;
  $('takeover-button').disabled = !canWrite();
  if (!$('role-dialog').open) return;
  if (roleDialogMode === 'code') {
    if (!ownCode) { closeRoleDialog(); return; }
    $('own-role-code').value = displayedRoleCode();
    $('role-title').textContent = `${COLORS[state.you.seat].name}色角色代码`;
  } else if (roleDialogMode === 'takeover') {
    if (!canTakeover) { closeRoleDialog(); return; }
    $('takeover-code').disabled = busy;
    $('role-submit').disabled = !canWrite();
    $('role-submit').textContent = busy ? '正在接管…' : '接管并继续游戏';
  }
}
function renderAfkControls() {
  const own = unfinishedParticipant(state.you.seat), skip = canSkipAfk();
  $('afk-tools').hidden = !own && !skip;
  $('afk-toggle').hidden = !own;
  $('afk-toggle').textContent = playerAfk(state.you.seat) ? '取消挂机' : '挂机';
  $('afk-toggle').disabled = !canWrite() || !own;
  $('afk-skip').hidden = !skip;
  $('afk-skip').textContent = state.game?.phase === 'move' ? '跳过其走棋阶段' : '跳过其掷骰阶段';
  $('afk-skip').disabled = !canWrite() || !skip;
}
function showRoleDialog(mode) {
  if (mode === 'code' ? !state?.you.takeoverCode || state.you.seat === null || playerRank(state.you.seat) : !isPlaying() || state.you.seat !== null) return;
  clearRoleDialog();
  roleDialogMode = mode;
  const showCode = mode === 'code';
  $('role-code-view').hidden = !showCode;
  $('role-takeover-form').hidden = showCode;
  $('role-title').textContent = showCode ? `${COLORS[state.you.seat].name}色角色代码` : '接管朋友的角色';
  $('role-description').textContent = showCode ? '将代码交给接替的人。接管后你将转为观战，飞机和回合保留；代码使用后会更新。' : '输入朋友的角色代码，即可代替对方继续这一局。原玩家将转为观战，飞机和回合保留。';
  if (showCode) $('own-role-code').value = displayedRoleCode();
  $('role-dialog').showModal();
  renderRoleTools();
  $(showCode ? 'own-role-code' : 'takeover-code').focus();
}
async function copyRoleCode() {
  if (roleDialogMode !== 'code' || !state?.you.takeoverCode || state.you.seat === null) return;
  const input = $('own-role-code');
  input.value = displayedRoleCode();
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(input.value);
    notify('角色代码已复制，请发给接替的人。');
  } catch {
    input.focus(); input.select(); input.setSelectionRange(0, input.value.length);
    try { document.execCommand('copy') ? notify('角色代码已复制，请发给接替的人。') : notify('请长按或全选角色代码复制。'); } catch { notify('请长按或全选角色代码复制。'); }
  }
}
function canManageRoom() {
  return !!state?.you.host && Array.isArray(state.you.takeoverCodes) && connected && !hostControlsRevoked;
}
function closeHostDialog() {
  if ($('host-dialog').open) $('host-dialog').close();
  $('host-player-list').replaceChildren();
  hostListKey = '';
}
function cancelKickConfirmation() {
  if (!kickConfirmation) return;
  kickConfirmation = null;
  dialogAction = null;
  if ($('confirm-dialog').open) $('confirm-dialog').close();
}
function renderHostTools() {
  const allowed = canManageRoom();
  $('host-tools-button').hidden = !allowed;
  $('host-tools-button').disabled = busy;
  if (!allowed) {
    closeHostDialog();
    cancelKickConfirmation();
    return;
  }
  if (kickConfirmation && (state.game || state.id !== kickConfirmation.roomId || state.you.id !== kickConfirmation.hostId || !state.players.some(player => player.id === kickConfirmation.playerId))) cancelKickConfirmation();
  if (!$('host-dialog').open) return;
  $('host-description').textContent = isPlaying() ? '管理未完成玩家的挂机状态，或将接管码交给接替的人。挂机不重置倒计时，超时仍由系统自动走棋。' : state.game ? '查看本局角色与名次，已结束的玩家不可设置挂机。' : '查看各角色接管码；开始游戏前，可将其他成员移出房间。';
  const key = JSON.stringify([state.players, state.game?.players, state.you.takeoverCodes, state.game?.status]);
  if (key !== hostListKey) {
    const focus = document.activeElement;
    const focusedPlayer = focus?.dataset.playerId;
    const focusedAction = focus?.dataset.hostAction;
    const codes = new Map(state.you.takeoverCodes.map(entry => [entry.id, entry.code]));
    const rows = state.players.map(player => {
      const row = document.createElement('article');
      row.className = 'host-player';
      const heading = document.createElement('div');
      heading.className = 'host-player-heading';
      const name = document.createElement('strong');
      name.textContent = player.name;
      const status = document.createElement('span');
      status.className = 'host-player-status';
      const role = player.seat === null ? '观战' : `${COLORS[player.seat].name}色`;
      status.textContent = `${role} · ${player.online ? '在线' : '离线'}${playerAfk(player.seat) ? ' · 挂机' : ''}${player.id === state.you.id ? ' · 房主' : ''}`;
      heading.append(name, status);
      row.append(heading);
      const rank = playerRank(player.seat);
      const code = player.seat === null || rank ? null : codes.get(player.id);
      if (code) {
        const field = document.createElement('input');
        field.className = 'copy-field host-code-field';
        field.type = 'text';
        field.readOnly = true;
        field.autocomplete = 'off';
        field.spellcheck = false;
        field.value = String(code).replace(/^(.{4})(.{4})(.{4})$/, '$1-$2-$3');
        field.setAttribute('aria-label', `${player.name}的接管码`);
        field.dataset.playerId = player.id;
        row.append(field);
      } else {
        const empty = document.createElement('p');
        empty.className = 'host-code-empty';
        empty.textContent = rank ? `已获得第${rank}名，本局不可接管` : player.seat === null ? '观战成员暂无接管码' : '暂无接管码';
        row.append(empty);
      }
      const actions = document.createElement('div');
      actions.className = 'host-player-actions';
      const addButton = (label, hostAction) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `text-button${hostAction === 'kick' ? ' host-kick-button' : ''}`;
        button.textContent = label;
        button.dataset.playerId = player.id;
        button.dataset.hostAction = hostAction;
        button.setAttribute('aria-label', `${label}：${player.name}`);
        actions.append(button);
      };
      if (code) addButton('复制接管码', 'copy');
      if (canSetAfk(player.seat)) addButton(playerAfk(player.seat) ? '取消挂机' : '挂机', 'afk');
      if (!state.game && player.id !== state.you.id) addButton('移出房间', 'kick');
      row.append(actions);
      return row;
    });
    $('host-player-list').replaceChildren(...rows);
    if (focusedPlayer && focusedAction) [...$('host-player-list').querySelectorAll('button')].find(button => button.dataset.playerId === focusedPlayer && button.dataset.hostAction === focusedAction)?.focus({ preventScroll: true });
    hostListKey = key;
  }
  $('host-player-list').querySelectorAll('button').forEach(button => { button.disabled = ['kick', 'afk'].includes(button.dataset.hostAction) ? !canWrite() : busy; });
}
function togglePlayerAfk(playerId) {
  if (!canManageRoom() || !canWrite() || !$('host-dialog').open) return;
  const target = state.players.find(player => player.id === playerId);
  if (!target || !canSetAfk(target.seat)) return;
  action('afk', { targetSeat: target.seat, afk: !playerAfk(target.seat) });
}
function showHostDialog() {
  if (!canManageRoom() || busy) return;
  hostListKey = '';
  $('host-dialog').showModal();
  renderHostTools();
}
async function copyHostCode(playerId) {
  if (!canManageRoom() || !$('host-dialog').open || busy) return;
  const code = state.you.takeoverCodes.find(entry => entry.id === playerId)?.code;
  const input = [...$('host-player-list').querySelectorAll('input')].find(field => field.dataset.playerId === playerId);
  if (!code || !input) return;
  const text = String(code).replace(/^(.{4})(.{4})(.{4})$/, '$1-$2-$3');
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(text);
    notify('接管码已复制，请交给接替的人。');
  } catch {
    if (!canManageRoom() || !$('host-dialog').open || !input.isConnected) return;
    input.focus(); input.select(); input.setSelectionRange(0, input.value.length);
    try { document.execCommand('copy') ? notify('接管码已复制，请交给接替的人。') : notify('请长按或全选接管码复制。'); } catch { notify('请长按或全选接管码复制。'); }
  }
}
function confirmKick(playerId) {
  if (!canManageRoom() || !canWrite() || state.game || !$('host-dialog').open || playerId === state.you.id) return;
  const target = state.players.find(player => player.id === playerId);
  if (!target) return;
  const expected = { roomId: state.id, hostId: state.you.id, playerId };
  showConfirm('将成员移出房间？', `确认移出“${target.name}”？对方的当前连接和接管码将失效，需要重新加入房间。`, '确认移出', async () => {
    kickConfirmation = null;
    if (!canManageRoom() || !canWrite() || state.game || state.id !== expected.roomId || state.you.id !== expected.hostId || !state.players.some(player => player.id === expected.playerId)) return;
    if (await action('kick', { playerId: expected.playerId })) notify('已将该成员移出房间。');
  });
  $('dialog-cancel').textContent = '取消';
  kickConfirmation = expected;
}
function render() {
  if (!state) return;
  renderConnection();
  renderSeats();
  renderMode();
  const game = !!state.game;
  $('game-header-tools').hidden = !game;
  $('lobby-panel').hidden = game;
  $('lobby-start').hidden = game;
  $('game-panel').hidden = !game;
  renderCaptainSelection();
  $('room-title').textContent = game ? state.game.status === 'finished' ? '圆满降落' : '飞行棋' : '候机大厅';
  $('room-eyebrow').textContent = game ? state.game.status === 'finished' ? '每一段快乐航程，都值得再来一局' : '下一站，好运气' : '大家就位，好运准备起飞';
  $('end-game').hidden = !game || !state.you.host;
  $('end-game').disabled = !canWrite();
  $('end-game').textContent = state.game?.status === 'finished' ? '返回候机大厅' : '结束游戏';
  $('table-footer').textContent = !connected ? '正在重新连接，请暂时等待' : state.you.seat === null ? '你正在观战 · 和朋友一起见证好运' : game ? `${COLORS[state.you.seat].name}色机队 · ${state.you.host ? '你是房主' : '祝你好运'}` : '入座后，等待房主开始游戏';
  if (!game) renderLobby();
  else renderBoard();
  renderTurn();
  renderRankings();
  renderLog();
  renderKeyEvents();
  renderRoleTools();
  renderAfkControls();
  renderHostTools();
  renderStrategy();
  $('home-button').disabled = busy;
  applyDockingLayout();
}

function xy(position) { return [(position[1] + .5) * UNIT, (position[0] + .5) * UNIT]; }
function boardBase(idPrefix = 'game', mode = 'classic', iceCell = null, rules, mines = []) {
  return renderBoardBase(idPrefix, mode, iceCell, rules, mines);
}
function pieceMarkup(seat, piece, progress, position, legal = false, offset = [0, 0], scale = 1, shadowId = 'piece-shadow') {
  const [px, py] = xy(position);
  const x = px + offset[0];
  const y = py + offset[1];
  const color = COLORS[seat];
  const finished = progress >= FINISH;
  const shielded = selectedRules().captains && state?.game?.shields?.[seat]?.[piece] === true && progress >= 0 && !finished;
  const reserved = selectedRules().captains && state?.game?.reserveSteps?.[seat]?.[piece] === true && !finished;
  const frozen = state?.game?.mode === 'fun' && state.game.frozenPieces?.[seat]?.[piece] === true && progress >= 0 && !finished;
  const physical = (STARTS[seat] + progress) % 52;
  const special = state?.game?.mode === 'fun' && progress >= 0 && progress <= 50 ? selectedRules().ice && state.game.iceCell === physical ? 'ice' : enabledSpecial(physical) : null;
  const specialLabel = { safe: '安全岛，免疫撞击', speed: '加速格', trap: '陷阱格', lucky: '幸运格', ice: '冰冻格' }[special];
  const label = `${color.name}色飞机 ${piece + 1}，${finished ? '已抵达' : progress === TAKEOFF ? '在本色停机坪' : progress < 0 ? '在机场' : `第 ${progress + 1} 格`}${specialLabel ? `，${specialLabel}` : ''}${frozen ? '，已冰冻，须掷出 6 点才能移动' : ''}${shielded ? '，护盾可抵挡一次撞击' : ''}${reserved ? '，下次离开停机坪保留进度加 1' : ''}${legal ? '，点击移动' : ''}`;
  const pieceSkinObj = PIECE_SKINS.find(s => s.id === currentPieceSkin) || PIECE_SKINS[0];
  const heading = visualHeadingFor(seat, progress, piece) + (pieceSkinObj.headingOffsets?.[seat] ?? 0);
  const pieceGraphic = finished
    ? `<path d="m-5 0 3.5 3.5L6-4" fill="none" stroke="${color.hex}" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"/>`
    : pieceSkinObj.type === 'sprite'
      ? `<image class="plane-sprite" href="/skins/${pieceSkinObj.id}/${seat}.png" x="-11.5" y="-11.5" width="23" height="23" preserveAspectRatio="xMidYMid meet"/>`
      : `<path class="plane-shape plane-skin-${pieceSkinObj.id}" d="${pieceSkinObj.path}"/>`;
  return `<g class="piece piece-skin-${pieceSkinObj.id} ${frozen ? 'is-frozen ' : ''}${legal ? `is-legal${canWrite() ? '' : ' is-disabled'}` : ''}" style="--piece-color:${color.hex}" transform="translate(${x} ${y}) scale(${scale})" data-piece="${piece}" data-owner="${seat}" data-frozen="${frozen}" role="${legal ? 'button' : 'img'}" aria-label="${escapeHTML(label)}" ${legal ? `tabindex="0" aria-disabled="${!canWrite()}"` : ''}>
    <title>${escapeHTML(label)}</title>${legal ? '<circle class="piece-halo" r="19"/>' : ''}
    ${shielded ? '<circle class="piece-shield" r="17.5" fill="none" stroke="#91e5ff" stroke-width="1.8" stroke-dasharray="4 2" pointer-events="none"/>' : ''}
    <circle class="piece-ring" r="15" filter="url(#${shadowId})"/><circle class="piece-core" r="11.9"/>
    <g class="piece-graphic"${finished ? '' : ` transform="rotate(${heading})"`}>${pieceGraphic}</g>
    <circle cx="10" cy="10" r="5.3" fill="#f5f8ff"/><text class="piece-number" x="10" y="13">${piece + 1}</text>
    ${frozen ? '<g class="frozen-mark" transform="translate(-11 -11)" pointer-events="none"><circle r="6.5" fill="#103759" stroke="#b9f3ff" stroke-width="1"/><path d="M0-4V4M-3.5-2L3.5 2M-3.5 2L3.5-2" fill="none" stroke="#dffaff" stroke-width="1.1" stroke-linecap="round"/></g>' : ''}
  </g>`;
}
function piecesMarkup(pieces, seats, interactive = false) {
  const shadowId = interactive ? 'piece-shadow' : 'preview-piece-shadow';
  const list = [];
  seats.forEach((seat) => pieces[seat].forEach((progress, piece) => {
    list.push({ seat, piece, progress, position: visualPositionFor(seat, progress, piece), space: visualSpaceFor(seat, progress), legal: interactive && state.you.seat === seat && myTurn() && state.game.phase === 'move' && state.game.legal.includes(piece) });
  }));
  const groups = new Map();
  list.forEach((item) => {
    const key = item.position.join(',');
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  });
  return [...groups.values()].flatMap((group) => {
    const space = group[0].space;
    const rotateOffset = ([x, y]) => {
      for (let turn = 0; turn < space.turns; turn++) [x, y] = [-y, x];
      return [x, y];
    };
    if (group.length === 1) {
      const item = group[0];
      return pieceMarkup(item.seat, item.piece, item.progress, item.position, item.legal, [0,0], space.kind === 'takeoff' ? .75 : 1, shadowId);
    }
    if (space.kind === 'takeoff') {
      const offsets = [[-7,-8],[7,-8],[-6,9],[5,1]];
      return group.map((item, index) => pieceMarkup(item.seat, item.piece, item.progress, item.position, item.legal, rotateOffset(offsets[index]), .55, shadowId));
    }
    const columns = Math.ceil(Math.sqrt(group.length));
    const rows = Math.ceil(group.length / columns);
    const gap = group.length > 4 ? 10 : 14;
    const scale = group.length > 4 ? .47 : .67;
    return group.map((item, index) => {
      const offset = [(index % columns - (columns - 1) / 2) * gap, (Math.floor(index / columns) - (rows - 1) / 2) * gap];
      return pieceMarkup(item.seat, item.piece, item.progress, item.position, item.legal, offset, scale, shadowId);
    });
  }).join('');
}
function renderBoard() {
  const activeSeats = state.players.filter((player) => player.seat !== null).map((player) => player.seat);
  const key = JSON.stringify([currentPieceSkin, currentBoardSkin, state.game.mode, state.game.rules, state.game.pieces, state.game.iceCell, state.game.frozenPieces, state.game.shields, state.game.reserveSteps, state.game.mines, activeSeats, state.game.phase, state.game.turn, state.game.legal, state.you.seat, canWrite(), playerAfk(state.you.seat)]);
  if (key === boardKey) return;
  const focus = document.activeElement?.closest?.('.piece');
  const focusedPiece = focus?.dataset.piece;
  const focusedOwner = focus?.dataset.owner;
  $('game-board').innerHTML = `<svg class="board-svg" viewBox="-4 -4 ${SIZE + 8} ${SIZE + 8}" xmlns="http://www.w3.org/2000/svg" role="group" aria-label="${state.game.mode === 'fun' ? '趣味' : '经典'}飞行棋棋盘">${boardBase('game', state.game.mode, state.game.iceCell, state.game.rules, state.game.mines)}${piecesMarkup(state.game.pieces, activeSeats, true)}</svg>`;
  if (focusedPiece != null) $('game-board').querySelector(`.piece[data-piece="${focusedPiece}"][data-owner="${focusedOwner}"][tabindex]`)?.focus({ preventScroll: true });
  boardKey = key;
}
function clearCaptureEffects() {
  clearTimeout(captureTimer);
  $('capture-effects').replaceChildren();
  $('capture-effects').toggleAttribute('hidden', true);
  $('capture-callout').hidden = true;
  $('capture-callout').removeAttribute('data-move-id');
  $('capture-callout').removeAttribute('data-event');
  $('capture-fact').textContent = '';
  $('capture-quote').textContent = '';
}
function missileEffectMarkup(move, event, captured) {
  const target = captured.find(hit => hit.seat === event.targetSeat && hit.piece === event.targetPiece)
    ?? (Number.isInteger(event.targetSeat) && COLORS[event.targetSeat] && Number.isInteger(event.targetPiece) && event.targetPiece >= 0 && event.targetPiece < 4 && Number.isInteger(event.targetFrom) && event.targetFrom >= 0 && event.targetFrom <= 50 ? { seat: event.targetSeat, piece: event.targetPiece, from: event.targetFrom } : null);
  if (!target || !Number.isInteger(event.from) || event.from < 0 || event.from > 50) return '';
  const [x, y] = xy(visualPositionFor(move.seat, event.from, move.piece));
  const [toX, toY] = xy(visualPositionFor(target.seat, target.from, target.piece));
  const angle = Math.atan2(toY - y, toX - x) * 180 / Math.PI;
  return `<g class="missile-effect" data-from="${x},${y}" data-to="${toX},${toY}" data-target-seat="${target.seat}" data-target-piece="${target.piece}">
    <path class="missile-trail" d="M${x} ${y}L${toX} ${toY}" pathLength="1"/>
    <g transform="translate(${x} ${y})"><g class="missile-flight" style="--missile-x:${toX - x}px;--missile-y:${toY - y}px"><g transform="rotate(${angle})"><path d="M-9-3-17 0-9 3Z" fill="#ff8f47"/><path d="M10 0 3-5H-9V5H3Z" fill="#fff2cb" stroke="#ffd65e" stroke-width="1.4"/><path d="M-6-3-10-8-2-4M-6 3-10 8-2 4" fill="#ffd65e"/><circle cx="2" r="1.8" fill="#ff7747"/></g></g></g>
    <g transform="translate(${toX} ${toY})"><g class="missile-impact"><circle r="12" fill="#fff1ad"/><path d="M0-31 5-13 19-22 13-5 31 0 13 5 19 22 5 13 0 31-5 13-19 22-13 5-31 0-13-5-19-22-5-13Z" fill="#ffd65e" fill-opacity=".85"/></g></g>
  </g>`;
}
function syncCaptureEffects(previous, next, baseline = false) {
  const game = next.game;
  const move = game?.lastMove;
  const id = Number.isInteger(move?.id) ? move.id : null;
  const previousId = captureMoveId;
  captureMoveId = id;
  // Initial, reconnect and role-transfer snapshots establish a baseline only.
  // The same move can also arrive through both SSE and an action response.
  if (baseline || !previous?.game || previous.id !== next.id || game?.status !== 'playing' || (id !== null && previousId !== null && id < previousId)) {
    clearCaptureEffects();
    return;
  }
  if (id === null || id === previousId) return;
  clearCaptureEffects();
  if (game.mode === 'fun' && !normalizeRules(game.mode, game.rules).captureEffects) return;
  if (!Number.isInteger(move.seat) || !COLORS[move.seat] || !Number.isInteger(move.piece) || move.piece < 0 || move.piece > 3) return;
  const wall = move.events?.find(event => ['WALL_BREAK', 'WALL_BOUNCE'].includes(event.type) && Number.isInteger(event.at) && event.at >= 0 && event.at <= 50);
  const mineHit = move.returnReason === 'mine' ? move.events?.find(event => event.type === 'MINE_HIT') : null;
  const missileEvent = move.events?.find(event => event.type === 'MISSILE');
  const extra = mineHit ?? missileEvent ?? move.events?.find(event => ['MINE_HIT', 'STUN', 'MINE_SET', 'AMBUSH', 'SHIELD_SET', 'SHIELD_BLOCK', 'ALLY_SWAP', 'SKILL_FLASH', 'REVENGE_CHASE'].includes(event.type));
  const captured = (move.captured ?? []).filter(hit => Number.isInteger(hit.seat) && COLORS[hit.seat] && Number.isInteger(hit.piece) && hit.piece >= 0 && hit.piece < 4 && Number.isInteger(hit.from) && hit.from >= 0 && hit.from <= 50);
  if (!wall && !extra && (game.mode !== 'fun' || !captured.length)) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const name = currentPlayer(move.seat)?.name ?? `${COLORS[move.seat].name}方`;
  $('capture-callout').dataset.moveId = String(id);
  const eventType = mineHit?.type ?? wall?.type ?? extra?.type ?? 'CAPTURE';
  const missileBlocked = missileEvent && move.events?.some(event => event.type === 'SHIELD_BLOCK' && event.targetSeat === missileEvent.targetSeat && event.targetPiece === missileEvent.targetPiece);
  const captureFact = captured.length ? ` · 撞飞 ${captured.length} 架敌机` : '';
  const facts = { MINE_HIT: `${name}踩中地雷 · 返回机场`, MISSILE: missileBlocked ? `${name}发射导弹 · 被${seatName(extra.targetSeat)}的护盾挡下` : `${name}使用导弹 · 击落 ${captured.length} 架敌机`, STUN: `${name}使用定身 · ${seatName(extra?.targetSeat)}的飞机被冻结`, MINE_SET: `${name}埋下一枚公开地雷`, AMBUSH: `${name}背叛奖励 · 撞飞后额外前进最多 2 格`, SHIELD_SET: `${name}为 ${move.piece + 1} 号飞机加上护盾`, SHIELD_BLOCK: `${seatName(extra?.targetSeat)}的 ${(extra?.targetPiece ?? 0) + 1} 号飞机 · 护盾挡下撞击`, ALLY_SWAP: `${name}与${seatName(extra?.targetSeat)}交换飞机位置`, SKILL_FLASH: `${name}闪现前进 ${Math.max(0, (extra?.to ?? 0) - (extra?.from ?? 0))} 格${captureFact}`, REVENGE_CHASE: `${name}追到${seatName(extra?.targetSeat)}的飞机${captureFact}` };
  const quotes = { WALL_BREAK: '此墙不破，我誓不为机！', WALL_BOUNCE: '墙太硬了……我还会回来的！', MINE_HIT: '地雷起飞，免费返航！', MISSILE: missileBlocked ? '护盾挡下一击，下次再来！' : '导弹已锁定，送你返航！', STUN: '寒冰封印，六点再起飞！', MINE_SET: '此路有雷，欢迎绕行！', AMBUSH: '不讲武德，再飞两格！', SHIELD_SET: '护盾就位，安心起飞！', SHIELD_BLOCK: '这一撞，我挡下了！', ALLY_SWAP: '换个位，换个好运气！', SKILL_FLASH: '闪现起飞，再近一步！', REVENGE_CHASE: '我追上你了，这次该我！' };
  $('capture-callout').dataset.event = eventType;
  $('capture-fact').textContent = eventType === 'WALL_BREAK' ? `${name}自爆破墙 · 实际 ${captured.length} 架敌机${move.selfReturned ? '与自己一起' : ''}回家` : eventType === 'WALL_BOUNCE' ? `${name}遇墙反弹` : facts[eventType] ?? `${name}撞回 ${captured.length} 架飞机`;
  $('capture-quote').textContent = missileBlocked ? quotes.MISSILE : move.taunt || quotes[eventType] || '我还会回来的！';
  $('capture-callout').hidden = false;
  $('capture-callout').classList.toggle('is-reduced', reduced);
  if (!reduced) {
    const returned = [...captured];
    if (['WALL_BREAK', 'MINE_HIT'].includes(eventType) && move.selfReturned && Number.isInteger(move.selfReturnFrom) && move.selfReturnFrom >= 0 && move.selfReturnFrom <= 50) returned.push({ seat: move.seat, piece: move.piece, from: move.selfReturnFrom });
    const ghostPlane = seat => `<circle r="18" fill="#071732" fill-opacity=".8" stroke="${COLORS[seat].hex}" stroke-width="2"/><path d="M0-12 3-4 10 3V5L3 3 2 9 5 11V13L0 11-5 13V11L-2 9-3 3-10 5V3L-3-4Z" fill="${COLORS[seat].hex}" stroke="#fff" stroke-width=".8"/>`;
    const ghosts = returned.map(hit => {
      const [x, y] = xy(visualPositionFor(hit.seat, hit.from, hit.piece));
      return `<g transform="translate(${x} ${y})"><g class="captured-ghost${eventType === 'MISSILE' ? ' missile-captured' : ''}">${ghostPlane(hit.seat)}</g></g>`;
    }).join('');
    let pulses = [...new Set([...captured.map(hit => hit.at), wall?.at, extra?.at])].filter(at => Number.isInteger(at) && at >= 0 && at <= 50).map(at => {
      const [x, y] = xy(visualPositionFor(move.seat, at, move.piece));
      return `<circle class="capture-pulse${eventType === 'MISSILE' ? ' missile-pulse' : ''}" cx="${x}" cy="${y}" r="21"/>`;
    }).join('');
    if (eventType === 'STUN' && Number.isInteger(extra.targetSeat) && COLORS[extra.targetSeat] && Number.isInteger(extra.targetPiece) && extra.targetPiece >= 0 && extra.targetPiece < 4 && Number.isInteger(extra.from) && extra.from >= 0 && extra.from <= 50) {
      const [x, y] = xy(visualPositionFor(extra.targetSeat, extra.from, extra.targetPiece));
      pulses += `<circle class="capture-pulse" cx="${x}" cy="${y}" r="21" style="stroke:#b9f3ff"/>`;
    }
    if (['SHIELD_SET', 'SHIELD_BLOCK', 'ALLY_SWAP'].includes(eventType) && Number.isInteger(extra.targetSeat) && COLORS[extra.targetSeat] && Number.isInteger(extra.targetPiece) && extra.targetPiece >= 0 && extra.targetPiece < 4) {
      const progress = eventType === 'ALLY_SWAP' ? extra.targetTo : extra.to;
      if (Number.isInteger(progress) && progress >= 0 && progress < FINISH) {
        const [x, y] = xy(visualPositionFor(extra.targetSeat, progress, extra.targetPiece));
        pulses += `<circle class="capture-pulse" cx="${x}" cy="${y}" r="21" style="stroke:#91e5ff"/>`;
      }
    }
    let bounce = '';
    if (wall?.type === 'WALL_BOUNCE' && Number.isInteger(move.to) && move.to >= 0 && move.to <= 50) {
      const [x, y] = xy(visualPositionFor(move.seat, Math.max(0, wall.at - 1), move.piece));
      const [toX, toY] = xy(visualPositionFor(move.seat, move.to, move.piece));
      bounce = `<g transform="translate(${x} ${y})"><g class="bounced-ghost" style="--bounce-x:${toX - x}px;--bounce-y:${toY - y}px">${ghostPlane(move.seat)}</g></g>`;
    }
    const missile = eventType === 'MISSILE' ? missileEffectMarkup(move, extra, captured) : '';
    $('capture-effects').innerHTML = pulses + ghosts + bounce + missile;
    $('capture-effects').toggleAttribute('hidden', false);
  }
  captureTimer = setTimeout(clearCaptureEffects, 950);
}
function previewBoard() {
  const pieces = [[-1, -1, 9, 30], [-1, -1, 16, 38], [-1, -1, 4, 47], [-1, -1, 11, 32]];
  const dice = '<g class="preview-center-dice"><rect x="284" y="284" width="32" height="32" rx="5" fill="#d8e9f3" stroke="#557184" stroke-width="1.5"/><circle cx="292" cy="292" r="3.3" fill="#344c5c"/><circle cx="308" cy="308" r="3.3" fill="#344c5c"/></g>';
  $('preview-board').innerHTML = `<svg class="board-svg" viewBox="-8 -8 ${SIZE + 16} ${SIZE + 16}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${boardBase('preview')}${piecesMarkup(pieces, [0, 1, 2, 3])}${dice}</svg>`;
}
function applyPieceSkin(id) {
  const found = PIECE_SKINS.find(s => s.id === id);
  if (!found) return;
  currentPieceSkin = id;
  writeStorage(localStorage, PIECE_SKIN_KEY, id);
  document.documentElement.dataset.pieceSkin = id;
  boardKey = '';
  if (state?.game) renderBoard();
  previewBoard();
  renderSkinDialog();
  notify(`已装扮棋子皮肤：${found.name}`);
}
function applyBoardSkin(id) {
  const found = BOARD_SKINS.find(s => s.id === id);
  if (!found) return;
  currentBoardSkin = id;
  writeStorage(localStorage, BOARD_SKIN_KEY, id);
  document.documentElement.dataset.boardSkin = id;
  boardKey = '';
  if (state?.game) renderBoard();
  previewBoard();
  renderSkinDialog();
  notify(`已装扮棋盘皮肤：${found.name}`);
}
function applyPairedTheme(pieceId, boardId) {
  const pieceObj = PIECE_SKINS.find(s => s.id === pieceId);
  const boardObj = BOARD_SKINS.find(s => s.id === boardId);
  if (pieceObj) {
    currentPieceSkin = pieceId;
    writeStorage(localStorage, PIECE_SKIN_KEY, pieceId);
    document.documentElement.dataset.pieceSkin = pieceId;
  }
  if (boardObj) {
    currentBoardSkin = boardId;
    writeStorage(localStorage, BOARD_SKIN_KEY, boardId);
    document.documentElement.dataset.boardSkin = boardId;
  }
  boardKey = '';
  if (state?.game) renderBoard();
  previewBoard();
  renderSkinDialog();
  notify(`已装扮【${pieceObj?.name ?? ''}】全套风格（棋子+棋盘）！`);
}
function renderSkinDialog() {
  const isPieceTab = skinDialogTab === 'piece';
  $('skin-tab-piece').classList.toggle('active', isPieceTab);
  $('skin-tab-piece').setAttribute('aria-selected', String(isPieceTab));
  $('skin-tab-board').classList.toggle('active', !isPieceTab);
  $('skin-tab-board').setAttribute('aria-selected', String(!isPieceTab));
  $('piece-skins-section').hidden = !isPieceTab;
  $('board-skins-section').hidden = isPieceTab;

  $('piece-skins-section').innerHTML = PIECE_SKINS.map((skin) => {
    const isEquipped = currentPieceSkin === skin.id;
    const previewGraphic = skin.type === 'sprite'
      ? `<svg viewBox="-28 -28 56 56" width="60" height="60" xmlns="http://www.w3.org/2000/svg">
          <circle r="26" fill="#0b1d3d" stroke="#1f3765" stroke-width="1.5"/>
          <image href="/skins/${skin.id}/0.png" x="-22" y="-22" width="20" height="20"/>
          <image href="/skins/${skin.id}/1.png" x="2" y="-22" width="20" height="20"/>
          <image href="/skins/${skin.id}/3.png" x="-22" y="2" width="20" height="20"/>
          <image href="/skins/${skin.id}/2.png" x="2" y="2" width="20" height="20"/>
        </svg>`
      : `<svg viewBox="-28 -28 56 56" width="60" height="60" xmlns="http://www.w3.org/2000/svg">
          <circle r="26" fill="#0b1d3d" stroke="#1f3765" stroke-width="1.5"/>
          <g transform="translate(-11, -11) scale(0.8)"><circle r="10" fill="#10d795" opacity="0.25"/><path d="${skin.path}" fill="#10d795"/></g>
          <g transform="translate(11, -11) scale(0.8)"><circle r="10" fill="#ff514b" opacity="0.25"/><path d="${skin.path}" fill="#ff514b"/></g>
          <g transform="translate(-11, 11) scale(0.8)"><circle r="10" fill="#12afe1" opacity="0.25"/><path d="${skin.path}" fill="#12afe1"/></g>
          <g transform="translate(11, 11) scale(0.8)"><circle r="10" fill="#ffd42a" opacity="0.25"/><path d="${skin.path}" fill="#ffd42a"/></g>
        </svg>`;
    return `<div class="skin-card ${isEquipped ? 'is-active' : ''}" data-skin-type="piece" data-skin-id="${skin.id}">
      <span class="skin-badge">${escapeHTML(skin.tag)}</span>
      <div class="skin-preview skin-preview-piece">${previewGraphic}</div>
      <div class="skin-info">
        <div class="skin-name-row">
          <strong class="skin-name">${escapeHTML(skin.name)}</strong>
          ${isEquipped ? '<span class="skin-status-tag">使用中</span>' : ''}
        </div>
        <p class="skin-desc">${escapeHTML(skin.desc)}</p>
      </div>
      <div class="skin-actions-row">
        <button type="button" class="button ${isEquipped ? 'button-secondary' : 'button-primary'} skin-action-btn" data-skin-type="piece" data-skin-id="${skin.id}">
          ${isEquipped ? '✓ 已装备' : '装备皮肤'}
        </button>
        ${skin.matchingBoardId ? `<button type="button" class="button button-secondary skin-pair-btn" data-pair-piece="${skin.id}" data-pair-board="${skin.matchingBoardId}" title="一键同时装备该风格的棋子和棋盘">搭配棋盘</button>` : ''}
      </div>
    </div>`;
  }).join('');

  $('board-skins-section').innerHTML = BOARD_SKINS.map((skin) => {
    const isEquipped = currentBoardSkin === skin.id;
    return `<div class="skin-card ${isEquipped ? 'is-active' : ''}" data-skin-type="board" data-skin-id="${skin.id}">
      <span class="skin-badge">${escapeHTML(skin.tag)}</span>
      <div class="skin-preview skin-preview-board" style="background: ${skin.bg}">
        <svg viewBox="0 0 60 60" width="60" height="60" xmlns="http://www.w3.org/2000/svg">
          <rect width="60" height="60" rx="8" fill="${skin.bg}" stroke="#ffffff20" stroke-width="1"/>
          <rect x="4" y="4" width="16" height="16" rx="4" fill="${skin.colors[0]}" opacity="0.85"/>
          <rect x="40" y="4" width="16" height="16" rx="4" fill="${skin.colors[1]}" opacity="0.85"/>
          <rect x="40" y="40" width="16" height="16" rx="4" fill="${skin.colors[2]}" opacity="0.85"/>
          <rect x="4" y="40" width="16" height="16" rx="4" fill="${skin.colors[3]}" opacity="0.85"/>
          <rect x="25" y="4" width="10" height="16" rx="2" fill="${skin.colors[1]}" opacity="0.6"/>
          <rect x="40" y="25" width="16" height="10" rx="2" fill="${skin.colors[2]}" opacity="0.6"/>
          <rect x="25" y="40" width="10" height="16" rx="2" fill="${skin.colors[3]}" opacity="0.6"/>
          <rect x="4" y="25" width="16" height="10" rx="2" fill="${skin.colors[0]}" opacity="0.6"/>
          <circle cx="30" cy="30" r="5" fill="#ffffff" opacity="0.95"/>
        </svg>
      </div>
      <div class="skin-info">
        <div class="skin-name-row">
          <strong class="skin-name">${escapeHTML(skin.name)}</strong>
          ${isEquipped ? '<span class="skin-status-tag">使用中</span>' : ''}
        </div>
        <p class="skin-desc">${escapeHTML(skin.desc)}</p>
      </div>
      <button type="button" class="button ${isEquipped ? 'button-secondary' : 'button-primary'} skin-action-btn" data-skin-type="board" data-skin-id="${skin.id}">
        ${isEquipped ? '✓ 已装备' : '装备棋盘'}
      </button>
    </div>`;
  }).join('');
}
function openSkinDialog() {
  renderSkinDialog();
  $('skin-dialog').showModal();
}
function cancelBetrayalConfirmation() {
  if (!betrayalConfirmation) return;
  betrayalConfirmation = null;
  dialogAction = null;
  if ($('confirm-dialog').open) $('confirm-dialog').close();
}
function showConfirm(title, description, label, callback) {
  cancelKickConfirmation();
  betrayalConfirmation = null;
  $('dialog-title').textContent = title;
  $('dialog-description').textContent = description;
  $('dialog-confirm').textContent = label;
  $('dialog-cancel').textContent = '继续玩';
  dialogAction = callback;
  $('confirm-dialog').showModal();
}
async function invite() {
  const url = new URL(location.href);
  url.searchParams.set('room', state.id);
  const text = url.href;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(text);
    notify('邀请链接已复制，发给朋友就能加入。');
  } catch {
    $('dialog-title').textContent = '邀请朋友一起起飞';
    $('dialog-description').textContent = `房间号 ${state.id}，复制下方链接分享给朋友。`;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'copy-field';
    input.readOnly = true;
    input.value = text;
    input.setAttribute('aria-label', '房间邀请链接');
    $('dialog-description').append(input);
    $('dialog-cancel').textContent = '关闭';
    $('dialog-confirm').textContent = '复制链接';
    dialogAction = () => {
      input.focus(); input.select(); input.setSelectionRange(0, text.length);
      try { document.execCommand('copy') ? notify('邀请链接已复制。') : notify('请长按或全选邀请链接复制。'); } catch { notify('请长按或全选邀请链接复制。'); }
    };
    $('confirm-dialog').showModal();
    input.focus(); input.select();
  }
}

$('create-room').addEventListener('click', () => enterRoom(true));
$('join-form').addEventListener('submit', (event) => { event.preventDefault(); enterRoom(false); });
$('player-name').addEventListener('input', () => { setEntryError(); writeStorage(localStorage, NAME_KEY, $('player-name').value); });
$('room-code').addEventListener('input', () => { setEntryError(); $('room-code').value = $('room-code').value.replace(/[^a-z0-9]/gi, '').toLowerCase(); });
$('sound-toggle').addEventListener('click', () => { soundEnabled = !soundEnabled; writeStorage(localStorage, SOUND_KEY, String(soundEnabled)); syncSoundButton(); if (soundEnabled) playSound('move'); });
$('turn-sound-toggle')?.addEventListener('click', toggleTurnSound);
$('turn-sound-chip')?.addEventListener('click', toggleTurnSound);
window.addEventListener('resize', updateBoardScale);
window.addEventListener('orientationchange', updateBoardScale);
$('seats').addEventListener('click', (event) => { const button = event.target.closest('[data-seat]'); if (button && !button.disabled) action('seat', { seat: Number(button.dataset.seat) }); });
$('capacity-options').addEventListener('click', (event) => { const button = event.target.closest('[data-capacity]'); if (!button || button.disabled) return; action('capacity', { capacity: Number(button.dataset.capacity) }); });
$('mode-options').addEventListener('click', event => { const button = event.target.closest('[data-mode]'); if (!button || button.disabled || state?.game || !state?.you.host || hostControlsRevoked) return; action('mode', { mode: button.dataset.mode }); });
$('fun-rules').addEventListener('change', event => {
  const input = event.target.closest('[data-rule]');
  if (!input || input.disabled || state?.game || !state?.you.host || !Object.hasOwn(RULE_NAMES, input.dataset.rule)) return;
  action('rules', { rules: { [input.dataset.rule]: input.checked } });
});
$('captain-choices').addEventListener('click', event => {
  const button = event.target.closest('[data-captain]');
  if (!button || button.disabled || !canWrite() || state.game || !selectedRules().captains || state.you.seat === null || !CAPTAINS.some(captain => captain.key === button.dataset.captain)) return;
  action('captain', { captain: button.dataset.captain });
});
$('captain-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!canWrite() || !skillReady()) return;
  const key = captainState(state.you.seat).key;
  const details = { revision: state.revision, turn: state.game.turn, phase: state.game.phase };
  if (['shield', 'betrayer'].includes(key)) {
    const piece = Number($('captain-piece').value);
    if ($('captain-piece').value === '' || !skillSources(key).some(choice => Number(choice.value) === piece)) return;
    details.piece = piece;
  }
  if (['betrayer', 'avenger'].includes(key)) {
    const value = $('captain-target').value;
    if (!skillTargets(key).some(choice => choice.value === value)) return;
    [details.targetSeat, details.targetPiece] = value.split(':').map(Number);
  }
  action('use-skill', details);
});
$('captain-accept').addEventListener('click', () => {
  const captain = captainState(state?.you.seat), game = state?.game;
  if (!canWrite() || !myTurn() || captain?.key !== 'gambler' || captain.used || game.phase !== 'move' || !game.rerollOffered || game.legal.length) return;
  action('accept-roll', { revision: state.revision, turn: game.turn, phase: game.phase });
});
for (const id of ['fun-intro-lobby', 'fun-intro-button']) $(id).addEventListener('click', () => {
  if ((state?.game?.mode ?? state?.mode) !== 'fun') return;
  $('fun-intro-dialog').showModal();
  $('fun-intro-close').focus();
  $('fun-intro-dialog').querySelector('.fun-intro-content').scrollTop = 0;
});
$('fun-intro-close').addEventListener('click', () => $('fun-intro-dialog').close());
$('alliance-invite').addEventListener('click', () => { if (activeParticipant() && !$('alliance-invite').disabled && $('alliance-target').value !== '') action('alliance-invite', { targetSeat: Number($('alliance-target').value) }); });
$('alliance-invitations').addEventListener('click', event => {
  const button = event.target.closest('[data-alliance]');
  if (!button || button.disabled || !activeParticipant() || !['accept', 'decline', 'cancel'].includes(button.dataset.alliance)) return;
  action(`alliance-${button.dataset.alliance}`, { targetSeat: Number(button.dataset.target) });
});
$('alliance-betray').addEventListener('click', () => {
  if ($('alliance-betray').disabled || !activeParticipant()) return;
  const expected = { roomId: state.id, seat: state.you.seat, ally: state.game.allies[state.you.seat] };
  showConfirm('背叛盟友？', '联盟将解除，你获得叛徒buff（两张随机道具，下轮掷骰翻倍，3轮内所有人踩你都可获得一张道具）；被背叛盟友将获得专属追杀卡；每人每局只能背叛一次。', '确认背叛', () => {
    betrayalConfirmation = null;
    if (!canWrite() || !activeParticipant() || state.id !== expected.roomId || state.you.seat !== expected.seat || state.game.allies[state.you.seat] !== expected.ally || state.game.betrayed[state.you.seat]) return;
    action('alliance-betray');
  });
  betrayalConfirmation = expected;
});
$('item-card').addEventListener('change', renderItems);
$('key-events-list').addEventListener('scroll', rememberKeyEventsView);
$('key-events-panel').addEventListener('toggle', () => { if ($('key-events-panel').open) restoreKeyEventsView(); });
$('item-source').addEventListener('change', renderItems);
$('item-form').addEventListener('submit', event => {
  event.preventDefault();
  if ($('item-submit').disabled || !myTurn() || state.game.phase !== 'roll') return;
  const card = $('item-card').value;
  const details = { card };
  if (!['stun', 'hunt'].includes(card)) details.piece = Number($('item-source').value);
  if (card !== 'mine') {
    const [targetSeat, targetPiece] = $('item-target').value.split(':').map(Number);
    details.targetSeat = targetSeat; details.targetPiece = targetPiece;
  }
  action('use-item', details);
});
$('spectate-button').addEventListener('click', () => action('spectate'));
$('start-game').addEventListener('click', () => action('start'));
$('roll-button').addEventListener('click', () => { if (canWrite() && myTurn() && state.game.phase === 'roll') action('roll'); });
$('dice').addEventListener('click', () => { if (canWrite() && myTurn() && state.game?.phase === 'roll') action('roll'); });
$('move-options').addEventListener('click', (event) => { const button = event.target.closest('[data-piece]'); if (button && !button.disabled && canMove(Number(button.dataset.piece))) action('move', { piece: Number(button.dataset.piece) }); });
$('afk-toggle').addEventListener('click', () => { if (canWrite() && unfinishedParticipant(state.you.seat)) action('afk', { targetSeat: state.you.seat, afk: !playerAfk(state.you.seat) }); });
$('afk-skip').addEventListener('click', () => { if (canWrite() && canSkipAfk()) action('skip-afk', { revision: state.revision, turn: state.game.turn, phase: state.game.phase }); });
$('game-board').addEventListener('click', (event) => { const piece = event.target.closest('.piece.is-legal'); if (piece && canMove(Number(piece.dataset.piece))) action('move', { piece: Number(piece.dataset.piece) }); });
$('game-board').addEventListener('keydown', (event) => { if (event.key !== 'Enter' && event.key !== ' ') return; const piece = event.target.closest('.piece.is-legal'); if (piece) { event.preventDefault(); if (canMove(Number(piece.dataset.piece))) action('move', { piece: Number(piece.dataset.piece) }); } });
$('end-game').addEventListener('click', () => { if (!canWrite()) return; if (state.game.status === 'finished') action('end'); else showConfirm('结束这局游戏？', '当前对局将结束，所有人返回候机大厅，可以重新开始。', '结束游戏', () => action('end')); });
$('home-button').addEventListener('click', () => { if (!state || busy) return; if (!connected) { showConfirm('离开房间？', '当前正在重连。离开后，本次连接会关闭；服务器会保留离线座位一段时间。', '返回首页', () => resetRoom()); return; } showConfirm('离开房间？', isPlaying() && state.you.seat !== null ? '离开后，你的飞机会由系统继续操作。再次使用邀请链接可以观战。' : '你可以使用邀请链接重新加入房间。', '确认离开', () => action('leave')); });
document.querySelector('.brand').addEventListener('click', (event) => { if (state) { event.preventDefault(); $('home-button').click(); } });
$('invite-button').addEventListener('click', invite);
$('role-code-button').addEventListener('click', () => showRoleDialog('code'));
$('host-tools-button').addEventListener('click', showHostDialog);
$('host-close').addEventListener('click', closeHostDialog);
$('host-player-list').addEventListener('click', event => {
  const button = event.target.closest('button[data-host-action]');
  if (!button || button.disabled) return;
  if (button.dataset.hostAction === 'copy') copyHostCode(button.dataset.playerId);
  else if (button.dataset.hostAction === 'kick') confirmKick(button.dataset.playerId);
  else if (button.dataset.hostAction === 'afk') togglePlayerAfk(button.dataset.playerId);
});
$('host-dialog').addEventListener('close', () => { $('host-player-list').replaceChildren(); hostListKey = ''; });
$('host-dialog').addEventListener('click', event => {
  if (event.target !== $('host-dialog')) return;
  const rect = event.target.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeHostDialog();
});
$('takeover-button').addEventListener('click', () => showRoleDialog('takeover'));
$('role-copy').addEventListener('click', copyRoleCode);
$('role-close').addEventListener('click', closeRoleDialog);
$('role-takeover-cancel').addEventListener('click', closeRoleDialog);
$('takeover-code').addEventListener('input', () => setRoleError());
$('role-takeover-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (roleDialogMode !== 'takeover' || !canWrite()) return;
  const code = $('takeover-code').value.trim();
  if (!code) { setRoleError('请输入要接管的角色代码。'); $('takeover-code').focus(); return; }
  setRoleError();
  if (await action('takeover', { code })) {
    closeRoleDialog();
    notify('已接管该角色，可以继续游戏。');
  }
});
$('role-dialog').addEventListener('close', clearRoleDialog);
$('role-dialog').addEventListener('click', (event) => {
  if (event.target !== $('role-dialog')) return;
  const rect = event.target.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeRoleDialog();
});
$('dialog-cancel').addEventListener('click', () => { $('confirm-dialog').close(); dialogAction = null; kickConfirmation = null; betrayalConfirmation = null; });
$('dialog-confirm').addEventListener('click', () => { const callback = dialogAction; dialogAction = null; if ($('dialog-confirm').textContent === '复制链接') { callback?.(); return; } $('confirm-dialog').close(); callback?.(); });
$('confirm-dialog').addEventListener('cancel', () => { dialogAction = null; kickConfirmation = null; betrayalConfirmation = null; });
$('confirm-dialog').addEventListener('click', (event) => { if (event.target === $('confirm-dialog')) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) { $('confirm-dialog').close(); dialogAction = null; kickConfirmation = null; betrayalConfirmation = null; } } });
$('skin-toggle').addEventListener('click', openSkinDialog);
$('skin-button-game').addEventListener('click', openSkinDialog);
$('skin-tab-piece').addEventListener('click', () => { skinDialogTab = 'piece'; renderSkinDialog(); });
$('skin-tab-board').addEventListener('click', () => { skinDialogTab = 'board'; renderSkinDialog(); });
$('skin-close').addEventListener('click', () => $('skin-dialog').close());
$('skin-dialog').addEventListener('click', (event) => {
  if (event.target === $('skin-dialog')) {
    const rect = event.target.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
      $('skin-dialog').close();
    }
    return;
  }
  const pairTarget = event.target.closest('[data-pair-piece]');
  if (pairTarget) {
    const pieceId = pairTarget.dataset.pairPiece;
    const boardId = pairTarget.dataset.pairBoard;
    applyPairedTheme(pieceId, boardId);
    return;
  }
  const target = event.target.closest('[data-skin-id]');
  if (target) {
    const skinType = target.dataset.skinType;
    const skinId = target.dataset.skinId;
    if (skinType === 'piece') applyPieceSkin(skinId);
    else if (skinType === 'board') applyBoardSkin(skinId);
  }
});
window.addEventListener('online', () => { if (session && !connected) openStream(); });
setInterval(updateCountdown, 1000);

function hasVisibleDockItem(container) {
  if (!container) return false;
  const items = container.querySelectorAll(':scope > .dock-item');
  for (const item of items) {
    if (!item.hidden) return true;
  }
  return false;
}

function updatePanelDockClasses() {
  const left = $('left-panel');
  const right = $('side-panel');
  const bottom = $('bottom-panel');
  if (left) left.classList.toggle('has-items', hasVisibleDockItem(left));
  if (right) right.classList.toggle('has-items', hasVisibleDockItem(right));
  if (bottom) bottom.classList.toggle('has-items', hasVisibleDockItem(bottom));
}

function updateBoardScale() {
  if (!document.body.classList.contains('room-active')) return;
  updatePanelDockClasses();
  const boardStage = document.querySelector('.board-stage');
  if (!boardStage) return;

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const isWide = viewportWidth >= 900;

  // Use the layout's actual width, including shell padding and scrollbar space.
  const layout = document.querySelector('.room-layout');
  let availW = layout?.clientWidth || viewportWidth;
  if (isWide) {
    for (const id of ['left-panel', 'side-panel']) {
      const panel = $(id);
      if (!panel) continue;
      const width = panel.getBoundingClientRect().width;
      if (width <= 0) continue;
      const style = getComputedStyle(panel);
      availW -= width + (parseFloat(style.marginLeft) || 0) + (parseFloat(style.marginRight) || 0);
    }
  }
  availW = Math.max(1, availW);
  let areaChrome = 0;
  if (isWide) {
    const areaStyle = getComputedStyle(document.querySelector('.play-area'));
    areaChrome = ['borderLeftWidth', 'borderRightWidth', 'paddingLeft', 'paddingRight']
      .reduce((total, key) => total + (parseFloat(areaStyle[key]) || 0), 0);
    availW = Math.max(1, availW - areaChrome);
  }

  // 视野垂直可用空间：若掷骰等卡片在下方，需预留高度确保其在视野可见范围内
  let topOffset = 135;
  const stageRect = boardStage.getBoundingClientRect();
  const rectTop = stageRect.top + window.scrollY;
  if (rectTop > 40 && rectTop < 300) {
    topOffset = rectTop;
  }
  let bottomReserve = 16;
  const bottomContainer = $('bottom-panel');
  if (bottomContainer && hasVisibleDockItem(bottomContainer)) {
    const hasTurnCard = !!bottomContainer.querySelector('#turn-card');
    const hasStrategy = !!bottomContainer.querySelector('#strategy-panel:not([hidden])');
    const hasEvents = !!bottomContainer.querySelector('#key-events-panel:not([hidden])');
    let needed = 16;
    if (hasTurnCard) needed += 58;
    if (hasStrategy) needed += 42;
    if (hasEvents) needed += 42;
    bottomReserve = Math.min(180, needed);
  }
  const availH = Math.max(240, viewportHeight - topOffset - bottomReserve);

  const targetSize = Math.floor(Math.min(availW, availH));
  document.documentElement.style.setProperty('--board-stage-size', `${targetSize}px`);
  if (isWide) document.documentElement.style.setProperty('--play-area-width', `${targetSize + areaChrome}px`);
}

let applyDockingLayout = () => {};

function initPanelDocking() {
  const STORAGE_KEY = 'sky_ludo_panels_dock_v3';
  const DOCKS = ['left', 'right', 'bottom'];
  const DEFAULT_LAYOUT = {
    left: [],
    right: ['key-events-panel', 'strategy-panel'],
    bottom: ['turn-card']
  };

  const containers = {
    left: $('left-panel'),
    right: $('side-panel'),
    bottom: $('bottom-panel')
  };
  const panels = {
    'key-events-panel': $('key-events-panel'),
    'strategy-panel': $('strategy-panel'),
    'turn-card': $('turn-card')
  };

  function readLayout() {
    try {
      const raw = readStorage(localStorage, STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const valid = DOCKS.every(d => Array.isArray(parsed[d]));
          if (valid) return parsed;
        }
      }
    } catch { /* fallback */ }
    return DEFAULT_LAYOUT;
  }

  function saveLayout() {
    if (!state?.game) return;
    const layout = { left: [], right: [], bottom: [] };
    for (const d of DOCKS) {
      const c = containers[d];
      if (c) {
        c.querySelectorAll(':scope > .dock-item').forEach(item => {
          if (panels[item.id]) layout[d].push(item.id);
        });
      }
    }
    writeStorage(localStorage, STORAGE_KEY, JSON.stringify(layout));
  }

  function applyLayout(layout) {
    const inGame = !!state?.game;
    if (!inGame) {
      // 在候机大厅阶段，就绪/开始卡片保持在右侧栏顶部（规则指南之前），方便所有玩家清晰查看入座进度与房主开局
      const side = containers.right;
      const turnCard = panels['turn-card'];
      if (side && turnCard) {
        const rulesCard = side.querySelector('.rules-card');
        if (rulesCard) {
          if (turnCard.parentElement !== side || turnCard.nextElementSibling !== rulesCard) side.insertBefore(turnCard, rulesCard);
        } else if (turnCard.parentElement !== side) {
          side.appendChild(turnCard);
        }
      }
      return;
    }

    const placed = new Set();
    const ordered = { left: [], right: [], bottom: [] };
    for (const d of DOCKS) {
      const list = layout[d] || [];
      for (const id of list) {
        const item = panels[id];
        if (item && !placed.has(id)) {
          ordered[d].push(item);
          placed.add(id);
        }
      }
    }
    for (const [id, item] of Object.entries(panels)) {
      if (item && !placed.has(id)) {
        const defDock = Object.keys(DEFAULT_LAYOUT).find(d => DEFAULT_LAYOUT[d].includes(id)) || 'right';
        ordered[defDock].push(item);
      }
    }
    for (const d of DOCKS) {
      const c = containers[d];
      if (!c) continue;
      let next = c.querySelector(':scope > .dock-item');
      for (const item of ordered[d]) {
        if (item !== next) c.insertBefore(item, next);
        next = item.nextElementSibling;
        while (next && !next.classList.contains('dock-item')) next = next.nextElementSibling;
      }
    }
  }

  applyDockingLayout = () => {
    applyLayout(readLayout());
    updateBoardScale();
  };

  applyDockingLayout();

  let drag = null;
  let wasDragged = false;

  function findTargetDock(x, y) {
    const margin = 32;
    for (const d of DOCKS) {
      const el = containers[d];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (x >= rect.left - margin && x <= rect.right + margin &&
          y >= rect.top - margin && y <= rect.bottom + margin) {
        return el;
      }
    }
    return null;
  }

  function onPointerDown(e) {
    if (!state?.game) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (e.target.closest('button, input, select, textarea, a, .dice, .dice-area, .move-option')) return;

    const handle = e.target.closest('.dock-handle');
    const summary = e.target.closest('.strategy-panel > summary');
    const cardLabel = e.target.closest('.turn-card .card-label');
    if (!handle && !summary && !cardLabel) return;

    const card = e.target.closest('.dock-item');
    if (!card || card.classList.contains('is-floating')) return;

    drag = {
      card,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: 0,
      offsetY: 0,
      started: false,
      ghost: null
    };
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;

    if (!drag.started) {
      if (Math.hypot(dx, dy) < 6) return;
      drag.started = true;
      wasDragged = true;
      try { drag.card.setPointerCapture(e.pointerId); } catch {}
      document.body.classList.add('is-panel-dragging');
      drag.card.classList.add('is-dragging');
      updateBoardScale();

      const rect = drag.card.getBoundingClientRect();
      drag.offsetX = e.clientX - rect.left;
      drag.offsetY = e.clientY - rect.top;

      const ghost = drag.card.cloneNode(true);
      ghost.classList.add('dock-ghost');
      ghost.style.width = `${rect.width}px`;
      ghost.style.left = `${rect.left}px`;
      ghost.style.top = `${rect.top}px`;
      document.body.appendChild(ghost);
      drag.ghost = ghost;
    }

    if (drag.ghost) {
      drag.ghost.style.left = `${e.clientX - drag.offsetX}px`;
      drag.ghost.style.top = `${e.clientY - drag.offsetY}px`;
    }

    const target = findTargetDock(e.clientX, e.clientY);
    DOCKS.forEach(d => {
      containers[d]?.classList.toggle('dock-zone-hover', containers[d] === target);
    });
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;

    if (drag.started) {
      try { drag.card.releasePointerCapture(e.pointerId); } catch {}
      const target = findTargetDock(e.clientX, e.clientY);
      if (target) {
        const siblings = Array.from(target.querySelectorAll(':scope > .dock-item')).filter(el => el !== drag.card);
        let inserted = false;
        for (const sib of siblings) {
          const r = sib.getBoundingClientRect();
          if (e.clientY < r.top + r.height / 2) {
            target.insertBefore(drag.card, sib);
            inserted = true;
            break;
          }
        }
        if (!inserted) target.appendChild(drag.card);
        saveLayout();
      }

      drag.ghost?.remove();
      drag.card.classList.remove('is-dragging');
      document.body.classList.remove('is-panel-dragging');
      DOCKS.forEach(d => containers[d]?.classList.remove('dock-zone-hover'));
      updateBoardScale();
    }

    drag = null;
  }

  document.addEventListener('pointerdown', onPointerDown, { passive: true });
  document.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerUp);

  document.addEventListener('click', (e) => {
    if (wasDragged) {
      e.preventDefault();
      e.stopPropagation();
      wasDragged = false;
    }
  }, true);

  // Float toggle for strategy panel
  const floatToggle = $('strategy-float-toggle');
  const strategyPanel = $('strategy-panel');
  if (floatToggle && strategyPanel) {
    let floatDrag = null;
    
    floatToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const isFloating = strategyPanel.classList.toggle('is-floating');
      
      if (isFloating) {
        // Remove from dock
        strategyPanel.dataset.wasDock = strategyPanel.parentElement?.id || '';
        strategyPanel.style.left = '50%';
        strategyPanel.style.top = '50%';
        strategyPanel.style.transform = 'translate(-50%, -50%)';
        floatToggle.textContent = '⬢';
        floatToggle.title = '返回停靠模式';
      } else {
        // Return to dock
        strategyPanel.style.left = '';
        strategyPanel.style.top = '';
        strategyPanel.style.transform = '';
        floatToggle.textContent = '⬡';
        floatToggle.title = '切换悬浮模式';
      }
    });

    // Drag handling for floating panel
    let floatWasDragged = false;
    strategyPanel.querySelector('summary')?.addEventListener('click', (e) => {
      if (strategyPanel.classList.contains('is-floating') && floatWasDragged) {
        e.preventDefault();
        floatWasDragged = false;
      }
    });

    strategyPanel.addEventListener('pointerdown', (e) => {
      if (!strategyPanel.classList.contains('is-floating')) return;
      if (e.target.closest('button, input, select, textarea, a')) return;
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      
      const rect = strategyPanel.getBoundingClientRect();
      floatDrag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        origLeft: rect.left,
        origTop: rect.top,
        moved: false
      };
      
      strategyPanel.style.transform = 'none';
      strategyPanel.style.left = rect.left + 'px';
      strategyPanel.style.top = rect.top + 'px';
      
      try { strategyPanel.setPointerCapture(e.pointerId); } catch {}
    });

    strategyPanel.addEventListener('pointermove', (e) => {
      if (!floatDrag || e.pointerId !== floatDrag.pointerId) return;
      
      const dx = e.clientX - floatDrag.startX;
      const dy = e.clientY - floatDrag.startY;
      if (Math.hypot(dx, dy) > 4) {
        floatDrag.moved = true;
        floatWasDragged = true;
      }
      
      const maxX = Math.max(10, window.innerWidth - 60);
      const maxY = Math.max(10, window.innerHeight - 40);
      const newLeft = Math.max(0, Math.min(maxX, floatDrag.origLeft + dx));
      const newTop = Math.max(0, Math.min(maxY, floatDrag.origTop + dy));
      strategyPanel.style.left = newLeft + 'px';
      strategyPanel.style.top = newTop + 'px';
    });

    strategyPanel.addEventListener('pointerup', (e) => {
      if (!floatDrag || e.pointerId !== floatDrag.pointerId) return;
      if (floatDrag.moved) {
        setTimeout(() => { floatWasDragged = false; }, 50);
      }
      floatDrag = null;
    });

    strategyPanel.addEventListener('pointercancel', (e) => {
      if (!floatDrag || e.pointerId !== floatDrag.pointerId) return;
      floatDrag = null;
      floatWasDragged = false;
    });
  }
}

async function initialize() {
  const captainLimits = CAPTAINS.map(captain => `${captain.name} ${captain.maxUses} 次`).join('、');
  $('captain-selection-note').textContent = `每位机长各有一个主动和一个被动，主动每局可用次数：${captainLimits}。可以选择相同机长，开局后锁定。`;
  $('captain-intro-note').textContent = `机长为趣味模式的可选玩法，同时启用结盟与道具。所有入座玩家开局前自行选择，可以重复；开局后锁定。主动每局可用次数：${captainLimits}；被动持续生效。`;
  $('captain-intro-list').innerHTML = CAPTAINS.map(captain => `<section><h4>${captain.icon} ${captain.name}</h4><p>主动 · ${escapeHTML(captain.active)}</p><p>被动 · ${escapeHTML(captain.passive)}</p></section>`).join('');
  $('player-name').value = readStorage(localStorage, NAME_KEY);
  soundEnabled = readStorage(localStorage, SOUND_KEY) === 'true';
  syncSoundButton();
  turnSoundEnabled = readStorage(localStorage, TURN_SOUND_KEY) === 'true';
  syncTurnSound();
  currentPieceSkin = readStorage(localStorage, PIECE_SKIN_KEY, 'classic');
  if (!PIECE_SKINS.some(s => s.id === currentPieceSkin)) currentPieceSkin = 'classic';
  document.documentElement.dataset.pieceSkin = currentPieceSkin;
  currentBoardSkin = readStorage(localStorage, BOARD_SKIN_KEY, 'classic');
  if (!BOARD_SKINS.some(s => s.id === currentBoardSkin)) currentBoardSkin = 'classic';
  document.documentElement.dataset.boardSkin = currentBoardSkin;
  previewBoard();
  initPanelDocking();
  const invitedRoom = new URL(location.href).searchParams.get('room')?.toLowerCase();
  if (invitedRoom) $('room-code').value = invitedRoom.slice(0, 8);
  try { session = JSON.parse(readStorage(sessionStorage, SESSION_KEY, 'null')); } catch { session = null; }
  if (!session?.roomId || !session?.token || (invitedRoom && invitedRoom !== session.roomId)) {
    session = null;
    if (invitedRoom) notify('朋友邀请你来玩，输入昵称即可加入房间。');
    return;
  }
  busy = true;
  $('create-room').disabled = true;
  $('join-form').querySelector('button').disabled = true;
  try {
    const data = await request(`/api/rooms/${encodeURIComponent(session.roomId)}?token=${encodeURIComponent(session.token)}`);
    const next = extractedState(data);
    if (!next) throw new Error('房间已失效');
    busy = false;
    adoptState(next);
    openStream();
  } catch (error) {
    if ([401, 403, 404].includes(error.status)) {
      resetRoom();
      if (invitedRoom) $('room-code').value = invitedRoom;
      notify('之前的房间已失效，请重新加入或创建房间。');
    } else {
      setEntryError('暂未连上之前的房间，正在恢复连接；也可以创建或加入其他房间。');
      openStream();
    }
  } finally {
    busy = false;
    $('create-room').disabled = false;
    $('join-form').querySelector('button').disabled = false;
  }
}
initialize();
