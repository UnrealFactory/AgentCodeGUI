import path from 'node:path'
import fs from 'node:fs'
import type { AgentStatus } from '@shared/protocol'
import { APP_HOME } from './engine/versions'
import { writeFileAtomic } from './atomicWrite'

// 추가 채팅(세션 창)의 영속 목록 — 창을 닫아도, 앱을 재시작해도 사이드바 '추가 채팅'에
// 남는 대화들. 스냅샷 모양(SessionState)은 렌더러가 소유하고 main의 Map이 전체 레코드를
// 들고 있다(마커 없음). 저장은 chats.ts처럼 채팅별 파일 팬아웃 + 내용 해시 비교 —
// 단일 블롭 시절엔 창 하나의 오토세이브마다 모든 추가 채팅의 스냅샷을 통째로 다시
// 직렬화·기록했다. 옛 단일 session-chats.json은 첫 read에서 마이그레이션.
const DIR = path.join(APP_HOME, 'session-chats')
const INDEX_PATH = path.join(DIR, 'index.json')
const LEGACY_BLOB = path.join(APP_HOME, 'session-chats.json')

const chatFile = (id: string): string => path.join(DIR, `${id}.json`)
// ids come from main's randomUUID(); reject anything else (no path traversal)
const safeId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9._-]+$/.test(id)

// id → last-seen file JSON, so a save only touches files whose content changed
const cache = new Map<string, string>()
let indexCache: string | null = null

export interface SessionChatRecord {
  id: string
  title: string
  custom?: boolean // 사이드바에서 이름을 바꾼 채팅 — 창의 자동 제목 보고를 무시
  status: AgentStatus // 저장 시 idle/done/error로 얼려서 온다 (실행 중 복원 방지)
  cwd: string
  refDirs?: string[] // 참조 폴더 — cwd 외 추가 작업 루트 (--add-dir)
  snapshot: unknown // 렌더러의 SessionState 스냅샷 (null = 아직 저장된 대화 없음)
  picker?: unknown
  draft?: string
  draftImages?: string[]
  empty?: boolean // 메시지 0 — 창을 닫을 때 목록에서 지우는 판정용
  updatedAt?: number
  // ── /btw 질문 채팅 (원본 대화의 컨텍스트를 포크해 시작한 추가 채팅) ──
  // btwOf: 원본 채팅 id — 그 채팅 화면의 btw 알약 도크가 이 채팅을 그린다.
  // btwSeed: 창의 첫 실행이 포크할 원본 세션(id+그 폴더). 자기 세션이 생기면 무시되므로
  // 지울 필요가 없다(폴더가 바뀌면 창 쪽 가드가 접는다).
  // btwPrompt: 자동 전송할 인라인 질문 — hydrate가 '읽으면 소비'로 한 번만 내려준다
  // (남겨두면 /clear 후 재열람 때 옛 질문이 되살아난다).
  btwOf?: string
  btwSeed?: { fork: string; cwd: string }
  btwPrompt?: string
}

const isRecord = (c: unknown): c is SessionChatRecord =>
  !!c && typeof c === 'object' && typeof (c as SessionChatRecord).id === 'string' && !!(c as SessionChatRecord).id

export function readSessionChats(): SessionChatRecord[] {
  // primary: per-chat files listed by index.json
  let index: { order?: unknown[] } | null = null
  try {
    index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'))
  } catch {
    index = null // no index yet — legacy migration below
  }
  if (index) {
    cache.clear()
    const chats: SessionChatRecord[] = []
    for (const id of Array.isArray(index.order) ? index.order : []) {
      if (!safeId(id)) continue
      try {
        const raw = fs.readFileSync(chatFile(id), 'utf8')
        const rec = JSON.parse(raw)
        if (!isRecord(rec)) continue
        cache.set(id, raw)
        chats.push(rec)
      } catch {
        /* skip a missing / corrupt chat file */
      }
    }
    // 인덱스가 있으면 비어 있어도 여기서 끝 — 레거시로 넘어가면 지운 채팅이 부활한다
    return chats
  }

  // migration: an older single session-chats.json → fan out, then drop it
  try {
    const raw = JSON.parse(fs.readFileSync(LEGACY_BLOB, 'utf8')) as { chats?: unknown }
    const chats = Array.isArray(raw?.chats) ? raw.chats.filter(isRecord) : []
    writeSessionChats(chats)
    try {
      fs.unlinkSync(LEGACY_BLOB)
    } catch {
      /* ignore */
    }
    return chats
  } catch {
    return []
  }
}

/** 목록 저장 (best effort) — 바뀐 레코드의 파일만 다시 쓴다. 빈 대화는 디스크에 남기지
 *  않는다 — 열었다 그냥 닫은 창이 재시작 후 목록을 어지럽히지 않게. */
export function writeSessionChats(chats: SessionChatRecord[]): void {
  try {
    fs.mkdirSync(DIR, { recursive: true })
    const present = new Set<string>()
    const order: string[] = []
    for (const rec of chats) {
      if (rec.empty || rec.snapshot == null || !safeId(rec.id)) continue
      present.add(rec.id)
      order.push(rec.id)
      const json = JSON.stringify(rec)
      if (cache.get(rec.id) !== json) {
        writeFileAtomic(chatFile(rec.id), json)
        cache.set(rec.id, json)
      }
    }
    // prune files for chats that no longer exist (or emptied back out)
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
      }
    }
    const indexJson = JSON.stringify({ version: 1, order })
    if (indexCache !== indexJson) {
      writeFileAtomic(INDEX_PATH, indexJson)
      indexCache = indexJson
    }
  } catch {
    /* ignore — 이번 저장만 건너뛴다 */
  }
}
