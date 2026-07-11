import { useEffect, useRef, useState } from 'react'
import type { UpdateStatus } from '@shared/protocol'
import { IconAlert, IconCheck } from './icons'

/**
 * App auto-update UI — mirrors EngineGate's install-card so updating the app looks
 * exactly like installing a Claude engine version: a streamed log + progress, then a
 * "재시작하여 설치" action when ready. The full state (incl. the log) is owned by the
 * main process; we seed from it on mount so no early event is missed, then follow live
 * updates. 카드는 스스로 뜨지 않는다 — 새 버전 알림은 사이드바 배지가 맡고, 이 카드는
 * 배지 클릭(app-update:open)으로만 열린다. 10분 주기 재확인이 작업 중에 카드를 불쑥
 * 띄우던 것을 막기 위한 규칙이라, 시작 시 발견된 업데이트도 배지로만 알린다.
 */
export function AppUpdateGate() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [dismissed, setDismissed] = useState(true)
  const logRef = useRef<HTMLDivElement>(null)

  // seed from the main-process state (catches events fired before we subscribed)
  useEffect(() => {
    // the sidebar's update badge opens the card through this event
    const reopen = (): void => setDismissed(false)
    window.addEventListener('app-update:open', reopen)
    window.api.app.getUpdateStatus().then(setStatus).catch(() => {})
    const off = window.api.app.onUpdateEvent(setStatus)
    return () => {
      window.removeEventListener('app-update:open', reopen)
      off()
    }
  }, [])

  // keep the log scrolled to the newest line
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [status?.log.length])

  if (!status || dismissed) return null
  const { phase } = status
  // only an actual update is worth a card; a normal launch (checking → none) shows nothing.
  const visible =
    phase === 'available' || phase === 'downloading' || phase === 'downloaded' || (phase === 'error' && status.version != null)
  if (!visible) return null

  const statusCls = phase === 'downloaded' ? 'done' : phase === 'error' ? 'error' : 'running'
  const title =
    phase === 'downloaded' ? '업데이트 준비 완료' : phase === 'error' ? '업데이트 오류' : '업데이트 다운로드 중'

  return (
    <div
      className="set-dialog-overlay"
      onMouseDown={() => setDismissed(true)} // hide; the download keeps running in the background
    >
      <div className="install-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ic-head">
          <span className={'ic-hic ' + statusCls}>
            {phase === 'downloaded' ? (
              <IconCheck size={16} />
            ) : phase === 'error' ? (
              <IconAlert size={16} />
            ) : (
              <span className="set-spin" />
            )}
          </span>
          <span className="ic-title">{title}</span>
          {status.version && <span className="ic-ver">v{status.version}</span>}
        </div>
        <div className="ic-log scroll" ref={logRef}>
          {status.log.map((l, i) => (
            <div className="ic-ln" key={i}>
              {l}
            </div>
          ))}
          {phase === 'error' && status.error && <div className="ic-ln err">{status.error}</div>}
        </div>
        <div className="ic-foot">
          <span className={'ic-status ' + statusCls}>
            {phase === 'downloaded'
              ? '재시작하면 새 버전이 설치됩니다'
              : phase === 'error'
                ? '업데이트에 실패했습니다'
                : `내려받는 중… ${status.percent}%`}
          </span>
          {phase === 'downloaded' ? (
            <>
              <button className="sd-cancel" onClick={() => setDismissed(true)}>
                나중에
              </button>
              <button className="sd-go" onClick={() => window.api.app.installUpdate()}>
                재시작하여 설치
              </button>
            </>
          ) : (
            <button className="sd-go" onClick={() => setDismissed(true)}>
              {phase === 'error' ? '확인' : '숨기기'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
