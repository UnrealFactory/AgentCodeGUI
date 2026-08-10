// PoC — maStore/sessionChats의 채팅별 파일 팬아웃 검증 (전자스텁 하네스, poc-chats-merge 계승)
// 시나리오: 레거시 단일 블롭 → 팬아웃 마이그레이션, 마커 병합(warm/cold), 마커 불변 시
// 파일 무접촉(스킵 최적화), 변경분만 재기록, 프룬, 빈 인덱스에서 레거시 부활 차단.
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(process.cwd())
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'poc-fanout-'))

const assert = (cond, msg) => {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exitCode = 1
  } else console.log('ok:', msg)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(HOME, ...p), 'utf8'))
const mtime = (...p) => fs.statSync(path.join(HOME, ...p)).mtimeMs

async function bundle(entry, tag) {
  const out = path.join(HOME, `bundle-${tag}.mjs`)
  await build({
    entryPoints: [path.join(ROOT, entry)],
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

// ══════════════ maStore ══════════════

// ── 1. 레거시 마이그레이션 — 단일 multi-agent.json → 세션별 파일 ──
fs.writeFileSync(
  path.join(HOME, 'multi-agent.json'),
  JSON.stringify({
    version: 3,
    activeSessionId: 'S1',
    sessions: [
      { id: 'S1', title: 's1', count: 4, panels: [{ snapshot: { messages: [7] } }] },
      { id: 'S2', title: 's2', count: 2, panels: [{ snapshot: { messages: [8] } }] }
    ]
  })
)
const ma1 = await bundle('src/main/maStore.ts', 'ma1')
const blob1 = ma1.readMulti()
assert(blob1?.sessions?.length === 2 && blob1.activeSessionId === 'S1', '마이그레이션: 레거시 블롭 반환')
assert(readJson('multi-agent', 'S2.json').panels[0].snapshot.messages[0] === 8, '마이그레이션: 세션 파일 팬아웃')
assert(readJson('multi-agent', 'index.json').order.join() === 'S1,S2', '마이그레이션: 인덱스 순서')
assert(!fs.existsSync(path.join(HOME, 'multi-agent.json')), '마이그레이션: 레거시 파일 제거')

// ── 2. 마커 저장(warm) — 메타만 덮이고 패널은 디스크 것 유지 ──
ma1.writeMulti({
  version: 3,
  activeSessionId: 'S1',
  sessions: [
    { id: 'S1', title: 's1', count: 4, panels: [{ snapshot: { messages: [7, 9] } }] },
    { id: 'S2', title: 's2-renamed', count: 2, panels: [], unloaded: true }
  ]
})
const s2a = readJson('multi-agent', 'S2.json')
assert(s2a.title === 's2-renamed', '마커(warm): 메타 덮임')
assert(s2a.panels?.[0]?.snapshot?.messages?.[0] === 8, '마커(warm): 패널 보존')
assert(!('unloaded' in s2a), '마커(warm): 플래그 미기록')
assert(readJson('multi-agent', 'S1.json').panels[0].snapshot.messages.length === 2, '활성(S1): 통째로 갱신')

// ── 3. 마커 불변 반복 저장 — 파일 무접촉(스킵 최적화) + 활성만 재기록 ──
const s1T = mtime('multi-agent', 'S1.json')
const s2T = mtime('multi-agent', 'S2.json')
await sleep(30)
ma1.writeMulti({
  version: 3,
  activeSessionId: 'S1',
  sessions: [
    { id: 'S1', title: 's1', count: 4, panels: [{ snapshot: { messages: [7, 9, 11] } }] },
    { id: 'S2', title: 's2-renamed', count: 2, panels: [], unloaded: true }
  ]
})
assert(mtime('multi-agent', 'S2.json') === s2T, '마커 불변: S2 파일 무접촉')
assert(mtime('multi-agent', 'S1.json') > s1T, '활성 변경: S1만 재기록')

// ── 4. 콜드 스타트(새 모듈·캐시 없음·readMulti 없이 바로 저장) — 디스크에서 병합 ──
const ma2 = await bundle('src/main/maStore.ts', 'ma2')
ma2.writeMulti({
  version: 3,
  activeSessionId: 'S1',
  sessions: [
    { id: 'S1', title: 's1', count: 4, panels: [{ snapshot: { messages: [7, 9, 11] } }] },
    { id: 'S2', title: 's2-cold', count: 2, panels: [], unloaded: true }
  ]
})
const s2c = readJson('multi-agent', 'S2.json')
assert(s2c.title === 's2-cold' && s2c.panels?.[0]?.snapshot?.messages?.[0] === 8, '마커(cold): 디스크에서 병합')

// ── 5. 지연 로드 — warm 캐시와 cold 파일 모두 ──
assert(ma2.readMultiSession('S2')?.panels?.[0]?.snapshot?.messages?.[0] === 8, 'readMultiSession(warm)')
const ma3 = await bundle('src/main/maStore.ts', 'ma3')
assert(ma3.readMultiSession('S2')?.title === 's2-cold', 'readMultiSession(cold)')
assert(ma3.readMultiSession('../evil') === null, 'readMultiSession: 경로 탈출 차단')

// ── 6. 재조립 라운드트립 + 손상 파일 스킵 ──
const rt = ma3.readMulti()
assert(rt.sessions.length === 2 && rt.sessions[1].title === 's2-cold', 'readMulti: 파일에서 재조립')
fs.writeFileSync(path.join(HOME, 'multi-agent', 'S2.json'), '{corrupt')
const ma4 = await bundle('src/main/maStore.ts', 'ma4')
const rt2 = ma4.readMulti()
assert(rt2.sessions.length === 1 && rt2.sessions[0].id === 'S1', 'readMulti: 손상 파일 스킵')
fs.writeFileSync(path.join(HOME, 'multi-agent', 'S2.json'), JSON.stringify(s2c)) // 복구

// ── 6.5 light 부팅 페이로드 — 활성만 패널을 싣고, 마커 재저장 사이클에서 스냅샷 보존 ──
const maL = await bundle('src/main/maStore.ts', 'maL')
const lb = maL.readMulti(true)
const lbS1 = lb.sessions.find((s) => s.id === 'S1')
const lbS2 = lb.sessions.find((s) => s.id === 'S2')
assert(lbS1.panels?.[0]?.snapshot?.messages?.length === 3, 'light: 활성(S1) 패널 유지')
assert(lbS2.unloaded === true && lbS2.panels.length === 0, 'light: 비활성(S2) 마커화')
assert(Array.isArray(lbS2.panelStatuses) && lbS2.panelStatuses.length === 1, 'light: 배지 요약 동봉')
// 렌더러가 부팅 마커를 그대로 되저장하는 사이클 — 디스크 패널이 살아남아야 한다
maL.writeMulti({ version: 3, activeSessionId: 'S1', sessions: [lbS1, { ...lbS2 }] })
const s2r = readJson('multi-agent', 'S2.json')
assert(s2r.panels?.[0]?.snapshot?.messages?.[0] === 8, 'light 재저장: 패널 보존')
assert(!('panelStatuses' in s2r) && !('unloaded' in s2r), 'light 재저장: 마커 필드 미기록')

// ── 7. 프룬 — 목록에서 빠진 세션의 파일 제거 ──
ma4.readMulti()
ma4.writeMulti({ version: 3, activeSessionId: 'S1', sessions: [{ id: 'S1', title: 's1', count: 4, panels: [] }] })
assert(!fs.existsSync(path.join(HOME, 'multi-agent', 'S2.json')), '프룬: 삭제 세션 파일 제거')
assert(readJson('multi-agent', 'index.json').order.join() === 'S1', '프룬: 인덱스에서도 제거')

// ── 8. 전부 삭제 후 빈 인덱스 — 레거시 부활 차단 ──
ma4.writeMulti({ version: 3, activeSessionId: '', sessions: [] })
fs.writeFileSync(path.join(HOME, 'multi-agent.json'), JSON.stringify({ sessions: [{ id: 'ZOMBIE', panels: [] }] }))
const ma5 = await bundle('src/main/maStore.ts', 'ma5')
assert(ma5.readMulti() === null, '빈 인덱스: null 반환 + 레거시 유령 부활 차단')
fs.unlinkSync(path.join(HOME, 'multi-agent.json'))

// ══════════════ sessionChats ══════════════

// ── 9. 레거시 마이그레이션 ──
fs.writeFileSync(
  path.join(HOME, 'session-chats.json'),
  JSON.stringify({
    version: 1,
    chats: [
      { id: 'C1', title: 'c1', status: 'done', cwd: '/x', snapshot: { messages: [1] } },
      { id: 'C2', title: 'c2', status: 'idle', cwd: '/y', snapshot: { messages: [2, 3] } }
    ]
  })
)
const sc1 = await bundle('src/main/sessionChats.ts', 'sc1')
const list1 = sc1.readSessionChats()
assert(list1.length === 2 && list1[1].snapshot.messages.length === 2, '마이그레이션: 레코드 반환')
assert(readJson('session-chats', 'C1.json').title === 'c1', '마이그레이션: 채팅 파일 팬아웃')
assert(!fs.existsSync(path.join(HOME, 'session-chats.json')), '마이그레이션: 레거시 파일 제거')

// ── 10. 한 레코드만 갱신 — 다른 파일 무접촉 ──
const c1T = mtime('session-chats', 'C1.json')
await sleep(30)
sc1.writeSessionChats([
  { id: 'C1', title: 'c1', status: 'done', cwd: '/x', snapshot: { messages: [1] } },
  { id: 'C2', title: 'c2-edited', status: 'idle', cwd: '/y', snapshot: { messages: [2, 3, 4] } }
])
assert(mtime('session-chats', 'C1.json') === c1T, '부분 갱신: C1 무접촉')
assert(readJson('session-chats', 'C2.json').snapshot.messages.length === 3, '부분 갱신: C2 재기록')

// ── 11. 빈 대화·스냅샷 없음 필터 + 프룬 ──
sc1.writeSessionChats([
  { id: 'C1', title: 'c1', status: 'done', cwd: '/x', snapshot: { messages: [1] } },
  { id: 'C2', title: 'c2-edited', status: 'idle', cwd: '/y', snapshot: { messages: [2, 3, 4] }, empty: true },
  { id: 'C3', title: 'fresh', status: 'idle', cwd: '', snapshot: null }
])
assert(!fs.existsSync(path.join(HOME, 'session-chats', 'C2.json')), '빈 대화: 파일 프룬')
assert(!fs.existsSync(path.join(HOME, 'session-chats', 'C3.json')), '스냅샷 없음: 미기록')
assert(readJson('session-chats', 'index.json').order.join() === 'C1', '인덱스: 살아남은 것만')

// ── 12. 콜드 재기동 — 순서대로 복원 + 빈 인덱스 레거시 차단 ──
const sc2 = await bundle('src/main/sessionChats.ts', 'sc2')
const list2 = sc2.readSessionChats()
assert(list2.length === 1 && list2[0].id === 'C1', '콜드 재기동: 파일에서 복원')
sc2.writeSessionChats([])
fs.writeFileSync(path.join(HOME, 'session-chats.json'), JSON.stringify({ chats: [{ id: 'Z', snapshot: {} }] }))
const sc3 = await bundle('src/main/sessionChats.ts', 'sc3')
assert(sc3.readSessionChats().length === 0, '빈 인덱스: 레거시 유령 부활 차단')

fs.rmSync(HOME, { recursive: true, force: true })
console.log(process.exitCode ? '\n결과: 실패 있음' : '\n결과: 전부 통과')
