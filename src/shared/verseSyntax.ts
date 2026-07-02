/* ============================================================
 * Verse 구문 공통 유틸 — main(verse.ts, verseMemberDb.ts)과
 * renderer(verseMembers.ts)가 같은 규칙으로 소스를 읽도록 한 곳에
 * 모은다. 전에는 들여쓰기 계산 3벌·doc 주석 추출 2벌이 파일마다
 * 복제돼 있었고, 그 드리프트가 실제 버그(블록 주석 누락 등)로
 * 이어졌다. 순수 함수만 — node/DOM 의존 없음(양쪽에서 import).
 * ============================================================ */

/** 정규식 조각 — 중첩 1단계까지 담는 괄호 그룹. 파라미터형 타입 선언
 *  `chat_channel<native><public>(member_info:subtype(member_info_interface)) := class…`의
 *  타입 매개변수 리스트가 이 꼴이다(안에 `subtype(...)` 같은 괄호가 한 번 더 들어간다 —
 *  단순한 `\([^()]*\)`는 여기서 끊겨 digest의 파라미터형 클래스를 통째로 놓쳤다). */
export const VERSE_PARENS = String.raw`\((?:[^()]|\([^()]*\))*\)`
/** 정규식 조각 — 타입/함수 이름 뒤에 붙을 수 있는 `<지정자>`·`(타입 매개변수)` 나열. */
export const VERSE_NAME_TRAIL = String.raw`(?:<[^>]*>|${VERSE_PARENS})*`

/** Indentation depth in levels (tab or 4 spaces = 1 level) — Verse blocks are significant-indent,
 *  Epic's own grammar treats both the same. */
export function verseIndent(line: string): number {
  let i = 0
  let lvl = 0
  for (;;) {
    if (line[i] === '\t') {
      lvl++
      i++
    } else if (line.startsWith('    ', i)) {
      lvl++
      i += 4
    } else break
  }
  return lvl
}

/** One (trimmed) line's role for doc-comment collection above/around a declaration. */
export type VerseDocPiece =
  | { type: 'blank' } // 빈 줄 — 선언에 "붙어 있지 않음", 수집기는 버퍼를 비우거나 중단
  | { type: 'doc'; text: string } // `# …` 또는 한 줄 `<# … #>` — 문서 본문
  | { type: 'attr'; name: string | null; text: string | null } // `@속성` 줄 — text는 @doc("…")의 본문
  | { type: 'code' } // 그 밖의 코드 줄 — 수집 중단/버퍼 플러시

/**
 * 문서 주석 수집용 줄 분류기 — verseDocAbove(위로 스캔)와 parseVerseTypes(아래로 스캔)가
 * 반드시 같은 분류를 쓰도록 하나로 뺐다. 한국어 번역 팩은 sha1(추출된 원문)으로 찾으므로
 * 두 수집기의 출력이 1바이트라도 어긋나면 번역을 못 찾는다 — 형식 변경은 여기 한 곳에서만.
 *   · `# …`        → 앞의 #들과 공백 하나를 벗긴 본문
 *   · `<# … #>`    → 한 줄 블록 주석의 내부(trim)
 *   · `@doc("…")`  → 이스케이프를 푼 문자열 본문 (attr.text)
 *   · 그 밖의 `@…` → attr (본문 없음; 수집기는 건너뛰고 위/아래 주석을 계속 본다)
 */
export function verseDocPiece(trimmed: string): VerseDocPiece {
  if (trimmed === '') return { type: 'blank' }
  if (trimmed.startsWith('@')) {
    const dm = /^@doc\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/.exec(trimmed)
    const nm = /^@([A-Za-z_]\w*)/.exec(trimmed)
    return { type: 'attr', name: nm ? nm[1] : null, text: dm ? dm[1].replace(/\\(.)/g, '$1') : null }
  }
  if (trimmed.startsWith('<#') && trimmed.endsWith('#>')) return { type: 'doc', text: trimmed.slice(2, -2).trim() }
  if (trimmed.startsWith('#') && !trimmed.startsWith('#>')) return { type: 'doc', text: trimmed.replace(/^#+\s?/, '') }
  return { type: 'code' }
}

/**
 * 선언 줄 바로 위의 문서 주석 — 연속된 `# …` 줄(과 한 줄짜리 `<# … #>`)과 `@doc("…")` 속성.
 * 사이의 다른 속성(@editable 등)은 건너뛰고 더 위의 주석을 계속 찾는다. 빈 줄/코드 줄에서 중단.
 * 번역 팩 매칭을 위해 반환 텍스트는 byte-stable(위 verseDocPiece 참고). 번역은 호출자 몫.
 */
export function verseDocAbove(lines: string[], declLine: number): string {
  const out: string[] = []
  for (let i = declLine - 1; i >= 0; i--) {
    const p = verseDocPiece((lines[i] ?? '').trim())
    if (p.type === 'doc') {
      out.unshift(p.text)
      continue
    }
    if (p.type === 'attr') {
      if (p.text != null) out.unshift(p.text)
      continue
    }
    break // blank/code — 붙어 있지 않음
  }
  return out.join('\n').trim()
}

/**
 * 선언 줄 바로 위의 `@속성` 이름들(붙어 있는 블록 안, 위→아래 순서). `@doc`는 문서 본문으로
 * 따로 처리하므로 제외. verseDocAbove와 같은 스캔 규칙(빈 줄/코드 줄에서 중단, 주석은 건너뜀).
 */
export function verseAttrsAbove(lines: string[], declLine: number): string[] {
  const out: string[] = []
  for (let i = declLine - 1; i >= 0; i--) {
    const p = verseDocPiece((lines[i] ?? '').trim())
    if (p.type === 'attr') {
      if (p.name && p.name !== 'doc') out.unshift(p.name)
      continue
    }
    if (p.type === 'doc') continue
    break // blank/code — 중단
  }
  return out
}

/**
 * `start` 줄을 실제로 감싸는(진짜 조상인) 가장 가까운 줄 중 `match`를 만족하는 첫 줄의 인덱스,
 * 없으면 -1. "위로 올라가며 첫 매치"가 아니라 min-indent walk: 지금까지 본 최소 들여쓰기보다
 * 얕은 줄만 조상으로 인정한다 — 그래야 앞서 지나간(감싸지 않는) 클래스/함수를 잡지 않는다.
 * 예: 클래스 A 아래의 자유 함수 본문에서 위로 스캔해도 A는 조상이 아니므로 매칭되지 않는다.
 * 빈 줄·`#` 주석·`@속성` 줄은 건너뛰고, 닫는 괄호로 시작하는 연속행(`)`/`]`/`}`)도 무시한다.
 * `startIndent`를 주면 start 줄 자체의 들여쓰기 대신 그 값을 기준으로 삼는다(공백뿐인 캐럿 줄).
 */
export function verseEnclosingLine(
  lines: string[],
  start: number,
  match: (trimmed: string, line: number) => boolean,
  startIndent?: number
): number {
  let min = startIndent ?? verseIndent(lines[start] ?? '')
  if (min <= 0) return -1
  for (let i = start - 1; i >= 0; i--) {
    const raw = lines[i] ?? ''
    const t = raw.trim()
    if (!t || t.startsWith('#') || t.startsWith('@') || /^[)\]}]/.test(t)) continue
    const ind = verseIndent(raw)
    if (ind >= min) continue // 형제/더 깊은 줄 — 조상 아님
    if (match(t, i)) return i
    min = ind
    if (min === 0) return -1 // 최상위까지 왔는데 매치 없음
  }
  return -1
}

/**
 * 캐럿이 속한 블록의 기준 줄과 들여쓰기 — verseEnclosingLine의 start 인자용.
 * 캐럿 줄에 내용이 있으면 그 줄, 공백만 있으면(자동 들여쓰기 상태로 입력 대기) 그 공백의
 * 들여쓰기를 신뢰하고, 완전히 비었으면 위쪽 첫 비어있지 않은 줄로 올라간다.
 */
export function verseBlockStart(lines: string[], caretLine: number): { line: number; indent: number } {
  const i = Math.min(Math.max(caretLine, 0), lines.length - 1)
  const raw = lines[i] ?? ''
  if (raw.trim()) return { line: i, indent: verseIndent(raw) }
  if (/^[ \t]+$/.test(raw)) return { line: i, indent: verseIndent(raw) } // 공백뿐 — 자동 들여쓰기 존중
  for (let j = i - 1; j >= 0; j--) {
    if ((lines[j] ?? '').trim()) return { line: j, indent: verseIndent(lines[j]) }
  }
  return { line: 0, indent: 0 }
}
