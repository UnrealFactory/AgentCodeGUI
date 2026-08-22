// 멀티채팅 성능 — 이 프로젝트의 **주 게이트**.
// 사용자 지적: "여러 개 켰을 때가 항상 문제". 단일 채팅은 어느 런타임이든 여유롭게
// 통과하므로 변별력이 없다. 여기서 이겨야 3.0이 이긴 것이다.
//
// 재는 것:
//  1) 패널 4개 + 추가 채팅 창 2개 유휴 메모리 (프로세스 트리 합)
//  2) 그 상태에서 패널 하나를 스크롤할 때 FPS (다른 패널이 DOM에 살아있는 채로)
//  3) 패널 4개 동시 스트리밍 중 FPS·드랍 (--live일 때만, 실 엔진 4턴 동시)
//  4) 창을 늘릴 때 프로세스가 몇 개 늘어나는지 (WebView2 vs Chromium 창 비용)
//
// 사용: node bench/multi.mjs electron|tauri [--live] [--panels=4]
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  electronProfile, tauriProfile, connectMainPage, cdpTargets, Cdp,
  procTreeMem, killTree, sleep, REPO
} from './lib.mjs'
import { makeMultiFixture } from './fixture.mjs'

const kind = process.argv[2] ?? 'electron'
const live = process.argv.includes('--live')
const panels = Number((process.argv.find((a) => a.startsWith('--panels=')) ?? '--panels=4').split('=')[1])
const profile = kind === 'tauri' ? tauriProfile({}) : electronProfile({})
const appVersion = kind === 'tauri' ? '3.0.0-beta.1' : '2.6.2'
const home = profile.env.CCG_HOME

fs.rmSync(home, { recursive: true, force: true })
const fx = makeMultiFixture(home, appVersion, { panels })
console.log(`multi fixture: ${panels} panels x ${fx.itemsPerPanel} items @ ${home}`)

const child = spawn(profile.cmd, profile.args, {
  env: { ...process.env, ...profile.env }, cwd: profile.cwd, stdio: 'ignore'
})
const cdp = await connectMainPage(profile.port, { timeoutMs: 45000 })
for (;;) {
  if (await cdp.eval(profile.mountExpr).catch(() => false)) break
  await sleep(100)
}
await sleep(4000)

const gridPanels = await cdp.eval(`document.querySelectorAll('.ma-p-thread').length`)
console.log('multi panels rendered:', gridPanels)
if (!gridPanels) {
  console.error('MULTI GRID NOT RENDERED — 픽스처/부팅 모드 확인 필요')
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null)
  if (shot) fs.writeFileSync(path.join(REPO, 'bench', `diag-multi-${profile.name}.png`), Buffer.from(shot.data, 'base64'))
  cdp.close(); killTree(child.pid); process.exit(1)
}

const out = { app: profile.name, panels, itemsPerPanel: fx.itemsPerPanel, gridPanels, at: new Date().toISOString() }

// ── 1) 멀티 그리드만 띄운 유휴 ──
await sleep(20000)
const memGrid = procTreeMem(child.pid)
out.idleGrid = { totalWsMB: memGrid.totalWsMB, totalPrivMB: memGrid.totalPrivMB, procs: memGrid.procs?.length }
console.log('idle (grid only):', JSON.stringify(out.idleGrid))

// ── 2) 추가 채팅 창 2개를 더 연 뒤의 유휴 (창당 비용) ──
for (let i = 0; i < 2; i++) {
  await cdp.eval(`window.api.openSessionWindow()`).catch(() => null)
  await sleep(3500)
}
await sleep(12000)
const memWins = procTreeMem(child.pid)
out.idleWithWindows = { totalWsMB: memWins.totalWsMB, totalPrivMB: memWins.totalPrivMB, procs: memWins.procs?.length }
out.windowCost = {
  wsMBPerWindow: Math.round(((memWins.totalWsMB - memGrid.totalWsMB) / 2) * 10) / 10,
  procsAdded: (memWins.procs?.length ?? 0) - (memGrid.procs?.length ?? 0)
}
console.log('idle (+2 session windows):', JSON.stringify(out.idleWithWindows), 'cost/window:', JSON.stringify(out.windowCost))

// ── 3) 패널 하나 스크롤 FPS (다른 패널들이 살아있는 채로) ──
const COLLECT = `(() => {
  window.__bench = { frames: [], long: 0, stop: false }
  const b = window.__bench
  let last = performance.now()
  function loop(t) { b.frames.push(t - last); last = t; if (!b.stop) requestAnimationFrame(loop) }
  requestAnimationFrame(loop)
  try { b.po = new PerformanceObserver((l) => { for (const e of l.getEntries()) b.long += e.duration }); b.po.observe({ entryTypes: ['longtask'] }) } catch (e) {}
  return true
})()`
const HARVEST = `(() => {
  const b = window.__bench; b.stop = true; if (b.po) b.po.disconnect()
  const f = b.frames.slice(5); if (!f.length) return null
  const s = [...f].sort((a, c) => a - c), sum = f.reduce((a, c) => a + c, 0)
  return { frames: f.length, avgFps: Math.round(1000 / (sum / f.length) * 10) / 10,
    p95Ms: Math.round(s[Math.floor(s.length * 0.95)] * 10) / 10,
    worstMs: Math.round(s[s.length - 1] * 10) / 10,
    droppedPct: Math.round(f.filter((x) => x > 33).length / f.length * 1000) / 10,
    longTaskMs: Math.round(b.long) }
})()`

const rect = await cdp.eval(`(() => { const el = document.querySelector('.ma-p-thread'); if (!el) return null
  const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)
if (rect) {
  await cdp.eval(COLLECT)
  const end = performance.now() + 6000
  while (performance.now() < end) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: rect.x, y: rect.y, deltaX: 0, deltaY: -140 })
    await sleep(16)
  }
  out.scrollInPanel = await cdp.eval(HARVEST)
  console.log('scroll in one panel (others alive):', JSON.stringify(out.scrollInPanel))
}

// ── 4) 패널 N개 동시 스트리밍 (--live) ──
if (live) {
  const prompts = await cdp.eval(`(() => {
    const areas = [...document.querySelectorAll('.ma-p-thread')].length
    return areas
  })()`)
  console.log('live streaming across panels:', prompts)
  // 각 패널의 컴포저에 프롬프트를 넣고 전송 — 패널 컴포저 셀렉터는 패널 루트 기준
  const sent = await cdp.eval(`(async () => {
    const panels = [...document.querySelectorAll('.ma-panel')]
    let n = 0
    for (const p of panels) {
      const ta = p.querySelector('textarea')
      const btn = p.querySelector('button.send')
      if (!ta || !btn) continue
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, '1부터 120까지 한 줄에 하나씩, 설명 없이 숫자만 세어줘.')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 120))
      if (!btn.disabled) { btn.click(); n++ }
      await new Promise(r => setTimeout(r, 200))
    }
    return n
  })()`, { awaitPromise: true }).catch((e) => ({ error: String(e) }))
  console.log('panels sent:', JSON.stringify(sent))

  let busy = false
  for (let i = 0; i < 600; i++) {
    busy = await cdp.eval(`document.querySelectorAll('.ma-panel .composer.scheduling').length > 0`).catch(() => false)
    if (busy) break
    await sleep(100)
  }
  if (busy) {
    await cdp.eval(COLLECT)
    const t0 = performance.now()
    for (let i = 0; i < 1800; i++) {
      const n = await cdp.eval(`document.querySelectorAll('.ma-panel .composer.scheduling').length`).catch(() => 0)
      if (!n) break
      await sleep(100)
    }
    out.liveStream = await cdp.eval(HARVEST)
    out.liveStream.busyMs = Math.round(performance.now() - t0)
    out.liveStream.panelsSent = sent
    console.log('concurrent streaming:', JSON.stringify(out.liveStream))
    // 앱 몫 / 엔진 몫 분리 — 엔진(CLI) 프로세스 비용은 두 앱이 똑같이 부담하는 외부
    // 비용이라, 총합만 보면 "절반 이하"가 구조적으로 불가능해진다. 유휴 시점의 PID
    // 집합을 기준선으로 잡고, 스트리밍 후 새로 생긴 PID를 엔진으로 분류한다.
    // (2.6.2는 엔진도 electron.exe로 뜨므로 이름으로는 못 가른다 — PID 차집합이 정답.)
    const memStream = procTreeMem(child.pid)
    const uiPids = new Set((memWins.procs ?? []).map((p) => p.pid))
    const ui = (memStream.procs ?? []).filter((p) => uiPids.has(p.pid))
    const eng = (memStream.procs ?? []).filter((p) => !uiPids.has(p.pid))
    const sum = (rows, k) => Math.round(rows.reduce((a, r) => a + r[k], 0) * 10) / 10
    out.memAfterStream = {
      totalWsMB: memStream.totalWsMB, totalPrivMB: memStream.totalPrivMB, procs: memStream.procs?.length,
      uiWsMB: sum(ui, 'wsMB'), uiPrivMB: sum(ui, 'privMB'), uiProcs: ui.length,
      engineWsMB: sum(eng, 'wsMB'), enginePrivMB: sum(eng, 'privMB'), engineProcs: eng.length
    }
    console.log('mem after concurrent streaming:', JSON.stringify(out.memAfterStream))
  } else {
    out.liveStream = { error: 'no panel went busy' }
  }
}

out.procDetail = (procTreeMem(child.pid).procs ?? []).map((p) => ({ name: p.name, wsMB: p.wsMB, privMB: p.privMB }))
fs.writeFileSync(path.join(REPO, 'bench', 'results', `multi-${profile.name}.json`), JSON.stringify(out, null, 2))
console.log('saved:', `bench/results/multi-${profile.name}.json`)
cdp.close()
await sleep(800)
killTree(child.pid)
