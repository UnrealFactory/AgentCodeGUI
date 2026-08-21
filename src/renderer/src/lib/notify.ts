import { useEffect, useRef } from 'react'
import type { NotifyKind, NotifyTarget } from '@shared/protocol'
import { bgActive } from '../store/session'
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
  const prev = useRef<Map<string, { busy: boolean; perm: boolean; q: boolean; bg: boolean }>>(new Map())
  useEffect(() => {
    for (const it of items) {
      const key = `${it.target.surface}:${it.target.id}${it.target.sub ? ':' + it.target.sub : ''}`
      const p = prev.current.get(key)
      const cur = { busy: it.busy, perm: !!it.state.pendingPermission, q: !!it.state.pendingQuestion, bg: bgActive(it.state) }
      prev.current.set(key, cur)
      if (!p) continue // 첫 관찰(마운트·복원·채팅 전환) — 전이가 아니다
      const send = (kind: NotifyKind, preview: string): void => {
        // ?. 가드: dev HMR로 렌더러만 갈리면 구 preload엔 notify가 없다 (기존 규칙)
        window.api.notify?.event?.({ kind, title: it.title, preview: preview || undefined, target: it.target }).catch(() => {})
      }
      if (!p.perm && cur.perm) send('approve', it.state.pendingPermission?.summary ?? '')
      if (!p.q && cur.q) send('ask', it.state.pendingQuestion?.questions[0]?.question ?? '')
      // '답변 도착' = 진짜 완료 — 턴이 끝났어도 백그라운드(셸·에이전트·워크플로)가 남아
      // 돌면 아직이다(실사용 피드백: 완료 신호는 "이제 시킬 일 없다"여야 한다). 두 경로:
      // ① 턴 종료 순간 백그라운드도 이미 없음(보통 실행 — 기존과 동일 타이밍),
      // ② 턴은 먼저 끝났고 남아 돌던 백그라운드가 이제 다 걷힘(그 순간이 완료).
      // 승인/질문 카드로 멈춘 경우는 위에서 알렸고, interrupted(중단)는 완료가 아니다.
      const turnDone = p.busy && !cur.busy && !cur.bg
      const bgDrained = !p.busy && !cur.busy && p.bg && !cur.bg
      if ((turnDone || bgDrained) && !cur.perm && !cur.q && !it.state.interrupted) {
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
