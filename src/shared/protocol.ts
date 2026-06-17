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

export interface ToolLogItem {
  id: string // tool_use id
  verb: string // display label: Search / Read / Write / Edit / Bash / Task …
  kind: ToolKind
  target: string // file path or command summary
  status: 'running' | 'done' | 'error'
  result?: string // short result summary once finished
  output?: string // captured output tail (Bash) — rendered as a collapsible inline log
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
  id: string // 'ts' | 'py' | 'cs' | 'cpp'
  label: string // server display name, e.g. 'C#'
  langs: string // covered languages, e.g. 'TypeScript · JavaScript'
  exts: string // covered extensions, e.g. '.cs .csx'
  kind: 'bundled' | 'download'
  // bundled = ships with the app (always available) · none = not yet downloaded
  state: 'bundled' | 'none' | 'installing' | 'installed'
  requires?: string // external prerequisite note, e.g. '.NET SDK(dotnet) 필요'
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
  | { type: 'tool-end'; runId: string; id: string; status: 'done' | 'error'; result?: string; output?: string }
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

// ── Rate-limit usage (from the OAuth usage API) ──────────────
export interface UsageWindow {
  pct: number // 0-100
  resetsAt: number | null // unix seconds
}
export interface UsageInfo {
  fiveHour: UsageWindow | null
  weekly: UsageWindow | null
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
  pickDirectory: 'dialog:pick-directory',
  pickImages: 'dialog:pick-images', // open dialog filtered to image files; returns absolute paths
  saveImageData: 'image:save-data', // persist pasted/dropped raw image bytes to a temp file; returns its path
  getUsage: 'usage:get',
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
  lspPrewarm: 'lsp:prewarm', // warm up a project's server/compile-DB before the first file open
  lspProjectStatus: 'lsp:project-status', // aggregate analysis state for a folder (explorer badge)
  lspInstall: 'lsp:install', // download a native language server (C#/C++) on user request
  lspServers: 'lsp:servers', // list every known language server + provisioning state (settings)
  lspInstallServer: 'lsp:install-server', // download a server by id (settings)
  lspUninstallServer: 'lsp:uninstall-server', // stop + delete a downloaded server (settings)
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
  engineInstallProgress: 'engine:install-progress',
  lspInstallProgress: 'lsp:install-progress', // streamed progress while downloading a language server
  winState: 'win:state'
} as const
