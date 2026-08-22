// 스트리밍 중 UI 반응성 — 실제 엔진 턴(haiku·minimal·bypass, 초저비용 카운트 프롬프트)이
// 스트리밍되는 동안 프레임 간격·롱태스크를 수집한다. busy 신호 = .composer.scheduling.
// 사용: node bench/stream.mjs electron|tauri
// 요구: 실계정(accounts.json은 os.homedir 고정이라 벤치 홈에서도 공유됨) + engines 정션.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { electronProfile, tauriProfile, connectMainPage, killTree, sleep, REPO } from './lib.mjs'
import { makeFixtureHome, FIX_ID } from './fixture.mjs'

const kind = process.argv[2] ?? 'electron'
const profile = kind === 'tauri' ? tauriProfile({}) : electronProfile({})
const appVersion = kind === 'tauri' ? '3.0.0-beta.1' : '2.6.2'
const home = profile.env.CCG_HOME

// 실부하 조건: 긴 스레드(470항목) 채팅 위에서 스트리밍한다 — 빈 채팅 스트리밍은
// 어느 런타임이든 여유롭게 통과해 변별력이 없다. 픽스처 채팅을 그대로 활성으로 쓴다.
fs.rmSync(home, { recursive: true, force: true })
makeFixtureHome(home, appVersion)
void FIX_ID

const child = spawn(profile.cmd, profile.args, { env: { ...process.env, ...profile.env }, cwd: profile.cwd, stdio: 'ignore' })
const cdp = await connectMainPage(profile.port, { timeoutMs: 45000 })
for (;;) {
  if (await cdp.eval(profile.mountExpr).catch(() => false)) break
  await sleep(100)
}
await sleep(2500)

// 긴 스레드를 전량 렌더(Ctrl+F reveal)해 DOM을 무겁게 만든 뒤 스트리밍한다
await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', modifiers: 2, windowsVirtualKeyCode: 70 })
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', modifiers: 2, windowsVirtualKeyCode: 70 })
await sleep(4000)
await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await sleep(800)
const domNodes = await cdp.eval(`document.querySelectorAll('.chat--code .chat-scroll .thread > *').length`)
console.log('thread nodes under load:', domNodes)

// 컴포저에 실키 입력 경로로 프롬프트 주입 (React controlled — insertText 필수)
const focused = await cdp.eval(`(() => { const t = document.querySelector('.composer-row textarea'); if (!t) return false; t.focus(); return true })()`)
if (!focused) { console.error('composer not found'); killTree(child.pid); process.exit(1) }
await cdp.send('Input.insertText', { text: '1부터 200까지 한 줄에 하나씩, 설명 없이 숫자만 세어줘.' })
await sleep(300)

const COLLECT = `(() => {
  window.__bench = { frames: [], long: 0, stop: false }
  const b = window.__bench
  let last = performance.now()
  function loop(t) { b.frames.push(t - last); last = t; if (!b.stop) requestAnimationFrame(loop) }
  requestAnimationFrame(loop)
  try {
    b.po = new PerformanceObserver((l) => { for (const e of l.getEntries()) b.long += e.duration })
    b.po.observe({ entryTypes: ['longtask'] })
  } catch (e) { /* 미지원 */ }
  return true
})()`
await cdp.eval(COLLECT)

const sendAt = performance.now()
const sent = await cdp.eval(`(() => { const b = document.querySelector('button.send'); if (!b || b.disabled) return false; b.click(); return true })()`)
if (!sent) { console.error('send button unavailable'); killTree(child.pid); process.exit(1) }
console.log('prompt sent — waiting for turn to run…')

// busy 상승 대기(엔진 스폰 포함 최대 60s) → busy 하강 대기(최대 180s)
let up = false
for (let i = 0; i < 600; i++) {
  if (await cdp.eval(`!!document.querySelector('.composer.scheduling')`).catch(() => false)) { up = true; break }
  await sleep(100)
}
const spawnMs = Math.round(performance.now() - sendAt)
if (!up) { console.error('turn never went busy'); killTree(child.pid); process.exit(1) }
const busyStart = performance.now()
for (let i = 0; i < 1800; i++) {
  if (!(await cdp.eval(`!!document.querySelector('.composer.scheduling')`).catch(() => true))) break
  await sleep(100)
}
const busyMs = Math.round(performance.now() - busyStart)

const m = await cdp.eval(`(() => {
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
})()`)
const answerLen = await cdp.eval(`(() => { const els = document.querySelectorAll('.chat--code .msg.ai-msg'); const last = els[els.length-1]; return last ? last.textContent.length : 0 })()`)
console.log('spawn→busy:', spawnMs, 'busyMs:', busyMs, 'answerLen:', answerLen)
console.log('stream metrics:', JSON.stringify(m))

const summary = { app: profile.name, domNodes, spawnMs, busyMs, answerLen, stream: m, at: new Date().toISOString() }
fs.writeFileSync(path.join(REPO, 'bench', 'results', `stream-${profile.name}.json`), JSON.stringify(summary, null, 2))
console.log('saved:', `bench/results/stream-${profile.name}.json`)
cdp.close()
await sleep(1500)
killTree(child.pid)
