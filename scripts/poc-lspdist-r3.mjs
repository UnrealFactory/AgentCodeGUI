#!/usr/bin/env node
/**
 * `poc-lspdist-r3` — 확인 크리틱 R2가 남긴 **중 2**를 닫혔는지 재는 PoC(마감).
 *
 * | 팔 | 겨누는 결함 | 통과 조건 |
 * |---|---|---|
 * | **A. 사이드카 유실** | **R2-C1** — 죽을 때 하는 말이 틀렸다 | `error` + 실패 문자열이 **`$INSTDIR\node.exe`를 지목**하고 「PATH를 안 본다」·「node 깔아도 안 낫는다」를 말한다 |
 * | **B. `.cargo-lock` 심기(G6)** | **R2-L2** — 게이트가 상류보다 약했다 | 빈 `.cargo-lock`을 심고 **미끼 node를 PATH 첫 칸**에 세워도 `error` |
 * | **C. 회피 변이 4종** | **R2-C2** — 계약이 출처를 안 본다 | E1·E2·E3 + 스테이징 실물 변조가 전부 **red** |
 * | D. 온전한 배포본 | 회귀 가드 | 두 언어 `ready`(사이드카를 문다) |
 *
 * A가 이 라운드의 본체다. R2는 「조용히 틀린 판을 무는 것보다 소리 내어 죽는 편이 낫다」를
 * 사서 PATH를 끊었는데, **죽을 때 하는 말이 틀렸으면 그 거래에서 산 것을 절반 잃는다**
 * (크리틱 §4). 그 문장이 이제 사슬과 **같은 목록**에서 나오는지를 문자열로 확인한다.
 *
 * 규율(R1·R2와 동일): 이름 기반 kill 0 · 전 팔 `CCG_HOME` 격리 · 실홈 무접촉 ·
 * NSIS 설치기 미실행 · 돌연변이는 격리 사본에서만(제품 트리 무접촉을 매회 확인) ·
 * 시스템 PATH 무변경(자식 환경변수만 조작).
 *
 * 사용: node scripts/poc-lspdist-r3.mjs [--skip-build] [--skip-mutations]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const TARGET = path.join(REPO, 'target-lspdist')
const SCRATCH = path.join(TARGET, 'poc-lspdist-r3')
const argv = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=')
const SKIP_BUILD = process.argv.includes('--skip-build')
const SKIP_MUT = process.argv.includes('--skip-mutations')
const OUT = path.resolve(REPO, argv('out', 'bench/results/poc-lspdist-r3.json'))

const log = (...a) => console.log(...a)
const fail = []
const check = (ok, what) => {
  log(`${ok ? '  ✓' : '  ✖'} ${what}`)
  if (!ok) fail.push(what)
  return ok
}

const LOCAL = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
const DIST = path.join(LOCAL, 'ccg-lspdist-r3', 'deployed')
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })

// ── 적재물(생성된 installer.nsi 그대로) ──────────────────────────────────────
const NSI_BASES = [path.join(REPO, 'src-tauri', 'target-lspdist', 'release', 'nsis'), path.join(TARGET, 'release', 'nsis')]
function payloadFromNsi() {
  for (const base of NSI_BASES) {
    if (!fs.existsSync(base)) continue
    for (const arch of fs.readdirSync(base)) {
      const nsi = path.join(base, arch, 'installer.nsi')
      if (!fs.existsSync(nsi)) continue
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

const scrubbedPath = (p) =>
  (p ?? '')
    .split(path.delimiter)
    .filter((d) => d && !fs.existsSync(path.join(d, 'node.exe')) && !fs.existsSync(path.join(d, 'node')))
    .join(path.delimiter)

function runArm({ exeDir, cwd, lang, rel, projRoot, home, samples = 4, noNode = false, baitPath = null }) {
  const env = { ...process.env, ...PROBE_ENV[lang], CCG_HOME: home }
  delete env.CCG_LSP_MODULES
  delete env.CCG_LSP_NODE
  if (noNode) env.PATH = scrubbedPath(env.PATH)
  // 미끼를 **첫 칸**에 세운다 — 물었다면 ready가 되어 누출이 시끄럽게 드러난다.
  if (baitPath) env.PATH = `${baitPath}${path.delimiter}${scrubbedPath(env.PATH)}`
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
  return { exitCode: r.status, stderrTail: (r.stderr ?? '').trim().slice(-300) || null, probe: json }
}

// ── 회피 변이 ────────────────────────────────────────────────────────────────
const CONF = 'src-tauri/tauri.conf.json'
const MUTATIONS = [
  {
    id: 'E1 · dest는 그대로, src만 남의 폴더로',
    why: '크리틱 R2-C2 — 목적지 문자열이 완벽해도 나르는 물건이 다르면 tsserver가 실종된다',
    file: CONF,
    apply: (s) => s.replace('"../node_modules/typescript/lib":', '"../node_modules/pyright/dist":'),
    expect: 'every_bundled_file_is_covered_by_the_installer_manifest (출처↔목적지)'
  },
  {
    id: 'E2 · node_modules를 통째로 나르기',
    why: '「매니페스트 단순화」로 실제로 나올 수 있는 편집. 유령 검사도 못 잡았다',
    file: CONF,
    apply: (s) => {
      const j = JSON.parse(s)
      j.bundle.resources = { 'lsp-runtime/node.exe': 'node.exe', '../node_modules': 'node_modules' }
      return JSON.stringify(j, null, 2) + '\n'
    },
    expect: '〃 (트리 통째 적재 금지)'
  },
  {
    id: 'E3 · dest=node.exe · src=LICENSE.txt',
    why: '★비가역 — $INSTDIR\\node.exe가 텍스트 파일이 되고 R2가 PATH를 끊어 복구 경로가 없다',
    file: CONF,
    apply: (s) => s.replace('"lsp-runtime/node.exe":', '"../node_modules/pyright/LICENSE.txt":'),
    expect: '〃 (런타임 출처는 스테이징 자리 하나뿐)'
  },
  {
    id: 'E4 · 스테이징된 실물을 다른 파일로 바꾸기',
    why: '스테이징의 해시 검사는 **빌드 시각**의 것이다 — 그 뒤에 바뀌면 아무도 안 봤다',
    plant: (tree) => {
      const d = path.join(tree, 'src-tauri', 'lsp-runtime')
      fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(path.join(d, 'node.exe'), 'not a node runtime\n')
    },
    unplant: (tree) => rmrf(path.join(tree, 'src-tauri', 'lsp-runtime')),
    expect: '〃 (스테이징 실물 sha256 == NODE_PIN)'
  }
]

function makeMutantTree() {
  const tree = path.join(SCRATCH, 'mutant')
  rmrf(tree)
  fs.mkdirSync(tree, { recursive: true })
  for (const f of ['Cargo.toml', 'Cargo.lock']) fs.copyFileSync(path.join(REPO, f), path.join(tree, f))
  fs.cpSync(path.join(REPO, 'crates'), path.join(tree, 'crates'), { recursive: true })
  fs.mkdirSync(path.join(tree, 'scripts'), { recursive: true })
  // 계약이 핀을 **여기서 읽는다** — 사본에도 있어야 한다.
  fs.copyFileSync(path.join(REPO, 'scripts', 'tauri-build.mjs'), path.join(tree, 'scripts', 'tauri-build.mjs'))
  fs.mkdirSync(path.join(tree, 'src-tauri'), { recursive: true })
  for (const f of ['Cargo.toml', 'tauri.conf.json', 'build.rs']) {
    const p = path.join(REPO, 'src-tauri', f)
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(tree, 'src-tauri', f))
  }
  fs.mkdirSync(path.join(tree, 'src-tauri', 'src'), { recursive: true })
  fs.writeFileSync(path.join(tree, 'src-tauri', 'src', 'main.rs'), 'fn main() {}\n')
  return tree
}

const runMutantTests = (tree, t) => {
  const r = spawnSync('cargo', ['test', '-p', 'ccg-lsp', '--lib', 'spec::tests'], {
    cwd: tree,
    env: { ...process.env, CARGO_TARGET_DIR: t },
    encoding: 'utf8',
    timeout: 900_000
  })
  return { status: r.status }
}

// ── 주행 ─────────────────────────────────────────────────────────────────────
const out = { poc: 'lspdist-r3', at: new Date().toISOString(), repo: REPO, node: process.version }

try {
  log('[0] 배포 모사')
  rmrf(DIST)
  fs.mkdirSync(DIST, { recursive: true })
  buildProbe()
  const p = payloadFromNsi()
  if (!p) throw new Error('installer.nsi를 못 찾았다 — 먼저 `npm run tauri:build`를 돌려라')
  for (const { src, dest } of p.pairs) {
    const to = path.join(DIST, dest)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(src, to)
  }
  fs.copyFileSync(PROBE, path.join(DIST, 'ccg-lspprobe.exe'))
  const sidecar = path.join(DIST, 'node.exe')
  check(fs.existsSync(sidecar), '배포 모사에 사이드카가 있다')
  out.deploySim = { dist: DIST, entries: p.pairs.length, nsi: p.nsi }

  log('[2] 픽스처')
  const { FIXTURES } = await import('../bench/lspfix.mjs')
  const proj = path.join(SCRATCH, 'proj')
  fs.mkdirSync(proj, { recursive: true })
  const fx = { ts: FIXTURES.ts.make(proj, { blocks: 40 }), py: FIXTURES.py.make(proj, { blocks: 40 }) }
  const { quietHome } = await import('../bench/lib.mjs')
  const homeFor = (n) => quietHome(path.join(SCRATCH, 'homes', n))
  const relOf = (l) => (l === 'ts' ? fx.ts.bigRel : fx.py.bigRel)

  // ── D. 회귀 가드: 온전한 배포본 ─────────────────────────────────────────────
  log('[3] D — 온전한 배포본(회귀 가드)')
  const good = {}
  for (const lang of ['ts', 'py']) {
    const r = runArm({ exeDir: DIST, cwd: DIST, lang, rel: relOf(lang), projRoot: proj, home: homeFor(`good-${lang}`), noNode: true })
    good[lang] = { status: r.probe?.status, node: r.probe?.resolve?.node, hover: r.probe?.hover?.hits }
    check(r.probe?.status === 'ready', `[D] ${lang} ready (PATH에 node 없이 · 사이드카를 문다)`)
    check(
      (r.probe?.resolve?.node ?? '').toLowerCase() === sidecar.toLowerCase(),
      `[D] ${lang} 문 node가 사이드카다 (${r.probe?.resolve?.node})`
    )
  }
  out.intact = good

  // ── A. ★ 사이드카 유실 — 죽을 때 하는 말 ───────────────────────────────────
  log('[4] ★A — 사이드카 유실(백신 격리 모사): 죽을 때 하는 말')
  const quarantined = path.join(SCRATCH, 'node.exe.quarantined')
  fs.renameSync(sidecar, quarantined)
  const lost = {}
  for (const lang of ['ts', 'py']) {
    // PATH에 **진짜 node를 그대로 둔 채** 돈다 — 배포본이 PATH를 안 본다는 것도 같이 본다.
    const r = runArm({ exeDir: DIST, cwd: DIST, lang, rel: relOf(lang), projRoot: proj, home: homeFor(`lost-${lang}`) })
    const err = r.probe?.resolve?.launchError ?? ''
    lost[lang] = { status: r.probe?.status, node: r.probe?.resolve?.node, launchError: err }
    log(`    ${lang}: status=${r.probe?.status} node=${r.probe?.resolve?.node}`)
    check(r.probe?.status === 'error', `[A] ${lang} — 사이드카가 없으면 죽는다`)
    check((r.probe?.resolve?.node ?? null) === null, `[A] ${lang} — PATH의 진짜 node를 물지 않는다`)
    // ★ 이 라운드의 피감수 — 문장이 무엇을 말하는가
    check(err.includes(sidecar), `[A] ${lang} — 실패 문자열이 **${sidecar}**를 지목한다`)
    check(!/PATH 순으로 찾는다/.test(err), `[A] ${lang} — R2의 틀린 문장("PATH 순으로 찾는다")이 사라졌다`)
    check(/보지 않는다|not consulted/.test(err), `[A] ${lang} — 배포본이 PATH를 안 본다고 말한다`)
    check(/낫지 않아요|will not help/.test(err), `[A] ${lang} — "node를 깔아도 안 낫는다"를 말한다(헛수고 방지)`)
    check(/lsp-runtime/.test(err), `[A] ${lang} — 사슬 ③(개발 스테이징)도 문장에 있다`)
    check(/다시 설치/.test(err) && /reinstall/.test(err), `[A] ${lang} — ko/en 두 벌이다`)
  }
  out.sidecarLost = lost
  if (lost.ts?.launchError) log(`\n--- 실패 문자열(ts) ---\n${lost.ts.launchError}\n---`)

  // ── B. ★ .cargo-lock 심기(크리틱 G6) ────────────────────────────────────────
  log('[5] ★B — $INSTDIR에 빈 .cargo-lock을 심고 미끼 node를 PATH 첫 칸에')
  const bait = path.join(SCRATCH, 'bait-path')
  fs.mkdirSync(bait, { recursive: true })
  fs.copyFileSync(quarantined, path.join(bait, 'node.exe')) // 진짜 node의 사본 = 물면 ready가 된다
  fs.writeFileSync(path.join(DIST, '.cargo-lock'), '')
  const g6 = {}
  for (const lang of ['ts', 'py']) {
    const r = runArm({ exeDir: DIST, cwd: DIST, lang, rel: relOf(lang), projRoot: proj, home: homeFor(`g6-${lang}`), baitPath: bait })
    g6[lang] = { status: r.probe?.status, node: r.probe?.resolve?.node }
    check(r.probe?.status === 'error', `[B] ${lang} — .cargo-lock을 심어도 안 열린다(R2는 여기서 ready였다)`)
    check((r.probe?.resolve?.node ?? null) === null, `[B] ${lang} — 미끼 node를 안 문다`)
  }
  out.cargoLockPlanted = g6
  fs.rmSync(path.join(DIST, '.cargo-lock'), { force: true })
  fs.renameSync(quarantined, sidecar) // 원상복구
  check(fs.existsSync(sidecar), '[B] 사이드카 원상복구')

  // ── C. 회피 변이 ────────────────────────────────────────────────────────────
  if (SKIP_MUT) {
    log('[6] C — 돌연변이 건너뜀(--skip-mutations)')
    out.mutations = { skipped: true }
  } else {
    log('[6] ★C — 회피 변이 4종(격리 사본 · 제품 트리 무접촉)')
    const tree = makeMutantTree()
    const mt = path.join(SCRATCH, 'mutant-target')
    check(runMutantTests(tree, mt).status === 0, '[C] 대조군 — 돌연변이 없는 사본은 초록이다')
    const results = []
    for (const m of MUTATIONS) {
      let orig = null
      if (m.file) {
        const f = path.join(tree, m.file)
        orig = fs.readFileSync(f, 'utf8')
        const next = m.apply(orig)
        if (next === orig) {
          check(false, `[C] ${m.id} — 돌연변이 적용 실패(패턴 불일치)`)
          results.push({ id: m.id, applied: false, red: false })
          continue
        }
        fs.writeFileSync(f, next)
      } else {
        m.plant(tree)
      }
      const r = runMutantTests(tree, mt)
      if (m.file) fs.writeFileSync(path.join(tree, m.file), orig)
      else m.unplant(tree)
      const red = r.status !== 0
      results.push({ id: m.id, why: m.why, expect: m.expect, applied: true, red })
      check(red, `[C] ${m.id} → ${red ? 'red' : '★초록(구멍)'}`)
    }
    const prod = fs.readFileSync(path.join(REPO, CONF), 'utf8')
    check(prod.includes('"lsp-runtime/node.exe"'), '[C] 제품 트리 무접촉')
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
