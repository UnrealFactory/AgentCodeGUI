// M6 크리틱 — collate.rs vs Node localeCompare(undefined,{sensitivity:'base'}) 교차 검증.
// 빌더 주장: 실파일명 꼴 30개 × 600세트 불일치 0 / 무작위 수프 43.5% 불일치.
// 여기서는 (1) 그 주장을 내 세트로 재현하고 (2) **이 머신의 진짜 폴더 이름**으로도 잰다.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const RUST = process.argv[2] // collate 프로브 exe
const rustSort = (names) => {
  const inp = JSON.stringify(names)
  const o = execFileSync(RUST, [], { input: inp, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(o)
}
const nodeSort = (names) =>
  [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))

function rng(seed) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
}

function compareSets(label, pool, count, size, seed) {
  const r = rng(seed)
  let bad = 0
  const examples = []
  for (let i = 0; i < count; i++) {
    const n = 2 + Math.floor(r() * (size - 1))
    const pick = []
    for (let k = 0; k < n; k++) pick.push(pool[Math.floor(r() * pool.length)])
    const uniq = [...new Set(pick)]
    if (uniq.length < 2) continue
    const a = rustSort(uniq).join('\u0001')
    const b = nodeSort(uniq).join('\u0001')
    if (a !== b) {
      bad++
      if (examples.length < 6)
        examples.push({ input: uniq, rust: rustSort(uniq), node: nodeSort(uniq) })
    }
  }
  return { label, sets: count, mismatch: bad, pct: +((bad / count) * 100).toFixed(1), examples }
}

// ── 풀 1: 빌더가 말한 "실제 프로젝트 이름 꼴" 30개 ─────────────────────────────
const REALISH = [
  'app', 'bench', 'crates', 'docs', 'progress', 'scripts', 'src', 'src-tauri', '.github',
  'node_modules', 'Cargo.toml', 'README.md', 'package.json', '_build', '__pycache__',
  '문서', '한글폴더', '가나다', '설계노트.md', '작업기록', 'Bench', 'APP', 'café.txt',
  'Über.md', 'index.ts', 'App.tsx', 'main.rs', '1-first', '2-second', '10-tenth'
]

// ── 풀 2: 이 머신의 진짜 폴더/파일 이름 ────────────────────────────────────────
function realNames() {
  const out = new Set()
  const roots = ['C:/Code', 'C:/Code/AgentCodeGUI', 'C:/Code/AgentCodeGUI/app/src',
                 'C:/Code/AgentCodeGUI/src/renderer/src/components', 'C:/Code/AgentCodeGUI/docs',
                 'C:/Code/AgentCodeGUI/progress', os.homedir(), path.join(os.homedir(), 'Documents'),
                 path.join(os.homedir(), 'Downloads'), path.join(os.homedir(), 'Desktop')]
  for (const r of roots) {
    try {
      for (const e of fs.readdirSync(r)) out.add(e)
    } catch { /* 없음 */ }
  }
  return [...out]
}

// ── 풀 3: 실사용에 실제로 나오는 "어려운" 이름들 ───────────────────────────────
const HARD = [
  '한글 파일.txt', '😀emoji.txt', '🎉릴리즈노트.md', 'ＦＵＬＬ幅.txt', '漢字문서.md',
  '설계_v2.md', '설계-v2.md', '설계.v2.md', 'a b  c.txt', 'ß-strasse.txt', 'æther.txt',
  'Ångström.csv', 'ÖNORM.pdf', 'naïve.js', 'Ω-omega.txt', 'Ж-zhe.txt', 'ひらがな.txt',
  'カタカナ.txt', '中文档案.txt', '가.txt', '힣.txt', 'ㄱ.txt', '3주차 회의록.md',
  'CHANGELOG.md', 'changelog.md', '(초안) 기획.md', '[보류] 기획.md', '#긴급.md',
  '~임시.txt', '_private.env', '.gitignore', '.env.local'
]

// ── 풀 4: 무작위 문자 수프(빌더의 43.5% 자리) ─────────────────────────────────
function soup(n, seed) {
  const r = rng(seed)
  const ranges = [[0x21, 0x7e], [0xc0, 0xff], [0xac00, 0xd7a3], [0x4e00, 0x9fa0], [0x3040, 0x30ff]]
  const out = []
  for (let i = 0; i < n; i++) {
    let s = ''
    const len = 1 + Math.floor(r() * 5)
    for (let k = 0; k < len; k++) {
      const [lo, hi] = ranges[Math.floor(r() * ranges.length)]
      s += String.fromCodePoint(lo + Math.floor(r() * (hi - lo)))
    }
    out.push(s)
  }
  return [...new Set(out)]
}

const results = [
  compareSets('realish-30 (빌더 주장 자리)', REALISH, 600, 12, 1),
  compareSets('real-machine-names', realNames(), 600, 12, 7),
  compareSets('hard-but-real (한글·이모지·전각·부호)', HARD, 600, 12, 11),
  compareSets('random-soup', soup(24, 3), 400, 10, 13)
]

// 전체 목록 한 방 정렬(세트가 아니라 통째로) — 화면에 실제로 보이는 순서
const whole = {}
for (const [k, pool] of [['realish', REALISH], ['hard', HARD], ['machine', realNames()]]) {
  const a = rustSort(pool)
  const b = nodeSort(pool)
  const firstDiff = a.findIndex((x, i) => x !== b[i])
  whole[k] = {
    identical: firstDiff === -1,
    firstDiffIndex: firstDiff,
    rustAround: firstDiff < 0 ? [] : a.slice(Math.max(0, firstDiff - 1), firstDiff + 4),
    nodeAround: firstDiff < 0 ? [] : b.slice(Math.max(0, firstDiff - 1), firstDiff + 4)
  }
}

console.log(JSON.stringify({ results, whole }, null, 2))
