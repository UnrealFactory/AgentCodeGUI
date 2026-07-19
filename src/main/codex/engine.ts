/* ============================================================
 * CodexEngine — OpenAI Codex CLI(`codex app-server`) 어댑터.
 *
 * ClaudeEngine과 같은 공개 계약(run/cancel/respondPermission/respondQuestion)을
 * 구현해, 렌더러는 엔진이 무엇이든 같은 EngineEvent 스트림만 본다.
 *
 * 와이어(실측, codex-cli 0.144.3):
 *  - `codex app-server` 프로세스와 stdio로 JSONL(JSON-RPC, 줄 단위) 통신
 *  - initialize → thread/start|resume → turn/start, 이후 알림 스트림
 *  - 승인은 서버→클라이언트 요청(item/commandExecution/requestApproval 등)으로
 *    오고, 우리 응답(decision)으로 풀린다 → permission-request 카드에 매핑
 *  - 선택형 질문(item/tool/requestUserInput)도 서버→클라 요청 — thread 설정
 *    오버라이드로 켜고(THREAD_CONFIG) question-request 카드에 매핑 (실측 0.144.4)
 *  - 모델 목록은 model/list (gpt-5.6-terra/luna, gpt-5.5, gpt-5.4-mini 실측)
 * ============================================================ */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { codexAccountRunDir, codexApiKeyRunDir, codexDefaultAccountEmail, syncCodexAccount } from './auth'
import { getOpenaiApiKey } from '../apiConfig'
import { codexBin } from './versions'
import { lspManager } from '../lsp/manager'
import type {
  AgentQuestion,
  BgTaskRequest,
  ChangedFile,
  CodexModelInfo,
  DiffLine,
  EffortId,
  EngineEvent,
  FileDiff,
  ModeId,
  PermissionResponse,
  QuestionResponse,
  RunRequest,
  Todo,
  ToolLogItem
} from '@shared/protocol'

type Emit = (event: EngineEvent) => void

// thread/start·resume의 config 오버라이드 (실측 0.144.4):
//  - 선택형 질문(request_user_input): tools.experimental_request_user_input(빈 맵 =
//    struct 기본값, boolean은 거절됨)로 켜지고, Default 모드에선 라우터가
//    "unavailable in Default mode"로 막으므로 features.default_mode_request_user_input이
//    함께 필요하다. 질문이 오면 item/tool/requestUserInput 서버 요청 → 질문 카드.
//  - unified_exec: 명령을 PTY 세션으로 돌려, 안 끝나는 명령이 턴을 막지 않고
//    백그라운드 터미널로 등록된다(폴링·중지·출력은 아래 bgTerms 배선).
const THREAD_CONFIG = {
  tools: { experimental_request_user_input: {} },
  features: { default_mode_request_user_input: true, unified_exec: true }
}

let runCounter = 0
const nextRunId = (): string => `cxrun-${++runCounter}`
// 재시작·복원된 대화의 기존 메시지 id와 절대 겹치지 않게 실행 태그를 붙인다
const LAUNCH_TAG = Math.random().toString(36).slice(2, 8)

/** picker EffortId → Codex reasoning effort. (max는 미지원 모델에서 xhigh로 강등) */
function codexEffort(effort: EffortId, supported: string[] | null): string {
  const want = effort === 'minimal' ? 'low' : effort
  if (!supported || supported.includes(want)) return want
  const ladder = ['max', 'xhigh', 'high', 'medium', 'low']
  for (const e of ladder.slice(ladder.indexOf(want) < 0 ? 0 : ladder.indexOf(want))) {
    if (supported.includes(e)) return e
  }
  return supported[supported.length - 1] ?? 'medium'
}

/** picker ModeId → Codex approvalPolicy + sandbox. Claude 모드 의미에 최대한 대응. */
function codexPolicy(mode: ModeId): { approvalPolicy: string; sandbox: string } {
  switch (mode) {
    case 'plan':
      // 플랜 대응: 읽기 전용 샌드박스 — 계획/분석만 하고 변경은 승인 후 다음 턴에서
      return { approvalPolicy: 'on-request', sandbox: 'read-only' }
    case 'acceptEdits':
      // 워크스페이스 안 파일 편집은 자동, 그 밖(네트워크·바깥 경로)은 요청 시 승인
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' }
    case 'auto':
      return { approvalPolicy: 'never', sandbox: 'workspace-write' }
    case 'bypass':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' }
    case 'normal':
    default:
      // 변경마다 승인 요청
      return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' }
  }
}

/** unified diff 텍스트 → 뷰어 마킹용 FileDiff 라인/증감. */
function parseUnifiedDiff(diffText: string): { lines: DiffLine[]; add: number; del: number } {
  const lines: DiffLine[] = []
  let add = 0
  let del = 0
  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('@@')) lines.push({ t: 'hunk', text: raw })
    else if (raw.startsWith('+++') || raw.startsWith('---')) continue
    else if (raw.startsWith('+')) {
      add++
      lines.push({ t: 'add', text: raw.slice(1) })
    } else if (raw.startsWith('-')) {
      del++
      lines.push({ t: 'del', text: raw.slice(1) })
    } else {
      lines.push({ t: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : raw })
    }
  }
  return { lines, add, del }
}

// 서브에이전트 중첩 활동 아이템(subAgentActivity.item) → 카드 activity 한 줄.
// 모르는 타입은 빈 문자열 — 카드에 소음을 만들지 않는다.
function cxActivityLine(inner: Record<string, unknown> | undefined): string {
  if (!inner) return ''
  switch (String(inner.type ?? '')) {
    case 'commandExecution':
      return oneLine('$ ' + String(inner.command ?? ''), 200)
    case 'fileChange': {
      const changes = ((inner.changes as { path?: string }[] | undefined) ?? [])
        .map((c) => String(c.path ?? '').split(/[\\/]/).pop())
        .filter(Boolean)
      return changes.length ? oneLine('파일 수정: ' + changes.join(', '), 200) : '파일 수정'
    }
    case 'webSearch': {
      const t = cxWebSearchTarget(inner)
      return t ? oneLine('검색: ' + t, 200) : ''
    }
    case 'mcpToolCall':
      return oneLine('MCP: ' + String(inner.tool ?? ''), 200)
    case 'agentMessage':
      return oneLine(String(inner.text ?? ''), 200)
    case 'reasoning':
      return oneLine(String((inner as { summary?: string; text?: string }).summary ?? (inner as { text?: string }).text ?? ''), 200)
    default:
      return ''
  }
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

// webSearch 아이템 → 행에 보여줄 대상 문구. 검색어는 item/completed에만 실리고
// (started는 query=""·action=null, 실측 0.144.4), 검색이 아닌 열람류 액션은
// {type:'other'}로 와 검색어가 끝까지 없다. 찾은 페이지 목록은 프로토콜에 없음 —
// 검색어 표시가 가능한 최대치다 (인용 링크는 답변 본문 마크다운으로 렌더된다).
function cxWebSearchTarget(item: Record<string, unknown>): string {
  const action = (item.action ?? {}) as { type?: string; query?: string; queries?: string[] | null }
  const queries = Array.isArray(action.queries) ? action.queries.filter(Boolean) : []
  const query = String(item.query ?? '') || String(action.query ?? '') || queries.join(' · ')
  if (query) return oneLine(query, 200)
  return action.type === 'other' ? '검색한 페이지 열람' : ''
}

// ── 모델 수용량 초과(ServerOverloaded) 판정 ──────────────────
// "Selected model is at capacity. Please try a different model."는 CLI가 재시도하지
// 않는 종결 오류다(codex-rs is_retryable=false 실측). 와이어에선 error 알림
// (willRetry=false) 뒤 turn/completed(status failed)가 따라오고, 양쪽 TurnError에
// codexErrorInfo: 'serverOverloaded'가 실린다(구버전 대비 메시지 매칭 폴백 유지).
function isCapacityErr(err: { message?: string; codexErrorInfo?: unknown } | null | undefined): boolean {
  if (!err) return false
  if (err.codexErrorInfo === 'serverOverloaded') return true
  return /at capacity|try a different model/i.test(String(err.message ?? ''))
}

// model/list가 안 될 때의 전환 후보 사다리 (renderer CODEX_FALLBACK과 같은 실측 순서)
const CAPACITY_LADDER: { id: string; label: string }[] = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' }
]

// unified exec은 PTY라 출력에 터미널 제어 시퀀스(CSI/OSC 등)가 섞인다 — 셸 카드
// 테일 파일은 평문이어야 해서 벗겨낸다 (Claude의 output_file은 원래 평문)
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '') // OSC (창 제목 등)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI (색·커서·지우기)
    .replace(/\x1b[@-Z\\-_]/g, '') // 2글자 ESC
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

export class CodexEngine {
  private emit: Emit
  private proc: ChildProcessWithoutNullStreams | null = null
  private stdoutBuf = ''
  private rpcId = 0
  private pending = new Map<number, Pending>()
  private initialized: Promise<void> | null = null
  /** 지금 프로세스가 어느 계정의 CODEX_HOME으로 떠 있나 — 계정이 바뀌면 재기동 */
  private procHome: string | null = null
  /** 이번 실행이 소비하는 계정 — finishRun에서 리프레시 토큰 되싱크에 쓴다 */
  private activeAccountEmail: string | null = null

  private activeRunId: string | null = null
  private activeThreadId: string | null = null
  private activeTurnId: string | null = null
  /** 이미 마감한 턴 id들 — 중단 3s 캡·수용량 재시도 등으로 먼저 마감한 턴의 늦은
   *  turn/completed·error 통지가 다음 실행의 시작 창(activeTurnId 공백)에 도착해
   *  새 runId로 둔갑하는 것을 막는다 (Claude의 무음 미니턴 오발과 같은 가족) */
  private endedTurnIds = new Set<string>()
  /** 턴 시작 시각 — turn.durationMs가 안 실려 올 때 '작업함' 줄의 소요 폴백 */
  private turnStartedAt = 0
  /** 이번 실행의 작업 폴더 — 파일 변경 경로를 Claude 엔진처럼 cwd 상대로 바꾼다 */
  private activeCwd = ''
  /** turn/completed(또는 오류)로 풀리는 현재 턴의 종료 대기 */
  private turnDone: { resolve: () => void } | null = null

  /** 승인 카드 requestId → JSON-RPC 응답을 보낼 서버 요청 id + 종류 */
  private permWaiters = new Map<string, { rpcId: number | string; kind: 'command' | 'file' | 'legacy-exec' | 'legacy-patch' }>()
  private permCounter = 0
  /** 질문 카드 requestId → 서버 요청 id + 질문 id 순서 (위치 기반 답 → id 매핑용) */
  private questionWaiters = new Map<string, { rpcId: number | string; qids: string[] }>()
  /** 서버 요청이 아닌 앱 자체 질문 카드(수용량 전환 확인) — requestId → resolve */
  private localQuestionWaiters = new Map<string, (answers: string[][] | null) => void>()

  /** 이번 실행의 요청 원본 — 수용량 초과 시 다른 모델로 같은 턴을 재시도하는 데 쓴다 */
  private activeModel = ''
  private activePrompt = ''
  private activeEffort: EffortId = 'medium'
  /** 이번 실행에서 수용량 초과로 실패한 모델들 — 전환 후보에서 빼 핑퐁을 막는다 */
  private triedModels = new Set<string>()

  /** itemId → tool-start를 보낸 도구 메타 (완료 시 tool-end 매핑) */
  private items = new Map<string, { kind: ToolLogItem['kind']; startedAt: number; output?: string }>()
  /** 백그라운드 터미널(unified exec) — itemId 키. 안 끝나는 명령이 세션에 남으면
   *  backgroundTerminals/list 폴링이 여기 등록하고 셸 칩(bg-tasks)으로 흘린다.
   *  출력은 outputDelta를 임시 파일에 이어 써서 렌더러의 기존 테일 폴링을 재사용.
   *  stopped: 중지 주체 표식 — 'user'(중지 버튼)/'turnEnd'(턴 종료 정리, 수명 통일) */
  private bgTerms = new Map<string, { processId: string; command: string; outputFile: string; startedAt: number; stopped?: 'user' | 'turnEnd' }>()
  /** processId → itemId (중지 요청·정착 통지의 역참조) */
  private bgByProcess = new Map<string, string>()
  private bgPollTimer: ReturnType<typeof setInterval> | null = null
  /** Codex 서브에이전트 — agentThreadId → { 시작 시각, 완료 여부 }. 실측(0.144): 스폰은
   *  spawnAgent 콜이 아니라 메인 스레드의 subAgentActivity{kind:'started'}로 통지되고,
   *  자식 스레드의 턴·아이템이 같은 연결에 다른 threadId로 스트리밍된다. */
  private cxAgents = new Map<string, { startedAt: number; done?: boolean }>()
  /** collab 제어 호출(item id) → { tool, 대상 agentThreadIds } — 완료 시 agentsStates 반영 */
  private cxCollabCalls = new Map<string, { tool: string; agents: string[] }>()
  /** 진행 중 reasoning 요약 누적 — thinking 한 줄로 보여준다 */
  private thinkingBuf = ''
  private lastCtxTokens: number | null = null
  private lastCtxWindow: number | null = null
  private sawActivity = false
  /** thread/tokenUsage/updated의 total(스레드 누적) 최신값 — 턴 소모량은 정착(settleTurn)
   *  시점 total과 직전 정착 시점 total(usageBase)의 델타로 만든다. 다른 스레드로 갈아타면
   *  서버 카운터가 이어지지 않으므로 베이스도 리셋(usageThreadId가 그 판별). 리셋 직후의
   *  첫 통지는 usageBaseAdopt로 base = total − last를 채택한다: 신규 스레드는 total==last라
   *  0과 같고, 재시작 후 복원(resume) 스레드가 total에 과거 누적을 실어 보내는 경우에도
   *  과거분이 통째로 이번 턴에 귀속되는 걸 막는다(오차는 최대 요청 1건분). */
  private usageTotal = { inTok: 0, cached: 0, outTok: 0 }
  private usageBase = { inTok: 0, cached: 0, outTok: 0 }
  private usageBaseAdopt = false
  private usageThreadId: string | null = null

  private modelCache: { at: number; models: CodexModelInfo[] } | null = null

  constructor(emit: Emit) {
    this.emit = emit
  }

  get isRunning(): boolean {
    return this.activeRunId !== null
  }

  // ── 프로세스/RPC 배관 ─────────────────────────────────────────
  // app-server는 CODEX_HOME(계정 폴더) 하나로 뜬다 — 다른 계정으로 실행하려면 재기동.
  // 실행은 엔진 인스턴스당 한 번에 하나라 턴 사이 재기동은 안전하다(스레드는
  // sessions 정션 공유 덕에 resume이 계정과 무관하게 이어진다).
  private setHome(home: string | null): void {
    if (this.procHome === home) return
    this.procHome = home
    if (this.proc && this.proc.exitCode === null) {
      try {
        this.proc.kill() // exit 핸들러가 pending·initialized를 정리한다
      } catch {
        /* ignore */
      }
      this.proc = null
      this.initialized = null
    }
  }

  private ensureProc(): ChildProcessWithoutNullStreams {
    if (this.proc && this.proc.exitCode === null) return this.proc
    // 앱이 설치·관리하는 codex 실행본(없으면 전역 PATH 폴백) — .cmd라 shell 경유가 견고
    const proc = spawn(codexBin(), ['app-server'], {
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: os.homedir(),
      env: { ...process.env, ...(this.procHome ? { CODEX_HOME: this.procHome } : {}) }
    })
    proc.on('error', () => {
      /* exit 핸들러가 정리 */
    })
    proc.on('exit', () => {
      // 진행 중이던 요청은 모두 실패 처리 — 다음 run이 새 프로세스를 띄운다
      for (const [, p] of this.pending) p.reject(new Error('codex app-server 종료'))
      this.pending.clear()
      this.initialized = null
      if (this.proc === proc) this.proc = null
      if (this.activeRunId) {
        this.emit({ type: 'error', runId: this.activeRunId, message: 'Codex CLI(app-server)가 종료됐어요. 다시 시도해 주세요.' })
        this.finishRun('error')
      }
    })
    proc.stdout.on('data', (d: Buffer) => this.onStdout(d.toString('utf8')))
    proc.stderr.on('data', () => {
      /* 진단 로그 — 이벤트로 올리지 않는다 */
    })
    this.proc = proc
    this.stdoutBuf = ''
    return proc
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk
    let nl: number
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim()
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      if (!line) continue
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      this.onMessage(msg)
    }
  }

  private request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const proc = this.ensureProc()
    const id = ++this.rpcId
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n'
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      proc.stdin.write(payload, (err) => {
        if (err) {
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  private respondRpc(id: number | string, result: unknown): void {
    if (!this.proc || this.proc.exitCode !== null) return
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
  }

  private respondRpcError(id: number | string, message: string): void {
    if (!this.proc || this.proc.exitCode !== null) return
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }) + '\n')
  }

  private ensureInitialized(): Promise<void> {
    if (this.initialized) return this.initialized
    this.initialized = this.request('initialize', {
      clientInfo: { name: 'agentcodegui', title: 'AgentCodeGUI', version: '2.0.0' },
      // thread/backgroundTerminals/*는 experimentalApi opt-in이 필요 (실측: 없으면
      // "requires experimentalApi capability"로 거절)
      capabilities: { experimentalApi: true }
    }).then(() => undefined)
    return this.initialized
  }

  // ── 메시지 라우팅 ────────────────────────────────────────────
  private onMessage(msg: Record<string, unknown>): void {
    // 1) 응답 (id + result/error, method 없음)
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id as number)
      if (p) {
        this.pending.delete(msg.id as number)
        if (msg.error) p.reject(new Error((msg.error as { message?: string })?.message ?? 'Codex RPC 오류'))
        else p.resolve(msg.result)
      }
      return
    }
    // 2) 서버→클라이언트 요청 (id + method)
    if (msg.id !== undefined && typeof msg.method === 'string') {
      this.onServerRequest(msg.id as number | string, msg.method, (msg.params ?? {}) as Record<string, unknown>)
      return
    }
    // 3) 알림 (method만)
    if (typeof msg.method === 'string') this.onNotification(msg.method, (msg.params ?? {}) as Record<string, unknown>)
  }

  private onServerRequest(id: number | string, method: string, params: Record<string, unknown>): void {
    const runId = this.activeRunId
    if (!runId) {
      this.respondRpcError(id, 'no active run')
      return
    }
    const ask = (kind: 'command' | 'file' | 'legacy-exec' | 'legacy-patch', toolName: string, summary: string): void => {
      const requestId = `cxperm-${LAUNCH_TAG}-${++this.permCounter}`
      this.permWaiters.set(requestId, { rpcId: id, kind })
      this.emit({ type: 'permission-request', runId, requestId, toolName, summary, engine: 'codex' })
    }
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const cmd = (params.command as string) ?? ''
        const reason = (params.reason as string) ?? ''
        ask('command', 'Bash', cmd || reason || '명령 실행')
        return
      }
      case 'execCommandApproval': {
        const cmd = Array.isArray(params.command) ? (params.command as string[]).join(' ') : String(params.command ?? '')
        ask('legacy-exec', 'Bash', cmd || '명령 실행')
        return
      }
      case 'item/fileChange/requestApproval': {
        const reason = (params.reason as string) ?? ''
        ask('file', 'Edit', reason || '파일 변경 적용')
        return
      }
      case 'applyPatchApproval': {
        ask('legacy-patch', 'Edit', '파일 변경 적용')
        return
      }
      // 선택형 질문 — 스키마가 AgentQuestion과 1:1이라(header/question/options{label,
      // description}) Claude의 AskUserQuestion과 같은 질문 카드로 흘린다. 질문 id는
      // 응답 매핑용으로 보관(카드의 위치 기반 답 string[][] → { qid: { answers } }).
      case 'item/tool/requestUserInput': {
        const raw = (params.questions as Array<Record<string, unknown>> | undefined) ?? []
        const questions: AgentQuestion[] = raw.map((q) => ({
          question: String(q.question ?? ''),
          header: String(q.header ?? ''),
          multiSelect: false, // Codex 질문엔 다중 선택 개념이 없다 — 단일 선택
          options: ((q.options as Array<{ label?: unknown; description?: unknown }> | undefined) ?? []).map((o) => ({
            label: String(o.label ?? ''),
            description: String(o.description ?? '')
          }))
        }))
        if (!questions.length) {
          this.respondRpcError(id, 'empty questions')
          return
        }
        const requestId = `cxq-${LAUNCH_TAG}-${++this.permCounter}`
        this.questionWaiters.set(requestId, { rpcId: id, qids: raw.map((q) => String(q.id ?? '')) })
        this.emit({ type: 'question-request', runId, requestId, questions, engine: 'codex' })
        return
      }
      default:
        // 다룰 수 없는 서버 요청(chatgptAuthTokens/refresh 등) — 거절해 서버가 폴백하게
        this.respondRpcError(id, `unsupported client request: ${method}`)
    }
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    const runId = this.activeRunId
    if (!runId) return
    // 다른 스레드의 알림 — 추적 중인 서브에이전트 스레드면 카드로 라우팅(메인 채팅
    // 오염 금지), 아니면 무시 (한 프로세스에 여러 스레드가 살 수 있다)
    const threadId = params.threadId as string | undefined
    if (threadId && this.activeThreadId && threadId !== this.activeThreadId) {
      if (this.cxAgents.has(threadId)) this.onAgentThreadNotification(runId, threadId, method, params)
      return
    }

    switch (method) {
      case 'item/agentMessage/delta': {
        this.markWorking()
        this.emit({ type: 'thinking-clear', runId })
        this.emit({ type: 'assistant-stream', runId, messageId: `cx${LAUNCH_TAG}-${params.itemId}`, delta: String(params.delta ?? '') })
        return
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        this.markWorking()
        this.thinkingBuf += String(params.delta ?? '')
        const tail = this.thinkingBuf.slice(-300)
        this.emit({ type: 'thinking', runId, text: oneLine(tail, 90) })
        return
      }
      case 'item/reasoning/summaryPartAdded': {
        this.thinkingBuf = ''
        return
      }
      case 'item/started': {
        this.markWorking()
        this.onItemStarted(runId, params.item as Record<string, unknown>)
        return
      }
      case 'item/completed': {
        this.onItemCompleted(runId, params.item as Record<string, unknown>)
        return
      }
      case 'item/commandExecution/outputDelta': {
        const itemId = String(params.itemId)
        // 백그라운드 터미널의 출력은 임시 파일로 — 렌더러 셸 카드가 이 파일을 1.2s
        // 폴링해 라이브 테일을 보여준다 (턴 종료 후에도 계속 흘러오는 것 실측)
        const bg = this.bgTerms.get(itemId)
        if (bg) {
          fs.appendFile(bg.outputFile, stripAnsi(String(params.delta ?? '')), () => {})
          return
        }
        const meta = this.items.get(itemId)
        if (meta) meta.output = ((meta.output ?? '') + String(params.delta ?? '')).slice(-8000)
        return
      }
      case 'turn/plan/updated': {
        const plan = (params.plan as { step: string; status: string }[]) ?? []
        const todos: Todo[] = plan.map((p, i) => ({
          id: `cxtodo-${i}`,
          label: p.step,
          status: p.status === 'completed' ? 'done' : p.status === 'inProgress' ? 'running' : 'pending'
        }))
        this.emit({ type: 'todos', runId, todos })
        return
      }
      case 'thread/tokenUsage/updated': {
        // last/total은 TokenUsageBreakdown(inputTokens·cachedInputTokens·outputTokens·
        // reasoningOutputTokens·totalTokens) — codex 0.144 generate-json-schema 실측
        type TokenBk = { totalTokens?: number; inputTokens?: number; cachedInputTokens?: number; outputTokens?: number }
        const usage = params.tokenUsage as {
          last?: TokenBk
          total?: TokenBk
          modelContextWindow?: number | null
        }
        const ctx = usage?.last?.totalTokens ?? usage?.total?.totalTokens ?? null
        if (typeof ctx === 'number') {
          this.lastCtxTokens = ctx
          this.emit({ type: 'context', runId, contextTokens: ctx })
        }
        if (typeof usage?.modelContextWindow === 'number') this.lastCtxWindow = usage.modelContextWindow
        // 스레드 누적 소모(입력에는 캐시 히트가 포함) — 턴 정착 때 델타로 접어 보고한다
        const tot = usage?.total
        if (tot) {
          this.usageTotal = { inTok: tot.inputTokens ?? 0, cached: tot.cachedInputTokens ?? 0, outTok: tot.outputTokens ?? 0 }
          if (this.usageBaseAdopt) {
            // 스레드 교체 후 첫 통지 — base = total − last (필드 주석 참고)
            this.usageBaseAdopt = false
            const l = usage?.last
            this.usageBase = {
              inTok: Math.max(0, this.usageTotal.inTok - (l?.inputTokens ?? 0)),
              cached: Math.max(0, this.usageTotal.cached - (l?.cachedInputTokens ?? 0)),
              outTok: Math.max(0, this.usageTotal.outTok - (l?.outputTokens ?? 0))
            }
          }
        }
        return
      }
      case 'turn/started': {
        // turn/start RPC 응답보다 먼저 파이프에 실리는 턴 개시 통지 — 응답 왕복을
        // 기다리는 사이 activeTurnId가 비는 창을 여기서 닫는다 (메인 스레드의 턴은
        // 전부 이 앱이 시작한 것이므로 채택해도 안전)
        const turn = params.turn as { id?: string } | undefined
        if (turn?.id && !this.activeTurnId) this.activeTurnId = turn.id
        return
      }
      case 'turn/completed': {
        const turn = params.turn as {
          id?: string
          status?: string
          error?: { message?: string; codexErrorInfo?: unknown } | null
          durationMs?: number | null
        }
        // 이미 마감한 턴의 늦은 통지(중단 캡 뒤 도착한 interrupted 등) — 시작 창에서
        // 받아주면 새 턴이 즉시 "응답 없이 끝났어요"로 정착하고 남은 스트림이 전부 버려진다
        if (turn?.id && this.endedTurnIds.has(turn.id)) return
        // 시작 창(activeTurnId 공백)에 도착한 id 달린 completed는 전부 잔재다 — 실측
        // 와이어 순서가 turn/start 응답(id) → turn/started → … → completed 라서, 우리
        // 턴의 completed는 채택(응답 또는 turn/started)보다 먼저 올 수 없다. id 없는
        // 프레임(비정형)만 종전처럼 도착 순서로 정착시킨다.
        if (!this.activeTurnId && turn?.id) return
        if (this.activeTurnId && turn?.id && turn.id !== this.activeTurnId) return
        void this.settleTurn(turn)
        return
      }
      case 'error': {
        // 마감한(또는 다른/아직 없는) 턴의 늦은 error 통지도 같은 이유로 걸러낸다 —
        // 시작 창에서 받아주면 새 실행이 이전 턴의 오류로 즉사한다. turn/start 자체의
        // 실패는 통지가 아니라 RPC 오류(run의 catch)로 온다.
        const errTurnId = typeof params.turnId === 'string' ? params.turnId : ''
        if (errTurnId && this.endedTurnIds.has(errTurnId)) return
        if (errTurnId && !this.activeTurnId) return
        if (errTurnId && this.activeTurnId && errTurnId !== this.activeTurnId) return
        const err = params.error as { message?: string; codexErrorInfo?: unknown } | undefined
        const willRetry = params.willRetry === true
        if (willRetry) {
          this.emit({ type: 'notice', runId, text: `Codex: ${err?.message ?? '일시적인 오류'} — 다시 시도하는 중이에요.` })
        } else if (isCapacityErr(err) && this.activeThreadId) {
          // 수용량 초과는 여기서 실행을 죽이지 않는다 — 같은 오류의 turn/completed
          // (failed)가 곧 따라오고(실측), settleTurn의 모델 전환 확인 카드가 잇는다
        } else {
          this.emit({ type: 'error', runId, message: err?.message ?? 'Codex 실행 오류' })
          this.finishRun('error')
        }
        return
      }
      default:
        return
    }
  }

  private onItemStarted(runId: string, item: Record<string, unknown> | undefined): void {
    if (!item) return
    const type = item.type as string
    const id = String(item.id ?? '')
    if (!id) return
    const start = (kind: ToolLogItem['kind'], verb: string, target: string): void => {
      this.items.set(id, { kind, startedAt: Date.now() })
      this.emit({ type: 'tool-start', runId, tool: { id, verb, kind, target, status: 'running' } })
    }
    switch (type) {
      case 'commandExecution':
        start('bash', 'Bash', String(item.command ?? ''))
        return
      case 'fileChange': {
        const changes = (item.changes as { path: string }[]) ?? []
        start('edit', 'Edit', changes.map((c) => c.path).join(', ') || '파일 변경')
        return
      }
      case 'mcpToolCall':
        start('mcp', String(item.tool ?? 'MCP'), `${item.server ?? ''}`)
        return
      case 'webSearch':
        // 검색어는 item/completed에만 실린다(실측: started는 query가 빈 문자열) —
        // 실행 중엔 자리 문구를 두고, 완료 처리가 tool-end.target으로 덮는다
        start('web', 'WebSearch', cxWebSearchTarget(item) || '검색 중…')
        return
      // Codex 서브에이전트(collab) — 도구 행이 아니라 Claude와 같은 서브에이전트
      // 칩/카드로. spawnAgent 콜이 오는 흐름은 카드를 여기서 만들고(receiverThreadIds[0]
      // =스폰된 스레드, prompt·model 동봉), 제어 호출(wait·sendInput·closeAgent…)은
      // 행/카드 없이 완료 시 agentsStates만 반영한다. 실측(0.144)에선 스폰이 이 콜 없이
      // subAgentActivity{kind:'started'}로만 오는 경우가 대부분 — 그쪽이 주 경로다.
      case 'collabAgentToolCall': {
        const tool = String(item.tool ?? '')
        const prompt = String((item as { prompt?: string }).prompt ?? '')
        const receivers = Array.isArray(item.receiverThreadIds) ? (item.receiverThreadIds as unknown[]).map(String) : []
        if (tool === 'spawnAgent' && receivers[0]) {
          const aid = receivers[0]
          if (!this.cxAgents.has(aid)) this.cxAgents.set(aid, { startedAt: Date.now() })
          this.cxCollabCalls.set(id, { tool, agents: [aid] })
          this.emit({
            type: 'subagent',
            runId,
            agent: {
              id: aid,
              name: 'Agent',
              role: oneLine(prompt, 40) || '서브에이전트',
              status: 'running',
              activity: oneLine(prompt, 200) || '작업 중',
              tools: [],
              model: item.model ? String(item.model) : undefined
            }
          })
        } else {
          this.cxCollabCalls.set(id, { tool, agents: receivers })
        }
        return
      }
      // 서브에이전트 수명 통지 (메인 스레드 아이템) — kind:'started'가 카드를 만든다
      case 'subAgentActivity':
        this.handleSubAgentActivity(runId, item)
        return
      default:
        return
    }
  }

  // subAgentActivity{kind, agentThreadId, agentPath} — item/started·completed 양쪽에서
  // 올 수 있어(실측: completed로만 온다) 공용 처리. started=카드 생성(이름은 agentPath
  // 마지막 조각), 종결 계열 kind면 완료 처리.
  private handleSubAgentActivity(runId: string, item: Record<string, unknown>): void {
    const aid = String((item as { agentThreadId?: string }).agentThreadId ?? '')
    if (!aid) return
    const kind = String((item as { kind?: string }).kind ?? '')
    if (kind === 'started') {
      if (this.cxAgents.has(aid)) return
      this.cxAgents.set(aid, { startedAt: Date.now() })
      const name = String((item as { agentPath?: string }).agentPath ?? '').split('/').filter(Boolean).pop() || 'Agent'
      this.emit({
        type: 'subagent',
        runId,
        agent: { id: aid, name, role: '서브에이전트', status: 'running', activity: '작업 중', tools: [] }
      })
      return
    }
    if (/clos|end|stop|shutdown|interrupt/i.test(kind)) {
      const meta = this.cxAgents.get(aid)
      if (!meta || meta.done) return
      meta.done = true
      this.emit({
        type: 'subagent',
        runId,
        agent: { id: aid, name: '', role: '', status: 'done', activity: '', tools: [], durationMs: Date.now() - meta.startedAt }
      })
    }
  }

  // 서브에이전트 스레드의 프레임 — 카드로만 흘린다 (메인 말풍선·생각줄·도구 행 오염
  // 금지, Claude 사이드체인 분리와 같은 규칙). 도구 계열 아이템은 parentToolId로 카드의
  // '도구 사용' 목록에, 답변·생각은 activity 줄로, 턴 완료가 곧 작업 완료(+소요).
  private onAgentThreadNotification(runId: string, aid: string, method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'turn/started': {
        // sendInput 등으로 턴이 다시 돌면 완료됐던 카드도 실행 중으로 복귀
        const meta = this.cxAgents.get(aid)
        if (meta) meta.done = false
        this.emit({
          type: 'subagent',
          runId,
          agent: { id: aid, name: '', role: '', status: 'running', activity: '', tools: [] }
        })
        return
      }
      case 'item/started': {
        const item = params.item as Record<string, unknown> | undefined
        if (!item) return
        const type = String(item.type ?? '')
        const id = String(item.id ?? '')
        if (!id) return
        const tool = (kind: ToolLogItem['kind'], verb: string, target: string): void => {
          this.items.set(id, { kind, startedAt: Date.now() })
          this.emit({ type: 'tool-start', runId, tool: { id, verb, kind, target, status: 'running', parentToolId: aid } })
        }
        if (type === 'commandExecution') tool('bash', 'Bash', oneLine(String(item.command ?? ''), 200))
        else if (type === 'fileChange') {
          const changes = (item.changes as { path: string }[]) ?? []
          tool('edit', 'Edit', changes.map((c) => c.path).join(', ') || '파일 변경')
        } else if (type === 'webSearch') tool('web', 'WebSearch', cxWebSearchTarget(item) || '검색 중…')
        else if (type === 'mcpToolCall') tool('mcp', String(item.tool ?? 'MCP'), String(item.server ?? ''))
        return
      }
      case 'item/completed': {
        const item = params.item as Record<string, unknown> | undefined
        if (!item) return
        const id = String(item.id ?? '')
        const meta = this.items.get(id)
        if (meta) {
          const type = String(item.type ?? '')
          const failed =
            type === 'commandExecution'
              ? (item.exitCode as number | null) !== 0
              : /fail|declin/i.test(String(item.status ?? ''))
          // webSearch의 검색어는 완료에만 실린다 — 카드 도구 줄의 자리 문구를 덮는다
          const target = type === 'webSearch' ? cxWebSearchTarget(item) : undefined
          this.emit({
            type: 'tool-end',
            runId,
            id,
            status: failed ? 'error' : 'done',
            durationMs: (item.durationMs as number | null) ?? Date.now() - meta.startedAt,
            ...(target ? { target } : {})
          })
          this.items.delete(id)
          return
        }
        // 도구가 아닌 활동(답변·생각 요약)은 카드 activity 줄로
        const line = cxActivityLine(item)
        if (line) {
          this.emit({
            type: 'subagent',
            runId,
            agent: { id: aid, name: '', role: '', status: 'running', activity: line, tools: [] }
          })
        }
        return
      }
      case 'turn/completed': {
        const turn = params.turn as { durationMs?: number | null } | undefined
        const meta = this.cxAgents.get(aid)
        if (meta) meta.done = true
        this.emit({
          type: 'subagent',
          runId,
          agent: {
            id: aid,
            name: '',
            role: '',
            status: 'done',
            activity: '',
            tools: [],
            durationMs: turn?.durationMs ?? (meta ? Date.now() - meta.startedAt : undefined)
          }
        })
        return
      }
      default:
        return
    }
  }

  private onItemCompleted(runId: string, item: Record<string, unknown> | undefined): void {
    if (!item) return
    const type = item.type as string
    const id = String(item.id ?? '')
    switch (type) {
      case 'agentMessage': {
        this.emit({ type: 'assistant-done', runId, messageId: `cx${LAUNCH_TAG}-${id}`, text: String(item.text ?? '') })
        return
      }
      case 'reasoning': {
        this.thinkingBuf = ''
        return
      }
      case 'commandExecution': {
        // 백그라운드 터미널로 넘어간 명령 — 도구 행은 이미 '백그라운드로 전환'으로
        // 닫혔고, 이 완료는 프로세스의 실제 종말(자연 종료/중지)이라 칩 쪽에 정착시킨다
        const bg = this.bgTerms.get(id)
        if (bg) {
          this.bgTerms.delete(id)
          this.bgByProcess.delete(bg.processId)
          const exit = item.exitCode as number | null
          // 자연 종료면 행도 되살린다 — 완료 아이템이 전체 출력(aggregatedOutput)을
          // 들고 오므로(실측 0.144.4: yield/폴링과 무관) '백그라운드로 전환'으로 일찍
          // 닫혔던 행에 최종 출력·실제 소요·성패를 정착시켜 로그를 클릭해 볼 수 있게.
          // 중지(user/turnEnd)는 제외 — 그 사연은 칩이 표기하고 행은 전환 표시를 유지.
          const output = String(item.aggregatedOutput ?? '')
          if (!bg.stopped && output) {
            this.emit({
              type: 'tool-end',
              runId,
              id,
              status: exit === 0 ? 'done' : 'error',
              result: exit === 0 ? undefined : `exit ${exit ?? '?'}`,
              output: output.slice(-8000),
              durationMs: (item.durationMs as number | null) ?? Date.now() - bg.startedAt
            })
          }
          this.emit({
            type: 'bg-task-end',
            runId,
            id: bg.processId,
            // 우리가 죽인 프로세스는 exit -1 + status failed로 오므로(실측) 중지로 읽는다
            status: bg.stopped ? 'stopped' : exit === 0 ? 'completed' : 'failed',
            summary: bg.stopped ? undefined : `exit ${exit ?? '?'}`,
            outputFile: bg.outputFile,
            atTurnEnd: bg.stopped === 'turnEnd' || undefined,
            byUser: bg.stopped === 'user' || undefined
          })
          return
        }
        const meta = this.items.get(id)
        const exit = item.exitCode as number | null
        const ok = exit === 0
        const durationMs = (item.durationMs as number | null) ?? (meta ? Date.now() - meta.startedAt : undefined) ?? undefined
        const output = String(item.aggregatedOutput ?? meta?.output ?? '')
        this.emit({
          type: 'tool-end',
          runId,
          id,
          status: ok ? 'done' : 'error',
          result: ok ? undefined : `exit ${exit ?? '?'}`,
          output: output ? output.slice(-8000) : undefined,
          durationMs
        })
        this.items.delete(id)
        return
      }
      case 'fileChange': {
        const meta = this.items.get(id)
        const status = String(item.status ?? '')
        const changes = (item.changes as { path: string; kind: { type: string }; diff: string }[]) ?? []
        const failed = status === 'failed' || status === 'declined'
        this.emit({
          type: 'tool-end',
          runId,
          id,
          status: failed ? 'error' : 'done',
          result: failed ? '적용 안 됨' : undefined,
          durationMs: meta ? Date.now() - meta.startedAt : undefined
        })
        if (!failed) {
          const watched: { abs: string; kind: 'created' | 'changed' | 'deleted' }[] = []
          for (const ch of changes) {
            const kind = ch.kind?.type
            // 실측: add/delete는 diff 필드에 파일 '원문'이 그대로 온다(접두사 없음) —
            // 전 줄을 추가/삭제로 취급. update만 진짜 unified diff.
            let lines: DiffLine[]
            let add = 0
            let del = 0
            if (kind === 'add' || kind === 'delete') {
              const t = (ch.diff ?? '').replace(/\n$/, '')
              const raw = t ? t.split('\n') : []
              lines = raw.map((text) => ({ t: kind === 'add' ? 'add' : 'del', text }))
              if (kind === 'add') add = lines.length
              else del = lines.length
            } else {
              ;({ lines, add, del } = parseUnifiedDiff(ch.diff ?? ''))
            }
            // 렌더러(변경 파일 칩·뷰어)는 워크스페이스 상대 경로를 기대한다 — cwd 아래면 상대화
            let p = ch.path
            if (this.activeCwd) {
              const rel = path.relative(this.activeCwd, ch.path)
              if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) p = rel
            }
            const file: ChangedFile = { path: p.replace(/\\/g, '/'), add, del, tag: kind === 'add' ? 'new' : 'edit' }
            const diff: FileDiff = { path: file.path, tag: file.tag, add, del, lines }
            // 새 파일/전체 갱신은 whole=true — 누적 diff를 대체
            this.emit({ type: 'file-change', runId, file, diff, whole: kind === 'add' })
            const abs = path.isAbsolute(ch.path) ? ch.path : this.activeCwd ? path.join(this.activeCwd, ch.path) : ''
            if (abs) watched.push({ abs, kind: kind === 'add' ? 'created' : kind === 'delete' ? 'deleted' : 'changed' })
          }
          // 살아있는 LSP 서버들에도 디스크 변화를 통지 — Claude 엔진의 Write/Edit 경로와 같은
          // 배선(C# 재프라임 예약 + 열린 뷰어 재폴링 깨우기; 역할 분담은 notifyWatchedFiles 주석).
          // 이게 없으면 GPT가 만든 새 파일/타입이 열린 C# 문서들에서 재열람 전까지 무색으로 남는다.
          if (watched.length) lspManager.notifyWatchedFiles(watched)
        }
        this.items.delete(id)
        return
      }
      case 'mcpToolCall':
      case 'webSearch': {
        if (!this.items.has(id)) return
        const meta = this.items.get(id)
        const failed = String(item.status ?? '').toLowerCase().includes('fail')
        // webSearch의 검색어는 여기(완료)에만 실린다 — 행의 자리 문구를 실제 검색어로 덮는다
        const target = type === 'webSearch' ? cxWebSearchTarget(item) : undefined
        this.emit({
          type: 'tool-end',
          runId,
          id,
          status: failed ? 'error' : 'done',
          durationMs: meta ? Date.now() - meta.startedAt : undefined,
          ...(target ? { target } : {})
        })
        this.items.delete(id)
        return
      }
      // collab 호출 완료 — 스폰 자체는 접수 완료일 뿐 에이전트는 계속 산다. 대상
      // 에이전트의 종결은 agentsStates(스레드 id → 상태)나 closeAgent가 알려준다.
      case 'collabAgentToolCall': {
        const call = this.cxCollabCalls.get(id)
        this.cxCollabCalls.delete(id)
        if (!call) return
        const states = (item.agentsStates ?? {}) as Record<string, unknown>
        for (const aid of new Set([...call.agents, ...Object.keys(states)])) {
          const st = String(states[aid] ?? '')
          const ended = call.tool === 'closeAgent' || /completed|errored|shutdown|closed|notfound/i.test(st)
          const meta = this.cxAgents.get(aid)
          if (!ended || !meta || meta.done) continue
          meta.done = true
          this.emit({
            type: 'subagent',
            runId,
            agent: {
              id: aid,
              name: '',
              role: '',
              status: 'done',
              // 활동 줄은 비워 마지막 답변/작업 줄을 남긴다 (빈 값은 reducer가 안 덮음)
              activity: /error/i.test(st) ? '실패' : '',
              tools: [],
              durationMs: Date.now() - meta.startedAt
            }
          })
        }
        return
      }
      case 'subAgentActivity':
        // 수명 통지(kind:'started' 등)는 실측상 completed로만 온다 — started와 공용 처리
        this.handleSubAgentActivity(runId, item)
        return
      default:
        return
    }
  }

  // ── 백그라운드 터미널 (unified exec) ─────────────────────────
  // 푸시 알림이 없어 실행 중 5초 폴링 — 새로 등록된 터미널은 도구 행을 '백그라운드로
  // 전환'으로 닫고(스피너가 턴 끝까지 도는 것 방지) 셸 칩(bg-tasks REPLACE)이 이어받는다.
  private async pollBgTerminals(): Promise<void> {
    const runId = this.activeRunId
    const threadId = this.activeThreadId
    if (!runId || !threadId) return
    let res: { data?: Array<Record<string, unknown>> } | undefined
    try {
      res = await this.request('thread/backgroundTerminals/list', { threadId })
    } catch {
      return // 폴링 실패는 다음 틱에 다시 — 소음 내지 않는다
    }
    if (this.activeRunId !== runId) return // 기다리는 사이 턴이 끝남 — finishRun이 정리했다
    let changed = false
    for (const t of res?.data ?? []) {
      const itemId = String(t.itemId ?? '')
      const pid = String(t.processId ?? '')
      if (!itemId || !pid || this.bgTerms.has(itemId)) continue
      changed = true
      const meta = this.items.get(itemId)
      const outputFile = path.join(os.tmpdir(), `ccg-codex-term-${pid.replace(/[^\w-]/g, '_')}.log`)
      try {
        fs.writeFileSync(outputFile, stripAnsi(meta?.output ?? '')) // 전환 전까지 쌓인 출력으로 시작
      } catch {
        /* 테일만 빈다 — 추적은 계속 */
      }
      this.bgTerms.set(itemId, { processId: pid, command: String(t.command ?? ''), outputFile, startedAt: meta?.startedAt ?? Date.now() })
      this.bgByProcess.set(pid, itemId)
      if (meta) {
        this.emit({ type: 'tool-end', runId, id: itemId, status: 'done', result: '백그라운드로 전환', durationMs: Date.now() - meta.startedAt })
        this.items.delete(itemId)
      }
    }
    if (changed) this.emitBgTasks(runId)
  }

  /** 살아있는 백그라운드 터미널의 REPLACE — Claude의 background_tasks_changed 미러와 동형 */
  private emitBgTasks(runId: string): void {
    const tasks = [...this.bgTerms.values()]
      .filter((t) => !t.stopped)
      .map((t) => ({ id: t.processId, kind: 'unified_exec', description: oneLine(t.command, 120), outputFile: t.outputFile }))
    this.emit({ type: 'bg-tasks', runId, tasks })
  }

  // 턴 정착 — result 전에 백그라운드 터미널 막차 폴링. 실측상 터미널 등록(도구가
  // ~10초에 백그라운드로 반환)과 모델의 마지막 답 사이가 ~1초라, 5초 폴링만으로는
  // 방금 등록된 터미널을 놓친 채 턴이 끝날 수 있다(그러면 도구 행이 영영 스피너).
  private async settleTurn(
    turn: { status?: string; error?: { message?: string; codexErrorInfo?: unknown } | null; durationMs?: number | null } | undefined
  ): Promise<void> {
    const runId = this.activeRunId
    if (!runId) return
    try {
      await this.pollBgTerminals()
    } catch {
      /* 정착은 계속 */
    }
    if (this.activeRunId !== runId) return // 기다리는 사이 cancel 등으로 이미 정리됨
    const failed = turn?.status === 'failed'
    // 수용량 초과 실패는 결과로 정착하지 않는다 — 다른 모델로 전환해 같은 턴을 다시
    // 시도할지 물어보고(질문 카드), 수락하면 이 실행이 그대로 이어진다
    if (failed && isCapacityErr(turn?.error)) {
      // 재시도 확인을 기다리는 동안(activeTurnId 공백) 같은 실패 턴의 중복 통지가
      // 오면 확인 카드가 겹으로 뜬다 — 실패 턴을 지금 마감 목록에 올린다
      if (this.activeTurnId) {
        this.endedTurnIds.add(this.activeTurnId)
        this.activeTurnId = null
      }
      void this.askCapacityFallback(runId)
      return
    }
    const interrupted = turn?.status === 'interrupted'
    this.emit({ type: 'thinking-clear', runId })
    // 이 턴이 소모한 실측 토큰 — 스레드 누적(total)의 정착 간 델타. inputTokens에는
    // 캐시 히트(cachedInputTokens)가 포함돼 있어 비캐시/캐시로 갈라 보고한다(캐시 쓰기
    // 구분은 Codex가 보고하지 않아 0). 수용량 전환으로 턴 중간에 모델이 바뀐 경우는
    // 최종 모델로 귀속된다(전환 전 소모를 가를 신호가 와이어에 없다 — 드문 경우라 수용).
    const dIn = Math.max(0, this.usageTotal.inTok - this.usageBase.inTok)
    const dCached = Math.max(0, this.usageTotal.cached - this.usageBase.cached)
    const dOut = Math.max(0, this.usageTotal.outTok - this.usageBase.outTok)
    this.usageBase = { ...this.usageTotal }
    const tokenUsage =
      dIn + dOut > 0
        ? [{ model: this.activeModel, inTok: Math.max(0, dIn - dCached), outTok: dOut, cacheRead: dCached, cacheWrite: 0 }]
        : []
    this.emit({
      type: 'result',
      runId,
      isError: failed,
      text: failed ? turn?.error?.message ?? '실행이 실패했어요' : interrupted ? '중단됨' : '',
      costUsd: null,
      // 서버가 durationMs를 안 주면 turn/start 시각으로 계산 — '작업함' 줄이 Codex에서도 뜬다
      durationMs: turn?.durationMs ?? (this.turnStartedAt ? Date.now() - this.turnStartedAt : null),
      numTurns: 1,
      contextTokens: this.lastCtxTokens,
      contextWindow: this.lastCtxWindow,
      viaApi: false,
      tokenUsage
    })
    this.finishRun(failed ? 'error' : 'done')
  }

  // ── 수용량 초과 복구 — 모델 전환 확인 카드 ───────────────────
  // "Selected model is at capacity"로 턴이 죽으면, 그대로 두는 한 다른 모델을 고르기
  // 전까지 매 메시지가 같은 오류로 죽는다. Claude의 거부 폴백과 같은 질문 카드로
  // 물어보고, 수락하면 같은 스레드에 방금 프롬프트를 다른 모델로 다시 보낸다.
  // picker는 model-fallback 이벤트(engine:'codex')로 따라와 이후 턴도 그 모델로 간다.
  private async askCapacityFallback(runId: string): Promise<void> {
    const from = this.activeModel
    this.triedModels.add(from)
    let models: CodexModelInfo[] = []
    try {
      models = await this.listModels()
    } catch {
      /* 목록 실패 — 정적 사다리로 */
    }
    const ladder = models.length ? models : CAPACITY_LADDER
    const label = (id: string): string => ladder.find((m) => m.id === id)?.label ?? id
    // 전환 후보: 서버 기본 모델 우선, 나머지는 목록 순서 — 이번 실행에서 실패한 모델 제외
    const def = models.find((m) => m.isDefault)?.id
    const ids = ladder.map((m) => m.id)
    const to = (def ? [def, ...ids.filter((i) => i !== def)] : ids).find((id) => !this.triedModels.has(id))
    if (this.activeRunId !== runId) return // 목록을 기다리는 사이 정리됨
    if (!to) {
      this.emit({ type: 'error', runId, message: `${label(from)} 모델이 수용량 한계로 응답하지 못했어요. 잠시 후 다시 시도해 주세요.` })
      this.finishRun('error')
      return
    }
    this.emit({ type: 'thinking-clear', runId })
    const contLabel = `${label(to)}로 전환해 다시 시도`
    const requestId = `cxcap-${LAUNCH_TAG}-${++this.permCounter}`
    const answers = await new Promise<string[][] | null>((resolve) => {
      this.localQuestionWaiters.set(requestId, resolve)
      this.emit({
        type: 'question-request',
        runId,
        requestId,
        engine: 'codex',
        questions: [
          {
            question: `${label(from)} 모델이 지금 수용량 한계예요(요청이 몰리고 있어요). ${label(to)} 모델로 전환해 다시 시도할까요?`,
            header: '모델 전환',
            multiSelect: false,
            options: [
              { label: contLabel, description: `방금 요청을 ${label(to)}로 다시 보내고, 이후 대화도 ${label(to)}로 진행합니다.` },
              { label: '중단', description: '전환하지 않고 여기서 끝냅니다. 잠시 후 같은 모델로 다시 보낼 수 있어요.' }
            ]
          }
        ]
      })
    })
    if (this.activeRunId !== runId) return // 답을 기다리는 사이 취소로 정리됨(카드는 null로 풀림)
    if (answers?.[0]?.[0] !== contLabel) {
      // 중단 선택 또는 카드 닫음 — 턴은 이미 서버에서 죽었으니 오류로 정착
      this.emit({
        type: 'error',
        runId,
        message: `${label(from)} 모델이 수용량 한계로 응답하지 못했어요. 잠시 후 다시 시도하거나 다른 모델을 선택해 주세요.`
      })
      this.finishRun('error')
      return
    }
    this.activeModel = to
    this.emit({
      type: 'model-fallback',
      runId,
      fromModel: from,
      toModel: to,
      engine: 'codex',
      text: `${label(from)} 모델이 수용량 한계라 ${label(to)}로 전환해 다시 시도해요. 이후 대화도 ${label(to)} 모델로 진행됩니다.`,
      retractMessageId: null // 수용량 초과는 요청 단계 실패 — 지울 부분 답변이 없다
    })
    try {
      const effort = codexEffort(this.activeEffort, models.find((m) => m.id === to)?.efforts ?? null)
      this.turnStartedAt = Date.now()
      const turn = await this.request<{ turn?: { id?: string } } | Record<string, unknown>>('turn/start', {
        threadId: this.activeThreadId,
        input: [{ type: 'text', text: this.activePrompt, text_elements: [] }],
        model: to,
        effort
      })
      const turnObj = turn as { turn?: { id?: string }; id?: string }
      // 응답을 기다리는 사이 turn/started가 먼저 채택했으면 보존, 실행이 이미 마감됐으면
      // id를 부활시키지 않는다(다음 실행이 엉뚱한 mismatch로 통지를 버리게 된다)
      if (this.activeRunId === runId)
        this.activeTurnId = turnObj?.turn?.id ?? (typeof turnObj?.id === 'string' ? turnObj.id : this.activeTurnId)
      // 헤더의 모델 표기 동기화 — 스레드는 그대로, 모델만 바뀌었다
      this.emit({ type: 'session', runId, sessionId: this.activeThreadId ?? '', model: to, cwd: this.activeCwd, tools: [] })
      // 첫 turn/start가 거절돼 폴링이 시작 전이면 여기서 — 재시도 턴도 셸 추적을 받게
      if (!this.bgPollTimer) this.bgPollTimer = setInterval(() => void this.pollBgTerminals(), 5000)
      // 이후는 평소처럼 알림 스트림이 끌고 간다 (turn/completed → result → finishRun)
    } catch (e) {
      if (this.activeRunId !== runId) return
      const msg = (e as Error)?.message ?? ''
      if (isCapacityErr({ message: msg })) {
        // 전환한 모델도 수용량 초과 — 남은 후보로 한 번 더 물어본다 (triedModels가 상한)
        void this.askCapacityFallback(runId)
        return
      }
      this.emit({ type: 'error', runId, message: msg || 'Codex 실행을 다시 시작하지 못했어요' })
      this.finishRun('error')
    }
  }

  private markWorking(): void {
    if (this.sawActivity || !this.activeRunId) return
    this.sawActivity = true
    this.emit({ type: 'status', runId: this.activeRunId, status: 'working' })
  }

  private finishRun(status: 'done' | 'error'): void {
    const runId = this.activeRunId
    if (!runId) return
    // 백그라운드 터미널 수명 통일(유저 결정) — Codex 터미널은 턴을 넘어 살 수 있지만
    // Claude 셸 규칙(턴 종료와 함께 정리)에 맞춘다. terminate는 fire-and-forget,
    // 칩은 여기서 즉시 정착(activeRunId가 곧 비므로 늦은 item/completed는 버려진다).
    if (this.bgPollTimer) {
      clearInterval(this.bgPollTimer)
      this.bgPollTimer = null
    }
    const threadId = this.activeThreadId
    for (const bg of this.bgTerms.values()) {
      // 직접 중지했는데 완료 통지가 아직인 항목도 여기서 정착 — 안 그러면 칩이 영영 스피너
      const byUser = bg.stopped === 'user'
      if (!bg.stopped) {
        bg.stopped = 'turnEnd'
        if (threadId) this.request('thread/backgroundTerminals/terminate', { threadId, processId: bg.processId }).catch(() => {})
      }
      this.emit({
        type: 'bg-task-end',
        runId,
        id: bg.processId,
        status: 'stopped',
        outputFile: bg.outputFile,
        atTurnEnd: !byUser || undefined,
        byUser: byUser || undefined
      })
    }
    this.bgTerms.clear()
    this.bgByProcess.clear()
    // 잔여 스윕(수명 통일 보험) — 취소 등으로 등록(~10초) 전에 턴이 끊긴 세션이
    // 뒤늦게 터미널로 등록되면 다음 턴의 칩으로 둔갑한다. 잠시 뒤 스레드째 정리.
    // (죽은 app-server를 스윕 때문에 되살리지 않게 프로세스 생존 가드)
    if (threadId) {
      setTimeout(() => {
        if (!this.proc || this.proc.exitCode !== null) return
        this.request<{ data?: Array<{ processId?: unknown }> }>('thread/backgroundTerminals/list', { threadId })
          .then((r) => {
            for (const t of r?.data ?? []) {
              const pid = String(t.processId ?? '')
              if (pid) this.request('thread/backgroundTerminals/terminate', { threadId, processId: pid }).catch(() => {})
            }
          })
          .catch(() => {})
      }, 2500)
    }
    // 종결 통지를 못 받은 서브에이전트만 정리 (Claude 엔진과 동일 규칙) — 이미 완료된
    // 카드에 또 emit하면 마지막 답변 줄이 '턴 종료로 정리됨'으로 덮인다
    for (const [aid, meta] of this.cxAgents) {
      if (meta.done) continue
      this.emit({
        type: 'subagent',
        runId,
        agent: {
          id: aid,
          name: '',
          role: '',
          status: 'done',
          activity: '턴 종료로 정리됨',
          tools: [],
          durationMs: Date.now() - meta.startedAt
        }
      })
    }
    this.cxAgents.clear()
    this.cxCollabCalls.clear()
    this.emit({ type: 'status', runId, status })
    this.activeRunId = null
    // 마감한 턴 id를 기억 — 늦은 turn/completed·error 통지가 다음 실행의 시작 창에서
    // 새 턴으로 둔갑하지 못하게 한다 (통지는 다음 턴 언저리에만 오므로 최근 몇 개면 충분)
    if (this.activeTurnId) {
      this.endedTurnIds.add(this.activeTurnId)
      if (this.endedTurnIds.size > 8) this.endedTurnIds.delete(this.endedTurnIds.values().next().value!)
    }
    this.activeTurnId = null
    this.sawActivity = false
    this.turnDone?.resolve()
    this.turnDone = null
    // 답을 기다리던 승인/질문 카드는 거절로 정리
    for (const [, w] of this.permWaiters) this.respondRpcError(w.rpcId, 'run ended')
    this.permWaiters.clear()
    for (const [, w] of this.questionWaiters) this.respondRpcError(w.rpcId, 'run ended')
    this.questionWaiters.clear()
    // 수용량 전환 확인 카드도 정리 — null로 풀면 ask 흐름이 runId 가드로 조용히 끝난다
    for (const [, resolve] of this.localQuestionWaiters) resolve(null)
    this.localQuestionWaiters.clear()
    // CLI가 계정 폴더에서 리프레시한 auth.json을 암호화 백업에 되쓴다
    if (this.activeAccountEmail) {
      try {
        syncCodexAccount(this.activeAccountEmail)
      } catch {
        /* ignore */
      }
      this.activeAccountEmail = null
    }
  }

  // ── 공개 계약 (ClaudeEngine과 동일) ──────────────────────────
  respondPermission(res: PermissionResponse): void {
    const w = this.permWaiters.get(res.requestId)
    if (!w) return
    this.permWaiters.delete(res.requestId)
    const allow = res.behavior === 'allow' || res.behavior === 'allow_always'
    const always = res.behavior === 'allow_always'
    if (w.kind === 'command' || w.kind === 'file') {
      this.respondRpc(w.rpcId, { decision: allow ? (always ? 'acceptForSession' : 'accept') : 'decline' })
    } else {
      // legacy applyPatchApproval/execCommandApproval — ReviewDecision 값 체계
      this.respondRpc(w.rpcId, { decision: allow ? (always ? 'approved_for_session' : 'approved') : 'denied' })
    }
  }

  respondQuestion(res: QuestionResponse): void {
    // 앱 자체 질문(수용량 전환 확인) — 서버 rpc가 없으니 로컬 waiter로 푼다
    const local = this.localQuestionWaiters.get(res.requestId)
    if (local) {
      this.localQuestionWaiters.delete(res.requestId)
      local(res.answers)
      return
    }
    const w = this.questionWaiters.get(res.requestId)
    if (!w) return // 다른 엔진의 requestId — 조용히 무시 (라우터가 양쪽에 배달한다)
    this.questionWaiters.delete(res.requestId)
    if (!res.answers) {
      // 건너뛰기 — 오류로 풀면 도구 호출만 실패하고 턴은 이어진다 (실측: 모델이
      // "응답을 받지 못했다"로 인지하고 진행)
      this.respondRpcError(w.rpcId, 'user dismissed the question without answering')
      return
    }
    const answers: Record<string, { answers: string[] }> = {}
    w.qids.forEach((qid, i) => {
      answers[qid] = { answers: res.answers?.[i] ?? [] }
    })
    this.respondRpc(w.rpcId, { answers })
  }

  // 셸 칩의 중지 버튼 — backgroundTerminals/terminate. 정착(bg-task-end)은 곧바로
  // 뒤따르는 item/completed(exit -1)가 bg 분기에서 처리한다(실측 ~100ms).
  // 'background'(Ctrl+B 패리티)는 Codex에 대응 API가 없다 — unified exec이 ~60초쯤
  // 알아서 백그라운드로 넘기므로 no-op.
  async bgTask(req: BgTaskRequest): Promise<void> {
    if (req.action !== 'stop' || !req.id) return
    const itemId = this.bgByProcess.get(req.id)
    const bg = itemId ? this.bgTerms.get(itemId) : undefined
    if (!bg || bg.stopped || !this.activeThreadId) return
    bg.stopped = 'user'
    try {
      await this.request('thread/backgroundTerminals/terminate', { threadId: this.activeThreadId, processId: bg.processId })
    } catch {
      /* 이미 죽었으면 item/completed가 알아서 정착 */
    }
  }

  async cancel(): Promise<void> {
    if (this.activeThreadId && this.activeTurnId) {
      try {
        await this.request('turn/interrupt', { threadId: this.activeThreadId, turnId: this.activeTurnId })
      } catch {
        /* 이미 끝났으면 무시 */
      }
    }
    // interrupt는 turn/completed(status interrupted)로 정착한다 — 잠깐 기다리되,
    // 프로세스가 죽어 통지가 없으면 그냥 정리한다.
    if (this.activeRunId) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          if (this.activeRunId) this.finishRun('done')
          resolve()
        }, 3000)
        this.turnDone = {
          resolve: () => {
            clearTimeout(t)
            resolve()
          }
        }
      })
    }
  }

  /** 설정/엔진 picker용 모델 목록 — app-server의 model/list (5분 캐시). */
  async listModels(): Promise<CodexModelInfo[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < 300_000) return this.modelCache.models
    // 프로세스가 아직 없으면 기본 계정의 CODEX_HOME으로 띄운다 (모델 목록도 인증 필요)
    if (!this.proc || this.proc.exitCode !== null) {
      const email = codexDefaultAccountEmail()
      if (email) {
        try {
          this.setHome(codexAccountRunDir(email))
        } catch {
          /* 물질화 실패 — 전역 없이 뜨면 목록만 빌 뿐 */
        }
      }
    }
    await this.ensureInitialized()
    const res = await this.request<{ data: Array<Record<string, unknown>> }>('model/list', {})
    const models: CodexModelInfo[] = (res?.data ?? [])
      .filter((m) => !m.hidden)
      .map((m) => ({
        id: String(m.id),
        label: String(m.displayName ?? m.model ?? m.id),
        desc: String(m.description ?? ''),
        efforts: ((m.supportedReasoningEfforts as { reasoningEffort: string }[]) ?? []).map((e) => e.reasoningEffort),
        defaultEffort: String(m.defaultReasoningEffort ?? 'medium'),
        isDefault: m.isDefault === true
      }))
    if (models.length) this.modelCache = { at: Date.now(), models }
    else if (this.modelCache) return this.modelCache.models // 갱신이 빈 목록 — 이전 목록 유지
    return models
  }

  /** Start a run. Returns the runId; events stream via `emit`. */
  async run(req: RunRequest): Promise<string> {
    if (this.isRunning) await this.cancel()

    const runId = nextRunId()
    this.activeRunId = runId
    this.activeTurnId = null // 잔재 보험 — 스테일 id가 새 턴의 통지를 mismatch로 버리지 않게
    this.sawActivity = false
    this.items.clear()
    this.cxAgents.clear()
    this.cxCollabCalls.clear()
    this.bgTerms.clear()
    this.bgByProcess.clear()
    this.thinkingBuf = ''
    this.emit({ type: 'status', runId, status: 'analyzing' })

    const cwd = req.cwd && req.cwd.trim() ? req.cwd : path.join(os.homedir(), 'Desktop')
    this.activeCwd = cwd
    const { approvalPolicy, sandbox } = codexPolicy(req.mode)
    const model = req.codexModel || 'gpt-5.6-terra'
    // 수용량 초과 재시도(askCapacityFallback)가 같은 턴을 다시 보낼 수 있게 원본 보관
    this.activeModel = model
    this.activePrompt = req.prompt
    this.activeEffort = req.effort
    this.triedModels.clear()

    try {
      if (req.useApi) {
        // API 모드 — 구독 계정 대신 저장된 OpenAI API 키 홈으로 app-server를 띄운다.
        // 계정 동기화(syncCodexAccount) 대상이 아니므로 activeAccountEmail은 비운다.
        const apiKey = getOpenaiApiKey()
        if (!apiKey) {
          throw new Error(
            'API 모드가 켜져 있지만 저장된 OpenAI API 키가 없어요 — 설정 → API에서 키를 등록하거나 컴포저의 API 토글을 꺼 주세요.'
          )
        }
        this.activeAccountEmail = null
        this.setHome(codexApiKeyRunDir(apiKey))
      } else {
        // 이 실행이 소비할 계정 — 채팅 바인딩(codexAccount), 미지정이면 기본 계정.
        // 그 계정의 격리 CODEX_HOME으로 app-server를 띄운다(계정이 바뀌면 재기동).
        const email = req.codexAccount ?? codexDefaultAccountEmail()
        if (!email) {
          throw new Error('등록된 OpenAI 계정이 없어요 — 설정 → Account에서 로그인해 주세요.')
        }
        this.activeAccountEmail = email
        this.setHome(codexAccountRunDir(email))
      }

      await this.ensureInitialized()

      // effort는 모델이 지원하는 범위로 강등 (모델 목록은 best effort)
      let efforts: string[] | null = null
      try {
        const models = await this.listModels()
        efforts = models.find((m) => m.id === model)?.efforts ?? null
      } catch {
        /* 목록 실패 — 그대로 전달 */
      }
      const effort = codexEffort(req.effort, efforts)

      // 스레드 시작/재개 — resume에는 이 앱이 준 threadId가 들어온다
      let threadId: string
      if (req.resume && req.resume.trim()) {
        const r = await this.request<{ thread?: { id?: string } }>('thread/resume', {
          threadId: req.resume,
          cwd,
          model,
          approvalPolicy,
          sandbox,
          config: THREAD_CONFIG,
          ...(req.systemPrompt ? { developerInstructions: req.systemPrompt } : {})
        })
        threadId = r?.thread?.id ?? req.resume
      } else {
        const r = await this.request<{ thread?: { id?: string } }>('thread/start', {
          cwd,
          model,
          approvalPolicy,
          sandbox,
          config: THREAD_CONFIG,
          ...(req.systemPrompt ? { developerInstructions: req.systemPrompt } : {})
        })
        threadId = r?.thread?.id ?? ''
        if (!threadId) throw new Error('thread/start가 스레드 id를 주지 않았어요')
      }
      this.activeThreadId = threadId
      // 토큰 누적 베이스 — 다른 스레드로 갈아탔으면 서버 카운터가 이어지지 않으므로
      // 리셋하고, 첫 통지에서 base를 채택한다(usageBaseAdopt — 필드 주석 참고).
      // 같은 스레드 재개(같은 프로세스)는 카운터가 이어지므로 그대로 둔다.
      if (this.usageThreadId !== threadId) {
        this.usageThreadId = threadId
        this.usageTotal = { inTok: 0, cached: 0, outTok: 0 }
        this.usageBase = { inTok: 0, cached: 0, outTok: 0 }
        this.usageBaseAdopt = true
      }
      this.emit({ type: 'session', runId, sessionId: threadId, model, cwd, tools: [] })

      this.turnStartedAt = Date.now()
      const turn = await this.request<{ turn?: { id?: string } } | Record<string, unknown>>('turn/start', {
        threadId,
        input: [{ type: 'text', text: req.prompt, text_elements: [] }],
        model,
        effort
      })
      const turnObj = turn as { turn?: { id?: string }; id?: string }
      // 응답을 기다리는 사이 turn/started가 먼저 채택했으면 보존(?? 뒤 폴백), 그 사이 턴이
      // 이미 정착해 실행이 끝났으면 id를 부활시키지 않는다(activeRunId 가드 — 스테일
      // activeTurnId가 다음 실행의 통지를 mismatch로 버리게 된다)
      if (this.activeRunId === runId)
        this.activeTurnId = turnObj?.turn?.id ?? (typeof turnObj?.id === 'string' ? turnObj.id : this.activeTurnId)
      // 백그라운드 터미널 폴링 시작 — 푸시 알림이 없어 5초 간격 list (finishRun이 멈춘다)
      this.bgPollTimer = setInterval(() => void this.pollBgTerminals(), 5000)
      // 이후는 알림 스트림이 끌고 간다 (turn/completed → result → finishRun)
    } catch (e) {
      const msg = (e as Error)?.message ?? 'Codex 실행을 시작하지 못했어요'
      // turn/start 자체가 수용량 초과로 거절된 경우도(스레드는 이미 섰다) 전환 확인으로
      if (this.activeRunId === runId && this.activeThreadId && isCapacityErr({ message: msg })) {
        void this.askCapacityFallback(runId)
        return runId
      }
      const hint = /ENOENT|not (found|recognized)|종료/.test(msg)
        ? 'Codex CLI가 설치돼 있는지 확인해 주세요 (npm i -g @openai/codex).'
        : msg
      this.emit({ type: 'error', runId, message: hint })
      this.finishRun('error')
    }
    return runId
  }

  /** 프로세스 정리 — 앱 종료 시 호출 (선택). */
  dispose(): void {
    try {
      this.proc?.kill()
    } catch {
      /* ignore */
    }
    this.proc = null
  }
}
