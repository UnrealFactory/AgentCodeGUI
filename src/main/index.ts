import { app, BrowserWindow, ipcMain, dialog, shell, session, screen, protocol } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { ClaudeEngine } from './claude/engine'
import * as engineVersions from './engine/versions'
import { readProfile, writeProfile } from './profile'
import { readUiPrefs, writeUiPrefs } from './uiPrefs'
import { readChats, writeChats } from './chats'
import { readMulti, writeMulti } from './maStore'
import { listSkills, setSkillEnabled } from './skills'
import { listMcpServers, setMcpEnabled } from './mcp'
import { listProjectFiles, listDir } from './files'
import * as gitApi from './git'
import { lspManager } from './lsp/manager'
import { initAutoUpdater, checkForUpdates, quitAndInstall, getUpdateStatus } from './updater'
import { IPC } from '@shared/protocol'
import type { EngineEvent, RunRequest, PermissionResponse, QuestionResponse, WindowBounds, ResizeEdge, SnapZone, UsageInfo, UsageWindow, FileReadResult, FileWriteResult, UserProfile, MultiRunRequest, MultiPermissionResponse, MultiQuestionResponse, LspPos } from '@shared/protocol'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── local image serving (composer attachments + chat image viewer) ───────────
// Renderer can't load file:// images from its http(dev)/file(prod) origin (webSecurity),
// so attached images are served over a private "ccg-img://" scheme. This must be declared
// privileged BEFORE app `ready`, hence at module scope. The handler is bound in bootstrap().
const IMG_EXTS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon'
}
protocol.registerSchemesAsPrivileged([
  { scheme: 'ccg-img', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }
])

// Directory holding pasted/dragged image data that has no source path of its own.
function attachmentsDir(): string {
  const dir = path.join(os.homedir(), '.agentcodegui', 'attachments')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

let mainWindow: BrowserWindow | null = null
let splashWindow: BrowserWindow | null = null

// A folder passed via the "AgentCodeGUI로 열기" context menu at launch. Held until
// the renderer asks for it (app:get-initial-dir), then cleared so it's applied once.
let pendingOpenDir: string | null = null

// When launched from the context menu, the selected folder is appended to argv (the
// NSIS verb runs `AgentCodeGUI.exe "%V"`). Pick the last argument that resolves to an
// existing directory, skipping Electron/Chromium flags. Only trusted in a packaged
// build — `electron-vite dev` passes its own paths that could look like a folder.
function openedDirFromArgv(argv: string[]): string | null {
  if (!app.isPackaged) return null
  for (let i = argv.length - 1; i >= 1; i--) {
    const a = argv[i]
    if (!a || a.startsWith('-')) continue
    try {
      if (fs.statSync(a).isDirectory()) return path.resolve(a)
    } catch {
      /* not a path — keep looking */
    }
  }
  return null
}

// Instant splash (logo + spinner) shown while the heavier main window loads, so
// launching the app gives immediate feedback instead of a blank delay then a pop-in.
const SPLASH_HTML = `<!doctype html><html><head><meta charset="utf-8" />
<style>
  html,body{margin:0;height:100%;background:transparent;overflow:hidden;
    font-family:'Wanted Sans Variable',system-ui,-apple-system,sans-serif;-webkit-user-select:none;user-select:none}
  .card{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
    background:oklch(0.992 0.002 80);border-radius:18px;
    box-shadow:0 24px 64px -22px rgba(40,30,20,.45),0 0 0 1px rgba(0,0,0,.06)}
  .logo{width:56px;height:56px;border-radius:16px;background:oklch(0.61 0.16 42);display:grid;place-items:center;
    color:#fff;font-weight:800;font-size:27px;font-family:'JetBrains Mono',ui-monospace,monospace;
    box-shadow:0 6px 16px -4px oklch(0.61 0.16 42 / .5)}
  .name{margin-top:16px;font-size:14px;font-weight:600;color:oklch(0.27 0.008 60);letter-spacing:-.01em}
  .spin{margin-top:18px;width:20px;height:20px;border-radius:50%;
    border:2.5px solid oklch(0.61 0.16 42 / .18);border-top-color:oklch(0.61 0.16 42);animation:s .7s linear infinite}
  .sub{margin-top:12px;font-size:11.5px;color:oklch(0.69 0.008 60)}
  @keyframes s{to{transform:rotate(360deg)}}
</style></head>
<body><div class="card">
  <div class="logo"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 8l-4 4 4 4"/><path d="M15 8l4 4-4 4"/></svg></div>
  <div class="name">AgentCodeGUI</div>
  <div class="spin"></div>
  <div class="sub">시작하는 중…</div>
</div></body></html>`

function createSplash(): void {
  try {
    splashWindow = new BrowserWindow({
      width: 300,
      height: 240,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      center: true
    })
    splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(SPLASH_HTML))
    splashWindow.once('ready-to-show', () => splashWindow?.show())
    // safety: never let the splash linger if the main window fails to signal
    setTimeout(closeSplash, 12000)
  } catch {
    /* ignore — splash is best-effort */
  }
}
function closeSplash(): void {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close()
  splashWindow = null
}

function send<T>(channel: string, payload: T): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

// ── persist window size/position/maximized across launches ──────────────────
interface WinState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}
const DEFAULT_STATE: WinState = { width: 1320, height: 880, maximized: false }
// Kept in the app home folder (~/.agentcodegui) alongside engine/config/profile,
// so all our data lives in one place and survives appId/name changes (unlike
// Electron's userData path, which is derived from the app name).
const stateFile = (): string => path.join(engineVersions.APP_HOME, 'window-state.json')

function loadWindowState(): WinState {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    if (typeof s.width === 'number' && typeof s.height === 'number') {
      return {
        x: typeof s.x === 'number' ? s.x : undefined,
        y: typeof s.y === 'number' ? s.y : undefined,
        width: Math.max(940, s.width),
        height: Math.max(600, s.height),
        maximized: !!s.maximized
      }
    }
  } catch {
    /* no saved state */
  }
  return DEFAULT_STATE
}

function isOnScreen(s: WinState): boolean {
  if (s.x == null || s.y == null) return false
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return s.x! < a.x + a.width && s.x! + s.width > a.x && s.y! < a.y + a.height && s.y! + s.height > a.y
  })
}

// Custom maximize: a transparent window gets no native maximize animation on
// Windows, so we animate the bounds ourselves and track the state here instead of
// relying on the OS maximize.
let customMaximized = false
let restoreBounds: WindowBounds | null = null

// The size we *intend* the window to be. A transparent window under fractional DPI
// scaling reads back ~1px larger than we set it (setBounds(W) ⇒ getBounds() === W+1),
// so re-deriving a gesture's locked size from getBounds() every time snowballed the
// window ~1px per title-bar drag / maximize-restore cycle. Steering by this intended
// size instead keeps the actual size settled — it never compounds. Updated only on
// deliberate size changes (initial create, edge-resize, restore).
let logicalSize: { width: number; height: number } | null = null

// Title-bar drag + edge-resize are driven by main-process timers that follow the live
// OS cursor. Hoisted to module scope so a lost-focus safety net (window 'blur') and the
// two gestures' mutual exclusion can reach them: a timer that outlives its mouseup is
// what made the window keep growing — it stays running and resizes on every later move.
let dragTimer: ReturnType<typeof setInterval> | null = null
let resizeTimer: ReturnType<typeof setInterval> | null = null
function stopDrag(): void {
  if (dragTimer) {
    clearInterval(dragTimer)
    dragTimer = null
  }
  hideSnapPreview() // 드래그가 끝나거나 끊기면 스냅 고스트도 같이 내린다
}
function stopResize(): void {
  if (resizeTimer) {
    clearInterval(resizeTimer)
    resizeTimer = null
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function saveWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  // remember the windowed (non-maximized) bounds even while maximized; take the size
  // from the clean intended size so the saved value doesn't carry the DPI inflation
  const b = customMaximized && restoreBounds ? restoreBounds : mainWindow.getBounds()
  const size = customMaximized ? b : logicalSize ?? b
  const state: WinState = { x: b.x, y: b.y, width: size.width, height: size.height, maximized: customMaximized }
  try {
    fs.mkdirSync(engineVersions.APP_HOME, { recursive: true })
    fs.writeFileSync(stateFile(), JSON.stringify(state))
  } catch {
    /* ignore */
  }
}
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(saveWindowState, 400)
}

function workAreaBounds(): WindowBounds {
  const d = mainWindow ? screen.getDisplayMatching(mainWindow.getBounds()) : screen.getPrimaryDisplay()
  const a = d.workArea
  return { x: a.x, y: a.y, width: a.width, height: a.height }
}
// maximize/restore is applied instantly — animating a transparent window's bounds
// stutters badly (every frame recomposites the layered window and re-lays-out the
// whole app). The light .win inset/border-radius CSS transition still softens the edge.
function setMaximized(want: boolean): void {
  if (!mainWindow || want === customMaximized) return
  if (want) {
    // capture the windowed bounds to restore to — but take the size from the clean
    // intended size, not the inflated getBounds(), so a maximize→restore round-trip
    // doesn't grow the window
    const b = mainWindow.getBounds()
    restoreBounds = logicalSize ? { x: b.x, y: b.y, width: logicalSize.width, height: logicalSize.height } : b
    customMaximized = true
    send(IPC.winState, { maximized: true })
    mainWindow.setBounds(workAreaBounds())
  } else {
    customMaximized = false
    send(IPC.winState, { maximized: false })
    if (restoreBounds) {
      mainWindow.setBounds(restoreBounds)
      logicalSize = { width: restoreBounds.width, height: restoreBounds.height }
    }
  }
  scheduleSave()
}

// ── 커스텀 스냅 (반쪽/쿼터/최대화) + 드래그 미리보기 ──────────────────────────
// 투명·프레임리스·수동드래그 창이라 네이티브 Snap Layouts/Aero Snap이 안 떠서 직접 구현.
function snapBounds(zone: Exclude<SnapZone, 'max'>, wa: WindowBounds): WindowBounds {
  const hw = Math.round(wa.width / 2)
  const hh = Math.round(wa.height / 2)
  const rw = wa.width - hw // 우측/하단 잔차 흡수 → 두 쪽이 화면을 정확히 채움
  const bh = wa.height - hh
  switch (zone) {
    case 'left':
      return { x: wa.x, y: wa.y, width: hw, height: wa.height }
    case 'right':
      return { x: wa.x + hw, y: wa.y, width: rw, height: wa.height }
    case 'tl':
      return { x: wa.x, y: wa.y, width: hw, height: hh }
    case 'tr':
      return { x: wa.x + hw, y: wa.y, width: rw, height: hh }
    case 'bl':
      return { x: wa.x, y: wa.y + hh, width: hw, height: bh }
    case 'br':
      return { x: wa.x + hw, y: wa.y + hh, width: rw, height: bh }
  }
}
function applySnap(zone: SnapZone): void {
  if (!mainWindow) return
  if (zone === 'max') {
    setMaximized(true)
    return
  }
  const b = snapBounds(zone, workAreaBounds())
  customMaximized = false
  mainWindow.setBounds(b)
  logicalSize = { width: b.width, height: b.height }
  send(IPC.winState, { maximized: false })
  scheduleSave()
}
// 커서가 디스플레이 가장자리/모서리에 닿았을 때의 스냅 존 (없으면 null). bounds = 디스플레이 전체.
function snapZoneFor(p: { x: number; y: number }, b: WindowBounds): SnapZone | null {
  const T = 22 // 직선 가장자리 두께 — 타이틀바 잡은 지점이 창 위에서 한참 아래라 넉넉히
  const C = 64 // 모서리로 인정하는 수직축 도달 범위
  const top = p.y <= b.y + T
  const bot = p.y >= b.y + b.height - T
  const lef = p.x <= b.x + T
  const rig = p.x >= b.x + b.width - T
  const cTop = p.y <= b.y + C
  const cBot = p.y >= b.y + b.height - C
  const cLef = p.x <= b.x + C
  const cRig = p.x >= b.x + b.width - C
  if ((lef && cTop) || (top && cLef)) return 'tl'
  if ((rig && cTop) || (top && cRig)) return 'tr'
  if ((lef && cBot) || (bot && cLef)) return 'bl'
  if ((rig && cBot) || (bot && cRig)) return 'br'
  if (top) return 'max'
  if (lef) return 'left'
  if (rig) return 'right'
  return null
}
// 스냅될 자리를 미리 보여주는 반투명 고스트 — mainWindow의 자식 창이라 함께 닫힌다.
let snapPreviewWin: BrowserWindow | null = null
let pendingSnapZone: SnapZone | null = null
function showSnapPreview(zone: SnapZone, wa: WindowBounds): void {
  if (!mainWindow) return
  if (!snapPreviewWin || snapPreviewWin.isDestroyed()) {
    snapPreviewWin = new BrowserWindow({
      parent: mainWindow,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      resizable: false,
      movable: false,
      hasShadow: false,
      fullscreenable: false,
      webPreferences: { sandbox: true }
    })
    snapPreviewWin.setIgnoreMouseEvents(true)
    const html =
      '<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent;overflow:hidden">' +
      '<div style="position:fixed;inset:7px;border-radius:12px;background:rgba(150,180,255,0.20);border:2px solid rgba(185,208,255,0.9)"></div></body>'
    snapPreviewWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  }
  const rect = zone === 'max' ? wa : snapBounds(zone, wa)
  snapPreviewWin.setBounds(rect)
  if (!snapPreviewWin.isVisible()) snapPreviewWin.showInactive()
}
function hideSnapPreview(): void {
  if (snapPreviewWin && !snapPreviewWin.isDestroyed() && snapPreviewWin.isVisible()) snapPreviewWin.hide()
}

const engine = new ClaudeEngine((event: EngineEvent) => send(IPC.engineEvent, event))
// A second, independent engine dedicated to the "/ask" throwaway conversation. It
// runs in parallel to `engine` (the main chat) on its own channel, so asking a quick
// side question never cancels the main run or mixes events into the work thread.
const askEngine = new ClaudeEngine((event: EngineEvent) => send(IPC.askEvent, event))

// ── multi-agent engine pool ─────────────────────────────────
// One ClaudeEngine per on-screen panel, created on demand and addressed by panelId.
// Each owns its own CLI subprocess, so N panels genuinely run in parallel; every event
// is tagged with the panelId on the shared maEvent channel for the renderer to route.
const maEngines = new Map<string, ClaudeEngine>()
function maEngine(panelId: string): ClaudeEngine {
  let eng = maEngines.get(panelId)
  if (!eng) {
    eng = new ClaudeEngine((event: EngineEvent) => send(IPC.maEvent, { panelId, event }))
    maEngines.set(panelId, eng)
  }
  return eng
}

function createWindow(): void {
  const state = loadWindowState()
  const positioned = isOnScreen(state)
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(positioned ? { x: state.x, y: state.y } : {}),
    minWidth: 940,
    minHeight: 600,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      // sandbox must be false to load the ESM (.mjs) preload. The preload only uses
      // contextBridge/ipcRenderer, so the surface is minimal; harden to sandbox:true
      // (which requires a CommonJS preload) before any non-local distribution. [M2+]
      sandbox: false
    }
  })

  logicalSize = { width: state.width, height: state.height }

  if (state.maximized) {
    restoreBounds = mainWindow.getBounds()
    customMaximized = true
    mainWindow.setBounds(workAreaBounds())
  }

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    closeSplash()
  })
  mainWindow.on('maximize', () => {
    // OS 경로(Win+↑ 등)로 최대화돼도 커스텀 최대화 체계로 일원화 — OS 최대화 상태로
    // 남겨두면 customMaximized=false라서 리사이즈 가드·복원 로직이 전부 어긋난다
    mainWindow?.unmaximize()
    setMaximized(true)
  })
  mainWindow.on('unmaximize', () => {
    send(IPC.winState, { maximized: false })
    saveWindowState()
  })
  mainWindow.on('resize', () => {
    // 커스텀 최대화 중인데 외부 경로(OS 스냅, Win+화살표 …)로 크기가 변했으면
    // 상태를 자가 치유 — 안 그러면 '최대화' 아이콘/가드와 실제 창이 어긋난 채 남는다
    if (customMaximized && mainWindow) {
      const wa = workAreaBounds()
      const b = mainWindow.getBounds()
      if (Math.abs(b.width - wa.width) > 2 || Math.abs(b.height - wa.height) > 2) {
        customMaximized = false
        send(IPC.winState, { maximized: false })
      }
    }
    scheduleSave()
  })
  mainWindow.on('move', scheduleSave)
  mainWindow.on('close', saveWindowState)
  // a drag/resize timer must never outlive its gesture — if focus leaves mid-drag
  // (alt-tab, a dialog, a click elsewhere), kill it so the window can't keep growing
  mainWindow.on('blur', () => {
    stopDrag()
    stopResize()
  })

  // Open external links in the OS browser, but only http/https; never navigate the app away.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const { protocol } = new URL(url)
      if (protocol === 'https:' || protocol === 'http:') shell.openExternal(url)
    } catch {
      /* malformed URL — ignore */
    }
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const dev = process.env['ELECTRON_RENDERER_URL']
    const allowed = (dev && url.startsWith(dev)) || url.startsWith('file:')
    if (!allowed) event.preventDefault()
  })
  // Ctrl/⌘+W는 Electron 기본 메뉴의 '창 닫기' 단축키라, 누르면 앱이 그대로 꺼진다 —
  // 삼켜서 앱 종료는 막되(before-input-event는 메뉴 단축키까지 차단), 렌더러엔 알려
  // 열린 코드 뷰어만 닫게 한다. (앱 종료는 창 닫기 버튼/Alt+F4로만)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.control || input.meta) && !input.alt && input.key.toLowerCase() === 'w') {
      event.preventDefault()
      send(IPC.closeShortcut, null)
    }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// ── OAuth rate-limit usage (5h / weekly), mirroring statusline.js ───────────
let usageCache: { at: number; data: UsageInfo } | null = null
const USAGE_TTL = 5 * 60 * 1000

async function getUsage(): Promise<UsageInfo> {
  const empty: UsageInfo = { fiveHour: null, weekly: null }
  if (usageCache && Date.now() - usageCache.at < USAGE_TTL) return usageCache.data
  let token: string | undefined
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'))
    token = creds?.claudeAiOauth?.accessToken
  } catch {
    /* no credentials */
  }
  if (!token) return empty
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 5000)
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: ctrl.signal
    })
    clearTimeout(timer)
    if (!res.ok) return empty
    const j = (await res.json()) as Record<string, { utilization?: number | string; resets_at?: string }>
    const toTs = (s?: string): number | null => {
      if (!s) return null
      const ms = Date.parse(s)
      return isNaN(ms) ? null : Math.floor(ms / 1000)
    }
    const win = (o?: { utilization?: number | string; resets_at?: string }): UsageWindow | null =>
      o ? { pct: Math.max(0, Math.min(100, Math.round(parseFloat(String(o.utilization ?? 0)) || 0))), resetsAt: toTs(o.resets_at) } : null
    const data: UsageInfo = { fiveHour: win(j.five_hour), weekly: win(j.seven_day) }
    usageCache = { at: Date.now(), data }
    return data
  } catch {
    return empty
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.runStart, async (_e, req: RunRequest) => engine.run(req))
  ipcMain.handle(IPC.runCancel, async () => {
    await engine.cancel()
  })
  ipcMain.handle(IPC.permissionRespond, async (_e, res: PermissionResponse) => engine.respondPermission(res))
  ipcMain.handle(IPC.questionRespond, async (_e, res: QuestionResponse) => engine.respondQuestion(res))

  // /ask — the independent ephemeral conversation, driven by its own engine instance
  ipcMain.handle(IPC.askRun, async (_e, req: RunRequest) => askEngine.run(req))
  ipcMain.handle(IPC.askCancel, async () => {
    await askEngine.cancel()
  })
  ipcMain.handle(IPC.askPermissionRespond, async (_e, res: PermissionResponse) => askEngine.respondPermission(res))
  ipcMain.handle(IPC.askQuestionRespond, async (_e, res: QuestionResponse) => askEngine.respondQuestion(res))

  // multi-agent — route each command to its panel's engine (lazily created on first run)
  ipcMain.handle(IPC.maRun, async (_e, req: MultiRunRequest) => maEngine(req.panelId).run(req))
  ipcMain.handle(IPC.maCancel, async (_e, panelId: string) => {
    await maEngines.get(panelId)?.cancel()
  })
  ipcMain.handle(IPC.maPermissionRespond, async (_e, res: MultiPermissionResponse) =>
    maEngines.get(res.panelId)?.respondPermission(res)
  )
  ipcMain.handle(IPC.maQuestionRespond, async (_e, res: MultiQuestionResponse) =>
    maEngines.get(res.panelId)?.respondQuestion(res)
  )
  // a removed panel: stop its run and drop the engine so its subprocess is released
  ipcMain.handle(IPC.maDispose, async (_e, panelId: string) => {
    const eng = maEngines.get(panelId)
    if (eng) {
      await eng.cancel()
      maEngines.delete(panelId)
    }
  })
  ipcMain.handle(IPC.maGet, async () => readMulti())
  ipcMain.handle(IPC.maSave, async (_e, data: unknown) => writeMulti(data))

  ipcMain.handle(IPC.pickDirectory, async () => {
    if (!mainWindow) return null
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: '작업할 프로젝트 폴더 선택'
    })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })
  ipcMain.handle(IPC.pickImages, async () => {
    if (!mainWindow) return []
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      title: '첨부할 이미지 선택',
      filters: [{ name: '이미지', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico'] }]
    })
    return r.canceled ? [] : r.filePaths
  })
  // a pasted screenshot or an image dragged from a browser has no file path — its raw
  // bytes are written to the app's attachments folder so it gets a path to show + attach
  ipcMain.handle(IPC.saveImageData, async (_e, a: { bytes: ArrayBuffer; ext: string }): Promise<string> => {
    const ext = ('.' + String(a.ext || 'png').replace(/^\.+/, '').toLowerCase()).replace(/[^.a-z0-9]/g, '')
    const safeExt = ext in IMG_EXTS ? ext : '.png'
    const abs = path.join(attachmentsDir(), `paste-${randomUUID()}${safeExt}`)
    await fs.promises.writeFile(abs, Buffer.from(a.bytes))
    return abs
  })
  ipcMain.handle(IPC.getUsage, async () => getUsage())

  // local user profile (nickname + avatar color), stored in the app home folder
  ipcMain.handle(IPC.profileGet, async () => readProfile())
  ipcMain.handle(IPC.profileSave, async (_e, profile: UserProfile) => writeProfile(profile))

  // chat history, persisted so conversations continue after a restart
  ipcMain.handle(IPC.chatsGet, async () => readChats())
  ipcMain.handle(IPC.chatsSave, async (_e, data: unknown) => writeChats(data))

  // renderer UI prefs (viewer size/zoom, chat zoom), stored in the app home folder
  ipcMain.handle(IPC.uiPrefsGet, async () => readUiPrefs())
  ipcMain.handle(IPC.uiPrefsSave, async (_e, prefs: Record<string, unknown>) => writeUiPrefs(prefs))

  // skills (SKILL.md capabilities): list global (~/.claude) + project (.claude),
  // and turn them on/off. The on/off choice is applied to runs by the engine.
  ipcMain.handle(IPC.skillList, async (_e, cwd: string) => listSkills(cwd || ''))
  ipcMain.handle(IPC.skillSetEnabled, async (_e, a: { name: string; enabled: boolean }) =>
    setSkillEnabled(a.name, a.enabled)
  )

  // MCP servers (Model Context Protocol): list user (~/.claude.json) + project
  // (.mcp.json) + local servers, and turn them on/off (applied to runs by the engine).
  ipcMain.handle(IPC.mcpList, async (_e, cwd: string) => listMcpServers(cwd || ''))
  ipcMain.handle(IPC.mcpSetEnabled, async (_e, a: { name: string; enabled: boolean }) =>
    setMcpEnabled(a.name, a.enabled)
  )

  ipcMain.handle(IPC.shellOpenPath, async (_e, a: { cwd: string; relPath: string }) => {
    const abs = path.isAbsolute(a.relPath) ? a.relPath : path.join(a.cwd, a.relPath)
    await shell.openPath(abs)
  })

  // Read a file's text for the in-app viewer card. Caps the read so a huge file
  // can't stall the UI, and rejects binaries (a null byte in the head) so the card
  // shows a friendly notice instead of garbage.
  ipcMain.handle(IPC.readFile, async (_e, a: { cwd: string; relPath: string }): Promise<FileReadResult> => {
    const MAX = 1.5 * 1024 * 1024
    const abs = path.isAbsolute(a.relPath) ? a.relPath : path.join(a.cwd || '', a.relPath)
    const isBinary = (buf: Buffer): boolean => {
      const n = Math.min(buf.length, 8000)
      for (let i = 0; i < n; i++) if (buf[i] === 0) return true
      return false
    }
    try {
      const st = await fs.promises.stat(abs)
      if (!st.isFile()) return { path: a.relPath, content: null, truncated: false, error: '파일이 아니에요' }
      if (st.size > MAX) {
        const fd = await fs.promises.open(abs, 'r')
        try {
          const buf = Buffer.alloc(MAX)
          const { bytesRead } = await fd.read(buf, 0, MAX, 0)
          const head = buf.subarray(0, bytesRead)
          if (isBinary(head)) return { path: a.relPath, content: null, truncated: false, error: '미리보기를 지원하지 않는 파일이에요' }
          return { path: a.relPath, content: head.toString('utf8'), truncated: true }
        } finally {
          await fd.close()
        }
      }
      const buf = await fs.promises.readFile(abs)
      if (isBinary(buf)) return { path: a.relPath, content: null, truncated: false, error: '미리보기를 지원하지 않는 파일이에요' }
      return { path: a.relPath, content: buf.toString('utf8'), truncated: false }
    } catch {
      return { path: a.relPath, content: null, truncated: false, error: '파일을 열 수 없어요' }
    }
  })

  // Overwrite a file's text from the in-app editor (Ctrl+S). Writes utf-8 to the same
  // resolved path readFile uses; the renderer holds the buffer, so this is the only
  // disk write for editing.
  ipcMain.handle(IPC.writeFile, async (_e, a: { cwd: string; relPath: string; content: string }): Promise<FileWriteResult> => {
    const abs = path.isAbsolute(a.relPath) ? a.relPath : path.join(a.cwd || '', a.relPath)
    try {
      await fs.promises.writeFile(abs, a.content, 'utf8')
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message || '파일을 저장할 수 없어요' }
    }
  })

  // Enumerate project files (relative paths) for the "@" mention palette. Bounded and
  // generated-dir-aware in listProjectFiles so a big repo can't stall the picker.
  ipcMain.handle(IPC.listFiles, async (_e, cwd: string) => listProjectFiles(cwd || ''))

  // One folder's entries for the file explorer — called lazily as folders expand
  ipcMain.handle(IPC.listDir, async (_e, a: { cwd: string; rel: string }) => listDir(a.cwd || '', a.rel || ''))

  // LSP code intelligence for the in-app viewer — lazy per-project language servers.
  // Failures degrade to null/[]: the viewer just loses hover/jump, never errors.
  // ── git — 탐색기 Git 카드 (읽기 + 커밋/푸시/풀) ────────────
  ipcMain.handle(IPC.gitRoot, async (_e, a: { cwd: string; force?: boolean }) => gitApi.gitRoot(a.cwd || '', !!a.force))
  ipcMain.handle(IPC.gitStatus, async (_e, root: string) => gitApi.gitStatus(root))
  ipcMain.handle(IPC.gitLog, async (_e, a: { root: string; limit?: number }) => gitApi.gitLog(a.root, a.limit))
  ipcMain.handle(IPC.gitCommitDetail, async (_e, a: { root: string; hash: string }) =>
    gitApi.gitCommitDetail(a.root, a.hash)
  )
  ipcMain.handle(IPC.gitFileAt, async (_e, a: { root: string; hash: string; path: string }) =>
    gitApi.gitFileAt(a.root, a.hash, a.path)
  )
  ipcMain.handle(IPC.gitWorkingFile, async (_e, a: { root: string; path: string }) =>
    gitApi.gitWorkingFile(a.root, a.path)
  )
  ipcMain.handle(IPC.gitCommit, async (_e, a: { root: string; subject: string; body: string }) =>
    gitApi.gitCommit(a.root, a.subject, a.body)
  )
  ipcMain.handle(IPC.gitPush, async (_e, root: string) => gitApi.gitPush(root))
  ipcMain.handle(IPC.gitPull, async (_e, root: string) => gitApi.gitPull(root))

  ipcMain.handle(IPC.lspStatus, async (_e, a: { cwd: string; relPath: string }) =>
    lspManager.status(a.cwd || '', a.relPath)
  )
  ipcMain.handle(IPC.lspHover, async (_e, a: { cwd: string; relPath: string; pos: LspPos }) =>
    lspManager.hover(a.cwd || '', a.relPath, a.pos).catch(() => null)
  )
  ipcMain.handle(IPC.lspDefinition, async (_e, a: { cwd: string; relPath: string; pos: LspPos }) =>
    lspManager.definition(a.cwd || '', a.relPath, a.pos).catch(() => [])
  )
  ipcMain.handle(IPC.lspSemanticTokens, async (_e, a: { cwd: string; relPath: string }) =>
    lspManager.semanticTokens(a.cwd || '', a.relPath).catch(() => null)
  )
  ipcMain.handle(IPC.lspCachedTokens, async (_e, a: { cwd: string; relPath: string }) =>
    lspManager.cachedTokens(a.cwd || '', a.relPath).catch(() => null)
  )
  ipcMain.handle(IPC.lspPrewarm, async (_e, a: { cwd: string }) => {
    lspManager.prewarm(a.cwd || '')
  })
  ipcMain.handle(IPC.lspProjectStatus, async (_e, a: { cwd: string }) => lspManager.projectStatus(a.cwd || ''))
  ipcMain.handle(IPC.lspInstall, async (_e, a: { cwd: string; relPath: string }) =>
    lspManager.install(a.cwd || '', a.relPath, (p) => send(IPC.lspInstallProgress, p))
  )
  ipcMain.handle(IPC.lspServers, async () => lspManager.listServers())
  ipcMain.handle(IPC.lspInstallServer, async (_e, id: string) =>
    lspManager.installServer(id, (p) => send(IPC.lspInstallProgress, p))
  )
  // resolve to { ok } instead of throwing — the settings card shows the reason
  ipcMain.handle(IPC.lspUninstallServer, async (_e, id: string) =>
    lspManager
      .uninstallServer(id)
      .then(() => ({ ok: true as const }))
      .catch((e) => ({ ok: false as const, error: (e as Error).message || '삭제하지 못했어요' }))
  )

  ipcMain.handle(IPC.winMinimize, async () => mainWindow?.minimize())
  ipcMain.handle(IPC.winMaximizeToggle, async () => {
    setMaximized(!customMaximized)
    return customMaximized
  })
  ipcMain.handle(IPC.winClose, async () => mainWindow?.close())
  ipcMain.handle(IPC.winIsMaximized, async () => customMaximized)
  ipcMain.handle(IPC.winGetBounds, async () => mainWindow?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 })
  ipcMain.handle(IPC.winSetBounds, async (_e, b: WindowBounds) => {
    if (mainWindow && !customMaximized) {
      mainWindow.setBounds(b)
      logicalSize = { width: b.width, height: b.height }
    }
  })

  // Manual title-bar drag. The frameless+transparent window can't use
  // -webkit-app-region:drag and still receive double-click, so we move the window
  // from here: on drag-start, poll the cursor and follow it by the grab offset.
  ipcMain.handle(IPC.winDragStart, async () => {
    if (!mainWindow) return
    stopResize() // a drag and a resize must never run at the same time
    const cursor = screen.getCursorScreenPoint()
    if (customMaximized) {
      // 윈도우 표준 동작: 최대화된 창의 타이틀바를 끌면 복원되면서 그대로 들려 간다.
      // 커서의 가로 비율을 유지해 복원 창에서도 잡았던 지점이 손에 남게 한다.
      const wa = workAreaBounds()
      const ratio = Math.min(1, Math.max(0, (cursor.x - wa.x) / wa.width))
      setMaximized(false) // restoreBounds 크기로 복원 + 상태 브로드캐스트
      const rb = mainWindow.getBounds()
      mainWindow.setBounds({
        x: Math.round(cursor.x - rb.width * ratio),
        y: Math.max(wa.y, cursor.y - 18), // 타이틀바를 쥔 손가락 아래로
        width: rb.width,
        height: rb.height
      })
      logicalSize = { width: rb.width, height: rb.height }
    }
    const b0 = mainWindow.getBounds()
    const offX = cursor.x - b0.x
    const offY = cursor.y - b0.y
    // Lock the *intended* size, not getBounds(): on a transparent window under
    // fractional DPI scaling getBounds() reads ~1px larger than what we set, so
    // re-deriving the size from it each drag grew the window ~1px per gesture.
    if (!logicalSize) logicalSize = { width: b0.width, height: b0.height }
    const width = logicalSize.width
    const height = logicalSize.height
    stopDrag()
    pendingSnapZone = null
    let lastX = b0.x
    let lastY = b0.y
    dragTimer = setInterval(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return stopDrag()
      const p = screen.getCursorScreenPoint()
      const x = p.x - offX
      const y = p.y - offY
      // skip when the cursor hasn't moved: nudging a still window every 8ms would still
      // inflate it (see below), and there's nothing to move anyway
      if (x === lastX && y === lastY) return
      lastX = x
      lastY = y
      // setBounds with the *locked* grab-time size — NOT setPosition. On a transparent
      // window with fractional display scaling, setPosition lets Chromium recompute the
      // size from physical pixels and round it up ~1px every call, so a held/long drag
      // grew the window without bound. Re-asserting the exact size each frame pins it.
      mainWindow.setBounds({ x, y, width, height })
      // 커서가 가장자리/모서리에 닿으면 스냅 고스트를 그 자리에 띄운다 (놓으면 거기로 스냅)
      const disp = screen.getDisplayNearestPoint(p)
      const zone = snapZoneFor(p, disp.bounds)
      if (zone !== pendingSnapZone) {
        pendingSnapZone = zone
        if (zone) showSnapPreview(zone, disp.workArea)
        else hideSnapPreview()
      }
    }, 8)
  })
  ipcMain.handle(IPC.winDragEnd, async () => {
    stopDrag() // 고스트도 내려간다
    if (pendingSnapZone) {
      const z = pendingSnapZone
      pendingSnapZone = null
      applySnap(z)
    }
  })

  // Manual edge resize. Like the drag, we sample the real OS cursor here instead of
  // trusting renderer pointer events: a renderer-driven resize on the top/left edges
  // moves the window origin, which fires fresh pointer events under the captured
  // handle and snowballs the window larger every frame. Anchoring the opposite edges
  // to the grab-time bounds and following the live cursor makes a still hold a no-op.
  const MIN_W = 940
  const MIN_H = 600
  ipcMain.handle(IPC.winResizeStart, async (_e, edge: ResizeEdge) => {
    if (!mainWindow || customMaximized) return
    stopDrag() // a drag and a resize must never run at the same time
    const b0 = mainWindow.getBounds()
    const c0 = screen.getCursorScreenPoint()
    const left0 = b0.x
    const top0 = b0.y
    const right0 = b0.x + b0.width
    const bottom0 = b0.y + b0.height
    stopResize()
    let prev = ''
    resizeTimer = setInterval(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return stopResize()
      const p = screen.getCursorScreenPoint()
      const dx = p.x - c0.x
      const dy = p.y - c0.y
      let left = left0
      let top = top0
      let right = right0
      let bottom = bottom0
      // each grabbed edge follows the cursor; the opposite edge stays pinned to its
      // grab-time position, so width/height clamp without ever shifting the anchor
      if (edge.includes('e')) right = Math.max(left0 + MIN_W, right0 + dx)
      if (edge.includes('w')) left = Math.min(right0 - MIN_W, left0 + dx)
      if (edge.includes('s')) bottom = Math.max(top0 + MIN_H, bottom0 + dy)
      if (edge.includes('n')) top = Math.min(bottom0 - MIN_H, top0 + dy)
      const next = { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) }
      // skip when the target is unchanged (still cursor) — re-setting identical bounds
      // can still drift ±1px under fractional DPI rounding
      const key = `${next.x},${next.y},${next.width},${next.height}`
      if (key === prev) return
      prev = key
      mainWindow.setBounds(next)
      // remember the intended size so a later drag re-asserts this, not the
      // inflated getBounds(), and the window doesn't drift after a resize
      logicalSize = { width: next.width, height: next.height }
    }, 8)
  })
  ipcMain.handle(IPC.winResizeEnd, async () => stopResize())

  // ── engine (Claude Code SDK) version management ──
  ipcMain.handle(IPC.engineListAvailable, async () => engineVersions.listAvailable())
  ipcMain.handle(IPC.engineState, async () => engineVersions.getState())
  ipcMain.handle(IPC.engineInstall, async (_e, version: string) =>
    engineVersions.install(version, (p) => send(IPC.engineInstallProgress, p))
  )
  ipcMain.handle(IPC.engineUninstall, async (_e, version: string) => engineVersions.uninstall(version))
  ipcMain.handle(IPC.engineSetActive, async (_e, version: string | null) => engineVersions.setActive(version))

  // ── app meta + auto-update ──
  ipcMain.handle(IPC.appGetVersion, async () => app.getVersion())
  // the folder from "AgentCodeGUI로 열기" at launch — returned once, then cleared
  ipcMain.handle(IPC.appGetInitialDir, async () => {
    const d = pendingOpenDir
    pendingOpenDir = null
    return d
  })
  ipcMain.handle(IPC.updateGetStatus, async () => getUpdateStatus())
  ipcMain.handle(IPC.updateCheck, async () => checkForUpdates())
  ipcMain.handle(IPC.updateInstall, async () => quitAndInstall())
}

// Single-instance: a second launch (e.g. "AgentCodeGUI로 열기" while the app is
// already running) focuses the existing window and forwards the folder, rather than
// spawning a duplicate process.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    const dir = openedDirFromArgv(argv)
    if (dir) send(IPC.openDirectory, dir)
  })
  bootstrap()
}

function bootstrap(): void {
  app.whenReady().then(() => {
  // a folder passed on the command line (context-menu launch) is applied once the UI asks
  pendingOpenDir = openedDirFromArgv(process.argv)
  // carry over an engine installed under the old (pre-rebrand) home folder
  engineVersions.migrateLegacyHome()
  registerIpc()
  // serve attached images to the renderer: ccg-img://local/?p=<absolute path>
  protocol.handle('ccg-img', async (request) => {
    try {
      const p = new URL(request.url).searchParams.get('p')
      if (!p) return new Response('bad request', { status: 400 })
      const ext = path.extname(p).toLowerCase()
      const mime = IMG_EXTS[ext]
      const st = await fs.promises.stat(p)
      if (!mime || !st.isFile()) return new Response('not found', { status: 404 })
      const data = await fs.promises.readFile(p)
      return new Response(data, { headers: { 'content-type': mime, 'cache-control': 'no-cache' } })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
  createSplash()
  // Production CSP. Skipped in dev because Vite's HMR needs inline/eval + ws.
  if (!process.env['ELECTRON_RENDERER_URL']) {
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; " +
              "script-src 'self'; " +
              "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; " +
              "font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net data:; " +
              "img-src 'self' data: ccg-img:; " +
              // 패치노트 시네마틱 배경 비디오 (Cloudinary + 이전 CloudFront 폴백)
              "media-src 'self' https://res.cloudinary.com https://d8j0ntlcm91z4.cloudfront.net; " +
              "connect-src 'self'"
          ]
        }
      })
    })
  }
  createWindow()
  // background auto-update against GitHub Releases (no-op in dev). Status is streamed
  // to the renderer so the UI can surface an "update available / ready" banner.
  initAutoUpdater((e) => send(IPC.updateEvent, e))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  })
}

app.on('window-all-closed', () => {
  lspManager.disposeAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  lspManager.disposeAll()
})
