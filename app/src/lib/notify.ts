import { useEffect, useRef } from 'react'
import type { NotifyKind, NotifyTarget } from '@shared/protocol'
import { abortedTurn, type SessionState } from '../store/session'

// 포커스 밖 알림 — 채팅 표면의 전이(턴 종료/승인 대기/AI 질문)를 감지해 메인 프로세스로
// 알린다. 실제 표시 판정(그 창이 비포커스인가 + 설정 on/off)은 메인이 한다 — 창별
// 포커스는 거기가 정답이고, 렌더러는 "무슨 일이 났는지"만 안다.

export interface NotifyWatchItem {
  state: SessionState
  busy: boolean
  title: string
  target: NotifyTarget
}

type Output = { id: string; text: string; error: boolean }
type Completion = { kind: 'done' | 'error'; runId: string | null; output: Output | null }
type Observation = {
  busy: boolean
  perm: string | null
  q: string | null
  runId: string | null
  commandId: string | null
  notified: Completion | null
}

// 이번 턴의 산출만 읽는다. 내부 정리 턴에는 사용자 말풍선이 없으므로 turnMark도
// 경계로 삼는다. /compact 등은 새 답변 대신 이 턴에 실행한 명령 카드가 산출이다.
function turnOutput(s: SessionState, commandId: string | null): Output | null {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i]
    if (m.kind === 'cmdresult' && m.id === commandId && !m.running) {
      return { id: m.id, text: [m.title, m.sub].filter(Boolean).join(' · '), error: !!m.failed }
    }
    if (m.id === s.turnMark || (m.kind === 'msg' && m.role === 'user')) break
    if (m.kind === 'msg' && m.role === 'assistant' && m.text.trim()) {
      return { id: m.id, text: m.text, error: !!m.error }
    }
  }
  return null
}

function preview(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/[#*`>|]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, 140)
}

function sameCompletion(a: Completion | null, b: Completion): boolean {
  return !!a && a.kind === b.kind && a.runId === b.runId
    && a.output?.id === b.output?.id && a.output?.text === b.output?.text
}

/** 연속해서 관찰한 채팅만 전이를 비교한다. 떠났다가 돌아온 채팅의 복원은 알리지 않는다. */
export function useTurnNotifyList(items: NotifyWatchItem[]): void {
  const prev = useRef<Map<string, Observation>>(new Map())
  useEffect(() => {
    const next = new Map<string, Observation>()
    for (const it of items) {
      const key = `${it.target.surface}:${it.target.id}${it.target.sub ? ':' + it.target.sub : ''}`
      const p = prev.current.get(key)
      const s = it.state
      const commandId = s.pendingCommand?.cardId ?? (p?.runId === s.curRunId ? p?.commandId : null) ?? null
      const cur: Observation = {
        busy: it.busy, perm: s.pendingPermission?.requestId ?? null, q: s.pendingQuestion?.requestId ?? null,
        runId: s.curRunId, commandId: it.busy ? commandId : null, notified: p?.notified ?? null
      }
      let completion: Completion | null = null
      if (!cur.busy && !cur.perm && !cur.q && !s.interrupted && !abortedTurn(s)
        && (s.status === 'done' || s.status === 'error')) {
        const output = turnOutput(s, commandId)
        if (s.status === 'error' || (output && !output.error)) {
          completion = { kind: s.status === 'error' ? 'error' : 'done', runId: s.curRunId,
            output: s.status === 'error' && !output?.error ? null : output }
        }
      }
      if (completion) cur.notified = completion
      next.set(key, cur)
      if (!p) continue // 첫 관찰(마운트·복원·채팅 전환) — 전이가 아니다
      const send = (kind: NotifyKind, preview: string): void => {
        // ?. 가드: dev HMR로 렌더러만 갈리면 구 preload엔 notify가 없다 (기존 규칙)
        window.api.notify?.event?.({ kind, title: it.title, preview: preview || undefined, target: it.target }).catch(() => {})
      }
      if (cur.perm && p.perm !== cur.perm) send('approve', s.pendingPermission?.summary ?? '')
      if (cur.q && p.q !== cur.q) send('ask', s.pendingQuestion?.questions[0]?.question ?? '')
      // 턴 종료 — 승인/질문 카드로 멈춘 게 아니라 진짜 끝난 경우만 (카드는 위에서 알렸다).
      // interrupted = 취소(중단)로 내려간 busy — 완료가 아니므로 '답변 도착'을 쏘지 않는다.
      // 백그라운드(셸·에이전트·워크플로) 잔존과는 무관하게 답변이 온 턴마다 알린다 —
      // "중간중간 답변이 오는 것"의 통지라는 사용자 결정. '진짜 완료(전부 걷힘)' 판정은
      // 표시 계층(패널 완료 링·칩 — effectiveStatus)만 쓴다.
      if (p.busy && completion && !sameCompletion(p.notified, completion)) {
        send(completion.kind, preview(completion.output?.text ?? ''))
      }
    }
    prev.current = next
  })
}

/** 단일 채팅 표면(본채팅·추가 채팅)용 — 리스트형의 1건 래퍼 */
export function useTurnNotify(state: SessionState, busy: boolean, title: string, target: NotifyTarget): void {
  useTurnNotifyList([{ state, busy, title, target }])
}
