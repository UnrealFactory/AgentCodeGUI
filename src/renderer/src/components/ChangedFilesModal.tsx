import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangedFile } from '@shared/protocol'
import { FileBadge } from './fileType'
import { IconClose, IconFolder } from './icons'
import { MouseGestureLayer, scrollGestures } from './mouseGesture'

// 분류 세그먼트 — 전체 / 수정됨 / 새 파일 (PoC chgseg)
type Cat = 'all' | 'edit' | 'new'

// 탐색기 우클릭 '변경된 파일 보기' — PoC 폴더 변경 파일 카드(chgcard):
// mhead(폴더 타일 + 이름/경로·개수 모노 서브 + ± 합계 알약) 아래 세그먼트 알약
// 필터(상태색 점 + 개수, 0개는 비활성)와 파일 행(아이콘·이름·흐린 위치·±수치·상태
// 글자) 목록. 행을 클릭하면 diff 뷰어가 카드 위로 뜨고(z 60 > 55) 카드는 남아
// 연달아 볼 수 있다. changed에서 매번 파생 — 보는 중에 에이전트가 파일을 더
// 만지면 즉시 반영된다.
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

  const list = useMemo(() => {
    const pre = scope.rel ? scope.rel + '/' : ''
    return changed.filter((f) => !pre || f.path.startsWith(pre)).sort((a, b) => a.path.localeCompare(b.path))
  }, [changed, scope])
  const nNew = list.reduce((n, f) => n + (f.tag === 'new' ? 1 : 0), 0)
  const sumAdd = list.reduce((n, f) => n + f.add, 0)
  const sumDel = list.reduce((n, f) => n + f.del, 0)
  const shown = cat === 'all' ? list : list.filter((f) => f.tag === cat)

  const SEGS: { k: Cat; t: string; c: number; dot?: string }[] = [
    { k: 'all', t: '전체', c: list.length },
    { k: 'edit', t: '수정됨', c: list.length - nNew, dot: 'var(--yellow)' },
    { k: 'new', t: '새 파일', c: nNew, dot: 'var(--green)' }
  ]

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

  // 오버레이에서 눌러서 오버레이에서 뗀 클릭만 닫기 — 카드 안에서 시작한 드래그가
  // 밖에서 끝나도 닫히지 않게
  const downOnOverlay = useRef(false)
  // 마우스 제스처(↑/↓ 목록 맨 위·아래, ↓→ 닫기) — 카드 루트와 스크롤 본문은 state로 추적
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null)
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null)

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
        actions={[...scrollGestures(() => bodyEl), { pattern: 'DR', label: '창 닫기', run: onClose }]}
      />
      <div className="chgm-modal" ref={setCardEl}>
        {/* ── 헤더 (PoC mhead) — 폴더 타일 + 2줄 제목, 오른쪽 ± 합계 알약 + 닫기 ── */}
        <div className="chgm-head">
          <span className="chgm-tile">
            <IconFolder size={17} />
          </span>
          <span className="chgm-tt">
            <span className="mt">{scope.label}</span>
            <span className="msub">{(scope.rel || scope.label) + ' · 변경된 파일 ' + list.length + '개'}</span>
          </span>
          <span className="sp" />
          {sumAdd > 0 && <span className="dpill add">+{sumAdd}</span>}
          {sumDel > 0 && <span className="dpill del">−{sumDel}</span>}
          <button className="chgm-close htip" onClick={onClose} aria-label="닫기" data-tip="닫기 (Esc)">
            <IconClose size={15} />
          </button>
        </div>

        {/* ── 본문 — 세그먼트 필터 + 파일 목록 인셋 카드(PoC mcard.tools), 통째로 스크롤 ── */}
        <div className="chgm-body scroll" ref={setBodyEl}>
          <div className="chgm-seg">
            {SEGS.map((s) => (
              <button
                key={s.k}
                className={(cat === s.k ? 'on' : '') + (s.c ? '' : ' dis')}
                onClick={() => setCat(s.k)}
              >
                {s.dot && <span className="d2" style={{ background: s.dot }} />}
                {s.t}
                <span className="c">{s.c}</span>
              </button>
            ))}
          </div>
          <div className="chgm-list">
            {shown.length === 0 ? (
              <div className="chgm-empty">변경된 파일이 없어요</div>
            ) : (
              shown.map((f) => {
                // 스코프 기준 상대 경로 — 이름과 흐린 위치(부모 폴더, 스코프 바로 아래면 '·')로 나눈다
                const local = scope.rel ? f.path.slice(scope.rel.length + 1) : f.path
                const slash = local.lastIndexOf('/')
                return (
                  <button key={f.path} className="chgm-row" onClick={() => onOpen(f.path)}>
                    <span className="fic">
                      <FileBadge path={f.path} size={14} />
                    </span>
                    <span className="n">{local.slice(slash + 1)}</span>
                    <span className="pp">{slash >= 0 ? local.slice(0, slash) : '·'}</span>
                    <span className="pm">
                      <span className={'a' + (f.add ? '' : ' zero')}>+{f.add}</span>
                      <span className={'d' + (f.del ? '' : ' zero')}>−{f.del}</span>
                    </span>
                    <span className={'gs ' + (f.tag === 'new' ? 'a' : 'm')}>{f.tag === 'new' ? 'A' : 'M'}</span>
                  </button>
                )
              })
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
