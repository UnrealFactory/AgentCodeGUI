// 확인 크리틱 R2 계기 ④ — **슬러그 불일치**를 코드로 검증한다 (읽기 전용 · 실홈 무접촉).
//
//   node docs/critic/tools/critic-fps144-slug.mjs
//
// FPS144 R2가 「3.0 라이브 팔이 죽는 진범은 계정 폴더 이름 불일치」라고 진단했다.
// 그 진단을 믿지 않고 **두 구현을 각각 옮겨 심어** 맞붙인다:
//
//   ① `ccg-auth::account_slug()`            (crates/ccg-auth/src/lib.rs:125)
//      = 소문자화 + [a-z0-9._-] 밖은 연속 1개의 `_`로 접기 + `-` + base36(자바식 31-해시)
//      ★ **로그인이 실제로 만드는 폴더 이름**이다(claude.rs:58 `accounts_dir().join(account_slug(email))`).
//   ② `ccg-engine::Runtime::account_dir()`  (crates/ccg-engine/src/runtime.rs:606-621)
//      = `email.replace('@',"_").replace('+',"-")` — **해시도 없고 소문자화도 없다.**
//        `<home>/accounts`를 훑어 `n == slug || n.starts_with(slug + "-")`인 첫 항목을 쓰고,
//        못 찾으면 `root.join(slug)`(없는 경로)를 그대로 `CLAUDE_CONFIG_DIR`로 내보낸다
//        (driver.rs:141). CLI는 빈 폴더를 만들고 "Not logged in"을 찍는다.
//
// ①의 이식이 맞다는 것은 레포에 박힌 **Rust 단위 테스트 벡터 8개**로 검증한다
// (crates/ccg-auth/src/lib.rs:313-325). 벡터가 하나라도 어긋나면 이 계기는 스스로 죽는다.
//
// 그리고 「실홈에서는 훑기 폴백이 성립한다」는 위안이 **어디까지 참인지** 세계 셋으로 가른다:
//   W1 격리 홈(accounts/ 없음) · W2 실홈(그 계정 폴더만) · W3 실홈(두 계정 · 오염 폴더)
import fs from 'node:fs'
import path from 'node:path'

// ── ① ccg-auth::account_slug 이식 ────────────────────────────────────────────
function authSlug(email) {
  const lower = email.toLowerCase()
  let safe = ''
  let inRun = false
  for (const c of lower) {
    const ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '.' || c === '_' || c === '-'
    if (ok) { safe += c; inRun = false } else if (!inRun) { safe += '_'; inRun = true }
  }
  // Rust: for u in email.encode_utf16() { h = h.wrapping_mul(31).wrapping_add(u as u32) }
  // ★ 해시는 **원문 email**(소문자화 전)의 UTF-16 코드 단위로 돈다.
  let h = 0
  for (let i = 0; i < email.length; i++) h = (Math.imul(h, 31) + email.charCodeAt(i)) >>> 0
  return `${safe}-${base36(h)}`
}
function base36(n) {
  const T = '0123456789abcdefghijklmnopqrstuvwxyz'
  if (n === 0) return '0'
  let out = ''
  while (n > 0) { out = T[n % 36] + out; n = Math.floor(n / 36) }
  return out
}

// ── ② ccg-engine::Runtime::account_dir 이식 ──────────────────────────────────
function engineSlug(email) {
  return email.split('@').join('_').split('+').join('-')
}
/** 훑기 + 폴백. `entries`는 `<home>/accounts`의 디렉터리 이름 목록(read_dir 순서). */
function engineResolve(email, entries) {
  const slug = engineSlug(email)
  for (const n of entries) {
    if (n === slug || n.startsWith(`${slug}-`)) return { picked: n, via: n === slug ? 'exact' : 'prefix' }
  }
  return { picked: slug, via: 'fallback(없는 경로)' }
}

// ── 이식 검증: 레포에 박힌 Rust 벡터와 대조 ─────────────────────────────────
const REPO = path.resolve(import.meta.dirname, '..', '..', '..')
const LIB = path.join(REPO, 'crates', 'ccg-auth', 'src', 'lib.rs')
const vectors = []
for (const m of fs.readFileSync(LIB, 'utf8').matchAll(/assert_eq!\(account_slug\("(.*?)"\),\s*"(.*?)"\)/g)) {
  vectors.push({ email: m[1], expect: m[2] })
}
let vOk = 0
console.log(`■ 이식 검증 — crates/ccg-auth/src/lib.rs의 단위 테스트 벡터 ${vectors.length}개`)
for (const v of vectors) {
  const got = authSlug(v.email)
  const ok = got === v.expect
  if (ok) vOk++
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${v.email.padEnd(24)} → ${got}${ok ? '' : `   (기대 ${v.expect})`}`)
}
if (!vectors.length || vOk !== vectors.length) {
  console.error('\n✖ 이식이 원본과 다르다 — 아래 분석은 신뢰할 수 없다. 중단한다.')
  process.exit(1)
}
console.log(`   → ${vOk}/${vectors.length} 일치. 이식이 원본과 같다.\n`)

// ── 세계 셋에서의 판정 ───────────────────────────────────────────────────────
// 실홈은 **건드리지 않는다** — 폴더 목록을 authSlug로 합성해 세계를 만든다.
const CORPUS = [
  { email: 'lmg56632@gmail.com', note: '평범한 소문자 (이 기계의 실계정 모양)' },
  { email: 'junelius@naver.com', note: '평범한 소문자' },
  { email: 'Bob@Example.com', note: '대문자 포함' },
  { email: 'a.b+tag@example.com', note: '플러스 주소' },
  { email: 'A.B+tag@Example.COM', note: '대문자 + 플러스 (레포 벡터)' },
  { email: "o'brien@x.com", note: '아포스트로피 (허용 밖 문자)' },
  { email: '한글@x.com', note: '비 ASCII (레포 벡터)' },
  { email: 'user_name@sub.domain.co.kr', note: '밑줄 + 다단 도메인' }
]

const rows = []
for (const { email, note } of CORPUS) {
  const real = authSlug(email)          // 로그인이 만드는 실제 폴더
  const eslug = engineSlug(email)       // 엔진이 조립하는 이름
  const w1 = engineResolve(email, [])                       // 격리 홈: accounts/ 없음
  const w2 = engineResolve(email, [real])                   // 실홈: 그 계정 폴더만
  rows.push({
    email, note, real, eslug,
    W1: w1.picked === real, W1via: w1.via,
    W2: w2.picked === real, W2via: w2.via
  })
}
console.log('■ W1 격리 홈(accounts/ 없음) · W2 실홈(그 계정 폴더 하나)')
console.log('   ' + 'email'.padEnd(27) + 'auth 폴더(실물)'.padEnd(34) + 'engine 조립'.padEnd(26) + 'W1  W2')
for (const r of rows) {
  console.log('   ' + r.email.padEnd(27) + r.real.padEnd(34) + r.eslug.padEnd(26) +
    (r.W1 ? ' ok ' : ' ✖  ') + (r.W2 ? ' ok' : ' ✖') + (r.W2 ? '' : `   ← ${r.note}`))
}

// ── W3: 오염·그림자 시나리오 ────────────────────────────────────────────────
console.log('\n■ W3 실홈에서 **잘못된 계정 폴더를 집는** 조건')
const scen = []

// (a) 자기오염 — 실패한 주행이 남긴 해시 없는 빈 폴더가 exact로 먼저 걸린다
{
  const email = 'lmg56632@gmail.com'
  const real = authSlug(email)
  const poisoned = engineSlug(email) // 앞선 실패 주행에서 CLI가 만든 빈 폴더
  // read_dir은 대략 사전순 — 짧은 쪽(접두)이 먼저 온다
  const entries = [poisoned, real].sort()
  const r = engineResolve(email, entries)
  scen.push({
    name: '(a) 자기오염(sticky)',
    detail: `실패 주행이 accounts/${poisoned} 를 만든 뒤에는 훑기가 그 빈 폴더를 exact로 먼저 집는다`,
    entries, picked: r.picked, via: r.via, ok: r.picked === real
  })
}
// (b) 그림자 — 다른 계정의 폴더가 접두로 걸린다
{
  // A의 엔진 슬러그가 B의 실제 폴더 이름의 접두가 되는 쌍
  const a = 'bob@x.com'
  const b = 'bob@x.com'.replace('bob', 'bob') // 동일 — 대신 아래에서 인위 구성
  void b
  // auth 폴더는 언제나 `<safe>-<hash>` 꼴이라, A의 engineSlug가 B의 safe와 같으면 접두로 걸린다.
  // safe는 허용 밖 문자를 `_` 하나로 접으므로 **서로 다른 이메일이 같은 safe**를 가질 수 있다.
  const e1 = 'a!b@x.com'
  const e2 = 'a#b@x.com'
  const d1 = authSlug(e1)
  const d2 = authSlug(e2)
  const entries = [d1, d2].sort()
  // 엔진이 e1을 찾을 때: engineSlug = 'a!b_x.com' → 어느 쪽에도 안 걸림(폴백)
  const r1 = engineResolve(e1, entries)
  // 그런데 safe가 같으므로, **해시 없는 이름으로 조립하는 다른 소비자**가 있으면 둘이 겹친다
  scen.push({
    name: '(b) safe 충돌',
    detail: `서로 다른 이메일 ${e1} · ${e2} 가 같은 safe(${d1.split('-').slice(0, -1).join('-')})를 갖는다 — 구분은 해시뿐인데 엔진은 해시를 안 쓴다`,
    entries, picked: r1.picked, via: r1.via, ok: r1.picked === d1
  })
}
// (c) 접두 그림자 — B의 폴더가 A의 엔진 슬러그로 시작
{
  const a = 'bob@x.com'                 // engineSlug: bob_x.com
  const bEmail = 'bob@x.com'            // 같은 local/domain으로는 못 만든다 → 아래처럼 safe가 확장되는 쌍
  void bEmail
  // auth safe는 `_`로 접기 때문에 `bob@x.com` 의 safe = `bob_x.com`.
  // `bob@x.com` 하나뿐이면 문제 없다. 그림자는 **A의 engineSlug + '-' 로 시작하는 다른 폴더**가
  // 있을 때 생긴다: 그런 이름은 safe가 `bob_x.com-…` 인 이메일에서 나온다(도메인에 `-` 포함).
  const e2 = 'bob@x.com-corp.net'       // safe = bob_x.com-corp.net
  const d2 = authSlug(e2)
  const dA = authSlug(a)
  const entries = [d2, dA].sort()       // d2가 사전순으로 먼저 올 수 있다
  const r = engineResolve(a, entries)
  scen.push({
    name: '(c) 접두 그림자',
    detail: `${a} 를 찾는데 ${e2} 의 폴더(${d2})가 'bob_x.com-' 접두에 걸린다 — read_dir 순서가 정하는 우연`,
    entries, picked: r.picked, via: r.via, ok: r.picked === dA
  })
}
for (const s of scen) {
  console.log(`   ${s.ok ? 'ok  ' : '✖ ★'} ${s.name}`)
  console.log(`        ${s.detail}`)
  console.log(`        accounts/ = [${s.entries.join(', ')}]`)
  console.log(`        엔진이 집은 것: ${s.picked}  (${s.via})`)
}

// ── 요약 ─────────────────────────────────────────────────────────────────────
const w2fail = rows.filter((r) => !r.W2)
console.log('\n■ 요약')
console.log(`   · 격리 홈(W1): ${rows.length}/${rows.length} 전부 실패 — accounts/가 없으니 훑기가 성립하지 않는다.`)
console.log(`   · 실홈(W2)  : ${w2fail.length}/${rows.length} 실패. 훑기가 살리는 것은 **이미 소문자이고 +·특수문자가 없는** 이메일뿐이다.`)
console.log(`               실패: ${w2fail.map((r) => r.email).join(' · ') || '(없음)'}`)
console.log(`   · W3       : 자기오염·접두 그림자로 **있는데도 틀린 폴더**를 집을 수 있다.`)

const OUT = path.join(REPO, 'docs', 'critic', 'evidence', 'fps144-slug-analysis.json')
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify({
  what: '슬러그 불일치 검증 — ccg-auth::account_slug vs ccg-engine::Runtime::account_dir (읽기 전용·실홈 무접촉)',
  vectorsChecked: vectors.length, vectorsOk: vOk,
  worlds: rows, scenarios: scen, at: new Date().toISOString()
}, null, 2))
console.log('\nsaved:', path.relative(REPO, OUT))
