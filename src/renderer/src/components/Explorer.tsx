import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { AppUser, ChangedFile, DirEntry } from '@shared/protocol'
import { FileBadge } from './fileType'
import { getPref, setPref } from '../lib/prefs'
import {
  IconChevLeft,
  IconChevRight,
  IconCopy,
  IconDiff,
  IconEyeOff,
  IconFile,
  IconFilter,
  IconFolder,
  IconFolderOpen,
  IconGear,
  IconMascot,
  IconPencil,
  IconRefresh,
  IconRotate,
  IconSearch,
  IconTrash,
  IconVerse,
  IconX2
} from './icons'
import { FileOpModal, type FileOp } from './FileOpModal'
import { NoticeModal } from './NoticeModal'
import {
  getHideDirs,
  getHideEnabled,
  getHideFiles,
  makeNameMatcher,
  onHideChanged,
  setHideDirs,
  setHideEnabled,
  setHideFiles
} from '../lib/hideDirs'

// 폴더 하나가 트리에 그리는 최대 행 수 — 초과분은 "외 N개 항목 생략" 안내 행으로 접는다
const MAX_DIR_ROWS = 500

// 펼쳐둔 폴더 목록의 저장 키 — 작업 폴더별로 따로 기억한다
function expandedKey(cwd: string): string {
  return 'explorer.expanded:' + cwd.replace(/[\\/]+/g, '/').toLowerCase()
}

// "Verse API" 묶음 펼침 여부의 저장 키 — 프로젝트별로 기억(기본 접힘)
function verseOpenKey(cwd: string): string {
  return 'explorer.verseOpen:' + cwd.replace(/[\\/]+/g, '/').toLowerCase()
}

// "Verse 위주로 보기"(에셋·정크 숨김) 토글의 저장 키 — 프로젝트별, Verse 프로젝트는 기본 ON
function verseFilterKey(cwd: string): string {
  return 'explorer.verseFilter:' + cwd.replace(/[\\/]+/g, '/').toLowerCase()
}

// 지금 보고 있는 폴더(메인='' 또는 Verse API digest 경로)의 저장 키 — 프로젝트별로 기억해
// 앱을 껐다 켜거나 같은 채팅을 다시 열어도 보던 폴더(예: /Verse.org)로 복원한다
function viewKey(cwd: string): string {
  return 'explorer.view:' + cwd.replace(/[\\/]+/g, '/').toLowerCase()
}

// 행 들여쓰기 — 깊이는 CSS 변수로 넘겨 .fxr가 패딩·세로 가이드라인을 함께 계산한다 (PoC)
function dstyle(depth: number): CSSProperties {
  return { ['--d' as string]: depth } as CSSProperties
}

/**
 * 파일 탐색기 — 2.0: 왼쪽 칼럼을 채팅 사이드바와 '전환'해 쓰는 패널 (PoC .fx).
 * 채팅 헤더의 패널 버튼(돋보기 옆)이 스위치다. 활성 채팅의 작업 폴더가 곧 트리의
 * 루트라서 폴더를 따로 "여는" 개념이 없다: 채팅을 바꾸면 트리도 따라간다.
 * 참고 폴더(보기 전용 다중 폴더)는 2.0에서 삭제 — 작업 폴더 하나 기준.
 *
 * 디렉터리는 펼칠 때마다 IPC로 그 폴더 하나만 읽는다(lazy). 전체 인덱싱이 없으니
 * node_modules 가 있는 큰 저장소도 즉시 열리고, 펼친 폴더 목록만 메모리에 남는다.
 * `refreshKey`가 바뀌면(에이전트 턴 종료) 루트 + 펼쳐둔 폴더를 다시 읽어
 * 방금 생성/삭제된 파일이 새로고침 없이 나타난다.
 */
export const Explorer = memo(function Explorer({
  cwd,
  refreshKey,
  onPickFolder,
  onOpenFile,
  changed,
  onShowChanged,
  onViewFolderChange,
  user,
  onOpenSettings
}: {
  cwd: string
  refreshKey: number // bump → re-read root + every expanded folder
  onPickFolder: () => void
  onOpenFile: (relPath: string) => void // forward-slash, cwd-relative — digest 파일은 절대 경로
  changed?: ChangedFile[] // 이 세션에서 AI가 만든/수정한 파일 (rel posix) → M/A 배지
  onShowChanged?: (scope: { rel: string; label: string }) => void // 우클릭 '변경된 파일 보기' → 카드
  onViewFolderChange?: (folder: string) => void // 지금 보고 있는 폴더를 알림 → 채팅 @ 멘션의 기준
  user?: AppUser // 하단 프로필 행(설정 진입점)의 아바타·이름 — 사이드바 footer와 동일
  onOpenSettings?: () => void // 하단 프로필 행 → 설정. 탐색기로 전환하면 사이드바 footer가 사라져 설정을 열 길이 없던 구멍을 메운다
}) {
  // Verse 프로젝트면 자동으로 채워지는 보기 전용 API digest 루트(Verse.org/Fortnite.com/…).
  // 영속하지 않고 매번 .vproject에서 다시 발견한다. 트리 맨 아래 접이식 그룹으로 노출.
  const [verseRefs, setVerseRefs] = useState<{ path: string; name: string }[]>([])
  const [verseOpen, setVerseOpen] = useState<boolean>(() => (cwd ? getPref<boolean>(verseOpenKey(cwd), false) : false))
  // "Verse 위주로 보기" — UEFN .code-workspace의 files.exclude 글롭 + 빈 폴더 숨김
  const [excludes, setExcludes] = useState<string[]>([])
  const [verseFilter, setVerseFilter] = useState<boolean>(() => (cwd ? getPref<boolean>(verseFilterKey(cwd), true) : true))
  // 지금 보고 있는 폴더 — 프로젝트별로 영속. '' = 메인, 아니면 Verse digest 절대 경로.
  const [view, setView] = useState<string>(() => (cwd ? getPref<string>(viewKey(cwd), '') : ''))
  // 빌드·생성물 숨김(설정 › Explorer) — 전역 프리셋. 우클릭 '숨김 목록에 추가'가 목록을
  // 바꾸면 hideDirs가 이벤트를 쏴, 여기서 다시 읽어 트리를 갱신한다.
  const [hideEnabled, setHideOn] = useState<boolean>(() => getHideEnabled())
  const [hideList, setHideList] = useState<string[]>(() => getHideDirs())
  const [hideFileList, setHideFileList] = useState<string[]>(() => getHideFiles())
  useEffect(
    () =>
      onHideChanged(() => {
        setHideOn(getHideEnabled())
        setHideList(getHideDirs())
        setHideFileList(getHideFiles())
      }),
    []
  )
  // 숨긴 항목 보기(헤더 눈 버튼, PoC fx-filter) — 켜면 숨김 필터를 풀고 해당 항목을
  // 흐리게(.hid) 보여준다. 전역 프리셋과 별개인 "잠깐 들춰보기" 토글.
  const [showHidden, setShowHidden] = useState<boolean>(() => getPref<boolean>('explorer.showHidden', false))
  const toggleShowHidden = (): void => {
    setShowHidden((s) => {
      setPref('explorer.showHidden', !s)
      return !s
    })
  }

  const [prevCwd, setPrevCwd] = useState(cwd)
  if (prevCwd !== cwd) {
    setPrevCwd(cwd)
    setVerseRefs([])
    setExcludes([])
    setVerseOpen(cwd ? getPref<boolean>(verseOpenKey(cwd), false) : false)
    setVerseFilter(cwd ? getPref<boolean>(verseFilterKey(cwd), true) : true)
    setView(cwd ? getPref<string>(viewKey(cwd), '') : '')
  }
  // "Verse 위주로 보기" — UEFN 글롭(파일+폴더) + 빈 폴더 숨김
  const verseFiltering = verseFilter && excludes.length > 0
  // 숨김 필터는 '숨긴 항목 보기'가 꺼져 있을 때만 listDir에 넘긴다 — 켜져 있으면
  // 전부 받아서 렌더에서 흐리게 표시한다 (Verse 글롭은 성격이 달라 그대로 적용)
  const hiding = hideEnabled && !showHidden
  const generalDirs = useMemo(() => (hiding ? hideList : []), [hiding, hideList])
  const generalFiles = useMemo(() => (hiding ? hideFileList : []), [hiding, hideFileList])
  const verseExcl = useMemo(() => (verseFiltering ? excludes : []), [verseFiltering, excludes])
  const hideEmpty = verseFiltering // 빈 폴더 프루닝은 Verse에만
  // 흐림(.hid) 판정용 매처 — 숨긴 항목 보기가 켜져 있을 때만 쓴다
  const dimDirSet = useMemo(
    () => new Set((hideEnabled ? hideList : []).map((d) => d.toLowerCase())),
    [hideEnabled, hideList]
  )
  const dimFileMatch = useMemo(() => makeNameMatcher(hideEnabled ? hideFileList : []), [hideEnabled, hideFileList])
  // 검색 결과에서 숨긴 폴더 밑의 파일도 빼기 위한 이름 집합(소문자)
  const hideSet = useMemo(() => new Set(generalDirs.map((d) => d.toLowerCase())), [generalDirs])
  const hideFileMatch = useMemo(() => makeNameMatcher(generalFiles), [generalFiles])
  const viewing = view && verseRefs.some((v) => v.path === view) ? view : '' // '' = 메인 폴더 보기
  const root = viewing || cwd // 지금 트리가 보여주는 폴더

  // rel path('' = root) → that folder's entries; only loaded (visited) folders exist here
  const [entries, setEntries] = useState<Map<string, DirEntry[]>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // 우클릭 컨텍스트 메뉴 + 파일 작업 카드(이름 변경·새 파일/폴더·삭제). root=true면 빈 영역
  // 우클릭(프로젝트 루트에 만들기)이다.
  const [ctx, setCtx] = useState<{
    x: number
    y: number
    rel: string
    name: string
    dir: boolean
    root?: boolean
  } | null>(null)
  const [fileOp, setFileOp] = useState<FileOp | null>(null)
  const ctxRef = useRef<HTMLDivElement>(null)
  // 드래그 앤 드롭 이동 — dragRel: 끌고 있는 항목, dropRel: 들어갈 대상 폴더('' = 루트)
  const [dragRel, setDragRel] = useState<string | null>(null)
  const [dropRel, setDropRel] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ title: string; message: string } | null>(null) // 알림 카드
  const asideRef = useRef<HTMLElement>(null)

  // 보고 있는 폴더가 바뀔 때마다 프로젝트별로 저장
  useEffect(() => {
    if (cwd) setPref(viewKey(cwd), view)
  }, [cwd, view])

  // Verse 프로젝트면 .vproject의 패키지(digest)를 발견해 보기 전용 루트로 자동 노출.
  // refreshKey도 의존 → 에이전트 턴이 .vproject를 처음 생성하면 그때 자동으로 나타난다.
  useEffect(() => {
    if (!cwd) {
      setVerseRefs([])
      setExcludes([])
      return
    }
    let alive = true
    Promise.all([window.api.lsp.verseDigests(cwd), window.api.lsp.verseExcludes(cwd)])
      .then(([digs, ex]) => {
        if (!alive) return
        setVerseRefs(digs || [])
        setExcludes(ex || [])
      })
      .catch(() => {
        if (!alive) return
        setVerseRefs([])
        setExcludes([])
      })
    return () => {
      alive = false
    }
  }, [cwd, refreshKey])

  // 필터가 바뀌면 화면에 떠 있는 것(root + 펼친 폴더)을 조용히 다시 읽는다 — 펼침/선택은
  // 그대로 두고 내용만 필터 반영. 검색 인덱스도 무효화.
  const filterSig =
    verseExcl.join('|') + '##' + generalDirs.join('|') + '##' + generalFiles.join('|') + '#' + (hideEmpty ? 1 : 0)
  useEffect(() => {
    if (!root) return
    loadDir('')
    expanded.forEach((rel) => loadDir(rel))
    setAllFiles(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterSig])
  const [sel, setSel] = useState<string | null>(null)
  // 파일 이름 검색 — 트리와 같은 자리에서 평면 결과로 전환. 파일 목록(@멘션과 같은
  // 워커)은 첫 검색에 한 번만 받아오고, cwd/refreshKey가 바뀌면 무효화한다.
  const [query, setQuery] = useState('')
  const [allFiles, setAllFiles] = useState<string[] | null>(null)
  // guards stale async loads: bumped whenever the tree resets to a new cwd
  const genRef = useRef(0)

  // 변경 파일 룩업: 파일 → NEW/EDIT, 그 조상 폴더 → 점 색 (NEW 자식이 하나라도 있으면 green)
  // 메인 작업 폴더 전용 — digest 뷰에 같은 rel 경로가 있어도 배지가 잘못 붙지 않게
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

  // 우클릭한 폴더 아래 변경 파일 수 — 메뉴 항목의 개수 알약, 0이면 비활성 (PoC fxm-chg)
  const countChg = (rel: string): number => {
    if (!rel) return chg.files.size
    let n = 0
    const pre = rel + '/'
    chg.files.forEach((_t, p) => {
      if (p.startsWith(pre)) n++
    })
    return n
  }

  const loadDir = (rel: string): void => {
    if (!root) return
    const gen = genRef.current
    window.api
      .listDir(
        root,
        rel,
        verseExcl.length ? verseExcl : undefined,
        hideEmpty,
        generalDirs.length ? generalDirs : undefined,
        generalFiles.length ? generalFiles : undefined
      )
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

  // a new root (작업 폴더 변경 또는 메인↔digest 전환) → a fresh tree. 같은 폴더를
  // 다시 열면(재시작·전환 복귀 포함) 지난번 펼쳐둔 폴더들이 ui-prefs에서 복원된다.
  useEffect(() => {
    genRef.current += 1
    setEntries(new Map())
    setSel(null)
    setQuery('')
    setAllFiles(null)
    setCtx(null)
    setFileOp(null)
    setDragRel(null)
    setDropRel(null)
    const saved = root ? new Set(getPref<string[]>(expandedKey(root), [])) : new Set<string>()
    setExpanded(saved)
    if (root) {
      loadDir('')
      saved.forEach((rel) => loadDir(rel))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root])

  // 지금 보고 있는 폴더를 위로 알린다 — 채팅의 @ 멘션이 이 폴더 기준으로 파일을 뜨우게
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
      // 트리에서 숨긴 폴더 밑의 파일은 검색에서도 뺀다 (숨긴 항목 보기가 켜지면 hideSet이
      // 비어 있어 전부 통과하고, 렌더에서 흐리게만 표시된다)
      if (hideSet.size) {
        const cut = f.lastIndexOf('/')
        if (cut >= 0 && f.slice(0, cut).toLowerCase().split('/').some((s) => hideSet.has(s))) continue
      }
      const name = f.slice(f.lastIndexOf('/') + 1).toLowerCase()
      if (hideFileMatch && hideFileMatch(name)) continue
      if (name.startsWith(q)) starts.push(f)
      else if (name.includes(q)) names.push(f)
      else if (f.toLowerCase().includes(q)) paths.push(f)
      if (starts.length >= 100) break
    }
    return [...starts, ...names, ...paths].slice(0, 100)
  }, [searching, allFiles, query, hideSet, hideFileMatch])

  const toggleDir = (rel: string): void => {
    const next = new Set(expanded)
    if (next.has(rel)) next.delete(rel)
    else {
      next.add(rel)
      loadDir(rel) // (re)read on every expand, so reopening a folder shows fresh contents
    }
    setExpanded(next)
    if (root) setPref(expandedKey(root), Array.from(next).slice(0, 300))
  }

  const openFile = (rel: string): void => {
    setSel(rel)
    // digest 파일은 메인 cwd 밖이라 rel로 열 수 없다 → 절대 경로(포워드 슬래시)로
    onOpenFile(viewing ? viewing.replace(/\\/g, '/') + '/' + rel : rel)
  }

  // "Verse API" 묶음 접기/펴기 — 상태를 프로젝트별로 영속
  const toggleVerse = (): void => {
    const next = !verseOpen
    setVerseOpen(next)
    if (cwd) setPref(verseOpenKey(cwd), next)
  }

  // "Verse 위주로 보기" 켜기/끄기 — 트리는 filterSig 변화로 자동 재로드
  const toggleFilter = (): void => {
    const next = !verseFilter
    setVerseFilter(next)
    if (cwd) setPref(verseFilterKey(cwd), next)
  }

  // 수동 새로고침(빈 영역 우클릭 메뉴) — 지금 보는 폴더(루트 + 펼쳐둔 하위)를 다시 읽는다
  const refresh = (): void => {
    if (!root) return
    loadDir('')
    expanded.forEach((rel) => loadDir(rel))
    setAllFiles(null)
  }

  // ── 우클릭 컨텍스트 메뉴 + 파일 작업 카드 ────────────────────────────────
  const openCtx = (ev: React.MouseEvent, rel: string, name: string, dir: boolean): void => {
    ev.preventDefault()
    ev.stopPropagation()
    setCtx({ x: ev.clientX, y: ev.clientY, rel, name, dir })
  }
  // 트리 빈 영역 우클릭 → 프로젝트 루트에 새 파일/폴더 (행은 stopPropagation이라 여기 안 옴)
  const openCtxRoot = (ev: React.MouseEvent): void => {
    if (!root) return
    ev.preventDefault()
    setCtx({ x: ev.clientX, y: ev.clientY, rel: '', name: rootLabel, dir: true, root: true })
  }
  const doReveal = (): void => {
    if (!ctx) return
    void window.api.revealPath(root, ctx.rel)
    setCtx(null)
  }
  // 절대경로를 클립보드로 — 뷰어 헤더 우클릭 '경로 복사'와 같은 백슬래시 표기
  const doCopyPath = (): void => {
    if (!ctx) return
    const abs = ctx.rel ? root.replace(/[\\/]+$/, '') + '\\' + ctx.rel : root
    void navigator.clipboard.writeText(abs.replace(/\//g, '\\'))
    setCtx(null)
  }
  // 우클릭 '숨김 목록에 추가' — 폴더는 폴더 목록에, 파일은 파일 목록에 이름으로 넣는다.
  const addHide = (pattern: string, dir: boolean): void => {
    setCtx(null)
    const list = dir ? getHideDirs() : getHideFiles()
    if (!list.some((x) => x.toLowerCase() === pattern.toLowerCase())) {
      ;(dir ? setHideDirs : setHideFiles)([...list, pattern])
    }
    if (!getHideEnabled()) setHideEnabled(true)
  }
  const startCreate = (kind: 'newFile' | 'newFolder'): void => {
    if (!ctx) return
    let parentRel: string
    let parentLabel: string
    if (ctx.root || ctx.dir) {
      parentRel = ctx.rel
      parentLabel = ctx.root ? rootLabel : ctx.name
    } else {
      parentRel = ctx.rel.includes('/') ? ctx.rel.slice(0, ctx.rel.lastIndexOf('/')) : ''
      parentLabel = parentRel ? parentRel.slice(parentRel.lastIndexOf('/') + 1) : rootLabel
    }
    setCtx(null)
    setFileOp({ kind, parentRel, parentLabel })
  }
  // 카드의 확정 — 종류별로 실제 동작 후 트리/검색 갱신. {ok,error}를 그대로 카드에 돌려준다.
  const runFileOp = async (op: FileOp, value: string): Promise<{ ok: boolean; error?: string }> => {
    const reloadParentOf = (rel: string): void => {
      loadDir(rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')
      setAllFiles(null)
    }
    if (op.kind === 'rename') {
      const r = await window.api.renamePath(root, op.rel, value)
      if (r.ok) {
        reloadParentOf(op.rel)
        if (sel === op.rel) setSel(null)
      }
      return r
    }
    if (op.kind === 'delete') {
      const r = await window.api.deletePath(root, op.rel)
      if (r.ok) {
        reloadParentOf(op.rel)
        if (sel === op.rel) setSel(null)
      }
      return r
    }
    // newFile / newFolder
    if (/[\\/]/.test(value) || value === '.' || value === '..') return { ok: false, error: '이름에 / 나 \\ 는 쓸 수 없어요' }
    const childRel = op.parentRel ? op.parentRel + '/' + value : value
    const r = await window.api.createPath(root, childRel, op.kind === 'newFolder')
    if (r.ok) {
      if (op.parentRel) {
        setExpanded((prev) => {
          const n = new Set(prev)
          n.add(op.parentRel)
          if (root) setPref(expandedKey(root), Array.from(n).slice(0, 300))
          return n
        })
      }
      loadDir(op.parentRel)
      setAllFiles(null)
    }
    return r
  }

  // ── 드래그 앤 드롭 이동 ──────────────────────────────────────────────────
  const canDropInto = (src: string, destFolderRel: string): boolean => {
    if (!src || src === destFolderRel) return false
    if (destFolderRel && destFolderRel.startsWith(src + '/')) return false // 자기 하위로 못 감
    const parent = src.includes('/') ? src.slice(0, src.lastIndexOf('/')) : ''
    if (parent === destFolderRel) return false // 이미 그 폴더 안에 있음
    return true
  }
  const onDragStartRow = (e: React.DragEvent, rel: string): void => {
    e.stopPropagation()
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', rel)
    setDragRel(rel)
  }
  const onDragEndRow = (): void => {
    setDragRel(null)
    setDropRel(null)
  }
  const onDragOverFolder = (e: React.DragEvent, folderRel: string): void => {
    e.stopPropagation()
    if (!dragRel || !canDropInto(dragRel, folderRel)) {
      setDropRel(null)
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropRel(folderRel)
  }
  const onDropFolder = (e: React.DragEvent, folderRel: string): void => {
    e.preventDefault()
    e.stopPropagation()
    const src = dragRel
    setDropRel(null)
    setDragRel(null)
    if (src) doMove(src, folderRel)
  }
  // 파일 위로 드래그: 드롭 대상이 아님(루트 하이라이트도 끔)
  const onDragOverFile = (e: React.DragEvent): void => {
    e.stopPropagation()
    setDropRel(null)
  }
  const onDragOverRoot = (e: React.DragEvent): void => {
    if (!dragRel || !canDropInto(dragRel, '')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropRel('')
  }
  const onDropRoot = (e: React.DragEvent): void => {
    e.preventDefault()
    const src = dragRel
    setDropRel(null)
    setDragRel(null)
    if (src) doMove(src, '')
  }
  const doMove = (src: string, destFolderRel: string): void => {
    if (!canDropInto(src, destFolderRel)) return
    const name = src.slice(src.lastIndexOf('/') + 1)
    const destRel = destFolderRel ? destFolderRel + '/' + name : name
    void window.api.movePath(root, src, destRel).then((r) => {
      if (!r.ok) {
        setNotice({ title: '옮길 수 없어요', message: r.error || '옮길 수 없어요' })
        return
      }
      loadDir(src.includes('/') ? src.slice(0, src.lastIndexOf('/')) : '') // 옛 부모
      loadDir(destFolderRel) // 새 부모
      setAllFiles(null)
      if (destFolderRel) {
        setExpanded((prev) => {
          const n = new Set(prev)
          n.add(destFolderRel)
          if (root) setPref(expandedKey(root), Array.from(n).slice(0, 300))
          return n
        })
      }
      if (sel === src) setSel(null)
    })
  }

  // 컨텍스트 메뉴가 화면 아래/오른쪽을 넘치면 실측 크기로 되민다
  useLayoutEffect(() => {
    const el = ctxRef.current
    if (!el || !ctx) return
    el.style.left = Math.max(8, Math.min(ctx.x, window.innerWidth - el.offsetWidth - 8)) + 'px'
    el.style.top = Math.max(8, Math.min(ctx.y, window.innerHeight - el.offsetHeight - 8)) + 'px'
  }, [ctx])

  // 컨텍스트 메뉴 닫기 — 바깥 클릭 / Esc / 스크롤 / 리사이즈 (메뉴 내부 클릭은 ref로 보호)
  useEffect(() => {
    if (!ctx) return
    const close = (): void => setCtx(null)
    const onDown = (e: MouseEvent): void => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    const aside = asideRef.current
    window.addEventListener('mousedown', onDown)
    window.addEventListener('resize', close)
    document.addEventListener('keydown', onKey)
    aside?.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', close)
      document.removeEventListener('keydown', onKey)
      aside?.removeEventListener('scroll', close, true)
    }
  }, [ctx])

  const project = basename(cwd)
  // 지금 보고 있는 뷰의 표시 이름 — 메인은 프로젝트명, Verse digest는 그 패키지명(예: /Verse.org)
  const rootLabel = viewing ? verseRefs.find((v) => v.path === viewing)?.name ?? basename(viewing) : project
  const ctxChg = ctx && onShowChanged && (ctx.dir || ctx.root) ? countChg(ctx.rel) : 0

  const renderRows = (base: string, depth: number): React.ReactNode => {
    const list = entries.get(base)
    if (!list) {
      return (
        <div className="fx-empty" style={dstyle(depth)} key={base + '/…'}>
          읽는 중…
        </div>
      )
    }
    if (list.length === 0) {
      return (
        <div className="fx-empty" style={dstyle(depth)} key={base + '/∅'}>
          비어 있음
        </div>
      )
    }
    // 생성물 폴더 등 수만 개 항목을 한 번에 DOM으로 만들면 렌더러가 멈춘다 — 상한 후 생략 행
    const shown = list.length > MAX_DIR_ROWS ? list.slice(0, MAX_DIR_ROWS) : list
    const rows = shown.map((e) => {
      const rel = base ? base + '/' + e.name : e.name
      // 숨긴 항목 보기 중이면 숨김 목록 매치 항목을 흐리게 (PoC .hid)
      const hid = showHidden && (e.dir ? dimDirSet.has(e.name.toLowerCase()) : !!dimFileMatch && dimFileMatch(e.name.toLowerCase()))
      if (e.dir) {
        const isOpen = expanded.has(rel)
        const dot = chg.dirs.get(rel)
        return (
          <Fragment key={rel}>
            <button
              className={
                'fxr' +
                (isOpen ? ' open' : '') +
                (hid ? ' hid' : '') +
                (dragRel === rel ? ' dragging' : '') +
                (dropRel === rel ? ' drop-into' : '')
              }
              style={dstyle(depth)}
              onClick={() => toggleDir(rel)}
              onContextMenu={(ev) => openCtx(ev, rel, e.name, true)}
              draggable
              onDragStart={(ev) => onDragStartRow(ev, rel)}
              onDragEnd={onDragEndRow}
              onDragOver={(ev) => onDragOverFolder(ev, rel)}
              onDrop={(ev) => onDropFolder(ev, rel)}
            >
              <span className="tw">
                <IconChevRight size={9} />
              </span>
              <span className="fic">{isOpen ? <IconFolderOpen size={14} /> : <IconFolder size={14} />}</span>
              <span className="n dir">{e.name}</span>
              {dot && <span className={'fx-dot ' + dot} />}
            </button>
            {isOpen && renderRows(rel, depth + 1)}
          </Fragment>
        )
      }
      const tag = chg.files.get(rel)
      return (
        <button
          key={rel}
          className={'fxr' + (sel === rel ? ' on' : '') + (hid ? ' hid' : '') + (dragRel === rel ? ' dragging' : '')}
          style={dstyle(depth)}
          onClick={() => openFile(rel)}
          onContextMenu={(ev) => openCtx(ev, rel, e.name, false)}
          draggable
          onDragStart={(ev) => onDragStartRow(ev, rel)}
          onDragEnd={onDragEndRow}
          onDragOver={onDragOverFile}
        >
          <span className="tw" />
          <span className="fic">
            <FileBadge path={e.name} size={14} />
          </span>
          <span className="n">{e.name}</span>
          {tag && <span className={'gs ' + (tag === 'new' ? 'a' : 'm')}>{tag === 'new' ? 'A' : 'M'}</span>}
        </button>
      )
    })
    if (list.length > shown.length) {
      rows.push(
        <div className="fx-empty" style={dstyle(depth)} key={base + '/…'}>
          외 {list.length - shown.length}개 항목 생략
        </div>
      )
    }
    return rows
  }

  return (
    <aside className="explorer" ref={asideRef}>
      {ctx &&
        createPortal(
          <div ref={ctxRef} className="ctx-menu" style={{ left: ctx.x, top: ctx.y }}>
            {/* 이 폴더(또는 프로젝트 전체) 아래 변경 파일 카드 — PoC처럼 맨 위, 개수 알약, 0이면 비활성 */}
            {onShowChanged && (ctx.dir || ctx.root) && (
              <>
                <button
                  className="ctx-item"
                  disabled={ctxChg === 0}
                  onClick={() => {
                    onShowChanged({ rel: ctx.rel, label: ctx.root ? rootLabel : ctx.name })
                    setCtx(null)
                  }}
                >
                  <IconDiff size={15} /> 변경된 파일 보기
                  <span className="cnt">{ctxChg}</span>
                </button>
                <div className="ctx-sep" />
              </>
            )}
            {/* 새 파일/폴더는 폴더 또는 빈 영역(루트)에서만 */}
            {(ctx.dir || ctx.root) && (
              <>
                <button className="ctx-item" onClick={() => startCreate('newFile')}>
                  <IconFile size={15} /> 새 파일
                </button>
                <button className="ctx-item" onClick={() => startCreate('newFolder')}>
                  <IconFolder size={15} /> 새 폴더
                </button>
                <div className="ctx-sep" />
              </>
            )}
            {!ctx.root && (
              <button
                className="ctx-item"
                onClick={() => {
                  setFileOp({ kind: 'rename', rel: ctx.rel, name: ctx.name, dir: ctx.dir })
                  setCtx(null)
                }}
              >
                <IconPencil size={15} /> 이름 변경
              </button>
            )}
            <button className="ctx-item" onClick={doCopyPath}>
              <IconCopy size={15} /> 경로 복사
            </button>
            <button className="ctx-item" onClick={doReveal}>
              <IconFolderOpen size={15} /> 파일 탐색기에서 보기
            </button>
            {ctx.root && (
              <button
                className="ctx-item"
                onClick={() => {
                  refresh()
                  setCtx(null)
                }}
              >
                <IconRefresh size={15} /> 새로고침
              </button>
            )}
            {!ctx.root && (
              <>
                <div className="ctx-sep" />
                <button className="ctx-item" onClick={() => addHide(ctx.name, ctx.dir)}>
                  <IconEyeOff size={15} /> ‘{shortName(ctx.name)}’ 숨김 목록에 추가
                </button>
                <div className="ctx-sep" />
                <button
                  className="ctx-item danger"
                  onClick={() => {
                    setFileOp({ kind: 'delete', rel: ctx.rel, name: ctx.name, dir: ctx.dir })
                    setCtx(null)
                  }}
                >
                  <IconTrash size={15} /> 삭제
                </button>
              </>
            )}
          </div>,
          document.body
        )}
      {/* 파일 작업·알림 카드 — 우클릭 메뉴와 같은 이유로 body 포털: 패널 안 인라인 fixed는
          조상 스태킹 컨텍스트에 갇혀 채팅 반투명 배경 밑에 깔릴 수 있다 */}
      {fileOp &&
        createPortal(
          <FileOpModal op={fileOp} onSubmit={(v) => runFileOp(fileOp, v)} onClose={() => setFileOp(null)} />,
          document.body
        )}
      {notice &&
        createPortal(
          <NoticeModal title={notice.title} message={notice.message} onClose={() => setNotice(null)} />,
          document.body
        )}

      {/* 헤더 — 마스코트 + 앱 이름 고정 (채팅 사이드바 브랜드 줄과 동일, 창 드래그 영역).
          지금 폴더는 채팅 헤더의 폴더 칩이 이미 말해준다 */}
      <div className="fxh">
        <span className="mark">
          <IconMascot size={23} />
        </span>
        <span className="t">AgentCodeGUI</span>
        <span className="sp" />
        {/* 새로고침 — 우클릭 메뉴의 '새로고침'과 동일(루트+펼친 폴더 재읽기), 헤더 상시 노출 */}
        <button className="has-tip" data-tip="새로고침" aria-label="새로고침" onClick={refresh} disabled={!cwd}>
          <IconRotate size={13} />
        </button>
        <button
          className={'has-tip' + (showHidden ? ' on' : '')}
          data-tip={showHidden ? '숨긴 항목 보는 중 — 클릭하면 다시 숨김' : '숨긴 항목 보기'}
          aria-label="숨긴 항목 보기"
          aria-pressed={showHidden}
          onClick={toggleShowHidden}
          disabled={!cwd}
        >
          <IconEyeOff size={13} />
        </button>
      </div>

      {cwd ? (
        <>
          <div className="fxs">
            <IconSearch size={11} />
            <input
              placeholder="파일 검색"
              spellCheck={false}
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
              <button className="sx" aria-label="검색 지우기" onClick={() => setQuery('')}>
                <IconX2 size={11} />
              </button>
            )}
          </div>
          {searching ? (
            <div className="fxtree scroll">
              {allFiles === null ? (
                <div className="fx-empty">파일 목록 읽는 중…</div>
              ) : hits.length === 0 ? (
                <div className="fx-empty">‘{query.trim()}’에 맞는 파일이 없어요</div>
              ) : (
                hits.map((f) => {
                  const cut = f.lastIndexOf('/')
                  const name = cut >= 0 ? f.slice(cut + 1) : f
                  const dir = cut >= 0 ? f.slice(0, cut) : ''
                  const tag = chg.files.get(f)
                  return (
                    <button key={f} className={'fxr' + (sel === f ? ' on' : '')} onClick={() => openFile(f)}>
                      <span className="tw" />
                      <span className="fic">
                        <FileBadge path={name} size={14} />
                      </span>
                      <span className="n">{name}</span>
                      {dir && <span className="pth">{dir}</span>}
                      {tag && <span className={'gs ' + (tag === 'new' ? 'a' : 'm')}>{tag === 'new' ? 'A' : 'M'}</span>}
                    </button>
                  )
                })
              )}
            </div>
          ) : (
            <div
              className={'fxtree scroll' + (dropRel === '' && dragRel ? ' drop-root' : '')}
              onContextMenu={openCtxRoot}
              onDragOver={onDragOverRoot}
              onDrop={onDropRoot}
            >
              {/* digest 뷰 — 맨 위 '돌아가기' 행으로 메인 폴더 복귀 */}
              {viewing && (
                <button className="fxr" onClick={() => setView('')}>
                  <span className="tw">
                    <IconChevLeft size={9} />
                  </span>
                  <span className="fic">
                    <IconFolder size={14} />
                  </span>
                  <span className="n dir">{project}</span>
                </button>
              )}
              {renderRows('', 0)}
              {/* Verse API 묶음 — 자동 발견한 보기 전용 digest 패키지들 (트리 맨 아래 접이식) */}
              {!viewing && verseRefs.length > 0 && (
                <>
                  <button
                    className={'fxr fx-verse' + (verseOpen ? ' open' : '')}
                    aria-expanded={verseOpen}
                    onClick={toggleVerse}
                  >
                    <span className="tw">
                      <IconChevRight size={9} />
                    </span>
                    <span className="fic verse">
                      <IconVerse size={14} />
                    </span>
                    <span className="n dir">Verse API</span>
                    {excludes.length > 0 && (
                      <span
                        className={'v-filter has-tip' + (verseFilter ? ' on' : '')}
                        role="button"
                        aria-label="Verse 위주로 보기"
                        aria-pressed={verseFilter}
                        data-tip={verseFilter ? 'Verse 위주로 보기 — 켜짐' : '모든 파일 보임'}
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleFilter()
                        }}
                      >
                        <IconFilter size={11} />
                      </span>
                    )}
                    <span className="cntp">{verseRefs.length}</span>
                  </button>
                  {verseOpen &&
                    verseRefs.map((v) => (
                      <button key={'verse:' + v.path} className="fxr" style={dstyle(1)} onClick={() => setView(v.path)}>
                        <span className="tw" />
                        <span className="fic verse">
                          <IconVerse size={13} />
                        </span>
                        <span className="n">{v.name}</span>
                      </button>
                    ))}
                </>
              )}
            </div>
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

      {/* 하단 설정 진입점 — 사이드바 footer(.sb-foot)와 동일한 프로필 행(아바타+이름+톱니).
          탐색기로 전환하면 사이드바가 통째로 사라져 설정을 열 길이 없던 구멍을 메운다.
          트리(flex:1) 아래 flex:0 항목이라 폴더 유무와 무관하게 항상 패널 맨 아래 붙는다 */}
      {user && onOpenSettings && (
        <button className="sb-foot has-tip" data-tip="설정 열기" aria-label="설정 열기" onClick={onOpenSettings}>
          <div className="ava" style={{ background: user.avatarColor, color: '#fff' }}>
            {user.avatarText}
          </div>
          <div className="who">
            <div className="n">{user.name}</div>
          </div>
          <IconGear size={13} />
        </button>
      )}
    </aside>
  )
})

function basename(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : p
}

// 컨텍스트 메뉴 라벨용 — 긴 파일 이름이 메뉴 폭을 폭주시키지 않게 줄인다
function shortName(name: string): string {
  return name.length > 24 ? name.slice(0, 22) + '…' : name
}
