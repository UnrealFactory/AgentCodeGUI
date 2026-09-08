/* ============================================================
 * 보드 자리 배치의 순수 규칙 — 자리 수(다이얼 1‥6)와 표시 순서(`panelOrder`)의 관계.
 *
 * 2‥6분할은 원래 표시 순서의 앞 N개를 보여 준다. 포커스된 자리를 자동으로 끼우면
 * 5→4에서 5번 빈 패널이 기존 4번 대화를 접어 버린다(2026-09-08 제보).
 *
 * 1분할 집중 보기만 현재 대화를 임시로 맨 앞에 올리고 원래 순서(`base`)를 기억한다.
 * 다시 여러 자리로 돌아가면 원래 순서를 복원한다. 직접 순서를 바꾸면(헤더 드래그 ·
 * 접힌 자리 ↥ 올리기) 그 순서가 기준이 되고 임시 승격은 해제된다.
 * ============================================================ */

/** 집중 보기로 끌어올린 자리 하나와, 끌어올리기 전의 순서. 예전 다중 자리 승격도 읽는다. */
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

/**
 * 자리 수를 `next`로 바꿀 때의 순서와 오버레이.
 * `keep` = 1분할에서 볼 자리(포커스). 순서에 없으면 첫 자리를 쓴다.
 *
 * - 1분할: `keep`을 맨 앞에 임시로 올리고 `base`를 기억한다.
 * - 2‥6분할: `base`가 있으면 복원하고 승격을 해제한다. 없으면 순서 그대로.
 *   이전 버전에서 여러 자리에 적용한 승격도 이 경로로 복원된다.
 * - 같은 수: 아무것도 안 바꾼다.
 */
export function resizeLayout(cur: Layout, next: number, keep: number): { order: number[]; promo: LayoutPromo | null } {
  const { order, count, promo } = cur
  if (next === count) return { order, promo }
  const base = promo?.base ?? order
  if (next === 1) {
    const keepSlot = order.includes(keep) ? keep : order[0]
    if (keepSlot !== base[0]) {
      return { order: [keepSlot, ...base.filter((s) => s !== keepSlot)], promo: { slot: keepSlot, base: [...base] } }
    }
  }
  return { order: base, promo: null }
}
