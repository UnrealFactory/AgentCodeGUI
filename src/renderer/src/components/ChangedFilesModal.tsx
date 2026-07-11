import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangedFile } from '@shared/protocol'
import { FileBadge } from './fileType'
import { IconClose, IconFile, IconFolder, IconList, IconMax, IconPencil, IconRestore } from './icons'
import { useResizableModal, ModalResizeHandles } from './resizableModal'
import { mergeRefs } from './zoom'
import { MouseGestureLayer, scrollGestures } from './mouseGesture'

// 분류 탭 — 전체 / 새 파일 / 수정됨 (설정창의 좌측 내비와 같은 언어)
type Cat = 'all' | 'new' | 'edit'

// 탐색기 우클릭 '변경된 파일 보기' — 설정창 크기의 창: 좌측에서 전체/새 파일/수정됨을
// 고르고, 본문은 그 폴더(rel '' = 프로젝트 전체) 아래의 세션 변경 파일을 하위 폴더별로
// 묶어 보여준다. 클릭하면 diff 뷰어가 창 위로 뜨고(z 60 > 55, Git 카드와 같은 레이어링)
// 창은 남아 연달아 볼 수 있다. Git 카드처럼 크기 조절·최대화·창별 크기 기억을 지원한다.
export function ChangedFilesModal({
  scope,
  changed,
  onOpen,
  onClose
}: {
  scope: { rel: string; label: string }
  changed: ChangedFile[]
  onOpen: (path: string) => void
  onClose: () => void
}) {
  const [cat, setCat] = useState<Cat>('all')

  // changed에서 매번 파생 — 보고 있는 중에 에이전트가 파일을 더 만지면 즉시 반영된다.
  // 경로순 정렬이라 폴더 그룹도 자연히 경로순(하위 폴더 먼저, 스코프 바로 아래 파일은 마지막).
  const list = useMemo(() => {
    const pre = scope.rel ? scope.rel + '/' : ''
    return changed.filter((f) => !pre || f.path.startsWith(pre)).sort((a, b) => a.path.localeCompare(b.path))
  }, [changed, scope])
  const nNew = list.reduce((n, f) => n + (f.tag === 'new' ? 1 : 0), 0)
  const sumAdd = list.reduce((n, f) => n + f.add, 0)
  const sumDel = list.reduce((n, f) => n + f.del, 0)
  const shown = cat === 'all' ? list : list.filter((f) => f.tag === cat)

  // 스코프 기준 상대 폴더별 그룹('' = 스코프 바로 아래) — 행에는 파일 이름만 남아 깔끔하다
  const groups = useMemo(() => {
    const m = new Map<string, { name: string; file: ChangedFile }[]>()
    for (const f of shown) {
      const local = scope.rel ? f.path.slice(scope.rel.length + 1) : f.path
      const slash = local.lastIndexOf('/')
      const dir = slash >= 0 ? local.slice(0, slash) : ''
      const g = m.get(dir)
      const row = { name: local.slice(slash + 1), file: f }
      if (g) g.push(row)
      else m.set(dir, [row])
    }
    return [...m.entries()]
  }, [shown, scope])

  const NAV: { id: Cat; label: string; icon: React.ReactNode; count: number }[] = [
    { id: 'all', label: '전체', icon: <IconList size={17} />, count: list.length },
    { id: 'new', label: '새 파일', icon: <IconFile size={17} />, count: nNew },
    { id: 'edit', label: '수정됨', icon: <IconPencil size={17} />, count: list.length - nNew }
  ]
  const EMPTY: Record<Cat, string> = {
    all: '변경된 파일이 없어요',
    new: '새로 만든 파일이 없어요',
    edit: '수정된 파일이 없어요'
  }

  // Esc — 위에 떠 있는 파일 뷰어가 우선 (뷰어의 Esc가 그쪽 카드만 닫는다, Git 카드와 같은 가드)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (document.querySelector('.fv-overlay, .sel-bar')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 오버레이에서 눌러서 오버레이에서 뗀 클릭만 닫기 — 창 안에서 시작한 드래그가
  // 밖에서 끝나도 닫히지 않게 (Git 카드와 같은 처리)
  const downOnOverlay = useRef(false)
  // 크기 조절·최대화 — Git 카드와 같은 훅, 크기는 'chgm.size'로 기억
  const rz = useResizableModal('chgm.size', true)
  // 마우스 제스처(↑/↓ 목록 맨 위·아래, ↓→ 닫기) 대상 — 창 루트는 state로 추적
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null)
  const modalRef = useMemo(() => mergeRefs(rz.ref, setCardEl), [rz.ref])
  const [listEl, setListEl] = useState<HTMLElement | null>(null)

  return (
    <div
      className="chgm-overlay"
      onMouseDown={(e) => {
        downOnOverlay.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        if (downOnOverlay.current && e.target === e.currentTarget) onClose()
      }}
    >
      <MouseGestureLayer
        target={cardEl}
        actions={[...scrollGestures(() => listEl), { pattern: 'DR', label: '창 닫기', run: onClose }]}
      />
      <div className="chgm-modal rzm" ref={modalRef} style={rz.modalStyle}>
        {!rz.maximized && <ModalResizeHandles onStart={rz.startResize} />}
        <div className="diff-head" onDoubleClick={rz.onHeaderDoubleClick}>
          <span className="gitm-ic">
            <IconList size={16} />
          </span>
          <span className="gitm-name">변경된 파일</span>
          <span className="gitm-path">{scope.rel || scope.label}</span>
          <span className="dspacer" />
          {(sumAdd > 0 || sumDel > 0) && (
            <span className="chgm-total">
              {sumAdd > 0 && <span className="add">+{sumAdd}</span>}
              {sumDel > 0 && <span className="del">−{sumDel}</span>}
            </span>
          )}
          <button
            className="dclose htip"
            onClick={rz.toggleMaximize}
            aria-label={rz.maximized ? '이전 크기로' : '최대화'}
            data-tip={rz.maximized ? '이전 크기로' : '최대화'}
          >
            {rz.maximized ? <IconRestore size={15} /> : <IconMax size={13} />}
          </button>
          <button className="dclose htip" onClick={onClose} aria-label="닫기" data-tip="닫기 (Esc)">
            <IconClose size={16} />
          </button>
        </div>

        <div className="chgm-body">
          {/* ── 좌측 분류 내비 (설정창과 같은 언어) ── */}
          <nav className="chgm-nav">
            <div className="nh">분류</div>
            {NAV.map(({ id, label, icon, count }) => (
              <button key={id} className={'nav-item' + (cat === id ? ' active' : '')} onClick={() => setCat(id)}>
                <span className="ic">{icon}</span>
                {label}
                <span className={'cnt' + (count === 0 ? ' zero' : '')}>{count}</span>
              </button>
            ))}
          </nav>

          {/* ── 본문: 하위 폴더별 그룹 목록 ── */}
          <main className="chgm-main scroll" ref={setListEl}>
            {shown.length === 0 ? (
              <div className="chgm-empty">{EMPTY[cat]}</div>
            ) : (
              groups.map(([dir, rows]) => (
                <Fragment key={dir || './'}>
                  {/* 스코프 바로 아래(dir '')는 다른 그룹이 있을 때만 './'로 구분해 준다 */}
                  {(dir || groups.length > 1) && (
                    <div className="chgm-dir">
                      <IconFolder size={13} />
                      {dir || './'}
                    </div>
                  )}
                  {rows.map(({ name, file: f }) => (
                    <button key={f.path} className="chgm-file" onClick={() => onOpen(f.path)}>
                      <FileBadge path={f.path} size={19} />
                      <span className="fn">{name}</span>
                      <span className="stat">
                        {f.add > 0 && <span className="add">+{f.add}</span>}
                        {f.del > 0 && <span className="del">−{f.del}</span>}
                      </span>
                      <span className={'exp-chg ' + f.tag}>{f.tag === 'new' ? 'N' : 'M'}</span>
                    </button>
                  ))}
                </Fragment>
              ))
            )}
          </main>
        </div>
      </div>
    </div>
  )
}
