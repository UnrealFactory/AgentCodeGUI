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
  // ★3.0 TOOLROW — 클릭 카드 재료(검색·MCP·기타 행). 파일 도구·Bash는 안 싣는다.
  name?: string // 원 도구 이름(`mcp__agentmon__status`) — MCP 카드 제목 「서버 · 도구」
  args?: string // 도구 입력 JSON 한 줄(6000자 캡) — 카드의 「요청」 섹션
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
/** 발견된 저장소 하나 — cwd 위(rev-parse)로 하나 + cwd 아래 얕은 걷기(깊이 3)로 찾는다.
 *  root를 그대로 git IPC들의 cwd 자리에 넘기면 그 저장소 기준으로 동작한다. */
export interface GitRepoInfo {
  root: string // 저장소 루트(절대 경로)
  rel: string // cwd 기준 상대 경로(포워드 슬래시). '' = cwd 자신 또는 상위 — 스트립·카드 라벨용
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
  // 3.0 additive (M7 R4): the same note in English. The note is produced by the Rust
  // crate, which can't reach the renderer's t() — so it ships both and the settings
  // card picks by UI language. Older shells omit it; `requires` stays the fallback.
  requiresEn?: string
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
  // 사이드체인 프레임이 보고한 실행 모델 표시명 (예: 'Opus 5') — 카드 서브 줄·푸터 칩
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

// 워크플로(Workflow 도구, task_type 'local_workflow') 진행 상태 — task_progress의
// workflow_progress 배열 미러. 이벤트마다 전체 스냅샷(REPLACE)이라 북엔드 짝맞춤이 없다.
export interface WorkflowAgent {
  label: string // 스크립트가 붙인 표시 라벨 (agent() opts.label / 프롬프트 요약)
  phase: number // 소속 phase index (1부터)
  phaseTitle: string
  model: string // 표시명 (엔진이 modelDisplay로 접어서 보냄)
  state: string // 'queued' | 'start' | 'done' | 'error' … (SDK 원시값 통과)
  tokens?: number
  toolCalls?: number
  durationMs?: number
  // 실행 중=프롬프트 미리보기, 완료=결과 미리보기 — 카드의 활동 한 줄
  note?: string
}
export interface WorkflowState {
  id: string // SDK task_id — 중지(BgTaskRequest.stop)에 그대로 쓴다
  summary: string // 워크플로 요약 (meta.description 계열 — 카드 제목)
  status: 'running' | 'completed' | 'failed' | 'stopped'
  phases: Array<{ index: number; title: string }>
  agents: WorkflowAgent[]
  totalTokens: number
  toolUses: number
  durationMs: number
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
  // 워크플로 진행/정착 — 전체 스냅샷 REPLACE. 정착(completed/failed/stopped) 후에도 CLI가
  // 정리 턴(assistant/result)을 이어 보낼 수 있다(엔진이 스트림을 열어둔 채 재기동을 기다림)
  | { type: 'workflow'; runId: string; wf: WorkflowState }
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
  // 대화 압축 경계 (CLI system/compact_boundary) — 컨텍스트가 가득 차 CLI가 스스로 요약한
  // 지점(auto) 또는 /compact(manual). preTokens는 압축 직전 컨텍스트(CLI 보고), afterTokens는
  // 압축 후 첫 assistant 프레임의 실측 컨텍스트 — 엔진이 그 프레임과 짝지어 한 번에 내보내므로
  // 게이지가 떨어지는 순간과 카드가 같이 뜬다(뒤 프레임 없이 턴이 끝나면 null). manual은
  // 명령 카드(pendingCommand 정착)가 이미 표시하므로 렌더러가 거른다.
  | { type: 'compact'; runId: string; trigger: 'auto' | 'manual'; preTokens: number | null; afterTokens: number | null }
  // Fable 5가 안전 정책으로 응답을 거부(stop_reason 'refusal')해 엔진이 CLI처럼 폴백
  // 모델로 자동 전환·재시도한 경우. 렌더러는 경고 배너를 스레드에 표시하고, 거부된
  // 쪽의 스트리밍 부분 답변(retractMessageId)을 지우고, 모델 picker를 toModel로 바꾼다.
  // Codex의 수용량 초과(ServerOverloaded) 전환도 이 이벤트를 재사용 — engine: 'codex'면
  // toModel이 GPT 모델 id라 picker의 codexModel을 바꾼다.
  | {
      type: 'model-fallback'
      runId: string
      fromModel: string // raw model id, e.g. claude-fable-5
      toModel: string // raw model id, e.g. claude-opus-5
      text: string // ready-to-render Korean warning line
      retractMessageId: string | null // 거부된 쪽이 스트리밍하던 메시지 id (없으면 null)
      engine?: EngineId // picker 동기화 분기용 — 생략하면 claude
    }
  // 엔진 루프의 일반 텍스트 배너 — CLI가 REPL에 띄우는 알림(notification)·경고 줄
  // (informational: 한도 경고, 훅 피드백 등). 스레드에 notice 줄로 그대로 표시한다.
  // once가 있으면 '이 대화에서 그 key당 한 번만' 표시하는 안내(예: API 과금)로 취급하고,
  // 방금 보낸 사용자 메시지 바로 위에 끼워 넣는다.
  // ★ M11 — `switch`가 붙어 오면 이 notice는 **한도 소진 자동 계정 전환** 배너다
  // (설정 '한도 소진 시 계정 자동 전환'이 켜져 있을 때만 온다. 기본 꺼짐).
  //
  // 왜 새 EngineEvent 종류가 아닌가: 이건 스레드에 줄 하나를 남기는 안내이고 그 문법은
  // notice가 이미 갖고 있다. 종류를 늘리면 리듀서의 소진 가드가 렌더러 타입체크를
  // 멈추고(M9 R1이 밟은 함정), 그 대가로 얻는 게 없다 — 되돌릴 재료는 선택 필드로
  // 실으면 그만이고, 안 읽는 화면은 지금처럼 문장만 그린다.
  //
  // `revertTo`는 **전환 직전 리비전**이다. `chat:identity-revert`에 그대로 넘기면
  // 계정이 돌아온다(히스토리 삭제가 아니라 새 리비전 — m-logic §6.3). 같은 tick에
  // `chat:identity{origin:'auto_account_switch', changed:['billing.account']}`도 나간다.
  // ★ M10 — `talk`이 붙어 오면 이 notice는 **대화 연결**(세션 간 소통)의 발신 기록이다.
  // M11의 `switch`와 같은 이유로 선택 필드다: 스레드에 줄 하나 남기는 안내이고, 그
  // 문법은 notice가 이미 갖고 있다.
  //
  // **거절도 반드시 온다**(`result`가 delivered/queued가 아닌 값). 조용히 안 나가면
  // 사용자는 두 세션이 왜 안 붙는지 알 수 없고, 모델은 같은 줄을 다음 턴에 또 쓴다.
  | {
      type: 'notice'
      runId: string
      text: string
      once?: string
      switch?: {
        from: string // 소진된 계정
        to: string // 갈아탄 계정
        soonestReset: number | null // 옮겨간 계정이 다음에 초기화되는 unix 초(모르면 null)
        revertTo: number
      }
    }
  | { type: 'error'; runId: string; message: string }

/**
 * ★M9 R2 확인 크리틱(F1) — **3.0 전용 엔진 이벤트까지 포함한 합집합.**
 *
 * `EngineEvent`는 2.6.2 렌더러(`src/renderer`, 동결)의 리듀서가 `never` 가드로 전수
 * 소진하는 유니온이다. 3.0이 새 종류를 그 유니온에 직접 더하면 **동결 트리의 타입체크가
 * 깨진다**(실제로 두 라운드 동안 `typecheck:web`이 빨간 채로 흘렀다 — `TS2345`).
 * 2.6.2 메인은 이 이벤트를 애초에 낼 수 없으므로 동결 렌더러가 몰라도 되는 것이 맞다.
 *
 * 규약: **와이어에 새 엔진 이벤트를 더할 때는 여기에 더한다.** `EngineEvent`는 2.6.2와의
 * 계약면으로 얼려 두고, 3.0 렌더러(`app/src`)와 셸이 이 이름을 쓴다.
 */
export type EngineEventV3 =
  | EngineEvent
  // ★ M9 — 이 채팅이 **실제로 들고 있는 도구 환경**(MCP 서버 · 스킬). REPLACE 의미:
  // 받은 쪽은 자기 스냅샷을 통째로 갈아끼운다. 턴마다(system/init) 오고, 세션 중간에
  // 커맨드 목록이 바뀌면(system/commands_changed) 한 번 더 온다.
  //
  // 2.6.2는 이 값을 **디스크에서 스캔**했다(src/main/mcp.ts·skills.ts가 ~/.claude.json과
  // .claude/skills를 읽는다). 그건 "설정에 뭐가 적혀 있나"이지 "지금 이 대화에 뭐가
  // 붙어 있나"가 아니다 — 연결 실패도, 승인 안 된 .mcp.json도, 플러그인이 들고 온
  // 스킬도 디스크만 봐서는 모른다. 3.0은 와이어가 말하는 것만 싣는다.
  | { type: 'tooling'; runId: string; tooling: ChatTooling }

/** 이 채팅에 붙어 있는 MCP 서버 하나 (`system/init`의 `mcp_servers[]`). */
export interface McpLive {
  name: string // 설정된 서버 이름 (.mcp.json / ~/.claude.json의 키)
  // CLI가 보고하는 연결 상태. 실측: 'connected' · 'failed'. 타입 선언상 가능한 나머지:
  // 'needs-auth' · 'pending' · 'disabled'. 열린 집합으로 다룬다(모르는 값은 그대로 표시).
  //
  // 'off'는 **셸이 만든 값**이다: 설정에서 끈 서버(P1e deniedMcpServers)는 CLI가 아예
  // 안 띄워 `init.mcp_servers`에서 행째로 사라진다 — 그러면 "내가 껐다"와 "설정에 없다"가
  // 구분이 안 돼서, 셸이 자기 denylist로 그 행을 되붙인다.
  status: string
  // 이 서버가 붙인 도구 이름들. `system/init`의 `tools[]`에서 `mcp__<서버>__<도구>`
  // 접두사로 갈라낸 값이라 **추가 왕복이 없다**. 서버 이름은 접두사에서 정규화되므로
  // (비 [A-Za-z0-9_-] → _) 셸이 같은 규칙으로 되맞춘다.
  tools: string[]
}

/** 이 채팅이 쓸 수 있는 스킬 하나. */
export interface SkillLive {
  name: string // `/이름`으로 부르는 그 이름
  description: string // 커맨드 사전의 설명 (스코프 접미사는 떼어 scope로 옮겼다)
  // 설명 꼬리의 `(user)`/`(project)` 표식에서 갈라낸 값. 내장 스킬처럼 표식이 없으면 null.
  scope: 'user' | 'project' | 'local' | 'plugin' | null
  // 설정에서 끈 스킬(P1e skillOverrides). MCP의 status:'off'와 같은 이유로 셸이 되붙인 행이다.
  off?: boolean
}

/** 한 채팅의 도구 환경 스냅샷 — 패널 헤더 칩·팝오버가 그리는 값 전체. */
export interface ChatTooling {
  cwd: string // 이 스냅샷이 어느 폴더의 것인가 (패널마다 다른 이유 그 자체)
  mcp: McpLive[]
  skills: SkillLive[]
  // 이 세션에 로드된 플러그인 (`system/init`의 `plugins[]`). 스킬·MCP를 함께 들고 오는
  // 출처라 팝오버 꼬리에 한 줄로 적는다.
  plugins: { name: string; version: string | null }[]
}

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
  // resume와 함께 켜면 그 세션을 '이어쓰기'가 아니라 '포크'한다 — 원본 세션 파일은 그대로
  // 두고 새 세션 id로 컨텍스트만 복제(SDK forkSession). /btw 질문 창의 첫 실행이 쓴다.
  // claude 전용 — Codex app-server엔 포크가 없다(렌더러가 애초에 켜지 않는다).
  forkSession?: boolean
  systemPrompt?: string // 채팅/패널별 프롬프트 — appended to the preset system prompt every run
  // 참조 폴더 — 작업 폴더(cwd) 외에 엔진이 작업 루트로 인식할 추가 폴더들.
  // claude: SDK additionalDirectories(CLI --add-dir). codex: 샌드박스 쓰기 루트
  // (sandbox_workspace_write.writable_roots) + developerInstructions 안내로 대응.
  addDirs?: string[]
  // true → 이 실행은 구독(OAuth) 대신 저장된 API 키로 과금한다 (컴포저의 API 토글).
  // 엔진이 하위 CLI에 ANTHROPIC_API_KEY를 주입하고, result 이벤트에 viaApi로 표시한다.
  useApi?: boolean
  // 이 실행이 소비할 클로드 구독 계정(계정 picker의 이메일). 엔진이 그 계정의 격리
  // CLAUDE_CONFIG_DIR을 물질화해 주입한다 — 미지정이면 기본 계정, useApi가 켜져 있으면 무시.
  account?: string
  // Codex 실행이 소비할 OpenAI 계정 — 미지정이면 기본 계정. 엔진이 그 계정의 격리
  // CODEX_HOME으로 app-server를 띄운다 (engine==='codex'일 때만 의미).
  codexAccount?: string
  // ★3.0.4 — 화면에 그린 사용자 말풍선 원문·첨부와 보낸 창의 라벨. 셸이 `user-echo`를
  // **보낸 창만 빼고** 같은 대화를 그리는 다른 창(팝아웃 그리드·자리 밖 수집기)에 뿌릴 때
  // 쓴다 — 없으면 에코하지 않는다. `prompt`(멘션·첨부 안내가 붙은 전송분)와 다르다.
  echoText?: string
  echoImages?: string[]
  echoFrom?: string
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

/** 패널 팝아웃 창의 상태 꾸러미 — 열 때(부트)와 닫힐 때(복귀) 같은 모양으로 오간다.
 *  picker·queue·snapshot은 렌더러 소유 타입이라 여기선 불투명(unknown)으로 나른다
 *  (maSave 블롭과 같은 규칙 — 검증은 렌더러의 sanitize가 담당). */
export interface PanelPopState {
  panelId: string
  slot: number
  num: number // 팝아웃 시점의 자리 번호 — 창 헤더 번호 칩 표기용
  title: string
  custom: boolean
  locked: boolean
  color: string
  cwd: string
  refDirs: string[]
  picker: unknown
  api: boolean
  input: string
  images: string[]
  queue: unknown[]
  snapshot: unknown
}
/** main→메인 창: 팝아웃 창 닫힘 통지 — flush는 그 창의 마지막 페르시스트(없으면 null) */
export interface PanelPopClosed {
  panelId: string
  flush: PanelPopState | null
}
/** 세션 마운트 시점의 팝아웃 현황 — open은 아직 떠 있는 창들, leftovers는 그 세션 화면이
 *  내려가 있는 동안 닫힌 창들의 미회수 복귀분(조회가 곧 소비 — 두 번 적용되지 않는다) */
export interface PanelPopStates {
  open: string[]
  leftovers: PanelPopState[]
}

// ── 파일 뷰어 독립 창 (3.0) ───────────────────────────────────
/** 어느 창 → main → 뷰어 창: 파일 하나를 별도 OS 창의 뷰어로. "창은 자리, 파일은 페이로드" —
 *  그 파일 하나에 필요한 것만 싣는다(세션 전체 diffs가 아니라 그 파일의 diff 하나). */
export interface ViewerOpenPayload {
  path: string // 호출 창의 cwd 기준 상대 경로(또는 절대 경로) — 카드 뷰어의 path prop 그대로
  cwd: string
  diff: FileDiff | null // 이 파일의 누적 diff(있으면 변경 마킹) — 카드 뷰어의 diffs[path]
  override: { content: string | null; diff: FileDiff | null; label: string | null } | null // Git 카드 스냅샷
  askable: boolean // 호출 창에 채팅이 있어 질문 패널(드래그 선택 → 질문)을 쓸 수 있는가
}
/** 뷰어 창 → main → 원래 창: 질문 패널에서 보낸 질문(카드 뷰어의 onAskSelection 인자와 같다) */
export interface ViewerAskPayload {
  path: string
  text: string
  from: number | null
  to: number | null
  question: string
}
/** main → 전 창: 끈적한 모드(파일 열기가 전부 독립 창으로 가는가) */
export interface ViewerMode {
  window: boolean
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
  /** 새 채팅·계정 미지정 채팅이 쓰는 계정인가.
   *  ★R28 ACCT §4 — 3.0에서 이것은 **저장된 상태가 아니라 파생값**이다: 목록의 **맨 위**
   *  (=설정 ▸ Account의 사용자 정렬 순서 0번)가 언제나 참이다. 2.6.2와의 의도적 분기이고
   *  `docs/renderer-divergence.md` §6에 기록돼 있다. */
  isDefault: boolean
  /**
   * ★M11 R3(F2) — 이 계정의 토큰 교환이 실패해 **재로그인이 필요해 보인다**.
   *
   * 3.0 전용 · 선택 필드다(2.6.2 main은 안 싣는다 = `undefined`라 화면이 그대로다).
   * 값의 출처는 `~/.agentcodegui/account-health.json`(`ccg-auth::health`)이고, 자동 전환
   * 워커가 `TokenLost`/401·403을 만난 순간 적는다. 재로그인하면 크리덴셜 지문이 달라져
   * 표식이 스스로 무효가 된다 — 화면도 같은 판정을 쓰므로 따로 지울 것이 없다.
   */
  needsLogin?: boolean
}

/** 등록된 OpenAI(Codex) 계정 1건 — Anthropic과 동일한 문법(앱 등록 계정만, 기본 계정). */
export interface CodexAccountInfo {
  email: string
  plan: string | null // 'plus' · 'pro' · 'free' 등 (id_token의 chatgpt_plan_type)
  /** ★R28 ACCT §4 — Anthropic과 같은 규약: **목록 맨 위**가 곧 기본(파생값). */
  isDefault: boolean
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
  /** ★R28 ACCT — 3.0 전용 표식(2.6.2 main은 안 싣는다 = `undefined`).
   *  `stale`  : 값은 있지만 **방금 물어본 값이 아니다**(캐시로 갈음).
   *  `unavailable`: 물어보지 못했고 갈음할 값도 없다 — 「한도 0」과 구분된다. */
  stale?: boolean
  unavailable?: boolean
}

/**
 * ★R28 ACCT §1 — `auth:accounts-usage(opts?)`의 선택 옵션. **없으면 2.6.2와 동일**하다.
 *
 * 규약(1200ms 직렬·TTL 2분·429 백오프)은 그대로 두고, **UI가 그걸 기다리지 않게** 하는
 * 세 개의 문이다. 자세한 근거는 `src-tauri/src/ipc/parity/usage.rs`의 §1 절.
 */
export interface AccountsUsageOpts {
  /** HTTP를 한 번도 안 쏘고 디스크 캐시만 그린다 — 첫 페인트(stale-while-revalidate). */
  cachedOnly?: boolean
  /** 이 계정을 **맨 먼저** 조회한다. 응답 순서(=등록 순서)는 바뀌지 않는다. */
  priority?: string
  /** 선행 워밍 — 로컬 액세스 토큰이 살아 있는 계정만 조회한다(토큰 회전 유발 금지). */
  warm?: boolean
  /** ★R28 ACCT R2(F5) — **사람이 「다시 시도」를 눌렀다.** 연속 실패로 3분 격리된 계정도
   *  이 표식이 있으면 조회가 나간다(격리는 벌이 아니라 직렬 큐 보호용 우회이므로,
   *  사람이 기다리기로 한 조회까지 막을 이유가 없다). 자동 경로는 이 문을 안 지난다.
   *  `cachedOnly`와 함께 오면 캐시 팔이 이긴다(HTTP 0회의 계약이 더 강하다). */
  retry?: boolean
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
  model: string // 표시 모델명 (Claude: 'Opus 5' 꼴, Codex: 모델 id 그대로)
}

/**
 * API 모드 실행 1건의 기록 (설정 → API 통계의 원장 한 줄).
 * 메인이 ~/.agentcodegui/api-usage.jsonl 에 실행이 끝날 때마다 append 한다.
 * 토큰 수치는 SDK result의 누적 usage(그 실행 전체 합).
 */
export interface ApiUsageRecord {
  ts: number // unix ms — 실행이 끝난 시각
  model: string // 표시 모델명 (예: 'Opus 5') — 알 수 없으면 picker 별칭
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
  // ★3.0 — **조회 자체가 실패했다**(계정/토큰 없음·전송 오류·비200이고 캐시도 없음).
  // 위 네 창이 전부 null인 값은 "한도가 없다"와 "못 물어봤다"를 구분할 수 없어서, 한도
  // 자동 이어서의 2단 재검증이 조회 실패를 「풀렸다」로 오판하고 자동 전송을 했다
  // (최종 파리티 R1 확인 크리틱 실패1). 값의 모양은 그대로 두고 표식만 얹는다 —
  // 2.6.2 본체는 이 키를 내지 않고, 없으면 판정은 "창이 하나도 없다"로 떨어진다.
  unavailable?: boolean
  // 신선 조회가 실패해 **낡은 캐시**로 갈음한 값. 값이 있으므로 판정은 그대로 하고
  // (그게 마지막 실측이다) 진단·하네스가 실패 경로를 확인하는 데 쓴다.
  stale?: boolean
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
  // /btw로 만들어진 질문 채팅이면 원본(일반 채팅) id — 그 채팅 화면의 btw 알약 도크가
  // 이 값으로 자기 것만 골라 그린다. 일반 추가 채팅은 없음.
  btwOf?: string
  // 창이 지금 화면에 보이는 상태인지(떠 있고 최소화 아님). btw 알약은 창이 보이는 동안엔
  // 숨고, 최소화/닫힘(숨김 상주 포함)일 때만 뜬다 — 창과 알약이 동시에 보이지 않게.
  shown?: boolean
}

/** /btw — 현재 대화의 컨텍스트를 포크해 별도 질문 창(추가 채팅)으로 여는 요청.
 *  fork가 없으면(세션 없음·폴더 불일치·Codex) 컨텍스트 없이 새 대화로 연다. */
export interface BtwOpenRequest {
  origin: string // 원본 채팅 id ('' = 메인이 sender로 보완 — 추가 채팅 창에서 부른 경우)
  originTitle?: string | null // 원본 채팅/패널의 제목 — btw 채팅 이름이 'BTW - <이 제목>'이 된다
  cwd: string
  refDirs?: string[]
  picker?: unknown // 원본 채팅의 모델·모드·계정 스냅샷 — 창이 sanitize해서 복원
  fork?: string | null // 포크 소스 세션 id (claude 전용)
  forkCwd?: string | null // 그 세션의 폴더 — 창에서 폴더를 바꾸면 포크를 접는 가드
  prompt?: string | null // '/btw 질문' 꼴의 인라인 질문 — 창이 열리자마자 자동 전송
}

// ── 포커스 밖 알림 (토스트) ──────────────────────────────────────────────────
// 창이 포커스를 잃은 사이 턴이 끝나거나(done/error) AI가 기다리기 시작하면(approve/ask)
// 커서가 있는 모니터 우하단에 작은 토스트 창을 띄운다. 표시 여부 판정(창 비포커스 +
// 설정 on/off)은 메인 프로세스가 한다 — 렌더러는 전이만 알린다.
export type NotifyKind = 'done' | 'error' | 'approve' | 'ask'

/** 토스트 클릭 라우팅 대상 — single=메인 창 일반 채팅, multi=멀티 세션(메인 창),
 *  session=추가 채팅(독립 창, id=영속 채팅 id — 메인이 sender로 채운다).
 *  sub: 같은 대상 안의 구분(멀티 패널 슬롯) — 업서트 키에만 쓰고 라우팅엔 안 쓴다. */
export interface NotifyTarget {
  surface: 'single' | 'multi' | 'session'
  id: string
  sub?: string
}

export interface NotifyEventPayload {
  kind: NotifyKind
  title: string // 채팅/패널 제목 ('' = 토스트가 '새 채팅'으로 표시)
  preview?: string // 답변 첫 줄·승인 요약·질문 본문 등 미리보기 한 줄
  target: NotifyTarget
}

/** 토스트 페이지에 보내는 표시 항목(REPLACE 목록, 최신이 앞) — key는 창·대상별 업서트
 *  키로, 클릭(notifyOpen)이 이 키로 라우팅을 되찾는다. */
export interface NotifyEntry extends NotifyEventPayload {
  key: string
}

/** 트레이 우클릭 메뉴(커스텀 팝업 창)의 항목 — 라벨은 main이 표시 시점 언어로 채운다 */
export interface TrayMenuItem {
  id: 'open' | 'quit'
  label: string
}

/** 세션 창 렌더러 → 메인: 이 창의 대화 저장(디바운스/닫기 flush). 스냅샷 모양은
 *  렌더러(SessionState)가 소유하고 메인은 그대로 저장만 한다. empty = 메시지 0 —
 *  창을 닫을 때 목록에 남기지 않는 판정용. */
export interface SessionPersistPayload {
  title: string
  status: AgentStatus
  cwd: string
  refDirs?: string[] // 참조 폴더 — cwd 외 추가 작업 루트 (RunRequest.addDirs로 전달)
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
  refDirs?: string[]
  picker?: unknown
  draft?: string
  draftImages?: string[]
  // /btw 질문 창의 시드 — btw: 이 창이 btw로 만들어졌다는 표식(안내 칩·기본 제목),
  // btwTitle: 레코드 제목('BTW - 원본 제목') — 창 헤더·알림이 이 이름을 쓴다,
  // btwFork/btwForkCwd: 첫 실행이 포크할 원본 세션(자기 세션이 생기기 전까지만 의미),
  // btwPrompt: 자동 전송할 인라인 질문 — 메인이 '읽으면 소비'로 한 번만 내려준다.
  btw?: boolean
  btwTitle?: string
  btwFork?: string
  btwForkCwd?: string
  btwPrompt?: string
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
  // Esc/중지의 소프트 중단 — 턴만 끊고 CLI·백그라운드(셸·워크플로·에이전트)는 상주 유지.
  // cancel(프로세스째 종료)은 /clear·폴더 전환·계정 전환처럼 정말 갈아엎는 경로 전용.
  runInterrupt: 'claude:interrupt',
  permissionRespond: 'claude:permission-respond',
  questionRespond: 'claude:question-respond',
  bgTask: 'claude:bg-task', // 백그라운드 작업 컨트롤 (중지 / 포그라운드 전부 백그라운드로)
  // multi-agent — a pool of independent engines, one per on-screen panel. Each command
  // carries a panelId so the main side routes it to that panel's engine; events come
  // back wrapped with the panelId on the shared maEvent channel.
  maRun: 'ma:run',
  maCancel: 'ma:cancel',
  maInterrupt: 'ma:interrupt', // 패널 Esc/중지의 소프트 중단 (runInterrupt와 같은 규칙)
  maPermissionRespond: 'ma:permission-respond',
  maQuestionRespond: 'ma:question-respond',
  maBgTask: 'ma:bg-task', // 패널 WorkBar의 백그라운드 셸 컨트롤(중지/Ctrl+B) — 그 패널 엔진으로
  maDispose: 'ma:dispose', // cancel + drop a panel's engine (panel removed)
  maGet: 'ma:get', // load the persisted multi-agent workspace (layout + panel snapshots)
  maSave: 'ma:save', // persist the multi-agent workspace so it survives a restart
  maLoadSession: 'ma:load-session', // read one saved session (지연 로드 — 비활성 세션 패널은 메모리에 없다)
  // 패널 팝아웃 창 — 멀티 패널 하나를 별도 OS 창으로(크게 보기의 창 버전, 듀얼 모니터용).
  // 엔진은 그대로 메인의 패널 풀(panelId)이고, 그 panelId의 maEvent가 이 창에도 팬아웃된다.
  // 창을 닫으면 마지막 페르시스트(초안·메타·스냅샷)가 메인 창으로 되돌아와 그리드에 복귀한다.
  maPanelOpen: 'ma:panel-open', // 메인 창 → 팝아웃 창 열기 (부트 페이로드 동봉)
  maPanelHydrate: 'ma:panel-hydrate', // 팝아웃 창 → 자기 부트 페이로드 조회 (마운트 복원)
  maPanelPersist: 'ma:panel-persist', // 팝아웃 창 → 자기 상태 저장 (디바운스 — 닫힘 때 메인 창 복귀분)
  maPanelFocus: 'ma:panel-focus', // 메인 창 → 열린 팝아웃 창을 앞으로 (유령 클릭)
  maPanelClose: 'ma:panel-close', // 메인 창 → 팝아웃 창 닫기 (closed가 복귀 통지를 담당)
  maPanelStates: 'ma:panel-states', // 메인 창 마운트 → 이 세션의 열린 팝아웃 + 미회수 복귀분 조회(소비)
  maPanelLeftoverClear: 'ma:panel-leftover-clear', // 메인 창 → 라이브로 회수한 복귀분의 잔여 사본 폐기
  // 파일 뷰어 독립 창 — 코드 뷰어 카드를 별도 OS 창으로(듀얼 모니터: 한쪽은 IDE, 한쪽은 코드).
  // 끈적한 모드: 「별도 창으로」 한 번이면 이후 모든 파일 열기가 그 창으로, 「창 안으로」까지.
  // 파일을 닫으면 창은 숨김(부수지 않음) — 다음 파일이 같은 자리에 창 생성 비용 없이 뜬다.
  viewerState: 'viewer:state', // 어느 창 → main: 끈적한 모드 조회(부팅 페이로드에도 실린다)
  viewerSetMode: 'viewer:set-mode', // 어느 창 → main: 모드 전환 → viewerMode 브로드캐스트
  viewerOpen: 'viewer:open', // 어느 창 → main: 파일 하나를 뷰어 창으로(창이 없으면 생성) · main → 뷰어 창: 그 페이로드
  viewerHydrate: 'viewer:hydrate', // 뷰어 창 → main: 마운트/재로드 복원분(닫은 뒤면 null)
  viewerShown: 'viewer:shown', // 뷰어 창 → main: 파일을 그렸다 — 이제 창을 보여도 된다(빈 창 번쩍임 방지)
  viewerHide: 'viewer:hide', // 뷰어 창 → main: 파일을 닫았다 — 창은 숨긴다
  viewerDock: 'viewer:dock', // 뷰어 창 → main: 「창 안으로」 — 모드 해제 + 원래 창의 카드 뷰어로 되돌림
  viewerAsk: 'viewer:ask-selection', // 뷰어 창 → main → 원래 창: 질문 패널 전송(원래 창의 채팅으로)
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
  sessionInterrupt: 'session:interrupt', // 추가 채팅 Esc/중지의 소프트 중단 (runInterrupt와 같은 규칙)
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
  // /btw — 현재 대화의 컨텍스트를 포크(SDK forkSession)해 별도 질문 창으로. 원본 채팅에는
  // 흔적이 남지 않고, 원본 화면 하단의 btw 알약이 창을 되부른다(창=추가 채팅 인프라 재사용).
  btwOpen: 'btw:open',
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
  authReorderAccounts: 'auth:reorder-accounts', // (emails) 계정 표시 순서 변경(꾹-드래그) — 새 목록 반환
  // Codex(OpenAI) 계정 — Anthropic과 동일한 문법: 앱 등록 계정만, 전역 ~/.codex 불가침
  codexListAccounts: 'codex-auth:list-accounts', // 등록 계정 목록 + 기본 표시
  codexLogin: 'codex-auth:login', // `codex login` (격리 CODEX_HOME 브라우저 OAuth) — 완료 시 편입 + 새 목록
  codexLogout: 'codex-auth:logout', // (email) 그 계정 auth 제거 + 등록 삭제 — 새 목록 반환
  codexSetDefaultAccount: 'codex-auth:set-default-account', // (email) 기본 계정 지정 — 새 목록
  codexLoginCancel: 'codex-auth:login-cancel',
  codexAccountsUsage: 'codex-auth:accounts-usage', // 등록 계정별 한도(rateLimits) 일괄 조회
  codexReorderAccounts: 'codex-auth:reorder-accounts', // (emails) 계정 표시 순서 변경(꾹-드래그) — 새 목록
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
  chatLoad: 'chats:load', // read one chat's saved file (지연 로드 — 비활성 스냅샷은 메모리에 없다)
  uiPrefsGet: 'ui-prefs:get', // load renderer UI prefs blob (viewer size/zoom, chat zoom)
  uiPrefsSave: 'ui-prefs:save', // persist the whole UI prefs blob to ~/.agentcodegui
  uiGlassChanged: 'ui-glass:changed', // 유리(벽지 비침) 값 브로드캐스트 → 전 창 틴트 동기화
  uiLangChanged: 'ui-lang:changed', // UI 언어(ko/en) 브로드캐스트 → 전 창 표시 언어 동기화
  skillList: 'skill:list', // enumerate global + project skills with their on/off state
  skillSetEnabled: 'skill:set-enabled', // turn a skill on/off (persisted to the app home)
  mcpList: 'mcp:list', // enumerate user + project + local MCP servers with on/off state
  mcpSetEnabled: 'mcp:set-enabled', // turn an MCP server on/off (persisted to the app home)
  shellOpenPath: 'shell:open-path', // open a file with the OS default app
  shellRevealPath: 'shell:reveal-path', // reveal a file/folder in the OS file manager (Explorer/Finder)
  shellOpenExternal: 'shell:open-external', // ★3.0.4 open an http(s) URL in the OS browser (2.6.2 shell.openExternal)
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
  gitRepos: 'git:repos', // 저장소 발견 — cwd 위 1곳 + 아래 얕은 걷기(깊이 3, 무거운 폴더 제외)
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
  maPanelClosed: 'ma:panel-closed', // main→메인 창: 팝아웃 창이 닫힘 (마지막 페르시스트 동봉 — 그리드 복귀)
  talkEvent: 'talk:event', // streamed events from the 채팅 (pure conversation) engine
  sessionEvent: 'session:event', // streamed events from a session window's own engine
  sessionWindowsChanged: 'session-wins:changed', // main→메인 창: 추가 채팅 목록 변경
  sessionFlushRequest: 'session-wins:flush-request', // main→세션 창: 닫기 전 마지막 스냅샷 저장 요청
  engineUpdateEvent: 'engine:update-event', // main→렌더러: 부팅 자동 업데이트 진행(REPLACE 스냅샷)
  engineInstallProgress: 'engine:install-progress',
  lspInstallProgress: 'lsp:install-progress', // streamed progress while downloading a language server
  winState: 'win:state',
  viewerMode: 'viewer:mode', // main→전 창: 뷰어 끈적한 모드 변경(어느 창이 바꿨든 다음 클릭이 같은 답)
  viewerDocked: 'viewer:docked', // main→원래 창: 「창 안으로」로 되돌아온 파일(카드 뷰어로 연다)
  // 포커스 밖 알림 (토스트 창) — 렌더러가 전이를 알리고, 메인이 비포커스 판정·표시·라우팅
  notifyEvent: 'notify:event', // 렌더러→main: 턴 종료/승인 대기/질문 발생
  notifyOpen: 'notify:open', // 토스트→main: 항목 클릭 — 해당 창 포커스 + 점프
  notifyClose: 'notify:close', // 토스트→main: ✕ — 전부 지우고 닫기
  notifyResize: 'notify:resize', // 토스트→main: 콘텐츠 높이 보고 → 창 크기 확정 + 표시
  notifyShow: 'notify:show', // main→토스트: 표시할 항목 목록(REPLACE, 최신이 앞)
  notifyJump: 'notify:jump', // main→메인 창: 클릭 라우팅(뷰 전환 + 채팅/세션 선택)
  // 트레이 우클릭 메뉴 — 네이티브 Win32 메뉴가 투박해 창=카드로 직접 그린다(토스트 패턴)
  trayMenuShow: 'traymenu:show', // main→메뉴 페이지: 항목 목록(표시 시점 언어)
  trayMenuResize: 'traymenu:resize', // 메뉴 페이지→main: 콘텐츠 높이 보고 → 위치 확정 + 표시
  trayMenuAction: 'traymenu:action', // 메뉴 페이지→main: 클릭한 항목 id ('' = Esc 닫기)

  // ══ 3.0 통합 채팅(chats-v3) — docs/design/ux-chat-unify.md §6.1의 32채널 ══════
  // ★ 이 블록은 **순수 추가**다. 위의 2.6.2 채널은 한 글자도 바뀌지 않았고, 아래 채널은
  //   Rust 쪽에서 `CCG_UNIFIED_STORE=1` 옵트인으로만 배선된다(기본은 옛 3스토어 경로).
  //   이름 자체를 여기 먼저 두는 이유: 문자열의 단일 소스가 갈리면 그 채널만 조용히
  //   미구현으로 떨어진다(디스패처는 미러다).
  //
  //   구현 상태(M2 라운드): 스토어 4 + 보드 3 = **7채널 구현**,
  //   실행 8 · 정체성/큐 5 · 창 자리 4 · 이벤트 8은 **이름만**(M-LOGIC·M4 소관).

  // ── 실행 (8) — M-LOGIC 소관. chatId 하나가 주소다(ChatRef 없음, §1.3)
  chatRun: 'chat:run',
  chatInterrupt: 'chat:interrupt', // 소프트 중단 (턴만; 상주 유지)
  chatCancel: 'chat:cancel', // 프로세스째 (/clear·폴더 전환·계정 전환 전용)
  chatPermission: 'chat:permission', // 매칭 키 = requestId
  chatAnswer: 'chat:answer', // answers=null → 무응답 해제
  chatRespondDialog: 'chat:respond-dialog', // 폴백 다이얼로그
  chatBgTask: 'chat:bg-task',
  chatDispose: 'chat:dispose', // 엔진 회수 (채팅 삭제·유휴 스윕)
  // ── 정체성·큐·원장 (5) — M-LOGIC 소관
  chatIdentityGet: 'chat:identity-get',
  chatIdentitySet: 'chat:identity-set', // patch는 **서브필드 단위**(RawIdentityPatch)
  chatIdentityRevert: 'chat:identity-revert',
  chatQueueMutate: 'chat:queue-mutate',
  chatForceSettle: 'chat:force-settle',
  // ★M9 R2 — 도구 환경(MCP·스킬) **재조회**. 푸시(EngineEvent{type:'tooling'})와 같은
  // 값을 같은 함수가 만든다. 주소는 `{chatId}` 또는 `{panelId}`(멀티 패널의 칩은 자기
  // chatId를 모르고 보드 자리 키만 안다). 답은 `ChatTooling | null` — null은 "MCP 없음"이
  // 아니라 **"아직 모름"**(런타임 없음 · system/init 전)이고, 화면은 그때 칩을 안 세운다.
  // 셸의 메모리에만 있는 값이라 앱 재시작 뒤에는 항상 null이다(지난주 목록을 되살리지
  // 않는다는 M9의 원칙 — 스냅샷을 디스크에 절이지 않는 이유 그 자체).
  chatToolingGet: 'chat:tooling-get',
  // ── 스토어 (4) — M2 구현. chats:get/save/load는 2.6.2와 **같은 이름**이라
  //    플래그가 켜지면 별칭 어댑터가 앞에서 가로챈다(§6.2).
  chatsSetActive: 'chats:set-active', // ★ 즉시 — 저장 디바운스와 무관(§6.2 U3)
  // ── 보드 (3) — M2 구현
  boardGet: 'board:get',
  boardLoad: 'board:load',
  boardSave: 'board:save',
  // ── 창 자리 (4) — M4(창) 소관
  winChatOpen: 'win:chat-open', // 추가채팅 + 팝아웃 + btw 통합
  winChatClose: 'win:chat-close',
  winChatFocus: 'win:chat-focus',
  winChatList: 'win:chat-list',
  // ── 이벤트 (8) — main → 렌더러
  chatEvent: 'chat:event', // { chatId, event } 봉투 (ma:event의 일반화)
  chatIdentityEvent: 'chat:identity',
  chatQueueEvent: 'chat:queue', // 큐 전체 REPLACE
  chatRunState: 'chat:run-state', // 상태기계 상태 + 라이브 원장 REPLACE
  chatVerdict: 'chat:verdict', // 거부/큐잉 사유
  chatStatus: 'chat:status', // ★ 전 채팅 경량 상태 REPLACE (§4.3)
  chatWindows: 'chat:windows', // 창 자리 목록 REPLACE
  chatFlushReq: 'chat:flush-req' // 창 닫기 전 마지막 저장 요청
  // ★R28k — 대화 연결(M10)의 `crosstalk:*` 넷이 여기 있었다. 사용자 결정으로 기능을
  //   전면 제거하면서 함께 걷었다(아래 타입 블록도 같이). `talkGet`/`talkSave`는 **남는다**
  //   — 그 둘은 1.x의 은퇴한 "채팅 모드" 블롭이고 M10과 무관한 파리티 항목이다.
} as const

/* ══════════════════════════════════════════════════════════════════════════
 * 3.0 통합 채팅 — 저장 스키마와 계약 타입 (순수 추가)
 *
 * 근거 문서: docs/design/ux-chat-unify.md §1.2·§4 / docs/design/m-logic.md §2.
 * 2.6.2 렌더러는 이 타입을 하나도 참조하지 않는다 — 얼려 둔 화면의 타입체크를 깨지
 * 않는 게 이 블록의 계약이다.
 * ══════════════════════════════════════════════════════════════════════════ */

// ── 실행 정체성 (m-logic §2.2·§2.5) ──────────────────────────
/** 엔진별로 의미가 다른 축(모델 id 공간·계정 스토어)을 태그드 유니온으로 묶는다.
 *  평평하게 두면 "codexModel은 claude일 때 무시" 같은 암묵 규칙이 비교식에 스며든다. */
export type EngineAxis =
  | { kind: 'claude'; model: ModelId; effort: EffortId }
  | { kind: 'codex'; model: string; effort: EffortId; account?: string | null }

/** 과금·자격 경로. `api_mode` 불리언 + `account` 문자열 두 필드로 두면
 *  "useApi면 account 무시"라는 규칙이 비교식 밖에 남는다 → 하나로 접는다. */
export type BillingAxis =
  | { kind: 'subscription'; account: string; dropEnvKey: boolean } // 실 이메일(기본 계정도 해석해 채운다)
  | { kind: 'api_key'; keyFp: string } // ★ 지문만 — 키 원문은 계약면에 절대 오르지 않는다

/** 도구 정책 축 — 스폰 시점 settings 플래그로 굳는다. */
export interface ToolPolicyAxis {
  skillOverrides: Record<string, 'disabled'> // 정렬된 키
  deniedMcp: string[] // 정렬·중복제거
}

/** **채팅 파일에 저장되는 완전 지정 원시 정체성**(물질화 — m-logic §2.4).
 *  모든 축이 키로 존재한다. 값은 아직 미해석일 수 있다(빈 cwd = 앱 기본,
 *  account:null = 기본 계정). 마이그레이션 무손실 비교의 **1차 키**가 이 객체의
 *  정준 직렬화다(O12 수정판). 부분 override 필드는 **없다** — "미지정"이라는 상태가
 *  저장 스키마에 존재하지 않으므로 전역 pref가 정체성에 개입할 수 없다. */
export interface RawIdentity {
  engine: { kind: EngineId; model: string; effort: EffortId; codexAccount?: string | null }
  billing: { kind: 'subscription' | 'api_key'; account?: string | null; dropEnvKey?: boolean }
  cwd: string
  addDirs: string[]
  mode: ModeId
  systemPrompt: string | null
  outputStyle: string | null
  tools: { skillOverrides: Record<string, 'disabled'>; deniedMcp: string[] }
}

/** **서브필드 단위 부분 패치.** 없는 키 = 건드리지 않음.
 *  ★ `engine.kind`를 지정하면 `engine.model`을 반드시 함께 지정해야 한다(모델 id 공간이 갈린다).
 *  ★ `billing.keyFp`는 여기 없다 — 키 원문이 계약면에 오르지 않으므로 Rust가 저장된 키에서 계산한다. */
export interface RawIdentityPatch {
  engine?: { kind?: EngineId; model?: string; effort?: EffortId; codexAccount?: string | null }
  billing?: { kind?: 'subscription' | 'api_key'; account?: string; dropEnvKey?: boolean }
  cwd?: string
  addDirs?: string[] // 전체 교체(집합이라 서브필드가 없다)
  mode?: ModeId
  systemPrompt?: string | null
  outputStyle?: string | null
  tools?: {
    skillOverrides?: Record<string, 'disabled' | null> // null = 그 키를 지운다
    deniedMcp?: Record<string, boolean> // true = 차단, false = 해제
  }
}

/** Rust가 정규화해 돌려주는 확정 정체성. 렌더러는 이 값을 **그대로 그린다**(재해석 금지). */
export interface RunIdentity {
  engine: EngineAxis
  billing: BillingAxis
  cwd: string
  addDirs: string[] // 정렬·중복제거된 정규 경로
  mode: ModeId
  systemPrompt: string | null
  outputStyle: string | null
  tools: ToolPolicyAxis
  hash: string // 16바이트 hex — 큐 항목·리비전·로그가 참조하는 키
}

/** 리프 경로 15개 — diff·정착 사유·드리프트 보고·UI 문구의 어휘. */
export type IdentityField =
  | 'engine.kind'
  | 'engine.model'
  | 'engine.effort'
  | 'engine.codexAccount'
  | 'billing.kind'
  | 'billing.account'
  | 'billing.dropEnvKey'
  | 'billing.keyFp'
  | 'cwd'
  | 'addDirs'
  | 'mode'
  | 'systemPrompt'
  | 'outputStyle'
  | 'tools.skillOverrides'
  | 'tools.deniedMcp'

/** 축 8개 — 문구를 뭉칠 때만 쓴다(`'engine.model' → 'engine'`). */
export type IdentityAxis = 'engine' | 'billing' | 'cwd' | 'addDirs' | 'mode' | 'systemPrompt' | 'outputStyle' | 'tools'

// ── 채팅 · 보드 저장 스키마 (ux-chat-unify §1.2·§4.1) ────────
/** 한도 소진 대기표 — 2.6.2는 훅 인스턴스마다 흩어져 있던 것이 채팅에 붙는다.
 *  **Rust 소유 필드**(저장 시 되끼움). `ready`는 영속하지 않는다(발화 재검증이 판정). */
export interface LimitHold {
  key: string // 소유 채팅 id
  engine: EngineId
  account?: string
  resetsAt: number | null // unix 초 (null = 리셋 시각 미상 → 프로브)
  fable: boolean
  lastPrompt: string
  at: number // 장전 시각(ms) — 24시간 만료 판정
}

/** 예약 큐 항목 — 프롬프트 + **정체성 스냅샷**(m-logic §7.1). */
export interface QueuedMessage {
  id: string
  text: string
  images: string[]
  identity?: RawIdentity // 장전 시점 스냅샷 — 착지에서 드리프트 판정
}

/** 통합 채팅 — 유일한 진실. 실행 상태·초안·큐·정체성이 전부 여기 붙는다.
 *  파일: `~/.agentcodegui/chats-v3/<id>.json`. */
export interface UnifiedChat {
  id: string // ★ 주소는 이 문자열 하나뿐이다 (§1.3)
  title: string
  custom: boolean
  locked: boolean // ※ 2.6.2 일반 채팅엔 없던 필드 — 마이그레이션이 기본값 주입
  color: string // ※ 동상 ('' = 기본색)
  identity: RawIdentity // ★ Rust 소유 — chats:save에 실려 와도 되끼워진다
  queue?: QueuedMessage[] // ★ Rust 소유
  hold?: LimitHold // ★ Rust 소유
  draft?: string
  draftImages?: string[]
  btwOf?: string
  btwSeed?: { fork: string; cwd: string }
  btwPrompt?: string
  empty?: boolean // 메시지 0 — 디스크 skip 판정
  lastSeenAt?: number // 읽지 않음 계산용 (3.0.0 미사용)
  updatedAt?: number
  snapshot?: unknown // 스레드 스냅샷(SessionState) — 마커일 땐 null
  unloaded?: boolean // 스냅샷이 메모리에 없음 (chats.ts 규약 그대로)
  /** 과도기 표식 — 어느 옛 스토어에서 왔는가. 별칭 계층이 "어디까지 지워도 되는지"를
   *  판단하는 데만 쓴다(2.6.2 렌더러가 목록을 셋으로 나눠 들기 때문). 통합 UI가 서면
   *  별칭 계층과 함께 사라진다. */
  origin?: 'chat' | 'panel' | 'session'
}

/** 자리 배치(2.6.2 `PersistedSession`의 후신). 파일: `~/.agentcodegui/boards/<id>.json`. */
export type BoardChrome = 'ide' | 'grid'
export interface Board {
  id: string
  title: string
  custom: boolean
  count: number // 다이얼 1~6
  chrome: BoardChrome // count=1의 기본은 'ide'
  order: number[] // 자리 순열(길이 6). 앞 count개가 보이는 자리
  slots: (string | null)[] // 길이 6. 인덱스=슬롯 정체성, 값=chatId
  updatedAt?: number
}

/* ── (제거됨) M10 대화 연결 ─────────────────────────────────────────────
 * 2026-08-26 사용자 결정으로 3.0에서 **전면 제거**. 여기 있던 `TalkResult`·`TalkSent`·
 * `TalkConfig`·`CROSSTALK` 넷과 `crosstalk:*` 채널 넷, 그리고 notice 이벤트의
 * `talk?: TalkSent` 필드를 함께 걷었다. 소비처는 제거 시점에 0이었다.
 *
 * 사유(요약): 안전은 닫혔으나(실 CLI 공격 26표본 0뚫림) 기능이 모델 재량에 좌우돼
 * 정당한 왕복 완성률이 같은 exe·같은 문면으로 18~93%를 오갔고, 제품 기본값 팔에서
 * 평범한 인사에 앱의 고정 거절 문장이 3/11로 붙었다. 다섯 라운드의 실측은
 * docs/m10-report-*.md와 docs/design/m10-talk.md에 철회 헤더와 함께 남아 있다.
 *
 * ★혼동 주의: 위쪽 `talkGet`/`talkSave`는 **1.x의 은퇴한 "채팅 모드" 블롭**이고
 * M10과 무관한 파리티 항목이다 — 그 둘은 살아 있다. */

/** 마커 채팅도 항상 갖는 경량 상태 — 스냅샷이 아니다(§4.3).
 *  파일은 `chats-v3/status.json` **하나**이고 쓰기 주인은 **Rust**다(렌더러는 읽기만). */
export interface ChatStatusLite {
  chatId: string
  status: AgentStatus
  /** ★R28 ACCT §3 — 이 채팅이 **지금 물고 있는 구독 계정**(3.0 전용 · 선택 필드).
   *
   *  키가 있으면 **살아 있는 런타임**이라는 뜻이다 — 정확히는 *"busy 턴 중이거나 상주
   *  CLI가 살아 있다"*(§3의 정의 그대로). 계정 picker·설정 ▸ Account의 「사용 중 · N번
   *  자리」 칩이 이 값 하나로 선다 — 창이 여럿이라(본채팅·멀티·추가 창·팝아웃) 렌더러가
   *  모은 표로는 자기 창밖을 못 보기 때문이다. API 키 실행은 구독 한도를 안 태우므로 없다.
   *
   *  ★R2(F1) — 그 문장을 **코드로** 참으로 만든 자리가 셋이다: `engine/lite.rs`의 생존
   *  판정 · `ccg_store::status`(디스크에 안 쓰고 부팅 장전에서 걷어낸다) ·
   *  `hub::Op::Dispose`(회수하면 뗀다). R1은 이 값이 `status.json`에 영속돼, 턴을 한 번
   *  돌린 채팅이 **이후 모든 부팅에서** 계정을 물었다(확인 크리틱 R1 F1). */
  account?: string | null
  /** ★R28 ACCT §3 — 이 채팅이 앉은 **멀티 보드 자리**(`${boardId}::${slot}`) · 3.0 전용.
   *  「2번 자리」 문구가 이 값에서 나온다(대응의 진실은 보드 스토어라 렌더러가 못 잇는다).
   *
   *  ★R2(F4) — 본채팅은 **없음**이다. `chrome:"ide"` 보드(= 본채팅 화면)는 자리로 세지
   *  않는다 — R1은 본채팅도 `default::0`이라 칩이 「1번 자리」였고 멀티 첫 자리와 문구가
   *  충돌했다. 자리에 안 앉은 채팅(본채팅·추가 창)의 이름표는 렌더러가 안다. */
  panelId?: string | null
  /** ★3.0.5 — 그 자리의 **보이는 번호**(1‥N, 보드 `order` 앞 `count`개 안의 위치). 「N번 자리」의 N.
   *  `panelId`의 슬롯 인덱스는 정체성이라 드래그로 옮겨도 안 변한다 — 번호는 이 값으로 그린다.
   *  접힌 자리·자리 없음은 `null`. */
  seat?: number | null
  busy: boolean // 원시 상태(전송 게이트)
  bgActive: boolean // 라이브 원장이 비었나 → 완료 링 판정(effectiveStatus 단일 소스)
  ask: 'none' | 'permission' | 'question' | 'dialog'
  hold: { resetAt: number | null; ready: boolean } | null // ★ 파생 요약 — 진실은 <chatId>.json
  queued: number // 예약 큐 길이 — 동상
  unread: number // ★ 3.0.0에서는 항상 0 (필드 예약 — 열린 문제 ⑪)
  updatedAt: number
}

/** `chats:get` 인자 — 없으면 light=true. */
export interface ChatsGetOptions {
  light?: boolean
  /** 열린 창의 채팅 — light 조회 (b). 이 목록은 스냅샷을 싣는다. */
  openChatIds?: string[]
}

/** `chats:get` 응답 — `index.json` + `status.json`을 합쳐서 준다. */
export interface UnifiedChatsBlob {
  version: number
  chats: UnifiedChat[]
  activeChatId: string
  statuses: Record<string, ChatStatusLite>
}

/** `board:get` 응답. */
export interface BoardsBlob {
  version: number
  boards: Board[]
  activeBoardId: string
}

/** 창 자리 하나(§1.2 `Slot{kind:'window'}`) — `win:chat-list` / `chat:windows`. */
export interface WindowSlotInfo {
  label: string // OS 창 라벨(창 레지스트리의 키)
  chatId: string
  title: string
  focused: boolean
}
