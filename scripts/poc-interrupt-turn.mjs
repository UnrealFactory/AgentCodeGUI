/**
 * PoC — 취소=중단(interrupt-turn) 리듀서 리플레이 검증.
 * 회수(retract) 시절엔 Esc가 마지막 사용자 메시지부터 스레드를 걷어냈지만, CLI 세션에는
 * 그 턴이 실제로 남아 화면과 어긋났다. 새 동작: 흔적은 그대로 + '중단함' 마커 + 늦은
 * 프레임(델타/마무리/result/error) 무시. 시나리오별로 스레드 모양을 단언한다.
 *
 * 실행: npx esbuild src/renderer/src/store/session.ts --bundle --format=esm \
 *        --outfile=.poc-session.mjs --external:react --alias:@shared=./src/shared
 *       node scripts/poc-interrupt-turn.mjs
 * (아래에서 둘 다 자동으로 한다)
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const bundle = path.join(root, '.poc-session.mjs')
execSync(
  'npx esbuild src/renderer/src/store/session.ts --bundle --format=esm ' +
    `--outfile=${JSON.stringify(bundle)} --external:react --alias:@shared=./src/shared`,
  { cwd: root, stdio: 'pipe' }
)
const { reducer, initialSessionState } = await import(pathToFileURL(bundle).href)
fs.rmSync(bundle, { force: true })

let failed = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || detail == null ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (!cond) failed++
}
const kinds = (s) => s.messages.map((m) => m.kind).join(',')
const run = (actions) => actions.reduce((s, a) => reducer(s, a), initialSessionState)
const ev = (event) => ({ type: 'engine', event })

// ── 1. 스트리밍 중 Esc: 흔적 보존 + 마커 + 스피너 정착 ─────────────
{
  const s = run([
    { type: 'begin', text: '질문입니다', time: '9:00', command: null },
    ev({ type: 'status', runId: 'run-1', status: 'analyzing' }),
    ev({ type: 'tool-start', runId: 'run-1', tool: { id: 't1', verb: 'Read', kind: 'read', target: 'a.ts', status: 'running' } }),
    ev({ type: 'assistant-stream', runId: 'run-1', messageId: 'a1', delta: '답변의 앞부분' }),
    { type: 'interrupt-turn' }
  ])
  check('1 스레드 = user,toolgroup,msg,interrupted', kinds(s) === 'msg,toolgroup,msg,interrupted', kinds(s))
  check('1 사용자 말풍선 보존', s.messages[0].text === '질문입니다')
  check('1 부분 답변 보존', s.messages[2].text === '답변의 앞부분')
  const t = s.messages[1].tools[0]
  check('1 돌던 도구 스피너 → 중단됨 정착', t.status === 'done' && t.result === '중단됨', t)
  check('1 busy 즉시 해제 + interrupted 가드', s.status === 'idle' && s.interrupted === true)
}

// ── 2. 중단 뒤 늦은 프레임은 전부 무시 (마커 뒤 유령 방지) ──────────
{
  const base = [
    { type: 'begin', text: 'q', time: '9:00', command: null },
    ev({ type: 'status', runId: 'run-1', status: 'analyzing' }),
    ev({ type: 'assistant-stream', runId: 'run-1', messageId: 'a1', delta: '부분' }),
    { type: 'interrupt-turn' }
  ]
  const s = run([
    ...base,
    ev({ type: 'assistant-stream', runId: 'run-1', messageId: 'a1', delta: '늦은 델타' }),
    ev({ type: 'assistant-done', runId: 'run-1', messageId: 'a1', text: '전체 답변으로 덮기 시도' }),
    ev({ type: 'result', runId: 'run-1', costUsd: 0, durationMs: 5000, numTurns: 1, contextTokens: 10, contextWindow: 100, isError: true, text: '중단 여파 에러' }),
    ev({ type: 'error', runId: 'run-1', message: '죽으면서 내는 소리' })
  ])
  check('2 늦은 델타/마무리에 부분 답변 안 자람', s.messages[1].text === '부분', s.messages[1].text)
  check('2 result의 worked/에러 말풍선 안 붙음', kinds(s) === 'msg,msg,interrupted', kinds(s))
  check('2 result 데이터(컨텍스트 게이지)는 반영', s.result?.contextTokens === 10)
  const s2 = run([...base, ev({ type: 'status', runId: 'run-1', status: 'done' })])
  check('2 늦은 status done이 가드 해제', s2.interrupted === false)
}

// ── 3. 출력 전 Esc: 마커가 무음 안내를 대신한다 ────────────────────
{
  const s = run([
    { type: 'begin', text: 'q', time: '9:00', command: null },
    ev({ type: 'status', runId: 'run-1', status: 'analyzing' }),
    { type: 'interrupt-turn' },
    ev({ type: 'result', runId: 'run-1', costUsd: 0, durationMs: 800, numTurns: 0, contextTokens: null, contextWindow: null, isError: false, text: '' })
  ])
  check('3 user,interrupted — "응답 없이 끝났어요" 안내 없음', kinds(s) === 'msg,interrupted', kinds(s))
}

// ── 4. 명령(/compact) 턴 Esc: 카드만 중단 정착, 마커 없음 ──────────
{
  const s = run([
    { type: 'begin', text: '/compact', time: '9:00', command: 'compact' },
    ev({ type: 'status', runId: 'run-1', status: 'analyzing' }),
    { type: 'interrupt-turn' }
  ])
  const card = s.messages.find((m) => m.kind === 'cmdresult')
  check('4 카드 정착: 중단 제목 + 스피너 꺼짐', card && !card.running && card.failed && card.title === '명령을 중단했어요', card)
  check('4 마커 없음 + pendingCommand 해제', kinds(s) === 'cmdresult' && s.pendingCommand === null, kinds(s))
}

// ── 5. 중단 뒤 새 턴: 흔적 위에 이어서 + ↑ 히스토리에 남음 ─────────
{
  const s = run([
    { type: 'begin', text: '첫 질문', time: '9:00', command: null },
    ev({ type: 'status', runId: 'run-1', status: 'analyzing' }),
    ev({ type: 'assistant-stream', runId: 'run-1', messageId: 'a1', delta: '부분' }),
    { type: 'interrupt-turn' },
    { type: 'begin', text: '다음 질문', time: '9:01', command: null },
    ev({ type: 'status', runId: 'run-2', status: 'analyzing' }),
    ev({ type: 'assistant-stream', runId: 'run-2', messageId: 'a2', delta: '새 답변' })
  ])
  check('5 msg,msg,interrupted,msg,msg — 이어서 진행', kinds(s) === 'msg,msg,interrupted,msg,msg', kinds(s))
  check('5 새 델타 정상 수신(가드 해제)', s.messages[4].text === '새 답변')
  const hist = s.messages.filter((m) => m.kind === 'msg' && m.role === 'user').map((m) => m.text)
  check('5 중단된 메시지도 ↑ 히스토리 소스에 남음', hist.join('|') === '첫 질문|다음 질문', hist)
}

console.log(failed ? `\n${failed}개 실패` : '\n전부 통과')
process.exit(failed ? 1 : 0)
