// ── M7 크리틱 — "이 레포보다 큰 무대" 생성기 ─────────────────────────────────
// 결정적(시드 고정) 대형 TS 프로젝트를 만든다. 네트워크 없이 재현 가능하게.
//   node m7-genbig.mjs [--dir %TEMP%/ccg-m7c-big] [--src 3000] [--nm 15000]
//     --src : src/ 아래 .ts 파일 수(서로 import 하는 사슬 — tsserver가 실제로 타입 검사)
//     --nm  : node_modules/ 아래 잡파일 수(탐색·해석 부하)
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const argv = process.argv.slice(2)
const flag = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const DIR = flag('dir', path.join(os.tmpdir(), 'ccg-m7c-big'))
const SRC = Number(flag('src', '3000'))
const NM = Number(flag('nm', '15000'))
const FORCE = argv.includes('--force')

if (FORCE) fs.rmSync(DIR, { recursive: true, force: true })
const stamp = path.join(DIR, '.gen.json')
if (fs.existsSync(stamp)) {
  const s = JSON.parse(fs.readFileSync(stamp, 'utf8'))
  if (s.src === SRC && s.nm === NM) {
    console.log(JSON.stringify({ dir: DIR, reused: true, ...s }))
    process.exit(0)
  }
  fs.rmSync(DIR, { recursive: true, force: true })
}

const srcDir = path.join(DIR, 'src')
fs.mkdirSync(srcDir, { recursive: true })
fs.writeFileSync(path.join(DIR, 'package.json'), JSON.stringify({ name: 'ccg-m7c-big', version: '0.0.0', private: true }, null, 2))
fs.writeFileSync(
  path.join(DIR, 'tsconfig.json'),
  JSON.stringify(
    { compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true }, include: ['src/**/*.ts'] },
    null, 2
  ) + '\n'
)

// 공통 코어 — 모든 모듈이 여기서 타입을 끌어온다(크로스 파일 해석을 강제)
fs.writeFileSync(path.join(srcDir, 'core.ts'), `export interface Node { id: number; name: string; kids: number[] }
export type Kind = 'leaf' | 'branch' | 'root'
export class Graph {
  private m = new Map<number, Node>()
  add(n: Node): number { this.m.set(n.id, n); return this.m.size }
  get(id: number): Node | undefined { return this.m.get(id) }
  kindOf(id: number): Kind { const n = this.m.get(id); return !n ? 'leaf' : n.kids.length ? 'branch' : 'root' }
  get size(): number { return this.m.size }
}
export function mk(id: number, name: string): Node { return { id, name, kids: [] } }
export const shared = new Graph()
`)

const pad = (i) => String(i).padStart(5, '0')
let bytes = 0
// 20개 폴더로 나눠 담는다(한 폴더 3000 항목은 탐색기·워처가 비현실적으로 힘들다)
for (let i = 0; i < SRC; i++) {
  const d = path.join(srcDir, 'm' + String(Math.floor(i / 150)).padStart(3, '0'))
  if (i % 150 === 0) fs.mkdirSync(d, { recursive: true })
  const t = pad(i)
  const prev = i > 0 ? `import { unit${pad(i - 1)} } from '${i % 150 === 0 ? '../m' + String(Math.floor((i - 1) / 150)).padStart(3, '0') + '/u' + pad(i - 1) : './u' + pad(i - 1)}'\n` : ''
  const body = `import { Graph, mk, shared, type Node, type Kind } from '${'../'.repeat(1)}core'
${prev}
export interface Unit${t} { id: number; label: string; node: Node; kind: Kind }
export function unit${t}(g: Graph = shared): Unit${t} {
  const n = mk(${i}, 'u${t}')
  g.add(n)
  ${i > 0 ? `const up = unit${pad(i - 1)}(g)\n  n.kids.push(up.node.id)` : 'n.kids.push(0)'}
  return { id: ${i}, label: 'u${t}', node: n, kind: g.kindOf(${i}) }
}
export const meta${t} = { id: ${i}, tags: ['a${t}', 'b${t}'], size: () => shared.size } as const
`
  const f = path.join(d, `u${t}.ts`)
  fs.writeFileSync(f, body)
  bytes += body.length
}

// node_modules — 실제 패키지 모양의 잡파일들(해석·워처·탐색기 부하)
let nmFiles = 0
const nmRoot = path.join(DIR, 'node_modules')
fs.mkdirSync(nmRoot, { recursive: true })
const perPkg = 30
const pkgs = Math.ceil(NM / perPkg)
for (let p = 0; p < pkgs && nmFiles < NM; p++) {
  const pk = path.join(nmRoot, 'pkg' + String(p).padStart(4, '0'), 'lib')
  fs.mkdirSync(pk, { recursive: true })
  fs.writeFileSync(path.join(pk, '..', 'package.json'), JSON.stringify({ name: 'pkg' + p, version: '1.0.0', main: 'lib/index.js', types: 'lib/index.d.ts' }))
  nmFiles++
  for (let k = 0; k < perPkg && nmFiles < NM; k++) {
    const base = k === 0 ? 'index' : 'f' + String(k).padStart(3, '0')
    fs.writeFileSync(path.join(pk, base + '.js'), `module.exports.v${k} = function v${k}(a){ return a + ${k} }\n`)
    nmFiles++
    if (nmFiles < NM) {
      fs.writeFileSync(path.join(pk, base + '.d.ts'), `export declare function v${k}(a: number): number\n`)
      nmFiles++
    }
  }
}

const info = { src: SRC, nm: NM, nmFiles, srcBytes: bytes, at: new Date().toISOString() }
fs.writeFileSync(stamp, JSON.stringify(info, null, 2))
console.log(JSON.stringify({ dir: DIR, reused: false, ...info }))
