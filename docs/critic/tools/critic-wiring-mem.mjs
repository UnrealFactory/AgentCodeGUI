#!/usr/bin/env node
/* ============================================================================
 * critic-wiring-mem — **유휴 +12MB의 출처 분해**(빌더 리포트 §5.3 / §7-5).
 *
 * 빌더의 가설: "팬아웃의 `cache: HashMap<id, 파일 원문>`이 후보다."
 * 그 가설은 **Rust 프로세스(브라우저)** 쪽에 델타가 있어야 성립한다. 그래서
 * 총합(procTreeMem 합계)만 보지 않고 **역할별로 쪼갠다**:
 *
 *   agentcodegui.exe(브라우저=Rust)  ← 팬아웃 캐시·스토어·엔진 글루가 사는 곳
 *   msedgewebview2.exe --type=renderer ← 렌더러 JS 힙/DOM
 *   그 밖(gpu·utility·crashpad)
 *
 * 그리고 같은 시점에
 *   · 렌더러 JS 힙(Runtime.getHeapUsage)          — 페이로드가 커진 건가
 *   · DOM 노드 수(Memory.getDOMCounters)          — 그리는 게 늘었나
 *   · chats:get / board:get / ma:get 페이로드 바이트 — 무엇이 얼마나 커졌나
 *   · 디스크의 스토어 바이트(캐시의 **상한**)      — 캐시가 그 크기가 될 수 있나
 * 를 함께 뜬다. 이 다섯이면 원인을 추측 없이 가른다.
 *
 *   node docs/critic/tools/critic-wiring-mem.mjs [--repeats=3]
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { connectMainPage, procTreeMem, killTree, median, sleep, REPO, tauriProfile, resolveTauriExe } from '../../../bench/lib.mjs'
import { makeMultiFixture } from '../../../bench/fixture.mjs'

const repeats = Number((process.argv.find((a) => a.startsWith('--repeats=')) ?? '--repeats=3').split('=')[1])
const OUT = path.join(REPO, 'docs', 'critic', 'wiring-r1-mem.json')
const HOME = path.join(REPO, '.critic-home-mem')
const PORT = 9381
// M12 R2 — mainBinaryName 변경으로 exe 이름이 둘이다(구·신 모두 탐색·최신 mtime 우선)
const EXE = resolveTauriExe((process.argv.find((a) => a.startsWith('--exe=')) ?? '').split('=').slice(1).join('='))

function dirBytes(p) {
  let n = 0
  try {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const q = path.join(p, e.name)
      n += e.isDirectory() ? dirBytes(q) : fs.statSync(q).size
    }
  } catch {}
  return n
}

async function once(arm, seq) {
  fs.rmSync(HOME, { recursive: true, force: true })
  makeMultiFixture(HOME, '3.0.0-beta.1', { panels: 4 })
  const env = { ...process.env, CCG_HOME: HOME, CCG_CDP_PORT: String(PORT) }
  if (arm.startsWith('off')) env.CCG_UNIFIED_STORE = '0'
  else delete env.CCG_UNIFIED_STORE
  // `on2` = **이미 마이그레이션된 홈**에서의 켬. 첫 부팅의 마이그레이션(레거시 3스토어를
  // 통째로 파싱해 chats-v3로 쓰는 1회 작업)이 남기는 몫과, 상주하는 몫(팬아웃 캐시 등)을
  // 가른다. 두 팔의 차이가 0에 가까우면 델타는 **상주**고, 크면 **1회 마이그레이션**이다.
  // 접미 2 = **웜 팔**: 같은 홈으로 한 번 띄웠다 끄고(마이그레이션 + WebView2 프로필
  //   코드캐시가 이미 선다) 두 번째 부팅을 잰다. 콜드 프로필의 큰 분산을 걷어낸다.
  if (arm.endsWith('2')) {
    const warm = spawn(EXE, [], { env, cwd: REPO, stdio: 'ignore' })
    const wcdp = await connectMainPage(PORT, { timeoutMs: 60_000 })
    for (;;) {
      if (await wcdp.eval(`!!document.getElementById('root') && document.getElementById('root').children.length > 0`).catch(() => false)) break
      await sleep(100)
    }
    await sleep(6000) // chats:get → ensure_migrated
    wcdp.close()
    killTree(warm.pid)
    await sleep(2000)
  }
  const child = spawn(EXE, [], { env, cwd: REPO, stdio: 'ignore' })
  const cdp = await connectMainPage(PORT, { timeoutMs: 60_000 })
  // 미배선 채널 인벤토리 — 심(shim)이 채널당 1회 내는 `[shim] … 안전값 반환` 경고를 줍는다.
  // "얼려 둔 렌더러가 **실제로 부르는데** 아직 없는 채널"의 전수 목록이다.
  const shimWarn = new Set()
  cdp.listeners.push((m) => {
    if (m.method !== 'Runtime.consoleAPICalled') return
    for (const a of m.params?.args ?? []) {
      const s = typeof a.value === 'string' ? a.value : ''
      const hit = s.match(/^\[shim\] ([^\s]+) —/)
      if (hit) shimWarn.add(hit[1])
    }
  })
  await cdp.send('Runtime.enable', {}).catch(() => {})
  for (;;) {
    if (await cdp.eval(`!!document.getElementById('root') && document.getElementById('root').children.length > 0`).catch(() => false)) break
    await sleep(100)
  }
  // multi.mjs의 idleGrid와 **같은 타이밍**(4s + 20s)에서 잰다
  await sleep(4000)
  const panels = await cdp.eval(`document.querySelectorAll('.ma-p-thread').length`)
  await sleep(20_000)

  const mem = procTreeMem(child.pid, { role: true })
  const bucket = { browser: { ws: 0, priv: 0, n: 0 }, renderer: { ws: 0, priv: 0, n: 0 }, other: { ws: 0, priv: 0, n: 0 } }
  for (const p of mem.procs ?? []) {
    const k = /agentcodegui/i.test(p.name) ? 'browser' : p.role === 'renderer' ? 'renderer' : 'other'
    bucket[k].ws += p.wsMB
    bucket[k].priv += p.privMB
    bucket[k].n += 1
  }
  for (const k of Object.keys(bucket)) {
    bucket[k].ws = Math.round(bucket[k].ws * 10) / 10
    bucket[k].priv = Math.round(bucket[k].priv * 10) / 10
  }

  let heap = null
  try {
    heap = await cdp.send('Runtime.getHeapUsage', {})
  } catch {}
  let dom = null
  try {
    await cdp.send('Memory.enable', {}).catch(() => {})
    dom = await cdp.send('Memory.getDOMCounters', {})
  } catch {}

  const payload = await cdp
    .eval(
      `(async () => JSON.stringify({
        chatsGetLight: JSON.stringify(await window.api.getChats()).length,
        boardGet: JSON.stringify(await (window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: 'board:get', payload: [{}] }))).length,
        maGet: JSON.stringify(await (window.api.multi?.getState?.() ?? null)).length,
        sessionWins: JSON.stringify(await window.api.sessionWindows.list()).length,
        chatIds: ((await window.api.getChats())?.chats ?? []).map((c) => c.id),
        domNodes: document.querySelectorAll('*').length
      }))()`,
      { awaitPromise: true }
    )
    .then((s) => JSON.parse(s))
    .catch((e) => ({ error: String(e) }))

  const disk = {
    chatsV3: dirBytes(path.join(HOME, 'chats-v3')),
    boards: dirBytes(path.join(HOME, 'boards')),
    chatsLegacy: dirBytes(path.join(HOME, 'chats')),
    maLegacy: dirBytes(path.join(HOME, 'multi-agent')),
    sessionChats: dirBytes(path.join(HOME, 'session-chats'))
  }

  cdp.close()
  await sleep(500)
  killTree(child.pid)
  await sleep(1500)
  return {
    arm,
    seq,
    panels,
    totalWsMB: mem.totalWsMB,
    totalPrivMB: mem.totalPrivMB,
    procs: mem.procs?.length,
    bucket,
    heapUsedMB: heap ? Math.round((heap.usedSize / 1048576) * 10) / 10 : null,
    heapTotalMB: heap ? Math.round((heap.totalSize / 1048576) * 10) / 10 : null,
    domNodes: dom?.documents != null ? { documents: dom.documents, nodes: dom.nodes, listeners: dom.jsEventListeners } : null,
    payload,
    shimUnimplemented: [...shimWarn].sort(),
    diskKB: Object.fromEntries(Object.entries(disk).map(([k, v]) => [k, Math.round(v / 1024)])),
    procDetail: (mem.procs ?? []).map((p) => ({ name: p.name, role: p.role, sub: p.sub, wsMB: p.wsMB, privMB: p.privMB }))
  }
}

const ARMS = (process.argv.find((a) => a.startsWith('--arms=')) ?? '--arms=on,off').split('=')[1].split(',')
const runs = []
// 팔을 **번갈아** 돈다 — 머신 드리프트가 한쪽 팔에만 얹히지 않게.
for (let i = 0; i < repeats; i++) {
  for (const arm of ARMS) {
    const r = await once(arm, i + 1)
    runs.push(r)
    console.log(
      `[${arm}#${i + 1}] total ${r.totalWsMB}/${r.totalPrivMB} · browser ${r.bucket.browser.ws}/${r.bucket.browser.priv} · renderer ${r.bucket.renderer.ws}/${r.bucket.renderer.priv} · heap ${r.heapUsedMB} · chats ${r.payload?.chatIds?.length} · chatsGet ${r.payload?.chatsGetLight}B`
    )
  }
}

const by = (arm, f) => median(runs.filter((r) => r.arm === arm).map(f))
const cmp = (label, f) => ({ label, on: by('on', f), off: by('off', f), delta: Math.round((by('on', f) - by('off', f)) * 10) / 10 })
const table = [
  cmp('total WS MB', (r) => r.totalWsMB),
  cmp('total Priv MB', (r) => r.totalPrivMB),
  cmp('browser(Rust) WS MB', (r) => r.bucket.browser.ws),
  cmp('browser(Rust) Priv MB', (r) => r.bucket.browser.priv),
  cmp('renderer WS MB', (r) => r.bucket.renderer.ws),
  cmp('renderer Priv MB', (r) => r.bucket.renderer.priv),
  cmp('other WS MB', (r) => r.bucket.other.ws),
  cmp('JS heap used MB', (r) => r.heapUsedMB),
  cmp('DOM nodes', (r) => r.domNodes?.nodes ?? null),
  cmp('chats:get bytes', (r) => r.payload?.chatsGetLight ?? null),
  cmp('ma:get bytes', (r) => r.payload?.maGet ?? null),
  cmp('board:get bytes', (r) => r.payload?.boardGet ?? null),
  cmp('chat count', (r) => r.payload?.chatIds?.length ?? null),
  cmp('disk chats-v3 KB', (r) => r.diskKB?.chatsV3 ?? null),
  cmp('disk boards KB', (r) => r.diskKB?.boards ?? null)
]
fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), repeats, table, runs }, null, 2))
console.log('\n' + table.map((t) => `${t.label.padEnd(24)} on=${t.on}  off=${t.off}  Δ=${t.delta}`).join('\n'))
console.log('\nsaved:', path.relative(REPO, OUT))
fs.rmSync(HOME, { recursive: true, force: true })
