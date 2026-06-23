import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChangedFile } from '@shared/protocol'
import { FileTree } from './FileTree'
import { IconFolder, IconFolderOpen, IconClose } from './icons'

const MENU_W = 270

function basename(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : p
}

/**
 * 패널 폴더 칩에서 펼쳐지는 파일 트리 팝오버(시안 B). 단일 모드 탐색기의 트리를
 * 그대로(FileTree) 칩 아래에 띄운다 — 영구 칼럼 없이 패널별 폴더를 그 자리에서 탐색.
 *
 * body로 포털한 fixed 박스라(같은 코드베이스의 ctx-menu/ScrollTip 패턴) 패널의
 * overflow·확대 오버레이에 잘리지 않는다. 칩 사각형(anchor)을 기준으로 아래에 띄우고
 * 화면 가장자리에서 클램프, 아래가 좁으면 위로 뒤집는다.
 */
export function PanelFolderMenu({
  anchor,
  cwd,
  changed,
  refreshKey,
  onOpenFile,
  onPickFolder,
  onClose
}: {
  anchor: DOMRect // 폴더 칩의 화면 사각형
  cwd: string // 패널의 작업 폴더 (절대 경로)
  changed?: ChangedFile[]
  refreshKey?: number
  onOpenFile: (rel: string) => void
  onPickFolder: () => void // "폴더 변경" — 패널 작업 폴더 선택 흐름
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchor.left, top: anchor.bottom + 6 })

  // 바깥 클릭 / Esc / 리사이즈로 닫기 (트리 내부 클릭은 ref로 보호)
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('resize', onClose)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', onClose)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // 뷰포트 클램프 + 아래가 좁으면 위로 뒤집기
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const h = el.offsetHeight
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_W - 8))
    const below = anchor.bottom + 6
    const top = below + h > window.innerHeight - 8 ? Math.max(8, anchor.top - 6 - h) : below
    setPos({ left, top })
  }, [anchor])

  const project = cwd ? basename(cwd) : ''

  return createPortal(
    <div ref={ref} className="pfm" style={{ left: pos.left, top: pos.top, width: MENU_W }}>
      <div className="pfm-head">
        <span className="pfm-fic">
          <IconFolderOpen size={14} />
        </span>
        <span className="pfm-name" title={cwd}>
          {project || '폴더 미선택'}
        </span>
        <button className="pfm-swap" onClick={onPickFolder}>
          폴더 변경
        </button>
        <button className="pfm-x" aria-label="닫기" onClick={onClose}>
          <IconClose size={14} />
        </button>
      </div>
      {cwd ? (
        <FileTree root={cwd} changed={changed} refreshKey={refreshKey} autoFocus onOpenFile={onOpenFile} />
      ) : (
        <div className="pfm-blank">
          <div className="pfm-blank-ic">
            <IconFolder size={18} />
          </div>
          <div className="pfm-blank-text">
            이 패널은 아직 작업 폴더가 없어요.
            <br />
            폴더를 선택하면 파일을 둘러볼 수 있어요.
          </div>
          <button className="pfm-blank-btn" onClick={onPickFolder}>
            폴더 선택
          </button>
        </div>
      )}
    </div>,
    document.body
  )
}
