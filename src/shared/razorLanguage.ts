import type { HLJSApi, Language, Mode } from 'highlight.js'
import csharp from 'highlight.js/lib/languages/csharp'

/** Lexical fallback while Roslyn loads the project; semantic tokens refine it. */
export function razor(hljs: HLJSApi): Language {
  const cs = csharp(hljs)
  // Leave block delimiters to our balanced modes, including nested classes/methods.
  const codeModes = (cs.contains ?? []).map((mode) => {
    if (mode.beginKeywords === 'class interface' || mode.beginKeywords === 'namespace'
      || mode.beginKeywords === 'record' || mode.className === 'function') {
      return { ...mode, excludeEnd: false, returnEnd: true }
    }
    return mode
  })
  const braces: Mode = { begin: /\{/, end: /\}/, keywords: cs.keywords, contains: [] }
  const parens: Mode = { begin: /\(/, end: /\)/, keywords: cs.keywords, contains: [] }
  const brackets: Mode = { begin: /\[/, end: /\]/, keywords: cs.keywords, contains: [] }
  const nested = [...codeModes, braces, parens, brackets]
  braces.contains = nested
  parens.contains = nested
  brackets.contains = nested
  return {
    name: 'Razor',
    aliases: ['cshtml', 'aspnetcorerazor'],
    subLanguage: 'xml',
    contains: [
      hljs.COMMENT(/@\*/, /\*@/),
      // Keep Razor transitions inside HTML comments and JS/CSS literals inert.
      { begin: /<!--/, end: /-->/, subLanguage: 'xml' },
      { begin: /<script\b[^>]*>/i, end: /<\/script\s*>/i, subLanguage: 'xml' },
      { begin: /<style\b[^>]*>/i, end: /<\/style\s*>/i, subLanguage: 'xml' },
      { match: /@@/, relevance: 0 },
      {
        begin: [/@(?:code|functions)\b/, /\s*/, /\{/],
        beginScope: { 1: 'keyword' },
        end: /\}/, keywords: cs.keywords, contains: nested
      },
      {
        begin: [/@/, /\{/], beginScope: { 1: 'keyword' },
        end: /\}/, keywords: cs.keywords, contains: nested
      },
      {
        begin: /@(?:if|else|foreach|for|while|switch|lock|try|catch|finally|using)(?=\s*\()/,
        beginScope: 'keyword', end: /(?=\{)/, keywords: cs.keywords, contains: nested
      },
      {
        begin: /@(?:page|using|inject|inherits|implements|namespace|layout|typeparam|attribute|rendermode|model|addTagHelper|removeTagHelper|tagHelperPrefix|preservewhitespace)\b/,
        beginScope: 'keyword', end: /$/, keywords: cs.keywords, contains: codeModes
      },
      { match: /@(?:bind(?:-[\w]+)?|on\w+|key|ref|attributes)(?::[\w]+)?\b/, scope: 'keyword' },
      { match: /@:/, scope: 'keyword' },
      {
        begin: [/@/, /\(/], beginScope: { 1: 'keyword' },
        end: /\)/, keywords: cs.keywords, contains: nested
      },
      {
        begin: /@(?:await\s+)?[A-Za-z_]\w*/, beginScope: 'variable',
        end: /(?=[^\w.?![(])/, keywords: cs.keywords, contains: [parens, brackets],
        relevance: 0
      }
    ]
  }
}
