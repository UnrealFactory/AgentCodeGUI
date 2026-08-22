// 콜드 스타트 **분해** — 243ms가 어디로 가는지 추측 없이 나눈다.
//
//   node bench/boot.mjs tauri|electron [runs=3]
//
// 왜 필요한가: coldstart.mjs는 winMs/rootMs 두 숫자만 준다. 그 숫자를 줄이려면
//   (1) 프로세스 스폰 → 페이지 navigationStart  = 웹 런타임(WebView2/Chromium) 기동
//   (2) navigationStart → 첫 페인트(스플래시)    = HTML 파스 + 렌더 차단 자원
//   (3) 첫 페인트 → #root 마운트                 = 번들 파스/실행 + 부팅 IPC 왕복
// 셋 중 어디가 큰지 알아야 한다. (1)이 크면 플래그·프로세스 수, (2)면 렌더 차단 CSS,
// (3)이면 번들 분할·부팅 페이로드 선주입이 답이다.
//
// 측정 방법:
//  - t0 = spawn 직전 Date.now(). 페이지의 performance.timeOrigin(epoch ms)과 빼면 (1).
//  - paint 엔트리(first-paint)·navigation 엔트리로 (2).
//  - 마운트 시각은 CDP로 폴링하지 않고 **페이지 안에서** MutationObserver가 찍는다
//    (폴링 간격 25ms가 그대로 오차로 들어가는 걸 없앤다).
//  - **부팅 IPC 왕복 수**: 재로드 경로에서 window.__TAURI_INTERNALS__.invoke(및 Electron
//    ipcRenderer.invoke)를 감싸 #root 마운트 전까지의 호출을 채널별로 센다.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { electronProfile, tauriProfile, connectMainPage, killTree, median, sleep, envInfo, REPO } from './lib.mjs'
import { makeFixtureHome } from './fixture.mjs'

const kind = process.argv[2] ?? 'tauri'
const runs = Number(process.argv[3] ?? 3)
const OUT = path.join(REPO, 'bench', 'results', 'boot-breakdown.json')

// 재로드 경로에 심는 계측기 — 문서 생성 시점(document-start)에 돈다.
const PROBE = `(() => {
  window.__ccgBoot = { ipc: [], mountAt: null, t0: performance.now() }
  const B = window.__ccgBoot
  function wrap(obj, key, tag) {
    if (!obj || typeof obj[key] !== 'function') return false
    const orig = obj[key].bind(obj)
    obj[key] = function (...args) {
      if (B.mountAt == null) {
        const ch = tag === 'tauri' ? (args[1] && args[1].channel) || args[0] : args[0]
        B.ipc.push({ at: Math.round(performance.now() * 10) / 10, ch: String(ch) })
      }
      return orig(...args)
    }
    return true
  }
  // Tauri: window.__TAURI_INTERNALS__.invoke(cmd, payload)  (심은 'ipc_call' 하나만 쓴다)
  const t = window.__TAURI_INTERNALS__
  if (t) wrap(t, 'invoke', 'tauri')
  else {
    // 아직 안 섰으면 정의될 때 감싼다
    let v
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      get: () => v,
      set: (nv) => { v = nv; wrap(nv, 'invoke', 'tauri') }
    })
  }
  // Electron: preload가 세운 window.api는 contextBridge라 감쌀 수 없다 —
  // 대신 마운트 시점만 찍고 IPC 수는 tauri 쪽만 센다(비교 항목이 아니라 진단 항목).
  function markMount() {
    if (B.mountAt != null) return
    B.mountAt = Math.round(performance.now() * 10) / 10
  }
  function check() {
    const r = document.getElementById('root')
    if (r && r.children.length > 0) { markMount(); return true }
    return false
  }
  const iv = setInterval(() => { if (check()) clearInterval(iv) }, 2)
  document.addEventListener('DOMContentLoaded', check)
})()`

const READ = `(() => {
  const nav = performance.getEntriesByType('navigation')[0]
  const paints = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime * 10) / 10]))
  const res = performance.getEntriesByType('resource')
    .map((r) => ({ n: r.name.split('/').pop(), start: Math.round(r.startTime * 10) / 10, dur: Math.round(r.duration * 10) / 10, size: r.encodedBodySize }))
    .sort((a, b) => b.dur - a.dur).slice(0, 10)
  const B = window.__ccgBoot || null
  return {
    timeOrigin: Math.round(performance.timeOrigin),
    nav: nav ? {
      responseEnd: Math.round(nav.responseEnd * 10) / 10,
      domInteractive: Math.round(nav.domInteractive * 10) / 10,
      domContentLoaded: Math.round(nav.domContentLoadedEventEnd * 10) / 10,
      loadEnd: Math.round(nav.loadEventEnd * 10) / 10
    } : null,
    paints,
    splashPaint: window.__ccgSplashPaintAt ?? null,
    boot: B ? { mountAt: B.mountAt, ipc: B.ipc } : null,
    res
  }
})()`

async function once(profile) {
  const t0 = Date.now()
  const child = spawn(profile.cmd, profile.args, {
    env: { ...process.env, ...profile.env }, cwd: profile.cwd, stdio: 'ignore'
  })
  const row = {}
  try {
    const cdp = await connectMainPage(profile.port, { timeoutMs: 45000 })
    for (;;) {
      if (await cdp.eval(profile.mountExpr).catch(() => false)) break
      await sleep(20)
    }
    row.first = await cdp.eval(READ)
    row.first.spawnToTimeOrigin = row.first.timeOrigin - t0

    // ── 재로드 경로: 계측기를 심고 다시 로드 (웹 런타임 기동 비용이 빠진 순수 페이지 비용) ──
    await cdp.send('Page.enable').catch(() => {})
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE })
    await cdp.send('Page.reload', { ignoreCache: false })
    await sleep(300)
    for (let i = 0; i < 600; i++) {
      const done = await cdp.eval(`!!(window.__ccgBoot && window.__ccgBoot.mountAt != null)`).catch(() => false)
      if (done) break
      await sleep(20)
    }
    row.reload = await cdp.eval(READ)
    cdp.close()
  } catch (err) {
    row.error = String(err?.message ?? err)
  }
  killTree(child.pid)
  await sleep(1200)
  return row
}

const profile = kind === 'tauri' ? tauriProfile({ port: 9371 }) : electronProfile({ port: 9372 })
// 콜드 스타트 계열은 pair.mjs와 같은 시드(단일 채팅 픽스처)에서 잰다 — 홈에 멀티
// 그리드가 남아 있으면 부팅이 하는 일이 달라져 비교가 무너진다.
fs.rmSync(profile.env.CCG_HOME, { recursive: true, force: true })
makeFixtureHome(profile.env.CCG_HOME, kind === 'tauri' ? '3.0.0-beta.1' : '2.6.2')

const rows = []
for (let i = 0; i < runs + 1; i++) {
  const r = await once(profile)
  if (i === 0) { console.log('warmup:', JSON.stringify(r.first?.spawnToTimeOrigin)); continue }
  rows.push(r)
  console.log(`run ${i}/${runs}: spawn→timeOrigin=${r.first?.spawnToTimeOrigin}ms  fp=${r.first?.paints?.['first-paint']}  splash=${r.first?.splashPaint}  reloadMount=${r.reload?.boot?.mountAt}  bootIpc=${r.reload?.boot?.ipc?.length}`)
}

const summary = {
  app: profile.name,
  spawnToTimeOriginMs: median(rows.map((r) => r.first?.spawnToTimeOrigin)),
  firstPaintMs: median(rows.map((r) => r.first?.paints?.['first-paint'])),
  splashPaintMs: median(rows.map((r) => r.first?.splashPaint)),
  domInteractiveMs: median(rows.map((r) => r.first?.nav?.domInteractive)),
  reloadMountMs: median(rows.map((r) => r.reload?.boot?.mountAt)),
  bootIpcCalls: rows.at(-1)?.reload?.boot?.ipc ?? null,
  runs: rows,
  at: new Date().toISOString()
}
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {}
prev.env ??= envInfo()
prev[profile.name] = summary
fs.writeFileSync(OUT, JSON.stringify(prev, null, 2))
console.log(JSON.stringify({ ...summary, runs: undefined }, null, 2))
console.log('saved:', OUT)
