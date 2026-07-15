import path from 'node:path'
import fs from 'node:fs'
import type { AgentStatus } from '@shared/protocol'
import { APP_HOME } from './engine/versions'
import { writeFileAtomic } from './atomicWrite'

// 추가 채팅(세션 창)의 영속 목록 — 창을 닫아도, 앱을 재시작해도 사이드바 '추가 채팅'에
// 남는 대화들. 스냅샷 모양(SessionState)은 렌더러가 소유하고, 이 모듈은 talk/multi처럼
// 앱 홈의 단일 JSON 블롭으로 레코드를 읽고 쓰기만 한다. 세션 창은 동시에 몇 개 수준이라
// 채팅별 파일 팬아웃(chats.ts) 없이 블롭 하나로 충분하다.
const FILE = path.join(APP_HOME, 'session-chats.json')

export interface SessionChatRecord {
  id: string
  title: string
  custom?: boolean // 사이드바에서 이름을 바꾼 채팅 — 창의 자동 제목 보고를 무시
  status: AgentStatus // 저장 시 idle/done/error로 얼려서 온다 (실행 중 복원 방지)
  cwd: string
  snapshot: unknown // 렌더러의 SessionState 스냅샷 (null = 아직 저장된 대화 없음)
  picker?: unknown
  draft?: string
  draftImages?: string[]
  empty?: boolean // 메시지 0 — 창을 닫을 때 목록에서 지우는 판정용
  updatedAt?: number
}

export function readSessionChats(): SessionChatRecord[] {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as { chats?: unknown }
    if (!Array.isArray(raw?.chats)) return []
    return raw.chats.filter(
      (c): c is SessionChatRecord => !!c && typeof c === 'object' && typeof (c as SessionChatRecord).id === 'string' && !!(c as SessionChatRecord).id
    )
  } catch {
    return []
  }
}

/** 목록 저장 (best effort). 빈 대화는 디스크에 남기지 않는다 — 열었다 그냥 닫은 창이
 *  재시작 후 목록을 어지럽히지 않게. */
export function writeSessionChats(chats: SessionChatRecord[]): void {
  try {
    fs.mkdirSync(APP_HOME, { recursive: true })
    writeFileAtomic(FILE, JSON.stringify({ version: 1, chats: chats.filter((c) => !c.empty && c.snapshot != null) }))
  } catch {
    /* ignore — 이번 저장만 건너뛴다 */
  }
}
