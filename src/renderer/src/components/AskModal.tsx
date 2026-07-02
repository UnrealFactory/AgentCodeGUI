import { useEffect, useRef, useState } from 'react'
import type { AppUser, RunRequest } from '@shared/protocol'
import { useAgentSession, sameCwd } from '../store/session'
import { MessageView, WorkingIndicator, PermissionModal, QuestionModal, RunPickers, type PickerState } from './Chat'
import { IconChevDown, IconClose, IconSend } from './icons'

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
  onMinimizedChange
}: {
  onClose: () => void
  cwd: string
  user: AppUser
  picker: PickerState
  initialText?: string
  // minimized state lives in App so re-running "/ask" while down keeps it down
  minimized: boolean
  onMinimizedChange: (v: boolean) => void
}) {
  // a second, isolated agent session driven by the /ask engine channel
  const { state, busy, begin, clearPermission, clearQuestion } = useAgentSession((cb) =>
    window.api.ask?.onEvent?.(cb) ?? (() => {})
  )
  const [input, setInput] = useState(initialText ?? '')
  // /ask 자체의 실행 설정 — 열릴 때 메인 컴포저의 선택을 이어받고, 여기서 바꾸면 이 질문
  // 세션에만 적용된다(메인 대화의 picker는 건드리지 않는다). 모달이 닫히면 함께 사라진다.
  const [pk, setPk] = useState<PickerState>(picker)
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

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
    if (!text || busy) return
    begin(text)
    const req: RunRequest = {
      prompt: text,
      model: pk.model,
      effort: pk.effort,
      mode: pk.mode,
      // empty cwd → the engine falls back to the home dir, so a general question still works
      cwd,
      // continue THIS ask's own session so follow-ups keep context (separate from the main
      // chat) — but only while still in the same folder (a session id is scoped to its
      // project, so resuming it after a folder change errors "No conversation found")
      resume: state.session && sameCwd(state.session.cwd, cwd) ? state.session.sessionId : undefined
    }
    setInput('')
    requestAnimationFrame(() => grow(taRef.current))
    window.api.ask?.run(req).catch(() => {})
  }

  const close = (): void => {
    window.api.ask?.cancel().catch(() => {})
    onClose()
  }

  const onPermission = (behavior: 'allow' | 'allow_always' | 'deny'): void => {
    if (!state.pendingPermission) return
    window.api.ask?.respondPermission({ requestId: state.pendingPermission.requestId, behavior }).catch(() => {})
    clearPermission()
  }
  const onAnswer = (answers: string[][]): void => {
    if (!state.pendingQuestion) return
    window.api.ask?.respondQuestion({ requestId: state.pendingQuestion.requestId, answers }).catch(() => {})
    clearQuestion()
  }
  const onDismissQuestion = (): void => {
    if (!state.pendingQuestion) return
    window.api.ask?.respondQuestion({ requestId: state.pendingQuestion.requestId, answers: null }).catch(() => {})
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
                <RunPickers picker={pk} setPicker={setPk} />
              </div>
              <div className={'ask-composer' + (busy ? ' busy' : '')}>
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
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      send()
                    }
                  }}
                />
                <button className="ask-send has-tip" data-tip="보내기 (Enter)" aria-label="보내기" onClick={send} disabled={busy || !input.trim()}>
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
