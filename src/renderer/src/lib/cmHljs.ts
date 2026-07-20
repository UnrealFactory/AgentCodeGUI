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

interface LineSpan {
  from: number // 줄 시작 기준 상대 오프셋 (디코드된 원문 문자 수)
  to: number
  cls: string
}

// 줄 HTML → span 파스 결과 캐시. 재색칠 사이 대부분의 줄은 hljs 출력이 같은 문자열이라
// (편집된 줄·토큰이 걸친 줄만 달라짐) 파스를 통째로 건너뛴다. 예산은 키(html) 길이 합.
const LINE_CACHE_BUDGET = 3_000_000
const lineCache = new Map<string, LineSpan[]>()
let lineCacheTotal = 0

const LINE_TOKEN_RE = /<span[^>]*>|<\/span>|&[^;]{1,8};|[^<&]+/g
const CLASS_RE = /class="([^"]*)"/

// One line's hljs HTML → mark ranges (line-relative offsets). 예전엔 detached div의
// innerHTML로 DOM 파싱했지만(줄마다 노드 생성 — 재색칠 비용의 큰 몫), highlightToLines가
// 줄 안 태그 균형을 보장하고 hljs 출력엔 <span class="…">·</span>·엔티티(&amp; 류 — 전부
// 1문자로 디코드됨)·텍스트뿐이라 문자열 스캐너로 동일 결과가 나온다. 원문 '&'는 항상
// &amp;로 이스케이프돼 있어 '&'는 엔티티 시작으로만, '<'는 태그 시작으로만 나타난다.
// 중첩 span은 안쪽이 먼저 닫혀 먼저 push된다(DOM 후위 순회와 같은 순서 — Decoration.set
// 정렬이 최종 순서를 잡는다). 반환 배열은 캐시 공유본 — 수정 금지.
function parseLine(html: string): LineSpan[] {
  const hit = lineCache.get(html)
  if (hit !== undefined) {
    lineCache.delete(html)
    lineCache.set(html, hit) // LRU 갱신
    return hit
  }
  const out: LineSpan[] = []
  const stack: { cls: string; start: number }[] = []
  let pos = 0
  LINE_TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LINE_TOKEN_RE.exec(html))) {
    const t = m[0]
    const c0 = t.charCodeAt(0)
    if (c0 === 60 /* '<' */) {
      if (t === '</span>') {
        const top = stack.pop()
        if (top && top.cls && pos > top.start) out.push({ from: top.start, to: pos, cls: top.cls })
      } else stack.push({ cls: CLASS_RE.exec(t)?.[1] ?? '', start: pos })
    } else if (c0 === 38 /* '&' */) pos += 1
    else pos += t.length
  }
  // 닫히지 않은 열림은 이론상 없다(highlightToLines가 줄 끝에서 닫는다) — 방어적으로 줄 끝까지
  for (const top of stack) if (top.cls && pos > top.start) out.push({ from: top.start, to: pos, cls: top.cls })
  lineCache.set(html, out)
  lineCacheTotal += html.length
  while (lineCacheTotal > LINE_CACHE_BUDGET && lineCache.size > 1) {
    const oldest = lineCache.keys().next().value!
    lineCacheTotal -= oldest.length
    lineCache.delete(oldest)
  }
  return out
}

// past this size the whole-file re-highlight (see `highlighting` below) takes long
// enough to hang the frame — the editor then runs uncolored but responsive. 뷰어의
// HL_LIMIT와 같은 값으로 묶는다(읽기/편집 전환 시 색 유무가 일치하게).
const CM_HL_MAX = 200_000

export function buildDeco(
  view: EditorView,
  lang: string,
  sem: LspSemanticTokens | null,
  structOv: StructOv | null
): DecorationSet {
  const doc = view.state.doc
  if (doc.length > CM_HL_MAX) return Decoration.none
  const text = doc.toString()
  const marks: Range<Decoration>[] = []
  // hljs base marks are made inclusive (startSide < 0) so they sort as the OUTER span;
  // sem marks are exclusive (default) → inner span. For a coinciding range the sem
  // span is therefore the innermost element, so its `.sem-*` color wins over hljs.
  // store=false — 편집 중간 버전을 하이라이트 LRU에 넣지 않는다(캐시 오염 방지).
  const lines = highlightToLines(text, lang, false)
  const n = Math.min(lines.length, doc.lines)
  for (let i = 0; i < n; i++) {
    const base = doc.line(i + 1).from
    for (const s of parseLine(lines[i])) {
      const from = base + s.from
      const to = base + s.to
      // clamp: an out-of-range decoration makes CodeMirror throw during render (the sem
      // marks below already guard this way; recolorVerse could in theory drift lengths)
      if (to > doc.length || to <= from) continue
      marks.push(Decoration.mark({ class: s.cls, inclusiveStart: true, inclusiveEnd: true }).range(from, to))
    }
  }
  const byLine = sem ? semByLine(sem, lang, structOv, text) : null
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

// 이 크기 이하 문서는 키 입력마다 동기로 전체 재색칠한다(수 ms — 새 글자에 색이 즉시).
// 넘으면 hljs 전체 실행(150k자 ≈ 40ms 실측)이 키 입력마다 프레임을 걸어 타이핑이 밀리므로,
// 기존 데코를 편집 위치에 맞춰 이동만 하고(값싼 map) 타이핑이 REBUILD_QUIET_MS 조용해진 뒤
// 한 번 재색칠한다 — 갓 친 글자만 잠깐 무색이고 기존 색은 텍스트를 그대로 따라간다.
const SYNC_REBUILD_MAX = 24_000
const REBUILD_QUIET_MS = 120

// Whole-document recolor — synchronous per keystroke for small docs, quiet-debounced for
// large ones (above). `sem` is captured per configuration — reconfigure the hosting
// compartment when new semantic tokens arrive.
export function highlighting(lang: string, sem: LspSemanticTokens | null, structOv: StructOv | null) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      private timer = 0
      constructor(readonly view: EditorView) {
        this.decorations = buildDeco(view, lang, sem, structOv)
      }
      update(u: ViewUpdate): void {
        if (!u.docChanged) return
        if (u.state.doc.length <= SYNC_REBUILD_MAX) {
          this.decorations = buildDeco(u.view, lang, sem, structOv)
          return
        }
        this.decorations = this.decorations.map(u.changes)
        window.clearTimeout(this.timer)
        this.timer = window.setTimeout(() => {
          this.decorations = buildDeco(this.view, lang, sem, structOv)
          this.view.dispatch({}) // 빈 트랜잭션 — 뷰가 플러그인 데코를 다시 읽게
        }, REBUILD_QUIET_MS)
      }
      destroy(): void {
        window.clearTimeout(this.timer)
      }
    },
    { decorations: (v) => v.decorations }
  )
}
