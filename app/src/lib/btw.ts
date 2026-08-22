/* ============================================================
 * /btw — 현재 대화의 컨텍스트를 포크해 별도 질문 창으로 여는 판정 로직.
 *
 * 순수 모듈(React·i18n 무의존)로 두는 이유: PoC(scripts/poc-btw-fork.mjs)가
 * 이 파일을 그대로 번들해 실 코드를 구동한다 — 판정이 복사본이 아니라 본체다.
 *  - parseBtw: 컴포저 텍스트가 /btw 명령인지 + 인라인 질문 분리
 *  - btwForkOf: 원본 채팅에서 "이어받을 수 있는" 포크 소스 판정
 *    (세션 없음·폴더 불일치·Codex(포크 미지원)는 null → 새 컨텍스트로 연다)
 *  - btwRunResume: btw 창의 실행이 쓸 resume/forkSession 결정
 *    (자기 세션 > 시드 포크 > 새 대화 — 시드는 원본 폴더·claude에서만)
 * ============================================================ */

/** Whether two working-directory paths point at the same folder. Used to gate session
 *  resume: a Claude Code session id is scoped to the project it was created in (its file
 *  lives under that cwd), so resuming it after the folder changed fails with
 *  "No conversation found with session ID". The engine echoes a cwd that can differ in
 *  format from what we sent (separators / trailing slash / drive-letter case), so we
 *  normalize before comparing — and treat a folder change as "start a fresh conversation".
 *  (원래 store/session.ts에 살던 함수 — /btw 판정 PoC가 순수 모듈을 요구해 이리로 옮겼고,
 *  store/session이 재수출해 기존 임포트는 그대로 동작한다.) */
export function sameCwd(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false
  const norm = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/** '/btw [질문]' 파싱 — 명령이면 인라인 질문(없으면 '')을, 아니면 null.
 *  '/btwxyz' 같은 접두 일치는 명령이 아니다. 대소문자 무관, 질문의 줄바꿈은 보존. */
export function parseBtw(text: string): { prompt: string } | null {
  const m = /^\/btw(?:\s+([\s\S]*))?$/i.exec(text.trim())
  if (!m) return null
  return { prompt: (m[1] ?? '').trim() }
}

/** 원본 채팅에서 포크할 수 있는 세션 — 가능할 때만 {fork, cwd}.
 *  세션이 아직 없거나(첫 응답 전), 폴더가 세션의 폴더와 다르거나(세션 id는 폴더 스코프),
 *  Codex 엔진이면(app-server엔 포크가 없다) null → 창은 새 컨텍스트로 열린다. */
export function btwForkOf(
  session: { sessionId: string; cwd: string } | null | undefined,
  cwd: string,
  engine?: 'claude' | 'codex'
): { fork: string; cwd: string } | null {
  if (!session || !session.sessionId) return null
  if (engine === 'codex') return null
  if (!sameCwd(session.cwd, cwd)) return null
  return { fork: session.sessionId, cwd: session.cwd }
}

/** 포크 첫 실행의 질문에 앞세우는 곁다리 질문 리마인더 — 클로드 코드 /btw의 실물
 *  system-reminder(CLI 2.1.237 실측 추출)를 이 앱의 창 구조에 맞게 옮긴 것.
 *  원문은 "도구 없음·단발 응답"인 오버레이 전제라 그대로 쓰면 거짓말이 된다(이 창은
 *  도구도 후속 턴도 있는 온전한 채팅) — 그래서 그 두 줄만 "읽기 전용으로 답하고,
 *  작업 이어하기·파일 수정은 금지(이 창에서 명시로 시키기 전까지)"로 바꿨다.
 *  핵심 목적은 동일: 컨텍스트를 통째로 이어받은 포크가 원본 작업을 마저 개발하려
 *  드는 사고(실사용 보고)를 막고, '질문에 답하는 별도 인스턴스'로 정체를 굳힌다.
 *  모델용 문구라 영어 고정(i18n 대상 아님) — 화면에는 안 보인다(엔진 전송분에만 붙음). */
export const BTW_SIDE_REMINDER = `<system-reminder>This is a side question from the user, asked in a separate window forked from the main conversation.

IMPORTANT CONTEXT:
- You are a separate instance spawned to answer this side question
- The main agent is NOT interrupted — it continues working independently, and its conversation never sees this window
- You share the conversation context up to this point, but you are a completely separate instance
- Do NOT reference being interrupted or what you were "previously doing" — that framing is incorrect

CRITICAL CONSTRAINTS:
- Do NOT continue, resume, or advance the main conversation's task — no file edits, no state-changing commands, no commits
- Answer the question directly from what you already know from the conversation context; you may use read-only tools (reading files, searching) if needed for an accurate answer
- Only make changes or take actions if the user explicitly asks for them in THIS window in a later message

Simply answer the question with the information you have.</system-reminder>`

/** 포크를 쏘는 실행(forkSession=true)의 엔진 전송 프롬프트 래핑 — 리마인더 + 원문.
 *  표시(스레드 말풍선)는 원문 그대로 두고 엔진에 보내는 텍스트에만 앞세운다
 *  (멘션/첨부 노트가 표시와 전송을 가르는 기존 문법과 동일). 이후 턴은 세션 컨텍스트에
 *  이 리마인더가 이미 남아 있으므로 다시 붙이지 않는다. */
export function wrapBtwFork(prompt: string): string {
  return `${BTW_SIDE_REMINDER}\n\n${prompt}`
}

/** btw 창의 실행이 쓸 resume/forkSession.
 *  자기 세션(own)이 생겼으면 보통 resume(포크는 첫 실행 한 번이면 끝),
 *  아직이면 시드 포크 — 단 원본 폴더 그대로일 때만(바꿨으면 세션을 못 찾는다),
 *  그리고 claude일 때만(창 안에서 Codex로 바꿨으면 포크를 접는다). 둘 다 아니면 새 대화. */
export function btwRunResume(
  own: string | undefined,
  seed: { fork: string; cwd: string } | null,
  cwd: string,
  engine?: 'claude' | 'codex'
): { resume?: string; forkSession?: boolean } {
  if (own) return { resume: own }
  if (seed && engine !== 'codex' && sameCwd(cwd, seed.cwd)) return { resume: seed.fork, forkSession: true }
  return {}
}
