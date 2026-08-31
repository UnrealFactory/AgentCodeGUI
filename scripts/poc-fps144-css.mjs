// PoC — 「6.9ms를 누가 먹는가」를 **한 부팅 안에서 교대로** 잰다.
//
//   node scripts/poc-fps144-css.mjs [--exe=PATH] [--cwd=DIR] [--rounds=4] [--ms=4000] [--port=11111]
//
// ## 왜 이 모양인가
// 트레이스 귀속(bench/fps.mjs --trace)이 4패널 스크롤의 최대 항목으로 **`Layerize`**
// (합성 레이어 재배치)를 지목했다 — 프레임당 1.4ms(1패널)~2.5ms(4패널). 예산 6.9ms의
// 3분의 1이 JS가 아니라 **합성 레이어 구조**에 간다는 뜻이다.
//
// 그런데 "backdrop-filter가 범인이다"는 아직 **추측**이다. 확인하려고 앱을 다시 빌드해
// 세션을 갈아 재면 밴드 이동(같은 코드가 회차마다 p95 5.2↔8.4ms로 흔들린다 — 실측)에
// 답이 묻힌다. 그래서 **한 부팅 안에서 CSS만 갈아 끼우며 교대로** 잰다:
//   base → A → base → B → …  (라운드 N회)
// 코드·프로세스·기계 상태가 전부 같고 **바뀌는 건 CSS 한 줄**뿐이라, 짝지은 차이가
// 그 CSS의 몫이다. 이기는 팔만 제품 CSS로 옮긴다(추측 최적화 금지).
//
// ※ 여기서 켜고 끄는 건 **측정용 오버라이드 스타일시트**다. 제품 CSS는 이 스크립트가
//    건드리지 않는다 — 결론이 난 뒤에 사람이 app/src/styles.css를 고친다.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { tauriProfile, connectMainPage, killTree, median, sleep, envInfo, binInfo, REPO } from '../bench/lib.mjs'
import { makeMultiFixture } from '../bench/fixture.mjs'
import { COLLECT, HARVEST, PANEL_POINTS, wheelSweep, cpuMark, cpuSince } from '../bench/ftgauge.mjs'

const argv = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=')
const ROUNDS = Number(argv('rounds', 4))
const MS = Number(argv('ms', 4000))
const PORT = Number(argv('port', 11111))
const EXE = argv('exe', '')
const CWD = argv('cwd', '')
const OUT = path.join(REPO, 'bench', 'results', argv('out', 'poc-fps144-css.json'))

// ── 팔 ───────────────────────────────────────────────────────────────────────
// 후보는 「스크롤 중 살아 있는 합성/가상화 장치」로 좁혔다. 모달·오버레이의
// backdrop-filter는 스크롤 중엔 DOM에 없으므로 후보가 아니다.
const ARMS = [
  { name: 'base', css: '' },
  {
    name: 'jump-noblur',
    note: '.jump-bottom(스크롤러 안 sticky 알약)의 backdrop-filter만 끔 — 블러 표면 유지 비용',
    css: '.jump-bottom{ backdrop-filter:none !important; -webkit-backdrop-filter:none !important; }'
  },
  {
    name: 'jump-gone',
    note: '.jump-bottom-wrap 통째로 제거 — sticky + 블러 + z-index 층 전부 제거(상한 측정용)',
    css: '.jump-bottom-wrap{ display:none !important; }'
  },
  {
    name: 'cv-off',
    note: 'content-visibility:auto 끔 — 네이티브 가상화가 만드는 페인트 청크 churn',
    css: '.thread > .msg{ content-visibility:visible !important; }'
  },
  {
    name: 'cv-fixed',
    note: 'contain-intrinsic-size를 auto→고정 — auto는 측정값을 기억하며 크기가 계속 바뀐다',
    css: '.thread > .msg{ contain-intrinsic-size:120px !important; }'
  }
]

const profile = tauriProfile({ ...(EXE ? { exe: EXE } : {}), port: PORT })
profile.env.CCG_HOME = path.join(REPO, '.bench-home-fps144css')
if (CWD) profile.cwd = path.resolve(CWD)

fs.rmSync(profile.env.CCG_HOME, { recursive: true, force: true })
makeMultiFixture(profile.env.CCG_HOME, '3.0.0-beta.1', { panels: 4 })

const child = spawn(profile.cmd, profile.args, {
  env: { ...process.env, ...profile.env }, cwd: profile.cwd, stdio: 'ignore'
})
const rows = []
let pts = null
try {
  const cdp = await connectMainPage(profile.port, { timeoutMs: 45000 })
  for (;;) { if (await cdp.eval(profile.mountExpr).catch(() => false)) break; await sleep(100) }
  await sleep(6000)
  pts = await cdp.eval(PANEL_POINTS)
  if (!pts?.length) throw new Error('멀티 그리드가 안 그려졌다')
  console.log(`panels: ${pts.length} · rounds ${ROUNDS} × arms ${ARMS.length} × ${MS}ms`)

  const setCss = (css) => cdp.eval(
    `(() => { let s = document.getElementById('poc-fps144'); if (!s) { s = document.createElement('style'); s.id = 'poc-fps144'; document.head.appendChild(s) } s.textContent = ${JSON.stringify(css)}; return s.textContent.length })()`
  )
  // 팔이 실제로 붙었는지 — 껍데기만 갈고 "차이 없음"을 결론 내는 사고를 막는다.
  const probeApplied = () => cdp.eval(`(() => {
    const j = document.querySelector('.jump-bottom')
    const m = document.querySelector('.thread > .msg')
    return {
      jumpPresent: !!j,
      jumpBackdrop: j ? getComputedStyle(j).backdropFilter : null,
      wrapDisplay: document.querySelector('.jump-bottom-wrap') ? getComputedStyle(document.querySelector('.jump-bottom-wrap')).display : 'absent',
      msgCv: m ? getComputedStyle(m).contentVisibility : null,
      msgIntrinsic: m ? getComputedStyle(m).containIntrinsicSize : null
    }
  })()`)

  for (let r = 1; r <= ROUNDS; r++) {
    for (const arm of ARMS) {
      await setCss(arm.css)
      // 점프 알약이 뜬 상태를 만든다(바닥에서 멀어져야 렌더된다) — 측정 창 **밖**에서.
      await wheelSweep(cdp, pts, 700, { period: 16, delta: 140 })
      await sleep(500)
      const applied = await probeApplied()
      await cdp.eval(COLLECT)
      const cpu0 = cpuMark()
      await wheelSweep(cdp, pts, MS)
      const sysCpuPct = cpuSince(cpu0)
      const m = await cdp.eval(HARVEST)
      rows.push({ round: r, arm: arm.name, sysCpuPct, applied, ...(m ?? { error: 'no samples' }) })
      console.log(`  r${r} ${arm.name.padEnd(12)} p50=${m?.workP50} p95=${m?.workP95} p99=${m?.workP99} max=${m?.workMax} >6.9ms=${m?.over69Pct}% cpu=${sysCpuPct}% jump=${applied?.jumpPresent} bf=${String(applied?.jumpBackdrop).slice(0, 14)} cv=${applied?.msgCv}`)
      await sleep(900)
    }
  }
  await setCss('')
  cdp.close()
} catch (e) {
  console.error('실패:', e?.message ?? e)
} finally {
  await sleep(500)
  killTree(child.pid)
}

// ── 집계: 짝지은 라운드 차 ───────────────────────────────────────────────────
const agg = (name) => {
  const f = rows.filter((r) => r.arm === name && !r.error)
  if (!f.length) return null
  const m = (k) => median(f.map((r) => r[k]))
  return {
    n: f.length, workP50: m('workP50'), workP95: m('workP95'), workP99: m('workP99'),
    workMaxWorst: Math.max(...f.map((r) => r.workMax ?? 0)),
    over69Pct: m('over69Pct'), avgFps: m('avgFps'), droppedPctWorst: Math.max(...f.map((r) => r.droppedPct ?? 0)),
    sysCpuPct: m('sysCpuPct')
  }
}
const summary = {}
for (const a of ARMS) summary[a.name] = agg(a.name)

// 같은 라운드 안에서만 뺀다 — 라운드 간 밴드 이동에 둔감하다.
const paired = {}
for (const a of ARMS.slice(1)) {
  const d = []
  for (let r = 1; r <= ROUNDS; r++) {
    const b = rows.find((x) => x.round === r && x.arm === 'base')
    const v = rows.find((x) => x.round === r && x.arm === a.name)
    if (b && v && !b.error && !v.error) {
      d.push({
        round: r,
        dP50: Math.round((v.workP50 - b.workP50) * 100) / 100,
        dP95: Math.round((v.workP95 - b.workP95) * 100) / 100,
        dOver69: Math.round((v.over69Pct - b.over69Pct) * 10) / 10
      })
    }
  }
  paired[a.name] = {
    rounds: d.length,
    medianDeltaP50: median(d.map((x) => x.dP50)),
    medianDeltaP95: median(d.map((x) => x.dP95)),
    medianDeltaOver69: median(d.map((x) => x.dOver69)),
    per: d
  }
}

const out = {
  what: '한 부팅 안 CSS 교대 A/B — 4패널 동시 스크롤의 프레임 작업 시간에 각 CSS가 얼마를 먹는가',
  budgetMs: 6.9, rounds: ROUNDS, sweepMs: MS, panels: pts?.length ?? null,
  arms: ARMS.map(({ name, note, css }) => ({ name, note: note ?? null, css })),
  bin: binInfo(profile.cmd), launchCwd: profile.cwd, env: envInfo(),
  summary, paired, rows, at: new Date().toISOString()
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log('\nsummary:', JSON.stringify(summary, null, 2))
console.log('paired(vs base):', JSON.stringify(paired, (k, v) => (k === 'per' ? undefined : v), 2))
console.log('saved:', path.relative(REPO, OUT))
