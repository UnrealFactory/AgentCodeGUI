// R4 크리틱 — `paintMs 0.45`가 같은 사건을 비교하는지 검증한다.
//
//   node docs/critic/tools/critic-r4-paint.mjs [runs=4]
//
// R4 §4는 winMs 비교가 무효(서로 다른 창)라고 바로잡았지만, 그 자리에 세운 paintMs는
// 검증하지 않았다. 두 앱 **모두** 스플래시가 있다:
//   2.6.2 : 별도 300x240 BrowserWindow, `data:text/html…` (src/main/index.ts:268)
//   3.0   : 메인 창 **안**의 오버레이, 셸이 initialization_script로 주입(src-tauri/src/splash.js)
// bench/lib.mjs의 connectMainPage는 `data:`를 **제외**한다 → Electron의 paintMs는
// 스플래시가 아니라 **메인 창**의 첫 픽셀이고, Tauri의 paintMs는 **스플래시 오버레이**의
// 첫 픽셀이다. 그러면 0.45는 "3.0 스플래시 vs 2.6.2 본 UI"를 나눈 값이 된다.
//
// 그래서 여기서는 **모든 페이지 타깃**의 first-paint를 스폰 기준 epoch로 환산해
// 어느 픽셀이 언제 떴는지 전부 남긴다. 산출: bench/results/critic-r4-paint.json
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { electronProfile, tauriProfile, cdpTargets, Cdp, killTree, median, sleep, binInfo, envInfo, REPO } from '../../../bench/lib.mjs'
import { makeFixtureHome } from '../../../bench/fixture.mjs'

const runs = Number(process.argv[2] ?? 4)
const OUT = path.join(REPO, 'bench', 'results', 'critic-r4-paint.json')

const PROBE = `(() => {
  const ps = performance.getEntriesByType('paint').map((p) => ({ name: p.name, startTime: Math.round(p.startTime * 10) / 10 }))
  return {
    href: location.href.slice(0, 90),
    timeOrigin: performance.timeOrigin,
    paints: ps,
    splashMark: window.__ccgSplashPaintAt ?? null,
    rootKids: (document.getElementById('root') || { children: [] }).children.length,
    visState: document.visibilityState
  }
})()`

/** 한 번 부팅하고 **모든** 페이지 타깃의 첫 픽셀 시각을 스폰 기준으로 환산한다. */
async function probe(profile, { watchMs = 12000 } = {}) {
  const t0 = performance.now()
  const child = spawn(profile.cmd, profile.args, { env: { ...process.env, ...profile.env }, cwd: profile.cwd, stdio: 'ignore' })
  const spawnEpoch = Date.now() - Math.round(performance.now() - t0)
  const seen = new Map() // url → { firstSeenMs, paintMs, rootMs, … }
  const deadline = Date.now() + watchMs
  while (Date.now() < deadline) {
    let targets = []
    try { targets = (await cdpTargets(profile.port)).filter((t) => t.type === 'page') } catch { /* 아직 */ }
    for (const t of targets) {
      const key = String(t.url).slice(0, 90)
      if (/toast|tray/.test(key)) continue
      const rec = seen.get(key) ?? { url: key, firstSeenMs: Date.now() - spawnEpoch, paintMs: null, rootMs: null, splashMarkMs: null }
      seen.set(key, rec)
      if (rec.paintMs != null && rec.rootMs != null) continue
      try {
        const c = await Cdp.connect(t.webSocketDebuggerUrl, { timeoutMs: 1200 })
        const info = await c.eval(PROBE, { timeoutMs: 1200 })
        c.close()
        if (info) {
          rec.visState = info.visState
          const fp = info.paints.find((p) => p.name === 'first-paint') ?? info.paints[0]
          if (fp && rec.paintMs == null) rec.paintMs = Math.round(info.timeOrigin + fp.startTime - spawnEpoch)
          if (info.splashMark && rec.splashMarkMs == null) rec.splashMarkMs = Math.round(info.timeOrigin + info.splashMark - spawnEpoch)
          if (info.rootKids > 0 && rec.rootMs == null) rec.rootMs = Date.now() - spawnEpoch
          rec.timeOriginMs = Math.round(info.timeOrigin - spawnEpoch)
        }
      } catch { /* 타깃이 사라졌거나 아직 */ }
    }
    // 메인 페이지가 마운트되고 스플래시가 사라졌으면 그만
    const main = [...seen.values()].find((r) => /index\.html/.test(r.url) && !/#session/.test(r.url))
    if (main?.rootMs != null && Date.now() - spawnEpoch > 3000) break
    await sleep(120)
  }
  killTree(child.pid)
  await sleep(1200)
  return [...seen.values()]
}

const out = { what: 'paintMs가 두 앱에서 같은 사건인가 — 모든 페이지 타깃의 첫 픽셀', runs, env: envInfo(), at: new Date().toISOString(), apps: {} }

for (const kind of ['electron', 'tauri']) {
  const profile = kind === 'tauri' ? tauriProfile({ port: 9481 }) : electronProfile({ port: 9482 })
  fs.rmSync(profile.env.CCG_HOME, { recursive: true, force: true })
  makeFixtureHome(profile.env.CCG_HOME, kind === 'tauri' ? '3.0.0-beta.1' : '2.6.2')
  const all = []
  for (let i = 0; i < runs; i++) {
    const rows = await probe(profile)
    all.push(rows)
    console.log(`${kind} run ${i + 1}: ` + rows.map((r) => `${/^data:/.test(r.url) ? 'SPLASH(data:)' : r.url.split('/').pop() || 'main'} seen=${r.firstSeenMs} paint=${r.paintMs} root=${r.rootMs}${r.splashMarkMs != null ? ' splashMark=' + r.splashMarkMs : ''}`).join(' | '))
    await sleep(1500)
  }
  const rest = all.slice(1) // 첫 회는 웜업
  const pick = (fn) => median(rest.map((rows) => fn(rows)).filter((v) => v != null))
  const splashRow = (rows) => rows.find((r) => /^data:/.test(r.url))
  const mainRow = (rows) => rows.find((r) => /index\.html|localhost/.test(r.url) && !/#session/.test(r.url))
  out.apps[profile.name] = {
    bin: binInfo(profile.cmd),
    perRun: all,
    splashTargetPaintMs: pick((rows) => splashRow(rows)?.paintMs ?? null),
    splashTargetSeenMs: pick((rows) => splashRow(rows)?.firstSeenMs ?? null),
    mainTargetPaintMs: pick((rows) => mainRow(rows)?.paintMs ?? null),
    mainTargetRootMs: pick((rows) => mainRow(rows)?.rootMs ?? null),
    inWindowSplashMarkMs: pick((rows) => mainRow(rows)?.splashMarkMs ?? null)
  }
}

const e = out.apps['electron-2.6.2']
const t = out.apps['tauri-3.0.0']
const r = (a, b) => (a != null && b ? Math.round((a / b) * 100) / 100 : null)
out.verdict = {
  '3.0 첫 픽셀(스플래시 오버레이)': t?.mainTargetPaintMs,
  '2.6.2 첫 픽셀(스플래시 창)': e?.splashTargetPaintMs,
  '2.6.2 본 UI 첫 픽셀(메인 창)': e?.mainTargetPaintMs,
  '보고서가 쓴 비 (3.0 스플래시 ÷ 2.6.2 본 UI)': r(t?.mainTargetPaintMs, e?.mainTargetPaintMs),
  '대칭 비 — 첫 픽셀 ÷ 첫 픽셀': r(t?.mainTargetPaintMs, e?.splashTargetPaintMs),
  '대칭 비 — 본 UI ÷ 본 UI (rootMs)': r(t?.mainTargetRootMs, e?.mainTargetRootMs)
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log('\n' + JSON.stringify(out.verdict, null, 2))
console.log('saved:', path.relative(REPO, OUT))
process.exit(0)
