import { useEffect, useRef, useState } from 'react'
import type { AppUser, RunRequest } from '@shared/protocol'
import type { WindowApi } from '@shared/api'
import { useAgentSession, sameCwd } from '../store/session'
import { MessageView, WorkingIndicator, PermissionModal, QuestionModal, RunPickers, type PickerState } from './Chat'
import { FileBadge } from './fileType'
import { imageSrc, imageName, isImagePath, isAttachablePath, filesToAttachmentPaths } from '../lib/images'
import { IconChevDown, IconClose, IconPaperclip, IconSend, IconX2 } from './icons'

// "/ask" — a throwaway, one-shot conversation that lives entirely apart from the work
// chat. It runs on its OWN engine instance (window.api.ask.*), so it never cancels the
// main run or leaks into the work thread. The whole thing is ephemeral: this component
// only mounts while the modal is open, so closing it (unmount) discards the session —
// nothing is ever persisted.
export function AskModal({
  onClose,
  cwd,
  user,
  picker,
  initialText,
  minimized,
  onMinimizedChange,
  apiMode = false,
  apiReady = false,
  onApiModeChange,
  channel = window.api.ask
}: {
  onClose: () => void
  cwd: string
  user: AppUser
  picker: PickerState
  initialText?: string
  // minimized state lives in App so re-running "/ask" while down keeps it down
  minimized: boolean
  onMinimizedChange: (v: boolean) => void
  apiMode?: boolean // 전역 과금 모드 (구독/API) — /ask 실행에도 그대로 적용
  apiReady?: boolean
  // 없으면 과금 picker를 숨긴다(RunPickers 규칙) — API 모드 배관이 없는 세션 창용
  onApiModeChange?: (next: boolean) => void
  // ask 엔진 채널 — 기본은 메인 창의 전역 /ask, 세션 창은 자기 창 전용 sessionAsk를 넣는다
  channel?: WindowApi['ask']
}) {
  // a second, isolated agent session driven by the /ask engine channel
  const { state, busy, begin, clearPermission, clearQuestion } = useAgentSession((cb) =>
    channel?.onEvent?.(cb) ?? (() => {})
  )
  const [input, setInput] = useState(initialText ?? '')
  // 첨부(이미지·텍스트 파일) — 메인 컴포저와 동일하게 경로 노트로 엔진에 전달돼 Read 도구가
  // 읽는다. /ask는 일회용이라 전송하면 함께 비운다(모달을 닫으면 그대로 사라진다).
  const [images, setImages] = useState<string[]>([])
  // /ask 자체의 실행 설정 — 열릴 때 메인 컴포저의 선택을 이어받고, 여기서 바꾸면 이 질문
  // 세션에만 적용된다(메인 대화의 picker는 건드리지 않는다). 모달이 닫히면 함께 사라진다.
  const [pk, setPk] = useState<PickerState>(picker)
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // dragenter/leave가 자식마다 튀어 플래그가 깜빡이므로 깊이 카운터로 센다(메인 컴포저와 동일)
  const dragDepth = useRef(0)
  const [dragOver, setDragOver] = useState(false)

  // 새 경로를 기존 첨부에 중복 없이 이어 붙인다
  const addPaths = (paths: string[]): void => {
    if (paths.length) setImages((prev) => Array.from(new Set([...prev, ...paths])))
  }
  const addFromPicker = async (): Promise<void> => {
    addPaths(await window.api.pickAttachments())
  }
  const removeImage = (i: number): void => setImages((prev) => prev.filter((_, j) => j !== i))

  // 드롭·붙여넣기 — 이미지와 읽을 수 있는 텍스트 파일을 첨부로 받는다(메인 컴포저와 동일)
  const onDrop = async (e: React.DragEvent): Promise<void> => {
    dragDepth.current = 0
    setDragOver(false)
    if (!e.dataTransfer.files?.length) return
    e.preventDefault()
    addPaths(await filesToAttachmentPaths(e.dataTransfer.files))
  }
  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>): Promise<void> => {
    const files = Array.from(e.clipboardData.files || []).filter(
      (f) => f.type.startsWith('image/') || isAttachablePath(f.name)
    )
    if (!files.length) return
    e.preventDefault()
    addPaths(await filesToAttachmentPaths(files))
  }
  const dragHasFile = (e: React.DragEvent): boolean =>
    Array.from(e.dataTransfer.items || []).some((it) => it.kind === 'file')

  const started = state.messages.length > 0

  // focus the composer whenever the modal is visible (open / restored from the pill)
  useEffect(() => {
    if (!minimized) requestAnimationFrame(() => taRef.current?.focus())
  }, [minimized])

  // keep the thread pinned to the latest message / working indicator
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [state.messages, state.thinkingText, busy])

  // Keyboard:
  //  · Esc (open)      → minimize (don't lose the conversation)
  //  · Esc (minimized) → close — so Esc·Esc in a row dismisses it
  //  · Enter (open, focus drifted out of a field) → pull focus back to THIS composer
  //  · Enter (minimized) → we do nothing, so it falls through to the main chat composer
  // A permission / question card owns the keyboard while it's up, so we stand down.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (state.pendingPermission || state.pendingQuestion) return
      if (e.key === 'Escape') {
        e.preventDefault()
        if (minimized) close()
        else onMinimizedChange(true)
        return
      }
      if (!minimized && e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const ae = document.activeElement as HTMLElement | null
        const interactive =
          !!ae && (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(ae.tagName) || ae.isContentEditable)
        if (!interactive) {
          e.preventDefault()
          taRef.current?.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minimized, state.pendingPermission, state.pendingQuestion])

  const grow = (el: HTMLTextAreaElement | null): void => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 140) + 'px'
  }

  const send = (): void => {
    const text = input.trim()
    // 첨부만 있고 글이 없어도 보낼 수 있다(메인 컴포저와 동일)
    if ((!text && images.length === 0) || busy) return
    begin(text, null, images)
    // 첨부 경로를 프롬프트 노트로 접어 넣는다 — 엔진이 Read 도구로 읽는다(메인 컴포저와 동일)
    const promptForEngine = images.length
      ? `${text}\n\n[첨부 파일 — Read 도구로 확인하세요]\n${images.map((p) => '- ' + p).join('\n')}`.trim()
      : text
    const req: RunRequest = {
      prompt: promptForEngine,
      model: pk.model,
      effort: pk.effort,
      mode: pk.mode,
      // empty cwd → the engine falls back to the home dir, so a general question still works
      cwd,
      // continue THIS ask's own session so follow-ups keep context (separate from the main
      // chat) — but only while still in the same folder (a session id is scoped to its
      // project, so resuming it after a folder change errors "No conversation found")
      resume: state.session && sameCwd(state.session.cwd, cwd) ? state.session.sessionId : undefined,
      // 전역 과금 모드 — API를 골랐으면 /ask 실행도 API 키로 과금
      useApi: apiMode || undefined
    }
    setInput('')
    setImages([])
    requestAnimationFrame(() => grow(taRef.current))
    channel?.run(req).catch(() => {})
  }

  const close = (): void => {
    channel?.cancel().catch(() => {})
    onClose()
  }

  const onPermission = (behavior: 'allow' | 'allow_always' | 'deny'): void => {
    if (!state.pendingPermission) return
    channel?.respondPermission({ requestId: state.pendingPermission.requestId, behavior }).catch(() => {})
    clearPermission()
  }
  const onAnswer = (answers: string[][]): void => {
    if (!state.pendingQuestion) return
    channel?.respondQuestion({ requestId: state.pendingQuestion.requestId, answers }).catch(() => {})
    clearQuestion()
  }
  const onDismissQuestion = (): void => {
    if (!state.pendingQuestion) return
    channel?.respondQuestion({ requestId: state.pendingQuestion.requestId, answers: null }).catch(() => {})
    clearQuestion()
  }

  // working indicator: same rule as the main chat — hide it while the answer streams
  const lastMsg = state.messages[state.messages.length - 1]
  const streamingAnswer = lastMsg?.kind === 'msg' && lastMsg.role === 'assistant' && !lastMsg.error
  const showWorking = (state.thinkingText != null || !streamingAnswer) && !state.pendingQuestion

  return (
    <>
      {minimized ? (
        // minimized: drop to a corner pill so the work chat behind is visible, then
        // click to expand again ("잠깐 내려서 뭐 물어봤지 보기")
        <div className="ask-mini" onClick={() => onMinimizedChange(false)}>
          <div className="mini-orb">
            <BoltGlyph />
            {busy && <span className="live" />}
          </div>
          <div className="mini-text">
            <div className="mini-title">
              빠른 질문
              <span className="ask-eph mini-eph">
                <span className="dot" />
                휘발성
              </span>
            </div>
            <div className="mini-sub">{busy ? '답변을 생각하는 중…' : started ? '대화 진행 중 · 닫으면 사라져요' : '아직 질문 전이에요'}</div>
          </div>
          <span className="mini-spacer" />
          <button className="mini-btn has-tip" data-tip="펼치기" aria-label="펼치기" onClick={() => onMinimizedChange(false)}>
            <RestoreGlyph />
          </button>
          <button
            className="mini-btn close has-tip"
            data-tip="닫기"
            aria-label="닫기"
            onClick={(e) => {
              e.stopPropagation()
              close()
            }}
          >
            <IconClose size={16} />
          </button>
        </div>
      ) : (
        <div className="ask-overlay">
          <div className="ask-modal" onMouseDown={(e) => e.stopPropagation()}>
            {/* header */}
            <div className="ask-head">
              <div className="ask-orb">
                <BoltGlyph />
              </div>
              <div className="ask-titles">
                <div className="ask-title">
                  빠른 질문 <span className="ask-cmd">/ask</span>
                </div>
                <div className="ask-sub">본 작업 대화와 분리된 일회용 질문이에요</div>
              </div>
              <span className="ask-spacer" />
              <span className="ask-eph">
                <span className="dot" />
                휘발성
              </span>
              <button className="ask-min has-tip" data-tip="최소화 (Esc)" aria-label="최소화" onClick={() => onMinimizedChange(true)}>
                <IconChevDown size={18} />
              </button>
              <button className="ask-close has-tip" data-tip="닫기" aria-label="닫기" onClick={close}>
                <IconClose size={17} />
              </button>
            </div>

            {/* body */}
            <div className="ask-body scroll" ref={scrollRef}>
              {!started ? (
                <div className="ask-empty">
                  <div className="ask-empty-orb">
                    <QuestionGlyph />
                  </div>
                  <h2>무엇이든 편하게 물어보세요</h2>
                  <p>
                    지금 보고 있는 코드나 개념을 가볍게 질문해 보세요.
                    <br />이 대화는 작업 기록에 남지 않고, 창을 닫으면 사라져요.
                  </p>
                </div>
              ) : (
                <div className="ask-thread">
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
                      />
                    )
                  })}
                  {busy && showWorking && <WorkingIndicator text={state.thinkingText} />}
                </div>
              )}
            </div>

            {/* composer */}
            <div className="ask-foot">
              {/* 이 질문 세션만의 모델·강도·모드 — 메인 컴포저와 동일한 컨트롤(RunPickers) */}
              <div className="ask-pickers">
                <RunPickers picker={pk} setPicker={setPk} apiMode={apiMode} apiReady={apiReady} onApiModeChange={onApiModeChange} />
              </div>
              {/* 첨부 트레이 — 컴포저 위. 이미지는 썸네일, 텍스트/문서는 파일명 칩(메인 컴포저와 동일) */}
              {images.length > 0 && (
                <div className="img-tray ask-tray">
                  {images.map((p, i) =>
                    isImagePath(p) ? (
                      <div className="img-thumb has-tip" data-tip={imageName(p)} key={p + i}>
                        <span className="img-thumb-open">
                          <img src={imageSrc(p)} alt={imageName(p)} draggable={false} />
                        </span>
                        <button className="img-thumb-x has-tip" onClick={() => removeImage(i)} aria-label="제거" data-tip="제거">
                          <IconX2 size={11} />
                        </button>
                      </div>
                    ) : (
                      <div className="img-thumb doc has-tip tip-path" data-tip={p} key={p + i}>
                        <span className="img-thumb-open">
                          <FileBadge path={p} size={15} />
                          <span className="doc-name">{imageName(p)}</span>
                        </span>
                        <button className="img-thumb-x has-tip" onClick={() => removeImage(i)} aria-label="제거" data-tip="제거">
                          <IconX2 size={11} />
                        </button>
                      </div>
                    )
                  )}
                </div>
              )}
              <div
                className={'ask-composer' + (busy ? ' busy' : '') + (dragOver ? ' drag' : '')}
                onDragEnter={(e) => {
                  if (!dragHasFile(e)) return
                  dragDepth.current += 1
                  setDragOver(true)
                }}
                onDragOver={(e) => {
                  if (dragHasFile(e)) e.preventDefault()
                }}
                onDragLeave={() => {
                  dragDepth.current = Math.max(0, dragDepth.current - 1)
                  if (dragDepth.current === 0) setDragOver(false)
                }}
                onDrop={onDrop}
              >
                <button
                  className="ask-attach has-tip"
                  data-tip="파일 첨부 (이미지·텍스트)"
                  aria-label="파일 첨부"
                  onClick={addFromPicker}
                  disabled={busy}
                >
                  <IconPaperclip size={17} />
                </button>
                <textarea
                  ref={taRef}
                  rows={1}
                  placeholder="궁금한 걸 물어보세요…"
                  value={input}
                  disabled={busy}
                  onChange={(e) => {
                    setInput(e.target.value)
                    grow(e.target)
                  }}
                  onPaste={onPaste}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      send()
                    }
                  }}
                />
                <button
                  className="ask-send has-tip"
                  data-tip="보내기 (Enter)"
                  aria-label="보내기"
                  onClick={send}
                  disabled={busy || (!input.trim() && images.length === 0)}
                >
                  <IconSend size={17} />
                </button>
              </div>
            </div>

            {/* ephemeral reminder */}
            <div className="ask-note">
              <TrashGlyph />
              창을 닫으면 이 대화는 저장되지 않고 즉시 사라집니다
            </div>
          </div>
        </div>
      )}

      {/* sub-prompts from the /ask agent — rendered at top level so they surface even
          when minimized, and resolve on the /ask channel (not the main engine) */}
      <PermissionModal permission={state.pendingPermission} onRespond={onPermission} />
      <QuestionModal question={state.pendingQuestion} onAnswer={onAnswer} onDismiss={onDismissQuestion} />
    </>
  )
}

// ── inline glyphs (no matching shared icon) ──────────────────────────────────
function BoltGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12z" />
    </svg>
  )
}
function QuestionGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.1 9a3 3 0 1 1 5.8 1c0 2-3 2.5-3 4.5" />
      <circle cx="12" cy="18.5" r="0.6" fill="currentColor" />
    </svg>
  )
}
function RestoreGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 17 17 7M9 7h8v8" />
    </svg>
  )
}
function TrashGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
    </svg>
  )
}
