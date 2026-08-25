// 최종 파리티 R2 — 계약면(`WindowApi`)의 **잎 이름**이 두 구현에 다 있는가.
//
//   node docs/critic/tools/critic-r28e-surface.mjs
//
// 채널 스캔은 "Rust에 핸들러가 있나"를 본다. 이건 그 한 칸 위 — **렌더러가 부를 메서드
// 자체가 있나**를 본다. 3.0은 preload가 아니라 `app/src/api/shim.ts`가 그 자리를 채우므로,
// 심에 메서드가 통째로 없으면 화면이 `undefined is not a function`으로 죽는다(안전값도
// 못 준다). 러프한 이름 매칭이지만 **누락은 잡는다**(있는데 못 잡는 거짓 경보는
// 사람이 한 줄로 확인할 수 있다).
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const REPO = path.resolve(import.meta.dirname, '..', '..', '..')
const api = JSON.parse(execFileSync('node', [path.join(REPO, 'docs/critic/tools/api-surface.mjs'), '--json'], { encoding: 'utf8' }))
const shim = fs.readFileSync(path.join(REPO, 'app/src/api/shim.ts'), 'utf8')
const pre = fs.readFileSync(path.join(REPO, 'src/preload/index.ts'), 'utf8')

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const has = (src, leaf) => new RegExp(`(^|[^A-Za-z0-9_$])${esc(leaf)}\\s*[:(]`, 'm').test(src)

const missShim = []
const missPre = []
for (const e of api) {
  const leaf = e.path.split('.').pop()
  if (!has(shim, leaf)) missShim.push(e.path)
  if (!has(pre, leaf)) missPre.push(e.path)
}
console.log(`WindowApi 표면 ${api.length}개`)
console.log(`app/src/api/shim.ts(3.0)에 이름이 없는 것 ${missShim.length}: ${missShim.join(', ') || '(없음)'}`)
console.log(`src/preload/index.ts(2.6.2)에 이름이 없는 것 ${missPre.length}: ${missPre.join(', ') || '(없음)'}`)
