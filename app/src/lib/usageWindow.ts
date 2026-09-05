/**
 * ★2026-09-05 — 한도 창의 **「지났나」** 판정, 표면 공통.
 *
 * usage API의 창(5시간·주간·Fable)은 `resetsAt`(unix 초)을 들고 온다. 그 시각을 넘긴
 * 퍼센트는 **지난 창의 값**이다 — 서버는 그 순간 0으로 되돌리고 새 `resetsAt`을 준다.
 * 그런데 캐시(셸 디스크 2분 · 메모리 5분 · 렌더러 1분)는 값의 *나이*만 봤고 창이 지났는지는
 * 아무도 안 봐서, Anthropic이 한도를 초기화해 준 뒤에도 설정·picker가 「Fable 0% 남음 · 곧」을
 * 붙들었다(제보 스크린샷). 조회가 실패하면(429 장기 차단) 그 「곧」은 몇 시간이고 「곧」이었다.
 *
 * 규칙은 엔진의 자동 전환 판정(`ccg-auth/switch.rs` `window_state` → `Rolled`)과 같다:
 * **지난 창은 소진이 아니다.** 여기서는 그 판정을 그리는 쪽(설정 게이지 · picker 한 줄 ·
 * 소진 숨김 필터 · 정렬 키)과 다시 묻는 쪽(`accounts.ts` 스케줄러)이 같은 함수로 읽게 한다.
 */
import type { AccountUsage } from '@shared/protocol'

export function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

/** 창 하나가 이미 지났나 — `resetsAt`이 있고 `now` 이하. 없으면(구 캐시·알 수 없음) 안 지난 것으로 본다. */
export function windowRolled(resetsAt: number | null | undefined, now: number = nowSec()): boolean {
  return resetsAt != null && resetsAt <= now
}

/** 세 창 중 하나라도 지났나 — 이 행은 **다시 물어야 하는 값**이다. */
export function anyRolled(u: AccountUsage | null | undefined, now: number = nowSec()): boolean {
  return !!u && (windowRolled(u.fiveHourResetsAt, now) || windowRolled(u.fableResetsAt, now) || windowRolled(u.weeklyResetsAt, now))
}

/** 아직 안 온 리셋 중 가장 이른 시각(unix 초) — 그 순간 다시 물으면 화면이 저절로 돈다. 없으면 null. */
export function nextReset(u: AccountUsage | null | undefined, now: number = nowSec()): number | null {
  if (!u) return null
  const future = [u.fiveHourResetsAt, u.fableResetsAt, u.weeklyResetsAt].filter((r): r is number => r != null && r > now)
  return future.length ? Math.min(...future) : null
}
