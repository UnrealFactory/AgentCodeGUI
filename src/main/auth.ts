/**
 * 클로드 계정(구독 OAuth) — 앱에 등록된 계정만 사용한다. 전역 ~/.claude는 읽지도 쓰지도
 * 않는다(최초 1회 가져오기 마이그레이션 제외 — 이후 터미널 Claude Code와 완전 격리).
 * 계정마다 격리 config 폴더(~/.agentcodegui/accounts/<slug>)를 두고, 모든 구독 실행이
 * CLAUDE_CONFIG_DIR로 그 폴더를 가리킨다. "활성 계정/전환" 개념은 없다 — 채팅이 계정을
 * 명시적으로 바인딩하고, 미지정이면 기본 계정(defaultEmail)을 쓴다.
 * (CLI가 CLAUDE_CONFIG_DIR을 상태 조회·로그인·실행 전부에서 자기 홈으로 취급하는 것 실측)
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, safeStorage, shell, type WebContents } from 'electron'
import { IPC } from '@shared/protocol'
import type { AuthStatus, AccountInfo, AccountUsage } from '@shared/protocol'

// 번들된 네이티브 claude 실행 파일을 찾는다(dev: 앱 node_modules, prod: asar.unpacked).
// auth 는 버전 무관하게 같은 크리덴셜 포맷을 다루므로 번들본으로 충분하다.
function claudeBin(): string | null {
  const rel = ['@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe']
  const cands = [
    process.env.MAIN_VITE_CLAUDE_BIN,
    process.env.CLAUDE_BIN,
    app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', ...rel) : null,
    path.join(app.getAppPath(), 'node_modules', ...rel),
    path.join(process.cwd(), 'node_modules', ...rel)
  ].filter((x): x is string => !!x)
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      /* ignore */
    }
  }
  return null
}

function parseStatus(stdout: string): AuthStatus {
  try {
    const j = JSON.parse(stdout.trim()) as Record<string, unknown>
    return {
      loggedIn: !!j.loggedIn,
      email: typeof j.email === 'string' ? j.email : undefined,
      authMethod: typeof j.authMethod === 'string' ? j.authMethod : undefined,
      subscriptionType: typeof j.subscriptionType === 'string' ? j.subscriptionType : undefined,
      orgName: typeof j.orgName === 'string' ? j.orgName : undefined
    }
  } catch {
    return { loggedIn: false }
  }
}

// 특정 config 폴더의 로그인 상태 — CLAUDE_CONFIG_DIR로 그 폴더만 본다(전역 무관).
function statusForDir(dir: string): Promise<AuthStatus> {
  const bin = claudeBin()
  if (!bin) return Promise.resolve({ loggedIn: false, error: 'claude 실행 파일을 찾지 못했어요' })
  return new Promise((resolve) => {
    execFile(
      bin,
      ['auth', 'status', '--json'],
      { timeout: 20000, windowsHide: true, env: { ...process.env, CLAUDE_CONFIG_DIR: dir } },
      (_err, stdout) => {
        // 로그아웃 상태면 CLI가 비-0으로 끝나며 JSON에 loggedIn:false를 준다 — 그대로 파싱
        if (stdout && stdout.trim().startsWith('{')) return resolve(parseStatus(stdout))
        resolve({ loggedIn: false })
      }
    )
  })
}

// ── 계정 스토어 (~/.agentcodegui/accounts.json, v3) ───────────────
// 계정 = { .credentials.json(토큰) + .claude.json의 oauthAccount·userID(신원) } 스냅샷.
// 살아있는 토큰의 실거처는 계정 폴더(CLI가 거기서 리프레시)고, 스토어의 암호화 스냅샷은
// 폴더 재생성용 백업이다 — 실행이 끝나면 syncAccountTokens가 폴더 쪽을 백업에 되쓴다.
const APP_HOME = path.join(os.homedir(), '.agentcodegui')
const STORE_PATH = path.join(APP_HOME, 'accounts.json')
const STORE_VERSION = 3 // v3: defaultEmail 추가 + 전역 ~/.claude 의존 제거 (v2와 계정 포맷 동일)

interface AccountSnapshot {
  creds: string // .credentials.json 전체 내용(토큰)
  account: unknown // .claude.json 의 oauthAccount(신원)
  userID?: string // .claude.json 의 userID
}

interface StoredAccount {
  email: string
  subscriptionType?: string
  credEnc: string // base64( safeStorage.encryptString( JSON(AccountSnapshot) ) )
}

interface StoreFile {
  version: number
  defaultEmail?: string // 새 채팅의 기본 계정 (미지정 채팅의 실행 계정)
  accounts: StoredAccount[]
}

function readJson(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

// v2(계정 포맷 동일)도 읽는다 — 마이그레이션 전에 호출돼도 계정이 사라져 보이지 않게.
// v1 이하는 신원이 없어 무효 → 폐기.
function readStoreFile(): StoreFile {
  try {
    const j = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as StoreFile
    if (j.version !== STORE_VERSION && j.version !== 2) return { version: STORE_VERSION, accounts: [] }
    return {
      version: j.version,
      defaultEmail: typeof j.defaultEmail === 'string' ? j.defaultEmail : undefined,
      accounts: Array.isArray(j.accounts) ? j.accounts : []
    }
  } catch {
    return { version: STORE_VERSION, accounts: [] }
  }
}
function readStore(): StoredAccount[] {
  return readStoreFile().accounts
}
function writeStoreFile(accounts: StoredAccount[], defaultEmail: string | undefined): void {
  try {
    fs.mkdirSync(APP_HOME, { recursive: true })
    // 기본 계정이 목록에 없으면(삭제 등) 첫 계정으로 물러난다 — "기본 없음" 상태를 안 만든다
    const def = accounts.some((a) => a.email === defaultEmail) ? defaultEmail : accounts[0]?.email
    fs.writeFileSync(STORE_PATH, JSON.stringify({ version: STORE_VERSION, defaultEmail: def, accounts }, null, 2))
  } catch {
    /* ignore */
  }
}

function encCreds(raw: string): string | null {
  try {
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(raw).toString('base64')
      : Buffer.from(raw, 'utf8').toString('base64')
  } catch {
    return null
  }
}
function decCreds(b64: string): string | null {
  try {
    const buf = Buffer.from(b64, 'base64')
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8')
  } catch {
    return null
  }
}

// 미지정 채팅이 쓸 기본 계정 — 스토어의 defaultEmail, 무효/부재면 첫 계정, 계정 0개면 null.
export function defaultAccountEmail(): string | null {
  const f = readStoreFile()
  if (f.defaultEmail && f.accounts.some((a) => a.email === f.defaultEmail)) return f.defaultEmail
  return f.accounts[0]?.email ?? null
}

export async function setDefaultAccount(email: string): Promise<AccountInfo[]> {
  const f = readStoreFile()
  if (f.accounts.some((a) => a.email === email)) writeStoreFile(f.accounts, email)
  return listAccounts()
}

// 등록 계정 목록 — 스토어만 본다(CLI 스폰 없음, 전역 무관).
export async function listAccounts(): Promise<AccountInfo[]> {
  const def = defaultAccountEmail()
  return readStore().map((a) => ({
    email: a.email,
    subscriptionType: a.subscriptionType,
    isDefault: a.email === def
  }))
}

export async function removeAccount(email: string): Promise<AccountInfo[]> {
  const f = readStoreFile()
  writeStoreFile(
    f.accounts.filter((a) => a.email !== email),
    f.defaultEmail
  )
  deleteAccountDir(email)
  return listAccounts()
}

// ── 계정별 격리 config 폴더 (CLAUDE_CONFIG_DIR) ─────────────────
// 모든 구독 실행이 계정 폴더를 CLAUDE_CONFIG_DIR로 받는다(빈 폴더=로그아웃, 토큰+신원을
// 넣은 폴더=그 계정 인식 — 실측 검증).
// - 세션 기록(projects·sessions 등)은 앱 소유 공유 원본(~/.agentcodegui/shared)으로 정션
//   링크 → resume이 계정과 무관하게 이어지고, 채팅 중간에 계정을 바꿔도 대화 맥락이
//   유지된다. skills·agents·plugins·commands도 링크해 계정끼리 같은 도구 환경을 쓴다
//   (Windows 정션은 관리자 권한 불필요).
// - settings.json·CLAUDE.md는 파일이라 링크 대신 물질화 때마다 shared에서 복사한다(수 KB).
// - CLI가 폴더 안에서 토큰을 스스로 리프레시하므로, 실행이 끝나면 syncAccountTokens가
//   폴더의 더 신선한 토큰을 암호화 스냅샷(백업)에 되쓴다. 가드(accessToken 존재 +
//   expiresAt 전진)를 통과할 때만 — 401을 맞아 껍데기로 덮인 크리덴셜이 백업을
//   오염시키지 않도록(1.6.2에서 잡은 스냅샷 오염과 같은 계열의 방어).
const ACCOUNTS_DIR = path.join(APP_HOME, 'accounts')
const SHARED_ROOT = path.join(APP_HOME, 'shared')
// 계정 폴더끼리 공유할 폴더(정션 링크) — 세션 기록 + 도구 환경. 파일은 복사.
const SHARED_DIRS = ['projects', 'sessions', 'session-env', 'todos', 'tasks', 'teams', 'agents', 'skills', 'plugins', 'commands', 'file-history']
const COPIED_FILES = ['settings.json', 'settings.local.json', 'CLAUDE.md']

// 이메일 → 폴더 이름. 로컬파트가 같은 계정끼리 부딪히지 않게 짧은 해시를 붙인다.
function accountSlug(email: string): string {
  const safe = email.toLowerCase().replace(/[^a-z0-9._-]+/g, '_')
  let h = 0
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0
  return `${safe}-${h.toString(36)}`
}

function readFileOrNull(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

// 크리덴셜의 신선도 키 — 액세스 토큰이 없으면 0(껍데기), 만료시각이 없으면 1(최소값).
// 물질화(어느 쪽 토큰을 남길지)와 되싱크(백업을 갱신할지) 판정에 쓴다.
function credsExpiresAt(raw: string | null): number {
  if (!raw) return 0
  try {
    const o = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } }).claudeAiOauth
    if (!o?.accessToken) return 0
    return typeof o.expiresAt === 'number' ? o.expiresAt : 1
  } catch {
    return 0
  }
}

// 공유 원본 폴더 보장 — 정션 대상이 항상 존재해야 CLI가 계정 폴더 안에 실폴더를 만들어
// 세션이 계정별로 갈라지는 사고가 없다.
function ensureSharedRoot(): void {
  try {
    for (const name of SHARED_DIRS) fs.mkdirSync(path.join(SHARED_ROOT, name), { recursive: true })
  } catch {
    /* ignore */
  }
}

// 세션 기록·도구 환경을 공유 원본과 잇는다(정션 링크 + 설정 파일 복사). 링크 실패는
// 그 항목만 격리 동작이 될 뿐 치명적이지 않아 조용히 넘어간다. CLI가 먼저 실폴더를
// 만들어뒀으면 데이터 보존을 우선해 그대로 둔다.
function linkSharedState(dir: string): void {
  ensureSharedRoot()
  for (const name of SHARED_DIRS) {
    const dst = path.join(dir, name)
    try {
      try {
        fs.lstatSync(dst)
        continue // 이미 있음(링크든 실폴더든) — 그대로 둔다
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

// 실행용 계정 폴더 — 등록 계정이면 물질화된 격리 config 폴더 경로(항상 반환). 폴더 쪽
// 토큰이 더 신선하면(직전 실행에서 CLI가 리프레시) 남겨두고, 백업이 더 신선하면(재로그인
// 등) 백업으로 덮는다. 스냅샷이 없거나 깨졌으면 던진다(엔진이 에러 카드로 표시).
export function accountRunDir(email: string): string {
  const target = readStore().find((a) => a.email === email)
  if (!target) throw new Error(`'${email}' 계정이 등록 목록에 없어요 — 설정 → Account에서 로그인해 주세요.`)
  const raw = decCreds(target.credEnc)
  if (!raw) throw new Error(`'${email}' 계정 데이터를 복호화하지 못했어요 — 설정 → Account에서 다시 로그인해 주세요.`)
  let snap: AccountSnapshot
  try {
    snap = JSON.parse(raw) as AccountSnapshot
  } catch {
    snap = { creds: '', account: null }
  }
  if (!snap.creds || !snap.account) {
    throw new Error(`'${email}' 계정 데이터가 손상됐어요 — 설정 → Account에서 다시 로그인해 주세요.`)
  }
  const dir = path.join(ACCOUNTS_DIR, accountSlug(email))
  fs.mkdirSync(dir, { recursive: true })
  const credPath = path.join(dir, '.credentials.json')
  if (credsExpiresAt(snap.creds) >= credsExpiresAt(readFileOrNull(credPath))) fs.writeFileSync(credPath, snap.creds)
  // 신원: 폴더의 .claude.json에 oauthAccount·userID를 병합(CLI가 적어둔 다른 상태는 보존)
  const cjPath = path.join(dir, '.claude.json')
  const cj = readJson(cjPath) ?? {}
  cj.oauthAccount = snap.account
  if (snap.userID !== undefined) cj.userID = snap.userID
  if (cj.hasCompletedOnboarding === undefined) cj.hasCompletedOnboarding = true
  fs.writeFileSync(cjPath, JSON.stringify(cj, null, 2))
  linkSharedState(dir)
  return dir
}

// 실행이 끝난 뒤 호출 — 계정 폴더에서 CLI가 리프레시한 토큰을 암호화 백업에 반영.
export function syncAccountTokens(email: string): void {
  const f = readStoreFile()
  const target = f.accounts.find((a) => a.email === email)
  if (!target) return
  const dirCreds = readFileOrNull(path.join(ACCOUNTS_DIR, accountSlug(email), '.credentials.json'))
  if (!dirCreds) return
  const raw = decCreds(target.credEnc)
  if (!raw) return
  let snap: AccountSnapshot
  try {
    snap = JSON.parse(raw) as AccountSnapshot
  } catch {
    return
  }
  if (dirCreds === snap.creds) return // 변화 없음
  if (credsExpiresAt(dirCreds) <= credsExpiresAt(snap.creds)) return // 껍데기/후퇴 토큰 가드
  const credEnc = encCreds(JSON.stringify({ ...snap, creds: dirCreds }))
  if (!credEnc) return
  writeStoreFile(
    f.accounts.map((a) => (a.email === email ? { ...a, credEnc } : a)),
    f.defaultEmail
  )
}

// 계정을 목록에서 지울 때 물질화된 폴더도 정리한다. 폴더 안의 정션이 공유 원본을
// 가리키므로, 재귀 삭제 전에 공유 링크를 먼저 끊어 원본이 절대 지워지지 않게 한다
// (rmSync는 심링크를 따라가지 않지만, 원본이 세션 기록 전체라 이중으로 방어한다).
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

// 계정의 usage 조회용 액세스 토큰 — 계정 폴더(살아있는 토큰)와 암호화 백업 중 신선한 쪽.
// 만료·부재·복호화 실패는 null(401 확정이거나 조회 불가 — 표시만 빠지고, 실행하면 CLI가
// 리프레시한다).
export function accountAccessToken(email: string): string | null {
  const target = readStore().find((a) => a.email === email)
  if (!target) return null
  let best: string | null = null
  const raw = decCreds(target.credEnc)
  if (raw) {
    try {
      best = (JSON.parse(raw) as AccountSnapshot).creds || null
    } catch {
      /* 손상된 백업 — 폴더 후보로 넘어간다 */
    }
  }
  const dirCreds = readFileOrNull(path.join(ACCOUNTS_DIR, accountSlug(email), '.credentials.json'))
  if (credsExpiresAt(dirCreds) > credsExpiresAt(best)) best = dirCreds
  if (!best) return null
  try {
    const o = (JSON.parse(best) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } }).claudeAiOauth
    if (!o?.accessToken) return null
    if (typeof o.expiresAt === 'number' && o.expiresAt <= Date.now()) return null
    return o.accessToken
  } catch {
    return null
  }
}

// ── 만료 토큰 리프레시 — 한도 조회가 "실행 후"가 아니라 언제든 뜨게 ──────
// 토큰은 실행 중 CLI만 갱신하므로, 오래 안 쓴 계정은 만료돼 게이지가 비어 있었다.
// CLI와 같은 공개 클라이언트(로그인 URL 실측의 client_id)로 refresh_token을 교환하고,
// 회전된 refresh 토큰까지 폴더+백업에 즉시 되써서 어느 쪽도 죽은 토큰을 남기지 않는다.
// 같은 계정 동시 요청은 단일 비행으로 합쳐 이중 회전을 막는다.
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const OAUTH_TOKEN_URLS = ['https://console.anthropic.com/v1/oauth/token', 'https://platform.claude.com/v1/oauth/token']
const refreshInflight = new Map<string, Promise<string | null>>()

// force=true는 시간상 유효해 보여도 리프레시한다 — 401을 맞은 토큰(다른 프로세스가
// 그랜트를 회전시킨 경우 등)의 1회 재시도용. 리프레시 토큰까지 죽었으면 null(재로그인 필요).
export async function freshAccountToken(email: string, force = false): Promise<string | null> {
  if (!force) {
    const now = accountAccessToken(email)
    if (now) return now
  }
  const inflight = refreshInflight.get(email)
  if (inflight) return inflight
  const p = refreshAccountToken(email).finally(() => refreshInflight.delete(email))
  refreshInflight.set(email, p)
  return p
}

async function refreshAccountToken(email: string): Promise<string | null> {
  const target = readStore().find((a) => a.email === email)
  if (!target) return null
  // 가장 신선한 크리덴셜 원문(폴더 > 백업)에서 refreshToken을 꺼낸다
  const dirCreds = readFileOrNull(path.join(ACCOUNTS_DIR, accountSlug(email), '.credentials.json'))
  let backup: string | null = null
  const snapRaw = decCreds(target.credEnc)
  let snap: AccountSnapshot | null = null
  try {
    snap = snapRaw ? (JSON.parse(snapRaw) as AccountSnapshot) : null
    backup = snap?.creds ?? null
  } catch {
    /* 손상된 백업 — 폴더 후보만 */
  }
  const base = credsExpiresAt(dirCreds) >= credsExpiresAt(backup) ? dirCreds : backup
  if (!base) return null
  let parsed: Record<string, unknown>
  let oauth: { refreshToken?: string } & Record<string, unknown>
  try {
    parsed = JSON.parse(base) as Record<string, unknown>
    oauth = (parsed.claudeAiOauth ?? {}) as typeof oauth
  } catch {
    return null
  }
  if (!oauth.refreshToken) return null
  for (const url of OAUTH_TOKEN_URLS) {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 10000)
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: OAUTH_CLIENT_ID }),
        signal: ctrl.signal
      })
      clearTimeout(t)
      if (!res.ok) continue // 4xx면 회전 없음 — 다음 엔드포인트 시도
      const j = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number }
      if (!j.access_token) continue
      const nextRaw = JSON.stringify({
        ...parsed,
        claudeAiOauth: {
          ...oauth,
          accessToken: j.access_token,
          refreshToken: j.refresh_token ?? oauth.refreshToken,
          expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000
        }
      })
      // 회전된 refresh 토큰 유실 방지 — 폴더와 암호화 백업 둘 다 즉시 갱신
      try {
        const dir = path.join(ACCOUNTS_DIR, accountSlug(email))
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, '.credentials.json'), nextRaw)
      } catch {
        /* ignore */
      }
      if (snap) {
        const credEnc = encCreds(JSON.stringify({ ...snap, creds: nextRaw }))
        if (credEnc) {
          const f = readStoreFile()
          writeStoreFile(
            f.accounts.map((a) => (a.email === email ? { ...a, credEnc } : a)),
            f.defaultEmail
          )
        }
      }
      return j.access_token
    } catch {
      /* 네트워크 오류 — 다음 엔드포인트 */
    }
  }
  return null
}

// ── usage API 레이트리밋 대응 — 실측: 같은 IP의 병렬 2건 중 1건이 429로 튕기고,
// 짧은 간격의 연속 호출도 튕긴다("게이지가 둘 중 하나만 나오는" 증상의 진짜 원인).
// 전 프로세스의 usage 호출을 하나의 큐로 직렬화하고 호출 사이 간격을 둔다 —
// getUsage(index.ts)도 같은 큐를 쓴다. 결과는 계정별 캐시 + 실패(429 등) 시 마지막
// 성공값 유지 — 게이지가 깜빡이며 사라지지 않는다.
let usageChain: Promise<unknown> = Promise.resolve()
const USAGE_GAP_MS = 1200
export function usageSlot<T>(fn: () => Promise<T>): Promise<T> {
  const run = usageChain.then(fn, fn)
  usageChain = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, USAGE_GAP_MS)))
  return run
}
const acctUsageCache = new Map<string, { at: number; data: AccountUsage }>()
const ACCT_USAGE_TTL = 2 * 60 * 1000
// 캐시는 디스크에도 영속화(민감정보 아님 — 퍼센트뿐) — 앱을 켜자마자 마지막 값이 바로
// 보이고, 레이트리밋으로 첫 조회가 늦어도 게이지가 비지 않는다.
const USAGE_CACHE_PATH = path.join(APP_HOME, 'usage-cache.json')
try {
  const j = JSON.parse(fs.readFileSync(USAGE_CACHE_PATH, 'utf8')) as Record<string, { at: number; data: AccountUsage }>
  for (const [k, v] of Object.entries(j)) if (v && v.data) acctUsageCache.set(k, v)
} catch {
  /* 없음/손상 — 빈 캐시로 시작 */
}
function saveUsageCache(): void {
  try {
    fs.mkdirSync(APP_HOME, { recursive: true })
    fs.writeFileSync(USAGE_CACHE_PATH, JSON.stringify(Object.fromEntries(acctUsageCache)))
  } catch {
    /* ignore */
  }
}

// 계정 1건의 한도 조회 — null이면 실패(429 포함, 호출부가 마지막 성공값으로 폴백).
// 401/403이면 강제 리프레시 후 1회 재시도 — 시간상 유효해 보여도 서버에서 무효화된
// 토큰(다른 프로세스의 그랜트 회전 등)을 걸러낸다.
async function fetchAccountUsage(email: string): Promise<AccountUsage | null> {
  const token = await freshAccountToken(email)
  if (!token) return null
  try {
    const hit = async (tk: string): Promise<Response> => {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 5000)
      try {
        return await fetch('https://api.anthropic.com/api/oauth/usage', {
          headers: { Authorization: 'Bearer ' + tk, 'anthropic-beta': 'oauth-2025-04-20' },
          signal: ctrl.signal
        })
      } finally {
        clearTimeout(t)
      }
    }
    let res = await hit(token)
    if (res.status === 401 || res.status === 403) {
      const retry = await freshAccountToken(email, true)
      if (!retry || retry === token) return null
      res = await hit(retry)
    }
    if (res.status === 429) {
      // 예산이 매우 빡빡한 엔드포인트(분당 1~2건 실측) — Retry-After만큼 기다렸다 1회 재시도.
      // 이 대기는 usageSlot 큐 안이라 다른 usage 호출도 자연히 뒤로 밀린다(추가 429 방지).
      const ra = parseInt(res.headers.get('retry-after') ?? '', 10)
      await new Promise((r) => setTimeout(r, Math.min(Number.isNaN(ra) ? 15000 : ra * 1000, 30000)))
      res = await hit(token)
    }
    if (!res.ok) return null
    const j = (await res.json()) as {
      five_hour?: { utilization?: number | string; resets_at?: string }
      seven_day?: { utilization?: number | string; resets_at?: string }
      limits?: { kind?: string; percent?: number; resets_at?: string; scope?: { model?: { display_name?: string } | null } | null }[]
    }
    const pct = (u?: { utilization?: number | string }): number | null => {
      if (!u) return null
      const n = parseFloat(String(u.utilization ?? ''))
      return isNaN(n) ? null : Math.max(0, Math.min(100, Math.round(n)))
    }
    // 초기화 시각(ISO) → unix 초 — getUsage(fetchUsage)와 같은 규칙
    const toTs = (s?: string): number | null => {
      if (!s) return null
      const ms = Date.parse(s)
      return isNaN(ms) ? null : Math.floor(ms / 1000)
    }
    // Fable 5 주간 한도: limits[]의 weekly_scoped + model 이름에 'fable' (getUsage와 같은 규칙)
    const fable = Array.isArray(j.limits)
      ? j.limits.find((l) => l?.kind === 'weekly_scoped' && (l.scope?.model?.display_name ?? '').toLowerCase().includes('fable'))
      : undefined
    return {
      email,
      fiveHourPct: pct(j.five_hour),
      weeklyPct: pct(j.seven_day),
      fablePct: fable && typeof fable.percent === 'number' ? Math.max(0, Math.min(100, Math.round(fable.percent))) : null,
      fiveHourResetsAt: toTs(j.five_hour?.resets_at),
      weeklyResetsAt: toTs(j.seven_day?.resets_at),
      fableResetsAt: toTs(fable?.resets_at)
    }
  } catch {
    return null
  }
}

// 등록 계정별 한도 사용률 — 캐시(2분)가 신선하면 그대로, 아니면 큐를 통해 순차 조회.
export async function accountsUsage(): Promise<AccountUsage[]> {
  const rows = readStore().map(async (a): Promise<AccountUsage> => {
    const cached = acctUsageCache.get(a.email)
    if (cached && Date.now() - cached.at < ACCT_USAGE_TTL) return cached.data
    const fresh = await usageSlot(() => fetchAccountUsage(a.email))
    if (fresh) {
      acctUsageCache.set(a.email, { at: Date.now(), data: fresh })
      saveUsageCache()
      return fresh
    }
    // 실패 — 마지막 성공값 유지(다음 주기에 재시도), 그것도 없으면 빈 값
    return cached?.data ?? { email: a.email, fiveHourPct: null, weeklyPct: null, fablePct: null }
  })
  return Promise.all(rows)
}

// ── 로그인/로그아웃 — 항상 CONFIG_DIR 격리, 전역 ~/.claude 불가침 ──
// 로그인 전엔 이메일을 모르므로 임시 폴더(~/.agentcodegui/login)로 로그인하고, 완료 후
// 신원을 읽어 스토어에 편입 + 계정 폴더로 물질화한다. "계정 추가"가 기존 계정을 절대
// 위협하지 않는다(전역 크리덴셜 덮어쓰기 자체가 없음).
const LOGIN_DIR = path.join(APP_HOME, 'login')

// 진행 중인 로그인 자식 프로세스(한 번에 하나) — 취소로 죽일 수 있게 보관
let loginProc: ChildProcess | null = null

export function authLoginCancel(): void {
  if (loginProc) {
    try {
      loginProc.kill()
    } catch {
      /* ignore */
    }
    loginProc = null
  }
}

export async function authLogin(wc: WebContents, useConsole: boolean): Promise<AuthStatus & { ok: boolean }> {
  const bin = claudeBin()
  if (!bin) return { ok: false, loggedIn: false, error: 'claude 실행 파일을 찾지 못했어요' }
  authLoginCancel() // 이전 시도가 있으면 정리
  try {
    fs.rmSync(LOGIN_DIR, { recursive: true, force: true }) // 이전의 부분 상태 제거
    fs.mkdirSync(LOGIN_DIR, { recursive: true })
  } catch {
    /* ignore */
  }
  return new Promise((resolve) => {
    const args = ['auth', 'login', useConsole ? '--console' : '--claudeai']
    const child = spawn(bin, args, { windowsHide: true, env: { ...process.env, CLAUDE_CONFIG_DIR: LOGIN_DIR } })
    loginProc = child
    let opened = false
    // CLI가 출력하는 OAuth URL을 잡아 브라우저로 연다(CLI가 자동으로 열기도 하지만 이중 안전).
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
    const timer = setTimeout(() => authLoginCancel(), 5 * 60 * 1000) // 5분 후 자동 중단
    const finish = async (): Promise<void> => {
      clearTimeout(timer)
      if (loginProc === child) loginProc = null
      const status = await statusForDir(LOGIN_DIR)
      if (status.loggedIn && status.email) importAccountFromDir(LOGIN_DIR, status)
      try {
        fs.rmSync(LOGIN_DIR, { recursive: true, force: true }) // 평문 토큰을 임시 자리에 남기지 않는다
      } catch {
        /* ignore */
      }
      resolve({ ok: !!(status.loggedIn && status.email), ...status })
    }
    child.on('close', () => void finish())
    child.on('error', () => void finish())
  })
}

// config 폴더의 { 토큰 + 신원 }을 스토어에 편입하고 계정 폴더로 물질화한다.
// (로그인 완료 + 마이그레이션의 전역 가져오기가 공용)
function importAccountFromDir(dir: string, status: AuthStatus): void {
  const email = status.email
  if (!email) return
  const creds = readFileOrNull(path.join(dir, '.credentials.json'))
  if (!creds) return
  const cj = readJson(path.join(dir, '.claude.json'))
  // 신원 객체가 없으면(비정상) 이메일로 합성 — accountRunDir가 신원을 요구한다
  const account = cj?.oauthAccount ?? { emailAddress: email }
  const userID = typeof cj?.userID === 'string' ? cj.userID : undefined
  const credEnc = encCreds(JSON.stringify({ creds, account, userID } satisfies AccountSnapshot))
  if (!credEnc) return
  const f = readStoreFile()
  const accounts = f.accounts.filter((a) => a.email !== email)
  accounts.push({ email, subscriptionType: status.subscriptionType, credEnc })
  // 첫 계정이면 자동으로 기본 계정이 된다(writeStoreFile의 폴백)
  writeStoreFile(accounts, f.defaultEmail)
  try {
    accountRunDir(email) // 계정 폴더 물질화 + 공유 정션 연결
  } catch {
    /* 다음 실행 때 다시 시도된다 */
  }
}

// 계정 로그아웃 — 그 계정 폴더를 CONFIG_DIR로 CLI 로그아웃(서버 토큰 해지) 후 스토어·폴더
// 제거. 해지 실패(네트워크 등)여도 로컬은 지운다 — 목록에 거짓 항목을 남기지 않는다.
export async function authLogout(email: string): Promise<AccountInfo[]> {
  const bin = claudeBin()
  let dir: string | null = null
  try {
    dir = accountRunDir(email) // 폴더가 없으면 백업에서 물질화해서라도 해지를 시도
  } catch {
    /* 스냅샷 손상 등 — 해지 없이 로컬만 제거 */
  }
  if (bin && dir) {
    await new Promise<void>((resolve) => {
      execFile(
        bin,
        ['auth', 'logout'],
        { timeout: 20000, windowsHide: true, env: { ...process.env, CLAUDE_CONFIG_DIR: dir } },
        () => resolve()
      )
    })
  }
  return removeAccount(email)
}

// ── 1회 마이그레이션 — 전역 ~/.claude 시대의 상태를 앱 소유로 이관 ──
// (1) 세션 기록·도구 환경을 ~/.claude에서 shared로 복사(원본은 남긴다 — 터미널 CLI 무손상)
// (2) 기존 계정 폴더의 ~/.claude행 정션을 끊어 다음 물질화가 shared로 다시 잇게
// (3) 전역에 로그인돼 있던 계정을 스토어로 가져오기(이후 전역은 다시 보지 않는다)
// (4) 스토어 v2 → v3 승격(defaultEmail 채움)
// 마커 파일로 1회만 실행. 앱 시작 시(창 생성 전) await — 복사 완료 전 실행되는 레이스 방지.
const MIGRATED_MARK = path.join(SHARED_ROOT, '.migrated-v3')

export async function migrateAccounts(): Promise<void> {
  const f = readStoreFile()
  if (fs.existsSync(MIGRATED_MARK)) {
    // 마이그레이션 후에도 v2 파일이 남은 희귀 경로(마이그레이션 중 크래시) — 승격만 재시도
    if (f.version !== STORE_VERSION) writeStoreFile(f.accounts, f.defaultEmail)
    return
  }
  const home = path.join(os.homedir(), '.claude')
  ensureSharedRoot()
  // (1) 세션 기록 1회 복사 — shared 쪽이 비어 있을 때만(재실행 시 사용자 데이터 보호)
  for (const name of SHARED_DIRS) {
    const src = path.join(home, name)
    const dst = path.join(SHARED_ROOT, name)
    try {
      if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) continue
      if (fs.readdirSync(dst).length > 0) continue
      await fs.promises.cp(src, dst, { recursive: true, force: false, errorOnExist: false })
    } catch {
      /* 항목 단위 실패는 무시 — 세션 일부가 안 옮겨질 뿐 */
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
  // (2) 기존 계정 폴더의 정션 재배선 — ~/.claude행 링크를 끊는다(다음 물질화가 shared로)
  try {
    for (const slug of fs.readdirSync(ACCOUNTS_DIR)) {
      for (const name of SHARED_DIRS) {
        try {
          const p = path.join(ACCOUNTS_DIR, slug, name)
          if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p)
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* accounts 폴더 없음 */
  }
  // (3) 전역 로그인 가져오기 — 신원+토큰이 있고, 아직 등록 안 됐고, 같은 토큰이 다른
  // 이메일로 저장돼 있지 않을 때만(신원·토큰 어긋난 혼합 상태 가드)
  const creds = readFileOrNull(path.join(home, '.credentials.json'))
  const cj = readJson(path.join(os.homedir(), '.claude.json'))
  const acc = cj?.oauthAccount as { emailAddress?: string } | undefined
  const email = typeof acc?.emailAddress === 'string' ? acc.emailAddress : null
  if (creds && email && !f.accounts.some((a) => a.email === email)) {
    const collided = f.accounts.some((a) => {
      const raw = decCreds(a.credEnc)
      if (!raw) return false
      try {
        return (JSON.parse(raw) as AccountSnapshot).creds === creds
      } catch {
        return false
      }
    })
    if (!collided) {
      // 플랜 이름은 전역 CLI 상태에서 한 번만 — 실패해도 가져오기는 진행(표시만 빠짐)
      const st = await globalAuthStatus()
      const credEnc = encCreds(
        JSON.stringify({ creds, account: cj!.oauthAccount, userID: typeof cj!.userID === 'string' ? cj!.userID : undefined } satisfies AccountSnapshot)
      )
      if (credEnc) f.accounts.push({ email, subscriptionType: st.subscriptionType, credEnc })
    }
  }
  // (4) v3 승격 + 기본 계정(기존 defaultEmail > 전역에 로그인돼 있던 계정 > 첫 계정 폴백)
  const globalDefault = email && f.accounts.some((a) => a.email === email) ? email : undefined
  writeStoreFile(f.accounts, f.defaultEmail ?? globalDefault)
  try {
    fs.writeFileSync(MIGRATED_MARK, String(Date.now()))
  } catch {
    /* ignore */
  }
}

// 전역 ~/.claude의 로그인 상태 — 마이그레이션의 플랜 이름 조회 전용(그 외 전역 조회 금지).
function globalAuthStatus(): Promise<AuthStatus> {
  const bin = claudeBin()
  if (!bin) return Promise.resolve({ loggedIn: false })
  return new Promise((resolve) => {
    execFile(bin, ['auth', 'status', '--json'], { timeout: 20000, windowsHide: true }, (_err, stdout) => {
      if (stdout && stdout.trim().startsWith('{')) return resolve(parseStatus(stdout))
      resolve({ loggedIn: false })
    })
  })
}
