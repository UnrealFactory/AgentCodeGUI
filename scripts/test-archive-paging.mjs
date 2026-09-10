import assert from 'node:assert/strict'
import test from 'node:test'
import { loadArchivePage } from '../app/src/lib/archivePaging.ts'

const entry = (seq, source = 'input', kind = 'user') => ({ seq, source, kind, at: seq, preview: '', turnId: null, payloadBytes: 1 })
const files = (seq, endSeq, count) => ({ ...entry(seq, 'file', 'file-version'), fileGroup: { endSeq, count } })
const page = (items, next, total = 30000) => ({ items, next, total })

test('conversations after several file-only scans appear with one merged file card', async () => {
  const calls = []
  const pages = new Map([
    [1, page([files(1, 4000, 3842)], 4001)],
    [4001, page([files(4001, 8000, 3900)], 8001)],
    [8001, page([], 12001)],
    [12001, page([files(12001, 16000, 3900)], 16001)],
    [16001, page([files(16001, 21000, 4100), entry(21616), entry(21946, 'ui', 'assistant-done')], null)]
  ])
  const result = await loadArchivePage({ from: 1, source: 'timeline', read: async position => { calls.push(position); return pages.get(position) } })
  assert.deepEqual(calls, [1, 4001, 8001, 12001, 16001])
  assert.deepEqual(result.items.map(e => e.seq), [1, 21616, 21946])
  assert.deepEqual(result.items[0].fileGroup, { endSeq: 21000, count: 15742 })
  assert.equal(result.next, null)
})

test('the next display page resumes at the first unused card, without losing messages', async () => {
  const records = Array.from({ length: 60 }, (_, i) => entry(4001 + i))
  const read = async position => position === 1 ? page([files(1, 4000, 4000)], 4001, 4060) : page(records.filter(e => e.seq >= position), null, 4060)
  const first = await loadArchivePage({ from: 1, source: 'timeline', read })
  assert.equal(first.items.length, 60)
  assert.equal(first.next, 4060)
  const second = await loadArchivePage({ from: first.next, source: 'timeline', read })
  assert.deepEqual([...first.items, ...second.items].filter(e => e.source === 'input').map(e => e.seq), records.map(e => e.seq))
  assert.equal(second.next, null)
})

test('file groups stay separate when a conversation is between them', async () => {
  const result = await loadArchivePage({ from: 1, source: 'timeline', read: async position => position === 1 ? page([files(1, 5, 5), entry(6)], 7) : page([files(7, 11, 5), entry(12, 'ui', 'assistant-done')], null) })
  assert.deepEqual(result.items.map(e => e.seq), [1, 6, 7, 12])
})

test('file-only recordings finish at the end and retain all grouped files', async () => {
  const result = await loadArchivePage({ from: 1, source: 'timeline', read: async position => position === 1 ? page([files(1, 4000, 4000)], 4001) : page([files(4001, 8000, 4000)], null) })
  assert.deepEqual(result.items[0].fileGroup, { endSeq: 8000, count: 8000 })
  assert.equal(result.next, null)
})

test('other filters still skip empty scans and return their first populated page', async () => {
  const calls = []
  const result = await loadArchivePage({ from: 1, source: 'conversation', read: async position => { calls.push(position); return position === 1 ? page([], 4001) : page([entry(4500)], 8001) } })
  assert.deepEqual(calls, [1, 4001])
  assert.equal(result.next, 8001)
})

test('cancelling a pending load discards its result and stops further reads', async () => {
  let active = true, calls = 0
  const result = await loadArchivePage({ from: 1, source: 'timeline', isActive: () => active, read: async () => { calls++; active = false; return page([files(1, 4000, 4000)], 4001) } })
  assert.equal(result, null)
  assert.equal(calls, 1)
})

test('a non-advancing scan fails instead of looping forever', async () => {
  await assert.rejects(loadArchivePage({ from: 1, source: 'timeline', read: async () => page([], 1) }), /Unable to advance/)
})
