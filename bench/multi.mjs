// 멀티채팅 성능 — 이 프로젝트의 **주 게이트**.
// 사용자 지적: "여러 개 켰을 때가 항상 문제". 단일 채팅은 어느 런타임이든 여유롭게
// 통과하므로 변별력이 없다. 여기서 이겨야 3.0이 이긴 것이다.
//
// 재는 것:
//  1) 패널 4개 + 추가 채팅 창 2개 유휴 메모리 (프로세스 트리 합)
//  2) 그 상태에서 패널 하나를 스크롤할 때 FPS (다른 패널이 DOM에 살아있는 채로)
//  2b) **4패널 동시 스크롤** — 부하 팔(R3 크리틱 §9-4). 한 패널 스크롤은 두 앱 다
//     p95 16.8ms로 붙어 실패 경계 근처에 가지 않는다 = 정보가 없다.
//  3) 패널 4개 동시 스트리밍 중 FPS·드랍 (--live일 때만, 실 엔진 4턴 동시)
//  4) 창을 늘릴 때 프로세스가 몇 개 늘어나는지 (WebView2 vs Chromium 창 비용)
//
// 사용: node bench/multi.mjs electron|tauri [--live] [--panels=4] [--repeats=5]
//
// ── R3 크리틱 §9-2 결함 수정 ──────────────────────────────────────────────────
// 전에는 결과를 `multi-<app>.json` **한 파일에 덮어썼다.** 팔(CCG_SINGLE_PROCESS 등)을
// 바꿔 돌리면 직전 팔이 사라지고, 빌더는 5회 결과를 손으로 `repeats` 블록에 적어 넣었다
// (= 하네스 산출물이 아니다). 이제
//   (a) 파일명·본문에 팔 이름이 들어가고(`multi-<app>-<arm>.json`),
//   (b) `--repeats=N`으로 **하네스가 직접** N회 부팅·반복하고 중앙값을 쓴다,
//   (c) 어느 exe로 쟀는지(mtime/sha/gitHead)를 파일에 박는다(§9-6).
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  electronProfile, tauriProfile, connectMainPage,
  procTreeMem, killTree, median, sleep, envInfo, provenance, armName, REPO
} from './lib.mjs'
import { makeMultiFixture } from './fixture.mjs'

const kind = process.argv[2] ?? 'electron'
const live = process.argv.includes('--live')
const panels = Number((process.argv.find((a) => a.startsWith('--panels=')) ?? '--panels=4').split('=')[1])
const repeats = Number((process.argv.find((a) => a.startsWith('--repeats=')) ?? '--repeats=1').split('=')[1])
// ★R4 — `--exe=`로 **고정된 바이너리**를 잰다. 같은 레포에서 다른 라운드가 주행 중에
// `rm -f target/release/agentcodegui.exe && npm run tauri:build`을 돌리면 exe가 사라진다
// (R3 §R3.6에서 두 번 밟았고, 이번 라운드에선 `node_modules`가 통째로 비는 것도 봤다).
const exeArg = (process.argv.find((a) => a.startsWith('--exe=')) ?? '').split('=').slice(1).join('=')
const profile = kind === 'tauri' ? tauriProfile(exeArg ? { exe: exeArg } : {}) : electronProfile({})
const appVersion = kind === 'tauri' ? '3.0.0-beta.1' : '2.6.2'
const home = profile.env.CCG_HOME
const arm = armName({ ...process.env, ...profile.env })

// ── FPS 수집기 (한 곳에만 둔다 — 문법이 갈리면 회차 비교가 무너진다) ──────────
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
    droppedFrames: f.filter((x) => x > 33).length,
    longTaskMs: Math.round(b.long) }
})()`

/** 패널 중심 좌표들. 부하 팔은 이 전부에 매 틱 휠을 뿌린다. */
const PANEL_POINTS = `(() => [...document.querySelectorAll('.ma-p-thread')].map((el) => {
  const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
}))()`

async function measureFps(cdp, points, { ms = 6000 } = {}) {
  if (!points?.length) return null
  await cdp.eval(COLLECT)
  const end = performance.now() + ms
  let dir = -140
  let flip = performance.now() + ms / 2
  while (performance.now() < end) {
    if (performance.now() > flip) { dir = 140; flip = Infinity }
    // 부하 팔: 한 틱에 모든 패널에 휠을 뿌린다(= 동시 스크롤). 단일 팔은 점이 하나.
    for (const p of points) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY: dir })
    }
    await sleep(16)
  }
  return await cdp.eval(HARVEST)
}

// ── 1회분 (부팅 → 측정 → 종료) ───────────────────────────────────────────────
async function runOnce(seq) {
  fs.rmSync(home, { recursive: true, force: true })
  const fx = makeMultiFixture(home, appVersion, { panels })
  if (seq === 0) console.log(`multi fixture: ${panels} panels x ${fx.itemsPerPanel} items @ ${home}`)

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
  console.log(`[${seq + 1}/${repeats}] multi panels rendered:`, gridPanels)
  if (!gridPanels) {
    console.error('MULTI GRID NOT RENDERED — 픽스처/부팅 모드 확인 필요')
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null)
    if (shot) fs.writeFileSync(path.join(REPO, 'bench', `diag-multi-${profile.name}.png`), Buffer.from(shot.data, 'base64'))
    cdp.close(); killTree(child.pid); process.exit(1)
  }

  const out = { seq: seq + 1, panels, itemsPerPanel: fx.itemsPerPanel, gridPanels, at: new Date().toISOString() }

  // ── 1) 멀티 그리드만 띄운 유휴 ──
  await sleep(20000)
  const memGrid = procTreeMem(child.pid)
  out.idleGrid = { totalWsMB: memGrid.totalWsMB, totalPrivMB: memGrid.totalPrivMB, procs: memGrid.procs?.length }
  console.log('  idle (grid only):', JSON.stringify(out.idleGrid))

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
  console.log('  idle (+2 session windows):', JSON.stringify(out.idleWithWindows), 'cost/window:', JSON.stringify(out.windowCost))

  // ── 3) 스크롤 FPS: 한 패널 / 4패널 동시(부하 팔) ──
  const pts = await cdp.eval(PANEL_POINTS).catch(() => null)
  if (pts?.length) {
    out.scrollInPanel = await measureFps(cdp, [pts[0]])
    console.log('  scroll in one panel (others alive):', JSON.stringify(out.scrollInPanel))
    await sleep(1500)
    out.scrollAllPanels = await measureFps(cdp, pts)
    console.log(`  scroll in ALL ${pts.length} panels (부하 팔):`, JSON.stringify(out.scrollAllPanels))
  }

  // ── 4) 패널 N개 동시 스트리밍 (--live) ──
  if (live) {
    console.log('  live streaming across panels')
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
    console.log('  panels sent:', JSON.stringify(sent))

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
      console.log('  concurrent streaming:', JSON.stringify(out.liveStream))
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
      console.log('  mem after concurrent streaming:', JSON.stringify(out.memAfterStream))
    } else {
      out.liveStream = { error: 'no panel went busy' }
    }
  }

  out.procDetail = (procTreeMem(child.pid).procs ?? []).map((p) => ({ name: p.name, wsMB: p.wsMB, privMB: p.privMB }))
  cdp.close()
  await sleep(800)
  killTree(child.pid)
  await sleep(1500)
  return out
}

// ── 실행 ─────────────────────────────────────────────────────────────────────
const runs = []
for (let i = 0; i < repeats; i++) runs.push(await runOnce(i))

const pick = (fn) => median(runs.map(fn))
const summary = {
  idleGridWsMB: pick((r) => r.idleGrid?.totalWsMB),
  idleGridPrivMB: pick((r) => r.idleGrid?.totalPrivMB),
  idleGridProcs: pick((r) => r.idleGrid?.procs),
  idleWithWindowsWsMB: pick((r) => r.idleWithWindows?.totalWsMB),
  idleWithWindowsPrivMB: pick((r) => r.idleWithWindows?.totalPrivMB),
  wsMBPerWindow: pick((r) => r.windowCost?.wsMBPerWindow),
  procsAdded: pick((r) => r.windowCost?.procsAdded),
  scrollInPanel: {
    avgFps: pick((r) => r.scrollInPanel?.avgFps),
    p95Ms: pick((r) => r.scrollInPanel?.p95Ms),
    worstDroppedPct: Math.max(...runs.map((r) => r.scrollInPanel?.droppedPct ?? 0)),
    zeroDropRuns: runs.filter((r) => (r.scrollInPanel?.droppedPct ?? 1) === 0).length
  },
  scrollAllPanels: {
    avgFps: pick((r) => r.scrollAllPanels?.avgFps),
    p95Ms: pick((r) => r.scrollAllPanels?.p95Ms),
    worstDroppedPct: Math.max(...runs.map((r) => r.scrollAllPanels?.droppedPct ?? 0)),
    zeroDropRuns: runs.filter((r) => (r.scrollAllPanels?.droppedPct ?? 1) === 0).length
  },
  runs: runs.length
}

const out = {
  app: profile.name,
  ...provenance(profile),
  panels,
  repeats,
  env: envInfo(),
  summary,
  perRun: runs,
  at: new Date().toISOString()
}
const file = path.join(REPO, 'bench', 'results', `multi-${profile.name}-${arm}.json`)
fs.writeFileSync(file, JSON.stringify(out, null, 2))
console.log('\nsummary:', JSON.stringify(summary, null, 2))
console.log('saved:', path.relative(REPO, file))
