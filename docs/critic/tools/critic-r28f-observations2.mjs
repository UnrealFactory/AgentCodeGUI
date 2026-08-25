// 최종 파리티 R4 — 「한도 축」 관측 수집기 **전량판**.
//
//   node docs/critic/tools/critic-r28f-observations2.mjs [--out=json]
//
// ── 왜 R3의 수집기를 다시 쓰는가 (숙제 b · 확인 크리틱 F2) ────────────────────
// R3는 「한도 축 관측 **전량** 27건」이라 적었는데, 그 '전량'은 실제로는 **세 계열**
// (press `limit-pop` · apiprobe `usage.get` · A/B `workbar-context-pop`)에 한정이었다.
// 같은 증거 파일 안에 **같은 축의 다른 표면** 관측이 더 있었고, 하필 §2.6이 T3 「닫힘」의
// 근거로 인용한 「`accounts-usage(cachedOnly)`가 6행」이 바로 그 표 밖 관측이다.
// 「고르지 말고 전량을 실어라」가 숙제였으므로 **선택 규칙을 코드로 못 박는다**:
//
//   포함 규칙 = 「두 앱 중 한쪽이라도 **한도 수치를 사용자에게 보여 주는 표면**의 값이
//               증거 파일에 기록된 자리」 — 표면 이름이 무엇이든, 극성이 어느 쪽이든.
//
// 그 규칙이 잡는 표면은 다섯이다:
//   ① 워크바 컨텍스트 팝오버        (press `limit-pop` · A/B `workbar-context-pop`)
//   ② 팝오버를 먹이는 채널          (`usage.get` — apiprobe **와 rawprobe** 둘 다)
//   ③ 설정 ▸ Account 계정별 한도    (`auth.accountsUsage[(cachedOnly)]`)
//   ④ 설정 ▸ Account Codex 한도     (`codexAuth.accountsUsage`)
//   ⑤ API 과금 사용량               (`apiConfig.listUsage`)
// 여기에 ⑥ **블라인드 판정**(`final-parity-r1-blind.json`의 한도 축 행)을 더한다 —
// R2 §5의 「블라인드에서 UI가 지지 않는가」 칸이 인용한 것이 정확히 그 행이기 때문이다.
//
// 극성 집계는 ①②만으로 한다(③~⑥은 행 수·판정이라 4↔5 극성으로 환산되지 않는다).
// **뺀 관측은 0건이다.** 극성으로 못 세는 것도 표에는 전부 싣는다.
import fs from 'node:fs'
import path from 'node:path'
import { REPO } from '../../../bench/lib.mjs'

const argv = process.argv.slice(2)
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d }
const OUT = path.resolve(arg('out', path.join(REPO, 'docs', 'critic', 'final-parity-r4-observations.json')))
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
// 값이 **잘린 문자열**로 저장된 자리가 있다(프로브가 700자에서 끊는다) — `JSON.parse`가
// 죽으므로 행 수는 `email` 출현으로 센다. 「최소 n행」이라고 적는 이유가 이것이다.
const rowsOf = (v) => {
  if (v == null) return null
  const s = String(v)
  if (/^\s*\[\s*\]\s*$/.test(s)) return 0
  try { const p = JSON.parse(s); if (Array.isArray(p)) return p.length } catch { /* 잘렸다 */ }
  const n = (s.match(/email/g) || []).length
  return n > 0 ? n : null
}
const truncated = (v) => String(v ?? '').length >= 690
// 실계정 이메일은 앞 세 글자만 남긴다(합성 `example.invalid`는 그대로 — 그게 이 라운드의 증표다).
const redact = (s) => String(s).replace(/([A-Za-z0-9._%+-]{3})[A-Za-z0-9._%+-]*@(?!example\.invalid)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '$1…@…')

// ── ① press 도구가 화면에서 눌러 본 `limit-pop` ──────────────────────────────
for (const f of fs.readdirSync(CRIT).filter((x) => /^final-parity-r\d.*press.*\.json$/.test(x))) {
  const j = rj(path.join(CRIT, f))
  const c = j?.cases?.['limit-pop']
  if (!c) continue
  rows.push({
    series: 'A', surface: '팝오버(press)', source: `docs/critic/${f}`, at: j.at, app: j.app, home: j.home,
    prows: c.prows, hasNoData: c.hasNoData, note: String(c.popText ?? '').slice(0, 90)
  })
}

// ── ② `usage.get` — apiprobe **와 rawprobe** 둘 다 ───────────────────────────
//    R3의 수집기는 파일명에 `apiprobe`가 든 것만 훑어서 `final-parity-r3-rawprobe.json`의
//    `usage.get(false)` 한 건을 통째로 놓쳤다(그 27건에 안 들어 있다).
for (const f of fs.readdirSync(CRIT).filter((x) => /^final-parity-r\d.*(apiprobe|rawprobe).*\.json$/.test(x))) {
  const j = rj(path.join(CRIT, f))
  for (const k of ['usage.get', 'usage.get(false)']) {
    const u = j?.probes?.[k]
    if (u === undefined) continue
    rows.push({
      series: 'B', surface: `${k}(채널)`, source: `docs/critic/${f}`, at: j.at, app: j.app ?? j.kind,
      prows: null, hasNoData: shape(u)?.startsWith('nulls') ?? null, note: shape(u)
    })
  }
}

// ── ③ A/B 하네스의 `workbar-context-pop` found ───────────────────────────────
for (const d of fs.existsSync(SHOTS) ? fs.readdirSync(SHOTS) : []) {
  const j = rj(path.join(SHOTS, d, 'report.json'))
  const r = (j?.rows ?? j?.screens ?? []).find((x) => x.id === 'workbar-context-pop')
  if (!r) continue
  rows.push({
    series: 'C', surface: '팝오버(A/B found)', source: `bench/shots/${d}/report.json`, at: j.at, app: j.app,
    prows: r.found, hasNoData: r.found === 4 ? true : r.found === 5 ? false : null,
    note: `ok=${r.ok}${j.mergedFrom ? ` · mergedFrom ${j.mergedFrom}` : ''}`
  })
}

// ── ④ R3의 반복 측정(계정 0 배치) ────────────────────────────────────────────
for (const f of fs.readdirSync(CRIT).filter((x) => /^final-parity-r3-limitpop-.*\.json$/.test(x))) {
  const j = rj(path.join(CRIT, f))
  for (const r of j?.runs ?? []) {
    rows.push({
      series: 'D', surface: `팝오버(R3 ${j.arm}${j.userProfileOverride ? '·USERPROFILE 격리' : ''})`,
      source: `docs/critic/${f}#run${r.run}`, at: r.at, app: j.app,
      prows: r.prows, hasNoData: r.hasNoData,
      note: `계정 ${r.acctCount}개 · usage-cache ${r.usageCacheSeededBytes ?? 0}B · ${shape(r.usageGet)}`
    })
  }
}

// ── ⑤ 설정 ▸ Account의 계정별 한도(클로드) — R3 표에 없던 계열 ───────────────
for (const f of fs.readdirSync(CRIT).filter((x) => /^final-parity-r\d.*(apiprobe|rawprobe).*\.json$/.test(x))) {
  const j = rj(path.join(CRIT, f))
  for (const k of Object.keys(j?.probes ?? {})) {
    if (!/^auth\.accountsUsage/.test(k)) continue
    const v = j.probes[k]
    rows.push({
      series: 'E', surface: `설정▸Account 한도(${k})`, source: `docs/critic/${f}`, at: j.at, app: j.app ?? j.kind,
      prows: null, hasNoData: null,
      note: `${rowsOf(v) === null ? '수치 아님' : `${truncated(v) ? '최소 ' : ''}${rowsOf(v)}행`} :: ${redact(String(v).slice(0, 60))}`
    })
  }
}

// ── ⑥ Codex 한도 · API 과금 사용량 — 같은 규칙에 걸리는 나머지 표면 ──────────
for (const f of fs.readdirSync(CRIT).filter((x) => /^final-parity-r\d.*(apiprobe|rawprobe).*\.json$/.test(x))) {
  const j = rj(path.join(CRIT, f))
  for (const k of Object.keys(j?.probes ?? {})) {
    if (!/^(codexAuth\.accountsUsage|apiConfig\.listUsage)/.test(k)) continue
    const v = j.probes[k]
    rows.push({
      series: 'F', surface: `${k}`, source: `docs/critic/${f}`, at: j.at, app: j.app ?? j.kind,
      prows: null, hasNoData: null, note: `${rowsOf(v)}행 :: ${redact(String(v).slice(0, 50))}`
    })
  }
}

// ── ⑦ 블라인드 판정의 한도 축 행 ─────────────────────────────────────────────
for (const f of fs.readdirSync(CRIT).filter((x) => /^final-parity-r\d.*blind.*\.json$/.test(x))) {
  const j = rj(path.join(CRIT, f))
  for (const r of j?.rows ?? []) {
    if (!/workbar-context-pop|limit/.test(String(r.id))) continue
    rows.push({
      series: 'G', surface: `블라인드 판정(${r.id})`, source: `docs/critic/${f}`, at: j.at, app: `judge:${r.winner}`,
      prows: null, hasNoData: null, note: String(r.note ?? '').slice(0, 100)
    })
  }
}

// ── ⑧ 이 라운드(R4)의 **판별력 있는** 배치 ───────────────────────────────────
for (const f of fs.readdirSync(CRIT).filter((x) => /^final-parity-r4-limitpop-.*\.json$/.test(x))) {
  const j = rj(path.join(CRIT, f))
  for (const r of j?.runs ?? []) {
    const ms = (() => { try { return JSON.parse(r.usageB).ms } catch { return null } })()
    const u = (() => { try { return JSON.parse(r.usageA).v } catch { return null } })()
    rows.push({
      series: 'H', surface: `팝오버(R4 ${j.arm})`, source: `docs/critic/${f}#run${r.run}`, at: r.at, app: j.app,
      prows: r.prows, hasNoData: r.hasNoData,
      note: `계정 ${r.acctCount}개 · 2차 usage:get ${ms}ms · 프록시 CONNECT ${r.proxyHits?.length ?? 0} · ${shape(u)}`
    })
  }
}

rows.sort((a, b) => String(a.at).localeCompare(String(b.at)))
const bySeries = {}
for (const r of rows) bySeries[r.series] = (bySeries[r.series] ?? 0) + 1
const pol = rows.filter((r) => 'ABCD'.includes(r.series))
const out = {
  at: new Date().toISOString(),
  what: '한도 축 관측 **전량** — 포함 규칙: 「한도 수치를 보여 주는 표면의 값이 기록된 자리」. 뺀 관측 0건',
  rule: '표면 5종(팝오버·usage.get·설정 Account 클로드/Codex 한도·API 과금) + 블라인드 판정 행',
  total: rows.length,
  bySeries,
  r3TableCounted: 'A+B(apiprobe만)+C+D = 27건 — R3가 「전량」이라 부른 범위',
  observations: rows,
  polarity: {
    scope: 'A~D(팝오버·usage.get)만 — E~H는 행 수/판정이라 4↔5 극성이 없다',
    'tauri 값 있음': pol.filter((r) => /tauri/.test(String(r.app)) && r.hasNoData === false).length,
    'tauri 데이터 없음': pol.filter((r) => /tauri/.test(String(r.app)) && r.hasNoData === true).length,
    'electron 값 있음': pol.filter((r) => /electron/.test(String(r.app)) && r.hasNoData === false).length,
    'electron 데이터 없음': pol.filter((r) => /electron/.test(String(r.app)) && r.hasNoData === true).length
  }
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
for (const r of rows) console.log(`${r.series} ${r.at}  ${String(r.app).padEnd(16)} ${r.surface.padEnd(38)} prows=${String(r.prows).padEnd(5)} noData=${String(r.hasNoData).padEnd(6)} ${String(r.note).slice(0, 62)}`)
console.log(`\nbySeries ${JSON.stringify(bySeries)}\n${JSON.stringify(out.polarity)}\ntotal ${rows.length}\nsaved: ${OUT}`)
