import type { DirEntry } from './protocol'

/** A companion belongs to the full Razor filename, not just its stem. */
export function razorParentName(name: string): string | null {
  const match = /^(.*\.(?:razor|cshtml))\.(?:cs|css|js|ts)$/i.exec(name)
  return match?.[1] ?? null
}

export interface NestedFileRow {
  entry: DirEntry
  parent?: string
  children: DirEntry[]
}

/** Preserve directory order and real filenames; never hide an orphan companion. */
export function nestFileRows(entries: DirEntry[], expanded: ReadonlySet<string>): NestedFileRow[] {
  const files = new Map<string, DirEntry | null>()
  for (const entry of entries) {
    if (entry.dir) continue
    const key = entry.name.toLowerCase()
    files.set(key, files.has(key) ? null : entry)
  }
  const children = new Map<DirEntry, DirEntry[]>()
  const nested = new Set<DirEntry>()
  for (const entry of entries) {
    if (entry.dir) continue
    const name = razorParentName(entry.name)
    const parent = name ? files.get(name.toLowerCase()) : null
    if (!parent) continue
    const list = children.get(parent) ?? []
    list.push(entry)
    children.set(parent, list)
    nested.add(entry)
  }
  const rows: NestedFileRow[] = []
  for (const entry of entries) {
    if (nested.has(entry)) continue
    const companions = children.get(entry) ?? []
    rows.push({ entry, children: companions })
    if (expanded.has(entry.name)) {
      for (const child of companions) rows.push({ entry: child, parent: entry.name, children: [] })
    }
  }
  return rows
}
