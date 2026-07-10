import fs from 'node:fs'
import path from 'node:path'
import type { DirEntry } from '@shared/protocol'

// Directories we never descend into when building the "@" mention file list —
// heavy, generated, or VCS internals that would swamp the picker and slow the walk.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'out', 'build', 'coverage',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache', '.vite',
  '.idea', '.vs', '.gradle', 'bin', 'obj', 'target', 'vendor', '__pycache__',
  '.venv', 'venv', '.mypy_cache', '.pytest_cache', '.expo', 'Pods', '.dart_tool'
])

// Hidden dot-directories worth keeping — they hold real, mention-worthy files
// (workflows, skills, MCP config) unlike the noise SKIP_DIRS already drops.
const KEEP_DOT_DIRS = new Set(['.github', '.claude', '.vscode'])

const MAX_FILES = 6000 // cap so a giant repo can't stall the walk or the renderer

/**
 * Walk `cwd` breadth-first and return project-relative POSIX file paths, skipping
 * heavy/generated directories and most hidden dot-dirs. Breadth-first ordering keeps
 * shallow files (the ones a user most often mentions) near the front, and MAX_FILES
 * bounds the work so the "@" mention palette stays responsive even in large repos.
 */
export async function listProjectFiles(cwd: string): Promise<string[]> {
  if (!cwd) return []
  const out: string[] = []
  const queue: string[] = ['']
  while (queue.length && out.length < MAX_FILES) {
    const rel = queue.shift() as string
    const abs = rel ? path.join(cwd, rel) : cwd
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(abs, { withFileTypes: true })
    } catch {
      continue // unreadable dir (perms, race) — just skip it
    }
    const dirs: string[] = []
    for (const e of entries) {
      const name = e.name
      const childRel = rel ? rel + '/' + name : name
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue
        if (name.startsWith('.') && !KEEP_DOT_DIRS.has(name)) continue
        dirs.push(childRel)
      } else if (e.isFile()) {
        out.push(childRel)
        if (out.length >= MAX_FILES) break
      }
    }
    // queue this dir's children after the ones already waiting → breadth-first
    for (const d of dirs) queue.push(d)
  }
  return out
}

/**
 * Build a fast "is this entry name excluded?" predicate from VS Code-style files.exclude
 * globs (UEFN's `.code-workspace` uses e.g. "**\/*.uasset", "Collections"). We match the
 * entry's *basename*: enough for the UEFN patterns (suffix globs + bare folder names), and
 * we treat a bare name as "exclude anywhere" so the junk folders vanish at any depth.
 */
function makeExcluder(patterns: string[]): (name: string) => boolean {
  const exact = new Set<string>()
  const regexes: RegExp[] = []
  for (const raw of patterns) {
    let p = (raw || '').trim()
    if (p.startsWith('**/')) p = p.slice(3)
    if (p.includes('/')) p = p.slice(p.lastIndexOf('/') + 1) // basename only
    if (!p) continue
    if (p.includes('*') || p.includes('?')) {
      const re = '^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
      try {
        regexes.push(new RegExp(re, 'i'))
      } catch {
        /* skip an unparseable glob */
      }
    } else {
      exact.add(p.toLowerCase())
    }
  }
  return (name: string): boolean => {
    if (exact.has(name.toLowerCase())) return true
    for (const re of regexes) if (re.test(name)) return true
    return false
  }
}

/**
 * Does `abs` (a directory) hold at least one non-excluded *file* anywhere below it? Used to
 * hide directories that are empty once the excludes are applied (UEFN's "Hide Empty
 * Directories"). Bounded by depth + a shared node budget so an all-asset subtree can't stall
 * the expand; on hitting the budget we assume "yes" — safer to reveal than to wrongly hide.
 * `hidden(name, dir)` matches the same file-vs-dir rules the top-level listing uses.
 */
async function dirHasVisibleFile(
  abs: string,
  hidden: (name: string, dir: boolean) => boolean,
  depth: number,
  budget: { n: number }
): Promise<boolean> {
  if (depth < 0 || budget.n <= 0) return true
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(abs, { withFileTypes: true })
  } catch {
    return false
  }
  const subdirs: string[] = []
  for (const e of entries) {
    const dir = e.isDirectory()
    if (hidden(e.name, dir)) continue
    if (e.isFile()) return true
    if (dir) subdirs.push(path.join(abs, e.name))
    if (--budget.n <= 0) return true
  }
  for (const d of subdirs) {
    if (await dirHasVisibleFile(d, hidden, depth - 1, budget)) return true
    if (budget.n <= 0) return true
  }
  return false
}

/**
 * List ONE folder for the file explorer — `rel` is cwd-relative ('' = project root).
 * Lazy by design (called per expanded folder). By default nothing is filtered — the explorer
 * shows the real tree, node_modules included.
 *
 * Three independent filters, each a name list:
 *  - `exclude`      — matches files AND folders (the "Verse 위주로 보기" globs: `**\/*.uasset`,
 *                     `Collections`, …). With `hideEmpty`, folders left empty by these are dropped
 *                     too — mirroring UEFN's Verse Explorer view.
 *  - `excludeDirs`  — matches DIRECTORIES ONLY (the general "빌드·생성물 폴더 숨김": bin/obj/Saved/…).
 *                     A file that merely shares a hidden folder's name (e.g. a file literally named
 *                     `Saved`) stays visible.
 *  - `excludeFiles` — matches FILES ONLY (숨김 파일 이름·패턴: Thumbs.db, `*.uasset`, …) — the
 *                     mirror of `excludeDirs`, so a folder sharing a hidden file's name stays visible.
 * Folders first, then files, each sorted case-insensitively.
 */
export async function listDir(
  cwd: string,
  rel: string,
  exclude?: string[],
  hideEmpty?: boolean,
  excludeDirs?: string[],
  excludeFiles?: string[]
): Promise<DirEntry[]> {
  if (!cwd) return []
  const root = path.resolve(cwd)
  const abs = path.resolve(root, rel || '.')
  // never escape the project root (a crafted "../" rel could otherwise browse anywhere)
  if (abs !== root && !abs.startsWith(root + path.sep)) return []
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(abs, { withFileTypes: true })
  } catch {
    return [] // unreadable dir (perms, gone) — show it empty
  }
  const exclAll = exclude && exclude.length ? makeExcluder(exclude) : null // files + dirs
  const exclDir = excludeDirs && excludeDirs.length ? makeExcluder(excludeDirs) : null // dirs only
  const exclFile = excludeFiles && excludeFiles.length ? makeExcluder(excludeFiles) : null // files only
  // one entry's verdict — the shared list always applies, then the dir-only/file-only list by kind
  const hidden = (name: string, dir: boolean): boolean =>
    (!!exclAll && exclAll(name)) || (dir ? !!exclDir && exclDir(name) : !!exclFile && exclFile(name))

  let out: DirEntry[] = entries.map((e) => ({ name: e.name, dir: e.isDirectory() }))
  if (exclAll || exclDir || exclFile) {
    out = out.filter((e) => !hidden(e.name, e.dir))
    if (hideEmpty) {
      const kept: DirEntry[] = []
      for (const e of out) {
        if (!e.dir) {
          kept.push(e)
          continue
        }
        if (await dirHasVisibleFile(path.join(abs, e.name), hidden, 6, { n: 4000 })) kept.push(e)
      }
      out = kept
    }
  }
  out.sort((a, b) =>
    a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.dir ? -1 : 1
  )
  return out
}
