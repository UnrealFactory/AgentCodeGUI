// ── M7 LSP 픽스처 — 두 앱이 **바이트 동일한** TS 코드를 보게 만든다 ──────────────
//
// 왜 생성 픽스처인가: 실 레포 파일을 쓰면 다른 빌더의 커밋이 파일을 바꾸는 순간
// 2.6.2 기준과 3.0 측정이 **다른 입력**을 재게 된다(호버 좌표까지 어긋난다).
// 생성 픽스처는 시드가 같으면 언제 만들어도 같은 바이트라 기준을 박제할 수 있다.
//
// 언어 확장 규약: `FIXTURES`에 언어 하나당 한 항목. 픽스처가 대는 것은
//   { files, big, lib, hoverAt[], defAt[], complAt, editAnchor }
// 뿐이고 하네스(bench/lsp.mjs)는 이 모양만 안다 — Python/C#/C++를 붙일 때
// 하네스는 한 글자도 안 고친다.
import fs from 'node:fs'
import path from 'node:path'

/** 결정적 문자열 해시 → 이름에 섞을 접미사(시드 고정) */
function tag(i) {
  return String(i).padStart(4, '0')
}

// ── TypeScript ────────────────────────────────────────────────────────────────
function tsLib() {
  return `// 벤치 픽스처(생성) — 크로스 파일 정의 이동의 목적지.
export type BenchMode = 'fast' | 'safe' | 'debug'

export interface BenchConfig {
  id: number
  name: string
  mode: BenchMode
  enabled: boolean
  tags: string[]
}

export const DEFAULT_MODE: BenchMode = 'safe'

export function makeConfig(id: number, name: string, mode: BenchMode = DEFAULT_MODE): BenchConfig {
  return { id, name, mode, enabled: id % 2 === 0, tags: [name, mode] }
}

export class BenchRegistry {
  private items = new Map<number, BenchConfig>()

  register(cfg: BenchConfig): number {
    this.items.set(cfg.id, cfg)
    return this.items.size
  }

  lookup(id: number): BenchConfig | undefined {
    return this.items.get(id)
  }

  tagsOf(id: number): string[] {
    return this.items.get(id)?.tags ?? []
  }

  get size(): number {
    return this.items.size
  }
}

export function summarize(reg: BenchRegistry, ids: number[]): number {
  let total = 0
  for (const id of ids) total += reg.tagsOf(id).length
  return total
}
`
}

/** big.ts — blocks개 블록(블록당 8줄) + 마지막에 편집 앵커 주석 */
function tsBig(blocks) {
  const out = [
    `// 벤치 픽스처(생성) — 대형 파일. 블록 ${blocks}개.`,
    `import { BenchRegistry, makeConfig, summarize, DEFAULT_MODE } from './lib'`,
    `import type { BenchConfig, BenchMode } from './lib'`,
    ``,
    `export const registry = new BenchRegistry()`,
    `export const mode: BenchMode = DEFAULT_MODE`,
    ``
  ]
  for (let i = 0; i < blocks; i++) {
    const t = tag(i)
    out.push(
      `export function step${t}(input: BenchConfig): number {`,
      `  const local${t} = makeConfig(${i}, input.name + '${t}', mode)`,
      `  registry.register(local${t})`,
      `  const found = registry.lookup(local${t}.id)`,
      `  const score = found ? found.tags.length + local${t}.id : -1`,
      `  return summarize(registry, [score, ${i}])`,
      `}`,
      ``
    )
  }
  out.push(`// EDIT-ANCHOR`, ``)
  return out.join('\n')
}

/**
 * 생성한 텍스트에서 **실제 식별자 위치**를 뽑는다(0-based line/character, UTF-16).
 * 좌표를 손으로 세지 않는다 — 파일을 바꿔도 위치가 저절로 따라온다.
 */
function findPositions(text, needles) {
  const lines = text.split('\n')
  const hits = []
  for (const { re, kind, max } of needles) {
    let n = 0
    for (let li = 0; li < lines.length && n < max; li++) {
      const m = new RegExp(re).exec(lines[li])
      if (!m) continue
      // 식별자 '가운데'를 찍는다 — 경계에 찍으면 서버가 옆 토큰을 집을 수 있다
      const col = m.index + Math.floor((m[0].length - 1) / 2)
      hits.push({ line: li, character: col, kind, word: m[0] })
      n++
    }
  }
  return hits
}

export const FIXTURES = {
  ts: {
    id: 'ts',
    label: 'TypeScript',
    dir: 'lspbench',
    /** 파일을 만든다(있으면 덮어씀). 반환 = 하네스가 쓰는 좌표/경로 묶음. */
    make(workDir, { blocks = 420 } = {}) {
      const dir = path.join(workDir, 'lspbench')
      fs.mkdirSync(dir, { recursive: true })
      const lib = tsLib()
      const big = tsBig(blocks)
      fs.writeFileSync(path.join(dir, 'lib.ts'), lib)
      fs.writeFileSync(path.join(dir, 'big.ts'), big)
      // 두 앱이 같은 tsconfig 아래에서 열리게 — 클론 루트 tsconfig는 app/·src/만 include한다
      fs.writeFileSync(
        path.join(dir, 'tsconfig.json'),
        JSON.stringify(
          { compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true }, include: ['*.ts'] },
          null,
          2
        ) + '\n'
      )
      const bigRel = 'lspbench/big.ts'
      const libRel = 'lspbench/lib.ts'
      // 호버 표적: 크로스 파일 심볼(makeConfig·summarize·BenchRegistry) + 지역(local####)
      const hoverAt = findPositions(big, [
        { re: 'makeConfig', kind: 'cross-fn', max: 14 },
        { re: 'summarize', kind: 'cross-fn', max: 12 },
        { re: 'registry', kind: 'module-var', max: 10 },
        { re: 'local\\d{4}', kind: 'local', max: 12 }
      ])
      // 정의 이동 표적: 크로스 파일(→lib.ts) 우선
      const defAt = findPositions(big, [
        { re: 'makeConfig', kind: 'cross-file', max: 12 },
        { re: 'summarize', kind: 'cross-file', max: 10 },
        { re: 'BenchRegistry', kind: 'cross-file', max: 4 },
        { re: 'local\\d{4}', kind: 'same-file', max: 10 }
      ])
      return {
        lang: 'ts',
        bigRel,
        libRel,
        bigLines: big.split('\n').length,
        bigBytes: Buffer.byteLength(big),
        hoverAt,
        defAt,
        /** 완성 프로브: **라이브 버퍼**(디스크 아님)에 `registry.` 한 줄을 꽂고 그 뒤를 묻는다 */
        completionProbe(text) {
          const lines = text.split('\n')
          const at = lines.findIndex((l) => l.startsWith('// EDIT-ANCHOR'))
          const anchor = at >= 0 ? at : lines.length - 1
          const probe = ['export function __benchProbe(): unknown {', '  return registry.', '}']
          const next = [...lines.slice(0, anchor), ...probe, ...lines.slice(anchor)]
          return { text: next.join('\n'), pos: { line: anchor + 1, character: '  return registry.'.length } }
        },
        /** 디스크 변경(재정확화 측정): 새 export 심볼을 앵커에 심는다 */
        edit(text, n) {
          const add = [
            `export function benchEdit${n}(cfg: BenchConfig): BenchConfig {`,
            `  const grown = makeConfig(cfg.id + ${n}, cfg.name, cfg.mode)`,
            `  registry.register(grown)`,
            `  return grown`,
            `}`,
            ``
          ].join('\n')
          return text.replace('// EDIT-ANCHOR', add + '// EDIT-ANCHOR')
        },
        /** 편집 후 토큰이 '새 내용'을 반영했다고 볼 판정 — 새 함수 이름이 있는 줄의 토큰 존재 */
        editedMarker: (n) => `benchEdit${n}`
      }
    }
  }
  // ── 다음 라운드: py / cs / cpp — 항목 1개씩 추가하면 하네스는 그대로 돈다 ──
}
