// Regression: Codex commentary finishes, then the next reasoning/tool event takes
// 30–60 seconds. Completion must release the streaming flag immediately so all
// three chat surfaces can show their working indicator during that quiet gap.
// Run: node scripts/poc-working-indicator.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const dir = path.join(root, 'node_modules', '.cache', 'poc-working-indicator')
mkdirSync(dir, { recursive: true })
const bundle = path.join(dir, 'session.mjs')
const result = await build({
  absWorkingDir: root,
  entryPoints: ['app/src/store/session.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  external: ['react'],
  alias: { '@shared': './src/shared' }
})
writeFileSync(bundle, result.outputFiles[0].text)
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} }
const { reducer, initialSessionState } = await import(pathToFileURL(bundle).href)
const event = (state, e) => reducer(state, { type: 'engine', event: { runId: 'run-1', ...e } })
const begin = () => event(
  reducer(initialSessionState, { type: 'begin', text: '연결 방식을 검토해줘', time: '12:00', command: null }),
  { type: 'status', status: 'working' }
)
const stream = (state, messageId, delta) => event(state, { type: 'assistant-stream', messageId, delta })
const complete = (state, messageId, text) => event(state, { type: 'assistant-done', messageId, text })

test('commentary completion restores the working indicator without another engine event', () => {
  const started = begin()
  assert.equal(started.streaming, false, 'show activity immediately after sending')
  const writing = stream(started, 'm1', '연결 방식을')
  assert.equal(writing.streaming, true, 'text deltas provide feedback while writing')
  const settled = complete(writing, 'm1', '연결 방식을 검토하겠습니다.')
  assert.equal(settled.streaming, false, 'a completed message must not hide activity during silence')
  assert.equal(settled.status, 'working', 'message completion is not turn completion')
  assert.equal(settled.turnAt, started.turnAt, 'the elapsed time still belongs to the same turn')
  assert.deepEqual(settled.messages.filter((m) => m.id === 'm1').map((m) => m.text), ['연결 방식을 검토하겠습니다.'])
})

test('completion-only messages also release an earlier streaming state', () => {
  // A completion may create a new message instead of updating an existing one.
  const writing = stream(begin(), 'm1', '먼저 연결 방식을 봅니다.')
  const settled = complete(writing, 'm2', '참조를 연결하는 시점도 확인하겠습니다.')
  assert.equal(settled.streaming, false)
  assert.equal(settled.status, 'working')
  assert.deepEqual(settled.messages.filter((m) => m.role === 'assistant').map((m) => m.text), [
    '먼저 연결 방식을 봅니다.', '참조를 연결하는 시점도 확인하겠습니다.'
  ])
})

test('the next streamed reply hides activity only until that message completes', () => {
  const commentary = complete(stream(begin(), 'm1', '확인 중'), 'm1', '확인하겠습니다.')
  const writing = stream(commentary, 'm2', '제안은')
  assert.equal(writing.streaming, true)
  const settled = complete(writing, 'm2', '제안은 참조 연결 시점을 분리하는 것입니다.')
  assert.equal(settled.streaming, false)
  assert.equal(settled.status, 'working')
  const finished = event(settled, { type: 'status', status: 'done' })
  assert.equal(finished.status, 'done', 'the busy gate still hides activity when the turn ends')
})

test('late message completion after interruption cannot revive activity or overwrite text', () => {
  const writing = stream(begin(), 'm1', '부분 답변')
  const stopped = reducer(writing, { type: 'interrupt-turn' })
  const late = complete(stopped, 'm1', '중단 후 도착한 전체 답변')
  assert.equal(late.status, 'idle')
  assert.equal(late.streaming, false)
  assert.deepEqual(late.messages, stopped.messages)
})
