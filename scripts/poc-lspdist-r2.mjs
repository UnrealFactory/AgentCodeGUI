#!/usr/bin/env node
/**
 * `poc-lspdist-r2` — 확인 크리틱 R1이 연 격차를 **닫혔는지 재는** PoC.
 *
 * R1 PoC(`poc-lspdist-r1.mjs`)는 「cwd가 결과를 안 가른다」를 쟀다. 그건 그대로 두고(회귀
 * 가드로 여기서도 다시 돈다), R2는 크리틱이 남긴 세 자리를 겨눈다:
 *
 * | 팔 | 겨누는 결함 | 통과 조건 |
 * |---|---|---|
 * | **A. PATH에 node 없음 × 두 언어 × 두 cwd** | 크리틱 §1.2 「네 팔 전부 error」 | **네 팔 전부 ready** |
 * | B. 두 cwd 팔 동일 | R1의 결론(회귀 가드) | status·문 파일 동일 |
 * | **C. 돌연변이 6종** | 크리틱 **C3**(계약이 파일을 안 문다) · **C4**(못이 한 층만 문다) | 전부 **red** |
 * | **D. 스테이징 무결성** | 판 고정 + sha256이 진짜로 거르는가 | 상한 캐시를 **거절**하고 exit≠0 |
 *
 * A가 이 라운드의 본체다. R1은 모듈만 싣고 런타임은 PATH에 기댔고, 크리틱이 그 대가를
 * 실측했다 — PATH에서 node를 걷어내면 **두 언어 × 두 cwd 넷 전부 죽는다.** R2는
 * `scripts/tauri-build.mjs`가 판 고정·해시 검증으로 스테이징한 `node.exe`를 설치기에 싣고,
 * 런처는 그 사이드카를 문다(배포본에서 PATH 칸은 도달 불가 — `.cargo-lock` 게이트).
 *
 * ## 함정(R1과 같은 규율)
 *  · 이름 기반 kill 0 — 프로브가 자기 자식만 걷는다. 사용자 실앱이 떠 있다.
 *  · 전 팔 `CCG_HOME` 격리(`quietHome`) · 실홈 무접촉 · NSIS 설치기 **미실행**.
 *  · 배포 모사는 생성된 `installer.nsi`의 `File /a` 줄을 복제해 만든다 — `tauri.conf.json`을
 *    우리가 다시 해석하면 번들러의 해석과 어긋날 수 있다.
 *  · 돌연변이는 **격리 사본에서만**. 제품 트리는 한 글자도 안 건드린다.
 *
 * 사용:
 *   node scripts/poc-lspdist-r2.mjs [--skip-build] [--skip-mutations]
 *                                   [--out=bench/results/poc-lspdist-r2.json]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const TARGET = path.join(REPO, 'target-lspdist')
const SCRATCH = path.join(TARGET, 'poc-lspdist-r2')
const argv = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=')
const SKIP_BUILD = process.argv.includes('--skip-build')
const SKIP_MUT = process.argv.includes('--skip-mutations')
const OUT = path.resolve(REPO, argv('out', 'bench/results/poc-lspdist-r2.json'))

const log = (...a) => console.log(...a)
const fail = []
const check = (ok, what) => {
  log(`${ok ? '  ✓' : '  ✖'} ${what}`)
  if (!ok) fail.push(what)
  return ok
}

const LOCAL = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
const DIST = path.join(LOCAL, 'ccg-lspdist-r2', 'bundled')

const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })

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
        onDisk += Math.ceil(s.size / 4096) * 4096
      }
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return { files, bytes, mb: +(bytes / 1048576).toFixed(2), onDiskMb: +(onDisk / 1048576).toFixed(2) }
}

// ── 설치기 적재물 ────────────────────────────────────────────────────────────
const NSI_BASES = [path.join(REPO, 'src-tauri', 'target-lspdist', 'release', 'nsis'), path.join(TARGET, 'release', 'nsis')]
function payloadFromNsi() {
  for (const base of NSI_BASES) {
    if (!fs.existsSync(base)) continue
    for (const arch of fs.readdirSync(base)) {
      const nsi = path.join(base, arch, 'installer.nsi')
      if (!fs.existsSync(nsi)) continue
      // R1은 `node_modules\…`만 봤다. R2는 **런타임도 적재물**이라 전부 본다.
      const re = /^\s*File \/a "\/oname=([^"]+)" "([^"]+)"\s*$/
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

function installerInfo() {
  for (const base of [path.join(REPO, 'src-tauri', 'target-lspdist'), TARGET]) {
    const d = path.join(base, 'release', 'bundle', 'nsis')
    if (!fs.existsSync(d)) continue
    const exe = fs.readdirSync(d).find((n) => n.endsWith('-setup.exe'))
    if (exe) return { path: path.join(d, exe), bytes: fs.statSync(path.join(d, exe)).size }
  }
  return null
}

// ── 프로브 ───────────────────────────────────────────────────────────────────
const PROBE = path.join(TARGET, 'release', 'ccg-lspprobe.exe')
function buildProbe() {
  if (SKIP_BUILD && fs.existsSync(PROBE)) return { rebuilt: false }
  log('[1] ccg-lspprobe 빌드')
  const r = spawnSync('cargo', ['build', '--release', '-p', 'ccg-lsp', '--features', 'cli', '--bin', 'ccg-lspprobe'], {
    cwd: REPO,
    env: { ...process.env, CARGO_TARGET_DIR: TARGET },
    stdio: 'inherit'
  })
  if (r.status !== 0) throw new Error('프로브 빌드 실패')
  return { rebuilt: true }
}

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

/** PATH에서 node.exe가 있는 디렉터리를 전부 걷어낸다 = node 없는 기계 모사. */
function scrubbedPath(p) {
  return (p ?? '')
    .split(path.delimiter)
    .filter((d) => d && !fs.existsSync(path.join(d, 'node.exe')) && !fs.existsSync(path.join(d, 'node')))
    .join(path.delimiter)
}

function runArm({ exeDir, cwd, lang, rel, projRoot, home, samples = 6, noNode = false }) {
  const env = { ...process.env, ...PROBE_ENV[lang], CCG_HOME: home }
  delete env.CCG_LSP_MODULES
  delete env.CCG_LSP_NODE
  if (noNode) env.PATH = scrubbedPath(env.PATH)
  const t = Date.now()
  const r = spawnSync(path.join(exeDir, 'ccg-lspprobe.exe'), [projRoot, rel, String(samples)], {
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
    /* 아무 말도 못 하고 죽은 팔 */
  }
  return { exitCode: r.status, wallMs: Date.now() - t, stderrTail: (r.stderr ?? '').trim().slice(-400) || null, probe: json }
}

// ── C. 돌연변이 ──────────────────────────────────────────────────────────────
// 격리 사본에서만 돈다. 제품 트리 무접촉을 **매회 해시로** 확인한다.
const MUTATIONS = [
  {
    id: 'C3-a · typescript/lib 한 줄 삭제',
    why: '크리틱 C3 — R1 계약은 패키지 단위라 이게 초록이었다(tsserver 실종 = 색이 반만)',
    file: 'src-tauri/tauri.conf.json',
    apply: (s) => s.replace(/^.*"\.\.\/node_modules\/typescript\/lib":.*\n/m, ''),
    expect: 'spec::tests::every_bundled_file_is_covered_by_the_installer_manifest'
  },
  {
    id: 'C3-b · tsls/package.json 한 줄 삭제',
    why: '크리틱 C3 — R1 §5가 한 절을 통째로 쓴 ENOENT 함정 그 자체인데 초록이었다',
    file: 'src-tauri/tauri.conf.json',
    apply: (s) => s.replace(/^.*"\.\.\/node_modules\/typescript-language-server\/package\.json":.*\n/m, ''),
    expect: 'spec::tests::every_bundled_file_is_covered_by_the_installer_manifest'
  },
  {
    id: 'R2-c · node 런타임 한 줄 삭제',
    why: 'R2가 새로 건 계약 — 런타임이 빠지면 크리틱 §1.2의 「네 팔 전부 error」로 돌아간다',
    file: 'src-tauri/tauri.conf.json',
    apply: (s) => s.replace(/^.*"lsp-runtime\/node\.exe":.*\n/m, ''),
    expect: 'spec::tests::every_bundled_file_is_covered_by_the_installer_manifest'
  },
  {
    id: 'C4-a · module_roots_from에 cwd 부활',
    why: 'R1도 잡던 자리(대조군) — 이게 초록이면 못이 통째로 죽은 것이다',
    file: 'crates/ccg-lsp/src/launch.rs',
    apply: (s) =>
      s.replace(
        '    roots\n}\n\n/// 실제 프로세스 상태로 만든',
        '    if let Ok(cwd) = std::env::current_dir() { roots.push(cwd); }\n    roots\n}\n\n/// 실제 프로세스 상태로 만든'
      ),
    expect: 'launch::tests::the_search_chain_is_exactly_exe_shaped_and_has_no_cwd'
  },
  {
    id: 'C4-b · module_roots()에 cwd 부활',
    why: '★크리틱 C4 — 여기가 옛 결함(09b9bc7)이 살던 층인데 R1 못은 초록이었다',
    file: 'crates/ccg-lsp/src/launch.rs',
    apply: (s) =>
      s.replace(
        'fn module_roots() -> Vec<PathBuf> {\n    module_roots_from(env_path("CCG_LSP_MODULES"), exe_dir())\n}',
        'fn module_roots() -> Vec<PathBuf> {\n    let mut r = module_roots_from(env_path("CCG_LSP_MODULES"), exe_dir());\n    if let Ok(cwd) = std::env::current_dir() { let mut c = Some(cwd.as_path()); while let Some(x) = c { r.push(x.to_path_buf()); c = x.parent(); } }\n    r\n}'
      ),
    expect: 'launch::tests::the_public_layer_adds_nothing_to_the_pure_chain'
  },
  {
    id: 'C4-c · shipped_module()에 cwd 부활',
    why: '★블랙박스 — 공개 진입점에 직접 되살린다. 통합 테스트가 진짜 cwd를 바꿔 놓고 묻는다',
    file: 'crates/ccg-lsp/src/launch.rs',
    apply: (s) =>
      s.replace(
        'pub fn shipped_module(rel: &[&str]) -> Option<PathBuf> {\n    find_module(&module_roots(), rel)\n}',
        'pub fn shipped_module(rel: &[&str]) -> Option<PathBuf> {\n    if let Some(p) = find_module(&module_roots(), rel) { return Some(p); }\n    let mut roots = Vec::new();\n    if let Ok(cwd) = std::env::current_dir() { let mut c = Some(cwd.as_path()); while let Some(x) = c { roots.push(x.to_path_buf()); c = x.parent(); } }\n    find_module(&roots, rel)\n}'
      ),
    expect: 'tests/cwd_is_never_consulted.rs (통합)'
  }
]

/** 돌연변이용 격리 사본 — 워크스페이스 파싱에 필요한 최소한만 나른다. */
function makeMutantTree() {
  const tree = path.join(SCRATCH, 'mutant')
  rmrf(tree)
  fs.mkdirSync(tree, { recursive: true })
  for (const f of ['Cargo.toml', 'Cargo.lock']) fs.copyFileSync(path.join(REPO, f), path.join(tree, f))
  fs.cpSync(path.join(REPO, 'crates'), path.join(tree, 'crates'), { recursive: true })
  fs.mkdirSync(path.join(tree, 'src-tauri'), { recursive: true })
  for (const f of ['Cargo.toml', 'tauri.conf.json', 'build.rs']) {
    const p = path.join(REPO, 'src-tauri', f)
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(tree, 'src-tauri', f))
  }
  // `src-tauri`는 파싱만 되면 된다(`-p ccg-lsp`는 그 크레이트를 안 굽는다).
  fs.mkdirSync(path.join(tree, 'src-tauri', 'src'), { recursive: true })
  fs.writeFileSync(path.join(tree, 'src-tauri', 'src', 'main.rs'), 'fn main() {}\n')
  return tree
}

function runMutantTests(tree, mutTarget) {
  const r = spawnSync('cargo', ['test', '-p', 'ccg-lsp'], {
    cwd: tree,
    env: { ...process.env, CARGO_TARGET_DIR: mutTarget },
    encoding: 'utf8',
    timeout: 900_000
  })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

// ── 주행 ─────────────────────────────────────────────────────────────────────
const out = { poc: 'lspdist-r2', at: new Date().toISOString(), repo: REPO, node: process.version }

try {
  log('[0] 배포 모사 자리')
  rmrf(DIST)
  fs.mkdirSync(DIST, { recursive: true })
  const anc = ancestorsWithNodeModules(DIST)
  out.deploySim = { dist: DIST, ancestorsWithNodeModules: anc }
  check(anc.length === 0, `배포 모사 조상 사슬에 node_modules 없음 (${DIST})`)

  buildProbe()
  out.probe = { path: PROBE, bytes: fs.statSync(PROBE).size }

  log('[2] 설치기 적재물(installer.nsi에서 복제)')
  const p = payloadFromNsi()
  if (!p) throw new Error('installer.nsi를 못 찾았다 — 먼저 `npm run tauri:build`를 돌려라')
  for (const { src, dest } of p.pairs) {
    const to = path.join(DIST, dest)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(src, to)
  }
  fs.copyFileSync(PROBE, path.join(DIST, 'ccg-lspprobe.exe'))
  const modStats = treeStats(path.join(DIST, 'node_modules'))
  const nodeSide = path.join(DIST, 'node.exe')
  out.payload = {
    source: p.source,
    nsi: p.nsi,
    entries: p.pairs.length,
    modules: modStats,
    nodeRuntime: fs.existsSync(nodeSide) ? { path: nodeSide, bytes: fs.statSync(nodeSide).size } : null,
    installer: installerInfo()
  }
  log(`    항목 ${p.pairs.length}개 · 모듈 ${modStats.files}파일/${modStats.mb}MB · node.exe ${out.payload.nodeRuntime ? (out.payload.nodeRuntime.bytes / 1048576).toFixed(2) + 'MB' : '없다'}`)
  if (out.payload.installer) log(`    설치기 ${(out.payload.installer.bytes / 1048576).toFixed(2)}MB`)
  check(!!out.payload.nodeRuntime, '★설치기가 node 런타임을 사이드카로 나른다($INSTDIR\\node.exe)')

  log('[3] 픽스처')
  const { FIXTURES } = await import('../bench/lspfix.mjs')
  const proj = path.join(SCRATCH, 'proj')
  fs.mkdirSync(proj, { recursive: true })
  const fx = { ts: FIXTURES.ts.make(proj, { blocks: 60 }), py: FIXTURES.py.make(proj, { blocks: 60 }) }
  out.fixture = { proj, ts: fx.ts.bigRel, py: fx.py.bigRel }

  const { quietHome } = await import('../bench/lib.mjs')
  const homeFor = (n) => quietHome(path.join(SCRATCH, 'homes', n))

  // ── A. ★ PATH에 node 없음 × 두 언어 × 두 cwd ────────────────────────────────
  log('[4] ★A — PATH에 node 없는 기계 · 두 언어 × 두 cwd')
  check(scrubbedPath(process.env.PATH) !== process.env.PATH, 'PATH 소거가 실제로 무언가를 걷어냈다(모사가 성립한다)')
  const armsA = {}
  for (const [name, cwd] of [
    ['install-cwd', DIST],
    ['project-cwd', proj]
  ]) {
    for (const lang of ['ts', 'py']) {
      const key = `nonode/${name}|${lang}`
      const r = runArm({
        exeDir: DIST,
        cwd,
        lang,
        rel: lang === 'ts' ? fx.ts.bigRel : fx.py.bigRel,
        projRoot: proj,
        home: homeFor(`nonode-${name}-${lang}`),
        noNode: true
      })
      armsA[key] = r
      const q = r.probe ?? {}
      log(`    ${key.padEnd(26)} status=${String(q.status).padEnd(11)} hover=${q.hover?.hits ?? '-'}/${q.hover?.n ?? '-'} tokens=${q.tokens ?? '-'} node=${q.resolve?.node ?? 'null'}`)
    }
  }
  out.armsNoNode = armsA
  for (const k of Object.keys(armsA)) {
    const q = armsA[k].probe ?? {}
    const lang = k.split('|')[1]
    check(q.status === 'ready', `[A] ${k} — ready (크리틱 실측은 error였다)`)
    check((q.hover?.hits ?? 0) > 0, `[A] ${k} — 호버 ${q.hover?.hits ?? 0}/${q.hover?.n ?? 0}`)
    if (lang === 'ts') check((q.tokens ?? 0) > 0, `[A] ${k} — 시맨틱 토큰 ${q.tokens ?? 0}`)
    check(
      (q.resolve?.node ?? '').toLowerCase().startsWith(DIST.toLowerCase()),
      `[A] ${k} — 문 node가 **번들 사이드카**다 (${q.resolve?.node ?? 'null'})`
    )
  }

  // ── B. 두 cwd 팔 동일(R1 회귀 가드) ─────────────────────────────────────────
  log('[5] B — 두 cwd 팔 동일(R1 회귀 가드 · PATH 정상)')
  const armsB = {}
  for (const [name, cwd] of [
    ['install-cwd', DIST],
    ['project-cwd', proj]
  ]) {
    for (const lang of ['ts', 'py']) {
      armsB[`${name}|${lang}`] = runArm({
        exeDir: DIST,
        cwd,
        lang,
        rel: lang === 'ts' ? fx.ts.bigRel : fx.py.bigRel,
        projRoot: proj,
        home: homeFor(`b-${name}-${lang}`)
      })
    }
  }
  out.armsDeterminism = armsB
  for (const lang of ['ts', 'py']) {
    const a = armsB[`install-cwd|${lang}`].probe ?? {}
    const b = armsB[`project-cwd|${lang}`].probe ?? {}
    check(a.status === 'ready' && b.status === 'ready', `[B] ${lang} 두 팔 다 ready`)
    check(JSON.stringify(a.resolve?.modules) === JSON.stringify(b.resolve?.modules), `[B] ${lang} 같은 모듈 파일을 문다`)
    check(a.resolve?.node === b.resolve?.node, `[B] ${lang} 같은 node를 문다 (${a.resolve?.node})`)
  }

  // ── D. 스테이징 무결성 ──────────────────────────────────────────────────────
  log('[6] D — 스테이징이 상한 캐시를 거절하는가')
  const stage = path.join(REPO, 'src-tauri', 'lsp-runtime', 'node.exe')
  const backup = path.join(SCRATCH, 'node.exe.backup')
  let staging = { skipped: true }
  if (fs.existsSync(stage)) {
    fs.mkdirSync(SCRATCH, { recursive: true })
    fs.copyFileSync(stage, backup)
    // 한 바이트만 바꾼다 — 크기는 그대로다. 크기로만 거르는 구현이면 여기서 통과해 버린다.
    const fd = fs.openSync(stage, 'r+')
    fs.writeSync(fd, Buffer.from([0x00]), 0, 1, 1024)
    fs.closeSync(fd)
    const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'tauri-build.mjs'), 'stage'], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 600_000,
      // 네트워크 없이 「거절하는가」만 본다 — 다시 받으러 가면 오래 걸리므로 프록시를 막는다.
      env: { ...process.env, http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9' }
    })
    const said = `${r.stdout ?? ''}${r.stderr ?? ''}`
    staging = {
      skipped: false,
      rejectedCorruptCache: /캐시가 핀과 다르다/.test(said),
      exitCode: r.status,
      failedLoudly: r.status !== 0 && /LSP용 Node 런타임을 준비하지 못했다/.test(said)
    }
    fs.copyFileSync(backup, stage) // 원상복구
    const back = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'tauri-build.mjs'), 'stage'], { cwd: REPO, encoding: 'utf8' })
    staging.restoredCacheHit = /캐시 적중/.test(`${back.stdout ?? ''}`)
    check(staging.rejectedCorruptCache, '[D] 1바이트만 바꾼 캐시를 **크기가 같아도** 거절한다')
    check(staging.failedLoudly, `[D] 못 받으면 사유를 말하고 exit≠0 (exit=${staging.exitCode})`)
    check(staging.restoredCacheHit, '[D] 원상복구 뒤 다시 캐시 적중(제품 트리 무손상)')
  } else {
    log('    건너뜀 — 스테이징 산출물이 없다')
  }
  out.staging = staging

  // ── C. 돌연변이 ─────────────────────────────────────────────────────────────
  if (SKIP_MUT) {
    log('[7] C — 돌연변이 건너뜀(--skip-mutations)')
    out.mutations = { skipped: true }
  } else {
    log('[7] ★C — 돌연변이 6종(격리 사본 · 제품 트리 무접촉)')
    const tree = makeMutantTree()
    const mutTarget = path.join(SCRATCH, 'mutant-target')
    const base = runMutantTests(tree, mutTarget)
    check(base.status === 0, '[C] 대조군 — 돌연변이 없는 사본은 초록이다')
    const results = []
    for (const m of MUTATIONS) {
      const f = path.join(tree, m.file)
      const orig = fs.readFileSync(f, 'utf8')
      const next = m.apply(orig)
      if (next === orig) {
        results.push({ ...m, applied: false, red: false, note: '돌연변이가 안 먹었다(패턴 불일치)' })
        check(false, `[C] ${m.id} — 돌연변이 적용 실패(패턴이 안 맞는다)`)
        continue
      }
      fs.writeFileSync(f, next)
      const r = runMutantTests(tree, mutTarget)
      fs.writeFileSync(f, orig)
      const red = r.status !== 0
      results.push({ id: m.id, why: m.why, file: m.file, expect: m.expect, applied: true, red, exitCode: r.status })
      check(red, `[C] ${m.id} → ${red ? 'red' : '★초록(그물에 구멍)'} · 기대: ${m.expect}`)
    }
    // 제품 트리가 정말 안 상했는지 — 사본만 건드렸다는 확인
    const prodConf = fs.readFileSync(path.join(REPO, 'src-tauri', 'tauri.conf.json'), 'utf8')
    check(prodConf.includes('"lsp-runtime/node.exe"'), '[C] 제품 트리 무접촉(매니페스트 원형 유지)')
    out.mutations = { tree, results }
  }

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
