import crypto from 'node:crypto'
import pack from './ue-doc-ko.json'

/* ============================================================
 * UE C++ 공식 주석 한국어 번역 — Verse(verseDocKo)와 같은 구조.
 * clangd 호버에는 엔진 소스의 /** … *\/ 주석이 그대로 실린다(영어).
 * 문단(빈 줄 구분) 단위로 정규화(공백 접기)·sha1 해시해 번역 팩에서
 * 찾고, 있으면 그 문단만 한국어로 바꾼다. 팩에 없는 문단(멤버 주석·
 * 신규 API·사용자 코드)은 영어 원문 그대로 — 호버가 깨지지 않는다.
 *
 * 팩 생성: scripts/ue-doc-extract.cjs 가 엔진 소스에서 핵심 타입의
 * 주석을 추출·해시하고, 번역은 ue-doc-ko.json 에 해시→한국어로 든다.
 * ============================================================ */

const PACK = pack as Record<string, string>

let enabled = true // 기본 켬 — Verse와 동일 (설정 ▸ 코드 분석 ▸ C/C++ 행에서 끔)

/** UE 공식 문서 한국어 켬/끔 — `ueDocLang` UI pref('en'=끔)로 구동. 바뀌었으면 true. */
export function setUeDocKo(on: boolean): boolean {
  const changed = enabled !== on
  enabled = on
  return changed
}

const keyOf = (s: string): string =>
  crypto.createHash('sha1').update(s.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12)

/**
 * clangd 호버 마크다운의 텍스트 문단들을 번역 팩으로 치환한다. ``` 펜스 안(시그니처/코드)과
 * 헤더·메타 줄은 어떤 해시와도 일치하지 않으므로 자연히 그대로 남는다. 꺼져 있으면 no-op.
 */
export function translateUeHover(md: string): string {
  if (!enabled || !md) return md
  const lines = md.split('\n')
  const out: string[] = []
  let block: string[] = []
  let inFence = false
  const flush = (): void => {
    if (!block.length) return
    const text = block.join('\n')
    const ko = PACK[keyOf(text)]
    out.push(ko ?? text)
    block = []
  }
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flush()
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    // 구분선·헤더·clangd 메타 줄은 그 자체로 블록 경계다 — 빈 줄 없이 문단과 붙어 와도
    // (clangd가 실제로 그렇게 보낸다) 문단 해시에 섞이지 않게 앞뒤를 끊는다.
    if (/^\s*(?:-{3,}\s*$|###\s|→|provided by\b|Type:|Value =|Offset:\s*\d|Size:\s*\d|Parameters:\s*$)/.test(line)) {
      flush()
      out.push(line)
      continue
    }
    if (!line.trim()) {
      flush()
      out.push(line)
      continue
    }
    block.push(line)
  }
  flush()
  return out.join('\n')
}
