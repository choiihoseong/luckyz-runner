// 사용법: node run.mjs scenarios/예시.yaml [--device sim]
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { ROOT, config, log, startAppium, resilientSession, releaseSession, DEAD_RE } from './lib.mjs';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--device');
const devIdx = args.indexOf('--device');
const deviceName = devIdx >= 0 ? args[devIdx + 1] : undefined;
if (!file) { console.error('사용법: node run.mjs scenarios/파일.yaml [--device sim]'); process.exit(1); }

const sc = YAML.parse(fs.readFileSync(path.resolve(ROOT, file), 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 요소 찾기: text(보이는 글자/라벨) | id(accessibility id) | contains | xpath | predicate
function selectorOf(s) {
  if (s.id) return `~${s.id}`;
  if (s.xpath) return s.xpath;
  if (s.predicate) return `-ios predicate string:${s.predicate}`;
  if (s.text) { const t = s.text.replace(/'/g, "\\'"); return `-ios predicate string:label == '${t}' OR name == '${t}' OR value == '${t}'`; }
  if (s.contains) { const t = s.contains.replace(/'/g, "\\'"); return `-ios predicate string:label CONTAINS '${t}' OR name CONTAINS '${t}' OR value CONTAINS '${t}'`; }
  return null;
}

// below: {contains: 제목}, within: 150  → 제목 바로 아래 within pt 안에 있는 요소만
// kind: Image → 요소 종류 제한 (비활성 버튼은 종류가 바뀌는 경우가 있어 활성만 고를 때 사용)
async function filterEls(drv, s, list) {
  let out = list;
  if (s.kind) { const k = []; for (const el of out) if ((await el.getTagName().catch(() => '')).endsWith(s.kind)) k.push(el); out = k; }
  if (s.below) {
    const asel = selectorOf(typeof s.below === 'string' ? { text: s.below } : s.below);
    let anchor = null; for (const a of await drv.$$(asel)) if (await a.isDisplayed().catch(() => false)) { anchor = a; break; }
    if (!anchor) return [];
    const ay = (await anchor.getLocation()).y, win = s.within ?? 150, k = [];
    const above = s.above ?? 0; for (const el of out) { const y = (await el.getLocation()).y; if (y > ay - above && y < ay + win) k.push(el); }
    out = k;
  }
  if (s.below || s.kind) {
    const withX = []; for (const el of out) withX.push([(await el.getLocation()).x, el]);
    out = withX.sort((a, b) => a[0] - b[0]).map(v => v[1]);   // 왼쪽부터
  }
  return out;
}

async function find(drv, s, timeout = 10000) {
  const sel = selectorOf(s);
  if (!sel) throw new Error('요소 지정이 없습니다 (text / contains / id / xpath / predicate 중 하나)');
  const els = await filterEls(drv, s, await drv.$$(sel));
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const list = await filterEls(drv, s, await drv.$$(sel));
    for (const el of list) if (await el.isDisplayed().catch(() => false)) return el;
    // 웹뷰의 Other 요소는 보여도 isDisplayed=false 인 경우가 있어, 화면 안에 위치하면 인정
    const { height: H } = await drv.getWindowSize();
    for (const el of list) { const r = await el.getElementRect(el.elementId).catch(() => null) ?? await drv.getElementRect(el.elementId).catch(() => null);
      if (r && r.width > 0 && r.height > 0 && r.y >= 40 && r.y + r.height / 2 < H - 60) return el; }
    await sleep(500);
  }
  if (els.length) return els[0];
  throw new Error(`요소를 못 찾음: ${JSON.stringify(s)}`);
}

async function swipe(drv, dir, distance = 0.6, atY = null) {
  const { width: w, height: h } = await drv.getWindowSize();
  const cx = w / 2, cy = atY ?? h / 2, dx = (w * distance) / 2, dy = (h * distance) / 2;
  const ex = 8;   // 세로 스와이프는 왼쪽 가장자리 여백에서 (광고·카드가 손가락을 가로채지 않게)
  const yA = Math.min(cy + dy, h * 0.72), yB = Math.max(cy - dy, h * 0.14);   // 탭바·상단바 피함
  const v = { up: [ex, yA, ex, yB], down: [ex, yB, ex, yA], left: [cx + dx, cy, cx - dx, cy], right: [cx - dx, cy, cx + dx, cy] }[dir];
  if (!v) throw new Error(`swipe 방향은 up/down/left/right: ${dir}`);
  // W3C 터치 동작은 이 앱 웹뷰에서 스크롤로 안 먹힘 → XCUITest 드래그 사용
  await drv.execute('mobile: dragFromToForDuration', { fromX: Math.round(v[0]), fromY: Math.round(v[1]), toX: Math.round(v[2]), toY: Math.round(v[3]), duration: 0.25 });
}

async function shot(drv, name) {
  const dir = path.join(ROOT, 'logs', 'shots'); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${name || 'shot'}.png`);
  await drv.saveScreenshot(f); log('  스크린샷', f);
}


// 광고 넘기기: 위쪽 좌/우 모서리의 X·>>·닫기·건너뛰기 버튼이 활성화되면 탭, until 글자가 보이면 종료
const CLOSE_RE = /close|skip|dismiss|닫기|건너뛰|×|✕|✖|^x$|»|>>|›|cancel/i;
// 화면 어디에 있든 누를 수 있는 '진행' 문구 (짧은 버튼 글자만), 절대 누르지 않을 문구
const PROGRESS_RE = /^(다음\s*보기|다음\s*광고|다음|계속(하기)?|건너뛰기|광고\s*건너뛰기|skip(\s*ad)?|next|continue|보상\s*받기|리워드\s*받기)\s*[>›»]*$/i;
// 럭키즈 자체 화면에만 있는 글자 (광고 화면엔 없음)
const APP_UI_RE = /게임 방법|오늘 걸음 수|게임에서 나가시겠어요/;
// 보상 지급이 끝났다는 광고 표시 (이게 보이면 닫기가 정답)
const REWARD_DONE_RE = /리워드\s*지급|보상\s*지급|보상이\s*지급|reward\s*(granted|earned|received)/i;
const BLOCK_RE = /설치|install|download|다운|구매|열기|^open|play\s*now|자세히|자세한|learn\s*more|더\s*알아보기|시작하려면|지금|shop|buy|get\s*it|바로가기/i;

// 규칙으로 안 풀릴 때: 이 맥의 Claude Code(claude -p)에게 스크린샷+요소목록을 주고 누를 곳을 물어봄
async function askClaude(drv, xml, goalTexts, urgent = false, avoid = []) {
  runState.aiCalls = (runState.aiCalls ?? 0) + 1;
  const { execFile } = await import('node:child_process');
  const dir = path.join(ROOT, 'logs', 'ai'); fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const img = path.join(dir, `${stamp}.png`); await drv.saveScreenshot(img);
  const { width: W, height: H } = await drv.getWindowSize();
  const small = path.join(dir, `${stamp}_s.jpg`);   // 절반 크기 JPEG 로 보내 응답 속도↑ (원본은 학습용 보관)
  try { (await import('node:child_process')).execFileSync('sips', ['-Z', '1300', '-s', 'format', 'jpeg', img, '--out', small], { stdio: 'ignore' }); } catch {}
  const sentImg = fs.existsSync(small) ? small : img;
  const buf = fs.readFileSync(img), pw = buf.readUInt32BE(16), ph = buf.readUInt32BE(20);
  const sentW = sentImg === img ? pw : Math.round(pw * Math.min(1, 1300 / Math.max(pw, ph)));
  const ratio = (W / sentW).toFixed(4);
  const attr = (a, k) => (a.match(new RegExp(` ${k}="([^"]*)"`)) || [])[1];
  const els = []; const re = /<XCUIElementType(\w+)([^>]*?)\/?>/g; let m;
  while ((m = re.exec(xml))) {
    const a = m[2]; if (attr(a, 'visible') !== 'true') continue;
    const t = attr(a, 'label') || attr(a, 'name') || attr(a, 'value') || '';
    if (!t && m[1] !== 'Button') continue;
    els.push(`${m[1]} "${t.slice(0, 40)}" enabled=${attr(a, 'enabled')} x=${attr(a, 'x')} y=${attr(a, 'y')} w=${attr(a, 'width')} h=${attr(a, 'height')}`);
  }
  const prompt = `너는 아이폰 자동화 도우미다. 지금 앱 안에서 보상형 광고가 재생 중이고, 목표는 광고를 끝까지 넘겨서 원래 앱 화면(이런 글자가 보이는 화면: ${goalTexts.join(', ')})으로 돌아가는 것이다.
스크린샷: ${sentImg} (Read 도구로 열어서 볼 것. 이미지 픽셀 좌표 × ${ratio} = 화면 pt 좌표. 반드시 pt 좌표로 답할 것)
화면 크기(좌표 단위 pt): ${W}x${H}
접근성 요소 목록:
${els.slice(0, 80).join('\n')}

규칙:
- 누를 수 있는 것: 닫기(X), 건너뛰기(>>, »), "다음 보기"/"다음 광고"/"계속" 처럼 다음 광고·다음 단계로 넘기는 버튼, 보상 받기 버튼.
- 절대 누르면 안 되는 것: 설치, 다운로드, 앱스토어 이동, 구매, 자세히 보기, Play Now, 광고 본문 영역, 소리 켜기/끄기 아이콘.
- 접근성 목록에 없더라도 스크린샷에 보이는 버튼(특히 좌/우 상단의 X, >>, » 아이콘)은 위 비율로 환산한 pt 좌표로 답할 것. 아이콘의 정중앙을 줄 것.
- "3의 광고 1" 같은 표시는 광고가 여러 개 연달아 나온다는 뜻이다. 이때는 >> 나 "다음 보기"로 다음 광고로 넘겨야 끝난다.
- 정말로 누를 버튼이 없을 때만 wait.${avoid.length ? `\n- 다음 좌표 근처는 이미 눌러봤는데 효과가 없던 자리(소리·정보 버튼 등)이니 고르지 말 것: ${avoid.join(' / ')}` : ''}
- 결제·이체·계좌·인증번호·비밀번호 입력 화면이면 절대 아무것도 누르지 말고 notad 로 답할 것.
- 화면이 광고가 아니라 앱 자체 화면(메뉴·설정·게임 시작 화면·코인 사용 확인창 등)이면 아무것도 누르지 말고 {"action":"notad","reason":"..."} 로 답할 것. 코인을 쓰는 버튼은 절대 누르지 말 것.${urgent ? '\n- 이 광고가 3분 넘게 끝나지 않았다. 화면을 꼼꼼히 보고 다음 단계로 넘어갈 수 있는 버튼을 반드시 찾아라.' : ''}
반드시 JSON 한 줄만 출력: {"action":"tap","x":숫자,"y":숫자,"reason":"짧게"} 또는 {"action":"wait","waitSec":숫자,"reason":"짧게"} 또는 {"action":"notad","reason":"짧게"}.
wait 일 때 waitSec 은 화면의 카운트다운(예: '19초', '0:12')이나 진행바로 보아 닫기 버튼이 나올 때까지 남은 초. 알 수 없으면 0. 좌표는 pt 단위.`;
  const out = await new Promise(res => {
    const cp = execFile('claude', ['-p', '--model', 'sonnet', '--allowedTools=Read'],
      { timeout: 90000, maxBuffer: 1 << 20, cwd: dir, env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` } },
      (err, stdout, stderr) => res((stdout || '') + (err && !stdout ? `\n[오류] ${err.message} ${String(stderr).slice(-300)}` : '')));
    cp.stdin.end(prompt);
  });
  const j = (out.match(/\{[^{}]*"action"[^{}]*\}/) || [])[0];
  fs.writeFileSync(img.replace('.png', '.txt'), `${prompt}\n\n---응답---\n${out}`);
  // 로그인 만료 등 인증 실패: 이번 실행 동안 Claude 를 끄고(헛호출로 시간 낭비 방지) 맥 알림 — 규칙 탭만으로 계속
  if (!j && /Failed to authenticate|OAuth|Not logged in|Invalid API key|\/login/i.test(out)) {
    runState.aiDisabled = true;
    log('    ⚠ Claude 로그인 만료 — 이번 실행은 Claude 판단 없이 진행. 맥 터미널에서 claude 실행 후 /login 필요');
    await incident(drv, 'claude_auth', { out: out.slice(0, 200) });
    try { (await import('node:child_process')).execFileSync('osascript', ['-e', 'display notification "Claude 로그인 만료 — 터미널에서 claude → /login" with title "럭키즈 자동 실행"']); } catch {}
  }
  const scale = fs.readFileSync(img).readUInt32BE(16) / W;
  try { return { d: j ? JSON.parse(j) : null, img, scale }; } catch { return { d: null, img, scale }; }
}

async function textVisible(drv, texts) {
  for (const t of texts) {
    const q = t.replace(/'/g, "\\'");
    for (const el of await drv.$$(`-ios predicate string:label CONTAINS '${q}' OR name CONTAINS '${q}'`))
      if (await el.isDisplayed().catch(() => false)) return t;
  }
  return null;
}
// ── 광고 넘기기 학습 저장소 (logs/learned.json, logs/learned/*.png) ──
//  networks: 광고사별 { spots:[{x,y,ok,fails}], delays:[초] }  templates: [{file,network,ok,fails}]
const LEARN_PATH = path.join(ROOT, 'logs', 'learned.json');
// 사건 기록(멈춤·오탭·시간초과 등) → logs/incidents.jsonl + 스크린샷
async function incident(drv, kind, detail = {}) {
  try {
    const t = new Date(); const shot = path.join(ROOT, 'logs', 'shots', `${t.toISOString().replace(/[:.]/g, '-')}_incident_${kind}.png`);
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    if (drv) await drv.saveScreenshot(shot).catch(() => {});
    fs.appendFileSync(path.join(ROOT, 'logs', 'incidents.jsonl'), JSON.stringify({ at: t.toISOString(), kind, ...detail, shot: path.basename(shot) }) + '\n');
    runState.incidents = (runState.incidents ?? 0) + 1;
  } catch {}
}
const LEARN_DIR = path.join(ROOT, 'logs', 'learned');
function loadLearn() {
  let j = {}; try { j = JSON.parse(fs.readFileSync(LEARN_PATH, 'utf8')); } catch {}
  if (j.version !== 2) {   // 예전 형식 {광고사: [{x,y}]} → v2
    const nets = {}; for (const [k, v] of Object.entries(j)) if (Array.isArray(v)) nets[k] = { spots: v.map(p => ({ x: p.x, y: p.y, ok: 1, fails: p.fails ?? 0 })), delays: [] };
    j = { version: 2, networks: nets, templates: [] };
  }
  j.noop ??= {};   // '광고사|x,y' → 눌러도 아무 일 없던 횟수
  return j;
}
const saveLearn = (j) => fs.writeFileSync(LEARN_PATH, JSON.stringify(j, null, 2));
const py = async (args) => (await import('node:child_process')).execFileSync('python3', [path.join(ROOT, 'puzzles', 'match.py'), ...args], { timeout: 20000 }).toString();

async function adSkip(drv, o) {
  const until = [].concat(o.until ?? []);
  const appId = o.app;
  const timeout = (o.timeout ?? 120) * 1000;
  const start = Date.now(); const tapped = new Map(), tappedAt = new Map();
  let lastProgress = Date.now(), segStart = Date.now();   // segStart: 지금 광고(연속 광고면 각 광고)의 시작
  let nextAI = Date.now() + (o.aiAfter ?? 8) * 1000, aiGap = 15000, lastMatch = 0, notAdCount = 0;
  const L = loadLearn(); fs.mkdirSync(LEARN_DIR, { recursive: true });
  let pending = null;   // { kind: 'spot'|'tpl'|'claude', network, pt, t, counter, tpl, shot }
  const spotTries = new Map(), tplTries = new Map();
  const { width: W } = await drv.getWindowSize();
  const attr = (a, k) => (a.match(new RegExp(` ${k}="([^"]*)"`)) || [])[1];
  const net = (n) => (L.networks[n] ??= { spots: [], delays: [] });

  const confirm = async (why) => {
    const p = pending; pending = null; if (!p) return;
    const key = p.network ?? '(이름없음)'; const N = net(key);
    const delay = Math.round((p.t - segStart) / 1000);
    N.delays = [...(N.delays ?? []), delay].slice(-5);
    if (p.kind === 'claude') {
      N.spots = [{ x: p.pt.x, y: p.pt.y, ok: 1, fails: 0 }, ...N.spots.filter(s => Math.hypot(s.x - p.pt.x, s.y - p.pt.y) > 15)].slice(0, 4);
      if (p.shot) try {
        const file = path.join(LEARN_DIR, `${Date.now()}.png`);
        await py(['crop', p.shot, String(p.pt.x), String(p.pt.y), String(p.scale), file]);
        L.templates.push({ file: path.basename(file), network: key, ok: 1, fails: 0 });
      } catch {}
      log(`    🧠 ${key} 버튼 위치·모양 기억 (${why}, ${delay}초 뒤 등장)`);
    } else if (p.kind === 'spot') {
      const sp = N.spots.find(s => s.x === p.pt.x && s.y === p.pt.y); if (sp) { sp.ok++; sp.fails = 0; }
      log(`    🧠 기억한 위치 효과 확인 (${why})`);
    } else if (p.kind === 'tpl') {
      const t = L.templates.find(t => t.file === p.tpl); if (t) { t.ok++; t.fails = 0; }
      log(`    🧠 기억한 모양 효과 확인 (${why})`);
    }
    saveLearn(L); segStart = Date.now();
  };
  const reject = () => {
    const p = pending; pending = null; if (!p) return;
    if (p.kind === 'spot') { const N = net(p.network ?? '(이름없음)'); const sp = N.spots.find(s => s.x === p.pt.x && s.y === p.pt.y);
      if (sp && ++sp.fails >= 3 && sp.fails > sp.ok) { N.spots = N.spots.filter(s => s !== sp); log('    🧠 효과 없는 위치 지움'); } }
    if (p.kind === 'tpl') { const t = L.templates.find(t => t.file === p.tpl);
      if (t && ++t.fails >= 3 && t.fails > t.ok) { L.templates = L.templates.filter(x => x !== t); try { fs.rmSync(path.join(LEARN_DIR, t.file)); } catch {} log('    🧠 효과 없는 모양 지움'); } }
    saveLearn(L);
  };
  // 일부 웹뷰 광고(AdMob 'Story' 형식 '리워드 지급됨 ✕')는 mobile: tap 을 무시함 → 같은 자리 2번 실패 후엔 W3C 포인터(누름 120ms→뗌)로 누름
  const pointerTap = async (pt) => { await drv.performActions([{ type: 'pointer', id: 'f1', parameters: { pointerType: 'touch' }, actions: [{ type: 'pointerMove', duration: 0, x: Math.round(pt.x), y: Math.round(pt.y) }, { type: 'pointerDown', button: 0 }, { type: 'pause', duration: 120 }, { type: 'pointerUp', button: 0 }] }]); await drv.releaseActions().catch(() => {}); };
  const tapAt = async (pt, alt = false) => { if (alt) await pointerTap(pt); else await drv.execute('mobile: tap', pt); lastProgress = lastActionAt = Date.now(); await sleep(1500); };
  const claudeTaps = new Map();   // Claude 가 고른 자리별 횟수 (같은 자리 반복이면 포인터 탭)
  const netOf = (x) => { const r2 = /<XCUIElementTypeOther([^>]*?)\/?>/g; let n; while ((n = r2.exec(x))) { const a = n[1]; const nm = attr(a, 'name'); if (nm && +attr(a, 'width') >= 300 && +attr(a, 'height') >= 500 && /^[A-Za-z][\w ]{2,30}$/.test(nm)) return nm; } return null; };
  const ctrOf = (x) => (x.match(/\d+\s*의\s*광고\s*\d+|광고\s*\d+\s*\/\s*\d+/) || [])[0] ?? null;
  // 학습용 탭: 누른 직후 최대 4초 동안 효과(다음 광고·광고 끝·광고사 바뀜) 확인 → 그 자리에서 성공/실패 판정
  const tapAndVerify = async (pt, prev, alt = false) => {
    if (alt) await pointerTap(pt); else await drv.execute('mobile: tap', pt); lastProgress = lastActionAt = Date.now();
    for (let k = 0; k < 5; k++) {
      await sleep(k === 0 ? 1200 : 700);
      const info = await drv.execute('mobile: activeAppInfo').catch(() => null);
      if (info?.bundleId && info.bundleId !== appId) return false;   // 광고 페이지·다른 앱이 열림 = 잘못 누름
      if (until.length && await textVisible(drv, until)) return 'end';
      const x = await drv.getPageSource().catch(() => '');
      const c2 = ctrOf(x), n2 = netOf(x);
      if ((prev.counter !== null && c2 !== prev.counter) || (prev.network && n2 && n2 !== prev.network)) return true;
    }
    return null;   // 모름 (아직 판단 불가)
  };

  while (Date.now() - start < timeout) {
    if (stopRequested) throw new Error('중지됨');
    if (appId) {
      const info = await drv.execute('mobile: activeAppInfo').catch(() => null);
      if (info && info.bundleId && info.bundleId !== appId) { if (pending && pending.kind !== 'claude') reject(); else pending = null; await handleForeignApp(drv, info.bundleId, { inAd: true }); lastProgress = Date.now(); continue; }
    }
    const hit = until.length ? await textVisible(drv, until) : null;
    if (hit) { if (pending && Date.now() - pending.t < 12000) await confirm('광고 끝'); else pending = null; saveLearn(L); log(`    → '${hit}' 보임, 광고 끝`); return; }
    const xml = await drv.getPageSource();
    const counter = (xml.match(/\d+\s*의\s*광고\s*\d+|광고\s*\d+\s*\/\s*\d+/) || [])[0] ?? null;
    let network = null;
    { const r2 = /<XCUIElementTypeOther([^>]*?)\/?>/g; let n;
      while ((n = r2.exec(xml))) { const a = n[1]; const nm = attr(a, 'name'); if (nm && +attr(a, 'width') >= 300 && +attr(a, 'height') >= 500 && /^[A-Za-z][\w ]{2,30}$/.test(nm)) { network = nm; break; } } }
    if (pending) {
      const age = Date.now() - pending.t;
      if (pending.counter !== null && counter !== pending.counter && age < 12000) await confirm('다음 광고로 넘어감');
      else if (age >= 12000) reject();
    }

    // 0) 광고가 끝나 앱 화면으로 돌아왔는데 아직 until 글자가 안 잡힌 순간: 뒤로가기를 눌러 '게임에서 나가시겠어요?' 가 뜨면 '계속 풀기'
    if (/<XCUIElementType\w+[^>]*(?:label|name)="게임에서 나가시겠어요[^"]*"[^>]*visible="true"/.test(xml)) {
      const keep = await drv.$$(`-ios predicate string:label == '계속 풀기' OR name == '계속 풀기'`).catch(() => []);
      if (keep[0]) { log("    → '게임에서 나가시겠어요?' 확인창 → '계속 풀기'"); await keep[0].click().catch(() => {}); lastProgress = Date.now(); await sleep(1500); continue; }
    }
    const appScreen = [...xml.matchAll(/<XCUIElementType\w+([^>]*?)\/?>/g)].some(([, a]) => attr(a, 'visible') === 'true' && APP_UI_RE.test(attr(a, 'label') || attr(a, 'name') || ''));   // 럭키즈 자체 화면이면 이름 없는 버튼(뒤로가기 등)은 광고 닫기가 아님

    // 1) 글자로 잡히는 닫기·건너뛰기·다음 보기
    const cands = [];
    // 같은 버튼 재탭 허용: 한도에 걸려도 8초 지나면 다시 (광고 끝나기 전에 미리 눌러 한도를 다 써버리는 경우 대비), 총 12번까지
    //  '리워드 지급됨' 처럼 보상이 끝났다는 표시가 보이면 닫기 버튼을 3초 간격으로 우선 누름
    const rewardDone = REWARD_DONE_RE.test(xml);
    const canTap = (key, limit) => { const n = tapped.get(key) ?? 0, t = tappedAt.get(key) ?? 0;
      return n < limit || (n < (rewardDone ? 40 : 12) && Date.now() - t > (rewardDone ? 3000 : 8000)); };
    const re = /<XCUIElementType(\w+)([^>]*?)\/?>/g; let m;
    while ((m = re.exec(xml))) {
      const a = m[2];
      if (attr(a, 'visible') !== 'true' || attr(a, 'enabled') !== 'true') continue;
      const x = +attr(a, 'x'), y = +attr(a, 'y'), w = +attr(a, 'width'), h = +attr(a, 'height');
      const txt = `${attr(a, 'name') || ''} ${attr(a, 'label') || ''} ${attr(a, 'value') || ''}`.trim();
      const t1 = (attr(a, 'label') || attr(a, 'name') || '').trim();
      if (t1 && t1.length <= 12 && !BLOCK_RE.test(t1) && PROGRESS_RE.test(t1)) {
        const key = `${Math.round(x)},${Math.round(y)}`; if (canTap(key, 3)) cands.push({ x: x + w / 2, y: y + h / 2, txt: t1, key, score: 3 });
        continue;
      }
      if (!(w > 0 && h > 0 && w <= 120 && h <= 80 && y < 170)) continue;
      if (!(x < 100 || x + w > W - 100)) continue;
      const named = CLOSE_RE.test(txt) || txt.split(/\s+/).some(t => CLOSE_RE.test(t));
      if (!named && (m[1] !== 'Button' || txt || appScreen)) continue;
      if (!named && !(w <= 50 && (x < 45 || x + w > W - 45))) continue;
      if (!named) { const sx = Math.round((x + w / 2) / 10) * 10, sy = Math.round((y + h / 2) / 10) * 10;
        if ((L.noop[`${network ?? '*'}|${sx},${sy}`] ?? 0) >= 2 || (L.noop[`*|${sx},${sy}`] ?? 0) >= 2) continue; }
      const key = `${Math.round(x / 20)},${Math.round(y / 20)}`;
      if (!canTap(key, named ? 4 : 2)) continue;
      cands.push({ x: x + w / 2, y: y + h / 2, txt, key, score: named ? (rewardDone ? 4 : 2) : 1 });
    }
    cands.sort((a, b) => b.score - a.score);
    if (cands.length) {
      const c = cands[0]; tapped.set(c.key, (tapped.get(c.key) ?? 0) + 1); tappedAt.set(c.key, Date.now());
      pending = null;   // 규칙이 누른 버튼의 공은 규칙에 (Claude 기억에 잘못 붙지 않게)
      // '리워드 지급됨' 광고(AdMob Story 형식)의 ✕는 일반 탭·포인터 탭 모두 무시함
      //  10-22 실측: 화면 캡처(screenshot)를 한 직후의 포인터 탭만 먹힘 (캡처 없이 누르면 5분 내내 그대로, 기다려도 소용없음)
      if (rewardDone && CLOSE_RE.test(c.txt) && tapped.get(c.key) >= 2) {
        log(`    → '리워드 지급됨' ✕ → 화면 캡처 후 포인터 탭`);
        await drv.takeScreenshot().catch(() => {}); await tapAt({ x: c.x, y: c.y }, true); await sleep(1000); continue;
      }
      const alt = (tapped.get(c.key) ?? 0) % 2 === 1 && tapped.get(c.key) >= 3;   // 3·5·7…번째는 포인터 탭
      log(`    → 닫기/넘기기 버튼 탭${alt ? '(포인터)' : ''}: '${c.txt || '(이름없음)'}' @${Math.round(c.x)},${Math.round(c.y)}`);
      const before = { counter, xmlLen: xml.length };
      await tapAt({ x: c.x, y: c.y }, alt);
      if (!c.txt) {   // 이름 없는 버튼: 눌렀는데 화면이 그대로면 '효과 없음' 기록 (2번이면 다음부터 안 누름)
        const after = await drv.getPageSource().catch(() => '');
        const stillAd = !(until.length && await textVisible(drv, until));
        const afterCounter = (after.match(/\d+\s*의\s*광고\s*\d+|광고\s*\d+\s*\/\s*\d+/) || [])[0] ?? null;
        if (stillAd && afterCounter === before.counter && Math.abs(after.length - before.xmlLen) < 400) {
          const k = `${network ?? '*'}|${Math.round(c.x / 10) * 10},${Math.round(c.y / 10) * 10}`;
          L.noop[k] = (L.noop[k] ?? 0) + 1; saveLearn(L);
          if (L.noop[k] === 2) log(`    🧠 (${Math.round(c.x)},${Math.round(c.y)}) 는 눌러도 효과 없는 버튼(소리 등) — 다음부터 안 누름`);
        }
      }
      continue;
    }

    // 2) 기억한 버튼 모양을 화면에서 찾기 (2초마다)
    if (!pending && L.templates.length && Date.now() - lastMatch > 1000) {
      lastMatch = Date.now();
      const shot = path.join(ROOT, 'logs', 'adshot.png'); await drv.saveScreenshot(shot);
      const scale = fs.readFileSync(shot).readUInt32BE(16) / W;
      const files = L.templates.filter(t => (tplTries.get(t.file) ?? 0) < 3).map(t => path.join(LEARN_DIR, t.file)).filter(f => fs.existsSync(f));
      if (files.length) try {
        const r = JSON.parse(await py(['match', shot, String(scale), ...files]));
        if (r.score >= 0.86) {
          const file = path.basename(r.tpl); tplTries.set(file, (tplTries.get(file) ?? 0) + 1);
          pending = { kind: 'tpl', network, pt: { x: r.x, y: r.y }, t: Date.now(), counter, tpl: file };
          log(`    → 기억한 버튼 모양 발견 (일치 ${(r.score * 100).toFixed(0)}%) 탭 @${r.x},${r.y}`);
          const v = await tapAndVerify({ x: r.x, y: r.y }, { counter, network });
          if (v === true || v === 'end') await confirm(v === 'end' ? '광고 끝' : '다음 광고로 넘어감'); else if (v === false) reject();
          if (v === 'end') { log('    → 광고 끝'); return; }
          continue;
        }
      } catch {}
    }

    // 3) 광고사별 기억한 위치 (보통 등장하는 시각이 지난 뒤, 위치당 최대 3번 · 5초 간격)
    // 모양을 기억한 광고사는 모양이 보일 때만 누름(위 2단계). 위치만 아는 광고사는 등장 시각을 학습한 뒤에만, 그 시각 이후에 누름
    const hasTpl = network && L.templates.some(t => t.network === network);
    if (!pending && network && !hasTpl && L.networks[network]?.spots?.length && L.networks[network].delays?.length) {
      const N = L.networks[network]; const minDelay = Math.max(0, Math.min(...N.delays) - 1);
      if (Date.now() - segStart >= minDelay * 1000 && Date.now() - lastProgress > 5000) {
        const sp = N.spots.find(s => (spotTries.get(`${s.x},${s.y}`) ?? 0) < 3);
        if (sp) {
          spotTries.set(`${sp.x},${sp.y}`, (spotTries.get(`${sp.x},${sp.y}`) ?? 0) + 1);
          pending = { kind: 'spot', network, pt: { x: sp.x, y: sp.y }, t: Date.now(), counter };
          log(`    → ${network} 광고, 기억한 위치 탭 @${sp.x},${sp.y}`);
          const v = await tapAndVerify({ x: sp.x, y: sp.y }, { counter, network });
          if (v === true || v === 'end') await confirm(v === 'end' ? '광고 끝' : '다음 광고로 넘어감'); else reject();
          if (v === 'end') { log('    → 광고 끝'); return; }
          continue;
        }
      }
    }

    // 4) Claude 화면 판단 (간격 조절: 카운트다운이면 남은 시간만큼, 아니면 점점 늘림)
    if (o.ai !== false && !runState.aiDisabled && !pending && Date.now() >= nextAI && Date.now() - lastProgress > 4000) {
      const urgent = Date.now() - start > 180000;
      log(`    → 누를 버튼을 못 찾음, Claude 에게 화면 판단 요청${urgent ? ' (3분 초과)' : ''}`);
      const res = await askClaude(drv, xml, until, urgent, Object.entries(L.noop).filter(([k, v]) => v >= 2 && (k.startsWith('*|') || k.startsWith(`${network}|`))).map(([k]) => k.split('|')[1])).catch(e => (log('    → 판단 실패: ' + e.message), null));
      const d = res?.d;
      if (d?.action === 'tap' && SENSITIVE_RE.test(xml)) { log('    → 민감한 화면(결제·인증 등) 감지, 누르지 않음'); throw new Error('민감한 화면 감지로 중단'); }
      if (d?.action === 'tap' && Number.isFinite(d.x) && Number.isFinite(d.y)) {
        let blocked = false; const r3 = /<XCUIElementType\w+([^>]*?)\/?>/g; let q;
        while ((q = r3.exec(xml))) { const a = q[1]; const t = attr(a, 'label') || attr(a, 'name') || ''; const x = +attr(a, 'x'), y = +attr(a, 'y'), w = +attr(a, 'width'), h = +attr(a, 'height');
          if (t && w < 300 && d.x >= x && d.x <= x + w && d.y >= y && d.y <= y + h && BLOCK_RE.test(t)) { blocked = true; break; } }
        if (blocked) { log('    → Claude 가 고른 곳이 광고 클릭 버튼이라 무시'); nextAI = Date.now() + aiGap; continue; }
        const pt = { x: Math.round(d.x), y: Math.round(d.y) };
        { const sx = Math.round(pt.x / 10) * 10, sy = Math.round(pt.y / 10) * 10;
          if ((L.noop[`${network ?? '*'}|${sx},${sy}`] ?? 0) >= 2 || (L.noop[`*|${sx},${sy}`] ?? 0) >= 2) { log(`    → Claude 가 고른 (${pt.x},${pt.y}) 는 효과 없던 자리라 무시`); nextAI = Date.now() + aiGap; continue; } }
        log(`    → Claude 판단: 탭 @${pt.x},${pt.y} (${d.reason ?? ''})`);
        const learnable = pt.y < 260 || pt.y > 740;   // 위·아래 띠의 버튼만 기억
        pending = learnable ? { kind: 'claude', network, pt, t: Date.now(), counter, shot: res.img, scale: res.scale } : null;
        aiGap = 15000; nextAI = Date.now() + 10000;
        const ck = `${Math.round(pt.x / 10)},${Math.round(pt.y / 10)}`; claudeTaps.set(ck, (claudeTaps.get(ck) ?? 0) + 1);
        const v = await tapAndVerify(pt, { counter, network }, claudeTaps.get(ck) >= 2);
        if (pending) { if (v === true || v === 'end') await confirm(v === 'end' ? '광고 끝' : '다음 광고로 넘어감'); else if (v === false) pending = null; }
        if (v === 'end') { log('    → 광고 끝'); return; }
        continue;
      }
      if (d?.action === 'notad') { notAdCount++; log(`    → Claude 판단: 광고 아님 (${d.reason ?? ''})`); if (notAdCount >= 2) throw new Error('광고가 아닌 앱 화면에서 멈춤: ' + (d.reason ?? '')); nextAI = Date.now() + 5000; continue; }
      const ws = Number(d?.waitSec);
      if (Number.isFinite(ws) && ws > 0) nextAI = Date.now() + Math.min(60, Math.max(5, ws + 2)) * 1000;
      else { nextAI = Date.now() + aiGap; aiGap = Math.min(60000, aiGap * 1.6); }
      log(`    → Claude 판단: 기다림 (${d?.reason ?? '응답 없음'})${Number.isFinite(ws) && ws > 0 ? ` · ${ws}초 뒤 다시` : ''}`);
      continue;
    }
    await sleep(800);
  }
  saveLearn(L);
  await incident(drv, 'ad_timeout', {});
  throw new Error(`광고 넘기기 시간 초과 (${o.timeout ?? 120}초)`);
}


// ── 그날 실행 기록 (logs/reports/YYYY-MM-DD.json) — 중간에 멈춰도 남도록 시작 때 바로 쓰고 끝날 때 갱신 ──
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayFile = (k = dayKey()) => path.join(ROOT, 'logs', 'reports', `${k}.json`);
const readDay = (k) => { try { return JSON.parse(fs.readFileSync(dayFile(k), 'utf8')); } catch { return { date: k, runs: [] }; } };
const writeDay = (j) => { fs.mkdirSync(path.dirname(dayFile(j.date)), { recursive: true }); fs.writeFileSync(dayFile(j.date), JSON.stringify(j, null, 2)); };
function openRunEntry(start) {
  const k = dayKey(); const j = readDay(k);
  // 끝 값 없이 멈춘 이전 실행(강제 종료·케이블 분리 등)은 이번 시작 보유량을 끝 값으로 채움
  for (const r of j.runs) if (!r.balanceEnd && r.balanceStart) {
    r.balanceEnd = { ...start }; r.coinDelta = start.coin - r.balanceStart.coin; r.moneyDelta = start.money - r.balanceStart.money;
    r.status = r.status === 'running' ? 'interrupted' : r.status; r.note = (r.note ? r.note + ' · ' : '') + '끝 값은 다음 실행 시작 보유량으로 채움';
  }
  j.runs.push({ at: new Date(runState.startedAt).toISOString(), startedAt: new Date(runState.startedAt).toISOString(), balanceStart: start, status: 'running' });
  runState.dayKey = k; runState.runIndex = j.runs.length - 1; writeDay(j);
}
function updateRunEntry(patch) {
  if (runState.runIndex == null) return;
  const j = readDay(runState.dayKey); const r = j.runs[runState.runIndex]; if (!r) return;
  Object.assign(r, patch);
  if (r.balanceStart && r.balanceEnd) { r.coinDelta = r.balanceEnd.coin - r.balanceStart.coin; r.moneyDelta = r.balanceEnd.money - r.balanceStart.money; }
  writeDay(j);
}

const TARGET_APP = sc.app ?? 'co.luckies.app';
const fmtDur = (sec) => { const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), x = sec % 60; return h ? `${h}시간 ${m}분` : m ? `${m}분 ${x}초` : `${x}초`; };
const runState = { balance: {}, startedAt: Date.now(), reportFile: null, aiCalls: 0 };
const SENSITIVE_RE = /인증번호|계좌|이체|결제하기|비밀번호|카드번호|송금|간편결제|PIN/;
let lastActionAt = Date.now();   // 자동화가 마지막으로 화면을 건드린 시각
const AD_APPS = ['com.apple.AppStore', 'com.apple.mobilesafari', 'com.apple.springboard'];
const idleMin = (sc.resumeAfterIdleMin ?? 3);

// 사용자가 폰을 쓰는 중이면 멈췄다가, 화면이 idleMin 분 동안 그대로면 재개
async function waitForUserIdle(drv, why) {
  log(`    ⏸ 사용자 사용 감지(${why}) → 멈춤. 화면이 ${idleMin}분간 그대로면 재개`);
  const crypto = await import('node:crypto');
  let lastHash = null, stillSince = Date.now();
  const pauseStart = Date.now(), maxPause = (sc.maxPauseMin ?? 60) * 60000;
  for (;;) {
    if (stopRequested) throw new Error('중지됨');
    if (Date.now() - pauseStart > maxPause) throw new Error(`${sc.maxPauseMin ?? 60}분 넘게 재개 조건이 안 돼 중단 (폰 잠김/사용 중)`);
    await sleep(20000);
    if (await drv.execute('mobile: isLocked').catch(() => false)) { lastHash = null; stillSince = Date.now(); continue; }
    const b64 = await drv.takeScreenshot().catch(() => null); if (!b64) continue;
    const h = crypto.createHash('md5').update(b64).digest('hex');
    if (h !== lastHash) { lastHash = h; stillSince = Date.now(); continue; }
    if (Date.now() - stillSince >= idleMin * 60000) break;
  }
  log(`    ▶ ${idleMin}분간 움직임 없음 → ${TARGET_APP} 로 돌아가 재개`);
  await drv.execute('mobile: activateApp', { bundleId: TARGET_APP }); await sleep(2500);
  lastActionAt = Date.now();
}

// 다른 앱이 앞에 있을 때: 자동화가 방금 누른 결과(광고)면 바로 복귀, 아니면 사용자 사용으로 보고 대기
const foreignSeen = [];   // 최근 다른 앱 등장 기록 {id, t}
async function handleForeignApp(drv, bundleId, { inAd = false } = {}) {
  // 홈 화면(springboard)은 사용 중으로 보지 않고 바로 복귀 (실행 시작 때 홈 화면인 경우가 많음)
  if (bundleId === 'com.apple.springboard') {
    await drv.execute('mobile: activateApp', { bundleId: TARGET_APP }); await sleep(1500); lastActionAt = Date.now(); return;
  }
  const now = Date.now(); foreignSeen.push({ id: bundleId, t: now });
  while (foreignSeen.length && now - foreignSeen[0].t > 120000) foreignSeen.shift();
  const repeats = foreignSeen.filter(f => f.id === bundleId).length;
  const ours = now - lastActionAt < 30000 || AD_APPS.includes(bundleId);
  // 사용자가 정말 쓰는 중이면 되돌려도 다시 그 앱으로 감 → 2분 안에 3번째 + 최근 30초 우리 조작 없음일 때만 멈춤
  if (repeats >= 3 && !ours) {
    await incident(drv, 'user_pause', { app: bundleId, inAd });
    return waitForUserIdle(drv, `다른 앱 ${bundleId}`);
  }
  const banner = !AD_APPS.includes(bundleId);
  log(`    ⚠ 다른 앱(${bundleId}) 화면 → ${TARGET_APP} 로 복귀${banner && inAd ? ' (알림 배너를 눌렀을 가능성)' : ''}`);
  if (banner) await incident(drv, 'foreign_app', { app: bundleId, inAd, sinceOurTapMs: now - lastActionAt });
  await drv.execute('mobile: activateApp', { bundleId: TARGET_APP }); await sleep(2000); lastActionAt = Date.now();
}

async function guard(drv, type) {
  if (['wait', 'screenshot', 'repeat', 'if'].includes(type)) return;
  if (Date.now() - (runState.lockCheckedAt ?? 0) > 20000) {   // 잠금 확인은 20초에 한 번
    runState.lockCheckedAt = Date.now();
    if (await drv.execute('mobile: isLocked').catch(() => false)) await waitForUserIdle(drv, '폰 잠김');
  }
  if (['launch', 'activate', 'close'].includes(type)) { lastActionAt = Date.now(); return; }
  const info = await drv.execute('mobile: activeAppInfo').catch(() => null);
  if (info?.bundleId && info.bundleId !== TARGET_APP) await handleForeignApp(drv, info.bundleId);
}

// 코인을 쓰는 화면에서는 아무것도 누르지 않음 (사용자 지시: 코인 사용 단계는 하지 않음)
const COIN_SPEND_RE = /코인\s*\d+\s*개를\s*사용|코인을\s*사용/;
async function refuseCoinSpend(drv, type) {
  if (sc.allowCoinSpend) return;
  if (!['tap', 'ifExists', 'longPress', 'type', 'drag'].includes(type)) return;
  const xml = await drv.getPageSource().catch(() => '');
  if (COIN_SPEND_RE.test(xml)) { log('    ⛔ 코인을 쓰는 화면이라 누르지 않음'); throw new Error('코인 사용 화면 — 건너뜀'); }
}

async function runStep(drv, step, i) {
  const [type, val] = Object.entries(step)[0];
  if (stopRequested && !runState.finalizing) throw new Error('중지됨');
  if (!(val && typeof val === 'object' && val.allowForeign)) await guard(drv, type);
  await refuseCoinSpend(drv, type);
  if (!['wait', 'screenshot', 'repeat', 'if', 'waitFor', 'assert', 'waitGone'].includes(type)) lastActionAt = Date.now();
  const o = typeof val === 'object' && val !== null ? val : {};
  log(`  ${i + 1}. ${type}`, typeof val === 'object' ? JSON.stringify(val) : String(val ?? ''));
  switch (type) {
    case 'launch': await drv.execute('mobile: launchApp', { bundleId: typeof val === 'string' ? val : o.bundleId }); await sleep(1500); break;
    case 'activate': await drv.execute('mobile: activateApp', { bundleId: typeof val === 'string' ? val : o.bundleId }); break;
    case 'close': await drv.execute('mobile: terminateApp', { bundleId: typeof val === 'string' ? val : o.bundleId }); break;
    case 'openUrl': await drv.url(typeof val === 'string' ? val : o.url); await sleep(1500); break;
    case 'tap':
      if (o.x !== undefined) await drv.execute('mobile: tap', { x: o.x, y: o.y });
      else if (o.xFrac !== undefined) {   // 요소 안 특정 가로 위치 탭 (예: 줄 오른쪽 버튼)
        const el = await find(drv, o, o.timeout); const r = await drv.getElementRect(el.elementId);
        await drv.execute('mobile: tap', { x: r.x + r.width * o.xFrac, y: r.y + r.height / 2 });
      }
      else await (await find(drv, typeof val === 'string' ? { text: val } : o, o.timeout)).click();
      break;
    case 'longPress': {
      const el = await find(drv, typeof val === 'string' ? { text: val } : o, o.timeout);
      await drv.execute('mobile: touchAndHold', { elementId: el.elementId, duration: o.seconds ?? 1 }); break;
    }
    case 'type': {
      if (o.into) { const el = await find(drv, typeof o.into === 'string' ? { text: o.into } : o.into); await el.click(); await el.setValue(o.text); }
      else await drv.keys(String(typeof val === 'string' ? val : o.text).split(''));
      break;
    }
    case 'waitFor': await find(drv, typeof val === 'string' ? { text: val } : o, (o.timeout ?? 20) * 1000); break;
    case 'ifExists': {
      // 있으면 tap (팝업 닫기 등). 없으면 넘어감
      try { const el = await find(drv, typeof val === 'string' ? { text: val } : o, (o.timeout ?? 3) * 1000); await el.click(); log('    → 있어서 눌렀음'); }
      catch { log('    → 없어서 건너뜀'); }
      break;
    }
    case 'waitGone': {
      const sel = selectorOf(typeof val === 'string' ? { text: val } : o);
      const end = Date.now() + (o.timeout ?? 15) * 1000; let gone = false;
      while (Date.now() < end) {
        let vis = false;
        for (const el of await drv.$$(sel)) if (await el.isDisplayed().catch(() => false)) { vis = true; break; }
        if (!vis) { gone = true; break; }
        await sleep(700);
      }
      log(gone ? '    → 사라짐' : '    → 시간 안에 안 사라짐, 계속 진행');
      break;
    }
    case 'repeat': {
      // repeat: { while: {contains: X}, max: 5, steps: [...] }  — while 요소가 보이는 동안 steps 반복
      let retries = 0;
      for (let k = 1; k <= (o.max ?? 5); k++) {
        let present = false;
        if (!o.while) present = true; else try { await find(drv, o.while, (o.checkTimeout ?? 4) * 1000); present = true; } catch {}
        if (!present) { log(`    → 반복 종료 (${k - 1}회 수행)`); break; }
        log(`    ↻ ${k}회차`);
        try { for (const [j, sub] of o.steps.entries()) await runStep(drv, sub, j); }
        catch (e) {
          if (!o.stopOnError) throw e;
          // retryOnError: N — 막히면 recover 단계(앱 재실행 등)로 되돌린 뒤 같은 회차를 다시 시도 (최대 N번)
          if (/중지됨/.test(e.message) || !o.recover || (retries = (retries ?? 0) + 1) > (o.retryOnError ?? 0)) {
            log(`    → 반복 중 진행 불가(${e.message}), 반복 종료`); await shot(drv, 'repeat_stop').catch(() => {}); break;
          }
          log(`    → 반복 중 막힘(${e.message}) → 처음 화면으로 되돌려 다시 시도 (${retries}/${o.retryOnError})`); await shot(drv, 'repeat_retry').catch(() => {});
          try { for (const [j, sub] of o.recover.entries()) await runStep(drv, sub, j); } catch (e2) { log(`    → 되돌리기 실패(${e2.message}), 반복 종료`); break; }
          k--; continue;
        }
        if (k === (o.max ?? 5)) log('    → 최대 반복 횟수 도달');
      }
      break;
    }
    case 'sudoku': {
      const { readBoard, solve } = await import('./puzzles/sudoku.mjs');
      const { width: W } = await drv.getWindowSize();
      const b = readBoard(await drv.getPageSource(), W);
      const sol = solve(b);
      log(`    → ${b.N}x${b.N} 판 읽음, 빈칸 ${b.g.flat().filter(v => !v).length}개 풀이 완료`);
      for (let r = 0; r < b.N; r++) for (let c = 0; c < b.N; c++) if (!b.g[r][c]) {
        await drv.execute('mobile: tap', { x: b.x0 + c * b.size + b.size / 2, y: b.y0 + r * b.size + b.size / 2 });
        const p = b.pad[sol[r][c] - 1]; await drv.execute('mobile: tap', { x: p.x + p.w / 2, y: p.y + p.h / 2 });
      }
      await sleep(2000); break;
    }
    case 'queens': {
      const { execFileSync } = await import('node:child_process');
      const xml = await drv.getPageSource();
      const tool = (xml.match(/name="(?:되돌리기|초기화)"[^>]*y="(\d+)"/) || [])[1];
      if (!tool) throw new Error('퀸즈 화면이 아님');
      const f = path.join(ROOT, 'logs', 'queens.png'); await drv.saveScreenshot(f);
      const { width: W } = await drv.getWindowSize();
      const scale = (await import('node:fs')).readFileSync(f).readUInt32BE(16) / W;   // PNG 가로 픽셀 / pt
      let out; try { out = execFileSync('python3', [path.join(ROOT, 'puzzles', 'queens.py'), f, tool, String(scale)]).toString(); }
      catch (e) { throw new Error('퀸즈 판 읽기 실패: ' + (e.stdout?.toString() || e.message)); }
      const r = JSON.parse(out);
      log(`    → ${r.N}x${r.N} 판, 색 영역 ${r.N}개 읽음, 풀이 완료`);
      for (const t of r.taps) { await drv.execute('mobile: tap', t); await sleep(150); await drv.execute('mobile: tap', t); await sleep(150); }
      await sleep(2000); break;
    }
    case 'shikaku': {
      const { read, solve } = await import('./puzzles/shikaku.mjs');
      const { width: W } = await drv.getWindowSize();
      const b = read(await drv.getPageSource(), W); const rects = solve(b);
      log(`    → ${b.C}x${b.R} 판, 숫자 ${b.clues.length}개 읽음, 풀이 완료`);
      const cx = c => b.x0 + c * b.cell + b.cell / 2, cy = r => b.y0 + r * b.cell + b.cell / 2;
      for (const q of rects) {
        if (q.h === 1 && q.w === 1) { await drv.execute('mobile: tap', { x: cx(q.c), y: cy(q.r) }); }
        else await drv.execute('mobile: dragFromToForDuration', { fromX: cx(q.c), fromY: cy(q.r), toX: cx(q.c + q.w - 1), toY: cy(q.r + q.h - 1), duration: 0.3 });
        await sleep(250);
      }
      await sleep(2000); break;
    }
    case 'drag': await drv.execute('mobile: dragFromToForDuration', { ...o, duration: o.duration ?? 0.3 }); await sleep(500); break;
    case 'if': {
      // if: { exists: {contains: X}, timeout: 3, then: [...], else: [...] }
      let ok = false; try { await find(drv, o.exists, (o.timeout ?? 3) * 1000); ok = true; } catch {}
      log(`    → 조건 ${ok ? '참' : '거짓'}`);
      for (const [j, sub] of ((ok ? o.then : o.else) ?? []).entries()) await runStep(drv, sub, j);
      break;
    }
    case 'spin': {
      // 룰렛: 금액 글자('N원')들의 평균 위치를 바퀴 중심으로 보고 빠르게 쓸어 돌리기
      const xml = await drv.getPageSource(); const pts = [];
      const re2 = /<XCUIElementTypeStaticText[^>]*name="\d+원"[^>]*x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g; let q;
      while ((q = re2.exec(xml))) pts.push([+q[1] + +q[3] / 2, +q[2] + +q[4] / 2]);
      if (pts.length < 3) throw new Error('룰렛을 못 찾음');
      const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      await drv.execute('mobile: dragFromToForDuration', { fromX: cx - 70, fromY: cy - 55, toX: cx + 90, toY: cy + 55, duration: 0.15 });
      await sleep(1500); break;
    }
    case 'game': {
      // game: { name: 미니 스도쿠, solver: sudoku|queens|shikaku, hardMax: 3 }
      const app = TARGET_APP, solver = { [o.solver]: true };
      const run = async (list) => { for (const [j, sub] of list.entries()) await runStep(drv, sub, j); };
      const toMain = [{ close: app }, { launch: app }, { waitFor: { contains: '오늘 걸음 수', timeout: 20 } }];
      // 받을 판 버튼: 보통 '+1' 이지만 일부 진행 뒤엔 남은 보상 합계('+3' 등)로 바뀜 → '+숫자' 전부 (10-28: '+3' 을 못 알아봐 한 판씩 남김)
      const plus = { predicate: "label BEGINSWITH '+'", below: { contains: o.name }, within: 40, above: 30, kind: 'Image' };
      const after = [
        { waitFor: { contains: '받았어요', timeout: 25 } },
        { ifExists: { text: '확인', timeout: 6 } },   // 보상 팝업이 늦게 떠서 3초로는 놓친 적 있음(10-21)
        { ifExists: { text: '닫기', kind: 'StaticText', timeout: 2 } },   // 구매·홍보 팝업 (머니 보상 팝업의 닫기는 Button 이라 제외)
        { wait: 1 },
      ];
      // 판 사이 화면이 늦게 뜨면 반복이 일찍 끝나 한 판이 남는 일이 있음(10-21·10-28)
      //  → 반복이 끝나면 메인으로 돌아가 +1 이 아직 있는지 다시 보고, 있으면 이어서 (최대 3번)
      let played = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        await run([...toMain, { scrollTo: { contains: o.name, between: [150, 600], maxSwipes: 12 } }]);
        let opened = false;
        try { await find(drv, plus, 3000); opened = true; } catch {}
        // 10-19: 버튼이 활성인데 못 찾고 건너뜀 → 앱을 다시 열어 한 번 더 찾고, 그래도 없으면 증거 스크린샷
        if (!opened && attempt === 0) {
          await run([...toMain, { scrollTo: { contains: o.name, between: [200, 550], maxSwipes: 12 } }]);
          try { await find(drv, plus, 6000); opened = true; } catch {}
        }
        if (!opened) {
          if (attempt === 0) { await shot(drv, `game_${o.solver}_none`).catch(() => {}); log(`    → ${o.name}: 받을 +1 없음 (오늘 완료)`); }
          else log(`    → ${o.name}: 남은 판 없음 확인`);
          break;
        }
        if (attempt > 0) log(`    → ${o.name}: 아직 남은 판이 있어 이어서 진행 (${attempt}번째 재확인)`);
        await run([{ tap: plus }, { wait: 2 }]);
        await run([{ repeat: { while: { contains: '코인 받기 (' }, max: 5, stopOnError: true, steps: [
          { tap: { contains: '코인 받기 (' } },
          { adSkip: { app, until: ['되돌리기'], timeout: 300 } }, { wait: 1 }, solver, ...after ] } }]);
        played++;
        if ((o.hardMax ?? 0) > 0) break;   // 머니 단계는 이 화면에서 바로 이어 감
      }
      if (!played) break;
      if ((o.hardMax ?? 0) > 0) {
        await run([{ if: { exists: { contains: '지금 바로 시작하기' }, timeout: 4, then: [{ tap: '지금 바로 시작하기' }, { wait: 3 }] } }]);
        await run([{ repeat: { while: { contains: '머니 룰렛' }, max: o.hardMax ?? 3, stopOnError: true, steps: [
          { tap: { text: '시작하기' } },
          { waitFor: { contains: '코인 5개를 사용', timeout: 8 } },
          { tap: { text: '시작하기', below: { contains: '보유한 코인' }, within: 400 } },
          { adSkip: { app, until: ['되돌리기'], timeout: 300 } }, { wait: 1 }, solver,
          { waitFor: { contains: '룰렛 돌리고', timeout: 15 } }, { spin: true }, ...after ] } }]);
      }
      await run([{ if: { exists: { contains: '지금 바로 시작하기' }, timeout: 2, then: [{ tap: '닫기' }] } }, { screenshot: `game_${o.solver}_end` }]);
      break;
    }
    case 'acceptAlert': {
      // 시스템 확인창(예: '쿠팡'에서 이 페이지를 열겠습니까?)의 버튼 누르기
      const name = typeof val === 'string' ? val : (o.button ?? '열기');
      const end = Date.now() + (o.timeout ?? 8) * 1000; let done = false;
      while (Date.now() < end && !done) {
        const btns = await drv.execute('mobile: alert', { action: 'getButtons' }).catch(() => null);
        if (btns?.includes(name)) { await drv.execute('mobile: alert', { action: 'accept', buttonLabel: name }); done = true; log(`    → 확인창 '${name}' 누름`); }
        else await sleep(700);
      }
      if (!done) log('    → 확인창 없음');
      break;
    }
    case 'scratch': case 'scratchStart': {
      // 복권: '코인 N개' 글자 줄 바로 위가 긁는 칸. scratchStart 는 첫 칸을 한 번 탭(광고 시작), scratch 는 모든 칸을 가로로 문지름
      const xml = await drv.getPageSource(); const ys = [];
      const re2 = /<XCUIElementTypeStaticText[^>]*name="코인&#10;\d+개"[^>]*y="([\d.]+)"/g; let q;
      while ((q = re2.exec(xml))) { const y = +q[1]; if (!ys.some(v => Math.abs(v - y) < 20)) ys.push(y); }
      ys.sort((a, b) => a - b);
      if (!ys.length) throw new Error('긁는 칸을 못 찾음');
      const { width: W } = await drv.getWindowSize();
      const areas = ys.map(y => ({ x1: 50, x2: W - 50, y1: y - 75, y2: y - 15 }));
      if (type === 'scratchStart') { await drv.execute('mobile: tap', { x: W / 2, y: (areas[0].y1 + areas[0].y2) / 2 }); await sleep(2000); break; }
      for (const a of areas) for (let y = a.y1; y <= a.y2; y += 10)
        await drv.execute('mobile: dragFromToForDuration', { fromX: a.x1, fromY: y, toX: a.x2, toY: y, duration: 0.2 });
      log(`    → 긁는 칸 ${areas.length}개 긁음`);
      await sleep(2000); break;
    }
    case 'balance': {
      // 메인 상단의 보유 코인·머니를 글자 인식으로 읽어 기록 (start / end)
      for (const st of [{ close: TARGET_APP }, { launch: TARGET_APP }, { waitFor: { contains: '오늘 걸음 수', timeout: 25 } }, { wait: 2 }]) await runStep(drv, st, 0);
      const f = path.join(ROOT, 'logs', 'balance.png'); await drv.saveScreenshot(f);
      const scale = fs.readFileSync(f).readUInt32BE(16) / (await drv.getWindowSize()).width;
      const { execFileSync } = await import('node:child_process');
      // 코인 칸(왼쪽)과 머니 칸(그 오른쪽)을 따로 읽음 — 0 같은 한 글자도 놓치지 않게, 숫자가 없으면 0
      const readPill = (x0, w) => execFileSync(path.join(ROOT, 'bin', 'ocr'), [f, String(Math.round(x0 * scale)), String(Math.round(60 * scale)), String(Math.round(w * scale)), String(Math.round(45 * scale))]).toString();
      const num = (t) => { const m = t.replace(/[,\s]/g, '').match(/\d+/g); return m ? Math.max(...m.map(Number)) : null; };
      let coinN = num(readPill(28, 62)), moneyN = num(readPill(92, 80));
      if (coinN === null || moneyN === null) {   // 칸 위치가 다를 때 대비: 띠 전체로 다시
        const txt = execFileSync(path.join(ROOT, 'bin', 'ocr'), [f, '0', String(Math.round(50 * scale)), String(Math.round(402 * scale)), String(Math.round(75 * scale))]).toString();
        const all = txt.split('\n').map(l => l.replace(/[,\s]/g, '')).filter(l => /^\d+$/.test(l)).map(Number);
        if (all.length >= 2) { coinN = all[0]; moneyN = all[1]; } else if (all.length === 1) { coinN = coinN ?? 0; moneyN = moneyN ?? all[0]; }
      }
      if (coinN === null) coinN = 0;
      if (moneyN === null) { log('    → 보유량 읽기 실패'); break; }
      const nums = [coinN, moneyN];
      runState.balance[val === 'end' ? 'end' : 'start'] = { coin: nums[0], money: nums[1] };
      if (val !== 'end') openRunEntry(runState.balance.start);
      log(`    → 보유 코인 ${nums[0]}개 · 머니 ${nums[1]}원 (${val === 'end' ? '끝' : '시작'})`);
      break;
    }
    case 'report': {
      // 코인 내역·머니 내역에서 오늘 날짜 항목을 끝까지 모아 미션별 합계 → logs/report-YYYY-MM-DD.txt
      const now = new Date(); const today = `${now.getMonth() + 1}.${String(now.getDate()).padStart(2, '0')}`;
      const todayAlt = `${now.getMonth() + 1}.${now.getDate()}`;
      const collect = async (pillX) => {
        for (const st of [{ close: TARGET_APP }, { launch: TARGET_APP }, { waitFor: { contains: '오늘 걸음 수', timeout: 20 } }, { tap: { x: pillX, y: 95 } }, { wait: 3 }]) await runStep(drv, st, 0);
        // 가상 목록이라 보이는 항목만 있음 → 스크롤 전후 같은 항목의 y 이동량(최빈값)으로 실제 스크롤 거리를 구해 절대 위치로 모음
        const byPos = new Map(); let offset = 0, prevPage = null, stale = 0;
        for (let k = 0; k < 60 && stale < 2; k++) {
          const xml = await drv.getPageSource(); const page = [];
          const re2 = /name="(\d{1,2}\.\d{1,2})&#10;([^"]*)"[^>]*visible="true"[^>]*y="([\d.]+)"/g; let q;
          while ((q = re2.exec(xml))) page.push({ d: q[1], body: q[2].split('&#10;'), y: +q[3], key: q[1] + '|' + q[2] });
          if (prevPage) {
            const votes = new Map();
            for (const a of prevPage) for (const b of page) if (a.key === b.key) { const dd = Math.round(a.y - b.y); votes.set(dd, (votes.get(dd) ?? 0) + 1); }
            let best = 0, bv = -1; for (const [dd, v] of votes) if (v > bv || (v === bv && dd > best)) { bv = v; best = dd; }
            if (best <= 2) stale++; else stale = 0;
            offset += best;
          }
          let added = 0;
          for (const e of page) { const abs = Math.round((e.y + offset) / 10); if (![...byPos.keys()].some(p => Math.abs(p - abs) <= 2)) { byPos.set(abs, e); added++; } }
          prevPage = page;
          if (page.some(e => e.d !== today && e.d !== todayAlt)) break;
          await drv.execute('mobile: dragFromToForDuration', { fromX: 8, fromY: 640, toX: 8, toY: 340, duration: 1.0 }); await sleep(900);
        }
        const all = [...byPos.entries()].sort((a, b) => a[0] - b[0]).map(v => v[1]);
        return all.filter(e => e.d === today || e.d === todayAlt);
      };
      const coins = await collect(60), money = await collect(150);
      const sum = (list, re) => { const by = {}; let tot = 0;
        for (const e of list) { const m = e.body.join(' ').match(re); if (!m) continue; const v = (m[1] === '-' ? -1 : 1) * +m[2].replace(/,/g, ''); tot += v; by[e.body[0]] = (by[e.body[0]] ?? 0) + v; }
        return { tot, by }; };
      const AUTO_RE = /걷기|놓친|스도쿠|퀸즈|시카쿠|보너스|클릭하고|쿠팡|럭키또/;
      const other = coins.filter(e => !AUTO_RE.test(e.body[0]));
      const c = sum(coins.filter(e => AUTO_RE.test(e.body[0])), /([+-])?\s*([\d,]+)\s*코인/), w = sum(money.filter(e => AUTO_RE.test(e.body[0])), /([+-])?\s*([\d,]+)\s*원\s*$/);
      const o2 = sum(other, /([+-])?\s*([\d,]+)\s*코인/);
      const b = runState.balance; const hasB = b.start && b.end;
      const lines = [`럭키즈 ${now.toLocaleDateString('ko-KR')} 보고`,
        `Claude 호출 ${runState.aiCalls}회 (광고 버튼 판단)`,
        `소요 시간 ${fmtDur(Math.round((Date.now() - runState.startedAt) / 1000))} (시작 ${new Date(runState.startedAt).toLocaleTimeString('ko-KR')})`,
        ...(hasB ? [`이번 실행 획득(보유량 기준): 코인 ${b.end.coin - b.start.coin >= 0 ? '+' : ''}${b.end.coin - b.start.coin}개 (${b.start.coin}→${b.end.coin}) · 머니 +${b.end.money - b.start.money}원 (${b.start.money}→${b.end.money})`, '오늘 내역 기준(참고):'] : []), `코인 합계 ${c.tot >= 0 ? '+' : ''}${c.tot}개 (${coins.length}건)`,
        ...Object.entries(c.by).map(([k, v]) => `  ${k}: ${v >= 0 ? '+' : ''}${v}`), `머니 합계 +${w.tot}원 (${money.length}건)`,
        ...Object.entries(w.by).map(([k, v]) => `  ${k}: +${v}원`),
        ...(other.length ? [`자동화 외 항목(합계 제외) ${o2.tot >= 0 ? '+' : ''}${o2.tot}코인`, ...Object.entries(o2.by).map(([k, v]) => `  ${k}: ${v >= 0 ? '+' : ''}${v}`)] : [])];
      try { (await import('node:child_process')).execFileSync('osascript', ['-e', `display notification "${hasB ? `코인 ${b.end.coin - b.start.coin >= 0 ? '+' : ''}${b.end.coin - b.start.coin}개 · 머니 +${b.end.money - b.start.money}원` : `코인 ${c.tot >= 0 ? '+' : ''}${c.tot}개 · 머니 +${w.tot}원`}" with title "럭키즈 자동 실행 완료"`]); } catch {}
      const out = path.join(ROOT, 'logs', `report-${now.toISOString().slice(0, 10)}.txt`);
      fs.writeFileSync(out, lines.join('\n') + '\n');
      // 날짜별 데이터: 이번 회차 갱신 (시작 때 이미 만들어 둠)
      updateRunEntry({ balanceEnd: b.end ?? undefined, historyCoin: c.tot, historyMoney: w.tot, coinByMission: c.by, moneyByMission: w.by, otherCoin: o2.by, aiCalls: runState.aiCalls });
      runState.reportFile = dayFile(runState.dayKey ?? dayKey());
      for (const l of lines) log('  📋 ' + l);
      await runStep(drv, { close: TARGET_APP }, 0); await runStep(drv, { launch: TARGET_APP }, 0);
      break;
    }
    case 'visitCoupang': {
      // 쿠팡 5초 구경: 버튼 탭 → 사파리/쿠팡으로 실제 이동 확인 → 8초 머문 뒤 럭키즈 복귀 → '받았어요' 확인, 안 되면 한 번 더
      const btnSel = `-ios predicate string:type == 'XCUIElementTypeButton' AND label CONTAINS '구경하고'`;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const btn = (await drv.$$(btnSel))[0];
        if (!btn) { const x = await drv.getPageSource(); if (/받았어요/.test(x)) { log('    → 이미 받음'); break; } throw new Error('쿠팡 버튼을 못 찾음'); }
        const r = await drv.getElementRect(btn.elementId); const { width: W } = await drv.getWindowSize();
        await drv.execute('mobile: tap', { x: Math.min(W - 20, Math.max(20, r.x + r.width / 2)), y: r.y + r.height / 2 }); lastActionAt = Date.now();
        let left = false;
        for (let k = 0; k < 10 && !left; k++) { await sleep(500); const info = await drv.execute('mobile: activeAppInfo').catch(() => null); left = !!info && info.bundleId !== TARGET_APP; }
        log(left ? '    → 쿠팡 페이지로 이동함, 8초 머묾' : '    → 다른 앱으로 안 넘어감 (앱 안 화면일 수 있음), 8초 기다림');
        await sleep(8000);
        await drv.execute('mobile: activateApp', { bundleId: TARGET_APP }); lastActionAt = Date.now(); await sleep(2500);
        const x = await drv.getPageSource();
        if (/1코인 받았어요|코인 받았어요|받았어요/.test(x)) { log('    → 쿠팡 방문 코인 받음'); break; }
        log(`    → 아직 보상 표시 없음${attempt < 2 ? ', 한 번 더' : ''}`);
        if (attempt === 2) throw new Error('쿠팡 방문 보상 확인 실패');
      }
      break;
    }
    case 'adSkip': await adSkip(drv, o); break;
    case 'wait': await sleep(Number(val) * 1000); break;
    case 'swipe': {
      let atY = null;
      if (o.at) { const a = await find(drv, typeof o.at === 'string' ? { text: o.at } : o.at, 3000); atY = (await a.getLocation()).y + (o.offsetY ?? 0); }
      await swipe(drv, typeof val === 'string' ? val : o.direction, o.distance, atY); await sleep(800); break;
    }
    case 'scrollTo': {
      // between: [최소y, 최대y] 를 주면 요소가 그 높이 범위에 들어올 때까지 조금씩 스크롤
      const target = typeof val === 'string' ? { text: val } : o;
      const [lo, hi] = o.between ?? [0, 99999];
      for (let k = 0; k < (o.maxSwipes ?? 10); k++) {
        let y = null;
        try { const el = await find(drv, target, 1000); if (await el.isDisplayed()) y = (await el.getLocation()).y; } catch {}
        if (process.env.DEBUG_SCROLL) log(`    · scrollTo y=${y}`);
        if (y !== null && y >= lo && y <= hi) break;
        if (y !== null && y < lo) await swipe(drv, 'down', 0.25);
        else if (y !== null && y > hi) await swipe(drv, 'up', 0.25);
        else await swipe(drv, o.direction ?? 'up');
        await sleep(600);
      }
      break;
    }
    case 'home': await drv.execute('mobile: pressButton', { name: 'home' }); break;
    case 'volumeUp': await drv.execute('mobile: pressButton', { name: 'volumeUp' }); break;
    case 'volumeDown': await drv.execute('mobile: pressButton', { name: 'volumeDown' }); break;
    case 'screenshot': await shot(drv, typeof val === 'string' ? val : o.name); break;
    case 'assert': await find(drv, typeof val === 'string' ? { text: val } : o, (o.timeout ?? 10) * 1000); log('    → 확인됨'); break;
    default: throw new Error(`모르는 단계: ${type}`);
  }
}

// 동시 실행 방지 잠금
const LOCK = path.join(ROOT, 'logs', 'run.lock');
try { const pid = +fs.readFileSync(LOCK, 'utf8'); process.kill(pid, 0); console.error(`이미 실행 중 (pid ${pid})`); process.exit(2); } catch {}
fs.writeFileSync(LOCK, String(process.pid));
process.on('exit', () => { try { if (+fs.readFileSync(LOCK, 'utf8') === process.pid) fs.rmSync(LOCK); } catch {} });
// 중지: 첫 신호는 하던 단계를 멈추고 보유량을 읽어 기록한 뒤 끝냄, 두 번째 신호는 즉시 종료
let stopRequested = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  if (stopRequested) process.exit(130);
  stopRequested = true; log('■ 중지 요청 — 마무리(보유량 기록) 후 끝냄');
});

const appium = await startAppium();
let drv, ok = true;
try {
  log(`▶ 시나리오 시작: ${sc.name ?? file} (${deviceName ?? config.device})`);
  drv = await resilientSession(deviceName);
  lastActionAt = Date.now();
  log(`  ✓ 폰 연결 완료 (${Math.round((Date.now() - runState.startedAt) / 1000)}초)`);
  for (const [i, step] of (sc.steps ?? []).entries()) {
    const gen0 = drv.__gen;
    try {
      try { await runStep(drv, step, i); }
      catch (e) {
        // 단계 도중 조작 도구가 끊겼다 다시 붙었으면 그 단계를 한 번 더
        if (stopRequested || !(drv.__gen !== gen0 || DEAD_RE.test(e?.message ?? ''))) throw e;
        if (drv.__gen === gen0) await drv.__reconnect();
        log(`  ↻ ${i + 1}단계 다시 시도 (연결 복구 후)`);
        await runStep(drv, step, i);
      }
    }
    catch (e) {
      log(`  ✗ ${i + 1}단계 실패: ${e.message}`); await shot(drv, `fail_step${i + 1}`).catch(() => {});
      if (stopRequested) { ok = false; break; }
      if (!sc.continueOnError) { ok = false; break; }
      ok = false;
    }
  }
  log(ok ? '✔ 시나리오 완료' : '✗ 시나리오 중단');
} catch (e) { ok = false; log('✗ 세션 실패:', e.message); }
finally {
  if (drv && runState.runIndex != null && !runState.balance.end) {
    runState.finalizing = true;
    try { await runStep(drv, { balance: 'end' }, 0); } catch (e) { log('  끝 보유량 읽기 실패: ' + e.message); }
  }
  await releaseSession(drv); appium.stop();
  const sec = Math.round((Date.now() - runState.startedAt) / 1000);
  log(`⏱ 전체 소요 시간 ${fmtDur(sec)} · Claude 호출 ${runState.aiCalls}회`);
  if (runState.runIndex != null) try {
    let profile = null; try { profile = JSON.parse((await import('node:child_process')).execFileSync('python3', [path.join(ROOT, 'tools', 'profile.py'), '--json']).toString()); } catch {}
    updateRunEntry({ durationSec: sec, endedAt: new Date().toISOString(), ok, status: stopRequested ? 'stopped' : ok ? 'done' : 'failed',
      aiCalls: runState.aiCalls, incidents: runState.incidents ?? 0, profile, ...(runState.balance.end ? { balanceEnd: runState.balance.end } : {}) });
    runState.reportFile = dayFile(runState.dayKey);
    const txt = runState.reportFile.replace(/reports\/(\d{4}-\d{2}-\d{2})\.json$/, 'report-$1.txt');
    if (fs.existsSync(txt)) fs.writeFileSync(txt, fs.readFileSync(txt, 'utf8').replace(/소요 시간 [^\n]*/, `소요 시간 ${fmtDur(sec)} (시작 ${new Date(runState.startedAt).toLocaleTimeString('ko-KR')})`));
  } catch {}
}
process.exit(ok ? 0 : 1);
