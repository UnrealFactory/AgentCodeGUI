import { useEffect, useMemo, useRef, useState } from 'react'
import type { ApiConfigStatus, AppUser, BgTaskRequest, EngineId, RunRequest, SessionWindowInfo, SubAgentInfo, UsageInfo, UserProfile } from '@shared/protocol'

// 백그라운드 셸 컨트롤(중지/Ctrl+B) — window.api는 전역이라 모듈 스코프의 고정 함수로
// 만들어 memo된 WorkBar가 매 렌더마다 새 콜백을 받지 않게 한다
const onBgTaskMain = (req: BgTaskRequest): void => {
  window.api.bgTask(req).catch(() => {})
}
import { extractMentions } from './lib/mentions'
import { useAgentSession, initialSessionState, sanitizeSnapshot, snapshotForPersist, sameCwd, commandOf, commandTitleOf, liveMsgIndex, type SessionState } from './store/session'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Sidebar, type ChatSummary, type SidebarSection } from './components/Sidebar'
import { pushRecentDir, seedRecentDirs } from './lib/recentDirs'
import { MultiWorkspace, useMultiSessions } from './components/MultiAgent'
import { NewChatModal } from './components/NewChatModal'
import { getPref, setPref } from './lib/prefs'
import { ChatHeader, ChatFind, Composer, MessageView, QuestionModal, PermissionModal, SelectionToolbar, WelcomeState, WorkBar, WorkingIndicator, hasRunningBash, nextMode, pickerModelOf, useThreadFollow, type PickerState, type ScheduledMsg } from './components/Chat'
import { SubAgentModal } from './components/AgentPanel'
import { Explorer } from './components/Explorer'
import { FolderSwitchDialog } from './components/FolderSwitchDialog'
import { FileModal } from './components/FileModal'
import { ChangedFilesModal } from './components/ChangedFilesModal'
import { ImageViewer } from './components/ImageViewer'
import { SettingsModal } from './components/Settings'
import { EngineGate } from './components/EngineGate'
import { EngineUpdateGate } from './components/EngineUpdateGate'
import { AppUpdateGate } from './components/AppUpdateGate'
import { PatchNotes } from './components/PatchNotes'
import { useZoom, ZoomBadge, mergeRefs } from './components/zoom'
import { MouseGestureLayer, clearGesture, sessionWindowGesture, type GestureAction } from './components/mouseGesture'
import { IconChevDown, IconCode } from './components/icons'

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
  updatedAt?: number // 마지막 활동(프롬프트 전송) 시각 — 사이드바 상대 시간 표시용
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
  const { state, busy, begin, clearPermission, clearQuestion, answerQuestion, load } = useAgentSession()
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
  // 탐색기 우클릭 '변경된 파일 보기' 카드 — 스코프 폴더(rel '' = 프로젝트 전체)와 표시 이름
  const [chgScope, setChgScope] = useState<{ rel: string; label: string } | null>(null)
  // a working-folder change that would reset the current conversation, parked here
  // until the user confirms it in the card modal (변경) or backs out (취소)
  const [pendingFolder, setPendingFolder] = useState<string | null>(null)
  const [openSubagentId, setOpenSubagentId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [chats, setChats] = useState<ChatMeta[]>(() => [newChatMeta()])
  const [activeChatId, setActiveChatId] = useState<string>(() => chats[0].id)
  // 일반(단일) / 멀티 뷰 — 2.0: 모드 탭이 사라지고 사이드바 항목 선택이 뷰를 정한다.
  // 1.x의 'chat'(순수 채팅 모드) 저장값은 'single'로 위생 처리 (모드 자체가 은퇴).
  const [mode, setMode] = useState<'single' | 'multi'>(() =>
    getPref<string>('workspace.mode', 'single') === 'multi' ? 'multi' : 'single'
  )
  const switchMode = (m: 'single' | 'multi'): void => {
    setMode(m)
    setPref('workspace.mode', m)
  }
  // 멀티 세션 메타(목록·제목·상태·영속화) — App이 소유해 사이드바 '멀티 채팅' 섹션이
  // 어느 뷰에서든 그려지고, 멀티 뷰는 이 번들을 받아 활성 세션만 렌더한다
  const multi = useMultiSessions()
  // 열린 세션 창(추가 채팅) 목록 — 메인 프로세스 레지스트리 구독
  const [sessionWins, setSessionWins] = useState<SessionWindowInfo[]>([])
  useEffect(() => {
    window.api.sessionWindows.list().then(setSessionWins).catch(() => {})
    return window.api.sessionWindows.onChanged(setSessionWins)
  }, [])
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
  // ` (백쿼트) 한 키 = 사이드바 ⟷ 탐색기 전환 — 글자가 들어가는 입력에서는 무시.
  // 탐색기는 코드 뷰 전용이라 멀티 뷰에서는 반응하지 않는다.
  const modeRef = useRef(mode)
  modeRef.current = mode
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== '`' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      if (modeRef.current !== 'single') return
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
  useEffect(() => {
    if (settingsOpen) return
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

  // restore saved conversations on mount, then load the active chat's snapshot
  // into the live session so it picks up right where it left off.
  // 1.x 채팅 모드(chat-talk.json)의 대화는 일반 목록 뒤로 1회 편입한다 — 모드 자체가
  // 은퇴했으므로(2.0), 편입 후 원본 파일은 비워 다음 실행에서 중복 편입되지 않게 한다.
  useEffect(() => {
    let alive = true
    Promise.all([window.api.getChats().catch(() => null), window.api.talk.getState().catch(() => null)])
      .then(([raw, talkRaw]) => {
        if (!alive) return
        const data = raw as PersistedChats | null
        // guard each snapshot against missing fields from an older/corrupt file —
        // including the per-chat folder, so restoring an old chat never sets undefined
        const restored =
          data && Array.isArray(data.chats) && data.chats.length
            ? data.chats.map((c) => ({
                ...c,
                manualCwd: c.manualCwd ?? '',
                picker: sanitizePicker(c.picker),
                snapshot: sanitizeSnapshot(c.snapshot)
              }))
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
          setActiveChatId(active.id)
          load(active.snapshot)
          setManualCwd(active.manualCwd ?? '')
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

  // 스레드 바닥 따라가기 — 래치·점프 버튼·스트리밍 rAF 고정을 훅이 소유한다
  // (본채팅·추가 채팅 공용 — Chat.tsx의 useThreadFollow)
  const follow = useThreadFollow(scrollEl, busy)

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
    { pattern: 'U', label: '맨 위로', run: () => follow.scrollTop() },
    { pattern: 'D', label: '맨 아래로', run: () => follow.jumpBottom() },
    sessionWindowGesture(),
    // clearConversation은 아래에서 선언 — 배열 생성 시점(TDZ)을 피해 실행 시점에 참조한다
    clearGesture(() => clearConversation())
  ]

  const cwd = manualCwd || ''
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

  // snapshot the live session into the currently active chat. 빈 채팅도 버리지 않고
  // 그대로 저장한다 — 새 채팅에서 골라둔 모델·모드·계정(picker)·폴더·초안이 다른 채팅에
  // 다녀와도 남아 있게. 사이드바 목록엔 원래 안 보이고(chatSummaries가 거름), 새로
  // 만드는 대신 createChat이 재사용하므로 빈 채팅은 여전히 최대 1개다.
  const saveActive = (list: ChatMeta[]): ChatMeta[] =>
    list.map((c) =>
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
    if (busy) return // a run streams into the active chat — don't switch mid-flight
    if (activeEmpty) {
      // already sitting on a blank chat — nothing to create, just reset drafts
      setInput('')
      setImages([])
      return
    }
    // 이미 만들어둔 빈 채팅이 있으면 새로 만들지 않고 거기로 복귀 — 골라둔
    // 모델·모드·계정·폴더·초안이 그대로 살아 돌아온다 (빈 채팅 최대 1개 규칙)
    const blank = chats.find((c) => c.id !== activeChatId && !c.title && c.snapshot.messages.length === 0)
    if (blank) {
      setChats((list) => saveActive(list))
      restore(blank)
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
      if (document.querySelector('.q-overlay, .q-mini, .pr-overlay')) return
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
          '.q-overlay, .q-mini, .set-overlay, .set-dialog-overlay, .pr-overlay, .fv-overlay, .gitm-overlay, .iv-overlay, .sa-overlay, .ctx-menu, .sel-bar'
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
  // 반환값: 엔진 런을 실제로 시작했으면 true — 클라이언트 명령(/clear)이나 조기
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
    // derive the chat title from the prompt (command → its friendly title) unless renamed.
    // a folder switch starts a fresh conversation, so it re-titles even a renamed chat.
    const title = cmd ? commandTitleOf(cmd) : text.trim().slice(0, 80) || '파일 첨부'
    setChats((list) =>
      list.map((c) => {
        if (c.id !== activeChatId) return c
        // 전송 = 활동 — 사이드바 상대 시간(updatedAt)이 이 순간으로 갱신된다
        const base = { ...c, updatedAt: Date.now() }
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
      // 실행 엔진(claude/codex) + Codex GPT 모델 — 생략하면 Claude
      engine: pk.engine,
      codexModel: pk.codexModel,
      cwd: dir,
      // resume this chat's session so the conversation continues with full history —
      // but only while still in the folder it was created in (a session id is scoped to
      // its project, so resuming it elsewhere errors "No conversation found"). A folder
      // change starts a fresh conversation in the new project.
      resume: state.session && sameCwd(state.session.cwd, dir) ? state.session.sessionId : undefined,
      // API 모드(컴포저 토글) — 이 실행을 구독 대신 저장된 API 키로 과금
      useApi: apiMode || undefined,
      // 실행 계정 — 클로드는 격리 CLAUDE_CONFIG_DIR, Codex는 격리 CODEX_HOME (미지정=기본 계정)
      account: pk.account,
      codexAccount: pk.codexAccount
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
    answerQuestion(answers) // 카드를 닫으며 문답 흔적을 스레드에 남긴다
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
          updatedAt: c.updatedAt
        })),
    [chats, activeChatId, state.messages.length, state.status]
  )

  // stable handlers for the memoized Sidebar / WorkBar
  const onOpenSettings = useEvent(() => setSettingsOpen(true))
  // 모든 파일은 코드 뷰어 카드 하나로 연다 — 변경된 파일이면 뷰어가 diff 마킹
  // (추가 틴트·삭제 헤어라인·룰러)을 얹으므로 LSP 심볼 탐색과 변경 표시가 공존한다.
  const openPath = (path: string): void => {
    setOpenFilePath(path)
  }
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
  // 작업 폴더가 바뀌면(채팅 전환 포함) 스코프 rel 경로가 무의미해지니 카드를 닫는다
  useEffect(() => setChgScope(null), [cwd])
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
  // 추가 채팅 — id는 영속 채팅 id. 클릭=창 포커스(닫힌 채팅이면 창을 다시 만들어 복원),
  // X=대화 삭제(열린 창이 있으면 그 창도 닫힘). 목록은 창을 닫아도/재시작해도 남는다.
  const onFocusSessionWin = useEvent((id: string) => {
    window.api.sessionWindows.focus(id).catch(() => {})
  })
  const onCloseSessionWin = useEvent((id: string) => {
    window.api.sessionWindows.close(id).catch(() => {})
  })
  const onRenameSessionWin = useEvent((id: string, name: string) => {
    window.api.sessionWindows.rename(id, name).catch(() => {})
  })
  const onCloseAllSessionWins = useEvent(() => {
    sessionWins.forEach((w) => window.api.sessionWindows.close(w.id).catch(() => {}))
  })
  const extraSummaries = useMemo<ChatSummary[]>(
    () => sessionWins.map((w) => ({ id: w.id, title: w.title || '새 채팅', status: w.status, updatedAt: w.updatedAt })),
    [sessionWins]
  )
  // 사이드바 3섹션 — active 하이라이트는 지금 보이는 뷰의 항목 하나만(PoC 규칙).
  // currentId는 busy 잠금 예외용: 실행이 흐르는 채팅은 멀티 뷰에서도 눌러 돌아올 수 있다
  const sections: SidebarSection[] = useMemo(
    () => [
      {
        key: 'general' as const,
        label: '일반 채팅',
        chats: chatSummaries,
        activeId: mode === 'single' ? activeChatId : undefined,
        currentId: activeChatId,
        busy,
        onSelect: onSelectGeneral,
        onRename: onRenameChat,
        onDelete: onDeleteChat,
        onDeleteAll: onDeleteAllChats
      },
      {
        key: 'multi' as const,
        label: '멀티 채팅',
        chats: multi.summaries,
        activeId: mode === 'multi' ? multi.activeId : undefined,
        onSelect: onSelectMulti,
        onRename: multi.renameSession,
        onDelete: multi.deleteSession,
        onDeleteAll: multi.deleteAllSessions
      },
      {
        key: 'extra' as const,
        label: '추가 채팅',
        chats: extraSummaries,
        onSelect: onFocusSessionWin,
        onRename: onRenameSessionWin,
        onDelete: onCloseSessionWin,
        onDeleteAll: onCloseAllSessionWins
      }
    ],
    // useEvent 핸들러·multi CRUD는 stable — 데이터/선택 상태만 의존한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatSummaries, multi.summaries, multi.activeId, extraSummaries, mode, activeChatId, busy]
  )
  return (
    <div className="win">
      <div className="blurwarm" />
      <div className="win-body">
        {/* 왼쪽 칼럼 — 채팅 사이드바 ⟷ 파일 탐색기 전환 ( ` 또는 헤더 돋보기 옆 버튼, 코드 뷰 전용).
            두 패널 모두 242px 고정이라 폭 트랜지션 없이 key 교체 슬라이드-인만 남는다 */}
        <div className="lcol">
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
            />
          ) : (
            <Sidebar key="sb" user={user} sections={sections} onNewChat={onOpenNewChat} onOpenSettings={onOpenSettings} />
          )}
        </div>
        {mode === 'multi' ? (
          <ErrorBoundary label="멀티 에이전트">
            <MultiWorkspace
              multi={multi}
              usage={usage}
              apiMode={apiMode}
              apiReady={!!apiCfg?.hasKey}
              apiReadyCodex={!!apiCfg?.hasOpenaiKey}
              onOpenApiSettings={openApiSettings}
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
            explorerHidden={!explorerOpen}
            onToggleExplorer={toggleExplorer}
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
                {state.messages.map((m, idx) => (
                  <MessageView
                    key={m.id}
                    item={m}
                    live={idx === liveMsgIndex(state.messages) && m.kind === 'msg' && m.role === 'assistant' && !m.error}
                    running={busy}
                    onOpenFile={onOpenToolFile}
                    onOpenImage={openViewer}
                  />
                ))}
                {busy && showWorking && <WorkingIndicator text={state.thinkingText} />}
              </div>
            )}
            {follow.showJump && (
              <div className="jump-bottom-wrap">
                <button
                  className="jump-bottom has-tip"
                  data-tip="맨 아래로"
                  aria-label="맨 아래로"
                  onClick={follow.jumpBottom}
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
            apiReadyCodex={!!apiCfg?.hasOpenaiKey}
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
        onClose={() => setOpenFilePath(null)}
        onAskSelection={onAskSelection}
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
          <div className="boot-logo"><IconCode size={29} stroke={2.4} /></div>
          <div className="boot-name">AgentCodeGUI</div>
          <div className="boot-spin" />
          <div className="boot-sub">불러오는 중…</div>
        </div>
      </div>
    )
  }
  // 최상위 안전망 — MainApp 자체 렌더(단일 모드 스레드 포함)에서 난 예외까지 잡는다.
  // 워크스페이스별 경계가 먼저 잡고, 여기는 그 밖(사이드바·모달 등)을 커버한다.
  return (
    <ErrorBoundary label="앱">
      <MainApp user={user} />
    </ErrorBoundary>
  )
}
