import { Component, type ErrorInfo, type ReactNode } from 'react'
import { t } from '../lib/i18n'

// 렌더 중 예외 하나가 앱 전체를 백지로 만드는 것을 막는 마지막 안전망. React는 렌더
// 예외가 잡히지 않으면 트리 전체를 언마운트하므로, 워크스페이스 단위로 감싸 크래시를
// 그 화면 안에 가둔다. 대화 기록은 디바운스 저장으로 이미 디스크에 있으니, '다시
// 시도'(경계 리셋)로 대부분 복구되고, 상태 자체가 손상됐다면 '앱 새로고침'으로 재로드.
//
// ── ★R28f SHIPBLOCK N2 — 2.6.2에서 분기한다(장부 §6.9) ────────────────────────
// 최종 파리티 감사 R2 §N2의 실측: 예외를 던지는 채팅을 고르면 **화면에 사이드바도 창
// 크롬도 없고**, 「앱 새로고침」을 눌러도 3.0은 같은 카드로 되돌아온다(3.0은 활성 채팅을
// 즉시 영속하므로 — `chats_v3::set_active`). 카드 문구는 *"대화 기록은 저장되어 있습니다"*
// 인데 **그 기록에 닿을 길이 없었다.**
//
// 이 파일이 받는 몫은 둘이다:
//  · `resetKey` — 값이 바뀌면 경계가 **스스로** 풀린다. 크롬(사이드바)이 경계 밖에 남으면
//    사용자가 다른 대화를 고를 수 있는데, 그때 경계가 error 상태로 굳어 있으면 아무 일도
//    안 일어난다. 「다시 시도」를 한 번 더 누르게 하지 않는다.
//  · `onError` — **무엇이 터졌는지**를 호스트가 안다(App은 그 순간의 활성 채팅 id를 안다).
//    그 사실이 부팅 격리(`App.tsx`의 `quarantine`)의 유일한 재료다.
interface Props {
  children: ReactNode
  label?: string
  /** 이 값이 바뀌면 경계를 리셋한다(예: 활성 채팅 전환). */
  resetKey?: string | number
  /** 렌더 예외가 잡힌 직후 1회. 호스트가 "무엇이 터졌나"를 적어 두는 자리. */
  onError?: (error: Error) => void
}
interface State {
  error: Error | null
  /** 리셋 판정용 — 마지막으로 본 `resetKey`. */
  key?: string | number
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  // 렌더 중에 도는 순수 함수다 — 여기서 하는 일은 **비교와 상태 반환**뿐이다.
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (state.key === props.resetKey) return null
    // 키가 바뀌었다 = 다른 것을 그리라는 뜻 → 경계를 푼다(첫 렌더도 여기를 지난다).
    return { key: props.resetKey, error: null }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', this.props.label ?? '', error, info.componentStack)
    try {
      this.props.onError?.(error)
    } catch {
      /* 보고가 실패해도 카드는 떠야 한다 */
    }
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    const msg = this.state.error.message || String(this.state.error)
    return (
      <div className="eb">
        <div className="eb-card">
          <div className="eb-title">{t('문제가 발생했어요', 'Something went wrong')}</div>
          <div className="eb-sub">
            {t(
              `${this.props.label ? `${this.props.label} 화면` : '이 화면'}을 그리는 중 오류가 났어요. 대화 기록은 저장되어 있습니다.`,
              `An error occurred while rendering ${this.props.label ? `the ${this.props.label} screen` : 'this screen'}. Your conversation history is saved.`
            )}
          </div>
          <div className="eb-msg">{msg}</div>
          <div className="eb-actions">
            <button className="eb-btn" onClick={() => this.setState({ error: null })}>
              {t('다시 시도', 'Try again')}
            </button>
            <button className="eb-btn eb-btn--ghost" onClick={() => window.location.reload()}>
              {t('앱 새로고침', 'Reload app')}
            </button>
          </div>
        </div>
      </div>
    )
  }
}
