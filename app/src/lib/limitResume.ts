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
  // 재확인 간격(recheckDelayMs)과 눈감고 쏘는 재개의 재확인 상한(MAX_RECHECKS)이 이걸 센다.
  probes?: number
  /** ★R28c RCAP — **눈감고 쏜 재개의 횟수**(연속). 엔진 `LimitHold::attempts`
   *  (`runtime.rs`의 `auto_resume_streak`)의 짝이다.
   *
   *  `probes`와 **세는 대상이 다르다**: probes 한 칸은 *재확인*(usage 조회 1회)이고
   *  이것 한 칸은 *재발사*(CLI 턴 1회)다. 그래서 상한도 따로다(MAX_RECHECKS / MAX_AUTO_ATTEMPTS).
   *
   *  값을 **표에 얹는 이유**: 재개 턴이 같은 한도 에러로 또 죽으면 그 대기표는 걷히고
   *  새 표가 선다. R28b까지 새 표는 늘 `probes:0`인 백지였고, 그래서 상한이 한 대기표
   *  안에서만 살아 있었다 — 주기가 영원히 돌아 5시간 창 하나에 **27회**를 쐈다
   *  (RVERD 확인 크리틱 R1 §3.1 실측). 계수를 물려받아야 그 주기가 끊긴다.
   *
   *  ★R28d WCAP — 다만 **일한 재개는 안 센다.** 물려받을지 말지는 아래
   *  [`carriedAttempts`]가 가른다(창이 넘어갔나 · 그 턴이 일을 했나). */
  attempts?: number
  /** ★R28c RCAP — **자동 재발사를 접었다**(엔진 `LimitHold::auto_paused`의 짝).
   *  표는 `ready`지만 소진 effect는 쏘지 않고, 배너의 「이어가기」가 유일한 출구다.
   *  영속하지 않는다 — 복원 뒤 재검증이 `attempts`로 다시 판정한다(`ready`와 같은 규약). */
  autoPaused?: boolean
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

/** **재확인**의 상한. 조회가 계속 실패해도 이 횟수를 넘기면 한 번 쏴 본다(2.6.2 동작).
 *
 *  ★R28c RCAP — R28b까지 이 상수의 이름은 `MAX_AUTO_ATTEMPTS`였다. 엔진
 *  (`crates/ccg-engine/src/limit.rs`)과 이름도 값도 같은데 **세는 대상만 달랐다**:
 *  엔진의 그것은 *재발사*(CLI 턴 1회)를 세고 이것은 *재확인*(usage 조회 1회)을 센다.
 *  값이 같아 더 헷갈렸다(RVERD 확인 크리틱 R1 §3.1). 세는 것의 이름으로 바꾸고,
 *  엔진과 같은 뜻의 상한은 아래 `MAX_AUTO_ATTEMPTS`가 새로 든다.
 *
 *  ★R28b RVERD — **시각 미상 표도 이 상한을 받는다**(아래 `resumeVerdict` 참고).
 *  R1까지 여기 적혀 있던 "근거가 하나도 없으면 영영 안 쏜다"는 규칙은, 조회가 죽어 있는
 *  판에서 그 대기표를 **출구 없는 방**에 가뒀다. */
export const MAX_RECHECKS = 2

/** ★R28c RCAP — **눈감고 쏘는 재개(재발사)의 상한.** `crates/ccg-engine/src/limit.rs`의
 *  `MAX_AUTO_ATTEMPTS`와 같은 값·같은 뜻이다: 자동으로 이어서 보낸 턴이 이 횟수만큼
 *  같은 한도 에러로 죽으면 **그것이 곧 "아직 안 풀렸다"는 신선한 증거**이므로 자동을
 *  접고 사용자에게 넘긴다(`ready` + `autoPaused` → 배너의 「이어가기」).
 *
 *  왜 필요한가(RVERD 확인 크리틱 R1 §3.1 실측): R28b는 상한을 **한 대기표 안에만** 뒀다.
 *  쏜 턴이 또 죽으면 새 대기표가 백지(`probes:0`)로 다시 서기 때문에 주기가 영원히 돌아,
 *  채널이 죽어 있는 판에서 5시간 창 하나에 **27회**를 눈감고 쐈다(11·22·32…290분).
 *  계수를 표에 물려(`LimitHold.attempts`) 대기표 사이를 건너게 해야 그 주기가 끊긴다. */
export const MAX_AUTO_ATTEMPTS = 2
/** 조회 실패 뒤 첫 재확인 간격. 배로 늘어 `PROBE_MS`에서 멎는다(네트워크 순간 단절이
 *  5시간 대기를 10분 더 늘리지 않게 짧게 시작한다). */
export const RECHECK_MS = 15_000

export function recheckDelayMs(probes: number): number {
  return Math.min(RECHECK_MS * 2 ** Math.max(0, probes - 1), PROBE_MS)
}

/** 2단 재검증의 착지 — 이 세 갈래가 전부다. */
export type ResumeVerdict =
  // 풀렸다(또는 상한을 넘긴 마지막 시도) — 소진 effect가 보낸다.
  // ★R28c RCAP — `paused`면 **보내지 않는다**: 표는 `ready`로 두되 배너의 「이어가기」가
  // 유일한 출구다(엔진 `auto_paused`의 짝). 켜지는 자리는 아래 `resumeVerdict` ③.
  | { kind: 'ready'; paused?: true }
  | { kind: 'hold'; resetsAt: number | null; probes: number } // 유지 — 타이머를 다시 건다

/** 재검증 결과 → 착지. `still`은 blockedResetsAt/codexBlockedResetsAt의 값(막는 창의
 *  해제 시각), `unavailable`은 위 판정. **순서가 규약이다**: 막혔다는 신선한 증거가
 *  있으면 그게 먼저고, 그다음이 "못 물어봤다"이며, 풀렸다는 맨 마지막이다. */
export function resumeVerdict(hold: LimitHold, still: number | null, unavailable: boolean, nowSec: number): ResumeVerdict {
  // ① 아직 막혀 있다는 신선한 증거 — 그 시각으로 재장전하고 실패 계수는 지운다.
  if (still != null) return { kind: 'hold', resetsAt: still, probes: 0 }
  // ② 못 물어봤다 — 유지하고 다시 묻는다(여기가 크리틱 실패1의 자리다).
  //
  // ★R28b RVERD — 사다리의 마지막 한 칸이 엔진과 달랐다(CRIT 확인 크리틱 R1 §4.1 실측:
  // 시각 미상 표에 조회 실패를 20번 먹여도 `ready` 도달 0/20). 원인은 `!past` 한 조각이다:
  // `past`는 **시각을 알 때만** 참이 될 수 있으므로 `resetsAt == null`인 표에서는 `!past`가
  // 영원히 참이고, 그러면 상한(`probes <= MAX`)은 한 번도 판정에 닿지 못한다. 그 표는
  // 재확인만 무한 반복하고 「이어가기」도 자동 재개도 오지 않는다 — codex 한도 문구에는
  // `…|epoch` 꼬리가 없어서 멀티 패널·팝아웃의 codex 대기표가 정확히 그 상태였다.
  //
  // 엔진은 같은 구멍을 이미 닫았다(`runtime.rs:3240` — `probes < MAX_BLIND_PROBES ||
  // (known && !past)`). 여기도 **같은 뜻**으로 맞춘다: 시각을 아는 표는 그 시각 전까지
  // 얼마든지 기다리되(상한 무시), **시각을 모르는 표는 상한을 받는다.** 시각을 모르는 것은
  // "기다릴 근거가 없다"는 뜻이지 "영원히 기다리라"가 아니다.
  if (unavailable) {
    const probes = (hold.probes ?? 0) + 1
    const known = hold.resetsAt != null
    const past = known && hold.resetsAt! <= nowSec
    if (probes <= MAX_RECHECKS || (known && !past)) return { kind: 'hold', resetsAt: hold.resetsAt, probes }
  }
  // ③ 풀렸다(또는 상한을 넘긴 눈감은 마지막 시도).
  //
  // ★R28c RCAP — **그 "마지막 시도"에도 상한이 있다.** 자동으로 이어서 보낸 턴이 이미
  // `MAX_AUTO_ATTEMPTS`번 같은 한도 에러로 죽었다면, 그것이 이 자리에서 얻을 수 있는
  // 가장 신선한 증거다(조회보다 신선하다 — 실제로 CLI를 태워 본 결과다). 그래서 표는
  // `ready`로 켜되 **자동 발사는 접고** 사용자의 손에 넘긴다. 엔진이 같은 자리에서 하는
  // 것과 글자 그대로 같다(`runtime.rs`: `attempts >= MAX_AUTO_ATTEMPTS` → `auto_paused`).
  //
  // 조회가 "풀렸다"고 말해도 접는 이유: 그 말은 이미 두 번 틀렸다(두 번의 재발사가 같은
  // 한도로 죽었다). 세 번째를 자동으로 태우는 대신 버튼 하나를 준다 — 사용자가 누른
  // 이어가기는 계수를 0으로 되돌리므로(`useLimitResume`) 막다른 방이 되지 않는다.
  if ((hold.attempts ?? 0) >= MAX_AUTO_ATTEMPTS) return { kind: 'ready', paused: true }
  return { kind: 'ready' }
}

/** ★R28c RCAP — **렌더러가 든 대기표를 눌러서 이어갈 수 있는가**(배너의 「이어가기」).
 *
 *  엔진 축의 짝은 `resumeOwner.ts`의 `canPressResume`이고 규칙도 같다: `ready`인데
 *  **아무도 안 쏘는** 표에만 버튼을 준다. 렌더러에서 그 조건은 `autoPaused` 하나다 —
 *  그 밖의 `ready`는 소진 effect가 같은 커밋에서 삼켜 전송으로 바꾸므로, 버튼을 두면
 *  누를 게 없는 버튼(침묵 no-op · M-LOGIC P7)이 된다. */
export function canPressContinue(hold: LimitHold | null | undefined): boolean {
  return !!hold?.ready && !!hold.autoPaused
}

/* ── ★R28d WCAP — 상한이 「헛발질」과 「제대로 일한 재개」를 가른다 ──────────────
 *
 * RCAP 확인 크리틱 R1 §4.1의 최대 격차: `attempts`는 **한도로 죽은 착지마다** 올랐고,
 * 그 턴이 30초 만에 같은 벽에 부딪혔는지 5시간을 꽉 채워 일하고 다음 창에서 막혔는지를
 * 아무도 안 봤다. 그래서 현실 시나리오(22시 한도 → 03시 재개 성공 → 08시 새 한도 → …)
 * 에서 밤샘 연속 주행이 **창 두 개**에서 잘리고, 그때 배너가 하는 말(「자동으로 이어서
 * 보낸 turn이 계속 한도에 막혔어요」)은 그 사용자에게 사실이 아니다 — 그 턴들은 막힌
 * 게 아니라 일했다.
 *
 * 구분자 둘을 받는다(엔진 `runtime.rs::arm_hold`가 글자 그대로 같은 둘을 본다):
 *  ① 새 한도 문구의 리셋 시각이 **직전에 쏜 표보다 뒤** = 창이 진짜로 넘어갔다.
 *  ② 그 턴이 어시스턴트 출력이나 도구 호출을 **하나라도** 냈다 = 헛발질이 아니다.
 *     한도로 문전박대당한 턴에는 오류 말풍선 하나뿐이다.
 *
 * **둘의 관계는 OR가 아니라 우선순위다** — 이 자리에서 스스로 판 함정 하나 때문이다.
 * 시각을 양쪽 다 아는 판에서 ①이 「안 넘어갔다」고 말하는데 ②가 「일했다」로 뒤집으면,
 * *토큰 한 줄을 내고 같은 벽에 다시 부딪히는* 판(서버가 이미 지난 epoch을 계속 되돌려
 * 주는 판)에서 계수가 영원히 0이 되고 **RCAP이 막은 무한 재발사가 그대로 돌아온다**
 * (엔진은 그 판에서 리셋+90초 = 15초 간격으로 계속 쏜다). 그리고 시각을 둘 다 아는
 * 판에서 ①의 답은 이미 완전하다: 새 벽이 직전 벽보다 뒤가 **아니면** 그 재개는 그 벽을
 * 못 넘은 것이고, 진짜로 넘었다면 새 창의 리셋은 반드시 더 뒤다. 그래서:
 *
 *   시각을 둘 다 안다  → **시계가 판정한다**(①). 일한 흔적은 안 본다.
 *   한쪽이라도 미상    → **일한 흔적이 판정한다**(②). codex 배너형 문구처럼 읽을 꼬리가
 *                        없는 축에서 ①은 영영 침묵하므로, 그 축을 ②가 든다.
 *
 * 상한·버튼·계승 구조는 RCAP 그대로다. 리셋 조건만 더한다.
 */

/** ① 창이 진짜로 넘어갔는가 — 직전에 쏜 표의 리셋 시각 대 이번 한도 문구의 리셋 시각.
 *  둘 중 하나라도 미상이면 **모른다**이고, 모르는 것은 넘어간 증거가 아니다(false).
 *
 *  다리가 둘인 이유:
 *   * `next > fired` — 크리틱이 준 그대로. 같은 벽에 다시 부딪히면 꼬리의 epoch이 그대로다.
 *   * `next > nowSec` — **새 벽이 아직 오지 않았다.** 이미 지난 시각을 되돌려 주는 문구
 *     (서버가 소진된 창의 옛 epoch을 계속 echo 하는 판)를 「넘어갔다」로 읽지 않게 하는
 *     다리다. 엔진에서는 이쪽이 하중을 다 진다 — `epoch_secs_to_runtime`이 **지난 epoch을
 *     `now`로 접기** 때문에(`saturating_sub`) 런타임 축에서는 첫 다리가 그 판에서도 늘
 *     참이 된다. 실측: 이 다리가 없던 초안에서 「토큰 한 줄 + 같은 벽」 판이 6시간에
 *     **39발**을 쐈다(`crates/ccg-engine/tests/wcap_limit_streak.rs` ④의 유래). */
export function windowRolled(firedResetsAt: number | null, nextResetsAt: number | null, nowSec: number): boolean {
  return firedResetsAt != null && nextResetsAt != null && nextResetsAt > firedResetsAt && nextResetsAt > nowSec
}

/** `turnDidWork`가 읽는 최소 모양 — 스레드 항목(`store/session.ts` `ThreadItem`)의
 *  구조적 부분집합이다. 판정을 순수하게 두려고 스토어 타입을 끌어오지 않는다. */
export interface TurnItem {
  kind: string
  role?: string
  text?: string
  error?: boolean
  tools?: readonly unknown[]
}

/** ② 방금 착지한 턴이 **일을 했는가** — 마지막 사용자 말풍선 **뒤에** 어시스턴트 출력이나
 *  도구 호출이 하나라도 있으면 참.
 *
 *  뒤에서부터 훑다가 사용자 말풍선을 만나면 거기가 이 턴의 시작이다(자동 재개도 사용자
 *  말풍선을 하나 남긴다 — '사용 한도가 초기화됐어…'). 한도로 문전박대당한 턴은 그 뒤에
 *  오류 말풍선 하나뿐이라 거짓이고, 5시간을 일한 턴은 참이다.
 *
 *  **오류 말풍선은 세지 않는다**: 한도 에러 자체가 어시스턴트 메시지로 들어오므로
 *  (`store/session.ts`의 `rerr…`) 그걸 세면 모든 턴이 「일했다」가 된다. 도구 그룹도
 *  **빈 그룹은 안 센다**(그룹은 도구가 오기 전에 먼저 열린다). `thinking`은 result가
 *  도착할 때 스토어가 걷어내므로 이 자리에 애초에 없다(엔진의 thinking_delta 활동과
 *  다른 점 — 렌더러가 볼 수 있는 증거만 쓴다). */
export function turnDidWork(items: readonly TurnItem[] | null | undefined): boolean {
  const list = items ?? []
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m.kind === 'msg' && m.role === 'user') return false
    if (m.kind === 'toolgroup' && (m.tools?.length ?? 0) > 0) return true
    if (m.kind === 'msg' && m.role === 'assistant' && !m.error && (m.text ?? '').trim()) return true
  }
  return false
}

/** 새로 서는 대기표가 물려받을 **재발사 계수.** 엔진 `arm_hold`의 같은 네 줄이다.
 *
 *  `streak`는 표 바깥에 있는 연속 계수(훅의 `firesRef` · 엔진의 `auto_resume_streak`),
 *  `firedResetsAt`은 **직전에 쏜 표**의 리셋 시각(훅의 `fireResetsRef` · 엔진의
 *  `auto_resume_at`)이다. 위 절의 우선순위대로 "그 재개가 벽을 넘었나"를 가르고,
 *  넘었으면 0으로 되돌린다(= 헛발질 연쇄가 아니었다). */
export function carriedAttempts(
  streak: number,
  firedResetsAt: number | null,
  nextResetsAt: number | null,
  items: readonly TurnItem[] | null | undefined,
  nowSec: number
): number {
  if (!(streak > 0)) return 0
  const cleared =
    firedResetsAt != null && nextResetsAt != null
      ? windowRolled(firedResetsAt, nextResetsAt, nowSec)
      : turnDidWork(items)
  return cleared ? 0 : streak
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
    ...(typeof h.probes === 'number' && h.probes >= 1 ? { probes: Math.min(Math.floor(h.probes), 99) } : {}),
    // ★R28c RCAP — **재발사 계수도 같은 이유로 살린다.** 이쪽은 한 칸이 CLI 턴 1회라
    // 더 비싸다: 재시작으로 0이 되면 "껐다 켤 때마다 두 번 더 쏘는" 자리가 된다.
    // `autoPaused`는 복원하지 않는다 — `ready`와 같이 재검증이 이 값으로 다시 판정한다.
    ...(typeof h.attempts === 'number' && h.attempts >= 1 ? { attempts: Math.min(Math.floor(h.attempts), 99) } : {})
  }
}
