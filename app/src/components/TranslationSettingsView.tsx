import { useEffect, useState } from 'react'
import type { EngineId } from '@shared/protocol'
import { t } from '../lib/i18n'
import { getTranslationSettings, loadTranslationSettings, saveTranslationSettings, translationLanguages, type TranslationSettings } from '../lib/translationSettings'
import { AI_TEXT_MODELS, aiTextEfforts } from './AiRequestPicker'
import { codexModelEfforts, useCodexModels } from './Chat'
import { IconCheck, IconTranslate, LogoClaude, LogoOpenAI } from './icons'
import { SelectMenu } from './SelectMenu'

export function TranslationSettingsView() {
  const [settings, setSettings] = useState(getTranslationSettings)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const codex = useCodexModels('codex')
  useEffect(() => {
    let alive = true
    void loadTranslationSettings().then(value => { if (alive) setSettings(value) })
      .catch(e => { if (alive) setError(String(e)) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])
  const update = (next: TranslationSettings) => { setSettings(next); saveTranslationSettings(next) }
  const changeModel = (engine: EngineId, model: string) => {
    const efforts = engine === 'codex' ? codexModelEfforts(model) : aiTextEfforts().map(e => e.id)
    const previous = settings.models[engine]
    const codexTier = engine === 'codex' && codex.find(m => m.id === model)?.tiers?.some(t => t.id === previous.codexTier) ? previous.codexTier : undefined
    update({ ...settings, models: { ...settings.models, [engine]: { model, effort: efforts.includes(previous.effort) ? previous.effort : efforts[0], codexTier } } })
  }
  return <div className="translation-settings">
    <div className="set-h1">{t('번역', 'Translation')}</div>
    <div className="set-h1-sub">{t('문장을 선택하고 번역을 누르면 이 설정으로 바로 번역해요.', 'Select a passage and click Translate to use these settings immediately.')}</div>
    <div className="translation-session-note"><IconCheck size={16} /><div><b>{t('현재 세션의 계정 사용', 'Use the current session account')}</b><p>{t('번역을 연 채팅의 제공업체와 계정을 자동으로 사용해요. 모델과 사고 수준은 아래 설정을 따라요.', 'Translation automatically uses the provider and account of the chat it was opened from, with the model and effort configured below.')}</p></div></div>
    {error && <div className="translation-error" role="alert">{error}</div>}
    <fieldset disabled={loading}>
      <section className="sc2 translation-language-setting">
        <div className="translation-setting-heading"><IconTranslate size={17} /><div className="em">{t('기본 번역 언어', 'Default target language')}</div></div>
        <SelectMenu label={t('기본 번역 언어', 'Default target language')} value={settings.targetLanguage} disabled={loading}
          options={[{ id: 'auto', label: t('자동 — 한국어는 영어로, 그 외는 한국어로', 'Automatic — Korean to English, other languages to Korean') }, ...translationLanguages()]}
          onChange={value => update({ ...settings, targetLanguage: value as TranslationSettings['targetLanguage'] })} />
      </section>
      {(['claude', 'codex'] as const).map(engine => {
        const choices = engine === 'codex' ? codex.map(m => ({ id: m.id, label: m.v })) : AI_TEXT_MODELS
        const selected = settings.models[engine]
        const tiers = engine === 'codex' ? codex.find(m => m.id === selected.model)?.tiers ?? [] : []
        const selectedTier = tiers.find(t => t.id === selected.codexTier)
        const efforts = engine === 'codex' ? codexModelEfforts(selected.model) : aiTextEfforts().map(e => e.id)
        const Logo = engine === 'codex' ? LogoOpenAI : LogoClaude
        const provider = engine === 'codex' ? 'OpenAI' : 'Anthropic'
        return <section key={engine} className="sc2 translation-provider-setting" data-engine={engine}>
          <div className="translation-setting-heading"><Logo size={19} /><div className="em">{provider}</div><span>{t('번역에 사용할 모델', 'Translation model')}</span></div>
          <div className={'translation-setting-fields' + (engine === 'codex' ? ' with-speed' : '')}>
            <div className="translation-setting-field"><span>{t('모델', 'Model')}</span><SelectMenu label={`${provider} ${t('번역 모델', 'translation model')}`} value={selected.model} disabled={loading}
              options={choices.some(m => m.id === selected.model) ? choices : [{ id: selected.model, label: selected.model }, ...choices]}
              onChange={value => changeModel(engine, value)} /></div>
            <div className="translation-setting-field"><span>{t('사고 수준', 'Effort')}</span><SelectMenu label={`${provider} ${t('번역 사고 수준', 'translation effort')}`} value={selected.effort} disabled={loading}
              options={(efforts.includes(selected.effort) ? efforts : [selected.effort, ...efforts]).map(id => ({ id, label: aiTextEfforts().find(e => e.id === id)?.label ?? id }))}
              onChange={value => update({ ...settings, models: { ...settings.models, [engine]: { ...selected, effort: value } } })} /></div>
            {engine === 'codex' && <div className="translation-setting-field"><span>{t('속도', 'Speed')}</span><SelectMenu label={t('OpenAI 번역 속도', 'OpenAI translation speed')} value={selected.codexTier ?? ''} disabled={loading}
              options={[{ id: '', label: t('표준', 'Standard') }, ...tiers.map(t => ({ id: t.id, label: t.name })),
                ...(selected.codexTier && !selectedTier ? [{ id: selected.codexTier, label: selected.codexTier }] : [])]}
              onChange={value => update({ ...settings, models: { ...settings.models, codex: { ...selected, codexTier: value || undefined } } })} /></div>}
          </div>
          {engine === 'codex' && <p className="translation-speed-note">{selectedTier?.desc || t('모델에서 지원하는 번역 속도를 선택할 수 있어요.', 'Choose a translation speed supported by the model.')}</p>}
        </section>
      })}
    </fieldset>
    <p className="translation-save-note">{t('변경 사항은 자동으로 저장됩니다.', 'Changes are saved automatically.')}</p>
  </div>
}
