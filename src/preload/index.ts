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

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
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
  getProfile: () => ipcRenderer.invoke(IPC.profileGet) as Promise<UserProfile | null>,
  saveProfile: (profile: UserProfile) => ipcRenderer.invoke(IPC.profileSave, profile),
  getChats: () => ipcRenderer.invoke(IPC.chatsGet),
  saveChats: (data: unknown) => ipcRenderer.invoke(IPC.chatsSave, data),
  getUiPrefs: () => ipcRenderer.invoke(IPC.uiPrefsGet) as Promise<Record<string, unknown>>,
  saveUiPrefs: (prefs: Record<string, unknown>) => ipcRenderer.invoke(IPC.uiPrefsSave, prefs),
  openPath: (cwd, relPath) => ipcRenderer.invoke(IPC.shellOpenPath, { cwd, relPath }),
  readFile: (cwd, relPath) => ipcRenderer.invoke(IPC.readFile, { cwd, relPath }),
  writeFile: (cwd, relPath, content) => ipcRenderer.invoke(IPC.writeFile, { cwd, relPath, content }),
  onCloseShortcut: (cb) => subscribe<void>(IPC.closeShortcut, () => cb()),
  listFiles: (cwd) => ipcRenderer.invoke(IPC.listFiles, cwd),
  listDir: (cwd, rel) => ipcRenderer.invoke(IPC.listDir, { cwd, rel }),
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
    hover: (cwd: string, relPath: string, pos: LspPos) => ipcRenderer.invoke(IPC.lspHover, { cwd, relPath, pos }),
    definition: (cwd: string, relPath: string, pos: LspPos) =>
      ipcRenderer.invoke(IPC.lspDefinition, { cwd, relPath, pos }),
    semanticTokens: (cwd: string, relPath: string) => ipcRenderer.invoke(IPC.lspSemanticTokens, { cwd, relPath }),
    cachedTokens: (cwd: string, relPath: string) => ipcRenderer.invoke(IPC.lspCachedTokens, { cwd, relPath }),
    prewarm: (cwd: string) => ipcRenderer.invoke(IPC.lspPrewarm, { cwd }),
    projectStatus: (cwd: string) => ipcRenderer.invoke(IPC.lspProjectStatus, { cwd }),
    install: (cwd: string, relPath: string) => ipcRenderer.invoke(IPC.lspInstall, { cwd, relPath }),
    onInstallProgress: (cb) => subscribe(IPC.lspInstallProgress, cb),
    servers: () => ipcRenderer.invoke(IPC.lspServers),
    installServer: (id: string) => ipcRenderer.invoke(IPC.lspInstallServer, id),
    uninstallServer: (id: string) => ipcRenderer.invoke(IPC.lspUninstallServer, id)
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
