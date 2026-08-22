import { useEffect, useState } from 'react'
import { IconMin, IconMax, IconRestore, IconClose } from './icons'
import { t, useLang } from '../lib/i18n'

// 2.0 PoC 구조: 풀폭 타이틀바 없음 — 창 컨트롤은 각 모드 헤더(.chat-head/.ma-head)
// 오른쪽 끝에 산다. 드래그는 헤더/사이드바 브랜드의 -webkit-app-region:drag가 담당.
export function WinControls() {
  useLang() // 언어 전환 재렌더 구독 — memo된 헤더 안에서도 툴팁이 따라오게
  const [max, setMax] = useState(false)
  useEffect(() => window.api.onWinState((s) => setMax(s.maximized)), [])
  useEffect(() => {
    window.api.win.isMaximized().then(setMax)
  }, [])
  return (
    <div className="win-ctl">
      <button
        aria-label={t('최소화', 'Minimize')}
        data-tip={t('최소화', 'Minimize')}
        className="has-tip"
        onClick={() => window.api.win.minimize()}
      >
        <IconMin size={13} />
      </button>
      <button
        aria-label={max ? t('이전 크기로', 'Restore') : t('최대화', 'Maximize')}
        data-tip={max ? t('이전 크기로', 'Restore') : t('최대화', 'Maximize')}
        className="has-tip"
        onClick={() => window.api.win.toggleMaximize()}
      >
        {max ? <IconRestore size={12} /> : <IconMax size={11} />}
      </button>
      <button
        className="close has-tip"
        aria-label={t('닫기', 'Close')}
        data-tip={t('닫기', 'Close')}
        onClick={() => window.api.win.close()}
      >
        <IconClose size={13} />
      </button>
    </div>
  )
}
