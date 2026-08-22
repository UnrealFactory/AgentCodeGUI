// WebView2(Chromium) 스위치 레버를 **하나씩 켜고** 유휴 메모리를 재는 하네스.
//
//   node bench/flags.mjs sweep [repeats=2] [settleSec=25]   ← 표 만들기
//   node bench/flags.mjs precedence                          ← env var vs 코드 인자 우선순위
//   node bench/flags.mjs one <name> [repeats] [settleSec]    ← 한 레버만 다시
//
// 규칙(docs/memory-strategy.md §판정):
//  - 대조군은 `CCG_WEBVIEW_ARGS_BASE_ONLY=1`(= wry 기본 인자만). 모든 레버는 대조군 위에
//    **하나만** 얹는다. 뭉뚱그린 세트는 다음 사람이 되돌릴 수 없다.
//  - 측정은 **CDP 없이**(첫 가시 창 → 고정 정착). 제품 실사용이 그쪽이고, CDP를 켜면
//    WebView2가 DevTools 호스트를 세워 프로세스/커밋이 달라진다.
//  - 홈은 `.bench-home-flags` 하나를 재사용한다(같은 픽스처·같은 WebView2 프로필 캐시).
//  - 픽스처는 **멀티 그리드 4패널**이다(주 게이트와 같은 무대). 단일 채팅에서 재면
//    레버가 렌더러 힙에 미치는 영향이 과소평가된다.
import fs from 'node:fs'
import path from 'node:path'
import { tauriProfile, measureIdle, median, sleep, envInfo, cdpTargets, killTree, REPO } from './lib.mjs'
import { makeMultiFixture } from './fixture.mjs'
import { spawn } from 'node:child_process'

const HOME = path.join(REPO, '.bench-home-flags')
const OUT = path.join(REPO, 'bench', 'results', 'webview-flags.json')

// 대조군 위에 하나씩 얹는 레버. env가 곧 레버의 정의다(재현 가능).
const BASE = { CCG_WEBVIEW_ARGS_BASE_ONLY: '1' }
const LEVERS = [
  { name: 'A0-control-wry-default', env: {}, note: 'wry 기본 인자만 (--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection)' },

  // ── 1군: 프로세스 모델 ────────────────────────────────────────────────────
  { name: 'B1-spare-renderer-off', env: { CCG_WEBVIEW_DISABLE_FEATURES: 'SpareRendererForSitePerProcess' },
    note: 'Edge가 미리 띄우는 예비 렌더러 프로세스 끄기' },
  { name: 'B2-renderer-limit-1', env: { CCG_WEBVIEW_ARGS_EXTRA: '--renderer-process-limit=1' },
    note: '렌더러 프로세스 상한 1' },
  { name: 'B3-process-per-site', env: { CCG_WEBVIEW_ARGS_EXTRA: '--process-per-site' },
    note: '같은 사이트 문서는 프로세스 공유' },
  { name: 'B4-no-site-isolation', env: { CCG_WEBVIEW_ARGS_EXTRA: '--disable-site-isolation-trials' },
    note: '사이트 격리 해제(렌더러 통합)' },
  { name: 'B5-network-in-process', env: { CCG_WEBVIEW_ENABLE_FEATURES: 'NetworkServiceInProcess' },
    note: '네트워크 서비스를 브라우저 프로세스 안에서' },
  { name: 'B6-audio-in-process', env: { CCG_WEBVIEW_DISABLE_FEATURES: 'AudioServiceOutOfProcess' },
    note: '오디오 서비스 별도 프로세스 끄기' },
  { name: 'B7-in-process-gpu', env: { CCG_WEBVIEW_ARGS_EXTRA: '--in-process-gpu' },
    note: 'GPU 프로세스를 브라우저 안으로 (스크롤 FPS 확인 필수)' },
  { name: 'B8-single-process', env: { CCG_WEBVIEW_ARGS_EXTRA: '--single-process' },
    note: 'MS 미지원 — 데이터 포인트로만' },

  // ── 2군: 서브시스템 끄기 ──────────────────────────────────────────────────
  { name: 'C1-features-off-bulk',
    env: { CCG_WEBVIEW_DISABLE_FEATURES: 'Translate,OptimizationHints,OptimizationGuideModelDownloading,BackForwardCache,MediaRouter,InterestFeedContentSuggestions,AutofillServerCommunication' },
    note: '번역·힌트·bfcache·캐스트·자동완성 서버통신 끄기' },
  { name: 'C2-bg-networking-off',
    env: { CCG_WEBVIEW_ARGS_EXTRA: '--disable-background-networking --disable-sync --disable-component-update --disable-extensions --no-first-run --no-default-browser-check --noerrdialogs' },
    note: '부팅 잡업(동기화·컴포넌트 업데이트·확장) 끄기' },

  // ── 3군: 그래픽 (메모리 ↔ 부드러움 맞바꿈 — 채택은 scroll.mjs 통과 조건) ──
  { name: 'D1-disable-gpu-compositing', env: { CCG_WEBVIEW_ARGS_EXTRA: '--disable-gpu-compositing' },
    note: 'GPU 합성 끄기' },
  { name: 'D2-disable-gpu', env: { CCG_WEBVIEW_ARGS_EXTRA: '--disable-gpu' },
    note: 'GPU 전면 끄기' },
  { name: 'D3-raster-1-thread', env: { CCG_WEBVIEW_ARGS_EXTRA: '--num-raster-threads=1 --disable-partial-raster' },
    note: '래스터 스레드 1개' },

  // ── 4군: V8 힙 ────────────────────────────────────────────────────────────
  { name: 'E1-v8-heap-256', env: { CCG_WEBVIEW_ARGS_EXTRA: '--js-flags=--max-old-space-size=256' },
    note: 'V8 old space 상한 256MB' },
  { name: 'E2-low-end-device', env: { CCG_WEBVIEW_ARGS_EXTRA: '--enable-low-end-device-mode' },
    note: 'Chromium 저사양 모드(힙·래스터·예비 렌더러 일괄 축소)' },

  // ── Z: 제품 기본값(webview_args.rs에 박은 채택 세트) 그대로 ────────────────
  { name: 'Z-adopted-default', env: null, note: 'BASE_ONLY 없이 = 코드에 박힌 채택 세트' }
]

function seedHome() {
  fs.rmSync(HOME, { recursive: true, force: true })
  makeMultiFixture(HOME, '3.0.0-beta.1', { panels: 4 })
}

async function runLever(lever, { repeats, settleSec }) {
  const runs = []
  for (let i = 0; i < repeats; i++) {
    const profile = tauriProfile({ cdp: false, extraEnv: { ...(lever.env ? BASE : {}), ...(lever.env ?? {}) } })
    profile.env.CCG_HOME = HOME
    let mem = null
    try {
      mem = await measureIdle(profile, { settleSec, cdp: false })
    } catch (err) {
      runs.push({ error: String(err?.message ?? err) })
      continue
    }
    if (mem?.error) { runs.push({ error: mem.error }); continue }
    runs.push({
      wsMB: mem.totalWsMB,
      privMB: mem.totalPrivMB,
      procs: mem.procs?.length ?? 0,
      detail: mem.procs
    })
    await sleep(800)
  }
  const ok = runs.filter((r) => !r.error)
  return {
    name: lever.name,
    note: lever.note,
    env: lever.env === null ? '(제품 기본값)' : { ...BASE, ...lever.env },
    runs: runs.map(({ detail, ...r }) => r),
    wsMB: median(ok.map((r) => r.wsMB)),
    privMB: median(ok.map((r) => r.privMB)),
    procs: median(ok.map((r) => r.procs)),
    lastDetail: ok.at(-1)?.detail ?? null
  }
}

// ── env var vs 코드 인자 우선순위 실측 ────────────────────────────────────────
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS(로더가 읽는 공식 환경변수)와 wry가 넣는
// ICoreWebView2EnvironmentOptions::AdditionalBrowserArguments 중 무엇이 이기는가.
// 서로 **다른 CDP 포트**를 주고 어느 쪽이 응답하는지로 가른다 — 논쟁 없는 판정.
async function precedence() {
  const A = 9411 // 코드 인자(CCG_CDP_PORT → webview_args.rs)
  const B = 9412 // 환경변수
  const profile = tauriProfile({ cdp: true, port: A })
  profile.env.CCG_HOME = HOME
  profile.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${B}`
  const child = spawn(profile.cmd, profile.args, { env: { ...process.env, ...profile.env }, cwd: profile.cwd, stdio: 'ignore' })
  const alive = { code: false, envvar: false }
  const t0 = Date.now()
  while (Date.now() - t0 < 20000) {
    if (!alive.code) alive.code = await cdpTargets(A).then(() => true).catch(() => false)
    if (!alive.envvar) alive.envvar = await cdpTargets(B).then(() => true).catch(() => false)
    if (alive.code || alive.envvar) break
    await sleep(200)
  }
  await sleep(1500)
  if (!alive.code) alive.code = await cdpTargets(A).then(() => true).catch(() => false)
  if (!alive.envvar) alive.envvar = await cdpTargets(B).then(() => true).catch(() => false)
  killTree(child.pid)
  await sleep(1000)
  return {
    codeArgPort: A,
    envVarPort: B,
    codeArgAnswered: alive.code,
    envVarAnswered: alive.envvar,
    winner: alive.envvar && !alive.code ? 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS(환경변수)가 덮어쓴다'
      : alive.code && !alive.envvar ? 'AdditionalBrowserArguments(코드 인자)가 이긴다 — 환경변수는 무시'
      : alive.code && alive.envvar ? '둘 다 살아있다(합쳐진다)'
      : '둘 다 응답 없음 — 판정 실패'
  }
}

// ── 엔트리 ────────────────────────────────────────────────────────────────────
const mode = process.argv[2] ?? 'sweep'
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {}

if (mode === 'precedence') {
  seedHome()
  const r = await precedence()
  console.log(JSON.stringify(r, null, 2))
  fs.writeFileSync(OUT, JSON.stringify({ ...prev, precedence: r, at: new Date().toISOString() }, null, 2))
} else {
  // one 모드는 인자 자리가 하나 밀린다: flags.mjs one <name> [repeats] [settleSec]
  const only = mode === 'one' ? process.argv[3] : null
  const repeats = Number((only ? process.argv[4] : process.argv[3]) ?? (only ? 3 : 2))
  const settleSec = Number((only ? process.argv[5] : process.argv[4]) ?? 25)
  const list = only ? LEVERS.filter((l) => l.name === only) : LEVERS
  if (!list.length) {
    console.error(`그런 레버가 없다: ${only}\n${LEVERS.map((l) => '  ' + l.name).join('\n')}`)
    process.exit(2)
  }
  seedHome()
  const results = only ? { ...(prev.results ? Object.fromEntries(prev.results.map((r) => [r.name, r])) : {}) } : {}
  const acc = []
  for (const lever of list) {
    process.stdout.write(`— ${lever.name} … `)
    const r = await runLever(lever, { repeats, settleSec })
    console.log(`ws=${r.wsMB} priv=${r.privMB} procs=${r.procs}`)
    acc.push(r)
    results[r.name] = r
  }
  const merged = only ? Object.values(results) : acc
  const ctrl = merged.find((r) => r.name === 'A0-control-wry-default')
  for (const r of merged) {
    if (ctrl && ctrl.wsMB && r.wsMB != null) {
      r.deltaWsMB = Math.round((r.wsMB - ctrl.wsMB) * 10) / 10
      r.deltaPrivMB = Math.round((r.privMB - ctrl.privMB) * 10) / 10
      r.deltaProcs = r.procs - ctrl.procs
    }
  }
  const out = {
    ...prev,
    what: 'WEBVIEW2 스위치 레버별 유휴 메모리 (CDP off · 첫 가시 창 기준 정착)',
    method: {
      home: '.bench-home-flags — 멀티 4패널 × 120항목 픽스처(주 게이트와 같은 무대)',
      cdp: false,
      settleSec,
      repeats,
      control: 'A0-control-wry-default'
    },
    env: envInfo(),
    results: merged,
    at: new Date().toISOString()
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
  console.log('\nsaved:', OUT)
  console.table(merged.map((r) => ({ lever: r.name, wsMB: r.wsMB, privMB: r.privMB, procs: r.procs, dWs: r.deltaWsMB, dPriv: r.deltaPrivMB, dProc: r.deltaProcs })))
}
