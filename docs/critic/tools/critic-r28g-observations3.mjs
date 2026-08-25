// 최종 파리티 R5 — 「한도 축」 관측 수집기 **전량 + 마크다운 표**판.
//
//   node docs/critic/tools/critic-r28g-observations3.mjs [--out=json] [--md=md]
//
// ── R4의 수집기(critic-r28f-observations2.mjs)에서 무엇이 달라졌나 ────────────
// ① 규칙은 그대로다(아래 한 줄). 바꾸면 「전량」의 뜻이 라운드마다 달라진다.
// ② R5(이 라운드)의 주행 계열 **I**를 더한다 — `final-parity-r5-limitpop-*.json`.
//    거기에는 스텁 양성 대조 팔(`arm=stub`)도 들어 있다.
// ③ 숙제 「증거 파일의 **모든 관측**을 표로 싣고 고른 이유를 한 줄로」를 위해
//    **마크다운 표를 파일로 뱉는다**(`--md=`) — 보고서 본문이 집계 숫자가 아니라
//    행 전량을 싣게 하기 위해서다(확인 크리틱 R28f-AUDIT-R2 G3).
//
//   ★고른 이유(한 줄) = 「두 앱 중 한쪽이라도 **한도 수치를 사용자에게 보여 주는 표면**의
//     값이 증거 파일에 기록된 자리」면 표면 이름·극성·유불리와 무관하게 전부 싣는다.
//
// 그 규칙이 잡는 표면은 다섯 + 판정 하나다:
//   ① 워크바 컨텍스트 팝오버 ② 팝오버를 먹이는 채널(`usage.get`) ③ 설정▸Account 클로드 한도
//   ④ 같은 화면 Codex 한도 ⑤ API 과금 사용량 ⑥ 블라인드 판정의 한도 축 행.
// 극성 집계는 ①②(계열 A~D·H·I)만 — ③~⑥은 행 수/판정이라 4↔5 극성으로 안 환산된다.
import fs from 'node:fs'
import path from 'node:path'
import { REPO } from '../../../bench/lib.mjs'

const argv = process.argv.slice(2)
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d }
const OUT = path.resolve(arg('out', path.join(REPO, 'docs', 'critic', 'final-parity-r5-observations.json')))
const MD = arg('md', '') ? path.resolve(arg('md')) : null
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
const rowsOf = (v) => {
  if (v == null) return null
  const s = String(v)
  if (/^\s*\[\s*\]\s*$/.test(s)) return 0
  try { const p = JSON.parse(s); if (Array.isArray(p)) return p.length } catch { /* 잘렸다 */ }
  const n = (s.match(/email/g) || []).length
  return n > 0 ? n : null
}
const truncated = (v) => String(v ?? '').length >= 690
const redact = (s) => String(s).replace(/([A-Za-z0-9._%+-]{3})[A-Za-z0-9._%+-]*@(?!example\.invalid)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '$1…@…')

// ── A. press 도구가 화면에서 눌러 본 `limit-pop` ─────────────────────────────
for (const f of fs.readdirSync(CRIT).filter((x) => /^final-parity-r\d.*press.*\.json$/.test(x))) {
  const j = rj(path.join(CRIT, f))
  const c = j?.cases?.['limit-pop']
  if (!c) continue
  rows.push({ series: 'A', surface: '팝오버(press)', source: `docs/critic/${f}`, at: j.at, app: j.app, prows: c.prows, hasNoData: c.hasNoData, note: String(c.popText ?? '').slice(0, 90) })
}
// ── B. `usage.get` — apiprobe **와 rawprobe** 둘 다 ──────────────────────────
for (const f of fs.readdirSync(CRIT).filter((x) => /^final-parity-r\d.*(apiprobe|rawprobe).*\.json$/.test(x))) {
  const j = rj(path.join(CRIT, f))
  for (const k of ['usage.get', 'usage.get(false)']) {
    const u = j?.probes?.[k]
    if (u === undefined) continue
    rows.push({ series: 'B', surface: `${k}(채널)`, source: `docs/critic/${f}`, at: j.at, app: j.app ?? j.kind, prows: null, hasNoData: shape(u)?.startsWith('nulls') ?? null, note: shape(u) })
  }
}
// ── C. A/B 하네스의 `workbar-context-pop` found ──────────────────────────────
for (const d of fs.existsSync(SHOTS) ? fs.readdirSync(SHOTS) : []) {
  const j = rj(path.join(SHOTS, d, 'report.json'))
  const r = (j?.rows ?? j?.screens ?? []).find((x) => x.id === 'workbar-context-pop')
  if (!r) continue
  rows.push({ series: 'C', surface: '팝오버(A/B found)', source: `bench/shots/${d}/report.json`, at: j.at, app: j.app, prows: r.found, hasNoData: r.found === 4 ? true : r.found === 5 ? false : null, note: `ok=${r.ok}${j.mergedFrom ? ` · mergedFrom ${j.mergedFrom}` : ''}` })
}
// ── D. R3의 반복 측정(계정 0 배치 — 판별력 0으로 판명된 그 12주행) ───────────
for (const f of fs.readdirSync(CRIT).filter((x) => /^final-parity-r3-limitpop-.*\.json$/.test(x))) {
  const j = rj(path.join(CRIT, f))
  for (const r of j?.runs ?? []) {
    rows.push({ series: 'D', surface: `팝오버(R3 ${j.arm}${j.userProfileOverride ? '·USERPROFILE 격리' : ''})`, source: `docs/critic/${f}#run${r.run}`, at: r.at, app: j.app, prows: r.prows, hasNoData: r.hasNoData, note: `계정 ${r.acctCount}개 · usage-cache ${r.usageCacheSeededBytes ?? 0}B · ${shape(r.usageGet)}` })
  }
}
// ── E. 설정 ▸ Account 클로드 한도 ────────────────────────────────────────────
for (const f of fs.readdirSync(CRIT).filter((x) => /^final-parity-r\d.*(apiprobe|rawprobe).*\.json$/.test(x))) {
  const j = rj(path.join(CRIT, f))
  for (const k of Object.keys(j?.probes ?? {})) {
    if (!/^auth\.accountsUsage/.test(k)) continue
    const v = j.probes[k]
    rows.push({ series: 'E', surface: `설정▸Account 한도(${k})`, source: `docs/critic/${f}`, at: j.at, app: j.app ?? j.kind, prows: null, hasNoData: null, note: `${rowsOf(v) === null ? '수치 아님' : `${truncated(v) ? '최소 ' : ''}${rowsOf(v)}행`} :: ${redact(String(v).slice(0, 60))}` })
  }
}
// ── F. Codex 한도 · API 과금 사용량 ──────────────────────────────────────────
for (const f of fs.readdirSync(CRIT).filter((x) => /^final-parity-r\d.*(apiprobe|rawprobe).*\.json$/.test(x))) {
  const j = rj(path.join(CRIT, f))
  for (const k of Object.keys(j?.probes ?? {})) {
    if (!/^(codexAuth\.accountsUsage|apiConfig\.listUsage)/.test(k)) continue
    const v = j.probes[k]
    rows.push({ series: 'F', surface: `${k}`, source: `docs/critic/${f}`, at: j.at, app: j.app ?? j.kind, prows: null, hasNoData: null, note: `${rowsOf(v)}행 :: ${redact(String(v).slice(0, 50))}` })
  }
}
// ── G. 블라인드 판정의 한도 축 행 ────────────────────────────────────────────
for (const f of fs.readdirSync(CRIT).filter((x) => /^final-parity-r\d.*blind.*\.json$/.test(x))) {
  const j = rj(path.join(CRIT, f))
  for (const r of j?.rows ?? []) {
    if (!/workbar-context-pop|limit/.test(String(r.id))) continue
    rows.push({ series: 'G', surface: `블라인드 판정(${r.id})`, source: `docs/critic/${f}`, at: j.at, app: `judge:${r.winner}`, prows: null, hasNoData: null, note: String(r.note ?? '').slice(0, 100) })
  }
}
// ── H. R4의 배치(문은 열렸으나 계기 한 칸의 극성이 뒤집혀 있던 그 20주행) ────
for (const f of fs.readdirSync(CRIT).filter((x) => /^final-parity-r4-limitpop-.*\.json$/.test(x))) {
  const j = rj(path.join(CRIT, f))
  for (const r of j?.runs ?? []) {
    const ms = (() => { try { return JSON.parse(r.usageB).ms } catch { return null } })()
    const u = (() => { try { return JSON.parse(r.usageA).v } catch { return null } })()
    rows.push({ series: 'H', surface: `팝오버(R4 ${j.arm})`, source: `docs/critic/${f}#run${r.run}`, at: r.at, app: j.app, prows: r.prows, hasNoData: r.hasNoData, note: `계정 ${r.acctCount}개 · 2차 usage:get ${ms}ms · CONNECT ${r.proxyHits?.length ?? 0} · ${shape(u)} · sees42=${r.sees42}(극성 뒤집힘 — 켜질 수 없는 칸)` })
  }
}
// ── I. R5(이 라운드) — 극성을 고친 계기 + 스텁 양성 대조 ─────────────────────
for (const f of fs.readdirSync(CRIT).filter((x) => /^final-parity-r5-limitpop-.*\.json$/.test(x))) {
  const j = rj(path.join(CRIT, f))
  for (const r of j?.runs ?? []) {
    const ms = (() => { try { return JSON.parse(r.usageB ?? 'null')?.ms ?? null } catch { return null } })()
    const u = (() => { try { return JSON.parse(r.usageA ?? 'null')?.v ?? null } catch { return null } })()
    rows.push({
      series: 'I', surface: `팝오버(R5 ${j.arm})`, source: `docs/critic/${f}#run${r.run}`, at: r.at, app: j.app,
      // 스텁 팔은 **계기 판별력을 증명하려고 값을 넣은 판**이다 — 극성 집계에서 뺀다
      // (안 빼면 「3.0이 값을 더 자주 보여 준다」로 오독된다).
      stubbed: j.arm === 'stub',
      prows: r.prows, hasNoData: r.hasNoData,
      note: `계정 ${r.acctCount}개 · ${j.arm === 'stub' ? `스텁 ${r.stubInstalled}/${r.refetch}` : `2차 usage:get ${ms}ms · CONNECT ${r.proxyHits?.length ?? 0} · ${shape(u)}`} · seesRemain=${r.seesRemain} · seesPlanted(R4 극성)=${r.seesPlantedR4Regex}`
    })
  }
}

rows.sort((a, b) => String(a.at).localeCompare(String(b.at)))
const bySeries = {}
for (const r of rows) bySeries[r.series] = (bySeries[r.series] ?? 0) + 1
const pol = rows.filter((r) => 'ABCDHI'.includes(r.series) && !r.stubbed)
const polOf = (re, v) => pol.filter((r) => re.test(String(r.app)) && r.hasNoData === v).length
const out = {
  at: new Date().toISOString(),
  what: '한도 축 관측 **전량** — 포함 규칙: 「한도 수치를 보여 주는 표면의 값이 기록된 자리」. 뺀 관측 0건',
  rule: '표면 5종(팝오버·usage.get·설정 Account 클로드/Codex 한도·API 과금) + 블라인드 판정 행',
  total: rows.length,
  bySeries,
  r3TableCounted: 'A+B(apiprobe만)+C+D = 27건 — R3가 「전량」이라 부른 범위',
  r4Counted: 'A~H = 62건 — R4가 「전량」이라 부른 범위(집계만 싣고 표는 14건만)',
  observations: rows,
  polarity: {
    scope: 'A~D·H·I(팝오버·usage.get)만 — E~G는 행 수/판정이라 4↔5 극성이 없다. R5 스텁 팔 6건은 계기 대조군이라 제외',
    'tauri 값 있음': polOf(/tauri/, false),
    'tauri 데이터 없음': polOf(/tauri/, true),
    'electron 값 있음': polOf(/electron/, false),
    'electron 데이터 없음': polOf(/electron/, true)
  }
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
if (MD) {
  const esc = (s) => String(s ?? '').replace(/\|/g, '\\|')
  const md = [
    `| # | 계열 | 시각(UTC) | 앱 | 표면 | prows | 데이터 없음 | 출처 | 관측 |`,
    `|---|---|---|---|---|---|---|---|---|`,
    ...rows.map((r, i) => `| ${i + 1} | ${r.series} | ${esc(String(r.at).replace('T', ' ').replace(/\..*/, ''))} | ${esc(r.app)} | ${esc(r.surface)} | ${r.prows ?? '—'} | ${r.hasNoData === null ? '—' : r.hasNoData} | ${esc(r.source)} | ${esc(r.note)} |`)
  ].join('\n')
  fs.mkdirSync(path.dirname(MD), { recursive: true })
  fs.writeFileSync(MD, md)
}
for (const r of rows) console.log(`${r.series} ${r.at}  ${String(r.app).padEnd(16)} ${r.surface.padEnd(38)} prows=${String(r.prows).padEnd(5)} noData=${String(r.hasNoData).padEnd(6)} ${String(r.note).slice(0, 66)}`)
console.log(`\nbySeries ${JSON.stringify(bySeries)}\n${JSON.stringify(out.polarity)}\ntotal ${rows.length}\nsaved: ${OUT}${MD ? ` · md: ${MD}` : ''}`)
