/**
 * 클로드 계정(구독 OAuth) 로그인 — 번들된 네이티브 `claude` CLI의 `auth` 서브커맨드를
 * 감싼다. 로그인/로그아웃은 ~/.claude/.credentials.json 을 바꾸므로 앱 전체 실행 인증에
 * 영향을 준다(엔진은 이 크리덴셜을 그대로 읽어 구독으로 실행한다).
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, safeStorage, shell, type WebContents } from 'electron'
import { IPC } from '@shared/protocol'
import type { AuthStatus, AccountInfo, AccountUsage } from '@shared/protocol'

// 번들된 네이티브 claude 실행 파일을 찾는다(dev: 앱 node_modules, prod: asar.unpacked).
// auth 는 버전 무관하게 같은 ~/.claude 크리덴셜을 다루므로 번들본으로 충분하다.
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

export function authStatus(): Promise<AuthStatus> {
  const bin = claudeBin()
  if (!bin) return Promise.resolve({ loggedIn: false, error: 'claude 실행 파일을 찾지 못했어요' })
  return new Promise((resolve) => {
    execFile(bin, ['auth', 'status', '--json'], { timeout: 20000, windowsHide: true }, (err, stdout) => {
      // 로그아웃 상태면 CLI가 비-0으로 끝나며 JSON에 loggedIn:false를 준다 — 그대로 파싱
      if (stdout && stdout.trim().startsWith('{')) return resolve(parseStatus(stdout))
      resolve({ loggedIn: false, ...(err ? {} : {}) })
    })
  })
}

export async function authLogout(): Promise<AuthStatus> {
  const bin = claudeBin()
  if (!bin) return { loggedIn: false, error: 'claude 실행 파일을 찾지 못했어요' }
  const st = await authStatus()
  await new Promise<void>((resolve) => {
    execFile(bin, ['auth', 'logout'], { timeout: 20000, windowsHide: true }, () => resolve())
  })
  // 로그아웃은 토큰을 서버에서 해지한다 — 같은 토큰을 담은 이 계정의 저장 스냅샷도 함께
  // 죽는다. 목록에 남겨두면 '변경'이 반드시 실패하는 거짓 항목이 되므로 같이 제거한다
  // (채팅별 오버라이드용으로 물질화된 격리 폴더도 같은 토큰이라 함께 정리).
  if (st.loggedIn && st.email) {
    writeStore(readStore().filter((a) => a.email !== st.email))
    deleteAccountDir(st.email)
  }
  return authStatus()
}

// ── 다중 계정 저장/전환 ───────────────────────────────────────
// Claude는 활성 계정 하나(~/.claude/.credentials.json)만 둔다. 각 계정의 크리덴셜 파일을
// 통째로 스냅샷해 앱 홈에 (safeStorage로 암호화) 보관해두면, "변경"은 그 스냅샷을
// .credentials.json 으로 되써서 재로그인 없이 전환된다(리프레시 토큰이 유효한 한).
// 계정 신원(이메일·org)은 .credentials.json이 아니라 ~/.claude.json의 oauthAccount에 있다.
// 그래서 한 계정 = { .credentials.json(토큰) + .claude.json의 oauthAccount·userID(신원) } 를
// 함께 스냅샷해야 한다. 토큰만 바꾸면 status가 이전 신원을 그대로 반환한다.
const CRED_PATH = path.join(os.homedir(), '.claude', '.credentials.json')
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json')
const STORE_PATH = path.join(os.homedir(), '.agentcodegui', 'accounts.json')
const STORE_VERSION = 2 // 포맷 변경 시 올린다(구버전 스토어는 자동 폐기)

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

function readJson(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function readStore(): StoredAccount[] {
  try {
    const j = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as { version?: number; accounts?: StoredAccount[] }
    if (j.version !== STORE_VERSION) return [] // 구버전 포맷은 신원이 없어 무효 → 폐기
    return Array.isArray(j.accounts) ? j.accounts : []
  } catch {
    return []
  }
}
function writeStore(accounts: StoredAccount[]): void {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
    fs.writeFileSync(STORE_PATH, JSON.stringify({ version: STORE_VERSION, accounts }, null, 2))
  } catch {
    /* ignore */
  }
}

// 현재 활성 계정의 { 토큰 + 신원 } 스냅샷
function currentSnapshot(): AccountSnapshot | null {
  const creds = readActiveCreds()
  const cj = readJson(CLAUDE_JSON)
  if (!creds || !cj || !cj.oauthAccount) return null
  return { creds, account: cj.oauthAccount, userID: typeof cj.userID === 'string' ? cj.userID : undefined }
}

// 스냅샷을 활성 계정으로 되쓴다(.credentials.json 토큰 + .claude.json의 oauthAccount·userID)
function applySnapshot(snap: AccountSnapshot): boolean {
  if (!snap.creds || !snap.account) return false
  if (!writeActiveCreds(snap.creds)) return false
  const cj = readJson(CLAUDE_JSON) ?? {}
  cj.oauthAccount = snap.account
  if (snap.userID !== undefined) cj.userID = snap.userID
  try {
    fs.writeFileSync(CLAUDE_JSON, JSON.stringify(cj, null, 2))
    return true
  } catch {
    return false
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
function readActiveCreds(): string | null {
  try {
    return fs.readFileSync(CRED_PATH, 'utf8')
  } catch {
    return null
  }
}
function writeActiveCreds(raw: string): boolean {
  try {
    fs.mkdirSync(path.dirname(CRED_PATH), { recursive: true })
    fs.writeFileSync(CRED_PATH, raw)
    return true
  } catch {
    return false
  }
}

// 현재 활성 로그인을 스냅샷해 저장(그 계정의 최신 토큰을 보존). 로그인 성공 후, 전환 직전에 호출.
async function snapshotCurrent(): Promise<void> {
  const st = await authStatus()
  if (!st.loggedIn || !st.email) return
  const snap = currentSnapshot()
  if (!snap) return
  // 오염 방지: 지금 크리덴셜(토큰)이 '다른 이메일'로 저장된 토큰과 동일하면, 신원(.claude.json)과
  // 토큰(.credentials.json)이 어긋난 혼합 상태다(외부 claude 프로세스가 신원만 되쓴 직후 등).
  // 이대로 저장하면 이 이메일 항목이 남의 토큰으로 오염되므로(전환이 무동작이 되는 원인) 건너뛴다.
  for (const a of readStore()) {
    if (a.email === st.email) continue
    const raw = decCreds(a.credEnc)
    if (!raw) continue
    try {
      if ((JSON.parse(raw) as AccountSnapshot).creds === snap.creds) return
    } catch {
      /* ignore */
    }
  }
  const credEnc = encCreds(JSON.stringify(snap))
  if (!credEnc) return
  const store = readStore().filter((a) => a.email !== st.email)
  store.push({ email: st.email, subscriptionType: st.subscriptionType, credEnc })
  writeStore(store)
}

export async function listAccounts(): Promise<AccountInfo[]> {
  const st = await authStatus()
  // 아직 저장 안 된 현재 로그인은 목록에 자동 편입
  if (st.loggedIn && st.email && !readStore().some((a) => a.email === st.email)) await snapshotCurrent()
  return readStore().map((a) => ({
    email: a.email,
    subscriptionType: a.subscriptionType,
    active: !!st.loggedIn && a.email === st.email
  }))
}

// 스냅샷 토큰의 생사 검증 — 로그아웃 등으로 서버에서 해지된 토큰을 복원하면 CLI가 401을
// 맞고 크리덴셜을 껍데기로 덮어써 "Not logged in"이 된다(디버그 로그로 실측). 만료 전인데
// 401/403이면 확실히 죽은 것. 이미 만료된 액세스 토큰은 401이 정상(리프레시로 살아날 수
// 있음)이라 판정 불가 → 'unknown'으로 전환을 막지 않는다. 네트워크 오류도 'unknown'.
async function validateSnapshotToken(credsRaw: string): Promise<'ok' | 'dead' | 'unknown'> {
  try {
    const j = JSON.parse(credsRaw) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } }
    const o = j.claudeAiOauth
    if (!o?.accessToken) return 'dead'
    if (typeof o.expiresAt === 'number' && o.expiresAt <= Date.now()) return 'unknown'
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 5000)
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: 'Bearer ' + o.accessToken, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: ctrl.signal
    })
    clearTimeout(t)
    if (res.status === 401 || res.status === 403) return 'dead'
    return 'ok'
  } catch {
    return 'unknown'
  }
}

export async function switchAccount(email: string): Promise<AuthStatus> {
  const st = await authStatus()
  if (st.loggedIn && st.email === email) return st // 이미 활성
  await snapshotCurrent() // 나가는 계정의 최신 토큰·신원 보존
  const target = readStore().find((a) => a.email === email)
  if (!target) return { ...st, error: '저장된 계정을 찾지 못했어요' }
  const rawSnap = decCreds(target.credEnc)
  if (!rawSnap) return { ...st, error: '계정 전환에 실패했어요' }
  let snap: AccountSnapshot
  try {
    snap = JSON.parse(rawSnap) as AccountSnapshot
  } catch {
    return { ...st, error: '계정 데이터가 손상됐어요 — 다시 로그인해 추가해 주세요' }
  }
  // 죽은 토큰은 적용하지 않는다 — 적용하면 현재 로그인까지 깨진다(껍데기 덮어쓰기).
  if ((await validateSnapshotToken(snap.creds)) === 'dead') {
    writeStore(readStore().filter((a) => a.email !== email))
    return { ...st, error: '이 계정의 저장된 로그인이 해지됐어요(로그아웃 등) — 다시 로그인해 추가해 주세요' }
  }
  if (!applySnapshot(snap)) return { ...st, error: '계정 전환에 실패했어요' }
  return authStatus()
}

export async function removeAccount(email: string): Promise<AccountInfo[]> {
  writeStore(readStore().filter((a) => a.email !== email))
  deleteAccountDir(email)
  return listAccounts()
}

// ── 채팅별 계정 오버라이드 (CLAUDE_CONFIG_DIR) ─────────────────
// 전역 로그인(~/.claude)은 한 계정뿐이라, 채팅마다 다른 계정으로 실행하려면 계정별 격리
// config 폴더가 필요하다. 등록 계정의 스냅샷을 ~/.agentcodegui/accounts/<slug>/ 에
// 물질화(.credentials.json 토큰 + .claude.json 신원)하고, 엔진이 CLAUDE_CONFIG_DIR로
// 그 폴더를 가리키면 그 실행만 해당 계정으로 인증된다(빈 폴더=로그아웃, 토큰+신원을
// 넣은 폴더=그 계정 인식 — 실측 검증).
// - 세션 기록(projects·sessions 등)은 ~/.claude로 정션 링크 → resume이 계정과 무관하게
//   이어지고, 채팅 중간에 계정을 바꿔도 대화 맥락이 유지된다. skills·agents·plugins·
//   commands도 링크해 전역과 같은 도구 환경을 쓴다(Windows 정션은 관리자 권한 불필요).
// - settings.json·CLAUDE.md는 파일이라 링크 대신 물질화 때마다 복사한다(수 KB).
// - CLI가 폴더 안에서 토큰을 스스로 리프레시하므로, 실행이 끝나면 syncAccountTokens가
//   폴더의 더 신선한 토큰을 암호화 스냅샷에 되쓴다. 가드(accessToken 존재 + expiresAt
//   전진)를 통과할 때만 — 401을 맞아 껍데기로 덮인 크리덴셜이 스냅샷을 오염시키지
//   않도록(1.6.2에서 잡은 스냅샷 오염과 같은 계열의 방어).
const ACCOUNTS_DIR = path.join(os.homedir(), '.agentcodegui', 'accounts')
// 전역 ~/.claude와 공유할 폴더(정션 링크) — 세션 기록 + 도구 환경. 파일은 복사.
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
// 물질화(어느 쪽 토큰을 남길지)와 되싱크(스냅샷을 갱신할지) 판정에 쓴다.
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

// 전역 활성 로그인의 이메일 — CLI를 띄우지 않고 ~/.claude.json의 신원을 직접 읽는다
// (실행마다 호출되는 경로라 authStatus의 프로세스 스폰은 과하다).
export function activeAccountEmail(): string | null {
  const acc = readJson(CLAUDE_JSON)?.oauthAccount as { emailAddress?: string } | undefined
  return typeof acc?.emailAddress === 'string' ? acc.emailAddress : null
}

// 세션 기록·도구 환경을 전역 ~/.claude와 공유(정션 링크 + 설정 파일 복사). 링크 실패는
// 그 항목만 격리 동작이 될 뿐 치명적이지 않아 조용히 넘어간다. CLI가 먼저 실폴더를
// 만들어뒀으면 데이터 보존을 우선해 그대로 둔다.
function linkSharedState(dir: string): void {
  const home = path.join(os.homedir(), '.claude')
  for (const name of SHARED_DIRS) {
    const src = path.join(home, name)
    const dst = path.join(dir, name)
    try {
      if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) continue
      try {
        fs.lstatSync(dst)
        continue // 이미 있음(링크든 실폴더든) — 그대로 둔다
      } catch {
        /* 없음 → 링크 생성 */
      }
      fs.symlinkSync(src, dst, 'junction')
    } catch {
      /* ignore */
    }
  }
  for (const name of COPIED_FILES) {
    try {
      const src = path.join(home, name)
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, name))
    } catch {
      /* ignore */
    }
  }
}

// 실행용 계정 해석 — 전역 활성 계정이면 null(오버라이드 불필요 — 같은 토큰을 두 곳에서
// 리프레시하다 서로 무효화하는 사고를 피한다), 다른 등록 계정이면 물질화된 격리 config
// 폴더 경로. 스냅샷이 없거나 깨졌으면 던진다(엔진이 에러 카드로 표시).
export function accountRunDir(email: string): string | null {
  if (activeAccountEmail() === email) return null
  const target = readStore().find((a) => a.email === email)
  if (!target) throw new Error(`'${email}' 계정이 저장 목록에 없어요 — 설정 → Account에서 다시 추가해 주세요.`)
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
  // 토큰: 폴더 쪽이 더 신선하면(직전 실행에서 CLI가 리프레시) 남겨두고, 스냅샷이 더
  // 신선하면(재로그인 등) 스냅샷으로 덮는다.
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

// 계정 오버라이드 실행이 끝난 뒤 호출 — 격리 폴더에서 리프레시된 토큰을 스냅샷에 반영.
export function syncAccountTokens(email: string): void {
  const store = readStore()
  const target = store.find((a) => a.email === email)
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
  writeStore(store.map((a) => (a.email === email ? { ...a, credEnc } : a)))
}

// 계정을 목록에서 지울 때 물질화된 폴더도 정리한다. 폴더 안의 정션이 ~/.claude를
// 가리키므로, 재귀 삭제 전에 공유 링크를 먼저 끊어 원본이 절대 지워지지 않게 한다
// (rmSync는 심링크를 따라가지 않지만, 원본이 사용자 홈이라 이중으로 방어한다).
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

// 저장된 계정별 한도 사용률 — 전환 없이 각 스냅샷의 액세스 토큰으로 usage API를 병렬 조회.
// 만료된 토큰은 조회하지 않는다(401 확정 — 전환하면 CLI가 리프레시하므로 전환 자체는 정상).
// 실패는 조용히 null(표시만 빠짐) — 목록 UX를 네트워크에 볼모 잡히지 않게 한다.
export async function accountsUsage(): Promise<AccountUsage[]> {
  const rows = readStore().map(async (a): Promise<AccountUsage> => {
    const empty: AccountUsage = { email: a.email, fiveHourPct: null, weeklyPct: null, fablePct: null }
    const raw = decCreds(a.credEnc)
    if (!raw) return empty
    let token: string | undefined
    let expiresAt: number | undefined
    try {
      const snap = JSON.parse(raw) as AccountSnapshot
      const o = (JSON.parse(snap.creds) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } }).claudeAiOauth
      token = o?.accessToken
      expiresAt = o?.expiresAt
    } catch {
      return empty
    }
    if (!token || (typeof expiresAt === 'number' && expiresAt <= Date.now())) return empty
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 5000)
      const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: { Authorization: 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20' },
        signal: ctrl.signal
      })
      clearTimeout(t)
      if (!res.ok) return empty
      const j = (await res.json()) as {
        five_hour?: { utilization?: number | string }
        seven_day?: { utilization?: number | string }
        limits?: { kind?: string; percent?: number; scope?: { model?: { display_name?: string } | null } | null }[]
      }
      const pct = (u?: { utilization?: number | string }): number | null => {
        if (!u) return null
        const n = parseFloat(String(u.utilization ?? ''))
        return isNaN(n) ? null : Math.max(0, Math.min(100, Math.round(n)))
      }
      // Fable 5 주간 한도: limits[]의 weekly_scoped + model 이름에 'fable' (getUsage와 같은 규칙)
      const fable = Array.isArray(j.limits)
        ? j.limits.find((l) => l?.kind === 'weekly_scoped' && (l.scope?.model?.display_name ?? '').toLowerCase().includes('fable'))
        : undefined
      return {
        email: a.email,
        fiveHourPct: pct(j.five_hour),
        weeklyPct: pct(j.seven_day),
        fablePct: fable && typeof fable.percent === 'number' ? Math.max(0, Math.min(100, Math.round(fable.percent))) : null
      }
    } catch {
      return empty
    }
  })
  return Promise.all(rows)
}

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
  // 지금 로그인된 계정을 먼저 보존한다 — 로그인은 .credentials.json을 덮어써서, 이게 없으면
  // 기존 계정이 사라진다("계정 추가"가 되도록)
  await snapshotCurrent()
  return new Promise((resolve) => {
    const args = ['auth', 'login', useConsole ? '--console' : '--claudeai']
    const child = spawn(bin, args, { windowsHide: true })
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
      const status = await authStatus()
      if (status.loggedIn) await snapshotCurrent() // 새로 로그인된 계정을 저장 목록에 편입
      resolve({ ok: status.loggedIn, ...status })
    }
    child.on('close', () => void finish())
    child.on('error', () => void finish())
  })
}
