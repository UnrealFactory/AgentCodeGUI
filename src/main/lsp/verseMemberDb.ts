import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LspCompletionItem, LspPos, VerseRegistry } from '../../shared/protocol'
import { VERSE_BUILTIN_KIND } from '../../shared/protocol'
import { verseIndent as indentOf, verseDocPiece, verseEnclosingLine, verseBlockStart, VERSE_NAME_TRAIL } from '../../shared/verseSyntax'
import { verseWorkspaceFolders } from './verse'
import { translateVerseDoc } from './verseDocKo'
import { versePlainDoc } from './verseDocFormat'

/* ============================================================
 * Verse member completion DB — the gap verse-lsp leaves open.
 *
 * verse-lsp returns the lexical SCOPE (locals + Self members +
 * globals) for a member access while you type, NOT the receiver's
 * members — and nothing for a struct trailing dot. So `weapon_kind.`
 * never offers `Sword/Bow/Staff`, `someStruct.` never offers its
 * fields, etc. Proven 2026-06-25 it's a server limit, not a client
 * one (VS Code drives the same exe the same way and hits it too).
 *
 * The member DATA is on disk: the generated digests (`*.digest.verse`,
 * full engine/std-lib API as plain Verse text) plus the project's own
 * `.verse` files. We scan both into a `type → members` map.
 *
 * Two halves, each by the tool that's good at it:
 *  • TYPE RESOLUTION ("what type is the receiver?") — verse-lsp HOVER
 *    accurately tracks it (manager.completion calls hover, parses the
 *    type with verseTypeFromHover). Regex (verseResolveTypeRegex) is
 *    a cold/failure fallback.
 *  • MEMBER ENUMERATION ("list that type's members") — our scan map
 *    (verseTypeMembers), incl. inherited via supers. verse-lsp can't.
 * ============================================================ */

type MemberKind = 'field' | 'method' | 'enumMember'
interface VMember {
  name: string
  sig: string
  mkind: MemberKind
  write?: string // a `var<…>` member's SETTER (write) access — verse-lsp's hover omits it
  private?: boolean // `<private>`/`<epic_internal>` — hidden from EXTERNAL access, but visible inside the declaring class
}
interface VType {
  kind: string // class | struct | enum | interface
  supers: string[]
  members: VMember[]
  doc?: string // the `#`/`@doc(...)` comment immediately above the declaration
}

// type declaration:  Name<specs>(typeparams) := class|struct|enum|interface <specs> (supers) :
// VERSE_NAME_TRAIL — 타입 매개변수 안의 중첩 괄호(`subtype(member_info_interface)` 등)까지 지나간다.
// 전엔 `\([^()]*\)`라 digest의 chat_channel 같은 파라미터형 클래스가 통째로 등록되지 않았다.
const TYPE_DECL = new RegExp(
  String.raw`^([A-Za-z_]\w*)${VERSE_NAME_TRAIL}\s*:=\s*(class|struct|enum|interface)\b((?:<[^>]*>)*)\s*(?:\(([^]*)\))?\s*:?\s*(?:#.*)?$`
)
const stripQual = (s: string): string => s.replace(/^\(\s*\/[^)]*?:\s*\)/, '') // strip `(/Verse.org/…:)`
// a type reference → its base simple name (drop ?/^ option/pointer prefixes, type-args, specifiers)
const baseType = (t: string): string =>
  (t || '')
    .trim()
    .replace(/^[?^]+/, '')
    .replace(/[(<].*$/, '')
    .trim()

// module-scope free declarations — a `module` container, a free function (has a param list), or a
// free constant/var (`Name:T=…` / `Name:=…`). Used to recover top-level symbols verse-lsp drops mid-edit.
const MODULE_DECL = /^([A-Za-z_]\w*)(?:<[^>]*>)*\s*:=\s*module\b/
const FREE_FN = /^([A-Za-z_]\w*)((?:<[^>]*>)*)\(([^]*?)\)((?:<[^>]*>)*)\s*:\s*([^=]+?)\s*=/
const FREE_BIND = /^([A-Za-z_]\w*)(?:<[^>]*>)*\s*:(?:=|\s*[^=]+=)/
// a single-line function/method header `Name<specs>(params)<eff>:ret =` (the `=` opens the body).
// `:(?!=)` — 파라미터형 타입 선언(`name<…>(t:…) := class…`)의 `:=`를 반환형으로 오인하지 않게.
const FN_HEADER = /^([A-Za-z_]\w*)(?:<[^>]*>)*\s*\(([^]*?)\)(?:<[^>]*>)*\s*:(?!=)[^=]*=/

/** Scan Verse source text → register types + their direct members into `types`. */
export function parseVerseTypes(types: Map<string, VType>, text: string): void {
  const lines = text.split(/\r?\n/)
  const stack: { indent: number; name: string; kind: string }[] = []
  // doc 주석 버퍼 — 선언 바로 위의 doc 조각을 모았다가 타입 선언에 붙인다. 분류는 공유
  // verseDocPiece — verse.ts의 호버 추출(verseDocAbove)과 같은 분류기라 출력이 byte 단위로
  // 일치하고, 한국어 번역 팩의 sha1(원문) 매칭이 안 어긋난다. 빈 줄/일반 코드 줄에서 비운다.
  let docBuf: string[] = []
  // 여러 줄 `<# … #>` 블록 주석 추적 — 주석 안의 코드 예시(`Foo := class` 등)가 팬텀
  // 타입/멤버로 등록되지 않게 통째로 건너뛴다(parseVerseGlobals·renderer verseScopes와 동일).
  let inBlockComment = false
  for (const raw of lines) {
    const t = raw.trim()
    if (inBlockComment) {
      if (t.includes('#>')) inBlockComment = false
      continue
    }
    if (t.startsWith('<#') && !t.includes('#>')) {
      inBlockComment = true
      docBuf = []
      continue
    }
    const piece = verseDocPiece(t)
    if (piece.type === 'blank') {
      docBuf = []
      continue
    }
    if (piece.type === 'doc') {
      docBuf.push(piece.text)
      continue
    }
    if (piece.type === 'attr') {
      if (piece.text != null) docBuf.push(piece.text) // @doc("…") 본문
      continue // 그 밖의 @속성은 건너뛰고 위쪽 주석을 유지한다
    }
    if (t.startsWith('using') || t.startsWith('import')) {
      docBuf = []
      continue
    }
    const ind = indentOf(raw)
    while (stack.length && ind <= stack[stack.length - 1].indent) stack.pop()
    const parent = stack[stack.length - 1]
    const decl = TYPE_DECL.exec(t)
    if (decl) {
      const name = decl[1]
      const kind = decl[2]
      const supers = (decl[4] || '').split(',').map(baseType).filter(Boolean)
      const doc = docBuf.join('\n').trim() || undefined
      docBuf = []
      const existing = types.get(name)
      if (!existing) types.set(name, { kind, supers, members: [], doc })
      else {
        existing.kind = kind
        if (supers.length) existing.supers = [...new Set([...existing.supers, ...supers])]
        if (doc && !existing.doc) existing.doc = doc
      }
      stack.push({ indent: ind, name, kind })
      continue
    }
    docBuf = [] // 일반 코드 줄(멤버 등) — 다음 선언의 doc로 새지 않게 비운다
    if (!parent) continue
    if (ind !== parent.indent + 1) continue // DIRECT members only — skip method-body statements
    const pt = types.get(parent.name)
    if (!pt) continue
    if (parent.kind === 'enum') {
      const m = /^([A-Za-z_]\w*)\b/.exec(t)
      if (m) pt.members.push({ name: m[1], sig: '', mkind: 'enumMember' })
      continue
    }
    // capture a `var`'s OWN specifiers (`var<private> X<protected>`) — the `<private>` is the SETTER
    // (write) access, separate from the member's own (read) access. verse-lsp's hover drops it.
    const q = stripQual(t)
    const vw = /^var\b((?:<[^>]*>)*)\s+/.exec(q)
    const write = vw ? /<(public|private|protected|internal|epic_internal)>/.exec(vw[1])?.[1] : undefined
    // strip the binding keyword + its specifiers so the privacy check sees only the member's own.
    const s = q.replace(/^(?:var|set)\b(?:<[^>]*>)*\s+/, '')
    // `<private>`/`<epic_internal>` → hidden from OUTSIDE the class, but still visible to its own
    // methods. Keep the member (flagged) instead of dropping it, so bare/`Self.` access inside the
    // class can still offer it; external `obj.` access filters it out at the use site.
    const isPriv = /<(?:private|epic_internal)>/.test(s)
    const m = /^([A-Za-z_]\w*)((?:<[^>]*>)*)(\([^]*?\))?((?:<[^>]*>)*)\s*:?\s*([^=]*)/.exec(s)
    if (m && m[1]) {
      const isFn = !!m[3]
      const ret = m[5] ? m[5].trim() : ''
      const sig = (m[3] || '') + (ret ? (ret.startsWith(':') ? '' : ':') + ret : '')
      pt.members.push({ name: m[1], sig: sig.trim(), mkind: isFn ? 'method' : 'field', write, private: isPriv })
    }
  }
}

/**
 * Scan Verse source → module-scope free functions / constants. NOT type members (parseVerseTypes'
 * job) and NOT function-body locals (scanned live per-caret in verseScopeCompletions). A binding is a
 * "global" only when it's a DIRECT child of top-scope or a `module` block — a type's direct child is a
 * member, and anything deeper sits in a function body, so neither qualifies.
 */
export function parseVerseGlobals(out: VGlobal[], text: string): void {
  const lines = text.split(/\r?\n/)
  const stack: { indent: number; isType: boolean }[] = [] // open type / module containers
  let inBlockComment = false
  for (const raw of lines) {
    const t = raw.trim()
    if (inBlockComment) {
      if (t.includes('#>')) inBlockComment = false
      continue
    }
    if (t.startsWith('<#') && !t.includes('#>')) {
      inBlockComment = true
      continue
    }
    if (!t || t.startsWith('#') || t.startsWith('@') || t.startsWith('using') || t.startsWith('import')) continue
    const ind = indentOf(raw)
    while (stack.length && ind <= stack[stack.length - 1].indent) stack.pop()
    const top = stack[stack.length - 1]
    if (TYPE_DECL.test(t)) {
      stack.push({ indent: ind, isType: true })
      continue
    }
    if (MODULE_DECL.test(t)) {
      stack.push({ indent: ind, isType: false })
      continue
    }
    const directChild = top ? ind === top.indent + 1 : ind === 0
    if (!directChild || top?.isType) continue // a member, or a body-local → not a free global
    const q = stripQual(t)
    const isVar = /^(?:var|set)\b/.test(q)
    const body = q.replace(/^(?:var|set)\b(?:<[^>]*>)*\s+/, '')
    const fn = FREE_FN.exec(body)
    if (fn && !isVar) {
      out.push({ name: fn[1], kind: 3, sig: `(${fn[3].trim()})${fn[4]}:${fn[5].trim()}` })
      continue
    }
    const b = FREE_BIND.exec(body)
    if (b) out.push({ name: b[1], kind: isVar ? 6 : 21 }) // mutable global var → Variable, else Constant
  }
}

/** Collect a type's members incl. inherited (walk supers), deduped by name. */
function collectMembers(get: (n: string) => VType | undefined, name: string, seen: Set<string>, acc: Map<string, VMember>): void {
  if (seen.has(name)) return
  seen.add(name)
  const t = get(name)
  if (!t) return
  for (const m of t.members) if (!acc.has(m.name)) acc.set(m.name, m)
  for (const s of t.supers) collectMembers(get, s, seen, acc)
}

// ── per-project cache of the static data (digests + on-disk project files) ──
interface VGlobal {
  name: string
  kind: number // LSP CompletionItemKind — 3 function · 21 constant · 6 variable
  sig?: string // function signature `(params):ret` (kind 3 only)
  detail?: string // a constant/var's type text, when known
}
interface Cached {
  digest: Map<string, VType>
  project: Map<string, VType>
  globals: VGlobal[] // project module-scope free functions / constants (digests excluded — too many)
  extMethods: Set<string> // names of receiver-based extension methods `(recv:T).Name(…)` — callable ONLY as `recv.Name(…)`
}

// receiver-based extension function: a line that opens with `(receiver:type).Name…`. verse-lsp dumps
// these into the bare-identifier scope even though they need a receiver, so we collect their names to
// strip from identifier completion. e.g. `(Input:[]t where t:type).RemoveElement<public>(IndexToRemove:int)…`
const EXT_METHOD = /^\(.*?\)\s*\.\s*([A-Za-z_]\w*)/

/** Collect receiver-based extension method names from Verse source/digest text. */
export function parseVerseExtMethods(out: Set<string>, text: string): void {
  for (const raw of text.split(/\r?\n/)) {
    const m = EXT_METHOD.exec(raw.trim())
    if (m) out.add(m[1])
  }
}
const cache = new Map<string, Cached>()
// 1-entry memo of the live buffer parse so the 2-3 lookups in one completion don't re-parse it
let liveMemo: { text: string; map: Map<string, VType> } = { text: ' ', map: new Map() }

/** Recursively collect `.verse` files under dir, bounded so a huge tree can't stall completion. */
function findVerseFiles(dir: string, digest: string[], source: string[], budget: { n: number }): void {
  if (budget.n <= 0) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (budget.n <= 0) return
    budget.n-- // count every entry visited so a giant non-Verse tree can't stall the walk
    const full = path.join(dir, e.name)
    if (e.isDirectory()) findVerseFiles(full, digest, source, budget)
    else if (e.name.toLowerCase().endsWith('.digest.verse')) digest.push(full)
    else if (e.name.toLowerCase().endsWith('.verse')) source.push(full)
  }
}

function buildCache(root: string): Cached {
  const digest = new Map<string, VType>()
  const project = new Map<string, VType>()
  const globals: VGlobal[] = []
  const extMethods = new Set<string>()
  const folders = verseWorkspaceFolders(root) ?? []
  const digestFiles: string[] = []
  const sourceFiles: string[] = []
  const budget = { n: 4000 }
  for (const f of folders) {
    let dir: string
    try {
      dir = fileURLToPath(f.uri)
    } catch {
      continue
    }
    findVerseFiles(dir, digestFiles, sourceFiles, budget)
  }
  for (const file of digestFiles) {
    try {
      const txt = fs.readFileSync(file, 'utf8')
      parseVerseTypes(digest, txt)
      parseVerseExtMethods(extMethods, txt)
    } catch {
      /* skip unreadable digest */
    }
  }
  for (const file of sourceFiles) {
    try {
      const txt = fs.readFileSync(file, 'utf8')
      parseVerseTypes(project, txt)
      parseVerseGlobals(globals, txt)
      parseVerseExtMethods(extMethods, txt)
    } catch {
      /* skip unreadable source */
    }
  }
  return { digest, project, globals, extMethods }
}

/** A type lookup over the live buffer (wins) → cached project files → cached digests. */
function getView(root: string, text: string): (n: string) => VType | undefined {
  const key = path.resolve(root).toLowerCase()
  let cached = cache.get(key)
  if (!cached) {
    cached = buildCache(root)
    cache.set(key, cached)
  }
  const c = cached
  if (liveMemo.text !== text) {
    const m = new Map<string, VType>()
    parseVerseTypes(m, text)
    liveMemo = { text, map: m }
  }
  const live = liveMemo.map
  return (n: string): VType | undefined => live.get(n) ?? c.project.get(n) ?? c.digest.get(n)
}

const KIND: Record<MemberKind, number> = { enumMember: 20, field: 5, method: 2 } // LSP CompletionItemKind

/**
 * The receiver of a `Receiver.` / `Receiver.partial` access immediately left of the caret, plus a
 * hover-able position inside that receiver token (for accurate type resolution). null when the caret
 * isn't on a member access.
 */
export function verseMemberContext(text: string, pos: LspPos): { receiver: string; receiverPos: LspPos } | null {
  const line = text.split(/\r?\n/)[pos.line] ?? ''
  const prefix = line.slice(0, pos.character)
  const m = /([A-Za-z_]\w*)\.\s*[A-Za-z_]\w*$|([A-Za-z_]\w*)\.$/.exec(prefix)
  if (!m) return null
  const receiver = m[1] ?? m[2]
  // the regex anchors at the receiver, so m.index is its start column; hover on its last char
  return { receiver, receiverPos: { line: pos.line, character: m.index + receiver.length - 1 } }
}

/**
 * 캐럿이 멤버 접근의 `.` 뒤인가 — verseMemberContext가 못 잡는 비식별자 리시버(`Foo().`,
 * `arr[0].`, 체인 끝의 복합식) 포함. manager.completion이 이때 스코프 후보(지역/전역) 병합을
 * 건너뛰게 한다: 점 바로 뒤에 지역변수 목록이 뜨는 건 명백한 노이즈다. 숫자 리터럴의 소수점
 * (`3.`)은 제외 — 그건 입력 중인 float이지 멤버 접근이 아니다(`x3.` 같은 식별자 꼬리 숫자는 통과).
 */
export function verseDotContext(text: string, pos: LspPos): boolean {
  const line = text.split(/\r?\n/)[pos.line] ?? ''
  const head = line.slice(0, pos.character).replace(/[A-Za-z_]\w*$/, '') // drop the partial member word
  if (!head.endsWith('.')) return false
  return !/(?:^|[^\w.])\d[\d_]*\.$/.test(head) // 토큰 전체가 숫자인 `3.`만 float으로 본다
}

/** Is `name` a type we know (live buffer / project / digests)? Fast, exact path for `TypeName.`. */
export function verseHasType(root: string, text: string, name: string): boolean {
  return !!getView(root, text)(name)
}

/** Extract a base type name from a verse-lsp hover string (`name<specs>:type`, `(/q:)x:?T`, `enum … T`). */
export function verseTypeFromHover(md: string): string | null {
  if (!md) return null
  let s = md.replace(/```[a-z]*|```/g, '').trim()
  const first = s.split('\n')[0].trim()
  // type receiver: hover is `class|struct|enum|interface … Name` → the trailing identifier is the type
  const tm = /^(?:class|struct|enum|interface|module)\b.*?([A-Za-z_]\w*)\s*$/.exec(first)
  if (tm) return tm[1]
  s = first.replace(/\(\/[^)]*?:\)/g, '') // strip `(/path:)` qualifier (its ':' is not the type ':')
  const idx = s.lastIndexOf(':')
  if (idx < 0) return null
  const t = s
    .slice(idx + 1)
    .trim()
    .replace(/^[?^]+/, '')
    .replace(/[<([].*$/, '')
    .trim()
  return /^[A-Za-z_]\w*$/.test(t) ? t : null
}

/** Heuristic (regex) type resolution — fallback when hover is unavailable (cold) or returns nothing. */
export function verseResolveTypeRegex(root: string, text: string, receiver: string, caretLine: number): string | null {
  const get = getView(root, text)
  if (get(receiver)) return receiver
  if (receiver === 'Self') {
    // 진짜 감싸는 클래스만(min-indent walk) — 위쪽의 무관한 클래스가 Self로 오인되지 않게
    const lines = text.split(/\r?\n/)
    const SELF_CLASS = new RegExp(String.raw`^([A-Za-z_]\w*)${VERSE_NAME_TRAIL}\s*:=\s*class\b`)
    const start = verseBlockStart(lines, caretLine)
    const h = verseEnclosingLine(lines, start.line, (t) => SELF_CLASS.test(t), start.indent)
    return h >= 0 ? (SELF_CLASS.exec(lines[h].trim())?.[1] ?? null) : null
  }
  const pats = [
    new RegExp(`\\bvar\\s+${receiver}\\s*(?:<[^>]*>)?\\s*:\\s*([?^]*[A-Za-z_]\\w*)`),
    new RegExp(`(?:^|[\\s(,])${receiver}\\s*:\\s*([?^]*[A-Za-z_]\\w*)\\s*[=,)]`),
    new RegExp(`\\b${receiver}\\s*:=\\s*([A-Za-z_]\\w*)\\s*{`)
  ]
  for (const p of pats) {
    const m = p.exec(text)
    if (m) return baseType(m[1])
  }
  return null
}

/**
 * Completion items for the members (own + inherited) of `typeName`. Empty when the type is unknown.
 * `includePrivate` (set for a `Self.` receiver) keeps the type's `<private>` members — external
 * `obj.` access leaves it false so they stay hidden.
 */
export function verseTypeMembers(root: string, text: string, typeName: string, includePrivate = false): LspCompletionItem[] {
  const get = getView(root, text)
  const acc = new Map<string, VMember>()
  collectMembers(get, typeName, new Set(), acc)
  return [...acc.values()]
    .filter((mb) => includePrivate || !mb.private)
    .map((mb) => ({
    // methods carry their signature in the label (`Name(args):ret`) so the renderer dims it and
    // inserts the call form; fields/enum members show just the name with the type as detail
    label: mb.mkind === 'method' ? mb.name + mb.sig : mb.name,
    kind: KIND[mb.mkind],
    detail: mb.mkind === 'method' ? undefined : mb.sig || undefined,
    insertText: mb.name
  }))
}

// the class/struct/interface whose body truly ENCLOSES the caret — Verse lets you reference its
// members bare. 공유 verseEnclosingLine(min-indent walk)이라 앞서 지나간(감싸지 않는) 클래스는
// 잡지 않는다 — 전엔 자유 함수 본문에서 위쪽 클래스의 멤버가 완성에 누출됐다.
function enclosingTypeName(lines: string[], caretLine: number): string | null {
  const start = verseBlockStart(lines, caretLine)
  const h = verseEnclosingLine(
    lines,
    start.line,
    (t) => {
      const m = TYPE_DECL.exec(t)
      return !!m && m[2] !== 'enum'
    },
    start.indent
  )
  return h >= 0 ? (TYPE_DECL.exec(lines[h].trim())?.[1] ?? null) : null
}

// params + var/walrus/typed locals of the function body enclosing the caret → push(name, 6=Variable).
// Bounded to the ONE truly enclosing function (min-indent walk) so siblings' locals/params don't leak.
function collectEnclosingLocals(lines: string[], caretLine: number, push: (n: string, k: number) => void): void {
  const start = verseBlockStart(lines, caretLine)
  const hi = verseEnclosingLine(lines, start.line, (t) => FN_HEADER.test(t), start.indent)
  if (hi < 0) return
  const headerIndent = indentOf(lines[hi])
  const fh = FN_HEADER.exec(lines[hi].trim())
  if (fh) for (const m of fh[2].matchAll(/(?:^|,)\s*\??\s*([A-Za-z_]\w*)\s*:(?!=)/g)) push(m[1], 6)
  for (let i = hi + 1; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    if (!raw.trim()) continue
    if (indentOf(raw) <= headerIndent) break // dedented back out of the function body
    if (i === caretLine) continue // the line being typed — don't suggest the local you're naming
    const t = raw.trim()
    if (t.startsWith('#') || t.startsWith('@')) continue
    const vm = /^var\s+([A-Za-z_]\w*)/.exec(t) // `set X = …` is a re-assignment, not a new binding
    if (vm) {
      push(vm[1], 6)
      continue
    }
    // walrus bindings (plain, `if (X := …)`, `for (X := …)`) — but not a nested type/module def
    for (const w of t.matchAll(/(?:^|[(,]\s*)\??([A-Za-z_]\w*)\s*:=\s*(?!(?:class|struct|enum|interface|module)\b)/g))
      push(w[1], 6)
    const tl = /^([A-Za-z_]\w*)\s*:\s*[^=]+=/.exec(t) // typed local `Name : type = …`
    if (tl) push(tl[1], 6)
    for (const fm of t.matchAll(/[(,]\s*([A-Za-z_]\w*)\s*:(?!=)\s*[^,)]+/g)) push(fm[1], 6) // `for (X:T = …)`
  }
}

/**
 * Identifier (non-member) completion candidates IN SCOPE at `pos`, scanned from the live buffer +
 * project: the enclosing function's params/locals, the enclosing class's members, and module-scope
 * free functions / constants / type names. verse-lsp returns a lexical scope too — but only while the
 * file COMPILES, which it rarely does mid-edit, so the user's own just-typed symbols vanish. This
 * source makes them ALWAYS appear (manager.completion merges it OVER verse-lsp's list, so our kinds —
 * e.g. function vs variable — win). Engine/std-lib globals still come from verse-lsp when it's warm.
 */
export function verseScopeCompletions(root: string, text: string, pos: LspPos): LspCompletionItem[] {
  const lines = text.split(/\r?\n/)
  // The caret's line is mid-edit: a half-typed identifier on it would be (mis)parsed as a field /
  // global declaration and offered back as a completion of ITSELF (`A` → `A`). Blank it for the
  // symbol scan so a declaration-in-progress never pollutes — symbols declared on OTHER lines are
  // untouched (so an expression like `set X = Heal|` still completes a real `Health`). The enclosing
  // function/class is still detected from the original lines below.
  const scanLines = lines.slice()
  if (pos.line >= 0 && pos.line < scanLines.length) scanLines[pos.line] = ''
  const scanText = scanLines.join('\n')
  const get = getView(root, scanText) // builds the project/digest cache + refreshes the live-buffer parse
  const cached = cache.get(path.resolve(root).toLowerCase())
  const out = new Map<string, LspCompletionItem>() // name → item; first push wins (local > self > global)
  const push = (name: string, kind: number, sig?: string, detail?: string): void => {
    if (!name || out.has(name)) return
    out.set(name, { label: sig ? name + sig : name, kind, detail: detail || undefined, insertText: name })
  }
  // 1) the enclosing function's params + locals — the variable you're writing where you're writing it
  collectEnclosingLocals(lines, pos.line, push)
  // 2) the enclosing class's members (own + inherited) — bare-accessible inside a method. The class's
  //    OWN private members count (a method sees them); INHERITED private members don't (a subclass
  //    can't reach a parent's private).
  const encType = enclosingTypeName(lines, pos.line)
  if (encType) {
    const t0 = get(encType)
    const acc = new Map<string, VMember>()
    if (t0) for (const m of t0.members) if (!acc.has(m.name)) acc.set(m.name, m) // own — private OK
    for (const sup of t0?.supers ?? []) {
      const inh = new Map<string, VMember>()
      collectMembers(get, sup, new Set(), inh)
      for (const m of inh.values()) if (!m.private && !acc.has(m.name)) acc.set(m.name, m) // inherited — no private
    }
    for (const m of acc.values()) {
      const kind = m.mkind === 'method' ? 2 : m.mkind === 'enumMember' ? 20 : 5
      push(m.name, kind, m.mkind === 'method' ? m.sig : undefined, m.mkind === 'method' ? undefined : m.sig)
    }
  }
  // 3) module-scope free functions / constants — this file's (live) + the project's (cached)
  const liveGlobals: VGlobal[] = []
  parseVerseGlobals(liveGlobals, scanText)
  for (const g of liveGlobals) push(g.name, g.kind, g.sig, g.detail)
  if (cached) for (const g of cached.globals) push(g.name, g.kind, g.sig, g.detail)
  // 4) type names — this file's (live) + the project's (engine/digest types come from verse-lsp)
  const addType = (name: string, kind: string): void =>
    push(name, kind === 'class' ? 7 : kind === 'interface' ? 8 : kind === 'enum' ? 13 : 22)
  for (const [name, t] of liveMemo.map) addType(name, t.kind)
  if (cached) for (const [name, t] of cached.project) addType(name, t.kind)
  return [...out.values()]
}

// caret sits in a TYPE-annotation slot — after a `:` that introduces a type (param type, return type,
// `var X : …`, typed field/local), allowing the type-prefix punctuation `? ^ [ ] ( ) ,`. Excludes the
// walrus `:=` (its head ends in `=`, not `:`) and value/name positions. So we can offer types only.
const TYPE_POS = /:\s*[?^[\](),\s]*$/
export function verseIsTypePosition(text: string, pos: LspPos): boolean {
  const line = text.split(/\r?\n/)[pos.line] ?? ''
  const head = line.slice(0, pos.character).replace(/[A-Za-z_]\w*$/, '') // drop the partial identifier
  return TYPE_POS.test(head)
}

// Verse built-in (intrinsic) types — verse-lsp may not list these as completions, so we inject them
// in a type position. Tagged VERSE_BUILTIN_KIND so the renderer gives them the `#` icon in the editor's
// keyword colour — they're language built-ins, NOT user structs (the DB never classifies these).
const VERSE_BUILTIN_TYPES = [
  'int', 'float', 'logic', 'string', 'void', 'char', 'char32', 'char8', 'rational', 'any', 'comparable', 'tuple', 'type'
]
export function verseBuiltinTypeItems(): LspCompletionItem[] {
  return VERSE_BUILTIN_TYPES.map((name) => ({ label: name, kind: VERSE_BUILTIN_KIND, insertText: name }))
}

/**
 * The accurate type registry (kinds / supers / members / enum values) for a project's digests +
 * `.verse` files — handed to the renderer so it colours and labels Verse from facts, not the
 * "lowercase = type" guess. (The current file's own just-declared types come from the renderer's
 * live scan; this carries the engine/std-lib + other-file types it can't see.)
 */
export function verseRegistry(root: string): VerseRegistry {
  const key = path.resolve(root).toLowerCase()
  let cached = cache.get(key)
  if (!cached) {
    cached = buildCache(root)
    cache.set(key, cached)
  }
  const reg: VerseRegistry = { kind: {}, supers: {}, members: {}, methods: {}, enumValues: {}, setters: {}, docs: {} }
  for (const map of [cached.digest, cached.project]) {
    for (const [name, t] of map) {
      reg.kind[name] = t.kind as VerseRegistry['kind'][string]
      if (t.supers.length) reg.supers[name] = t.supers
      // 한국어 보기가 켜져 있으면 번역(팩에 있으면)으로 — 메인 호버 문서와 동일하게. 끄면/없으면 원문.
      // 이 docs는 카드 안 토큰 설명 '플레인 텍스트' 툴팁(.lh-tokdesc)으로 가므로 첫 문단만,
      // 백틱·구분선·코드 줄은 벗겨서(versePlainDoc) — 전체 문서는 호버 카드 본문이 담당한다.
      if (t.doc) reg.docs[name] = versePlainDoc(translateVerseDoc(t.doc))
      // colouring is cross-file (other files / inherited), where private members aren't visible — so
      // the registry's member list stays public-only (same-class private colouring is the renderer's
      // own live scan). Enum values are never private.
      const visible = t.members.filter((m) => !m.private)
      const names = visible.map((m) => m.name)
      if (names.length) reg.members[name] = names
      // methods (function members) so the renderer can colour an inherited/cross-file method reference
      // as a FUNCTION (mint), distinct from a data field (member colour).
      const methodNames = visible.filter((m) => m.mkind === 'method').map((m) => m.name)
      if (methodNames.length) reg.methods[name] = methodNames
      if (t.kind === 'enum' && names.length) reg.enumValues[name] = names
      for (const m of t.members) if (m.write) (reg.setters[name] ??= {})[m.name] = m.write // explicit setter access
    }
  }
  return reg
}

/** Names of receiver-based extension methods for a project (digests + `.verse`). For stripping them
 *  from bare-identifier completion — they're only callable as `receiver.Name(…)`. */
export function verseExtMethods(root: string): Set<string> {
  const key = path.resolve(root).toLowerCase()
  let cached = cache.get(key)
  if (!cached) {
    cached = buildCache(root)
    cache.set(key, cached)
  }
  return cached.extMethods
}

// ── 캐시 수명 ────────────────────────────────────────────────────────────────
// digest/소스 파스는 프로젝트당 1회 캐시되지만 영원하진 않다: UEFN이 Verse를 재빌드하면
// (digest 재생성 → manager가 verse-lsp를 재시작하는 그 경로에서) 해당 루트를 무효화하고,
// 앱 안에서 .verse를 저장할 때도 무효화한다. `regRev`는 레지스트리 세대 카운터 — 무효화나
// 문서 언어 토글(내용은 같아도 번역이 달라짐)마다 올라가고, 렌더러는 rev 비교로 자기가 든
// 레지스트리가 낡았을 때만 다시 받아간다. (남은 구멍: 에이전트가 디스크에서 직접 고친
// .verse는 어느 경로도 안 지나므로 다음 재빌드/저장/재시작까지 낡은 채로 남는다.)
let regRev = 1

/** 현재 레지스트리 세대 — 렌더러가 들고 있는 rev와 비교해 재전송 여부를 정한다. */
export function verseRegistryRev(): number {
  return regRev
}

/** 캐시 내용은 그대로지만 파생물이 달라질 때(한국어 문서 토글) 세대만 올린다. */
export function bumpVerseRegistryRev(): void {
  regRev++
}

/** Drop ONE project's cached digest/source parse — UEFN 재빌드 감지·.verse 저장 시. */
export function invalidateVerseMemberCache(root: string): void {
  cache.delete(path.resolve(root).toLowerCase())
  liveMemo = { text: ' ', map: new Map() } // 어떤 실제 버퍼와도 다른 센티널(선언부와 동일 값)
  regRev++
}

/** Drop every project's cached parse (e.g. when the Verse server is reconfigured). */
export function clearVerseMemberCache(): void {
  regRev++
  cache.clear()
  liveMemo = { text: ' ', map: new Map() }
}
