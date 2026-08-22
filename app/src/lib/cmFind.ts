import { EditorView, Decoration, type DecorationSet } from '@codemirror/view'
import { StateField, StateEffect, type Range } from '@codemirror/state'

// 파일 내 검색(Ctrl+F) 매치 하이라이트. CM 기본 검색 패널(어수선하고 우리 톤과 안 맞음)
// 대신, 우리 디자인의 .fv-find 바(React 오버레이)가 매치를 계산해 이 필드로 칠한다.
// 전체 매치 = .cm-find-hit(은은), 현재 매치 = .cm-find-cur(또렷).
export type FindHits = { ranges: { from: number; to: number }[]; cur: number } | null
export const setFindHits = StateEffect.define<FindHits>()
const hitMark = Decoration.mark({ class: 'cm-find-hit' })
const curMark = Decoration.mark({ class: 'cm-find-cur' })
export const findField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes) // 편집 따라 하이라이트도 이동
    for (const e of tr.effects)
      if (e.is(setFindHits)) {
        if (!e.value) return Decoration.none
        const { ranges, cur } = e.value
        const out: Range<Decoration>[] = []
        ranges.forEach((r, i) => {
          if (r.from < r.to) out.push((i === cur ? curMark : hitMark).range(r.from, r.to))
        })
        deco = Decoration.set(out, true)
      }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f)
})

// 검색마다 문서 전체(최대 1.5MB)를 소문자 복사하면 키 입력마다 버벅인다 — 같은 문서
// 버전(Text는 불변, 편집 시 새 인스턴스)에 대해 1회만 만들고 재사용한다.
let lowerCache: { doc: unknown; hay: string } | null = null

// 평문·대소문자 무시 검색 (비-CM FindBar와 동일 규칙). 과도한 매치는 상한으로 막는다.
export function computeMatches(view: EditorView, query: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  if (!query) return out
  const needle = query.toLowerCase()
  const doc = view.state.doc
  if (!lowerCache || lowerCache.doc !== doc) lowerCache = { doc, hay: doc.toString().toLowerCase() }
  const hay = lowerCache.hay
  const step = Math.max(needle.length, 1)
  let idx = hay.indexOf(needle)
  while (idx >= 0 && out.length < 5000) {
    out.push({ from: idx, to: idx + needle.length })
    idx = hay.indexOf(needle, idx + step)
  }
  return out
}
