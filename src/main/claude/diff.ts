import type { DiffLine } from '@shared/protocol'
import { diffLineOps } from '@shared/lineDiff'

/**
 * 라인 diff — Edit/Write 훙크를 UI에 그리기 위한 전체 파일 diff.
 *
 * 코어는 shared/lineDiff의 Myers(O(ND)·D 상한 2000·스텝 예산): 비용이 실제 변경량에
 * 비례해, 큰 파일의 서로 먼 두 곳 수정도 정확히 그 줄만 나온다. 예전 LCS DP는 변경 구간
 * 가로×세로만큼 할당해 수만 줄에서 V8이 잡을 수 없는 OOM abort로 메인 프로세스째 죽었고
 * (셀 캡으로 막았지만 캡 초과 = 전체 초록 뭉개짐), Myers는 상한이 전부 하드 바운드라
 * 그 크래시 가족이 원천적으로 안 나온다 — 상한 초과는 전부 삭제+전부 추가 폴백(그 규모로
 * 진짜 바뀐 파일의 정직한 표시)으로 같다.
 */
export function computeLineDiff(
  oldText: string,
  newText: string
): { lines: DiffLine[]; add: number; del: number } {
  // CRLF → LF 정규화 — diff는 표시용이고 렌더러(CM 문서)는 LF 기준이다. '\r'이 라인
  // 텍스트에 남으면 읽기 모드의 부모 복원(cmDiff oldLines)이 LF 문서와 전 줄 불일치가
  // 되어 파일 전체가 변경으로 칠해진다.
  const ao = oldText.replace(/\r\n/g, '\n')
  const bo = newText.replace(/\r\n/g, '\n')
  // Drop a single trailing newline so line counts match the real file.
  const an = ao.endsWith('\n') ? ao.slice(0, -1) : ao
  const bn = bo.endsWith('\n') ? bo.slice(0, -1) : bo
  const a = an.length ? an.split('\n') : []
  const b = bn.length ? bn.split('\n') : []

  const lines: DiffLine[] = []
  let add = 0
  let del = 0
  for (const op of diffLineOps(a, b)) {
    if (op.t === 'eq') lines.push({ t: 'ctx', text: a[op.ai] })
    else if (op.t === 'del') {
      lines.push({ t: 'del', text: a[op.ai] })
      del++
    } else {
      lines.push({ t: 'add', text: b[op.bi] })
      add++
    }
  }
  return { lines, add, del }
}

/** Build an all-added diff for a freshly written file. */
export function newFileDiff(content: string): { lines: DiffLine[]; add: number } {
  const lf = content.replace(/\r\n/g, '\n') // computeLineDiff와 같은 이유의 LF 정규화
  const normalized = lf.endsWith('\n') ? lf.slice(0, -1) : lf
  const body = normalized.length ? normalized.split('\n') : []
  const lines: DiffLine[] = [{ t: 'hunk', text: `@@ 새 파일 +1,${body.length} @@` }]
  for (const text of body) lines.push({ t: 'add', text })
  return { lines, add: body.length }
}
