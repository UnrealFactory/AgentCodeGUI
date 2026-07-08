import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppUser, RunRequest, UserProfile, UsageInfo } from '@shared/protocol'
import { useAgentSession, initialSessionState, type SessionState } from '../store/session'
import { extractMentions } from '../lib/mentions'
import { IconMin, IconMax, IconRestore, IconClose } from './icons'
import {
  Composer,
  MessageView,
  WorkingIndicator,
  WorkBar,
  PermissionModal,
  QuestionModal,
  type PickerState,
  type ScheduledMsg
} from './Chat'
import { ImageViewer } from './ImageViewer'
import { SubAgentModal } from './AgentPanel'
import { FileModal } from './FileModal'
import { AskModal } from './AskModal'

// ── 추가 채팅 (세션 창) ────────────────────────────────────────
// A standalone conversation in its OWN native OS window (freely resizable, movable to a
// second monitor), running on this window's own engine via the `session` channel — fully
// independent of the main window's code/chat/multi work.
//
// The chat body is the SAME as 채팅 모드: the real MessageView thread + the full Composer
// (model·effort·mode pickers, attachments, history). Only the empty state (center bolt)
// and the "추가 채팅" header are bespoke to this window.

const DEFAULT_PICKER: PickerState = { model: 'opus', effort: 'high', mode: 'auto' }
const FALLBACK_USER: AppUser = { name: '나', avatarText: '나', avatarColor: '#7c8cff' }
const EMPTY_USAGE: UsageInfo = { fiveHour: null, weekly: null, weeklyFable: null, extraCredit: null }
// same intent as 채팅 모드 — conversational, no tool-rummaging unless asked/attached
const CHAT_SYSTEM_PROMPT =
  '지금은 사용자와 자유롭게 이야기하는 채팅 모드입니다. 사용자가 파일/이미지를 첨부했거나 명시적으로 요청한 경우가 아니라면, 파일을 뒤지거나 도구를 실행하지 말고 대화로 답하세요. 친근하고 간결하게, 한국어로 답합니다.'

function userFromProfile(p: UserProfile): AppUser {
  const name = p.nickname.trim()
  return { name: name || '나', avatarText: (name.slice(0, 1) || '나').toUpperCase(), avatarColor: p.color }
}

export function SessionWindow(): React.ReactElement {
  const { state, busy, begin, clearPermission, clearQuestion, load } = useAgentSession((cb) =>
    window.api.session?.onEvent?.(cb) ?? (() => {})
  )
  const [max, setMax] = useState(false)
  const [user, setUser] = useState<AppUser>(FALLBACK_USER)
  const [input, setInput] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [queue, setQueue] = useState<ScheduledMsg[]>([])
  const [picker, setPicker] = useState<PickerState>(DEFAULT_PICKER)
  const [usage, setUsage] = useState<UsageInfo>(EMPTY_USAGE)
  const [viewer, setViewer] = useState<{ images: string[]; index: number } | null>(null)
  const [openWorkFile, setOpenWorkFile] = useState<string | null>(null)
  const [openSubagentId, setOpenSubagentId] = useState<string | null>(null)
  const openSubagent = openSubagentId ? state.subagents.find((a) => a.id === openSubagentId) ?? null : null
  const scrollRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  // "/ask" — 이 창 전용 일회용 질문 모달(sessionAsk 채널, 본 대화 엔진과 분리). 메인 창과
  // 동일한 UX: "/ask <질문>"은 모달 컴포저를 미리 채우고, 닫으면(언마운트) 대화가 사라진다.
  const [askOpen, setAskOpen] = useState(false)
  const [askInitial, setAskInitial] = useState('')
  const [askMinimized, setAskMinimized] = useState(false)
  const askOpenRef = useRef(askOpen)
  askOpenRef.current = askOpen
  const askMinimizedRef = useRef(askMinimized)
  askMinimizedRef.current = askMinimized
  const openAsk = (initial: string): void => {
    setAskInitial(initial)
    setAskMinimized(false)
    setAskOpen(true)
  }

  const started = state.messages.length > 0
  const onRefreshUsage = (): void => {
    window.api.getUsage(true).then(setUsage).catch(() => {})
  }

  // 내가 보낸 메시지(오래된→최신) — 작성칸에서 ↑/↓로 다시 불러오기 (채팅과 동일)
  const sentHistory = useMemo(
    () =>
      state.messages
        .filter((m): m is Extract<SessionState['messages'][number], { kind: 'msg' }> => m.kind === 'msg' && m.role === 'user')
        .map((m) => m.text)
        .filter((t) => t.trim().length > 0),
    [state.messages]
  )

  // avatar/name from the shared saved profile; usage for the composer strip
  useEffect(() => {
    window.api.getProfile().then((p) => p && setUser(userFromProfile(p))).catch(() => {})
    window.api.getUsage().then(setUsage).catch(() => {})
  }, [])

  useEffect(() => {
    requestAnimationFrame(() => composerRef.current?.focus())
  }, [])

  // our custom title bar's maximize icon — reflects THIS window's native maximize state
  useEffect(() => window.api.onWinState((s) => setMax(s.maximized)), [])
  useEffect(() => {
    window.api.win.isMaximized().then(setMax)
  }, [])

  // Enter (from anywhere outside a field) jumps into the composer — same as the main app,
  // so you can read the thread and just start typing. A permission/question card owns the
  // keyboard while up, so stand down then.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      if (e.key !== 'Enter') return
      if (document.querySelector('.q-overlay, .pr-overlay')) return
      // /ask 모달이 펼쳐져 있으면 Enter는 그 모달의 컴포저 몫 (메인 창과 동일)
      if (askOpenRef.current && !askMinimizedRef.current) return
      const ae = document.activeElement as HTMLElement | null
      const interactive =
        !!ae && (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(ae.tagName) || ae.isContentEditable)
      if (!interactive) {
        e.preventDefault()
        composerRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // pin the thread to the newest message / working line as it streams
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [state.messages, state.thinkingText, busy])

  // ── attachments (same as 채팅) ───────────────────────────────
  const addImagePaths = (paths: string[]): void => {
    if (paths.length) setImages((prev) => Array.from(new Set([...prev, ...paths])))
  }
  const addImagesFromPicker = async (): Promise<void> => {
    addImagePaths(await window.api.pickAttachments())
  }
  const openViewer = (imgs: string[], index: number): void => setViewer({ images: imgs, index })

  const runPrompt = (text: string, opts?: { images?: string[]; picker?: PickerState; keepDraft?: boolean }): void => {
    const imgs = opts?.images ?? images
    const pk = opts?.picker ?? picker
    if ((!text.trim() && imgs.length === 0) || busy) return
    // /clear — reset this window's conversation (client command, same as 채팅/코드)
    if (text.trim() === '/clear') {
      load(initialSessionState)
      setInput('')
      setImages([])
      setQueue([])
      return
    }
    // /ask — 이 창 전용 일회용 질문 모달(자체 엔진). 본 대화로는 보내지 않는다 (메인 창과 동일)
    const trimmed = text.trim()
    if (trimmed === '/ask' || trimmed.startsWith('/ask ')) {
      openAsk(trimmed.slice(4).trim())
      if (!opts?.keepDraft) setInput('')
      return
    }
    begin(text, null, imgs)
    // fold mention/attachment notes into the prompt so the engine reads them (same as 채팅)
    let promptForEngine = text
    const notes: string[] = []
    const mentions = extractMentions(text)
    if (mentions.length) notes.push(`[멘션된 파일 — 필요하면 Read 도구로 확인하세요]\n${mentions.map((p) => '- ' + p).join('\n')}`)
    if (imgs.length) notes.push(`[첨부 파일 — Read 도구로 확인하세요]\n${imgs.map((p) => '- ' + p).join('\n')}`)
    if (notes.length) promptForEngine = `${text}\n\n${notes.join('\n\n')}`
    const req: RunRequest = {
      prompt: promptForEngine,
      model: pk.model,
      effort: pk.effort,
      mode: pk.mode,
      cwd: '', // no folder — the engine falls back to the Desktop
      systemPrompt: CHAT_SYSTEM_PROMPT,
      resume: state.session?.sessionId
    }
    if (!opts?.keepDraft) {
      setInput('')
      setImages([])
    }
    window.api.session?.run(req).catch(() => {})
  }

  // queue a draft while busy → auto-send when the run ends (same as 채팅)
  const scheduleMessage = (): void => {
    if (!busy || (!input.trim() && images.length === 0)) return
    // /ask는 본 대화와 분리된 자체 엔진 모달 — 실행 중에도 예약 없이 즉시 연다 (메인 창과 동일)
    const t = input.trim()
    if (t === '/ask' || t.startsWith('/ask ')) {
      openAsk(t.slice(4).trim())
      setInput('')
      composerRef.current?.focus()
      return
    }
    const id = crypto.randomUUID ? crypto.randomUUID() : `q-${queue.length}-${state.messages.length}`
    setQueue((q) => [...q, { id, text: input, images, picker }])
    setInput('')
    setImages([])
    composerRef.current?.focus()
  }
  const prevBusyRef = useRef(busy)
  useEffect(() => {
    const was = prevBusyRef.current
    prevBusyRef.current = busy
    if (busy || !was || queue.length === 0) return
    const next = queue[0]
    setQueue((q) => q.slice(1))
    runPrompt(next.text, { images: next.images, picker: next.picker, keepDraft: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queue])

  const onPermission = (behavior: 'allow' | 'allow_always' | 'deny'): void => {
    if (!state.pendingPermission) return
    window.api.session?.respondPermission({ requestId: state.pendingPermission.requestId, behavior }).catch(() => {})
    clearPermission()
  }
  const onAnswer = (answers: string[][]): void => {
    if (!state.pendingQuestion) return
    window.api.session?.respondQuestion({ requestId: state.pendingQuestion.requestId, answers }).catch(() => {})
    clearQuestion()
  }
  const onDismissQuestion = (): void => {
    if (!state.pendingQuestion) return
    window.api.session?.respondQuestion({ requestId: state.pendingQuestion.requestId, answers: null }).catch(() => {})
    clearQuestion()
  }

  const lastMsg = state.messages[state.messages.length - 1]
  const streamingAnswer = lastMsg?.kind === 'msg' && lastMsg.role === 'assistant' && !lastMsg.error
  const showWorking = (state.thinkingText != null || !streamingAnswer) && !state.pendingQuestion

  return (
    <div className="sw">
      {/* 우리 앱과 동일한 커스텀 타이틀바(.titlebar 재사용) — 네이티브 바 대신 "추가 채팅".
          창 전체는 -webkit-app-region:drag로 끌 수 있고, 버튼만 no-drag. 창 컨트롤은
          메인 프로세스에서 호출 창(webContents) 기준으로 이 창을 제어한다. */}
      <div className="titlebar sw-titlebar">
        <span className="tb-page">추가 채팅</span>
        <div className="tb-spacer" />
        <div className="tb-controls">
          <button className="tb-btn" aria-label="최소화" data-tip="최소화" onClick={() => window.api.win.minimize()}>
            <IconMin size={15} />
          </button>
          <button
            className="tb-btn"
            aria-label={max ? '이전 크기로' : '최대화'}
            data-tip={max ? '이전 크기로' : '최대화'}
            onClick={() => window.api.win.toggleMaximize()}
          >
            {max ? <IconRestore size={14} /> : <IconMax size={13} />}
          </button>
          <button className="tb-btn close" aria-label="닫기" data-tip="닫기" onClick={() => window.api.win.close()}>
            <IconClose size={15} />
          </button>
        </div>
      </div>

      <div className="sw-scroll scroll" ref={scrollRef}>
        {!started && !busy ? (
          <div className="sw-empty">
            <div className="sw-empty-orb">
              <BoltGlyph big />
            </div>
            <h2>무엇이든 편하게 물어보세요</h2>
            <p>
              지금 하는 코드 작업은 그대로 두고, 이 창에서 따로 대화하세요.
              <br />크기 조절·다른 모니터로 옮기기 모두 자유예요.
            </p>
          </div>
        ) : (
          <div className="sw-thread">
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
                  onOpenImage={openViewer}
                />
              )
            })}
            {busy && showWorking && <WorkingIndicator text={state.thinkingText} />}
          </div>
        )}
      </div>

      <WorkBar
        todos={state.todos}
        files={state.files}
        subagents={state.subagents}
        usage={usage}
        contextTokens={state.result?.contextTokens ?? null}
        contextWindow={state.result?.contextWindow ?? null}
        model={picker.model}
        apiMode={false}
        chatSpentUsd={state.spentUsd ?? 0}
        budgetUsd={null}
        totalSpentUsd={0}
        onOpenFile={(f) => setOpenWorkFile(f.path)}
        onOpenSubagent={(a) => setOpenSubagentId(a.id)}
        onRefreshUsage={onRefreshUsage}
      />
      <Composer
        value={input}
        onChange={setInput}
        history={sentHistory}
        onSend={() => runPrompt(input)}
        onStop={() => {
          window.api.session?.cancel().catch(() => {})
          setQueue([])
        }}
        onSchedule={scheduleMessage}
        queued={queue}
        onRemoveQueued={(id) => setQueue((q) => q.filter((m) => m.id !== id))}
        busy={busy}
        started={started}
        picker={picker}
        setPicker={setPicker}
        images={images}
        onPickImages={addImagesFromPicker}
        onAddImagePaths={addImagePaths}
        onRemoveImage={(i) => setImages((a) => a.filter((_, idx) => idx !== i))}
        onOpenImage={openViewer}
        contextTokens={state.result?.contextTokens ?? null}
        contextWindow={state.result?.contextWindow ?? null}
        usage={usage}
        showContext={false}
        cwd=""
        mentionBase=""
        inputRef={composerRef}
      />

      <PermissionModal permission={state.pendingPermission} onRespond={onPermission} />
      <QuestionModal question={state.pendingQuestion} onAnswer={onAnswer} onDismiss={onDismissQuestion} />

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

      {/* /ask — 이 창 전용 일회용 질문 모달. sessionAsk 채널이라 이 창의 본 대화·다른 창과
          완전히 분리된다. 세션 창엔 폴더가 없으므로 cwd는 빈 값(엔진이 홈으로 폴백). */}
      {askOpen && (
        <AskModal
          onClose={() => {
            setAskOpen(false)
            setAskMinimized(false)
          }}
          minimized={askMinimized}
          onMinimizedChange={setAskMinimized}
          cwd=""
          user={user}
          picker={picker}
          initialText={askInitial}
          channel={window.api.sessionAsk}
        />
      )}
    </div>
  )
}

function BoltGlyph({ big }: { big?: boolean }): React.ReactElement {
  const s = big ? 26 : 15
  return (
    <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12z" />
    </svg>
  )
}
