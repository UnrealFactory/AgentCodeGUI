import type { HLJSApi, Language, Mode } from 'highlight.js'
import { VERSE_SPECIFIER_NAMES } from '@shared/verseKeywords'
import { VERSE_NAME_TRAIL } from '@shared/verseSyntax'

// highlight.js grammar for Epic's Verse language (.verse). Grounded in the UE6.0 source
// corpus AND cross-checked against Epic's own VS Code Verse grammar (verse.json, scope
// source.verse) shipped inside Verse.vsix. Verse exposes NO semantic tokens (verse-lsp ships
// none — it answers only hover/definition/workspace-symbol, no semanticTokens, no
// documentSymbol), and its naming convention doesn't separate fields from locals, so coloring
// is regex-only and cannot tell a member from a local/parameter, nor a definition from a use.
// Epic's grammar sidesteps this by colouring definition-vs-use; we instead colour by the
// IDE-familiar category that IS lexically recoverable — function / type / variable:
//   • a name before '(' is a FUNCTION (call or definition head) → `title.function`
//     (→ --code-fn). Keeps functions visually distinct from variables.
//   • a type-definition name (`Name := class|struct|enum|interface|module`) → `title.class`
//     (→ --code-type).
//   • EVERY other identifier — field, parameter, local, member access, variable read, type
//     use — is a VARIABLE → `variable` (→ --code-member). One colour, because nothing in the
//     text separates member from local or definition from use.
//   • keywords + built-in primitive types stay keyword-coloured (app convention).
// Strings, comments, numbers, @attributes and <specifiers> are scoped as before. Colour-only.

// Effect, access and declaration specifiers that appear between angle brackets, e.g.
// <native>, <public>, <transacts>, <getter(GetX)>. Listing them explicitly (rather than
// matching any <word>) keeps the '<' comparison operator from being read as a specifier.
// The list is shared with the @/<' autocomplete (verseKeywords.ts) so colouring + completion
// never drift; its order matters here — longer variants precede their prefixes (final_super_base
// → final_super → final) so the alternation matches the whole token.
const SPECIFIERS = VERSE_SPECIFIER_NAMES.join('|')

// Reserved words. KEYWORDS also includes the built-in primitive types (coloured like `class`,
// matching how Rider colours `int`/`void`) and the control/declaration words (in/is/of/with/
// until/catch/over/next/yield/ref/alias). Listing them does double duty: the keyword engine
// colours them, AND the NOT_KW guard keeps the function/variable rules from swallowing them.
const KEYWORDS = [
  'using', 'import', 'module', 'class', 'struct', 'enum', 'interface',
  'if', 'else', 'for', 'while', 'loop', 'case', 'block', 'defer', 'return',
  'break', 'continue', 'spawn', 'branch', 'sync', 'rush', 'race', 'then',
  'do', 'where', 'var', 'set', 'option', 'profile', 'test', 'not', 'and', 'or',
  'super', 'Self', 'live', 'await', 'upon', 'when', 'batch',
  'ref', 'alias', 'in', 'is', 'with', 'until', 'catch', 'of', 'at', 'over', 'next', 'yield',
  'int', 'float', 'string', 'logic', 'void', 'char', 'char32', 'char8',
  'rational', 'any', 'comparable', 'tuple', 'array', 'map', 'weak_map', 'type', 'subtype',
  'generator', 'message'
  // NOTE: `vector3`/`vector2`/`rotation`/`transform`/`color` are NOT keywords — they're std-lib
  // STRUCTS (/Verse.org/SpatialMath, …), so they must read in the struct colour, not keyword-blue.
  // Kept OUT of KEYWORDS so they fall through to the VARIABLE rule → recolorVerse promotes them to
  // the struct colour from the registry (with a built-in fallback in verseMembers for the no-digest
  // case). Only genuine primitives (int/float/…) stay here, coloured like a class as Rider does.
]
const LITERALS = ['true', 'false']
const BUILT_INS = ['external']

export function verse(hljs: HLJSApi): Language {
  // A negative look-ahead that fails on any reserved word, so the function/variable identifier
  // rules never consume a keyword — the keyword engine still colours it.
  const NOT_KW = `(?!(?:${[...KEYWORDS, ...LITERALS, ...BUILT_INS].join('|')})\\b)`
  // A run of <…> specifiers — used to look past `Name<native>(` to the '(' that marks a call.
  const SPECS = '(?:<[^>]*>)*'

  // <native>, <public>, <override>, <getter(GetX)> … — effect/access/decl specifiers.
  // Sub-scope 'meta.specifier' emits `hljs-meta specifier_`; the `specifier_` class
  // (Verse-only) lets styles.css tint every <…> specifier with the struct colour.
  const SPECIFIER: Mode = {
    scope: 'meta.specifier',
    match: new RegExp(`<(?:${SPECIFIERS})(?:\\([^)]*\\))?>`)
  }
  // @doc("…"), @editable, @replicated("RepNotify") … → annotation/meta colour.
  const ATTRIBUTE: Mode = {
    scope: 'meta',
    match: /@[a-z_][A-Za-z0-9_]*/
  }
  // Verse block comments nest, so contain self.
  const BLOCK_COMMENT: Mode = {
    scope: 'comment',
    begin: /<#/,
    end: /#>/,
    contains: ['self']
  }
  // Double-quoted string with backslash escapes and "{expr}" interpolation. Strings can span
  // lines (multi-line @doc bodies), so the mode is not line-bounded.
  const STRING: Mode = {
    scope: 'string',
    begin: /"/,
    end: /"/,
    contains: [hljs.BACKSLASH_ESCAPE, { scope: 'subst', begin: /\{/, end: /\}/ }]
  }
  const CHAR: Mode = {
    scope: 'string',
    begin: /'/,
    end: /'/,
    contains: [hljs.BACKSLASH_ESCAPE]
  }
  const NUMBER: Mode = {
    scope: 'number',
    match: /\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?\b/,
    relevance: 0
  }
  // A Verse module path `/Verse.org/Simulation`, `/Fortnite.com/Devices@1.0` — the argument of
  // `using { … }` / `import` and qualified references. Coloured as one token in the module/type
  // colour (like an external-module receiver), not split into stray identifiers. The look-behind
  // `(?<![\w)\]])` keeps it off division `a/b` (whose '/' follows a value); a path's '/' is
  // immediately followed by a letter and sits after `{`/`(`/`,`/whitespace.
  const PATH: Mode = {
    scope: 'type',
    match: /(?<![\w)\]])\/[A-Za-z_][\w.@/-]*/
  }
  // '?' is Verse's option operator (`?t`, `?Name`, `x?`); Verse has no ternary, so colour it
  // like a keyword. Listed before the identifier rules so a leading '?Name' splits cleanly.
  const OPTION_OP: Mode = {
    scope: 'keyword',
    match: /\?/
  }

  // Type definition: `Name<…>(typeparams)? := class|struct|enum|module|interface`. Kept on the type
  // colour. Tried before FUNCTION/VARIABLE so the type name wins — VERSE_NAME_TRAIL이 파라미터형
  // 타입(`chat_channel<…>(t:subtype(…)) := class…`)의 괄호도 지나가므로, FUNCTION('(' 앞 이름)보다
  // 먼저 타입으로 칠해진다.
  const TYPE_DEF: Mode = {
    scope: 'title.class',
    match: new RegExp(
      `\\b${NOT_KW}[A-Za-z_]\\w*(?=[ \\t]*${VERSE_NAME_TRAIL}[ \\t]*:=[ \\t]*(?:class|struct|enum|module|interface)\\b)`
    ),
    relevance: 0
  }
  // A name immediately before '(' (after any <specs>) is a FUNCTION — a call or a definition
  // head (`OnHit(…):void=`, `Subscribe(…)`, `ComputeDamage(…)`). Functions get the function
  // colour so they read distinctly from variables. NOT_KW skips keywords like `if (`.
  const FUNCTION: Mode = {
    scope: 'title.function',
    match: new RegExp(`\\b${NOT_KW}[A-Za-z_]\\w*(?=${SPECS}[ \\t]*\\()`),
    relevance: 0
  }
  // A name right after a '.' is a member ACCESS (`TickEvents.PrePhysics`, `Self.Health`) — it
  // is always a member, including inherited / external-module members that the file-scan can't
  // see. Scoped 'property' (→ member colour) and, unlike 'variable', NOT stripped by the
  // member-field recolor pass, so dotted members stay coloured regardless of the scan. A dotted
  // *call* (`obj.Method(`) is caught by FUNCTION above (listed first), so it stays a function.
  const MEMBER_ACCESS: Mode = {
    scope: 'property',
    match: new RegExp(`(?<=\\.)${NOT_KW}[A-Za-z_]\\w*`),
    relevance: 0
  }
  // NOTE: we deliberately do NOT guess "lowercase identifier = type" here. That convention
  // (types snake_case, the rest PascalCase) is unenforced, so it mis-colours lowercase locals
  // (`abs := 10`) as types. Instead every plain identifier is a VARIABLE (default colour) and
  // recolorVerse promotes only the ones CONFIRMED to be types/members by the registry + file scan.
  // Every other identifier — PascalCase field, parameter, local, variable read — is a VARIABLE.
  // Verse exposes no info to split member from local or definition from use, so they share one
  // colour (the member-field recolor pass then keeps members and drops the rest). NOT_KW keeps
  // keywords keyword-coloured. Listed last, so the rules above claim their names first.
  const VARIABLE: Mode = {
    scope: 'variable',
    match: new RegExp(`\\b${NOT_KW}[A-Za-z_]\\w*`),
    relevance: 0
  }

  return {
    name: 'Verse',
    aliases: ['verse'],
    case_insensitive: false,
    keywords: {
      keyword: KEYWORDS,
      literal: LITERALS,
      built_in: BUILT_INS
    },
    contains: [
      BLOCK_COMMENT,
      hljs.COMMENT(/#/, /$/),
      ATTRIBUTE,
      SPECIFIER,
      STRING,
      CHAR,
      NUMBER,
      PATH,
      OPTION_OP,
      TYPE_DEF,
      FUNCTION,
      MEMBER_ACCESS,
      VARIABLE
    ]
  }
}

export default verse
