import { app, BrowserWindow, ipcMain, screen } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC } from '@shared/protocol'
import type { NotifyEntry, NotifyEventPayload, NotifyTarget } from '@shared/protocol'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── 포커스 밖 알림 토스트 ─────────────────────────────────────────────────────
// 채팅 표면(메인 창·멀티 패널·추가 채팅 창)이 전이(턴 종료/승인 대기/질문)를 보내면,
// 그 창이 포커스를 잃은 경우에만 "커서가 있는 모니터" 우하단에 작은 토스트 창을 띄운다.
// 창=카드: frameless+불투명 검정+focusable:false — 떠도 포커스를 절대 뺏지 않는다.
// 자동 닫힘 없음(사용자 결정) — 클릭(점프)·✕·해당 창 포커스 회복만이 소멸 경로다.
// 토스트 창은 필요할 때 만들고 비면 부순다 — 숨은 창이 window-all-closed(앱 종료)를
// 막는 부류의 사고를 구조적으로 없앤다(닫기 정리 대기 세션 창과 같은 함정).

interface Deps {
  getMainWindow(): BrowserWindow | null
  /** 추가 채팅 라우팅 — 열려 있으면 포커스, 닫힌 채팅이면 창을 다시 만든다 */
  focusSessionChat(chatId: string): void
  /** 이 webContents가 추가 채팅 창이면 그 영속 채팅 id (아니면 null) */
  sessionChatIdFor(wcId: number): string | null
  /** 설정 › 알림 on/off (ui-prefs notify.toast, 기본 on) */
  isEnabled(): boolean
}

const TOAST_W = 360
const TOAST_MARGIN = 16

let deps: Deps | null = null
// 업서트 키(surface:id[:sub]) → 항목. 같은 채팅의 승인→완료는 최신 것으로 갈아끼운다.
const pending = new Map<string, NotifyEntry & { winId: number }>()
// 'closed' 정리 리스너를 붙여 둔 창들 — 창이 죽으면 그 창의 항목도 죽는다
const watched = new Set<number>()
let toastWin: BrowserWindow | null = null
let toastLoaded = false

function entriesNewestFirst(): NotifyEntry[] {
  // Map은 삽입 순서 — 업서트가 delete+set으로 끝에 다시 넣으므로 뒤가 최신이다
  return [...pending.values()].reverse().map(({ winId: _w, ...e }) => e)
}

function destroyToast(): void {
  const w = toastWin
  toastWin = null
  toastLoaded = false
  if (w && !w.isDestroyed()) w.destroy()
}

function ensureToast(): void {
  if (toastWin && !toastWin.isDestroyed()) return
  toastLoaded = false
  const win = new BrowserWindow({
    width: TOAST_W,
    height: 120,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    // 포커스 불가 — 게임/작업 중에 떠도 입력을 한 순간도 뺏지 않는다 (클릭은 받는다)
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // 불투명 검정 카드 — 유리(아크릴)보다 가독성이 좋다는 사용자 결정. 페이지 배경과
    // 같은 색을 창에도 깔아 로드 직전 프레임의 흰 번쩍임을 막는다.
    backgroundColor: '#151515',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false
    }
  })
  // 일반 alwaysOnTop 위로 — 전체화면 독점 모드 게임 위에는 어차피 못 뜬다(알려진 한계)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.webContents.on('did-finish-load', () => {
    toastLoaded = true
    pushEntries()
  })
  win.on('closed', () => {
    if (toastWin === win) {
      toastWin = null
      toastLoaded = false
    }
  })
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) win.loadURL(devUrl + '/toast.html')
  else win.loadFile(path.join(__dirname, '../renderer/toast.html'))
  toastWin = win
}

// 표시 목록을 토스트 페이지로 밀어넣는다(REPLACE). 페이지가 렌더 후 notifyResize로
// 콘텐츠 높이를 보고하면 그때 크기·위치를 확정하고 보여준다 — 첫 표시에 깜빡임이 없다.
function pushEntries(): void {
  if (pending.size === 0) {
    destroyToast()
    return
  }
  ensureToast()
  if (toastLoaded && toastWin && !toastWin.isDestroyed()) {
    toastWin.webContents.send(IPC.notifyShow, entriesNewestFirst())
  }
}

function clearFor(winId: number): void {
  let dropped = false
  for (const [k, v] of pending) {
    if (v.winId === winId) {
      pending.delete(k)
      dropped = true
    }
  }
  if (dropped) pushEntries()
}

function watchWindow(win: BrowserWindow): void {
  if (watched.has(win.id)) return
  watched.add(win.id)
  win.on('closed', () => {
    watched.delete(win.id)
    clearFor(win.id)
  })
}

export function initNotifyToast(d: Deps): void {
  deps = d

  // 어느 창이든 포커스를 되찾으면 그 창 몫의 알림은 무의미 — 자동 소멸
  app.on('browser-window-focus', (_e, win) => clearFor(win.id))

  ipcMain.handle(IPC.notifyEvent, async (e, p: NotifyEventPayload) => {
    if (!deps || !deps.isEnabled()) return
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed() || win.isFocused()) return
    // 추가 채팅 창의 이벤트는 메인이 대상 채팅 id를 채운다 — 렌더러는 자기 id를 모른다
    const sessionId = deps.sessionChatIdFor(e.sender.id)
    const target: NotifyTarget = sessionId ? { surface: 'session', id: sessionId } : p.target
    const key = `${target.surface}:${target.id}${target.sub ? ':' + target.sub : ''}`
    watchWindow(win)
    pending.delete(key) // 재삽입으로 끝(최신)으로 보낸다
    pending.set(key, { ...p, target, key, winId: win.id })
    pushEntries()
  })

  // 토스트 페이지의 콘텐츠 높이 보고 — 커서가 있는 모니터의 작업 영역 우하단에 앉힌다.
  // 항목 갱신으로 이미 떠 있던 토스트도 커서 모니터를 다시 따른다("보는 화면" 규칙).
  ipcMain.handle(IPC.notifyResize, async (_e, height: number) => {
    if (!toastWin || toastWin.isDestroyed() || pending.size === 0) return
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    const h = Math.max(48, Math.min(Math.round(height), wa.height - TOAST_MARGIN * 2))
    toastWin.setBounds({
      x: wa.x + wa.width - TOAST_W - TOAST_MARGIN,
      y: wa.y + wa.height - h - TOAST_MARGIN,
      width: TOAST_W,
      height: h
    })
    if (!toastWin.isVisible()) toastWin.showInactive()
  })

  // 항목 클릭 — 해당 창을 있던 자리 그대로 앞으로(창을 옮기지 않는다) + 포커스,
  // 메인 창 대상이면 뷰 전환·선택까지 렌더러에 넘긴다(notifyJump)
  ipcMain.handle(IPC.notifyOpen, async (_e, key: string) => {
    const entry = pending.get(key)
    if (!entry || !deps) return
    clearFor(entry.winId) // 포커스 이벤트로도 지워지지만, 라우팅 실패에도 남지 않게 즉시
    if (entry.target.surface === 'session') {
      deps.focusSessionChat(entry.target.id)
      return
    }
    const main = deps.getMainWindow()
    if (!main || main.isDestroyed()) return
    if (main.isMinimized()) main.restore()
    main.show()
    main.focus()
    main.webContents.send(IPC.notifyJump, entry.target)
  })

  // ✕ — 전부 지우고 닫는다 (집계형에서도 ✕ 한 번이면 끝)
  ipcMain.handle(IPC.notifyClose, async () => {
    pending.clear()
    pushEntries()
  })
}
