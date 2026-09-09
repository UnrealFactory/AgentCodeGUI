import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TranslationLanguage, TranslationResult, TranslationSession } from '@shared/protocol'
import { translateText } from '../api/translation'
import { t } from '../lib/i18n'
import { getTranslationSettings, loadTranslationSettings, translationLanguages, translationTarget, TRANSLATION_TEXT_LIMIT } from '../lib/translationSettings'
import { SettingsModal } from './Settings'
import { SelectMenu } from './SelectMenu'
import { IconCheck, IconClose, IconCopy, IconGear, IconTranslate } from './icons'

export function TranslationDialog({ text, session, anchor, onClose }: {
  text: string
  session: TranslationSession
  anchor: { x: number; y: number }
  onClose: () => void
}) {
  const [target, setTarget] = useState<TranslationLanguage>(() => translationTarget(getTranslationSettings(), text))
  const [result, setResult] = useState<Extract<TranslationResult, { ok: true }> | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [position, setPosition] = useState({ x: anchor.x + 12, y: anchor.y + 12 })
  const generation = useRef(0)
  const card = useRef<HTMLElement>(null)
  const dragging = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const settingsRevision = useRef(0)
  const tooLong = [...text].length > TRANSLATION_TEXT_LIMIT

  const run = useCallback(async (language?: TranslationLanguage) => {
    const id = ++generation.current
    setCopied(false); setCopyError(false); setError(''); setResult(null)
    if (tooLong) { setBusy(false); return }
    setBusy(true)
    try {
      const settings = await loadTranslationSettings()
      if (id !== generation.current) return
      settingsRevision.current = settings.updatedAt
      const targetLanguage = language ?? translationTarget(settings, text)
      setTarget(targetLanguage)
      const response = await translateText({ text, session, targetLanguage, models: settings.models })
      if (id === generation.current) setResult(response)
    } catch (e) {
      if (id === generation.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (id === generation.current) setBusy(false)
    }
  }, [text, session.chatId, session.panelId, tooLong])

  useEffect(() => {
    void run()
    return () => { generation.current += 1 }
  }, [run])
  useEffect(() => {
    if (settingsOpen) return
    card.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (document.querySelector('.select-menu-popover')) return
      e.preventDefault(); e.stopImmediatePropagation(); onClose()
    }
    const onPointerDown = (e: PointerEvent) => {
      const el = card.current, target = e.target as Node
      if (!el || el.contains(target)) return
      // The language list is portaled outside the card but still belongs to it.
      const menuId = el.querySelector('[role="combobox"]')?.getAttribute('aria-controls')
      if (menuId && document.getElementById(menuId)?.contains(target)) return
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [settingsOpen, onClose])
  useLayoutEffect(() => {
    const el = card.current
    if (!el || settingsOpen) return
    const place = (initial = false) => {
      const r = el.getBoundingClientRect()
      setPosition(p => {
        const left = initial ? (anchor.x + r.width + 24 < innerWidth ? anchor.x + 12 : anchor.x - r.width - 12) : p.x
        const x = Math.max(12, Math.min(left, innerWidth - r.width - 12))
        const y = Math.max(12, Math.min(initial ? anchor.y + 12 : p.y, innerHeight - r.height - 12))
        return p.x === x && p.y === y ? p : { x, y }
      })
    }
    place(true)
    const resize = () => place()
    const observer = new ResizeObserver(resize)
    observer.observe(el)
    window.addEventListener('resize', resize)
    return () => { observer.disconnect(); window.removeEventListener('resize', resize) }
  }, [anchor.x, anchor.y, settingsOpen])

  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
    if (getTranslationSettings().updatedAt !== settingsRevision.current) void run()
  }, [run])
  const copy = async () => {
    try { await navigator.clipboard.writeText(result!.text); setCopied(true); setCopyError(false) }
    catch { setCopyError(true) }
  }

  if (settingsOpen) return createPortal(<SettingsModal initialView="translation" onClose={closeSettings} />, document.body)

  return createPortal(
    <section className="translation-popover" role="dialog" aria-label={t('번역', 'Translation')} ref={card} tabIndex={-1}
      style={{ left: position.x, top: position.y }}>
      <header className="translation-topbar"
        onPointerDown={e => {
          if (e.button !== 0 || (e.target as HTMLElement).closest('button, select')) return
          dragging.current = { x: e.clientX, y: e.clientY, left: position.x, top: position.y }
          e.currentTarget.setPointerCapture(e.pointerId)
          e.preventDefault()
        }}
        onPointerMove={e => {
          const d = dragging.current, r = card.current?.getBoundingClientRect()
          if (!d || !r) return
          setPosition({ x: Math.max(12, Math.min(d.left + e.clientX - d.x, innerWidth - r.width - 12)), y: Math.max(12, Math.min(d.top + e.clientY - d.y, innerHeight - r.height - 12)) })
        }}
        onPointerUp={() => { dragging.current = null }} onPointerCancel={() => { dragging.current = null }}>
        <span className="translation-title"><IconTranslate size={16} />{t('번역', 'Translation')}</span>
        <span className="qsp" />
        <button className="translation-icon" aria-label={t('번역 설정', 'Translation settings')} disabled={busy} onClick={() => setSettingsOpen(true)}><IconGear size={15} /></button>
        <button className="translation-icon" aria-label={t('닫기', 'Close')} onClick={onClose}><IconClose size={15} /></button>
      </header>
      <div className="translation-controls">
        <SelectMenu label={t('번역 언어', 'Translate to')} value={target} options={translationLanguages()} disabled={busy}
          onChange={value => void run(value as TranslationLanguage)} />
      </div>
      <div className={'translation-output' + (busy || error || tooLong ? ' is-status' : '')} lang={target} tabIndex={0} aria-busy={busy}>
        {busy ? <div className="translation-state" role="status"><span className="spin" />{t('번역 중…', 'Translating…')}</div>
          : tooLong ? <div className="translation-error" role="alert">{t('한 번에 50,000자까지 번역할 수 있어요. 더 짧은 부분을 선택해 주세요.', 'Select a shorter passage. You can translate up to 50,000 characters at a time.')}</div>
          : error ? <div className="translation-error" role="alert">{error}</div> : result?.text}
      </div>
      <footer className="translation-footer">
        <button className="translation-copy" disabled={!result || busy} onClick={() => void copy()}>
          {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}{copied ? t('복사됨', 'Copied') : t('복사', 'Copy')}
        </button>
        <span className="translation-model">{result?.model}</span>
        {result?.engine === 'codex' && result.codexTier && <span className="translation-speed">{result.codexTier === 'priority' ? 'Fast' : result.codexTier === 'ultrafast' ? 'Ultrafast' : result.codexTier}</span>}
      </footer>
      {copyError && <div className="translation-error" role="alert">{t('번역문을 선택해 복사해 주세요.', 'Select the translation and copy it manually.')}</div>}
    </section>, document.body
  )
}
