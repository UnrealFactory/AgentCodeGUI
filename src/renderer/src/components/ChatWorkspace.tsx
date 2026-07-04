import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppUser, RunRequest, UsageInfo } from '@shared/protocol'
import { extractMentions } from '../lib/mentions'
import {
  useAgentSession,
  initialSessionState,
  sanitizeSnapshot,
  snapshotForPersist,
  commandOf,
  commandTitleOf,
  type SessionState
} from '../store/session'
import {
  ChatHeader,
  Composer,
  MessageView,
  QuestionModal,
  PermissionModal,
  SelectionToolbar,
  WelcomeState,
  WorkingIndicator,
  WorkBar,
  nextMode,
  pickerModelOf,
  type PickerState,
  type ScheduledMsg
} from './Chat'
import { SubAgentModal } from './AgentPanel'
import { FileModal } from './FileModal'
import { Sidebar, type WorkspaceMode } from './Sidebar'
import { ImageViewer } from './ImageViewer'
import { useZoom, ZoomBadge, mergeRefs } from './zoom'
import { IconChevDown } from './icons'

// px from the bottom within which the chat counts as "at the bottom" — scrolling
// back into this band (when not mid scroll-up) resumes auto-follow (mirrors 단일 모드)
const BOTTOM_EPSILON = 60
const JUMP_SHOW_PX = 240 // 바닥에서 이만큼 멀어지면 "맨 아래로" 점프 버튼을 띄운다 (단일 모드와 동일)

// 채팅(순수 대화)은 작업 폴더가 없다 — 엔진은 빈 cwd를 홈 폴더로 폴백한다. 시스템
// 프롬프트로 "대화 위주" 성향을 살짝 유도해, 사용자가 첨부/요청하지 않는 한 도구를
// 들추지 않고 말로 답하게 한다 (첨부 이미지·명시 요청은 예외).
const CHAT_SYSTEM_PROMPT =
  '지금은 사용자와 자유롭게 이야기하는 채팅 모드입니다. 사용자가 파일/이미지를 첨부했거나 명시적으로 요청한 경우가 아니라면, 파일을 뒤지거나 도구를 실행하지 말고 대화로 답하세요. 친근하고 간결하게, 한국어로 답합니다.'

// fresh chats / chats saved before the picker existed fall back to this
const DEFAULT_PICKER: PickerState = { model: 'opus', effort: 'high', mode: 'auto' }
const MODEL_IDS = ['fable', 'opus', 'sonnet', 'haiku']
const EFFORT_IDS = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal']
const MODE_IDS = ['normal', 'plan', 'acceptEdits', 'auto', 'bypass']
function sanitizePicker(p?: Partial<PickerState> | null): PickerState {
  return {
    model: p?.model && MODEL_IDS.includes(p.model) ? p.model : DEFAULT_PICKER.model,
    effort: p?.effort && EFFORT_IDS.includes(p.effort) ? p.effort : DEFAULT_PICKER.effort,
    mode: p?.mode && MODE_IDS.includes(p.mode) ? p.mode : DEFAULT_PICKER.mode
  }
}

// one conversation in the 채팅 list — the active one's live data lives in the session;
// inactive ones hold a frozen snapshot restored on switch (same shape as 단일 모드,
// minus the folder/recent-files/prompt fields that pure chat doesn't have)
interface ChatMeta {
  id: string
  title: string
  custom: boolean // user-renamed → keep the title instead of deriving from prompts
  snapshot: SessionState
  picker: PickerState
  draft?: string // 보내지 않은 컴포저 초안 — 채팅 전환에도 유지
  draftImages?: string[]
}

let chatSeq = 0
function chatId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  chatSeq += 1
  return `talk-${chatSeq}-${performance.now().toString(36)}`
}
function newChatMeta(picker: PickerState = DEFAULT_PICKER): ChatMeta {
  return { id: chatId(), title: '', custom: false, snapshot: initialSessionState, picker: { ...picker } }
}

// stable callback identity that always calls the latest closure — lets the memoized
// Sidebar skip re-render on every keystroke without stale closures
function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn)
  ref.current = fn
  return useRef((...args: A) => ref.current(...args)).current
}

// ── chat-workspace persistence (~/.agentcodegui/chat-talk.json) ──────────────
const TALK_VERSION = 1
interface PersistedTalk {
  version: number
  chats: ChatMeta[]
  activeChatId: string
}

// The pure-conversation workspace: sidebar (its own chat list) + one clean chat column.
// No explorer, no agent/todo panel, no project folder — just talking. Runs on a dedicated
// engine channel (window.api.talk) so its stream never mixes into the 단일/멀티 chats.
export function ChatWorkspace({
  user,
  usage,
  onOpenSettings,
  mode,
  onModeChange,
  apiMode,
  apiReady,
  onApiModeChange,
  budgetUsd,
  totalSpentUsd
}: {
  user: AppUser
  usage: UsageInfo
  onOpenSettings: () => void
  mode: WorkspaceMode
  onModeChange: (m: WorkspaceMode) => void
  apiMode: boolean // 전역 과금 모드 (구독/API) — App이 소유, 여기선 표시·전달만
  apiReady: boolean
  onApiModeChange: (next: boolean) => void
  budgetUsd: number | null // 컴포저 ContextStrip의 남은 예산 표시용
  totalSpentUsd: number
}) {
  const { state, clearPermission, clearQuestion, begin, load } = useAgentSession(window.api.talk.onEvent)
  const busy = state.status === 'analyzing' || state.status === 'working'

  const [chats, setChats] = useState<ChatMeta[]>(() => [newChatMeta()])
  const [activeChatId, setActiveChatId] = useState<string>(() => chats[0].id)
  const [chatQuery, setChatQuery] = useState('')
  const [picker, setPicker] = useState<PickerState>(DEFAULT_PICKER)
  const [input, setInput] = useState('')
  const [images, setImages] = useState<string[]>([])
  // messages drafted while the agent is busy — auto-sent in order once the run ends
  const [queue, setQueue] = useState<ScheduledMsg[]>([])
  const [viewer, setViewer] = useState<{ images: string[]; index: number } | null>(null)
  // false until saved chats are loaded — gates persistence so we never clobber the saved
  // file with the default blank chat before hydration finishes
  const [hydrated, setHydrated] = useState(false)
  // App refreshes usage on the MAIN engine's runs, which never fire here — so the chat
  // workspace keeps its own copy fresh (seeded from the prop) on mount + each run end
  const [liveUsage, setLiveUsage] = useState<UsageInfo>(usage)
  useEffect(() => {
    window.api.getUsage().then(setLiveUsage).catch(() => {})
  }, [])
  useEffect(() => {
    if (state.status === 'done' || state.status === 'error') window.api.getUsage().then(setLiveUsage).catch(() => {})
  }, [state.status])

  const scrollRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)

  // Ctrl+휠로 채팅 글자 크기 조절 (단일/멀티 모드와 같은 'chat.zoom' 키를 공유해 한 번
  // 정한 읽기 크기가 모드 간에 일관되게 유지된다). zoom.ref(휠 리스너용 콜백 ref)를
  // 스크롤 뷰포트에 합쳐 붙인다 — 콜백 ref는 stable하므로 memo가 재생성되지 않는다.
  const chatZoom = useZoom('chat.zoom')
  const chatScrollRef = useMemo(() => mergeRefs(scrollRef, chatZoom.ref), [chatZoom.ref])

  // 내가 보낸 메시지(오래된→최신) — 작성칸에서 ↑/↓로 셸처럼 다시 불러온다
  const sentHistory = useMemo(
    () =>
      state.messages
        .filter((m): m is Extract<SessionState['messages'][number], { kind: 'msg' }> => m.kind === 'msg' && m.role === 'user')
        .map((m) => m.text)
        .filter((t) => t.trim().length > 0),
    [state.messages]
  )

  // restore saved conversations on mount, then load the active chat's snapshot
  useEffect(() => {
    let alive = true
    window.api.talk
      .getState()
      .then((raw) => {
        if (!alive) return
        const data = raw as PersistedTalk | null
        if (data && Array.isArray(data.chats) && data.chats.length) {
          const restored = data.chats.map((c) => ({
            ...c,
            picker: sanitizePicker(c.picker),
            snapshot: sanitizeSnapshot(c.snapshot)
          }))
          const active = restored.find((c) => c.id === data.activeChatId) ?? restored[0]
          setChats(restored)
          setActiveChatId(active.id)
          load(active.snapshot)
          setPicker(active.picker)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // persist the chat list (debounced) — the active chat's live session is folded back
  // in, and ephemeral fields are stripped, so a restart resumes cleanly
  useEffect(() => {
    if (!hydrated) return
    const list = chats.map((c) =>
      c.id === activeChatId
        ? { ...c, snapshot: snapshotForPersist(state), picker, draft: input, draftImages: images }
        : { ...c, snapshot: snapshotForPersist(c.snapshot) }
    )
    const payload: PersistedTalk = { version: TALK_VERSION, chats: list, activeChatId }
    const t = setTimeout(() => {
      window.api.talk.saveState(payload).catch(() => {})
    }, 600)
    return () => clearTimeout(t)
  }, [hydrated, chats, activeChatId, state, picker, input, images])

  // Fable 5 정책 거부 → 엔진이 폴백 모델로 전환·재시도한 경우, 이 채팅의 picker도 따라
  // 바꿔 다음 메시지부터 폴백 모델로 바로 가게 한다 (단일 모드와 동일)
  useEffect(
    () =>
      window.api.talk.onEvent((e) => {
        if (e.type !== 'model-fallback') return
        const next = pickerModelOf(e.toModel)
        if (next) setPicker((p) => (p.model === next ? p : { ...p, model: next }))
      }),
    []
  )

  // ── auto-follow latch (same intent-read approach as 단일 모드) ──────────────
  const stickRef = useRef(true)
  const lastWheelUpRef = useRef(-Infinity)
  const [showJump, setShowJump] = useState(false) // 바닥에서 멀어지면 "맨 아래로" 버튼 표시
  // the chat-scroll element is stable for this workspace's lifetime, so binding once on
  // mount (refs are attached before effects run) is enough — no need to track it as state
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey) return // ctrl+wheel은 줌(zoom 훅이 처리) — 스크롤이 아니다
      if (e.deltaY < 0) {
        stickRef.current = false
        lastWheelUpRef.current = e.timeStamp
      }
    }
    const onScroll = (e: Event): void => {
      const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      setShowJump(fromBottom > JUMP_SHOW_PX)
      if (!stickRef.current && fromBottom <= BOTTOM_EPSILON && e.timeStamp - lastWheelUpRef.current > 150)
        stickRef.current = true
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('scroll', onScroll)
    }
  }, [])
  // switching chats re-pins to the bottom
  useEffect(() => {
    stickRef.current = true
    setShowJump(false)
  }, [activeChatId])
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [state.messages, state.thinkingText])
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

  const activeChat = chats.find((c) => c.id === activeChatId)
  const activeEmpty = state.messages.length === 0 && !activeChat?.title

  // snapshot the live session into the active chat (dropping a blank active chat, so at
  // most one blank chat ever exists)
  const saveActive = (list: ChatMeta[]): ChatMeta[] =>
    activeEmpty
      ? list.filter((c) => c.id !== activeChatId)
      : list.map((c) => (c.id === activeChatId ? { ...c, snapshot: state, picker, draft: input, draftImages: images } : c))

  const restore = (c: ChatMeta): void => {
    load(c.snapshot)
    setPicker(c.picker ?? DEFAULT_PICKER)
    setInput(c.draft ?? '')
    setImages(c.draftImages ?? [])
    setActiveChatId(c.id)
  }

  const createChat = (): void => {
    if (busy) return // a run streams into the active chat — don't switch mid-flight
    if (activeEmpty) {
      setInput('')
      setImages([])
      return
    }
    const fresh = newChatMeta(picker)
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
        const fresh = newChatMeta(picker)
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

  // /clear — wipe the active conversation back to a blank slate (client action, never
  // sent to the engine, so the visible list and the engine context stay in sync)
  const clearConversation = (): void => {
    if (busy) return
    load(initialSessionState)
    setInput('')
    setImages([])
    setChats((list) =>
      list.map((c) => (c.id === activeChatId ? { ...c, title: '', custom: false, snapshot: initialSessionState } : c))
    )
  }

  // ⌘N / Ctrl+N opens a fresh chat (read through a ref to avoid stale closures)
  const createChatRef = useRef(createChat)
  createChatRef.current = createChat
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        createChatRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Enter (from outside a field) jumps into the composer; Shift+Tab cycles the run mode
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
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

  // Esc stops the running conversation — unless a modal/menu/selection toolbar owns Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !busy) return
      if (document.querySelector('.q-overlay, .q-mini, .set-overlay, .set-dialog-overlay, .pr-overlay, .iv-overlay, .ctx-menu, .sel-bar'))
        return
      e.preventDefault()
      window.api.talk.cancel().catch(() => {})
      setQueue([])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy])

  const addImagePaths = (paths: string[]): void => {
    if (paths.length) setImages((a) => Array.from(new Set([...a, ...paths])))
  }
  const addImagesFromPicker = async (): Promise<void> => {
    addImagePaths(await window.api.pickImages())
  }
  const openViewer = useEvent((imgs: string[], index: number) => setViewer({ images: imgs, index }))

  // 작업 바(할 일·서브에이전트·변경된 파일·컨텍스트)에서 연 것들 — 단일(코드) 모드와
  // 동일한 뷰어/카드. 채팅 모드도 요청하면 도구가 돌 수 있어 같은 패널이 유효하다.
  const [openWorkFile, setOpenWorkFile] = useState<string | null>(null)
  const [openSubagentId, setOpenSubagentId] = useState<string | null>(null)
  const openSubagent = openSubagentId ? state.subagents.find((a) => a.id === openSubagentId) ?? null : null

  // `opts` lets a queued message replay with the attachments + run settings it was
  // scheduled with; interactive sends omit it. keepDraft: queued replays don't clear the
  // draft the user may be typing.
  const runPrompt = async (
    text: string,
    opts?: { images?: string[]; picker?: PickerState; keepDraft?: boolean }
  ): Promise<void> => {
    const imgs = opts?.images ?? images
    const pk = opts?.picker ?? picker
    if ((!text.trim() && imgs.length === 0) || busy) return
    // /clear is a client command — reset the conversation instead of calling the engine
    if (text.trim() === '/clear') {
      clearConversation()
      return
    }
    // 명령 카드(/init·/compact·/review·/security-review) 추적 — 완료 시 요약 카드로
    const cmd = commandOf(text)
    stickRef.current = true
    begin(text, cmd, imgs)
    const title = cmd ? commandTitleOf(cmd) : text.trim().slice(0, 80) || '이미지 첨부'
    setChats((list) =>
      list.map((c) => (c.id === activeChatId && !c.custom ? { ...c, title, custom: false } : c))
    )
    // 명령은 추가 노트 없이; 일반 프롬프트엔 멘션/첨부 노트를 붙여 엔진이 확실히 읽게 한다
    let promptForEngine = text
    if (!cmd) {
      const notes: string[] = []
      const mentions = extractMentions(text)
      if (mentions.length)
        notes.push(`[멘션된 파일 — 필요하면 Read 도구로 확인하세요]\n${mentions.map((p) => '- ' + p).join('\n')}`)
      if (imgs.length)
        notes.push(`[첨부 이미지 — Read 도구로 확인하세요]\n${imgs.map((p) => '- ' + p).join('\n')}`)
      if (notes.length) promptForEngine = `${text}\n\n${notes.join('\n\n')}`
    }
    const req: RunRequest = {
      prompt: promptForEngine,
      model: pk.model,
      effort: pk.effort,
      mode: pk.mode,
      // 작업 폴더 없음 — 엔진이 빈 cwd를 홈 폴더로 폴백한다 (folder는 늘 동일하므로 resume도 안전)
      cwd: '',
      systemPrompt: CHAT_SYSTEM_PROMPT,
      resume: state.session?.sessionId,
      // 전역 과금 모드 — API를 골랐으면 이 실행도 API 키로 과금
      useApi: apiMode || undefined
    }
    if (!opts?.keepDraft) {
      setInput('')
      setImages([])
    }
    window.api.talk.run(req).catch(() => {})
  }

  // queue the current draft (while busy) to auto-send when the run ends
  const scheduleMessage = (): void => {
    if (!busy || (!input.trim() && images.length === 0)) return
    const id = crypto.randomUUID ? crypto.randomUUID() : `q-${Date.now()}-${queue.length}`
    setQueue((q) => [...q, { id, text: input, images, picker }])
    setInput('')
    setImages([])
    composerRef.current?.focus()
  }

  // drain the queue one message at a time on each busy→idle transition (the `was` guard
  // prevents a double-send: dequeuing re-runs this effect before the next run's busy flips on)
  const prevBusyRef = useRef(busy)
  useEffect(() => {
    const was = prevBusyRef.current
    prevBusyRef.current = busy
    if (busy || !was || queue.length === 0) return
    const next = queue[0]
    setQueue((q) => q.slice(1))
    void runPrompt(next.text, { images: next.images, picker: next.picker, keepDraft: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queue])

  // "더 자세히" — wrap the highlighted passage in a <selection> tag and drop it in the composer
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

  const onPermission = (behavior: 'allow' | 'allow_always' | 'deny'): void => {
    if (!state.pendingPermission) return
    window.api.talk.respondPermission({ requestId: state.pendingPermission.requestId, behavior }).catch(() => {})
    clearPermission()
  }
  const onAnswer = (answers: string[][]): void => {
    if (!state.pendingQuestion) return
    window.api.talk.respondQuestion({ requestId: state.pendingQuestion.requestId, answers }).catch(() => {})
    clearQuestion()
  }
  const onDismissQuestion = (): void => {
    if (!state.pendingQuestion) return
    window.api.talk.respondQuestion({ requestId: state.pendingQuestion.requestId, answers: null }).catch(() => {})
    clearQuestion()
  }

  const taskTitle = (activeChat?.title || '').slice(0, 40)
  const lastMsg = state.messages[state.messages.length - 1]
  const streamingAnswer = lastMsg?.kind === 'msg' && lastMsg.role === 'assistant' && !lastMsg.error
  const showWorking = (state.thinkingText != null || !streamingAnswer) && !state.pendingQuestion && !state.pendingCommand

  // only chats with real content show in the recent list (blank chats hidden). memoized so
  // it keeps a stable reference across keystrokes → memoized Sidebar skips re-render
  const chatSummaries = useMemo(
    () =>
      chats
        .filter((c) => (c.id === activeChatId ? state.messages.length > 0 : c.snapshot.messages.length > 0) || c.title !== '')
        .map((c) => ({
          id: c.id,
          title: c.title,
          status: c.id === activeChatId ? state.status : c.snapshot.status
        })),
    [chats, activeChatId, state.messages.length, state.status]
  )

  const onNewChat = useEvent(createChat)
  const onSelectChat = useEvent(selectChat)
  const onRenameChat = useEvent(renameChat)
  const onDeleteChat = useEvent(deleteChat)

  return (
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
        onOpenSettings={onOpenSettings}
        mode={mode}
        onModeChange={onModeChange}
      />

      {/* chat--talk: 순수 채팅 모드는 탐색기/에이전트 패널이 없어 칼럼이 끝까지 넓어진다.
          이 스코프에서만 본문·컴포저 폭을 키워 양옆 여백을 줄인다(에이전트 모드의 760px
          고정 컴포저는 그대로 둔다) */}
      <div className="chat chat--talk">
        <ChatHeader title={taskTitle} />
        <ZoomBadge pct={chatZoom.pct} show={chatZoom.flash} />
        <div className="chat-scroll scroll" ref={chatScrollRef}>
          {state.messages.length === 0 && !busy ? (
            <WelcomeState
              variant="chat"
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
                    onOpenFile={setOpenWorkFile}
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
        <WorkBar
          status={state.status}
          todos={state.todos}
          files={state.files}
          subagents={state.subagents}
          usage={liveUsage}
          contextTokens={state.result?.contextTokens ?? null}
          contextWindow={state.result?.contextWindow ?? null}
          model={picker.model}
          apiMode={apiMode}
          chatSpentUsd={state.spentUsd ?? 0}
          budgetUsd={budgetUsd}
          totalSpentUsd={totalSpentUsd}
          onOpenFile={(f) => setOpenWorkFile(f.path)}
          onOpenSubagent={(a) => setOpenSubagentId(a.id)}
        />
        <Composer
          value={input}
          onChange={setInput}
          history={sentHistory}
          onSend={() => runPrompt(input)}
          onStop={() => {
            window.api.talk.cancel().catch(() => {})
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
          apiReady={apiReady}
          onApiModeChange={onApiModeChange}
          chatSpentUsd={state.spentUsd ?? 0}
          budgetUsd={budgetUsd}
          totalSpentUsd={totalSpentUsd}
          images={images}
          onPickImages={addImagesFromPicker}
          onAddImagePaths={addImagePaths}
          onRemoveImage={(i) => setImages((a) => a.filter((_, idx) => idx !== i))}
          onOpenImage={openViewer}
          contextTokens={state.result?.contextTokens ?? null}
          contextWindow={state.result?.contextWindow ?? null}
          usage={liveUsage}
          showContext={false}
          cwd=""
          mentionBase=""
          inputRef={composerRef}
        />
      </div>

      <QuestionModal question={state.pendingQuestion} onAnswer={onAnswer} onDismiss={onDismissQuestion} />
      <PermissionModal permission={state.pendingPermission} onRespond={onPermission} />

      {/* 작업 바에서 연 변경 파일 뷰어 — cwd는 엔진이 실제로 쓴 폴더(세션 보고값) */}
      {openWorkFile && (
        <FileModal
          path={openWorkFile}
          cwd={state.session?.cwd ?? ''}
          diffs={state.diffs}
          onClose={() => setOpenWorkFile(null)}
        />
      )}
      <SubAgentModal agent={openSubagent} onClose={() => setOpenSubagentId(null)} />

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
