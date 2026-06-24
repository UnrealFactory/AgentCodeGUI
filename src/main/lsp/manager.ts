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
  verseDeclHover,
  verseDocAt,
  verseKeywordDoc,
  setVerseExe,
  clearVerseExe
} from './verse'
import { getCached, setCached, gcDeadBuckets } from './semcache'
import { APP_HOME } from '../engine/versions'
import type {
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
  // Roslyn: true between initialize and projectInitializationComplete — status reports
  // 'starting' while true so the viewer waits for the full index before asking tokens
  projectInitPending: boolean
  // latest $/progress percentage during indexing (Roslyn 'Loading'…), null when none —
  // feeds the explorer's "분석 중 N%" badge
  progressPct: number | null
  // the server's semanticTokens legend (token type names + modifier names) from the
  // initialize result — null when the server doesn't do semantic highlighting
  semLegend: { types: string[]; mods: string[] } | null
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

  /** Hover info (markdown signature + docs) at an LSP (0-based) position. */
  async hover(cwd: string, relPath: string, pos: LspPos): Promise<LspHoverResult | null> {
    const ctx = await this.prep(cwd, relPath)
    if (!ctx) return null
    const r = await ctx.rpc.request<{ contents?: unknown } | null>('textDocument/hover', {
      textDocument: { uri: ctx.uri },
      position: pos
    })
    const contents = hoverMarkdown(r?.contents)
    const abs = this.resolve(cwd, relPath)
    const def = abs ? serverDefFor(abs) : null
    if (def?.id === 'verse' && abs) {
      // 1) 키워드·지정자·속성·내장 타입은 우리 용어집 설명으로. 내장 타입(int/void…)은 LSP가
      //    이름만 주므로 여기서 덮어쓴다 — 그래서 LSP 응답 유무와 무관하게 가장 먼저 본다.
      const gloss = await verseKeywordDoc(abs, pos.line, pos.character).catch(() => null)
      if (gloss) return { contents: gloss }
      // 2) 실제 심볼: verse-lsp는 호버에 문서 주석을 안 싣는다 — definition으로 선언을 찾아
      //    그 위의 `# …`/@doc 주석을 붙인다(내 코드 또는 API digest).
      if (contents) {
        const doc = await this.verseHoverDoc(ctx.rpc, ctx.uri, pos).catch(() => '')
        return { contents: doc ? contents + '\n\n' + doc : contents }
      }
      // 3) 호버가 아예 없으면 선언부 — 그 줄에서 카드를 합성한다(+ 그 위 문서 주석).
      const declSig = await verseDeclHover(abs, pos.line, pos.character).catch(() => null)
      if (declSig) return { contents: declSig }
    }
    return contents ? { contents } : null
  }

  /** The doc comment above a Verse symbol's declaration, found via textDocument/definition. */
  private async verseHoverDoc(rpc: StdioRpc, uri: string, pos: LspPos): Promise<string> {
    const d = await rpc.request<RawLocation | RawLocation[] | null>('textDocument/definition', {
      textDocument: { uri },
      position: pos
    })
    const loc = Array.isArray(d) ? d[0] : d
    if (!loc) return ''
    const turi = loc.uri ?? loc.targetUri
    const range = loc.range ?? loc.targetSelectionRange ?? loc.targetRange
    const line = range?.start?.line
    if (!turi || !turi.startsWith('file:') || typeof line !== 'number') return ''
    try {
      return await verseDocAt(fileURLToPath(turi), line)
    } catch {
      return ''
    }
  }

  /** Definition target(s) for the symbol at an LSP (0-based) position. */
  async definition(cwd: string, relPath: string, pos: LspPos): Promise<LspLocation[]> {
    const ctx = await this.prep(cwd, relPath)
    if (!ctx) return []
    const r = await ctx.rpc.request<RawLocation | RawLocation[] | null>('textDocument/definition', {
      textDocument: { uri: ctx.uri },
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
          const m = await ctx.rpc.request<{ Source?: string } | null>('o#/metadata', { ...meta, Timeout: 5000 }, 15000)
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
    const key = `${def.id}|${path.resolve(root).toLowerCase()}`
    const existing = this.servers.get(key)
    if (existing) {
      if (existing.status !== 'error') return existing
      if (Date.now() - existing.diedAt < RESPAWN_COOLDOWN) return existing
      this.servers.delete(key) // cooled down — try a fresh spawn below
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
      semLegend: null,
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
        capabilities?: { semanticTokensProvider?: { legend?: { tokenTypes?: string[]; tokenModifiers?: string[] } } }
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
