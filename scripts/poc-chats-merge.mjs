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

// ── 5. light 부팅 페이로드 — 활성만 스냅샷, 마커 재저장 사이클에서 스냅샷 보존 ──
m2.writeChats({
  version: 1,
  activeChatId: 'A',
  chats: [
    { id: 'A', title: 'a2', snapshot: { messages: [1] } },
    { id: 'B', title: 'b3', snapshot: { messages: [3, 4] } },
    { id: 'C', title: 'fresh', snapshot: { messages: [] } } // 빈 스냅샷 — light에서도 그대로
  ]
})
const m4 = await bundle('four')
const light = m4.readChats(true)
const lA = light.chats.find((c) => c.id === 'A')
const lB = light.chats.find((c) => c.id === 'B')
const lC = light.chats.find((c) => c.id === 'C')
assert(lA.snapshot?.messages?.length === 1, 'light: 활성(A) 스냅샷 유지')
assert(lB.unloaded === true && lB.snapshot == null, 'light: 비활성(B) 마커화')
assert(lC.snapshot?.messages?.length === 0 && !lC.unloaded, 'light: 빈 스냅샷(C)은 그대로')
// 렌더러가 부팅 마커를 그대로 되저장하는 사이클 — 디스크 스냅샷이 살아남아야 한다
m4.writeChats({ version: 1, activeChatId: 'A', chats: [lA, { ...lB }, lC] })
const bAfter = readFile('B')
assert(bAfter.snapshot?.messages?.[0] === 3, 'light 재저장: 스냅샷 보존')
assert(!('unloaded' in bAfter), 'light 재저장: 마커 필드 미기록')

// maStore·sessionChats(채팅별 파일 팬아웃 포맷)는 poc-store-fanout.mjs가 검증한다 —
// 둘 다 2026-08 팬아웃 이관으로 단일 블롭 포맷을 떠나 이 하네스의 대상이 아니게 됐다.

fs.rmSync(HOME, { recursive: true, force: true })
console.log(process.exitCode ? '\n결과: 실패 있음' : '\n결과: 전부 통과')
