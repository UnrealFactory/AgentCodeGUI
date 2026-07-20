import { EditorView, Decoration, WidgetType, type DecorationSet } from '@codemirror/view'
import { StateField, type EditorState, type Range } from '@codemirror/state'
import type { FileDiff } from '@shared/protocol'
import { diffLineOps } from '@shared/lineDiff'
import { highlightCode } from './highlight'

// ── changed-file decorations (diff painted onto the live file) ───────────────
// The agent's cumulative whole-file diff (run baseline → current) mapped onto the
// real file: which current-file lines were added, and the boundaries where lines
// were deleted. Shared by the read-only viewer (FileModal) and the CM editor.
export interface DiffMarks {
  added: Set<number> // 1-based current-file line numbers introduced by this run
  delAfter: Set<number> // a deletion sits between line n and n+1 (0 = before line 1)
  // 삭제된 줄의 원문 — 경계(새 파일 기준 줄 번호) 자리에 빨간 고스트 줄로 렌더된다.
  // n은 옛(old-side) 줄 번호: 사라진 코드가 원래 몇 번째 줄이었는지 거터에 보여준다.
  ghosts: Map<number, { n: number; text: string }[]>
  blocks: { start: number; end: number; type: 'add' | 'del' | 'mix' }[] // overview-ruler runs
  newCount: number // new-side line total
  // 부모(에이전트 작업 전, old-side) 전체 줄 — del+ctx로 복원. 읽기 모드 표준 diff의 기준이며,
  // 저장·재열기로 디스크가 바뀌어도 이 기준은 안 변하므로 "현재파일 vs 부모" diff가 안 깨진다.
  oldLines: string[]
}

export function diffMarksOf(diff: FileDiff): DiffMarks {
  const added = new Set<number>()
  const delAfter = new Set<number>()
  const ghosts = new Map<number, { n: number; text: string }[]>()
  const blocks: DiffMarks['blocks'] = []
  const oldLines: string[] = []
  // 지금 엔진은 diff 라인을 LF로 정규화해 보내지만, 구(舊) 세션 스냅샷의 diff는 CRLF
  // 파일이면 텍스트 끝에 '\r'이 남아 있다 — 부모 복원(oldLines)이 LF 문서와 전 줄
  // 불일치(=전체변경으로 칠해짐)가 되지 않게 여기서 한 번 벗긴다. 고스트 표시도 동일.
  const clean = (s: string): string => (s.endsWith('\r') ? s.slice(0, -1) : s)
  const mark = (line: number, type: 'add' | 'del'): void => {
    const last = blocks[blocks.length - 1]
    if (last && line - last.end <= 1) {
      last.end = Math.max(last.end, line)
      if (last.type !== type) last.type = 'mix'
    } else blocks.push({ start: line, end: line, type })
  }
  let ln = 0
  let oldLn = 0
  for (const l of diff.lines) {
    if (l.t === 'hunk') continue
    if (l.t === 'del') {
      oldLn++
      oldLines.push(clean(l.text)) // del = old-side 줄
      delAfter.add(ln)
      let arr = ghosts.get(ln)
      if (!arr) ghosts.set(ln, (arr = []))
      arr.push({ n: oldLn, text: clean(l.text) })
      mark(ln + 1, 'del') // ruler mark above line ln+1 (below the last line when at EOF)
      continue
    }
    ln++
    if (l.t === 'add') {
      added.add(ln)
      mark(ln, 'add')
    } else {
      oldLn++
      oldLines.push(clean(l.text)) // ctx = old-side 줄이기도 하다
    }
  }
  return { added, delAfter, ghosts, blocks, newCount: ln, oldLines }
}

// ── CodeMirror diff decorations ──────────────────────────────────────────────
// Deleted lines render as a block widget between lines — a red "ghost" showing the
// removed source (syntax-highlighted; colors inherit from the host's hljs/palette
// classes) with the old line number in a faux-gutter. Display-only (events ignored).
// 한 삭제 블록에서 실제로 그리는 최대 행 수. 블록 위젯은 뷰포트 가상화가 안 되어 행 전부를
// 즉시 DOM+하이라이트로 만든다 — 수만 줄 통재작성 파일의 고스트가 렌더러를 헹시키지 않게
// 앞부분만 그리고 나머지는 개수 요약 한 줄로 접는다.
const MAX_GHOST_ROWS = 300
class GhostWidget extends WidgetType {
  readonly key: string
  constructor(
    private readonly gs: { n: number; text: string }[],
    private readonly lang: string
  ) {
    super()
    this.key = gs.map((g) => g.n + ':' + g.text).join('\n')
  }
  eq(other: GhostWidget): boolean {
    return other.key === this.key
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-ghost'
    for (const g of this.gs.slice(0, MAX_GHOST_ROWS)) {
      // 삭제 줄 = 본문 코드 줄과 같은 패딩으로 렌더 → 삭제 코드가 실제 코드와 정확히 정렬.
      // (CM 블록 위젯은 거터 칸을 못 만들어 옛 줄번호는 거터에 못 넣는다 — 생략)
      const row = document.createElement('div')
      row.className = 'cm-ghost-row'
      if (this.lang) row.innerHTML = highlightCode(g.text || ' ', this.lang)
      else row.textContent = g.text || ' '
      wrap.appendChild(row)
    }
    if (this.gs.length > MAX_GHOST_ROWS) {
      const more = document.createElement('div')
      more.className = 'cm-ghost-row'
      more.textContent = `… 외 ${(this.gs.length - MAX_GHOST_ROWS).toLocaleString()}줄 삭제`
      wrap.appendChild(more)
    }
    return wrap
  }
  ignoreEvent(): boolean {
    return true
  }
}

// ── 표준 라인 diff (부모 a ↔ 현재 b) ─────────────────────────────────────────
// 코어는 shared/lineDiff의 Myers(엔진 diff와 같은 구현): 비용이 실제 변경량 D에 비례해
// 큰 파일의 먼 두 곳 수정도 정확히 그 줄만 나오고, 수정 묶음은 "🔴 옛거(위) → 🟢 새거
// (아래)" 순서(del 전부 → add 전부)가 계약으로 보장된다. 상한(D 2000·스텝 예산) 초과는
// 전부 삭제+전부 추가 폴백 — 그 규모로 진짜 바뀐 문서의 정직한 표시.

// 읽기 모드 데코 — "현재 파일(C) vs 부모(parent)" 표준 diff. 추가/변경된 C 줄 = 초록,
// 삭제된 부모 줄 = 그 자리 빨강 고스트 블록. 기준이 부모(불변)라 저장·재열기에도 안 깨진다.
const addLine = Decoration.line({ class: 'cm-dadd' })
function buildReadDiff(state: EditorState, parent: string[], lang: string): DecorationSet {
  const doc = state.doc
  const cLines = doc.toString().split('\n')
  let pLines = parent
  // CM은 끝의 개행을 빈 줄로 들고 있다 — C 끝에만 빈 줄이 있으면 부모에도 맞춰 헛 diff 방지
  if (cLines.length && cLines[cLines.length - 1] === '' && (pLines.length === 0 || pLines[pLines.length - 1] !== ''))
    pLines = [...pLines, '']
  const ops = diffLineOps(pLines, cLines)
  const ranges: Range<Decoration>[] = []
  let curLine = 0 // 지금까지 낸 현재(C) 줄 수
  let pendingDel: { n: number; text: string }[] = []
  const flushDel = (): void => {
    if (!pendingDel.length) return
    const pos = curLine <= 0 ? 0 : doc.line(Math.min(curLine, doc.lines)).to
    ranges.push(Decoration.widget({ widget: new GhostWidget(pendingDel, lang), block: true, side: curLine <= 0 ? -1 : 1 }).range(pos))
    pendingDel = []
  }
  for (const op of ops) {
    if (op.t === 'del') pendingDel.push({ n: op.ai + 1, text: pLines[op.ai] })
    else {
      flushDel() // 삭제 묶음은 앞 줄과 다음 줄 사이에 끼운다
      curLine++
      if (op.t === 'add' && curLine <= doc.lines) ranges.push(addLine.range(doc.line(curLine).from))
    }
  }
  flushDel() // 파일 끝 삭제
  return Decoration.set(ranges, true)
}

// 읽기 모드 전용 diff 필드. parent(부모) 기준으로 현재 문서를 표준 diff로 칠한다. 읽기 모드는
// 읽기 전용이라 보통 create()로 끝나지만, 안전하게 docChanged에도 다시 계산한다.
export function readDiffField(parent: string[], lang: string): StateField<DecorationSet> {
  return StateField.define<DecorationSet>({
    create: (state) => buildReadDiff(state, parent, lang),
    update: (deco, tr) => (tr.docChanged ? buildReadDiff(tr.state, parent, lang) : deco),
    provide: (f) => EditorView.decorations.from(f)
  })
}
