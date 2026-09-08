// ★2026-09-04 — `app/src/lib/panelLayout.ts` 규칙 검증(esbuild로 묶어 진짜 함수를 부른다).
// 보고: 보드 다이얼 2·3·4·5를 반복하면 순서가 뒤틀려 1번이던 패널이 5번에 가 있다.
//   node scripts/poc-panel-layout.mjs
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const r = await build({ entryPoints: ['app/src/lib/panelLayout.ts'], bundle: true, write: false, format: 'esm', platform: 'node' })
const dir = join(process.cwd(), 'node_modules', '.cache', 'poc-panel-layout')
mkdirSync(dir, { recursive: true })
const out = join(dir, 'panelLayout.mjs')
writeFileSync(out, r.outputFiles[0].text)
const m = await import(pathToFileURL(out).href)

let fails = 0
const check = (label, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  ← ${JSON.stringify(got)}`}`)
  if (!ok) fails++
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const ID = [0, 1, 2, 3, 4, 5]
/** 다이얼을 차례로 누른다 — 각 단계의 keep(포커스)은 배열로 준다. */
const press = (start, steps) => {
  let lay = { order: [...start.order], count: start.count, promo: start.promo ?? null }
  for (const [n, keep] of steps) {
    const r = m.resizeLayout(lay, n, keep)
    lay = { order: r.order, count: n, promo: r.promo }
  }
  return lay
}

// ── 보고 그대로: 5번 패널(슬롯 4)에 포커스 두고 1 → 5 ──
let l = press({ order: ID, count: 5 }, [[1, 4]])
check('5→1: 포커스 자리가 1번 자리로 올라온다', eq(l.order.slice(0, 1), [4]) && l.promo?.slot === 4, l)
l = press({ order: ID, count: 5 }, [[1, 4], [5, 4]])
check('→5: 원래 순서로 돌아온다(오버레이 해제)', eq(l.order, ID) && l.promo === null, l)

// 옛 동작이 만들던 드리프트 — 서로 다른 포커스로 1↔5를 네 번 반복해도 순서가 그대로
l = press({ order: ID, count: 5 }, [[1, 4], [5, 4], [1, 3], [5, 3], [1, 2], [5, 2], [1, 1], [5, 1]])
check('1↔5 반복(포커스 매번 다름)에도 드리프트 없음', eq(l.order, ID) && l.promo === null, l)

// 2026-09-08 보고: 5번 빈 패널에 포커스한 채 5→4에서 기존 4번 대화가 접혔다.
l = press({ order: ID, count: 5 }, [[4, 4]])
check('5→4(포커스 5번): 기존 1~4번 유지 · 5번만 접힘', eq(l.order.slice(0, 4), [0, 1, 2, 3]) && l.promo === null, l)

// 여러 패널을 남기는 축소에서는 포커스 때문에 남는 자리가 교체되면 안 된다.
l = press({ order: ID, count: 5 }, [[2, 4]])
check('5→2: 기존 1·2번 유지', eq(l.order.slice(0, 2), [0, 1]) && l.promo === null, l)
l = press({ order: ID, count: 5 }, [[2, 4], [5, 4]])
check('2→5: 복원', eq(l.order, ID) && l.promo === null, l)

// 줄일 때 포커스가 이미 보이면 순서 불변·오버레이 없음
l = press({ order: ID, count: 5 }, [[3, 1]])
check('5→3(포커스 2번): 순서 그대로 · 오버레이 없음', eq(l.order, ID) && l.promo === null, l)

// 두 번 줄이기(다른 포커스) 뒤 늘리기 → 둘 다 제자리
l = press({ order: ID, count: 6 }, [[4, 5], [1, 3], [6, 3]])
check('6→4(포커스 6번)→1(포커스 4번)→6: 완전 복원', eq(l.order, ID) && l.promo === null, l)

// 한 자리 집중 보기에서 여러 자리로 돌아올 때도 원래 앞쪽 패널을 유지한다.
l = press({ order: ID, count: 5 }, [[1, 4], [3, 4]])
check('1→3: 기존 1~3번 복원 · 임시 승격 해제', eq(l.order, ID) && l.promo === null, l)
l = press({ order: ID, count: 5 }, [[1, 4], [3, 4], [5, 4]])
check('→5: 그다음 완전 복원', eq(l.order, ID) && l.promo === null, l)

// 사용자가 손으로 바꾼 순서는 진실 — 오버레이를 걷은 뒤(호출부가 promo:null로) 늘려도 되돌리지 않는다
l = press({ order: [4, 0, 1, 2, 3, 5], count: 1, promo: null }, [[5, 4]])
check('오버레이 없이 늘리기: 순서 그대로', eq(l.order, [4, 0, 1, 2, 3, 5]) && l.promo === null, l)

// 같은 수 다시 누름: 무동작
l = press({ order: ID, count: 5 }, [[1, 4], [1, 4]])
check('같은 수 반복: 무동작', eq(l.order.slice(0, 1), [4]) && l.promo?.slot === 4 && eq(l.promo.base, ID), l)

// 예전 버전에서 5→4하며 저장한 승격도 다이얼을 바꾸면 원래 순서로 복원한다.
const legacy = { order: [0, 1, 2, 4, 3, 5], count: 4, promo: { slot: 4, base: ID } }
for (const next of [2, 3, 5, 6]) {
  l = press(JSON.parse(JSON.stringify(legacy)), [[next, 4]])
  check(`이전 저장본 4→${next}: 기존 순서 복원`, eq(l.order, ID) && l.promo === null, l)
}

// 드래그/직접 올리기로 만든 임의 순서도 슬롯 번호가 아니라 표시 순서대로 접는다.
function* permutations(items) {
  if (!items.length) { yield []; return }
  for (const item of items) {
    for (const rest of permutations(items.filter(v => v !== item))) yield [item, ...rest]
  }
}
let cases = 0
let mismatch = null
for (const order of permutations(ID)) {
  for (let count = 2; count <= 6; count++) {
    for (let next = 2; next <= 6; next++) {
      for (const keep of [...order.slice(0, count), -1]) {
        const before = { order: [...order], count, promo: null }
        const saved = JSON.stringify(before)
        const result = m.resizeLayout(before, next, keep)
        cases++
        if ((!eq(result.order, order) || result.promo !== null || JSON.stringify(before) !== saved) && !mismatch) {
          mismatch = { before, next, keep, result }
        }
      }
    }
  }
}
check(`2~6분할 모든 순열·포커스 조합 ${cases}건: 순서 보존 · 입력 불변`, !mismatch, mismatch)

// 위생
check('sanitizePromo: 정상', eq(m.sanitizePromo({ slot: 2, base: ID }, 6), { slot: 2, base: ID }))
check('sanitizePromo: 슬롯 범위 밖', m.sanitizePromo({ slot: 6, base: ID }, 6) === null)
check('sanitizePromo: 순열 아님', m.sanitizePromo({ slot: 1, base: [0, 1, 1, 3, 4, 5] }, 6) === null)
check('sanitizePromo: null', m.sanitizePromo(null, 6) === null)
check('isPermutation', m.isPermutation([5, 4, 3, 2, 1, 0], 6) && !m.isPermutation([0, 1, 2, 3, 4], 6))

console.log(fails ? `\n${fails} FAIL` : '\nALL PASS')
process.exit(fails ? 1 : 0)
