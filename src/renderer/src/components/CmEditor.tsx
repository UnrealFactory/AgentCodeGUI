import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { EditorState, Compartment, StateField, StateEffect } from '@codemirror/state'
import {
  EditorView,
  lineNumbers,
  drawSelection,
  keymap,
  hoverTooltip,
  tooltips,
  Decoration,
  type DecorationSet
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  closeBrackets,
  closeBracketsKeymap,
  autocompletion,
  completionKeymap,
  startCompletion,
  acceptCompletion,
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult
} from '@codemirror/autocomplete'
import { highlightSelectionMatches } from '@codemirror/search'
import { indentUnit, bracketMatching } from '@codemirror/language'
import type { LspSemanticTokens, LspLocation } from '@shared/protocol'
import { highlighting } from '../lib/cmHljs'
import { ensureVerseRegistry, onVerseRegChange } from '../lib/verseRegistry'
import { buildSemDict, type StructOv } from '../lib/semTokens'
import { readDiffField, type DiffMarks } from '../lib/cmDiff'
import { findField, setFindHits, computeMatches } from '../lib/cmFind'
import { paletteClassFor } from './fileType'
import { IconSearch, IconChevDown, IconClose, IconAlert } from './icons'
import { HoverContent } from './FileModal'

export interface CmEditorHandle {
  save: () => void
  getCaret: () => number // 현재 캐럿 offset — 정의 이동 시 호출 위치 저장용
  openSearch: () => void // Ctrl+F — CM 검색 패널 열기 (포커스 무관)
  focus: () => void // 편집기로 포커스 복귀 (예: 닫기 확인 카드를 취소한 뒤)
}

const PAIR: Record<string, string> = { '{': '}', '[': ']', '(': ')' }

// CM document offset → LSP 0-based {line, character}
function toLspPos(view: EditorView, offset: number): { line: number; character: number } {
  const line = view.state.doc.lineAt(offset)
  return { line: line.number - 1, character: offset - line.from }
}

// LSP CompletionItemKind(숫자) → CM 자동완성 아이콘 type 문자열. CM이 아는 종류로 매핑하고
// 모르는 건 'variable'로 떨군다(아이콘만 다름 — 동작엔 영향 없음).
const COMPL_KIND: Record<number, string> = {
  2: 'method', 3: 'function', 4: 'function', 5: 'property', 6: 'variable', 7: 'class',
  8: 'interface', 9: 'namespace', 10: 'property', 13: 'enum', 14: 'keyword', 15: 'text',
  16: 'constant', 17: 'text', 20: 'enum', 21: 'constant', 22: 'struct', 23: 'variable',
  24: 'operator', 25: 'type'
}
function complKind(kind?: number): string {
  return (kind != null && COMPL_KIND[kind]) || 'variable'
}

// verse-lsp는 label에 시그니처까지 통째로 싣는다(`Sleep(Seconds:float)`, `kind {Field:t := …}`).
// 이름과 그 뒤 시그니처(첫 '(' 또는 '{'부터)를 갈라, 이름은 또렷이·시그니처는 흐리게 보여 준다.
function splitSig(label: string): { name: string; sig: string } {
  // 값 매개변수 '(', 타입 매개변수 '[', 구조체 아키타입 '{' 중 첫 경계부터를 시그니처로 가른다
  const cut = label.search(/[([{]/)
  if (cut <= 0) return { name: label, sig: '' }
  // 이름은 매칭용으로 깔끔히(trim), 중괄호 앞 공백은 시그니처에 살려 `kind {…}`처럼 띄워 보인다
  const gap = label[cut - 1] === ' ' ? ' ' : ''
  return { name: label.slice(0, cut).trimEnd(), sig: gap + label.slice(cut) }
}

// 정의 이동 도착 줄을 잠깐 깜빡이는 라인 데코레이션 (뷰어의 .fvl.flash와 같은 fvl-flash 애니메이션).
// 값 = 줄 시작 offset, null = 해제.
const flashEffect = StateEffect.define<number | null>()
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(flashEffect))
        deco = e.value == null ? Decoration.none : Decoration.set([Decoration.line({ class: 'cm-flash' }).range(e.value)])
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f)
})

// 들여쓰기가 의미를 갖는 언어의 스마트 Enter 보정. open: 블록을 여는 줄(끝이 ':' 또는 Verse는
// '=' 정의도) 다음 줄은 한 단계 들여쓰고, dedent: 블록을 닫는 문(return/break/continue …) 다음
// 줄은 한 단계 내어쓴다 — 그다음은 보통 바깥 스코프의 새 선언이라(사용자 예: `return 0.0` 뒤엔
// 새 함수·변수). 괄호({}/[]/()) 기반 언어는 아래 PAIR 로직이 이미 처리하므로 여기 등록하지 않는다.
const INDENT_RULES: Record<string, { open: RegExp; dedent: RegExp }> = {
  verse: { open: /[:=]$/, dedent: /^(return|break|continue|yield)\b/ },
  python: { open: /:$/, dedent: /^(return|break|continue|pass|raise)\b/ }
}

// Smart Enter — works for every language without a CM grammar: continue the current line's
// indentation, add one level after an opening bracket, split a freshly-typed pair ( {| } )
// onto three lines (IDE-classic), and—for indentation-significant languages (Verse/Python)—
// open a block after ':'/'=' and close one after return/break/continue.
function smartEnter(view: EditorView, lang: string): boolean {
  const { state } = view
  if (state.readOnly) return false // 읽기 모드에선 편집하지 않는다(기본 동작에 양보)
  const sel = state.selection.main
  if (sel.from !== sel.to) return false // let the default handle ranged selections
  const line = state.doc.lineAt(sel.from)
  const indent = /^[ \t]*/.exec(line.text)![0]
  const unit = state.facet(indentUnit)
  const before = state.doc.sliceString(line.from, sel.from)
  const opener = before.replace(/\s+$/, '').slice(-1)
  const opensBlock = opener in PAIR
  const nextChar = state.doc.sliceString(sel.from, Math.min(sel.from + 1, line.to))
  if (opensBlock && nextChar === PAIR[opener]) {
    view.dispatch({
      changes: { from: sel.from, insert: '\n' + indent + unit + '\n' + indent },
      selection: { anchor: sel.from + 1 + indent.length + unit.length },
      scrollIntoView: true,
      userEvent: 'input'
    })
    return true
  }
  let newIndent = opensBlock ? indent + unit : indent
  const rule = INDENT_RULES[lang]
  if (!opensBlock && rule) {
    const head = before.trim()
    if (rule.open.test(head)) newIndent = indent + unit
    else if (rule.dedent.test(head) && indent.endsWith(unit)) newIndent = indent.slice(0, indent.length - unit.length)
  }
  view.dispatch({
    changes: { from: sel.from, insert: '\n' + newIndent },
    selection: { anchor: sel.from + 1 + newIndent.length },
    scrollIntoView: true,
    userEvent: 'input'
  })
  return true
}

// Per-language line-comment token. We paint colours from hljs (no CM language package), so
// CM's own toggleComment has no commentTokens to work with — this drives our own Mod-/ below.
const LINE_COMMENT: Record<string, string> = {
  verse: '#', python: '#', ruby: '#', perl: '#', bash: '#', yaml: '#', ini: '#', r: '#',
  makefile: '#', dockerfile: '#',
  csharp: '//', cpp: '//', c: '//', javascript: '//', typescript: '//', java: '//', rust: '//',
  go: '//', kotlin: '//', swift: '//', php: '//', fsharp: '//', scss: '//', less: '//',
  objectivec: '//', json: '//', vbnet: "'", sql: '--', lua: '--'
}

// Mod-/ — toggle line comments over the selected lines, language-aware. Comments at the
// selection's shallowest indent (keeps code aligned); uncomments when every non-blank line
// already starts with the token. No-op (falls through) for read mode or unknown languages.
function toggleLineComment(view: EditorView, lang: string): boolean {
  const token = LINE_COMMENT[lang]
  if (!token || view.state.readOnly) return false
  const { state } = view
  const nums = new Set<number>()
  for (const r of state.selection.ranges)
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) nums.add(n)
  const lines = [...nums].map((n) => state.doc.line(n)).filter((l) => l.text.trim().length)
  if (!lines.length) return false
  const allCommented = lines.every((l) => l.text.trimStart().startsWith(token))
  const changes = allCommented
    ? lines.map((l) => {
        const from = l.from + l.text.indexOf(token)
        const to = from + token.length + (state.doc.sliceString(from + token.length, from + token.length + 1) === ' ' ? 1 : 0)
        return { from, to }
      })
    : (() => {
        const col = Math.min(...lines.map((l) => /^[ \t]*/.exec(l.text)![0].length))
        return lines.map((l) => ({ from: l.from + col, insert: token + ' ' }))
      })()
  view.dispatch({ changes, userEvent: allCommented ? 'delete' : 'input' })
  return true
}

// Indent unit from the file's first indented line (tab vs 2/4 spaces) — most files
// are consistent, so this is enough for Tab + smart-Enter to match the file's style.
function detectIndentUnit(text: string): string {
  for (const l of text.split('\n')) {
    const m = /^([ \t]+)\S/.exec(l)
    if (!m) continue
    return m[1][0] === '\t' ? '\t' : ' '.repeat(m[1].length >= 4 ? 4 : 2)
  }
  return '  '
}

// CM theme tuned to match the read-only viewer (.fv-pre / .fv-gutter): same mono
// font, 12.5px / line-height 1.7, app background, accent caret, no active-line tint.
// All token COLORS come from the hljs decoration layer + the app's existing
// `.hljs .hljs-*` CSS — never from CM's own highlighter.
const baseTheme = EditorView.theme(
  {
    // background is the viewer's recessed code color (--inset, darker than --bg).
    // font-size is driven by --cm-fs (Ctrl+휠 zoom) so the editor scales like the viewer
    // without CSS `zoom`, which would skew CM's caret/selection geometry
    '&': { height: '100%', backgroundColor: 'var(--inset)', color: 'var(--text-2)', fontSize: 'var(--cm-fs, 12.5px)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.7', overflow: 'auto' },
    '.cm-content': { padding: '14px 0', caretColor: 'var(--accent)' },
    '.cm-line': { padding: '0 20px 0 16px' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'var(--accent-soft)'
    },
    // 캐럿 옆 괄호 짝 강조 — 선택색과 구분되게 은은한 박스(테두리 위주), 짝 없으면 빨강 글자
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: 'var(--accent-soft)',
      outline: '1px solid color-mix(in oklch, var(--accent) 55%, transparent)',
      borderRadius: '2px'
    },
    '.cm-nonmatchingBracket': { color: 'var(--red)' },
    '.cm-gutters': { backgroundColor: 'var(--inset)', borderRight: '1px solid var(--line)', color: 'var(--text-4)' },
    '.cm-lineNumbers .cm-gutterElement': {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--cm-fs, 12.5px)',
      padding: '0 10px 0 16px',
      minWidth: '34px'
    },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' }
  },
  { dark: true }
)

// A CodeMirror-backed code surface: the viewer's exact colors (hljs decorations +
// existing CSS), now editable with history/undo, auto-closing brackets, smart Enter,
// and Ctrl+S save. The host div carries `hljs` + the language palette class so the
// existing `.hljs .hljs-*` / `.pal-rider …` rules cascade onto the decoration spans.
export const CmEditor = forwardRef<
  CmEditorHandle,
  {
    content: string
    lang: string
    path: string
    cwd: string
    sem?: LspSemanticTokens | null // LSP 시맨틱 토큰 → .sem-* 색 (도착하면 리컴파트먼트)
    structOv?: StructOv | null // C++ struct 연보라 보정 (hover 프로브로 늦게 도착)
    marks?: DiffMarks | null // 변경 diff — 추가 줄 초록 + 삭제 고스트 + 오버뷰 룰러
    readOnly?: boolean // 읽기 모드 — 편집 잠금 + "현재 vs 부모" 표준 diff 표시(편집 모드는 diff 끔)
    zoom?: number // Ctrl+휠 배율 (1 = 100%) — 폰트 크기로 환산해 적용
    lsp?: boolean // 언어 서버 준비됨 → hover·정의 이동 활성화
    jump?: { line: number; tick: number } | null // 정의 이동 도착 줄 (1-based) → 스크롤
    initialPos?: number // 마운트 시 복원할 캐럿 offset (뒤로가기로 돌아온 파일의 호출 위치)
    onNavigate?: (loc: LspLocation) => void // 정의 이동 (같은 파일=jump, 다른 파일=스택)
    onDirtyChange?: (dirty: boolean) => void
    onSaved?: () => void
  }
>(function CmEditor(
  { content, lang, path, cwd, sem = null, structOv = null, marks = null, readOnly = false, zoom = 1, lsp = false, jump = null, initialPos, onNavigate, onDirtyChange, onSaved },
  ref
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const cmParentRef = useRef<HTMLDivElement>(null) // CM이 마운트되는 안쪽 div (룰러 오버레이와 형제)
  const viewRef = useRef<EditorView | null>(null)
  const [rulerOn, setRulerOn] = useState(false) // 스크롤될 때만 오버뷰 룰러 표시
  const [findOpen, setFindOpen] = useState(false) // Ctrl+F 검색 바(우리 디자인 .fv-find 오버레이)
  const [saveErr, setSaveErr] = useState<string | null>(null) // 저장 실패 — 네이티브 alert 대신 카드로
  // live mirrors so the CM event handlers (built once) always see current values
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  const pathRef = useRef(path)
  pathRef.current = path
  const langRef = useRef(lang) // 한 번 만든 키맵(smartEnter·Mod-/)이 항상 현재 언어를 읽도록
  langRef.current = lang
  const lspRef = useRef(lsp)
  lspRef.current = lsp
  const onNavRef = useRef(onNavigate)
  onNavRef.current = onNavigate
  const mousePtRef = useRef<{ x: number; y: number } | null>(null) // 에디터 위 마지막 마우스 좌표 (F12 대상)
  // 호버 카드 시그니처를 본문과 같은 시맨틱 색으로 칠하기 위한 파일 사전(이름→클래스).
  // sem/structOv가 도착하면 갱신되고, 호버 create()가 ref로 최신값을 읽는다.
  const semDict = useMemo(() => (sem ? buildSemDict(sem, lang, content, structOv) : null), [sem, lang, content, structOv])
  const semDictRef = useRef(semDict)
  semDictRef.current = semDict

  // 파일이 뜨는 즉시 서버에 미리 문서를 열어(didOpen) 인덱싱을 시작 → 타이핑 전에 준비가 끝나,
  // 첫 완성이 빈 목록으로 떠 "몇 번 재시도해야 나오는" 콜드 스타트를 없앤다. LSP 파일일 때만.
  useEffect(() => {
    if (!lsp || !path) return
    void window.api.lsp.warm(cwd, path).catch(() => {})
  }, [lsp, path, cwd])

  // .verse 정확 색칠용 타입 레지스트리(digest+프로젝트의 종류·멤버)를 프로젝트당 1회 가져오고,
  // 도착하면 하이라이트 레이어를 한 번 재구성해 다시 칠한다(추측 대신 사실로 색칠).
  useEffect(() => {
    if (lang === 'verse' && path) void ensureVerseRegistry(cwd, path)
  }, [lang, path, cwd])
  useEffect(() => {
    if (lang !== 'verse') return
    return onVerseRegChange(() => {
      viewRef.current?.dispatch({
        effects: hlCompartment.current.reconfigure(highlighting(lang, semRef.current, structOvRef.current))
      })
    })
  }, [lang])

  // Ctrl+클릭 / F12 → 정의 이동 (CM 좌표 → LSP 좌표 변환 후 onNavigate). 뷰어와 동일하게
  // 포커스와 무관히 동작하도록 컴포넌트 레벨 콜백으로 둔다. 점프 전 캐럿을 클릭 위치로
  // 옮겨, 뒤로가기로 돌아올 때 '호출하던 자리'가 복원되게 한다.
  const runDef = useCallback((offset: number): void => {
    const view = viewRef.current
    if (!view || !lspRef.current) return
    view.dispatch({ selection: { anchor: offset } })
    window.api.lsp
      .definition(cwdRef.current, pathRef.current, toLspPos(view, offset))
      .then((locs) => {
        if (locs?.[0]) onNavRef.current?.(locs[0])
      })
      .catch(() => {})
  }, [])
  const hlCompartment = useRef(new Compartment()) // highlighting(lang, sem, structOv) 교체용
  const diffCompartment = useRef(new Compartment()) // 읽기 모드 readDiffField ↔ 편집 모드 비움
  const editCompartment = useRef(new Compartment()) // editable/readOnly 토글
  const marksRef = useRef(marks) // 빌드 시 최신 marks를 읽기 위한 미러
  marksRef.current = marks
  const readOnlyRef = useRef(readOnly) // 마운트 시 최신 readOnly를 읽기 위한 미러
  readOnlyRef.current = readOnly
  const semRef = useRef(sem) // 빌드 시 최신 sem을 읽기 위한 미러
  semRef.current = sem
  const structOvRef = useRef(structOv)
  structOvRef.current = structOv
  const baselineRef = useRef('') // last-saved text — dirty = current doc differs from this
  const dirtyRef = useRef(false)
  // callbacks via refs so a parent re-render (new inline handlers) never rebuilds the editor
  const onDirtyRef = useRef(onDirtyChange)
  const onSavedRef = useRef(onSaved)
  onDirtyRef.current = onDirtyChange
  onSavedRef.current = onSaved

  const doSave = useCallback(async () => {
    const view = viewRef.current
    if (!view) return
    const text = view.state.doc.toString()
    if (text === baselineRef.current) return
    const r = await window.api.writeFile(cwd, path, text)
    if (r.ok) {
      baselineRef.current = text
      dirtyRef.current = false
      onDirtyRef.current?.(false)
      // diff는 편집 모드에서 꺼져 있고, 읽기 모드로 돌아가면 부모 기준으로 다시 계산되므로
      // 저장 자체는 diff를 건드릴 필요가 없다(부모는 불변 — 내 변경이 초록으로 합쳐져 보임).
      onSavedRef.current?.()
    } else {
      setSaveErr(r.error || '알 수 없는 오류')
    }
  }, [cwd, path])
  const saveRef = useRef(doSave)
  saveRef.current = doSave
  useImperativeHandle(
    ref,
    () => ({
      save: () => void saveRef.current(),
      getCaret: () => viewRef.current?.state.selection.main.head ?? 0,
      openSearch: () => setFindOpen(true), // 검색 바 열기 — 입력은 자동 포커스
      focus: () => viewRef.current?.focus()
    }),
    []
  )

  useEffect(() => {
    const parent = cmParentRef.current
    if (!parent) return
    // normalize CRLF→LF so hljs's `\n` line split and CM's line offsets agree
    const doc = content.replace(/\r\n/g, '\n')
    baselineRef.current = doc
    dirtyRef.current = false
    // 읽기 모드 diff의 기준 = 부모(에이전트 작업 전, marks.oldLines). 마운트 시점 모드/마크로 초기 구성.
    const ro0 = readOnlyRef.current
    const parent0 = marksRef.current?.oldLines ?? []
    // 마우스 호버 → 타입 카드. 뷰어와 동일한 HoverContent를 .lsp-hover 카드에 렌더한다.
    // (CM 툴팁이 body에 떠서 클리핑 안 됨; .cm-tooltip 크롬은 테마에서 투명화)
    const lspHover = hoverTooltip(
      async (v, pos) => {
        if (!lspRef.current) return null
        const r = await window.api.lsp.hover(cwdRef.current, pathRef.current, toLspPos(v, pos)).catch(() => null)
        if (!r || !r.contents) return null
        const md = r.contents
        return {
          pos,
          create: () => {
            const dom = document.createElement('div')
            dom.className = 'lsp-hover cm-lsp-hover' + paletteClassFor(lang)
            const root = createRoot(dom)
            let alive = true
            const draw = (mods?: string[]): void =>
              root.render(<HoverContent md={md} lang={lang} dict={semDictRef.current} extraMods={mods} />)
            draw()
            // C#: OmniSharp 호버엔 접근지시자(public/static…)가 없어 정의 줄을 읽어 ACCESS
            // 행을 보강한다(뷰어 CodeView와 동일). 도착하면 카드를 다시 그린다.
            if (lang === 'csharp') {
              void (async () => {
                const locs = await window.api.lsp
                  .definition(cwdRef.current, pathRef.current, toLspPos(v, pos))
                  .catch(() => null)
                const loc = locs?.[0]
                if (!loc || !alive) return
                const f = await window.api.readFile(cwdRef.current, loc.path).catch(() => null)
                const defLine = f?.content?.split('\n')[loc.line]
                if (!defLine || !alive) return
                const m =
                  /^\s*((?:(?:public|private|protected|internal|static|readonly|virtual|override|sealed|abstract|async|partial|extern|unsafe|required|new|const|event)\s+)+)/.exec(
                    defLine
                  )
                if (!m || !alive) return
                draw([...new Set(m[1].trim().split(/\s+/))])
              })()
            }
            return {
              dom,
              destroy: () => {
                alive = false
                root.unmount()
              }
            }
          }
        }
      },
      { hoverTime: 300 }
    )
    // LSP 자동완성 소스: 현재 CM 버퍼 전체를 같이 보내(미저장 편집·부분 단어 반영) 후보를 받는다.
    // 읽기 모드/LSP 미준비면 끈다. word가 있으면 그 시작에서, 트리거(`.`) 뒤면 캐럿에서 치환.
    const lspComplete = async (ctx: CompletionContext): Promise<CompletionResult | null> => {
      if (!lspRef.current || ctx.state.readOnly) return null
      const word = ctx.matchBefore(/[\w$]+/)
      const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 1), ctx.pos)
      // 자동 발동은 단어 입력 중이거나 트리거 문자 뒤일 때만 — 빈 자리에서 매 입력마다 뜨는 걸 막는다.
      // (Ctrl+Space로 명시 호출하면 ctx.explicit=true라 항상 통과)
      if (!ctx.explicit && !word && before !== '.') return null
      // CM offset → LSP {line, character} (ctx.view는 optional이라 state.doc에서 직접 계산)
      const ln = ctx.state.doc.lineAt(ctx.pos)
      const pos = { line: ln.number - 1, character: ctx.pos - ln.from }
      const list = await window.api.lsp
        .completion(cwdRef.current, pathRef.current, pos, ctx.state.doc.toString())
        .catch(() => null)
      if (!list || !list.items.length) return null
      // verse-lsp 내부 placeholder 정리: 이름 없는 매개변수의 `__dupe___unnamed_parameter_1:t` → `t`
      const clean = (s: string): string => s.replace(/__dupe___unnamed_parameter_\d+\s*:?\s*/g, '')
      // 구조체/클래스는 '이름'(타입)과 '이름 {필드 := …}'(아키타입) 두 항목을 같이 준다 → 같은 이름이
      // 두 번 떠 헷갈린다. 기본 '이름' 항목이 있으면 아키타입({…}) 변형은 버리고, 완전 중복도 정리.
      const bare = new Set(
        list.items.map((it) => splitSig(clean(it.label))).filter((s) => !s.sig.includes('{')).map((s) => s.name)
      )
      const seen = new Set<string>()
      const items = list.items.filter((it) => {
        const label = clean(it.label)
        if (seen.has(label)) return false
        seen.add(label)
        const { name, sig } = splitSig(label)
        return !(sig.includes('{') && bare.has(name))
      })
      const options: Completion[] = items.map((it, i) => {
        // 이름(매칭 대상)과 시그니처를 가른다 — 시그니처는 흐린 detail로
        const label = clean(it.label)
        const { name, sig } = splitSig(label)
        const base: Completion = {
          label: name,
          detail: sig || it.detail || undefined,
          type: complKind(it.kind),
          info: it.documentation || undefined,
          // 서버가 매겨 준 순서(verse-lsp는 관련도순으로 정렬해 보낸다)를 동점일 때의 타이브레이커로
          // 만 쓴다 — 폭을 1 미만으로 좁혀 CM의 접두어 매칭 품질을 뒤엎지 않게 한다.
          boost: -i / 1000
        }
        // 값 매개변수 괄호 '(...)'가 있으면 호출 형태로 — `이름()` + 커서를 괄호 안에(인자 있으면).
        // 타입 매개변수 '[...]'는 보통 추론되니 넣지 않고, 그 외(타입/식별자)는 이름만 삽입한다.
        // 어느 경우든 선언 매개변수 텍스트(name:type)는 박지 않는다.
        const paren = label.indexOf('(')
        if (paren >= 0) {
          const hasParams = !/^\(\s*\)/.test(label.slice(paren))
          return snippetCompletion(hasParams ? `${name}(\${})` : `${name}()`, base)
        }
        return { ...base, apply: name }
      })
      return {
        from: word ? word.from : ctx.pos,
        options,
        // 완전한 목록(isIncomplete=false)일 때만 로컬 필터를 허용 — 단어를 더 쳐도 서버 재요청 없이
        // CM이 거른다(왕복↓·깜빡임↓). 서버가 잘라 보낸 목록(isIncomplete=true)이면 validFor를 빼서
        // 키 입력마다 다시 묻는다 — 안 그러면 잘린 N개 밖의 심볼(예: 멤버가 수백 개일 때)을 영영
        // 못 찾는다. (어느 경우든 단어 경계를 벗어나거나 `.` 트리거면 소스가 다시 돌아 새 목록을 받는다.)
        validFor: list.isIncomplete ? undefined : /^[\w$]*$/
      }
    }
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          closeBrackets(),
          highlightSelectionMatches(),
          indentUnit.of(detectIndentUnit(doc)),
          // Ctrl+S — highest precedence so it always wins over anything below
          keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => (void saveRef.current(), true) }]),
          // 완성 키맵을 Enter/smartEnter보다 위에 — 팝업이 열렸을 때만 Enter·방향키·Esc를 가로채고,
          // 닫혀 있으면 각 핸들러가 false를 반환해 아래 smartEnter/기본 키맵으로 흘러간다. Tab도 수락에
          // 추가(팝업 열림=수락, 닫힘=false → 아래 indentWithTab으로 들여쓰기).
          keymap.of([...completionKeymap, { key: 'Tab', run: acceptCompletion }]),
          keymap.of([
            { key: 'Enter', run: (v) => smartEnter(v, langRef.current) },
            { key: 'Mod-/', run: (v) => toggleLineComment(v, langRef.current), preventDefault: true },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab
          ]),
          bracketMatching(), // 캐럿 옆 괄호와 그 짝을 은은히 강조 (.cm-matchingBracket)
          hlCompartment.current.of(highlighting(lang, semRef.current, structOvRef.current)),
          flashField,
          findField, // Ctrl+F 검색 매치 하이라이트 (CM 기본 패널 대신 .fv-find 오버레이가 구동)
          editCompartment.current.of([EditorView.editable.of(!ro0), EditorState.readOnly.of(ro0)]),
          // 읽기 모드 + diff 있을 때만 표준 diff를 칠한다. diff 없는 파일의 읽기 모드는
          // 그냥 잠긴 뷰어(색 없음) — parent가 비면 전부 초록으로 칠해지는 걸 막는다.
          diffCompartment.current.of(ro0 && marksRef.current ? readDiffField(parent0, lang) : []),
          baseTheme,
          lspHover,
          tooltips({ parent: document.body }),
          EditorView.domEventHandlers({
            mousemove: (e) => {
              mousePtRef.current = { x: e.clientX, y: e.clientY }
              return false
            },
            mousedown: (e, v) => {
              if (!(e.ctrlKey || e.metaKey) || !lspRef.current) return false
              const offset = v.posAtCoords({ x: e.clientX, y: e.clientY })
              if (offset == null) return false
              e.preventDefault()
              runDef(offset)
              return true
            }
          }),
          EditorView.contentAttributes.of({ spellcheck: 'false' }),
          // LSP 자동완성 — 소스는 lspRef/readOnly로 자체 게이트하므로 항상 달아 둬도 안전.
          // 자체 키맵은 끄고(위에서 completionKeymap을 명시 순서로 넣음) 타이핑 중 자동 발동만 둔다.
          autocompletion({ override: [lspComplete], defaultKeymap: false, activateOnTyping: true }),
          // 방금 친 글자가 멤버 트리거(`.`)이거나 식별자 문자면 팝업을 직접 연다. activateOnTyping만으론
          // 파일을 막 연 직후 첫 글자에 팝업이 안 뜨는 경우가 있어(콜드), 명시적으로 발동해 신뢰성을 높인다.
          // (validFor 덕에 단어 도중엔 서버 재요청 없이 로컬 필터만 돌아 비용은 거의 없다.)
          EditorView.updateListener.of((u) => {
            if (!u.docChanged || !lspRef.current || u.state.readOnly) return
            let trigger = false
            u.changes.iterChanges((_fa, _ta, _fb, _tb, ins) => {
              const s = ins.toString()
              if (s === '.' || (s.length === 1 && /[A-Za-z_]/.test(s))) trigger = true
            })
            if (trigger) startCompletion(u.view)
          }),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return
            const dirty = u.state.doc.toString() !== baselineRef.current
            if (dirty !== dirtyRef.current) {
              dirtyRef.current = dirty
              onDirtyRef.current?.(dirty)
            }
          })
        ]
      })
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // rebuild when the file/lang changes (no incremental doc diffing yet)
  }, [content, lang])

  // semantic tokens + C++ struct 보정 arrive async (LSP warm-up / hover probe) — swap
  // the highlighting layer in place via the compartment, so live colors appear without
  // rebuilding (caret/undo kept)
  useEffect(() => {
    viewRef.current?.dispatch({ effects: hlCompartment.current.reconfigure(highlighting(lang, sem, structOv)) })
  }, [sem, structOv, lang])

  // 읽기/편집 모드 토글 + diff 갱신. 읽기 모드면 편집을 잠그고 "현재 vs 부모" 표준 diff를
  // 칠하고(readDiffField.create가 현재 doc으로 즉시 계산), 편집 모드면 편집을 풀고 diff를 끈다.
  // 부모(marks.oldLines)는 불변이라 편집·저장 뒤 읽기로 돌아와도 diff가 안 깨진다.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const parent = marks?.oldLines ?? []
    view.dispatch({
      effects: [
        editCompartment.current.reconfigure([EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly)]),
        diffCompartment.current.reconfigure(readOnly && marks ? readDiffField(parent, lang) : [])
      ]
    })
    if (!readOnly) view.focus() // 편집 모드 진입 → 바로 타이핑되도록 포커스
  }, [readOnly, marks, lang])

  // 오버뷰 룰러는 스크롤이 있을 때만 의미 — 스크롤 가능 여부를 재서 표시 토글
  useEffect(() => {
    const view = viewRef.current
    if (!view) {
      setRulerOn(false)
      return
    }
    const sc = view.scrollDOM
    const measure = (): void => setRulerOn(sc.scrollHeight > sc.clientHeight + 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(sc)
    return () => ro.disconnect()
  }, [content, zoom, marks])

  // offset으로 스크롤(가운데) + 캐럿 + 깜빡임. ★재마운트 직후 CM의 동기 초기 측정은
  // 브라우저 레이아웃 전이라 높이가 0 → 즉시 스크롤하면 맨 위로 계산된다. 다음 프레임
  // (CM이 실제 측정을 끝낸 뒤)으로 미뤄야 다른 파일 점프·뒤로가기에서도 정확히 스크롤된다.
  // (같은 파일 점프는 재마운트가 없어 즉시도 됐던 것.)
  // flash=true면 도착 줄을 잠깐 강조(정의 점프용). 뒤로/앞으로의 캐럿 복원은 flash=false로
  // 조용히 — 깜빡임은 "방금 점프해 왔다"는 신호라, 되돌아오기엔 오히려 거슬리고 위치도 헷갈린다.
  const scrollTo = useCallback((view: EditorView, offset: number, focus: boolean, flash = true): (() => void) => {
    const p = Math.min(Math.max(offset, 0), view.state.doc.length)
    let timer = 0
    const raf = requestAnimationFrame(() => {
      if (viewRef.current !== view) return
      view.dispatch({
        selection: { anchor: p },
        effects: flash
          ? [EditorView.scrollIntoView(p, { y: 'center' }), flashEffect.of(view.state.doc.lineAt(p).from)]
          : [EditorView.scrollIntoView(p, { y: 'center' })]
      })
      if (focus) view.focus()
      if (flash)
        timer = window.setTimeout(() => {
          if (viewRef.current === view) view.dispatch({ effects: flashEffect.of(null) })
        }, 1500)
    })
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
    }
  }, [])

  // 뒤로/앞으로로 (재)마운트된 파일 → 저장해둔 캐럿 위치로 조용히 복원(flash 없음). (막 점프해
  // 온 경우엔 아래 jump 이펙트가 도착 줄로 덮어쓰며 깜빡인다.)
  useEffect(() => {
    const view = viewRef.current
    if (!view || initialPos == null) return
    return scrollTo(view, initialPos, false, false)
    // 파일이 바뀔 때(=재마운트)마다 1회. initialPos는 마운트 시점 값.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content])

  // definition jump (same-file 또는 갓 마운트된 대상 파일) → 도착 줄로 스크롤·강조
  useEffect(() => {
    const view = viewRef.current
    if (!view || !jump) return
    const ln = Math.max(1, Math.min(jump.line, view.state.doc.lines))
    return scrollTo(view, view.state.doc.line(ln).from, true)
  }, [jump, scrollTo])

  // F12 → 정의 이동. 뷰어처럼 전역으로 받아 포커스와 무관하게 동작: 에디터 위에 마우스가
  // 있으면 그 심볼, 아니면 캐럿 위치를 대상으로 한다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'F12' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      const view = viewRef.current
      if (!view || !lspRef.current) return
      let offset: number | null = null
      const pt = mousePtRef.current
      if (pt) {
        const el = document.elementFromPoint(pt.x, pt.y)
        if (el && view.dom.contains(el)) offset = view.posAtCoords({ x: pt.x, y: pt.y })
      }
      if (offset == null && view.hasFocus) offset = view.state.selection.main.head
      if (offset == null) return
      e.preventDefault()
      runDef(offset)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [runDef])

  // Ctrl/⌘ 누르고 있는 동안 포인터 커서(정의 이동 모드) — 뷰어의 .lsp-ctrl와 동일
  useEffect(() => {
    if (!lsp) return
    const host = hostRef.current
    const set = (on: boolean): void => {
      host?.classList.toggle('lsp-ctrl', on)
    }
    const down = (e: KeyboardEvent): void => {
      if (e.key === 'Control' || e.key === 'Meta') set(true)
    }
    const up = (e: KeyboardEvent): void => {
      if (e.key === 'Control' || e.key === 'Meta') set(false)
    }
    const blur = (): void => set(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      set(false)
    }
  }, [lsp])

  // zoom changes font-size via the CSS var → tell CM to re-measure line geometry
  useEffect(() => {
    viewRef.current?.requestMeasure()
  }, [zoom])

  return (
    <div
      className={'cm-host hljs' + paletteClassFor(lang) + (readOnly ? ' mode-read' : ' mode-edit')}
      ref={hostRef}
      style={{ ['--cm-fs']: (12.5 * zoom).toFixed(2) + 'px' } as CSSProperties}
    >
      <div className="cm-mount" ref={cmParentRef} />
      {findOpen && viewRef.current && (
        <CmFindBar
          view={viewRef.current}
          onClose={() => {
            viewRef.current?.dispatch({ effects: setFindHits.of(null) })
            setFindOpen(false)
            viewRef.current?.focus()
          }}
        />
      )}
      {readOnly && marks && rulerOn && marks.blocks.length > 0 && (
        <div className="diff-ruler">
          {marks.blocks.map((b, i) => (
            <button
              key={i}
              className={'mark ' + b.type}
              style={{
                top: `${((Math.min(b.start, marks.newCount) - 1) / marks.newCount) * 100}%`,
                height: `${((b.end - b.start + 1) / marks.newCount) * 100}%`
              }}
              onClick={() => {
                const v = viewRef.current
                if (!v) return
                const ln = Math.max(1, Math.min(b.start, v.state.doc.lines))
                v.dispatch({ effects: EditorView.scrollIntoView(v.state.doc.line(ln).from, { y: 'center' }) })
              }}
              aria-label={`${b.start}번째 줄 변경으로 이동`}
            />
          ))}
        </div>
      )}
      {saveErr && (
        <SaveErrorDialog
          message={saveErr}
          onClose={() => {
            setSaveErr(null)
            viewRef.current?.focus() // 편집기로 포커스 복귀 — 다시 저장 시도하거나 이어서 편집
          }}
        />
      )}
    </div>
  )
})

// 저장 실패를 알리는 카드(네이티브 alert 대체) — 스레드를 막지 않아 IME가 엉키지 않고, 앱의
// .set-dialog 언어와도 맞는다. body로 포털해 .cm-host의 클리핑/스태킹을 벗어난다. Esc·Enter·
// 확인·백드롭 모두 닫기. capture+stopPropagation으로 뷰어의 Esc 핸들러가 먼저 닫는 일을 막는다.
function SaveErrorDialog({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return createPortal(
    <div className="set-dialog-overlay" onMouseDown={onClose}>
      <div className="set-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sd-ic">
          <IconAlert size={22} />
        </div>
        <div className="sd-title">저장하지 못했어요</div>
        <div className="sd-msg">{message}</div>
        <div className="sd-btns">
          <button className="sd-go" onClick={onClose} autoFocus>
            확인
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// 파일 내 검색 바 — 비-CM FindBar와 같은 .fv-find 디자인을 CM 문서·하이라이트에 맞춰 구동.
// 매치는 직접 계산(computeMatches)해 findField로 칠하고, 현재 매치로 스크롤만 한다(캐럿은
// 안 건드려 selectionMatch와 안 겹침). Esc는 포커스와 무관히 모달 닫힘보다 먼저 바를 닫는다.
function CmFindBar({ view, onClose }: { view: EditorView; onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [cur, setCur] = useState(0)
  const [total, setTotal] = useState(0)
  const rangesRef = useRef<{ from: number; to: number }[]>([])

  // 매치를 칠하고 현재 매치로 스크롤(캐럿은 안 건드림 → selectionMatch와 안 겹침)
  const show = (ranges: { from: number; to: number }[], idx: number): void => {
    if (!ranges.length) {
      view.dispatch({ effects: setFindHits.of(null) })
      return
    }
    view.dispatch({ effects: [setFindHits.of({ ranges, cur: idx }), EditorView.scrollIntoView(ranges[idx].from, { y: 'center' })] })
  }

  // 쿼리 변경 → 매치 재계산 + 캐럿 이후 첫 매치로 (한 번만 dispatch)
  useEffect(() => {
    const ranges = computeMatches(view, query)
    rangesRef.current = ranges
    setTotal(ranges.length)
    let idx = 0
    if (ranges.length) {
      const head = view.state.selection.main.from
      const found = ranges.findIndex((r) => r.from >= head)
      idx = found < 0 ? 0 : found
    }
    setCur(idx)
    show(ranges, idx)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, view])

  // Esc = 모달 닫힘보다 먼저 검색 바부터 닫기(capture+stop). Ctrl+F 재입력 시 입력 재선택.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const step = (d: number): void => {
    const ranges = rangesRef.current
    if (!ranges.length) return
    const next = (cur + d + ranges.length) % ranges.length
    setCur(next)
    show(ranges, next)
  }

  return (
    <div className="fv-find cm-find">
      <IconSearch size={13} />
      <input
        ref={inputRef}
        autoFocus
        value={query}
        placeholder="파일 내 검색…"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            step(e.shiftKey ? -1 : 1)
          }
        }}
      />
      <span className="cnt">{total ? `${cur + 1}/${total}` : query ? '0개' : ''}</span>
      <button className="has-tip" data-tip="이전 (Shift+Enter)" aria-label="이전 결과" onClick={() => step(-1)} disabled={!total}>
        <IconChevDown size={14} style={{ transform: 'rotate(180deg)' }} />
      </button>
      <button className="has-tip" data-tip="다음 (Enter)" aria-label="다음 결과" onClick={() => step(1)} disabled={!total}>
        <IconChevDown size={14} />
      </button>
      <button className="has-tip" data-tip="닫기 (Esc)" aria-label="검색 닫기" onClick={onClose}>
        <IconClose size={14} />
      </button>
    </div>
  )
}
