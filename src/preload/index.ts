import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { IPC } from '@shared/protocol'
import type {
  RunRequest,
  PermissionResponse,
  QuestionResponse,
  BgTaskRequest,
  EngineEvent,
  WindowState,
  UserProfile,
  UpdateStatus,
  MultiRunRequest,
  MultiPermissionResponse,
  MultiQuestionResponse,
  MultiEngineEvent,
  AgentStatus,
  SessionWindowInfo,
  SessionPersistPayload,
  EngineUpdateStatus
} from '@shared/protocol'
import type { LspPos } from '@shared/protocol'
import type { WindowApi } from '@shared/api'

// One real ipcRenderer listener per channel, fanned out to JS subscribers. The multi
// workspace alone subscribes 12+ times to the shared ma:event channel (6 panel hooks +
// 6 fallback watchers), which blows past Node's default 10-listener warning threshold
// and re-registers native listeners on every session switch. A hub keeps the native
// side at exactly one listener per channel; subscribers come and go in a plain Set.
const hubs = new Map<string, Set<(payload: unknown) => void>>()
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  let subs = hubs.get(channel)
  if (!subs) {
    subs = new Set()
    hubs.set(channel, subs)
    const set = subs
    ipcRenderer.on(channel, (_e: IpcRendererEvent, payload: unknown) => {
      // iterate a copy so a subscriber unsubscribing (or throwing) mid-dispatch
      // can't corrupt the loop or starve the remaining subscribers
      for (const fn of [...set]) {
        try {
          fn(payload)
        } catch (err) {
          console.error(`[preload] subscriber error on ${channel}`, err)
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

const api: WindowApi = {
  run: (req: RunRequest) => ipcRenderer.invoke(IPC.runStart, req),
  cancel: () => ipcRenderer.invoke(IPC.runCancel),
  respondPermission: (res: PermissionResponse) => ipcRenderer.invoke(IPC.permissionRespond, res),
  respondQuestion: (res: QuestionResponse) => ipcRenderer.invoke(IPC.questionRespond, res),
  bgTask: (req: BgTaskRequest) => ipcRenderer.invoke(IPC.bgTask, req),
  pickDirectory: () => ipcRenderer.invoke(IPC.pickDirectory),
  dirExists: (dir: string) => ipcRenderer.invoke(IPC.dirExists, dir),
  pickAttachments: () => ipcRenderer.invoke(IPC.pickAttachments),
  saveAttachmentData: (bytes: ArrayBuffer, ext: string) => ipcRenderer.invoke(IPC.saveAttachmentData, { bytes, ext }),
  // webUtils.getPathForFile must run in the preload (not the sandboxed renderer); the
  // File is passed through the contextBridge function call and resolved to its OS path
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  getUsage: (fresh?: boolean, account?: string) => ipcRenderer.invoke(IPC.getUsage, fresh, account),
  auth: {
    logout: (email: string) => ipcRenderer.invoke(IPC.authLogout, email),
    login: (useConsole?: boolean) => ipcRenderer.invoke(IPC.authLogin, useConsole),
    cancelLogin: () => ipcRenderer.invoke(IPC.authLoginCancel),
    onLoginUrl: (cb: (url: string) => void) => subscribe(IPC.authLoginUrl, cb),
    listAccounts: () => ipcRenderer.invoke(IPC.authListAccounts),
    setDefaultAccount: (email: string) => ipcRenderer.invoke(IPC.authSetDefaultAccount, email),
    removeAccount: (email: string) => ipcRenderer.invoke(IPC.authRemoveAccount, email),
    accountsUsage: () => ipcRenderer.invoke(IPC.authAccountsUsage)
  },
  codexAuth: {
    listAccounts: () => ipcRenderer.invoke(IPC.codexListAccounts),
    login: () => ipcRenderer.invoke(IPC.codexLogin),
    logout: (email: string) => ipcRenderer.invoke(IPC.codexLogout, email),
    setDefaultAccount: (email: string) => ipcRenderer.invoke(IPC.codexSetDefaultAccount, email),
    cancelLogin: () => ipcRenderer.invoke(IPC.codexLoginCancel),
    accountsUsage: () => ipcRenderer.invoke(IPC.codexAccountsUsage)
  },
  engineAutoUpdate: (enabled?: boolean) => ipcRenderer.invoke(IPC.engineAutoUpdate, enabled),
  engineUpdate: {
    status: () => ipcRenderer.invoke(IPC.engineUpdateStatus),
    onEvent: (cb: (s: EngineUpdateStatus) => void) => subscribe(IPC.engineUpdateEvent, cb)
  },
  openApiSettings: () => ipcRenderer.invoke(IPC.openApiSettings),
  onApiSettingsRequested: (cb: () => void) => subscribe(IPC.apiSettingsRequested, cb),
  apiConfig: {
    get: () => ipcRenderer.invoke(IPC.apiConfigGet),
    setKey: (key: string, provider?: 'anthropic' | 'openai') => ipcRenderer.invoke(IPC.apiConfigSetKey, key, provider),
    clearKey: (provider?: 'anthropic' | 'openai') => ipcRenderer.invoke(IPC.apiConfigClearKey, provider),
    setBudget: (usd: number | null) => ipcRenderer.invoke(IPC.apiConfigSetBudget, usd),
    resetBudget: () => ipcRenderer.invoke(IPC.apiConfigResetBudget),
    listUsage: () => ipcRenderer.invoke(IPC.apiUsageList)
  },
  getProfile: () => ipcRenderer.invoke(IPC.profileGet) as Promise<UserProfile | null>,
  saveProfile: (profile: UserProfile) => ipcRenderer.invoke(IPC.profileSave, profile),
  getChats: () => ipcRenderer.invoke(IPC.chatsGet),
  saveChats: (data: unknown) => ipcRenderer.invoke(IPC.chatsSave, data),
  getUiPrefs: () => ipcRenderer.invoke(IPC.uiPrefsGet) as Promise<Record<string, unknown>>,
  saveUiPrefs: (prefs: Record<string, unknown>) => ipcRenderer.invoke(IPC.uiPrefsSave, prefs),
  onUiGlassChanged: (cb) => subscribe(IPC.uiGlassChanged, cb),
  openPath: (cwd, relPath) => ipcRenderer.invoke(IPC.shellOpenPath, { cwd, relPath }),
  revealPath: (cwd, relPath) => ipcRenderer.invoke(IPC.shellRevealPath, { cwd, relPath }),
  renamePath: (cwd, relPath, newName) => ipcRenderer.invoke(IPC.fsRename, { cwd, relPath, newName }),
  deletePath: (cwd, relPath) => ipcRenderer.invoke(IPC.fsDelete, { cwd, relPath }),
  createPath: (cwd, relPath, dir) => ipcRenderer.invoke(IPC.fsCreate, { cwd, relPath, dir }),
  movePath: (cwd, srcRel, destRel) => ipcRenderer.invoke(IPC.fsMove, { cwd, srcRel, destRel }),
  readFile: (cwd, relPath) => ipcRenderer.invoke(IPC.readFile, { cwd, relPath }),
  writeFile: (cwd, relPath, content) => ipcRenderer.invoke(IPC.writeFile, { cwd, relPath, content }),
  htmlPreviewUrl: (cwd, relPath) => ipcRenderer.invoke(IPC.htmlPreviewUrl, { cwd, relPath }),
  onCloseShortcut: (cb) => subscribe<void>(IPC.closeShortcut, () => cb()),
  listFiles: (cwd) => ipcRenderer.invoke(IPC.listFiles, cwd),
  listDir: (cwd, rel, exclude, hideEmpty, excludeDirs, excludeFiles) =>
    ipcRenderer.invoke(IPC.listDir, { cwd, rel, exclude, hideEmpty, excludeDirs, excludeFiles }),
  git: {
    status: (cwd) => ipcRenderer.invoke(IPC.gitStatus, cwd),
    log: (cwd, limit, skip) => ipcRenderer.invoke(IPC.gitLog, { cwd, limit, skip }),
    fileDiff: (cwd, rel) => ipcRenderer.invoke(IPC.gitFileDiff, { cwd, rel }),
    commitDetail: (cwd, hash) => ipcRenderer.invoke(IPC.gitCommitDetail, { cwd, hash }),
    commitFileDiff: (cwd, hash, rel) => ipcRenderer.invoke(IPC.gitCommitFileDiff, { cwd, hash, rel }),
    commit: (cwd, files, subject, body) => ipcRenderer.invoke(IPC.gitCommit, { cwd, files, subject, body }),
    push: (cwd) => ipcRenderer.invoke(IPC.gitPush, cwd),
    pull: (cwd) => ipcRenderer.invoke(IPC.gitPull, cwd),
    fetch: (cwd) => ipcRenderer.invoke(IPC.gitFetch, cwd),
    discard: (cwd, rel, untracked) => ipcRenderer.invoke(IPC.gitDiscard, { cwd, rel, untracked }),
    branches: (cwd) => ipcRenderer.invoke(IPC.gitBranches, cwd),
    switchBranch: (cwd, name) => ipcRenderer.invoke(IPC.gitSwitchBranch, { cwd, name }),
    createBranch: (cwd, name) => ipcRenderer.invoke(IPC.gitCreateBranch, { cwd, name }),
    aiMessage: (cwd, files, opts) =>
      ipcRenderer.invoke(IPC.gitAiMessage, {
        cwd,
        files,
        account: opts?.account,
        model: opts?.model,
        effort: opts?.effort
      })
  },
  lsp: {
    status: (cwd: string, relPath: string) => ipcRenderer.invoke(IPC.lspStatus, { cwd, relPath }),
    hover: (cwd: string, relPath: string, pos: LspPos, text?: string) =>
      ipcRenderer.invoke(IPC.lspHover, { cwd, relPath, pos, text }),
    definition: (cwd: string, relPath: string, pos: LspPos, text?: string) =>
      ipcRenderer.invoke(IPC.lspDefinition, { cwd, relPath, pos, text }),
    semanticTokens: (cwd: string, relPath: string) => ipcRenderer.invoke(IPC.lspSemanticTokens, { cwd, relPath }),
    cachedTokens: (cwd: string, relPath: string) => ipcRenderer.invoke(IPC.lspCachedTokens, { cwd, relPath }),
    completion: (cwd: string, relPath: string, pos: LspPos, text: string) =>
      ipcRenderer.invoke(IPC.lspCompletion, { cwd, relPath, pos, text }),
    resolveCompletion: (cwd: string, relPath: string, gen: number, ri: number) =>
      ipcRenderer.invoke(IPC.lspResolveCompletion, { cwd, relPath, gen, ri }),
    prewarm: (cwd: string) => ipcRenderer.invoke(IPC.lspPrewarm, { cwd }),
    warm: (cwd: string, relPath: string) => ipcRenderer.invoke(IPC.lspWarm, { cwd, relPath }),
    verseRegistry: (cwd: string, relPath: string, knownRev?: number) =>
      ipcRenderer.invoke(IPC.lspVerseRegistry, { cwd, relPath, knownRev }),
    projectStatus: (cwd: string) => ipcRenderer.invoke(IPC.lspProjectStatus, { cwd }),
    verseDigests: (cwd: string) => ipcRenderer.invoke(IPC.lspVerseDigests, { cwd }),
    verseExcludes: (cwd: string) => ipcRenderer.invoke(IPC.lspVerseExcludes, { cwd }),
    install: (cwd: string, relPath: string) => ipcRenderer.invoke(IPC.lspInstall, { cwd, relPath }),
    onInstallProgress: (cb) => subscribe(IPC.lspInstallProgress, cb),
    onFilesChanged: (cb) => subscribe(IPC.lspFilesChanged, cb),
    servers: () => ipcRenderer.invoke(IPC.lspServers),
    installServer: (id: string) => ipcRenderer.invoke(IPC.lspInstallServer, id),
    uninstallServer: (id: string) => ipcRenderer.invoke(IPC.lspUninstallServer, id),
    pickVerseServer: () => ipcRenderer.invoke(IPC.lspPickVerseServer),
    setVersePath: (p: string) => ipcRenderer.invoke(IPC.lspSetVersePath, p),
    clearVersePath: () => ipcRenderer.invoke(IPC.lspClearVersePath)
  },
  win: {
    minimize: () => ipcRenderer.invoke(IPC.winMinimize),
    toggleMaximize: () => ipcRenderer.invoke(IPC.winMaximizeToggle),
    close: () => ipcRenderer.invoke(IPC.winClose),
    isMaximized: () => ipcRenderer.invoke(IPC.winIsMaximized)
  },
  engine: {
    listAvailable: () => ipcRenderer.invoke(IPC.engineListAvailable),
    state: () => ipcRenderer.invoke(IPC.engineState),
    install: (version: string) => ipcRenderer.invoke(IPC.engineInstall, version),
    uninstall: (version: string) => ipcRenderer.invoke(IPC.engineUninstall, version),
    setActive: (version: string | null) => ipcRenderer.invoke(IPC.engineSetActive, version),
    cleanup: () => ipcRenderer.invoke(IPC.engineCleanup),
    onInstallProgress: (cb) => subscribe(IPC.engineInstallProgress, cb)
  },
  codexEngine: {
    listAvailable: () => ipcRenderer.invoke(IPC.codexEngineListAvailable),
    state: () => ipcRenderer.invoke(IPC.codexEngineState),
    install: (version: string) => ipcRenderer.invoke(IPC.codexEngineInstall, version),
    uninstall: (version: string) => ipcRenderer.invoke(IPC.codexEngineUninstall, version),
    setActive: (version: string | null) => ipcRenderer.invoke(IPC.codexEngineSetActive, version),
    cleanup: () => ipcRenderer.invoke(IPC.codexEngineCleanup),
    onInstallProgress: (cb) => subscribe(IPC.codexEngineInstallProgress, cb)
  },
  codexModels: () => ipcRenderer.invoke(IPC.codexModels),
  skill: {
    list: (cwd: string) => ipcRenderer.invoke(IPC.skillList, cwd),
    setEnabled: (name: string, enabled: boolean) =>
      ipcRenderer.invoke(IPC.skillSetEnabled, { name, enabled })
  },
  mcp: {
    list: (cwd: string) => ipcRenderer.invoke(IPC.mcpList, cwd),
    setEnabled: (name: string, enabled: boolean) =>
      ipcRenderer.invoke(IPC.mcpSetEnabled, { name, enabled })
  },
  talk: {
    run: (req: RunRequest) => ipcRenderer.invoke(IPC.talkRun, req),
    cancel: () => ipcRenderer.invoke(IPC.talkCancel),
    respondPermission: (res: PermissionResponse) => ipcRenderer.invoke(IPC.talkPermissionRespond, res),
    respondQuestion: (res: QuestionResponse) => ipcRenderer.invoke(IPC.talkQuestionRespond, res),
    bgTask: (req: BgTaskRequest) => ipcRenderer.invoke(IPC.talkBgTask, req),
    getState: () => ipcRenderer.invoke(IPC.talkGet),
    saveState: (data: unknown) => ipcRenderer.invoke(IPC.talkSave, data),
    onEvent: (cb: (e: EngineEvent) => void) => subscribe(IPC.talkEvent, cb)
  },
  openSessionWindow: () => ipcRenderer.invoke(IPC.openSessionWindow),
  session: {
    run: (req: RunRequest) => ipcRenderer.invoke(IPC.sessionRun, req),
    cancel: () => ipcRenderer.invoke(IPC.sessionCancel),
    respondPermission: (res: PermissionResponse) => ipcRenderer.invoke(IPC.sessionPermissionRespond, res),
    respondQuestion: (res: QuestionResponse) => ipcRenderer.invoke(IPC.sessionQuestionRespond, res),
    bgTask: (req: BgTaskRequest) => ipcRenderer.invoke(IPC.sessionBgTask, req),
    onEvent: (cb: (e: EngineEvent) => void) => subscribe(IPC.sessionEvent, cb),
    report: (info: { title: string; status: AgentStatus }) => ipcRenderer.invoke(IPC.sessionReport, info),
    hydrate: () => ipcRenderer.invoke(IPC.sessionHydrate),
    persist: (p: SessionPersistPayload) => ipcRenderer.invoke(IPC.sessionPersist, p),
    onFlushRequest: (cb: () => void) => subscribe<void>(IPC.sessionFlushRequest, () => cb())
  },
  sessionWindows: {
    list: () => ipcRenderer.invoke(IPC.sessionWindowsList),
    focus: (id: string) => ipcRenderer.invoke(IPC.sessionWindowFocus, id),
    close: (id: string) => ipcRenderer.invoke(IPC.sessionWindowClose, id),
    rename: (id: string, title: string) => ipcRenderer.invoke(IPC.sessionWindowRename, id, title),
    onChanged: (cb: (list: SessionWindowInfo[]) => void) => subscribe(IPC.sessionWindowsChanged, cb)
  },
  multi: {
    run: (req: MultiRunRequest) => ipcRenderer.invoke(IPC.maRun, req),
    cancel: (panelId: string) => ipcRenderer.invoke(IPC.maCancel, panelId),
    respondPermission: (res: MultiPermissionResponse) => ipcRenderer.invoke(IPC.maPermissionRespond, res),
    respondQuestion: (res: MultiQuestionResponse) => ipcRenderer.invoke(IPC.maQuestionRespond, res),
    bgTask: (panelId: string, req: BgTaskRequest) => ipcRenderer.invoke(IPC.maBgTask, panelId, req),
    dispose: (panelId: string) => ipcRenderer.invoke(IPC.maDispose, panelId),
    getState: () => ipcRenderer.invoke(IPC.maGet),
    saveState: (data: unknown) => ipcRenderer.invoke(IPC.maSave, data),
    // one shared channel for every panel's engine — deliver only the events for `panelId`
    onEvent: (panelId: string, cb: (e: EngineEvent) => void) =>
      subscribe(IPC.maEvent, (p: MultiEngineEvent) => {
        if (p.panelId === panelId) cb(p.event)
      })
  },
  app: {
    getVersion: () => ipcRenderer.invoke(IPC.appGetVersion) as Promise<string>,
    getInitialDirectory: () => ipcRenderer.invoke(IPC.appGetInitialDir) as Promise<string | null>,
    getUpdateStatus: () => ipcRenderer.invoke(IPC.updateGetStatus) as Promise<UpdateStatus>,
    checkForUpdate: () => ipcRenderer.invoke(IPC.updateCheck),
    installUpdate: () => ipcRenderer.invoke(IPC.updateInstall),
    onOpenDirectory: (cb: (dir: string) => void) => subscribe(IPC.openDirectory, cb),
    onUpdateEvent: (cb: (s: UpdateStatus) => void) => subscribe(IPC.updateEvent, cb)
  },
  notify: {
    event: (p) => ipcRenderer.invoke(IPC.notifyEvent, p),
    open: (key: string) => ipcRenderer.invoke(IPC.notifyOpen, key),
    close: () => ipcRenderer.invoke(IPC.notifyClose),
    resize: (height: number) => ipcRenderer.invoke(IPC.notifyResize, height),
    onShow: (cb) => subscribe(IPC.notifyShow, cb),
    onJump: (cb) => subscribe(IPC.notifyJump, cb)
  },
  onEngineEvent: (cb: (e: EngineEvent) => void) => subscribe(IPC.engineEvent, cb),
  onWinState: (cb: (s: WindowState) => void) => subscribe(IPC.winState, cb)
}

contextBridge.exposeInMainWorld('api', api)
