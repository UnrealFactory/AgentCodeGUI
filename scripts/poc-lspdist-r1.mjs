#!/usr/bin/env node
/**
 * `poc-lspdist-r1` — **배포본에서 TS·Python LSP가 cwd와 무관하게 뜨는가**를 재는 PoC.
 *
 * ── 무엇을 재는가 ───────────────────────────────────────────────────────────
 * R28j 수정 R1 §1.4-b · 확인 크리틱 R2 F1이 남긴 결함(§1.6-A2 · 미결 F):
 * `crates/ccg-lsp/src/launch.rs::shipped_module()`이 **exe 폴더 사슬 ∪ 프로세스 cwd 사슬**을
 * 훑는 바람에, 같은 exe·같은 설치 자리인데 **프로세스 cwd**가 코드 인텔리전스의 유무를
 * 갈랐다(유휴 WS 0.627 ↔ 0.839). 이 PoC는 네 팔로 그 결함이 죽었는지 본다:
 *
 * | 팔 | exe 자리 | 번들(node_modules) | 프로세스 cwd | 기대 |
 * |---|---|---|---|---|
 * | `bundled/install-cwd` | 배포 모사 폴더 | **있다** | 설치 폴더 | **뜬다** |
 * | `bundled/project-cwd` | 같은 자리 | **있다** | 레포 안 프로젝트 | **뜬다 · 위와 동일** |
 * | `bare/install-cwd` | 번들 없는 모사 폴더 | 없다 | 설치 폴더 | 안 뜬다 |
 * | `bare/project-cwd` | 같은 자리 | 없다 | **레포 안 프로젝트** | **안 뜬다** ← 여기가 핵심 |
 *
 * 마지막 팔이 이 라운드의 피감수다. 고치기 전에는 **떴다**(cwd 조상에 레포의 `node_modules`가
 * 있으니까). 지금 떠 버리면 cwd 사슬이 살아 있다는 뜻이고, 0.627/0.839 띠도 같이 살아 있다.
 *
 * ── 왜 앱이 아니라 프로브인가 ───────────────────────────────────────────────
 * `ccg-lspprobe`는 셸 없이 크레이트를 실물 서버에 붙이는 프로브다(`--features cli`).
 * 해석 사슬은 **exe 경로와 cwd**의 함수라 프로브 exe를 배포 모사 자리에 두면 앱과
 * 정확히 같은 판정을 탄다. 그리고 이 프로브는 **어느 파일을 물었는지**(`resolve.modules`)를
 * 찍는다 — 두 팔이 "둘 다 성공"만으로는 같은 판을 물었다는 증명이 안 되기 때문이다.
 * 앱 층(헬퍼 프로세스 수 · 유휴 WS)은 `bench/multi.mjs --tag=lspdist`가 따로 잰다.
 *
 * ── 함정(전부 실제 사고) ────────────────────────────────────────────────────
 *  · 사용자 실앱이 떠 있다 → **이름 기반 kill 금지.** 여기서는 프로브를 `spawnSync`로
 *    돌리고 프로브가 `dispose_all()`로 자기 자식만 걷는다(잡 객체 안전망도 그대로).
 *  · 실홈 무접촉 → 모든 팔이 `CCG_HOME`을 격리 홈으로 들고 돈다(`quietHome`).
 *  · 배포 모사 자리는 **조상에 `node_modules`가 없어야** 의미가 있다 — 만들기 전에 확인한다.
 *
 * 사용:
 *   node scripts/poc-lspdist-r1.mjs [--skip-build] [--out=bench/results/poc-lspdist-r1.json]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
/** 공용 `target/`을 오염시키지 않는다(다른 갈래가 같은 워크트리에서 돈다). */
const TARGET = path.join(REPO, 'target-lspdist')
const SCRATCH = path.join(TARGET, 'poc-lspdist')
const argv = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=')
const SKIP_BUILD = process.argv.includes('--skip-build')
const OUT = path.resolve(REPO, argv('out', 'bench/results/poc-lspdist-r1.json'))

const log = (...a) => console.log(...a)
const fail = []
const check = (ok, what) => {
  log(`${ok ? '  ✓' : '  ✖'} ${what}`)
  if (!ok) fail.push(what)
  return ok
}

// ── 0. 배포 모사 자리 ────────────────────────────────────────────────────────
// %LOCALAPPDATA% 아래 — 실제 설치 자리(`%LOCALAPPDATA%\AgentCodeGUI3`)와 **같은 조상**을
// 쓰는 것이 요점이다. 설치 폴더 자체는 절대 안 건드린다(이름을 갈라 둔다).
const LOCAL = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
const DIST = path.join(LOCAL, 'ccg-lspdist-r1', 'bundled')
const BARE = path.join(LOCAL, 'ccg-lspdist-r1', 'bare')

/** 이 폴더의 조상 사슬 어디에도 `node_modules`가 없는가 = 배포 모사가 성립하는가. */
function ancestorsWithNodeModules(dir) {
  const hits = []
  let cur = path.resolve(dir)
  for (;;) {
    if (fs.existsSync(path.join(cur, 'node_modules'))) hits.push(cur)
    const up = path.dirname(cur)
    if (up === cur) break
    cur = up
  }
  return hits
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
}

function copyTree(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.cpSync(src, dst, { recursive: true, force: true })
}

/** 파일 수 · 원바이트 · 4KiB 클러스터 슬랙까지 — 설치 폴더가 **실제로** 먹는 값. */
function treeStats(dir) {
  let files = 0
  let bytes = 0
  let onDisk = 0
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) {
        const s = fs.statSync(p)
        files += 1
        bytes += s.size
        onDisk += Math.ceil(s.size / 4096) * 4096 // NTFS 기본 클러스터
      }
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return { files, bytes, mb: +(bytes / 1048576).toFixed(2), onDiskMb: +(onDisk / 1048576).toFixed(2) }
}

// ── 1. 프로브 빌드 ───────────────────────────────────────────────────────────
// `--features cli`가 있어야 `[[bin]]`이 나온다. 앱 바이너리가 아니므로
// `custom-protocol`은 상관없다(그건 `src-tauri`의 피처다).
const PROBE = path.join(TARGET, 'release', 'ccg-lspprobe.exe')
function buildProbe() {
  if (SKIP_BUILD && fs.existsSync(PROBE)) return { built: false, path: PROBE }
  log('[1] ccg-lspprobe 빌드 (CARGO_TARGET_DIR=target-lspdist)')
  const r = spawnSync(
    'cargo',
    ['build', '--release', '-p', 'ccg-lsp', '--features', 'cli', '--bin', 'ccg-lspprobe'],
    { cwd: REPO, env: { ...process.env, CARGO_TARGET_DIR: TARGET }, stdio: 'inherit' }
  )
  if (r.status !== 0) throw new Error('프로브 빌드 실패')
  return { built: true, path: PROBE }
}

// ── 2. 설치기 적재물(payload) 찾기 ───────────────────────────────────────────
// **진실은 생성된 `installer.nsi`다.** tauri 번들러가 거기에
//   File /a "/oname=node_modules\…" "C:\…\node_modules\…"
// 를 한 줄씩 찍고 makensis가 그대로 굽는다 — 즉 이 줄들이 설치 폴더의 배치 그 자체다.
// `tauri.conf.json`의 지도를 우리가 다시 해석하면 **번들러의 해석과 어긋날 수 있고**,
// 그러면 PoC는 통과하는데 설치기는 다른 것을 나르는 최악의 조합이 된다.
// 번들을 아직 안 구웠을 때만 지도를 직접 따라간다(그 사실을 `source`에 남긴다).
const NSI_CANDIDATES = [
  path.join(REPO, 'src-tauri', 'target-lspdist', 'release', 'nsis'),
  path.join(TARGET, 'release', 'nsis')
]
function payloadFromNsi() {
  for (const base of NSI_CANDIDATES) {
    if (!fs.existsSync(base)) continue
    for (const arch of fs.readdirSync(base)) {
      const nsi = path.join(base, arch, 'installer.nsi')
      if (!fs.existsSync(nsi)) continue
      const re = /^\s*File \/a "\/oname=(node_modules\\[^"]+)" "([^"]+)"\s*$/
      const pairs = []
      for (const line of fs.readFileSync(nsi, 'utf8').split(/\r?\n/)) {
        const m = re.exec(line)
        if (m) pairs.push({ dest: m[1], src: m[2] })
      }
      if (pairs.length) return { source: `installer.nsi(${arch})`, nsi, pairs }
    }
  }
  return null
}

function stagePayload() {
  const out = path.join(SCRATCH, 'payload')
  rmrf(out)
  const fromNsi = payloadFromNsi()
  if (fromNsi) {
    for (const { src, dest } of fromNsi.pairs) {
      const to = path.join(out, dest)
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(src, to)
    }
    return { source: fromNsi.source, nsi: fromNsi.nsi, entries: fromNsi.pairs.length, dir: path.join(out, 'node_modules') }
  }
  const conf = JSON.parse(fs.readFileSync(path.join(REPO, 'src-tauri', 'tauri.conf.json'), 'utf8'))
  const res = conf.bundle?.resources ?? {}
  for (const [src, dest] of Object.entries(res)) {
    if (!dest.startsWith('node_modules/')) continue
    const from = path.resolve(REPO, 'src-tauri', src)
    if (!fs.existsSync(from)) throw new Error(`설치기 지도가 없는 자리를 가리킨다: ${from}`)
    copyTree(from, path.join(out, dest))
  }
  return { source: 'tauri.conf.json(map · 번들 미생성)', entries: Object.keys(res).length, dir: path.join(out, 'node_modules') }
}

/** 설치기(.exe)와 그 서명 — 크기를 보고서에 그대로 싣는다. */
function installerInfo() {
  for (const base of [path.join(REPO, 'src-tauri', 'target-lspdist'), TARGET]) {
    const f = path.join(base, 'release', 'bundle', 'nsis')
    if (!fs.existsSync(f)) continue
    const exe = fs.readdirSync(f).find((n) => n.endsWith('-setup.exe'))
    if (exe) return { path: path.join(f, exe), bytes: fs.statSync(path.join(f, exe)).size }
  }
  return null
}

// ── 3. 픽스처 ────────────────────────────────────────────────────────────────
// **레포 안**에 만든다 — 그래야 `bare/project-cwd` 팔의 cwd 조상 사슬이 레포의
// `node_modules`에 닿는다(옛 코드가 그것을 물었다). 이 PoC의 핵심 유혹거리다.
async function makeFixtures() {
  const { FIXTURES } = await import('../bench/lspfix.mjs')
  const proj = path.join(SCRATCH, 'proj')
  fs.mkdirSync(proj, { recursive: true })
  const ts = FIXTURES.ts.make(proj, { blocks: 60 })
  const py = FIXTURES.py.make(proj, { blocks: 60 })
  return { proj, ts, py }
}

/** 언어별 프로브 환경 — `ccg_lspprobe.rs` 머리말의 표 그대로. */
const PROBE_ENV = {
  ts: {
    CCG_LSPPROBE_SYMS: 'makeConfig,summarize',
    CCG_LSPPROBE_CROSS: 'lib.ts',
    CCG_LSPPROBE_PRE: 'export function __probe(): unknown {',
    CCG_LSPPROBE_COMPL: '  return registry.',
    CCG_LSPPROBE_POST: '}',
    CCG_LSPPROBE_ANCHOR: '// EDIT-ANCHOR'
  },
  py: {
    CCG_LSPPROBE_SYMS: 'make_config,summarize',
    CCG_LSPPROBE_CROSS: 'lib.py',
    CCG_LSPPROBE_PRE: 'def __probe() -> object:',
    CCG_LSPPROBE_COMPL: '    return registry.',
    CCG_LSPPROBE_POST: '',
    CCG_LSPPROBE_ANCHOR: '# EDIT-ANCHOR'
  }
}

// ── 4. 한 팔 ─────────────────────────────────────────────────────────────────
function runArm({ exeDir, cwd, lang, rel, projRoot, home, samples = 8, scrubPath = false }) {
  const exe = path.join(exeDir, 'ccg-lspprobe.exe')
  const env = { ...process.env, ...PROBE_ENV[lang], CCG_HOME: home }
  // `CCG_LSP_MODULES`가 이 셸에 남아 있으면 팔 전체가 무의미해진다 — 명시적으로 지운다.
  delete env.CCG_LSP_MODULES
  delete env.CCG_LSP_NODE
  if (scrubPath) {
    // node가 PATH에 없는 컴퓨터 모사 — 남은 구멍을 **정직하게** 재는 자리.
    env.PATH = (env.PATH ?? '')
      .split(path.delimiter)
      .filter((d) => d && !fs.existsSync(path.join(d, 'node.exe')))
      .join(path.delimiter)
  }
  const t = Date.now()
  const r = spawnSync(exe, [projRoot, rel, String(samples)], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 300_000,
    windowsHide: true
  })
  const line = (r.stdout ?? '').trim().split('\n').filter(Boolean).pop()
  let json = null
  try {
    json = JSON.parse(line)
  } catch {
    /* 프로브가 아무 말도 못 하고 죽은 팔 — 아래에서 stderr로 드러난다 */
  }
  return {
    exitCode: r.status,
    wallMs: Date.now() - t,
    stderrTail: (r.stderr ?? '').trim().slice(-400) || null,
    probe: json
  }
}

// ── 5. 주행 ──────────────────────────────────────────────────────────────────
const out = {
  poc: 'lspdist-r1',
  at: new Date().toISOString(),
  repo: REPO,
  node: process.version
}

try {
  log('[0] 배포 모사 자리 확인')
  for (const d of [DIST, BARE]) {
    rmrf(d)
    fs.mkdirSync(d, { recursive: true })
  }
  const distAnc = ancestorsWithNodeModules(DIST)
  const bareAnc = ancestorsWithNodeModules(BARE)
  out.deploySim = { dist: DIST, bare: BARE, ancestorsWithNodeModules: { dist: distAnc, bare: bareAnc } }
  check(distAnc.length === 0, `배포 모사 조상 사슬에 node_modules 없음 (${DIST})`)
  check(bareAnc.length === 0, `대조 모사 조상 사슬에 node_modules 없음 (${BARE})`)

  const probe = buildProbe()
  out.probe = { path: probe.path, rebuilt: probe.built, bytes: fs.statSync(probe.path).size }

  log('[2] 설치기 적재물')
  const payload = stagePayload()
  const pstat = treeStats(payload.dir)
  out.payload = { ...payload, ...pstat, installer: installerInfo() }
  log(`    ${payload.source}: ${pstat.files}개 파일 · ${pstat.mb}MB(원바이트) · ${pstat.onDiskMb}MB(4KiB 클러스터)`)
  if (out.payload.installer) log(`    설치기: ${(out.payload.installer.bytes / 1048576).toFixed(2)}MB`)
  check(pstat.files > 0, '적재물이 비어 있지 않다')
  check(payload.source.startsWith('installer.nsi'), '적재물의 출처가 생성된 installer.nsi다(번들러의 해석 그대로)')

  // 배포 모사 = exe 한 개 + 번들. 실제 설치 폴더의 배치와 같다($INSTDIR\node_modules\…).
  fs.copyFileSync(probe.path, path.join(DIST, 'ccg-lspprobe.exe'))
  copyTree(payload.dir, path.join(DIST, 'node_modules'))
  fs.copyFileSync(probe.path, path.join(BARE, 'ccg-lspprobe.exe')) // 번들 없음(대조군)

  log('[3] 픽스처')
  const fx = await makeFixtures()
  out.fixture = { proj: fx.proj, ts: fx.ts.bigRel, py: fx.py.bigRel, tsLines: fx.ts.bigLines, pyLines: fx.py.bigLines }
  const anc = ancestorsWithNodeModules(fx.proj)
  out.fixture.ancestorsWithNodeModules = anc
  check(anc.includes(REPO), '픽스처의 cwd 조상 사슬이 레포 node_modules에 닿는다(= 옛 코드의 미끼가 살아 있다)')

  const HOMES = path.join(SCRATCH, 'homes')
  const { quietHome } = await import('../bench/lib.mjs')
  const homeFor = (name) => quietHome(path.join(HOMES, name))

  log('[4] 네 팔 × 두 언어')
  const arms = {}
  const plan = [
    ['bundled/install-cwd', DIST, DIST],
    ['bundled/project-cwd', DIST, fx.proj],
    ['bare/install-cwd', BARE, BARE],
    ['bare/project-cwd', BARE, fx.proj]
  ]
  for (const [name, exeDir, cwd] of plan) {
    for (const lang of ['ts', 'py']) {
      const key = `${name}|${lang}`
      const rel = lang === 'ts' ? fx.ts.bigRel : fx.py.bigRel
      const r = runArm({
        exeDir,
        cwd,
        lang,
        rel,
        projRoot: fx.proj,
        home: homeFor(`${name.replace(/[/]/g, '-')}-${lang}`)
      })
      arms[key] = r
      const p = r.probe ?? {}
      log(
        `    ${key.padEnd(28)} status=${String(p.status).padEnd(11)} hover=${p.hover?.hits ?? '-'}/${p.hover?.n ?? '-'} ` +
          `tokens=${p.tokens ?? '-'} (${r.wallMs}ms)`
      )
    }
  }
  out.arms = arms

  // ── 6. 판정 ────────────────────────────────────────────────────────────────
  log('[5] 판정')
  const P = (k) => arms[k]?.probe ?? {}
  for (const lang of ['ts', 'py']) {
    const a = P(`bundled/install-cwd|${lang}`)
    const b = P(`bundled/project-cwd|${lang}`)
    // ① 배포본에서 **뜬다** — cwd가 설치 폴더여도(= 시작 메뉴 실행)
    check(a.status === 'ready', `[${lang}] 배포 모사 · cwd=설치 폴더에서 ready`)
    // ② 실제 응답이 온다(뜨기만 하고 답을 안 하면 소용없다)
    check((a.hover?.hits ?? 0) > 0, `[${lang}] 호버 응답 ${a.hover?.hits ?? 0}/${a.hover?.n ?? 0}`)
    if (lang === 'ts') check((a.tokens ?? 0) > 0, `[ts] 시맨틱 토큰 ${a.tokens ?? 0}개`)
    else check(a.semanticSupported === false, '[py] pyright에 시맨틱 토큰이 없다(2.6.2와 같다)')
    // ③ ★ cwd가 결과를 안 가른다 — 상태도, **문 파일도** 같아야 한다
    check(a.status === b.status, `[${lang}] 두 cwd 팔의 status 동일 (${a.status} / ${b.status})`)
    check(
      JSON.stringify(a.resolve?.modules) === JSON.stringify(b.resolve?.modules),
      `[${lang}] 두 cwd 팔이 **같은 모듈 파일**을 문다`
    )
    check(
      (a.resolve?.modules?.[lang] ?? '').toLowerCase().startsWith(DIST.toLowerCase()),
      `[${lang}] 문 파일이 배포 모사 번들 안이다 (${a.resolve?.modules?.[lang] ?? 'null'})`
    )
    // ④ ★ 번들이 없으면 **cwd가 프로젝트여도** 안 뜬다 = cwd 사슬이 죽었다
    const c = P(`bare/install-cwd|${lang}`)
    const d = P(`bare/project-cwd|${lang}`)
    check(c.status !== 'ready', `[${lang}] 번들 없음 · cwd=설치 폴더 → 안 뜬다 (${c.status})`)
    check(
      d.status !== 'ready',
      `[${lang}] ★번들 없음 · cwd=프로젝트 → 안 뜬다 (${d.status}) — 고치기 전에는 여기서 떴다`
    )
    check(c.status === d.status, `[${lang}] 번들 없는 두 팔도 서로 동일 (${c.status} / ${d.status})`)
    check(
      (d.resolve?.modules?.[lang] ?? null) === null,
      `[${lang}] 번들 없는 팔은 아무것도 못 찾는다(cwd 조상의 레포 것을 안 문다)`
    )
  }

  // ── 6b. ★ 고치기 전에는 정말 떴는가 — **옛 트리로 구운 프로브**로 되짚는다 ──
  // "고치기 전에는 여기서 떴다"는 위 팔의 문구는 주장이지 실측이 아니다. 옛 코드가
  // 실제로 어떻게 갈렸는지는 옛 코드로 재야 한다:
  //   git archive HEAD | tar -x -C <tmp> && cargo build -p ccg-lsp --features cli --bin ccg-lspprobe
  // 같은 픽스처·같은 번들 없는 자리에 옛 프로브를 놓고 cwd만 두 개로 돌린다.
  const BEFORE = argv('before', path.join(TARGET, 'before-head', 'target', 'release', 'ccg-lspprobe.exe'))
  if (fs.existsSync(BEFORE)) {
    log('[6b] 옛 코드(HEAD)로 되짚기 — 번들 없는 자리, cwd만 다르게')
    const dir = path.join(LOCAL, 'ccg-lspdist-r1', 'before-bare')
    rmrf(dir)
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(BEFORE, path.join(dir, 'ccg-lspprobe.exe'))
    const before = {}
    for (const [name, cwd] of [
      ['install-cwd', dir],
      ['project-cwd', fx.proj]
    ]) {
      const r = runArm({
        exeDir: dir,
        cwd,
        lang: 'ts',
        rel: fx.ts.bigRel,
        projRoot: fx.proj,
        home: homeFor(`before-${name}`),
        samples: 4
      })
      before[name] = { status: r.probe?.status ?? null, hoverHits: r.probe?.hover?.hits ?? null, tokens: r.probe?.tokens ?? null }
      log(`    before/${name.padEnd(12)} status=${before[name].status} hover=${before[name].hoverHits} tokens=${before[name].tokens}`)
    }
    out.before = { exe: BEFORE, arms: before }
    // 이 두 줄이 §1.4-b의 0.627/0.839 띠 그 자체다.
    check(before['install-cwd'].status === 'error', '[before] cwd=설치 폴더 → 안 떴다(§1.4-b의 0.627 팔)')
    check(before['project-cwd'].status === 'ready', '[before] ★cwd=프로젝트 → **떴다**(§1.4-b의 0.839 팔) = 띠의 존재 실측')
    check(
      before['install-cwd'].status !== before['project-cwd'].status,
      '[before] 옛 코드에서는 cwd가 결과를 갈랐다 — 지금은 위 팔들이 전부 같다'
    )
  } else {
    log(`[6b] 건너뜀 — 옛 프로브가 없다(${BEFORE})`)
    out.before = { skipped: true, expected: BEFORE }
  }

  // ── 7. 남은 구멍을 **재서** 적는다 — PATH에 node가 없는 컴퓨터 ─────────────
  log('[6] 남은 구멍(PATH에 node 없음)')
  const noNode = runArm({
    exeDir: DIST,
    cwd: DIST,
    lang: 'ts',
    rel: fx.ts.bigRel,
    projRoot: fx.proj,
    home: homeFor('no-node-ts'),
    samples: 2,
    scrubPath: true
  })
  out.residual = {
    what: 'PATH에 node가 없는 컴퓨터 — 번들은 모듈만 싣고 런타임은 안 싣는다',
    status: noNode.probe?.status ?? null,
    resolvedNode: noNode.probe?.resolve?.node ?? null,
    modulesFound: noNode.probe?.resolve?.modules?.ts ?? null
  }
  log(`    status=${out.residual.status} · node=${out.residual.resolvedNode} · 모듈은 찾았나=${!!out.residual.modulesFound}`)
  check(!!out.residual.modulesFound, '[구멍] 모듈은 여전히 찾는다(런타임만 없다) — 진단이 정확하다')

  out.verdict = { failures: fail, ok: fail.length === 0 }
} catch (e) {
  out.error = String(e?.stack ?? e)
  fail.push(`예외: ${e?.message ?? e}`)
  out.verdict = { failures: fail, ok: false }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n')
log(`\n결과: ${OUT}`)
log(fail.length ? `✖ 실패 ${fail.length}건\n - ${fail.join('\n - ')}` : '✓ 전부 통과')
process.exit(fail.length ? 1 : 0)
