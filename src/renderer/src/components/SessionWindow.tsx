import { useEffect, useMemo, useRef, useState } from 'react'
import type { ApiConfigStatus, AppUser, RunRequest, UserProfile, UsageInfo } from '@shared/protocol'
import { getPref, setPref } from '../lib/prefs'
import { useAgentSession, initialSessionState, sameCwd, type SessionState } from '../store/session'
import { extractMentions } from '../lib/mentions'
import { IconMin, IconMax, IconRestore, IconClose, IconFolder } from './icons'
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
import { useZoom, ZoomBadge, mergeRefs } from './zoom'
import { MouseGestureLayer, scrollGestures, sessionWindowGesture } from './mouseGesture'

// ── 추가 채팅 (세션 창) ────────────────────────────────────────
// A standalone conversation in its OWN native OS window (freely resizable, movable to a
// second monitor), running on this window's own engine via the `session` channel — fully
// independent of the main window's code/chat/multi work.
//
// The chat body is the SAME as 채팅 모드: the real MessageView thread + the full Composer
// (model·effort·mode pickers, attachments, history). Only the empty state (center bolt)
// and the "추가 채팅" header are bespoke to this window.

const DEFAULT_PICKER: PickerState = { model: 'opus', effort: 'high', mode: 'auto' }
// 마지막에 고른 모델·effort·모드를 기억한다 → 새 창을 열면 그 값이 기본이 된다.
const PICKER_KEY = 'session.picker'
const MODEL_IDS = ['fable', 'opus', 'sonnet', 'haiku']
const EFFORT_IDS = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal']
const MODE_IDS = ['normal', 'plan', 'acceptEdits', 'auto', 'bypass']
// 저장값이 낡거나 손상됐을 수 있으니 필드마다 검증하고, 이상하면 기본값으로 채운다.
function sanitizePicker(p?: Partial<PickerState> | null): PickerState {
  return {
    model: p?.model && MODEL_IDS.includes(p.model) ? p.model : DEFAULT_PICKER.model,
    effort: p?.effort && EFFORT_IDS.includes(p.effort) ? p.effort : DEFAULT_PICKER.effort,
    mode: p?.mode && MODE_IDS.includes(p.mode) ? p.mode : DEFAULT_PICKER.mode,
    // 실행 계정(이메일) — 형태만 확인 (등록 목록 대조는 picker·엔진이 담당)
    account: typeof p?.account === 'string' && p.account ? p.account : undefined
  }
}
function loadPicker(): PickerState {
  try {
    const raw = localStorage.getItem(PICKER_KEY)
    if (raw) return sanitizePicker(JSON.parse(raw))
  } catch {
    /* 손상·미지원 → 기본값 */
  }
  return DEFAULT_PICKER
}
const FALLBACK_USER: AppUser = { name: '나', avatarText: '나', avatarColor: '#7c8cff' }
const EMPTY_USAGE: UsageInfo = { fiveHour: null, weekly: null, weeklyFable: null, extraCredit: null }
// same intent as 채팅 모드 — conversational, no tool-rummaging unless asked/attached
const CHAT_SYSTEM_PROMPT =
  '지금은 사용자와 자유롭게 이야기하는 채팅 모드입니다. 사용자가 파일/이미지를 첨부했거나 명시적으로 요청한 경우가 아니라면, 파일을 뒤지거나 도구를 실행하지 말고 대화로 답하세요. 친근하고 간결하게, 한국어로 답합니다.'

function userFromProfile(p: UserProfile): AppUser {
  const name = p.nickname.trim()
  return { name: name || '나', avatarText: (name.slice(0, 1) || '나').toUpperCase(), avatarColor: p.color }
}

// 이 창의 작업 폴더는 마지막에 고른 값을 기억한다(창을 다시 열어도 유지). 빈 값이면 엔진이
// 바탕화면으로 폴백하므로, '' = 바탕화면(기본)을 뜻한다.
const CWD_KEY = 'session.cwd'
// 폴더 경로에서 표시용 이름(마지막 구간)만 뽑는다. 빈 값이면 기본 라벨.
function folderLabel(cwd: string): string {
  if (!cwd) return '바탕화면'
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || cwd
}

export function SessionWindow(): React.ReactElement {
  const { state, busy, begin, clearPermission, clearQuestion, load } = useAgentSession((cb) =>
    window.api.session?.onEvent?.(cb) ?? (() => {})
  )
  const [max, setMax] = useState(false)
  // 이 창의 작업 폴더('' = 바탕화면 기본). 폴더를 지정하면 실행·@멘션·/ask가 모두 그 폴더 기준.
  const [cwd, setCwd] = useState('')
  const [user, setUser] = useState<AppUser>(FALLBACK_USER)
  const [input, setInput] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [queue, setQueue] = useState<ScheduledMsg[]>([])
  // 새 창은 마지막에 고른 모델·effort·모드로 시작한다(localStorage 복원, 손상 시 기본값)
  const [picker, setPicker] = useState<PickerState>(loadPicker)
  // 피커를 바꾸면 다음 새 창의 기본값이 되도록 저장한다
  const savePicker = (p: PickerState): void => {
    setPicker(p)
    try {
      localStorage.setItem(PICKER_KEY, JSON.stringify(p))
    } catch {
      /* localStorage 불가 — 이번 창에서만 유지 */
    }
  }
  const [usage, setUsage] = useState<UsageInfo>(EMPTY_USAGE)
  // 과금(구독/API) — 메인과 같은 전역 pref(api.mode)에서 시작한다. 이 창엔 설정 모달이
  // 없어서 키 없이 API를 고르면 IPC로 메인 창의 설정 → API 탭을 대신 연다. 키 존재/예산은
  // 창 포커스마다 다시 읽어 메인에서 방금 등록/삭제한 키를 따라잡는다.
  const [apiMode, setApiMode] = useState<boolean>(() => getPref<boolean>('api.mode', false))
  const [apiCfg, setApiCfg] = useState<ApiConfigStatus | null>(null)
  useEffect(() => {
    const refresh = (): void => {
      window.api.apiConfig
        .get()
        .then((s) => {
          setApiCfg(s)
          // 키가 사라졌으면 API 모드도 끈다 — 키 없는 API 모드는 실행이 실패한다 (메인과 동일 가드)
          if (!s.hasKey) {
            setApiMode((on) => {
              if (on) setPref('api.mode', false)
              return false
            })
          }
        })
        .catch(() => {})
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])
  const onApiModeChange = (next: boolean): void => {
    if (next && !apiCfg?.hasKey) {
      // ?. 가드: HMR로 렌더러만 갈린 구 preload엔 이 함수가 없을 수 있다 (App과 동일)
      window.api.openApiSettings?.().catch(() => {})
      return
    }
    setApiMode(next)
    setPref('api.mode', next)
  }
  const [viewer, setViewer] = useState<{ images: string[]; index: number } | null>(null)
  const [openWorkFile, setOpenWorkFile] = useState<string | null>(null)
  const [openSubagentId, setOpenSubagentId] = useState<string | null>(null)
  const openSubagent = openSubagentId ? state.subagents.find((a) => a.id === openSubagentId) ?? null : null
  const scrollRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  // Ctrl+휠 글자 크기 — 메인 채팅과 같은 'chat.zoom' 키를 공유해 한 번 정한 읽기
  // 크기가 이 창에도 그대로 적용된다 (휠 리스너용 콜백 ref를 스크롤 뷰포트에 합침)
  const chatZoom = useZoom('chat.zoom')
  // 마우스 제스처(↑/↓) 대상 — 스레드 엘리먼트를 state로 추적
  const [threadEl, setThreadEl] = useState<HTMLDivElement | null>(null)
  const swScrollRef = useMemo(() => mergeRefs(scrollRef, chatZoom.ref, setThreadEl), [chatZoom.ref])
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

  // 실행이 끝나면 API 누적 사용액을 다시 읽는다 — 작업 바의 남은 예산이 바로 맞아떨어지게
  useEffect(() => {
    if (state.status === 'done' || state.status === 'error') {
      window.api.apiConfig.get().then(setApiCfg).catch(() => {})
    }
  }, [state.status])

  // 작업 폴더 적용 — 값을 기억하고, 대화가 이미 시작됐다면 새 폴더로 새 대화를 연다. 세션 ID는
  // 폴더에 묶여 있어(메인 앱과 동일) 이어갈 수 없으므로, 스레드를 비워 보이는 대화와 엔진 세션을
  // 일치시킨다. 큐에 쌓인 예약 메시지도 이전 폴더의 것이라 함께 비운다.
  const applyFolder = (dir: string): void => {
    if (dir === cwd || sameCwd(dir, cwd)) return // 같은 폴더(형식만 다른 경우 포함) → 대화 유지
    if (started) {
      load(initialSessionState)
      setQueue([])
    }
    setCwd(dir)
    try {
      localStorage.setItem(CWD_KEY, dir)
    } catch {
      /* localStorage 불가 — 이번 창에서만 유지 */
    }
  }
  const pickFolder = async (): Promise<void> => {
    const dir = await window.api.pickDirectory()
    if (dir) applyFolder(dir)
  }
  const resetFolder = (): void => applyFolder('') // 바탕화면(기본)으로

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

  // 지난번에 고른 작업 폴더 복원 — 폴더가 지워졌을 수 있으니 존재를 확인하고, 없으면 바탕화면으로.
  useEffect(() => {
    let saved = ''
    try {
      saved = localStorage.getItem(CWD_KEY) || ''
    } catch {
      /* localStorage 불가 */
    }
    if (!saved) return
    window.api
      .dirExists(saved)
      .then((ok) => {
        if (ok) setCwd(saved)
        else {
          try {
            localStorage.removeItem(CWD_KEY)
          } catch {
            /* no-op */
          }
        }
      })
      .catch(() => {})
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
      cwd, // 지정한 작업 폴더. 빈 값이면 엔진이 바탕화면으로 폴백
      systemPrompt: CHAT_SYSTEM_PROMPT,
      resume: state.session?.sessionId,
      // 과금 모드 — API를 골랐으면 이 창의 실행도 API 키로 과금 (메인과 같은 전역 설정)
      useApi: apiMode || undefined,
      // 이 창의 실행 계정(구독) — 전역 활성 계정과 다르면 엔진이 격리 폴더로 돌린다
      account: pk.account
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
        {/* 작업 폴더 — 클릭하면 폴더 선택(취소하면 그대로). 지정하면 실행·@멘션·/ask가 그 폴더 기준.
            기본은 바탕화면이며, 폴더를 고르면 옆의 ×로 다시 바탕화면으로 되돌린다. */}
        <button
          className="sw-folder has-tip tip-path"
          data-tip={cwd ? `작업 폴더: ${cwd}` : '바탕화면 — 클릭해서 작업 폴더 지정'}
          onClick={pickFolder}
        >
          <IconFolder size={13} />
          <span className="sw-folder-name">{folderLabel(cwd)}</span>
        </button>
        {cwd && (
          <button className="sw-folder-reset has-tip" data-tip="바탕화면으로" aria-label="바탕화면으로" onClick={resetFolder}>
            <IconClose size={11} />
          </button>
        )}
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

      <ZoomBadge pct={chatZoom.pct} show={chatZoom.flash} />
      {/* ↑←는 여기서도 창을 하나 더 연다. →↑는 타이틀바 최대화 버튼과 같은 토글 — 라벨은
          현재 상태(max)를 따라 '최대화'/'이전 크기로'로 바뀐다. ↓→ 닫기는 × 버튼과 같은
          네이티브 close — 이 창의 대화는 창과 함께 사라지는 게 원래 규칙이라 확인 없이 닫는다. */}
      <MouseGestureLayer
        target={threadEl}
        actions={[
          ...scrollGestures(() => threadEl),
          sessionWindowGesture(),
          { pattern: 'RU', label: max ? '이전 크기로' : '창 최대화', run: () => window.api.win.toggleMaximize() },
          { pattern: 'DR', label: '창 닫기', run: () => window.api.win.close() }
        ]}
      />
      <div className="sw-scroll scroll" ref={swScrollRef}>
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
            {/* 작업 폴더를 미리 정해두면 파일을 다루는 대화가 그 폴더에서 열린다(기본은 바탕화면) */}
            <button className="sw-empty-folder" onClick={pickFolder}>
              <IconFolder size={14} />
              <span>작업 폴더: {folderLabel(cwd)}</span>
            </button>
          </div>
        ) : (
          <div className="sw-thread" style={{ zoom: chatZoom.zoom, '--z': chatZoom.zoom } as React.CSSProperties}>
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
        apiMode={apiMode}
        chatSpentUsd={state.spentUsd ?? 0}
        budgetUsd={apiCfg?.budgetUsd ?? null}
        totalSpentUsd={apiCfg?.spentUsd ?? 0}
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
        setPicker={savePicker}
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
        mentionBase={cwd}
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
          완전히 분리된다. 작업 폴더를 지정했으면 그 폴더 기준(없으면 엔진이 바탕화면으로 폴백). */}
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
