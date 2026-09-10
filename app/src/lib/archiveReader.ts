import type { ArchiveEntry, PayloadPage } from '../api/archive'

/** Cache raw pages, not rendered Markdown/DOM. Scope one cache to one reader. */
export class ArchivePayloadCache {
  private pages = new Map<string, PayloadPage>()
  private pending = new Map<string, Promise<PayloadPage>>()
  private bytes = 0
  private read: (seq: number, offset: number) => Promise<PayloadPage>
  private maxBytes: number
  private maxPages: number

  constructor(
    read: (seq: number, offset: number) => Promise<PayloadPage>,
    maxBytes = 6 * 1024 * 1024,
    maxPages = 128
  ) { this.read = read; this.maxBytes = maxBytes; this.maxPages = maxPages }

  get retainedBytes(): number { return this.bytes }
  get size(): number { return this.pages.size }
  peek = (seq: number, offset: number): PayloadPage | undefined => this.pages.get(`${seq}:${offset}`)

  load = (seq: number, offset: number): Promise<PayloadPage> => {
    const key = `${seq}:${offset}`
    const cached = this.pages.get(key)
    if (cached) {
      this.pages.delete(key)
      this.pages.set(key, cached)
      return Promise.resolve(cached)
    }
    const pending = this.pending.get(key)
    if (pending) return pending
    const request = Promise.resolve().then(() => this.read(seq, offset)).then(page => {
      const cost = page.text.length * 2
      if (cost <= this.maxBytes) {
        this.pages.set(key, page)
        this.bytes += cost
        while (this.bytes > this.maxBytes || this.pages.size > this.maxPages) {
          const oldest = this.pages.keys().next().value!
          this.bytes -= this.pages.get(oldest)!.text.length * 2
          this.pages.delete(oldest)
        }
      }
      return page
    }).finally(() => this.pending.delete(key))
    this.pending.set(key, request)
    return request
  }
}

export function archiveRowEstimate(entry: ArchiveEntry, previous?: ArchiveEntry): number {
  const message = entry.source === 'input' && entry.kind === 'user' || entry.kind === 'assistant-done'
  const day = !previous || new Date(previous.at).toDateString() !== new Date(entry.at).toDateString()
  return (message ? 170 : 50) + (day ? 50 : 0)
}

/** First row whose bottom is below the requested local scroll position. */
export function archiveRowAt(offsets: readonly number[], top: number): number {
  let low = 0, high = Math.max(0, offsets.length - 1)
  while (low < high) {
    const mid = (low + high) >>> 1
    if (offsets[mid + 1] <= top) low = mid + 1
    else high = mid
  }
  return Math.min(low, Math.max(0, offsets.length - 2))
}

export function archiveVisibleRange(offsets: readonly number[], top: number, height: number, overscan = 600) {
  const count = Math.max(0, offsets.length - 1)
  if (!count) return { start: 0, end: 0 }
  return {
    start: archiveRowAt(offsets, Math.max(0, top - overscan)),
    end: Math.min(count, archiveRowAt(offsets, top + height + overscan) + 1)
  }
}

/** Measurements may commit after a wheel/scrollbar jump. That newer user
 * position wins over a correction sampled at the old position. */
export function archiveCorrectedScroll(current: number, sampled: number, delta: number): number {
  return Math.abs(current - sampled) < 1 ? Math.max(0, current + delta) : current
}
