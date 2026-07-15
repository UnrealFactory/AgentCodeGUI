import { useEffect, useState } from 'react'
import { IconMin, IconMax, IconRestore, IconClose } from './icons'

// 2.0 PoC 구조: 풀폭 타이틀바 없음 — 창 컨트롤은 각 모드 헤더(.chat-head/.ma-head)
// 오른쪽 끝에 산다. 드래그는 헤더/사이드바 브랜드의 -webkit-app-region:drag가 담당.
export function WinControls() {
  const [max, setMax] = useState(false)
  useEffect(() => window.api.onWinState((s) => setMax(s.maximized)), [])
  useEffect(() => {
    window.api.win.isMaximized().then(setMax)
  }, [])
  return (
    <div className="win-ctl">
      <button aria-label="최소화" data-tip="최소화" className="has-tip" onClick={() => window.api.win.minimize()}>
        <IconMin size={13} />
      </button>
      <button
        aria-label={max ? '이전 크기로' : '최대화'}
        data-tip={max ? '이전 크기로' : '최대화'}
        className="has-tip"
        onClick={() => window.api.win.toggleMaximize()}
      >
        {max ? <IconRestore size={12} /> : <IconMax size={11} />}
      </button>
      <button className="close has-tip" aria-label="닫기" data-tip="닫기" onClick={() => window.api.win.close()}>
        <IconClose size={13} />
      </button>
    </div>
  )
}
