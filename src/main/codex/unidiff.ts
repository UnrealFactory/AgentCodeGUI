/* Codex 와이어(fileChange item)의 unified diff 유틸 — 엔진에서 쓰는 순수 함수 모듈.
 * 순수라 하네스(esbuild 번들 + node)로 직접 검증한다. */
import type { DiffLine } from '@shared/protocol'

/** unified diff 텍스트 → 뷰어 마킹용 FileDiff 라인/증감. 훙크 조각을 그대로 옮기므로
 * 줄번호가 파일 기준이 아니다 — 역적용(reverseApplyUnified) 실패 시의 폴백 전용이고,
 * 렌더러(FileModal)는 이 모양(훙크 헤더가 남은 diff)의 변경 마킹을 통째로 접는다. */
export function parseUnifiedDiff(diffText: string): { lines: DiffLine[]; add: number; del: number } {
  const lines: DiffLine[] = []
  let add = 0
  let del = 0
  for (const raw of diffText.replace(/\r\n/g, '\n').split('\n')) {
    if (raw.startsWith('@@')) lines.push({ t: 'hunk', text: raw })
    else if (raw.startsWith('+++') || raw.startsWith('---')) continue
    else if (raw.startsWith('+')) {
      add++
      lines.push({ t: 'add', text: raw.slice(1) })
    } else if (raw.startsWith('-')) {
      del++
      lines.push({ t: 'del', text: raw.slice(1) })
    } else {
      lines.push({ t: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : raw })
    }
  }
  return { lines, add, del }
}

/** unified diff를 '적용 후' 텍스트에 역적용해 '적용 전' 원문을 복원한다(전부 LF 기준).
 * fileChange는 Codex가 디스크에 적용을 마친 뒤 오므로, 디스크 = 새쪽이 정확히 성립한다.
 * 훙크의 새쪽(ctx·add) 줄이 실제 텍스트와 하나라도 어긋나면 null — 어긋난 복원으로
 * 전체 diff를 오염시키느니 포기한다(호출측이 훙크 조각 폴백). */
export function reverseApplyUnified(newText: string, diffText: string): string | null {
  const nl = newText.replace(/\r\n/g, '\n')
  const hadNl = nl.endsWith('\n')
  const body = hadNl ? nl.slice(0, -1) : nl
  const cur = body.length ? body.split('\n') : []
  const d = diffText.replace(/\r\n/g, '\n').split('\n')
  while (d.length && d[d.length - 1] === '') d.pop() // diff 말단 개행 잔여물 — ctx로 오인 금지
  const out: string[] = []
  let pos = 0 // 소비한 새쪽(적용 후) 줄 수
  let inHunk = false
  for (const line of d) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (h) {
      // 훙크 사이 구간은 변경 없음 — 새쪽 시작 줄(1-based)까지 그대로 복사한다.
      // 새쪽 개수가 0인 훙크(순수 삭제·컨텍스트 없음)는 관례상 "그 줄 뒤"를 가리킨다.
      const cnt = h[2] != null ? parseInt(h[2], 10) : 1
      const start = parseInt(h[1], 10) - (cnt === 0 ? 0 : 1)
      if (start < pos || start > cur.length) return null
      while (pos < start) out.push(cur[pos++])
      inHunk = true
      continue
    }
    if (!inHunk) continue // ---/+++ 등 프리앰블
    if (line.startsWith('\\')) continue // "\ No newline at end of file"
    if (line.startsWith('-')) {
      out.push(line.slice(1))
      continue
    }
    const t = line.startsWith('+') || line.startsWith(' ') ? line.slice(1) : line
    if (pos >= cur.length || cur[pos] !== t) return null // 새쪽 줄이 디스크와 다르면 신뢰 불가
    if (!line.startsWith('+')) out.push(t)
    pos++
  }
  if (!inHunk) return null
  while (pos < cur.length) out.push(cur[pos++])
  return out.join('\n') + (hadNl && out.length ? '\n' : '')
}
