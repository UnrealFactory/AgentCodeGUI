import type { HLJSApi, Language, Mode } from 'highlight.js'

// highlight.js grammar for Epic's Verse language (.verse). Grounded in the UE6.0 source
// corpus (~227 files): specifiers (<native>/<public>/<transacts>…), attributes
// (@doc/@editable…), declaration kinds (class/struct/enum/module/interface), the core
// primitive types and control-flow keywords, line (#) and nestable block (<# … #>)
// comments. We emit only the standard hljs scopes so the app's IntelliJ-default palette
// (.hljs-keyword/type/string/comment/number/meta/title.*) colours Verse like every other
// language — the one exception is the <…> specifier sub-scope 'meta.specifier', tinted the
// struct colour by a Verse-specific styles.css rule. Epic ships no Verse LSP with open-source
// UE, so this is colour-only (no semantic tokens / symbol outline).

// Effect, access and declaration specifiers that appear between angle brackets, e.g.
// <native>, <public>, <transacts>, <getter(GetX)>. Listing them explicitly (rather than
// matching any <word>) keeps the '<' comparison operator from being read as a specifier.
// Ordered by frequency in the corpus, then the remaining documented ones.
const SPECIFIERS = [
  'native_callable', 'native', 'public', 'private', 'protected', 'internal',
  'epic_internal', 'transacts', 'computes', 'reads', 'writes', 'decides', 'varies',
  'converges', 'suspends', 'no_rollback', 'allocates', 'override', 'final_super_base',
  'final_super', 'final', 'abstract', 'unique', 'concrete', 'open', 'closed', 'castable',
  'constructor', 'getter', 'setter', 'predicts', 'persistable', 'persistent', 'localizes',
  'uht_comparable', 'scoped', 'module_scoped_var_weak_map_key', 'mesh_part_field'
].join('|')

export function verse(hljs: HLJSApi): Language {
  // <native>, <public>, <override>, <transacts>, <getter(GetX)> … — effect/access/decl
  // specifiers. Sub-scope 'meta.specifier' emits `hljs-meta specifier_`; the `specifier_`
  // class (Verse-only) lets styles.css tint every <…> specifier with the struct colour
  // (--code-type-2) so they read distinctly from class names (--code-type, same purple) and
  // from @attributes, which keep the plain 'meta' colour below.
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
  // Double-quoted string with backslash escapes and "{expr}" / {0u004d} interpolation.
  // Strings can span lines (multi-line @doc bodies), so the mode is not line-bounded.
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
  // A run of specifiers like <public><native><getter(GetX)> — used to look past them.
  const SPECS = '(?:<[a-z_][a-z0-9_]*(?:\\([^)]*\\))?>)*'
  // A name that — after any <specifiers> — is immediately followed by '(' is a function /
  // method definition or call. The trailing-'(' excludes value/message constants.
  // scope is 'title.function' (NOT 'title.function_') — hljs appends the '_' itself, emitting
  // `hljs-title function_` to match the app's .hljs-title.function_ CSS. The extra '_' would
  // make it `function__`, miss the CSS, and fall back to the plain-title (function) colour.
  const FUNCTION: Mode = {
    scope: 'title.function',
    match: new RegExp(`\\b[A-Z][A-Za-z0-9_]*(?=${SPECS}[ \\t]*\\()`),
    relevance: 0
  }
  // The name at the head of a type definition: `Name<…> := class|struct|enum|module|interface`
  // (allows PascalCase like `Test` as well as snake_case like `mesh_component`).
  const TYPE_DEF: Mode = {
    scope: 'title.class',
    match: new RegExp(`\\b[A-Za-z_][A-Za-z0-9_]*(?=[ \\t]*(?:<[^>]*>)*[ \\t]*:=[ \\t]*(?:class|struct|enum|module|interface)\\b)`),
    relevance: 0
  }
  // A declared name annotated with a type — `Name<…>:type` — i.e. a field, property,
  // parameter or typed var/let. The ':' (not ':=') after any specifiers marks the binding
  // name; gets the member colour. Tried after FUNCTION/TYPE_DEF so those win their forms.
  const FIELD: Mode = {
    scope: 'variable',
    match: new RegExp(`\\b[A-Za-z_][A-Za-z0-9_]*(?=${SPECS}[ \\t]*:(?!=))`),
    relevance: 0
  }
  // `var X` / `set X` binding with no type annotation (the typed form is caught by FIELD).
  const VAR_NAME: Mode = {
    scope: 'variable',
    match: /(?<=\b(?:var|set)[ \t])[A-Za-z_][A-Za-z0-9_]*/,
    relevance: 0
  }
  // super / Self read like keywords (blue). But `(super:)` / `Self(` would be grabbed by FIELD
  // (name before ':') or FUNCTION (Name before '(') first, so match them explicitly and list
  // this mode AHEAD of those in `contains` — otherwise the keyword colour never applies.
  const SPECIAL: Mode = {
    scope: 'keyword',
    match: /\b(?:super|Self)\b/
  }
  // '?' is Verse's option operator — optional type `?t`, optional param `?Name`, unwrap `x?`.
  // Verse has no ternary, so every '?' is this operator: colour it like a keyword (blue).
  // (Listed after STRING/comments in `contains`, so '?' inside those isn't matched.)
  const OPTION_OP: Mode = {
    scope: 'keyword',
    match: /\?/
  }

  return {
    name: 'Verse',
    aliases: ['verse'],
    case_insensitive: false,
    keywords: {
      keyword: [
        'using', 'import', 'module', 'class', 'struct', 'enum', 'interface',
        'if', 'else', 'for', 'while', 'loop', 'case', 'block', 'defer', 'return',
        'break', 'continue', 'spawn', 'branch', 'sync', 'rush', 'race', 'then',
        'do', 'where', 'var', 'set', 'option', 'profile', 'test', 'not', 'and', 'or',
        // special names + reactive (live-variable) keywords
        'super', 'Self', 'live', 'await', 'upon', 'when', 'batch',
        // Built-in data types are coloured like keywords (blue), same as `class` — matching
        // how Rider/C# colour `int`/`void`/`bool`. (Type-DEFINITION names stay the type colour
        // via TYPE_DEF → title.class_, so they remain distinct from these.)
        'int', 'float', 'string', 'logic', 'void', 'char', 'char32', 'char8',
        'rational', 'any', 'comparable', 'tuple', 'array', 'map', 'weak_map', 'type', 'subtype',
        'generator', 'message', 'vector3', 'vector2', 'rotation', 'transform', 'color'
      ],
      literal: ['true', 'false'],
      built_in: ['external']
    },
    contains: [BLOCK_COMMENT, hljs.COMMENT(/#/, /$/), ATTRIBUTE, SPECIFIER, STRING, CHAR, NUMBER, OPTION_OP, SPECIAL, TYPE_DEF, FUNCTION, FIELD, VAR_NAME]
  }
}

export default verse
