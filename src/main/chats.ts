import path from 'node:path'
import fs from 'node:fs'
import { APP_HOME } from './engine/versions'
import { writeFileAtomic } from './atomicWrite'

// One file per chat under ~/.agentcodegui/chats/ (<id>.json), plus a small
// index.json holding the order + which chat was active. The renderer still
// sends/receives one { version, chats, activeChatId } blob — this module fans it
// out to per-chat files and only rewrites the ones whose content actually changed.
const CHATS_DIR = path.join(APP_HOME, 'chats')
const INDEX_PATH = path.join(CHATS_DIR, 'index.json')
// older single-file format, migrated into per-chat files on first read
const LEGACY_BLOB = path.join(APP_HOME, 'chats.json')

const chatFile = (id: string): string => path.join(CHATS_DIR, `${id}.json`)
// chat ids are uuids / chat-<n>-<base36>; reject anything else (no path traversal)
const safeId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9._-]+$/.test(id)

// id → last-seen JSON string, so a save only touches files whose content changed
const cache = new Map<string, string>()

// unloaded 마커 채팅에 디스크의 기존 스냅샷을 다시 끼워 넣는다 — 마커엔 스냅샷이 없으므로
// 그대로 저장하면 대화가 지워진다. 파일도 캐시도 없으면(비정상) 스냅샷 없이 저장된다.
function withStoredSnapshot(id: string, chat: object): object {
  let snapshot: unknown
  try {
    const raw = cache.get(id) ?? fs.readFileSync(chatFile(id), 'utf8')
    snapshot = (JSON.parse(raw) as { snapshot?: unknown }).snapshot
  } catch {
    /* keep snapshot undefined */
  }
  const merged: Record<string, unknown> = { ...chat, snapshot }
  delete merged.unloaded
  return merged
}

interface ChatLike {
  id?: unknown
}
interface ChatsBlob {
  version?: number
  chats?: ChatLike[]
  activeChatId?: string
}

/** Reassembles the saved chats into the renderer's blob shape, or null when none. */
export function readChats(): unknown {
  // primary: per-chat files listed by index.json
  try {
    const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'))
    const order: unknown[] = Array.isArray(index.order) ? index.order : []
    cache.clear()
    const chats: unknown[] = []
    for (const id of order) {
      if (!safeId(id)) continue
      try {
        const raw = fs.readFileSync(chatFile(id), 'utf8')
        cache.set(id, raw)
        chats.push(JSON.parse(raw))
      } catch {
        /* skip a missing / corrupt chat file */
      }
    }
    if (chats.length) return { version: index.version ?? 1, chats, activeChatId: index.activeChatId ?? '' }
  } catch {
    /* no index yet — fall through to legacy migration */
  }

  // migration: an older single chats.json → fan out into per-chat files, then drop it
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_BLOB, 'utf8'))
    if (legacy && Array.isArray(legacy.chats) && legacy.chats.length) {
      writeChats(legacy)
      try {
        fs.unlinkSync(LEGACY_BLOB)
      } catch {
        /* ignore */
      }
      return legacy
    }
  } catch {
    /* no legacy file */
  }

  return null
}

/** One chat's saved file, parsed — the renderer's lazy snapshot load on chat switch. */
export function readChat(id: unknown): unknown {
  if (!safeId(id)) return null
  try {
    const raw = cache.get(id) ?? fs.readFileSync(chatFile(id), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Persists the blob as per-chat files, rewriting only changed ones and pruning removed ones. */
export function writeChats(data: unknown): void {
  const blob = data as ChatsBlob | null
  if (!blob || !Array.isArray(blob.chats)) return
  try {
    fs.mkdirSync(CHATS_DIR, { recursive: true })
    const present = new Set<string>()
    const order: string[] = []
    for (const chat of blob.chats) {
      if (!safeId(chat?.id)) continue
      const id = chat.id as string
      present.add(id)
      order.push(id)
      // 렌더러가 스냅샷을 내린(unloaded) 채팅 — 메타(제목·폴더·초안…)만 온다. 파일의
      // 스냅샷은 지키고 메타만 덮어쓴다: 여기서 그냥 저장하면 대화 내용이 통째로 증발한다.
      const merged = (chat as { unloaded?: boolean }).unloaded ? withStoredSnapshot(id, chat) : chat
      const json = JSON.stringify(merged)
      if (cache.get(id) !== json) {
        writeFileAtomic(chatFile(id), json)
        cache.set(id, json)
      }
    }
    // prune files for chats that no longer exist
    let existing: string[] = []
    try {
      existing = fs.readdirSync(CHATS_DIR).filter((f) => f.endsWith('.json') && f !== 'index.json')
    } catch {
      /* dir was just created */
    }
    for (const f of existing) {
      const id = f.slice(0, -'.json'.length)
      if (!present.has(id)) {
        try {
          fs.unlinkSync(path.join(CHATS_DIR, f))
        } catch {
          /* ignore */
        }
        cache.delete(id)
      }
    }
    writeFileAtomic(
      INDEX_PATH,
      JSON.stringify({ version: blob.version ?? 1, order, activeChatId: blob.activeChatId ?? '' })
    )
  } catch {
    /* best effort — a write failure just means this turn isn't persisted */
  }
}
