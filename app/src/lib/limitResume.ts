// 한도 자동 이어서(auto-continue) — 구독 사용 한도에 막혀 죽은 턴을 판별하고,
// 리셋 시각에 맞춰 자동 재개하기 위한 순수 판정 로직. 클로드 코드 데스크톱의
// "Auto-continue when the limit resets" 체크박스와 같은 동작을 우리 문법으로 옮긴 것.
// 상태 머신(장전·발화·재검증)은 App.tsx가 소유하고, 여기는 부수효과 없는 판정만 둔다.
// 검증: scripts/poc-limit-resume.mjs (실전 에러 문구 대본 + 창 조합 픽스처)
// 3.0 이식: 2.6.2 원본은 상대 경로('../../../shared/protocol')였는데, app/으로 옮기면
// 그 경로가 레포 밖을 가리킨다. 타입 전용 import라 번들은 통과하지만 타입 검사가 깨진다
// → 앱 전체가 쓰는 별칭으로 통일. (docs/renderer-divergence.md에 기록)
import type { UsageInfo } from '@shared/protocol'

export interface LimitHit {
  hit: boolean
  resetsAt: number | null // unix 초 — 에러 원문 꼬리("…|1755150000")에서 파싱된 값
}

// 한도 소진 대기표 — 화면(본채팅·멀티 패널·추가 채팅)마다 대화 하나당 한 장.
// 본채팅 것은 ui-prefs('limitResume.hold')에 영속돼 앱을 껐다 켜도 활성 채팅이면 이어진다.
export interface LimitHold {
  key: string // 소유 식별자 — 본채팅: chatId, 멀티 패널: 슬롯, 추가 채팅: '' (창당 대화 하나)
  engine: 'claude' | 'codex'
  account?: string // 실행 계정(이메일) — 재검증 usage 조회도 이 계정 기준
  resetsAt: number | null // unix 초 — null이면 리셋 시각 미상(10분 프로브)
  fable: boolean // 장전 당시 모델이 Fable — Fable 주간 창을 게이트로 볼지
  lastPrompt: string // 세션이 아예 없을 때(첫 턴 사망) '이어서' 대신 원문 재전송
  at: number // 장전 시각(ms) — 늦은 비동기 갱신 대조 + 복원 시 24시간 만료 판정
  ready?: boolean // 한도가 풀림 — 그 채팅이 활성·로드되면 이어서 보낸다 (영속 안 함)
  // ★3.0 — **조회 실패로 재검증을 못 한 횟수**(연속). 값을 얻은 재검증은 0으로 되돌린다.
  // 재확인 간격(recheckDelayMs)과 눈감고 쏘는 재개의 상한(MAX_AUTO_ATTEMPTS)이 이걸 센다.
  probes?: number
}

// unix 초 꼬리 파싱 — 클로드 API의 한도 에러 원문 형식("Claude AI usage limit reached|1755150000")
function parseEpoch(s: string): number | null {
  const m = s.match(/\|(\d{10})(?:\D|$)/)
  if (!m) return null
  const v = Number(m[1])
  return v > 1e9 && v < 1e10 ? v : null
}

/** 턴을 죽인 에러 문구가 "구독 사용 한도 소진"인지 판별한다. 컨텍스트·토큰·출력 길이
 *  한도는 전혀 다른 사고라 제외하고, 일시 과부하(rate limited/overloaded 재시도류)도
 *  CLI가 자체 재시도하므로 잡지 않는다 — 오탐으로 남의 에러를 조용히 재전송하는 쪽이
 *  놓침(사용자가 직접 재전송)보다 훨씬 나쁘다. */
export function classifyLimitError(text: string | null | undefined): LimitHit {
  const s = String(text ?? '')
  if (!s) return { hit: false, resetsAt: null }
  // 명시적 "usage limit" — 다른 단어가 섞여 있어도 확정 (claude/codex 공통 문구)
  if (/usage limit/i.test(s)) return { hit: true, resetsAt: parseEpoch(s) }
  // 컨텍스트·토큰·출력 한도 계열은 전부 비한도 — 아래 관대한 패턴의 오탐 차단벽
  if (/context|token|output|length/i.test(s)) return { hit: false, resetsAt: null }
  const hit =
    // REPL 배너형 "5-hour limit reached ∙ resets 3pm" / "Weekly limit reached …"
    /(?:\d+[ -]hour|five[ -]hour|weekly|session|daily) limit reached/i.test(s) ||
    // "You've hit your limit" / "you have reached your weekly limit" 계열
    /(?:hit|reached) your [^.\n]{0,24}limit/i.test(s) ||
    // 리셋 시각 꼬리가 붙은 limit reached 변형
    /limit reached\|\d{9,}/i.test(s)
  return { hit, resetsAt: hit ? parseEpoch(s) : null }
}

/** usage 조회 결과에서 "지금 실행을 막고 있는" 창들의 해제 시각을 고른다.
 *  여러 창이 동시 소진이면 전부 풀려야 실행되므로 가장 늦은 시각. Fable 주간 창은
 *  Fable 모델 실행일 때만 게이트다(다른 모델은 그 창 소진과 무관하게 돈다).
 *  null = 막는 창 없음(이미 풀렸거나 API 반영 지연). */
export function blockedResetsAt(u: UsageInfo | null | undefined, modelIsFable: boolean, nowSec: number): number | null {
  if (!u) return null
  const wins = [u.fiveHour, u.weekly, ...(modelIsFable ? [u.weeklyFable] : [])]
  let latest: number | null = null
  for (const w of wins) {
    if (!w || w.pct < 100 || w.resetsAt == null || w.resetsAt <= nowSec) continue
    if (latest == null || w.resetsAt > latest) latest = w.resetsAt
  }
  return latest
}

/** Codex 판 blockedResetsAt — 계정 한도 창 목록(usedPct·resetsAt)에서 소진 창의
 *  가장 늦은 해제 시각. 창 라벨 구분 없이 소진이면 게이트로 본다(플랜별 창 구성이 다르다). */
export function codexBlockedResetsAt(
  windows: { usedPct: number; resetsAt?: number | null }[] | null | undefined,
  nowSec: number
): number | null {
  let latest: number | null = null
  for (const w of windows ?? []) {
    if (w.usedPct < 100 || w.resetsAt == null || w.resetsAt <= nowSec) continue
    if (latest == null || w.resetsAt > latest) latest = w.resetsAt
  }
  return latest
}

// 리셋 시각 미상일 때의 재확인 간격 — usage 조회로 "풀렸나"만 보므로 부담이 작다
export const PROBE_MS = 10 * 60_000
// 리셋 시각 뒤 여유 — 서버 쪽 창 전환 반영 지연을 흡수 (일찍 쏘면 또 막혀 에러만 쌓인다)
export const RESET_GRACE_MS = 90_000

/** 재개 타이머 지연(ms) — 리셋 시각 + 여유, 최소 15초. 시각 미상이면 프로브 간격. */
export function resumeDelayMs(resetsAt: number | null, nowMs: number): number {
  if (resetsAt == null) return PROBE_MS
  return Math.max(15_000, resetsAt * 1000 - nowMs + RESET_GRACE_MS)
}

/* ── ★3.0 — 「조회 실패 = 풀림」 오판을 없애는 조각들 ──────────────────────────
 *
 * 최종 파리티 R1 확인 크리틱 실패1: `usage:get`이 실패하면 창 넷이 전부 `null`인 값이
 * 오는데, 위 `blockedResetsAt`은 그 값을 **「막는 창 없음」**(= 풀렸다)으로 읽는다
 * (`!w` continue). 즉 조회가 죽어 있는 동안 2단 재검증은 안전장치가 아니라 **눈감고
 * 쏘는 재전송기**였다. 실측: `CCG_NO_NET=1` + 살아 있는 계정 → `blockedResetsAt`=null
 * → `ready=true`(자동 전송). 대조군(주간 100% 실값)은 1787752800으로 유지.
 *
 * 판정을 셋으로 나눈다 — **막혔다 / 풀렸다 / 못 물어봤다.** 셋째는 둘 중 어느 쪽도
 * 아니므로 대기표를 **유지**하고 다시 묻는다. 이 파일에 두는 이유는 원래 규약과 같다:
 * 판정은 순수 함수, React 배선은 useLimitResume.ts (검증: scripts/poc-limit-resume.mjs).
 */

/** usage 조회가 **실패**했는가(= 「풀렸다」를 말할 근거가 없다).
 *
 *  ① 셸이 표식을 주면 그걸 믿는다(`ipc/parity/usage.rs` `unavailable_usage`).
 *  ② 표식이 없는 판(2.6.2 본체·옛 심)에서는 **창이 하나도 없다**가 같은 뜻이다 —
 *     실계정의 정상 응답에는 최소한 5시간·주간 창이 실려 온다. 근거가 0인 값으로
 *     "풀렸다"고 단정하는 것이 바로 이 사고였다. */
export function usageUnavailable(u: UsageInfo | null | undefined): boolean {
  if (!u) return true
  if (u.unavailable) return true
  return !u.fiveHour && !u.weekly && !u.weeklyFable && !u.extraCredit
}

/** Codex 판 — 그 계정의 창 목록이 아예 없다(조회 실패·계정 못 찾음)면 근거가 0이다. */
export function codexUsageUnavailable(windows: { usedPct: number }[] | null | undefined): boolean {
  return !windows || windows.length === 0
}

/** **눈감고 쏘는 재개**의 상한 — `crates/ccg-engine/src/limit.rs`의 `MAX_AUTO_ATTEMPTS`와
 *  같은 값·같은 뜻이다. 조회가 계속 실패해도 문구가 알려 준 리셋 시각이 이미 지났다면
 *  이 횟수의 재확인 뒤에는 한 번 쏴 본다(그 자리가 2.6.2의 동작이다). 근거가 정말
 *  하나도 없으면(시각 미상) 쏘지 않는다 — 그건 10분마다 다시 막히는 재전송기가 된다. */
export const MAX_AUTO_ATTEMPTS = 2
/** 조회 실패 뒤 첫 재확인 간격. 배로 늘어 `PROBE_MS`에서 멎는다(네트워크 순간 단절이
 *  5시간 대기를 10분 더 늘리지 않게 짧게 시작한다). */
export const RECHECK_MS = 15_000

export function recheckDelayMs(probes: number): number {
  return Math.min(RECHECK_MS * 2 ** Math.max(0, probes - 1), PROBE_MS)
}

/** 2단 재검증의 착지 — 이 세 갈래가 전부다. */
export type ResumeVerdict =
  | { kind: 'ready' } // 풀렸다(또는 상한을 넘긴 마지막 시도) — 소진 effect가 보낸다
  | { kind: 'hold'; resetsAt: number | null; probes: number } // 유지 — 타이머를 다시 건다

/** 재검증 결과 → 착지. `still`은 blockedResetsAt/codexBlockedResetsAt의 값(막는 창의
 *  해제 시각), `unavailable`은 위 판정. **순서가 규약이다**: 막혔다는 신선한 증거가
 *  있으면 그게 먼저고, 그다음이 "못 물어봤다"이며, 풀렸다는 맨 마지막이다. */
export function resumeVerdict(hold: LimitHold, still: number | null, unavailable: boolean, nowSec: number): ResumeVerdict {
  // ① 아직 막혀 있다는 신선한 증거 — 그 시각으로 재장전하고 실패 계수는 지운다.
  if (still != null) return { kind: 'hold', resetsAt: still, probes: 0 }
  // ② 못 물어봤다 — 유지하고 다시 묻는다(여기가 크리틱 실패1의 자리다).
  if (unavailable) {
    const probes = (hold.probes ?? 0) + 1
    const past = hold.resetsAt != null && hold.resetsAt <= nowSec
    if (probes <= MAX_AUTO_ATTEMPTS || !past) return { kind: 'hold', resetsAt: hold.resetsAt, probes }
  }
  // ③ 풀렸다(또는 상한을 넘긴 눈감은 마지막 시도).
  return { kind: 'ready' }
}

/** 대기표 하나의 다음 발화까지 남은 시간(ms) — **타이머와 상태줄이 같은 함수를 본다.**
 *  조회 실패로 재장전된 표(`probes`)는 리셋 시각이 이미 지나 있어 `resumeDelayMs`가
 *  최소값(15초)만 돌려준다 — 그 값을 그대로 쓰면 배너가 "곧 이어감"이라고 말하면서
 *  실제로는 재확인만 반복한다. 두 자리가 갈리지 않게 여기 하나로 모은다. */
export function holdDelayMs(hold: LimitHold, nowMs: number): number {
  if (hold.probes) return recheckDelayMs(hold.probes)
  return resumeDelayMs(hold.resetsAt, nowMs)
}

/** ui-prefs에서 복원한 대기표 위생 — 형태가 어긋나거나 24시간 지난 표는 버린다
 *  (며칠 전 대기표가 부팅하자마자 옛 채팅에 프롬프트를 쏘는 사고 방지). ready는
 *  영속하지 않는다 — 복원 후 발화 경로가 재검증으로 다시 판정한다. */
export function sanitizeHold(v: unknown, nowMs: number): LimitHold | null {
  if (!v || typeof v !== 'object') return null
  const h = v as Partial<LimitHold>
  if (typeof h.key !== 'string' || !h.key) return null
  if (typeof h.at !== 'number' || !(nowMs - h.at < 24 * 3600_000)) return null
  return {
    key: h.key,
    engine: h.engine === 'codex' ? 'codex' : 'claude',
    account: typeof h.account === 'string' && h.account ? h.account : undefined,
    resetsAt: typeof h.resetsAt === 'number' ? h.resetsAt : null,
    fable: !!h.fable,
    lastPrompt: typeof h.lastPrompt === 'string' ? h.lastPrompt : '',
    at: h.at,
    // 조회 실패 계수는 살려서 복원한다 — 앱을 껐다 켜는 것으로 상한이 초기화되면
    // "부팅할 때마다 눈감고 한 번 쏘는" 자리가 생긴다. 음수·NaN·거대값은 버린다.
    ...(typeof h.probes === 'number' && h.probes >= 1 ? { probes: Math.min(Math.floor(h.probes), 99) } : {})
  }
}
