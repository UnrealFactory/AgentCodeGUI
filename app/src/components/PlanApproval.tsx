import { useEffect, useId, useRef, useState } from 'react'
import type { PlanPreview } from '@shared/protocol'
import { t } from '../lib/i18n'
import { Markdown } from './Markdown'
import { HoverTip } from './HoverTip'
import { IconBook, IconCheck, IconCopy, IconRefresh } from './icons'

export function PlanApproval({ plan, onRespond, hotkeys }: {
  plan?: PlanPreview
  onRespond: (behavior: 'allow' | 'deny') => void
  hotkeys: boolean
}) {
  const titleId = useId()
  const bodyRef = useRef<HTMLDivElement>(null)
  const [revision, setRevision] = useState(0)
  const [reading, setReading] = useState(!!plan?.filePath)
  const [text, setText] = useState(plan?.text ?? '')
  const [error, setError] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)

  useEffect(() => {
    setCopied(false)
    setCopyError(false)
    if (!plan?.filePath) return
    let alive = true
    setReading(true)
    setError('')
    setText('')
    setTruncated(false)
    void window.api.readFile(plan.cwd ?? '', plan.filePath).then(result => {
      if (!alive) return
      if (result.content == null) setError(result.error || t('파일을 읽을 수 없어요.', 'Unable to read the file.'))
      else { setText(result.content); setTruncated(result.truncated) }
    }).catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (alive) setReading(false) })
    return () => { alive = false }
  }, [plan?.filePath, plan?.cwd, revision])

  useEffect(() => {
    if (hotkeys) bodyRef.current?.focus({ preventScroll: true })
  }, [hotkeys])

  useEffect(() => {
    if (!hotkeys) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
      if (e.key === 'Escape') { e.preventDefault(); onRespond('deny') }
      // Reading or copying numbered steps must never approve a plan.
      // Approval is an explicit click (or keyboard activation) of its button.
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hotkeys, onRespond])

  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setCopyError(false) }
    catch { setCopyError(true) }
  }
  return (
    <div className="q-overlay plan-approval-overlay">
      <div className="qcard plan-approval" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="qhead">
          <IconBook size={17} />
          <span className="qhl">{t('계획 검토', 'Review plan')}</span>
          <span className="qsp" />
          {plan?.filePath && <HoverTip text={t('계획 다시 읽기', 'Reload plan')}>
            <button className="qmin" type="button" aria-label={t('계획 다시 읽기', 'Reload plan')}
              disabled={reading} onClick={() => { setReading(true); setRevision(v => v + 1) }}><IconRefresh size={15} /></button>
          </HoverTip>}
          <HoverTip text={copied ? t('복사됨', 'Copied') : t('계획 복사', 'Copy plan')}>
            <button className="qmin" type="button" aria-label={t('계획 복사', 'Copy plan')}
              disabled={reading || !text} onClick={() => void copy()}>{copied ? <IconCheck size={15} /> : <IconCopy size={15} />}</button>
          </HoverTip>
        </div>
        <div id={titleId} className="qbt">{t('이 계획으로 진행할까요?', 'Proceed with this plan?')}</div>
        {plan?.filePath && <HoverTip text={plan.filePath}><div className="plan-approval-path">{plan.filePath}</div></HoverTip>}
        <div ref={bodyRef} className="content plan-approval-body scroll" tabIndex={0} aria-label={t('계획 내용', 'Plan content')} aria-busy={reading}>
          {reading ? <p className="plan-approval-note" role="status">{t('계획을 읽고 있어요…', 'Loading the plan…')}</p>
            : error ? <div className="plan-approval-error" role="alert"><p>{t('계획 파일을 읽지 못했어요.', 'Could not read the plan file.')}</p><p>{error}</p></div>
            : text.trim() ? <Markdown text={text} />
            : <p className="plan-approval-note" role="status">{plan?.filePath
              ? t('계획 파일이 비어 있어요.', 'The plan file is empty.')
              : t('CLI가 계획 내용이나 파일 경로를 전달하지 않았어요.', 'The CLI did not provide plan content or a file path.')}</p>}
        </div>
        {truncated && <p className="plan-approval-warning" role="status">{t('큰 파일이라 앞부분만 표시했어요. 승인 전 원본 파일을 확인해 주세요.', 'Only the beginning of this large file is shown. Review the original before approving.')}</p>}
        {copyError && <p className="plan-approval-warning" role="status">{t('복사하지 못했어요. 내용을 선택해서 복사해 주세요.', 'Copy failed. Select the text to copy it.')}</p>}
        <div className="plan-approval-footer">
          <span>{t('승인하면 계획에 따라 작업을 시작해요.', 'Approval lets the agent begin implementing the plan.')}</span>
          <div className="plan-approval-actions">
            <button type="button" className="set-chipbtn" onClick={() => onRespond('deny')}>{t('승인하지 않기', 'Decline')}</button>
            <button type="button" className="set-chipbtn go" disabled={reading} onClick={() => onRespond('allow')}>{t('계획 승인', 'Approve plan')}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
