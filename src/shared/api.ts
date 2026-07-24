import type {
  RunRequest,
  PermissionResponse,
  QuestionResponse,
  BgTaskRequest,
  MultiRunRequest,
  MultiPermissionResponse,
  MultiQuestionResponse,
  EngineEvent,
  WindowState,
  UsageInfo,
  ApiConfigStatus,
  AuthStatus,
  AccountInfo,
  AccountUsage,
  CodexAccountInfo,
  CodexAccountUsage,
  ApiUsageRecord,
  UserProfile,
  EngineVersionEntry,
  EngineVersionState,
  EngineInstallProgress,
  EngineCleanupResult,
  CodexModelInfo,
  FileReadResult,
  FileWriteResult,
  DirEntry,
  SkillInfo,
  McpServerInfo,
  UpdateStatus,
  LspStatus,
  LspProjectStatus,
  AgentStatus,
  SessionWindowInfo,
  SessionPersistPayload,
  SessionHydrateData,
  EngineUpdateStatus,
  LspPos,
  LspHoverResult,
  LspLocation,
  LspSemanticTokens,
  LspCompletionList,
  LspResolvedCompletion,
  VerseRegistrySnapshot,
  LspFilesChangedEvent,
  LspInstallProgress,
  LspServerInfo,
  GitStatus,
  GitLogResult,
  GitFileDiffResult,
  GitCommitDetail,
  GitBranch,
  GitResult,
  GitAiMessageResult,
  ModelId,
  EffortId,
} from './protocol'

/** The surface exposed to the renderer via `window.api` (contextBridge). */
export interface WindowApi {
  run(req: RunRequest): Promise<string>
  cancel(): Promise<void>
  respondPermission(res: PermissionResponse): Promise<void>
  respondQuestion(res: QuestionResponse): Promise<void>
  /** 백그라운드 작업 컨트롤 — 중지(stop) / 포그라운드 도구 전부 백그라운드로(background, Ctrl+B 패리티) */
  bgTask(req: BgTaskRequest): Promise<void>
  pickDirectory(): Promise<string | null>
  /** whether an absolute path exists and is a directory — used to validate a saved 작업 폴더 before reusing it */
  dirExists(dir: string): Promise<boolean>
  /** open a file dialog filtered to attachable files (images + readable text); returns the chosen absolute paths */
  pickAttachments(): Promise<string[]>
  /** persist raw attachment bytes (a pasted screenshot / browser-dragged file with no path) to a
   *  temp file in the app home and return its absolute path, so it can be shown + attached */
  saveAttachmentData(bytes: ArrayBuffer, ext: string): Promise<string>
  /** resolve the absolute filesystem path of a dragged-in File (Electron webUtils) */
  pathForFile(file: File): string
  /** 구독 사용량 (한도·추가 크레딧). 기본은 5분 캐시 — fresh=true는 15초 바닥만 지키고
   *  새로 받아온다 (실행 종료·컨텍스트 팝오버 열기 등 "지금 값"이 필요한 순간용).
   *  account: 이 채팅의 실행 계정(picker.account) — 미지정이면 기본 계정 기준으로 조회해,
   *  컨텍스트 팝오버 한도가 실제 소비될 계정 기준이 되게 한다. */
  getUsage(fresh?: boolean, account?: string): Promise<UsageInfo>
  /** 클로드 계정(구독 OAuth) — 앱 등록 계정만 사용, 전역 ~/.claude 불가침 (설정 → Account). */
  auth: {
    /** 계정 추가(로그인) — 격리 폴더 브라우저 OAuth. 완료 시 등록 + 결과 상태 반환.
     *  useConsole=true 면 구독 대신 Anthropic 콘솔(API) 계정으로 로그인한다. */
    login(useConsole?: boolean): Promise<AuthStatus & { ok: boolean }>
    /** 계정 로그아웃 — 그 계정 토큰 해지 + 등록 제거 → 갱신된 목록 */
    logout(email: string): Promise<AccountInfo[]>
    /** 진행 중인 로그인 프로세스를 중단한다 */
    cancelLogin(): Promise<void>
    /** 로그인 OAuth URL 수신 (브라우저가 안 열릴 때 폴백 링크용) */
    onLoginUrl(cb: (url: string) => void): () => void
    /** 등록 계정 목록 — 기본 계정은 isDefault:true */
    listAccounts(): Promise<AccountInfo[]>
    /** 새 채팅·미지정 채팅이 쓸 기본 계정 지정 → 갱신된 목록 */
    setDefaultAccount(email: string): Promise<AccountInfo[]>
    /** 등록 목록에서 계정 제거(토큰 해지 없이 — 해지는 logout) → 갱신된 목록 */
    removeAccount(email: string): Promise<AccountInfo[]>
    /** 등록 계정별 한도 사용률(5시간·주간·Fable) — 각 계정 토큰으로 일괄 조회 */
    accountsUsage(): Promise<AccountUsage[]>
  }
  /** Codex(OpenAI) 계정 — Anthropic과 동일: 앱 등록 계정만, 전역 ~/.codex 불가침 (설정 → Account). */
  codexAuth: {
    /** 등록 계정 목록 — 기본 계정은 isDefault:true */
    listAccounts(): Promise<CodexAccountInfo[]>
    /** 계정 추가 — 격리 CODEX_HOME 브라우저 OAuth. 완료 시 등록 + 갱신된 목록 */
    login(): Promise<CodexAccountInfo[]>
    /** 계정 삭제 — 그 계정 auth 제거 + 등록 삭제 → 갱신된 목록 */
    logout(email: string): Promise<CodexAccountInfo[]>
    /** 새 채팅·미지정 채팅이 쓸 기본 계정 지정 → 갱신된 목록 */
    setDefaultAccount(email: string): Promise<CodexAccountInfo[]>
    cancelLogin(): Promise<void>
    /** 등록 계정별 한도(rateLimits) 일괄 조회 — planType은 표시 플랜으로도 우선 사용 */
    accountsUsage(): Promise<CodexAccountUsage[]>
  }
  /** 두 엔진 CLI 공통 자동 업데이트 — 인자 있으면 설정, 항상 현재 값을 반환 (설정 → Engine → 공통) */
  engineAutoUpdate(enabled?: boolean): Promise<boolean>
  /** 부팅 자동 업데이트 카드 — 메인이 부팅 직후 두 엔진을 설치→활성화→정리하며
   *  진행 스냅샷(REPLACE)을 흘린다. status()는 마운트 때 현재 상태 따라잡기용. */
  engineUpdate: {
    status(): Promise<EngineUpdateStatus>
    onEvent(cb: (s: EngineUpdateStatus) => void): () => void
  }
  /** 세션 창(추가 채팅)에서: 메인 창을 앞으로 가져와 설정 → API 탭을 연다 (키 등록 안내) */
  openApiSettings(): Promise<void>
  /** 메인 창에서: 위 요청 수신 → 설정 모달을 API 탭으로 연다. 반환값은 구독 해제 함수. */
  onApiSettingsRequested(cb: () => void): () => void
  /** API 키 과금 설정 (설정 → API + 컴포저 API 토글). 모든 호출이 최신 스냅샷을 돌려준다. */
  apiConfig: {
    get(): Promise<ApiConfigStatus>
    /** API 키 저장 — 메인이 safeStorage로 암호화해 보관 (원문은 렌더러로 안 돌아옴).
     *  provider 생략 = Anthropic, 'openai' = Codex 실행용 OpenAI 키. */
    setKey(key: string, provider?: 'anthropic' | 'openai'): Promise<ApiConfigStatus>
    clearKey(provider?: 'anthropic' | 'openai'): Promise<ApiConfigStatus>
    /** 예산(USD) 설정 — null이면 예산 없음. Anthropic 전용(Codex는 비용 미보고). */
    setBudget(usd: number | null): Promise<ApiConfigStatus>
    /** 예산 초기화(0원) — 예산을 지우고 누적 사용액도 0으로 (재충전 시) */
    resetBudget(): Promise<ApiConfigStatus>
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
  /** 유리(벽지 비침) 값 변경 구독 — 어느 창에서 바꾸든 전 창이 같은 값을 받는다 */
  onUiGlassChanged(cb: (v: number) => void): () => void
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
  /** ccg-page:// URL for the viewer's rendered HTML preview (registers the serving root) */
  htmlPreviewUrl(cwd: string, relPath: string): Promise<string>
  /** Ctrl+W was pressed (main blocks the app-close) — fired so the open viewer can close itself */
  onCloseShortcut(cb: () => void): () => void
  /** enumerate project files (relative POSIX paths) to power the "@" mention palette */
  listFiles(cwd: string): Promise<string[]>
  /** list one folder's entries (folders first) for the file explorer — `rel` is cwd-relative ('' = root).
   *  `exclude` = files.exclude globs (files+folders) and `hideEmpty` together give the "Verse 위주로 보기"
   *  filtered tree; `excludeDirs` = names hidden for DIRECTORIES ONLY, `excludeFiles` = names/patterns
   *  hidden for FILES ONLY (일반 "빌드·생성물 숨김" — 설정 › Explorer의 두 목록). */
  listDir(
    cwd: string,
    rel: string,
    exclude?: string[],
    hideEmpty?: boolean,
    excludeDirs?: string[],
    excludeFiles?: string[]
  ): Promise<DirEntry[]>
  /** Git — 탐색기 상태 스트립 + Git 카드. 작업 폴더 기준(하위 폴더여도 저장소 루트로 동작),
   *  경로는 전부 루트 기준 포워드 슬래시. .git 없는 폴더는 status가 repo:false로 답해
   *  스트립 자체가 그려지지 않는다. */
  git: {
    /** 브랜치·ahead/behind·변경 파일 목록 — repo 아님이면 repo:false */
    status(cwd: string): Promise<GitStatus>
    /** 히스토리 (HEAD 기준, limit+skip 페이징) — unpushed 표시 포함 */
    log(cwd: string, limit?: number, skip?: number): Promise<GitLogResult>
    /** 워킹트리 파일 diff (HEAD ↔ 디스크) — 뷰어 override용 FileDiff */
    fileDiff(cwd: string, rel: string): Promise<GitFileDiffResult>
    /** 커밋 메타(제목·본문·작성자) + 바뀐 파일 목록 */
    commitDetail(cwd: string, hash: string): Promise<GitCommitDetail | null>
    /** 커밋 시점 파일 내용 + 부모 대비 diff — 뷰어 override(스냅샷)용 */
    commitFileDiff(cwd: string, hash: string, rel: string): Promise<GitFileDiffResult & { content: string | null }>
    /** 고른 파일만 add 후 commit — 실패 시 스테이징 원복 + 사유 반환 */
    commit(cwd: string, files: string[], subject: string, body: string): Promise<GitResult>
    push(cwd: string): Promise<GitResult>
    pull(cwd: string): Promise<GitResult>
    /** 갱신하기 — 원격 상태만 새로 읽는다 (fetch --prune) */
    fetch(cwd: string): Promise<GitResult>
    /** 파일 하나 되돌리기 — 추적 파일은 HEAD로, 미추적 새 파일은 휴지통(복구 가능) */
    discard(cwd: string, rel: string, untracked: boolean): Promise<GitResult>
    branches(cwd: string): Promise<GitBranch[]>
    switchBranch(cwd: string, name: string): Promise<GitResult>
    createBranch(cwd: string, name: string): Promise<GitResult>
    /** AI 커밋 메시지 — 담긴 파일 diff를 읽고 저장소 최근 커밋 톤으로 1회 생성(도구 없는 1턴).
     *  계정·모델·effort는 카드에서 매번 고른다 — 계정마다 남은 한도가 달라서(앱의 계정 문법). */
    aiMessage(
      cwd: string,
      files: string[],
      opts?: { account?: string; model?: ModelId; effort?: EffortId }
    ): Promise<GitAiMessageResult>
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
    /** 코드 파일 변화 브로드캐스트 구독 — 열린 뷰어가 멈춘 토큰 폴링을 다시 깨운다.
     *  (C#: 새/수정 파일의 타입은 main의 재프라임 뒤 요청부터 색이 들어온다) */
    onFilesChanged(cb: (e: LspFilesChangedEvent) => void): () => void
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
  }
  /** Claude Code engine (SDK) version management. */
  engine: {
    listAvailable(): Promise<{ latest: string | null; versions: EngineVersionEntry[] }>
    state(): Promise<EngineVersionState>
    install(version: string): Promise<{ ok: boolean; error?: string }>
    uninstall(version: string): Promise<void>
    setActive(version: string | null): Promise<void>
    /** 최신 설치본만 남기고 이전 버전을 모두 삭제 (설정 ▸ Engine ▸ 정리) */
    cleanup(): Promise<EngineCleanupResult>
    onInstallProgress(cb: (p: EngineInstallProgress) => void): () => void
  }
  /** Codex CLI 버전 관리 — Claude Code와 동일한 문법 (state.bundled 자리는 전역 codex 버전 폴백). */
  codexEngine: {
    listAvailable(): Promise<{ latest: string | null; versions: EngineVersionEntry[] }>
    state(): Promise<EngineVersionState>
    install(version: string): Promise<{ ok: boolean; error?: string }>
    uninstall(version: string): Promise<void>
    setActive(version: string | null): Promise<void>
    cleanup(): Promise<EngineCleanupResult>
    onInstallProgress(cb: (p: EngineInstallProgress) => void): () => void
  }
  /** Codex CLI(app-server)의 모델 목록 — picker의 OpenAI 세그먼트. 미설치면 []. */
  codexModels(): Promise<CodexModelInfo[]>

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
  /** 채팅 — a pure-conversation workspace on its own dedicated engine + persistence.
   *  No project folder, explorer, or tools UI; its own conversation list, separate from
   *  the single-agent chats. Same payload shapes as the main chat, separate channel. */
  talk: {
    run(req: RunRequest): Promise<string>
    cancel(): Promise<void>
    respondPermission(res: PermissionResponse): Promise<void>
    respondQuestion(res: QuestionResponse): Promise<void>
    bgTask(req: BgTaskRequest): Promise<void>
    /** load the persisted chat-workspace conversations blob (renderer-owned shape), or null */
    getState(): Promise<unknown>
    /** persist the chat-workspace conversations so they survive a restart */
    saveState(data: unknown): Promise<void>
    /** subscribe to the 채팅 engine's streaming events (returns an unsubscribe fn) */
    onEvent(cb: (event: EngineEvent) => void): () => void
  }
  /** open a new "session" window — an independent OS window (native frame, freely
   *  resizable, movable to a second monitor) running its own conversation on its own
   *  engine. Callable from any mode; each window is fully independent of the others. */
  openSessionWindow(): Promise<void>
  /** 세션 창 — the chat that lives inside a session window. Its own engine per window,
   *  events routed only to that window (sessionEvent). Same payload shapes as the main
   *  chat; the run/cancel/respond are resolved to the calling window's engine in main. */
  session: {
    run(req: RunRequest): Promise<string>
    cancel(): Promise<void>
    respondPermission(res: PermissionResponse): Promise<void>
    respondQuestion(res: QuestionResponse): Promise<void>
    bgTask(req: BgTaskRequest): Promise<void>
    /** subscribe to THIS window's session engine events (returns an unsubscribe fn) */
    onEvent(cb: (event: EngineEvent) => void): () => void
    /** 이 세션 창의 제목(첫 프롬프트)·상태 보고 — 메인 창 사이드바 '추가 채팅' 목록용 */
    report(info: { title: string; status: AgentStatus }): Promise<void>
    /** 이 창에 배정된 채팅의 저장본 조회 — 마운트 시 복원. 새 채팅이면 null */
    hydrate(): Promise<SessionHydrateData | null>
    /** 이 창의 대화 스냅샷 저장 — 디바운스 저장과 닫기 flush가 같은 경로를 쓴다 */
    persist(p: SessionPersistPayload): Promise<void>
    /** 메인이 닫기 직전 마지막 스냅샷을 요청 — 받으면 즉시 persist로 응답한다 */
    onFlushRequest(cb: () => void): () => void
  }
  /** 추가 채팅 레지스트리 — 대화는 채팅 id 기준으로 영속(창을 닫아도·재시작해도 목록에
   *  남음), 창은 열어 보는 뷰. 클릭 = 창 포커스(닫힌 채팅이면 창을 다시 만들어 복원),
   *  X = 대화 삭제. */
  sessionWindows: {
    list(): Promise<SessionWindowInfo[]>
    focus(id: string): Promise<void>
    close(id: string): Promise<void>
    /** 사이드바에서 이름 변경 — 이후 그 창의 자동 제목 보고(첫 프롬프트)는 무시된다 */
    rename(id: string, title: string): Promise<void>
    onChanged(cb: (list: SessionWindowInfo[]) => void): () => void
  }
  /** Multi-agent — a pool of independent engines, one per on-screen panel, all running
   *  in parallel. Each command names its panel; events arrive on a shared channel and
   *  are delivered per-panel by `onEvent(panelId, …)`. */
  multi: {
    run(req: MultiRunRequest): Promise<string>
    cancel(panelId: string): Promise<void>
    respondPermission(res: MultiPermissionResponse): Promise<void>
    respondQuestion(res: MultiQuestionResponse): Promise<void>
    /** 패널 WorkBar의 백그라운드 셸 컨트롤(중지/Ctrl+B) — 그 패널의 엔진으로 라우팅 */
    bgTask(panelId: string, req: BgTaskRequest): Promise<void>
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
