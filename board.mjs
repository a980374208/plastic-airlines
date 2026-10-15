export const COLORS = [
  { name: '绿', hex: '#10d795', key: 'green' },
  { name: '红', hex: '#ff514b', key: 'red' },
  { name: '黄', hex: '#ffd42a', key: 'yellow' },
  { name: '蓝', hex: '#12afe1', key: 'blue' }
];
// Clockwise physical ring. Each colour turns into its own home lane after 50.
export const ROUTE = [
  [6,1],[6,2],[6,3],[6,4],[6,5],[5,6],[4,6],[3,6],[2,6],[1,6],[0,6],[0,7],[0,8],
  [1,8],[2,8],[3,8],[4,8],[5,8],[6,9],[6,10],[6,11],[6,12],[6,13],[6,14],[7,14],[8,14],
  [8,13],[8,12],[8,11],[8,10],[8,9],[9,8],[10,8],[11,8],[12,8],[13,8],[14,8],[14,7],[14,6],
  [13,6],[12,6],[11,6],[10,6],[9,6],[8,5],[8,4],[8,3],[8,2],[8,1],[8,0],[7,0],[6,0]
];
export const STARTS = [0,13,26,39];
export const GAME_MODES = Object.freeze(['classic', 'fun']);
export const CAPTAINS = Object.freeze([
  { key: 'flash', name: '闪现者', icon: '⚡', maxUses: 3, active: '本次走棋后额外前进 3 格，全局 3 次', passive: '掷出 6 点时移动步数 +1，连续掷 6 每次生效' },
  { key: 'shield', name: '护盾者', icon: '🛡️', maxUses: 2, active: '为自己一架飞机加护盾，抵挡一次撞击，全局 2 次', passive: '回机场后，下次离开停机坪额外前进 1 格，不累积' },
  { key: 'betrayer', name: '背叛者', icon: '🗡️', maxUses: 1, active: '交换己机与盟友的一架外环飞机，每局一次', passive: '主动撞飞敌机时随机偷取一张道具，手牌上限 3 张' },
  { key: 'avenger', name: '复仇者', icon: '🔥', maxUses: 1, active: '锁定曾撞过自己的敌机，己机下一次外环移动追到其当前格，每局一次', passive: '被敌方撞回机场后，下个轮次首骰实际步数加 2，不累积' },
  { key: 'gambler', name: '赌徒', icon: '🎲', maxUses: 2, active: '强制重掷一次，必须接受新点数，全局 2 次', passive: '掷出 1 点时随机获得一张道具，手牌上限 3 张' },
].map(captain => Object.freeze(captain)));
export const DEFAULT_FUN_RULES = Object.freeze({
  speed: true, trap: true, safe: true, lucky: true, ice: true,
  captureEffects: true, alliances: false, items: false, captains: false
});
export function normalizeRules(mode, rules = {}) {
  if (!GAME_MODES.includes(mode)) throw new Error('游戏模式无效');
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) throw new Error('趣味规则配置无效');
  for (const [key, value] of Object.entries(rules)) {
    if (!Object.hasOwn(DEFAULT_FUN_RULES, key) || typeof value !== 'boolean') throw new Error('趣味规则开关无效');
  }
  const selected = { ...DEFAULT_FUN_RULES, ...rules };
  if (mode === 'fun' && selected.captains) selected.alliances = selected.items = true;
  return Object.fromEntries(Object.keys(DEFAULT_FUN_RULES).map(key => [key, mode === 'fun' && selected[key]]));
}
// Fixed special spaces repeat in every quadrant; ice is generated per game.
export const SPECIAL_CELLS = Object.freeze(STARTS.flatMap(start => [
  Object.freeze({ index: start + 2, type: 'safe' }),
  Object.freeze({ index: start + 7, type: 'speed' }),
  Object.freeze({ index: start + 10, type: 'trap' }),
  Object.freeze({ index: start + 11, type: 'lucky' }),
]));
export function specialCellAt(index) {
  return SPECIAL_CELLS.find(cell => cell.index === index)?.type ?? null;
}
// -1 is in the airport; TAKEOFF is the owner's private apron, outside the ring.
export const TAKEOFF = -2;
export const TAKEOFFS = [[4.5,0],[0,9.5],[9.5,14],[14,4.5]];
export const HOME_LANES = [
  [[7,1],[7,2],[7,3],[7,4],[7,5],[7,6]],
  [[1,7],[2,7],[3,7],[4,7],[5,7],[6,7]],
  [[7,13],[7,12],[7,11],[7,10],[7,9],[7,8]],
  [[13,7],[12,7],[11,7],[10,7],[9,7],[8,7]]
];
export const FINISH = 57;
export const FLIGHT_FROM = 18;
export const FLIGHT_TO = 30;
export const AIRPORTS = [
  [[1.8,1.8],[1.8,3.8],[3.8,1.8],[3.8,3.8]],
  [[1.8,10.2],[1.8,12.2],[3.8,10.2],[3.8,12.2]],
  [[10.2,10.2],[10.2,12.2],[12.2,10.2],[12.2,12.2]],
  [[10.2,1.8],[10.2,3.8],[12.2,1.8],[12.2,3.8]]
];
export function positionFor(seat, progress, piece = 0) {
  if (progress === TAKEOFF) return TAKEOFFS[seat];
  if (progress < 0 || progress >= FINISH) return AIRPORTS[seat][piece];
  if (progress >= 51) return HOME_LANES[seat][progress - 51];
  return ROUTE[(STARTS[seat] + progress) % ROUTE.length];
}
export function cellColor(index) {
  for (let seat = 0; seat < 4; seat++) {
    if (index === (STARTS[seat] + FLIGHT_FROM) % 52 || index === (STARTS[seat] + FLIGHT_TO) % 52) return seat;
  }
  return (index + 2) % 4;
}
