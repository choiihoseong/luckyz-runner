// 미니 스도쿠: 화면 XML 에서 판 읽기 → 풀기 → 탭 입력
const attr = (a, k) => (a.match(new RegExp(` ${k}="([^"]*)"`)) || [])[1];
function els(xml) {
  const out = []; const re = /<XCUIElementType(\w+)([^>]*?)\/?>/g; let m;
  while ((m = re.exec(xml))) { const a = m[2]; if (attr(a, 'visible') !== 'true') continue;
    out.push({ type: m[1], t: (attr(a, 'label') || attr(a, 'name') || '').trim(), x: +attr(a, 'x'), y: +attr(a, 'y'), w: +attr(a, 'width'), h: +attr(a, 'height') }); }
  return out;
}
export function readBoard(xml, W) {
  const all = els(xml);
  const tool = all.find(e => e.t === '되돌리기' || e.t === '지우기');
  if (!tool) throw new Error('스도쿠 화면이 아님(되돌리기 버튼 없음)');
  const digits = all.filter(e => e.type === 'StaticText' && /^[1-9]$/.test(e.t));
  const pad = digits.filter(e => e.y > tool.y).sort((a, b) => a.x - b.x);
  const N = pad.length; if (![4, 6, 9].includes(N)) throw new Error(`숫자 버튼 수가 이상함: ${N}`);
  const cells = digits.filter(e => e.y < tool.y && e.w > 20 && e.w < 120);
  const size = cells.map(c => c.w).sort((a, b) => a - b)[Math.floor(cells.length / 2)];
  const x0 = W / 2 - (N * size) / 2;
  const ys = cells.map(c => c.y); const ymax = Math.max(...ys), ymin = Math.min(...ys);
  const y0 = Math.round((ymax - ymin) / size) >= N - 1 ? ymin : ymax - (N - 1) * size;
  const g = Array.from({ length: N }, () => Array(N).fill(0));
  for (const c of cells) {
    const col = Math.round((c.x - x0) / size), row = Math.round((c.y - y0) / size);
    if (row < 0 || row >= N || col < 0 || col >= N) throw new Error(`칸 위치 계산 실패 (${c.x},${c.y})`);
    g[row][col] = +c.t;
  }
  const [br, bc] = { 4: [2, 2], 6: [2, 3], 9: [3, 3] }[N];
  return { N, br, bc, g, size, x0, y0, pad };
}
export function solve({ N, br, bc, g }) {
  const s = g.map(r => r.slice());
  const ok = (r, c, v) => { for (let i = 0; i < N; i++) if (s[r][i] === v || s[i][c] === v) return false;
    const r0 = r - (r % br), c0 = c - (c % bc);
    for (let i = 0; i < br; i++) for (let j = 0; j < bc; j++) if (s[r0 + i][c0 + j] === v) return false; return true; };
  let count = 0, first = null;
  const bt = () => { let best = null, bestOpts = null;
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (!s[r][c]) { const o = []; for (let v = 1; v <= N; v++) if (ok(r, c, v)) o.push(v);
      if (!best || o.length < bestOpts.length) { best = [r, c]; bestOpts = o; } }
    if (!best) { count++; if (!first) first = s.map(r => r.slice()); return count > 1; }
    for (const v of bestOpts) { s[best[0]][best[1]] = v; if (bt()) return true; s[best[0]][best[1]] = 0; } return false; };
  bt();
  if (!first) throw new Error('풀이 없음 (판 읽기 오류 가능)');
  return first;
}
