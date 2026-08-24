/* ============================================================================
 * ★R28 ACCT — **계정 표면의 단일 스토어**(`docs/r28-followup.md` §1·§3·§3-b).
 *
 * 이 파일이 생기기 전, 계정 정보를 그리는 표면은 셋이었고 저마다 자기 캐시를 들고
 * 있었다: 설정 ▸ Account(`Settings.tsx`의 `useState` 넷) · 채팅 계정 picker
 * (`Chat.tsx`의 모듈 캐시 넷) · 커밋 카드(`GitModal.tsx`). 그래서 —
 *
 *  1. 설정과 picker를 같은 순간에 열면 **같은 조회가 두 번** 나갔다(실 HTTP, 1200ms
 *     직렬 게이트를 각각 지난다 = 계정 수 × 2회).
 *  2. 실패가 「데이터 없음」과 구분되지 않아, 429 한 번이면 화면이 그냥 비었다.
 *  3. 첫 페인트가 HTTP를 기다렸다 — 계정 3개면 3.6초 뒤에야 첫 숫자가 떴다.
 *
 * ## 규칙 넷
 *
 *  1. **캐시 우선(stale-while-revalidate).** 마지막으로 안 값(디스크 보존)을 즉시
 *     그리고 뒤에서 갱신한다. `cachedOnly` 조회는 HTTP를 한 번도 안 쏜다.
 *  2. **인플라이트 중복 0.** 조회는 이 모듈의 프로미스 하나이고, 표면 몇 개가 동시에
 *     물어도 그 하나에 합류한다.
 *  3. **실패는 실패라고 말한다.** 계정별 `stale`/`unavailable` 표식을 그대로 들고
 *     다니고, 수동 재시도가 있다.
 *  4. **워밍은 토큰을 회전시키지 않는다.** `warm:true`는 로컬 토큰이 살아 있는 계정만
 *     건드린다(M11 R2 C1 — 부팅 프리웜을 들어낸 그 이유). 사용자가 탭을 직접 열면
 *     `warm:false`라 그때는 옛 규약 그대로다.
 *
 * ## §3의 역인덱스(계정 → 살아 있는 자리)도 여기 산다
 *
 * 판정 소스는 **셸의 `chat:status`**다(`ChatStatusLite.account`). 렌더러가 모은 표를
 * 안 쓰는 이유는 창이 여럿이기 때문이다 — 본채팅·멀티 자리·추가 창·팝아웃이 각자 다른
 * JS 힙이라, 자기 창의 자리만 아는 표로 「다른 곳에서 쓰는 중」을 말할 수 없다.
 * 이 파일은 그 배열에 **자리 이름**만 붙인다(chatId → 「2번 자리」·「추가 창」·「본채팅」).
 * ========================================================================== */
import { useSyncExternalStore } from 'react'
import type { AccountInfo, AccountUsage, ChatStatusLite, CodexAccountInfo, CodexAccountUsage } from '@shared/protocol'
import { t } from './i18n'

// ── 상태 ─────────────────────────────────────────────────────────────────────

export interface AcctState {
  /** null = 아직 한 번도 조회하지 않았다(로딩 스켈레톤과 「계정 없음」의 구분). */
  accounts: AccountInfo[] | null
  usage: Record<string, AccountUsage>
  cxAccounts: CodexAccountInfo[] | null
  cxUsage: Record<string, CodexAccountUsage>
  /** 지금 한도 조회가 도는가(두 엔진 각각). 표면의 스피너가 이걸 본다. */
  loading: boolean
  cxLoading: boolean
  /** 마지막 갱신 시각(ms) — 「N분 전 값」 문구·워밍 쿨다운. */
  at: number
  /** 표면이 값을 다시 그리게 하는 단조 카운터(같은 배열이어도 리렌더가 필요할 때가 있다). */
  rev: number
}

let state: AcctState = {
  accounts: null,
  usage: {},
  cxAccounts: null,
  cxUsage: {},
  loading: false,
  cxLoading: false,
  at: 0,
  rev: 0
}

const subs = new Set<() => void>()

function emit(patch: Partial<AcctState>): void {
  state = { ...state, ...patch, rev: state.rev + 1 }
  for (const s of subs) s()
}

function subscribe(cb: () => void): () => void {
  subs.add(cb)
  return () => {
    subs.delete(cb)
  }
}

const snapshot = (): AcctState => state

/** 지금 값 한 벌(React 밖) — 이벤트 핸들러·하네스가 읽는 문. */
export function accountState(): AcctState {
  return state
}

/** 계정 표면 구독 — 설정 탭·picker·커밋 카드가 같은 값을 본다. */
export function useAccounts(): AcctState {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

// ── 조회 (인플라이트 중복 제거) ───────────────────────────────────────────────

/** 계정 목록은 설정에서만 바뀐다 — 1분이면 충분히 신선하다(2.6.2 `ACCT_TTL`). */
const LIST_TTL = 60_000
/** 한도 갱신의 렌더러 쪽 바닥 — 셸의 2분 디스크 TTL 안쪽이라 값이 달라질 일이 없다. */
const USAGE_TTL = 60_000
/** 워밍 쿨다운 — 창 포커스가 잦아도 그 간격 안에는 다시 안 묻는다. */
const WARM_COOLDOWN = 90_000

let listAt = 0
let listFlight: Promise<AccountInfo[]> | null = null
let cxListAt = 0
let cxListFlight: Promise<CodexAccountInfo[]> | null = null
let usageFlight: Promise<Record<string, AccountUsage>> | null = null
let cxUsageFlight: Promise<Record<string, CodexAccountUsage>> | null = null
let lastWarmAt = 0

function byEmail<T extends { email: string }>(rows: T[]): Record<string, T> {
  const m: Record<string, T> = {}
  for (const r of rows) if (r?.email) m[r.email] = r
  return m
}

/** 등록 계정 목록(양 엔진). TTL 안이면 조회하지 않는다. */
export function ensureAccounts(force = false): Promise<AccountInfo[]> {
  if (!force && state.accounts && Date.now() - listAt < LIST_TTL) return Promise.resolve(state.accounts)
  if (listFlight) return listFlight
  listFlight = window.api.auth
    .listAccounts()
    .then((list) => {
      listAt = Date.now()
      listFlight = null
      emit({ accounts: list })
      return list
    })
    .catch(() => {
      listFlight = null
      // 목록 조회 실패는 **빈 목록으로 굳히지 않는다** — 이미 아는 목록이 있으면 그게 낫다.
      const have = state.accounts ?? []
      if (!state.accounts) emit({ accounts: [] })
      return have
    })
  return listFlight
}

export function ensureCodexAccounts(force = false): Promise<CodexAccountInfo[]> {
  if (!force && state.cxAccounts && Date.now() - cxListAt < LIST_TTL) return Promise.resolve(state.cxAccounts)
  if (cxListFlight) return cxListFlight
  cxListFlight = window.api.codexAuth
    .listAccounts()
    .then((list) => {
      cxListAt = Date.now()
      cxListFlight = null
      emit({ cxAccounts: list })
      return list
    })
    .catch(() => {
      cxListFlight = null
      const have = state.cxAccounts ?? []
      if (!state.cxAccounts) emit({ cxAccounts: [] })
      return have
    })
  return cxListFlight
}

export interface UsageQuery {
  /** 이 계정을 맨 먼저 조회한다(사용자가 지금 보는 계정). */
  priority?: string
  /** 선행 워밍 — 토큰 회전이 필요한 계정은 건너뛴다. */
  warm?: boolean
  /** TTL을 무시하고 지금 묻는다 — **수동 재시도 전용**. */
  force?: boolean
}

/**
 * 계정별 한도 갱신 — **인플라이트 하나**. 이미 도는 조회가 있으면 그것에 합류한다
 * (설정 탭과 picker를 같은 순간에 열어도 HTTP는 한 벌이다).
 *
 * TTL이 앞에 있는 이유: 이 함수는 표면을 **열 때마다** 불린다(팝오버 토글 한 번이
 * 한 번이다). 그대로 흘리면 팝오버를 다섯 번 여닫는 것이 조회 다섯 번이고, usage API는
 * 분당 1~2건이 예산이다. 셸의 2분 디스크 TTL이 HTTP는 막아 주지만 IPC 왕복과 상태
 * 갈아끼우기는 남는다 — 그 몫을 여기서 자른다.
 */
export function refreshUsage(q: UsageQuery = {}): Promise<Record<string, AccountUsage>> {
  if (usageFlight) return usageFlight
  if (!q.force && state.at && Date.now() - state.at < USAGE_TTL) return Promise.resolve(state.usage)
  emit({ loading: true })
  usageFlight = window.api.auth
    .accountsUsage({ priority: q.priority, warm: q.warm })
    .then((rows) => {
      usageFlight = null
      const map = byEmail(rows)
      emit({ usage: map, loading: false, at: Date.now() })
      return map
    })
    .catch(() => {
      usageFlight = null
      emit({ loading: false })
      return state.usage
    })
  return usageFlight
}

export function refreshCodexUsage(): Promise<Record<string, CodexAccountUsage>> {
  if (cxUsageFlight) return cxUsageFlight
  emit({ cxLoading: true })
  cxUsageFlight = window.api.codexAuth
    .accountsUsage()
    .then((rows) => {
      cxUsageFlight = null
      const map = byEmail(rows)
      emit({ cxUsage: map, cxLoading: false })
      return map
    })
    .catch(() => {
      cxUsageFlight = null
      emit({ cxLoading: false })
      return state.cxUsage
    })
  return cxUsageFlight
}

/**
 * **첫 페인트** — 디스크에 보존된 마지막 값만 그린다(HTTP 0회). 앱을 켜자마자,
 * 그리고 표면을 열 때마다 이걸 먼저 부르면 게이지가 빈 칸으로 뜨는 순간이 사라진다.
 */
export function primeUsageFromDisk(): Promise<void> {
  return window.api.auth
    .accountsUsage({ cachedOnly: true })
    .then((rows) => {
      if (!rows.length) return
      // 이미 실조회 값이 들어와 있으면 낡은 값으로 덮지 않는다.
      if (state.at) return
      emit({ usage: byEmail(rows) })
    })
    .catch(() => {})
}

/**
 * 선행 워밍 — 시작·창 포커스에서 부른다. 쿨다운 안이면 아무 일도 안 한다.
 * `priority`는 사용자가 지금 보는 계정(활성 계정)이다.
 */
export function warmUsage(priority?: string): void {
  if (Date.now() - lastWarmAt < WARM_COOLDOWN) return
  lastWarmAt = Date.now()
  void ensureAccounts().then((list) => {
    if (!list.length) return
    void refreshUsage({ priority, warm: true })
  })
}

/** 계정 목록이 바뀐 뒤(로그인·삭제·정렬) — 목록과 한도를 다시 뜬다. */
export function invalidateAccounts(): void {
  listAt = 0
  cxListAt = 0
}

/** 셸이 새 목록을 돌려준 자리(로그인·삭제·정렬)에서 스토어를 바로 맞춘다. */
export function putAccounts(list: AccountInfo[]): void {
  listAt = Date.now()
  emit({ accounts: list })
}
export function putCodexAccounts(list: CodexAccountInfo[]): void {
  cxListAt = Date.now()
  emit({ cxAccounts: list })
}

/**
 * 함수형 갱신 — 드래그 재정렬의 **낙관 갱신**이 쓰는 문.
 *
 * `useState`의 함수형 setState와 같은 의미론이 필요하다: 놓는 순간의 저장은 "마지막
 * move까지 반영된" 배열을 재료로 써야 하고, 렌더 사이에 낀 값을 읽으면 한 칸 어긋난다.
 * 스토어가 동기라 그냥 최신 상태를 읽어 적용하면 그 성질이 그대로 산다.
 */
export function updateAccounts(fn: (prev: AccountInfo[] | null) => AccountInfo[] | null): void {
  const next = fn(state.accounts)
  if (next !== state.accounts) emit({ accounts: next })
}
export function updateCodexAccounts(fn: (prev: CodexAccountInfo[] | null) => CodexAccountInfo[] | null): void {
  const next = fn(state.cxAccounts)
  if (next !== state.cxAccounts) emit({ cxAccounts: next })
}

// ── ★§3 역인덱스 — 계정 → 살아 있는 자리 ────────────────────────────────────

/** 한 자리(살아 있는 채팅) — 라벨은 표시 계층이 붙인다. */
export interface AcctSlot {
  chatId: string
  /** 「본채팅」·「2번 자리」·「추가 창」 — 모르면 빈 문자열(그때는 개수만 말한다). */
  label: string
  /** 이 자리가 **지금 보고 있는 그 채팅**인가(§3의 「이 채팅」 표기). */
  self: boolean
}

/** `${boardId}::${slot}` → 자리 번호. 형식이 아니면 `null`(지어내지 않는다). */
function slotOf(panelId?: string | null): number | null {
  const i = panelId?.lastIndexOf('::') ?? -1
  if (i < 0) return null
  const n = Number(panelId!.slice(i + 2))
  return Number.isInteger(n) && n >= 0 ? n : null
}

/**
 * chatId → 자리 이름. 창마다 아는 범위가 달라 **표시용**으로만 쓴다.
 *
 * 등록자가 여럿이라(본채팅 목록 · 멀티 자리 · 추가 창) **구역별**로 넣는다 — 한 벌짜리
 * 맵이면 나중에 등록한 쪽이 앞의 것을 통째로 지운다.
 */
const slotScopes: Record<string, Record<string, string>> = {}
let slotNames: Record<string, string> = {}
/** 셸이 준 살아 있는 채팅들(계정 키가 있는 행만). */
let liveRows: { chatId: string; account: string; panelId: string }[] = []

/**
 * `chat:status` REPLACE를 스토어에 앉힌다. **키가 있는 행만** 산다 —
 * `account` 키는 살아 있는 런타임만 싣기 때문이다(`engine/lite.rs`).
 */
export function putChatStatuses(rows: ChatStatusLite[]): void {
  const next: { chatId: string; account: string; panelId: string }[] = []
  for (const r of rows) {
    const acct = r?.account
    if (r?.chatId && typeof acct === 'string' && acct) next.push({ chatId: r.chatId, account: acct, panelId: r.panelId ?? '' })
  }
  // 같은 내용이면 팬아웃하지 않는다(스레드 꼬리 윈도잉을 흔드는 헛 렌더 방지).
  const same =
    next.length === liveRows.length &&
    next.every((n, i) => liveRows[i].chatId === n.chatId && liveRows[i].account === n.account && liveRows[i].panelId === n.panelId)
  if (same) return
  liveRows = next
  emit({})
}

/**
 * 자리 이름표를 **구역 단위로** 등록한다(`'chats'`·`'panels'`·`'wins'`).
 * 같은 값이면 팬아웃하지 않는다 — 헛 렌더 하나가 스레드 꼬리 윈도잉을 흔든다.
 */
export function putSlotNames(scope: string, names: Record<string, string>): void {
  const prev = slotScopes[scope]
  const keys = Object.keys(names)
  if (prev && keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === names[k])) return
  slotScopes[scope] = names
  slotNames = Object.assign({}, ...Object.values(slotScopes)) as Record<string, string>
  emit({})
}

/**
 * 이 계정을 **지금 물고 있는 자리들**. `selfKey`(그 화면의 chatId 또는 panelId)가 그중에
 * 있으면 `self:true`가 되고, 호출부가 그 항목을 빼고 세면 「다른 자리 사용 중」이 된다.
 *
 * 이름표의 출처는 둘이다: 멀티 자리는 셸이 준 `panelId`에서 번호를 뜨고(그 대응은 보드
 * 스토어만 안다), 본채팅·추가 창은 이 창이 등록한 이름표를 쓴다.
 */
export function slotsUsing(email: string | undefined, selfKey?: string): AcctSlot[] {
  if (!email) return []
  return liveRows
    .filter((r) => r.account === email)
    .map((r) => {
      const slot = slotOf(r.panelId)
      return {
        chatId: r.chatId,
        label: slot != null ? panelSlotName(slot) : (slotNames[r.chatId] ?? ''),
        self: !!selfKey && (r.chatId === selfKey || (!!r.panelId && r.panelId === selfKey))
      }
    })
}

/**
 * 「사용 중」 칩의 문구 — 없으면 `null`.
 *
 * 규약(§3):
 *  - 다른 자리 하나: 「사용 중 · 2번 자리」(이름을 모르면 「사용 중 · 다른 자리」)
 *  - 여럿: 「사용 중 · 2곳」
 *  - **이 채팅뿐**이면 칩을 안 단다 — 그건 §3-b의 「현재」가 이미 말한 사실이다.
 */
export function inUseLabel(email: string | undefined, selfKey?: string): string | null {
  const others = slotsUsing(email, selfKey).filter((s) => !s.self)
  if (!others.length) return null
  if (others.length > 1) return t(`사용 중 · ${others.length}곳`, `In use · ${others.length} places`)
  return others[0].label
    ? t(`사용 중 · ${others[0].label}`, `In use · ${others[0].label}`)
    : t('사용 중 · 다른 자리', 'In use · another slot')
}

/** 멀티 패널 자리 번호 → 이름표(§3의 「2번 자리」). */
export function panelSlotName(index: number): string {
  return t(`${index + 1}번 자리`, `Slot ${index + 1}`)
}
export const MAIN_SLOT_NAME = (): string => t('본채팅', 'Main chat')
export const WINDOW_SLOT_NAME = (): string => t('추가 창', 'Extra window')
