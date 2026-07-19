import { useEffect, useRef, useState } from 'react'
import type { UpdateStatus } from '@shared/protocol'
import { IconAlert, IconDownload } from './icons'

/**
 * 앱 자동 업데이트 알림 — 2.0 PoC의 사이드바 하단 유리 카드.
 * 새 버전(받는 중 게이지) → 준비 완료(나중에/업데이트) → 적용하는 중이 카드 하나에서
 * 이어진다. 상태는 메인 프로세스가 소유 — 마운트 때 시드해 구독 전 이벤트를 놓치지
 * 않는다. 다운로드는 백그라운드 자동이라 카드의 '업데이트'는 곧 적용(재시작)이다.
 *
 * 뜨고 접히는 규칙: 새 버전이 발견되면 스스로 떠서 진행을 보여주고, '나중에'로 접으면
 * 준비 완료가 되는 순간 한 번 더 뜬다(그때가 행동할 순간이라). 그 뒤로는 다음 실행에서
 * 다시 안내한다 — 10분 주기 재확인이 작업 중에 카드를 되띄우지 않게. 알림 통로는 이
 * 카드 하나 — 예전 사이드바 배지(sb-update)는 같은 알림이 둘로 뜨는 중복이라 은퇴시켰다.
 * 설치는 이 카드의 '업데이트' 버튼만 — 종료 시 자동 설치는 보이지 않는
 * 설치기 도중 PC가 꺼지면 앱이 삭제되는 사고라 껐다(받아둔 파일은 다음 실행에 재사용).
 */
export function AppUpdateGate() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [appVer, setAppVer] = useState('')
  const [dismissed, setDismissed] = useState(false)
  const [applying, setApplying] = useState(false)
  const [shown, setShown] = useState(false) // .show — 올라오는/가라앉는 트랜지션용
  const prevPhase = useRef<UpdateStatus['phase'] | null>(null)

  useEffect(() => {
    window.api.app.getVersion().then(setAppVer).catch(() => {})
    window.api.app.getUpdateStatus().then(setStatus).catch(() => {})
    return window.api.app.onUpdateEvent(setStatus)
  }, [])

  // 받는 중에 접었어도 준비 완료가 되는 순간엔 다시 알린다
  useEffect(() => {
    const ph = status?.phase ?? null
    if (ph !== prevPhase.current) {
      prevPhase.current = ph
      if (ph === 'downloaded') setDismissed(false)
      // 적용 대기 중 단계가 바뀌면(설치 실패 → error 등) 버튼 줄을 되살린다
      else setApplying(false)
    }
  }, [status?.phase])

  const phase = status?.phase
  // 실제 업데이트가 있을 때만 카드가 존재한다 — 평범한 시작(checking → none)은 무표시.
  // 오류는 업데이트가 진행되던 중(version 있음)일 때만 알릴 가치가 있다.
  const active =
    phase === 'available' || phase === 'downloading' || phase === 'downloaded' || (phase === 'error' && status?.version != null)
  const visible = active && !dismissed

  // .show는 한 프레임 늦게 붙여 첫 등장도 트랜지션을 타게 한다
  useEffect(() => {
    if (!visible) {
      setShown(false)
      return
    }
    const raf = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(raf)
  }, [visible])

  if (!status || !active) return null

  const err = phase === 'error'
  const ready = phase === 'downloaded'
  const ver = status.version
  const verLine = appVer && ver ? `${appVer} → ${ver}` : ver ? `v${ver}` : ''

  return (
    <div className={'upd' + (shown ? ' show' : '')}>
      <div className="uh">
        <div className={'uic' + (err ? ' err' : '')}>
          {err ? <IconAlert size={14} stroke={2.2} /> : <IconDownload size={14} stroke={2} />}
        </div>
        <div>
          <div className="ut">{err ? '업데이트 오류' : '새 버전이 나왔어요'}</div>
          <div className="us">
            {err ? (
              status.error || '업데이트에 실패했어요 · 잠시 후 다시 시도해요'
            ) : (
              <>
                <span className="uk">{verLine}</span>
                {applying ? ' · 적용하는 중…' : ready ? ' · 바로 적용돼요' : ` · 받는 중 — ${status.percent}%`}
              </>
            )}
          </div>
        </div>
      </div>
      {!err && !ready && (
        <div className="upbar">
          <i style={{ width: status.percent + '%' }} />
        </div>
      )}
      {!applying && (
        <div className="ub">
          <button className="later" onClick={() => setDismissed(true)}>
            {err ? '확인' : '나중에'}
          </button>
          {ready && (
            <button
              className="go"
              onClick={() => {
                // 스플래시가 겹쳐 뜨고 앱이 꺼진다 — 그 한 박자 동안 '적용하는 중…'
                setApplying(true)
                window.api.app.installUpdate()
              }}
            >
              업데이트
            </button>
          )}
        </div>
      )}
    </div>
  )
}
