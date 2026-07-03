import path from 'node:path'
import fs from 'node:fs'
import { APP_HOME } from './engine/versions'
import { writeFileAtomic } from './atomicWrite'

// Renderer-owned UI preferences (file-viewer size/zoom, chat zoom) live alongside the
// profile in the app home folder, so they sit with the rest of the app's settings and
// survive launches — rather than being buried in Electron's localStorage. The renderer
// keeps the authoritative in-memory copy and writes the whole blob back here.
const UI_PREFS_PATH = path.join(APP_HOME, 'ui-prefs.json')

/** Reads the saved UI prefs blob, or an empty object when none/unreadable. */
export function readUiPrefs(): Record<string, unknown> {
  try {
    const v = JSON.parse(fs.readFileSync(UI_PREFS_PATH, 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Persists the whole UI prefs blob, creating the home folder if needed. */
export function writeUiPrefs(prefs: Record<string, unknown>): void {
  fs.mkdirSync(APP_HOME, { recursive: true })
  writeFileAtomic(UI_PREFS_PATH, JSON.stringify(prefs ?? {}, null, 2))
}
