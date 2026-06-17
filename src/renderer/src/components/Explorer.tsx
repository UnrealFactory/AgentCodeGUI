import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChangedFile, DirEntry } from '@shared/protocol'
import { FileBadge } from './fileType'
import { getPref, setPref } from '../lib/prefs'
import { IconChevLeft, IconChevRight, IconFolder, IconFolderOpen, IconGitBranch, IconPlus, IconSearch, IconX2 } from './icons'

const isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac')

// 펼쳐둔 폴더 목록의 저장 키 — 작업 폴더별로 따로 기억한다
function expandedKey(cwd: string): string {
  return 'explorer.expanded:' + cwd.replace(/[\\/]+/g, '/').toLowerCase()
}

// 참고 폴더 목록의 저장 키 — 메인 작업 폴더별로 따로 기억한다
function refsKey(cwd: string): string {
  return 'explorer.refs:' + cwd.replace(/[\\/]+/g, '/').toLowerCase()
}

/**
 * 파일 탐색기 — 채팅 옆의 접이식 칼럼 (A안). 활성 채팅의 작업 폴더가 곧 트리의
 * 루트라서 폴더를 따로 "여는" 개념이 없다: 채팅을 바꾸면 트리도 따라간다.
 *
 * 여기에 "+ 폴더 추가"로 보기 전용 참고 폴더를 더 열 수 있다. 폴더 리스트에서
 * 클릭 한 번으로 메인과 참고 폴더를 왔다갔다하며, 에이전트의 작업 폴더(cwd)에는
 * 영향이 없다 — 트리 탐색·파일 열람·검색만 된다. 목록은 메인 폴더별로 ui-prefs에
 * 영속되고, 펼침 상태·선택도 폴더별로 따로 기억된다.
 *
 * 디렉터리는 펼칠 때마다 IPC로 그 폴더 하나만 읽는다(lazy). 전체 인덱싱이 없으니
 * node_modules 가 있는 큰 저장소도 즉시 열리고, 펼친 폴더 목록만 메모리에 남는다.
 * `refreshKey`가 바뀌면(에이전트 턴 종료) 루트 + 펼쳐둔 폴더를 다시 읽어
 * 방금 생성/삭제된 파일이 새로고침 없이 나타난다.
 */
export const Explorer = memo(function Explorer({
  cwd,
  open,
  onToggle,
  refreshKey,
  onPickFolder,
  onOpenFile,
  changed,
  gitReady,
  onOpenGit,
  onViewFolderChange
}: {
  cwd: string
  open: boolean
  onToggle: () => void
  refreshKey: number // bump → re-read root + every expanded folder
  onPickFolder: () => void
  onOpenFile: (relPath: string) => void // forward-slash, cwd-relative — 참고 폴더의 파일은 절대 경로
  changed?: ChangedFile[] // 이 세션에서 AI가 만든/수정한 파일 (rel posix) → 색·배지 표시
  gitReady?: boolean // 메인 작업 폴더가 git 레포 안에 있는지 (상위 탐색 포함)
  onOpenGit?: () => void // ⎇ 버튼 → Git 카드 (커밋 히스토리·변경 사항)
  onViewFolderChange?: (folder: string) => void // 지금 보고 있는 폴더(메인/참고)를 알림 → 채팅 @ 멘션의 기준
}) {
  // 참고 폴더(보기 전용) 목록과 지금 보고 있는 폴더('' = 메인). cwd가 바뀌면(채팅
  // 전환/폴더 변경) 렌더 중에 같이 갈아끼워, stale한 루트로 트리를 한 번 더 읽는
  // 깜빡임이 없게 한다.
  const [refs, setRefs] = useState<string[]>(() => (cwd ? getPref<string[]>(refsKey(cwd), []) : []))
  const [view, setView] = useState('')
  const [prevCwd, setPrevCwd] = useState(cwd)
  if (prevCwd !== cwd) {
    setPrevCwd(cwd)
    setRefs(cwd ? getPref<string[]>(refsKey(cwd), []) : [])
    setView('')
  }
  const viewing = view && refs.includes(view) ? view : '' // '' = 메인 폴더 보기
  const root = viewing || cwd // 지금 트리가 보여주는 폴더

  // rel path('' = root) → that folder's entries; only loaded (visited) folders exist here
  const [entries, setEntries] = useState<Map<string, DirEntry[]>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // 참고 폴더도 미리 데워 둔다(메인은 App에서 prewarm) — 첫 파일 열 때 빠르게.
  // 심볼 분석 진행 표시는 코드창(파일별 "심볼 분석 중 %")으로 옮겼다 — 폴더 배지 없음.
  useEffect(() => {
    refs.forEach((d) => window.api.lsp.prewarm(d).catch(() => {}))
  }, [refs])
  const [sel, setSel] = useState<string | null>(null)
  // 파일 이름 검색 — 트리와 같은 자리에서 평면 결과로 전환. 파일 목록(@멘션과 같은
  // 워커)은 첫 검색에 한 번만 받아오고, cwd/refreshKey가 바뀌면 무효화한다.
  const [query, setQuery] = useState('')
  const [allFiles, setAllFiles] = useState<string[] | null>(null)
  // guards stale async loads: bumped whenever the tree resets to a new cwd
  const genRef = useRef(0)

  // 변경 파일 룩업: 파일 → NEW/EDIT, 그 조상 폴더 → 점 색 (NEW 자식이 하나라도 있으면 green)
  // 메인 작업 폴더 전용 — 참고 폴더에 같은 rel 경로가 있어도 배지가 잘못 붙지 않게
  const chg = useMemo(() => {
    const files = new Map<string, 'new' | 'edit'>()
    const dirs = new Map<string, 'new' | 'edit'>()
    for (const f of (viewing ? [] : changed) ?? []) {
      const t = f.tag === 'new' ? 'new' : 'edit'
      files.set(f.path, t)
      let p = f.path
      while (p.includes('/')) {
        p = p.slice(0, p.lastIndexOf('/'))
        if (dirs.get(p) !== 'new') dirs.set(p, t)
      }
    }
    return { files, dirs }
  }, [changed, viewing])

  const loadDir = (rel: string): void => {
    if (!root) return
    const gen = genRef.current
    window.api
      .listDir(root, rel)
      .then((list) => {
        if (gen !== genRef.current) return // a different folder took over meanwhile
        setEntries((m) => {
          const next = new Map(m)
          next.set(rel, list)
          return next
        })
      })
      .catch(() => {})
  }

  // a new root (작업 폴더 변경 또는 메인↔참고 전환) → a fresh tree. 같은 폴더를
  // 다시 열면(재시작·전환 복귀 포함) 지난번 펼쳐둔 폴더들이 ui-prefs에서 복원된다.
  useEffect(() => {
    genRef.current += 1
    setEntries(new Map())
    setSel(null)
    setQuery('')
    setAllFiles(null)
    const saved = root ? new Set(getPref<string[]>(expandedKey(root), [])) : new Set<string>()
    setExpanded(saved)
    if (root) {
      loadDir('')
      saved.forEach((rel) => loadDir(rel))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root])

  // 지금 보고 있는 폴더(메인 또는 참고)를 위로 알린다 — 채팅의 @ 멘션이 이 폴더 기준으로
  // 파일을 뜨우게 하기 위해. 메인↔참고 전환·작업 폴더 변경 때마다 root가 바뀐다.
  useEffect(() => {
    onViewFolderChange?.(root)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root])

  // turn ended → silently re-read what's on screen (root + expanded folders),
  // and drop the search index so an active/next search sees the new files
  useEffect(() => {
    if (!root || refreshKey === 0) return
    loadDir('')
    expanded.forEach((rel) => loadDir(rel))
    setAllFiles(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  // fetch the flat file list the first time a search needs it (then keep it warm)
  const searching = query.trim().length > 0
  useEffect(() => {
    if (!searching || allFiles !== null || !root) return
    const gen = genRef.current
    window.api
      .listFiles(root)
      .then((files) => {
        if (gen === genRef.current) setAllFiles(files)
      })
      .catch(() => {})
  }, [searching, allFiles, root])

  const hits = useMemo(() => {
    if (!searching || !allFiles) return []
    const q = query.trim().toLowerCase()
    const starts: string[] = []
    const names: string[] = []
    const paths: string[] = []
    for (const f of allFiles) {
      const name = f.slice(f.lastIndexOf('/') + 1).toLowerCase()
      if (name.startsWith(q)) starts.push(f)
      else if (name.includes(q)) names.push(f)
      else if (f.toLowerCase().includes(q)) paths.push(f)
      if (starts.length >= 100) break
    }
    return [...starts, ...names, ...paths].slice(0, 100)
  }, [searching, allFiles, query])

  const toggleDir = (rel: string): void => {
    const next = new Set(expanded)
    if (next.has(rel)) next.delete(rel)
    else {
      next.add(rel)
      loadDir(rel) // (re)read on every expand, so reopening a folder shows fresh contents
    }
    setExpanded(next)
    // 펼침 상태를 폴더별로 기억 — 재시작/채팅 전환/메인↔참고 전환 후에도 그대로
    if (root) setPref(expandedKey(root), Array.from(next).slice(0, 300))
  }

  const openFile = (rel: string): void => {
    setSel(rel)
    // 참고 폴더의 파일은 메인 cwd 밖이라 rel로 열 수 없다 → 절대 경로(포워드 슬래시)로
    onOpenFile(viewing ? viewing.replace(/\\/g, '/') + '/' + rel : rel)
  }

  // 참고 폴더 추가 — 이미 있는 폴더(메인 포함)를 다시 고르면 그 뷰로 전환만 한다
  const addRef = async (): Promise<void> => {
    if (!cwd) return
    const p = await window.api.pickDirectory()
    if (!p) return
    const same = (a: string, b: string): boolean =>
      a.replace(/[\\/]+/g, '/').toLowerCase() === b.replace(/[\\/]+/g, '/').toLowerCase()
    if (same(p, cwd)) {
      setView('')
      return
    }
    const dup = refs.find((r) => same(r, p))
    if (dup) {
      setView(dup)
      return
    }
    const next = [...refs, p]
    setRefs(next)
    setPref(refsKey(cwd), next)
    setView(p)
  }

  const removeRef = (r: string): void => {
    const next = refs.filter((x) => x !== r)
    setRefs(next)
    setPref(refsKey(cwd), next)
    if (view === r) setView('')
  }

  // Ctrl/⌘+F → 탐색기 검색으로 점프 (접혀 있으면 펼친 다음 포커스).
  // 모달이 떠 있을 때는 그쪽 키보드 소유권을 존중해 양보한다.
  const searchRef = useRef<HTMLInputElement>(null)
  const focusOnOpen = useRef(false)
  const asideRef = useRef<HTMLElement>(null) // 스크롤 밖으로 띄우는 툴팁(ScrollTip)의 기준
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'f') return
      if (!cwd) return
      if (
        document.querySelector(
          '.fv-overlay, .set-overlay, .set-dialog-overlay, .q-overlay, .ask-overlay, .iv-overlay, .sa-overlay'
        )
      )
        return
      e.preventDefault()
      if (open) searchRef.current?.select()
      else {
        focusOnOpen.current = true
        onToggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, cwd, onToggle])
  useEffect(() => {
    if (open && focusOnOpen.current) {
      focusOnOpen.current = false
      searchRef.current?.focus()
    }
  }, [open])

  // 접힘: 펼치기 버튼 하나만 남는 좁은 레일
  if (!open) {
    return (
      <div className="explorer-rail">
        <button className="exp-rail-btn has-tip" data-tip="탐색기 열기" aria-label="탐색기 열기" onClick={onToggle}>
          <IconChevRight size={14} />
        </button>
      </div>
    )
  }

  const project = basename(cwd)

  const renderRows = (base: string, depth: number): React.ReactNode => {
    const list = entries.get(base)
    if (!list) {
      return (
        <div className="exp-note" style={{ paddingLeft: indent(depth) + 18 }} key={base + '/…'}>
          읽는 중…
        </div>
      )
    }
    if (list.length === 0) {
      return (
        <div className="exp-note" style={{ paddingLeft: indent(depth) + 18 }} key={base + '/∅'}>
          비어 있음
        </div>
      )
    }
    return list.map((e) => {
      const rel = base ? base + '/' + e.name : e.name
      if (e.dir) {
        const isOpen = expanded.has(rel)
        const dot = chg.dirs.get(rel)
        return (
          <Fragment key={rel}>
            <button className="exp-row" style={{ paddingLeft: indent(depth) }} onClick={() => toggleDir(rel)}>
              <span className={'exp-tw' + (isOpen ? ' open' : '')}>
                <IconChevRight size={11} />
              </span>
              <span className="exp-fic">{isOpen ? <IconFolderOpen size={14} /> : <IconFolder size={14} />}</span>
              <span className="exp-name dir">{e.name}</span>
              {dot && <span className={'exp-dot ' + dot} />}
            </button>
            {isOpen && renderRows(rel, depth + 1)}
          </Fragment>
        )
      }
      const tag = chg.files.get(rel)
      return (
        <button
          key={rel}
          className={'exp-row has-tip' + (sel === rel ? ' sel' : '') + (tag ? ' chg-' + tag : '')}
          data-tip={tag ? rel + (tag === 'new' ? ' · 새 파일 — 클릭하면 diff' : ' · 수정됨 — 클릭하면 diff') : rel}
          style={{ paddingLeft: indent(depth) + 15 }}
          onClick={() => openFile(rel)}
        >
          <span className="exp-fbadge">
            <FileBadge path={e.name} size={15} />
          </span>
          <span className="exp-name">{e.name}</span>
          {tag && <span className={'exp-chg ' + tag}>{tag === 'new' ? 'N' : 'M'}</span>}
        </button>
      )
    })
  }

  return (
    <aside className="explorer" ref={asideRef}>
      <ScrollTip rootRef={asideRef} />
      <div className="exp-head">
        <span className="exp-title">탐색기</span>
        {/* 수동 새로고침은 제거 — 턴이 끝날 때마다 자동 갱신된다. 그 자리에 Git 카드 진입 */}
        <button
          className="exp-act git has-tip"
          data-tip={gitReady ? 'Git — 커밋 히스토리·변경 사항' : 'Git 저장소가 아니에요'}
          aria-label="Git"
          onClick={onOpenGit}
          disabled={!cwd || !gitReady}
        >
          <IconGitBranch size={14} />
        </button>
        <button className="exp-act has-tip" data-tip="탐색기 접기" aria-label="탐색기 접기" onClick={onToggle}>
          <IconChevLeft size={13} />
        </button>
      </div>

      {cwd ? (
        <>
          <div className="exp-folders">
            <button
              className={'exp-frow main has-tip' + (!viewing ? ' active' : '')}
              data-tip={cwd + ' · 메인 작업 폴더' + (viewing ? '' : ' — 클릭하면 변경')}
              onClick={() => (viewing ? setView('') : onPickFolder())}
              aria-label="메인 작업 폴더"
            >
              <IconFolder className="f-ic" size={14} />
              <span className="f-name">{project}</span>
              {refs.length > 0 ? (
                <span className="f-main-chip">메인</span>
              ) : (
                <span className="kbd">{isMac ? '⌘O' : 'Ctrl O'}</span>
              )}
            </button>
            {refs.map((r) => (
              <button
                key={r}
                className={'exp-frow has-tip' + (viewing === r ? ' active' : '')}
                data-tip={r + ' · 참고 폴더 (보기 전용)'}
                onClick={() => setView(r)}
              >
                <IconFolder className="f-ic" size={14} />
                <span className="f-name">{basename(r)}</span>
                <span
                  className="f-x"
                  role="button"
                  aria-label="참고 폴더 닫기"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeRef(r)
                  }}
                >
                  <IconX2 size={10} />
                </span>
              </button>
            ))}
            <button className="exp-fadd" onClick={addRef}>
              <IconPlus size={11} /> 폴더 추가
            </button>
          </div>
          <div className="exp-search">
            <IconSearch size={13} />
            <input
              ref={searchRef}
              placeholder="파일 검색…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) {
                  e.preventDefault()
                  e.stopPropagation()
                  setQuery('')
                }
              }}
            />
            {query ? (
              <button className="exp-search-x" aria-label="검색 지우기" onClick={() => setQuery('')}>
                <IconX2 size={11} />
              </button>
            ) : (
              <span className="kbd">{isMac ? '⌘F' : 'Ctrl F'}</span>
            )}
          </div>
          {searching ? (
            <div className="exp-tree scroll">
              {allFiles === null ? (
                <div className="exp-note">파일 목록 읽는 중…</div>
              ) : hits.length === 0 ? (
                <div className="exp-note">‘{query.trim()}’ 결과가 없어요</div>
              ) : (
                hits.map((f) => {
                  const cut = f.lastIndexOf('/')
                  const name = cut >= 0 ? f.slice(cut + 1) : f
                  const dir = cut >= 0 ? f.slice(0, cut) : ''
                  const tag = chg.files.get(f)
                  return (
                    <button
                      key={f}
                      className={'exp-row has-tip' + (sel === f ? ' sel' : '') + (tag ? ' chg-' + tag : '')}
                      data-tip={f}
                      style={{ paddingLeft: 8 }}
                      onClick={() => openFile(f)}
                    >
                      <span className="exp-fbadge">
                        <FileBadge path={name} size={15} />
                      </span>
                      <span className="exp-name">{name}</span>
                      {dir && <span className="exp-dir">{dir}</span>}
                      {tag && <span className={'exp-chg ' + tag}>{tag === 'new' ? 'N' : 'M'}</span>}
                    </button>
                  )
                })
              )}
            </div>
          ) : (
            <div className="exp-tree scroll">{renderRows('', 0)}</div>
          )}
        </>
      ) : (
        <div className="exp-blank">
          <div className="exp-blank-ic">
            <IconFolder size={18} />
          </div>
          <div className="exp-blank-text">
            폴더를 선택하면
            <br />
            프로젝트 파일이 표시돼요
          </div>
          <button className="exp-blank-btn" onClick={onPickFolder}>
            폴더 선택
          </button>
        </div>
      )}
    </aside>
  )
})

function indent(depth: number): number {
  return 8 + depth * 14
}

function basename(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : p
}

// 트리/폴더 행 툴팁 — CSS ::after 툴팁은 스크롤 컨테이너(.exp-tree, overflow)에서 잘려 안 보인다.
// 그래서 그 두 영역의 [data-tip]은 여기서 body로 포털한 fixed 툴팁으로 띄운다(클리핑 탈출).
// (CSS 쪽은 .exp-tree/.exp-folders 의 ::after 를 끄고, exp-head 등 다른 곳은 그대로 CSS 툴팁 유지.)
function ScrollTip({ rootRef }: { rootRef: { current: HTMLElement | null } }) {
  const [tip, setTip] = useState<{ text: string; rect: DOMRect } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    let timer = 0
    let cur: Element | null = null
    const clear = (): void => {
      window.clearTimeout(timer)
      cur = null
      setTip(null)
    }
    const onOver = (e: MouseEvent): void => {
      const el = (e.target as Element).closest?.('[data-tip]')
      if (!el || !el.closest('.exp-tree, .exp-folders')) return
      if (el === cur) return
      cur = el
      window.clearTimeout(timer)
      setTip(null)
      const text = el.getAttribute('data-tip') || ''
      if (!text) return
      timer = window.setTimeout(() => {
        if (cur === el) setTip({ text, rect: el.getBoundingClientRect() })
      }, 300)
    }
    const onOut = (e: MouseEvent): void => {
      if (!cur) return
      const to = e.relatedTarget as Element | null
      if (to && cur.contains(to)) return
      if (!to || !to.closest?.('[data-tip]')) clear() // 빈 곳/툴팁 없는 곳으로 나가면 닫는다
    }
    root.addEventListener('mouseover', onOver)
    root.addEventListener('mouseout', onOut)
    root.addEventListener('mouseleave', clear)
    root.addEventListener('scroll', clear, true) // 스크롤하면 위치가 어긋나니 닫는다
    return () => {
      window.clearTimeout(timer)
      root.removeEventListener('mouseover', onOver)
      root.removeEventListener('mouseout', onOut)
      root.removeEventListener('mouseleave', clear)
      root.removeEventListener('scroll', clear, true)
    }
  }, [rootRef])
  // 뷰포트 밖이면 좌우 클램프 + 아래로 넘치면 행 위로 뒤집기
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !tip) return
    const r = tip.rect
    el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 8)) + 'px'
    const below = r.bottom + 6
    el.style.top = (below + el.offsetHeight > window.innerHeight - 8 ? Math.max(8, r.top - 6 - el.offsetHeight) : below) + 'px'
  }, [tip])
  if (!tip) return null
  return createPortal(
    <div ref={ref} className="scroll-tip" style={{ left: tip.rect.left, top: tip.rect.bottom + 6 }}>
      {tip.text}
    </div>,
    document.body
  )
}
