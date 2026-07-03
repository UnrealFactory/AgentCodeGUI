import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { IPC } from '@shared/protocol'
import type {
  RunRequest,
  PermissionResponse,
  QuestionResponse,
  EngineEvent,
  WindowState,
  UserProfile,
  UpdateStatus,
  MultiRunRequest,
  MultiPermissionResponse,
  MultiQuestionResponse,
  MultiEngineEvent
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
  pickDirectory: () => ipcRenderer.invoke(IPC.pickDirectory),
  pickImages: () => ipcRenderer.invoke(IPC.pickImages),
  saveImageData: (bytes: ArrayBuffer, ext: string) => ipcRenderer.invoke(IPC.saveImageData, { bytes, ext }),
  // webUtils.getPathForFile must run in the preload (not the sandboxed renderer); the
  // File is passed through the contextBridge function call and resolved to its OS path
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  getUsage: () => ipcRenderer.invoke(IPC.getUsage),
  apiConfig: {
    get: () => ipcRenderer.invoke(IPC.apiConfigGet),
    setKey: (key: string) => ipcRenderer.invoke(IPC.apiConfigSetKey, key),
    clearKey: () => ipcRenderer.invoke(IPC.apiConfigClearKey),
    setBudget: (usd: number | null) => ipcRenderer.invoke(IPC.apiConfigSetBudget, usd),
    resetSpend: () => ipcRenderer.invoke(IPC.apiConfigResetSpend),
    listUsage: () => ipcRenderer.invoke(IPC.apiUsageList)
  },
  getProfile: () => ipcRenderer.invoke(IPC.profileGet) as Promise<UserProfile | null>,
  saveProfile: (profile: UserProfile) => ipcRenderer.invoke(IPC.profileSave, profile),
  getChats: () => ipcRenderer.invoke(IPC.chatsGet),
  saveChats: (data: unknown) => ipcRenderer.invoke(IPC.chatsSave, data),
  getUiPrefs: () => ipcRenderer.invoke(IPC.uiPrefsGet) as Promise<Record<string, unknown>>,
  saveUiPrefs: (prefs: Record<string, unknown>) => ipcRenderer.invoke(IPC.uiPrefsSave, prefs),
  openPath: (cwd, relPath) => ipcRenderer.invoke(IPC.shellOpenPath, { cwd, relPath }),
  revealPath: (cwd, relPath) => ipcRenderer.invoke(IPC.shellRevealPath, { cwd, relPath }),
  renamePath: (cwd, relPath, newName) => ipcRenderer.invoke(IPC.fsRename, { cwd, relPath, newName }),
  deletePath: (cwd, relPath) => ipcRenderer.invoke(IPC.fsDelete, { cwd, relPath }),
  createPath: (cwd, relPath, dir) => ipcRenderer.invoke(IPC.fsCreate, { cwd, relPath, dir }),
  movePath: (cwd, srcRel, destRel) => ipcRenderer.invoke(IPC.fsMove, { cwd, srcRel, destRel }),
  readFile: (cwd, relPath) => ipcRenderer.invoke(IPC.readFile, { cwd, relPath }),
  writeFile: (cwd, relPath, content) => ipcRenderer.invoke(IPC.writeFile, { cwd, relPath, content }),
  onCloseShortcut: (cb) => subscribe<void>(IPC.closeShortcut, () => cb()),
  listFiles: (cwd) => ipcRenderer.invoke(IPC.listFiles, cwd),
  listDir: (cwd, rel, exclude, hideEmpty) => ipcRenderer.invoke(IPC.listDir, { cwd, rel, exclude, hideEmpty }),
  git: {
    root: (cwd: string, force?: boolean) => ipcRenderer.invoke(IPC.gitRoot, { cwd, force }),
    status: (root: string) => ipcRenderer.invoke(IPC.gitStatus, root),
    log: (root: string, limit?: number) => ipcRenderer.invoke(IPC.gitLog, { root, limit }),
    commitDetail: (root: string, hash: string) => ipcRenderer.invoke(IPC.gitCommitDetail, { root, hash }),
    fileAt: (root: string, hash: string, path: string) => ipcRenderer.invoke(IPC.gitFileAt, { root, hash, path }),
    workingFile: (root: string, path: string) => ipcRenderer.invoke(IPC.gitWorkingFile, { root, path }),
    commit: (root: string, subject: string, body: string) => ipcRenderer.invoke(IPC.gitCommit, { root, subject, body }),
    push: (root: string) => ipcRenderer.invoke(IPC.gitPush, root),
    pull: (root: string) => ipcRenderer.invoke(IPC.gitPull, root)
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
    prewarm: (cwd: string) => ipcRenderer.invoke(IPC.lspPrewarm, { cwd }),
    warm: (cwd: string, relPath: string) => ipcRenderer.invoke(IPC.lspWarm, { cwd, relPath }),
    verseRegistry: (cwd: string, relPath: string, knownRev?: number) =>
      ipcRenderer.invoke(IPC.lspVerseRegistry, { cwd, relPath, knownRev }),
    projectStatus: (cwd: string) => ipcRenderer.invoke(IPC.lspProjectStatus, { cwd }),
    verseDigests: (cwd: string) => ipcRenderer.invoke(IPC.lspVerseDigests, { cwd }),
    verseExcludes: (cwd: string) => ipcRenderer.invoke(IPC.lspVerseExcludes, { cwd }),
    install: (cwd: string, relPath: string) => ipcRenderer.invoke(IPC.lspInstall, { cwd, relPath }),
    onInstallProgress: (cb) => subscribe(IPC.lspInstallProgress, cb),
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
    isMaximized: () => ipcRenderer.invoke(IPC.winIsMaximized),
    getBounds: () => ipcRenderer.invoke(IPC.winGetBounds),
    setBounds: (bounds) => ipcRenderer.invoke(IPC.winSetBounds, bounds),
    dragStart: () => ipcRenderer.invoke(IPC.winDragStart),
    dragEnd: () => ipcRenderer.invoke(IPC.winDragEnd),
    resizeStart: (edge) => ipcRenderer.invoke(IPC.winResizeStart, edge),
    resizeEnd: () => ipcRenderer.invoke(IPC.winResizeEnd)
  },
  engine: {
    listAvailable: () => ipcRenderer.invoke(IPC.engineListAvailable),
    state: () => ipcRenderer.invoke(IPC.engineState),
    install: (version: string) => ipcRenderer.invoke(IPC.engineInstall, version),
    uninstall: (version: string) => ipcRenderer.invoke(IPC.engineUninstall, version),
    setActive: (version: string | null) => ipcRenderer.invoke(IPC.engineSetActive, version),
    onInstallProgress: (cb) => subscribe(IPC.engineInstallProgress, cb)
  },
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
  ask: {
    run: (req: RunRequest) => ipcRenderer.invoke(IPC.askRun, req),
    cancel: () => ipcRenderer.invoke(IPC.askCancel),
    respondPermission: (res: PermissionResponse) => ipcRenderer.invoke(IPC.askPermissionRespond, res),
    respondQuestion: (res: QuestionResponse) => ipcRenderer.invoke(IPC.askQuestionRespond, res),
    onEvent: (cb: (e: EngineEvent) => void) => subscribe(IPC.askEvent, cb)
  },
  talk: {
    run: (req: RunRequest) => ipcRenderer.invoke(IPC.talkRun, req),
    cancel: () => ipcRenderer.invoke(IPC.talkCancel),
    respondPermission: (res: PermissionResponse) => ipcRenderer.invoke(IPC.talkPermissionRespond, res),
    respondQuestion: (res: QuestionResponse) => ipcRenderer.invoke(IPC.talkQuestionRespond, res),
    getState: () => ipcRenderer.invoke(IPC.talkGet),
    saveState: (data: unknown) => ipcRenderer.invoke(IPC.talkSave, data),
    onEvent: (cb: (e: EngineEvent) => void) => subscribe(IPC.talkEvent, cb)
  },
  multi: {
    run: (req: MultiRunRequest) => ipcRenderer.invoke(IPC.maRun, req),
    cancel: (panelId: string) => ipcRenderer.invoke(IPC.maCancel, panelId),
    respondPermission: (res: MultiPermissionResponse) => ipcRenderer.invoke(IPC.maPermissionRespond, res),
    respondQuestion: (res: MultiQuestionResponse) => ipcRenderer.invoke(IPC.maQuestionRespond, res),
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
  onEngineEvent: (cb: (e: EngineEvent) => void) => subscribe(IPC.engineEvent, cb),
  onWinState: (cb: (s: WindowState) => void) => subscribe(IPC.winState, cb)
}

contextBridge.exposeInMainWorld('api', api)
