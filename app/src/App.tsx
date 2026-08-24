import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiConfigStatus, AppUser, BgTaskRequest, ChatStatusLite, EngineId, RunRequest, SessionWindowInfo, SubAgentInfo, UsageInfo, UserProfile } from '@shared/protocol'

// 백그라운드 셸 컨트롤(중지/Ctrl+B) — window.api는 전역이라 모듈 스코프의 고정 함수로
// 만들어 memo된 WorkBar가 매 렌더마다 새 콜백을 받지 않게 한다
const onBgTaskMain = (req: BgTaskRequest): void => {
  window.api.bgTask(req).catch(() => {})
}
import { extractMentions } from './lib/mentions'
import { useTurnNotify } from './lib/notify'
import type { NotifyTarget } from '@shared/protocol'
import { useAgentSession, engineAction, initialSessionState, reducer as sessionReducer, sanitizeSnapshot, snapshotForPersist, sameCwd, commandOf, commandTitleOf, liveMsgIndex, nowTime, type SessionState } from './store/session'
import { shellAuthored, verdictNote, verdictLine } from './lib/verdict'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Sidebar, type ChatSummary, type SidebarSection } from './components/Sidebar'
import { pushRecentDir, seedRecentDirs } from './lib/recentDirs'
import { FoldSlotHold, MultiWorkspace, PanelDial, useMultiSessions, type MultiExplorerInfo, type PanelSummary } from './components/MultiAgent'
// ★ 3.0 M-UX — WindowApi에 없는 통합 채널들(§6.1·§6.2). 계약면(src/shared)은 안 건드린다.
import {
  closeChatWindow,
  focusChatWindow,
  listChatWindows,
  onChatEvent,
  onChatIdentity,
  onChatRunState,
  onChatStatus,
  onChatVerdict,
  onChatWindows,
  respondDialog,
  resumeHold,
  revertIdentity,
  runChat,
  setActiveChat,
  type WindowSlot
} from './api/unified'
import { noteSettled } from './lib/settled'
// ★M10 R2 — 대화 연결의 **긴급 정지**. R1은 채널만 있고 누를 자리가 0이었다(크리틱 D7).
import { TalkStopPill } from './components/TalkStop'
import { NewChatModal } from './components/NewChatModal'
import { getPref, setPref, delPref } from './lib/prefs'
import { t, useLang } from './lib/i18n'
// ★R28 ACCT §1·§3 — 계정 한도 선행 워밍 + 「계정 → 살아 있는 자리」 역인덱스의 재료 공급.
import { MAIN_SLOT_NAME, primeUsageFromDisk, putChatStatuses, putSlotNames, warmUsage, WINDOW_SLOT_NAME } from './lib/accounts'
import { sanitizeHold } from './lib/limitResume'
import { canPressResume, engineHoldOf, engineOwnsResume } from './lib/resumeOwner'
import { useLimitResume } from './lib/useLimitResume'
import {
  SIDEBAR_AUTOHIDE,
  SIDEBAR_AUTOHIDE_TRIGGER,
  AUTOHIDE_DEFAULT,
  AUTOHIDE_TRIGGER_DEFAULT,
  SIDEBAR_AUTOHIDE_EVENT,
  SIDEBAR_AUTOHIDE_TRIGGER_PREVIEW_EVENT,
  type AutohideTriggerPreviewDetail
} from './lib/sidebarAutohide'
import { BtwDock, ChatHeader, ChatFind, Composer, FALLBACK_ASK_CANCEL, IdentityBand, LimitHoldBar, MessageView, QuestionModal, PermissionModal, SelectionToolbar, VerdictToast, WelcomeState, WorkBar, WorkflowDock, WorkingIndicator, hasRunningBash, isFallbackAsk, nextMode, pickerModelOf, slashCommandsWithBtw, useThreadFollow, useThreadWindow, type IdentityNotice, type NotifyAction, type PickerState, type ScheduledMsg, type VerdictToastItem } from './components/Chat'
import { parseBtw, btwForkOf } from './lib/btw'
import { SubAgentModal } from './components/AgentPanel'
import { Explorer } from './components/Explorer'
import { FolderSwitchDialog } from './components/FolderSwitchDialog'
// 지연 로드 — FileModal이 CodeMirror 전체(+cm 유틸·semTokens)를 끌고 와 번들의 ~1/3이다.
// 뷰어를 처음 열 때 로컬 청크 한 번만 로드하면 되고, 그 전엔 파스·메모리 비용이 0이 된다.
const FileModal = lazy(() => import('./components/FileModal').then((m) => ({ default: m.FileModal })))
import { ChangedFilesModal } from './components/ChangedFilesModal'
import { GitModal, type GitViewerOverride } from './components/GitModal'
import { ImageViewer } from './components/ImageViewer'
import { SettingsModal } from './components/Settings'
import { EngineGate } from './components/EngineGate'
import { EngineUpdateGate } from './components/EngineUpdateGate'
import { AppUpdateGate } from './components/AppUpdateGate'
import { PatchNotes } from './components/PatchNotes'
import { useZoom, ZoomBadge, mergeRefs } from './components/zoom'
import { MouseGestureLayer, clearGesture, sessionWindowGesture, type GestureAction } from './components/mouseGesture'
import { IconChevDown, IconMascot } from './components/icons'

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

// One conversation in the sidebar. The active chat's live data lives in the
// agent session; inactive chats hold a frozen snapshot restored on switch.
interface ChatMeta {
  id: string
  title: string
  custom: boolean // user-renamed → keep the title instead of deriving from prompts
  snapshot: SessionState
  manualCwd: string
  refDirs?: string[] // 참조 폴더(--add-dir) — 작업 폴더 외에 엔진이 함께 인식할 폴더들
  picker: PickerState // 모델·effort·모드 — per chat, restored on switch
  draft?: string // 보내지 않은 컴포저 초안 — 채팅 전환/재시작에도 유지
  draftImages?: string[]
  // ★ 3.0 M-UX R2 — 예약 큐는 **이 채팅의 것**이다 (ux-chat-unify `Chat.queue`).
  // 앱 단위 단일 목록이던 시절의 전제("활성 채팅 = 유일하게 도는 채팅")를 스펙 ⑥이
  // 깼고, 그 결과 A에서 예약한 프롬프트가 B로 발사됐다(크리틱 M-UX R1 §2-①).
  // 소유자를 대화로 내리면 전환은 큐를 **주차**할 뿐이고, 발사는 그 대화의 턴 종료에만
  // 일어난다. 디스크에는 안 실린다 — `queue`는 chats-v3의 Rust 소유 필드라
  // `chats:save` 페이로드의 값이 어떤 경우에도 채택되지 않는다(chats_v3.rs `apply_owned`).
  // 그래서 렌더러 사본은 **세션 메모리 수명**이고, 저장 페이로드에서 명시적으로 뺀다.
  queue?: ScheduledMsg[]
  updatedAt?: number // 마지막 활동(프롬프트 전송) 시각 — 사이드바 상대 시간 표시용
  // 스냅샷이 메모리에 없다는 표식 — snapshot은 자리표시자(initialSessionState)고 진짜는
  // 디스크의 채팅 파일에 있다(전환 시 loadChat으로 되읽음). 모든 채팅의 전체 스냅샷을
  // 상주시키던 것이 이틀 상주 렌더러를 1GB대로 키우던 주범이라, 활성 채팅만 산다.
  // 저장 페이로드의 이 표식은 main(chats.ts)이 "메타만 덮고 파일 스냅샷은 지켜라"로 읽는다.
  unloaded?: boolean
}

// fallback for fresh chats and for chats saved before the picker was persisted
const DEFAULT_PICKER: PickerState = { model: 'opus', effort: 'xhigh', mode: 'auto' }
const MODEL_IDS = ['fable', 'opus', 'sonnet', 'haiku']
const EFFORT_IDS = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal']
const MODE_IDS = ['normal', 'plan', 'acceptEdits', 'auto', 'bypass']
// a picker loaded from disk may be missing (older file) or hold ids this build no
// longer knows — every field falls back to the default individually
function sanitizePicker(p?: Partial<PickerState> | null): PickerState {
  return {
    model: p?.model && MODEL_IDS.includes(p.model) ? p.model : DEFAULT_PICKER.model,
    effort: p?.effort && EFFORT_IDS.includes(p.effort) ? p.effort : DEFAULT_PICKER.effort,
    mode: p?.mode && MODE_IDS.includes(p.mode) ? p.mode : DEFAULT_PICKER.mode,
    // 실행 엔진 + Codex 모델 — codex가 아니면 필드를 지워 기본(Claude)으로
    engine: p?.engine === 'codex' ? 'codex' : undefined,
    codexModel: typeof p?.codexModel === 'string' && p.codexModel ? p.codexModel : undefined,
    // 실행 계정(이메일) — 등록 목록과의 대조는 비동기라 여기선 형태만 확인. 목록에서
    // 사라진 계정은 picker가 경고 항목으로 보여주고, 실행 시 엔진이 에러로 알린다.
    account: typeof p?.account === 'string' && p.account ? p.account : undefined,
    codexAccount: typeof p?.codexAccount === 'string' && p.codexAccount ? p.codexAccount : undefined
  }
}

let chatSeq = 0
function chatId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  chatSeq += 1
  return `chat-${chatSeq}-${performance.now().toString(36)}`
}

// stable callback identity that always calls the latest closure — lets memoized
// children (Sidebar/WorkBar) skip re-render on every keystroke without stale
// closures or hand-tracked dependency arrays
function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn)
  ref.current = fn
  return useRef((...args: A) => ref.current(...args)).current
}

function newChatMeta(manualCwd = '', picker: PickerState = DEFAULT_PICKER, refDirs: string[] = []): ChatMeta {
  return {
    id: chatId(),
    title: '',
    custom: false,
    snapshot: initialSessionState,
    manualCwd,
    refDirs: [...refDirs],
    picker: { ...picker }
  }
}

// 저장본의 참조 폴더 위생 — 문자열 배열만, 상한 8 (손상 저장본이 이상한 값을 흘려도 무해하게)
function sanitizeRefDirs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && !!s).slice(0, 8) : []
}

// ── ★ 3.0 M-UX R2 — 실행 요청 조립 (두 드레인 경로의 단일 소스) ────────────────
//
// 활성 채팅은 `runPrompt`가, 자리 밖 채팅은 `drainBgQueue`가 보낸다. 두 경로가 프롬프트를
// 다르게 만들면 "돌아와 보니 내 예약이 다른 문장으로 나갔다"가 된다 — 멘션/첨부 안내와
// resume 게이트를 여기 한 곳에 둔다.
function promptWithNotes(text: string, cmd: string | null, imgs: string[]): string {
  if (cmd) return text // 명령은 extras를 안 받는다
  const notes: string[] = []
  const mentions = extractMentions(text)
  if (mentions.length)
    notes.push(
      `${t('[멘션된 파일 — 필요하면 Read 도구로 확인하세요]', '[Mentioned files — read them with the Read tool if needed]')}\n${mentions.map((p) => '- ' + p).join('\n')}`
    )
  if (imgs.length)
    notes.push(
      `${t('[첨부 파일 — Read 도구로 확인하세요]', '[Attached files — read them with the Read tool]')}\n${imgs.map((p) => '- ' + p).join('\n')}`
    )
  return notes.length ? `${text}\n\n${notes.join('\n\n')}` : text
}
function buildRunRequest(a: {
  text: string
  images: string[]
  picker: PickerState
  cwd: string
  refDirs: string[]
  session: SessionState['session']
  apiMode: boolean
}): RunRequest {
  const pk = a.picker
  const extraDirs = a.refDirs.filter((p) => !sameCwd(p, a.cwd))
  return {
    prompt: promptWithNotes(a.text, commandOf(a.text), a.images),
    model: pk.model,
    effort: pk.effort,
    mode: pk.mode,
    engine: pk.engine,
    codexModel: pk.codexModel,
    cwd: a.cwd,
    addDirs: extraDirs.length ? extraDirs : undefined,
    // 세션 id는 폴더 스코프다 — 폴더가 바뀌었으면 이어붙이지 않는다("No conversation found")
    resume: a.session && sameCwd(a.session.cwd, a.cwd) ? a.session.sessionId : undefined,
    useApi: a.apiMode || undefined,
    account: pk.account,
    codexAccount: pk.codexAccount
  }
}

// ── chat persistence (~/.agentcodegui/chats.json) ───────────────────────────
const CHATS_VERSION = 1
// 저장 페이로드의 채팅 — unloaded 채팅은 스냅샷 없이(메타만) 나가고, `queue`는 아예
// 안 나간다(Rust 소유 필드 — 통합 스토어가 페이로드 값을 버린다. 위 ChatMeta.queue 주석)
type PersistedChat = Omit<ChatMeta, 'snapshot' | 'queue'> & { snapshot?: SessionState }
interface PersistedChats {
  version: number
  chats: PersistedChat[]
  activeChatId: string
}

function MainApp({ user }: { user: AppUser }) {
  const lang = useLang() // 언어 전환 시 아래 useMemo(사이드바 섹션 라벨 등)가 새 언어로 재계산되게
  const { state, elapsed, busy, begin, clearPermission, clearQuestion, answerQuestion, load, interruptTurn, noteVerdict, noteReverted } = useAgentSession()
  // 워크플로 상주 중(턴은 끝나 busy=false) — 전송·채팅 전환이 워크플로를 죽이지 않게 잠근다
  const wfAlive = state.workflows.some((w) => w.status === 'running')
  // 턴을 막고 있는 포그라운드 Bash가 있을 때만 셸 팝오버에 "건너뛰기"(Ctrl+B) 버튼을 노출
  const canSkipWait = useMemo(() => hasRunningBash(state.messages), [state.messages])
  const [input, setInput] = useState('')
  // 이번 대화에서 내가 보낸 메시지(오래된→최신) — 작성칸에서 ↑/↓로 셸처럼 다시 불러온다
  const sentHistory = useMemo(
    () =>
      state.messages
        .filter((m): m is Extract<SessionState['messages'][number], { kind: 'msg' }> => m.kind === 'msg' && m.role === 'user')
        .map((m) => m.text)
        .filter((t) => t.trim().length > 0),
    [state.messages]
  )
  const [picker, setPicker] = useState<PickerState>(DEFAULT_PICKER)
  const [manualCwd, setManualCwd] = useState('')
  // 참조 폴더(--add-dir) — 이 채팅의 작업 폴더 외 추가 작업 루트 (폴더 팝오버에서 관리)
  const [refDirs, setRefDirs] = useState<string[]>([])
  const [images, setImages] = useState<string[]>([])
  // ★ 3.0 M-UX R2 — **활성 채팅의** 예약 큐. 진실은 `ChatMeta.queue`이고 이 state는
  // 그중 지금 화면에 있는 한 벌이다(초안 draft/draftImages와 같은 규약: 전환 때
  // saveActive가 접어 넣고 restore가 되꺼낸다).
  //
  // 2.6.2의 주석은 *"busy 중에만 예약할 수 있고 busy 중엔 채팅을 못 떠나므로 이 단일
  // 목록은 언제나 활성 채팅의 것"* 이었다. 스펙 ⑥이 뒷문장을 지웠는데 앞문장의 결론이
  // 남아 A의 예약이 B로 발사됐다. 소유자를 아래 `queueOwnerRef`로 명시하고, 드레인은
  // 소유자와 활성 채팅이 일치할 때만 돈다(자리 밖 채팅은 `drainBgQueue`가 `chat:run`으로).
  const [queue, setQueue] = useState<ScheduledMsg[]>([])
  // 이 `queue` state가 **누구 것인가**. 전환 착지(restore/createChat/삭제 후 착지)에서만
  // 바뀐다 — 렌더 순서에 기대지 않고 불변식을 코드로 들고 있기 위한 ref다.
  const queueOwnerRef = useRef('')
  // the image lightbox/multi-viewer: the set being viewed + the active index (null = closed)
  const [viewer, setViewer] = useState<{ images: string[]; index: number } | null>(null)
  const [usage, setUsage] = useState<UsageInfo>({ fiveHour: null, weekly: null, weeklyFable: null, extraCredit: null })
  // 한도 자동 이어서 — 과금 picker(구독 → '한도 소진 시 자동 이어서')로 켜는 앱 단위
  // 설정. 켜두면 구독 한도에 막혀 죽은 턴을 리셋 시각에 자동 재개한다 (클로드 코드
  // 데스크톱의 auto-continue 체크박스 패리티). 상태 머신은 useLimitResume(아래) 공용 —
  // 본채팅·멀티 패널이 이 한 쌍(상태+토글 핸들러)을 같이 쓴다.
  const [autoResume, setAutoResume] = useState<boolean>(() => getPref<boolean>('limitResume.on', false))
  const onAutoResumeChange = useEvent((on: boolean) => {
    setPref('limitResume.on', on)
    setAutoResume(on)
  })
  // API 모드 — 켜면 실행이 구독(OAuth) 대신 저장된 API 키로 과금된다. 앱 단위 설정
  // (채팅별 picker와 달리 과금 수단이라 전역이 자연스럽다) — uiPrefs에 영속.
  const [apiMode, setApiMode] = useState<boolean>(() => getPref<boolean>('api.mode', false))
  // 설정 → API의 스냅샷(키 존재·예산·누적 사용액) — 토글 가드와 남은 예산 표시에 쓴다
  const [apiCfg, setApiCfg] = useState<ApiConfigStatus | null>(null)
  // 설정 모달을 특정 탭으로 열기 (키 없이 API 토글을 누르면 'api' 탭으로 바로)
  const [settingsView, setSettingsView] = useState<'version' | 'api' | undefined>(undefined)
  const [openFilePath, setOpenFilePath] = useState<string | null>(null)
  // Git 카드(탐색기 하단 스트립) — null=닫힘, {root}=열림(root는 스트립이 고른 저장소 —
  // 없으면 카드가 발견 목록의 첫 저장소로). 카드에서 연 파일의 일회성 뷰어 오버라이드는
  // gitViewer(커밋 스냅샷·일회성 diff·해시 칩) — 일반 경로로 연 파일은 null이라 뷰어가 평소처럼 돈다.
  const [gitOpen, setGitOpen] = useState<{ root?: string } | null>(null)
  const [gitViewer, setGitViewer] = useState<GitViewerOverride | null>(null)
  // 탐색기 우클릭 '변경된 파일 보기' 카드 — 스코프 폴더(rel '' = 프로젝트 전체)와 표시 이름
  const [chgScope, setChgScope] = useState<{ rel: string; label: string } | null>(null)
  // a working-folder change that would reset the current conversation, parked here
  // until the user confirms it in the card modal (변경) or backs out (취소)
  const [pendingFolder, setPendingFolder] = useState<string | null>(null)
  const [openSubagentId, setOpenSubagentId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [chats, setChats] = useState<ChatMeta[]>(() => [newChatMeta()])
  const [activeChatId, setActiveChatId] = useState<string>(() => chats[0].id)
  // 저장 완료 콜백(비동기)에서 "지금" 활성인 채팅을 지키기 위한 ref — 클로저의 낡은
  // activeChatId로 방금 전환해 온 채팅의 스냅샷을 내리면 안 된다
  const activeChatIdRef = useRef(activeChatId)
  activeChatIdRef.current = activeChatId
  // 일반(단일) / 멀티 뷰 — 2.0: 모드 탭이 사라지고 사이드바 항목 선택이 뷰를 정한다.
  // 1.x의 'chat'(순수 채팅 모드) 저장값은 'single'로 위생 처리 (모드 자체가 은퇴).
  const [mode, setMode] = useState<'single' | 'multi'>(() =>
    getPref<string>('workspace.mode', 'single') === 'multi' ? 'multi' : 'single'
  )
  const switchMode = (m: 'single' | 'multi'): void => {
    setMode(m)
    setPref('workspace.mode', m)
  }
  // 멀티 세션 메타(목록·제목·상태·영속화) — App이 소유해 사이드바 '배치' 섹션이
  // 어느 뷰에서든 그려지고, 멀티 뷰는 이 번들을 받아 활성 보드만 렌더한다
  const multi = useMultiSessions()
  // ★ 3.0 M-UX — 활성 보드의 자리 요약(제목·상태·자리 번호·접힘). 통합 사이드바
  // 「채팅」 목록이 일반 채팅과 **한 목록**으로 그린다(§8-①(a)).
  // 보드 크롬을 떠나도(일반 채팅으로 전환) 비우지 않는다 — 다시 들어가면 새 마운트가
  // 곧바로 덮어쓴다(multiExp와 같은 규약). 비우면 사이드바에서 대화가 사라져 보인다.
  const [panelInfos, setPanelInfos] = useState<PanelSummary[]>([])
  // 열린 세션 창(추가 채팅) 목록 — 메인 프로세스 레지스트리 구독
  const [sessionWins, setSessionWins] = useState<SessionWindowInfo[]>([])
  useEffect(() => {
    window.api.sessionWindows.list().then(setSessionWins).catch(() => {})
    return window.api.sessionWindows.onChanged(setSessionWins)
  }, [])
  // ★R28 ACCT §3 — 추가 채팅 창의 자리 이름표. 「사용 중 · 추가 창」의 그 「추가 창」이다.
  // 셸이 주는 것은 chatId뿐이라(계정은 `chat:status`가 싣는다) 여기서 이름만 붙인다.
  useEffect(() => {
    putSlotNames('wins', Object.fromEntries(sessionWins.map((w) => [w.id, w.title?.trim() || WINDOW_SLOT_NAME()])))
  }, [sessionWins, lang])
  // 본채팅 목록의 이름표 — 제목이 있으면 제목(사용자가 아는 이름), 없으면 「본채팅」.
  useEffect(() => {
    putSlotNames('chats', Object.fromEntries(chats.map((c) => [c.id, c.title?.trim() || MAIN_SLOT_NAME()])))
  }, [chats, lang])
  // ★R28 ACCT §1 — **선행 워밍.** 시작 직후와 창 포커스에서 백그라운드로 미리 조회해,
  // Account 탭·계정 picker를 열 때는 이미 따뜻한 캐시를 치게 한다. 두 안전장치가 붙는다:
  //   ① 90초 쿨다운(포커스가 잦아도 다시 안 묻는다)
  //   ② `warm:true` — **로컬 토큰이 살아 있는 계정만** 묻는다. 오래 논 계정의 리프레시
  //      토큰 회전은 되돌릴 수 없는 부작용이라, 앱을 켠 것만으로 그 일이 나면 안 된다
  //      (M11 R2 C1이 부팅 프리웜을 들어낸 바로 그 이유).
  // 우선 조회 대상은 **지금 이 채팅의 계정**이다. ref로 읽는 이유: 워밍은 나중에(포커스
  // 회복 때) 돌고, 그때의 계정이어야 한다(클로저에 박힌 첫 렌더 값이면 늘 같은 계정이다).
  const warmAcctRef = useRef<string | undefined>(undefined)
  warmAcctRef.current = picker.account
  useEffect(() => {
    void primeUsageFromDisk()
    const warm = (): void => warmUsage(warmAcctRef.current)
    const id = setTimeout(warm, 1_500) // 부팅 경로(엔진·LSP 프리웜)와 겹치지 않게 조금 뒤
    window.addEventListener('focus', warm)
    return () => {
      clearTimeout(id)
      window.removeEventListener('focus', warm)
    }
  }, [])
  // 전 채팅 경량 상태(`chat:status`) · 창 자리 목록(`chat:windows`) — 구독은 아래 effect.
  // **선언만 여기로 올린다**: 한도 재개 훅(useLimitResume, §R3 7)이 `chatStatus`를 읽는데
  // 그 호출이 구독 effect보다 위에 있어 TDZ에 걸린다.
  const [chatStatus, setChatStatus] = useState<Record<string, ChatStatusLite>>({})
  const [winSlots, setWinSlots] = useState<WindowSlot[]>([])
  // 새 채팅 선택 모달 (일반/멀티 → 패널 수) — Ctrl+N·사이드바 새 채팅이 연다
  const [newChatOpen, setNewChatOpen] = useState(false)
  // 파일 탐색기 — 2.0: 왼쪽 칼럼을 채팅 사이드바와 '전환'해 쓴다 (헤더 돋보기 옆 버튼).
  // 기본은 채팅 목록. 전환 상태는 앱 단위로 기억.
  const [explorerOpen, setExplorerOpen] = useState<boolean>(() => getPref<boolean>('explorer.swap', false))
  const toggleExplorer = useEvent(() => {
    setExplorerOpen((o) => {
      setPref('explorer.swap', !o)
      return !o
    })
  })
  // 왼쪽 칼럼 폭 — 오른쪽 경계 핸들 드래그로 조절(180–420px), 앱 단위로 기억.
  // null = 기본 폭(242px, 좁은 창 210px 반응형 유지 — 인라인 스타일을 안 얹는다).
  // 핸들 더블클릭이 기본 폭 복귀. 실제 드래그가 있을 때만 저장 — 클릭만으로
  // 기본(반응형)이 고정 폭으로 굳는 걸 막고, 더블클릭 복귀와도 안 엉킨다.
  const [lcolW, setLcolW] = useState<number | null>(() => getPref<number | null>('sidebar.width', null))
  const [lcolDrag, setLcolDrag] = useState(false)
  const onLcolResize = useEvent((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const handle = e.currentTarget
    const startW = handle.parentElement?.getBoundingClientRect().width ?? 242
    const startX = e.clientX
    let w: number | null = null
    handle.setPointerCapture(e.pointerId)
    setLcolDrag(true)
    const onMove = (ev: PointerEvent): void => {
      w = Math.round(Math.min(420, Math.max(180, startW + (ev.clientX - startX))))
      setLcolW(w)
    }
    const onUp = (): void => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      setLcolDrag(false)
      if (w != null) setPref('sidebar.width', w)
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  })
  const onLcolReset = useEvent(() => {
    setLcolW(null)
    setPref('sidebar.width', null)
  })
  // 사이드바 자동 숨김 — 켜면 왼쪽 칼럼을 오버레이로 접고(본문이 폭을 가득 쓴다),
  // 왼쪽 가장자리 감지 폭 안으로 마우스가 오면 슥 펼치고, 본문 쪽으로 벗어나면 다시 접는다.
  // 값은 설정 › Display에서 바꾸며 SIDEBAR_AUTOHIDE_EVENT로 이 창이 즉시 다시 읽는다.
  const [autohide, setAutohide] = useState<boolean>(() => getPref<boolean>(SIDEBAR_AUTOHIDE, AUTOHIDE_DEFAULT))
  const [autohideTrigger, setAutohideTrigger] = useState<number>(() =>
    getPref<number>(SIDEBAR_AUTOHIDE_TRIGGER, AUTOHIDE_TRIGGER_DEFAULT)
  )
  const [lcolRevealed, setLcolRevealed] = useState(false)
  const lcolRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onChanged = (): void => {
      setAutohide(getPref<boolean>(SIDEBAR_AUTOHIDE, AUTOHIDE_DEFAULT))
      setAutohideTrigger(getPref<number>(SIDEBAR_AUTOHIDE_TRIGGER, AUTOHIDE_TRIGGER_DEFAULT))
    }
    window.addEventListener(SIDEBAR_AUTOHIDE_EVENT, onChanged)
    return () => window.removeEventListener(SIDEBAR_AUTOHIDE_EVENT, onChanged)
  }, [])
  // 펼침/접힘 판정 — 커서 X 위치(창 안 mousemove) + 문서 이탈/창 blur.
  // 펼침: 가장자리 감지 폭 안. 접힘: 실제 패널 폭 + 여유(8px) 바깥. 폭 드래그 중엔 접지 않는다.
  // 커서가 창 밖(옆 모니터)으로 나가면 mousemove가 끊겨 마지막 상태가 얼어붙으므로,
  // 문서 mouseleave(300ms 유예 — 왼쪽 경계 살짝 넘었다 돌아올 때 안 깜빡)와 창 blur(즉시)로 접는다.
  // 포털 메뉴(ctx-menu·sconfirm)는 body 소속이라도 문서 안이라 문서 mouseleave에 안 걸린다.
  // 단, app-region:drag 띠(탐색기 .fxh·사이드바 .sb-top 등)는 OS가 타이틀바(비클라이언트)로
  // 취급해 커서가 올라가는 순간에도 문서 mouseleave가 발생한다 — 창 밖으로 나간 게 아니므로
  // leave 좌표가 드래그 띠 위면 무시한다. 안 그러면 헤더의 새로고침·숨김보기 버튼으로 가는
  // 길에 사이드바가 접혀버린다. 진짜 창 이탈은 좌표가 드래그 띠 밖(트리·본문)이라 그대로 접힌다.
  useEffect(() => {
    if (!autohide) {
      setLcolRevealed(false)
      return
    }
    // 접힘 판정은 '목표 폭' 기준 — 펼침 애니 도중 커서를 빨리 움직여도(현재 폭이 아직 작아도)
    // 중간에 접히지 않게. 안쪽 사이드바(.sidebar/.explorer)는 고정 폭이라 offsetWidth가 곧 목표 폭.
    let leaveTimer: ReturnType<typeof setTimeout> | undefined
    const onMove = (e: MouseEvent): void => {
      clearTimeout(leaveTimer)
      if (e.clientX <= autohideTrigger) setLcolRevealed(true)
      else if (!lcolDrag) {
        const inner = lcolRef.current?.firstElementChild as HTMLElement | null
        const w = inner?.offsetWidth || (lcolW ?? 242)
        if (e.clientX > w + 8) setLcolRevealed(false)
      }
    }
    // 창 드래그 띠 셀렉터 — styles.css의 -webkit-app-region:drag 선언과 짝 (버튼은 no-drag라
    // 커서가 버튼 위에 있는 동안엔 애초에 mouseleave가 안 난다)
    const DRAG_STRIPS = '.titlebar, .sb-top, .fxh, .chat-head, .ma-head'
    const onDocLeave = (e: MouseEvent): void => {
      if (lcolDrag) return
      const el = document.elementFromPoint(e.clientX, e.clientY)
      if (el?.closest(DRAG_STRIPS)) return // 드래그 띠 진입으로 인한 가짜 leave — 접지 않는다
      clearTimeout(leaveTimer)
      leaveTimer = setTimeout(() => setLcolRevealed(false), 300)
    }
    const onBlur = (): void => {
      if (lcolDrag) return
      clearTimeout(leaveTimer)
      setLcolRevealed(false)
    }
    window.addEventListener('mousemove', onMove)
    document.documentElement.addEventListener('mouseleave', onDocLeave)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('mousemove', onMove)
      document.documentElement.removeEventListener('mouseleave', onDocLeave)
      window.removeEventListener('blur', onBlur)
      clearTimeout(leaveTimer)
    }
  }, [autohide, autohideTrigger, lcolDrag, lcolW])
  // 감지 폭 미리보기 — 설정에서 슬라이더를 만지는 동안 왼쪽 가장자리에 그 폭만큼 띠를 띄운다.
  // active=false는 200ms 뒤 사라지게(다시 true가 오면 취소) — 드래그 중 잠깐의 leave에 안 깜빡.
  const [triggerPrev, setTriggerPrev] = useState<{ show: boolean; w: number }>({
    show: false,
    w: AUTOHIDE_TRIGGER_DEFAULT
  })
  const triggerPrevTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    const onPrev = (e: Event): void => {
      const d = (e as CustomEvent<AutohideTriggerPreviewDetail>).detail
      if (!d) return
      clearTimeout(triggerPrevTimer.current)
      if (d.active) setTriggerPrev({ show: true, w: d.value })
      else {
        setTriggerPrev((p) => ({ show: p.show, w: d.value ?? p.w }))
        triggerPrevTimer.current = setTimeout(() => setTriggerPrev((p) => ({ ...p, show: false })), 200)
      }
    }
    window.addEventListener(SIDEBAR_AUTOHIDE_TRIGGER_PREVIEW_EVENT, onPrev)
    return () => {
      window.removeEventListener(SIDEBAR_AUTOHIDE_TRIGGER_PREVIEW_EVENT, onPrev)
      clearTimeout(triggerPrevTimer.current)
    }
  }, [])
  // ` (백쿼트) 한 키 = 사이드바 ⟷ 탐색기 전환 — 글자가 들어가는 입력에서는 무시.
  // 멀티 뷰에서도 동작한다 — 그때 탐색기는 마지막으로 클릭(포커스)한 패널의 폴더를 보인다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== '`' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      const ae = document.activeElement as HTMLElement | null
      if (ae && (['INPUT', 'TEXTAREA', 'SELECT'].includes(ae.tagName) || ae.isContentEditable)) return
      e.preventDefault()
      toggleExplorer()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // 탐색기가 지금 보여주는 폴더(메인 작업 폴더 또는 참고 폴더의 절대 경로). '' = 아직
  // 보고가 없음 → cwd로 폴백. 채팅 입력의 @ 멘션이 이 폴더를 기준으로 파일을 뜨운다.
  const [explorerFolder, setExplorerFolder] = useState('')
  const onExplorerView = useEvent((folder: string) => setExplorerFolder(folder))
  // 멀티 뷰의 탐색기가 따라갈 패널 정보 — ActiveSession이 마지막으로 클릭(포커스)한
  // 패널의 폴더·변경 파일·핸들러를 보고한다. 세션 전환 시 새 마운트가 곧바로 덮어쓰므로
  // 언마운트에서 비우지 않는다(비우면 전환마다 사이드바로 한 번 튕겼다 돌아온다).
  const [multiExp, setMultiExp] = useState<MultiExplorerInfo | null>(null)
  // bumped when a run finishes → the explorer re-reads its expanded folders, so files
  // the agent just created/deleted show up without a manual refresh
  const [fsTick, setFsTick] = useState(0)
  // false until saved chats are loaded — gates persistence so we never overwrite
  // the saved file with the default blank chat before hydration finishes
  const [hydrated, setHydrated] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  // also track the scroll viewport as state, not just a ref: the chat pane is unmounted
  // and rebuilt on a multi-agent mode round trip, so listener effects must re-bind to the
  // fresh element (a ref's `.current` change alone wouldn't re-run them)
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  const chatZoom = useZoom('chat.zoom')
  const chatScrollRef = useMemo(() => mergeRefs(scrollRef, setScrollEl, chatZoom.ref), [chatZoom.ref])
  const composerRef = useRef<HTMLTextAreaElement>(null)

  // rate-limit usage: 마운트 + 이 채팅의 실행 계정이 바뀔 때(계정 picker·채팅 전환) —
  // 컨텍스트 한도는 "이 채팅이 실제로 소비할 계정" 기준이어야 해서 계정을 함께 넘긴다
  useEffect(() => {
    window.api.getUsage(false, picker.account).then(setUsage).catch(() => {})
  }, [picker.account])
  useEffect(() => {
    window.api.apiConfig.get().then(setApiCfg).catch(() => {})
  }, [])

  // 설정 모달을 닫으면 API 설정을 다시 읽는다 — 방금 키를 등록/삭제했을 수 있다.
  // 키가 사라졌으면 API 모드도 끈다(키 없는 API 모드는 실행이 실패하므로).
  // 사용량도 다시 — Account 탭에서 활성 계정을 전환했을 수 있다(토큰이 바뀌면
  // 메인 캐시가 자동 미스라 새 계정 수치가 바로 온다).
  const settingsWasOpen = useRef(false)
  useEffect(() => {
    if (settingsOpen) {
      settingsWasOpen.current = true
      return
    }
    // 마운트 직후(열린 적 없음)엔 건너뛴다 — 위 마운트 이펙트(getUsage·apiConfig)와
    // 같은 요청을 한 번 더 쏘던 중복 발사 제거. 진짜 "열었다 닫음" 전이에서만 재조회.
    if (!settingsWasOpen.current) return
    settingsWasOpen.current = false
    window.api.getUsage(true, picker.account).then(setUsage).catch(() => {})
    window.api.apiConfig
      .get()
      .then((s) => {
        setApiCfg(s)
        // 두 엔진 키가 모두 사라졌을 때만 API 모드를 강제로 끈다 — 한쪽 키만 있어도
        // 그 엔진 실행은 API 과금이 유효하다 (키 없는 엔진은 실행 시 엔진이 안내한다)
        if (!s.hasKey && !s.hasOpenaiKey) {
          setApiMode((on) => {
            if (on) setPref('api.mode', false)
            return on ? false : on
          })
        }
      })
      .catch(() => {})
  }, [settingsOpen])

  // 설정 → API 탭 열기 — 키 없이 API 과금을 고른 화면들이 공용으로 쓰는 가드
  const openApiSettings = useEvent(() => {
    setSettingsView('api')
    setSettingsOpen(true)
  })

  // 세션 창(추가 채팅)에서 키 없이 API 과금을 고르면 — 그 창엔 설정 모달이 없어서
  // 메인 프로세스가 이 창을 앞으로 가져오며 보내는 요청 — 설정 → API 탭을 연다.
  // ?. 가드: dev HMR로 렌더러만 새 코드가 들어오면 구 preload엔 이 함수가 없다 —
  // 마운트 효과라 가드가 없으면 TypeError 하나가 앱 전체를 에러 카드로 만든다(실측).
  useEffect(() => window.api.onApiSettingsRequested?.(openApiSettings), [openApiSettings])

  // 컴포저의 과금 picker(구독/API) — API 선택인데 그 엔진의 키가 없으면 설정 → API 탭을
  // 열어 안내한다 (Anthropic 엔진=Anthropic 키, Codex 엔진=OpenAI 키)
  const onApiModeChange = useEvent((next: boolean, engine?: EngineId) => {
    const ready = engine === 'codex' ? !!apiCfg?.hasOpenaiKey : !!apiCfg?.hasKey
    if (next && !ready) {
      openApiSettings()
      return
    }
    setApiMode(() => {
      setPref('api.mode', next)
      return next
    })
  })

  // Fable 5 정책 거부(claude)·모델 수용량 초과(codex) → 엔진이 폴백 모델로 전환·재시도한
  // 경우(경고 배너는 스레드에 표시됨), 이 채팅의 모델 picker도 따라 바꿔서 다음
  // 메시지부터 폴백 모델로 바로 가게 한다 — 안 바꾸면 매번 오류→전환을 반복한다.
  useEffect(
    () =>
      window.api.onEngineEvent((e) => {
        if (e.type !== 'model-fallback') return
        if (e.engine === 'codex') {
          setPicker((p) => (p.codexModel === e.toModel ? p : { ...p, codexModel: e.toModel }))
          return
        }
        const next = pickerModelOf(e.toModel)
        if (next) setPicker((p) => (p.model === next ? p : { ...p, model: next }))
      }),
    []
  )

  useEffect(() => {
    if (state.status === 'done' || state.status === 'error') {
      // fresh — 추가 크레딧 잔액이 방금 실행의 소비를 바로 반영하게 (5분 캐시 우회)
      window.api.getUsage(true, picker.account).then(setUsage).catch(() => {})
      // API 모드 누적 사용액(전역)도 갱신 — 남은 예산 링이 실행 직후 바로 맞아떨어지게
      window.api.apiConfig.get().then(setApiCfg).catch(() => {})
      setFsTick((t) => t + 1)
    }
  }, [state.status])

  // ── 한도 자동 이어서 (useLimitResume 공용 훅 — PoC: scripts/poc-limit-resume.mjs) ──
  // 본채팅은 리듀서 하나를 채팅들이 갈아타는 구조라 소유 키=activeChatId. canSend의
  // unloaded 가드 덕에 다른 채팅을 보다 돌아온 경우도 스냅샷 되읽기가 끝난 다음에야
  // 보낸다(readyDep=chats — 되읽기 완료가 effect를 다시 태운다).
  const limitResume = useLimitResume({
    state,
    busy,
    enabled: autoResume,
    apiMode,
    engine: picker.engine === 'codex' ? 'codex' : 'claude',
    account: picker.engine === 'codex' ? picker.codexAccount : picker.account,
    fable: picker.engine !== 'codex' && picker.model === 'fable',
    holdKey: activeChatId,
    send: (p) => void runPrompt(p, { keepDraft: true }),
    canSend: (h) => !chats.find((c) => c.id === h.key)?.unloaded,
    readyDep: chats,
    // ★ R3 — 재개 주체는 하나다(m-logic P6). `chat:status`가 「엔진이 관장한다」고
    // 말하면(배선 R4의 `resumeOwner`, 없으면 대기표의 존재) 렌더러 기계는 장전·타이머·
    // 소진을 전부 멈추고 화면은 엔진의 표를 그린다 — 안 그러면 리셋 시각에 두 번 나간다.
    managed: engineOwnsResume(chatStatus[activeChatId])
  })

  // 재시작 복원 — 한도를 기다리다 앱을 껐다 켜는 흐름이 흔해 대기표를 ui-prefs에
  // 살린다. 활성 채팅 것만 되살린다(비활성 채팅 표는 전환·로드 조건이 얽혀 위험 대비
  // 이득이 없다) — 24시간 만료·형태 위생은 sanitizeHold가 본다.
  useEffect(() => {
    if (!hydrated) return
    const saved = sanitizeHold(getPref<unknown>('limitResume.hold', null), Date.now())
    if (saved && saved.key === activeChatIdRef.current) limitResume.setHold(saved)
    else if (saved) delPref('limitResume.hold')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated])
  // 대기표 영속 — ready(풀림 표시)는 저장하지 않는다: 복원 후 발화 재검증이 다시 판정한다.
  // 위 복원 effect가 먼저 선언돼 있어야 한다 — 순서가 뒤집히면 첫 실행의 delPref가
  // 복원이 읽기 전에 저장본을 지운다.
  useEffect(() => {
    if (!hydrated) return
    if (limitResume.hold) setPref('limitResume.hold', { ...limitResume.hold, ready: undefined })
    else delPref('limitResume.hold')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limitResume.hold, hydrated])

  // restore saved conversations on mount, then load the active chat's snapshot
  // into the live session so it picks up right where it left off.
  // 1.x 채팅 모드(chat-talk.json)의 대화는 일반 목록 뒤로 1회 편입한다 — 모드 자체가
  // 은퇴했으므로(2.0), 편입 후 원본 파일은 비워 다음 실행에서 중복 편입되지 않게 한다.
  useEffect(() => {
    let alive = true
    let landed = false // 아래 finally의 폴백 착지 판정 (저장본이 없으면 착지가 안 돈다)
    Promise.all([window.api.getChats().catch(() => null), window.api.talk.getState().catch(() => null)])
      .then(([raw, talkRaw]) => {
        if (!alive) return
        const data = raw as PersistedChats | null
        // guard each snapshot against missing fields from an older/corrupt file —
        // including the per-chat folder, so restoring an old chat never sets undefined.
        // 활성 채팅만 스냅샷을 통째로 살린다 — 비활성은 자리표시자+unloaded로 두고 전환 때
        // 디스크에서 되읽는다(모든 채팅의 전체 스냅샷 상주가 렌더러 힙을 GB대로 키웠다)
        const bootActiveId =
          data && Array.isArray(data.chats) && data.chats.length
            ? ((data.chats.find((c) => c?.id === data.activeChatId) ?? data.chats[0])?.id ?? '')
            : ''
        const restored =
          data && Array.isArray(data.chats) && data.chats.length
            ? data.chats.map((c) => {
                // main이 부팅 페이로드를 경량화해 보낸 비활성 채팅(unloaded 마커, 스냅샷 없음)은
                // 그대로 마커로 둔다 — keep으로 오판하면 "내용 있는 채팅"이 빈 채팅으로 둔갑한다
                const keep = !c.unloaded && (c.id === bootActiveId || !(c.snapshot as SessionState | undefined)?.messages?.length)
                return {
                  ...c,
                  manualCwd: c.manualCwd ?? '',
                  refDirs: sanitizeRefDirs(c.refDirs),
                  picker: sanitizePicker(c.picker),
                  snapshot: keep ? sanitizeSnapshot(c.snapshot) : initialSessionState,
                  unloaded: keep ? undefined : true
                }
              })
            : null
        const talk = talkRaw as { chats?: Partial<ChatMeta>[] } | null
        const have = new Set((restored ?? []).map((c) => c.id))
        const migrated = (Array.isArray(talk?.chats) ? talk!.chats : [])
          .filter(
            (c): c is Partial<ChatMeta> & { id: string } =>
              !!c && typeof c === 'object' && typeof c.id === 'string' && !have.has(c.id) &&
              (!!c.title || !!(c.snapshot as SessionState | undefined)?.messages?.length)
          )
          .map((c) => ({
            id: c.id,
            title: c.title ?? '',
            custom: !!c.custom,
            snapshot: sanitizeSnapshot(c.snapshot),
            manualCwd: '', // 순수 대화엔 폴더가 없었다 — 첫 전송 때 폴더를 고른다
            picker: sanitizePicker(c.picker),
            draft: c.draft,
            draftImages: c.draftImages
          }))
        if (restored) {
          const active = restored.find((c) => c.id === data!.activeChatId) ?? restored[0]
          // 공유 최근 폴더 콜드 스타트 — 비어 있으면 기존 채팅들의 폴더로 1회 시드
          seedRecentDirs(restored.map((c) => ({ p: c.manualCwd, t: c.updatedAt ?? 0 })))
          setChats([...restored, ...migrated])
          // 부팅도 착지점이다 — 별칭 계층이 첫 전송을 이 채팅으로 라우팅해야 한다(§6.2)
          // ★ R2: 큐 소유자도 여기서 선다(부팅 직후의 드레인 게이트가 이 값을 본다)
          queueOwnerRef.current = active.id
          landed = true
          landActiveChat(active.id)
          load(active.snapshot)
          setManualCwd(active.manualCwd ?? '')
          setRefDirs(active.refDirs ?? [])
          setPicker(active.picker)
          // 닫기 전에 쓰다 만 초안(텍스트·첨부 이미지)도 그대로 돌아온다
          setInput(active.draft ?? '')
          setImages(active.draftImages ?? [])
        } else if (migrated.length) {
          setChats((cur) => [...cur, ...migrated])
        }
        if (migrated.length) window.api.talk.saveState({ version: 1, chats: [], activeChatId: '' }).catch(() => {})
      })
      .catch(() => {})
      .finally(() => {
        if (!alive) return
        // ★ R2 (잔여 착지점 대조) — 저장본이 없는 첫 실행·읽기 실패에서는 위의 착지가
        // 안 돈다. 그러면 `chats:set-active`가 한 번도 안 나가고, 첫 전송이 저장 디바운스
        // (600ms)보다 빠를 때 별칭 계층이 **빈 주소**로 라우팅한다. 부팅도 착지점이다.
        // (착지가 이미 돌았으면 건드리지 않는다 — activeChatIdRef는 아직 커밋 전이라
        //  여기서 다시 부르면 **낡은 id**가 나간다.)
        if (!landed) {
          queueOwnerRef.current = activeChatIdRef.current
          landActiveChat(activeChatIdRef.current)
        }
        setHydrated(true)
      })
    return () => {
      alive = false
    }
  }, [])

  // persist the chat list (debounced) — the active chat's live session is folded
  // back in, and ephemeral fields are stripped, so a restart resumes cleanly
  useEffect(() => {
    if (!hydrated) return
    // 스냅샷 조립도 타이머 안에서 — 이 이펙트는 스트리밍 토큰마다 다시 돌므로, 밖에서
    // 조립하면 매 토큰이 모든 채팅의 snapshotForPersist를 물게 된다(600ms 안에 취소될
    // 작업인데도). 안으로 옮기면 토큰당 비용은 setTimeout 예약뿐이다.
    const t = setTimeout(() => {
      // ★ 3.0 M-UX — 이 저장이 **무엇을 담았는지** 기억해 둔다. 아래 언로드 스윕이
      // "디스크에 닿았으니 메모리에서 내려도 된다"를 근거로 도는데, 저장이 도는 사이
      // (chat:event 수집기의 600ms 플러시 등으로) 스냅샷이 더 자라 있으면 그 최신분은
      // 디스크에 없다 — 내리는 순간 그 꼬리가 증발한다. 참조가 바뀐 채팅은 건너뛴다.
      const sentSnaps = new Map(chats.map((c) => [c.id, c.snapshot]))
      const list: PersistedChat[] = chats.map(({ queue: _q, ...c }) =>
        c.id === activeChatId
          ? { ...c, snapshot: snapshotForPersist(state), unloaded: undefined, manualCwd, refDirs, picker, draft: input, draftImages: images }
          : c.unloaded
            ? { ...c, snapshot: undefined } // 스냅샷은 디스크에 있다 — 메타만 보내 파일의 것을 지키게(chats.ts)
            : { ...c, snapshot: snapshotForPersist(c.snapshot) }
      )
      const payload: PersistedChats = { version: CHATS_VERSION, chats: list, activeChatId }
      window.api.saveChats(payload)
        .then(() => {
          // 디스크에 닿았다 — 비활성 채팅의 스냅샷은 내려도 된다(전환 때 되읽음). 저장
          // 사이에 활성이 바뀌었을 수 있으니 ref로 "지금" 활성만 지킨다.
          setChats((cur) => {
            let changed = false
            const next = cur.map((c) => {
              // ★ 자리 밖에서 도는 채팅은 내리지 않는다 — 스냅샷을 자리표시자로 바꾸면
              // chat:event 수집기가 접을 바탕을 잃는다(그 대화의 꼬리가 통째로 증발)
              if (
                c.id === activeChatIdRef.current ||
                c.unloaded ||
                bgSnapRef.current.has(c.id) ||
                c.snapshot.messages.length === 0 ||
                c.snapshot !== sentSnaps.get(c.id) // 저장 이후에 더 자란 스냅샷 — 아직 디스크에 없다
              )
                return c
              changed = true
              return { ...c, snapshot: initialSessionState, unloaded: true }
            })
            return changed ? next : cur
          })
        })
        .catch(() => {})
    }, 600)
    return () => clearTimeout(t)
  }, [hydrated, chats, activeChatId, state, manualCwd, refDirs, picker, input, images])

  const addImagePaths = (paths: string[]): void => {
    if (paths.length) setImages((a) => Array.from(new Set([...a, ...paths])))
  }
  const addImagesFromPicker = async (): Promise<void> => {
    addImagePaths(await window.api.pickAttachments())
  }
  const openViewer = useEvent((imgs: string[], index: number) => setViewer({ images: imgs, index }))

  // A file dropped anywhere but the composer would otherwise make the window navigate to
  // it (the main process's will-navigate guard allows file:// URLs). Neutralize the browser
  // default outside the composer; drops onto the composer fall through to its own handler.
  useEffect(() => {
    const guard = (e: DragEvent): void => {
      if ((e.target as HTMLElement | null)?.closest?.('.composer')) return
      e.preventDefault()
    }
    window.addEventListener('dragover', guard)
    window.addEventListener('drop', guard)
    return () => {
      window.removeEventListener('dragover', guard)
      window.removeEventListener('drop', guard)
    }
  }, [])

  // 스레드 바닥 따라가기 — 래치·점프 버튼·스트리밍 rAF 고정을 훅이 소유한다
  // (본채팅·추가 채팅 공용 — Chat.tsx의 useThreadFollow)
  const follow = useThreadFollow(scrollEl, busy)
  // 꼬리 윈도잉 — 긴 세션의 DOM 상주를 꼬리 N개로 제한 (채팅 전환 시 꼬리로 리셋)
  const twin = useThreadWindow(scrollEl, state.messages.length, activeChatId)

  // switching/opening a chat always re-pins to the bottom (runs before the
  // message-arrive effect below, so the freshly loaded thread lands at the bottom)
  useEffect(() => {
    follow.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChatId])

  // auto-stick to bottom when new messages/thinking arrive — but only while the
  // follow latch is on (scrolling up to read history pauses this)
  useEffect(() => {
    follow.snapIfStuck()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.messages, state.thinkingText])

  // 대화 스레드 ↑/↓ 제스처 — ↑는 스트리밍 중 rAF 바닥 고정이 도로 끌어내리지 않게 고정을
  // 풀고(재고정 150ms 가드도 무장), ↓는 '맨 아래로' 버튼과 같은 규칙으로 다시 고정한다
  const chatGestures: GestureAction[] = [
    // 맨 위로 = 전체 히스토리 의도 — 윈도를 먼저 다 펼치고 올라간다 (센티널 연쇄 로드 방지)
    { pattern: 'U', label: t('맨 위로', 'Scroll to top'), run: () => { twin.showAll(); follow.scrollTop() } },
    { pattern: 'D', label: t('맨 아래로', 'Scroll to bottom'), run: () => follow.jumpBottom() },
    sessionWindowGesture(),
    // clearConversation은 아래에서 선언 — 배열 생성 시점(TDZ)을 피해 실행 시점에 참조한다
    clearGesture(() => clearConversation())
  ]

  const cwd = manualCwd || ''
  // Git 카드의 기준 폴더 — 단일 뷰는 이 채팅의 작업 폴더, 멀티 뷰는 탐색기가 따라가는
  // (마지막으로 클릭한) 패널의 폴더. 탐색기 스트립과 카드가 같은 폴더를 본다.
  const gitCwd = mode === 'multi' ? multiExp?.cwd ?? '' : cwd
  // @ 멘션의 기준 폴더 — 탐색기가 떠 있고 다른 뷰(Verse digest)를 보고 있으면 그 폴더,
  // 아니면 작업 폴더. 탐색기가 내려가 있으면 보고값이 낡을 수 있어 cwd로 되돌린다.
  const mentionBase = (explorerOpen && explorerFolder) || cwd

  // 프로젝트가 정해지면 분석 서버/컴파일 DB를 미리 데워 둔다 — 첫 파일을 열 때
  // 서버 워밍을 기다리지 않도록(특히 C#/UE). 폴더가 바뀔 때마다 한 번.
  useEffect(() => {
    if (cwd) window.api.lsp.prewarm(cwd).catch(() => {})
  }, [cwd])

  const activeChat = chats.find((c) => c.id === activeChatId)
  // a fresh chat with no messages and no title — it never appears in the recent
  // list; the chat area shows the welcome screen instead
  const activeEmpty = state.messages.length === 0 && !activeChat?.title

  // 포커스 밖 알림 — 이 창이 비포커스일 때 턴 종료/승인/질문을 커서 모니터 토스트로.
  // 단일 뷰는 실행 중 채팅 전환이 막혀 있어 활성 채팅 하나만 감시하면 충분하다.
  useTurnNotify(state, busy, activeChat?.title ?? '', { surface: 'single', id: activeChatId })
  // 토스트 클릭 라우팅 — 메인이 창을 앞으로 가져온 뒤 보낸다: 뷰 전환 + 대상 선택
  const onNotifyJump = useEvent((t: NotifyTarget) => {
    if (t.surface === 'multi') {
      if (mode !== 'multi') switchMode('multi')
      multi.selectSession(t.id)
    } else if (t.surface === 'single') {
      if (mode !== 'single') switchMode('single')
      if (t.id && t.id !== activeChatId) selectChat(t.id)
    }
  })
  // ?. 가드: dev HMR로 렌더러만 갈리면 구 preload엔 notify가 없다 (onApiSettingsRequested와 동일)
  useEffect(() => window.api.notify?.onJump?.(onNotifyJump) ?? undefined, [onNotifyJump])

  // ── ★ 3.0 M-UX — 활성 채팅 착지 (ux-chat-unify §6.2 U3, chats:set-active) ─────
  //
  // 별칭 계층(`claude:*` → `chat:*`)은 인자에 chatId가 없어서 **그 순간의 활성 채팅**으로
  // 명령을 라우팅한다. 그 진실 소스가 `chats:set-active`다 — `chats:save`의 activeChatId는
  // 600ms 디바운스라 "전환 직후 전송"에서 낡은 값이 가고, 그러면 실행이 남의 ChatRuntime
  // (정체성·큐·라이브 원장·계정 CONFIG_DIR)에 붙는다.
  // 렌더러 몫은 **전환 착지점마다 한 줄**이고, 착지점은 이 함수 하나로 모았다.
  const landActiveChat = (id: string): void => {
    setActiveChatId(id)
    setActiveChat(id)
  }

  // ── ★ 3.0 M-UX — 자리 밖에서 도는 채팅의 꼬리를 받는다 (스펙 ⑥의 안전망) ────────
  //
  // 실행 중 채팅 전환을 허용하면(아래 selectChat) 떠난 채팅의 스트림은 메인 창에 더 이상
  // 안 온다 — Rust가 `engine:event`를 **활성 채팅으로 게이팅**하기 때문이다
  // (src-tauri/src/engine/hub.rs `fanout`). 게이팅이 없으면 남의 이벤트가 지금 보고 있는
  // 스레드에 섞여 들어가므로 그 설계가 옳고, 대신 **누군가 꼬리를 받아 둬야** 돌아왔을 때
  // 대화가 잘려 있지 않다. 통합 봉투 `chat:event { chatId, event }`가 전 창에 나가므로
  // 그걸 받아 그 채팅의 스냅샷에 같은 리듀서로 접는다.
  //
  // 규약 셋:
  //  · 대상은 "실행 중에 떠난 채팅"뿐이다(집합에 없는 chatId는 무시) — 활성 채팅은
  //    라이브 리듀서가 소유하므로 절대 이중 적용되지 않는다.
  //  · 스냅샷은 ref에 접고(토큰마다 setState 금지 — 스트리밍 fps), 600ms마다 스토어에 민다.
  //  · 돌아오면(restore) ref의 최신 스냅샷으로 착지한다 — 플러시 대기분도 안 잃는다.
  const bgSnapRef = useRef<Map<string, SessionState>>(new Map())
  const bgTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  // 추적 집합의 **렌더 가능한 사본**. 삭제 가드("도는 대화는 못 지운다")와 사이드바
  // 실행 배지가 ref를 직접 읽으면 멤버십 변화에 다시 그려지지 않는다(ref는 렌더 신호가
  // 아니다) — 마지막 대화가 정착한 순간에도 배지가 남고 가드가 안 풀린다.
  const [bgIds, setBgIds] = useState<string[]>([])
  // ★ R4 — `chat:verdict`(자리 밖 대화의 거부) 토스트 스택 · `chat:identity`(폴백 배너 +
  // 되돌리기). 둘 다 R3까지 **구독자 0**이던 채널의 착지점이다(크리틱 R14 §4.3-M2·M3).
  const [verdictToasts, setVerdictToasts] = useState<VerdictToastItem[]>([])
  const [identNotices, setIdentNotices] = useState<Record<string, IdentityNotice>>({})
  const syncBgIds = (): void => {
    const ids = [...bgSnapRef.current.keys()]
    setBgIds((prev) => (prev.length === ids.length && prev.every((v, i) => v === ids[i]) ? prev : ids))
  }
  const bgFlush = useEvent(() => {
    const map = bgSnapRef.current
    if (map.size === 0) {
      clearInterval(bgTimerRef.current)
      bgTimerRef.current = undefined
      return
    }
    const batch = new Map(map)
    setChats((list) =>
      list.map((c) => {
        const snap = batch.get(c.id)
        return snap && snap !== c.snapshot ? { ...c, snapshot: snap, unloaded: undefined } : c
      })
    )
    // 정착한(더 안 도는) 채팅은 **밀어 넣은 뒤** 추적을 놓는다 — 순서가 뒤집히면
    // 마지막 턴의 꼬리가 스토어에 안 닿는다
    for (const [id, snap] of batch) {
      if (snap.status === 'working' || snap.status === 'analyzing') continue
      // ★ R2 — 이 채팅의 턴이 끝났다. **이 채팅이** 예약해 둔 것이 있으면 지금이 발사
      // 시각이고, 발사처는 당연히 이 채팅이다(스펙 ⑥이 열어 둔 문 뒤의 소유권).
      // 드레인이 새 턴을 시작하면 추적을 유지한다 — 놓으면 그 턴의 꼬리를 또 잃는다.
      if (drainBgQueue(id, snap)) continue
      map.delete(id)
    }
    syncBgIds()
  })
  const bgTrack = (id: string, snap: SessionState): void => {
    bgSnapRef.current.set(id, snap)
    if (!bgTimerRef.current) bgTimerRef.current = setInterval(bgFlush, 600)
    syncBgIds()
  }
  const bgUntrack = (id: string): void => {
    if (bgSnapRef.current.delete(id)) syncBgIds()
  }
  useEffect(() => {
    const off = onChatEvent((id, event) => {
      const cur = bgSnapRef.current.get(id)
      if (!cur) return // 추적 대상이 아니다 (활성 채팅·차가운 채팅)
      // ★ R4 — `engineAction`을 지나야 `user-echo`가 말풍선이 된다. 자리 밖 채팅의
      // 예약 드레인·한도 재개가 정확히 이 경로라, 여기서 안 접으면 돌아왔을 때
      // "내가 보낸 적 없는 답"만 있다(크리틱 R14 §5-F5).
      bgSnapRef.current.set(id, sessionReducer(cur, engineAction(event)))
    })
    return () => {
      off()
      clearInterval(bgTimerRef.current)
      bgTimerRef.current = undefined
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── ★ R2/R3 — 전 채팅 경량 상태 (`chat:status`) + **F12 따라잡기** ────────────
  //
  // 이 채널이 없으면 "지금 화면에 없는 대화가 승인 카드를 띄운 채 멈춰 있다"를 목록이
  // 말할 방법이 없다(§2.2-5). 함정은 **첫 REPLACE가 구독자보다 이르다**는 것이다 —
  // `engine::boot()`이 창 생성 전에 쏘고 이후 전이가 없으면 다시 안 온다(배선 R2 F12).
  //
  // ★ R3 — 따라잡기를 **리스너가 붙은 뒤로** 옮겼다(`onChatStatus`의 `onReady`).
  // R2는 구독과 동시에 쏘았는데 `listen()`은 비동기 등록이라, 그 사이에 나간 REPLACE는
  //   ① 리스너가 아직 없어서 못 받고 ② 따라잡기 응답이 그보다 **먼저** 오면 그 값도 낡다
  // → 두 겹을 다 통과하는 창이 남아 있었다. 등록 후에 물으면 그 창이 닫힌다:
  //   등록 전에 나간 것은 따라잡기가 줍고, 등록 후에 나간 것은 리스너가 받는다.
  //
  // 병합은 "비어 있는 키만"이 아니라 **`updatedAt` 비교**다 — 따라잡기 응답이 늦게 와도
  // 그 사이 도착한 더 새 REPLACE를 되돌리지 않는다(R2는 존재 여부만 봐서, 첫 REPLACE가
  // **일부 채팅만** 실은 경우 나머지를 낡은 값으로 채울 수 있었다).
  useEffect(() => {
    const catchUp = (): void => {
      void window.api
        .getChats()
        .then((raw) => {
          const statuses = (raw as { statuses?: Record<string, ChatStatusLite> } | null)?.statuses
          if (!statuses) return
          setChatStatus((cur) => {
            const merged = { ...cur }
            let changed = false
            for (const [id, v] of Object.entries(statuses)) {
              if (!v) continue
              const have = merged[id]
              if (have && (have.updatedAt ?? 0) >= (v.updatedAt ?? 0)) continue
              merged[id] = v
              changed = true
            }
            return changed ? merged : cur
          })
        })
        .catch(() => {})
    }
    const off = onChatStatus((rows) => {
      const next: Record<string, ChatStatusLite> = {}
      for (const r of rows) if (r?.chatId) next[r.chatId] = r
      setChatStatus(next)
      // ★R28 ACCT §3 — 같은 REPLACE가 「계정 → 살아 있는 자리」 역인덱스의 재료다.
      // 판정 소스가 하나여야 picker·설정 목록·다른 창이 같은 답을 낸다.
      putChatStatuses(rows)
    }, catchUp)
    return off
  }, [])

  // ── ★ R3 — 창 자리 목록 (`chat:windows`) ────────────────────────────────────
  //
  // 셸은 창을 열고 닫을 때마다 이 REPLACE를 낸다(배선 R3 §R3.4). 같은 사실을 옛 이름
  // (`session-wins:changed`)으로도 내지만 그쪽 페이로드에는 **창 라벨·포커스**가 없고,
  // "영속됐지만 창이 없는 추가 채팅"까지 섞여 있어 *지금 창이 떠 있는가*를 못 말한다.
  // 사이드바 「창」 칩의 진실은 이쪽이다. 따라잡기는 `win:chat-list`(요청/응답).
  useEffect(() => {
    const catchUp = (): void => {
      void listChatWindows().then((slots) => {
        // 그 사이에 REPLACE가 왔으면 그것이 더 새 사실이다 — 빈 목록으로만 덮는다
        setWinSlots((cur) => (cur.length ? cur : slots))
      })
    }
    return onChatWindows(setWinSlots, catchUp)
  }, [])

  // ── ★ R2 — 정착 사유 (`chat:run-state.settled[]`) ───────────────────────────
  // 셸은 사유(`stream_closed:externalkill` · `watchdog:none` …)를 실어 보내는데 R1엔
  // 읽는 쪽이 없었다. 없으면 CLI가 밖에서 죽어도 도구 행 스피너가 영원히 돈다.
  useEffect(() => onChatRunState((p) => noteSettled(p.settled)), [])

  // ── ★ R2 — 자리 밖 채팅의 예약 드레인 (`chat:run`) ──────────────────────────
  //
  // 활성 채팅의 드레인은 아래 effect가 `runPrompt`로 한다(라이브 리듀서가 말풍선·busy를
  // 소유하므로). 자리 밖 채팅은 그 리듀서가 없으니 두 가지를 직접 해야 한다:
  //   ① **주소가 있는 채널로 발사** — `chat:run{chatId}`. 별칭(`claude:run`)으로 쏘면
  //      "그 순간의 활성 채팅"으로 라우팅돼 남의 대화에 들어간다(§2-① 그 사고).
  //   ② 사용자 말풍선을 그 채팅의 **배경 스냅샷에 접는다** — 돌아왔을 때 자기가 예약한
  //      문장이 스레드에 있어야 한다. 답변은 `chat:event` 수집기가 이어서 접는다.
  // 폴더를 모르는 채팅(첫 전송 전)은 발사하지 않는다 — 배경에서 폴더 선택 창을 띄울 수
  // 없다. 그 예약은 큐에 남고 사용자가 돌아오면 평소 경로로 나간다.
  const chatsRef = useRef<ChatMeta[]>(chats)
  chatsRef.current = chats
  const drainBgQueue = (id: string, snap: SessionState): boolean => {
    const chat = chatsRef.current.find((c) => c.id === id)
    const next = chat?.queue?.[0]
    if (!chat || !next) return false
    if (limitResume.holdRef.current?.key === id) return false // 한도 대기표 — 지금 보내도 막힌다
    const dir = chat.manualCwd || snap.session?.cwd || ''
    if (!dir) return false
    setChats((list) => list.map((c) => (c.id === id ? { ...c, queue: c.queue?.slice(1), updatedAt: Date.now() } : c)))
    // 배경 스냅샷에 사용자 말풍선 + '분석 중' 표식을 접는다(활성 경로의 begin과 같은 리듀서)
    const cmd = commandOf(next.text)
    bgSnapRef.current.set(
      id,
      sessionReducer(snap, { type: 'begin', text: next.text, time: nowTime(), command: cmd, images: next.images })
    )
    void runChat(id, buildRunRequest({
      text: next.text,
      images: next.images,
      picker: next.picker,
      cwd: dir,
      refDirs: chat.refDirs ?? [],
      session: snap.session,
      apiMode
    }))
    return true
  }

  // snapshot the live session into the currently active chat. 빈 채팅도 버리지 않고
  // 그대로 저장한다 — 새 채팅에서 골라둔 모델·모드·계정(picker)·폴더·초안이 다른 채팅에
  // 다녀와도 남아 있게. 사이드바 목록엔 원래 안 보이고(chatSummaries가 거름), 새로
  // 만드는 대신 createChat이 재사용하므로 빈 채팅은 여전히 최대 1개다.
  const saveActive = (list: ChatMeta[]): ChatMeta[] =>
    list.map((c) =>
      c.id === activeChatId
        ? // ★ R2 — 예약 큐도 초안과 같이 접어 넣는다. 이게 없으면 떠나는 순간 A의 예약이
          // 화면 state에만 남아 다음 착지에서 **B의 것으로 오인**된다(§2-① misroute).
          { ...c, snapshot: state, unloaded: undefined, manualCwd, refDirs, picker, draft: input, draftImages: images, queue }
        : c
    )

  // load a chat's saved snapshot into the live session + restore its directory,
  // its own 모델·effort·모드 selection and any unsent composer draft.
  // unloaded 채팅(스냅샷이 메모리에 없음)은 디스크에서 되읽은 뒤 착지한다 — 전환 연타로
  // 지연 로드가 겹치면 seq 가드로 마지막 요청만 이긴다(동기 전환도 진행 중인 로드를 무효화).
  const restoreSeq = useRef(0)
  // ★ R4 — 자리 밖 대화의 거부 사유 대기열(`chat:verdict`). 그 대화가 열릴 때 접힌다.
  const pendingVerdictRef = useRef<Map<string, { text: string; blocked: boolean; time: string }[]>>(new Map())
  const restore = (c: ChatMeta): void => {
    const land = (raw: SessionState): void => {
      // 열리는 순간이 이 대화의 "사유를 접을 자리"다 — 스냅샷이 이제야 손에 있다
      const pend = pendingVerdictRef.current.get(c.id)
      let snap = raw
      if (pend?.length) {
        pendingVerdictRef.current.delete(c.id)
        snap = pend.reduce((s, v) => sessionReducer(s, { type: 'verdict', text: v.text, blocked: v.blocked, time: v.time }), raw)
        setChats((list) => list.map((x) => (x.id === c.id ? { ...x, snapshot: snap, unloaded: undefined } : x)))
      }
      load(snap)
      setManualCwd(c.manualCwd)
      setRefDirs(c.refDirs ?? [])
      setPicker(c.picker ?? DEFAULT_PICKER)
      setInput(c.draft ?? '')
      setImages(c.draftImages ?? [])
      // ★ R2 — 큐 소유권 이전. 이 두 줄이 "예약은 대화의 것"이라는 불변식의 착지점이다.
      setQueue(chatsRef.current.find((x) => x.id === c.id)?.queue ?? c.queue ?? [])
      queueOwnerRef.current = c.id
      landActiveChat(c.id)
    }
    // ★ 자리 밖에서 돌던 채팅으로 돌아온다 — ref의 최신 스냅샷이 스토어보다 새롭다
    // (플러시는 600ms 간격이라 최대 그만큼 앞선다). 착지와 동시에 추적을 놓는다.
    const bg = bgSnapRef.current.get(c.id)
    if (bg) {
      bgUntrack(c.id)
      restoreSeq.current++
      setChats((list) => list.map((x) => (x.id === c.id ? { ...x, snapshot: bg, unloaded: undefined } : x)))
      land(bg)
      return
    }
    if (!c.unloaded) {
      restoreSeq.current++
      land(c.snapshot)
      return
    }
    const seq = ++restoreSeq.current
    window.api
      .loadChat(c.id)
      .then((raw) => {
        if (seq !== restoreSeq.current) return
        const snap = sanitizeSnapshot((raw as { snapshot?: unknown } | null)?.snapshot)
        setChats((list) => list.map((x) => (x.id === c.id ? { ...x, snapshot: snap, unloaded: undefined } : x)))
        land(snap)
      })
      .catch(() => {})
  }

  // ★ 3.0 M-UX (스펙 열린문제 ⑥ — 침묵 no-op 제거) ─────────────────────────────
  // 2.6.2는 busy·상주 워크플로 중의 새 채팅/전환/삭제를 **아무 말 없이** 막았다
  // (App.tsx:774,799,811). 통합 모델에서는 자리가 여럿이고 "실행은 그 자리에서 계속,
  // 화면은 다른 채팅"이 기본값이다. 그래서 잠금을 풀되 **잃는 것이 없게** 두 가지를 건다:
  //   ① 떠나는 채팅이 돌고 있으면 bgTrack — chat:event로 꼬리를 계속 접는다(위 수집기).
  //   ② 사이드바에 실행 중 배지 — 지금 어느 대화가 도는지 목록에서 보인다.
  // 삭제만은 여전히 막는다: 도는 엔진의 대화를 지우면 되돌릴 수 없다(no-op이 아니라
  // 확인 카드가 이유를 말한다 — Sidebar의 busy 가드가 그 자리).
  const leaveActive = (): void => {
    if (busy || wfAlive) bgTrack(activeChatId, state)
  }

  const createChat = (): void => {
    if (activeEmpty) {
      // already sitting on a blank chat — nothing to create, just reset drafts
      setInput('')
      setImages([])
      return
    }
    // 이미 만들어둔 빈 채팅이 있으면 새로 만들지 않고 거기로 복귀 — 골라둔
    // 모델·모드·계정·폴더·초안이 그대로 살아 돌아온다 (빈 채팅 최대 1개 규칙)
    const blank = chats.find((c) => c.id !== activeChatId && !c.unloaded && !c.title && c.snapshot.messages.length === 0)
    if (blank) {
      leaveActive()
      setChats((list) => saveActive(list))
      restore(blank)
      return
    }
    // a new chat starts from the settings you're currently using — not the app default
    leaveActive()
    const fresh = newChatMeta(manualCwd, picker, refDirs)
    setChats((list) => [fresh, ...saveActive(list)])
    load(initialSessionState)
    setInput('')
    setImages([])
    landOnFreshChat(fresh.id)
  }

  /** 빈 채팅으로의 착지 — 새 채팅 · 마지막 하나 삭제 · 전체 삭제가 같은 자리를 쓴다.
   *  ★ R2: 큐 소유권도 여기서 넘어간다(앞 채팅의 예약을 새 채팅이 물려받으면 안 된다). */
  const landOnFreshChat = (id: string): void => {
    setQueue([])
    queueOwnerRef.current = id
    landActiveChat(id)
  }

  const selectChat = (id: string): void => {
    if (id === activeChatId) return
    const target = chats.find((c) => c.id === id)
    if (!target) return
    leaveActive() // 실행 중이면 그 채팅의 꼬리를 계속 받는다 (스펙 ⑥)
    setChats((list) => saveActive(list))
    restore(target)
  }

  const renameChat = (id: string, name: string): void => {
    setChats((list) => list.map((c) => (c.id === id ? { ...c, title: name, custom: true } : c)))
  }

  // ── ★ 3.0 M-UX R2 — 삭제 잠금은 「도는 대화 전부」다 ─────────────────────────
  //
  // 2.6.2의 가드는 `id === activeChatId && busy`였고 그걸로 충분했다 — "busy인데 활성이
  // 아닌 채팅"이라는 상태가 만들어질 수 없었으니까. 스펙 ⑥이 그 상태를 만들었고, 가드를
  // 안 넓힌 대가로 **자리 밖에서 스트리밍 중인 대화가 아무 저지 없이 삭제됐다**
  // (크리틱 M-UX R1 §2-②). 판정 근거는 이 라운드가 이미 들고 있는 두 가지다:
  //   · 활성 채팅 → 라이브 `busy` / 상주 워크플로
  //   · 그 밖 → 배경 추적 집합(`bgSnapRef`) 보유 = 지금 이 창이 꼬리를 접고 있는 대화
  // 반환값은 **사용자에게 보여줄 이유**다. 빈 문자열이면 지울 수 있다 —
  // 침묵 no-op(P7 위반)이 아니라 사이드바가 이 문장을 카드/툴팁으로 말한다.
  const deleteLockOf = (id: string): string => {
    if (id === activeChatId && (busy || wfAlive))
      return t(
        '지금 실행 중인 대화예요 — 중지하거나 끝난 뒤에 지울 수 있어요.',
        "This chat is running — stop it or wait for it to finish before deleting."
      )
    if (bgIds.includes(id))
      return t(
        '이 대화는 자리 밖에서 아직 실행 중이에요 — 열어서 중지하거나 끝난 뒤에 지울 수 있어요.',
        'This chat is still running off-screen — open it to stop it, or wait for it to finish.'
      )
    return ''
  }

  const deleteChat = (id: string): void => {
    // 마지막 방어선 — 사이드바가 이미 막고 이유를 말하지만, 다른 호출 경로(단축키·미래의
    // 표면)가 여기로 새어 들어와 **도는 엔진의 대화**를 지우는 일은 없어야 한다.
    if (deleteLockOf(id)) return
    bgUntrack(id) // 배경 추적 중이었다면 같이 놓는다
    const remaining = chats.filter((c) => c.id !== id)
    if (id === activeChatId) {
      if (remaining.length === 0) {
        const fresh = newChatMeta(manualCwd, picker, refDirs)
        load(initialSessionState)
        setInput('')
        setImages([])
        setChats([fresh])
        landOnFreshChat(fresh.id)
        return
      }
      restore(remaining[0])
    }
    setChats(remaining)
  }

  /** 「전체 삭제」가 막히는 이유(빈 문자열 = 지울 수 있다). 대상 중 **하나라도** 도는
   *  대화가 있으면 전부 막는다 — 부분 삭제는 "무엇이 남았나"를 설명할 수 없다. */
  const deleteAllLock = (): string => {
    if (busy || wfAlive)
      return t(
        '지금 실행 중이에요 — 작업이 끝난 뒤 지울 수 있어요.',
        'A run is in progress — you can delete after it finishes.'
      )
    if (bgIds.length)
      return t(
        `자리 밖에서 실행 중인 대화가 ${bgIds.length}개 있어요 — 끝난 뒤 지울 수 있어요.`,
        `${bgIds.length} chats are still running off-screen — you can delete after they finish.`
      )
    return ''
  }

  // 사이드바 라벨 행의 전체 삭제 — 확인 카드는 Sidebar가 띄우고, 여기선 빈 채팅
  // 하나로 리셋한다 (deleteChat의 remaining.length === 0 분기와 동일한 착지점)
  const deleteAllChats = (): void => {
    if (deleteAllLock()) return
    bgSnapRef.current.clear()
    syncBgIds()
    const fresh = newChatMeta(manualCwd, picker, refDirs)
    load(initialSessionState)
    setInput('')
    setImages([])
    setChats([fresh])
    landOnFreshChat(fresh.id)
  }

  // ⌘N / Ctrl+N — 새 채팅 선택 모달(일반/멀티)을 연다 (PoC: 버튼도 같은 모달)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Shift+Ctrl+N is a separate shortcut (new session window) — don't also make a chat
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        setNewChatOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Ctrl/⌘+Shift+N — open a new independent session window (works in any mode)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        window.api.openSessionWindow().catch(() => {})
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Enter (from anywhere outside a field) jumps into the composer;
  // Shift+Tab cycles the run mode to the next one
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      // a blocking question/프롬프트 modal owns the keyboard (arrows/Enter/numbers) while
      // open — don't let these global shortcuts steal focus or cycle the mode underneath it.
      // .q-mini = 질문을 잠깐 내려둔 상태(여전히 답 대기 중)도 동일하게 비켜준다
      if (document.querySelector('.q-overlay, .q-mini, .pr-overlay, .wf-card')) return
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault()
        setPicker((p) => ({ ...p, mode: nextMode(p.mode) }))
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        const ae = document.activeElement as HTMLElement | null
        const interactive =
          !!ae && (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(ae.tagName) || ae.isContentEditable)
        if (!interactive) {
          e.preventDefault()
          composerRef.current?.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 취소 = 중단 — 클로드 코드처럼 턴을 그 자리에서 끊는다. 보낸 말풍선과 반쯤 온 답은
  // 스레드에 그대로 남고(CLI 세션에도 실제로 남아 있는 내용이라 화면과 어긋나지 않는다)
  // '중단함' 마커가 붙는다. 보낸 문장은 ↑ 히스토리로 다시 불러올 수 있다.
  // 소프트 중단 — 턴만 끊고 CLI·백그라운드(셸·워크플로·에이전트)는 상주로 살린다.
  // 프로세스째 죽이던 예전 cancel은 백그라운드를 고아 통지로 남겨 다음 턴부터 상주가
  // 턴마다 죽는 꼬임 루프를 시작시켰다(실측 2026-08-03). busy가 아니라 상주 워크플로만
  // 도는 경우엔 완결된 턴이므로 워크플로만 그레이스풀 중지(CLI는 살아 보고 턴을 낸다).
  // Esc와 컴포저 중지 버튼이 같은 경로를 쓴다.
  const cancelRun = (): void => {
    if (busy) {
      interruptTurn()
      window.api.interrupt()
    } else {
      for (const w of state.workflows) if (w.status === 'running') onBgTaskMain({ action: 'stop', id: w.id })
    }
    setQueue([])
    // ★ R2 — 소유 대화의 사본도 같이 비운다(중지는 "뒤에 줄 선 것까지 취소"가 계약이다)
    setChats((list) => list.map((c) => (c.id === activeChatIdRef.current ? { ...c, queue: [] } : c)))
  }

  // Esc stops the running conversation (single mode). A modal / menu / selection toolbar
  // that's open owns Esc for its own dismiss, so we stand down while any is present —
  // only abort the run when Esc would otherwise do nothing. Mirrors the composer's stop
  // button: cancel the run and drop anything queued behind it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 상주 워크플로(busy=false) 중의 Esc도 취소로 — 중지 버튼과 같은 의미
      if (e.key !== 'Escape' || mode !== 'single' || (!busy && !wfAlive)) return
      if (
        document.querySelector(
          '.q-overlay, .q-mini, .wf-card, .set-overlay, .set-dialog-overlay, .pr-overlay, .fv-overlay, .gitm-overlay, .iv-overlay, .sa-overlay, .ctx-menu, .sel-bar'
        )
      )
        return
      e.preventDefault()
      cancelRun()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // state.messages는 busy 전환(begin→analyzing)마다 재바인딩되며 최신을 본다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, mode, wfAlive])

  // /clear — wipe the current conversation back to a blank slate (a client action
  // mirroring Claude Code's /clear; never sent to the engine, so the visible message
  // list and the engine's context stay in sync). Keeps the project folder.
  // 상주 백그라운드(워크플로·셸·에이전트)도 함께 회수한다 — 화면만 지우면 살아남은
  // 프로세스가 완료 통지에서 정리 턴을 재기동해, 백지가 된 대화(curRunId=null이라 실행
  // 경계 가드도 무장 해제) 위에서 되살아난다. Esc 취소와 같은 착지점이고, 상주가 없으면
  // 엔진 쪽에서 무해한 no-op이다.
  const clearConversation = (): void => {
    if (busy) return
    window.api.cancel()
    load(initialSessionState)
    setInput('')
    setImages([])
    // 이 채팅의 한도 대기표도 함께 — 백지가 된 대화 위에 옛 프롬프트가 자동
    // 재전송되면(세션이 없어 lastPrompt 폴백을 탄다) 방금 지운 작업이 되살아난다
    if (limitResume.holdRef.current?.key === activeChatId) limitResume.setHold(null)
    // 백지가 된 대화 뒤에 줄 서 있던 예약도 같이 지운다 — 방금 지운 맥락 위로 발사된다
    setQueue([])
    setChats((list) =>
      list.map((c) =>
        c.id === activeChatId ? { ...c, title: '', custom: false, snapshot: initialSessionState, queue: [] } : c
      )
    )
  }

  // ── /btw — 지금 컨텍스트를 이어받은 별도 질문 창 (클로드 코드의 btw 패리티) ──
  // 현재 세션을 포크(forkSession)해 추가 채팅 창으로 연다: 같은 폴더·모델·모드·계정,
  // 인라인 질문('/btw 어쩌구')은 창이 열리자마자 자동 전송. 이 대화의 세션 파일은 그대로라
  // 원본 채팅엔 흔적이 남지 않고, 하단 btw 알약이 창을 되부른다. 턴이 도는 중에도 동작
  // (예약 큐를 타지 않고 즉시) — 디스크에 흘러간 데까지의 컨텍스트로 포크된다.
  // 이어받을 세션이 없거나(첫 응답 전), Codex 엔진이면(app-server엔 포크가 없다) 새
  // 컨텍스트로 열리고, 그 사정은 창 안 안내 칩이 말한다.
  const tryBtw = (text: string): boolean => {
    const p = parseBtw(text)
    if (!p) return false
    const dir = cwd || state.session?.cwd || ''
    const seed = btwForkOf(state.session, dir, picker.engine === 'codex' ? 'codex' : 'claude')
    window.api
      .btwOpen({
        origin: activeChatId,
        // btw 채팅 이름 = 'BTW - <이 채팅 제목>' (제목 전 새 채팅이면 '새 채팅')
        originTitle: activeChat?.title || t('새 채팅', 'New chat'),
        cwd: dir,
        refDirs,
        picker,
        fork: seed?.fork ?? null,
        forkCwd: seed?.cwd ?? null,
        prompt: p.prompt || null
      })
      .catch(() => {})
    return true
  }

  // `opts` lets a queued message replay with the attachments + run settings it was
  // scheduled with (instead of the composer's current state); interactive sends omit it.
  // keepDraft: 컴포저 밖에서 만들어진 프롬프트(파일 뷰어 질문, 큐 재생)는 사용자가
  // 쓰다 둔 초안을 지우지 않는다.
  // 반환값: 엔진 런을 실제로 시작했으면 true — 클라이언트 명령(/clear)이나 조기
  // 반환은 false. 예약 큐 드레인이 이 값으로 "런 없이 소진된 항목" 뒤를 이어서 보낸다.
  const runPrompt = async (
    text: string,
    opts?: { images?: string[]; picker?: PickerState; keepDraft?: boolean }
  ): Promise<boolean> => {
    const imgs = opts?.images ?? images
    const pk = opts?.picker ?? picker
    // an image-only message (attachments, no text) is allowed — guard on having either.
    // 워크플로/백그라운드 작업이 도는 중의 전송은 엔진이 같은 프로세스에 주입한다(tryInject)
    // — 여기서 막지 않는다.
    if ((!text.trim() && imgs.length === 0) || busy) return false
    // /clear is a client command — reset the conversation instead of calling the engine
    if (text.trim() === '/clear') {
      clearConversation()
      return false
    }
    // /btw — 클라이언트 명령: 엔진 대신 별도 질문 창을 연다 (이 대화엔 아무 흔적 없음)
    if (tryBtw(text)) {
      if (!opts?.keepDraft) setInput('')
      return false
    }
    // a built-in slash command (/init·/compact·/review·/security-review) → tracked so
    // its completion renders a summary card instead of a raw user bubble; null otherwise
    const cmd = commandOf(text)
    let dir = cwd
    if (!dir) {
      dir = (await window.api.pickDirectory()) ?? ''
      if (!dir) return false
      setManualCwd(dir)
    }
    // sending re-engages the follow so the user's own message (and the reply) scroll
    // into view, even if they'd scrolled up to read history before sending
    follow.pin()
    // folder changed since this conversation began → it's a different project, and the
    // session can't continue here (a session id is folder-scoped). Reset the thread to a
    // clean slate so the visible chat matches the fresh engine session instead of showing
    // stale messages the model no longer remembers.
    const folderSwitched = !!state.session && state.messages.length > 0 && !sameCwd(state.session.cwd, dir)
    if (folderSwitched) load(initialSessionState)
    begin(text, cmd, imgs)
    // 한도 대기표 해제는 useLimitResume의 busy 상승 에지가 처리한다 — 이 채팅(소유 키
    // 일치)의 새 실행만 해제하고, 다른 채팅의 재개 약속은 보존된다.
    // derive the chat title from the prompt (command → its friendly title) unless renamed.
    // a folder switch starts a fresh conversation, so it re-titles even a renamed chat.
    const title = cmd ? commandTitleOf(cmd) : text.trim().slice(0, 80) || t('파일 첨부', 'File attachment')
    setChats((list) =>
      list.map((c) => {
        if (c.id !== activeChatId) return c
        // 전송 = 활동 — 사이드바 상대 시간(updatedAt)이 이 순간으로 갱신된다
        const base = { ...c, updatedAt: Date.now() }
        return !c.custom || folderSwitched ? { ...base, title, custom: false } : base
      })
    )
    // 요청 조립은 buildRunRequest 한 곳 — 자리 밖 드레인(drainBgQueue)과 **같은 문장**이
    // 나가야 "돌아와 보니 예약이 다른 프롬프트로 나갔다"가 안 생긴다.
    const req = buildRunRequest({
      text,
      images: imgs,
      picker: pk,
      cwd: dir,
      refDirs,
      // 폴더가 바뀌었으면 위에서 스레드를 리셋했다 — resume도 같이 끊는다
      session: folderSwitched ? null : state.session,
      apiMode
    })
    if (!opts?.keepDraft) {
      setInput('')
      setImages([])
    }
    window.api.run(req).catch(() => {})
    return true
  }

  // queue the current draft (while the agent is busy) to auto-send when the run ends
  const scheduleMessage = (): void => {
    if (!busy || (!input.trim() && images.length === 0)) return
    // /btw는 예약하지 않고 즉시 연다 — "작업 도는 동안 곁다리 질문"이 이 명령의 존재 이유
    if (tryBtw(input)) {
      setInput('')
      return
    }
    const id = crypto.randomUUID ? crypto.randomUUID() : `q-${Date.now()}-${queue.length}`
    // ★ R2 — 예약은 곧바로 **그 대화의 것**이 된다. state와 ChatMeta를 함께 쓰는 이유:
    // 전환이 saveActive를 못 타는 경로(창 닫기·크래시 직전 등)에서도 소유자가 남아야 한다.
    const item: ScheduledMsg = { id, text: input, images, picker }
    queueOwnerRef.current = activeChatId // 예약한 사람이 곧 소유자 (부팅 직후 착지가 없어도 맞다)
    setQueue((q) => [...q, item])
    setChats((list) => list.map((c) => (c.id === activeChatId ? { ...c, queue: [...(c.queue ?? []), item] } : c)))
    setInput('')
    setImages([])
    composerRef.current?.focus()
  }
  /** 예약 취소 — state와 소유 대화의 사본을 같이 지운다(두 벌이 갈리면 유령 예약이 남는다). */
  const removeQueued = useEvent((id: string) => {
    setQueue((q) => q.filter((m) => m.id !== id))
    setChats((list) =>
      list.map((c) => (c.id === activeChatIdRef.current ? { ...c, queue: (c.queue ?? []).filter((m) => m.id !== id) } : c))
    )
  })

  // drain the queue on each busy→idle transition. 런을 시작하지 않는 클라이언트 명령
  // (/clear 등)은 busy가 다시 전환되지 않아 뒤 항목이 영영 갇히므로, 엔진 런이 하나
  // 시작될 때까지 while 로 연달아 소진한다. 이중 전송 방지: 루프는 전환당 한 번만 돌고
  // (deps=busy — 항목 추가는 busy 중에만 일어나 effect를 다시 태우지 않는다), 런을
  // 시작한 순간 멈춘다(다음 idle 전환이 이어받는다).
  const prevBusyRef = useRef(busy)
  const queueRef = useRef(queue)
  queueRef.current = queue
  useEffect(() => {
    const was = prevBusyRef.current
    prevBusyRef.current = busy
    // ★ R2 — **소유권 게이트.** 이 목록이 지금 활성인 채팅의 것이 아니면 여기서 쏘지
    // 않는다. busy는 "이 창의 라이브 리듀서"가 내는 값이라 전환(=남의 idle 스냅샷 로드)
    // 만으로도 true→false가 되고, 그 에지에 예약을 쏘면 **남의 대화로 발사된다**
    // (크리틱 M-UX R1 §2-① `queue.misroute`). 자리 밖 채팅의 드레인은 그 채팅의 진짜
    // 턴 종료를 보는 `drainBgQueue`가 `chat:run{chatId}`로 한다.
    if (queueOwnerRef.current !== activeChatIdRef.current) return
    // 이 채팅에 한도 대기표가 있으면 드레인 보류 — 지금 보내봐야 같은 한도에 막혀
    // 에러만 쌓인다. 자동/수동 재개 턴이 끝난 다음 idle 전환이 이어받는다. (ref인 이유:
    // 훅의 장전 effect와 이 effect가 같은 status 변화에서 도는데 state 반영은 다음 렌더라 늦다)
    if (busy || queueRef.current.length === 0 || !was || limitResume.holdRef.current?.key === activeChatIdRef.current) return
    void (async () => {
      const owner = queueOwnerRef.current
      while (queueRef.current.length > 0) {
        const next = queueRef.current[0]
        queueRef.current = queueRef.current.slice(1)
        setQueue((q) => q.slice(1))
        setChats((list) => list.map((c) => (c.id === owner ? { ...c, queue: (c.queue ?? []).slice(1) } : c)))
        // 예약 메시지는 자체 텍스트/첨부로 재생 — 실행 중에 새로 쓰던 초안은 건드리지 않는다
        const started = await runPrompt(next.text, { images: next.images, picker: next.picker, keepDraft: true })
        if (started) break
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy])

  // "더 자세히" from the chat selection toolbar: wrap the highlighted passage in a
  // <selection> tag — an XML tag the model parses more reliably than a markdown
  // blockquote (unambiguous bounds), and the name mirrors the drag-to-select gesture
  // and the "이 부분" the ask refers to. Then focus + grow the textarea so the user can
  // tweak it and send. Appends to any text already typed.
  const onElaborateSelection = (text: string): void => {
    const base = `<selection>\n${text.trim()}\n</selection>\n\n${t('이 부분 더 자세히 설명해줘', 'Explain this part in more detail')}`
    setInput((cur) => (cur.trim() ? cur + '\n\n' + base : base))
    requestAnimationFrame(() => {
      const el = composerRef.current
      if (!el) return
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 160) + 'px'
      el.focus()
      const end = el.value.length
      el.setSelectionRange(end, end)
    })
  }

  // 파일 뷰어의 질문 패널에서 작성된 질문: 경로·줄 범위가 붙은 <selection> 블록과
  // 함께 즉시 전송한다 (대화 진행 중이면 예약 큐로). 컴포저 초안은 건드리지 않는다.
  const onAskSelection = useEvent(
    (p: { path: string; text: string; from: number | null; to: number | null; question: string }) => {
      const lines = p.from != null && p.to != null ? ` lines="${Math.min(p.from, p.to)}-${Math.max(p.from, p.to)}"` : ''
      const prompt = `<selection file="${p.path}"${lines}>\n${p.text}\n</selection>\n\n${p.question}`
      setOpenFilePath(null)
      if (busy) {
        const id = crypto.randomUUID ? crypto.randomUUID() : `q-${Date.now()}-${queue.length}`
        const item: ScheduledMsg = { id, text: prompt, images: [], picker }
        queueOwnerRef.current = activeChatIdRef.current
        setQueue((q) => [...q, item])
        setChats((list) => list.map((c) => (c.id === activeChatIdRef.current ? { ...c, queue: [...(c.queue ?? []), item] } : c)))
      } else {
        void runPrompt(prompt, { images: [], keepDraft: true })
      }
    }
  )

  const onPermission = (behavior: 'allow' | 'allow_always' | 'deny'): void => {
    if (!state.pendingPermission) return
    window.api
      .respondPermission({ requestId: state.pendingPermission.requestId, behavior })
      .catch(() => {})
    clearPermission()
  }

  // ── ★ 3.0 M-UX R2 — 폴백 확인 카드의 응답은 전용 채널로 (§4.4b) ─────────────
  //
  // 셸은 `request_user_dialog`를 2.6.2 파리티로 **질문 카드**로 그리고, 질문 채널로 온
  // 답을 원장 종류에 맞춰 되맞춘다(hub.rs `ask_kind_of`). 계약면의 정답은 전용 채널이고
  // 어휘도 다르다: `{behavior:'completed', result:'retry_fallback'}` / `{behavior:'cancelled'}`.
  // 되맞춤에 기대지 않고 여기서 바로 옳은 채널로 답한다 — 다만 **거절되면 질문 채널로
  // 되돌아간다**(구 빌드·원장이 이 id를 질문으로 아는 경우). 안 그러면 카드만 닫히고
  // 엔진은 영원히 기다린다 — 이 라운드가 없애겠다고 한 바로 그 유령이다.
  const answerFallbackDialog = (requestId: string, accepted: boolean, answers: string[][] | null): void => {
    void respondDialog(activeChatIdRef.current, requestId, accepted).then((ok) => {
      if (!ok) window.api.respondQuestion({ requestId, answers }).catch(() => {})
    })
  }
  const onAnswer = (answers: string[][]): void => {
    const pq = state.pendingQuestion
    if (!pq) return
    if (isFallbackAsk(pq)) {
      const picked = answers[0]?.[0] ?? ''
      answerFallbackDialog(pq.requestId, !!picked && picked !== FALLBACK_ASK_CANCEL, answers)
    } else {
      window.api.respondQuestion({ requestId: pq.requestId, answers }).catch(() => {})
    }
    answerQuestion(answers) // 카드를 닫으며 문답 흔적을 스레드에 남긴다
  }
  // skip without answering (Esc / backdrop / ✕) → agent proceeds with its defaults
  const onDismissQuestion = (): void => {
    const pq = state.pendingQuestion
    if (!pq) return
    // 폴백 확인은 "무응답 진행"이라는 선택지가 없다 — 접어두기는 취소(=폴백 안 함)다
    if (isFallbackAsk(pq)) answerFallbackDialog(pq.requestId, false, null)
    else window.api.respondQuestion({ requestId: pq.requestId, answers: null }).catch(() => {})
    clearQuestion()
  }

  // ── working-folder changes (chat-scoped) ──────────────────────────────────
  // The folder belongs to the ACTIVE chat (each chat keeps its own in ChatMeta and it's
  // restored on switch). A session id is folder-scoped, so moving a chat with messages to
  // another folder can't continue the conversation — every change funnels through
  // requestFolder, which asks first via the card modal instead of silently resetting
  // the thread on the next send.
  const requestFolder = (path: string): void => {
    // what this chat's conversation is actually anchored to — the visible cwd, or the
    // session's folder when no folder is set anymore (e.g. restored from an older file)
    const cur = cwd || state.session?.cwd || ''
    // same folder (re-pick of the current path) or nothing to lose → just apply, no ceremony
    if (!path || !cur || sameCwd(path, cur) || state.messages.length === 0) {
      if (path) setManualCwd(path)
      return
    }
    if (busy) return // the running turn works in this folder — stop or finish it first
    setPendingFolder(path)
  }

  // 변경 — move the folder and start fresh: the thread is wiped and the chat reverts to
  // a blank one (same shape as /clear), since the session can't follow the folder.
  // Drafted input/images are kept — they're not tied to the old folder.
  const confirmFolder = (): void => {
    if (!pendingFolder) return
    setManualCwd(pendingFolder)
    load(initialSessionState)
    setChats((list) =>
      list.map((c) =>
        c.id === activeChatId ? { ...c, title: '', custom: false, snapshot: initialSessionState } : c
      )
    )
    setPendingFolder(null)
  }

  const pickFolder = async (): Promise<void> => {
    if (mode !== 'single') return // ⌘O is a 단일 모드 action — chat/multi have no project folder
    if (busy) return // a folder change is blocked mid-run anyway — don't even open the picker
    const p = await window.api.pickDirectory()
    if (p) requestFolder(p)
  }

  // ── 참조 폴더(--add-dir) 관리 — 폴더 팝오버의 '참조 폴더' 섹션 + 행별 + 토글 ──
  // 작업 폴더와 달리 대화를 리셋하지 않는다(엔진에 추가 루트만 얹는 것) — 다음 실행부터 적용
  const addRefDirPath = (dir: string): void => {
    if (!dir) return
    setRefDirs((a) => {
      const cur = cwd || state.session?.cwd || ''
      if ((cur && sameCwd(dir, cur)) || a.some((p) => sameCwd(p, dir)) || a.length >= 8) return a
      return [...a, dir]
    })
  }
  const addRefDir = async (): Promise<void> => {
    const dir = await window.api.pickDirectory()
    if (dir) addRefDirPath(dir)
  }
  const removeRefDir = (p: string): void => setRefDirs((a) => a.filter((x) => !sameCwd(x, p)))

  // ⌘O / Ctrl+O opens the folder picker — read through a ref to avoid stale closures
  const pickFolderRef = useRef(pickFolder)
  pickFolderRef.current = pickFolder
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        pickFolderRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Set the active project folder to a directory opened via "AgentCodeGUI로 열기"
  // (Windows right-click). Mirrors picking a folder by hand: switch the working
  // directory — confirming first if a conversation is open.
  const openProjectDir = (dir: string): void => {
    if (dir) requestFolder(dir)
  }
  const openProjectDirRef = useRef(openProjectDir)
  openProjectDirRef.current = openProjectDir

  // folder opened via "AgentCodeGUI로 열기" while the app is already running
  // (auto-update UI lives in its own <AppUpdateGate />, like <EngineGate />)
  useEffect(() => {
    return window.api.app.onOpenDirectory((dir) => openProjectDirRef.current(dir))
  }, [])

  // apply the folder passed at launch, but only after chats hydrate so the restored
  // chat's saved cwd doesn't clobber it. Consumed once (the main side clears it).
  const initDirApplied = useRef(false)
  useEffect(() => {
    if (!hydrated || initDirApplied.current) return
    initDirApplied.current = true
    window.api.app
      .getInitialDirectory()
      .then((dir) => {
        if (dir) openProjectDirRef.current(dir)
      })
      .catch(() => {})
  }, [hydrated])

  // look the subagent up live each render so the open card reflects status/tool updates
  const openSubagent = openSubagentId ? state.subagents.find((a) => a.id === openSubagentId) ?? null : null
  const taskTitle = truncate(activeChat?.title || '', 40)
  // 최근 작업 폴더는 공유 저장소(lib/recentDirs) — 일반·멀티·추가 채팅이 같은 목록을
  // 쓴다. 이 채팅의 폴더가 바뀌면(선택·복원 포함) 목록 맨 앞으로 올린다.
  useEffect(() => {
    if (cwd) pushRecentDir(cwd)
  }, [cwd])
  // 스레드 map 밖에서 한 번만 — 메시지마다 liveMsgIndex를 다시 계산하지 않게
  const liveIdx = liveMsgIndex(state.messages)
  // ★ M-UI §5-6의 **중복 금지** 규약을 폴백에도 적용한다. 엔진은 전환 한 번에
  // `chat:identity(engine_fallback)`과 런 이벤트 `model-fallback`을 **함께** 낸다
  // (runtime.rs `fallback_signal` — apply_identity + Event::FallbackBanner가 한 문 안에).
  // 이제 스레드의 `fallback` band가 되돌리기까지 들고 있으므로(그쪽은 엔진이 준 진짜
  // `revertTo`를 쓴다 — 여기 상태줄은 `revision-1`로 **추정**한다), 같은 사건이면 상태줄은
  // 비운다. 같은 사건 판정: 배너의 revertTo == 이 리비전의 직전(§6.2 — revert_to는 적용 전 값).
  // ★M11 — 계정 자동 전환도 같은 쌍이다(`chat:identity(auto_account_switch)` +
  // `notice{switch}`가 `try_auto_switch` 한 문 안에서 나간다 — runtime.rs ②③).
  // 그래서 판정도 같다: 스레드에 그 지점을 가리키는 band가 있으면 상태줄은 비운다.
  const identBandNotice = (() => {
    const n = identNotices[activeChatId] ?? null
    if (!n) return n
    if (n.origin === 'engine_fallback') return state.messages.some((m) => m.kind === 'fallback' && m.revertTo === n.revision - 1) ? null : n
    if (n.origin === 'auto_account_switch')
      return state.messages.some((m) => m.kind === 'notice' && m.action === 'revert' && m.revertTo === n.revision - 1) ? null : n
    return n
  })()
  // 작업 인디케이터(마스코트+문구+경과 초)는 '답변 본문 스트리밍 중'에만 숨긴다(그때는
  // 흐르는 답변 글자가 곧 피드백). 사고·도구·침묵 구간엔 계속 띄워 AI가 도는 걸 보여준다.
  // 질문/명령 카드가 떠 있으면 그 카드가 "작업 중"을 대신 전하므로 중복 인디케이터는 뺀다.
  const showWorking = !state.streaming && !state.pendingQuestion && !state.pendingCommand
  // only chats with real content show up in the recent list (blank chats are hidden).
  // memoized so it keeps a stable reference across keystrokes → memoized Sidebar skips.
  const chatSummaries = useMemo(
    () =>
      chats
        // unloaded 채팅은 스냅샷이 자리표시자(빈 messages)지만 내용이 있어서 내려간 것이다
        .filter((c) => (c.id === activeChatId ? state.messages.length > 0 : c.unloaded || c.snapshot.messages.length > 0) || c.title !== '')
        .map((c) => ({
          id: c.id,
          title: c.title,
          // ★ R2 — 활성 채팅은 라이브 리듀서, 그 밖은 `chat:status`(Rust 소유 진실) →
          // 스냅샷 순. 자리 밖에서 도는 대화의 점이 낡은 스냅샷으로 굳지 않는다.
          status: c.id === activeChatId ? state.status : chatStatus[c.id]?.status ?? c.snapshot.status,
          // 승인/질문 대기 — 화면에 없는 대화의 카드는 목록이 대신 말한다(§2.2-5)
          ask: c.id === activeChatId ? undefined : (chatStatus[c.id]?.ask ?? 'none') !== 'none',
          updatedAt: c.updatedAt
        })),
    [chats, activeChatId, state.messages.length, state.status, chatStatus]
  )

  // stable handlers for the memoized Sidebar / WorkBar
  const onOpenSettings = useEvent(() => setSettingsOpen(true))
  // 모든 파일은 코드 뷰어 카드 하나로 연다 — 변경된 파일이면 뷰어가 diff 마킹
  // (추가 틴트·삭제 헤어라인·룰러)을 얹으므로 LSP 심볼 탐색과 변경 표시가 공존한다.
  // 일반 경로 열기는 Git 오버라이드를 지운다 — 직전에 커밋 스냅샷을 봤어도 새 파일은 평소대로.
  const openPath = (path: string): void => {
    setGitViewer(null)
    setOpenFilePath(path)
  }
  // Git 카드 — 탐색기 하단 상태 스트립이 연다(줄이 가리킨 저장소 root 전달). 카드에서
  // 연 파일은 override로 뷰어에.
  const onOpenGit = useEvent((root?: string) => setGitOpen({ root }))
  const onOpenGitFile = useEvent((path: string, ov: GitViewerOverride) => {
    setGitViewer(ov)
    setOpenFilePath(path)
  })
  // 폴더·뷰 전환(멀티의 패널 전환 포함)이면 카드를 접는다 — 스코프 폴더가 달라졌다
  useEffect(() => setGitOpen(null), [gitCwd, mode])
  const onOpenFile = useEvent((f: { path: string }) => openPath(f.path))
  // click a file in a tool-log row / explorer — same viewer
  const onOpenToolFile = useEvent((path: string) => openPath(path))
  const onOpenSubagent = useEvent((a: SubAgentInfo) => setOpenSubagentId(a.id))
  // 컨텍스트 팝오버 열 때 사용량 강제 새로고침 — 추가 크레딧 잔액이 그 순간 최신이게
  const onRefreshUsage = useEvent(() => {
    window.api.getUsage(true, picker.account).then(setUsage).catch(() => {})
  })
  // ── 변경 파일 카드 (탐색기 우클릭) ─────────────────────────
  const onShowChanged = useEvent((scope: { rel: string; label: string }) => setChgScope(scope))
  // 작업 폴더가 바뀌면(채팅 전환 포함) 스코프 rel 경로가 무의미해지니 카드를 닫는다.
  // 멀티 뷰에선 탐색기가 따라가는 패널·그 폴더가 바뀔 때도 같은 이유로 닫는다.
  useEffect(() => setChgScope(null), [cwd, mode, multiExp?.slot, multiExp?.cwd])
  const onRenameChat = useEvent(renameChat)
  const onDeleteChat = useEvent(deleteChat)
  const onDeleteAllChats = useEvent(deleteAllChats)
  const onOpenNewChat = useEvent(() => setNewChatOpen(true))
  // 사이드바 항목 선택 — 섹션이 곧 뷰: 일반=코드 뷰, 멀티=멀티 뷰, 추가=그 창 포커스
  const onSelectGeneral = useEvent((id: string) => {
    if (mode !== 'single') switchMode('single')
    selectChat(id)
  })
  const onSelectMulti = useEvent((id: string) => {
    if (mode !== 'multi') switchMode('multi')
    multi.selectSession(id)
  })
  // ★ 3.0 M-UX — 일반 채팅(IDE 크롬)의 다이얼. 1은 지금 화면이므로 아무 일도 안 하고,
  // 2‥6은 활성 보드를 그 자리 수로 연다. 대화는 어느 쪽에서도 사라지지 않는다 —
  // 일반 채팅은 「채팅」 목록에 그대로 있고, 보드 자리도 그대로다(§2.2).
  const onDialPick = useEvent((n: number) => {
    if (n <= 1) return
    multi.setActiveCount(n)
    if (mode !== 'multi') switchMode('multi')
  })
  // 추가 채팅 — id는 영속 채팅 id. 클릭=창 포커스(닫힌 채팅이면 창을 다시 만들어 복원),
  // X=대화 삭제(열린 창이 있으면 그 창도 닫힘). 목록은 창을 닫아도/재시작해도 남는다.
  //
  // ★ R3 — 포커스/되만들기는 **`win:chat-focus`** 로 간다(배선 R3 §R3.4 S6이 실증한 자리).
  // 옛 `session-wins:focus`와 같은 일을 하지만 3.0 계약면의 이름이고, 응답이 곧 창 자리
  // 목록이라 브로드캐스트를 기다리지 않고 칩을 갱신할 수 있다. **닫기는 갈랐다**:
  //   `session-wins:close` = 대화 **삭제**(옛 계약) — 사이드바 X가 그대로 쓴다
  //   `win:chat-close`     = **창만** 닫기 — 통합 모델의 "자리는 뷰"(대화는 남는다)
  // 한 함수로 합치면 둘 중 하나가 반드시 대화를 잃는다.
  const onFocusSessionWin = useEvent((id: string) => {
    void focusChatWindow(id).then((slots) => {
      if (slots.length) {
        setWinSlots(slots)
        return
      }
      // 창 자리 채널이 없는 셸(미구현 안전값) — 옛 이름으로 되돌아간다.
      // 목록에서 대화를 아예 못 여는 것보다, 채널 하나를 양보하는 편이 낫다.
      window.api.sessionWindows.focus(id).catch(() => {})
    })
  })
  const onCloseSessionWin = useEvent((id: string) => {
    window.api.sessionWindows.close(id).catch(() => {})
  })
  /** ★ R3 — 창만 닫는다(대화 유지). 사이드바 「창」 칩의 ✕가 부르는 자리. */
  const onCloseWindowOnly = useEvent((id: string) => {
    void closeChatWindow(id).then((okd) => {
      if (okd) setWinSlots((cur) => cur.filter((w) => w.chatId !== id))
    })
  })
  const onRenameSessionWin = useEvent((id: string, name: string) => {
    window.api.sessionWindows.rename(id, name).catch(() => {})
  })
  const onCloseAllSessionWins = useEvent(() => {
    sessionWins.forEach((w) => window.api.sessionWindows.close(w.id).catch(() => {}))
  })
  // 지금 **OS 창이 떠 있는** 채팅 id들 — 「창」 칩의 유일한 진실(`chat:windows`).
  const openWinIds = useMemo(() => new Set(winSlots.map((w) => w.chatId)), [winSlots])
  const extraSummaries = useMemo<ChatSummary[]>(
    () =>
      sessionWins.map((w) => ({
        id: w.id,
        title: w.title || t('새 채팅', 'New chat'),
        status: w.status,
        updatedAt: w.updatedAt,
        // ★ 3.0 M-UX — 추가 채팅은 더 이상 독립 섹션이 아니다. 「채팅」 목록 안에서
        // **창 자리 칩**으로 구분된다(§3.3: 추가 채팅 창 = 자리를 창으로 뺀 것).
        //
        // ★ R3 — 칩은 **창이 실제로 떠 있을 때만** 단다(`chat:windows`). R2까지는
        // 영속된 추가 채팅 전부에 「창」을 달아서, 창을 닫아도 목록은 계속 "창에 있어요"
        // 라고 말했다 — 보드 자리에서 R2가 고친 `stale-live`(§2-⑤)와 같은 거짓말이다.
        // 칩이 없는 항목은 "창이 닫힌 대화"이고, 클릭하면 그 창을 **되만든다**.
        slot: openWinIds.has(w.id) ? { text: t('창', 'win'), kind: 'win' as const } : undefined
      })),
    [sessionWins, openWinIds, lang]
  )
  // ── ★ 3.0 M-UX — 활성 보드의 자리들을 「채팅」 목록 항목으로 ────────────────────
  // 항목 키는 panelId(`${sessionId}::${slot}`) — 별칭 계층이 chatId로 번역하는 그 키다.
  // 보이는 자리(1‥N) → 접힌 자리(⌄N) 순서. 빈 자리는 대화가 아니라 안 보인다(§2.4).
  const boardSummaries = useMemo<ChatSummary[]>(
    () =>
      panelInfos
        .filter((p) => !p.empty)
        .slice()
        .sort((a, b) => (a.pos ?? 100 + (a.fold ?? 0)) - (b.pos ?? 100 + (b.fold ?? 0)))
        .map((p) => ({
          id: p.panelId,
          title: p.title || t('새 채팅', 'New chat'),
          status: p.status,
          ask: p.ask,
          running: p.status === 'working' || p.status === 'analyzing',
          // ★ R2 — 칩의 뜻은 *"이 대화가 지금 어느 자리에서 **보이는가**"* 다(Sidebar.tsx:27).
          // 보드 크롬을 떠나 있으면 그 자리들은 **화면에 없다** — 그때도 「1」을 달아 두면
          // 일반 채팅과 보드 1번 자리가 같은 자리를 동시에 주장한다(크리틱 M-UX R1 §2-⑤
          // `side.dup-slot1`/`side.stale-live`, 스펙 §2.6 불변식 위반). 칩을 떼면 "어느
          // 자리에도 안 얹힌 대화"라는 기존 어휘 그대로다 — 대화는 목록에 그대로 남는다.
          slot: p.popped
            ? { text: t('창', 'win'), kind: 'win' as const }
            : p.pos != null
              ? mode === 'multi'
                ? { text: String(p.pos), kind: 'live' as const, tag: p.color }
                : undefined
              : { text: String(p.fold ?? ''), kind: 'folded' as const, tag: p.color }
        })),
    [panelInfos, mode, lang]
  )
  // 「채팅」 = 보드 자리 ∪ 창 ∪ 일반 채팅. 한 목록 안에서 자리 칩만 다르다(§8-①(a)).
  //
  // ★ R3 — 두 사실이 더 붙는다: **창이 떠 있는가**(`chat:windows` → 우클릭 「창 닫기」)와
  // **엔진이 든 대기표가 ready인가**(`chat:status.hold.ready` → 「이어가기」 알약).
  // 둘 다 화면 밖 대화에 대한 사실이라 목록 말고는 말할 자리가 없다.
  const unifiedChats = useMemo<ChatSummary[]>(
    () => [
      ...boardSummaries,
      ...extraSummaries.map((c) => ({ ...c, winOpen: openWinIds.has(c.id), resumeReady: canPressResume(chatStatus[c.id]) })),
      ...chatSummaries.map((c) => ({
        ...c,
        // 창이 떠 있으면 그게 이 대화가 「지금 있는 자리」다(추가 채팅이 아니어도 —
        // `chat:windows`가 진실이지 어느 목록에서 왔는지가 진실이 아니다).
        // 아니면 IDE 크롬(1 모드)을 차지하고 있을 때 1번 자리.
        slot: openWinIds.has(c.id)
          ? { text: t('창', 'win'), kind: 'win' as const }
          : mode === 'single' && c.id === activeChatId
            ? { text: '1', kind: 'live' as const }
            : undefined,
        running: c.id === activeChatId ? busy || wfAlive : bgIds.includes(c.id),
        // ★ R2 — 지울 수 없으면 **왜인지**를 목록이 들고 다닌다(침묵 no-op 금지, P7)
        lock: deleteLockOf(c.id) || undefined,
        winOpen: openWinIds.has(c.id),
        resumeReady: canPressResume(chatStatus[c.id])
      }))
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boardSummaries, extraSummaries, chatSummaries, mode, activeChatId, busy, wfAlive, bgIds, openWinIds, chatStatus, lang]
  )
  // 접힌 자리 수 — 사이드바 안내 줄("이 배치의 N개 자리가 접혔어요")
  const foldedCount = useMemo(() => panelInfos.filter((p) => !p.empty && p.pos == null && !p.popped).length, [panelInfos])
  // 통합 목록의 클릭 라우팅 — 항목 종류를 id로 판별한다(세 id 공간이 겹치지 않는다)
  const onSelectUnified = useEvent((id: string) => {
    const panel = panelInfos.find((p) => p.panelId === id)
    if (panel) {
      if (mode !== 'multi') switchMode('multi')
      // 접힌 자리면 1번 자리로 올린다(setVisible 관문 — reconcileChatRefs가 따라 돈다)
      multi.raiseSlot(panel.slot)
      return
    }
    // 창이 떠 있는 대화는 그 창을 앞으로 — 본창에 같은 대화를 두 벌 그리지 않는다.
    // (추가 채팅은 창이 닫혀 있어도 이 경로다: `win:chat-focus`가 창을 **되만든다**.)
    if (openWinIds.has(id) || sessionWins.some((w) => w.id === id)) {
      onFocusSessionWin(id)
      return
    }
    onSelectGeneral(id)
  })
  const onRenameUnified = useEvent((id: string, name: string) => {
    if (panelInfos.some((p) => p.panelId === id)) return // 패널 제목은 자리 안에서(F2·연필)
    if (sessionWins.some((w) => w.id === id)) {
      onRenameSessionWin(id, name)
      return
    }
    onRenameChat(id, name)
  })
  // 「채팅」 전체 삭제 — 일반 채팅 전부 + 창 대화 전부. 보드 자리는 「배치」 소관이라 남는다
  const onDeleteAllUnified = useEvent(() => {
    onDeleteAllChats()
    onCloseAllSessionWins()
  })
  const onDeleteUnified = useEvent((id: string) => {
    if (panelInfos.some((p) => p.panelId === id)) return // 자리 비우기는 2단계(창 자리 채널 미배선)
    if (sessionWins.some((w) => w.id === id)) {
      onCloseSessionWin(id)
      return
    }
    onDeleteChat(id)
  })
  // ★ R3 — 「창 닫기」(대화 유지) · 「이어가기」(ready 대기표 소진). 둘 다 보드 자리에는
  // 없는 개념이라(자리는 창이 아니고, 대기표는 채팅 단위다) 채팅 id에만 적용한다.
  const onCloseWindowUnified = useEvent((id: string) => {
    if (panelInfos.some((p) => p.panelId === id)) return
    onCloseWindowOnly(id)
  })
  const onResumeUnified = useEvent((id: string) => {
    if (panelInfos.some((p) => p.panelId === id)) return
    void resumeHold(id)
  })
  // 이 채팅에서 띄운 /btw 질문 창들 — 하단 btw 알약 도크가 그린다 (다른 채팅 것은 안 보임)
  const btwWins = useMemo(() => sessionWins.filter((w) => w.btwOf === activeChatId), [sessionWins, activeChatId])
  // "/" 팔레트 — /btw 포함 (배선된 표면 공통 조립: 본채팅·추가 채팅·멀티 패널·팝아웃)
  const composerCommands = useMemo(() => slashCommandsWithBtw(), [lang])
  // ── ★ 3.0 M-UX — 사이드바 **2섹션** (§8-①(a), 목업 chat-unify-collapse) ────────
  //
  // 2.6.2의 3섹션(일반/멀티/추가)은 "대화를 담는 그릇이 네 벌"이라는 사실이 화면에
  // 새어 나온 것이었다. 통합 모델에서 대화는 하나의 풀이고 자리는 뷰다 →
  //   「채팅」 = 대화 전부(보드 자리 · 창 · 일반). 어디에 있는지는 **자리 칩**이 말한다.
  //   「배치」 = 보드 목록(2.6.2 멀티 세션의 후신 — "그때 그 조합" 복원을 잃지 않는다).
  // 추가 채팅 섹션은 사라졌다 — 목록에서 창 칩으로만 구분된다(§3.3).
  const sections: SidebarSection[] = useMemo(
    () => [
      {
        key: 'general' as const,
        label: t('채팅', 'Chats'),
        chats: unifiedChats,
        // 활성 항목 — 보드 크롬이면 포커스된 자리, 아니면 지금 보는 일반 채팅
        // 보드 크롬이면 1번 자리(= 지금 대화), 아니면 지금 보는 일반 채팅
        activeId: mode === 'multi' ? panelInfos.find((p) => p.pos === 1 && !p.empty)?.panelId : activeChatId,
        currentId: activeChatId,
        // 접힘 안내는 **보드를 보고 있을 때만** — 화면에 없는 배치의 접힘을 계속 말하면
        // 일반 채팅 화면에서 "지금 뭔가 접혀 있다"는 거짓 신호가 된다(§2-⑤와 같은 뿌리)
        hint:
          mode === 'multi' && foldedCount > 0
            ? t(
                `이 배치의 ${foldedCount}개 자리가 접혔어요 — 대화는 그대로예요`,
                `${foldedCount} slots in this board are folded — the chats are all still here`
              )
            : undefined,
        // busy 잠금 없음 — 실행 중에도 전환된다(스펙 ⑥). 실행 중 표시는 항목의 배지가 한다.
        onSelect: onSelectUnified,
        onRename: onRenameUnified,
        onDelete: onDeleteUnified,
        // 전체 삭제 = 일반 채팅 + 창 대화. **보드 자리는 안 지운다**(그건 「배치」 소관)
        // 이라 목록 길이와 실제 개수가 다르다 → 확인 카드에 실제 개수를 준다
        onDeleteAll: onDeleteAllUnified,
        deleteAllCount: chatSummaries.length + extraSummaries.length,
        // ★ R2 — 도는 대화가 하나라도 있으면 「전체 삭제」는 이유를 말하며 잠긴다
        deleteAllLock: deleteAllLock() || undefined,
        // ★ R3 — 창만 닫기(`win:chat-close`) · ready 대기표 이어가기(`op:'resume'`)
        onCloseWindow: onCloseWindowUnified,
        onResume: onResumeUnified
      },
      {
        key: 'multi' as const,
        label: t('배치', 'Boards'),
        emptyText: t('배치가 없어요', 'No boards yet'),
        chats: multi.summaries,
        activeId: mode === 'multi' ? multi.activeId : undefined,
        onSelect: onSelectMulti,
        onRename: multi.renameSession,
        onDelete: multi.deleteSession,
        onDeleteAll: multi.deleteAllSessions
      }
    ],
    // useEvent 핸들러·multi CRUD는 stable — 데이터/선택 상태만 의존한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [unifiedChats, panelInfos, chatSummaries, extraSummaries, foldedCount, multi.summaries, multi.activeId, mode, activeChatId, busy, wfAlive, bgIds, lang]
  )

  // ── ★ R4 — 거부·큐잉 사유 (`chat:verdict`) ──────────────────────────────────
  //
  // 이 채널의 구독자가 0이던 동안 무슨 일이 있었나(크리틱 R14 §5-F4 실측): 채팅 폴더를
  // 없는 경로로 바꾸고 한 줄 보내면 **말풍선이 그려지고 나레이션이 40초를 돌고 중지
  // 버튼이 살아 있는데 오류·안내가 0건**이었다. 셸은 `hub::ensure()`에서 사유를 이 채널로
  // 뿌리고 `null`을 돌려줬을 뿐이고, 런타임이 없으니 T3(20초 침묵 감시)도 없었다.
  // m-logic P8("영구 정지 + 침묵") — 3.0이 죽이겠다고 선언한 그 증상이다.
  //
  // 착지는 둘로 갈린다. **보고 있는 대화**는 스레드 안 카드(+busy 되감기)로, **자리 밖
  // 대화**는 토스트 + 그 대화의 스냅샷에 접기로. 뒤쪽을 스냅샷에만 접으면 열어야 보인다.
  useEffect(() => {
    const off = onChatVerdict((id, v) => {
      const note = verdictNote(v)
      if (!note) return // accepted·applied·noop — 판정 로그를 화면에 흘리지 않는다
      const line = verdictLine(note)
      // ★ R5 접점 — 셸의 `reject_spawn`이 사유를 **스레드로 직접** 내는 판정(`message` 동반)은
      // 저자가 셸이다. 그 대화의 스레드에 렌더러가 같은 사실을 한 번 더 쓰면 두 벌이 된다.
      // 렌더러가 남는 자리는 **셸의 fanout이 닿지 않는 곳**뿐이다:
      //   · 토스트 — 셸에는 없는 표면(다른 대화를 보고 있을 때 이 사고를 알리는 유일한 길)
      //   · 추적도 안 되는 차가운 대화 — `chat:event`를 아무도 안 받으므로 기록이 0이 된다
      const shellSaid = shellAuthored(v)
      if (id === activeChatIdRef.current) {
        if (!shellSaid) noteVerdict(line, note.blocked)
        return
      }
      // 자리 밖 대화 — 지금 창에 한 줄 띄우고(놓치면 다시 못 본다) 그 대화에도 접어 둔다
      setVerdictToasts((cur) =>
        [...cur, { id: `${id}:${note.key}:${Date.now()}`, chatId: id, title: note.title, text: note.text, detail: note.detail }].slice(-3)
      )
      const bg = bgSnapRef.current.get(id)
      if (bg) {
        // 배경 수집기가 셸의 `error` 말풍선을 이미 접고 있다 — 접을 것은 토스트뿐이다
        if (!shellSaid)
          bgSnapRef.current.set(id, sessionReducer(bg, { type: 'verdict', text: line, blocked: note.blocked, time: nowTime() }))
        return
      }
      // 배경 추적 대상이 아니다 = 이 창의 메모리에 그 대화의 스냅샷이 없을 수도 있다
      // (부팅 라이트 페이로드의 `unloaded` 마커). 그러면 지금 접을 자리가 없으므로
      // **열릴 때 접는다**(`restore`의 착지점이 소비). 안 그러면 토스트가 사라지는 순간
      // 사유도 함께 사라진다 — 자리 밖 대화에서 그건 사실상 침묵이다.
      const q = pendingVerdictRef.current.get(id) ?? []
      pendingVerdictRef.current.set(id, [...q, { text: line, blocked: note.blocked, time: nowTime() }].slice(-3))
      while (pendingVerdictRef.current.size > 32) {
        const first = pendingVerdictRef.current.keys().next()
        if (first.done) break
        pendingVerdictRef.current.delete(first.value)
      }
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── ★ R4 — 정체성 리비전 (`chat:identity`) ──────────────────────────────────
  //
  // 구독자 0이던 채널(크리틱 R14 §4.3-M3). 폴백 배너는 `model-fallback`이 이미 스레드에
  // 한 줄 남기지만 그 줄에는 **되돌릴 재료가 없다**(리비전 번호가 계약면에 없다).
  // 여기서 리비전을 받아 배너에 [되돌리기]를 얹는다 — m-logic §6.2 전이 절차 3.
  useEffect(() => {
    const off = onChatIdentity((p) => {
      const id = p.chatId ?? ''
      const origin = p.origin ?? ''
      const kept = (p.keptByFallback ?? []).filter((s) => typeof s === 'string')
      const drifted = (p.driftedFields ?? []).filter((s) => typeof s === 'string')
      // ★M11 — 한도 소진 자동 계정 전환도 **내가 고르지 않은 변화**다(m11 §6-1). 스레드
      // 쪽은 `notice{switch}` band가 되돌리기까지 들지만, 그 줄이 없는 자리(스크롤 위로
      // 밀렸거나 옛 스냅샷)에서는 이 상태줄이 유일한 표면이다. 중복은 아래 identBandNotice가
      // 판정한다 — 폴백과 **같은 규약**(같은 사건이면 스레드 band가 이긴다).
      const show =
        origin === 'engine_fallback' ||
        origin === 'auto_account_switch' ||
        (origin === 'deferred_apply' && (kept.length > 0 || drifted.length > 0))
      setIdentNotices((cur) => {
        if (!show) {
          // 사용자가 직접 바꿨거나 되돌렸다 = 이 배너가 말하던 사실이 더는 최신이 아니다
          if (!cur[id]) return cur
          const next = { ...cur }
          delete next[id]
          return next
        }
        return {
          ...cur,
          [id]: {
            chatId: id,
            revision: typeof p.revision === 'number' ? p.revision : 0,
            origin,
            model: p.identity?.engine?.model ?? '',
            // ★M11 — 구독 축의 계정. api_key 축이면 `account`가 없으므로 빈 문자열이 되고,
            // 배너는 이름 절 없이 사실만 말한다(지어내지 않는다).
            account: p.identity?.billing?.account ?? '',
            keptByFallback: kept,
            driftedFields: drifted
          }
        }
      })
    })
    return off
  }, [])
  const dismissIdent = useEvent((id: string) => {
    setIdentNotices((cur) => {
      if (!cur[id]) return cur
      const next = { ...cur }
      delete next[id]
      return next
    })
  })
  // 되돌리기 — 셸의 와이어에 `revertTo`가 없어 **직전 리비전**으로 되돌린다. 그 번호가
  // 없으면 엔진이 `no_revision`으로 거절하고, 그 사유는 위 verdict 구독자가 그린다.
  const onRevertIdent = useEvent((n: IdentityNotice) => {
    void revertIdentity(n.chatId, n.revision - 1).then((ok) => {
      if (!ok) return
      dismissIdent(n.chatId)
      // 스레드에 같은 지점을 가리키는 band가 있으면 그쪽 알약도 정착시킨다 — 상태줄만
      // 사라지고 스레드 알약이 계속 '되돌리기'면 두 번째 클릭이 `no_revision`을 받는다
      if (n.chatId === activeChatIdRef.current) noteReverted(n.revision - 1)
    })
  })
  // ★ M-UI — 스레드 알림 band의 행동 알약. 형태가 행동을 가질 수 있는 건 band뿐이고
  // (rule=사실의 기록 · card=끝난 산출물), 그 행동이 **호스트 상태를 건드리는 것**만
  // 여기로 온다(복사·펼치기는 뷰 안에서 끝난다).
  const onNotifyAction = useEvent((a: NotifyAction) => {
    // ★ 잔여 (M-UI 크리틱 F3) — 눌렀다는 **되먹임**이 없었다. 셸이 true를 주면 그 band를
    // `[되돌림 ✓]`로 정착시킨다(뷰는 이미 그 가지를 갖고 있었고, 세우는 쪽이 없었다).
    // 거절(false)이면 아무것도 안 세운다 — 사유는 `chat:verdict` 구독자가 그린다.
    if (a.kind === 'revert')
      void revertIdentity(activeChatId, a.revertTo).then((ok) => {
        if (ok) noteReverted(a.revertTo)
      })
    // "하단 `과금` 토글에서 바꿀 수 있어요"라는 심부름 문장 대신 그 토글을 바로 누른다
    else if (a.kind === 'billing-off') onApiModeChange(false, picker.engine)
  })

  /* ── ★M10 R2 C3 — 대화 연결 **긴급 정지**. ───────────────────────────────
   *
   * 크리틱 D7: `grep -rn crosstalk app/src` = **0건**. 라우터·상한·옵트인은 전부
   * 섰는데 사람이 누를 자리가 없었다 — 「멈추는 방법」이 무게중심이라던 라운드에서
   * 정지가 제품에 없었다는 뜻이다. 여기가 그 자리다.
   *
   * 자리를 **둘**로 두는 이유: 설정 모달을 열어야 누를 수 있으면 그건 긴급 정지가
   * 아니다. 켜져 있을 때만 뜨는 알약 하나 + 어디서나 듣는 단축키 하나.
   */
  //
  // ★R3 C4 — 알약·단축키·상태 구독이 **한 덩어리**로 `components/TalkStop.tsx`에
  // 들어갔다. R2는 이 셋이 여기(MainApp) 안에만 있었고, 렌더러 뿌리가 셋이라
  // 추가 창·팝아웃에는 누를 자리가 없었다(크리틱 D6). 세 뿌리가 같은 것을 건다.

  return (
    <div className="win">
      <div className="blurwarm" />
      {/* 켜져 있을 때만 뜬다. 기본값이 꺼짐인 기능의 정지 버튼을 상시 띄우면 화면만
          시끄럽고, 꺼져 있으면 위험이 0이므로 자리도 0이어야 한다. */}
      <TalkStopPill />
      <div className="win-body">
        {/* 왼쪽 칼럼 — 채팅 사이드바 ⟷ 파일 탐색기 전환 ( ` 또는 헤더 돋보기 옆 버튼).
            멀티 뷰의 탐색기는 마지막으로 클릭한 패널의 폴더를 따라간다(패널 전환 = 트리 전환).
            두 패널 모두 --lcol-w 한 폭이라 폭 트랜지션 없이 key 교체 슬라이드-인만 남는다.
            오른쪽 경계 핸들 드래그로 폭 조절 — 사용자 폭일 때만 인라인 변수를 얹는다 */}
        {autohide && <div className={'lcol-edge' + (lcolRevealed ? ' gone' : '')} />}
        <div
          ref={lcolRef}
          className={'lcol' + (autohide ? ' autohide' : '') + (autohide && lcolRevealed ? ' revealed' : '')}
          style={lcolW != null ? ({ '--lcol-w': `${lcolW}px` } as React.CSSProperties) : undefined}
        >
          {mode === 'single' && explorerOpen ? (
            <Explorer
              key="fx"
              cwd={cwd}
              refreshKey={fsTick}
              onPickFolder={pickFolder}
              onOpenFile={onOpenToolFile}
              changed={state.files}
              onShowChanged={onShowChanged}
              onViewFolderChange={onExplorerView}
              user={user}
              onOpenSettings={onOpenSettings}
              onOpenGit={onOpenGit}
            />
          ) : mode === 'multi' && explorerOpen && multiExp ? (
            <Explorer
              key="fxm"
              cwd={multiExp.cwd}
              refreshKey={multiExp.tick}
              onPickFolder={multiExp.pickFolder}
              onOpenFile={multiExp.openFile}
              changed={multiExp.files}
              onShowChanged={onShowChanged}
              user={user}
              onOpenSettings={onOpenSettings}
              onOpenGit={onOpenGit}
            />
          ) : (
            <Sidebar key="sb" user={user} sections={sections} onNewChat={onOpenNewChat} onOpenSettings={onOpenSettings} />
          )}
          <div
            className={lcolDrag ? 'lcol-rs on' : 'lcol-rs'}
            onPointerDown={onLcolResize}
            onDoubleClick={onLcolReset}
          />
        </div>
        {mode === 'multi' ? (
          <ErrorBoundary label={t('멀티 에이전트', 'Multi-agent')}>
            <MultiWorkspace
              multi={multi}
              onPanelInfo={setPanelInfos}
              usage={usage}
              apiMode={apiMode}
              apiReady={!!apiCfg?.hasKey}
              apiReadyCodex={!!apiCfg?.hasOpenaiKey}
              onOpenApiSettings={openApiSettings}
              autoResume={autoResume}
              onAutoResumeChange={onAutoResumeChange}
              onExplorerInfo={setMultiExp}
              explorerHidden={!explorerOpen}
              onToggleExplorer={toggleExplorer}
            />
          </ErrorBoundary>
        ) : (
        <>
        <div className="chat chat--code">
          <ChatHeader
            title={taskTitle}
            cwd={cwd}
            onSelectFolder={requestFolder}
            onBrowseFolder={pickFolder}
            refDirs={refDirs}
            onAddRefDir={addRefDir}
            onAddRefDirPath={addRefDirPath}
            onRemoveRefDir={removeRefDir}
            explorerHidden={!explorerOpen}
            onToggleExplorer={toggleExplorer}
            /* ★ 3.0 M-UX — 다이얼은 두 크롬의 **같은 자리**에 산다(§2.1). 여기(IDE)에서
               2‥6을 고르면 활성 보드가 그 자리 수로 열린다 — 1↔2 전환에서 버튼이 안 움직인다.
               R2: 접힘 배지 자리(FoldSlotHold)를 함께 예약해야 그 규약이 실제로 지켜진다 —
               안 그러면 보드 크롬에만 있는 배지 폭만큼 이 화면의 다이얼이 오른쪽으로 간다 */
            dial={
              <>
                <PanelDial count={1} onPick={onDialPick} />
                <FoldSlotHold />
              </>
            }
          />
          <ZoomBadge pct={chatZoom.pct} show={chatZoom.flash} />
          <div className="chat-scroll scroll" ref={chatScrollRef}>
            {state.messages.length === 0 && !busy ? (
              <WelcomeState
                userName={user.name}
                onPick={(t) => {
                  setInput(t)
                  composerRef.current?.focus()
                }}
              />
            ) : (
              // --z: 줌 배율을 CSS에도 전달 — .thread가 px 폭 경계를 역보정해
              // 확대해도 칼럼의 보이는 폭은 유지한 채 글자만 커지게 한다
              <div className="thread" style={{ zoom: chatZoom.zoom, '--z': chatZoom.zoom } as React.CSSProperties}>
                {twin.start > 0 && <div className="thread-older" ref={twin.sentinelRef} aria-hidden="true" />}
                {state.messages.slice(twin.start).map((m, i) => (
                  <MessageView
                    key={m.id}
                    item={m}
                    live={twin.start + i === liveIdx && m.kind === 'msg' && m.role === 'assistant' && !m.error}
                    running={busy}
                    onOpenFile={onOpenToolFile}
                    onOpenImage={openViewer}
                    onNotify={onNotifyAction}
                    // 본채팅만 `chatId`(=activeChatId)를 안다 = 되돌리기를 실제로 보낼 수
                    // 있는 유일한 표면이다. 멀티 패널·추가 채팅 창은 이 줄을 안 준다.
                    canRevert
                  />
                ))}
                {busy && showWorking && <WorkingIndicator elapsed={elapsed} />}
              </div>
            )}
            {follow.showJump && (
              <div className="jump-bottom-wrap">
                <button
                  className="jump-bottom has-tip"
                  data-tip={t('맨 아래로', 'Scroll to bottom')}
                  aria-label={t('맨 아래로', 'Scroll to bottom')}
                  onClick={follow.jumpBottom}
                >
                  <IconChevDown size={17} />
                </button>
              </div>
            )}
          </div>
          <SelectionToolbar scrollRef={scrollRef} onElaborate={onElaborateSelection} />
          <ChatFind scrollRef={scrollRef} onOpenChange={(o) => o && twin.reveal()} />
          <MouseGestureLayer target={scrollEl} actions={chatGestures} />
          <WorkBar
            todos={state.todos}
            files={state.files}
            subagents={state.subagents}
            bgTasks={state.bgTasks}
            busy={busy}
            canSkipWait={canSkipWait}
            onBgTask={onBgTaskMain}
            usage={usage}
            contextTokens={state.result?.contextTokens ?? null}
            contextWindow={state.result?.contextWindow ?? null}
            model={picker.model}
            apiMode={apiMode}
            chatSpentUsd={state.spentUsd ?? 0}
            budgetUsd={apiCfg?.budgetUsd ?? null}
            totalSpentUsd={apiCfg?.spentUsd ?? 0}
            tokenTotals={state.tokenTotals}
            engine={picker.engine}
            codexAccount={picker.codexAccount}
            onOpenFile={onOpenFile}
            onOpenSubagent={onOpenSubagent}
            onRefreshUsage={onRefreshUsage}
          />
          {/* ★ R4 — 엔진이 뒤에서 바꾼 정체성(폴백·드리프트) + [되돌리기]. 한도 배너와
              같은 줄에 서지만 말하는 사실이 다르다(m-logic §6.2 · M-UI 목업 1-fallback) */}
          <IdentityBand
            notice={identBandNotice}
            onRevert={() => {
              const n = identNotices[activeChatId]
              if (n) onRevertIdent(n)
            }}
            onDismiss={() => dismissIdent(activeChatId)}
          />
          {/* 한도 자동 이어서 상태줄 — 이 채팅 소유의 대기표만 보여준다.
              토글 자체는 과금 picker(구독 → '한도 소진 시 자동 이어서')에 있다 */}
          <LimitHoldBar
            hold={limitResume.hold?.key === activeChatId ? limitResume.hold : null}
            enabled={autoResume}
            onCancel={() => limitResume.setHold(null)}
            // ★ R3 — 엔진이 든 대기표가 있으면 그것이 진실이다(렌더러 기계는 managed로 멈춰 있다)
            managed={engineHoldOf(chatStatus[activeChatId])}
            onResume={() => void resumeHold(activeChatId)}
            // ★R28c RCAP — 렌더러가 든 표(옛 셸·통합 스토어 꺼짐)의 이어가기. 위 `onResume`과
            //   상대가 다르다 — 저쪽은 엔진에게 묻고 이쪽은 훅이 직접 쏜다.
            onContinue={limitResume.resumeNow}
          />
          <Composer
            value={input}
            onChange={setInput}
            history={sentHistory}
            onSend={() => runPrompt(input)}
            onStop={cancelRun}
            onSchedule={scheduleMessage}
            queued={queue}
            onRemoveQueued={removeQueued}
            busy={busy}
            started={state.messages.length > 0}
            picker={picker}
            setPicker={setPicker}
            apiMode={apiMode}
            apiReady={!!apiCfg?.hasKey}
            apiReadyCodex={!!apiCfg?.hasOpenaiKey}
            onApiModeChange={onApiModeChange}
            autoResume={autoResume}
            onAutoResumeChange={onAutoResumeChange}
            images={images}
            onPickImages={addImagesFromPicker}
            onAddImagePaths={addImagePaths}
            onRemoveImage={(i) => setImages((a) => a.filter((_, idx) => idx !== i))}
            onOpenImage={openViewer}
            cwd={cwd}
            mentionBase={mentionBase}
            commands={composerCommands}
            inputRef={composerRef}
            chatId={activeChatId}
          />
        </div>

        </>
        )}
      </div>

      {chgScope && (
        <ChangedFilesModal
          scope={chgScope}
          // 멀티 뷰의 탐색기에서 열렸으면 그 패널의 변경 목록·뷰어(패널 cwd·diffs)로 간다
          changed={(mode === 'multi' ? multiExp?.files : state.files) ?? []}
          onOpen={mode === 'multi' && multiExp ? multiExp.openFile : onOpenToolFile}
          onClose={() => setChgScope(null)}
        />
      )}

      {/* Git 카드 — 뷰어(z 60)가 위에 뜨도록 한 단계 아래(z 55). 멀티 뷰에선 탐색기가
          따라가는 패널의 폴더 기준으로 열리고, 파일은 언제나 루트 FileModal(절대 경로)로 간다 */}
      {gitOpen && gitCwd && (
        <GitModal
          cwd={gitCwd}
          initialRoot={gitOpen.root}
          refreshKey={mode === 'multi' ? multiExp?.tick ?? 0 : fsTick}
          onClose={() => setGitOpen(null)}
          onOpenFile={onOpenGitFile}
        />
      )}

      {/* 조건 마운트 — 닫힌 FileModal은 어차피 null을 그렸고(path 가드), 상시 마운트면
          lazy 청크가 부팅에 로드돼 지연 로드가 무력화된다. fallback 없음 = 첫 오픈 시
          로컬 청크 로드 한 프레임(체감 0)만 비었다가 뜬다 */}
      {(openFilePath !== null || gitViewer !== null) && (
        <Suspense fallback={null}>
          <FileModal
            path={openFilePath}
            cwd={cwd}
            diffs={state.diffs}
            override={gitViewer}
            onClose={() => {
              setOpenFilePath(null)
              setGitViewer(null)
            }}
            onAskSelection={onAskSelection}
          />
        </Suspense>
      )}

      {viewer && (
        <ImageViewer
          images={viewer.images}
          index={viewer.index}
          onIndexChange={(i) => setViewer((v) => (v ? { ...v, index: i } : v))}
          onClose={() => setViewer(null)}
        />
      )}

      <SubAgentModal agent={openSubagent} onClose={() => setOpenSubagentId(null)} />

      {/* btw 알약 도크 — 이 채팅에서 띄운 질문 창들. DOM에서 워크플로 도크보다 앞이어야
          동시 상주 시 형제 선택자(:has ~)로 한 층 위로 비킨다 */}
      {mode === 'single' && <BtwDock wins={btwWins} onFocus={onFocusSessionWin} onClose={onCloseSessionWin} />}

      {/* 워크플로 알약/카드 — 메인 채팅 표면에서만 (멀티 패널은 자기 표면이 따로 붙는다) */}
      {mode === 'single' && (
        <WorkflowDock wfs={state.workflows} onStop={(id) => onBgTaskMain({ action: 'stop', id })} />
      )}

      <QuestionModal question={state.pendingQuestion} onAnswer={onAnswer} onDismiss={onDismissQuestion} />

      <PermissionModal permission={state.pendingPermission} onRespond={onPermission} />

      {pendingFolder && (
        <FolderSwitchDialog
          from={cwd || state.session?.cwd || ''}
          to={pendingFolder}
          onCancel={() => setPendingFolder(null)}
          onConfirm={confirmFolder}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          cwd={cwd}
          initialView={settingsView}
          onClose={() => {
            setSettingsOpen(false)
            setSettingsView(undefined)
          }}
        />
      )}

      {/* 감지 폭 미리보기 — 설정 슬라이더를 만지는 동안 창 왼쪽 가장자리에 그 폭만큼 뜨는 띠.
          설정 모달(z-70) 위로 보이게 z-90. 안내용이라 클릭은 통과(pointer-events:none). */}
      {triggerPrev.show && (
        <div className="autohide-trigger-preview" style={{ width: `${triggerPrev.w}px` }}>
          <div className="atp-lbl">
            {t(`감지 폭 ${triggerPrev.w}px`, `Trigger zone ${triggerPrev.w}px`)}
            <span>{t('이 안에 마우스가 오면 펼쳐져요', 'Opens when the mouse enters this zone')}</span>
          </div>
        </div>
      )}

      {/* 새 채팅 선택 — 일반(코드 뷰에 빈 채팅)/멀티(패널 수 골라 새 세션) */}
      {newChatOpen && (
        <NewChatModal
          busy={busy}
          onClose={() => setNewChatOpen(false)}
          onGeneral={() => {
            if (mode !== 'single') switchMode('single')
            createChat()
          }}
          onMulti={(n) => {
            if (mode !== 'multi') switchMode('multi')
            multi.newSession(n)
          }}
        />
      )}


      {/* 패치노트 릴리즈 카드 — 버전이 오른(또는 첫) 실행에 한 장. 엔진/앱 업데이트
          게이트보다 먼저 렌더해서(z-index 동급, DOM 뒤가 위) 게이트가 항상 위에 뜬다 */}
      {/* ★ R4 — 자리 밖 대화의 거부 사유. 스레드 카드는 그 대화를 열어야 보이므로,
          지금 창에 한 줄 띄워 "보낸 줄 알았는데 안 나갔다"를 그 순간에 알린다 */}
      <VerdictToast
        items={verdictToasts}
        onGo={(id) => {
          setVerdictToasts((cur) => cur.filter((v) => v.chatId !== id))
          onSelectUnified(id)
        }}
        onDismiss={(id) => setVerdictToasts((cur) => cur.filter((v) => v.id !== id))}
      />

      <PatchNotes />

      <EngineGate />
      <EngineUpdateGate />
      <AppUpdateGate />
    </div>
  )
}

// Build the in-memory user from a saved/just-entered profile.
function userFromProfile(p: UserProfile): AppUser {
  const name = p.nickname.trim()
  return { name, avatarText: name.slice(0, 1).toUpperCase() || '?', avatarColor: p.color }
}

// 2.0: 입장 화면 없이 바로 시작 — 저장된 프로필이 있으면 그대로, 없으면 기본값.
// 닉네임·아바타는 설정 ▸ Profile에서 언제든 바꾼다.
const DEFAULT_USER: AppUser = { name: 'User', avatarText: 'U', avatarColor: '#6366F1' }

export default function App() {
  useLang() // 언어 전환 시 전체 트리 재렌더 — 모든 t()가 새 언어로 다시 평가된다
  const [ready, setReady] = useState(false)
  const [user, setUser] = useState<AppUser>(DEFAULT_USER)

  useEffect(() => {
    window.api
      .getProfile()
      .then((p) => {
        if (p && p.nickname?.trim()) setUser(userFromProfile(p))
      })
      .catch(() => {})
      .finally(() => setReady(true))
  }, [])

  // 설정 ▸ Profile 저장이 바로 반영되게 — profileChanged 커스텀 이벤트로 동기화
  useEffect(() => {
    const onChanged = (e: Event): void => {
      const p = (e as CustomEvent<UserProfile>).detail
      if (p && p.nickname?.trim()) setUser(userFromProfile(p))
    }
    window.addEventListener('ccg-profile-changed', onChanged)
    return () => window.removeEventListener('ccg-profile-changed', onChanged)
  }, [])

  if (!ready) {
    return (
      <div className="win">
        <div className="boot">
          <div className="boot-logo"><IconMascot size={30} /></div>
          <div className="boot-name">AgentCodeGUI</div>
          <div className="boot-spin" />
          <div className="boot-sub">{t('불러오는 중…', 'Loading…')}</div>
        </div>
      </div>
    )
  }
  // 최상위 안전망 — MainApp 자체 렌더(단일 모드 스레드 포함)에서 난 예외까지 잡는다.
  // 워크스페이스별 경계가 먼저 잡고, 여기는 그 밖(사이드바·모달 등)을 커버한다.
  return (
    <ErrorBoundary label={t('앱', 'App')}>
      <MainApp user={user} />
    </ErrorBoundary>
  )
}
