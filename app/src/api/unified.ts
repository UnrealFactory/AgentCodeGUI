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
import type { EngineEvent } from '@shared/protocol'

const CHATS_SET_ACTIVE = 'chats:set-active'
const CHAT_EVENT = 'chat:event'

let lastActive = ''

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
  let dead = false
  let off: (() => void) | undefined
  // 진단 — 자리 밖 수집기가 "무엇을 몇 개 받았나"(shim의 window.__ccgChrome과 같은 규약).
  // 이게 없으면 "돌아왔더니 대화가 잘렸다"의 원인이 채널인지 수집기인지 구분할 수 없다.
  const dbg = ((window as unknown as { __ccgChatEv?: { n: number; ids: string[] } }).__ccgChatEv ??= { n: 0, ids: [] })
  void listen<{ chatId?: string; event?: EngineEvent }>(CHAT_EVENT, (e) => {
    const p = e.payload
    if (!p || typeof p.chatId !== 'string' || !p.event) return
    dbg.n += 1
    if (!dbg.ids.includes(p.chatId)) dbg.ids.push(p.chatId)
    cb(p.chatId, p.event)
  })
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
