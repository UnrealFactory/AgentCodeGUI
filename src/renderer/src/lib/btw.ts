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
