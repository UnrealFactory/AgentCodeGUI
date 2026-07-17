import { useEffect, useReducer, useRef, useState } from 'react'
import type {
  AgentStatus,
  AgentQuestion,
  BgTask,
  ChangedFile,
  EngineEvent,
  EngineId,
  FileDiff,
  SubAgentInfo,
  TermLine,
  Todo,
  TokenTally,
  TokenUse,
  ToolLogItem
} from '@shared/protocol'

export type ThreadItem =
  | { kind: 'msg'; id: string; role: 'user' | 'assistant'; text: string; animate: boolean; error?: boolean; time: string; images?: string[] }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'toolgroup'; id: string; tools: ToolLogItem[]; time: string }
  // a "/command" card (slash commands only — skills/​/clear excluded). Shown the
  // moment the command starts (running:true, with a spinner) and updated in place to
  // the completed summary when it finishes — so the run is never a blank freeze.
  | {
      kind: 'cmdresult'
      id: string
      name: string
      title: string
      sub: string | null
      stats: string | null
      time: string
      running: boolean
      failed?: boolean
    }
  // 시스템 경고를 스레드에 인라인으로 보여주는 줄 (예: 정책 거부 → 모델 자동 전환, API 과금 안내)
  | { kind: 'notice'; id: string; text: string; time: string }
  // 턴 마무리 줄 (PoC .worked) — 'N초 동안 작업함'. result의 durationMs로 답변 앞에 끼운다
  | { kind: 'worked'; id: string; ms: number }
  // AI 질문의 문답 흔적 (PoC .qa) — 답을 보내면 질문·선택을 스레드에 남긴다 (건너뛰면 없음)
  | { kind: 'qa'; id: string; pairs: { q: string; a: string[] }[] }

export interface SessionState {
  status: AgentStatus
  messages: ThreadItem[]
  todos: Todo[]
  files: ChangedFile[]
  diffs: Record<string, FileDiff>
  terminal: TermLine[]
  subagents: SubAgentInfo[]
  // 백그라운드 작업(셸 등) — 살아있는 건 bg-tasks REPLACE로, 종료 상세는 bg-task-end로 갱신
  bgTasks: BgTask[]
  // engine — 요청한 엔진(카드 헤더 'Claude의 승인 요청'/'GPT의 승인 요청' 표기), 생략=claude
  pendingPermission: { requestId: string; toolName: string; summary: string; engine?: EngineId } | null
  // engine — 질문을 던진 엔진(카드 헤더 'Claude의 질문'/'GPT의 질문' 표기), 생략=claude
  pendingQuestion: { requestId: string; questions: AgentQuestion[]; engine?: EngineId } | null
  session: { sessionId: string; model: string; cwd: string } | null
  result: {
    costUsd: number | null
    durationMs: number | null
    numTurns: number | null
    contextTokens: number | null
    contextWindow: number | null
  } | null
  // set while a slash command run is in flight; consumed on 'result' to finalize its
  // card (cardId points at the running card pushed in 'begin')
  pendingCommand: { name: string; beforeContext: number | null; beforeMsgs: number; cardId: string } | null
  // 이 대화에서 실제 API 키로 과금된(viaApi) 실행들이 쓴 비용 누적(USD) — 구독 실행의
  // 명목 비용은 실제 청구가 아니므로 더하지 않는다. 예전 스냅샷엔 없을 수 있어 ?? 0으로 읽는다.
  spentUsd: number
  // 이 대화가 지금까지 소모한 모델별 실측 토큰 누적 — 컨텍스트 팝오버 '토큰 사용량'.
  // 키는 엔진이 보고한 표시 모델명, 값은 실행 1건분(result.tokenUsage)의 합.
  // 한도 차감 환산이 아니라 실측 그대로다. 예전 스냅샷엔 없을 수 있어 ?? {}로 읽는다.
  tokenTotals: Record<string, TokenTally>
  thinkingText: string | null
  openGroupId: string | null
  seq: number
  // 이 대화에서 이미 한 번 보여준 '한 번만' 안내(notice)들의 key. 스냅샷에 저장돼 재시작
  // 후에도 유지되고, 같은 key의 once 안내는 이후 다시 끼우지 않는다. (예: 'api-billing')
  shownNotices: string[]
  // 실행 경계 가드 — 현재 실행의 runId. begin이 'pending'(엔진의 analyzing 이벤트 전
  // 표식)으로 갈아끼우고 analyzing이 실 runId를 채택한다. 종결 이벤트(status/result/
  // error)는 현재 실행 것만 반영해, 죽어가는 이전 실행의 늦은 이벤트(정리 유예 중 CLI를
  // 새 실행이 밀어낼 때의 잔재)가 새 실행의 busy·결과를 덮지 못하게 한다.
  // null = 출처 불명(복원 직후 등) — 잘못 거르면 busy가 영영 안 풀리므로 가드 없이 통과.
  curRunId: string | null
}

type Action =
  | { type: 'begin'; text: string; time: string; command: string | null; images?: string[] }
  | { type: 'engine'; event: EngineEvent }
  | { type: 'clear-permission' }
  | { type: 'clear-question' }
  // 질문에 답을 보냄 — pendingQuestion을 닫으며 문답 흔적(qa)을 스레드에 남긴다
  | { type: 'answer-question'; answers: string[][] }
  | { type: 'load'; state: SessionState }

const THINKING_ID = 'thinking'
// begin 직후(엔진의 analyzing 이벤트가 아직)를 나타내는 curRunId 표식 — 이 창에 도착하는
// 종결 이벤트는 전부 이전 실행의 잔재다. 실제 runId는 'run-N'/'cxrun-N'이라 충돌하지 않는다.
const PENDING_RUN = 'pending'

export function nowTime(): string {
  return new Date().toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })
}

// Slash commands that get a card. Skills and /clear (client-side) are excluded.
// `running` is the in-progress title; `sub` the static done description (/compact
// fills it dynamically).
const CMD_CARDS: Record<string, { title: string; running: string; sub: string | null }> = {
  init: { title: 'CLAUDE.md를 정리했어요', running: 'CLAUDE.md를 작성하는 중…', sub: '코드베이스를 분석해 프로젝트 가이드를 작성했습니다.' },
  compact: { title: '대화를 요약했어요', running: '대화를 요약하는 중…', sub: null },
  review: { title: '코드 리뷰를 마쳤어요', running: '코드를 리뷰하는 중…', sub: '변경 사항을 검토했습니다.' },
  'security-review': { title: '보안 검토를 마쳤어요', running: '보안을 검토하는 중…', sub: '변경 사항의 보안 취약점을 점검했습니다.' }
}
/** "/compact …" → "compact" when it's a card command, else null (normal prompt / skill). */
export function commandOf(text: string): string | null {
  const m = /^\/([a-z][a-z-]*)/i.exec(text.trim())
  const name = m?.[1]?.toLowerCase()
  return name && name in CMD_CARDS ? name : null
}
/** Friendly title for naming a chat started by a command. */
export function commandTitleOf(name: string): string {
  return CMD_CARDS[name]?.title ?? name
}
function fmtTokShort(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1000) return Math.round(n / 1000) + 'K'
  return String(n)
}

// Whether two working-directory paths point at the same folder. Used to gate session
// resume: a Claude Code session id is scoped to the project it was created in (its file
// lives under that cwd), so resuming it after the folder changed fails with
// "No conversation found with session ID". The engine echoes a cwd that can differ in
// format from what we sent (separators / trailing slash / drive-letter case), so we
// normalize before comparing — and treat a folder change as "start a fresh conversation".
export function sameCwd(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false
  const norm = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

// Strip live/ephemeral fields before persisting a session snapshot: an in-flight run
// is frozen to idle, transient UI (terminal, open modals, thinking text) is dropped,
// and lingering subagents are marked done. Messages, todos, files, diffs, and the
// session id (for resume) are kept. Shared by the single-chat list and multi-agent panels.
export function snapshotForPersist(s: SessionState): SessionState {
  return {
    ...s,
    status: s.status === 'analyzing' || s.status === 'working' ? 'idle' : s.status,
    terminal: [],
    pendingPermission: null,
    pendingQuestion: null,
    thinkingText: null,
    openGroupId: null,
    pendingCommand: null,
    // drop a command card still mid-run — it would restore as a forever-spinning card
    messages: s.messages.filter((m) => !(m.kind === 'cmdresult' && m.running)),
    subagents: s.subagents.map((a) => (a.status === 'done' ? a : { ...a, status: 'done' as const })),
    // 백그라운드 작업은 CLI 프로세스와 함께 죽으므로 "실행 중"으로 복원되면 거짓말이 된다
    bgTasks: s.bgTasks.map((t) => (t.status === 'running' ? { ...t, status: 'stopped' as const, teardown: true } : t))
  }
}

export const initialSessionState: SessionState = {
  status: 'idle',
  messages: [],
  todos: [],
  files: [],
  diffs: {},
  terminal: [],
  subagents: [],
  bgTasks: [],
  pendingPermission: null,
  pendingQuestion: null,
  session: null,
  result: null,
  pendingCommand: null,
  spentUsd: 0,
  tokenTotals: {},
  thinkingText: null,
  openGroupId: null,
  seq: 0,
  shownNotices: [],
  curRunId: null
}

// ── growth caps ──────────────────────────────────────────────
// A long autonomous session (worst case: 6 multi-agent panels in bypass mode, all
// streaming at once) produces tens of thousands of events. Nothing user-visible needs
// unbounded history, and unbounded arrays held live in 6 panels simultaneously are
// what eventually OOM-kill the renderer. Oldest entries fall off each cap.
const MAX_THREAD_ITEMS = 500
const MAX_TOOLS_PER_GROUP = 400
const MAX_SUBAGENT_TOOLS = 200
const MAX_SUBAGENT_LOG = 100
const MAX_TERMINAL_LINES = 500
const MAX_DIFF_LINES = 4000

// 실행 1건분의 모델별 토큰(result.tokenUsage)을 대화 누적(tokenTotals)에 더한다.
// 보고가 없으면(생략·빈 배열) 기존 객체를 그대로 돌려줘 불필요한 리렌더를 만들지 않는다.
function mergeTokenUse(prev: Record<string, TokenTally> | undefined, use: TokenUse[] | undefined): Record<string, TokenTally> {
  const base = prev ?? {}
  if (!use?.length) return base
  const next = { ...base }
  for (const u of use) {
    const t = next[u.model] ?? { inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0 }
    next[u.model] = {
      inTok: t.inTok + u.inTok,
      outTok: t.outTok + u.outTok,
      cacheRead: t.cacheRead + u.cacheRead,
      cacheWrite: t.cacheWrite + u.cacheWrite
    }
  }
  return next
}

// 스레드 끝의 '작업함' 줄을 건너뛴 마지막 항목 index — 답변의 부드러운 공개(live)는
// 이 index 기준이라, result가 끝에 worked를 붙여도 공개 애니메이션이 뚝 끊기지 않는다.
export function liveMsgIndex(list: ThreadItem[]): number {
  let i = list.length - 1
  while (i >= 0 && list[i].kind === 'worked') i--
  return i
}

function capThread(list: ThreadItem[]): ThreadItem[] {
  return list.length > MAX_THREAD_ITEMS ? list.slice(list.length - MAX_THREAD_ITEMS) : list
}
function capPush<T>(list: T[], item: T, max: number): T[] {
  return list.length >= max ? [...list.slice(-(max - 1)), item] : [...list, item]
}

// Rebuild a persisted snapshot defensively before loading it into live state.
// Snapshots are written as one JSON blob; a crash mid-write or schema drift can leave
// fields missing or wrongly shaped, and spreading such a blob straight into the
// reducer makes the first render throw (`messages.map is not a function`) — which,
// without an error boundary, white-screens the whole workspace and repeats on every
// launch. Anything malformed falls back to its empty initial value.
export function sanitizeSnapshot(raw: unknown): SessionState {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
  const obj = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

  const messages = arr<ThreadItem>(r.messages)
    .filter((m): m is ThreadItem => !!m && typeof m === 'object' && typeof (m as { kind?: unknown }).kind === 'string')
    .map((m) => (m.kind === 'toolgroup' && !Array.isArray(m.tools) ? { ...m, tools: [] } : m))
  const subagents = arr<SubAgentInfo>(r.subagents)
    .filter((a) => !!a && typeof a === 'object')
    .map((a) => ({ ...a, tools: Array.isArray(a.tools) ? a.tools : [], log: Array.isArray(a.log) ? a.log : undefined }))
  const diffs: Record<string, FileDiff> = {}
  const rawDiffs = obj(r.diffs)
  if (rawDiffs) {
    for (const key of Object.keys(rawDiffs)) {
      const d = rawDiffs[key] as FileDiff | null
      if (d && typeof d === 'object' && Array.isArray(d.lines)) diffs[key] = d
    }
  }
  const session = obj(r.session)
  const result = obj(r.result)
  // 대화 누적 토큰 — 숫자 아닌 필드는 0으로 접고, 형태가 아예 다르면 항목째 버린다
  const tokenTotals: Record<string, TokenTally> = {}
  const rawTok = obj(r.tokenTotals)
  if (rawTok) {
    const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : 0)
    for (const key of Object.keys(rawTok)) {
      const t = obj(rawTok[key])
      if (t) tokenTotals[key] = { inTok: num(t.inTok), outTok: num(t.outTok), cacheRead: num(t.cacheRead), cacheWrite: num(t.cacheWrite) }
    }
  }
  // an in-flight status must never restore as busy (the run died with the app);
  // completed states keep their sidebar dot
  const status: AgentStatus = r.status === 'done' || r.status === 'error' ? r.status : 'idle'
  return {
    ...initialSessionState,
    status,
    messages: capThread(messages),
    todos: arr<Todo>(r.todos).filter((t) => !!t && typeof t === 'object'),
    files: arr<ChangedFile>(r.files).filter((f) => !!f && typeof f === 'object'),
    diffs,
    subagents,
    bgTasks: arr<BgTask>(r.bgTasks).filter((t) => !!t && typeof t === 'object' && typeof t.id === 'string'),
    session: session
      ? { sessionId: String(session.sessionId ?? ''), model: String(session.model ?? ''), cwd: String(session.cwd ?? '') }
      : null,
    result: result
      ? {
          costUsd: typeof result.costUsd === 'number' ? result.costUsd : null,
          durationMs: typeof result.durationMs === 'number' ? result.durationMs : null,
          numTurns: typeof result.numTurns === 'number' ? result.numTurns : null,
          contextTokens: typeof result.contextTokens === 'number' ? result.contextTokens : null,
          contextWindow: typeof result.contextWindow === 'number' ? result.contextWindow : null
        }
      : null,
    spentUsd: typeof r.spentUsd === 'number' ? r.spentUsd : 0,
    tokenTotals,
    seq: typeof r.seq === 'number' ? r.seq : 0,
    // 예전 이름(dismissedNotices)도 읽어 마이그레이션
    shownNotices: arr<unknown>(r.shownNotices ?? r.dismissedNotices).filter((x): x is string => typeof x === 'string')
  }
}

// export는 리플레이 하네스용 — 앱 코드는 useAgentSession을 통해서만 쓴다
export function reducer(state: SessionState, action: Action): SessionState {
  if (action.type === 'load') {
    return action.state
  }

  if (action.type === 'clear-permission') {
    return { ...state, pendingPermission: null }
  }

  if (action.type === 'clear-question') {
    return { ...state, pendingQuestion: null }
  }

  if (action.type === 'answer-question') {
    const pq = state.pendingQuestion
    if (!pq) return state
    // 실제로 답한 질문만 흔적으로 남긴다 (전부 비어 있으면 카드만 닫는다)
    const pairs = pq.questions
      .map((q, i) => ({ q: q.question, a: action.answers[i] ?? [] }))
      .filter((p) => p.a.length > 0)
    if (!pairs.length) return { ...state, pendingQuestion: null }
    const seq = state.seq + 1
    return {
      ...state,
      seq,
      pendingQuestion: null,
      messages: capThread([...state.messages, { kind: 'qa', id: `qa${seq}`, pairs }])
    }
  }

  if (action.type === 'begin') {
    const seq = state.seq + 1
    const cmd = action.command
    const without = state.messages.filter((m) => m.id !== THINKING_ID)
    const cardId = `cmd${seq}`
    return {
      ...state,
      status: 'analyzing',
      // 새 실행의 analyzing이 오기 전까지 종결 이벤트를 전부 잔재로 취급 (실행 경계 가드)
      curRunId: PENDING_RUN,
      // 백그라운드 셸은 턴을 못 넘기고 CLI와 함께 죽으므로, 지난 턴의 종료 항목을 계속
      // 끌고 다니면 매 대화마다 죽은 셸이 다시 보인다 — 새 턴 시작에 비운다 (칩=현재 턴)
      bgTasks: [],
      // a command run replaces the user bubble with a live "running" card (spinner)
      // pushed right away, so the run shows immediate feedback instead of a blank gap
      messages: capThread(
        cmd
          ? [
              ...without,
              { kind: 'cmdresult', id: cardId, name: cmd, title: CMD_CARDS[cmd].running, sub: null, stats: null, time: action.time, running: true }
            ]
          : [...without, { kind: 'msg', id: `u${seq}`, role: 'user', text: action.text, animate: false, time: action.time, images: action.images?.length ? action.images : undefined }]
      ),
      // snapshot the pre-run context so /compact can report real savings on completion
      pendingCommand: cmd
        ? { name: cmd, beforeContext: state.result?.contextTokens ?? null, beforeMsgs: without.filter((m) => m.kind === 'msg').length, cardId }
        : null,
      // 할 일 (task plan) and 변경된 파일 (cumulative diff) are session-scoped, not
      // per-turn output — keep them across messages so they don't blank out and flicker
      // back when the next turn starts. Tasks: the engine retains them per session and
      // re-emits the full list on each change (replaced, never duplicated). Files: the
      // file-change reducer merges by path, so re-editing a file across turns accumulates.
      todos: state.todos,
      files: state.files,
      diffs: state.diffs,
      // drop only *completed* subagents at the start of a turn — still-running ones are
      // kept (e.g. spawned in parallel/background while the main agent moves on to the
      // next message). This bounds growth (done ones clear next turn) without wiping
      // in-flight work. A subagent has no agent-driven delete, so we prune here.
      subagents: state.subagents.filter((a) => a.status !== 'done'),
      // terminal is the current run's live command stream — start each turn clean
      terminal: [],
      pendingPermission: null,
      pendingQuestion: null,
      // keep the previous turn's result (only its contextTokens is shown) so the
      // "현재 컨텍스트" gauge holds its last value during the run instead of
      // dropping to 0 — it refreshes when this run emits its own result.
      result: state.result,
      thinkingText: null,
      openGroupId: null,
      seq
    }
  }

  const e = action.event
  // 실행 경계 가드 — 죽어가는 이전 실행의 늦은 종결 이벤트인지. begin 직후(pending)면
  // 현 실행의 analyzing 전이므로 전부 잔재고, runId 채택 후엔 다른 id를 거른다.
  // curRunId=null(복원 등 출처 불명)은 통과 — 잘못 거르면 busy가 영영 안 풀린다.
  const staleRun = (runId: string): boolean =>
    state.curRunId === PENDING_RUN || (!!state.curRunId && state.curRunId !== runId)
  switch (e.type) {
    case 'status':
      // analyzing = 모든 실행의 첫 이벤트 (엔진 계약) — 이 실행을 현재 실행으로 채택
      if (e.status === 'analyzing') return { ...state, status: 'analyzing', curRunId: e.runId }
      if (staleRun(e.runId)) return state
      return { ...state, status: e.status }

    case 'session':
      return { ...state, session: { sessionId: e.sessionId, model: e.model, cwd: e.cwd } }

    case 'thinking':
      return { ...state, thinkingText: e.text }
    case 'thinking-clear':
      return { ...state, thinkingText: null }

    case 'assistant-stream': {
      // append a streamed chunk to the in-progress assistant message (creating it
      // on the first chunk). animate:false — the streaming itself is the animation.
      // Hot path first: the streamed message is almost always the last item — update
      // it in place instead of re-filtering + re-mapping the whole history per token.
      const last = state.messages[state.messages.length - 1]
      if (last && last.kind === 'msg' && last.id === e.messageId) {
        const messages = state.messages.slice()
        messages[messages.length - 1] = { ...last, text: last.text + e.delta }
        return { ...state, thinkingText: null, openGroupId: null, messages }
      }
      const without = state.messages.filter((m) => m.id !== THINKING_ID)
      const exists = without.some((m) => m.id === e.messageId)
      const messages = exists
        ? without.map((m) => (m.id === e.messageId && m.kind === 'msg' ? { ...m, text: m.text + e.delta } : m))
        : capThread([...without, { kind: 'msg' as const, id: e.messageId, role: 'assistant' as const, text: e.delta, animate: false, time: nowTime() }])
      return { ...state, thinkingText: null, openGroupId: null, messages }
    }

    case 'assistant-done': {
      // finalize: if the message was streamed, replace its text with the
      // authoritative final text; otherwise add it fresh.
      const without = state.messages.filter((m) => m.id !== THINKING_ID)
      const exists = without.some((m) => m.id === e.messageId)
      if (exists) {
        return {
          ...state,
          openGroupId: null,
          messages: without.map((m) => (m.id === e.messageId && m.kind === 'msg' ? { ...m, text: e.text, animate: false } : m))
        }
      }
      return {
        ...state,
        openGroupId: null,
        messages: capThread([
          ...without,
          // animate short replies for a streaming feel; render long output instantly
          { kind: 'msg', id: e.messageId, role: 'assistant', text: e.text, animate: e.text.length <= 280, time: nowTime() }
        ])
      }
    }

    case 'tool-start': {
      // tools spawned inside a Task subagent are attributed to that subagent,
      // not the top-level tool log.
      if (e.tool.parentToolId) {
        const pid = e.tool.parentToolId
        return {
          ...state,
          subagents: state.subagents.map((a) => (a.id === pid ? { ...a, tools: capPush(a.tools, e.tool, MAX_SUBAGENT_TOOLS) } : a))
        }
      }
      let messages = state.messages
      let openGroupId = state.openGroupId
      const hasOpen = openGroupId && messages.some((m) => m.kind === 'toolgroup' && m.id === openGroupId)
      if (!hasOpen) {
        const seq = state.seq + 1
        openGroupId = `tg${seq}`
        messages = capThread([...messages.filter((m) => m.id !== THINKING_ID), { kind: 'toolgroup', id: openGroupId, tools: [], time: nowTime() }])
        state = { ...state, seq }
      }
      messages = messages.map((m) =>
        m.kind === 'toolgroup' && m.id === openGroupId ? { ...m, tools: capPush(m.tools, e.tool, MAX_TOOLS_PER_GROUP) } : m
      )
      return { ...state, messages, openGroupId }
    }

    case 'tool-end': {
      // tool-end carries no parentToolId, so update whichever container holds the id.
      // The id lives in exactly one container, and recent tools sit at the end — scan
      // backwards and rebuild only the one message/agent holding it. (The previous
      // full-history rebuild reallocated every message + every subagent tool list on
      // every tool completion, which grows quadratic over a long session.)
      const patch = (t: ToolLogItem): ToolLogItem => ({
        ...t,
        status: e.status,
        result: e.result,
        ...(e.output ? { output: e.output } : {}),
        ...(e.durationMs != null ? { durationMs: e.durationMs } : {}),
        ...(e.links ? { links: e.links } : {}),
        // 완료 때 확정된 대상(Codex webSearch 검색어)이 실려 오면 자리 문구를 덮는다
        ...(e.target ? { target: e.target } : {})
      })
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const m = state.messages[i]
        if (m.kind !== 'toolgroup') continue
        for (let k = m.tools.length - 1; k >= 0; k--) {
          if (m.tools[k].id !== e.id) continue
          const tools = m.tools.slice()
          tools[k] = patch(tools[k])
          const messages = state.messages.slice()
          messages[i] = { ...m, tools }
          return { ...state, messages }
        }
      }
      for (let i = state.subagents.length - 1; i >= 0; i--) {
        const a = state.subagents[i]
        for (let k = a.tools.length - 1; k >= 0; k--) {
          if (a.tools[k].id !== e.id) continue
          const tools = a.tools.slice()
          tools[k] = patch(tools[k])
          const subagents = state.subagents.slice()
          subagents[i] = { ...a, tools }
          return { ...state, subagents }
        }
      }
      return state
    }

    case 'todos':
      return { ...state, todos: e.todos }

    case 'file-change': {
      // A full Write replaces the whole file, so its diff supersedes whatever was
      // accumulated for that path — otherwise re-writing a file stacks a second block
      // and double-counts the lines (+17 then +41 → +58). An Edit is incremental, so
      // it still merges onto the existing diff. (`whole` is set by the engine: true for
      // Write — even an overwrite that renders as a real +/− diff — false for Edit.)
      const isWrite = e.whole
      const existing = state.files.find((f) => f.path === e.file.path)
      // most-recently-touched first — a re-edited file bubbles back to the top of the
      // panel instead of staying parked wherever it was first touched
      const updated: ChangedFile =
        !existing || isWrite
          ? e.file
          : { ...existing, add: existing.add + e.file.add, del: existing.del + e.file.del, tag: existing.tag === 'new' ? 'new' : e.file.tag }
      const files = [updated, ...state.files.filter((f) => f.path !== e.file.path)]
      const prevDiff = state.diffs[e.file.path]
      // a file re-edited many times otherwise grows its line array without bound —
      // keep the most recent MAX_DIFF_LINES with a marker where older hunks fell off
      const merged = prevDiff && !isWrite ? [...prevDiff.lines, ...e.diff.lines] : e.diff.lines
      const lines =
        merged.length > MAX_DIFF_LINES
          ? [{ t: 'hunk' as const, text: '@@ 이전 변경 일부 생략 @@' }, ...merged.slice(-MAX_DIFF_LINES)]
          : merged
      const diff: FileDiff =
        prevDiff && !isWrite
          ? { ...prevDiff, add: prevDiff.add + e.diff.add, del: prevDiff.del + e.diff.del, lines }
          : { ...e.diff, lines }
      return { ...state, files, diffs: { ...state.diffs, [e.file.path]: diff } }
    }

    case 'terminal':
      return { ...state, terminal: capPush(state.terminal, e.line, MAX_TERMINAL_LINES) }

    case 'subagent': {
      const existing = state.subagents.find((a) => a.id === e.agent.id)
      if (existing) {
        const subagents = state.subagents.map((a) => {
          if (a.id !== e.agent.id) return a
          // 실행 중 내레이션은 최신 한 줄(activity)로 덮이므로, 변화를 log에 쌓아
          // 카드의 "과정" 섹션이 흐름 전체를 보여줄 수 있게 한다 (완료 시 결과는 제외)
          const act = e.agent.activity
          const log =
            act && e.agent.status === 'running' && act !== a.activity
              ? capPush(a.log ?? [], act, MAX_SUBAGENT_LOG)
              : a.log
          return {
            ...a,
            status: e.agent.status,
            name: e.agent.name || a.name,
            role: e.agent.role || a.role,
            activity: act || a.activity,
            // 모델·소요는 부분 업데이트로 띄엄띄엄 온다 — 빈 값이 기존 값을 지우지 않게
            model: e.agent.model || a.model,
            durationMs: e.agent.durationMs ?? a.durationMs,
            log
          }
        })
        return { ...state, subagents }
      }
      return { ...state, subagents: [...state.subagents, e.agent] }
    }

    case 'bg-tasks': {
      // 살아있는 백그라운드 작업의 REPLACE — 목록에 있으면 실행 중으로 업서트, 실행 중이었는데
      // 사라졌으면 종료로 간주(정확한 상태·요약은 바로 뒤따르는 bg-task-end가 채운다).
      // 이미 종료된 항목은 이번 대화의 기록으로 그대로 남긴다.
      const live = new Map(e.tasks.map((t) => [t.id, t]))
      const next = state.bgTasks.map((t) => {
        const hit = live.get(t.id)
        if (hit) {
          live.delete(t.id)
          return {
            ...t,
            kind: hit.kind || t.kind,
            description: hit.description || t.description,
            // 종료 통지의 실제 경로가 이미 있으면 유도값으로 되덮지 않는다
            outputFile: t.outputFile ?? hit.outputFile,
            status: 'running' as const
          }
        }
        return t.status === 'running' ? { ...t, status: 'completed' as const } : t
      })
      for (const t of live.values()) next.push({ id: t.id, kind: t.kind, description: t.description, outputFile: t.outputFile, status: 'running' })
      return { ...state, bgTasks: next }
    }

    case 'bg-task-end': {
      // 정착 통지 — 추적 중인 id만 반영한다 (포그라운드 Bash·서브에이전트의 정착 통지도
      // 같은 이벤트로 오므로, 모르는 id는 백그라운드였던 적이 없는 작업 → 무시)
      if (!state.bgTasks.some((t) => t.id === e.id)) return state
      return {
        ...state,
        bgTasks: state.bgTasks.map((t) =>
          t.id === e.id
            ? {
                ...t,
                status: e.status,
                summary: e.summary ?? t.summary,
                outputFile: e.outputFile ?? t.outputFile,
                teardown: e.atTurnEnd || undefined,
                byUser: e.byUser ?? t.byUser
              }
            : t
        )
      }
    }

    case 'model-fallback': {
      // Fable 5가 정책상 응답을 거부해 폴백 모델로 전환됨 — 거부된 쪽이 스트리밍하던
      // 부분 답변을 지우고(재시도 답변이 새 말풍선으로 오도록) 경고 배너를 끼워 넣는다.
      const seq = state.seq + 1
      const without = state.messages.filter((m) => m.id !== THINKING_ID && (!e.retractMessageId || m.id !== e.retractMessageId))
      return {
        ...state,
        seq,
        thinkingText: null,
        messages: capThread([...without, { kind: 'notice', id: `fb${seq}`, text: e.text, time: nowTime() }])
      }
    }

    case 'notice': {
      const seq = state.seq + 1
      const item = { kind: 'notice' as const, id: `n${seq}`, text: e.text, time: nowTime() }
      // once 안내(예: API 과금)는 이 대화에서 그 key당 딱 한 번만, 방금 보낸 사용자 메시지
      // 바로 위에 끼워 넣는다 — 'API로 과금 중'을 자기 메시지 바로 위에서 한 번 알아채게.
      if (e.once) {
        if (state.shownNotices.includes(e.once)) return state
        const msgs = state.messages.slice()
        let at = msgs.length
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].kind === 'msg' && (msgs[i] as { role?: string }).role === 'user') {
            at = i
            break
          }
        }
        msgs.splice(at, 0, item)
        return { ...state, seq, shownNotices: [...state.shownNotices, e.once], messages: capThread(msgs) }
      }
      // 그 외 일반 배너(CLI 알림·한도 경고 등) — 진행 상태는 건드리지 않고 끝에 줄만 붙인다
      return { ...state, seq, messages: capThread([...state.messages, item]) }
    }

    case 'permission-request':
      return { ...state, pendingPermission: { requestId: e.requestId, toolName: e.toolName, summary: e.summary, engine: e.engine } }

    case 'question-request':
      return { ...state, pendingQuestion: { requestId: e.requestId, questions: e.questions, engine: e.engine } }

    case 'context': {
      // live mid-run update of just the context-token gauge
      const prev = state.result
      return {
        ...state,
        result: {
          costUsd: prev?.costUsd ?? null,
          durationMs: prev?.durationMs ?? null,
          numTurns: prev?.numTurns ?? null,
          contextTokens: e.contextTokens,
          contextWindow: prev?.contextWindow ?? null
        }
      }
    }

    case 'result': {
      if (staleRun(e.runId)) return state
      const after = e.contextTokens ?? state.result?.contextTokens ?? null
      const window = e.contextWindow ?? state.result?.contextWindow ?? null
      const base = {
        ...state,
        result: {
          costUsd: e.costUsd,
          durationMs: e.durationMs,
          numTurns: e.numTurns,
          // keep the last live context value if the result didn't carry one (e.g. a
          // run that errored before any assistant turn) instead of blanking the gauge
          contextTokens: after,
          // the real window size only arrives with the result; hold the last known
          // value across turns so the denominator stays correct mid-run
          contextWindow: window
        },
        pendingPermission: null,
        pendingQuestion: null,
        pendingCommand: null,
        // API 모드 실행의 비용만 대화 누적에 더한다 (컨텍스트 팝오버 '이번 대화 비용')
        spentUsd: (state.spentUsd ?? 0) + (e.viaApi && e.costUsd ? e.costUsd : 0),
        // 실행 1건분의 모델별 실측 토큰을 대화 누적에 더한다 (컨텍스트 팝오버 '토큰 사용량')
        tokenTotals: mergeTokenUse(state.tokenTotals, e.tokenUsage)
      }
      const without = state.messages.filter((m) => m.id !== THINKING_ID)
      // a slash command finished → finalize its running card in place
      const pc = state.pendingCommand
      if (pc) {
        const cfg = CMD_CARDS[pc.name]
        // failed run: flip the spinner to a failed state (never leave it spinning)
        if (e.isError) {
          return {
            ...base,
            messages: without.map((m) =>
              m.kind === 'cmdresult' && m.id === pc.cardId
                ? { ...m, running: false, failed: true, title: '명령을 완료하지 못했어요', sub: e.text || null, stats: null, time: nowTime() }
                : m
            )
          }
        }
        let sub = cfg.sub
        let stats: string | null = null
        if (pc.name === 'compact') {
          sub =
            pc.beforeMsgs > 0
              ? `이전 ${pc.beforeMsgs}개 메시지를 핵심 요약으로 압축했습니다.`
              : '대화를 핵심 요약으로 압축했습니다.'
          // only when the engine actually reports a smaller context — never fabricate
          const before = pc.beforeContext
          if (before != null && after != null && window && after < before) {
            const bp = Math.round((before / window) * 100)
            const ap = Math.round((after / window) * 100)
            stats = `컨텍스트 ${bp}% → ${ap}% 로 절약 · 토큰 ${fmtTokShort(before - after)} 회수`
          }
        }
        return {
          ...base,
          messages: without.map((m) =>
            m.kind === 'cmdresult' && m.id === pc.cardId
              ? { ...m, running: false, title: cfg.title, sub, stats, time: nowTime() }
              : m
          )
        }
      }
      // surface failure reason as a message (error subtypes carry text in `errors`)
      if (e.isError && e.text) {
        const seq = state.seq + 1
        return {
          ...base,
          seq,
          messages: capThread([...without, { kind: 'msg', id: `rerr${seq}`, role: 'assistant', text: e.text, animate: false, error: true, time: nowTime() }])
        }
      }
      const extra: ThreadItem[] = []
      let seq = state.seq
      // 무음 턴 가시화 — 스트리밍 답변·도구 로그·에러 아무것도 안 남긴 성공 result는
      // 지금까지 조용히 idle로 돌아가 "메시지가 씹힌 것"처럼 보였다(빈 텍스트 result,
      // 시작 직후 죽은 실행 등). 마지막 항목이 방금 보낸 사용자 말풍선 그대로면
      // 안내 줄을 남겨 빈 턴을 눈에 보이게 한다. (실행 중지도 이 모양이 될 수 있어
      // 문구가 그 경우를 함께 안내한다)
      const last = without[without.length - 1]
      if (!e.isError && last?.kind === 'msg' && last.role === 'user') {
        seq += 1
        extra.push({
          kind: 'notice',
          id: `n${seq}`,
          text: '이번 턴이 응답 없이 끝났어요 — 직접 중지한 게 아니라면 메시지를 다시 보내 주세요.',
          time: nowTime()
        })
      }
      // 턴 마무리 줄(PoC .worked) — 'N초 동안 작업함'. 답변 앞은 "읽기 전에 걸리적"
      // 이라는 피드백으로 턴 맨 끝(답변 뒤)에 붙인다.
      if (!e.isError && e.durationMs != null && e.durationMs >= 1000) {
        seq += 1
        extra.push({ kind: 'worked', id: `w${seq}`, ms: e.durationMs })
      }
      if (extra.length) return { ...base, seq, messages: capThread([...without, ...extra]) }
      return base
    }

    case 'error': {
      if (staleRun(e.runId)) return state
      const seq = state.seq + 1
      const without = state.messages.filter((m) => m.id !== THINKING_ID)
      return {
        ...state,
        seq,
        pendingPermission: null,
        pendingQuestion: null,
        messages: capThread([
          ...without,
          { kind: 'msg', id: `err${seq}`, role: 'assistant', text: `오류: ${e.message}`, animate: false, error: true, time: nowTime() }
        ])
      }
    }

    default:
      // exhaustiveness guard — every EngineEvent variant is handled above
      return ((_x: never): SessionState => state)(e)
  }
}

// `subscribe` defaults to the main engine channel; other surfaces (채팅·추가 채팅·
// 멀티 패널) pass their own channel's onEvent so each isolated conversation drives
// through the exact same reducer.
export function useAgentSession(
  subscribe?: (cb: (event: EngineEvent) => void) => () => void
) {
  const [state, dispatch] = useReducer(reducer, initialSessionState)
  const [elapsed, setElapsed] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startRef = useRef(0)

  // subscribe to streaming engine events (main channel by default, or the one passed in)
  useEffect(() => {
    const sub = subscribe ?? window.api.onEngineEvent
    return sub((event) => dispatch({ type: 'engine', event }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // run timer follows status
  const busy = state.status === 'analyzing' || state.status === 'working'
  useEffect(() => {
    if (busy) {
      if (timerRef.current) return
      startRef.current = Date.now()
      setElapsed(0)
      timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000)
    } else if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    return () => {
      // always clear on unmount / dependency change to avoid a leaked interval
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [busy])

  const begin = (text: string, command: string | null = null, images?: string[]): void =>
    dispatch({ type: 'begin', text, time: nowTime(), command, images })
  const clearPermission = (): void => dispatch({ type: 'clear-permission' })
  const clearQuestion = (): void => dispatch({ type: 'clear-question' })
  // 답과 함께 질문을 닫는다 — clearQuestion과 달리 문답 흔적(qa)을 스레드에 남긴다
  const answerQuestion = (answers: string[][]): void => dispatch({ type: 'answer-question', answers })
  // replace the entire live state — used when switching between chats
  const load = (snapshot: SessionState): void => dispatch({ type: 'load', state: snapshot })

  return { state, elapsed, busy, begin, clearPermission, clearQuestion, answerQuestion, load }
}
