import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

/** Header menus share a viewport layer, anchored to the button that opened them. */
export function HeaderPopover({ anchor, onClose, label, className, width = 300, maxHeight = 340, children }: {
  anchor: RefObject<HTMLElement | null>
  onClose: () => void
  label: string
  className: string
  width?: number
  maxHeight?: number
  children: ReactNode
}) {
  const card = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })

  useLayoutEffect(() => {
    const button = anchor.current
    const menu = card.current
    if (!button || !menu) return
    let frame = 0
    const place = (): void => {
      const r = button.getBoundingClientRect()
      const viewport = window.visualViewport
      const x = viewport?.offsetLeft ?? 0, y = viewport?.offsetTop ?? 0
      const vw = viewport?.width ?? window.innerWidth, vh = viewport?.height ?? window.innerHeight
      if (!button.isConnected || r.width === 0 || r.bottom <= y || r.top >= y + vh || r.right <= x || r.left >= x + vw) {
        close.current(); return
      }
      const margin = 8, gap = 7
      const actualWidth = Math.min(width, vw - margin * 2)
      const below = y + vh - r.bottom - gap - margin, above = r.top - y - gap - margin
      const desiredHeight = Math.min(maxHeight, menu.scrollHeight + 2)
      const up = below < desiredHeight && above > below
      const actualMaxHeight = Math.max(1, Math.min(maxHeight, up ? above : below))
      const height = Math.min(menu.scrollHeight + 2, actualMaxHeight)
      const next: CSSProperties = {
        position: 'fixed', left: Math.max(x + margin, Math.min(r.left, x + vw - actualWidth - margin)),
        top: Math.max(y + margin, up ? r.top - gap - height : r.bottom + gap),
        right: 'auto', bottom: 'auto', width: actualWidth, maxWidth: actualWidth, maxHeight: actualMaxHeight,
        visibility: 'visible'
      }
      setPosition(previous => Object.keys(next).every(key => previous[key as keyof CSSProperties] === next[key as keyof CSSProperties]) ? previous : next)
    }
    const schedule = (): void => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place) }
    const scroll = (e: Event): void => { if (!menu.contains(e.target as Node)) schedule() }
    const outside = (e: Event): void => {
      if (!menu.contains(e.target as Node) && !button.contains(e.target as Node)) close.current()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.preventDefault(); e.stopImmediatePropagation(); close.current(); button.focus({ preventScroll: true })
    }
    // Keyboard/programmatic activation of another header menu also closes this one.
    const opened = (e: Event): void => { if ((e as CustomEvent).detail !== button) close.current() }
    window.dispatchEvent(new CustomEvent('ccg:header-menu-open', { detail: button }))
    window.addEventListener('ccg:header-menu-open', opened)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('click', outside, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', scroll, true)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    const observer = new ResizeObserver(schedule)
    observer.observe(button); observer.observe(menu)
    const header = button.closest('.ma-p-head, .chat-head')
    if (header) observer.observe(header)
    place()
    const focusFrame = requestAnimationFrame(() => menu.focus({ preventScroll: true }))
    return () => {
      cancelAnimationFrame(frame); cancelAnimationFrame(focusFrame); observer.disconnect()
      window.removeEventListener('ccg:header-menu-open', opened)
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('click', outside, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', scroll, true)
      window.visualViewport?.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('scroll', schedule)
    }
  }, [anchor, width, maxHeight])

  return createPortal(<div ref={card} className={`header-popover ${className}`} style={position}
    role="dialog" aria-label={label} tabIndex={-1} onPointerDown={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}>
    {children}
  </div>, document.body)
}
