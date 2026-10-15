import { randomInt } from 'node:crypto';
import { COLORS, STARTS, FINISH, TAKEOFF, FLIGHT_FROM, FLIGHT_TO, cellColor, GAME_MODES, CAPTAINS, specialCellAt, normalizeRules } from './board.mjs';

const CAPTURE_TAUNTS = ['这片天空，我先承包了！', '请系好安全带，送你返航！', '下次起飞，我们再较量！', '这一撞，都是骰子的安排！'];
const LUCKY_STEPS = [-3, -2, -1, 1, 2, 3];
const ITEM_CARDS = ['stun', 'mine', 'missile', 'hunt'];
const BASE_ITEM_CARDS = ['stun', 'mine', 'missile'];
const CARD_NAMES = { stun: '定身', mine: '地雷', missile: '导弹', hunt: '追杀' };

function note(game, text, type = null) {
  const at = Date.now();
  game.log.push({ text, at });
  if (game.log.length > 30) game.log.shift();
  if (type) {
    game.keyEvents.push({ id: ++game.eventNumber, type, text, at });
    if (game.keyEvents.length > 50) game.keyEvents.shift();
  }
}
export function createStats() {
  return Object.fromEntries(COLORS.map(color => [color.key, 0]));
}
function playerFor(game, seat) {
  return game.players.find(player => player.seat === seat);
}
function hasRank(game, seat) {
  return playerFor(game, seat)?.rank != null;
}
function enabled(game, rule) {
  return game.mode === 'fun' && game.rules[rule] === true;
}
function captainFor(game, seat) {
  return enabled(game, 'captains') ? game.captains[seat] : null;
}
function allied(game, seat, other) {
  return enabled(game, 'alliances') && game.allies[seat] === other;
}
export function isFrozen(game, seat, piece) {
  return game.mode === 'fun' && game.frozenPieces[seat]?.[piece] === true;
}
function refreshIceCell(game, randomIndex) {
  const occupied = new Set(game.active.flatMap(seat => hasRank(game, seat) ? [] : game.pieces[seat]
    .filter(progress => progress >= 0 && progress <= 50).map(progress => (STARTS[seat] + progress) % 52)));
  const candidates = Array.from({ length: 52 }, (_, index) => index)
    .filter(index => !enabled(game, specialCellAt(index)) && !occupied.has(index)
      && index !== game.iceCell && !game.mines.some(mine => mine.index === index));
  game.iceCell = candidates.length ? candidates[randomIndex(candidates.length)] : null;
  note(game, game.iceCell == null ? '冰冻格暂无可用位置，等待下一轮生成' : '冰冻格已生成，首架落入的飞机将被冻结', 'ICE_GENERATED');
}
// Every active or future self-return rule records its counts through this helper.
export function addStat(game, seat, colorSeat, count = 1) {
  const player = playerFor(game, seat);
  if (!player || !COLORS[colorSeat] || !Number.isInteger(count) || count < 1) return;
  player.stats[COLORS[colorSeat].key] += count;
}
function assertTurn(game, seat, phase, automatic = false) {
  if (game.status !== 'playing') throw new Error('游戏尚未开始或已经结束');
  if (hasRank(game, seat)) throw new Error('你已完成比赛，请等待其他玩家');
  if (!automatic && playerFor(game, seat)?.afk) throw new Error('你正在挂机，请先恢复游戏');
  if (game.turn !== seat) throw new Error('请等待你的回合');
  if (game.phase !== phase) throw new Error(phase === 'roll' ? '请先选择要移动的飞机' : '请先掷骰子');
}
function nextTurn(game, repeat = false) {
  const outgoingSeat = game.turn;
  if (game.huntTargets?.[outgoingSeat]?.pending) {
    game.huntTargets[outgoingSeat].pending = false;
  }
  const outgoing = captainFor(game, game.turn);
  if (outgoing) outgoing.flashReady = false;
  game.phase = 'roll';
  game.legal = [];
  if (enabled(game, 'captains')) game.rerollOffered = false;
  if (!repeat || hasRank(game, game.turn)) {
    const current = game.active.indexOf(game.turn);
    for (let offset = 1; offset <= game.active.length; offset++) {
      const seat = game.active[(current + offset) % game.active.length];
      if (!hasRank(game, seat)) {
        const firstActive = game.active.find(s => !hasRank(game, s));
        if (seat === firstActive) {
          for (let i = 0; i < 4; i++) {
            if (game.bountyRounds[i] > 0) game.bountyRounds[i]--;
          }
        }
        game.turn = seat;
        game.itemUsed[seat] = false;
        const captain = captainFor(game, seat);
        if (captain) {
          captain.bonusReady = Math.max(captain.bonusReady, captain.revengeBonus);
          captain.revengeBonus = 0;
        }
        break;
      }
    }
    game.sixes = 0;
  }
}
export function createGame(players, { mode = 'classic', rules } = {}) {
  if (!GAME_MODES.includes(mode)) throw new Error('游戏模式无效');
  const active = players.filter(p => Number.isInteger(p.seat)).map(p => p.seat).sort((a,b) => a-b);
  if (active.length < 2 || new Set(active).size !== active.length) throw new Error('至少需要两名不同座位的玩家');
  const game = {
    status: 'playing', mode, rules: normalizeRules(mode, rules), active, turn: active[0], phase: 'roll', dice: null,
    players: active.map(seat => ({ seat, rank: null, stats: createStats(), afk: false })), rankings: [],
    sixes: 0, legal: [], pieces: Array.from({ length: 4 }, () => [-1,-1,-1,-1]),
    rollCount: 0, iceCell: null, frozenPieces: Array.from({ length: 4 }, () => [false,false,false,false]),
    allies: [null,null,null,null], invitations: [], betrayed: [false,false,false,false], ambush: [false,false,false,false],
    everAllied: [false,false,false,false], revengeTarget: [null,null,null,null], diceDouble: [false,false,false,false],
    bountyRounds: [0,0,0,0], huntTargets: [null,null,null,null], betrayedBy: [null,null,null,null],
    hands: Array.from({ length: 4 }, () => []), itemUsed: [false,false,false,false], mines: [],
    winner: null, lastMove: null, moveNumber: 0, log: [], keyEvents: [], eventNumber: 0, deadline: null
  };
  if (enabled(game, 'captains')) {
    game.captains = [null, null, null, null];
    for (const seat of active) {
      const key = players.find(player => player.seat === seat)?.captain;
      const captain = CAPTAINS.find(captain => captain.key === key);
      if (!captain) throw new Error('请每位玩家先选择机长');
      const maxUses = captain.maxUses;
      game.captains[seat] = { key, used: false, uses: maxUses, maxUses, flashReady: false, revengeTarget: null, revengeBonus: 0, bonusReady: 0, attackers: [], rerolledThisTurn: false };
    }
    game.shields = Array.from({ length: 4 }, () => [false, false, false, false]);
    game.reserveSteps = Array.from({ length: 4 }, () => [false, false, false, false]);
    game.steps = null;
    game.rollBonus = 0;
    game.sixesBeforeRoll = 0;
    game.rerollOffered = false;
  }
  if (enabled(game, 'items')) for (const seat of active) game.hands[seat] = ['stun', 'mine', 'missile'];
  note(game, '准备起航！' + COLORS[game.turn].name + '方先掷骰子', 'START');
  return game;
}
export function rollDice(game, seat, value, randomIndex = randomInt, automatic = false) {
  assertTurn(game, seat, 'roll', automatic);
  if (!Number.isInteger(value) || value < 1 || value > 6) throw new Error('无效骰子');
  if (enabled(game, 'captains')) {
    const captain = captainFor(game, seat);
    game.rollBonus = captain.bonusReady;
    captain.bonusReady = 0;
    game.sixesBeforeRoll = game.sixes;
    captain.rerolledThisTurn = false;
  }
  return settleRoll(game, seat, value, randomIndex);
}
function resolveHuntEffects(game, seat, randomIndex) {
  const huntTarget = game.huntTargets?.[seat];
  if (!huntTarget || huntTarget.pending) return;
  
  const { targetSeat, targetPiece } = huntTarget;
  game.huntTargets[seat] = null;
  
  const currentProgress = game.pieces[targetSeat]?.[targetPiece];
  if (currentProgress == null || currentProgress < 0 || currentProgress > 50) {
    note(game, COLORS[seat].name + '方追杀目标已不在外环，追杀落空', 'HUNT_FAILED');
    return;
  }
  
  const targetIndex = (STARTS[targetSeat] + currentProgress) % 52;
  if (enabled(game, 'safe') && specialCellAt(targetIndex) === 'safe') {
    note(game, COLORS[seat].name + '方追杀目标停留在安全格，追杀落空', 'HUNT_FAILED');
    return;
  }
  
  let hunterPiece = game.pieces[seat].findIndex(p => p >= 0 && p <= 50);
  if (hunterPiece < 0) hunterPiece = game.pieces[seat].findIndex(p => p === TAKEOFF);
  if (hunterPiece < 0) hunterPiece = game.pieces[seat].findIndex(p => p === -1);
  if (hunterPiece < 0) return;
  
  const from = game.pieces[seat][hunterPiece];
  const hunterTo = Math.min(50, (targetIndex - STARTS[seat] + 52) % 52);
  game.pieces[seat][hunterPiece] = hunterTo;
  
  const events = [];
  events.push({ type: 'HUNT_EXECUTE', targetSeat, targetPiece, at: hunterTo, from, to: hunterTo });
  
  if (returnPlane(game, targetSeat, targetPiece, { attackerSeat: seat, attackerPiece: hunterPiece, events, at: hunterTo })) {
    addStat(game, seat, targetSeat);
  }
  
  game.lastMove = {
    id: ++game.moveNumber, kind: 'item', card: 'hunt', seat, piece: hunterPiece,
    from, to: hunterTo, path: [hunterTo], captured: [{ seat: targetSeat, piece: targetPiece, from: currentProgress, at: hunterTo }],
    effects: [], events, selfReturned: false, selfReturnFrom: null, returnReason: null, at: Date.now(), taunt: ''
  };
  
  note(game, COLORS[seat].name + '方追杀成功，跳至' + COLORS[targetSeat].name + '方 ' + (targetPiece + 1) + ' 号飞机位置并将其击落', 'HUNT');
}

function settleRoll(game, seat, value, randomIndex, reroll = false) {
  resolveHuntEffects(game, seat, randomIndex);
  const doubled = game.diceDouble[seat];
  if (doubled) {
    value = value * 2;
    game.diceDouble[seat] = false;
  }
  game.dice = value;
  game.sixes = value === 6 ? (reroll ? game.sixesBeforeRoll : game.sixes) + 1 : 0;
  const captain = captainFor(game, seat);
  const flashBonus = captain?.key === 'flash' && value === 6 ? 1 : 0;
  if (captain) {
    game.steps = value + game.rollBonus + flashBonus;
    game.rerollOffered = false;
  }
  game.rollCount++;
  note(game, COLORS[seat].name + '方掷出 ' + value + ' 点' + (doubled ? '（背叛buff翻倍）' : ''));
  if (captain && game.rollBonus) note(game, COLORS[seat].name + '方复仇被动生效，本次实际移动 ' + game.steps + ' 格');
  if (flashBonus) note(game, COLORS[seat].name + '方闪现者被动生效，本次移动步数 +1，实际步数为 ' + game.steps);
  if (enabled(game, 'ice') && game.rollCount % 20 === 0) refreshIceCell(game, randomIndex);
  if (captain?.key === 'gambler' && value === 1 && game.hands[seat].length < 3) {
    game.hands[seat].push(BASE_ITEM_CARDS[randomIndex(BASE_ITEM_CARDS.length)]);
    note(game, COLORS[seat].name + '方赌徒掷出 1 点，获得一张随机道具卡', 'ITEM_DRAWN');
  }
  game.legal = game.pieces[seat].flatMap((p,i) => p < FINISH && (!isFrozen(game, seat, i) || value === 6)
    && (p >= 0 || p === TAKEOFF || value % 2 === 0) ? [i] : []);
  if (!game.legal.length) {
    if (captain?.key === 'gambler' && !captain.used && !captain.rerolledThisTurn && (captain.uses ?? 1) > 0) {
      game.phase = 'move';
      game.rerollOffered = true;
      note(game, '没有可移动的飞机，可以使用赌徒重掷（剩余 ' + captain.uses + ' 次）或接受本次点数');
      return game;
    }
    note(game, '没有可移动的飞机，轮到下一位');
    nextTurn(game, value === 6);
  } else game.phase = 'move';
  return game;
}
export function acceptRoll(game, seat, automatic = false) {
  assertTurn(game, seat, 'move', automatic);
  if (!enabled(game, 'captains') || !game.rerollOffered || game.legal.length) throw new Error('当前骰子需要选择飞机移动');
  note(game, COLORS[seat].name + '方接受本次点数，没有可移动的飞机');
  nextTurn(game, game.dice === 6);
  return game;
}
function specialLanding(game, seat, progress) {
  if (game.mode !== 'fun' || progress < 0 || progress > 50) return null;
  const physical = (STARTS[seat] + progress) % 52;
  if (enabled(game, 'ice') && physical === game.iceCell) return 'ice';
  const type = specialCellAt(physical);
  return enabled(game, type) ? type : null;
}
function opponentsAt(game, seat, progress) {
  if (progress < 0 || progress > 50) return [];
  const physical = (STARTS[seat] + progress) % 52;
  return game.active.flatMap(other => {
    if (other === seat || hasRank(game, other) || allied(game, seat, other)) return [];
    return game.pieces[other].flatMap((p, piece) =>
      p >= 0 && p <= 50 && (STARTS[other] + p) % 52 === physical
        ? [{ seat: other, piece, from: p, at: progress }] : []);
  });
}
function wallAt(game, seat, progress) {
  if (specialLanding(game, seat, progress) === 'safe') return null;
  const planes = opponentsAt(game, seat, progress);
  const counts = new Map();
  for (const plane of planes) counts.set(plane.seat, (counts.get(plane.seat) ?? 0) + 1);
  return [...counts.values()].some(count => count >= 2) ? planes : null;
}
function firstWall(game, seat, from, target) {
  const direction = target > from ? 1 : -1;
  for (let progress = from + direction; direction > 0 ? progress <= target : progress >= target; progress += direction) {
    if (wallAt(game, seat, progress)) return progress;
  }
  return null;
}
function blockedLanding(game, seat, from, target) {
  const wall = firstWall(game, seat, from, target);
  return wall == null ? target : wall + (target > from ? -1 : 1);
}
// All returns share protection and captain passives; callers count only real hits.
function returnPlane(game, seat, piece, { attackerSeat = null, attackerPiece = null, shieldable = true, events = [], at = null, moving = false } = {}) {
  if ((!moving && game.pieces[seat][piece] < 0) || game.pieces[seat][piece] >= FINISH) return false;
  const captain = captainFor(game, seat);
  if (enabled(game, 'captains') && shieldable && game.shields[seat][piece]) {
    game.shields[seat][piece] = false;
    const progress = moving ? at : game.pieces[seat][piece];
    events.push({ type: 'SHIELD_BLOCK', targetSeat: seat, targetPiece: piece, at, from: progress, to: progress });
    note(game, COLORS[seat].name + '方 ' + (piece + 1) + ' 号飞机的护盾抵挡了一次撞击', 'SHIELD_BLOCK');
    return false;
  }
  game.pieces[seat][piece] = -1;
  game.frozenPieces[seat][piece] = false;
  if (captain) {
    game.shields[seat][piece] = false;
    if (captain.key === 'shield') game.reserveSteps[seat][piece] = true;
    if (captain.key === 'avenger' && attackerSeat != null && attackerSeat !== seat) {
      captain.revengeBonus = 2;
      if (Number.isInteger(attackerPiece) && !captain.attackers.some(plane => plane.seat === attackerSeat && plane.piece === attackerPiece)) {
        captain.attackers.push({ seat: attackerSeat, piece: attackerPiece });
      }
    }
  }
  return true;
}
function stealItem(game, seat, victims, randomIndex, events) {
  const captain = captainFor(game, seat);
  if (captain?.key !== 'betrayer' || game.hands[seat].length >= 3) return;
  const targets = [...new Set(victims.map(plane => plane.seat))].filter(other => game.hands[other].length);
  if (!targets.length) return;
  const targetSeat = targets[randomIndex(targets.length)];
  const cards = game.hands[targetSeat];
  game.hands[seat].push(cards.splice(randomIndex(cards.length), 1)[0]);
  events.push({ type: 'ITEM_STOLEN', targetSeat });
  note(game, COLORS[seat].name + '方撞飞敌机，从' + COLORS[targetSeat].name + '方随机偷取一张道具卡', 'ITEM_STOLEN');
}
function capture(game, seat, progress, captured, countStats = true, piece = null, events = [], randomIndex = randomInt) {
  if (progress < 0 || progress > 50) return;
  const physical = (STARTS[seat] + progress) % 52;
  if (enabled(game, 'safe') && specialCellAt(physical) === 'safe') return;
  for (const plane of opponentsAt(game, seat, progress)) {
    if (!returnPlane(game, plane.seat, plane.piece, { attackerSeat: seat, attackerPiece: piece, events, at: progress })) continue;
    captured.push(plane);
    if (countStats) addStat(game, seat, plane.seat);
    if (game.bountyRounds[plane.seat] > 0) {
      if (game.hands[seat].length < 3) {
        const card = BASE_ITEM_CARDS[randomIndex(BASE_ITEM_CARDS.length)];
        game.hands[seat].push(card);
        note(game, COLORS[seat].name + '方撞飞有悬赏的' + COLORS[plane.seat].name + '方飞机，获得' + CARD_NAMES[card], 'BOUNTY_REWARD');
      }
    }
  }
}
function clearParticipation(game, seat) {
  playerFor(game, seat).afk = false;
  const ally = game.allies[seat];
  if (ally != null) game.allies[ally] = null;
  game.allies[seat] = null;
  game.invitations = game.invitations.filter(invite => invite.from !== seat && invite.to !== seat);
  game.ambush[seat] = false;
  game.diceDouble[seat] = false;
  game.revengeTarget[seat] = null;
  game.frozenPieces[seat].fill(false);
  game.hands[seat] = [];
  game.mines = game.mines.filter(mine => mine.seat !== seat);
  const captain = captainFor(game, seat);
  if (captain) {
    captain.flashReady = false;
    captain.revengeTarget = null;
    captain.revengeBonus = captain.bonusReady = 0;
    game.shields[seat].fill(false);
    game.reserveSteps[seat].fill(false);
  }
}
function finishPlayer(game, seat) {
  const player = playerFor(game, seat);
  clearParticipation(game, seat);
  player.rank = game.rankings.push(seat);
  if (game.winner == null) game.winner = seat;
  note(game, COLORS[seat].name + '方四架飞机全部抵达，获得第 ' + player.rank + ' 名！', 'RANK');
  const remaining = game.players.filter(other => other.rank == null);
  if (remaining.length === 1) {
    remaining[0].rank = game.rankings.push(remaining[0].seat);
    clearParticipation(game, remaining[0].seat);
    note(game, COLORS[remaining[0].seat].name + '方获得第 ' + remaining[0].rank + ' 名，本局结束', 'FINISH');
  }
  if (remaining.length <= 1) {
    game.status = 'finished';
    game.phase = 'roll';
    game.legal = [];
    game.sixes = 0;
    game.deadline = null;
  } else nextTurn(game);
}
function assertParticipant(game, seat, allowAfk = false) {
  if (game.status !== 'playing') throw new Error('游戏尚未开始或已经结束');
  if (!game.active.includes(seat)) throw new Error('观战玩家不能使用此功能');
  if (hasRank(game, seat)) throw new Error('你已完成比赛，请等待其他玩家');
  if (!allowAfk && playerFor(game, seat).afk) throw new Error('你正在挂机，请先恢复游戏');
}
export function setAfk(game, seat, afk) {
  assertParticipant(game, seat, true);
  if (typeof afk !== 'boolean') throw new Error('挂机状态无效');
  const player = playerFor(game, seat);
  if (player.afk === afk) return game;
  player.afk = afk;
  note(game, COLORS[seat].name + '方' + (afk ? '已挂机，其他玩家可跳过其当前阶段' : '已恢复游戏'), afk ? 'AFK_ON' : 'AFK_OFF');
  return game;
}
export function skipAfk(game, actorSeat, expectedTurn, expectedPhase) {
  assertParticipant(game, actorSeat);
  if (game.turn !== expectedTurn || game.phase !== expectedPhase || !['roll', 'move'].includes(expectedPhase)) {
    throw new Error('回合阶段已改变，请等待最新状态');
  }
  if (actorSeat === game.turn) throw new Error('不能跳过自己的阶段');
  if (!playerFor(game, game.turn)?.afk || hasRank(game, game.turn)) throw new Error('当前玩家没有挂机');
  note(game, COLORS[actorSeat].name + '方跳过了挂机中的' + COLORS[game.turn].name + '方' + (game.phase === 'roll' ? '掷骰' : '走棋') + '阶段', 'AFK_SKIP');
  game.dice = null;
  nextTurn(game);
  return game;
}
export function allianceAction(game, seat, type, targetSeat, randomIndex = randomInt) {
  assertParticipant(game, seat);
  if (!enabled(game, 'alliances')) throw new Error('本局未启用结盟与背叛');
  if (type === 'alliance-betray') {
    const ally = game.allies[seat];
    if (ally == null) throw new Error('你当前没有盟友');
    if (game.betrayed[seat]) throw new Error('每人每局只能背叛一次');
    game.allies[seat] = game.allies[ally] = null;
    game.betrayed[seat] = true;
    game.diceDouble[seat] = true;
    game.bountyRounds[seat] = 3;
    game.betrayedBy[ally] = seat;
    const rewardCards = [];
    for (let i = 0; i < 2; i++) {
      if (game.hands[seat].length < 3) {
        const card = BASE_ITEM_CARDS[randomIndex(BASE_ITEM_CARDS.length)];
        game.hands[seat].push(card);
        rewardCards.push(card);
      }
    }
    if (game.hands[ally].length < 3) {
      game.hands[ally].push('hunt');
    } else {
      const replaceIdx = game.hands[ally].findIndex(c => c !== 'hunt');
      if (replaceIdx >= 0) game.hands[ally].splice(replaceIdx, 1, 'hunt');
      else game.hands[ally].push('hunt');
    }
    note(game, COLORS[seat].name + '方解除联盟，下一次掷骰点数翻倍，3轮内被踩可获得道具，并获得' + rewardCards.map(c => CARD_NAMES[c]).join('、'), 'BETRAYAL');
    note(game, COLORS[ally].name + '方遭到背叛，获得追杀卡，可追杀背叛者', 'BETRAYAL_VICTIM');
    return game;
  }
  if (!Number.isInteger(targetSeat) || targetSeat === seat || !game.active.includes(targetSeat) || hasRank(game, targetSeat)) {
    throw new Error('请选择仍在比赛中的其他玩家');
  }
  const incoming = game.invitations.find(invite => invite.from === targetSeat && invite.to === seat);
  const outgoing = game.invitations.find(invite => invite.from === seat && invite.to === targetSeat);
  if (type === 'alliance-invite') {
    if (game.allies[seat] != null || game.allies[targetSeat] != null) throw new Error('每人最多只能有一位盟友');
    if (game.everAllied[seat] || game.everAllied[targetSeat]) throw new Error('每人每局只能结盟一次');
    if (outgoing) throw new Error('已经向该玩家发出邀请');
    game.invitations.push({ from: seat, to: targetSeat });
    note(game, COLORS[seat].name + '方向' + COLORS[targetSeat].name + '方发出结盟邀请', 'ALLIANCE_INVITE');
  } else if (type === 'alliance-accept') {
    if (!incoming) throw new Error('该结盟邀请不存在或已经失效');
    if (game.allies[seat] != null || game.allies[targetSeat] != null) throw new Error('每人最多只能有一位盟友');
    if (game.everAllied[seat] || game.everAllied[targetSeat]) throw new Error('每人每局只能结盟一次');
    game.allies[seat] = targetSeat;
    game.allies[targetSeat] = seat;
    game.everAllied[seat] = game.everAllied[targetSeat] = true;
    game.invitations = game.invitations.filter(invite => ![seat, targetSeat].includes(invite.from) && ![seat, targetSeat].includes(invite.to));
    note(game, COLORS[seat].name + '方与' + COLORS[targetSeat].name + '方结为盟友，互不碰撞并可通行对方的墙', 'ALLIANCE_ACCEPT');
  } else if (type === 'alliance-decline' || type === 'alliance-cancel') {
    const invite = type === 'alliance-decline' ? incoming : outgoing;
    if (!invite) throw new Error('该结盟邀请不存在或已经失效');
    game.invitations = game.invitations.filter(entry => entry !== invite);
    note(game, COLORS[seat].name + '方' + (type === 'alliance-decline' ? '拒绝了结盟邀请' : '撤回了结盟邀请'), type === 'alliance-decline' ? 'ALLIANCE_DECLINE' : 'ALLIANCE_CANCEL');
  } else throw new Error('联盟操作无效');
  return game;
}
function targetPlane(game, seat, targetSeat, targetPiece) {
  if (!Number.isInteger(targetSeat) || targetSeat === seat || !game.active.includes(targetSeat)
      || hasRank(game, targetSeat) || allied(game, seat, targetSeat)) throw new Error('请选择敌方仍在比赛中的飞机');
  if (!Number.isInteger(targetPiece) || targetPiece < 0 || targetPiece > 3) throw new Error('目标飞机无效');
  const progress = game.pieces[targetSeat][targetPiece];
  if (progress < 0 || progress > 50) throw new Error('只能选择公共外环上的敌机');
  return progress;
}
function sourcePlane(game, seat, piece) {
  if (!Number.isInteger(piece) || piece < 0 || piece > 3) throw new Error('请选择自己的飞机');
  const progress = game.pieces[seat][piece];
  if (progress < 0 || progress > 50) throw new Error('请选择公共外环上的己方飞机');
  return progress;
}
export function useSkill(game, seat, { piece, targetSeat, targetPiece } = {}, randomDice = () => randomInt(1, 7), randomIndex = randomInt) {
  assertParticipant(game, seat);
  const captain = captainFor(game, seat);
  if (!captain) throw new Error('本局未启用机长技能');
  if (captain.used || (captain.uses != null && captain.uses <= 0)) throw new Error('主动技能次数已用完');
  const phase = captain.key === 'flash' || captain.key === 'gambler' ? 'move' : 'roll';
  assertTurn(game, seat, phase);
  if (captain.key === 'flash') {
    if (captain.flashReady) throw new Error('闪现已准备，请先完成本次移动');
    if (!game.legal.some(index => game.pieces[seat][index] !== -1 && (!isFrozen(game, seat, index) || game.dice === 6))) {
      throw new Error('请选择可在本次移动后闪现的飞机');
    }
    captain.uses--;
    captain.used = captain.uses <= 0;
    captain.flashReady = true;
    game.legal = game.legal.filter(index => game.pieces[seat][index] !== -1);
    note(game, COLORS[seat].name + '方准备闪现（剩余 ' + captain.uses + ' 次），本次合法走棋后额外前进最多 3 格', 'SKILL_FLASH');
    return game;
  }
  if (captain.key === 'gambler') {
    if (captain.rerolledThisTurn) throw new Error('新点数必须接受，不能连续重掷');
    const value = randomDice();
    if (!Number.isInteger(value) || value < 1 || value > 6) throw new Error('无效骰子');
    captain.uses--;
    captain.used = captain.uses <= 0;
    captain.rerolledThisTurn = true;
    note(game, COLORS[seat].name + '方使用赌徒重掷（剩余 ' + captain.uses + ' 次），新点数必须接受', 'REROLL');
    return settleRoll(game, seat, value, randomIndex, true);
  }
  if (captain.key === 'avenger') {
    if (!Number.isInteger(targetSeat) || targetSeat === seat || !game.active.includes(targetSeat)
      || hasRank(game, targetSeat) || allied(game, seat, targetSeat)) throw new Error('请选择敌方仍在比赛中的飞机');
    if (!Number.isInteger(targetPiece) || targetPiece < 0 || targetPiece > 3) throw new Error('目标飞机无效');
    if (!captain.attackers.some(plane => plane.seat === targetSeat && plane.piece === targetPiece)) throw new Error('只能锁定曾撞过自己的敌机');
    captain.uses = 0;
    captain.used = true;
    captain.revengeTarget = { seat: targetSeat, piece: targetPiece };
    note(game, COLORS[seat].name + '方锁定' + COLORS[targetSeat].name + '方 ' + (targetPiece + 1) + ' 号飞机，等待外环追击', 'REVENGE_MARK');
    return game;
  }
  if (!Number.isInteger(piece) || piece < 0 || piece > 3) throw new Error('请选择自己的飞机');
  const from = game.pieces[seat][piece];
  const events = [];
  let to = from;
  let text;
  if (captain.key === 'shield') {
    if (from < 0 || from >= FINISH) throw new Error('只能保护外环或归航道上的己方飞机');
    if (game.shields[seat][piece]) throw new Error('这架飞机已经有护盾');
    captain.uses--;
    captain.used = captain.uses <= 0;
    game.shields[seat][piece] = true;
    events.push({ type: 'SHIELD_SET', targetSeat: seat, targetPiece: piece, at: from, from, to });
    text = '为 ' + (piece + 1) + ' 号飞机加上一层护盾（剩余 ' + captain.uses + ' 次）';
  } else {
    sourcePlane(game, seat, piece);
    if (!Number.isInteger(targetSeat) || targetSeat === seat || !allied(game, seat, targetSeat) || hasRank(game, targetSeat)) throw new Error('请选择当前盟友的飞机');
    if (!Number.isInteger(targetPiece) || targetPiece < 0 || targetPiece > 3) throw new Error('目标飞机无效');
    const targetFrom = game.pieces[targetSeat][targetPiece];
    if (targetFrom < 0 || targetFrom > 50) throw new Error('只能交换双方公共外环上的飞机');
    to = (STARTS[targetSeat] + targetFrom - STARTS[seat] + 52) % 52;
    const targetTo = (STARTS[seat] + from - STARTS[targetSeat] + 52) % 52;
    if (to > 50 || targetTo > 50) throw new Error('交换位置超出其中一方的公共外环路线');
    captain.uses = 0;
    captain.used = true;
    game.pieces[seat][piece] = to;
    game.pieces[targetSeat][targetPiece] = targetTo;
    events.push({ type: 'ALLY_SWAP', targetSeat, targetPiece, targetFrom, targetTo, at: to, from, to });
    text = '将 ' + (piece + 1) + ' 号飞机与盟友' + COLORS[targetSeat].name + '方 ' + (targetPiece + 1) + ' 号飞机交换位置';
  }
  game.lastMove = { id: ++game.moveNumber, kind: 'skill', skill: captain.key, seat, piece, from, to, path: [to], captured: [], effects: [], events,
    selfReturned: false, selfReturnFrom: null, returnReason: null, at: Date.now(), taunt: '' };
  note(game, COLORS[seat].name + '方' + text, events[0].type);
  return game;
}
export function useItem(game, seat, { card, piece, targetSeat, targetPiece } = {}, randomIndex = randomInt) {
  assertTurn(game, seat, 'roll');
  if (!enabled(game, 'items')) throw new Error('本局未启用道具卡');
  if (!ITEM_CARDS.includes(card)) throw new Error('道具无效');
  if (game.itemUsed[seat]) throw new Error('本轮已经使用过一张道具卡');
  const cardIndex = game.hands[seat].indexOf(card);
  if (cardIndex < 0) throw new Error('你没有这张道具卡');
  const captured = [];
  const events = [];
  const sourcePiece = card === 'stun' ? 0 : piece;
  let from = game.pieces[seat][sourcePiece];
  let text;
  if (card === 'stun') {
    let finalTargetSeat = targetSeat, finalTargetPiece = targetPiece;
    const gambler = captainFor(game, seat);
    if (gambler?.key === 'gambler' && randomIndex(2) === 0) {
      const ownOuter = game.pieces[seat].map((p, i) => (p >= 0 && p <= 50 && !isFrozen(game, seat, i) ? i : -1)).filter(i => i >= 0);
      if (ownOuter.length) {
        finalTargetSeat = seat;
        finalTargetPiece = ownOuter[randomIndex(ownOuter.length)];
      }
    }
    const targetFrom = finalTargetSeat === seat
      ? game.pieces[seat][finalTargetPiece]
      : targetPlane(game, seat, finalTargetSeat, finalTargetPiece);
    if (finalTargetSeat === seat && captainFor(game, seat)?.key !== 'gambler') throw new Error('定身只能选择敌方飞机');
    if (isFrozen(game, finalTargetSeat, finalTargetPiece)) throw new Error('这架飞机已经被冻结');
    game.frozenPieces[finalTargetSeat][finalTargetPiece] = true;
    events.push({ type: 'STUN', targetSeat: finalTargetSeat, targetPiece: finalTargetPiece, from: targetFrom, to: targetFrom });
    text = finalTargetSeat === seat
      ? '赌徒的定身失控，冻结了自己的 ' + (finalTargetPiece + 1) + ' 号飞机'
      : '使用定身，让' + COLORS[finalTargetSeat].name + '方 ' + (finalTargetPiece + 1) + ' 号飞机冻结';
  } else if (card === 'mine') {
    from = sourcePlane(game, seat, piece);
    const index = (STARTS[seat] + from) % 52;
    if (specialLanding(game, seat, from) || game.mines.some(mine => mine.index === index)) throw new Error('只能在没有特殊效果或地雷的普通外环格埋雷');
    const gambler = captainFor(game, seat);
    if (gambler?.key === 'gambler' && randomIndex(10) < 3) {
      events.push({ type: 'MINE_SET', index, at: from, from, to: from });
      if (returnPlane(game, seat, piece, { attackerSeat: seat, attackerPiece: piece, events, at: from })) {
        captured.push({ seat, piece, from, at: from });
        addStat(game, seat, seat);
      }
      text = '地雷提前引爆！' + (piece + 1) + ' 号飞机被炸回机场';
    } else {
      game.mines.push({ seat, index, ...(enabled(game, 'captains') ? { piece } : {}) });
      events.push({ type: 'MINE_SET', index, at: from, from, to: from });
      text = '在 ' + (piece + 1) + ' 号飞机当前格埋下一枚公开地雷';
    }
  } else if (card === 'missile') {
    from = sourcePlane(game, seat, piece);
    let finalTargetSeat = targetSeat, finalTargetPiece = targetPiece, finalTargetFrom = targetPlane(game, seat, targetSeat, targetPiece);
    const gambler = captainFor(game, seat);
    if (gambler?.key === 'gambler' && randomIndex(2) === 0) {
      const ownOuter = game.pieces[seat].map((p, i) => {
        if (p < 0 || p > 50) return -1;
        const idx = (STARTS[seat] + p) % 52;
        if (enabled(game, 'safe') && specialCellAt(idx) === 'safe') return -1;
        return i;
      }).filter(i => i >= 0);
      if (ownOuter.length) {
        finalTargetSeat = seat;
        finalTargetPiece = ownOuter[randomIndex(ownOuter.length)];
        finalTargetFrom = game.pieces[seat][finalTargetPiece];
      }
    }
    const targetIndex = (STARTS[finalTargetSeat] + finalTargetFrom) % 52;
    const distance = (targetIndex - (STARTS[seat] + from) + 52) % 52;
    if (finalTargetSeat !== seat && (distance < 1 || distance > 6 || from + distance > 50)) throw new Error('导弹只能击落己机前方 6 格公共外环内的敌机');
    if (finalTargetSeat === seat && (finalTargetFrom < 0 || finalTargetFrom > 50)) throw new Error('目标飞机不在公共外环');
    if (enabled(game, 'safe') && specialCellAt(targetIndex) === 'safe') throw new Error('安全岛上的飞机免疫导弹');
    const hitAt = finalTargetSeat === seat ? finalTargetFrom : from + distance;
    if (returnPlane(game, finalTargetSeat, finalTargetPiece, { attackerSeat: seat, attackerPiece: piece, events, at: hitAt })) {
      captured.push({ seat: finalTargetSeat, piece: finalTargetPiece, from: finalTargetFrom, at: hitAt });
      addStat(game, seat, finalTargetSeat);
    }
    events.unshift({ type: 'MISSILE', at: hitAt, from, to: from, targetSeat: finalTargetSeat, targetPiece: finalTargetPiece,
      ...(enabled(game, 'captains') ? { targetFrom: finalTargetFrom } : {}) });
    text = finalTargetSeat === seat
      ? '赌徒的导弹打偏，击落了自己的 ' + (finalTargetPiece + 1) + ' 号飞机'
      : '使用导弹' + (captured.length ? '击落' : '命中护盾中的') + COLORS[finalTargetSeat].name + '方 ' + (finalTargetPiece + 1) + ' 号飞机';
  } else if (card === 'hunt') {
    if (game.betrayedBy[seat] == null) throw new Error('只有被背叛的玩家才能使用追杀卡');
    const targetFrom = targetPlane(game, seat, targetSeat, targetPiece);
    const targetIndex = (STARTS[targetSeat] + targetFrom) % 52;
    if (enabled(game, 'safe') && specialCellAt(targetIndex) === 'safe') throw new Error('安全格内的飞机无法被追杀');
    game.huntTargets[seat] = { targetSeat, targetPiece, targetFrom, pending: true };
    events.push({ type: 'HUNT_SET', targetSeat, targetPiece, at: targetFrom, from: targetFrom, to: targetFrom });
    text = '锁定追杀' + COLORS[targetSeat].name + '方 ' + (targetPiece + 1) + ' 号飞机，下回合若其仍在外环将执行追杀';
  }
  game.hands[seat].splice(cardIndex, 1);
  stealItem(game, seat, captured, randomIndex, events);
  game.itemUsed[seat] = true;
  game.moveNumber++;
  game.lastMove = {
    id: game.moveNumber, kind: 'item', card, seat, piece: sourcePiece,
    from, to: from, path: [from], captured, effects: [], events,
    selfReturned: false, selfReturnFrom: null, returnReason: null, at: Date.now(),
    taunt: enabled(game, 'captureEffects') && captured.length ? '导弹已锁定，送你返航！' : '',
  };
  note(game, COLORS[seat].name + '方' + text, events[0].type);
  return game;
}
export function movePiece(game, seat, piece, randomIndex = randomInt, automatic = false) {
  assertTurn(game, seat, 'move', automatic);
  if (!Number.isInteger(piece) || !game.legal.includes(piece)) throw new Error('请选择高亮的飞机');
  if (isFrozen(game, seat, piece) && game.dice !== 6) throw new Error('这架飞机已被冻结，掷出 6 点才能解冻移动');
  // Thaw only the selected plane. A new ice landing below can freeze it again.
  const thawed = isFrozen(game, seat, piece);
  game.frozenPieces[seat][piece] = false;
  const from = game.pieces[seat][piece];
  const captain = captainFor(game, seat);
  const steps = captain ? game.steps : game.dice;
  const reserved = captain && from === TAKEOFF && game.reserveSteps[seat][piece] ? 1 : 0;
  if (reserved) game.reserveSteps[seat][piece] = false;
  const moveSteps = steps + reserved;
  const captured = [];
  const stealableCaptured = [];
  const mineVictims = new Map();
  const path = [];
  const effects = [];
  const events = [];
  let selfReturned = false;
  let selfReturnFrom = null;
  let returnReason = null;
  let ambushCapture = false;
  let flew = false;
  let jumped = false;
  const launching = from === -1;
  // The apron exits onto the adjacent corner triangle (progress 1).
  let to = launching ? TAKEOFF : from === TAKEOFF ? moveSteps : from + moveSteps;
  if (to > FINISH) to = FINISH * 2 - to;
  let chasing = false;
  const target = captain?.revengeTarget;
  if (target && from >= 0 && from <= 50 && game.active.includes(target.seat) && !hasRank(game, target.seat) && !allied(game, seat, target.seat)) {
    const targetFrom = game.pieces[target.seat][target.piece];
    const targetTo = (STARTS[target.seat] + targetFrom - STARTS[seat] + 52) % 52;
    if (targetFrom >= 0 && targetFrom <= 50 && targetTo <= 50) {
      to = targetTo;
      chasing = true;
      captain.revengeTarget = null;
      events.push({ type: 'REVENGE_CHASE', targetSeat: target.seat, targetPiece: target.piece, at: to, from, to });
    }
  }
  const settleLanding = (progress, countStats = true) => {
    const index = progress >= 0 && progress <= 50 ? (STARTS[seat] + progress) % 52 : null;
    const mine = enabled(game, 'items') && !(enabled(game, 'safe') && specialCellAt(index) === 'safe')
      && game.mines.find(entry => entry.index === index
      && entry.seat !== seat && !allied(game, seat, entry.seat));
    if (mine) {
      game.mines = game.mines.filter(entry => entry !== mine);
      if (returnPlane(game, seat, piece, { attackerSeat: mine.seat, attackerPiece: mine.piece, events, at: progress, moving: true })) {
        addStat(game, mine.seat, seat);
        mineVictims.set(mine.seat, [{ seat, piece }]);
        selfReturned = true;
        selfReturnFrom = progress;
        returnReason = 'mine';
        events.push({ type: 'MINE_HIT', at: progress, from: progress, to: -1, owner: mine.seat, victimSeat: seat, victimPiece: piece });
        to = -1;
        return;
      }
    }
    const before = captured.length;
    capture(game, seat, progress, captured, countStats, piece, events, randomIndex);
    if (countStats && captured.length > before) {
      ambushCapture = true;
      stealableCaptured.push(...captured.slice(before));
    }
  };
  const breakWall = progress => {
    const before = captured.length;
    capture(game, seat, progress, captured, true, piece, events, randomIndex);
    stealableCaptured.push(...captured.slice(before));
    addStat(game, seat, seat);
    selfReturned = true;
    selfReturnFrom = progress;
    returnReason = 'wall';
    returnPlane(game, seat, piece, { shieldable: false, moving: true, events, at: progress });
    events.push({ type: 'WALL_BREAK', at: progress, from, to: -1 });
    to = -1;
  };
  // Only the dice movement walks the whole ground route. Colour jumps and
  // flights keep their airborne route, but their landing must respect a wall.
  const origin = from === TAKEOFF ? 0 : from;
  const wall = !launching && !chasing && origin <= 50 ? firstWall(game, seat, origin, Math.min(50, origin + moveSteps)) : null;
  let bounced = false;
  if (chasing && wallAt(game, seat, to)) {
    path.push(to);
    breakWall(to);
  } else if (wall != null) {
    const distance = wall - origin;
    if (moveSteps === distance) {
      path.push(wall);
      breakWall(wall);
    } else {
      bounced = true;
      const front = wall - 1;
      path.push(front);
      to = blockedLanding(game, seat, front, Math.max(0, front - (moveSteps - distance)));
      if (to !== front) path.push(to);
      settleLanding(to, false);
      events.push({ type: 'WALL_BOUNCE', at: wall, from, to });
    }
  } else {
    path.push(to);
    settleLanding(to);
  }
  // Special spaces replace the colour reward on their direct landing.
  if (!launching && !chasing && !selfReturned && !bounced && to <= 50 && !specialLanding(game, seat, to)) {
    if (to === FLIGHT_FROM) {
      flew = true;
      to = FLIGHT_TO;
      path.push(to);
      if (wallAt(game, seat, to)) breakWall(to);
      else settleLanding(to);
    } else if (cellColor((STARTS[seat] + to) % 52) === seat && to + 4 <= 50) {
      jumped = true;
      to += 4;
      path.push(to);
      if (wallAt(game, seat, to)) breakWall(to);
      else settleLanding(to);
      if (!selfReturned && to === FLIGHT_FROM && !specialLanding(game, seat, to)) {
        flew = true;
        to = FLIGHT_TO;
        path.push(to);
        if (wallAt(game, seat, to)) breakWall(to);
        else settleLanding(to);
      }
    }
  }
  const effect = !launching && !chasing && !selfReturned && !bounced && specialLanding(game, seat, to);
  let luckyDelta = null;
  if (effect) {
    const landing = to;
    if (effect === 'speed') to = blockedLanding(game, seat, to, Math.min(FINISH, to + 2));
    else if (effect === 'trap') to = blockedLanding(game, seat, to, Math.max(0, to - 3));
    else if (effect === 'lucky') {
      luckyDelta = LUCKY_STEPS[randomIndex(LUCKY_STEPS.length)];
      to = blockedLanding(game, seat, to, Math.max(0, Math.min(FINISH, to + luckyDelta)));
    } else if (effect === 'ice') {
      game.frozenPieces[seat][piece] = true;
      game.iceCell = null;
    }
    effects.push({ type: effect, from: landing, to, ...(effect === 'lucky' ? { delta: luckyDelta } : {}) });
    // Extra movement settles once, without another colour or special reward.
    if (to !== landing) {
      path.push(to);
      settleLanding(to, effect === 'speed' || effect === 'lucky' && luckyDelta > 0);
    }
  }
  // Betrayal rewards a real forward capture, never a passive retreat or item.
  // It settles once and cannot trigger another special space or colour reward.
  if (enabled(game, 'alliances') && game.ambush[seat] && ambushCapture && !selfReturned && !bounced && effect !== 'ice') {
    game.ambush[seat] = false;
    const landing = to;
    to = blockedLanding(game, seat, to, Math.min(FINISH, to + 2));
    effects.push({ type: 'ambush', from: landing, to });
    events.push({ type: 'AMBUSH', at: landing, from: landing, to });
    if (to !== landing) {
      path.push(to);
      settleLanding(to);
    }
  }
  if (captain?.flashReady && !launching && !selfReturned && effect !== 'ice' && !isFrozen(game, seat, piece)) {
    captain.flashReady = false;
    const landing = to;
    to = blockedLanding(game, seat, to, Math.min(FINISH, to + 3));
    effects.push({ type: 'flash', from: landing, to });
    events.push({ type: 'SKILL_FLASH', at: landing, from: landing, to });
    if (to !== landing) {
      path.push(to);
      settleLanding(to);
    }
  }
  game.pieces[seat][piece] = to;
  if (to === FINISH || to === -1) {
    game.frozenPieces[seat][piece] = false;
    if (captain) game.shields[seat][piece] = false;
  }
  stealItem(game, seat, stealableCaptured, randomIndex, events);
  for (const [owner, victims] of mineVictims) stealItem(game, owner, victims, randomIndex, events);
  game.moveNumber++;
  game.lastMove = {
    id: game.moveNumber, seat, piece, from, to, path, captured, effects, events,
    selfReturned, selfReturnFrom, returnReason, at: Date.now(),
    taunt: game.mode === 'classic' || enabled(game, 'captureEffects')
      ? returnReason === 'wall' ? '此墙不破，我誓不为机！' : returnReason === 'mine' ? '地雷起飞，免费返航！'
        : bounced ? '墙太硬了……我还会回来的！'
          : game.mode === 'fun' && captured.length ? CAPTURE_TAUNTS[(game.moveNumber - 1) % CAPTURE_TAUNTS.length] : '' : '',
  };
  let text = COLORS[seat].name + '方 ' + (piece + 1) + ' 号';
  text += launching ? '飞机出门到停机坪' : to === FINISH ? '飞机到达终点' : '飞机前进';
  if (flew) text += '，飞越航线';
  else if (jumped) text += '，同色跳跃';
  const specialMove = effects.find(entry => entry.type === effect);
  if (effect === 'speed') text += '，加速前进 ' + (specialMove.to - specialMove.from) + ' 格';
  else if (effect === 'trap') text += '，触发陷阱后退 ' + (specialMove.from - specialMove.to) + ' 格';
  else if (effect === 'safe') text += '，停靠安全岛';
  else if (effect === 'lucky') {
    const actual = specialMove.to - specialMove.from;
    text += '，幸运格随机' + (luckyDelta > 0 ? '前进 ' : '后退 ') + Math.abs(luckyDelta) + ' 格';
    if (actual !== luckyDelta) text += actual === 0 ? '，实际停留原格' : '，实际' + (actual > 0 ? '前进 ' : '后退 ') + Math.abs(actual) + ' 格';
  }
  else if (effect === 'ice') text += '，落入冰冻格，需要掷出 6 点解冻';
  const ambushMove = effects.find(entry => entry.type === 'ambush');
  if (ambushMove) text += '，背叛奖励额外前进 ' + (ambushMove.to - ambushMove.from) + ' 格';
  if (returnReason === 'wall') text += '，自爆破墙并返回机场';
  else if (returnReason === 'mine') text += '，触发地雷返回机场';
  else if (bounced) text += '，被墙阻挡并反弹';
  if (captured.length) text += '，撞回 ' + captured.length + ' 架飞机（' + captured.map(hit => COLORS[hit.seat].name + '方 ' + (hit.piece + 1) + ' 号').join('、') + '）';
  if (thawed) text += '，解除冰冻';
  if (reserved) text += '，保留的起飞进度额外前进 1 格';
  if (chasing) text += '，追击锁定敌机';
  const flashMove = effects.find(entry => entry.type === 'flash');
  if (flashMove) text += '，闪现额外前进 ' + (flashMove.to - flashMove.from) + ' 格';
  const type = returnReason === 'mine' ? 'MINE_HIT' : returnReason === 'wall' ? 'WALL_BREAK'
    : bounced ? 'WALL_BOUNCE' : ambushMove ? 'AMBUSH' : captured.length ? 'CAPTURE'
      : flashMove ? 'SKILL_FLASH' : chasing ? 'REVENGE_CHASE'
      : effect ? ({ speed: 'SPEED', trap: 'TRAP', safe: 'SAFE', lucky: 'LUCKY', ice: 'FROZEN' })[effect]
        : to === FINISH ? 'ARRIVAL' : thawed ? 'THAWED' : null;
  note(game, text, type);
  if (game.pieces[seat].every(p => p === FINISH)) {
    finishPlayer(game, seat);
  } else nextTurn(game, game.dice === 6);
  return game;
}
export function autoTurn(game, value, randomIndex = randomInt) {
  if (game.status !== 'playing') return game;
  if (hasRank(game, game.turn)) nextTurn(game);
  const seat = game.turn;
  note(game, COLORS[seat].name + '方操作超时，系统自动走棋', 'AUTO_TURN');
  if (game.phase === 'roll') rollDice(game, seat, value, randomIndex, true);
  if (game.phase === 'move' && game.turn === seat) {
    if (game.rerollOffered && !game.legal.length) acceptRoll(game, seat, true);
    else movePiece(game, seat, game.legal[0], randomIndex, true);
  }
  return game;
}
