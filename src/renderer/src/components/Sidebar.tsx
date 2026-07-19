import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AppUser, AgentStatus } from '@shared/protocol'
import {
  IconSearch,
  IconPlus,
  IconPencil,
  IconTrash,
  IconMessage,
  IconMascot,
  IconGear,
  IconX2
} from './icons'

// 2.0 사이드바 — 모드 탭 없이 일반/멀티/추가 채팅 3섹션이 상시 노출된다 (PoC v3).
// 일반 항목 클릭=코드 뷰, 멀티 항목 클릭=멀티 뷰, 추가 항목 클릭=그 세션 창 포커스.
// 새 채팅은 선택 모달(일반/멀티→패널 수)이 담당하고 여기선 onNewChat만 부른다.

export interface ChatSummary {
  id: string
  title: string
  status: AgentStatus
  updatedAt?: number // 마지막 활동 시각 — 오른쪽 상대 시간(지금/28분/1시간)으로 표시
}

export type SidebarSectionKey = 'general' | 'multi' | 'extra'

export interface SidebarSection {
  key: SidebarSectionKey
  label: string
  chats: ChatSummary[]
  /** 현재 뷰가 이 섹션일 때만 활성 id를 넘긴다 — 사이드바 전체에서 active는 하나 */
  activeId?: string
  /** 이 섹션의 "지금 열려 있는" 항목 — busy 잠금 예외용. 멀티 뷰를 보는 동안에도
   *  실행이 흐르는 일반 채팅은 눌러서 돌아올 수 있어야 한다 (activeId는 하이라이트만) */
  currentId?: string
  /** 일반 섹션: 실행 중 → 항목 전환·삭제 잠금 (멀티는 세션별 독립이라 잠그지 않음) */
  busy?: boolean
  onSelect: (id: string) => void
  onRename?: (id: string, name: string) => void
  onDelete?: (id: string) => void
  onDeleteAll?: () => void
}

const isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac')

// 상태 점 — 진행 중=노랑 · 에러=빨강 (완료·대기는 점 없음, PoC 확정)
function dotClass(status: AgentStatus): string {
  if (status === 'working' || status === 'analyzing') return 'run'
  if (status === 'error') return 'err'
  return ''
}

// 상대 시간 — PoC 표기(지금/28분/1시간/2일/1주/5개월). updatedAt이 없는 항목(구버전
// 저장본)은 빈칸으로 조용히 넘어간다. 헤더 폴더 picker(최근 폴더의 when)도 같이 쓴다.
export function relTime(ts?: number): string {
  if (!ts) return ''
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return '지금'
  const m = s / 60
  if (m < 60) return `${Math.floor(m)}분`
  const h = m / 60
  if (h < 24) return `${Math.floor(h)}시간`
  const d = h / 24
  if (d < 7) return `${Math.floor(d)}일`
  if (d < 35) return `${Math.floor(d / 7)}주`
  const mo = d / 30.44
  if (mo < 12) return `${Math.max(1, Math.floor(mo))}개월`
  return `${Math.floor(mo / 12)}년`
}

// 삭제 확인 문구 — 추가 채팅도 이제 대화가 영속이라 X는 여느 채팅처럼 '삭제'다
// (창 닫기는 저장 후 정리라 확인이 필요 없고, 사이드바 X만 여기로 온다)
function confirmOneText(title: string): { title: string; msg: string } {
  return { title: '채팅 삭제', msg: `'${title}' 채팅이 삭제돼요. 되돌릴 수 없어요.` }
}
function confirmAllText(label: string, n: number): { title: string; msg: string } {
  return { title: `${label} 모두 삭제`, msg: `채팅 ${n}개가 삭제돼요. 되돌릴 수 없어요.` }
}

// 열려 있는 동안 F2/Del 단축키를 비켜야 하는 오버레이들 — 모달이 키보드를 소유한다
const OVERLAY_GUARD =
  '.q-overlay, .sa-overlay, .fv-overlay, .set-overlay, .set-dialog-overlay, .sconfirm, .pr-overlay, .iv-overlay, .ma-expand-overlay, .pn-overlay, .chgm-overlay, .nc-veil'

interface MenuState {
  sec: SidebarSectionKey
  id: string
  x: number
  y: number
}
interface ConfirmState {
  sec: SidebarSectionKey
  id: string | null // null = 전체 삭제
  title: string
  msg: string
}

export const Sidebar = memo(function Sidebar({
  user,
  sections,
  onNewChat,
  onOpenSettings
}: {
  user: AppUser
  sections: SidebarSection[]
  onNewChat: () => void
  onOpenSettings: () => void
}) {
  // 섹션별 검색 — 라벨 행 돋보기로 여닫는 인라인 필터 (닫으면 초기화)
  const [searchOpen, setSearchOpen] = useState<Partial<Record<SidebarSectionKey, boolean>>>({})
  const [queries, setQueries] = useState<Partial<Record<SidebarSectionKey, string>>>({})
  // 우클릭 메뉴 · 제자리 이름 변경 · 삭제 확인 카드 · 삭제 접힘 애니메이션
  const [menu, setMenu] = useState<MenuState | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const asideRef = useRef<HTMLElement>(null)
  const [renaming, setRenaming] = useState<{ sec: SidebarSectionKey; id: string } | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [removing, setRemoving] = useState<{ sec: SidebarSectionKey; id: string } | null>(null)
  // 상대 시간은 스스로 흐른다 — 1분마다 다시 그려 '지금'이 '1분'이 되게
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])

  // 메뉴가 화면 아래/오른쪽을 넘치면 실측 크기로 되민다 (탐색기 메뉴와 같은 문법)
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el || !menu) return
    el.style.left = Math.max(8, Math.min(menu.x, window.innerWidth - el.offsetWidth - 8)) + 'px'
    el.style.top = Math.max(8, Math.min(menu.y, window.innerHeight - el.offsetHeight - 8)) + 'px'
  }, [menu])

  // 메뉴 닫기 — 바깥 클릭 / Esc / 스크롤 / 리사이즈 / 창 포커스 아웃 (내부 클릭은 ref로 보호)
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    const aside = asideRef.current
    window.addEventListener('mousedown', onDown)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    document.addEventListener('keydown', onKey)
    aside?.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      document.removeEventListener('keydown', onKey)
      aside?.removeEventListener('scroll', close, true)
    }
  }, [menu])

  // Esc closes the confirm card
  useEffect(() => {
    if (!confirm) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setConfirm(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [confirm])

  const sectionsRef = useRef(sections)
  sectionsRef.current = sections

  // 삭제 실행 — 항목이 접히며 사라진 뒤 실제 삭제 콜백 (PoC의 height 접힘 연출)
  const runDelete = (sec: SidebarSectionKey, id: string): void => {
    const s = sectionsRef.current.find((x) => x.key === sec)
    if (!s?.onDelete) return
    setRemoving({ sec, id })
    setTimeout(() => {
      setRemoving(null)
      s.onDelete?.(id)
    }, 200)
  }

  const askDelete = (sec: SidebarSectionKey, id: string): void => {
    const s = sectionsRef.current.find((x) => x.key === sec)
    const chat = s?.chats.find((c) => c.id === id)
    if (!s || !chat) return
    if (s.busy && (s.currentId ?? s.activeId) === id) return // 실행이 흐르는 채팅은 지울 수 없다
    const t = confirmOneText(chat.title || '새 채팅')
    setConfirm({ sec, id, ...t })
  }
  const startRename = (sec: SidebarSectionKey, id: string): void => {
    const s = sectionsRef.current.find((x) => x.key === sec)
    if (!s?.onRename) return
    setRenaming({ sec, id })
  }

  // F2=이름 변경 · Delete=삭제 — 지금 보고 있는(활성) 항목에 작동. 입력 중이거나
  // 모달이 떠 있으면 무시 (PoC의 .modal-veil 가드와 같은 규칙)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'F2' && e.key !== 'Delete') return
      const ae = document.activeElement as HTMLElement | null
      if (ae && (['INPUT', 'TEXTAREA', 'SELECT'].includes(ae.tagName) || ae.isContentEditable)) return
      if (document.querySelector(OVERLAY_GUARD)) return
      const act = sectionsRef.current.find((s) => s.activeId && s.chats.some((c) => c.id === s.activeId))
      if (!act) return
      if (e.key === 'F2') {
        e.preventDefault()
        startRename(act.key, act.activeId!)
      } else {
        askDelete(act.key, act.activeId!)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const menuSection = menu ? sections.find((s) => s.key === menu.sec) : null
  const menuChat = menu && menuSection ? menuSection.chats.find((c) => c.id === menu.id) : null

  return (
    <aside className="sidebar" ref={asideRef}>
      {/* 브랜드 줄 = 창 드래그 영역 — PoC 그대로 마스코트+이름뿐 (접기는 ` 키) */}
      <div className="sb-top">
        <div className="mark"><IconMascot size={23} /></div>
        <span className="name">AgentCodeGUI</span>
      </div>

      {/* 새 채팅 — 일반/멀티 선택 모달을 연다 (PoC: 버튼이 곧장 만들지 않는다) */}
      <button className="sb-new" onClick={onNewChat}>
        <IconPlus size={16} />
        <span>새 채팅</span>
        <span className="kbd">{isMac ? '⌘N' : 'Ctrl+N'}</span>
      </button>
      {/* 추가 채팅 — 지금 작업과 따로 굴러가는 독립 대화를 새 창으로 연다 (호버 설명 없음 — 유저 결정) */}
      <button className="sb-new" onClick={() => window.api.openSessionWindow().catch(() => {})}>
        <IconMessage size={16} />
        <span>추가 채팅</span>
        <span className="kbd">{isMac ? '⌘⇧N' : 'Ctrl+Shift+N'}</span>
      </button>

      <div className="sb-scroll scroll">
        {sections.map((s) => {
          const q = (queries[s.key] ?? '').trim().toLowerCase()
          const filtered = q ? s.chats.filter((c) => (c.title || '새 채팅').toLowerCase().includes(q)) : s.chats
          const searching = !!searchOpen[s.key]
          return (
            <div className="sb-sec" key={s.key}>
              <div className="sb-label">
                {s.label} <span className="sp" />
                <button
                  className={'slb' + (searching ? ' on' : '')}
                  title="검색"
                  aria-label={`${s.label} 검색`}
                  onClick={() => {
                    setSearchOpen((o) => ({ ...o, [s.key]: !o[s.key] }))
                    if (searching) setQueries((qs) => ({ ...qs, [s.key]: '' }))
                  }}
                >
                  <IconSearch size={12} />
                </button>
                {s.onDeleteAll && (
                  <button
                    className="slb has-tip"
                    data-tip={s.busy ? '작업이 끝난 뒤 지울 수 있어요' : '전체 삭제'}
                    aria-label="전체 삭제"
                    disabled={s.busy || s.chats.length === 0}
                    onClick={() => setConfirm({ sec: s.key, id: null, ...confirmAllText(s.label, s.chats.length) })}
                  >
                    <IconTrash size={12} />
                  </button>
                )}
              </div>

              {searching && (
                <div className="sb-search2">
                  <IconSearch size={12} />
                  <input
                    autoFocus
                    placeholder={`${s.label} 검색…`}
                    value={queries[s.key] ?? ''}
                    onChange={(e) => setQueries((qs) => ({ ...qs, [s.key]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation()
                        setSearchOpen((o) => ({ ...o, [s.key]: false }))
                        setQueries((qs) => ({ ...qs, [s.key]: '' }))
                      }
                    }}
                  />
                  <button
                    className="sx"
                    aria-label="검색 닫기"
                    onClick={() => {
                      setSearchOpen((o) => ({ ...o, [s.key]: false }))
                      setQueries((qs) => ({ ...qs, [s.key]: '' }))
                    }}
                  >
                    <IconX2 size={11} />
                  </button>
                </div>
              )}

              <div className="sb-list">
                {filtered.length === 0 ? (
                  <div className="sb-empty">
                    {q ? '검색 결과가 없어요' : '채팅이 없어요'}
                  </div>
                ) : (
                  filtered.map((c) => {
                    const active = s.activeId === c.id
                    const locked = !!s.busy && c.id !== (s.currentId ?? s.activeId)
                    const isRenaming = renaming?.sec === s.key && renaming.id === c.id
                    const isRemoving = removing?.sec === s.key && removing.id === c.id
                    return (
                      <div
                        key={c.id}
                        role="button"
                        tabIndex={0}
                        className={
                          'sb-item' +
                          (active ? ' active' : '') +
                          (locked ? ' locked' : '') +
                          (isRemoving ? ' removing' : '')
                        }
                        onClick={() => !locked && !isRenaming && s.onSelect(c.id)}
                        onKeyDown={(e) => {
                          if ((e.key === 'Enter' || e.key === ' ') && !locked && !isRenaming) {
                            e.preventDefault()
                            s.onSelect(c.id)
                          }
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          setMenu({ sec: s.key, id: c.id, x: e.clientX, y: e.clientY })
                        }}
                      >
                        <span className={'dot ' + dotClass(c.status)} />
                        {isRenaming ? (
                          <RenameInput
                            initial={c.title || '새 채팅'}
                            onDone={(commit, value) => {
                              setRenaming(null)
                              const v = value.trim()
                              if (commit && v) s.onRename?.(c.id, v)
                            }}
                          />
                        ) : (
                          <span className="t">
                            <span className="tx">{c.title || '새 채팅'}</span>
                          </span>
                        )}
                        {!isRenaming && <span className="when">{relTime(c.updatedAt)}</span>}
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          )
        })}
      </div>

      <button className="sb-foot has-tip" data-tip="설정 열기" aria-label="설정 열기" onClick={onOpenSettings}>
        <div className="ava" style={{ background: user.avatarColor, color: '#fff' }}>
          {user.avatarText}
        </div>
        <div className="who">
          <div className="n">{user.name}</div>
        </div>
        <IconGear size={13} />
      </button>

      {/* 우클릭 메뉴 — 탐색기 메뉴처럼 body 포털: 조상(transform 애니메이션·overflow)에
          좌표·클립이 절대 안 묶이게 한다 */}
      {menu && menuSection && menuChat &&
        createPortal(
          <div ref={menuRef} className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
            <div className="cmh">{menuChat.title || '새 채팅'}</div>
            {menuSection.onRename && (
              <button
                className="ctx-item"
                onClick={() => {
                  setMenu(null)
                  startRename(menu.sec, menu.id)
                }}
              >
                <IconPencil size={15} /> 이름 변경
              </button>
            )}
            <div className="ctx-sep" />
            <button
              className="ctx-item danger"
              disabled={!!menuSection.busy && (menuSection.currentId ?? menuSection.activeId) === menu.id}
              onClick={() => {
                setMenu(null)
                askDelete(menu.sec, menu.id)
              }}
            >
              <IconTrash size={15} /> 삭제
            </button>
          </div>,
          document.body
        )}

      {/* 삭제 확인 — 화면 중앙 유리 카드 (PoC .sconfirm 그대로: 원형 위험 아이콘 + 가운데 정렬).
          메뉴와 같은 이유로 body 포털 — 전체 화면 베일이 조상에 묶이면 안 된다 */}
      {confirm &&
        createPortal(
          <div className="sconfirm" onMouseDown={() => setConfirm(null)}>
            <div className="sccard" onMouseDown={(e) => e.stopPropagation()}>
              <div className="scic">
                <IconTrash size={19} />
              </div>
              <div className="sctt">{confirm.title}</div>
              <div className="sct">{confirm.msg}</div>
              <div className="scb">
                <button className="cancel" onClick={() => setConfirm(null)}>
                  취소
                </button>
                <button
                  className="danger"
                  onClick={() => {
                    const c = confirm
                    setConfirm(null)
                    if (c.id) runDelete(c.sec, c.id)
                    else sectionsRef.current.find((x) => x.key === c.sec)?.onDeleteAll?.()
                  }}
                >
                  {confirm.id ? '삭제' : '모두 삭제'}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </aside>
  )
})

// 제자리 이름 변경 — 제목 span 자리에 입력이 뜬다. Enter/바깥 클릭=확정, Esc=취소.
// 입력 클릭이 항목 클릭(select)으로 새지 않게 전파를 막는다 (PoC .rnin 규칙)
function RenameInput({ initial, onDone }: { initial: string; onDone: (commit: boolean, value: string) => void }) {
  const [value, setValue] = useState(initial)
  const doneRef = useRef(false)
  const done = (commit: boolean, v: string): void => {
    if (doneRef.current) return
    doneRef.current = true
    onDone(commit, v)
  }
  return (
    <input
      className="sb-edit"
      autoFocus
      value={value}
      spellCheck={false}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => done(true, value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') done(true, value)
        else if (e.key === 'Escape') done(false, value)
      }}
    />
  )
}
