import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { refreshCodexAccount, useAccounts } from '../lib/accounts'
import { consumeCodexReset, pendingCodexReset } from '../lib/codexResetCredits'
import { isEn, t } from '../lib/i18n'
import { IconClose, IconRefresh } from './icons'
import { MouseGestureLayer, scrollGestures } from './mouseGesture'

function dateLabel(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(isEn() ? 'en-US' : 'ko-KR', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  })
}

export function CodexResetCredits({ email, disabled = false }: { email: string; disabled?: boolean }) {
  const { cxUsage, cxLoading } = useAccounts()
  const summary = cxUsage[email]?.rateLimitResetCredits
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [card, setCard] = useState<HTMLDivElement | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const submitting = useRef(false)
  const titleId = useId()
  const count = summary?.availableCount
  const pending = pendingCodexReset(email) != null
  const close = (): void => { setOpen(false); trigger.current?.focus() }

  useEffect(() => {
    if (!open || !card) return
    card.querySelector<HTMLButtonElement>('.cx-reset-close')?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        close()
      } else if (e.key === 'Tab') {
        const items = [...card.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        const first = items[0], last = items.at(-1)
        if (e.shiftKey && (document.activeElement === first || !card.contains(document.activeElement))) {
          e.preventDefault(); last?.focus()
        } else if (!e.shiftKey && (document.activeElement === last || !card.contains(document.activeElement))) {
          e.preventDefault(); first?.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, card])

  const useCredit = async (): Promise<void> => {
    if (submitting.current || disabled || (!pending && !(count != null && count > 0))) return
    submitting.current = true
    setBusy(true)
    setNotice('')
    try {
      const result = await consumeCodexReset(email)
      if (result.outcome === 'error') {
        setNotice(result.error === 'unsupported'
          ? t('이 Codex 버전은 초기화권 사용을 지원하지 않아요. 설정의 Engine에서 업데이트해 주세요.', 'This Codex version does not support resets. Update it in Settings → Engine.')
          : result.error === 'accountUnavailable'
            ? t('이 계정으로 연결할 수 없어요. 로그인 상태와 Codex 설치를 확인해 주세요.', 'Cannot connect to this account. Check its sign-in and Codex installation.')
            : t('사용 결과를 확인하지 못했어요. 다시 확인하면 같은 요청을 조회해 중복 사용을 방지합니다.', 'Could not confirm the result. Retry checks the same request to avoid spending another reset.'))
      } else if (result.outcome === 'reset' || result.outcome === 'alreadyRedeemed') {
        setNotice(result.usage.windows.length && result.usage.rateLimitResetCredits != null
          ? t('초기화권을 사용했어요. 현재 한도와 보유 수량을 갱신했습니다.', 'Reset applied. Usage limits and remaining resets have been refreshed.')
          : t('초기화권 사용은 완료됐어요. 최신 한도와 보유 수량은 새로고침해서 확인해 주세요.', 'Reset applied. Refresh to check the latest usage limits and reset balance.'))
      } else if (result.outcome === 'nothingToReset') {
        setNotice(t('현재 초기화할 수 있는 사용 한도가 없어요. 초기화권은 사용되지 않았습니다.', 'There is no eligible usage limit to reset. No reset was spent.'))
      } else {
        setNotice(t('현재 사용할 수 있는 초기화권이 없어요.', 'There are no resets available to use.'))
      }
    } catch {
      setNotice(t('사용 결과를 확인하지 못했어요. 다시 확인하면 같은 요청으로 재시도합니다.', 'Could not confirm the result. Retry uses the same request.'))
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return <>
    <button ref={trigger} className="cx-reset-trigger" disabled={disabled} onClick={() => setOpen(true)} aria-haspopup="dialog">
      {count != null ? t(`초기화권 ${count}개`, `${count} resets`) : cxLoading ? t('초기화권 조회 중…', 'Loading resets…') : t('초기화권 · 확인 불가', 'Resets · unavailable')}
    </button>
    {open && createPortal(
      <div className="set-dialog-overlay cx-reset-overlay" onMouseDown={(e) => { e.stopPropagation(); close() }} onPointerDown={(e) => e.stopPropagation()}>
        <MouseGestureLayer target={card} actions={[
          ...scrollGestures(() => card?.querySelector('.cx-reset-list')),
          { pattern: 'L', label: t('계정으로 돌아가기', 'Back to account'), run: close },
          { pattern: 'DR', label: t('닫기', 'Close'), run: close }
        ]} />
        <div ref={setCard} className="set-dialog cx-reset-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(e) => e.stopPropagation()}>
          <button className="dc-close cx-reset-close" onClick={close} aria-label={t('닫기', 'Close')}><IconClose size={16} /></button>
          <div className="cx-reset-heading"><IconRefresh size={20} /><h2 id={titleId}>{t('Codex 초기화권', 'Codex resets')}</h2></div>
          <div className="cx-reset-account">{email}</div>
          <div className="cx-reset-balance"><span>{t('사용 가능', 'Available')}</span><strong>{count != null ? t(`${count}개`, String(count)) : '—'}</strong>
            <button className="set-chipbtn" disabled={cxLoading || busy} onClick={() => void refreshCodexAccount(email)}>
              <IconRefresh size={12} /> {cxLoading ? t('조회 중…', 'Loading…') : t('새로고침', 'Refresh')}
            </button>
          </div>
          {summary == null ? <p className="cx-reset-help">{t('초기화권 정보를 받지 못했어요. 계정이나 Codex 버전에 따라 제공되지 않을 수 있습니다.', 'Reset information is unavailable. Availability can depend on the account or Codex version.')}</p>
            : count === 0 ? <p className="cx-reset-help">{t('보유한 초기화권이 없어요.', 'You have no resets available.')}</p>
            : <>
              <div className="cx-reset-list scroll">
                {summary.credits?.map((credit) => <div className="cx-reset-credit" key={credit.id}>
                  <div>{credit.title || t('사용 한도 초기화권', 'Usage-limit reset')}</div>
                  {credit.description && <p>{credit.description}</p>}
                  <span>{t('지급', 'Granted')} · {dateLabel(credit.grantedAt)}</span>
                  <span>{credit.expiresAt == null ? t('만료일 없음', 'No expiry') : t('만료', 'Expires') + ' · ' + dateLabel(credit.expiresAt)}</span>
                </div>)}
              </div>
              {(summary.credits == null || summary.credits.length < (count ?? 0)) && <p className="cx-reset-help">{t('일부 초기화권의 상세 정보는 제공되지 않았어요. 위 보유 수량이 전체 수량입니다.', 'Some reset details are unavailable. The count above is your total balance.')}</p>}
              <p className="cx-reset-help">{t('1개를 사용하면 이 계정에서 초기화 가능한 사용 한도가 재설정됩니다.', 'Use one reset to restore eligible usage limits for this account.')}</p>
            </>}
          {notice && <p className="cx-reset-notice" role="status">{notice}</p>}
          {!notice && pending && <p className="cx-reset-notice" role="status">{t('이전에 보낸 사용 요청의 결과를 확인할 수 있어요.', 'You can check the result of your previous reset request.')}</p>}
          <div className="sd-btns">
            <button className="sd-cancel" onClick={close}>{t('닫기', 'Close')}</button>
            <button className="sd-go cx-reset-use" disabled={disabled || busy || cxLoading || (!pending && !(count != null && count > 0))} onClick={() => void useCredit()}>
              {busy ? t('확인 중…', 'Checking…') : pending ? t('사용 결과 다시 확인', 'Check reset result') : t('초기화권 1개 사용', 'Use 1 reset')}
            </button>
          </div>
        </div>
      </div>, document.body
    )}
  </>
}
