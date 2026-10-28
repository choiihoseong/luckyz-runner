# 미니 퀸즈: 스크린샷에서 판(테두리·칸수·색 영역) 읽기 → 풀기 → 탭할 pt 좌표 JSON 출력
# 사용: python3 -I queens.py screenshot.png tool_y_pt scale
import sys, json
from PIL import Image
img = Image.open(sys.argv[1]).convert('RGB'); tool_y = int(float(sys.argv[2]) * float(sys.argv[3])); S = float(sys.argv[3])
W, H = img.size; px = img.load()
lum = lambda p: 0.299*p[0] + 0.587*p[1] + 0.114*p[2]
dark = lambda x, y: lum(px[x, y]) < 70
# 1) 바깥 테두리: 도구 버튼 위 영역에서 가로로 가장 길게 이어진 어두운 줄들 중 가장 아래 = 아래 테두리
def longest(y):
    run = best = bs = 0; st = 0
    for x in range(W):
        if dark(x, y):
            if run == 0: st = x
            run += 1
            if run > best: best = run; bs = st
        else: run = 0
    return best, bs
rows = [(y, *longest(y)) for y in range(tool_y - 1, max(0, tool_y - 1400), -1)]
mx = max(r[1] for r in rows)
if mx < W * 0.4: raise SystemExit(json.dumps({"error": "판 테두리 못 찾음"}))
ys = [r for r in rows if r[1] >= mx * 0.97]
bottom_row = ys[0]; top_row = ys[-1]
bottom = bottom_row[0]; top = top_row[0]
run, st = bottom_row[1], bottom_row[2]
corner = (bottom - top) - run   # 둥근 모서리만큼 짧음
left = st - corner // 2; right = st + run + corner // 2
size = right - left
th = 0
while dark(left + th + 2, (top + bottom)//2) and th < 30: th += 1
th += 2
# 2) 칸 수: 가운데 가로줄을 따라 판 안쪽의 선(밝기 200 미만 구간) 개수 + 1
def count_inner(y):
    n = 0; prev = False
    for x in range(left + th + 3, right - th - 3):
        d = lum(px[x, y]) < 200
        if d and not prev: n += 1
        prev = d
    return n + 1
cnts = [count_inner(top + int((bottom - top) * f)) for f in (0.3, 0.5, 0.7)]
N = max(set(cnts), key=cnts.count)
if not 4 <= N <= 10: raise SystemExit(json.dumps({"error": f"칸 수 이상 {N}", "cnts": cnts}))
cell = (size - 2*th) / N
# 3) 영역: 이웃 칸 사이 경계가 굵은 검은 선이면 다른 영역, 가는 선이면 같은 영역 (색이 비슷해도 정확)
ch = (bottom - top - 2*th) / N
cxf = lambda c: left + th + (c + .5)*cell
cyf = lambda r: top + th + (r + .5)*ch
def thick_v(r, c):   # 칸 (r,c) 와 (r,c+1) 사이 세로 경계
    x = left + th + (c + 1)*cell; y = int(cyf(r)); n = 0
    for dx in range(-int(cell*.25), int(cell*.25) + 1):
        if lum(px[int(x + dx), y]) < 70: n += 1
    return n >= 3
def thick_h(r, c):   # 칸 (r,c) 와 (r+1,c) 사이 가로 경계
    y = top + th + (r + 1)*ch; x = int(cxf(c)); n = 0
    for dy in range(-int(ch*.25), int(ch*.25) + 1):
        if lum(px[x, int(y + dy)]) < 70: n += 1
    return n >= 3
par = list(range(N*N))
def f(a):
    while par[a] != a: par[a] = par[par[a]]; a = par[a]
    return a
for r in range(N):
    for c in range(N):
        if c + 1 < N and not thick_v(r, c): par[f(r*N + c)] = f(r*N + c + 1)
        if r + 1 < N and not thick_h(r, c): par[f(r*N + c)] = f((r + 1)*N + c)
ids = {}; reg = [[ids.setdefault(f(r*N + c), len(ids)) for c in range(N)] for r in range(N)]
if len(ids) != N: raise SystemExit(json.dumps({"error": f"영역 {len(ids)}개 (칸 {N})", "reg": reg}))
# 4) 풀기
sol = [-1]*N; usedc = set(); usedr = set()
def bt(r):
    if r == N: return True
    for c in range(N):
        if c in usedc or reg[r][c] in usedr: continue
        if r > 0 and abs(sol[r-1] - c) <= 1: continue
        sol[r] = c; usedc.add(c); usedr.add(reg[r][c])
        if bt(r + 1): return True
        usedc.discard(c); usedr.discard(reg[r][c])
    return False
if not bt(0): raise SystemExit(json.dumps({"error": "풀이 없음", "reg": reg}))
taps = [{"x": round(cxf(sol[r]) / S), "y": round(cyf(r) / S)} for r in range(N)]
print(json.dumps({"N": N, "reg": reg, "sol": sol, "taps": taps}))
