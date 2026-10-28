// 미니 시카쿠: 숫자 칸 읽기 → 각 숫자를 넓이로 하는 직사각형으로 판 나누기 → 드래그 좌표
const attr = (a, k) => (a.match(new RegExp(` ${k}="([^"]*)"`)) || [])[1];
export function read(xml, W) {
  const re = /<XCUIElementType(\w+)([^>]*?)\/?>/g; let m; const all = [];
  while ((m = re.exec(xml))) { const a = m[2]; if (attr(a, 'visible') !== 'true') continue;
    all.push({ type: m[1], t: (attr(a, 'label') || attr(a, 'name') || '').trim(), x: +attr(a, 'x'), y: +attr(a, 'y'), w: +attr(a, 'width'), h: +attr(a, 'height') }); }
  const tool = all.find(e => e.t === '되돌리기'); if (!tool) throw new Error('시카쿠 화면이 아님');
  const nums = all.filter(e => e.type === 'StaticText' && /^\d+$/.test(e.t) && e.y < tool.y && e.y > 100)
    .map(e => ({ v: +e.t, cx: e.x + e.w / 2, cy: e.y + e.h / 2 }));
  const total = nums.reduce((a, b) => a + b.v, 0);
  const xs = [...new Set(nums.map(n => Math.round(n.cx)))].sort((a, b) => a - b);
  const ys = [...new Set(nums.map(n => Math.round(n.cy)))].sort((a, b) => a - b);
  const diffs = [...xs.slice(1).map((v, i) => v - xs[i]), ...ys.slice(1).map((v, i) => v - ys[i])].filter(d => d > 20);
  const base = Math.min(...diffs);
  const cell = diffs.filter(d => Math.round(d / base) === 1).reduce((a, b) => a + b, 0) / diffs.filter(d => Math.round(d / base) === 1).length;
  const C = Math.round((W - 40) / cell);
  if (total % C) throw new Error(`숫자 합 ${total} 이 가로 ${C}칸으로 안 나눠짐`);
  const R = total / C;
  const x0 = W / 2 - (C * cell) / 2;
  const y0 = tool.y - 26 - R * cell;   // 판 아래와 도구 버튼 사이 간격 약 26pt
  const clues = nums.map(n => ({ v: n.v, c: Math.round((n.cx - x0 - cell / 2) / cell), r: Math.round((n.cy - y0 - cell / 2) / cell) }));
  if (clues.some(q => q.r < 0 || q.r >= R || q.c < 0 || q.c >= C)) throw new Error('숫자 칸 위치 계산 실패');
  const N = C;
  return { R, C, N: C, cell, x0, y0, clues };
}
export function solve({ R, C, clues }) {
  const grid = Array.from({ length: R }, () => Array(C).fill(-1));
  const cands = clues.map((cl, i) => { const out = [];
    for (let h = 1; h <= cl.v; h++) { if (cl.v % h) continue; const w = cl.v / h;
      for (let r = cl.r - h + 1; r <= cl.r; r++) for (let c = cl.c - w + 1; c <= cl.c; c++) {
        if (r < 0 || c < 0 || r + h > R || c + w > C) continue;
        if (clues.some((o, j) => j !== i && o.r >= r && o.r < r + h && o.c >= c && o.c < c + w)) continue;
        out.push({ r, c, h, w }); } }
    return out; });
  const order = clues.map((_, i) => i).sort((a, b) => cands[a].length - cands[b].length);
  const res = [];
  const fits = (q) => { for (let r = q.r; r < q.r + q.h; r++) for (let c = q.c; c < q.c + q.w; c++) if (grid[r][c] !== -1) return false; return true; };
  const set = (q, v) => { for (let r = q.r; r < q.r + q.h; r++) for (let c = q.c; c < q.c + q.w; c++) grid[r][c] = v; };
  const bt = (k) => { if (k === order.length) return grid.every(row => row.every(v => v !== -1));
    const i = order[k]; for (const q of cands[i]) if (fits(q)) { set(q, i); res[i] = q; if (bt(k + 1)) return true; set(q, -1); } return false; };
  if (!bt(0)) throw new Error('풀이 없음');
  return res;
}
