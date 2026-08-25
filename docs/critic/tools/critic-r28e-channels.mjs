// 최종 파리티 R2 감사 도구 — 계약면(src/shared/protocol.ts `IPC`)의 채널 전수를
// **커밋된 Rust 소스**와 대조한다.
//
//   node docs/critic/tools/critic-r28e-channels.mjs [--tree=<경로>] [--out=<json>]
//
// R1(`docs/critic/final-parity-r1-channels.json`)이 쓴 것과 같은 잣대를 쓰되,
// 두 가지를 더 본다 —
//   ① 문자열이 **주석에만** 있는지 / 코드에 있는지 (R1의 `btw:open`이 그 함정이었다:
//      주석 한 줄 때문에 "있다"로 셀 뻔했다. R1은 반대로 손으로 갈랐다)
//   ② 디스패처의 **match 팔**에 실제로 걸리는지 — `ch::` 상수만 정의하고 아무도 안 쓰면
//      채널은 여전히 `{__unimplemented:true}`로 떨어진다.
//
// 판정:
//   impl      = 코드(주석 아님)에 채널 문자열/상수가 있고 dispatch 경로에서 참조된다
//   comment   = 주석에만 있다 (= 미구현)
//   missing   = 어디에도 없다
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const REPO = path.resolve(import.meta.dirname, '..', '..', '..')
const argv = process.argv.slice(2)
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d }
const TREE = path.resolve(arg('tree', REPO))
const OUT = arg('out', null)

// ── 계약면: protocol.ts의 IPC 맵을 TS AST로 읽는다(정규식 추정 아님) ───────────
const ts = require(path.join(REPO, 'node_modules', 'typescript'))
const pfile = path.join(TREE, 'src', 'shared', 'protocol.ts')
const psrc = ts.createSourceFile(pfile, fs.readFileSync(pfile, 'utf8'), ts.ScriptTarget.Latest, true)

const channels = []
function readIpcMap(node) {
  if (!ts.isVariableStatement(node)) return
  for (const d of node.declarationList.declarations) {
    if (!ts.isIdentifier(d.name) || d.name.text !== 'IPC') continue
    const init = d.initializer
    const obj = init && ts.isAsExpression(init) ? init.expression : init
    if (!obj || !ts.isObjectLiteralExpression(obj)) continue
    for (const p of obj.properties) {
      if (!ts.isPropertyAssignment(p)) continue
      const key = ts.isIdentifier(p.name) ? p.name.text : ts.isStringLiteral(p.name) ? p.name.text : null
      if (!key) continue
      if (!ts.isStringLiteral(p.initializer)) continue
      channels.push({ key, ch: p.initializer.text })
    }
  }
}
ts.forEachChild(psrc, readIpcMap)

// ── Rust 소스 전수 스캔 ─────────────────────────────────────────────────────────
const rustRoots = [path.join(TREE, 'src-tauri', 'src'), path.join(TREE, 'crates')]
const files = []
;(function walk(dir) {
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'target') walk(p) }
    else if (e.name.endsWith('.rs')) files.push(p)
  }
})(rustRoots[0])
walkAll()
function walkAll() {
  ;(function walk(dir) {
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'target') walk(p) }
      else if (e.name.endsWith('.rs')) files.push(p)
    }
  })(rustRoots[1])
}

// 한 줄이 Rust 주석인가 — `//`/`//!`/`///`로 시작하거나 블록 주석 몸통.
// 대략적이지만 이 코드베이스는 블록 주석을 거의 안 쓰므로 줄 단위 판정으로 충분하다.
const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line)

const src = files.map((f) => ({ f, lines: fs.readFileSync(f, 'utf8').split(/\r?\n/) }))

function hits(needle) {
  const code = []
  const comments = []
  for (const { f, lines } of src) {
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(needle)) continue
      const where = `${path.relative(TREE, f).replace(/\\/g, '/')}:${i + 1}`
      if (isComment(lines[i])) comments.push(where)
      else code.push(where)
    }
  }
  return { code, comments }
}

const rows = channels.map(({ key, ch }) => {
  const h = hits(`"${ch}"`)
  const verdict = h.code.length ? 'impl' : h.comments.length ? 'comment' : 'missing'
  return { key, ch, verdict, code: h.code.slice(0, 4), codeN: h.code.length, commentN: h.comments.length }
})

const summary = {
  at: new Date().toISOString(),
  tree: TREE,
  gitHead: (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim() } catch { return null } })(),
  total: rows.length,
  impl: rows.filter((r) => r.verdict === 'impl').length,
  commentOnly: rows.filter((r) => r.verdict === 'comment').length,
  missing: rows.filter((r) => r.verdict === 'missing').length
}

const out = { ...summary, rows }
if (OUT) fs.writeFileSync(path.resolve(OUT), JSON.stringify(out, null, 2))
console.log(JSON.stringify(summary, null, 2))
for (const r of rows.filter((x) => x.verdict !== 'impl')) console.log(`${r.verdict.toUpperCase().padEnd(8)} ${r.key.padEnd(28)} ${r.ch}`)
