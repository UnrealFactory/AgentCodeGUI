/* ============================================================
 * window.api 심(shim) — 2.6.2 preload(src/preload/index.ts)의 자리를 대신한다.
 *
 * 규약 3가지만 지키면 렌더러 33k LOC는 손대지 않아도 된다:
 *  1) 표면은 @shared/api의 WindowApi **전 메서드**. 계약면(protocol.ts)이 캐노니컬.
 *  2) 호출은 단일 커맨드 invoke('ipc_call', { channel, payload }) 하나.
 *     - channel = protocol.ts의 IPC 상수 문자열 그대로
 *     - payload = **호출 인자 배열**. ipcRenderer.invoke(channel, ...args)가 가변
 *       인자였으므로(getUsage(fresh, account), sessionWindowRename(id, title) 등)
 *       배열로 통일해 인자 개수를 보존한다. 인자 없음 = [].
 *  3) 이벤트는 Tauri event(listen)로 **같은 채널명**. preload의 허브 팬아웃 문법을
 *     그대로 유지한다 — 채널당 네이티브 리스너 1개, 구독자는 Set.
 *
 * 백엔드가 아직 구현하지 않은 채널은 Rust가 { __unimplemented: true }를 돌려준다.
 * 그때 심은 채널당 1회만 console.warn 하고 **시그니처에 맞는 안전값**을 돌려준다 —
 * 어떤 화면도 크래시하지 않는 게 M1의 계약이다(빈 목록·null·false·no-op).
 * ============================================================ */
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { IPC } from '@shared/protocol'
import type {
  AgentStatus,
  ApiConfigStatus,
  AuthStatus,
  BgTaskRequest,
  BtwOpenRequest,
  EngineCleanupResult,
  EngineEvent,
  EngineUpdateStatus,
  FileReadResult,
  GitAiMessageResult,
  GitFileDiffResult,
  GitLogResult,
  GitResult,
  GitStatus,
  LspPos,
  MultiEngineEvent,
  MultiPermissionResponse,
  MultiQuestionResponse,
  MultiRunRequest,
  PanelPopClosed,
  PanelPopState,
  PanelPopStates,
  PermissionResponse,
  QuestionResponse,
  RunRequest,
  SessionPersistPayload,
  SessionWindowInfo,
  UpdateStatus,
  UsageInfo,
  UserProfile,
  WindowState
} from '@shared/protocol'
import type { WindowApi } from '@shared/api'
import { initWindowChrome } from './chrome'

// ── 미구현 채널 안전망 ────────────────────────────────────────────────────────
const warned = new Set<string>()
function warnOnce(channel: string, why: string): void {
  if (warned.has(channel)) return
  warned.add(channel)
  console.warn(`[shim] ${channel} — ${why} (3.0 M1: 안전값 반환)`)
}

function isUnimplemented(res: unknown): boolean {
  return !!res && typeof res === 'object' && (res as { __unimplemented?: boolean }).__unimplemented === true
}

// ── 부팅 페이로드 선주입 ──────────────────────────────────────────────────────
// 셸(src-tauri/src/win.rs `boot_payload_script`)이 문서 생성 시점에 window.__CCG_BOOT로
// 넣어 둔 값. 렌더러는 `loadPrefs()`가 resolve된 **뒤에야** createRoot를 부르므로
// `ui-prefs:get` 왕복 하나가 #root 마운트의 임계 경로에 통째로 들어가 있었다.
// 값은 창이 만들어진 그 순간 디스크에서 읽은 것이라 첫 조회 결과와 같고,
// **채널당 한 번만** 소비한다 — 두 번째 조회부터는 보통의 IPC로 간다(저장 후 재조회가
// 낡은 값을 보는 사고를 원천 차단). 인자가 있는 호출은 아예 손대지 않는다.
type BootMap = Record<string, unknown>
const boot: BootMap = (window as unknown as { __CCG_BOOT?: BootMap }).__CCG_BOOT ?? {}
function takeBoot(channel: string, args: unknown[]): { v: unknown } | null {
  if (args.length > 0) return null
  if (!Object.prototype.hasOwnProperty.call(boot, channel)) return null
  const v = boot[channel]
  delete boot[channel] // 한 번 쓰고 버린다
  return { v } // null도 정당한 값이라(profile:get) 박스로 감싼다
}

/** 채널 1회 호출. 미구현·에러면 fallback을 돌려준다(절대 throw 하지 않는다). */
async function call<T>(channel: string, args: unknown[], fallback: T): Promise<T> {
  const pre = takeBoot(channel, args)
  if (pre) return pre.v as T
  let res: unknown
  try {
    res = await invoke('ipc_call', { channel, payload: args })
  } catch (err) {
    warnOnce(channel + ' !', `호출 실패: ${String((err as Error)?.message ?? err)}`)
    return fallback
  }
  if (isUnimplemented(res)) {
    warnOnce(channel, '백엔드 미구현 채널')
    return fallback
  }
  return res as T
}

/** 반환값이 없는(void) 채널 — 미구현이어도 조용한 no-op. */
function callVoid(channel: string, args: unknown[] = []): Promise<void> {
  return call<void>(channel, args, undefined as void)
}

// ── 이벤트 허브 (preload와 같은 문법) ─────────────────────────────────────────
// 채널당 네이티브 리스너 하나, 구독자는 평범한 Set. 멀티 워크스페이스 혼자
// ma:event에 12번 붙는 구조라 여기서 접어주지 않으면 리스너가 계속 증식한다.
const hubs = new Map<string, Set<(payload: unknown) => void>>()
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  let subs = hubs.get(channel)
  if (!subs) {
    subs = new Set()
    hubs.set(channel, subs)
    const set = subs
    // listen()은 비동기 등록이라 구독 직후 아주 잠깐의 공백이 있다. preload(동기 on)와
    // 다른 유일한 지점 — 부팅 직후 도착하는 이벤트는 백엔드가 스냅샷 조회(status/get)로
    // 따라잡게 되어 있어(계약면 규약) 실사용 의미는 같다.
    void listen<unknown>(channel, (ev) => {
      // 구독자가 디스패치 도중 해지/예외를 내도 루프가 깨지지 않게 사본을 돈다
      for (const fn of [...set]) {
        try {
          fn(ev.payload)
        } catch (err) {
          console.error(`[shim] subscriber error on ${channel}`, err)
        }
      }
    })
  }
  const fn = cb as (payload: unknown) => void
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}

// ── 안전값 상수 (시그니처에 맞는 "데이터 없음" 모양) ──────────────────────────
const NO_USAGE: UsageInfo = { fiveHour: null, weekly: null, weeklyFable: null, extraCredit: null }
const NO_AUTH: AuthStatus & { ok: boolean } = { ok: false, loggedIn: false, error: 'unimplemented' }
const NO_API_CONFIG: ApiConfigStatus = {
  hasKey: false,
  keyTail: null,
  budgetUsd: null,
  spentUsd: 0,
  hasOpenaiKey: false,
  openaiKeyTail: null
}
const NO_UPDATE: UpdateStatus = { phase: 'idle', version: null, percent: 0, log: [], error: null }
const NO_ENGINE_UPDATE: EngineUpdateStatus = {
  active: false,
  items: [],
  cleanup: 'pending',
  freedBytes: 0,
  done: false
}
const NO_ENGINE_STATE = { package: '', bundled: 'unknown', active: null, installed: [] as string[] }
const NO_AVAILABLE = { latest: null as string | null, versions: [] }
const NO_CLEANUP: EngineCleanupResult = { removed: [], kept: null, freedBytes: 0, activeSwitched: false }
const failed = (error = 'unimplemented'): GitResult => ({ ok: false, error })
const NO_GIT_STATUS: GitStatus = {
  repo: false,
  root: '',
  branch: '',
  detached: false,
  ahead: 0,
  behind: 0,
  upstream: null,
  hasRemote: false,
  files: []
}
const NO_GIT_LOG: GitLogResult = { commits: [], hasMore: false }
const NO_GIT_DIFF: GitFileDiffResult = { diff: null, error: 'unimplemented' }
const NO_AI_MSG: GitAiMessageResult = { ok: false, error: 'unimplemented' }
const NO_PANEL_STATES: PanelPopStates = { open: [], leftovers: [] }

const api: WindowApi = {
  run: (req: RunRequest) => call(IPC.runStart, [req], ''),
  cancel: () => callVoid(IPC.runCancel),
  interrupt: () => callVoid(IPC.runInterrupt),
  respondPermission: (res: PermissionResponse) => callVoid(IPC.permissionRespond, [res]),
  respondQuestion: (res: QuestionResponse) => callVoid(IPC.questionRespond, [res]),
  bgTask: (req: BgTaskRequest) => callVoid(IPC.bgTask, [req]),
  pickDirectory: () => call<string | null>(IPC.pickDirectory, [], null),
  dirExists: (dir: string) => call(IPC.dirExists, [dir], false),
  pickAttachments: () => call<string[]>(IPC.pickAttachments, [], []),
  // 유일한 예외: "경로 없음"을 뜻하는 안전한 문자열이 없다. 호출부(lib/images.ts)가
  // try/catch로 감싸 첨부를 건너뛰게 되어 있어, 미구현은 조용한 skip이 정답이다.
  saveAttachmentData: async (bytes: ArrayBuffer, ext: string) => {
    const p = await call<string>(IPC.saveAttachmentData, [{ bytes: Array.from(new Uint8Array(bytes)), ext }], '')
    if (!p) throw new Error('saveAttachmentData: unimplemented')
    return p
  },
  // Electron webUtils.getPathForFile의 대응물. Tauri는 OS 드래그 경로를 네이티브
  // drag-drop 이벤트로만 주므로 File→경로 동기 해석이 불가하다(M1 갭 — chrome.ts가
  // 마지막 drop 경로를 캐시해 이름이 맞으면 돌려준다).
  pathForFile: (file: File) => dropPathFor(file),
  getUsage: (fresh?: boolean, account?: string) => call(IPC.getUsage, [fresh, account], NO_USAGE),
  auth: {
    login: (useConsole?: boolean) => call(IPC.authLogin, [useConsole], NO_AUTH),
    logout: (email: string) => call(IPC.authLogout, [email], []),
    cancelLogin: () => callVoid(IPC.authLoginCancel),
    onLoginUrl: (cb: (url: string) => void) => subscribe(IPC.authLoginUrl, cb),
    listAccounts: () => call(IPC.authListAccounts, [], []),
    setDefaultAccount: (email: string) => call(IPC.authSetDefaultAccount, [email], []),
    removeAccount: (email: string) => call(IPC.authRemoveAccount, [email], []),
    reorderAccounts: (emails: string[]) => call(IPC.authReorderAccounts, [emails], []),
    accountsUsage: () => call(IPC.authAccountsUsage, [], [])
  },
  codexAuth: {
    listAccounts: () => call(IPC.codexListAccounts, [], []),
    login: () => call(IPC.codexLogin, [], []),
    logout: (email: string) => call(IPC.codexLogout, [email], []),
    setDefaultAccount: (email: string) => call(IPC.codexSetDefaultAccount, [email], []),
    cancelLogin: () => callVoid(IPC.codexLoginCancel),
    reorderAccounts: (emails: string[]) => call(IPC.codexReorderAccounts, [emails], []),
    accountsUsage: () => call(IPC.codexAccountsUsage, [], [])
  },
  engineAutoUpdate: (enabled?: boolean) => call(IPC.engineAutoUpdate, [enabled], true),
  engineUpdate: {
    status: () => call(IPC.engineUpdateStatus, [], NO_ENGINE_UPDATE),
    onEvent: (cb: (s: EngineUpdateStatus) => void) => subscribe(IPC.engineUpdateEvent, cb)
  },
  openApiSettings: () => callVoid(IPC.openApiSettings),
  onApiSettingsRequested: (cb: () => void) => subscribe<void>(IPC.apiSettingsRequested, () => cb()),
  apiConfig: {
    get: () => call(IPC.apiConfigGet, [], NO_API_CONFIG),
    setKey: (key: string, provider?: 'anthropic' | 'openai') =>
      call(IPC.apiConfigSetKey, [key, provider], NO_API_CONFIG),
    clearKey: (provider?: 'anthropic' | 'openai') => call(IPC.apiConfigClearKey, [provider], NO_API_CONFIG),
    setBudget: (usd: number | null) => call(IPC.apiConfigSetBudget, [usd], NO_API_CONFIG),
    resetBudget: () => call(IPC.apiConfigResetBudget, [], NO_API_CONFIG),
    listUsage: () => call(IPC.apiUsageList, [], [])
  },
  getProfile: () => call<UserProfile | null>(IPC.profileGet, [], null),
  saveProfile: (profile: UserProfile) => callVoid(IPC.profileSave, [profile]),
  getChats: () => call<unknown>(IPC.chatsGet, [], null),
  saveChats: (data: unknown) => callVoid(IPC.chatsSave, [data]),
  loadChat: (id: string) => call<unknown>(IPC.chatLoad, [id], null),
  getUiPrefs: () => call<Record<string, unknown>>(IPC.uiPrefsGet, [], {}),
  saveUiPrefs: (prefs: Record<string, unknown>) => callVoid(IPC.uiPrefsSave, [prefs]),
  onUiGlassChanged: (cb) => subscribe(IPC.uiGlassChanged, cb),
  onUiLangChanged: (cb) => subscribe(IPC.uiLangChanged, cb),
  openPath: (cwd, relPath) => callVoid(IPC.shellOpenPath, [{ cwd, relPath }]),
  revealPath: (cwd, relPath) => callVoid(IPC.shellRevealPath, [{ cwd, relPath }]),
  renamePath: (cwd, relPath, newName) => call(IPC.fsRename, [{ cwd, relPath, newName }], failed()),
  deletePath: (cwd, relPath) => call(IPC.fsDelete, [{ cwd, relPath }], failed()),
  createPath: (cwd, relPath, dir) => call(IPC.fsCreate, [{ cwd, relPath, dir }], failed()),
  movePath: (cwd, srcRel, destRel) => call(IPC.fsMove, [{ cwd, srcRel, destRel }], failed()),
  readFile: (cwd, relPath) =>
    call<FileReadResult>(IPC.readFile, [{ cwd, relPath }], {
      path: relPath,
      content: null,
      truncated: false,
      error: 'unimplemented'
    }),
  writeFile: (cwd, relPath, content) => call(IPC.writeFile, [{ cwd, relPath, content }], failed()),
  htmlPreviewUrl: (cwd, relPath) => call(IPC.htmlPreviewUrl, [{ cwd, relPath }], ''),
  onCloseShortcut: (cb) => subscribe<void>(IPC.closeShortcut, () => cb()),
  listFiles: (cwd) => call<string[]>(IPC.listFiles, [cwd], []),
  listDir: (cwd, rel, exclude, hideEmpty, excludeDirs, excludeFiles) =>
    call(IPC.listDir, [{ cwd, rel, exclude, hideEmpty, excludeDirs, excludeFiles }], []),
  git: {
    repos: (cwd) => call(IPC.gitRepos, [cwd], []),
    status: (cwd) => call(IPC.gitStatus, [cwd], NO_GIT_STATUS),
    log: (cwd, limit, skip) => call(IPC.gitLog, [{ cwd, limit, skip }], NO_GIT_LOG),
    fileDiff: (cwd, rel) => call(IPC.gitFileDiff, [{ cwd, rel }], NO_GIT_DIFF),
    commitDetail: (cwd, hash) => call(IPC.gitCommitDetail, [{ cwd, hash }], null),
    commitFileDiff: (cwd, hash, rel) =>
      call(IPC.gitCommitFileDiff, [{ cwd, hash, rel }], { ...NO_GIT_DIFF, content: null }),
    commit: (cwd, files, subject, body) => call(IPC.gitCommit, [{ cwd, files, subject, body }], failed()),
    push: (cwd) => call(IPC.gitPush, [cwd], failed()),
    pull: (cwd) => call(IPC.gitPull, [cwd], failed()),
    fetch: (cwd) => call(IPC.gitFetch, [cwd], failed()),
    discard: (cwd, rel, untracked) => call(IPC.gitDiscard, [{ cwd, rel, untracked }], failed()),
    branches: (cwd) => call(IPC.gitBranches, [cwd], []),
    switchBranch: (cwd, name) => call(IPC.gitSwitchBranch, [{ cwd, name }], failed()),
    createBranch: (cwd, name) => call(IPC.gitCreateBranch, [{ cwd, name }], failed()),
    aiMessage: (cwd, files, opts) =>
      call(
        IPC.gitAiMessage,
        [{ cwd, files, account: opts?.account, model: opts?.model, effort: opts?.effort }],
        NO_AI_MSG
      )
  },
  lsp: {
    status: (cwd: string, relPath: string) => call(IPC.lspStatus, [{ cwd, relPath }], 'unsupported' as const),
    hover: (cwd: string, relPath: string, pos: LspPos, text?: string) =>
      call(IPC.lspHover, [{ cwd, relPath, pos, text }], null),
    definition: (cwd: string, relPath: string, pos: LspPos, text?: string) =>
      call(IPC.lspDefinition, [{ cwd, relPath, pos, text }], []),
    semanticTokens: (cwd: string, relPath: string) => call(IPC.lspSemanticTokens, [{ cwd, relPath }], null),
    cachedTokens: (cwd: string, relPath: string) => call(IPC.lspCachedTokens, [{ cwd, relPath }], null),
    completion: (cwd: string, relPath: string, pos: LspPos, text: string) =>
      call(IPC.lspCompletion, [{ cwd, relPath, pos, text }], null),
    resolveCompletion: (cwd: string, relPath: string, gen: number, ri: number) =>
      call(IPC.lspResolveCompletion, [{ cwd, relPath, gen, ri }], null),
    prewarm: (cwd: string) => callVoid(IPC.lspPrewarm, [{ cwd }]),
    warm: (cwd: string, relPath: string) => callVoid(IPC.lspWarm, [{ cwd, relPath }]),
    verseRegistry: (cwd: string, relPath: string, knownRev?: number) =>
      call(IPC.lspVerseRegistry, [{ cwd, relPath, knownRev }], null),
    projectStatus: (cwd: string) => call(IPC.lspProjectStatus, [{ cwd }], { state: 'idle' as const, percent: null }),
    verseDigests: (cwd: string) => call(IPC.lspVerseDigests, [{ cwd }], []),
    verseExcludes: (cwd: string) => call(IPC.lspVerseExcludes, [{ cwd }], []),
    install: (cwd: string, relPath: string) => call(IPC.lspInstall, [{ cwd, relPath }], failed()),
    onInstallProgress: (cb) => subscribe(IPC.lspInstallProgress, cb),
    onFilesChanged: (cb) => subscribe(IPC.lspFilesChanged, cb),
    servers: () => call(IPC.lspServers, [], []),
    installServer: (id: string) => call(IPC.lspInstallServer, [id], failed()),
    uninstallServer: (id: string) => call(IPC.lspUninstallServer, [id], failed()),
    pickVerseServer: () => call<string | null>(IPC.lspPickVerseServer, [], null),
    setVersePath: (p: string) => call(IPC.lspSetVersePath, [p], failed()),
    clearVersePath: () => call(IPC.lspClearVersePath, [], failed())
  },
  win: {
    minimize: () => callVoid(IPC.winMinimize),
    toggleMaximize: () => call(IPC.winMaximizeToggle, [], false),
    close: () => callVoid(IPC.winClose),
    isMaximized: () => call(IPC.winIsMaximized, [], false)
  },
  engine: {
    listAvailable: () => call(IPC.engineListAvailable, [], NO_AVAILABLE),
    state: () => call(IPC.engineState, [], NO_ENGINE_STATE),
    install: (version: string) => call(IPC.engineInstall, [version], failed()),
    uninstall: (version: string) => callVoid(IPC.engineUninstall, [version]),
    setActive: (version: string | null) => callVoid(IPC.engineSetActive, [version]),
    cleanup: () => call(IPC.engineCleanup, [], NO_CLEANUP),
    onInstallProgress: (cb) => subscribe(IPC.engineInstallProgress, cb)
  },
  codexEngine: {
    listAvailable: () => call(IPC.codexEngineListAvailable, [], NO_AVAILABLE),
    state: () => call(IPC.codexEngineState, [], NO_ENGINE_STATE),
    install: (version: string) => call(IPC.codexEngineInstall, [version], failed()),
    uninstall: (version: string) => callVoid(IPC.codexEngineUninstall, [version]),
    setActive: (version: string | null) => callVoid(IPC.codexEngineSetActive, [version]),
    cleanup: () => call(IPC.codexEngineCleanup, [], NO_CLEANUP),
    onInstallProgress: (cb) => subscribe(IPC.codexEngineInstallProgress, cb)
  },
  codexModels: () => call(IPC.codexModels, [], []),
  skill: {
    list: (cwd: string) => call(IPC.skillList, [cwd], []),
    setEnabled: (name: string, enabled: boolean) => callVoid(IPC.skillSetEnabled, [{ name, enabled }])
  },
  mcp: {
    list: (cwd: string) => call(IPC.mcpList, [cwd], []),
    setEnabled: (name: string, enabled: boolean) => callVoid(IPC.mcpSetEnabled, [{ name, enabled }])
  },
  talk: {
    run: (req: RunRequest) => call(IPC.talkRun, [req], ''),
    cancel: () => callVoid(IPC.talkCancel),
    respondPermission: (res: PermissionResponse) => callVoid(IPC.talkPermissionRespond, [res]),
    respondQuestion: (res: QuestionResponse) => callVoid(IPC.talkQuestionRespond, [res]),
    bgTask: (req: BgTaskRequest) => callVoid(IPC.talkBgTask, [req]),
    getState: () => call<unknown>(IPC.talkGet, [], null),
    saveState: (data: unknown) => callVoid(IPC.talkSave, [data]),
    onEvent: (cb: (e: EngineEvent) => void) => subscribe(IPC.talkEvent, cb)
  },
  openSessionWindow: () => callVoid(IPC.openSessionWindow),
  btwOpen: (req: BtwOpenRequest) => callVoid(IPC.btwOpen, [req]),
  session: {
    run: (req: RunRequest) => call(IPC.sessionRun, [req], ''),
    cancel: () => callVoid(IPC.sessionCancel),
    interrupt: () => callVoid(IPC.sessionInterrupt),
    respondPermission: (res: PermissionResponse) => callVoid(IPC.sessionPermissionRespond, [res]),
    respondQuestion: (res: QuestionResponse) => callVoid(IPC.sessionQuestionRespond, [res]),
    bgTask: (req: BgTaskRequest) => callVoid(IPC.sessionBgTask, [req]),
    onEvent: (cb: (e: EngineEvent) => void) => subscribe(IPC.sessionEvent, cb),
    report: (info: { title: string; status: AgentStatus }) => callVoid(IPC.sessionReport, [info]),
    hydrate: () => call(IPC.sessionHydrate, [], null),
    persist: (p: SessionPersistPayload) => callVoid(IPC.sessionPersist, [p]),
    onFlushRequest: (cb: () => void) => subscribe<void>(IPC.sessionFlushRequest, () => cb())
  },
  sessionWindows: {
    list: () => call(IPC.sessionWindowsList, [], []),
    focus: (id: string) => callVoid(IPC.sessionWindowFocus, [id]),
    close: (id: string) => callVoid(IPC.sessionWindowClose, [id]),
    rename: (id: string, title: string) => callVoid(IPC.sessionWindowRename, [id, title]),
    onChanged: (cb: (list: SessionWindowInfo[]) => void) => subscribe(IPC.sessionWindowsChanged, cb)
  },
  multi: {
    run: (req: MultiRunRequest) => call(IPC.maRun, [req], ''),
    cancel: (panelId: string) => callVoid(IPC.maCancel, [panelId]),
    interrupt: (panelId: string) => callVoid(IPC.maInterrupt, [panelId]),
    respondPermission: (res: MultiPermissionResponse) => callVoid(IPC.maPermissionRespond, [res]),
    respondQuestion: (res: MultiQuestionResponse) => callVoid(IPC.maQuestionRespond, [res]),
    bgTask: (panelId: string, req: BgTaskRequest) => callVoid(IPC.maBgTask, [panelId, req]),
    dispose: (panelId: string) => callVoid(IPC.maDispose, [panelId]),
    getState: () => call<unknown>(IPC.maGet, [], null),
    saveState: (data: unknown) => callVoid(IPC.maSave, [data]),
    loadSession: (id: string) => call<unknown>(IPC.maLoadSession, [id], null),
    // 패널 전부가 한 채널을 공유한다 — panelId가 맞는 이벤트만 그 구독자에게
    onEvent: (panelId: string, cb: (e: EngineEvent) => void) =>
      subscribe(IPC.maEvent, (p: MultiEngineEvent) => {
        if (p.panelId === panelId) cb(p.event)
      }),
    openPanelWindow: (state: PanelPopState) => callVoid(IPC.maPanelOpen, [state]),
    panelHydrate: () => call(IPC.maPanelHydrate, [], null),
    panelPersist: (state: PanelPopState) => callVoid(IPC.maPanelPersist, [state]),
    panelFocus: (panelId: string) => callVoid(IPC.maPanelFocus, [panelId]),
    panelClose: (panelId: string) => callVoid(IPC.maPanelClose, [panelId]),
    panelStates: (sessionId: string) => call(IPC.maPanelStates, [sessionId], NO_PANEL_STATES),
    panelClearLeftover: (panelId: string) => callVoid(IPC.maPanelLeftoverClear, [panelId]),
    onPanelClosed: (cb: (p: PanelPopClosed) => void) => subscribe(IPC.maPanelClosed, cb)
  },
  app: {
    getVersion: () => call(IPC.appGetVersion, [], ''),
    getInitialDirectory: () => call<string | null>(IPC.appGetInitialDir, [], null),
    getUpdateStatus: () => call(IPC.updateGetStatus, [], NO_UPDATE),
    checkForUpdate: () => callVoid(IPC.updateCheck),
    installUpdate: () => callVoid(IPC.updateInstall),
    onOpenDirectory: (cb: (dir: string) => void) => subscribe(IPC.openDirectory, cb),
    onUpdateEvent: (cb: (s: UpdateStatus) => void) => subscribe(IPC.updateEvent, cb)
  },
  notify: {
    event: (p) => callVoid(IPC.notifyEvent, [p]),
    open: (key: string) => callVoid(IPC.notifyOpen, [key]),
    close: () => callVoid(IPC.notifyClose),
    resize: (height: number) => callVoid(IPC.notifyResize, [height]),
    onShow: (cb) => subscribe(IPC.notifyShow, cb),
    onJump: (cb) => subscribe(IPC.notifyJump, cb)
  },
  trayMenu: {
    action: (id: string) => callVoid(IPC.trayMenuAction, [id]),
    resize: (height: number) => callVoid(IPC.trayMenuResize, [height]),
    onShow: (cb) => subscribe(IPC.trayMenuShow, cb)
  },
  onEngineEvent: (cb: (e: EngineEvent) => void) => subscribe(IPC.engineEvent, cb),
  onWinState: (cb: (s: WindowState) => void) => subscribe(IPC.winState, cb)
}

// 드래그로 들어온 파일의 OS 경로 — Tauri에는 webUtils.getPathForFile 대응물이 없다.
// 네이티브 drag-drop(경로 동봉)을 켜면 HTML5 drop이 웹뷰에 아예 안 와서 렌더러의 드롭
// 처리 전부가 죽으므로, HTML5 경로를 살리고 여기서는 ''을 돌려준다. 호출부는 경로가
// 없으면 바이트를 메인으로 넘기는 폴백(saveAttachmentData)이 이미 있다 — 그쪽이
// 구현되면 OS 드래그·브라우저 드래그·붙여넣기가 한 길로 모인다. (M1 갭: 둘 다 미구현)
function dropPathFor(_file: File): string {
  warnOnce('pathForFile', 'Tauri에는 File→OS 경로 동기 해석이 없다')
  return ''
}

// window.api를 렌더러 코드보다 **먼저** 세운다 — index.html에서 main.tsx보다 앞선
// 모듈 스크립트로 로드된다(모듈은 문서 순서대로 실행).
;(window as unknown as { api: WindowApi }).api = api

// 창 껍데기 보조 — CSS의 -webkit-app-region(드래그 영역)을 WebView2에서 재현한다
initWindowChrome()
