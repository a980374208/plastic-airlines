import { COLORS, ROUTE, HOME_LANES, STARTS, AIRPORTS, cellColor, FLIGHT_FROM, FLIGHT_TO } from '/board.mjs';
const UNIT = 40;

function xy(position) { return [(position[1] + .5) * UNIT, (position[0] + .5) * UNIT]; }
function tile(position, color, extra = '', className = '', dataColor = '') {
  return `<rect class="board-tile ${className}" ${dataColor !== '' ? `data-color="${dataColor}"` : ''} x="${position[1] * UNIT + 1}" y="${position[0] * UNIT + 1}" width="${UNIT - 2}" height="${UNIT - 2}" rx="7" fill="${color}"/>${extra}`;
}
function arrow(position, rotation = 0, opacity = 1) {
  const [x, y] = xy(position);
  return `<path d="M-9 2H4V-7M-1-2 4-7 9-2" stroke="#ffffff" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}" transform="translate(${x} ${y}) rotate(${rotation})"/>`;
}
export function renderPreviewBase(idPrefix = 'game') {
  let content = `<defs><filter id="${idPrefix}-shadow" x="-60%" y="-60%" width="220%" height="240%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#051126" flood-opacity=".55"/></filter><filter id="preview-piece-shadow" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="0" dy="2" stdDeviation="1.2" flood-color="#051126" flood-opacity=".6"/></filter></defs>`;
  COLORS.forEach((color, seat) => {
    const left = (seat === 0 || seat === 3 ? .8 : 9.4) * UNIT;
    const top = (seat === 0 || seat === 1 ? .8 : 9.4) * UNIT;
    content += `<rect class="airport-base airport-color-${seat}" data-airport="${seat}" x="${left}" y="${top}" width="${4.8 * UNIT}" height="${4.8 * UNIT}" rx="15" fill="${color.hex}" opacity=".98"/>`;
    AIRPORTS[seat].forEach((position) => {
      const [x, y] = xy(position);
      content += `<circle cx="${x}" cy="${y}" r="${UNIT * .53}" fill="#ffffff" opacity=".32"/>`;
    });
    content += `<text class="airport-label" x="${left + 12}" y="${top + 17}" fill="#0c1d40" opacity=".48">${color.name}色机场</text>`;
    const from = xy(ROUTE[(STARTS[seat] + FLIGHT_FROM) % 52]);
    const to = xy(ROUTE[(STARTS[seat] + FLIGHT_TO) % 52]);
    content += `<path class="preview-flight-path flight-arrow-${seat}" data-flight-seat="${seat}" d="M${from.join(' ')} L${to.join(' ')}" stroke="${color.hex}" stroke-width="14" opacity=".13"/>`;
  });
  ROUTE.forEach((position, index) => {
    const seat = STARTS.indexOf(index);
    const colorIndex = cellColor(index);
    content += tile(position, COLORS[colorIndex].hex, seat < 0 ? '' : arrow(position, [90, 180, -90, 0][seat]), `tile-color-${colorIndex}`, colorIndex);
    for (let owner = 0; owner < 4; owner++) {
      if (index === (STARTS[owner] + FLIGHT_FROM) % 52) {
        const [x, y] = xy(position);
        content += `<path d="M0-10 3-3 10 0 3 3 0 10-3 3-10 0-3-3Z" fill="#fff" opacity=".7" transform="translate(${x} ${y})"/>`;
      }
    }
  });
  HOME_LANES.forEach((lane, seat) => lane.forEach((position, index) => {
    const [x, y] = xy(position);
    content += tile(position, COLORS[seat].hex, '', `home-color-${seat}`, seat);
    if (index === 2) content += `<circle cx="${x}" cy="${y}" r="${UNIT * .28}" fill="#fff" opacity=".82"/>`;
    if (index === 0) content += `<path d="M-4-6 3 0-4 6" fill="none" stroke="#fff" opacity=".65" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" transform="translate(${x} ${y}) rotate(${[0, 90, 180, -90][seat]})"/>`;
  }));
  const center = 7 * UNIT;
  const middle = 7.5 * UNIT;
  content += `<g class="board-finish"><path class="finish-sector-1" data-finish-seat="1" d="M${center} ${center}H${center + UNIT}L${middle} ${middle}Z" fill="${COLORS[1].hex}"/><path class="finish-sector-2" data-finish-seat="2" d="M${center + UNIT} ${center}V${center + UNIT}L${middle} ${middle}Z" fill="${COLORS[2].hex}"/><path class="finish-sector-3" data-finish-seat="3" d="M${center + UNIT} ${center + UNIT}H${center}L${middle} ${middle}Z" fill="${COLORS[3].hex}"/><path class="finish-sector-0" data-finish-seat="0" d="M${center} ${center + UNIT}V${center}L${middle} ${middle}Z" fill="${COLORS[0].hex}"/></g><circle cx="${middle}" cy="${middle}" r="9" fill="#fff" opacity=".94"/><path d="m${middle - 4} ${middle} 3 3 6-6" stroke="#1a365b" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
  return content;
}
