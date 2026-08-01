import path from 'node:path'
import fs from 'node:fs'
import { APP_HOME } from './engine/versions'
import { writeFileAtomic } from './atomicWrite'

// The multi-agent workspace (session list + each session's 6-panel snapshots) lives in
// one JSON blob under the app home folder. The renderer owns the shape; this module
// reads/writes — plus one wrinkle: 렌더러는 비활성 세션의 패널 스냅샷을 메모리에 안 든다
// (unloaded 마커만 보냄). 저장 시 마커 세션은 디스크의 기존 패널을 다시 끼워 넣는다 —
// 그대로 쓰면 그 세션의 대화가 통째로 증발한다.
const FILE = path.join(APP_HOME, 'multi-agent.json')

interface MaSession {
  id?: unknown
  unloaded?: boolean
  count?: unknown
  panels?: unknown
}
interface MaBlob {
  sessions?: MaSession[]
}

// 마지막으로 읽거나 쓴 블롭 — 마커 병합의 원본(메인이 유일한 작성자라 항상 최신).
// 앱 기동 후 첫 저장이 read보다 먼저 오는 경우를 위해 필요 시 파일에서 채운다.
let lastBlob: MaBlob | null = null

function storedSessions(): Map<string, MaSession> {
  if (!lastBlob) {
    try {
      lastBlob = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    } catch {
      lastBlob = {}
    }
  }
  const map = new Map<string, MaSession>()
  for (const s of Array.isArray(lastBlob?.sessions) ? lastBlob!.sessions : []) {
    if (s && typeof s.id === 'string') map.set(s.id, s)
  }
  return map
}

/** Load the saved multi-agent workspace blob, or null when none has been saved yet. */
export function readMulti(): unknown {
  try {
    const blob = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    lastBlob = blob
    return blob
  } catch {
    return null
  }
}

/** One saved session by id — 렌더러가 세션 전환 때 내려둔 패널 스냅샷을 되읽는다. */
export function readMultiSession(id: unknown): unknown {
  if (typeof id !== 'string' || !id) return null
  return storedSessions().get(id) ?? null
}

/** Persist the multi-agent workspace blob (best effort — a write failure just skips this save). */
export function writeMulti(data: unknown): void {
  try {
    const blob = data as MaBlob | null
    if (blob && Array.isArray(blob.sessions)) {
      const stored = storedSessions()
      blob.sessions = blob.sessions.map((s) => {
        if (!s || !s.unloaded || typeof s.id !== 'string') return s
        // unloaded 마커: 메타(제목·시각…)는 마커 것, 패널·구성은 디스크 것을 지킨다
        const prev = stored.get(s.id)
        const merged: MaSession = { ...s, count: prev?.count ?? s.count, panels: prev?.panels ?? [] }
        delete merged.unloaded
        return merged
      })
    }
    fs.mkdirSync(APP_HOME, { recursive: true })
    writeFileAtomic(FILE, JSON.stringify(data))
    lastBlob = blob
  } catch {
    /* ignore */
  }
}
