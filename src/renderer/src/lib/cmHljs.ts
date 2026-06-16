import { EditorView, Decoration, type DecorationSet, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import type { Range } from '@codemirror/state'
import type { LspSemanticTokens } from '@shared/protocol'
import { highlightToLines } from './highlight'
import { semByLine, type StructOv } from './semTokens'

// ── highlight.js (+ LSP semantic) → CodeMirror decorations ───────────────────
// CodeMirror's own (Lezer) highlighter classifies tokens differently than hljs, so
// to match the read-only viewer's colors EXACTLY we don't use it at all. Instead we
// run the same highlightToLines() the viewer uses and re-express its `.hljs-*` token
// <span>s as CM mark decorations, then overlay the LSP semantic tokens as `.sem-*`
// marks on top. The CM host carries the `hljs` (+ palette) class, so the app's
// existing `.hljs .hljs-*` and `.sem-*` CSS paints these verbatim.

// One line's hljs HTML → mark ranges (doc offsets). One mark per <span> element over
// its full text span with that element's class(es); nested hljs spans → nested marks,
// so the innermost color wins exactly as in the viewer's raw-HTML <pre>.
function lineMarks(html: string, base: number, out: { from: number; to: number; cls: string }[]): void {
  const root = document.createElement('div')
  root.innerHTML = html
  let pos = 0
  const walk = (node: Node): void => {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === Node.TEXT_NODE) {
        pos += (c.textContent || '').length
      } else if (c.nodeType === Node.ELEMENT_NODE) {
        const el = c as HTMLElement
        const start = pos
        walk(el)
        if (el.className && pos > start) out.push({ from: base + start, to: base + pos, cls: el.className })
      }
    }
  }
  walk(root)
}

export function buildDeco(
  view: EditorView,
  lang: string,
  sem: LspSemanticTokens | null,
  structOv: StructOv | null
): DecorationSet {
  const doc = view.state.doc
  const marks: Range<Decoration>[] = []
  // hljs base marks are made inclusive (startSide < 0) so they sort as the OUTER span;
  // sem marks are exclusive (default) → inner span. For a coinciding range the sem
  // span is therefore the innermost element, so its `.sem-*` color wins over hljs.
  const hljsRaw: { from: number; to: number; cls: string }[] = []
  const lines = highlightToLines(doc.toString(), lang)
  const n = Math.min(lines.length, doc.lines)
  for (let i = 0; i < n; i++) lineMarks(lines[i], doc.line(i + 1).from, hljsRaw)
  for (const m of hljsRaw) {
    marks.push(Decoration.mark({ class: m.cls, inclusiveStart: true, inclusiveEnd: true }).range(m.from, m.to))
  }
  const byLine = sem ? semByLine(sem, lang, structOv, doc.toString()) : null
  if (byLine) {
    for (const [lineIdx, spans] of byLine) {
      if (lineIdx + 1 > doc.lines) continue
      const lineStart = doc.line(lineIdx + 1).from
      for (const s of spans) {
        const from = lineStart + s.char
        const to = from + s.len
        if (to > from && to <= doc.length) marks.push(Decoration.mark({ class: s.cls }).range(from, to))
      }
    }
  }
  return Decoration.set(marks, true) // sort by from/startSide — hljs(outer) before sem(inner)
}

// Whole-document recolor on every edit. For a PoC this is fine (the viewer already
// highlights the whole file on open). `sem` is captured per configuration — reconfigure
// the hosting compartment when new semantic tokens arrive.
export function highlighting(lang: string, sem: LspSemanticTokens | null, structOv: StructOv | null) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = buildDeco(view, lang, sem, structOv)
      }
      update(u: ViewUpdate): void {
        if (u.docChanged) this.decorations = buildDeco(u.view, lang, sem, structOv)
      }
    },
    { decorations: (v) => v.decorations }
  )
}
