import { invoke } from '@tauri-apps/api/core'
import { IPC, type TranslationRequest, type TranslationResult } from '@shared/protocol'
import { t } from '../lib/i18n'

export async function translateText(request: TranslationRequest): Promise<Extract<TranslationResult, { ok: true }>> {
  const result = await invoke<TranslationResult>('ipc_call', { channel: IPC.translateText, payload: [request] })
  if (!result.ok) throw new Error(result.error || t('번역에 실패했어요', 'Translation failed'))
  if (!result.text?.trim()) throw new Error(t('번역 결과가 비어 있어요', 'The translation is empty'))
  return result
}
