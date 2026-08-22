import { useCallback, useEffect, useRef, useState } from 'react'
import { getPref, setPref } from '../lib/prefs'

// matches the 40px padding on .fv-overlay — the most a card can grow
// to before it would touch the window edge
const OVERLAY_PAD = 40
const MIN_W = 520
const MIN_H = 300

export type ModalSize = { w: number; h: number }

// only the bottom edge, the two sides, and the bottom corners get grips: the card is
// centred and grows symmetrically, so a top grip would be redundant *and* would sit
// over the header buttons (close / 최대화). cursor matches the drag axis.
const RESIZE_CURSOR: Record<string, string> = {
  e: 'ew-resize',
  w: 'ew-resize',
  s: 'ns-resize',
  se: 'nwse-resize',
  sw: 'nesw-resize'
}
const HANDLES = ['e', 'w', 's', 'se', 'sw']

function loadSize(key: string): ModalSize | null {
  const v = getPref<{ w?: unknown; h?: unknown } | null>(key, null)
  if (v && typeof v.w === 'number' && typeof v.h === 'number') return { w: v.w, h: v.h }
  return null
}

/**
 * Makes the file-viewer / diff cards user-resizable (remembered across restarts via the
 * app's ui-prefs store) and double-click-to-maximize. Until the user resizes once, `size` is
 * null and the card keeps its CSS default size — so small files still open as a small
 * card and the markdown split keeps its wider default.
 *
 * opts.defaultMaximized: open maximized when nothing's been remembered yet (the code
 * viewer wants this — 큰 화면으로 바로). The maximize state is itself persisted, so once
 * the user restores to a smaller size that choice sticks across reopens / restarts.
 */
export function useResizableModal(storageKey: string, open: boolean, opts?: { defaultMaximized?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<ModalSize | null>(() => loadSize(storageKey))
  const maxKey = storageKey + '.max'
  const defaultMax = opts?.defaultMaximized ?? false
  const [maximized, setMaximized] = useState<boolean>(() => getPref<boolean>(maxKey, defaultMax))

  // re-read the saved size + maximize state whenever the card opens: the file-viewer and
  // diff cards are separate, always-mounted instances that share one key, so this keeps a
  // size/maximize chosen in one of them in sync the next time the other opens
  useEffect(() => {
    if (open) {
      setSize(loadSize(storageKey))
      setMaximized(getPref<boolean>(maxKey, defaultMax))
    }
  }, [open, storageKey, maxKey, defaultMax])

  // toggling persists the choice (so a restore-to-small / re-maximize is remembered)
  const toggleMaximize = useCallback(() => {
    setMaximized((m) => {
      const next = !m
      setPref(maxKey, next)
      return next
    })
  }, [maxKey])

  // The card is centred in its overlay, so its centre stays put as it grows: a 1px
  // cursor move past an edge has to add 2px of size (one per side) for that edge to
  // track the cursor 1:1. We write width/height straight to the DOM during the drag
  // and only commit to React state on release, so a big syntax-highlighted file isn't
  // re-rendered (and re-highlighted) on every mouse move.
  const startResize = useCallback(
    (edge: string) => (e: React.MouseEvent): void => {
      if (e.button !== 0) return
      const el = ref.current
      if (!el) return
      e.preventDefault()
      e.stopPropagation()
      const startX = e.clientX
      const startY = e.clientY
      const baseW = el.offsetWidth
      const baseH = el.offsetHeight
      const maxW = window.innerWidth - OVERLAY_PAD * 2
      const maxH = window.innerHeight - OVERLAY_PAD * 2
      let next: ModalSize = { w: baseW, h: baseH }

      const onMove = (ev: MouseEvent): void => {
        let w = baseW
        let h = baseH
        if (edge.includes('e')) w = baseW + (ev.clientX - startX) * 2
        if (edge.includes('w')) w = baseW - (ev.clientX - startX) * 2
        if (edge.includes('s')) h = baseH + (ev.clientY - startY) * 2
        w = Math.max(MIN_W, Math.min(maxW, w))
        h = Math.max(MIN_H, Math.min(maxH, h))
        next = { w, h }
        el.style.width = w + 'px'
        el.style.height = h + 'px'
      }
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.classList.remove('rzm-resizing')
        document.body.style.cursor = ''
        // swallow the click that fires right after the release: if the gesture ended
        // over the backdrop it would otherwise count as a backdrop click and close
        const swallow = (ce: MouseEvent): void => {
          ce.stopPropagation()
          window.removeEventListener('click', swallow, true)
        }
        window.addEventListener('click', swallow, true)
        setSize(next)
        setPref(storageKey, next)
      }
      document.body.classList.add('rzm-resizing')
      document.body.style.cursor = RESIZE_CURSOR[edge] || ''
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [storageKey]
  )

  const onHeaderDoubleClick = useCallback(
    (e: React.MouseEvent): void => {
      if ((e.target as HTMLElement).closest('button')) return
      toggleMaximize()
    },
    [toggleMaximize]
  )

  const modalStyle: React.CSSProperties = maximized
    ? { width: '100%', height: '100%', maxWidth: '100%', maxHeight: '100%' }
    : size
      ? { width: size.w, height: size.h, maxWidth: '100%', maxHeight: '100%' }
      : {}

  return { ref, maximized, modalStyle, startResize, toggleMaximize, onHeaderDoubleClick }
}

/** Edge/corner grips rendered inside a resizable card. Hidden while maximized. */
export function ModalResizeHandles({ onStart }: { onStart: (edge: string) => (e: React.MouseEvent) => void }) {
  return (
    <>
      {HANDLES.map((edge) => (
        <div key={edge} className={'rzm-h rzm-h-' + edge} onMouseDown={onStart(edge)} />
      ))}
    </>
  )
}
