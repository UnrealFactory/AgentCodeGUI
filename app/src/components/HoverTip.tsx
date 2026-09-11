import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

// The same tooltip styling as .has-tip, portaled out of scroll/clipping containers.
export function HoverTip({ text, children, className = '' }: { text: string; children: ReactElement<HTMLAttributes<HTMLElement>>; className?: string }) {
  const id = useId()
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const tip = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const hide = (): void => { clearTimeout(timer.current); setAnchor(null) }
  const show = (el: HTMLElement, delay: number): void => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (el.isConnected) setAnchor(el.getBoundingClientRect())
    }, delay)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    if (!anchor) return
    const dismiss = (): void => setAnchor(null)
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') dismiss() }
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('keydown', onKey)
    }
  }, [anchor])
  useLayoutEffect(() => {
    if (!anchor || !tip.current) return
    const { width, height } = tip.current.getBoundingClientRect()
    setPos({
      left: Math.max(8, Math.min(anchor.left + (anchor.width - width) / 2, innerWidth - width - 8)),
      top: anchor.top >= height + 16 ? anchor.top - height - 8 : Math.min(anchor.bottom + 8, innerHeight - height - 8)
    })
  }, [anchor, text])
  return <>
    {cloneElement(children, {
      'aria-describedby': anchor ? [children.props['aria-describedby'], id].filter(Boolean).join(' ') : children.props['aria-describedby'],
      onMouseEnter: e => { children.props.onMouseEnter?.(e); show(e.currentTarget, 300) },
      onMouseLeave: e => { children.props.onMouseLeave?.(e); hide() },
      onFocus: e => { children.props.onFocus?.(e); show(e.currentTarget, 0) },
      onBlur: e => { children.props.onBlur?.(e); hide() }
    })}
    {anchor && createPortal(<div ref={tip} id={id} role="tooltip" className={'hover-tip' + (className ? ` ${className}` : '')} style={pos}>{text}</div>, document.body)}
  </>
}
