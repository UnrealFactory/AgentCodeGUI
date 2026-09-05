/**
 * PoC — PENDING 매듭 풀기(2026-09-04 보고: /clear 뒤 첫 전송이 '작업 중'에 굳음).
 *
 * 실행 채택(curRunId 확정)은 status:analyzing 하나에만 걸려 있다. 그 이벤트가 전송 중
 * 한 번 유실되면 curRunId가 PENDING에 묶이고, 그 뒤 working·result·done이 전부 잔재로
 * 버려져 스피너가 영영 안 풀린다(답이 와도 화면이 안 받는다). 이 스크립트는 그 유실을
 * 재현하고, 뒤이은 working이 실행을 채택해 매듭을 푸는지 단언한다.
 *
 * 실행: node scripts/poc-pending-adopt.mjs (아래에서 esbuild 번들까지 자동으로 한다)
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const bundle = path.join(root, '.poc-session.mjs')
execSync(
  'npx esbuild app/src/store/session.ts --bundle --format=esm ' +
    `--outfile=${JSON.stringify(bundle)} --external:react --alias:@shared=./src/shared`,
  { cwd: root, stdio: 'pipe' }
)
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} }
const { reducer, initialSessionState } = await import(pathToFileURL(bundle).href)
fs.rmSync(bundle, { force: true })

let failed = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || detail == null ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (!cond) failed++
}
const run = (actions) => actions.reduce((s, a) => reducer(s, a), initialSessionState)
const ev = (event) => ({ type: 'engine', event })
const begin = { type: 'begin', text: '설정 두 개 추가해줘', command: null, time: '오후 9:57' }

// ── 1. analyzing 유실 → working이 매듭을 푼다(핵심 회귀) ─────────────────────
{
  // begin(pending) → [analyzing 유실] → working r5 → assistant → result done
  const s = run([
    begin,
    // analyzing을 일부러 뺀다 (전송 중 유실 재현)
    ev({ type: 'status', runId: 'run-5', status: 'working' }),
    ev({ type: 'assistant-done', runId: 'run-5', messageId: 'a1', text: '두 옵션을 추가했어요.' }),
    ev({ type: 'status', runId: 'run-5', status: 'done' })
  ])
  check('working이 PENDING에서 실행을 채택한다', s.curRunId === 'run-5', s.curRunId)
  check('턴이 done으로 정착한다(스피너 풀림)', s.status === 'done', s.status)
  check('답변이 스레드에 남는다', s.messages.some((m) => m.kind === 'msg' && m.role === 'assistant'), s.messages.map((m) => m.kind))
}

// ── 2. 정상 경로(analyzing 있음)는 그대로 — working이 채택을 뒤엎지 않는다 ──────
{
  const s = run([
    begin,
    ev({ type: 'status', runId: 'run-7', status: 'analyzing' }),
    ev({ type: 'status', runId: 'run-7', status: 'working' }),
    ev({ type: 'status', runId: 'run-7', status: 'done' })
  ])
  check('정상 경로 채택 유지', s.curRunId === 'run-7', s.curRunId)
  check('정상 경로 done', s.status === 'done', s.status)
}

// ── 3. 죽어가는 이전 실행의 잔재(done/error)는 PENDING을 채택하지 않는다 ─────────
{
  // begin(pending) 직후 이전 실행 run-3의 늦은 done/error가 흘러들어도 매듭이 풀리면 안 된다
  const s = run([
    begin,
    ev({ type: 'status', runId: 'run-3', status: 'done' }),
    ev({ type: 'result', runId: 'run-3', costUsd: 0, durationMs: 10, numTurns: 1, contextTokens: 10, contextWindow: 200000 }),
    ev({ type: 'error', runId: 'run-3', message: '이전 실행의 죽음' })
  ])
  check('이전 실행 잔재는 PENDING을 안 푼다', s.curRunId === 'pending', s.curRunId)
  check('스피너 유지(analyzing)', s.status === 'analyzing', s.status)
  check('잔재 오류 말풍선을 안 그린다', !s.messages.some((m) => m.kind === 'notice' || (m.kind === 'msg' && m.role === 'assistant')), s.messages.map((m) => m.kind))
}

// ── 4. 채택 뒤 다른 runId의 working은 여전히 잔재로 버린다(경계 가드 유지) ──────
{
  const s = run([
    begin,
    ev({ type: 'status', runId: 'run-9', status: 'working' }), // 채택
    ev({ type: 'status', runId: 'run-8', status: 'working' }) // 남의 실행 — 무시
  ])
  check('채택 뒤 남의 working 무시', s.curRunId === 'run-9', s.curRunId)
}

console.log(failed ? `\n${failed} FAILED` : '\nALL PASS')
process.exit(failed ? 1 : 0)
