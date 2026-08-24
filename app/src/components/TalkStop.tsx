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
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TalkConfig } from '@shared/protocol'
import { STOP_HOTKEY, isStopHotkey, stopTalk, useTalkConfig } from '../lib/crosstalk'
import { t } from '../lib/i18n'

/**
 * 정지 결과 한 줄 — **무엇이 멎었나**를 숫자로 말한다(침묵도 과장도 금지).
 *
 * ## ★R4 D2 — 「중단」은 결과가 아니라 **보낸 것**이다
 *
 * R3의 이 함수는 `interrupted`를 「도는 턴 N개 **중단**」이라고 단정했다. 그런데 소프트
 * 중단은 요청이고, CLI가 안 받으면 몇 초 뒤 스트림을 접는 방식이라 그 사이에 한 일은
 * 남는다(설계 §8이 정확히 그렇게 적어 두었는데 알약만 단정형이었다 — 크리틱 D2).
 * 게다가 `unstoppable`이 오르는 갈래는 좁은 레이스뿐이라, **정말 못 멈춘 경우는
 * `interrupted`로 세어졌다.**
 *
 * 그래서 문장이 둘이다.
 *  · 정지 응답(`stopVerdict` 없음) → 「중단을 **보냈어요**(CLI가 안 받으면 몇 초 더 갑니다)」
 *  · 8초 뒤 셸이 **다시 잰 값**(`stopVerdict:true`) → 「N개 멎었어요 · M개는 끝까지 갑니다」
 */
export function stopSaid(c: TalkConfig | null): string {
  if (c == null) return t('정지 요청이 셸에 닿지 않았어요', 'The stop request never reached the shell')
  const purged = c.purged ?? 0
  const hit = c.interrupted ?? 0
  const miss = c.unstoppable ?? 0
  const measured = c.stopVerdict === true
  const parts: string[] = []
  parts.push(measured ? t('정지 결과', 'Stop result') : t('정지했어요', 'Stopped'))
  if (purged > 0) parts.push(t(`대기 ${purged}건 회수`, `pulled back ${purged} queued`))
  if (hit > 0)
    parts.push(
      measured
        ? t(`도는 턴 ${hit}개 멎었어요`, `${hit} running turn(s) actually stopped`)
        : t(`도는 턴 ${hit}개에 중단을 보냈어요(CLI가 안 받으면 몇 초 더 갑니다)`, `sent an interrupt to ${hit} running turn(s) — if the CLI ignores it they run a few seconds more`)
    )
  // ★R3 C2 — 못 멈춘 것이 있으면 **그 문장을 먼저 없애지 않는다**. R2가 여기서
  // 「정지했어요」로 끝내는 바람에 도는 턴 하나가 그대로 파일을 고칠 수 있었다.
  if (miss > 0) parts.push(t(`도는 턴 ${miss}개는 중단을 안 받아 끝까지 갑니다`, `${miss} running turn(s) ignored the interrupt and will finish`))
  if (purged === 0 && hit === 0 && miss === 0)
    parts.push(measured ? t('도는 턴은 없었어요', 'nothing was still running') : t('보드 동의도 전부 해제됐습니다', 'every board opt-in was revoked'))
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
  // ★R4 D2 — **이 창이 정지를 눌렀나.** 8초 뒤 오는 「잰 값」은 전 창에 방송되는데,
  // 누르지도 않은 창에 결과 문장이 불쑥 뜨면 그건 알림이지 결과가 아니다.
  const mine = useRef(false)
  const stop = useCallback(() => {
    setBusy((b) => {
      if (b) return b
      mine.current = true
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
  // ★R4 D2 — 셸이 다시 잰 결과가 오면 **단정형을 정정한다**. 「중단을 보냈어요」가
  // 「멎었어요」나 「끝까지 갑니다」로 바뀌는 자리가 여기다.
  useEffect(() => {
    if (cfg.stopVerdict !== true || !mine.current) return
    mine.current = false
    setSaid(stopSaid(cfg))
    const h = window.setTimeout(() => setSaid(''), 9000)
    return () => window.clearTimeout(h)
  }, [cfg])
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
