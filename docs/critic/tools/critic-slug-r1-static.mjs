#!/usr/bin/env node
/* ============================================================================
 * critic-slug-r1-static — SLUG R1 확인 크리틱의 **읽기 전용 계기**.
 *
 * 빌더의 말을 안 믿고 네 가지를 직접 잰다:
 *
 *  S1 슬러그 레시피 파리티 — `ccg-auth::account_slug`(Rust)의 규칙을 JS로 재현하고,
 *     레포 안 **모든 하네스 사본**을 그 값과 대조한다. 사본이 하나라도 어긋나면
 *     그 하네스는 조용히 헛것을 재고 있다.
 *
 *  S2 (c) 「해시 우연」 — 빌더는 `bob@…`이면 결함이 숨고 `eve@…`라야 드러난다고 했다.
 *     **실제 NTFS에 폴더를 파고 열거 순서를 잰다**(격리 임시 폴더 · 실홈 무접촉).
 *     옛 스캔의 답이 픽스처 선택에 따라 갈리는지가 여기서 판정된다.
 *
 *  S3 하네스 동시 수정의 정당성 — 「옛 하네스 + 새 제품」이 정말 깨지는가.
 *     poc-account-switch / poc-acct-live 가 실제로 쓰는 이메일로 옛 슬러그와 실물
 *     슬러그를 나란히 세워, 옛 값으로 쓴 `fake.<slug>.jsonl`이 한 장도 안 골라짐을 보인다.
 *
 *  S4 제품 경로에 추측이 남았나 — 엔진 크레이트의 `read_dir` 접두 스캔 · 제품
 *     `ChatRuntime` 생성 지점(= 리졸버 배선이 필요한 자리)을 센다.
 *
 * 실행: node docs/critic/tools/critic-slug-r1-static.mjs --repo=<격리트리> [--out=<접미>]
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const args = process.argv.slice(2)
const argOf = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) ?? '').split('=')[1] || d
const REPO = path.resolve(argOf('repo', process.cwd()))
const OUT_SUFFIX = argOf('out', '')
const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const OUT = path.join(HERE, 'evidence', `slug-r1-static${OUT_SUFFIX}.json`)

const rep = { at: new Date().toISOString(), repo: REPO, checks: {}, findings: [] }
const bad = (id, why, extra) => {
  rep.findings.push({ id, why, ...(extra ?? {}) })
  console.error(`  x ${id} — ${why}`)
}
const ok = (id, v) => console.log(`  o ${id}${v === undefined ? '' : ' — ' + JSON.stringify(v)}`)

// ── 진짜 레시피(ccg-auth/src/lib.rs:125 의 JS 원본) ─────────────────────────
const truth = (email) => {
  const safe = email.toLowerCase().replace(/[^a-z0-9._-]+/g, '_')
  let h = 0
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0
  return `${safe}-${h.toString(36)}`
}
const oldGuess = (email) => email.replace(/@/g, '_').replace(/\+/g, '-')

// 전임 크리틱(FPS144)이 확정한 8벡터 + 이 라운드의 픽스처.
const VECTORS = [
  'lmg56632@gmail.com',
  'junelius@naver.com',
  'Bob@Example.com',
  'a.b+tag@example.com',
  'A.B+tag@Example.COM',
  "o'brien@x.com",
  '한글@x.com',
  'user_name@sub.domain.co.kr'
]

// ── S1 ─────────────────────────────────────────────────────────────────────
// 레포에서 슬러그 헬퍼를 들고 있는 파일을 전부 찾아 **그 함수 자체를 실행**해 대조한다.
function extractSlugFn(file) {
  const src = fs.readFileSync(file, 'utf8')
  // `const slug = (x) => { ... }`  또는  `const slug = (x) => expr`
  const m = src.match(/const slug = \((\w+)\) => \{[\s\S]*?\n\}/) || src.match(/const slug = \((\w+)\) => .*/)
  if (!m) return null
  const body = m[0].replace(/^const slug = /, '')
  // eslint-disable-next-line no-new-func
  return { fn: new Function(`return (${body})`)(), text: body }
}

function s1() {
  console.log('\n[S1] 슬러그 레시피 파리티 — 레포의 하네스 사본 전부')
  const files = fs
    .readdirSync(path.join(REPO, 'scripts'))
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => path.join(REPO, 'scripts', f))
    .filter((p) => /const slug = \(/.test(fs.readFileSync(p, 'utf8')))
  const rows = []
  for (const f of files) {
    const got = extractSlugFn(f)
    if (!got) {
      rows.push({ file: path.basename(f), parsed: false })
      continue
    }
    const mism = VECTORS.filter((e) => {
      try {
        return got.fn(e) !== truth(e)
      } catch {
        return true
      }
    })
    const equalsOldGuess = VECTORS.every((e) => {
      try {
        return got.fn(e) === oldGuess(e)
      } catch {
        return false
      }
    })
    rows.push({ file: path.basename(f), parsed: true, mismatches: mism.length, equalsOldGuess })
  }
  rep.checks.s1 = { vectors: VECTORS.length, files: rows }
  const wrong = rows.filter((r) => !r.parsed || r.mismatches > 0)
  if (!wrong.length) ok('S1 하네스 슬러그 사본이 전부 진짜 레시피와 일치', rows.map((r) => r.file))
  else bad('S1', `사본이 어긋난 하네스가 있다`, { wrong })
}

// ── S2 실제 NTFS 열거 순서 ──────────────────────────────────────────────────
function oldScan(root, email) {
  const slug = oldGuess(email)
  const hits = []
  for (const n of fs.readdirSync(root)) {
    if (n === slug || n.startsWith(`${slug}-`)) hits.push(n)
  }
  return hits
}

function s2() {
  console.log('\n[S2] (c) 접두 그림자 — 「bob이면 숨고 eve라야 드러난다」를 실제 열거로 판정')
  const rows = []
  for (const [short, long] of [
    ['bob@ex.invalid', 'bob@ex.invalid-corp.test'],
    ['eve@ex.invalid', 'eve@ex.invalid-corp.test'],
    // FPS144 증거가 쓴 원래 세계(x.com)도 같이 잰다.
    ['bob@x.com', 'bob@x.com-corp.net']
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccg-slugcrit-order-'))
    const s = truth(short)
    const l = truth(long)
    // **심는 순서를 뒤집어** 두 번 잰다 — 파일시스템 인덱스가 이름순인지, 생성순인지.
    const orders = {}
    for (const [tag, seq] of [
      ['real-first', [s, l]],
      ['neighbour-first', [l, s]]
    ]) {
      const sub = path.join(root, tag)
      fs.mkdirSync(sub)
      for (const n of seq) fs.mkdirSync(path.join(sub, n))
      const hits = oldScan(sub, short)
      orders[tag] = { enumerated: fs.readdirSync(sub), hits, picked: hits[0] ?? null, wrong: hits[0] !== s }
    }
    rows.push({ short, long, realSlug: s, neighbourSlug: l, orders })
    fs.rmSync(root, { recursive: true, force: true })
  }
  rep.checks.s2 = rows
  for (const r of rows) {
    const stable = r.orders['real-first'].picked === r.orders['neighbour-first'].picked
    const wrong = r.orders['real-first'].wrong || r.orders['neighbour-first'].wrong
    console.log(
      `   ${r.short.padEnd(26)} 심은순서무관=${stable}  옛스캔이집은것=${r.orders['real-first'].picked}  남의폴더=${wrong}`
    )
  }
  const bobRow = rows.find((r) => r.short === 'bob@ex.invalid')
  const eveRow = rows.find((r) => r.short === 'eve@ex.invalid')
  const bobHidden = !bobRow.orders['real-first'].wrong && !bobRow.orders['neighbour-first'].wrong
  const eveExposed = eveRow.orders['real-first'].wrong && eveRow.orders['neighbour-first'].wrong
  rep.checks.s2Verdict = { bobHidden, eveExposed }
  if (bobHidden && eveExposed) ok('S2 빌더의 「해시 우연」 주장이 실측과 일치', { bobHidden, eveExposed })
  else bad('S2', '「bob이면 숨고 eve라야 드러난다」가 실측과 다르다', { bobHidden, eveExposed })
}

// ── S3 하네스 동시 수정의 정당성 ────────────────────────────────────────────
function s3() {
  console.log('\n[S3] 「옛 하네스 + 새 제품」이 정말 깨지는가')
  // 두 하네스가 실제로 쓰는 계정 이메일을 소스에서 뽑는다.
  const rows = []
  for (const f of ['poc-account-switch.mjs', 'poc-acct-live.mjs']) {
    const p = path.join(REPO, 'scripts', f)
    if (!fs.existsSync(p)) continue
    const src = fs.readFileSync(p, 'utf8')
    const emails = [...new Set((src.match(/[a-z0-9][\w.+-]*@[\w.-]+\.(?:test|invalid|com|net)/gi) ?? []))]
    const per = emails.map((e) => ({
      email: e,
      real: truth(e),
      old: oldGuess(e),
      // 옛 하네스는 `fake.<old>.jsonl`을 쓴다. 새 제품은 `accounts/<real>`을 집으므로
      // 가짜 CLI는 `fake.<real>.jsonl`을 찾는다 → 옛 대본은 **한 장도 안 골라진다**.
      scriptWouldBeChosen: oldGuess(e) === truth(e)
    }))
    rows.push({ file: f, emails: per, anyChosen: per.some((x) => x.scriptWouldBeChosen) })
  }
  rep.checks.s3 = rows
  const allBroken = rows.length > 0 && rows.every((r) => !r.anyChosen)
  if (allBroken) ok('S3 옛 하네스는 새 제품에서 계정별 대본을 한 장도 못 고른다(동시 수정 불가피)', rows.map((r) => r.file))
  else bad('S3', '옛 하네스가 새 제품에서도 대본을 고를 수 있다 — 동시 수정의 정당성이 약하다', { rows })
}

// ── S4 제품 경로에 추측이 남았나 ────────────────────────────────────────────
function s4() {
  console.log('\n[S4] 제품 경로 잔여 — 추측 스캔 · 런타임 생성 지점')
  const rt = fs.readFileSync(path.join(REPO, 'crates', 'ccg-engine', 'src', 'runtime.rs'), 'utf8')
  // 제품 본문(첫 `#[cfg(test)]` 앞)만 본다.
  const prod = rt.slice(0, rt.indexOf('#[cfg(test)]') >= 0 ? rt.indexOf('#[cfg(test)]') : rt.length)
  const scan = /read_dir\(&root\)|starts_with\(&format!\("\{slug\}-"\)\)/.test(prod)
  const guessInProd = (prod.match(/replace\('@', "_"\)/g) ?? []).length
  // 셸의 런타임 생성 지점 — 리졸버가 필요한 자리가 하나인지.
  const shellFiles = []
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n)
      const st = fs.statSync(p)
      if (st.isDirectory()) walk(p)
      else if (n.endsWith('.rs')) shellFiles.push(p)
    }
  }
  walk(path.join(REPO, 'src-tauri', 'src'))
  const ctors = []
  for (const p of shellFiles) {
    const src = fs.readFileSync(p, 'utf8')
    const lines = src.split('\n')
    lines.forEach((ln, idx) => {
      if (!ln.includes('ChatRuntime::new')) return
      // 주석 줄(`///`·`//`)은 생성 지점이 아니다 — 이 파일들은 주석이 길다.
      if (/^\s*(\/\/|\*)/.test(ln)) return
      const before = lines.slice(0, idx).join('\n')
      ctors.push({
        file: path.relative(REPO, p).replace(/\\/g, '/'),
        line: idx + 1,
        inTestModule: before.lastIndexOf('#[cfg(test)]') >= 0
      })
    })
  }
  const prodCtors = ctors.filter((c) => !c.inTestModule)
  const wired = fs.readFileSync(path.join(REPO, 'src-tauri', 'src', 'engine', 'hub.rs'), 'utf8').includes('.with_account_resolver(')
  rep.checks.s4 = { engineScanRemains: scan, guessInProd, ctors, prodCtors, hubWired: wired }
  if (!scan) ok('S4a 엔진 제품 본문에 접두 스캔이 없다')
  else bad('S4a', '엔진 제품 본문에 접두 스캔이 남아 있다')
  if (guessInProd <= 1) ok('S4b 제품 본문의 추측 조립은 폴백 표식 1곳뿐', guessInProd)
  else bad('S4b', `제품 본문에 추측 조립이 ${guessInProd}곳`, { guessInProd })
  if (prodCtors.length === 1 && wired) ok('S4c 제품 런타임 생성 지점이 하나이고 거기 리졸버가 꽂혔다', prodCtors)
  else bad('S4c', '런타임 생성 지점이 하나가 아니거나 배선이 없다', { prodCtors, wired })
}

// ── S5 폴백 두 층의 구조 보장 — 이메일 표식이 경로를 탈출할 수 있나 ─────────
function s5() {
  console.log('\n[S5] `_no-resolver/<표식>` 두 층 — 표식이 층을 탈출할 수 있나')
  const marker = (e) => e.replace(/@/g, '_').replace(/\+/g, '-')
  const cases = [
    'user@example.invalid',
    'a.b+tag@Example.invalid',
    "o'brien@x.com",
    '한글@x.com',
    // 적대적: 경로 구분자를 품은 「이메일」.
    'a\\..\\..\\evil@x.com',
    'a/../../evil@x.com',
    '..@x.com'
  ]
  const rows = cases.map((e) => {
    const m = marker(e)
    const joined = path.win32.join('C:\\home\\accounts\\_no-resolver', m)
    const norm = path.win32.normalize(joined)
    const escapes = !norm.toLowerCase().startsWith('c:\\home\\accounts\\_no-resolver\\')
    return { email: e, marker: m, resolved: norm, escapesFallbackLayer: escapes }
  })
  rep.checks.s5 = rows
  const esc = rows.filter((r) => r.escapesFallbackLayer)
  if (!esc.length) ok('S5 어떤 표식도 `_no-resolver` 층을 못 벗어난다')
  else bad('S5', '표식이 `_no-resolver` 층을 탈출한다 — 「구조로 막았다」는 절대 보장이 아니다', { esc })
}

s1()
s2()
s3()
s4()
s5()

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(rep, null, 2))
console.log(`\n보고서 → ${OUT}`)
if (rep.findings.length) {
  console.error(`\n${rep.findings.length}건 지적`)
  process.exit(1)
}
console.log('\n지적 없음')
