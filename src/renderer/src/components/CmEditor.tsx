import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, type CSSProperties } from 'react'
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
  type DecorationSet,
  type Command
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { indentUnit } from '@codemirror/language'
import type { LspSemanticTokens, LspLocation } from '@shared/protocol'
import { highlighting } from '../lib/cmHljs'
import type { StructOv } from '../lib/semTokens'
import { paletteClassFor } from './fileType'
import { HoverContent } from './FileModal'

export interface CmEditorHandle {
  save: () => void
  getCaret: () => number // 현재 캐럿 offset — 정의 이동 시 호출 위치 저장용
}

const PAIR: Record<string, string> = { '{': '}', '[': ']', '(': ')' }

// CM document offset → LSP 0-based {line, character}
function toLspPos(view: EditorView, offset: number): { line: number; character: number } {
  const line = view.state.doc.lineAt(offset)
  return { line: line.number - 1, character: offset - line.from }
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

// Language-agnostic smart Enter — works for every language without a CM grammar:
// continue the current line's indentation, add one level after an opening bracket,
// and when the caret sits between a freshly-typed pair ( {| } ) split it onto three
// lines with the caret indented on the middle one (the IDE-classic).
const smartEnter: Command = (view) => {
  const { state } = view
  const sel = state.selection.main
  if (sel.from !== sel.to) return false // let the default handle ranged selections
  const line = state.doc.lineAt(sel.from)
  const indent = /^[ \t]*/.exec(line.text)![0]
  const unit = state.facet(indentUnit)
  const opener = state.doc.sliceString(line.from, sel.from).replace(/\s+$/, '').slice(-1)
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
  const newIndent = opensBlock ? indent + unit : indent
  view.dispatch({
    changes: { from: sel.from, insert: '\n' + newIndent },
    selection: { anchor: sel.from + 1 + newIndent.length },
    scrollIntoView: true,
    userEvent: 'input'
  })
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
    zoom?: number // Ctrl+휠 배율 (1 = 100%) — 폰트 크기로 환산해 적용
    lsp?: boolean // 언어 서버 준비됨 → hover·정의 이동 활성화
    jump?: { line: number; tick: number } | null // 정의 이동 도착 줄 (1-based) → 스크롤
    initialPos?: number // 마운트 시 복원할 캐럿 offset (뒤로가기로 돌아온 파일의 호출 위치)
    onNavigate?: (loc: LspLocation) => void // 정의 이동 (같은 파일=jump, 다른 파일=스택)
    onDirtyChange?: (dirty: boolean) => void
    onSaved?: () => void
  }
>(function CmEditor(
  { content, lang, path, cwd, sem = null, structOv = null, zoom = 1, lsp = false, jump = null, initialPos, onNavigate, onDirtyChange, onSaved },
  ref
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // live mirrors so the CM event handlers (built once) always see current values
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  const pathRef = useRef(path)
  pathRef.current = path
  const lspRef = useRef(lsp)
  lspRef.current = lsp
  const onNavRef = useRef(onNavigate)
  onNavRef.current = onNavigate
  const mousePtRef = useRef<{ x: number; y: number } | null>(null) // 에디터 위 마지막 마우스 좌표 (F12 대상)

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
      onSavedRef.current?.()
    } else {
      window.alert('저장 실패: ' + (r.error || '알 수 없는 오류'))
    }
  }, [cwd, path])
  const saveRef = useRef(doSave)
  saveRef.current = doSave
  useImperativeHandle(
    ref,
    () => ({ save: () => void saveRef.current(), getCaret: () => viewRef.current?.state.selection.main.head ?? 0 }),
    []
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    // normalize CRLF→LF so hljs's `\n` line split and CM's line offsets agree
    const doc = content.replace(/\r\n/g, '\n')
    baselineRef.current = doc
    dirtyRef.current = false
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
            root.render(<HoverContent md={md} lang={lang} dict={null} />)
            return { dom, destroy: () => root.unmount() }
          }
        }
      },
      { hoverTime: 300 }
    )
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          closeBrackets(),
          indentUnit.of(detectIndentUnit(doc)),
          // Ctrl+S — highest precedence so it always wins over anything below
          keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => (void saveRef.current(), true) }]),
          keymap.of([
            { key: 'Enter', run: smartEnter },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab
          ]),
          hlCompartment.current.of(highlighting(lang, semRef.current, structOvRef.current)),
          flashField,
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

  // offset으로 스크롤(가운데) + 캐럿 + 깜빡임. ★재마운트 직후 CM의 동기 초기 측정은
  // 브라우저 레이아웃 전이라 높이가 0 → 즉시 스크롤하면 맨 위로 계산된다. 다음 프레임
  // (CM이 실제 측정을 끝낸 뒤)으로 미뤄야 다른 파일 점프·뒤로가기에서도 정확히 스크롤된다.
  // (같은 파일 점프는 재마운트가 없어 즉시도 됐던 것.)
  const scrollTo = useCallback((view: EditorView, offset: number, focus: boolean): (() => void) => {
    const p = Math.min(Math.max(offset, 0), view.state.doc.length)
    let timer = 0
    const raf = requestAnimationFrame(() => {
      if (viewRef.current !== view) return
      view.dispatch({
        selection: { anchor: p },
        effects: [EditorView.scrollIntoView(p, { y: 'center' }), flashEffect.of(view.state.doc.lineAt(p).from)]
      })
      if (focus) view.focus()
      timer = window.setTimeout(() => {
        if (viewRef.current === view) view.dispatch({ effects: flashEffect.of(null) })
      }, 1500)
    })
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
    }
  }, [])

  // 뒤로가기로 (재)마운트된 파일 → 저장해둔 캐럿 위치로 복원. (막 점프해 온 경우엔 아래
  // jump 이펙트가 도착 줄로 덮어쓴다.)
  useEffect(() => {
    const view = viewRef.current
    if (!view || initialPos == null) return
    return scrollTo(view, initialPos, false)
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
      className={'cm-host hljs' + paletteClassFor(lang)}
      ref={hostRef}
      style={{ ['--cm-fs']: (12.5 * zoom).toFixed(2) + 'px' } as CSSProperties}
    />
  )
})
