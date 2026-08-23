/* ============================================================================
 * 대화 연결 — **긴급 정지 알약**(전 창 공용).
 *
 * ## 왜 파일이 하나 늘었나 (★M10 R3 C4)
 *
 * R2는 이 알약과 단축키를 `App.tsx`의 `MainApp` **안에** 두었다. 렌더러의 진입점은
 * 해시로 세 뿌리다(`main.tsx`: `#session → SessionWindow` · `#mapanel → PanelWindow` ·
 * 그 외 `App`). 그래서 크리틱이 잰 결과는 이랬다(D6):
 *
 * ```
 * 메인 창        .talk-stop 있음
 * 추가 창(#session)  알약 없음 · 그 창에서 Ctrl+Shift+. 를 쏴도 enabled: true → true
 * ```
 *
 * 그런데 설정 ▸ Talk는 *"어느 화면에서든 Ctrl+Shift+. 로도 눌러요"* 라고 적혀 있었다.
 * **팝아웃 패널은 보드를 보는 창**이다 — 두 세션이 주고받는 것을 보고 있는 그 창이
 * 정확히 정지가 없는 창이었다.
 *
 * 훅은 이미 창 독립이다(`listen()`은 창마다 붙는다). 부족했던 것은 **거는 자리**뿐이라
 * 여기 한 덩어리로 묶고 세 뿌리가 전부 이걸 건다.
 *
 * ## 이 파일의 규칙
 *
 *  1. **상태의 주인은 셸이다.** 낙관적으로 그리지 않는다 — 눌렀는데 화면만 꺼지고
 *     실제로는 도는 것이 이 기능에서 가장 나쁜 거짓말이다.
 *  2. **못 멈춘 것을 말한다**(★R3 C2). R2의 알약은 `purged`만 보고 「정지했어요」라고
 *     했는데, 이미 CLI에 들어가 도는 봉투 턴은 끝까지 갔다. 이제 셋을 다 센다:
 *     큐에서 뽑은 수 · 중단을 보낸 수 · **못 세운 수**.
 *  3. **켜져 있을 때만 보인다.** 기본값이 꺼짐인 기능의 버튼을 상시 띄우지 않는다.
 * ========================================================================== */
import { useCallback, useEffect, useState } from 'react'
import type { TalkConfig } from '@shared/protocol'
import { STOP_HOTKEY, isStopHotkey, stopTalk, useTalkConfig } from '../lib/crosstalk'
import { t } from '../lib/i18n'

/** 정지 결과 한 줄 — **실제로 무엇이 멎었나**를 숫자로 말한다(침묵도 과장도 금지). */
export function stopSaid(c: TalkConfig | null): string {
  if (c == null) return t('정지 요청이 셸에 닿지 않았어요', 'The stop request never reached the shell')
  const purged = c.purged ?? 0
  const hit = c.interrupted ?? 0
  const miss = c.unstoppable ?? 0
  const parts: string[] = []
  parts.push(t('정지했어요', 'Stopped'))
  if (purged > 0) parts.push(t(`대기 ${purged}건 회수`, `pulled back ${purged} queued`))
  if (hit > 0) parts.push(t(`도는 턴 ${hit}개 중단`, `interrupted ${hit} running turn(s)`))
  // ★R3 C2 — 못 멈춘 것이 있으면 **그 문장을 먼저 없애지 않는다**. R2가 여기서
  // 「정지했어요」로 끝내는 바람에 도는 턴 하나가 그대로 파일을 고칠 수 있었다.
  if (miss > 0) parts.push(t(`도는 턴 ${miss}개는 끝까지 갑니다`, `${miss} running turn(s) will finish`))
  if (purged === 0 && hit === 0 && miss === 0) parts.push(t('보드 동의도 전부 해제됐습니다', 'every board opt-in was revoked'))
  return parts.join(' · ')
}

/** 정지 한 번 + 그 결과 문장. 어느 창에서든 같은 동작이다. */
export function useTalkStop(): {
  cfg: TalkConfig
  said: string
  busy: boolean
  stop: () => void
} {
  const { cfg } = useTalkConfig()
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState('')
  const stop = useCallback(() => {
    setBusy((b) => {
      if (b) return b
      void stopTalk()
        .then((c) => {
          // 상태는 `crosstalk:state`가 REPLACE로 그린다 — 여기서 낙관적으로 끄지 않는다.
          setSaid(stopSaid(c))
          window.setTimeout(() => setSaid(''), 7000)
        })
        .finally(() => setBusy(false))
      return true
    })
  }, [])
  // 캡처 단계 — 입력창·에디터가 먼저 삼키면 "어디서나 멈춘다"가 거짓이 된다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isStopHotkey(e)) return
      e.preventDefault()
      stop()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [stop])
  return { cfg, said, busy, stop }
}

/**
 * 창 오른쪽 아래 알약. **세 뿌리 전부**가 이걸 건다(메인 · 추가 채팅 · 팝아웃 패널).
 * 단축키는 이 컴포넌트가 마운트되는 것만으로 함께 걸린다.
 */
export function TalkStopPill(): React.ReactElement | null {
  const { cfg, said, busy, stop } = useTalkStop()
  if (!cfg.enabled && !said) return null
  return (
    <div className="talk-stop-wrap">
      {cfg.enabled && (
        <button
          type="button"
          className="talk-stop"
          disabled={busy}
          onClick={stop}
          title={t(
            `대화 연결을 즉시 멈춥니다 (${STOP_HOTKEY}) — 대기 중인 메시지를 큐에서 뽑고, 이미 도는 봉투 턴에 중단을 보내고, 보드 동의를 해제해요`,
            `Stop cross-talk now (${STOP_HOTKEY}) — pulls queued messages, interrupts injected turns already running, and revokes every board opt-in`
          )}
        >
          <span className="talk-stop-dot" />
          {t('대화 연결 정지', 'Stop cross-talk')}
        </button>
      )}
      {said && <div className="talk-stop-said">{said}</div>}
    </div>
  )
}
