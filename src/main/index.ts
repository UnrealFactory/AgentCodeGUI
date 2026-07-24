import { app, BrowserWindow, crashReporter, ipcMain, dialog, shell, session, screen, protocol, type WebContents } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { EngineRouter } from './engineRouter'
import { coalesceStream } from './streamCoalesce'
import { CodexEngine } from './codex/engine'
import * as engineVersions from './engine/versions'
import { readProfile, writeProfile } from './profile'
import { readUiPrefs, writeUiPrefs } from './uiPrefs'
import { apiConfigStatus, setApiKey, clearApiKey, setOpenaiApiKey, clearOpenaiApiKey, setBudget, resetBudget } from './apiConfig'
import { readApiUsage } from './apiUsage'
import { authLogin, authLogout, authLoginCancel, listAccounts, setDefaultAccount, removeAccount, accountsUsage, defaultAccountEmail, freshAccountToken, usageSlot, migrateAccounts } from './auth'
import { codexListAccounts, codexLogin, codexLogout, codexSetDefaultAccount, codexLoginCancel, codexAccountsUsage, migrateCodexAccounts } from './codex/auth'
import * as codexVersions from './codex/versions'
import { setVerseDocKo } from './lsp/verseDocKo'
import { setUeDocKo } from './lsp/ueDocKo'
import { bumpVerseRegistryRev } from './lsp/verseMemberDb'
import { readChats, writeChats } from './chats'
import { initNotifyToast } from './notifyToast'
import { writeFileAtomic } from './atomicWrite'
import { readMulti, writeMulti } from './maStore'
import { readTalk, writeTalk } from './talkStore'
import { readSessionChats, writeSessionChats, type SessionChatRecord } from './sessionChats'
import { listSkills, setSkillEnabled } from './skills'
import { listMcpServers, setMcpEnabled } from './mcp'
import { listProjectFiles, listDir } from './files'
import {
  gitStatus,
  gitLog,
  gitFileDiff,
  gitCommitDetail,
  gitCommitFileDiff,
  gitCommit,
  gitPush,
  gitPull,
  gitFetch,
  gitDiscard,
  gitBranches,
  gitSwitchBranch,
  gitCreateBranch,
  gitAiMessage
} from './git'
import { lspManager } from './lsp/manager'
import { initAutoUpdater, checkForUpdates, quitAndInstall, getUpdateStatus } from './updater'
import { IPC } from '@shared/protocol'
import { ATTACH_IMAGE_EXTS, ATTACH_TEXT_EXTS } from '@shared/attachments'
import type { EngineEvent, RunRequest, PermissionResponse, QuestionResponse, BgTaskRequest, UsageInfo, UsageWindow, FileReadResult, FileWriteResult, UserProfile, MultiRunRequest, MultiPermissionResponse, MultiQuestionResponse, LspPos, AgentStatus, SessionWindowInfo, SessionPersistPayload, SessionHydrateData, EngineUpdateItem, EngineUpdateStatus, ModelId, EffortId } from '@shared/protocol'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── dev 샌드박스 격리(CCG_HOME) ──────────────────────────────────────────────
// 설치본이 떠 있는 채로 dev를 시험할 때: APP_HOME(versions.ts)과 함께 userData도 통째로
// 옮겨야 완전히 분리된다 — userData가 설치본과 같으면 requestSingleInstanceLock이 실패해
// dev가 '로그 한 줄 없이' app.quit()으로 조용히 죽는다(그간의 미스터리 재현 원인). env
// USERPROFILE/APPDATA 오버라이드는 못 쓴다: 크래시패드 핸들러가 --database 없이 떠 자멸
// (exit 127)하거나 Electron이 env를 무시한다. crashReporter.start 전에 실행해야 크래시
// 덤프(userData/Crashpad)까지 샌드박스로 따라온다. 프로덕션(isPackaged)에선 무시.
if (!app.isPackaged && process.env.CCG_HOME) {
  app.setPath('userData', path.join(path.resolve(process.env.CCG_HOME), 'userData'))
}

// ── 최후 안전망: 크래시 진단 + 메인 프로세스 생존 ────────────────────────────
// crashReporter는 네이티브 크래시(V8 OOM abort 등)의 미니덤프를 로컬에 남긴다
// (업로드 없음 — app.getPath('crashDumps')에서 확인). app ready 전에 시작해야 한다.
crashReporter.start({ uploadToServer: false })
// uncaughtException의 기본 동작은 즉시 종료 — 대화 중이던 앱이 통째로 사라진다.
// 진단 로그(~/.agentcodegui/crash.log)를 남기고 계속 산다: 상태가 이상해질 수는
// 있지만, 사용자가 저장 안 된 작업을 잃고 원인도 모른 채 꺼지는 것보다는 낫다.
function logFatal(kind: string, err: unknown): void {
  try {
    const file = path.join(engineVersions.APP_HOME, 'crash.log')
    fs.mkdirSync(engineVersions.APP_HOME, { recursive: true })
    try {
      // 로그가 무한히 자라지 않게 1MB에서 새로 시작
      if (fs.statSync(file).size > 1024 * 1024) fs.unlinkSync(file)
    } catch {
      /* no log yet */
    }
    const detail = err instanceof Error ? err.stack ?? err.message : String(err)
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${kind}: ${detail}\n`)
  } catch {
    /* logging must never throw */
  }
}
process.on('uncaughtException', (err) => logFatal('uncaughtException', err))
process.on('unhandledRejection', (reason) => logFatal('unhandledRejection', reason))

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
  { scheme: 'ccg-img', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
  // HTML 미리보기(파일 뷰어) 문서·상대경로 리소스 서빙 — corsEnabled로 페이지 안의
  // fetch('./data.json')도 동작(응답에 ACAO:* — sandbox iframe은 opaque origin이라 필요)
  { scheme: 'ccg-page', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true } }
])

// ── HTML 미리보기 서빙(ccg-page://) ──────────────────────────────────────────
// 뷰어가 htmlPreviewUrl로 등록한 루트(프로젝트 폴더 또는 문서의 폴더) 아래만 서빙 —
// 임의 로컬 파일이 스킴으로 노출되지 않게 하는 범위 제한. 소문자·구분자 정규화 키.
const pageRoots = new Set<string>()
// 문서가 참조할 만한 텍스트/폰트/미디어 타입 — 이미지들은 IMG_EXTS를 그대로 재사용
const PAGE_MIME: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg'
}
// 미리보기 HTML 문서 끝에 덧붙이는 입력 브리지 — sandbox iframe이 포커스/호버를 가지면
// 부모(뷰어)가 keydown·우클릭 드래그를 못 받아 Ctrl+D(코드 전환)·Esc(닫기)·마우스 제스처가
// 죽는다. 그 입력만 postMessage로 부모에 중계한다(Ctrl+W는 main의 before-input 경로가
// 프레임 무관하게 이미 잡는다). 우클릭 포인터는 드래그 동안만 중계해 스팸이 없고, 획을
// 그렸으면 페이지 자체 contextmenu도 한 발 삼킨다(부모 제스처 레이어와 같은 관례).
// 부모→페이지 방향으론 스크롤 명령(ccgPageScroll)을 받아 ↑/↓ 제스처의 맨 위/아래를 맡는다.
// </html> 뒤에 붙어도 파서가 스크립트를 body로 옮겨 실행하므로 삽입 위치를 찾을 필요가 없다.
const PAGE_KEY_BRIDGE = `
<script>(function(){
var post=function(m){try{window.parent.postMessage(m,"*")}catch(_){}};
window.addEventListener("keydown",function(e){
if(e.ctrlKey||e.metaKey){if(e.altKey||e.shiftKey)return;
if(e.code!=="KeyD"&&(e.key||"").toLowerCase()!=="d")return;
e.preventDefault();post({ccgPageKey:"d"});}
else if(e.key==="Escape"){post({ccgPageKey:"escape"});}
},true);
var rd=false,drew=false,sx=0,sy=0;
var rel=function(t,e){post({ccgPagePtr:{t:t,x:e.clientX,y:e.clientY}})};
window.addEventListener("pointerdown",function(e){
if(e.button!==2||e.pointerType!=="mouse")return;
rd=true;drew=false;sx=e.clientX;sy=e.clientY;rel("pd",e);
},true);
window.addEventListener("pointermove",function(e){
if(!rd)return;
if(!(e.buttons&2)){rd=false;rel("pc",e);return;}
if(Math.hypot(e.clientX-sx,e.clientY-sy)>14)drew=true;
rel("pm",e);
},true);
window.addEventListener("pointerup",function(e){
if(e.button!==2||!rd)return;rd=false;rel("pu",e);
},true);
window.addEventListener("pointercancel",function(e){
if(rd){rd=false;rel("pc",e);}
},true);
window.addEventListener("contextmenu",function(e){
if(drew){drew=false;e.preventDefault();e.stopImmediatePropagation();}
},true);
window.addEventListener("message",function(e){
var s=e.data&&e.data.ccgPageScroll;
if(s)window.scrollTo({top:s==="top"?0:document.documentElement.scrollHeight,behavior:"smooth"});
});
})()</script>
`

// pathless 첨부(붙여넣기/브라우저 드래그) 저장 시 허용되는 확장자 — 이미지 + 텍스트
const ATTACH_SAVE_EXTS = new Set([...ATTACH_IMAGE_EXTS, ...ATTACH_TEXT_EXTS].map((e) => '.' + e))

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
    background:#151515;border-radius:18px;
    box-shadow:0 24px 64px -22px rgba(0,0,0,.8),0 0 0 1px rgba(255,255,255,.10)}
  .logo{width:56px;height:56px;border-radius:16px;background:#e9e9e9;display:grid;place-items:center;
    color:#161616;font-weight:800;font-size:27px;font-family:'JetBrains Mono',ui-monospace,monospace}
  .name{margin-top:16px;font-size:14px;font-weight:600;color:rgba(255,255,255,.90);letter-spacing:-.01em}
  .spin{margin-top:18px;width:20px;height:20px;border-radius:50%;
    border:2.5px solid rgba(255,255,255,.14);border-top-color:rgba(255,255,255,.62);animation:s .7s linear infinite}
  .sub{margin-top:12px;font-size:11.5px;color:rgba(255,255,255,.40)}
  @keyframes s{to{transform:rotate(360deg)}}
</style></head>
<body><div class="card">
  <div class="logo"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="8" width="13" height="10" rx="4.5"/><circle cx="10.2" cy="13" r=".95" fill="currentColor" stroke="none"/><circle cx="13.8" cy="13" r=".95" fill="currentColor" stroke="none"/><path d="M9.5 8Q9 5.8 7.3 4.9"/><circle cx="7" cy="4.7" r=".85" fill="currentColor" stroke="none"/><path d="M14.5 8Q15 5.8 16.7 4.9"/><circle cx="17" cy="4.7" r=".85" fill="currentColor" stroke="none"/><path d="M4.4 10.6C3 11.5 3 14.5 4.4 15.4"/><path d="M19.6 10.6C21 11.5 21 14.5 19.6 15.4"/></svg></div>
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

// 2.0 아크릴 창: 불투명(재질) 창이라 네이티브 최대화·Aero Snap·가장자리 리사이즈가
// 전부 살아 있다 — 투명 창 시절의 커스텀 최대화/스냅/드래그/리사이즈 배관은 제거됐다.
let saveTimer: ReturnType<typeof setTimeout> | null = null
function saveWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const maximized = mainWindow.isMaximized()
  const b = mainWindow.getNormalBounds() // 최대화 중에도 창 모드 크기를 기억
  const state: WinState = { x: b.x, y: b.y, width: b.width, height: b.height, maximized }
  try {
    fs.mkdirSync(engineVersions.APP_HOME, { recursive: true })
    writeFileAtomic(stateFile(), JSON.stringify(state))
  } catch {
    /* ignore */
  }
}
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(saveWindowState, 400)
}

// 2.0: 채널마다 EngineRouter — RunRequest.engine(claude/codex)에 따라
// Claude Code CLI 또는 Codex CLI(app-server)로 라우팅된다.
const engine = new EngineRouter(coalesceStream((event: EngineEvent) => send(IPC.engineEvent, event)), 'chat')

// The 채팅(pure conversation) workspace runs on its own dedicated engine — separate from
// the main chat (`engine`) — so its events never mix into it.
// It has no project folder; the engine falls back to the Desktop folder for an empty cwd.
const talkEngine = new EngineRouter(coalesceStream((event: EngineEvent) => send(IPC.talkEvent, event)), 'talk')

// ── multi-agent engine pool ─────────────────────────────────
// One engine per on-screen panel, created on demand and addressed by panelId.
// Each owns its own CLI subprocess, so N panels genuinely run in parallel; every event
// is tagged with the panelId on the shared maEvent channel for the renderer to route.
const maEngines = new Map<string, EngineRouter>()
function maEngine(panelId: string): EngineRouter {
  let eng = maEngines.get(panelId)
  if (!eng) {
    eng = new EngineRouter(coalesceStream((event: EngineEvent) => send(IPC.maEvent, { panelId, event })), 'ma')
    maEngines.set(panelId, eng)
  }
  return eng
}

// picker의 OpenAI 모델 목록 — 실행과 무관하게 조회만 하는 공용 Codex 인스턴스
let codexList: CodexEngine | null = null
async function codexModels(): Promise<import('@shared/protocol').CodexModelInfo[]> {
  if (!codexList) codexList = new CodexEngine(() => {})
  return codexList.listModels()
}

// ── session windows ("추가 세션") ───────────────────────────
// Each session window is an INDEPENDENT OS window with its OWN engine; events route only
// to that window's webContents (never the shared mainWindow send()). Keyed by
// webContents.id so any number of session windows stay fully isolated from each other and
// from the main window. Purely additive — the main window's channels/chrome are untouched.
const sessionEngines = new Map<number, EngineRouter>()
function sessionEngineFor(wc: WebContents): EngineRouter {
  let eng = sessionEngines.get(wc.id)
  if (!eng) {
    eng = new EngineRouter(
      coalesceStream((event: EngineEvent) => {
        if (!wc.isDestroyed()) wc.send(IPC.sessionEvent, event)
      }),
      'chat'
    )
    sessionEngines.set(wc.id, eng)
  }
  return eng
}

// 추가 채팅 영속 레지스트리 — 대화(스냅샷·제목·폴더)는 채팅 id 기준으로 디스크에 남고
// (메인 채팅처럼 재시작 후에도 사이드바에 유지), 창은 그 채팅을 "열어 보는" 뷰일 뿐이다.
// 닫기 = 저장 후 창 정리(대화는 목록에 남음), 사이드바 X = 대화 삭제.
const sessionChats = new Map<string, SessionChatRecord>()
for (const r of readSessionChats()) sessionChats.set(r.id, r)
function persistSessionChats(): void {
  writeSessionChats([...sessionChats.values()])
}

// 열린 세션 창 — webContents id → { 창, 채팅 id, 라이브 상태 }. 제목·상태는 그 창의
// 렌더러가 sessionReport로 보고하고, 변화가 있을 때마다 메인 창으로 목록을 흘린다.
// kill: 사이드바 X(대화 삭제)의 진짜 닫기 표식 — 닫기=저장 후 정리 흐름을 건너뛴다.
// flushing/flushTimer: 닫기 시 마지막 스냅샷을 받아낸 뒤 destroy하는 중간 상태.
const sessionWins = new Map<
  number,
  { win: BrowserWindow; chatId: string; status: AgentStatus; kill?: boolean; flushing?: boolean; flushTimer?: NodeJS.Timeout }
>()
// 앱 종료 중 표식 — 종료가 시작되면 세션 창의 닫기 가로채기를 멈춰 quit이 안 막히게
let appQuitting = false

// ── 엔진 부팅 자동 업데이트 스냅샷 ───────────────────────────
// 부팅 게이트(runBootEngineUpdate)가 채우고, 변화마다 렌더러로 통째로 흘린다.
// 렌더러 카드는 마운트 때 engineUpdateStatus로 따라잡는다(이벤트 경합 무해).
let engUpdate: EngineUpdateStatus = { active: false, items: [], cleanup: 'pending', freedBytes: 0, done: false }
function pushEngUpdate(): void {
  send(IPC.engineUpdateEvent, engUpdate)
}
function sessionWinList(): SessionWindowInfo[] {
  const live = new Map<string, AgentStatus>()
  for (const [, s] of sessionWins) if (!s.win.isDestroyed()) live.set(s.chatId, s.status)
  return [...sessionChats.values()].map((r) => ({
    id: r.id,
    title: r.title,
    status: live.get(r.id) ?? (r.status === 'done' || r.status === 'error' ? r.status : 'idle'),
    open: live.has(r.id),
    updatedAt: r.updatedAt
  }))
}
function broadcastSessionWins(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.sessionWindowsChanged, sessionWinList())
}

// 숨긴 창의 마지막 스냅샷을 받아낸 뒤 창을 정리한다 — 렌더러에 flush를 요청하고, persist가
// 도착하면(또는 1.5초 타임아웃) destroy. 그 사이 사용자가 사이드바로 창을 되살렸으면
// (visible) 정리를 취소해 대화가 계속 그 창에서 이어지게 한다.
function finishFlush(wcId: number): void {
  const s = sessionWins.get(wcId)
  if (!s) return
  if (s.flushTimer) {
    clearTimeout(s.flushTimer)
    s.flushTimer = undefined
  }
  if (!s.flushing) return
  s.flushing = false
  if (s.win.isDestroyed() || s.win.isVisible()) return
  s.win.destroy()
}
function flushAndDestroy(wcId: number): void {
  const s = sessionWins.get(wcId)
  if (!s || s.win.isDestroyed() || s.flushing) return
  s.flushing = true
  s.win.webContents.send(IPC.sessionFlushRequest, null)
  s.flushTimer = setTimeout(() => finishFlush(wcId), 1500)
}

// 비활성 창에서 DWM이 아크릴을 끄고 불투명 회색 폴백을 그리는 것을 되돌린다 — blur 때
// 재질을 다시 적용하면 비활성 상태로도 유리가 유지된다. 50ms 지연은 DWM의 비활성 전환이
// 끝난 뒤에 재적용이 얹히도록 하는 간격(실측: 흰 배경·글래스100에서 사이드바 81→51로
// 꺼지던 것이 81 유지, 전환 순간 딥은 1프레임 3/255뿐). 재질 미지원(Win10)은 원래 no-op.
function keepAcrylicWhenBlurred(win: BrowserWindow): void {
  win.on('blur', () => {
    setTimeout(() => {
      if (!win.isDestroyed()) win.setBackgroundMaterial('acrylic')
    }, 50)
  })
}

function createSessionWindow(chatId?: string): void {
  // 새 창 = 새 채팅 레코드. 빈 채팅은 디스크에 쓰이지 않으므로(writeSessionChats가 거름)
  // 열었다 그냥 닫으면 흔적이 남지 않고, 닫힌 채팅을 다시 열면 기존 레코드에 창만 붙는다.
  let rec = chatId ? sessionChats.get(chatId) : undefined
  if (!rec) {
    rec = { id: randomUUID(), title: '', status: 'idle', cwd: '', snapshot: null }
    sessionChats.set(rec.id, rec)
  }
  const recId = rec.id
  const win = new BrowserWindow({
    width: 560,
    height: 720,
    minWidth: 360,
    minHeight: 440,
    show: false,
    // 메인 창과 같은 아크릴 껍데기 — 프레임리스여도 thickFrame으로 OS 리사이즈·스냅이 산다.
    // backgroundColor 금지 — 불투명 층이 아크릴을 막는다 (메인 창과 동일 규칙)
    frame: false,
    backgroundMaterial: 'acrylic',
    // hide the default "File Edit View Window" menu bar too; Alt still reveals it so the
    // standard edit accelerators (copy/paste/…) stay intact.
    autoHideMenuBar: true,
    title: '추가 채팅 — AgentCodeGUI',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false
    }
  })
  const wcId = win.webContents.id
  keepAcrylicWhenBlurred(win)

  win.once('ready-to-show', () => win.show())

  // never navigate the app away; open external links in the OS browser (mirrors mainWindow)
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const { protocol: p } = new URL(url)
      if (p === 'https:' || p === 'http:') shell.openExternal(url)
    } catch {
      /* malformed URL — ignore */
    }
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const dev = process.env['ELECTRON_RENDERER_URL']
    const allowed = (dev && url.startsWith(dev)) || url.startsWith('file:')
    if (!allowed) event.preventDefault()
  })

  // our custom title bar reflects maximize state via winState — send it to THIS window
  // (session windows use native maximize, not the main window's custom scheme)
  win.on('maximize', () => win.webContents.send(IPC.winState, { maximized: true }))
  win.on('unmaximize', () => win.webContents.send(IPC.winState, { maximized: false }))

  // 닫기(X·Alt+F4·↓→ 제스처) = 저장 후 창 정리 — 대화는 사이드바 '추가 채팅'에 남고,
  // 항목을 누르면 창을 다시 만들어 이어간다. 실행 중이면 창만 숨겨 턴을 끝까지 돌리고
  // (백그라운드 계속 실행), 끝나는 시점(sessionReport)에 마지막 스냅샷을 받아 정리한다.
  // 진짜 종료는 사이드바 X(kill = 대화 삭제)와 앱 종료뿐. 메인 창이 없으면 사이드바도
  // 없어 대화를 되찾을 길이 없으니 이 흐름 없이 그냥 닫는다.
  win.on('close', (e) => {
    const s = sessionWins.get(wcId)
    if (appQuitting || s?.kill || !mainWindow || mainWindow.isDestroyed()) return
    e.preventDefault()
    win.hide()
    const busy = s && (s.status === 'analyzing' || s.status === 'working')
    if (!busy) flushAndDestroy(wcId)
  })

  // release this window's engines (and their CLI subprocesses) when it closes
  win.on('closed', () => {
    const eng = sessionEngines.get(wcId)
    if (eng) {
      eng.cancel().catch(() => {})
      sessionEngines.delete(wcId)
    }
    const s = sessionWins.get(wcId)
    if (s?.flushTimer) clearTimeout(s.flushTimer)
    // 빈 대화(첫 메시지 전)는 목록에 남길 이유가 없다 — 창이 사라질 때 항목째 정리
    const rec = s ? sessionChats.get(s.chatId) : undefined
    if (rec && (rec.empty || rec.snapshot == null)) {
      sessionChats.delete(rec.id)
      persistSessionChats()
    }
    sessionWins.delete(wcId)
    broadcastSessionWins()
  })

  sessionWins.set(wcId, { win, chatId: recId, status: 'idle' })
  broadcastSessionWins()

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    win.loadURL(devUrl + '#session')
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'session' })
  }
}

// 추가 채팅으로 이동 — 열려 있으면 그 창을 있던 자리 그대로 앞으로, 닫힌 채팅이면 창을
// 다시 만든다(렌더러가 sessionHydrate로 저장본 복원). 사이드바 클릭과 알림 토스트
// 클릭이 같은 경로를 쓴다.
function focusSessionChat(id: string): void {
  for (const s of sessionWins.values()) {
    if (s.chatId !== id || s.win.isDestroyed()) continue
    // 닫기(저장 후 정리)가 진행 중이었다면 취소 — 사용자가 대화를 도로 열었다
    if (s.flushTimer) {
      clearTimeout(s.flushTimer)
      s.flushTimer = undefined
    }
    s.flushing = false
    if (!s.win.isVisible()) s.win.show()
    if (s.win.isMinimized()) s.win.restore()
    s.win.focus()
    return
  }
  if (sessionChats.has(id)) createSessionWindow(id)
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
    // 창 자체가 카드 — DWM 아크릴 재질(transparent와 병용 불가). 라운드·그림자·
    // 네이티브 스냅/최대화/리사이즈가 OS에서 그대로 온다. 비활성 시 재질이 꺼지는
    // 것은 keepAcrylicWhenBlurred로 되살린다(blur 시 재적용 — 실측 검증).
    // backgroundColor는 절대 깔지 않는다 — 불투명 층이 재질과 웹 콘텐츠 사이를 막아
    // 유리가 완전히 죽는다(실측). 재질 미지원(Win10)은 DWM이 알아서 불투명 폴백.
    backgroundMaterial: 'acrylic',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      // sandbox must be false to load the ESM (.mjs) preload. The preload only uses
      // contextBridge/ipcRenderer, so the surface is minimal; harden to sandbox:true
      // (which requires a CommonJS preload) before any non-local distribution. [M2+]
      sandbox: false
    }
  })

  if (state.maximized) mainWindow.maximize()
  keepAcrylicWhenBlurred(mainWindow)

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    closeSplash()
  })
  // 네이티브 최대화 — 커스텀 타이틀바 아이콘이 상태를 따라가게만 알린다
  mainWindow.on('maximize', () => {
    send(IPC.winState, { maximized: true })
    scheduleSave()
  })
  mainWindow.on('unmaximize', () => {
    send(IPC.winState, { maximized: false })
    scheduleSave()
  })
  mainWindow.on('resize', scheduleSave)
  mainWindow.on('move', scheduleSave)
  mainWindow.on('close', saveWindowState)
  // 숨은 추가 채팅 창(닫기 정리 대기 또는 백그라운드 턴 실행 중)은 메인 창이 죽으면 함께
  // 정리해 보이지 않는 창이 window-all-closed(앱 종료)를 막는 일을 없앤다. 대화는 마지막
  // 저장본으로 디스크에 남는다. 보이는(또는 최소화된) 세션 창은 지금처럼 독립 생존하고,
  // 이후의 닫기는 mainWindow=null이라 진짜 닫힘.
  mainWindow.on('closed', () => {
    mainWindow = null
    for (const [, s] of sessionWins) {
      if (!s.win.isDestroyed() && !s.win.isVisible()) s.win.destroy()
    }
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
// 캐시는 계정별(키=계정 이메일, ''=전역) + 엔트리에 조회 토큰을 함께 저장 — 토큰이
// 달라지면(설정 → Account 전환 = 크리덴셜 스왑) TTL이 남았어도 캐시 미스로 떨어져,
// 전환 직후 이전 계정 수치가 최대 5분 남던 문제가 구조적으로 사라진다.
const usageCache = new Map<string, { at: number; token: string; data: UsageInfo }>()
// 같은 키의 동시 조회 합치기 — 마운트/설정 닫기/실행 종료가 겹쳐도 API는 한 번만 맞는다
const usageInflight = new Map<string, Promise<UsageInfo>>()
const USAGE_TTL = 5 * 60 * 1000
// 강제 새로고침(fresh)의 바닥 TTL — 추가 크레딧 잔액은 실행마다 실제 돈이 줄어드는
// 값이라 5분 캐시는 너무 낡는다. 실행 종료·팝오버 열기 순간엔 새로 받되, 연타가
// API를 때리지 않게 15초는 재사용한다.
const USAGE_TTL_FRESH = 15 * 1000

// 조회에 쓸 토큰 — account(채팅별 실행 계정), 미지정이면 기본 계정. 컨텍스트 팝오버의
// 한도는 "이 채팅이 실제로 소비할 계정" 기준이어야 하기 때문. 등록 계정 스토어만 보고,
// 만료된 토큰은 리프레시해서라도 돌려준다(오래 안 쓴 계정도 한도가 뜨게).
async function usageTokenFor(account?: string): Promise<{ token: string; key: string } | null> {
  const email = account ?? defaultAccountEmail()
  if (!email) return null
  const token = await freshAccountToken(email)
  return token ? { token, key: email } : null
}

async function getUsage(fresh = false, account?: string): Promise<UsageInfo> {
  const empty: UsageInfo = { fiveHour: null, weekly: null, weeklyFable: null, extraCredit: null }
  const tk = await usageTokenFor(account)
  if (!tk) return empty
  const hit = usageCache.get(tk.key)
  if (hit && hit.token === tk.token && Date.now() - hit.at < (fresh ? USAGE_TTL_FRESH : USAGE_TTL)) return hit.data
  const inflight = usageInflight.get(tk.key)
  if (inflight) return inflight
  // usage API는 세게 레이트리밋됨(429) — 계정별 한도 조회와 같은 전역 큐로 직렬화
  const req = usageSlot(() => fetchUsage(tk.token, tk.key)).finally(() => usageInflight.delete(tk.key))
  usageInflight.set(tk.key, req)
  return req
}

async function fetchUsage(token: string, cacheKey: string): Promise<UsageInfo> {
  const empty: UsageInfo = { fiveHour: null, weekly: null, weeklyFable: null, extraCredit: null }
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 5000)
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: ctrl.signal
    })
    clearTimeout(timer)
    // 실패(429 등)는 마지막 성공값으로 폴백 — TTL이 지난 캐시라도 빈 화면보다 낫다
    if (!res.ok) return usageCache.get(cacheKey)?.data ?? empty
    const j = (await res.json()) as Record<string, { utilization?: number | string; resets_at?: string }> & {
      // 모델별 한도는 legacy 필드(seven_day_opus 등)가 아니라 limits[] 배열로 온다.
      limits?: { kind?: string; percent?: number; resets_at?: string; scope?: { model?: { display_name?: string } | null } | null }[]
      // 추가 사용 크레딧 (claude.ai 설정 → 사용 크레딧과 같은 데이터).
      // 금액 필드는 {amount_minor, currency, exponent} 또는 {money, credits} 래퍼 —
      // 실측에서 두 형태가 다 관찰돼 필드별 타입은 unknown으로 두고 관대하게 파싱한다.
      spend?: {
        enabled?: boolean
        disabled_reason?: string | null
        percent?: number | null
        used?: unknown
        cap?: unknown
        limit?: unknown
        balance?: unknown
      } | null
    }
    const toTs = (s?: string): number | null => {
      if (!s) return null
      const ms = Date.parse(s)
      return isNaN(ms) ? null : Math.floor(ms / 1000)
    }
    const win = (o?: { utilization?: number | string; resets_at?: string }): UsageWindow | null =>
      o ? { pct: Math.max(0, Math.min(100, Math.round(parseFloat(String(o.utilization ?? 0)) || 0))), resetsAt: toTs(o.resets_at) } : null
    // Fable 5 주간 한도: limits[]에서 weekly_scoped + model 이름에 'fable'이 들어간 항목
    const fable = Array.isArray(j.limits)
      ? j.limits.find((l) => l?.kind === 'weekly_scoped' && (l.scope?.model?.display_name ?? '').toLowerCase().includes('fable'))
      : undefined
    // 금액 파서 — 숫자 그대로, {amount_minor, exponent}, {money, credits} 래퍼를 모두 수용
    const money = (m: unknown): number | null => {
      if (m == null) return null
      if (typeof m === 'number') return m
      if (typeof m !== 'object') return null
      const o = m as { amount_minor?: unknown; exponent?: unknown; money?: unknown; credits?: unknown }
      if (typeof o.amount_minor === 'number')
        return o.amount_minor / Math.pow(10, typeof o.exponent === 'number' ? o.exponent : 2)
      return money(o.money) ?? money(o.credits)
    }
    const sp = j.spend
    // 토글은 켰지만 잔액 소진 → API가 enabled:false + out_of_credits로 내려준다
    const outOfCredits = sp?.disabled_reason === 'out_of_credits'
    const data: UsageInfo = {
      fiveHour: win(j.five_hour),
      weekly: win(j.seven_day),
      weeklyFable: fable ? { pct: Math.max(0, Math.min(100, Math.round(fable.percent ?? 0))), resetsAt: toTs(fable.resets_at) } : null,
      extraCredit: sp
        ? {
            enabled: !!sp.enabled,
            outOfCredits,
            currency: ((sp.used as { currency?: string } | null)?.currency || 'USD') as string,
            used: money(sp.used),
            cap: money(sp.cap) ?? money(sp.limit),
            balance: money(sp.balance) ?? (outOfCredits ? 0 : null),
            pct: typeof sp.percent === 'number' ? Math.max(0, Math.min(100, Math.round(sp.percent))) : null
          }
        : null
    }
    usageCache.set(cacheKey, { at: Date.now(), token, data })
    return data
  } catch {
    return usageCache.get(cacheKey)?.data ?? empty
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.runStart, async (_e, req: RunRequest) => engine.run(req))
  ipcMain.handle(IPC.runCancel, async () => {
    await engine.cancel()
  })
  ipcMain.handle(IPC.permissionRespond, async (_e, res: PermissionResponse) => engine.respondPermission(res))
  ipcMain.handle(IPC.questionRespond, async (_e, res: QuestionResponse) => engine.respondQuestion(res))
  ipcMain.handle(IPC.bgTask, async (_e, req: BgTaskRequest) => engine.bgTask(req))

  // 채팅 — the pure-conversation workspace, driven by its own engine instance
  ipcMain.handle(IPC.talkRun, async (_e, req: RunRequest) => talkEngine.run(req))
  ipcMain.handle(IPC.talkCancel, async () => {
    await talkEngine.cancel()
  })
  ipcMain.handle(IPC.talkPermissionRespond, async (_e, res: PermissionResponse) => talkEngine.respondPermission(res))
  ipcMain.handle(IPC.talkQuestionRespond, async (_e, res: QuestionResponse) => talkEngine.respondQuestion(res))
  ipcMain.handle(IPC.talkBgTask, async (_e, req: BgTaskRequest) => talkEngine.bgTask(req))
  ipcMain.handle(IPC.talkGet, async () => readTalk())
  ipcMain.handle(IPC.talkSave, async (_e, data: unknown) => writeTalk(data))

  // 세션 창 — open a new independent window; run/cancel/respond resolve to the CALLING
  // window's own engine (via _e.sender), so each window's conversation stays isolated.
  ipcMain.handle(IPC.openSessionWindow, async () => {
    createSessionWindow()
  })
  ipcMain.handle(IPC.sessionRun, async (_e, req: RunRequest) => sessionEngineFor(_e.sender).run(req))
  ipcMain.handle(IPC.sessionCancel, async (_e) => {
    await sessionEngines.get(_e.sender.id)?.cancel()
  })
  ipcMain.handle(IPC.sessionPermissionRespond, async (_e, res: PermissionResponse) =>
    sessionEngines.get(_e.sender.id)?.respondPermission(res)
  )
  ipcMain.handle(IPC.sessionQuestionRespond, async (_e, res: QuestionResponse) =>
    sessionEngines.get(_e.sender.id)?.respondQuestion(res)
  )
  ipcMain.handle(IPC.sessionBgTask, async (_e, req: BgTaskRequest) => sessionEngines.get(_e.sender.id)?.bgTask(req))
  // 추가 채팅 레지스트리 — 목록 조회/포커스/삭제/이름 변경(메인 창), 제목·상태 보고와
  // 대화 저장·복원(세션 창 자신). 대화는 채팅 id 기준 영속 — 창은 열어 보는 뷰다.
  ipcMain.handle(IPC.sessionWindowsList, async () => sessionWinList())
  ipcMain.handle(IPC.sessionWindowFocus, async (_e, id: string) => focusSessionChat(id))
  ipcMain.handle(IPC.sessionWindowClose, async (_e, id: string) => {
    // 사이드바 X = 대화 삭제 — 열린 창이 있으면 저장 없이 그 창도 닫는다
    for (const [, s] of sessionWins) {
      if (s.chatId === id && !s.win.isDestroyed()) {
        s.kill = true // 닫기=저장 후 정리 가로채기를 통과시키는 진짜 닫기 표식
        s.win.close()
      }
    }
    if (sessionChats.delete(id)) persistSessionChats()
    broadcastSessionWins()
  })
  ipcMain.handle(IPC.sessionWindowRename, async (_e, id: string, title: string) => {
    const rec = sessionChats.get(id)
    if (!rec || !title.trim()) return
    rec.title = title.trim()
    rec.custom = true
    persistSessionChats()
    broadcastSessionWins()
  })
  ipcMain.handle(IPC.sessionReport, async (_e, info: { title: string; status: AgentStatus }) => {
    const s = sessionWins.get(_e.sender.id)
    if (!s) return
    s.status = info.status
    const rec = sessionChats.get(s.chatId)
    if (rec && !rec.custom) rec.title = info.title
    // 닫기(숨김)로 백그라운드에서 돌던 턴이 끝났다 — 마지막 스냅샷을 받아 창을 정리한다
    const busy = info.status === 'analyzing' || info.status === 'working'
    if (!busy && !s.kill && !s.win.isDestroyed() && !s.win.isVisible()) flushAndDestroy(_e.sender.id)
    broadcastSessionWins()
  })
  ipcMain.handle(IPC.sessionHydrate, async (_e): Promise<SessionHydrateData | null> => {
    const s = sessionWins.get(_e.sender.id)
    const rec = s ? sessionChats.get(s.chatId) : undefined
    if (!rec || rec.snapshot == null) return null
    return { snapshot: rec.snapshot, cwd: rec.cwd, picker: rec.picker, draft: rec.draft, draftImages: rec.draftImages }
  })
  ipcMain.handle(IPC.sessionPersist, async (_e, p: SessionPersistPayload) => {
    const s = sessionWins.get(_e.sender.id)
    const rec = s ? sessionChats.get(s.chatId) : undefined
    if (!s || !rec) return
    if (!rec.custom) rec.title = p.title
    // 실행 중 스냅샷은 idle로 얼려 저장한다 — 재시작 복원이 "실행 중"으로 거짓말하지 않게
    rec.status = p.status === 'done' || p.status === 'error' ? p.status : 'idle'
    rec.cwd = p.cwd
    rec.snapshot = p.snapshot
    rec.picker = p.picker
    rec.draft = p.draft
    rec.draftImages = p.draftImages
    rec.empty = p.empty
    if (p.updatedAt != null) rec.updatedAt = p.updatedAt
    persistSessionChats()
    if (s.flushing) finishFlush(_e.sender.id) // 닫기 대기 중이던 창 — 저장이 끝났으니 정리
    broadcastSessionWins()
  })

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
  // 패널 WorkBar의 백그라운드 셸 컨트롤(중지/Ctrl+B) — 그 패널의 엔진으로 (없으면 no-op)
  ipcMain.handle(IPC.maBgTask, async (_e, panelId: string, req: BgTaskRequest) =>
    maEngines.get(panelId)?.bgTask(req)
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

  ipcMain.handle(IPC.pickDirectory, async (_e) => {
    // parent the picker to the window that asked (so a 추가 채팅 창의 다이얼로그가 그 창 위에 뜬다);
    // fall back to the main window if the sender's window is gone
    const owner = BrowserWindow.fromWebContents(_e.sender) ?? mainWindow
    if (!owner) return null
    const r = await dialog.showOpenDialog(owner, {
      properties: ['openDirectory'],
      title: '작업할 프로젝트 폴더 선택'
    })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })
  ipcMain.handle(IPC.dirExists, async (_e, dir: string) => {
    if (!dir || !dir.trim()) return false
    try {
      return fs.statSync(dir).isDirectory()
    } catch {
      return false
    }
  })
  ipcMain.handle(IPC.pickAttachments, async () => {
    if (!mainWindow) return []
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      title: '첨부할 파일 선택',
      filters: [
        { name: '첨부 가능한 파일', extensions: [...ATTACH_IMAGE_EXTS, ...ATTACH_TEXT_EXTS] },
        { name: '이미지', extensions: [...ATTACH_IMAGE_EXTS] },
        { name: '텍스트·문서', extensions: [...ATTACH_TEXT_EXTS] }
      ]
    })
    return r.canceled ? [] : r.filePaths
  })
  // a pasted screenshot or a file dragged from a browser has no file path — its raw
  // bytes are written to the app's attachments folder so it gets a path to show + attach
  ipcMain.handle(IPC.saveAttachmentData, async (_e, a: { bytes: ArrayBuffer; ext: string }): Promise<string> => {
    const ext = ('.' + String(a.ext || 'png').replace(/^\.+/, '').toLowerCase()).replace(/[^.a-z0-9]/g, '')
    const safeExt = ATTACH_SAVE_EXTS.has(ext) ? ext : '.png'
    const abs = path.join(attachmentsDir(), `paste-${randomUUID()}${safeExt}`)
    await fs.promises.writeFile(abs, Buffer.from(a.bytes))
    return abs
  })
  ipcMain.handle(IPC.getUsage, async (_e, fresh?: boolean, account?: string) => getUsage(!!fresh, account))

  // 클로드 계정(구독) — 앱 등록 계정만, 전역 ~/.claude 불가침 (설정 → Account)
  ipcMain.handle(IPC.authLogout, async (_e, email: string) => authLogout(email))
  ipcMain.handle(IPC.authLogin, async (_e, useConsole?: boolean) => authLogin(_e.sender, !!useConsole))
  ipcMain.handle(IPC.authLoginCancel, async () => authLoginCancel())
  ipcMain.handle(IPC.authListAccounts, async () => listAccounts())
  ipcMain.handle(IPC.authSetDefaultAccount, async (_e, email: string) => setDefaultAccount(email))
  ipcMain.handle(IPC.authRemoveAccount, async (_e, email: string) => removeAccount(email))
  ipcMain.handle(IPC.authAccountsUsage, async () => accountsUsage())
  // Codex(OpenAI) 계정 — Anthropic과 동일한 문법 (앱 등록 계정만, 전역 ~/.codex 불가침)
  ipcMain.handle(IPC.codexListAccounts, async () => codexListAccounts())
  ipcMain.handle(IPC.codexLogin, async (_e) => codexLogin(_e.sender))
  ipcMain.handle(IPC.codexLogout, async (_e, email: string) => codexLogout(email))
  ipcMain.handle(IPC.codexSetDefaultAccount, async (_e, email: string) => codexSetDefaultAccount(email))
  ipcMain.handle(IPC.codexLoginCancel, async () => codexLoginCancel())
  ipcMain.handle(IPC.codexAccountsUsage, async () => codexAccountsUsage())
  // 두 엔진 CLI 공통 자동 업데이트 토글 — 인자 있으면 설정, 항상 현재 값을 반환
  ipcMain.handle(IPC.engineAutoUpdate, async (_e, enabled?: boolean) => {
    if (typeof enabled === 'boolean') engineVersions.setAutoUpdate(enabled)
    return engineVersions.getAutoUpdate()
  })
  // 부팅 자동 업데이트 진행 스냅샷 — 카드가 마운트 때 현재 상태를 따라잡는 용도
  ipcMain.handle(IPC.engineUpdateStatus, async () => engUpdate)

  // 세션 창(추가 채팅)의 과금 picker — 설정 모달은 메인 창에만 있어서, 키 없이 API를
  // 고르면 메인 창을 앞으로 가져와 설정 → API 탭을 대신 연다.
  ipcMain.handle(IPC.openApiSettings, async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    mainWindow.webContents.send(IPC.apiSettingsRequested)
  })

  // API 키 과금 설정 (설정 → API) — 키 원문은 절대 렌더러로 돌려주지 않는다.
  // provider 인자로 Anthropic(기본)·OpenAI 키가 같은 채널을 쓴다.
  ipcMain.handle(IPC.apiConfigGet, async () => apiConfigStatus())
  ipcMain.handle(IPC.apiConfigSetKey, async (_e, key: string, provider?: string) => {
    if (provider === 'openai') setOpenaiApiKey(String(key ?? ''))
    else setApiKey(String(key ?? ''))
    return apiConfigStatus()
  })
  ipcMain.handle(IPC.apiConfigClearKey, async (_e, provider?: string) => {
    if (provider === 'openai') clearOpenaiApiKey()
    else clearApiKey()
    return apiConfigStatus()
  })
  ipcMain.handle(IPC.apiConfigSetBudget, async (_e, usd: number | null) => {
    setBudget(typeof usd === 'number' ? usd : null)
    return apiConfigStatus()
  })
  ipcMain.handle(IPC.apiConfigResetBudget, async () => {
    resetBudget()
    return apiConfigStatus()
  })
  ipcMain.handle(IPC.apiUsageList, async () => readApiUsage())

  // local user profile (nickname + avatar color), stored in the app home folder
  ipcMain.handle(IPC.profileGet, async () => readProfile())
  ipcMain.handle(IPC.profileSave, async (_e, profile: UserProfile) => writeProfile(profile))

  // chat history, persisted so conversations continue after a restart
  ipcMain.handle(IPC.chatsGet, async () => readChats())
  ipcMain.handle(IPC.chatsSave, async (_e, data: unknown) => writeChats(data))

  // renderer UI prefs (viewer size/zoom, chat zoom, verse doc language), in the app home folder
  ipcMain.handle(IPC.uiPrefsGet, async () => readUiPrefs())
  // 유리 슬라이더(ui.glass)의 마지막 브로드캐스트 값 — prefs 블롭은 뷰어 줌 등 딴 변경에도
  // 통째로 저장되므로, 값이 실제로 바뀐 저장에만 전 창 브로드캐스트를 쏜다
  let lastGlass = readUiPrefs()['ui.glass']
  // 포커스 밖 알림 on/off — 저장 시점마다 캐시해 알림 이벤트가 파일을 읽지 않게 한다
  let notifyToastOn = readUiPrefs()['notify.toast'] !== false
  initNotifyToast({
    getMainWindow: () => mainWindow,
    focusSessionChat,
    sessionChatIdFor: (wcId) => sessionWins.get(wcId)?.chatId ?? null,
    isEnabled: () => notifyToastOn
  })
  ipcMain.handle(IPC.uiPrefsSave, async (_e, prefs: Record<string, unknown>) => {
    writeUiPrefs(prefs)
    notifyToastOn = prefs?.['notify.toast'] !== false
    // Verse hover docs in Korean unless '원문 보기'. 언어가 실제로 바뀌었으면 레지스트리 세대를
    // 올려, 렌더러가 든 registry.docs(fetch 시점 언어로 번역돼 박제됨)도 다음 열기에 새 언어로.
    if (setVerseDocKo(prefs?.verseDocLang !== 'en')) bumpVerseRegistryRev()
    // UE C++ 공식 주석 번역(clangd 호버) — 다음 호버부터 즉시 적용, 캐시 없음이라 세대 갱신 불필요
    setUeDocKo(prefs?.ueDocLang !== 'en')
    // 유리(벽지 비침) — 나란히 뜬 아크릴 창들의 비침이 어긋나면 바로 보이므로, 추가 채팅 창
    // 포함 전 창에 같은 값을 뿌린다 (수신 쪽은 prefs 캐시 patch만 — 재저장 레이스 없음)
    const g = prefs?.['ui.glass']
    if (typeof g === 'number' && g !== lastGlass) {
      lastGlass = g
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send(IPC.uiGlassChanged, g)
      }
    }
  })
  setVerseDocKo(readUiPrefs().verseDocLang !== 'en') // apply the saved choice at startup
  setUeDocKo(readUiPrefs().ueDocLang !== 'en')

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
  // Reveal (highlight) a file/folder in the OS file manager — explorer "파일 탐색기에서 보기"
  ipcMain.handle(IPC.shellRevealPath, async (_e, a: { cwd: string; relPath: string }) => {
    const abs = path.isAbsolute(a.relPath) ? a.relPath : path.join(a.cwd || '', a.relPath)
    shell.showItemInFolder(abs)
  })
  // 탐색기 파일 작업 뒤 LSP 통지 준비물 — 폴더 작업은 안의 '파일'들이 통지 대상이라(서버
  // 워처는 파일 글롭) 상한을 두고 열거한다. 상한 초과분은 놓치지만(드묾) 통지는 최선 노력.
  const walkFilesBounded = (dir: string, cap = 400): string[] => {
    const out: string[] = []
    const queue = [dir]
    while (queue.length && out.length < cap) {
      const d = queue.shift() as string
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(d, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) queue.push(p)
        else if (e.isFile()) {
          out.push(p)
          if (out.length >= cap) break
        }
      }
    }
    return out
  }
  // src→dest 이동/이름변경을 서버에는 삭제+생성 쌍으로 알린다(LSP엔 rename 이벤트가 없다)
  const notifyMoved = (src: string, dest: string): void => {
    const changes: { abs: string; kind: 'created' | 'changed' | 'deleted' }[] = []
    try {
      if (fs.statSync(dest).isDirectory()) {
        for (const f of walkFilesBounded(dest)) {
          changes.push({ abs: path.join(src, path.relative(dest, f)), kind: 'deleted' }, { abs: f, kind: 'created' })
        }
      } else {
        changes.push({ abs: src, kind: 'deleted' }, { abs: dest, kind: 'created' })
      }
    } catch {
      /* 통지는 최선 노력 — 실패해도 파일 작업 자체는 성공 */
    }
    lspManager.notifyWatchedFiles(changes)
  }
  // Rename a file/folder within its own parent dir. Rejects path separators / dup names.
  ipcMain.handle(
    IPC.fsRename,
    async (_e, a: { cwd: string; relPath: string; newName: string }): Promise<{ ok: boolean; error?: string }> => {
      try {
        const abs = path.isAbsolute(a.relPath) ? a.relPath : path.join(a.cwd || '', a.relPath)
        const name = (a.newName || '').trim()
        if (!name || /[\\/]/.test(name) || name === '.' || name === '..') return { ok: false, error: '올바른 이름이 아니에요' }
        const dest = path.join(path.dirname(abs), name)
        if (path.resolve(dest) === path.resolve(abs)) return { ok: true } // unchanged
        if (fs.existsSync(dest)) return { ok: false, error: '같은 이름이 이미 있어요' }
        await fs.promises.rename(abs, dest)
        notifyMoved(abs, dest)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: (e as Error)?.message || '이름을 바꿀 수 없어요' }
      }
    }
  )
  // Move a file/folder to the OS trash (recycle bin) — recoverable, safer than rm
  ipcMain.handle(
    IPC.fsDelete,
    async (_e, a: { cwd: string; relPath: string }): Promise<{ ok: boolean; error?: string }> => {
      try {
        const abs = path.isAbsolute(a.relPath) ? a.relPath : path.join(a.cwd || '', a.relPath)
        // 휴지통에 들어가면 열거할 수 없으니 지우기 '전'에 통지 대상 파일을 모아 둔다
        const gone = fs.statSync(abs).isDirectory() ? walkFilesBounded(abs) : [abs]
        await shell.trashItem(abs)
        lspManager.notifyWatchedFiles(gone.map((f) => ({ abs: f, kind: 'deleted' as const })))
        return { ok: true }
      } catch (e) {
        return { ok: false, error: (e as Error)?.message || '삭제할 수 없어요' }
      }
    }
  )
  // Move a file/folder to a new path (drag & drop). Stays within the root, refuses to move a
  // folder into itself/its descendant, and won't clobber an existing name at the destination.
  ipcMain.handle(
    IPC.fsMove,
    async (_e, a: { cwd: string; srcRel: string; destRel: string }): Promise<{ ok: boolean; error?: string }> => {
      try {
        const root = path.resolve(a.cwd || '')
        const src = path.resolve(root, a.srcRel)
        const dest = path.resolve(root, a.destRel)
        const inside = (p: string): boolean => p === root || p.startsWith(root + path.sep)
        if (!inside(src) || !inside(dest)) return { ok: false, error: '경로가 프로젝트 밖이에요' }
        if (src === dest) return { ok: true }
        if (dest === src || dest.startsWith(src + path.sep)) return { ok: false, error: '폴더를 자기 안으로 옮길 수 없어요' }
        if (fs.existsSync(dest)) return { ok: false, error: '대상에 같은 이름이 이미 있어요' }
        await fs.promises.rename(src, dest)
        notifyMoved(src, dest)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: (e as Error)?.message || '옮길 수 없어요' }
      }
    }
  )
  // Create a new empty file or folder. Fails if something with that name already exists.
  ipcMain.handle(
    IPC.fsCreate,
    async (_e, a: { cwd: string; relPath: string; dir: boolean }): Promise<{ ok: boolean; error?: string }> => {
      try {
        const abs = path.isAbsolute(a.relPath) ? a.relPath : path.join(a.cwd || '', a.relPath)
        if (fs.existsSync(abs)) return { ok: false, error: '같은 이름이 이미 있어요' }
        if (a.dir) {
          await fs.promises.mkdir(abs, { recursive: true })
        } else {
          await fs.promises.mkdir(path.dirname(abs), { recursive: true })
          await fs.promises.writeFile(abs, '', { flag: 'wx' }) // wx: fail if it appeared meanwhile
          lspManager.notifyWatchedFiles([{ abs, kind: 'created' }])
        }
        return { ok: true }
      } catch (e) {
        return { ok: false, error: (e as Error)?.message || '만들 수 없어요' }
      }
    }
  )

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

  // HTML 미리보기 URL 발급 + 서빙 루트 등록. 루트는 프로젝트(cwd) — 프로젝트 안 어디를
  // 참조하든(../assets 포함) 서빙되고, 어차피 뷰어/에이전트가 읽을 수 있는 범위라 새 노출이
  // 아니다. 문서가 cwd 밖이면(참고 폴더 등) 그 문서의 폴더로 좁힌다.
  ipcMain.handle(IPC.htmlPreviewUrl, (_e, a: { cwd: string; relPath: string }): string => {
    const abs = path.resolve(path.isAbsolute(a.relPath) ? a.relPath : path.join(a.cwd || '', a.relPath))
    const root = a.cwd ? path.resolve(a.cwd) : ''
    const under = root && abs.toLowerCase().startsWith(root.toLowerCase() + path.sep)
    pageRoots.add(((under ? root : path.dirname(abs)) + path.sep).toLowerCase())
    return 'ccg-page://local/' + abs.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
  })

  // Overwrite a file's text from the in-app editor (Ctrl+S). Writes utf-8 to the same
  // resolved path readFile uses; the renderer holds the buffer, so this is the only
  // disk write for editing.
  ipcMain.handle(IPC.writeFile, async (_e, a: { cwd: string; relPath: string; content: string }): Promise<FileWriteResult> => {
    const abs = path.isAbsolute(a.relPath) ? a.relPath : path.join(a.cwd || '', a.relPath)
    try {
      await fs.promises.writeFile(abs, a.content, 'utf8')
      // Verse 파일이면 그 프로젝트의 멤버 DB 캐시를 무효화 — 새 타입/멤버가 다른 파일의
      // 완성·색칠에도 반영되게 (verse-lsp 자체는 didChange로 이미 최신).
      lspManager.fileWritten(a.cwd || '', a.relPath)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message || '파일을 저장할 수 없어요' }
    }
  })

  // Enumerate project files (relative paths) for the "@" mention palette. Bounded and
  // generated-dir-aware in listProjectFiles so a big repo can't stall the picker.
  ipcMain.handle(IPC.listFiles, async (_e, cwd: string) => listProjectFiles(cwd || ''))

  // One folder's entries for the file explorer — called lazily as folders expand
  ipcMain.handle(
    IPC.listDir,
    async (
      _e,
      a: {
        cwd: string
        rel: string
        exclude?: string[]
        hideEmpty?: boolean
        excludeDirs?: string[]
        excludeFiles?: string[]
      }
    ) => listDir(a.cwd || '', a.rel || '', a.exclude, a.hideEmpty, a.excludeDirs, a.excludeFiles)
  )

  // Git — 탐색기 상태 스트립 + Git 카드 (main/git.ts의 시스템 git CLI 래퍼).
  // 실패는 전부 조용한 폴백(repo:false / [] / {ok:false,error}) — 카드가 그대로 보여준다.
  ipcMain.handle(IPC.gitStatus, async (_e, cwd: string) => gitStatus(cwd || ''))
  ipcMain.handle(IPC.gitLog, async (_e, a: { cwd: string; limit?: number; skip?: number }) =>
    gitLog(a.cwd || '', a.limit, a.skip)
  )
  ipcMain.handle(IPC.gitFileDiff, async (_e, a: { cwd: string; rel: string }) => gitFileDiff(a.cwd || '', a.rel))
  ipcMain.handle(IPC.gitCommitDetail, async (_e, a: { cwd: string; hash: string }) =>
    gitCommitDetail(a.cwd || '', a.hash)
  )
  ipcMain.handle(IPC.gitCommitFileDiff, async (_e, a: { cwd: string; hash: string; rel: string }) =>
    gitCommitFileDiff(a.cwd || '', a.hash, a.rel)
  )
  ipcMain.handle(IPC.gitCommit, async (_e, a: { cwd: string; files: string[]; subject: string; body: string }) =>
    gitCommit(a.cwd || '', a.files || [], a.subject || '', a.body || '')
  )
  ipcMain.handle(IPC.gitPush, async (_e, cwd: string) => gitPush(cwd || ''))
  ipcMain.handle(IPC.gitPull, async (_e, cwd: string) => gitPull(cwd || ''))
  ipcMain.handle(IPC.gitFetch, async (_e, cwd: string) => gitFetch(cwd || ''))
  ipcMain.handle(IPC.gitDiscard, async (_e, a: { cwd: string; rel: string; untracked: boolean }) =>
    gitDiscard(a.cwd || '', a.rel, !!a.untracked)
  )
  ipcMain.handle(IPC.gitBranches, async (_e, cwd: string) => gitBranches(cwd || ''))
  ipcMain.handle(IPC.gitSwitchBranch, async (_e, a: { cwd: string; name: string }) =>
    gitSwitchBranch(a.cwd || '', a.name)
  )
  ipcMain.handle(IPC.gitCreateBranch, async (_e, a: { cwd: string; name: string }) =>
    gitCreateBranch(a.cwd || '', a.name)
  )
  ipcMain.handle(
    IPC.gitAiMessage,
    async (_e, a: { cwd: string; files: string[]; account?: string; model?: ModelId; effort?: EffortId }) =>
      gitAiMessage(a.cwd || '', a.files || [], { account: a.account, model: a.model, effort: a.effort })
  )

  // LSP code intelligence for the in-app viewer — lazy per-project language servers.
  // Failures degrade to null/[]: the viewer just loses hover/jump, never errors.
  // 코드 파일 변화(에이전트 편집·저장·탐색기 작업)가 서버에 통지되면 모든 창의 뷰어에
  // 브로드캐스트 — 열려 있는 문서의 토큰 폴링을 깨워 재프라임 뒤의 색을 받아 가게 한다
  // (세션 창도 FileModal을 띄우므로 mainWindow 한정 send가 아니라 전 창에 보낸다)
  lspManager.onFilesChanged = (e) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(IPC.lspFilesChanged, e)
    }
  }
  ipcMain.handle(IPC.lspStatus, async (_e, a: { cwd: string; relPath: string }) =>
    lspManager.status(a.cwd || '', a.relPath)
  )
  ipcMain.handle(IPC.lspHover, async (_e, a: { cwd: string; relPath: string; pos: LspPos; text?: string }) =>
    lspManager.hover(a.cwd || '', a.relPath, a.pos, a.text).catch(() => null)
  )
  ipcMain.handle(IPC.lspDefinition, async (_e, a: { cwd: string; relPath: string; pos: LspPos; text?: string }) =>
    lspManager.definition(a.cwd || '', a.relPath, a.pos, a.text).catch(() => [])
  )
  ipcMain.handle(IPC.lspSemanticTokens, async (_e, a: { cwd: string; relPath: string }) =>
    lspManager.semanticTokens(a.cwd || '', a.relPath).catch(() => null)
  )
  ipcMain.handle(IPC.lspCachedTokens, async (_e, a: { cwd: string; relPath: string }) =>
    lspManager.cachedTokens(a.cwd || '', a.relPath).catch(() => null)
  )
  ipcMain.handle(IPC.lspCompletion, async (_e, a: { cwd: string; relPath: string; pos: LspPos; text: string }) =>
    lspManager.completion(a.cwd || '', a.relPath, a.pos, a.text).catch(() => null)
  )
  ipcMain.handle(IPC.lspResolveCompletion, async (_e, a: { cwd: string; relPath: string; gen: number; ri: number }) =>
    lspManager.resolveCompletion(a.cwd || '', a.relPath, a.gen, a.ri).catch(() => null)
  )
  ipcMain.handle(IPC.lspPrewarm, async (_e, a: { cwd: string }) => {
    lspManager.prewarm(a.cwd || '')
  })
  ipcMain.handle(IPC.lspWarm, async (_e, a: { cwd: string; relPath: string }) => {
    lspManager.warm(a.cwd || '', a.relPath).catch(() => {})
  })
  ipcMain.handle(IPC.lspVerseRegistry, async (_e, a: { cwd: string; relPath: string; knownRev?: number }) => {
    try {
      return lspManager.verseRegistry(a.cwd || '', a.relPath, a.knownRev)
    } catch {
      return null
    }
  })
  ipcMain.handle(IPC.lspProjectStatus, async (_e, a: { cwd: string }) => lspManager.projectStatus(a.cwd || ''))
  ipcMain.handle(IPC.lspVerseDigests, async (_e, a: { cwd: string }) => {
    try {
      return lspManager.verseDigestFolders(a.cwd || '')
    } catch {
      return []
    }
  })
  ipcMain.handle(IPC.lspVerseExcludes, async (_e, a: { cwd: string }) => {
    try {
      return lspManager.verseFileExcludes(a.cwd || '')
    } catch {
      return []
    }
  })
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
  ipcMain.handle(IPC.lspPickVerseServer, async () => {
    if (!mainWindow) return null
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      title: 'Verse 언어 서버 선택 (Verse.vsix 또는 verse-lsp.exe)',
      filters: [{ name: 'Verse 서버', extensions: ['vsix', 'exe'] }]
    })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })
  ipcMain.handle(IPC.lspSetVersePath, async (_e, p: string) =>
    lspManager.setVersePath(p || '').catch((e) => ({ ok: false as const, error: (e as Error).message || '설정 실패' }))
  )
  ipcMain.handle(IPC.lspClearVersePath, async () =>
    lspManager
      .clearVersePath()
      .then(() => ({ ok: true as const }))
      .catch((e) => ({ ok: false as const, error: (e as Error).message || '해제하지 못했어요' }))
  )

  // window controls resolve to the CALLING window — 전 창이 네이티브 최대화/복원.
  // (드래그는 렌더러의 -webkit-app-region:drag, 리사이즈는 프레임리스 thickFrame이 담당)
  ipcMain.handle(IPC.winMinimize, async (_e) => (BrowserWindow.fromWebContents(_e.sender) ?? mainWindow)?.minimize())
  ipcMain.handle(IPC.winMaximizeToggle, async (_e) => {
    const w = BrowserWindow.fromWebContents(_e.sender) ?? mainWindow
    if (!w) return false
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
    return w.isMaximized()
  })
  ipcMain.handle(IPC.winClose, async (_e) => (BrowserWindow.fromWebContents(_e.sender) ?? mainWindow)?.close())
  ipcMain.handle(IPC.winIsMaximized, async (_e) => {
    const w = BrowserWindow.fromWebContents(_e.sender) ?? mainWindow
    return w ? w.isMaximized() : false
  })

  // ── engine (Claude Code SDK) version management ──
  ipcMain.handle(IPC.engineListAvailable, async () => engineVersions.listAvailable())
  // Codex CLI 모델 목록 — 실패(미설치 등)는 빈 배열로 강등해 picker가 정적 폴백을 쓴다
  ipcMain.handle(IPC.codexModels, async () => {
    try {
      return await codexModels()
    } catch {
      return []
    }
  })
  ipcMain.handle(IPC.engineState, async () => engineVersions.getState())
  ipcMain.handle(IPC.engineInstall, async (_e, version: string) =>
    engineVersions.install(version, (p) => send(IPC.engineInstallProgress, p))
  )
  ipcMain.handle(IPC.engineUninstall, async (_e, version: string) => engineVersions.uninstall(version))
  ipcMain.handle(IPC.engineSetActive, async (_e, version: string | null) => engineVersions.setActive(version))
  ipcMain.handle(IPC.engineCleanup, async () => engineVersions.cleanupOld())
  // Codex CLI 버전 관리 — Claude Code와 동일한 문법 (전역 codex는 폴백일 뿐, 불가침)
  ipcMain.handle(IPC.codexEngineListAvailable, async () => codexVersions.codexListAvailable())
  ipcMain.handle(IPC.codexEngineState, async () => codexVersions.codexEngineState())
  ipcMain.handle(IPC.codexEngineInstall, async (_e, version: string) =>
    codexVersions.codexInstall(version, (p) => send(IPC.codexEngineInstallProgress, p))
  )
  ipcMain.handle(IPC.codexEngineUninstall, async (_e, version: string) => codexVersions.codexUninstall(version))
  ipcMain.handle(IPC.codexEngineSetActive, async (_e, version: string | null) => codexVersions.codexSetActive(version))
  ipcMain.handle(IPC.codexEngineCleanup, async () => codexVersions.codexCleanupOld())

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
  app.whenReady().then(async () => {
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
  // HTML 미리보기 문서 + 그 상대경로 리소스: ccg-page://local/<인코딩된 절대경로>.
  // 상대 참조(./style.css, ../img.png)가 URL 해석만으로 같은 스킴의 이웃 경로가 되므로
  // 별도 매핑 없이 그대로 서빙된다. 등록된 루트 밖(../.. 탈출 포함)은 404.
  protocol.handle('ccg-page', async (request) => {
    try {
      const u = new URL(request.url)
      const p = path.normalize(decodeURIComponent(u.pathname).replace(/^\//, ''))
      const key = p.toLowerCase()
      if (![...pageRoots].some((r) => key.startsWith(r))) return new Response('not found', { status: 404 })
      const st = await fs.promises.stat(p)
      if (!st.isFile()) return new Response('not found', { status: 404 })
      const ext = path.extname(p).toLowerCase()
      let mime = PAGE_MIME[ext] ?? IMG_EXTS[ext] ?? 'application/octet-stream'
      if (/^text\/|json|xml$/.test(mime)) mime += '; charset=utf-8'
      const headers: Record<string, string> = {
        'content-type': mime,
        'cache-control': 'no-cache',
        // 뷰어의 변경 감시(HEAD 폴링) 지문 + opaque origin(sandbox iframe)의 fetch 허용
        'last-modified': st.mtime.toUTCString(),
        'access-control-allow-origin': '*'
      }
      // 변경 감시 폴링은 HEAD — 본문을 읽지 않아 큰 문서도 부담 없음
      if (request.method === 'HEAD') return new Response(null, { headers })
      let data = await fs.promises.readFile(p)
      if (PAGE_MIME[ext] === 'text/html') data = Buffer.concat([data, Buffer.from(PAGE_KEY_BRIDGE, 'utf8')])
      return new Response(data, { headers })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
  createSplash()
  // 계정 v3 1회 마이그레이션 — 세션 기록을 앱 소유 shared로 복사 + 전역 로그인 가져오기.
  // 창 생성 전에 await — 복사가 끝나기 전 엔진이 실행돼 세션이 갈라지는 레이스 방지
  // (그동안 스플래시가 떠 있다). Codex(OpenAI)도 같은 문법으로 이관.
  await migrateAccounts()
  await migrateCodexAccounts()
  // Production CSP. Skipped in dev because Vite's HMR needs inline/eval + ws.
  if (!process.env['ELECTRON_RENDERER_URL']) {
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      // 미리보기 문서(ccg-page)에는 앱 CSP를 주입하지 않는다 — 문서라서 CSP가 실제로
      // 적용되는데, script-src 'self'가 인라인 <script>를 죽여 미리보기가 반쪽이 된다.
      // 격리는 sandbox iframe(opaque origin)이 맡는다.
      if (details.url.startsWith('ccg-page:')) {
        cb({})
        return
      }
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
              // ccg-page: HTML 미리보기 iframe(frame-src) + 그 변경 감시 HEAD 폴링(connect-src)
              "frame-src 'self' ccg-page:; " +
              "connect-src 'self' ccg-page:"
          ]
        }
      })
    })
  }
  createWindow()
  // ── 엔진 CLI 자동 업데이트 (설정 → Engine → 공통 토글, 기본 켬) ─────────────
  // 부팅 게이트: "새 버전이 있어요" 물어보는 창 대신, 부팅 직후 — 아직 어떤 세션도
  // 돌기 전이라 옛 버전 삭제가 실행 중 CLI(또는 상시 codex app-server)를 물 수 없는
  // 유일한 시점 — 두 엔진을 설치→활성화→이전 버전 정리까지 끝내고, 진행 상황을
  // 카드(EngineUpdateStatus REPLACE)로 렌더러에 흘린다. 할 일이 없으면 카드도 없다.
  // 6시간 주기는 설치+활성화만(다음 턴부터 새 버전) — 삭제는 하지 않는다: 진행 중
  // 세션의 CLI가 옛 폴더에서 돌고 있으면 Windows 파일 잠금으로 반쯤 지워지다 실패하고
  // 최악은 그 턴이 깨진다. 남은 옛 버전은 다음 부팅 게이트가 정리한다.
  const updateTargets = [
    {
      id: 'claude' as const,
      label: 'Claude Code',
      list: () => engineVersions.listAvailable(),
      state: async () => engineVersions.getState(),
      install: (v: string) => engineVersions.install(v, () => {}),
      setActive: (v: string) => engineVersions.setActive(v),
      cleanup: () => engineVersions.cleanupOld()
    },
    {
      id: 'codex' as const,
      label: 'Codex CLI',
      list: () => codexVersions.codexListAvailable(),
      state: async () => codexVersions.codexEngineState(),
      install: (v: string) => codexVersions.codexInstall(v, () => {}),
      setActive: (v: string) => codexVersions.codexSetActive(v),
      cleanup: () => codexVersions.codexCleanupOld()
    }
  ]
  const runBootEngineUpdate = async (): Promise<void> => {
    if (!engineVersions.getAutoUpdate()) return
    // 할 일 조사 — 조회 실패(오프라인 등) 엔진은 조용히 건너뛴다 (다음 부팅에 재시도)
    const work: { t: (typeof updateTargets)[number]; item: EngineUpdateItem }[] = []
    for (const t of updateTargets) {
      try {
        const { latest } = await t.list()
        if (!latest) continue
        const st = await t.state()
        // 활성이 latest와 같거나 더 높으면(프리뷰 채널) 할 일 없음. 같음(===)만 보던 게
        // 무한 사이클의 원인: 프리뷰 활성 상태에서 stable을 "업데이트"로 설치·활성화하면
        // 아래 정리 단계가 수치상 최신인 프리뷰만 남기고 방금 깐 stable을 도로 지워
        // 활성이 프리뷰로 복귀하고, 다음 부팅이 똑같이 반복했다(설치와 정리의 싸움).
        if (st.active && engineVersions.compareVersionsDesc(latest, st.active) >= 0) continue
        work.push({ t, item: { id: t.id, label: t.label, from: st.active, to: latest, status: 'pending' } })
      } catch {
        /* skip */
      }
    }
    if (!work.length) {
      // 업데이트 없음 — 지난 6시간 주기(사일런트 설치)가 남긴 옛 버전만 조용히 정리
      for (const t of updateTargets) {
        try {
          if ((await t.state()).installed.length > 1) await t.cleanup()
        } catch {
          /* 다음 부팅에 재시도 */
        }
      }
      return
    }
    engUpdate = { active: true, items: work.map((w) => w.item), cleanup: 'pending', freedBytes: 0, done: false }
    pushEngUpdate()
    for (const { t, item } of work) {
      item.status = 'installing'
      pushEngUpdate()
      try {
        if (!(await t.state()).installed.includes(item.to)) {
          const r = await t.install(item.to)
          if (!r.ok) throw new Error(r.error ?? '설치 실패')
        }
        t.setActive(item.to)
        item.status = 'done'
      } catch (e) {
        item.status = 'error'
        item.error = (e as Error)?.message ?? String(e)
      }
      pushEngUpdate()
    }
    engUpdate.cleanup = 'running'
    pushEngUpdate()
    for (const t of updateTargets) {
      try {
        // 실패한 설치본은 listInstalled에 안 잡히므로(마커 없는 반쪽 폴더) 안전 —
        // 최신 하나만 남기고 삭제, 활성 포인터는 cleanup이 스스로 보정한다
        if ((await t.state()).installed.length > 1) engUpdate.freedBytes += (await t.cleanup()).freedBytes
      } catch {
        /* 다음 부팅에 재시도 */
      }
    }
    engUpdate.cleanup = 'done'
    engUpdate.done = true
    pushEngUpdate()
  }
  const silentEngineUpdate = async (): Promise<void> => {
    if (!engineVersions.getAutoUpdate()) return
    for (const t of updateTargets) {
      try {
        const { latest } = await t.list()
        if (!latest) continue
        const st = await t.state()
        // 부팅 게이트와 같은 채널 가드 — 프리뷰 활성을 stable로 끌어내리지 않는다
        if (st.active && engineVersions.compareVersionsDesc(latest, st.active) >= 0) continue
        if (!st.installed.includes(latest)) {
          const r = await t.install(latest)
          if (!r.ok) continue
        }
        t.setActive(latest)
      } catch {
        /* 조용히 — 다음 주기에 재시도 */
      }
    }
  }
  setTimeout(() => void runBootEngineUpdate(), 1500) // 렌더러가 뜬 뒤 카드가 보이게 살짝 늦춘다
  setInterval(() => void silentEngineUpdate(), 6 * 60 * 60 * 1000)
  // background auto-update against GitHub Releases (no-op in dev). Status is streamed
  // to the renderer so the UI can surface an "update available / ready" banner.
  initAutoUpdater((e) => send(IPC.updateEvent, e))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  })
}

// 두 엔진의 자식 프로세스 정리 — Claude는 abort로 CLI 정리를 시작시키고,
// codex는 상시 app-server 프로세스를 죽인다
function disposeEngines(): void {
  engine.dispose()
  talkEngine.dispose()
  for (const [, e] of maEngines) e.dispose()
  for (const [, e] of sessionEngines) e.dispose()
  codexList?.dispose()
}

app.on('window-all-closed', () => {
  lspManager.disposeAll()
  disposeEngines()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  appQuitting = true // 세션 창 닫기 가로채기 해제 — 저장 후 정리 흐름이 quit을 막지 않게
  lspManager.disposeAll()
  disposeEngines()
})
