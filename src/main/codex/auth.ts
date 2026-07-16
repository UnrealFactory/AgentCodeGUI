/**
 * Codex(OpenAI) 계정 — Anthropic(auth.ts v3)과 동일한 문법: 앱에 등록된 계정만 사용하고
 * 전역 ~/.codex는 읽지도 쓰지도 않는다(최초 1회 가져오기 마이그레이션 제외 — 터미널
 * codex와 완전 격리). 계정마다 격리 CODEX_HOME(~/.agentcodegui/codex/accounts/<slug>)을
 * 두고, 엔진(app-server)이 그 폴더로 뜬다. 채팅이 계정을 명시 바인딩하고 미지정은 기본
 * 계정(defaultEmail).
 * (codex CLI가 CODEX_HOME을 상태 조회·로그인 전부에서 홈으로 취급하는 것 실측 —
 *  빈 폴더=Not logged in, auth.json 사본=그 계정 인식)
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { safeStorage, shell, type WebContents } from 'electron'
import { IPC } from '@shared/protocol'
import type { CodexAccountInfo, CodexAccountUsage } from '@shared/protocol'
import { codexBin } from './versions'

const APP_HOME = path.join(os.homedir(), '.agentcodegui')
const STORE_PATH = path.join(APP_HOME, 'codex-accounts.json')
const STORE_VERSION = 1
const CODEX_ROOT = path.join(APP_HOME, 'codex')
const ACCOUNTS_DIR = path.join(CODEX_ROOT, 'accounts')
const SHARED_ROOT = path.join(CODEX_ROOT, 'shared')
const LOGIN_DIR = path.join(CODEX_ROOT, 'login')
// 계정 폴더끼리 공유할 폴더(정션) — 세션(resume)·스킬·플러그인·캐시. sqlite/history 등
// 루트의 파일 상태는 계정별로 갈라진다(파일은 정션 불가 — 계정 스코프 상태라 오히려 맞다).
const SHARED_DIRS = ['sessions', 'skills', 'plugins', 'cache']
const COPIED_FILES = ['config.toml']

interface StoredCodexAccount {
  email: string
  plan?: string // 'plus' · 'pro' · 'free' 등 (id_token의 chatgpt_plan_type)
  authEnc: string // base64( safeStorage.encryptString( auth.json 원문 ) )
}
interface StoreFile {
  version: number
  defaultEmail?: string
  accounts: StoredCodexAccount[]
}

function readStoreFile(): StoreFile {
  try {
    const j = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as StoreFile
    if (j.version !== STORE_VERSION) return { version: STORE_VERSION, accounts: [] }
    return {
      version: j.version,
      defaultEmail: typeof j.defaultEmail === 'string' ? j.defaultEmail : undefined,
      accounts: Array.isArray(j.accounts) ? j.accounts : []
    }
  } catch {
    return { version: STORE_VERSION, accounts: [] }
  }
}
function writeStoreFile(accounts: StoredCodexAccount[], defaultEmail: string | undefined): void {
  try {
    fs.mkdirSync(APP_HOME, { recursive: true })
    const def = accounts.some((a) => a.email === defaultEmail) ? defaultEmail : accounts[0]?.email
    fs.writeFileSync(STORE_PATH, JSON.stringify({ version: STORE_VERSION, defaultEmail: def, accounts }, null, 2))
  } catch {
    /* ignore */
  }
}

function enc(raw: string): string | null {
  try {
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(raw).toString('base64')
      : Buffer.from(raw, 'utf8').toString('base64')
  } catch {
    return null
  }
}
function dec(b64: string): string | null {
  try {
    const buf = Buffer.from(b64, 'base64')
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8')
  } catch {
    return null
  }
}

function readFileOrNull(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

// auth.json 원문 → 이메일·플랜. id_token(JWT) 페이로드를 표시용으로만 디코드한다.
function parseAuth(raw: string | null): { email: string | null; plan: string | null } | null {
  if (!raw) return null
  try {
    const j = JSON.parse(raw) as { OPENAI_API_KEY?: string | null; tokens?: { id_token?: string } }
    const id = j.tokens?.id_token
    if (id) {
      const payload = JSON.parse(Buffer.from(id.split('.')[1], 'base64url').toString()) as Record<string, unknown>
      const auth = (payload['https://api.openai.com/auth'] ?? {}) as { chatgpt_plan_type?: string }
      return {
        email: typeof payload.email === 'string' ? payload.email : null,
        plan: typeof auth.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : null
      }
    }
    if (j.OPENAI_API_KEY) return { email: null, plan: null }
    return null
  } catch {
    return null
  }
}

// 토큰 신선도 — auth.json의 last_refresh(ISO). 못 읽으면 0.
function authFreshness(raw: string | null): number {
  if (!raw) return 0
  try {
    const t = (JSON.parse(raw) as { last_refresh?: string }).last_refresh
    const ms = t ? Date.parse(t) : NaN
    return Number.isNaN(ms) ? 1 : ms
  } catch {
    return 0
  }
}

function accountSlug(email: string): string {
  const safe = email.toLowerCase().replace(/[^a-z0-9._-]+/g, '_')
  let h = 0
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0
  return `${safe}-${h.toString(36)}`
}

export function codexDefaultAccountEmail(): string | null {
  const f = readStoreFile()
  if (f.defaultEmail && f.accounts.some((a) => a.email === f.defaultEmail)) return f.defaultEmail
  return f.accounts[0]?.email ?? null
}

export async function codexListAccounts(): Promise<CodexAccountInfo[]> {
  const def = codexDefaultAccountEmail()
  return readStoreFile().accounts.map((a) => {
    // 플랜: 스토어 값이 최우선 — rateLimits 조회(codexAccountsUsage)가 최신 planType으로
    // 되싱크해 준다(id_token은 리프레시 전까지 옛 플랜을 물고 있어 폴백으로만).
    const dirAuth = readFileOrNull(path.join(ACCOUNTS_DIR, accountSlug(a.email), 'auth.json'))
    const backup = dec(a.authEnc)
    const best = authFreshness(dirAuth) >= authFreshness(backup) ? (dirAuth ?? backup) : backup
    return {
      email: a.email,
      plan: a.plan ?? parseAuth(best)?.plan ?? null,
      isDefault: a.email === def
    }
  })
}

export async function codexSetDefaultAccount(email: string): Promise<CodexAccountInfo[]> {
  const f = readStoreFile()
  if (f.accounts.some((a) => a.email === email)) writeStoreFile(f.accounts, email)
  return codexListAccounts()
}

function ensureSharedRoot(): void {
  try {
    for (const name of SHARED_DIRS) fs.mkdirSync(path.join(SHARED_ROOT, name), { recursive: true })
  } catch {
    /* ignore */
  }
}

function linkSharedState(dir: string): void {
  ensureSharedRoot()
  for (const name of SHARED_DIRS) {
    const dst = path.join(dir, name)
    try {
      try {
        fs.lstatSync(dst)
        continue // 이미 있음(링크든 실폴더든) — 데이터 보존
      } catch {
        /* 없음 → 링크 생성 */
      }
      fs.symlinkSync(path.join(SHARED_ROOT, name), dst, 'junction')
    } catch {
      /* ignore */
    }
  }
  for (const name of COPIED_FILES) {
    try {
      const src = path.join(SHARED_ROOT, name)
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, name))
    } catch {
      /* ignore */
    }
  }
}

// 실행용 CODEX_HOME — 등록 계정의 격리 폴더(항상 반환). 폴더 쪽 auth가 더 신선하면
// (직전 실행에서 CLI가 리프레시) 남겨두고, 백업이 더 신선하면(재로그인) 백업으로 덮는다.
export function codexAccountRunDir(email: string): string {
  const target = readStoreFile().accounts.find((a) => a.email === email)
  if (!target) throw new Error(`'${email}' OpenAI 계정이 등록 목록에 없어요 — 설정 → Account에서 로그인해 주세요.`)
  const raw = dec(target.authEnc)
  if (!raw) throw new Error(`'${email}' OpenAI 계정 데이터를 복호화하지 못했어요 — 설정 → Account에서 다시 로그인해 주세요.`)
  const dir = path.join(ACCOUNTS_DIR, accountSlug(email))
  fs.mkdirSync(dir, { recursive: true })
  const authPath = path.join(dir, 'auth.json')
  if (authFreshness(raw) >= authFreshness(readFileOrNull(authPath))) fs.writeFileSync(authPath, raw)
  linkSharedState(dir)
  return dir
}

// API 키 실행용 CODEX_HOME — 계정 로그인 대신 저장된 OPENAI_API_KEY로 과금하는 격리 홈.
// codex는 auth.json의 OPENAI_API_KEY를 API 키 인증으로 읽는다. sessions 정션을 계정
// 폴더들과 공유하므로 구독 ↔ API 모드를 오가도 스레드 resume이 그대로 이어진다.
export function codexApiKeyRunDir(key: string): string {
  const dir = path.join(CODEX_ROOT, 'api-key')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: key }))
  linkSharedState(dir)
  return dir
}

// 실행이 끝난 뒤 — CLI가 폴더에서 리프레시한 auth.json을 암호화 백업에 반영(전진 가드).
export function syncCodexAccount(email: string): void {
  const f = readStoreFile()
  const target = f.accounts.find((a) => a.email === email)
  if (!target) return
  const dirAuth = readFileOrNull(path.join(ACCOUNTS_DIR, accountSlug(email), 'auth.json'))
  if (!dirAuth) return
  const raw = dec(target.authEnc)
  if (!raw || dirAuth === raw) return
  if (authFreshness(dirAuth) <= authFreshness(raw)) return
  const authEnc = enc(dirAuth)
  if (!authEnc) return
  // 플랜은 여기서 건드리지 않는다 — id_token은 리프레시 후에도 옛 플랜을 물고 있을 수
  // 있어(실측: 구독 직후 free 유지), rateLimits 조회(codexAccountsUsage)가 진실을 되싱크한다.
  writeStoreFile(
    f.accounts.map((a) => (a.email === email ? { ...a, authEnc } : a)),
    f.defaultEmail
  )
}

function deleteAccountDir(email: string): void {
  const dir = path.join(ACCOUNTS_DIR, accountSlug(email))
  try {
    if (!fs.existsSync(dir)) return
    for (const name of SHARED_DIRS) {
      try {
        const p = path.join(dir, name)
        if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p)
      } catch {
        /* ignore */
      }
    }
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

// 삭제 — 그 계정 폴더를 CODEX_HOME으로 `codex logout`(로컬 auth 제거) 후 등록·폴더 정리.
export async function codexLogout(email: string): Promise<CodexAccountInfo[]> {
  const dir = path.join(ACCOUNTS_DIR, accountSlug(email))
  if (fs.existsSync(path.join(dir, 'auth.json'))) {
    await new Promise<void>((resolve) => {
      const child = spawn(codexBin(), ['logout'], {
        windowsHide: true,
        shell: true,
        env: { ...process.env, CODEX_HOME: dir }
      })
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* ignore */
        }
        resolve()
      }, 15000)
      child.on('close', () => {
        clearTimeout(timer)
        resolve()
      })
      child.on('error', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
  const f = readStoreFile()
  writeStoreFile(
    f.accounts.filter((a) => a.email !== email),
    f.defaultEmail
  )
  deleteAccountDir(email)
  return codexListAccounts()
}

// 진행 중인 로그인 자식 프로세스(한 번에 하나)
let loginProc: ChildProcess | null = null

export function codexLoginCancel(): void {
  if (loginProc) {
    try {
      loginProc.kill()
    } catch {
      /* ignore */
    }
    loginProc = null
  }
}

// `codex login` — 임시 CODEX_HOME(~/.agentcodegui/codex/login)으로 브라우저 OAuth.
// 완료 후 auth.json에서 신원을 읽어 편입 + 계정 폴더 물질화, 임시 폴더는 지운다.
// (Temp 아래가 아니라 앱 홈이라 codex의 PATH 헬퍼 거부 경고도 없다)
export async function codexLogin(wc: WebContents): Promise<CodexAccountInfo[]> {
  codexLoginCancel()
  try {
    fs.rmSync(LOGIN_DIR, { recursive: true, force: true })
    fs.mkdirSync(LOGIN_DIR, { recursive: true })
  } catch {
    /* ignore */
  }
  return new Promise((resolve) => {
    const child = spawn(codexBin(), ['login'], {
      windowsHide: true,
      shell: true,
      env: { ...process.env, CODEX_HOME: LOGIN_DIR }
    })
    loginProc = child
    let opened = false
    const onData = (buf: Buffer): void => {
      const m = buf.toString().match(/https?:\/\/[^\s"'）)]+/)
      if (m && !opened) {
        opened = true
        shell.openExternal(m[0]).catch(() => {})
        if (!wc.isDestroyed()) wc.send(IPC.authLoginUrl, m[0])
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    const timer = setTimeout(() => codexLoginCancel(), 5 * 60 * 1000)
    const finish = async (): Promise<void> => {
      clearTimeout(timer)
      if (loginProc === child) loginProc = null
      importAccountFromDir(LOGIN_DIR)
      try {
        fs.rmSync(LOGIN_DIR, { recursive: true, force: true }) // 평문 토큰을 임시 자리에 남기지 않는다
      } catch {
        /* ignore */
      }
      resolve(await codexListAccounts())
    }
    child.on('close', () => void finish())
    child.on('error', () => void finish())
  })
}

// 폴더의 auth.json을 스토어에 편입 + 계정 폴더 물질화 (로그인 완료·마이그레이션 공용).
function importAccountFromDir(dir: string): string | undefined {
  const raw = readFileOrNull(path.join(dir, 'auth.json'))
  const meta = parseAuth(raw)
  if (!raw || !meta?.email) return undefined // API 키 인증(이메일 없음)은 계정 목록 대상이 아니다
  const authEnc = enc(raw)
  if (!authEnc) return undefined
  const f = readStoreFile()
  const accounts = f.accounts.filter((a) => a.email !== meta.email)
  accounts.push({ email: meta.email, plan: meta.plan ?? undefined, authEnc })
  writeStoreFile(accounts, f.defaultEmail) // 첫 계정이면 자동 기본(폴백)
  try {
    codexAccountRunDir(meta.email)
  } catch {
    /* 다음 실행 때 다시 시도된다 */
  }
  return meta.email
}

// ── 계정별 한도 — app-server `account/rateLimits/read` (실측) ─────────
// 짧게 띄운 app-server에 initialize → rateLimits/read 한 번 쏘고 죽인다. planType이
// id_token보다 신선해(구독 변경 즉시 반영) 스토어 plan도 이걸로 되싱크한다.
function codexRpcOnce(home: string, method: string): Promise<unknown | null> {
  return new Promise((resolve) => {
    const proc = spawn(codexBin(), ['app-server'], {
      windowsHide: true,
      shell: process.platform === 'win32',
      env: { ...process.env, CODEX_HOME: home }
    })
    let buf = ''
    let done = false
    const finish = (v: unknown | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), 12000)
    proc.stdout?.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let m: { id?: number; result?: unknown; error?: unknown }
        try {
          m = JSON.parse(line)
        } catch {
          continue
        }
        if (m.id === 1) proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method }) + '\n')
        else if (m.id === 2) finish(m.error ? null : (m.result ?? null))
      }
    })
    proc.on('error', () => finish(null))
    proc.on('exit', () => finish(null))
    proc.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'agentcodegui', title: 'AgentCodeGUI', version: '2.0.0' }, capabilities: null }
      }) + '\n'
    )
  })
}

// 윈도 길이(분) → 한국어 라벨 (300=5시간, 10080=주간 — 실측 값 기준, 그 외는 일반화)
function windowLabel(mins: number): string {
  if (mins <= 0) return '한도'
  if (mins <= 1440) return `${Math.max(1, Math.round(mins / 60))}시간`
  if (Math.round(mins / 1440) === 7) return '주간'
  return `${Math.round(mins / 1440)}일`
}

// 조회 결과는 계정별 캐시(2분) + 실패 시 마지막 성공값 유지 — 호출마다 app-server를
// 스폰하므로(≈0.7s) 폴링이 프로세스를 반복 생성하지 않게 하고, 게이지가 깜빡이며
// 사라지지 않게 한다.
const cxUsageCache = new Map<string, { at: number; data: CodexAccountUsage }>()
const CX_USAGE_TTL = 2 * 60 * 1000

export async function codexAccountsUsage(): Promise<CodexAccountUsage[]> {
  const rows = readStoreFile().accounts.map(async (a): Promise<CodexAccountUsage> => {
    const cached = cxUsageCache.get(a.email)
    if (cached && Date.now() - cached.at < CX_USAGE_TTL) return cached.data
    const empty: CodexAccountUsage = cached?.data ?? { email: a.email, planType: null, windows: [] }
    let dir: string
    try {
      dir = codexAccountRunDir(a.email)
    } catch {
      return empty
    }
    const res = (await codexRpcOnce(dir, 'account/rateLimits/read')) as {
      rateLimits?: {
        planType?: string
        primary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number } | null
        secondary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number } | null
      }
    } | null
    const rl = res?.rateLimits
    if (!rl) return empty
    const windows: CodexAccountUsage['windows'] = []
    for (const w of [rl.primary, rl.secondary]) {
      if (w && typeof w.usedPercent === 'number' && typeof w.windowDurationMins === 'number') {
        windows.push({
          label: windowLabel(w.windowDurationMins),
          usedPct: Math.max(0, Math.min(100, Math.round(w.usedPercent))),
          // 창 초기화 시각(unix 초) — rateLimits/read 실측 필드
          resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : null
        })
      }
    }
    const planType = typeof rl.planType === 'string' ? rl.planType : null
    // 구독 변경(Free→Plus 등)을 스토어 plan에도 되싱크 — 목록 표시가 다음 조회부터 바로 맞게
    if (planType && planType !== a.plan) {
      const f = readStoreFile()
      writeStoreFile(
        f.accounts.map((x) => (x.email === a.email ? { ...x, plan: planType } : x)),
        f.defaultEmail
      )
    }
    const data: CodexAccountUsage = { email: a.email, planType, windows }
    cxUsageCache.set(a.email, { at: Date.now(), data })
    return data
  })
  return Promise.all(rows)
}

// ── 1회 마이그레이션 — 전역 ~/.codex의 로그인·상태를 앱 소유로 이관 ──
// (1) sessions·skills 등 공유 폴더 + config.toml을 shared로 복사(원본 보존 — 터미널 codex 무손상)
// (2) 전역에 로그인돼 있던 계정을 첫 등록 계정으로 가져오기(이후 전역은 다시 보지 않는다)
const MIGRATED_MARK = path.join(SHARED_ROOT, '.migrated-v1')

export async function migrateCodexAccounts(): Promise<void> {
  if (fs.existsSync(MIGRATED_MARK)) return
  const home = path.join(os.homedir(), '.codex')
  ensureSharedRoot()
  for (const name of SHARED_DIRS) {
    const src = path.join(home, name)
    const dst = path.join(SHARED_ROOT, name)
    try {
      if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) continue
      if (fs.readdirSync(dst).length > 0) continue
      await fs.promises.cp(src, dst, { recursive: true, force: false, errorOnExist: false })
    } catch {
      /* 항목 단위 실패는 무시 */
    }
  }
  for (const name of COPIED_FILES) {
    try {
      const src = path.join(home, name)
      const dst = path.join(SHARED_ROOT, name)
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst)
    } catch {
      /* ignore */
    }
  }
  const f = readStoreFile()
  const imported = importAccountFromDir(home)
  if (imported) writeStoreFile(readStoreFile().accounts, f.defaultEmail ?? imported)
  try {
    fs.writeFileSync(MIGRATED_MARK, String(Date.now()))
  } catch {
    /* ignore */
  }
}
