#!/usr/bin/env node
/**
 * `critic-lspdist-r3` — LSPDIST R3(마감) 확인 크리틱의 **표적 계기**.
 *
 * 새 축은 안 판다. 확인 크리틱 R2가 남긴 것만 겨눈다:
 *   R2-C1  죽을 때 하는 말이 틀렸다      → 유실 팔의 **실패 문자열 전문**을 검사
 *   R2-L2  게이트가 상류보다 약하다      → **G6 재실측**(R2에서 ready였다) + 개발 팔 무후퇴
 *   R2-C2  계약이 출처를 안 본다        → E1~E4는 `--mutations`(cargo)로 따로
 *
 * ★ 이 라운드의 새 위험: 게이트를 좁히면(`target` 폴더명 AND) **진짜 개발 판이 죽을 수** 있다.
 * 그래서 개발 배치를 다섯 모양으로 만들어 어느 것이 열리고 어느 것이 닫히는지 표로 뽑는다.
 * 판정 재료는 「미끼 node를 무는가」다 — 미끼는 **진짜 node의 사본**이라 물면 `ready`가 되어
 * 게이트가 열린 것이 시끄럽게 드러난다(안 도는 가짜를 쓰면 「어차피 error」와 구별이 안 된다).
 *
 * 규율: 이름 기반 kill 0 · 전 팔 `CCG_HOME` 격리 · 실홈 무접촉 · 시스템 PATH 무변경.
 *
 * 사용:
 *   node docs/critic/tools/critic-lspdist-r3.mjs \
 *     --probe=<프로브.exe> --tree=<격리 트리> --out=docs/critic/lspdist-critic-r3-probe.json
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
const TREE = argv('tree', '')
const OUT = path.resolve(REPO, argv('out', 'docs/critic/lspdist-critic-r3-probe.json'))

const LOCAL = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
const BASE = path.join(LOCAL, 'ccg-critic-lspdist-r3')
const BAIT = path.join(BASE, 'bait-path')
const NOWHERE = path.join(BASE, 'nowhere')

const log = (...a) => console.log(...a)
const fail = []
const check = (ok, what) => {
  log(`${ok ? '  ✓' : '  ✖'} ${what}`)
  if (!ok) fail.push(what)
  return ok
}
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })

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
const scrubNode = (p) =>
  (p ?? '')
    .split(path.delimiter)
    .filter((d) => d && !fs.existsSync(path.join(d, 'node.exe')) && !fs.existsSync(path.join(d, 'node')))
    .join(path.delimiter)

function runArm({ exeDir, cwd, lang, rel, projRoot, home, samples = 2, pathMode = 'asis' }) {
  const env = { ...process.env, ...PROBE_ENV[lang], CCG_HOME: home }
  delete env.CCG_LSP_MODULES
  delete env.CCG_LSP_NODE
  if (pathMode === 'nonode') env.PATH = scrubNode(env.PATH ?? env.Path)
  if (pathMode === 'bait') env.PATH = [BAIT, scrubNode(env.PATH ?? env.Path)].filter(Boolean).join(path.delimiter)
  delete env.Path
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
    /* 말 없이 죽은 팔 */
  }
  return { exitCode: r.status, probe: json }
}

const out = { critic: 'lspdist-r3', at: new Date().toISOString(), inputs: { PROBE, TREE } }

try {
  log('[0] 자리 만들기')
  rmrf(BASE)
  for (const d of [BAIT, NOWHERE]) fs.mkdirSync(d, { recursive: true })
  const realNode = (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((d) => path.join(d, 'node.exe'))
    .find((p) => fs.existsSync(p))
  check(!!realNode, 'PATH에서 진짜 node.exe를 찾았다(미끼 재료 — 사본이라 물면 ready가 된다)')
  fs.copyFileSync(realNode, path.join(BAIT, 'node.exe'))
  const stagedNode = path.join(TREE, 'src-tauri', 'lsp-runtime', 'node.exe')
  check(fs.existsSync(stagedNode), `스테이징 산출물이 있다 (${stagedNode})`)
  const mods = path.join(TREE, 'node_modules')

  /** 배치 하나 굽기. `modules`는 정션 대신 실제 사본(조상 오염을 피하려고 exe 옆에 둔다). */
  const NM_CACHE = path.join(BASE, 'nm')
  fs.mkdirSync(NM_CACHE, { recursive: true })
  for (const p of [
    ['typescript-language-server', 'lib'],
    ['typescript-language-server', 'package.json'],
    ['typescript', 'lib'],
    ['typescript', 'package.json'],
    ['pyright']
  ]) {
    const from = path.join(mods, ...p)
    const to = path.join(NM_CACHE, 'node_modules', ...p)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.cpSync(from, to, { recursive: true })
  }
  const make = (rel, { sidecar = false, cargoLock = false } = {}) => {
    const dir = path.join(BASE, rel)
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(PROBE, path.join(dir, 'ccg-lspprobe.exe'))
    fs.cpSync(path.join(NM_CACHE, 'node_modules'), path.join(dir, 'node_modules'), { recursive: true })
    if (sidecar) fs.copyFileSync(stagedNode, path.join(dir, 'node.exe'))
    if (cargoLock) fs.writeFileSync(path.join(dir, '.cargo-lock'), '')
    return dir
  }

  log('[1] 픽스처')
  const { FIXTURES } = await import(pathToFileURL(path.join(REPO, 'bench', 'lspfix.mjs')).href)
  const proj = path.join(TREE, 'critic-fx-r3', 'proj')
  fs.mkdirSync(proj, { recursive: true })
  const ts = FIXTURES.ts.make(proj, { blocks: 60 })
  const py = FIXTURES.py.make(proj, { blocks: 60 })
  const { quietHome } = await import(pathToFileURL(path.join(REPO, 'bench', 'lib.mjs')).href)
  const homeFor = (n) => quietHome(path.join(BASE, 'homes', n.replace(/[/\\|=+]/g, '-')))
  const relOf = (l) => (l === 'ts' ? ts.bigRel : py.bigRel)

  const arms = {}
  const go = (key, opts) => {
    const r = runArm({ projRoot: proj, home: homeFor(key), ...opts })
    arms[key] = r
    const p = r.probe ?? {}
    const n = p.resolve?.node
    log(
      `    ${key.padEnd(44)} ${String(p.status).padEnd(7)} node=${n ? path.basename(path.dirname(n)) + '\\' + path.basename(n) : 'null'}`
    )
    return r
  }

  // ── A. 온전한 배포본 회귀 가드 ────────────────────────────────────────────
  log('[2] 온전한 배포본(회귀 가드) — PATH에 node 없음')
  const deployed = make('deployed', { sidecar: true })
  for (const lang of ['ts', 'py']) {
    go(`deployed/nonode|${lang}`, { exeDir: deployed, cwd: deployed, lang, rel: relOf(lang), pathMode: 'nonode', samples: 6 })
  }

  // ── B. ★ G6 재실측 ────────────────────────────────────────────────────────
  log('[3] ★ G6 재실측 — $INSTDIR에 .cargo-lock 심기 + 미끼 node를 PATH 첫 칸')
  const forged = make('forged-cargolock', { sidecar: false, cargoLock: true })
  for (const lang of ['ts', 'py']) go(`G6/forged-cargolock+bait|${lang}`, { exeDir: forged, cwd: forged, lang, rel: relOf(lang), pathMode: 'bait' })

  // ── C. ★ 사이드카 유실 — 실패 문자열 전문 ────────────────────────────────
  log('[4] ★ 사이드카 유실(백신 격리 모사) — PATH에 진짜 node를 둔 채')
  const lost = make('sidecar-lost', { sidecar: false })
  for (const lang of ['ts', 'py']) go(`lost/realnode-on-PATH|${lang}`, { exeDir: lost, cwd: lost, lang, rel: relOf(lang), pathMode: 'asis' })

  // ── D. ★ 개발 팔 무후퇴 — 게이트를 좁힌 대가 ─────────────────────────────
  // 전부 `.cargo-lock` 있음 · 사이드카 없음 · 조상에 스테이징본 없음.
  // 유일한 변수는 **폴더 모양**이고, 판정 재료는 「미끼 node를 무는가」다.
  log('[5] ★ 개발 배치 다섯 모양 — 어디가 열리고 어디가 닫히나')
  const shapes = [
    ['dev/target-release', path.join('gate', 'a', 'target', 'release')],
    ['dev/target-lspdist-release', path.join('gate', 'b', 'target-lspdist', 'release')],
    ['dev/target-triple-release', path.join('gate', 'c', 'target', 'x86_64-pc-windows-msvc', 'release')],
    ['dev/CUSTOM-suffix-target', path.join('gate', 'd', 'ccg-critic-r3-target', 'release')],
    ['dev/CUSTOM-build-out', path.join('gate', 'e', 'build', 'release')]
  ]
  for (const [name, rel] of shapes) {
    const dir = make(rel, { sidecar: false, cargoLock: true })
    go(`${name}|ts`, { exeDir: dir, cwd: dir, lang: 'ts', rel: ts.bigRel, pathMode: 'bait' })
  }
  // 실제 개발 실행(스테이징을 한 번이라도 돌린 개발자) — 게이트와 무관하게 ③이 받친다
  const devReal = path.join(TREE, 'target-sim', 'release')
  fs.mkdirSync(devReal, { recursive: true })
  fs.copyFileSync(PROBE, path.join(devReal, 'ccg-lspprobe.exe'))
  fs.writeFileSync(path.join(devReal, '.cargo-lock'), '')
  go('dev/staged-ancestor|nonode|ts', { exeDir: devReal, cwd: NOWHERE, lang: 'ts', rel: ts.bigRel, pathMode: 'nonode' })

  out.arms = arms

  // ── 판정 ──────────────────────────────────────────────────────────────────
  log('[6] 판정')
  const P = (k) => arms[k]?.probe ?? {}
  const sidecar = path.join(deployed, 'node.exe').toLowerCase()
  for (const lang of ['ts', 'py']) {
    const d = P(`deployed/nonode|${lang}`)
    check(d.status === 'ready', `[회귀] [${lang}] 온전한 배포본 · PATH에 node 없음 → ready`)
    check((d.resolve?.node ?? '').toLowerCase() === sidecar, `[회귀] [${lang}] node = 배포 사이드카`)
    // ★ G6
    const g = P(`G6/forged-cargolock+bait|${lang}`)
    check(g.status === 'error', `★[G6] [${lang}] .cargo-lock 심어도 error (R2에서는 ready였다)`)
    check((g.resolve?.node ?? null) === null, `★[G6] [${lang}] 미끼 node를 안 문다 (${g.resolve?.node})`)
  }

  // ★ 실패 문자열 — 「자리가 문장에 있는가」로 본다(문구 암기가 아니라)
  const L = P('lost/realnode-on-PATH|ts')
  const msg = L.resolve?.launchError ?? ''
  out.lostArm = { status: L.status ?? null, node: L.resolve?.node ?? null, launchError: msg, nodeHint: L.resolve?.nodeHint ?? null }
  log('\n    ── 유실 팔이 하는 말(전문) ──')
  for (const ln of String(msg).split('\n')) log(`      ${ln}`)
  log('')
  check(L.status === 'error', '★[유실] 사이드카 없으면 error(PATH에 진짜 node가 있어도)')
  check((L.resolve?.node ?? null) === null, '★[유실] resolve.node=null — PATH의 진짜 node를 안 문다')
  const lower = String(msg).toLowerCase()
  check(lower.includes(path.join(lost, 'node.exe').toLowerCase()), '★[말] ② 설치 폴더 사이드카 경로가 문장에 있다')
  check(lower.includes('resources'), '★[말] ② resources 사이드카 자리가 문장에 있다')
  check(lower.includes('lsp-runtime') || lower.includes('src-tauri'), '★[말] ③ 개발 스테이징 자리가 문장에 있다')
  check(lower.includes('ccg_lsp_node'), '★[말] ① CCG_LSP_NODE 레버가 문장에 있다')
  check(!msg.includes('PATH 순으로 찾는다'), '★[말] R2의 거짓말("PATH 순으로 찾는다")이 사라졌다')
  // 문구를 암기시키지 않는다 — 「PATH 칸이 배포본에서 닫혔다는 사실이 문장에 있는가」만 본다.
  check(
    /PATH/.test(msg) && /(보지 않는다|안 본다|not consulted|will not help)/i.test(msg),
    '★[말] "배포본은 PATH를 안 본다"가 있다'
  )
  check(/(다시 설치|reinstall)/i.test(msg), '★[말] 사용자가 할 일(재설치)을 말한다')
  check(/[A-Za-z]{4,}/.test(msg) && /[가-힣]/.test(msg), '★[말] ko/en 두 벌이 한 문자열에 있다')

  // ★ 개발 팔
  const openOf = (k) => {
    const p = P(k)
    return {
      status: p.status ?? null,
      node: p.resolve?.node ?? null,
      open: (p.resolve?.node ?? '').toLowerCase().startsWith(BAIT.toLowerCase()),
      // 닫힌 팔은 **뭐라고 말하는지**까지 남긴다 — 잔여 위험의 크기가 거기서 정해진다.
      launchError: p.resolve?.launchError ?? null
    }
  }
  out.devGate = Object.fromEntries(shapes.map(([n]) => [n, openOf(`${n}|ts`)]))
  check(openOf('dev/target-release|ts').open, '[개발] target/release → 게이트 열림(무후퇴)')
  check(openOf('dev/target-lspdist-release|ts').open, '[개발] target-lspdist/release → 열림(이 레포의 관례)')
  check(openOf('dev/target-triple-release|ts').open, '[개발] target/<triple>/release → 열림(크로스 빌드)')
  const devStaged = P('dev/staged-ancestor|nonode|ts')
  check(devStaged.status === 'ready', '[개발] 스테이징을 돌린 개발자는 PATH 없이도 ready(③)')
  check(
    (devStaged.resolve?.node ?? '').toLowerCase() === path.join(TREE, 'src-tauri', 'lsp-runtime', 'node.exe').toLowerCase(),
    '[개발] 그 팔이 문 것은 조상의 스테이징 산출물'
  )

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
