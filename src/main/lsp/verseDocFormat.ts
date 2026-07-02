/* ============================================================
 * Verse 공식 doc 주석 → 카드 표시용 포맷터.
 *
 * digest의 doc 블록은 순수 산문이 아니다 — `====` 구분선, 정렬된
 * 코드 목록(`light_component := class<final_super>(component){}`),
 * 들여쓴 섹션(제목 + 본문), 수명주기 트리 같은 것이 섞여 있고,
 * 이를 그대로 마크다운에 흘리면 구분선은 거대한 setext 제목으로,
 * 코드 목록은 한 문단으로 뭉개져 렌더된다. 여기서 표시 직전에
 * 마크다운답게 고쳐 준다. 번역 팩 매칭(sha1)은 "원문"으로 하므로
 * 이 후처리는 매칭에 영향이 없다 — translateVerseDoc 뒤에만 적용.
 *
 * 두 소비처, 두 형태:
 *  · formatVerseDoc — 호버 카드 본문(react-markdown). 코드 목록을
 *    ```verse 펜스로(카드에서 Verse 색), 섹션 제목은 굵게, 핵심
 *    용어(snake_case·CamelCase API명)는 백틱으로(코드 색+설명 툴팁).
 *  · versePlainDoc — 카드 안 토큰 설명 툴팁(.lh-tokdesc, 플레인
 *    텍스트). 첫 산문 문단만, 백틱 벗겨서.
 * ============================================================ */

// 구분선-전용 줄 (`====…`, `----…`, `~~~~…`) — 마크다운에선 setext 제목/hr로 오해된다
const SEP_LINE = /^\s*[=\-~_]{6,}\s*$/

// 산문에 섞인 코드 줄인가 — 보수적으로: 한글이 없고, (백틱 밖에) `:=` 바인딩이 있거나
// 들여쓴 식별자 트리(`OnBeginSimulation -> OnSimulate<suspends>`)일 때만. 불릿(`* …`)은 산문.
function isCodeLine(line: string): boolean {
  if (!line.trim() || /[가-힣]/.test(line) || /^\s*[*-]\s/.test(line)) return false
  const noTicks = line.replace(/`[^`]*`/g, '')
  if (/:=/.test(noTicks)) return true
  return /^\s{2,}[A-Za-z_]\w*(?:<[^>]*>)?(?:\s*->\s*[A-Za-z_]\w*(?:<[^>]*>)?)*\s*:?\s*$/.test(line)
}

// 짧은 제목 줄인가 — `====` 구분선 다음 줄을 섹션 제목(굵게)으로 승격할지 판단
function isTitleLine(line: string): boolean {
  const t = line.trim()
  return t.length > 0 && t.length <= 60 && !/[.!?:;,]$/.test(t) && !/^[*-]\s/.test(t) && /[A-Za-z가-힣]/.test(t)
}

// 산문 줄의 핵심 용어를 백틱으로 — snake_case 식별자(`light_component`)와 2험프 이상의
// CamelCase API명(`OnBeginSimulation`). 이미 백틱 안인 부분은 건드리지 않도록 백틱 스팬
// 단위로 쪼개 산문 조각에만 적용한다. 카드에서 백틱 코드는 Verse 색으로 칠해지고, 알려진
// 타입이면 호버 설명 툴팁까지 붙는다(FileModal verseWordDesc).
function backtickTerms(line: string): string {
  return line
    .split(/(`[^`]*`)/)
    .map((part) =>
      part.startsWith('`')
        ? part
        : part
            .replace(/(?<![\w`])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?![\w`])/g, '`$1`')
            .replace(/(?<![\w`.])([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+(?:\(\))?)(?![\w`])/g, '`$1`')
    )
    .join('')
}

// 연속 코드 줄들을 ```verse 펜스로 감싼다 — 공통 들여쓰기는 벗겨 카드 폭을 아낀다
function flushCode(buf: string[], out: string[]): void {
  if (!buf.length) return
  const indents = buf.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length)
  const cut = indents.length ? Math.min(...indents) : 0
  out.push('```verse', ...buf.map((l) => l.slice(cut)), '```')
  buf.length = 0
}

/**
 * 호버 카드 본문용 마크다운 정리. 이미 ``` 펜스가 있는 텍스트(재번역된 팩 항목 등)는 펜스
 * 안을 건드리지 않으므로 이중 적용에도 안전하다(멱등에 가깝다).
 */
export function formatVerseDoc(text: string): string {
  if (!text) return text
  const lines = text.split('\n')
  const out: string[] = []
  const code: string[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      flushCode(code, out)
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    if (SEP_LINE.test(line)) {
      // 구분선 — 다음 비어있지 않은 줄이 짧은 제목이면 굵은 섹션 제목으로 승격, 아니면 그냥 버린다
      flushCode(code, out)
      let j = i + 1
      while (j < lines.length && !lines[j].trim()) j++
      if (j < lines.length && isTitleLine(lines[j]) && !SEP_LINE.test(lines[j]) && !isCodeLine(lines[j])) {
        out.push('', `**${lines[j].trim()}**`, '')
        i = j
      }
      continue
    }
    if (isCodeLine(line)) {
      code.push(line)
      continue
    }
    flushCode(code, out)
    if (!line.trim()) {
      out.push('')
      continue
    }
    // 들여쓴 산문(섹션 본문 등)은 마크다운의 4칸 규칙(코드 블록)에 걸리지 않게 앞 공백을 벗긴다 —
    // 단, 불릿은 목록 중첩이 들여쓰기에 걸려 있으므로 그대로 둔다.
    const dedented = /^\s{4,}/.test(line) && !/^\s*[*-]\s/.test(line) ? line.trimStart() : line
    out.push(backtickTerms(dedented))
  }
  flushCode(code, out)
  // 3연속 이상 빈 줄만 정리 (마크다운은 2개까지는 알아서 접는다)
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 플레인 텍스트 툴팁용(.lh-tokdesc) — 첫 산문 문단만, 백틱·구분선·코드 줄 제거.
 * 카드 안 타입 토큰에 마우스를 올렸을 때 뜨는 한 줄짜리 설명이라 전체 문서는 과하다.
 */
export function versePlainDoc(text: string): string {
  if (!text) return text
  const para: string[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      if (para.length) break // 첫 문단 끝
      continue
    }
    if (SEP_LINE.test(line) || isCodeLine(line) || /^\s*```/.test(line)) {
      if (para.length) break
      continue
    }
    para.push(line.trim())
  }
  return para.join(' ').replace(/`/g, '')
}
