import { useEffect, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'

// Hover belongs to this column. Keeping it out of App avoids rendering the chat,
// account picker and explorer whenever the pointer crosses the reveal boundary.
export function SidebarColumn({ autohide, trigger, dragging, width, columnRef, children }: {
  autohide: boolean
  trigger: number
  dragging: boolean
  width: number | null
  columnRef: RefObject<HTMLDivElement | null>
  children: ReactNode
}) {
  const [revealed, setRevealed] = useState(false)
  useEffect(() => {
    if (!autohide) { setRevealed(false); return }
    const column = columnRef.current
    if (!column) return
    // Read once, then track actual width changes (including the narrow-window
    // breakpoint). Pointer movement must not synchronously ask for layout.
    let panelWidth = column.offsetWidth
    const observer = new ResizeObserver(([entry]) => {
      panelWidth = entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width
    })
    observer.observe(column)
    let leaveTimer: ReturnType<typeof setTimeout> | undefined
    const onMove = (e: MouseEvent): void => {
      clearTimeout(leaveTimer)
      if (e.clientX <= trigger) setRevealed(true)
      else if (!dragging && e.clientX > panelWidth + 8) setRevealed(false)
    }
    const onLeave = (e: MouseEvent): void => {
      if (dragging) return
      // Native window-drag strips can emit mouseleave without leaving the window.
      const el = document.elementFromPoint(e.clientX, e.clientY)
      if (el?.closest('.titlebar, .sb-top, .fxh, .chat-head, .ma-head')) return
      clearTimeout(leaveTimer)
      leaveTimer = setTimeout(() => setRevealed(false), 300)
    }
    const onBlur = (): void => {
      if (dragging) return
      clearTimeout(leaveTimer)
      setRevealed(false)
    }
    window.addEventListener('mousemove', onMove, { passive: true })
    document.documentElement.addEventListener('mouseleave', onLeave)
    window.addEventListener('blur', onBlur)
    return () => {
      observer.disconnect()
      clearTimeout(leaveTimer)
      window.removeEventListener('mousemove', onMove)
      document.documentElement.removeEventListener('mouseleave', onLeave)
      window.removeEventListener('blur', onBlur)
    }
  }, [autohide, trigger, dragging, columnRef])
  return <>
    {autohide && <div className={'lcol-edge' + (revealed ? ' gone' : '')} />}
    <div ref={columnRef}
      className={'lcol' + (autohide ? ' autohide' : '') + (autohide && revealed ? ' revealed' : '')}
      style={width != null ? ({ '--lcol-w': `${width}px` } as CSSProperties) : undefined}>
      {children}
    </div>
  </>
}
