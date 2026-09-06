import { useEffect, useId, useState } from 'react'
import type { EngineId } from '@shared/protocol'
import { loadEngineEnvironments, pickEngineEnvironmentPath, saveEngineEnvironment, useEngineEnvironments, type EngineEnvironment } from '../api/engineEnvironment'
import { t } from '../lib/i18n'
import { IconCheck, IconFolderOpen, IconRefresh } from './icons'
import { HoverTip } from './HoverTip'

export function EngineEnvironmentCard({ engine }: { engine: EngineId }) {
  const environments = useEngineEnvironments()
  const saved = environments?.[engine]
  const fieldId = useId()
  const [draft, setDraft] = useState<EngineEnvironment>({ mode: 'managed', cliPath: '', configDir: '' })
  const [busy, setBusy] = useState<'save' | 'detect' | 'browse' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [detected, setDetected] = useState(false)
  useEffect(() => {
    if (saved) setDraft({ mode: saved.mode, cliPath: saved.cliPath, configDir: saved.configDir })
  }, [saved?.mode, saved?.cliPath, saved?.configDir])
  useEffect(() => {
    void loadEngineEnvironments().catch(e => setError(String(e)))
  }, [])
  const changed = !!saved && (draft.mode !== saved.mode || draft.cliPath !== saved.cliPath || draft.configDir !== saved.configDir)
  const edit = (patch: Partial<EngineEnvironment>) => {
    setDraft(v => ({ ...v, ...patch }))
    setError(null)
    setDetected(false)
  }
  const save = async () => {
    setBusy('save')
    setError(null)
    try { await saveEngineEnvironment(engine, draft); setDetected(false) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(null) }
  }
  const detect = async () => {
    setBusy('detect')
    setError(null)
    setDetected(false)
    try {
      const result = (await loadEngineEnvironments(true))[engine]
      if (result.detectionError) throw new Error(result.detectionError)
      const cliPath = result.detectedCliPath
      if (!cliPath) throw new Error(t('CLI 실행 파일을 찾지 못했어요. 경로를 직접 입력해 주세요.', 'CLI not found. Enter its path manually.'))
      // Only replace edits after both paths have been found and validated.
      setDraft(v => ({ ...v, cliPath, configDir: result.detectedConfigDir }))
      setDetected(true)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(null) }
  }
  const visibleError = error || (draft.mode === 'system' && !changed ? saved?.error : null)
  const browse = async (kind: 'cliPath' | 'configDir') => {
    setBusy('browse')
    try {
      const current = draft[kind] || (kind === 'cliPath' ? saved?.resolvedCliPath : saved?.resolvedConfigDir) || ''
      const path = await pickEngineEnvironmentPath(kind, current)
      if (path !== null) edit({ [kind]: path })
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(null) }
  }
  return (
    <div className="sc2 engine-environment" data-engine={engine}>
      <div className="engine-environment-head">
        <div className="em">{engine === 'claude' ? 'Claude Code' : 'Codex CLI'} · {t('실행 환경', 'Execution environment')}</div>
        <div className="engine-environment-modes" role="radiogroup" aria-label={t('실행 환경', 'Execution environment')}>
          {(['managed', 'system'] as const).map(mode => (
            <button key={mode} type="button" className="engine-environment-mode"
              role="radio" aria-checked={draft.mode === mode} tabIndex={draft.mode === mode ? 0 : -1} disabled={!saved || !!busy}
              onClick={() => edit({ mode })}
              onKeyDown={e => {
                if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return
                e.preventDefault()
                const next = e.key === 'Home' ? 'managed' : e.key === 'End' ? 'system' : mode === 'managed' ? 'system' : 'managed'
                edit({ mode: next })
                const group = e.currentTarget.parentElement!
                group.querySelectorAll<HTMLButtonElement>('button')[next === 'managed' ? 0 : 1].focus()
              }}>
              {mode === 'managed' ? t('앱 관리', 'App managed') : t('시스템 환경', 'System environment')}
            </button>
          ))}
        </div>
      </div>
      <p className="engine-environment-description">
        {draft.mode === 'managed'
          ? t('앱에서 CLI 설치와 업데이트, 계정을 관리해요.', 'The app manages CLI installation, updates, and accounts.')
          : t('터미널에서 사용하던 CLI와 로그인·설정을 사용해요. CLI 업데이트는 시스템에서 관리해 주세요.', 'Uses your terminal CLI, login, and configuration. Manage CLI updates outside the app.')}
      </p>
      {draft.mode === 'system' && (
        <div className="engine-environment-paths">
          <div className="engine-environment-paths-head">
            <span>{t('시스템 경로', 'System paths')}</span>
            <button type="button" className="engine-environment-detect" disabled={!!busy} onClick={() => void detect()}>
              <IconRefresh size={13} className={busy === 'detect' ? 'engine-environment-spin' : undefined} aria-hidden="true" />
              {busy === 'detect' ? t('찾는 중…', 'Detecting…') : t('자동 감지', 'Auto-detect')}
            </button>
          </div>
          {([
            { kind: 'cliPath', label: t('CLI 실행 파일', 'CLI executable'), browseLabel: t('CLI 실행 파일 선택', 'Choose CLI executable'), placeholder: saved?.detectedCliPath || t('전체 경로 입력', 'Enter full path') },
            { kind: 'configDir', label: t('설정 폴더', 'Configuration folder'), browseLabel: t('설정 폴더 선택', 'Choose configuration folder'), placeholder: saved?.detectedConfigDir || (engine === 'claude' ? '~/.claude' : '~/.codex') }
          ] as const).map(field => (
            <div className="set-field" key={field.kind}>
              <label htmlFor={`${fieldId}-${field.kind}`}>{field.label}</label>
              <div className="engine-environment-path-input">
                <input id={`${fieldId}-${field.kind}`} className="set-input" aria-label={field.label} value={draft[field.kind]} disabled={!!busy}
                  placeholder={field.placeholder} onChange={e => edit({ [field.kind]: e.target.value })} spellCheck={false} autoComplete="off" />
                <HoverTip text={field.browseLabel}>
                  <button type="button" className="engine-environment-browse" aria-label={field.browseLabel}
                    disabled={!!busy} onClick={() => void browse(field.kind)}>
                    <IconFolderOpen size={16} aria-hidden="true" />
                  </button>
                </HoverTip>
              </div>
            </div>
          ))}
          <div className="engine-environment-hint">{t('비워 두면 표시된 자동 감지 경로를 사용해요.', 'Empty fields use the detected paths shown above.')}</div>
        </div>
      )}
      {busy === 'detect' && <div className="engine-environment-feedback" role="status">{t('설치된 CLI와 설정 폴더를 찾고 있어요…', 'Looking for your installed CLI and configuration folder…')}</div>}
      {detected && !visibleError && <div className="engine-environment-feedback" role="status">
        <IconCheck size={14} aria-hidden="true" />{t('찾은 CLI와 설정 폴더를 입력했어요.', 'Detected CLI and configuration paths filled in.')}
      </div>}
      {visibleError && <div className="engine-environment-feedback error" role="alert">{visibleError}</div>}
      {changed ? (
        <div className="engine-environment-actions">
          <span className="engine-environment-hint">{t('저장 후 앱을 재시작하면 새 대화부터 적용돼요.', 'After saving, restart the app to apply changes to new chats.')}</span>
          <div className="engine-environment-buttons">
            <button type="button" className="engine-environment-cancel" disabled={!!busy} onClick={() => saved && edit({ mode: saved.mode, cliPath: saved.cliPath, configDir: saved.configDir })}>
              {t('취소', 'Cancel')}
            </button>
            <button type="button" className="set-chipbtn" disabled={!!busy} onClick={() => void save()}>
              {busy === 'save' ? t('저장 중…', 'Saving…') : t('저장', 'Save')}
            </button>
          </div>
        </div>
      ) : saved?.restartRequired && (
        <div className="engine-environment-feedback" role="status"><IconCheck size={14} aria-hidden="true" />
          {t('저장됨 · 앱 재시작 후 새 대화부터 적용', 'Saved · restart the app to apply to new chats')}
        </div>
      )}
    </div>
  )
}
