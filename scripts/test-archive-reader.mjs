import assert from 'node:assert/strict'
import test from 'node:test'
import { ArchivePayloadCache, archiveCorrectedScroll, archiveRowAt, archiveVisibleRange } from '../app/src/lib/archiveReader.ts'

const page = text => ({ text, totalBytes: text.length, next: null })

test('concurrent readers share a request and cached revisits avoid another read', async () => {
  let calls = 0
  const cache = new ArchivePayloadCache(async () => { calls++; return page('message') })
  const [a, b] = await Promise.all([cache.load(1, 0), cache.load(1, 0)])
  assert.equal(a, b)
  assert.equal(cache.peek(1, 0), a)
  assert.equal(await cache.load(1, 0), a)
  assert.equal(calls, 1)
})

test('cache evicts the least recently used pages to stay within its byte limit', async () => {
  const cache = new ArchivePayloadCache(async seq => page(String(seq).repeat(5)), 20, 100)
  await cache.load(1, 0)
  await cache.load(2, 0)
  await cache.load(1, 0)
  await cache.load(3, 0)
  assert.equal(cache.peek(2, 0), undefined)
  assert.ok(cache.peek(1, 0))
  assert.equal(cache.retainedBytes, 20)
  assert.equal(cache.size, 2)
})

test('cache page count and oversized pages are also bounded', async () => {
  const cache = new ArchivePayloadCache(async seq => page(seq === 4 ? 'x'.repeat(1000) : 'small'), 100, 2)
  for (const seq of [1, 2, 3, 4]) await cache.load(seq, 0)
  assert.equal(cache.peek(1, 0), undefined)
  assert.equal(cache.peek(4, 0), undefined)
  assert.equal(cache.size, 2)
  assert.ok(cache.retainedBytes <= 100)
})

test('failed requests can be retried and offsets cache independently', async () => {
  let calls = 0
  const cache = new ArchivePayloadCache(async (_, offset) => { if (++calls === 1) throw new Error('temporary'); return page(String(offset)) })
  await assert.rejects(cache.load(1, 0), /temporary/)
  assert.equal((await cache.load(1, 0)).text, '0')
  assert.equal((await cache.load(1, 128000)).text, '128000')
  assert.equal(calls, 3)
})

test('variable-height row lookup handles boundaries and empty lists', () => {
  const offsets = [0, 50, 400, 450, 700]
  assert.equal(archiveRowAt(offsets, 49), 0)
  assert.equal(archiveRowAt(offsets, 50), 1)
  assert.equal(archiveRowAt(offsets, 399), 1)
  assert.equal(archiveRowAt(offsets, 999), 3)
  assert.deepEqual(archiveVisibleRange([0], 0, 800), { start: 0, end: 0 })
})

test('a hundred thousand loaded rows still produce a small visible window', () => {
  const offsets = Array.from({ length: 100001 }, (_, i) => i * 50)
  const range = archiveVisibleRange(offsets, 2500000, 800)
  assert.equal(range.start, 49988)
  assert.ok(range.end - range.start < 50)
  const end = archiveVisibleRange(offsets, 4999800, 800)
  assert.equal(end.end, 100000)
})

test('late height measurements never override a newer user scroll position', () => {
  assert.equal(archiveCorrectedScroll(0, 200000, 599), 0)
  assert.equal(archiveCorrectedScroll(1500, 1000, 50), 1500)
  assert.equal(archiveCorrectedScroll(1000, 1000, 50), 1050)
  assert.equal(archiveCorrectedScroll(5, 5, -20), 0)
})
