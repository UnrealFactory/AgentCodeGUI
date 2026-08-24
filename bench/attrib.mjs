#!/usr/bin/env node
/* ============================================================================
 * attrib — **유휴 메모리 귀속**(★R4). 서브시스템 스위치 하나씩 끄고 인터리브 A/B.
 *
 * ## 왜 새로 파나
 *
 * R3의 주 게이트는 유휴 Priv 254.7MB로 게이트(≤253)를 넘었는데 **원인 미상**이었다
 * (§R3.7): 같은 바이너리에 네 라운드의 변경이 함께 들어 있었고, R2가 자기 델타를
 * 주장할 때 쓴 방법(같은 바이너리 인터리브 A/B)은 `CCG_UNIFIED_STORE`라는 **팔을 가를
 * 스위치**가 있어서 성립한 것이다. 그 스위치를 서브시스템마다 판 것이
 * `src-tauri/src/flags.rs`이고, 이 하네스가 그것을 쓴다.
 *
 * 방법은 R11 크리틱의 `critic-wiring-mem.mjs`를 그대로 계승한다:
 *  · 팔을 **쌍 단위로 번갈아** 돈다(머신 드리프트가 한쪽에만 얹히지 않게).
 *  · 총합만 보지 않고 **역할별로 쪼갠다**(browser=Rust / renderer / 그 밖).
 *    같은 총합이라도 어디서 났는지가 다르면 원인이 다르다.
 *  · 판정은 **쌍별 Δ의 중앙값**이다. 점추정은 이 무대에서 ±5MB를 말할 수 없다(R2.10).
 *
 * 픽스처·타이밍은 **주 게이트와 같다**(`makeMultiFixture` 4패널 · 마운트 후 4s + 20s) —
 * 다른 픽스처로 재면 절대값을 주 게이트와 섞어 읽는 사고가 난다(R2.10의 경고).
 *
 *   node bench/attrib.mjs                       # base vs noglue, 3쌍
 *   node bench/attrib.mjs --arm=nofs --pairs=5
 *   node bench/attrib.mjs --arm=noglue,nohub,nostatus,nofs,notick --pairs=3
 *
 * 안전: 죽이는 것은 이 스크립트가 spawn한 PID 트리(`killTree`)뿐. 홈은 `CCG_HOME` 격리.
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { connectMainPage, procTreeMem, killTree, median, sleep, REPO, binInfo, envInfo, resolveTauriExe } from './lib.mjs'
import { makeMultiFixture } from './fixture.mjs'

const argv = process.argv.slice(2)
const val = (k, d) => (argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=')
const PAIRS = Number(val('pairs', 3))
const ARMS = val('arm', 'noglue').split(',').filter(Boolean)
const TAG = val('tag', `${process.pid}`)
// M12 R2 — mainBinaryName 변경으로 이름이 둘이다(구·신 모두 탐색, 최신 mtime 우선)
const EXE = resolveTauriExe(val('exe', ''))
const HOME = path.join(REPO, `.bench-home-attrib-${TAG}`)
const PORT = Number(val('port', 9391))

/** 팔 이름 → 그 팔이 세우는 env. `base`는 아무것도 안 준다(= 제품 기본값). */
const ENV_OF = {
  base: {},
  noglue: { CCG_NO_ENGINE_GLUE: '1' },
  nohub: { CCG_NO_ENGINE_HUB: '1' },
  nostatus: { CCG_NO_STATUS_BOOT: '1' },
  nofs: { CCG_NO_FS: '1' },
  notick: { CCG_NO_STATUS_TICK: '1' },
  // 이 팔만 방향이 반대다 — **R3 동작으로 되돌리는** 스위치라, 여기서 나오는 Δ는
  // "그 서브시스템의 몫"이 아니라 **R4 수정이 되돌려 받은 몫**이다(부호 주의).
  deepboot: { CCG_DEEP_BOOT_SCAN: '1' },
  // 이 팔도 방향이 반대다 — **아직 기본이 아닌** 실험을 켜는 스위치다.
  lightpanels: { CCG_LIGHT_PANEL_CHATS: '1' },
  legacystore: { CCG_UNIFIED_STORE: '0' }
}

const rmrf = (p) => {
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
      return
    } catch {
      /* WebView2가 핸들을 놓는 데 한 박자 — 재시도 */
    }
  }
}

async function once(arm) {
  const extra = ENV_OF[arm]
  if (!extra) throw new Error(`모르는 팔: ${arm} (${Object.keys(ENV_OF).join(', ')})`)
  rmrf(HOME)
  makeMultiFixture(HOME, '3.0.0-beta.1', { panels: 4 })
  const env = { ...process.env, CCG_HOME: HOME, CCG_CDP_PORT: String(PORT), ...extra }
  // 부모 셸이 남긴 스위치가 섞이지 않게 — 이 팔이 안 세운 것은 **지운다**.
  for (const k of Object.keys(ENV_OF).flatMap((a) => Object.keys(ENV_OF[a]))) {
    if (!(k in extra)) delete env[k]
  }
  const child = spawn(EXE, [], { env, cwd: REPO, stdio: 'ignore' })
  const cdp = await connectMainPage(PORT, { timeoutMs: 60_000 })
  for (;;) {
    const up = await cdp
      .eval(`!!document.getElementById('root') && document.getElementById('root').children.length > 0`)
      .catch(() => false)
    if (up) break
    await sleep(100)
  }
  // 주 게이트(multi.mjs)의 idleGrid와 **같은 타이밍**.
  await sleep(4000)
  const panels = await cdp.eval(`document.querySelectorAll('.ma-p-thread').length`).catch(() => 0)
  await sleep(20_000)

  const mem = procTreeMem(child.pid, { role: true })
  const bucket = { browser: { ws: 0, priv: 0, n: 0 }, renderer: { ws: 0, priv: 0, n: 0 }, other: { ws: 0, priv: 0, n: 0 } }
  for (const p of mem.procs ?? []) {
    // ★ 이름이 아니라 **루트 pid**로 가른다. `critic-wiring-mem.mjs`는 `/agentcodegui/i`로
    //   갈랐는데, `--exe=`로 스냅샷(`ccg-r4-snap.exe`)을 재면 그 정규식이 아무것도 안 잡아
    //   **Rust 몫이 통째로 0**으로 나온다(1차 주행에서 실제로 밟았다 — 표가 전부 rust 0/0).
    const k = p.pid === child.pid ? 'browser' : p.role === 'renderer' ? 'renderer' : 'other'
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
  } catch {
    /* 렌더러가 응답을 못 하면 힙은 없는 값이다 */
  }
  // **이 주행이 정말 그 팔이었나** — 셸이 자기 스위치를 되읽어 준다(engine:debug).
  // `noglue`에서는 그 채널 자체가 죽으므로 null이 정답이다.
  const flags = await cdp
    .eval(
      `(async () => { try { const r = await window.__TAURI_INTERNALS__.invoke('ipc_call',
         { channel: 'engine:debug', payload: [{}] }); return JSON.stringify(r?.flags ?? null) }
         catch (e) { return 'null' } })()`,
      { awaitPromise: true }
    )
    .then((s) => JSON.parse(s))
    .catch(() => null)

  cdp.close()
  await sleep(500)
  killTree(child.pid)
  await sleep(1500)
  return {
    arm,
    panels,
    totalWsMB: mem.totalWsMB,
    totalPrivMB: mem.totalPrivMB,
    procs: mem.procs?.length,
    bucket,
    heapUsedMB: heap ? Math.round((heap.usedSize / 1048576) * 10) / 10 : null,
    flags
  }
}

const runs = []
for (const arm of ARMS) {
  for (let i = 0; i < PAIRS; i++) {
    // 쌍 = (base, arm). 순서를 쌍마다 뒤집어 "첫 회차가 콜드 프로필을 뒤집어쓴다"는
    // 편향도 한쪽 팔에 고이지 않게 한다(R2.10의 1쌍 +0.1 사고).
    const order = i % 2 === 0 ? ['base', arm] : [arm, 'base']
    const pair = {}
    for (const a of order) {
      const r = await once(a)
      pair[a] = r
      console.log(
        `[${arm}#${i + 1}] ${a.padEnd(9)} total ${r.totalWsMB}/${r.totalPrivMB} · rust ${r.bucket.browser.ws}/${r.bucket.browser.priv} · rend ${r.bucket.renderer.ws}/${r.bucket.renderer.priv} · procs ${r.procs} · flags ${JSON.stringify(r.flags)}`
      )
    }
    runs.push({ arm, pair: i + 1, base: pair.base, off: pair[arm] })
  }
}

const d = (r, f) => Math.round((f(r.base) - f(r.off)) * 10) / 10 // 켬 − 끔 = **그 서브시스템의 몫**
const table = ARMS.map((arm) => {
  const rs = runs.filter((r) => r.arm === arm)
  const col = (f) => ({
    perPair: rs.map((r) => d(r, f)),
    median: median(rs.map((r) => d(r, f)))
  })
  return {
    arm,
    pairs: rs.length,
    totalWs: col((x) => x.totalWsMB),
    totalPriv: col((x) => x.totalPrivMB),
    rustWs: col((x) => x.bucket.browser.ws),
    rustPriv: col((x) => x.bucket.browser.priv),
    rendWs: col((x) => x.bucket.renderer.ws),
    rendPriv: col((x) => x.bucket.renderer.priv),
    heap: col((x) => x.heapUsedMB ?? 0)
  }
})

const OUT = path.join(REPO, 'bench', 'results', `attrib-tauri-3.0.0${TAG === String(process.pid) ? '' : `-${TAG}`}.json`)
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(
  OUT,
  JSON.stringify({ at: new Date().toISOString(), exe: binInfo(EXE), env: envInfo(), pairs: PAIRS, table, runs }, null, 2)
)
console.log('\n귀속(켬 − 끔, 쌍별 Δ의 중앙값 · MB):')
console.log('arm        totalWS  totalPriv  rustWS  rustPriv  rendWS  rendPriv')
for (const t of table) {
  const f = (x) => String(x.median).padStart(7)
  console.log(
    `${t.arm.padEnd(10)} ${f(t.totalWs)} ${f(t.totalPriv)} ${f(t.rustWs)} ${f(t.rustPriv)} ${f(t.rendWs)} ${f(t.rendPriv)}`
  )
  console.log(`           쌍별 totalPriv: ${JSON.stringify(t.totalPriv.perPair)}`)
}
console.log('\nsaved:', path.relative(REPO, OUT))
rmrf(HOME)
