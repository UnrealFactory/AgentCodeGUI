import type { DiffLine } from '@shared/protocol'

/**
 * Minimal LCS line diff — good enough to render Edit/Write hunks in the UI.
 * Returns diff lines plus added/removed counts.
 *
 * The precise LCS DP is O(n·m) in memory, which on a big file (tens of thousands
 * of lines) allocates gigabytes and V8 kills the whole main process with an
 * uncatchable OOM abort. So: common prefix/suffix lines are trimmed first (a
 * typical edit shrinks to the few changed lines), and if the remaining middle is
 * still over MAX_DP_CELLS the alignment is skipped — the middle renders as one
 * deleted block + one added block, which is what diff viewers do at this scale.
 */
const MAX_DP_CELLS = 4_000_000 // ≈2000×2000 changed lines; Int32Array rows keep this ≤ ~16MB

export function computeLineDiff(
  oldText: string,
  newText: string
): { lines: DiffLine[]; add: number; del: number } {
  // Drop a single trailing newline so line counts match the real file.
  const an = oldText.endsWith('\n') ? oldText.slice(0, -1) : oldText
  const bn = newText.endsWith('\n') ? newText.slice(0, -1) : newText
  const a = an.length ? an.split('\n') : []
  const b = bn.length ? bn.split('\n') : []

  // trim common prefix/suffix — the DP only ever sees the changed middle
  const minLen = Math.min(a.length, b.length)
  let pre = 0
  while (pre < minLen && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < minLen - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const n = a.length - pre - suf
  const m = b.length - pre - suf

  const lines: DiffLine[] = []
  for (let i = 0; i < pre; i++) lines.push({ t: 'ctx', text: a[i] })
  let add = 0
  let del = 0

  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_DP_CELLS) {
    // one side empty (pure insert/delete) or too large to align precisely —
    // emit the middle as a replaced block, no quadratic work
    for (let i = 0; i < n; i++) {
      lines.push({ t: 'del', text: a[pre + i] })
      del++
    }
    for (let j = 0; j < m; j++) {
      lines.push({ t: 'add', text: b[pre + j] })
      add++
    }
  } else {
    // dp[i][j] = LCS length of middle-a[i:] and middle-b[j:] — typed rows, no boxing
    const dp: Int32Array[] = []
    for (let i = 0; i <= n; i++) dp.push(new Int32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[pre + i] === b[pre + j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (a[pre + i] === b[pre + j]) {
        lines.push({ t: 'ctx', text: a[pre + i] })
        i++
        j++
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        lines.push({ t: 'del', text: a[pre + i] })
        i++
        del++
      } else {
        lines.push({ t: 'add', text: b[pre + j] })
        j++
        add++
      }
    }
    while (i < n) {
      lines.push({ t: 'del', text: a[pre + i] })
      i++
      del++
    }
    while (j < m) {
      lines.push({ t: 'add', text: b[pre + j] })
      j++
      add++
    }
  }

  for (let k = 0; k < suf; k++) lines.push({ t: 'ctx', text: a[a.length - suf + k] })
  return { lines, add, del }
}

/** Build an all-added diff for a freshly written file. */
export function newFileDiff(content: string): { lines: DiffLine[]; add: number } {
  const normalized = content.endsWith('\n') ? content.slice(0, -1) : content
  const body = normalized.length ? normalized.split('\n') : []
  const lines: DiffLine[] = [{ t: 'hunk', text: `@@ 새 파일 +1,${body.length} @@` }]
  for (const text of body) lines.push({ t: 'add', text })
  return { lines, add: body.length }
}
