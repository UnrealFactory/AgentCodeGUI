import { app } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { writeFileAtomic } from '../atomicWrite'
import type {
  EngineVersionEntry,
  EngineVersionState,
  EngineInstallProgress,
  EngineCleanupResult
} from '@shared/protocol'

// The Claude Code engine ships as this npm package. Selecting a "version" means
// installing that package version into our own home folder and loading it from
// there — the system / user-installed claude is never touched.
const PACKAGE = '@anthropic-ai/claude-agent-sdk'

// App home folder — engines, config, and the local user profile all live here.
// Exported so other main-process modules (e.g. profile storage) share the path.
// dev 한정 CCG_HOME 오버라이드: 설치본이 떠 있는 채로 dev를 시험할 때 홈을 통째로
// 샌드박스로 옮긴다 — 설치본과 ~/.agentcodegui를 공유하면 dev가 조용히 죽고,
// USERPROFILE 오버라이드는 크래시패드 핸들러가 기동 못 해(--database 누락 자멸) 못 쓴다.
// 프로덕션(isPackaged)에선 무시되므로 사용자 환경엔 영향이 없다.
export const APP_HOME =
  !app.isPackaged && process.env.CCG_HOME
    ? path.resolve(process.env.CCG_HOME)
    : path.join(os.homedir(), '.agentcodegui')
// Previous (pre-rebrand) home folder, migrated on first launch if it still exists.
const LEGACY_HOME = path.join(os.homedir(), '.rookissaiclaudecode')
const ENGINES_DIR = path.join(APP_HOME, 'engines')
const CONFIG_PATH = path.join(APP_HOME, 'config.json')

/**
 * One-time rename of the old ~/.rookissaiclaudecode folder to the new home, so an
 * already-installed engine (and its config) carries over after the rebrand. Best
 * effort: only runs when the new folder doesn't exist yet and the old one does.
 */
export function migrateLegacyHome(): void {
  try {
    if (!fs.existsSync(APP_HOME) && fs.existsSync(LEGACY_HOME)) {
      fs.renameSync(LEGACY_HOME, APP_HOME)
    }
  } catch {
    /* best effort — a fresh home will just be created on demand */
  }
}

type QueryFn = (arg: unknown) => unknown

// 두 엔진 CLI(Claude Code·Codex) 공통 자동 업데이트 플래그 (설정 → Engine → 공통) — 기본 켬
const AUTO_UPDATE_PATH = path.join(APP_HOME, 'engine-auto-update.json')
export function getAutoUpdate(): boolean {
  try {
    return (JSON.parse(fs.readFileSync(AUTO_UPDATE_PATH, 'utf8')) as { enabled?: boolean }).enabled !== false
  } catch {
    return true
  }
}
export function setAutoUpdate(enabled: boolean): void {
  try {
    fs.mkdirSync(APP_HOME, { recursive: true })
    writeFileAtomic(AUTO_UPDATE_PATH, JSON.stringify({ enabled }))
  } catch {
    /* ignore */
  }
}

interface Config {
  activeVersion: string | null
}

function readConfig(): Config {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    return { activeVersion: typeof c.activeVersion === 'string' ? c.activeVersion : null }
  } catch {
    return { activeVersion: null }
  }
}

function writeConfig(c: Config): void {
  fs.mkdirSync(APP_HOME, { recursive: true })
  writeFileAtomic(CONFIG_PATH, JSON.stringify(c, null, 2))
}

/** The version bundled with the app (the package.json dependency floor). */
function bundledVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'))
    const spec = String(pkg?.dependencies?.[PACKAGE] ?? '')
    return spec.replace(/^[\^~>=<\s]+/, '') || 'unknown'
  } catch {
    return 'unknown'
  }
}

function packageDir(version: string): string {
  return path.join(ENGINES_DIR, version, 'node_modules', ...PACKAGE.split('/'))
}

/** Reads the actually-installed version from a version dir, or null if absent. */
function installedVersionAt(version: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir(version), 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

// rough semver-ish descending compare (stable versions only). Exported for the boot
// gate's channel guard (양 엔진 공통 — 자릿수 비교라 패키지 무관).
export function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export function listInstalled(): string[] {
  let names: string[] = []
  try {
    names = fs
      .readdirSync(ENGINES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
  return names.filter((v) => installedVersionAt(v) != null).sort(compareVersionsDesc)
}

export function getState(): EngineVersionState {
  const installed = listInstalled()
  let active = readConfig().activeVersion
  // a configured-but-missing version silently falls back to the bundled engine
  if (active && !installed.includes(active)) active = null
  return { package: PACKAGE, bundled: bundledVersion(), active, installed }
}

export function setActive(version: string | null): void {
  if (version && installedVersionAt(version) == null) {
    throw new Error(`버전 ${version}이(가) 설치되어 있지 않습니다.`)
  }
  writeConfig({ activeVersion: version })
}

/** Fetches the available versions straight from the npm registry metadata. */
export async function listAvailable(): Promise<{ latest: string | null; versions: EngineVersionEntry[] }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(`https://registry.npmjs.org/${PACKAGE}`, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`레지스트리 응답 오류 (${res.status})`)
    const j = (await res.json()) as {
      'dist-tags'?: Record<string, string>
      versions?: Record<string, unknown>
      time?: Record<string, string>
    }
    const latest = j['dist-tags']?.latest ?? null
    const time = j.time ?? {}
    // stable releases only (drop -beta/-rc/etc), newest first
    const stable = Object.keys(j.versions ?? {}).filter((v) => !v.includes('-'))
    stable.sort(compareVersionsDesc)
    const versions: EngineVersionEntry[] = stable.map((v) => ({
      version: v,
      date: time[v] ?? null,
      latest: v === latest,
      // latest보다 높은 버전 = next 등 프리뷰 채널 (예: latest 0.3.208 위의 0.3.209)
      preview: latest != null && compareVersionsDesc(v, latest) < 0
    }))
    return { latest, versions }
  } finally {
    clearTimeout(timer)
  }
}

function writeMarkers(version: string, installed: string): void {
  const dir = path.join(ENGINES_DIR, version)
  try {
    fs.writeFileSync(path.join(dir, '.installed'), installed)
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ package: PACKAGE, version: installed, installedAt: new Date().toISOString() }, null, 2)
    )
  } catch {
    /* markers are best-effort */
  }
}

/**
 * Installs a specific engine version into ~/.agentcodegui/engines/<version>/
 * via `npm install <pkg>@<version> --prefix <dir>`, streaming npm output back.
 */
export async function install(
  version: string,
  onProgress: (p: EngineInstallProgress) => void
): Promise<{ ok: boolean; error?: string }> {
  const dir = path.join(ENGINES_DIR, version)
  try {
    await fsp.mkdir(dir, { recursive: true })
    // a clean private root so npm doesn't walk up into a parent package.json
    await fsp.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: `agent-code-gui-engine-${version}`, version: '0.0.0', private: true }, null, 2)
    )
  } catch (e) {
    return { ok: false, error: `폴더 생성 실패: ${(e as Error).message}` }
  }

  const isWin = process.platform === 'win32'
  const npmCmd = isWin ? 'npm.cmd' : 'npm'
  const args = ['install', `${PACKAGE}@${version}`, '--prefix', dir, '--no-audit', '--no-fund', '--loglevel=http']
  onProgress({ version, line: `$ npm install ${PACKAGE}@${version}` })

  return await new Promise((resolve) => {
    // On Windows, Node refuses to spawn a .cmd directly (EINVAL) since the
    // CVE-2024-27980 patch — run it through a shell, quoting args with spaces.
    const spawnArgs = isWin ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args
    const child = spawn(npmCmd, spawnArgs, { cwd: dir, env: process.env, windowsHide: true, shell: isWin })
    const onData = (buf: Buffer): void => {
      for (const line of buf.toString().split(/\r?\n/)) {
        const t = line.trim()
        if (t) onProgress({ version, line: t })
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (e) => {
      const error = `npm 실행 실패: ${e.message}. npm(Node.js)이 설치돼 있고 PATH에 있는지 확인하세요.`
      onProgress({ version, done: true, ok: false, error })
      resolve({ ok: false, error })
    })
    child.on('close', (code) => {
      const installed = installedVersionAt(version)
      if (code === 0 && installed) {
        writeMarkers(version, installed)
        onProgress({ version, done: true, ok: true })
        resolve({ ok: true })
      } else {
        const error = `설치 실패 (npm 종료 코드 ${code})`
        onProgress({ version, done: true, ok: false, error })
        resolve({ ok: false, error })
      }
    })
  })
}

export async function uninstall(version: string): Promise<void> {
  // Windows: 백신/인덱서의 순간 점유로 rm이 EPERM으로 즉사할 수 있다 — 기본
  // maxRetries가 0이라 재시도를 명시해야 견딘다 (codexUninstall과 동일 규칙)
  await fsp.rm(path.join(ENGINES_DIR, version), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  if (readConfig().activeVersion === version) writeConfig({ activeVersion: null })
  if (sdkCache?.version === version) sdkCache = null
}

// best-effort recursive folder size — the "얼마나 확보했는지" figure for cleanup
async function dirSize(dir: string): Promise<number> {
  let total = 0
  try {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) total += await dirSize(p)
      else if (e.isFile()) total += (await fsp.stat(p).catch(() => null))?.size ?? 0
    }
  } catch {
    /* unreadable entries just don't count */
  }
  return total
}

/**
 * Deletes every installed version except the newest one. If the active version
 * was among the deleted, the kept newest becomes active — a cleanup must never
 * silently drop runs back to the bundled SDK.
 */
export async function cleanupOld(): Promise<EngineCleanupResult> {
  const installed = listInstalled() // newest first
  const kept = installed[0] ?? null
  const activeBefore = readConfig().activeVersion
  const removed: string[] = []
  let freedBytes = 0
  for (const v of installed.slice(1)) {
    freedBytes += await dirSize(path.join(ENGINES_DIR, v))
    await uninstall(v) // clears config/sdkCache when they pointed at this version
    removed.push(v)
  }
  const activeSwitched = activeBefore != null && removed.includes(activeBefore)
  if (activeSwitched) writeConfig({ activeVersion: kept })
  return { removed, kept, freedBytes, activeSwitched }
}

// ── dynamic SDK loading (used by the engine) ─────────────────
let sdkCache: { version: string; query: QueryFn } | null = null

function resolveEntry(pkg: Record<string, unknown>): string | null {
  const exp = pkg.exports as unknown
  const dot = exp && typeof exp === 'object' ? (exp as Record<string, unknown>)['.'] ?? exp : exp
  if (typeof dot === 'string') return dot
  if (dot && typeof dot === 'object') {
    const o = dot as Record<string, unknown>
    for (const key of ['import', 'module', 'node', 'default']) {
      if (typeof o[key] === 'string') return o[key] as string
    }
  }
  if (typeof pkg.module === 'string') return pkg.module
  if (typeof pkg.main === 'string') return pkg.main
  return 'index.js'
}

/**
 * Loads the `query` function from the active installed version, or null to tell
 * the engine to use its bundled SDK. Any failure → null (safe fallback).
 */
export async function loadActiveQuery(): Promise<QueryFn | null> {
  const { active } = getState()
  if (!active) return null
  if (sdkCache?.version === active) return sdkCache.query
  try {
    const pkgDir = packageDir(active)
    const pkg = JSON.parse(await fsp.readFile(path.join(pkgDir, 'package.json'), 'utf8'))
    const entry = resolveEntry(pkg)
    if (!entry) return null
    const url = pathToFileURL(path.join(pkgDir, entry)).href
    const mod = await import(/* @vite-ignore */ url)
    const query = (mod.query ?? mod.default?.query) as QueryFn | undefined
    if (typeof query !== 'function') return null
    sdkCache = { version: active, query }
    return query
  } catch {
    return null
  }
}
