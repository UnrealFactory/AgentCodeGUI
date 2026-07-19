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
  verseOverrideDoc,
  setVerseExe,
  clearVerseExe
} from './verse'
import {
  verseMemberContext,
  verseDotContext,
  verseHasType,
  verseMemberDoc,
  verseTypeFromHover,
  verseResolveTypeRegex,
  verseTypeMembers,
  verseScopeCompletions,
  verseExtMethods,
  verseIsTypePosition,
  verseBuiltinTypeItems,
  verseRegistry as verseMemberDbRegistry,
  verseRegistryRev,
  invalidateVerseMemberCache,
  clearVerseMemberCache
} from './verseMemberDb'
import { getCached, setCached, gcDeadBuckets } from './semcache'
import { APP_HOME } from '../engine/versions'
import {
  glossaryLineDoc,
  keywordPriorityDoc,
  ueCppPriorityDoc,
  ueCppFallbackDoc,
  glossaryDoc,
  glossaryWordAt,
  csSymbolDoc
} from '@shared/langGlossary'
import { translateUeHover } from './ueDocKo'
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
   *  which projects to open here (after `initialized`). Other servers don't need it.
   *  반환: 무언가 열었으면 true, 열 것이 없었으면 false — false면 ensure가
   *  projectInitializationComplete 게이트를 바로 내린다(기다릴 로드가 없다). */
  afterInitialized?(rpc: StdioRpc, root: string): boolean
  /** true when the server keeps loading after `initialize` and signals readiness with
   *  a `workspace/projectInitializationComplete` notification (Roslyn). We hold the
   *  status at 'starting' until then so the viewer only asks for tokens once the index
   *  is complete — otherwise it captures early/partial tokens and never refreshes. */
  awaitsProjectInit?: boolean
  /** 파일별 서버 루트 — 기본은 열린 프로젝트(cwd). C#은 그 파일의 csproj를 '참조하는'
   *  솔루션 폴더(크로스 프로젝트 분석·서버 1개), 없으면 가장 가까운 .csproj 폴더로 좁힌다.
   *  참조 검사 덕에 UE 모노레포 루트의 무관한 sln(엔진 자동화 프로젝트 수십 개)을 물어
   *  정작 보는 파일이 어느 프로젝트에도 속하지 않던 실패는 나지 않는다 (csRootFor) */
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

// ── C# 솔루션 인식 루트 ──────────────────────────────────────────
// 보는 파일은 csproj 하나여도, 그 csproj를 '참조하는' 솔루션(.sln/.slnx)이 있으면 솔루션
// 폴더를 루트로 삼아 솔루션째 연다 — 한 Roslyn이 프로젝트 전부(크로스 참조 포함)를 담당하고,
// 프로젝트를 오가며 봐도 서버가 하나만 뜬다. '참조하는지'를 실제로 검사하므로 UE 루트의
// 무관한 자동화 sln(예전 휴리스틱이 무서워하던 것)은 자연히 걸러진다. UnrealSharp 배치는
// 관리 솔루션이 <UE루트>/Script에 있고 플러그인 스크립트는 Plugins/<P>/Script에 있어 조상
// 관계가 아니다 — ueRoot로 따로 찾는다(플러그인 폴더만 열었어도 게임의 관리 솔루션을 쓴다).
interface CsRootHit {
  root: string
  sln: string | null // 참조 확인된 솔루션 파일의 절대 경로 (afterInitialized가 정확히 이걸 연다)
}
const csRootMemo = new Map<string, { at: number; hit: CsRootHit }>()
const CS_ROOT_TTL = 30_000 // 솔루션 탐색은 파일시스템 워크 — status 폴링(400ms)마다 걷지 않게
// rootFor가 고른 솔루션을 afterInitialized(시그니처가 root뿐)에 전달하는 스태시
const csSolutionByRoot = new Map<string, string>()

// "참조 확인 없이는 솔루션을 열지 않는다"의 폴백 확장 — csproj 조상이 없는 낱파일이 UE
// 루트(cwd)로 폴백해 뜬 서버 루트가 여기 등록되고, afterInitialized가 이 루트에선 루트
// 솔루션 자동 열기를 생략한다. UE 루트의 솔루션은 UBT가 생성한 것(엔진 자동화 프로젝트
// 수십 개 참조)이라 통째로 열면 수 분짜리 헛인덱싱인데, 낱파일은 어차피 어느 프로젝트
// 소속도 아니어서 misc 문서가 되고 misc는 솔루션 없이도 기본 색이 나온다(얻는 것 동일).
const csNoAutoSln = new Set<string>()

// UE 룰 파일(*.Build.cs / *.Target.cs)의 주인 — UBT가 프로젝트 파일 생성 때 만들어 두는
// 룰 전용 프로젝트(<UE루트>/Intermediate/Build/BuildRulesProjects/<X>/, Build.cs·Target.cs를
// include). 폴더 탐색은 디스크 워크라 csRootMemo와 같은 TTL로 memo — 프로젝트 파일을
// 나중에 생성해도(폴더가 나중에 생겨도) TTL 뒤엔 잡힌다.
const ueRulesMemo = new Map<string, { at: number; dir: string | null }>()
function ueRulesProjectDir(ur: string): string | null {
  const key = path.resolve(ur).toLowerCase()
  const memo = ueRulesMemo.get(key)
  if (memo && Date.now() - memo.at < CS_ROOT_TTL) return memo.dir
  let dir: string | null = null
  try {
    const base = path.join(ur, 'Intermediate', 'Build', 'BuildRulesProjects')
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const d = path.join(base, e.name)
      let ok = false
      try {
        ok = fs.readdirSync(d).some((f) => f.toLowerCase().endsWith('.csproj'))
      } catch {
        /* 못 읽는 폴더 — 다음 후보로 */
      }
      if (ok) {
        dir = d
        break
      }
    }
  } catch {
    /* 룰 프로젝트 미생성(프로젝트 파일을 만든 적 없음) — 기존 폴백 유지 */
  }
  ueRulesMemo.set(key, { at: Date.now(), dir })
  return dir
}

// Roslyn MetadataAsSource(F12로 어셈블리 심볼에 들어갈 때 서버가 %TEMP%에 떨궈 주는 디컴파일/
// PDB 소스) 경로 → 그 파일을 만들어 준 서버의 루트. 이 파일은 어떤 프로젝트에도 속하지 않아
// 일반 rootFor로는 엉뚱한 서버가 뜨고(misc행 — 같은 파일 심볼만 색칠), 오직 '만든 서버'만이
// 자기 메타데이터 워크스페이스 문서로 제대로 분석한다. definition()이 채운다.
const META_AS_SOURCE_RE = /[\\/]MetadataAsSource[\\/]/i
const metadataAsSourceRoot = new Map<string, string>()
// 주인을 모르는 MetadataAsSource(앱 재시작 후 최근 파일 탭 등으로 재열람 — 맵은 메모리라
// 비어 있다)용 폴백: 가장 최근에 쓴 C# 서버 루트. 그 서버가 만든 파일일 가능성이 가장 높고,
// 아니어도 cwd 루트(무관한 솔루션)로 새 서버를 띄우는 것보단 낫다.
let lastCsRoot: string | null = null

// Roslyn 버그 우회: 대상이 MetadataAsSource 임시 파일인 정의 요청은 "그 파일을 처음 생성한
// 한 번"만 위치를 주고, 같은 심볼의 두 번째 요청부터는 빈 응답이 온다(실측 — 파일이 이미
// 있으면 위치 반환을 건너뛰는 서버 동작). 첫 성공을 (소스 파일 + 커서 단어) 키로 기억해 두고
// 빈 응답이 오면 캐시로 답한다. 임시 파일 대상만 캐시하므로 일반 코드의 정당한 "정의 없음"
// (공백·키워드 위 등)은 건드리지 않는다.
const metaDefCache = new Map<string, LspLocation[]>()
const META_DEF_CACHE_CAP = 500
// 지금까지 definition 결과로 본 MetadataAsSource 파일들 (소문자 → 원본 경로). 아래 "컨테이너
// 경유 복구"가 타입 이름으로 이미 생성된 임시 파일을 되찾는 데 쓴다.
const metaFilesSeen = new Map<string, string>()

/**
 * 빈 정의 응답의 컨테이너 경유 복구 — Roslyn의 1회용은 심볼이 아니라 '생성 파일' 단위라,
 * 같은 임시 파일에 사는 두 번째 멤버부터는 첫 요청조차 0개가 온다(실측: Bind_FProperty의
 * CallGetNativePropertyFromName가 파일을 만들면 CallGetPropertyOffsetFromName는 영영 빈 응답).
 * 호버 시그니처(`int Bind_FProperty.CallGetPropertyOffsetFromName(…)`)에서 컨테이너 타입을
 * 읽어, 이미 본 그 타입의 임시 파일 안에서 멤버 선언 줄을 텍스트로 찾아 위치를 합성한다.
 */
async function recoverMetaDef(rpc: StdioRpc, uri: string, pos: LspPos, word: string, srcAbs: string): Promise<LspLocation | null> {
  const hov = await rpc
    .request<{ contents?: unknown } | null>('textDocument/hover', { textDocument: { uri }, position: pos }, 8000)
    .catch(() => null)
  const md = hoverContentString(hov)
  const m = new RegExp(`([A-Za-z_]\\w*)\\.${word}\\s*[({<]`).exec(md) ?? new RegExp(`([A-Za-z_]\\w*)\\.${word}\\b`).exec(md)
  const container = m?.[1]
  if (!container) return null
  // 파일명 후보: 컨테이너 그대로 + UE 접두사(U/A/F/E) 벗긴 것 — C# 클래스 UToolMenuEntryScript의
  // 생성 파일은 엔진 이름 그대로 ToolMenuEntryScript.generated.cs다.
  const names = new Set([container.toLowerCase()])
  if (/^[UAFE][A-Z]/.test(container)) names.add(container.slice(1).toLowerCase())
  const wanted = new Set<string>()
  for (const n of names) {
    wanted.add(`${n}.generated.cs`)
    wanted.add(`${n}.cs`)
  }
  // 현재 파일 자신도 후보(같은 타입의 다른 멤버 — 예: 선언으로의 파일 내 점프)
  const candidates = [srcAbs, ...metaFilesSeen.values()]
  for (const orig of candidates) {
    if (!wanted.has(path.basename(orig).toLowerCase())) continue
    try {
      if (!fs.existsSync(orig)) continue
      const ls = (await fsp.readFile(orig, 'utf8')).split(/\r?\n/)
      const declRe = new RegExp(`\\b${word}\\s*[(<]`)
      // 선언 줄 우선(public/static 등 선두 한정자 동반), 없으면 첫 등장 줄
      let li = ls.findIndex((l) => declRe.test(l) && /^\s*(?:\[|public|private|protected|internal|static|extern|unsafe|partial)/.test(l))
      if (li < 0) li = ls.findIndex((l) => declRe.test(l))
      if (li < 0) continue
      return { path: orig, line: li, character: Math.max(0, ls[li].indexOf(word)) }
    } catch {
      /* 못 읽으면 다음 후보로 */
    }
  }
  return null
}

/** dir 안의 .sln/.slnx 중 `csprojs`(절대경로 소문자 집합) 하나라도 참조하는 첫 파일 —
 *  그 솔루션이 참조하는 전체 csproj 수(projects)와 함께. 수가 클수록 "완전한" 솔루션이다. */
function slnReferencing(dir: string, csprojs: Set<string>): { sln: string; projects: number } | null {
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  const slns = names.filter((n) => /\.slnx?$/i.test(n))
  slns.sort((a, b) => Number(/\.sln$/i.test(a)) - Number(/\.sln$/i.test(b))) // 신형 .slnx 우선
  for (const n of slns) {
    let txt = ''
    try {
      txt = fs.readFileSync(path.join(dir, n), 'utf8')
    } catch {
      continue
    }
    // .slnx는 Path="…csproj", .sln은 "…\X.csproj" — 어느 형식이든 따옴표 안 경로로 잡힌다
    const re = /"([^"]+\.csproj)"/gi
    let m: RegExpExecArray | null
    let projects = 0
    let matched = false
    while ((m = re.exec(txt))) {
      projects++
      try {
        if (!matched && csprojs.has(path.resolve(dir, m[1]).toLowerCase())) matched = true
      } catch {
        /* 이상한 경로 항목 — 다음 항목으로 */
      }
    }
    if (matched) return { sln: path.join(dir, n), projects }
  }
  return null
}

/** 파일의 C# 서버 루트: 참조 솔루션 폴더(있으면) > 가장 가까운 csproj 폴더 > cwd. */
function csRootFor(abs: string, cwd: string): string {
  // F12로 들어간 MetadataAsSource 임시 파일 — 만들어 준 서버로 되돌려 보낸다 (위 주석 참조)
  if (META_AS_SOURCE_RE.test(abs)) {
    const owner = metadataAsSourceRoot.get(path.resolve(abs).toLowerCase())
    if (owner) return owner
    if (lastCsRoot) return lastCsRoot // 주인 미상(재시작 후 재열람) — 최근 C# 서버로 폴백
  }
  const projDir = nearestCsProjectRoot(abs, cwd)
  if (!projDir) {
    // UnrealSharp UHT 글루(<플러그인>/Intermediate/UnrealSharp/UHT/**)는 csproj 조상이 없다 —
    // 진짜 소유자는 <플러그인>/Managed/UnrealSharp/UnrealSharp/UnrealSharp.csproj의 글롭
    // include다. 그 프로젝트로 위임해 UnrealSharp.sln째 열면 글루 문서가 로드된 프로젝트에
    // 매칭돼 심볼이 전부 풀린다 — 위임 없이는 cwd 루트(무관한 C++ 솔루션)로 스폰돼 misc
    // 워크스페이스행: 로컬만 풀리고 IntPtr 같은 크로스 어셈블리 심볼은 전멸한다.
    // (게임 쪽 글루는 폴더에 자체 csproj가 UBT로 생성돼 있어 위의 일반 경로로 풀린다)
    const glue = /^(.*?)[/\\]Intermediate[/\\]UnrealSharp[/\\]UHT[/\\]/i.exec(abs)
    if (glue) {
      const owner = path.join(glue[1], 'Managed', 'UnrealSharp', 'UnrealSharp', 'UnrealSharp.csproj')
      try {
        if (fs.existsSync(owner)) return csRootFor(owner, cwd)
      } catch {
        /* 접근 불가 — cwd 폴백 */
      }
    }
    // UE 룰 파일(Build.cs·Target.cs)도 csproj 조상이 없다 — 진짜 주인은 UBT의 룰 전용
    // 프로젝트(ueRulesProjectDir)다. 그 폴더로 'csproj 단독 로드' 위임한다: 참조 솔루션
    // 탐색을 일부러 안 거치는데, 루트의 UBT 생성 거대 솔루션이 이 csproj를 참조하고 있어
    // 평소 규칙대로면 그 솔루션째(엔진 자동화 프로젝트 수십 개) 열리기 때문 — 룰 프로젝트
    // 하나면 몇 초 만에 색·호버가 전부 나온다.
    if (/\.(build|target)\.cs$/i.test(abs)) {
      const ur = ueRoot(path.dirname(abs))
      if (ur) {
        const rules = ueRulesProjectDir(ur)
        if (rules) {
          lastCsRoot = rules // F12(디컴파일 소스)의 주인 미상 폴백도 이 서버로
          return rules
        }
      }
    }
    // 그 외 주인 없는 낱파일이 UE 루트로 떨어지는 경우 — 루트 솔루션 자동 열기를 눌러 둔다
    // (csNoAutoSln 주석). 비 UE 프로젝트는 루트 솔루션이 대개 사용자 자신의 것이라 기존대로.
    if (cwd && ueRoot(cwd)) csNoAutoSln.add(path.resolve(cwd).toLowerCase())
    return cwd
  }
  const key = projDir.toLowerCase() + '|' + (cwd || '').toLowerCase()
  const memo = csRootMemo.get(key)
  if (memo && Date.now() - memo.at < CS_ROOT_TTL) return memo.hit.root
  let csprojs = new Set<string>()
  try {
    csprojs = new Set(
      fs
        .readdirSync(projDir)
        .filter((n) => n.toLowerCase().endsWith('.csproj'))
        .map((n) => path.join(projDir, n).toLowerCase())
    )
  } catch {
    /* 못 읽으면 아래 폴백(projDir 단독)으로 */
  }
  let hit: CsRootHit = { root: projDir, sln: null }
  if (csprojs.size) {
    // 후보 수집: ① csproj 폴더에서 cwd 경계까지 조상 워크 + ② UnrealSharp 특례(<UE루트>/Script —
    // 관리 솔루션이 플러그인 스크립트와 조상 관계가 아니라 따로 본다; cwd 밖이어도).
    // 그중 "참조 프로젝트 수가 가장 많은" 솔루션을 고른다(동률이면 안쪽 우선) — csproj 폴더에
    // 도구가 떨궈 둔 단일 프로젝트 sln이 진짜(전체) 솔루션을 가리면, 프라임이 형제 프로젝트를
    // 커버하지 못해 크로스 프로젝트 심볼이 무색으로 남는다(UnrealSharp에서 실측).
    const candidates: { root: string; sln: string; projects: number }[] = []
    const stop = cwd ? path.resolve(cwd).toLowerCase() : ''
    let dir = projDir
    for (let i = 0; i < 16; i++) {
      const c = slnReferencing(dir, csprojs)
      if (c) candidates.push({ root: dir, ...c })
      if (dir.toLowerCase() === stop) break
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    const ur = ueRoot(projDir)
    if (ur) {
      const scriptDir = path.join(ur, 'Script')
      const c = slnReferencing(scriptDir, csprojs)
      if (c && !candidates.some((x) => x.sln.toLowerCase() === c.sln.toLowerCase())) {
        candidates.push({ root: scriptDir, ...c })
      }
    }
    let best: { root: string; sln: string; projects: number } | null = null
    for (const c of candidates) if (!best || c.projects > best.projects) best = c
    if (best) hit = { root: best.root, sln: best.sln }
  }
  csRootMemo.set(key, { at: Date.now(), hit })
  if (hit.sln) csSolutionByRoot.set(path.resolve(hit.root).toLowerCase(), hit.sln)
  lastCsRoot = hit.root // 주인 미상 MetadataAsSource 폴백용 — 최근 실사용 루트
  return hit.root
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
// C# 재프라임이 마지막 파일 변화 통지로부터 보장하는 조용한 간격 — Roslyn 폴백 워처의
// 새 파일 편입(실측 0.8~1.6초, 소형 솔루션 기준)이 끝난 뒤에 프라임해야 한다. 그 전에
// 프라임하면 새 파일이 빠진 컴파일이 "프라임 완료"로 확정돼 영영 무색(실측 재현).
const PRIME_REDO_GAP = 3_000

interface DocState {
  version: number
  mtimeMs: number
  size: number
  // 마지막으로 서버에 보낸 문서 내용 — incremental 동기화 서버(Roslyn)에 didChange를
  // "이전 문서 전체 range + 새 텍스트"로 보내기 위한 기준. 열린 문서(≤MAX_OPEN_DOCS)만 유지.
  text: string
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
  // completionItem/resolve 지원(initialize의 completionProvider.resolveProvider) — tsserver/
  // pyright/Roslyn은 후보 목록엔 문서를 안 싣고 resolve로 지연 제공한다. false면 요청 안 함.
  complResolve: boolean
  // initialize 결과의 textDocumentSync.change — 2(incremental)를 선언한 서버(Roslyn)에는
  // didChange를 range 없는 전문 교체로 보내면 안 된다: Roslyn은 range null에
  // NullReferenceException으로 '프로세스째' 죽는다. 그런 서버엔 전체-range 교체로 보낸다.
  syncKind: number
  // Roslyn 전 솔루션 시맨틱 프라임(workspace/symbol) — 형제 ProjectReference의 스켈레톤은
  // 그 프로젝트 컴파일을 누가 요구해야 만들어지고, 없으면 frozen 토큰 모델이 크로스 프로젝트
  // 심볼을 영영 'variable'(무색)로 분류한다. 한 번의 심볼 검색이 전 프로젝트 컴파일을 강제한다.
  wsSymPrime?: Promise<void>
  // C# 파일이 마지막으로 생성/수정/삭제 통지된 시각(0 = 없음) — 프라임은 스냅샷이라 그 뒤의
  // 새 파일/새 타입은 재프라임 전까지 열린 문서들에서 영영 무색이다(실측). notifyWatchedFiles가
  // 이 시각을 찍고 wsSymPrime을 비워 다음 토큰 요청이 재프라임하게 하고, primeFullSemantics는
  // 이 시각으로부터 조용한 간격(PRIME_REDO_GAP)을 보장한다 — Roslyn 폴백 워처의 새 파일 편입
  // (실측 0.8~1.6초)이 끝나기 '전'의 프라임은 새 파일 없는 컴파일을 확정하는 헛프라임이다.
  primeDirtyAt: number
  // 마지막 완성 응답의 "원본" 아이템들(서버의 data 필드 포함) — resolve는 원본을 그대로
  // 돌려보내야 한다. gen(세대)으로 렌더러의 지연 resolve가 낡은 목록을 집는 걸 막는다.
  complRaw: { gen: number; items: RawCompletionItem[] } | null
  complGen: number
  // C# 전용: 로드한 솔루션 파일(.sln/.slnx)의 워처 — UnrealSharp가 플러그인 생성/삭제로
  // 솔루션을 재생성하면 solution/open을 재통지해 새 프로젝트를 로드한다(watchCsSolution).
  // 서버가 죽으면 반드시 close (안 하면 워처가 유령으로 남아 죽은 rpc에 notify한다).
  slnWatch?: fs.FSWatcher
  // C# 전용: 서버 루트의 재귀 워처 — 앱을 '거치지 않은' 디스크 변화(에이전트 Bash, 외부
  // 도구의 코드 재생성, 외부 에디터, git)를 notifyWatchedFiles로 흘린다(watchCsRoot).
  // slnWatch와 같은 자리들에서 close.
  dirWatch?: fs.FSWatcher
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
      // spawn failure (ENOENT 등) is emitted async — without the error listener it
      // becomes an uncaughtException; fall back to a plain kill instead
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
      })
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
    // 파일의 csproj를 '참조하는' 솔루션이 있으면 그 폴더(솔루션째 로드 — 크로스 프로젝트
    // 분석·서버 1개), 없으면 가장 가까운 csproj 폴더(단독 로드)로 좁힌다. csRootFor 참조.
    rootFor: (abs, cwd) => csRootFor(abs, cwd),
    // initialize 후에도 솔루션 인덱싱이 한참 걸린다 — projectInitializationComplete
    // 전까지 status를 'starting'으로 잡아 뷰어가 완성된 토큰만 받게 한다
    awaitsProjectInit: true,
    // Roslyn은 솔루션/프로젝트를 스스로 찾지 않는다 — rootFor가 참조 확인까지 마친 솔루션이
    // 있으면 정확히 그 파일을(solution/open), 아니면 루트의 .sln/.slnx → .csproj들 순으로
    // 열어 줘야 인덱싱이 시작된다. 로드가 끝나면 workspace/projectInitializationComplete가
    // 오고, 그 전엔 빈 토큰이 올 수 있어 렌더러의 semanticTokens 재시도(폴링)가 이를 메운다.
    afterInitialized: (rpc, root) => {
      const chosen = csSolutionByRoot.get(root.toLowerCase())
      // UE 루트로 폴백한 낱파일 서버 — 참조 확인 안 된 루트 솔루션(UBT 생성 거대 솔루션)을
      // 열지 않는다(csNoAutoSln 주석). 문서는 misc로 동작하고 기본 색은 그대로 나온다.
      if (!chosen && csNoAutoSln.has(root.toLowerCase())) return false
      const sln = chosen ? pathToFileURL(chosen).href : slnUri(root)
      if (sln) {
        // 프리웜(prewarm → ensure 직행, csRootFor 미경유)으로 뜬 서버는 스태시가 비어 있다 —
        // 여기서 실제로 연 솔루션을 채워야 직후의 watchCsSolution이 재생성 감시를 건다.
        // 안 채우면 외부 도구가 새 프로젝트를 추가하며 솔루션 파일을 재생성해도 프리웜
        // 경로의 서버만 그걸 몰라, 새 프로젝트의 모든 .cs가 misc(무색)로 남는다.
        if (!chosen) csSolutionByRoot.set(root.toLowerCase(), fileURLToPath(sln))
        rpc.notify('solution/open', { solution: sln })
        return true
      }
      const projects = csprojUris(root)
      if (projects.length) {
        rpc.notify('project/open', { projects })
        return true
      }
      return false
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

// 파일의 용어집 언어 키(shared/langGlossary의 LANG_GLOSSARY 키) — 없으면 null.
// LSP languageId(typescriptreact 등)를 렌더러 fileType.lang과 같은 키로 접는다.
function glossaryLangFor(def: ServerDef, absPath: string): string | null {
  const ext = path.extname(absPath).slice(1).toLowerCase()
  const id = def.exts[ext]
  if (!id) return null
  if (id === 'typescript' || id === 'typescriptreact') return 'typescript'
  if (id === 'javascript' || id === 'javascriptreact') return 'javascript'
  if (id === 'python' || id === 'csharp' || id === 'cpp' || id === 'c') return id
  return null
}

// 파일이 UE C++인지 — ① UE 프로젝트(.uproject 조상) 안이거나 ② 엔진 소스 트리 자체
// (…\UE_5.x\Engine\Source\… — F12로 엔진 헤더에 들어간 경우. 엔진 트리엔 .uproject가 없어
// ueRoot로는 못 잡는다; 엔진 루트의 Engine/Build/Build.version이 마커다). 호버마다 위로
// 걷지 않게 폴더별로 memo. UE 전용 어휘(UPROPERTY·int32·번역…)는 이 판정이 참일 때만.
const ueDirMemo = new Map<string, boolean>()
function ueEngineRoot(dir: string): string | null {
  let d = path.resolve(dir)
  for (let i = 0; i < 24; i++) {
    try {
      if (fs.existsSync(path.join(d, 'Engine', 'Build', 'Build.version'))) return d
    } catch {
      /* unreadable — keep walking */
    }
    const parent = path.dirname(d)
    if (parent === d) break
    d = parent
  }
  return null
}
function isUeCpp(def: ServerDef, abs: string): boolean {
  if (def.id !== 'cpp') return false
  const dir = path.dirname(path.resolve(abs)).toLowerCase()
  let v = ueDirMemo.get(dir)
  if (v === undefined) {
    v = ueRoot(dir) != null || ueEngineRoot(dir) != null
    ueDirMemo.set(dir, v)
  }
  return v
}

// (pos.line, text|디스크)에서 커서 줄 텍스트 하나를 읽는다 — 용어집류 판정의 공통 입력.
async function lineAt(abs: string, line: number, text?: string): Promise<string> {
  try {
    return (text != null ? text : await fsp.readFile(abs, 'utf8')).split(/\r?\n/)[line] ?? ''
  } catch {
    return ''
  }
}

/**
 * offset이 C# set/init 접근자 본문 안인가 — 세터의 암시적 `value` 판정용. Roslyn은 암시적
 * value에 평범한 매개변수 카드(+널 분석 소음)만 줘서 "이게 뭔지"를 설명하지 못하므로,
 * 접근자 안으로 확인될 때만 용어집이 먼저 답한다(접근자 밖의 진짜 value 심볼은 안 가린다).
 * 문자열/주석 안 중괄호까지는 안 본다 — 카드 하나의 폴백 판정이라 휴리스틱으로 충분.
 */
function csInSetAccessor(full: string, offset: number): boolean {
  // ① 표현식 본문: `set => … value` — 문장 경계(;·{·}) 전까지 거꾸로 보며 '=>' 앞 토큰 확인
  for (let i = offset - 1; i >= 0; i--) {
    const c = full[i]
    if (c === ';' || c === '{' || c === '}') break
    if (c === '>' && full[i - 1] === '=') {
      const m = /(\w+)\s*$/.exec(full.slice(Math.max(0, i - 24), i - 1))
      if (m && (m[1] === 'set' || m[1] === 'init')) return true
      break
    }
  }
  // ② 블록 본문: 미짝 '{'를 바깥으로 걸으며 여는 괄호 앞 토큰이 set/init인지 — if/for 같은
  //    안쪽 블록은 지나쳐 계속 바깥으로, get 접근자를 만나면 확정적으로 아님.
  let depth = 0
  for (let i = offset - 1; i >= 0; i--) {
    const c = full[i]
    if (c === '}') depth++
    else if (c === '{') {
      if (depth > 0) {
        depth--
        continue
      }
      const m = /(\w+)\s*$/.exec(full.slice(Math.max(0, i - 24), i))
      if (m && (m[1] === 'set' || m[1] === 'init')) return true
      if (m && m[1] === 'get') return false
    }
  }
  return false
}

/**
 * UE 매크로·지정자 우선 호버 — LSP보다 먼저 답한다(hover()의 최상단에서 호출). UPROPERTY 같은
 * 리플렉션 매크로는 clangd가 `#define …` 전개 카드(정보 없음)를 주고, 괄호 안 지정자
 * (EditAnywhere…)는 UHT 전용 토큰이라 아예 침묵하므로 — Verse가 내장 타입을 덮어쓰는 것과
 * 같은 이유로 우리 설명이 이긴다. UE 프로젝트의 C/C++일 때만.
 */
async function ueCppPriorityHover(def: ServerDef, abs: string, pos: LspPos, text?: string): Promise<LspHoverResult | null> {
  if (!isUeCpp(def, abs)) return null
  const doc = ueCppPriorityDoc(await lineAt(abs, pos.line, text), pos.character)
  return doc ? { contents: doc } : null
}

/**
 * 키워드·내장 타입 용어집 폴백 카드 — Verse의 verseKeywordDoc에 해당하는 비-Verse 경로.
 * 언어 서버는 예약어(`if`·`for`…)와 상당수 내장 타입(`int`·`number`…)에 호버를 주지 않으므로,
 * ① LSP 호버가 비어 있을 때와 ② 서버가 아직 준비 전/미설치일 때 이걸로 답한다. UE 프로젝트의
 * C/C++이면 UE 타입(int32·FString…)도 함께 본다. `text`(라이브 버퍼)가 있으면 그걸, 없으면
 * 디스크를 읽는다. 해당 없으면 null.
 */
async function glossaryHover(def: ServerDef, abs: string, pos: LspPos, text?: string): Promise<LspHoverResult | null> {
  const lang = glossaryLangFor(def, abs)
  if (!lang) return null
  const line = await lineAt(abs, pos.line, text)
  if (isUeCpp(def, abs)) {
    const ue = ueCppFallbackDoc(line, pos.character)
    if (ue) return { contents: ue }
  }
  const doc = glossaryLineDoc(lang, line, pos.character)
  return doc ? { contents: doc } : null
}

// 호버 마크다운에 문서 한 단락을 보탠다 — clangd 마크다운은 시그니처 펜스로 "끝나는" 형태라,
// 뒤에 그냥 붙이면 렌더러의 말미 펜스(시그니처) 추출이 깨져 `class X` 코드 박스가 본문에
// 그대로 노출된다. 말미 펜스가 있으면 그 '앞'에 끼워 넣는다.
function appendDocToHover(md: string, doc: string): string {
  const m = /```(\w*)\n[\s\S]*?```\s*$/.exec(md)
  if (m) return md.slice(0, m.index) + doc + '\n\n' + md.slice(m.index)
  return md + '\n\n' + doc
}

// 호버 마크다운에 "본문 문서"(코드 펜스·헤더·메타 줄이 아닌 산문)가 있는지 — 전방 선언만
// 보이는 클래스 카드(이름뿐)를 판별해 UE 타입 설명을 보탤지 정하는 데 쓴다.
function hoverHasProse(md: string): boolean {
  let inFence = false
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const t = line.trim()
    if (!t) continue
    // #include "…" — clangd include-cleaner의 헤더 제안 줄. 문서(산문)가 아니다 —
    // 이걸 산문으로 치면 전방 선언 카드에 UE 타입 설명 폴백이 안 붙는다.
    if (/^(###\s|-{3,}\s*$|provided by\b|#include\b|→|Type:|Value =|Offset:\s*\d|Size:\s*\d|Parameters:\s*$)/.test(t)) continue
    return true
  }
  return false
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
  data?: unknown // 서버의 resolve 핸들(불투명) — completionItem/resolve로 그대로 돌려보낸다
}
// textDocument/completion returns either a bare item array or a CompletionList wrapper
type RawCompletion = RawCompletionItem[] | { items?: RawCompletionItem[]; isIncomplete?: boolean } | null

/** A completion response's raw item array — mapCompletion과 같은 규칙(ri 인덱스 기준). */
function rawItemsOf(r: RawCompletion): RawCompletionItem[] {
  if (!r) return []
  return Array.isArray(r) ? r : Array.isArray(r.items) ? r.items : []
}

/** Normalize a server completion response into our flat list (null when there's nothing usable). */
function mapCompletion(r: RawCompletion): LspCompletionList | null {
  if (!r) return null
  const rawItems = rawItemsOf(r)
  const isIncomplete = Array.isArray(r) ? false : !!r.isIncomplete
  const items: LspCompletionItem[] = []
  for (let i = 0; i < rawItems.length; i++) {
    const it = rawItems[i]
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
      filterText: it.filterText,
      ri: i // 원본 인덱스 — completionItem/resolve(문서 지연 로드)가 이걸로 원본을 되찾는다
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

/**
 * didChange의 contentChanges 페이로드 — incremental(2)을 선언한 서버엔 "이전 문서 전체를 덮는
 * range 교체"로, 그 외(full/미선언)엔 range 없는 전문 교체로 만든다. LSP상 range 없는 교체는
 * 항상 합법이지만 Roslyn은 range를 non-null로 가정해 NullReferenceException으로 '프로세스째'
 * 죽는다 — 서버가 선언한 동기화 방식을 존중하는 게 스펙이기도 하다. (\r\n 문서: split('\n')의
 * 중간 조각에 남는 \r만큼 character가 부풀 수 있지만, 스펙상 줄 길이 초과 position은 줄 끝으로
 * 클램프되므로 "전체 덮기"에는 지장이 없다. 마지막 조각엔 터미네이터가 없어 정확하다.)
 */
function fullChange(syncKind: number, prevText: string, text: string): unknown[] {
  if (syncKind !== 2) return [{ text }] // no range → full-content replace
  const lines = prevText.split('\n')
  return [
    {
      range: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines[lines.length - 1].length } },
      text
    }
  ]
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

  /** notifyWatchedFiles가 서버에 실제로 통지했을 때 부르는 훅 — index.ts가 모든 창으로
   *  브로드캐스트하게 배선한다(IPC.lspFilesChanged). 열린 뷰어의 토큰 재폴링 신호. */
  onFilesChanged: ((e: { paths: string[]; exts: string[] }) => void) | null = null

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
          // openDoc 자체의 실패(stat 불가 등)도 삼킨다 — 바깥 catch는 ready 실패만 잡는다
          if (!s.projectInitPending) void this.openDoc(s, def, abs).catch(() => {})
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
    // UE 프로젝트의 하위 폴더(플러그인 Script 등)를 연 경우, 그 파일들을 담당하는 서버는
    // UE 루트 쪽(<UE루트>/Script의 C# 솔루션 서버 등)에 뜬다 — cwd 접두사 매칭만으로는
    // 배지가 그 서버를 못 보므로 UE 루트 아래 서버도 포함한다.
    const ur = ueRoot(root)
    const urPrefix = ur && path.resolve(ur).toLowerCase() !== root ? path.resolve(ur).toLowerCase() + path.sep : null
    let analyzing = false
    let ready = false
    let percent: number | null = null
    for (const [key, s] of this.servers) {
      const sroot = key.slice(key.indexOf('|') + 1) // key = `${id}|${resolved lowercased root}`
      if (sroot !== root && !sroot.startsWith(prefix) && !(urPrefix && sroot.startsWith(urPrefix))) continue
      if (s.status === 'error') continue
      if (s.status === 'starting' || s.projectInitPending) {
        analyzing = true
        if (s.progressPct != null) percent = s.progressPct
      } else if (s.status === 'ready' && s.progressPct != null) {
        // clangd: initialize는 즉시 끝나지만 백그라운드 인덱싱($/progress)은 한참 이어진다 —
        // 진행률이 흐르는 동안은 '분석 중 N%'로 정직하게 보여 준다 (end가 오면 percent가 걷힌다)
        analyzing = true
        percent = s.progressPct
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
    // Roslyn: 시맨틱 토큰은 frozen(부분) 컴파일로 분류된다 — 아무도 풀 컴파일을 요구하지
    // 않으면 크로스 어셈블리 심볼(IntPtr·참조 타입…)이 영영 'variable'(미해석)로 남아 색이
    // 빠진다. 문서를 연 뒤의 전 솔루션 프라임(workspace/symbol) 한 번이 자기 프로젝트와
    // 형제 ProjectReference 스켈레톤까지 전부 확보한다. (진단 풀(textDocument/diagnostic)로
    // 강제하는 방법은 함정 — 자기 프로젝트만 풀리고, 프라임 '뒤'에 돌리면 형제 스켈레톤을
    // 도로 무효화해 토큰이 다시 미해석으로 떨어진다. 실측으로 확인.)
    if (def?.awaitsProjectInit) await this.primeFullSemantics(ctx.s).catch(() => {})
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
    // UnrealSharp: UE 프로젝트에 관리(C#) 솔루션(<UE루트>/Script/*.slnx|sln)이 있으면 Roslyn도
    // 함께 데운다 — 주력 언어 감지는 cpp라 안 잡히지만, 솔루션 로드는 수 초 걸리므로 첫 .cs를
    // 보기 전에 미리. csRootFor가 같은 Script 폴더를 루트로 고르므로 이 서버가 그대로 재사용된다.
    if (def?.id !== 'cs' && installState('cs') === 'installed') {
      const ur = ueRoot(root)
      const scriptDir = ur ? path.join(ur, 'Script') : null
      let hasSln = false
      try {
        hasSln = !!scriptDir && fs.readdirSync(scriptDir).some((n) => /\.slnx?$/i.test(n))
      } catch {
        /* Script 폴더 없음 — UnrealSharp 미사용 */
      }
      if (scriptDir && hasSln) {
        const cs = SERVERS.find((s) => s.id === 'cs')
        if (cs) void this.ensure(cs, scriptDir)
      }
    }
    // Verse 워크스페이스면 멤버 DB(digest/소스 파스)도 지금 데워 둔다 — 안 그러면 첫 완성/
    // 레지스트리 요청이 동기 파싱을 통째로 물어 수백 ms 걸릴 수 있다. verse-lsp exe가 없어도
    // 색칠 레지스트리는 이 DB에서 나오므로 폴더 구조만 보이면 데운다. setTimeout(0)으로 프로젝트
    // 열기 직후의 바쁜 프레임(파일 트리·프리워밍 IPC)을 피해 다음 틱으로 미룬다.
    if (def?.id === 'verse' || verseWorkspaceFolders(root)) {
      setTimeout(() => {
        try {
          verseMemberDbRegistry(root)
        } catch {
          /* 예열 실패는 무해 — 첫 요청이 다시 만든다 */
        }
      }, 0)
    }
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
    // UEFN 크리에이티브 프로젝트(.uefnproject, .uproject 없음)의 주력 언어는 Verse
    else if (has(/\.uefnproject$/)) id = 'verse'
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
    clearVerseMemberCache() // 서버 재구성 — 파스 캐시도 처음부터
    await killHolders('verse') // orphans from a force-killed run still hold the exe
    await new Promise((r) => setTimeout(r, 300)) // let the OS release the handle
    return setVerseExe(srcPath)
  }

  /** Forget the configured Verse server (stop it, delete the prepared exe + config). */
  async clearVersePath(): Promise<void> {
    this.stopServers('verse')
    clearVerseMemberCache()
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
    // UE C++ 매크로(UPROPERTY…)·매크로 괄호 안 지정자(EditAnywhere…)는 LSP보다 먼저 —
    // clangd의 매크로 전개 카드는 무의미하고 지정자엔 아예 침묵한다 (설치 여부와도 무관).
    const uePrio = await ueCppPriorityHover(def, abs, pos, text)
    if (uePrio) return uePrio
    // 예약어도 LSP보다 먼저 — clangd/Roslyn은 키워드 위치에서 무의미한 카드(override)나
    // 감싸는 함수의 카드(virtual)를 돌려줘, 폴백 순서로는 키워드 설명이 나오지 않는다.
    // 예약어는 사용자 식별자가 될 수 없으므로 심볼 호버를 가리지 않는다 (Verse와 동일 규칙;
    // 문맥 키워드와 auto·this 같은 "LSP가 더 잘 아는" 키워드는 shared 쪽에서 제외돼 있다).
    if (def.id !== 'verse') {
      const lang = glossaryLangFor(def, abs)
      if (lang) {
        const line = await lineAt(abs, pos.line, text)
        const kw = keywordPriorityDoc(lang, line, pos.character)
        if (kw) return { contents: kw }
        // C# 세터의 암시적 `value` — Roslyn 카드는 평범한 매개변수(+널 분석 소음)라 정체를
        // 설명하지 못한다. set/init 접근자 본문 안의 `value`(멤버 접근 `x.value` 제외)로
        // 확인될 때만 용어집이 먼저 답한다 — 접근자 밖의 진짜 value 심볼은 안 가린다.
        if (lang === 'csharp') {
          // `?`·`??`·`??=`·`?.` — 기호는 wordAt이 못 잡고 사용자 식별자도 될 수 없으므로
          // 위치로 판별해 LSP보다 먼저 설명한다 (Verse의 `?` 옵션 연산자 처리와 동일 규칙)
          const sym = csSymbolDoc(line, pos.character)
          if (sym) return { contents: sym }
          const w = glossaryWordAt(line, pos.character)
          if (w?.word === 'value' && line[w.start - 1] !== '.') {
            try {
              const full = text != null ? text : await fsp.readFile(abs, 'utf8')
              const ls = full.split('\n')
              if (pos.line < ls.length) {
                let off = 0
                for (let i = 0; i < pos.line; i++) off += ls[i].length + 1
                off += Math.min(pos.character, ls[pos.line].length)
                if (csInSetAccessor(full, off)) {
                  const doc = glossaryDoc('csharp', 'value')
                  if (doc) return { contents: doc }
                }
              }
            } catch {
              /* 읽기 실패 — 평소 경로(LSP)로 계속 */
            }
          }
        }
      }
    }
    // 미설치 서버(C#/C++ 다운로드 전)도 키워드·내장 타입 용어집 호버는 동작한다 —
    // Verse가 서버 없이 합성 카드를 내는 것과 같은 "콜드 경로".
    if (def.kind === 'download' && installState(def.id) !== 'installed') return glossaryHover(def, abs, pos, text)
    if (def.kind === 'external' && !def.command('')) return null
    const root = def.rootFor?.(abs, cwd) ?? cwd
    const s = this.ensure(def, root)
    let ready = false
    if (s) {
      try {
        await s.ready
        ready = true
      } catch {
        /* verse는 아래 로컬 합성 체인으로 계속 — 다른 서버는 용어집 폴백으로 */
      }
    }
    // 서버 준비 전(인덱싱/에러) — Verse는 아래 합성 체인이 답하고, 그 외 언어는 심볼 호버는
    // 못 줘도 키워드/내장 타입 용어집으로는 답한다(호버 공백 최소화).
    if (!ready && def.id !== 'verse') return glossaryHover(def, abs, pos, text)
    // live buffer → didChange (reflects unsaved edits); no buffer → the disk-synced doc
    const uri = !ready ? '' : text != null ? this.syncBuffer(s!, def, abs, text) : await this.openDoc(s!, def, abs)
    // 타임아웃 60초 — clangd가 UE TU를 콜드 파싱하는 동안 hover는 파싱이 끝날 때까지
    // 큐에 있다가 응답한다. 기본 15초로는 첫 몇 분간 호버가 전부 타임아웃돼 "파일을 껐다
    // 켜야 뜨는" 것처럼 보였다. 늦게 온 응답은 렌더러(hoverSeq/CM)가 낡은 것을 버린다.
    // 실패(타임아웃·서버 사망)는 throw하지 않고 빈 응답으로 — 안 그러면 아래 용어집 폴백
    // (예: C# `partial` 같은 문맥 키워드)까지 못 가고 호버가 통째로 침묵한다.
    const r = ready
      ? await s!.rpc
          .request<{ contents?: unknown } | null>('textDocument/hover', { textDocument: { uri }, position: pos }, 60000)
          .catch(() => null)
      : null
    let contents = hoverMarkdown(r?.contents)
    // C# this/base — Roslyn 카드는 가리키는 타입만 보여준다(유용). 여기에 키워드 설명 한 줄을
    // 보태 "공식 문법 설명이 항상 보이게" 한다(사용자 피드백). LSP가 침묵하면 맨 아래
    // 용어집 폴백이 키워드 카드로 답하므로 어느 쪽이든 설명은 나온다.
    if (contents && glossaryLangFor(def, abs) === 'csharp') {
      const w = glossaryWordAt(await lineAt(abs, pos.line, text), pos.character)?.word
      if (w === 'this' || w === 'base') {
        const doc = glossaryDoc('csharp', w)
        if (doc) contents = appendDocToHover(contents, doc)
      }
    }
    // UE C++: clangd 호버에 실려 온 엔진 공식 주석(영어)을 문단 해시로 번역 팩에서 찾아
    // 한국어로 바꾼다 — Verse 공식 문서 번역과 같은 구조 (설정에서 끄면 no-op).
    if (contents && isUeCpp(def, abs)) {
      contents = translateUeHover(contents)
      // 문서 없는 카드(전방 선언만 보이는 콜드/미해석 상태의 `class UCameraComponent` 등)에는
      // 우리 UE 타입 설명 한 줄을 보태 준다 — clangd가 나중에 진짜 주석을 실어 오면 그때는
      // 위 번역 팩이 답하므로 중복되지 않는다.
      if (!hoverHasProse(contents)) {
        const extra = ueCppFallbackDoc(await lineAt(abs, pos.line, text), pos.character)
        if (extra) contents = appendDocToHover(contents, extra)
      }
    }
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
        // contents가 있다는 것 = 서버 응답이 있었다는 것(ready) — s는 비-null
        const { doc, kind } = await this.verseDefInfo(s!.rpc, uri, pos, root, abs, text).catch(() => ({ doc: '', kind: null }))
        const body = kind ? injectVerseKind(contents, kind) : contents
        return { contents: doc ? body + '\n\n' + doc : body }
      }
      // 4) 호버가 아예 없으면 선언부 — 그 줄에서 카드를 합성한다(+ 그 위 문서 주석; <override>
      //    선언이라 자기 주석이 없으면 supers 체인의 베이스(공식) doc — 번역 포함 — 로 폴백).
      const declSig = await verseDeclHover(abs, pos.line, pos.character, text, (t, m) =>
        verseMemberDoc(root, text ?? '', t, m)
      ).catch(() => null)
      if (declSig) return { contents: declSig }
    }
    if (contents) return { contents }
    // LSP가 침묵한 위치 — 키워드/내장 타입이면 용어집으로 답한다(같은 이름의 진짜 심볼은
    // 위에서 서버 호버가 먼저 잡으므로 여기 오지 않는다). 그 외엔 정말로 호버 없음.
    return glossaryHover(def, abs, pos, text)
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
    root: string,
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
      // 사용처 호버의 definition이 <override> 선언(자기 주석 없음)에 떨어지면 supers 체인의
      // 베이스(공식) doc — 번역 포함 — 로 폴백. verseMemberDoc의 라이브 파스에는 정의 대상
      // 파일의 텍스트를 준다(감싸는 타입·supers가 그 파일에 있다).
      let doc = await verseDocAt(file, line, live)
      if (!doc) doc = verseOverrideDoc(lines, line, (t, m) => verseMemberDoc(root, lines.join('\n'), t, m))
      return { doc, kind: km ? km[1] : null }
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
    const root = def.rootFor?.(abs, cwd) ?? cwd
    const s = this.ensure(def, root)
    if (!s) return []
    try {
      await s.ready
    } catch {
      return []
    }
    const uri = text != null ? this.syncBuffer(s, def, abs, text) : await this.openDoc(s, def, abs)
    const r = await s.rpc
      .request<RawLocation | RawLocation[] | null>('textDocument/definition', {
        textDocument: { uri },
        position: pos
      })
      .catch(() => null)
    const list = Array.isArray(r) ? r : r ? [r] : []
    const out: LspLocation[] = []
    for (const loc of list) {
      const uri = loc.uri ?? loc.targetUri
      const range = loc.range ?? loc.targetSelectionRange ?? loc.targetRange
      const start = range?.start
      if (!uri || !uri.startsWith('file:') || typeof start?.line !== 'number') continue
      try {
        const p = fileURLToPath(uri)
        // Roslyn이 %TEMP%에 떨궈 준 MetadataAsSource(디컴파일/PDB 소스) — 이 파일의 주인은
        // 지금 이 서버다. 뷰어가 열 때 같은 서버로 라우팅되도록 기억해 둔다(csRootFor 참조).
        if (META_AS_SOURCE_RE.test(p)) {
          metadataAsSourceRoot.set(path.resolve(p).toLowerCase(), path.resolve(root))
          metaFilesSeen.set(path.resolve(p).toLowerCase(), p) // 컨테이너 경유 복구용 원본 경로
        }
        out.push({ path: p, line: start.line, character: start.character ?? 0 })
      } catch {
        /* unparseable uri — skip */
      }
    }
    // MetadataAsSource 재요청 우회 캐시 (위 metaDefCache 주석 참조): 첫 성공은 저장하고,
    // 빈 응답은 같은 단어의 캐시(대상 파일이 아직 디스크에 있을 때만)로 되살린다.
    if (def.id === 'cs') {
      const word = glossaryWordAt(await lineAt(abs, pos.line, text), pos.character)?.word
      if (word) {
        const cacheKey = path.resolve(abs).toLowerCase() + '|' + word
        // 캐시 저장 조건: 대상이 임시 파일이거나, 소스 자체가 임시 파일(읽기 전용·불변이라
        // 어떤 성공이든 안전)일 때. UObject처럼 대상은 실소스여도 partial의 생성 파트가 얽혀
        // 재요청부터 0개가 되는 케이스(실측)를 후자가 덮는다.
        if (out.length && (out.some((o) => META_AS_SOURCE_RE.test(o.path)) || META_AS_SOURCE_RE.test(abs))) {
          if (metaDefCache.size >= META_DEF_CACHE_CAP) {
            const oldest = metaDefCache.keys().next().value
            if (oldest) metaDefCache.delete(oldest)
          }
          metaDefCache.set(cacheKey, out.map((o) => ({ ...o })))
        } else if (!out.length) {
          const cached = metaDefCache.get(cacheKey)
          if (cached && cached.every((c) => fs.existsSync(c.path))) {
            out.push(...cached.map((c) => ({ ...c })))
          } else {
            // 캐시에도 없는 첫 0개 — 같은 생성 파일의 "다른 멤버" 케이스(1회용이 파일 단위).
            // 호버의 컨테이너 타입으로 이미 생성된 임시 파일에서 선언을 찾아 복구하고 캐시한다.
            const rec = await recoverMetaDef(s.rpc, uri, pos, word, abs).catch(() => null)
            if (rec) {
              out.push(rec)
              metaDefCache.set(cacheKey, [{ ...rec }])
            }
          }
        }
      }
    }
    // F12 대상이 임시 메타 파일이면 지금 바로 서버에 didOpen(선워밍) — 뷰어가 파일을 여는
    // 시점보다 먼저 파싱을 시작시켜, "들어갔는데 몇 초간 호버·색이 안 나오는" 공백을 줄인다.
    // 이어서 도착 지점 심볼에 호버(QuickInfo)도 한 번 쏴 둔다(응답은 버림) — 토큰은 frozen
    // 계산이라 색이 먼저 들어오는데 호버는 풀 시맨틱이 필요해 몇 초 늦었고, 그 사이 "분석 중"
    // 칩은 이미 사라져 거짓 신호가 됐다. 여기서 흡수하면 색과 호버가 거의 같이 준비된다.
    for (const o of out) {
      if (!META_AS_SOURCE_RE.test(o.path)) continue
      void (async () => {
        await this.openDoc(s, def, o.path).catch(() => {})
        await s.rpc
          .request(
            'textDocument/hover',
            { textDocument: { uri: pathToFileURL(o.path).href }, position: { line: o.line, character: o.character + 1 } },
            30000
          )
          .catch(() => {})
      })()
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
    let ready = false
    if (s) {
      try {
        await s.ready
        ready = true
      } catch {
        /* verse는 아래 스캔-전용 분기로 계속 */
      }
    }
    // Verse 콜드/에러 구간 — 서버 없이도 스캔 기반 후보(리시버 멤버·스코프)를 즉시 준다.
    // isIncomplete=true 라 렌더러가 입력마다 다시 물어, 서버가 준비되는 순간 자연히 합쳐진다.
    if (!ready && def.id === 'verse') {
      const mctx = verseMemberContext(text, pos)
      if (mctx) {
        const type = verseHasType(root, text, mctx.receiver)
          ? mctx.receiver
          : verseResolveTypeRegex(root, text, mctx.receiver, pos.line)
        if (type) {
          const members = verseTypeMembers(root, text, type, mctx.receiver === 'Self')
          if (members.length) return { items: members, isIncomplete: true }
        }
        return null
      }
      if (verseDotContext(text, pos)) return null // 미해석 리시버의 `.` 뒤 — 스코프 주입 금지
      const scope = verseScopeCompletions(root, text, pos)
      if (verseIsTypePosition(text, pos)) {
        const typeScope = [...verseBuiltinTypeItems(), ...scope.filter((it) => TYPE_KINDS.has(it.kind ?? -1))]
        return mergeVerseTypes(typeScope, null, verseMemberDbRegistry(root))
      }
      return mergeVerseScope(scope, null, verseExtMethods(root))
    }
    if (!ready || !s) return null
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
      // `.` 뒤인데 리시버가 식별자가 아닌 경우(`Foo().`, `arr[0].`, 복합 체인) — verseMemberContext가
      // 못 잡아 아래 identifier 분기로 흘러 지역/전역이 점 뒤에 제안되던 노이즈를 막는다. 위의
      // 미해석 리시버 분기와 동일하게 verse-lsp 원본만 돌려준다(스코프 주입 없음).
      if (verseDotContext(text, pos)) return mapCompletion(r)
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
    const list = mapCompletion(r)
    // 서버가 resolve를 지원하면 원본 아이템(불투명 data 포함)을 세대와 함께 보관 — 렌더러가
    // 후보를 하이라이트할 때 completion-resolve IPC로 문서를 지연 로드한다(tsserver/pyright/Roslyn
    // 은 목록엔 문서를 안 싣고 resolve로만 준다 — 이게 없으면 다른 언어의 완성 문서가 영영 빈다).
    if (list && s.complResolve) {
      s.complRaw = { gen: ++s.complGen, items: rawItemsOf(r) }
      list.gen = s.complRaw.gen
    }
    return list
  }

  /**
   * 완성 후보의 문서 지연 로드 — completion()이 보관해 둔 원본 아이템(gen 세대의 ri번째)을
   * completionItem/resolve로 돌려보내 detail/documentation을 받아 온다. 세대가 다르면(그 사이
   * 새 완성 목록이 왔으면) 낡은 요청이므로 null. 서버가 resolve를 지원하지 않아도 null.
   */
  async resolveCompletion(
    cwd: string,
    relPath: string,
    gen: number,
    ri: number
  ): Promise<{ detail?: string; documentation?: string } | null> {
    const abs = this.resolve(cwd, relPath)
    const def = abs ? serverDefFor(abs) : null
    if (!abs || !def) return null
    if (def.kind === 'download' && installState(def.id) !== 'installed') return null
    if (def.kind === 'external' && !def.command('')) return null
    const s = this.ensure(def, def.rootFor?.(abs, cwd) ?? cwd)
    if (!s || !s.complResolve || !s.complRaw || s.complRaw.gen !== gen) return null
    const raw = s.complRaw.items[ri]
    if (!raw) return null
    try {
      await s.ready
    } catch {
      return null
    }
    const r = await s.rpc.request<RawCompletionItem | null>('completionItem/resolve', raw, 10000).catch(() => null)
    if (!r) return null
    const doc = typeof r.documentation === 'string' ? r.documentation : r.documentation?.value
    if (!doc && !r.detail) return null
    return { detail: typeof r.detail === 'string' ? r.detail : undefined, documentation: doc || undefined }
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

  /**
   * Accurate Verse type registry for a file's project (for the renderer's semantic colouring),
   * 세대(rev) 스냅샷으로. 렌더러가 마지막으로 받은 `knownRev`를 보내면, 그 사이 무효화(UEFN
   * 재빌드·저장·문서 언어 토글)가 없었을 때 `reg: null`(변화 없음)만 돌려줘 큰 페이로드
   * 직렬화를 건너뛴다. null = Verse 파일/프로젝트가 아님(렌더러는 마크 없이 다음에 재시도).
   */
  verseRegistry(cwd: string, relPath: string, knownRev?: number): { rev: number; reg: VerseRegistry | null } | null {
    const abs = this.resolve(cwd, relPath)
    if (!abs || serverDefFor(abs)?.id !== 'verse') return null
    const root = verseProjectRoot(abs) ?? cwd
    if (!root) return null
    const rev = verseRegistryRev()
    if (knownRev === rev) return { rev, reg: null } // unchanged — 렌더러가 이미 들고 있다
    return { rev, reg: verseMemberDbRegistry(root) }
  }

  /**
   * 파일이 앱 안에서 저장됐다는 알림(IPC.writeFile 뒤) — 서버들에 디스크 변화를 통지하고
   * (열린 문서는 didChange가 진실이라 무해), Verse 파일이면 그 프로젝트의 멤버 DB 캐시를
   * 무효화해 새로 선언한 타입/멤버가 다른 파일의 완성·색칠에도 나타나게 한다. verse-lsp
   * 자체는 didChange로 이미 최신이므로 서버는 건드리지 않는다.
   */
  fileWritten(cwd: string, relPath: string): void {
    const abs = this.resolve(cwd, relPath)
    if (!abs) return
    this.notifyWatchedFiles([{ abs, kind: 'changed' }])
    if (serverDefFor(abs)?.id !== 'verse') return
    invalidateVerseMemberCache(verseProjectRoot(abs) ?? cwd)
  }

  /**
   * 디스크 파일 변화(생성/수정/삭제)를 살아있는 서버들에 workspace/didChangeWatchedFiles로
   * 알린다 — 앱이 스스로 아는 변화(에이전트 Write/Edit, 내장 에디터 저장, 탐색기 파일 작업)만.
   * Roslyn은 이 '통지 자체'에는 기대지 않는다: 우리가 워칭 능력을 선언하지 않아 자체 폴백
   * 워처가 돌고(initialize 능력 주석 참조), 솔루션 멤버십 구멍은 watchCsSolution이 맡는다.
   * 통지는 클라이언트 워칭에 기대는 서버들(pyright류)을 위한 최선 노력이고, 관심 없는 서버는
   * 조용히 무시하므로 무해하다. 단 C#은 여기서 두 가지를 '함께' 한다:
   *  ① 프라임 캐시 무효화 — frozen 토큰은 마지막 프라임 시점의 컴파일로 분류하므로, 그 뒤에
   *     생긴/바뀐 파일의 타입은 재프라임 전까지 열린 문서들에서 영영 무색이다(실측 재현).
   *  ② onFilesChanged 브로드캐스트 — 열려 있는 뷰어의 멈춘 토큰 폴링을 깨워, 재프라임 뒤의
   *     좋아진 토큰을 실제로 받아 가게 한다(재열람 없이도 색 회복).
   *
   * 서버 root 포함 여부로 거르지 않는다: C#의 root(sln 폴더)가 cwd 밖 형제 프로젝트의 파일
   * (UnrealSharp 플러그인 Script)을 경로상 '포함'하지 않는 배치가 실제로 있다. 대신 그 서버가
   * 관심 가질 확장자(def.exts + C#은 프로젝트/솔루션 파일)만 골라 보낸다.
   */
  notifyWatchedFiles(changes: { abs: string; kind: 'created' | 'changed' | 'deleted' }[]): void {
    if (!changes.length) return
    const TYPE = { created: 1, changed: 2, deleted: 3 } as const
    // C#은 소스 외에 프로젝트/솔루션 파일 변화도 프로젝트 시스템 갱신 대상
    const CS_EXTRA = new Set(['csproj', 'sln', 'slnx', 'props', 'targets'])
    const notified = new Map<string, string>() // 소문자 키 → 원본 절대 경로 (브로드캐스트용 중복 제거)
    for (const [key, s] of this.servers) {
      if (s.status !== 'ready') continue // 초기화 전 서버는 스킵 — 로드 시점 글롭 평가가 커버
      const def = SERVERS.find((d) => d.id === key.slice(0, key.indexOf('|')))
      if (!def) continue
      const wanted = changes.filter((c) => {
        const ext = path.extname(c.abs).slice(1).toLowerCase()
        return ext in def.exts || (def.id === 'cs' && CS_EXTRA.has(ext))
      })
      if (!wanted.length) continue
      // C#(Roslyn): 다음 semanticTokens 요청이 재프라임하도록 예약 — primeDirtyAt이 재프라임의
      // "조용한 간격" 기준점이 된다(폴백 워처의 새 파일 편입이 끝난 뒤 컴파일 확정, 실측).
      if (def.awaitsProjectInit) {
        s.primeDirtyAt = Date.now()
        s.wsSymPrime = undefined
      }
      for (const c of wanted) {
        const abs = path.resolve(c.abs)
        notified.set(abs.toLowerCase(), abs)
      }
      s.rpc.notify('workspace/didChangeWatchedFiles', {
        changes: wanted.map((c) => ({ uri: pathToFileURL(path.resolve(c.abs)).href, type: TYPE[c.kind] }))
      })
    }
    // 어느 서버든 실제로 통지받았을 때만 뷰어를 깨운다 — 서버가 없으면 갱신할 토큰도 없다
    if (notified.size && this.onFilesChanged) {
      const paths = [...notified.values()]
      const exts = new Set<string>()
      for (const p of paths) {
        const e = path.extname(p).slice(1).toLowerCase()
        exts.add(e)
        // 프로젝트/솔루션 파일 변화도 .cs 뷰어가 다시 칠할 사유다(멤버십/참조 변화)
        if (e === 'cs' || e === 'csx' || CS_EXTRA.has(e)) {
          exts.add('cs')
          exts.add('csx')
        }
      }
      this.onFilesChanged({ paths, exts: [...exts] })
    }
  }

  /** Kill every server (app quit). */
  disposeAll(): void {
    for (const s of this.servers.values()) {
      s.slnWatch?.close()
      s.dirWatch?.close()
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
        // 우리 멤버 DB(완성 멤버·레지스트리)도 같은 digest를 파싱해 캐시하므로 함께 무효화한다 —
        // 서버만 재시작하고 DB를 남기면 새 API가 완성/색칠에 영영 안 나타난다.
        invalidateVerseMemberCache(rRoot)
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
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch {
      return null
    }
    // stderr 꼬리만 보관 — 서버가 죽으면 사인(예: Roslyn의 unhandled exception 덤프)을 남긴다.
    // 파이프를 안 읽으면 버퍼가 차 서버가 멈출 수 있으므로 항상 소비하고 버린다(clangd는
    // 평상시 로그도 stderr로 쏟는다 — 꼬리 4KB만 유지).
    let errTail = ''
    child.stderr?.on('data', (d: Buffer) => {
      errTail = (errTail + d.toString('utf8')).slice(-4096)
    })
    child.stderr?.on('error', () => {})

    const rpc = new StdioRpc(child)
    rpc.onRequest = (method, params) => {
      // answer the handful of server→client requests tsserver-ls actually sends;
      // an unanswered request can stall the server's queue
      if (method === 'workspace/configuration') {
        const items = (params as { items?: unknown[] } | undefined)?.items
        return Array.isArray(items) ? items.map(() => null) : []
      }
      if (method === 'workspace/applyEdit') return { applied: false }
      // 진행률 토큰 생성 요청 수락 — 이후 $/progress(백그라운드 인덱싱 %)가 흘러온다
      if (method === 'window/workDoneProgress/create') return null
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
      complResolve: false,
      syncKind: 1,
      complRaw: null,
      complGen: 0,
      projectInitPending: !!def.awaitsProjectInit,
      progressPct: null,
      primeDirtyAt: 0
    }
    // Roslyn signals the full index is ready with this notification — flip the gate so
    // status() reports 'ready' and the viewer asks for (now complete) semantic tokens.
    // $/progress feeds the explorer's analysis percentage during indexing.
    rpc.onNotify = (method, params) => {
      if (method === 'workspace/projectInitializationComplete') {
        handle.projectInitPending = false
        handle.progressPct = null
        // 주의: 전 솔루션 시맨틱 프라임(primeFullSemantics)을 여기서 선제 실행하면 안 된다 —
        // 문서가 하나도 열리기 '전'의 프라임은 효과가 없다(실측: prime→didOpen 순서면 토큰이
        // 계속 미해석). semanticTokens가 문서를 연 뒤 첫 요청에서 프라임한다.
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
          completionProvider?: { triggerCharacters?: string[]; resolveProvider?: boolean }
          textDocumentSync?: number | { change?: number }
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
              // their snippet/markdown-doc formats) light up — Verse's verse-lsp included.
              // resolveSupport: tsserver/pyright/Roslyn은 문서·detail을 resolve로 지연 제공한다.
              completion: {
                completionItem: {
                  snippetSupport: true,
                  documentationFormat: ['markdown', 'plaintext'],
                  resolveSupport: { properties: ['documentation', 'detail'] }
                }
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
            // workspace.didChangeWatchedFiles는 '일부러' 선언하지 않는다 — 선언하면 Roslyn이
            // 자체 폴백 파일 워처를 끄고 워칭을 전적으로 클라이언트에 맡기는데(실측), 우리는
            // 외부 변화(빌드 산출물·다른 에디터·git)까지 다 챙겨 줄 수 없다. 미선언이면 Roslyn이
            // 로드된 프로젝트 폴더를 스스로 감시해 새 파일을 수 초 안에 편입한다(실측). 남는
            // 구멍은 둘: '솔루션 멤버십 변화'(slnx 재생성)는 watchCsSolution이, '편입돼도 frozen
            // 토큰엔 재프라임 전까지 안 들어오는 것'은 notifyWatchedFiles의 재프라임 예약이 메운다.
            workspace: { workspaceFolders: true },
          // 진행률 알림 수신 — 이걸 선언해야 clangd가 백그라운드 인덱싱 $/progress를 보낸다
          // (Roslyn은 선언 없이도 보냈지만 clangd는 능력 선언에 gate 되어 있다)
          window: { workDoneProgress: true }
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
        handle.complResolve = !!cp?.resolveProvider
        // 서버의 문서 동기화 방식(1=full·2=incremental) — didChange 페이로드 형태를 가른다
        const sync = res?.capabilities?.textDocumentSync
        handle.syncKind = (typeof sync === 'number' ? sync : sync?.change) ?? 1
        rpc.notify('initialized', {})
        const opened = def.afterInitialized?.(rpc, path.resolve(root))
        // 열 것이 아예 없던 루트(낱파일 폴백 등) — projectInitializationComplete를 기다릴
        // 로드가 없다: 게이트를 바로 내려 misc 문서의 기본 색·호버가 즉시 나가게 한다
        if (opened === false) handle.projectInitPending = false
        handle.status = 'ready'
        if (def.id === 'cs') {
          this.watchCsSolution(handle, path.resolve(root))
          this.watchCsRoot(handle, path.resolve(root))
        }
      })
    handle.ready.catch(() => {
      handle.status = 'error'
      handle.diedAt = Date.now()
      handle.slnWatch?.close()
      handle.dirWatch?.close()
      // a server that failed/hung initialize would linger forever — take it down
      // so the cooldown respawn starts from a clean slate
      killTree(child)
      rpc.dispose('초기화 실패')
    })
    child.on('error', () => {
      handle.status = 'error'
      handle.diedAt = Date.now()
      handle.slnWatch?.close()
      handle.dirWatch?.close()
      rpc.dispose('LSP 서버 실행 실패')
    })
    child.on('exit', (code) => {
      // 비정상 종료는 stderr 꼬리와 함께 남긴다 — "왜 죽었는지"가 어디에도 안 남던 문제
      if (code !== 0 && code != null) {
        console.error(`[lsp] ${def.id} 서버 비정상 종료 (code=${code})${errTail.trim() ? '\n' + errTail.trim().slice(-2000) : ''}`)
      }
      handle.status = 'error'
      handle.diedAt = Date.now()
      handle.docs.clear()
      handle.slnWatch?.close()
      handle.dirWatch?.close()
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

  /**
   * C# 서버가 로드한 솔루션 파일(.sln/.slnx)을 감시하다가 바뀌면 solution/open을 재통지한다.
   *
   * 왜: Roslyn은 솔루션 '멤버십'을 로드 시점에 한 번만 읽는다. UnrealSharp는 플러그인을
   * 만들면 솔루션을 재생성해 새 csproj 참조를 더하는데, 이미 떠 있는 서버는 그걸 모른 채
   * 새 프로젝트의 모든 .cs를 떠돌이(misc) 문서로 취급한다 — BCL만 색이 붙고 UnrealSharp/
   * 프로젝트 심볼은 무색(실측 재현). 같은 경로로 solution/open을 다시 보내면 수 초 안에
   * 새 프로젝트가 로드되고, '이미 열려 있던' misc 문서까지 그 자리에서 회복된다(실측) —
   * 서버 재시작(수 분짜리 재인덱싱)이 필요 없다.
   *
   * 로드된 프로젝트 '안'의 새 파일은 이 감시가 필요 없다: didChangeWatchedFiles를 선언하지
   * 않은 클라이언트에겐 Roslyn이 자체 폴백 워처를 돌려 수 초 안에 스스로 편입한다(실측).
   * 파일을 직접 감시하지 않고 폴더를 감시해 이름으로 거른다 — 재생성(삭제+생성/교체)이
   * 파일 핸들 워치를 끊는 Windows 특성 회피.
   */
  private watchCsSolution(s: ServerHandle, root: string): void {
    const sln = csSolutionByRoot.get(root.toLowerCase()) ?? null
    if (!sln) return // csproj 단독 로드 — 감시할 솔루션이 없다
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      const name = path.basename(sln).toLowerCase()
      s.slnWatch = fs.watch(path.dirname(sln), (_ev, fn) => {
        if (!fn || String(fn).toLowerCase() !== name) return
        // 재생성은 이벤트가 여러 번 튄다(쓰기·교체) — 마지막 이벤트 후 2초 조용해지면 1회 재통지
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          if (s.status !== 'ready') return
          try {
            if (!fs.existsSync(sln)) return // 삭제-후-재생성 중간이면 다음 생성 이벤트가 다시 재운다
          } catch {
            return
          }
          s.rpc.notify('solution/open', { solution: pathToFileURL(sln).href })
          // 새로 로드될 프로젝트는 프라임된 적이 없다 — 재프라임을 예약하고 열린 C# 뷰어를
          // 깨워, 새 프로젝트의 심볼이 재열람 없이 색에 반영되게 한다. (재프라임의
          // workspace/symbol은 서버 쪽에서 솔루션 로드 완료를 기다렸다 답하므로 순서 안전)
          s.primeDirtyAt = Date.now()
          s.wsSymPrime = undefined
          this.onFilesChanged?.({ paths: [], exts: ['cs', 'csx'] })
        }, 2000)
      })
      // 폴더 삭제 등으로 워처가 에러를 내면 조용히 끝낸다 — 'error' 이벤트를 안 받으면
      // 프로세스째 uncaughtException으로 죽는다
      s.slnWatch.on('error', () => {})
    } catch {
      /* 감시 실패(권한 등) — 없던 기능이니 조용히 포기, 색칠은 재시작 시 회복 */
    }
  }

  /**
   * C# 서버 루트의 재귀 파일 워처 — 앱을 '거치지 않은' 디스크 변화(에이전트의 Bash 명령,
   * 외부 도구의 코드 재생성, 외부 에디터, git 체크아웃)를 notifyWatchedFiles로 흘린다.
   *
   * 왜: 앱 경유 변화(Write/Edit·에디터 저장·탐색기 작업)는 각자 통지하지만, 그 밖의 변화는
   * Roslyn이 폴백 워처로 프로젝트 '편입'까지는 스스로 해도 ① frozen 토큰 재프라임 예약과
   * ② 열린 뷰어의 재폴링 깨우기는 앱 쪽 신호가 없으면 영영 안 일어난다 — 새로 생긴 파일의
   * 타입이 열린 C# 문서들에서 재열람 전까지 무색으로 고착된다(notifyWatchedFiles 주석의
   * ①②가 정확히 이 신호다). 이벤트는 1초 조용해질 때까지 모아 한 번에 통지한다(빌드 폭풍
   * 대비 — 배치 상한 400개, 초과분은 버려도 재프라임 예약엔 지장 없다). 앱 경유 변화와의
   * 중복 통지는 무해: 재프라임 예약은 시각 갱신일 뿐이고 서버 통지는 Roslyn이 무시한다.
   */
  private watchCsRoot(s: ServerHandle, root: string): void {
    const WATCH_EXTS = new Set(['cs', 'csx', 'csproj', 'sln', 'slnx', 'props', 'targets'])
    const pending = new Map<string, string>() // 소문자 경로 → 원본 절대 경로
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      s.dirWatch = fs.watch(root, { recursive: true }, (_ev, fn) => {
        if (!fn) return
        const ext = path.extname(String(fn)).slice(1).toLowerCase()
        if (!WATCH_EXTS.has(ext)) return
        const abs = path.join(root, String(fn))
        if (pending.size < 400) pending.set(abs.toLowerCase(), abs)
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          const batch = [...pending.values()]
          pending.clear()
          const changes = batch.map((p) => {
            let kind: 'changed' | 'deleted' = 'changed'
            try {
              if (!fs.existsSync(p)) kind = 'deleted'
            } catch {
              /* 판정 불가 — changed로 (프라임 예약엔 종류가 중요하지 않다) */
            }
            return { abs: p, kind }
          })
          this.notifyWatchedFiles(changes)
        }, 1000)
      })
      // 루트 폴더 삭제 등으로 워처가 에러를 내면 조용히 끝낸다 — 'error' 이벤트를 안 받으면
      // 프로세스째 uncaughtException으로 죽는다
      s.dirWatch.on('error', () => {})
    } catch {
      /* 재귀 감시 실패(네트워크 드라이브 등) — 앱 경유 변화 통지만으로 동작(기존과 동일) */
    }
  }

  /**
   * Roslyn 전 솔루션 시맨틱 프라임 — workspace/symbol 검색 한 번이 모든 프로젝트의 컴파일
   * (형제 ProjectReference 스켈레톤 포함)을 강제한다. 이게 없으면 frozen 토큰 모델이
   * 크로스 프로젝트 심볼을 영영 'variable'(무색)로 분류한다(진단은 정상이라 더 헷갈린다).
   * 쿼리 문자열은 무엇이든 전체 인덱스 빌드를 유발한다 — 히트 0짜리 이상한 쿼리로 페이로드만
   * 아낀다. 실패하면 프라임을 비워 다음 기회에 재시도한다.
   * 반드시 문서가 하나 이상 didOpen된 '뒤'에 불러야 한다 — 열기 전 프라임은 효과가 없다
   * (실측). 성공한 프라임은 '그 시점까지의' 소스에 유효하다 — 그 뒤 파일이 생기거나 바뀌면
   * notifyWatchedFiles가 캐시를 비워 재프라임을 예약한다(안 하면 새 타입이 영영 무색, 실측).
   * 재프라임은 증분 컴파일이라 값싸다(실측 0초대).
   */
  private primeFullSemantics(s: ServerHandle): Promise<void> {
    if (!s.wsSymPrime) {
      s.wsSymPrime = (async () => {
        // didOpen '직후'(같은 틱)에 쏘면 서버가 문서 열림을 워크스페이스에 반영하기 전
        // 스냅샷을 프라임해 소스 제너레이터 멤버(Bind_*의 CallXxx)가 미해석으로 남는다 —
        // 실측: 갭 0ms=실패, 1.5s=성공. 재프라임은 추가로 "마지막 파일 변화로부터
        // PRIME_REDO_GAP 조용"까지 기다린다(폴백 워처의 새 파일 편입 완료 뒤에 컴파일을
        // 확정해야 하므로 — primeDirtyAt 주석 참조). 기다리는 동안 또 바뀌면 다시 기다린다
        // (에이전트 턴의 연속 편집을 한 번의 프라임으로 합침).
        for (;;) {
          const dirty = s.primeDirtyAt
          const wait = Math.max(1500, dirty ? dirty + PRIME_REDO_GAP - Date.now() : 0)
          await new Promise((r) => setTimeout(r, wait))
          if (s.primeDirtyAt === dirty) break
        }
        const started = Date.now()
        await s.rpc.request('workspace/symbol', { query: 'zz__semantic_prime__' }, 180000)
        // 프라임이 도는 사이 새 변화가 통지됐으면 이 프라임은 이미 낡았다 — 캐시를 비워
        // 다음 토큰 요청이 재프라임하게 한다(뷰어의 폴링이 이어 물어 자연 회복).
        if (s.primeDirtyAt > started) s.wsSymPrime = undefined
      })().catch(() => {
        s.wsSymPrime = undefined
      })
    }
    return s.wsSymPrime
  }

  /** Server ready + document opened/synced — the common front half of every query. */
  private async prep(
    cwd: string,
    relPath: string
  ): Promise<{
    rpc: StdioRpc
    uri: string
    semLegend: { types: string[]; mods: string[] } | null
    s: ServerHandle
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
      return { rpc: s.rpc, uri, semLegend: s.semLegend, s }
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
      s.docs.set(uri, { version: 1, mtimeMs: -1, size: -1, text })
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
      if (cur.text === text) return uri // 서버가 이미 같은 내용을 들고 있다(호버 연타 등) — didChange 생략
      // 엔트리는 교체(제자리 수정 금지) — openDoc의 pre/cur 동일성 검사가 "그 사이 라이브
      // 버퍼가 밀렸음"을 알아채고 디스크 didChange로 되덮는 걸 접게 하는 신호다.
      s.docs.set(uri, { version: cur.version + 1, mtimeMs: -1, size: -1, text })
      s.rpc.notify('textDocument/didChange', {
        textDocument: { uri, version: cur.version + 1 },
        contentChanges: fullChange(s.syncKind, cur.text, text)
      })
    }
    return uri
  }

  /**
   * didOpen the file (or didChange when it changed on disk since — e.g. the agent
   * just edited it), so the server's view always matches what the viewer shows.
   *
   * 레이스 규약: 판정·기록·통지는 모든 await '뒤' 한 틱에 몰아서 한다. 뷰어는 파일 하나에
   * status 폴링·warm·semanticTokens(prep)·hover를 동시에 던지고, 그 openDoc들이 stat/read의
   * await 갭에서 겹치면 둘 다 "안 열림"으로 판정해 didOpen을 두 번 보냈다 — tsserver/clangd는
   * 관용하지만 Roslyn은 unhandled exception으로 '프로세스째' 죽는다(C# 전멸의 근본 원인).
   * docs 엔트리 객체는 제자리 수정 없이 매번 교체하므로, await 전에 집은 엔트리(pre)와 지금
   * 엔트리가 다르면 그 사이 누가 문서를 열었거나 갱신한 것 — 이번 디스크 동기화는 접는다
   * (그쪽이 더 최신이고, 특히 라이브 버퍼를 디스크 내용으로 되돌려선 안 된다).
   */
  private async openDoc(s: ServerHandle, def: ServerDef, abs: string): Promise<string> {
    const uri = pathToFileURL(abs).href
    const pre = s.docs.get(uri)
    const st = await fsp.stat(abs)
    if (pre && pre.mtimeMs === st.mtimeMs && pre.size === st.size) return uri
    const text = await fsp.readFile(abs, 'utf8')
    const cur = s.docs.get(uri)
    if (!cur) {
      s.docs.set(uri, { version: 1, mtimeMs: st.mtimeMs, size: st.size, text })
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
    } else if (cur === pre) {
      if (cur.text === text) {
        // 내용은 그대로인데 mtime만 달라진 경우(라이브 버퍼 마크 -1 → 디스크 재검사 포함) —
        // didChange 없이 동기화 상태만 최신으로 되돌린다
        s.docs.set(uri, { version: cur.version, mtimeMs: st.mtimeMs, size: st.size, text })
        return uri
      }
      s.docs.set(uri, { version: cur.version + 1, mtimeMs: st.mtimeMs, size: st.size, text })
      s.rpc.notify('textDocument/didChange', {
        textDocument: { uri, version: cur.version + 1 },
        contentChanges: fullChange(s.syncKind, cur.text, text)
      })
    }
    return uri
  }
}

export const lspManager = new LspManager()
