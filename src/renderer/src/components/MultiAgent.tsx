import { Suspense, lazy, memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { AgentStatus, BgTaskRequest, ChangedFile, EngineId, UsageInfo, MultiRunRequest, EngineEvent, SubAgentInfo } from '@shared/protocol'
import {
  useAgentSession,
  initialSessionState,
  sanitizeSnapshot,
  snapshotForPersist,
  sameCwd,
  commandOf,
  commandTitleOf,
  liveMsgIndex,
  type SessionState
} from '../store/session'
import {
  Composer,
  MessageView,
  WorkingIndicator,
  WorkBar,
  WorkflowDock,
  PermissionModal,
  QuestionModal,
  SelectionToolbar,
  ChatFind,
  FolderPop,
  useThreadFollow,
  useThreadWindow,
  hasRunningBash,
  pickerModelOf,
  type PickerState,
  type ScheduledMsg
} from './Chat'
import type { ChatSummary } from './Sidebar'
import { WinControls } from './TitleBar'
import { FolderSwitchDialog } from './FolderSwitchDialog'
const FileModal = lazy(() => import('./FileModal').then((m) => ({ default: m.FileModal }))) // CodeMirror 청크 지연 로드 (App.tsx와 동일)
import { pushRecentDir } from '../lib/recentDirs'
import { SubAgentModal } from './AgentPanel'
import { ImageViewer } from './ImageViewer'
import { extractMentions } from '../lib/mentions'
import { useTurnNotifyList } from '../lib/notify'
import { mergeRefs, useZoom, ZoomBadge } from './zoom'
import { MouseGestureLayer, clearGesture, sessionWindowGesture } from './mouseGesture'
import { IconFolder, IconChevDown, IconMascot, IconPanelRight, IconExpand, IconCollapse, IconPencil } from './icons'
import { t, useLang } from '../lib/i18n'

// A multi-agent SESSION is a group of N panels that work together. The recent-tasks
// list shows one entry per session (not per panel); "새 작업" opens a fresh session and
// the panels are part of it. Each session owns SLOT_COUNT panels, each an independent
// Claude Code engine addressed by `${sessionId}::${slot}` — unique per session, so two
// sessions never collide on the shared event channel, and a session's runs keep going
// in the background after you switch away (events resync when you come back).
const SLOT_COUNT = 6
const SLOTS = [0, 1, 2, 3, 4, 5]

// 그리드 배치는 .ma-grid.nN 클래스가 결정 (PoC: 2·3=한 줄, 4=2×2, 5=3+2 스팬, 6=3×2)
const COUNT_OPTIONS = [2, 3, 4, 5, 6]

// 라벨은 함수로 늦춰 렌더 때 t() 평가 — 모듈 스코프 상수에 언어가 박제되지 않게
const STATUS_META: Record<AgentStatus, { label: () => string; cls: string }> = {
  idle: { label: () => t('대기', 'Idle'), cls: 'idle' },
  analyzing: { label: () => t('분석 중', 'Analyzing'), cls: 'analyzing' },
  working: { label: () => t('작업 중', 'Working'), cls: 'working' },
  done: { label: () => t('완료', 'Done'), cls: 'done' },
  error: { label: () => t('오류', 'Error'), cls: 'error' }
}

// multi-agent panels default to bypass — autonomous parallel work shouldn't stop on
// per-tool approvals across several panels at once (changeable per panel in the picker)
const DEFAULT_PICKER: PickerState = { model: 'opus', effort: 'xhigh', mode: 'bypass' }

// 아직 조회 전인 계정의 빈 사용량 — 컨텍스트 팝오버 한도 행이 '데이터 없음'으로 그려진다
const EMPTY_USAGE: UsageInfo = { fiveHour: null, weekly: null, weeklyFable: null, extraCredit: null }

// a picker restored from disk may be missing, truncated (crash mid-save), or hold ids
// this build no longer knows — each field falls back to the default individually
const PICKER_MODELS = ['fable', 'opus', 'sonnet', 'haiku']
const PICKER_EFFORTS = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal']
const PICKER_MODES = ['normal', 'plan', 'acceptEdits', 'auto', 'bypass']
function sanitizePanelPicker(p?: Partial<PickerState> | null): PickerState {
  return {
    model: p?.model && PICKER_MODELS.includes(p.model) ? p.model : DEFAULT_PICKER.model,
    effort: p?.effort && PICKER_EFFORTS.includes(p.effort) ? p.effort : DEFAULT_PICKER.effort,
    mode: p?.mode && PICKER_MODES.includes(p.mode) ? p.mode : DEFAULT_PICKER.mode,
    // 실행 엔진 + Codex 모델 — 버리면 GPT 패널이 복원 때마다 Claude로 폴백한다
    engine: p?.engine === 'codex' ? 'codex' : undefined,
    codexModel: typeof p?.codexModel === 'string' && p.codexModel ? p.codexModel : undefined,
    // 실행 계정(이메일) — 형태만 확인 (등록 목록 대조는 picker·엔진이 담당)
    account: typeof p?.account === 'string' && p.account ? p.account : undefined,
    codexAccount: typeof p?.codexAccount === 'string' && p.codexAccount ? p.codexAccount : undefined
  }
}

const MULTI_VERSION = 2

// one panel's live state within a session (input + images + queue are draft-only, not persisted)
interface PanelMeta {
  title: string
  custom: boolean // user-renamed → keep the title instead of deriving it from the prompt
  color: string // 컬러 태그('' = 슬롯 기본색) — 헤더 하단 라인. cwd·picker 같은 패널 설정이라 /clear에도 유지
  cwd: string // this panel's working dir
  refDirs: string[] // 참조 폴더(--add-dir) — 작업 폴더 외에 이 패널 엔진이 함께 인식할 폴더들
  picker: PickerState
  api: boolean // 이 패널의 과금 (true = API 키 종량) — 모델/모드처럼 패널별 독립 선택
  input: string
  images: string[] // attached image paths, sent with the next message
  queue: ScheduledMsg[] // messages queued while this panel is busy — auto-sent in order when its run ends
}
// what we persist for one panel (its meta + the frozen session thread)
interface PersistedPanel {
  title: string
  custom: boolean
  color?: string // 없으면(예전 저장본) 태그 없음
  cwd: string
  refDirs?: string[] // 없으면(예전 저장본) 빈 목록
  picker: PickerState
  api?: boolean // 없으면(예전 저장본) 복원 시점의 전역 과금 모드로 시드
  snapshot?: SessionState
}
// a whole multi-agent session: a title (for the recent list) + its panel layout
interface PersistedSession {
  id: string
  title: string
  custom: boolean
  count: number
  panels: PersistedPanel[] // length SLOT_COUNT
  updatedAt?: number // 마지막 활동(실행 시작) 시각 — 사이드바 상대 시간 표시용
  // 패널 스냅샷이 메모리에 없다는 표식 — panels는 빈 배열이고 진짜는 디스크(maStore)에
  // 있다(전환 시 loadSession으로 되읽음). 모든 세션×6패널 스냅샷을 상주시키면 렌더러
  // 힙이 세션 수에 비례해 큰다. 저장 페이로드의 이 표식은 maStore가 "메타만 덮고
  // 저장된 패널은 지켜라"로 읽는다.
  unloaded?: boolean
  // main의 부팅 경량화(readMulti light)가 마커에 실어 주는 패널 상태 요약 — 배지 계산용.
  // 파일엔 저장되지 않고(활성화 merge·maStore가 걷어냄) 부팅 한 번만 쓰인다.
  panelStatuses?: AgentStatus[]
}
interface MultiPersist {
  version: number
  activeSessionId: string
  sessions: PersistedSession[]
}
// the active session's panels reported up for persistence
interface CommitPayload {
  count: number
  panels: PersistedPanel[]
}

// 왼쪽 칼럼 파일 탐색기(` 전환)가 따라갈 패널의 스냅샷 — ActiveSession이 App으로
// 보고하고, App이 사이드바 자리(.lcol)에 이 정보로 Explorer를 그린다. 핸들러는
// useEvent라 안정 — 파일 열기/폴더 선택이 그 패널의 뷰어·폴더 흐름으로 간다.
export interface MultiExplorerInfo {
  slot: number
  cwd: string // 그 패널의 작업 폴더 ('' = 아직 미선택 → 탐색기 빈 화면 + 폴더 선택 버튼)
  files: ChangedFile[] // 그 패널 세션의 변경 파일 → 트리 M/A 배지
  tick: number // 패널 실행이 끝날 때마다 +1 → 탐색기 재읽기 (본채팅 fsTick 규칙)
  openFile: (path: string) => void // 그 패널의 cwd·diffs로 코드 뷰어
  pickFolder: () => void // 그 패널의 폴더 선택 (OS 픽커 + 확인 카드 흐름)
}

function freshPanel(api = false): PanelMeta {
  return { title: '', custom: false, color: '', cwd: '', refDirs: [], picker: { ...DEFAULT_PICKER }, api, input: '', images: [], queue: [] }
}
// 저장본의 참조 폴더 위생 — 문자열 배열만, 상한 8 (본채팅 sanitizeRefDirs와 같은 규칙)
function sanitizeRefDirs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && !!s).slice(0, 8) : []
}
// 컬러 태그 순환 팔레트 — 탈채도 기능색(:root 변수명 그대로). 해제 상태는 없다(유저 결정:
// 모든 패널이 항상 색으로 구분). 저장값 ''은 "슬롯 기본색"으로 읽어 예전 저장본도 자동 착색.
const TAG_COLORS = ['violet', 'blue', 'amber', 'teal', 'green', 'yellow', 'red']
function defaultTag(slot: number): string {
  return TAG_COLORS[slot % TAG_COLORS.length]
}
function nextTag(c: string): string {
  return TAG_COLORS[(TAG_COLORS.indexOf(c) + 1) % TAG_COLORS.length]
}
function sanitizeTag(v: unknown): string {
  return typeof v === 'string' && TAG_COLORS.includes(v) ? v : ''
}
// 패널 자동 제목 — 첫 프롬프트(명령이면 카드 제목) 유래. 직접 지정 제목을 비워 저장하면 여기로 복귀
function deriveTitle(text: string): string {
  const cmd = commandOf(text)
  return cmd ? commandTitleOf(cmd) : text.slice(0, 80) || t('파일 첨부', 'File attachment')
}
function blankSession(id: string, count = 4): PersistedSession {
  return {
    id,
    title: '',
    custom: false,
    count,
    panels: SLOTS.map(() => ({ title: '', custom: false, cwd: '', picker: { ...DEFAULT_PICKER } }))
  }
}
function clampCount(n: unknown): number {
  const v = typeof n === 'number' ? n : 4
  return Math.max(2, Math.min(SLOT_COUNT, Math.round(v)))
}
function basename(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : p
}
let sessSeq = 0
function newSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  sessSeq += 1
  return `ms-${sessSeq}-${Date.now().toString(36)}`
}
// the engine/event channel for one panel — unique per (session, slot)
function chan(sessionId: string, slot: number): string {
  return `${sessionId}::${slot}`
}
// aggregate of a session's panel statuses, for the recent-list dot
function aggregateStatus(sts: AgentStatus[]): AgentStatus {
  if (sts.some((s) => s === 'working')) return 'working'
  if (sts.some((s) => s === 'analyzing')) return 'analyzing'
  if (sts.some((s) => s === 'error')) return 'error'
  if (sts.some((s) => s === 'done')) return 'done'
  return 'idle'
}

// stable callback identity that always calls the latest closure (memoized panels skip
// re-render on a sibling's keystroke without stale closures)
function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn)
  ref.current = fn
  return useRef((...args: A) => ref.current(...args)).current
}
// stable per-panel subscribe (read once by the session hook on mount)
function subFor(channel: string) {
  return (cb: (e: EngineEvent) => void): (() => void) => window.api.multi?.onEvent?.(channel, cb) ?? (() => {})
}

// ── one panel's chat (presentational; its session is owned by ActiveSession) ──────
// 패널 안은 본채팅과 완전히 같은 문법(PoC) — .thread 스레드 + WorkBar 5칩 + 진짜
// Composer(모델 칩·"/"·"@"·첨부·예약 포함)를 그대로 쓰고, zoom(.8)으로만 비례 축소한
// 미니어처다. 패널 고유의 것은 헤더(번호·제목·폴더 칩·상태)와 패널 스코프 카드뿐.
interface PanelViewProps {
  slot: number
  meta: PanelMeta
  state: SessionState
  busy: boolean
  elapsed: number
  focused: boolean
  expanded: boolean // 크게 보기 카드로 렌더 중 — 헤더 토글이 '원래 크기로'가 된다
  usage: UsageInfo // WorkBar 컨텍스트 팝오버용 — 이 패널의 실행 계정(바인딩 ?? 기본 계정) 기준
  budgetUsd: number | null // 설정 → API 예산 — API 패널의 WorkBar 비용 행
  totalSpentUsd: number // 전체 워크스페이스 API 누적 사용액
  zoom: number // Ctrl+휠 읽기 크기(chat.zoom 공유) — 멀티에선 전 패널에 함께 적용
  onInput: (slot: number, text: string) => void
  onAddImages: (slot: number, paths: string[]) => void
  onRemoveImage: (slot: number, i: number) => void
  onSend: (slot: number) => void
  onSchedule: (slot: number) => void // queue the draft while the panel is busy
  onRemoveQueued: (slot: number, id: string) => void
  onStop: (slot: number) => void
  onClear: (slot: number) => void // ↑↓ 제스처 — 이 패널의 대화만 백지로 (/clear)
  onPicker: (slot: number, p: PickerState) => void
  apiReady: boolean // Anthropic 키 존재 여부 (없으면 API 선택이 설정을 연다)
  apiReadyCodex: boolean // OpenAI 키 존재 여부 — Codex 패널의 과금 선택용
  onApiMode: (slot: number, next: boolean, engine?: EngineId) => void // 패널별 과금 선택
  onPickFolder: (slot: number) => void // 찾아보기 — OS 폴더 선택
  onSelectFolder: (slot: number, path: string) => void // 작업 폴더 팝오버 목록에서 선택
  onAddRefDir: (slot: number) => void // 참조 폴더(--add-dir) 추가 — OS 픽커
  onAddRefDirPath: (slot: number, path: string) => void // 즐겨찾기/최근 행의 + — 경로 직접 추가
  onRemoveRefDir: (slot: number, path: string) => void
  onOpenFile: (slot: number, rel: string) => void // WorkBar·툴 로그의 파일 → 뷰어
  onOpenSubagent: (slot: number, id: string) => void // WorkBar 서브에이전트 행 → 상세 카드
  onOpenImage: (images: string[], index: number) => void // 스레드/컴포저 이미지 → 뷰어
  onBgTask: (slot: number, req: BgTaskRequest) => void // 백그라운드 셸 중지/Ctrl+B — 이 패널 엔진으로
  onRefreshUsage: (slot: number) => void // 컨텍스트 팝오버를 열 때 이 패널 계정의 사용량 강제 새로고침
  onFocusPanel: (slot: number) => void
  onToggleExpand: (slot: number) => void // 헤더 버튼 — 크게 보기 ⟷ 원래 크기로
  onPermission: (slot: number, behavior: 'allow' | 'allow_always' | 'deny') => void
  onAnswer: (slot: number, answers: string[][]) => void
  onDismissQuestion: (slot: number) => void
  renaming: boolean // 제목 인라인 편집 중 — 더블클릭/연필/F2로 진입 (상태는 ActiveSession 소유)
  onStartRename: (slot: number) => void
  onRename: (slot: number, title: string | null, custom: boolean) => void // null = 취소(닫기만)
  onCycleColor: (slot: number) => void // 번호 칩 클릭 — 컬러 태그 순환
}

const PanelView = memo(function PanelView({
  slot,
  meta,
  state,
  busy,
  elapsed,
  focused,
  expanded,
  usage,
  budgetUsd,
  totalSpentUsd,
  zoom,
  onInput,
  onAddImages,
  onRemoveImage,
  onSend,
  onSchedule,
  onRemoveQueued,
  onStop,
  onClear,
  onPicker,
  apiReady,
  apiReadyCodex,
  onApiMode,
  onPickFolder,
  onSelectFolder,
  onAddRefDir,
  onAddRefDirPath,
  onRemoveRefDir,
  onOpenFile,
  onOpenSubagent,
  onOpenImage,
  onBgTask,
  onRefreshUsage,
  onFocusPanel,
  onToggleExpand,
  onPermission,
  onAnswer,
  onDismissQuestion,
  renaming,
  onStartRename,
  onRename,
  onCycleColor,
}: PanelViewProps) {
  useLang() // 언어 전환 재렌더 구독 (memo 컴포넌트라 루트 재렌더를 안 탄다)
  const scrollRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  // 마우스 제스처(↑/↓) 대상 — 이 패널의 스레드 엘리먼트를 state로 추적 (패널별 독립)
  const [threadEl, setThreadEl] = useState<HTMLDivElement | null>(null)
  const threadRef = useMemo(() => mergeRefs(scrollRef, setThreadEl), [])
  // 폴더 칩에서 펼쳐지는 작업 폴더 팝오버 — 본채팅 헤더와 같은 FolderPop(공유 최근 폴더)
  const [folderPop, setFolderPop] = useState(false)

  const cwd = meta.cwd || ''
  // 폴더를 고르지 않으면 엔진이 바탕화면에서 동작한다 — 라벨로 그 기본값을 알린다
  const cwdLabel = meta.cwd ? basename(meta.cwd) : t('바탕화면', 'Desktop')

  // 승인/질문 카드가 떠 있는 동안은 상태를 "응답 대기"로 덮어쓴다 — 엔진은 busy지만
  // 실제로는 사용자를 기다리는 중이라, 그냥 작업 중인 패널과 한눈에 구분돼야 한다
  const waiting = !!(state.pendingPermission || state.pendingQuestion)
  const status = waiting ? { label: () => t('응답 대기', 'Needs input'), cls: 'ask' } : STATUS_META[state.status]
  const started = state.messages.length > 0
  // 턴을 막고 있는 포그라운드 Bash가 있을 때만 셸 팝오버에 "건너뛰기"(Ctrl+B) 노출 (본채팅과 동일)
  const canSkipWait = useMemo(() => hasRunningBash(state.messages), [state.messages])

  // 이 패널의 사용자 메시지(오래된→최신) — ↑↓ 히스토리·첫 지시 미리보기·자동 제목 복귀의 공용 재료
  const userMsgs = useMemo(
    () =>
      state.messages.filter(
        (m): m is Extract<SessionState['messages'][number], { kind: 'msg' }> => m.kind === 'msg' && m.role === 'user'
      ),
    [state.messages]
  )
  // 작성칸에서 ↑/↓로 셸처럼 다시 불러오는 히스토리
  const sentHistory = useMemo(() => userMsgs.map((m) => m.text).filter((t) => t.trim().length > 0), [userMsgs])
  // 첫 지시 — 제목 호버 미리보기 카드의 원문 (제목은 요약, 원문은 한 호버 거리에)
  const firstUser = userMsgs[0]

  // 제목 편집 커밋은 한 번만 — Enter 커밋 직후 인풋 언마운트가 blur를 한 번 더 쏴도 재진입 없음
  const renameDoneRef = useRef(false)
  // 포커스+전체선택은 편집 진입 때 한 번만 — 인라인 ref 콜백은 렌더마다 재실행이라
  // 스트리밍(토큰마다 재렌더) 중엔 입력할 때마다 전체선택이 다시 걸려 글자가 덮여 지워졌다
  const renameInRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!renaming) return
    renameDoneRef.current = false
    renameInRef.current?.focus()
    renameInRef.current?.select()
  }, [renaming])
  const commitRename = (v: string | null): void => {
    if (renameDoneRef.current) return
    renameDoneRef.current = true
    if (v === null) return onRename(slot, null, false)
    const tv = v.trim()
    // 자동 제목을 안 고치고 닫음 → custom으로 잠그지 않는다 / 비워서 저장 → 자동 제목 복귀
    if (!tv) return onRename(slot, firstUser ? deriveTitle(firstUser.text) : '', false)
    if (tv === meta.title && !meta.custom) return onRename(slot, null, false)
    onRename(slot, tv, true)
  }

  // "더 자세히" — 채팅에서 선택한 글을 <selection> 태그로 감싸 이 패널의 작성칸에 붙인다
  // (단일 모드와 동일). 작성칸에 이미 글이 있으면 아래에 이어 붙인다.
  const onElaborate = (text: string): void => {
    const sel = `<selection>\n${text.trim()}\n</selection>\n\n${t('이 부분 더 자세히 설명해줘', 'Explain this part in more detail')}`
    onInput(slot, meta.input.trim() ? meta.input + '\n\n' + sel : sel)
    onFocusPanel(slot)
    requestAnimationFrame(() => {
      const el = composerRef.current
      if (!el) return
      el.focus()
      const n = el.value.length
      el.setSelectionRange(n, n)
    })
  }

  // 첨부 파일 선택 — 진짜 Composer의 [+] 버튼이 부른다 (본채팅과 같은 OS 픽커)
  const pickImages = async (): Promise<void> => {
    const paths = await window.api.pickAttachments()
    if (paths.length) onAddImages(slot, paths)
  }

  // 스레드 바닥 따라가기 — 본채팅과 같은 의도 래치(useThreadFollow): 스트리밍 중에도
  // 휠 업이면 따라가기를 풀어 위 내용을 읽을 수 있고, 바닥에 다시 닿으면 재개된다.
  // (예전의 무조건 scrollTop=scrollHeight는 실행 중 위로 못 올라가는 원인이었다)
  const follow = useThreadFollow(threadEl, busy)
  // 꼬리 윈도잉 — 패널마다 독립 (긴 세션 DOM 상주가 패널 수만큼 곱해지는 걸 막는다)
  const twin = useThreadWindow(threadEl, state.messages.length)
  useEffect(() => {
    follow.snapIfStuck()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.messages, state.thinkingText])

  // 작업 인디케이터는 '답변 본문 스트리밍 중'에만 숨긴다 — 사고·도구·침묵 구간엔 계속 띄운다
  const showWorking = !state.streaming && !state.pendingQuestion && !state.pendingCommand
  // 스트리밍 중 매 토큰 렌더에서 MessageView memo가 유지되도록 — 인라인 화살표를 넘기면
  // 매 렌더 새 함수 정체성이 완료된 메시지까지 전부 리렌더(마크다운 재파싱)시킨다
  const openFile = useEvent((p: string) => onOpenFile(slot, p))
  // 같은 이유로 memo인 WorkBar의 콜백들도 안정 정체성으로 — 순수 텍스트 스트리밍 중엔
  // 나머지 props(할 일·파일·서브에이전트 배열)가 그대로라 WorkBar가 통째로 스킵된다
  const openChangedFile = useEvent((f: ChangedFile) => onOpenFile(slot, f.path))
  const openSubagent = useEvent((a: SubAgentInfo) => onOpenSubagent(slot, a.id))
  const bgTask = useEvent((req: BgTaskRequest) => onBgTask(slot, req))
  const refreshUsage = useEvent(() => onRefreshUsage(slot))
  // 메시지마다 liveMsgIndex를 다시 계산하지 않게 map 밖에서 한 번만
  const liveIdx = liveMsgIndex(state.messages)

  return (
    <div
      className={'ma-panel' + (state.status === 'done' ? ' done' : '') + (focused ? ' focused' : '')}
      data-slot={slot}
      // 이 패널의 컬러 태그를 변수로 — 헤더 하단 라인(.ma-p-tag)과 완료 테두리(.done)가 같이 쓴다
      style={{ '--ptag': `var(--${meta.color || defaultTag(slot)})` } as CSSProperties}
      onMouseDown={() => onFocusPanel(slot)}
    >
      {/* PoC .mph — 한 줄 헤더: [번호][제목] ─ [폴더 칩][상태 칩]. 컨텍스트·모델·과금은
          아래 WorkBar·Composer(본채팅 문법)가 이미 말하므로 헤더는 신원과 상태만 남긴다 */}
      <div className="ma-p-head">
        {/* 번호 칩 = 컬러 태그 토글 — 클릭마다 7색 순환 후 해제. 색은 헤더 하단 라인(.ma-p-tag)에 */}
        <button
          className={'ma-p-num has-tip' + (focused ? ' on' : '')}
          data-tip={t('컬러 태그 — 클릭해 색 변경', 'Color tag — click to change')}
          onClick={() => onCycleColor(slot)}
        >
          {slot + 1}
        </button>
        {/* 제목 묶음 — 더블클릭/연필/F2로 그 자리 편집, 호버 0.35s 후 첫 지시 원문 미리보기 */}
        <span className="ma-p-tw">
          {renaming ? (
            <input
              className="ma-p-tin"
              defaultValue={meta.title}
              placeholder={t('패널 제목', 'Panel title')}
              ref={renameInRef}
              onKeyDown={(e) => {
                // Esc가 패널 키보드(실행 취소 분기)로 새면 안 된다 — 편집 중 키는 여기서 끝
                e.stopPropagation()
                if (e.key === 'Enter') commitRename(e.currentTarget.value)
                else if (e.key === 'Escape') commitRename(null)
              }}
              onBlur={(e) => commitRename(e.currentTarget.value)}
              onMouseDown={(e) => e.stopPropagation()}
            />
          ) : (
            <>
              <span className={'ma-p-title' + (meta.custom ? ' custom' : '')} onDoubleClick={() => onStartRename(slot)}>
                {meta.title || t('새 작업', 'New task')}
              </span>
              <button
                className="ma-p-tedit"
                aria-label={t('패널 이름 바꾸기 (F2)', 'Rename panel (F2)')}
                onClick={() => onStartRename(slot)}
              >
                <IconPencil size={11} />
              </button>
              {firstUser && (
                <span className="ma-p-peek">
                  <span className="pk-l">
                    {t('첫 지시', 'First instruction')} · {firstUser.time} ·{' '}
                    {t(`${userMsgs.length}턴`, `${userMsgs.length} turn${userMsgs.length > 1 ? 's' : ''}`)}
                  </span>
                  <span className="pk-b">{firstUser.text.trim() || t('파일 첨부', 'File attachment')}</span>
                </span>
              )}
            </>
          )}
        </span>
        <span className="ma-spacer" />
        {/* 작업 폴더 칩 — 본채팅 헤더와 같은 FolderPop(공유 최근 폴더 + 찾아보기)이 열린다.
            .hfold 래퍼가 팝오버 기준점 + 안쪽 클릭의 바깥닫힘 전파 차단을 겸한다 */}
        <span className="hfold" onMouseDown={(e) => e.stopPropagation()}>
          {/* 팝오버가 열려 있는 동안은 has-tip을 떼어 툴팁이 팝오버 위에 겹치지 않게 한다 */}
          <button
            className={'ma-p-folder' + (folderPop ? ' on' : ' has-tip tip-wrap')}
            data-tip={
              meta.cwd
                ? meta.cwd + t(' · 클릭해 폴더 변경', ' · Click to change folder')
                : t('바탕화면 · 클릭해 폴더 선택', 'Desktop · Click to choose a folder')
            }
            onClick={() => {
              onFocusPanel(slot)
              setFolderPop((o) => !o)
            }}
          >
            <IconFolder size={11} />
            <span className="ma-p-folder-name">{cwdLabel}</span>
            {/* 참조 폴더가 있으면 +N (본채팅 폴더 칩과 같은 표시) */}
            {meta.refDirs.length > 0 && <span className="fsel-ref">+{meta.refDirs.length}</span>}
            <IconChevDown size={10} />
          </button>
          {folderPop && (
            <FolderPop
              right
              cwd={meta.cwd}
              onSelect={(p) => onSelectFolder(slot, p)}
              onBrowse={() => onPickFolder(slot)}
              onClose={() => setFolderPop(false)}
              refDirs={meta.refDirs}
              onAddRef={() => onAddRefDir(slot)}
              onAddRefPath={(p) => onAddRefDirPath(slot, p)}
              onRemoveRef={(p) => onRemoveRefDir(slot, p)}
            />
          )}
        </span>
        <span className={'ma-status ' + status.cls}>
          {/* 응답 대기 중엔 스피너를 숨긴다 — 도는 건 에이전트가 아니라 사용자 차례 */}
          {busy && !waiting && <span className="ma-status-spin" />}
          <span>{status.label()}</span>
          {busy && <span className="ma-status-time">{fmtElapsed(elapsed)}</span>}
        </span>
        {/* 크게 보기 ⟷ 원래 크기로 — 이 패널을 본채팅 크기의 오버레이 카드로 (작은 글씨 대책) */}
        <button
          className="ma-p-expand has-tip"
          data-tip={expanded ? t('원래 크기로 (Esc)', 'Restore size (Esc)') : t('크게 보기', 'Expand')}
          aria-label={expanded ? t('원래 크기로', 'Restore size') : t('크게 보기', 'Expand')}
          onClick={() => onToggleExpand(slot)}
        >
          {expanded ? <IconCollapse size={12} /> : <IconExpand size={12} />}
        </button>
        {/* 컬러 태그 — 헤더 하단 전폭 2px 라인. 기본은 슬롯 색(1=보라, 2=파랑…), 번호 칩 클릭으로 순환.
            색은 패널 루트의 --ptag(완료 테두리와 공유) */}
        <span className="ma-p-tag" />
      </div>

      <div className="ma-p-body">
        <div className="ma-p-thread scroll" ref={threadRef}>
          {!started && !busy ? (
            <div className="ma-p-empty">
              {/* 공식 로봇 마스코트 — 웰컴 화면(.wc-mark)과 같은 정지 아이콘 */}
              <div className="ma-p-empty-ic">
                <IconMascot size={38} />
              </div>
              <div className="ma-p-empty-text">{t('메시지를 입력해 작업을 시작하세요', 'Type a message to start working')}</div>
            </div>
          ) : (
            // 본채팅과 같은 .thread 마크업 — 패널에선 CSS(zoom .8·풀폭)만 다르고,
            // Ctrl+휠 읽기 크기(chat.zoom)는 그 위에 곱으로 얹힌다(전 패널 공통)
            <div className="thread" style={{ zoom, '--z': zoom } as CSSProperties}>
              {twin.start > 0 && <div className="thread-older" ref={twin.sentinelRef} aria-hidden="true" />}
              {state.messages.slice(twin.start).map((m, i) => (
                <MessageView
                  key={m.id}
                  item={m}
                  live={twin.start + i === liveIdx && m.kind === 'msg' && m.role === 'assistant' && !m.error}
                  running={busy}
                  onOpenFile={openFile}
                  onOpenImage={onOpenImage}
                />
              ))}
              {busy && showWorking && <WorkingIndicator elapsed={elapsed} />}
            </div>
          )}
          {/* 따라가기를 풀고 위를 읽는 중 — 본채팅과 같은 "맨 아래로" 점프 버튼 */}
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
        <ChatFind scrollRef={scrollRef} active={focused} panel onOpenChange={(o) => o && twin.reveal()} />
      </div>

      <SelectionToolbar scrollRef={scrollRef} onElaborate={onElaborate} />
      {/* 그리드에선 RU(→↑, 최대화 문법)=크게 보기, 카드에선 DR(↓→, 닫기 문법)=원래
          크기로. 카드의 RU 토글 닫기는 최대화 제스처와 헷갈려 뺐다(사용자 피드백) —
          닫기는 다른 카드·뷰어와 같은 ↓→ 하나로 통일 */}
      <MouseGestureLayer
        target={threadEl}
        actions={[
          // ↑/↓는 follow 래치 규칙(본채팅과 동일) — ↑는 윈도를 다 펼치고 고정을 풀며 올라간다
          { pattern: 'U', label: t('맨 위로', 'Scroll to top'), run: () => { twin.showAll(); follow.scrollTop() } },
          { pattern: 'D', label: t('맨 아래로', 'Scroll to bottom'), run: () => follow.jumpBottom() },
          sessionWindowGesture(),
          clearGesture(() => onClear(slot)),
          ...(expanded
            ? [{ pattern: 'DR', label: t('원래 크기로', 'Restore size'), run: () => onToggleExpand(slot) }]
            : [{ pattern: 'RU', label: t('크게 보기', 'Expand'), run: () => onToggleExpand(slot) }])
        ]}
      />

      {/* 본채팅과 완전히 같은 WorkBar(할 일·서브에이전트·백그라운드 셸·변경된 파일·컨텍스트)
          + 진짜 Composer(모델 칩·"/" 팔레트·"@" 멘션·첨부·예약 큐) — zoom .8 미니어처 */}
      <WorkBar
        todos={state.todos}
        files={state.files}
        subagents={state.subagents}
        bgTasks={state.bgTasks}
        busy={busy}
        canSkipWait={canSkipWait}
        onBgTask={bgTask}
        usage={usage}
        contextTokens={state.result?.contextTokens ?? null}
        contextWindow={state.result?.contextWindow ?? null}
        model={meta.picker.model}
        apiMode={meta.api}
        chatSpentUsd={state.spentUsd ?? 0}
        budgetUsd={budgetUsd}
        totalSpentUsd={totalSpentUsd}
        tokenTotals={state.tokenTotals}
        engine={meta.picker.engine}
        codexAccount={meta.picker.codexAccount}
        onOpenFile={openChangedFile}
        onOpenSubagent={openSubagent}
        onRefreshUsage={refreshUsage}
      />
      <Composer
        value={meta.input}
        onChange={(t) => onInput(slot, t)}
        history={sentHistory}
        // 전송 = 따라가기 재개 — 위를 읽던 중이어도 내 메시지와 답이 시야로 (본채팅과 동일)
        onSend={() => {
          follow.pin()
          onSend(slot)
        }}
        onStop={() => onStop(slot)}
        onSchedule={() => onSchedule(slot)}
        queued={meta.queue}
        onRemoveQueued={(id) => onRemoveQueued(slot, id)}
        busy={busy}
        started={started}
        picker={meta.picker}
        setPicker={(p) => onPicker(slot, p)}
        apiMode={meta.api}
        apiReady={apiReady}
        apiReadyCodex={apiReadyCodex}
        onApiModeChange={(next, eng) => onApiMode(slot, next, eng)}
        images={meta.images}
        onPickImages={pickImages}
        onAddImagePaths={(paths) => onAddImages(slot, paths)}
        onRemoveImage={(i) => onRemoveImage(slot, i)}
        onOpenImage={onOpenImage}
        cwd={cwd}
        mentionBase={cwd}
        inputRef={composerRef}
      />

      {/* 패널 스코프 카드 — .ma-panel(position:relative) 안에서 그 패널만 덮으므로
          어느 패널의 요청인지 위치로 식별된다. 키보드는 포커스된 패널의 카드만
          받는다 — 동시에 여러 카드가 떠도 키 한 번이 전부에 응답되지 않도록. */}
      <WorkflowDock wfs={state.workflows} onStop={(id) => onBgTask(slot, { action: 'stop', id })} />
      <PermissionModal
        permission={state.pendingPermission}
        onRespond={(b) => onPermission(slot, b)}
        hotkeys={focused}
      />
      <QuestionModal
        question={state.pendingQuestion}
        onAnswer={(a) => onAnswer(slot, a)}
        onDismiss={() => onDismissQuestion(slot)}
        hotkeys={focused}
      />
    </div>
  )
})

function fmtElapsed(s: number): string {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

// ── one active multi-agent session: its panel grid + header (keyed by sessionId in the
//    workspace, so switching sessions cleanly remounts a fresh set of 6 panel hooks) ──
function ActiveSession({
  sessionId,
  initial,
  usage,
  apiMode,
  apiReady,
  apiReadyCodex,
  onOpenApiSettings,
  onFirstPrompt,
  onStatus,
  onCommit,
  onExplorerInfo,
  explorerHidden,
  onToggleExplorer
}: {
  sessionId: string
  initial: PersistedSession
  usage: UsageInfo
  apiMode: boolean // 전역 과금 모드 — 새 패널/예전 저장본의 기본값 시드로만 쓴다
  apiReady: boolean // Anthropic 키 존재 여부 — 없으면 패널에서 API 선택 시 설정을 연다
  apiReadyCodex: boolean // OpenAI 키 존재 여부 — Codex 패널의 API 선택 가드
  onOpenApiSettings: () => void // 설정 → API 탭 열기 (키 미등록 가드)
  onFirstPrompt: (sessionId: string, prompt: string) => void
  onStatus: (sessionId: string, status: AgentStatus) => void
  onCommit: (sessionId: string, payload: CommitPayload) => void
  onExplorerInfo?: (info: MultiExplorerInfo) => void // 왼쪽 칼럼 탐색기가 따라갈 패널 보고
  explorerHidden?: boolean // 탐색기가 내려가 있는가 — 헤더 토글 버튼의 상태 표시
  onToggleExplorer?: () => void // 헤더 토글 버튼 — 사이드바 ⟷ 탐색기 (본채팅 헤더와 동일)
}) {
  // every slot's session — six fixed hook calls, subscribed for this session's lifetime
  const s0 = useAgentSession(subFor(chan(sessionId, 0)))
  const s1 = useAgentSession(subFor(chan(sessionId, 1)))
  const s2 = useAgentSession(subFor(chan(sessionId, 2)))
  const s3 = useAgentSession(subFor(chan(sessionId, 3)))
  const s4 = useAgentSession(subFor(chan(sessionId, 4)))
  const s5 = useAgentSession(subFor(chan(sessionId, 5)))
  const sessions = [s0, s1, s2, s3, s4, s5]

  // 계정별 한도 사용량(키=계정 이메일, ''=기본 계정) — 컨텍스트 한도는 "그 패널이
  // 실제로 소비할 계정" 기준이어야 해서(본채팅 picker.account와 같은 계약) 전역 한 장이
  // 아니라 계정별로 들고, 각 패널 WorkBar엔 그 패널 실행 계정의 것만 준다. App이 준
  // usage는 기본 계정 항목의 첫 화면 시드 — 아래 프리페치가 곧 제 계정 값으로 덮는다.
  const [acctUsage, setAcctUsage] = useState<Record<string, UsageInfo>>(() => ({ '': usage }))
  const fetchAcctUsage = useEvent((acct: string, fresh: boolean) => {
    window.api
      .getUsage(fresh, acct || undefined)
      .then((u) => setAcctUsage((p) => ({ ...p, [acct]: u })))
      .catch(() => {})
  })
  const busyCount = sessions.filter((s) => s.busy).length
  const prevBusyCountRef = useRef(busyCount)
  // 패널 실행이 하나라도 끝나면 +1 — 왼쪽 탐색기가 루트+펼친 폴더를 다시 읽어 방금
  // 생성/삭제된 파일이 새로고침 없이 보인다 (본채팅 fsTick과 같은 규칙)
  const [fsTick, setFsTick] = useState(0)

  const [count, setCount] = useState(() => clampCount(initial.count))
  const [metas, setMetas] = useState<PanelMeta[]>(() =>
    SLOTS.map((i) => {
      const p = initial.panels?.[i]
      return p
        ? {
            title: p.title ?? '',
            custom: !!p.custom,
            color: sanitizeTag(p.color),
            cwd: typeof p.cwd === 'string' ? p.cwd : '',
            refDirs: sanitizeRefDirs(p.refDirs),
            picker: sanitizePanelPicker(p.picker),
            // 패널별 과금 — 예전 저장본(필드 없음)은 현재 전역 모드를 기본값으로
            api: p.api ?? apiMode,
            input: '',
            images: [],
            queue: []
          }
        : freshPanel(apiMode)
    })
  )

  // 보이는 패널들의 실행 계정(바인딩 ?? 기본 계정) — Codex 패널은 Anthropic 한도를 안
  // 그리니 제외. 구성이 바뀔 때만 미리 받아 둬(메인의 계정별 5분 캐시라 가볍다) 컨텍스트
  // 팝오버 첫 열림이 '데이터 없음'으로 시작하지 않게 한다.
  const acctSig = JSON.stringify(
    Array.from(new Set(metas.slice(0, count).filter((m) => m.picker.engine !== 'codex').map((m) => m.picker.account ?? ''))).sort()
  )
  useEffect(() => {
    ;(JSON.parse(acctSig) as string[]).forEach((a) => fetchAcctUsage(a, false))
    // fetchAcctUsage는 useEvent(stable) — 계정 구성 시그니처에만 의존
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acctSig])
  // 사용량은 App이 단일 모드 실행에만 갱신한다 — 멀티 패널 실행이 끝날 때는 여기서 직접
  // 강제 새로고침해(패널 계정 전부 — 연타는 메인의 계정별 15초 바닥 TTL이 흡수) 컨텍스트
  // 팝오버의 한도·추가 크레딧이 방금 소비를 바로 반영하게 한다.
  useEffect(() => {
    const was = prevBusyCountRef.current
    prevBusyCountRef.current = busyCount
    if (busyCount < was) {
      ;(JSON.parse(acctSig) as string[]).forEach((a) => fetchAcctUsage(a, true))
      setFsTick((t) => t + 1)
    }
    // acctSig·fetchAcctUsage는 트리거가 아니라 재료 — busy 감소 순간에만 동작한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busyCount])

  const [focusedSlot, setFocusedSlot] = useState<number | null>(null)
  // 제목 인라인 편집 중인 슬롯 — F2(포커스 패널)·더블클릭·연필로 진입, 커밋/취소로 해제
  const [renamingSlot, setRenamingSlot] = useState<number | null>(null)
  // 포커스 밖 알림 — 6패널 각각의 전이(턴 종료/승인/질문)를 감시한다. sub=슬롯이라
  // 패널별로 항목이 따로 쌓이고, 클릭 라우팅은 세션 단위(이 세션이 열린다).
  useTurnNotifyList(
    sessions.map((s, i) => ({
      state: s.state,
      busy: s.busy,
      title: metas[i].title,
      target: { surface: 'multi' as const, id: sessionId, sub: String(i) }
    }))
  )
  // Ctrl+휠 읽기 크기 — 멀티 전용 배율(multi.zoom, 기본 120%): 패널은 미니어처(zoom .8)라
  // 시작점을 키워 두고, 본채팅(chat.zoom)·추가 채팅(session.zoom)과는 독립이다.
  // 그리드에서 굴리면 전 패널에 함께 적용된다.
  const multiZoom = useZoom('multi.zoom', true, 1.2)
  // 크게 보기 — 이 슬롯의 패널을 본채팅 크기의 오버레이 카드로 띄운다. 패널 상태는 전부
  // 이 컴포넌트 소유라 같은 PanelView를 자리만 옮겨 그리면 스레드·초안·실행이 그대로다
  // (그리드 자리엔 고스트). 영속 안 함 — 세션 전환·재시작이면 접힌 채 시작.
  const [expandedSlot, setExpandedSlot] = useState<number | null>(null)
  // 카드 안 Ctrl+휠 읽기 크기 — 그리드(multi.zoom 120%)와 독립인 표면, 기본 100%(본채팅 크기)
  const expandZoom = useZoom('multi.expand.zoom', expandedSlot != null, 1)
  // a folder change that would reset a panel's conversation, parked here until the user
  // confirms it in the card modal (변경) or backs out (취소)
  const [pendingFolder, setPendingFolder] = useState<{ slot: number; cwd: string } | null>(null)
  // 폴더 팝오버에서 연 파일 — 그 패널의 cwd·diffs로 코드 뷰어를 띄운다 (패널 안이 아니라
  // 여기서 한 번만 렌더해야 .fv-overlay(absolute)가 패널의 스태킹 컨텍스트에 갇혀
  // 그 패널 영역 안에서만 뜨는 사고가 없다)
  const [openFile, setOpenFile] = useState<{ slot: number; path: string } | null>(null)
  // WorkBar 서브에이전트 행에서 연 상세 카드 — 열려 있는 동안 그 패널의 라이브 상태를 따른다
  const [openSub, setOpenSub] = useState<{ slot: number; id: string } | null>(null)
  // 스레드/컴포저 이미지 → 라이트박스 (본채팅과 동일한 뷰어를 세션 레벨에서 한 번만)
  const [viewer, setViewer] = useState<{ images: string[]; index: number } | null>(null)

  // restore each panel's saved thread into its live session, once on mount
  useEffect(() => {
    initial.panels?.forEach((p, i) => {
      if (p?.snapshot && i < SLOT_COUNT) sessions[i].load(sanitizeSnapshot(p.snapshot))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Fable 5 정책 거부(claude)·모델 수용량 초과(codex) → 엔진이 폴백 모델로 전환·재시도한
  // 패널은 picker도 따라 바꾼다(안 바꾸면 그 패널은 매번 오류→전환을 반복). 경고 배너는
  // 스레드에 표시된다.
  useEffect(() => {
    const offs = SLOTS.map(
      (slot) =>
        window.api.multi?.onEvent?.(chan(sessionId, slot), (e) => {
          if (e.type !== 'model-fallback') return
          if (e.engine === 'codex') {
            setMetas((prev) =>
              prev.map((m, i) =>
                i === slot && m.picker.codexModel !== e.toModel ? { ...m, picker: { ...m.picker, codexModel: e.toModel } } : m
              )
            )
            return
          }
          const next = pickerModelOf(e.toModel)
          if (next)
            setMetas((prev) =>
              prev.map((m, i) => (i === slot && m.picker.model !== next ? { ...m, picker: { ...m.picker, model: next } } : m))
            )
        }) ?? (() => {})
    )
    return () => offs.forEach((off) => off())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // cheap signature of every panel session (status + message count)
  const sig = sessions.map((s) => s.state.status + ':' + s.state.messages.length).join('|')

  // report aggregate status up for the recent-list dot
  const aggStatus = aggregateStatus(sessions.map((s) => s.state.status))
  useEffect(() => {
    onStatus(sessionId, aggStatus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aggStatus])

  // 예산(전역 누적) — API 과금 패널의 WorkBar 컨텍스트 팝오버(비용 행)용. API 패널이
  // 있을 때만 읽고, 실행이 끝날 때마다 다시 읽어 실행 직후 바로 맞아떨어지게 한다
  const billApi = SLOTS.slice(0, count).filter((i) => metas[i].api).length
  const [budget, setBudget] = useState<{ budgetUsd: number | null; spentUsd: number } | null>(null)
  useEffect(() => {
    if (!billApi) return
    window.api.apiConfig
      .get()
      .then((s) => setBudget({ budgetUsd: s.budgetUsd ?? null, spentUsd: s.spentUsd ?? 0 }))
      .catch(() => {})
  }, [billApi, aggStatus])

  // build the persistable form of this session (latest closure kept in a ref so the
  // unmount commit captures the final state)
  const buildRef = useRef<() => CommitPayload>(() => ({ count, panels: [] }))
  buildRef.current = () => ({
    count,
    panels: SLOTS.map((i) => {
      const m = metas[i]
      return {
        title: m.title,
        custom: m.custom,
        color: m.color,
        cwd: m.cwd,
        refDirs: m.refDirs,
        picker: m.picker,
        api: m.api,
        snapshot: snapshotForPersist(sessions[i].state)
      }
    })
  })
  // commit (debounced) on any change, and immediately on unmount (session switch)
  useEffect(() => {
    const t = setTimeout(() => onCommit(sessionId, buildRef.current()), 600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, metas, sig])
  useEffect(() => {
    return () => onCommit(sessionId, buildRef.current())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Panel keyboard control (only while focus isn't in a field):
  //  · 1‥N        jump straight into that panel's composer (selects it + focuses the input)
  //  · Enter      drop the cursor into the selected panel's composer (e.g. after a click)
  //  · Esc        cancel the focused panel's RUN if it's busy (단일 모드의 Esc=작업 취소와
  //               같은 기대), else release the selection
  // A permission/question card owns the keyboard while open, so we always stand down then.
  //
  // 이벤트 시점의 busy를 읽어야 해서 useEvent — 키보드 effect는 [focusedSlot, count]에만
  // 재바인딩되므로 클로저의 sessions는 그 사이 얼어 있다(막 busy로 바뀐 패널을
  // 못 보고 선택만 풀던 원인).
  const escCancelPanel = useEvent((slot: number): boolean => {
    const sess = sessions[slot]
    // 상주 워크플로(busy=false지만 도는 중)도 Esc 취소 대상 — 중지 버튼과 같은 의미.
    // 회수(턴 걷기 + 문장 복원)는 stopPanel이 공통으로 처리한다.
    if (!sess.busy && !sess.state.workflows.some((w) => w.status === 'running')) return false
    stopPanel(slot)
    return true
  })
  // 포커스 없이 Esc — 도는 패널(busy 또는 상주 워크플로)이 딱 하나면 그걸 취소한다.
  // 여럿이면 어느 걸 멈추라는 건지 모호하므로 가만히 둔다(패널을 포커스해 취소).
  const escCancelSole = useEvent((): boolean => {
    const running = sessions
      .map((s, i) => (s.busy || s.state.workflows.some((w) => w.status === 'running') ? i : -1))
      .filter((i) => i >= 0)
    return running.length === 1 ? escCancelPanel(running[0]) : false
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 앱 전역 오버레이(폴더 확인 / 프롬프트 모달 / 파일 뷰어 / 폴더 팝오버)가 열려
      // 있으면 항상 양보한다
      if (document.querySelector('.set-dialog-overlay, .pr-overlay, .fv-overlay, .hpop')) return
      // 승인/질문 카드는 패널 안에 뜬다(스코프 오버레이). 키보드를 받는 건 포커스된
      // 패널의 카드뿐이니 그때만 양보하고, 다른 패널의 카드는 1‥N 이동을 막지 않는다 —
      // 번호를 누르면 그 패널이 포커스되며 카드가 키를 넘겨받는다. 패널 밖 .q-overlay
      // (ask 모달의 질문 등)는 예전처럼 전역으로 키보드를 가진다.
      for (const el of Array.from(document.querySelectorAll('.q-overlay'))) {
        const panel = el.closest('.ma-panel')
        if (!panel || panel.classList.contains('focused')) return
      }
      const ae = document.activeElement as HTMLElement | null
      const typing = !!ae && (['INPUT', 'TEXTAREA', 'SELECT'].includes(ae.tagName) || ae.isContentEditable)

      if (e.key === 'Escape') {
        // 크게 보기가 떠 있으면 먼저 접는다 — 오버레이의 표준 기대. 실행 취소는 접힌 뒤
        // 다시 Esc(또는 카드 안 중지 버튼)로.
        if (expandedSlot != null) {
          e.preventDefault()
          setExpandedSlot(null)
          return
        }
        if (focusedSlot != null) {
          e.preventDefault()
          // 실행 중인 패널이면 선택 해제가 아니라 그 패널의 실행 취소 — 포커스는 유지해
          // 이어서 바로 다음 지시를 입력할 수 있다. 대기 패널일 때만 선택을 놓는다.
          if (!escCancelPanel(focusedSlot)) {
            setFocusedSlot(null)
            if (typing) ae?.blur()
          }
        } else if (escCancelSole()) {
          e.preventDefault()
        }
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey || typing) return

      // F2 = 포커스 패널의 제목 편집 — 사이드바 F2(세션 이름 변경)는 패널 선택 중엔 양보한다
      if (e.key === 'F2' && focusedSlot != null) {
        e.preventDefault()
        setRenamingSlot(focusedSlot)
        return
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        const ta = document.querySelector('.ma-panel.focused .composer textarea') as HTMLTextAreaElement | null
        if (ta) {
          e.preventDefault()
          ta.focus()
        }
        return
      }
      const n = parseInt(e.key, 10)
      if (Number.isInteger(n) && n >= 1 && n <= count) {
        e.preventDefault()
        const slot = n - 1
        setFocusedSlot(slot)
        // 크게 보기 중엔 카드를 그 패널로 갈아끼운다 — 숫자 키로 패널들을 크게 넘겨본다
        if (expandedSlot != null) {
          setExpandedSlot(slot)
          requestAnimationFrame(() => {
            const ta = document.querySelector('.ma-expand-card .composer textarea') as HTMLTextAreaElement | null
            ta?.focus()
          })
          return
        }
        // jump straight into that panel's composer (next frame, once the grid is settled)
        requestAnimationFrame(() => {
          const ta = document.querySelector(
            `.ma-grid .ma-panel[data-slot="${slot}"] .composer textarea`
          ) as HTMLTextAreaElement | null
          ta?.focus()
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusedSlot, count, expandedSlot])

  // ── stable per-panel handlers ──
  const patchMeta = useEvent((slot: number, patch: Partial<PanelMeta>) =>
    setMetas((prev) => prev.map((m, i) => (i === slot ? { ...m, ...patch } : m)))
  )
  const onInput = useEvent((slot: number, text: string) => patchMeta(slot, { input: text }))
  // 패널별 과금 선택 — API를 골랐는데 그 패널 엔진의 키가 없으면 켜는 대신 설정 → API 탭을 연다
  const onPanelApi = useEvent((slot: number, next: boolean, engine?: EngineId) => {
    const ready = engine === 'codex' ? apiReadyCodex : apiReady
    if (next && !ready) {
      onOpenApiSettings()
      return
    }
    patchMeta(slot, { api: next })
  })
  const onAddImages = useEvent((slot: number, paths: string[]) =>
    setMetas((prev) => prev.map((m, i) => (i === slot ? { ...m, images: Array.from(new Set([...m.images, ...paths])) } : m)))
  )
  const onRemoveImage = useEvent((slot: number, idx: number) =>
    setMetas((prev) => prev.map((m, i) => (i === slot ? { ...m, images: m.images.filter((_, j) => j !== idx) } : m)))
  )
  const onPicker = useEvent((slot: number, picker: PickerState) => patchMeta(slot, { picker }))
  const onFocusPanel = useEvent((slot: number) => setFocusedSlot(slot))
  // ── 패널 제목 편집 + 컬러 태그 ──
  const onStartRename = useEvent((slot: number) => {
    setFocusedSlot(slot)
    setRenamingSlot(slot)
  })
  const onRenamePanel = useEvent((slot: number, title: string | null, custom: boolean) => {
    setRenamingSlot(null)
    if (title !== null) patchMeta(slot, { title, custom })
  })
  const onCycleColor = useEvent((slot: number) =>
    setMetas((prev) => prev.map((m, i) => (i === slot ? { ...m, color: nextTag(m.color || defaultTag(slot)) } : m)))
  )
  // 크게 보기 토글 — 열릴 때 카드 컴포저로 바로 커서(숫자 키 점프와 같은 착지)
  const onToggleExpand = useEvent((slot: number) => {
    const opening = expandedSlot !== slot
    setExpandedSlot(opening ? slot : null)
    setFocusedSlot(slot)
    if (opening)
      requestAnimationFrame(() => {
        const ta = document.querySelector('.ma-expand-card .composer textarea') as HTMLTextAreaElement | null
        ta?.focus()
      })
  })
  const onOpenPanelFile = useEvent((slot: number, rel: string) => setOpenFile({ slot, path: rel }))
  const onOpenPanelSub = useEvent((slot: number, id: string) => setOpenSub({ slot, id }))
  const onOpenImage = useEvent((imgs: string[], index: number) => setViewer({ images: imgs, index }))
  // 백그라운드 셸 컨트롤(중지/Ctrl+B) — 그 패널의 엔진으로 라우팅 (?.: 구 preload 가드)
  const onPanelBgTask = useEvent((slot: number, req: BgTaskRequest) => {
    window.api.multi?.bgTask?.(chan(sessionId, slot), req).catch(() => {})
  })
  // 패널 WorkBar의 컨텍스트 팝오버를 열 때 그 패널 실행 계정의 사용량을 강제 새로고침
  // (본채팅과 동일한 fresh 규칙 — 계정만 이 패널의 바인딩을 따른다)
  const onRefreshUsage = useEvent((slot: number) => fetchAcctUsage(metas[slot].picker.account ?? '', true))

  // ── panel working-folder changes ──
  // A panel's folder is panel-scoped, and its session id is folder-scoped — moving a
  // panel with a conversation to another folder can't continue it. Folder changes funnel
  // through requestPanelFolder, which confirms via the card modal before wiping.
  const panelCwd = (slot: number): string => metas[slot].cwd || sessions[slot].state.session?.cwd || ''
  const requestPanelFolder = (slot: number, cwd: string): void => {
    const cur = panelCwd(slot)
    // same folder / nothing to lose → just rebind, no ceremony
    if (!cwd || !cur || sameCwd(cwd, cur) || sessions[slot].state.messages.length === 0) {
      patchMeta(slot, { cwd })
      if (cwd) pushRecentDir(cwd) // 공유 최근 폴더(일반·추가 채팅과 공용)에 반영
      return
    }
    if (sessions[slot].busy) return // the running turn works in this folder
    setPendingFolder({ slot, cwd })
  }
  const onPickFolder = useEvent(async (slot: number) => {
    if (sessions[slot].busy) return // blocked mid-run anyway — don't even open the picker
    const dir = await window.api.pickDirectory()
    if (dir) requestPanelFolder(slot, dir)
  })
  // 작업 폴더 팝오버(FolderPop) 목록에서 선택 — 확인 카드 흐름은 requestPanelFolder가 공용
  const onSelectFolder = useEvent((slot: number, dir: string) => requestPanelFolder(slot, dir))
  // ── 패널별 참조 폴더(--add-dir) — 대화 리셋 없음(추가 루트만 얹음), 다음 실행부터 적용 ──
  const onAddRefDirPath = useEvent((slot: number, dir: string) => {
    if (!dir) return
    setMetas((prev) =>
      prev.map((m, i) => {
        if (i !== slot) return m
        const cur = m.cwd || sessions[slot].state.session?.cwd || ''
        if ((cur && sameCwd(dir, cur)) || m.refDirs.some((p) => sameCwd(p, dir)) || m.refDirs.length >= 8) return m
        return { ...m, refDirs: [...m.refDirs, dir] }
      })
    )
  })
  const onAddRefDir = useEvent(async (slot: number) => {
    const dir = await window.api.pickDirectory()
    if (dir) onAddRefDirPath(slot, dir)
  })
  const onRemoveRefDir = useEvent((slot: number, p: string) =>
    setMetas((prev) => prev.map((m, i) => (i === slot ? { ...m, refDirs: m.refDirs.filter((x) => !sameCwd(x, p)) } : m)))
  )

  // ── 왼쪽 칼럼 파일 탐색기(` 전환) — 따라갈 패널을 App으로 보고 ──
  // 마지막으로 포커스(클릭)한 패널 기준, 아직 없으면 1번. Esc로 선택을 놓아도 탐색기는
  // 그 패널에 남는다. 패널 수를 줄여 슬롯이 사라지면 마지막 패널로 내려앉는다.
  const [expSlot, setExpSlot] = useState(0)
  useEffect(() => {
    if (focusedSlot != null) setExpSlot(focusedSlot)
  }, [focusedSlot])
  const eSlot = Math.min(expSlot, count - 1)
  // 파일 열기는 그 패널의 cwd·diffs 뷰어(openFile), 폴더 선택은 그 패널의 선택 흐름으로
  const expOpenFile = useEvent((path: string) => setOpenFile({ slot: Math.min(expSlot, count - 1), path }))
  const expPickFolder = useEvent(() => onPickFolder(Math.min(expSlot, count - 1)))
  const expCwd = panelCwd(eSlot)
  const expFiles = sessions[eSlot].state.files
  useEffect(() => {
    onExplorerInfo?.({ slot: eSlot, cwd: expCwd, files: expFiles, tick: fsTick, openFile: expOpenFile, pickFolder: expPickFolder })
    // 핸들러는 useEvent(stable), onExplorerInfo는 App의 setState(stable) — 데이터만 의존
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eSlot, expCwd, expFiles, fsTick])

  // `opts` lets a queued message replay with the text/attachments/run settings it was
  // scheduled with (instead of the live draft, which the user may be typing in — a
  // replay never consumes it); interactive sends omit it.
  const sendPanel = useEvent(async (slot: number, opts?: { text: string; images: string[]; picker: PickerState }) => {
    const m = metas[slot]
    const sess = sessions[slot]
    const text = (opts?.text ?? m.input).trim()
    const imgs = opts?.images ?? m.images
    const pk = opts?.picker ?? m.picker
    // an image-only message (attachments, no text) is allowed.
    // 워크플로/백그라운드 작업이 도는 중의 전송은 엔진이 같은 프로세스에 주입한다(tryInject)
    if ((!text && imgs.length === 0) || sess.busy) return
    // /clear is a client command — reset just this panel's conversation (never sent to the engine).
    // 이 패널의 상주 백그라운드(워크플로·셸·에이전트)도 함께 회수한다 — 화면만 지우면
    // 완료 통지의 정리 턴이 백지가 된 패널 위에서 되살아난다 (본채팅과 동일한 처방).
    if (text === '/clear') {
      window.api.multi?.cancel(chan(sessionId, slot)).catch(() => {})
      sess.load(initialSessionState)
      patchMeta(slot, { title: '', custom: false, ...(opts ? {} : { input: '', images: [] }) })
      return
    }
    // a built-in slash command (/init·/compact·/review·/security-review) → tracked so it
    // renders a summary card instead of a raw bubble; null for a normal prompt / skill
    const cmd = commandOf(text)
    const firstInSession = sessions.every((s) => s.state.messages.length === 0)
    // 폴더 미선택이면 대화상자를 강제하지 않는다 — 칩 라벨의 약속대로 엔진이
    // 바탕화면으로 폴백한다. 이어지는 턴은 세션이 보고한 실제 폴더(바탕화면의 절대
    // 경로)를 그대로 써서 resume·폴더 비교가 끊기지 않게 한다.
    let dir = m.cwd || ''
    if (!dir && sess.state.session) dir = sess.state.session.cwd
    // folder changed since this panel's conversation began → a different project, and the
    // session can't continue here (a session id is folder-scoped). Reset the panel's thread
    // so it matches the fresh engine session instead of showing stale messages.
    const folderSwitched =
      !!sess.state.session && sess.state.messages.length > 0 && !sameCwd(sess.state.session.cwd, dir)
    if (folderSwitched) sess.load(initialSessionState)
    sess.begin(text, cmd, imgs)
    const title = deriveTitle(text)
    if (firstInSession) onFirstPrompt(sessionId, title)
    setMetas((prev) =>
      prev.map((pm, i) =>
        i === slot
          ? {
              ...pm,
              // a queued replay keeps the draft being typed; an interactive send consumes it
              ...(opts ? {} : { input: '', images: [] }),
              // cwd는 여기서 만지지 않는다 — 사용자가 폴더를 고르면 onPickFolder가 쓰고,
              // 미선택(바탕화면 폴백) 패널은 빈 값을 유지해 칩 라벨이 '바탕화면'으로 남는다
              title: pm.custom && !folderSwitched ? pm.title : title,
              custom: folderSwitched ? false : pm.custom
            }
          : pm
      )
    )
    // commands take no extras; for a normal prompt, list mentions + attachments so the
    // engine reads them reliably (the Agent SDK doesn't auto-expand "@" / images the way the CLI does)
    let promptForEngine = text
    if (!cmd) {
      const notes: string[] = []
      const mentions = extractMentions(text)
      if (mentions.length)
        notes.push(
          `${t('[멘션된 파일 — 필요하면 Read 도구로 확인하세요]', '[Mentioned files — read them with the Read tool if needed]')}\n${mentions.map((p) => '- ' + p).join('\n')}`
        )
      if (imgs.length)
        notes.push(`${t('[첨부 파일 — Read 도구로 확인하세요]', '[Attached files — check them with the Read tool]')}\n${imgs.map((p) => '- ' + p).join('\n')}`)
      if (notes.length) promptForEngine = `${text}\n\n${notes.join('\n\n')}`
    }
    // 참조 폴더 — 작업 폴더와 겹치는 항목은 걸러서 전달
    const extraDirs = m.refDirs.filter((p) => !sameCwd(p, dir))
    const req: MultiRunRequest = {
      panelId: chan(sessionId, slot),
      prompt: promptForEngine,
      model: pk.model,
      effort: pk.effort,
      mode: pk.mode,
      // 실행 엔진(claude/codex) + Codex GPT 모델 — 생략하면 Claude
      engine: pk.engine,
      codexModel: pk.codexModel,
      cwd: dir,
      addDirs: extraDirs.length ? extraDirs : undefined,
      // 패널별 프롬프트 — 매 실행 시스템 프롬프트에 append (없으면 생략)
      // resume only while still in the session's original folder (a session id is scoped
      // to its project — resuming it after a folder change errors "No conversation found")
      resume: sess.state.session && sameCwd(sess.state.session.cwd, dir) ? sess.state.session.sessionId : undefined,
      // 패널별 과금 — 이 패널이 API를 골랐으면 이 실행만 API 키로 과금
      useApi: m.api || undefined,
      // 실행 계정 — 클로드는 격리 CLAUDE_CONFIG_DIR, Codex는 격리 CODEX_HOME (미지정=기본 계정)
      account: pk.account,
      codexAccount: pk.codexAccount
    }
    window.api.multi?.run(req).catch(() => {})
  })

  // queue the panel's draft (while it's busy) to auto-send when its run ends
  const schedulePanel = useEvent((slot: number) => {
    const m = metas[slot]
    if (!sessions[slot].busy || (!m.input.trim() && m.images.length === 0)) return
    const id = crypto.randomUUID ? crypto.randomUUID() : `q-${Date.now()}-${m.queue.length}`
    setMetas((prev) =>
      prev.map((pm, i) =>
        i === slot
          ? { ...pm, input: '', images: [], queue: [...pm.queue, { id, text: pm.input, images: pm.images, picker: pm.picker }] }
          : pm
      )
    )
  })
  const onRemoveQueued = useEvent((slot: number, id: string) =>
    setMetas((prev) => prev.map((m, i) => (i === slot ? { ...m, queue: m.queue.filter((q) => q.id !== id) } : m)))
  )

  // drain each panel's queue one message at a time on its busy→idle transition. The
  // `was` guard (only act when that slot was busy and now isn't) prevents a double-send:
  // dequeuing changes `metas` and re-runs this effect before the next run's busy flips on.
  const busySig = sessions.map((s) => (s.busy ? '1' : '0')).join('')
  const prevBusyRef = useRef(busySig)
  // slots mid-drain — sendPanel can await pickDirectory (cwd 없는 재생) before busy
  // flips, and this effect re-runs on every metas change in that window; the ref makes
  // re-entry per slot impossible regardless of timing
  const drainingRef = useRef<Set<number>>(new Set())
  useEffect(() => {
    const was = prevBusyRef.current
    prevBusyRef.current = busySig
    SLOTS.forEach((slot) => {
      if (busySig[slot] === '1' || was[slot] !== '1' || drainingRef.current.has(slot)) return
      // 런을 시작하지 않는 클라이언트 명령(/clear)은 busy 전환이 다시 오지 않아 뒤 항목이
      // 영영 갇힌다 — 앞쪽의 /clear 들을 연달아 소진하고, 엔진 런을 시작할 첫 일반 항목까지
      // 한 번에 내보낸다(그 런이 끝나면 다음 idle 전환이 나머지를 이어받는다).
      const q = metas[slot].queue
      let clears = 0
      while (clears < q.length && q[clears].text.trim() === '/clear') clears++
      const items = q.slice(0, Math.min(clears + 1, q.length))
      if (!items.length) return
      drainingRef.current.add(slot)
      setMetas((prev) => prev.map((m, i) => (i === slot ? { ...m, queue: m.queue.slice(items.length) } : m)))
      // 예약 메시지는 자체 텍스트/첨부/설정으로 재생 — 실행 중에 새로 쓰던 초안은 건드리지
      // 않는다. 순차 await: 이전 항목이 자리를 잡기 전에 다음 항목이 겹쳐 나가지 않게.
      void (async () => {
        try {
          for (const next of items) await sendPanel(slot, { text: next.text, images: next.images, picker: next.picker })
        } finally {
          drainingRef.current.delete(slot)
        }
      })()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busySig, metas])

  // ↑↓ 제스처의 대화 비우기 — 컴포저 /clear와 같은 착지점(이 패널만 백지로).
  // 상주 백그라운드 회수도 동일하게 — sendPanel의 /clear 분기 주석 참고.
  const clearPanel = useEvent((slot: number) => {
    const sess = sessions[slot]
    if (sess.busy) return
    window.api.multi?.cancel(chan(sessionId, slot)).catch(() => {})
    sess.load(initialSessionState)
    patchMeta(slot, { title: '', custom: false, input: '', images: [] })
  })

  const stopPanel = useEvent((slot: number) => {
    // 취소 = 중단 — 턴의 흔적은 패널 스레드에 그대로 남기고 '중단함' 마커만 붙인다
    // (본채팅과 동일). 소프트 중단 — 턴만 끊고 그 패널 CLI·백그라운드는 상주 유지
    // (cancel은 고아 통지 → 상주 꼬임 루프의 진입점 — 본채팅 cancelRun과 같은 이유).
    // 상주 워크플로만 도는 경우엔 완결된 턴이라 마커 없이 워크플로만 그레이스풀 중지.
    const sess = sessions[slot]
    if (sess.busy) {
      sess.interruptTurn()
      window.api.multi?.interrupt?.(chan(sessionId, slot)).catch(() => {})
    } else {
      for (const w of sess.state.workflows)
        if (w.status === 'running') onPanelBgTask(slot, { action: 'stop', id: w.id })
    }
    // stopping the run also abandons anything queued behind it (mirrors single mode)
    setMetas((prev) => prev.map((m, i) => (i === slot && m.queue.length ? { ...m, queue: [] } : m)))
  })
  const onPermission = useEvent((slot: number, behavior: 'allow' | 'allow_always' | 'deny') => {
    const sess = sessions[slot]
    if (!sess.state.pendingPermission) return
    window.api.multi
      ?.respondPermission({ panelId: chan(sessionId, slot), requestId: sess.state.pendingPermission.requestId, behavior })
      .catch(() => {})
    sess.clearPermission()
  })
  const onAnswer = useEvent((slot: number, answers: string[][]) => {
    const sess = sessions[slot]
    if (!sess.state.pendingQuestion) return
    window.api.multi
      ?.respondQuestion({ panelId: chan(sessionId, slot), requestId: sess.state.pendingQuestion.requestId, answers })
      .catch(() => {})
    sess.answerQuestion(answers) // 카드를 닫으며 문답 흔적을 그 패널 스레드에 남긴다
  })
  const onDismissQuestion = useEvent((slot: number) => {
    const sess = sessions[slot]
    if (!sess.state.pendingQuestion) return
    window.api.multi
      ?.respondQuestion({ panelId: chan(sessionId, slot), requestId: sess.state.pendingQuestion.requestId, answers: null })
      .catch(() => {})
    sess.clearQuestion()
  })

  // 변경 — apply the parked folder change and start that panel's conversation fresh
  const confirmFolder = useEvent(() => {
    const p = pendingFolder
    if (!p) return
    patchMeta(p.slot, { cwd: p.cwd, title: '', custom: false })
    sessions[p.slot].load(initialSessionState)
    pushRecentDir(p.cwd) // 공유 최근 폴더에 반영
    setPendingFolder(null)
  })

  // expanded=true면 같은 패널을 크게 보기 카드 안에 그린다 — 읽기 배율만 카드 전용
  // (multi.expand.zoom)으로 갈아끼우고 나머지 배선은 그리드와 동일
  const renderPanel = (slot: number, expanded = false): React.ReactNode => {
    const sess = sessions[slot]
    return (
      <PanelView
        key={slot}
        slot={slot}
        meta={metas[slot]}
        state={sess.state}
        busy={sess.busy}
        elapsed={sess.elapsed}
        focused={focusedSlot === slot}
        expanded={expanded}
        usage={acctUsage[metas[slot].picker.account ?? ''] ?? EMPTY_USAGE}
        budgetUsd={budget?.budgetUsd ?? null}
        totalSpentUsd={budget?.spentUsd ?? 0}
        zoom={expanded ? expandZoom.zoom : multiZoom.zoom}
        onInput={onInput}
        onAddImages={onAddImages}
        onRemoveImage={onRemoveImage}
        onSend={sendPanel}
        onSchedule={schedulePanel}
        onRemoveQueued={onRemoveQueued}
        onStop={stopPanel}
        onClear={clearPanel}
        onPicker={onPicker}
        apiReady={apiReady}
        apiReadyCodex={apiReadyCodex}
        onApiMode={onPanelApi}
        onPickFolder={onPickFolder}
        onSelectFolder={onSelectFolder}
        onAddRefDir={onAddRefDir}
        onAddRefDirPath={onAddRefDirPath}
        onRemoveRefDir={onRemoveRefDir}
        onOpenFile={onOpenPanelFile}
        onOpenSubagent={onOpenPanelSub}
        onOpenImage={onOpenImage}
        onBgTask={onPanelBgTask}
        onRefreshUsage={onRefreshUsage}
        onFocusPanel={onFocusPanel}
        onToggleExpand={onToggleExpand}
        onPermission={onPermission}
        onAnswer={onAnswer}
        onDismissQuestion={onDismissQuestion}
        renaming={renamingSlot === slot}
        onStartRename={onStartRename}
        onRename={onRenamePanel}
        onCycleColor={onCycleColor}
      />
    )
  }

  return (
    <>
      {/* .expanded 플래그 — 크게 보기 중 뒤 그리드 패널의 질문 카드(z80)를 베일 밑으로 내리는 CSS 훅 */}
      <section className={'multi' + (expandedSlot != null ? ' expanded' : '')}>
        {/* 헤더 = 드래그 바: 아이콘/타이틀·일괄 폴더·한도 필은 2.0에서 삭제 — 남는 건
            오른쪽의 패널 수 탭과 창 컨트롤뿐(왼쪽 배치는 시도 후 롤백). 한도·비용은
            각 패널 WorkBar 컨텍스트 팝오버가 말한다 */}
        <div className="ma-head">
          <span className="ma-spacer" />
          <div className="ma-count" role="tablist" aria-label={t('패널 수', 'Panel count')}>
            {COUNT_OPTIONS.map((n) => (
              <button
                key={n}
                role="tab"
                aria-selected={count === n}
                className={'ma-count-btn' + (count === n ? ' on' : '')}
                onClick={() => {
                  setCount(n)
                  // 줄어든 그리드 밖을 가리키던 선택/모달 슬롯은 정리 — 안 보이는
                  // 패널이 오버레이로 계속 떠 있거나 포커스를 쥐고 있지 않게
                  setFocusedSlot((s) => (s != null && s >= n ? null : s))
                  setRenamingSlot((s) => (s != null && s >= n ? null : s))
                  setExpandedSlot((s) => (s != null && s >= n ? null : s))
                  setOpenFile((f) => (f && f.slot >= n ? null : f))
                  setOpenSub((s) => (s && s.slot >= n ? null : s))
                }}
              >
                {n}
              </button>
            ))}
          </div>
          {/* 탐색기 토글 — 본채팅 헤더와 같은 버튼·툴팁: 단축키(`)를 모르는 사람도
              멀티 뷰에서 탐색기를 열 수 있게 (탐색기는 포커스한 패널의 폴더를 따라간다) */}
          {onToggleExplorer && (
            <button
              className={'h-ic has-tip' + (explorerHidden ? '' : ' on')}
              data-tip={
                explorerHidden
                  ? t('파일 탐색기 — 왼쪽 목록과 전환 (`)', 'File explorer — swaps with the left list (`)')
                  : t('채팅 목록으로 (`)', 'Back to chat list (`)')
              }
              aria-label={t('파일 탐색기', 'File explorer')}
              onClick={onToggleExplorer}
            >
              <IconPanelRight size={15} />
            </button>
          )}
          <span className="vsep" />
          <WinControls />
        </div>

        {/* 배치는 .nN 클래스가 결정 — PoC: 2·3=한 줄, 4=2×2, 5=3+2(스팬), 6=3×2 */}
        <div className={'ma-grid scroll n' + count} ref={multiZoom.ref}>
          {SLOTS.slice(0, count).map((slot) =>
            slot === expandedSlot ? (
              // 크게 보는 패널의 그리드 자리 지킴이 — 실물 PanelView는 오버레이 카드에 가 있다
              // (.ma-panel 클래스 유지: n5 스팬 등 그리드 배치 규칙이 그대로 먹게)
              <div key={slot} className="ma-panel ma-ghost" data-slot={slot}>
                <span className="ma-p-num on">{slot + 1}</span>
                <span className="ma-ghost-text">{t('크게 보는 중', 'Expanded')}</span>
              </div>
            ) : (
              renderPanel(slot)
            )
          )}
        </div>
        <ZoomBadge pct={multiZoom.pct} show={multiZoom.flash} />
      </section>

      {/* 크게 보기 — 그 패널을 본채팅 크기의 오버레이 카드로. 상태는 전부 이 컴포넌트
          소유라 스레드·작성 중 초안·실행이 그대로 이어진다. 베일 클릭/Esc/헤더 버튼으로
          제자리, 숫자 키로 카드 안 패널 전환. 파일 뷰어(z60)·서브에이전트 카드(z70)는
          이 베일(z55) 위에 뜬다 */}
      {expandedSlot != null && (
        <div
          className="ma-expand-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setExpandedSlot(null)
          }}
        >
          <div className="ma-expand-card" ref={expandZoom.ref}>
            {renderPanel(expandedSlot, true)}
          </div>
          <ZoomBadge pct={expandZoom.pct} show={expandZoom.flash} />
        </div>
      )}

      {pendingFolder && (
        <FolderSwitchDialog
          from={panelCwd(pendingFolder.slot)}
          to={pendingFolder.cwd}
          onCancel={() => setPendingFolder(null)}
          onConfirm={confirmFolder}
        />
      )}

      {/* 폴더 팝오버에서 연 파일 — 그 패널의 cwd·diffs로 코드 뷰어. 패널이 아니라 여기서
          한 번만 렌더해 .fv-overlay(absolute inset:0)가 .win-body 전체를 덮게 한다 */}
      {openFile && (
        <Suspense fallback={null}>
          <FileModal
            path={openFile.path}
            cwd={metas[openFile.slot].cwd || sessions[openFile.slot].state.session?.cwd || ''}
            diffs={sessions[openFile.slot].state.diffs}
            onClose={() => setOpenFile(null)}
          />
        </Suspense>
      )}

      {/* WorkBar 서브에이전트 상세 카드 — 매 렌더 라이브 조회라 상태/도구 갱신이 흐른다 (본채팅과 동일) */}
      <SubAgentModal
        agent={openSub ? sessions[openSub.slot].state.subagents.find((a) => a.id === openSub.id) ?? null : null}
        onClose={() => setOpenSub(null)}
      />

      {viewer && (
        <ImageViewer
          images={viewer.images}
          index={viewer.index}
          onIndexChange={(i) => setViewer((v) => (v ? { ...v, index: i } : v))}
          onClose={() => setViewer(null)}
        />
      )}
    </>
  )
}

// ── 멀티 세션 메타(목록·제목·상태·영속화)를 소유하는 훅 — App이 부른다 ────────
// 2.0 사이드바는 멀티 뷰 밖에서도 '멀티 채팅' 섹션을 상시로 그려야 해서, 세션
// 목록/영속화를 워크스페이스 컴포넌트 밖으로 들어올렸다. MultiWorkspace는 이
// 번들을 props로 받아 활성 세션만 그리는 순수 뷰가 된다.
export function useMultiSessions() {
  // full data for every session (active one is folded in on commit / unmount). A ref,
  // not state — the live thread lives in ActiveSession's hooks, this is only for persist.
  const dataRef = useRef<Record<string, PersistedSession>>({})
  const [order, setOrder] = useState<string[]>([]) // session ids, most recent first
  const [activeId, setActiveId] = useState<string>('')
  // 저장 완료 콜백(비동기)에서 "지금" 활성인 세션을 지키기 위한 ref — 낡은 클로저의
  // activeId로 방금 전환해 온 세션의 패널을 내리면 안 된다
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const [titles, setTitles] = useState<Record<string, { title: string; custom: boolean }>>({})
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({})
  // 세션별 마지막 활동 시각 — 사이드바 상대 시간. 실행 시작·첫 프롬프트에서 갱신
  const [times, setTimes] = useState<Record<string, number>>({})
  const [hydrated, setHydrated] = useState(false)

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const doSave = useEvent(() => {
    const blob: MultiPersist = {
      version: MULTI_VERSION,
      activeSessionId: activeId,
      sessions: order
        .map((id) => {
          const d = dataRef.current[id]
          if (!d) return null
          const t = titles[id]
          return { ...d, title: t?.title ?? d.title, custom: t?.custom ?? d.custom, updatedAt: times[id] ?? d.updatedAt }
        })
        .filter(Boolean) as PersistedSession[]
    }
    window.api.multi
      ?.saveState?.(blob)
      .then(() => {
        // 디스크에 닿았다 — 비활성 세션의 패널 스냅샷은 메모리에서 내린다(전환 때 되읽음).
        // ref 변이라 리렌더 없음: 이 데이터는 영속·재마운트(initialOf)에만 쓰인다.
        for (const [id, d] of Object.entries(dataRef.current)) {
          if (id === activeIdRef.current || d.unloaded || !d.panels?.some((p) => p?.snapshot)) continue
          dataRef.current[id] = { ...d, panels: [], unloaded: true }
        }
      })
      .catch(() => {})
  })
  const scheduleSave = useEvent(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      if (hydrated) doSave()
    }, 700)
  })

  // restore the saved sessions on mount, or seed one fresh session
  useEffect(() => {
    let alive = true
    const seed = (): void => {
      const id = newSessionId()
      dataRef.current[id] = blankSession(id)
      setOrder([id])
      setTitles({ [id]: { title: '', custom: false } })
      setStatuses({ [id]: 'idle' })
      setActiveId(id)
    }
    window.api.multi
      ?.getState?.()
      .then((raw) => {
        if (!alive) return
        const data = raw as MultiPersist | null
        // a crash mid-save can leave malformed entries — keep only sessions with a real
        // id so a corrupt one can't seed `undefined` keys through the whole workspace
        const sessions = (Array.isArray(data?.sessions) ? data!.sessions : []).filter(
          (s): s is PersistedSession => !!s && typeof s === 'object' && typeof s.id === 'string' && s.id.length > 0
        )
        if (sessions.length) {
          const ord = sessions.map((s) => s.id)
          const act = data!.activeSessionId && ord.includes(data!.activeSessionId) ? data!.activeSessionId : ord[0]
          // 활성 세션만 패널 스냅샷을 통째로 든다 — 비활성은 마커만 두고 전환 때 디스크에서
          // 되읽는다(전 세션×6패널 상주가 렌더러 힙을 세션 수에 비례해 키웠다). 상태 배지는
          // 아래에서 원본(sessions)으로 계산하므로 잃는 것 없음.
          sessions.forEach((s) => {
            dataRef.current[s.id] =
              s.id === act || !(s.panels ?? []).some((p) => p?.snapshot) ? s : { ...s, panels: [], unloaded: true }
          })
          setOrder(ord)
          setTitles(Object.fromEntries(sessions.map((s) => [s.id, { title: s.title ?? '', custom: !!s.custom }])))
          setTimes(
            Object.fromEntries(
              sessions.filter((s) => typeof s.updatedAt === 'number').map((s) => [s.id, s.updatedAt as number])
            )
          )
          setStatuses(
            Object.fromEntries(
              sessions.map((s) => [
                s.id,
                // 경량 페이로드의 마커 세션은 panels가 비어 온다 — 배지는 요약(panelStatuses)으로
                aggregateStatus(s.panelStatuses ?? (s.panels ?? []).map((p) => p?.snapshot?.status ?? 'idle'))
              ])
            )
          )
          setActiveId(act)
        } else {
          seed()
        }
      })
      .catch(() => {
        if (alive) seed()
      })
      .finally(() => {
        if (alive) setHydrated(true)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // persist whenever the session list / titles / active selection changes
  useEffect(() => {
    if (hydrated) scheduleSave()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, order, titles, activeId, times])

  // ── reports from the active session ──
  const onCommit = useEvent((sid: string, payload: CommitPayload) => {
    const prev = dataRef.current[sid]
    dataRef.current[sid] = {
      id: sid,
      title: prev?.title ?? '',
      custom: prev?.custom ?? false,
      count: payload.count,
      panels: payload.panels
    }
    scheduleSave()
  })
  const onFirstPrompt = useEvent((sid: string, prompt: string) => {
    setTimes((t) => ({ ...t, [sid]: Date.now() }))
    // 업데이터 파라미터 t가 i18n t를 가리므로 번역은 밖에서 미리 평가한다
    const title = prompt.slice(0, 80) || t('멀티 세션', 'Multi session')
    setTitles((t) => {
      const cur = t[sid]
      if (cur?.custom || (cur && cur.title)) return t // already named
      return { ...t, [sid]: { title, custom: false } }
    })
  })
  const onStatus = useEvent((sid: string, status: AgentStatus) => {
    // 실행이 시작되는 전이만 활동으로 친다 — done/error 정착은 시간을 안 건드린다
    if ((status === 'working' || status === 'analyzing') && statuses[sid] !== status)
      setTimes((t) => ({ ...t, [sid]: Date.now() }))
    setStatuses((s) => (s[sid] === status ? s : { ...s, [sid]: status }))
  })

  // the active session is "empty" (no title, idle) → 새 작업 just stays on it
  const activeEmpty = (statuses[activeId] ?? 'idle') === 'idle' && !titles[activeId]?.title

  // 새 세션 — 패널 수는 새 채팅 모달(2~6)이 넘기고, 없으면 현 세션 구성을 따른다.
  // 빈 세션 위에서 부르면: 같은 구성이면 그대로 머물고, 다른 구성이면 그 빈 세션을
  // 갈아끼운다 (key 교체로 ActiveSession이 새 패널 수로 재마운트되도록 id를 새로 딴다)
  const newSession = useEvent((count?: number) => {
    const n = clampCount(count ?? dataRef.current[activeId]?.count ?? 4)
    if (activeEmpty && (dataRef.current[activeId]?.count ?? 4) === n) return
    const id = newSessionId()
    dataRef.current[id] = blankSession(id, n)
    const replacing = activeEmpty ? activeId : null
    if (replacing) delete dataRef.current[replacing]
    setOrder((o) => [id, ...(replacing ? o.filter((x) => x !== replacing) : o)])
    setTitles((t) => {
      const next = { ...t, [id]: { title: '', custom: false } }
      if (replacing) delete next[replacing]
      return next
    })
    setStatuses((s) => {
      const next: Record<string, AgentStatus> = { ...s, [id]: 'idle' }
      if (replacing) delete next[replacing]
      return next
    })
    activate(id)
  })
  // 세션 착지 — unloaded(패널이 메모리에 없음)면 디스크에서 되읽은 뒤 활성화한다.
  // 전환 연타로 로드가 겹치면 seq 가드로 마지막 요청만 이긴다.
  const activateSeq = useRef(0)
  const activate = useEvent((id: string) => {
    const d = dataRef.current[id]
    if (!d?.unloaded) {
      activateSeq.current++ // 진행 중이던 지연 로드 무효화 — 동기 전환이 항상 이긴다
      setActiveId(id)
      return
    }
    const seq = ++activateSeq.current
    window.api.multi
      ?.loadSession?.(id)
      .then((raw) => {
        if (seq !== activateSeq.current) return
        const s = raw as PersistedSession | null
        dataRef.current[id] =
          s && typeof s === 'object' && Array.isArray(s.panels)
            ? { ...d, count: s.count ?? d.count, panels: s.panels, unloaded: undefined, panelStatuses: undefined }
            : { ...blankSession(id), title: d.title, custom: d.custom } // 파일에 없던 세션(비정상) — 빈 세션으로나마 착지
        setActiveId(id)
      })
      .catch(() => {})
  })
  const selectSession = useEvent((id: string) => {
    if (id !== activeId) activate(id)
  })
  const renameSession = useEvent((id: string, name: string) => {
    setTitles((t) => ({ ...t, [id]: { title: name, custom: true } }))
    const d = dataRef.current[id]
    if (d) {
      d.title = name
      d.custom = true
    }
  })
  const deleteSession = useEvent((id: string) => {
    // release the session's panel engines
    SLOTS.forEach((i) => window.api.multi?.dispose(chan(id, i)).catch(() => {}))
    delete dataRef.current[id]
    const next = order.filter((x) => x !== id)
    setTitles((t) => {
      const n = { ...t }
      delete n[id]
      return n
    })
    setStatuses((s) => {
      const n = { ...s }
      delete n[id]
      return n
    })
    setTimes((t) => {
      const n = { ...t }
      delete n[id]
      return n
    })
    if (id === activeId) {
      if (next.length === 0) {
        const nid = newSessionId()
        dataRef.current[nid] = blankSession(nid)
        setTitles((t) => ({ ...t, [nid]: { title: '', custom: false } }))
        setStatuses((s) => ({ ...s, [nid]: 'idle' }))
        setOrder([nid])
        activate(nid)
      } else {
        setOrder(next)
        activate(next[0]) // unloaded 세션이면 되읽고 착지 (잠깐의 빈 화면은 로드가 메운다)
      }
    } else {
      setOrder(next)
    }
  })
  // 사이드바 라벨 행의 전체 삭제 — 모든 세션의 패널 엔진을 해제하고 빈 세션 하나로
  // 시작한다 (deleteSession의 "마지막 하나 삭제" 분기와 동일한 착지점)
  const deleteAllSessions = useEvent(() => {
    order.forEach((id) => SLOTS.forEach((i) => window.api.multi?.dispose(chan(id, i)).catch(() => {})))
    dataRef.current = {}
    const nid = newSessionId()
    dataRef.current[nid] = blankSession(nid)
    setTitles({ [nid]: { title: '', custom: false } })
    setStatuses({ [nid]: 'idle' })
    setTimes({})
    setOrder([nid])
    activate(nid)
  })

  // recent-tasks list = sessions that actually have content. A fresh blank session
  // (no message sent yet) stays hidden — like single mode, where a new chat doesn't
  // appear in the list until it's used, so the list opens on "채팅이 없어요".
  const summaries: ChatSummary[] = useMemo(
    () =>
      order
        .map((id) => ({
          id,
          title: titles[id]?.title ?? '',
          status: statuses[id] ?? ('idle' as AgentStatus),
          updatedAt: times[id]
        }))
        .filter((c) => c.title !== ''),
    [order, titles, statuses, times]
  )

  const initialOf = useEvent((id: string): PersistedSession => dataRef.current[id] ?? blankSession(id))

  return {
    hydrated,
    activeId,
    summaries,
    activeEmpty,
    newSession,
    selectSession,
    renameSession,
    deleteSession,
    deleteAllSessions,
    initialOf,
    onFirstPrompt,
    onStatus,
    onCommit
  }
}
export type MultiSessions = ReturnType<typeof useMultiSessions>

// ── the multi-agent workspace — 활성 세션만 그리는 뷰. 세션 목록·전환·삭제는
// App의 사이드바(멀티 채팅 섹션)가 useMultiSessions 번들로 다룬다 ────────────
export function MultiWorkspace({
  multi,
  usage,
  apiMode,
  apiReady,
  apiReadyCodex = false,
  onOpenApiSettings,
  onExplorerInfo,
  explorerHidden,
  onToggleExplorer
}: {
  multi: MultiSessions
  usage: UsageInfo
  apiMode: boolean // 전역 과금 모드 — 새 패널의 기본값 시드로만 쓴다 (선택은 패널별)
  apiReady: boolean
  apiReadyCodex?: boolean // OpenAI 키 존재 여부 — Codex 패널의 과금 선택용
  onOpenApiSettings: () => void // 설정 → API 탭 열기 (키 미등록 가드)
  onExplorerInfo?: (info: MultiExplorerInfo) => void // 왼쪽 칼럼 탐색기가 따라갈 패널 보고
  explorerHidden?: boolean // 헤더 토글 버튼 상태 — 탐색기가 내려가 있으면 true
  onToggleExplorer?: () => void // 헤더 토글 버튼 — 사이드바 ⟷ 탐색기
}) {
  return !multi.hydrated || !multi.activeId ? (
    <section className="multi">
      <div className="ma-hydrate">
        <span className="ma-hydrate-spin" />
      </div>
    </section>
  ) : (
    <ActiveSession
      key={multi.activeId}
      sessionId={multi.activeId}
      initial={multi.initialOf(multi.activeId)}
      usage={usage}
      apiMode={apiMode}
      apiReady={apiReady}
      apiReadyCodex={apiReadyCodex}
      onOpenApiSettings={onOpenApiSettings}
      onFirstPrompt={multi.onFirstPrompt}
      onStatus={multi.onStatus}
      onCommit={multi.onCommit}
      onExplorerInfo={onExplorerInfo}
      explorerHidden={explorerHidden}
      onToggleExplorer={onToggleExplorer}
    />
  )
}
