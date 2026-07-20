// ── didChange 최소 range 교체 계산 ───────────────────────────────────────────
// incremental(syncKind 2) 서버에 전문 교체 대신, 이전/새 텍스트의 공통 prefix/suffix를
// 잘라낸 가운데 조각만 range 교체로 보낸다 — 키 입력마다 문서 전문이 JSON-RPC로 나가고
// 서버가 전문을 재파싱하던 비용(완성이 열린 채 타이핑하는 동안 매 키)을 조각 크기로 줄인다.
// 전자 없이 순수 문자열 연산만 하는 별도 모듈 — esbuild 하네스로 단독 검증 가능.
//
// LSP position은 UTF-16 코드 유닛 기준(JS 문자열 인덱스와 동일)이라 변환이 필요 없다.
// 경계가 서러게이트 쌍(이모지 등)을 가르면 한 칸 물려 통짜 문자를 유지한다 — 유닛 단위
// 스플라이스만 하는 서버라면 갈라도 결과는 같지만, 검증하는 서버를 자극하지 않게.

export interface MinimalChange {
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  text: string
}

/** offset(UTF-16 유닛) → LSP {line, character}. 줄 경계는 '\n' — \r\n 문서의 '\r'은
 *  character에 포함되며, 서버도 우리가 보낸 같은 텍스트로 줄을 재므로 좌표가 일치한다. */
function posAt(s: string, offset: number): { line: number; character: number } {
  let line = 0
  let lineStart = 0
  for (;;) {
    const nl = s.indexOf('\n', lineStart)
    if (nl < 0 || nl >= offset) break
    line++
    lineStart = nl + 1
  }
  return { line, character: offset - lineStart }
}

/** i가 s의 서러게이트 쌍(high, low) 한가운데를 가르는가 */
function splitsPair(s: string, i: number): boolean {
  return i > 0 && i < s.length && (s.charCodeAt(i - 1) & 0xfc00) === 0xd800 && (s.charCodeAt(i) & 0xfc00) === 0xdc00
}

/** prevText → text로 가는 한 건의 최소 range 교체. 동일 텍스트면 빈 no-op 교체가 나온다
 *  (호출부가 보통 먼저 거른다). range 좌표는 prevText 기준. */
export function minimalRangeChange(prevText: string, text: string): MinimalChange {
  let a = 0
  const max = Math.min(prevText.length, text.length)
  while (a < max && prevText.charCodeAt(a) === text.charCodeAt(a)) a++
  let b = 0
  const maxB = max - a // prefix와 겹치지 않게 — 안 그러면 "abab"→"ab" 같은 데서 음수 조각
  while (b < maxB && prevText.charCodeAt(prevText.length - 1 - b) === text.charCodeAt(text.length - 1 - b)) b++
  while (a > 0 && (splitsPair(prevText, a) || splitsPair(text, a))) a--
  while (b > 0 && (splitsPair(prevText, prevText.length - b) || splitsPair(text, text.length - b))) b--
  return {
    range: { start: posAt(prevText, a), end: posAt(prevText, prevText.length - b) },
    text: text.slice(a, text.length - b)
  }
}
