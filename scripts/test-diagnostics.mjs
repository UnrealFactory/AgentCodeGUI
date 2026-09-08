// Replay both production reducers: node scripts/test-diagnostics.mjs
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
globalThis.localStorage = { getItem: () => null }
const bundle = await build({
  stdin: { contents: `export * as app from './app/src/store/session';
    export * as electron from './src/renderer/src/store/session';
    export * from './src/shared/diagnostics';`, resolveDir: root, loader: 'ts' },
  alias: { '@shared': path.join(root, 'src/shared') },
  bundle: true, platform: 'node', format: 'cjs', write: false
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, mod, mod.exports)
const { app, electron, DIAGNOSTIC_ENTRY_LIMIT, classifyDiagnostic } = mod.exports
const retry = (n) => `Codex: Reconnecting... ${n}/5 — 다시 시도하는 중이에요.`
const fallback = 'Codex: Falling back from WebSockets to HTTPS transport. stream disconnected before completion: websocket closed by server before response completed.'
const logs = (s, group) => s.messages.filter((m) => m.diagnostics?.group === group)
const emit = (reduce, s, e, runId = 'run-1') => reduce(s, { type: 'engine', event: { runId, ...e } })
const begin = (reduce, s, runId = 'run-1') => emit(reduce, reduce(s, { type: 'begin', text: 'Continue', time: '11:10', command: null }), { type: 'status', status: 'analyzing' }, runId)
const tool = (id, parentToolId) => ({ id, verb: 'Bash', kind: 'bash', target: 'echo test', status: 'running', parentToolId })

for (const [name, { reducer, initialSessionState, snapshotForPersist, sanitizeSnapshot }] of Object.entries({ app, electron })) {
  const send = (s, e, runId) => emit(reducer, s, e, runId)
  let s = begin(reducer, initialSessionState)
  for (let n = 2; n <= 5; n++) s = send(s, { type: 'notice', text: retry(n) })
  assert.equal(logs(s, 'connection').length, 1)
  assert.equal(logs(s, 'connection')[0].diagnostics.total, 4)
  assert.equal(s.connectionRetry.attempt, 5)
  const id = logs(s, 'connection')[0].id
  s = send(s, { type: 'notice', text: fallback })
  assert.equal(logs(s, 'connection')[0].id, id, 'retry updates the original row')
  assert.equal(s.connectionRetry.phase, 'fallback')

  for (const event of [
    { type: 'status', status: 'working' },
    { type: 'status', status: 'analyzing' },
    { type: 'tool-start', tool: tool('child', 'agent-parent') },
    { type: 'tool-end', id: 'child', status: 'done' },
    { type: 'bg-tasks', tasks: [] },
    { type: 'terminal', line: { id: 'line1', text: 'background output', time: '11:12' } }
  ]) {
    s = send(s, event)
    assert.equal(s.connectionRetry.phase, 'fallback', `${event.type} cannot claim main model recovery`)
  }
  const beforeStale = s
  for (const e of [
    { type: 'notice', text: retry(1) },
    { type: 'notice', text: '[stderr] old run' },
    { type: 'assistant-stream', messageId: 'stale', delta: 'old response' },
    { type: 'thinking', text: 'old thoughts' },
    { type: 'status', status: 'done' },
    { type: 'error', message: 'old error' }
  ]) s = send(s, e, 'old-run')
  assert.equal(s, beforeStale, 'old-run events cannot hide or overwrite the current retry')

  s = send(s, { type: 'tool-start', tool: tool('main') })
  assert.equal(s.connectionRetry, null)
  assert.equal(logs(s, 'connection')[0].diagnostics.state, 'resumed')
  s = send(s, { type: 'notice', text: retry(1) })
  assert.equal(logs(s, 'connection').length, 1, 'another retry in the same turn reuses the group')
  assert.equal(logs(s, 'connection')[0].diagnostics.state, 'active')
  s = send(s, { type: 'assistant-stream', messageId: 'reply', delta: 'Back to work' })
  assert.equal(s.connectionRetry, null)
  assert.equal(s.streaming, true)
  s = send(s, { type: 'notice', text: '[stderr] network trace' })
  s = send(s, { type: 'notice', text: '[stderr] network trace' })
  assert.equal(logs(s, 'stderr').length, 1)
  assert.equal(logs(s, 'stderr')[0].diagnostics.entries[0].count, 2)
  assert.equal(s.streaming, true, 'stderr does not disturb real progress')
  for (let n = 0; n < 150; n++) s = send(s, { type: 'notice', text: `[stderr] trace ${n}` })
  const stderr = logs(s, 'stderr')[0].diagnostics
  assert.equal(stderr.entries.length, DIAGNOSTIC_ENTRY_LIMIT)
  assert.equal(stderr.total, 152)
  assert.equal(stderr.omitted, 52)
  assert.equal(stderr.entries.at(-1).text, '[stderr] trace 149')

  s = send(s, { type: 'notice', text: 'Codex: Please sign in again.' })
  s = send(s, { type: 'notice', text: 'API billing enabled', once: 'api-billing' })
  assert.ok(s.messages.some(m => m.kind === 'notice' && m.text === 'Codex: Please sign in again.' && !m.diagnostics))
  assert.ok(s.shownNotices.includes('api-billing'))
  assert.ok(s.messages.some(m => (m.text === 'API billing enabled' || m.action === 'billing-off') && !m.diagnostics))
  s = send(s, { type: 'notice', text: retry(5) })
  const persisted = snapshotForPersist(s)
  assert.equal(persisted.connectionRetry, null)
  assert.equal(logs(persisted, 'connection')[0].diagnostics.state, 'history')
  assert.equal(s.connectionRetry.attempt, 5, 'persisting cannot mutate live state')
  assert.equal(logs(sanitizeSnapshot(persisted), 'stderr')[0].diagnostics.total, 152)

  const failed = send(s, { type: 'error', message: 'Connection failed permanently' })
  assert.equal(failed.connectionRetry, null)
  assert.equal(logs(failed, 'connection')[0].diagnostics.state, 'history')
  assert.ok(failed.messages.some(m => m.kind === 'msg' && m.error && m.text.includes('Connection failed permanently')))
  for (const status of ['done', 'idle', 'error']) {
    const ended = send(s, { type: 'status', status })
    assert.equal(ended.connectionRetry, null)
    assert.equal(logs(ended, 'connection')[0].diagnostics.state, 'history')
  }
  const interrupted = reducer(s, { type: 'interrupt-turn' })
  assert.equal(interrupted.connectionRetry, null)
  assert.equal(logs(interrupted, 'connection')[0].diagnostics.state, 'history')
  assert.equal(send(interrupted, { type: 'notice', text: retry(1) }).connectionRetry, null)
  const pending = reducer(s, { type: 'begin', text: 'Next turn', time: '11:15', command: null })
  assert.equal(send(pending, { type: 'notice', text: retry(1) }), pending)
  const next = send(begin(reducer, s, 'run-2'), { type: 'notice', text: retry(1) }, 'run-2')
  assert.equal(logs(next, 'connection').length, 2, 'different turns keep separate records')
  assert.equal(logs(next, 'connection')[0].diagnostics.state, 'history')

  const raw = [
    { kind: 'msg', id: 'u', role: 'user', text: retry(2), time: '11:10' },
    ...[2, 3, 4, 5].map(n => ({ kind: 'notice', id: `n${n}`, text: retry(n), time: '11:11' })),
    { kind: 'notice', id: 'nf', text: fallback, time: '11:11' },
    { kind: 'notice', id: 'ne', text: '[stderr] trace', time: '11:11' },
    { kind: 'notice', id: 'ns', text: 'Codex: sign in required', time: '11:11' },
    { kind: 'msg', id: 'u2', role: 'user', text: 'next', time: '11:12' },
    { kind: 'notice', id: 'n7', text: retry(2), time: '11:13' }
  ]
  const restored = sanitizeSnapshot({ messages: raw, connectionRetry: { phase: 'retry' } })
  assert.equal(restored.messages[0].text, retry(2), 'user content is never classified')
  assert.equal(logs(restored, 'connection').length, 2)
  assert.equal(logs(restored, 'connection')[0].diagnostics.total, 5)
  assert.ok(logs(restored, 'connection').every(m => m.diagnostics.state === 'history'))
  assert.equal(restored.connectionRetry, null)
  assert.deepEqual(sanitizeSnapshot(restored).messages, restored.messages, 'migration is idempotent')
  console.log(`${name}: grouping, bounded stderr, current status, stale events, recovery, termination and snapshot migration passed.`)
}

let s = begin(app.reducer, app.initialSessionState)
const apiRetry = { type: 'api-retry', attempt: 2, maxRetries: 5, retryInMs: 1000, status: 529, error: 'overloaded' }
s = emit(app.reducer, s, apiRetry)
for (const e of [{ type: 'status', status: 'working' }, { type: 'tool-start', tool: tool('child', 'agent') }, { type: 'tool-end', id: 'child', status: 'done' }]) {
  s = emit(app.reducer, s, e)
  assert.equal(s.apiRetry.attempt, 2)
}
assert.equal(emit(app.reducer, s, { type: 'error', message: 'stale' }, 'old').apiRetry, s.apiRetry)
assert.equal(emit(app.reducer, s, { type: 'assistant-done', messageId: 'reply', text: 'Recovered' }).apiRetry, null)
s = emit(app.reducer, s, { type: 'notice', text: retry(3) })
assert.equal(s.apiRetry, null)
s = emit(app.reducer, s, apiRetry)
assert.equal(s.connectionRetry, null, 'the latest retry type owns the live indicator')
assert.equal(classifyDiagnostic('Codex: request failed — retrying.').group, 'connection')
assert.equal(classifyDiagnostic('Some unrelated retrying error'), null)
console.log('API retry progress guards and narrowly scoped notice classification passed.')
