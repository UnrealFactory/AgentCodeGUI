import { useEffect, useRef, useState } from 'react'
import { IconClose, IconFile, IconFolder, IconInfo, IconPencil, IconTrash } from './icons'

// 탐색기 파일 작업(이름 변경·새 파일/폴더·삭제)을 앱 공통 카드(.pr-*) 스타일로 띄운다.
// 인라인 입력/네이티브 confirm 대신 이 하나로 통일 — 같은 카드 언어, 에러는 카드 안에서.
export type FileOp =
  | { kind: 'rename'; rel: string; name: string; dir: boolean }
  | { kind: 'delete'; rel: string; name: string; dir: boolean }
  | { kind: 'newFile'; parentRel: string; parentLabel: string }
  | { kind: 'newFolder'; parentRel: string; parentLabel: string }

export function FileOpModal({
  op,
  onSubmit,
  onClose
}: {
  op: FileOp
  // 입력류는 이름을, 삭제는 ''를 넘긴다. ok면 카드가 닫히고, 아니면 에러를 카드에 띄운다.
  onSubmit: (value: string) => Promise<{ ok: boolean; error?: string }>
  onClose: () => void
}) {
  const isInput = op.kind !== 'delete'
  const [val, setVal] = useState(op.kind === 'rename' ? op.name : '')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inRef = useRef<HTMLInputElement>(null)

  // Esc 닫기 — 다른 다이얼로그와 같은 문서 레벨 핸들러
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 입력 카드: 포커스 + 선택(이름 변경 시 파일은 확장자 앞까지만 선택해 바로 고치기 편하게)
  useEffect(() => {
    const el = inRef.current
    if (!el) return
    el.focus()
    if (op.kind === 'rename' && !op.dir) {
      const dot = op.name.lastIndexOf('.')
      if (dot > 0) el.setSelectionRange(0, dot)
      else el.select()
    } else el.select()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submit = async (): Promise<void> => {
    if (busy) return
    const v = val.trim()
    if (isInput && !v) {
      setErr('이름을 입력해 주세요')
      return
    }
    setBusy(true)
    const r = await onSubmit(isInput ? v : '')
    setBusy(false)
    if (r.ok) onClose()
    else setErr(r.error || '실패했어요')
  }

  // 삭제 확인은 채팅 삭제 확인과 같은 중앙 유리 카드(.sconfirm) 문법 — 입력류만 .pr-* 카드
  if (op.kind === 'delete') {
    return (
      <div className="sconfirm" onMouseDown={onClose}>
        <div className="sccard" onMouseDown={(e) => e.stopPropagation()}>
          <div className="scic">
            <IconTrash size={19} />
          </div>
          <div className="sctt">{op.dir ? '폴더 삭제' : '파일 삭제'}</div>
          <div className="sct">
            &lsquo;{op.name}&rsquo; {op.dir ? '폴더를' : '파일을'} 휴지통으로 보내요. 휴지통에서 다시 복구할 수
            있어요.
          </div>
          {err && (
            <div className="fop-err">
              <IconInfo size={14} /> {err}
            </div>
          )}
          <div className="scb">
            <button className="cancel" onClick={onClose}>
              취소
            </button>
            <button className="danger" onClick={() => void submit()} disabled={busy}>
              삭제
            </button>
          </div>
        </div>
      </div>
    )
  }

  const META = {
    rename: { title: '이름 변경', icon: <IconPencil size={18} stroke={2} />, btn: '변경' },
    newFile: { title: '새 파일', icon: <IconFile size={18} stroke={2} />, btn: '만들기' },
    newFolder: { title: '새 폴더', icon: <IconFolder size={18} stroke={2} />, btn: '만들기' }
  }[op.kind]

  const sub = op.kind === 'rename' ? op.name : `${op.parentLabel} 안에 만들기`

  return (
    <div className="pr-overlay" onMouseDown={onClose}>
      <div className="pr-modal fop-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="pr-head">
          <div className="pr-ic">{META.icon}</div>
          <div className="pr-titles">
            <div className="pr-title">{META.title}</div>
            <div className="pr-sub">{sub}</div>
          </div>
          <button className="pr-close has-tip" data-tip="닫기 (Esc)" aria-label="닫기" onClick={onClose}>
            <IconClose size={15} />
          </button>
        </div>

        <div className="pr-body">
          <input
            ref={inRef}
            className="pr-input"
            value={val}
            spellCheck={false}
            placeholder={op.kind === 'newFolder' ? '폴더 이름' : op.kind === 'newFile' ? '파일 이름 (예: test.txt)' : '새 이름'}
            onChange={(e) => {
              setVal(e.target.value)
              setErr(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void submit()
              }
            }}
          />
          {err && (
            <div className="fop-err">
              <IconInfo size={14} /> {err}
            </div>
          )}
        </div>

        <div className="pr-foot">
          <span className="sp" />
          <button className="pr-cancel" onClick={onClose}>
            취소
          </button>
          <button className="pr-save" onClick={() => void submit()} disabled={busy}>
            {META.btn}
          </button>
        </div>
      </div>
    </div>
  )
}
