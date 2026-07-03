import path from 'node:path'
import fs from 'node:fs'
import { APP_HOME } from './engine/versions'
import { writeFileAtomic } from './atomicWrite'

// The multi-agent workspace (panel layout + each panel's session snapshot) is small
// and bounded (≤6 panels), so it lives in one JSON blob under the app home folder —
// the same place as the profile / window state — rather than the per-file fan-out the
// single-chat history uses. The renderer owns the shape; this module just reads/writes.
const FILE = path.join(APP_HOME, 'multi-agent.json')

/** Load the saved multi-agent workspace blob, or null when none has been saved yet. */
export function readMulti(): unknown {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch {
    return null
  }
}

/** Persist the multi-agent workspace blob (best effort — a write failure just skips this save). */
export function writeMulti(data: unknown): void {
  try {
    fs.mkdirSync(APP_HOME, { recursive: true })
    writeFileAtomic(FILE, JSON.stringify(data))
  } catch {
    /* ignore */
  }
}
