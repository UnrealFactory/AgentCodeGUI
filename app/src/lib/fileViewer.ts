import { createElement, lazy } from 'react'

type Viewer = typeof import('../components/FileModal')['FileModal']
let loaded: Viewer | undefined
const loadViewer = () => import('../components/FileModal').then(m => {
  loaded = m.FileModal
  return { default: m.FileModal }
})
const LazyViewer = lazy(loadViewer)
export function FileModal(props: Parameters<Viewer>[0]) {
  // A new lazy promise still suspends even when the module is already cached.
  // Use the prepared component directly so the first click avoids React's
  // fallback/reveal delay. Early clicks retain the normal lazy-loading path.
  return createElement(loaded ?? LazyViewer, props)
}

// Keep CodeMirror off the startup path, but prepare it during idle time so the
// first file click does not pay for downloading and evaluating the whole chunk.
// Loading the module does not mount an editor, read files or start a language server.
export function warmFileViewer(): void {
  window.setTimeout(() => {
    const load = (): void => { void loadViewer().catch(() => {}) }
    if ('requestIdleCallback' in window) window.requestIdleCallback(load, { timeout: 2000 })
    else load()
  }, 500)
}
