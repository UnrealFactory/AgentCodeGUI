import { useEffect } from 'react'
import { IconFolder } from './icons'
import { t, isEn } from '../lib/i18n'

function basename(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : p
}

// Card-style confirmation for moving a conversation's working folder. A session id is
// folder-scoped, so moving the folder means the conversation can't continue — this modal
// makes that explicit up front (변경 wipes + starts fresh, 취소 keeps everything) instead
// of silently resetting the thread on the next send. Shared by the single-chat folder
// picker / editor binding and the multi-agent panel + batch folder actions.
export function FolderSwitchDialog({
  from,
  to,
  multi = false,
  onCancel,
  onConfirm
}: {
  from: string // current folder path ('' is fine for batch wording, which doesn't show it)
  to: string // candidate folder path (or an editor's project path)
  multi?: boolean // batch wording: every panel moves at once
  onCancel: () => void
  onConfirm: () => void
}) {
  // Esc cancels — same as clicking the backdrop. The global Esc handlers (run-abort,
  // panel collapse) stand down while a .set-dialog-overlay is open, so this is the only
  // thing Esc does here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="set-dialog-overlay" onMouseDown={onCancel}>
      <div className="set-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sd-ic">
          <IconFolder size={22} />
        </div>
        <div className="sd-title">{t('작업 폴더를 변경할까요?', 'Change the working folder?')}</div>
        {/* 문장 사이에 <b>가 끼는 문구라 t() 한 벌로는 못 담는다 — isEn() 삼항으로 JSX를 통째로 고른다 */}
        <div className="sd-msg">
          {multi ? (
            isEn() ? (
              <>
                Every panel&apos;s working folder becomes <b>{basename(to)}</b>. Panels with a conversation in
                progress are cleared and start over.
              </>
            ) : (
              <>
                모든 패널의 작업 폴더가 <b>{basename(to)}</b>(으)로 바뀝니다. 대화가 진행 중인 패널은 내용이
                지워지고 새 대화로 시작됩니다.
              </>
            )
          ) : isEn() ? (
            <>
              A conversation is scoped to its folder, so switching <b>{basename(from)}</b> →{' '}
              <b>{basename(to)}</b> clears this conversation and starts a new one.
            </>
          ) : (
            <>
              대화는 폴더 단위로 이어지기 때문에 <b>{basename(from)}</b> → <b>{basename(to)}</b>(으)로 바꾸면
              현재 대화 내용이 지워지고 새 대화로 시작됩니다.
            </>
          )}
        </div>
        <div className="sd-btns">
          <button className="sd-cancel" onClick={onCancel}>
            {t('취소', 'Cancel')}
          </button>
          <button className="sd-go danger" onClick={onConfirm}>
            {t('변경', 'Change')}
          </button>
        </div>
      </div>
    </div>
  )
}
