import hljs from 'highlight.js/lib/common'
import { verse } from './verseLang'
import { verseScopes, recolorVerse } from './verseMembers'

// Epic's Verse (.verse) isn't part of the hljs common bundle — register our corpus-based
// grammar once so highlightCode('verse') colours it like any built-in language.
hljs.registerLanguage('verse', verse)

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
      return lang === 'verse' ? recolorVerse(value, verseScopes(code)) : value
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
