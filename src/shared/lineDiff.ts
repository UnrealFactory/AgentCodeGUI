/* ============================================================
 * 라인 diff 공용 코어 — main(엔진 파일 변경 미리보기 diff.ts)과 renderer(뷰어 읽기 모드
 * cmDiff.ts)가 같은 구현을 쓴다.
 *
 * Myers O(ND): 비용이 파일 크기가 아니라 실제 변경량 D에 비례한다. 예전 LCS DP는 메모리가
 * "변경 구간 가로×세로"라, 큰 파일의 서로 먼 두 곳 수정(위 import + 아래 함수, +3줄)만으로
 * 셀 캡을 넘어 전부 삭제+전부 추가(=전체 초록)로 뭉개졌다 — Myers는 그 경우 D=3이라 즉시
 * 정확한 diff가 나온다.
 *
 * 크래시 규율(예전 DP의 무제한 할당은 V8이 잡을 수 없는 OOM abort로 프로세스째 죽였다 —
 * 할당·시간 모두 하드 상한, 초과는 폴백):
 *  - D 상한 2000 — 경로 복원(trace) 메모리가 (D+1)² Int32 ≤ 16MB로 물리적 확정
 *  - 스텝 예산 — 전진 루프 최악 비용 (N+M)·D가 예산을 넘지 않게 초대형 입력은 D 상한을
 *    비례 축소(엔진은 알림 스트림에서 동기로 도므로 수십 ms 이상 막으면 안 된다)
 *  - 상한 초과 = 전부 삭제+전부 추가 폴백 — 그 규모로 진짜 바뀐 파일의 정직한 표시
 * ============================================================ */

export type LineDiffOp = { t: 'eq'; ai: number; bi: number } | { t: 'del'; ai: number } | { t: 'add'; bi: number }

const MAX_D = 2000
// (N+M)·D 근사 스텝 예산 — 64M ≈ JS 수십~백 ms. N+M이 크면 D 상한이 비례로 줄어
// 시간도 상한된다(예: 중간 구간 40만 줄이면 D≤160 — 그 이상 바뀌었으면 폴백).
const STEP_BUDGET = 64_000_000

/** 두 줄 배열의 편집 스크립트: eq(그대로)·del(a에만)·add(b에만). 인덱스는 원본 배열 기준이며
 * eq/del의 ai, eq/add의 bi가 각각 0..n-1, 0..m-1을 순서대로 정확히 한 번씩 지난다.
 * 수정된 줄 묶음은 항상 del 전부 → add 전부 순서(🔴 옛것 위 → 🟢 새것 아래 렌더 계약). */
export function diffLineOps(a: string[], b: string[]): LineDiffOp[] {
  const n = a.length
  const m = b.length
  // 공통 앞뒤 줄을 먼저 잘라 국소 변경은 O(n)으로 끝낸다 — Myers는 잘린 가운데만 본다
  let p = 0
  const cap = Math.min(n, m)
  while (p < cap && a[p] === b[p]) p++
  let s = 0
  while (s < cap - p && a[n - 1 - s] === b[m - 1 - s]) s++
  const MA = n - s - p
  const MB = m - s - p

  const ops: LineDiffOp[] = []
  for (let i = 0; i < p; i++) ops.push({ t: 'eq', ai: i, bi: i })
  if (MA === 0) {
    for (let j = 0; j < MB; j++) ops.push({ t: 'add', bi: p + j })
  } else if (MB === 0) {
    for (let i = 0; i < MA; i++) ops.push({ t: 'del', ai: p + i })
  } else {
    const dmax = Math.min(MAX_D, Math.floor(STEP_BUDGET / (MA + MB)))
    const mid = myersOps(a, b, p, MA, MB, dmax)
    if (mid) {
      for (const op of mid) ops.push(op) // 스프레드 금지 — 수만 op에서 인자 상한 초과
    } else {
      // 상한 초과 폴백 — 예전 DP 셀 캡 폴백과 동일한 모양
      for (let i = 0; i < MA; i++) ops.push({ t: 'del', ai: p + i })
      for (let j = 0; j < MB; j++) ops.push({ t: 'add', bi: p + j })
    }
  }
  for (let k = 0; k < s; k++) ops.push({ t: 'eq', ai: n - s + k, bi: m - s + k })
  return ops
}

/** 가운데(공통 앞뒤 제거 후) 구간의 Myers 그리디 전진 + trace 역추적. off = 구간 시작의
 * 원본 인덱스, N·M = 구간 길이. D가 dmax를 넘으면 null(호출측 폴백). */
function myersOps(a: string[], b: string[], off: number, N: number, M: number, dmax: number): LineDiffOp[] | null {
  if (dmax < 1) return null
  // V[k] = 대각선 k(=x−y)에서 도달한 최장 x. 창 [-dmax..dmax]를 오프셋으로 편다.
  const vOff = dmax + 1
  const V = new Int32Array(2 * dmax + 3)
  // trace[d] = d 단계 종료 시점 V의 [-d..d] 창 사본 — 총 (D+1)² Int32 ≤ 16MB(D=2000)
  const trace: Int32Array[] = []
  let D = -1
  outer: for (let d = 0; d <= dmax; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && V[vOff + k - 1] < V[vOff + k + 1])) x = V[vOff + k + 1]
      else x = V[vOff + k - 1] + 1
      let y = x - k
      while (x < N && y < M && a[off + x] === b[off + y]) {
        x++
        y++
      }
      V[vOff + k] = x
      if (x >= N && y >= M) {
        trace.push(V.slice(vOff - d, vOff + d + 1))
        D = d
        break outer
      }
    }
    trace.push(V.slice(vOff - d, vOff + d + 1))
  }
  if (D < 0) return null

  // 역추적 — 끝(N,M)에서 (0,0)까지. 이동 1회 = del(오른쪽) 또는 add(아래쪽) 1개.
  const rev: LineDiffOp[] = []
  let x = N
  let y = M
  for (let d = D; d > 0; d--) {
    const k = x - y
    const Vp = trace[d - 1] // 창 [-(d-1)..d-1], 인덱스 = k' + (d-1)
    let prevK: number
    if (k === -d || (k !== d && Vp[k - 1 + (d - 1)] < Vp[k + 1 + (d - 1)])) prevK = k + 1
    else prevK = k - 1
    const prevX = Vp[prevK + (d - 1)]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x--
      y--
      rev.push({ t: 'eq', ai: off + x, bi: off + y })
    }
    if (prevK === k + 1) {
      y-- // 아래 이동 = b[prevY] 삽입
      rev.push({ t: 'add', bi: off + y })
    } else {
      x-- // 오른쪽 이동 = a[prevX] 삭제
      rev.push({ t: 'del', ai: off + x })
    }
  }
  while (x > 0 && y > 0) {
    x--
    y--
    rev.push({ t: 'eq', ai: off + x, bi: off + y })
  }
  rev.reverse()
  // 경로가 del/add를 섞어 낼 수 있다 — eq 사이의 변경 묶음마다 del 전부 → add 전부로
  // 재배열한다(같은 편집 스크립트의 유효한 재배열: del은 a열, add는 b열을 각자 소비).
  return groupRuns(rev)
}

function groupRuns(ops: LineDiffOp[]): LineDiffOp[] {
  const out: LineDiffOp[] = []
  const dels: LineDiffOp[] = []
  const adds: LineDiffOp[] = []
  const flush = (): void => {
    for (const o of dels) out.push(o)
    for (const o of adds) out.push(o)
    dels.length = 0
    adds.length = 0
  }
  for (const op of ops) {
    if (op.t === 'eq') {
      flush()
      out.push(op)
    } else if (op.t === 'del') dels.push(op)
    else adds.push(op)
  }
  flush()
  return out
}
