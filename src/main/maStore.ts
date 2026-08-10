import path from 'node:path'
import fs from 'node:fs'
import { APP_HOME } from './engine/versions'
import { writeFileAtomic } from './atomicWrite'

// The multi-agent workspace, fanned out one file per session (chats.ts와 같은 구조):
// APP_HOME/multi-agent/<id>.json + index.json(버전·순서·활성 세션). 렌더러 계약은
// 그대로 블롭 하나 주고받기 — 이 모듈이 팬아웃/재조립을 맡는다. 통 직렬화 시절엔
// 저장(700ms 디바운스)마다 전 세션×6패널 스냅샷을 다시 stringify+기록해 저장 비용이
// 세션 수에 비례해 자랐다. 옛 단일 multi-agent.json은 첫 read에서 마이그레이션.
//
// 한 가지 굴곡은 유지: 렌더러는 비활성 세션의 패널 스냅샷을 메모리에 안 든다(unloaded
// 마커만 보냄). 마커 세션은 디스크의 기존 패널을 다시 끼워 저장한다 — 그대로 쓰면
// 그 세션의 대화가 통째로 증발한다.
const DIR = path.join(APP_HOME, 'multi-agent')
const INDEX_PATH = path.join(DIR, 'index.json')
// older single-file format, migrated into per-session files on first read
const LEGACY_BLOB = path.join(APP_HOME, 'multi-agent.json')

const sessionFile = (id: string): string => path.join(DIR, `${id}.json`)
// ids are uuids / ms-<n>-<base36>; reject anything else (no path traversal)
const safeId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9._-]+$/.test(id)

interface MaSession {
  id?: unknown
  unloaded?: boolean
  count?: unknown
  panels?: unknown
}
interface MaBlob {
  version?: number
  activeSessionId?: string
  sessions?: MaSession[]
}

// id → last-seen file JSON, so a save only touches files whose content changed
const cache = new Map<string, string>()
// id → 마지막 마커 페이로드의 JSON — 같은 마커가 또 오면(제목·시각 불변) 패널을
// 파싱·재직렬화하지 않고 통째로 건너뛴다. 전체 저장이 오면 무효(다음 마커가 재계산).
const metaCache = new Map<string, string>()
let indexCache: string | null = null

/** unloaded 마커 세션에 디스크의 기존 패널을 다시 끼워 넣는다. */
function withStoredPanels(id: string, marker: MaSession): MaSession {
  let prev: MaSession | null = null
  try {
    prev = JSON.parse(cache.get(id) ?? fs.readFileSync(sessionFile(id), 'utf8'))
  } catch {
    /* 파일도 캐시도 없음(비정상) — 패널 없이 저장된다 */
  }
  const merged: MaSession = { ...marker, count: prev?.count ?? marker.count, panels: prev?.panels ?? [] }
  delete merged.unloaded
  delete (merged as { panelStatuses?: unknown }).panelStatuses // 부팅 마커의 배지 요약 — 파일엔 안 남긴다
  return merged
}

/** Load the saved multi-agent workspace blob, or null when none has been saved yet.
 *  light: 부팅용 — 활성 세션만 패널을 싣고, 나머지는 unloaded 마커(+상태 배지용
 *  panelStatuses)로 보낸다. 렌더러가 받자마자 버리던 비활성 패널 스냅샷의 직렬화·
 *  역직렬화를 통째로 건너뛴다. 세션 전환 시엔 readMultiSession이 되읽는다. */
export function readMulti(light = false): unknown {
  // primary: per-session files listed by index.json
  let index: { version?: number; activeSessionId?: string; order?: unknown[] } | null = null
  try {
    index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'))
  } catch {
    index = null // no index yet — legacy migration below
  }
  if (index) {
    cache.clear()
    metaCache.clear()
    const sessions: Record<string, unknown>[] = []
    for (const id of Array.isArray(index.order) ? index.order : []) {
      if (!safeId(id)) continue
      try {
        const raw = fs.readFileSync(sessionFile(id), 'utf8')
        cache.set(id, raw)
        sessions.push(JSON.parse(raw))
      } catch {
        /* skip a missing / corrupt session file */
      }
    }
    if (!sessions.length) return null // 인덱스가 있으면 비어 있어도 여기서 끝 — 레거시로 넘어가면 지운 세션이 부활한다
    const activeSessionId = index.activeSessionId ?? ''
    let out: unknown[] = sessions
    if (light) {
      // 렌더러의 마커 판정(활성이거나 스냅샷 있는 패널이 없으면 그대로)과 같은 기준
      const panelsOf = (s: Record<string, unknown>): Array<{ snapshot?: { status?: unknown } } | null> =>
        Array.isArray(s.panels) ? (s.panels as Array<{ snapshot?: { status?: unknown } } | null>) : []
      const act = sessions.find((s) => s.id === activeSessionId) ?? sessions[0]
      out = sessions.map((s) => {
        const panels = panelsOf(s)
        if (s === act || !panels.some((p) => p?.snapshot)) return s
        return { ...s, panels: [], panelStatuses: panels.map((p) => String(p?.snapshot?.status ?? 'idle')), unloaded: true }
      })
    }
    return { version: index.version ?? 1, activeSessionId, sessions: out }
  }

  // migration: an older single multi-agent.json → fan out, then drop it
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_BLOB, 'utf8'))
    if (legacy && Array.isArray(legacy.sessions) && legacy.sessions.length) {
      writeMulti(legacy)
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

/** One saved session by id — 렌더러가 세션 전환 때 내려둔 패널 스냅샷을 되읽는다. */
export function readMultiSession(id: unknown): unknown {
  if (!safeId(id)) return null
  try {
    const raw = cache.get(id) ?? fs.readFileSync(sessionFile(id), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Persist the workspace as per-session files, rewriting only changed ones and pruning removed ones. */
export function writeMulti(data: unknown): void {
  const blob = data as MaBlob | null
  if (!blob || !Array.isArray(blob.sessions)) return
  try {
    fs.mkdirSync(DIR, { recursive: true })
    const present = new Set<string>()
    const order: string[] = []
    for (const s of blob.sessions) {
      if (!s || !safeId(s.id)) continue
      const id = s.id
      present.add(id)
      order.push(id)
      if (s.unloaded) {
        // 마커가 지난번과 그대로면(제목·시각 불변) 파일도 그대로다 — 병합 자체를 생략
        const markerJson = JSON.stringify({ ...s, unloaded: undefined })
        if (metaCache.get(id) === markerJson && cache.has(id)) continue
        const json = JSON.stringify(withStoredPanels(id, s))
        if (cache.get(id) !== json) {
          writeFileAtomic(sessionFile(id), json)
          cache.set(id, json)
        }
        metaCache.set(id, markerJson)
      } else {
        const json = JSON.stringify(s)
        if (cache.get(id) !== json) {
          writeFileAtomic(sessionFile(id), json)
          cache.set(id, json)
        }
        metaCache.delete(id) // 전체 저장이 왔다 — 다음 마커는 병합을 다시 계산한다
      }
    }
    // prune files for sessions that no longer exist
    let existing: string[] = []
    try {
      existing = fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'index.json')
    } catch {
      /* dir was just created */
    }
    for (const f of existing) {
      const id = f.slice(0, -'.json'.length)
      if (!present.has(id)) {
        try {
          fs.unlinkSync(path.join(DIR, f))
        } catch {
          /* ignore */
        }
        cache.delete(id)
        metaCache.delete(id)
      }
    }
    const indexJson = JSON.stringify({ version: blob.version ?? 1, activeSessionId: blob.activeSessionId ?? '', order })
    if (indexCache !== indexJson) {
      writeFileAtomic(INDEX_PATH, indexJson)
      indexCache = indexJson
    }
  } catch {
    /* best effort — a write failure just means this save is skipped */
  }
}
