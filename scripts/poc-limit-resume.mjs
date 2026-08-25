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
function mountArmed(props, text, mod = hookMod, thread = null) {
  timers.length = 0 // 앞 시나리오의 호스트가 걸어 둔 타이머와 섞이지 않게(가짜 시계 초기화)
  const errText = text ?? 'Claude AI usage limit reached|' + (NOW - 100)
  // ★R28e WFIRE — `thread`는 배열(손 픽스처) 또는 **스토어 상태 통째**(K·L절)다. 뒤쪽이면
  // `messages`만이 아니라 `turnMark`도 같이 가져온다 — 훅이 그 둘을 함께 읽기 때문이다.
  const st = Array.isArray(thread) ? { messages: thread } : (thread ?? {})
  const state = {
    status: 'working',
    session: 'ses-1',
    interrupted: false,
    // 첫 표는 계수가 0이라 수명 판정에 안 닿는다(『carriedAttempts』 첫 줄) — 그래도
    // 실물과 같은 모양으로 둔다: 스토어는 턴을 열 때마다 이 값을 놓는다.
    turnAt: Date.now(),
    turnMark: st.turnMark ?? null,
    // `thread`를 주면 **실제 스토어 리듀서가 지은 스레드**로 장전한다(K절) — 손으로 만든
    // 픽스처가 스토어가 결코 만들지 않는 모양일 위험을 없앤다(WCAP 확인 크리틱 R2 §4.3).
    messages: st.messages ?? [
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
 *  status:error → 재장전). I절의 주행이 이 한 걸음을 반복한다.
 *
 *  ★R28d WCAP — `work:true`면 그 턴이 **죽기 전에 일을 한** 스레드를 만든다(어시스턴트
 *  답 + 도구 그룹). 앱에서 5시간을 꽉 채워 일하고 다음 창에서 막힌 재개가 정확히 이
 *  모양이다 — 사용자 말풍선 뒤에 출력이 쌓이고 맨 끝에 한도 오류 말풍선이 붙는다. */
async function rearm(h, text, opts = {}) {
  const errText = text ?? 'Claude AI usage limit reached|' + (NOW - 100)
  h.o.busy = true
  h.o.state = { ...h.o.state, status: 'working' }
  h.host.render()
  await flush()
  h.o.busy = false
  // ★R2 — `think`는 **화면에 안 남는 산출**의 대역이다(엔진의 `thinking_delta` 짝).
  // 스토어가 착지마다 걷어내는 말풍선이라 실물 스레드엔 없지만, 여기서는 일부러 남겨
  // 「그래도 안 세는가」를 잰다 — 엔진이 12시간에 71발을 내던 바로 그 구멍이다.
  const did = opts.think
    ? [{ id: 'thinking', kind: 'msg', role: 'assistant', text: '어디부터 볼까…' }]
    : opts.work
      ? [
          { kind: 'msg', role: 'assistant', text: '리팩터링을 끝냈어' },
          { kind: 'toolgroup', tools: [{ id: 'tool-1', name: 'Edit' }] }
        ]
      : []
  // ★R3 — **도구가 턴 경계를 넘는 판**(WCAP 확인 크리틱 R2 §3.3의 P12). 스토어의 `tool-end`는
  // 있는 도구를 **제자리에서 패치만** 하므로, 앞 턴에서 열린 도구의 결과가 이 턴에 뒤늦게
  // 와도 그 도구 그룹은 재개 사용자 말풍선 **앞**에 그대로 있다. 그 배치가 이 줄이다 —
  // 그러니 이 턴 구간(사용자 말풍선 뒤)은 오류 말풍선 하나뿐이고 `turnDidWork`는 거짓이다.
  const stale = opts.crossTool
    ? [{ kind: 'toolgroup', id: 'tg-prev', tools: [{ id: 'toolu-0', name: 'Read', status: 'ok' }] }]
    : []
  // ★R28e WFIRE — **그 턴이 얼마나 살았나.** 스토어가 턴을 열 때 놓는 `turnAt`을 뒤로
  // 밀어 수명을 만든다(`Date.now() - turnAt`). 기본 0 = *프롬프트를 받은 자리에서 즉사* —
  // 그 모양이 크리틱 §5.1의 71발이고, 이제 「일했다」로 안 쳐 준다. 진짜로 창을 태운 재개는
  // `lifeMs`를 준다(엔진 못의 `work_ms`와 같은 손잡이).
  const lifeMs = opts.lifeMs ?? 0
  h.o.state = {
    ...h.o.state,
    status: 'error',
    turnAt: Date.now() - lifeMs,
    messages: [
      ...h.o.state.messages,
      ...stale,
      { kind: 'msg', role: 'user', text: '이어서' },
      ...did,
      { kind: 'msg', role: 'assistant', text: errText, error: true }
    ]
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

// ── J. ★R28d WCAP — 상한이 「헛발질」과 「일한 재개」를 가른다 ────────────────
//
// RCAP 확인 크리틱 R1 §4.1의 최대 격차: `attempts`는 **한도로 죽은 착지마다** 올랐고,
// 그 턴이 30초 만에 같은 벽에 부딪혔는지 5시간을 꽉 채워 일하고 다음 창에서 막혔는지를
// 아무도 안 봤다(크리틱 실측: 조회가 매번 「풀렸다」고 답하는 판에서도
// `attempts=1 → attempts=2 → PAUSED`). 현실 시나리오는 22시 한도 → 03시 재개(성공) →
// 08시 새 한도 → … 인데, 그 밤샘 주행이 **창 두 개**에서 잘리고 배너는 「자동으로 이어서
// 보낸 턴이 계속 한도에 막혔어요」라고 말한다 — 그 턴들은 막힌 게 아니라 일했다.
//
// 구분자 둘을 받는다(엔진 `crates/ccg-engine/src/runtime.rs::arm_hold`가 같은 둘을 같은
// 순서로 본다): ① 새 문구의 리셋 시각이 직전에 쏜 표보다 **뒤**이고 **아직 오지 않았다** /
// ② 그 턴이 어시스턴트 출력·도구 호출을 **하나라도** 냈다. **OR가 아니라 우선순위다** —
// 시각을 둘 다 아는 판은 ①이 완전한 답을 주므로 시계가 판정하고, 한쪽이라도 미상인
// 판(codex 배너형)만 ②가 든다. OR로 두면 「토큰 한 줄 내고 같은 벽에 다시 부딪히는」 판에서
// 계수가 영영 0이 돼 RCAP이 막은 무한 재발사가 그대로 돌아온다(아래 ④가 그 자리를 잠근다 —
// 엔진 초안 실측 6시간 39발, `crates/ccg-engine/tests/wcap_limit_streak.rs`).
//
// 상한·버튼·계승 구조는 RCAP 그대로 두고 리셋 조건만 더한 것이라, 이 절은 **양쪽을 같이
// 잰다**: 일한 재개는 안 잘리는가, 그리고 헛발질은 여전히 2발인가.
console.log('\nJ. 일한 재개는 상한이 세지 않는다(RCAP 확인 크리틱 R1 §4.1)')
tag = 'WCAP'

// ① 순수 판정 — 구분자 둘.
console.log('   ① windowRolled / turnDidWork / carriedAttempts')
eq('창이 넘어갔다(새 리셋이 더 뒤 · 아직 안 옴)', lib3.windowRolled(NOW - 3600, NOW + 5 * 3600, NOW), true)
eq('같은 벽 — 꼬리의 epoch이 그대로면 안 넘어간 것', lib3.windowRolled(NOW, NOW, NOW), false)
eq('되레 앞이면 안 넘어간 것(낡은 캐시)', lib3.windowRolled(NOW, NOW - 10, NOW), false)
// ★ 두 번째 다리 — **이미 지난 시각**을 새 벽이라고 내미는 문구는 넘어간 증거가 아니다.
//   엔진에서는 이 다리가 하중을 다 진다(`epoch_secs_to_runtime`이 지난 epoch을 `now`로 접는다).
eq('★★ 더 뒤이긴 한데 이미 지난 시각 = 안 넘어간 것', lib3.windowRolled(NOW - 7200, NOW - 60, NOW), false)
eq('직전 시각 미상 = 모른다(넘어간 증거 아님)', lib3.windowRolled(null, NOW + 3600, NOW), false)
eq('이번 시각 미상 = 모른다(codex 배너형)', lib3.windowRolled(NOW, null, NOW), false)

const J_USER = { kind: 'msg', role: 'user', text: '이어서' }
const J_ERR = { kind: 'msg', role: 'assistant', text: 'Claude AI usage limit reached', error: true }
eq('문전박대 턴 — 오류 말풍선 하나뿐이면 일한 게 아니다', lib3.turnDidWork([J_USER, J_ERR]), false)
eq('★ 어시스턴트 출력이 있으면 일했다', lib3.turnDidWork([J_USER, { kind: 'msg', role: 'assistant', text: '고쳤어' }, J_ERR]), true)
eq('★ 도구 호출이 있으면 일했다', lib3.turnDidWork([J_USER, { kind: 'toolgroup', tools: [{ id: 't1' }] }, J_ERR]), true)
eq('빈 도구 그룹은 안 센다(그룹은 도구보다 먼저 열린다)', lib3.turnDidWork([J_USER, { kind: 'toolgroup', tools: [] }, J_ERR]), false)
eq('공백뿐인 어시스턴트 텍스트도 안 센다', lib3.turnDidWork([J_USER, { kind: 'msg', role: 'assistant', text: '   ' }, J_ERR]), false)
eq('오류 말풍선 자체는 출력이 아니다(세면 모든 턴이 「일했다」가 된다)', lib3.turnDidWork([J_USER, J_ERR, J_ERR]), false)
eq('직전 턴의 출력은 이 턴의 것이 아니다 — 사용자 말풍선이 경계', lib3.turnDidWork([{ kind: 'msg', role: 'assistant', text: '어제 한 일' }, J_USER, J_ERR]), false)
eq('빈 스레드', lib3.turnDidWork([]), false)
eq('널 스레드', lib3.turnDidWork(null), false)
// ★R2 — **파리티 문턱의 못**(WCAP 확인 크리틱 R1 §3.2). 엔진이 갈라진 자리가 정확히
// 여기다: 프레임 축의 `saw_turn_activity`는 `ping`·`message_start`·`thinking_delta`
// 한 장에도 서서 같은 12시간 대본에 71발(렌더러는 2발)을 냈다. 엔진을 이 문턱으로
// 좁혔으므로(`crates/ccg-engine/src/runtime.rs::Turn::saw_turn_output`), 이 절의 다음
// 네 줄이 그 71 대 2의 렌더러 쪽 잠금이다 — 여기가 넓어지면 엔진도 같이 넓어져야 한다.
const J_THINK = { id: 'thinking', kind: 'msg', role: 'assistant', text: '어디부터 볼까…' }
eq('★★ 추론 말풍선은 출력이 아니다(엔진 thinking_delta 71발의 짝)', lib3.turnDidWork([J_USER, J_THINK, J_ERR]), false)
eq('★ 추론뿐인 턴 — 오류조차 없어도 거짓', lib3.turnDidWork([J_USER, J_THINK]), false)
eq('★ 추론을 건너뛰어도 그 아래 진짜 출력은 본다', lib3.turnDidWork([J_USER, { kind: 'msg', role: 'assistant', text: '고쳤어' }, J_THINK]), true)
eq('★ 추론은 사용자 경계도 못 가린다', lib3.turnDidWork([{ kind: 'msg', role: 'assistant', text: '어제 한 일' }, J_USER, J_THINK, J_ERR]), false)
// ★R3 정정(크리틱 R2 §4.3) — 위 네 줄의 픽스처 `{id:'thinking', kind:'msg'}`는 **스토어가
// 결코 만들지 않는 모양**이다. 실물은 `{kind:'thinking'}`이고(`app/src/store/session.ts:36`)
// `turnDidWork`는 `kind`가 `'msg'`/`'toolgroup'`인 것만 보므로 `THINKING_ID` 줄이 없어도
// 거짓이다. 그러니 이 줄이 **실물 모양의** 못이고, 위 넷은 옛 모양 대비 방어선이다.
const J_THINK_STORE = { id: 'thinking', kind: 'thinking', text: '어디부터 볼까…' }
eq('★★ 스토어의 실제 추론 항목(kind:thinking)은 출력이 아니다', lib3.turnDidWork([J_USER, J_THINK_STORE, J_ERR]), false)
eq('★ 실제 추론 항목도 사용자 경계를 못 가린다', lib3.turnDidWork([{ kind: 'msg', role: 'assistant', text: '어제 한 일' }, J_USER, J_THINK_STORE, J_ERR]), false)

// ★R3 — **P12의 렌더러 쪽**(WCAP 확인 크리틱 R2 §3.3). 스토어의 `tool-end`는 있는 도구를
// 제자리에서 패치만 하고 항목을 새로 붙이지 않으므로, 앞 턴에서 열린 도구의 결과가 재개 턴에
// 뒤늦게 와도 그 그룹은 사용자 말풍선 **앞**에 남는다 = 이 턴의 산출이 아니다. 엔진이 이
// 다리에서 갈라져 있었다(같은 12시간 대본에 엔진 71발 / 렌더러 2발) — 지금은 엔진도 이
// 경계로 센다(`crates/ccg-engine/tests/wcap_limit_streak.rs` ⑦).
const J_TG = { kind: 'toolgroup', id: 'tg1', tools: [{ id: 'toolu-0', name: 'Read' }] }
eq('★★ 앞 턴에서 열린 도구 그룹은 이 턴의 산출이 아니다(엔진 71발의 짝)', lib3.turnDidWork([J_TG, J_USER, J_ERR]), false)
eq('★ 같은 턴에서 열린 도구 그룹은 산출이다(과잉 절단 방지)', lib3.turnDidWork([J_USER, J_TG, J_ERR]), true)

const J_WORKED = [J_USER, { kind: 'msg', role: 'assistant', text: 'ok' }, J_ERR]
// ★R28e WFIRE — `carriedAttempts`의 넷째 인자가 **증거 한 벌**(`TurnEvidence`)이 됐다.
// `ms`(그 턴이 산 시간)를 안 주면 「모른다」이고, 모르는 것은 「일했다」가 아니다 —
// 상한이 「모른다」로 지워지면 그건 상한이 아니다. 아래 기본값은 문턱을 **넘는** 수명이라
// R28d의 이 못들이 재던 것(무엇을 산출로 세는가)은 한 글자도 안 바뀐 채로 남는다.
const LONG = 20 * 60_000 // ≫ MIN_WORK_MS(5분)
const EV = (items, ms = LONG, mark = null) => ({ items, ms, mark })
eq('계수가 0이면 볼 것도 없다', lib3.carriedAttempts(0, NOW, NOW, EV([J_USER, J_ERR]), NOW), 0)
eq('헛발질이면 계수를 그대로 물려받는다(RCAP 불변)', lib3.carriedAttempts(2, NOW, NOW, EV([J_USER, J_ERR]), NOW), 2)
eq('★★ 창이 넘어갔으면 0', lib3.carriedAttempts(2, NOW - 3600, NOW + 5 * 3600, EV([J_USER, J_ERR]), NOW), 0)
eq('★★ 꼬리가 없어도 그 턴이 일했으면 0(codex 축)', lib3.carriedAttempts(2, null, null, EV([J_USER, { kind: 'toolgroup', tools: [{ id: 't' }] }, J_ERR]), NOW), 0)
eq('직전 표만 시각을 알아도 미상 판 — 일한 흔적이 판정한다', lib3.carriedAttempts(2, NOW, null, EV(J_WORKED), NOW), 0)
eq('이번 문구만 시각을 알아도 미상 판', lib3.carriedAttempts(2, null, NOW, EV(J_WORKED), NOW), 0)
// ★ 우선순위의 핵심 — 시각을 둘 다 아는데 벽이 그대로면, 그 턴이 무엇을 냈든 **못 넘은 것**이다.
//   여기서 ②로 뒤집으면 「토큰 한 줄 + 같은 벽」 판이 무한 재발사로 되돌아간다.
eq('★★ 시각을 둘 다 아는 판에서는 일한 흔적이 시계를 못 뒤집는다', lib3.carriedAttempts(2, NOW, NOW, EV(J_WORKED), NOW), 2)
eq('★ 되레 앞선 벽(지난 epoch 되돌림)도 못 넘은 것', lib3.carriedAttempts(2, NOW, NOW - 10, EV(J_WORKED), NOW), 2)
eq('★ 지난 벽을 되돌려 줘도 일한 흔적이 시계를 못 뒤집는다', lib3.carriedAttempts(2, NOW - 7200, NOW - 60, EV(J_WORKED), NOW), 2)
// ★R3 — 같은 경계가 `carriedAttempts`에도 그대로 서야 한다(시각 미상 축 = ②가 유일 판정자).
eq('★★ 앞 턴 도구 그룹은 계수를 못 지운다(codex 축)', lib3.carriedAttempts(2, null, null, EV([J_TG, J_USER, J_ERR]), NOW), 2)
eq('★ 이 턴이 연 도구 그룹은 계수를 지운다', lib3.carriedAttempts(2, null, null, EV([J_USER, J_TG, J_ERR]), NOW), 0)

// ② 밤샘 연속 주행 — 조회는 「풀렸다」고 답하고 재개는 실제로 일한다(크리틱의 그 판).
console.log('   ② 밤샘 주행 — 창을 여섯 번 넘어도 안 잘린다')
usageAnswer = G_FREE

/** «쏜다 → 그 턴이 착지한다»를 n번 돈다. 멎는 자리는 **접힌 표**(autoPaused) 하나다.
 *  `work`와 `tailOf`가 구분자 둘의 손잡이다 — 둘 다 끄면 그게 곧 헛발질(대조군)이다. */
async function nightRun(props, n, tailOf, work, opts = {}) {
  sent.length = 0
  const h = mountArmed(props, tailOf(0))
  const seen = []
  for (let i = 1; i <= n; i++) {
    if (!h.hold || h.hold.autoPaused) break
    await tick(h) // 리셋 도달 → 재검증 → ready → 소진 effect가 쏜다
    if (h.hold) break // 안 쐈다 = 자동이 접혔다
    await rearm(h, tailOf(i), { work, ...opts })
    seen.push(h.hold?.attempts ?? 0)
  }
  return { h, sent: sent.length, seen }
}

// 훅은 **진짜 시계**로 돈다(G절 주석) — 꼬리도 실시간 기준이어야 「아직 안 온 벽」이 된다.
// 첫 표(i=0)만 지난 시각이고(그래야 타이머가 곧 발화한다) 그다음부터 5시간씩 미래로 간다.
const J_TAIL = (i) => 'Claude AI usage limit reached|' + (REAL - 100 + i * 5 * 3600)
const J_SAME = () => 'Claude AI usage limit reached|' + (REAL - 100)
const night = await nightRun(I_PROPS, 6, J_TAIL, true)
eq('★★ 여섯 창을 내리 이어간다 — 계수가 한 번도 안 오른다', { sent: night.sent, seen: night.seen }, { sent: 6, seen: [0, 0, 0, 0, 0, 0] })
ok('★ 접힌 표가 없다(밤샘 주행이 안 잘린다)', !night.h.hold?.autoPaused, JSON.stringify(night.h.hold))

// 대조군 — **같은 대본에서 구분자 둘만 뺀다**(같은 벽 · 빈 턴). 상한은 그대로 서야 한다.
const dud = await nightRun(I_PROPS, 6, J_SAME, false)
eq('★★ 헛발질은 여전히 2발에서 멎는다(상한이 무뎌지지 않았다)', { sent: dud.sent, seen: dud.seen }, { sent: 2, seen: [1, 2] })
ok('★ 그 표는 접혀 있다(ready + autoPaused)', dud.h.hold?.ready === true && dud.h.hold?.autoPaused === true, JSON.stringify(dud.h.hold))
console.log(`   A/B — 같은 6창 대본: 일한 재개 ${night.sent}발(계수 ${JSON.stringify(night.seen)})  vs  헛발질 ${dud.sent}발(계수 ${JSON.stringify(dud.seen)})`)

// 구분자를 **하나씩만** 켜서 각각 혼자 작동하는지 본다(OR의 두 다리).
const onlyRoll = await nightRun(I_PROPS, 4, J_TAIL, false) // 창만 넘어간다(턴은 빈손)
eq('★ ① 창 이동만으로도 안 잘린다', { sent: onlyRoll.sent, seen: onlyRoll.seen }, { sent: 4, seen: [0, 0, 0, 0] })
cxAnswer = [cxRow('me@openai.com', 5, REAL + 3600)] // codex 채널이 「풀렸다」고 답한다
// ★R28e WFIRE — 「일했다」는 이제 **수명과 함께**다. `lifeMs`가 없으면 그 대본은 크리틱
// §5.1의 71발짜리(한 줄 내고 즉사)이고, 아래 L절이 그쪽을 「2발에서 접힌다」로 잠근다.
const onlyWork = await nightRun(CX_PROPS, 4, () => CX_BANNER, true, { lifeMs: LONG }) // 꼬리 없음 = ①은 침묵
eq('★ ② 일한 흔적만으로도 안 잘린다(codex 배너형 — 읽을 꼬리가 없다)', { sent: onlyWork.sent, seen: onlyWork.seen }, { sent: 4, seen: [0, 0, 0, 0] })
const cxDud = await nightRun(CX_PROPS, 4, () => CX_BANNER, false)
eq('★ codex 축의 헛발질도 여전히 2발', { sent: cxDud.sent, seen: cxDud.seen }, { sent: 2, seen: [1, 2] })
// ★R2 — **엔진 71발의 렌더러 짝**(WCAP 확인 크리틱 R1 §3.2). 같은 대본(codex 배너형 ·
// 시각 미상 · 매번 같은 벽)에서 턴이 흘리는 것이 추론뿐일 때, 엔진 R1은 12시간에 71발을
// 냈고 렌더러는 2발이었다. 이제 두 축이 같은 2발이다 — 이 줄이 렌더러 쪽 잠금이다.
const cxThink = await nightRun(CX_PROPS, 8, () => CX_BANNER, false, { think: true })
eq('★★ 추론만 흘리고 죽는 턴도 2발에서 접힌다(엔진 71발의 짝)', { sent: cxThink.sent, seen: cxThink.seen }, { sent: 2, seen: [1, 2] })
ok('★ 그 표는 접혀 있다', cxThink.h.hold?.ready === true && cxThink.h.hold?.autoPaused === true, JSON.stringify(cxThink.h.hold))
// ★R3 — **엔진 못 ⑦의 렌더러 짝**(WCAP 확인 크리틱 R2 §3.3의 P12). 앞 턴에서 열린 도구의
// 결과가 재개 턴에 뒤늦게 오는 판이다. 렌더러는 R2에서도 이미 2발이었고(그래서 엔진 71 대
// 렌더러 2), 이 줄은 그 값이 **앞으로도** 2임을 못 박는다 — 엔진을 이 경계로 좁혔으니
// 이쪽이 흔들리면 파리티가 반대로 깨진다.
const cxCross = await nightRun(CX_PROPS, 8, () => CX_BANNER, false, { crossTool: true })
eq('★★ 앞 턴 도구의 결과만 오는 턴도 2발에서 접힌다(엔진 ⑦의 짝)', { sent: cxCross.sent, seen: cxCross.seen }, { sent: 2, seen: [1, 2] })
ok('★ 그 표는 접혀 있다', cxCross.h.hold?.ready === true && cxCross.h.hold?.autoPaused === true, JSON.stringify(cxCross.h.hold))
// 반대 방향 — **이 턴 안에서** 도구가 돌면(work) 그건 일한 것이다. 그 그룹이 사용자 말풍선
// 뒤에 서므로 계수가 안 오르고, 앞 턴 그룹이 스레드에 남아 있어도 답은 안 바뀐다.
const cxCrossWork = await nightRun(CX_PROPS, 4, () => CX_BANNER, true, { crossTool: true, lifeMs: LONG })
eq('★ 앞 턴 그룹이 남아 있어도 이 턴이 일했으면 안 접힌다', { sent: cxCrossWork.sent, seen: cxCrossWork.seen }, { sent: 4, seen: [0, 0, 0, 0] })
cxAnswer = []

// ③ 섞인 판 — 일한 재개 하나가 상한을 **영영** 무디게 만들지 않는다(계수가 다시 선다).
//    축은 codex(꼬리 없음 = ②가 판정하는 판)다.
console.log('   ③ 섞인 판 — 리셋 뒤에도 상한은 다시 선다')
cxAnswer = [cxRow('me@openai.com', 5, REAL + 3600)]
sent.length = 0
const hmx = mountArmed(CX_PROPS, CX_BANNER)
await tick(hmx)
await rearm(hmx, CX_BANNER, { work: true, lifeMs: LONG }) // 그 턴은 오래 일했다 → 계수 0
eq('일한 재개 뒤의 표는 백지', hmx.hold?.attempts, undefined)
await tick(hmx)
await rearm(hmx, CX_BANNER) // 이번엔 빈손 → 1
eq('★ 그다음 헛발질은 1에서 다시 센다(ref도 같이 되돌아갔다)', hmx.hold?.attempts, 1)
await tick(hmx)
await rearm(hmx, CX_BANNER)
eq('그다음 헛발질은 2', hmx.hold?.attempts, 2)
await tick(hmx)
eq(
  '★★ 상한은 여전히 선다 — 접힌 표 + 발사 3회에서 멎음',
  { ready: !!hmx.hold?.ready, paused: !!hmx.hold?.autoPaused, sent: sent.length },
  { ready: true, paused: true, sent: 3 }
)
cxAnswer = []

// ④ ★ 우선순위의 회귀 잠금 — 「토큰 한 줄 + 같은 벽」이 상한을 무력화하지 않는다.
//    구분자를 OR로 두면 이 판에서 계수가 영영 0이 되고, 리셋 시각이 이미 지나 있어
//    타이머가 최소값(15초)으로 돌아 **RCAP 이전의 무한 재발사**가 그대로 돌아온다.
console.log('   ④ 토큰 한 줄 + 같은 벽(지난 epoch 되돌림) — 상한이 무력화되지 않는다')
usageAnswer = G_FREE
// `lifeMs`를 **주고도** 멎어야 한다 — 시각을 둘 다 아는 판은 시계가 판정하기 때문이다.
const stale = await nightRun(I_PROPS, 8, J_SAME, true, { lifeMs: LONG })
eq('★★ 매 턴 출력을 내도 같은 벽이면 2발에서 멎는다', { sent: stale.sent, seen: stale.seen }, { sent: 2, seen: [1, 2] })
ok('★ 그 표는 접혀 있다(사용자의 버튼 차례)', stale.h.hold?.ready === true && stale.h.hold?.autoPaused === true, JSON.stringify(stale.h.hold))

// ── K. ★R28d WCAP R4 — 「이 턴이 연 도구 그룹」은 **누가 턴을 열었든** 같은 답이어야 한다 ──
//
// WCAP 확인 크리틱 R3 §4.3. R3에서 두 축의 공통 문장은 「이 턴이 연 비어 있지 않은 도구
// 그룹」이 됐는데, 렌더러에서 「이 턴」을 정하는 것은 스토어의 `openGroupId`이고 그 값을
// 비우는 자리에 **`user-echo`가 빠져 있었다**(`begin`·`assistant-*`·`verdict(blocked)`·
// `interrupt`만 비웠다). 한도 자동 재개는 엔진이 여는 턴 = `user-echo`다(`hub.rs`의 큐
// 드레인). 그래서 **텍스트 없이 도구만 여는 재개 턴**에서 스토어는 그 도구를 앞 턴의 열린
// 그룹에 밀어 넣었고, 뒤에서부터 훑는 `turnDidWork`는 사용자 말풍선에서 멎어 거짓을 냈다 —
// 엔진은 같은 판에서 참(그 턴이 연 도구 = 산출)이라 **71 대 2가 `tool_use` 문으로 한 번 더**
// 서 있었다. 스토어 한 줄(`app/src/store/session.ts`의 `user-echo`: `openGroupId: null`)로
// 닫았고, 이 절이 그 사실을 **실제 리듀서로** 잠근다.
//
// 이 절이 앞 절들과 다른 점: 스레드를 **손으로 안 만든다.** `begin`/`user-echo`/`status`/
// `tool-start`/`tool-end`/`assistant-done`/`thinking`/`result`를 진짜 리듀서에 먹여 스레드를
// 짓고, 그 스레드를 판정 함수와 **훅**에 그대로 넣는다.
console.log('\nK. 실제 스토어 리듀서 — 엔진이 연 턴(user-echo)과 렌더러가 연 턴(begin)이 같은 답을 낸다')
tag = 'WCAP R4'

const store = await bundle(path.join(root, 'app/src/store/session.ts'), 'store.mjs', {
  alias: { react: stubPath, '@shared': path.join(root, 'src/shared') }
})
const { reducer, initialSessionState } = store
const kEv = (e) => ({ type: 'engine', event: e })
const kTool = (id) => ({ id, name: 'Read', input: '', status: 'running' })
// 꼬리(`…|epoch`)가 없는 문구 = **시각 미상 축**. 구분자 ①이 영영 침묵하므로 ②(일한 흔적)가
// 유일 판정자다 — 엔진 못들이 71 대 2를 재던 그 축이고, codex 대기표의 기본 축이다.
const kResult = (run) => ({
  type: 'result', runId: run, isError: true, text: CX_BANNER,
  costUsd: null, durationMs: null, numTurns: null, contextTokens: null, contextWindow: null, viaApi: false
})

/** 한 턴이 죽기 전에 흘리는 것 — 엔진 못(`crates/ccg-engine/tests/wcap_limit_streak.rs`)의
 *  ⑤⑥⑦ 대본과 같은 다섯이다. `i`는 턴 번호(0 = 사용자가 보낸 첫 턴). */
const K_BODY = {
  '빈손(문전박대)': () => [],
  '이 턴이 연 도구': (run, i) => [kEv({ type: 'tool-start', runId: run, tool: kTool(`toolu-${i}`) })],
  // 턴0은 도구를 열어 놓고 죽고, 재개 턴들은 **앞 턴** 도구의 결과만 받는다(엔진 못 ⑦의 P12).
  '앞 턴 도구의 결과만': (run, i) =>
    i === 0
      ? [kEv({ type: 'tool-start', runId: run, tool: kTool('toolu-0') })]
      : [kEv({ type: 'tool-end', runId: run, id: 'toolu-0', status: 'ok', preview: 'ok' })],
  '어시스턴트 텍스트': (run, i) => [kEv({ type: 'assistant-done', runId: run, messageId: `m${i}`, text: '고쳤어' })],
  '추론만': (run) => [kEv({ type: 'thinking', runId: run, text: '어디부터 볼까' })]
}

/** 엔진이 같은 대본에 내는 답(= 위 못들의 착지). **이 표가 두 축의 계약이다.** */
const K_WANT = {
  '빈손(문전박대)': false, // ⑤ 12시간 2발 · attempts 2 · 접힘
  '이 턴이 연 도구': true, // ⑥ 「결과 없이 죽는 도구 호출」 65분 6발 · attempts 0
  '앞 턴 도구의 결과만': false, // ⑦ 12시간 2발 · 접힘
  '어시스턴트 텍스트': true, // ⑥
  '추론만': false // ⑤ (thinking_delta 한 장)
}

/** 한 턴을 스토어에 태운다. `openWith`가 이 절의 전부다 — 같은 이벤트 열을 **세 판**으로
 *  돌린다: 렌더러가 여는 판(`begin`) · 엔진이 에코와 함께 여는 판(`user-echo`) ·
 *  ★R28e WFIRE — **에코가 아예 없는 엔진 턴**(`none`).
 *
 *  셋째 판이 크리틱 R2 §5.3이다: 큐 항목 없이 엔진이 스스로 여는 턴(상주 정리턴 재개 ·
 *  통지 기상 턴)은 `user-echo`가 안 나가므로 스레드에 **사용자 말풍선이 없다**. 그러면
 *  「이 턴」의 창이 앞 턴까지 뒤로 새고, 앞 턴이 도구를 열어 뒀으면 답이 뒤집힌다
 *  (엔진 = 헛발질 · 렌더러 = `true`). 유일한 신호는 **새 `runId`의 `analyzing`**이다. */
function kTurn(s, i, openWith, body) {
  const run = `run-${i + 1}`
  if (i === 0 || openWith === 'begin') s = reducer(s, { type: 'begin', text: i ? '이어서' : '원래 하던 일', time: '10:00', command: null })
  else if (openWith === 'user-echo') s = reducer(s, { type: 'user-echo', text: '이어서', time: '10:05' })
  s = reducer(s, kEv({ type: 'status', status: 'analyzing', runId: run }))
  for (const a of body(run, i)) s = reducer(s, a)
  return reducer(s, kEv(kResult(run)))
}
const kState = (openWith, body, turns = 2) => {
  let s = initialSessionState
  for (let i = 0; i < turns; i++) s = kTurn(s, i, openWith, body)
  return s
}
const kThread = (openWith, body, turns = 2) => kState(openWith, body, turns).messages
const kShape = (msgs) =>
  msgs.map((m) => (m.kind === 'toolgroup' ? `TG(${m.tools.length})` : m.kind === 'msg' ? (m.error ? 'a!' : m.role[0]) : m.kind)).join(' ')

console.log('   ① 판정 — 같은 이벤트 열, 여는 방식만 다르게')
for (const [label, body] of Object.entries(K_BODY)) {
  const a = kState('begin', body)
  const b = kState('user-echo', body)
  eq(`「${label}」 렌더러가 연 턴 = 엔진의 답`, lib3.turnDidWork(a.messages, a.turnMark), K_WANT[label])
  eq(`★★ 「${label}」 엔진이 연 턴도 같은 답(여는 방식과 무관)`, lib3.turnDidWork(b.messages, b.turnMark), K_WANT[label])
  // 답만이 아니라 **스레드 모양**까지 같아야 한다 — 답이 우연히 겹치는 것과 다르다.
  eq(`★ 「${label}」 스레드 모양이 같다`, kShape(b.messages), kShape(a.messages))
  // ★R28e WFIRE — **셋째 판(에코 없는 엔진 턴)**도 같은 답이어야 한다(크리틱 R2 §5.3).
  //   모양은 다를 수밖에 없다(사용자 말풍선이 하나 없다) — 같아야 하는 것은 **답**이다.
  const c = kState('none', body)
  eq(`★★ 「${label}」 에코 없는 엔진 턴도 같은 답(§5.3)`, lib3.turnDidWork(c.messages, c.turnMark), K_WANT[label])
}
// 이 절이 실제로 무엇을 잡는지 못 박는다 — 고치기 전 `user-echo` 판의 실측 모양이다.
eq(
  '★ 회귀 표식 — 재개 턴의 도구는 새 그룹을 연다(앞 턴 그룹에 안 쌓인다)',
  kShape(kThread('user-echo', K_BODY['이 턴이 연 도구'])),
  'u TG(1) a! u TG(1) a!'
)
// ★R28e WFIRE — **에코 없는 판의 A/B.** 경계(`turnMark`)를 빼면 그 자리에서 답이 뒤집힌다.
//   이 두 줄이 §5.3의 판별력이다: 같은 스레드에 경계만 있고 없고로 `true`/`false`가 갈린다.
{
  const c = kState('none', K_BODY['앞 턴 도구의 결과만'])
  eq('★ 에코 없는 턴의 실측 모양(사용자 말풍선이 하나뿐이다)', kShape(c.messages), 'u TG(1) a! a!')
  eq('★★ 경계가 없으면 앞 턴 도구가 이 턴의 산출로 읽힌다(고치기 전 값)', lib3.turnDidWork(c.messages), true)
  eq('★★ 경계를 주면 엔진과 같은 답', lib3.turnDidWork(c.messages, c.turnMark), false)
  ok('★ 그 경계는 스토어가 스스로 적은 값이다', typeof c.turnMark === 'string' && !!c.turnMark, JSON.stringify(c.turnMark))
}

// ② 계수 궤적 — 그 스레드를 **훅에 그대로** 먹인다(픽스처 0개).
console.log('   ② 훅 실구동 — 스토어가 지은 스레드로 계수 궤적을 잰다')

/** 쏜 재개 턴이 또 죽는다 — 스레드·경계·수명 전부 **스토어가 준 상태**에서 온다.
 *  `lifeMs`만 하네스가 정한다(가상 시계가 없으므로 `turnAt`을 뒤로 밀어 만든다). */
async function kRearm(h, s, lifeMs) {
  h.o.busy = true
  h.o.state = { ...h.o.state, status: 'working' }
  h.host.render()
  await flush()
  h.o.busy = false
  h.o.state = { ...h.o.state, status: 'error', messages: s.messages, turnMark: s.turnMark, turnAt: Date.now() - lifeMs }
  h.host.render()
  await flush()
}

/** 첫 턴을 스토어로 태워 표를 세우고, 재개를 n번 돌린다(매번 같은 한도로 죽는다). */
async function kNight(openWith, body, n, lifeMs = LONG) {
  sent.length = 0
  let s = kTurn(initialSessionState, 0, openWith, body)
  const h = mountArmed(CX_PROPS, null, hookMod, s)
  const seen = []
  for (let i = 1; i <= n; i++) {
    if (!h.hold || h.hold.autoPaused) break
    await tick(h)
    if (h.hold) break // 안 쐈다 = 자동이 접혔다
    s = kTurn(s, i, openWith, body)
    await kRearm(h, s, lifeMs)
    seen.push(h.hold?.attempts ?? 0)
  }
  return { h, sent: sent.length, seen }
}

cxAnswer = [cxRow('me@openai.com', 5, REAL + 3600)] // 재검증은 「풀렸다」고 답한다
const kBegin = await kNight('begin', K_BODY['이 턴이 연 도구'], 6)
eq('매 턴 도구를 여는 재개 — 렌더러가 연 판은 안 잘린다', { sent: kBegin.sent, seen: kBegin.seen }, { sent: 6, seen: [0, 0, 0, 0, 0, 0] })
const kEcho = await kNight('user-echo', K_BODY['이 턴이 연 도구'], 6)
eq('★★ 엔진이 연 판도 같은 궤적 — 71 대 2가 `tool_use` 문으로 서 있던 자리', { sent: kEcho.sent, seen: kEcho.seen }, { sent: 6, seen: [0, 0, 0, 0, 0, 0] })
ok('★ 접힌 표가 없다(엔진 못 ⑥과 같은 착지)', !kEcho.h.hold?.autoPaused, JSON.stringify(kEcho.h.hold))
// ★R28e WFIRE — 셋째 판도 같은 궤적이어야 한다(§5.3).
const kNone = await kNight('none', K_BODY['이 턴이 연 도구'], 6)
eq('★★ 에코 없는 엔진 턴도 같은 궤적', { sent: kNone.sent, seen: kNone.seen }, { sent: 6, seen: [0, 0, 0, 0, 0, 0] })
console.log(
  `   A/B — 같은 6턴 대본: begin ${kBegin.sent}발  vs  user-echo ${kEcho.sent}발  vs  에코 없음 ${kNone.sent}발` +
    ` (계수 ${JSON.stringify(kEcho.seen)})`
)

// 반대 방향(과잉 절단) — 진짜 헛발질은 **세 판 다** 2발에서 접힌다. RCAP 불변.
for (const [label, want] of [['빈손(문전박대)', '빈손'], ['앞 턴 도구의 결과만', '앞 턴 결과']]) {
  for (const how of ['begin', 'user-echo', 'none']) {
    const r = await kNight(how, K_BODY[label], 6)
    eq(`★ 「${want}」(${how})은 여전히 2발에서 멎는다`, { sent: r.sent, seen: r.seen }, { sent: 2, seen: [1, 2] })
    ok(`★ 「${want}」(${how}) 표가 접혀 있다`, r.h.hold?.ready === true && r.h.hold?.autoPaused === true, JSON.stringify(r.h.hold))
  }
}
cxAnswer = []

// ── L. ★R28e WFIRE — 상한의 단위: 「연속 빈손」 → 「에피소드 예산 + 턴 수명」 ──────────
//
// WCAP 확인 크리틱 R2 §5.1의 남은 격차. 구분자 ②가 「화면에 남는 산출 한 줄」이라, 리셋
// 시각을 모르는 축에서는 재개 턴이 **글자 한 줄만 내도** `attempts`가 영영 0이 되어 RCAP의
// 「자동은 최대 2발」이 사라졌다 — 12시간 **71발** · `attempts` 0 · 안 접힘. 그 표의 세 줄이
// ① 어시스턴트 텍스트 한 줄 ② 도구 하나 열고 결과 없이 죽음 ③ **한도 문구 자체**를 텍스트로
// 받은 턴이다(③이 가장 나쁘다 — 「일했다」가 사용자에게 명백한 거짓이 된다).
//
// 장치 둘을 **함께** 세운다(하나만으로는 서로의 사각을 못 덮는다):
//  * **턴 수명**(`MIN_WORK_MS`) — 「30초 만에 같은 벽」과 「창을 꽉 채워 일함」을 가른다.
//  * **에피소드 예산**(`MAX_EPISODE_FIRES`) — 산출을 흘리며 **천천히** 죽는 턴은 수명 문턱을
//    넘으므로 ①·②로는 절대 안 멎는다. 아무 구분자도 못 지우는 총계가 그 천장이다.
//
// 엔진 짝은 `crates/ccg-engine/tests/wcap_limit_streak.rs` ⑩~⑬이고, 이 절과 **같은 대본·
// 같은 착지**를 가상 시계로 잰다(엔진: 12시간 71발 → 2발 / 예산 12발에서 접힘).
console.log('\nL. 에피소드 예산 + 턴 수명 — 「글자 한 줄」로는 상한을 못 지운다(크리틱 R2 §5.1)')
tag = 'WFIRE'

// ① 순수 판정 — 상수·수명 문턱·예산 게이트.
console.log('   ① 상수와 문턱')
eq('엔진과 같은 값 — 예산 12발', lib3.MAX_EPISODE_FIRES, 12)
eq('엔진과 같은 값 — 최소 수명 5분', lib3.MIN_WORK_MS, 5 * 60_000)
eq('★ 문턱 정각은 일한 것(>=)', lib3.turnLivedLongEnough(lib3.MIN_WORK_MS), true)
eq('★ 문턱 1ms 아래는 헛발질', lib3.turnLivedLongEnough(lib3.MIN_WORK_MS - 1), false)
eq('★★ 모르면 일한 게 아니다 — 상한이 「모른다」로 지워지면 그건 상한이 아니다', lib3.turnLivedLongEnough(null), false)
eq('모름(undefined)도 같다', lib3.turnLivedLongEnough(undefined), false)

const J_ONE_LINE = [J_USER, { kind: 'msg', role: 'assistant', text: '알겠습니다' }, J_ERR]
eq('★★ 한 줄 내고 즉사한 턴은 계수를 못 지운다(12시간 71발의 자리)', lib3.carriedAttempts(2, null, null, { items: J_ONE_LINE, ms: 0 }, NOW), 2)
eq('★ 30초도 아직 헛발질', lib3.carriedAttempts(2, null, null, { items: J_ONE_LINE, ms: 30_000 }, NOW), 2)
eq('★★ 창을 태운 턴은 그대로 0(과잉 절단 방지)', lib3.carriedAttempts(2, null, null, { items: J_ONE_LINE, ms: 5 * 3600_000 }, NOW), 0)
eq('★ 산출이 없으면 오래 살아도 헛발질(둘은 AND다)', lib3.carriedAttempts(2, null, null, { items: [J_USER, J_ERR], ms: 5 * 3600_000 }, NOW), 2)

console.log('   ② 예산 게이트(resumeVerdict) — 계수가 0이어도 접힌다')
const H_FIRES = (n) => H({ resetsAt: null, fires: n })
eq('예산이 남았으면 그냥 ready', lib3.resumeVerdict(H_FIRES(lib3.MAX_EPISODE_FIRES - 1), null, false, NOW), { kind: 'ready' })
eq(
  '★★ 예산을 다 쓰면 접힌다 — `attempts`가 0이어도',
  lib3.resumeVerdict(H_FIRES(lib3.MAX_EPISODE_FIRES), null, false, NOW),
  { kind: 'ready', paused: true }
)
eq('★ 「아직 막혔다」는 여전히 먼저다(순서는 규약)', lib3.resumeVerdict(H_FIRES(99), NOW + 3600, false, NOW), { kind: 'hold', resetsAt: NOW + 3600, probes: 0 })
eq('★ 예산은 영속된다 — 껐다 켜서 되살아나면 예산이 아니다', lib3.sanitizeHold({ ...H_FIRES(7), attempts: 1 }, NOW_MS)?.fires, 7)
eq('0은 안 싣는다(영속 형태 유지)', lib3.sanitizeHold({ ...H_FIRES(0) }, NOW_MS)?.fires, undefined)

// ③ 훅 실구동 — 엔진 못 ⑩·⑫와 **같은 대본**을 세 표면 중 codex 축(②가 유일 판정자)에 먹인다.
console.log('   ③ 훅 실구동 — 71발의 세 줄, 그리고 예산 천장')
cxAnswer = [cxRow('me@openai.com', 5, REAL + 3600)] // 조회는 매번 「풀렸다」고 답한다

// 크리틱 §5.1 표의 세 줄. 전부 「산출은 있는데 즉사」다 = 이제 헛발질이다(엔진 ⑩ = 2발).
const L_LINES = [
  ['어시스턴트 텍스트 한 줄', { work: true, lifeMs: 0 }],
  ['도구 하나 열고 즉사', { work: true, lifeMs: 0, crossTool: false }],
  ['한도 문구를 어시스턴트 텍스트로', { work: true, lifeMs: 0 }]
]
for (const [label, opts] of L_LINES) {
  const r = await nightRun(CX_PROPS, 20, () => CX_BANNER, opts.work, opts)
  eq(`★★ 「${label}」도 2발에서 접힌다(엔진 ⑩과 같은 착지)`, { sent: r.sent, seen: r.seen }, { sent: 2, seen: [1, 2] })
  ok(`★ 「${label}」 표가 접혀 있다`, r.h.hold?.ready === true && r.h.hold?.autoPaused === true, JSON.stringify(r.h.hold))
}

// 반대편 — 같은 대본에 **수명만** 주면 안 잘린다(엔진 ⑪).
const lived = await nightRun(CX_PROPS, 6, () => CX_BANNER, true, { lifeMs: lib3.MIN_WORK_MS })
eq('★★ 수명 문턱을 넘긴 턴은 그대로 이어간다', { sent: lived.sent, seen: lived.seen }, { sent: 6, seen: [0, 0, 0, 0, 0, 0] })
ok('★ 접힌 표가 없다', !lived.h.hold?.autoPaused, JSON.stringify(lived.h.hold))

// 그리고 그 대본을 **그냥 오래** 돌리면 예산이 천장으로 선다(엔진 ⑫ = 12발).
const budget = await nightRun(CX_PROPS, 40, () => CX_BANNER, true, { lifeMs: LONG })
eq(
  '★★ 산출로도 못 지우는 천장 — 예산 12발에서 멎는다(엔진 ⑫와 같은 수)',
  { sent: budget.sent, attempts: budget.h.hold?.attempts, fires: budget.h.hold?.fires },
  { sent: lib3.MAX_EPISODE_FIRES, attempts: undefined, fires: lib3.MAX_EPISODE_FIRES }
)
ok('★ 접은 것은 계수가 아니라 예산이다(계수는 끝까지 0)', budget.seen.every((v) => v === 0), JSON.stringify(budget.seen))
ok('★ 그 표는 접혀 있다', budget.h.hold?.ready === true && budget.h.hold?.autoPaused === true, JSON.stringify(budget.h.hold))
console.log(`   A/B — 같은 codex 대본: 즉사 2발 · 수명만 주면 6발 · 오래 돌리면 ${budget.sent}발에서 예산 소진`)

// ④ 막다른 방이 아니다 — 누르면 예산이 통째로 되살아난다(엔진 ⑬).
console.log('   ④ 「이어가기」 — 예산을 다 쓴 표의 출구')
budget.h.api.resumeNow()
budget.h.host.render()
await flush()
eq('★★ 누르면 그 자리에서 보낸다', { hold: budget.h.hold, sent: sent.length }, { hold: null, sent: lib3.MAX_EPISODE_FIRES + 1 })
await rearm(budget.h, CX_BANNER, { work: true, lifeMs: LONG })
eq('★★ 누른 재개 뒤의 표는 예산도 백지 — 버튼이 한 번 쓰고 버리는 것이 되지 않는다', budget.h.hold?.fires, undefined)
ok('★ 다시 쏠 수 있다(접혀 있지 않다)', !budget.h.hold?.autoPaused, JSON.stringify(budget.h.hold))

// ⑤ 에피소드의 끝 — 한도가 아닌 착지 하나가 예산을 되살린다(엔진 `!limited`의 짝).
console.log('   ⑤ 한도가 아닌 착지 — 에피소드가 끝났다는 유일한 기계적 신호')
const ep = await nightRun(CX_PROPS, 40, () => CX_BANNER, true, { lifeMs: LONG })
eq('먼저 예산을 다 쓴다', ep.sent, lib3.MAX_EPISODE_FIRES)
ep.h.api.resumeNow()
ep.h.host.render()
await flush()
await rearm(ep.h, 'Command failed with exit code 1') // 이번엔 한도가 아닌 이유로 죽었다
eq('한도가 아닌 착지에는 표가 안 선다', ep.h.hold, null)
await rearm(ep.h, CX_BANNER, { work: true, lifeMs: LONG })
eq('★★ 그다음 표는 예산도 계수도 백지', { fires: ep.h.hold?.fires, attempts: ep.h.hold?.attempts }, { fires: undefined, attempts: undefined })
cxAnswer = []

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} 통과, ${fail} 실패`)
process.exit(fail === 0 ? 0 : 1)
