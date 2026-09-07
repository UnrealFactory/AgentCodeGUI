import { useEffect, useId, useRef, useState } from 'react'
import type { CodexContextSettings, CodexContextTokens } from '@shared/protocol'
import { t } from '../lib/i18n'
import { useCodexModels } from './Chat'

type TokenSettings = Omit<CodexContextSettings, 'management'>
type Fields = { contextWindow: string; compactTokenLimit: string }
const tokens = ({ preset, models, fallback }: CodexContextSettings): TokenSettings => ({ preset, models, fallback })
const format = (value?: number): string => value?.toLocaleString('en-US') ?? ''
const fields = (v?: CodexContextTokens | null): Fields => ({ contextWindow: format(v?.contextWindow), compactTokenLimit: format(v?.compactTokenLimit) })
const number = (text: string): number | null => {
  const raw = text.replaceAll(',', '').trim()
  return /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null
}
const parse = (v: Fields): CodexContextTokens | null => {
  const w = number(v.contextWindow), c = number(v.compactTokenLimit)
  return w != null && c != null && w > 0 && w <= 2147483647 && c > 0 && c < w ? { contextWindow: w, compactTokenLimit: c } : null
}

export function CodexContextCard(): React.ReactElement {
  const [initial, setInitial] = useState<CodexContextSettings | null>(null)
  const [defaults, setDefaults] = useState<Record<string, CodexContextTokens>>({})
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const load = async (): Promise<void> => {
    setLoading(true); setError('')
    try {
      const result = await window.api.codexContext.get()
      if (!result.settings) throw new Error(result.error)
      setDefaults(result.defaults ?? {})
      setInitial(result.settings)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  if (!initial) return <div className="sc2 cx-context-loading" aria-busy={loading}>
    <div className="em">{t('컨텍스트 설정', 'Context settings')}</div>
    {loading ? <div className="meta">{t('기본값 불러오는 중…', 'Loading defaults…')}</div> : <>
      <div className="cx-context-error" role="alert">{error}</div>
      <button className="set-chipbtn" onClick={() => void load()}>{t('다시 시도', 'Retry')}</button>
    </>}
  </div>
  return <div className="cx-context">
    <ManagementCard initial={initial.management} />
    <TokenCard initial={initial} defaults={defaults} />
  </div>
}

function TokenCard({ initial, defaults }: { initial: CodexContextSettings; defaults: Record<string, CodexContextTokens> }): React.ReactElement {
  const id = useId()
  const visible = useCodexModels('codex')
  const [saved, setSaved] = useState<TokenSettings>(() => tokens(initial))
  const [preset, setPreset] = useState(initial.preset)
  const [draft, setDraft] = useState<Record<string, Fields>>(() => Object.fromEntries(Object.entries(initial.models).map(([id, v]) => [id, fields(v)])))
  const [fallback, setFallback] = useState(initial.fallback)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const invalid = Object.values(draft).some(v => !parse(v))
  const next: TokenSettings = { preset, models: Object.fromEntries(Object.entries(draft).flatMap(([id, v]) => { const parsed = parse(v); return parsed ? [[id, parsed]] : [] })), fallback }
  const changed = invalid || JSON.stringify(next) !== JSON.stringify(saved)
  const pick = (value: TokenSettings['preset']): void => {
    setPreset(value); setError('')
    if (value !== 'custom') {
      setFallback(null)
      setDraft(value === 'recommended' ? { 'gpt-6-astra': fields({ contextWindow: 512000, compactTokenLimit: 430000 }) } : {})
    }
  }
  const save = async (): Promise<void> => {
    if (pending.current || !changed || invalid) return
    pending.current = true; setBusy(true); setError('')
    try {
      const result = await window.api.codexContext.save(next)
      if (!result.settings) throw new Error(result.error)
      const value = tokens(result.settings)
      setSaved(value); setPreset(value.preset); setFallback(value.fallback)
      setDraft(Object.fromEntries(Object.entries(value.models).map(([id, v]) => [id, fields(v)])))
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { pending.current = false; setBusy(false) }
  }
  return <section className="sc2 cx-token-settings" data-preset={preset} aria-labelledby={id + '-title'} aria-busy={busy}>
    <div className="cx-token-heading">
      <div className="em" id={id + '-title'}>{t('컨텍스트 설정', 'Context settings')}</div>
      <span className="cx-unit">{t('단위: 토큰', 'Unit: tokens')}</span>
    </div>
    <fieldset disabled={busy}>
      <div className="cx-context-presets" role="group" aria-label={t('컨텍스트 프리셋', 'Context preset')}>
        {(['default', 'recommended', 'custom'] as const).map(value => <button key={value}
          className="cx-preset" aria-pressed={preset === value} onClick={() => pick(value)}>
          {value === 'default' ? t('기본값', 'Default') : value === 'recommended' ? t('추천값', 'Recommended') : t('직접 설정', 'Custom')}
        </button>)}
      </div>
      <div className="cx-preset-description">{preset === 'default' ? t('Codex에서 제공하는 모델별 기본값', 'Per-model defaults provided by Codex')
        : preset === 'recommended' ? t('개발자 추천 모델 값', 'Developer-recommended model values') : t('모델별로 원하는 값을 입력하세요', 'Enter your preferred values for each model')}</div>
      <table className="cx-model-table">
        <thead><tr><th>{t('모델', 'Model')}</th><th>{t('컨텍스트 크기', 'Context window')}</th><th>{t('자동 압축 기준', 'Auto-compaction')}</th></tr></thead>
        <tbody>{visible.map(model => {
          const value = draft[model.id] ?? fields(fallback ?? defaults[model.id])
          const bad = !!draft[model.id] && !parse(value)
          const name = /-(astra|sol|terra|luna)$/i.exec(model.id)?.[1]
          const label = name ? name[0].toUpperCase() + name.slice(1) : model.v
          return <tr key={model.id} data-model={model.id}>
            <th scope="row"><div className="cx-model-label"><span className="cx-model-name">{label}</span><span className="cx-model-version">{name ? model.id.slice(0, -(name.length + 1)).toUpperCase() : model.id}</span></div></th>
            {(['contextWindow', 'compactTokenLimit'] as const).map(key => <td key={key}>
              <div className={'cx-token-input' + (number(value[key]) != null && defaults[model.id] && number(value[key]) !== defaults[model.id][key] ? ' is-overridden' : '')}>
                <input inputMode="numeric" autoComplete="off" value={value[key]} placeholder="—"
                  aria-label={label + ' ' + (key === 'contextWindow' ? t('컨텍스트 크기', 'Context window') : t('자동 압축 기준', 'Auto-compaction threshold'))}
                  aria-invalid={bad} aria-describedby={bad ? id + '-invalid' : undefined}
                  onChange={e => { setDraft(d => ({ ...d, [model.id]: { ...value, [key]: e.target.value } })); setPreset('custom'); setError('') }}
                  onBlur={() => { const n = number(value[key]); if (draft[model.id] && n != null) setDraft(d => ({ ...d, [model.id]: { ...d[model.id], [key]: format(n) } })) }} />
              </div>
            </td>)}
          </tr>
        })}</tbody>
      </table>
      {visible.some(m => !defaults[m.id]) && <div className="cx-apply-note">{t('— 표시는 Codex에서 기본값을 확인하지 못한 모델이에요.', '— means Codex did not provide defaults for that model.')}</div>}
      {invalid && <div id={id + '-invalid'} className="cx-context-error" role="alert">{t('양의 정수를 입력하고 압축 기준을 컨텍스트 크기보다 작게 설정하세요.', 'Use positive integers with compaction below the context window.')}</div>}
    </fieldset>
    {error && <div className="cx-context-error" role="alert">{error}</div>}
    <div className="cx-context-footer">
      <div className="cx-apply-note" role="status">{busy ? t('저장 중…', 'Saving…') : changed ? t('변경사항을 저장해 주세요', 'Save your changes') : t('새 대화·재연결부터 적용', 'Applies to new or reconnected chats')}</div>
      <button className="cx-save" disabled={busy || !changed || invalid} onClick={() => void save()}>{t('저장', 'Save')}</button>
    </div>
  </section>
}

function ManagementCard({ initial }: { initial: boolean }): React.ReactElement {
  const id = useId()
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const toggle = async (): Promise<void> => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    try {
      const result = await window.api.codexContext.save({ management: !value })
      if (!result.settings) throw new Error(result.error)
      setValue(result.settings.management)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { pending.current = false; setBusy(false) }
  }
  return <section className="sc2 cx-management" aria-labelledby={id} aria-busy={busy}>
    <div className="cx-settings-head">
      <div>
        <div className="em" id={id}>{t('컨텍스트 관리', 'Context management')} <span className="cx-experimental">{t('실험 기능', 'Experimental')}</span></div>
        <div className="meta">{t('메모와 과거 기록 검색으로 작업 맥락을 유지해요', 'Keep task context with notes and searchable history')}</div>
      </div>
      <div className="cx-management-switch"><span>{value ? 'ON' : 'OFF'}</span>
        <button className={'sw2' + (value ? ' on' : '')} role="switch" aria-checked={value} aria-label={t('컨텍스트 관리', 'Context management')} disabled={busy} onClick={() => void toggle()} />
      </div>
    </div>
    <div className="cx-management-note" role="status">{busy ? t('저장 중…', 'Saving…') : t('새 대화·재연결부터 적용', 'Applies to new or reconnected chats')}</div>
    {error && <div className="cx-context-error" role="alert">{error}</div>}
  </section>
}
