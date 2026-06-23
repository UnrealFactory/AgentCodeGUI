import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangedFile, DirEntry } from '@shared/protocol'
import { FileBadge } from './fileType'
import { IconChevRight, IconFolder, IconFolderOpen, IconSearch, IconX2 } from './icons'

/**
 * 파일 트리 코어 — 단일 모드 Explorer의 트리(lazy listDir·펼침·검색·변경 배지)만
 * 떼어낸 재사용 컴포넌트. 폴더 목록/참고 폴더/접기 같은 Explorer 전용 껍데기는 없고,
 * `root` 하나를 루트로 그 폴더만 보여준다. 멀티 모드의 패널 폴더 팝오버가 쓴다.
 *
 * 스타일은 Explorer와 같은 `.exp-*` 클래스를 그대로 재사용한다(별도 CSS 없음).
 * 스크롤 영역 안 툴팁은 ScrollTip 대신 native `title`로 — 팝오버는 작아서 충분하다.
 */
export function FileTree({
  root,
  changed,
  refreshKey = 0,
  autoFocus = false,
  onOpenFile
}: {
  root: string // 트리의 루트 (절대 경로) — 보통 패널의 작업 폴더
  changed?: ChangedFile[] // 이 패널에서 AI가 만든/수정한 파일 (rel posix) → 색·배지
  refreshKey?: number // 값이 바뀌면 루트 + 펼쳐둔 폴더를 다시 읽는다
  autoFocus?: boolean // 마운트 시 검색창에 포커스
  onOpenFile: (rel: string) => void // 클릭한 파일의 cwd-상대(posix) 경로
}) {
  // rel('' = root) → 그 폴더의 엔트리. 방문(펼친)한 폴더만 들어 있다
  const [entries, setEntries] = useState<Map<string, DirEntry[]>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [sel, setSel] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [allFiles, setAllFiles] = useState<string[] | null>(null)
  const genRef = useRef(0) // root가 바뀌면 올려 stale async 로드를 버린다
  const searchRef = useRef<HTMLInputElement>(null)

  // 변경 파일 룩업: 파일 → NEW/EDIT, 그 조상 폴더 → 점 색
  const chg = useMemo(() => {
    const files = new Map<string, 'new' | 'edit'>()
    const dirs = new Map<string, 'new' | 'edit'>()
    for (const f of changed ?? []) {
      const t = f.tag === 'new' ? 'new' : 'edit'
      files.set(f.path, t)
      let p = f.path
      while (p.includes('/')) {
        p = p.slice(0, p.lastIndexOf('/'))
        if (dirs.get(p) !== 'new') dirs.set(p, t)
      }
    }
    return { files, dirs }
  }, [changed])

  const loadDir = (rel: string): void => {
    if (!root) return
    const gen = genRef.current
    window.api
      .listDir(root, rel)
      .then((list) => {
        if (gen !== genRef.current) return
        setEntries((m) => {
          const next = new Map(m)
          next.set(rel, list)
          return next
        })
      })
      .catch(() => {})
  }

  // 새 root → 새 트리
  useEffect(() => {
    genRef.current += 1
    setEntries(new Map())
    setExpanded(new Set())
    setSel(null)
    setQuery('')
    setAllFiles(null)
    if (root) loadDir('')
    if (autoFocus) requestAnimationFrame(() => searchRef.current?.focus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root])

  // refreshKey 변동 → 보고 있는 것(루트 + 펼친 폴더) 다시 읽기 + 검색 인덱스 무효화
  useEffect(() => {
    if (!root || refreshKey === 0) return
    loadDir('')
    expanded.forEach((rel) => loadDir(rel))
    setAllFiles(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  // 검색이 처음 필요할 때 평면 파일 목록을 한 번 받아온다(이후 따뜻하게 유지)
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
      loadDir(rel)
    }
    setExpanded(next)
  }

  const openFile = (rel: string): void => {
    setSel(rel)
    onOpenFile(rel)
  }

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
            <button className="exp-row" style={{ paddingLeft: indent(depth) }} onClick={() => toggleDir(rel)} title={rel}>
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
          className={'exp-row' + (sel === rel ? ' sel' : '') + (tag ? ' chg-' + tag : '')}
          title={tag ? rel + (tag === 'new' ? ' · 새 파일' : ' · 수정됨') : rel}
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
    <>
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
        {query && (
          <button className="exp-search-x" aria-label="검색 지우기" onClick={() => setQuery('')}>
            <IconX2 size={11} />
          </button>
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
                  className={'exp-row' + (sel === f ? ' sel' : '') + (tag ? ' chg-' + tag : '')}
                  title={f}
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
  )
}

function indent(depth: number): number {
  return 8 + depth * 14
}
