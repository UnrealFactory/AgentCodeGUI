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
import type { ViewerOpenPayload, ViewerAskPayload, ViewerMode } from '@shared/protocol'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { IPC } from '@shared/protocol'
import type {
  AccountsUsageOpts,
  AgentStatus,
  ApiConfigStatus,
  AuthStatus,
  BgTaskRequest,
  BtwOpenRequest,
  ChatTooling,
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
import { initGlassFallback } from './glassFallback'

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

/**
 * ★R28f SHIPBLOCK N1(3) — **안전값을 돌려주면 안 되는 채널**을 위한 문.
 *
 * 위 `call`의 계약("어떤 화면도 크래시하지 않는다")은 **조회**에 옳다. 목록이 잠깐 비는
 * 것은 다음 조회가 고친다. 그런데 **상태를 바꾸라는 호출**에서는 그 계약이 정확히 거꾸로
 * 돈다 — 최종 파리티 감사 R2 §N1의 실측이 그 모양이다:
 *
 * ```
 * codexAuth.reorderAccounts(현재 순서)  →  {__unimplemented:true}  →  심이 [] 로 갈음
 *   → setCxAccounts([])  →  화면의 OpenAI 계정이 **통째로 사라진다**
 *   → 호출부의 catch는 reject일 때만 도니 **영원히 안 돈다**(안내 문구 0개)
 * ```
 *
 * 즉 "실패했다"가 "빈 결과가 왔다"로 **번역**되어 호출부에 도착했다. 그래서 쓰기 채널은
 * 실패를 **구분 가능한 결과**로 올린다(reject). 호출부는 이미 try/catch를 갖고 있고,
 * 거기서 사용자에게 보이는 문구를 세운다(`Settings.tsx`의 `setNote`).
 *
 * 조회 채널은 그대로 `call`이다 — 이 문을 거기까지 넓히면 목록 하나가 없다고 설정 화면이
 * 통째로 죽는다(그게 M1이 `call`을 만든 이유다).
 */
export class ShimUnavailableError extends Error {
  readonly channel: string
  /** 백엔드가 준 **사람이 읽는 사유**(있을 때만). 없으면 호출부가 일반 문구를 쓴다. */
  readonly detail?: string
  constructor(channel: string, why: string, detail?: string) {
    super(`${channel}: ${why}`)
    this.name = 'ShimUnavailableError'
    this.channel = channel
    this.detail = detail
  }
}

async function callStrict<T>(channel: string, args: unknown[]): Promise<T> {
  let res: unknown
  try {
    res = await invoke('ipc_call', { channel, payload: args })
  } catch (err) {
    const why = String((err as Error)?.message ?? err)
    warnOnce(channel + ' !', `호출 실패: ${why}`)
    throw new ShimUnavailableError(channel, why)
  }
  if (isUnimplemented(res)) {
    warnOnce(channel, '백엔드 미구현 채널')
    throw new ShimUnavailableError(channel, '백엔드 미구현 채널')
  }
  return res as T
}

/**
 * 목록을 돌려주기로 한 채널의 strict 호출 — **배열이 아니면 reject**한다.
 *
 * 왜: `codex-auth:login`은 「띄울 수조차 없었다」를 `{ error: "…" }`로 알린다
 * (`ipc/accounts.rs`의 `login_error` — 그 자리에 목록을 돌려주면 화면은 「눌렀는데 아무 일도
 * 안 일어난다」가 되고, 그게 이 라운드가 닫는 병이다). 그 객체가 목록 setter에 그대로
 * 앉으면 `cxAccounts.map`이 죽으므로 **배열만** 통과시키고 사유는 `detail`로 올린다.
 */
async function callList<T>(channel: string, args: unknown[]): Promise<T[]> {
  const r = await callStrict<unknown>(channel, args)
  if (Array.isArray(r)) return r as T[]
  const detail = (r as { error?: unknown } | null)?.error
  throw new ShimUnavailableError(channel, '목록이 아닌 응답', typeof detail === 'string' ? detail : undefined)
}

/**
 * ★R28f SHIPBLOCK R2 — **`null`이 두 가지 뜻인 채널**을 위한 문.
 *
 * `lsp:pick-verse-server`는 「사용자가 파일 대화상자를 취소했다」를 `null`로 답한다. 그런데
 * `call`의 안전값도 `null`이라, 채널이 미구현이면 그 사실이 **사용자의 취소로 번역**되어
 * 호출부에 도착한다 — 그래서 「Verse 서버 고르기」를 눌러도 아무 일도 안 일어나고 아무
 * 말도 없었다(확인 크리틱 「요구 3의 뒷절반」 · N1과 같은 모양).
 *
 * 그래서 문자열(고름) / `null`(취소) **둘만** 통과시키고, 그 밖의 응답은 사유를 실어
 * reject한다. 셸은 이제 「없다」를 `{ error: "…" }`로 말한다(`ipc/lsp.rs`).
 */
async function callPathOrNull(channel: string, args: unknown[] = []): Promise<string | null> {
  const r = await callStrict<unknown>(channel, args)
  if (typeof r === 'string' || r == null) return (r as string | null) ?? null
  const detail = (r as { error?: unknown }).error
  throw new ShimUnavailableError(channel, '경로가 아닌 응답', typeof detail === 'string' ? detail : undefined)
}

/** 반환값이 없는(void) 채널 — 미구현이어도 조용한 no-op. */
function callVoid(channel: string, args: unknown[] = []): Promise<void> {
  return call<void>(channel, args, undefined as void)
}

/**
 * 첨부 바이트 → base64. `ipc_call`의 payload는 **JSON**이라 `ArrayBuffer`가 구조적
 * 복제로 건너가지 않는다(preload의 `ipcRenderer.invoke`와 다른 자리다). 숫자 배열로
 * 보내면 바이트당 `255,` 네 글자라 3MB 스크린샷 하나가 20MB JSON이 된다 — base64는
 * 1.37배다.
 *
 * 청크로 도는 이유: `String.fromCharCode(...arr)`는 인자를 스택에 펼쳐 큰 이미지에서
 * `RangeError: Maximum call stack size exceeded`로 죽는다. 32k는 그 한계보다 한참 아래다.
 */
function toBase64(buf: ArrayBuffer): string {
  const a = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000))
  return btoa(s)
}

// ── 이벤트 허브 (preload와 같은 문법) ─────────────────────────────────────────
// 채널당 네이티브 리스너 하나, 구독자는 평범한 Set. 멀티 워크스페이스 혼자
// ma:event에 12번 붙는 구조라 여기서 접어주지 않으면 리스너가 계속 증식한다.
const hubs = new Map<string, Set<(payload: unknown) => void>>()

/**
 * ★최종 파리티 R1 확인 크리틱 **실패2** — 구독은 **이 창 것만** 받아야 한다.
 *
 * `listen()`의 기본 대상은 `{ kind: 'Any' }`이고, Tauri의 팬아웃은 그 대상을
 * **필터보다 먼저** 통과시킨다(`tauri/src/event/listener.rs` `match_any_or_filter`:
 * `*target == EventTarget::Any || filter(...)`). 즉 셸이 `emit_to(label, …)`로 **한
 * 창에만** 보낸 이벤트를 **모든 창이 받았다**. 실측: 메인에서 `shortcut:close`를 1회
 * 부르면 메인 1 + 추가 채팅 창 1 — 다른 창의 Ctrl+W가 이 창에 열린 파일 뷰어를 닫는다
 * (`FileModal.tsx:2998`). 창별 상태(`win:state`)·닫기 전 flush 요청도 같은 병이었다.
 *
 * 라벨을 실어 등록하면 대상이 `AnyLabel`이 되어 셸의 필터가 살아난다. **브로드캐스트
 * (`app.emit`)는 필터 자체가 없어 그대로 다 받는다** — 그래서 "전 창에 알린다"는 규약은
 * 셸이 `emit_to(MAIN, …)`이 아니라 `emit(…)`으로 내는 것으로 지킨다(`win.rs`
 * `broadcast_sessions` — 2.6.2 `broadcastSessionWins`가 `getAllWindows()`를 도는 자리).
 *
 * 라벨을 못 읽으면(내부 메타데이터 부재) 옛 동작(전역 수신)으로 떨어진다 — 이벤트를
 * 통째로 잃는 것보다 낫다.
 */
function winLabel(): string {
  try {
    return getCurrentWindow().label || ''
  } catch {
    return ''
  }
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  let subs = hubs.get(channel)
  if (!subs) {
    subs = new Set()
    hubs.set(channel, subs)
    const set = subs
    const label = winLabel()
    // listen()은 비동기 등록이라 구독 직후 아주 잠깐의 공백이 있다. preload(동기 on)와
    // 다른 유일한 지점 — 부팅 직후 도착하는 이벤트는 백엔드가 스냅샷 조회(status/get)로
    // 따라잡게 되어 있어(계약면 규약) 실사용 의미는 같다.
    void listen<unknown>(
      channel,
      (ev) => {
        // 구독자가 디스패치 도중 해지/예외를 내도 루프가 깨지지 않게 사본을 돈다
        for (const fn of [...set]) {
          try {
            fn(ev.payload)
          } catch (err) {
            console.error(`[shim] subscriber error on ${channel}`, err)
          }
        }
      },
      label ? { target: label } : undefined
    )
  }
  const fn = cb as (payload: unknown) => void
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}

// ── ★R28i N3 — 「AgentCodeGUI3으로 열기」가 **실패했다**는 통지 ────────────────
// 계약면(src/shared/protocol.ts)에는 없는 **3.0 전용** 셸 채널이다. 2.6.2는 폴더가 아닌
// 인자를 `openedDirFromArgv`에서 조용히 버렸고(통지 자체가 없다), 그 침묵이 최종 파리티
// R5 §9.1 `N3`의 핵심이었다 — "창만 앞으로 오고 폴더는 사라진다. 오류도 안내도 없다."
// 성공 쪽은 계약 그대로 `IPC.openDirectory`(문자열 하나)로 온다 — 여기서 안 건드린다.
const OPEN_DIRECTORY_FAILED = 'app:open-directory-failed'

/** 열지 못한 사유 — Rust `open_dir::Verdict::reason()`과 같은 이름표다. */
export type OpenDirFailure = {
  path: string
  reason: 'empty' | 'not-a-dir' | 'denied' | 'not-found' | (string & {})
}

/** 셸이 폴더를 열지 못했을 때(없음·파일·권한). 구독 해지 함수를 돌려준다. */
export function onOpenDirectoryFailed(cb: (f: OpenDirFailure) => void): () => void {
  return subscribe<OpenDirFailure>(OPEN_DIRECTORY_FAILED, cb)
}

// ── ★LSPIDLE R3 — 「죽을 때 하는 말」과 「아직 못 물어봤다」를 읽는 3.0 전용 계약면 ──
//
// 동결 계약면(`src/shared/protocol.ts:176`)의 `LspProjectStatus`는 `{state, percent}`뿐이고,
// `LspSemanticTokens`는 `{data, types, mods}`뿐이다. Rust는 두 칸을 **더해서** 보내는데
// (`ccg-lsp/src/lib.rs` — `error` · `pending`) 타입이 막아 렌더러가 읽을 수가 없었다.
// 크리틱 LSPIDLE R2 §4-A가 그 세 겹(타입에 칸 없음 · 렌더러가 안 읽음 · 에러 세계에선
// 아예 안 부름)을 짚은 자리다.
//
// 동결 트리를 열지 않고 여기서 닫는다 — `OpenDirFailure`(위)와 같은 모양이다:
// **3.0 전용 타입 + 전용 헬퍼**를 내보내고, 호출부는 `window.api`가 아니라 이 함수를 쓴다.
// 채널·페이로드는 그대로라 셸(`src-tauri/src/ipc/lsp.rs`)도 안 건드린다.

/** `lsp:project-status`의 **실제** 모양 — 동결 타입에 `error` 한 칸이 더 온다. */
export type LspProjectStatusEx = {
  state: 'idle' | 'analyzing' | 'ready'
  percent: number | null
  /**
   * 서버가 죽었다면 그 사유(`Error: Cannot find module 'X'` 등). Rust가 **앞에서** 320자만
   * 남겨 보낸다 — 사용자가 읽어야 할 것은 거의 언제나 첫 줄이라서.
   * 살아 있는 프로젝트에서는 이 칸이 아예 없다(`undefined`).
   */
  error?: string
}

/** 프로젝트 분석 상태 + **사유**. `window.api.lsp.projectStatus`의 3.0판이다. */
export function lspProjectStatusEx(cwd: string): Promise<LspProjectStatusEx> {
  return call<LspProjectStatusEx>(IPC.lspProjectStatus, [{ cwd }], { state: 'idle', percent: null })
}

/** `lsp:semantic-tokens`의 **실제** 모양 — 「아직 못 물어봤다」 표가 더 온다. */
export type LspTokensEx = { data: number[]; types: string[]; mods: string[]; pending?: boolean }

/**
 * 서버가 예산 안에 `ready`가 못 되어 **묻지도 못한** 답인가.
 *
 * 빈 토큰과 모양이 같으면 렌더러는 「이 파일엔 심볼이 없다」로 굳는다(크리틱이 이름 붙인
 * 「조용한 빈손」). 회수 뒤 재기동이 정확히 그 모양인데, 그때 렌더러는 이미 `ready`라 믿고
 * status 폴링을 멈춘 뒤라 **다시 알려 줄 사람이 이 표 말고 없다**.
 */
export function isTokensPending(t: unknown): boolean {
  return !!t && (t as LspTokensEx).pending === true
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
  // try/catch로 감싸 첨부를 건너뛰게 되어 있어, 실패는 조용한 skip이 정답이다.
  saveAttachmentData: async (bytes: ArrayBuffer, ext: string) => {
    const p = await call<string>(IPC.saveAttachmentData, [{ b64: toBase64(bytes), ext }], '')
    if (!p) throw new Error('saveAttachmentData: 저장 실패')
    return p
  },
  // Electron webUtils.getPathForFile의 대응물. Tauri는 OS 드래그 경로를 네이티브
  // drag-drop 이벤트로만 주므로 File→경로 동기 해석이 불가하다(M1 갭 — chrome.ts가
  // 마지막 drop 경로를 캐시해 이름이 맞으면 돌려준다).
  pathForFile: (file: File) => dropPathFor(file),
  getUsage: (fresh?: boolean, account?: string) => call(IPC.getUsage, [fresh, account], NO_USAGE),
  auth: {
    // `login`만 `call`이다 — 반환값 자체가 `{ok:false, error}`라 **실패가 결과 안에 실린다**
    // (호출부가 `res.ok`를 보고 문구를 세운다). 아래 넷은 그런 자리가 없어 strict다.
    login: (useConsole?: boolean) => call(IPC.authLogin, [useConsole], NO_AUTH),
    logout: (email: string) => callStrict(IPC.authLogout, [email]),
    cancelLogin: () => callVoid(IPC.authLoginCancel),
    onLoginUrl: (cb: (url: string) => void) => subscribe(IPC.authLoginUrl, cb),
    listAccounts: () => call(IPC.authListAccounts, [], []),
    setDefaultAccount: (email: string) => callStrict(IPC.authSetDefaultAccount, [email]),
    removeAccount: (email: string) => callStrict(IPC.authRemoveAccount, [email]),
    reorderAccounts: (emails: string[]) => callStrict(IPC.authReorderAccounts, [emails]),
    // ★R28 ACCT §1 — 인자 0개가 2.6.2 규약이고 3.0은 선택 옵션 하나를 더 받는다.
    // 안 넘기면 `undefined`가 실려 셸이 `Value::Null`로 읽는다(= R1과 같은 동작).
    accountsUsage: (opts?: AccountsUsageOpts) => call(IPC.authAccountsUsage, [opts], [])
  },
  codexAuth: {
    listAccounts: () => call(IPC.codexListAccounts, [], []),
    // ★R28f SHIPBLOCK N1 — 목록을 **갈아끼우는** 넷은 전부 strict다. 이 넷의 안전값이
    // `[]`였던 것이 감사 §N1의 두 번째 피해(계정 목록 증발 + 안내 문구 0개)의 기전이다.
    // 목록 채널 중 유일하게 **사유 객체**가 올 수 있는 자리(띄울 CLI가 없다 등) — `callList`가
    // 배열만 통과시키고 사유를 `ShimUnavailableError.detail`로 올린다.
    login: () => callList(IPC.codexLogin, []),
    logout: (email: string) => callStrict(IPC.codexLogout, [email]),
    setDefaultAccount: (email: string) => callStrict(IPC.codexSetDefaultAccount, [email]),
    cancelLogin: () => callVoid(IPC.codexLoginCancel),
    reorderAccounts: (emails: string[]) => callStrict(IPC.codexReorderAccounts, [emails]),
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
    // ★R28f SHIPBLOCK R2 — 안전값 `null`은 「사용자가 취소했다」와 구분이 안 된다.
    pickVerseServer: () => callPathOrNull(IPC.lspPickVerseServer),
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
    // ★M9 R2 — 도구 환경 재조회(마운트 1회). 셸은 이벤트 봉투째(`{type:'tooling',
    // runId, tooling}`) 돌려주므로 여기서 알맹이만 꺼내 준다 — 구독자가 받는 값과 같은
    // 모양(`ChatTooling`)이어야 호출부가 두 경로를 한 setState로 받는다.
    toolingGet: async (panelId: string) => {
      const r = await call<{ tooling?: ChatTooling } | null>(IPC.chatToolingGet, [{ panelId }], null)
      return r?.tooling ?? null
    },
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
  onWinState: (cb: (s: WindowState) => void) => subscribe(IPC.winState, cb),
  // 파일 뷰어 독립 창 — `viewer:state`는 부팅 페이로드에 실려 첫 호출이 왕복 없이 끝난다.
  viewer: {
    state: () => call<ViewerMode>(IPC.viewerState, [], { window: false }),
    setMode: (on: boolean) => callVoid(IPC.viewerSetMode, [on]),
    open: (p: ViewerOpenPayload) => call<boolean>(IPC.viewerOpen, [p], false),
    hydrate: () => call<ViewerOpenPayload | null>(IPC.viewerHydrate, [], null),
    shown: () => callVoid(IPC.viewerShown),
    hide: () => callVoid(IPC.viewerHide),
    dock: (p: ViewerOpenPayload) => callVoid(IPC.viewerDock, [p]),
    askSelection: (p: ViewerAskPayload) => callVoid(IPC.viewerAsk, [p]),
    onOpen: (cb: (p: ViewerOpenPayload) => void) => subscribe(IPC.viewerOpen, cb),
    onMode: (cb: (m: ViewerMode) => void) => subscribe(IPC.viewerMode, cb),
    onDocked: (cb: (p: ViewerOpenPayload) => void) => subscribe(IPC.viewerDocked, cb),
    onAskSelection: (cb: (p: ViewerAskPayload) => void) => subscribe(IPC.viewerAsk, cb)
  }
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

// 유리 폴백 — OS가 아크릴을 못 그릴 때(투명 효과 끔·원격 세션) 셸이 통지하면
// 의도된 불투명 다크 배경으로 갈아탄다. 창이 transparent라 이게 없으면 벽지가
// 생으로 비쳐 글자를 못 읽는다(glassFallback.ts 헤더 실측).
initGlassFallback()
