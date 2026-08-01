import { useEffect } from 'react'
import { IconAlert, IconClose } from './icons'
import { t } from '../lib/i18n'

// 간단한 알림 카드 — 탐색기 드래그 이동 실패 등 네이티브 alert을 대체한다(앱 .pr-* 카드 톤).
export function NoticeModal({ title, message, onClose }: { title: string; message: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || e.key === 'Enter') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="pr-overlay" onMouseDown={onClose}>
      <div className="pr-modal fop-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="pr-head">
          <div className="pr-ic danger">
            <IconAlert size={18} stroke={2} />
          </div>
          <div className="pr-titles">
            <div className="pr-title">{title}</div>
          </div>
          <button
            className="pr-close has-tip"
            data-tip={t('닫기 (Esc)', 'Close (Esc)')}
            aria-label={t('닫기', 'Close')}
            onClick={onClose}
          >
            <IconClose size={15} />
          </button>
        </div>
        <div className="pr-body">
          <div className="fop-confirm">{message}</div>
        </div>
        <div className="pr-foot">
          <span className="sp" />
          <button className="pr-save" onClick={onClose}>
            {t('확인', 'OK')}
          </button>
        </div>
      </div>
    </div>
  )
}
