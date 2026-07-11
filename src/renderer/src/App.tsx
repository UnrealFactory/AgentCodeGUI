import { useEffect, useMemo, useRef, useState } from 'react'
import type { ApiConfigStatus, AppUser, FileDiff, RunRequest, SubAgentInfo, UsageInfo, UserProfile } from '@shared/protocol'
import { extractMentions } from './lib/mentions'
import { useMaximized } from './lib/useMaximized'
import { useAgentSession, initialSessionState, sanitizeSnapshot, snapshotForPersist, sameCwd, commandOf, commandTitleOf, type SessionState } from './store/session'
import { ErrorBoundary } from './components/ErrorBoundary'
import { TitleBar } from './components/TitleBar'
import { Sidebar, type WorkspaceMode } from './components/Sidebar'
import { MultiWorkspace } from './components/MultiAgent'
import { ChatWorkspace } from './components/ChatWorkspace'
import { getPref, setPref } from './lib/prefs'
import { ChatHeader, ChatFind, Composer, MessageView, QuestionModal, PermissionModal, SelectionToolbar, WelcomeState, WorkBar, WorkingIndicator, nextMode, pickerModelOf, type PickerState, type ScheduledMsg } from './components/Chat'
import { SubAgentModal } from './components/AgentPanel'
import { Explorer } from './components/Explorer'
import { AskModal } from './components/AskModal'
import { FolderSwitchDialog } from './components/FolderSwitchDialog'
import { FileModal } from './components/FileModal'
import { GitModal, type GitFileOpen } from './components/GitModal'
import { ChangedFilesModal } from './components/ChangedFilesModal'
import { ImageViewer } from './components/ImageViewer'
import { SettingsModal } from './components/Settings'
import { EngineGate } from './components/EngineGate'
import { AppUpdateGate } from './components/AppUpdateGate'
import { WhatsNew } from './components/WhatsNew'
import { UpdateNotes } from './components/UpdateNotes'
import { Profile } from './components/Profile'
import { PromptModal } from './components/PromptModal'
import { RecentFiles } from './components/RecentFiles'
import { ResizeHandles } from './components/ResizeHandles'
import { useZoom, ZoomBadge, mergeRefs } from './components/zoom'
import { MouseGestureLayer, sessionWindowGesture, type GestureAction } from './components/mouseGesture'
import { IconChevDown, IconCode } from './components/icons'

// px from the bottom within which the chat counts as "at the bottom" — scrolling
// back into this band (when not mid scroll-up) resumes auto-follow
const BOTTOM_EPSILON = 60
const JUMP_SHOW_PX = 240 // 바닥에서 이만큼 멀어지면 "맨 아래로" 점프 버튼을 띄운다

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
  picker: PickerState // 모델·effort·모드 — per chat, restored on switch
  draft?: string // 보내지 않은 컴포저 초안 — 채팅 전환/재시작에도 유지
  draftImages?: string[]
  sysPrompt?: string // 채팅별 프롬프트 — 매 실행마다 시스템 프롬프트에 append (없으면 미설정)
  recentFiles?: string[] // 이 채팅에서 연 파일 (rel 경로, 최신순) — 헤더 아래 탭으로 표시
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
    // 실행 계정(이메일) — 등록 목록과의 대조는 비동기라 여기선 형태만 확인. 목록에서
    // 사라진 계정은 picker가 경고 항목으로 보여주고, 실행 시 엔진이 에러로 알린다.
    account: typeof p?.account === 'string' && p.account ? p.account : undefined
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

function newChatMeta(manualCwd = '', picker: PickerState = DEFAULT_PICKER): ChatMeta {
  return {
    id: chatId(),
    title: '',
    custom: false,
    snapshot: initialSessionState,
    manualCwd,
    picker: { ...picker }
  }
}

// ── chat persistence (~/.agentcodegui/chats.json) ───────────────────────────
const CHATS_VERSION = 1
interface PersistedChats {
  version: number
  chats: ChatMeta[]
  activeChatId: string
}

function MainApp({ user }: { user: AppUser }) {
  const { state, elapsed, busy, begin, clearPermission, clearQuestion, load } = useAgentSession()
  const maximized = useMaximized()
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
  const [images, setImages] = useState<string[]>([])
  // messages drafted while the agent is busy — queued here and auto-sent in order once
  // the run ends (you can only enqueue while busy, and you can't switch chats while busy,
  // so this single list always belongs to the active chat)
  const [queue, setQueue] = useState<ScheduledMsg[]>([])
  // the image lightbox/multi-viewer: the set being viewed + the active index (null = closed)
  const [viewer, setViewer] = useState<{ images: string[]; index: number } | null>(null)
  const [usage, setUsage] = useState<UsageInfo>({ fiveHour: null, weekly: null, weeklyFable: null, extraCredit: null })
  // API 모드 — 켜면 실행이 구독(OAuth) 대신 저장된 API 키로 과금된다. 앱 단위 설정
  // (채팅별 picker와 달리 과금 수단이라 전역이 자연스럽다) — uiPrefs에 영속.
  const [apiMode, setApiMode] = useState<boolean>(() => getPref<boolean>('api.mode', false))
  // 설정 → API의 스냅샷(키 존재·예산·누적 사용액) — 토글 가드와 남은 예산 표시에 쓴다
  const [apiCfg, setApiCfg] = useState<ApiConfigStatus | null>(null)
  // 설정 모달을 특정 탭으로 열기 (키 없이 API 토글을 누르면 'api' 탭으로 바로)
  const [settingsView, setSettingsView] = useState<'version' | 'api' | undefined>(undefined)
  const [openFilePath, setOpenFilePath] = useState<string | null>(null)
  // Git 카드에서 연 파일의 일회성 컨텍스트(시점 내용·마킹 diff·해시 칩) — 일반
  // 경로 열기(openPath)는 항상 이걸 비워서 세션 diff 마킹으로 돌아온다
  const [fileOverride, setFileOverride] = useState<{ content: string | null; diff: FileDiff | null; label: string | null } | null>(null)
  // 탐색기 ⎇ 버튼 → Git 카드. 루트는 메인 프로세스가 상위 폴더까지 탐색(cwd별 캐시)
  const [gitOpen, setGitOpen] = useState(false)
  const [gitRoot, setGitRoot] = useState<string | null>(null)
  // 탐색기 우클릭 '변경된 파일 보기' 카드 — 스코프 폴더(rel '' = 프로젝트 전체)와 표시 이름
  const [chgScope, setChgScope] = useState<{ rel: string; label: string } | null>(null)
  // a working-folder change that would reset the current conversation, parked here
  // until the user confirms it in the card modal (변경) or backs out (취소)
  const [pendingFolder, setPendingFolder] = useState<string | null>(null)
  const [openSubagentId, setOpenSubagentId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 프롬프트 설정 모달이 열린 채팅 id (사이드바 우클릭 → 프롬프트 설정)
  const [promptChatId, setPromptChatId] = useState<string | null>(null)
  // "/ask" — a throwaway side conversation (its own engine + session). Mounted only
  // while open, so closing it discards everything (ephemeral). `askInitial` pre-fills
  // the composer when the user typed "/ask <question>".
  const [askOpen, setAskOpen] = useState(false)
  const [askMinimized, setAskMinimized] = useState(false)
  const [askInitial, setAskInitial] = useState('')
  // /ask 모달 열기 — 컴포저의 "/ask <질문>"(idle)과 예약 우회(busy 중 즉시 실행)가 공유.
  // 항상 앞으로 가져온다: 최소화돼 있었으면 펼친다.
  const openAsk = (initial: string): void => {
    setAskInitial(initial)
    setAskOpen(true)
    setAskMinimized(false)
  }
  // read in the global key handler (registered once) without going stale
  const askOpenRef = useRef(askOpen)
  askOpenRef.current = askOpen
  const askMinimizedRef = useRef(askMinimized)
  askMinimizedRef.current = askMinimized
  const [chats, setChats] = useState<ChatMeta[]>(() => [newChatMeta()])
  const [activeChatId, setActiveChatId] = useState<string>(() => chats[0].id)
  const [chatQuery, setChatQuery] = useState('')
  // 단일 / 멀티 에이전트 작업 모드 — persisted so the app reopens where you left off
  const [mode, setMode] = useState<WorkspaceMode>(() => getPref<WorkspaceMode>('workspace.mode', 'single'))
  const onModeChange = (m: WorkspaceMode): void => {
    setMode(m)
    setPref('workspace.mode', m)
  }
  // 파일 탐색기 칼럼(채팅 옆) — 접힘 상태는 앱 단위로 기억
  const [explorerOpen, setExplorerOpen] = useState<boolean>(() => getPref<boolean>('explorer.open', true))
  const toggleExplorer = useEvent(() => {
    setExplorerOpen((o) => {
      setPref('explorer.open', !o)
      return !o
    })
  })
  // 탐색기가 지금 보여주는 폴더(메인 작업 폴더 또는 참고 폴더의 절대 경로). '' = 아직
  // 보고가 없음 → cwd로 폴백. 채팅 입력의 @ 멘션이 이 폴더를 기준으로 파일을 뜨운다.
  const [explorerFolder, setExplorerFolder] = useState('')
  const onExplorerView = useEvent((folder: string) => setExplorerFolder(folder))
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

  // rate-limit usage: on mount and whenever a run finishes
  useEffect(() => {
    window.api.getUsage().then(setUsage).catch(() => {})
    window.api.apiConfig.get().then(setApiCfg).catch(() => {})
  }, [])

  // 설정 모달을 닫으면 API 설정을 다시 읽는다 — 방금 키를 등록/삭제했을 수 있다.
  // 키가 사라졌으면 API 모드도 끈다(키 없는 API 모드는 실행이 실패하므로).
  useEffect(() => {
    if (settingsOpen) return
    window.api.apiConfig
      .get()
      .then((s) => {
        setApiCfg(s)
        if (!s.hasKey) {
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

  // 컴포저의 과금 picker(구독/API) — API 선택인데 키가 없으면 설정 → API 탭을 열어 안내
  const onApiModeChange = useEvent((next: boolean) => {
    if (next && !apiCfg?.hasKey) {
      openApiSettings()
      return
    }
    setApiMode(() => {
      setPref('api.mode', next)
      return next
    })
  })

  // Fable 5 정책 거부 → 엔진이 폴백 모델로 전환·재시도한 경우(경고 배너는 스레드에
  // 표시됨), 이 채팅의 모델 picker도 따라 바꿔서 다음 메시지부터 폴백 모델로 바로
  // 가게 한다 — 안 바꾸면 매번 거부→전환을 반복한다.
  useEffect(
    () =>
      window.api.onEngineEvent((e) => {
        if (e.type !== 'model-fallback') return
        const next = pickerModelOf(e.toModel)
        if (next) setPicker((p) => (p.model === next ? p : { ...p, model: next }))
      }),
    []
  )

  // git 레포 루트 — 폴더가 바뀌면 다시 찾고, 턴이 끝나면(fsTick) force 재조회
  // (에이전트가 방금 git init 했을 수도 있다). 카드가 열린 채 폴더가 바뀌면 닫는다.
  useEffect(() => {
    setGitOpen(false)
    if (!manualCwd) {
      setGitRoot(null)
      return
    }
    let alive = true
    window.api.git
      .root(manualCwd)
      .then((r) => alive && setGitRoot(r))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [manualCwd])
  useEffect(() => {
    if (!manualCwd || fsTick === 0) return
    let alive = true
    window.api.git
      .root(manualCwd, true)
      .then((r) => alive && setGitRoot(r))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [fsTick])
  useEffect(() => {
    if (state.status === 'done' || state.status === 'error') {
      // fresh — 추가 크레딧 잔액이 방금 실행의 소비를 바로 반영하게 (5분 캐시 우회)
      window.api.getUsage(true).then(setUsage).catch(() => {})
      // API 모드 누적 사용액(전역)도 갱신 — 남은 예산 링이 실행 직후 바로 맞아떨어지게
      window.api.apiConfig.get().then(setApiCfg).catch(() => {})
      setFsTick((t) => t + 1)
    }
  }, [state.status])

  // restore saved conversations on mount, then load the active chat's snapshot
  // into the live session so it picks up right where it left off
  useEffect(() => {
    let alive = true
    window.api
      .getChats()
      .then((raw) => {
        if (!alive) return
        const data = raw as PersistedChats | null
        if (data && Array.isArray(data.chats) && data.chats.length) {
          // guard each snapshot against missing fields from an older/corrupt file —
          // including the per-chat folder, so restoring an old chat never sets undefined
          const restored = data.chats.map((c) => ({
            ...c,
            manualCwd: c.manualCwd ?? '',
            picker: sanitizePicker(c.picker),
            snapshot: sanitizeSnapshot(c.snapshot)
          }))
          const active = restored.find((c) => c.id === data.activeChatId) ?? restored[0]
          setChats(restored)
          setActiveChatId(active.id)
          load(active.snapshot)
          setManualCwd(active.manualCwd ?? '')
          setPicker(active.picker)
          // 닫기 전에 쓰다 만 초안(텍스트·첨부 이미지)도 그대로 돌아온다
          setInput(active.draft ?? '')
          setImages(active.draftImages ?? [])
        }
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setHydrated(true)
      })
    return () => {
      alive = false
    }
  }, [])

  // persist the chat list (debounced) — the active chat's live session is folded
  // back in, and ephemeral fields are stripped, so a restart resumes cleanly
  useEffect(() => {
    if (!hydrated) return
    const list = chats.map((c) =>
      c.id === activeChatId
        ? { ...c, snapshot: snapshotForPersist(state), manualCwd, picker, draft: input, draftImages: images }
        : { ...c, snapshot: snapshotForPersist(c.snapshot) }
    )
    const payload: PersistedChats = { version: CHATS_VERSION, chats: list, activeChatId }
    const t = setTimeout(() => {
      window.api.saveChats(payload).catch(() => {})
    }, 600)
    return () => clearTimeout(t)
  }, [hydrated, chats, activeChatId, state, manualCwd, picker, input, images])

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

  // Whether the chat auto-follows the bottom. This is a LATCH, not a per-frame
  // position check: the streaming loop below snaps to the bottom every frame, so
  // comparing positions would let each snap immediately undo a small scroll-up —
  // the user could never escape without one big flick. Instead we read intent
  // directly: a wheel-up turns following OFF (deltaY is intrinsic to the event, so
  // it never races the snap — and the handler runs before the frame's rAF, so the
  // snap is skipped that very frame). Following turns back ON only when the user
  // settles at the bottom AND isn't mid scroll-up. Reset to true on send / chat switch.
  const stickRef = useRef(true)
  const lastWheelUpRef = useRef(-Infinity) // timeStamp of the most recent upward wheel
  const lastTopRef = useRef(0) // 마지막 스크롤 위치 — 멀티 모드 왕복으로 패널이 재생성될 때 복원용
  const [showJump, setShowJump] = useState(false) // 바닥에서 멀어지면 "맨 아래로" 버튼 표시
  useEffect(() => {
    const el = scrollEl
    if (!el) return
    // 멀티 모드 왕복은 채팅 패널을 재생성해 scrollTop이 0(맨 위)에서 시작한다 — 바닥을
    // 따라가던 중이면 맨 아래로, 위를 읽던 중이면 마지막으로 보던 위치로 복원
    el.scrollTop = stickRef.current ? el.scrollHeight : lastTopRef.current
    setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight > JUMP_SHOW_PX)
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey) return // ctrl+wheel is zoom (handled elsewhere), not a scroll
      if (e.deltaY < 0) {
        stickRef.current = false // scrolling up → stop following
        lastWheelUpRef.current = e.timeStamp
      }
    }
    const onScroll = (e: Event): void => {
      lastTopRef.current = el.scrollTop
      const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      setShowJump(fromBottom > JUMP_SHOW_PX)
      // resume only while paused, settled at the bottom, and not in the middle of an
      // upward gesture — the time guard stops a near-bottom scroll-up from instantly
      // re-arming the follow (which would trap the user in the bottom band)
      if (!stickRef.current && fromBottom <= BOTTOM_EPSILON && e.timeStamp - lastWheelUpRef.current > 150)
        stickRef.current = true
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('scroll', onScroll)
    }
  }, [scrollEl])

  // switching/opening a chat always re-pins to the bottom (runs before the
  // message-arrive effect below, so the freshly loaded thread lands at the bottom)
  useEffect(() => {
    stickRef.current = true
    setShowJump(false)
  }, [activeChatId])

  // auto-stick to bottom when new messages/thinking arrive — but only while the
  // follow latch is on (scrolling up to read history pauses this)
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [state.messages, state.thinkingText])

  // while a run streams, follow the smooth text reveal every frame so it reads as
  // a continuous flow (not a jump on each delta). Paused while the latch is off.
  useEffect(() => {
    if (!busy) return
    const el = scrollRef.current
    if (!el) return
    let raf = 0
    let alive = true
    const stick = (): void => {
      if (!alive) return
      if (stickRef.current) el.scrollTop = el.scrollHeight
      raf = requestAnimationFrame(stick)
    }
    raf = requestAnimationFrame(stick)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
    }
  }, [busy])

  // 대화 스레드 ↑/↓ 제스처 — ↑는 스트리밍 중 rAF 바닥 고정이 도로 끌어내리지 않게 고정을
  // 풀고(재고정 150ms 가드도 무장), ↓는 '맨 아래로' 버튼과 같은 규칙으로 다시 고정한다
  const chatGestures: GestureAction[] = [
    {
      pattern: 'U',
      label: '맨 위로',
      run: () => {
        stickRef.current = false
        lastWheelUpRef.current = performance.now()
        scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
      }
    },
    {
      pattern: 'D',
      label: '맨 아래로',
      run: () => {
        stickRef.current = true
        const el = scrollRef.current
        if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      }
    },
    sessionWindowGesture()
  ]

  const cwd = manualCwd || ''
  // @ 멘션의 기준 폴더 — 탐색기가 보고 있는 폴더(참고 폴더 포함), 없으면 작업 폴더.
  // root가 바뀔 때마다 탐색기가 보고하므로 cwd가 바뀌어도 곧 따라온다.
  const mentionBase = explorerFolder || cwd

  // 프로젝트가 정해지면 분석 서버/컴파일 DB를 미리 데워 둔다 — 첫 파일을 열 때
  // 서버 워밍을 기다리지 않도록(특히 C#/UE). 폴더가 바뀔 때마다 한 번.
  useEffect(() => {
    if (cwd) window.api.lsp.prewarm(cwd).catch(() => {})
  }, [cwd])

  const activeChat = chats.find((c) => c.id === activeChatId)
  // a fresh chat with no messages and no title — it never appears in the recent
  // list; the chat area shows the welcome screen instead
  const activeEmpty = state.messages.length === 0 && !activeChat?.title

  // snapshot the live session into the currently active chat. An empty active
  // chat is dropped rather than kept, so at most one blank chat ever exists.
  const saveActive = (list: ChatMeta[]): ChatMeta[] =>
    activeEmpty
      ? list.filter((c) => c.id !== activeChatId)
      : list.map((c) =>
          c.id === activeChatId ? { ...c, snapshot: state, manualCwd, picker, draft: input, draftImages: images } : c
        )

  // load a chat's saved snapshot into the live session + restore its directory,
  // its own 모델·effort·모드 selection and any unsent composer draft
  const restore = (c: ChatMeta): void => {
    load(c.snapshot)
    setManualCwd(c.manualCwd)
    setPicker(c.picker ?? DEFAULT_PICKER)
    setInput(c.draft ?? '')
    setImages(c.draftImages ?? [])
    setActiveChatId(c.id)
  }

  const createChat = (): void => {
    if (mode !== 'single') return // multi/채팅 own ⌘N via their own workspaces
    if (busy) return // a run streams into the active chat — don't switch mid-flight
    if (activeEmpty) {
      // already sitting on a blank chat — nothing to create, just reset drafts
      setInput('')
      setImages([])
      return
    }
    // a new chat starts from the settings you're currently using — not the app default
    const fresh = newChatMeta(manualCwd, picker)
    setChats((list) => [fresh, ...saveActive(list)])
    load(initialSessionState)
    setInput('')
    setImages([])
    setActiveChatId(fresh.id)
  }

  const selectChat = (id: string): void => {
    if (id === activeChatId || busy) return
    const target = chats.find((c) => c.id === id)
    if (!target) return
    setChats((list) => saveActive(list))
    restore(target)
  }

  const renameChat = (id: string, name: string): void => {
    setChats((list) => list.map((c) => (c.id === id ? { ...c, title: name, custom: true } : c)))
  }

  const deleteChat = (id: string): void => {
    if (id === activeChatId && busy) return
    const remaining = chats.filter((c) => c.id !== id)
    if (id === activeChatId) {
      if (remaining.length === 0) {
        const fresh = newChatMeta(manualCwd, picker)
        load(initialSessionState)
        setInput('')
        setImages([])
        setChats([fresh])
        setActiveChatId(fresh.id)
        return
      }
      restore(remaining[0])
    }
    setChats(remaining)
  }

  // 사이드바 라벨 행의 전체 삭제 — 확인 카드는 Sidebar가 띄우고, 여기선 빈 채팅
  // 하나로 리셋한다 (deleteChat의 remaining.length === 0 분기와 동일한 착지점)
  const deleteAllChats = (): void => {
    if (busy) return
    const fresh = newChatMeta(manualCwd, picker)
    load(initialSessionState)
    setInput('')
    setImages([])
    setChats([fresh])
    setActiveChatId(fresh.id)
  }

  // ⌘N / Ctrl+N opens a fresh chat — read createChat through a ref to avoid stale closures
  const createChatRef = useRef(createChat)
  createChatRef.current = createChat
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Shift+Ctrl+N is a separate shortcut (new session window) — don't also make a chat
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        createChatRef.current()
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
      if (document.querySelector('.q-overlay, .q-mini, .pr-overlay')) return
      // when the /ask modal is FULL open it owns Enter (focuses its own composer), so
      // don't steal focus to the main one. When it's minimized, we deliberately let
      // this run — Enter then focuses the main chat composer, as expected.
      if (askOpenRef.current && !askMinimizedRef.current) return
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

  // Esc stops the running conversation (single mode). A modal / menu / selection toolbar
  // that's open owns Esc for its own dismiss, so we stand down while any is present —
  // only abort the run when Esc would otherwise do nothing. Mirrors the composer's stop
  // button: cancel the run and drop anything queued behind it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || mode !== 'single' || !busy) return
      if (
        document.querySelector(
          '.q-overlay, .q-mini, .set-overlay, .set-dialog-overlay, .pr-overlay, .ask-overlay, .ask-mini, .fv-overlay, .gitm-overlay, .iv-overlay, .sa-overlay, .ctx-menu, .sel-bar'
        )
      )
        return
      e.preventDefault()
      window.api.cancel()
      setQueue([])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, mode])

  // /clear — wipe the current conversation back to a blank slate (a client action
  // mirroring Claude Code's /clear; never sent to the engine, so the visible message
  // list and the engine's context stay in sync). Keeps the project folder.
  const clearConversation = (): void => {
    if (busy) return
    load(initialSessionState)
    setInput('')
    setImages([])
    setChats((list) =>
      list.map((c) => (c.id === activeChatId ? { ...c, title: '', custom: false, snapshot: initialSessionState } : c))
    )
  }

  // `opts` lets a queued message replay with the attachments + run settings it was
  // scheduled with (instead of the composer's current state); interactive sends omit it.
  // keepDraft: 컴포저 밖에서 만들어진 프롬프트(파일 뷰어 질문, 큐 재생)는 사용자가
  // 쓰다 둔 초안을 지우지 않는다.
  // 반환값: 엔진 런을 실제로 시작했으면 true — 클라이언트 명령(/ask·/clear)이나 조기
  // 반환은 false. 예약 큐 드레인이 이 값으로 "런 없이 소진된 항목" 뒤를 이어서 보낸다.
  const runPrompt = async (
    text: string,
    opts?: { images?: string[]; picker?: PickerState; keepDraft?: boolean }
  ): Promise<boolean> => {
    const imgs = opts?.images ?? images
    const pk = opts?.picker ?? picker
    // an image-only message (attachments, no text) is allowed — guard on having either
    if ((!text.trim() && imgs.length === 0) || busy) return false
    // /clear is a client command — reset the conversation instead of calling the engine
    if (text.trim() === '/clear') {
      clearConversation()
      return false
    }
    // /ask opens the independent throwaway modal — it runs on its own engine and is
    // never sent to the main chat. "/ask <question>" pre-fills the modal's composer.
    const trimmed = text.trim()
    if (trimmed === '/ask' || trimmed.startsWith('/ask ')) {
      openAsk(trimmed.slice(4).trim())
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
    stickRef.current = true
    // folder changed since this conversation began → it's a different project, and the
    // session can't continue here (a session id is folder-scoped). Reset the thread to a
    // clean slate so the visible chat matches the fresh engine session instead of showing
    // stale messages the model no longer remembers.
    const folderSwitched = !!state.session && state.messages.length > 0 && !sameCwd(state.session.cwd, dir)
    if (folderSwitched) load(initialSessionState)
    begin(text, cmd, imgs)
    // derive the chat title from the prompt (command → its friendly title) unless renamed.
    // a folder switch starts a fresh conversation, so it re-titles even a renamed chat.
    const title = cmd ? commandTitleOf(cmd) : text.trim().slice(0, 80) || '파일 첨부'
    setChats((list) =>
      list.map((c) => {
        if (c.id !== activeChatId) return c
        // 폴더가 바뀌면 최근 파일 탭도 비운다 (rel 경로는 이전 프로젝트의 것)
        const base = folderSwitched ? { ...c, recentFiles: undefined } : c
        return !c.custom || folderSwitched ? { ...base, title, custom: false } : base
      })
    )
    // commands take no extras — only fold mention/attachment notes into normal prompts.
    // `@path` mentions are already inline; the note just lists them so the engine reads
    // the referenced files reliably (the Agent SDK doesn't expand "@" the way the CLI does).
    let promptForEngine = text
    if (!cmd) {
      const notes: string[] = []
      const mentions = extractMentions(text)
      if (mentions.length)
        notes.push(`[멘션된 파일 — 필요하면 Read 도구로 확인하세요]\n${mentions.map((p) => '- ' + p).join('\n')}`)
      if (imgs.length)
        notes.push(`[첨부 파일 — Read 도구로 확인하세요]\n${imgs.map((p) => '- ' + p).join('\n')}`)
      if (notes.length) promptForEngine = `${text}\n\n${notes.join('\n\n')}`
    }
    const req: RunRequest = {
      prompt: promptForEngine,
      model: pk.model,
      effort: pk.effort,
      mode: pk.mode,
      cwd: dir,
      // 채팅별 프롬프트 — 매 실행 시스템 프롬프트에 append (없으면 생략)
      systemPrompt: activeChat?.sysPrompt,
      // resume this chat's session so the conversation continues with full history —
      // but only while still in the folder it was created in (a session id is scoped to
      // its project, so resuming it elsewhere errors "No conversation found"). A folder
      // change starts a fresh conversation in the new project.
      resume: state.session && sameCwd(state.session.cwd, dir) ? state.session.sessionId : undefined,
      // API 모드(컴포저 토글) — 이 실행을 구독 대신 저장된 API 키로 과금
      useApi: apiMode || undefined,
      // 이 채팅의 실행 계정(구독) — 전역 활성 계정과 다르면 엔진이 격리 폴더로 돌린다
      account: pk.account
    }
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
    // /ask는 본 대화와 분리된 자체 엔진 모달 — 메인 런과 무관하므로 예약하지 않고
    // 즉시 연다. (전엔 큐로 들어가 "실행 중엔 /ask가 안 되는" 것처럼 보였다.)
    const t = input.trim()
    if (t === '/ask' || t.startsWith('/ask ')) {
      openAsk(t.slice(4).trim())
      setInput('')
      composerRef.current?.focus()
      return
    }
    const id = crypto.randomUUID ? crypto.randomUUID() : `q-${Date.now()}-${queue.length}`
    setQueue((q) => [...q, { id, text: input, images, picker }])
    setInput('')
    setImages([])
    composerRef.current?.focus()
  }

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
    if (busy || !was || queueRef.current.length === 0) return
    void (async () => {
      while (queueRef.current.length > 0) {
        const next = queueRef.current[0]
        queueRef.current = queueRef.current.slice(1)
        setQueue((q) => q.slice(1))
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
    const base = `<selection>\n${text.trim()}\n</selection>\n\n이 부분 더 자세히 설명해줘`
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
        setQueue((q) => [...q, { id, text: prompt, images: [], picker }])
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

  const onAnswer = (answers: string[][]): void => {
    if (!state.pendingQuestion) return
    window.api.respondQuestion({ requestId: state.pendingQuestion.requestId, answers }).catch(() => {})
    clearQuestion()
  }
  // skip without answering (Esc / backdrop / ✕) → agent proceeds with its defaults
  const onDismissQuestion = (): void => {
    if (!state.pendingQuestion) return
    window.api.respondQuestion({ requestId: state.pendingQuestion.requestId, answers: null }).catch(() => {})
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
    // 최근 파일 탭도 비운다 — rel 경로는 폴더에 묶여 있어 새 프로젝트에선 무의미
    setChats((list) =>
      list.map((c) =>
        c.id === activeChatId
          ? { ...c, title: '', custom: false, snapshot: initialSessionState, recentFiles: undefined }
          : c
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
  // hide the "thinking…" indicator while the assistant is streaming its answer
  // text (the streaming text is the activity); keep it for thinking/tool phases
  const lastMsg = state.messages[state.messages.length - 1]
  const streamingAnswer = lastMsg?.kind === 'msg' && lastMsg.role === 'assistant' && !lastMsg.error
  // while a question card — or a running command card — is up, that card already
  // conveys "working", so drop the duplicate "…중" indicator
  const showWorking =
    (state.thinkingText != null || !streamingAnswer) && !state.pendingQuestion && !state.pendingCommand
  // only chats with real content show up in the recent list (blank chats are hidden).
  // memoized so it keeps a stable reference across keystrokes → memoized Sidebar skips.
  const chatSummaries = useMemo(
    () =>
      chats
        .filter((c) => (c.id === activeChatId ? state.messages.length > 0 : c.snapshot.messages.length > 0) || c.title !== '')
        .map((c) => ({
          id: c.id,
          title: c.title,
          status: c.id === activeChatId ? state.status : c.snapshot.status,
          hasPrompt: !!c.sysPrompt
        })),
    [chats, activeChatId, state.messages.length, state.status]
  )

  // stable handlers for the memoized Sidebar / WorkBar
  const onOpenSettings = useEvent(() => setSettingsOpen(true))
  // 최근 파일 탭: 이 채팅에서 연 파일을 기록. 새 파일만 맨 앞에 끼우고 이미 있는
  // 파일은 자리를 지킨다 — 드래그로 정리한 순서가 다시 열 때마다 출렁이지 않게. 최대 20개.
  const recordRecentFile = (path: string): void => {
    setChats((list) =>
      list.map((c) => {
        if (c.id !== activeChatId) return c
        const cur = c.recentFiles ?? []
        if (cur.includes(path)) return c
        return { ...c, recentFiles: [path, ...cur].slice(0, 20) }
      })
    )
  }
  // 모든 파일은 코드 뷰어 카드 하나로 연다 — 변경된 파일이면 뷰어가 diff 마킹
  // (추가 틴트·삭제 헤어라인·룰러)을 얹으므로 LSP 심볼 탐색과 변경 표시가 공존한다.
  // 일반 열기는 Git 카드의 일회성 컨텍스트를 비워 세션 diff 마킹으로 돌아온다.
  const openPath = (path: string): void => {
    setFileOverride(null)
    setOpenFilePath(path)
  }
  const onOpenFile = useEvent((f: { path: string }) => {
    recordRecentFile(f.path)
    openPath(f.path)
  })
  // click a file in a tool-log row / explorer — same viewer, recorded as recent
  const onOpenToolFile = useEvent((path: string) => {
    recordRecentFile(path)
    openPath(path)
  })
  // 최근 파일 탭에서 열기 — 기록 갱신 없이(탭 순서가 클릭마다 출렁이지 않게) 열기만
  const onOpenRecent = useEvent((path: string) => openPath(path))
  // 뷰어 안 Ctrl+클릭 정의 이동으로 들어간 파일도 최근 탭에 기록
  const onViewFile = useEvent((path: string) => recordRecentFile(path))
  // 드래그로 바뀐 탭 순서를 그대로 저장
  const onReorderRecent = useEvent((files: string[]) => {
    setChats((list) => list.map((c) => (c.id === activeChatId ? { ...c, recentFiles: files } : c)))
  })
  // 탭 X·휠클릭은 한 개, 우클릭 메뉴(다른/오른쪽/모두 닫기)는 여러 개를 한 번에 제거
  const onRemoveRecent = useEvent((paths: string[]) => {
    const drop = new Set(paths)
    setChats((list) =>
      list.map((c) =>
        c.id === activeChatId ? { ...c, recentFiles: (c.recentFiles ?? []).filter((p) => !drop.has(p)) } : c
      )
    )
  })
  const onOpenSubagent = useEvent((a: SubAgentInfo) => setOpenSubagentId(a.id))
  // 컨텍스트 팝오버 열 때 사용량 강제 새로고침 — 추가 크레딧 잔액이 그 순간 최신이게
  const onRefreshUsage = useEvent(() => {
    window.api.getUsage(true).then(setUsage).catch(() => {})
  })
  // ── Git 카드 ───────────────────────────────────────────────
  const onOpenGit = useEvent(() => {
    if (gitRoot) setGitOpen(true)
  })
  // ── 변경 파일 카드 (탐색기 우클릭) ─────────────────────────
  const onShowChanged = useEvent((scope: { rel: string; label: string }) => setChgScope(scope))
  // 작업 폴더가 바뀌면(채팅 전환 포함) 스코프 rel 경로가 무의미해지니 카드를 닫는다
  useEffect(() => setChgScope(null), [cwd])
  // Git 카드에서 파일 열기 — 커밋 시점 내용/마킹을 뷰어에 일회성으로 넘긴다
  const onGitOpenFile = useEvent((p: GitFileOpen) => {
    setFileOverride({ content: p.content, diff: p.diff, label: p.label })
    setOpenFilePath(p.path)
  })
  // "Claude에게 메시지 짓게 하기" — 활성 채팅에 커밋 위임 (작업 중이면 예약 큐로)
  const onGitAskClaude = useEvent((prompt: string) => {
    if (busy) {
      const id = crypto.randomUUID ? crypto.randomUUID() : `q-${Date.now()}-${queue.length}`
      setQueue((q) => [...q, { id, text: prompt, images: [], picker }])
    } else {
      void runPrompt(prompt, { images: [], keepDraft: true })
    }
  })
  const onNewChat = useEvent(createChat)
  const onSelectChat = useEvent(selectChat)
  const onRenameChat = useEvent(renameChat)
  const onDeleteChat = useEvent(deleteChat)
  const onDeleteAllChats = useEvent(deleteAllChats)
  const onPromptChat = useEvent((id: string) => setPromptChatId(id))
  // 프롬프트 저장 — 빈 값은 해제(필드 제거)로 처리
  const savePrompt = (id: string, text: string): void => {
    setChats((list) => list.map((c) => (c.id === id ? { ...c, sysPrompt: text || undefined } : c)))
  }
  const promptChat = promptChatId ? chats.find((c) => c.id === promptChatId) ?? null : null

  return (
    <div className={'win' + (maximized ? ' max' : '')}>
      <TitleBar title="Desktop" />
      <div className="win-body">
        {mode === 'multi' ? (
          <ErrorBoundary label="멀티 에이전트">
            <MultiWorkspace
              user={user}
              usage={usage}
              onOpenSettings={onOpenSettings}
              mode={mode}
              onModeChange={onModeChange}
              apiMode={apiMode}
              apiReady={!!apiCfg?.hasKey}
              onOpenApiSettings={openApiSettings}
            />
          </ErrorBoundary>
        ) : mode === 'chat' ? (
          <ErrorBoundary label="채팅">
            <ChatWorkspace
              user={user}
              usage={usage}
              onOpenSettings={onOpenSettings}
              mode={mode}
              onModeChange={onModeChange}
              apiMode={apiMode}
              apiReady={!!apiCfg?.hasKey}
              onApiModeChange={onApiModeChange}
              budgetUsd={apiCfg?.budgetUsd ?? null}
              totalSpentUsd={apiCfg?.spentUsd ?? 0}
            />
          </ErrorBoundary>
        ) : (
        <>
        <Sidebar
          user={user}
          chats={chatSummaries}
          activeChatId={activeChatId}
          busy={busy}
          chatQuery={chatQuery}
          onChatQuery={setChatQuery}
          onNewChat={onNewChat}
          onSelectChat={onSelectChat}
          onRenameChat={onRenameChat}
          onDeleteChat={onDeleteChat}
          onDeleteAllChats={onDeleteAllChats}
          onPromptChat={onPromptChat}
          onOpenSettings={onOpenSettings}
          mode={mode}
          onModeChange={onModeChange}
        />

        <Explorer
          cwd={cwd}
          open={explorerOpen}
          onToggle={toggleExplorer}
          refreshKey={fsTick}
          onPickFolder={pickFolder}
          onOpenFile={onOpenToolFile}
          changed={state.files}
          gitReady={!!gitRoot}
          onOpenGit={onOpenGit}
          onShowChanged={onShowChanged}
          onViewFolderChange={onExplorerView}
        />

        <div className="chat chat--code">
          <ChatHeader
            title={taskTitle}
            status={state.status}
            elapsed={elapsed}
            explorerHidden={!explorerOpen}
            onToggleExplorer={toggleExplorer}
          />
          <RecentFiles
            files={activeChat?.recentFiles ?? []}
            changed={state.files}
            activePath={openFilePath}
            onOpen={onOpenRecent}
            onRemove={onRemoveRecent}
            onReorder={onReorderRecent}
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
                {state.messages.map((m, idx) => {
                  // a tool group that opens the assistant's turn (the model ran a tool
                  // before writing any text) has no preceding message to carry the
                  // avatar — flag it so it draws the Claude avatar itself. It "leads"
                  // when the previous item isn't already part of the assistant column.
                  const prev = state.messages[idx - 1]
                  const prevIsAiBlock =
                    !!prev && (prev.kind === 'toolgroup' || (prev.kind === 'msg' && prev.role === 'assistant'))
                  return (
                    <MessageView
                      key={m.id}
                      item={m}
                      userInitial={user.avatarText}
                      userColor={user.avatarColor}
                      userName={user.name}
                      live={idx === state.messages.length - 1 && m.kind === 'msg' && m.role === 'assistant' && !m.error}
                      running={busy}
                      lead={m.kind === 'toolgroup' && !prevIsAiBlock}
                      onOpenFile={onOpenToolFile}
                      onOpenImage={openViewer}
                    />
                  )
                })}
                {busy && showWorking && <WorkingIndicator text={state.thinkingText} />}
              </div>
            )}
            {showJump && (
              <div className="jump-bottom-wrap">
                <button
                  className="jump-bottom has-tip"
                  data-tip="맨 아래로"
                  aria-label="맨 아래로"
                  onClick={() => {
                    stickRef.current = true
                    const el = scrollRef.current
                    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
                  }}
                >
                  <IconChevDown size={17} />
                </button>
              </div>
            )}
          </div>
          <SelectionToolbar scrollRef={scrollRef} onElaborate={onElaborateSelection} />
          <ChatFind scrollRef={scrollRef} />
          <MouseGestureLayer target={scrollEl} actions={chatGestures} />
          <WorkBar
            todos={state.todos}
            files={state.files}
            subagents={state.subagents}
            usage={usage}
            contextTokens={state.result?.contextTokens ?? null}
            contextWindow={state.result?.contextWindow ?? null}
            model={picker.model}
            apiMode={apiMode}
            chatSpentUsd={state.spentUsd ?? 0}
            budgetUsd={apiCfg?.budgetUsd ?? null}
            totalSpentUsd={apiCfg?.spentUsd ?? 0}
            onOpenFile={onOpenFile}
            onOpenSubagent={onOpenSubagent}
            onRefreshUsage={onRefreshUsage}
          />
          <Composer
            value={input}
            onChange={setInput}
            history={sentHistory}
            onSend={() => runPrompt(input)}
            onStop={() => {
              // stopping the run also abandons anything queued behind it
              window.api.cancel()
              setQueue([])
            }}
            onSchedule={scheduleMessage}
            queued={queue}
            onRemoveQueued={(id) => setQueue((q) => q.filter((m) => m.id !== id))}
            busy={busy}
            started={state.messages.length > 0}
            picker={picker}
            setPicker={setPicker}
            apiMode={apiMode}
            apiReady={!!apiCfg?.hasKey}
            onApiModeChange={onApiModeChange}
            images={images}
            onPickImages={addImagesFromPicker}
            onAddImagePaths={addImagePaths}
            onRemoveImage={(i) => setImages((a) => a.filter((_, idx) => idx !== i))}
            onOpenImage={openViewer}
            contextTokens={state.result?.contextTokens ?? null}
            contextWindow={state.result?.contextWindow ?? null}
            usage={usage}
            showContext={false}
            cwd={cwd}
            mentionBase={mentionBase}
            inputRef={composerRef}
          />
        </div>
        </>
        )}
      </div>

      {gitOpen && gitRoot && (
        <GitModal root={gitRoot} cwd={cwd} onClose={() => setGitOpen(false)} onOpenFile={onGitOpenFile} onAskClaude={onGitAskClaude} />
      )}

      {chgScope && (
        <ChangedFilesModal
          scope={chgScope}
          changed={state.files}
          onOpen={onOpenToolFile}
          onClose={() => setChgScope(null)}
        />
      )}

      <FileModal
        path={openFilePath}
        cwd={cwd}
        diffs={state.diffs}
        override={fileOverride}
        onClose={() => {
          setOpenFilePath(null)
          setFileOverride(null)
        }}
        onAskSelection={onAskSelection}
        onViewFile={onViewFile}
      />

      {viewer && (
        <ImageViewer
          images={viewer.images}
          index={viewer.index}
          onIndexChange={(i) => setViewer((v) => (v ? { ...v, index: i } : v))}
          onClose={() => setViewer(null)}
        />
      )}

      <SubAgentModal agent={openSubagent} onClose={() => setOpenSubagentId(null)} />

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

      {askOpen && (
        <AskModal
          onClose={() => {
            setAskOpen(false)
            setAskMinimized(false)
          }}
          minimized={askMinimized}
          onMinimizedChange={setAskMinimized}
          cwd={cwd}
          user={user}
          picker={picker}
          initialText={askInitial}
          apiMode={apiMode}
          apiReady={!!apiCfg?.hasKey}
          onApiModeChange={onApiModeChange}
        />
      )}

      {promptChat && (
        <PromptModal
          target={promptChat.title || '새 채팅'}
          scope="이 채팅에만 적용"
          noun="채팅"
          value={promptChat.sysPrompt ?? ''}
          onSave={(text) => savePrompt(promptChat.id, text)}
          onClose={() => setPromptChatId(null)}
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


      {/* 첫 실행 안내 — 둘은 SEEN_KEY를 공유해 서로 배타적이다. 새 설치(도장 없음)는
          WhatsNew(전체 기능 소개), 마이너 버전이 오른 업데이트는 UpdateNotes(업데이트
          패치노트). 엔진/앱 업데이트 게이트보다 먼저 렌더해서(z-index 동급, DOM 뒤가
          위) 게이트가 항상 위에 뜬다 */}
      <WhatsNew />
      <UpdateNotes />

      <EngineGate />
      <AppUpdateGate />
    </div>
  )
}

// Build the in-memory user from a saved/just-entered profile.
function userFromProfile(p: UserProfile): AppUser {
  const name = p.nickname.trim()
  return { name, avatarText: name.slice(0, 1).toUpperCase() || '?', avatarColor: p.color }
}

export default function App() {
  const [ready, setReady] = useState(false)
  // the last saved profile — pre-fills the entry screen so a returning user just
  // presses 입장하기. null until loaded / when none has ever been set.
  const [profile, setProfile] = useState<UserProfile | null>(null)
  // set once the user presses 입장하기; null shows the entry screen.
  const [user, setUser] = useState<AppUser | null>(null)
  const maximized = useMaximized()

  useEffect(() => {
    window.api
      .getProfile()
      .then((p) => setProfile(p))
      .catch(() => {})
      .finally(() => setReady(true))
  }, [])

  // 입장하기: persist the profile, then enter the app
  const enter = (p: UserProfile): void => {
    window.api.saveProfile(p).catch(() => {})
    setProfile(p)
    setUser(userFromProfile(p))
  }

  let content: React.ReactNode
  if (!ready) {
    content = (
      <div className={'win' + (maximized ? ' max' : '')}>
        <div className="boot">
          <div className="boot-logo"><IconCode size={29} stroke={2.4} /></div>
          <div className="boot-name">AgentCodeGUI</div>
          <div className="boot-spin" />
          <div className="boot-sub">불러오는 중…</div>
        </div>
      </div>
    )
  } else if (!user) {
    content = <Profile initial={profile} onEnter={enter} />
  } else {
    // 최상위 안전망 — MainApp 자체 렌더(단일 모드 스레드 포함)에서 난 예외까지 잡는다.
    // 워크스페이스별 경계가 먼저 잡고, 여기는 그 밖(사이드바·모달 등)을 커버한다.
    content = (
      <ErrorBoundary label="앱">
        <MainApp user={user} />
      </ErrorBoundary>
    )
  }

  return (
    <>
      {!maximized && <ResizeHandles />}
      {content}
    </>
  )
}
