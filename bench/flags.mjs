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
import { tauriProfile, measureIdle, median, sleep, envInfo, binInfo, cdpTargets, killTree, REPO } from './lib.mjs'
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
    note: '**옛 이름 — 존재하지 않는 feature다.** Chromium이 M96 무렵 kNetworkServiceInProcess의 문자열 이름을 "NetworkServiceInProcess2"로 바꿨다. 모르는 feature 이름은 경고 없이 조용히 무시된다. 무효 판정의 근거로 쓰면 안 되는 줄 — 대조군으로만 남긴다(B5b가 진짜다).' },
  { name: 'B5b-network-in-process2', env: { CCG_WEBVIEW_ENABLE_FEATURES: 'NetworkServiceInProcess2' },
    note: '현행 이름. utility:NetworkService 프로세스가 통째로 사라진다(R3 크리틱 실측 ΔWS −40 / Δprocs −1).' },
  { name: 'B6-audio-in-process', env: { CCG_WEBVIEW_DISABLE_FEATURES: 'AudioServiceOutOfProcess' },
    note: '오디오 서비스 별도 프로세스 끄기' },
  { name: 'B7-in-process-gpu', env: { CCG_WEBVIEW_ARGS_EXTRA: '--in-process-gpu' },
    note: 'GPU 프로세스를 브라우저 안으로 (스크롤 FPS 확인 필수)' },
  { name: 'B8-single-process', env: { CCG_WEBVIEW_ARGS_EXTRA: '--single-process' },
    note: 'MS 미지원 — 데이터 포인트로만' },
  // R3 추가: wincost의 role 태깅이 밝힌 실제 프로세스 구성에서 나온 레버들.
  // 유휴 7프로세스 = browser(webview2) + agentcodegui(호스트) + renderer + gpu-process
  //                 + utility:NetworkService + utility:StorageService + crashpad-handler
  { name: 'B9-storage-in-process', env: { CCG_WEBVIEW_DISABLE_FEATURES: 'StorageServiceOutOfProcess' },
    note: '스토리지 서비스를 브라우저 프로세스 안에서 (utility 하나 제거 시도)' },
  { name: 'B10-no-crashpad', env: { CCG_WEBVIEW_ARGS_EXTRA: '--disable-breakpad --disable-crash-reporter' },
    note: 'crashpad-handler 프로세스 제거 시도' },
  { name: 'B11-net-in-process-switch', env: { CCG_WEBVIEW_ARGS_EXTRA: '--single-process-network' },
    note: 'feature가 아니라 스위치로 네트워크 인프로세스 (B5가 안 먹을 때의 대안)' },

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
  // R3 추가: gpu-process가 Priv 118~124MB로 **렌더러 다음으로 큰 소비자**였다(role 태깅).
  // 프로세스를 없애는 대신 그 안의 예산·캐시를 깎는 쪽부터 잰다(FPS 위험이 낮은 순).
  { name: 'D4-gpu-mem-64', env: { CCG_WEBVIEW_ARGS_EXTRA: '--force-gpu-mem-available-mb=64' },
    note: 'GPU 프로세스가 스스로 잡는 메모리 예산 상한' },
  { name: 'D5-no-gpu-caches', env: { CCG_WEBVIEW_ARGS_EXTRA: '--disable-gpu-shader-disk-cache --disable-gpu-program-cache --disable-gpu-driver-bug-workarounds' },
    note: 'GPU 셰이더/프로그램 캐시 끄기' },
  { name: 'D6-no-accel-canvas', env: { CCG_WEBVIEW_ARGS_EXTRA: '--disable-accelerated-2d-canvas --disable-accelerated-video-decode --disable-accelerated-video-encode' },
    note: '2D 캔버스·비디오 가속 끄기(앱이 쓰지 않는 경로)' },
  { name: 'D7-angle-gl', env: { CCG_WEBVIEW_ARGS_EXTRA: '--use-angle=gl' },
    note: 'ANGLE 백엔드를 D3D11 대신 GL (D3D 리소스 커밋 회피 시도)' },
  { name: 'D8-gpu-mem-64+no-caches', env: { CCG_WEBVIEW_ARGS_EXTRA: '--force-gpu-mem-available-mb=64 --disable-gpu-shader-disk-cache --disable-gpu-program-cache' },
    note: 'D4+D5 합 — 가산성 확인용' },

  // ── 4군: V8 힙 ────────────────────────────────────────────────────────────
  { name: 'E1-v8-heap-256', env: { CCG_WEBVIEW_ARGS_EXTRA: '--js-flags=--max-old-space-size=256' },
    note: 'V8 old space 상한 256MB' },
  { name: 'E2-low-end-device', env: { CCG_WEBVIEW_ARGS_EXTRA: '--enable-low-end-device-mode' },
    note: 'Chromium 저사양 모드(힙·래스터·예비 렌더러 일괄 축소)' },
  // R3 추가: 값 안에 공백이 있는 스위치라 webview_args.rs의 따옴표 인지 분리가 필요하다.
  { name: 'E3-v8-optimize-for-size', env: { CCG_WEBVIEW_ARGS_EXTRA: '--js-flags="--optimize-for-size"' },
    note: 'V8이 속도보다 메모리를 택한다(코드 공간·인라인 캐시 축소)' },
  { name: 'E4-v8-small-semispace', env: { CCG_WEBVIEW_ARGS_EXTRA: '--js-flags="--max-semi-space-size=1"' },
    note: '영세대(semi space) 8MB→1MB — 스캐빈지가 잦아지므로 FPS 확인 필수' },
  { name: 'E5-v8-both', env: { CCG_WEBVIEW_ARGS_EXTRA: '--js-flags="--optimize-for-size --max-semi-space-size=1"' },
    note: 'E3+E4 (따옴표 안 공백 보존이 되는지 자체가 검증 대상)' },

  // ── F군: 창 껍데기(아크릴/투명)의 메모리 값 — 플래그가 아니라 창 옵션이다 ────
  // 투명 창은 합성기가 알파를 안고 가야 해서 표면·버퍼가 늘 수 있다. CCG_CHROME는
  // R1이 만든 창 후보 전환 스위치라 재빌드 없이 대조군을 만들 수 있다(win.rs).
  { name: 'F1-no-acrylic-opaque', env: { CCG_CHROME: 'c' },
    note: '채택안(b)에서 아크릴+투명만 뺀 창 — 유리의 메모리 값' },
  { name: 'F2-decorated-window', env: { CCG_CHROME: 'a' },
    note: 'OS 캡션 창(파리티 불가·데이터 포인트)' },

  // ── Y군: 조합(R3 1차 스윕에서 실제로 효과가 난 것만 쌓는다) ────────────────
  // 개별 레버는 "대조군 + 하나"였다. 제품은 여러 개를 동시에 켜므로 가산성이
  // 성립하는지 따로 재야 한다(GPU 백엔드와 GPU 프로세스 배치는 서로 간섭할 수 있다).
  { name: 'Y1-angle-gl+in-process-gpu', env: { CCG_WEBVIEW_ARGS_EXTRA: '--use-angle=gl --in-process-gpu' },
    note: 'D7+B7 — Priv 최대 절감 후보(FPS 게이트 필수)' },
  { name: 'Y2-safe-set', env: { CCG_WEBVIEW_ARGS_EXTRA: '--use-angle=gl --in-process-gpu --process-per-site --disable-background-networking --disable-sync --disable-component-update --disable-extensions --no-first-run --no-default-browser-check --noerrdialogs' },
    note: 'Y1 + 프로세스 공유 + 부팅 잡업 끄기 (MS 지원 범위 안)' },
  { name: 'Y3-safe-set+v8', env: { CCG_WEBVIEW_ARGS_EXTRA: '--use-angle=gl --in-process-gpu --process-per-site --disable-background-networking --disable-sync --disable-component-update --disable-extensions --no-first-run --no-default-browser-check --noerrdialogs --js-flags="--optimize-for-size"' },
    note: 'Y2 + V8 메모리 우선' },
  { name: 'Y4-single-process+angle-gl', env: { CCG_WEBVIEW_ARGS_EXTRA: '--single-process --use-angle=gl' },
    note: 'MS 미지원 조합 — 목표 도달 여부의 상한선을 알기 위한 데이터 포인트' },

  // ── Z: 제품 기본값(webview_args.rs에 박은 채택 세트) 그대로 ────────────────
  { name: 'Z-adopted-default', env: null, note: 'BASE_ONLY 없이 = 코드에 박힌 채택 세트' }
]

// `--keep` = 홈을 그대로 쓴다(WebView2 프로필이 따뜻한 상태).
// 왜 필요한가: seedHome()은 홈을 통째로 지우므로 **그 뒤 첫 레버만 WebView2 프로필을
// 새로 만든다**(Default/ 생성·LevelDB 초기화·코드 캐시 없음). R3 1차 스윕에서 A0가
// 맨 앞이었던 탓에 대조군만 차가웠고, 그 뒤 모든 레버가 약 −14MB씩 싸게 나오는
// 가짜 밴드가 생겼다. 이후로는 (a) 스윕이면 대조군을 한 번 버리는 워밍업으로 돌리고,
// (b) 한 레버만 다시 잴 때는 `--keep`으로 따뜻한 홈을 쓴다.
const KEEP = process.argv.includes('--keep')

function seedHome() {
  if (KEEP && fs.existsSync(HOME)) return
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
      mem = await measureIdle(profile, { settleSec, cdp: false, role: true })
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
    // 총합만으로는 "무엇이 줄었나"를 못 본다 — 역할별(--type=)로도 남긴다.
    byRole: roleSum(ok.at(-1)?.detail),
    lastDetail: ok.at(-1)?.detail ?? null
  }
}

/** 프로세스 목록 → 역할별 합계. wincost.mjs와 같은 문법. */
function roleSum(procs) {
  if (!procs) return null
  const by = {}
  for (const p of procs) {
    const k = `${p.role ?? '?'}${p.sub ? ':' + p.sub.replace(/^.*\.mojom\./, '') : ''}`
    by[k] ??= { n: 0, wsMB: 0, privMB: 0 }
    by[k].n++
    by[k].wsMB = Math.round((by[k].wsMB + p.wsMB) * 10) / 10
    by[k].privMB = Math.round((by[k].privMB + p.privMB) * 10) / 10
  }
  return by
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
  if (!only && !KEEP) {
    // 대조군을 한 번 버리는 워밍업 — WebView2 프로필 생성 비용을 첫 레버가 뒤집어쓰지
    // 않게 한다(위 seedHome 주석의 '가짜 −14MB 밴드' 방지).
    process.stdout.write('— warmup (버리는 측정) … ')
    const w = await runLever(LEVERS[0], { repeats: 1, settleSec: Math.min(settleSec, 15) })
    console.log(`ws=${w.wsMB} priv=${w.privMB} (버림)`)
  }
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
    notes: [
      'R3 1차 스윕(2026-08-22)에서 A0 대조군만 WebView2 프로필이 차가웠다(seedHome 직후). 그 탓에 그 뒤 모든 레버가 약 −14MB씩 싸게 나오는 가짜 밴드가 생겼다 — A0를 `--keep`(따뜻한 홈)으로 다시 재서 대체했고, 그 이후 델타는 그 값 기준이다.',
      '**"procs가 안 바뀌면 WebView2가 무시한 것"은 틀린 추론이다(R3 크리틱 §5.1이 반증).** NetworkServiceInProcess가 무효로 보인 진짜 이유는 런타임이 무시해서가 아니라 **Chromium이 feature 이름을 바꿔서**(→ NetworkServiceInProcess2) 존재하지 않는 이름을 준 것이었다. 올바른 이름을 주면 utility:NetworkService가 사라진다. 무효 판정 전에 **현행 Chromium 이름부터 대조할 것**.',
      'Priv 절감의 정체는 GPU 프로세스의 D3D11 커밋이다: gpu-process Priv 106MB → --use-angle=gl 또는 --disable-gpu로 18MB.',
      '앱(우리 UI)이 차지하는 몫은 **WS 43MB / Priv 34MB**다(gpu-css-probe.json의 `appShare`). 예전 주석의 "8.4MB"는 `innerHTML=\'\'`로 잰 값이라 무효였다 — DOM을 떼어냈을 뿐 해제하지 않아 리스너·JS 힙이 그대로였다. 지금 하네스는 about:blank로 문서를 언로드하고 해제 여부를 판정 조건으로 찍는다.'
    ],
    method: {
      home: '.bench-home-flags — 멀티 4패널 × 120항목 픽스처(주 게이트와 같은 무대)',
      cdp: false,
      settleSec,
      repeats,
      control: 'A0-control-wry-default'
    },
    // 어느 바이너리로 쟀는가 (§9-6) — 커밋된 표의 Z행이 procs 7이었던 사고(채택 레버가
    // 붙기 전 exe)를 다음 사람이 파일만 보고 알아챌 수 있게 한다.
    bin: binInfo(tauriProfile({}).cmd),
    env: envInfo(),
    results: merged,
    at: new Date().toISOString()
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
  console.log('\nsaved:', OUT)
  console.table(merged.map((r) => ({ lever: r.name, wsMB: r.wsMB, privMB: r.privMB, procs: r.procs, dWs: r.deltaWsMB, dPriv: r.deltaPrivMB, dProc: r.deltaProcs })))
}
