// ── M7 LSP 픽스처 — 두 앱이 **바이트 동일한** TS 코드를 보게 만든다 ──────────────
//
// 왜 생성 픽스처인가: 실 레포 파일을 쓰면 다른 빌더의 커밋이 파일을 바꾸는 순간
// 2.6.2 기준과 3.0 측정이 **다른 입력**을 재게 된다(호버 좌표까지 어긋난다).
// 생성 픽스처는 시드가 같으면 언제 만들어도 같은 바이트라 기준을 박제할 수 있다.
//
// 언어 확장 규약: `FIXTURES`에 언어 하나당 한 항목. 하네스(bench/lsp.mjs)가 읽는 것은
// 아래 모양뿐이다:
//
//   수치 루프  bigRel · libRel · bigLines · bigBytes · hoverAt[] · defAt[]
//              completionProbe(text) · edit(text,n) · editedMarker(n)
//   뷰어 실증  openName · symbol · crossName · typeText          ← R3에서 추가
//   능력       semantic(서버가 시맨틱 토큰을 내는가)              ← R3에서 추가
//   환경       prepareHome(home)(선택 — 내려받는 서버의 설치를 격리 홈에 잇는다)
//   청결       cleanliness(home)(선택 — 서버가 프로젝트 폴더에 남긴 흔적) ← R4에서 추가
//
// ★ R3의 정직한 정정: R1/R2는 "픽스처만 대면 하네스는 한 글자도 안 고친다"고 적었는데,
//   **절반만 맞았다.** 수치 루프는 정말 픽스처 구동이었지만 ① 뷰어 실증에는 TS 식별자가
//   네 군데 박혀 있었고(`big.ts`·`makeConfig`·`lib.ts`·`registry.`) ② "모든 서버는 시맨틱
//   토큰을 낸다"가 암묵 전제였다(pyright는 안 낸다 — Pylance 전용 기능이다).
//   그 둘을 위 다섯 필드로 뽑아내면서 하네스 본문이 바뀌었다(순증 +40줄). 이제는 진짜로
//   픽스처만 대면 된다 — C++(R4)는 이 파일에만 손대면 될 것이다.
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

// ── Python ────────────────────────────────────────────────────────────────────
function pyLib() {
  return `"""벤치 픽스처(생성) — 크로스 파일 정의 이동의 목적지."""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class BenchMode(str, Enum):
    FAST = "fast"
    SAFE = "safe"
    DEBUG = "debug"


DEFAULT_MODE: BenchMode = BenchMode.SAFE


@dataclass
class BenchConfig:
    id: int
    name: str
    mode: BenchMode
    enabled: bool
    tags: list[str] = field(default_factory=list)


def make_config(id: int, name: str, mode: BenchMode = DEFAULT_MODE) -> BenchConfig:
    return BenchConfig(id=id, name=name, mode=mode, enabled=id % 2 == 0, tags=[name, mode.value])


class BenchRegistry:
    def __init__(self) -> None:
        self.items: dict[int, BenchConfig] = {}

    def register(self, cfg: BenchConfig) -> int:
        self.items[cfg.id] = cfg
        return len(self.items)

    def lookup(self, id: int) -> BenchConfig | None:
        return self.items.get(id)

    def tags_of(self, id: int) -> list[str]:
        cfg = self.items.get(id)
        return cfg.tags if cfg is not None else []

    @property
    def size(self) -> int:
        return len(self.items)


def summarize(reg: BenchRegistry, ids: list[int]) -> int:
    total = 0
    for i in ids:
        total += len(reg.tags_of(i))
    return total
`
}

/** big.py — blocks개 블록(블록당 8줄) + 마지막에 편집 앵커 주석 */
function pyBig(blocks) {
  const out = [
    `# 벤치 픽스처(생성) — 대형 파일. 블록 ${blocks}개.`,
    `from __future__ import annotations`,
    ``,
    `from lspbench_py.lib import DEFAULT_MODE, BenchConfig, BenchMode, BenchRegistry, make_config, summarize`,
    ``,
    `registry = BenchRegistry()`,
    `mode: BenchMode = DEFAULT_MODE`,
    ``
  ]
  for (let i = 0; i < blocks; i++) {
    const t = tag(i)
    out.push(
      `def step${t}(source: BenchConfig) -> int:`,
      `    local${t} = make_config(${i}, source.name + "${t}", mode)`,
      `    registry.register(local${t})`,
      `    found = registry.lookup(local${t}.id)`,
      `    score = len(found.tags) + local${t}.id if found is not None else -1`,
      `    return summarize(registry, [score, ${i}])`,
      ``,
      ``
    )
  }
  out.push(`# EDIT-ANCHOR`, ``)
  return out.join('\n')
}

// ── C# ────────────────────────────────────────────────────────────────────────
function csLib() {
  return `// 벤치 픽스처(생성) — 크로스 **프로젝트** 정의 이동의 목적지(Core 프로젝트).
namespace Bench.Core;

public enum BenchMode { Fast, Safe, Debug }

public sealed class BenchConfig
{
    public int Id { get; init; }
    public string Name { get; init; } = "";
    public BenchMode Mode { get; init; }
    public string[] Tags { get; init; } = [];
}

public static class Factory
{
    public const BenchMode DefaultMode = BenchMode.Safe;

    public static BenchConfig MakeConfig(int id, string name, BenchMode mode = DefaultMode)
        => new() { Id = id, Name = name, Mode = mode, Tags = [name, mode.ToString()] };
}

public sealed class BenchRegistry
{
    private readonly Dictionary<int, BenchConfig> _items = new();

    public int Register(BenchConfig cfg)
    {
        _items[cfg.Id] = cfg;
        return _items.Count;
    }

    public BenchConfig? Lookup(int id) => _items.TryGetValue(id, out var c) ? c : null;

    public string[] TagsOf(int id) => Lookup(id)?.Tags ?? [];

    public int Size => _items.Count;
}

public static class Summary
{
    public static int Summarize(BenchRegistry reg, int[] ids)
    {
        var total = 0;
        foreach (var id in ids) total += reg.TagsOf(id).Length;
        return total;
    }
}
`
}

/** Big.cs — blocks개 블록(블록당 8줄) + 마지막에 편집 앵커 주석 */
function csBig(blocks) {
  const out = [
    `// 벤치 픽스처(생성) — 대형 파일. 블록 ${blocks}개.`,
    `using Bench.Core;`,
    ``,
    `namespace Bench.App;`,
    ``,
    `public static class Big`,
    `{`,
    `    public static readonly BenchRegistry Registry = new();`,
    `    public const BenchMode Mode = Factory.DefaultMode;`,
    ``
  ]
  for (let i = 0; i < blocks; i++) {
    const t = tag(i)
    out.push(
      `    public static int Step${t}(BenchConfig source)`,
      `    {`,
      `        var local${t} = Factory.MakeConfig(${i}, source.Name + "${t}", Mode);`,
      `        Registry.Register(local${t});`,
      `        var found = Registry.Lookup(local${t}.Id);`,
      `        var score = found is null ? -1 : found.Tags.Length + local${t}.Id;`,
      `        return Summary.Summarize(Registry, [score, ${i}]);`,
      `    }`,
      ``
    )
  }
  out.push(`    // EDIT-ANCHOR`, `}`, ``)
  return out.join('\n')
}

// ── C/C++ ─────────────────────────────────────────────────────────────────────
// **헤더 온리 + 표준 라이브러리 무의존.** 이유가 둘이다:
//  ① `<map>`·`<string>`을 쓰면 clangd가 MSVC STL 헤더를 찾아야 하고, 그러면 이 수치가
//     "이 기계에 어떤 VS가 깔렸나"를 재게 된다. 픽스처는 서버를 재야 한다.
//  ② 정의 이동의 목적지를 한 파일로 못 박는다 — `.h`에 선언, `.cpp`에 정의로 나누면
//     clangd가 배경 인덱스 상태에 따라 둘 중 하나로 가서 판정이 흔들린다.
function cppLib() {
  return `// 벤치 픽스처(생성) — 크로스 파일 정의 이동의 목적지(헤더 온리).
#pragma once

enum BenchMode { Fast, Safe, Debug };

struct BenchConfig {
  int id;
  const char* name;
  BenchMode mode;
  bool enabled;
  int tagCount;
};

const BenchMode DEFAULT_MODE = Safe;

inline BenchConfig makeConfig(int id, const char* name, BenchMode mode = DEFAULT_MODE) {
  BenchConfig cfg;
  cfg.id = id;
  cfg.name = name;
  cfg.mode = mode;
  cfg.enabled = (id % 2) == 0;
  cfg.tagCount = 2;
  return cfg;
}

class BenchRegistry {
 public:
  int add(const BenchConfig& cfg) {
    if (count_ < kCapacity) items_[count_++] = cfg;
    return count_;
  }

  const BenchConfig* lookup(int id) const {
    for (int i = 0; i < count_; ++i) {
      if (items_[i].id == id) return &items_[i];
    }
    return nullptr;
  }

  int tagsOf(int id) const {
    const BenchConfig* found = lookup(id);
    return found ? found->tagCount : 0;
  }

  int size() const { return count_; }

 private:
  static const int kCapacity = 512;
  BenchConfig items_[kCapacity];
  int count_ = 0;
};

inline int summarize(const BenchRegistry& reg, int a, int b) {
  return reg.tagsOf(a) + reg.tagsOf(b);
}
`
}

/** big.cpp — blocks개 블록(블록당 8줄) + 마지막에 편집 앵커 주석 */
function cppBig(blocks) {
  const out = [
    `// 벤치 픽스처(생성) — 대형 파일. 블록 ${blocks}개.`,
    `#include "lib.h"`,
    ``,
    `BenchRegistry registry;`,
    `const BenchMode mode = DEFAULT_MODE;`,
    ``
  ]
  for (let i = 0; i < blocks; i++) {
    const t = tag(i)
    out.push(
      `int step${t}(const BenchConfig& source) {`,
      `  BenchConfig local${t} = makeConfig(${i}, source.name, mode);`,
      `  registry.add(local${t});`,
      `  const BenchConfig* found = registry.lookup(local${t}.id);`,
      `  int score = found ? found->tagCount + local${t}.id : -1;`,
      `  return summarize(registry, score, ${i});`,
      `}`,
      ``
    )
  }
  out.push(`// EDIT-ANCHOR`, ``)
  return out.join('\n')
}

const CS_PROJ = (refs) =>
  `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <EnableDefaultCompileItems>true</EnableDefaultCompileItems>
  </PropertyGroup>${refs}
</Project>
`

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
        // 뷰어 실증이 쓰는 값 — R2까지 하네스 본문에 박혀 있던 네 개다
        semantic: true,
        openName: 'big.ts',
        symbol: 'makeConfig',
        crossName: 'lib.ts',
        typeText: '\nregistry.',
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
  },

  // ── Python (pyright) ────────────────────────────────────────────────────────
  // 패키지(`__init__.py`)로 만든다 — pyright의 기본 검색 경로는 **워크스페이스 루트**라,
  // `from lib import …`는 안 풀리고 `from lspbench_py.lib import …`는 풀린다.
  py: {
    id: 'py',
    label: 'Python',
    dir: 'lspbench_py',
    make(workDir, { blocks = 420 } = {}) {
      const dir = path.join(workDir, 'lspbench_py')
      fs.mkdirSync(dir, { recursive: true })
      const lib = pyLib()
      const big = pyBig(blocks)
      fs.writeFileSync(path.join(dir, '__init__.py'), '')
      fs.writeFileSync(path.join(dir, 'lib.py'), lib)
      fs.writeFileSync(path.join(dir, 'big.py'), big)
      const bigRel = 'lspbench_py/big.py'
      const hoverAt = findPositions(big, [
        { re: 'make_config', kind: 'cross-fn', max: 14 },
        { re: 'summarize', kind: 'cross-fn', max: 12 },
        { re: 'registry', kind: 'module-var', max: 10 },
        { re: 'local\\d{4}', kind: 'local', max: 12 }
      ])
      const defAt = findPositions(big, [
        { re: 'make_config', kind: 'cross-file', max: 12 },
        { re: 'summarize', kind: 'cross-file', max: 10 },
        { re: 'BenchRegistry', kind: 'cross-file', max: 4 },
        { re: 'local\\d{4}', kind: 'same-file', max: 10 }
      ])
      return {
        lang: 'py',
        bigRel,
        libRel: 'lspbench_py/lib.py',
        bigLines: big.split('\n').length,
        bigBytes: Buffer.byteLength(big),
        hoverAt,
        defAt,
        // ★ pyright(오픈소스)에는 semanticTokensProvider가 **없다** — 시맨틱 색은 Pylance
        //   전용 기능이라 2.6.2도 3.0도 같이 없다(실측: initialize 응답에 legend 부재).
        //   뷰어는 highlight.js 문법 색으로 떨어지고, 하네스는 토큰 눈금을 건너뛴다.
        semantic: false,
        openName: 'big.py',
        symbol: 'make_config',
        crossName: 'lib.py',
        // 파일 끝(Ctrl+End)에 꽂는다 — 대입문 형태여야 파서가 회복하고 멤버 목록이 뜬다
        typeText: '\n_probe = registry.',
        completionProbe(text) {
          const lines = text.split('\n')
          const at = lines.findIndex((l) => l.startsWith('# EDIT-ANCHOR'))
          const anchor = at >= 0 ? at : lines.length - 1
          const probe = ['def _bench_probe() -> object:', '    return registry.']
          const next = [...lines.slice(0, anchor), ...probe, ...lines.slice(anchor)]
          return { text: next.join('\n'), pos: { line: anchor + 1, character: '    return registry.'.length } }
        },
        edit(text, n) {
          const add = [
            `def bench_edit${n}(cfg: BenchConfig) -> BenchConfig:`,
            `    grown = make_config(cfg.id + ${n}, cfg.name, cfg.mode)`,
            `    registry.register(grown)`,
            `    return grown`,
            ``,
            ``
          ].join('\n')
          return text.replace('# EDIT-ANCHOR', add + '# EDIT-ANCHOR')
        },
        editedMarker: (n) => `bench_edit${n}`
      }
    }
  },

  // ── C# (Roslyn) ─────────────────────────────────────────────────────────────
  // 두 프로젝트(App → Core 참조) + 솔루션. **App 폴더에 단일 프로젝트 미끼 솔루션**을
  // 같이 깐다 — `RootRule::ReferencingSolution`이 "참조 프로젝트 최대"를 고르지 못하면
  // 미끼가 이기고, 그러면 크로스 프로젝트 정의 이동이 통째로 실패해 눈금에 드러난다.
  cs: {
    id: 'cs',
    label: 'C#',
    dir: 'lspbench_cs',
    make(workDir, { blocks = 420 } = {}) {
      const dir = path.join(workDir, 'lspbench_cs')
      const core = path.join(dir, 'src', 'Core')
      const app = path.join(dir, 'src', 'App')
      fs.mkdirSync(core, { recursive: true })
      fs.mkdirSync(app, { recursive: true })
      const lib = csLib()
      const big = csBig(blocks)
      fs.writeFileSync(path.join(core, 'Core.csproj'), CS_PROJ(''))
      fs.writeFileSync(path.join(core, 'Lib.cs'), lib)
      fs.writeFileSync(
        path.join(app, 'App.csproj'),
        CS_PROJ('\n  <ItemGroup>\n    <ProjectReference Include="..\\Core\\Core.csproj" />\n  </ItemGroup>')
      )
      fs.writeFileSync(path.join(app, 'Big.cs'), big)
      // 미끼: App만 참조하는 단일 프로젝트 솔루션(안쪽)
      fs.writeFileSync(path.join(app, 'AppOnly.slnx'), '<Solution>\n  <Project Path="App.csproj" />\n</Solution>\n')
      // 진짜: 두 프로젝트를 참조하는 솔루션(바깥)
      fs.writeFileSync(
        path.join(dir, 'Bench.slnx'),
        '<Solution>\n  <Project Path="src/Core/Core.csproj" />\n  <Project Path="src/App/App.csproj" />\n</Solution>\n'
      )
      const bigRel = 'lspbench_cs/src/App/Big.cs'
      const hoverAt = findPositions(big, [
        { re: 'MakeConfig', kind: 'cross-fn', max: 14 },
        { re: 'Summarize', kind: 'cross-fn', max: 12 },
        { re: 'Registry', kind: 'module-var', max: 10 },
        { re: 'local\\d{4}', kind: 'local', max: 12 }
      ])
      const defAt = findPositions(big, [
        { re: 'MakeConfig', kind: 'cross-file', max: 12 },
        { re: 'Summarize', kind: 'cross-file', max: 10 },
        { re: 'BenchConfig', kind: 'cross-file', max: 4 },
        { re: 'local\\d{4}', kind: 'same-file', max: 10 }
      ])
      return {
        lang: 'cs',
        bigRel,
        libRel: 'lspbench_cs/src/Core/Lib.cs',
        bigLines: big.split('\n').length,
        bigBytes: Buffer.byteLength(big),
        hoverAt,
        defAt,
        semantic: true,
        openName: 'Big.cs',
        symbol: 'MakeConfig',
        crossName: 'Lib.cs',
        // 파일 끝(= 클래스 닫는 괄호 뒤)에 꽂으므로 **새 타입 안**에서 물어야 한다.
        // 파일 스코프 네임스페이스(`namespace Bench.App;`)라 `Big`이 그대로 보인다.
        typeText: '\n\npublic static class BenchProbeCls { public static object P() { return Big.Registry.',
        /** 내려받는 서버 — **2.6.2가 이미 받아 둔 설치를 격리 홈에 정션으로 잇는다**
         *  (159MB를 주행마다 복사하지 않는다. 실홈은 읽기 전용으로만 닿는다). */
        prepareHome(home) {
          const real = path.join(process.env.USERPROFILE || '', '.agentcodegui', 'lsp', 'cs')
          const dst = path.join(home, 'lsp', 'cs')
          if (!fs.existsSync(real)) return { linked: false, reason: `실홈에 Roslyn 설치 없음: ${real}` }
          fs.mkdirSync(path.dirname(dst), { recursive: true })
          // ★ 정션을 지울 때는 반드시 unlink — recursive rm이 대상(실홈 159MB)을 따라가면
          //   사용자의 설치가 사라진다. lstat으로 먼저 가른다.
          try {
            const st = fs.lstatSync(dst)
            if (st.isSymbolicLink()) fs.unlinkSync(dst)
            else fs.rmSync(dst, { recursive: true, force: true })
          } catch { /* 없거나 잠김 */ }
          try {
            fs.symlinkSync(real, dst, 'junction')
            return { linked: true, from: real }
          } catch (e) {
            return { linked: false, reason: String(e?.message ?? e) }
          }
        },
        completionProbe(text) {
          const lines = text.split('\n')
          const at = lines.findIndex((l) => l.includes('// EDIT-ANCHOR'))
          const anchor = at >= 0 ? at : lines.length - 2
          const probe = ['    public static object BenchProbe()', '    {', '        return Registry.', '    }']
          const next = [...lines.slice(0, anchor), ...probe, ...lines.slice(anchor)]
          return { text: next.join('\n'), pos: { line: anchor + 2, character: '        return Registry.'.length } }
        },
        edit(text, n) {
          const add = [
            `    public static BenchConfig BenchEdit${n}(BenchConfig cfg)`,
            `    {`,
            `        var grown = Factory.MakeConfig(cfg.Id + ${n}, cfg.Name, cfg.Mode);`,
            `        Registry.Register(grown);`,
            `        return grown;`,
            `    }`,
            ``,
            `    `
          ].join('\n')
          return text.replace('    // EDIT-ANCHOR', add + '// EDIT-ANCHOR')
        },
        editedMarker: (n) => `BenchEdit${n}`
      }
    }
  },

  // ── C/C++ (clangd) ──────────────────────────────────────────────────────────
  // R3이 적어 둔 판정: "cpp는 이 파일에만 손대면 될 것이다." **그 약속은 지켜졌다** —
  // 아래 항목 하나 + `lsp.mjs`의 `cleanliness` 한 검사(3.0 고유 주장이라 새 눈금이다)뿐이다.
  cpp: {
    id: 'cpp',
    label: 'C/C++',
    dir: 'lspbench_cpp',
    make(workDir, { blocks = 420 } = {}) {
      const dir = path.join(workDir, 'lspbench_cpp')
      fs.mkdirSync(dir, { recursive: true })
      // clangd의 디스크 인덱스를 지우고 시작한다 — 안 지우면 2.6.2 팔이 **앞 주행이 소스
      // 트리에 남긴 인덱스**를 물고 시작해 콜드가 콜드가 아니다(3.0 인덱스는 앱 홈에 있어
      // 홈을 지우면 함께 사라진다 → 그대로 두면 A/B가 비대칭이 된다).
      fs.rmSync(path.join(dir, '.cache'), { recursive: true, force: true })
      const lib = cppLib()
      const big = cppBig(blocks)
      fs.writeFileSync(path.join(dir, 'lib.h'), lib)
      fs.writeFileSync(path.join(dir, 'big.cpp'), big)
      // compile DB — clangd에겐 이 파일이 다리다. 경로는 전부 절대(그래야 앱 홈으로 미러해도
      // 그대로 유효하다). 드라이버가 이 기계에 없어도 된다: 시스템 헤더를 안 쓰기 때문에
      // clangd가 드라이버에 물어볼 일이 없다.
      const u = (p) => p.replace(/\\/g, '/')
      fs.writeFileSync(
        path.join(dir, 'compile_commands.json'),
        JSON.stringify(
          [
            {
              directory: u(dir),
              command: `clang++ -std=c++17 -x c++ -I${u(dir)} -c ${u(path.join(dir, 'big.cpp'))}`,
              file: u(path.join(dir, 'big.cpp'))
            }
          ],
          null,
          2
        ) + '\n'
      )
      const bigRel = 'lspbench_cpp/big.cpp'
      const hoverAt = findPositions(big, [
        { re: 'makeConfig', kind: 'cross-fn', max: 14 },
        { re: 'summarize', kind: 'cross-fn', max: 12 },
        { re: 'registry', kind: 'module-var', max: 10 },
        { re: 'local\\d{4}', kind: 'local', max: 12 }
      ])
      const defAt = findPositions(big, [
        { re: 'makeConfig', kind: 'cross-file', max: 12 },
        { re: 'summarize', kind: 'cross-file', max: 10 },
        { re: 'BenchConfig', kind: 'cross-file', max: 4 },
        { re: 'local\\d{4}', kind: 'same-file', max: 10 }
      ])
      return {
        lang: 'cpp',
        bigRel,
        libRel: 'lspbench_cpp/lib.h',
        bigLines: big.split('\n').length,
        bigBytes: Buffer.byteLength(big),
        hoverAt,
        defAt,
        semantic: true,
        openName: 'big.cpp',
        symbol: 'makeConfig',
        crossName: 'lib.h',
        // 파일 끝(Ctrl+End)에 새 함수를 열고 그 안에서 멤버를 묻는다
        typeText: '\n\nint benchProbeFn() { return registry.',
        /** 팔마다 콜드 앞에서 부른다 — **앞 팔이 소스 트리에 남긴 인덱스를 지운다.**
         *  안 지우면 두 번째 팔의 '프로젝트 오염' 칸이 첫 팔의 흔적을 세어 버린다
         *  (R4 첫 주행에서 실제로 3.0이 남기지도 않은 3개를 뒤집어썼다). */
        resetTrace() {
          fs.rmSync(path.join(dir, '.cache'), { recursive: true, force: true })
        },
        /** 3.0의 고유 주장 — **프로젝트 폴더에 흔적을 안 남긴다**. 두 앱을 같은 잣대로 본다.
         *  clangd의 디스크 인덱스는 compile DB 폴더 옆(`.cache/clangd`)에 쌓인다. */
        cleanliness(home) {
          const inTree = path.join(dir, '.cache')
          const cppDb = path.join(home, 'lsp', 'cpp-db')
          const walk = (d) => {
            try {
              return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
                e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]
              )
            } catch {
              return []
            }
          }
          const homeIdx = walk(cppDb)
          return {
            projectCacheDir: inTree,
            projectPolluted: fs.existsSync(inTree),
            projectFiles: walk(inTree).length,
            appHomeDbDir: cppDb,
            appHomeFiles: homeIdx.length,
            appHomeHasDb: homeIdx.some((f) => f.endsWith('compile_commands.json'))
          }
        },
        /** 내려받는 서버 — 실홈에 이미 있는 clangd 설치를 격리 홈에 정션으로 잇는다
         *  (cs와 같은 규약: 실홈은 읽기 전용으로만 닿고, 정션은 unlink로만 지운다). */
        prepareHome(home) {
          const real = path.join(process.env.USERPROFILE || '', '.agentcodegui', 'lsp', 'cpp')
          const dst = path.join(home, 'lsp', 'cpp')
          if (!fs.existsSync(real)) return { linked: false, reason: `실홈에 clangd 설치 없음: ${real}` }
          fs.mkdirSync(path.dirname(dst), { recursive: true })
          try {
            const st = fs.lstatSync(dst)
            if (st.isSymbolicLink()) fs.unlinkSync(dst)
            else fs.rmSync(dst, { recursive: true, force: true })
          } catch { /* 없거나 잠김 */ }
          try {
            fs.symlinkSync(real, dst, 'junction')
            return { linked: true, from: real }
          } catch (e) {
            return { linked: false, reason: String(e?.message ?? e) }
          }
        },
        completionProbe(text) {
          const lines = text.split('\n')
          const at = lines.findIndex((l) => l.startsWith('// EDIT-ANCHOR'))
          const anchor = at >= 0 ? at : lines.length - 1
          const probe = ['int benchProbe() {', '  return registry.', '}']
          const next = [...lines.slice(0, anchor), ...probe, ...lines.slice(anchor)]
          return { text: next.join('\n'), pos: { line: anchor + 1, character: '  return registry.'.length } }
        },
        edit(text, n) {
          const add = [
            `int benchEdit${n}(const BenchConfig& cfg) {`,
            `  BenchConfig grown = makeConfig(cfg.id + ${n}, cfg.name, cfg.mode);`,
            `  registry.add(grown);`,
            `  return grown.id;`,
            `}`,
            ``
          ].join('\n')
          return text.replace('// EDIT-ANCHOR', add + '// EDIT-ANCHOR')
        },
        editedMarker: (n) => `benchEdit${n}`
      }
    }
  }
}
