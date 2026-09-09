import type { TranslationLanguage, TranslationModels } from '@shared/protocol'
import { getPref, patchPref, setPref } from './prefs'
import { t } from './i18n'

const KEY = 'translation.settings'
export const TRANSLATION_TEXT_LIMIT = 50_000
export interface TranslationSettings {
  targetLanguage: TranslationLanguage | 'auto'
  models: TranslationModels
  updatedAt: number
}
export const translationLanguages = (): { id: TranslationLanguage; label: string }[] => [
  { id: 'ko', label: t('한국어', 'Korean') }, { id: 'en', label: t('영어', 'English') },
  { id: 'ja', label: t('일본어', 'Japanese') }, { id: 'zh-CN', label: t('중국어 (간체)', 'Chinese (Simplified)') },
  { id: 'fr', label: t('프랑스어', 'French') }, { id: 'de', label: t('독일어', 'German') }, { id: 'es', label: t('스페인어', 'Spanish') }
]
function normalize(value: unknown): TranslationSettings {
  const v = value as Partial<TranslationSettings> | null
  const model = (engine: 'claude' | 'codex', field: 'model' | 'effort', fallback: string) => {
    const saved = v?.models?.[engine]?.[field]
    const legacy = getPref<unknown>(`translation.ai.${engine === 'codex' ? 'codex.' : ''}${field}`, fallback)
    return typeof saved === 'string' && saved.trim() ? saved : typeof legacy === 'string' && legacy.trim() ? legacy : fallback
  }
  const tier = v?.models?.codex?.codexTier
  return {
    targetLanguage: translationLanguages().some(l => l.id === v?.targetLanguage) ? v!.targetLanguage! : 'auto',
    models: {
      claude: { model: model('claude', 'model', 'sonnet'), effort: model('claude', 'effort', 'low') },
      codex: { model: model('codex', 'model', 'gpt-5.6-terra'), effort: model('codex', 'effort', 'low'),
        codexTier: typeof tier === 'string' && tier.trim() ? tier.trim() : undefined }
    },
    updatedAt: typeof v?.updatedAt === 'number' ? v.updatedAt : 0
  }
}
export function getTranslationSettings(): TranslationSettings { return normalize(getPref(KEY, null)) }
export function saveTranslationSettings(value: TranslationSettings): void {
  setPref(KEY, { ...value, updatedAt: Date.now() })
}
/** Pick up changes made in another window; keep local edits during the preference save debounce. */
export async function loadTranslationSettings(): Promise<TranslationSettings> {
  const prefs = await window.api.getUiPrefs()
  const local = getTranslationSettings()
  const saved = normalize(prefs?.[KEY])
  if (saved.updatedAt > local.updatedAt) { patchPref(KEY, saved); return saved }
  return local
}
export function translationTarget(settings: TranslationSettings, text: string): TranslationLanguage {
  return settings.targetLanguage === 'auto' ? (/[가-힣]/.test(text) ? 'en' : 'ko') : settings.targetLanguage
}
