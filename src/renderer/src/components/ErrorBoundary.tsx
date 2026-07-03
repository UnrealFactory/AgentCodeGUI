import { Component, type ErrorInfo, type ReactNode } from 'react'

// 렌더 중 예외 하나가 앱 전체를 백지로 만드는 것을 막는 마지막 안전망. React는 렌더
// 예외가 잡히지 않으면 트리 전체를 언마운트하므로, 워크스페이스 단위로 감싸 크래시를
// 그 화면 안에 가둔다. 대화 기록은 디바운스 저장으로 이미 디스크에 있으니, '다시
// 시도'(경계 리셋)로 대부분 복구되고, 상태 자체가 손상됐다면 '앱 새로고침'으로 재로드.
interface Props {
  children: ReactNode
  label?: string
}
interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', this.props.label ?? '', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    const msg = this.state.error.message || String(this.state.error)
    return (
      <div className="eb">
        <div className="eb-card">
          <div className="eb-title">문제가 발생했어요</div>
          <div className="eb-sub">
            {this.props.label ? `${this.props.label} 화면` : '이 화면'}을 그리는 중 오류가 났어요. 대화 기록은 저장되어
            있습니다.
          </div>
          <div className="eb-msg">{msg}</div>
          <div className="eb-actions">
            <button className="eb-btn" onClick={() => this.setState({ error: null })}>
              다시 시도
            </button>
            <button className="eb-btn eb-btn--ghost" onClick={() => window.location.reload()}>
              앱 새로고침
            </button>
          </div>
        </div>
      </div>
    )
  }
}
