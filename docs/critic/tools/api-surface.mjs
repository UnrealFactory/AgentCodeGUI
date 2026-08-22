// 크리틱 도구 — src/shared/api.ts의 WindowApi 표면을 점 경로 목록으로 뽑는다.
// TypeScript 컴파일러 AST를 쓰므로 정규식 추정이 아니다.
//   node docs/critic/tools/api-surface.mjs          → 한 줄에 하나씩 출력
//   node docs/critic/tools/api-surface.mjs --json    → JSON 배열
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const REPO = path.resolve(import.meta.dirname, '..', '..', '..')
const ts = require(path.join(REPO, 'node_modules', 'typescript'))

const file = path.join(REPO, 'src', 'shared', 'api.ts')
const src = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)

const out = []

function walkMembers(members, prefix) {
  for (const m of members) {
    const name = m.name && ts.isIdentifier(m.name) ? m.name.text : null
    if (!name) continue
    const dotted = prefix ? `${prefix}.${name}` : name
    if (ts.isMethodSignature(m)) {
      out.push({ path: dotted, kind: 'method' })
    } else if (ts.isPropertySignature(m)) {
      const t = m.type
      if (t && ts.isTypeLiteralNode(t)) walkMembers(t.members, dotted)
      else if (t && (ts.isFunctionTypeNode(t) || ts.isConstructorTypeNode(t))) out.push({ path: dotted, kind: 'method' })
      else out.push({ path: dotted, kind: 'property' })
    }
  }
}

ts.forEachChild(src, (node) => {
  if (ts.isInterfaceDeclaration(node) && node.name.text === 'WindowApi') walkMembers(node.members, '')
})

if (process.argv.includes('--json')) console.log(JSON.stringify(out))
else for (const e of out) console.log(`${e.kind === 'method' ? 'fn ' : 'val'} ${e.path}`)
