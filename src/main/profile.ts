import path from 'node:path'
import fs from 'node:fs'
import { APP_HOME } from './engine/versions'
import { writeFileAtomic } from './atomicWrite'
import type { UserProfile } from '@shared/protocol'

// The local user profile (nickname + avatar color) lives alongside the engine
// in the app home folder, so it survives across launches and app updates.
const PROFILE_PATH = path.join(APP_HOME, 'profile.json')

/** Reads the saved profile, or null when none has been set yet / it's unreadable. */
export function readProfile(): UserProfile | null {
  try {
    const p = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'))
    const nickname = typeof p.nickname === 'string' ? p.nickname.trim() : ''
    const color = typeof p.color === 'string' ? p.color : ''
    if (!nickname || !color) return null
    return { nickname, color }
  } catch {
    return null
  }
}

/** Persists the profile, creating the home folder if needed. */
export function writeProfile(profile: UserProfile): void {
  fs.mkdirSync(APP_HOME, { recursive: true })
  writeFileAtomic(
    PROFILE_PATH,
    JSON.stringify({ nickname: profile.nickname.trim(), color: profile.color }, null, 2)
  )
}
