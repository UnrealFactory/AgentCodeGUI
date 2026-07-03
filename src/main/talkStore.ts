import path from 'node:path'
import fs from 'node:fs'
import { APP_HOME } from './engine/versions'
import { writeFileAtomic } from './atomicWrite'

// The 채팅(pure conversation) workspace — its conversation list + each chat's frozen
// session thread. Pure chats carry no tool logs / diffs, so they stay small and bounded;
// like the multi-agent workspace they live in one JSON blob under the app home folder
// rather than the per-file fan-out the single-agent chat history uses. The renderer owns
// the shape; this module just reads/writes.
const FILE = path.join(APP_HOME, 'chat-talk.json')

/** Load the saved chat-workspace blob, or null when none has been saved yet. */
export function readTalk(): unknown {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch {
    return null
  }
}

/** Persist the chat-workspace blob (best effort — a write failure just skips this save). */
export function writeTalk(data: unknown): void {
  try {
    fs.mkdirSync(APP_HOME, { recursive: true })
    writeFileAtomic(FILE, JSON.stringify(data))
  } catch {
    /* ignore */
  }
}
