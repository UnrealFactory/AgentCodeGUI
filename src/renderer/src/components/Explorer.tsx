import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChangedFile, DirEntry } from '@shared/protocol'
import { FileBadge } from './fileType'
import { getPref, setPref } from '../lib/prefs'
import { IconChevLeft, IconChevRight, IconCopy, IconEyeOff, IconFile, IconFilter, IconFolder, IconFolderOpen, IconGitBranch, IconList, IconPencil, IconPlus, IconRefresh, IconSearch, IconTrash, IconVerse, IconX2 } from './icons'
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

const isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac')

// 폴더 하나가 트리에 그리는 최대 행 수 — 초과분은 "외 N개 항목 생략" 안내 행으로 접는다
const MAX_DIR_ROWS = 500

// 탐색기 칼럼 너비(가로 드래그로 조절) — 하한/상한과 기본값. 전역으로 기억한다.
const EXP_MIN_W = 190
const EXP_MAX_W = 620
const EXP_DEFAULT_W = 236

// 펼쳐둔 폴더 목록의 저장 키 — 작업 폴더별로 따로 기억한다
function expandedKey(cwd: string): string {
  return 'explorer.expanded:' + cwd.replace(/[\\/]+/g, '/').toLowerCase()
}

// 참고 폴더 목록의 저장 키 — 메인 작업 폴더별로 따로 기억한다
function refsKey(cwd: string): string {
  return 'explorer.refs:' + cwd.replace(/[\\/]+/g, '/').toLowerCase()
}

// "Verse API" 묶음 펼침 여부의 저장 키 — 프로젝트별로 기억(기본 접힘)
function verseOpenKey(cwd: string): string {
  return 'explorer.verseOpen:' + cwd.replace(/[\\/]+/g, '/').toLowerCase()
}

// "Verse 위주로 보기"(에셋·정크 숨김) 토글의 저장 키 — 프로젝트별, Verse 프로젝트는 기본 ON
function verseFilterKey(cwd: string): string {
  return 'explorer.verseFilter:' + cwd.replace(/[\\/]+/g, '/').toLowerCase()
}

// 지금 보고 있는 폴더(메인='' 또는 Verse API·참고 폴더 경로)의 저장 키 — 프로젝트별로 기억해
// 앱을 껐다 켜거나 같은 채팅을 다시 열어도 보던 폴더(예: /Verse.org)로 복원한다
function viewKey(cwd: string): string {
  return 'explorer.view:' + cwd.replace(/[\\/]+/g, '/').toLowerCase()
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
  onShowChanged,
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
  onShowChanged?: (scope: { rel: string; label: string }) => void // 우클릭 '변경된 파일 보기' → 카드
  onViewFolderChange?: (folder: string) => void // 지금 보고 있는 폴더(메인/참고)를 알림 → 채팅 @ 멘션의 기준
}) {
  // 참고 폴더(보기 전용) 목록과 지금 보고 있는 폴더('' = 메인). cwd가 바뀌면(채팅
  // 전환/폴더 변경) 렌더 중에 같이 갈아끼워, stale한 루트로 트리를 한 번 더 읽는
  // 깜빡임이 없게 한다.
  const [refs, setRefs] = useState<string[]>(() => (cwd ? getPref<string[]>(refsKey(cwd), []) : []))
  // Verse 프로젝트면 자동으로 채워지는 보기 전용 API digest 루트(Verse.org/Fortnite.com/…).
  // 수동 참고 폴더(refs)와 달리 영속하지 않고 — 매번 .vproject에서 다시 발견한다.
  const [verseRefs, setVerseRefs] = useState<{ path: string; name: string }[]>([])
  // "Verse API" 묶음 접힘/펼침 — 프로젝트별로 기억(기본 접힘). 클러터를 줄이는 게 목적이라
  // 처음엔 한 줄로만 보이고, 한 번 펼치면 그 프로젝트에선 그대로 유지된다.
  const [verseOpen, setVerseOpen] = useState<boolean>(() => (cwd ? getPref<boolean>(verseOpenKey(cwd), false) : false))
  // "Verse 위주로 보기" — UEFN .code-workspace의 files.exclude 글롭 + 빈 폴더 숨김으로 에셋/정크를
  // 가린다. excludes가 비면(=Verse 프로젝트 아님) 토글 자체를 숨긴다. 기본 ON, 프로젝트별 영속.
  const [excludes, setExcludes] = useState<string[]>([])
  const [verseFilter, setVerseFilter] = useState<boolean>(() => (cwd ? getPref<boolean>(verseFilterKey(cwd), true) : true))
  // 지금 보고 있는 폴더 — 프로젝트별로 영속(껐다 켜도 보던 Verse API/참고 폴더로 복원). '' = 메인.
  const [view, setView] = useState<string>(() => (cwd ? getPref<string>(viewKey(cwd), '') : ''))
  // 빌드·생성물 숨김(설정 › Explorer) — Verse와 달리 프로젝트별이 아니라 전역 프리셋이고,
  // 폴더 목록과 파일(이름·패턴) 목록 두 벌이다. 설정이나 우클릭 '숨김 목록에 추가'가 목록/토글을
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
  // 칼럼 너비 — 오른쪽 가장자리 핸들을 끌어 조절, 전역으로 기억(껐다 켜도 유지). 더블클릭으로 기본값 복귀.
  const clampW = (w: number): number => Math.max(EXP_MIN_W, Math.min(EXP_MAX_W, Math.round(w)))
  const [width, setWidth] = useState<number>(() => clampW(getPref<number>('explorer.width', EXP_DEFAULT_W)))
  const widthRef = useRef(width)
  const dragRef = useRef<{ x: number; w: number } | null>(null)
  const resizeElRef = useRef<HTMLDivElement>(null)
  // 핸들 옆 말풍선 — 호버엔 안내문, 드래그 중엔 실시간 너비(px). 커서 Y를 따라 왼쪽에 뜬다.
  const [wtip, setWtip] = useState<{ x: number; y: number; text: string } | null>(null)
  const applyWidth = (w: number): void => {
    const c = clampW(w)
    widthRef.current = c
    setWidth(c)
  }
  const paintTip = (clientY: number, dragging: boolean): void => {
    const el = resizeElRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setWtip({ x: r.left, y: clientY, text: dragging ? `${widthRef.current}px` : '드래그로 너비 조절 · 더블클릭 초기화' })
  }
  const onResizeDown = (e: React.PointerEvent): void => {
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { x: e.clientX, w: width }
    document.body.classList.add('col-resizing')
    paintTip(e.clientY, true)
  }
  const onResizeMove = (e: React.PointerEvent): void => {
    const d = dragRef.current
    if (d) applyWidth(d.w + (e.clientX - d.x))
    paintTip(e.clientY, !!d) // 드래그면 px, 호버면 안내문 — 커서를 따라 위치 갱신
  }
  const onResizeUp = (e: React.PointerEvent): void => {
    if (!dragRef.current) return
    dragRef.current = null
    document.body.classList.remove('col-resizing')
    ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
    setPref('explorer.width', widthRef.current)
    setWtip(null)
  }
  const onResizeEnter = (e: React.PointerEvent): void => {
    if (!dragRef.current) paintTip(e.clientY, false)
  }
  const onResizeLeave = (): void => {
    if (!dragRef.current) setWtip(null)
  }
  const resetWidth = (e: React.MouseEvent): void => {
    applyWidth(EXP_DEFAULT_W)
    setPref('explorer.width', EXP_DEFAULT_W)
    paintTip(e.clientY, false) // 초기화 후에도 안내문을 그 자리에 다시 그린다
  }
  const [prevCwd, setPrevCwd] = useState(cwd)
  if (prevCwd !== cwd) {
    setPrevCwd(cwd)
    setRefs(cwd ? getPref<string[]>(refsKey(cwd), []) : [])
    setVerseRefs([])
    setExcludes([])
    setVerseOpen(cwd ? getPref<boolean>(verseOpenKey(cwd), false) : false)
    setVerseFilter(cwd ? getPref<boolean>(verseFilterKey(cwd), true) : true)
    setView(cwd ? getPref<string>(viewKey(cwd), '') : '')
  }
  // "Verse 위주로 보기" — UEFN 글롭(파일+폴더) + 빈 폴더 숨김
  const verseFiltering = verseFilter && excludes.length > 0
  // 세 필터는 성격이 달라 따로 넘긴다:
  //  - 일반 숨김 폴더(generalDirs)는 '폴더에만' — 같은 이름의 파일(예: 확장자 없는 'Saved')은 안 숨긴다.
  //  - 일반 숨김 파일(generalFiles)은 '파일에만' — 이름 또는 *.확장자 패턴, 폴더 목록의 거울.
  //  - Verse 글롭(verseExcl)은 *.uasset 같은 파일도 폴더도 숨겨야 하므로 양쪽에 건다.
  const generalDirs = useMemo(() => (hideEnabled ? hideList : []), [hideEnabled, hideList])
  const generalFiles = useMemo(() => (hideEnabled ? hideFileList : []), [hideEnabled, hideFileList])
  const verseExcl = useMemo(() => (verseFiltering ? excludes : []), [verseFiltering, excludes])
  const hideEmpty = verseFiltering // 빈 폴더 프루닝은 Verse에만
  // 검색 결과에서 숨긴 폴더 밑의 파일도 빼기 위한 이름 집합(소문자) — 일반 숨김(폴더)만 대상
  const hideSet = useMemo(() => new Set(generalDirs.map((d) => d.toLowerCase())), [generalDirs])
  // 숨긴 파일 이름·패턴은 검색 결과에서도 뺀다 — 트리 판정(makeExcluder)과 같은 규칙의 렌더러 매처
  const hideFileMatch = useMemo(() => makeNameMatcher(generalFiles), [generalFiles])
  // 수동 참고 폴더에 이미 있는 경로는 자동 digest 행에서 빼 중복을 막는다
  const autoRefs = verseRefs.filter((v) => !refs.some((r) => samePath(r, v.path)))
  const viewing = view && (refs.includes(view) || autoRefs.some((v) => v.path === view)) ? view : '' // '' = 메인 폴더 보기
  const root = viewing || cwd // 지금 트리가 보여주는 폴더

  // rel path('' = root) → that folder's entries; only loaded (visited) folders exist here
  const [entries, setEntries] = useState<Map<string, DirEntry[]>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const refreshRef = useRef<HTMLButtonElement>(null) // 새로고침 아이콘 1회전 애니메이션 대상
  // 우클릭 컨텍스트 메뉴 + 파일 작업 카드(이름 변경·새 파일/폴더·삭제). root=true면 빈 영역
  // 우클릭(프로젝트 루트에 만들기)이다.
  const [ctx, setCtx] = useState<{
    x: number
    y: number
    rel: string
    name: string
    dir: boolean
    root?: boolean
    // 절대경로 대상(작업/참고 폴더 행) — "파일 탐색기에서 보기"만 있는 보기 전용 메뉴.
    // 파일 작업(새 파일·이름 변경·삭제)은 트리의 rel 경로 기반이라 여기엔 안 붙인다.
    revealAbs?: string
  } | null>(null)
  const [fileOp, setFileOp] = useState<FileOp | null>(null)
  const ctxRef = useRef<HTMLDivElement>(null)
  // 드래그 앤 드롭 이동 — dragRel: 끌고 있는 항목, dropRel: 들어갈 대상 폴더('' = 루트)
  const [dragRel, setDragRel] = useState<string | null>(null)
  const [dropRel, setDropRel] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ title: string; message: string } | null>(null) // 알림 카드
  // 참고 폴더도 미리 데워 둔다(메인은 App에서 prewarm) — 첫 파일 열 때 빠르게.
  // 심볼 분석 진행 표시는 코드창(파일별 "심볼 분석 중 %")으로 옮겼다 — 폴더 배지 없음.
  useEffect(() => {
    refs.forEach((d) => window.api.lsp.prewarm(d).catch(() => {}))
  }, [refs])

  // 보고 있는 폴더가 바뀔 때마다 프로젝트별로 저장 — 모든 setView 경로(메인/참고/Verse API 클릭,
  // 참고 폴더 추가·삭제)를 한곳에서 영속한다. cwd 전환 시엔 위에서 그 프로젝트의 저장값으로
  // 막 복원했으므로 같은 값을 다시 쓰는 무해한 no-op이 된다.
  useEffect(() => {
    if (cwd) setPref(viewKey(cwd), view)
  }, [cwd, view])

  // Verse 프로젝트면 .vproject의 패키지(내 Verse 소스 + Verse.org/Fortnite.com/… digest)를
  // 발견해 보기 전용 루트로 자동 노출 — UEFN이 VS Code에 그리는 그룹 뷰와 같은 모습.
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

  // 필터를 켜고/끄거나(또는 excludes가 처음 도착하면) 화면에 떠 있는 것(root + 펼친 폴더)을
  // 조용히 다시 읽는다 — 펼침/선택 상태는 그대로 두고 내용만 필터 반영. 검색 인덱스도 무효화.
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

  // 우클릭한 폴더 아래 변경 파일 수 — 0이면 '변경된 파일 보기' 메뉴 항목 자체를
  // 안 그린다(점 없는 폴더와 일치). 목록 자체는 App의 ChangedFilesModal 카드가 그린다.
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

  // a new root (작업 폴더 변경 또는 메인↔참고 전환) → a fresh tree. 같은 폴더를
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
      // 트리에서 숨긴 폴더 밑의 파일은 검색에서도 뺀다(디렉터리 세그먼트만 검사, 파일명은 제외)
      if (hideSet.size) {
        const cut = f.lastIndexOf('/')
        if (cut >= 0 && f.slice(0, cut).toLowerCase().split('/').some((s) => hideSet.has(s))) continue
      }
      const name = f.slice(f.lastIndexOf('/') + 1).toLowerCase()
      if (hideFileMatch && hideFileMatch(name)) continue // 숨긴 파일 이름·패턴도 검색에서 제외
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
    if (samePath(p, cwd)) {
      setView('')
      return
    }
    const dup = refs.find((r) => samePath(r, p))
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

  // 수동 새로고침 — 지금 보고 있는 폴더(루트 + 펼쳐둔 하위 폴더)를 다시 읽는다. 검색 인덱스도
  // 버려 다음 검색이 최신 파일을 본다. 펼침·선택 상태는 그대로. (턴 종료 자동 갱신과 같은 동작)
  const refresh = (): void => {
    if (!root) return
    loadDir('')
    expanded.forEach((rel) => loadDir(rel))
    setAllFiles(null)
    // WAAPI로 매 클릭마다 깔끔히 한 바퀴 — CSS 클래스 토글과 달리 연속 클릭에도 항상 재시작
    refreshRef.current
      ?.querySelector('svg')
      ?.animate?.([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], {
        duration: 500,
        easing: 'ease-in-out'
      })
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
  // 작업/참고 폴더 행 우클릭 — 절대경로 대상의 "파일 탐색기에서 보기" 전용 메뉴
  const openCtxAbs = (ev: React.MouseEvent, abs: string, name: string): void => {
    ev.preventDefault()
    ev.stopPropagation()
    setCtx({ x: ev.clientX, y: ev.clientY, rel: '', name, dir: false, revealAbs: abs })
  }
  const doReveal = (): void => {
    if (!ctx) return
    if (ctx.revealAbs) void window.api.revealPath('', ctx.revealAbs)
    else void window.api.revealPath(root, ctx.rel)
    setCtx(null)
  }
  // 절대경로를 클립보드로 — 뷰어 헤더 우클릭 '경로 복사'와 같은 백슬래시 표기
  const doCopyPath = (): void => {
    if (!ctx) return
    const abs = ctx.revealAbs || (ctx.rel ? root.replace(/[\\/]+$/, '') + '\\' + ctx.rel : root)
    void navigator.clipboard.writeText(abs.replace(/\//g, '\\'))
    setCtx(null)
  }
  // 우클릭 '숨김 목록에 추가' — 폴더는 폴더 목록에, 파일은 파일 목록에 이름으로 넣는다.
  // 전역 목록이라 설정 › Explorer에서 되돌리고, setHide*가 이벤트를 쏴 트리가 곧바로
  // 다시 읽힌다. 마스터 토글이 꺼져 있으면 켠다 — 숨기라고 눌렀는데 그대로 보이면 이상하니.
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
  // dest 폴더('' = 루트)로 src를 옮길 수 있나 — 자기 자신/자기 하위/이미 그 안이면 불가
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

  // 컨텍스트 메뉴가 화면 아래/오른쪽을 넘치면 실측 크기로 되민다 — 항목 수가 행 종류
  // (파일/폴더/루트/절대경로)마다 달라 상수 클램프로는 부족하다. paint 전에 실행돼 안 튄다.
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

  // 접힘: 잔여 레일 없이 완전히 사라진다 — 칼럼이 깔끔하게 닫힌다. 다시 열기는
  // 채팅 헤더 좌상단의 토글 버튼(단축키 몰라도 클릭) 또는 Ctrl/⌘+F.
  if (!open) return null

  const project = basename(cwd)
  // 지금 보고 있는 뷰의 표시 이름 — 메인은 프로젝트명, Verse API/참고 폴더는 그 폴더명(예: /Verse.org)
  const rootLabel = viewing ? autoRefs.find((v) => v.path === viewing)?.name ?? basename(viewing) : project
  // 우클릭 메뉴의 '변경된 파일 보기' — 폴더/루트(빈 영역)에서만, 그 아래 변경 파일이 있을 때만.
  // 참고 폴더 뷰에선 chg가 비어 있어 자연히 안 뜬다.
  const ctxChg = ctx && onShowChanged && (ctx.dir || ctx.root) && !ctx.revealAbs ? countChg(ctx.rel) : 0

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
    // 생성물 폴더 등 수만 개 항목을 한 번에 DOM으로 만들면 렌더러가 멈춘다 — 상한 후
    // 생략 안내 행을 붙인다
    const shown = list.length > MAX_DIR_ROWS ? list.slice(0, MAX_DIR_ROWS) : list
    const rows = shown.map((e) => {
      const rel = base ? base + '/' + e.name : e.name
      if (e.dir) {
        const isOpen = expanded.has(rel)
        const dot = chg.dirs.get(rel)
        return (
          <Fragment key={rel}>
            <button
              className={
                'exp-row' + (dragRel === rel ? ' dragging' : '') + (dropRel === rel ? ' drop-into' : '')
              }
              style={{ paddingLeft: indent(depth) }}
              onClick={() => toggleDir(rel)}
              onContextMenu={(ev) => openCtx(ev, rel, e.name, true)}
              draggable
              onDragStart={(ev) => onDragStartRow(ev, rel)}
              onDragEnd={onDragEndRow}
              onDragOver={(ev) => onDragOverFolder(ev, rel)}
              onDrop={(ev) => onDropFolder(ev, rel)}
            >
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
          className={
            'exp-row has-tip' + (sel === rel ? ' sel' : '') + (tag ? ' chg-' + tag : '') + (dragRel === rel ? ' dragging' : '')
          }
          data-tip={tag ? rel + (tag === 'new' ? ' · 새 파일 — 클릭하면 diff' : ' · 수정됨 — 클릭하면 diff') : rel}
          style={{ paddingLeft: indent(depth) + 15 }}
          onClick={() => openFile(rel)}
          onContextMenu={(ev) => openCtx(ev, rel, e.name, false)}
          draggable
          onDragStart={(ev) => onDragStartRow(ev, rel)}
          onDragEnd={onDragEndRow}
          onDragOver={onDragOverFile}
        >
          <span className="exp-fbadge">
            <FileBadge path={e.name} size={15} />
          </span>
          <span className="exp-name">{e.name}</span>
          {tag && <span className={'exp-chg ' + tag}>{tag === 'new' ? 'N' : 'M'}</span>}
        </button>
      )
    })
    if (list.length > shown.length) {
      rows.push(
        <div className="exp-note" style={{ paddingLeft: indent(depth) + 18 }} key={base + '/…'}>
          외 {list.length - shown.length}개 항목 생략
        </div>
      )
    }
    return rows
  }

  return (
    <aside className="explorer" ref={asideRef} style={{ width, flex: `0 0 ${width}px` }}>
      <ScrollTip rootRef={asideRef} suppressed={!!ctx} />
      {ctx &&
        createPortal(
          <div
            ref={ctxRef}
            className="ctx-menu"
            style={{ left: ctx.x, top: ctx.y }}
          >
            {/* 새 파일/폴더는 폴더 또는 빈 영역(루트)에서만 — 파일·폴더 행(revealAbs) 우클릭엔 안 뜬다 */}
            {(ctx.dir || ctx.root) && !ctx.revealAbs && (
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
            {!ctx.root && !ctx.revealAbs && (
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
            {/* 이 폴더(또는 프로젝트 전체) 아래 AI가 만든/수정한 파일 목록 카드 — 점이 붙은 폴더에만 뜬다 */}
            {ctxChg > 0 && (
              <button
                className="ctx-item"
                onClick={() => {
                  onShowChanged?.({ rel: ctx.rel, label: ctx.root ? rootLabel : ctx.name })
                  setCtx(null)
                }}
              >
                <IconList size={15} /> 변경된 파일 {ctxChg}개 보기
              </button>
            )}
            {/* 숨김 목록에 추가 — 이름으로 폴더/파일 목록에 넣는다. 루트/절대경로 행에는 안 붙는다.
                클릭 즉시 트리에서 사라지고 설정 › Explorer에서 관리(거기선 *.확장자 패턴도 가능). */}
            {!ctx.root && !ctx.revealAbs && (
              <>
                <div className="ctx-sep" />
                <button className="ctx-item" onClick={() => addHide(ctx.name, ctx.dir)}>
                  <IconEyeOff size={15} /> ‘{shortName(ctx.name)}’ 숨김 목록에 추가
                </button>
              </>
            )}
            {!ctx.root && !ctx.revealAbs && (
              <>
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
      {fileOp && (
        <FileOpModal op={fileOp} onSubmit={(v) => runFileOp(fileOp, v)} onClose={() => setFileOp(null)} />
      )}
      {notice && <NoticeModal title={notice.title} message={notice.message} onClose={() => setNotice(null)} />}
      <div className="exp-head">
        <span className="exp-title">탐색기</span>
        {/* 빌드·생성물 숨김(폴더·파일) 빠른 토글 — 목록은 설정 › Explorer에서 관리(전역 프리셋) */}
        <button
          className={'exp-act has-tip' + (hideEnabled ? ' on' : '')}
          data-tip={
            hideEnabled
              ? '빌드·생성물 폴더·파일 숨김 · 켜짐 — 클릭하면 모두 보기 (목록: 설정 › Explorer)'
              : '모든 항목 보임 — 클릭하면 빌드·생성물 폴더·파일 숨김 (목록: 설정 › Explorer)'
          }
          aria-label="빌드·생성물 폴더·파일 숨김"
          aria-pressed={hideEnabled}
          onClick={() => setHideEnabled(!hideEnabled)}
          disabled={!cwd}
        >
          <IconFilter size={14} />
        </button>
        {/* 수동 새로고침 — 턴 종료 자동 갱신과 별개로, 외부에서 바뀐 파일을 지금 바로 반영 */}
        <button
          ref={refreshRef}
          className="exp-act has-tip"
          data-tip="새로고침 — 지금 보는 폴더 다시 읽기"
          aria-label="새로고침"
          onClick={refresh}
          disabled={!cwd}
        >
          <IconRefresh size={14} />
        </button>
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
              onContextMenu={(e) => openCtxAbs(e, cwd, project)}
              aria-label="메인 작업 폴더"
            >
              <IconFolder className="f-ic" size={14} />
              <span className="f-name">{project}</span>
              {refs.length > 0 || autoRefs.length > 0 ? (
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
                onContextMenu={(e) => openCtxAbs(e, r, basename(r))}
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
            {autoRefs.length > 0 && (
              <>
                <button
                  className={'exp-frow verse vparent has-tip' + (verseOpen ? ' open' : '')}
                  data-tip={`Verse API · ${autoRefs.length}개 패키지 (읽기 전용)`}
                  aria-expanded={verseOpen}
                  onClick={toggleVerse}
                >
                  <IconVerse className="f-ic" size={14} />
                  <span className="f-name">Verse API</span>
                  {excludes.length > 0 && (
                    <span
                      className={'v-filter has-tip' + (verseFilter ? ' on' : '')}
                      role="button"
                      aria-label="Verse 위주로 보기"
                      aria-pressed={verseFilter}
                      data-tip={verseFilter ? 'Verse 위주로 보기 — 켜짐 (클릭하면 모든 파일)' : '모든 파일 보임 (클릭하면 Verse 위주로)'}
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleFilter()
                      }}
                    >
                      <IconFilter size={12} />
                    </span>
                  )}
                  <span className="f-vcount">{autoRefs.length}</span>
                </button>
                {verseOpen &&
                  autoRefs.map((v) => (
                    <button
                      key={'verse:' + v.path}
                      className={'exp-vchild has-tip' + (viewing === v.path ? ' active' : '')}
                      data-tip={v.name}
                      onClick={() => setView(v.path)}
                    >
                      <IconVerse className="f-ic" size={13} />
                      <span className="f-name">{v.name}</span>
                    </button>
                  ))}
              </>
            )}
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
            <div
              className={'exp-tree scroll' + (dropRel === '' && dragRel ? ' drop-root' : '')}
              onContextMenu={openCtxRoot}
              onDragOver={onDragOverRoot}
              onDrop={onDropRoot}
            >
              {renderRows('', 0)}
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
      {/* 오른쪽 가장자리 드래그로 칼럼 너비 조절 — 더블클릭하면 기본 너비로 복귀 */}
      <div
        ref={resizeElRef}
        className="exp-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="탐색기 너비 조절"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerEnter={onResizeEnter}
        onPointerLeave={onResizeLeave}
        onDoubleClick={resetWidth}
      />
      {wtip &&
        createPortal(
          <div className="exp-wtip" style={{ left: wtip.x, top: wtip.y }}>
            {wtip.text}
          </div>,
          document.body
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

// 컨텍스트 메뉴 라벨용 — 긴 파일 이름이 메뉴 폭을 폭주시키지 않게 줄인다
function shortName(name: string): string {
  return name.length > 24 ? name.slice(0, 22) + '…' : name
}

// 경로 동치 비교 — 슬래시 방향·중복·대소문자 무시 (Windows 경로 섞임 대응)
function samePath(a: string, b: string): boolean {
  return a.replace(/[\\/]+/g, '/').toLowerCase() === b.replace(/[\\/]+/g, '/').toLowerCase()
}

// 트리/폴더 행 툴팁 — CSS ::after 툴팁은 스크롤 컨테이너(.exp-tree, overflow)에서 잘려 안 보인다.
// 그래서 그 두 영역의 [data-tip]은 여기서 body로 포털한 fixed 툴팁으로 띄운다(클리핑 탈출).
// (CSS 쪽은 .exp-tree/.exp-folders 의 ::after 를 끄고, exp-head 등 다른 곳은 그대로 CSS 툴팁 유지.)
function ScrollTip({ rootRef, suppressed }: { rootRef: { current: HTMLElement | null }; suppressed?: boolean }) {
  const [tip, setTip] = useState<{ text: string; rect: DOMRect } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  // 컨텍스트 메뉴가 열려 있는 동안은 툴팁을 띄우지 않는다(우클릭 시 둘이 겹쳐 보이던 버그).
  const suppressedRef = useRef(false)
  useEffect(() => {
    suppressedRef.current = !!suppressed
    if (suppressed) setTip(null)
  }, [suppressed])
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
      if (suppressedRef.current) return
      const el = (e.target as Element).closest?.('[data-tip]')
      if (!el || !el.closest('.exp-tree, .exp-folders')) return
      if (el === cur) return
      cur = el
      window.clearTimeout(timer)
      setTip(null)
      const text = el.getAttribute('data-tip') || ''
      if (!text) return
      timer = window.setTimeout(() => {
        if (cur === el && !suppressedRef.current) setTip({ text, rect: el.getBoundingClientRect() })
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
