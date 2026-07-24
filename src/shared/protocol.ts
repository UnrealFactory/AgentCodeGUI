/* ============================================================
 * Shared protocol — contracts between main & renderer processes.
 * Keep this file dependency-free (types + const only).
 * ============================================================ */

// ── Picker enums (UI ⇄ engine) ───────────────────────────────
/** 실행 엔진 — Anthropic(Claude Code CLI) 또는 OpenAI(Codex CLI). */
export type EngineId = 'claude' | 'codex'
export type ModelId = 'fable' | 'opus' | 'sonnet' | 'haiku'
// minimal → extended thinking off; low..max → SDK effort levels (xhigh = Opus 4.7+)
export type EffortId = 'max' | 'xhigh' | 'high' | 'medium' | 'low' | 'minimal'
/** Maps to Claude Agent SDK permissionMode (+ canUseTool behaviour). */
export type ModeId = 'normal' | 'plan' | 'acceptEdits' | 'auto' | 'bypass'

export type AgentStatus = 'idle' | 'analyzing' | 'working' | 'done' | 'error'

// ── Tool activity ────────────────────────────────────────────
export type ToolKind = 'search' | 'read' | 'write' | 'edit' | 'bash' | 'task' | 'web' | 'mcp' | 'other'

export interface WebLink {
  title: string
  url: string
}

export interface ToolLogItem {
  id: string // tool_use id
  verb: string // display label: Search / Read / Write / Edit / Bash / Task …
  kind: ToolKind
  target: string // file path or command summary
  status: 'running' | 'done' | 'error'
  result?: string // short result summary once finished
  output?: string // captured output tail (Bash) — 클릭 시 전체 로그 모달로 표시
  durationMs?: number // 실행 시간 (tool-start→end) — bash 행의 우측 요약·모달에 표시
  links?: WebLink[] // web rows — pages a WebSearch found; the chat row expands to clickable links
  parentToolId?: string // set when this tool runs inside a subagent (Task)
}

// ── Todos (TodoWrite tool) ───────────────────────────────────
export type TodoStatus = 'pending' | 'running' | 'done'
export interface Todo {
  id: string
  label: string
  status: TodoStatus
}

// ── Changed files + diffs ────────────────────────────────────
export interface ChangedFile {
  path: string // workspace-relative path
  add: number
  del: number
  tag: 'new' | 'edit'
}
export interface DiffLine {
  t: 'add' | 'del' | 'ctx' | 'hunk'
  text: string
}
export interface FileDiff {
  path: string
  tag: 'new' | 'edit'
  add: number
  del: number
  lines: DiffLine[]
}

/** Result of reading a file's content for the in-app viewer card. */
export interface FileReadResult {
  path: string // the relative path that was requested (echoed back)
  content: string | null // utf-8 text, or null when not previewable
  truncated: boolean // true when the file exceeded the read cap (content is a prefix)
  error?: string // human-readable reason when content is null (binary / too big / missing)
}

/** Result of writing a file's content from the in-app editor (Ctrl+S). */
export interface FileWriteResult {
  ok: boolean
  error?: string // human-readable reason when the write failed
}

/** One entry of a directory listing (the in-app file explorer, loaded lazily per folder). */
export interface DirEntry {
  name: string
  dir: boolean // true → expandable folder
}

// ── Git (탐색기 상태 스트립 + Git 카드) ──────────────────────
// 작업 폴더 기준 시스템 git CLI 래퍼(main/git.ts). 경로는 전부 저장소 루트 기준
// 포워드 슬래시 — 작업 폴더가 저장소의 하위 폴더여도 루트(toplevel)로 동작한다.
/** 변경 파일 하나 — index/워크트리 구분 없이 접은 표시용 상태 한 글자. */
export interface GitFileStatus {
  path: string // repo-root-relative, forward slashes
  status: 'M' | 'A' | 'D' | 'R' | 'U' // 수정·새 파일·삭제·개명·충돌
  renamedFrom?: string // R일 때 원래 경로
  untracked?: boolean // 미추적 새 파일 — 되돌리기가 휴지통행이 된다
}
/** repo=false면 나머지 필드는 무의미 — 스트립 자체를 그리지 않는다. */
export interface GitStatus {
  repo: boolean
  root: string // 저장소 루트(절대 경로)
  branch: string // 현재 브랜치명 (detached면 안내 문구)
  detached: boolean
  ahead: number // 업스트림보다 앞선(푸시 대기) 커밋 수
  behind: number // 업스트림보다 뒤처진(당겨올) 커밋 수
  upstream: string | null // e.g. 'origin/main' — 없으면 첫 푸시 전
  hasRemote: boolean // remote 자체가 없으면 push/pull 버튼을 접는다
  files: GitFileStatus[]
}
/** 히스토리 한 줄 — 목록 표시에 필요한 만큼만 (본문·파일은 상세 조회로). */
export interface GitCommit {
  hash: string
  shortHash: string
  parents: string[]
  author: string
  time: number // unix seconds
  refs: string[] // 브랜치·태그 장식 (HEAD-> 제거됨)
  subject: string
  unpushed: boolean // 업스트림에 아직 없는 커밋 — '푸시 안 됨' 점
}
export interface GitLogResult {
  commits: GitCommit[]
  hasMore: boolean // limit+1 조회로 판정 — 더 불러오기 행 노출용
}
/** 파일 diff — 뷰어 계약(전체 파일·LF·FileDiff) 그대로. null이면 error가 사유. */
export interface GitFileDiffResult {
  diff: FileDiff | null
  error?: string // 바이너리·용량 초과 등 diff를 접은 이유
  // 워크트리에서 지워진 파일 — 디스크에 없어 뷰어가 읽을 게 없으니 HEAD 내용을
  // 스냅샷으로 준다 (되돌리기 전에 "뭘 잃는지"를 보게)
  headContent?: string
}
export interface GitCommitFile {
  path: string
  status: 'M' | 'A' | 'D' | 'R'
  renamedFrom?: string
}
export interface GitCommitDetail {
  hash: string
  shortHash: string
  author: string
  time: number
  subject: string
  body: string
  files: GitCommitFile[]
}
export interface GitBranch {
  name: string
  current: boolean
  time: number // 마지막 커밋 시각(unix) — 목록 정렬·상대 시간 표시
}
export interface GitResult {
  ok: boolean
  error?: string
}
export interface GitAiMessageResult {
  ok: boolean
  subject?: string
  body?: string
  error?: string
}

// ── LSP code intelligence (in-app file viewer) ───────────────
/**
 * Code-intelligence availability for a file in the viewer card.
 * 'need-install' / 'installing' apply to downloadable native servers
 * (C#/OmniSharp, C++/clangd) — bundled ones (TS, Python) skip those states.
 */
export type LspStatus = 'unsupported' | 'starting' | 'ready' | 'error' | 'need-install' | 'installing'
/** Aggregate code-analysis state for a whole project — drives the explorer folder badge.
 *  'analyzing' = a server under the folder is still starting/indexing, 'ready' = all done,
 *  'idle' = nothing running. percent = latest indexing % during 'analyzing' (or null). */
export interface LspProjectStatus {
  state: 'idle' | 'analyzing' | 'ready'
  percent: number | null
}
/** A known language server + its provisioning state (설정 ▸ 코드 분석). */
export interface LspServerInfo {
  id: string // 'ts' | 'py' | 'cs' | 'cpp' | 'verse'
  label: string // server display name, e.g. 'C#'
  langs: string // covered languages, e.g. 'TypeScript · JavaScript'
  exts: string // covered extensions, e.g. '.cs .csx'
  // bundled = ships with the app · download = fetched on demand · external = user supplies
  // the binary (Verse: Epic's verse-lsp.exe, can't be shipped/downloaded)
  kind: 'bundled' | 'download' | 'external'
  // bundled = ships with the app (always available) · none = not provisioned · installed =
  // downloaded (download) or configured (external) · installing = download in progress
  state: 'bundled' | 'none' | 'installing' | 'installed'
  requires?: string // external prerequisite note, e.g. '.NET SDK(dotnet) 필요'
  path?: string // external: the configured source path (vsix/exe) — for display
}
/** Streamed progress while downloading a language server. */
export interface LspInstallProgress {
  server: string // 'cs' | 'cpp'
  label: string // human-readable server name, e.g. 'C# (OmniSharp)'
  percent: number | null // download progress 0-100, null when indeterminate
  line?: string // a human-readable progress line
  done?: boolean
  ok?: boolean
  error?: string
}
/** A document position in LSP convention — both fields 0-based, UTF-16 columns. */
export interface LspPos {
  line: number
  character: number
}
/** Hover info for a symbol — markdown (signature + docs), as the server sent it. */
export interface LspHoverResult {
  contents: string
}
/** A definition target. `path` is absolute; line/character are 0-based. */
export interface LspLocation {
  path: string
  line: number
  character: number
}
/** Semantic highlighting for a whole document (LSP semanticTokens, decoded). */
export interface LspSemanticTokens {
  /** flat quintuples — line, character, length, typeIndex, modifierBits (0-based, UTF-16 columns) */
  data: number[]
  /** typeIndex → LSP token type name (the server's legend) */
  types: string[]
  /** modifier bit position → LSP token modifier name (the server's legend) */
  mods: string[]
}
/** 프로젝트 코드 파일 변화가 언어 서버들에 통지됐다는 브로드캐스트(main→모든 창) — 열린
 *  뷰어가 멈춘 토큰 폴링을 다시 깨우는 신호. C#(Roslyn)은 새/수정 파일의 타입이 재프라임
 *  '뒤'의 토큰 요청부터 분류되므로, 이 신호가 없으면 열려 있는 문서는 재열람 전까지 무색. */
export interface LspFilesChangedEvent {
  /** 바뀐 파일들의 절대 경로 — 뷰어가 "자기 자신"의 변화(본문 스냅샷과 좌표 어긋남)를 거른다 */
  paths: string[]
  /** 바뀐 확장자들(소문자, 점 없음) + 파생 언어 키(csproj/sln 변화 → 'cs') — 관심 판별용 */
  exts: string[]
}
/** A private CompletionItemKind (outside LSP's 1–25) we tag Verse language built-ins with — built-in
 *  types (int/float/…) AND reserved literals/keywords (true/false/…). The renderer gives them their own
 *  `#` "official built-in" icon in the keyword colour, distinct from user-defined symbols. */
export const VERSE_BUILTIN_KIND = 1001

/** One completion candidate — a trimmed LSP CompletionItem the renderer turns into a CM option. */
export interface LspCompletionItem {
  label: string
  /** LSP CompletionItemKind (1=Text, 3=Function, 5=Field, 7=Class … 25=TypeParameter) — drives the CM icon */
  kind?: number
  /** type / signature shown beside the label (e.g. `:int`) */
  detail?: string
  /** markdown docs (flattened), shown in the side panel */
  documentation?: string
  /** text to insert (falls back to label); when `snippet` it carries LSP `${1:..}` placeholders */
  insertText?: string
  /** true when insertText is an LSP snippet (insertTextFormat=2) rather than plain text */
  snippet?: boolean
  /** server-provided sort/filter hints (CM uses them when present) */
  sortText?: string
  filterText?: string
  /** 원본 아이템 인덱스 — 목록의 `gen`과 함께 completion-resolve(문서 지연 로드)의 핸들이 된다 */
  ri?: number
}
/** Completion result at a position — candidates + whether the list is partial (re-query on more typing). */
export interface LspCompletionList {
  items: LspCompletionItem[]
  isIncomplete: boolean
  /** 이 목록의 세대(resolve 핸들) — 서버가 completionItem/resolve를 지원할 때만 실린다 */
  gen?: number
}
/** completionItem/resolve로 지연 로드한 후보 문서 — 없으면 null. */
export interface LspResolvedCompletion {
  detail?: string
  documentation?: string
}
/**
 * Accurate Verse type registry parsed from the project's digests + `.verse` files (verse-lsp emits
 * no semantic tokens, so the renderer colours/labels from this instead of guessing). Per UE project.
 */
export interface VerseRegistry {
  kind: Record<string, 'class' | 'struct' | 'enum' | 'interface'> // type name → its kind
  supers: Record<string, string[]> // type name → super-type names (for inherited-member resolution)
  members: Record<string, string[]> // type name → its direct member names (fields + methods)
  methods: Record<string, string[]> // type name → its method names (subset of members) — coloured as functions
  enumValues: Record<string, string[]> // enum name → its value names (subset of members)
  setters: Record<string, Record<string, string>> // type → member → SETTER (write) access, when explicit
  docs: Record<string, string> // type name → its doc comment (`#`/`@doc`) — shown when hovering the type in a card
}
/**
 * verseRegistry IPC의 세대(rev) 스냅샷. 메인은 무효화(UEFN 재빌드·저장·문서 언어 토글)마다
 * rev를 올리고, 렌더러가 보낸 knownRev와 같으면 reg=null(변화 없음)만 돌려줘 큰 페이로드
 * 직렬화를 건너뛴다. 최상위 null = Verse 파일/프로젝트가 아님(렌더러는 다음 열기에 재시도).
 */
export interface VerseRegistrySnapshot {
  rev: number
  reg: VerseRegistry | null
}

// ── Terminal (Bash tool) ─────────────────────────────────────
export type TermLineType = 'cmd' | 'out' | 'ok' | 'muted' | 'err'
export interface TermLine {
  type: TermLineType
  text: string
}

// ── Subagents (Task tool) ────────────────────────────────────
export type SubAgentStatus = 'queued' | 'running' | 'done'
export interface SubAgentInfo {
  id: string // the Task tool_use id (= parentToolId of its child tools)
  name: string
  role: string
  status: SubAgentStatus
  activity: string
  tools: ToolLogItem[] // tools this subagent ran (its child tool_uses)
  // 실행 중 내레이션의 누적 로그 — activity는 최신 한 줄로 덮이므로, 과정을 나중에
  // 볼 수 있게 렌더러(reducer)가 변화를 여기 쌓는다 (엔진은 채우지 않는다)
  log?: string[]
  // 사이드체인 프레임이 보고한 실행 모델 표시명 (예: 'Opus 4.8') — 카드 서브 줄·푸터 칩
  model?: string
  // Task 도구 시작→완료 소요 — 완료 emit에만 실린다 (실행 중엔 없음)
  durationMs?: number
}

// ── Chat ─────────────────────────────────────────────────────
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  time?: string
}

// ── AskUserQuestion (agent asks the user to choose) ──────────
export interface AgentQuestionOption {
  label: string
  description: string
}
export interface AgentQuestion {
  question: string
  header: string // short chip label, e.g. "정리 대상"
  multiSelect: boolean
  options: AgentQuestionOption[]
}

// ── 백그라운드 작업 (Claude Code의 셸 추적 패리티) ────────────
// Bash run_in_background / Ctrl+B로 백그라운드가 된 작업. CLI 프로세스 안에서 돌므로
// 턴의 스트림이 닫히면(결과 후 유예 포함) 함께 정리된다 — 그때도 종료 통지가 온다.
export interface BgTask {
  id: string // SDK task_id — 중지(stop) 요청에 그대로 쓴다
  kind: string // SDK task_type 원시값 (셸은 'local_bash')
  description: string // 작업 설명 (셸이면 모델이 붙인 명령 한 줄 설명)
  status: 'running' | 'completed' | 'failed' | 'stopped'
  summary?: string // 종료 통지의 요약
  outputFile?: string // 출력이 쌓이는 파일 경로 (실행 중엔 유도값, 종료 통지가 실제 경로로 덮음)
  // stopped가 사용자의 중지가 아니라 턴 종료에 따른 CLI 정리였는지 — 표시 문구를 가른다
  teardown?: boolean
  // 사용자가 중지 버튼으로 끊은 작업인지 (엔진이 stop 요청 id를 기억해 정착 통지에 표식)
  byUser?: boolean
}

// 렌더러 → 엔진 백그라운드 작업 컨트롤. stop: 그 작업 중지(id 필수),
// background: 지금 도는 포그라운드 도구 전부를 백그라운드로 (터미널 Ctrl+B 패리티).
export interface BgTaskRequest {
  action: 'stop' | 'background'
  id?: string
}

// ── Engine → Renderer events ─────────────────────────────────
export type EngineEvent =
  | { type: 'status'; runId: string; status: AgentStatus }
  | { type: 'session'; runId: string; sessionId: string; model: string; cwd: string; tools: string[] }
  | { type: 'assistant-done'; runId: string; messageId: string; text: string }
  // streaming text chunk appended to the in-progress assistant message
  | { type: 'assistant-stream'; runId: string; messageId: string; delta: string }
  | { type: 'thinking'; runId: string; text: string }
  | { type: 'thinking-clear'; runId: string }
  | { type: 'tool-start'; runId: string; tool: ToolLogItem }
  // target: 시작 시점엔 몰랐던 대상이 완료 때 확정되면 행의 target을 덮는다
  // (Codex webSearch — 검색어가 item/completed에만 실린다, 실측 0.144.4)
  | { type: 'tool-end'; runId: string; id: string; status: 'done' | 'error'; result?: string; output?: string; durationMs?: number; links?: WebLink[]; target?: string }
  | { type: 'todos'; runId: string; todos: Todo[] }
  // `whole` = a full-file Write (the diff supersedes any accumulated diff for this
  // path); false for incremental Edit/MultiEdit (merges onto the existing diff)
  | { type: 'file-change'; runId: string; file: ChangedFile; diff: FileDiff; whole: boolean }
  | { type: 'terminal'; runId: string; line: TermLine }
  | { type: 'subagent'; runId: string; agent: SubAgentInfo }
  // 살아있는 백그라운드 작업 전체 목록 (SDK background_tasks_changed 미러 — REPLACE 의미:
  // 렌더러는 이 목록에 없는 실행 중 작업을 종료로 간주하고, 종료 상세는 bg-task-end가 채운다)
  | { type: 'bg-tasks'; runId: string; tasks: Array<{ id: string; kind: string; description: string; outputFile?: string }> }
  // 백그라운드 작업 정착 통지 (SDK task_notification) — 렌더러가 추적 중인 id만 반영한다.
  // atTurnEnd: result 이후의 정착 = 턴 종료에 따른 CLI 정리, byUser: 사용자가 중지 버튼으로
  // 끊음 — stopped의 사유 표기(직접 중지/Claude가 중지/턴 종료 정리)를 가른다
  | { type: 'bg-task-end'; runId: string; id: string; status: 'completed' | 'failed' | 'stopped'; summary?: string; outputFile?: string; atTurnEnd?: boolean; byUser?: boolean }
  | {
      type: 'permission-request'
      runId: string
      requestId: string
      toolName: string
      summary: string
      // 카드 헤더 표기용('Claude의 승인 요청'/'GPT의 승인 요청') — 생략하면 claude
      engine?: EngineId
    }
  // the agent called AskUserQuestion → surface an interactive choice card.
  // engine: 카드 헤더 표기용('Claude의 질문'/'GPT의 질문') — 생략하면 claude
  | { type: 'question-request'; runId: string; requestId: string; questions: AgentQuestion[]; engine?: EngineId }
  | {
      type: 'result'
      runId: string
      isError: boolean
      text: string
      costUsd: number | null
      durationMs: number | null
      numTurns: number | null
      contextTokens: number | null
      // the model's real context-window size (tokens), from the SDK's per-model usage.
      // null when unknown → the renderer falls back to the model's default window.
      contextWindow: number | null
      // 이 실행이 실제로 API 키로 과금됐는지(토글이 아니라 인증 경로 기준: 전역
      // ANTHROPIC_API_KEY로 붙은 실행도 true). 대화별 비용 누적은 이 플래그가 켜진
      // 결과의 costUsd만 합산한다 (구독 실행의 명목 비용은 실제 청구가 아니므로).
      viaApi: boolean
      // 이 실행이 소모한 모델별 실측 토큰 — 렌더러가 대화 단위로 누적해 컨텍스트
      // 팝오버 맨 아래 '토큰 사용량'을 그린다. 생략/빈 배열 = 보고 없음.
      tokenUsage?: TokenUse[]
    }
  // live context-token estimate emitted per assistant turn (before the final result)
  | { type: 'context'; runId: string; contextTokens: number }
  // Fable 5가 안전 정책으로 응답을 거부(stop_reason 'refusal')해 엔진이 CLI처럼 폴백
  // 모델로 자동 전환·재시도한 경우. 렌더러는 경고 배너를 스레드에 표시하고, 거부된
  // 쪽의 스트리밍 부분 답변(retractMessageId)을 지우고, 모델 picker를 toModel로 바꾼다.
  // Codex의 수용량 초과(ServerOverloaded) 전환도 이 이벤트를 재사용 — engine: 'codex'면
  // toModel이 GPT 모델 id라 picker의 codexModel을 바꾼다.
  | {
      type: 'model-fallback'
      runId: string
      fromModel: string // raw model id, e.g. claude-fable-5
      toModel: string // raw model id, e.g. claude-opus-4-8
      text: string // ready-to-render Korean warning line
      retractMessageId: string | null // 거부된 쪽이 스트리밍하던 메시지 id (없으면 null)
      engine?: EngineId // picker 동기화 분기용 — 생략하면 claude
    }
  // 엔진 루프의 일반 텍스트 배너 — CLI가 REPL에 띄우는 알림(notification)·경고 줄
  // (informational: 한도 경고, 훅 피드백 등). 스레드에 notice 줄로 그대로 표시한다.
  // once가 있으면 '이 대화에서 그 key당 한 번만' 표시하는 안내(예: API 과금)로 취급하고,
  // 방금 보낸 사용자 메시지 바로 위에 끼워 넣는다.
  | { type: 'notice'; runId: string; text: string; once?: string }
  | { type: 'error'; runId: string; message: string }

// ── Renderer → Main commands ─────────────────────────────────
export interface RunRequest {
  prompt: string
  model: ModelId
  effort: EffortId
  mode: ModeId
  cwd: string // working directory (project root). Required.
  // 실행 엔진 — 생략하면 'claude'. 'codex'면 codexModel(GPT 모델 id)로 Codex CLI가 돈다.
  engine?: EngineId
  codexModel?: string
  resume?: string // session id to resume — carries this chat's conversation history
  systemPrompt?: string // 채팅/패널별 프롬프트 — appended to the preset system prompt every run
  // true → 이 실행은 구독(OAuth) 대신 저장된 API 키로 과금한다 (컴포저의 API 토글).
  // 엔진이 하위 CLI에 ANTHROPIC_API_KEY를 주입하고, result 이벤트에 viaApi로 표시한다.
  useApi?: boolean
  // 이 실행이 소비할 클로드 구독 계정(계정 picker의 이메일). 엔진이 그 계정의 격리
  // CLAUDE_CONFIG_DIR을 물질화해 주입한다 — 미지정이면 기본 계정, useApi가 켜져 있으면 무시.
  account?: string
  // Codex 실행이 소비할 OpenAI 계정 — 미지정이면 기본 계정. 엔진이 그 계정의 격리
  // CODEX_HOME으로 app-server를 띄운다 (engine==='codex'일 때만 의미).
  codexAccount?: string
}

// ── Multi-agent (N independent panels, one engine each) ──────
// A pool of ClaudeEngines runs in parallel — one per on-screen panel — so several
// tasks proceed at once. Every renderer→main command names its panel, and every
// main→renderer event is wrapped with the panel it belongs to, so streams stay
// routed to the right panel on the shared channel.
export interface MultiRunRequest extends RunRequest {
  panelId: string
}
export interface MultiPermissionResponse extends PermissionResponse {
  panelId: string
}
export interface MultiQuestionResponse extends QuestionResponse {
  panelId: string
}
/** An engine event tagged with the panel it came from (multi-agent channel). */
export interface MultiEngineEvent {
  panelId: string
  event: EngineEvent
}

export interface PermissionResponse {
  requestId: string
  // 'allow_always' = allow now AND stop asking for this tool for the rest of the session
  behavior: 'allow' | 'allow_always' | 'deny'
  message?: string
}

export interface QuestionResponse {
  requestId: string
  // one entry per question, each holding the selected option labels.
  // null when the user dismissed without answering.
  answers: string[][] | null
}

/** Codex 모델 1건 — app-server model/list의 축약형 (picker 표시용). */
export interface CodexModelInfo {
  id: string
  label: string
  desc: string
  efforts: string[]
  defaultEffort: string
  isDefault: boolean
}

// ── Window ───────────────────────────────────────────────────
export interface WindowState {
  maximized: boolean
}

// ── API 키 과금 설정 (설정 → API) ─────────────────────────────
/**
 * 렌더러에 보여줄 API 설정 스냅샷. 키 원문은 절대 렌더러로 보내지 않는다 —
 * 존재 여부(hasKey)와 확인용 끝 4자리(keyTail)만 노출. 키는 메인 프로세스가
 * safeStorage(Windows DPAPI)로 암호화해 앱 홈(api-config.json)에 보관한다.
 * spentUsd는 API 모드 실행들의 total_cost_usd 누적(전체 워크스페이스 합산) —
 * Anthropic은 잔액 조회 API를 제공하지 않으므로, 예산(budgetUsd)을 입력받아
 * 이 누적치를 차감하는 방식으로 "남은 예산"을 근사한다.
 */
export interface ApiConfigStatus {
  hasKey: boolean
  keyTail: string | null // 저장된 키의 끝 4자리 (표시용)
  budgetUsd: number | null // 사용자가 입력한 예산(충전액), 없으면 null
  spentUsd: number // API 모드 실행의 누적 비용(USD)
  // OpenAI(Codex) API 키 — API 모드에서 Codex 실행이 이 키로 과금된다.
  // Codex는 실행 비용(total_cost_usd)을 보고하지 않아 예산·누적은 Anthropic 전용.
  hasOpenaiKey: boolean
  openaiKeyTail: string | null
}

/** 클로드 로그인 시도 결과 — `claude auth status --json`(격리 폴더)을 정규화한 값. */
export interface AuthStatus {
  loggedIn: boolean
  email?: string
  authMethod?: string // 'claude.ai'(구독) 등
  subscriptionType?: string // 'max' · 'pro' 등
  orgName?: string
  error?: string // 상태 조회/실행 실패 사유 (있으면 UI에 안내)
}

/** 등록된 계정 1건 — 크리덴셜 스냅샷은 앱 홈에 암호화 보관, 여기엔 표시용 메타만. */
export interface AccountInfo {
  email: string
  subscriptionType?: string
  isDefault: boolean // 새 채팅·계정 미지정 채팅이 쓰는 기본 계정인가
}

/** 등록된 OpenAI(Codex) 계정 1건 — Anthropic과 동일한 문법(앱 등록 계정만, 기본 계정). */
export interface CodexAccountInfo {
  email: string
  plan: string | null // 'plus' · 'pro' · 'free' 등 (id_token의 chatgpt_plan_type)
  isDefault: boolean // 새 채팅·계정 미지정 채팅이 쓰는 기본 계정인가
}

/**
 * OpenAI(Codex) 계정 1건의 한도 — app-server `account/rateLimits/read` 실측.
 * planType은 id_token보다 신선(구독 변경이 바로 반영)해서 표시 플랜도 이걸 우선한다.
 */
export interface CodexAccountUsage {
  email: string
  planType: string | null
  // resetsAt: 창 초기화 시각(unix 초, rateLimits primary/secondary의 resetsAt 실측) — 없으면 null
  windows: { label: string; usedPct: number; resetsAt?: number | null }[] // 예: [{label:'주간',usedPct:34,resetsAt:1784724661}]
}

/**
 * 저장된 계정 1건의 한도 사용률 — 전환 없이 각 계정의 저장 토큰으로 usage API를 조회한 값.
 * null = 그 한도가 플랜에 없거나 조회 불가(저장 토큰 만료 등). 만료된 토큰은 전환 시
 * CLI가 리프레시하므로 "조회만 안 될 뿐" 전환은 정상 동작한다.
 */
export interface AccountUsage {
  email: string
  fiveHourPct: number | null // 5시간 창 사용률 0-100
  weeklyPct: number | null // 주간(7일) 창 사용률 0-100
  fablePct: number | null // Fable 5 전용 주간 한도 사용률 0-100
  // 각 창의 초기화 시각(unix 초, usage API resets_at) — 없으면 null.
  // optional인 이유: 디스크 캐시(usage-cache.json)의 구 항목엔 필드가 없다.
  fiveHourResetsAt?: number | null
  weeklyResetsAt?: number | null
  fableResetsAt?: number | null
}

/** 어떤 화면의 엔진이 실행했는지 — 사용 통계의 분류 축. */
export type ApiUsageSource = 'chat' | 'talk' | 'ma'

/** 모델 하나의 토큰 소모 묶음 — 대화 누적(tokenTotals)의 값 형태. */
export interface TokenTally {
  inTok: number // 비캐시 입력
  outTok: number // 출력
  cacheRead: number // 캐시 읽기 (Codex는 cachedInputTokens)
  cacheWrite: number // 캐시 쓰기 (Codex는 구분 보고가 없어 0)
}

/**
 * 실행 1건이 소모한 모델별 실측 토큰 (result 이벤트의 tokenUsage 한 항목).
 * 렌더러가 대화 단위로 누적해 컨텍스트 팝오버 '토큰 사용량'을 그린다.
 * 주의: 한도(주간·5시간) 차감은 모델 단가·캐시 여부로 가중되므로 이 수치와
 * 정비례하지 않는다 — UI는 실측 토큰이라고만 말하고 한도 환산을 주장하지 않는다.
 */
export interface TokenUse extends TokenTally {
  model: string // 표시 모델명 (Claude: 'Opus 4.8' 꼴, Codex: 모델 id 그대로)
}

/**
 * API 모드 실행 1건의 기록 (설정 → API 통계의 원장 한 줄).
 * 메인이 ~/.agentcodegui/api-usage.jsonl 에 실행이 끝날 때마다 append 한다.
 * 토큰 수치는 SDK result의 누적 usage(그 실행 전체 합).
 */
export interface ApiUsageRecord {
  ts: number // unix ms — 실행이 끝난 시각
  model: string // 표시 모델명 (예: 'Opus 4.8') — 알 수 없으면 picker 별칭
  source: ApiUsageSource
  costUsd: number
  inTok: number // input_tokens (비캐시 입력)
  outTok: number // output_tokens
  cacheRead: number // cache_read_input_tokens
  cacheWrite: number // cache_creation_input_tokens
  durationMs: number | null
  numTurns: number | null
}

// ── Rate-limit usage (from the OAuth usage API) ──────────────
export interface UsageWindow {
  pct: number // 0-100
  resetsAt: number | null // unix seconds
}
// 구독 "추가 사용 크레딧"(한도 도달 후 종량 이어쓰기) — usage API의 spend 객체.
// 금액은 주(major) 단위 숫자(amount_minor / 10^exponent 환산), 통화는 코드 그대로.
export interface ExtraCreditInfo {
  enabled: boolean // 켜져 있고 잔액도 있는 정상 상태
  // 토글은 켰지만 잔액이 소진돼 API가 비활성 취급하는 상태 (disabled_reason:
  // "out_of_credits") — UI는 이때도 행을 보여준다 ("다 떨어짐"이야말로 중요한 정보)
  outOfCredits: boolean
  currency: string // 'USD' 등 — USD만 $ 기호로 표시
  used: number | null // 이번 달 사용액
  cap: number | null // 월간 지출 한도
  balance: number | null // 현재 잔액 (소진 상태는 0으로 정규화)
  pct: number | null // 월 한도 대비 사용률 0-100
}
export interface UsageInfo {
  fiveHour: UsageWindow | null
  weekly: UsageWindow | null
  // Fable 5 전용 주간 한도 (usage API `limits[]`의 weekly_scoped·model=Fable 항목).
  // 플랜에 이 한도가 없으면 null → UI는 행/필 자체를 숨긴다.
  weeklyFable: UsageWindow | null
  // 추가 사용 크레딧 — 응답에 spend가 없으면(구버전 API) null → UI는 행을 숨긴다
  extraCredit: ExtraCreditInfo | null
}

// ── Engine (Claude Code SDK) version management ──────────────
/** A version available on the npm registry. */
export interface EngineVersionEntry {
  version: string
  date: string | null // ISO publish date, if known
  latest: boolean // matches the registry's dist-tags.latest
  // 정식(latest dist-tag)보다 높은 버전 — next 등 프리뷰 채널. 자동 업데이트 대상이
  // 아니므로 UI가 '프리뷰' 배지로 구분한다 (없으면 '최신 위에 배지 없는 버전'이 고장처럼 보임)
  preview?: boolean
}
/** Current state of the locally managed engine versions. */
export interface EngineVersionState {
  package: string // npm package being managed
  bundled: string // version shipped inside the app (used as fallback)
  active: string | null // installed version in use, or null → bundled
  installed: string[] // installed versions, newest first
}
/** Streaming progress while installing a version. */
export interface EngineInstallProgress {
  version: string
  line?: string // a stdout/stderr line from npm
  done?: boolean
  ok?: boolean
  error?: string
}
/** Result of deleting every installed version except the newest (설정 ▸ 정리). */
export interface EngineCleanupResult {
  removed: string[] // versions deleted, newest first
  kept: string | null // the newest installed version that stayed
  freedBytes: number // disk space reclaimed (best-effort walk before rm)
  activeSwitched: boolean // active pointed at a removed version → moved to `kept`
}

// ── User profile (local nickname + avatar color) ─────────────
/** Persisted to ~/.agentcodegui/profile.json — set once on the entry screen. */
export interface UserProfile {
  nickname: string
  color: string // hex, chosen from the avatar palette
}

/** 추가 채팅(세션 창) 한 개 — 사이드바 목록 항목. id는 영속 채팅 id(uuid)로, 창을
 *  닫았다 다시 열거나 앱을 재시작해도 같은 대화를 가리킨다. title '' = 아직 첫
 *  메시지를 보내지 않은 채팅. open = 그 채팅의 창이 지금 떠 있는지(숨김 포함). */
export interface SessionWindowInfo {
  id: string
  title: string
  status: AgentStatus
  open: boolean
  updatedAt?: number // 마지막 활동(프롬프트 전송) 시각 — 사이드바 상대 시간 표시용
}

/** 세션 창 렌더러 → 메인: 이 창의 대화 저장(디바운스/닫기 flush). 스냅샷 모양은
 *  렌더러(SessionState)가 소유하고 메인은 그대로 저장만 한다. empty = 메시지 0 —
 *  창을 닫을 때 목록에 남기지 않는 판정용. */
export interface SessionPersistPayload {
  title: string
  status: AgentStatus
  cwd: string
  snapshot: unknown
  picker?: unknown
  draft?: string
  draftImages?: string[]
  empty: boolean
  updatedAt?: number
}

/** 메인 → 세션 창 렌더러: 저장된 추가 채팅의 복원 데이터 (새 채팅이면 null). */
export interface SessionHydrateData {
  snapshot: unknown
  cwd: string
  picker?: unknown
  draft?: string
  draftImages?: string[]
}

// ── 엔진 자동 업데이트 (부팅 게이트) ─────────────────────────
/** 부팅 자동 업데이트에서 엔진 하나의 진행 상태 — 카드의 행 하나. */
export interface EngineUpdateItem {
  id: 'claude' | 'codex'
  label: string // 'Claude Code' | 'Codex CLI'
  from: string | null // 현재 활성 버전 (null = 신규 설치)
  to: string // 목표(최신) 버전
  status: 'pending' | 'installing' | 'done' | 'error'
  error?: string
}
/** 부팅 자동 업데이트 전체 스냅샷 — 변화마다 통째로 다시 보낸다(REPLACE).
 *  active=false면 이번 부팅엔 할 일이 없었다는 뜻(카드 없음). done이 서면 렌더러가
 *  잠시 보여주고 자동으로 닫는다. */
export interface EngineUpdateStatus {
  active: boolean
  items: EngineUpdateItem[]
  cleanup: 'pending' | 'running' | 'done' // 이전 버전 정리 단계
  freedBytes: number
  done: boolean
}

/** In-memory user derived from the saved profile, threaded through the UI. */
export interface AppUser {
  name: string
  avatarText: string // first character of the nickname
  avatarColor: string // the chosen palette color
}

// ── MCP servers (Model Context Protocol) ─────────────────────
/** Coarse scope used for the 전체/전역/로컬 filter tabs. */
export type McpScope = 'global' | 'local'
/** Finer source of a server config, shown as the row badge. */
export type McpOrigin = 'user' | 'project' | 'local'
export type McpTransport = 'stdio' | 'http' | 'sse' | 'unknown'
/** A discovered MCP server, plus its in-app on/off state. */
export interface McpServerInfo {
  name: string // server name (the key in the mcpServers map)
  scope: McpScope // global = ~/.claude.json user servers · local = project / private
  origin: McpOrigin // user (~/.claude.json) · project (.mcp.json) · local (private)
  transport: McpTransport // stdio (command) | http | sse
  detail: string // command line (stdio) or URL (http/sse)
  enabled: boolean // false → turned off in the app (engine gets deniedMcpServers)
}

// ── Skills (SKILL.md agent capabilities) ─────────────────────
/** Where a skill's SKILL.md lives. */
export type SkillScope = 'global' | 'local'
/** A discovered skill (one SKILL.md folder), plus its in-app on/off state. */
export interface SkillInfo {
  name: string // frontmatter `name` (falls back to the directory name)
  description: string // frontmatter `description` (may be empty)
  scope: SkillScope // global = ~/.claude/skills · local = <project>/.claude/skills
  path: string // absolute path to the SKILL.md file
  enabled: boolean // false → turned off in the app (engine gets skillOverrides: 'off')
}

// ── App auto-update (electron-updater, GitHub Releases) ──────
/**
 * Authoritative auto-update state, owned by the main process and mirrored to the
 * renderer. Carries a running `log` (engine-install style) so the UI can show the
 * whole process — and because main holds it, the renderer can fetch the current
 * state on mount and never miss early events fired before it subscribed.
 */
export interface UpdateStatus {
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'none' | 'error'
  version: string | null // the new version, once known
  percent: number // download progress, 0-100
  log: string[] // human-readable progress lines
  error: string | null
}

// ── IPC channel names ────────────────────────────────────────
export const IPC = {
  // renderer → main (invoke)
  runStart: 'claude:run',
  runCancel: 'claude:cancel',
  permissionRespond: 'claude:permission-respond',
  questionRespond: 'claude:question-respond',
  bgTask: 'claude:bg-task', // 백그라운드 작업 컨트롤 (중지 / 포그라운드 전부 백그라운드로)
  // multi-agent — a pool of independent engines, one per on-screen panel. Each command
  // carries a panelId so the main side routes it to that panel's engine; events come
  // back wrapped with the panelId on the shared maEvent channel.
  maRun: 'ma:run',
  maCancel: 'ma:cancel',
  maPermissionRespond: 'ma:permission-respond',
  maQuestionRespond: 'ma:question-respond',
  maBgTask: 'ma:bg-task', // 패널 WorkBar의 백그라운드 셸 컨트롤(중지/Ctrl+B) — 그 패널 엔진으로
  maDispose: 'ma:dispose', // cancel + drop a panel's engine (panel removed)
  maGet: 'ma:get', // load the persisted multi-agent workspace (layout + panel snapshots)
  maSave: 'ma:save', // persist the multi-agent workspace so it survives a restart
  // 채팅 — a pure-conversation workspace on its OWN engine instance, with its own
  // conversation list. No project folder, explorer, or tools UI.
  talkRun: 'talk:run',
  talkCancel: 'talk:cancel',
  talkPermissionRespond: 'talk:permission-respond',
  talkQuestionRespond: 'talk:question-respond',
  talkBgTask: 'talk:bg-task',
  talkGet: 'talk:get', // load the persisted chat-workspace conversations (or null)
  talkSave: 'talk:save', // persist the chat-workspace conversations so they survive a restart
  // 세션 창 — "추가 세션": 어느 모드에서든 새 OS 창(네이티브 프레임, 크기조절 자유)을 하나
  // 더 띄워 독립 대화를 굴린다. 창마다 자기 엔진을 갖고, 이벤트는 그 창의 webContents로만
  // 라우팅된다(sessionEvent). 기존 채널/메인 창 로직은 건드리지 않는 순수 추가 채널이다.
  openSessionWindow: 'win:open-session', // 새 세션 창을 띄운다 (타이틀바 + / Ctrl+Shift+N)
  sessionRun: 'session:run',
  sessionCancel: 'session:cancel',
  sessionPermissionRespond: 'session:permission-respond',
  sessionQuestionRespond: 'session:question-respond',
  sessionBgTask: 'session:bg-task',
  // 추가 채팅 레지스트리 — 대화는 채팅 id 기준으로 디스크에 영속(메인 채팅처럼 재시작
  // 후에도 사이드바에 남음)하고, 창은 그 채팅을 열어 보는 뷰다. 창 렌더러가 제목(첫
  // 프롬프트)·상태를 보고하고, 생성/종료/보고/저장 때마다 메인 창에 브로드캐스트.
  sessionWindowsList: 'session-wins:list', // 메인 창: 추가 채팅 목록 조회(열린 창 + 저장된 채팅)
  sessionWindowFocus: 'session-wins:focus', // (id) 창이 있으면 앞으로, 닫힌 채팅이면 창을 다시 만들어 복원
  sessionWindowClose: 'session-wins:close', // (id) 채팅 삭제 — 열린 창이 있으면 저장 없이 닫는다
  sessionWindowRename: 'session-wins:rename', // (id, title) 사이드바에서 이름 변경 — 이후 창의 자동 제목 보고는 무시
  sessionReport: 'session-wins:report', // 세션 창 렌더러 → 자기 제목·상태 보고
  sessionHydrate: 'session-wins:hydrate', // 세션 창 렌더러 → 자기 채팅의 저장본 조회(마운트 복원)
  sessionPersist: 'session-wins:persist', // 세션 창 렌더러 → 자기 대화 스냅샷 저장(디바운스/flush)
  pickDirectory: 'dialog:pick-directory',
  dirExists: 'fs:dir-exists', // 저장된 작업 폴더가 아직 존재하는지 확인(추가 채팅의 폴더 복원 검증)
  pickAttachments: 'dialog:pick-attachments', // open dialog filtered to attachable files (images + text); returns absolute paths
  saveAttachmentData: 'attachment:save-data', // persist pasted/dropped raw attachment bytes to a temp file; returns its path
  getUsage: 'usage:get',
  // 클로드 계정(구독 OAuth) — 앱 등록 계정만 사용. 로그인/로그아웃은 격리 CONFIG_DIR에서
  // 이뤄져 전역 ~/.claude를 건드리지 않는다. "전환" 개념 없음 — 채팅이 계정을 바인딩한다.
  authLogin: 'auth:login', // `claude auth login` (브라우저 OAuth, 격리 폴더) — 완료 시 계정 편입 + 상태 반환
  authLogout: 'auth:logout', // (email) 그 계정 토큰 해지 + 등록 제거 — 새 목록 반환
  authLoginCancel: 'auth:login-cancel', // 진행 중인 로그인 프로세스 중단
  authLoginUrl: 'auth:login-url', // main→renderer: 로그인 OAuth URL (브라우저가 안 열릴 때 폴백 링크)
  authListAccounts: 'auth:list-accounts', // 등록 계정 목록 + 기본 계정 표시
  authSetDefaultAccount: 'auth:set-default-account', // (email) 새 채팅의 기본 계정 지정 — 새 목록 반환
  authRemoveAccount: 'auth:remove-account', // 등록 목록에서 계정 제거(토큰 해지 없이 — 해지는 logout)
  authAccountsUsage: 'auth:accounts-usage', // 등록 계정별 한도 사용률(5시간·주간·Fable) 일괄 조회
  // Codex(OpenAI) 계정 — Anthropic과 동일한 문법: 앱 등록 계정만, 전역 ~/.codex 불가침
  codexListAccounts: 'codex-auth:list-accounts', // 등록 계정 목록 + 기본 표시
  codexLogin: 'codex-auth:login', // `codex login` (격리 CODEX_HOME 브라우저 OAuth) — 완료 시 편입 + 새 목록
  codexLogout: 'codex-auth:logout', // (email) 그 계정 auth 제거 + 등록 삭제 — 새 목록 반환
  codexSetDefaultAccount: 'codex-auth:set-default-account', // (email) 기본 계정 지정 — 새 목록
  codexLoginCancel: 'codex-auth:login-cancel',
  codexAccountsUsage: 'codex-auth:accounts-usage', // 등록 계정별 한도(rateLimits) 일괄 조회
  engineAutoUpdate: 'engine:auto-update', // (get: 인자 없음 / set: boolean) 두 엔진 CLI 자동 업데이트 토글
  engineUpdateStatus: 'engine:update-status', // 부팅 자동 업데이트 스냅샷 조회 — 카드가 마운트 때 따라잡는다
  apiConfigGet: 'api-config:get', // API 키/예산/누적 사용액 스냅샷 (키 원문 제외)
  apiConfigSetKey: 'api-config:set-key', // API 키 저장 (safeStorage 암호화)
  apiConfigClearKey: 'api-config:clear-key', // 저장된 API 키 삭제
  apiConfigSetBudget: 'api-config:set-budget', // 예산(USD) 설정 (null = 없음, provider별)
  apiConfigResetBudget: 'api-config:reset-budget', // 예산 초기화(0원) — Anthropic은 누적도 0으로
  apiUsageList: 'api-usage:list', // API 모드 실행 원장 (설정 → API 통계)
  openApiSettings: 'ui:open-api-settings', // 세션 창 → 메인 프로세스: 메인 창을 앞으로 + 설정 → API 탭 열기
  apiSettingsRequested: 'ui:api-settings-requested', // 메인 프로세스 → 메인 창: 위 요청 전달(설정 모달 열기)
  profileGet: 'profile:get', // load the saved local user profile (or null)
  profileSave: 'profile:save', // persist nickname + avatar color
  chatsGet: 'chats:get', // load the saved chat list + active id (or null)
  chatsSave: 'chats:save', // persist the chat list so conversations survive a restart
  uiPrefsGet: 'ui-prefs:get', // load renderer UI prefs blob (viewer size/zoom, chat zoom)
  uiPrefsSave: 'ui-prefs:save', // persist the whole UI prefs blob to ~/.agentcodegui
  uiGlassChanged: 'ui-glass:changed', // 유리(벽지 비침) 값 브로드캐스트 → 전 창 틴트 동기화
  skillList: 'skill:list', // enumerate global + project skills with their on/off state
  skillSetEnabled: 'skill:set-enabled', // turn a skill on/off (persisted to the app home)
  mcpList: 'mcp:list', // enumerate user + project + local MCP servers with on/off state
  mcpSetEnabled: 'mcp:set-enabled', // turn an MCP server on/off (persisted to the app home)
  shellOpenPath: 'shell:open-path', // open a file with the OS default app
  shellRevealPath: 'shell:reveal-path', // reveal a file/folder in the OS file manager (Explorer/Finder)
  fsRename: 'fs:rename', // rename a file/folder within its parent (explorer context menu)
  fsDelete: 'fs:delete', // move a file/folder to the OS trash / recycle bin (explorer context menu)
  fsCreate: 'fs:create', // create a new empty file or folder (explorer context menu)
  fsMove: 'fs:move', // move a file/folder into another folder (explorer drag & drop)
  readFile: 'fs:read-file', // read a file's text content for the in-app viewer card
  writeFile: 'fs:write-file', // overwrite a file's text content from the in-app editor (Ctrl+S)
  htmlPreviewUrl: 'fs:html-preview-url', // ccg-page:// URL 발급 + 서빙 루트 등록 (뷰어 HTML 미리보기)
  closeShortcut: 'shortcut:close', // Ctrl+W pressed (main swallows it) → renderer closes the open viewer
  listFiles: 'fs:list-files', // enumerate project files for the "@" mention palette
  listDir: 'fs:list-dir', // list one folder's entries for the file explorer (lazy per expand)
  // Git — 탐색기 상태 스트립 + Git 카드 (작업 폴더 기준, main/git.ts)
  gitStatus: 'git:status', // 브랜치·ahead/behind·변경 파일 목록 (repo 아님 판정 포함)
  gitLog: 'git:log', // 히스토리 (limit/skip 페이징, 푸시 안 됨 표시)
  gitFileDiff: 'git:file-diff', // 워킹트리 파일 diff (HEAD ↔ 디스크, 뷰어 계약)
  gitCommitDetail: 'git:commit-detail', // 커밋 메타 + 바뀐 파일 목록
  gitCommitFileDiff: 'git:commit-file-diff', // 커밋 시점 파일 내용 + 부모 대비 diff (뷰어 override)
  gitCommit: 'git:commit', // 고른 파일만 add 후 commit
  gitPush: 'git:push', // 올리기 (업스트림 없으면 -u origin HEAD)
  gitPull: 'git:pull', // 당겨오기
  gitFetch: 'git:fetch', // 갱신하기 — 원격 상태만 새로 읽는다
  gitDiscard: 'git:discard', // 파일 하나 되돌리기 (미추적은 휴지통)
  gitBranches: 'git:branches', // 로컬 브랜치 목록
  gitSwitchBranch: 'git:switch-branch', // 브랜치 전환
  gitCreateBranch: 'git:create-branch', // 새 브랜치 만들고 전환
  gitAiMessage: 'git:ai-message', // AI 커밋 메시지 — diff 읽고 저장소 톤으로 1회 생성
  lspStatus: 'lsp:status', // code-intel status for a file (lazily spawns the project's server)
  lspHover: 'lsp:hover', // symbol hover (markdown) at a position
  lspDefinition: 'lsp:definition', // definition target(s) for the symbol at a position
  lspSemanticTokens: 'lsp:semantic-tokens', // semantic highlighting tokens for a document
  lspCachedTokens: 'lsp:cached-tokens', // disk-cached tokens for instant paint (no server spawn)
  lspCompletion: 'lsp:completion', // completion candidates at a position (carries the live editor buffer)
  lspResolveCompletion: 'lsp:completion-resolve', // lazy docs for a completion candidate (completionItem/resolve)
  lspPrewarm: 'lsp:prewarm', // warm up a project's server/compile-DB before the first file open
  lspWarm: 'lsp:warm', // eagerly open a specific file on its server so it's indexed before typing
  lspVerseRegistry: 'lsp:verse-registry', // accurate Verse type registry (digests+project) for colouring
  lspProjectStatus: 'lsp:project-status', // aggregate analysis state for a folder (explorer badge)
  lspVerseDigests: 'lsp:verse-digests', // Verse API digest folders for the explorer (Verse.org/Fortnite.com/…)
  lspVerseExcludes: 'lsp:verse-excludes', // files.exclude globs for "Verse 위주로 보기" (from .code-workspace)
  lspInstall: 'lsp:install', // download a native language server (C#/C++) on user request
  lspServers: 'lsp:servers', // list every known language server + provisioning state (settings)
  lspInstallServer: 'lsp:install-server', // download a server by id (settings)
  lspUninstallServer: 'lsp:uninstall-server', // stop + delete a downloaded server (settings)
  lspPickVerseServer: 'lsp:pick-verse-server', // file dialog to choose Verse.vsix / verse-lsp.exe
  lspSetVersePath: 'lsp:set-verse-path', // configure the Verse server from a vsix/exe path
  lspClearVersePath: 'lsp:clear-verse-path', // forget the configured Verse server
  lspFilesChanged: 'lsp:files-changed', // 코드 파일 변화 브로드캐스트 → 열린 뷰어의 토큰 재폴링
  winMinimize: 'win:minimize',
  winMaximizeToggle: 'win:maximize-toggle',
  winClose: 'win:close',
  winIsMaximized: 'win:is-maximized',
  // Codex CLI 버전 관리 — Claude Code 엔진과 동일한 문법(npm 패키지를 앱 홈에 버전별 설치)
  codexEngineListAvailable: 'codex-engine:list-available',
  codexEngineState: 'codex-engine:state',
  codexEngineInstall: 'codex-engine:install',
  codexEngineUninstall: 'codex-engine:uninstall',
  codexEngineSetActive: 'codex-engine:set-active',
  codexEngineCleanup: 'codex-engine:cleanup',
  codexEngineInstallProgress: 'codex-engine:install-progress',
  engineListAvailable: 'engine:list-available',
  codexModels: 'codex:models', // Codex CLI(app-server) model/list — picker의 OpenAI 모델 목록
  engineState: 'engine:state',
  engineInstall: 'engine:install',
  engineUninstall: 'engine:uninstall',
  engineSetActive: 'engine:set-active',
  engineCleanup: 'engine:cleanup', // 최신 설치본만 남기고 이전 버전 폴더 전부 삭제

  // app meta + auto-update (electron-updater)
  appGetVersion: 'app:get-version', // the running app version (package.json version)
  appGetInitialDir: 'app:get-initial-dir', // folder passed via "AgentCodeGUI로 열기" at launch (consumed once)
  updateGetStatus: 'app:update-status', // current auto-update state + log (seeds the UI on mount)
  updateCheck: 'app:update-check', // manually trigger an update check
  updateInstall: 'app:update-install', // quit & install a downloaded update
  // main → renderer (send)
  engineEvent: 'engine:event',
  openDirectory: 'app:open-directory', // a folder opened via "AgentCodeGUI로 열기" while already running
  updateEvent: 'app:update-event', // streamed auto-update status
  maEvent: 'ma:event', // streamed events from every multi-agent engine (wrapped with panelId)
  talkEvent: 'talk:event', // streamed events from the 채팅 (pure conversation) engine
  sessionEvent: 'session:event', // streamed events from a session window's own engine
  sessionWindowsChanged: 'session-wins:changed', // main→메인 창: 추가 채팅 목록 변경
  sessionFlushRequest: 'session-wins:flush-request', // main→세션 창: 닫기 전 마지막 스냅샷 저장 요청
  engineUpdateEvent: 'engine:update-event', // main→렌더러: 부팅 자동 업데이트 진행(REPLACE 스냅샷)
  engineInstallProgress: 'engine:install-progress',
  lspInstallProgress: 'lsp:install-progress', // streamed progress while downloading a language server
  winState: 'win:state'
} as const
