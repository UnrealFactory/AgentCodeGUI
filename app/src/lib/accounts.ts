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
import { anyRolled, nextReset, nowSec } from './usageWindow'

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
/** 도는 조회가 **사람이 누른 재시도**인가 — 합류 판정의 유일한 축(F5 부수). */
let usageFlightManual = false
/** 도는 조회 뒤에 한 번 더 돌 **수동 재시도**(F5 부수 — 워밍 결과를 재시도로 속이지 않는다). */
let usageQueued: Promise<Record<string, AccountUsage>> | null = null
let cxUsageFlight: Promise<Record<string, CodexAccountUsage>> | null = null
let lastWarmAt = 0

// ── ★2026-09-05 — 지난 창은 저절로 다시 묻는다 ──────────────────────────────
//
// 제보: Anthropic이 한도를 초기화해 줬는데 화면은 「Fable 0% 남음 · 곧」 그대로. 표면은
// 열 때 한 번만 묻고(설정 탭은 주기 폴링이 없다 — usage API 예산) 캐시는 나이만 봤다.
// 여기서는 값이 들어올 때마다 창의 `resetsAt`을 읽어 **그 시각에** 한 번 다시 묻는다:
//  · 이미 지난 창이 있으면 지금(계정당 1분에 한 번 — 조회가 실패해도 여기서 돌지 않게),
//  · 아니면 가장 이른 리셋 시각 + 2초에 타이머 하나.
// HTTP는 셸이 정한다 — 디스크 캐시 적중이면 IPC 왕복뿐이고, 셸도 지난 창은 적중으로 안
// 본다(`ipc/parity/usage.rs`). 격리(429 장기 차단)된 계정은 셸이 건너뛴다.
/** 지난 창의 재조회 최소 간격 — 실패가 이어져도 분당 IPC 한 번(HTTP는 셸의 격리가 막는다). */
const ROLLED_MIN_GAP = 60_000
/** 미래 리셋 타이머의 상한 — 그보다 멀면 그때 가서 다시 잡는다(setTimeout 32비트 한계 안). */
const ROLLED_TIMER_MAX = 30 * 60_000
let rolledTimer: ReturnType<typeof setTimeout> | null = null
const rolledAskedAt: Record<string, number> = {}

function scheduleRolledRefresh(usage: Record<string, AccountUsage>): void {
  const nowMs = Date.now()
  const now = nowSec()
  let due: string | null = null
  let nextMs = Infinity
  for (const u of Object.values(usage)) {
    if (!u?.email) continue
    if (anyRolled(u, now)) {
      const asked = rolledAskedAt[u.email] ?? 0
      if (nowMs - asked >= ROLLED_MIN_GAP) due = due ?? u.email
      else nextMs = Math.min(nextMs, asked + ROLLED_MIN_GAP)
    }
    const nr = nextReset(u, now)
    if (nr != null) nextMs = Math.min(nextMs, nr * 1000 + 2_000)
  }
  if (rolledTimer) {
    clearTimeout(rolledTimer)
    rolledTimer = null
  }
  if (due) {
    rolledAskedAt[due] = nowMs
    // 우선 조회 대상은 지난 창의 계정 — 훑기 자체는 전 계정이라 다른 지난 창도 같은 벌에 돈다.
    void refreshUsage({ priority: due, rolled: true })
    return
  }
  if (!Number.isFinite(nextMs)) return
  const delay = Math.max(1_000, Math.min(nextMs - nowMs, ROLLED_TIMER_MAX))
  rolledTimer = setTimeout(() => {
    rolledTimer = null
    void refreshUsage({ rolled: true })
  }, delay)
}

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
  /**
   * TTL을 무시하고 지금 묻는다 — **수동 재시도 전용**.
   *
   * ★R28 ACCT R2(F5) — 이 값은 셸까지 간다(`retry`). R1은 렌더러 TTL만 넘고 셸에는 안
   * 실려, 연속 실패로 격리된 계정은 사용자가 눌러도 3분 동안 조회가 안 나갔다.
   */
  force?: boolean
  /**
   * ★2026-09-05 — 지난 창 재조회(`scheduleRolledRefresh`). 렌더러 1분 TTL만 넘고, 셸의
   * 격리는 넘지 않는다(`retry`가 아니다 — 사람이 누른 게 아니라 시계가 울린 것이다).
   */
  rolled?: boolean
}

/**
 * 계정별 한도 갱신 — **인플라이트 하나**. 이미 도는 조회가 있으면 그것에 합류한다
 * (설정 탭과 picker를 같은 순간에 열어도 IPC는 한 벌이다).
 *
 * TTL이 앞에 있는 이유: 이 함수는 표면을 **열 때마다** 불린다(팝오버 토글 한 번이
 * 한 번이다). 그대로 흘리면 팝오버를 다섯 번 여닫는 것이 조회 다섯 번이고, usage API는
 * 분당 1~2건이 예산이다. 셸의 2분 디스크 TTL이 HTTP는 막아 주지만 IPC 왕복과 상태
 * 갈아끼우기는 남는다 — 그 몫을 여기서 자른다.
 *
 * ★R28 ACCT R2(N1) — **이 합류는 「이 창 안에서」만 참이다.** `#session`(추가 채팅
 * 창)·`#mapanel`(팝아웃)은 같은 번들의 다른 OS 창 = **다른 JS 힙**이라 이 모듈을 한 벌씩
 * 들고, 그 창들도 picker를 그린다. 창 밖까지 세는 합류는 렌더러에 있을 수가 없어서
 * (모듈 상태를 공유할 방법이 없다) **셸이 진짜 관문이다**: `ipc/parity/usage.rs`의
 * 계정별 레인 + 레인 안 디스크 재확인. 여기 합류는 IPC 왕복을 아끼는 앞단일 뿐이고,
 * 「HTTP 한 벌」의 근거는 저쪽이다(확인 크리틱 R1 N1 — R1은 이 자리를 「중복 0」이라고만
 * 적어 두 창이 겹치는 판을 못 봤다).
 */
function runUsage(q: UsageQuery): Promise<Record<string, AccountUsage>> {
  emit({ loading: true })
  usageFlightManual = !!q.force
  const flight = window.api.auth
    // `retry`는 셸의 실패 격리를 넘는 표식이다(F5) — 사람이 누른 조회에만 붙인다.
    .accountsUsage({ priority: q.priority, warm: q.warm, retry: q.force })
    .then((rows) => {
      usageFlight = null
      const map = byEmail(rows)
      emit({ usage: map, loading: false, at: Date.now() })
      scheduleRolledRefresh(map)
      return map
    })
    .catch(() => {
      usageFlight = null
      emit({ loading: false })
      return state.usage
    })
  usageFlight = flight
  return flight
}

export function refreshUsage(q: UsageQuery = {}): Promise<Record<string, AccountUsage>> {
  if (usageFlight) {
    // ★R28 ACCT R2(F5 부수) — **수동 재시도는 「약한 조회」에 합류하지 않는다.**
    //
    // 도는 것이 워밍이면 그 결과에는 「토큰이 만료돼 건너뛴 계정」이 비어 있고, 자동
    // 갱신이면 「연속 실패로 격리된 계정」이 비어 있다 — 사용자가 「다시 시도」로 보려는
    // 것이 정확히 그 계정들이다. 그 값을 받아 놓고 「다시 시도했다」고 하면 버튼이
    // 거짓말을 한다. 대신 앞선 조회가 끝난 **뒤에** 한 번 더 돈다.
    //
    // 재시도끼리는 그대로 합류한다 — §1의 「인플라이트 중복 0」(설정 탭 + picker 동시)은
    // 이 축에서 갈리지 않는다.
    if (!q.force || usageFlightManual) return usageFlight
    // 여러 번 눌러도 꼬리는 하나다.
    if (!usageQueued) {
      const again = (): Promise<Record<string, AccountUsage>> => {
        usageQueued = null
        return runUsage(q)
      }
      usageQueued = usageFlight.then(again, again)
    }
    return usageQueued
  }
  if (!q.force && !q.rolled && state.at && Date.now() - state.at < USAGE_TTL) return Promise.resolve(state.usage)
  return runUsage(q)
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
      const map = byEmail(rows)
      emit({ usage: map })
      // 디스크의 마지막 값에 지난 창이 있으면(앱을 켜자마자 「곧」) 곧바로 다시 묻는다.
      scheduleRolledRefresh(map)
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

/**
 * 계정 목록이 바뀐 뒤(로그인·삭제·정렬) — 목록과 한도를 다시 뜬다.
 *
 * ★R28 ACCT R2 — **한도의 신선도까지 버린다.** 계정 하나가 늘거나 줄면 지금 들고 있는
 * 한도 표는 그 계정에 대해 아무 말도 못 한다(새 계정은 값이 아예 없다). R1은 목록
 * 캐시만 놓아, 로그인 직후 60초 동안 새 계정의 게이지가 빈 칸이었다.
 * (`at`은 이 모듈의 TTL 축이고 화면은 안 읽는다 — 값을 지우는 것이 아니라 나이만 지운다.)
 */
export function invalidateAccounts(): void {
  listAt = 0
  cxListAt = 0
  emit({ at: 0 })
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
let liveRows: { chatId: string; account: string; panelId: string; seat: number | null }[] = []

/**
 * `chat:status` REPLACE를 스토어에 앉힌다. **키가 있는 행만** 산다 —
 * `account` 키는 살아 있는 런타임만 싣기 때문이다(`engine/lite.rs`).
 */
export function putChatStatuses(rows: ChatStatusLite[]): void {
  const next: { chatId: string; account: string; panelId: string; seat: number | null }[] = []
  for (const r of rows) {
    const acct = r?.account
    if (r?.chatId && typeof acct === 'string' && acct)
      next.push({ chatId: r.chatId, account: acct, panelId: r.panelId ?? '', seat: typeof r.seat === 'number' ? r.seat : null })
  }
  // 같은 내용이면 팬아웃하지 않는다(스레드 꼬리 윈도잉을 흔드는 헛 렌더 방지).
  const same =
    next.length === liveRows.length &&
    next.every(
      (n, i) =>
        liveRows[i].chatId === n.chatId && liveRows[i].account === n.account && liveRows[i].panelId === n.panelId && liveRows[i].seat === n.seat
    )
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
      // ★3.0.5 — 번호는 셸이 준 **보이는 자리**(`seat`)다. `panelId`의 슬롯 인덱스는 정체성이라
      // 드래그로 옮겨도 안 변해, 그걸 번호로 그리면 화면의 1번이 칩에는 「3번 자리」였다
      // (2026-09-03 보고). 자리에 앉았는데 번호가 없으면 접힌 자리다.
      const seated = slotOf(r.panelId) != null
      const label = r.seat != null ? panelSlotName(r.seat - 1) : seated ? t('접힌 자리', 'folded slot') : (slotNames[r.chatId] ?? '')
      return {
        chatId: r.chatId,
        label,
        self: !!selfKey && (r.chatId === selfKey || (!!r.panelId && r.panelId === selfKey))
      }
    })
}

/**
 * **이 자리의 살아 있는 런타임이 지금 물고 있는 계정** — 없으면 `undefined`.
 *
 * 바인딩이 없는 채팅의 「현재」는 `목록 맨 위`가 아니라 이 값이어야 한다. 런타임은
 * 첫 실행 때의 맨 위를 정체성으로 굳히고(`identity.rs` normalize → `to_raw`가 계정을
 * 박는다) 이후 실행 요청에 계정이 없으면 그대로 간다 — 그 사이 설정에서 정렬해 맨 위가
 * 바뀌어도 이 채팅은 옛 계정으로 돈다. picker가 새 맨 위를 「현재」라고 적으면 실행과
 * 표시가 갈린다(3.0.0 보고: 「선택한 계정이 제대로 안 된다」).
 */
export function liveAccountOf(selfKey?: string): string | undefined {
  if (!selfKey) return undefined
  return liveRows.find((r) => r.chatId === selfKey || (!!r.panelId && r.panelId === selfKey))?.account
}

/** chatId → 셸이 준 보드 자리(`${boardId}::${slot}`). 살아 있는 행에 없으면 `null`
 *  (★2026-09-04 — 팝아웃·그리드가 `chat:identity`의 chatId를 자기 자리와 잇는 데 쓴다). */
export function panelIdOfChat(chatId: string): string | null {
  return liveRows.find((r) => r.chatId === chatId)?.panelId || null
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
