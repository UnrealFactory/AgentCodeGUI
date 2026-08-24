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
import { execFileSync } from 'node:child_process'
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
// ★R28b RVERD — CRIT 확인 크리틱 R1 §4.1의 실측(시각 미상 표는 조회 실패 20회에도 ready 0/20).
// 엔진은 같은 구멍을 `probes < MAX_BLIND_PROBES || (known && !past)`로 닫았고(`runtime.rs:3240`),
// 렌더러도 같은 뜻이 됐다: **시각을 모르는 표는 상한을 받는다.** 시각 미상은 "기다릴 근거가
// 없다"이지 "영원히 기다리라"가 아니다 — 그 표에 출구가 없으면 「이어가기」도 자동 재개도 없다.
eq('★ 시각 미상 — 상한 안(1회차)이면 유지', lib3.resumeVerdict(H({ resetsAt: null }), null, true, NOW), { kind: 'hold', resetsAt: null, probes: 1 })
eq('★ 시각 미상 — 상한 안(2회차)이면 유지', lib3.resumeVerdict(H({ resetsAt: null, probes: 1 }), null, true, NOW), { kind: 'hold', resetsAt: null, probes: 2 })
eq('★★ 시각 미상 — 상한을 넘기면 사용자에게 출구가 생긴다', lib3.resumeVerdict(H({ resetsAt: null, probes: 2 }), null, true, NOW), { kind: 'ready' })
eq('★★ 시각 미상 — 20회차에도 갇히지 않는다(크리틱 20/20 hold의 자리)', lib3.resumeVerdict(H({ resetsAt: null, probes: 19 }), null, true, NOW), { kind: 'ready' })
eq('상한 초과여도 리셋이 아직 미래면 안 쏜다', lib3.resumeVerdict(H({ resetsAt: NOW + 3600, probes: 9 }), null, true, NOW), { kind: 'hold', resetsAt: NOW + 3600, probes: 10 })
eq('시각을 아는 표는 상한과 무관하게 그 시각까지 기다린다(엔진 `known && !past`)', lib3.resumeVerdict(H({ resetsAt: NOW + 5, probes: 99 }), null, true, NOW), { kind: 'hold', resetsAt: NOW + 5, probes: 100 })
eq('물어봤고 막는 창이 없다 → 풀렸다', lib3.resumeVerdict(H(), null, false, NOW), { kind: 'ready' })

// ★R28c RCAP — **재발사 상한**(RVERD 확인 크리틱 R1 §3.1). R28b의 상한은 `probes`(재확인)만
// 셌고 그건 **한 대기표 안에서만** 산다. 쏜 턴이 또 죽어 새 표가 서면 백지라 주기가 영원히
// 돌았다(5시간 27회). `attempts`(재발사)는 표를 건너 물려받고, 넘기면 `ready + paused`다 —
// 엔진 `runtime.rs`의 `attempts >= MAX_AUTO_ATTEMPTS → auto_paused`와 같은 착지.
eq('재발사 계수 1(상한 안) → 눈감은 발사는 아직 허용', lib3.resumeVerdict(H({ resetsAt: null, probes: 2, attempts: 1 }), null, true, NOW), { kind: 'ready' })
eq('★★ 재발사 계수 2(상한) → ready지만 자동은 접힌다', lib3.resumeVerdict(H({ resetsAt: null, probes: 2, attempts: 2 }), null, true, NOW), { kind: 'ready', paused: true })
eq('★★ 조회가 "풀렸다"고 해도 상한을 넘긴 표는 접는다', lib3.resumeVerdict(H({ attempts: 2 }), null, false, NOW), { kind: 'ready', paused: true })
eq('아직 막혔다는 신선한 증거가 먼저다(상한과 무관)', lib3.resumeVerdict(H({ attempts: 9 }), NOW + 3600, false, NOW), { kind: 'hold', resetsAt: NOW + 3600, probes: 0 })
eq('재발사 상한은 엔진과 같은 값', lib3.MAX_AUTO_ATTEMPTS, 2)
eq('재확인 상한은 이름이 바뀌었을 뿐 값은 그대로', lib3.MAX_RECHECKS, 2)
eq('attempts 복원(위생) — 재시작이 상한을 지우면 껐다 켤 때마다 두 발이다', lib3.sanitizeHold({ ...H({ attempts: 2 }), at: NOW_MS - 1000 }, NOW_MS)?.attempts, 2)
eq('attempts 오염(음수)은 버린다', lib3.sanitizeHold({ ...H({ attempts: -3 }), at: NOW_MS - 1000 }, NOW_MS)?.attempts, undefined)
eq('autoPaused는 영속하지 않는다(ready와 같은 규약)', lib3.sanitizeHold({ ...H({ attempts: 2, autoPaused: true }), at: NOW_MS - 1000 }, NOW_MS)?.autoPaused, undefined)

// 배너의 버튼 조건 — `LimitHoldBar`의 비-`managed` 갈래가 **이 함수**를 본다(Chat.tsx).
// 엔진 축의 `canPressResume`과 같은 규칙: 아무도 안 쏘는 `ready`에만 버튼을 준다.
eq('★ 접힌 표에는 버튼', lib3.canPressContinue(H({ ready: true, autoPaused: true })), true)
eq('그냥 ready는 소진 effect가 삼킨다 — 버튼 없음(침묵 no-op 금지)', lib3.canPressContinue(H({ ready: true })), false)
eq('대기 중인 표에는 버튼 없음', lib3.canPressContinue(H({ probes: 1 })), false)
eq('표가 없으면 버튼 없음', lib3.canPressContinue(null), false)

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
let cxAnswer = []
let cxCalls = 0
globalThis.window = {
  api: {
    getUsage: async () => {
      usageCalls++
      if (usageAnswer === 'throw') throw new Error('boom')
      return usageAnswer
    },
    // ★R28b RVERD — codex 축의 재검증 재료. R1까지 이 자리는 **언제나 `[]`**였다
    // (`codex-auth:accounts-usage`가 Rust에 없어 심이 빈 배열로 갈음 — 크리틱 §4.1 라이브
    // 실측). 채널이 생겼으므로 하네스도 값을 돌려줄 수 있어야 한다.
    codexAuth: {
      accountsUsage: async () => {
        cxCalls++
        if (cxAnswer === 'throw') throw new Error('boom')
        return cxAnswer
      }
    }
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

/** 대기표 하나를 장전한 훅 호스트를 만든다. props는 화면이 실제로 넘기는 모양 그대로.
 *  `text`를 주면 그 문구로 죽은 턴을 만든다(codex 한도 문구에는 `…|epoch` 꼬리가 없다). */
function mountArmed(props, text, mod = hookMod) {
  timers.length = 0 // 앞 시나리오의 호스트가 걸어 둔 타이머와 섞이지 않게(가짜 시계 초기화)
  const errText = text ?? 'Claude AI usage limit reached|' + (NOW - 100)
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
  // `mod`는 훅과 훅 런타임(stub)을 **같은 번들에서** 꺼내야 한다 — 스텁의 `cur`가 모듈
  // 스코프라 두 번들을 섞으면 훅이 남의 셀 배열을 읽는다(I절의 대조군이 그 자리다).
  const host = mod.__mount(() => {
    handle = mod.useLimitResume(o)
    return null
  })
  // 장전 조건: 방금 돌던 턴(working)이 error로 끝났다 = status 상승 에지
  o.state = { ...state, status: 'error' }
  host.render()
  return { host, o, get hold() { return handle.hold }, get api() { return handle } }
}

/** 쏜 재개 턴이 **같은 한도 에러로 또 죽는다** — 앱이 실제로 밟는 경로(busy 상승 →
 *  status:error → 재장전). I절의 주행이 이 한 걸음을 반복한다. */
async function rearm(h, text) {
  const errText = text ?? 'Claude AI usage limit reached|' + (NOW - 100)
  h.o.busy = true
  h.o.state = { ...h.o.state, status: 'working' }
  h.host.render()
  await flush()
  h.o.busy = false
  h.o.state = {
    ...h.o.state,
    status: 'error',
    messages: [...h.o.state.messages, { kind: 'msg', role: 'user', text: '이어서' }, { kind: 'msg', role: 'assistant', text: errText, error: true }]
  }
  h.host.render()
  await flush()
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

  // ② ★R28b RVERD — 시각 미상(배너형 문구·codex 한도 문구)의 표에도 **출구가 있다.**
  //    R1까지 이 자리는 「상한을 넘겨도 절대 안 쏜다」였고, 그래서 조회가 죽어 있는 동안
  //    그 대기표는 재확인만 무한 반복했다(크리틱 실측 20/20 hold). 상한 안(1·2회차)에서는
  //    그대로 유지하고, 넘기면 사용자에게 넘긴다 — 엔진이 `runtime.rs:3240`에서 한 것과 같다.
  sent.length = 0
  h = mountArmed(props)
  h.host.render()
  // 문구 꼬리가 없는 판을 손으로 만든다(배너형 = resetsAt null)
  h.hold && (h.hold.resetsAt = null)
  await tick(h)
  eq(`${name} 시각 미상 1회차 → 유지(전송 0)`, { hold: !!h.hold, ready: !!h.hold?.ready, probes: h.hold?.probes, sent: sent.length }, { hold: true, ready: false, probes: 1, sent: 0 })
  await tick(h)
  eq(`${name} 시각 미상 2회차 → 여전히 유지`, { hold: !!h.hold, ready: !!h.hold?.ready, probes: h.hold?.probes, sent: sent.length }, { hold: true, ready: false, probes: 2, sent: 0 })
  await tick(h)
  eq(`${name} ★★ 시각 미상 3회차 → 출구(대기표 소진 · 전송 1)`, { hold: h.hold, sent: sent.length }, { hold: null, sent: 1 })
  // 더 돌려도 두 번 쏘지 않는다(표가 없으면 타이머도 없다).
  for (let i = 0; i < 3; i++) await tick(h)
  eq(`${name} 출구 뒤 추가 전송 0`, sent.length, 1)

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

// ── H. ★R28b RVERD — codex 축(멀티 패널의 그 표면) ──────────────────────────
//
// 이 절이 재는 것은 **두 수정이 만나는 자리**다:
//   ① `codex-auth:accounts-usage`가 Rust에 생겨 재검증이 값을 얻는다(R1까진 언제나 `[]`).
//   ② 값을 못 얻는 판(빈 배열)에서도 대기표에 출구가 있다.
// codex 한도 문구에는 `…|epoch` 꼬리가 없다 = 대기표의 `resetsAt`이 null이다. 그 표가
// 갇히던 자리가 정확히 크리틱 §4.1이고, 멀티 패널·팝아웃은 이 기계를 아직 쓴다.
console.log('\nH. codex 축 — 채널이 값을 주는 판 / 못 주는 판')
tag = 'codex'
const CX_PROPS = { holdKey: '0', account: 'me@openai.com', engine: 'codex' }
const CX_BANNER = "You've hit your usage limit. Try again later."
const cxRow = (email, pct, at) => ({ email, planType: 'plus', windows: [{ label: '주간', usedPct: pct, resetsAt: at }] })

// ① 채널이 빈 배열(= R1의 미구현 셸) — 「못 물어봤다」가 무한히 반복되던 자리.
sent.length = 0
cxAnswer = []
cxCalls = 0
let hc = mountArmed(CX_PROPS, CX_BANNER)
eq('codex 대기표는 시각 미상이다(문구에 꼬리가 없다)', { hold: !!hc.hold, resetsAt: hc.hold ? hc.hold.resetsAt : 'no-hold' }, { hold: true, resetsAt: null })
await tick(hc)
await tick(hc)
eq('★ 채널이 빈 배열이면 2회차까지 유지(전송 0)', { hold: !!hc.hold, probes: hc.hold?.probes, sent: sent.length }, { hold: true, probes: 2, sent: 0 })
await tick(hc)
eq('★★ 그래도 3회차엔 출구가 있다(크리틱 20/20 hold의 자리)', { hold: hc.hold, sent: sent.length }, { hold: null, sent: 1 })
ok('빈 배열도 실제로 물어본 결과다', cxCalls >= 3, `cxCalls=${cxCalls}`)

// ② 채널이 **소진된 창**을 준다 — 그 시각으로 재장전하고 안 쏜다(클로드 축 ⑤와 같은 규약).
sent.length = 0
cxAnswer = [cxRow('me@openai.com', 100, REAL + 3600)]
hc = mountArmed(CX_PROPS, CX_BANNER)
await flush()
await flush()
hc.host.render()
eq('★ 장전 직후 정제 — 채널의 창 시각이 대기표에 앉는다', hc.hold?.resetsAt, REAL + 3600)
await tick(hc)
eq('★ 아직 막힘 → 그 시각으로 재장전 · 전송 0', { resetsAt: hc.hold?.resetsAt, probes: hc.hold?.probes, sent: sent.length }, { resetsAt: REAL + 3600, probes: 0, sent: 0 })

// ③ 채널이 **여유 있는 창**을 준다 — 풀렸다 = 즉시 이어서.
sent.length = 0
cxAnswer = [cxRow('me@openai.com', 5, REAL + 3600)]
hc = mountArmed(CX_PROPS, CX_BANNER)
await tick(hc)
eq('★ 창이 여유 → 이어서 전송 1회', { hold: hc.hold, sent: sent.length }, { hold: null, sent: 1 })

// ④ 계정이 여럿이면 **자기 계정 행**을 고른다(남의 소진 창에 갇히지 않는다).
sent.length = 0
cxAnswer = [cxRow('other@openai.com', 100, REAL + 7200), cxRow('me@openai.com', 5, REAL + 3600)]
hc = mountArmed(CX_PROPS, CX_BANNER)
await tick(hc)
eq('★ 남의 계정이 소진돼도 내 표는 풀린다', { hold: hc.hold, sent: sent.length }, { hold: null, sent: 1 })

// ⑤ 계정 미지정(= codex 기본 계정)이면 첫 행 — 그 행이 막혀 있으면 유지한다.
sent.length = 0
cxAnswer = [cxRow('first@openai.com', 100, REAL + 7200)]
hc = mountArmed({ ...CX_PROPS, account: undefined }, CX_BANNER)
await tick(hc)
eq('★ 계정 미지정이면 첫 행(기본 계정)으로 판정', { resetsAt: hc.hold?.resetsAt, sent: sent.length }, { resetsAt: REAL + 7200, sent: 0 })

// ⑥ 채널이 던지는 판도 실패로 읽는다(유지 — 상한 전까지).
sent.length = 0
cxAnswer = 'throw'
hc = mountArmed(CX_PROPS, CX_BANNER)
await tick(hc)
eq('채널이 던져도 유지', { hold: !!hc.hold, probes: hc.hold?.probes, sent: sent.length }, { hold: true, probes: 1, sent: 0 })
cxAnswer = []

// 본채팅은 엔진이 대기표를 들면 손을 뗀다(재개 주체 하나) — 그 성질이 살아 있나.
tag = 'managed'
sent.length = 0
usageAnswer = G_FREE
const hm = mountArmed({ holdKey: 'chat-1', account: 'a@b.c', managed: true })
eq('managed면 장전 자체를 안 한다', { hold: hm.hold, timers: timers.length, sent: sent.length }, { hold: null, timers: 0, sent: 0 })

// ── I. ★R28c RCAP — **재발사 상한**: 5시간 창 하나에 몇 발인가 ────────────────
//
// RVERD 확인 크리틱 R1 §3.1의 최대 격차: R28b가 낸 출구는 버튼이 아니라 **발사**였고
// 그 발사에 상한이 없었다. 상한은 `probes`(재확인)뿐이었는데 그건 **한 대기표 안에서만**
// 산다 — 쏜 턴이 같은 한도로 또 죽으면 새 표가 백지(`probes:0`)로 서서 주기가 영원히 돈다.
// 크리틱 실측: 채널이 계속 빈 배열인 판에서 **5시간에 27회**(11·22·32…290분).
//
// 여기서는 그 주행을 하네스로 옮긴다. 판은 크리틱과 같다 — 시각 미상 대기표(codex 한도
// 문구엔 `…|epoch` 꼬리가 없다) + 조회가 계속 실패 + 쏜 턴이 같은 한도로 또 죽는다.
// 한 대기표의 벽시계는 `PROBE_MS 600s + 15s + 30s = 645s`다.
console.log('\nI. 재발사 상한 — 5시간 주행(크리틱 R1 §3.1 재현)')
tag = 'RCAP'

const FIVE_H = 5 * 3600_000
const I_PROPS = { holdKey: 'slot-0', account: 'a@b.c' }

/** 대기표가 서고 → 쏘고 → 그 턴이 또 죽고를 5시간(가짜 시계)까지 반복한다.
 *  멎는 자리는 둘 중 하나: 자동이 접힌 표(`autoPaused`)이거나, 5시간을 다 쓴 것. */
async function blindRun(mod, text) {
  sent.length = 0
  const h = mountArmed(I_PROPS, text, mod)
  let clock = 0
  const fired = []
  let guard = 0
  while (clock < FIVE_H && guard++ < 900) {
    if (h.hold && !h.hold.ready) {
      const ms = await tick(h)
      if (ms == null) break
      clock += ms
      continue
    }
    if (!h.hold) {
      fired.push(clock) // 방금 쐈다 — 그 턴이 같은 한도로 또 죽는다
      await rearm(h, text)
      continue
    }
    break // `ready`인 채 멎었다 = 자동을 접었다(사용자의 버튼 차례)
  }
  return { h, clock, fired }
}

usageAnswer = FAIL_VALUE // 조회가 계속 죽어 있는 판(크리틱이 27회를 잰 그 판)
const now = await blindRun(hookMod, CX_BANNER)
eq('★★ 5시간 눈감은 재발사 = 상한(2)에서 멎는다', { fires: now.fired.length, sent: sent.length }, { fires: 2, sent: 2 })
eq('★ 발사 시각은 645초 · 1290초(대기표당 600+15+30)', now.fired, [645_000, 1_290_000])
eq(
  '★★ 세 번째 표는 ready지만 자동은 접혔다(엔진 auto_paused 짝)',
  { ready: !!now.h.hold?.ready, paused: !!now.h.hold?.autoPaused, attempts: now.h.hold?.attempts },
  { ready: true, paused: true, attempts: 2 }
)
eq('★ 접힌 표는 아무것도 안 태운다 — 타이머 0', timers.length, 0)
for (let i = 0; i < 5; i++) await tick(now.h)
eq('★ 더 돌려도 발사 0(주기가 끊겼다)', sent.length, 2)
ok('★ 멎은 시각은 32분대 — 5시간을 다 쓰지 않는다', now.clock < 40 * 60_000, `${Math.round(now.clock / 60_000)}분`)

// 대조군 — **R28b 판을 그대로 꺼내** 같은 대본을 먹인다. 27이 나와야 이 절의 주장이 선다.
const PRE_REF = '63bf667' // R28b RVERD R1 = 크리틱이 27회를 실측한 판
const preDir = path.join(tmp, 'pre-r28b')
let preMod = null
try {
  fs.mkdirSync(preDir, { recursive: true })
  for (const f of ['limitResume.ts', 'useLimitResume.ts']) {
    const src = execFileSync('git', ['show', `${PRE_REF}:app/src/lib/${f}`], { cwd: root, maxBuffer: 1 << 24 }).toString('utf8')
    // 훅이 값으로 쓰는 유일한 이웃은 `t()`다. A/B 축이 아니므로 **레포의 현재 사본**을
    // 절대 경로로 가리킨다(i18n은 다시 './prefs'를 부른다 — 복사하면 그 이웃이 끊긴다).
    fs.writeFileSync(path.join(preDir, f), src.replace(/from '\.\/i18n'/g, `from ${imp(path.join(root, 'app/src/lib/i18n.ts'))}`))
  }
  const preEntry = path.join(tmp, 'pre-entry.mjs')
  fs.writeFileSync(preEntry, `export { useLimitResume } from ${imp(path.join(preDir, 'useLimitResume.ts'))}\nexport { __mount } from ${imp(stubPath)}\n`)
  preMod = await bundle(preEntry, 'pre-hook.mjs', { alias: { react: stubPath } })
} catch (e) {
  console.log(`   (대조군 ${PRE_REF} 판을 못 꺼냈다 — 건너뛴다: ${String(e.message).split('\n')[0]})`)
}
if (preMod) {
  const pre = await blindRun(preMod, CX_BANNER)
  eq(`★★ 대조군(${PRE_REF}) — 같은 5시간에 27회`, pre.fired.length, 27)
  ok('대조군의 간격도 645초 정각', pre.fired[0] === 645_000 && pre.fired[26] === 27 * 645_000, JSON.stringify(pre.fired.slice(0, 3)))
  ok('대조군의 마지막 표는 살아 있다(끝이 없다)', !!pre.h.hold && !pre.h.hold.autoPaused, JSON.stringify(pre.h.hold))
  console.log(
    `   A/B — 5시간 눈감은 재발사: R28b(${PRE_REF}) ${pre.fired.length}회 · 마지막 ${Math.round(pre.fired[pre.fired.length - 1] / 60_000)}분` +
      `  →  HEAD ${now.fired.length}회 · ${Math.round(now.clock / 60_000)}분에 자동 정지`
  )
}

// ② 사용자가 누르는 출구 — 접힌 표의 **유일한** 발사구이고, 누른 재개는 세지 않는다.
console.log('   ② 「이어가기」(resumeNow) — 누른 재개는 상한이 세지 않는다')
usageAnswer = FAIL_VALUE
const hp = await blindRun(hookMod, CX_BANNER)
ok('접힌 표가 서 있다', hp.h.hold?.ready === true && hp.h.hold?.autoPaused === true, JSON.stringify(hp.h.hold))
hp.h.api.resumeNow()
hp.h.host.render()
await flush()
eq('★★ 누르면 그 자리에서 보낸다(표 소진)', { hold: hp.h.hold, sent: sent.length }, { hold: null, sent: 3 })
ok('보낸 문구는 이어서(세션 있음)', /이어서|continue/i.test(sent[2] ?? ''), sent[2])
await rearm(hp.h, CX_BANNER)
eq('★★ 누른 재개 뒤의 새 표는 백지 — 버튼이 한 번 쓰고 버리는 것이 되지 않는다', hp.h.hold?.attempts, undefined)

// ③ 계수가 0으로 돌아가는 나머지 두 자리(엔진 `!limited` · `origin == User`의 짝).
console.log('   ③ 계수 리셋 — 한도가 아닌 착지 / 사용자가 직접 보냄')
sent.length = 0
const hb = mountArmed(I_PROPS, CX_BANNER)
for (let i = 0; i < 3; i++) await tick(hb)
eq('첫 표는 한 발 쏜다', { hold: hb.hold, sent: sent.length }, { hold: null, sent: 1 })
await rearm(hb, 'Command failed with exit code 1') // 이번엔 한도가 아닌 이유로 죽었다
eq('한도가 아닌 착지에는 표가 안 선다', hb.hold, null)
await rearm(hb, CX_BANNER)
eq('★ 한도가 아닌 착지가 연쇄를 끊는다 — 다음 표는 백지', hb.hold?.attempts, undefined)

sent.length = 0
const hu = mountArmed(I_PROPS, CX_BANNER)
for (let i = 0; i < 3; i++) await tick(hu)
await rearm(hu, CX_BANNER)
eq('두 번째 표는 계수 1을 물려받는다', hu.hold?.attempts, 1)
// 표가 **선 채로** busy가 올라갔다 = 사용자가 직접 보냈다(자동 재발사는 표를 먼저 걷는다)
await rearm(hu, CX_BANNER)
eq('★ 사용자가 직접 보내면 표가 걷히고 계수도 0 — 다음 표는 백지', hu.hold?.attempts, undefined)

// ✕(대기 취소)도 같은 문(`setHold(null)`)을 지난다 — 취소한 표의 계수가 다음 표에 남으면
// 사용자는 ✕를 누른 것만으로 다음 한도에서 「자동 멈춤」을 만나게 된다.
sent.length = 0
const hx = mountArmed(I_PROPS, CX_BANNER)
for (let i = 0; i < 3; i++) await tick(hx)
await rearm(hx, CX_BANNER)
eq('취소 전 표는 계수 1', hx.hold?.attempts, 1)
hx.api.setHold(null) // 사용자가 ✕
hx.host.render()
await rearm(hx, CX_BANNER)
eq('★ ✕로 취소한 뒤의 새 표도 백지', hx.hold?.attempts, undefined)

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} 통과, ${fail} 실패`)
process.exit(fail === 0 ? 0 : 1)
