/**
 * PoC — 한도 자동 이어서(limitResume) 판정 로직 + **훅 착지** 검증.
 *
 * 클로드 코드 데스크톱의 "Auto-continue when the limit resets" 패리티: 구독 한도에
 * 막혀 죽은 턴을 에러 문구로 판별하고(오탐 = 남의 에러를 조용히 재전송 — 최악),
 * usage 창 조합에서 "언제 풀리는지"를 골라 타이머 지연을 계산한다.
 *
 * 검증:
 *  A. classifyLimitError — 실전 한도 문구는 전부 hit, 비한도(컨텍스트·토큰·키·일반
 *     실패·일시 과부하)는 전부 miss, "…|1755150000" 꼬리는 unix 초로 파싱
 *  B. blockedResetsAt — 소진 창 중 가장 늦은 시각, Fable 창은 Fable 실행만 게이트,
 *     과거 시각(낡은 캐시)·미소진은 제외
 *  C. codexBlockedResetsAt — 라벨 무관 소진 창의 최댓값
 *  D. resumeDelayMs — 리셋+90s 여유·최소 15s·미상은 10분 프로브
 *  E. sanitizeHold — 손상/만료(24h) 복원값은 버리고 정상 표는 형태 보존
 *
 *  ★A~E는 **두 사본에 똑같이** 먹인다: 2.6.2 동결본(`src/renderer/src/lib`)과 3.0
 *   이식본(`app/src/lib`). 3.0의 분기가 **덧붙이기뿐**임을 회귀로 못 박는다.
 *
 *  F. (3.0 전용) usageUnavailable · codexUsageUnavailable · resumeVerdict ·
 *     recheckDelayMs · holdDelayMs — 「막혔다 / 풀렸다 / **못 물어봤다**」 세 갈래
 *  G. (3.0 전용) **실제 훅을 그대로 구동한다**(`app/src/lib/useLimitResume.ts`).
 *     최소 훅 런타임(useState/useRef/useEffect) + 가짜 `window.api`로, 최종 파리티 R1
 *     확인 크리틱 실패1의 시나리오(조회 실패)가 **유지**로 착지하는지를 본채팅·멀티
 *     패널·추가 채팅 **세 표면의 실제 props**로 각각 잰다.
 *
 * 실행: node scripts/poc-limit-resume.mjs   (esbuild로 lib를 번들 후 인메모리 구동)
 */
import esbuild from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
// 스크래치는 **레포 밖**(%TEMP%)에 판다 — 주행이 중간에 죽어도 남의 git status를 더럽히지 않는다.
const tmp = path.join(os.tmpdir(), 'ccg-limit-poc-t3t4')
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })

async function bundle(entry, outName, opts = {}) {
  const outfile = path.join(tmp, outName)
  await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', outfile, ...opts })
  return import(pathToFileURL(outfile).href)
}

const COPIES = [
  ['2.6.2 동결본', 'src/renderer/src/lib/limitResume.ts'],
  ['3.0 이식본', 'app/src/lib/limitResume.ts']
]

let pass = 0
let fail = 0
let tag = ''
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else {
    fail++
    console.error(`  FAIL [${tag}] ${name}\n    want ${JSON.stringify(want)}\n    got  ${JSON.stringify(got)}`)
  }
}
const ok = (name, cond, detail) => eq(name, cond ? true : `거짓: ${detail ?? ''}`, true)

const NOW = 1_755_000_000
const NOW_MS = NOW * 1000
const W = (pct, resetsAt) => ({ pct, resetsAt })

// ── A~E: 두 사본에 같은 대본 ─────────────────────────────────────────
for (const [label, rel] of COPIES) {
  tag = label
  const lib = await bundle(path.join(root, rel), `lib-${label.replace(/[^a-z0-9.]/gi, '_')}.mjs`)
  console.log(`\n=== ${label} (${rel}) ===`)

  // ── A. 에러 문구 판정 ────────────────────────────────────────────────
  console.log('A. classifyLimitError')
  const HITS = [
    ['Claude AI usage limit reached|1755150000', 1755150000], // 구독 한도 원문(리셋 꼬리)
    ['Claude AI usage limit reached', null],
    ["You've reached your usage limit.", null], // codex/claude 공통 문구형
    ["You've hit your usage limit. Upgrade to continue.", null],
    ['5-hour limit reached ∙ resets 3pm', null], // REPL 배너형
    ['Weekly limit reached · resets Aug 20', null],
    ['five-hour limit reached, resets 15:00', null],
    ['Session limit reached|1799999999', 1799999999],
    ['you have reached your weekly limit', null]
  ]
  for (const [s, epoch] of HITS) eq(`hit: ${s}`, lib.classifyLimitError(s), { hit: true, resetsAt: epoch })
  const MISSES = [
    'Invalid API key · Please run /login',
    'Command failed with exit code 1',
    'context limit reached: conversation too long', // 컨텍스트 한도 — 다른 사고
    'output token limit exceeded',
    'prompt is too long: maximum context length exceeded',
    'API Error: 529 overloaded_error', // 일시 과부하 — CLI가 자체 재시도
    'rate limited; retry shortly',
    '오류: 실행 중 프로세스가 종료되었습니다',
    ''
  ]
  for (const s of MISSES) eq(`miss: ${s || '(빈 문자열)'}`, lib.classifyLimitError(s), { hit: false, resetsAt: null })
  eq('null 입력', lib.classifyLimitError(null), { hit: false, resetsAt: null })

  // ── B. 막는 창 고르기 (Anthropic) ────────────────────────────────────
  console.log('B. blockedResetsAt')
  eq('5h만 소진', lib.blockedResetsAt({ fiveHour: W(100, NOW + 3600), weekly: W(40, NOW + 86400), weeklyFable: null, extraCredit: null }, false, NOW), NOW + 3600)
  eq(
    '5h+주간 동시 소진 → 늦은 쪽(주간)',
    lib.blockedResetsAt({ fiveHour: W(100, NOW + 1800), weekly: W(100, NOW + 86400), weeklyFable: null, extraCredit: null }, false, NOW),
    NOW + 86400
  )
  eq(
    'Fable 창 소진 — Fable 실행 아님 → 게이트 아님',
    lib.blockedResetsAt({ fiveHour: W(30, NOW + 3600), weekly: W(50, NOW + 86400), weeklyFable: W(100, NOW + 40000), extraCredit: null }, false, NOW),
    null
  )
  eq(
    'Fable 창 소진 — Fable 실행 → 게이트',
    lib.blockedResetsAt({ fiveHour: W(30, NOW + 3600), weekly: W(50, NOW + 86400), weeklyFable: W(100, NOW + 40000), extraCredit: null }, true, NOW),
    NOW + 40000
  )
  eq('과거 리셋(낡은 캐시)은 제외', lib.blockedResetsAt({ fiveHour: W(100, NOW - 60), weekly: null, weeklyFable: null, extraCredit: null }, false, NOW), null)
  eq('아무 창도 안 막음', lib.blockedResetsAt({ fiveHour: W(99, NOW + 3600), weekly: W(0, null), weeklyFable: null, extraCredit: null }, false, NOW), null)
  eq('usage 없음', lib.blockedResetsAt(null, false, NOW), null)

  // ── C. Codex 창 ──────────────────────────────────────────────────────
  console.log('C. codexBlockedResetsAt')
  eq(
    '소진 창 중 최댓값',
    lib.codexBlockedResetsAt(
      [
        { usedPct: 100, resetsAt: NOW + 1200 },
        { usedPct: 100, resetsAt: NOW + 604800 },
        { usedPct: 12, resetsAt: NOW + 99999999 }
      ],
      NOW
    ),
    NOW + 604800
  )
  eq('소진 없음', lib.codexBlockedResetsAt([{ usedPct: 34, resetsAt: NOW + 1200 }], NOW), null)
  eq('resetsAt 없는 소진 창은 제외', lib.codexBlockedResetsAt([{ usedPct: 100 }], NOW), null)
  eq('빈/널 목록', lib.codexBlockedResetsAt(null, NOW), null)

  // ── D. 타이머 지연 ───────────────────────────────────────────────────
  console.log('D. resumeDelayMs')
  eq('1시간 뒤 리셋 → +90s 여유', lib.resumeDelayMs(NOW + 3600, NOW_MS), 3600_000 + 90_000)
  eq('이미 지난 리셋 → 최소 15s', lib.resumeDelayMs(NOW - 100, NOW_MS), 15_000)
  eq('시각 미상 → 10분 프로브', lib.resumeDelayMs(null, NOW_MS), 10 * 60_000)

  // ── E. 복원 위생 ─────────────────────────────────────────────────────
  console.log('E. sanitizeHold')
  const hold = { key: 'c1', engine: 'claude', account: 'a@b.c', resetsAt: NOW + 60, fable: false, lastPrompt: '이어서', at: NOW_MS - 1000, ready: true }
  eq('정상 표 보존(단 ready는 영속 안 함)', lib.sanitizeHold(hold, NOW_MS), { ...hold, ready: undefined })
  eq('24시간 경과 → 폐기', lib.sanitizeHold({ ...hold, at: NOW_MS - 25 * 3600_000 }, NOW_MS), null)
  eq('key 없음 → 폐기', lib.sanitizeHold({ ...hold, key: '' }, NOW_MS), null)
  eq('at이 문자열(손상) → 폐기', lib.sanitizeHold({ ...hold, at: 'x' }, NOW_MS), null)
  eq('엔진 값 오염 → claude 폴백', lib.sanitizeHold({ ...hold, engine: 'gpt9' }, NOW_MS)?.engine, 'claude')
  eq('널 → 폐기', lib.sanitizeHold(null, NOW_MS), null)
}

// ── F. 3.0 분기 — 「못 물어봤다」 갈래 ────────────────────────────────
tag = '3.0'
const lib3 = await bundle(path.join(root, 'app/src/lib/limitResume.ts'), 'lib3.mjs')
console.log('\n=== 3.0 분기 (최종 파리티 R1 확인 크리틱 실패1) ===')
console.log('F. usageUnavailable / resumeVerdict / holdDelayMs')

// **실측 실패값** — `scripts/poc-limit-blind.mjs`가 실 exe(격리 홈 + CCG_NO_NET=1 +
// 살아 있는 토큰)에서 읽어 남긴 값이 있으면 그것을 쓴다. 하네스가 손으로 적은 모양이
// 아니라 **바이너리가 실제로 뱉은 값**이어야 이 절의 주장이 성립한다.
const MEASURED = path.join(root, 'docs/critic/limit-blind-t3t4-r1.json')
let FAIL_VALUE = { fiveHour: null, weekly: null, weeklyFable: null, extraCredit: null, unavailable: true }
try {
  const m = JSON.parse(fs.readFileSync(MEASURED, 'utf8'))
  if (m?.steps?.usageGet) {
    FAIL_VALUE = m.steps.usageGet
    console.log(`   (실측 실패값을 ${path.relative(root, MEASURED)}에서 읽었다: ${JSON.stringify(FAIL_VALUE)})`)
  }
} catch {
  console.log('   (실측 파일 없음 — 리터럴 실패값으로 돈다. `node scripts/poc-limit-blind.mjs`로 갱신)')
}
// R1의 값 = 표식이 없던 시절의 실패값. 표식이 없어도 유지로 착지해야 한다(창이 0개다).
const FAIL_R1 = { fiveHour: null, weekly: null, weeklyFable: null, extraCredit: null }
const LIVE_BLOCKED = { fiveHour: W(0, null), weekly: W(100, NOW + 3600), weeklyFable: W(33, NOW + 3600), extraCredit: null }
const LIVE_FREE = { fiveHour: W(12, NOW + 3600), weekly: W(40, NOW + 86400), weeklyFable: null, extraCredit: null }

eq('실측 실패값 = 못 물어봤다', lib3.usageUnavailable(FAIL_VALUE), true)
eq('R1의 무표식 실패값도 못 물어봤다(창 0개)', lib3.usageUnavailable(FAIL_R1), true)
eq('null도 못 물어봤다', lib3.usageUnavailable(null), true)
eq('창이 하나라도 있으면 판정 근거가 있다', lib3.usageUnavailable(LIVE_BLOCKED), false)
eq('extraCredit만 있어도 응답은 왔다', lib3.usageUnavailable({ fiveHour: null, weekly: null, weeklyFable: null, extraCredit: { enabled: false, pct: 0 } }), false)
eq('낡은 캐시(stale)는 값이다 — 못 물어본 것이 아니다', lib3.usageUnavailable({ ...LIVE_FREE, stale: true }), false)
eq('codex: 창 목록 없음 = 못 물어봤다', lib3.codexUsageUnavailable(undefined), true)
eq('codex: 빈 목록 = 못 물어봤다', lib3.codexUsageUnavailable([]), true)
eq('codex: 창이 있으면 근거가 있다', lib3.codexUsageUnavailable([{ usedPct: 0 }]), false)

const H = (over = {}) => ({ key: 'c1', engine: 'claude', resetsAt: NOW - 100, fable: false, lastPrompt: 'p', at: NOW_MS, ...over })
eq('막혔다는 신선한 증거 → 유지 + 실패 계수 리셋', lib3.resumeVerdict(H({ probes: 2 }), NOW + 3600, false, NOW), { kind: 'hold', resetsAt: NOW + 3600, probes: 0 })
eq('★ 못 물어봤다 → 유지(1회차)', lib3.resumeVerdict(H(), null, true, NOW), { kind: 'hold', resetsAt: NOW - 100, probes: 1 })
eq('★ 못 물어봤다 → 유지(2회차)', lib3.resumeVerdict(H({ probes: 1 }), null, true, NOW), { kind: 'hold', resetsAt: NOW - 100, probes: 2 })
eq('상한 초과 + 리셋 시각이 이미 지남 → 눈감고 한 번(2.6.2 동작)', lib3.resumeVerdict(H({ probes: 2 }), null, true, NOW), { kind: 'ready' })
eq('상한 초과여도 시각 미상이면 절대 안 쏜다', lib3.resumeVerdict(H({ resetsAt: null, probes: 9 }), null, true, NOW), { kind: 'hold', resetsAt: null, probes: 10 })
eq('상한 초과여도 리셋이 아직 미래면 안 쏜다', lib3.resumeVerdict(H({ resetsAt: NOW + 3600, probes: 9 }), null, true, NOW), { kind: 'hold', resetsAt: NOW + 3600, probes: 10 })
eq('물어봤고 막는 창이 없다 → 풀렸다', lib3.resumeVerdict(H(), null, false, NOW), { kind: 'ready' })

eq('재확인 간격 1회차 = 15초', lib3.recheckDelayMs(1), 15_000)
eq('재확인 간격 2회차 = 30초', lib3.recheckDelayMs(2), 30_000)
eq('재확인 간격은 프로브(10분)에서 멎는다', lib3.recheckDelayMs(20), 10 * 60_000)
eq('probes 없는 표 = 옛 규칙 그대로', lib3.holdDelayMs(H({ resetsAt: NOW + 3600 }), NOW_MS), 3600_000 + 90_000)
eq('probes 있는 표 = 재확인 간격(배너와 타이머가 같은 값)', lib3.holdDelayMs(H({ probes: 2 }), NOW_MS), 30_000)
eq('probes 복원(위생)', lib3.sanitizeHold({ ...H({ probes: 3 }), at: NOW_MS - 1000 }, NOW_MS)?.probes, 3)
eq('probes 오염(음수)은 버린다', lib3.sanitizeHold({ ...H({ probes: -5 }), at: NOW_MS - 1000 }, NOW_MS)?.probes, undefined)

// ── G. 실제 훅 구동 ──────────────────────────────────────────────────
console.log('\nG. useLimitResume 실구동 — 조회 실패의 착지(세 표면)')

// 최소 훅 런타임(react 대체). 실제 훅 소스를 **한 글자도 안 고치고** 돌리기 위한 것.
const stubPath = path.join(tmp, 'react-stub.mjs')
fs.writeFileSync(
  stubPath,
  `let cur = null
function slot(make) {
  const h = cur, i = h.idx++
  if (h.cells.length <= i) h.cells.push(make())
  return h.cells[i]
}
export function useState(init) {
  const c = slot(() => ({ v: typeof init === 'function' ? init() : init }))
  const host = cur
  return [c.v, (nv) => {
    const next = typeof nv === 'function' ? nv(c.v) : nv
    if (Object.is(next, c.v)) return
    c.v = next
    host.dirty = true
    if (!host.running) host.render()
  }]
}
export function useRef(init) { return slot(() => ({ current: init })) }
// i18n.ts의 useLang()이 쓰는 자리 — 훅 착지 판정과 무관해서 재렌더만 흉내 낸다.
export function useReducer(reduce, init) {
  const c = slot(() => ({ v: init }))
  const host = cur
  return [c.v, (a) => { c.v = reduce(c.v, a); host.dirty = true; if (!host.running) host.render() }]
}
export function useEffect(fn, deps) {
  const s = slot(() => ({ deps: null, cleanup: null, first: true }))
  const changed = s.first || !deps || !s.deps || deps.length !== s.deps.length || deps.some((d, i) => !Object.is(d, s.deps[i]))
  s.first = false
  s.deps = deps
  if (changed) cur.effects.push({ s, fn })
}
export function __mount(component) {
  const host = { cells: [], idx: 0, effects: [], dirty: false, running: false, renders: 0, out: null }
  host.render = () => {
    if (host.running) { host.dirty = true; return }
    host.running = true
    let guard = 0
    do {
      host.dirty = false
      host.idx = 0
      host.effects = []
      const prev = cur
      cur = host
      try { host.out = component() } finally { cur = prev }
      host.renders++
      const eff = host.effects
      host.effects = []
      for (const e of eff) {
        if (typeof e.s.cleanup === 'function') { try { e.s.cleanup() } catch { /* ignore */ } }
        const c = e.fn()
        e.s.cleanup = typeof c === 'function' ? c : null
      }
    } while (host.dirty && ++guard < 100)
    host.running = false
  }
  host.render()
  return host
}
`
)
const entryPath = path.join(tmp, 'hook-entry.mjs')
const imp = (p) => JSON.stringify(p.replace(/\\/g, '/')) // esbuild는 file:// URL을 못 푼다
fs.writeFileSync(
  entryPath,
  `export { useLimitResume } from ${imp(path.join(root, 'app/src/lib/useLimitResume.ts'))}
export { __mount } from ${imp(stubPath)}
`
)

// 훅이 도는 판 — 브라우저 전역 최소 대역(모듈 초기화가 localStorage를 읽는다: i18n)
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
const timers = []
let tid = 0
const sent = []
let usageAnswer = FAIL_VALUE
let usageCalls = 0
globalThis.window = {
  api: {
    getUsage: async () => {
      usageCalls++
      if (usageAnswer === 'throw') throw new Error('boom')
      return usageAnswer
    },
    codexAuth: { accountsUsage: async () => [] }
  },
  setTimeout: (fn, ms) => {
    const id = ++tid
    timers.push({ id, fn, ms })
    return id
  },
  clearTimeout: (id) => {
    const i = timers.findIndex((x) => x.id === id)
    if (i >= 0) timers.splice(i, 1)
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => {}
}

const hookMod = await bundle(entryPath, 'hook.mjs', { alias: { react: stubPath } })
// G절은 **진짜 시계**로 돈다(훅이 Date.now()를 쓴다) — 창 시각도 실시간 기준으로 만든다.
const REAL = Math.floor(Date.now() / 1000)
const G_BLOCKED = { fiveHour: W(0, null), weekly: W(100, REAL + 3600), weeklyFable: W(33, REAL + 3600), extraCredit: null }
const G_FREE = { fiveHour: W(12, REAL + 3600), weekly: W(40, REAL + 86400), weeklyFable: null, extraCredit: null }
const flush = () => new Promise((r) => setTimeout(r, 0))

/** 대기표 하나를 장전한 훅 호스트를 만든다. props는 화면이 실제로 넘기는 모양 그대로. */
function mountArmed(props) {
  timers.length = 0 // 앞 시나리오의 호스트가 걸어 둔 타이머와 섞이지 않게(가짜 시계 초기화)
  const errText = 'Claude AI usage limit reached|' + (NOW - 100)
  const state = {
    status: 'working',
    session: 'ses-1',
    interrupted: false,
    messages: [
      { kind: 'msg', role: 'user', text: '원래 하던 일' },
      { kind: 'msg', role: 'assistant', text: errText, error: true }
    ]
  }
  const o = { state, busy: false, enabled: true, apiMode: false, engine: 'claude', fable: false, send: (p) => sent.push(p), ...props }
  let handle = null
  const host = hookMod.__mount(() => {
    handle = hookMod.useLimitResume(o)
    return null
  })
  // 장전 조건: 방금 돌던 턴(working)이 error로 끝났다 = status 상승 에지
  o.state = { ...state, status: 'error' }
  host.render()
  return { host, o, get hold() { return handle.hold } }
}

/** 걸려 있는 타이머 하나를 지금 터뜨린다(가짜 시계) — fire()가 끝날 때까지 기다린다. */
async function tick(h) {
  const t = timers.shift()
  if (!t) return null
  t.fn()
  await flush()
  await flush()
  h.host.render()
  return t.ms
}

const SURFACES = [
  ['본채팅(App.tsx)', { holdKey: 'chat-1', account: 'a@b.c', canSend: () => true, readyDep: true, managed: false }],
  ['멀티 패널(MultiAgent.tsx)', { holdKey: 'slot-0', account: 'a@b.c' }],
  ['추가 채팅 창(SessionWindow.tsx)', { holdKey: '', account: 'a@b.c' }]
]

for (const [name, props] of SURFACES) {
  tag = name
  // ① ★크리틱 실패1 재현 — 조회가 실패하는 판에서 재검증이 어디로 착지하나.
  sent.length = 0
  usageAnswer = FAIL_VALUE
  usageCalls = 0
  let h = mountArmed(props)
  ok(`${name} 장전됨`, !!h.hold, JSON.stringify(h.hold))
  eq(`${name} 장전 시각은 문구 꼬리`, h.hold?.resetsAt, NOW - 100)
  const d1 = await tick(h)
  eq(`${name} ★ 조회 실패 1회차 → 유지(전송 0)`, { hold: !!h.hold, ready: !!h.hold?.ready, probes: h.hold?.probes, sent: sent.length }, { hold: true, ready: false, probes: 1, sent: 0 })
  eq(`${name} 다음 재확인은 15초 뒤`, timers[0]?.ms ?? d1, 15_000)
  await tick(h)
  eq(`${name} ★ 조회 실패 2회차 → 여전히 유지`, { hold: !!h.hold, ready: !!h.hold?.ready, probes: h.hold?.probes, sent: sent.length }, { hold: true, ready: false, probes: 2, sent: 0 })
  ok(`${name} 조회는 실제로 매번 나갔다`, usageCalls >= 3, `usageCalls=${usageCalls}`)
  // 상한(MAX_AUTO_ATTEMPTS=2)을 넘기면 **문구가 알려 준 시각이 지났을 때만** 한 번 쏜다.
  await tick(h)
  eq(`${name} 상한 초과 → 눈감고 한 번(그리고 대기표 소진)`, { hold: h.hold, sent: sent.length }, { hold: null, sent: 1 })

  // ② 시각 미상(배너형 문구)이면 상한을 넘겨도 절대 안 쏜다 — 근거가 0이다.
  sent.length = 0
  h = mountArmed(props)
  h.host.render()
  // 문구 꼬리가 없는 판을 손으로 만든다(배너형 = resetsAt null)
  h.hold && (h.hold.resetsAt = null)
  for (let i = 0; i < 5; i++) await tick(h)
  eq(`${name} 시각 미상 + 조회 실패 5회 → 유지·전송 0`, { hold: !!h.hold, ready: !!h.hold?.ready, sent: sent.length }, { hold: true, ready: false, sent: 0 })

  // ③ R1의 무표식 실패값(옛 셸)도 같은 착지 — 표식에만 기대지 않는다.
  sent.length = 0
  usageAnswer = FAIL_R1
  h = mountArmed(props)
  await tick(h)
  eq(`${name} 무표식 실패값도 유지`, { hold: !!h.hold, ready: !!h.hold?.ready, sent: sent.length }, { hold: true, ready: false, sent: 0 })

  // ④ 조회가 던지는 판(계약 위반)도 실패로 읽는다.
  sent.length = 0
  usageAnswer = 'throw'
  h = mountArmed(props)
  await tick(h)
  eq(`${name} 조회가 던져도 유지`, { hold: !!h.hold, ready: !!h.hold?.ready, sent: sent.length }, { hold: true, ready: false, sent: 0 })

  // ⑤ 대조군 — 아직 막혀 있다는 실값이면 그 시각으로 재장전(회귀 없음).
  sent.length = 0
  usageAnswer = G_BLOCKED
  h = mountArmed(props)
  await tick(h)
  eq(`${name} 실값(아직 막힘) → 그 시각으로 재장전`, { resetsAt: h.hold?.resetsAt, probes: h.hold?.probes, sent: sent.length }, { resetsAt: REAL + 3600, probes: 0, sent: 0 })

  // ⑥ 대조군 — 풀렸다는 실값이면 즉시 이어서 전송(기능이 죽지 않았다).
  sent.length = 0
  usageAnswer = G_FREE
  h = mountArmed(props)
  await tick(h)
  eq(`${name} 실값(풀림) → 이어서 전송 1회`, { hold: h.hold, sent: sent.length }, { hold: null, sent: 1 })
  ok(`${name} 전송 문구는 '이어서'(세션 있음)`, /이어서|continue/i.test(sent[0] ?? ''), sent[0])
}

// 본채팅은 엔진이 대기표를 들면 손을 뗀다(재개 주체 하나) — 그 성질이 살아 있나.
tag = 'managed'
sent.length = 0
usageAnswer = G_FREE
const hm = mountArmed({ holdKey: 'chat-1', account: 'a@b.c', managed: true })
eq('managed면 장전 자체를 안 한다', { hold: hm.hold, timers: timers.length, sent: sent.length }, { hold: null, timers: 0, sent: 0 })

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} 통과, ${fail} 실패`)
process.exit(fail === 0 ? 0 : 1)
