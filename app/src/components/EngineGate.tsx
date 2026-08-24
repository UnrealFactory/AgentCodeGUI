import { useEffect, useRef, useState } from 'react'
import type { EngineUpdateStatus } from '@shared/protocol'
import { t } from '../lib/i18n'
import { IconAlert, IconCheck, IconClaude } from './icons'

type Phase = 'hidden' | 'prompt' | 'installing' | 'done' | 'error'

/**
 * 부팅 업데이터가 **결론**을 낼 때까지 기다린다 — 결론은 둘 중 하나다:
 * `active`(일이 있어 지금 하고 있다) 또는 `done`(끝났고 이번 부팅엔 할 일이 없었다).
 *
 * 자동 업데이트가 꺼져 있으면 부팅 업데이터가 아예 안 돌므로 기다리지 않는다.
 * 상한(20초)은 두 엔진의 레지스트리 조회 상한(각 8초)보다 넉넉히 크다 — 그 안에
 * 답이 안 오면 "아무도 안 돈다"로 보고 우리가 안내한다(침묵보다 낫다).
 */
async function settleBootUpdater(): Promise<EngineUpdateStatus | null> {
  const peek = async (): Promise<EngineUpdateStatus | null> =>
    (await window.api.engineUpdate?.status?.().catch(() => null)) ?? null
  let s = await peek()
  if (s?.active) return s
  const auto = await window.api.engineAutoUpdate().catch(() => true)
  if (!auto) return s
  for (let i = 0; i < 40 && !s?.active && !s?.done; i++) {
    await new Promise((r) => setTimeout(r, 500))
    s = await peek()
  }
  return s
}

/**
 * On launch: if the Claude engine isn't installed, pops a card prompting to install
 * the latest version — one click installs it into ~/.agentcodegui and activates it.
 *
 * ★R28 T1T2 R2 — 조기 반환의 조건이 「자동 업데이트가 **켜져 있다**」에서
 * 「부팅 업데이터가 **실제로 돌고 있다**」로 좁혀졌다. 3.0에는 그 부팅 업데이터가
 * 통째로 없었고(`engine:update-status`가 하드코딩 `{active:false}`), 기본값이 켬이라
 * 이 게이트는 언제나 첫 줄에서 물러났다 — 엔진도 CLI도 없는 새 사용자가 25초를
 * 기다려도 카드 한 장 못 보던 자리다(확인 크리틱 §4.2 실측). 이제 부팅 업데이터가
 * 일을 맡았을 때만 비켜서고, 아무도 안 도는 판에서는 우리가 안내한다.
 *
 * 일을 맡은 판에서는 진행을 EngineUpdateGate가 카드로 보여준다. "새 엔진 버전"
 * 업데이트 프롬프트는 그 구조로 대체돼 제거됐다(누르지 않아도 20초 뒤 사일런트
 * 업데이트가 어차피 덮어쓰던 거짓 선택지였다).
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
        // ① 설치본부터 본다 — 디스크 한 번이라 싸다. 활성 엔진이 있으면 할 말이 없고,
        //    그러면 **레지스트리 조회를 아예 안 한다**(부팅마다 npm 자식 하나가 준다).
        const state = await window.api.engine.state()
        if (!alive || state.active) return
        // ② 엔진이 없다 — 부팅 업데이터가 그 일을 맡았는지 결론을 기다린다.
        const boot = await settleBootUpdater()
        if (!alive || boot?.active) return // 맡았다 → 진행은 EngineUpdateGate의 몫
        // ③ 아무도 안 돈다. 이제 "무엇을 깔아야 하는지"를 알아내 안내한다.
        const avail = await window.api.engine.listAvailable()
        if (!alive) return
        const latest = avail.latest
        if (!latest) return // can't determine latest (offline) → stay hidden
        setTarget(latest)
        setPhase('prompt')
      } catch {
        /* offline / error → stay hidden, settings still lets them install */
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // 부팅 업데이터가 **뒤늦게** 일을 시작하면(느린 레지스트리 조회) 우리가 물러난다 —
  // 안 그러면 같은 화면에 안내 카드와 진행 카드가 겹쳐 뜬다.
  useEffect(() => {
    return (
      window.api.engineUpdate?.onEvent?.((s) => {
        if (s.active && !s.done) setPhase((p) => (p === 'prompt' ? 'hidden' : p))
      }) ?? undefined
    )
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
    setLog([t('설치를 준비하는 중…', 'Preparing install…')])
    setPhase('installing')
    try {
      const r = await window.api.engine.install(target)
      if (r.ok) {
        await window.api.engine.setActive(target)
        setPhase('done')
      } else {
        setError(r.error ?? t('알 수 없는 오류로 설치에 실패했습니다.', 'Install failed with an unknown error.'))
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
          <div className="sd-title">{t('Claude 엔진 설치', 'Install Claude engine')}</div>
          <div className="sd-msg">
            {t(
              `Claude Code 엔진이 아직 설치되지 않았습니다. 최신 버전(${target})을 설치하면 바로 사용할 수 있어요.`,
              `The Claude Code engine isn't installed yet. Install the latest version (${target}) to start right away.`
            )}
          </div>
          <div className="sd-btns">
            <button className="sd-cancel" onClick={() => setPhase('hidden')}>
              {t('나중에', 'Later')}
            </button>
            <button className="sd-go" onClick={doInstall}>
              {t('설치', 'Install')}
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
            {phase === 'installing'
              ? t('엔진 설치 중', 'Installing engine')
              : phase === 'done'
                ? t('설치 완료', 'Install complete')
                : t('설치 실패', 'Install failed')}
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
              ? t('설치하는 중…', 'Installing…')
              : phase === 'done'
                ? t('설치가 완료되었습니다', 'Installation complete')
                : t('설치에 실패했습니다', 'Installation failed')}
          </span>
          {phase === 'error' && (
            <button className="sd-cancel" onClick={doInstall}>
              {t('다시 시도', 'Retry')}
            </button>
          )}
          <button className="sd-go" onClick={() => setPhase('hidden')} disabled={phase === 'installing'}>
            {t('확인', 'OK')}
          </button>
        </div>
      </div>
    </div>
  )
}
