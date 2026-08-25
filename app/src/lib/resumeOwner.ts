/* ============================================================
 * 한도 재개의 **주인이 누구인가** — `chat:status` 한 줄에서 읽는다.
 *
 * 왜 필요한가(M-UX R2 §R2.9가 미리 적어 둔 접점): 배선 R3이 부팅 재장전
 * (`reload_state`/`ReloadHold`/`auto_resume`)을 넣으면서 한 채팅에 **재개 주체가 둘**이
 * 될 수 있게 됐다 — 렌더러의 `useLimitResume`과 엔진의 `check_hold`. 둘 다 살아 있으면
 * 리셋 시각에 **전송이 두 번** 나간다(재현 축: 한도로 죽은 턴 → 앱 재시작 → 리셋 시각
 * 도달 → 전송이 한 번인가 두 번인가). m-logic P6의 "행위자 하나"다.
 *
 * 배선 R4가 그 선언을 와이어에 실었다(`src-tauri/src/engine/lite.rs`):
 *   `resumeOwner: "engine"` — 이 채팅의 재개는 Rust가 관장한다(렌더러는 손을 뗀다)
 *   `autoResume: bool`      — 그 안에서 갈리는 스펙 ⑤. 보이는 자리·열린 창은 스스로 쏘고,
 *                             화면 밖 채팅은 `hold.ready`만 켜고 사용자가 누를 때까지 멈춘다
 *
 * **계약면(`src/shared/protocol.ts`의 `ChatStatusLite`)에는 아직 이 두 필드가 없다** —
 * 배선 R4가 진행 중이고 `src/shared/`는 이 라운드의 경계 밖이다. 그래서 여기서는
 * **선택적 확장**으로 읽고, 값이 없으면 옛 동작(렌더러 소유)으로 떨어진다.
 * 필드가 계약면에 오르면 이 파일의 `ResumeLite`만 지우면 된다.
 * ============================================================ */
import type { ChatStatusLite } from '@shared/protocol'

/** 계약면에 아직 없는 필드를 읽기 위한 확장(§R3 7 · 배선 R4 접점).
 *
 *  ★R28f WFIRE — `hold`에 두 칸이 붙었다(`engine/lite.rs`). 계약면(`ChatStatusLite.hold`)은
 *  여전히 `{resetAt, ready}`이고 `src/shared/`는 이 라운드의 경계 밖이라, `resumeOwner`·
 *  `autoResume`과 **같은 방식**으로 선택적 확장으로만 읽는다(없으면 옛 문장으로 떨어진다). */
type ResumeLite = ChatStatusLite & {
  resumeOwner?: string
  autoResume?: boolean
  hold?: ({ resetAt: number | null; ready: boolean } & { fires?: number; paused?: boolean }) | null
}

/**
 * 엔진이 이 채팅의 재개를 관장하는가 = **렌더러 기계를 꺼야 하는가.**
 *
 * 신호 우선순위:
 *  1. `resumeOwner`가 실려 왔다 → 그 선언이 전부다(`'engine'`이면 엔진, 그 밖은 렌더러).
 *  2. 안 실려 왔다(옛 셸·런타임 없는 채팅) → **대기표의 존재**를 신호로 본다.
 *     `chat:status.hold`는 `<chatId>.json`의 Rust 소유 필드에서 파생된 값이라
 *     (`ccg_store::status::truth_from_chat_file`), 그게 있다는 것은 엔진이 재장전할
 *     대기표를 들고 있다는 뜻이다.
 *  3. 둘 다 없으면 **false** — 렌더러가 계속 주인이다(2.6.2 동작 그대로).
 */
export function engineOwnsResume(row?: ChatStatusLite | null): boolean {
  const r = row as ResumeLite | null | undefined
  if (!r) return false
  if (typeof r.resumeOwner === 'string' && r.resumeOwner) return r.resumeOwner === 'engine'
  return !!r.hold
}

/** 엔진이 든 대기표 — 배너가 그리는 값. 엔진이 주인일 때만 값이 있다. */
export interface EngineHold {
  resetAt: number | null
  ready: boolean
  /** 엔진이 스스로 쏠 것인가(스펙 ⑤). 모르면 undefined — 그때는 ready에 버튼을 준다. */
  auto?: boolean
  /** ★R28f WFIRE — **엔진이 자동을 접었다**(`LimitHold::auto_paused`). `auto:false`와
   *  다른 사실이다: 저쪽은 「화면 밖이라 안 쏜다」도 포함하고(그 표는 한도가 진짜로
   *  풀린 표다), 이쪽은 「상한에 걸려 멈췄다」뿐이다. 배너 문구가 갈리는 자리다. */
  paused?: boolean
  /** ★R28f WFIRE — 이 에피소드가 태운 자동 재개 수(`ChatRuntime::episode_fires`).
   *  `paused`의 **이유**를 가른다 — `>= MAX_EPISODE_FIRES`면 예산 착지, 아니면 연속 헛발질. */
  fires?: number
}

export function engineHoldOf(row?: ChatStatusLite | null): EngineHold | null {
  const r = row as ResumeLite | null | undefined
  if (!r?.hold || !engineOwnsResume(r)) return null
  return {
    resetAt: r.hold.resetAt ?? null,
    ready: !!r.hold.ready,
    auto: r.autoResume,
    paused: r.hold.paused,
    fires: r.hold.fires
  }
}

/**
 * 목록에서 **눌러서 이어갈 수 있는가**(사이드바 「이어가기」 알약 · 배너 버튼).
 *
 * `ready`인데 아직 안 나갔다 = 그 채팅의 자동이 꺼져 있다는 뜻이다(켜져 있었으면
 * 엔진이 이미 소진했다). `auto`를 모르는 셸에서는 `ready` 하나로 판단한다 — 그때도
 * 누르는 것은 무해하다(`resume_now`는 `ready`인 대기표를 소진할 뿐이다).
 */
export function canPressResume(row?: ChatStatusLite | null): boolean {
  const h = engineHoldOf(row)
  return !!h?.ready && h.auto !== true
}
