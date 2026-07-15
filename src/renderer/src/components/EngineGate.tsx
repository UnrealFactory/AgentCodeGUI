import { useEffect, useRef, useState } from 'react'
import { IconAlert, IconCheck, IconClaude } from './icons'

type Phase = 'hidden' | 'prompt' | 'installing' | 'done' | 'error'

/**
 * On launch: if the Claude engine isn't installed, pops a card prompting to install
 * the latest version — one click installs it into ~/.agentcodegui and activates it.
 *
 * 자동 업데이트(설정 → Engine, 기본 켬)가 켜져 있으면 이 게이트는 아예 안 뜬다 —
 * 설치도 업데이트도 부팅 게이트(EngineUpdateGate)가 물어보지 않고 진행하며 카드로
 * 보여준다. "새 엔진 버전" 업데이트 프롬프트는 그 구조로 대체돼 제거됐다(누르지
 * 않아도 20초 뒤 사일런트 업데이트가 어차피 덮어쓰던 거짓 선택지였다).
 */
export function EngineGate() {
  const [phase, setPhase] = useState<Phase>('hidden')
  const [target, setTarget] = useState('') // latest version to install
  const [log, setLog] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const installingRef = useRef(false)

  // one-time check on mount
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        // 자동 업데이트가 켜져 있으면 부팅 게이트의 몫 — 조회 실패는 켬(기본값)으로 간주
        const auto = await window.api.engineAutoUpdate().catch(() => true)
        if (!alive || auto) return
        const [state, avail] = await Promise.all([window.api.engine.state(), window.api.engine.listAvailable()])
        if (!alive) return
        const latest = avail.latest
        if (!latest) return // can't determine latest (offline) → stay hidden
        setTarget(latest)
        if (!state.active) setPhase('prompt')
      } catch {
        /* offline / error → stay hidden, settings still lets them install */
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // accumulate npm output while our own install runs
  useEffect(() => {
    return window.api.engine.onInstallProgress((p) => {
      if (p.line && installingRef.current) setLog((l) => [...l, p.line as string])
    })
  }, [])

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])

  const doInstall = async (): Promise<void> => {
    installingRef.current = true
    setError(null)
    setLog(['설치를 준비하는 중…'])
    setPhase('installing')
    try {
      const r = await window.api.engine.install(target)
      if (r.ok) {
        await window.api.engine.setActive(target)
        setPhase('done')
      } else {
        setError(r.error ?? '알 수 없는 오류로 설치에 실패했습니다.')
        setPhase('error')
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
      setPhase('error')
    } finally {
      installingRef.current = false
    }
  }

  if (phase === 'hidden') return null

  if (phase === 'prompt') {
    return (
      <div className="set-dialog-overlay">
        <div className="set-dialog" onMouseDown={(e) => e.stopPropagation()}>
          <div className="sd-ic warn">
            <IconClaude size={22} />
          </div>
          <div className="sd-title">Claude 엔진 설치</div>
          <div className="sd-msg">{`Claude Code 엔진이 아직 설치되지 않았습니다. 최신 버전(${target})을 설치하면 바로 사용할 수 있어요.`}</div>
          <div className="sd-btns">
            <button className="sd-cancel" onClick={() => setPhase('hidden')}>
              나중에
            </button>
            <button className="sd-go" onClick={doInstall}>
              설치
            </button>
          </div>
        </div>
      </div>
    )
  }

  // installing / done / error → log card
  const statusCls = phase === 'installing' ? 'running' : phase === 'done' ? 'done' : 'error'
  return (
    <div
      className="set-dialog-overlay"
      onMouseDown={() => {
        if (phase !== 'installing') setPhase('hidden')
      }}
    >
      <div className="install-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ic-head">
          <span className={'ic-hic ' + statusCls}>
            {phase === 'installing' ? (
              <span className="set-spin" />
            ) : phase === 'done' ? (
              <IconCheck size={16} />
            ) : (
              <IconAlert size={16} />
            )}
          </span>
          <span className="ic-title">
            {phase === 'installing' ? '엔진 설치 중' : phase === 'done' ? '설치 완료' : '설치 실패'}
          </span>
          <span className="ic-ver">{target}</span>
        </div>
        <div className="ic-log scroll" ref={logRef}>
          {log.map((l, i) => (
            <div className="ic-ln" key={i}>
              {l}
            </div>
          ))}
          {phase === 'error' && error && <div className="ic-ln err">{error}</div>}
        </div>
        <div className="ic-foot">
          <span className={'ic-status ' + statusCls}>
            {phase === 'installing'
              ? '설치하는 중…'
              : phase === 'done'
                ? '설치가 완료되었습니다'
                : '설치에 실패했습니다'}
          </span>
          {phase === 'error' && (
            <button className="sd-cancel" onClick={doInstall}>
              다시 시도
            </button>
          )}
          <button className="sd-go" onClick={() => setPhase('hidden')} disabled={phase === 'installing'}>
            확인
          </button>
        </div>
      </div>
    </div>
  )
}
