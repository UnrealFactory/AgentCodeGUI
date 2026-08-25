// 최종 파리티 R3 — 「한도 축」 증거 파일의 **모든 관측**을 시각순으로 뽑는 수집기.
//
//   node docs/critic/tools/critic-r28f-observations.mjs [--out=json]
//
// ── 왜 ────────────────────────────────────────────────────────────────────────
// R2 감사는 `limit-pop`을 「3.0 5행 실값 vs 2.6.2 4행 데이터 없음 → 역전」이라 적었는데,
// **같은 라운드·같은 홈의 반대 관측**을 한 줄도 인용하지 않았다(확인 크리틱 R1 §3.1).
// 숙제 2번은 「증거 파일의 **모든** 관측을 표로 싣고 고른 이유를 한 줄로 적어라」다.
// 이 도구는 그 표를 사람 손이 아니라 파일에서 기계적으로 뽑는다 — 다음 라운드가 인용을
// 고를 때 「안 실은 관측」이 존재할 수 없게 만드는 게 목적이다.
//
// 훑는 것: `docs/critic/final-parity-r{1,2,3}-*.json`(press · apiprobe) +
//          `bench/shots/{tauri,electron}{,-r28e,-r28e2}/report.json`의 `workbar-context-pop` 행.
import fs from 'node:fs'
import path from 'node:path'
import { REPO } from '../../../bench/lib.mjs'

const argv = process.argv.slice(2)
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d }
const OUT = path.resolve(arg('out', path.join(REPO, 'docs', 'critic', 'final-parity-r3-observations.json')))
const CRIT = path.join(REPO, 'docs', 'critic')
const SHOTS = path.join(REPO, 'bench', 'shots')

const rows = []
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
const shape = (u) => {
  if (u == null) return null
  const o = typeof u === 'string' ? (() => { try { return JSON.parse(u) } catch { return null } })() : u
  if (!o || typeof o !== 'object') return String(u).slice(0, 60)
  const has = o.fiveHour != null || o.weekly != null || o.weeklyFable != null
  return `${has ? '실값' : 'nulls'}${o.unavailable ? '+unavailable' : ''}${o.weeklyFable != null ? ' (Fable행 有)' : ''}`
}

// ── ① press 도구가 화면에서 눌러 본 `limit-pop` ──────────────────────────────
for (const f of fs.readdirSync(CRIT).filter((x) => /^final-parity-r\d.*press.*\.json$/.test(x))) {
  const j = rj(path.join(CRIT, f))
  const c = j?.cases?.['limit-pop']
  if (!c) continue
  rows.push({
    axis: 'limit-pop(press)', source: `docs/critic/${f}`, at: j.at, app: j.app, home: j.home,
    prows: c.prows, hasNoData: c.hasNoData, note: String(c.popText ?? '').slice(0, 90)
  })
}

// ── ② apiprobe가 채널로 직접 물어본 `usage.get` ──────────────────────────────
for (const f of fs.readdirSync(CRIT).filter((x) => /^final-parity-r\d.*apiprobe.*\.json$/.test(x))) {
  const j = rj(path.join(CRIT, f))
  // 키가 **평평한 점 이름**이다(`probes["usage.get"]`) — 중첩으로 읽으면 통째로 놓친다.
  const u = j?.probes?.['usage.get'] ?? j?.probes?.usage?.get
  if (u === undefined) continue
  rows.push({
    axis: 'usage.get(apiprobe)', source: `docs/critic/${f}`, at: j.at, app: j.app ?? j.kind,
    prows: null, hasNoData: shape(u)?.startsWith('nulls') ?? null, note: shape(u)
  })
}

// ── ③ A/B 하네스의 `workbar-context-pop` found ───────────────────────────────
for (const d of fs.existsSync(SHOTS) ? fs.readdirSync(SHOTS) : []) {
  const j = rj(path.join(SHOTS, d, 'report.json'))
  const r = (j?.rows ?? j?.screens ?? []).find((x) => x.id === 'workbar-context-pop')
  if (!r) continue
  rows.push({
    axis: 'workbar-context-pop(A/B found)', source: `bench/shots/${d}/report.json`, at: j.at, app: j.app,
    prows: r.found, hasNoData: r.found === 4 ? true : r.found === 5 ? false : null, note: `ok=${r.ok}${j.mergedFrom ? ` · mergedFrom ${j.mergedFrom}` : ''}`
  })
}

// ── ④ 이 라운드(R3)의 반복 측정 ──────────────────────────────────────────────
for (const f of fs.readdirSync(CRIT).filter((x) => /^final-parity-r3-limitpop-.*\.json$/.test(x))) {
  const j = rj(path.join(CRIT, f))
  for (const r of j?.runs ?? []) {
    rows.push({
      axis: `limit-pop(R3 ${j.arm}${j.userProfileOverride ? '·USERPROFILE 격리' : ''})`,
      source: `docs/critic/${f}#run${r.run}`, at: r.at, app: j.app,
      prows: r.prows, hasNoData: r.hasNoData, note: `계정 ${r.acctCount}개 · usage-cache ${r.usageCacheSeededBytes ?? 0}B · ${shape(r.usageGet)}`
    })
  }
}

rows.sort((a, b) => String(a.at).localeCompare(String(b.at)))
const out = {
  at: new Date().toISOString(),
  what: '한도 축(limit-pop · workbar-context-pop · usage.get)의 **모든** 관측 — 골라 싣지 않는다',
  total: rows.length,
  observations: rows,
  polarity: {
    'tauri prows/found=5 또는 실값': rows.filter((r) => /tauri/.test(String(r.app)) && r.hasNoData === false).length,
    'tauri 4 또는 nulls': rows.filter((r) => /tauri/.test(String(r.app)) && r.hasNoData === true).length,
    'electron 5 또는 실값': rows.filter((r) => /electron/.test(String(r.app)) && r.hasNoData === false).length,
    'electron 4 또는 nulls': rows.filter((r) => /electron/.test(String(r.app)) && r.hasNoData === true).length
  }
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
for (const r of rows) console.log(`${r.at}  ${String(r.app).padEnd(16)} ${r.axis.padEnd(34)} prows=${String(r.prows).padEnd(5)} noData=${String(r.hasNoData).padEnd(6)} ${r.note.slice(0, 70)}`)
console.log(`\n${JSON.stringify(out.polarity)}\ntotal ${rows.length}\nsaved: ${OUT}`)
