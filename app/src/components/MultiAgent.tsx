import { Suspense, memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { AgentStatus, BgTaskRequest, ChangedFile, EngineId, UsageInfo, MultiRunRequest, EngineEvent, SubAgentInfo, PanelPopState, PanelPopClosed, SessionWindowInfo } from '@shared/protocol'
import {
  useAgentSession,
  initialSessionState,
  sanitizeSnapshot,
  snapshotForPersist,
  sameCwd,
  commandOf,
  commandTitleOf,
  liveMsgIndex,
  abortedTurn,
  effectiveStatus,
  type SessionState
} from '../store/session'
import {
  BtwDock,
  Composer,
  LimitHoldBar,
  MessageView,
  WelcomeState,
  WorkingIndicator,
  WorkBar,
  WorkflowDock,
  PermissionModal,
  QuestionModal,
  SelectionToolbar,
  ChatFind,
  FolderPop,
  slashCommandsWithBtw,
  useThreadAnchor,
  useThreadFollow,
  useThreadWindow,
  hasRunningBash,
  pickerModelOf,
  type NotifyAction,
  type PickerState,
  type ScheduledMsg
} from './Chat'
import { parseBtw, btwForkOf } from '../lib/btw'
import { onChatIdentity, onChatVerdict } from '../api/unified'
import { panelIdOfChat } from '../lib/accounts'
import { panelSlotOfChat, pickerAfterLanding, queueAfterLanding } from '../lib/identityLanding'
import { shellAuthored, verdictLine, verdictNote } from '../lib/verdict'
// ★3.0.8 — 다이얼(자리 수) ↔ 표시 순서의 순수 규칙. 줄일 때의 포커스 자리 승격은 임시 오버레이다.
import { resizeLayout, sanitizePromo, type LayoutPromo } from '../lib/panelLayout'
import type { LimitHold } from '../lib/limitResume'
import { useLimitResume, type LimitResumeSurface } from '../lib/useLimitResume'
import type { ChatSummary } from './Sidebar'
import { WinControls } from './TitleBar'
import { FolderSwitchDialog } from './FolderSwitchDialog'
import { McpSkillView } from './McpSkillView'
import { FileModal } from '../lib/fileViewer'
import { pushRecentDir } from '../lib/recentDirs'
import { SubAgentModal } from './AgentPanel'
import { ImageViewer } from './ImageViewer'
import { extractMentions } from '../lib/mentions'
import { useTurnNotifyList } from '../lib/notify'
import { mergeRefs, useZoom, ZoomBadge } from './zoom'
import { MouseGestureLayer, clearGesture, sessionWindowGesture } from './mouseGesture'
import { IconFolder, IconChevDown, IconMascot, IconPanelRight, IconSearch, IconExpand, IconCollapse, IconPopout, IconPencil, IconLock, IconLockOpen } from './icons'
import { t, useLang } from '../lib/i18n'
import { openInViewerWindow, setViewerWindowMode, viewerWindowMode } from '../lib/viewerWindow'

// A multi-agent SESSION is a group of N panels that work together. The recent-tasks
// list shows one entry per session (not per panel); "새 작업" opens a fresh session and
// the panels are part of it. Each session owns SLOT_COUNT panels, each an independent
// Claude Code engine addressed by `${sessionId}::${slot}` — unique per session, so two
// sessions never collide on the shared event channel, and a session's runs keep going
// in the background after you switch away (events resync when you come back).
const SLOT_COUNT = 6
const SLOTS = [0, 1, 2, 3, 4, 5]

// 그리드 배치는 .ma-grid.nN 클래스가 결정 (PoC: 2·3=한 줄, 4=2×2, 5=3+2 스팬, 6=3×2)
// ★ 3.0 M-UX — 다이얼에 **1**이 들어왔다(ux-chat-unify §2.1). 1 = 그리드가 아니라
// **IDE 크롬**: 자리 하나가 화면 전체를 쓰고(.n1) 미니어처 배율(zoom .8/.9)이 풀리며,
// 그 자리의 패널 헤더가 곧 TopBar가 된다(다이얼·접힘 배지·탐색기 토글·창 컨트롤을 얹는다).
// 2‥6은 2.6.2 그리드 그대로.
const COUNT_OPTIONS = [1, 2, 3, 4, 5, 6]

// 한도 자동 이어서 토글의 미제공 폴백 — 모듈 상수여야 한다: 렌더마다 새 함수를 만들면
// PanelView(memo) 전 패널이 매 렌더 리렌더된다
const NOOP_AUTORESUME = (_on: boolean): void => {}

// /btw 알약 도크 핸들러 — 창 포커스/삭제는 전역 API라 모듈 상수로 (memo PanelView에 안전).
// 빈 목록도 모듈 상수 — 알약 없는 패널이 브로드캐스트마다 새 []로 리렌더되지 않게.
const btwFocus = (id: string): void => void window.api.sessionWindows.focus(id).catch(() => {})
const btwClose = (id: string): void => void window.api.sessionWindows.close(id).catch(() => {})
const EMPTY_BTW: SessionWindowInfo[] = []

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
export const EMPTY_USAGE: UsageInfo = { fiveHour: null, weekly: null, weeklyFable: null, extraCredit: null }

// a picker restored from disk may be missing, truncated (crash mid-save), or hold ids
// this build no longer knows — each field falls back to the default individually
const PICKER_MODELS = ['fable', 'opus', 'sonnet', 'haiku']
const PICKER_EFFORTS = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal']
const PICKER_MODES = ['normal', 'plan', 'acceptEdits', 'auto', 'bypass']
export function sanitizePanelPicker(p?: Partial<PickerState> | null): PickerState {
  return {
    model: p?.model && PICKER_MODELS.includes(p.model) ? p.model : DEFAULT_PICKER.model,
    effort: p?.effort && PICKER_EFFORTS.includes(p.effort) ? p.effort : DEFAULT_PICKER.effort,
    mode: p?.mode && PICKER_MODES.includes(p.mode) ? p.mode : DEFAULT_PICKER.mode,
    // 실행 엔진 + Codex 모델 — 버리면 GPT 패널이 복원 때마다 Claude로 폴백한다
    engine: p?.engine === 'codex' ? 'codex' : undefined,
    codexModel: typeof p?.codexModel === 'string' && p.codexModel ? p.codexModel : undefined,
    codexTier: typeof p?.codexTier === 'string' && p.codexTier ? p.codexTier : undefined,
    // 실행 계정(이메일) — 형태만 확인 (등록 목록 대조는 picker·엔진이 담당)
    account: typeof p?.account === 'string' && p.account ? p.account : undefined,
    codexAccount: typeof p?.codexAccount === 'string' && p.codexAccount ? p.codexAccount : undefined
  }
}

const MULTI_VERSION = 2

// one panel's live state within a session (input + images + queue are draft-only, not persisted)
export interface PanelMeta {
  title: string
  custom: boolean // user-renamed → keep the title instead of deriving it from the prompt
  locked: boolean // 제목 잠금 — /clear·제스처 비우기·폴더 변경·매 전송 자동 유도에도 현 제목 동결
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
  locked?: boolean // 없으면(예전 저장본) 잠금 해제
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
  // 패널 표시 순서 — 슬롯 번호의 순열(길이 SLOT_COUNT). 헤더 길게 누르기 드래그로 바꾼
  // 자리 배치다. 슬롯 정체성(엔진 채널·훅·메타 인덱스·번호 칩)은 패널을 따라가고 그리드
  // 위치만 바뀐다. 없으면(예전 저장본) 기본 순서.
  panelOrder?: number[]
  // ★3.0.8 — 자리 수를 줄이며 끌어올린 자리와 그 전의 순서(`lib/panelLayout.ts`). 늘릴 때 되돌리는 근거.
  // null = 오버레이 없음. 없으면(예전 저장본) 오버레이 없음과 같다.
  promo?: LayoutPromo | null
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
  panelOrder: number[]
  promo: LayoutPromo | null
  panels: PersistedPanel[]
}

// 왼쪽 칼럼 파일 탐색기(` 전환)가 따라갈 패널의 스냅샷 — ActiveSession이 App으로
// 보고하고, App이 사이드바 자리(.lcol)에 이 정보로 Explorer를 그린다. 핸들러는
// useEvent라 안정 — 파일 열기/폴더 선택이 그 패널의 뷰어·폴더 흐름으로 간다.
// ── ★ 3.0 M-UX — 통합 사이드바가 보드 자리를 그리기 위해 받는 요약 (ux-chat-unify §8-①(a)) ──
// 항목 키는 **panelId**(`${sessionId}::${slot}`)다 — 별칭 계층이 그대로 chatId로 번역하는
// 그 키라(§6.2 `panelIdToChat`), 통합 스토어가 렌더러에 노출되는 2단계에서 chatId로
// 바꿔 끼우면 사이드바 쪽 코드는 그대로 산다.
export interface PanelSummary {
  slot: number
  panelId: string
  title: string
  status: AgentStatus
  pos: number | null // 보이는 자리 번호(1‥N) — 접혀 있으면 null
  fold: number | null // 접힘 집합 안의 자리 번호(count+1‥6) — 보이면 null
  color: string
  popped: boolean // 별도 창에서 보는 중(유령 셀)
  ask: boolean // 승인/질문 대기
  empty: boolean // 제목도 메시지도 없다 — 사이드바에 안 보인다(§2.4)
}

export interface MultiExplorerInfo {
  slot: number
  cwd: string // 그 패널의 작업 폴더 ('' = 아직 미선택 → 탐색기 빈 화면 + 폴더 선택 버튼)
  files: ChangedFile[] // 그 패널 세션의 변경 파일 → 트리 M/A 배지
  tick: number // 패널 실행이 끝날 때마다 +1 → 탐색기 재읽기 (본채팅 fsTick 규칙)
  openFile: (path: string) => void // 그 패널의 cwd·diffs로 코드 뷰어
  pickFolder: () => void // 그 패널의 폴더 선택 (OS 픽커 + 확인 카드 흐름)
}

export function freshPanel(api = false): PanelMeta {
  return { title: '', custom: false, locked: false, color: '', cwd: '', refDirs: [], picker: { ...DEFAULT_PICKER }, api, input: '', images: [], queue: [] }
}
// 저장본의 참조 폴더 위생 — 문자열 배열만, 상한 8 (본채팅 sanitizeRefDirs와 같은 규칙)
export function sanitizeRefDirs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && !!s).slice(0, 8) : []
}
// 컬러 태그 순환 팔레트 — 탈채도 기능색(:root 변수명 그대로). 해제 상태는 없다(유저 결정:
// 모든 패널이 항상 색으로 구분). 저장값 ''은 "슬롯 기본색"으로 읽어 예전 저장본도 자동 착색.
const TAG_COLORS = ['violet', 'blue', 'amber', 'teal', 'green', 'yellow', 'red']
export function defaultTag(slot: number): string {
  return TAG_COLORS[slot % TAG_COLORS.length]
}
export function nextTag(c: string): string {
  return TAG_COLORS[(TAG_COLORS.indexOf(c) + 1) % TAG_COLORS.length]
}
export function sanitizeTag(v: unknown): string {
  return typeof v === 'string' && TAG_COLORS.includes(v) ? v : ''
}
// 패널 자동 제목 — 첫 프롬프트(명령이면 카드 제목) 유래. 직접 지정 제목을 비워 저장하면 여기로 복귀
export function deriveTitle(text: string): string {
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
// ★ 3.0 M-UX — 하한이 2에서 **1**로 내려왔다. 1은 "패널 하나짜리 그리드"가 아니라
// IDE 크롬이고, 나머지 자리는 삭제가 아니라 **접힘**이다(§2.2).
function clampCount(n: unknown): number {
  const v = typeof n === 'number' ? n : 4
  return Math.max(1, Math.min(SLOT_COUNT, Math.round(v)))
}
// 패널 표시 순서 위생 — 슬롯 번호의 온전한 순열만 인정(길이·구성원 검사), 어긋나면
// (예전 저장본·크래시 반토막) 기본 순서. 표시만 바꾸는 값이라 폴백이 안전하다.
function sanitizePanelOrder(v: unknown): number[] {
  return Array.isArray(v) && v.length === SLOT_COUNT && SLOTS.every((s) => v.includes(s)) ? (v as number[]) : [...SLOTS]
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
export function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
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
  /** ★ 3.0 M-UX R3 — 읽던 자리 앵커의 키(`chan(sessionId, slot)`). 자리 정체성이지
   *  화면 위치가 아니다 — 6분할의 3번 칸에서 접혀 n1의 1번 칸으로 되올라와도 같은 키다. */
  anchorKey: string
  /** ★ 3.0 M9 — 이 패널의 엔진 채널(`chan(sessionId, slot)`). `anchorKey`와 갈라 두는
   *  이유: 앵커는 껍데기마다 접미사가 붙지만(`::exp`·`::win`) 구독 주소는 하나여야 한다. */
  panelId: string
  num: number // 자리 번호(1‥N) — 그리드 위치 기준. 드래그로 옮기면 바뀐다
  /** ★ 3.0 M-UX — n1(IDE 크롬)에서 이 패널의 헤더가 TopBar를 겸한다: 다이얼·접힘 배지·
   *  탐색기 토글·창 컨트롤이 헤더 오른쪽에 얹힌다. 2‥6에서는 undefined(.ma-head가 그린다). */
  topbar?: React.ReactNode
  /** n1(IDE 크롬) 웰컴 인사말용 닉네임 — 본채팅(App user.name)과 같은 프로필 소스.
   *  팝아웃 창(PanelWindow)은 topbar가 없어 웰컴을 안 그리므로 생략 가능. */
  userName?: string
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
  limitHold: LimitHold | null // 이 패널의 한도 대기표 — 컴포저 위 상태줄
  autoResume: boolean // 한도 자동 이어서(전역) — 과금 picker 체크 + 상태줄 문구
  onCancelHold: (slot: number) => void // 상태줄 ✕ — 대기 취소
  onResumeHold: (slot: number) => void // ★R28c RCAP — 상태줄 「이어가기」(자동을 접은 표의 출구)
  onAutoResume: (on: boolean) => void // 과금 picker의 '한도 소진 시 자동 이어서' 체크
  onPickFolder: (slot: number) => void // 찾아보기 — OS 폴더 선택
  onSelectFolder: (slot: number, path: string) => void // 작업 폴더 팝오버 목록에서 선택
  onAddRefDir: (slot: number) => void // 참조 폴더(--add-dir) 추가 — OS 픽커
  onAddRefDirPath: (slot: number, path: string) => void // 즐겨찾기/최근 행의 + — 경로 직접 추가
  onRemoveRefDir: (slot: number, path: string) => void
  onOpenFile: (slot: number, rel: string, line?: number) => void // WorkBar·툴 로그의 파일 → 뷰어
  onOpenSubagent: (slot: number, id: string) => void // WorkBar 서브에이전트 행 → 상세 카드
  onOpenImage: (images: string[], index: number) => void // 스레드/컴포저 이미지 → 뷰어
  onBgTask: (slot: number, req: BgTaskRequest) => void // 백그라운드 셸 중지/Ctrl+B — 이 패널 엔진으로
  onRefreshUsage: (slot: number) => void // 컨텍스트 팝오버를 열 때 이 패널 계정의 사용량 강제 새로고침
  onFocusPanel: (slot: number) => void
  onToggleExpand: (slot: number) => void // 헤더 버튼 — 크게 보기 ⟷ 원래 크기로
  onPopout?: (slot: number) => void // 헤더 버튼 — 별도 OS 창으로 (팝아웃 창 안에선 미제공=숨김)
  onPermission: (slot: number, behavior: 'allow' | 'allow_always' | 'deny') => void
  onAnswer: (slot: number, answers: string[][]) => void
  onDismissQuestion: (slot: number) => void
  renaming: boolean // 제목 인라인 편집 중 — 더블클릭/연필/F2로 진입 (상태는 ActiveSession 소유)
  onStartRename: (slot: number) => void
  onRename: (slot: number, title: string | null, custom: boolean) => void // null = 취소(닫기만)
  onToggleLock: (slot: number) => void // 자물쇠 클릭 — 제목 잠금 토글 (잠그면 클리어에도 제목 유지)
  onCycleColor: (slot: number) => void // 번호 칩 클릭 — 컬러 태그 순환
  btwWins: SessionWindowInfo[] // 이 패널에서 띄운 /btw 질문 창들 — 패널 안 btw 알약 도크
}

export const PanelView = memo(function PanelView({
  slot,
  anchorKey,
  panelId,
  num,
  topbar,
  userName = 'User',
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
  limitHold,
  autoResume,
  onCancelHold,
  onResumeHold,
  onAutoResume,
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
  onPopout,
  onPermission,
  onAnswer,
  onDismissQuestion,
  renaming,
  onStartRename,
  onRename,
  onToggleLock,
  onCycleColor,
  btwWins,
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
  // 턴이 끝나도 백그라운드(셸·에이전트·워크플로)가 남아 돌면 아직 '완료'가 아니다 —
  // 완료 칩·컬러 링은 전부 걷힌 순간에만 켠다 (진짜 완료 판정 — store의 단일 규칙)
  const effStatus = effectiveStatus(state)
  // ★ R2 — 중단으로 끝난 턴은 '완료'가 아니다(m3 R2의 `TerminalStatus::Aborted` 짝).
  // 와이어에는 그 어휘가 없어 셸이 `done`으로 접어 보내므로, 화면에 남은 '중단함' 마커가
  // 렌더러의 판정 근거다(store/session.ts `abortedTurn`). effectiveStatus가 이미 완료
  // 색·완료 링을 껐고, 여기서는 칩 **문구**를 「중단됨」으로 바로잡는다.
  const status = waiting
    ? { label: () => t('응답 대기', 'Needs input'), cls: 'ask' }
    : abortedTurn(state)
      ? { label: () => t('중단됨', 'Stopped'), cls: 'idle' }
      : STATUS_META[effStatus]
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
  // 초기화(/clear·제스처)로 스레드가 비면 따라가기·점프 버튼도 백지로 — 패널의 clear는
  // ActiveSession(clearPanel) 소관이라 여기서 빈 스레드를 신호로 받는다. 빈 스레드는
  // scroll 이벤트가 없어 showJump 잔상이 저절로 안 꺼진다(2026-09-01 사용자 보고)
  const emptied = state.messages.length === 0
  useEffect(() => {
    if (emptied) follow.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emptied])
  // ★ 3.0 M-UX R3 — 읽던 자리 앵커. 접히면(=이 패널이 언마운트되면) 뷰포트 맨 위
  // **메시지 id**를 자리 키에 적어 두고, 되올라오면 그 메시지를 같은 오프셋에 놓는다.
  // 크리틱 §2-⑧ `raise.scroll`의 정공법 — 픽셀 복원은 6분할↔n1에서 다른 문단에 착지한다.
  // **호출 순서가 계약이다**: `useThreadFollow`보다 뒤여야 그 마운트 스냅(바닥 고정)을
  // 이 훅의 effect가 뒤에서 바로잡는다.
  useThreadAnchor({
    anchorKey,
    scrollEl: threadEl,
    messages: state.messages,
    start: twin.start,
    ensureIndex: twin.ensureIndex,
    unpin: follow.unpin,
    isStuck: follow.isStuck
  })

  // 작업 인디케이터는 '답변 본문 스트리밍 중'에만 숨긴다 — 사고·도구·침묵 구간엔 계속 띄운다
  const showWorking = !state.streaming && !state.pendingQuestion && !state.pendingCommand
  // 스트리밍 중 매 토큰 렌더에서 MessageView memo가 유지되도록 — 인라인 화살표를 넘기면
  // 매 렌더 새 함수 정체성이 완료된 메시지까지 전부 리렌더(마크다운 재파싱)시킨다
  const openFile = useEvent((p: string, line?: number) => onOpenFile(slot, p, line))
  // ★3.0.5 — 알림 band 콜백도 같은 규칙. 인라인 화살표라 토큰마다 스레드의 MessageView 전부가
  // memo를 잃고 다시 그려졌다(감사 #4 — 바로 위 주석이 금지한 그 모양).
  const notify = useEvent((a: NotifyAction) => {
    if (a.kind === 'billing-off') onApiMode(slot, false, meta.picker.engine)
  })
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
      className={'ma-panel' + (effStatus === 'done' ? ' done' : '') + (focused ? ' focused' : '')}
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
          {num}
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
              {/* 제목 잠금 — 잠그면 /clear·제스처 비우기·폴더 변경에도 제목이 남는다.
                  잠김 상태는 호버 없이도 보여야 하는 상태 표식이라 .on은 상시 표시 */}
              <button
                className={'ma-p-tlock has-tip' + (meta.locked ? ' on' : '')}
                data-tip={
                  meta.locked
                    ? t('제목 잠금 해제', 'Unlock title')
                    : t('제목 잠금 — 대화를 비워도 유지', 'Lock title — kept when the chat is cleared')
                }
                aria-label={meta.locked ? t('제목 잠금 해제', 'Unlock title') : t('제목 잠금', 'Lock title')}
                onClick={() => onToggleLock(slot)}
              >
                {meta.locked ? <IconLock size={11} /> : <IconLockOpen size={11} />}
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
                : // 칩에 이미 「바탕화면」이 보이므로 툴팁에 되풀이하지 않는다(2026-09-01 사용자 지적)
                  t('클릭해 폴더 선택', 'Click to choose a folder')
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
        {/* ★M9·R3 — 도구 환경 칩(MCP & Skill). 폴더 칩 **오른쪽**(2026-09-01 사용자 결정:
            읽는 순서 「어느 폴더 → 무엇이 붙어 있나」). 첫 실행 전에도 디스크 스캔으로
            항상 선다 — 설정 ▸ MCP/Skill 탭을 걷어낸 자리를 이 칩이 넘겨받았다.
            ★R2 `onOpen` — 팝오버 배타. 도구 칩이 열릴 때 폴더 팝오버를 접는다(반대
            방향은 칩 쪽 캡처 리스너가 닫는다). 두 팝오버는 같은 자리(`.ma-p-head` 오른쪽
            끝)에 뜨므로, 하나라도 안 닫히면 정확히 포개져 뒤엣것이 통째로 가려진다. */}
        <McpSkillView panelId={panelId} cwd={cwd} engine={meta.picker.engine} account={meta.picker.codexAccount} apiMode={meta.api} onOpen={() => setFolderPop(false)} />
        <span className={'ma-status ' + status.cls}>
          {/* 응답 대기 중엔 스피너를 숨긴다 — 도는 건 에이전트가 아니라 사용자 차례 */}
          {busy && !waiting && <span className="ma-status-spin" />}
          <span>{status.label()}</span>
          {busy && <span className="ma-status-time">{fmtElapsed(elapsed)}</span>}
        </span>
        {/* 별도 창으로 — 이 패널을 독립 OS 창으로 팝아웃 (듀얼 모니터: 창은 왼쪽, 그리드는 오른쪽)
            n1(IDE 크롬)에서는 숨김 — 패널이 이미 창 전체라 무의미하다(2026-09-01 사용자 결정) */}
        {onPopout && !topbar && (
          <button
            className="ma-p-expand has-tip"
            data-tip={t('별도 창으로', 'Open in its own window')}
            aria-label={t('별도 창으로', 'Open in its own window')}
            onClick={() => onPopout(slot)}
          >
            <IconPopout size={12} />
          </button>
        )}
        {/* 크게 보기 ⟷ 원래 크기로 — 이 패널을 본채팅 크기의 오버레이 카드로 (작은 글씨 대책)
            같은 이유로 n1에서는 숨김 — 이미 본채팅 크기다 */}
        {!topbar && (
          <button
            className="ma-p-expand has-tip"
            data-tip={expanded ? t('원래 크기로 (Esc)', 'Restore size (Esc)') : t('크게 보기', 'Expand')}
            aria-label={expanded ? t('원래 크기로', 'Restore size') : t('크게 보기', 'Expand')}
            onClick={() => onToggleExpand(slot)}
          >
            {expanded ? <IconCollapse size={12} /> : <IconExpand size={12} />}
          </button>
        )}
        {/* ★ n1(IDE 크롬) — 이 헤더가 TopBar를 겸한다. 다이얼의 x좌표가 2‥6의 .ma-head와
            같은 자리(오른쪽 끝 창 컨트롤 앞)라 1↔2 전환에서 버튼이 안 움직인다(§2.1) */}
        {topbar}
        {/* 컬러 태그 — 헤더 하단 전폭 2px 라인. 기본은 슬롯 색(1=보라, 2=파랑…), 번호 칩 클릭으로 순환.
            색은 패널 루트의 --ptag(완료 테두리와 공유) */}
        <span className="ma-p-tag" />
      </div>

      <div className="ma-p-body">
        <div className="ma-p-thread scroll" ref={threadRef}>
          {!started && !busy ? (
            topbar ? (
              // ★ n1(IDE 크롬)의 빈 화면 = 본채팅·추가 채팅과 같은 웰컴(마스코트+인사+추천).
              // 다이얼 2→1로 돌아왔을 때 컴팩트 빈 화면이 나오면 "다른 화면"처럼 보여
              // 통합이 깨져 보인다(2026-09-01 사용자 보고). 컴팩트판은 그리드(2‥6) 전용.
              <WelcomeState
                userName={userName}
                onPick={(text) => {
                  onInput(slot, text)
                  composerRef.current?.focus()
                }}
              />
            ) : (
              <div className="ma-p-empty">
                {/* 공식 로봇 마스코트 — 웰컴 화면(.wc-mark)과 같은 정지 아이콘 */}
                <div className="ma-p-empty-ic">
                  <IconMascot size={38} />
                </div>
                <div className="ma-p-empty-text">{t('메시지를 입력해 작업을 시작하세요', 'Type a message to start working')}</div>
              </div>
            )
          ) : (
            // 본채팅과 같은 .thread 마크업 — 패널에선 CSS(zoom .8·풀폭)만 다르고,
            // Ctrl+휠 읽기 크기(chat.zoom)는 그 위에 곱으로 얹힌다(전 패널 공통)
            <div className="thread" style={{ zoom, '--z': zoom } as CSSProperties}>
              {twin.start > 0 && <div className="thread-older" ref={twin.sentinelRef} aria-hidden="true" />}
              {state.messages.slice(twin.start).map((m, i) => (
                <MessageView
                  key={m.id}
                  item={m}
                  cwd={meta.cwd || state.session?.cwd || ''}
                  live={twin.start + i === liveIdx && m.kind === 'msg' && m.role === 'assistant' && !m.error}
                  running={busy}
                  onOpenFile={openFile}
                  onOpenImage={onOpenImage}
                  // ★ M-UI — 알림 band의 행동 알약. 패널엔 통합 스토어의 chatId 배선이
                  // 아직 없어 `revert`는 못 준다 → 그 알약은 **아예 안 그려진다**
                  // (누르면 아무 일 없는 버튼을 그리는 게 제일 나쁘다). 과금은 패널 소유다.
                  // ★ 잔여 — 그 "안 그려진다"를 코드가 안 지키고 있었다(`onNotify`만 있으면
                  // 그렸다 = 죽은 버튼). 이제 `canRevert`를 **안 주는 것**이 그 선언이다.
                  onNotify={notify}
                />
              ))}
              {busy && showWorking && <WorkingIndicator elapsed={elapsed} retry={state.apiRetry ?? null} />}
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
      {/* 그리드에선 RU(→↑, 최대화 문법)=크게 보기, 카드에선 같은 RU 한 번 더=별도 창으로
          (확대의 다음 단계라 같은 획이 자연스럽다 — 팝아웃 창 안에선 onPopout이 없어 무동작),
          DR(↓→, 닫기 문법)=원래 크기로. 카드의 RU '토글 닫기'는 최대화 제스처와 헷갈려
          뺐던 자리(사용자 피드백) — 닫기는 다른 카드·뷰어와 같은 ↓→ 하나로 통일 */}
      <MouseGestureLayer
        target={threadEl}
        actions={[
          // ↑/↓는 follow 래치 규칙(본채팅과 동일) — ↑는 윈도를 다 펼치고 고정을 풀며 올라간다
          { pattern: 'U', label: t('맨 위로', 'Scroll to top'), run: () => { twin.showAll(); follow.scrollTop() } },
          { pattern: 'D', label: t('맨 아래로', 'Scroll to bottom'), run: () => follow.jumpBottom() },
          sessionWindowGesture(),
          clearGesture(() => onClear(slot)),
          ...(expanded
            ? [
                { pattern: 'DR', label: t('원래 크기로', 'Restore size'), run: () => onToggleExpand(slot) },
                ...(onPopout
                  ? [{ pattern: 'RU', label: t('별도 창으로', 'Open in its own window'), run: () => onPopout(slot) }]
                  : [])
              ]
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
      {/* 한도 자동 이어서 상태줄 — 이 패널 대기표의 재개 예정 (본채팅과 같은 공용 바) */}
      <LimitHoldBar hold={limitHold} enabled={autoResume} onCancel={() => onCancelHold(slot)} onContinue={() => onResumeHold(slot)} />
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
        autoResume={autoResume}
        onAutoResumeChange={onAutoResume}
        images={meta.images}
        onPickImages={pickImages}
        onAddImagePaths={(paths) => onAddImages(slot, paths)}
        onRemoveImage={(i) => onRemoveImage(slot, i)}
        onOpenImage={onOpenImage}
        cwd={cwd}
        mentionBase={cwd}
        commands={slashCommandsWithBtw()}
        inputRef={composerRef}
        // ★R28 ACCT §3 — 이 자리의 식별자. 계정 picker가 「사용 중」 역인덱스에서 자기
        // 자리를 뺄 때 쓴다(자기 자리는 경고가 아니라 「현재」다). 패널은 자기 chatId를
        // 모르고 자리 키만 아는데, 셸이 `chat:status`에 같은 키를 실어 준다.
        chatId={panelId}
      />

      {/* 패널 스코프 카드 — .ma-panel(position:relative) 안에서 그 패널만 덮으므로
          어느 패널의 요청인지 위치로 식별된다. 키보드는 포커스된 패널의 카드만
          받는다 — 동시에 여러 카드가 떠도 키 한 번이 전부에 응답되지 않도록.
          btw 도크는 워크플로 도크보다 DOM 앞 — 동시 상주 시 :has(~)로 한 층 위로 비킨다 */}
      <BtwDock wins={btwWins} onFocus={btwFocus} onClose={btwClose} />
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

// ── ★ 3.0 M-UX — 접힘 배지 + 팝오버 (ux-chat-unify §2.2-3, 목업 chat-unify-collapse) ──
//
// 다이얼을 내리면 나머지 자리는 **삭제가 아니라 접힘**이다. 대화가 어디로 갔는지
// 화면이 답해야 하고(사용자 요구 "6→1로 내려도 나머지 대화가 삭제되면 안 된다"),
// 답하는 자리가 셋이다 — 사이드바 「채팅」 목록 · 이 배지 · 헤더 실행 요약 칩.
export interface FoldRow {
  slot: number
  num: number // 접힘 집합 안에서의 자리 번호 (count+1 부터)
  title: string
  status: AgentStatus
  ask: boolean // 승인/질문이 대기 중 — 배지의 ‼N (§2.2-5)
  color: string
}
/** ★ 3.0 M-UX R2 — TopBar 돋보기. 본채팅 `ChatHeader`와 **같은 문법**:
 *  `ccg:chat-find` 창 이벤트를 쏘고 열림 상태(`ccg:chat-find-state`)를 구독해 켜짐을 표시한다.
 *  받는 쪽은 포커스된 패널의 `ChatFind` 하나뿐이라 카드가 여럿 열리는 일은 없다. */
function PanelFindButton() {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const h = (e: Event): void => setOn(!!(e as CustomEvent).detail)
    window.addEventListener('ccg:chat-find-state', h)
    return () => window.removeEventListener('ccg:chat-find-state', h)
  }, [])
  return (
    <button
      className={'h-ic has-tip' + (on ? ' on' : '')}
      data-tip={t('대화에서 찾기 (Ctrl+F)', 'Find in chat (Ctrl+F)')}
      aria-label={t('대화에서 찾기', 'Find in chat')}
      onClick={() => window.dispatchEvent(new Event('ccg:chat-find'))}
    >
      <IconSearch size={15} />
    </button>
  )
}

/** ★ 3.0 M-UX R2 — 본채팅(IDE 크롬)에서 **접힘 배지 자리만** 예약한다.
 *  일반 채팅에는 접힐 자리가 없지만, 자리를 안 비우면 같은 다이얼이 보드 크롬(n1)보다
 *  오른쪽에 앉는다 — 「1↔2에서 다이얼이 안 움직인다」는 규약이 크롬 경계에서 깨진다.
 *  (모듈 상수 두 개로 정체성을 고정 — memo된 헤더가 렌더마다 새 prop을 받지 않게) */
const EMPTY_FOLD_ROWS: FoldRow[] = []
const NOOP_RAISE = (_slot: number): void => {}
export function FoldSlotHold() {
  return <FoldBadge rows={EMPTY_FOLD_ROWS} onRaise={NOOP_RAISE} />
}

function FoldBadge({ rows, onRaise }: { rows: FoldRow[]; onRaise: (slot: number) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  // ★ 3.0 M-UX R2 — 접힘이 없어도 **자리를 비워 둔다**(배지는 없고 폭만 남는다).
  // §2.1은 *"1↔2 전환에서 다이얼 버튼이 화면에서 이동하지 않는다 — 위치 고정이 규약"*
  // 이라 못 박았는데, 배지가 다이얼 **오른쪽**에서 나타났다 사라지면 오른쪽 정렬 줄에서
  // 다이얼이 그만큼 밀린다(크리틱 M-UX R1 §2-⑥: n6 976 → n2 929, −47px. 같은 화면
  // 좌표를 다시 누르면 「2」 자리에 「4」가 와 있다).
  // 자리표시자는 **배지가 아니다** — 클래스를 나눠 두어 "n6인데 배지가 남았다"(유령)와
  // 구분된다. 폭은 같은 박스 규칙(.ma-fold-badge/.ma-fold-hold 공용)에서 나온다.
  if (rows.length === 0)
    return (
      <span className="ma-fold hold" aria-hidden="true">
        <span className="ma-fold-hold">
          <IconChevDown size={12} />
          <span className="cnt">0</span>
        </span>
      </span>
    )
  const asks = rows.filter((r) => r.ask).length
  // 대기 중인 자리를 맨 위로 — 배지를 눌러 여는 이유가 대개 그것이다(§2.2-5)
  const sorted = [...rows].sort((a, b) => Number(b.ask) - Number(a.ask))
  return (
    <span className="ma-fold" ref={ref}>
      <button
        className={'ma-fold-badge has-tip' + (open ? ' open' : '') + (asks ? ' alert' : '')}
        data-tip={t(`접힌 자리 ${rows.length}개 — 대화는 그대로예요`, `${rows.length} folded slots — the chats are all still here`)}
        aria-label={t('접힌 자리', 'Folded slots')}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <IconChevDown size={12} />
        <span className="cnt">{rows.length}</span>
        {asks > 0 && <span className="bang">‼{asks}</span>}
      </button>
      {open && (
        <div className="ma-fold-pop">
          <div className="ph">
            <span>{t(`접힌 자리 ${rows.length}개`, `${rows.length} folded slots`)}</span>
            <span className="sp" />
            <span>{t('이 배치에만 접혀 있어요', 'Folded in this board only')}</span>
          </div>
          {sorted.map((r) => (
            <button
              key={r.slot}
              className={'ma-fold-row' + (r.ask ? ' waiting' : '')}
              onClick={() => {
                setOpen(false)
                onRaise(r.slot)
              }}
            >
              <span className="num" data-tag={r.color || defaultTag(r.slot)}>{r.num}</span>
              <span className="t">{r.title || t('새 채팅', 'New chat')}</span>
              <span className={'st ' + (r.ask ? 'ask' : statusKind(r.status))}>
                {r.ask ? t('대기', 'Waiting') : statusLabel(r.status)}
              </span>
              <span className="act">↥</span>
            </button>
          ))}
          <div className="pf">
            <span>{t('↥ = 1번 자리로 올리기', '↥ = raise to slot 1')}</span>
            <span className="sp" />
            <span>{t('다이얼을 되올리면 전부 제자리', 'Turn the dial back up and they all return')}</span>
          </div>
        </div>
      )}
    </span>
  )
}
function statusKind(s: AgentStatus): string {
  if (s === 'working' || s === 'analyzing') return 'run'
  if (s === 'done') return 'done'
  if (s === 'error') return 'err'
  return ''
}
function statusLabel(s: AgentStatus): string {
  if (s === 'working' || s === 'analyzing') return t('작업 중', 'Working')
  if (s === 'done') return t('완료', 'Done')
  if (s === 'error') return t('오류', 'Error')
  return t('대기', 'Idle')
}

// 다이얼 — .ma-count 마크업은 2.6.2 그대로다(1이 하나 늘었을 뿐). 두 크롬(n1 패널 헤더 /
// 2‥6 .ma-head)이 **같은 조각**을 쓰기 때문에 1↔2 전환에서 버튼이 화면에서 안 움직인다(§2.1).
export function PanelDial({ count, onPick }: { count: number; onPick: (n: number) => void }) {
  return (
    <div className="ma-count" role="tablist" aria-label={t('패널 수', 'Panel count')}>
      {COUNT_OPTIONS.map((n) => (
        <button
          key={n}
          role="tab"
          aria-selected={count === n}
          className={'ma-count-btn' + (count === n ? ' on' : '')}
          data-count={n}
          onClick={() => onPick(n)}
        >
          {n}
        </button>
      ))}
    </div>
  )
}

// n1(IDE 크롬) 웰컴 인사말용 닉네임 — App(userFromProfile)·SessionWindow와 같은 소스
// (getProfile + ccg-profile-changed). 프로필이 없으면 본채팅 기본값(User)과 같은 글자.
function useProfileName(): string {
  const [name, setName] = useState('User')
  useEffect(() => {
    window.api
      .getProfile()
      .then((p) => {
        if (p?.nickname?.trim()) setName(p.nickname.trim())
      })
      .catch(() => {})
    const onChanged = (e: Event): void => {
      const p = (e as CustomEvent<{ nickname?: string }>).detail
      if (p?.nickname?.trim()) setName(p.nickname.trim())
    }
    window.addEventListener('ccg-profile-changed', onChanged)
    return () => window.removeEventListener('ccg-profile-changed', onChanged)
  }, [])
  return name
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
  autoResume,
  onAutoResumeChange,
  onFirstPrompt,
  onStatus,
  onCommit,
  onExplorerInfo,
  onPanelInfo,
  countSeed,
  raiseSeed,
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
  autoResume: boolean // 한도 자동 이어서(전역 pref) — 패널 과금 picker 체크 + 대기표 발화 게이트
  onAutoResumeChange: (on: boolean) => void // 체크 토글 (본채팅과 같은 pref를 쓴다)
  onFirstPrompt: (sessionId: string, prompt: string) => void
  onStatus: (sessionId: string, status: AgentStatus) => void
  onCommit: (sessionId: string, payload: CommitPayload) => void
  onExplorerInfo?: (info: MultiExplorerInfo) => void // 왼쪽 칼럼 탐색기가 따라갈 패널 보고
  onPanelInfo?: (list: PanelSummary[]) => void // ★ 통합 사이드바 「채팅」에 실을 자리 요약
  countSeed?: { n: number; seq: number } // ★ 다른 크롬(일반 채팅)의 다이얼이 고른 자리 수
  raiseSeed?: { slot: number; seq: number } // ★ 사이드바에서 고른 접힌 자리 → 1번 자리로
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
  // n1(IDE 크롬) 웰컴 인사말 — 본채팅과 같은 프로필 닉네임
  const profileName = useProfileName()

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
  const [focusedSlot, setFocusedSlot] = useState<number | null>(null)
  // 패널 표시 순서(슬롯 순열) — 헤더 길게 누르기 드래그로 바꾼다. 그리드가 이 순서로
  // 그리고, 슬롯 정체성(엔진·대화·컬러 태그)은 패널을 따라간다. 세션에 영속.
  // 번호 칩은 자리 기준(1‥N) — 옮기면 그 자리의 번호를 새로 받는다.
  const [panelOrder, setPanelOrder] = useState<number[]>(() => sanitizePanelOrder(initial.panelOrder))
  // ★3.0.8 — 다이얼을 줄이며 끌어올린 자리의 오버레이(`lib/panelLayout.ts`). 늘리면 `base`로 되돌아간다.
  // 손으로 순서를 바꾸면(드래그·↥ 올리기) 그 순서가 새 진실이라 걷는다. 세션에 영속.
  const [promo, setPromo] = useState<LayoutPromo | null>(() => sanitizePromo(initial.promo, SLOT_COUNT))
  // 지금 보이는 슬롯들, 자리 순서대로 — 번호(인덱스+1)·그리드 렌더의 단일 소스.
  //
  // ★ 3.0 M-UX (ux-chat-unify §2.2) — 판정 기준이 **슬롯 번호**에서 **order 내 위치**로
  // 바뀌었다. 2.6.2는 `panelOrder.filter(s => s < count)`라, 6→2로 줄이면 슬롯 4·5번
  // 패널이 "보이던 자리"를 통째로 잃었다(자리 번호와 슬롯 번호가 묶여 있었다).
  // 지금은 `order.slice(0, count)` — 접힌 자리는 `order.slice(count)`이고, 대화는
  // 어디로도 가지 않는다. 되올리면 같은 자리로 돌아온다(slots를 안 건드리므로).
  const visibleSlots = panelOrder.slice(0, count)
  const foldedSlots = panelOrder.slice(count)
  const [metas, setMetas] = useState<PanelMeta[]>(() =>
    SLOTS.map((i) => {
      const p = initial.panels?.[i]
      return p
        ? {
            title: p.title ?? '',
            custom: !!p.custom,
            locked: !!p.locked,
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
    Array.from(
      // ★ 보이는 자리 기준 — 슬롯 번호(slice(0,count))가 아니라 order 위치다(§2.2)
      new Set(visibleSlots.map((i) => metas[i]).filter((m) => m.picker.engine !== 'codex').map((m) => m.picker.account ?? ''))
    ).sort()
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
  // ★ n1(IDE 크롬)은 미니어처가 아니라 본채팅과 같은 크기 — 배율 키도 본채팅 것을 쓴다
  // (§4.2 zoom.ide←chat.zoom / zoom.grid←multi.zoom). useZoom은 키가 바뀌면 다시 읽는다.
  const multiZoom = useZoom(count === 1 ? 'chat.zoom' : 'multi.zoom', true, count === 1 ? 1 : 1.2)
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
  // rebound — 대상 패널이 접혀 다른 자리로 옮겨 붙었다는 표식(뷰어 헤더 한 줄 안내, §2.2-1b)
  const [openFile, setOpenFile] = useState<{ slot: number; path: string; line?: number; rebound?: boolean } | null>(null)
  // WorkBar 서브에이전트 행에서 연 상세 카드 — 열려 있는 동안 그 패널의 라이브 상태를 따른다
  const [openSub, setOpenSub] = useState<{ slot: number; id: string } | null>(null)
  // 스레드/컴포저 이미지 → 라이트박스 (본채팅과 동일한 뷰어를 세션 레벨에서 한 번만)
  const [viewer, setViewer] = useState<{ images: string[]; index: number } | null>(null)

  // ── ★ 3.0 M-UX §2.2-1b — 고아 UI 정리 관문 ───────────────────────────────
  //
  // 보이는 자리 집합이 바뀌는 **모든** 전이는 setVisible을 지나고, setVisible은 반드시
  // reconcileChatRefs를 부른다. 2.6.2는 이 정리가 다이얼 버튼 onClick 안에 인라인이라
  // (MultiAgent.tsx:1823-1827) 다른 경로로 자리가 바뀌면 안 돌았다 — 접힌(=화면에 없는)
  // 패널을 가리킨 채 뷰어·서브에이전트 카드가 남는 유령 UI가 그래서 생긴다.
  //
  // 닫기 vs 재바인드의 갈림은 "내용이 그 채팅의 것인가"다:
  //   · 뷰어(openFile)  → **재바인드**. 파일 읽기는 채팅과 무관하고 뷰어는 앱 크롬이다.
  //   · 서브에이전트·크게보기·라이트박스 → **닫는다**(그 채팅 원장/스레드의 내용).
  //   · 포커스 → order[0]로 재바인드(키보드 스코프는 항상 정의돼 있어야 한다).
  //   · 이름 편집 → 커밋 후 닫기(입력 중이던 글자를 버리지 않는다 — 인풋 onBlur가 커밋).
  const reconcileChatRefs = useEvent((vis: number[]) => {
    const seen = new Set(vis)
    const fallback = vis[0] ?? 0
    setFocusedSlot((s) => (s != null && !seen.has(s) ? fallback : s))
    setRenamingSlot((s) => (s != null && !seen.has(s) ? null : s)) // 커밋은 인풋 blur가 한다
    setExpandedSlot((s) => (s != null && !seen.has(s) ? null : s))
    setOpenSub((v) => (v && !seen.has(v.slot) ? null : v))
    // 이미지 라이트박스는 슬롯을 물고 있지 않다(열 때 이미지 배열을 사본으로 받는다) —
    // 고아가 될 대상이 없어 여기서 손댈 것이 없다. 스펙 표의 lightboxSource는
    // chatId를 들고 다니는 통합 모델(2단계)에서 생긴다.
    setOpenFile((f) => (f && !seen.has(f.slot) ? { ...f, slot: fallback, rebound: true } : f))
    // ★M8-R2 — **팝아웃 OS 창도 자리에 묶인 표면이다.** 자리가 접히면 그리드에 그 창을
    //   가리킬 표식(유령 셀)이 사라져 창만 화면에 남는다 = 사용자가 제보한 그 고아 UI
    //   (크리틱 M8 §3.2 실측: gridPanels 1 · ghostAfter false · popStillOpen true).
    //   이 관문이 "보이는 자리 집합을 바꾸는 모든 전이"의 유일한 문이므로 여기 등록한다.
    //   자리를 접으면 창도 접는다 — 닫힘 → `ma:panel-closed` → 복귀분은 접힌 자리로
    //   정상 적용되고(slotOfPanelId는 접힘을 안 본다), 셸이 닫기 전에 마지막 저장까지
    //   청하므로(popout.rs `flush_before_close`) **데이터는 잃지 않는다.**
    //   `popped`는 아래(팝아웃 블록)에서 선언되지만 useEvent라 호출 시점 클로저가 최신이다.
    for (const key of Object.keys(popped)) {
      const s = Number(key)
      if (!seen.has(s)) window.api.multi?.panelClose?.(chan(sessionId, s)).catch(() => {})
    }
  })
  // 보이는 자리 집합을 바꾸는 유일한 문 — 소비자: ① 다이얼 ② 접힘 팝오버 「↥ 1번 자리로」
  // ③ 사이드바에서 접힌 대화 선택. 여섯 번째가 생겨도 규칙은 안 샌다(열거가 아니라 관문).
  const setVisible = useEvent((nextOrder: number[], nextCount: number) => {
    const n = clampCount(nextCount)
    setPanelOrder(nextOrder)
    setCount(n)
    // ★ R2 — n1은 자리가 하나뿐이니 그 자리가 곧 「지금 대화」다. 포커스를 안 세우면
    // 그 패널의 ChatFind가 `active=false`라 **Ctrl+F도 헤더 돋보기도 죽는다**
    // (일반 채팅에서는 되는 기능이 n1에서만 안 되는 것 — 두 갈래의 어포던스 격차).
    if (n === 1) setFocusedSlot(nextOrder[0])
    reconcileChatRefs(nextOrder.slice(0, n))
  })
  // 다이얼 — 줄일 때 **포커스된 자리를 order 맨 앞으로** 올린다(§2.2-1 "현재 대화 = 1번 자리").
  // 나머지 상대 순서는 보존된다.
  //
  // ★2026-09-02 — 접히게 된 포커스 자리는 맨 앞이 아니라 **보이는 마지막 자리(next번)**로
  // 온다. 맨 앞에 끼우면 1‥next-1번이 전부 한 칸씩 밀린다: 4→2에서 3번 패널에 포커스가
  // 있으면 [3,1 | 2,4]가 되고 다시 4로 늘리면 [3,1,2,4] — 사용자에겐 "1번·2번 순서가
  // 뒤틀렸다"로 보였다(패널 아무 데나 클릭해도 포커스가 잡히니 언제 그러는지 알 수 없었다).
  // 마지막 자리로 오면 1‥next-1번은 그대로고 밀리는 건 포커스 자리와 접히는 자리 사이뿐이다.
  // next=1이면 맨 앞이라 "현재 대화 = 1번 자리"(IDE 크롬)는 그대로 성립한다. 늘릴 때는
  // 어느 판에서도 순서를 안 건드린다.
  //
  // ★3.0.8 — 그 승격이 `panelOrder`를 **영구히** 바꿔 5→1(포커스 5번)→5를 되풀이할 때마다 원래
  // 1‥4번이 한 칸씩 밀렸다(「1번이던 패널이 5번에 가 있다」 — 2026-09-04 제보). 이제 승격은
  // 오버레이(`promo`)이고 늘릴 때 승격 전 순서로 되돌린다 — 규칙은 `lib/panelLayout.ts` 한 곳.
  const applyCount = useEvent((n: number) => {
    const next = clampCount(n)
    const cur = panelOrder
    const keep = focusedSlot != null && cur.includes(focusedSlot) ? focusedSlot : cur[0]
    const r = resizeLayout({ order: cur, count, promo }, next, keep)
    setPromo(r.promo)
    setVisible(r.order, next)
  })
  // 접힌 자리를 1번 자리로 올린다(팝오버 ↥ · 사이드바 클릭). count는 그대로 —
  // 자리 수를 바꾸지 않고 **누가 보이는가**만 바꾼다. 밀려난 자리는 접힘 집합 맨 앞으로.
  const raiseSlot = useEvent((slot: number) => {
    const cur = panelOrder
    if (cur.indexOf(slot) < count) {
      setFocusedSlot(slot) // 이미 보이는 자리 — 포커스만
      return
    }
    setPromo(null) // 손으로 올린 순서가 새 진실 — 다이얼 오버레이는 걷는다(★3.0.8)
    setVisible([slot, ...cur.filter((s) => s !== slot)], count)
    setFocusedSlot(slot)
  })
  // 접힘 배지가 세는 것 — **내용이 있는** 접힌 자리만(빈 자리는 대화가 아니다, §2.4).
  // 자리 번호는 접힘 집합 안의 순서(count+1‥6) — 되올리면 그 번호로 돌아간다.
  const foldRows: FoldRow[] = foldedSlots
    .map((slot, i) => ({
      slot,
      num: count + i + 1,
      title: metas[slot].title,
      status: effectiveStatus(sessions[slot].state),
      ask: !!(sessions[slot].state.pendingPermission || sessions[slot].state.pendingQuestion),
      color: metas[slot].color
    }))
    .filter((r) => !!r.title || sessions[r.slot].state.messages.length > 0)
  // 자리 밖 실행 — 접혀 있어도 엔진은 돈다(불변식 4). 헤더 요약 칩이 그 사실을 말한다.
  const foldedRunning = foldRows.filter((r) => r.status === 'working' || r.status === 'analyzing').length


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

  // ★2026-09-04 — 엔진이 착지한 **계정**(한도 자동 전환·되돌리기)도 그 자리의 picker에 미러링한다
  // — 위 모델 폴백과 같은 이유(안 바꾸면 다음 전송이 옛 계정을 실어 전환을 되돌리고, 다른
  // 자리의 「사용 중」 칩과 이 자리의 칩이 서로 다른 계정을 말한다 — 2026-09-04 보고: NetCore가
  // lmg56631로 전환됐는데 칩은 lmg56630, 그래서 「lmg56631 사용 중 · 2곳」이 유령처럼 보였다).
  // 자리 대응은 셸이 준 살아 있는 행(chatId ↔ panelId)이 우선, 없으면 채번 규칙 `ma-{board}-{slot}`.
  // 예약 메시지의 picker 스냅샷도 같이 고친다(드레인 때 옛 계정을 싣지 않게). 규칙은 lib/identityLanding.ts.
  useEffect(
    () =>
      onChatIdentity((p) => {
        const id = p.chatId ?? ''
        if (!id) return
        const pid = panelIdOfChat(id)
        const slot = pid?.startsWith(sessionId + '::') ? Number(pid.slice(sessionId.length + 2)) : panelSlotOfChat(id, sessionId)
        if (slot == null || !Number.isInteger(slot)) return
        setMetas((prev) => {
          const m = prev[slot]
          if (!m) return prev
          const pk = pickerAfterLanding(m.picker, p)
          const q = queueAfterLanding(m.queue, p)
          if (pk === m.picker && q === m.queue) return prev
          return prev.map((x, i) => (i === slot ? { ...x, picker: pk, queue: q } : x))
        })
      }),
    [sessionId]
  )

  // cheap signature of every panel session (status + message count)
  const sig = sessions.map((s) => s.state.status + ':' + s.state.messages.length).join('|')

  // report aggregate status up for the recent-list dot
  // 세션 레일 점도 '진짜 완료' 규칙 — 백그라운드가 남아 도는 패널은 working으로 집계
  const aggStatus = aggregateStatus(sessions.map((s) => effectiveStatus(s.state)))
  useEffect(() => {
    onStatus(sessionId, aggStatus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aggStatus])

  // 예산(전역 누적) — API 과금 패널의 WorkBar 컨텍스트 팝오버(비용 행)용. API 패널이
  // 있을 때만 읽고, 실행이 끝날 때마다 다시 읽어 실행 직후 바로 맞아떨어지게 한다
  const billApi = visibleSlots.filter((i) => metas[i].api).length
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
  const buildRef = useRef<() => CommitPayload>(() => ({ count, panelOrder: [...SLOTS], promo: null, panels: [] }))
  buildRef.current = () => ({
    count,
    panelOrder,
    promo,
    panels: SLOTS.map((i) => {
      const m = metas[i]
      return {
        title: m.title,
        custom: m.custom,
        locked: m.locked,
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
  }, [count, metas, sig, panelOrder, promo])
  useEffect(() => {
    return () => onCommit(sessionId, buildRef.current())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Panel keyboard control (only while focus isn't in a field):
  //  · Enter      drop the cursor into the selected panel's composer (e.g. after a click)
  //  · Esc        cancel the focused panel's RUN if it's busy (단일 모드의 Esc=작업 취소와
  //               같은 기대), else release the selection
  // A permission/question card owns the keyboard while open, so we always stand down then.
  //
  // 이벤트 시점의 busy를 읽어야 해서 useEvent — 키보드 effect는 [focusedSlot, count]에만
  // 재바인딩되므로 클로저의 sessions는 그 사이 얼어 있다(막 busy로 바뀐 패널을
  // 못 보고 선택만 풀던 원인).
  const escCancelPanel = useEvent((slot: number): boolean => {
    // 팝아웃 유령도 포커스가 되므로(폴더 탐색기 따라가기) 여기로 올 수 있다 — 그 실행은
    // 다른 창에서 보고 있으니 그리드의 눈먼 Esc로 끊으면 사고(escCancelSole과 같은 규칙)
    if (popped[slot]) return false
    const sess = sessions[slot]
    // 상주 워크플로(busy=false지만 도는 중)도 Esc 취소 대상 — 중지 버튼과 같은 의미.
    // 회수(턴 걷기 + 문장 복원)는 stopPanel이 공통으로 처리한다.
    if (!sess.busy && !sess.state.workflows.some((w) => w.status === 'running')) return false
    stopPanel(slot)
    return true
  })
  // 팝아웃 여부 — 키보드 핸들러용 접근자. popped 상태는 아래(팝아웃 블록)에서 선언되고
  // 키보드 effect는 [focusedSlot, count, expandedSlot]에만 재바인딩되므로, dep에 넣는
  // 대신(선언 전 참조 = TDZ) useEvent로 이벤트 시점의 최신값을 읽는다(sessions와 동일).
  const isPopped = useEvent((slot: number): boolean => !!popped[slot])
  // 포커스 없이 Esc — 도는 패널(busy 또는 상주 워크플로)이 딱 하나면 그걸 취소한다.
  // 여럿이면 어느 걸 멈추라는 건지 모호하므로 가만히 둔다(패널을 포커스해 취소).
  const escCancelSole = useEvent((): boolean => {
    const running = sessions
      .map((s, i) => (s.busy || s.state.workflows.some((w) => w.status === 'running') ? i : -1))
      // 팝아웃 패널은 제외 — 다른 창에서 보고 있는 실행을 그리드의 눈먼 Esc가 끊으면 사고
      .filter((i) => i >= 0 && !popped[i])
    return running.length === 1 ? escCancelPanel(running[0]) : false
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 앱 전역 오버레이(폴더 확인 / 프롬프트 모달 / 파일 뷰어 / 폴더 팝오버)가 열려
      // 있으면 항상 양보한다
      if (document.querySelector('.set-dialog-overlay, .pr-overlay, .fv-overlay, .hpop')) return
      // 승인/질문 카드는 패널 안에 뜬다(스코프 오버레이). 키보드를 받는 건 포커스된
      // 패널의 카드뿐이니 그때만 양보하고, 다른 패널의 카드는 남은 키(Esc·F2·Enter)를
      // 막지 않는다 — 패널을 클릭해 포커스하면 카드가 키를 넘겨받는다. 패널 밖 .q-overlay
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
      // (팝아웃 유령은 제외 — 편집 UI가 저쪽 창에 있어 여기선 보이지 않는 상태만 남는다)
      if (e.key === 'F2' && focusedSlot != null && !isPopped(focusedSlot)) {
        e.preventDefault()
        setRenamingSlot(focusedSlot)
        return
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        // 포커스가 팝아웃 유령이면 컴포저도 저쪽 창에 있다 — 클릭과 같은 의미로 그 창으로
        if (focusedSlot != null && isPopped(focusedSlot)) {
          e.preventDefault()
          window.api.multi?.panelFocus?.(chan(sessionId, focusedSlot)).catch(() => {})
          return
        }
        const ta = document.querySelector('.ma-panel.focused .composer textarea') as HTMLTextAreaElement | null
        if (ta) {
          e.preventDefault()
          ta.focus()
        }
        return
      }
      // (숫자 키 1‥N 패널 점프는 쓰는 사람이 없어 폐쇄 — 패널 선택은 클릭, 번호 칩은
      // 자리 표시로만 남는다)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusedSlot, count, expandedSlot])

  // ── 패널 위치 변경 — 헤더 빈 곳을 길게 누르면(0.35s) 집어 들고, 끌어서 놓는다 ──
  // 그리드 위임 한 곳에서 처리해 memo 패널(PanelView)엔 손대지 않는다. 드래그 중엔
  // 포인터가 올라탄 패널의 자리로 곧장 끼워 넣어(라이브 미리보기) 놓는 순간이 곧 확정.
  // 집힌 패널 강조는 같은 엘리먼트가 순서 이동에도 유지되는 점(React key=slot)을 믿고
  // classList로 직접 건다 — 상태로 돌리면 전 패널이 리렌더된다.
  const [reordering, setReordering] = useState(false) // 그리드 커서·선택 억제 CSS 훅
  const dragRef = useRef<{
    slot: number
    el: HTMLElement
    pointerId: number
    timer: ReturnType<typeof setTimeout> | null
    sx: number
    sy: number
    active: boolean
  } | null>(null)
  const endPanelDrag = useEvent(() => {
    const d = dragRef.current
    if (!d) return
    if (d.timer) clearTimeout(d.timer)
    if (d.active) {
      d.el.classList.remove('drag-lift')
      try {
        d.el.releasePointerCapture(d.pointerId)
      } catch {
        /* 이미 풀렸음(pointercancel 등) */
      }
      setReordering(false)
    }
    dragRef.current = null
    window.removeEventListener('pointermove', onPanelDragMove)
    window.removeEventListener('pointerup', endPanelDrag)
    window.removeEventListener('pointercancel', endPanelDrag)
    window.removeEventListener('blur', endPanelDrag)
  })
  const onPanelDragMove = useEvent((e: PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    // 길게 누르기 판정 전의 이동은 드래그 의도가 아니다 — 흔들림 허용치를 넘으면 무장 해제
    if (!d.active) {
      if (Math.abs(e.clientX - d.sx) > 6 || Math.abs(e.clientY - d.sy) > 6) endPanelDrag()
      return
    }
    // 포인터 밑의 패널 자리로 삽입 — 이동하면 집힌 패널이 그 자리로 따라와 자연히 안정된다
    const over = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest?.(
      '.ma-grid .ma-panel'
    ) as HTMLElement | null
    // 삽입 위치는 **그리드 안의 칸 번호**(포인터 밑 패널의 DOM 위치)다. 밑에 깔린 패널의
    // 슬롯으로 `prev.indexOf(target)`을 잡으면, 리렌더 전에 pointermove가 한 번 더 오는 경우
    // (패널 여럿이 스트리밍 중일 때) 같은 칸이 "이미 옮긴 뒤의 상태"에서는 반대 방향 이동으로
    // 읽혀 왕복 반전된다 — 놓인 순서가 이벤트 홀짝에 좌우됐다. 칸 번호면 같은 칸은 from === to.
    if (!over || Number(over.dataset.slot) === d.slot) return
    const to = over.parentElement ? Array.prototype.indexOf.call(over.parentElement.children, over) : -1
    if (to < 0) return
    setPromo(null) // 드래그로 정한 순서가 새 진실 — 다이얼 오버레이는 걷는다(★3.0.8)
    setPanelOrder((prev) => {
      const from = prev.indexOf(d.slot)
      if (from < 0 || to >= prev.length || from === to) return prev
      const next = [...prev]
      next.splice(from, 1)
      next.splice(to, 0, d.slot)
      return next
    })
  })
  const onGridPointerDown = useEvent((e: React.PointerEvent) => {
    // n1(IDE 크롬)은 보이는 자리가 하나라 재배치할 것이 없다 — 헤더는 창 드래그 띠다
    if (e.button !== 0 || count === 1 || expandedSlot != null || dragRef.current) return
    const t = e.target as HTMLElement
    // 핸들 = 헤더의 빈 곳·제목·상태 칩 — 상호작용 요소(번호 칩·연필·자물쇠·폴더 칩·
    // 제목 입력·확대 버튼)는 제 역할대로 두고 드래그를 안 건다
    if (!t.closest('.ma-p-head') || t.closest('button, input, .hfold, .ma-p-peek')) return
    const panel = t.closest('.ma-panel') as HTMLElement | null
    if (!panel || panel.classList.contains('ma-ghost')) return
    const slot = Number(panel.dataset.slot)
    if (!Number.isInteger(slot)) return
    const d = {
      slot,
      el: panel,
      pointerId: e.pointerId,
      timer: null as ReturnType<typeof setTimeout> | null,
      sx: e.clientX,
      sy: e.clientY,
      active: false
    }
    d.timer = setTimeout(() => {
      d.timer = null
      d.active = true
      window.getSelection()?.removeAllRanges() // 누르는 사이 생긴 제목 텍스트 선택 정리
      try {
        d.el.setPointerCapture(d.pointerId) // 창 밖 release도 pointerup으로 돌아오게
      } catch {
        /* 포인터가 이미 사라짐(원버튼 탭 등) — 캡처 없이도 window 리스너가 처리 */
      }
      d.el.classList.add('drag-lift')
      setReordering(true)
    }, 350)
    dragRef.current = d
    window.addEventListener('pointermove', onPanelDragMove)
    window.addEventListener('pointerup', endPanelDrag)
    window.addEventListener('pointercancel', endPanelDrag)
    window.addEventListener('blur', endPanelDrag)
  })
  // 세션 전환 등으로 드래그 중 언마운트되면 리스너·타이머를 걷는다
  useEffect(() => () => endPanelDrag(), [endPanelDrag])

  // ── 패널 팝아웃 창 — 이 세션의 슬롯이 별도 OS 창으로 나가 있는 동안 그리드엔 유령 ──
  // 창은 메인 창의 화면 전환·세션 전환과 무관하게 산다(엔진은 어차피 메인 프로세스의
  // 패널 풀). 마운트 때 현황(panelStates)을 조회해 유령을 복원하고, 이 화면이 내려가
  // 있는 사이 닫힌 창의 복귀분(leftover)도 그때 받아 되메운다.
  const [popped, setPopped] = useState<Record<number, boolean>>({})
  const slotOfPanelId = (panelId: string): number | null => {
    const prefix = sessionId + '::'
    if (!panelId.startsWith(prefix)) return null
    const s = Number(panelId.slice(prefix.length))
    return Number.isInteger(s) && s >= 0 && s < SLOT_COUNT ? s : null
  }
  // ★ chat:verdict 착지 — **화면에 보이는 자리**의 거부는 본채팅처럼 그 패널 스레드의
  // 카드로 말한다. App의 오른쪽 아래 토스트는 자리 밖 대화 전용이다 — 보이는 패널에서
  // 한 행동의 사유가 화면 반대편 구석에 뜨는 게 이상하다는 보고(2026-09-01)가 계기.
  // 셸이 문장을 직접 낸 판정(shellAuthored)은 이미 이 패널의 이벤트 스트림에 실려
  // 온다 — 여기서 또 쓰면 두 벌이 된다(App 쪽 R5 접점과 같은 규칙).
  const verdictCtx = useRef({ visibleSlots, popped, sessions })
  verdictCtx.current = { visibleSlots, popped, sessions }
  useEffect(() => {
    // 와이어의 1번 키는 chatId지만 렌더러의 자리 화면엔 chatId 배선이 없다 — 셸이 같이
    // 실어 주는 자리 별칭(panelId, hub `panel_alias`)으로만 판별한다.
    return onChatVerdict((_chatId, v, panelId) => {
      const slot = panelId != null ? slotOfPanelId(panelId) : null
      if (slot == null) return
      const cur = verdictCtx.current
      if (!cur.visibleSlots.includes(slot) || cur.popped[slot]) return // 자리 밖(접힘·팝아웃)은 App 토스트 소관
      const note = verdictNote(v)
      if (!note || shellAuthored(v)) return
      cur.sessions[slot].noteVerdict(verdictLine(note), note.blocked)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // 복귀분 적용 — 팝아웃 창의 마지막 상태(초안·메타·카드 정리·스냅샷)를 이 슬롯에 되메운다
  const applyPanelFlush = useEvent((f: PanelPopState) => {
    const slot = slotOfPanelId(f.panelId)
    if (slot == null) return
    patchMeta(slot, {
      title: typeof f.title === 'string' ? f.title : '',
      custom: !!f.custom,
      locked: !!f.locked,
      color: sanitizeTag(f.color),
      cwd: typeof f.cwd === 'string' ? f.cwd : '',
      refDirs: sanitizeRefDirs(f.refDirs),
      picker: sanitizePanelPicker(f.picker as Partial<PickerState> | null),
      api: !!f.api,
      input: typeof f.input === 'string' ? f.input : '',
      images: Array.isArray(f.images) ? f.images.filter((x): x is string => typeof x === 'string') : [],
      queue: Array.isArray(f.queue) ? (f.queue as ScheduledMsg[]).filter((q) => q && typeof q.text === 'string') : []
    })
    // ★M8-R2 — **복귀분이 라이브를 덮지 못하게 한다**(크리틱 M8 §3.1: 4/4 재현, 디스크 확인).
    //
    // 그리드는 팝아웃이 떠 있는 동안에도 같은 panelId의 `ma:event`를 계속 리듀스한다
    // (위 1034-1040 구독 + `hub.rs`의 `app.emit`은 전 창 브로드캐스트). 반면 창의
    // 페르시스트는 600ms 디바운스다(PanelWindow.tsx:140). 즉 **복귀분의 스레드는 항상
    // 그리드와 같거나 더 낡았다.** 그걸 `load`로 전체 교체하면, 디바운스가 못 내려간
    // 마지막 답변이 화면과 chats-v3에서 함께 사라진다:
    //   · 턴 종료 직후 닫기 → 다 읽은 마지막 답변이 **영구 손실**(뒤에 올 이벤트가 없다)
    //   · 스트리밍 중 닫기 → 되감긴 뒤 라이브가 이어 붙어 **스레드 한가운데가 뚫린다**
    // 창이 나르는 진짜 값은 초안·큐·메타다(위 patchMeta). 스레드는 라이브가 이긴다.
    //
    // ★ 잔여 (r19-confirm §6-4) — 그 판정을 **길이**로 하면 "짧아지는 편집"을 영구히 버린다.
    // 되돌리기·메시지 삭제처럼 스레드가 **줄어드는** 조작을 창에서 하면 복귀분이 통째로
    // 무시된다(`incoming >= live`가 거짓). 크리틱은 "지금은 패널에 revert 알약이 안 그려져
    // 도달 경로가 없다"고 낮게 봤지만, 그 전제는 알약 하나 배선되는 순간 사라진다.
    // 길이가 아니라 **세대**(`seq` — 리듀서가 모든 변화마다 +1 하는 단조 카운터)를 본다:
    //   · 라이브가 앞선다(디바운스 600ms 동안 그리드가 더 먹었다) → seq가 크다 → 거절 ✔
    //     (M8-R2가 막은 그 사고 — 마지막 답변이 화면·디스크에서 사라지던 것)
    //   · 창에서만 일어난 변화(전송·중단·되돌리기)  → seq가 크다 → 채택 ✔ (길이와 무관)
    //   · 스레드가 상한(capThread)에 닿아 **둘 다 길이가 안 늘 때**도 세대는 갈린다 ✔
    // 세대를 모르는 옛 복귀분(숫자 seq 없음)만 예전 길이 규칙으로 떨어뜨린다.
    if (!f.snapshot) return
    const snap = f.snapshot as SessionState
    const accept =
      typeof snap.seq === 'number'
        ? snap.seq >= sessions[slot].state.seq
        : (snap.messages ?? []).length >= sessions[slot].state.messages.length
    if (accept) sessions[slot].load(sanitizeSnapshot(snap))
  })
  const onPanelWindowClosed = useEvent((p: PanelPopClosed) => {
    const slot = slotOfPanelId(p.panelId)
    if (slot == null) return
    setPopped((prev) => {
      if (!prev[slot]) return prev
      const next = { ...prev }
      delete next[slot]
      return next
    })
    if (p.flush) {
      applyPanelFlush(p.flush)
      // 라이브로 회수했다 — 다음 마운트가 같은 복귀분을 또 적용하지 않게 잔여 사본 폐기
      window.api.multi?.panelClearLeftover?.(p.panelId).catch(() => {})
    }
  })
  useEffect(() => {
    const off = window.api.multi?.onPanelClosed?.(onPanelWindowClosed)
    window.api.multi
      ?.panelStates?.(sessionId)
      .then((r) => {
        if (!r) return
        const slots: Record<number, boolean> = {}
        for (const pid of r.open) {
          const s = slotOfPanelId(pid)
          if (s != null) slots[s] = true
        }
        if (Object.keys(slots).length) setPopped((prev) => ({ ...prev, ...slots }))
        for (const f of r.leftovers) applyPanelFlush(f)
      })
      .catch(() => {})
    return off
    // 구독·현황 조회는 마운트 1회 — 핸들러는 useEvent(최신 클로저)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // 팝아웃 — 이 패널을 별도 OS 창으로. 초안·예약 큐 소유권은 창으로 넘어가고(양쪽 드레인
  // 중복 방지), 한도 대기표 상태 머신도 창 쪽이 이어받는다(lrOptsFor의 enabled 게이트와 짝).
  const onPopout = useEvent((slot: number) => {
    const panelId = chan(sessionId, slot)
    if (popped[slot]) {
      window.api.multi?.panelFocus?.(panelId).catch(() => {})
      return
    }
    const m = metas[slot]
    const state: PanelPopState = {
      panelId,
      slot,
      num: visibleSlots.indexOf(slot) + 1,
      title: m.title,
      custom: m.custom,
      locked: m.locked,
      color: m.color,
      cwd: m.cwd,
      refDirs: m.refDirs,
      picker: m.picker,
      api: m.api,
      input: m.input,
      images: m.images,
      queue: m.queue,
      snapshot: snapshotForPersist(sessions[slot].state)
    }
    window.api.multi
      ?.openPanelWindow?.(state)
      .then(() => {
        setPopped((prev) => ({ ...prev, [slot]: true }))
        patchMeta(slot, { input: '', images: [], queue: [] })
        if (expandedSlot === slot) setExpandedSlot(null)
        lrs[slot].setHold(null)
      })
      .catch(() => {})
  })

  // ── /btw 질문 창 — 패널에서도 곁다리 질문 (원본 키 = panelId, 알약은 그 패널 안 도크) ──
  // 목록은 메인의 추가 채팅 레지스트리 브로드캐스트 그대로 — btwOf(=panelId)로 슬롯을
  // 되찾아 패널별로 가른다. 슬롯별 배열은 useMemo + 모듈 상수 EMPTY_BTW로 참조를 고정해
  // 브로드캐스트가 없는 렌더에선 memo PanelView가 리렌더되지 않는다.
  const [sessionWins, setSessionWins] = useState<SessionWindowInfo[]>([])
  useEffect(() => {
    window.api.sessionWindows.list().then(setSessionWins).catch(() => {})
    return window.api.sessionWindows.onChanged(setSessionWins)
  }, [])
  const btwWinsBySlot = useMemo(() => {
    const map = new Map<number, SessionWindowInfo[]>()
    for (const w of sessionWins) {
      if (!w.btwOf) continue
      const slot = slotOfPanelId(w.btwOf)
      if (slot == null) continue
      const arr = map.get(slot)
      if (arr) arr.push(w)
      else map.set(slot, [w])
    }
    return map
    // slotOfPanelId는 sessionId 클로저 — 세션이 바뀌면 매핑도 다시
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionWins, sessionId])
  // /btw 판정+요청 — sendPanel(일반 전송)과 schedulePanel(busy 중 전송)이 같은 경로를 쓴다.
  // 본채팅 tryBtw의 패널판: 포크 소스는 이 패널의 세션, 상속물은 이 패널의 폴더·picker.
  const tryBtwPanel = (slot: number, text: string, pk: PickerState): boolean => {
    const p = parseBtw(text)
    if (!p) return false
    const sess = sessions[slot]
    const m = metas[slot]
    const dir = m.cwd || sess.state.session?.cwd || ''
    const seed = btwForkOf(sess.state.session, dir, pk.engine === 'codex' ? 'codex' : 'claude')
    const num = visibleSlots.indexOf(slot) + 1
    window.api
      .btwOpen({
        origin: chan(sessionId, slot),
        // btw 채팅 이름 = 'BTW - <이 패널 제목>' (제목 전이면 자리 번호로)
        originTitle: m.title || t(`패널 ${num}`, `Panel ${num}`),
        cwd: dir,
        refDirs: m.refDirs,
        picker: pk,
        fork: seed?.fork ?? null,
        forkCwd: seed?.cwd ?? null,
        prompt: p.prompt || null
      })
      .catch(() => {})
    return true
  }

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
  // 제목 잠금 토글 — 잠긴 동안엔 클리어·폴더 변경·자동 유도가 제목을 못 건드린다
  // (직접 이름 바꾸기는 잠긴 채로도 가능 — 잠금은 '자동으로 안 바뀜'이지 '수정 불가'가 아니다)
  const onToggleLock = useEvent((slot: number) => setMetas((prev) => prev.map((m, i) => (i === slot ? { ...m, locked: !m.locked } : m))))
  const onCycleColor = useEvent((slot: number) =>
    setMetas((prev) => prev.map((m, i) => (i === slot ? { ...m, color: nextTag(m.color || defaultTag(slot)) } : m)))
  )
  // 크게 보기 토글 — 열릴 때 카드 컴포저로 바로 커서
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
  // 끈적한 창 모드면 그 패널의 cwd·diffs로 독립 뷰어 창에(본채팅과 같은 규칙). 되돌아오는
  // 「창 안으로」는 이 창의 루트(App)가 페이로드째 받는다 — 패널 자리와 무관하게 한 자리.
  const openPanelFile = (slot: number, rel: string, line?: number): void => {
    if (viewerWindowMode()) {
      const cwd = metas[slot].cwd || sessions[slot].state.session?.cwd || ''
      void openInViewerWindow({ path: rel, line, cwd, diffs: sessions[slot].state.diffs, backToParent: !!openSub }).then((took) => {
        if (!took) setOpenFile({ slot, path: rel, line })
      })
      return
    }
    setOpenFile({ slot, path: rel, line })
  }
  const onOpenPanelFile = useEvent((slot: number, rel: string, line?: number) => openPanelFile(slot, rel, line))
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
  // ★ 3.0 M-UX — 판정이 슬롯 번호(`min(slot, count-1)`)가 아니라 **보이는 자리 집합**이다.
  // 접힌 자리를 따라가면 왼쪽 칼럼이 화면에 없는 패널의 폴더를 그린다(고아 UI).
  const visSlot = (s: number): number => (visibleSlots.includes(s) ? s : (visibleSlots[0] ?? 0))
  const eSlot = visSlot(expSlot)
  // 파일 열기는 그 패널의 cwd·diffs 뷰어(openFile), 폴더 선택은 그 패널의 선택 흐름으로
  const expOpenFile = useEvent((path: string) => openPanelFile(visSlot(expSlot), path))
  const expPickFolder = useEvent(() => onPickFolder(visSlot(expSlot)))
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
      // 잠긴 제목은 클리어에도 남긴다 — 패널을 역할 이름으로 두고 대화만 비우는 흐름
      patchMeta(slot, { ...(m.locked ? {} : { title: '', custom: false }), ...(opts ? {} : { input: '', images: [] }) })
      // 한도 대기표도 함께 — 백지가 된 패널 위에 옛 프롬프트가 자동 재전송되면 사고 (본채팅과 동일)
      lrs[slot].setHold(null)
      return
    }
    // /btw — 클라이언트 명령: 이 패널의 컨텍스트를 포크한 별도 질문 창 (패널 대화엔 흔적 없음)
    if (tryBtwPanel(slot, text, pk)) {
      if (!opts) patchMeta(slot, { input: '' })
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
              // 잠긴 제목은 폴더 전환에도 동결 — 단, 빈 제목 잠금은 첫 프롬프트 유도까지는 허용
              title: pm.locked && pm.title ? pm.title : pm.custom && !folderSwitched ? pm.title : title,
              custom: pm.locked ? pm.custom : folderSwitched ? false : pm.custom
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
      codexTier: pk.codexTier,
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
      codexAccount: pk.codexAccount,
      // ★3.0.4 — 이 패널을 그리는 다른 창(팝아웃)이 받을 사용자 말풍선 원문(명령은 카드라 제외)
      echoText: cmd ? undefined : text,
      echoImages: imgs.length ? imgs : undefined
    }
    window.api.multi?.run(req).catch(() => {})
  })

  // queue the panel's draft (while it's busy) to auto-send when its run ends
  const schedulePanel = useEvent((slot: number) => {
    const m = metas[slot]
    if (!sessions[slot].busy || (!m.input.trim() && m.images.length === 0)) return
    // /btw는 예약하지 않고 즉시 연다 — 작업 도는 동안의 곁다리 질문이 이 명령의 존재 이유 (본채팅과 동일)
    if (tryBtwPanel(slot, m.input.trim(), m.picker)) {
      patchMeta(slot, { input: '' })
      return
    }
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

  // ── 한도 자동 이어서 — 슬롯마다 독립 대기표 (본채팅과 같은 useLimitResume 공용 훅).
  // 소유 키는 슬롯 고정 — 멀티 세션 전환·패널 수 변경은 ActiveSession 재마운트(key)라
  // 대기표가 함께 내려간다(런타임 전용: 이 세션 화면을 떠나면 자동 재개 약속도 접힌다).
  // 아래 큐 드레인 effect보다 먼저 선언돼야 한다 — 장전(ref 동기 갱신)이 같은 커밋의
  // 드레인 가드에 보이는 순서 보장.
  const lrOptsFor = (slot: number, sess: { state: SessionState; busy: boolean }): LimitResumeSurface => {
    const m = metas[slot]
    const engine = m.picker.engine === 'codex' ? ('codex' as const) : ('claude' as const)
    return {
      state: sess.state,
      busy: sess.busy,
      // 팝아웃 중엔 창 쪽 useLimitResume이 대기표를 굴린다 — 여기 미러까지 켜 두면
      // 같은 한도 에러에 양쪽이 재개 턴을 이중 전송한다
      enabled: autoResume && !popped[slot],
      apiMode: m.api,
      engine,
      account: engine === 'codex' ? m.picker.codexAccount : m.picker.account,
      fable: engine === 'claude' && m.picker.model === 'fable',
      holdKey: String(slot),
      // 재개 전송 — 예약 재생과 같은 opts 경로라 그 패널의 초안을 지우지 않는다
      send: (p) => void sendPanel(slot, { text: p, images: [], picker: metas[slot].picker })
    }
  }
  const lr0 = useLimitResume(lrOptsFor(0, s0))
  const lr1 = useLimitResume(lrOptsFor(1, s1))
  const lr2 = useLimitResume(lrOptsFor(2, s2))
  const lr3 = useLimitResume(lrOptsFor(3, s3))
  const lr4 = useLimitResume(lrOptsFor(4, s4))
  const lr5 = useLimitResume(lrOptsFor(5, s5))
  const lrs = [lr0, lr1, lr2, lr3, lr4, lr5]
  const onCancelHold = useEvent((slot: number) => lrs[slot].setHold(null))
  // ★R28c RCAP — 「이어가기」. 자동 재발사를 접은 표(`autoPaused`)의 유일한 출구다.
  const onResumeHold = useEvent((slot: number) => lrs[slot].resumeNow())

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
      // 한도 대기표가 걸린 패널은 드레인 보류 — 지금 보내봐야 같은 한도에 막혀 에러만
      // 쌓인다. 자동/수동 재개 턴이 끝난 다음 idle 전환이 이어받는다 (본채팅과 동일).
      if (busySig[slot] === '1' || was[slot] !== '1' || drainingRef.current.has(slot) || lrs[slot].holdRef.current) return
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
    // 잠긴 제목 유지 — 컴포저 /clear 분기와 같은 규칙
    patchMeta(slot, { ...(metas[slot].locked ? {} : { title: '', custom: false }), input: '', images: [] })
    lrs[slot].setHold(null) // 한도 대기표도 함께 — sendPanel의 /clear 분기와 같은 이유
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
    sess.answerPermission(behavior)
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
    // 잠긴 제목은 폴더가 바뀌어도 유지 — 잠금은 '이 패널의 역할 이름'이지 프로젝트 소속이 아니다
    patchMeta(p.slot, { cwd: p.cwd, ...(metas[p.slot].locked ? {} : { title: '', custom: false }) })
    sessions[p.slot].load(initialSessionState)
    lrs[p.slot].setHold(null) // 폴더 변경 = 새 대화 — 옛 대화의 한도 대기표는 무효
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
        // ★ R3 — 읽던 자리 앵커의 키. 「크게 보기」는 같은 대화가 다른 껍데기로 옮겨
        // 가는 것이라 키를 갈라 둔다(그리드 자리의 앵커를 카드가 소비하면 안 된다).
        anchorKey={chan(sessionId, slot) + (expanded ? '::exp' : '')}
        // ★M9 — 구독 주소는 껍데기와 무관하게 하나다(앵커에 붙는 `::exp`는 빼고 준다).
        panelId={chan(sessionId, slot)}
        num={visibleSlots.indexOf(slot) + 1}
        // ★ n1(IDE 크롬)에서는 이 패널의 헤더가 곧 TopBar다 — 다이얼·접힘 배지·탐색기
        // 토글·창 컨트롤이 여기 얹힌다(줄을 하나 더 쌓지 않는다, §2.1)
        topbar={soloReal && slot === soloSlot && !expanded ? topBar : undefined}
        userName={profileName}
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
        limitHold={lrs[slot].hold}
        autoResume={autoResume}
        onCancelHold={onCancelHold}
        onResumeHold={onResumeHold}
        onAutoResume={onAutoResumeChange}
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
        onPopout={onPopout}
        onPermission={onPermission}
        onAnswer={onAnswer}
        onDismissQuestion={onDismissQuestion}
        renaming={renamingSlot === slot}
        onStartRename={onStartRename}
        onRename={onRenamePanel}
        onToggleLock={onToggleLock}
        onCycleColor={onCycleColor}
        btwWins={btwWinsBySlot.get(slot) ?? EMPTY_BTW}
      />
    )
  }

  // ── ★ 3.0 M-UX — 사이드바 「채팅」에 이 보드의 자리들을 싣기 위한 보고 ──────────
  //
  // 통합 사이드바는 일반 채팅·보드 자리·창을 **한 목록**으로 그린다(§8-①(a)). 보드
  // 자리의 제목·상태·자리 번호는 여기(ActiveSession)에만 있으므로 App으로 올려 보낸다.
  // 시그니처가 바뀔 때만 보고한다 — 스트리밍 토큰마다 App을 다시 그리면 안 된다
  // (메시지 수는 시그니처에 없다: 상태·제목·자리만 사이드바에 보인다).
  const panelInfos: PanelSummary[] = SLOTS.map((slot) => {
    const pos = visibleSlots.indexOf(slot)
    const fold = foldedSlots.indexOf(slot)
    return {
      slot,
      panelId: chan(sessionId, slot),
      title: metas[slot].title,
      status: effectiveStatus(sessions[slot].state),
      pos: pos >= 0 ? pos + 1 : null,
      fold: fold >= 0 ? count + fold + 1 : null,
      color: metas[slot].color || defaultTag(slot),
      popped: !!popped[slot],
      ask: !!(sessions[slot].state.pendingPermission || sessions[slot].state.pendingQuestion),
      empty: !metas[slot].title && sessions[slot].state.messages.length === 0
    }
  })
  const panelInfoSig = JSON.stringify(panelInfos)
  useEffect(() => {
    onPanelInfo?.(JSON.parse(panelInfoSig) as PanelSummary[])
    // 시그니처 문자열이 유일한 트리거 — 콜백은 App의 setState(stable)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelInfoSig])

  // 다이얼을 **다른 화면에서** 돌린 경우(일반 채팅 크롬의 다이얼로 2‥6을 고름) — App이
  // seq를 올려 보내면 여기서 같은 applyCount를 탄다. 값이 아니라 seq로 판정해야
  // "같은 수를 다시 고름"도 전달된다.
  const seedSeqRef = useRef(countSeed?.seq ?? 0)
  useEffect(() => {
    if (!countSeed || countSeed.seq === seedSeqRef.current) return
    seedSeqRef.current = countSeed.seq
    applyCount(countSeed.n)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countSeed])
  // 사이드바에서 접힌 대화를 눌렀다 — 같은 raiseSlot 관문을 탄다(자리 수는 안 바뀐다)
  const raiseSeqRef = useRef(raiseSeed?.seq ?? 0)
  useEffect(() => {
    if (!raiseSeed || raiseSeed.seq === raiseSeqRef.current) return
    raiseSeqRef.current = raiseSeed.seq
    raiseSlot(raiseSeed.slot)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raiseSeed])

  // n1에서 TopBar를 이어받을 **진짜 패널**이 있는가. 그 한 자리가 팝아웃(유령 셀)이거나
  // 「크게 보기」로 오버레이에 가 있으면 헤더를 얹을 몸통이 없다 → .ma-head 줄을 되살린다.
  // (안 그러면 창 컨트롤·다이얼이 통째로 사라져 창을 닫을 수도 없다.)
  const soloSlot = count === 1 ? visibleSlots[0] : undefined
  const soloReal = soloSlot != null && !popped[soloSlot] && soloSlot !== expandedSlot

  // ── ★ 3.0 M-UX — TopBar 조각. n1(IDE 크롬)에서는 그 자리 패널의 헤더 오른쪽에,
  //    2‥6에서는 .ma-head에 얹힌다. **같은 조각**이라 1↔2 전환에서 다이얼이 안 움직인다(§2.1).
  const topBar = (
    <>
      {/* 접힌 자리에서 도는 실행 — 안 보이는 곳에서 N개가 돌고 있다는 사실을 숨기지 않는다 */}
      {foldedRunning > 0 && (
        <span
          className="ma-runsum has-tip"
          data-tip={t('접힌 자리에서 도는 실행 — 접혀도 엔진은 계속 돌아요', 'Runs in folded slots — folding never stops an engine')}
        >
          <i className="ma-runsum-spin" />
          {t(`접힌 자리 실행 ${foldedRunning}`, `${foldedRunning} running while folded`)}
        </span>
      )}
      <PanelDial count={count} onPick={applyCount} />
      <FoldBadge rows={foldRows} onRaise={raiseSlot} />
      {/* ★ R2 — 찾기. 스펙 §3.1/§2.1의 TopBar 목록과 목업 `chat-unify-collapse`에 다
          있는데 R1 실물에만 없었다(크리틱 §2-⑦). Ctrl+F는 되므로 기능 손실이 아니라
          **어포던스 손실**이고, "두 갈래지만 사용자 눈에는 같은 화면"이라는 주장이
          이것 하나로 거짓이 된다. 본채팅 헤더와 같은 창 이벤트를 쓴다 — 받는 쪽은
          포커스된 패널의 ChatFind 하나뿐이다(active 게이트). */}
      <PanelFindButton />
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
    </>
  )

  return (
    <>
      {/* .expanded 플래그 — 크게 보기 중 뒤 그리드 패널의 질문 카드(z80)를 베일 밑으로 내리는 CSS 훅 */}
      <section className={'multi' + (expandedSlot != null ? ' expanded' : '') + (count === 1 ? ' ide' : '')}>
        {/* 헤더 = 드래그 바: 아이콘/타이틀·일괄 폴더·한도 필은 2.0에서 삭제 — 남는 건
            오른쪽의 패널 수 탭과 창 컨트롤뿐(왼쪽 배치는 시도 후 롤백). 한도·비용은
            각 패널 WorkBar 컨텍스트 팝오버가 말한다.
            ★ n1(IDE 크롬)에서는 이 줄이 없다 — 그 자리 패널의 헤더가 곧 TopBar다.
            줄을 하나 더 쌓으면 "기존 일반 채팅 그대로"가 깨진다(목업 chat-unify-1-ide). */}
        {!soloReal && (
          <div className="ma-head">
            <span className="ma-spacer" />
            {topBar}
          </div>
        )}

        {/* 배치는 .nN 클래스가 결정 — PoC: 2·3=한 줄, 4=2×2, 5=3+2(스팬), 6=3×2.
            n1은 그리드가 아니라 전폭 한 칸(미니어처 배율도 풀린다 — styles.css .ma-grid.n1).
            순서는 panelOrder(헤더 길게 누르기 드래그) — 슬롯 정체성은 패널을 따라간다 */}
        <div className={'ma-grid scroll n' + count + (reordering ? ' reordering' : '')} ref={multiZoom.ref} onPointerDown={onGridPointerDown}>
          {visibleSlots.map((slot, i) =>
            slot === expandedSlot ? (
              // 크게 보는 패널의 그리드 자리 지킴이 — 실물 PanelView는 오버레이 카드에 가 있다
              // (.ma-panel 클래스 유지: n5 스팬 등 그리드 배치 규칙이 그대로 먹게)
              <div key={slot} className="ma-panel ma-ghost" data-slot={slot}>
                <span className="ma-p-num on">{i + 1}</span>
                <span className="ma-ghost-text">{t('크게 보는 중', 'Expanded')}</span>
              </div>
            ) : popped[slot] ? (
              // 팝아웃 유령 — 실물은 별도 OS 창에. 클릭하면 그 창을 앞으로.
              // mousedown은 실물 패널과 똑같이 그리드 포커스도 잡는다 — 왼쪽 파일
              // 탐색기가 "포커스한 패널의 폴더"를 따라가는 약속이 유령에도 통하게.
              <div
                key={slot}
                className={'ma-panel ma-ghost pop' + (focusedSlot === slot ? ' focused' : '')}
                data-slot={slot}
                role="button"
                onMouseDown={() => onFocusPanel(slot)}
                onClick={() => window.api.multi?.panelFocus?.(chan(sessionId, slot)).catch(() => {})}
              >
                <span className="ma-p-num on">{i + 1}</span>
                <span className="ma-ghost-text">{t('별도 창에서 보는 중 — 클릭해 창으로', 'In its own window — click to focus it')}</span>
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
          제자리. 파일 뷰어(z60)·서브에이전트 카드(z70)는 이 베일(z55) 위에 뜬다 */}
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
            line={openFile.line}
            backToParent={!!openSub}
            cwd={metas[openFile.slot].cwd || sessions[openFile.slot].state.session?.cwd || ''}
            diffs={sessions[openFile.slot].state.diffs}
            onClose={() => setOpenFile(null)}
            // 「별도 창으로」 — 끈적한 모드를 켜고 이 파일을 그 패널의 cwd·diffs로 독립 창에
            onPopout={(p) => {
              const slot = openFile.slot
              setViewerWindowMode(true)
              void openInViewerWindow({
                path: p,
                line: p === openFile.path ? openFile.line : undefined,
                backToParent: !!openSub,
                cwd: metas[slot].cwd || sessions[slot].state.session?.cwd || '',
                diffs: sessions[slot].state.diffs
              }).then((took) => {
                if (took) setOpenFile(null)
                else setViewerWindowMode(false)
              })
            }}
          />
        </Suspense>
      )}

      {/* ★ 3.0 M-UX §2.2-1b — 뷰어는 **닫지 않고** 대상만 옮겨 붙었다는 한 줄.
          2.6.2는 대상 패널이 접히면 뷰어를 통째로 닫았다(뷰어가 패널 안에 있었으니까).
          3.0의 뷰어는 앱 크롬이고 파일 읽기는 채팅과 무관하다 — 닫으면 오히려 회귀다. */}
      {openFile?.rebound && (
        <div className="ma-rebind" role="status">
          <span className="ic">↳</span>
          <span>
            {t(
              `대상 채팅이 접혀서 「${metas[openFile.slot].title || t('새 채팅', 'New chat')}」로 바꿨어요 — diff도 새 대상 기준이에요`,
              `The target chat was folded — switched to "${metas[openFile.slot].title || 'New chat'}" (diff follows the new target)`
            )}
          </span>
          <button
            className="x"
            aria-label={t('닫기', 'Dismiss')}
            onClick={() => setOpenFile((f) => (f ? { ...f, rebound: undefined } : f))}
          >
            ✕
          </button>
        </div>
      )}

      {/* WorkBar 서브에이전트 상세 카드 — 매 렌더 라이브 조회라 상태/도구 갱신이 흐른다 (본채팅과 동일) */}
      <SubAgentModal
        agent={openSub ? sessions[openSub.slot].state.subagents.find((a) => a.id === openSub.id) ?? null : null}
        cwd={openSub ? panelCwd(openSub.slot) : undefined}
        onClose={() => setOpenSub(null)}
        onOpenFile={openSub ? (path, line) => openPanelFile(openSub.slot, path, line) : undefined}
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
      panelOrder: payload.panelOrder,
      // null도 그대로 싣는다 — 저장 쪽(legacy_bridge)은 키가 없을 때만 지난 값을 쓰므로, 걷은 오버레이가 되살아나지 않는다
      promo: payload.promo,
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
            ? { ...d, count: s.count ?? d.count, panelOrder: s.panelOrder ?? d.panelOrder, panels: s.panels, unloaded: undefined, panelStatuses: undefined }
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

  // ── ★ 3.0 M-UX — 다이얼이 두 크롬에 산다 ───────────────────────────────────
  // 일반 채팅(IDE)에서 2‥6을 고르면 보드 크롬으로 넘어가야 하고, 그 순간 활성 보드의
  // 자리 수가 그 값이어야 한다. 마운트돼 있으면 seq로 밀어 넣고(ActiveSession의 effect),
  // 아직 마운트 전이면 레코드의 count가 곧 `initial.count`라 그대로 반영된다.
  const [countSeed, setCountSeed] = useState<{ n: number; seq: number } | undefined>(undefined)
  const setActiveCount = useEvent((n: number) => {
    const v = clampCount(n)
    const d = dataRef.current[activeId]
    if (d) {
      // ★3.0.8 — 순서 규칙(`lib/panelLayout.ts`)을 레코드에도 적용한다. 마운트 전(일반 채팅 크롬에서
      // 2‥6을 고름)에는 이 레코드가 곧 `initial`이라, 여기서 안 되돌리면 접힌 채 굳은 오버레이가 남는다.
      // 마운트돼 있으면 ActiveSession의 applyCount(포커스 기준)가 같은 규칙으로 다시 계산해 커밋으로 덮는다.
      const cur = sanitizePanelOrder(d.panelOrder)
      const r = resizeLayout({ order: cur, count: clampCount(d.count), promo: sanitizePromo(d.promo, SLOT_COUNT) }, v, cur[0])
      d.count = v
      d.panelOrder = r.order
      d.promo = r.promo
    }
    setCountSeed((c) => ({ n: v, seq: (c?.seq ?? 0) + 1 }))
  })
  // 사이드바에서 접힌 자리를 눌렀다 → 1번 자리로 올린다(§2.2-1b의 관문을 ActiveSession이 탄다)
  const [raiseSeed, setRaiseSeed] = useState<{ slot: number; seq: number } | undefined>(undefined)
  const raiseSlot = useEvent((slot: number) => {
    // ★ R2 — **레코드의 순서도 같이 올린다**(countSeed와 같은 규약). seq만 올리면 보드가
    // 아직 마운트 안 된 경우(일반 채팅 화면에서 접힌 대화를 고름)에 지고 만다:
    // `ActiveSession`이 그 직후 마운트되면서 `raiseSeqRef`를 **이미 오른 seq로** 초기화해
    // 승격이 통째로 삼켜지고, 1번 자리에는 엉뚱한 대화가 앉는다
    // (크리틱 M-UX R1 §2-④ `side.raise-from-single`). 레코드가 곧 `initial.panelOrder`다.
    const d = dataRef.current[activeId]
    if (d) {
      const cur = sanitizePanelOrder(d.panelOrder)
      d.panelOrder = [slot, ...cur.filter((s) => s !== slot)]
      d.promo = null // 손으로 올린 순서가 새 진실(★3.0.8)
    }
    setRaiseSeed((r) => ({ slot, seq: (r?.seq ?? 0) + 1 }))
  })
  /** 활성 보드가 지금 몇 자리인가 — 일반 채팅 크롬의 다이얼 하이라이트·라우팅 판정용 */
  const activeCount = useEvent((): number => clampCount(dataRef.current[activeId]?.count ?? 4))

  return {
    hydrated,
    activeId,
    summaries,
    activeEmpty,
    countSeed,
    setActiveCount,
    activeCount,
    raiseSeed,
    raiseSlot,
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
  autoResume = false,
  onAutoResumeChange,
  onExplorerInfo,
  onPanelInfo,
  explorerHidden,
  onToggleExplorer
}: {
  multi: MultiSessions
  usage: UsageInfo
  apiMode: boolean // 전역 과금 모드 — 새 패널의 기본값 시드로만 쓴다 (선택은 패널별)
  apiReady: boolean
  apiReadyCodex?: boolean // OpenAI 키 존재 여부 — Codex 패널의 과금 선택용
  onOpenApiSettings: () => void // 설정 → API 탭 열기 (키 미등록 가드)
  autoResume?: boolean // 한도 자동 이어서(전역 pref) — App이 소유, 패널 picker·대기표가 쓴다
  onAutoResumeChange?: (on: boolean) => void
  onExplorerInfo?: (info: MultiExplorerInfo) => void // 왼쪽 칼럼 탐색기가 따라갈 패널 보고
  onPanelInfo?: (list: PanelSummary[]) => void // ★ 통합 사이드바 「채팅」에 실을 자리 요약
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
      autoResume={autoResume}
      onAutoResumeChange={onAutoResumeChange ?? NOOP_AUTORESUME}
      onFirstPrompt={multi.onFirstPrompt}
      onStatus={multi.onStatus}
      onCommit={multi.onCommit}
      onExplorerInfo={onExplorerInfo}
      onPanelInfo={onPanelInfo}
      countSeed={multi.countSeed}
      raiseSeed={multi.raiseSeed}
      explorerHidden={explorerHidden}
      onToggleExplorer={onToggleExplorer}
    />
  )
}
