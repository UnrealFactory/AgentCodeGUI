#!/usr/bin/env node
/**
 * ★LSPIDLE R3 [A급] — **40분 인덱싱이 일하는 중에 끊기는가**(크리틱 R2 §3의 그 표).
 *
 * 확인 크리틱 R2가 반증한 문장은 이것이다:
 *
 *   > 이 눈금은 진짜로 일하는 서버를 안 죽인다: 30분이 걸리든 두 시간이 걸리든
 *   > 진행 신호가 흐르는 동안은 유예가 이어진다.
 *
 * 크리틱은 배포되는 네 스펙에 40분짜리 인덱싱을 먹이고 **통지 간격만** 훑어, 6분·10분
 * 간격에서 ts·py가 11·15분에, cs·cpp가 35분에 **일하는 중** 회수되는 것을 보였다.
 *
 * 이 계기는 그 시나리오를 **전과 후에서 각각** 돌린다:
 *   - `before` — R2의 값(멎음 유예 5분 상수)
 *   - `after`  — R3의 값(스펙 필드 `stall_grace_ms`: ts·py 15분 / cs·cpp 30분)
 *
 * 규칙 자체는 손대지 않는다 — **값만 갈아 끼운다.** 그래야 「무엇이 고쳤는가」가 값이라는
 * 것이 드러나고, 규칙을 바꿔 표를 만든 것이 아님이 보인다. 값은 제품 스펙
 * (`crates/ccg-lsp/src/spec.rs`)에서 읽어 오고, `before`만 5분으로 덮는다.
 *
 * ```
 * node scripts/poc-lspidle-r3-grace.mjs [--out bench/results/poc-lspidle-r3-grace.json]
 * ```
 *
 * 이 파일이 Rust 못과 **따로** 있는 이유: 못은 「지금 값에서 안 끊긴다」를 지키고,
 * 이 계기는 「옛 값에서는 끊겼다」까지 같이 보여 준다. 뒤엣것은 회귀 못이 될 수 없다
 * (옛 값이 제품에 없으므로) — 그래서 증거로만 남긴다.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d
}
const OUT = arg('out', join(REPO, 'bench', 'results', 'poc-lspidle-r3-grace.json'))
const MIN = 60_000

/** 제품 스펙에서 네 서버의 눈금을 **읽어 온다**(계기가 값을 따로 적어 두지 않게). */
function readSpecs() {
  const src = readFileSync(join(REPO, 'crates', 'ccg-lsp', 'src', 'spec.rs'), 'utf8')
  const out = []
  // `id: "ts",` … `idle_ttl_ms: 10 * 60_000,` … `stall_grace_ms: 15 * 60_000,`
  const re = /id:\s*"([a-z+]+)"/g
  let m
  while ((m = re.exec(src))) {
    const tail = src.slice(m.index, m.index + 20000)
    const ttl = /idle_ttl_ms:\s*(\d+)\s*\*\s*60_000/.exec(tail)
    const stall = /stall_grace_ms:\s*(\d+)\s*\*\s*60_000/.exec(tail)
    if (ttl && stall) out.push({ id: m[1], ttlMin: +ttl[1], stallMin: +stall[1] })
  }
  if (out.length !== 4) throw new Error(`스펙을 4개 못 읽었다(${out.length}) — 계기가 낡았다`)
  return out
}

/**
 * `lifecycle.rs`의 규칙을 그대로 옮긴 것 — 40분 인덱싱 동안 **회수가 나는 분**을 돌려준다.
 * (null = 안 끊겼다). 1분 간격 스윕은 제품의 `SWEEP_EVERY_MS_DEFAULT`와 같다.
 */
function cutAt({ ttlMin, stallMin }, gapMin, totalMin = 40) {
  let lastUsed = 0
  let lastWork = 0
  for (let now = 1; now <= totalMin; now++) {
    if (now % gapMin === 0) lastWork = now // 서버가 진행 통지를 흘렸다
    if (now - lastUsed < ttlMin) continue // Keep
    // indexing = true 인 시나리오다(40분 내내 인덱싱)
    if (now - lastWork >= stallMin) return now // Reclaim — 일하는 중인데 접혔다
  }
  return null
}

const GAPS = [1, 2, 4, 5, 6, 10]
const specs = readSpecs()
const arms = {
  // R2가 쓰던 값: 엔진 상수 하나(5분)가 네 서버 전부에 걸렸다
  before: specs.map((s) => ({ ...s, stallMin: 5 })),
  // R3의 값: 스펙 필드
  after: specs
}

const table = {}
for (const [arm, list] of Object.entries(arms)) {
  table[arm] = {}
  for (const s of list) {
    table[arm][s.id] = Object.fromEntries(GAPS.map((g) => [`${g}분`, cutAt(s, g)]))
  }
}

const cutCount = (arm) =>
  Object.values(table[arm]).reduce((a, row) => a + Object.values(row).filter((v) => v != null).length, 0)

const evidence = {
  harness: 'poc-lspidle-r3-grace',
  at: new Date().toISOString(),
  measures: '40분 인덱싱 · 진행 통지 간격별 「일하는 중 회수」가 나는 분(null = 안 끊김)',
  gapsMin: GAPS,
  specs: Object.fromEntries(specs.map((s) => [s.id, { ttlMin: s.ttlMin, stallMinAfter: s.stallMin, stallMinBefore: 5 }])),
  table,
  cutsBefore: cutCount('before'),
  cutsAfter: cutCount('after'),
  verdict: cutCount('after') === 0 ? '새 값에서는 한 칸도 안 끊긴다' : '★아직 끊기는 칸이 있다'
}
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(evidence, null, 1) + '\n')

const fmt = (v) => (v == null ? '안 끊김' : `${v}분에 회수`)
for (const arm of ['before', 'after']) {
  console.log(`\n[${arm === 'before' ? 'R2 값(멎음 5분 상수)' : 'R3 값(스펙 필드)'}]`)
  console.log(`  통지간격 ${GAPS.map((g) => String(g + '분').padStart(9)).join('')}`)
  for (const s of arms[arm]) {
    const row = GAPS.map((g) => fmt(table[arm][s.id][`${g}분`]).padStart(9)).join('')
    console.log(`  ${(s.id + `(TTL${s.ttlMin}·멎음${s.stallMin})`).padEnd(9)}${row}`)
  }
}
console.log(`\n끊긴 칸: before=${evidence.cutsBefore} → after=${evidence.cutsAfter} · ${evidence.verdict}`)
console.log(`saved: ${OUT}`)
