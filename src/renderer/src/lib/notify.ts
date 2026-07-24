import { useEffect, useRef } from 'react'
import type { NotifyKind, NotifyTarget } from '@shared/protocol'
import type { SessionState } from '../store/session'

// 포커스 밖 알림 — 채팅 표면의 전이(턴 종료/승인 대기/AI 질문)를 감지해 메인 프로세스로
// 알린다. 실제 표시 판정(그 창이 비포커스인가 + 설정 on/off)은 메인이 한다 — 창별
// 포커스는 거기가 정답이고, 렌더러는 "무슨 일이 났는지"만 안다.

export interface NotifyWatchItem {
  state: SessionState
  busy: boolean
  title: string
  target: NotifyTarget
}

// 미리보기 한 줄 — 마지막 어시스턴트 답변에서 마크다운 잡음을 걷어낸 앞부분
function lastAssistantText(s: SessionState): string {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i]
    if (m.kind === 'msg' && m.role === 'assistant') {
      return m.text
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/[#*`>|]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 140)
    }
  }
  return ''
}

/** 여러 채팅(멀티 패널)을 한 훅으로 감시 — 항목 수·순서가 렌더마다 고정이어야 한다.
 *  매 렌더 값 비교(불리언 3개)라 deps 없이 돌려도 비용이 없다. */
export function useTurnNotifyList(items: NotifyWatchItem[]): void {
  const prev = useRef<Map<string, { busy: boolean; perm: boolean; q: boolean }>>(new Map())
  useEffect(() => {
    for (const it of items) {
      const key = `${it.target.surface}:${it.target.id}${it.target.sub ? ':' + it.target.sub : ''}`
      const p = prev.current.get(key)
      const cur = { busy: it.busy, perm: !!it.state.pendingPermission, q: !!it.state.pendingQuestion }
      prev.current.set(key, cur)
      if (!p) continue // 첫 관찰(마운트·복원·채팅 전환) — 전이가 아니다
      const send = (kind: NotifyKind, preview: string): void => {
        // ?. 가드: dev HMR로 렌더러만 갈리면 구 preload엔 notify가 없다 (기존 규칙)
        window.api.notify?.event?.({ kind, title: it.title, preview: preview || undefined, target: it.target }).catch(() => {})
      }
      if (!p.perm && cur.perm) send('approve', it.state.pendingPermission?.summary ?? '')
      if (!p.q && cur.q) send('ask', it.state.pendingQuestion?.questions[0]?.question ?? '')
      // 턴 종료 — 승인/질문 카드로 멈춘 게 아니라 진짜 끝난 경우만 (카드는 위에서 알렸다)
      if (p.busy && !cur.busy && !cur.perm && !cur.q) {
        const err = it.state.status === 'error'
        send(err ? 'error' : 'done', lastAssistantText(it.state))
      }
    }
  })
}

/** 단일 채팅 표면(본채팅·추가 채팅)용 — 리스트형의 1건 래퍼 */
export function useTurnNotify(state: SessionState, busy: boolean, title: string, target: NotifyTarget): void {
  useTurnNotifyList([{ state, busy, title, target }])
}
