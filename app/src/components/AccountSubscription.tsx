import { useState } from 'react'
import type { CodexAccountInfo } from '@shared/protocol'
import { isEn, t } from '../lib/i18n'
import { subscriptionAction, useWebSubscription, type WebSubscription } from '../api/subscriptions'

/** 공급자가 실제 제공한 구독 기간과 관리 화면만 표시합니다. */
export function AccountSubscription({ provider, email, period }: {
  provider: 'claude' | 'codex'
  email: string
  period?: CodexAccountInfo['subscriptionPeriod']
}): React.ReactElement {
  const web = useWebSubscription(provider, email)
  const [failed, setFailed] = useState<string | null>(null)
  const [acting, setActing] = useState(false)
  const format = (seconds?: number | null): string | null => {
    if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null
    const date = new Date(seconds * 1000)
    if (!Number.isFinite(date.getTime())) return null
    return date.toLocaleDateString(isEn() ? 'en-US' : 'ko-KR', { year: 'numeric', month: 'short', day: 'numeric' })
  }
  const data = web?.data
  const busy = acting || (web != null && web.phase !== 'idle')
  const webDate = data?.date ? new Date(data.date.length === 10 ? data.date + 'T00:00:00' : data.date) : null
  const dateText = webDate && Number.isFinite(webDate.getTime()) ? webDate.toLocaleDateString(isEn() ? 'en-US' : 'ko-KR', { year: 'numeric', month: 'short', day: 'numeric' }) : null
  const labels: Record<NonNullable<WebSubscription['data']>['kind'], string> = {
    renews: t('자동 갱신 예정', 'Renews'), cancels: t('취소 예정', 'Cancellation scheduled'), ended: t('구독 종료', 'Subscription ended'),
    paused: t('구독 일시 중지', 'Subscription paused'), trial: t('체험 종료', 'Trial ends'), scheduled: t('구독 변경 예정', 'Subscription change scheduled'),
    active: t('구독 중', 'Subscribed'), none: t('유료 구독 없음', 'No paid subscription'), unknown: t('구독 상태 확인 필요', 'Check subscription status'), paymentDue: t('결제 확인 필요', 'Payment needs attention')
  }
  const ends = format(period?.endsAt)
  const checked = format(period?.checkedAt)
  const past = period != null && period.endsAt * 1000 <= Date.now()
  const detail = ends
    ? [
        checked ? t(`${checked}에 확인한 정보입니다.`, `Last checked on ${checked}.`) : t('로그인할 때 확인된 정보입니다.', 'Information from the saved sign-in.'),
        t('자동 갱신·취소 여부와 최신 날짜는 구독 관리에서 확인해 주세요.', 'Check subscription settings for renewal, cancellation, and the latest date.')
      ].join(' ')
    : t('현재 계정 연결에서는 결제 날짜를 확인할 수 없어요.', 'Billing dates are unavailable from this account connection.')
  const url = provider === 'claude' ? 'https://claude.ai/settings/billing' : 'https://chatgpt.com/#settings/Account'
  const open = async (): Promise<void> => {
    setFailed(null)
    try { if (!(await window.api.openExternal(url))) setFailed('browserOpen') } catch { setFailed('browserOpen') }
  }
  const action = async (name: 'connect' | 'refresh' | 'cancel' | 'disconnect'): Promise<void> => {
    setActing(true); setFailed(null)
    try { await subscriptionAction(name, provider, email) } catch (e) { setFailed(e instanceof Error ? e.message : 'unavailable') }
    finally { setActing(false) }
  }
  const error = failed ?? web?.error
  const errors: Record<string, string> = {
    needsLogin: t('웹 연결을 다시 확인해 주세요.', 'Reconnect to verify your web sign-in.'),
    wrongAccount: t('다른 계정으로 로그인되어 있어요. 이 계정으로 다시 연결해 주세요.', 'A different account is signed in. Reconnect with this account.'),
    identityMissing: t('앱 계정 정보를 확인할 수 없어요. 해당 계정으로 채팅을 실행하거나 다시 로그인해 주세요.', 'Account details are unavailable. Run a chat with this account or sign in again.'),
    browserMissing: t('연결에 사용할 Chrome 또는 Edge를 찾지 못했어요.', 'Chrome or Edge could not be found.'),
    runtimeMissing: t('앱의 브라우저 연결 도구를 찾지 못했어요.', 'The app’s browser connection tool is unavailable.'),
    saveFailed: t('구독 정보를 저장하지 못했어요.', 'Could not save subscription details.'),
    browserOpen: t('브라우저를 열지 못했어요.', 'Could not open the browser.'),
    busy: t('조회가 끝난 뒤 다시 시도해 주세요.', 'Try again after the current check.'),
    cancelled: t('웹 연결을 취소했어요.', 'Connection cancelled.'), closed: t('구독 정보를 확인하기 전에 창이 닫혔어요.', 'The browser closed before subscription details were read.')
  }
  const outdated = data != null && (Boolean(error) || Date.now() / 1000 - data.checkedAt >= 21600 || (webDate != null && webDate.getTime() <= Date.now() && !['ended', 'none'].includes(data.kind)))
  return (
    <div className="acct-subscription" onPointerDown={(event) => event.stopPropagation()}>
      <span className={data?.kind === 'cancels' ? 'acct-subscription-cancels' : undefined} title={data ? t('연결한 웹 계정에서 확인한 구독 정보입니다.', 'Subscription details from the connected web account.') : detail}>
        {data ? <>{outdated && t('최근 확인: ', 'Last known: ')}{labels[data.kind]}{dateText && ` · ${dateText}`}</> : ends
          ? past ? t(`이전 구독 기간 종료 ${ends}`, `Last subscription period ended ${ends}`) : t(`구독 기간 종료 ${ends}`, `Subscription period ends ${ends}`)
          : t('웹 연결로 구독 날짜 확인', 'Connect to check subscription dates')}
      </span>
      {data && <span className="acct-subscription-checked" title={new Date(data.checkedAt * 1000).toLocaleString(isEn() ? 'en-US' : 'ko-KR')}>
        {t(`${new Date(data.checkedAt * 1000).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })} 확인`, `Checked ${new Date(data.checkedAt * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`)}
      </span>}
      <div className="acct-subscription-actions">
      {busy ? <>
        <span>{web?.phase === 'queued' ? t('확인 대기 중…', 'Queued…') : web?.phase === 'refreshing' ? t('확인 중…', 'Checking…') : t('웹 로그인 연결 중…', 'Connecting…')}</span>
        <button className="acct-subscription-link" disabled={acting} onClick={() => void action('cancel')}>{t('취소', 'Cancel')}</button>
      </> : <>
        {web?.connected && !error
          ? <button className="acct-subscription-link" onClick={() => void action('refresh')}>{t('새로고침', 'Refresh')}</button>
          : <button className="acct-subscription-link" onClick={() => void action('connect')}>{web?.connected ? t('다시 연결', 'Reconnect') : t('웹 연결', 'Connect web account')}</button>}
        {web?.connected && <button className="acct-subscription-link" onClick={() => void action('disconnect')}>{t('연결 해제', 'Disconnect')}</button>}
      </>}
      <button
        className="acct-subscription-link"
        onClick={() => void open()}
        title={t(`브라우저에서 ${email} 계정인지 확인해 주세요.`, `Make sure the browser is signed in as ${email}.`)}
        aria-label={t(`${email} 구독 관리 열기`, `Open subscription settings for ${email}`)}
      >{t('구독 관리 ↗', 'Manage subscription ↗')}</button>
      </div>
      {(web?.phase === 'connecting' || web?.phase === 'wrongAccount') && <span className="acct-subscription-help" role="status">
        {web.phase === 'wrongAccount'
          ? t(`다른 계정입니다. 열린 브라우저에서 ${email} 계정으로 변경해 주세요.`, `Different account. Switch to ${email} in the browser.`)
          : t(`열린 브라우저에서 ${email} 계정으로 로그인해 주세요.`, `Sign in as ${email} in the browser.`)}
      </span>}
      {error && !busy && <span role="alert">{errors[error] ?? t('구독 정보를 가져오지 못했어요. 다시 연결해 주세요.', 'Could not fetch subscription details. Reconnect to try again.')}</span>}
    </div>
  )
}
