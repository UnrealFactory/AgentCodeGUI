#!/usr/bin/env node
/**
 * `critic-lspdist-r2` — LSPDIST R2 확인 크리틱의 **독립 계기**.
 *
 * R1 크리틱 하네스(`critic-lspdist-r1.mjs`)의 후속. 빌더의 `poc-lspdist-r2.mjs`는 안 돌린다 —
 * 같은 계기로 같은 값이 나오는 것은 재현이 아니다. 오염 없는 트리(`git archive b4f89b5`)에서
 * 새로 구운 프로브·새로 구운 `installer.nsi`·새로 스테이징한 `node.exe`만 쓴다.
 *
 * ── R1 하네스에 더한 것: `.cargo-lock` 게이트 공격 ─────────────────────────────
 * R2는 「배포본에서 PATH를 못 본다」를 `exe 폴더에 .cargo-lock이 있는가` 하나로 판정한다.
 * 그 신호를 믿어도 되는지를 **실측으로** 때린다:
 *
 * | 팔 | 배치 | PATH | 기대 |
 * |---|---|---|---|
 * | `deployed` | 사이드카 있음 · `.cargo-lock` 없음 | node 없음 | **ready** · node=사이드카 |
 * | `deployed-nosidecar` | 사이드카 **없음** · `.cargo-lock` 없음 | **진짜 node 있음** | **error** ← PATH 폴백 금지 |
 * | `deployed-nosidecar` + 미끼 | 〃 | **미끼 node.exe가 PATH 첫 칸** | **error** · 미끼를 안 문다 |
 * | `forged-cargolock` | 사이드카 없음 · **`.cargo-lock`을 심었다** | 진짜 node | ready(=게이트가 그 한 파일) |
 * | `dev-staged` | `.cargo-lock` 있음 · 사이드카 없음 · 조상에 스테이징본 | **node 없음** | **ready** · node=③ 스테이징본 |
 * | `orphan-exe` | `.cargo-lock` 없음 · 사이드카 없음 · 조상 없음 | node 있음 | error |
 *
 * 미끼 `node.exe`는 **진짜 node의 사본**이다 — 물면 `ready`가 되어 누출이 시끄럽게 드러난다
 * (안 도는 가짜를 쓰면 「어차피 error」와 구별이 안 된다).
 *
 * 규율: 이름 기반 kill 0 · 전 팔 `CCG_HOME` 격리 · 실홈 무접촉 · 배포 모사 이름을 빌더 것과
 * 갈랐다(`ccg-critic-lspdist-r2`) · 환경변수만 조작(시스템 PATH 무변경).
 *
 * 사용:
 *   node docs/critic/tools/critic-lspdist-r2.mjs \
 *     --probe=<프로브.exe> --nsi=<installer.nsi> --tree=<격리 트리> \
 *     --out=docs/critic/lspdist-critic-r2-probe.json
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const argv = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.split('=').slice(1).join('=') : d
}
const PROBE = argv('probe', '')
const NSI = argv('nsi', '')
const TREE = argv('tree', '')
const OUT = path.resolve(REPO, argv('out', 'docs/critic/lspdist-critic-r2-probe.json'))

const LOCAL = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
const BASE = path.join(LOCAL, 'ccg-critic-lspdist-r2')
const D = {
  deployed: path.join(BASE, 'deployed'), // 사이드카 O · .cargo-lock X
  nosidecar: path.join(BASE, 'deployed-nosidecar'), // 사이드카 X · .cargo-lock X
  forged: path.join(BASE, 'forged-cargolock'), // 사이드카 X · .cargo-lock O(내가 심었다)
  orphan: path.join(BASE, 'orphan-exe'), // 아무것도 없음
  bait: path.join(BASE, 'bait-path'), // PATH 미끼 node.exe
  nowhere: path.join(BASE, 'nowhere') // cwd 중립 자리
}

const log = (...a) => console.log(...a)
const fail = []
const check = (ok, what) => {
  log(`${ok ? '  ✓' : '  ✖'} ${what}`)
  if (!ok) fail.push(what)
  return ok
}
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

const realNodeOnPath = () =>
  (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((d) => path.join(d, 'node.exe'))
    .find((p) => fs.existsSync(p))

/** node.exe를 담은 PATH 항목을 전부 걷어낸다(환경변수만 만진다). */
const scrubNode = (p) =>
  (p ?? '')
    .split(path.delimiter)
    .filter((d) => d && !fs.existsSync(path.join(d, 'node.exe')) && !fs.existsSync(path.join(d, 'node')))
    .join(path.delimiter)

function runArm({ exeDir, cwd, lang, rel, projRoot, home, samples = 6, pathMode = 'asis', modulesEnv = null }) {
  const exe = path.join(exeDir, 'ccg-lspprobe.exe')
  const env = { ...process.env, ...PROBE_ENV[lang], CCG_HOME: home }
  delete env.CCG_LSP_MODULES
  delete env.CCG_LSP_NODE
  if (modulesEnv) env.CCG_LSP_MODULES = modulesEnv
  if (pathMode === 'nonode') env.PATH = scrubNode(env.PATH ?? env.Path)
  // 미끼 = 진짜 node의 사본을 **PATH 첫 칸**에. 물면 ready가 되어 누출이 시끄럽게 드러난다.
  if (pathMode === 'bait') env.PATH = [D.bait, scrubNode(env.PATH ?? env.Path)].filter(Boolean).join(path.delimiter)
  delete env.Path // Windows에서 두 키가 공존하면 어느 쪽이 이길지 모른다
  const t = Date.now()
  const r = spawnSync(exe, [projRoot, rel, String(samples)], { cwd, env, encoding: 'utf8', timeout: 300_000, windowsHide: true })
  const line = (r.stdout ?? '').trim().split('\n').filter(Boolean).pop()
  let json = null
  try {
    json = JSON.parse(line)
  } catch {
    /* 말 없이 죽은 팔 */
  }
  return { exitCode: r.status, wallMs: Date.now() - t, stderrTail: (r.stderr ?? '').trim().slice(-400) || null, probe: json }
}

const out = { critic: 'lspdist-r2', at: new Date().toISOString(), node: process.version, inputs: { PROBE, NSI, TREE } }

try {
  log('[0] 배포 모사 자리')
  for (const d of Object.values(D)) {
    rmrf(d)
    fs.mkdirSync(d, { recursive: true })
  }
  out.deploySim = {}
  for (const [k, d] of Object.entries(D)) {
    const anc = ancestorsWithNodeModules(d)
    out.deploySim[k] = { dir: d, ancestorsWithNodeModules: anc }
    check(anc.length === 0, `${k} 조상 사슬에 node_modules 없음`)
  }

  log('[1] 적재물 — 내가 구운 installer.nsi 그대로')
  const reMod = /^\s*File \/a "\/oname=(node_modules\\[^"]+)" "([^"]+)"\s*$/
  const reAny = /^\s*File \/a "\/oname=([^"]+)" "([^"]+)"\s*$/
  const pairs = []
  const allPairs = []
  for (const line of fs.readFileSync(NSI, 'utf8').split(/\r?\n/)) {
    const m = reMod.exec(line)
    if (m) pairs.push({ dest: m[1], src: m[2] })
    const a = reAny.exec(line)
    if (a) allPairs.push({ dest: a[1], src: a[2] })
  }
  const nodeEntry = allPairs.find((p) => p.dest.toLowerCase() === 'node.exe')
  check(pairs.length > 0, `installer.nsi의 node_modules 적재 줄 ${pairs.length}개`)
  check(!!nodeEntry, `installer.nsi가 node.exe를 싣는다 (${nodeEntry?.src ?? '없다'})`)
  const stage = path.join(BASE, 'payload')
  rmrf(stage)
  for (const { src, dest } of pairs) {
    const to = path.join(stage, dest)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(src, to)
  }
  const pstat = treeStats(stage)
  out.payload = { nsi: NSI, moduleEntries: pairs.length, totalEntries: allPairs.length, nodeEntry, ...pstat }
  log(`    모듈 ${pairs.length}개 · ${pstat.mb}MB(원바이트) · ${pstat.onDiskMb}MB(4KiB)`)

  // 사이드카 = installer.nsi가 지목한 그 파일(스테이징 산출물)
  const stagedNode = nodeEntry ? nodeEntry.src : null
  if (stagedNode) {
    const h = spawnSync('certutil', ['-hashfile', stagedNode, 'SHA256'], { encoding: 'utf8' })
    out.stagedNodeSha256 = (h.stdout ?? '').split(/\r?\n/)[1]?.replace(/\s/g, '') ?? null
    out.stagedNodeBytes = fs.statSync(stagedNode).size
    log(`    사이드카: ${out.stagedNodeBytes} B · sha256=${(out.stagedNodeSha256 ?? '').slice(0, 16)}…`)
  }

  // 배치 굽기
  const put = (dir, { sidecar, cargoLock, modules }) => {
    fs.copyFileSync(PROBE, path.join(dir, 'ccg-lspprobe.exe'))
    if (modules) fs.cpSync(path.join(stage, 'node_modules'), path.join(dir, 'node_modules'), { recursive: true })
    if (sidecar && stagedNode) fs.copyFileSync(stagedNode, path.join(dir, 'node.exe'))
    if (cargoLock) fs.writeFileSync(path.join(dir, '.cargo-lock'), '')
  }
  put(D.deployed, { sidecar: true, cargoLock: false, modules: true })
  put(D.nosidecar, { sidecar: false, cargoLock: false, modules: true })
  put(D.forged, { sidecar: false, cargoLock: true, modules: true })
  put(D.orphan, { sidecar: false, cargoLock: false, modules: false })
  // 미끼: 진짜 node의 사본
  const rn = realNodeOnPath()
  out.baitNodeFrom = rn ?? null
  if (rn) fs.copyFileSync(rn, path.join(D.bait, 'node.exe'))
  check(!!rn, 'PATH에서 진짜 node.exe를 찾았다(미끼·대조군 재료)')

  log('[2] 픽스처(격리 트리 안 — cwd 미끼)')
  const { FIXTURES } = await import(pathToFileURL(path.join(REPO, 'bench', 'lspfix.mjs')).href)
  const proj = path.join(TREE, 'critic-fx-r2', 'proj')
  fs.mkdirSync(proj, { recursive: true })
  const ts = FIXTURES.ts.make(proj, { blocks: 60 })
  const py = FIXTURES.py.make(proj, { blocks: 60 })
  check(ancestorsWithNodeModules(proj).includes(path.resolve(TREE)), '픽스처 cwd 조상이 트리의 node_modules에 닿는다')
  out.fixture = { proj, ts: ts.bigRel, py: py.bigRel }

  const { quietHome } = await import(pathToFileURL(path.join(REPO, 'bench', 'lib.mjs')).href)
  const homeFor = (n) => quietHome(path.join(BASE, 'homes', n.replace(/[/\\|=]/g, '-')))
  const relOf = (l) => (l === 'ts' ? ts.bigRel : py.bigRel)

  const arms = {}
  const go = (key, opts) => {
    const r = runArm({ projRoot: proj, home: homeFor(key), ...opts })
    arms[key] = r
    const p = r.probe ?? {}
    const n = p.resolve?.node
    log(
      `    ${key.padEnd(40)} status=${String(p.status).padEnd(11)} hover=${p.hover?.hits ?? '-'}/${p.hover?.n ?? '-'} ` +
        `tok=${p.tokens ?? '-'} node=${n ? path.basename(path.dirname(n)) + '\\' + path.basename(n) : 'null'}`
    )
    return r
  }

  log('[3] ★ 최대 격차 재현 — PATH에 node 없음 · 두 언어 × 두 cwd')
  for (const lang of ['ts', 'py']) {
    go(`nonode/deployed/install-cwd|${lang}`, { exeDir: D.deployed, cwd: D.deployed, lang, rel: relOf(lang), pathMode: 'nonode' })
    go(`nonode/deployed/project-cwd|${lang}`, { exeDir: D.deployed, cwd: proj, lang, rel: relOf(lang), pathMode: 'nonode' })
  }

  log('[4] ★ .cargo-lock 게이트 공격')
  go('attack/nosidecar+realnode-on-PATH|ts', { exeDir: D.nosidecar, cwd: D.nosidecar, lang: 'ts', rel: ts.bigRel, pathMode: 'asis', samples: 2 })
  go('attack/nosidecar+BAIT-node-on-PATH|ts', { exeDir: D.nosidecar, cwd: D.nosidecar, lang: 'ts', rel: ts.bigRel, pathMode: 'bait', samples: 2 })
  go('attack/nosidecar+BAIT|py', { exeDir: D.nosidecar, cwd: D.nosidecar, lang: 'py', rel: py.bigRel, pathMode: 'bait', samples: 2 })
  go('attack/FORGED-cargolock+BAIT-node|ts', { exeDir: D.forged, cwd: D.forged, lang: 'ts', rel: ts.bigRel, pathMode: 'bait', samples: 2 })
  go('attack/orphan-exe+realnode|ts', { exeDir: D.orphan, cwd: D.orphan, lang: 'ts', rel: ts.bigRel, pathMode: 'asis', samples: 2 })
  // 설치본을 cargo 레포 **안에서** 켜는 판 — cwd가 cargo 폴더여도 게이트는 exe 경로의 함수여야 한다
  const cargoCwd = path.join(TREE, 'target-sim', 'release')
  fs.mkdirSync(cargoCwd, { recursive: true })
  fs.writeFileSync(path.join(cargoCwd, '.cargo-lock'), '')
  go('attack/nosidecar+cwd=cargo-dir+BAIT|ts', { exeDir: D.nosidecar, cwd: cargoCwd, lang: 'ts', rel: ts.bigRel, pathMode: 'bait', samples: 2 })

  log('[5] 개발 실행 — ③ 스테이징 산출물(조상)로 산다 · PATH 없이')
  const devDir = path.join(TREE, 'target-sim', 'release')
  fs.copyFileSync(PROBE, path.join(devDir, 'ccg-lspprobe.exe'))
  go('dev/staged-ancestor|cwd=nowhere|ts', { exeDir: devDir, cwd: D.nowhere, lang: 'ts', rel: ts.bigRel, pathMode: 'nonode', samples: 2 })
  go('dev/staged-ancestor|py', { exeDir: devDir, cwd: proj, lang: 'py', rel: py.bigRel, pathMode: 'nonode', samples: 2 })

  log('[6] 모듈 사슬 무후퇴(R1 못이 아직 사나)')
  go('regress/bare/project-cwd|ts', { exeDir: D.orphan, cwd: proj, lang: 'ts', rel: ts.bigRel, pathMode: 'asis', samples: 2 })
  go('lever/CCG_LSP_MODULES|ts', { exeDir: D.orphan, cwd: D.orphan, lang: 'ts', rel: ts.bigRel, modulesEnv: TREE, pathMode: 'asis', samples: 2 })
  out.arms = arms

  log('[7] 판정')
  const P = (k) => arms[k]?.probe ?? {}
  const sidecarPath = path.join(D.deployed, 'node.exe').toLowerCase()
  for (const lang of ['ts', 'py']) {
    const a = P(`nonode/deployed/install-cwd|${lang}`)
    const b = P(`nonode/deployed/project-cwd|${lang}`)
    check(a.status === 'ready', `[${lang}] ★PATH에 node 없어도 cwd=설치 폴더에서 ready (R1은 error였다)`)
    check(b.status === 'ready', `[${lang}] ★PATH에 node 없어도 cwd=프로젝트에서 ready`)
    check((a.hover?.hits ?? 0) === (a.hover?.n ?? -1) && (a.hover?.n ?? 0) > 0, `[${lang}] 호버 ${a.hover?.hits}/${a.hover?.n}`)
    check((a.resolve?.node ?? '').toLowerCase() === sidecarPath, `[${lang}] node=번들 사이드카 (${a.resolve?.node})`)
    check(
      JSON.stringify(a.resolve?.modules) === JSON.stringify(b.resolve?.modules),
      `[${lang}] 두 cwd 팔이 같은 모듈 파일을 문다`
    )
  }
  // ★ PATH 폴백 금지
  const noSide = P('attack/nosidecar+realnode-on-PATH|ts')
  check(noSide.status === 'error', `★배포 배치·사이드카 없음 → PATH에 진짜 node가 있어도 error (${noSide.status})`)
  check((noSide.resolve?.node ?? null) === null, `★그 팔의 resolve.node=null (${noSide.resolve?.node})`)
  for (const k of ['attack/nosidecar+BAIT-node-on-PATH|ts', 'attack/nosidecar+BAIT|py', 'attack/nosidecar+cwd=cargo-dir+BAIT|ts']) {
    const v = P(k)
    check(v.status === 'error' && (v.resolve?.node ?? null) === null, `★미끼 node를 안 문다: ${k} (${v.status} · ${v.resolve?.node})`)
  }
  const orphan = P('attack/orphan-exe+realnode|ts')
  check(orphan.status === 'error', `고아 exe(사이드카·조상·.cargo-lock 전부 없음) → error (${orphan.status})`)
  // 게이트가 정확히 그 한 파일인가 — 심으면 열린다(설계대로. 위험도는 판정문에서 논한다)
  const forged = P('attack/FORGED-cargolock+BAIT-node|ts')
  out.forgedGate = { status: forged.status ?? null, node: forged.resolve?.node ?? null }
  check(
    forged.status === 'ready' && (forged.resolve?.node ?? '').toLowerCase().startsWith(D.bait.toLowerCase()),
    `.cargo-lock 한 파일을 심으면 PATH 칸이 열린다(게이트의 실체 확인 · ${forged.status} · ${forged.resolve?.node})`
  )
  // 개발 실행
  const dev = P('dev/staged-ancestor|cwd=nowhere|ts')
  const stagedDev = path.join(TREE, 'src-tauri', 'lsp-runtime', 'node.exe').toLowerCase()
  check(dev.status === 'ready', `개발 실행(PATH에 node 없음) → ready (${dev.status})`)
  check((dev.resolve?.node ?? '').toLowerCase() === stagedDev, `개발 팔이 문 node = 조상의 스테이징 산출물 (${dev.resolve?.node})`)
  check(P('dev/staged-ancestor|py').status === 'ready', 'py도 개발 실행에서 ready')
  // 무후퇴
  check(P('regress/bare/project-cwd|ts').status === 'error', 'R1 못 유지 — 번들 없는 project-cwd는 여전히 error')
  check(P('lever/CCG_LSP_MODULES|ts').status !== 'unsupported', 'CCG_LSP_MODULES 레버 팔이 돈다')

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
