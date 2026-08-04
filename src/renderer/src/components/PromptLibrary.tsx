import { useEffect, useRef, useState } from 'react'
import { t, useLang } from '../lib/i18n'
import { loadPrompts, savePrompts, type SavedPrompt } from '../lib/prompts'
import { relTime } from './Sidebar'
import { MouseGestureLayer, scrollGestures } from './mouseGesture'
import { IconCheck, IconClipList, IconClose, IconCopy, IconPencil, IconPlus, IconTrash } from './icons'

// ── 프롬프트 라이브러리 — 사이드바 '프롬프트' 버튼이 여는 모달 ──────────────
// 자주 쓰는 프롬프트를 저장해 두고, 행 클릭(또는 복사 버튼)으로 클립보드에 복사해
// 붙여 쓴다. 껍데기는 공용 카드(.pr-modal — 기존 오버레이 가드 .pr-overlay 재사용),
// 속은 에디토리얼(.plib-*): 배지 없는 타이틀 헤더, 시간↔액션 스왑 레일, 무테 편집
// 캔버스. 저장은 lib/prompts(localStorage — 모든 창 공유), 열 때마다 새로 읽는다.

type View = { kind: 'list' } | { kind: 'edit'; id: string | null } // id null = 새 프롬프트

export function PromptLibrary({ onClose }: { onClose: () => void }) {
  useLang() // 언어 전환 재렌더 구독
  const [items, setItems] = useState<SavedPrompt[]>(() => loadPrompts())
  const [view, setView] = useState<View>({ kind: 'list' })
  const [del, setDel] = useState<SavedPrompt | null>(null)
  const [copiedId, setCopiedId] = useState('')
  // 편집 폼 — openEdit에서 시드하고 저장 시에만 items에 반영 (취소=버림)
  const [eTitle, setETitle] = useState('')
  const [eText, setEText] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)
  // 마우스 제스처(↓→ 닫기 · 목록 ↑/↓ 스크롤) — 카드 루트·목록은 state로 추적
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null)
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null)

  // Esc는 겹친 층부터 걷는다 — 삭제 확인 → 편집 폼(초안 버림) → 모달 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (del) setDel(null)
      else if (view.kind === 'edit') setView({ kind: 'list' })
      else onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [del, view, onClose])

  const commit = (next: SavedPrompt[]): void => {
    setItems(next)
    savePrompts(next)
  }

  // 행/버튼 복사 — 그 행에 '복사됨' 피드백(초록 플래시)을 잠깐 띄운다
  const copyTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(copyTimer.current), [])
  const copy = (p: SavedPrompt): void => {
    navigator.clipboard?.writeText(p.text).catch(() => {})
    setCopiedId(p.id)
    window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopiedId(''), 1400)
  }

  const openEdit = (p: SavedPrompt | null): void => {
    setETitle(p?.title ?? '')
    setEText(p?.text ?? '')
    setView({ kind: 'edit', id: p?.id ?? null })
  }
  const saveEdit = (): void => {
    if (!eText.trim()) return
    const now = Date.now()
    const title = eTitle.trim()
    if (view.kind === 'edit' && view.id) {
      commit(items.map((x) => (x.id === view.id ? { ...x, title, text: eText, t: now } : x)))
    } else {
      const id = crypto.randomUUID ? crypto.randomUUID() : `p-${now}-${items.length}`
      commit([{ id, title, text: eText, t: now }, ...items])
    }
    setView({ kind: 'list' })
  }

  // 목록 표시 이름 — 제목이 비어 있으면 본문 첫 줄
  const nameOf = (p: SavedPrompt): string =>
    p.title || p.text.split('\n').find((l) => l.trim())?.trim() || t('제목 없음', 'Untitled')

  return (
    <>
      <div className="pr-overlay" onMouseDown={view.kind === 'list' ? onClose : undefined}>
        {/* ↓→ 닫기(편집 중엔 Esc처럼 목록으로 — 초안이 통째로 날아가지 않게) + 목록 ↑/↓ */}
        <MouseGestureLayer
          target={cardEl}
          disabled={!!del}
          actions={[
            ...scrollGestures(() => listEl),
            view.kind === 'edit'
              ? { pattern: 'DR', label: t('목록으로', 'Back to list'), run: () => setView({ kind: 'list' }) }
              : { pattern: 'DR', label: t('창 닫기', 'Close window'), run: onClose }
          ]}
        />
        <div className="pr-modal plib-modal" ref={setCardEl} onMouseDown={(e) => e.stopPropagation()}>
          {/* 헤더 — 배지 없는 에디토리얼 타이틀 + 개수 칩. 부제가 안내를 겸한다 */}
          <div className="plib-head">
            <div className="row">
              <span className="tt">{t('프롬프트', 'Prompts')}</span>
              {view.kind === 'list' && items.length > 0 && <span className="n">{items.length}</span>}
              <span className="sp" />
              <button
                className="pr-close has-tip"
                data-tip={t('닫기 (Esc)', 'Close (Esc)')}
                aria-label={t('닫기', 'Close')}
                onClick={onClose}
              >
                <IconClose size={15} />
              </button>
            </div>
            <div className="sub">
              {view.kind === 'edit'
                ? view.id
                  ? t('프롬프트 수정', 'Edit prompt')
                  : t('새 프롬프트', 'New prompt')
                : t('자주 쓰는 프롬프트를 저장해 두고, 클릭 한 번으로 복사해요', 'Save prompts you reuse — click one to copy')}
            </div>
          </div>

          {view.kind === 'list' ? (
            <div className="plib-list scroll" ref={setListEl}>
              {items.length === 0 ? (
                <div className="plib-empty">
                  <IconClipList size={26} />
                  <div className="e1">{t('아직 저장한 프롬프트가 없어요', 'No prompts yet')}</div>
                  <div className="e2">{t('아래에서 첫 프롬프트를 추가해 보세요', 'Add your first one below')}</div>
                </div>
              ) : (
                items.map((p) => (
                  <div
                    key={p.id}
                    className={'plib-row' + (copiedId === p.id ? ' copied' : '')}
                    role="button"
                    tabIndex={0}
                    onClick={() => copy(p)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        copy(p)
                      }
                    }}
                  >
                    <div className="tl">
                      <span className="tt">{nameOf(p)}</span>
                      {/* 오른쪽 레일 — 평소엔 시간, 호버엔 액션이 같은 자리에서 스왑 */}
                      <span className="rail">
                        {copiedId === p.id ? (
                          <span className="plib-done">
                            <IconCheck size={12} stroke={2.4} /> {t('복사됨', 'Copied')}
                          </span>
                        ) : (
                          <>
                            <span className="when">{relTime(p.t)}</span>
                            <span className="acts">
                              <span
                                className="plib-act"
                                role="button"
                                aria-label={t('복사', 'Copy')}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  copy(p)
                                }}
                              >
                                <IconCopy size={13} />
                              </span>
                              <span
                                className="plib-act"
                                role="button"
                                aria-label={t('수정', 'Edit')}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  openEdit(p)
                                }}
                              >
                                <IconPencil size={13} />
                              </span>
                              <span
                                className="plib-act danger"
                                role="button"
                                aria-label={t('삭제', 'Delete')}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setDel(p)
                                }}
                              >
                                <IconTrash size={13} />
                              </span>
                            </span>
                          </>
                        )}
                      </span>
                    </div>
                    <div className="tx">{p.text}</div>
                  </div>
                ))
              )}
              {items.length > 0 && <div className="plib-sep" />}
              <button className="plib-add" onClick={() => openEdit(null)}>
                <IconPlus size={14} /> {t('새 프롬프트', 'New prompt')}
              </button>
            </div>
          ) : (
            <>
              {/* 편집 — 박스 입력 대신 무테 캔버스: 큰 제목 + 본문이 한 종이처럼 이어진다 */}
              <div className="plib-ed">
                <input
                  className="ti"
                  value={eTitle}
                  spellCheck={false}
                  autoFocus
                  placeholder={t('제목 (비우면 첫 줄로 표시)', 'Title (first line if empty)')}
                  onChange={(e) => setETitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      taRef.current?.focus()
                    }
                  }}
                />
                <textarea
                  ref={taRef}
                  className="tx scroll"
                  value={eText}
                  spellCheck={false}
                  placeholder={t('프롬프트 내용을 적어 주세요…', 'Write your prompt…')}
                  onChange={(e) => setEText(e.target.value)}
                  onKeyDown={(e) => {
                    // 컴포저와 같은 문법 — Enter 저장, Shift+Enter 줄바꿈
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      saveEdit()
                    }
                  }}
                />
              </div>
              <div className="plib-foot">
                <span className="hint">
                  <kbd>Enter</kbd> {t('저장', 'save')}
                </span>
                <span className="hint">
                  <kbd>Shift+Enter</kbd> {t('줄바꿈', 'new line')}
                </span>
                <span className="sp" />
                <button className="pr-cancel" onClick={() => setView({ kind: 'list' })}>
                  {t('취소', 'Cancel')}
                </button>
                <button className="pr-save" onClick={saveEdit} disabled={!eText.trim()}>
                  {t('저장', 'Save')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 삭제 확인 — 채팅 삭제와 같은 중앙 유리 카드. 프롬프트 모달(z 120) 위라 .up 변형.
          pr-overlay의 형제로 그려 mousedown이 목록 뷰의 '바깥 클릭 닫기'로 새지 않게 한다 */}
      {del && (
        <div className="sconfirm up" onMouseDown={() => setDel(null)}>
          <div className="sccard" onMouseDown={(e) => e.stopPropagation()}>
            <div className="scic">
              <IconTrash size={19} />
            </div>
            <div className="sctt">{t('프롬프트 삭제', 'Delete prompt')}</div>
            <div className="sct">
              {t(`'${nameOf(del)}' 프롬프트가 삭제돼요. 되돌릴 수 없어요.`, `'${nameOf(del)}' will be deleted. This can't be undone.`)}
            </div>
            <div className="scb">
              <button className="cancel" onClick={() => setDel(null)}>
                {t('취소', 'Cancel')}
              </button>
              <button
                className="danger"
                onClick={() => {
                  commit(items.filter((x) => x.id !== del.id))
                  setDel(null)
                }}
              >
                {t('삭제', 'Delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
