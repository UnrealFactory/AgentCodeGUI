import { useEffect, useRef, useState } from 'react'
import { externalToolGuide } from '../lib/externalToolGuide'
import { t, useLang } from '../lib/i18n'
import { IconCheck, IconCopy } from './icons'
import './externalToolsSettings.css'

export function ExternalToolsSettingsView() {
  const language = useLang()
  const guide = externalToolGuide(language)
  const preview = useRef<HTMLTextAreaElement>(null)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)

  useEffect(() => { setCopied(false); setCopyFailed(false) }, [language])
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 2500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const selectGuide = (): void => { preview.current?.focus(); preview.current?.select() }
  const copyGuide = async (): Promise<void> => {
    setCopied(false); setCopyFailed(false)
    try {
      await navigator.clipboard.writeText(guide)
      setCopied(true)
    } catch {
      selectGuide()
      setCopyFailed(true)
    }
  }

  return <div className="external-tools-settings">
    <div className="set-h1">{t('외부 도구 연동', 'External tool integration')}</div>
    <div className="set-h1-sub">{t('내 프로그램에서 선택한 내용과 현재 상태를 대화에 연결하세요.', 'Bring selections and current state from your own program into your conversations.')}</div>

    <section className="sc2 ext-guide-card">
      <h2>{t('개발 AI에게 연동 맡기기', 'Ask your coding AI to connect your program')}</h2>
      <p>{t('아래 지침을 복사해 연결할 프로그램을 개발하는 AI에게 붙여넣으세요. 연결 규격과 참고 코드, 동작 확인 방법이 함께 전달됩니다.', 'Copy the instructions below and paste them into the AI working on your program. They include the protocol, reference code, and checks to verify the integration.')}</p>
      <div className="ext-guide-actions">
        <button type="button" className="set-chipbtn go ext-guide-copy" onClick={() => { void copyGuide() }}>
          {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          {copied ? t('복사했습니다', 'Copied') : t('AI용 연동 지침 복사', 'Copy instructions for AI')}
        </button>
        <span className="ext-guide-status" role="status">{copied ? t('개발 AI에게 붙여넣어 주세요.', 'Paste them into your coding AI.') : 'External Tools API v1'}</span>
      </div>
    </section>

    <ol className="ext-guide-steps">
      <li><span>1</span><div><strong>{t('지침 복사', 'Copy the instructions')}</strong><p>{t('연동에 필요한 설명과 예제를 한 번에 복사합니다.', 'Get the instructions and examples in one copy.')}</p></div></li>
      <li><span>2</span><div><strong>{t('개발 AI에게 붙여넣기', 'Paste into your coding AI')}</strong><p>{t('연결할 프로그램을 열고, 전달하고 싶은 내용도 함께 알려주세요.', 'Open your program’s project and describe what you want to share.')}</p></div></li>
      <li><span>3</span><div><strong>{t('세션에서 도구 연결', 'Connect in a session')}</strong><p>{t('구현한 프로그램을 실행한 뒤, 대화 상단의 도구 연결에서 선택하세요.', 'Run your integrated program, then select it under tool connections at the top of a conversation.')}</p></div></li>
    </ol>

    <div className="ext-guide-preview-heading">
      <label htmlFor="external-tool-guide">{t('복사할 내용', 'Instructions to copy')}</label>
      <button type="button" className="set-chipbtn" onClick={selectGuide}>{t('전체 선택', 'Select all')}</button>
    </div>
    {copyFailed && <p className="ext-guide-error" role="alert">{t('자동 복사가 되지 않았습니다. 아래 선택된 내용을 Ctrl+C로 복사해 주세요.', 'Automatic copying failed. Copy the selected instructions below with Ctrl+C.')}</p>}
    <textarea ref={preview} id="external-tool-guide" className="ext-guide-preview scroll" value={guide} readOnly spellCheck={false} />
  </div>
}
