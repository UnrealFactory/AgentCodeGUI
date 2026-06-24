import type { CSSProperties } from 'react'
import { IconFile } from './icons'

// A file's display identity: a short monogram, a solid badge color, and the
// highlight.js language id used to syntax-colour its contents in the viewer card.
export interface FileType {
  label: string // 1-4 char monogram shown in the badge ('' → generic file glyph)
  color: string // badge tint/text — fixed oklch (NOT a theme token: 다크 테마의
  //              저채도 토큰으로는 배지가 묻혀서, 언어 브랜드 색을 고정값으로 쓴다)
  lang: string // highlight.js language id ('' → let hljs auto-detect)
}

// extension → identity. 소스 파일은 언어 브랜드 색(중간 밝기, 충분한 채도)으로 또렷하게,
// 빌드·설정류(sln/csproj/props/ini…)는 저채도 슬레이트로 가라앉혀 소스와 즉각 구분되게.
const EXT: Record<string, FileType> = {
  // C-family / .NET
  cs: { label: 'C#', color: 'oklch(0.51 0.17 305)', lang: 'csharp' },
  csx: { label: 'C#', color: 'oklch(0.51 0.17 305)', lang: 'csharp' },
  cpp: { label: 'C++', color: 'oklch(0.50 0.14 255)', lang: 'cpp' },
  cc: { label: 'C++', color: 'oklch(0.50 0.14 255)', lang: 'cpp' },
  cxx: { label: 'C++', color: 'oklch(0.50 0.14 255)', lang: 'cpp' },
  c: { label: 'C', color: 'oklch(0.45 0.10 240)', lang: 'c' },
  hpp: { label: 'H+', color: 'oklch(0.56 0.10 215)', lang: 'cpp' },
  hxx: { label: 'H+', color: 'oklch(0.56 0.10 215)', lang: 'cpp' },
  hh: { label: 'H+', color: 'oklch(0.56 0.10 215)', lang: 'cpp' },
  // .h는 하이라이트도 C++로 — 실무에선 거의 C++ 헤더고, C 문법엔 public/class 같은
  // 키워드가 없어 접근 지시자가 안 칠해진다 (LSP 쪽 exts 매핑과 동일한 선택)
  h: { label: 'H', color: 'oklch(0.56 0.10 215)', lang: 'cpp' },
  m: { label: 'M', color: 'oklch(0.55 0.12 235)', lang: 'objectivec' },
  mm: { label: 'MM', color: 'oklch(0.55 0.12 235)', lang: 'objectivec' },
  // .NET / MSBuild (Rider · Visual Studio) — 빌드 배관은 무채색 슬레이트 (라벨로 구분)
  sln: { label: 'SLN', color: 'oklch(0.48 0.045 290)', lang: '' },
  slnx: { label: 'SLN', color: 'oklch(0.48 0.045 290)', lang: 'xml' },
  csproj: { label: 'PROJ', color: 'oklch(0.50 0.04 270)', lang: 'xml' },
  fsproj: { label: 'PROJ', color: 'oklch(0.50 0.04 270)', lang: 'xml' },
  vbproj: { label: 'PROJ', color: 'oklch(0.50 0.04 270)', lang: 'xml' },
  vcxproj: { label: 'PROJ', color: 'oklch(0.50 0.04 270)', lang: 'xml' },
  proj: { label: 'PROJ', color: 'oklch(0.50 0.04 270)', lang: 'xml' },
  props: { label: 'PROP', color: 'oklch(0.52 0.04 250)', lang: 'xml' },
  targets: { label: 'TGT', color: 'oklch(0.52 0.04 230)', lang: 'xml' },
  nuspec: { label: 'NUS', color: 'oklch(0.52 0.05 250)', lang: 'xml' },
  resx: { label: 'RES', color: 'oklch(0.52 0.03 210)', lang: 'xml' },
  config: { label: 'CFG', color: 'oklch(0.50 0.025 270)', lang: 'xml' },
  fs: { label: 'FS', color: 'oklch(0.55 0.13 195)', lang: 'fsharp' },
  fsi: { label: 'FSI', color: 'oklch(0.55 0.13 195)', lang: 'fsharp' },
  fsx: { label: 'FSX', color: 'oklch(0.55 0.13 195)', lang: 'fsharp' },
  vb: { label: 'VB', color: 'oklch(0.50 0.12 270)', lang: 'vbnet' },
  xaml: { label: 'XAML', color: 'oklch(0.58 0.12 240)', lang: 'xml' },
  axaml: { label: 'XAML', color: 'oklch(0.58 0.12 240)', lang: 'xml' },
  razor: { label: 'RAZ', color: 'oklch(0.55 0.13 290)', lang: 'xml' },
  cshtml: { label: 'CSH', color: 'oklch(0.55 0.13 290)', lang: 'xml' },
  gradle: { label: 'GRDL', color: 'oklch(0.48 0.10 200)', lang: '' },
  // JS / TS
  js: { label: 'JS', color: 'oklch(0.63 0.14 85)', lang: 'javascript' },
  mjs: { label: 'JS', color: 'oklch(0.63 0.14 85)', lang: 'javascript' },
  cjs: { label: 'JS', color: 'oklch(0.63 0.14 85)', lang: 'javascript' },
  jsx: { label: 'JSX', color: 'oklch(0.60 0.12 215)', lang: 'javascript' },
  ts: { label: 'TS', color: 'oklch(0.52 0.13 255)', lang: 'typescript' },
  tsx: { label: 'TSX', color: 'oklch(0.60 0.12 215)', lang: 'typescript' },
  // scripting
  py: { label: 'PY', color: 'oklch(0.50 0.12 245)', lang: 'python' },
  pyw: { label: 'PY', color: 'oklch(0.50 0.12 245)', lang: 'python' },
  rb: { label: 'RB', color: 'oklch(0.50 0.18 25)', lang: 'ruby' },
  php: { label: 'PHP', color: 'oklch(0.55 0.09 285)', lang: 'php' },
  lua: { label: 'LUA', color: 'oklch(0.45 0.15 265)', lang: 'lua' },
  r: { label: 'R', color: 'oklch(0.55 0.12 250)', lang: 'r' },
  pl: { label: 'PL', color: 'oklch(0.50 0.10 250)', lang: 'perl' },
  ex: { label: 'EX', color: 'oklch(0.52 0.13 300)', lang: '' },
  exs: { label: 'EX', color: 'oklch(0.52 0.13 300)', lang: '' },
  // systems / compiled
  go: { label: 'GO', color: 'oklch(0.60 0.12 215)', lang: 'go' },
  rs: { label: 'RS', color: 'oklch(0.50 0.13 40)', lang: 'rust' },
  java: { label: 'JAVA', color: 'oklch(0.55 0.15 35)', lang: 'java' },
  kt: { label: 'KT', color: 'oklch(0.58 0.15 330)', lang: 'kotlin' },
  kts: { label: 'KT', color: 'oklch(0.58 0.15 330)', lang: 'kotlin' },
  swift: { label: 'SW', color: 'oklch(0.60 0.15 40)', lang: 'swift' },
  dart: { label: 'DART', color: 'oklch(0.55 0.12 210)', lang: '' },
  scala: { label: 'SC', color: 'oklch(0.48 0.16 15)', lang: '' },
  // Epic Verse (UE/UEFN) — `Foo.native.verse` also resolves here (ext is the last segment).
  // hljs id 'verse' is our own grammar registered in highlight.ts.
  verse: { label: 'VRS', color: 'oklch(0.62 0.15 200)', lang: 'verse' },
  // data / config
  json: { label: '{}', color: 'oklch(0.63 0.13 80)', lang: 'json' },
  jsonc: { label: '{}', color: 'oklch(0.63 0.13 80)', lang: 'json' },
  json5: { label: '{}', color: 'oklch(0.63 0.13 80)', lang: 'json' },
  yml: { label: 'YML', color: 'oklch(0.52 0.10 185)', lang: 'yaml' },
  yaml: { label: 'YML', color: 'oklch(0.52 0.10 185)', lang: 'yaml' },
  toml: { label: 'TOML', color: 'oklch(0.50 0.08 60)', lang: 'ini' },
  ini: { label: 'INI', color: 'oklch(0.50 0.05 250)', lang: 'ini' },
  cfg: { label: 'CFG', color: 'oklch(0.50 0.025 270)', lang: 'ini' },
  conf: { label: 'CONF', color: 'oklch(0.50 0.025 270)', lang: 'ini' },
  env: { label: 'ENV', color: 'oklch(0.62 0.12 90)', lang: '' },
  sql: { label: 'SQL', color: 'oklch(0.55 0.13 350)', lang: 'sql' },
  graphql: { label: 'GQL', color: 'oklch(0.58 0.18 345)', lang: '' },
  gql: { label: 'GQL', color: 'oklch(0.58 0.18 345)', lang: '' },
  proto: { label: 'PB', color: 'oklch(0.52 0.08 230)', lang: '' },
  // web
  css: { label: 'CSS', color: 'oklch(0.48 0.16 265)', lang: 'css' },
  scss: { label: 'SCSS', color: 'oklch(0.60 0.15 350)', lang: 'scss' },
  sass: { label: 'SASS', color: 'oklch(0.60 0.15 350)', lang: 'scss' },
  less: { label: 'LESS', color: 'oklch(0.45 0.12 270)', lang: 'less' },
  html: { label: '<>', color: 'oklch(0.58 0.16 40)', lang: 'xml' },
  htm: { label: '<>', color: 'oklch(0.58 0.16 40)', lang: 'xml' },
  xml: { label: 'XML', color: 'oklch(0.55 0.12 50)', lang: 'xml' },
  svg: { label: 'SVG', color: 'oklch(0.65 0.14 75)', lang: 'xml' },
  vue: { label: 'VUE', color: 'oklch(0.55 0.13 165)', lang: 'xml' },
  svelte: { label: 'SV', color: 'oklch(0.58 0.16 30)', lang: 'xml' },
  // shell
  sh: { label: 'SH', color: 'oklch(0.45 0.10 150)', lang: 'bash' },
  bash: { label: 'SH', color: 'oklch(0.45 0.10 150)', lang: 'bash' },
  zsh: { label: 'SH', color: 'oklch(0.45 0.10 150)', lang: 'bash' },
  ps1: { label: 'PS', color: 'oklch(0.45 0.10 250)', lang: '' },
  bat: { label: 'BAT', color: 'oklch(0.50 0.06 230)', lang: '' },
  // docs / misc
  md: { label: 'MD', color: 'oklch(0.46 0.08 255)', lang: 'markdown' },
  mdx: { label: 'MDX', color: 'oklch(0.50 0.10 280)', lang: 'markdown' },
  markdown: { label: 'MD', color: 'oklch(0.46 0.08 255)', lang: 'markdown' },
  txt: { label: 'TXT', color: 'oklch(0.55 0.02 270)', lang: 'plaintext' },
  log: { label: 'LOG', color: 'oklch(0.55 0.02 270)', lang: '' },
  csv: { label: 'CSV', color: 'oklch(0.52 0.12 155)', lang: '' },
  diff: { label: 'DIFF', color: 'oklch(0.50 0.08 150)', lang: 'diff' },
  patch: { label: 'DIFF', color: 'oklch(0.50 0.08 150)', lang: 'diff' },
  lock: { label: 'LCK', color: 'oklch(0.50 0.02 270)', lang: '' },
  // images render as an in-viewer preview; other binaries (pdf) show a notice
  png: { label: 'IMG', color: 'oklch(0.55 0.12 200)', lang: '' },
  jpg: { label: 'IMG', color: 'oklch(0.55 0.12 200)', lang: '' },
  jpeg: { label: 'IMG', color: 'oklch(0.55 0.12 200)', lang: '' },
  gif: { label: 'IMG', color: 'oklch(0.55 0.12 200)', lang: '' },
  webp: { label: 'IMG', color: 'oklch(0.55 0.12 200)', lang: '' },
  ico: { label: 'IMG', color: 'oklch(0.55 0.12 200)', lang: '' },
  pdf: { label: 'PDF', color: 'oklch(0.55 0.18 25)', lang: '' }
}

// a few well-known extensionless filenames
const NAMED: Record<string, FileType> = {
  dockerfile: { label: 'DKR', color: 'oklch(0.55 0.13 240)', lang: 'dockerfile' },
  makefile: { label: 'MK', color: 'oklch(0.48 0.06 100)', lang: 'makefile' },
  '.gitignore': { label: 'GIT', color: 'oklch(0.55 0.16 30)', lang: '' },
  '.gitattributes': { label: 'GIT', color: 'oklch(0.55 0.16 30)', lang: '' },
  '.dockerignore': { label: 'DKR', color: 'oklch(0.55 0.13 240)', lang: '' },
  '.editorconfig': { label: 'EC', color: 'oklch(0.50 0.03 270)', lang: 'ini' },
  '.npmrc': { label: 'NPM', color: 'oklch(0.52 0.17 25)', lang: 'ini' },
  license: { label: 'LIC', color: 'oklch(0.52 0.04 85)', lang: '' }
}

const GENERIC: FileType = { label: '', color: 'var(--text-4)', lang: '' }

// Deterministic color for an extension with no curated entry: a hue hashed from the
// text, in the same solid-chip lightness/chroma band as the curated set, so unfamiliar
// types still read as distinct badges instead of flat gray.
function hashColor(ext: string): string {
  let h = 0
  for (let i = 0; i < ext.length; i++) h = (Math.imul(h, 31) + ext.charCodeAt(i)) >>> 0
  return `oklch(0.55 0.13 ${h % 360})`
}

export function fileTypeFor(filePath: string): FileType {
  const name = (filePath.split(/[\\/]/).pop() || filePath).toLowerCase()
  const named = NAMED[name]
  if (named) return named
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1) : ''
  if (!ext) return GENERIC
  return EXT[ext] ?? { label: ext.slice(0, 4).toUpperCase(), color: hashColor(ext), lang: '' }
}

export function langForPath(filePath: string): string {
  return fileTypeFor(filePath).lang
}

// 언어별 코드 팔레트: C#/C++/F# 등 Rider 언어는 Rider(ReSharper) 스킴, 그 외는
// IntelliJ 플랫폼 스킴(IDEA·WebStorm·PyCharm 공통). hljs 언어 id와 마크다운 펜스
// 표기(cs, c++ …)를 모두 받아 컨테이너에 붙일 팔레트 클래스를 돌려준다.
// Verse rides the Rider (ReSharper) scheme alongside C#/C++ — the look that read best for it.
const RIDER_LANGS = new Set(['csharp', 'cs', 'c#', 'fsharp', 'fs', 'vbnet', 'vb', 'cpp', 'c++', 'cc', 'cxx', 'c', 'h', 'hpp', 'verse'])
// hljs의 내장 타입 분류가 언어마다 달라(C++은 hljs-type, C#은 hljs-built_in)
// Rider의 '내장 타입 = 키워드 파랑'을 재현하려면 언어 보조 클래스가 필요하다
const CS_LANGS = new Set(['csharp', 'cs', 'c#'])
const CPP_LANGS = new Set(['cpp', 'c++', 'cc', 'cxx', 'c', 'h', 'hpp'])
export function paletteClassFor(lang: string): string {
  const l = lang.toLowerCase()
  if (!RIDER_LANGS.has(l)) return ''
  if (CS_LANGS.has(l)) return ' pal-rider pal-cs'
  if (CPP_LANGS.has(l)) return ' pal-rider pal-cpp'
  if (l === 'verse') return ' pal-rider pal-verse'
  return ' pal-rider'
}

// A small rounded chip with the file-type monogram, tinted by the language color —
// the modern, recognizable-at-a-glance icon used wherever a file path is shown.
export function FileBadge({ path, size = 16, className }: { path: string; size?: number; className?: string }) {
  const t = fileTypeFor(path)
  if (!t.label) {
    return (
      <span className={'ftbadge generic' + (className ? ' ' + className : '')} style={{ width: size, height: size }}>
        <IconFile size={Math.round(size * 0.84)} />
      </span>
    )
  }
  // longer monograms (C++, JSX, JAVA…) shrink so they stay inside the chip
  const fontSize = size * (t.label.length >= 3 ? 0.34 : 0.46)
  // 다크 테마용 밝은 변형(L 0.78, 같은 채도·색상) — 어두운 배경에선 솔리드 칩이
  // 묻히므로 밝은 글자 + 은은한 동색 틴트로 그린다 (styles.css의 다크 분기 참고)
  const bright = t.color.replace(/oklch\(\s*[\d.]+/, 'oklch(0.78')
  const style = {
    ['--ft']: t.color,
    ['--ftb']: bright,
    width: size,
    height: size,
    fontSize: `${fontSize}px`
  } as CSSProperties
  return (
    <span className={'ftbadge' + (className ? ' ' + className : '')} style={style}>
      {t.label}
    </span>
  )
}
