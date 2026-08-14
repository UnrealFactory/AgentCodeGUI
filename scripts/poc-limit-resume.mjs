/**
 * PoC — 한도 자동 이어서(limitResume) 판정 로직 검증.
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
 * 실행: node scripts/poc-limit-resume.mjs   (esbuild로 lib를 번들 후 인메모리 구동)
 */
import esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const bundle = path.join(root, '.poc-limit-resume.mjs')

await esbuild.build({
  entryPoints: [path.join(root, 'src/renderer/src/lib/limitResume.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: bundle
})
const lib = await import(pathToFileURL(bundle).href)
fs.rmSync(bundle, { force: true })

let pass = 0
let fail = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else {
    fail++
    console.error(`  FAIL ${name}\n    want ${JSON.stringify(want)}\n    got  ${JSON.stringify(got)}`)
  }
}

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
const NOW = 1_755_000_000
const W = (pct, resetsAt) => ({ pct, resetsAt })
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
const NOW_MS = NOW * 1000
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

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} 통과, ${fail} 실패`)
process.exit(fail === 0 ? 0 : 1)
