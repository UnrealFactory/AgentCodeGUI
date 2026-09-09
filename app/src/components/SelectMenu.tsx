import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconCheck, IconChevDown } from './icons'

export interface SelectOption { id: string; label: string }

/** App-rendered dropdown: native Windows option surfaces do not inherit our translucent theme. */
export function SelectMenu({ label, value, options, onChange, disabled = false, className = '' }: {
  label: string
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxHeight: 300 })
  const search = useRef({ text: '', at: 0 })
  const selected = options.findIndex(o => o.id === value)
  const keys = options.map(o => o.id).join('\0')

  const choose = (index: number) => {
    const option = options[index]
    if (!option) return
    setOpen(false)
    trigger.current?.focus({ preventScroll: true })
    if (option.id !== value) onChange(option.id)
  }
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useLayoutEffect(() => {
    if (!open) return
    setActive(Math.max(0, selected))
    search.current = { text: '', at: 0 }
  }, [open, selected, keys])
  useLayoutEffect(() => {
    if (!open || !trigger.current) return
    const place = () => {
      const r = trigger.current?.getBoundingClientRect()
      if (!r) return
      if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) { setOpen(false); return }
      const below = innerHeight - r.bottom - 12, above = r.top - 12
      const up = below < Math.min(300, options.length * 34 + 10) && above > below
      const maxHeight = Math.max(34, Math.min(300, up ? above : below))
      const width = Math.min(Math.max(160, r.width), innerWidth - 16)
      const height = Math.min(menu.current?.scrollHeight || options.length * 34 + 10, maxHeight)
      setPosition({ left: Math.max(8, Math.min(r.left, innerWidth - width - 8)), top: Math.max(8, Math.min(up ? r.top - height - 4 : r.bottom + 4, innerHeight - height - 8)), width, maxHeight })
    }
    place()
    const onScroll = (e: Event) => { if (!menu.current?.contains(e.target as Node)) place() }
    window.addEventListener('resize', place)
    window.addEventListener('scroll', onScroll, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', onScroll, true) }
  }, [open, keys])
  useEffect(() => {
    if (open) menu.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, open])
  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => {
      if (!trigger.current?.contains(e.target as Node) && !menu.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return
      if (e.key === 'Tab') { setOpen(false); return }
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopImmediatePropagation(); setOpen(false); trigger.current?.focus({ preventScroll: true }); return
      }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(e.key)) {
        e.preventDefault(); e.stopImmediatePropagation()
        if (e.key === 'Enter' || e.key === ' ') choose(active)
        else setActive(index => e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length)
      } else if (e.key.length === 1) {
        const now = Date.now()
        const term = (now - search.current.at < 650 ? search.current.text : '') + e.key.toLocaleLowerCase()
        search.current = { text: term, at: now }
        const found = options.findIndex(o => o.label.toLocaleLowerCase().startsWith(term))
        if (found >= 0) { e.preventDefault(); e.stopImmediatePropagation(); setActive(found) }
      }
    }
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', onKey, true) }
  }, [open, active, options, value, onChange])

  return <div className={'select-menu ' + className}>
    <button type="button" ref={trigger} role="combobox" className="select-menu-trigger" value={value}
      aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
      aria-activedescendant={open ? `${id}-${active}` : undefined} disabled={disabled || !options.length}
      onClick={() => setOpen(v => !v)} onKeyDown={e => { if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setOpen(true) } }}>
      <span>{options[selected]?.label ?? value}</span><IconChevDown size={13} />
    </button>
    {open && createPortal(<div ref={menu} id={id} role="listbox" aria-label={label} className="select-menu-popover"
      style={{ ...position, visibility: position.width ? 'visible' : 'hidden' }}
      onMouseDown={e => { e.preventDefault(); e.stopPropagation() }} onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
      {options.map((option, index) => <button type="button" id={`${id}-${index}`} key={option.id} role="option" tabIndex={-1}
        aria-selected={option.id === value} data-value={option.id} data-index={index}
        className={'select-menu-option' + (active === index ? ' is-active' : '')}
        onPointerMove={() => setActive(index)} onClick={() => choose(index)}>
        <span>{option.label}</span>{option.id === value && <IconCheck size={13} />}
      </button>)}
    </div>, document.body)}
  </div>
}
