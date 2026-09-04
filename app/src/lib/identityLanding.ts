// ★2026-09-04 보고 — 「사용 중 · 2곳」인데 화면엔 그 계정을 쓰는 자리가 없다.
//
// 실측(~/.agentcodegui3/chats-v3): NetCore 자리는 한도에 걸려 엔진이 lmg56631로 **자동 전환**
// 했고(스레드 notice 「사용 한도에 걸려 lmg56631 계정으로 바꿔 이어갑니다」), 셸 정체성도
// 그 계정이다. 그런데 그 자리의 칩은 lmg56630 — 렌더러의 picker 바인딩은 그대로였다.
// 「사용 중」 역인덱스는 셸의 `chat:status.account`(= 정체성)로 세니 「2곳」이 맞고, 거짓말을
// 한 건 칩이다. 더 나쁜 건 다음 전송이 옛 바인딩을 `account`로 실어 보내
// (`ident::patch_from_run_request`) 정체성을 소진 계정으로 **되돌린다**는 점 — 모델 폴백에
// 「안 바꾸면 매번 오류→전환을 반복」이라 적어 둔 그 병리의 계정판이다.
//
// 모델은 이미 `model-fallback` 런 이벤트로 picker를 따라 바꾼다(App·MultiAgent·SessionWindow).
// 계정은 `chat:identity`(허브가 모든 창에 emit_all)가 원천이다 — 착지한 정체성의 계정 축을 그
// 채팅의 picker 바인딩(과 예약 메시지가 품은 picker 스냅샷)에 미러링한다. 규칙:
//  · origin 'default'(리비전 0 — 런타임 생성 직후, 요청 패치가 붙기 전)는 건너뛴다.
//  · 바인딩이 **있고** 착지값과 다를 때만 바꾼다. 바인딩이 없는(따라감) 채팅은 칩이 이미
//    `liveAccountOf`(정체성)를 그리고 전송도 계정을 안 실으니 손댈 게 없다.
//  · 사용자 리비전(origin 'user')은 바인딩과 같은 값이라 무동작. 되돌리기('revert')는 옛
//    계정으로 되미러링된다 — 되돌렸는데 다음 전송이 전환 계정을 다시 싣는 역전을 막는다.
//  · Codex 축은 `identity.engine.account` → `codexAccount`(같은 규칙).
import type { IdentityWire } from '../api/unified'

export interface AccountBindings {
  account?: string
  codexAccount?: string
}

/** 착지한 정체성에 맞춘 picker — 바뀔 게 없으면 **같은 객체**를 돌려준다(헛 렌더·헛 저장 방지). */
export function pickerAfterLanding<P extends AccountBindings>(p: P, w: IdentityWire): P {
  if (!w.identity || w.origin === 'default') return p
  let next = p
  const b = w.identity.billing
  const sub = b?.kind === 'subscription' ? (b.account ?? '') : ''
  if (sub && p.account && p.account !== sub) next = { ...next, account: sub }
  const eng = w.identity.engine
  const cx = eng?.kind === 'codex' ? (eng.account ?? '') : ''
  if (cx && p.codexAccount && p.codexAccount !== cx) next = { ...next, codexAccount: cx }
  return next
}

/** 예약 메시지들이 품은 picker 스냅샷도 같이 — 드레인 때 옛 계정을 실어 전환을 되돌리지 않게. */
export function queueAfterLanding<Q extends { picker: AccountBindings }>(queue: Q[], w: IdentityWire): Q[] {
  let touched = false
  const next = queue.map((q) => {
    const pk = pickerAfterLanding(q.picker, w)
    if (pk === q.picker) return q
    touched = true
    return { ...q, picker: pk } as Q
  })
  return touched ? next : queue
}

/** `ma-{board}-{slot}` 채번 규칙(셸 `panel_id_to_chat`의 폴백과 같다)으로 자리 번호를 뽑는다 — 아니면 `null`. */
export function panelSlotOfChat(chatId: string, board: string): number | null {
  const head = `ma-${board}-`
  if (!board || !chatId.startsWith(head)) return null
  const n = Number(chatId.slice(head.length))
  return Number.isInteger(n) && n >= 0 ? n : null
}
