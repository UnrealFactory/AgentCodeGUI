// PoC — chats.ts의 unloaded 마커 병합 검증 (전자스텁 하네스)
// 시나리오: 전체 저장 → 마커 저장(메타만) → 파일의 스냅샷이 살아있고 메타만 덮였는가,
// 콜드 스타트(캐시 없음)에서도 디스크에서 병합하는가, 목록에서 빠지면 프룬되는가.
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(process.cwd())
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'poc-chats-'))
const OUT = path.join(HOME, 'chats-bundle.mjs')

async function bundle(tag) {
  const out = OUT.replace('.mjs', `-${tag}.mjs`)
  await build({
    entryPoints: [path.join(ROOT, 'src/main/chats.ts')],
    bundle: true,
    format: 'esm',
    outfile: out,
    platform: 'node',
    plugins: [
      {
        name: 'stub-versions',
        setup(b) {
          b.onResolve({ filter: /engine\/versions$/ }, () => ({ path: 'versions-stub', namespace: 'stub' }))
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            contents: `export const APP_HOME = ${JSON.stringify(HOME)}`,
            loader: 'ts'
          }))
        }
      }
    ]
  })
  return import(pathToFileURL(out).href + `?v=${tag}`)
}

const assert = (cond, msg) => {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exitCode = 1
  } else console.log('ok:', msg)
}

const readFile = (id) => JSON.parse(fs.readFileSync(path.join(HOME, 'chats', `${id}.json`), 'utf8'))

// ── 1. 전체 저장 (warm 프로세스) ──
const m1 = await bundle('one')
m1.writeChats({
  version: 1,
  activeChatId: 'A',
  chats: [
    { id: 'A', title: 'a', snapshot: { messages: [1, 2] } },
    { id: 'B', title: 'b', snapshot: { messages: [3] }, draft: 'wip' }
  ]
})
assert(readFile('B').snapshot.messages.length === 1, '전체 저장: B 스냅샷 기록')

// ── 2. 마커 저장 — 메타만 갱신, 스냅샷은 파일 것 유지 ──
m1.writeChats({
  version: 1,
  activeChatId: 'A',
  chats: [
    { id: 'A', title: 'a2', snapshot: { messages: [1, 2, 9] } },
    { id: 'B', title: 'b-renamed', unloaded: true }
  ]
})
const b2 = readFile('B')
assert(b2.title === 'b-renamed', '마커 저장: 메타(제목) 덮임')
assert(Array.isArray(b2.snapshot?.messages) && b2.snapshot.messages[0] === 3, '마커 저장: 스냅샷 보존')
assert(!('unloaded' in b2), '마커 저장: unloaded 플래그 미기록')
assert(readFile('A').snapshot.messages.length === 3, '마커 저장: 활성(A)은 통째로 갱신')

// ── 3. 콜드 스타트(새 모듈, 캐시 없음, readChats 없이 바로 저장) ──
const m2 = await bundle('two')
m2.writeChats({
  version: 1,
  activeChatId: 'A',
  chats: [
    { id: 'A', title: 'a2', snapshot: { messages: [1, 2, 9] } },
    { id: 'B', title: 'b-cold', unloaded: true }
  ]
})
const b3 = readFile('B')
assert(b3.title === 'b-cold' && b3.snapshot.messages[0] === 3, '콜드 스타트: 디스크에서 병합')

// ── 4. readChat 되읽기 + 목록 제외 시 프룬 ──
const loaded = m2.readChat('B')
assert(loaded && loaded.snapshot.messages[0] === 3, 'readChat: 지연 로드 반환')
m2.writeChats({ version: 1, activeChatId: 'A', chats: [{ id: 'A', title: 'a2', snapshot: { messages: [] } }] })
assert(!fs.existsSync(path.join(HOME, 'chats', 'B.json')), '삭제: 목록에서 빠지면 프룬')

// ── 5. maStore도 같은 규약 검증 ──
const m3 = await bundle('ma').then(() => null).catch(() => null) // (chats 전용 하네스 — maStore는 아래 별도 번들)
const outMa = path.join(HOME, 'ma-bundle.mjs')
await build({
  entryPoints: [path.join(ROOT, 'src/main/maStore.ts')],
  bundle: true,
  format: 'esm',
  outfile: outMa,
  platform: 'node',
  plugins: [
    {
      name: 'stub-versions',
      setup(b) {
        b.onResolve({ filter: /engine\/versions$/ }, () => ({ path: 'versions-stub', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: `export const APP_HOME = ${JSON.stringify(HOME)}`,
          loader: 'ts'
        }))
      }
    }
  ]
})
const ma = await import(pathToFileURL(outMa).href)
ma.writeMulti({
  version: 1,
  activeSessionId: 'S1',
  sessions: [
    { id: 'S1', title: 's1', count: 4, panels: [{ snapshot: { messages: [7] } }] },
    { id: 'S2', title: 's2', count: 2, panels: [{ snapshot: { messages: [8] } }] }
  ]
})
ma.writeMulti({
  version: 1,
  activeSessionId: 'S1',
  sessions: [
    { id: 'S1', title: 's1', count: 4, panels: [{ snapshot: { messages: [7, 9] } }] },
    { id: 'S2', title: 's2-renamed', count: 2, panels: [], unloaded: true }
  ]
})
const maFile = JSON.parse(fs.readFileSync(path.join(HOME, 'multi-agent.json'), 'utf8'))
const s2 = maFile.sessions.find((s) => s.id === 'S2')
assert(s2.title === 's2-renamed', 'maStore 마커: 메타 덮임')
assert(s2.panels?.[0]?.snapshot?.messages?.[0] === 8, 'maStore 마커: 패널 보존')
assert(!('unloaded' in s2), 'maStore 마커: 플래그 미기록')
const s2loaded = ma.readMultiSession('S2')
assert(s2loaded && s2loaded.panels[0].snapshot.messages[0] === 8, 'maStore: 지연 로드 반환')

// 콜드 스타트 maStore
const outMa2 = outMa.replace('.mjs', '-2.mjs')
fs.copyFileSync(outMa, outMa2)
const ma2 = await import(pathToFileURL(outMa2).href)
ma2.writeMulti({
  version: 1,
  activeSessionId: 'S1',
  sessions: [
    { id: 'S1', title: 's1', count: 4, panels: [{ snapshot: { messages: [7, 9] } }] },
    { id: 'S2', title: 's2-cold', count: 2, panels: [], unloaded: true }
  ]
})
const maFile2 = JSON.parse(fs.readFileSync(path.join(HOME, 'multi-agent.json'), 'utf8'))
const s2c = maFile2.sessions.find((s) => s.id === 'S2')
assert(s2c.title === 's2-cold' && s2c.panels?.[0]?.snapshot?.messages?.[0] === 8, 'maStore 콜드: 디스크에서 병합')

fs.rmSync(HOME, { recursive: true, force: true })
console.log(process.exitCode ? '\n결과: 실패 있음' : '\n결과: 전부 통과')
