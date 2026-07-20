// Renderer UI preferences (file-viewer size/zoom, chat zoom), persisted to
// ~/.agentcodegui/ui-prefs.json via the main process. We keep an in-memory cache that
// is the source of truth for the session: hooks read it synchronously and write through
// `setPref`, which debounces the whole blob back to disk. `loadPrefs()` must run (and
// resolve) before the app renders so the first read already has the saved values.

let cache: Record<string, unknown> = {}
let loaded = false
let saveTimer: number | undefined

// old localStorage keys → new ui-prefs.json keys, migrated once on first load
const MIGRATE: Record<string, string> = {
  'ccgui.viewer.size': 'viewer.size',
  'ccgui.viewer.zoom': 'viewer.zoom',
  'ccgui.chat.zoom': 'chat.zoom'
}

function flush(): void {
  window.clearTimeout(saveTimer)
  saveTimer = undefined
  if (loaded) window.api.saveUiPrefs(cache).catch(() => {})
}

/** Load the saved prefs into the cache. Run once at startup, before rendering. */
export async function loadPrefs(): Promise<void> {
  try {
    cache = (await window.api.getUiPrefs()) || {}
  } catch {
    cache = {}
  }
  // one-time migration from the previous localStorage location
  const oldKeys: string[] = []
  for (const [oldKey, newKey] of Object.entries(MIGRATE)) {
    const raw = localStorage.getItem(oldKey)
    if (raw == null) continue
    oldKeys.push(oldKey)
    if (cache[newKey] === undefined) {
      try {
        cache[newKey] = JSON.parse(raw)
      } catch {
        // unparseable legacy value — drop it
      }
    }
  }
  loaded = true
  if (oldKeys.length) {
    window.api
      .saveUiPrefs(cache)
      .then(() => oldKeys.forEach((k) => localStorage.removeItem(k)))
      .catch(() => {})
  }
  // make sure a pending change isn't lost if the window closes before the debounce fires
  window.addEventListener('beforeunload', flush)
}

/** Synchronous read from the cache (valid after loadPrefs has resolved). */
export function getPref<T>(key: string, fallback: T): T {
  const v = cache[key]
  return v === undefined || v === null ? fallback : (v as T)
}

/** Update a pref and schedule a debounced write of the whole blob to disk. */
export function setPref(key: string, value: unknown): void {
  cache[key] = value
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(flush, 250)
}

/** 다른 창의 변경 브로드캐스트를 캐시에만 반영 — 저장을 걸지 않는다. 여기서 저장까지 하면
 *  원본 창의 flush와 통(blob)째 저장이 경합하고, 반영을 안 하면 이 창의 다음 flush가 낡은
 *  값으로 되돌려 쓴다(둘 다 실측 가능한 함정). */
export function patchPref(key: string, value: unknown): void {
  cache[key] = value
}
