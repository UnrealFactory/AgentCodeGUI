// A file's display identity: a Material Icon Theme glyph (modern SVG, replacing the
// old letter monogram), plus a fixed brand color and the highlight.js language id used
// to syntax-colour its contents in the viewer card. `label`/`color` are kept for tooltips
// and the various color accents around the app (change dots, pickers) that still read them.
export interface FileType {
  icon: string // Material Icon Theme name (→ src/assets/fileicons/<icon>.svg)
  label: string // 1-4 char monogram (legacy; kept for a11y/title + non-badge accents)
  color: string // brand tint — fixed oklch (NOT a theme token), used by row/dot accents
  lang: string // highlight.js language id ('' → let hljs auto-detect)
}

// Material Icon Theme SVGs, bundled & inlined as raw strings at build time → name → markup.
// Inlining (vs <img>) keeps it offline-proof and lets one set of CSS size every call site.
const ICON_RAW = import.meta.glob('../assets/fileicons/*.svg', {
  eager: true,
  query: '?raw',
  import: 'default'
}) as Record<string, string>
const ICON_SVG: Record<string, string> = {}
for (const [path, svg] of Object.entries(ICON_RAW)) {
  ICON_SVG[path.slice(path.lastIndexOf('/') + 1, -4)] = svg
}

// extension → identity. `icon` is the Material Icon Theme glyph; `.NET 프로젝트/솔루션
// (sln·csproj·props·targets·xaml…)`은 전용 아이콘이 없고 VS 로고는 의도(빌드 배관 가라앉히기)와
// 어긋나 중립적인 `xml`로 통일한다. `label`/`color`는 호환을 위해 남겨둔다.
const EXT: Record<string, FileType> = {
  // C-family / .NET
  cs: { icon: 'csharp', label: 'C#', color: 'oklch(0.51 0.17 305)', lang: 'csharp' },
  csx: { icon: 'csharp', label: 'C#', color: 'oklch(0.51 0.17 305)', lang: 'csharp' },
  cpp: { icon: 'cpp', label: 'C++', color: 'oklch(0.50 0.14 255)', lang: 'cpp' },
  cc: { icon: 'cpp', label: 'C++', color: 'oklch(0.50 0.14 255)', lang: 'cpp' },
  cxx: { icon: 'cpp', label: 'C++', color: 'oklch(0.50 0.14 255)', lang: 'cpp' },
  c: { icon: 'c', label: 'C', color: 'oklch(0.45 0.10 240)', lang: 'c' },
  hpp: { icon: 'h', label: 'H+', color: 'oklch(0.56 0.10 215)', lang: 'cpp' },
  hxx: { icon: 'h', label: 'H+', color: 'oklch(0.56 0.10 215)', lang: 'cpp' },
  hh: { icon: 'h', label: 'H+', color: 'oklch(0.56 0.10 215)', lang: 'cpp' },
  // .h는 하이라이트도 C++로 — 실무에선 거의 C++ 헤더고, C 문법엔 public/class 같은
  // 키워드가 없어 접근 지시자가 안 칠해진다 (LSP 쪽 exts 매핑과 동일한 선택)
  h: { icon: 'h', label: 'H', color: 'oklch(0.56 0.10 215)', lang: 'cpp' },
  m: { icon: 'objective-c', label: 'M', color: 'oklch(0.55 0.12 235)', lang: 'objectivec' },
  mm: { icon: 'objective-cpp', label: 'MM', color: 'oklch(0.55 0.12 235)', lang: 'objectivec' },
  // .NET / MSBuild (Rider · Visual Studio) — 프로젝트/솔루션/빌드 props는 중립 xml로 통일
  sln: { icon: 'xml', label: 'SLN', color: 'oklch(0.48 0.045 290)', lang: '' },
  slnx: { icon: 'xml', label: 'SLN', color: 'oklch(0.48 0.045 290)', lang: 'xml' },
  csproj: { icon: 'xml', label: 'PROJ', color: 'oklch(0.50 0.04 270)', lang: 'xml' },
  fsproj: { icon: 'xml', label: 'PROJ', color: 'oklch(0.50 0.04 270)', lang: 'xml' },
  vbproj: { icon: 'xml', label: 'PROJ', color: 'oklch(0.50 0.04 270)', lang: 'xml' },
  vcxproj: { icon: 'xml', label: 'PROJ', color: 'oklch(0.50 0.04 270)', lang: 'xml' },
  proj: { icon: 'xml', label: 'PROJ', color: 'oklch(0.50 0.04 270)', lang: 'xml' },
  props: { icon: 'xml', label: 'PROP', color: 'oklch(0.52 0.04 250)', lang: 'xml' },
  targets: { icon: 'xml', label: 'TGT', color: 'oklch(0.52 0.04 230)', lang: 'xml' },
  nuspec: { icon: 'nuget', label: 'NUS', color: 'oklch(0.52 0.05 250)', lang: 'xml' },
  resx: { icon: 'i18n', label: 'RES', color: 'oklch(0.52 0.03 210)', lang: 'xml' },
  config: { icon: 'settings', label: 'CFG', color: 'oklch(0.50 0.025 270)', lang: 'xml' },
  fs: { icon: 'fsharp', label: 'FS', color: 'oklch(0.55 0.13 195)', lang: 'fsharp' },
  fsi: { icon: 'fsharp', label: 'FSI', color: 'oklch(0.55 0.13 195)', lang: 'fsharp' },
  fsx: { icon: 'fsharp', label: 'FSX', color: 'oklch(0.55 0.13 195)', lang: 'fsharp' },
  vb: { icon: 'visualstudio', label: 'VB', color: 'oklch(0.50 0.12 270)', lang: 'vbnet' },
  xaml: { icon: 'xml', label: 'XAML', color: 'oklch(0.58 0.12 240)', lang: 'xml' },
  axaml: { icon: 'xml', label: 'XAML', color: 'oklch(0.58 0.12 240)', lang: 'xml' },
  razor: { icon: 'razor', label: 'RAZ', color: 'oklch(0.55 0.13 290)', lang: 'xml' },
  cshtml: { icon: 'razor', label: 'CSH', color: 'oklch(0.55 0.13 290)', lang: 'xml' },
  gradle: { icon: 'gradle', label: 'GRDL', color: 'oklch(0.48 0.10 200)', lang: '' },
  // JS / TS
  js: { icon: 'javascript', label: 'JS', color: 'oklch(0.63 0.14 85)', lang: 'javascript' },
  mjs: { icon: 'javascript', label: 'JS', color: 'oklch(0.63 0.14 85)', lang: 'javascript' },
  cjs: { icon: 'javascript', label: 'JS', color: 'oklch(0.63 0.14 85)', lang: 'javascript' },
  jsx: { icon: 'react', label: 'JSX', color: 'oklch(0.60 0.12 215)', lang: 'javascript' },
  ts: { icon: 'typescript', label: 'TS', color: 'oklch(0.52 0.13 255)', lang: 'typescript' },
  tsx: { icon: 'react_ts', label: 'TSX', color: 'oklch(0.60 0.12 215)', lang: 'typescript' },
  // scripting
  py: { icon: 'python', label: 'PY', color: 'oklch(0.50 0.12 245)', lang: 'python' },
  pyw: { icon: 'python', label: 'PY', color: 'oklch(0.50 0.12 245)', lang: 'python' },
  rb: { icon: 'ruby', label: 'RB', color: 'oklch(0.50 0.18 25)', lang: 'ruby' },
  php: { icon: 'php', label: 'PHP', color: 'oklch(0.55 0.09 285)', lang: 'php' },
  lua: { icon: 'lua', label: 'LUA', color: 'oklch(0.45 0.15 265)', lang: 'lua' },
  r: { icon: 'r', label: 'R', color: 'oklch(0.55 0.12 250)', lang: 'r' },
  pl: { icon: 'perl', label: 'PL', color: 'oklch(0.50 0.10 250)', lang: 'perl' },
  ex: { icon: 'elixir', label: 'EX', color: 'oklch(0.52 0.13 300)', lang: '' },
  exs: { icon: 'elixir', label: 'EX', color: 'oklch(0.52 0.13 300)', lang: '' },
  // systems / compiled
  go: { icon: 'go', label: 'GO', color: 'oklch(0.60 0.12 215)', lang: 'go' },
  rs: { icon: 'rust', label: 'RS', color: 'oklch(0.50 0.13 40)', lang: 'rust' },
  java: { icon: 'java', label: 'JAVA', color: 'oklch(0.55 0.15 35)', lang: 'java' },
  kt: { icon: 'kotlin', label: 'KT', color: 'oklch(0.58 0.15 330)', lang: 'kotlin' },
  kts: { icon: 'kotlin', label: 'KT', color: 'oklch(0.58 0.15 330)', lang: 'kotlin' },
  swift: { icon: 'swift', label: 'SW', color: 'oklch(0.60 0.15 40)', lang: 'swift' },
  dart: { icon: 'dart', label: 'DART', color: 'oklch(0.55 0.12 210)', lang: '' },
  scala: { icon: 'scala', label: 'SC', color: 'oklch(0.48 0.16 15)', lang: '' },
  // Epic Verse (UE/UEFN) — `Foo.native.verse` also resolves here (ext is the last segment).
  // hljs id 'verse' is our own grammar registered in highlight.ts.
  verse: { icon: 'verse', label: 'VRS', color: 'oklch(0.62 0.15 200)', lang: 'verse' },
  // Unreal Engine 파일 — 전부 모던 글리프(MDI)로 채색(공식 마크는 얇은 링이라 작은 크기에서
  // 깨져 제거). 에셋계열 indigo / 월드·실행계열 steel. uplugin/uproject는 실제 JSON이라 열림.
  uasset: { icon: 'uasset', label: 'UE', color: 'oklch(0.66 0.16 280)', lang: '' }, // 헥사 클러스터
  umap: { icon: 'umap', label: 'MAP', color: 'oklch(0.68 0.13 250)', lang: '' }, //   지구(레벨/월드)
  uplugin: { icon: 'uplugin', label: 'UPL', color: 'oklch(0.66 0.16 280)', lang: 'json' }, // 퍼즐(플러그인)
  uproject: { icon: 'uproject', label: 'UPRJ', color: 'oklch(0.68 0.13 250)', lang: 'json' }, // 로켓(프로젝트)
  // data / config
  json: { icon: 'json', label: '{}', color: 'oklch(0.63 0.13 80)', lang: 'json' },
  jsonc: { icon: 'json', label: '{}', color: 'oklch(0.63 0.13 80)', lang: 'json' },
  json5: { icon: 'json', label: '{}', color: 'oklch(0.63 0.13 80)', lang: 'json' },
  yml: { icon: 'yaml', label: 'YML', color: 'oklch(0.52 0.10 185)', lang: 'yaml' },
  yaml: { icon: 'yaml', label: 'YML', color: 'oklch(0.52 0.10 185)', lang: 'yaml' },
  toml: { icon: 'toml', label: 'TOML', color: 'oklch(0.50 0.08 60)', lang: 'ini' },
  ini: { icon: 'settings', label: 'INI', color: 'oklch(0.50 0.05 250)', lang: 'ini' },
  cfg: { icon: 'settings', label: 'CFG', color: 'oklch(0.50 0.025 270)', lang: 'ini' },
  conf: { icon: 'settings', label: 'CONF', color: 'oklch(0.50 0.025 270)', lang: 'ini' },
  env: { icon: 'tune', label: 'ENV', color: 'oklch(0.62 0.12 90)', lang: '' },
  sql: { icon: 'database', label: 'SQL', color: 'oklch(0.55 0.13 350)', lang: 'sql' },
  graphql: { icon: 'graphql', label: 'GQL', color: 'oklch(0.58 0.18 345)', lang: '' },
  gql: { icon: 'graphql', label: 'GQL', color: 'oklch(0.58 0.18 345)', lang: '' },
  proto: { icon: 'proto', label: 'PB', color: 'oklch(0.52 0.08 230)', lang: '' },
  // web
  css: { icon: 'css', label: 'CSS', color: 'oklch(0.48 0.16 265)', lang: 'css' },
  scss: { icon: 'sass', label: 'SCSS', color: 'oklch(0.60 0.15 350)', lang: 'scss' },
  sass: { icon: 'sass', label: 'SASS', color: 'oklch(0.60 0.15 350)', lang: 'scss' },
  less: { icon: 'less', label: 'LESS', color: 'oklch(0.45 0.12 270)', lang: 'less' },
  html: { icon: 'html', label: '<>', color: 'oklch(0.58 0.16 40)', lang: 'xml' },
  htm: { icon: 'html', label: '<>', color: 'oklch(0.58 0.16 40)', lang: 'xml' },
  xml: { icon: 'xml', label: 'XML', color: 'oklch(0.55 0.12 50)', lang: 'xml' },
  svg: { icon: 'svg', label: 'SVG', color: 'oklch(0.65 0.14 75)', lang: 'xml' },
  vue: { icon: 'vue', label: 'VUE', color: 'oklch(0.55 0.13 165)', lang: 'xml' },
  svelte: { icon: 'svelte', label: 'SV', color: 'oklch(0.58 0.16 30)', lang: 'xml' },
  // shell
  sh: { icon: 'console', label: 'SH', color: 'oklch(0.45 0.10 150)', lang: 'bash' },
  bash: { icon: 'console', label: 'SH', color: 'oklch(0.45 0.10 150)', lang: 'bash' },
  zsh: { icon: 'console', label: 'SH', color: 'oklch(0.45 0.10 150)', lang: 'bash' },
  ps1: { icon: 'powershell', label: 'PS', color: 'oklch(0.45 0.10 250)', lang: '' },
  bat: { icon: 'console', label: 'BAT', color: 'oklch(0.50 0.06 230)', lang: '' },
  // docs / misc
  md: { icon: 'markdown', label: 'MD', color: 'oklch(0.46 0.08 255)', lang: 'markdown' },
  mdx: { icon: 'mdx', label: 'MDX', color: 'oklch(0.50 0.10 280)', lang: 'markdown' },
  markdown: { icon: 'markdown', label: 'MD', color: 'oklch(0.46 0.08 255)', lang: 'markdown' },
  txt: { icon: 'document', label: 'TXT', color: 'oklch(0.55 0.02 270)', lang: 'plaintext' },
  log: { icon: 'log', label: 'LOG', color: 'oklch(0.55 0.02 270)', lang: '' },
  csv: { icon: 'table', label: 'CSV', color: 'oklch(0.52 0.12 155)', lang: '' },
  diff: { icon: 'diff', label: 'DIFF', color: 'oklch(0.50 0.08 150)', lang: 'diff' },
  patch: { icon: 'diff', label: 'DIFF', color: 'oklch(0.50 0.08 150)', lang: 'diff' },
  lock: { icon: 'lock', label: 'LCK', color: 'oklch(0.50 0.02 270)', lang: '' },
  // images render as an in-viewer preview; other binaries (pdf) show a notice
  png: { icon: 'image', label: 'IMG', color: 'oklch(0.55 0.12 200)', lang: '' },
  jpg: { icon: 'image', label: 'IMG', color: 'oklch(0.55 0.12 200)', lang: '' },
  jpeg: { icon: 'image', label: 'IMG', color: 'oklch(0.55 0.12 200)', lang: '' },
  gif: { icon: 'image', label: 'IMG', color: 'oklch(0.55 0.12 200)', lang: '' },
  webp: { icon: 'image', label: 'IMG', color: 'oklch(0.55 0.12 200)', lang: '' },
  ico: { icon: 'image', label: 'IMG', color: 'oklch(0.55 0.12 200)', lang: '' },
  pdf: { icon: 'pdf', label: 'PDF', color: 'oklch(0.55 0.18 25)', lang: '' }
}

// a few well-known extensionless filenames
const NAMED: Record<string, FileType> = {
  dockerfile: { icon: 'docker', label: 'DKR', color: 'oklch(0.55 0.13 240)', lang: 'dockerfile' },
  makefile: { icon: 'makefile', label: 'MK', color: 'oklch(0.48 0.06 100)', lang: 'makefile' },
  '.gitignore': { icon: 'git', label: 'GIT', color: 'oklch(0.55 0.16 30)', lang: '' },
  '.gitattributes': { icon: 'git', label: 'GIT', color: 'oklch(0.55 0.16 30)', lang: '' },
  '.dockerignore': { icon: 'docker', label: 'DKR', color: 'oklch(0.55 0.13 240)', lang: '' },
  '.editorconfig': { icon: 'editorconfig', label: 'EC', color: 'oklch(0.50 0.03 270)', lang: 'ini' },
  '.npmrc': { icon: 'npm', label: 'NPM', color: 'oklch(0.52 0.17 25)', lang: 'ini' },
  license: { icon: 'certificate', label: 'LIC', color: 'oklch(0.52 0.04 85)', lang: '' }
}

// generic/unknown → the neutral document glyph
const GENERIC: FileType = { icon: 'document', label: '', color: 'var(--text-4)', lang: '' }

// Deterministic color for an extension with no curated entry: a hue hashed from the
// text, in the same solid-chip lightness/chroma band as the curated set, so the few
// color accents that still read `.color` stay distinct for unfamiliar types.
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
  return EXT[ext] ?? { icon: 'document', label: ext.slice(0, 4).toUpperCase(), color: hashColor(ext), lang: '' }
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

// The modern, recognizable-at-a-glance file icon (Material Icon Theme SVG) used wherever
// a file path is shown. Sized by the caller; the bundled SVG scales to fill.
export function FileBadge({ path, size = 16, className }: { path: string; size?: number; className?: string }) {
  const t = fileTypeFor(path)
  const svg = ICON_SVG[t.icon] ?? ICON_SVG.document
  return (
    <span
      className={'fticon' + (className ? ' ' + className : '')}
      style={{ width: size, height: size }}
      title={t.label || undefined}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
