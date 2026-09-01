#!/usr/bin/env node
/**
 * ★LSPIDLE R3 마감 — `errHeadline`을 **여섯 모양**에 물린다(확인 크리틱 R3 §7 C급).
 *
 * 칩 한 줄을 고르는 규칙이 node의 죽음 모양을 가정하고 있었다. 크리틱이 여섯 모양을 물려
 * 두 칸에서 어긋나는 것을 보였다:
 *
 *   - **소문자 `error:`**(pyright 등) → 버전 배너(`info: pyright 1.1.0`)를 골랐다
 *   - **`Error:` 줄이 아예 없음** → 고치려던 `node:internal/…` 줄로 되돌아갔다
 *
 * 고침은 대소문자 무시 + `fatal:`·`panic:` 허용이고, 함께 막아야 하는 것이 하나 있다:
 * `/i`만 붙이면 사유의 첫 줄에 있는 **`stderr:`가 걸려** 바로 그 「고치려던 줄」이 다시
 * 뽑힌다. 그래서 `std(err|out):`은 앞에서 잘라 낸다.
 *
 * ## 이 계기가 규칙을 **옮겨 적지 않는** 이유
 *
 * 크리틱 R3은 전/후 유예 계기(`poc-lspidle-r3-grace.mjs`)가 러스트 규칙을 JS로 옮겨 적은
 * 것을 C급으로 지적했다 — 옮겨 적은 모델은 제품이 아니라 **모델**을 검사한다. 그래서
 * 여기서는 `FileModal.tsx`에서 `errHeadline` **함수 소스를 그대로 뽑아** 실행한다.
 * 제품에서 그 함수가 바뀌면 이 계기가 즉시 그 변화를 본다(못 찾으면 소리 내어 죽는다).
 *
 * ```
 * node scripts/poc-lspidle-r3-headline.mjs
 * ```
 * exe도 앱도 필요 없다 — 순수 함수 하나를 재는 자리다.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// `--src`는 **대조용** 문이다: 고침 전 파일(`git show ee14cb9:…`)을 물려 「그때는 붉었다」를
// 실측한다. 못이 무는지 안 보고 초록만 보면 그건 통과가 아니라 아무것도 안 잰 것이다.
const srcFlag = process.argv.indexOf('--src')
const SRC = srcFlag >= 0 && process.argv[srcFlag + 1] ? process.argv[srcFlag + 1] : path.join(REPO, 'app', 'src', 'components', 'FileModal.tsx')
const OUT = path.join(REPO, 'bench', 'results', 'poc-lspidle-r3-headline.json')

/** 제품 소스에서 함수를 뽑아 실행 가능한 JS로 만든다(타입 표기만 벗긴다). */
function loadErrHeadline() {
  const src = fs.readFileSync(SRC, 'utf8')
  const m = /function errHeadline\(s: string\): string \{[\s\S]*?\n\}/.exec(src)
  if (!m) throw new Error('errHeadline을 못 찾았다 — 제품이 바뀌었고 이 계기가 낡았다')
  const js = m[0].replace('(s: string): string', '(s)')
  // eslint-disable-next-line no-new-func
  return { fn: new Function(`${js}\nreturn errHeadline`)(), source: m[0] }
}

const NODE_MODULE_NOT_FOUND = [
  'LSP 서버가 종료됨 · stderr: node:internal/modules/cjs/loader:1568',
  '  throw err;',
  '  ^',
  '',
  "Error: Cannot find module 'C:/nope/missing.cjs'",
  'Require stack:',
  '- internal/preload',
  '    at Module._resolveFilename (node:internal/modules/cjs/loader:1564:15)'
].join('\n')

/** 크리틱의 여섯 모양 + 이번 고침이 새로 지켜야 하는 것들. */
const CASES = [
  {
    id: 'node-module-not-found',
    why: '배포되는 죽음(번들 node) — 첫 줄이 쓸모없고 말은 다섯째 줄에 있다',
    input: NODE_MODULE_NOT_FOUND,
    want: "Error: Cannot find module 'C:/nope/missing.cjs'"
  },
  {
    id: 'typeerror',
    why: '접두사가 붙은 에러 이름',
    input: 'LSP 서버가 종료됨 · stderr: boot\nTypeError: undefined is not a function',
    want: 'TypeError: undefined is not a function'
  },
  {
    id: 'stack-frame-mentions-error',
    why: '스택 프레임에 `…Error:`가 들어도 프레임을 안 고른다',
    input: 'at Object.<anonymous> (Error: not this one)\nError: real reason here',
    want: 'Error: real reason here'
  },
  {
    id: 'clangd-assertion',
    why: '대문자 Error:가 없다 — 첫 줄이 곧 말이다(폴백이 옳게 동작하는 칸)',
    input: 'clangd: /src/x.cpp:12: assertion failed',
    want: 'clangd: /src/x.cpp:12: assertion failed'
  },
  {
    id: 'lowercase-error-only',
    why: '★크리틱이 붉게 만든 칸 — 소문자 error:만 있고 첫 줄은 버전 배너다',
    input: 'info: pyright 1.1.0\nerror: Invalid configuration in pyrightconfig.json',
    want: 'error: Invalid configuration in pyrightconfig.json'
  },
  {
    id: 'lowercase-error-with-location',
    why: '★소문자 error:가 줄 가운데 있다(clangd/gcc 모양)',
    input: 'clangd version 17.0.0\n/src/x.cpp:12:3: error: expected \';\' after expression',
    want: "/src/x.cpp:12:3: error: expected ';' after expression"
  },
  {
    id: 'fatal',
    why: 'fatal: 도 말이다',
    input: 'starting up\nfatal: could not read config',
    want: 'fatal: could not read config'
  },
  {
    id: 'stderr-must-not-win',
    why: '★대소문자를 무시하면 첫 줄의 `stderr:`가 걸려 고치려던 줄이 되돌아온다',
    input: NODE_MODULE_NOT_FOUND,
    want: "Error: Cannot find module 'C:/nope/missing.cjs'"
  },
  {
    id: 'no-message-line-at-all',
    why: '말인 줄이 없으면 첫 줄로 떨어진다(더 나빠지지 않는다)',
    input: 'LSP 서버가 종료됨 · stderr: node:internal/modules/cjs/loader:1568\n  throw err;',
    want: 'LSP 서버가 종료됨 · stderr: node:internal/modules/cjs/loader:1568'
  },
  {
    id: 'empty',
    why: '빈 사유에 안 죽는다',
    input: '   \n\n',
    want: ''
  }
]

const { fn: errHeadline, source } = loadErrHeadline()
const rows = CASES.map((c) => {
  const got = errHeadline(c.input)
  return { id: c.id, why: c.why, got, want: c.want, ok: got === c.want }
})
const bad = rows.filter((r) => !r.ok)

for (const r of rows) {
  console.log(`${r.ok ? '  ✔' : '  ✘'} ${r.id.padEnd(28)} ${JSON.stringify(r.got)}`)
  if (!r.ok) console.log(`      기대: ${JSON.stringify(r.want)}`)
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      harness: 'poc-lspidle-r3-headline',
      at: new Date().toISOString(),
      measures: '제품 소스에서 뽑은 errHeadline을 stderr 모양들에 물린다(규칙을 옮겨 적지 않는다)',
      from: 'app/src/components/FileModal.tsx',
      functionSource: source,
      passed: rows.length - bad.length,
      total: rows.length,
      rows
    },
    null,
    2
  ) + '\n'
)
console.log(`\n${rows.length - bad.length}/${rows.length} 통과 · saved: ${OUT}`)
process.exit(bad.length ? 1 : 0)
