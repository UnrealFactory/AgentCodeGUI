/* ============================================================
 * 통합 스토어/엔진 채널 중 **WindowApi에 없는 것**만 부르는 얇은 창구.
 *
 * `@shared/api`의 `WindowApi`는 얼려 둔 2.6.2 계약면이라 3.0에서 새로 생긴 채널
 * (`chats:set-active` · `chat:event`)이 없다. 계약면을 고치는 것은 M-UX의 경계 밖
 * (`src/shared/` 수정 금지)이므로, 렌더러 쪽에서만 쓰는 두 채널을 여기서 직접 부른다.
 * 호출 문법은 심(shim.ts)과 똑같다 — `invoke('ipc_call', { channel, payload })`.
 *
 * 채널이 백엔드에 없으면(구 빌드) Rust가 `{ __unimplemented: true }`를 돌려주고,
 * 여기서는 조용한 no-op이 된다. 어떤 화면도 이것 때문에 깨지지 않는다.
 * ============================================================ */
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { ChatStatusLite, EngineEvent, RunRequest } from '@shared/protocol'

const CHATS_SET_ACTIVE = 'chats:set-active'
const CHAT_EVENT = 'chat:event'
const CHAT_RUN = 'chat:run'
const CHAT_RUN_STATE = 'chat:run-state'
const CHAT_STATUS = 'chat:status'
const CHAT_RESPOND_DIALOG = 'chat:respond-dialog'

let lastActive = ''

/** 이 창의 구독 하나 — `listen()`이 비동기라 등록 전 해지도 안전하게 접는다. */
function sub<T>(channel: string, cb: (payload: T) => void): () => void {
  let dead = false
  let off: (() => void) | undefined
  void listen<T>(channel, (e) => cb(e.payload))
    .then((f) => {
      if (dead) f()
      else off = f
    })
    .catch(() => {})
  return () => {
    dead = true
    off?.()
  }
}

/**
 * `chats:set-active` — 별칭 계층(`claude:*` → `chat:*`)이 들고 있는 **활성 채팅**을
 * 즉시 갱신한다. 저장(`chats:save`)은 600ms 디바운스라 "전환 직후 전송"에서 낡은
 * 값이 가고, 그러면 실행이 **남의 ChatRuntime**에 붙는다(ux-chat-unify §6.2 U3).
 *
 * 같은 값 연타는 접는다 — 전환 착지점 3곳이 서로를 부르는 경로(삭제 → restore)에서
 * 같은 id가 두 번 나가는 것을 막는다.
 */
export function setActiveChat(chatId: string): void {
  if (!chatId || chatId === lastActive) return
  lastActive = chatId
  void invoke('ipc_call', { channel: CHATS_SET_ACTIVE, payload: [chatId] }).catch(() => {
    lastActive = '' // 실패는 캐시하지 않는다 — 다음 전환이 다시 시도한다
  })
}

/**
 * `chat:event` — 3.0의 통합 봉투 `{ chatId, event }`. 메인 창에는 활성 채팅의
 * 이벤트만 옛 이름(`engine:event`)으로 오므로(hub.rs `fanout`의 active 게이트),
 * **자리 밖에서 도는 채팅**의 스트림은 이 채널로만 볼 수 있다.
 *
 * 실행 중 채팅 전환을 허용하려면(스펙 열린문제 ⑥) 떠난 채팅의 꼬리를 누군가
 * 받아 둬야 한다 — 안 그러면 돌아왔을 때 대화가 잘려 있다.
 */
export function onChatEvent(cb: (chatId: string, event: EngineEvent) => void): () => void {
  // 진단 — 자리 밖 수집기가 "무엇을 몇 개 받았나"(shim의 window.__ccgChrome과 같은 규약).
  // 이게 없으면 "돌아왔더니 대화가 잘렸다"의 원인이 채널인지 수집기인지 구분할 수 없다.
  const dbg = ((window as unknown as { __ccgChatEv?: { n: number; ids: string[] } }).__ccgChatEv ??= { n: 0, ids: [] })
  return sub<{ chatId?: string; event?: EngineEvent }>(CHAT_EVENT, (p) => {
    if (!p || typeof p.chatId !== 'string' || !p.event) return
    dbg.n += 1
    if (!dbg.ids.includes(p.chatId)) dbg.ids.push(p.chatId)
    cb(p.chatId, p.event)
  })
}

/**
 * ★ R2 — `chat:run`. **주소가 페이로드에 있는 유일한 실행 채널**(m-logic §4.3).
 *
 * 옛 별칭(`claude:run`)은 주소를 안 실어서 "그 순간의 활성 채팅"으로 라우팅된다. 그래서
 * 자리 밖에서 도는 채팅의 예약 큐를 드레인하려면 이 채널이어야 한다 — 별칭으로 쏘면
 * **지금 보고 있는 남의 대화**로 발사된다(크리틱 M-UX R1 §2-① `queue.misroute`가 그 사고다).
 *
 * 반환은 runId 문자열(구 빌드/미구현이면 빈 문자열).
 */
export async function runChat(chatId: string, req: RunRequest): Promise<string> {
  if (!chatId) return ''
  try {
    const v = await invoke('ipc_call', { channel: CHAT_RUN, payload: [{ chatId, ...req }] })
    return typeof v === 'string' ? v : ''
  } catch {
    return ''
  }
}

/** 상태기계 상태 + 라이브 원장 REPLACE. `settled[]`가 정착 사유의 유일한 원천(§5.2). */
export interface RunStateWire {
  chatId?: string
  state?: string
  runId?: string | null
  live?: { id: string; kind: string }[]
  settled?: { id: string; kind: string; reason: string }[]
}
export function onChatRunState(cb: (p: RunStateWire) => void): () => void {
  return sub<RunStateWire>(CHAT_RUN_STATE, (p) => {
    if (p && typeof p.chatId === 'string') cb(p)
  })
}

/**
 * 전 채팅 경량 상태 REPLACE(§4.3). **F12 주의**: `engine::boot()`의 첫 방출은 창이
 * 생기기 전에 나가고 전이가 없으면 다시 안 온다 — 구독만 하면 첫 그림이 빈다.
 * 구독자는 반드시 `chats:get`의 `statuses`로 한 번 따라잡아야 한다(App이 그렇게 한다).
 */
export function onChatStatus(cb: (rows: ChatStatusLite[]) => void): () => void {
  return sub<unknown>(CHAT_STATUS, (rows) => {
    if (Array.isArray(rows)) cb(rows as ChatStatusLite[])
  })
}

/**
 * 폴백 확인 카드의 응답(§4.4b). 셸은 이 카드를 2.6.2 파리티로 **질문 카드**로 그리고
 * 질문 응답이 오면 종류를 되맞춰 주지만, 계약면의 정답은 이 채널이다.
 *
 * 되돌리는 값: 원장이 이 requestId를 다이얼로그로 알고 있어 수리됐으면 true.
 * 어긋나면(`wrong_card_kind` 등) false — 호출부가 질문 채널로 되돌아갈 수 있게.
 */
export async function respondDialog(chatId: string, requestId: string, accepted: boolean): Promise<boolean> {
  if (!chatId || !requestId) return false
  try {
    const v = (await invoke('ipc_call', {
      channel: CHAT_RESPOND_DIALOG,
      payload: [{ chatId, requestId, accepted }]
    })) as { kind?: string; __unimplemented?: boolean } | null
    if (!v || v.__unimplemented) return false
    return v.kind === 'accepted'
  } catch {
    return false
  }
}
