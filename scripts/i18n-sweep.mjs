// i18n 훑기 — 3.0(app/src)과 2.6.2(src/renderer/src)의 UI 언어 범위를 **같은 자로** 잰다.
//
//   node scripts/i18n-sweep.mjs [--json=bench/results/i18n-sweep.json] [--list=N]
//
// 왜 있나: 3.0의 UI 언어가 **ko/en 두 벌로 확정**됐다(사용자 결정, R28j). 그런데 "확정"은
// 약속이고, 약속이 코드에서 지켜지는지는 눈으로 못 센다. 이 앱의 i18n 규약은 사전 파일이
// 없는 **콜사이트 인라인 `t(ko, en)`** 한 벌이라(`app/src/lib/i18n.ts`), 번역 누락은
// "사전에 키가 없다"가 아니라 **"그 자리에 한국어가 그냥 박혀 있다"**로 나타난다.
// 사전이 없으니 사전 diff도 못 한다 — 그래서 소스를 훑는 이 도구가 유일한 계기다.
//
// 무엇을 세나
//   ① t(ko,en) 콜사이트 수와 (ko→en) 쌍 — 두 트리에서 각각
//   ② 규약 위반: 인자 2개가 아님 / en 쪽에 한글 / ko와 en이 같은 문자열
//   ③ **모듈 스코프 t()** — import 시점 언어로 박제되는 함정(i18n.ts 주석의 금지 규약)
//   ④ 하드코딩 한국어 후보 — t()·isEn() 삼항 어느 쪽에도 안 덮인 한글 문자열/JSX 텍스트
//   ⑤ 범위 비교 — 2.6.2에만 있는 ko 문자열(= 3.0이 못 옮긴 문구 후보) / 3.0에만 있는 것
//
// ★ 판정이 아니라 계기다. ④는 **후보**다 — 주석·로그·개발자 문자열·`_EN` 미러 상수처럼
// 사용자에게 안 보이거나 다른 방법으로 번역된 자리가 섞인다. 수를 그대로 "버그 N건"으로
// 읽지 말고, `--list=N`으로 실물을 보고 분류하라. 이 도구는 **두 트리에 같은 자를 댄다**는
// 것만 보장한다(같은 오차가 양쪽에 걸리므로 비교는 유효하다).
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..')
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=')
const OUT = arg('json', '')
const LIST = Number(arg('list', 0))

const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/

const TREES = [
  { id: 'tauri-3.0', root: path.join(REPO, 'app', 'src'), label: '3.0 (app/src)' },
  { id: 'electron-2.6.2', root: path.join(REPO, 'src', 'renderer', 'src'), label: '2.6.2 (src/renderer/src)' }
]

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p)
  }
  return out
}

/**
 * 소스를 한 번 훑어 (a) 주석 스팬 (b) 문자열 리터럴 스팬 (c) 위치별 중괄호 깊이를 만든다.
 * 정규식만으로는 문자열 안의 `//`·중괄호에 걸려 넘어진다 — 그래서 상태 기계로 읽는다.
 */
function scan(src) {
  const comments = []
  const strings = []
  const depth = new Int32Array(src.length + 1)
  let i = 0
  let d = 0
  let paren = 0
  // 정규식 리터럴을 안 읽으면 `/`` /` 같은 패턴(백틱을 매칭하는 정규식)이 템플릿 리터럴
  // 시작으로 오인돼 그 뒤 수백 줄이 통째로 "문자열"이 된다 — 초판이 실제로 밟았다
  // (CmEditor.tsx의 후보 20여 건이 전부 이 오인이었다).
  const prevMeaningful = (p) => {
    let k = p - 1
    while (k >= 0 && /\s/.test(src[k])) k--
    return k >= 0 ? src[k] : ''
  }
  const regexCanStart = (p) => {
    const c = prevMeaningful(p)
    if (c === '' || '(,=:[!&|?{};+-*%~^<>'.includes(c)) return true
    // `return /re/` · `case /re/` 같은 키워드 뒤
    return /\b(return|typeof|case|in|of|do|else|yield|await)\s*$/.test(src.slice(Math.max(0, p - 12), p))
  }
  while (i < src.length) {
    depth[i] = d
    const c = src[i]
    const n = src[i + 1]
    if (c === '/' && n !== '/' && n !== '*' && regexCanStart(i)) {
      let k = i + 1
      let cls = false
      let ok = false
      while (k < src.length && src[k] !== '\n') {
        if (src[k] === '\\') { k += 2; continue }
        if (src[k] === '[') cls = true
        else if (src[k] === ']') cls = false
        else if (src[k] === '/' && !cls) { ok = true; k++; break }
        k++
      }
      if (ok) {
        const s = i
        while (i < k) { depth[i] = d; i++ }
        comments.push([s, k]) // 정규식 본문은 "문자열도 코드도 아님"으로 덮는다
        continue
      }
    }
    if (c === '/' && n === '/') {
      const s = i
      while (i < src.length && src[i] !== '\n') { depth[i] = d; i++ }
      comments.push([s, i])
      continue
    }
    if (c === '/' && n === '*') {
      const s = i
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { depth[i] = d; i++ }
      i = Math.min(i + 2, src.length)
      comments.push([s, i])
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      const s = i
      i++
      while (i < src.length) {
        depth[i] = d
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === q) { i++; break }
        // 템플릿 리터럴의 ${...}는 코드다 — 깊이를 흐트러뜨리지 않도록 통째로 건너뛴다.
        if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
          let k = 1
          i += 2
          while (i < src.length && k > 0) {
            if (src[i] === '{') k++
            else if (src[i] === '}') k--
            depth[i] = d
            i++
          }
          continue
        }
        i++
      }
      strings.push([s, i, q])
      continue
    }
    if (c === '{') d++
    else if (c === '}') d = Math.max(0, d - 1)
    else if (c === '(') paren++
    else if (c === ')') paren = Math.max(0, paren - 1)
    depth[i] = d
    i++
  }
  depth[src.length] = d
  return { comments, strings, depth }
}

const inSpans = (spans, pos) => spans.some(([a, b]) => pos >= a && pos < b)

/** `t(` 콜사이트에서 괄호 균형을 맞춰 인자 원문을 뜯는다(문자열·주석 인식). */
function parseArgs(src, open, sc) {
  const args = []
  let d = 0
  let start = open + 1
  let i = open
  while (i < src.length) {
    if (inSpans(sc.comments, i)) { i++; continue }
    const str = sc.strings.find(([a, b]) => i >= a && i < b)
    if (str) { i = str[1]; continue }
    const c = src[i]
    if (c === '(' || c === '[' || c === '{') d++
    else if (c === ')' || c === ']' || c === '}') {
      d--
      if (d === 0) { args.push(src.slice(start, i)); return { args, end: i } }
    } else if (c === ',' && d === 1) {
      args.push(src.slice(start, i))
      start = i + 1
    }
    i++
  }
  return { args, end: i }
}

const isLiteral = (s) => /^\s*(['"`])[\s\S]*\1\s*$/.test(s)
const litText = (s) => s.trim().slice(1, -1)

function sweepTree(tree) {
  const files = walk(tree.root)
  const calls = []
  const violations = { argCount: [], enHasHangul: [], sameBothSides: [], moduleScope: [] }
  const hardcoded = []
  let loc = 0

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8')
    loc += src.split('\n').length
    const rel = path.relative(REPO, file).replace(/\\/g, '/')
    const sc = scan(src)
    const lineOf = (pos) => src.slice(0, pos).split('\n').length

    // ── ①②③ t(ko,en) 콜사이트 ────────────────────────────────────────────────
    const covered = [] // t()의 인자 스팬 — ④에서 "덮였다"로 친다
    const re = /(^|[^A-Za-z0-9_$.])t\s*\(/g
    let m
    while ((m = re.exec(src))) {
      const open = m.index + m[0].length - 1
      if (inSpans(sc.comments, open) || inSpans(sc.strings, open)) continue
      const { args, end } = parseArgs(src, open, sc)
      covered.push([open, end + 1])
      const line = lineOf(open)
      const rec = { file: rel, line, args: args.map((a) => a.trim()) }
      if (args.length !== 2) { violations.argCount.push(rec); continue }
      const [a1, a2] = args.map((a) => a.trim())
      const both = isLiteral(a1) && isLiteral(a2)
      const ko = both ? litText(a1) : null
      const en = both ? litText(a2) : null
      calls.push({ file: rel, line, ko, en, literal: both, raw: both ? null : [a1, a2] })
      if (HANGUL.test(a2)) violations.enHasHangul.push({ ...rec, ko: a1, en: a2 })
      if (both && ko === en && HANGUL.test(ko)) violations.sameBothSides.push({ ...rec, ko, en })
      // 모듈 스코프에서 만든 t()는 import 시점 언어로 **박제**된다(i18n.ts 금지 규약).
      // 단 `() => t(...)`(중괄호 없는 화살표 본문)는 **규약이 시키는 지연 평가**다 —
      // 중괄호가 없어 깊이가 0으로 보일 뿐이라 그대로 세면 전부 거짓 양성이다
      // (초판이 4건을 그렇게 냈고 넷 다 화살표였다). 함수 정의 자체(`function t(`)도 뺀다.
      const before = src.slice(Math.max(0, m.index - 24), m.index + 1)
      const lazy = /=>\s*$/.test(before) || /\b(function|export function)\s*$/.test(before)
      if (sc.depth[open] === 0 && !lazy) violations.moduleScope.push({ file: rel, line, snippet: src.slice(m.index, Math.min(end + 1, m.index + 90)).replace(/\s+/g, ' ') })
    }

    // isEn()/en 삼항이 감싸는 구간도 "덮였다"로 친다 — 규약이 허용하는 두 번째 형태.
    const tern = /(isEn\(\)|\ben\b|lang\s*===\s*'en'|getLang\(\)\s*===\s*'en')\s*\?/g
    let tm
    while ((tm = tern.exec(src))) {
      if (inSpans(sc.comments, tm.index) || inSpans(sc.strings, tm.index)) continue
      // 삼항의 끝을 정확히 찾는 건 과하다 — 뒤 400자를 보수적으로 덮는다(과잉 덮기는
      // ④를 **과소** 보고하게 하므로, 이 도구가 내는 수는 하한이다).
      covered.push([tm.index, Math.min(src.length, tm.index + 400)])
    }
    // `..._EN`/`EN_...` 미러 상수 블록(FileModal의 GENERIC_KIND_DESC_EN 같은 것)도 덮는다.
    const mirror = /\b(?:const|let)\s+[A-Za-z0-9_$]*_?EN[A-Za-z0-9_$]*\s*[:=]/g
    let mm
    while ((mm = mirror.exec(src))) covered.push([mm.index, Math.min(src.length, mm.index + 4000)])

    // ── ④ 하드코딩 한국어 후보 ────────────────────────────────────────────────
    for (const [a, b, q] of sc.strings) {
      const text = src.slice(a + 1, b - 1)
      if (!HANGUL.test(text)) continue
      if (inSpans(covered, a)) continue
      hardcoded.push({ file: rel, line: lineOf(a), kind: 'string' + (q === '`' ? '-tpl' : ''), text: text.slice(0, 120) })
    }
    // JSX 텍스트 노드 — 문자열도 주석도 아닌 자리에 있는 한글
    for (let p = 0; p < src.length; p++) {
      if (!HANGUL.test(src[p])) continue
      if (inSpans(sc.strings, p) || inSpans(sc.comments, p) || inSpans(covered, p)) continue
      let e = p
      while (e < src.length && !/[<>{}]/.test(src[e])) e++
      hardcoded.push({ file: rel, line: lineOf(p), kind: 'jsx-text', text: src.slice(p, e).trim().slice(0, 120) })
      p = e
    }
  }

  const koSet = new Map()
  for (const c of calls) if (c.literal && c.ko != null) {
    if (!koSet.has(c.ko)) koSet.set(c.ko, { en: c.en, at: `${c.file}:${c.line}`, n: 0 })
    koSet.get(c.ko).n++
  }

  return { ...tree, files: files.length, loc, callSites: calls.length, literalPairs: koSet.size, calls, koSet, violations, hardcoded }
}

const res = TREES.map(sweepTree)
const [a3, e26] = res

// ── ⑥ 호스트 쪽 (3.0 Rust ↔ 2.6.2 main) ──────────────────────────────────────
// 렌더러만 봐서는 반쪽이다. 사용자에게 닿는 문구의 일부는 **호스트**가 만든다 —
// 2.6.2는 `src/main/lang.ts`의 `t(ko,en)`, 3.0은 `ccg_fs::t(ko,en)`(+ aimsg.rs의
// `t(en_on, ko, en)`). 두 호스트에 같은 자를 댄다.
//
// Rust 스캐너를 따로 쓰는 이유: Rust는 `'a` 수명 표기가 있어서 JS 스캐너처럼 `'`를
// 문자열 시작으로 보면 그 뒤가 통째로 문자열이 된다. Rust는 `"`와 `r#"…"#`만 본다.
function scanRust(src) {
  const comments = []
  const strings = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (c === '/' && n === '/') { const s = i; while (i < src.length && src[i] !== '\n') i++; comments.push([s, i]); continue }
    if (c === '/' && n === '*') { const s = i; i += 2; let k = 1; while (i < src.length && k > 0) { if (src[i] === '/' && src[i + 1] === '*') { k++; i += 2; continue } if (src[i] === '*' && src[i + 1] === '/') { k--; i += 2; continue } i++ } comments.push([s, i]); continue }
    if (c === 'r' && (n === '"' || n === '#')) {
      let h = 0; let k = i + 1
      while (src[k] === '#') { h++; k++ }
      if (src[k] === '"') {
        const s = i; k++
        const close = '"' + '#'.repeat(h)
        const at = src.indexOf(close, k)
        i = at < 0 ? src.length : at + close.length
        strings.push([s, i, 'r'])
        continue
      }
    }
    if (c === '"') { const s = i; i++; while (i < src.length) { if (src[i] === '\\') { i += 2; continue } if (src[i] === '"') { i++; break } i++ } strings.push([s, i, '"']); continue }
    i++
  }
  return { comments, strings }
}

function sweepHost(tree) {
  const exts = tree.lang === 'rust' ? /\.rs$/ : /\.ts$/
  const files = []
  const walkAny = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (e.name === 'target' || e.name === 'node_modules') continue; walkAny(p) }
      else if (exts.test(e.name)) files.push(p)
    }
  }
  for (const r of tree.roots) walkAny(path.join(REPO, r))

  const calls = []
  const hardcoded = []
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8')
    const rel = path.relative(REPO, file).replace(/\\/g, '/')
    const sc = tree.lang === 'rust' ? scanRust(src) : scan(src)
    const lineOf = (pos) => src.slice(0, pos).split('\n').length
    const covered = []
    // Rust는 `crate::t(` · `ccg_fs::t(` 처럼 경로가 붙는다 — `::`를 배제하면 절대다수를
    // 놓친다(초판이 238 대 6으로 잘못 셌다). TS 쪽은 `.t(` 메서드 호출과 섞이지 않게
    // 점(`.`)만 배제한다.
    const re = tree.lang === 'rust' ? /(^|[^A-Za-z0-9_])(?:[A-Za-z0-9_]+::)*t\s*\(/g : /(^|[^A-Za-z0-9_$.])t\s*\(/g
    let m
    while ((m = re.exec(src))) {
      const open = m.index + m[0].length - 1
      if (inSpans(sc.comments, open) || inSpans(sc.strings, open)) continue
      const { args, end } = parseArgs(src, open, sc)
      covered.push([open, end + 1])
      // Rust 쪽은 2인자 `t(ko,en)`과 3인자 `t(en_on, ko, en)` 두 모양이 있다.
      const a = args.map((x) => x.trim())
      const pair = a.length === 3 ? [a[1], a[2]] : a.length === 2 ? [a[0], a[1]] : null
      if (!pair) continue
      const ko = pair[0].replace(/^["']|["']$/g, '')
      if (!HANGUL.test(ko)) continue
      calls.push({ file: rel, line: lineOf(open), ko, en: pair[1].replace(/^["']|["']$/g, '') })
    }
    for (const [s, e2] of sc.strings) {
      const text = src.slice(s, e2)
      if (!HANGUL.test(text)) continue
      if (inSpans(covered, s)) continue
      hardcoded.push({ file: rel, line: lineOf(s), text: text.replace(/^r?#*"|"#*$/g, '').slice(0, 110) })
    }
  }
  const koSet = new Map()
  for (const c of calls) if (!koSet.has(c.ko)) koSet.set(c.ko, c)
  return { ...tree, files: files.length, tCallSites: calls.length, distinctKo: koSet.size, hardcoded, koSet }
}

const HOSTS = [
  { id: 'host-3.0(rust)', label: '3.0 호스트 (src-tauri/src · crates)', roots: ['src-tauri/src', 'crates'], lang: 'rust' },
  { id: 'host-2.6.2(main)', label: '2.6.2 호스트 (src/main)', roots: ['src/main'], lang: 'ts' }
]
const hosts = HOSTS.map(sweepHost)

// ── ⑤ 범위 비교 ──────────────────────────────────────────────────────────────
const onlyIn26 = [...e26.koSet.keys()].filter((k) => !a3.koSet.has(k))
const onlyIn30 = [...a3.koSet.keys()].filter((k) => !e26.koSet.has(k))
const VERSE = /verse|Verse|UEFN|\.verse/i
const only26NonVerse = onlyIn26.filter((k) => !VERSE.test(k) && !VERSE.test(e26.koSet.get(k).at))

const report = {
  what: 'UI 언어(ko/en) 범위·규약 훑기 — 3.0(app/src) vs 2.6.2(src/renderer/src)',
  method: '콜사이트 인라인 t(ko,en) 소스 스캔(사전 파일이 없어 사전 diff가 불가능하다). ④는 후보이고 과잉 덮기 때문에 **하한**이다.',
  at: new Date().toISOString(),
  trees: res.map((r) => ({
    id: r.id,
    label: r.label,
    files: r.files,
    loc: r.loc,
    tCallSites: r.callSites,
    distinctKoStrings: r.literalPairs,
    nonLiteralCalls: r.calls.filter((c) => !c.literal).length,
    violations: {
      argCount: r.violations.argCount.length,
      enHasHangul: r.violations.enHasHangul.length,
      sameBothSides: r.violations.sameBothSides.length,
      moduleScope: r.violations.moduleScope.length
    },
    hardcodedKoreanCandidates: r.hardcoded.length,
    // 정밀도가 다르다. `string`(홑/겹따옴표 리터럴)은 거의 그대로 믿을 수 있고,
    // `string-tpl`/`jsx-text`는 JSX·템플릿 안에서 스캐너가 자리를 잃어 **잡음이 많다**.
    // 그래서 종류별로 나눠 싣고, 본문 수치는 `string`만 쓴다.
    hardcodedByKind: r.hardcoded.reduce((acc, h) => ((acc[h.kind] = (acc[h.kind] ?? 0) + 1), acc), {}),
    hardcodedPlainStrings: r.hardcoded.filter((h) => h.kind === 'string').length,
    hardcodedPlainStringsExPatchNotes: r.hardcoded.filter((h) => h.kind === 'string' && !/PatchNotes/.test(h.file)).length,
    hardcodedByFile: Object.entries(
      r.hardcoded.reduce((acc, h) => ((acc[h.file] = (acc[h.file] ?? 0) + 1), acc), {})
    ).sort((x, y) => y[1] - x[1]).slice(0, 12)
  })),
  hosts: hosts.map((h) => ({
    id: h.id,
    label: h.label,
    files: h.files,
    tCallSitesWithKorean: h.tCallSites,
    distinctKo: h.distinctKo,
    hardcodedKoreanCandidates: h.hardcoded.length,
    hardcodedByFile: Object.entries(
      h.hardcoded.reduce((acc, x) => ((acc[x.file] = (acc[x.file] ?? 0) + 1), acc), {})
    ).sort((x, y) => y[1] - x[1]).slice(0, 10)
  })),
  scope: {
    koOnlyIn262: onlyIn26.length,
    koOnlyIn262_excludingVerse: only26NonVerse.length,
    koOnlyIn30: onlyIn30.length,
    shared: [...a3.koSet.keys()].filter((k) => e26.koSet.has(k)).length
  },
  samples: {
    koOnlyIn262: only26NonVerse.slice(0, LIST || 20).map((k) => ({ ko: k, en: e26.koSet.get(k).en, at: e26.koSet.get(k).at })),
    violations30: {
      enHasHangul: a3.violations.enHasHangul.slice(0, LIST || 10),
      sameBothSides: a3.violations.sameBothSides.slice(0, LIST || 10),
      moduleScope: a3.violations.moduleScope.slice(0, LIST || 10),
      argCount: a3.violations.argCount.slice(0, LIST || 10)
    },
    hardcoded30: a3.hardcoded.filter((h) => h.kind === 'string' && !/PatchNotes/.test(h.file)).slice(0, LIST || 25),
    hardcoded262: e26.hardcoded.filter((h) => h.kind === 'string' && !/PatchNotes/.test(h.file)).slice(0, LIST || 25)
  }
}

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0)
console.log('──── i18n 훑기 ────')
for (const t of report.trees) {
  console.log(
    `${t.label.padEnd(28)} 파일 ${String(t.files).padStart(3)} · t() ${String(t.tCallSites).padStart(4)} · 고유 ko ${String(t.distinctKoStrings).padStart(4)} · ` +
      `위반(인자수 ${t.violations.argCount}/en한글 ${t.violations.enHasHangul}/동일 ${t.violations.sameBothSides}/모듈스코프 ${t.violations.moduleScope}) · ` +
      `하드코딩 후보 ${t.hardcodedKoreanCandidates}(따옴표 리터럴만 ${t.hardcodedPlainStrings} · 패치노트 제외 ${t.hardcodedPlainStringsExPatchNotes})`
  )
}
for (const h of report.hosts) {
  console.log(
    `${h.label.padEnd(28)} 파일 ${String(h.files).padStart(3)} · t(ko,en) ${String(h.tCallSitesWithKorean).padStart(4)} · 고유 ko ${String(h.distinctKo).padStart(4)} · 하드코딩 후보 ${h.hardcodedKoreanCandidates}`
  )
}
console.log(
  `범위: 공유 ko ${report.scope.shared} · 2.6.2에만 ${report.scope.koOnlyIn262}(Verse 제외 ${report.scope.koOnlyIn262_excludingVerse}) · 3.0에만 ${report.scope.koOnlyIn30}`
)
console.log(`3.0 t() 커버리지(=고유 ko 중 공유 비율): ${pct(report.scope.shared, a3.literalPairs)}%`)
if (LIST) {
  console.log('\n— 2.6.2에만 있는 ko(Verse 제외) —')
  for (const s of report.samples.koOnlyIn262) console.log(`  ${s.at.padEnd(46)} ${s.ko}  →  ${s.en}`)
  console.log('\n— 3.0 하드코딩 한국어 후보 —')
  for (const h of report.samples.hardcoded30) console.log(`  ${(h.file + ':' + h.line).padEnd(46)} [${h.kind}] ${h.text}`)
  console.log('\n— 3.0 모듈 스코프 t() —')
  for (const v of report.samples.violations30.moduleScope) console.log(`  ${(v.file + ':' + v.line).padEnd(46)} ${v.snippet}`)
}

if (OUT) {
  const p = path.isAbsolute(OUT) ? OUT : path.join(REPO, OUT)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(report, null, 2))
  console.log('saved:', p)
}
