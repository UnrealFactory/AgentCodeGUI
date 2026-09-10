import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ArchiveEntry } from '../api/archive'
import { archiveCorrectedScroll, archiveRowEstimate, archiveVisibleRange } from '../lib/archiveReader'

const ArchiveRow = memo(function ArchiveRow({ entry, previous, index, offset, count, measure, renderEntry }: {
  entry: ArchiveEntry
  previous?: ArchiveEntry
  index: number
  offset: number
  count: number
  measure: (seq: number, height: number) => void
  renderEntry: (entry: ArchiveEntry) => ReactNode
}) {
  const element = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const node = element.current
    if (!node) return
    const update = () => {
      if (!node.querySelector('[data-archive-pending="true"]')) measure(entry.seq, node.getBoundingClientRect().height)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [entry.seq, measure])
  const day = !previous || new Date(previous.at).toDateString() !== new Date(entry.at).toDateString()
  return <div ref={element} className="arc-virtual-row" data-archive-index={index} role="listitem" aria-posinset={index + 1} aria-setsize={count}
    style={{ transform: `translateY(${offset}px)` }}>
    {day && <div className="arc-day">{new Date(entry.at).toLocaleDateString()}</div>}
    {renderEntry(entry)}
  </div>
})

/** Keep only nearby rows mounted. Measured heights preserve the scroll track
 * when older rows unmount; ResizeObserver also covers expanded tool outputs. */
export function ArchiveVirtualList({ entries, scrollElement, renderEntry }: {
  entries: ArchiveEntry[]
  scrollElement: HTMLElement | null
  renderEntry: (entry: ArchiveEntry) => ReactNode
}) {
  const list = useRef<HTMLDivElement>(null)
  const heights = useRef(new Map<number, number>())
  const pending = useRef(new Map<number, number>())
  const measureFrame = useRef(0)
  const correction = useRef<{ top: number; delta: number } | null>(null)
  const [revision, setRevision] = useState(0)
  const [viewport, setViewport] = useState({ top: 0, height: 700 })
  const offsets = useMemo(() => {
    const positions = [0]
    for (let i = 0; i < entries.length; i++) positions.push(positions[i] + (heights.current.get(entries[i].seq) ?? archiveRowEstimate(entries[i], entries[i - 1])))
    return positions
  }, [entries, revision])
  const indices = useMemo(() => new Map(entries.map((entry, index) => [entry.seq, index])), [entries])
  const latest = useRef({ offsets, indices, viewport })
  latest.current = { offsets, indices, viewport }
  const scrollRef = useRef(scrollElement)
  scrollRef.current = scrollElement

  const updateViewport = useCallback(() => {
    if (!scrollElement || !list.current) return
    const listTop = list.current.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top + scrollElement.scrollTop - scrollElement.clientTop
    const top = Math.max(0, scrollElement.scrollTop - listTop)
    const height = scrollElement.clientHeight
    setViewport(old => Math.abs(old.top - top) < 1 && old.height === height ? old : { top, height })
  }, [scrollElement])

  const measure = useCallback((seq: number, height: number) => {
    if (height <= 0 || Math.abs((heights.current.get(seq) ?? 0) - height) < 0.5) return
    pending.current.set(seq, height)
    if (measureFrame.current) return
    measureFrame.current = requestAnimationFrame(() => {
      measureFrame.current = 0
      let changed = false
      const { offsets: oldOffsets, indices: oldIndices } = latest.current
      const scroller = scrollRef.current
      const node = list.current
      // Read the actual position here: a scroll-to-top can precede the scroll
      // listener's next animation frame and invalidate its cached viewport.
      const scrollTop = scroller?.scrollTop ?? 0
      const listTop = scroller && node ? node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scrollTop - scroller.clientTop : 0
      const visibleTop = Math.max(0, scrollTop - listTop)
      let delta = 0
      for (const [id, size] of pending.current) {
        const index = oldIndices.get(id)
        if (index == null) continue
        const oldSize = heights.current.get(id) ?? oldOffsets[index + 1] - oldOffsets[index]
        if (oldOffsets[index + 1] <= visibleTop) delta += size - oldSize
        heights.current.set(id, size)
        changed = true
      }
      pending.current.clear()
      if (delta) {
        const previous = correction.current
        correction.current = { top: scrollTop, delta: delta + (previous && Math.abs(previous.top - scrollTop) < 1 ? previous.delta : 0) }
      }
      if (changed) setRevision(value => value + 1)
    })
  }, [])

  useLayoutEffect(() => {
    const adjustment = correction.current
    correction.current = null
    if (scrollElement && adjustment) {
      scrollElement.scrollTop = archiveCorrectedScroll(scrollElement.scrollTop, adjustment.top, adjustment.delta)
    }
    updateViewport()
  }, [offsets, scrollElement, updateViewport])

  useEffect(() => {
    if (!scrollElement) return
    let frame = 0
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; updateViewport() }) }
    scrollElement.addEventListener('scroll', schedule, { passive: true })
    const observer = new ResizeObserver(schedule)
    observer.observe(scrollElement)
    schedule()
    return () => { scrollElement.removeEventListener('scroll', schedule); observer.disconnect(); cancelAnimationFrame(frame) }
  }, [scrollElement, updateViewport])
  useEffect(() => () => cancelAnimationFrame(measureFrame.current), [])

  const range = archiveVisibleRange(offsets, viewport.top, viewport.height)
  return <div ref={list} className="arc-virtual-list" role="list" data-loaded-count={entries.length} data-rendered-count={range.end - range.start}
    style={{ height: offsets[offsets.length - 1] }}>
    {entries.slice(range.start, range.end).map((entry, localIndex) => {
      const index = range.start + localIndex
      return <ArchiveRow key={entry.seq} entry={entry} previous={entries[index - 1]} index={index} offset={offsets[index]} count={entries.length}
        measure={measure} renderEntry={renderEntry} />
    })}
  </div>
}
