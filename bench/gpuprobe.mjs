// 합성기(GPU 프로세스)·렌더러가 **무엇 때문에** 크는지 재빌드 없이 가른다.
//
//   node bench/gpuprobe.mjs tauri|electron
//
// 배경: wincost.mjs의 role 태깅으로 유휴 7프로세스의 정체가 드러났고, 그중
// gpu-process가 WS 85 / **Priv 126MB** 였다(렌더러 다음으로 큰 소비자). 플래그로 끄기
// 전에 "그 메모리가 무엇의 값인가"를 먼저 알아야 한다 — 우리 CSS가 만든 것이면
// 플래그가 아니라 CSS가 답이고, 플래그로 끄면 FPS만 잃는다.
//
// 방법: 살아 있는 앱에 <style> 오버라이드를 **하나씩 누적**으로 얹고 그때마다
// 프로세스 트리를 역할별로 다시 잰다. 각 단계의 차이가 곧 그 효과의 값이다.
// (재시작 A/B가 더 깨끗하지만 부팅 편차가 단계 차이보다 커서 누적 쪽이 분해능이 높다.)
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { electronProfile, tauriProfile, connectMainPage, procTreeMem, killTree, sleep, envInfo, REPO } from './lib.mjs'
import { makeMultiFixture } from './fixture.mjs'

const kind = process.argv[2] ?? 'tauri'
const SETTLE = Number((process.argv.find((a) => a.startsWith('--settle=')) ?? '--settle=14').split('=')[1])
const HOME = path.join(REPO, '.bench-home-gpu' + (kind === 'tauri' ? '-tauri' : ''))
const OUT = path.join(REPO, 'bench', 'results', 'gpu-css-probe.json')
const profile = kind === 'tauri' ? tauriProfile({ port: 9381 }) : electronProfile({ port: 9382 })
profile.env.CCG_HOME = HOME

fs.rmSync(HOME, { recursive: true, force: true })
makeMultiFixture(HOME, kind === 'tauri' ? '3.0.0-beta.1' : '2.6.2', { panels: 4 })

const child = spawn(profile.cmd, profile.args, {
  env: { ...process.env, ...profile.env }, cwd: profile.cwd, stdio: 'ignore'
})
const cdp = await connectMainPage(profile.port, { timeoutMs: 45000 })
for (;;) {
  if (await cdp.eval(profile.mountExpr).catch(() => false)) break
  await sleep(100)
}
await sleep(4000)
const panels = await cdp.eval(`document.querySelectorAll('.ma-p-thread').length`)
console.log('panels:', panels)

const roleSum = (procs) => {
  const by = {}
  for (const p of procs ?? []) {
    const k = `${p.role ?? '?'}${p.sub ? ':' + String(p.sub).replace(/^.*\.mojom\./, '') : ''}`
    by[k] ??= { n: 0, wsMB: 0, privMB: 0 }
    by[k].n++
    by[k].wsMB = Math.round((by[k].wsMB + p.wsMB) * 10) / 10
    by[k].privMB = Math.round((by[k].privMB + p.privMB) * 10) / 10
  }
  return by
}

const steps = []
async function measure(label) {
  await sleep(SETTLE * 1000)
  await cdp.send('HeapProfiler.enable').catch(() => {})
  await cdp.send('HeapProfiler.collectGarbage').catch(() => {})
  await sleep(2500)
  const m = procTreeMem(child.pid, { role: true })
  const js = await cdp.eval(`(() => { const m = performance.memory
    return m ? { usedMB: Math.round(m.usedJSHeapSize/1048576*10)/10, totalMB: Math.round(m.totalJSHeapSize/1048576*10)/10 } : null })()`).catch(() => null)
  const dom = await cdp.send('Memory.getDOMCounters').catch(() => null)
  const row = { label, wsMB: m.totalWsMB, privMB: m.totalPrivMB, procs: m.procs?.length, byRole: roleSum(m.procs), jsHeap: js, dom }
  steps.push(row)
  const g = row.byRole['gpu-process'] ?? {}
  const r = row.byRole['renderer'] ?? {}
  console.log(`${label.padEnd(30)} tot ${row.wsMB}/${row.privMB}  gpu ${g.wsMB}/${g.privMB}  rend ${r.wsMB}/${r.privMB}  js ${js?.usedMB}`)
  return row
}

/** 누적 오버라이드 — 같은 <style> 노드에 계속 덧붙인다. */
async function apply(css) {
  await cdp.eval(`(() => {
    let s = document.getElementById('__ccg_probe_css')
    if (!s) { s = document.createElement('style'); s.id = '__ccg_probe_css'; document.head.appendChild(s) }
    s.textContent += ${JSON.stringify(css)}
    // 레이아웃/합성을 실제로 다시 돌게 강제
    document.body.getBoundingClientRect()
    return s.textContent.length
  })()`)
  await sleep(1200)
}

await measure('0-baseline')

// 1) 블러 워머 — 2x2px 고정 요소 하나가 backdrop-filter 표면(=백드롭 루트 전체 스냅샷)을
//    상시로 붙들고 있다. 창 크기만 한 텍스처가 하나 살아 있는지 여기서 드러난다.
await apply('.blurwarm{display:none!important}')
await measure('1-no-blurwarm')

// 2) 나머지 backdrop-filter 전부(유휴엔 대부분 안 보이지만 표면은 만들어질 수 있다)
await apply('*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}')
await measure('2-no-backdrop-filter')

// 3) box-shadow 116곳 — 그림자는 페인트 비용이지 합성 표면은 아니지만 타일 무효화가 크다
await apply('*{box-shadow:none!important}')
await measure('3-no-box-shadow')

// 4) 패널 3개를 DOM에서 숨긴다 — "패널 하나당" 렌더러/GPU 값
await apply('.ma-panel:nth-child(n+2){display:none!important}')
await measure('4-one-panel-visible')

// 5) 문서를 통째로 비운다 — 웹 런타임의 바닥값(우리 UI와 무관한 상수 비용)
await cdp.eval(`document.getElementById('root').innerHTML=''`)
await measure('5-empty-root')

const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {}
prev.env ??= envInfo()
prev.what = '합성기/렌더러 메모리의 출처 — 살아 있는 앱에 CSS 오버라이드를 누적으로 얹으며 역할별 재측정'
prev[profile.name] = { panels, settleSec: SETTLE, steps, at: new Date().toISOString() }
fs.writeFileSync(OUT, JSON.stringify(prev, null, 2))
console.log('saved:', OUT)
cdp.close()
await sleep(500)
killTree(child.pid)
