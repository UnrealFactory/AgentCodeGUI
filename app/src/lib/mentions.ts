// "@" file mentions — shared parsing used by the composer palette (which token is
// the caret in?) and by the send path (which files did the prompt reference?).
//
// A mention is `@` + a run of non-whitespace, where the `@` sits at the start of the
// text or right after whitespace. That start-boundary rule keeps emails (a@b.com) and
// decorators (@override) from being mistaken for file mentions.
//
// The palette is a file *browser*, not a flat list: typing "@" shows the project
// root's immediate children (folders + files), and picking a folder drills in (the
// inserted "dir/" re-opens the palette one level deeper). Typing a name segment flips
// to *search* — a recursive match under the current folder ("@ens" → everything
// matching "ens" from root; "@src/ens" → everything matching "ens" under src).

export interface MentionToken {
  query: string // text typed after the '@' (empty right after typing '@')
  start: number // index of the '@'
  end: number // index just past the token (= the caret when actively typing)
}

const isBoundary = (ch: string): boolean => /\s/.test(ch)

/** The mention token the caret currently sits inside, or null if it isn't in one. */
export function mentionAtCaret(text: string, caret: number): MentionToken | null {
  let i = caret - 1
  while (i >= 0) {
    const ch = text[i]
    if (ch === '@') {
      const before = i === 0 ? '' : text[i - 1]
      if (before === '' || isBoundary(before)) return { query: text.slice(i + 1, caret), start: i, end: caret }
      return null // '@' glued to a word (email, decorator) → not a mention
    }
    if (isBoundary(ch)) return null // hit whitespace before any '@'
    i--
  }
  return null
}

/** Every completed `@path` mention in the text, in order, de-duplicated. */
export function extractMentions(text: string): string[] {
  const re = /(?:^|\s)@([^\s@]+)/g
  const out: string[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const p = m[1]
    // a trailing "/" means the user was still browsing a folder, not a real file ref
    if (p.endsWith('/')) continue
    if (!seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }
  return out
}

// ── Palette browsing/search ──────────────────────────────────
const LIMIT = 60 // cap rendered rows so the palette stays light on huge repos

export interface MentionEntry {
  kind: 'dir' | 'file'
  full: string // dir: path WITHOUT trailing slash · file: the file path (relative, POSIX)
  name: string // basename shown prominently
  dir: string // parent directory (with trailing slash), '' = project root
}

export interface MentionResult {
  mode: 'browse' | 'search'
  base: string // the folder being browsed/searched (with trailing slash), '' = root
  term: string // the search term in search mode ('' in browse mode)
  entries: MentionEntry[]
}

// recursive search only kicks in once the term is specific enough; a 1-3 char term
// stays inside the current folder (just filters its immediate children) so it doesn't
// explode into the whole tree
const SEARCH_MIN = 4

/**
 * Resolve a mention query into the rows to show. The part up to the last "/" is the
 * base folder; the trailing segment is the term. Empty term → browse the base's
 * immediate children (folders first). 1-3 chars → filter those immediate children.
 * 4+ chars → recursively search files under the base.
 */
export function mentionEntries(files: string[], query: string): MentionResult {
  const cut = query.lastIndexOf('/')
  const base = cut === -1 ? '' : query.slice(0, cut + 1) // '', 'src/', 'src/components/'
  const term = (cut === -1 ? query : query.slice(cut + 1)).toLowerCase()

  if (term.length < SEARCH_MIN) {
    // BROWSE / LOCAL FILTER — immediate children of `base`, optionally filtered by a
    // short term: subfolders (deduped) then files, each kept only if its name matches
    const dirs = new Set<string>()
    const fileEntries: MentionEntry[] = []
    for (const f of files) {
      if (base && !f.startsWith(base)) continue
      const rest = f.slice(base.length)
      const slash = rest.indexOf('/')
      if (slash === -1) {
        if (term && !rest.toLowerCase().includes(term)) continue
        fileEntries.push({ kind: 'file', full: f, name: rest, dir: base })
      } else {
        const d = rest.slice(0, slash)
        if (term && !d.toLowerCase().includes(term)) continue
        dirs.add(d)
      }
    }
    const dirEntries: MentionEntry[] = [...dirs]
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map((d) => ({ kind: 'dir' as const, full: base + d, name: d, dir: base }))
    fileEntries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    return { mode: 'browse', base, term, entries: [...dirEntries, ...fileEntries].slice(0, LIMIT) }
  }

  // SEARCH — recursive under `base`; match the path *relative to base* (so the term
  // doesn't have to repeat the folder you're already in). Basename hits rank first.
  const scored: { e: MentionEntry; score: number; len: number }[] = []
  for (const f of files) {
    if (base && !f.startsWith(base)) continue
    const rel = f.slice(base.length).toLowerCase()
    if (!rel.includes(term)) continue
    const slash = f.lastIndexOf('/')
    const name = slash === -1 ? f : f.slice(slash + 1)
    const dir = slash === -1 ? '' : f.slice(0, slash + 1)
    const bi = name.toLowerCase().indexOf(term)
    const score = bi === 0 ? 0 : bi > 0 ? 1 : 2
    scored.push({ e: { kind: 'file', full: f, name, dir }, score, len: f.length })
  }
  scored.sort((a, b) => a.score - b.score || a.len - b.len || a.e.full.localeCompare(b.e.full))
  return { mode: 'search', base, term, entries: scored.slice(0, LIMIT).map((s) => s.e) }
}
