import { useCallback, useEffect, useRef, useState } from 'react'
import { getPref, setPref } from '../lib/prefs'

const MIN = 0.5 // 50%
const MAX = 3 // 300%
const STEP = 0.1 // 10% per wheel notch

// snap to 10% steps so repeated wheeling can't drift to values like 119.999%
function clamp(v: number): number {
  return Math.min(MAX, Math.max(MIN, Math.round(v * 10) / 10))
}

function load(key: string, def = 1): number {
  const v = getPref(key, def)
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v) : clamp(def)
}

/**
 * Ctrl + mouse-wheel zoom for a scrollable pane, remembered in localStorage. Attach
 * `ref` to the element that receives the wheel (the scroll viewport) and apply `zoom`
 * (a CSS `zoom` factor) to the inner content. `flash` is true briefly after each change
 * so a "120%" badge can fade in then out. React's onWheel is registered passive and
 * can't preventDefault, so we bind a native non-passive listener ourselves.
 * `def`: 저장값이 없을 때의 기본 배율 — 멀티(1.2)처럼 화면별로 다른 시작점을 준다.
 */
export function useZoom(storageKey: string, active = true, def = 1) {
  // track the target via a state-backed callback ref, not a plain ref object: the wheel
  // listener must re-bind whenever the element unmounts/remounts — the chat pane is torn
  // down and rebuilt on a multi-agent mode round trip, and the viewer cards render null
  // while closed. A ref object's `.current` change wouldn't re-run the effect; state does.
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const ref = useCallback((node: HTMLDivElement | null) => setEl(node), [])
  const [zoom, setZoom] = useState(() => load(storageKey, def))
  const [flash, setFlash] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  // re-sync from storage each time the pane (re)opens, so panes sharing a key (the file
  // viewer and the diff card both use ccgui.viewer.zoom) agree within a session too
  useEffect(() => {
    if (active) setZoom(load(storageKey, def))
  }, [active, storageKey, def])

  // re-runs whenever the live element changes (mount/unmount) or `active` flips, so the
  // listener always follows the current node rather than a one-shot mount-time capture.
  useEffect(() => {
    if (!el || !active) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault() // stop the page from zooming out from under us
      setZoom((z) => {
        const next = clamp(z + (e.deltaY < 0 ? STEP : -STEP))
        if (next !== z) setPref(storageKey, next)
        return next
      })
      setFlash(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setFlash(false), 1100)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      window.clearTimeout(timer.current)
    }
  }, [el, storageKey, active])

  return { ref, zoom, pct: Math.round(zoom * 100), flash }
}

/** Composes multiple refs (objects or callbacks) onto one element. */
export function mergeRefs<T>(...refs: Array<React.Ref<T> | undefined>) {
  return (el: T | null): void => {
    for (const r of refs) {
      if (!r) continue
      if (typeof r === 'function') r(el)
      else (r as React.MutableRefObject<T | null>).current = el
    }
  }
}

/** A transient "120%" pill that fades out once the zoom stops changing. */
export function ZoomBadge({ pct, show }: { pct: number; show: boolean }) {
  return (
    <div className={'zoom-badge' + (show ? ' on' : '')} aria-hidden="true">
      {pct}%
    </div>
  )
}
