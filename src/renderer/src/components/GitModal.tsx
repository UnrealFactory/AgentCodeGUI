import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileDiff, GitChange, GitCommit, GitStatus } from '@shared/protocol'
import { FileBadge } from './fileType'
import { IconCheck, IconClaude, IconClose, IconGitBranch, IconMax, IconRestore, IconSearch } from './icons'
import { useResizableModal, ModalResizeHandles } from './resizableModal'
import { mergeRefs } from './zoom'
import { MouseGestureLayer } from './mouseGesture'

// Fork의 정보 구조(내비 · 커밋 리스트 · 상세)를 앱의 모달 카드 언어로 옮긴 Git 카드.
// 데이터는 전부 읽기 전용 git 명령(IPC)이고, 쓰기 동작은 커밋·푸시·--ff-only 풀뿐.
// 파일 열람은 기존 코드 뷰어(FileModal)에 위임한다 — 작업 트리 파일은 디스크 내용
// + HEAD→디스크 마킹(LSP 살아 있음), 커밋 파일은 그 시점 내용 + 부모→커밋 마킹.

export interface GitFileOpen {
  path: string // 뷰어에 넘길 경로 (root==cwd면 rel posix, 아니면 절대 경로)
  content: string | null // 커밋 시점 내용 (null = 디스크에서 읽기)
  diff: FileDiff | null // 변경 마킹
  label: string | null // 헤더 칩 (커밋 짧은 해시 등)
}

const STATUS_CLS: Record<string, string> = { M: 'm', A: 'a', D: 'd', R: 'm' }

function dayLabel(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = Math.round((today - day) / 86_400_000)
  if (diff === 0) return '오늘'
  if (diff === 1) return '어제'
  if (d.getFullYear() !== now.getFullYear()) return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`
  return `${d.getMonth() + 1}월 ${d.getDate()}일`
}
function agoLabel(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return '방금'
  if (s < 3600) return `${Math.floor(s / 60)}분 전`
  if (s < 86_400) return `${Math.floor(s / 3600)}시간 전`
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function fullDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function sameDir(a: string, b: string): boolean {
  const n = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
  return n(a) === n(b)
}

function FileRow({ c, onOpen }: { c: GitChange; onOpen: (c: GitChange) => void }) {
  const slash = c.path.lastIndexOf('/')
  const dir = slash >= 0 ? c.path.slice(0, slash + 1) : ''
  const name = slash >= 0 ? c.path.slice(slash + 1) : c.path
  return (
    <button className="gitm-file" onClick={() => onOpen(c)} data-tip={c.path}>
      <span className={'gitm-st ' + (STATUS_CLS[c.status] ?? 'm')}>{c.status}</span>
      <FileBadge path={c.path} size={16} />
      <span className="fn">
        <span className="dir">{dir}</span>
        {name}
      </span>
      <span className="stat">
        {c.add != null && c.add > 0 ? <span className="add">+{c.add}</span> : null}
        {c.del != null && c.del > 0 ? <span className="del">−{c.del}</span> : null}
      </span>
    </button>
  )
}

export function GitModal({
  root,
  cwd,
  onClose,
  onOpenFile,
  onAskClaude
}: {
  root: string
  cwd: string
  onClose: () => void
  onOpenFile: (p: GitFileOpen) => void
  // "Claude에게 메시지 짓게 하기" — 활성 채팅에 커밋 작업을 위임하고 카드를 닫는다
  onAskClaude: (prompt: string) => void
}) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [commits, setCommits] = useState<GitCommit[] | null>(null)
  const [view, setView] = useState<'changes' | 'history'>('history')
  const [selHash, setSelHash] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, GitChange[]>>({})
  const [query, setQuery] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState<'commit' | 'push' | 'pull' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const rz = useResizableModal('git.size', true)
  const downOnOverlay = useRef(false)
  // 마우스 제스처(↓→ 닫기) 대상 — 카드 엘리먼트를 state로 추적 (스크롤 페인이 셋이라 ↑/↓는 없음)
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null)
  const modalRef = useMemo(() => mergeRefs(rz.ref, setCardEl), [rz.ref])

  const refresh = useCallback((): void => {
    window.api.git.status(root).then(setStatus).catch(() => {})
    window.api.git
      .log(root, 100)
      .then((list) => {
        setCommits(list)
        setSelHash((h) => h ?? list[0]?.hash ?? null)
      })
      .catch(() => {})
  }, [root])
  useEffect(refresh, [refresh])

  // Esc — 위에 떠 있는 파일 뷰어가 우선 (뷰어의 Esc가 그쪽 카드만 닫는다)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (document.querySelector('.fv-overlay, .sel-bar')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 선택된 커밋의 변경 파일 — 한 번 받아오면 캐시
  useEffect(() => {
    if (!selHash || details[selHash]) return
    let alive = true
    window.api.git
      .commitDetail(root, selHash)
      .then((files) => alive && setDetails((d) => ({ ...d, [selHash]: files })))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [selHash, root, details])

  const repoName = root.split(/[\\/]/).filter(Boolean).pop() ?? root
  // root가 곧 작업 폴더면 rel 경로로(뷰어 헤더가 깔끔), 상위 레포면 절대 경로로
  const viewerPath = useCallback(
    (rel: string): string => (sameDir(root, cwd) ? rel : root.replace(/[\\/]+$/, '') + '\\' + rel.replace(/\//g, '\\')),
    [root, cwd]
  )

  const openWorking = (c: GitChange): void => {
    if (c.status === 'D') return // 디스크에 없는 파일 — 열 것이 없다
    window.api.git
      .workingFile(root, c.path)
      .then((r) => onOpenFile({ path: viewerPath(c.path), content: null, diff: r.diff, label: null }))
      .catch(() => {})
  }
  const openAtCommit = (hash: string, shortHash: string) => (c: GitChange): void => {
    window.api.git
      .fileAt(root, hash, c.path)
      .then((r) => {
        if (r.content == null) {
          setErr(r.error ?? '파일을 열 수 없어요')
          return
        }
        onOpenFile({ path: viewerPath(c.path), content: r.content, diff: r.diff, label: shortHash })
      })
      .catch(() => {})
  }

  const doCommit = (): void => {
    if (!subject.trim() || busy) return
    setBusy('commit')
    setErr(null)
    window.api.git
      .commit(root, subject.trim(), body.trim())
      .then((r) => {
        if (r.ok) {
          setSubject('')
          setBody('')
          refresh()
        } else setErr(r.error ?? '커밋 실패')
      })
      .finally(() => setBusy(null))
  }
  const doSync = (kind: 'push' | 'pull'): void => {
    if (busy) return
    setBusy(kind)
    setErr(null)
    const op = kind === 'push' ? window.api.git.push(root) : window.api.git.pull(root)
    op.then((r) => {
      if (!r.ok) setErr(r.error ?? (kind === 'push' ? '푸시 실패' : '풀 실패'))
      refresh()
    }).finally(() => setBusy(null))
  }

  const askClaude = (): void => {
    onAskClaude(
      'git 작업 트리의 변경 사항을 검토해서, 이 저장소의 기존 커밋 메시지 스타일에 맞는 커밋 메시지를 작성해 커밋해줘. 푸시는 하지 마.'
    )
    onClose()
  }

  // 커밋 검색 — 메시지·해시·작성자·태그
  const filtered = useMemo(() => {
    if (!commits) return null
    const q = query.trim().toLowerCase()
    if (!q) return commits
    return commits.filter(
      (c) =>
        c.subject.toLowerCase().includes(q) ||
        c.body.toLowerCase().includes(q) ||
        c.hash.startsWith(q) ||
        c.author.toLowerCase().includes(q) ||
        c.tags.some((t) => t.toLowerCase().includes(q))
    )
  }, [commits, query])

  const sel = selHash && commits ? commits.find((c) => c.hash === selHash) ?? null : null
  const changeCount = status?.changes.length ?? 0

  // 날짜 그룹 헤더를 끼워 넣은 렌더 목록
  const rows: React.ReactNode[] = []
  if (filtered) {
    let lastDay = ''
    for (const c of filtered) {
      const day = dayLabel(c.date)
      if (day !== lastDay) {
        lastDay = day
        rows.push(
          <div className="gitm-day" key={'day-' + day + c.hash}>
            {day}
          </div>
        )
      }
      rows.push(
        <button
          key={c.hash}
          className={'gitm-commit' + (c.pushed ? ' pushed' : '') + (c.hash === selHash ? ' sel' : '')}
          onClick={() => setSelHash(c.hash)}
        >
          <span className="c-rail">
            <span className="c-dot" />
            <span className="c-line" />
          </span>
          <span className="c-main">
            {/* 메시지만 말줄임표로 줄고 태그는 항상 보인다 — 태그가 텍스트 흐름에
                이어 붙으면 긴 메시지에서 … 뒤로 잘려 나간다 */}
            <span className="c-msg">
              <span className="t">{c.subject || '(메시지 없음)'}</span>
              {c.tags.map((t) => (
                <span className="c-tag" key={t}>
                  {t}
                </span>
              ))}
            </span>
            <span className="c-meta">
              <span className="c-hash">{c.shortHash}</span>
              <span>{agoLabel(c.date)}</span>
              <span>{c.author}</span>
            </span>
          </span>
        </button>
      )
    }
  }

  return (
    <div
      className="gitm-overlay"
      onMouseDown={(e) => {
        downOnOverlay.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        if (downOnOverlay.current && e.target === e.currentTarget) onClose()
      }}
    >
      <div className="gitm-modal rzm" ref={modalRef} style={rz.modalStyle}>
        <MouseGestureLayer target={cardEl} actions={[{ pattern: 'DR', label: '창 닫기', run: onClose }]} />
        {!rz.maximized && <ModalResizeHandles onStart={rz.startResize} />}
        <div className="diff-head" onDoubleClick={rz.onHeaderDoubleClick}>
          <span className="gitm-ic">
            <IconGitBranch size={17} />
          </span>
          <span className="gitm-name">{repoName}</span>
          {status && (
            <span className="gitm-br">
              ⎇ {status.branch}
              {status.ahead > 0 && <i className="ab">↑{status.ahead}</i>}
              {status.behind > 0 && <i className="ab bh">↓{status.behind}</i>}
            </span>
          )}
          <span className="gitm-path">{root}</span>
          <span className="dspacer" />
          {err && <span className="gitm-err htip" data-tip={err}>{err}</span>}
          <button className="gitm-btn" onClick={() => doSync('pull')} disabled={busy != null}>
            {busy === 'pull' ? <span className="spin" /> : '⇣'} 당겨오기
          </button>
          <button
            className={'gitm-btn' + ((status?.ahead ?? 0) > 0 ? ' pri' : '')}
            onClick={() => doSync('push')}
            disabled={busy != null}
          >
            {busy === 'push' ? <span className="spin" /> : '⇡'} 푸시{(status?.ahead ?? 0) > 0 ? ` ${status?.ahead}` : ''}
          </button>
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

        <div className="gitm-body">
          {/* ── 좌측 내비 ── */}
          <nav className="gitm-nav scroll">
            <div className="gitm-sec">작업 트리</div>
            <button className={'gitm-item' + (view === 'changes' ? ' on' : '')} onClick={() => setView('changes')}>
              <span className="ic">±</span>변경 사항
              {changeCount > 0 && <span className="n warn">{changeCount}</span>}
            </button>
            <div className="gitm-sec">히스토리</div>
            <button className={'gitm-item' + (view === 'history' ? ' on' : '')} onClick={() => setView('history')}>
              <span className="ic">⏱</span>모든 커밋
              {commits && <span className="n">{commits.length}{commits.length >= 100 ? '+' : ''}</span>}
            </button>
            {status && status.branches.length > 0 && (
              <>
                <div className="gitm-sec">브랜치</div>
                {status.branches.map((b) => (
                  <div className="gitm-item static" key={b.name}>
                    <span className="ic">⎇</span>
                    <span className="nm">{b.name}</span>
                    {b.current && (
                      <span className="cur">
                        <IconCheck size={11} />
                      </span>
                    )}
                  </div>
                ))}
              </>
            )}
            {status && status.remotes.length > 0 && (
              <>
                <div className="gitm-sec">원격</div>
                {status.remotes.map((r) => (
                  <div className="gitm-item static" key={r}>
                    <span className="ic">☁</span>
                    <span className="nm">{r}</span>
                  </div>
                ))}
              </>
            )}
            {status && status.tags.length > 0 && (
              <>
                <div className="gitm-sec">태그</div>
                {status.tags.map((t) => (
                  <button
                    className="gitm-item"
                    key={t}
                    onClick={() => {
                      setView('history')
                      setQuery(t)
                    }}
                  >
                    <span className="ic">⌂</span>
                    <span className="nm">{t}</span>
                  </button>
                ))}
              </>
            )}
          </nav>

          {view === 'history' ? (
            <>
              {/* ── 커밋 리스트 ── */}
              <section className="gitm-list">
                <div className="gitm-filter">
                  <IconSearch size={13} />
                  <input
                    value={query}
                    placeholder="커밋 메시지·해시·작성자 검색…"
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {query && (
                    <button className="x" onClick={() => setQuery('')} aria-label="검색 지우기">
                      <IconClose size={12} />
                    </button>
                  )}
                </div>
                <div className="gitm-scroll scroll">
                  {commits == null ? (
                    <div className="gitm-state">
                      <span className="spin" />
                    </div>
                  ) : rows.length ? (
                    rows
                  ) : (
                    <div className="gitm-state">{query ? '검색 결과가 없어요' : '커밋이 없어요'}</div>
                  )}
                </div>
              </section>
              {/* ── 커밋 상세 ── */}
              <aside className="gitm-detail scroll">
                {sel ? (
                  <>
                    <div className="gd-pad">
                      <div className="gd-msg">{sel.subject}</div>
                      {sel.body && <div className="gd-desc">{sel.body}</div>}
                      <div className="gd-meta">
                        <span className="gd-av">{(sel.author || '?').slice(0, 1).toUpperCase()}</span>
                        <span className="gd-who">
                          <b>{sel.author}</b>
                          <i>{fullDate(sel.date)}</i>
                        </span>
                        <button
                          className="gd-hash"
                          onClick={() => {
                            navigator.clipboard?.writeText(sel.hash).then(() => {
                              setCopied(true)
                              setTimeout(() => setCopied(false), 1200)
                            }, () => {})
                          }}
                        >
                          {copied ? '복사됨' : sel.shortHash + ' ⧉'}
                        </button>
                      </div>
                    </div>
                    <div className="gitm-sec line">변경된 파일 {details[sel.hash]?.length ?? ''}</div>
                    {details[sel.hash] ? (
                      details[sel.hash].map((c) => <FileRow key={c.path} c={c} onOpen={openAtCommit(sel.hash, sel.shortHash)} />)
                    ) : (
                      <div className="gitm-state small">
                        <span className="spin" />
                      </div>
                    )}
                  </>
                ) : (
                  <div className="gitm-state">커밋을 선택하세요</div>
                )}
              </aside>
            </>
          ) : (
            /* ── 변경 사항 (작업 트리) ── */
            <section className="gitm-list wide">
              <div className="gitm-scroll scroll">
                <div className="gitm-day">변경된 파일 {changeCount}</div>
                {status == null ? (
                  <div className="gitm-state">
                    <span className="spin" />
                  </div>
                ) : changeCount === 0 ? (
                  <div className="gitm-state">작업 트리가 깨끗해요 ✓</div>
                ) : (
                  status.changes.map((c) => <FileRow key={c.path} c={c} onOpen={openWorking} />)
                )}
                {changeCount > 0 && (
                  <div className="gitm-hint">
                    파일을 클릭하면 코드 뷰어에서 커밋 전 변경 내용(추가 초록·삭제 빨강)으로 열려요.
                  </div>
                )}
              </div>
              <div className="gitm-compose">
                <input
                  value={subject}
                  placeholder="커밋 메시지"
                  onChange={(e) => setSubject(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      doCommit()
                    }
                  }}
                />
                <textarea value={body} rows={2} placeholder="설명 (선택)" onChange={(e) => setBody(e.target.value)} />
                <div className="row">
                  <button className="gitm-btn claude" onClick={askClaude} disabled={changeCount === 0}>
                    <IconClaude size={13} /> Claude에게 메시지 짓게 하기
                  </button>
                  <span className="sp" />
                  <button className="gitm-btn pri" onClick={doCommit} disabled={!subject.trim() || changeCount === 0 || busy != null}>
                    {busy === 'commit' ? <span className="spin" /> : null} 커밋
                  </button>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
