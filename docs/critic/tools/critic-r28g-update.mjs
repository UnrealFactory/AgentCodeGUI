// 최종 파리티 R5 수정 라운드 1 — **앱 자동 업데이트 통로**를 화면에서 판정한다.
//
//   node docs/critic/tools/critic-r28g-update.mjs --exe=<3.0 exe> [--port=10631]
//        [--arm=bare|ready|downloading] [--runs=3] [--out=json]
//
// ── 왜 이 계기를 새로 쓰나 ───────────────────────────────────────────────────
// 확인 크리틱 R1(`docs/critic/r28g-audit3-critic-r1.md` §4.2)이 R5를 불합격시킨 사유:
// 「§9 첫 줄이 남은 10을 적어 놓고 판정은 `app:open-directory` **하나**로 닫았다 —
// `app:update-{check,install,event}` 셋(= 자동 업데이트 통로 전부)이 등급도 사유도 없이
// 빠졌다」. 나는 그 사실을 **남의 보고서가 아니라 내 exe·내 격리 홈에서** 다시 잰다.
//
// ── 무엇을 가르나 (이 라운드의 판별 설계) ────────────────────────────────────
// 「채널이 미구현이다」는 스캐너로 이미 안다. 화면 축에서 물어야 하는 것은 두 가지다.
//   ① 방출자가 정말 0인가        → 원시 `ipc_call` 3채널 + 대조 3채널(양성·음성)
//   ② 화면(`AppUpdateGate`)이 죽은 것인가, **살았는데 먹일 것이 없는 것인가**
//      → ★스텁 대조군. 셸이 주는 시드(`app.getUpdateStatus`)만 갈아 끼우면 카드가
//        뜨는지 본다. 뜨면 「화면은 실려 있고 방출자만 0」이 실행으로 증명된다.
//        (R4의 `sees42`처럼 **가설이 참인 세계에서도 안 켜지는 칸**을 또 싣지 않으려면,
//         이 라운드의 새 주장도 자기 판별력을 스스로 증명해야 한다.)
//   ③ 카드가 떴다 치고 「업데이트」를 누르면 무슨 일이 나는가 → 제품 경로 클릭 1회.
//   ④ `app:update-install`은 크리틱이 **일부러 안 눌렀다**(구현돼 있으면 앱이 꺼진다).
//      나는 누른다 — 단 **모든 측정이 끝난 마지막**에. 꺼지면 그것도 실측이다.
//
// ── 스텁은 어떻게 심나 ───────────────────────────────────────────────────────
// `AppUpdateGate`는 **마운트 때 한 번** 시드를 읽는다(`:29`). 그래서 로드 후 대입으로는
// 늦다 — `Page.addScriptToEvaluateOnNewDocument`로 문서 생성 시점에 `window.api`의
// **setter 덫**을 놓고, 심(`shim.ts` 끝줄 `window.api = api`)이 대입하는 그 순간
// `app.getUpdateStatus`만 바꿔치기한 뒤 `Page.reload()`로 다시 마운트시킨다.
// bare 팔도 **똑같이 reload** 한다 — 두 팔의 유일한 차이가 스텁이 되게.
//
// ── 안전 ─────────────────────────────────────────────────────────────────────
// * 홈은 내가 직접 쓴다 — 실홈(`%USERPROFILE%\.agentcodegui`)을 **읽지도 복사하지도**
//   않는다(`bench/fixture.mjs`의 `makeFixtureHome`은 `accounts.json`·`Local State`를
//   복사한다. 이 축은 계정이 필요 없으므로 아예 안 쓴다 — 확인 크리틱 R1 §0.3의 규율).
// * `CCG_NO_NET=1` · 이름 기반 kill 0(내가 스폰한 PID만) · 산출물은 `--out`으로만.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { cdpTargets, Cdp, killTree, sleep, REPO } from '../../../bench/lib.mjs'

const argv = process.argv.slice(2)
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d }
const EXE = arg('exe', undefined)
const PORT = Number(arg('port', 10631))
const ROOT = arg('root', 'C:\\Temp\\ccg-r28g-audit')
const ARM = arg('arm', 'bare') // bare | ready | downloading
const RUNS = Number(arg('runs', 3))
const OUT = path.resolve(arg('out', path.join(REPO, 'docs', 'critic', `final-parity-r5-update-${ARM}.json`)))
const APP_VERSION = '3.0.0-beta.1'

if (!EXE) { console.error('--exe=<3.0 release exe> 필수'); process.exit(2) }

// 심는 값 — 셸이 「받아 놨다」/「받는 중」이라고 말하는 판.
const PLANT = ARM === 'ready'
  ? { phase: 'downloaded', version: '9.9.9-upd-stub', percent: 100, log: ['stub'], error: null }
  : ARM === 'downloading'
    ? { phase: 'downloading', version: '9.9.9-upd-stub', percent: 42, log: ['stub'], error: null }
    : null

/** 실홈을 참조하지 않는 최소 홈. 이 축은 계정·엔진·스레드가 전혀 필요 없다. */
function buildHome(tag) {
  const home = path.join(ROOT, `home-upd-${ARM}-${tag}`)
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 잠기면 덮어쓴다 */ }
  fs.mkdirSync(path.join(home, 'chats'), { recursive: true })
  fs.writeFileSync(path.join(home, 'profile.json'), JSON.stringify({ nickname: 'UpdAudit', color: '#0EA5E9' }))
  fs.writeFileSync(path.join(home, 'engine-auto-update.json'), JSON.stringify({ enabled: false }))
  fs.writeFileSync(path.join(home, 'ui-prefs.json'), JSON.stringify({
    'workspace.mode': 'single', 'explorer.swap': false, 'chat.zoom': 1,
    'sidebar.autohide': false, 'whatsnew.seenVersion': APP_VERSION, 'ui.lang': 'ko'
  }))
  fs.writeFileSync(path.join(home, 'chats', 'index.json'), JSON.stringify({ version: 1, order: [], activeChatId: null }))
  return home
}

async function connectMain(port, timeoutMs = 90000) {
  const t0 = Date.now()
  for (;;) {
    try {
      const ts = await cdpTargets(port)
      const t = ts.find((x) => x.type === 'page' && !x.url.startsWith('data:') && !/toast\.html|tray\.html/.test(x.url) && !x.url.includes('#') && /index\.html|localhost/.test(x.url))
      if (t?.webSocketDebuggerUrl) return await Cdp.connect(t.webSocketDebuggerUrl)
    } catch { /* 아직 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('main target not found')
    await sleep(80)
  }
}

/** 앞 주행의 웹뷰가 CDP 포트를 아직 물고 있으면 다음 주행이 **죽은 문서**에 붙는다
 *  (초판에서 실제로 났다 — `rootKids 0` · `window.api undefined` ·
 *   Tauri IPC가 `Origin header is not a valid URL`. 6주행 중 4가 그 꼴이었다).
 *  그래서 다음 기동 전에 포트가 조용해질 때까지 기다린다. */
async function waitPortFree(port, timeoutMs = 20000) {
  const t0 = Date.now()
  for (;;) {
    let live = false
    try { live = (await cdpTargets(port)).length > 0 } catch { live = false }
    if (!live) return Date.now() - t0
    if (Date.now() - t0 > timeoutMs) return -1
    await sleep(200)
  }
}

/** `#root`에 자식이 생길 때까지. 안 생기면 false — **조용히 0을 재지 않는다.** */
async function waitMount(cdp, ms = 60000) {
  const t0 = Date.now()
  for (;;) {
    const ok = await cdp.eval(`!!document.getElementById('root') && document.getElementById('root').children.length > 0`).catch(() => false)
    if (ok) return true
    if (Date.now() - t0 > ms) return false
    await sleep(150)
  }
}

// 화면이 실제로 보여 주는 것 — 카드 유무·문구·버튼·게이지.
const SNAP = `(() => JSON.stringify({
  href: String(location.href).slice(0, 120),
  upd: document.querySelectorAll('.upd').length,
  updText: ((document.querySelector('.upd') || {}).textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
  goBtn: document.querySelectorAll('.upd .ub button.go').length,
  laterBtn: document.querySelectorAll('.upd .ub button.later').length,
  bar: document.querySelectorAll('.upd .upbar').length,
  sb: document.querySelectorAll('.sb-item').length,
  win: document.querySelectorAll('.win-ctl').length,
  rootKids: (document.getElementById('root') || { children: [] }).children.length,
  stub: window.__updStub ? JSON.stringify(window.__updStub) : null
}))()`

const RAW = (ch) => `window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: ${JSON.stringify(ch)}, payload: [] })
  .then((v) => JSON.stringify(v === undefined ? null : v)).catch((e) => 'THROW ' + String((e && e.message) || e))`

const CLICK_GO = `(() => {
  const b = document.querySelector('.upd .ub button.go')
  if (!b) return 'no-go-btn'
  b.click(); return 'clicked'
})()`

const stubScript = () => `(() => {
  const PLANT = ${JSON.stringify(PLANT)};
  let real;
  try {
    Object.defineProperty(window, 'api', {
      configurable: true,
      get() { return real },
      set(v) {
        real = v;
        try {
          if (v && v.app && typeof v.app.getUpdateStatus === 'function') {
            v.app.getUpdateStatus = async () => PLANT;
            window.__updStub = { applied: true, via: 'window.api setter', planted: PLANT };
          } else {
            window.__updStub = { applied: false, why: 'no app.getUpdateStatus at assign' };
          }
        } catch (e) { window.__updStub = { applied: false, err: String((e && e.message) || e) } }
      }
    });
    window.__updStubArmed = true;
  } catch (e) { window.__updStub = { applied: false, err: 'defineProperty ' + String((e && e.message) || e) } }
})()`

const out = {
  at: new Date().toISOString(), arm: ARM, exe: EXE, port: PORT, plant: PLANT,
  what: '앱 자동 업데이트 통로(app:update-check/install/event) 화면 축 판정 — 감사 R5 수정 라운드 1',
  runs: []
}

for (let i = 1; i <= RUNS; i++) {
  const home = buildHome(`j${i}`)
  const rec = { run: i, home, at: new Date().toISOString(), console: [] }
  let child = null
  let cdp = null
  try {
    child = spawn(EXE, [], {
      env: { ...process.env, CCG_HOME: home, CCG_CDP_PORT: String(PORT), CCG_NO_NET: '1' },
      cwd: REPO, stdio: 'ignore'
    })
    rec.pid = child.pid
    cdp = await connectMain(PORT)
    await cdp.send('Runtime.enable').catch(() => {})
    await cdp.send('Page.enable').catch(() => {})
    // 심이 미구현 채널에 대해 찍는 경고를 그대로 줍는다(`[shim] app:update-… 안전값 반환`)
    cdp.listeners.push((msg) => {
      if (msg.method !== 'Runtime.consoleAPICalled') return
      const txt = (msg.params.args || []).map((a) => String(a.value ?? a.description ?? '')).join(' ')
      if (/\[shim\]|update/i.test(txt)) rec.console.push({ type: msg.params.type, txt: txt.slice(0, 200) })
    })
    // ★첫 문서가 **마운트를 끝낸 뒤에** 다시 로드한다. 초판은 기동 중(내비게이션
    //   진행 중)에 reload를 던져 웹뷰를 빈 문서에 앉혔다 — 6주행 중 4가 그 꼴이었다.
    rec.mounted1 = await waitMount(cdp, 60000)
    rec.href1 = await cdp.eval(`String(location.href)`).catch(() => null)
    if (PLANT) rec.injected = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: stubScript() }).then(() => 'ok').catch((e) => 'FAIL ' + e.message)
    // bare도 똑같이 reload — 두 팔의 유일한 차이를 스텁으로 만든다
    await cdp.send('Page.reload', {}).catch(() => {})
    rec.mounted2 = await waitMount(cdp, 45000)
    if (!rec.mounted2 && rec.href1) {
      // 빈 문서에 앉았으면 원래 URL로 직접 돌려놓고 한 번 더 기다린다(그리고 기록한다)
      rec.recovery = 'Page.navigate'
      await cdp.send('Page.navigate', { url: rec.href1 }).catch(() => {})
      rec.mounted2 = await waitMount(cdp, 45000)
    }
    await sleep(4000)
    rec.screen = JSON.parse(await cdp.eval(SNAP))
    // 마운트 실패 주행은 **표에 못 들어간다** — 조용히 0을 재는 것이 제일 나쁘다
    rec.valid = rec.mounted2 === true && rec.screen.rootKids > 0

    // ── ① 방출자가 0인가 — 원시 호출(양성·음성 대조 포함) ────────────────────
    rec.raw = {}
    for (const ch of ['app:get-version', 'app:update-status', 'app:update-check', 'app:update-event', 'ccg:no-such-channel-r5upd']) {
      rec.raw[ch] = await cdp.eval(RAW(ch), { awaitPromise: true, timeoutMs: 20000 }).catch((e) => 'THROW ' + e.message)
    }
    // 제품 경로(심을 지나는 길)
    rec.apiGetStatus = await cdp.eval(`window.api.app.getUpdateStatus().then((v) => JSON.stringify(v))`, { awaitPromise: true, timeoutMs: 20000 }).catch((e) => 'THROW ' + e.message)
    rec.apiCheck = await cdp.eval(`window.api.app.checkForUpdate().then((v) => 'resolved:' + JSON.stringify(v === undefined ? null : v)).catch((e) => 'REJECT ' + String(e))`, { awaitPromise: true, timeoutMs: 20000 }).catch((e) => 'THROW ' + e.message)

    // ── ③ 카드가 떴다면 「업데이트」를 눌러 본다(제품 경로) ────────────────────
    if (rec.screen.goBtn > 0) {
      rec.clickGo = await cdp.eval(CLICK_GO)
      await sleep(3000)
      rec.screenAfterGo = JSON.parse(await cdp.eval(SNAP))
      rec.aliveAfterGo = (() => { try { process.kill(child.pid, 0); return true } catch { return false } })()
    }

    // ── ④ 마지막에 update-install 원시 호출 — 구현돼 있으면 여기서 앱이 죽는다 ──
    rec.rawInstall = await cdp.eval(RAW('app:update-install'), { awaitPromise: true, timeoutMs: 20000 }).catch((e) => 'THROW ' + e.message)
    await sleep(3000)
    rec.aliveAfterInstall = (() => { try { process.kill(child.pid, 0); return true } catch { return false } })()
    rec.screenAfterInstall = await cdp.eval(SNAP).then(JSON.parse).catch((e) => ({ err: String(e.message) }))
  } catch (e) {
    rec.fatal = String(e.stack ?? e).slice(0, 600)
  } finally {
    try { cdp?.close() } catch { /* 닫힘 */ }
    if (child?.pid) killTree(child.pid)
    rec.portFreeMs = await waitPortFree(PORT) // 다음 주행이 죽은 문서에 붙지 않게
  }
  out.runs.push(rec)
  console.log(`[${ARM} ${i}/${RUNS}] valid=${rec.valid} upd=${rec.screen?.upd} go=${rec.screen?.goBtn} bar=${rec.screen?.bar} stub=${rec.screen?.stub ?? '-'}`)
  console.log(`    text="${rec.screen?.updText ?? ''}"`)
  console.log(`    raw: check=${rec.raw?.['app:update-check']} event=${rec.raw?.['app:update-event']} install=${rec.rawInstall} aliveAfterInstall=${rec.aliveAfterInstall}`)
  console.log(`    ctrl: status=${rec.raw?.['app:update-status']} ver=${rec.raw?.['app:get-version']} none=${rec.raw?.['ccg:no-such-channel-r5upd']}`)
  if (rec.clickGo) console.log(`    click 업데이트 → ${rec.clickGo} · after="${rec.screenAfterGo?.updText}" alive=${rec.aliveAfterGo}`)
  await sleep(1500)
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log(`\nsaved: ${OUT}`)
