// 공통: Appium 서버 띄우기 + 세션 열기
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { remote, attach } from 'webdriverio';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
// config.json 이 없으면(클라우드 실행) config.example.json 을 쓰고 환경변수로 덮음
const cfgFile = fs.existsSync(path.join(ROOT, 'config.json')) ? 'config.json' : 'config.example.json';
export const config = JSON.parse(fs.readFileSync(path.join(ROOT, cfgFile), 'utf8'));
fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
// 무선(Tailscale)·클라우드 실행: 폰의 WDA 주소가 있으면 Appium 없이 바로 붙음 (예: http://100.x.x.x:8100)
export const WDA_URL = process.env.LUCKYZ_WDA_URL || config.devices?.[config.device]?.wdaUrl || '';

export function log(...a) {
  const line = `[${new Date().toLocaleString('ko-KR')}] ${a.join(' ')}`;
  if (!process.env.LUCKYZ_QUIET) console.log(line);   // 클라우드(공개 저장소) 실행에선 화면 출력 안 함
  fs.appendFileSync(path.join(ROOT, 'logs', 'run.log'), line + '\n');
}

async function isUp(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/status`); return r.ok; } catch { return false; }
}

export async function startAppium() {
  if (WDA_URL) return { stop() {} };
  const port = config.appiumPort;
  if (await isUp(port)) return { stop() {} };
  // 상시 Appium 서버(launchd)를 먼저 깨움 — 조작 도구를 계속 켜 둬서 다음 실행이 빠름
  try { (await import('node:child_process')).execFileSync('launchctl', ['kickstart', `gui/${process.getuid()}/com.hoseong.luckyz-appium`], { stdio: 'ignore' }); } catch {}
  for (let i = 0; i < 40; i++) { if (await isUp(port)) return { stop() {} }; await new Promise(r => setTimeout(r, 500)); }
  const out = fs.openSync(path.join(ROOT, 'logs', 'appium.log'), 'a');
  const p = spawn(path.join(ROOT, 'node_modules/.bin/appium'), ['-p', String(port), '--log-level', 'info'], {
    env: { ...process.env, APPIUM_HOME: path.join(ROOT, '.appium') },
    stdio: ['ignore', out, out],
  });
  for (let i = 0; i < 60; i++) {
    if (await isUp(port)) return { stop() { p.kill(); } };
    await new Promise(r => setTimeout(r, 500));
  }
  p.kill();
  throw new Error('Appium 서버가 30초 안에 안 떴습니다. logs/appium.log 확인');
}

// 상시 세션: 세션을 닫으면 Appium 이 폰의 조작 도구(WDA)까지 꺼서 다음 실행 때 xcodebuild 로 재설치됨.
// 그래서 세션 하나를 계속 살려 두고(logs/session.json) 실행마다 거기에 붙기만 함 → 실행 즉시 럭키즈가 열림.
const SESSION_FILE = path.join(ROOT, 'logs', 'session.json');
const CREATE_LOCK = path.join(ROOT, 'logs', 'session-create.lock');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error('timeout'); })]);

async function attachSaved(udid) {
  let saved; try { saved = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch { return null; }
  if (saved.udid !== udid) return null;
  const drv = await attach({ sessionId: saved.sessionId, capabilities: saved.capabilities,
    hostname: '127.0.0.1', port: config.appiumPort, path: '/', logLevel: 'error' });
  try { await withTimeout(drv.execute('mobile: activeAppInfo'), 15000); return drv; }
  catch { await withTimeout(drv.deleteSession(), 20000).catch(() => {}); fs.rmSync(SESSION_FILE, { force: true }); return null; }
}

async function createSession(d) {
  const caps = {
    platformName: 'iOS',
    'appium:automationName': 'XCUITest',
    'appium:udid': d.udid,
    'appium:noReset': true,
    'appium:newCommandTimeout': 0, // 상시 세션 — 시간 초과로 닫히지 않게
    'appium:wdaLaunchTimeout': 240000,
    'appium:wdaConnectionTimeout': 240000,
    'appium:showXcodeLog': false,
  };
  if (d.real) {
    caps['appium:xcodeOrgId'] = d.teamId;
    caps['appium:xcodeSigningId'] = 'Apple Development';
    caps['appium:updatedWDABundleId'] = d.wdaBundleId;
    caps['appium:allowProvisioningDeviceRegistration'] = true;
  }
  // connectionRetryCount 0: 재시도가 앞 요청과 겹치면 세션끼리 서로 끊으며 WDA 를 거듭 재설치함
  const drv = await remote({
    hostname: '127.0.0.1', port: config.appiumPort, path: '/',
    logLevel: 'error', capabilities: caps, connectionRetryTimeout: 600000, connectionRetryCount: 0,
  });
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ udid: d.udid, sessionId: drv.sessionId, capabilities: drv.capabilities, createdAt: new Date().toISOString() }));
  return drv;
}

export async function openSession(deviceName = config.device) {
  if (WDA_URL) { const { wdaDriver } = await import('./wda.mjs'); return wdaDriver(WDA_URL); }
  const d = config.devices[deviceName];
  if (!d) throw new Error(`config.json 에 '${deviceName}' 기기가 없습니다`);
  const hit = await attachSaved(d.udid);
  if (hit) return hit;
  // 세션 만들기는 한 번에 하나만 (미리 띄우기 warm 과 실행이 겹쳐도 하나가 끝나길 기다렸다 붙음)
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(CREATE_LOCK); break; }
    catch {
      let age = 0; try { age = Date.now() - fs.statSync(CREATE_LOCK).mtimeMs; } catch {}
      if (age > 300000) { fs.rmSync(CREATE_LOCK, { recursive: true, force: true }); continue; }
      await sleep(2000);
      const again = await attachSaved(d.udid).catch(() => null);
      if (again) return again;
    }
  }
  try {
    return (await attachSaved(d.udid)) ?? (await createSession(d));
  } finally { fs.rmSync(CREATE_LOCK, { recursive: true, force: true }); }
}

// 세션은 닫지 않음(조작 도구 유지). 완전히 끊어야 할 때만 closeSession()
export async function releaseSession(drv) { /* 의도적으로 유지 */ }
export async function closeSession(drv) {
  if (WDA_URL) return;
  await drv?.deleteSession().catch(() => {}); fs.rmSync(SESSION_FILE, { force: true });
}

// 실행 중 조작 도구(WDA)가 죽으면(무거운 광고 화면 source 읽다 폰에서 종료되는 경우 등) 자동으로 다시 연결하고 같은 호출을 재시도
export const DEAD_RE = /socket hang up|Session does not exist|ECONNREFUSED|ECONNRESET|WebDriverAgent is not initialized|invalid session id|session is either terminated|session not created/i;
export async function resilientSession(deviceName = config.device) {
  let cur = await openSession(deviceName), gen = 0, pending = null;
  const reconnect = () => pending ??= (async () => {
    log('  ⚠ 조작 도구 연결 끊김 — 다시 연결');
    const t = Date.now();
    await withTimeout(closeSession(cur), 30000).catch(() => {});
    cur = await openSession(deviceName); gen++;
    log(`  ✓ 다시 연결됨 (${Math.round((Date.now() - t) / 1000)}초)`);
  })().finally(() => { pending = null; });
  return new Proxy({}, {
    get(_, prop) {
      if (prop === '__gen') return gen;
      if (prop === '__reconnect') return reconnect;
      const v = cur[prop];
      if (typeof v !== 'function') return v;
      return async (...args) => {
        try { return await cur[prop](...args); }
        catch (e) { if (!DEAD_RE.test(e?.message ?? '')) throw e; await reconnect(); return await cur[prop](...args); }
      };
    },
  });
}
