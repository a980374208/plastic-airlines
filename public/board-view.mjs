import { COLORS, STARTS, FINISH, TAKEOFF, cellColor, FLIGHT_FROM, FLIGHT_TO, SPECIAL_CELLS, specialCellAt, normalizeRules } from '../board.mjs';

export const VIEW_SIZE = 600;
const UNIT = 40;
const MIDDLE = 7;
const TILE = 44;
const HALF_TILE = TILE / 2;
const CORNER = 3.5;
const INNER_LOW = CORNER - TILE / (6 * UNIT);
const INNER_HIGH = CORNER + TILE / (6 * UNIT);

// The four recessed bends each contain TWO triangular spaces. This retains the
// complete 52-space route while reproducing the reference board's outline.
// A quarter begins at its home entrance and ends just before the next entrance.
const QUARTER = [
  [7, 0], [35 / 6, 0], [14 / 3, 0], [CORNER, 0],
  [CORNER, 7 / 6], [CORNER, 7 / 3],
  [INNER_HIGH, INNER_LOW], [INNER_LOW, INNER_HIGH],
  [7 / 3, CORNER], [7 / 6, CORNER], [0, CORNER],
  [0, 14 / 3], [0, 35 / 6]
];
function rotate(position, turns = 1) {
  let [row, col] = position;
  for (let turn = 0; turn < turns; turn++) [row, col] = [col, MIDDLE * 2 - row];
  return [row, col];
}
function xy([row, col]) { return [(col + .5) * UNIT, (row + .5) * UNIT]; }
function number(value) { return Number(value.toFixed(3)); }
const VISUAL_ROUTE = Array(52);
const VISUAL_ROUTE_SPACES = Array(52);
for (let turn = 0; turn < 4; turn++) {
  QUARTER.forEach((position, step) => {
    const index = (50 + turn * 13 + step) % 52;
    const outerCorner = step === 3 || step === 10;
    const center = outerCorner ? position.map((value) => value + TILE / (6 * UNIT)) : position;
    VISUAL_ROUTE[index] = rotate(center, turn);
    VISUAL_ROUTE_SPACES[index] = { kind: outerCorner ? 'outer-corner' : 'other', turns: outerCorner ? turn : 0 };
  });
}
const CORNER_LOW = (CORNER + .5) * UNIT;
const CORNER_HIGH = VIEW_SIZE - CORNER_LOW;
const FLIGHT_POINTS = [
  [[CORNER_HIGH, CORNER_LOW], [CORNER_HIGH, CORNER_HIGH]],
  [[CORNER_HIGH, CORNER_HIGH], [CORNER_LOW, CORNER_HIGH]],
  [[CORNER_LOW, CORNER_HIGH], [CORNER_LOW, CORNER_LOW]],
  [[CORNER_LOW, CORNER_LOW], [CORNER_HIGH, CORNER_LOW]]
];
const LANE_CENTERS = [0.905, 1.77, 2.635, 3.5, 4.365, 5.23];
const VISUAL_HOME_LANES = Array.from({ length: 4 }, (_, seat) => LANE_CENTERS.map((col) => rotate([7, col], seat)));
const VISUAL_AIRPORTS = [
  [[.525, .525], [.525, 1.575], [1.575, .525], [1.575, 1.575]],
  [[.525, 12.425], [.525, 13.475], [1.575, 12.425], [1.575, 13.475]],
  [[12.425, 12.425], [12.425, 13.475], [13.475, 12.425], [13.475, 13.475]],
  [[12.425, .525], [12.425, 1.575], [13.475, .525], [13.475, 1.575]]
];
const VISUAL_TAKEOFFS = Array.from({ length: 4 }, (_, seat) => rotate([139 / UNIT - .5, 18 / UNIT - .5], seat));

export function visualPositionFor(seat, progress, piece = 0) {
  if (progress === TAKEOFF) return VISUAL_TAKEOFFS[seat];
  if (progress < 0 || progress >= FINISH) return VISUAL_AIRPORTS[seat][piece];
  if (progress >= 51) return VISUAL_HOME_LANES[seat][progress - 51];
  return VISUAL_ROUTE[(STARTS[seat] + progress) % VISUAL_ROUTE.length];
}

export function visualHeadingFor(seat, progress, piece = 0) {
  if (progress !== TAKEOFF && (progress < 0 || progress >= FINISH)) return [90, 180, -90, 0][seat];
  const [x, y] = xy(visualPositionFor(seat, progress, piece));
  // An apron exits at progress 1; the final home space points at the centre.
  const next = progress === TAKEOFF ? visualPositionFor(seat, 1, piece)
    : progress === FINISH - 1 ? [MIDDLE, MIDDLE] : visualPositionFor(seat, progress + 1, piece);
  const [nextX, nextY] = xy(next);
  return number(Math.atan2(nextY - y, nextX - x) * 180 / Math.PI + 90);
}

export function visualSpaceFor(seat, progress) {
  if (progress === TAKEOFF) return { kind: 'takeoff', turns: seat };
  if (progress < 0 || progress > 50) return { kind: 'other', turns: 0 };
  return VISUAL_ROUTE_SPACES[(STARTS[seat] + progress) % VISUAL_ROUTE.length];
}

function airportMarkup(seat) {
  const [x, y] = [[10, 10], [486, 10], [486, 486], [10, 486]][seat];
  return `<g class="board-airport airport-color-${seat}" data-airport="${seat}"><rect class="airport-base" x="${x}" y="${y}" width="104" height="104" rx="6" fill="${COLORS[seat].hex}"/>${VISUAL_AIRPORTS[seat].map((position) => {
    const [cx, cy] = xy(position);
    return `<circle class="airport-spot" cx="${cx}" cy="${cy}" r="18" fill="#fff" fill-opacity=".48"/>`;
  }).join('')}</g>`;
}
function flightMarkup(seat) {
  const fromIndex = (STARTS[seat] + FLIGHT_FROM) % 52;
  const toIndex = (STARTS[seat] + FLIGHT_TO) % 52;
  const [[x1, y1], [x2, y2]] = FLIGHT_POINTS[seat];
  const angle = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
  const line = `M${number(x1)} ${number(y1)}L${number(x2)} ${number(y2)}`;
  const arrows = [1 / 3, 2 / 3].map((fraction) => {
    const x = number(x1 + (x2 - x1) * fraction);
    const y = number(y1 + (y2 - y1) * fraction);
    return `<path class="flight-arrow flight-arrow-${seat}" d="M-8-7-1 0-8 7M0-7 7 0 0 7" transform="translate(${x} ${y}) rotate(${number(angle)})" fill="none" stroke="${COLORS[seat].hex}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');
  return `<g class="board-flight" data-flight-seat="${seat}" data-flight-from="${fromIndex}" data-flight-to="${toIndex}"><path class="flight-road-bg" d="${line}" fill="none" stroke="#bac3d1" stroke-width="22"/><path class="flight-road-core" d="${line}" fill="none" stroke="#738197" stroke-width="18"/>${arrows}</g>`;
}
const SPECIAL_LABELS = {
  safe: '安全岛：不同颜色可以共存，飞机免疫撞击',
  speed: '加速格：额外前进 2 格，不再触发其他奖励',
  trap: '陷阱格：后退 3 格，最多退到外环起点，不回机场',
  lucky: '幸运格：随机前进或后退 1～3 格，不再触发其他奖励',
  ice: '冰冻格：仅首架落入的飞机被冻结，须掷出 6 点才能移动'
};
function routeMarkup(mode, iceCell, rules) {
  return Array.from({ length: 4 }, (_, turn) => `<g transform="rotate(${turn * 90} 300 300)">${QUARTER.map((position, step) => {
    const index = (50 + turn * 13 + step) % 52;
    const colorIndex = cellColor(index);
    const fill = COLORS[colorIndex].hex;
    const [x, y] = xy(position);
    const type = specialCellAt(index);
    const special = mode === 'fun' ? rules.ice && iceCell === index ? 'ice' : type && rules[type] ? type : null : null;
    const attributes = `class="board-track track-color-${colorIndex}${special === 'ice' ? ' is-ice' : ''}" data-route-index="${index}" data-color="${colorIndex}" fill="${fill}"${special ? ` aria-label="外环 ${index + 1} 格，${SPECIAL_LABELS[special]}"` : ''}`;
    if (step === 6 || step === 7) {
      const [cx, cy] = xy([CORNER, CORNER]);
      const left = cx - HALF_TILE, right = cx + HALF_TILE;
      const top = cy - HALF_TILE, bottom = cy + HALF_TILE;
      // The coordinate for each triangular cell is its actual centroid.
      const points = step === 6 ? `${left},${top} ${left},${bottom} ${right},${bottom}` : `${left},${top} ${right},${top} ${right},${bottom}`;
      return `<polygon ${attributes} points="${points}" stroke="#0b1d40" stroke-width="1.5" stroke-linejoin="round"/>`;
    }
    if (step === 3 || step === 10) {
      const points = `${number(x - HALF_TILE)},${number(y + HALF_TILE)} ${number(x + HALF_TILE)},${number(y - HALF_TILE)} ${number(x + HALF_TILE)},${number(y + HALF_TILE)}`;
      return `<polygon ${attributes} points="${points}" stroke="${fill}" stroke-width="1.3" stroke-linejoin="round"/>`;
    }
    return `<rect ${attributes} x="${number(x - HALF_TILE)}" y="${number(y - HALF_TILE)}" width="${TILE}" height="${TILE}" rx="6"/>`;
  }).join('')}</g>`).join('');
}
function specialMarkup(iceCell, rules) {
  const icons = {
    safe: '<path d="M0-5 4-3V1C4 3 2 5 0 6-2 5-4 3-4 1V-3Z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m-2 0 1.5 1.5L2-2" fill="none" stroke="currentColor" stroke-width="1.4"/>',
    speed: '<path d="m1-6-5 7H0L-1 6 5-1H1Z" fill="currentColor"/>',
    trap: '<path d="M4-3H-3m3-3-3 3 3 3M-3-3V3H4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
    lucky: '<path d="M-4-1H4V5H-4ZM-5-3H5V-1H-5ZM0-3V5M0-3C-6-3-5-7-2-5L0-3C6-3 5-7 2-5Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
    ice: '<path d="M0-6V6M-5-3L5 3M-5 3L5-3M-2-4 0-2 2-4M-2 4 0 2 2 4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'
  };
  const cells = SPECIAL_CELLS.filter(cell => rules[cell.type]);
  if (rules.ice && Number.isInteger(iceCell) && iceCell >= 0 && iceCell < 52) cells.push({ index: iceCell, type: 'ice' });
  return `<g class="board-specials">${cells.map(({ index, type }) => {
    const [x, y] = xy(VISUAL_ROUTE[index]);
    return `<g class="board-special special-${type}" data-special="${type}" data-special-index="${index}" transform="translate(${number(x + 13)} ${number(y - 12)})" role="img" aria-label="外环 ${index + 1} 格，${SPECIAL_LABELS[type]}"><title>${SPECIAL_LABELS[type]}</title><circle r="8.5" fill="#071732" stroke="#f2f7ff" stroke-width="1"/>${icons[type]}</g>`;
  }).join('')}</g>`;
}
function mineMarkup(mines) {
  return `<g class="board-mines" pointer-events="none">${mines.filter(mine => COLORS[mine.seat] && Number.isInteger(mine.index) && mine.index >= 0 && mine.index < 52).map(mine => {
    const [x, y] = xy(VISUAL_ROUTE[mine.index]);
    const label = `${COLORS[mine.seat].name}方公开地雷，外环 ${mine.index + 1} 格`;
    return `<g class="board-mine" data-mine-index="${mine.index}" data-owner="${mine.seat}" transform="translate(${number(x - 13)} ${number(y + 13)})" role="img" aria-label="${label}"><title>${label}</title><circle r="8" fill="#071732" stroke="${COLORS[mine.seat].hex}" stroke-width="1.4"/><path d="M0-5V5M-5 0H5M-3.5-3.5L3.5 3.5M-3.5 3.5L3.5-3.5" stroke="#fff1ce" stroke-width="1.3" stroke-linecap="round"/><circle r="2.3" fill="#ffd42a"/></g>`;
  }).join('')}</g>`;
}
function homeMarkup(seat) {
  const color = COLORS[seat].hex;
  const lane = LANE_CENTERS.map((col, index) => {
    const [x, y] = xy([7, col]);
    return `<rect class="board-home home-color-${seat}" data-home-seat="${seat}" data-home-step="${index}" x="${number(x - 16.75)}" y="${y - 20}" width="33.5" height="40" rx="6" fill="${color}"/>${index === 3 ? `<circle cx="${number(x)}" cy="${y}" r="14" fill="#fff" fill-opacity=".92"/>` : ''}`;
  }).join('');
  return `<g transform="rotate(${seat * 90} 300 300)">${lane}<path class="home-arrow home-arrow-${seat}" d="M14 307V297H27M22 292L27 297 22 302" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></g>`;
}
function takeoffMarkup(seat) {
  return `<g class="board-takeoff takeoff-color-${seat}" data-takeoff-seat="${seat}" transform="rotate(${seat * 90} 300 300)"><path class="takeoff-road" d="M0 120H42V138L0 180Z" fill="${COLORS[seat].hex}"/><g transform="translate(18 139) rotate(45)"><path class="takeoff-plane" d="M0-13 3-4 11 3V5L3 3 2 9 5 11V13L0 11-5 13V11L-2 9-3 3-11 5V3L-3-4Z" fill="#aeb7f8"/><path d="M0-13V11" fill="none" stroke="#e1e5ff" stroke-width="2"/></g></g>`;
}

// A fragment is returned so the caller can append interactive pieces to the
// same outer SVG without nesting viewports or changing pointer coordinates.
export function renderBoardBase(idPrefix = 'game', mode = 'classic', iceCell = null, options, mines = []) {
  const rules = normalizeRules(mode, options);
  const safePrefix = String(idPrefix).replace(/[^a-zA-Z0-9_-]/g, '') || 'game';
  const shadowId = safePrefix === 'game' ? 'piece-shadow' : `${safePrefix}-piece-shadow`;
  return `<defs><filter id="${shadowId}" x="-60%" y="-60%" width="220%" height="220%"><feDropShadow dx="0" dy="1" stdDeviation="1.8" flood-color="#001128" flood-opacity=".5"/></filter></defs><g class="board-base">${[0, 1, 2, 3].map(airportMarkup).join('')}${[0, 1, 2, 3].map(flightMarkup).join('')}${routeMarkup(mode, iceCell, rules)}${[0, 1, 2, 3].map(homeMarkup).join('')}<g class="board-finish" stroke="#0b1d40" stroke-width="1.3"><path class="finish-sector finish-sector-0" data-finish-seat="0" d="M248 248 300 300 248 352Z" fill="${COLORS[0].hex}"/><path class="finish-sector finish-sector-1" data-finish-seat="1" d="M248 248H352L300 300Z" fill="${COLORS[1].hex}"/><path class="finish-sector finish-sector-2" data-finish-seat="2" d="M352 248V352L300 300Z" fill="${COLORS[2].hex}"/><path class="finish-sector finish-sector-3" data-finish-seat="3" d="M248 352H352L300 300Z" fill="${COLORS[3].hex}"/></g>${[0, 1, 2, 3].map(takeoffMarkup).join('')}${mode === 'fun' ? specialMarkup(iceCell, rules) : ''}${rules.items ? mineMarkup(mines) : ''}</g>`;
}
