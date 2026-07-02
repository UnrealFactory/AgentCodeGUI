import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { app } from 'electron'
import { loadActiveQuery } from '../engine/versions'
import { disabledSkillOverrides } from '../skills'
import { deniedMcpServers } from '../mcp'
import { getApiKey, addSpend } from '../apiConfig'
import { recordApiUsage } from '../apiUsage'
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
  ChangedFile,
  FileDiff,
  Todo
} from '@shared/protocol'
import { computeLineDiff, newFileDiff } from './diff'

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
function windowFromModelUsage(mu?: Record<string, { contextWindow?: number }>): number | null {
  if (!mu) return null
  let max = 0
  for (const key of Object.keys(mu)) {
    const w = mu[key]?.contextWindow
    if (typeof w === 'number' && w > max) max = w
  }
  return max > 0 ? max : null
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
  modelUsage?: Record<string, { contextWindow?: number }>
  // system/model_refusal_fallback (Fable 5 정책 거부 → 폴백 모델 전환 알림)
  original_model?: string
  fallback_model?: string
  api_refusal_category?: string | null
  // system/notification (REPL 알림 큐 미러) · system/informational (루프 배너)
  text?: string
  content?: string
  level?: string
  priority?: string
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

export class ClaudeEngine {
  private emit: Emit
  /** 이 엔진이 속한 화면 (chat/ask/talk/ma) — API 사용 원장의 분류 축 */
  private source: ApiUsageSource
  private abort: AbortController | null = null
  private handle: { interrupt?: () => Promise<void> } | null = null
  private activeRunId: string | null = null
  /** resolves when the active run's stream loop has fully torn down */
  private runLoop: Promise<void> | null = null
  /** pending canUseTool resolvers keyed by requestId */
  private permissionWaiters = new Map<string, (r: PermChoice) => void>()
  /** pending AskUserQuestion resolvers keyed by requestId (answers, or null if dismissed) */
  private questionWaiters = new Map<string, (answers: string[][] | null) => void>()
  /** tool_use id → metadata so we can interpret tool_results (incl. a deferred file change) */
  private tools = new Map<string, { name: string; cwd: string; pending?: { whole: boolean; file: ChangedFile; diff: FileDiff } }>()
  /** tool_use ids of subagent-spawn tools (Task/Agent), to flip them to done on result */
  private subagents = new Set<string>()
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
  /** 마지막으로 띄운 인증 불일치 배너 — 같은 내용이 매 메시지(런)마다 반복되지 않게
   *  내용이 바뀔 때만 다시 띄운다 (예: 전역 ANTHROPIC_API_KEY가 있는 구독 모드). */
  private lastAuthNotice = ''

  constructor(emit: Emit, source: ApiUsageSource = 'chat') {
    this.emit = emit
    this.source = source
  }

  get isRunning(): boolean {
    return this.activeRunId !== null
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

  async cancel(): Promise<void> {
    try {
      await this.handle?.interrupt?.()
    } catch {
      /* ignore */
    }
    this.abort?.abort()
    // reject any outstanding permission prompts
    for (const [, waiter] of this.permissionWaiters) waiter({ behavior: 'deny', message: 'cancelled' })
    this.permissionWaiters.clear()
    // dismiss any open question cards (the run is ending)
    for (const [, waiter] of this.questionWaiters) waiter(null)
    this.questionWaiters.clear()
    // wait for the in-flight stream loop to fully tear down before a new run starts,
    // so two CLI subprocesses can't briefly coexist and emit overlapping events.
    if (this.runLoop) {
      try {
        await this.runLoop
      } catch {
        /* ignore */
      }
    }
  }

  /** Start a run. Returns the runId; events stream via `emit`. */
  async run(req: RunRequest): Promise<string> {
    if (this.isRunning) await this.cancel()

    const runId = nextRunId()
    this.activeRunId = runId
    this.tools.clear()
    this.subagents.clear()
    this.baselines.clear()

    // 폴더가 지정되지 않은 실행(채팅·멀티/단일 폴더 미선택)은 홈이 아니라 바탕화면에서
    // 동작한다 — 사용자가 결과물을 바로 확인하기 쉬운 위치. app.getPath는 OneDrive로
    // 리디렉션된 바탕화면도 정확히 잡는다(실패 시에만 홈으로).
    const cwd = req.cwd && req.cwd.trim() ? req.cwd : defaultCwd()
    const abort = new AbortController()
    this.abort = abort
    let resolveLoop: () => void = () => {}
    this.runLoop = new Promise<void>((r) => (resolveLoop = r))

    const prompt = req.prompt
    const permissionMode = modeToPermission(req.mode)
    // skills turned off in 설정 → Skill: hide them from the model for this run via
    // the flag-settings layer (null when nothing is disabled). This never touches
    // the user's ~/.claude config — it's applied per-run alongside permissionMode.
    const skillOverrides = disabledSkillOverrides()
    // MCP servers turned off in 설정 → MCP: a per-run denylist spanning every scope
    // (null when none disabled). Like skillOverrides, never edits ~/.claude.json.
    const mcpDenied = deniedMcpServers()

    this.emit({ type: 'status', runId, status: 'analyzing' })

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
    let streamedThisMsg = false
    // banners already emitted from onUserDialog — the end-of-turn
    // model_refusal_fallback notice for the same fallback is then skipped
    let pendingFallbackNotices = 0
    // 지금 답변을 생성 중인 모델(표시명) — assistant 프레임의 model 필드로 추적해, 세션
    // 중 전환(한도 도달·모델 과부하 폴백 등 거부 이외의 원인 포함)을 감지해 배너를 띄운다.
    // 거부 폴백 경로는 배너를 직접 띄우면서 이 값을 갱신하므로 이중 배너가 뜨지 않는다.
    let curModelDisplay = ''

    // API 모드 — 저장된 키를 하위 CLI의 환경변수로 주입해 이 실행을 구독(OAuth)이
    // 아닌 API 키 과금으로 돌린다. 키 원문은 여기(메인)에서만 읽고 렌더러엔 안 간다.
    const useApi = !!req.useApi
    const apiKey = useApi ? getApiKey() : null

    try {
      if (!query) {
        throw new Error('설치된 Claude Code 엔진이 없습니다. 설정 → 버전에서 엔진을 먼저 설치해 주세요.')
      }
      if (useApi && !apiKey) {
        throw new Error('API 모드가 켜져 있지만 저장된 API 키가 없습니다. 설정 → API에서 키를 먼저 등록해 주세요.')
      }
      const q = query({
        prompt,
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
            ...(skillOverrides ? { skillOverrides } : {}),
            ...(mcpDenied ? { deniedMcpServers: mcpDenied } : {})
          },
          // reasoning effort (or thinking off) chosen in the composer's effort picker
          ...effortToOptions(req.effort, req.model),
          // continue this chat's conversation (loads prior history) instead of
          // starting fresh every message
          ...(req.resume ? { resume: req.resume } : {}),
          // 'bypassPermissions' is inert unless this companion flag is set — the SDK
          // only passes --allow-dangerously-skip-permissions when it's true.
          ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
          // API 모드: ANTHROPIC_API_KEY를 주입해 이 실행을 API 키 과금으로 돌린다.
          // SDK의 env 옵션은 process.env를 대체(merge 아님)하므로 반드시 펼쳐서 준다.
          ...(useApi && apiKey ? { env: { ...process.env, ANTHROPIC_API_KEY: apiKey } } : {}),
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
          abortController: abort,
          // The SDK spawns its bundled native Claude CLI directly and, with no
          // CLAUDE_CONFIG_DIR / ANTHROPIC_API_KEY override, reads the existing
          // ~/.claude OAuth login — so a Max subscription works with no API key.
          ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}),
          canUseTool: this.makeCanUseTool(runId, req.mode, cwd),
          // ── Fable 5 정책 거부 → 폴백 모델 자동 전환 (CLI 패리티) ──
          // Fable 5 has safety measures that can end a turn with stop_reason
          // 'refusal'. The SDK's fallback flow is dialog-gated: a consumer that
          // doesn't declare 'refusal_fallback_prompt' just gets the refusal error
          // and the turn dies. Declare it and auto-accept — like the CLI, the turn
          // is retried on the fallback model (Opus) and the session stays there —
          // and surface a warning banner in the chat instead of a blocking prompt.
          supportedDialogKinds: ['refusal_fallback_prompt'],
          onUserDialog: async (dlg: { dialogKind: string; payload?: Record<string, unknown> }) => {
            // unrecognized dialog kinds must be answered 'cancelled' (SDK contract:
            // the CLI then applies that dialog's default behavior)
            if (dlg.dialogKind !== 'refusal_fallback_prompt') return { behavior: 'cancelled' as const }
            const p = dlg.payload ?? {}
            pendingFallbackNotices++
            if (thinkingOpen) {
              this.emit({ type: 'thinking-clear', runId })
              thinkingOpen = false
            }
            this.emit({
              type: 'model-fallback',
              runId,
              fromModel: typeof p.originalModel === 'string' ? p.originalModel : '',
              toModel: typeof p.fallbackModel === 'string' ? p.fallbackModel : '',
              text: fallbackNotice(p.originalModel, p.fallbackModel, p.apiRefusalCategory),
              // the refused leg's streamed partial — the retried answer must start
              // a fresh bubble, not append to it
              retractMessageId: curTextId
            })
            curModelDisplay = modelKey(p.fallbackModel) || curModelDisplay
            curTextId = null
            curThinking = ''
            streamedThisMsg = false
            return { behavior: 'completed' as const, result: 'retry_fallback' }
          },
          stderr: (data: string) => {
            if (data?.trim()) this.emit({ type: 'terminal', runId, line: { type: 'muted', text: data.trim() } })
          }
        }
      })
      this.handle = q as unknown as { interrupt?: () => Promise<void> }

      // size of the live context window. Each assistant turn's usage reflects the
      // whole conversation at that point, so the latest one is the current context.
      // The final `result.usage` is the run's *cumulative* total (summed across every
      // turn — input + cache reads add up over many tool rounds), which would wildly
      // overstate the window, so we never use it for the gauge.
      let lastContextTokens: number | null = null

      for await (const raw of q as AsyncIterable<SdkMsg>) {
        if (this.activeRunId !== runId) break
        const msg = raw

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
          // API 모드 검증 — init의 apiKeySource가 실제 과금 경로를 알려준다. 토글과
          // 어긋나면(켰는데 oauth로 붙음 / 껐는데 API 키로 붙음 — 예: 전역 환경변수)
          // 조용히 지나가지 않고 배너로 알린다. 같은 배너가 매 메시지 반복되진 않게
          // 내용이 바뀔 때만 다시 띄운다.
          if (typeof msg.apiKeySource === 'string' && msg.apiKeySource) {
            let authNotice = ''
            if (useApi && msg.apiKeySource === 'oauth') {
              authNotice = 'API 모드가 켜져 있지만 이 실행은 구독(OAuth) 인증으로 연결됐어요. 과금이 API 키로 되지 않았을 수 있습니다.'
            } else if (!useApi && msg.apiKeySource !== 'oauth') {
              authNotice = '이 실행은 API 키 인증으로 연결됐어요(환경변수 등). 구독이 아닌 API 크레딧으로 과금될 수 있습니다.'
            }
            if (authNotice !== this.lastAuthNotice) {
              this.lastAuthNotice = authNotice
              if (authNotice) this.emit({ type: 'notice', runId, text: authNotice })
            }
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

        // partial streaming: text/thinking arrive as deltas before the full message
        if (msg.type === 'stream_event') {
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
              curThinking += d.thinking
              streamedThisMsg = true
              this.emit({ type: 'thinking', runId, text: oneLine(curThinking, 90) })
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
                text: `모델이 ${curModelDisplay}에서 ${mk}로 전환되었어요. 이후 답변은 ${mk}로 생성됩니다.`,
                retractMessageId: null
              })
              curModelDisplay = mk
            }
          }
          // live context estimate: each assistant turn's usage reflects the
          // conversation so far → update the gauge before the final result lands.
          const ctx = contextFromUsage(msg.message?.usage)
          if (ctx != null) {
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
          streamedThisMsg = false
          continue
        }

        if (msg.type === 'user') {
          const blocks = Array.isArray(msg.message?.content) ? (msg.message!.content as ContentBlock[]) : []
          for (const block of blocks) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              this.handleToolResult(runId, block)
            }
          }
          continue
        }

        if (msg.type === 'result') {
          // Only SDKResultSuccess carries `result`; error subtypes put text in `errors`.
          const resultText = msg.is_error
            ? Array.isArray(msg.errors) && msg.errors.length
              ? msg.errors.join('; ')
              : msg.result ?? '실행이 실패했습니다.'
            : msg.result ?? ''
          // use the last per-turn context, NOT contextFromUsage(msg.usage): the
          // result's usage is cumulative across the whole run and would overstate
          // the live window (often well past 100%).
          // API 모드 실행의 비용은 전역 누적(설정 → API의 사용액)에 바로 더하고, 실행
          // 1건을 사용 원장에 남긴다(모델별·일별 통계) — 모든 엔진 인스턴스(메인/ask/
          // 채팅/멀티)가 이 경로를 지나므로 한 곳에서 끝난다.
          if (useApi && typeof msg.total_cost_usd === 'number') {
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
            viaApi: useApi
          })
          this.emit({ type: 'status', runId, status: msg.is_error ? 'error' : 'done' })
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // An abort surfaces as an error — don't surface it as a failure to the user.
      if (!abort.signal.aborted) {
        this.emit({ type: 'error', runId, message })
        this.emit({ type: 'status', runId, status: 'error' })
      }
    } finally {
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
      if (this.activeRunId === runId) {
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
    this.tools.set(id, { name, cwd })

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
          role: oneLine(desc, 40) || '서브에이전트',
          status: 'running',
          activity: oneLine(desc, 200) || '작업 중',
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
      const cur = readDisk(abs)
      let next: string
      if (name === 'Write') {
        next = String(input.content ?? '')
      } else if (name === 'Edit') {
        next = applyEdit(cur ?? '', String(input.old_string ?? ''), String(input.new_string ?? ''), !!input.replace_all)
      } else {
        const edits = Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : []
        next = edits.reduce((t, e) => applyEdit(t, String(e.old_string ?? ''), String(e.new_string ?? ''), !!e.replace_all), cur ?? '')
      }
      this.tools.set(id, { name, cwd, pending: this.fileChangePending(rel, abs, cur, next) })
    }
  }

  // Build a deferred whole-file change. `cur` is the file's content right before this
  // tool runs; the first time a path is touched this run it becomes the baseline, so
  // later edits diff against the run's original state (cumulative). A path with no
  // baseline (didn't exist) renders as an all-added new file.
  private fileChangePending(
    rel: string,
    abs: string,
    cur: string | null,
    next: string
  ): { whole: boolean; file: ChangedFile; diff: FileDiff } {
    if (!this.baselines.has(abs)) this.baselines.set(abs, cur)
    const base = this.baselines.get(abs) ?? null
    if (base == null) {
      const { lines, add } = newFileDiff(next)
      return { whole: true, file: { path: rel, add, del: 0, tag: 'new' }, diff: { path: rel, tag: 'new', add, del: 0, lines } }
    }
    const { lines, add, del } = computeLineDiff(base, next)
    return { whole: true, file: { path: rel, add, del, tag: 'edit' }, diff: { path: rel, tag: 'edit', add, del, lines } }
  }

  // ── tool_result → events ───────────────────────────────────
  private handleToolResult(runId: string, block: ContentBlock): void {
    const id = block.tool_use_id!
    const meta = this.tools.get(id)
    const isError = !!block.is_error
    const text = resultText(block.content)

    // Subagent finished
    if (this.subagents.has(id)) {
      this.subagents.delete(id)
      this.emit({
        type: 'subagent',
        runId,
        agent: { id, name: '', role: '', status: 'done', activity: agentResult(text) || '완료', tools: [] }
      })
      return
    }

    // Emit the deferred file change only now that the edit/write has actually succeeded.
    if (meta?.pending && !isError) {
      this.emit({ type: 'file-change', runId, file: meta.pending.file, diff: meta.pending.diff, whole: meta.pending.whole })
    }

    if (meta?.name === 'Bash') {
      const lines = text.split('\n').slice(0, 200)
      for (const ln of lines) {
        if (ln.trim()) this.emit({ type: 'terminal', runId, line: { type: isError ? 'err' : 'out', text: ln } })
      }
      if (!isError) this.emit({ type: 'terminal', runId, line: { type: 'ok', text: '✓ 완료' } })
    }

    // Panel-feeding tools (TodoWrite / Task*) produce no tool log row.
    if (meta && !TASK_TOOLS.has(meta.name)) {
      // edit/write surface their +/- line counts (or 새 파일); other tools use a summary
      const result =
        meta.pending && !isError
          ? meta.pending.file.tag === 'new'
            ? '새 파일'
            : `+${meta.pending.file.add} -${meta.pending.file.del}`
          : resultSummary(meta.name, text, isError)
      // Bash rows carry their output tail so the chat can show it as an inline log
      const output = meta.name === 'Bash' ? tailOutput(text) : undefined
      this.emit({ type: 'tool-end', runId, id, status: isError ? 'error' : 'done', result, ...(output ? { output } : {}) })
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
      if (choice.behavior === 'deny') return { behavior: 'deny', message: choice.message || '사용자가 거부했습니다.' }
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
// 'claude-opus-4-8(-YYYYMMDD)' → 'Opus 4.8' — 폴백 경고 배너에 쓰는 표시 이름
function modelDisplay(id: unknown): string {
  const s = typeof id === 'string' ? id : ''
  const m = /claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?\b/i.exec(s)
  if (!m) return s || '다른 모델'
  return m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() + ' ' + m[2] + (m[3] ? '.' + m[3] : '')
}

// modelDisplay의 엄격판 — 풀 모델 id로 파싱될 때만 표시명을, 아니면 ''. 전환 감지의 비교
// 키로 쓴다: 짧은 별칭('fable')이나 빈 값이 기준점을 오염시켜 가짜 전환 배너를 띄우지 않게.
// [1m] 컨텍스트 변형은 같은 표시명으로 정규화돼 전환으로 치지 않는다.
function modelKey(id: unknown): string {
  const s = typeof id === 'string' ? id : ''
  return /claude-(fable|opus|sonnet|haiku)-\d/i.test(s) ? modelDisplay(s) : ''
}

// stop_details.category 코드 → 한국어 라벨. Open string — 새 분류가 스키마보다
// 먼저 생길 수 있어서, 모르는 값은 코드 그대로 보여준다.
const REFUSAL_CATEGORY_LABEL: Record<string, string> = { cyber: '사이버 보안', bio: '생물학' }

function fallbackNotice(from: unknown, to: unknown, category: unknown): string {
  const f = modelDisplay(from)
  const t = modelDisplay(to)
  const c = typeof category === 'string' && category ? ` (감지 분류: ${REFUSAL_CATEGORY_LABEL[category] ?? category})` : ''
  return `${f}의 안전 정책이 이 요청에 대한 응답을 거부해 ${t} 모델로 자동 전환했어요${c}. 이후 대화도 ${t} 모델로 진행됩니다.`
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
const TOOL_GEN_LABEL: Record<import('@shared/protocol').ToolKind, string> = {
  read: '파일 읽는 중',
  search: '검색하는 중',
  write: '파일 작성 중',
  edit: '파일 수정 중',
  bash: '명령 실행 중',
  task: '서브에이전트 실행 중',
  web: '웹 검색 중',
  mcp: '도구 실행 중',
  other: '도구 실행 중'
}
function toolGenLabel(name: string): string {
  return TOOL_GEN_LABEL[describeTool(name, {}, '').kind]
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
  if (!answers) return '사용자가 질문에 답하지 않고 건너뛰었습니다. 합리적인 기본값으로 계속 진행하세요.'
  const lines = questions.map((q, i) => {
    const picked = (answers[i] ?? []).filter(Boolean)
    const label = q.header || q.question || `질문 ${i + 1}`
    return `- ${label}: ${picked.length ? picked.join(', ') : '(선택 없음)'}`
  })
  return `사용자가 질문에 다음과 같이 답했습니다:\n${lines.join('\n')}\n\n이 선택을 반영해 계속 진행하세요. (같은 내용을 다시 묻지 마세요.)`
}

function permissionSummary(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash') return `명령 실행: ${oneLine(String(input.command ?? ''), 80)}`
  if (toolName === 'Write') return `파일 생성: ${String(input.file_path ?? '')}`
  if (toolName === 'Edit' || toolName === 'MultiEdit') return `파일 편집: ${String(input.file_path ?? '')}`
  return `${toolName} 실행`
}

function resultSummary(name: string, text: string, isError: boolean): string {
  if (isError) return '오류'
  if (name === 'Grep') {
    const m = text.match(/(\d+)\s+(match|matches|lines?)/i)
    if (m) return `${m[1]}개 일치`
    const count = text.split('\n').filter((l) => l.trim()).length
    return count ? `${count}건` : '완료'
  }
  if (name === 'Read') {
    const count = text.split('\n').length
    return `${count}줄`
  }
  if (name === 'Bash') return '✓'
  return '완료'
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
