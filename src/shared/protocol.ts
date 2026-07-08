/* ============================================================
 * Shared protocol — contracts between main & renderer processes.
 * Keep this file dependency-free (types + const only).
 * ============================================================ */

// ── Picker enums (UI ⇄ engine) ───────────────────────────────
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
  output?: string // captured output tail (Bash) — rendered as a collapsible inline log
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

// ── Git (탐색기 Git 카드) ─────────────────────────────────────
export type GitFileStatus = 'M' | 'A' | 'D' | 'R'
export interface GitChange {
  path: string // 레포 루트 기준 posix 경로
  status: GitFileStatus
  add: number | null // numstat 증감 (바이너리/미상 = null)
  del: number | null
}
export interface GitStatus {
  root: string // 레포 최상위 절대 경로
  branch: string // 현재 브랜치 (detached면 짧은 해시)
  ahead: number
  behind: number
  changes: GitChange[]
  branches: { name: string; current: boolean }[]
  remotes: string[]
  tags: string[] // 최신순, 최대 20개
}
export interface GitCommit {
  hash: string
  shortHash: string
  subject: string
  body: string
  author: string
  date: number // unix ms
  tags: string[] // 이 커밋을 가리키는 태그들
  pushed: boolean // 업스트림에 반영됐는지 (업스트림 없으면 true)
}
export interface GitFileAt {
  content: string | null // 커밋 시점 파일 내용 (바이너리/너무 큼/삭제 = null)
  diff: FileDiff | null // 부모→커밋 whole-file diff (뷰어 변경 마킹용)
  error?: string
}
export interface GitOpResult {
  ok: boolean
  error?: string
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
  | { type: 'tool-end'; runId: string; id: string; status: 'done' | 'error'; result?: string; output?: string; links?: WebLink[] }
  | { type: 'todos'; runId: string; todos: Todo[] }
  // `whole` = a full-file Write (the diff supersedes any accumulated diff for this
  // path); false for incremental Edit/MultiEdit (merges onto the existing diff)
  | { type: 'file-change'; runId: string; file: ChangedFile; diff: FileDiff; whole: boolean }
  | { type: 'terminal'; runId: string; line: TermLine }
  | { type: 'subagent'; runId: string; agent: SubAgentInfo }
  | {
      type: 'permission-request'
      runId: string
      requestId: string
      toolName: string
      summary: string
    }
  // the agent called AskUserQuestion → surface an interactive choice card
  | { type: 'question-request'; runId: string; requestId: string; questions: AgentQuestion[] }
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
    }
  // live context-token estimate emitted per assistant turn (before the final result)
  | { type: 'context'; runId: string; contextTokens: number }
  // Fable 5가 안전 정책으로 응답을 거부(stop_reason 'refusal')해 엔진이 CLI처럼 폴백
  // 모델로 자동 전환·재시도한 경우. 렌더러는 경고 배너를 스레드에 표시하고, 거부된
  // 쪽의 스트리밍 부분 답변(retractMessageId)을 지우고, 모델 picker를 toModel로 바꾼다.
  | {
      type: 'model-fallback'
      runId: string
      fromModel: string // raw model id, e.g. claude-fable-5
      toModel: string // raw model id, e.g. claude-opus-4-8
      text: string // ready-to-render Korean warning line
      retractMessageId: string | null // 거부된 쪽이 스트리밍하던 메시지 id (없으면 null)
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
  resume?: string // session id to resume — carries this chat's conversation history
  systemPrompt?: string // 채팅/패널별 프롬프트 — appended to the preset system prompt every run
  // true → 이 실행은 구독(OAuth) 대신 저장된 API 키로 과금한다 (컴포저의 API 토글).
  // 엔진이 하위 CLI에 ANTHROPIC_API_KEY를 주입하고, result 이벤트에 viaApi로 표시한다.
  useApi?: boolean
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

// ── Window ───────────────────────────────────────────────────
export interface WindowState {
  maximized: boolean
}
export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}
/** Which edge/corner of the frameless window a resize grabs. */
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
/** Snap-layout target: 반쪽(left/right) · 쿼터(tl/tr/bl/br) · 최대화(max). */
export type SnapZone = 'left' | 'right' | 'tl' | 'tr' | 'bl' | 'br' | 'max'

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
}

/** 어떤 화면의 엔진이 실행했는지 — 사용 통계의 분류 축. */
export type ApiUsageSource = 'chat' | 'ask' | 'talk' | 'ma'

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
  // /ask — an independent, throwaway conversation that runs on its OWN engine
  // instance so it never cancels or pollutes the main chat (same payload shapes).
  askRun: 'ask:run',
  askCancel: 'ask:cancel',
  askPermissionRespond: 'ask:permission-respond',
  askQuestionRespond: 'ask:question-respond',
  // multi-agent — a pool of independent engines, one per on-screen panel. Each command
  // carries a panelId so the main side routes it to that panel's engine; events come
  // back wrapped with the panelId on the shared maEvent channel.
  maRun: 'ma:run',
  maCancel: 'ma:cancel',
  maPermissionRespond: 'ma:permission-respond',
  maQuestionRespond: 'ma:question-respond',
  maDispose: 'ma:dispose', // cancel + drop a panel's engine (panel removed)
  maGet: 'ma:get', // load the persisted multi-agent workspace (layout + panel snapshots)
  maSave: 'ma:save', // persist the multi-agent workspace so it survives a restart
  // 채팅 — a pure-conversation workspace on its OWN engine instance (like /ask but
  // persistent, with its own conversation list). No project folder, explorer, or tools UI.
  talkRun: 'talk:run',
  talkCancel: 'talk:cancel',
  talkPermissionRespond: 'talk:permission-respond',
  talkQuestionRespond: 'talk:question-respond',
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
  pickDirectory: 'dialog:pick-directory',
  pickAttachments: 'dialog:pick-attachments', // open dialog filtered to attachable files (images + text); returns absolute paths
  saveAttachmentData: 'attachment:save-data', // persist pasted/dropped raw attachment bytes to a temp file; returns its path
  getUsage: 'usage:get',
  apiConfigGet: 'api-config:get', // API 키/예산/누적 사용액 스냅샷 (키 원문 제외)
  apiConfigSetKey: 'api-config:set-key', // API 키 저장 (safeStorage 암호화)
  apiConfigClearKey: 'api-config:clear-key', // 저장된 API 키 삭제
  apiConfigSetBudget: 'api-config:set-budget', // 예산(USD) 설정 (null = 없음)
  apiConfigResetSpend: 'api-config:reset-spend', // 누적 사용액 0으로 리셋 (재충전 시)
  apiUsageList: 'api-usage:list', // API 모드 실행 원장 (설정 → API 통계)
  profileGet: 'profile:get', // load the saved local user profile (or null)
  profileSave: 'profile:save', // persist nickname + avatar color
  chatsGet: 'chats:get', // load the saved chat list + active id (or null)
  chatsSave: 'chats:save', // persist the chat list so conversations survive a restart
  uiPrefsGet: 'ui-prefs:get', // load renderer UI prefs blob (viewer size/zoom, chat zoom)
  uiPrefsSave: 'ui-prefs:save', // persist the whole UI prefs blob to ~/.agentcodegui
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
  closeShortcut: 'shortcut:close', // Ctrl+W pressed (main swallows it) → renderer closes the open viewer
  listFiles: 'fs:list-files', // enumerate project files for the "@" mention palette
  listDir: 'fs:list-dir', // list one folder's entries for the file explorer (lazy per expand)
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
  winMinimize: 'win:minimize',
  winMaximizeToggle: 'win:maximize-toggle',
  winClose: 'win:close',
  winIsMaximized: 'win:is-maximized',
  winGetBounds: 'win:get-bounds',
  winSetBounds: 'win:set-bounds',
  winDragStart: 'win:drag-start',
  winDragEnd: 'win:drag-end',
  winResizeStart: 'win:resize-start',
  winResizeEnd: 'win:resize-end',
  engineListAvailable: 'engine:list-available',
  engineState: 'engine:state',
  engineInstall: 'engine:install',
  engineUninstall: 'engine:uninstall',
  engineSetActive: 'engine:set-active',
  engineCleanup: 'engine:cleanup', // 최신 설치본만 남기고 이전 버전 폴더 전부 삭제

  // git — 탐색기의 Git 카드 (읽기 + 커밋/푸시/풀)
  gitRoot: 'git:root', // cwd → 레포 최상위(.git 상위 탐색 포함), 없으면 null
  gitStatus: 'git:status', // 브랜치·ahead/behind·작업 트리 변경·브랜치/원격/태그 목록
  gitLog: 'git:log', // 커밋 목록 (푸시 여부 포함)
  gitCommitDetail: 'git:commit-detail', // 한 커밋의 변경 파일 + 증감
  gitFileAt: 'git:file-at', // 커밋 시점의 파일 내용 + 부모→커밋 diff (뷰어 마킹용)
  gitWorkingFile: 'git:working-file', // 작업 트리 파일의 HEAD→디스크 diff (뷰어 마킹용)
  gitCommit: 'git:commit', // add -A + commit
  gitPush: 'git:push',
  gitPull: 'git:pull', // --ff-only
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
  askEvent: 'ask:event', // streamed events from the /ask engine (separate channel)
  maEvent: 'ma:event', // streamed events from every multi-agent engine (wrapped with panelId)
  talkEvent: 'talk:event', // streamed events from the 채팅 (pure conversation) engine
  sessionEvent: 'session:event', // streamed events from a session window's own engine
  engineInstallProgress: 'engine:install-progress',
  lspInstallProgress: 'lsp:install-progress', // streamed progress while downloading a language server
  winState: 'win:state'
} as const
