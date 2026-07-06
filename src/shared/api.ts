import type {
  RunRequest,
  PermissionResponse,
  QuestionResponse,
  MultiRunRequest,
  MultiPermissionResponse,
  MultiQuestionResponse,
  EngineEvent,
  WindowState,
  WindowBounds,
  ResizeEdge,
  UsageInfo,
  ApiConfigStatus,
  ApiUsageRecord,
  UserProfile,
  EngineVersionEntry,
  EngineVersionState,
  EngineInstallProgress,
  EngineCleanupResult,
  FileReadResult,
  FileWriteResult,
  DirEntry,
  SkillInfo,
  McpServerInfo,
  UpdateStatus,
  LspStatus,
  LspProjectStatus,
  LspPos,
  LspHoverResult,
  LspLocation,
  LspSemanticTokens,
  LspCompletionList,
  LspResolvedCompletion,
  VerseRegistrySnapshot,
  LspInstallProgress,
  LspServerInfo,
  GitStatus,
  GitCommit,
  GitChange,
  GitFileAt,
  GitOpResult
} from './protocol'

/** The surface exposed to the renderer via `window.api` (contextBridge). */
export interface WindowApi {
  run(req: RunRequest): Promise<string>
  cancel(): Promise<void>
  respondPermission(res: PermissionResponse): Promise<void>
  respondQuestion(res: QuestionResponse): Promise<void>
  pickDirectory(): Promise<string | null>
  /** open a file dialog filtered to attachable files (images + readable text); returns the chosen absolute paths */
  pickAttachments(): Promise<string[]>
  /** persist raw attachment bytes (a pasted screenshot / browser-dragged file with no path) to a
   *  temp file in the app home and return its absolute path, so it can be shown + attached */
  saveAttachmentData(bytes: ArrayBuffer, ext: string): Promise<string>
  /** resolve the absolute filesystem path of a dragged-in File (Electron webUtils) */
  pathForFile(file: File): string
  /** 구독 사용량 (한도·추가 크레딧). 기본은 5분 캐시 — fresh=true는 15초 바닥만 지키고
   *  새로 받아온다 (실행 종료·컨텍스트 팝오버 열기 등 "지금 값"이 필요한 순간용) */
  getUsage(fresh?: boolean): Promise<UsageInfo>
  /** API 키 과금 설정 (설정 → API + 컴포저 API 토글). 모든 호출이 최신 스냅샷을 돌려준다. */
  apiConfig: {
    get(): Promise<ApiConfigStatus>
    /** API 키 저장 — 메인이 safeStorage로 암호화해 보관 (원문은 렌더러로 안 돌아옴) */
    setKey(key: string): Promise<ApiConfigStatus>
    clearKey(): Promise<ApiConfigStatus>
    /** 예산(USD) 설정 — null이면 예산 없음(누적 사용액만 표시) */
    setBudget(usd: number | null): Promise<ApiConfigStatus>
    /** 누적 사용액을 0으로 리셋 (재충전 시 기준점 재설정) */
    resetSpend(): Promise<ApiConfigStatus>
    /** API 모드 실행 원장(최근 2만 건) — 설정 → API의 통계가 집계한다 */
    listUsage(): Promise<ApiUsageRecord[]>
  }
  /** load the saved local user profile, or null when none has been set */
  getProfile(): Promise<UserProfile | null>
  /** persist the local user profile (nickname + avatar color) */
  saveProfile(profile: UserProfile): Promise<void>
  /** load the persisted chat list blob (renderer-owned shape), or null when none */
  getChats(): Promise<unknown>
  /** persist the chat list blob so conversations survive a restart */
  saveChats(data: unknown): Promise<void>
  /** load the renderer UI prefs blob (viewer size/zoom, chat zoom) from the app home folder */
  getUiPrefs(): Promise<Record<string, unknown>>
  /** persist the whole UI prefs blob to ~/.agentcodegui/ui-prefs.json */
  saveUiPrefs(prefs: Record<string, unknown>): Promise<void>
  /** open a file (cwd-relative) with the OS default app */
  openPath(cwd: string, relPath: string): Promise<void>
  /** reveal (highlight) a file/folder in the OS file manager — explorer "파일 탐색기에서 보기" */
  revealPath(cwd: string, relPath: string): Promise<void>
  /** rename a file/folder within its parent — explorer context menu */
  renamePath(cwd: string, relPath: string, newName: string): Promise<{ ok: boolean; error?: string }>
  /** move a file/folder to the OS trash (recycle bin) — explorer context menu */
  deletePath(cwd: string, relPath: string): Promise<{ ok: boolean; error?: string }>
  /** create a new empty file (dir=false) or folder (dir=true) — explorer context menu */
  createPath(cwd: string, relPath: string, dir: boolean): Promise<{ ok: boolean; error?: string }>
  /** move a file/folder to a new path within the project — explorer drag & drop */
  movePath(cwd: string, srcRel: string, destRel: string): Promise<{ ok: boolean; error?: string }>
  /** read a file's text content (cwd-relative or absolute) for the in-app viewer card */
  readFile(cwd: string, relPath: string): Promise<FileReadResult>
  /** overwrite a file's text content (cwd-relative or absolute) from the in-app editor */
  writeFile(cwd: string, relPath: string, content: string): Promise<FileWriteResult>
  /** Ctrl+W was pressed (main blocks the app-close) — fired so the open viewer can close itself */
  onCloseShortcut(cb: () => void): () => void
  /** enumerate project files (relative POSIX paths) to power the "@" mention palette */
  listFiles(cwd: string): Promise<string[]>
  /** list one folder's entries (folders first) for the file explorer — `rel` is cwd-relative ('' = root).
   *  `exclude` = files.exclude globs and `hideEmpty` together give the "Verse 위주로 보기" filtered tree. */
  listDir(cwd: string, rel: string, exclude?: string[], hideEmpty?: boolean): Promise<DirEntry[]>
  /** git — 탐색기의 Git 카드 (히스토리·변경 사항·커밋/푸시/풀) */
  git: {
    /** cwd가 속한 레포 최상위(.git 상위 폴더 탐색 포함), 없으면 null — cwd별 캐시 */
    root(cwd: string, force?: boolean): Promise<string | null>
    /** 브랜치·ahead/behind·작업 트리 변경·브랜치/원격/태그 목록 */
    status(root: string): Promise<GitStatus | null>
    /** 커밋 목록 (푸시 여부 포함) */
    log(root: string, limit?: number): Promise<GitCommit[]>
    /** 한 커밋의 변경 파일 + 증감 */
    commitDetail(root: string, hash: string): Promise<GitChange[]>
    /** 커밋 시점 파일 내용 + 부모→커밋 diff — 뷰어가 그 시점을 그대로 보여줄 때 */
    fileAt(root: string, hash: string, path: string): Promise<GitFileAt>
    /** 작업 트리 파일의 HEAD→디스크 diff — 뷰어 마킹용 (내용은 디스크에서 읽음) */
    workingFile(root: string, path: string): Promise<GitFileAt>
    /** add -A 후 커밋 */
    commit(root: string, subject: string, body: string): Promise<GitOpResult>
    push(root: string): Promise<GitOpResult>
    /** --ff-only 풀 */
    pull(root: string): Promise<GitOpResult>
  }
  /** LSP code intelligence for the in-app viewer (lazy per-project language servers) */
  lsp: {
    /** current status for a file — asking also warms up the project's server */
    status(cwd: string, relPath: string): Promise<LspStatus>
    /** hover info (markdown) for the symbol at an LSP (0-based) position. `text` is the live editor
     *  buffer — pass it so hover reflects unsaved edits (e.g. a freshly-typed function). */
    hover(cwd: string, relPath: string, pos: LspPos, text?: string): Promise<LspHoverResult | null>
    /** definition target(s) for the symbol at an LSP (0-based) position. `text` is the live editor
     *  buffer — pass it so jumping to a just-typed (unsaved) symbol resolves against on-screen content. */
    definition(cwd: string, relPath: string, pos: LspPos, text?: string): Promise<LspLocation[]>
    /** semantic highlighting tokens for a document — null when unsupported */
    semanticTokens(cwd: string, relPath: string): Promise<LspSemanticTokens | null>
    /** disk-cached tokens for instant paint on open (no server spawn) — null when none */
    cachedTokens(cwd: string, relPath: string): Promise<LspSemanticTokens | null>
    /** completion candidates at an LSP (0-based) position. `text` is the live editor buffer —
     *  completion needs the unsaved partial word, which isn't on disk yet. Null = no candidates. */
    completion(cwd: string, relPath: string, pos: LspPos, text: string): Promise<LspCompletionList | null>
    /** lazy docs for a completion candidate (completionItem/resolve) — `gen`은 completion()이 준
     *  목록 세대, `ri`는 후보의 원본 인덱스. 낡은 세대·미지원 서버·문서 없음이면 null. */
    resolveCompletion(cwd: string, relPath: string, gen: number, ri: number): Promise<LspResolvedCompletion | null>
    /** warm a project's server / compile-DB before the first file is opened */
    prewarm(cwd: string): Promise<void>
    /** eagerly open a specific file on its server so indexing finishes before the first completion */
    warm(cwd: string, relPath: string): Promise<void>
    /** accurate Verse type registry (kinds/supers/members/enum values) for a file's project, for colouring.
     *  `knownRev`(마지막으로 받은 세대)와 같으면 reg=null 스냅샷만 와 페이로드를 아낀다 */
    verseRegistry(cwd: string, relPath: string, knownRev?: number): Promise<VerseRegistrySnapshot | null>
    /** aggregate analysis state for a folder (explorer badge: analyzing/ready + percent) */
    projectStatus(cwd: string): Promise<LspProjectStatus>
    /** Verse API digest folders to show as view-only roots in the explorer (mirrors UEFN's
     *  VS Code view): the project's packages — Verse source + Verse.org/Fortnite.com/… digests —
     *  as { path, name }. [] when `cwd` isn't a generated Verse project. */
    verseDigests(cwd: string): Promise<{ path: string; name: string }[]>
    /** files.exclude globs for the "Verse 위주로 보기" filter (UEFN .code-workspace + defaults).
     *  [] when `cwd` isn't a Verse project — the filter toggle then stays hidden. */
    verseExcludes(cwd: string): Promise<string[]>
    /** download this file's native language server (C#/C++) — user-initiated */
    install(cwd: string, relPath: string): Promise<{ ok: boolean; error?: string }>
    /** subscribe to streamed server-download progress (returns an unsubscribe fn) */
    onInstallProgress(cb: (p: LspInstallProgress) => void): () => void
    /** list every known language server + provisioning state (설정 ▸ 코드 분석) */
    servers(): Promise<LspServerInfo[]>
    /** download a server by id (settings tab) */
    installServer(id: string): Promise<{ ok: boolean; error?: string }>
    /** stop every running instance of a downloaded server and delete it from disk */
    uninstallServer(id: string): Promise<{ ok: boolean; error?: string }>
    /** open a file dialog to choose Verse.vsix / verse-lsp.exe — returns the path or null */
    pickVerseServer(): Promise<string | null>
    /** configure the Verse server from a vsix/exe path (extracts/copies the binary) */
    setVersePath(p: string): Promise<{ ok: boolean; error?: string }>
    /** forget the configured Verse server (stop it + delete the prepared binary) */
    clearVersePath(): Promise<{ ok: boolean; error?: string }>
  }
  win: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<boolean>
    close(): Promise<void>
    isMaximized(): Promise<boolean>
    getBounds(): Promise<WindowBounds>
    setBounds(bounds: WindowBounds): Promise<void>
    /** begin/end a manual title-bar drag (frameless window moved from the main process) */
    dragStart(): Promise<void>
    dragEnd(): Promise<void>
    /** begin/end a manual edge resize — the main process samples the live cursor so
     *  it never feeds back on itself the way renderer pointer events can */
    resizeStart(edge: ResizeEdge): Promise<void>
    resizeEnd(): Promise<void>
  }
  /** Claude Code engine (SDK) version management. */
  engine: {
    listAvailable(): Promise<{ latest: string | null; versions: EngineVersionEntry[] }>
    state(): Promise<EngineVersionState>
    install(version: string): Promise<{ ok: boolean; error?: string }>
    uninstall(version: string): Promise<void>
    setActive(version: string | null): Promise<void>
    /** 최신 설치본만 남기고 이전 버전을 모두 삭제 (설정 ▸ Claude Code ▸ 정리) */
    cleanup(): Promise<EngineCleanupResult>
    onInstallProgress(cb: (p: EngineInstallProgress) => void): () => void
  }
  /** Agent skills (SKILL.md). Listed by scope; toggled on/off from Settings. */
  skill: {
    /** enumerate global (~/.claude) + project (.claude/skills for `cwd`) skills */
    list(cwd: string): Promise<SkillInfo[]>
    /** turn a skill on/off by name — applied to subsequent runs by the engine */
    setEnabled(name: string, enabled: boolean): Promise<void>
  }
  /** MCP servers. Listed by scope (user/project/local); toggled on/off from Settings. */
  mcp: {
    /** enumerate user (~/.claude.json) + project (.mcp.json) + local servers for `cwd` */
    list(cwd: string): Promise<McpServerInfo[]>
    /** turn an MCP server on/off by name — applied to subsequent runs by the engine */
    setEnabled(name: string, enabled: boolean): Promise<void>
  }
  /** "/ask" — an independent throwaway conversation on its own engine instance, so it
   *  never cancels or mixes into the main chat. Same payload shapes, separate channel. */
  ask: {
    run(req: RunRequest): Promise<string>
    cancel(): Promise<void>
    respondPermission(res: PermissionResponse): Promise<void>
    respondQuestion(res: QuestionResponse): Promise<void>
    /** subscribe to the /ask engine's streaming events (returns an unsubscribe fn) */
    onEvent(cb: (event: EngineEvent) => void): () => void
  }
  /** 채팅 — a pure-conversation workspace on its own dedicated engine + persistence.
   *  No project folder, explorer, or tools UI; its own conversation list, separate from
   *  the single-agent chats. Same payload shapes as the main chat, separate channel. */
  talk: {
    run(req: RunRequest): Promise<string>
    cancel(): Promise<void>
    respondPermission(res: PermissionResponse): Promise<void>
    respondQuestion(res: QuestionResponse): Promise<void>
    /** load the persisted chat-workspace conversations blob (renderer-owned shape), or null */
    getState(): Promise<unknown>
    /** persist the chat-workspace conversations so they survive a restart */
    saveState(data: unknown): Promise<void>
    /** subscribe to the 채팅 engine's streaming events (returns an unsubscribe fn) */
    onEvent(cb: (event: EngineEvent) => void): () => void
  }
  /** Multi-agent — a pool of independent engines, one per on-screen panel, all running
   *  in parallel. Each command names its panel; events arrive on a shared channel and
   *  are delivered per-panel by `onEvent(panelId, …)`. */
  multi: {
    run(req: MultiRunRequest): Promise<string>
    cancel(panelId: string): Promise<void>
    respondPermission(res: MultiPermissionResponse): Promise<void>
    respondQuestion(res: MultiQuestionResponse): Promise<void>
    /** stop a panel's run and release its engine (the panel was removed) */
    dispose(panelId: string): Promise<void>
    /** load the persisted multi-agent workspace blob (layout + panel snapshots), or null */
    getState(): Promise<unknown>
    /** persist the multi-agent workspace blob so it survives a restart */
    saveState(data: unknown): Promise<void>
    /** subscribe to one panel's streaming engine events (returns an unsubscribe fn) */
    onEvent(panelId: string, cb: (event: EngineEvent) => void): () => void
  }
  /** App metadata + auto-update (electron-updater, GitHub Releases). */
  app: {
    /** the running app version (package.json `version`) */
    getVersion(): Promise<string>
    /** the folder passed via "AgentCodeGUI로 열기" at launch — returned once, then cleared */
    getInitialDirectory(): Promise<string | null>
    /** the current auto-update state + log — used to seed the UI on mount (no missed events) */
    getUpdateStatus(): Promise<UpdateStatus>
    /** manually trigger an update check */
    checkForUpdate(): Promise<void>
    /** quit and install an already-downloaded update */
    installUpdate(): Promise<void>
    /** a folder opened via "AgentCodeGUI로 열기" while the app was already running */
    onOpenDirectory(cb: (dir: string) => void): () => void
    /** subscribe to the full auto-update state on every change (returns an unsubscribe fn) */
    onUpdateEvent(cb: (status: UpdateStatus) => void): () => void
  }
  /** Subscribe to streaming engine events. Returns an unsubscribe fn. */
  onEngineEvent(cb: (event: EngineEvent) => void): () => void
  onWinState(cb: (state: WindowState) => void): () => void
}
