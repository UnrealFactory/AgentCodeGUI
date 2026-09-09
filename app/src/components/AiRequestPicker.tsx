import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { AccountInfo, AccountUsage, AiTextOptions, CodexAccountUsage, EngineId } from '@shared/protocol'
import { ensureAccounts, ensureCodexAccounts, refreshUsage, refreshCodexUsage } from '../lib/accounts'
import { getPref, setPref } from '../lib/prefs'
import { t } from '../lib/i18n'
import { CODEX_DEFAULT_MODEL, codexModelEfforts, useCodexModels } from './Chat'
import { IconCheck, IconChevLeft, IconClose, IconSpark } from './icons'

export type AiTextSelection = Required<AiTextOptions>
export const aiProviderName = (engine: EngineId): string => engine === 'codex' ? 'OpenAI' : 'Anthropic'
const prefKey = (prefix: string, engine: EngineId, key: string): string =>
  engine === 'claude' ? `${prefix}.${key}` : `${prefix}.codex.${key}`
export const AI_TEXT_MODELS = [
  { id: 'fable', label: 'Fable 5.1' }, { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' }, { id: 'haiku', label: 'Haiku' }
]
export const aiTextEfforts = () => [
  { id: 'minimal', label: t('최소', 'Minimal') }, { id: 'low', label: t('낮음', 'Low') },
  { id: 'medium', label: t('중간', 'Medium') }, { id: 'high', label: t('높음', 'High') },
  { id: 'xhigh', label: t('매우 높음', 'Very high') }, { id: 'max', label: t('최대', 'Max') }
]
function usageDesc(usage: AccountUsage | CodexAccountUsage | undefined, loading: boolean): string {
  if (!usage) return loading ? t('한도 확인 중…', 'Checking limits…') : t('한도 정보를 못 가져왔어요', 'Could not load limit info')
  const windows = 'windows' in usage ? usage.windows : [
    { label: t('5시간', '5h'), usedPct: usage.fiveHourPct },
    { label: t('주간', 'Weekly'), usedPct: usage.weeklyPct },
    { label: 'Fable', usedPct: usage.fablePct }
  ]
  return windows.filter(w => w.usedPct != null).map(w => {
    const left = Math.max(0, Math.round(100 - w.usedPct!))
    return t(`${w.label} ${left}% 남음`, `${w.label} ${left}% left`)
  }).join(' · ') || t('한도 정보 없음', 'No limit info')
}

/** Shared provider/account/model selection for short AI tasks. */
export function AiRequestPicker({ title, prefPrefix, submitLabel, hint, children, disabled, onSubmit, onClose }: {
  title: string
  prefPrefix: string
  submitLabel: string
  hint?: string
  children?: ReactNode
  disabled?: boolean
  onSubmit: (selection: AiTextSelection) => void
  onClose: () => void
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [engine, setEngine] = useState<EngineId>(() => getPref<string>(`${prefPrefix}.engine`, getPref<string>('git.ai.engine', 'claude')) === 'codex' ? 'codex' : 'claude')
  const [accounts, setAccounts] = useState<Pick<AccountInfo, 'email' | 'isDefault'>[] | null>(null)
  const [usage, setUsage] = useState<Record<string, AccountUsage | CodexAccountUsage> | null>(null)
  const [account, setAccount] = useState('')
  const [model, setModel] = useState('sonnet')
  const [effort, setEffort] = useState('low')
  const card = useRef<HTMLDivElement>(null)
  const codexModels = useCodexModels(step >= 2 ? engine : 'claude')
  const choices = engine === 'codex' ? codexModels.map(m => ({ id: m.id, label: m.v })) : AI_TEXT_MODELS
  const selectedModel = choices.find(m => m.id === model)?.id ?? choices[0]?.id ?? ''
  const efforts = engine === 'codex'
    ? codexModelEfforts(selectedModel).map(id => ({ id, label: aiTextEfforts().find(e => e.id === id)?.label ?? id }))
    : aiTextEfforts()
  const selectedEffort = efforts.find(e => e.id === effort)?.id ?? efforts[0]?.id ?? 'low'

  useEffect(() => {
    card.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  useEffect(() => {
    if (step !== 2) return
    let active = true
    setAccounts(null)
    setUsage(null)
    const list = engine === 'codex' ? ensureCodexAccounts(true) : ensureAccounts(true)
    const limits = engine === 'codex' ? refreshCodexUsage() : refreshUsage()
    void list.then(rows => { if (active) setAccounts(rows) })
    void limits.then(rows => { if (active) setUsage(rows) })
    return () => { active = false }
  }, [step, engine])

  const pickEngine = (next: EngineId) => {
    setEngine(next)
    setPref(`${prefPrefix}.engine`, next)
    setAccount(getPref(prefKey(prefPrefix, next, 'account'), ''))
    setModel(getPref(prefKey(prefPrefix, next, 'model'), next === 'codex' ? CODEX_DEFAULT_MODEL : 'sonnet'))
    setEffort(getPref(prefKey(prefPrefix, next, 'effort'), 'low'))
    setAccounts(null)
    setStep(2)
  }
  const pickAccount = (email: string) => {
    setAccount(email)
    setPref(prefKey(prefPrefix, engine, 'account'), email)
    setStep(3)
  }
  const submit = () => {
    if (disabled || !account || !selectedModel) return
    setPref(prefKey(prefPrefix, engine, 'model'), selectedModel)
    setPref(prefKey(prefPrefix, engine, 'effort'), selectedEffort)
    onSubmit({ engine, account, model: selectedModel, effort: selectedEffort })
  }
  return createPortal(
    <div className="set-dialog-overlay" onMouseDown={e => { if (e.button === 0 && e.target === e.currentTarget) onClose() }}>
      <div className="qcard ai-request-picker" role="dialog" aria-modal="true" aria-label={title} ref={card} tabIndex={-1}>
        <div className="qhead">
          <IconSpark size={15} /><span className="qhl">{title}</span><span className="qsp" />
          <button className="qmin" aria-label={t('닫기', 'Close')} onClick={onClose}><IconClose size={14} /></button>
        </div>
        {step === 1 ? (
          <div className="qwrap qstep-b" key="provider">
            <div className="qbl">{t('1 / 3 — 제공업체', '1 / 3 — Provider')}</div>
            <div className="qbt">{t('어떤 AI를 사용할까요?', 'Which AI would you like to use?')}</div>
            <div className="qopts">
              {(['claude', 'codex'] as const).map(id => (
                <button key={id} className={'qopt' + (engine === id ? ' on' : '')} onClick={() => pickEngine(id)}>
                  <span className="ql">{aiProviderName(id)}</span><span className="qd">{id === 'codex' ? 'GPT · Codex' : 'Claude'}</span>
                  <span className="qck"><IconCheck size={14} /></span>
                </button>
              ))}
            </div>
          </div>
        ) : step === 2 ? (
          <div className="qwrap qstep-b" key={`account-${engine}`}>
            <div className="qbl">
              <button className="qback" onClick={() => setStep(1)}><IconChevLeft size={11} />{t('제공업체 다시 고르기', 'Choose provider again')}</button>
              <span className="qsp" />{aiProviderName(engine)} · {t('2 / 3 — 계정', '2 / 3 — Account')}
            </div>
            <div className="qbt">{t('어떤 계정을 사용할까요?', 'Which account would you like to use?')}</div>
            <div className="qopts">
              {accounts === null ? (
                <div className="gitm-state small"><span className="spin" />{t('계정 목록 읽는 중…', 'Reading account list…')}</div>
              ) : accounts.length === 0 ? (
                <div className="gitm-state small">{t(`등록된 ${aiProviderName(engine)} 계정이 없어요 — 설정 → Account에서 로그인해 주세요`, `No ${aiProviderName(engine)} accounts yet — sign in at Settings → Account`)}</div>
              ) : accounts.map(a => (
                <button key={a.email} className={'qopt' + (a.email === account ? ' on' : '')} onClick={() => pickAccount(a.email)}>
                  <span className="ql">{a.email}{a.isDefault ? t(' · 기본', ' · default') : ''}</span>
                  <span className="qd">{usageDesc(usage?.[a.email], usage === null)}</span>
                  <span className="qck"><IconCheck size={14} /></span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="qwrap qstep" key="model">
            <div className="qbl">
              <button className="qback" onClick={() => setStep(2)}><IconChevLeft size={11} />{t('계정 다시 고르기', 'Choose account again')}</button>
              <span className="qsp" />{t('3 / 3 — 모델 · 사고 수준', '3 / 3 — Model · effort')}
            </div>
            <div className="gai-lab">{t('모델', 'Model')}</div>
            <div className="gai-seg">{choices.map(m => <button key={m.id} className={selectedModel === m.id ? 'on' : ''} onClick={() => setModel(m.id)}>{m.label}</button>)}</div>
            <div className="gai-lab">{t('사고 수준 (effort)', 'Effort')}</div>
            <div className="gai-seg">{efforts.map(e => <button key={e.id} className={selectedEffort === e.id ? 'on' : ''} onClick={() => setEffort(e.id)}>{e.label}</button>)}</div>
            {children}
            <div className="qfoot">
              <span className="qhint">{aiProviderName(engine)} · {account}{hint ? ` · ${hint}` : ''}</span>
              <button className="qgo" onClick={submit} disabled={disabled || !account || !selectedModel}>{submitLabel}</button>
            </div>
          </div>
        )}
      </div>
    </div>, document.body
  )
}
