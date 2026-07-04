import hljs from 'highlight.js/lib/common'
import { verse } from './verseLang'
import { verseScopes, recolorVerse } from './verseMembers'
import { UE_SPECIFIERS } from '@shared/langGlossary'

// Epic's Verse (.verse) isn't part of the hljs common bundle — register our corpus-based
// grammar once so highlightCode('verse') colours it like any built-in language.
hljs.registerLanguage('verse', verse)

// ── UE C++ 매크로 지정자 recolor ─────────────────────────────────────────────
// UPROPERTY(EditAnywhere…) 괄호 안의 지정자는 언리얼 헤더 툴(UHT) 전용 토큰이라 hljs도
// clangd 시맨틱 토큰도 색을 주지 않는다 — recolorVerse처럼 hljs HTML을 후처리해, 그 매크로에
// 유효한 지정자 이름만 클래스와 같은 타입 색(.hljs-title.class_ = --code-type)으로 칠한다.
// 매크로별 유효 지정자 집합 (공유 UE_SPECIFIERS에서 파생 — 호버·완성과 같은 출처).
// UHT 지정자는 대소문자 무관(`config=Game`·`hidecategories=…`)이라 소문자 키로 든다.
const UE_SPEC_NAMES = new Map<string, Set<string>>()
for (const s of UE_SPECIFIERS)
  for (const m of s.macros) {
    let set = UE_SPEC_NAMES.get(m)
    if (!set) UE_SPEC_NAMES.set(m, (set = new Set()))
    set.add(s.name.toLowerCase())
  }
const UE_MACRO_NAME = /\b(UPROPERTY|UFUNCTION|UCLASS|USTRUCT|UENUM|UINTERFACE|UMETA|UPARAM)\b/g

function recolorUeCpp(html: string): string {
  UE_MACRO_NAME.lastIndex = 0
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = UE_MACRO_NAME.exec(html))) {
    const specs = UE_SPEC_NAMES.get(m[1])
    if (!specs) continue
    // 매크로 이름 뒤 (닫는 태그·공백을 건너뛰고) '('가 와야 매크로 호출이다
    let i = m.index + m[0].length
    while (i < html.length) {
      if (html[i] === '<') {
        const e = html.indexOf('>', i)
        if (e < 0) break
        i = e + 1
      } else if (html[i] === ' ' || html[i] === '\t') i++
      else break
    }
    if (html[i] !== '(') continue
    // 괄호 균형으로 인자 구간을 찾는다 — 태그(<span…>) 안은 세지 않고, 관례상 한 줄이므로
    // 개행을 만나면(균형이 안 맞은 채) 포기한다(파일 전체를 삼키는 오탐 방지)
    let depth = 0
    let j = i
    for (; j < html.length; j++) {
      const c = html[j]
      if (c === '<') {
        const e = html.indexOf('>', j)
        if (e < 0) {
          j = html.length
          break
        }
        j = e
        continue
      }
      if (c === '\n') break
      if (c === '(') depth++
      else if (c === ')' && --depth === 0) break
    }
    if (depth !== 0 || j >= html.length) continue
    // 인자 구간에서 태그 밖(span 깊이 0 = 문자열/주석 토큰 밖) 텍스트의 지정자 이름만 감싼다
    const args = html.slice(i + 1, j)
    let colored = ''
    let sd = 0
    let k = 0
    while (k < args.length) {
      if (args[k] === '<') {
        const e = args.indexOf('>', k)
        if (e < 0) {
          colored += args.slice(k)
          break
        }
        sd += args[k + 1] === '/' ? -1 : 1
        colored += args.slice(k, e + 1)
        k = e + 1
        continue
      }
      const mm = /^[A-Za-z_]\w*/.exec(args.slice(k))
      if (mm) {
        colored += sd === 0 && specs.has(mm[0].toLowerCase()) ? `<span class="hljs-title class_">${mm[0]}</span>` : mm[0]
        k += mm[0].length
        continue
      }
      colored += args[k]
      k++
    }
    out += html.slice(last, i + 1) + colored
    last = j
    UE_MACRO_NAME.lastIndex = j
  }
  return out + html.slice(last)
}

// escape the three HTML-significant chars so raw code can be dropped into innerHTML safely
function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
}

// Highlighting is synchronous on the UI thread — past these sizes it turns from
// "colors" into "the app froze", so bigger blocks render as escaped plain text.
// Auto-detect runs EVERY grammar over the block (many× the cost), hence its far
// lower cap. Mirrors the viewer's own HL_LIMIT.
const HL_MAX = 200_000
const HL_AUTO_MAX = 20_000

// highlight.js → HTML. Uses the named language when hljs knows it, falls back to
// auto-detect, then to plain escaped text. Shared by the markdown renderer and the
// file viewer card so both produce identically-themed `.hljs-*` token markup.
export function highlightCode(code: string, lang: string): string {
  try {
    if (lang && hljs.getLanguage(lang)) {
      if (code.length > HL_MAX) return escapeHtml(code)
      const value = hljs.highlight(code, { language: lang }).value
      // Verse has no LSP semantic tokens; recover member fields by a whole-file scan and keep
      // only those identifiers on the member colour (locals/params/uses of non-members drop to
      // default). Both the viewer and the editor go through here, so both get it.
      if (lang === 'verse') return recolorVerse(value, verseScopes(code))
      // C/C++: UE 매크로 괄호 안 지정자(EditAnywhere…)를 클래스와 같은 타입 색으로
      if (lang === 'cpp' || lang === 'c') return recolorUeCpp(value)
      return value
    }
    if (code.length > HL_AUTO_MAX) return escapeHtml(code)
    return hljs.highlightAuto(code).value
  } catch {
    return escapeHtml(code)
  }
}

// highlight.js → per-line HTML. hljs token <span>s can cross newlines (template
// strings, block comments), so a naive split would break the markup — this
// re-balances the tags: spans still open at a line's end are closed there and
// re-opened at the start of the next line. Lets the file viewer render each line
// as its own element (LSP hit-testing + line jumps) with identical colors.
export function highlightToLines(code: string, lang: string): string[] {
  const html = highlightCode(code, lang)
  const tagRe = /<span[^>]*>|<\/span>/g
  const stack: string[] = []
  return html.split('\n').map((line) => {
    const reopened = stack.join('')
    let m: RegExpExecArray | null
    tagRe.lastIndex = 0
    while ((m = tagRe.exec(line))) {
      if (m[0] === '</span>') stack.pop()
      else stack.push(m[0])
    }
    return reopened + line + '</span>'.repeat(stack.length)
  })
}
