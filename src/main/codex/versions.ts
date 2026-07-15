/**
 * Codex CLI 버전 관리 — Claude Code(engine/versions.ts)와 동일한 문법: npm 패키지
 * (@openai/codex)를 앱 홈 전용 폴더에 버전별로 설치하고 그 실행 파일로 돈다. 시스템
 * 전역 codex는 건드리지 않는다(설치본이 없으면 전역 codex로 폴백 — 번들이 없다는 점만
 * Claude와 다르다).
 */
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { writeFileAtomic } from '../atomicWrite'
import type { EngineVersionEntry, EngineVersionState, EngineInstallProgress, EngineCleanupResult } from '@shared/protocol'

const PACKAGE = '@openai/codex'
const APP_HOME = path.join(os.homedir(), '.agentcodegui')
const ENGINES_DIR = path.join(APP_HOME, 'codex-engines')
const CONFIG_PATH = path.join(APP_HOME, 'codex-config.json')

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

function packageDir(version: string): string {
  return path.join(ENGINES_DIR, version, 'node_modules', ...PACKAGE.split('/'))
}

function installedVersionAt(version: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir(version), 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

function compareDesc(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export function codexListInstalled(): string[] {
  let names: string[] = []
  try {
    names = fs
      .readdirSync(ENGINES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
  return names.filter((v) => installedVersionAt(v) != null).sort(compareDesc)
}

// 전역 codex의 버전 — 설치본이 없을 때의 폴백 표시 (Claude의 '번들' 자리). 캐시 1회.
let globalVer: string | null | undefined
function globalCodexVersion(): Promise<string> {
  if (globalVer !== undefined) return Promise.resolve(globalVer ?? 'unknown')
  return new Promise((resolve) => {
    execFile('codex', ['--version'], { timeout: 8000, windowsHide: true, shell: true }, (_e, stdout) => {
      const m = (stdout ?? '').match(/\d+\.\d+\.\d+/)
      globalVer = m ? m[0] : null
      resolve(globalVer ?? 'unknown')
    })
  })
}

export async function codexEngineState(): Promise<EngineVersionState> {
  const installed = codexListInstalled()
  let active = readConfig().activeVersion
  if (active && !installed.includes(active)) active = null
  // bundled 자리에 전역 codex 버전 — 설치본이 없으면 이걸로 돈다(폴백)
  return { package: PACKAGE, bundled: await globalCodexVersion(), active, installed }
}

export function codexSetActive(version: string | null): void {
  if (version && installedVersionAt(version) == null) {
    throw new Error(`버전 ${version}이(가) 설치되어 있지 않습니다.`)
  }
  writeConfig({ activeVersion: version })
}

export async function codexListAvailable(): Promise<{ latest: string | null; versions: EngineVersionEntry[] }> {
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
    const stable = Object.keys(j.versions ?? {}).filter((v) => !v.includes('-'))
    stable.sort(compareDesc)
    return {
      latest,
      versions: stable.map((v) => ({
        version: v,
        date: time[v] ?? null,
        latest: v === latest,
        // latest보다 높은 버전 = 프리뷰 채널 — 자동 업데이트 대상 아님 (UI '프리뷰' 배지)
        preview: latest != null && compareDesc(v, latest) < 0
      }))
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function codexInstall(
  version: string,
  onProgress: (p: EngineInstallProgress) => void
): Promise<{ ok: boolean; error?: string }> {
  const dir = path.join(ENGINES_DIR, version)
  try {
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: `agent-code-gui-codex-${version}`, version: '0.0.0', private: true }, null, 2)
    )
  } catch (e) {
    return { ok: false, error: `폴더 생성 실패: ${(e as Error).message}` }
  }

  const isWin = process.platform === 'win32'
  const npmCmd = isWin ? 'npm.cmd' : 'npm'
  const args = ['install', `${PACKAGE}@${version}`, '--prefix', dir, '--no-audit', '--no-fund', '--loglevel=http']
  onProgress({ version, line: `$ npm install ${PACKAGE}@${version}` })

  return await new Promise((resolve) => {
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
      if (code === 0 && installedVersionAt(version)) {
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

export async function codexUninstall(version: string): Promise<void> {
  // Windows: 백신/인덱서가 큰 node_modules(네이티브 exe 포함)를 순간 점유하면 rm이
  // EPERM으로 즉사한다 — 기본 maxRetries가 0이라 재시도를 명시해야 견딘다 (실측:
  // 부팅 게이트의 옛 버전 정리가 조용히 실패해 0.144.3 잔재가 남았다)
  await fsp.rm(path.join(ENGINES_DIR, version), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  if (readConfig().activeVersion === version) writeConfig({ activeVersion: null })
}

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

export async function codexCleanupOld(): Promise<EngineCleanupResult> {
  const installed = codexListInstalled()
  const kept = installed[0] ?? null
  const activeBefore = readConfig().activeVersion
  const removed: string[] = []
  let freedBytes = 0
  for (const v of installed.slice(1)) {
    freedBytes += await dirSize(path.join(ENGINES_DIR, v))
    await codexUninstall(v)
    removed.push(v)
  }
  const activeSwitched = activeBefore != null && removed.includes(activeBefore)
  if (activeSwitched) writeConfig({ activeVersion: kept })
  return { removed, kept, freedBytes, activeSwitched }
}

/**
 * 실행에 쓸 codex 명령 — 활성 설치본의 실행 파일, 없으면 전역 'codex'(PATH) 폴백.
 * Windows는 .cmd라 shell 경유 스폰이 전제 — 경로 공백이 깨지지 않게 따옴표로 감싼다
 * (비-Windows는 shell 없이 스폰하므로 원문 그대로).
 */
export function codexBin(): string {
  const { activeVersion } = readConfig()
  if (activeVersion) {
    const bin = path.join(
      ENGINES_DIR,
      activeVersion,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'codex.cmd' : 'codex'
    )
    if (fs.existsSync(bin)) return process.platform === 'win32' && /\s/.test(bin) ? `"${bin}"` : bin
  }
  return 'codex'
}
