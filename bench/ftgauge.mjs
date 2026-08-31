// 프레임 **작업 시간** 눈금 — 공용 계측부.
//
// 왜 별도 파일인가: 같은 문법을 두 소비자(`bench/fps.mjs`, `scripts/poc-fps144-css.mjs`)가
// 쓴다. 기존 하네스들이 FPS 수집기를 파일마다 복붙해 둔 탓에(multi/scroll/stream/fpsab에
// 같은 COLLECT가 네 벌) 한 곳만 고치면 회차 비교가 조용히 어긋난다 — 그 실수를 새 눈금에
// 물려주지 않는다.
//
// 원리와 한계는 `bench/fps.mjs` 머리말에 있다. 요약:
//   rAF 콜백 안에서 MessageChannel로 t0을 쏘면 그 메시지 태스크는 **커밋이 끝난 뒤**에야
//   실행된다(태스크는 서로를 선점하지 못한다). t1-t0 = 그 프레임의 메인 스레드 작업 시간이고
//   vsync 대기가 안 섞인다 → 60Hz 기계에서도 144Hz 예산(6.9ms)을 판정할 수 있다.
import os from 'node:os'

export const BUDGET_MS = 6.9 // 144Hz 프레임 예산

export const COLLECT = `(() => {
  const b = { work: [], gap: [], long: 0, loaf: [], stop: false }
  window.__ft = b
  const mc = new MessageChannel()
  let prev = 0
  // t0을 **메시지에 실어** 보낸다. 전역 변수에 두면 메시지가 다음 프레임 뒤로 밀렸을 때
  // t0이 덮여 work가 음수/0으로 찍힌다(순서 가정을 아예 없앤다).
  mc.port1.onmessage = (ev) => { b.work.push(performance.now() - ev.data) }
  function raf(ts) {
    const t0 = performance.now()
    if (prev) b.gap.push(ts - prev)
    prev = ts
    // ★ 재요청은 **콜백 안에서 즉시** — 옛 하네스의 자기연쇄 rAF와 완전히 같은 모양이라
    //   gap[]/avgFps/droppedPct 열이 기존 결과와 그대로 비교된다. 재요청을 페인트 뒤
    //   메시지 태스크로 미루면 다음 vsync를 놓쳐 fps가 인위적으로 떨어진다(실측 58.8fps).
    if (!b.stop) requestAnimationFrame(raf)
    mc.port2.postMessage(t0)
  }
  requestAnimationFrame(raf)
  try {
    b.po = new PerformanceObserver((l) => { for (const e of l.getEntries()) b.long += e.duration })
    b.po.observe({ entryTypes: ['longtask'] })
  } catch (e) { /* 미지원 */ }
  try {
    b.po2 = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) b.loaf.push({
        d: e.duration,
        blocking: e.blockingDuration ?? 0,
        renderMs: e.renderStart ? (e.startTime + e.duration) - e.renderStart : null,
        styleLayoutMs: e.styleAndLayoutStart ? (e.startTime + e.duration) - e.styleAndLayoutStart : null,
        scripts: (e.scripts ?? []).slice(0, 3).map((s) => ({ n: s.name ?? s.invoker ?? '?', d: Math.round(s.duration) }))
      })
    })
    // durationThreshold의 하한은 16ms다 — 6.9ms 프레임은 LoAF로 볼 수 없다(그래서 보조).
    b.po2.observe({ type: 'long-animation-frame', buffered: false, durationThreshold: 16 })
  } catch (e) { b.loafErr = String(e && e.message || e) }
  return true
})()`

export const HARVEST = `(() => {
  const b = window.__ft; if (!b) return null
  b.stop = true
  try { b.po && b.po.disconnect() } catch (e) {}
  try { b.po2 && b.po2.disconnect() } catch (e) {}
  const r2 = (x) => x == null ? null : Math.round(x * 100) / 100
  // 기존 하네스와 **같은 분위 규약**(nearest-rank, floor(n*p))을 쓴다 — 회차 비교가 목적.
  const q = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : null
  const w = b.work.slice(3), g = b.gap.slice(3)
  if (!w.length) return null
  const ws = [...w].sort((x, y) => x - y), gs = [...g].sort((x, y) => x - y)
  const over = (t) => Math.round(w.filter((x) => x > t).length / w.length * 1000) / 10
  const gsum = g.reduce((a, c) => a + c, 0)
  const hist = new Array(62).fill(0)           // 0.5ms 버킷 × 0~30ms, 마지막 칸은 넘침
  for (const x of w) hist[Math.min(61, Math.floor(x / 0.5))]++
  const worst = [...w].sort((a, c) => c - a).slice(0, 8).map(r2)
  let loafMax = null, loafBlockMax = null, loafRenderMax = null
  if (b.loaf.length) {
    loafMax = r2(b.loaf.reduce((a, e) => Math.max(a, e.d), 0))
    loafBlockMax = r2(b.loaf.reduce((a, e) => Math.max(a, e.blocking), 0))
    loafRenderMax = r2(b.loaf.reduce((a, e) => Math.max(a, e.renderMs ?? 0), 0))
  }
  return {
    frames: w.length,
    // ★ 144Hz 판정 열 — 프레임 작업 시간
    workP50: r2(q(ws, 0.5)), workP75: r2(q(ws, 0.75)), workP95: r2(q(ws, 0.95)),
    workP99: r2(q(ws, 0.99)), workMax: r2(ws[ws.length - 1]),
    workMean: r2(w.reduce((a, c) => a + c, 0) / w.length),
    over69Pct: over(6.9), over166Pct: over(16.6), over33Pct: over(33),
    // 옛 눈금(60Hz 무후퇴 확인용) — rAF 간격
    rafP50: r2(q(gs, 0.5)), rafP95: r2(q(gs, 0.95)), rafMax: r2(gs[gs.length - 1]),
    avgFps: g.length ? Math.round(1000 / (gsum / g.length) * 10) / 10 : null,
    droppedPct: g.length ? Math.round(g.filter((x) => x > 33).length / g.length * 1000) / 10 : null,
    droppedFrames: g.filter((x) => x > 33).length,
    longTaskMs: Math.round(b.long),
    loaf: b.loaf.length ? { n: b.loaf.length, maxMs: loafMax, maxBlockingMs: loafBlockMax, maxRenderMs: loafRenderMax, top: b.loaf.slice().sort((a, c) => c.d - a.d).slice(0, 3) } : (b.loafErr ? { err: b.loafErr } : null),
    worstFramesMs: worst,
    hist
  }
})()`

// ── 오염 증인(CPU 부하) ──────────────────────────────────────────────────────
// 사용자의 실앱이 같은 기계에서 돈다(실측: clangd 하나가 232초 CPU를 먹고 있었다).
// 그 부하가 밴드째 움직이면 「고치기 전/후」가 코드가 아니라 **기계 상태**를 잰다.
// `os.cpus()`의 누적 시간 차 — 프로세스 스폰이 0이라 측정 창을 건드리지 않는다.
export function cpuMark() {
  const c = os.cpus()
  let idle = 0, total = 0
  for (const x of c) { idle += x.times.idle; for (const k in x.times) total += x.times[k] }
  return { idle, total, at: Date.now() }
}
export function cpuSince(m0) {
  const m1 = cpuMark()
  const dt = m1.total - m0.total
  if (dt <= 0) return null
  return Math.round((1 - (m1.idle - m0.idle) / dt) * 1000) / 10
}

// ── 입력 구동 ────────────────────────────────────────────────────────────────
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 지정한 점들에 휠을 뿌린다. 여러 점 = 동시 스크롤(부하 팔). 중간에 방향을 한 번 뒤집는다. */
export async function wheelSweep(cdp, points, ms, { period = 16, delta = 140 } = {}) {
  const end = performance.now() + ms
  const flipAt = performance.now() + ms / 2
  let dir = -delta
  let flipped = false
  while (performance.now() < end) {
    if (!flipped && performance.now() > flipAt) { dir = delta; flipped = true }
    for (const p of points) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY: dir })
    }
    await sleep(period)
  }
}

/** 4패널 그리드의 각 스레드 중심 좌표. */
export const PANEL_POINTS = `(() => [...document.querySelectorAll('.ma-p-thread')].map((el) => {
  const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
}))()`

// ── CDP Tracing 대조 ─────────────────────────────────────────────────────────
export async function traceStart(cdp) {
  const chunks = []
  const onMsg = (m) => { if (m.method === 'Tracing.dataCollected' && Array.isArray(m.params?.value)) chunks.push(...m.params.value) }
  cdp.listeners.push(onMsg)
  // `devtools.timeline`이 있어야 Layout/UpdateLayoutTree/Paint/Layerize/FunctionCall이 나온다.
  // `disabled-by-default-…`만 켜면 **RunTask 한 덩어리**뿐이라 귀속이 안 된다(실측).
  await cdp.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: {
      includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink.user_timing', '__metadata']
    }
  })
  return { chunks, onMsg }
}
export async function traceEnd(cdp, h) {
  let resolve
  const done = new Promise((r) => { resolve = r })
  const onDone = (m) => { if (m.method === 'Tracing.tracingComplete') resolve() }
  cdp.listeners.push(onDone)
  await cdp.send('Tracing.end')
  await Promise.race([done, sleep(30000)])
  cdp.listeners = cdp.listeners.filter((f) => f !== h.onMsg && f !== onDone)
  return h.chunks
}
export function analyzeTrace(events) {
  if (!events?.length) return null
  const mains = new Set()
  for (const e of events) {
    if (e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain') mains.add(`${e.pid}:${e.tid}`)
  }
  // 렌더러가 여럿일 수 있다(토스트 창 등) — RunTask 총합이 가장 큰 스레드가 무대다.
  const byThread = new Map()
  for (const e of events) {
    if (e.ph !== 'X' || e.name !== 'RunTask' || typeof e.dur !== 'number') continue
    const k = `${e.pid}:${e.tid}`
    if (mains.size && !mains.has(k)) continue
    if (!byThread.has(k)) byThread.set(k, [])
    byThread.get(k).push(e.dur / 1000)
  }
  let best = null
  for (const [k, arr] of byThread) {
    const sum = arr.reduce((a, c) => a + c, 0)
    if (!best || sum > best.sum) best = { k, arr, sum }
  }
  if (!best) return { tasks: 0, note: 'RunTask 없음(WebView2에서 카테고리 미지원일 수 있음)' }
  const s = best.arr.slice().sort((a, c) => a - c)
  const r2 = (x) => x == null ? null : Math.round(x * 100) / 100
  const q = (p) => r2(s[Math.min(s.length - 1, Math.floor(s.length * p))])
  return {
    thread: best.k,
    // ── 모집단 ① 그 스레드의 **모든** RunTask ────────────────────────────────
    // ★ 이 분위를 인페이지 `work`와 나란히 놓으면 **안 된다**(FPS144 R1이 저지른 오류).
    //   `work`의 모집단은 「프레임」이고 이쪽은 「태스크 전부」다 — 프레임 태스크는 그중
    //   일부고 나머지는 잡티(타이머·IPC·GC)라 p50이 0.01ms로 깔린다. 실제로 R1의
    //   §2.2 대조는 1패널 최대값이 126% 어긋났다(10.5 vs 23.76). 이 칸은 「메인 스레드가
    //   전체로 얼마나 바빴나」에만 쓴다.
    tasks: s.length,
    taskP50Ms: q(0.5), taskP95Ms: q(0.95), taskP99Ms: q(0.99), taskMaxMs: r2(s[s.length - 1]),
    taskOver69Pct: Math.round(s.filter((x) => x > 6.9).length / s.length * 1000) / 10,
    busyMsTotal: Math.round(best.sum),
    // ── 모집단 ② **프레임 태스크만** — 인페이지 눈금과 같은 모집단 ───────────
    //   `FireAnimationFrame`을 품은 RunTask = 그 프레임의 BeginMainFrame이다.
    //   이것만이 인페이지 `work`와 짝지어 비교할 수 있는 독립 대조다.
    frame: frameTasks(events, best.k),
    breakdown: selfTime(events, best.k),
    // ── 한계의 크기 — 메인 스레드 눈금이 못 보는 몫이 예산을 뒤집나 ──────────
    threads: threadBusy(events)
  }
}

/**
 * **프레임 태스크만** 고른다 — `FireAnimationFrame`을 품은 `RunTask`.
 * 인페이지 눈금(rAF 콜백 시작 → 커밋 뒤)과 **같은 모집단**이라 분위끼리 비교가 성립한다.
 */
export function frameTasks(events, threadKey) {
  const on = (e) => `${e.pid}:${e.tid}` === threadKey && e.ph === 'X' && typeof e.dur === 'number'
  const runs = events.filter((e) => on(e) && e.name === 'RunTask').sort((a, b) => a.ts - b.ts)
  const fafs = events.filter((e) => on(e) && e.name === 'FireAnimationFrame').map((e) => e.ts).sort((a, b) => a - b)
  if (!runs.length || !fafs.length) return { tasks: 0, note: 'FireAnimationFrame 없음' }
  // 각 RunTask 구간 [ts, ts+dur] 안에 FAF 시작점이 있는지 — 이분 탐색
  const lower = (x) => { let lo = 0, hi = fafs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (fafs[m] < x) lo = m + 1; else hi = m } return lo }
  const picked = []
  for (const r of runs) {
    const i = lower(r.ts)
    if (i < fafs.length && fafs[i] <= r.ts + r.dur) picked.push(r.dur / 1000)
  }
  if (!picked.length) return { tasks: 0, note: 'rAF를 품은 RunTask 없음' }
  const s = picked.sort((a, b) => a - b)
  const r2 = (x) => x == null ? null : Math.round(x * 100) / 100
  const q = (p) => r2(s[Math.min(s.length - 1, Math.floor(s.length * p))])
  return {
    tasks: s.length,
    p50Ms: q(0.5), p95Ms: q(0.95), p99Ms: q(0.99), maxMs: r2(s[s.length - 1]),
    over69Pct: Math.round(s.filter((x) => x > 6.9).length / s.length * 1000) / 10,
    busyMsTotal: Math.round(s.reduce((a, c) => a + c, 0))
  }
}

/**
 * 스레드별 busy 합 — 「컴포지터/GPU는 안 보인다」는 한계의 **크기**를 재기 위한 것.
 * 메인 스레드 눈금이 놓치는 몫이 예산을 뒤집는지 아닌지는 이 표로만 닫을 수 있다.
 */
export function threadBusy(events, { top = 8 } = {}) {
  const name = new Map()
  for (const e of events) {
    if (e.ph === 'M' && e.name === 'thread_name' && e.args?.name) name.set(`${e.pid}:${e.tid}`, e.args.name)
  }
  // 최상위(중첩 안 된) 'X' 이벤트만 더한다 — 자식까지 더하면 이중 계산이 된다
  const byThread = new Map()
  for (const e of events) {
    if (e.ph !== 'X' || typeof e.dur !== 'number') continue
    const k = `${e.pid}:${e.tid}`
    if (!byThread.has(k)) byThread.set(k, [])
    byThread.get(k).push(e)
  }
  const rows = []
  for (const [k, evs] of byThread) {
    evs.sort((a, b) => (a.ts - b.ts) || (b.dur - a.dur))
    let sum = 0, end = -Infinity
    for (const e of evs) { if (e.ts >= end) { sum += e.dur; end = e.ts + e.dur } }
    rows.push({ thread: name.get(k) ?? k, key: k, busyMs: Math.round(sum / 1000) })
  }
  return rows.sort((a, b) => b.busyMs - a.busyMs).slice(0, top)
}

/**
 * **자기 시간(self time) 귀속** — 「6.9ms가 어디로 갔는가」를 추측이 아니라 트레이스로.
 * 같은 스레드의 'X'(complete) 이벤트는 시간상 완전히 중첩되므로 스택으로 부모를 찾아
 * 자식 길이를 빼면 각 이름의 순수 몫이 나온다. 상위 12개만 남긴다.
 */
export function selfTime(events, threadKey) {
  const evs = events
    .filter((e) => e.ph === 'X' && typeof e.dur === 'number' && `${e.pid}:${e.tid}` === threadKey)
    .sort((a, b) => (a.ts - b.ts) || (b.dur - a.dur))
  const self = new Map()
  const cnt = new Map()
  const stack = []
  const nodes = []
  for (const e of evs) {
    while (stack.length && stack[stack.length - 1].end <= e.ts) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent) parent.self -= e.dur       // 자식 길이는 부모의 자기 시간에서 뺀다
    const node = { name: e.name, end: e.ts + e.dur, self: e.dur }
    stack.push(node)
    nodes.push(node)
    cnt.set(e.name, (cnt.get(e.name) ?? 0) + 1)
  }
  for (const n of nodes) self.set(n.name, (self.get(n.name) ?? 0) + n.self)
  return [...self.entries()]
    .map(([name, us]) => ({ name, selfMs: Math.round(us / 1000 * 10) / 10, n: cnt.get(name) }))
    .filter((r) => r.selfMs >= 1)
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, 12)
}
