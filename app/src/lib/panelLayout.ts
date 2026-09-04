/* ============================================================
 * 보드 자리 배치의 순수 규칙 — 자리 수(다이얼 1‥6)와 표시 순서(`panelOrder`)의 관계.
 *
 * ★3.0.8 — 「2·3·4·5를 오가다 보면 1번이던 패널이 5번에 가 있다」(2026-09-04 제보).
 *
 * 왜 그랬나: 자리 수를 **줄일** 때 포커스된 자리가 접히게 되면 그 자리를 보이는 마지막
 * 자리로 끌어올린다(「현재 대화는 안 접힌다」 — 2026-09-02 결정). 그런데 그 승격이
 * `panelOrder` 자체를 **영구히** 바꿨고, 늘릴 때는 순서를 안 건드렸다. 그래서 5→1(포커스
 * 5번) → 5를 반복하면 매번 원래 1‥4번이 한 칸씩 오른쪽으로 밀렸다 — 패널 아무 데나
 * 클릭해도 포커스가 잡히니 사용자에겐 「순서가 저절로 뒤틀린다」로 보였다.
 *
 * 규칙: 승격은 **임시 오버레이**다. 줄일 때 승격하면서 승격 전 순서(`base`)를 기억하고,
 * 늘릴 때 그 순서로 되돌린다(승격 자리가 그래도 안 보이면 되돌린 순서 위에 다시 얹는다).
 * 사용자가 손으로 순서를 바꾸면(헤더 드래그 · 접힌 자리 ↥ 올리기) 그 순간의 순서가 새
 * 진실이 되고 오버레이는 사라진다.
 * ============================================================ */

/** 자리 수를 줄이며 끌어올린 자리 하나와, 끌어올리기 전의 순서. */
export interface LayoutPromo {
  slot: number
  base: number[]
}

export interface Layout {
  order: number[] // 표시 순서 — 슬롯 번호의 순열
  count: number // 보이는 자리 수
  promo: LayoutPromo | null
}

/** `0..n-1`의 순열인가(길이·구성원). */
export function isPermutation(v: unknown, n: number): v is number[] {
  if (!Array.isArray(v) || v.length !== n) return false
  for (let i = 0; i < n; i++) if (!v.includes(i)) return false
  return true
}

/** 저장본의 `promo` 위생 — 슬롯 범위·순열이 아니면 없는 것으로(표시만 바꾸는 값이라 폴백이 안전하다). */
export function sanitizePromo(v: unknown, n: number): LayoutPromo | null {
  if (!v || typeof v !== 'object') return null
  const p = v as { slot?: unknown; base?: unknown }
  if (typeof p.slot !== 'number' || !Number.isInteger(p.slot) || p.slot < 0 || p.slot >= n) return null
  if (!isPermutation(p.base, n)) return null
  return { slot: p.slot, base: [...p.base] }
}

/** `slot`을 빼서 `at` 자리에 끼운 순서. */
function promote(order: number[], slot: number, at: number): number[] {
  const rest = order.filter((s) => s !== slot)
  rest.splice(Math.max(0, Math.min(at, rest.length)), 0, slot)
  return rest
}

/**
 * 자리 수를 `next`로 바꿀 때의 순서와 오버레이.
 * `keep` = 안 접혀야 하는 자리(포커스). 순서에 없으면 첫 자리를 쓴다.
 *
 * - 줄이기: `keep`이 이미 보이면 순서 그대로. 접히게 되면 보이는 마지막 자리(`next-1`)로
 *   끌어올리고 `base`(오버레이가 없었으면 지금 순서, 있었으면 그 오버레이의 `base`)를 기억한다.
 * - 늘리기: 오버레이가 있으면 `base`로 되돌린다. 되돌린 순서에서도 그 자리가 안 보이면
 *   `base` 위에 다시 얹는다(오버레이 유지). 오버레이가 없으면 순서 그대로.
 * - 같은 수: 아무것도 안 바꾼다.
 */
export function resizeLayout(cur: Layout, next: number, keep: number): { order: number[]; promo: LayoutPromo | null } {
  const { order, count, promo } = cur
  const keepSlot = order.includes(keep) ? keep : order[0]
  if (next < count) {
    if (order.indexOf(keepSlot) < next) return { order, promo }
    const base = promo?.base ?? order
    return { order: promote(order, keepSlot, next - 1), promo: { slot: keepSlot, base: [...base] } }
  }
  if (next > count && promo) {
    const idx = promo.base.indexOf(promo.slot)
    if (idx < next) return { order: [...promo.base], promo: null }
    return { order: promote(promo.base, promo.slot, next - 1), promo }
  }
  return { order, promo }
}
