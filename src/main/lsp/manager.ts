import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { StdioRpc } from './jsonrpc'
import { DOWNLOADS, install, installState, installedBin, uninstall, killHolders } from './install'
import { ensureUeClangDb, ueDbDir, ueRoot } from './ue'
import {
  verseExePath,
  verseSourcePath,
  verseProjectRoot,
  verseWorkspaceFolders,
  verseWorkspaceMtime,
  verseDeclHover,
  verseLocalHover,
  verseDocAt,
  verseKeywordDoc,
  verseSymbolDoc,
  setVerseExe,
  clearVerseExe
} from './verse'
import {
  verseMemberContext,
  verseHasType,
  verseTypeFromHover,
  verseResolveTypeRegex,
  verseTypeMembers,
  verseScopeCompletions,
  verseExtMethods,
  verseIsTypePosition,
  verseBuiltinTypeItems,
  verseRegistry as verseMemberDbRegistry
} from './verseMemberDb'
import { getCached, setCached, gcDeadBuckets } from './semcache'
import { APP_HOME } from '../engine/versions'
import { VERSE_BUILTIN_KIND } from '@shared/protocol'
import type {
  LspCompletionItem,
  LspCompletionList,
  VerseRegistry,
  LspHoverResult,
  LspInstallProgress,
  LspLocation,
  LspPos,
  LspProjectStatus,
  LspSemanticTokens,
  LspServerInfo,
  LspStatus
} from '@shared/protocol'

/* ============================================================
 * LSP manager — lazy, per-project language servers powering the
 * in-app viewer's code intelligence (hover types + go-to-definition).
 *
 * The "index" lives inside the server process; we only ask
 * questions over JSON-RPC. Two provisioning kinds:
 *  - bundled: pure-JS servers shipped in node_modules, run on
 *    Electron's own Node (TypeScript, Python/pyright)
 *  - download: native binaries fetched on demand into the app
 *    home (C#/OmniSharp, C++/clangd) — see install.ts
 * ============================================================ */

interface SpawnPlan {
  cmd: string
  args: string[]
  env?: Record<string, string>
}

interface ServerDef {
  id: string
  label: string
  langs: string // display name of the covered languages (settings list)
  // bundled = ships in node_modules · download = fetched on demand (install.ts) ·
  // external = a user-supplied binary we can't ship/download (Verse: Epic's verse-lsp.exe)
  kind: 'bundled' | 'download' | 'external'
  exts: Record<string, string> // extension → LSP languageId
  requires?: string // external prerequisite, shown in settings (e.g. .NET SDK)
  /** how to launch the server for a given project root, or null when its
   *  binary/module is missing. `root` lets clangd point at the project's
   *  out-of-tree compile DB; bundled servers ignore it. */
  command(root: string): SpawnPlan | null
  /** workspace folders to send at `initialize`, or null to use the default (the single
   *  project root). Verse returns the source package + API digest folders parsed from the
   *  project's .vproject so the server can resolve cross-package symbols. */
  workspaceFoldersFor?(root: string): { uri: string; name: string }[] | null
  initializationOptions?(): unknown
  /** post-initialize hook — Roslyn doesn't auto-discover .sln/.csproj, so we tell it
   *  which projects to open here (after `initialized`). Other servers don't need it. */
  afterInitialized?(rpc: StdioRpc, root: string): void
  /** true when the server keeps loading after `initialize` and signals readiness with
   *  a `workspace/projectInitializationComplete` notification (Roslyn). We hold the
   *  status at 'starting' until then so the viewer only asks for tokens once the index
   *  is complete — otherwise it captures early/partial tokens and never refreshes. */
  awaitsProjectInit?: boolean
  /** 파일별 서버 루트 — 기본은 열린 프로젝트(cwd). C#은 가장 가까운 .csproj 폴더로
   *  좁힌다: UE 같은 모노레포 루트의 무관한 sln(엔진 자동화 프로젝트 수십 개)을
   *  물면 정작 보는 파일이 어느 프로젝트에도 속하지 않아 토큰이 안 나온다 */
  rootFor?(abs: string, cwd: string): string
}

// 소스 없는 .NET 어셈블리 심볼(F12 → BCL 타입 등)의 디컴파일 소스를 떨궈 두는 곳.
// 이 안의 파일은 읽기 전용 뷰 — LSP를 붙여봐야 misc 문서라 status에서 제외한다.
const METADATA_DIR = path.join(APP_HOME, 'metadata')

// Roslyn LSP가 쓰는 로그 폴더 (서버가 직접 기록) — 앱 홈 아래로 모은다
const ROSLYN_LOG = path.join(APP_HOME, 'lsp', 'roslyn-log')

/** OmniSharp의 $metadata$ 가짜 경로 → o#/metadata 요청 파라미터.
 *  '$metadata$/Project/<P>/Assembly/<A>/Symbol/<T>.cs' 꼴이고 이름의 '.'이
 *  경로 구분자로 풀려 있다(System.Runtime → System/Runtime). */
function parseMetadataPath(p: string): { ProjectName: string; AssemblyName: string; TypeName: string } | null {
  const m = /\$metadata\$[/\\]Project[/\\](.+)[/\\]Assembly[/\\](.+)[/\\]Symbol[/\\](.+)\.cs$/.exec(p)
  if (!m) return null
  const undot = (s: string): string => s.replace(/[/\\]/g, '.')
  return { ProjectName: undot(m[1]), AssemblyName: undot(m[2]), TypeName: undot(m[3]) }
}

/** 파일에서 위로 올라가며 .csproj가 있는 첫 폴더 — cwd 경계(또는 16단계)까지. */
function nearestCsProjectRoot(absFile: string, cwd: string): string | null {
  const stop = cwd ? path.resolve(cwd).toLowerCase() : ''
  let dir = path.dirname(path.resolve(absFile))
  for (let i = 0; i < 16; i++) {
    let names: string[] = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      /* unreadable — keep walking */
    }
    if (names.some((n) => n.toLowerCase().endsWith('.csproj'))) return dir
    if (dir.toLowerCase() === stop) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** .csproj file URIs directly in `root` — Roslyn's project/open payload. */
function csprojUris(root: string): string[] {
  try {
    return fs
      .readdirSync(root)
      .filter((n) => n.toLowerCase().endsWith('.csproj'))
      .map((n) => pathToFileURL(path.join(root, n)).href)
  } catch {
    return []
  }
}

/** solution file URI directly in `root`, or null — preferred over csproj (whole solution).
 *  .slnx(신형 XML)와 .sln 둘 다 인식하고, 둘 다 있으면 신형 .slnx를 고른다. */
function slnUri(root: string): string | null {
  try {
    const names = fs.readdirSync(root)
    const n = names.find((x) => x.toLowerCase().endsWith('.slnx')) ?? names.find((x) => x.toLowerCase().endsWith('.sln'))
    return n ? pathToFileURL(path.join(root, n)).href : null
  } catch {
    return null
  }
}

// keep a server's working set bounded — beyond this, the least recently
// opened document is closed so server memory doesn't grow with every file viewed
const MAX_OPEN_DOCS = 32
// a crashed/failed server isn't respawned until this much time has passed,
// so a broken install can't spawn-loop
const RESPAWN_COOLDOWN = 30_000
// verse only: minimum gap between checks of the workspace's digest/.vproject mtimes (a restart
// trigger after a UEFN Verse rebuild) — without it we'd stat the digests on every hover
const VERSE_WS_RECHECK = 4_000

interface DocState {
  version: number
  mtimeMs: number
  size: number
}

interface ServerHandle {
  rpc: StdioRpc
  child: ChildProcess
  status: 'starting' | 'ready' | 'error'
  ready: Promise<void>
  docs: Map<string, DocState> // uri → sync state (insertion order = open order)
  diedAt: number
  // verse only: when this server spawned (Date.now), and when we last checked the workspace's
  // digest/.vproject mtimes against it. UEFN regenerates those on every Verse build; once they
  // climb past startedAt the server's index is stale and ensure() restarts it (throttled by
  // wsCheckedAt). Set for every server but only consulted for verse.
  startedAt: number
  wsCheckedAt: number
  // Roslyn: true between initialize and projectInitializationComplete — status reports
  // 'starting' while true so the viewer waits for the full index before asking tokens
  projectInitPending: boolean
  // latest $/progress percentage during indexing (Roslyn 'Loading'…), null when none —
  // feeds the explorer's "분석 중 N%" badge
  progressPct: number | null
  // the server's semanticTokens legend (token type names + modifier names) from the
  // initialize result — null when the server doesn't do semantic highlighting
  semLegend: { types: string[]; mods: string[] } | null
  // the server's completion trigger characters (e.g. Verse '.') from the initialize
  // result's completionProvider — [] when it completes but lists no triggers, null when
  // the server has no completion provider at all (so we skip the request entirely)
  complTriggers: string[] | null
  // id of the most recent in-flight textDocument/completion (interactive-while-typing). A
  // newer keystroke cancels it via $/cancelRequest so the server isn't stuck re-parsing the
  // full document for a popup the user has already typed past. undefined when none in flight.
  lastComplId?: number
}

// Resolve a file that ships in the app's node_modules. In a packaged build the
// LSP server runs as a plain Node child process and must read real files, so
// node_modules is asarUnpack'ed and we prefer the .unpacked mirror; in dev this
// is just the project's node_modules.
function shippedModule(...rel: string[]): string | null {
  const appPath = app.getAppPath()
  const bases = [appPath.replace(/app\.asar$/, 'app.asar.unpacked'), appPath]
  for (const base of bases) {
    const p = path.join(base, 'node_modules', ...rel)
    try {
      if (fs.existsSync(p)) return p
    } catch {
      /* keep looking */
    }
  }
  return null
}

// run a pure-JS server on Electron's own Node — users don't need Node installed
function nodeServer(script: string | null, ...args: string[]): SpawnPlan | null {
  if (!script) return null
  return { cmd: process.execPath, args: [script, ...args], env: { ELECTRON_RUN_AS_NODE: '1' } }
}

// kill a server *and its children* — on Windows, child.kill() leaves grandchildren
// (e.g. OmniSharp's MSBuild worker nodes) alive and holding file locks
function killTree(child: ChildProcess): void {
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      child.kill()
    }
  } catch {
    /* already gone */
  }
}

// verse-lsp's hover for a type *reference* is the bare `(/path:)name<specs>` with no kind
// keyword, so the renderer's parseVerseSig labels it the generic 'Type'. Once definition tells
// us the real kind, prepend it to the fenced signature so the card reads 'Class'/'Struct'/… and
// shows e.g. `class component<…>`. No-op if the sig already starts with a declaration keyword.
function injectVerseKind(md: string, kind: string): string {
  return md.replace(/^```verse\n([^\n]*)/, (full, line: string) =>
    /^\s*(?:class|struct|enum|interface|module)\b/.test(line) ? full : '```verse\n' + kind + ' ' + line
  )
}

// The type from a verse-lsp hover signature (```verse\n(/qual:)name<specs>:type\n```) — fills the
// Type row of a synthesized local/parameter card (verse-lsp gives a `:type` at use sites). '' when
// there's no `:type` part.
function verseHoverType(md: string | null): string {
  const m = /```verse\n([^\n]*)/.exec(md ?? '')
  if (!m) return ''
  let s = m[1].trim()
  s = s.replace(/^(?:var|set)\s+/, '') // strip leading var/set
  s = s.replace(/^\(\/[^()]*?:\)\s*/, '') // strip (/Module/Path:)
  s = s.replace(/^[A-Za-z_]\w*(?:<[^>]*>)*\s*/, '') // strip name + <specs>
  const t = /^:\s*(.+)$/.exec(s)
  return t ? t[1].trim() : ''
}

const SERVERS: ServerDef[] = [
  {
    id: 'ts',
    label: 'TypeScript',
    langs: 'TypeScript · JavaScript',
    kind: 'bundled',
    exts: {
      ts: 'typescript',
      mts: 'typescript',
      cts: 'typescript',
      tsx: 'typescriptreact',
      js: 'javascript',
      mjs: 'javascript',
      cjs: 'javascript',
      jsx: 'javascriptreact'
    },
    command: () => nodeServer(shippedModule('typescript-language-server', 'lib', 'cli.mjs'), '--stdio'),
    initializationOptions: () => {
      // pin the bundled tsserver so resolution never depends on the opened project
      const tsserver = shippedModule('typescript', 'lib', 'tsserver.js')
      return tsserver ? { tsserver: { path: tsserver } } : undefined
    }
  },
  {
    id: 'py',
    label: 'Python',
    langs: 'Python',
    kind: 'bundled',
    exts: { py: 'python', pyw: 'python', pyi: 'python' },
    command: () => nodeServer(shippedModule('pyright', 'langserver.index.js'), '--stdio')
  },
  {
    id: 'cs',
    label: 'C#',
    langs: 'C#',
    kind: 'download',
    requires: '.NET SDK 10+ 필요',
    exts: { cs: 'csharp', csx: 'csharp' },
    // Roslyn LSP: self-contained apphost launched over stdio. Needs the .NET 10 runtime
    // (+ SDK for MSBuild project loads) — a given on modern C# dev machines.
    command: () => {
      const exe = installedBin('cs')
      return exe ? { cmd: exe, args: ['--stdio', '--logLevel=Information', `--extensionLogDirectory=${ROSLYN_LOG}`] } : null
    },
    rootFor: (abs, cwd) => nearestCsProjectRoot(abs, cwd) ?? cwd,
    // initialize 후에도 솔루션 인덱싱이 한참 걸린다 — projectInitializationComplete
    // 전까지 status를 'starting'으로 잡아 뷰어가 완성된 토큰만 받게 한다
    awaitsProjectInit: true,
    // Roslyn은 솔루션/프로젝트를 스스로 찾지 않는다 — 루트에 .sln/.slnx가 있으면 솔루션째
    // (solution/open), 없으면 그 폴더의 .csproj들을(project/open) 열어 줘야 인덱싱이
    // 시작된다. 로드가 끝나면 workspace/projectInitializationComplete가 오고, 그 전엔
    // 빈 토큰이 올 수 있어 렌더러의 semanticTokens 재시도(폴링)가 이를 메운다.
    afterInitialized: (rpc, root) => {
      const sln = slnUri(root)
      if (sln) {
        rpc.notify('solution/open', { solution: sln })
        return
      }
      const projects = csprojUris(root)
      if (projects.length) rpc.notify('project/open', { projects })
    }
  },
  {
    id: 'cpp',
    label: 'C/C++',
    langs: 'C · C++',
    kind: 'download',
    // .h defaults to C++ — the common case in the wild (and clangd mostly
    // decides from compile flags / content anyway)
    exts: { c: 'c', h: 'cpp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp', hh: 'cpp' },
    command: (root) => {
      const bin = installedBin('cpp')
      if (!bin) return null
      const args = ['--background-index']
      // UE 프로젝트는 compile_commands.json을 앱 홈(ueDbDir)에 만들어 둔다 — 거기에
      // 있으면 clangd가 그 폴더를 보게 한다. 그러면 clangd의 디스크 인덱스(.cache/clangd)도
      // 이 폴더 기준으로 쌓여 사용자의 언리얼 폴더가 깨끗하게 유지된다. (DB가 없는 일반
      // C++ 프로젝트는 플래그 없이 — clangd가 소스 트리에서 알아서 찾는다)
      // root가 하위폴더라도 ueRoot로 .uproject 조상을 찾아 같은 ue-db를 가리킨다.
      const ur = root ? ueRoot(root) : null
      if (ur && fs.existsSync(path.join(ueDbDir(ur), 'compile_commands.json'))) {
        args.push(`--compile-commands-dir=${ueDbDir(ur)}`)
      }
      return { cmd: bin, args }
    }
  },
  {
    id: 'verse',
    label: 'Verse',
    langs: 'Verse',
    kind: 'external',
    exts: { verse: 'verse', versetest: 'verse', vson: 'verse' },
    // Epic's verse-lsp.exe — only runnable once the user points us at their Verse.vsix /
    // verse-lsp.exe (prepared into the app home). Null = color-only (highlight.js grammar).
    // No special args, plain stdio — exactly how the VS Code Verse extension launches it.
    command: () => {
      const exe = verseExePath()
      return exe ? { cmd: exe, args: [] } : null
    },
    // key the server by the UE project root (.uproject ancestor), not the deep source folder
    rootFor: (abs, cwd) => verseProjectRoot(abs) ?? cwd,
    // the server needs the source + Verse/UnrealEngine digest folders, discovered from the
    // generated .vproject — without them every request times out (it can't resolve types)
    workspaceFoldersFor: (root) => verseWorkspaceFolders(root)
  }
]

function serverDefFor(absPath: string): ServerDef | null {
  const ext = path.extname(absPath).slice(1).toLowerCase()
  if (!ext) return null
  return SERVERS.find((s) => ext in s.exts) ?? null
}

// hover `contents` arrives as string | MarkedString | MarkupContent | arrays of
// those — flatten everything into one markdown string for the renderer
function hoverMarkdown(contents: unknown): string {
  const one = (c: unknown): string => {
    if (typeof c === 'string') return c
    if (c && typeof c === 'object') {
      const o = c as { language?: string; value?: string }
      if (typeof o.value !== 'string') return ''
      if (o.language) return '```' + o.language + '\n' + o.value + '\n```'
      return o.value
    }
    return ''
  }
  const parts = Array.isArray(contents) ? contents.map(one) : [one(contents)]
  return parts.filter(Boolean).join('\n\n').trim()
}

interface RawRange {
  start?: { line?: number; character?: number }
}
interface RawLocation {
  uri?: string
  targetUri?: string
  range?: RawRange
  targetSelectionRange?: RawRange
  targetRange?: RawRange
}

interface RawCompletionItem {
  label?: string
  kind?: number
  detail?: string
  documentation?: string | { kind?: string; value?: string }
  insertText?: string
  insertTextFormat?: number // 2 = snippet (LSP `${1:..}` placeholders)
  textEdit?: { newText?: string }
  sortText?: string
  filterText?: string
}
// textDocument/completion returns either a bare item array or a CompletionList wrapper
type RawCompletion = RawCompletionItem[] | { items?: RawCompletionItem[]; isIncomplete?: boolean } | null

/** Normalize a server completion response into our flat list (null when there's nothing usable). */
function mapCompletion(r: RawCompletion): LspCompletionList | null {
  if (!r) return null
  const rawItems = Array.isArray(r) ? r : Array.isArray(r.items) ? r.items : []
  const isIncomplete = Array.isArray(r) ? false : !!r.isIncomplete
  const items: LspCompletionItem[] = []
  for (const it of rawItems) {
    if (!it || typeof it.label !== 'string') continue
    const doc = typeof it.documentation === 'string' ? it.documentation : it.documentation?.value
    items.push({
      label: it.label,
      kind: typeof it.kind === 'number' ? it.kind : undefined,
      detail: typeof it.detail === 'string' ? it.detail : undefined,
      documentation: doc || undefined,
      insertText: it.textEdit?.newText ?? it.insertText ?? it.label,
      snippet: it.insertTextFormat === 2,
      sortText: it.sortText,
      filterText: it.filterText
    })
  }
  return items.length ? { items, isIncomplete } : null
}

/**
 * Merge scan-based scope candidates OVER a raw verse-lsp list: our items first (so their kinds win —
 * a user function reads as a function, not a generic variable), then any server item whose name we
 * don't already carry. Keeps the list `isIncomplete` when the server returned nothing (likely a cold
 * compile) so the renderer re-queries as the user types, instead of locally filtering our scan forever.
 *
 * Strips two kinds of noise verse-lsp dumps into the bare-identifier scope:
 *  • receiver-required extension methods like `(arr:[]t).RemoveElement(…)` — by NAME (`extMethods`,
 *    scanned from the digests) plus any LSP kind=Method. Only callable as `receiver.method(…)`.
 *  • operator definitions like `ref int += int` / `operator'+'…` — by shape: a real bare candidate's
 *    label is `Name`, `Name(…)`, `Name[…]`, `Name<…>`, `Name:type`, or the archetype `Name {…}`;
 *    an operator's `identifier + space + symbol` (or no leading identifier) fails BARE_IDENT.
 * The enclosing class's OWN methods stay — they come from the scope scan (added first), not from here.
 */
const LSP_KIND_METHOD = 2
const LSP_KIND_KEYWORD = 14
const BARE_IDENT = /^[A-Za-z_]\w*(?:$|[([{<:]|\s+\{)/
// LSP CompletionItemKinds that are TYPES — Class, Interface, Enum, Struct, TypeParameter
const TYPE_KINDS = new Set([7, 8, 13, 22, 25])

/**
 * Type-position completion: the caret is in a `: Type` slot (parameter/return/field type), so offer
 * TYPES ONLY — built-ins + our scope's type entries + verse-lsp items that are types (by kind, or
 * confirmed by our registry when verse-lsp mis-tags them). Drops every variable/function/field so the
 * user isn't offered their locals where only a type makes sense.
 */
function mergeVerseTypes(typeScope: LspCompletionItem[], raw: RawCompletion, reg: VerseRegistry): LspCompletionList | null {
  const lsp = mapCompletion(raw)
  const nameOf = (l: string): string => l.split(/[([{<]/)[0].trim()
  const seen = new Set(typeScope.map((i) => nameOf(i.label)))
  const items = [...typeScope]
  if (lsp)
    for (const it of lsp.items) {
      if (!BARE_IDENT.test(it.label)) continue
      const n = nameOf(it.label)
      if (seen.has(n)) continue
      if (!TYPE_KINDS.has(it.kind ?? -1) && !reg.kind[n]) continue // keep only types
      seen.add(n)
      items.push(it)
    }
  if (!items.length) return null
  return { items, isIncomplete: lsp ? lsp.isIncomplete : true }
}

function mergeVerseScope(scope: LspCompletionItem[], raw: RawCompletion, extMethods: Set<string>): LspCompletionList | null {
  const lsp = mapCompletion(raw)
  const nameOf = (l: string): string => l.split(/[([{]/)[0].trim()
  const seen = new Set(scope.map((i) => nameOf(i.label)))
  const items = [...scope]
  if (lsp)
    for (const it of lsp.items) {
      if (!BARE_IDENT.test(it.label)) continue // operator / non-identifier dump → not a bare candidate
      const n = nameOf(it.label)
      if (it.kind === LSP_KIND_METHOD || extMethods.has(n)) continue // needs a receiver → not a bare candidate
      if (seen.has(n)) continue
      // verse-lsp tags language built-ins/reserved (int/float/char/true/false/…) as Keyword(14);
      // surface them with the `#` "official built-in" icon instead of the generic keyword key.
      if (it.kind === LSP_KIND_KEYWORD) it.kind = VERSE_BUILTIN_KIND
      seen.add(n)
      items.push(it)
    }
  if (!items.length) return null
  return { items, isIncomplete: lsp ? lsp.isIncomplete : true }
}

/** The character immediately left of an LSP position in `text` — for trigger-char detection. */
function charBefore(text: string, pos: LspPos): string {
  const lines = text.split('\n')
  const line = lines[pos.line]
  if (line == null || pos.character <= 0) return ''
  return line.charAt(pos.character - 1)
}

/** Flatten a raw LSP hover result's `contents` (string | {value} | array) to a plain string. */
function hoverContentString(h: { contents?: unknown } | null): string {
  const c = h?.contents
  if (!c) return ''
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : ((x as { value?: string })?.value ?? ''))).join('\n')
  return (c as { value?: string }).value ?? ''
}

class LspManager {
  private servers = new Map<string, ServerHandle>()

  /**
   * Code-intelligence status for a file — and the lazy kick-off: asking for the
   * status spawns the project's server / warms the document in the background.
   * The renderer polls this while 'starting'/'installing' and turns the features
   * on at 'ready'. Downloadable servers report 'need-install' until the user
   * explicitly installs them.
   */
  status(cwd: string, relPath: string): LspStatus {
    const abs = this.resolve(cwd, relPath)
    const def = abs ? serverDefFor(abs) : null
    if (!abs || !def) return 'unsupported'
    // 디컴파일 메타데이터 뷰 — 어느 프로젝트에도 속하지 않으니 LSP를 붙이지 않는다
    if (abs.toLowerCase().startsWith(METADATA_DIR.toLowerCase())) return 'unsupported'
    if (def.kind === 'download') {
      const st = installState(def.id)
      if (st === 'installing') return 'installing'
      if (st === 'none') return 'need-install'
    }
    // external (Verse): no binary configured yet → behave like an unsupported file
    // (highlight.js colouring stays; no LSP features). Configured → fall through to spawn.
    if (def.kind === 'external' && !def.command('')) return 'unsupported'
    // UE 프로젝트면 clangd용 compile_commands.json을 백그라운드로 생성/갱신 —
    // 이미 떠 있던 clangd는 'DB 없음'을 캐시하므로 생성됐을 때 재시작해 준다
    if (def.id === 'cpp') this.maybeUeDb(cwd)
    const s = this.ensure(def, def.rootFor?.(abs, cwd) ?? cwd)
    if (!s) return 'error'
    if (s.status !== 'error') {
      // awaitsProjectInit 서버(Roslyn): 프로젝트 로드가 끝나기 전에 문서를 열면 misc
      // (임시) 워크스페이스에 묶여 심볼이 안 풀린다 — hover가 null이고 토큰도 degrade된다.
      // projectInitializationComplete 이후에 열어야 로드된 프로젝트에 제대로 붙는다.
      void s.ready
        .then(() => {
          if (!s.projectInitPending) void this.openDoc(s, def, abs)
        })
        .catch(() => {})
    }
    // Roslyn: initialize returns early but the index isn't ready until
    // projectInitializationComplete — keep reporting 'starting' so the viewer doesn't
    // grab partial tokens (which would then need a reopen to refresh).
    if (s.status === 'ready' && s.projectInitPending) return 'starting'
    return s.status
  }

  /**
   * Aggregate analysis state for a whole project (the explorer's folder badge): how every
   * language server rooted at/under `cwd` is doing. 'analyzing' while any is still
   * starting/indexing, 'ready' once all are done, 'idle' when none is running. `percent`
   * is the latest indexing % during 'analyzing' (null when the server doesn't report one).
   */
  projectStatus(cwd: string): LspProjectStatus {
    if (!cwd) return { state: 'idle', percent: null }
    const root = path.resolve(cwd).toLowerCase()
    const prefix = root + path.sep
    let analyzing = false
    let ready = false
    let percent: number | null = null
    for (const [key, s] of this.servers) {
      const sroot = key.slice(key.indexOf('|') + 1) // key = `${id}|${resolved lowercased root}`
      if (sroot !== root && !sroot.startsWith(prefix)) continue
      if (s.status === 'error') continue
      if (s.status === 'starting' || s.projectInitPending) {
        analyzing = true
        if (s.progressPct != null) percent = s.progressPct
      } else if (s.status === 'ready') ready = true
    }
    if (analyzing) return { state: 'analyzing', percent }
    if (ready) return { state: 'ready', percent: null }
    return { state: 'idle', percent: null }
  }

  /**
   * The Verse API digest folders to surface in the explorer — mirrors UEFN's VS Code view.
   * Returns the grouped folders ({ path, name }: name like `/Verse.org` over an absolute path).
   *
   * Source of truth, in order: (1) the `*.code-workspace` UEFN writes in the project root —
   * it lists exactly these folders, with the real (often global %LOCALAPPDATA%) digest paths;
   * (2) falling back to reconstructing from a local `.vproject`. The cwd itself is dropped
   * (already the main root) and non-existent dirs are skipped. Empty when neither exists, so
   * non-Verse folders show nothing extra.
   */
  verseDigestFolders(cwd: string): { path: string; name: string }[] {
    if (!cwd) return []
    const folders = this.codeWorkspaceFolders(cwd) ?? this.vprojectFolders(cwd)
    if (!folders) return []
    const self = path.resolve(cwd).toLowerCase()
    const out: { path: string; name: string }[] = []
    for (const f of folders) {
      let abs: string
      try {
        abs = path.resolve(cwd, f.path)
        if (abs.toLowerCase() === self) continue // already the main root
        if (!fs.existsSync(abs)) continue
      } catch {
        continue
      }
      out.push({ path: abs, name: f.name })
    }
    return out
  }

  // Parse the UEFN-generated `*.code-workspace` in the project root → its folder list. This is
  // the same file VS Code opens, so paths/names match UEFN exactly (incl. the global digest
  // dirs). Relative folder paths resolve against the workspace dir. null = no such file.
  private codeWorkspaceFolders(cwd: string): { path: string; name: string }[] | null {
    let files: string[]
    try {
      files = fs.readdirSync(cwd).filter((n) => n.toLowerCase().endsWith('.code-workspace'))
    } catch {
      return null
    }
    for (const n of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(cwd, n), 'utf8')) as {
          folders?: { name?: string; path?: string }[]
        }
        const folders = (j.folders ?? [])
          .filter((f): f is { name?: string; path: string } => !!f.path)
          .map((f) => ({ path: f.path, name: f.name || path.basename(f.path) }))
        if (folders.length) return folders
      } catch {
        // malformed workspace file — try the next one
      }
    }
    return null
  }

  /**
   * files.exclude globs for the explorer's "Verse 위주로 보기" filter. Mirrors what UEFN's own
   * VS Code workspace hides (*.uasset/*.umap/__ExternalActors__/Collections/…), so the tree
   * reads like UEFN's Verse Explorer. Starts from a sensible UEFN default set, then unions the
   * project's own `.code-workspace` files.exclude. Returns [] when this isn't a Verse project
   * (no .code-workspace and no .vproject) — the filter toggle then never appears.
   */
  verseFileExcludes(cwd: string): string[] {
    if (!cwd) return []
    if (!this.codeWorkspaceFolders(cwd) && !verseWorkspaceFolders(cwd)) return []
    const set = new Set<string>([
      '**/*.uasset',
      '**/*.umap',
      '**/*.png',
      '**/*.jpg',
      '**/*.tga',
      '**/*.vproject',
      '_INT',
      '__ExternalActors__',
      '__ExternalObjects__',
      'Collections',
      'Developers'
    ])
    for (const k of this.codeWorkspaceExcludes(cwd)) set.add(k)
    return [...set]
  }

  // The true-valued keys of `settings["files.exclude"]` in the project root's *.code-workspace.
  private codeWorkspaceExcludes(cwd: string): string[] {
    let files: string[]
    try {
      files = fs.readdirSync(cwd).filter((n) => n.toLowerCase().endsWith('.code-workspace'))
    } catch {
      return []
    }
    for (const n of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(cwd, n), 'utf8')) as {
          settings?: { 'files.exclude'?: Record<string, boolean> }
        }
        const ex = j.settings?.['files.exclude']
        if (ex) {
          return Object.entries(ex)
            .filter(([, v]) => v)
            .map(([k]) => k)
        }
      } catch {
        // malformed workspace file — try the next one
      }
    }
    return []
  }

  // Fallback: reconstruct the folder list from a `.vproject` (when no .code-workspace exists).
  private vprojectFolders(cwd: string): { path: string; name: string }[] | null {
    const folders = verseWorkspaceFolders(cwd)
    if (!folders) return null
    const out: { path: string; name: string }[] = []
    for (const f of folders) {
      try {
        out.push({ path: fileURLToPath(f.uri), name: f.name })
      } catch {
        // skip unparsable uri
      }
    }
    return out.length ? out : null
  }

  // clangd 서버(키=cwd)당 한 번만 — generate가 끝나 'generated'면 그 서버를 재시작.
  // DB는 .uproject 조상(ueRoot)에 대해 만들지만, 재시작 대상은 cwd로 띄운 서버다
  // (하위폴더를 열면 ueRoot≠cwd이므로 둘을 구분해야 한다).
  private ueKicked = new Set<string>()
  private maybeUeDb(cwd: string): void {
    if (process.platform !== 'win32' || !cwd) return
    const ur = ueRoot(cwd)
    if (!ur) return
    const key = path.resolve(cwd).toLowerCase()
    if (this.ueKicked.has(key)) return
    this.ueKicked.add(key)
    void ensureUeClangDb(ur).then((r) => {
      if (r === 'generated') this.restart('cpp', cwd)
    })
  }

  /** Drop a project's server so the next ask respawns it fresh (no cooldown). */
  private restart(defId: string, root: string): void {
    const key = `${defId}|${path.resolve(root).toLowerCase()}`
    const s = this.servers.get(key)
    if (!s) return
    this.servers.delete(key) // exit 핸들러보다 먼저 지워 쿨다운 없이 재스폰되게
    s.rpc.dispose('compile_commands.json 갱신 — 분석 서버 재시작')
    killTree(s.child)
  }

  /** Download a 'download'-kind server (user-initiated from the viewer chip). */
  async install(
    cwd: string,
    relPath: string,
    onProgress: (p: LspInstallProgress) => void
  ): Promise<{ ok: boolean; error?: string }> {
    const abs = this.resolve(cwd, relPath)
    const def = abs ? serverDefFor(abs) : null
    if (!def || def.kind !== 'download' || !DOWNLOADS[def.id]) {
      return { ok: false, error: '설치형 분석 서버가 아니에요' }
    }
    return install(def.id, onProgress)
  }

  /**
   * Semantic highlighting for a whole document. Returns the server's tokens with
   * relative positions already decoded to absolute (line, char, len, typeIndex,
   * modifierBits) quintuples; null when this file's server doesn't do semantic tokens.
   */
  async semanticTokens(cwd: string, relPath: string): Promise<LspSemanticTokens | null> {
    const abs = this.resolve(cwd, relPath)
    const def = abs ? serverDefFor(abs) : null
    const ctx = await this.prep(cwd, relPath)
    if (!ctx || !ctx.semLegend) return null
    // a failed/timed-out request reports "supported but empty" — null is reserved
    // for "this server has no semantic tokens", which stops the renderer's retries
    const r = await ctx.rpc
      .request<{ data?: number[] } | null>('textDocument/semanticTokens/full', { textDocument: { uri: ctx.uri } }, 30000)
      .catch(() => null)
    const raw = r?.data
    if (!Array.isArray(raw) || raw.length === 0) {
      // 빈 토큰 = "지원하지만 아직 없음"(서버가 인덱싱/프로젝트 로드 중). null은
      // "이 서버는 시맨틱 토큰 자체가 없음"에만 쓴다 — 그래야 렌더러가 폴링을 멈춘다.
      // Roslyn은 projectInitializationComplete 전까지 비어 올 수 있고, 그 폴링이 메운다.
      return { data: [], types: ctx.semLegend.types, mods: ctx.semLegend.mods }
    }
    const data: number[] = []
    let line = 0
    let char = 0
    for (let i = 0; i + 4 < raw.length; i += 5) {
      const dLine = raw[i]
      line += dLine
      char = dLine === 0 ? char + raw[i + 1] : raw[i + 1]
      data.push(line, char, raw[i + 2], raw[i + 3], raw[i + 4])
    }
    const out = { data, types: ctx.semLegend.types, mods: ctx.semLegend.mods }
    // 디스크 캐시에 떨궈 다음 실행 때 서버를 안 기다리고 즉시 색칠할 수 있게 한다
    if (abs && def) {
      void fsp
        .readFile(abs, 'utf8')
        .then((content) => setCached(cwd, def.id, abs, content, out))
        .catch(() => {})
    }
    return out
  }

  /**
   * 디스크 캐시에 저장된 시맨틱 토큰 — 서버를 띄우지 않고 즉시 돌려준다.
   * 뷰어가 파일을 열자마자 호출해 "0ms 색칠"을 하고, 그 뒤 semanticTokens()로
   * 라이브 토큰을 받아 다르면 갱신한다. 캐시가 없으면 null.
   */
  async cachedTokens(cwd: string, relPath: string): Promise<LspSemanticTokens | null> {
    const abs = this.resolve(cwd, relPath)
    const def = abs ? serverDefFor(abs) : null
    if (!abs || !def) return null
    if (abs.toLowerCase().startsWith(METADATA_DIR.toLowerCase())) return null
    let content: string
    try {
      content = await fsp.readFile(abs, 'utf8')
    } catch {
      return null
    }
    return getCached(cwd, def.id, abs, content)
  }

  /**
   * 프로젝트를 열 때 호출 — 첫 파일을 보기 전에 미리 워밍한다. UE면 compile DB를
   * 먼저 생성해 두고, 그 프로젝트의 주력 언어 서버를 미리 띄워 둔다(특히 C#/OmniSharp는
   * 솔루션 로드가 분 단위라 미리 데워 두면 체감 지연이 사용자 시야 밖으로 빠진다).
   */
  prewarm(cwd: string): void {
    if (!cwd) return
    const root = path.resolve(cwd)
    void gcDeadBuckets() // 원본 폴더가 사라진 프로젝트의 캐시를 회수
    this.maybeUeDb(root)
    const def = this.detectProjectServer(root)
    if (def && def.command(root)) void this.ensure(def, root)
  }

  /** cwd의 주력 언어 서버를 값싼 파일 시그널로 추정 — 못 찾으면 null. */
  private detectProjectServer(root: string): ServerDef | null {
    let names: string[] = []
    try {
      names = fs.readdirSync(root)
    } catch {
      return null
    }
    const lower = names.map((n) => n.toLowerCase())
    const has = (re: RegExp): boolean => lower.some((n) => re.test(n))
    let id: string | null = null
    // .uproject가 cwd에 없어도 조상에 있으면 UE 하위폴더를 연 것 — cpp로 본다
    if (has(/\.uproject$/) || ueRoot(root)) id = 'cpp'
    else if (has(/\.slnx?$/) || has(/\.csproj$/)) id = 'cs'
    else if (has(/^tsconfig.*\.json$/) || has(/^package\.json$/)) id = 'ts'
    else if (has(/^pyproject\.toml$/) || has(/^requirements\.txt$/) || has(/^setup\.py$/)) id = 'py'
    if (!id) return null
    const def = SERVERS.find((s) => s.id === id) ?? null
    if (!def) return null
    // 설치형(C#/C++)은 아직 안 받았으면 미리 띄울 수 없다 — 사용자가 설정에서 설치
    if (def.kind === 'download' && installState(def.id) !== 'installed') return null
    // external(Verse)도 exe 경로가 설정돼 있어야 미리 띄운다
    if (def.kind === 'external' && !def.command('')) return null
    return def
  }

  /** Every known language server + its provisioning state, for the settings tab. */
  listServers(): LspServerInfo[] {
    const list: LspServerInfo[] = SERVERS.map((def) => {
      const exts = Object.keys(def.exts)
        .map((e) => '.' + e)
        .join(' ')
      const base = { id: def.id, label: def.label, langs: def.langs, exts, requires: def.requires }
      if (def.kind === 'bundled') {
        // bundled 서버는 root와 무관하게 모듈 존재 여부만 본다
        return { ...base, kind: 'bundled' as const, state: def.command('') ? ('bundled' as const) : ('none' as const) }
      }
      // external(Verse): exe 경로가 지정돼 준비됐으면 'installed', 아니면 'none'.
      // path는 사용자가 지정한 vsix/exe 원본 경로(설정 표시용).
      if (def.kind === 'external') {
        return {
          ...base,
          kind: 'external' as const,
          state: def.command('') ? ('installed' as const) : ('none' as const),
          path: verseSourcePath() ?? undefined
        }
      }
      return { ...base, kind: 'download' as const, state: installState(def.id) }
    })
    return list
  }

  /** Download a server by id (settings tab). */
  async installServer(id: string, onProgress: (p: LspInstallProgress) => void): Promise<{ ok: boolean; error?: string }> {
    const def = SERVERS.find((s) => s.id === id)
    if (!def || def.kind !== 'download') return { ok: false, error: '설치형 분석 서버가 아니에요' }
    return install(id, onProgress)
  }

  /** Remove a downloaded server: stop every running instance, then delete from disk. */
  async uninstallServer(id: string): Promise<void> {
    this.stopServers(id)
    await uninstall(id)
  }

  /** Stop + drop every running server instance for an id (no disk changes). */
  private stopServers(id: string): void {
    for (const [key, s] of [...this.servers]) {
      if (key.startsWith(id + '|')) {
        s.rpc.dispose('서버 중지')
        killTree(s.child)
        this.servers.delete(key)
      }
    }
  }

  /** Configure Verse's verse-lsp.exe from a user path (vsix/exe). Stops any running
   *  verse server first so the destination binary isn't file-locked during copy. */
  async setVersePath(srcPath: string): Promise<{ ok: boolean; error?: string }> {
    this.stopServers('verse')
    await killHolders('verse') // orphans from a force-killed run still hold the exe
    await new Promise((r) => setTimeout(r, 300)) // let the OS release the handle
    return setVerseExe(srcPath)
  }

  /** Forget the configured Verse server (stop it, delete the prepared exe + config). */
  async clearVersePath(): Promise<void> {
    this.stopServers('verse')
    await killHolders('verse')
    await new Promise((r) => setTimeout(r, 300))
    await clearVerseExe()
  }

  /**
   * Hover info (markdown signature + docs) at an LSP (0-based) position. `text` is the live editor
   * buffer; when present we push it to the server (didChange) and feed it to the Verse helpers, so
   * hover reflects UNSAVED edits — without it, hovering inside a freshly-typed (not-yet-saved)
   * function reads stale/absent disk content at a shifted line and shows nothing.
   */
  async hover(cwd: string, relPath: string, pos: LspPos, text?: string): Promise<LspHoverResult | null> {
    const abs = this.resolve(cwd, relPath)
    const def = abs ? serverDefFor(abs) : null
    if (!abs || !def) return null
    if (abs.toLowerCase().startsWith(METADATA_DIR.toLowerCase())) return null
    if (def.kind === 'download' && installState(def.id) !== 'installed') return null
    if (def.kind === 'external' && !def.command('')) return null
    const s = this.ensure(def, def.rootFor?.(abs, cwd) ?? cwd)
    if (!s) return null
    try {
      await s.ready
    } catch {
      return null
    }
    // live buffer → didChange (reflects unsaved edits); no buffer → the disk-synced doc
    const uri = text != null ? this.syncBuffer(s, def, abs, text) : await this.openDoc(s, def, abs)
    const r = await s.rpc.request<{ contents?: unknown } | null>('textDocument/hover', {
      textDocument: { uri },
      position: pos
    })
    const contents = hoverMarkdown(r?.contents)
    if (def.id === 'verse') {
      // 0) `?` 옵션 연산자 — verse-lsp도 글로서리(wordAt)도 기호는 못 잡으므로 위치로 판별해 설명.
      const qdoc = await verseSymbolDoc(abs, pos.line, pos.character, text).catch(() => null)
      if (qdoc) return { contents: qdoc }
      // 1) 키워드·지정자·속성·내장 타입은 우리 용어집 설명으로. 내장 타입(int/void…)은 LSP가
      //    이름만 주므로 여기서 덮어쓴다 — 그래서 LSP 응답 유무와 무관하게 가장 먼저 본다.
      const gloss = await verseKeywordDoc(abs, pos.line, pos.character, text).catch(() => null)
      if (gloss) return { contents: gloss }
      // 2) 지역변수·매개변수: verse-lsp는 선언부엔 호버가 없고, 사용처엔 `:type` 시그니처만 줘서
      //    렌더러가 'Constant'로 오분류한다. 파일을 스캔해 먼저 판별하고 'Parameter'/'Local Variable'
      //    로 덮어쓴다(클래스 필드는 들여쓰기로 제외 → verse-lsp가 처리). 타입은 선언 주석 또는
      //    verse-lsp가 사용처에서 준 추론 타입(verseHoverType)으로 채운다.
      const localSig = await verseLocalHover(abs, pos.line, pos.character, verseHoverType(contents), text).catch(() => null)
      if (localSig) return { contents: localSig }
      // 3) 실제 심볼: verse-lsp 호버는 `(/path:)name<specs>`만 줄 뿐 종류 키워드(class/struct…)도
      //    문서 주석도 안 싣는다. definition으로 선언을 찾아 그 줄에서 종류를 읽어 시그니처 앞에
      //    박고(그래야 카드가 'Type'이 아니라 'Class'로 뜬다) 위의 `# …`/@doc 주석도 붙인다.
      if (contents) {
        const { doc, kind } = await this.verseDefInfo(s.rpc, uri, pos, abs, text).catch(() => ({ doc: '', kind: null }))
        const body = kind ? injectVerseKind(contents, kind) : contents
        return { contents: doc ? body + '\n\n' + doc : body }
      }
      // 4) 호버가 아예 없으면 선언부 — 그 줄에서 카드를 합성한다(+ 그 위 문서 주석).
      const declSig = await verseDeclHover(abs, pos.line, pos.character, text).catch(() => null)
      if (declSig) return { contents: declSig }
    }
    return contents ? { contents } : null
  }

  /**
   * Follow textDocument/definition for a Verse symbol and read its declaration: the doc comment
   * above it, plus the declaration kind (class/struct/enum/interface/module) when the decl line
   * is a type definition — so the hover card can label an external type reference 'Class' rather
   * than the generic 'Type'. Works on the user's code and on API digests.
   */
  private async verseDefInfo(
    rpc: StdioRpc,
    uri: string,
    pos: LspPos,
    abs?: string,
    text?: string
  ): Promise<{ doc: string; kind: string | null }> {
    const d = await rpc.request<RawLocation | RawLocation[] | null>('textDocument/definition', {
      textDocument: { uri },
      position: pos
    })
    const loc = Array.isArray(d) ? d[0] : d
    if (!loc) return { doc: '', kind: null }
    const turi = loc.uri ?? loc.targetUri
    const range = loc.range ?? loc.targetSelectionRange ?? loc.targetRange
    const line = range?.start?.line
    if (!turi || !turi.startsWith('file:') || typeof line !== 'number') return { doc: '', kind: null }
    try {
      const file = fileURLToPath(turi)
      // definition lands in the SAME (currently-edited) file → read the live buffer, not stale disk,
      // so a just-typed type's kind/doc resolve. Cross-file/digest targets stay disk-read (saved).
      const live =
        abs != null && text != null && path.resolve(file).toLowerCase() === path.resolve(abs).toLowerCase()
          ? text
          : undefined
      const lines = (live != null ? live : await fsp.readFile(file, 'utf8')).split(/\r?\n/)
      const km = /:=\s*(class|struct|enum|interface|module)\b/.exec(lines[line] ?? '')
      return { doc: await verseDocAt(file, line, live), kind: km ? km[1] : null }
    } catch {
      return { doc: '', kind: null }
    }
  }

  /**
   * Definition target(s) for the symbol at an LSP (0-based) position. `text` is the live editor
   * buffer; when present we push it (didChange) so both the clicked position AND a same-file target
   * line are in the on-screen coordinate system — without it, jumping to a symbol you just typed
   * (unsaved) resolves against stale disk content and lands on the wrong line (or nothing).
   */
  async definition(cwd: string, relPath: string, pos: LspPos, text?: string): Promise<LspLocation[]> {
    const abs = this.resolve(cwd, relPath)
    const def = abs ? serverDefFor(abs) : null
    if (!abs || !def) return []
    if (abs.toLowerCase().startsWith(METADATA_DIR.toLowerCase())) return []
    if (def.kind === 'download' && installState(def.id) !== 'installed') return []
    if (def.kind === 'external' && !def.command('')) return []
    const s = this.ensure(def, def.rootFor?.(abs, cwd) ?? cwd)
    if (!s) return []
    try {
      await s.ready
    } catch {
      return []
    }
    const uri = text != null ? this.syncBuffer(s, def, abs, text) : await this.openDoc(s, def, abs)
    const r = await s.rpc.request<RawLocation | RawLocation[] | null>('textDocument/definition', {
      textDocument: { uri },
      position: pos
    })
    const list = Array.isArray(r) ? r : r ? [r] : []
    const out: LspLocation[] = []
    for (const loc of list) {
      const uri = loc.uri ?? loc.targetUri
      const range = loc.range ?? loc.targetSelectionRange ?? loc.targetRange
      const start = range?.start
      if (!uri || !uri.startsWith('file:') || typeof start?.line !== 'number') continue
      try {
        out.push({ path: fileURLToPath(uri), line: start.line, character: start.character ?? 0 })
      } catch {
        /* unparseable uri — skip */
      }
    }
    // C#: 소스 없는 어셈블리 심볼은 $metadata$ 가짜 경로로 온다 — o#/metadata로
    // 디컴파일 소스를 받아 캐시 파일로 떨구고 그 경로로 바꿔치기해서, F12가
    // BCL 타입에서도 (읽기 전용) 원본을 연다. 실패하면 원래 경로 그대로(기존 동작).
    for (const o of out) {
      if (!o.path.includes('$metadata$')) continue
      const meta = parseMetadataPath(o.path)
      if (!meta) continue
      try {
        const safe = (s: string): string => s.replace(/[^\w.\-]/g, '_')
        const file = path.join(METADATA_DIR, safe(meta.AssemblyName), safe(meta.TypeName) + '.cs')
        if (!fs.existsSync(file)) {
          const m = await s.rpc.request<{ Source?: string } | null>('o#/metadata', { ...meta, Timeout: 5000 }, 15000)
          if (!m?.Source) continue
          await fsp.mkdir(path.dirname(file), { recursive: true })
          await fsp.writeFile(file, m.Source)
        }
        o.path = file
      } catch {
        /* 메타데이터 조회 실패 — 가짜 경로 유지 (뷰어가 '열 수 없음'을 보여준다) */
      }
    }
    return out
  }

  /**
   * Completion candidates at an LSP position. Unlike hover/definition — which query the
   * SAVED file — completion is interactive-while-typing: the partial word and any unsaved
   * edits aren't on disk yet. So the renderer hands us `text` (the live CM buffer) and we
   * push it to the server with a didChange right before asking, so the server's view, the
   * cursor position, and the partial token all line up with what the user sees on screen.
   * Returns null when the file's server has no completion provider (e.g. color-only Verse).
   */
  async completion(cwd: string, relPath: string, pos: LspPos, text: string): Promise<LspCompletionList | null> {
    const abs = this.resolve(cwd, relPath)
    const def = abs ? serverDefFor(abs) : null
    if (!abs || !def) return null
    if (abs.toLowerCase().startsWith(METADATA_DIR.toLowerCase())) return null
    if (def.kind === 'download' && installState(def.id) !== 'installed') return null
    if (def.kind === 'external' && !def.command('')) return null
    const root = def.rootFor?.(abs, cwd) ?? cwd
    const s = this.ensure(def, root)
    if (!s) return null
    try {
      await s.ready
    } catch {
      return null
    }
    if (s.complTriggers == null) return null // server advertised no completionProvider
    const uri = this.syncBuffer(s, def, abs, text)
    // when the char left of the cursor is one of the server's trigger chars (Verse '.'),
    // tell the server it was a trigger-character completion (2) — some servers only return
    // member lists in that mode; otherwise it's an explicit/typed invocation (1)
    const before = charBefore(text, pos)
    const ctx =
      before && s.complTriggers.includes(before)
        ? { triggerKind: 2, triggerCharacter: before }
        : { triggerKind: 1 }
    // a newer keystroke obsoletes any completion still in flight — cancel it so the server
    // drops the stale full-document parse instead of working through a backlog
    if (s.lastComplId != null) s.rpc.cancel(s.lastComplId)
    const { id, promise } = s.rpc.requestId<RawCompletion>(
      'textDocument/completion',
      { textDocument: { uri }, position: pos, context: ctx },
      15000
    )
    s.lastComplId = id
    let r = await promise.catch(() => null)
    if (s.lastComplId === id) s.lastComplId = undefined
    if (def.id === 'verse') {
      // ── Member access (`receiver.partial`) ──────────────────────────────────────────────
      // verse-lsp returns the lexical SCOPE here (locals+globals), never the receiver's members. So
      // resolve the receiver's type ACCURATELY (hover tracks vars/params/members/chains; a known type
      // name resolves instantly; regex is the cold/fail fallback) and list THAT type's members from our
      // scan map. Show ONLY these — the LSP's lexical-scope items are noise right after a `.`.
      const mctx = verseMemberContext(text, pos)
      if (mctx) {
        let type = verseHasType(root, text, mctx.receiver) ? mctx.receiver : null
        if (!type) {
          const hov = await s.rpc
            .request<{ contents?: unknown } | null>(
              'textDocument/hover',
              { textDocument: { uri }, position: mctx.receiverPos },
              4000
            )
            .catch(() => null)
          type = verseTypeFromHover(hoverContentString(hov))
        }
        if (!type) type = verseResolveTypeRegex(root, text, mctx.receiver, pos.line)
        if (type) {
          // a `Self.` receiver may see the class's own private members; an external `obj.` may not
          const members = verseTypeMembers(root, text, type, mctx.receiver === 'Self')
          if (members.length) return { items: members, isIncomplete: false }
        }
        // member access on an unresolved receiver — fall back to whatever verse-lsp gave (often
        // nothing), but do NOT inject scope identifiers: locals/functions are wrong right after a `.`.
        return mapCompletion(r)
      }
      // ── Identifier completion (no `.`) ──────────────────────────────────────────────────
      // verse-lsp's lexical scope only populates when the file COMPILES — which it rarely does while
      // you type — so the user's own locals/params/functions/types disappear. Scan them from the live
      // buffer + project and merge OVER verse-lsp's list so they ALWAYS appear with the right kind.
      // Only spin for a cold server when even our scan is empty (a brand-new / near-empty file).
      const scope = verseScopeCompletions(root, text, pos)
      const isEmpty = (x: RawCompletion): boolean => !x || (Array.isArray(x) ? x.length === 0 : !x.items?.length)
      for (let tries = 0; tries < 4 && isEmpty(r) && !scope.length; tries++) {
        await new Promise((res) => setTimeout(res, 120))
        if (s.lastComplId != null) s.rpc.cancel(s.lastComplId)
        const rr = s.rpc.requestId<RawCompletion>(
          'textDocument/completion',
          { textDocument: { uri }, position: pos, context: ctx },
          15000
        )
        s.lastComplId = rr.id
        r = await rr.promise.catch(() => null)
        if (s.lastComplId === rr.id) s.lastComplId = undefined
      }
      // type-annotation slot (`: Type`) → types only (no locals/functions); else the full scope merge
      if (verseIsTypePosition(text, pos)) {
        const typeScope = [
          ...verseBuiltinTypeItems(),
          ...scope.filter((it) => TYPE_KINDS.has(it.kind ?? -1))
        ]
        return mergeVerseTypes(typeScope, r, verseMemberDbRegistry(root))
      }
      return mergeVerseScope(scope, r, verseExtMethods(root))
    }
    return mapCompletion(r)
  }

  /**
   * Eagerly open a file on its LSP server (didOpen) the moment the viewer shows it, so the
   * server finishes compiling/indexing BEFORE the user types. Without this the first
   * completion is itself the file's first didOpen — the server hasn't indexed yet and returns
   * an empty list, so the popup looks broken until a few retries later (cold start). Fire-and-
   * forget; mirrors completion()'s guards and is a no-op for files with no server.
   */
  async warm(cwd: string, relPath: string): Promise<void> {
    const abs = this.resolve(cwd, relPath)
    const def = abs ? serverDefFor(abs) : null
    if (!abs || !def) return
    if (abs.toLowerCase().startsWith(METADATA_DIR.toLowerCase())) return
    if (def.kind === 'download' && installState(def.id) !== 'installed') return
    if (def.kind === 'external' && !def.command('')) return
    const s = this.ensure(def, def.rootFor?.(abs, cwd) ?? cwd)
    if (!s) return
    try {
      await s.ready
    } catch {
      return
    }
    await this.openDoc(s, def, abs).catch(() => {})
  }

  /** Accurate Verse type registry for a file's project (for the renderer's semantic colouring). */
  verseRegistry(cwd: string, relPath: string): VerseRegistry | null {
    const abs = this.resolve(cwd, relPath)
    if (!abs || serverDefFor(abs)?.id !== 'verse') return null
    const root = verseProjectRoot(abs) ?? cwd
    return root ? verseMemberDbRegistry(root) : null
  }

  /** Kill every server (app quit). */
  disposeAll(): void {
    for (const s of this.servers.values()) {
      s.rpc.dispose('앱 종료')
      killTree(s.child)
    }
    this.servers.clear()
  }

  // ── internals ──────────────────────────────────────────────

  private resolve(cwd: string, relPath: string): string | null {
    if (!relPath) return null
    if (path.isAbsolute(relPath)) return relPath
    return cwd ? path.join(cwd, relPath) : null
  }

  /** Get (or spawn) the server of this kind owning this project root. */
  private ensure(def: ServerDef, root: string): ServerHandle | null {
    if (!root) return null
    const rRoot = path.resolve(root)
    const key = `${def.id}|${rRoot.toLowerCase()}`
    const existing = this.servers.get(key)
    if (existing) {
      if (existing.status === 'error') {
        if (Date.now() - existing.diedAt < RESPAWN_COOLDOWN) return existing
        this.servers.delete(key) // cooled down — try a fresh spawn below
      } else if (def.id === 'verse' && this.verseWorkspaceStale(existing, rRoot)) {
        // UEFN rewrites the .vproject + API digests on every Verse build; a server that indexed
        // before that is stale — it can't resolve the regenerated API symbols, so official hovers
        // (and go-to-definition into the digests) go blank. Tear it down so the fresh spawn below
        // re-indexes the new project. User source edits don't count (verseWorkspaceMtime ignores them).
        existing.rpc.dispose('Verse 프로젝트 재생성 감지 — 재시작')
        killTree(existing.child)
        this.servers.delete(key)
      } else {
        return existing
      }
    }

    const plan = def.command(path.resolve(root))
    if (!plan) return null

    let child: ChildProcess
    try {
      child = spawn(plan.cmd, plan.args, {
        cwd: path.resolve(root),
        env: { ...process.env, ...plan.env },
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true
      })
    } catch {
      return null
    }

    const rpc = new StdioRpc(child)
    rpc.onRequest = (method, params) => {
      // answer the handful of server→client requests tsserver-ls actually sends;
      // an unanswered request can stall the server's queue
      if (method === 'workspace/configuration') {
        const items = (params as { items?: unknown[] } | undefined)?.items
        return Array.isArray(items) ? items.map(() => null) : []
      }
      if (method === 'workspace/applyEdit') return { applied: false }
      return null
    }

    const handle: ServerHandle = {
      rpc,
      child,
      status: 'starting',
      ready: Promise.resolve(),
      docs: new Map(),
      diedAt: 0,
      startedAt: Date.now(),
      wsCheckedAt: Date.now(),
      semLegend: null,
      complTriggers: null,
      projectInitPending: !!def.awaitsProjectInit,
      progressPct: null
    }
    // Roslyn signals the full index is ready with this notification — flip the gate so
    // status() reports 'ready' and the viewer asks for (now complete) semantic tokens.
    // $/progress feeds the explorer's analysis percentage during indexing.
    rpc.onNotify = (method, params) => {
      if (method === 'workspace/projectInitializationComplete') {
        handle.projectInitPending = false
        handle.progressPct = null
      } else if (method === '$/progress') {
        const v = (params as { value?: { kind?: string; percentage?: number } } | undefined)?.value
        if (v?.kind === 'end') handle.progressPct = null
        else if (typeof v?.percentage === 'number') handle.progressPct = v.percentage
      }
    }
    const rootUri = pathToFileURL(path.resolve(root)).href
    // Verse supplies its own multi-root folder set (source + API digests, from the .vproject).
    // With a custom set we send rootUri:null (LSP multi-root convention) so the server treats
    // each folder as a package root rather than re-scanning the project root.
    const customFolders = def.workspaceFoldersFor?.(path.resolve(root))
    const folders = customFolders ?? [{ uri: rootUri, name: path.basename(root) }]
    handle.ready = rpc
      .request<{
        capabilities?: {
          semanticTokensProvider?: { legend?: { tokenTypes?: string[]; tokenModifiers?: string[] } }
          completionProvider?: { triggerCharacters?: string[] }
        }
      }>(
        'initialize',
        {
          processId: process.pid,
          rootUri: customFolders ? null : rootUri,
          workspaceFolders: folders,
          capabilities: {
            textDocument: {
              hover: { contentFormat: ['markdown', 'plaintext'] },
              definition: {},
              // completion isn't wired for every server yet, but declaring the client
              // capability is harmless and lets servers that gate completion on it (and
              // their snippet/markdown-doc formats) light up — Verse's verse-lsp included
              completion: {
                completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'] }
              },
              synchronization: { dynamicRegistration: false },
              semanticTokens: {
                requests: { full: true },
                tokenTypes: [
                  'namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter', 'parameter',
                  'variable', 'property', 'enumMember', 'event', 'function', 'method', 'macro', 'keyword',
                  'modifier', 'comment', 'string', 'number', 'regexp', 'operator', 'decorator'
                ],
                tokenModifiers: [
                  'declaration', 'definition', 'readonly', 'static', 'deprecated',
                  'abstract', 'async', 'modification', 'documentation', 'defaultLibrary'
                ],
                formats: ['relative']
              }
            },
            workspace: { workspaceFolders: true }
          },
          ...(def.initializationOptions?.() != null ? { initializationOptions: def.initializationOptions() } : {})
        },
        // OmniSharp answers initialize only after loading the whole solution — on a
        // real project that's minutes, not seconds. The chip honestly shows 준비 중
        // for the duration; the timeout is just a backstop against a truly hung server.
        600000
      )
      .then((res) => {
        const legend = res?.capabilities?.semanticTokensProvider?.legend
        const types = legend?.tokenTypes
        handle.semLegend =
          Array.isArray(types) && types.length
            ? { types, mods: Array.isArray(legend?.tokenModifiers) ? legend.tokenModifiers : [] }
            : null
        // record the completion trigger chars (Verse: '.'). null = no completionProvider →
        // completion() short-circuits so we never round-trip to a server that can't complete.
        const cp = res?.capabilities?.completionProvider
        handle.complTriggers = cp ? (Array.isArray(cp.triggerCharacters) ? cp.triggerCharacters : []) : null
        rpc.notify('initialized', {})
        def.afterInitialized?.(rpc, path.resolve(root))
        handle.status = 'ready'
      })
    handle.ready.catch(() => {
      handle.status = 'error'
      handle.diedAt = Date.now()
      // a server that failed/hung initialize would linger forever — take it down
      // so the cooldown respawn starts from a clean slate
      killTree(child)
      rpc.dispose('초기화 실패')
    })
    child.on('error', () => {
      handle.status = 'error'
      handle.diedAt = Date.now()
      rpc.dispose('LSP 서버 실행 실패')
    })
    child.on('exit', () => {
      handle.status = 'error'
      handle.diedAt = Date.now()
      handle.docs.clear()
      rpc.dispose('LSP 서버가 종료됨')
    })

    this.servers.set(key, handle)
    return handle
  }

  /**
   * True when the Verse workspace's generated artifacts (digests/.vproject/.code-workspace) are
   * newer than when `handle` indexed them — i.e. UEFN rebuilt Verse and this server's index is
   * stale. Throttled (we'd otherwise stat the digests on every hover) and only ever consulted for
   * the verse server, where `ensure` uses it to restart the server with the regenerated project.
   */
  private verseWorkspaceStale(handle: ServerHandle, root: string): boolean {
    const now = Date.now()
    if (now - handle.wsCheckedAt < VERSE_WS_RECHECK) return false
    handle.wsCheckedAt = now
    const m = verseWorkspaceMtime(root)
    return m > 0 && m > handle.startedAt
  }

  /** Server ready + document opened/synced — the common front half of every query. */
  private async prep(
    cwd: string,
    relPath: string
  ): Promise<{
    rpc: StdioRpc
    uri: string
    semLegend: { types: string[]; mods: string[] } | null
  } | null> {
    const abs = this.resolve(cwd, relPath)
    const def = abs ? serverDefFor(abs) : null
    if (!abs || !def) return null
    if (abs.toLowerCase().startsWith(METADATA_DIR.toLowerCase())) return null
    if (def.kind === 'download' && installState(def.id) !== 'installed') return null
    if (def.kind === 'external' && !def.command('')) return null
    const s = this.ensure(def, def.rootFor?.(abs, cwd) ?? cwd)
    if (!s) return null
    try {
      await s.ready
      const uri = await this.openDoc(s, def, abs)
      return { rpc: s.rpc, uri, semLegend: s.semLegend }
    } catch {
      return null
    }
  }

  /**
   * Push the LIVE editor buffer to the server (didOpen if new, else didChange) so the very
   * next request sees the user's unsaved edits + partial word. Used by completion, which —
   * unlike the disk-synced openDoc — must reflect the on-screen buffer, not the saved file.
   * We mark the disk-sync tracker stale (mtime/size = -1) so the next openDoc (hover/def on a
   * later keystroke) re-reads disk and re-syncs, instead of trusting an unchanged mtime and
   * leaving the server stuck on this buffer version.
   */
  private syncBuffer(s: ServerHandle, def: ServerDef, abs: string, text: string): string {
    const uri = pathToFileURL(abs).href
    const cur = s.docs.get(uri)
    if (!cur) {
      s.docs.set(uri, { version: 1, mtimeMs: -1, size: -1 })
      const ext = path.extname(abs).slice(1).toLowerCase()
      s.rpc.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: def.exts[ext] ?? Object.values(def.exts)[0], version: 1, text }
      })
      if (s.docs.size > MAX_OPEN_DOCS) {
        const oldest = s.docs.keys().next().value
        if (oldest && oldest !== uri) {
          s.docs.delete(oldest)
          s.rpc.notify('textDocument/didClose', { textDocument: { uri: oldest } })
        }
      }
    } else {
      cur.version++
      cur.mtimeMs = -1
      cur.size = -1
      s.rpc.notify('textDocument/didChange', {
        textDocument: { uri, version: cur.version },
        contentChanges: [{ text }] // no range → full-content replace
      })
    }
    return uri
  }

  /**
   * didOpen the file (or didChange when it changed on disk since — e.g. the agent
   * just edited it), so the server's view always matches what the viewer shows.
   */
  private async openDoc(s: ServerHandle, def: ServerDef, abs: string): Promise<string> {
    const uri = pathToFileURL(abs).href
    const st = await fsp.stat(abs)
    const cur = s.docs.get(uri)
    if (cur && cur.mtimeMs === st.mtimeMs && cur.size === st.size) return uri
    const text = await fsp.readFile(abs, 'utf8')
    if (!cur) {
      s.docs.set(uri, { version: 1, mtimeMs: st.mtimeMs, size: st.size })
      const ext = path.extname(abs).slice(1).toLowerCase()
      s.rpc.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: def.exts[ext] ?? Object.values(def.exts)[0], version: 1, text }
      })
      if (s.docs.size > MAX_OPEN_DOCS) {
        const oldest = s.docs.keys().next().value
        if (oldest && oldest !== uri) {
          s.docs.delete(oldest)
          s.rpc.notify('textDocument/didClose', { textDocument: { uri: oldest } })
        }
      }
    } else {
      cur.version++
      cur.mtimeMs = st.mtimeMs
      cur.size = st.size
      s.rpc.notify('textDocument/didChange', {
        textDocument: { uri, version: cur.version },
        contentChanges: [{ text }] // no range → full-content replace
      })
    }
    return uri
  }
}

export const lspManager = new LspManager()
