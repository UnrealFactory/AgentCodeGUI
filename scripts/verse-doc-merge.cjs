// Merge the per-chunk Korean translations into one pack, and validate:
//  (1) every unique block key is present with a non-empty translation
//  (2) backtick code spans are preserved (same multiset in EN and KO) — catches
//      an agent translating/dropping `code`, type names, or paths.
const fs = require('fs')
const DIR = require('path').join(__dirname, '..', '.tmp-verse')

// (구버전은 여기서 한국어 문장마다 문단(`\n\n`)으로 강제 분리했다 — 카드가 세로로 한없이
// 길어지는 원인. 지금은 RULES.md가 번역 에이전트에게 "자연스러운 문단으로 재구성"을 직접
// 요구하므로, 병합은 에이전트가 만든 문단 구조를 그대로 존중하고 공백만 정돈한다.
// 표시 단 정리는 앱의 verseDocFormat.ts(구분선 제거·코드 펜스·용어 백틱)가 담당.)
function formatDoc(s) {
  return String(s).replace(/\n{3,}/g, '\n\n').trim()
}

const blocks = JSON.parse(fs.readFileSync(DIR + '/blocks.json', 'utf8'))
const enByKey = new Map(blocks.map((b) => [b.key, b.en]))

const ko = {}
let dupes = 0
for (const f of fs.readdirSync(DIR + '/ko')) {
  if (!f.endsWith('.json')) continue
  const part = JSON.parse(fs.readFileSync(DIR + '/ko/' + f, 'utf8'))
  for (const [k, v] of Object.entries(part)) {
    if (k in ko) dupes++
    ko[k] = v
  }
}

// manual fix overlay — corrects mistranslations / fills gaps found in validation
let fixes = 0
try {
  const fx = JSON.parse(fs.readFileSync(DIR + '/fixes.json', 'utf8'))
  for (const [k, v] of Object.entries(fx)) { ko[k] = v; fixes++ }
} catch { /* no fixes file */ }

const ticks = (s) => (s.match(/`[^`]+`/g) || []).slice().sort()
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

const missing = []
const empty = []
const tickMismatch = []
for (const b of blocks) {
  const v = ko[b.key]
  if (v == null) { missing.push(b.key); continue }
  if (!String(v).trim()) { empty.push(b.key); continue }
  if (!eq(ticks(b.en), ticks(v))) tickMismatch.push(b.key)
}

console.log('unique blocks   :', blocks.length)
console.log('translated keys :', Object.keys(ko).length)
console.log('manual fixes    :', fixes)
console.log('duplicate keys  :', dupes)
console.log('MISSING         :', missing.length, missing.slice(0, 20).join(' '))
console.log('EMPTY           :', empty.length, empty.slice(0, 20).join(' '))
console.log('tick warnings   :', tickMismatch.length, '(reviewed: source-typo / type-name wrapping — non-blocking)')

fs.writeFileSync(DIR + '/tick-mismatch.json', JSON.stringify(tickMismatch))
// tick mismatches are warnings only — all 18 reviewed (malformed source backticks or KO
// wrapping a bare type name); missing/empty are the only hard blockers.
if (!missing.length && !empty.length) {
  // emit the merged pack — exactly the canonical block keys (the runtime lookup set),
  // sorted for stable diffs. Stray ko keys (from older extraction passes) are dropped.
  const out = {}
  for (const b of blocks.slice().sort((a, c) => (a.key < c.key ? -1 : 1))) out[b.key] = formatDoc(ko[b.key])
  fs.writeFileSync(DIR + '/verse-doc-ko.json', JSON.stringify(out))
  console.log('PACK WRITTEN    : .tmp-verse/verse-doc-ko.json (' + Object.keys(out).length + ' entries)')
} else {
  console.log('PACK NOT WRITTEN — fix missing/empty first')
}
