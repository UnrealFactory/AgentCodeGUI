import { useEffect, useRef, useState } from 'react'
import type { EngineUpdateStatus } from '@shared/protocol'
import { IconAlert, IconCheck, IconClaude, IconMascot, LogoOpenAI } from './icons'

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB'
  if (n >= 1024 ** 2) return Math.round(n / 1024 ** 2) + ' MB'
  if (n >= 1024) return Math.round(n / 1024) + ' KB'
  return n + ' B'
}

/**
 * 엔진 부팅 자동 업데이트 카드 — "새 버전이 있어요" 물어보는 창 대신, 이미 하고 있는
 * 일을 비추는 창. 메인이 부팅 직후(아직 어떤 세션도 돌기 전 — 옛 버전 삭제가 실행 중
 * CLI를 물 수 없는 유일한 시점) 두 엔진을 설치→활성화→이전 버전 정리까지 끝내며
 * 스냅샷(REPLACE)을 흘리고, 이 카드는 그 진행을 보여주다 끝나면 스스로 닫힌다.
 * 실패한 엔진이 있으면 자동으로 닫지 않고 사유와 확인 버튼을 남긴다.
 */
export function EngineUpdateGate() {
  const [st, setSt] = useState<EngineUpdateStatus | null>(null)
  const [closing, setClosing] = useState(false)
  const [hidden, setHidden] = useState(false)
  // 진행 중인 모습을 실제로 봤을 때만 done 스냅샷을 그린다 — 리로드/HMR 직후 이미
  // 끝난 흐름의 스냅샷이 뒤늦게 카드를 띄우지 않게.
  const sawLiveRef = useRef(false)

  useEffect(() => {
    // ?. 가드: HMR로 렌더러만 갈린 구 preload엔 engineUpdate가 없을 수 있다
    window.api.engineUpdate
      ?.status?.()
      .then((s) => {
        if (s.active && !s.done) {
          sawLiveRef.current = true
          setSt(s)
        }
      })
      .catch(() => {})
    return (
      window.api.engineUpdate?.onEvent?.((s) => {
        if (!s.active) return
        if (!s.done) sawLiveRef.current = true
        if (s.done && !sawLiveRef.current) return
        setSt(s)
      }) ?? (() => {})
    )
  }, [])

  const failed = st?.items.some((i) => i.status === 'error') ?? false
  // 전부 끝났고 실패가 없으면 완료 상태를 잠깐 보여주고 스스로 닫는다
  useEffect(() => {
    if (!st?.done || failed) return
    const t1 = setTimeout(() => setClosing(true), 1300)
    const t2 = setTimeout(() => setHidden(true), 1650)
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [st?.done, failed])

  if (!st || hidden) return null

  return (
    <div className={'set-dialog-overlay eu-overlay' + (closing ? ' closing' : '')}>
      <div className="eu-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="eu-head">
          {/* 진행 중 아이콘은 2.0 마스코트 로봇 — "엔진이 새로워지는 중" (HTML 후보 비교로 선정) */}
          <span className={'eu-ic' + (st.done ? (failed ? ' err' : ' ok') : '')}>
            {st.done ? failed ? <IconAlert size={18} /> : <IconCheck size={18} /> : <IconMascot size={21} />}
          </span>
          <div>
            <div className="eu-title">엔진 업데이트</div>
            <div className="eu-sub">
              {st.done
                ? failed
                  ? '일부 엔진을 업데이트하지 못했어요'
                  : '최신 버전으로 준비됐어요'
                : '새 버전을 설치하는 중이에요 — 잠시만요'}
            </div>
          </div>
        </div>
        <div className="eu-rows">
          {st.items.map((i) => (
            <div className="eu-row" key={i.id}>
              <span className="eu-logo">{i.id === 'claude' ? <IconClaude size={15} /> : <LogoOpenAI size={15} />}</span>
              <span className="eu-name">{i.label}</span>
              <span className="eu-vers">
                {i.from ? (
                  <>
                    {i.from} <span className="eu-arrow">→</span> {i.to}
                  </>
                ) : (
                  <>{i.to} 새로 설치</>
                )}
              </span>
              <span className={'eu-st ' + i.status}>
                {i.status === 'installing' ? (
                  <span className="set-spin" />
                ) : i.status === 'done' ? (
                  <IconCheck size={13} />
                ) : i.status === 'error' ? (
                  <IconAlert size={13} />
                ) : null}
              </span>
            </div>
          ))}
          <div className="eu-row eu-clean">
            <span className="eu-name">이전 버전 정리</span>
            <span className="eu-vers">{st.cleanup === 'done' && st.freedBytes > 0 ? fmtBytes(st.freedBytes) + ' 확보' : ''}</span>
            <span className={'eu-st ' + (st.cleanup === 'done' ? 'done' : st.cleanup === 'running' ? 'installing' : 'pending')}>
              {st.cleanup === 'running' ? <span className="set-spin" /> : st.cleanup === 'done' ? <IconCheck size={13} /> : null}
            </span>
          </div>
        </div>
        {st.done && failed && (
          <div className="eu-foot">
            <div className="eu-err">{st.items.find((i) => i.error)?.error ?? '네트워크 상태를 확인한 뒤 다시 시작하면 재시도해요.'}</div>
            <button className="sd-go" onClick={() => setHidden(true)}>
              확인
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
