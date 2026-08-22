// 긴 스레드 스크롤 성능 — 두 국면을 잰다:
//  A) 바닥에서 실휠 업-스윕 6초 (윈도잉 확장 churn 포함 — 실제 UX 경로)
//  B) Ctrl+F reveal(전량 렌더) 후 다운+업 스윕 6초 (순수 렌더 스크롤)
// 사용: node bench/scroll.mjs electron|tauri
// 매 실행: 벤치 홈을 지우고 픽스처 재생성 → 부팅 → 측정 → 종료 (재현성)
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { electronProfile, tauriProfile, connectMainPage, killTree, sleep, REPO } from './lib.mjs'
import { makeFixtureHome } from './fixture.mjs'

const kind = process.argv[2] ?? 'electron'
const profile = kind === 'tauri' ? tauriProfile({}) : electronProfile({})
const appVersion = kind === 'tauri' ? '3.0.0-beta.1' : '2.6.2'
const home = profile.env.CCG_HOME

fs.rmSync(home, { recursive: true, force: true })
const fx = makeFixtureHome(home, appVersion)
console.log(`fixture: ${fx.items} items @ ${home}`)

const child = spawn(profile.cmd, profile.args, { env: { ...process.env, ...profile.env }, cwd: profile.cwd, stdio: 'ignore' })
const cdp = await connectMainPage(profile.port, { timeoutMs: 45000 })
for (;;) {
  if (await cdp.eval(profile.mountExpr).catch(() => false)) break
  await sleep(100)
}
await sleep(3000)

const threadCount = await cdp.eval(`document.querySelectorAll('.chat--code .chat-scroll .thread > *').length`)
console.log('DOM thread nodes (windowed):', threadCount)
if (!threadCount || threadCount < 30) {
  console.error('FIXTURE NOT RENDERED — abort')
  killTree(child.pid)
  process.exit(1)
}

const rect = await cdp.eval(`(() => { const el = document.querySelector('.chat--code .chat-scroll'); const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) } })()`)

// rAF + longtask 수집기 — 측정 창 동안 프레임 간격 히스토그램
const COLLECT = `(() => {
  window.__bench = { frames: [], long: 0, stop: false }
  const b = window.__bench
  let last = performance.now()
  function loop(t) { b.frames.push(t - last); last = t; if (!b.stop) requestAnimationFrame(loop) }
  requestAnimationFrame(loop)
  try {
    b.po = new PerformanceObserver((l) => { for (const e of l.getEntries()) b.long += e.duration })
    b.po.observe({ entryTypes: ['longtask'] })
  } catch (e) { /* longtask 미지원 */ }
  return true
})()`
const HARVEST = `(() => {
  const b = window.__bench; b.stop = true; if (b.po) b.po.disconnect()
  const f = b.frames.slice(5)
  if (!f.length) return null
  const sorted = [...f].sort((a, c) => a - c)
  const sum = f.reduce((a, c) => a + c, 0)
  return {
    frames: f.length,
    avgFps: Math.round(1000 / (sum / f.length) * 10) / 10,
    p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10,
    worstMs: Math.round(sorted[sorted.length - 1] * 10) / 10,
    droppedPct: Math.round(f.filter((x) => x > 33).length / f.length * 1000) / 10,
    longTaskMs: Math.round(b.long)
  }
})()`

async function wheelSweep(ms, deltaY) {
  const end = performance.now() + ms
  while (performance.now() < end) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: rect.x, y: rect.y, deltaX: 0, deltaY })
    await sleep(16)
  }
}

// ── A) 윈도잉 포함 업-스윕 ──
await cdp.eval(COLLECT)
await wheelSweep(6000, -140)
const a = await cdp.eval(HARVEST)
console.log('A (windowed up-sweep):', JSON.stringify(a))

// ── B) 전량 렌더 후 스윕 ──
await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', modifiers: 2, windowsVirtualKeyCode: 70 })
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', modifiers: 2, windowsVirtualKeyCode: 70 })
await sleep(4000) // 전량 렌더 + remark 파싱 안정화
const fullCount = await cdp.eval(`document.querySelectorAll('.chat--code .chat-scroll .thread > *').length`)
console.log('DOM thread nodes (revealed):', fullCount)
await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await sleep(500)
await cdp.eval(COLLECT)
await wheelSweep(3000, 160)
await wheelSweep(3000, -160)
const b = await cdp.eval(HARVEST)
console.log('B (full-render sweep):', JSON.stringify(b))

const summary = { app: profile.name, items: fx.items, windowedNodes: threadCount, revealedNodes: fullCount, sweepWindowed: a, sweepFull: b, at: new Date().toISOString() }
fs.writeFileSync(path.join(REPO, 'bench', 'results', `scroll-${profile.name}.json`), JSON.stringify(summary, null, 2))
console.log('saved:', `bench/results/scroll-${profile.name}.json`)
cdp.close()
killTree(child.pid)
