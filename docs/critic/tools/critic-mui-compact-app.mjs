/**
 * M-UI R1 크리틱 — `poc-auto-compact.mjs`의 B파트(리듀서 검사 5·8·9)를 **app/src 리듀서**로
 * 다시 돌린다.
 *
 * 왜: 본 하네스는 `src/renderer/src/store/session.ts`(2.6.2 렌더러)를 번들한다. M-UI는
 * `app/src/store/session.ts`만 고쳤으므로, 단정만 3.0 문법으로 바꾸면 게이트가 빨개진다.
 * 여기선 "단정 값 자체는 맞았는가"를 가른다 — 진입점만 app/src로 바꿔 같은 검사를 돌린다.
 *
 *   node docs/critic/tools/critic-mui-compact-app.mjs
 */
import esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = 'C:/Code/AgentCodeGUI'
let failed = 0
const rows = []
const check = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || detail == null ? '' : ` — ${JSON.stringify(detail)}`}`)
  rows.push({ name, ok: !!cond, detail: cond ? null : detail })
  if (!cond) failed++
}

globalThis.localStorage = { getItem: () => null, setItem: () => {} }

const out = path.join(root, '.poc-store-compact-app.mjs')
await esbuild.build({
  entryPoints: [path.join(root, 'app/src/store/session.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  alias: { '@shared': path.join(root, 'src/shared') },
  logLevel: 'silent'
})
const { reducer, initialSessionState } = await import(pathToFileURL(out).href)
fs.rmSync(out, { force: true })

const eng = (event) => ({ type: 'engine', event })
const compactEv = (over = {}) => ({ type: 'compact', runId: 'r1', trigger: 'auto', preTokens: 150000, afterTokens: 12300, ...over })
const lastMsg = (s) => s.messages[s.messages.length - 1]

const withWindow = reducer(
  initialSessionState,
  eng({ type: 'result', runId: 'r1', isError: false, text: '', costUsd: null, durationMs: null, numTurns: null, contextTokens: 150000, contextWindow: 200000, viaApi: false })
)

const m5 = lastMsg(reducer(withWindow, eng(compactEv())))
check('5 auto → boundary(compact) 경계 선', m5?.kind === 'boundary' && m5?.glyph === 'compact', m5)
check('5 라벨 = 여기까지 요약됨', m5?.label === '여기까지 요약됨', m5?.label)
check('5 수치 = 150K → 12K · 컨텍스트 75% → 6%', m5?.num === '150K → 12K · 컨텍스트 75% → 6%', m5?.num)
check('6 manual 무시', reducer(withWindow, eng(compactEv({ trigger: 'manual' }))) === withWindow)
const pending = { ...withWindow, pendingCommand: { name: 'compact', beforeContext: 150000, beforeMsgs: 2, cardId: 'c1' } }
check('7 pendingCommand=compact 중 무시', reducer(pending, eng(compactEv())) === pending)
const m8 = lastMsg(reducer(initialSessionState, eng(compactEv())))
check('8 window 미상 → 토큰 전/후만', m8?.kind === 'boundary' && m8?.num === '150K → 12K', m8?.num)
const m9 = lastMsg(reducer(withWindow, eng(compactEv({ afterTokens: null }))))
check('9 after 미상 → 수치 없음', m9?.kind === 'boundary' && m9?.num === null, m9?.num)

fs.writeFileSync(
  path.join(root, 'docs/critic/mui-apply-r1-compact.json'),
  JSON.stringify({ at: new Date().toISOString(), entry: 'app/src/store/session.ts', failed, rows }, null, 1)
)
console.log(failed ? `\n${failed} FAILED` : '\nall ok')
