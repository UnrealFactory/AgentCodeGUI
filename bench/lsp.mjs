// ── M7 코드 탐색기/LSP 하네스 ────────────────────────────────────────────────
//
//   node bench/lsp.mjs electron            2.6.2 기준 (out/ 빌드 + node_modules/electron)
//   node bench/lsp.mjs tauri               3.0.0 (target/release/agentcodegui.exe)
//   node bench/lsp.mjs both                둘 다
//     --lang ts            픽스처 언어(기본 ts) — bench/lspfix.mjs의 FIXTURES 키
//     --out <suffix>       결과 파일 접미사 (lsp-<kind>-<ver><suffix>.json)
//     --exe <path>         3.0 실행 파일(기본 target/release/agentcodegui.exe)
//     --blocks 420         big.ts 블록 수
//     --keep               앱/작업폴더 남김
//     --no-viewer          뷰어 CDP 실증 생략(수치만)
//
// 산출: bench/results/lsp-electron-2.6.2.json · lsp-tauri-3.0.0.json
//       bench/shots/lsp-<kind>/*.png (뷰어 실증)
//
// ── 왜 이렇게 재는가 ──────────────────────────────────────────────────────────
// **공정성 = 대칭성.** 두 앱의 렌더러는 같은 화면 코드(2.6.2 src/renderer ≡ 3.0 app/src)라
// 계약면도 같다 — `window.api.lsp.*`. 그래서 **렌더러 안에서** performance.now()로 재고
// (CDP 왕복을 측정에서 뺀다), 표본 루프도 페이지 안에서 돌린다. 두 앱에 대해 같은 코드가
// 같은 픽스처(bench/lspfix.mjs, 생성 — 바이트 동일)를 상대로 돈다.
//
// [측정 눈금]
//   prewarmMs        문서 시작(navigationStart) → lsp.status가 'ready'가 된 순간
//                    (앱이 부팅 때 스스로 prewarm을 부른다 — App.tsx. 그게 실사용 경로다)
//   fpsDuringPrewarm 그 구간의 rAF 프레임 간격 — 인덱싱이 UI 스레드를 먹는지
//   tokenColdMs      캐시 미적중: 대형 파일의 첫 **비어 있지 않은** semanticTokens까지
//   tokenCacheMs     캐시 적중: 같은 홈으로 재실행 → cachedTokens가 값을 주기까지
//   hover/def        p50/p95 + 적중률(내용이 실제로 온 비율)
//   complFirstMs     completion 호출 → 첫 후보가 실린 목록까지
//   retokenizeMs     디스크에서 파일이 바뀐 뒤 → 토큰이 새 심볼을 담기까지
//   idleReclaim      유휴 TTL 뒤 서버 프로세스가 실제로 사라지는지(3.0은 TTL 주입 가능)
//
// [측정하지 않는 것] 메모리 — 4명 동시 주행이라 노이즈가 크다(리드가 따로 잰다).
//   대신 **서버 프로세스 목록(이름·PID)**만 남겨 리드가 그 PID를 재도록 한다.
//
// [격리 규약] 홈 = %TEMP%/ccg-lsp-home-<kind>, 작업 폴더 = %TEMP%/ccg-lsp-repo(이 레포의
//   로컬 클론). 실 레포·실홈은 **읽기/복사만**. 죽이는 프로세스는 내가 스폰한 PID 트리뿐.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import { electronProfile, tauriProfile, connectMainPage, killTree, sleep, median, envInfo, REPO } from './lib.mjs'
import { makeFixtureHome, FIX_ID } from './fixture.mjs'
import { HELPERS_JS, makeCtx } from './screens.mjs'
import { FIXTURES } from './lspfix.mjs'

const argv = process.argv.slice(2)
const which = argv.find((a) => !a.startsWith('--')) ?? 'tauri'
const KINDS = which === 'both' ? ['electron', 'tauri'] : [which]
const flag = (name, dflt) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
const LANG = flag('lang', 'ts')
const OUT_SUFFIX = flag('out', '')
/// 3.0 실행 파일 경로(기본 `target/release/agentcodegui.exe`) — `--exe`로 갈아끼운다.
const EXE_ARG = flag('exe', '')
const BLOCKS = Number(flag('blocks', '420'))
const KEEP = argv.includes('--keep')
const NO_VIEWER = argv.includes('--no-viewer')
const WORK = path.join(os.tmpdir(), 'ccg-lsp-repo')
const VIEW = { width: 1440, height: 900 }

if (!FIXTURES[LANG]) throw new Error(`알 수 없는 픽스처 언어: ${LANG} (있는 것: ${Object.keys(FIXTURES).join(', ')})`)

// ── 작업 폴더(클론) ───────────────────────────────────────────────────────────
function makeWorkRepo() {
  if (!fs.existsSync(path.join(WORK, '.git'))) {
    fs.rmSync(WORK, { recursive: true, force: true })
    execFileSync('git', ['clone', '--local', '--no-hardlinks', '--quiet', REPO, WORK], { stdio: 'ignore' })
  }
  return FIXTURES[LANG].make(WORK, { blocks: BLOCKS })
}

function makeHome(kind, version, fresh) {
  const home = path.join(os.tmpdir(), `ccg-lsp-home-${kind}`)
  if (fresh) {
    fs.rmSync(home, { recursive: true, force: true })
    makeFixtureHome(home, version)
    const f = path.join(home, 'chats', `${FIX_ID}.json`)
    const chat = JSON.parse(fs.readFileSync(f, 'utf8'))
    chat.manualCwd = WORK
    if (chat.snapshot) chat.snapshot.cwd = WORK
    fs.writeFileSync(f, JSON.stringify(chat))
  }
  return home
}

// ── 페이지 안에서 도는 측정기 ─────────────────────────────────────────────────
// 모든 표본 루프가 여기서 돈다 — CDP 왕복은 측정에 들어가지 않는다.
const PROBE_JS = `(() => {
  const L = (window.__lsp = window.__lsp || {})
  L.installedAt = L.installedAt != null ? L.installedAt : performance.now()
  L.api = () => (window.api && window.api.lsp) || null

  // ── rAF 프레임 샘플러 (UI 스레드가 막히는지) ──
  L.fpsStart = () => {
    L.frames = []
    L.fpsOn = true
    const tick = (t) => { if (!L.fpsOn) return; L.frames.push(t); requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    return true
  }
  L.fpsStop = () => {
    L.fpsOn = false
    const f = L.frames || []
    if (f.length < 3) return { frames: f.length, spanMs: 0, fps: null, p95GapMs: null, longFrames: null }
    const gaps = []
    for (let i = 1; i < f.length; i++) gaps.push(f[i] - f[i - 1])
    const sorted = gaps.slice().sort((a, b) => a - b)
    const span = f[f.length - 1] - f[0]
    return {
      frames: f.length,
      spanMs: Math.round(span),
      fps: Math.round((f.length - 1) / (span / 1000) * 10) / 10,
      medGapMs: Math.round(sorted[Math.floor(sorted.length / 2)] * 100) / 100,
      p95GapMs: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 100) / 100,
      maxGapMs: Math.round(sorted[sorted.length - 1] * 100) / 100,
      longFrames: gaps.filter((g) => g > 33).length
    }
  }

  // ── status 감시: 'ready'가 된 절대 시각(performance.now = navigationStart 기준) ──
  L.watchReady = (cwd, rel) => {
    L.watchStart = performance.now()
    L.readyAt = null
    L.states = []
    L.statusErr = null
    let tries = 0
    const tick = () => {
      const a = L.api()
      if (!a) { if (tries++ < 3000) setTimeout(tick, 50); return }
      a.status(cwd, rel).then((st) => {
        if (L.states[L.states.length - 1] !== st) L.states.push(st)
        if (st === 'ready') { L.readyAt = performance.now(); return }
        if (tries++ < 3000) setTimeout(tick, 100)
      }).catch((e) => { L.statusErr = String(e && e.message || e); if (tries++ < 3000) setTimeout(tick, 200) })
    }
    tick()
    return true
  }
  L.readyInfo = () => ({
    installedAt: Math.round(L.installedAt),
    watchStart: Math.round(L.watchStart),
    readyAt: L.readyAt == null ? null : Math.round(L.readyAt),
    states: L.states,
    statusErr: L.statusErr
  })

  // ── 시맨틱 토큰 ──
  // 캐시 적중(서버를 안 띄우는 즉시 색칠) — 뷰어가 파일을 열자마자 부르는 그 호출.
  // **첫 표본과 p50을 따로 남긴다.** 첫 표본은 부팅 경합(프리웜 스폰·트리 로드)과 겹치는
  // 실사용 순간이고, p50은 그 경합을 뺀 이 경로의 값이다. 하나만 재면 "느려졌다"가
  // 캐시 탓인지 그때 마침 바빴던 탓인지 못 가른다.
  L.cachedTokens = async (cwd, rel, n) => {
    const rows = []
    for (let i = 0; i < (n || 1); i++) {
      const t0 = performance.now()
      const t = await L.api().cachedTokens(cwd, rel).catch(() => null)
      rows.push({
        ms: Math.round((performance.now() - t0) * 100) / 100,
        n: t && t.data ? t.data.length / 5 : 0,
        hit: !!(t && t.data && t.data.length)
      })
      await new Promise((r) => setTimeout(r, 120))
    }
    const sorted = rows.map((r) => r.ms).sort((a, b) => a - b)
    return {
      ms: rows[0].ms, // 첫 표본 = 파일을 여는 그 순간
      p50: sorted[Math.floor(sorted.length / 2)],
      min: sorted[0],
      n: rows[0].n,
      hit: rows[0].hit,
      rows
    }
  }
  // 라이브 토큰이 **비지 않게** 올 때까지 (뷰어 폴링과 같은 리듬)
  L.liveTokens = async (cwd, rel, budgetMs) => {
    const t0 = performance.now()
    let tries = 0
    for (;;) {
      const t = await L.api().semanticTokens(cwd, rel).catch(() => null)
      if (t && t.data && t.data.length) {
        return { ms: Math.round(performance.now() - t0), n: t.data.length / 5, types: t.types.length, tries }
      }
      tries++
      if (performance.now() - t0 > budgetMs) return { ms: null, n: 0, types: 0, tries, timeout: true, nullResult: t == null }
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  // ── 첫 색칠 경주 (문서 시작 시점에 건다) ──
  //
  // [함정] "대형 파일 열기 → 첫 페인트"를 하네스가 **나중에** 재면 그때는 이미 서버가
  // 그 문서를 파싱해 둔 뒤다(status 폴링이 openDoc을 시킨다). 실제로 첫 A/B에서 이걸
  // 밟았다 — 앞에 캐시 표본 5회를 끼워 넣자 '콜드 토큰'이 372ms에서 56ms로 떨어졌다.
  // 잰 것이 좋아진 게 아니라 **다른 것을 재게 된 것**이다.
  // 그래서 문서가 시작하는 순간 걸어 두고, performance.now()(=navigationStart 기준)로
  // 도착 시각을 박는다. 순서는 뷰어(FileModal)와 같다: cachedTokens는 즉시,
  // semanticTokens는 status가 ready가 된 뒤부터 폴링.
  L.paintRace = (cwd, rel) => {
    L.paint = { t0: performance.now(), cacheAt: null, cacheHit: false, cacheN: 0, liveAt: null, liveN: 0, tries: 0 }
    const whenApi = (fn) => { const tick = () => (L.api() ? fn() : setTimeout(tick, 20)); tick() }
    whenApi(() => {
      L.api().cachedTokens(cwd, rel).then((t) => {
        L.paint.cacheAt = performance.now()
        L.paint.cacheHit = !!(t && t.data && t.data.length)
        L.paint.cacheN = t && t.data ? t.data.length / 5 : 0
      }).catch(() => { L.paint.cacheAt = performance.now() })
      const loop = () => {
        L.api().semanticTokens(cwd, rel).then((t) => {
          if (t && t.data && t.data.length) {
            L.paint.liveAt = performance.now()
            L.paint.liveN = t.data.length / 5
            return
          }
          L.paint.tries++
          if (performance.now() - L.paint.t0 < 120000) setTimeout(loop, 250)
        }).catch(() => { L.paint.tries++; setTimeout(loop, 400) })
      }
      const gate = () => (L.readyAt != null ? loop() : setTimeout(gate, 50))
      gate()
    })
    return true
  }
  L.paintInfo = () => {
    const p = L.paint || {}
    const r = (v) => (v == null ? null : Math.round(v))
    return {
      cacheAtMs: r(p.cacheAt), cacheHit: !!p.cacheHit, cacheN: p.cacheN || 0,
      liveAtMs: r(p.liveAt), liveN: p.liveN || 0, tries: p.tries || 0,
      liveAfterReadyMs: p.liveAt != null && L.readyAt != null ? Math.round(p.liveAt - L.readyAt) : null
    }
  }

  // 토큰이 특정 문자열이 있는 줄을 담을 때까지 — 편집 반영(재정확화) 판정
  L.tokensCover = async (cwd, rel, line, budgetMs) => {
    const t0 = performance.now()
    let tries = 0
    for (;;) {
      const t = await L.api().semanticTokens(cwd, rel).catch(() => null)
      if (t && t.data && t.data.length) {
        for (let i = 0; i < t.data.length; i += 5) if (t.data[i] === line) {
          return { ms: Math.round(performance.now() - t0), tries }
        }
      }
      tries++
      if (performance.now() - t0 > budgetMs) return { ms: null, tries, timeout: true }
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  // ── 호버 / 정의 표본 루프 ──
  L.sample = async (kind, cwd, rel, positions) => {
    const a = L.api()
    const out = []
    for (const p of positions) {
      const t0 = performance.now()
      let r = null
      try { r = kind === 'hover' ? await a.hover(cwd, rel, p) : await a.definition(cwd, rel, p) } catch (e) { r = null }
      const ms = Math.round((performance.now() - t0) * 100) / 100
      const ok = kind === 'hover'
        ? !!(r && r.contents && r.contents.trim().length)
        : !!(r && r.length)
      out.push({ ms, ok, kind: p.kind, word: p.word,
        meta: kind === 'hover' ? (r && r.contents ? r.contents.slice(0, 60) : '') : (r && r[0] ? r[0].path : '') })
      await new Promise((r2) => setTimeout(r2, 25))
    }
    return out
  }

  // ── 자동완성: 첫 후보까지 ──
  L.completion = async (cwd, rel, text, pos, n) => {
    const a = L.api()
    const out = []
    for (let i = 0; i < n; i++) {
      // 매 회차 버퍼를 아주 조금 바꿔 서버 캐시에 그대로 얹히지 않게 한다(공백 1칸)
      const t = i === 0 ? text : text.replace('// EDIT-ANCHOR', '// EDIT-ANCHOR ' + i)
      const t0 = performance.now()
      let r = null
      try { r = await a.completion(cwd, rel, pos, t) } catch (e) { r = null }
      const ms = Math.round((performance.now() - t0) * 100) / 100
      out.push({ ms, items: r && r.items ? r.items.length : 0, ok: !!(r && r.items && r.items.length),
        sample: r && r.items ? r.items.slice(0, 5).map((x) => x.label) : [] })
      await new Promise((r2) => setTimeout(r2, 60))
    }
    return out
  }

  return true
})()`

// 문서가 만들어지는 **그 순간** 프로브를 심고 감시를 건다.
//
// [함정] 3.0은 CDP를 붙인 뒤에도 문서가 한 번 더 갈린다(초기 about:blank → tauri://localhost).
// 붙자마자 Runtime.evaluate로 심으면 그 컨텍스트째 사라져서 `window.__lsp`가 undefined가 된다
// (첫 A/B에서 실제로 밟았다: "Cannot read properties of undefined (reading 'cachedTokens')").
// addScriptToEvaluateOnNewDocument로 심으면 **양쪽 앱 모두** 문서 시작 시점에 심기고,
// performance.now()의 원점(navigationStart)과 감시 시작이 같은 사건에 붙는다 —
// prewarmMs가 하네스의 접속 속도에 흔들리지 않게 되는 부수 효과가 오히려 본체다.
const bootProbe = (cwd, rel) => `${PROBE_JS};(() => {
  const L = window.__lsp
  if (L.started) return 'already'
  L.started = true
  L.fpsStart()
  L.watchReady(${JSON.stringify(cwd)}, ${JSON.stringify(rel)})
  L.paintRace(${JSON.stringify(cwd)}, ${JSON.stringify(rel)})
  return 'armed'
})()`

const pct = (arr, q) => {
  if (!arr.length) return null
  const s = arr.slice().sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * q))] * 100) / 100
}
const stat = (rows) => {
  const ok = rows.filter((r) => r.ok)
  const ms = ok.map((r) => r.ms)
  return {
    n: rows.length,
    hits: ok.length,
    hitRate: rows.length ? Math.round((ok.length / rows.length) * 1000) / 10 : 0,
    p50: pct(ms, 0.5),
    p95: pct(ms, 0.95),
    max: ms.length ? Math.max(...ms) : null,
    // 실패 표본도 시간은 실재한다(사용자는 그만큼 기다렸다) — 따로 남긴다
    p50All: pct(rows.map((r) => r.ms), 0.5)
  }
}

// ── 서버 프로세스 목록 (메모리는 안 잰다 — 이름·PID만) ────────────────────────
function serverProcs(rootPid) {
  const ps = `$ErrorActionPreference='SilentlyContinue'
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine
$map = @{}; foreach ($p in $all) { $map[[int]$p.ProcessId] = $p }
$want = New-Object System.Collections.Generic.HashSet[int]
[void]$want.Add(${rootPid})
for ($i=0; $i -lt 6; $i++) { foreach ($p in $all) { if ($want.Contains([int]$p.ParentProcessId)) { [void]$want.Add([int]$p.ProcessId) } } }
$out = foreach ($id in $want) { $p = $map[[int]$id]; if ($p) { [pscustomobject]@{ pid=$p.ProcessId; name=$p.Name; cmd=($p.CommandLine -replace '"','' ) } } }
$out | ConvertTo-Json -Compress -Depth 3`
  try {
    const raw = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 << 20
    }).trim()
    if (!raw) return []
    const arr = JSON.parse(raw)
    const list = Array.isArray(arr) ? arr : [arr]
    // 언어 서버로 보이는 것만 태그한다 — 나머지는 앱/웹뷰 프로세스
    return list.map((p) => ({
      pid: p.pid,
      name: p.name,
      lsp: /typescript-language-server|tsserver|pyright|Microsoft\.CodeAnalysis|clangd|verse-lsp/i.test(p.cmd || '')
        ? (/tsserver/i.test(p.cmd) ? 'tsserver' : /typescript-language-server/i.test(p.cmd) ? 'ts-ls'
          : /pyright/i.test(p.cmd) ? 'pyright' : /clangd/i.test(p.cmd) ? 'clangd'
          : /Microsoft\.CodeAnalysis/i.test(p.cmd) ? 'roslyn' : 'verse')
        : null
    }))
  } catch {
    return []
  }
}

// ── exe 스냅샷 (다른 빌더의 재빌드에 안 흔들리게) ─────────────────────────────
// `--exe <경로>`를 주면 그 파일을 스냅샷한다 — 4명이 동시에 커밋하는 라운드에서
// **공용 `target/release`를 안 건드리고** 자기 타깃 폴더로 빌드해 재기 위한 문이다.
async function snapshotExe() {
  const src = EXE_ARG ? path.resolve(EXE_ARG) : path.join(REPO, 'target', 'release', 'agentcodegui.exe')
  const dir = path.join(os.tmpdir(), 'ccg-lsp-exe')
  fs.mkdirSync(dir, { recursive: true })
  const dst = path.join(dir, 'agentcodegui.exe')
  for (let i = 0; i < 80; i++) {
    try {
      fs.copyFileSync(src, dst)
      return dst
    } catch {
      if (i === 0) console.log(`[lsp] ${src} 없음 — 재빌드 대기`)
      await sleep(5000)
    }
  }
  throw new Error('exe 스냅샷 실패')
}

// ── 앱 한 번 띄우고 CDP 붙이기 ────────────────────────────────────────────────
async function boot(kind, home, exe, fix, extraEnv = {}) {
  const port = kind === 'tauri' ? 9372 : 9371
  const profile = kind === 'tauri' ? tauriProfile({ port, exe }) : electronProfile({ port })
  const child = spawn(profile.cmd, profile.args, {
    env: { ...process.env, ...profile.env, CCG_HOME: home, ...extraEnv },
    cwd: profile.cwd,
    stdio: 'ignore'
  })
  const cdp = await connectMainPage(port, { timeoutMs: 90000 })
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  const source = bootProbe(WORK, fix.bigRel)
  // ① 앞으로 만들어질 모든 문서에 (3.0의 재항해를 잡는다)
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source }).catch(() => {})
  // ② 지금 문서에도 (이미 로드가 끝난 경우 — 2.6.2가 보통 이쪽)
  await cdp.eval(source).catch(() => {})
  const { windowId } = await cdp.send('Browser.getWindowForTarget').catch(() => ({}))
  if (windowId) await cdp.send('Browser.setWindowBounds', { windowId, bounds: { ...VIEW, windowState: 'normal' } }).catch(() => {})
  /** 프로브가 살아 있는지 확인하고, 문서가 갈려 사라졌으면 다시 심는다. */
  const heal = async () => {
    const alive = await cdp.eval(`!!(window.__lsp && window.__lsp.started)`).catch(() => false)
    if (!alive) await cdp.eval(source).catch(() => {})
    return alive
  }
  return { child, cdp, profile, port, heal }
}

async function waitMount(cdp, profile, budget = 90000) {
  const t0 = Date.now()
  while (Date.now() - t0 < budget) {
    if (await cdp.eval(profile.mountExpr).catch(() => false)) return true
    await sleep(60)
  }
  return false
}

// ── 실행 1회분 ────────────────────────────────────────────────────────────────
async function runOnce(kind, { fix, exe, fresh, phase, extraEnv }) {
  const version = kind === 'tauri' ? '3.0.0-beta.1' : '2.6.2'
  const home = makeHome(kind, version, fresh)
  const { child, cdp, profile, heal } = await boot(kind, home, exe, fix, extraEnv)
  const S = (v) => JSON.stringify(v)
  const out = { phase, home, pid: child.pid }
  try {
    out.mounted = await waitMount(cdp, profile)
    // 문서가 갈렸으면 여기서 드러난다 — 프로브가 살아 있어야 아래 측정이 성립한다
    out.probeSurvived = await heal()
    if (!out.probeSurvived) await sleep(500)

    // ── ① prewarm 완료 (= status 'ready') + 그동안의 프레임 ────────────────
    const readyBudget = 180000
    const t0 = Date.now()
    let ready = await cdp.eval(`window.__lsp.readyInfo()`)
    while (ready.readyAt == null && Date.now() - t0 < readyBudget) {
      await sleep(200)
      ready = await cdp.eval(`window.__lsp.readyInfo()`)
    }
    out.ready = ready
    out.prewarmMs = ready.readyAt // navigationStart 기준 — 앱이 스스로 부른 prewarm 포함
    out.prewarmFromProbeMs = ready.readyAt == null ? null : ready.readyAt - ready.watchStart

    if (ready.readyAt == null) {
      out.fps = await cdp.eval(`window.__lsp.fpsStop()`)
      out.error = `status가 ${readyBudget}ms 안에 ready가 안 됨 (관측된 상태: ${JSON.stringify(ready.states)})`
      out.procs = serverProcs(child.pid)
      return out
    }

    // ── ② 첫 색칠 — 문서 시작에 걸어 둔 경주의 결과를 거둔다 ────────────────
    let paint = await cdp.eval(`window.__lsp.paintInfo()`)
    const paintT0 = Date.now()
    while (paint.liveAtMs == null && Date.now() - paintT0 < 120000) {
      await sleep(150)
      paint = await cdp.eval(`window.__lsp.paintInfo()`)
    }
    out.paint = paint

    // ── ③ 시맨틱 토큰 왕복 비용(서버가 이미 이 문서를 아는 상태) ────────────
    // ②와 다른 눈금이다: ②는 "열고 나서 처음 색이 오기까지", ③은 "이미 아는 문서를
    // 다시 물었을 때의 왕복". 둘을 같은 칸에 적으면 무엇이 좋아졌는지 못 읽는다.
    out.liveTokens = await cdp.eval(`window.__lsp.liveTokens(${S(WORK)}, ${S(fix.bigRel)}, 90000)`, {
      awaitPromise: true, timeoutMs: 100000
    })

    // ── ④ 캐시 경로 비용(첫 호출 + p50) ─────────────────────────────────────
    out.cached = await cdp.eval(`window.__lsp.cachedTokens(${S(WORK)}, ${S(fix.bigRel)}, 5)`, { awaitPromise: true })

    // 프레임 샘플러는 **여기서** 멈춘다 — "서버 기동 + 첫 색칠"이 끝나는 순간까지가
    // 사용자가 앱을 쓰면서 인덱싱을 기다리는 구간이다. ready까지만 재면 창이 0.5초라
    // 표본이 서너 프레임뿐이라 판정이 불가능하다(첫 실행에서 실제로 밟은 함정).
    // 최소 2초는 채운다 — 토큰이 너무 빨리 와도 프레임 표본이 남게.
    const warmupSpan = 2000 - (Date.now() - t0)
    if (warmupSpan > 0) await sleep(warmupSpan)
    out.fps = await cdp.eval(`window.__lsp.fpsStop()`)
    out.fps.window = '문서 시작 → 첫 색칠+토큰 왕복+캐시 표본 (최소 2s)'

    if (phase === 'cold') {
      // ── ④ 호버 ──────────────────────────────────────────────────────────────
      const hoverRows = await cdp.eval(`window.__lsp.sample('hover', ${S(WORK)}, ${S(fix.bigRel)}, ${S(fix.hoverAt)})`, {
        awaitPromise: true, timeoutMs: 180000
      })
      out.hover = { ...stat(hoverRows), rows: hoverRows }

      // ── ⑤ 정의 이동 ─────────────────────────────────────────────────────────
      const defRows = await cdp.eval(`window.__lsp.sample('def', ${S(WORK)}, ${S(fix.bigRel)}, ${S(fix.defAt)})`, {
        awaitPromise: true, timeoutMs: 180000
      })
      const crossFile = defRows.filter((r) => r.kind === 'cross-file' && r.ok && /lib\.ts$/i.test(r.meta || ''))
      out.definition = { ...stat(defRows), crossFileHits: crossFile.length, rows: defRows }

      // ── ⑥ 자동완성 첫 후보 ──────────────────────────────────────────────────
      const bigText = fs.readFileSync(path.join(WORK, fix.bigRel), 'utf8')
      const probe = fix.completionProbe(bigText)
      const complRows = await cdp.eval(
        `window.__lsp.completion(${S(WORK)}, ${S(fix.bigRel)}, ${S(probe.text)}, ${S(probe.pos)}, 10)`,
        { awaitPromise: true, timeoutMs: 180000 }
      )
      out.completion = { ...stat(complRows), items: pct(complRows.map((r) => r.items), 0.5), rows: complRows }

      // ── ⑦ 파일 변경 → 토큰 재정확화 ────────────────────────────────────────
      // 디스크에서 새 export 심볼을 심고, 토큰이 **그 줄을** 담을 때까지 잰다.
      const abs = path.join(WORK, fix.bigRel)
      const before = fs.readFileSync(abs, 'utf8')
      const edited = fix.edit(before, 1)
      const newLine = edited.split('\n').findIndex((l) => l.includes(fix.editedMarker(1)))
      fs.writeFileSync(abs, edited)
      out.retokenize = await cdp.eval(`window.__lsp.tokensCover(${S(WORK)}, ${S(fix.bigRel)}, ${newLine}, 60000)`, {
        awaitPromise: true, timeoutMs: 70000
      })
      out.retokenize.line = newLine
      fs.writeFileSync(abs, before) // 되돌린다 — 다음(warm) 실행이 같은 파일을 봐야 캐시가 맞다

      // ── ⑦-b 대조군: 아무 일도 없을 때의 프레임 ────────────────────────────
      // 워밍 구간의 fps만 보면 "낮다=인덱싱이 UI를 먹었다"인지 "창이 가려져 rAF가
      // 스로틀됐다"인지 못 가른다(동시 주행 중엔 남의 창이 앞에 올 수 있다).
      // 조용한 3초를 같은 방법으로 재서 대조군을 남긴다.
      await cdp.eval(`window.__lsp.fpsStart()`)
      await sleep(3000)
      out.fpsIdle = await cdp.eval(`window.__lsp.fpsStop()`)
      out.fpsIdle.window = 'idle 3s (대조군)'

      // ── ⑧ 서버 프로세스 목록 (메모리는 안 잰다) ────────────────────────────
      out.procs = serverProcs(child.pid)

      // ── ⑨ 뷰어 실화면 실증 ─────────────────────────────────────────────────
      if (!NO_VIEWER) out.viewer = await viewerProof(cdp, kind, fix)
    } else {
      out.procs = serverProcs(child.pid)
    }
    return out
  } finally {
    try { cdp.close() } catch { /* closed */ }
    killTree(child.pid)
    await sleep(1500)
  }
}

// ── 뷰어 실증 — 호버 카드/정의 이동/완성이 **화면에** 뜨는가 ──────────────────
async function viewerProof(cdp, kind, fix) {
  const shotDir = path.join(REPO, 'bench', 'shots', `lsp-${kind}`)
  fs.mkdirSync(shotDir, { recursive: true })
  const shot = async (id) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null)
    if (r?.data) fs.writeFileSync(path.join(shotDir, `${id}.png`), Buffer.from(r.data, 'base64'))
  }
  await cdp.eval(HELPERS_JS)
  const ctx = makeCtx(cdp)
  const checks = []
  const check = async (id, fn) => {
    const t0 = Date.now()
    try {
      const detail = await fn()
      checks.push({ id, ok: true, ms: Date.now() - t0, detail })
      console.log(`    [ok]   ${id} — ${JSON.stringify(detail)}`)
    } catch (e) {
      checks.push({ id, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e) })
      console.log(`    [FAIL] ${id} — ${e?.message ?? e}`)
    }
  }

  await check('viewer-open', async () => {
    await ctx.openFile('big.ts')
    const lines = await ctx.count('.fv-body .cm-line')
    if (lines < 5) throw new Error(`본문 줄이 ${lines}개뿐`)
    return { lines }
  })

  // 시맨틱 색: 서버 토큰이 칠해지면 .cm-line 안에 sem-* 클래스가 생긴다
  await check('viewer-semantic-paint', async () => {
    const t0 = Date.now()
    for (;;) {
      const n = await cdp.eval(`document.querySelectorAll('.fv-body [class*="sem-"]').length`).catch(() => 0)
      if (n > 20) return { semSpans: n, waitMs: Date.now() - t0 }
      if (Date.now() - t0 > 60000) throw new Error(`60s 안에 시맨틱 스팬이 안 뜸 (n=${n})`)
      await sleep(400)
    }
  })
  await shot('01-semantic')

  // 호버 카드 — 첫 makeConfig 토큰 위로 진짜 마우스를 올린다
  await check('viewer-hover-card', async () => {
    const at = await cdp.eval(`(() => {
      const els = [...document.querySelectorAll('.fv-body .cm-line span')]
      const e = els.find((s) => s.textContent === 'makeConfig')
      if (!e) return null
      const b = e.getBoundingClientRect()
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), text: e.textContent }
    })()`)
    if (!at) throw new Error('makeConfig 토큰을 화면에서 못 찾음')
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x - 6, y: at.y, button: 'none', buttons: 0 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, button: 'none', buttons: 0 })
    const t0 = Date.now()
    for (;;) {
      const card = await cdp.eval(`(() => {
        const c = document.querySelector('.lsp-hover')
        return c ? { text: (c.innerText || '').slice(0, 160) } : null
      })()`).catch(() => null)
      if (card?.text?.trim()) return { waitMs: Date.now() - t0, card: card.text.replace(/\s+/g, ' ').slice(0, 120) }
      if (Date.now() - t0 > 15000) throw new Error('15s 안에 .lsp-hover 카드가 안 뜸')
      await sleep(200)
    }
  })
  await shot('02-hover')

  // 정의 이동 — Ctrl+클릭으로 lib.ts로 넘어가는가
  await check('viewer-goto-definition', async () => {
    const at = await cdp.eval(`(() => {
      const els = [...document.querySelectorAll('.fv-body .cm-line span')]
      const e = els.find((s) => s.textContent === 'makeConfig')
      if (!e) return null
      const b = e.getBoundingClientRect()
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }
    })()`)
    if (!at) throw new Error('makeConfig 토큰 없음')
    const before = await cdp.eval(`(document.querySelector('.fv-name')?.innerText ?? '')`)
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {
        type, x: at.x, y: at.y, button: type === 'mouseMoved' ? 'none' : 'left',
        buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1, modifiers: 2 // Ctrl
      })
    }
    const t0 = Date.now()
    for (;;) {
      const title = await cdp.eval(`(document.querySelector('.fv-name')?.innerText ?? '')`)
      if (/lib\.ts/.test(title)) return { waitMs: Date.now() - t0, from: before, title }
      if (Date.now() - t0 > 15000) throw new Error(`15s 안에 lib.ts로 안 넘어감 (before=${JSON.stringify(before)}, now=${JSON.stringify(title)})`)
      await sleep(250)
    }
  })
  await shot('03-definition')

  // 자동완성 팝업 — 편집 모드(Ctrl+E)로 바꾸고 `registry.`를 친다
  await check('viewer-completion-popup', async () => {
    await ctx.esc(1)
    await sleep(300)
    await ctx.openFile('big.ts')
    await sleep(600)
    await cdp.eval(`(() => { const c = document.querySelector('.fv-body .cm-content'); if (c) c.focus(); return true })()`)
    await ctx.key('e', { ctrl: true }) // read → edit
    await sleep(700)
    const editable = await cdp.eval(`document.querySelector('.fv-body .cm-content')?.getAttribute('contenteditable')`)
    if (editable !== 'true') throw new Error(`편집 모드 전환 실패 (contenteditable=${editable})`)
    // 파일 끝(Ctrl+End)으로 가서 새 줄에 `registry.` 를 친다.
    // ctx.key의 VK 테이블에 End/'.'가 없어 잘못된 가상키(46=Delete)가 실려 나간다 —
    // End는 CDP로 직접, 본문은 Input.insertText(가상키 없는 텍스트 입력)로 넣는다.
    // CM6는 insertText가 만드는 beforeinput/input을 `input.type` 사용자 이벤트로 보므로
    // activateOnTyping 완성이 그대로 발동한다.
    const endKey = { key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: 2 }
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...endKey })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...endKey })
    await sleep(200)
    await cdp.send('Input.insertText', { text: '\nregistry.' })
    const t0 = Date.now()
    for (;;) {
      const opts = await cdp.eval(`(() => {
        const l = document.querySelectorAll('.cm-tooltip-autocomplete li')
        return { n: l.length, first: [...l].slice(0, 5).map((e) => e.innerText.trim().slice(0, 24)) }
      })()`).catch(() => ({ n: 0, first: [] }))
      if (opts.n > 0) return { waitMs: Date.now() - t0, options: opts.n, first: opts.first }
      if (Date.now() - t0 > 15000) throw new Error('15s 안에 완성 팝업이 안 뜸')
      await sleep(250)
    }
  })
  await shot('04-completion')

  return { checks, shots: shotDir, pass: checks.filter((c) => c.ok).length, total: checks.length }
}

// ── 유휴 회수 프로브 (3.0 전용 — TTL 주입) ────────────────────────────────────
async function idleReclaimProbe(kind, fix, exe) {
  if (kind !== 'tauri') {
    return {
      supported: false,
      note: '2.6.2에는 TTL 주입 스위치가 없다 — 상수(IDLE_TTL_LIGHT=10분 / IDLE_TTL_HEAVY=30분, ' +
        'src/main/lsp/manager.ts:527-529)와 sweep 주기(60초) 코드 확인만. 실측은 3.0에서.'
    }
  }
  const version = '3.0.0-beta.1'
  const home = makeHome(kind, version, false)
  const { child, cdp, profile, heal } = await boot(kind, home, exe, fix, {
    CCG_LSP_IDLE_TTL_MS: '6000',
    CCG_LSP_SWEEP_MS: '1000'
  })
  const S = (v) => JSON.stringify(v)
  try {
    await waitMount(cdp, profile)
    await heal()
    const t0 = Date.now()
    let info = await cdp.eval(`window.__lsp.readyInfo()`)
    while (info.readyAt == null && Date.now() - t0 < 120000) { await sleep(200); info = await cdp.eval(`window.__lsp.readyInfo()`) }
    if (info.readyAt == null) return { supported: true, error: 'ready 안 됨' }
    const alive = serverProcs(child.pid).filter((p) => p.lsp)
    // TTL(6s) + sweep(1s) 여유 — 12초 조용히 둔다
    await sleep(12000)
    const after = serverProcs(child.pid).filter((p) => p.lsp)
    // 회수 뒤 다시 요청 → 되살아나는가 + 얼마나 걸리는가
    const back = await cdp.eval(`window.__lsp.liveTokens(${S(WORK)}, ${S(fix.bigRel)}, 60000)`, { awaitPromise: true, timeoutMs: 70000 })
    const revived = serverProcs(child.pid).filter((p) => p.lsp)
    return {
      supported: true,
      ttlMs: 6000,
      beforeIdle: alive.map((p) => ({ pid: p.pid, kind: p.lsp })),
      afterIdle: after.map((p) => ({ pid: p.pid, kind: p.lsp })),
      reclaimed: alive.length > 0 && after.length === 0,
      respawnMs: back.ms,
      afterRespawn: revived.map((p) => ({ pid: p.pid, kind: p.lsp })),
      respawnedNewPid: revived.length > 0 && !revived.some((r) => alive.some((a) => a.pid === r.pid))
    }
  } finally {
    try { cdp.close() } catch { /* closed */ }
    killTree(child.pid)
    await sleep(1200)
  }
}

// ── 한 앱 전부 ────────────────────────────────────────────────────────────────
async function run(kind, fix, exe) {
  console.log(`\n[lsp] ── ${kind} ─────────────────────────────────────────────`)
  console.log('[lsp]   ① 콜드(빈 홈 = 토큰 캐시 없음)')
  const cold = await runOnce(kind, { fix, exe, fresh: true, phase: 'cold' })
  console.log(
    `[lsp]     ready=${cold.prewarmMs}ms 첫색칠=${cold.paint?.liveAtMs}ms(토큰 ${cold.paint?.liveN}) ` +
      `왕복=${cold.liveTokens?.ms}ms fps=${cold.fps?.fps}/${cold.fpsIdle?.fps} (long=${cold.fps?.longFrames})`
  )
  if (cold.error) console.log(`[lsp]     !! ${cold.error}`)
  console.log('[lsp]   ② 웜(같은 홈 = 토큰 디스크 캐시 적중)')
  const warm = await runOnce(kind, { fix, exe, fresh: false, phase: 'warm' })
  console.log(
    `[lsp]     첫색칠(캐시)=${warm.paint?.cacheAtMs}ms hit=${warm.paint?.cacheHit} ` +
      `캐시호출 첫/p50=${warm.cached?.ms}/${warm.cached?.p50}ms ready=${warm.prewarmMs}ms`
  )
  console.log('[lsp]   ③ 유휴 회수')
  const idle = await idleReclaimProbe(kind, fix, exe).catch((e) => ({ supported: kind === 'tauri', error: String(e?.message ?? e) }))
  console.log(`[lsp]     ${JSON.stringify(idle).slice(0, 200)}`)
  return { kind, cold, warm, idle }
}

// ── main ──────────────────────────────────────────────────────────────────────
const fix = makeWorkRepo()
console.log(`[lsp] 픽스처 ${LANG}: ${fix.bigRel} ${fix.bigLines}줄 / ${fix.bigBytes}B · 호버표본 ${fix.hoverAt.length} · 정의표본 ${fix.defAt.length}`)
console.log(`[lsp] 작업 폴더: ${WORK}`)

const EXE = KINDS.includes('tauri') ? await snapshotExe() : null
const results = []
for (const kind of KINDS) {
  const r = await run(kind, fix, EXE)
  const version = kind === 'tauri' ? '3.0.0' : '2.6.2'
  const file = path.join(REPO, 'bench', 'results', `lsp-${kind}-${version}${OUT_SUFFIX}.json`)
  const payload = {
    harness: 'bench/lsp.mjs',
    at: new Date().toISOString(),
    kind,
    version,
    lang: LANG,
    fixture: {
      work: WORK, bigRel: fix.bigRel, libRel: fix.libRel,
      lines: fix.bigLines, bytes: fix.bigBytes,
      hoverSamples: fix.hoverAt.length, defSamples: fix.defAt.length
    },
    env: envInfo(),
    note: '메모리는 재지 않는다(동시 주행 노이즈 — 리드가 procs의 PID로 따로 잰다).',
    ...r
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(payload, null, 2))
  console.log(`[lsp] → ${file}`)
  results.push(payload)
}

// ── 비교표 ────────────────────────────────────────────────────────────────────
if (results.length) {
  // 모든 '첫 …' 수치는 **문서 시작(navigationStart) 기준**이라 두 앱에서 같은 사건에 붙는다.
  const row = (r) => ({
    앱: `${r.kind} ${r.version}`,
    'prewarm ready ms': r.cold.prewarmMs ?? '—',
    '첫 색칠(캐시미스) ms': r.cold.paint?.liveAtMs ?? '—',
    '첫 색칠(캐시적중) ms': r.warm.paint?.cacheAtMs ?? '—',
    '캐시적중': r.warm.paint?.cacheHit ?? '—',
    '토큰 왕복 ms': r.cold.liveTokens?.ms ?? '—',
    '캐시호출 첫/p50': `${r.warm.cached?.ms ?? '—'}/${r.warm.cached?.p50 ?? '—'}`,
    'hover p50/p95': `${r.cold.hover?.p50 ?? '—'}/${r.cold.hover?.p95 ?? '—'}`,
    'def p50/p95': `${r.cold.definition?.p50 ?? '—'}/${r.cold.definition?.p95 ?? '—'}`,
    'compl p50/p95': `${r.cold.completion?.p50 ?? '—'}/${r.cold.completion?.p95 ?? '—'}`,
    '재정확화 ms': r.cold.retokenize?.ms ?? '—',
    'fps 워밍/유휴': `${r.cold.fps?.fps ?? '—'}/${r.cold.fpsIdle?.fps ?? '—'}`,
    '긴프레임': r.cold.fps?.longFrames ?? '—',
    '뷰어 실증': r.cold.viewer ? `${r.cold.viewer.pass}/${r.cold.viewer.total}` : '—',
    '유휴회수': r.idle?.reclaimed === true ? `회수+재기동 ${r.idle.respawnMs}ms` : r.idle?.supported === false ? '주입불가' : '—'
  })
  console.log('\n[lsp] ── 비교표 ─────────────────────────────────────────────')
  console.table(results.map(row))
}

if (!KEEP) {
  // 작업 폴더는 남긴다(다음 실행이 클론을 재사용 — 클론은 몇 초 걸린다). 홈만 정리.
  for (const kind of KINDS) {
    try { fs.rmSync(path.join(os.tmpdir(), `ccg-lsp-home-${kind}`), { recursive: true, force: true }) } catch { /* 잠김 */ }
  }
}
