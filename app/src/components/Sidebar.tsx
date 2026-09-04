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
  IconX2,
  IconClipList
} from './icons'
import { t, useLang } from '../lib/i18n'
import { PromptLibrary } from './PromptLibrary'

// 2.0 사이드바 — 모드 탭 없이 일반/멀티/추가 채팅 3섹션이 상시 노출된다 (PoC v3).
// 일반 항목 클릭=코드 뷰, 멀티 항목 클릭=멀티 뷰, 추가 항목 클릭=그 세션 창 포커스.
// 새 채팅은 onNewChat이 곧장 일반 채팅을 만든다(선택 모달은 통합 뒤 제거 — 2026-09-01).

export interface ChatSummary {
  id: string
  title: string
  status: AgentStatus
  updatedAt?: number // 마지막 활동 시각 — 오른쪽 상대 시간(지금/28분/1시간)으로 표시
  /** ★ 3.0 M-UX — 자리 칩. 이 대화가 지금 어느 자리에서 보이는가(ux-chat-unify §2.2-3).
   *  live=보이는 자리 번호 · folded=접힌 자리(⌄N, 대화는 그대로) · win=별도 창.
   *  ★ R2: `live`는 **지금 화면에 있는** 자리에만 붙는다 — 보드 크롬을 떠나면 그 자리
   *  칩은 사라진다(안 그러면 「1번 자리」를 두 대화가 동시에 주장한다). */
  slot?: { text: string; kind: 'live' | 'folded' | 'win'; tag?: string }
  /** 승인/질문 대기 — 상태 점이 대기 색(2.6.2엔 없던 상태, §2.2-5) */
  ask?: boolean
  /** 실행 중 — 1 모드 busy 전환을 허용한 대신 목록에서 "돌고 있음"을 표시한다(스펙 ⑥) */
  running?: boolean
  /** ★ 3.0 M-UX R2 — 삭제가 막히는 **이유**. 있으면 우클릭 「삭제」가 잠기고(툴팁=이 문장),
   *  Delete 키로 들어와도 카드가 이 문장을 말한다. 침묵 no-op은 M-LOGIC P7 위반이다. */
  lock?: string
  /** ★ 3.0 M-UX R3 — 이 대화의 **OS 창이 지금 떠 있다**(`chat:windows`). 우클릭 메뉴에
   *  「창 닫기」가 생긴다 — `win:chat-close`는 **창만** 닫고 대화는 목록에 남는다
   *  (`session-wins:close`=삭제와 정반대라 메뉴 항목도 따로 둔다, 배선 R3 §R3.4). */
  winOpen?: boolean
  /** ★ 3.0 M-UX R3 — 한도 대기표가 **`ready`** 다(엔진이 들고 있다). 목록에서 눌러
   *  바로 이어갈 수 있다(`chat:queue-mutate {op:'resume'}` — 스펙 ⑤ 후반부). */
  resumeReady?: boolean
}

// ★ 3.0 M-UX — 섹션이 셋(일반/멀티/추가)에서 **둘**(채팅/배치)로 접혔다.
// 추가 채팅은 독립 섹션이 아니라 「채팅」 목록의 창 자리 칩이 됐다(§3.3·§8-①(a)).
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
  /** ★ R3 — 「창 닫기」(`win:chat-close`). 창이 떠 있는 항목(winOpen)에만 메뉴에 뜬다. */
  onCloseWindow?: (id: string) => void
  /** ★ R3 — 「이어가기」(`chat:queue-mutate {op:'resume'}`). resumeReady 항목의 알약. */
  onResume?: (id: string) => void
  /** ★ 3.0 M-UX — 목록 위 한 줄 안내(접힘 상태 등). 목업 chat-unify-collapse의 .foldhint */
  hint?: string
  /** 빈 목록 문구 — 섹션마다 세는 것이 다르다(「배치」는 채팅이 아니라 배치가 없는 것) */
  emptyText?: string
  /** ★ 3.0 M-UX — 「전체 삭제」가 실제로 지우는 개수. 통합 「채팅」 목록은 보드 자리도
   *  함께 보여주지만 그 자리들은 삭제 대상이 아니라(배치 섹션 소관) 목록 길이와 다르다.
   *  주지 않으면 목록 길이를 쓴다(2.6.2 동작). */
  deleteAllCount?: number
  /** ★ 3.0 M-UX R2 — 「전체 삭제」가 막히는 이유(있으면 잠기고 툴팁이 이 문장). */
  deleteAllLock?: string
}

const isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac')

// 상태 점 — 진행 중=노랑 · 에러=빨강 (완료·대기는 점 없음, PoC 확정)
// ★ 3.0 M-UX — 승인/질문 대기(ask)가 한 상태 더 붙었다: 접힌 자리에서 카드가 떠도
// 화면엔 안 보이므로, 목록의 점이 그 사실을 대신 말한다(§2.2-5).
function dotClass(status: AgentStatus, ask?: boolean): string {
  if (ask) return 'ask'
  if (status === 'working' || status === 'analyzing') return 'run'
  if (status === 'error') return 'err'
  return ''
}

// 상대 시간 — PoC 표기(지금/28분/1시간/2일/1주/5개월). updatedAt이 없는 항목(구버전
// 저장본)은 빈칸으로 조용히 넘어간다. 헤더 폴더 picker(최근 폴더의 when)도 같이 쓴다.
export function relTime(ts?: number): string {
  if (!ts) return ''
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return t('지금', 'now')
  const m = s / 60
  if (m < 60) return t(`${Math.floor(m)}분`, `${Math.floor(m)}m`)
  const h = m / 60
  if (h < 24) return t(`${Math.floor(h)}시간`, `${Math.floor(h)}h`)
  const d = h / 24
  if (d < 7) return t(`${Math.floor(d)}일`, `${Math.floor(d)}d`)
  if (d < 35) return t(`${Math.floor(d / 7)}주`, `${Math.floor(d / 7)}w`)
  const mo = d / 30.44
  if (mo < 12) return t(`${Math.max(1, Math.floor(mo))}개월`, `${Math.max(1, Math.floor(mo))}mo`)
  return t(`${Math.floor(mo / 12)}년`, `${Math.floor(mo / 12)}y`)
}

// 삭제 확인 문구 — 추가 채팅도 이제 대화가 영속이라 X는 여느 채팅처럼 '삭제'다
// (창 닫기는 저장 후 정리라 확인이 필요 없고, 사이드바 X만 여기로 온다)
function confirmOneText(title: string): { title: string; msg: string } {
  return {
    title: t('채팅 삭제', 'Delete chat'),
    msg: t(`'${title}' 채팅이 삭제돼요. 되돌릴 수 없어요.`, `'${title}' will be deleted. This can't be undone.`)
  }
}
function confirmAllText(label: string, n: number): { title: string; msg: string } {
  return {
    title: t(`${label} 모두 삭제`, `Delete all ${label}`),
    msg: t(`채팅 ${n}개가 삭제돼요. 되돌릴 수 없어요.`, `${n} chats will be deleted. This can't be undone.`)
  }
}

// 열려 있는 동안 F2/Del 단축키를 비켜야 하는 오버레이들 — 모달이 키보드를 소유한다
const OVERLAY_GUARD =
  '.q-overlay, .sa-overlay, .fv-overlay, .set-overlay, .set-dialog-overlay, .sconfirm, .pr-overlay, .iv-overlay, .ma-expand-overlay, .pn-overlay, .chgm-overlay'

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
  /** ★ R2 — 삭제가 **막혔다**는 카드(파괴 버튼 없음, 「확인」 하나). 이유가 곧 msg다. */
  blocked?: boolean
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
  useLang() // 언어 전환 재렌더 구독
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
  // 프롬프트 라이브러리 모달 — 자주 쓰는 프롬프트를 저장해 두고 복사해 쓴다
  const [plibOpen, setPlibOpen] = useState(false)
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
    // ★ R2 — 실행이 흐르는 대화는 못 지운다. 2.6.2는 여기서 조용히 `return` 했고(눌리지도
    // 않았으니 무해했다) R1은 그 가드가 죽으면서 **확인 카드까지 통과한 뒤 아무 일도 안
    // 일어나는** 형태가 됐다(크리틱 §2-③). 이제는 카드가 이유를 말한다.
    const lock = chat.lock || (s.busy && (s.currentId ?? s.activeId) === id ? t('실행 중이에요', 'It is running') : '')
    if (lock) {
      setConfirm({ sec, id, title: t('지금은 지울 수 없어요', "Can't delete right now"), msg: lock, blocked: true })
      return
    }
    const txt = confirmOneText(chat.title || t('새 채팅', 'New chat')) // txt: 지역 이름이 i18n t()를 가리지 않게
    setConfirm({ sec, id, ...txt })
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
        // 멀티 뷰에서 패널이 선택돼 있으면 F2는 그 패널의 제목 편집 몫 — 세션 이름 변경은 양보
        if (document.querySelector('.ma-panel.focused')) return
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

      {/* 새 채팅 — 곧장 일반 채팅 생성 (자리 수는 채팅 크롬의 다이얼 소관) */}
      <button className="sb-new" onClick={onNewChat}>
        <IconPlus size={16} />
        <span>{t('새 채팅', 'New chat')}</span>
        <span className="kbd">{isMac ? '⌘N' : 'Ctrl+N'}</span>
      </button>
      {/* 추가 채팅 — 지금 작업과 따로 굴러가는 독립 대화를 새 창으로 연다 (호버 설명 없음 — 유저 결정) */}
      <button className="sb-new" onClick={() => window.api.openSessionWindow().catch(() => {})}>
        <IconMessage size={16} />
        <span>{t('추가 채팅', 'Extra chat')}</span>
        <span className="kbd">{isMac ? '⌘⇧N' : 'Ctrl+Shift+N'}</span>
      </button>
      {/* 프롬프트 — 자주 쓰는 프롬프트 라이브러리 모달 (저장해 두고 복사해 쓰기) */}
      <button className="sb-new" onClick={() => setPlibOpen(true)}>
        <IconClipList size={16} />
        <span>{t('프롬프트', 'Prompts')}</span>
      </button>

      <div className="sb-scroll scroll">
        {sections.map((s) => {
          const q = (queries[s.key] ?? '').trim().toLowerCase()
          const filtered = q ? s.chats.filter((c) => (c.title || t('새 채팅', 'New chat')).toLowerCase().includes(q)) : s.chats
          const searching = !!searchOpen[s.key]
          return (
            <div className="sb-sec" key={s.key}>
              <div className="sb-label">
                {s.label} <span className="sp" />
                <button
                  className={'slb' + (searching ? ' on' : '')}
                  title={t('검색', 'Search')}
                  aria-label={t(`${s.label} 검색`, `Search ${s.label}`)}
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
                    data-tip={s.deleteAllLock || (s.busy ? t('작업이 끝난 뒤 지울 수 있어요', 'You can delete after the run finishes') : t('전체 삭제', 'Delete all'))}
                    aria-label={t('전체 삭제', 'Delete all')}
                    disabled={s.busy || !!s.deleteAllLock || (s.deleteAllCount ?? s.chats.length) === 0}
                    onClick={() =>
                      setConfirm({ sec: s.key, id: null, ...confirmAllText(s.label, s.deleteAllCount ?? s.chats.length) })
                    }
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
                    placeholder={t(`${s.label} 검색…`, `Search ${s.label}…`)}
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
                    aria-label={t('검색 닫기', 'Close search')}
                    onClick={() => {
                      setSearchOpen((o) => ({ ...o, [s.key]: false }))
                      setQueries((qs) => ({ ...qs, [s.key]: '' }))
                    }}
                  >
                    <IconX2 size={11} />
                  </button>
                </div>
              )}

              {/* ★ 접힘 안내 — "대화는 그대로"라는 사실을 목록 위에서 한 번 더 말한다.
                  6→1로 내려도 아무것도 삭제되지 않는다는 것이 사용자 요구의 핵심이다 */}
              {s.hint && !searching && (
                <div className="sb-foldhint">
                  <span>⌄</span>
                  <span>{s.hint}</span>
                </div>
              )}
              <div className="sb-list">
                {filtered.length === 0 ? (
                  <div className="sb-empty">
                    {q ? t('검색 결과가 없어요', 'No matching chats') : (s.emptyText ?? t('채팅이 없어요', 'No chats yet'))}
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
                        <span className={'dot ' + dotClass(c.status, c.ask)} />
                        {isRenaming ? (
                          <RenameInput
                            initial={c.title || t('새 채팅', 'New chat')}
                            onDone={(commit, value) => {
                              setRenaming(null)
                              const v = value.trim()
                              if (commit && v) s.onRename?.(c.id, v)
                            }}
                          />
                        ) : (
                          <span className="t">
                            <span className="tx">{c.title || t('새 채팅', 'New chat')}</span>
                          </span>
                        )}
                        {/* ★ 자리 칩 — 「이 대화가 지금 어디에 있는가」. 접힌 자리는 흐린 ⌄N,
                            별도 창은 창 칩. 칩이 없으면 어느 자리에도 안 얹힌 대화다(§2.2-3) */}
                        {!isRenaming && c.slot && (
                          <span
                            className={
                              'slotchip' +
                              (c.slot.kind === 'folded' ? ' folded' : c.slot.kind === 'win' ? ' winchip' : '')
                            }
                            data-tag={c.slot.tag}
                          >
                            {c.slot.kind === 'folded' && <i>⌄</i>}
                            {c.slot.text}
                          </span>
                        )}
                        {/* ★ R3 — `ready` 대기표를 **눌러서** 이어간다(스펙 ⑤ 후반부).
                            엔진은 화면 밖 채팅의 대기표를 `ready`로만 켜고 멈춰 있다
                            (`auto_resume=false`) — 여기가 그 대기표의 유일한 출구다.
                            항목 클릭(전환)으로 새지 않게 전파를 끊는다. */}
                        {!isRenaming && c.resumeReady && s.onResume && (
                          <button
                            className="sb-resume has-tip"
                            data-tip={t('한도가 풀렸어요 — 눌러서 이어가기', 'Limit lifted — click to continue')}
                            aria-label={t('이어가기', 'Continue')}
                            onClick={(e) => {
                              e.stopPropagation()
                              s.onResume?.(c.id)
                            }}
                          >
                            {t('이어가기', 'Continue')}
                          </button>
                        )}
                        {/* 「실행」 배지 제거(2026-09-01 사용자) — 앞의 상태 점이 이미 실행 중을 말한다 */}
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

      <button className="sb-foot has-tip" data-tip={t('설정 열기', 'Open settings')} aria-label={t('설정 열기', 'Open settings')} onClick={onOpenSettings}>
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
            <div className="cmh">{menuChat.title || t('새 채팅', 'New chat')}</div>
            {menuSection.onRename && (
              <button
                className="ctx-item"
                onClick={() => {
                  setMenu(null)
                  startRename(menu.sec, menu.id)
                }}
              >
                <IconPencil size={15} /> {t('이름 변경', 'Rename')}
              </button>
            )}
            {/* ★ R3 — 「창 닫기」는 삭제가 **아니다**. `win:chat-close`가 창만 닫고 대화는
                목록에 남는다("자리는 뷰, 대화는 접힐 뿐 사라지지 않는다"). 옛
                `session-wins:close`(=삭제)와 의미가 정반대라 항목을 따로 둔다 — 합치면
                둘 중 하나가 반드시 대화를 잃는다(배선 R3 §R3.4). */}
            {menuChat.winOpen && menuSection.onCloseWindow && (
              <button
                className="ctx-item"
                onClick={() => {
                  setMenu(null)
                  menuSection.onCloseWindow?.(menu.id)
                }}
              >
                <IconX2 size={15} /> {t('창 닫기 — 대화는 남아요', 'Close window — the chat stays')}
              </button>
            )}
            <div className="ctx-sep" />
            {/* ★ R2 — 도는 대화는 여기서 잠긴다(2.6.2 파리티). 왜 잠겼는지는 title이 말하고,
                단축키(Delete)로 들어오면 askDelete의 카드가 같은 문장을 말한다. */}
            <button
              className="ctx-item danger"
              disabled={
                !!menuChat.lock || (!!menuSection.busy && (menuSection.currentId ?? menuSection.activeId) === menu.id)
              }
              title={menuChat.lock || undefined}
              onClick={() => {
                setMenu(null)
                askDelete(menu.sec, menu.id)
              }}
            >
              <IconTrash size={15} /> {t('삭제', 'Delete')}
            </button>
            {menuChat.lock && <div className="cmwhy">{menuChat.lock}</div>}
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
                {confirm.blocked ? (
                  // 막힌 카드에는 파괴 버튼이 없다 — 누를 것을 주면 또 침묵 no-op이 된다
                  <button className="cancel" onClick={() => setConfirm(null)}>
                    {t('확인', 'OK')}
                  </button>
                ) : (
                  <>
                    <button className="cancel" onClick={() => setConfirm(null)}>
                      {t('취소', 'Cancel')}
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
                      {confirm.id ? t('삭제', 'Delete') : t('모두 삭제', 'Delete all')}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* 프롬프트 라이브러리 — 다른 오버레이처럼 body 포털 (fixed 좌표가 조상에 안 묶이게) */}
      {plibOpen && createPortal(<PromptLibrary onClose={() => setPlibOpen(false)} />, document.body)}
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
