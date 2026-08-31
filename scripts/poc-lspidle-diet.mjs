#!/usr/bin/env node
/**
 * ★LSPIDLE R1 PoC ② — **유령 바이트를 뺀 번들이 실제로 도는가.**
 *
 * `scripts/tauri-build.mjs::stageLspModules`가 만드는 「거른 사본」은 설치기에 실릴 바로 그
 * 파일 집합이다. 뺀 것이 정말 아무도 안 쓰는 바이트였는지는 **그 사본만 보게 하고 서버를
 * 띄워** 확인해야 한다 — 레포의 node_modules가 옆에 있는 채로 재면 무엇을 물었는지 모른다.
 *
 * 그래서 `CCG_LSP_MODULES`(사슬 ① — 벤치·하네스용 문)를 스테이징 폴더로 못박아
 * `ccg-lspprobe`를 돌린다. 그 프로브는 실물 서버에 붙어 호버·정의·완성·토큰을 다 재므로,
 * 「기동했다」가 아니라 **「기능이 돈다」**가 확인된다.
 *
 * 두 팔을 잰다:
 *   ① 레포 원본(`<repo>`)      — 다이어트 전과 같은 파일 집합
 *   ② 거른 사본(`lsp-modules`) — 설치기에 실릴 집합
 * 두 팔의 적중 수가 같아야 통과다. 속도는 참고로만 싣는다(같은 기계·다른 순간이라 흔들린다).
 *
 * 실행: node scripts/poc-lspidle-diet.mjs
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = path.join(REPO, 'target-lspidle')
const STAGE = path.join(REPO, 'src-tauri', 'lsp-modules')
const NODE_EXE = path.join(REPO, 'src-tauri', 'lsp-runtime', 'node.exe')
const WORK = path.join(os.tmpdir(), 'ccg-lspidle-diet-work')
const REL = 'src/big.ts'

function makeFixture() {
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.mkdirSync(path.join(WORK, 'src'), { recursive: true })
  fs.writeFileSync(path.join(WORK, 'package.json'), JSON.stringify({ name: 'ccg-diet-fixture', private: true }, null, 2))
  fs.writeFileSync(
    path.join(WORK, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true, noEmit: true }, include: ['src/*.ts'] }, null, 2)
  )
  // `ccg-lspprobe`의 기본 표본(makeConfig·summarize)과 크로스 파일 목적지(lib.ts)를 맞춘다.
  fs.writeFileSync(
    path.join(WORK, 'src', 'lib.ts'),
    [
      'export interface BenchConfig { id: number; name: string }',
      'export function makeConfig(id: number, name: string): BenchConfig { return { id, name } }',
      'export class BenchRegistry { private m = new Map<number, BenchConfig>()',
      '  register(c: BenchConfig) { this.m.set(c.id, c) }',
      '  lookup(id: number) { return this.m.get(id) }',
      '  get size() { return this.m.size } }',
      'export function summarize(r: BenchRegistry, ids: number[]): number { return ids.filter((i) => r.lookup(i)).length }',
      'export const registry = new BenchRegistry()'
    ].join('\n') + '\n'
  )
  const body = [
    `import { makeConfig, summarize, registry, BenchConfig } from './lib'`,
    '// EDIT-ANCHOR'
  ]
  for (let i = 0; i < 200; i++) {
    body.push(
      `export function step${i}(): number {`,
      `  const local${String(i).padStart(4, '0')}: BenchConfig = makeConfig(${i}, 'n${i}')`,
      `  registry.register(local${String(i).padStart(4, '0')})`,
      `  return summarize(registry, [${i}])`,
      `}`
    )
  }
  fs.writeFileSync(path.join(WORK, 'src', 'big.ts'), body.join('\n') + '\n')
}

function build() {
  const r = spawnSync(
    'cargo',
    ['build', '--release', '-p', 'ccg-lsp', '--features', 'cli', '--bin', 'ccg-lspprobe'],
    { cwd: REPO, env: { ...process.env, CARGO_TARGET_DIR: TARGET }, stdio: 'inherit' }
  )
  if (r.status !== 0) throw new Error(`cargo build 종료 코드 ${r.status}`)
}

/** 프로브를 한 팔 돌린다. `modulesRoot` = `node_modules`를 **담고 있는** 폴더. */
function probe(label, modulesRoot) {
  const exe = path.join(TARGET, 'release', 'ccg-lspprobe.exe')
  const home = path.join(os.tmpdir(), `ccg-lspidle-diet-home-${label}`)
  fs.rmSync(home, { recursive: true, force: true })
  const child = spawnSync(exe, [WORK, REL, '12'], {
    env: {
      ...process.env,
      CCG_HOME: home,
      CCG_LSP_MODULES: modulesRoot,
      CCG_LSP_NODE: NODE_EXE,
      CCG_LSPPROBE_CROSS: 'lib.ts'
    },
    encoding: 'utf8',
    timeout: 300000,
    windowsHide: false
  })
  const line = (child.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop()
  if (!line) throw new Error(`${label}: 프로브가 JSON을 안 냈다\n${child.stderr}`)
  return JSON.parse(line)
}

function dirBytes(dir) {
  let n = 0
  let files = 0
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        n += fs.statSync(p).size
        files += 1
      }
    }
  }
  walk(dir)
  return { bytes: n, files }
}

function main() {
  if (!fs.existsSync(STAGE)) {
    console.error(`[poc] 거른 사본이 없다: ${STAGE}\n[poc]   먼저 \`node scripts/tauri-build.mjs stage\`를 돌려라.`)
    process.exit(1)
  }
  makeFixture()
  build()

  // 크기 — 뺀 것이 얼마인가(설치기에 실릴 집합과 레포 원본의 차).
  const conf = JSON.parse(fs.readFileSync(path.join(REPO, 'src-tauri', 'tauri.conf.json'), 'utf8'))
  const tails = Object.values(conf.bundle.resources)
    .filter((d) => typeof d === 'string' && d.startsWith('node_modules/'))
    .map((d) => d.slice('node_modules/'.length))
  let raw = { bytes: 0, files: 0 }
  let cut = { bytes: 0, files: 0 }
  for (const t of tails) {
    const a = path.join(REPO, 'node_modules', ...t.split('/'))
    const b = path.join(STAGE, 'node_modules', ...t.split('/'))
    const one = (p) => (fs.statSync(p).isDirectory() ? dirBytes(p) : { bytes: fs.statSync(p).size, files: 1 })
    const ra = one(a)
    const rb = one(b)
    raw = { bytes: raw.bytes + ra.bytes, files: raw.files + ra.files }
    cut = { bytes: cut.bytes + rb.bytes, files: cut.files + rb.files }
  }

  const arms = { repo: probe('repo', REPO), staged: probe('staged', STAGE) }

  const checks = []
  const nail = (name, ok, detail) => checks.push({ name, ok: !!ok, detail })
  const mb = (n) => (n / 1048576).toFixed(2)

  for (const [k, a] of Object.entries(arms)) {
    nail(`${k}: 서버가 ready로 뜬다`, a.status === 'ready', `status=${a.status} launchError=${a.resolve?.launchError ?? '—'}`)
  }
  // ★ 다이어트 팔이 **정말 사본을 물었는가** — 아니면 아래 동치 비교는 공짜로 통과한다.
  nail(
    '★거른 사본을 물었다(레포가 아니라)',
    String(arms.staged.resolve?.modules?.ts ?? '').startsWith(STAGE) &&
      String(arms.staged.resolve?.modules?.['ts.tsserver'] ?? '').startsWith(STAGE),
    `${arms.staged.resolve?.modules?.ts}`
  )
  nail(
    '레포 팔은 레포를 물었다(대조군)',
    String(arms.repo.resolve?.modules?.ts ?? '').startsWith(path.join(REPO, 'node_modules')),
    `${arms.repo.resolve?.modules?.ts}`
  )
  // 기능 동치 — 「떴다」가 아니라 「돈다」
  nail(
    '★호버 적중이 두 팔에서 같다',
    arms.repo.hover.hits > 0 && arms.staged.hover.hits === arms.repo.hover.hits,
    `repo ${arms.repo.hover.hits}/${arms.repo.hover.n} · staged ${arms.staged.hover.hits}/${arms.staged.hover.n}`
  )
  nail(
    '★정의 이동(크로스 파일)이 두 팔에서 같다',
    arms.repo.definition.crossFile > 0 && arms.staged.definition.crossFile === arms.repo.definition.crossFile,
    `repo ${arms.repo.definition.crossFile} · staged ${arms.staged.definition.crossFile}`
  )
  nail(
    '★시맨틱 토큰 수가 두 팔에서 같다',
    (arms.repo.tokens ?? 0) > 0 && arms.staged.tokens === arms.repo.tokens,
    `repo ${arms.repo.tokens} · staged ${arms.staged.tokens}`
  )
  nail(
    '자동완성 후보 수가 두 팔에서 같다',
    (arms.repo.completion?.maxItems ?? 0) > 0 && arms.staged.completion?.maxItems === arms.repo.completion?.maxItems,
    `repo ${arms.repo.completion?.maxItems}(${(arms.repo.completion?.sample ?? []).join(",")}) · staged ${arms.staged.completion?.maxItems}(${(arms.staged.completion?.sample ?? []).join(",")})`
  )
  nail(
    '★실제로 줄었다',
    cut.bytes < raw.bytes,
    `${mb(raw.bytes)}MB(${raw.files}개) → ${mb(cut.bytes)}MB(${cut.files}개) · −${mb(raw.bytes - cut.bytes)}MB`
  )

  const out = {
    harness: 'poc-lspidle-diet',
    at: new Date().toISOString(),
    stage: STAGE,
    size: {
      rawBytes: raw.bytes,
      rawFiles: raw.files,
      stagedBytes: cut.bytes,
      stagedFiles: cut.files,
      savedBytes: raw.bytes - cut.bytes,
      savedFiles: raw.files - cut.files
    },
    arms,
    checks
  }
  fs.writeFileSync(path.join(REPO, 'bench', 'results', 'poc-lspidle-diet.json'), JSON.stringify(out, null, 2) + '\n')

  console.log('')
  for (const c of checks) console.log(`  ${c.ok ? '✔' : '✖'} ${c.name} — ${c.detail}`)
  const bad = checks.filter((c) => !c.ok)
  console.log(`\n[poc] ${checks.length - bad.length}/${checks.length} 통과 · 결과: bench/results/poc-lspidle-diet.json`)
  fs.rmSync(WORK, { recursive: true, force: true })
  process.exit(bad.length ? 1 : 0)
}

main()
