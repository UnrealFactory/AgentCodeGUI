/**
 * M5 R1 크리틱 — "2.6.2가 우리가 쓴 파일을 그대로 읽는가" 하네스.
 *
 * src/main/auth.ts의 읽기/쓰기 로직을 **그대로 베껴** Electron safeStorage 위에서 돌린다.
 * APP_HOME은 env(CCG_HOME)로 갈아끼우고, userData는 실 설치본의 Local State 사본을 쓴다.
 * 사용자 실홈은 건드리지 않는다 — 전부 스크래치 사본.
 */
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const APP_HOME = process.env.CCG_HOME
const USERDATA = process.env.CCG_USERDATA
if (!APP_HOME || !USERDATA) {
  console.error('CCG_HOME / CCG_USERDATA 필요')
  process.exit(2)
}
app.setPath('userData', USERDATA)

const STORE_PATH = path.join(APP_HOME, 'accounts.json')
const STORE_VERSION = 3

// ── auth.ts 원문 이식 ──────────────────────────────────────────────────────
function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
function readStoreFile() {
  try {
    const j = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
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
function writeStoreFile(accounts, defaultEmail, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  const def = accounts.some((a) => a.email === defaultEmail) ? defaultEmail : accounts[0]?.email
  fs.writeFileSync(outPath, JSON.stringify({ version: STORE_VERSION, defaultEmail: def, accounts }, null, 2))
}
function encCreds(raw) {
  try {
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(raw).toString('base64')
      : Buffer.from(raw, 'utf8').toString('base64')
  } catch {
    return null
  }
}
function decCreds(b64) {
  try {
    const buf = Buffer.from(b64, 'base64')
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8')
  } catch (e) {
    return null
  }
}
function accountSlug(email) {
  const safe = email.toLowerCase().replace(/[^a-z0-9._-]+/g, '_')
  let h = 0
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0
  return `${safe}-${h.toString(36)}`
}
function credsExpiresAt(raw) {
  if (!raw) return 0
  try {
    const o = JSON.parse(raw).claudeAiOauth
    if (!o?.accessToken) return 0
    return typeof o.expiresAt === 'number' ? o.expiresAt : 1
  } catch {
    return 0
  }
}
function defaultAccountEmail() {
  const f = readStoreFile()
  if (f.defaultEmail && f.accounts.some((a) => a.email === f.defaultEmail)) return f.defaultEmail
  return f.accounts[0]?.email ?? null
}
/** accountRunDir의 판정부만(파일은 안 쓴다) — 2.6.2가 이 계정을 실행할 수 있는가. */
function canRun(email) {
  const target = readStoreFile().accounts.find((a) => a.email === email)
  if (!target) return { ok: false, why: 'not-registered' }
  const raw = decCreds(target.credEnc)
  if (!raw) return { ok: false, why: 'undecryptable' }
  let snap
  try {
    snap = JSON.parse(raw)
  } catch {
    snap = { creds: '', account: null }
  }
  if (!snap.creds || !snap.account) return { ok: false, why: 'corrupt' }
  const cr = JSON.parse(snap.creds).claudeAiOauth ?? {}
  return {
    ok: true,
    slug: accountSlug(email),
    hasAccess: typeof cr.accessToken === 'string' && cr.accessToken.length > 0,
    hasRefresh: typeof cr.refreshToken === 'string' && cr.refreshToken.length > 0,
    expiresAt: credsExpiresAt(snap.creds),
    identityEmail: snap.account?.emailAddress ?? null,
    hasUserID: Object.prototype.hasOwnProperty.call(snap, 'userID'),
    snapKeys: Object.keys(snap)
  }
}

app.whenReady().then(() => {
  const cmd = process.argv[process.argv.length - 1]
  const out = { cmd, encryptionAvailable: safeStorage.isEncryptionAvailable(), home: APP_HOME }
  if (cmd === 'read') {
    const f = readStoreFile()
    out.version = f.version
    out.defaultEmail = !!f.defaultEmail
    out.defaultEmailSlug = f.defaultEmail ? accountSlug(f.defaultEmail) : null
    out.count = f.accounts.length
    out.order = f.accounts.map((a) => accountSlug(a.email))
    out.resolvedDefault = defaultAccountEmail() ? accountSlug(defaultAccountEmail()) : null
    out.rows = f.accounts.map((a) => ({ slug: accountSlug(a.email), sub: a.subscriptionType, ...canRun(a.email) }))
    out.allRunnable = out.rows.every((r) => r.ok && r.hasAccess && r.hasRefresh)
  } else if (cmd === 'rewrite') {
    // 2.6.2 writeStoreFile을 그대로 돌려 산출물을 낸다(비교용)
    const f = readStoreFile()
    writeStoreFile(f.accounts, f.defaultEmail, path.join(APP_HOME, 'node-out.json'))
    out.bytes = fs.statSync(path.join(APP_HOME, 'node-out.json')).size
  } else if (cmd === 'reencrypt') {
    // 우리(Rust)가 다시 암호화한 blob을 2.6.2 safeStorage가 푸는가
    const f = readStoreFile()
    out.rows = f.accounts.map((a) => {
      const raw = decCreds(a.credEnc)
      let snapOk = false
      try {
        const s = JSON.parse(raw)
        snapOk = !!s.creds && !!s.account
      } catch {}
      return { slug: accountSlug(a.email), decrypted: raw != null, snapOk, len: a.credEnc.length }
    })
  } else if (cmd === 'seed') {
    // 합성 계정을 2.6.2 스킴으로 심는다(오염/중복 공격용). SEED_JSON = [{email,sub,creds,account,userID?}]
    const spec = JSON.parse(process.env.SEED_JSON)
    const accounts = spec.map((s) => {
      const snap = { creds: JSON.stringify(s.creds), account: s.account, userID: s.userID }
      return { email: s.email, subscriptionType: s.sub, credEnc: encCreds(JSON.stringify(snap)) }
    })
    writeStoreFile(accounts, process.env.SEED_DEFAULT || undefined, STORE_PATH)
    out.wrote = accounts.length
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  app.exit(0)
})
