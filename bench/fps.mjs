// 프레임 **타임** 눈금 — 「60fps·드랍 0%」로는 144Hz를 판정할 수 없다.
//
//   node bench/fps.mjs electron|tauri [--mode=multi|scroll] [--tag=fps144] [--out=NAME]
//        [--port=N] [--exe=PATH] [--cwd=DIR] [--repeats=N] [--live] [--novsync] [--trace]
//
// ── 왜 새 눈금인가 ────────────────────────────────────────────────────────────
// 기존 하네스(multi.mjs·scroll.mjs·stream.mjs·fpsab.mjs)의 `p95Ms`는 **rAF 콜백이
// 불린 시각의 간격**이다. 그 간격은 vsync가 정한다 — 60Hz 모니터에서 앱이 1ms를 쓰든
// 15ms를 쓰든 간격은 똑같이 16.6ms로 찍힌다. 그래서 두 앱이 나란히 "p95 16.8ms"였고,
// 그 숫자는 **앱에 대해 아무 말도 하지 않았다**(모니터에 대해 말했을 뿐이다).
// 144Hz의 프레임 예산은 6.9ms다. 간격 눈금으로는 6.9ms 초과를 셀 수 없다.
//
// ── 무엇을 재는가: 프레임 **작업 시간** ───────────────────────────────────────
// Chromium/WebView2의 한 프레임은 `BeginMainFrame` **한 개의 태스크**다:
//     rAF 콜백들 → 스타일 → 레이아웃 → 페인트 → 커밋
// 이 태스크가 끝나야 다음 태스크가 돈다. 그래서 rAF 콜백 **안에서** MessageChannel로
// 메시지를 쏘면 그 메시지 태스크는 **커밋이 끝난 뒤**에야 실행된다(태스크는 서로를
// 선점하지 못한다). 두 시각의 차이가 곧 그 프레임의 **메인 스레드 작업 시간**이고,
// 여기엔 vsync 대기가 **들어가지 않는다**. 60Hz 기계에서도 6.9ms 예산을 판정할 수 있다.
//
//   raf(ts)  ── t0 = now()  ─┐
//                            │  (남은 rAF 콜백 + 스타일 + 레이아웃 + 페인트 + 커밋)
//   port1.onmessage ── t1 = now()
//   work = t1 - t0
//
// ── 한계(보고서에 그대로 옮길 것) ─────────────────────────────────────────────
//  (1) 우리 rAF 콜백이 그 프레임의 **몇 번째**로 불리는지는 우리가 못 정한다. 앱이 나중에
//      등록한 rAF는 창 안에 들어오고, 먼저 등록된 것은 t0 앞에 있어 빠진다. 즉 work는
//      프레임 작업의 **하한**이다(과대평가가 아니라 과소평가 쪽으로 틀린다).
//  (2) 커밋 직후 메시지 태스크 앞에 다른 태스크(입력·IPC·타이머)가 끼면 그만큼 얹힌다.
//      그 시간도 같은 6.9ms 예산을 먹는 메인 스레드 작업이라 섞여 있어도 해석은 같다.
//  (3) 컴포지터 스레드/GPU 프로세스의 작업은 안 보인다. 메인 스레드 눈금이다.
//  (4) `--trace`(CDP Tracing)는 (1)(2)에 안 걸리는 **독립 대조**다 — 렌더러 메인 스레드의
//      `RunTask` 실측 길이. 다만 트레이싱 자체가 비용이라 기본은 끔이고, p95 비교용으로만.
//  (5) `--novsync`(측정 전용 팔)는 `--disable-gpu-vsync --disable-frame-rate-limit`로
//      프레임 상한을 풀어 **도달 fps**를 참고로 뽑는다. 3.0은 `CCG_WEBVIEW_ARGS_EXTRA`
//      (제품이 이미 가진 env 옵트인)로만 준다 — tauri.conf/제품 기본값은 건드리지 않는다.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  electronProfile, tauriProfile, connectMainPage, killTree, median, sleep, envInfo, provenance, armName, REPO
} from './lib.mjs'
import { makeFixtureHome, makeMultiFixture, plantAccountDirs } from './fixture.mjs'
import {
  COLLECT, HARVEST, cpuMark, cpuSince, wheelSweep, traceStart, traceEnd, analyzeTrace, BUDGET_MS
} from './ftgauge.mjs'

const kind = process.argv[2] ?? 'electron'
const argv = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=')
const has = (k) => process.argv.includes(`--${k}`)

const MODE = argv('mode', 'multi')            // multi = 4패널 · scroll = 긴 스레드 단일 채팅
const TAG = argv('tag', 'fps144')
const OUT_NAME = argv('out', '')
const PORT = Number(argv('port', kind === 'tauri' ? 11104 : 11103))
const EXE = argv('exe', '')
const CWD = argv('cwd', '')
const REPEATS = Number(argv('repeats', 1))
const PANELS = Number(argv('panels', 4))
const DUR = Number(argv('ms', 6000))
const LIVE = has('live')
const NOVSYNC = has('novsync')
const TRACE = has('trace')
// ★R2 — 격리 홈에 계정 설정 폴더를 심어 **실엔진 턴이 로그인 상태를 잇게** 한다.
// 기본 끔(기존 하네스의 홈 구성 불변). 이유는 fixture.mjs의 plantAccountDirs 머리말.
const ACCT = has('acct')

// 측정 전용 플래그. **제품 기본값을 바꾸지 않는다** — 3.0은 이미 있는 env 옵트인으로,
// 2.6.2는 커맨드라인 인자로만 준다(그쪽 트리는 읽기·실행만).
const NOVSYNC_SWITCHES = '--disable-gpu-vsync --disable-frame-rate-limit'

const profile = kind === 'tauri'
  ? tauriProfile({ ...(EXE ? { exe: EXE } : {}), port: PORT, extraEnv: NOVSYNC ? { CCG_WEBVIEW_ARGS_EXTRA: NOVSYNC_SWITCHES } : {} })
  : electronProfile({ port: PORT })
if (kind !== 'tauri' && NOVSYNC) profile.args = [...profile.args, ...NOVSYNC_SWITCHES.split(' ')]
profile.env.CCG_HOME += '-' + TAG + '-' + MODE + (NOVSYNC ? '-novsync' : '')
if (CWD) profile.cwd = path.resolve(CWD)
const appVersion = kind === 'tauri' ? '3.0.0-beta.1' : '2.6.2'
const home = profile.env.CCG_HOME
const arm = armName({ ...process.env, ...profile.env })

// ── 계측부는 bench/ftgauge.mjs 한 곳에 둔다 ─────────────────────────────────
// 같은 문법을 poc(scripts/poc-fps144-css.mjs)도 쓴다. 복붙해 두면 한쪽만 고쳐져
// 회차 비교가 조용히 어긋난다 — 기존 FPS 수집기가 네 파일에 복사돼 있던 그 실수다.

async function measure(cdp, name, drive, { trace = TRACE } = {}) {
  await cdp.eval(COLLECT)
  const cpu0 = cpuMark()
  const th = trace ? await traceStart(cdp).catch(() => null) : null
  await drive()
  const sysCpuPct = cpuSince(cpu0)
  const m = await cdp.eval(HARVEST)
  if (m) m.sysCpuPct = sysCpuPct
  if (th) {
    try { m.trace = analyzeTrace(await traceEnd(cdp, th)) } catch (e) { m.trace = { err: String(e?.message ?? e) } }
  }
  if (m) {
    console.log(`  ${name}: work p50=${m.workP50} p95=${m.workP95} max=${m.workMax}ms · >6.9ms ${m.over69Pct}% · rAF p95=${m.rafP95}ms ${m.avgFps}fps drop=${m.droppedPct}% · sysCpu=${m.sysCpuPct}%` +
      (m.trace?.taskP95Ms != null ? ` · trace task p95=${m.trace.taskP95Ms}ms` : ''))
  } else {
    console.log(`  ${name}: (수집 실패)`)
  }
  return m
}

// ── 1회분 ────────────────────────────────────────────────────────────────────
async function runOnce(seq) {
  fs.rmSync(home, { recursive: true, force: true })
  const fx = MODE === 'scroll'
    ? makeFixtureHome(home, appVersion)
    : makeMultiFixture(home, appVersion, { panels: PANELS })
  if (ACCT) { const r = plantAccountDirs(home); if (seq === 0) console.log('계정 설정 폴더 이식:', JSON.stringify(r)) }
  if (seq === 0) console.log(`fixture(${MODE}): ${JSON.stringify(fx)} @ ${home}`)

  const child = spawn(profile.cmd, profile.args, {
    env: { ...process.env, ...profile.env }, cwd: profile.cwd, stdio: 'ignore'
  })
  const out = { seq: seq + 1, at: new Date().toISOString() }
  let cdp = null
  try {
    cdp = await connectMainPage(profile.port, { timeoutMs: 45000 })
    for (;;) {
      if (await cdp.eval(profile.mountExpr).catch(() => false)) break
      await sleep(100)
    }
    await sleep(5000)
    out.refreshRateHz = await cdp.eval(`(() => new Promise((res) => {
      let n = 0, t0 = 0
      const f = (t) => { if (!n++) { t0 = t; requestAnimationFrame(f); return }
        if (n < 40) return requestAnimationFrame(f)
        res(Math.round(1000 / ((t - t0) / (n - 1)) * 10) / 10) }
      requestAnimationFrame(f)
    }))()`, { awaitPromise: true }).catch(() => null)

    if (MODE === 'scroll') {
      const nodes = await cdp.eval(`document.querySelectorAll('.chat--code .chat-scroll .thread > *').length`)
      out.threadNodes = nodes
      console.log(`[${seq + 1}/${REPEATS}] thread nodes (windowed): ${nodes} · refresh ${out.refreshRateHz}Hz`)
      if (!nodes) throw new Error('단일 채팅 스레드가 안 그려졌다')
      const rect = await cdp.eval(`(() => { const el = document.querySelector('.chat--code .chat-scroll'); const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) } })()`)
      out.threadWindowed = await measure(cdp, 'thread up-sweep (윈도잉 churn)', () => wheelSweep(cdp, [rect], DUR))
      await sleep(1500)
      // Ctrl+F reveal → 전량 렌더 (윈도잉 규약: reveal이 창을 걷어낸다)
      for (const type of ['keyDown', 'keyUp']) {
        await cdp.send('Input.dispatchKeyEvent', { type, key: 'f', code: 'KeyF', modifiers: 2, windowsVirtualKeyCode: 70 })
      }
      await sleep(4500)
      out.revealedNodes = await cdp.eval(`document.querySelectorAll('.chat--code .chat-scroll .thread > *').length`)
      for (const type of ['keyDown', 'keyUp']) {
        await cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      }
      await sleep(800)
      console.log(`  thread nodes (revealed): ${out.revealedNodes}`)
      out.threadRevealed = await measure(cdp, 'thread full-render sweep', async () => {
        await wheelSweep(cdp, [rect], DUR / 2, { period: 16 })
        await wheelSweep(cdp, [rect], DUR / 2, { period: 16 })
      })
    } else {
      const grid = await cdp.eval(`document.querySelectorAll('.ma-p-thread').length`)
      out.gridPanels = grid
      console.log(`[${seq + 1}/${REPEATS}] multi panels: ${grid} · refresh ${out.refreshRateHz}Hz`)
      if (!grid) throw new Error('멀티 그리드가 안 그려졌다')
      const pts = await cdp.eval(`(() => [...document.querySelectorAll('.ma-p-thread')].map((el) => {
        const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) } }))()`)
      out.scrollOnePanel = await measure(cdp, 'scroll 1 panel', () => wheelSweep(cdp, [pts[0]], DUR))
      await sleep(1500)
      out.scrollAllPanels = await measure(cdp, `scroll ALL ${pts.length} panels (부하)`, () => wheelSweep(cdp, pts, DUR))

      if (LIVE) {
        await sleep(1500)
        const sent = await cdp.eval(`(async () => {
          const panels = [...document.querySelectorAll('.ma-panel')]
          let n = 0
          for (const p of panels) {
            const ta = p.querySelector('textarea'); const btn = p.querySelector('button.send')
            if (!ta || !btn) continue
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
            setter.call(ta, '1부터 200까지 한 줄에 하나씩, 설명 없이 숫자만 세어줘.')
            ta.dispatchEvent(new Event('input', { bubbles: true }))
            await new Promise(r => setTimeout(r, 120))
            if (!btn.disabled) { btn.click(); n++ }
            await new Promise(r => setTimeout(r, 200))
          }
          return n
        })()`, { awaitPromise: true }).catch((e) => ({ error: String(e) }))
        out.panelsSent = sent
        let busy = false
        for (let i = 0; i < 900; i++) {
          busy = await cdp.eval(`document.querySelectorAll('.ma-panel .composer.scheduling').length > 0`).catch(() => false)
          if (busy) break
          await sleep(100)
        }
        if (!busy) {
          out.streamLive = { error: 'no panel went busy' }
        } else {
          // ★ busy 폴링은 **측정 창 안의 메인 스레드 작업**이다(Runtime.evaluate 하나가
          //   태스크 하나). 300ms로 늦춰 눈금에 섞이는 몫을 줄인다. 폴 횟수를 남긴다.
          let polls = 0
          const t0 = performance.now()
          out.streamLive = await measure(cdp, `stream ${PANELS} panels 동시`, async () => {
            for (let i = 0; i < 900; i++) {
              polls++
              const n = await cdp.eval(`document.querySelectorAll('.ma-panel .composer.scheduling').length`).catch(() => 0)
              if (!n) break
              await sleep(300)
            }
          })
          if (out.streamLive) { out.streamLive.busyMs = Math.round(performance.now() - t0); out.streamLive.polls = polls }
          // ★ 답변 **내용 증인** (FPS144 R2 — 크리틱 §11의 「이 결함을 두 번 못 겪게 하는
          //   유일한 못」). R1의 라이브 팔은 프레임 수와 busy 지속만 남겨서, 3.0이 40자짜리
          //   `Not logged in` 오류 말풍선 한 장을 재고 있는데도 표가 정상으로 보였다
          //   (프레임 15장 · busy 314ms). 답변 길이와 꼬리를 같이 남기면 그 자리에서 걸린다.
          //   판정 규칙: `answerChars`가 수백 자 미만이거나 `answerTail`이 오류 문구면
          //   그 행은 **스트리밍을 잰 행이 아니다.**
          const wit = await cdp.eval(`(() => {
            const panels = [...document.querySelectorAll('.ma-panel')]
            const rows = panels.map((p) => {
              const ms = p.querySelectorAll('.ma-p-thread .msg')
              const last = ms[ms.length - 1]
              return { chars: last ? last.textContent.length : 0, tail: last ? last.textContent.slice(-60) : null }
            })
            return { perPanel: rows, total: rows.reduce((a, r) => a + r.chars, 0) }
          })()`).catch(() => null)
          if (out.streamLive && wit) {
            out.streamLive.answerChars = wit.total
            out.streamLive.answerPerPanel = wit.perPanel.map((r) => r.chars)
            out.streamLive.answerTail = wit.perPanel[0]?.tail ?? null
            out.streamLive.looksLikeStreaming = wit.total >= 400 && !/not logged in|please run \/login/i.test(wit.perPanel.map((r) => r.tail ?? '').join(' '))
          }
          console.log(`    답변 증인: ${out.streamLive?.answerChars}자 ${JSON.stringify(out.streamLive?.answerPerPanel)} streaming=${out.streamLive?.looksLikeStreaming} tail=${JSON.stringify(String(out.streamLive?.answerTail).slice(-40))}`)
        }
      }
    }
  } catch (e) {
    out.error = String(e?.message ?? e)
    console.error('  ! 주행 실패:', out.error)
  } finally {
    try { cdp?.close() } catch { /* 이미 닫힘 */ }
    await sleep(600)
    killTree(child.pid)
    await sleep(1500)
  }
  return out
}

// ── 실행 ─────────────────────────────────────────────────────────────────────
const runs = []
for (let i = 0; i < REPEATS; i++) runs.push(await runOnce(i))

const KEYS = MODE === 'scroll'
  ? ['threadWindowed', 'threadRevealed']
  : ['scrollOnePanel', 'scrollAllPanels', ...(LIVE ? ['streamLive'] : [])]
const summary = {}
for (const k of KEYS) {
  const rows = runs.map((r) => r[k]).filter((x) => x && !x.error)
  if (!rows.length) { summary[k] = { runs: 0 }; continue }
  const m = (f) => median(rows.map(f))
  summary[k] = {
    runs: rows.length,
    workP50: m((r) => r.workP50), workP95: m((r) => r.workP95), workP99: m((r) => r.workP99),
    workMaxWorst: Math.max(...rows.map((r) => r.workMax ?? 0)),
    over69Pct: m((r) => r.over69Pct), over69PctWorst: Math.max(...rows.map((r) => r.over69Pct ?? 0)),
    over166Pct: m((r) => r.over166Pct),
    // 60Hz 무후퇴 열 — 기존 게이트와 같은 자
    avgFps: m((r) => r.avgFps), rafP95Ms: m((r) => r.rafP95),
    worstDroppedPct: Math.max(...rows.map((r) => r.droppedPct ?? 0)),
    zeroDropRuns: rows.filter((r) => (r.droppedPct ?? 1) === 0).length,
    // ★ 오염 증인 — 이 칸이 팔끼리 크게 다르면 위 숫자는 코드가 아니라 기계를 잰 것이다
    sysCpuPct: m((r) => r.sysCpuPct), sysCpuPctWorst: Math.max(...rows.map((r) => r.sysCpuPct ?? 0)),
    ...(rows.some((r) => r.trace?.taskP95Ms != null)
      ? { traceTaskP95Ms: m((r) => r.trace?.taskP95Ms), traceTaskOver69Pct: m((r) => r.trace?.taskOver69Pct) }
      : {})
  }
}

const out = {
  what: '프레임 타임(작업 시간) 눈금 — 144Hz 예산 6.9ms 기준. rAF 간격이 아니라 BeginMainFrame 작업 시간.',
  app: profile.name, mode: MODE, panels: MODE === 'multi' ? PANELS : null,
  budgetMs: BUDGET_MS, live: LIVE, acctPlanted: ACCT, novsync: NOVSYNC, trace: TRACE,
  novsyncSwitches: NOVSYNC ? NOVSYNC_SWITCHES : null,
  ...provenance(profile),
  launchCwd: profile.cwd,
  refreshRateHz: runs.map((r) => r.refreshRateHz).find((x) => x != null) ?? null,
  repeats: REPEATS, durMs: DUR,
  env: envInfo(),
  summary, perRun: runs,
  at: new Date().toISOString()
}
const file = path.join(REPO, 'bench', 'results',
  OUT_NAME || `fps-${profile.name}-${MODE}-${arm}${NOVSYNC ? '-novsync' : ''}-${TAG}.json`)
fs.writeFileSync(file, JSON.stringify(out, null, 2))
console.log('\nsummary:', JSON.stringify(summary, null, 2))
console.log('saved:', path.relative(REPO, file))
