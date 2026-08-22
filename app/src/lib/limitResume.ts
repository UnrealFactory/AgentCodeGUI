// 한도 자동 이어서(auto-continue) — 구독 사용 한도에 막혀 죽은 턴을 판별하고,
// 리셋 시각에 맞춰 자동 재개하기 위한 순수 판정 로직. 클로드 코드 데스크톱의
// "Auto-continue when the limit resets" 체크박스와 같은 동작을 우리 문법으로 옮긴 것.
// 상태 머신(장전·발화·재검증)은 App.tsx가 소유하고, 여기는 부수효과 없는 판정만 둔다.
// 검증: scripts/poc-limit-resume.mjs (실전 에러 문구 대본 + 창 조합 픽스처)
import type { UsageInfo } from '../../../shared/protocol'

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
    at: h.at
  }
}
