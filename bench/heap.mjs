// 힙 스냅샷 — "패널 4개가 무엇으로 메모리를 잡는가"를 **추측 없이** 본다.
//
//   node bench/heap.mjs tauri|electron [--panels=4]
//
// CDP HeapProfiler.takeHeapSnapshot을 받아 v8 스냅샷의 노드 배열을 직접 집계한다.
//  - 생성자(=node name)별 **shallow self_size 합**: 무엇이 힙을 채우는가.
//  - node type별 합(string/object/array/code/closure…): 코드인가 데이터인가.
//  - Memory.getDOMCounters + 렌더러 DOM 실측: DOM 노드가 몇 개이고 패널마다 몇 개인가.
//
// retained size(지배자 트리)는 계산하지 않는다 — 그건 "누가 붙들고 있나"를 보는 도구고,
// 지금 필요한 답("무엇이 얼마나 차지하나")은 shallow 합으로 충분하며 편향이 없다.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { electronProfile, tauriProfile, connectMainPage, procTreeMem, killTree, sleep, REPO } from './lib.mjs'
import { makeMultiFixture } from './fixture.mjs'

const kind = process.argv[2] ?? 'tauri'
const panels = Number((process.argv.find((a) => a.startsWith('--panels=')) ?? '--panels=4').split('=')[1])
const profile = kind === 'tauri' ? tauriProfile({ port: 9361 }) : electronProfile({ port: 9362 })
const HOME = path.join(REPO, '.bench-home-heap' + (kind === 'tauri' ? '-tauri' : ''))
profile.env.CCG_HOME = HOME
const OUT = path.join(REPO, 'bench', 'results', 'heap-panels.json')

fs.rmSync(HOME, { recursive: true, force: true })
makeMultiFixture(HOME, kind === 'tauri' ? '3.0.0-beta.1' : '2.6.2', { panels })

const child = spawn(profile.cmd, profile.args, {
  env: { ...process.env, ...profile.env }, cwd: profile.cwd, stdio: 'ignore'
})
const cdp = await connectMainPage(profile.port, { timeoutMs: 45000 })
for (;;) {
  if (await cdp.eval(profile.mountExpr).catch(() => false)) break
  await sleep(100)
}
await sleep(8000)

const gridPanels = await cdp.eval(`document.querySelectorAll('.ma-p-thread').length`)
console.log('panels rendered:', gridPanels)

// ── DOM 실측 (윈도잉이 살아 있으면 패널당 DOM이 항목 수에 비례하지 않는다) ──
const dom = await cdp.eval(`(() => {
  const q = (s) => document.querySelectorAll(s).length
  const panels = [...document.querySelectorAll('.ma-panel')]
  return {
    allNodes: document.getElementsByTagName('*').length,
    panels: panels.length,
    perPanelNodes: panels.map((p) => p.getElementsByTagName('*').length),
    msgRows: q('.ma-p-thread .msg'),
    toolGroups: q('.tool-group, .toolgroup, .tg'),
    codeBlocks: q('pre code'),
    imgs: q('img')
  }
})()`).catch((e) => ({ error: String(e) }))
console.log('dom:', JSON.stringify(dom))

const domCounters = await cdp.send('Memory.getDOMCounters').catch(() => null)
const jsHeap = await cdp.eval(`(() => { const m = performance.memory
  return m ? { usedMB: Math.round(m.usedJSHeapSize/1048576*10)/10, totalMB: Math.round(m.totalJSHeapSize/1048576*10)/10 } : null })()`).catch(() => null)

// ── 힙 스냅샷 스트리밍 수신 ────────────────────────────────────────────────────
const snapFile = path.join(os.tmpdir(), `ccg-heap-${kind}-${Date.now()}.heapsnapshot`)
const ws = fs.createWriteStream(snapFile)
let chunks = 0
cdp.listeners.push((msg) => {
  if (msg.method === 'HeapProfiler.addHeapSnapshotChunk') { ws.write(msg.params.chunk); chunks++ }
})
await cdp.send('HeapProfiler.enable')
console.log('taking heap snapshot …')
await cdp.send('HeapProfiler.collectGarbage').catch(() => {})
await sleep(1500)
await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, treatGlobalObjectsAsRoots: true })
await new Promise((r) => ws.end(r))
console.log('snapshot chunks:', chunks, '·', Math.round(fs.statSync(snapFile).size / 1048576), 'MB')

const memAtSnap = procTreeMem(child.pid)
cdp.close()
await sleep(400)
killTree(child.pid)

// ── 집계 ──────────────────────────────────────────────────────────────────────
const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'))
const meta = snap.snapshot.meta
const nf = meta.node_fields
const iType = nf.indexOf('type'), iName = nf.indexOf('name'), iSize = nf.indexOf('self_size')
const typeNames = meta.node_types[0]
const nodes = snap.nodes, strings = snap.strings, stride = nf.length

const byName = new Map()
const byType = new Map()
let total = 0
for (let i = 0; i < nodes.length; i += stride) {
  const size = nodes[i + iSize]
  const t = typeNames[nodes[i + iType]]
  const n = strings[nodes[i + iName]] ?? ''
  total += size
  byType.set(t, (byType.get(t) ?? 0) + size)
  // 문자열·코드는 개별 내용이 아니라 종류로만 묶는다(이름이 곧 내용이라 표가 터진다)
  const key = t === 'string' || t === 'concatenated string' || t === 'sliced string' ? `(string)` : (n || `(${t})`)
  const cur = byName.get(key) ?? { bytes: 0, count: 0 }
  cur.bytes += size; cur.count++
  byName.set(key, cur)
}
const mb = (b) => Math.round((b / 1048576) * 100) / 100
const top = [...byName.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 40)
  .map(([name, v]) => ({ name, mb: mb(v.bytes), count: v.count }))
const types = [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([t, b]) => ({ type: t, mb: mb(b) }))

const row = {
  app: profile.name, panels, gridPanels, at: new Date().toISOString(),
  jsHeap, domCounters: domCounters ?? null, dom,
  heapTotalMB: mb(total), nodeCount: nodes.length / stride,
  byType: types, topByConstructor: top,
  procTree: { wsMB: memAtSnap.totalWsMB, privMB: memAtSnap.totalPrivMB, procs: memAtSnap.procs?.length }
}
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {}
prev[profile.name] = row
fs.writeFileSync(OUT, JSON.stringify(prev, null, 2))
fs.rmSync(snapFile, { force: true })
console.log('\nheap total:', row.heapTotalMB, 'MB · nodes:', row.nodeCount)
console.table(top.slice(0, 20))
console.log('saved:', OUT)
