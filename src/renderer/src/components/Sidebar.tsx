import { memo, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AppUser, AgentStatus } from '@shared/protocol'
import { useAppVersion } from '../lib/version'
import { getPref, setPref } from '../lib/prefs'
import { IconSearch, IconPlus, IconMore, IconPencil, IconSpark, IconTrash, IconCode, IconGrid, IconMessage, IconChevLeft, IconPanelLeft } from './icons'

// 채팅 = pure conversation (no folder/explorer) · single = one coding agent · multi = parallel agents
export type WorkspaceMode = 'chat' | 'single' | 'multi'

export interface ChatSummary {
  id: string
  title: string
  status: AgentStatus
  hasPrompt?: boolean // 채팅별 프롬프트가 설정돼 있음 — 제목 옆 글리프로 표시
}

const isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac')

function statusSub(status: AgentStatus): string {
  return status === 'idle'
    ? '대기 중'
    : status === 'done'
      ? '완료됨'
      : status === 'error'
        ? '오류'
        : status === 'working'
          ? '진행 중'
          : '분석 중'
}

function dotClass(status: AgentStatus): string {
  if (status === 'done') return 'done'
  if (status === 'working' || status === 'analyzing') return 'run'
  return ''
}

const MENU_W = 178

function RecentChats({
  chats,
  activeChatId,
  busy,
  query,
  onSelect,
  onRename,
  onDelete,
  onPrompt
}: {
  chats: ChatSummary[]
  activeChatId: string
  busy: boolean
  query: string
  onSelect: (id: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  onPrompt?: (id: string) => void // 채팅별 프롬프트 설정 — 단일 모드만 제공
}) {
  // 메뉴 높이는 화면 가장자리 클램프용 추정치 — 프롬프트 항목이 있으면 한 줄 더
  const menuH = onPrompt ? 127 : 92
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [dialog, setDialog] = useState<{ kind: 'rename' | 'delete'; id: string; title: string } | null>(null)
  const [draft, setDraft] = useState('')

  // close the context menu on any outside interaction
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

  // Esc closes the rename/delete dialog
  useEffect(() => {
    if (!dialog) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setDialog(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [dialog])

  const openRename = (id: string): void => {
    const chat = chats.find((c) => c.id === id)
    setDraft(chat?.title || '')
    setDialog({ kind: 'rename', id, title: chat?.title || '새 채팅' })
    setMenu(null)
  }
  const openDelete = (id: string): void => {
    const chat = chats.find((c) => c.id === id)
    setDialog({ kind: 'delete', id, title: chat?.title || '새 채팅' })
    setMenu(null)
  }
  const commitRename = (): void => {
    if (!dialog) return
    const name = draft.trim()
    if (name) onRename(dialog.id, name)
    setDialog(null)
  }
  const confirmDelete = (): void => {
    if (!dialog) return
    onDelete(dialog.id)
    setDialog(null)
  }

  const q = query.trim().toLowerCase()
  const filtered = q ? chats.filter((c) => (c.title || '새 채팅').toLowerCase().includes(q)) : chats

  return (
    <>
      {filtered.length === 0 ? (
        <div className="sb-empty">{q ? '검색 결과가 없어요' : '아직 채팅이 없어요'}</div>
      ) : (
        filtered.map((c) => {
          const active = c.id === activeChatId
          const locked = busy && !active
          return (
            <div
              key={c.id}
              role="button"
              tabIndex={0}
              className={'sb-item' + (active ? ' active' : '') + (locked ? ' locked' : '')}
              onClick={() => !locked && onSelect(c.id)}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && !locked) {
                  e.preventDefault()
                  onSelect(c.id)
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ id: c.id, x: e.clientX, y: e.clientY })
              }}
            >
              <span className={'dot ' + dotClass(c.status)} />
              <span className="txt">
                <div className="t1">
                  <span className="t1-text">{c.title || '새 채팅'}</span>
                  {c.hasPrompt && (
                    <span className="pr-mark has-tip" data-tip="프롬프트 설정됨">
                      <IconSpark size={11} stroke={2.4} />
                    </span>
                  )}
                </div>
                {c.status !== 'idle' && <div className="t2">{statusSub(c.status)}</div>}
              </span>
              <button
                className="more"
                aria-label="채팅 메뉴"
                onClick={(e) => {
                  e.stopPropagation()
                  const r = e.currentTarget.getBoundingClientRect()
                  setMenu({ id: c.id, x: r.right - MENU_W, y: r.bottom + 6 })
                }}
              >
                <IconMore size={16} />
              </button>
            </div>
          )
        })
      )}

      {menu && (
        <div
          className="ctx-menu"
          style={{
            left: Math.max(8, Math.min(menu.x, window.innerWidth - MENU_W - 8)),
            top: Math.max(8, Math.min(menu.y, window.innerHeight - menuH - 8))
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button className="ctx-item" onClick={() => openRename(menu.id)}>
            <IconPencil size={15} /> 이름 변경
          </button>
          {onPrompt && (
            <button
              className="ctx-item"
              onClick={() => {
                onPrompt(menu.id)
                setMenu(null)
              }}
            >
              <IconSpark size={15} /> 프롬프트 설정
            </button>
          )}
          <div className="ctx-sep" />
          <button className="ctx-item danger" onClick={() => openDelete(menu.id)}>
            <IconTrash size={15} /> 삭제
          </button>
        </div>
      )}

      {dialog && (
        <div className="set-dialog-overlay" onMouseDown={() => setDialog(null)}>
          <div className="set-dialog" onMouseDown={(e) => e.stopPropagation()}>
            {dialog.kind === 'delete' ? (
              <>
                <div className="sd-ic">
                  <IconTrash size={22} />
                </div>
                <div className="sd-title">채팅 삭제</div>
                <div className="sd-msg">
                  <b>{dialog.title}</b> 채팅을 삭제할까요? 되돌릴 수 없습니다.
                </div>
                <div className="sd-btns">
                  <button className="sd-cancel" onClick={() => setDialog(null)}>
                    취소
                  </button>
                  <button className="sd-go danger" onClick={confirmDelete}>
                    삭제
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="sd-ic warn">
                  <IconPencil size={20} />
                </div>
                <div className="sd-title">이름 변경</div>
                <input
                  className="sd-input"
                  autoFocus
                  value={draft}
                  placeholder="채팅 이름"
                  onChange={(e) => setDraft(e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    else if (e.key === 'Escape') setDialog(null)
                  }}
                />
                <div className="sd-btns">
                  <button className="sd-cancel" onClick={() => setDialog(null)}>
                    취소
                  </button>
                  <button className="sd-go" onClick={commitRename}>
                    저장
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}

export const Sidebar = memo(function Sidebar({
  user,
  chats,
  activeChatId,
  busy,
  chatQuery,
  onChatQuery,
  onNewChat,
  onSelectChat,
  onRenameChat,
  onDeleteChat,
  onDeleteAllChats,
  onPromptChat,
  onOpenSettings,
  mode = 'single',
  onModeChange,
  listLabel = '최근 채팅',
  newLabel = '새 채팅',
  newTip = '새로운 대화를 시작해요',
  searchLabel = '채팅 검색…'
}: {
  user: AppUser
  chats: ChatSummary[]
  activeChatId: string
  busy: boolean
  chatQuery: string
  onChatQuery: (q: string) => void
  onNewChat: () => void
  onSelectChat: (id: string) => void
  onRenameChat: (id: string, name: string) => void
  onDeleteChat: (id: string) => void
  onDeleteAllChats?: () => void // 목록 전체 삭제 — 라벨 행의 휴지통, 확인 카드 후 실행
  onPromptChat?: (id: string) => void // 채팅별 프롬프트 설정 (단일 모드)
  onOpenSettings: () => void
  mode?: WorkspaceMode
  onModeChange?: (m: WorkspaceMode) => void
  listLabel?: string // recent-list heading (단일: 최근 채팅 · 멀티: 최근 작업)
  newLabel?: string // new-item button label
  newTip?: string // new-item button hover tooltip (설명형 — 라벨 반복이 아니라 동작 설명)
  searchLabel?: string // search input placeholder (단일: 채팅 검색 · 멀티: 작업 검색)
}) {
  const appVersion = useAppVersion()
  // 접힘 상태는 Sidebar 안에서 관리 — 단일/멀티 모드 어느 쪽에서 접어도 같은
  // pref('sidebar.open')를 읽고 쓰므로 모드를 오가도 상태가 이어진다
  const [open, setOpen] = useState<boolean>(() => getPref<boolean>('sidebar.open', true))
  // 전체 삭제 확인 카드 — 개별 삭제와 같은 set-dialog 이디엄, Esc로 닫힌다
  const [confirmAll, setConfirmAll] = useState(false)
  useEffect(() => {
    if (!confirmAll) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setConfirmAll(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [confirmAll])
  // 라벨('최근 채팅'/'최근 작업')에서 항목 단어를 따와 확인 문구에 쓴다
  const itemWord = listLabel.includes('작업') ? '작업' : '채팅'
  const toggle = (): void => {
    setOpen((o) => {
      setPref('sidebar.open', !o)
      return !o
    })
  }

  // ` (백쿼트) 한 키로 접기/펼치기 — 글자가 들어가는 입력(컴포저 등)에서는 무시
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== '`' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      const ae = document.activeElement as HTMLElement | null
      if (ae && (['INPUT', 'TEXTAREA', 'SELECT'].includes(ae.tagName) || ae.isContentEditable)) return
      e.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 접힘 시 "다시 열기" 토글을 타이틀바 좌측 슬롯에 포털한다 — 단축키(`) 몰라도 클릭으로
  // 열 수 있고, 타이틀바는 모든 모드 공통(한 번만 렌더)이라 채팅·코드·멀티 어디서나 동작.
  // 슬롯 DOM은 마운트 뒤에 잡는다(첫 커밋 전엔 없으므로).
  const [tbSlot, setTbSlot] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setTbSlot(document.getElementById('tb-left-slot'))
  }, [])

  // 접힘: 잔여 레일 없이 완전히 사라진다 — 칼럼이 깔끔하게 닫힌다.
  if (!open) {
    return tbSlot
      ? createPortal(
          <button className="tb-sb-toggle has-tip" data-tip="사이드바 열기 ( ` )" aria-label="사이드바 열기" onClick={toggle}>
            <IconPanelLeft size={16} />
          </button>,
          tbSlot
        )
      : null
  }

  return (
    <aside className="sidebar">
      <div className="sb-top">
        <div className="sb-ws">
          <div className="mark"><IconCode size={15} stroke={2.2} /></div>
          <div>
            <div className="name">AgentCodeGUI</div>
            <div className="sub">{`Coding Agent · v${appVersion}`}</div>
          </div>
        </div>
        <button className="sb-collapse has-tip" data-tip="사이드바 접기 ( ` )" aria-label="사이드바 접기" onClick={toggle}>
          <IconChevLeft size={14} />
        </button>
      </div>

      {onModeChange && (
        <div className="sb-mode three" role="tablist" aria-label="작업 모드">
          <button
            role="tab"
            aria-selected={mode === 'chat'}
            className={'sb-mode-btn has-tip' + (mode === 'chat' ? ' on' : '')}
            data-tip="폴더 없이 순수하게 대화만"
            onClick={() => onModeChange('chat')}
          >
            <IconMessage size={14} />
            <span>채팅</span>
          </button>
          <button
            role="tab"
            aria-selected={mode === 'single'}
            className={'sb-mode-btn has-tip' + (mode === 'single' ? ' on' : '')}
            data-tip="탐색기·코드 인텔리전스를 갖춘 코드 작업 공간"
            onClick={() => onModeChange('single')}
          >
            <IconCode size={14} />
            <span>코드</span>
          </button>
          <button
            role="tab"
            aria-selected={mode === 'multi'}
            className={'sb-mode-btn has-tip' + (mode === 'multi' ? ' on' : '')}
            data-tip="여러 에이전트로 동시에 작업"
            onClick={() => onModeChange('multi')}
          >
            <IconGrid size={14} />
            <span>멀티</span>
          </button>
        </div>
      )}

      {/* 추가 채팅 — 지금 작업과 따로 굴러가는 독립 대화를 새 창으로 연다 (어느 모드에서든) */}
      <button
        className="sb-new sb-addchat has-tip"
        onClick={() => window.api.openSessionWindow().catch(() => {})}
        data-tip="새 창으로 독립 대화 — 지금 작업과 따로 굴러가요"
      >
        <IconMessage size={16} />
        <span>추가 채팅</span>
        <span className="kbd">{isMac ? '⌘ Shift N' : 'Ctrl Shift N'}</span>
      </button>

      <button className="sb-new has-tip" onClick={onNewChat} disabled={busy} data-tip={busy ? '작업이 끝난 뒤 시작할 수 있어요' : newTip}>
        <IconPlus size={16} />
        <span>{newLabel}</span>
        <span className="kbd">{isMac ? '⌘N' : 'Ctrl N'}</span>
      </button>

      <div className="sb-search">
        <IconSearch size={15} />
        <input placeholder={searchLabel} value={chatQuery} onChange={(e) => onChatQuery(e.target.value)} />
      </div>

      <div className="sb-label">
        <span>{listLabel}</span>
        {onDeleteAllChats && chats.length > 0 && (
          <button
            className="sb-clear has-tip"
            data-tip={busy ? '작업이 끝난 뒤 지울 수 있어요' : '전체 삭제'}
            aria-label="전체 삭제"
            disabled={busy}
            onClick={() => setConfirmAll(true)}
          >
            <IconTrash size={13} />
          </button>
        )}
      </div>
      <div className="sb-list scroll">
        <RecentChats
          chats={chats}
          activeChatId={activeChatId}
          busy={busy}
          query={chatQuery}
          onSelect={onSelectChat}
          onRename={onRenameChat}
          onDelete={onDeleteChat}
          onPrompt={onPromptChat}
        />
      </div>

      <button className="sb-foot has-tip" data-tip="설정 열기" aria-label="설정 열기" onClick={onOpenSettings}>
        <div className="ava" style={{ background: user.avatarColor, color: '#fff' }}>
          {user.avatarText}
        </div>
        <div className="who">
          <div className="n">{user.name}</div>
        </div>
      </button>

      {confirmAll && (
        <div className="set-dialog-overlay" onMouseDown={() => setConfirmAll(false)}>
          <div className="set-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <div className="sd-ic">
              <IconTrash size={22} />
            </div>
            <div className="sd-title">전체 삭제</div>
            <div className="sd-msg">
              {itemWord} <b>{chats.length}개</b>를 모두 삭제할까요? 되돌릴 수 없습니다.
            </div>
            <div className="sd-btns">
              <button className="sd-cancel" onClick={() => setConfirmAll(false)}>
                취소
              </button>
              <button
                className="sd-go danger"
                onClick={() => {
                  onDeleteAllChats?.()
                  setConfirmAll(false)
                }}
              >
                모두 삭제
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
})
