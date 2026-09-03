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
import type { ChatStatusLite, ChatTooling, EngineEvent, RunRequest } from '@shared/protocol'

const CHATS_SET_ACTIVE = 'chats:set-active'
const CHAT_EVENT = 'chat:event'
const CHAT_RUN = 'chat:run'
const CHAT_RUN_STATE = 'chat:run-state'
const CHAT_STATUS = 'chat:status'
const CHAT_RESPOND_DIALOG = 'chat:respond-dialog'
const CHAT_QUEUE_MUTATE = 'chat:queue-mutate'
const CHAT_TOOLING_GET = 'chat:tooling-get'
const CHAT_VERDICT = 'chat:verdict'
const CHAT_IDENTITY = 'chat:identity'
const CHAT_IDENTITY_REVERT = 'chat:identity-revert'
const CHAT_WINDOWS = 'chat:windows'
const WIN_CHAT_CLOSE = 'win:chat-close'
const WIN_CHAT_FOCUS = 'win:chat-focus'
const WIN_CHAT_LIST = 'win:chat-list'

let lastActive = ''

/**
 * 이 창의 구독 하나 — `listen()`이 비동기라 등록 전 해지도 안전하게 접는다.
 *
 * `onReady`는 **네이티브 리스너가 실제로 붙은 뒤** 한 번 불린다. 스냅샷 따라잡기를
 * 그 안에서 해야 레이스가 사라진다(§R3 3): 등록 전에 나간 REPLACE는 따라잡기가 줍고,
 * 등록 후에 나간 REPLACE는 리스너가 받는다 — 두 구간 사이에 틈이 없다. 구독과 동시에
 * 따라잡기를 쏘면 그 사이에 나간 REPLACE를 **둘 다 놓친다**.
 */
function sub<T>(channel: string, cb: (payload: T) => void, onReady?: () => void): () => void {
  let dead = false
  let off: (() => void) | undefined
  void listen<T>(channel, (e) => cb(e.payload))
    .then((f) => {
      if (dead) return f()
      off = f
      onReady?.()
    })
    .catch(() => {
      // 등록 자체가 실패해도 따라잡기는 돌려야 한다 — 한 장이라도 그리는 편이 낫다
      if (!dead) onReady?.()
    })
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
  const seen = new Set(dbg.ids)
  return sub<{ chatId?: string; event?: EngineEvent }>(CHAT_EVENT, (p) => {
    if (!p || typeof p.chatId !== 'string' || !p.event) return
    dbg.n += 1
    if (!seen.has(p.chatId)) {
      seen.add(p.chatId)
      dbg.ids.push(p.chatId)
    }
    cb(p.chatId, p.event)
  })
}

/**
 * ★R3 — 본채팅 헤더 칩(McpSkillView)의 도구 환경 재조회. 멀티 칩은 shim의
 * `multi.toolingGet(panelId)`를 쓰지만 본채팅이 아는 주소는 `chatId`뿐이다 —
 * 채널(`chat:tooling-get`)은 두 주소를 다 받는다(engine/mod.rs가 번역).
 * `null` = "아직 모름"(런타임 없음 · `system/init` 전) — 칩은 그때 디스크 폴백을 그린다.
 */
export async function getChatTooling(chatId: string): Promise<ChatTooling | null> {
  if (!chatId) return null
  try {
    const v = (await invoke('ipc_call', {
      channel: CHAT_TOOLING_GET,
      payload: [{ chatId }]
    })) as { tooling?: ChatTooling; __unimplemented?: boolean } | null
    if (!v || v.__unimplemented) return null
    return v.tooling ?? null
  } catch {
    return null
  }
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
 *
 * ★ R3 — 따라잡기는 `onReady`(리스너가 붙은 뒤)에서 한다. R2는 구독과 **동시에**
 * `chats:get`을 쏘았는데, `listen()` 등록이 끝나기 전에 도착한 REPLACE는 리스너도
 * 못 받고 따라잡기 응답보다 늦게 오면 따라잡기도 못 준다 — 그 창이 레이스였다.
 */
export function onChatStatus(cb: (rows: ChatStatusLite[]) => void, onReady?: () => void): () => void {
  return sub<unknown>(
    CHAT_STATUS,
    (rows) => {
      if (Array.isArray(rows)) cb(rows as ChatStatusLite[])
    },
    onReady
  )
}

/**
 * ★ R3 — `chat:queue-mutate {op:'resume'}`. **`ready` 대기표를 사용자가 눌러 소진한다**
 * (스펙 ⑤ 후반부 · 배선 R3 §R3.3 B4에서 실증된 자리). 화면 밖 채팅은 엔진이 `ready`만
 * 켜고 멈춰 있으므로(`auto_resume=false`), 이 채널이 그 대기표의 **유일한 출구**다.
 * 누른 것 자체가 "이 채팅은 이제 보고 있다"이므로 엔진은 자동 재개도 함께 켠다.
 *
 * 되돌리는 값: 엔진이 실제로 소진했으면 true(거부 verdict면 false).
 */
export async function resumeHold(chatId: string): Promise<boolean> {
  if (!chatId) return false
  try {
    const v = (await invoke('ipc_call', {
      channel: CHAT_QUEUE_MUTATE,
      payload: [{ chatId, op: 'resume' }]
    })) as { kind?: string; __unimplemented?: boolean } | null
    if (!v || v.__unimplemented) return false
    return v.kind === 'accepted'
  } catch {
    return false
  }
}

/**
 * ★ R4 — `chat:verdict`. **거부·큐잉 사유의 유일한 통로**(m-logic D7 「침묵 no-op 금지」).
 *
 * 셸의 `hub::ensure()`는 정체성 정규화에 실패하면(`CwdMissing`·`AccountUnavailable`)
 * 사유를 이 채널로 뿌리고 호출에는 `null`을 돌려준다(`hub.rs:262-268, 377`). R3까지
 * 구독자가 **0**이라 그 실패는 화면 어디에도 안 나타났다 — 런타임이 없으니 T3(20초 침묵
 * 감시)도 없어서 **40초를 봐도 오류 0건**이었다(크리틱 R14 §5-F4의 실측).
 *
 * 브로드캐스트라 창 전부에 온다 — 호출측이 `chatId`로 자기 것만 고른다.
 */
export interface VerdictWire {
  kind?: string
  cmd?: string
  reason?: string | null
}
// `panelId` — 이 대화가 보드 자리에 앉아 있을 때의 자리 별칭(셸 hub `panel_alias`).
// 렌더러의 자리 화면(ActiveSession 착지·App 토스트 가드)은 chatId 배선이 없어 이 키로만
// 판별할 수 있다. 없으면(자리 밖 대화) undefined.
export function onChatVerdict(cb: (chatId: string, verdict: VerdictWire, panelId?: string) => void): () => void {
  // 진단 — `window.__ccgChatEv`와 같은 규약. "사유가 안 보인다"의 원인이 채널인지
  // 화면인지 가르는 유일한 창구다(구독자 0이던 시절엔 이 값 자체가 없었다).
  const dbg = ((window as unknown as { __ccgVerdicts?: { n: number; rows: unknown[] } }).__ccgVerdicts ??= { n: 0, rows: [] })
  return sub<{ chatId?: string; panelId?: string | null; verdict?: VerdictWire }>(CHAT_VERDICT, (p) => {
    if (!p || typeof p.chatId !== 'string' || !p.verdict) return
    dbg.n += 1
    if (dbg.rows.length < 200) dbg.rows.push({ chatId: p.chatId, panelId: p.panelId, ...p.verdict })
    cb(p.chatId, p.verdict, typeof p.panelId === 'string' ? p.panelId : undefined)
  })
}

/**
 * ★ R4 — `chat:identity`. 정체성 리비전 브로드캐스트(m-logic §4.3 `ChatIdentityEvent`).
 *
 * R3까지 구독자가 **0**이었다(크리틱 R14 §4.3-M3). 그래서 엔진이 모델을 뒤에서 바꿔도
 * (`origin:'engine_fallback'`) 화면은 그 사실을 **되돌릴 재료 없이** 배너 한 줄로만 알았다 —
 * 2.6.2 병리 P3("뒤에서 바뀌는 picker · 되돌릴 수 없음") 그대로다. 최소 표면은 §6.2가 적은
 * 세 가지다: 무엇이 바뀌었나 · 왜 바뀌었나 · **되돌리기**(`chat:identity-revert`).
 *
 * 셸이 싣는 값은 §4.3 초안의 부분집합이다(`fallback{}` 뭉치는 아직 없다 — 엔진 소관).
 * 그래서 되돌릴 지점은 `revision - 1`로 잡는다: 없으면 엔진이 `no_revision` 거부를
 * 돌려주고 그 사유는 이제 위 `chat:verdict` 구독자가 그린다(지어내지 않는다).
 */
export interface IdentityWire {
  chatId?: string
  // ★M11 — `billing`은 셸이 늘 싣던 축인데(`BillingAxis` 태그드 유니온 그대로:
  // `{kind:'subscription', account}` · `{kind:'api_key', keyFp}`) 이 타입이 안 적어
  // 읽을 수가 없었다. 계정 자동 전환 배너가 **어느 계정으로 갔는지**를 지어내지 않고
  // 말하려면 여기가 원천이다 — `engine.account`는 Codex 축이라 Claude 구독엔 없다.
  identity?: {
    engine?: { kind?: string; model?: string; effort?: string; account?: string | null }
    billing?: { kind?: string; account?: string | null } | null
    cwd?: string
  } | null
  revision?: number
  origin?: string
  changed?: string[]
  driftedFields?: string[]
  keptByFallback?: string[]
}
export function onChatIdentity(cb: (p: IdentityWire) => void): () => void {
  const dbg = ((window as unknown as { __ccgIdentity?: { n: number; rows: unknown[] } }).__ccgIdentity ??= { n: 0, rows: [] })
  return sub<IdentityWire>(CHAT_IDENTITY, (p) => {
    if (!p || typeof p.chatId !== 'string') return
    dbg.n += 1
    if (dbg.rows.length < 200) dbg.rows.push({ chatId: p.chatId, revision: p.revision, origin: p.origin, model: p.identity?.engine?.model })
    cb(p)
  })
}

/** 그 리비전의 정체성으로 되돌린다(히스토리 삭제가 아니라 **새 리비전** — m-logic §6.3). */
export async function revertIdentity(chatId: string, revision: number): Promise<boolean> {
  if (!chatId || !Number.isFinite(revision) || revision < 0) return false
  try {
    const v = (await invoke('ipc_call', {
      channel: CHAT_IDENTITY_REVERT,
      payload: [{ chatId, revision }]
    })) as { kind?: string; __unimplemented?: boolean } | null
    if (!v || v.__unimplemented) return false
    return v.kind === 'applied' || v.kind === 'accepted'
  } catch {
    return false
  }
}

/**
 * ★ R3 — 창 자리 목록 REPLACE(`chat:windows`)와 4채널(`win:chat-*`).
 *
 * 2.6.2의 `session-wins:*`와 **공존**하지만 의미가 하나 정반대다(배선 R3 §R3.4):
 *   `session-wins:close` = 대화 **삭제** · `win:chat-close` = **창만** 닫기.
 * 통합 모델("자리는 뷰, 대화는 접힐 뿐 사라지지 않는다")의 닫기는 뒤쪽이다.
 */
export interface WindowSlot {
  label: string
  chatId: string
  title: string
  focused: boolean
}
function asSlots(v: unknown): WindowSlot[] {
  return Array.isArray(v)
    ? (v.filter((x) => x && typeof (x as WindowSlot).chatId === 'string') as WindowSlot[])
    : []
}
export function onChatWindows(cb: (slots: WindowSlot[]) => void, onReady?: () => void): () => void {
  return sub<unknown>(CHAT_WINDOWS, (v) => cb(asSlots(v)), onReady)
}
async function winChat(channel: string, payload: unknown[]): Promise<unknown> {
  try {
    return await invoke('ipc_call', { channel, payload })
  } catch {
    return null
  }
}
/** 열려 있는 창 자리 전부(요청/응답 — 구독 레이스의 따라잡기용). */
export async function listChatWindows(): Promise<WindowSlot[]> {
  return asSlots(await winChat(WIN_CHAT_LIST, []))
}
/** 그 대화의 창을 앞으로 — **창이 없으면 되만든다**(닫힌 자리 클릭의 착지점). */
export async function focusChatWindow(chatId: string): Promise<WindowSlot[]> {
  if (!chatId) return []
  return asSlots(await winChat(WIN_CHAT_FOCUS, [{ chatId }]))
}
/** 창만 닫는다 — 대화는 목록에 남는다(삭제가 아니다). */
export async function closeChatWindow(chatId: string): Promise<boolean> {
  if (!chatId) return false
  return (await winChat(WIN_CHAT_CLOSE, [{ chatId }])) === true
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
