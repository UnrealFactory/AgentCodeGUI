import type { ArchiveEntry, ArchivePage } from '../api/archive'

/** A native read bounds the number of raw records scanned, not the number of
 * visible cards returned. Fill a display page across those bounded reads. */
export async function loadArchivePage({
  from,
  source,
  read,
  isActive = () => true,
  pageSize = 60,
  stalledMessage = 'Unable to advance through archive records.'
}: {
  from: number
  source: string
  read: (position: number) => Promise<ArchivePage<ArchiveEntry>>
  isActive?: () => boolean
  pageSize?: number
  stalledMessage?: string
}): Promise<ArchivePage<ArchiveEntry> | null> {
  const items: ArchiveEntry[] = []
  let position = from
  while (isActive()) {
    const page = await read(position)
    if (!isActive()) return null
    if (page.next != null && page.next <= position) throw new Error(stalledMessage)

    for (const entry of page.items) {
      const previous = items[items.length - 1]
      if (source === 'timeline' && previous?.fileGroup && entry.fileGroup) {
        items[items.length - 1] = {
          ...previous,
          fileGroup: { endSeq: entry.fileGroup.endSeq, count: previous.fileGroup.count + entry.fileGroup.count }
        }
      } else {
        // A scan can return more cards than the remaining display slots. Resume
        // at the first unused card rather than skipping to that scan's next.
        if (items.length >= pageSize) return { items, total: page.total, next: entry.seq }
        items.push(entry)
      }
    }
    if (page.next == null || items.length >= pageSize || (source !== 'timeline' && items.length)) {
      return { items, total: page.total, next: page.next }
    }
    position = page.next
  }
  return null
}
