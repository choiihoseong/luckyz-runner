// Appium 없이 폰의 조작 도구(WebDriverAgent)에 HTTP 로 바로 붙는 드라이버
//  - 용도: 폰이 USB 로 안 붙어 있을 때(Tailscale 무선·클라우드 실행). Appium 은 USB(usbmux)로 보이는 폰만 받아 줌.
//  - run.mjs 가 쓰는 webdriverio 메서드·'mobile: …' 명령만 같은 모양으로 흉내 냄 (Appium xcuitest 드라이버가 WDA 로 보내는 요청 그대로)
import fs from 'node:fs';

const W3C_EL = 'element-6066-11e4-a52e-4f735466cecf';

export async function wdaDriver(baseUrl, { timeoutMs = 60000 } = {}) {
  const base = baseUrl.replace(/\/$/, '');
  const call = async (method, p, body) => {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(base + p, { method, signal: ctl.signal, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    } catch (e) { throw new Error(`ECONNREFUSED WDA 연결 실패 (${base}): ${e.cause?.code ?? e.message}`); }
    finally { clearTimeout(t); }
    const j = await res.json().catch(() => ({}));
    const v = j.value;
    if (!res.ok || (v && typeof v === 'object' && v.error)) {
      const msg = v?.message || v?.error || `HTTP ${res.status}`;
      throw new Error(/session/i.test(v?.error ?? '') ? `invalid session id: ${msg}` : msg);
    }
    return v;
  };

  const st = await call('GET', '/status');
  let sid = st?.sessionId;
  if (!sid) sid = (await call('POST', '/session', { capabilities: { alwaysMatch: {}, firstMatch: [{}] } }))?.sessionId;
  const s = (p) => `/session/${sid}${p}`;
  const idOf = (e) => e?.[W3C_EL] ?? e?.ELEMENT;

  const el = (id) => ({
    elementId: id,
    isDisplayed: () => call('GET', s(`/element/${id}/displayed`)),
    isEnabled: () => call('GET', s(`/element/${id}/enabled`)),
    getTagName: () => call('GET', s(`/element/${id}/name`)),
    getLocation: async () => { const r = await call('GET', s(`/element/${id}/rect`)); return { x: r.x, y: r.y }; },
    getSize: async () => { const r = await call('GET', s(`/element/${id}/rect`)); return { width: r.width, height: r.height }; },
    getElementRect: () => call('GET', s(`/element/${id}/rect`)),
    getText: () => call('GET', s(`/element/${id}/text`)),
    getAttribute: (n) => call('GET', s(`/element/${id}/attribute/${encodeURIComponent(n)}`)),
    click: () => call('POST', s(`/element/${id}/click`), {}),
    setValue: (text) => call('POST', s(`/element/${id}/value`), { value: String(text).split('') }),
  });
  const parseSel = (sel) => {
    if (sel.startsWith('~')) return { using: 'accessibility id', value: sel.slice(1) };
    if (sel.startsWith('-ios predicate string:')) return { using: 'predicate string', value: sel.slice('-ios predicate string:'.length) };
    if (sel.startsWith('-ios class chain:')) return { using: 'class chain', value: sel.slice('-ios class chain:'.length) };
    if (sel.startsWith('/') || sel.startsWith('(')) return { using: 'xpath', value: sel };
    return { using: 'class name', value: sel };
  };
  const findAll = async (sel) => ((await call('POST', s('/elements'), parseSel(sel))) ?? []).map(e => el(idOf(e)));

  const mobile = {
    'mobile: tap': ({ x, y, elementId }) => call('POST', s(elementId ? `/wda/element/${elementId}/tap` : '/wda/tap'), { x, y }),
    'mobile: touchAndHold': ({ x, y, duration, elementId }) => call('POST', s(elementId ? `/wda/element/${elementId}/touchAndHold` : '/wda/touchAndHold'), { x, y, duration: Number(duration) }),
    'mobile: dragFromToForDuration': ({ fromX, fromY, toX, toY, duration, elementId }) =>
      call('POST', s(elementId ? `/wda/element/${elementId}/dragfromtoforduration` : '/wda/dragfromtoforduration'), { fromX: +fromX, fromY: +fromY, toX: +toX, toY: +toY, duration: +duration }),
    'mobile: activeAppInfo': () => call('GET', s('/wda/activeAppInfo')),
    'mobile: launchApp': ({ bundleId, arguments: args, environment }) => call('POST', s('/wda/apps/launch'), { bundleId, arguments: args, environment }),
    'mobile: terminateApp': ({ bundleId }) => call('POST', s('/wda/apps/terminate'), { bundleId }),
    'mobile: activateApp': ({ bundleId }) => call('POST', s('/wda/apps/activate'), { bundleId }),
    'mobile: isLocked': () => call('GET', s('/wda/locked')),
    'mobile: unlock': () => call('POST', s('/wda/unlock')),
    'mobile: pressButton': ({ name, durationSeconds }) => call('POST', s('/wda/pressButton'), { name, duration: durationSeconds }),
    'mobile: alert': ({ action, buttonLabel }) => {
      if (action === 'getButtons') return call('GET', s('/wda/alert/buttons'));
      const body = buttonLabel ? { name: buttonLabel } : {};
      if (action === 'accept') return call('POST', s('/alert/accept'), body);
      if (action === 'dismiss') return call('POST', s('/alert/dismiss'), body);
      throw new Error(`mobile: alert action 은 accept/dismiss/getButtons: ${action}`);
    },
  };

  return {
    sessionId: sid, wdaUrl: base, capabilities: {},
    execute: async (name, args = {}) => {
      const f = mobile[name]; if (!f) throw new Error(`무선 드라이버가 모르는 명령: ${name}`);
      return f(args ?? {});
    },
    $$: findAll,
    $: async (sel) => { const l = await findAll(sel); if (!l.length) throw new Error(`요소 없음: ${sel}`); return l[0]; },
    getPageSource: () => call('GET', '/source?format=xml&scope=AppiumAUT'),
    getWindowSize: () => call('GET', s('/window/size')),
    getElementRect: (id) => call('GET', s(`/element/${id}/rect`)),
    takeScreenshot: () => call('GET', '/screenshot'),
    saveScreenshot: async (file) => { const b = await call('GET', '/screenshot'); fs.writeFileSync(file, Buffer.from(b, 'base64')); return b; },
    performActions: (actions) => call('POST', s('/actions'), { actions }),
    releaseActions: async () => {},
    keys: (arr) => call('POST', s('/wda/keys'), { value: [].concat(arr) }),
    url: (u) => call('POST', s('/url'), { url: u }),
    deleteSession: async () => {},   // 세션·WDA 유지
  };
}
