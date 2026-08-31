#!/usr/bin/env node
/**
 * `critic-lspdist-r1` — LSPDIST R1 확인 크리틱의 **독립 계기**.
 *
 * 빌더의 `scripts/poc-lspdist-r1.mjs`를 다시 돌리지 않는다(같은 계기로 같은 값이 나오는
 * 것은 재현이 아니다). 이 하네스는 **오염 없는 트리**(`git archive bcd0734`를 %TEMP%에 푼
 * 것)에서 새로 구운 프로브·새로 구운 설치기의 `installer.nsi`만 쓴다.
 *
 * ── 빌더의 팔에 더한 것 ─────────────────────────────────────────────────────
 *  · **PATH에서 node를 걷어낸 팔을 두 언어 × 두 cwd로** 넓혔다. 빌더는 ts·cwd=설치 폴더
 *    한 칸만 쟀는데, 그 칸이 §1.6-A2의 「닫혔나」를 정하는 자리다.
 *  · **사이드카 팔** — `<exe 폴더>\node.exe`를 채우면 PATH 없이도 사는가. 다음 라운드가
 *    「한 파일이면 닫힌다」인지 「설계를 더 손대야」인지를 가른다.
 *  · **개발 실행 팔** — cwd 조상에 `node_modules`가 **전혀 없는 자리**에서 켜도 exe 조상
 *    사슬로 레포를 무는가(= cwd를 지운 대가가 개발이 아닌가).
 *  · **`CCG_LSP_MODULES` 팔** — 번들 없는 exe에 환경변수만 얹으면 사는가(레버 생존).
 *
 * 규율: 이름 기반 kill 없음(프로브가 자기 자식만 걷는다) · 전 팔 `CCG_HOME` 격리 ·
 * 실홈 무접촉 · 배포 모사 이름을 빌더 것(`ccg-lspdist-r1`)과 갈라 기존 산출물 무접촉.
 *
 * 사용:
 *   node docs/critic/tools/critic-lspdist-r1.mjs \
 *     --probe=<새 프로브.exe> --before=<옛 프로브.exe> --nsi=<installer.nsi> \
 *     --tree=<격리 트리 루트> --out=docs/critic/lspdist-critic-r1-probe.json
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
const BEFORE = argv('before', '')
const NSI = argv('nsi', '')
const TREE = argv('tree', '')
const OUT = path.resolve(REPO, argv('out', 'docs/critic/lspdist-critic-r1-probe.json'))

const LOCAL = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
/** 빌더의 `ccg-lspdist-r1`과 **이름을 갈랐다** — 남의 산출물을 안 밟는다. */
const BASE = path.join(LOCAL, 'ccg-critic-lspdist')
const DIST = path.join(BASE, 'bundled')
const BARE = path.join(BASE, 'bare')
const SIDE = path.join(BASE, 'sidecar')
const OLD = path.join(BASE, 'before-bare')
const NOWHERE = path.join(BASE, 'nowhere') // cwd 조상에 node_modules가 없는 중립 자리

const log = (...a) => console.log(...a)
const fail = []
const check = (ok, what) => {
  log(`${ok ? '  ✓' : '  ✖'} ${what}`)
  if (!ok) fail.push(what)
  return ok
}

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
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })

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

/** node.exe를 담은 PATH 항목을 전부 걷어낸다(환경변수만 만진다 — 시스템 무변경). */
function scrubNode(p) {
  return (p ?? '')
    .split(path.delimiter)
    .filter((d) => d && !fs.existsSync(path.join(d, 'node.exe')) && !fs.existsSync(path.join(d, 'node')))
    .join(path.delimiter)
}

function runArm({ exeDir, cwd, lang, rel, projRoot, home, samples = 6, scrubPath = false, modulesEnv = null }) {
  const exe = path.join(exeDir, 'ccg-lspprobe.exe')
  const env = { ...process.env, ...PROBE_ENV[lang], CCG_HOME: home }
  delete env.CCG_LSP_MODULES
  delete env.CCG_LSP_NODE
  if (modulesEnv) env.CCG_LSP_MODULES = modulesEnv
  if (scrubPath) env.PATH = scrubNode(env.PATH ?? env.Path)
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
    /* 프로브가 말 없이 죽은 팔 */
  }
  return { exitCode: r.status, wallMs: Date.now() - t, stderrTail: (r.stderr ?? '').trim().slice(-400) || null, probe: json }
}

const out = { critic: 'lspdist-r1', at: new Date().toISOString(), node: process.version, inputs: { PROBE, BEFORE, NSI, TREE } }

try {
  // ── 0. 배포 모사 자리 ──────────────────────────────────────────────────────
  log('[0] 배포 모사 자리')
  for (const d of [DIST, BARE, SIDE, OLD, NOWHERE]) {
    rmrf(d)
    fs.mkdirSync(d, { recursive: true })
  }
  out.deploySim = {}
  for (const [k, d] of Object.entries({ DIST, BARE, SIDE, OLD, NOWHERE })) {
    const anc = ancestorsWithNodeModules(d)
    out.deploySim[k] = { dir: d, ancestorsWithNodeModules: anc }
    check(anc.length === 0, `${k} 조상 사슬에 node_modules 없음`)
  }

  // ── 1. 적재물 — 내가 구운 installer.nsi 그대로 ─────────────────────────────
  log('[1] 적재물(내가 구운 installer.nsi)')
  const re = /^\s*File \/a "\/oname=(node_modules\\[^"]+)" "([^"]+)"\s*$/
  const pairs = []
  for (const line of fs.readFileSync(NSI, 'utf8').split(/\r?\n/)) {
    const m = re.exec(line)
    if (m) pairs.push({ dest: m[1], src: m[2] })
  }
  check(pairs.length > 0, `installer.nsi에서 node_modules 적재 줄 ${pairs.length}개`)
  const stage = path.join(BASE, 'payload')
  rmrf(stage)
  for (const { src, dest } of pairs) {
    const to = path.join(stage, dest)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(src, to)
  }
  const pstat = treeStats(stage)
  const topPkgs = [...new Set(pairs.map((p) => p.dest.split('\\')[1]))].sort()
  out.payload = { nsi: NSI, entries: pairs.length, topPackages: topPkgs, ...pstat }
  log(`    ${pairs.length}개 · ${pstat.mb}MB(원바이트) · ${pstat.onDiskMb}MB(4KiB) · 패키지 ${topPkgs.join(', ')}`)

  fs.copyFileSync(PROBE, path.join(DIST, 'ccg-lspprobe.exe'))
  fs.cpSync(path.join(stage, 'node_modules'), path.join(DIST, 'node_modules'), { recursive: true })
  fs.copyFileSync(PROBE, path.join(BARE, 'ccg-lspprobe.exe'))
  // 사이드카 팔 = 번들 + exe 옆 node.exe
  fs.copyFileSync(PROBE, path.join(SIDE, 'ccg-lspprobe.exe'))
  fs.cpSync(path.join(stage, 'node_modules'), path.join(SIDE, 'node_modules'), { recursive: true })
  const sysNode = scrubNode('') === '' ? null : null
  const realNode = (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((d) => path.join(d, 'node.exe'))
    .find((p) => fs.existsSync(p))
  if (realNode) fs.copyFileSync(realNode, path.join(SIDE, 'node.exe'))
  out.sidecarNodeFrom = realNode ?? null
  void sysNode

  // ── 2. 픽스처 — **격리 트리 안**에 둔다(cwd 조상이 node_modules에 닿게) ────
  log('[2] 픽스처(격리 트리 안 — cwd 미끼)')
  const { FIXTURES } = await import(pathToFileURL(path.join(REPO, 'bench', 'lspfix.mjs')).href)
  const proj = path.join(TREE, 'critic-fx', 'proj')
  fs.mkdirSync(proj, { recursive: true })
  const ts = FIXTURES.ts.make(proj, { blocks: 60 })
  const py = FIXTURES.py.make(proj, { blocks: 60 })
  const anc = ancestorsWithNodeModules(proj)
  out.fixture = { proj, ts: ts.bigRel, py: py.bigRel, ancestorsWithNodeModules: anc }
  check(anc.includes(path.resolve(TREE)), '픽스처 cwd 조상이 격리 트리의 node_modules에 닿는다(= 옛 코드의 미끼가 산다)')

  const { quietHome } = await import(pathToFileURL(path.join(REPO, 'bench', 'lib.mjs')).href)
  const homeFor = (n) => quietHome(path.join(BASE, 'homes', n.replace(/[/\\|]/g, '-')))
  const relOf = (lang) => (lang === 'ts' ? ts.bigRel : py.bigRel)

  // ── 3. 팔 ─────────────────────────────────────────────────────────────────
  const arms = {}
  const go = (key, opts) => {
    const r = runArm({ projRoot: proj, home: homeFor(key), ...opts })
    arms[key] = r
    const p = r.probe ?? {}
    log(
      `    ${key.padEnd(34)} status=${String(p.status).padEnd(11)} hover=${p.hover?.hits ?? '-'}/${p.hover?.n ?? '-'} ` +
        `tok=${p.tokens ?? '-'} node=${p.resolve?.node ? 'y' : 'n'} (${r.wallMs}ms)`
    )
    return r
  }

  log('[3] 기본 네 팔 × 두 언어')
  for (const lang of ['ts', 'py']) {
    go(`bundled/install-cwd|${lang}`, { exeDir: DIST, cwd: DIST, lang, rel: relOf(lang) })
    go(`bundled/project-cwd|${lang}`, { exeDir: DIST, cwd: proj, lang, rel: relOf(lang) })
    go(`bare/install-cwd|${lang}`, { exeDir: BARE, cwd: BARE, lang, rel: relOf(lang) })
    go(`bare/project-cwd|${lang}`, { exeDir: BARE, cwd: proj, lang, rel: relOf(lang) })
  }

  log('[4] ★ PATH에 node가 없는 기계 — 두 언어 × 두 cwd')
  for (const lang of ['ts', 'py']) {
    go(`nonode/bundled/install-cwd|${lang}`, { exeDir: DIST, cwd: DIST, lang, rel: relOf(lang), scrubPath: true, samples: 2 })
    go(`nonode/bundled/project-cwd|${lang}`, { exeDir: DIST, cwd: proj, lang, rel: relOf(lang), scrubPath: true, samples: 2 })
  }

  log('[5] 사이드카 node.exe — 한 파일이면 닫히는가')
  for (const lang of ['ts', 'py']) {
    go(`nonode/sidecar/install-cwd|${lang}`, { exeDir: SIDE, cwd: SIDE, lang, rel: relOf(lang), scrubPath: true, samples: 2 })
  }

  log('[6] 레버·개발 실행')
  go('lever/CCG_LSP_MODULES|ts', { exeDir: BARE, cwd: BARE, lang: 'ts', rel: ts.bigRel, modulesEnv: TREE, samples: 2 })
  // 개발 실행 모사: exe가 <트리>/target-sim/release/ 안 → 조상 사슬이 트리의 node_modules를 문다.
  const DEVEXE = path.join(TREE, 'target-sim', 'release')
  fs.mkdirSync(DEVEXE, { recursive: true })
  fs.copyFileSync(PROBE, path.join(DEVEXE, 'ccg-lspprobe.exe'))
  go('dev/exe-in-tree|cwd=nowhere|ts', { exeDir: DEVEXE, cwd: NOWHERE, lang: 'ts', rel: ts.bigRel, samples: 2 })

  // ── 4. 옛 코드 되짚기 ─────────────────────────────────────────────────────
  if (BEFORE && fs.existsSync(BEFORE)) {
    log('[7] 옛 코드(adcef10^ = 09b9bc7) — 번들 없는 자리, cwd만 다르게')
    fs.copyFileSync(BEFORE, path.join(OLD, 'ccg-lspprobe.exe'))
    for (const lang of ['ts', 'py']) {
      go(`before/bare/install-cwd|${lang}`, { exeDir: OLD, cwd: OLD, lang, rel: relOf(lang), samples: 2 })
      go(`before/bare/project-cwd|${lang}`, { exeDir: OLD, cwd: proj, lang, rel: relOf(lang), samples: 2 })
    }
  }
  out.arms = arms

  // ── 5. 판정 ───────────────────────────────────────────────────────────────
  log('[8] 판정')
  const P = (k) => arms[k]?.probe ?? {}
  for (const lang of ['ts', 'py']) {
    const a = P(`bundled/install-cwd|${lang}`)
    const b = P(`bundled/project-cwd|${lang}`)
    check(a.status === 'ready', `[${lang}] 배포 모사 · cwd=설치 폴더 → ready`)
    check((a.hover?.hits ?? 0) === (a.hover?.n ?? -1) && (a.hover?.n ?? 0) > 0, `[${lang}] 호버 ${a.hover?.hits}/${a.hover?.n}`)
    check(a.status === b.status, `[${lang}] 두 cwd 팔 status 동일(${a.status}/${b.status})`)
    check(
      JSON.stringify(a.resolve?.modules) === JSON.stringify(b.resolve?.modules),
      `[${lang}] 두 cwd 팔이 같은 모듈 파일을 문다`
    )
    check(
      (a.resolve?.modules?.[lang] ?? '').toLowerCase().startsWith(DIST.toLowerCase()),
      `[${lang}] 문 파일이 배포 번들 안이다`
    )
    const c = P(`bare/install-cwd|${lang}`)
    const d = P(`bare/project-cwd|${lang}`)
    check(c.status === 'error' && d.status === 'error', `[${lang}] 번들 없으면 두 팔 다 error(${c.status}/${d.status})`)
    check((d.resolve?.modules?.[lang] ?? null) === null, `[${lang}] ★번들 없는 project-cwd가 레포 것을 안 문다`)
    // ★ 파리티 판정
    const n1 = P(`nonode/bundled/install-cwd|${lang}`)
    const n2 = P(`nonode/bundled/project-cwd|${lang}`)
    check(!!n1.resolve?.modules?.[lang], `[${lang}] node 없어도 **모듈은** 찾는다(진단 정확)`)
    out[`nonode_${lang}`] = {
      installCwd: { status: n1.status ?? null, node: n1.resolve?.node ?? null },
      projectCwd: { status: n2.status ?? null, node: n2.resolve?.node ?? null }
    }
    const s = P(`nonode/sidecar/install-cwd|${lang}`)
    out[`sidecar_${lang}`] = { status: s.status ?? null, node: s.resolve?.node ?? null }
  }
  const lever = P('lever/CCG_LSP_MODULES|ts')
  check(lever.status === 'ready', `CCG_LSP_MODULES 레버가 산다(${lever.status})`)
  const dev = P('dev/exe-in-tree|cwd=nowhere|ts')
  check(dev.status === 'ready', `개발 실행(cwd 조상에 node_modules 0)에서도 ready(${dev.status})`)
  check(
    (dev.resolve?.modules?.ts ?? '').toLowerCase().startsWith(path.resolve(TREE).toLowerCase()),
    'dev 팔이 문 것은 격리 트리의 node_modules다(exe 조상 사슬)'
  )
  if (arms['before/bare/project-cwd|ts']) {
    const bi = P('before/bare/install-cwd|ts')
    const bp = P('before/bare/project-cwd|ts')
    check(bi.status === 'error', '[before·ts] cwd=설치 폴더 → error')
    check(bp.status === 'ready', '[before·ts] ★cwd=프로젝트 → ready = 띠의 존재 실측')
    const qi = P('before/bare/install-cwd|py')
    const qp = P('before/bare/project-cwd|py')
    out.before = { ts: { install: bi.status, project: bp.status }, py: { install: qi.status, project: qp.status } }
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
