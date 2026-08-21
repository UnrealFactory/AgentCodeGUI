import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { app } from 'electron'
import { loadActiveQuery, APP_HOME } from '../engine/versions'
import { readUiPrefs } from '../uiPrefs'
import { disabledSkillOverrides } from '../skills'
import { deniedMcpServers } from '../mcp'
import { getApiKey, addSpend, envKeyChoice, setEnvKeyChoice } from '../apiConfig'
import { recordApiUsage } from '../apiUsage'
import { accountRunDir, syncAccountTokens, defaultAccountEmail } from '../auth'
import type { ApiUsageSource } from '@shared/protocol'
import type {
  EngineEvent,
  RunRequest,
  ModeId,
  ModelId,
  EffortId,
  PermissionResponse,
  QuestionResponse,
  AgentQuestion,
  BgTaskRequest,
  ChangedFile,
  FileDiff,
  Todo,
  TokenUse,
  WorkflowState,
  WorkflowAgent
} from '@shared/protocol'
import { computeLineDiff, newFileDiff } from './diff'
import { lspManager } from '../lsp/manager'
import { t } from '../lang'

type Emit = (event: EngineEvent) => void

// 폴더 미선택 실행의 기본 작업 폴더 = 바탕화면. app.getPath('desktop')는 OneDrive 등으로
// 리디렉션·로컬라이즈된 실제 바탕화면 경로를 돌려준다(드물게 실패하면 홈으로 폴백).
function defaultCwd(): string {
  try {
    return app.getPath('desktop')
  } catch {
    return os.homedir()
  }
}

// Claude Agent SDK permission modes (string literals, kept local to avoid
// depending on the SDK's exact exported type names across versions).
type SdkPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'

// 설정 → Engine의 Claude Code 출력 스타일(ui-prefs 'claude.outputStyle'). CLI 내장
// 스타일(2.1.237 실측: Concise/Explanatory/Learning/Proactive)일 때만 --settings의
// outputStyle로 주입한다 — '기본'(그 외 값)은 미지정으로 두어 사용자의 ~/.claude 설정을
// 존중한다(플래그 설정 계층은 사용자 설정을 이기므로, 안 보낼 때만 전역이 산다).
// 스폰마다 디스크에서 읽는다(스폰 빈도가 낮아 비용 무시 가능) — 상주 주입 게이트
// (optsMatch)가 스폰 시점 값과 현재 값을 비교해, 스타일 변경을 옵션 불일치(새 스폰)로 다룬다.
const CLAUDE_OUTPUT_STYLES = new Set(['Concise', 'Explanatory', 'Learning', 'Proactive'])
function claudeOutputStyle(): string | null {
  const v = readUiPrefs()['claude.outputStyle']
  return typeof v === 'string' && CLAUDE_OUTPUT_STYLES.has(v) ? v : null
}

// Minimal structural views of the SDK message/content shapes we consume.
// Typed loosely on purpose — the SDK's concrete types vary by version and we
// only read a handful of well-known fields.
interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}
interface UsageInfo {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}
function contextFromUsage(u?: UsageInfo): number | null {
  return u
    ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0)
    : null
}

// the real context-window size, read from the result's per-model usage. Several
// models may appear (e.g. a subagent on a smaller model) — the main conversation
// runs on the largest window, so take the max. null when unavailable.
interface ModelUsageEntry {
  contextWindow?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}
function windowFromModelUsage(mu?: Record<string, ModelUsageEntry>): number | null {
  if (!mu) return null
  let max = 0
  for (const key of Object.keys(mu)) {
    const w = mu[key]?.contextWindow
    if (typeof w === 'number' && w > max) max = w
  }
  return max > 0 ? max : null
}

// 실행 1건의 모델별 실측 토큰 — result의 modelUsage(모델 id 키)를 표시명으로 접어
// 내보낸다. 서브에이전트가 다른 모델로 돌면 항목이 여러 개고, [1m] 컨텍스트 변형처럼
// 표시명이 같아지는 id는 하나로 합친다. modelUsage가 없거나 전부 0이면(옛 CLI 방어)
// 합산 usage를 현재 모델 하나로 폴백. 전부 0인 항목은 내보내지 않는다.
function tokenUseFromResult(msg: { modelUsage?: Record<string, ModelUsageEntry>; usage?: UsageInfo }, fallbackModel: string): TokenUse[] {
  const out: TokenUse[] = []
  const push = (t: TokenUse): void => {
    if (t.inTok + t.outTok + t.cacheRead + t.cacheWrite <= 0) return
    const same = out.find((x) => x.model === t.model)
    if (same) {
      same.inTok += t.inTok
      same.outTok += t.outTok
      same.cacheRead += t.cacheRead
      same.cacheWrite += t.cacheWrite
    } else out.push(t)
  }
  for (const [id, u] of Object.entries(msg.modelUsage ?? {})) {
    push({
      model: modelDisplay(id),
      inTok: u?.inputTokens ?? 0,
      outTok: u?.outputTokens ?? 0,
      cacheRead: u?.cacheReadInputTokens ?? 0,
      cacheWrite: u?.cacheCreationInputTokens ?? 0
    })
  }
  if (!out.length && msg.usage) {
    push({
      model: fallbackModel,
      inTok: msg.usage.input_tokens ?? 0,
      outTok: msg.usage.output_tokens ?? 0,
      cacheRead: msg.usage.cache_read_input_tokens ?? 0,
      cacheWrite: msg.usage.cache_creation_input_tokens ?? 0
    })
  }
  return out
}

interface StreamEvent {
  type?: string
  index?: number
  content_block?: { type?: string; name?: string }
  delta?: { type?: string; text?: string; thinking?: string }
}
interface SdkMsg {
  type: string
  subtype?: string
  // system/init: 이 세션의 인증 출처 — 'oauth'(구독 로그인) 또는 API 키 계열
  // ('user'/'project'/'org'/'temporary'). API 모드 검증(과금 경로 확인)에 쓴다.
  apiKeySource?: string
  // message.model: 이 assistant 프레임을 실제로 생성한 모델 id — 세션 중 전환(한도·과부하
  // 폴백 등)을 원인 불문 감지하는 안전망으로 쓴다
  message?: { content?: ContentBlock[] | string; usage?: UsageInfo; model?: string }
  event?: StreamEvent // present on 'stream_event' messages (partial streaming)
  parent_tool_use_id?: string | null
  subagent_type?: string // 이 프레임을 만든 서브에이전트 타입 (사이드체인 판별 보조)
  session_id?: string
  model?: string
  cwd?: string
  tools?: string[]
  result?: string
  errors?: string[]
  is_error?: boolean
  total_cost_usd?: number
  duration_ms?: number
  num_turns?: number
  usage?: UsageInfo
  modelUsage?: Record<string, ModelUsageEntry>
  // system/model_refusal_fallback (Fable 5 정책 거부 → 폴백 모델 전환 알림)
  original_model?: string
  fallback_model?: string
  api_refusal_category?: string | null
  // system/notification (REPL 알림 큐 미러) · system/informational (루프 배너)
  text?: string
  content?: string
  level?: string
  priority?: string
  // system/background_tasks_changed (살아있는 백그라운드 작업 전체 — REPLACE 의미)
  tasks?: Array<{ task_id?: string; task_type?: string; description?: string }>
  // system/task_notification (작업 정착: completed/failed/stopped + 요약·출력 파일)
  task_id?: string
  tool_use_id?: string // 그 작업을 시작한 tool_use 블록 id — 백그라운드 서브에이전트 완료 매칭
  status?: string
  summary?: string
  output_file?: string
  // system/compact_boundary (대화 압축 지점 — trigger 'auto'=컨텍스트 만료 자동, 'manual'=/compact)
  compact_metadata?: { trigger?: string; pre_tokens?: number }
}

interface PermissionResult {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  // SDK permission rules to add when 항상 허용 — e.g. a session-scoped allow for the tool
  updatedPermissions?: unknown[]
  message?: string
}

// what the renderer's permission card resolves with (allow once / always / deny)
type PermChoice = { behavior: 'allow' | 'allow_always' | 'deny'; message?: string }

const READONLY_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'NotebookRead', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task', 'Agent',
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskStop', 'TaskOutput'
])
const MUTATING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'BashOutput', 'KillBash'])

// Tools that feed the 할 일 panel instead of the chat tool-log. TodoWrite sends the
// whole list at once; the Task* family is incremental (create one / update one), so
// the engine accumulates them in `taskMap` and re-emits the full list on each change.
const TASK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList'])

// 'minimal' turns extended thinking off; every other level is an SDK effort
// value (low | medium | high | xhigh | max) — the SDK silently downgrades any
// level the chosen model doesn't support. Fable 5 rejects an explicit
// `thinking: {type:'disabled'}` with a 400 (thinking is already off when the
// param is omitted), so 'minimal' on fable sends nothing instead.
function effortToOptions(effort: EffortId, model: ModelId): Record<string, unknown> {
  if (effort !== 'minimal') return { effort }
  return model === 'fable' ? {} : { thinking: { type: 'disabled' } }
}

function modeToPermission(mode: ModeId): SdkPermissionMode {
  switch (mode) {
    case 'plan':
      return 'plan'
    case 'acceptEdits':
    case 'auto':
      return 'acceptEdits'
    case 'bypass':
      return 'bypassPermissions'
    case 'normal':
    default:
      return 'default'
  }
}

let runCounter = 0
const nextRunId = (): string => `run-${++runCounter}`
let blockCounter = 0
// Unique per app launch. blockCounter resets to 0 every launch, so a resumed chat would
// reissue m1, m2… — ids that already exist in the restored message list. The renderer
// keys assistant messages by id, so a reissued id makes it update the matching *old*
// message in place (it reappears at the top) instead of appending the new reply at the
// bottom. The launch tag keeps ids distinct from any restored from a saved conversation.
const LAUNCH_TAG = Math.random().toString(36).slice(2, 8)
const nextBlockId = (): string => `m${LAUNCH_TAG}-${++blockCounter}`

// ── 엔진 진단 로그(옵트인) — CCG_ENGINE_LOG=1일 때만 APP_HOME/engine-debug.log에 남긴다.
// 상주 CLI가 "언제·왜 닫혔는지"는 재현이 어렵고 로그 없인 사후 추적이 불가능했다(2026-08-03
// 중단 고아 통지 → 턴마다 CLI 사망 꼬임 사고의 교훈). 프로덕션 기본은 무음·무비용.
const ENGINE_DEBUG = !!process.env.CCG_ENGINE_LOG
function dlog(msg: string): void {
  if (!ENGINE_DEBUG) return
  try {
    fs.appendFileSync(path.join(APP_HOME, 'engine-debug.log'), `${new Date().toISOString()} ${msg}\n`)
  } catch {
    /* 진단 로그는 절대 본작업을 방해하지 않는다 */
  }
}

export class ClaudeEngine {
  private emit: Emit
  /** 이 엔진이 속한 화면 (chat/talk/ma) — API 사용 원장의 분류 축 */
  private source: ApiUsageSource
  private abort: AbortController | null = null
  private handle: {
    interrupt?: () => Promise<void>
    // 백그라운드 작업 컨트롤 (SDK Query 메서드) — stopTask: 지정 작업 중지,
    // backgroundTasks: 포그라운드 작업을 백그라운드로 (인자 없으면 전부 = Ctrl+B)
    stopTask?: (taskId: string) => Promise<void>
    backgroundTasks?: (toolUseId?: string) => Promise<boolean>
  } | null = null
  private activeRunId: string | null = null
  /** 현재 실행의 스트리밍 입력을 닫는 손잡이 — 입력이 닫혀야 CLI가 턴 정리 후 종료한다.
   *  워크플로 상주(입력을 열어둔 채 재기동 대기) 중 cancel/dispose가 이걸로 문을 닫는다. */
  private closeInput: (() => void) | null = null
  /** 상주 유지 주입 — 백그라운드 작업이 살아 있는 열린 스트림이 있고 스폰 옵션이 같으면
   *  새 프로세스 대신 그 스트림에 다음 턴을 밀어넣는다(성공 시 새 runId, 불가 시 null →
   *  기존 경로: 이전 실행 취소 후 새 스폰). run()이 매 실행 자기 클로저로 갈아끼운다. */
  private tryInject: ((req: RunRequest) => string | null) | null = null
  /** 직전 run()에서 주입이 거부된 사유 — 지킬 백그라운드 작업이 살아 있는데 옵션 불일치
   *  ('opts')·진행 중 턴('busy')으로 새 스폰(=그 작업들 사망)으로 흐른 경우에만 기록된다.
   *  run()이 소비해 "백그라운드 작업이 왜 정리됐는지"를 스레드에 안내한다. */
  private injectMissReason: 'opts' | 'busy' | null = null
  /** 현재 실행이 result 프레임을 지났는지 — 정리 유예(post-result) 중인 CLI에는 interrupt를
   *  보내지 않는다(응답할 턴이 없어 유예가 끝날 때까지 cancel이 막힌다). 실행이 없으면 true.
   *  bg 통지의 atTurnEnd('중지됨' vs '턴 종료로 정리됨') 판정도 이 값을 쓴다. */
  private turnEnded = true
  /** 이 턴에 사용자 중단(Esc/중지)이 요청됐는지 — 통지 삼킴 리플레이가 사용자가 방금 끊은
   *  턴의 프롬프트를 되살리지 않게 막는다. 새 턴(스폰·주입)마다 리셋. */
  private interruptRequested = false
  /** resolves when the active run's stream loop has fully torn down */
  private runLoop: Promise<void> | null = null
  /** pending canUseTool resolvers keyed by requestId */
  private permissionWaiters = new Map<string, (r: PermChoice) => void>()
  /** pending AskUserQuestion resolvers keyed by requestId (answers, or null if dismissed) */
  private questionWaiters = new Map<string, (answers: string[][] | null) => void>()
  /** tool_use id → metadata so we can interpret tool_results (incl. a deferred file change).
   *  startedAt은 tool-end의 durationMs(실행 시간 — bash 행 요약에 표시)를 계산한다. */
  // abs: Write/Edit 대상의 절대 경로 — 성공 시 LSP에 파일 변화를 통지하는 데 쓴다(rel은 cwd 밖이면 모호)
  private tools = new Map<string, { name: string; cwd: string; startedAt: number; abs?: string; pending?: { whole: boolean; file: ChangedFile; diff: FileDiff; op: { isNew: boolean; add: number; del: number } } }>()
  /** tool_use ids of subagent-spawn tools (Task/Agent), to flip them to done on result */
  private subagents = new Set<string>()
  /** 서브에이전트별 사이드체인 모델 표시명 — 프레임마다 오므로 변화 시 1회만 emit */
  private subagentModels = new Map<string, string>()
  /** 사용자가 중지 버튼으로 끊은 백그라운드 작업 id — 정착 통지에 byUser 표식을 붙인다 */
  private userBgStops = new Set<string>()
  /** 살아있는 작업의 tool_use id → task id (task_started로 등록, 정착 통지로 해제).
   *  서브에이전트 tool_result가 "백그라운드 시작 접수증"인지 판정한다: 결과가 왔는데
   *  작업이 아직 살아 있으면 접수증(문구 스니핑보다 견고 — 접수증 문구는 종류마다 다르다). */
  private liveTaskByToolUse = new Map<string, string>()
  /** absolute path → its content the first time it was modified this run (null = the
   *  file didn't exist yet). Every change renders as a full-file diff against this
   *  baseline, so repeated edits to one file accumulate into one whole-file diff. */
  private baselines = new Map<string, string | null>()
  private permReqCounter = 0
  /** 할 일 panel: tasks accumulated from TaskCreate/TaskUpdate, keyed by the tool's task id */
  private taskMap = new Map<string, Todo>()
  /** monotonic task id counter, kept in lock-step with the SDK's own per-session numbering */
  private taskSeq = 0
  /** session the taskMap belongs to — a new session resets the accumulated tasks */
  private taskSessionId: string | null = null

  constructor(emit: Emit, source: ApiUsageSource = 'chat') {
    this.emit = emit
    this.source = source
  }

  get isRunning(): boolean {
    return this.activeRunId !== null
  }

  /** 유휴 회수(스윕) 판단용 — 턴이 돌고 있거나, 백그라운드(셸·워크플로·에이전트)를
   *  지키려 열어 둔 상주 입력 스트림이 살아 있으면 true. 이때 엔진을 거두면 그 작업들이
   *  고아 통지로 남아 다음 턴부터 CLI가 죽는 꼬임 루프의 진입점이 된다. */
  get hasLiveStream(): boolean {
    return this.activeRunId !== null || this.closeInput !== null
  }

  /** Resolve a permission prompt that the renderer answered. */
  respondPermission(res: PermissionResponse): void {
    const waiter = this.permissionWaiters.get(res.requestId)
    if (!waiter) return
    this.permissionWaiters.delete(res.requestId)
    waiter({ behavior: res.behavior, message: res.message })
  }

  /** Resolve an AskUserQuestion card that the renderer answered. */
  respondQuestion(res: QuestionResponse): void {
    const waiter = this.questionWaiters.get(res.requestId)
    if (!waiter) return
    this.questionWaiters.delete(res.requestId)
    waiter(res.answers)
  }

  /** 백그라운드 작업 컨트롤 — stop: 그 작업 중지(task_notification 'stopped'가 뒤따라
   *  목록을 정리한다), background: 지금 도는 포그라운드 도구 전부를 백그라운드로(터미널
   *  Ctrl+B 패리티 — 막혀 있던 tool_result가 즉시 반환되고 턴이 계속된다). 실행이 이미
   *  끝나 핸들이 없거나 요청이 늦었으면 조용히 무시한다. */
  async bgTask(req: BgTaskRequest): Promise<void> {
    try {
      if (req.action === 'stop' && req.id) {
        this.userBgStops.add(req.id) // 정착 통지에 '직접 중지' 표식을 붙이기 위해 기억
        await this.handle?.stopTask?.(req.id)
      } else if (req.action === 'background') {
        await this.handle?.backgroundTasks?.()
      }
    } catch {
      /* 실행 종료와 경합 — 무시 */
    }
  }

  async cancel(): Promise<void> {
    dlog(`cancel: hard (turnEnded=${this.turnEnded})`)
    this.interruptRequested = true // 사용자/시스템이 끊은 턴 — 삼킴 리플레이 대상에서 제외
    // interrupt는 진행 중인 턴에만 보낸다 — result 후 정리 유예(~5s) 중인 CLI는 응답할
    // 턴이 없어 여기서 유예가 끝날 때까지 조용히 막혔다(답변 직후 보낸 다음 메시지가
    // 몇 초간 "씹힌" 것처럼 보이는 주범). 턴이 끝났으면 바로 abort로 가고, 진행 중이어도
    // 응답이 늦으면 1.5s 뒤 abort가 강제 마무리한다(행 방지).
    try {
      if (!this.turnEnded && this.handle?.interrupt) {
        await Promise.race([
          this.handle.interrupt().catch(() => {}),
          new Promise((r) => setTimeout(r, 1500))
        ])
      }
    } catch {
      /* ignore */
    }
    this.closeInput?.() // 워크플로 상주로 열려 있던 입력 스트림도 함께 닫는다
    this.abort?.abort()
    // reject any outstanding permission prompts
    for (const [, waiter] of this.permissionWaiters) waiter({ behavior: 'deny', message: 'cancelled' })
    this.permissionWaiters.clear()
    // dismiss any open question cards (the run is ending)
    for (const [, waiter] of this.questionWaiters) waiter(null)
    this.questionWaiters.clear()
    // wait for the in-flight stream loop to fully tear down before a new run starts,
    // so two CLI subprocesses can't briefly coexist and emit overlapping events.
    // 상한 5초: 루프 탈출은 '다음 프레임 도착'에 기대므로(위 가드), CLI가 조용히 뻗어
    // 프레임이 영영 없으면 여기서 무한 대기하게 된다 — 그땐 포기하고 넘어간다(옛 루프는
    // 다음 프레임이 오는 순간 스스로 탈출하고, 가드가 새 실행과의 혼선을 막는다).
    if (this.runLoop) {
      try {
        await Promise.race([this.runLoop, new Promise((r) => setTimeout(r, 5000))])
      } catch {
        /* ignore */
      }
    }
  }

  /** 턴 종료(또는 실행 소멸)까지 대기 — true=턴 끝남/실행 없음, false=타임아웃.
   *  이벤트 배선 없이 200ms 폴링 — 대기 지점이 둘뿐이고 정밀도가 중요치 않다. */
  private waitTurnEnd(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const t0 = Date.now()
      const tick = (): void => {
        if (this.turnEnded || !this.isRunning) return resolve(true)
        if (Date.now() - t0 >= ms) return resolve(false)
        setTimeout(tick, 200)
      }
      tick()
    })
  }

  /** Esc/중지 = 지금 턴만 우아하게 중단 — cancel()과 달리 CLI 프로세스를 죽이지 않아
   *  백그라운드(셸·워크플로·에이전트)와 상주가 살아남는다. 프로세스째 죽이면 그 작업들이
   *  고아 통지로 남아 다음 턴부터 "새 CLI가 통지 소화 → 턴 종료 직후 사망"을 반복하는
   *  꼬임 루프의 진입점이 됐다(실측 2026-08-03). CLI가 interrupt에 응답하지 않으면(행)
   *  기존 cancel로 강등해 프로세스를 정리한다. 턴이 이미 끝난 상주는 건드릴 게 없다 —
   *  상주 워크플로 중지는 렌더러가 bgTask(stop)로 따로 보낸다. */
  async interruptTurn(): Promise<void> {
    if (!this.isRunning || this.turnEnded) return
    if (!this.handle?.interrupt) return this.cancel()
    dlog('interruptTurn: graceful interrupt')
    this.interruptRequested = true // 사용자가 끊은 턴 — 삼킴 리플레이가 되살리지 않게
    // 턴이 끝나며 카드도 의미를 잃는다 — 대기 중인 승인/질문을 풀어 프로미스가 매달리지 않게
    for (const [, waiter] of this.permissionWaiters) waiter({ behavior: 'deny', message: 'cancelled' })
    this.permissionWaiters.clear()
    for (const [, waiter] of this.questionWaiters) waiter(null)
    this.questionWaiters.clear()
    try {
      await Promise.race([this.handle.interrupt().catch(() => {}), new Promise((r) => setTimeout(r, 4000))])
    } catch {
      /* ignore */
    }
    // 접수만으로는 부족 — 중단된 턴의 result 프레임까지 봐야 끝난 것. 안 오면 행으로 보고 강제 정리.
    const ended = await this.waitTurnEnd(6000)
    if (!ended) {
      dlog('interruptTurn: no result after interrupt — hard cancel')
      await this.cancel()
    } else dlog('interruptTurn: turn ended, CLI kept alive')
  }

  /** 앱 종료 시 정리 — cancel()과 달리 아무것도 기다리지 않는다(quit 핸들러는 동기).
   *  abort가 SDK로 전달돼 CLI 자식 프로세스가 정리를 시작하고(못 미치면 job object가
   *  앱 종료와 함께 거둔다), 떠 있던 권한/질문 대기자는 즉시 풀어 프로미스가 매달린
   *  채 남지 않게 한다. */
  dispose(): void {
    this.closeInput?.()
    this.abort?.abort()
    for (const [, waiter] of this.permissionWaiters) waiter({ behavior: 'deny', message: 'cancelled' })
    this.permissionWaiters.clear()
    for (const [, waiter] of this.questionWaiters) waiter(null)
    this.questionWaiters.clear()
  }

  /** Start a run. Returns the runId; events stream via `emit`. */
  async run(req: RunRequest): Promise<string> {
    // 백그라운드 작업(셸·에이전트·워크플로)이 살아 있는 열린 스트림이 있으면 거기에 주입 —
    // 새 스폰은 이전 프로세스를 죽여 그 작업들이 전부 사망한다(유지의 핵심 경로)
    const injected = this.tryInject?.(req)
    if (injected) {
      dlog(`run: injected into resident stream (runId=${injected})`)
      return injected
    }
    // 주입 불가 사유(지킬 백그라운드가 있었던 경우에만 기록됨) — analyzing 뒤 안내에 쓴다
    let injectMiss = this.injectMissReason
    this.injectMissReason = null
    // 'busy' = 지킬 백그라운드가 살아 있는데 턴(대개 정착 통지를 소화하는 기상 미니턴)이
    // 진행 중이라 주입이 밀린 경우. 여기서 바로 cancel로 자르면 CLI째 죽어 그 작업들이
    // 고아 통지로 남고, 다음 턴이 그 통지를 소화하다 또 죽는 꼬임 루프의 연료가 된다
    // (실측 2026-08-03: 릴리즈 빌드 3연속 사망). 미니턴은 짧다 — 종결을 기다렸다 재주입.
    if (injectMiss === 'busy') {
      dlog('run: inject miss (busy) — waiting for turn end to re-inject')
      if (await this.waitTurnEnd(15_000)) {
        const late = this.tryInject?.(req)
        if (late) {
          dlog('run: late inject succeeded')
          return late
        }
        injectMiss = this.injectMissReason ?? injectMiss
        this.injectMissReason = null
      }
      dlog('run: late inject unavailable — falling back to respawn')
    }
    if (this.isRunning) await this.cancel()

    let runId = nextRunId()
    this.activeRunId = runId
    dlog(`run: fresh spawn (runId=${runId}${injectMiss ? `, injectMiss=${injectMiss}` : ''})`)
    this.turnEnded = false // 새 턴 — cancel이 다시 우아한 interrupt 경로를 쓴다
    this.interruptRequested = false
    this.tools.clear()
    this.subagents.clear()
    this.subagentModels.clear()
    this.userBgStops.clear()
    this.liveTaskByToolUse.clear()
    this.baselines.clear()

    // 폴더가 지정되지 않은 실행(채팅·멀티/단일 폴더 미선택)은 홈이 아니라 바탕화면에서
    // 동작한다 — 사용자가 결과물을 바로 확인하기 쉬운 위치. app.getPath는 OneDrive로
    // 리디렉션된 바탕화면도 정확히 잡는다(실패 시에만 홈으로).
    const cwd = req.cwd && req.cwd.trim() ? req.cwd : defaultCwd()
    const abort = new AbortController()
    this.abort = abort
    let resolveLoop: () => void = () => {}
    this.runLoop = new Promise<void>((r) => (resolveLoop = r))

    // ── 스트리밍 입력 — 워크플로 상주의 발판 ──
    // 문자열 프롬프트는 result 후 SDK가 입력을 닫아 CLI가 죽는다(백그라운드 워크플로
    // 동반 사망 — 완료 통지를 받을 프로세스가 없어 "결과 나오면 정리" 약속이 못 지켜짐).
    // AsyncIterable로 주고, 워크플로가 살아 있는 동안 입력을 닫지 않으면 CLI가 완료 통지
    // 뒤 스스로 정리 턴(재기동)을 낸다. 실측: scripts/poc-workflow-keepalive.mjs.
    // 워크플로가 없는 보통 턴은 result 직후 closeInput이 불려 기존 수명과 동일하다.
    const inbox: unknown[] = [
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: req.prompt }] },
        parent_tool_use_id: null,
        session_id: ''
      }
    ]
    let wakeInput: (() => void) | null = null
    let inputClosed = false
    const closeInput = (): void => {
      if (inputClosed) return
      inputClosed = true
      wakeInput?.()
    }
    this.closeInput = closeInput
    abort.signal.addEventListener('abort', closeInput, { once: true })
    async function* promptStream(): AsyncGenerator<unknown> {
      while (true) {
        if (inbox.length) {
          yield inbox.shift()
          continue
        }
        if (inputClosed) return
        await new Promise<void>((r) => (wakeInput = r))
      }
    }
    const permissionMode = modeToPermission(req.mode)

    // busy 표시는 어떤 실패보다 먼저 — 설정 읽기(디스크·safeStorage)까지 전부 아래 try
    // 안으로 옮겨, 어디서 던져도 error+status 이벤트로 정리되고 렌더러가 analyzing에
    // 갇히지 않는다. (렌더러의 실행 경계 가드도 analyzing이 항상 첫 이벤트임을 전제한다)
    this.emit({ type: 'status', runId, status: 'analyzing' })

    // 주입 불가 폴백의 가시화 — 살아있는 백그라운드 작업이 있었는데 상주 스트림에 주입하지
    // 못하고 새 프로세스로 왔다(이전 프로세스와 그 작업들은 정리됨). 조용히 죽이면
    // 사용자에겐 "작업이 증발했다"로 보이므로 이유를 스레드에 남긴다.
    if (injectMiss) {
      this.emit({
        type: 'notice',
        runId,
        text:
          injectMiss === 'opts'
            ? t(
                '실행 설정(모델·모드·계정 등)이 바뀌어 이전 백그라운드 작업(워크플로·에이전트·셸)을 이어받지 못하고 정리했어요. 백그라운드 작업이 도는 동안 설정을 그대로 두면 이어집니다.',
                'Run settings changed (model, mode, account, …), so the previous background tasks (workflows, agents, shells) could not be carried over and were cleaned up. Keep the settings unchanged while background tasks are running to carry them over.'
              )
            : t(
                '이전 턴이 아직 진행 중이어서 백그라운드 작업을 이어받지 못하고 새 프로세스로 시작했어요 — 돌던 백그라운드 작업은 정리됐습니다.',
                'The previous turn was still in progress, so this message started a fresh process — running background tasks were cleaned up.'
              )
      })
    }

    const claudeBin = process.env.MAIN_VITE_CLAUDE_BIN || process.env.CLAUDE_BIN
    // the engine is whatever version is installed in ~/.agentcodegui — no
    // bundled fallback, so behaviour is unambiguous (install one in 설정 → 버전).
    const query = await loadActiveQuery().catch(() => null)

    // streaming state for the current assistant text block — declared before query()
    // because onUserDialog (the refusal-fallback hook below) closes over it
    let sawTool = false
    let thinkingOpen = false
    let curTextId: string | null = null
    let curThinking = ''
    // 마지막으로 보낸 생각 한 줄 — 앞 90자가 다 채워지면 이후 델타로는 안 변한다
    let thinkLine = ''
    let streamedThisMsg = false
    // banners already emitted from onUserDialog — the end-of-turn
    // model_refusal_fallback notice for the same fallback is then skipped
    let pendingFallbackNotices = 0
    // 지금 답변을 생성 중인 모델(표시명) — assistant 프레임의 model 필드로 추적해, 세션
    // 중 전환(한도 도달·모델 과부하 폴백 등 거부 이외의 원인 포함)을 감지해 배너를 띄운다.
    // 거부 폴백 경로는 배너를 직접 띄우면서 이 값을 갱신하므로 이중 배너가 뜨지 않는다.
    let curModelDisplay = ''
    // 백그라운드 작업 추적 — 살아있는 id 집합(REPLACE로 갱신). "턴이 이미 끝났는지"는
    // this.turnEnded가 담당(cancel의 interrupt 생략 판단과 공유): result 뒤에 오는 stopped
    // 통지는 사용자가 누른 중지가 아니라 CLI 정리(턴 종료와 함께 셸 사망)이므로,
    // atTurnEnd로 구분해 렌더러가 '중지됨'과 '턴 종료로 정리됨'을 가른다.
    const liveBgIds = new Set<string>()
    let bgSessionId = ''
    // ── 워크플로 상주 상태 (task_type 'local_workflow') ──
    // liveWorkflows: 도는 중인 워크플로(bg 목록 REPLACE로 동기화). wfIds: 이 실행에서 본
    // 모든 워크플로 id — 정착 통지가 bg 목록이 빈 뒤에 오므로 판별은 이 집합으로 한다.
    const liveWorkflows = new Set<string>()
    const wfIds = new Set<string>()
    // pendingSettles: 정착(목록 이탈·통지)했지만 CLI의 보고 턴(재기동/정리 턴)이 아직 안
    // 끝난 백그라운드 작업 id — 이 동안 입력을 닫으면 보고 턴이 잘린다. 구 wfWrapPending의
    // 일반화: 워크플로뿐 아니라 에이전트·셸 정착도 CLI가 통지를 user 프레임으로 주입하고
    // 스스로 깨어나 보고하므로 똑같이 기다린다(즉시 닫으면 보고가 잘리고, 못 전한 통지가
    // '밀린 통지'로 남아 다음 세션의 무음 미니턴 → '응답 없음' 오탐까지 만든다).
    // 직접 중지(byUser)만 보고 턴이 없으므로 즉시 삭제한다.
    const pendingSettles = new Set<string>()
    // 이번 턴에 모델로 실제 전달된 통지의 task id — 메인 체인 user 프레임의
    // <task-notification> 태그에서 뽑는다. 그 턴의 result가 곧 해당 정착의 보고 완료다.
    // (system task_notification 프레임이 재기동 턴의 첫 활동보다 늦게 오면 아래 순서 비교
    // 만으로는 wrap이 영영 안 풀린다 — 그 stuck이 10분 안전망의 상주 오인 사살로 이어졌던
    // 실측 사고의 방어벽.)
    const deliveredNotifs = new Set<string>()
    // 턴/통지 순서 추적 — 완료 통지가 '진행 중이던 턴' 도중에 끼면 그 턴의 result는
    // 정리 턴이 아니다(wrap을 풀면 정리 턴이 잘린다). 통지 이후 시작된 턴의 result만
    // wrap을 마감한다. 통지가 유휴 중에 오면 재기동 턴이 곧바로 그 "이후 턴"이다.
    let frameSeq = 0
    let turnStartSeq = 0
    let wfNotifySeq = -1
    // 지금 턴이 사용자 주입 턴인지 — 통지와 정리 턴 사이에 사용자가 끼어들 수 있다.
    // 주입 턴의 result는 wrap을 마감하지 않는다(정리 턴은 CLI 재기동 턴 몫).
    let turnFromInject = false
    // id별 마지막 스냅샷 — 동시 워크플로가 서로의 알약을 덮어쓰지 않게 워크플로마다 든다
    const wfSnaps = new Map<string, WorkflowState>()
    // 정착 스냅샷의 지연 방출분(id별) — 유휴 상주(턴 종료 후) 정착 전용. 렌더러의 전송
    // 게이트(wfAlive)가 wf.status==='running'에 매달리므로, 정리 턴이 끝나기 전에 settled를
    // 내보내면 그 틈에 새 전송이 끼어들어 정리 턴을 자른다. 정리 턴의 result(또는 무음
    // 정착·스트림 종료)에서 내보낸다. 진행 중인 턴의 정착은 busy가 전송을 막고 있어
    // 즉시 방출한다(통지 처리 분기) — 미루면 턴이 긴 동안 알약이 안 걷히고 쌓인다.
    const wfSettledEmits = new Map<string, WorkflowState>()
    const flushWfSettled = (): void => {
      for (const wf of wfSettledEmits.values()) this.emit({ type: 'workflow', runId, wf })
      wfSettledEmits.clear()
    }
    // 백그라운드 서브에이전트 생존 추적 — bg 목록의 셸도 워크플로도 아닌 항목(subagent류).
    // 셸(liveBgIds)·워크플로와 함께 "파이프를 열어둘 이유"가 된다.
    const liveBgAgents = new Set<string>()
    // 턴도 끝났고 살아있는 백그라운드 작업(워크플로·셸·에이전트)도 보고 턴 대기도 없으면
    // 입력을 닫는다 → 루프가 기존 수명(턴 종료 = CLI 정리 = finally)으로 흐른다.
    // 백그라운드가 없는 보통 실행은 result 직후 여기로 — 기존과 동일.
    const maybeCloseInput = (): void => {
      if (!liveWorkflows.size && !liveBgIds.size && !liveBgAgents.size && !pendingSettles.size && this.turnEnded) {
        dlog('closeInput: all clear at turn end')
        closeInput()
      } else armHoldIdle() // 계속 상주 — 사유에 맞는 안전망을 다시 장전
    }
    // 보고 턴 마감 판정 — result에서 부른다. 통지 이후 시작된 턴(재기동/정리 턴)이면 대기
    // 전부를, 아니면 이 턴에 실제로 주입된 통지(deliveredNotifs)의 것만 걷는다. 후자가
    // system 통지 프레임의 도착 순서와 무관하게 동작하는 안전벨트다(주입 턴 포함).
    const finishWrap = (): void => {
      if (turnStartSeq > wfNotifySeq && !turnFromInject) pendingSettles.clear()
      else for (const id of deliveredNotifs) pendingSettles.delete(id)
      deliveredNotifs.clear()
    }
    // 상주 안전망 — 목적은 "지킬 것이 없는데 영영 안 닫히는" 릭 방지지, 조용한 상주의
    // 사살이 아니다. 그래서 ① 셸·워크플로가 살아 있으면 타이머 자체를 걸지 않고(dev 서버·
    // 긴 워크플로 단계는 몇십 분 조용한 게 정상), ② 발화 시점에 반드시 현재 상태를 재검증
    // 한다 — 장전 때의 10/30분 묵은 판단으로 닫지 않는다(실측 사고: stuck wrap + 원샷
    // 타이머가 R5 워크플로가 도는 상주 CLI를 오인 사살). 대상 두 경우:
    // (1) 보고 턴 대기(pendingSettles)만 남은 상주 — 곧 와야 정상이라 10분 무소식 =
    //     CLI 급사/행 → 닫고 정리로 흐른다.
    // (2) 에이전트만 남은 상주 — 30분 무프레임이면 좀비 의심이지만, 에이전트는 자기 전사
    //     파일(subagents/**)을 계속 쓰므로 파일이 최근에 쓰였으면 살려 두고 재장전한다.
    let holdIdleTimer: NodeJS.Timeout | null = null
    // 백그라운드 에이전트 생존 물증 — 프레임이 안 흘러도(긴 도구 실행·깊은 추론) 전사
    // 파일이 최근에 쓰였으면 일하는 중이다. <config>/projects/<cwd 슬러그>/<세션>/subagents
    // 아래를 얕게 훑는다(경로 규칙은 CLI 실측 — 계정 격리 시 accountDir, API 모드는 ~/.claude).
    const agentsRecentlyActive = (withinMs: number): boolean => {
      if (!bgSessionId) return false
      const base = accountDir ?? path.join(os.homedir(), '.claude')
      const now = Date.now()
      const stack = [path.join(base, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), bgSessionId, 'subagents')]
      let scanned = 0
      while (stack.length && scanned < 400) {
        const dir = stack.pop()!
        let entries: fs.Dirent[]
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
          continue // 아직 안 생겼거나 지워짐 — 물증 없음
        }
        for (const ent of entries) {
          if (++scanned > 400) break
          const p = path.join(dir, ent.name)
          if (ent.isDirectory()) stack.push(p)
          else {
            try {
              if (now - fs.statSync(p).mtimeMs <= withinMs) return true
            } catch {
              /* 삭제 경합 — 다음 항목 */
            }
          }
        }
      }
      return false
    }
    const fireHoldIdle = (): void => {
      holdIdleTimer = null
      if (inputClosed || abort.signal.aborted) return
      // 발화 시점 재검증 — 장전 후 상태가 바뀌었으면(턴 재개·새 셸/워크플로 등장) 닫지 않는다
      if (!this.turnEnded || liveBgIds.size || liveWorkflows.size) return
      if (liveBgAgents.size && agentsRecentlyActive(10 * 60_000)) {
        armHoldIdle() // 조용하지만 일하는 중 — 재장전
        return
      }
      dlog('closeInput: hold-idle safety fired')
      closeInput()
    }
    const armHoldIdle = (): void => {
      if (holdIdleTimer) clearTimeout(holdIdleTimer)
      holdIdleTimer = null
      if (!this.turnEnded || liveBgIds.size || liveWorkflows.size) return
      if (liveBgAgents.size) holdIdleTimer = setTimeout(fireHoldIdle, 30 * 60_000)
      else if (pendingSettles.size) holdIdleTimer = setTimeout(fireHoldIdle, 10 * 60_000)
    }
    // 종결 status(done/error)를 이미 보냈는지 — 못 보낸 채 스트림이 닫히면(CLI 급사,
    // result 프레임 없는 종료) 렌더러의 busy가 영영 안 풀리므로 finally의 안전망이 챙긴다
    let sentTerminalStatus = false
    // 이 실행의 실제 인증 경로 — init의 apiKeySource('oauth'=구독 / 그 외='user'·'project'
    // ·환경변수 등=API 키). 과금 집계는 토글(useApi)이 아니라 이 실제 경로로 판정해야,
    // 전역 ANTHROPIC_API_KEY로 API 과금된 실행도 원장에 잡히고(그리고 API 모드를 켰지만
    // 구독으로 붙은 실행은 잡지 않는다). null=아직 못 받음 → useApi로 폴백.
    let runApiKeySource: string | null = null

    // API 모드 — 저장된 키를 하위 CLI의 환경변수로 주입해 이 실행을 구독(OAuth)이
    // 아닌 API 키 과금으로 돌린다. 키 원문은 여기(메인)에서만 읽고 렌더러엔 안 간다.
    const useApi = !!req.useApi
    // 채팅별 계정(구독) 오버라이드 — 이 채팅이 전역 활성 계정과 다른 등록 계정을 골랐으면
    // 그 계정의 격리 config 폴더를 물질화해 CLAUDE_CONFIG_DIR로 주입한다(auth.ts).
    // 이 실행이 소비할 계정 — 채팅이 바인딩한 계정(req.account), 미지정이면 기본 계정.
    // 구독 실행은 항상 그 계정의 격리 config 폴더(CLAUDE_CONFIG_DIR)로 돈다(전역 ~/.claude
    // 불가침). API 모드면 과금 주체가 API 키라 계정은 무의미 → 건너뛴다.
    // finally에서 되싱크에 쓰므로 밖에 선언.
    let accountEmail: string | null = null
    let accountDir: string | null = null

    try {
      // skills turned off in 설정 → Skill: hide them from the model for this run via
      // the flag-settings layer (null when nothing is disabled). This never touches
      // the user's ~/.claude config — it's applied per-run alongside permissionMode.
      const skillOverrides = disabledSkillOverrides()
      // MCP servers turned off in 설정 → MCP: a per-run denylist spanning every scope
      // (null when none disabled). Like skillOverrides, never edits ~/.claude.json.
      const mcpDenied = deniedMcpServers()
      const apiKey = useApi ? getApiKey() : null

      if (!query) {
        throw new Error(
          t(
            '설치된 Claude Code 엔진이 없습니다. 설정 → 버전에서 엔진을 먼저 설치해 주세요.',
            'No Claude Code engine is installed. Install one in Settings → Versions first.'
          )
        )
      }
      if (useApi && !apiKey) {
        throw new Error(
          t(
            'API 모드가 켜져 있지만 저장된 API 키가 없습니다. 설정 → API에서 키를 먼저 등록해 주세요.',
            'API mode is on, but no API key is saved. Add a key in Settings → API first.'
          )
        )
      }
      if (!useApi) {
        accountEmail = req.account ?? defaultAccountEmail()
        if (!accountEmail) {
          throw new Error(
            t('등록된 클로드 계정이 없어요 — 설정 → Account에서 로그인해 주세요.', 'No Claude account is registered — sign in from Settings → Account.')
          )
        }
        accountDir = accountRunDir(accountEmail) // 등록 없음/손상 → throw로 에러 표시
      }

      // 전역 환경변수 ANTHROPIC_API_KEY 확인 — 헤드리스 CLI는 터미널 TUI와 달리 묻지
      // 않고 env 키를 구독 로그인보다 우선한다(실측: apiKeySource=ANTHROPIC_API_KEY,
      // OAuth 완전 무시). TUI의 "이 키를 쓸까요?" 확인을 질문 카드로 재현한다:
      // 승인=이 키로 API 과금 계속(기존 과금 공지·원장이 그대로 잡는다), 거절=자식
      // env에서 키를 걷어내 구독으로. 답은 키 지문별로 저장돼 같은 키면 다시 묻지
      // 않는다(키가 바뀌면 재확인). API 모드는 저장된 키를 명시 주입하므로 해당 없음.
      let dropEnvKey = false
      const envKey = !useApi ? process.env.ANTHROPIC_API_KEY || null : null
      if (envKey) {
        let choice = envKeyChoice(envKey)
        if (!choice) {
          const useLabel = t('API 키로 과금', 'Bill to API key')
          const requestId = `ask-${runId}-${++this.permReqCounter}`
          const answers = await new Promise<string[][] | null>((resolve) => {
            this.questionWaiters.set(requestId, resolve)
            const onAbort = (): void => {
              if (this.questionWaiters.delete(requestId)) resolve(null)
            }
            abort.signal.addEventListener('abort', onAbort, { once: true })
            this.emit({
              type: 'question-request',
              runId,
              requestId,
              questions: [
                {
                  question: t(
                    '시스템 환경변수에 ANTHROPIC_API_KEY가 설정돼 있어요. 이 키로 실행하면 구독이 아니라 API 크레딧으로 과금됩니다. 어떻게 할까요?',
                    'ANTHROPIC_API_KEY is set in your system environment. Running with this key bills API credits instead of your subscription. What would you like to do?'
                  ),
                  header: t('API 키 감지', 'API key detected'),
                  multiSelect: false,
                  options: [
                    {
                      label: useLabel,
                      description: t(
                        '환경변수의 API 키로 실행합니다 — API 크레딧이 차감돼요. 이 키에 대한 선택은 기억됩니다.',
                        'Runs with the API key from the environment — API credits will be charged. Your choice is remembered for this key.'
                      )
                    },
                    {
                      label: t('구독으로 실행', 'Use subscription'),
                      description: t(
                        '이 키를 무시하고 로그인한 구독 계정으로 실행합니다. 이 키에 대한 선택은 기억됩니다.',
                        'Ignores this key and runs with the signed-in subscription account. Your choice is remembered for this key.'
                      )
                    }
                  ]
                }
              ]
            })
          })
          if (abort.signal.aborted) throw new Error('cancelled') // catch가 abort로 침묵 처리
          // 답 없이 닫힘(null) → 저장하지 않고 이번 실행만 안전한 쪽(구독)으로
          choice = answers?.[0]?.[0] === useLabel ? 'api' : 'sub'
          if (answers) setEnvKeyChoice(envKey, choice)
        }
        dropEnvKey = choice === 'sub'
      }
      // 구독 실행 env — 위에서 "구독으로"를 골랐으면 env 키를 걷어내 하이재킹을 차단
      const subEnv: NodeJS.ProcessEnv | null = accountDir
        ? { ...process.env, CLAUDE_CONFIG_DIR: accountDir }
        : null
      if (subEnv && dropEnvKey) delete subEnv.ANTHROPIC_API_KEY

      // 출력 스타일 — 스폰 시점 값으로 굳힌다(주입 게이트가 변경을 감지해 새 스폰으로)
      const outputStyle = claudeOutputStyle()
      const q = query({
        prompt: promptStream(),
        options: {
          cwd,
          model: req.model,
          permissionMode,
          // Make the composer's mode authoritative over the user's global settings. A
          // ~/.claude/settings.json with `permissions.defaultMode: "auto"` (or any
          // escalating mode) would otherwise auto-approve tools BEFORE our canUseTool
          // gate runs, so picking 일반 in the app still wouldn't prompt. An inline
          // `settings` is a flag layer that outranks user/project/local settings, so
          // pinning defaultMode to the chosen mode neutralizes that — without editing
          // the user's global file. (canUseTool remains the real allow/deny gate.)
          settings: {
            permissions: { defaultMode: permissionMode },
            // 설정 → Engine의 출력 스타일(Concise 등) — CLI가 시스템 프롬프트에 반영
            // (claude_code 프리셋 경로 실측: -p + --settings로 스타일 활성 확인)
            ...(outputStyle ? { outputStyle } : {}),
            ...(skillOverrides ? { skillOverrides } : {}),
            ...(mcpDenied ? { deniedMcpServers: mcpDenied } : {})
          },
          // 참조 폴더 — cwd 밖 폴더들을 추가 작업 루트로 (CLI --add-dir 패리티). 도구
          // 접근·@멘션·CLAUDE.md 인식이 그 폴더들까지 넓어진다.
          ...(req.addDirs?.length ? { additionalDirectories: req.addDirs } : {}),
          // reasoning effort (or thinking off) chosen in the composer's effort picker
          ...effortToOptions(req.effort, req.model),
          // continue this chat's conversation (loads prior history) instead of
          // starting fresh every message
          ...(req.resume ? { resume: req.resume } : {}),
          // /btw 질문 창의 첫 실행 — resume한 세션을 이어쓰지 않고 새 세션 id로 포크한다.
          // 원본 세션 파일은 그대로라 원본 대화는 여기서의 문답을 전혀 모른다.
          ...(req.resume && req.forkSession ? { forkSession: true } : {}),
          // 'bypassPermissions' is inert unless this companion flag is set — the SDK
          // only passes --allow-dangerously-skip-permissions when it's true.
          ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
          // API 모드: ANTHROPIC_API_KEY를 주입해 이 실행을 API 키 과금으로 돌린다.
          // 계정 오버라이드: CLAUDE_CONFIG_DIR로 그 계정의 격리 config 폴더를 가리킨다.
          // SDK의 env 옵션은 process.env를 대체(merge 아님)하므로 반드시 펼쳐서 준다.
          ...(useApi && apiKey
            ? { env: { ...process.env, ANTHROPIC_API_KEY: apiKey } }
            : subEnv
              ? { env: subEnv }
              : {}),
          // Behave like the Claude Code CLI (full coding-agent persona + tools)
          // and honour the user's installed settings / CLAUDE.md / MCP servers.
          // A per-chat/panel 프롬프트 rides along as an append — re-sent on every
          // run, so editing it takes effect from the next message.
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            ...(req.systemPrompt?.trim() ? { append: req.systemPrompt.trim() } : {})
          },
          settingSources: ['user', 'project', 'local'],
          // stream assistant text token-by-token instead of one final block
          includePartialMessages: true,
          // 서브에이전트의 내레이션/생각 프레임도 전달받는다(기본은 tool_use/tool_result만).
          // 사이드체인 분기가 이를 그 서브에이전트 카드의 activity 줄로 보낸다 — 카드에서
          // 도구만이 아니라 "지금 뭘 하는 중인지"가 실시간으로 보이게.
          forwardSubagentText: true,
          abortController: abort,
          // The SDK spawns its bundled native Claude CLI directly and, with no
          // CLAUDE_CONFIG_DIR / ANTHROPIC_API_KEY override, reads the existing
          // ~/.claude OAuth login — so a Max subscription works with no API key.
          ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}),
          canUseTool: this.makeCanUseTool(runId, req.mode, cwd),
          // ── Fable 5 정책 거부 → 폴백 모델 전환 확인 (CLI 패리티) ──
          // Fable 5 has safety measures that can end a turn with stop_reason
          // 'refusal'. The SDK's fallback flow is dialog-gated: a consumer that
          // doesn't declare 'refusal_fallback_prompt' just gets the refusal error
          // and the turn dies. Declare it and — like the CLI's own prompt — ask
          // the user before switching: accept retries the turn on the fallback
          // model (Opus) and the session stays there; decline answers 'cancelled'
          // and the CLI applies its no-dialog default (refusal error ends the turn).
          supportedDialogKinds: ['refusal_fallback_prompt'],
          onUserDialog: async (
            dlg: { dialogKind: string; payload?: Record<string, unknown> },
            dlgOpts?: { signal?: AbortSignal }
          ) => {
            // unrecognized dialog kinds must be answered 'cancelled' (SDK contract:
            // the CLI then applies that dialog's default behavior)
            if (dlg.dialogKind !== 'refusal_fallback_prompt') return { behavior: 'cancelled' as const }
            const p = dlg.payload ?? {}
            const from = modelDisplay(p.originalModel)
            const to = modelDisplay(p.fallbackModel)
            if (thinkingOpen) {
              this.emit({ type: 'thinking-clear', runId })
              thinkingOpen = false
            }
            // AskUserQuestion 카드 재사용 — 모든 표면(코드 메인·채팅·세션 창·멀티 패널)이
            // 이미 렌더한다. requestId가 ask- 접두라 finally의 waiter 정리도 그대로 적용.
            const contLabel = t(`${to}로 전환해 계속`, `Switch to ${to} and continue`)
            const reason = fallbackReason(p.originalModel, p.apiRefusalCategory)
            const requestId = `ask-${runId}-${++this.permReqCounter}`
            const answers = await new Promise<string[][] | null>((resolve) => {
              this.questionWaiters.set(requestId, resolve)
              const onAbort = (): void => {
                if (this.questionWaiters.delete(requestId)) resolve(null)
              }
              dlgOpts?.signal?.addEventListener('abort', onAbort, { once: true })
              this.emit({
                type: 'question-request',
                runId,
                requestId,
                questions: [
                  {
                    question: t(`${reason} ${to} 모델로 전환해 계속할까요?`, `${reason} Switch to ${to} and continue?`),
                    header: t('모델 전환', 'Model switch'),
                    multiSelect: false,
                    options: [
                      {
                        label: contLabel,
                        description: t(
                          `이 요청을 ${to}로 다시 시도하고, 이후 대화도 ${to}로 진행합니다.`,
                          `Retries this request on ${to}; the rest of the conversation continues on ${to}.`
                        )
                      },
                      {
                        label: t('중단', 'Stop'),
                        description: t(
                          '전환하지 않고 여기서 끝냅니다. 프롬프트를 고쳐 다시 보낼 수 있어요.',
                          'Ends here without switching. You can revise your prompt and try again.'
                        )
                      }
                    ]
                  }
                ]
              })
            })
            if (answers?.[0]?.[0] !== contLabel) {
              // 중단 선택(또는 실행 취소로 카드가 닫힘 = null) → 거부 에러로 턴 종료.
              // 취소로 닫혔을 땐 실행 자체가 끝나는 중이라 안내 줄을 더하지 않는다.
              if (answers) {
                this.emit({
                  type: 'notice',
                  runId,
                  text: t(
                    `모델을 전환하지 않아 이 요청은 ${from}의 거부로 종료됐어요. 프롬프트를 수정해 다시 시도할 수 있어요.`,
                    `The model was not switched, so this request ended with ${from}'s refusal. You can revise your prompt and try again.`
                  )
                })
              }
              return { behavior: 'cancelled' as const }
            }
            pendingFallbackNotices++
            this.emit({
              type: 'model-fallback',
              runId,
              fromModel: typeof p.originalModel === 'string' ? p.originalModel : '',
              toModel: typeof p.fallbackModel === 'string' ? p.fallbackModel : '',
              text: t(
                `${reason} ${to} 모델로 전환해 계속해요. 이후 대화도 ${to} 모델로 진행됩니다.`,
                `${reason} Switching to ${to} to continue. The rest of the conversation will use ${to}.`
              ),
              // the refused leg's streamed partial — the retried answer must start
              // a fresh bubble, not append to it
              retractMessageId: curTextId
            })
            curModelDisplay = modelKey(p.fallbackModel) || curModelDisplay
            curTextId = null
            curThinking = ''
            thinkLine = ''
            streamedThisMsg = false
            return { behavior: 'completed' as const, result: 'retry_fallback' }
          },
          stderr: (data: string) => {
            if (data?.trim()) this.emit({ type: 'terminal', runId, line: { type: 'muted', text: data.trim() } })
          }
        }
      })
      this.handle = q as unknown as NonNullable<typeof this.handle>

      // size of the live context window. Each assistant turn's usage reflects the
      // whole conversation at that point, so the latest one is the current context.
      // The final `result.usage` is the run's *cumulative* total (summed across every
      // turn — input + cache reads add up over many tool rounds), which would wildly
      // overstate the window, so we never use it for the gauge.
      let lastContextTokens: number | null = null

      // 압축 경계(compact_boundary) 보류분 — 압축 후 컨텍스트는 다음 assistant 프레임의
      // usage가 처음 반영하므로, 경계에서 바로 내보내지 않고 그 프레임과 짝지어 전/후를
      // 한 번에 알린다(카드와 게이지 하락이 같은 순간에 뜬다). 뒤 프레임 없이 턴이 끝나면
      // settleResult가 afterTokens: null로 흘린다.
      let pendingCompact: { trigger: 'auto' | 'manual'; preTokens: number | null } | null = null

      // 이 실행에 눈에 보이는 턴 활동(답변 텍스트·도구·tool_result)이 있었는지 — 생각만
      // 한 프레임은 스레드에 아무것도 안 남기므로 세지 않는다(무음 턴 notice 기준과 일치)
      let sawTurnActivity = false
      // 활동 없이 도착한 성공 result 보류분 — 실측(밀린 백그라운드 통지): 새 CLI가 이전
      // 턴 작업의 통지를 먼저 무음 미니턴으로 소화하며 빈 result를 내고 진짜 턴이 뒤에
      // 이어진다. 이를 즉시 종결로 내보내면 busy가 풀리고 렌더러가 "이번 턴이 응답 없이
      // 끝났어요"를 오발한다 — 스트림이 실질 메시지로 이어지면 버리고, 그대로 닫히면
      // 루프 뒤에서 진짜 무음 턴으로 정착한다.
      let heldResult: SdkMsg | null = null
      // 무음 정착 대기 — 고정 원샷이 아니라 슬라이딩: 보류 후에도 프레임이 흐르고 있으면
      // 판정을 미룬다(진짜 턴의 첫 토큰은 2.5초를 훌쩍 넘기기 일쑤 — 아침 실측 13초.
      // 고정 2.5초가 '응답 없음' 오탐의 주범이었다). 재장전 상한(총 ~22초)을 둬, 진행
      // 프레임이 끊임없이 흐르는 상주에서도 진짜 무음 턴은 언젠가 정착한다.
      // 통지를 소화한 턴(deliveredNotifs)은 무프레임 침묵도 포기 사유가 아니다 — 그 빈
      // result는 밀린 통지 미니턴의 것이고, 큐에 밀린 진짜 턴(사용자 프롬프트 재생)이
      // 뒤에 온다. 침묵 2.5초 만에 정착하면 maybeCloseInput이 입력을 닫아 그 진짜 턴이
      // CLI와 함께 죽는다(실측: 중단 → 재전송 턴이 통째로 씹히고 '응답 없음'만 남음).
      // 상한까지 기다리면 프롬프트 재생 프레임(아래 user 텍스트 판별)이 보류를 푼다.
      let heldRearms = 0
      const armHeldSettle = (): void => {
        const seqAtArm = frameSeq
        setTimeout(() => {
          if (!heldResult || this.activeRunId !== runId || abort.signal.aborted) return
          if ((frameSeq !== seqAtArm || deliveredNotifs.size) && heldRearms < 8) {
            heldRearms++
            armHeldSettle()
            return
          }
          heldRearms = 0
          // 무음 정착 직전 삼킴 판정 — 통지를 소화한 턴이면 정착 대신 프롬프트를 되살린다
          if (tryNotifReplay()) return
          flushWfSettled()
          const held = heldResult
          heldResult = null
          settleResult(held)
          finishWrap()
          maybeCloseInput()
        }, 2500)
      }
      const settleResult = (msg: SdkMsg): void => {
        // Only SDKResultSuccess carries `result`; error subtypes put text in `errors`.
        const resultText = msg.is_error
          ? Array.isArray(msg.errors) && msg.errors.length
            ? msg.errors.join('; ')
            : msg.result ?? t('실행이 실패했습니다.', 'The run failed.')
          : msg.result ?? ''
        // use the last per-turn context, NOT contextFromUsage(msg.usage): the
        // result's usage is cumulative across the whole run and would overstate
        // the live window (often well past 100%).
        // API 키로 실제 과금된 실행의 비용을 전역 누적(설정 → API의 사용액)에 더하고,
        // 실행 1건을 사용 원장에 남긴다(모델별·일별 통계). 판정은 토글이 아니라 실제
        // 인증 경로(runApiKeySource)로 한다 — 그래야 전역 ANTHROPIC_API_KEY로 API 과금된
        // 실행도 잡히고, 구독(oauth)으로 붙은 실행의 명목 비용은 (API 모드를 켰더라도)
        // 실제 청구가 아니므로 더하지 않는다. init 전에 죽어 경로를 못 받았으면 useApi로 폴백.
        // 모든 엔진 인스턴스(메인/채팅/멀티)가 이 경로를 지나므로 한 곳에서 끝난다.
        const billedToApi = runApiKeySource ? isApiKeyBilled(runApiKeySource) : useApi
        if (billedToApi && typeof msg.total_cost_usd === 'number') {
          addSpend(msg.total_cost_usd)
          recordApiUsage({
            ts: Date.now(),
            // 표시 모델명(전환 감지가 추적한 값) — init 전에 죽은 실행은 picker 별칭으로
            model: curModelDisplay || req.model,
            source: this.source,
            costUsd: msg.total_cost_usd,
            inTok: msg.usage?.input_tokens ?? 0,
            outTok: msg.usage?.output_tokens ?? 0,
            cacheRead: msg.usage?.cache_read_input_tokens ?? 0,
            cacheWrite: msg.usage?.cache_creation_input_tokens ?? 0,
            durationMs: msg.duration_ms ?? null,
            numTurns: msg.num_turns ?? null
          })
        }
        // 짝지을 assistant 프레임 없이 턴이 끝난 압축 경계(수동 /compact 턴, 경계 직후
        // 중단 등) — 전 값만이라도 흘려 보류가 다음 턴으로 새지 않게 한다.
        if (pendingCompact) {
          this.emit({ type: 'compact', runId, trigger: pendingCompact.trigger, preTokens: pendingCompact.preTokens, afterTokens: null })
          pendingCompact = null
        }
        this.emit({
          type: 'result',
          runId,
          isError: !!msg.is_error,
          text: resultText,
          costUsd: msg.total_cost_usd ?? null,
          durationMs: msg.duration_ms ?? null,
          numTurns: msg.num_turns ?? null,
          contextTokens: lastContextTokens,
          contextWindow: windowFromModelUsage(msg.modelUsage),
          // 대화별 비용 누적(렌더러)도 같은 실제-과금 판정을 쓴다 (전역 원장과 일관)
          viaApi: billedToApi,
          // 이 실행이 소모한 모델별 실측 토큰 — 렌더러가 대화 누적(tokenTotals)에 더한다
          tokenUsage: tokenUseFromResult(msg, curModelDisplay || req.model)
        })
        this.emit({ type: 'status', runId, status: msg.is_error ? 'error' : 'done' })
        sentTerminalStatus = true
      }

      // ── 통지 삼킴 리플레이 ──
      // 고아/밀린 <task-notification>을 소화하는 기상 턴이 사용자 프롬프트와 한 턴으로
      // 묶이면 모델이 통지 규약대로 'No response requested.'만 내고 프롬프트를 삼킨다
      // (실측 2026-08-13 전사: 워크플로를 쥔 CLI가 죽은 뒤 — Esc 중지(TaskStop)는 전사에
      // 완료 기록을 안 남긴다 — 재기동 첫 턴에서 CLI가 고아 통지를 합성·주입해 재현.
      // 렌더러엔 '응답 없이 끝났어요'만 남고 메시지가 증발, 수동 재전송은 정상 동작했다).
      // 시그니처: 통지가 이 턴에 실제 주입됐고(deliveredNotifs) 눈에 보이는 활동이 전혀
      // 없이 성공 종결 — 정착시키지 않고 같은 스트림에 프롬프트를 한 번 다시 밀어넣는다
      // (수동 재전송의 자동화). 활동이 있었으면 부분 실행 위험이 있어 건드리지 않고,
      // 사용자가 직접 끊은 턴(interruptRequested)도 되살리지 않는다. 실행당 1회.
      let lastPrompt = req.prompt
      let promptReplayed = false
      const tryNotifReplay = (): boolean => {
        if (promptReplayed || inputClosed || abort.signal.aborted || this.interruptRequested) return false
        if (sawTurnActivity || !deliveredNotifs.size) return false
        promptReplayed = true
        dlog('notif swallow: replaying prompt into resident stream')
        finishWrap() // 통지 보고는 이 턴으로 끝났다 — 보고 턴 대기만 걷는다
        heldResult = null
        heldRearms = 0
        this.turnEnded = false // 턴이 이어진다 — Esc가 다시 우아한 interrupt 경로
        turnStartSeq = frameSeq
        turnFromInject = true // 사용자 프롬프트 턴 — 이 턴의 result가 wrap을 마감하지 않게
        inbox.push({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: lastPrompt }] },
          parent_tool_use_id: null,
          session_id: ''
        })
        wakeInput?.()
        return true
      }

      // ── 상주 유지 주입의 문 — run()이 새 스폰 대신 이 스트림에 다음 턴을 밀어넣는다 ──
      // 조건: 이전 턴이 끝났고(result 지남), 지킬 백그라운드 작업(워크플로·셸·에이전트,
      // 보고 턴 대기 포함)이 살아 있고, 스폰 시점에만 정할 수 있는 옵션이 전부 같을 때만.
      // 하나라도 다르면 null → 기존 경로(취소 후 새 스폰 — 그 작업들은 사망). 그 경우
      // 사유(injectMissReason)를 남겨 run()이 "왜 정리됐는지"를 스레드에 안내한다 —
      // 조용히 죽이면 사용자에겐 "작업이 증발했다"로 보인다.
      // runId는 let이라 갈아끼우면 이후 모든 emit이 자동으로 새 턴 소속이 된다.
      const injectFn = (nreq: RunRequest): string | null => {
        if (inputClosed || abort.signal.aborted) return null
        if (!liveWorkflows.size && !liveBgIds.size && !liveBgAgents.size && !pendingSettles.size) return null
        if (!this.turnEnded) {
          this.injectMissReason = 'busy'
          return null
        }
        const ncwd = nreq.cwd && nreq.cwd.trim() ? nreq.cwd : defaultCwd()
        const optsMatch =
          ncwd === cwd &&
          nreq.resume === bgSessionId &&
          nreq.model === req.model &&
          nreq.mode === req.mode &&
          nreq.effort === req.effort &&
          !!nreq.useApi === useApi &&
          (nreq.account ?? null) === (req.account ?? null) &&
          (nreq.systemPrompt?.trim() ?? '') === (req.systemPrompt?.trim() ?? '') &&
          JSON.stringify(nreq.addDirs ?? []) === JSON.stringify(req.addDirs ?? []) &&
          // 출력 스타일도 스폰에만 정해지는 옵션 — 설정을 바꿨으면 새 스폰으로 반영
          claudeOutputStyle() === outputStyle
        if (!optsMatch) {
          this.injectMissReason = 'opts'
          return null
        }
        runId = nextRunId()
        this.activeRunId = runId
        this.turnEnded = false
        this.interruptRequested = false
        sentTerminalStatus = false
        sawTurnActivity = false
        heldResult = null
        heldRearms = 0
        lastPrompt = nreq.prompt // 삼킴 리플레이가 이 턴의 프롬프트를 되살리게
        promptReplayed = false // 주입 = 새 턴 — 리플레이 기회도 새로
        turnStartSeq = frameSeq // 주입 턴 시작점 — wrap 마감 판정의 기준
        turnFromInject = true
        sawTool = false
        curTextId = null
        curThinking = ''
        thinkLine = ''
        streamedThisMsg = false
        this.emit({ type: 'status', runId, status: 'analyzing' })
        inbox.push({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: nreq.prompt }] },
          parent_tool_use_id: null,
          session_id: ''
        })
        wakeInput?.()
        return runId
      }
      this.tryInject = injectFn

      for await (const raw of q as AsyncIterable<SdkMsg>) {
        // abort 후에도 SDK 이터레이터는 반려되지 않을 수 있다(실측, win32): abort의 reject는
        // '그 순간 대기 중이던 읽기'에만 적용되고, 스트리밍 중(프레임 소비 중)이면 다음
        // 읽기가 그냥 이어진다 + Windows SDK는 자식을 즉시 죽이지도 않는다(stdin 닫고
        // 5초 뒤 SIGKILL). 그래서 취소를 SDK에 맡기지 않고 여기서 다음 프레임에 탈출한다.
        if (this.activeRunId !== runId || abort.signal.aborted) break
        const msg = raw
        frameSeq++
        armHoldIdle() // 상주 안전망 재장전 — 프레임이 흐르는 동안은 살아있는 것

        // 눈에 보이는 턴 활동 판별 — 보류 중인 result가 있으면 턴이 계속되고 있다는
        // 증거이므로 버린다(미니턴의 조기 종결이었음). 주입된 통지는 user 텍스트 프레임,
        // 생각은 thinking 블록/델타라 여기 안 걸린다 — 그 뒤의 무음 result를 보류할 수 있다.
        const msgBlocks = Array.isArray(msg.message?.content) ? msg.message.content : []
        // 사이드체인(parent_tool_use_id) 프레임은 턴 활동이 아니다 — 백그라운드 서브에이전트가
        // 턴 종료 후에도 내레이션/도구 프레임을 계속 흘리는데(상주 유지로 이제 실제로 온다),
        // 이를 활동으로 세면 busy가 되살아나고(재점등 오발) turnEnded=false가 주입도 막는다.
        if (
          !msg.parent_tool_use_id &&
          ((msg.type === 'assistant' && msgBlocks.some((b) => b?.type === 'text' || b?.type === 'tool_use')) ||
            (msg.type === 'stream_event' && msg.event?.delta?.type === 'text_delta') ||
            (msg.type === 'user' && msgBlocks.some((b) => b?.type === 'tool_result')))
        ) {
          sawTurnActivity = true
          if (heldResult) {
            heldResult = null
            heldRearms = 0
            this.turnEnded = false // 미니턴 종결로 오판했던 상태 복구 — cancel이 다시 interrupt 경로
          }
          // 워크플로 정리 턴 재개 — done을 이미 보낸 뒤 새 활동이 오면(완료 통지에 따른
          // 재기동) busy를 다시 켠다. 같은 runId의 done→working→done 왕복은 렌더러
          // 리듀서가 그대로 견디고, 왕복의 두 번째 done이 완료 토스트를 겸한다.
          if (sentTerminalStatus) {
            sentTerminalStatus = false
            this.turnEnded = false
            turnStartSeq = frameSeq // 재기동 턴 시작점 — 통지 이후면 이 턴의 result가 wrap 마감
            turnFromInject = false
            this.emit({ type: 'status', runId, status: 'working' })
          }
        }

        if (msg.type === 'system' && msg.subtype === 'init') {
          // A different session means a fresh task list — drop tasks carried over
          // from another chat. Resuming the same session keeps them (and their ids
          // stay aligned with the SDK's own counter for later TaskUpdate calls).
          if (msg.session_id && msg.session_id !== this.taskSessionId) {
            this.taskSessionId = msg.session_id
            this.taskSeq = 0
            this.taskMap.clear()
          }
          this.emit({
            type: 'session',
            runId,
            sessionId: msg.session_id ?? '',
            model: msg.model ?? req.model,
            cwd: msg.cwd ?? cwd,
            tools: msg.tools ?? []
          })
          // 전환 감지의 기준점 — init이 준 풀 모델 id만 신뢰(짧은 별칭이면 첫 assistant
          // 프레임이 기준점을 잡는다)
          curModelDisplay = modelKey(msg.model) || curModelDisplay
          bgSessionId = msg.session_id ?? '' // 백그라운드 출력 파일 경로 유도에 사용
          // API 모드 검증 — init의 apiKeySource가 실제 과금 경로를 알려준다. 토글과
          // 어긋나면(켰는데 oauth로 붙음 / 껐는데 API 키로 붙음 — 예: 전역 환경변수)
          // 조용히 지나가지 않고 배너로 알린다. 같은 배너가 매 메시지 반복되진 않게
          // 내용이 바뀔 때만 다시 띄운다.
          if (typeof msg.apiKeySource === 'string' && msg.apiKeySource) {
            runApiKeySource = msg.apiKeySource // 과금 집계 판정용 (아래 result에서 사용)
            const apiBilled = isApiKeyBilled(msg.apiKeySource) // 'oauth'·'none'=구독 → false
            let authNotice = ''
            // once: 이 대화에서 한 번만, 방금 보낸 사용자 메시지 바로 위에 끼워 넣는 키.
            // '실수로 과금 API로 해놨네'를 알아채라고 띄우는 거라 반복하지 않고 딱 한 번만.
            let once: string | undefined
            if (apiBilled) {
              // 이 실행은 실제로 API 크레딧으로 과금된다 (직접 켠 경우·전역 ANTHROPIC_API_KEY 둘 다)
              // 백틱으로 감싼 부분은 렌더러가 색을 넣는다 (하단 '과금' 토글과 바꿀 값 '구독')
              authNotice = useApi
                ? t(
                    '이 대화는 API 크레딧으로 과금돼요 (구독이 아닙니다). 실수로 API를 골랐다면 하단 `과금`을 `구독`으로 바꾸세요.',
                    'This chat is billed to API credits (not your subscription). If you picked API by mistake, switch the bottom `billing` toggle to `subscription`.'
                  )
                : t(
                    '이 대화는 API 키로 과금돼요 (환경변수 ANTHROPIC_API_KEY 사용). 구독 크레딧은 쓰이지 않습니다.',
                    'This chat is billed to an API key (via the ANTHROPIC_API_KEY environment variable). Subscription credits are not used.'
                  )
              once = 'api-billing'
            } else if (useApi) {
              // API 모드를 켰는데 구독으로 붙음 = 의도(API 과금)가 실패한 불일치 → 한 번만 알림
              authNotice = t(
                'API 모드가 켜져 있지만 이 실행은 구독 인증으로 연결됐어요. 과금이 API 키로 되지 않았을 수 있습니다.',
                'API mode is on, but this run connected with subscription auth. Billing may not have gone to the API key.'
              )
              once = 'api-mismatch'
            }
            if (authNotice) this.emit({ type: 'notice', runId, text: authNotice, ...(once ? { once } : {}) })
          }
          continue
        }

        // Fable 5 정책 거부 → 폴백 전환 알림. The dialog path (onUserDialog above)
        // already emitted the banner — this end-of-turn notice for the same fallback
        // is skipped. When the CLI auto-switched without asking (no dialog), this is
        // the only signal, so emit the banner from here. Never retract here: at end
        // of turn the live stream id may already belong to the retried (good) answer.
        if (msg.type === 'system' && msg.subtype === 'model_refusal_fallback') {
          curModelDisplay = modelKey(msg.fallback_model) || curModelDisplay
          if (pendingFallbackNotices > 0) {
            pendingFallbackNotices--
          } else {
            this.emit({
              type: 'model-fallback',
              runId,
              fromModel: msg.original_model ?? '',
              toModel: msg.fallback_model ?? '',
              text: fallbackNotice(msg.original_model, msg.fallback_model, msg.api_refusal_category),
              retractMessageId: null
            })
          }
          continue
        }

        // CLI 루프 배너 — REPL 알림(notification: 한도 경고·모델 전환 사유 등)과 눈에 띄는
        // 정보 줄(informational: warning/suggestion). CLI가 사용자에게 보여주는 것이니 우리도
        // 스레드에 notice 줄로 표시한다. 'info'(transcript 전용)·'notice'(도구 진행줄이 섞여
        // 소란) 레벨과 tool_use_id 달린 진행줄은 건너뛴다.
        if (msg.type === 'system' && msg.subtype === 'notification') {
          const text = msg.text?.trim()
          if (text) this.emit({ type: 'notice', runId, text })
          continue
        }
        if (msg.type === 'system' && msg.subtype === 'informational') {
          const text = msg.content?.trim()
          const prominent = msg.level === 'warning' || msg.level === 'suggestion'
          if (text && prominent && !(msg as { tool_use_id?: string }).tool_use_id) {
            this.emit({ type: 'notice', runId, text })
          }
          continue
        }

        // 대화 압축 경계 — 컨텍스트가 가득 차 CLI가 스스로 요약했거나(/compact면 manual)
        // 그 지점 표식. 여기서는 보류만 하고, 압축 후 컨텍스트를 아는 다음 assistant
        // 프레임에서 전/후 짝으로 내보낸다.
        if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
          const meta = msg.compact_metadata
          pendingCompact = {
            trigger: meta?.trigger === 'manual' ? 'manual' : 'auto',
            preTokens: typeof meta?.pre_tokens === 'number' ? meta.pre_tokens : null
          }
          continue
        }

        // 백그라운드 작업(셸 등) 추적 — 살아있는 목록 전체가 멤버십 변화(시작·완료·중지·
        // Ctrl+B 백그라운드화)마다 REPLACE로 온다. 레벨 신호라 북엔드를 짝맞출 필요 없음.
        // outputFile은 CLI의 실측 규칙(%TEMP%\claude\<경로의 영숫자 외→'-'>\<session>\tasks\
        // <task_id>.output)으로 유도한 라이브 출력 후보 — 종료 통지의 실제 경로가 오면 덮인다.
        if (msg.type === 'system' && msg.subtype === 'background_tasks_changed') {
          const outFile = (id: string): string | undefined =>
            bgSessionId ? path.join(os.tmpdir(), 'claude', cwd.replace(/[^a-zA-Z0-9]/g, '-'), bgSessionId, 'tasks', `${id}.output`) : undefined
          const all = (Array.isArray(msg.tasks) ? msg.tasks : []).filter((t) => t && typeof t.task_id === 'string')
          // 정착 임박 감지 — 추적 중이던 작업이 목록에서 빠졌다. 정착 통지는 목록이 빈 뒤에
          // 오므로(실측), 여기서 곧장 닫으면 통지·보고 턴이 경합으로 잘린다. 보고 턴 대기로
          // 넘겨 파이프를 지킨다(직접 중지는 통지의 byUser 분기가, 진짜 무통지는 10분
          // 안전망이 정리한다).
          const nextIds = new Set(all.map((t) => t.task_id!))
          for (const id of [...liveWorkflows, ...liveBgAgents, ...liveBgIds]) {
            if (!nextIds.has(id)) {
              pendingSettles.add(id)
              wfNotifySeq = frameSeq
            }
          }
          // 워크플로·서브에이전트 생존 동기화 — REPLACE 의미 그대로, 목록에 있는 동안 살아있음
          liveWorkflows.clear()
          liveBgAgents.clear()
          for (const t of all) {
            const kind = t.task_type ?? ''
            if (/workflow/i.test(kind)) {
              liveWorkflows.add(t.task_id!)
              wfIds.add(t.task_id!)
            } else if (!/bash|shell/i.test(kind)) {
              liveBgAgents.add(t.task_id!)
            }
          }
          const tasks = all
            // 셸 계열만 — 백그라운드 서브에이전트도 이 목록에 실려 오지만(task_type
            // 'subagent'류) 그건 서브에이전트 칩이 이미 추적하고, 워크플로는 위의 전용
            // 추적(+workflow 이벤트)이 맡는다. 칩 이름값('셸')대로 거른다.
            .filter((t) => /bash|shell/i.test(t.task_type ?? ''))
            .map((t) => ({ id: t.task_id!, kind: t.task_type ?? '', description: t.description ?? '', outputFile: outFile(t.task_id!) }))
          liveBgIds.clear()
          for (const t of tasks) liveBgIds.add(t.id)
          dlog(
            `bg REPLACE: shells=[${[...liveBgIds].join(',')}] wf=[${[...liveWorkflows].join(',')}] agents=[${[...liveBgAgents].join(',')}] settles=[${[...pendingSettles].join(',')}]`
          )
          this.emit({ type: 'bg-tasks', runId, tasks })
          maybeCloseInput() // 마지막 백그라운드 작업이 걷힌 REPLACE면 유지 상주를 끝낸다
          continue
        }
        // 워크플로 진행 스냅샷 — workflow_progress가 실린 task_progress만 보드 이벤트로.
        // (그 외 task_progress는 작업 하트비트라 표시할 게 없다.) 배열엔 phase와 agent가
        // 섞여 오고 매번 전체 스냅샷이라 REPLACE로 흘리면 끝. 실측: PoC frames.jsonl.
        if (msg.type === 'system' && msg.subtype === 'task_progress') {
          const wp = (msg as { workflow_progress?: unknown }).workflow_progress
          if (Array.isArray(wp) && wp.length && typeof msg.task_id === 'string') {
            const phases: WorkflowState['phases'] = []
            const agents: WorkflowAgent[] = []
            for (const e of wp as Array<Record<string, unknown>>) {
              if (e?.type === 'workflow_phase') {
                phases.push({ index: Number(e.index) || 0, title: String(e.title ?? '') })
              } else if (e?.type === 'workflow_agent') {
                const state = String(e.state ?? '')
                agents.push({
                  label: String(e.label ?? ''),
                  phase: Number(e.phaseIndex) || 0,
                  phaseTitle: String(e.phaseTitle ?? ''),
                  model: modelDisplay(e.model),
                  state,
                  ...(typeof e.tokens === 'number' ? { tokens: e.tokens } : {}),
                  ...(typeof e.toolCalls === 'number' ? { toolCalls: e.toolCalls } : {}),
                  ...(typeof e.durationMs === 'number' ? { durationMs: e.durationMs } : {}),
                  // 실행 중=프롬프트 미리보기, 완료=결과 미리보기 — 카드의 활동 한 줄
                  note: oneLine(String((state === 'done' ? e.resultPreview : e.promptPreview) ?? ''), 140) || undefined
                })
              }
            }
            const u = (msg as { usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number } }).usage
            const prevSummary: string = wfSnaps.get(msg.task_id)?.summary ?? ''
            const wf: WorkflowState = {
              id: msg.task_id,
              summary: msg.summary?.trim() || prevSummary,
              status: 'running',
              phases,
              agents,
              totalTokens: u?.total_tokens ?? 0,
              toolUses: u?.tool_uses ?? 0,
              durationMs: u?.duration_ms ?? 0
            }
            wfSnaps.set(msg.task_id, wf)
            wfIds.add(msg.task_id)
            this.emit({ type: 'workflow', runId, wf })
          }
          continue
        }
        // 작업 시작 북엔드 — tool_use ↔ task 매핑 등록 (포그라운드·백그라운드 공통)
        if (msg.type === 'system' && msg.subtype === 'task_started') {
          if (typeof msg.tool_use_id === 'string' && typeof msg.task_id === 'string') {
            this.liveTaskByToolUse.set(msg.tool_use_id, msg.task_id)
          }
          continue
        }
        // 작업 정착 통지 — 상태·요약·출력 파일 경로. 포그라운드 Bash·서브에이전트의 정착도
        // 같은 subtype으로 오므로, 렌더러는 자기가 추적하던 백그라운드 id만 반영한다.
        if (msg.type === 'system' && msg.subtype === 'task_notification') {
          const st = msg.status
          if (typeof msg.task_id === 'string' && (st === 'completed' || st === 'failed' || st === 'stopped')) {
            const byUser = this.userBgStops.has(msg.task_id)
            dlog(`task_notification: ${msg.task_id} ${st}${byUser ? ' (byUser)' : ''}`)
            // 정착 = 보고 턴 대기 — 워크플로·에이전트·셸 공통. CLI가 통지를 주입하고 스스로
            // 깨어나 보고 턴을 내므로 그때까지 입력을 연다(pendingSettles — 보고 턴의
            // result가 마감). 직접 중지만 즉시 정리한다(중지 = 여기서 끝내라, 보고 턴 없음).
            // 추적한 적 있는 작업만 대상 — 포그라운드 Bash·서브에이전트의 정착도 같은
            // subtype으로 오지만 그건 이 턴 안에서 이미 소화된다.
            if (byUser) {
              pendingSettles.delete(msg.task_id)
            } else if (
              wfIds.has(msg.task_id) ||
              liveWorkflows.has(msg.task_id) ||
              liveBgAgents.has(msg.task_id) ||
              liveBgIds.has(msg.task_id) ||
              pendingSettles.has(msg.task_id)
            ) {
              pendingSettles.add(msg.task_id)
              wfNotifySeq = frameSeq
            }
            // 워크플로 정착 — bg 목록에선 이미 빠진 뒤에 오므로 wfIds로 판별한다. 이
            // 프레임은 아래의 공용 bg-task-end로도 흐르지만 렌더러는 자기가 추적하던
            // 셸 id만 반영하므로 무해하다.
            if (wfIds.has(msg.task_id)) {
              liveWorkflows.delete(msg.task_id)
              const snap = wfSnaps.get(msg.task_id)
              if (snap && snap.status === 'running') {
                // summary는 진행 프레임의 원문을 지킨다 — 정착 통지의 문장은
                // 'Dynamic workflow "…" completed' 꼴이라 흔적 줄에서 '완료'와 중복된다
                const settled: WorkflowState = { ...snap, status: st, summary: snap.summary || msg.summary?.trim() || '' }
                wfSnaps.set(msg.task_id, settled)
                // 직접 중지는 보고 턴이 없고, 진행 중인 턴의 정착은 busy가 이미 전송을
                // 예약 큐로 막고 있어 미룰 이유가 없다(미루면 마라톤 턴에서 완료 알약이
                // 안 걷히고 계속 쌓인다) — 둘 다 즉시 방출. 유휴 상주의 정착만 미룬다.
                if (byUser || !this.turnEnded) this.emit({ type: 'workflow', runId, wf: settled })
                else wfSettledEmits.set(msg.task_id, settled)
              }
            }
            liveBgIds.delete(msg.task_id)
            liveBgAgents.delete(msg.task_id)
            this.emit({
              type: 'bg-task-end',
              runId,
              id: msg.task_id,
              status: st,
              summary: msg.summary?.trim() || undefined,
              outputFile: msg.output_file || undefined,
              atTurnEnd: this.turnEnded,
              // 사용자가 중지 버튼으로 끊은 작업이면 표식 (턴 종료 정리와 표기를 가른다)
              byUser: this.userBgStops.delete(msg.task_id) || undefined
            })
            // 정착했으니 "살아있는 작업" 매핑에서 해제
            const tuid = msg.tool_use_id
            if (typeof tuid === 'string') this.liveTaskByToolUse.delete(tuid)
            // 백그라운드 서브에이전트의 진짜 완료 — Task의 tool_result는 "백그라운드로
            // 시작됨" 접수증과 함께 즉시 돌아와 카드가 일찍 done이 되므로(그 경우
            // handleToolResult가 카드를 실행 중으로 유지한다), 완료는 이 통지가 맡는다.
            if (typeof tuid === 'string' && this.subagents.has(tuid)) {
              this.subagents.delete(tuid)
              const label =
                st === 'completed'
                  ? t('완료', 'Done')
                  : st === 'stopped'
                    ? this.turnEnded
                      ? t('턴 종료로 정리됨', 'Cleaned up at turn end')
                      : t('중지됨', 'Stopped')
                    : t('실패', 'Failed')
              const saMeta = this.tools.get(tuid)
              this.emit({
                type: 'subagent',
                runId,
                agent: {
                  id: tuid,
                  name: '',
                  role: '',
                  status: 'done',
                  activity: msg.summary?.trim() || label,
                  tools: [],
                  durationMs: saMeta ? Date.now() - saMeta.startedAt : undefined
                }
              })
            }
            maybeCloseInput() // 마지막 백그라운드 작업의 정착이면 유지 상주를 끝낸다
          }
          continue
        }

        // partial streaming: text/thinking arrive as deltas before the full message
        if (msg.type === 'stream_event') {
          // 사이드체인(서브에이전트) 스트리밍 델타는 메인 말풍선/생각줄에 섞지 않는다 —
          // 전체 프레임이 도착하면 위의 assistant 분기가 카드 activity로 보낸다.
          if (msg.parent_tool_use_id) continue
          const ev = msg.event
          if (ev?.type === 'content_block_delta') {
            const d = ev.delta
            if (d?.type === 'text_delta' && d.text) {
              if (thinkingOpen) {
                this.emit({ type: 'thinking-clear', runId })
                thinkingOpen = false
              }
              if (!curTextId) curTextId = `a${nextBlockId()}`
              streamedThisMsg = true
              this.emit({ type: 'assistant-stream', runId, messageId: curTextId, delta: d.text })
            } else if (d?.type === 'thinking_delta' && d.thinking) {
              thinkingOpen = true
              streamedThisMsg = true
              // 표시 줄은 누적 생각의 앞 90자 — 다 채워지면(89자+…) 이후 델타로 절대
              // 안 변하므로, 그 뒤로 델타마다 전체 누적 문자열을 재정규화하고 같은
              // 문구를 다시 보내(렌더러 리렌더) 낭비하던 것을 건너뛴다
              if (thinkLine.length < 90) {
                curThinking += d.thinking
                const line = oneLine(curThinking, 90)
                if (line !== thinkLine) {
                  thinkLine = line
                  this.emit({ type: 'thinking', runId, text: line })
                }
              }
            }
          } else if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
            // The model just started emitting a tool call. Its input — for a Write,
            // the entire file body — streams as input_json_delta and can take several
            // seconds, during which no answer text and no tool row appear yet, so the
            // UI looks frozen. Reuse the working indicator with a tool-specific label
            // ("파일 작성 중" etc.) to fill that gap. We deliberately leave thinkingOpen
            // untouched: no thinking-clear fires when the full message lands, so the
            // indicator stays put until the tool row takes over (avoids a 1-frame blink),
            // and the next text delta clears it on its own.
            if (!thinkingOpen) this.emit({ type: 'thinking', runId, text: toolGenLabel(ev.content_block.name ?? '') })
          }
          continue
        }

        if (msg.type === 'assistant') {
          // 서브에이전트(사이드체인) 프레임 — 메인 스레드와 완전히 분리해 처리한다.
          // 서브에이전트는 자기 정의대로 메인과 다른 모델로 돌 수 있어(예: Fable 5 메인
          // 아래 Explore=Opus 5) 메인 경로에 태우면 ① 모델 전환 안전망이 인터리브마다
          // "전환됨" 배너를 핑퐁으로 도배(+model-fallback을 받은 picker 동요), ② usage가
          // 서브에이전트 자신의 컨텍스트라 게이지 오염, ③ 내레이션 text가 메인 말풍선으로
          // 섞이고, ④ 메인 스트리밍 상태(curTextId)를 중간에 리셋해 말풍선이 쪼개진다.
          // → 내부 tool_use는 카드에 귀속(parentToolId), 내레이션/생각은 그 카드의
          // activity 줄로(reducer의 subagent 케이스가 부분 병합 — tools 보존).
          if (msg.parent_tool_use_id || msg.subagent_type) {
            const pid = msg.parent_tool_use_id
            // 사이드체인 프레임이 보고한 실행 모델 — 카드 서브 줄·푸터 '모델' 칩용.
            // 프레임마다 실려 오므로 값이 바뀔 때만 부분 업데이트로 흘린다.
            const smk = modelKey(msg.message?.model)
            if (pid && smk && this.subagents.has(pid) && this.subagentModels.get(pid) !== smk) {
              this.subagentModels.set(pid, smk)
              this.emit({
                type: 'subagent',
                runId,
                agent: { id: pid, name: '', role: '', status: 'running', activity: '', tools: [], model: smk }
              })
            }
            const blocks = Array.isArray(msg.message?.content) ? (msg.message!.content as ContentBlock[]) : []
            for (const block of blocks) {
              if (block.type === 'tool_use' && block.id && block.name) {
                this.handleToolUse(runId, block, cwd, pid ?? undefined)
              } else if (pid && this.subagents.has(pid)) {
                // 실행 중인(스폰을 목격한) 서브에이전트만 — 모르는 pid에 빈 카드를 만들지 않는다
                const line = block.type === 'text' ? (block.text ?? '') : block.type === 'thinking' ? (block.thinking ?? '') : ''
                if (line.trim()) {
                  this.emit({
                    type: 'subagent',
                    runId,
                    agent: { id: pid, name: '', role: '', status: 'running', activity: oneLine(line, 200), tools: [] }
                  })
                }
              }
            }
            continue
          }
          // 세션 중 모델 전환 감지(원인 불문 안전망) — 이 프레임을 만든 모델이 직전과 다르면
          // 배너 + picker 동기화(model-fallback 이벤트 재사용). 거부 폴백 경로는 위에서 이미
          // 배너를 띄우며 curModelDisplay를 갱신하므로 이중으로 뜨지 않고, [1m] 컨텍스트
          // 변형 전환은 표시명이 같아 걸리지 않는다.
          const mk = modelKey(msg.message?.model)
          if (mk) {
            if (!curModelDisplay) curModelDisplay = mk
            else if (mk !== curModelDisplay) {
              this.emit({
                type: 'model-fallback',
                runId,
                fromModel: curModelDisplay,
                toModel: msg.message?.model ?? mk,
                text: t(
                  `모델이 ${curModelDisplay}에서 ${mk}로 전환되었어요. 이후 답변은 ${mk}로 생성됩니다.`,
                  `The model switched from ${curModelDisplay} to ${mk}. Later replies will be generated by ${mk}.`
                ),
                retractMessageId: null
              })
              curModelDisplay = mk
            }
          }
          // live context estimate: each assistant turn's usage reflects the
          // conversation so far → update the gauge before the final result lands.
          const ctx = contextFromUsage(msg.message?.usage)
          if (ctx != null) {
            // 압축 직후 첫 실측 — 미뤄둔 압축 알림을 전/후 값과 함께, 게이지를 떨어뜨릴
            // context 이벤트보다 먼저 내보낸다(카드가 하락을 설명하는 순서).
            if (pendingCompact) {
              this.emit({ type: 'compact', runId, trigger: pendingCompact.trigger, preTokens: pendingCompact.preTokens, afterTokens: ctx })
              pendingCompact = null
            }
            lastContextTokens = ctx
            this.emit({ type: 'context', runId, contextTokens: ctx })
          }
          const blocks = Array.isArray(msg.message?.content) ? (msg.message!.content as ContentBlock[]) : []
          for (const block of blocks) {
            if (block.type === 'thinking' && block.thinking) {
              // only emit from the full message when nothing streamed (fallback)
              if (!streamedThisMsg) {
                thinkingOpen = true
                this.emit({ type: 'thinking', runId, text: oneLine(block.thinking, 90) })
              }
            } else if (block.type === 'text' && block.text && block.text.trim()) {
              if (thinkingOpen) {
                this.emit({ type: 'thinking-clear', runId })
                thinkingOpen = false
              }
              // finalize the streamed message with the authoritative text (or add
              // a fresh one if partials never arrived)
              const messageId = curTextId ?? `a${nextBlockId()}`
              this.emit({ type: 'assistant-done', runId, messageId, text: block.text })
              curTextId = null
            } else if (block.type === 'tool_use' && block.id && block.name) {
              if (!sawTool) {
                sawTool = true
                this.emit({ type: 'status', runId, status: 'working' })
              }
              if (thinkingOpen) {
                this.emit({ type: 'thinking-clear', runId })
                thinkingOpen = false
              }
              this.handleToolUse(runId, block, cwd, msg.parent_tool_use_id ?? undefined)
            }
          }
          // reset per-message streaming state for the next assistant turn
          curTextId = null
          curThinking = ''
          thinkLine = ''
          streamedThisMsg = false
          continue
        }

        if (msg.type === 'user') {
          const blocks = Array.isArray(msg.message?.content) ? (msg.message!.content as ContentBlock[]) : []
          // 메인 체인 user '텍스트' 프레임 — CLI가 주입한 정착 통지(<task-notification>)거나
          // 큐에 밀렸던 사용자 메시지의 재생이다. ① 통지면 어떤 정착이 모델에 전달됐는지
          // 기록(finishWrap의 보고 판정), ② 어느 쪽이든 "다음 턴이 이어진다"는 증거이므로
          // 보류 중인 무음 result는 버린다 — 그 빈 result는 이 메시지에 대한 답이 아니다
          // (밀린 통지 미니턴의 조기 종결을 무음 턴으로 오판해 '응답 없음'을 띄우던 구멍).
          if (!msg.parent_tool_use_id) {
            let sawText = false
            for (const block of blocks) {
              if (block.type === 'text' && typeof block.text === 'string') {
                sawText = true
                if (block.text.includes('<task-notification>')) {
                  for (const m of block.text.matchAll(/<task-id>([^<]+)<\/task-id>/g)) deliveredNotifs.add(m[1])
                }
              }
            }
            if (sawText && heldResult) {
              heldResult = null
              heldRearms = 0
              this.turnEnded = false // 턴이 이어진다 — cancel이 다시 우아한 interrupt 경로
            }
          }
          for (const block of blocks) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              this.handleToolResult(runId, block)
            }
          }
          continue
        }

        if (msg.type === 'result') {
          // 이후의 stopped 통지는 사용자 중지가 아니라 턴 종료에 따른 CLI 정리로 표시하고,
          // 이후의 cancel은 interrupt 없이 바로 abort한다(정리 유예 중 CLI는 응답이 없다)
          this.turnEnded = true
          if (!msg.is_error && !sawTurnActivity && !msg.result?.trim()) {
            // 눈에 보이는 활동도 result 텍스트도 없는 성공 result — 밀린 통지를 소화한
            // 무음 미니턴의 조기 종결일 수 있으니 보류한다(위 활동 판별이 버리거나, 루프
            // 뒤에서 정착). 실패 result나 텍스트 실린 result는 즉시 정착 — 오류는 바로
            // 보여야 하고, 답이 있는 턴의 result가 빈 활동으로 오는 일은 없다(실측).
            heldResult = msg
            // 스트리밍 입력에선 스트림이 스스로 닫히지 않는다 — 실질 메시지가 안 이어지면
            // 무음 턴으로 정착시키고 입력을 닫는다(문자열 모드의 '닫힘 정착' 등가).
            // 프레임이 흐르는 동안은 슬라이딩으로 판정을 미룬다(armHeldSettle).
            heldRearms = 0
            armHeldSettle()
            continue
          }
          // result에 텍스트는 실렸는데 활동이 전혀 없던 성공 종결 — 기상 턴이 프롬프트째
          // 삼킨 시그니처('No response requested.'가 result로만 온다). 정착 대신 리플레이.
          if (!msg.is_error && !sawTurnActivity && tryNotifReplay()) continue
          // 워크플로 마감 — 미뤄둔 settled 스냅샷을 result보다 먼저 내보낸다(알약 소등이
          // busy 해제보다 앞서야 렌더러 게이트·드레인이 어긋나지 않는다). 보고 턴 대기는
          // finishWrap이 푼다 — 통지 이후 시작된 턴이거나 이 턴에 통지가 실제 주입된
          // 경우만. 다 풀리면 입력을 닫아 기존 수명으로 흐른다.
          flushWfSettled()
          settleResult(msg)
          finishWrap()
          maybeCloseInput()
        }
      }
      // 보류된 무음 result — 실질 메시지 없이 스트림이 닫혔으면 진짜 무음 턴이다.
      // 여기서 정착해야 렌더러의 무음 턴 안내가 (진짜일 때만) 뜨고 busy가 풀린다.
      if (heldResult && this.activeRunId === runId && !abort.signal.aborted) settleResult(heldResult)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // An abort surfaces as an error — don't surface it as a failure to the user.
      if (!abort.signal.aborted) {
        this.emit({ type: 'error', runId, message })
        this.emit({ type: 'status', runId, status: 'error' })
        sentTerminalStatus = true
      }
    } finally {
      if (holdIdleTimer) clearTimeout(holdIdleTimer)
      if (this.closeInput === closeInput) this.closeInput = null
      this.tryInject = null // 이 스트림은 닫혔다 — 다음 run은 정상 스폰 경로로
      // clear any permission waiters belonging to this run so resolvers never outlive it
      for (const [key, waiter] of this.permissionWaiters) {
        if (key.startsWith(`perm-${runId}-`)) {
          this.permissionWaiters.delete(key)
          waiter({ behavior: 'deny', message: 'run ended' })
        }
      }
      for (const [key, waiter] of this.questionWaiters) {
        if (key.startsWith(`ask-${runId}-`)) {
          this.questionWaiters.delete(key)
          waiter(null)
        }
      }
      // CLI가 격리 폴더 안에서 리프레시한 토큰을 암호화 백업에 되쓴다
      // (다음 물질화·한도 조회가 신선한 토큰을 쓰도록)
      if (accountDir && accountEmail) {
        try {
          syncAccountTokens(accountEmail)
        } catch {
          /* ignore */
        }
      }
      if (this.activeRunId === runId) {
        // 미뤄둔 settled 스냅샷이 정리 턴을 못 만나고 스트림이 끝남(취소 등) → 지금 방출.
        // 아직 running이던 워크플로가 스트림 종료와 함께 죽음(취소·CLI 급사·상주 안전망) →
        // stopped로 마감. 어느 쪽이든 알약이 도는 채로 남지 않게 워크플로마다 챙긴다.
        dlog('stream end: run loop tearing down')
        flushWfSettled()
        for (const wf of wfSnaps.values()) {
          if (wf.status === 'running') this.emit({ type: 'workflow', runId, wf: { ...wf, status: 'stopped' } })
        }
        // 스트림이 닫히면 CLI 프로세스도 죽으므로 백그라운드 작업은 전부 사라진다 —
        // 통지가 못 온 잔여 항목은 "턴 종료로 정리됨"으로 명시하고 빈 REPLACE로 마감한다.
        // (activeRunId 가드: 새 실행이 이미 시작됐다면 그쪽 목록을 지우면 안 된다)
        for (const id of liveBgIds) {
          this.emit({ type: 'bg-task-end', runId, id, status: 'stopped', atTurnEnd: true })
        }
        this.emit({ type: 'bg-tasks', runId, tasks: [] })
        // 아직 done을 못 받은 서브에이전트(백그라운드로 돌다 통지 없이 스트림이 닫힘,
        // 또는 실행 취소)도 실행 중으로 남지 않게 정리한다
        for (const id of this.subagents) {
          const saMeta = this.tools.get(id)
          this.emit({
            type: 'subagent',
            runId,
            agent: {
              id,
              name: '',
              role: '',
              status: 'done',
              activity: t('턴 종료로 정리됨', 'Cleaned up at turn end'),
              tools: [],
              durationMs: saMeta ? Date.now() - saMeta.startedAt : undefined
            }
          })
        }
        this.subagents.clear()
        // 종결 status 보장 — result 프레임도 error도 없이 스트림이 닫히면(CLI 급사 등)
        // 아무도 done을 안 보내 busy가 영영 안 풀렸다. 취소(abort)로 끝난 경우도 이
        // 안전망이 스피너를 정리한다 — 새 실행의 begin이 이미 지나갔다면 렌더러의
        // 실행 경계 가드(curRunId)가 이 늦은 status를 걸러낸다.
        if (!sentTerminalStatus) {
          if (!abort.signal.aborted) {
            this.emit({ type: 'notice', runId, text: t('엔진이 응답 없이 종료됐어요 — 메시지를 다시 보내 주세요.', 'The engine exited without responding — please send your message again.') })
            this.emit({ type: 'status', runId, status: 'error' })
          } else {
            this.emit({ type: 'status', runId, status: 'done' })
          }
        }
        this.activeRunId = null
        this.handle = null
        this.abort = null
        this.runLoop = null
      }
      resolveLoop()
    }
    return runId
  }

  // ── tool_use → events ──────────────────────────────────────
  private handleToolUse(runId: string, block: ContentBlock, cwd: string, parentToolId?: string): void {
    const name = block.name!
    const id = block.id!
    const input = (block.input ?? {}) as Record<string, unknown>
    // AskUserQuestion is surfaced as an interactive choice card (handled in
    // canUseTool), not a tool-log row — so don't render or track it here.
    if (name === 'AskUserQuestion') return
    const startedAt = Date.now()
    this.tools.set(id, { name, cwd, startedAt })

    // Subagent spawn — newer engines name this tool 'Agent', older ones 'Task'.
    if (name === 'Task' || name === 'Agent') {
      const subType = String(input.subagent_type ?? input.description ?? 'agent')
      const desc = String(input.description ?? input.prompt ?? '')
      this.subagents.add(id)
      this.emit({
        type: 'subagent',
        runId,
        agent: {
          id,
          name: subType,
          role: oneLine(desc, 40) || t('서브에이전트', 'Subagent'),
          status: 'running',
          activity: oneLine(desc, 200) || t('작업 중', 'Working'),
          tools: []
        }
      })
      return
    }

    // TodoWrite drives the todo panel, not the tool log.
    if (name === 'TodoWrite') {
      const todos = Array.isArray(input.todos) ? (input.todos as Array<Record<string, unknown>>) : []
      this.emit({
        type: 'todos',
        runId,
        todos: todos.map((t, i) => ({
          id: String(i + 1),
          label: String(t.content ?? t.activeForm ?? ''),
          status: todoStatus(String(t.status ?? 'pending'))
        }))
      })
      return
    }

    // TaskCreate / TaskUpdate (newer incremental task tools) also feed the 할 일 panel.
    // We never see a task's id in the TaskCreate input — it's assigned on creation — so
    // we mint ids in creation order, which matches the SDK's own per-session numbering
    // that later TaskUpdate calls reference.
    if (name === 'TaskCreate' || name === 'TaskUpdate' || name === 'TaskList') {
      if (name === 'TaskCreate') {
        const subject = String(input.subject ?? input.description ?? '').trim()
        if (subject) {
          const tid = String(++this.taskSeq)
          this.taskMap.set(tid, { id: tid, label: subject, status: 'pending' })
        }
      } else if (name === 'TaskUpdate') {
        const tid = String(input.taskId ?? '')
        const status = String(input.status ?? '')
        const task = this.taskMap.get(tid)
        if (task) {
          if (status === 'deleted') this.taskMap.delete(tid)
          else {
            if (status) task.status = todoStatus(status)
            if (input.subject) task.label = String(input.subject)
          }
        }
      }
      // TaskList changes nothing; it just re-syncs the panel from what we've tracked.
      this.emit({ type: 'todos', runId, todos: [...this.taskMap.values()].map((t) => ({ ...t })) })
      return
    }

    const { verb, kind, target } = describeTool(name, input, cwd)
    this.emit({
      type: 'tool-start',
      runId,
      tool: { id, verb, kind, target, status: 'running', parentToolId }
    })

    // Bash command is shown immediately; file changes are deferred until the tool
    // succeeds (see handleToolResult) so a denied/failed edit never leaves a phantom diff.
    if (name === 'Bash') {
      const cmd = String(input.command ?? '')
      if (cmd) this.emit({ type: 'terminal', runId, line: { type: 'cmd', text: cmd } })
    } else if (name === 'Write' || name === 'Edit' || name === 'MultiEdit') {
      // Build a *whole-file* diff (baseline → result) so the modal shows the entire
      // file with the changed lines marked in place — far easier to read than an
      // isolated fragment. We read the file as it currently is on disk (this runs
      // before the SDK performs the change), then compute the resulting full content:
      //   Write     → the new content verbatim
      //   Edit      → apply old_string→new_string to the current content
      //   MultiEdit → apply each edit in sequence
      // The baseline (captured on first touch this run) is diffed against the result,
      // so several edits to one file accumulate into one cumulative whole-file diff.
      const fp = String(input.file_path ?? '')
      const rel = toRel(cwd, fp)
      const abs = path.isAbsolute(fp) ? fp : path.join(cwd, fp)
      // stat 먼저 — HUGE 판정이 어차피 미리보기를 접을 파일(≥16MB 바이트면 UTF-8 최악
      // 4바이트/자로도 4M자 초과 확정)은 통째 동기 읽기 자체를 생략한다. 지금까지는
      // 크기 판정보다 읽기가 먼저라, 수십 MB 파일 편집이 스트림 루프를 읽기 시간만큼
      // 통째로 막은 뒤에야 "너무 커서 생략"으로 빠졌다.
      const hugeOnDisk = statSize(abs) >= HUGE_BYTES_CERTAIN
      // 원문·편집 문자열 모두 LF로 정규화해 다룬다 — CLI의 Edit는 개행 차이를 흡수해
      // 적용하지만 우리 applyEdit(리터럴 indexOf)는 CRLF 원문에서 old_string(LF)을 못
      // 찾아 미리보기가 통째로 누락(+0−0)됐다. diff 라인 텍스트도 LF로 깨끗해져 뷰어의
      // LF 정규화 문서(CmEditor)와 줄 단위로 일치한다.
      const raw = hugeOnDisk ? null : readDisk(abs)
      const cur = raw == null ? null : normEol(raw)
      let next: string
      if (name === 'Write') {
        next = normEol(String(input.content ?? ''))
      } else if (name === 'Edit') {
        next = applyEdit(cur ?? '', normEol(String(input.old_string ?? '')), normEol(String(input.new_string ?? '')), !!input.replace_all)
      } else {
        const edits = Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : []
        next = edits.reduce((t, e) => applyEdit(t, normEol(String(e.old_string ?? '')), normEol(String(e.new_string ?? '')), !!e.replace_all), cur ?? '')
      }
      this.tools.set(id, { name, cwd, startedAt, abs, pending: this.fileChangePending(rel, abs, cur, next, hugeOnDisk) })
    }
  }

  // Build a deferred whole-file change. `cur` is the file's content right before this
  // tool runs; the first time a path is touched this run it becomes the baseline, so
  // later edits diff against the run's original state (cumulative). A path with no
  // baseline (didn't exist) renders as an all-added new file.
  // `op`는 별도 축 — 누적이 아니라 "이 도구 한 번"(cur→next)의 증감. 도구 행의 +N −N은
  // 이걸 쓴다: 같은 파일을 여러 번 고칠 때 행마다 그 편집의 크기가 나와야지, 런 누적이
  // 행에 실리면 편집할수록 숫자만 불어난다 (누적은 diff 모달·변경 파일 패널의 몫).
  private fileChangePending(
    rel: string,
    abs: string,
    cur: string | null,
    next: string,
    // 호출측 stat 가드가 읽기를 생략한 파일 — cur=null이지만 새 파일이 아니라 거대 파일
    hugeOnDisk = false
  ): { whole: boolean; file: ChangedFile; diff: FileDiff; op: { isNew: boolean; add: number; del: number } } {
    // A very large file makes the whole-file diff itself the hazard: the line array
    // balloons the IPC payload, the renderer's state, and the persisted snapshot —
    // and holding the baseline text pins megabytes for the rest of the run. Keep a
    // summary row instead of a preview. (`whole: true` so the renderer replaces any
    // previously accumulated diff for this path rather than appending.)
    const HUGE = 4_000_000 // chars ≈ 4MB
    if (hugeOnDisk || (cur?.length ?? 0) > HUGE || next.length > HUGE) {
      this.baselines.delete(abs)
      const tag = cur == null && !hugeOnDisk ? ('new' as const) : ('edit' as const)
      const lines = [
        { t: 'hunk' as const, text: t('@@ 파일이 너무 커서 변경 미리보기를 생략했어요 @@', '@@ File is too large — change preview skipped @@') }
      ]
      return {
        whole: true,
        file: { path: rel, add: 0, del: 0, tag },
        diff: { path: rel, tag, add: 0, del: 0, lines },
        op: { isNew: tag === 'new', add: 0, del: 0 }
      }
    }
    if (!this.baselines.has(abs)) this.baselines.set(abs, cur)
    const base = this.baselines.get(abs) ?? null
    // 이 도구 한 번의 증감(cur→next). 디스크가 아직 기준선 그대로면(첫 접촉 포함) 누적
    // diff와 같으니 재계산을 생략하고 그 수치를 물려받는다.
    const opCounts = (cumAdd: number, cumDel: number): { isNew: boolean; add: number; del: number } => {
      if (base === cur) return { isNew: false, add: cumAdd, del: cumDel }
      const d = computeLineDiff(cur ?? '', next)
      return { isNew: false, add: d.add, del: d.del }
    }
    if (base == null) {
      const { lines, add } = newFileDiff(next)
      // 런에서 태어난 파일의 후속 편집(cur≠null)은 누적으로는 여전히 '새 파일 한 장'이지만
      // 도구 행은 이 편집의 실제 증감으로 — 매번 '새 파일'로 뜨는 오표기를 막는다.
      const op = cur == null ? { isNew: true, add, del: 0 } : opCounts(add, 0)
      return { whole: true, file: { path: rel, add, del: 0, tag: 'new' }, diff: { path: rel, tag: 'new', add, del: 0, lines }, op }
    }
    const { lines, add, del } = computeLineDiff(base, next)
    return {
      whole: true,
      file: { path: rel, add, del, tag: 'edit' },
      diff: { path: rel, tag: 'edit', add, del, lines },
      op: opCounts(add, del)
    }
  }

  // ── tool_result → events ───────────────────────────────────
  private handleToolResult(runId: string, block: ContentBlock): void {
    const id = block.tool_use_id!
    const meta = this.tools.get(id)
    const isError = !!block.is_error
    const text = resultText(block.content)

    // Subagent finished
    if (this.subagents.has(id)) {
      // 백그라운드로 돌린 서브에이전트의 tool_result는 "백그라운드로 시작됨" 접수증이
      // 즉시 돌아온 것 — 완료가 아니다. 판정: 그 작업이 아직 살아 있으면(task_started
      // 등록 후 정착 통지 전) 접수증이다. 포그라운드는 정착 통지가 tool_result보다 먼저
      // 와서(실측) 여기 안 걸린다. 문구 검사는 task_started가 늦게 오는 레이스의 보조
      // (접수증 문구가 종류마다 달라 — bash "backgrounded", agent "Async agent launched").
      if (!isError && (this.liveTaskByToolUse.has(id) || /running in background|backgrounded|async agent launched/i.test(text))) {
        this.emit({
          type: 'subagent',
          runId,
          agent: {
            id,
            name: '',
            role: '',
            status: 'running',
            activity: t('백그라운드에서 진행 중', 'Running in the background'),
            tools: []
          }
        })
        return
      }
      this.subagents.delete(id)
      this.emit({
        type: 'subagent',
        runId,
        // 소요 = Task tool_use 시작→결과 도착 (meta.startedAt은 handleToolUse가 기록)
        agent: {
          id,
          name: '',
          role: '',
          status: 'done',
          activity: agentResult(text) || t('완료', 'Done'),
          tools: [],
          durationMs: meta ? Date.now() - meta.startedAt : undefined
        }
      })
      return
    }

    // Emit the deferred file change only now that the edit/write has actually succeeded.
    if (meta?.pending && !isError) {
      this.emit({ type: 'file-change', runId, file: meta.pending.file, diff: meta.pending.diff, whole: meta.pending.whole })
      // 살아있는 LSP 서버들에도 디스크 변화를 통지 — 클라이언트 워칭에 기대는 서버가
      // 에이전트가 만든/고친 파일을 곧바로 알게 한다 (자세한 역할 분담은 notifyWatchedFiles 주석)
      if (meta.abs) {
        // op.isNew — 누적 tag는 런에서 태어난 파일의 후속 편집도 'new'라 created를 반복 통지한다
        lspManager.notifyWatchedFiles([{ abs: meta.abs, kind: meta.pending.op.isNew ? 'created' : 'changed' }])
      }
    }

    if (meta?.name === 'Bash') {
      const lines = text.split('\n').slice(0, 200)
      for (const ln of lines) {
        if (ln.trim()) this.emit({ type: 'terminal', runId, line: { type: isError ? 'err' : 'out', text: ln } })
      }
      if (!isError) this.emit({ type: 'terminal', runId, line: { type: 'ok', text: t('✓ 완료', '✓ Done') } })
    }

    // Panel-feeding tools (TodoWrite / Task*) produce no tool log row.
    if (meta && !TASK_TOOLS.has(meta.name)) {
      // Web 행: 검색이 어떤 페이지들을 찾았는지 뽑아 행에 링크 목록으로 실어 보낸다
      // — 채팅에서 행을 클릭하면 목록이 펼쳐지고 각 링크는 브라우저로 열린다
      const links = meta.name === 'WebSearch' && !isError ? extractWebLinks(text) : undefined
      // edit/write surface their +/- line counts (or 새 파일); other tools use a summary
      // — 수치는 op(이 도구 한 번의 cur→next)다. 누적(file.add/del)을 실으면 같은 파일을
      // 거듭 고칠 때 행마다 런 전체 증감이 반복돼 "한 줄 고쳤는데 +300"으로 읽힌다.
      const result =
        meta.pending && !isError
          ? meta.pending.op.isNew
            ? t('새 파일', 'New file')
            : `+${meta.pending.op.add} -${meta.pending.op.del}`
          : links
            ? t(`${links.length}개 결과`, `${links.length} results`)
            : resultSummary(meta.name, text, isError)
      // Bash rows carry their output tail so the chat can show it as an inline log
      const output = meta.name === 'Bash' ? tailOutput(text) : undefined
      this.emit({
        type: 'tool-end',
        runId,
        id,
        status: isError ? 'error' : 'done',
        result,
        // 실행 시간 — bash 행의 우측 요약(시간 · 줄수)과 로그 모달에 표시
        durationMs: Date.now() - meta.startedAt,
        ...(output ? { output } : {}),
        ...(links ? { links } : {})
      })
    }
  }

  // ── permission gate ────────────────────────────────────────
  // The agent asked the user to choose (AskUserQuestion). Surface a card, wait for
  // the answer, and feed it back as the tool result. canUseTool can only allow/deny,
  // so we deny with a message that carries the user's choice — the model reads that
  // as the result and proceeds. Works in every mode (incl. auto): a question is an
  // explicit request for input, so we always pause for it.
  private async handleAskQuestion(
    runId: string,
    input: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<PermissionResult> {
    const questions = parseQuestions(input)
    if (!questions.length) return { behavior: 'allow', updatedInput: input }
    const requestId = `ask-${runId}-${++this.permReqCounter}`
    const answers = await new Promise<string[][] | null>((resolve) => {
      this.questionWaiters.set(requestId, resolve)
      const onAbort = (): void => {
        if (this.questionWaiters.delete(requestId)) resolve(null)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.emit({ type: 'question-request', runId, requestId, questions })
    })
    return { behavior: 'deny', message: formatAnswers(questions, answers) }
  }

  private makeCanUseTool(runId: string, mode: ModeId, _cwd: string) {
    return async (
      toolName: string,
      input: Record<string, unknown>,
      options?: { signal?: AbortSignal }
    ): Promise<PermissionResult> => {
      // AskUserQuestion → interactive card, regardless of mode
      if (toolName === 'AskUserQuestion') return this.handleAskQuestion(runId, input, options?.signal)
      // auto / bypass: allow everything
      if (mode === 'auto' || mode === 'bypass') return { behavior: 'allow', updatedInput: input }
      // read-only is always fine
      if (READONLY_TOOLS.has(toolName)) return { behavior: 'allow', updatedInput: input }
      // acceptEdits: file edits already auto-approved by the mode; this path is
      // reached for Bash and other side-effectful tools → prompt the user.
      // normal: prompt for every mutating tool.
      if (mode === 'acceptEdits' && toolName !== 'Bash' && !MUTATING_TOOLS.has(toolName)) {
        return { behavior: 'allow', updatedInput: input }
      }
      const requestId = `perm-${runId}-${++this.permReqCounter}`
      const summary = permissionSummary(toolName, input)
      const choice = await new Promise<PermChoice>((resolve) => {
        this.permissionWaiters.set(requestId, resolve)
        // If the SDK aborts the run independently of our cancel(), don't hang.
        const onAbort = (): void => {
          if (this.permissionWaiters.delete(requestId)) resolve({ behavior: 'deny', message: 'aborted' })
        }
        options?.signal?.addEventListener('abort', onAbort, { once: true })
        this.emit({ type: 'permission-request', runId, requestId, toolName, summary })
      })
      // 모델이 읽는 거부 사유 — 뒤이은 답변이 사용자에게 보이므로 UI 언어를 따른다
      if (choice.behavior === 'deny')
        return { behavior: 'deny', message: choice.message || t('사용자가 거부했습니다.', 'The user denied this.') }
      // 항상 허용 → add a session-scoped allow rule for this tool so the SDK stops asking
      // for it this session (no settings-file write — destination is in-memory 'session').
      if (choice.behavior === 'allow_always') {
        return {
          behavior: 'allow',
          updatedInput: input,
          updatedPermissions: [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' }]
        }
      }
      return { behavior: 'allow', updatedInput: input }
    }
  }
}

// ── helpers ──────────────────────────────────────────────────
// 'claude-opus-5' / 'claude-opus-4-8(-YYYYMMDD)' → 'Opus 5' / 'Opus 4.8' — 폴백 경고 배너에 쓰는 표시 이름
function modelDisplay(id: unknown): string {
  const s = typeof id === 'string' ? id : ''
  const m = /claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?\b/i.exec(s)
  if (!m) return s || t('다른 모델', 'another model')
  return m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() + ' ' + m[2] + (m[3] ? '.' + m[3] : '')
}

// modelDisplay의 엄격판 — 풀 모델 id로 파싱될 때만 표시명을, 아니면 ''. 전환 감지의 비교
// 키로 쓴다: 짧은 별칭('fable')이나 빈 값이 기준점을 오염시켜 가짜 전환 배너를 띄우지 않게.
// [1m] 컨텍스트 변형은 같은 표시명으로 정규화돼 전환으로 치지 않는다.
function modelKey(id: unknown): string {
  const s = typeof id === 'string' ? id : ''
  return /claude-(fable|opus|sonnet|haiku)-\d/i.test(s) ? modelDisplay(s) : ''
}

// init의 apiKeySource가 "실제 API 키 과금"을 뜻하는지. 구독 계열은 두 값이 온다:
// 'oauth'(구독 로그인)과 'none'(키 없음 → 로그인 계정으로 폴백). 둘 다 API 청구가 아니라
// 명목 비용만 있으므로 과금 집계·안내에서 제외한다. 그 외 값('user'/'project'/'org'/
// 'temporary'/환경변수 등)은 실제 API 키 과금. 빈 값이면 판정 불가(호출부에서 폴백).
function isApiKeyBilled(source: string | null | undefined): boolean {
  return !!source && source !== 'oauth' && source !== 'none'
}

// stop_details.category 코드 → 표시 라벨. Open string — 새 분류가 스키마보다
// 먼저 생길 수 있어서, 모르는 값은 코드 그대로 보여준다.
// (모듈 상수로 두면 언어가 첫 로드 시점에 박제되므로 호출마다 만든다)
function refusalCategoryLabel(code: string): string {
  const map: Record<string, string> = { cyber: t('사이버 보안', 'cybersecurity'), bio: t('생물학', 'biology') }
  return map[code] ?? code
}

// 거부 사유 한 줄 — 전환 확인 질문 카드와 전환 배너가 공유한다
function fallbackReason(from: unknown, category: unknown): string {
  const f = modelDisplay(from)
  const c =
    typeof category === 'string' && category
      ? t(` (감지 분류: ${refusalCategoryLabel(category)})`, ` (detected category: ${refusalCategoryLabel(category)})`)
      : ''
  return t(
    `${f}의 안전 정책이 이 요청에 대한 응답을 거부했어요${c}.`,
    `${f}'s safety policy declined to answer this request${c}.`
  )
}

// 다이얼로그 없이 CLI가 스스로 전환을 끝낸 경우(end-of-turn 통지만 온 경우)의 배너
function fallbackNotice(from: unknown, to: unknown, category: unknown): string {
  const tk = modelDisplay(to) // i18n t()를 가리지 않게 tk
  return t(
    `${fallbackReason(from, category)} ${tk} 모델로 자동 전환했어요. 이후 대화도 ${tk} 모델로 진행됩니다.`,
    `${fallbackReason(from, category)} Automatically switched to ${tk}. The rest of the conversation will use ${tk}.`
  )
}

function describeTool(
  name: string,
  input: Record<string, unknown>,
  cwd: string
): { verb: string; kind: import('@shared/protocol').ToolKind; target: string } {
  // MCP tools are named mcp__<server>__<tool> — show the server as the label and the
  // tool/action as the target instead of the raw, ugly full name.
  if (name.startsWith('mcp__')) {
    const parts = name.split('__')
    return { verb: parts[1] || 'mcp', kind: 'mcp', target: parts.slice(2).join('__') || name }
  }
  switch (name) {
    case 'Read':
      return { verb: 'Read', kind: 'read', target: toRel(cwd, String(input.file_path ?? '')) }
    case 'Grep':
      return { verb: 'Search', kind: 'search', target: String(input.pattern ?? '') }
    case 'Glob':
      return { verb: 'Search', kind: 'search', target: String(input.pattern ?? '') }
    case 'Write':
      return { verb: 'Write', kind: 'write', target: toRel(cwd, String(input.file_path ?? '')) }
    case 'Edit':
    case 'MultiEdit':
      return { verb: 'Edit', kind: 'edit', target: toRel(cwd, String(input.file_path ?? '')) }
    case 'Bash':
      // no length cap — the UI wraps long commands to the next line in full
      return { verb: 'Bash', kind: 'bash', target: String(input.command ?? '').replace(/\s+/g, ' ').trim() }
    case 'WebFetch':
    case 'WebSearch':
      return { verb: 'Web', kind: 'web', target: String(input.url ?? input.query ?? '') }
    default:
      return { verb: name, kind: 'other', target: oneLine(JSON.stringify(input), 200) }
  }
}

// label shown in the working indicator while the model is still *generating* a tool
// call (its input streams in — a whole file body for Write — before the tool row
// appears). Reuses describeTool's kind so it stays in sync with the tool-log icons.
// Present-progressive so it also reads fine once the tool is actually running.
// (모듈 상수가 아니라 호출마다 — 상수면 언어가 첫 로드 시점에 박제된다)
function toolGenLabels(): Record<import('@shared/protocol').ToolKind, string> {
  return {
    read: t('파일 읽는 중', 'Reading a file'),
    search: t('검색하는 중', 'Searching'),
    write: t('파일 작성 중', 'Writing a file'),
    edit: t('파일 수정 중', 'Editing a file'),
    bash: t('명령 실행 중', 'Running a command'),
    task: t('서브에이전트 실행 중', 'Running a subagent'),
    web: t('웹 검색 중', 'Searching the web'),
    mcp: t('도구 실행 중', 'Running a tool'),
    other: t('도구 실행 중', 'Running a tool')
  }
}
function toolGenLabel(name: string): string {
  return toolGenLabels()[describeTool(name, {}, '').kind]
}

// Parse the AskUserQuestion tool input into our AgentQuestion[] shape, tolerating
// the SDK's loosely-typed payload (missing fields, odd types).
function parseQuestions(input: Record<string, unknown>): AgentQuestion[] {
  const raw = Array.isArray(input.questions) ? input.questions : []
  const out: AgentQuestion[] = []
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue
    const o = q as Record<string, unknown>
    const options = (Array.isArray(o.options) ? o.options : [])
      .map((opt) => {
        const r = (opt ?? {}) as Record<string, unknown>
        return { label: String(r.label ?? ''), description: String(r.description ?? '') }
      })
      .filter((opt) => opt.label)
    if (!options.length) continue
    out.push({
      question: String(o.question ?? ''),
      header: String(o.header ?? ''),
      multiSelect: !!o.multiSelect,
      options
    })
  }
  return out
}

// Turn the user's selections into the tool-result text the model reads. Phrased as
// an explicit instruction so the model proceeds with the choice instead of re-asking.
function formatAnswers(questions: AgentQuestion[], answers: string[][] | null): string {
  // 모델이 읽는 지시문 — 이어지는 답변이 사용자 화면에 보이므로 UI 언어를 따른다
  if (!answers)
    return t(
      '사용자가 질문에 답하지 않고 건너뛰었습니다. 합리적인 기본값으로 계속 진행하세요.',
      'The user skipped the question without answering. Continue with reasonable defaults.'
    )
  const lines = questions.map((q, i) => {
    const picked = (answers[i] ?? []).filter(Boolean)
    const label = q.header || q.question || t(`질문 ${i + 1}`, `Question ${i + 1}`)
    return `- ${label}: ${picked.length ? picked.join(', ') : t('(선택 없음)', '(nothing selected)')}`
  })
  return t(
    `사용자가 질문에 다음과 같이 답했습니다:\n${lines.join('\n')}\n\n이 선택을 반영해 계속 진행하세요. (같은 내용을 다시 묻지 마세요.)`,
    `The user answered the question(s) as follows:\n${lines.join('\n')}\n\nContinue with these choices in mind. (Do not ask the same thing again.)`
  )
}

function permissionSummary(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash')
    return t(`명령 실행: ${oneLine(String(input.command ?? ''), 80)}`, `Run command: ${oneLine(String(input.command ?? ''), 80)}`)
  if (toolName === 'Write')
    return t(`파일 생성: ${String(input.file_path ?? '')}`, `Create file: ${String(input.file_path ?? '')}`)
  if (toolName === 'Edit' || toolName === 'MultiEdit')
    return t(`파일 편집: ${String(input.file_path ?? '')}`, `Edit file: ${String(input.file_path ?? '')}`)
  return t(`${toolName} 실행`, `Run ${toolName}`)
}

function resultSummary(name: string, text: string, isError: boolean): string {
  if (isError) return t('오류', 'Error')
  if (name === 'Grep') {
    const m = text.match(/(\d+)\s+(match|matches|lines?)/i)
    if (m) return t(`${m[1]}개 일치`, `${m[1]} matches`)
    const count = text.split('\n').filter((l) => l.trim()).length
    return count ? t(`${count}건`, `${count} hits`) : t('완료', 'Done')
  }
  if (name === 'Read') {
    const count = text.split('\n').length
    return t(`${count}줄`, `${count} lines`)
  }
  if (name === 'Bash') return '✓'
  return t('완료', 'Done')
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text ?? '') : ''))
      .join('\n')
  }
  return ''
}

// WebSearch 결과 본문에서 검색이 찾은 페이지 목록을 뽑는다 — 본문에는
// `Links: [{"title":"…","url":"…"}, …]` JSON 블록이 (여러 검색 라운드면 여러 번) 들어온다.
// 파싱이 안 되는 변형이면 "url":"…" 쌍이라도 줍는다. 채팅 Web 행의 펼침 목록에 쓴다.
function extractWebLinks(text: string): import('@shared/protocol').WebLink[] | undefined {
  const out: { title: string; url: string }[] = []
  const seen = new Set<string>()
  const push = (title: unknown, url: unknown): void => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || seen.has(url)) return
    seen.add(url)
    const t = typeof title === 'string' ? title.trim() : ''
    out.push({ title: t || url, url })
  }
  const re = /Links:\s*(\[[^\n]*\])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    try {
      const arr: unknown = JSON.parse(m[1])
      if (Array.isArray(arr))
        for (const it of arr) {
          const o = (it ?? {}) as Record<string, unknown>
          push(o.title, o.url)
        }
    } catch {
      /* 잘리거나 변형된 블록 — 아래 폴백이 줍는다 */
    }
  }
  if (!out.length) {
    const ure = /"url"\s*:\s*"(https?:\/\/[^"\s]+)"/g
    while ((m = ure.exec(text))) push('', m[1])
  }
  return out.length ? out.slice(0, 20) : undefined
}

// The tail of a bash output for the inline chat log: last 200 lines / 16KB. Caps
// keep the renderer light and the persisted chat snapshots from ballooning.
function tailOutput(text: string): string | undefined {
  const trimmed = text.replace(/\s+$/, '')
  if (!trimmed) return undefined
  let lines = trimmed.split('\n')
  if (lines.length > 200) lines = lines.slice(-200)
  let out = lines.join('\n')
  if (out.length > 16000) out = out.slice(-16000)
  return out
}

function todoStatus(s: string): import('@shared/protocol').TodoStatus {
  if (s === 'completed' || s === 'done') return 'done'
  if (s === 'in_progress' || s === 'running') return 'running'
  return 'pending'
}

// read a file's text, or null if it can't be read (doesn't exist / not text)
function readDisk(abs: string): string | null {
  try {
    return fs.readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

// UTF-8 최악(4바이트/자)으로도 HUGE(4M자)를 확실히 넘는 바이트 크기 — 이 이상이면
// 읽지 않고도 "미리보기 생략" 판정이 확정된다. 그 미만은 기존대로 읽어 글자 수로 판정.
const HUGE_BYTES_CERTAIN = 16_000_000

function statSize(abs: string): number {
  try {
    return fs.statSync(abs).size
  } catch {
    return 0
  }
}

// CRLF → LF — 파일 변경 미리보기 파이프라인은 전부 LF 기준(CmEditor 문서 정규화와 짝)
function normEol(s: string): string {
  return s.replace(/\r\n/g, '\n')
}

// apply an Edit-tool replacement to text the same way the tool does: first occurrence
// (or all when replace_all). Uses indexOf/slice so the match is literal — no regex
// metacharacter surprises from the searched string.
function applyEdit(text: string, oldStr: string, newStr: string, all: boolean): string {
  if (!oldStr) return text
  if (all) return text.split(oldStr).join(newStr)
  const i = text.indexOf(oldStr)
  return i < 0 ? text : text.slice(0, i) + newStr + text.slice(i + oldStr.length)
}

function toRel(cwd: string, p: string): string {
  if (!p) return ''
  try {
    if (path.isAbsolute(p)) {
      const rel = path.relative(cwd, p)
      return rel && !rel.startsWith('..') ? rel.split(path.sep).join('/') : p.split(path.sep).join('/')
    }
  } catch {
    /* ignore */
  }
  return p.split(path.sep).join('/')
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

// A subagent's final result, cleaned for the detail card: drop the SDK's trailing
// "agentId: <id> (use SendMessage …)" continuation metadata — that's plumbing for
// resuming the subagent, not its answer — and keep the original line breaks (the card
// renders pre-wrap). No length cap: the card scrolls, and an agent may return a lot.
function agentResult(text: string): string {
  return text.replace(/\n*\s*agentId:\s*\S+[\s\S]*$/i, '').trim()
}
