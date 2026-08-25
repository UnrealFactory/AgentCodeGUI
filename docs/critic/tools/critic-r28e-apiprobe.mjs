// 최종 파리티 R2 — 「값이 있는가」 실측기 (R1의 apiprobe 재주행 + 확장)
//
//   node docs/critic/tools/critic-r28e-apiprobe.mjs tauri --exe=<경로> [--port=n] [--out=json]
//   node docs/critic/tools/critic-r28e-apiprobe.mjs electron            [--port=n] [--out=json]
//
// 화면 A/B는 **도달**만 본다. R1의 치명 4건 중 셋(T1 계정·T2 엔진·T3 한도)은 화면이
// 정상으로 뜨는데 값이 비어 있던 자리라, 같은 `window.api` 호출을 두 앱에 던져 응답을
// 마주 세운다. 부작용이 있는 호출(로그인·설치·정리·업데이트·네이티브 대화상자)은
// 부르지 않는다 — 픽스처 홈이 사용자 실홈의 `accounts.json`을 복사하고 `engines/`를
// **정션**하므로, 그쪽 쓰기는 실홈을 건드린다.
//
// R1 대비 더 보는 것:
//   · `__unimplemented` 심 경고를 채널 이름까지 수집(3.0 전용 신호)
//   · 「눌러도 안 되는」 채널을 **부작용 없는 인자**로 한 번씩 두드린다
//     (`auth:reorder-accounts`에 **현재 순서 그대로** = no-op 쓰기, `auth:login-cancel`
//      = 도는 로그인이 없을 때 no-op) — 응답이 `__unimplemented`인지만 본다
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { electronProfile, tauriProfile, cdpTargets, Cdp, killTree, sleep, REPO } from '../../../bench/lib.mjs'
import { makeFixtureHome } from '../../../bench/fixture.mjs'
import { augmentFixture } from '../../../bench/screens.mjs'

const kind = process.argv[2] ?? 'tauri'
const argv = process.argv.slice(3)
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d }
const PORT = Number(arg('port', kind === 'tauri' ? 10231 : 10230))
const OUT = path.resolve(arg('out', path.join(REPO, 'docs', 'critic', `final-parity-r2-apiprobe-${kind}.json`)))
const profile = kind === 'tauri' ? tauriProfile({ port: PORT, exe: arg('exe', undefined) }) : electronProfile({ port: PORT })
if (kind !== 'tauri') profile.args = ['.', `--remote-debugging-port=${PORT}`]
const APP_VERSION = kind === 'tauri' ? '3.0.0-beta.1' : '2.6.2'
const HOME = path.join(os.tmpdir(), `ccg-r28e-apiprobe-${kind}`)

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch { /* 잠기면 덮어쓴다 */ }
makeFixtureHome(HOME, APP_VERSION)
augmentFixture(HOME, { repo: REPO })

// ★ 실홈의 `usage-cache.json`을 **복사**해 온다(읽기만 한다 — 실홈은 안 건드린다).
//
// 왜: T3(한도)가 살아났는지 보려면 값이 있어야 하는데, 살아 있는 계정 6개에
// `auth:accounts-usage()`를 그냥 던지면 만료된 계정에서 **리프레시 토큰이 회전**한다.
// 회전은 되돌릴 수 없고 실홈 사본을 죽인다(이 라운드의 금지 규약). 캐시를 심어 두고
// `{cachedOnly:true}`로 물으면 네트워크 0회로 같은 판정을 얻는다 — 값이 오면 채널이
// 살아 있고 디스크 캐시 계층도 붙어 있다는 뜻이다.
const realCache = path.join(os.homedir(), '.agentcodegui', 'usage-cache.json')
let seededCache = false
try {
  if (fs.existsSync(realCache)) { fs.copyFileSync(realCache, path.join(HOME, 'usage-cache.json')); seededCache = true }
} catch { /* 없으면 캐시 없는 판정 */ }

const child = spawn(profile.cmd, profile.args, {
  env: { ...process.env, ...profile.env, CCG_HOME: HOME },
  cwd: profile.cwd,
  stdio: 'ignore'
})

async function connectMain(port, timeoutMs = 90000) {
  const t0 = Date.now()
  for (;;) {
    try {
      const ts = await cdpTargets(port)
      const t = ts.find((x) => x.type === 'page' && !x.url.startsWith('data:') && !/toast\.html|tray\.html/.test(x.url) && !x.url.includes('#') && /index\.html|localhost/.test(x.url))
      if (t?.webSocketDebuggerUrl) return await Cdp.connect(t.webSocketDebuggerUrl)
    } catch { /* 아직 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('main target not found')
    await sleep(80)
  }
}

const REPO_JS = JSON.stringify(REPO)
const MCPPROJ = JSON.stringify(path.join(REPO, 'bench', 'scratch', 'mcpproj'))
const PROBES = [
  // ── T3: 한도 ────────────────────────────────────────────────────────────────
  // `fresh=false` — 워크바 게이지가 부르는 그 호출. 기본 계정 **하나**만 나간다.
  ['usage.get', `window.api.getUsage(false)`],
  // 캐시만 — 네트워크 0회(위 주석). **2.6.2에는 이 옵션이 없다**(§6.7): 인자를 무시하고
  // 등록 계정 6개를 전부 조회하러 나가므로 만료된 계정에서 토큰이 회전한다. 그래서
  // 2.6.2에서는 아예 부르지 않는다 — 이 축의 A/B는 3.0 단독 실측으로 남긴다.
  ...(kind === 'tauri'
    ? [['auth.accountsUsage(cachedOnly)', `window.api.auth.accountsUsage({ cachedOnly: true }).then(l => (l||[]).map(a => JSON.stringify(a).slice(0, 150)))`]]
    : [['auth.accountsUsage(cachedOnly)', `'(2.6.2에서는 안 부른다 — cachedOnly 옵션이 없어 6계정 실조회 = 토큰 회전 위험)'`]]),
  ['codexAuth.accountsUsage', `window.api.codexAuth.accountsUsage()`],
  // ── T1: 계정 ────────────────────────────────────────────────────────────────
  ['auth.listAccounts', `window.api.auth.listAccounts().then(l => l.map(a => a.email))`],
  ['codexAuth.listAccounts', `window.api.codexAuth.listAccounts().then(l => l.map(a => a.email))`],
  // no-op 쓰기 — **현재 순서 그대로** 되보낸다. 목록이 안 바뀌므로 실홈 사본에 무해하고,
  // 미구현이면 심의 안전값 `[]`가 돌아와 즉시 갈린다.
  ['auth.reorderAccounts(noop)', `window.api.auth.listAccounts().then(l => window.api.auth.reorderAccounts(l.map(a => a.email))).then(r => ({ n: (r||[]).length }))`],
  ['codexAuth.reorderAccounts(noop)', `window.api.codexAuth.listAccounts().then(l => window.api.codexAuth.reorderAccounts(l.map(a => a.email))).then(r => ({ n: (r||[]).length }))`],
  // 도는 로그인이 없을 때의 취소 = no-op. 미구현이면 심이 조용히 삼키므로 이 값만으로는
  // 못 가른다 → 아래 `__unimplemented` 직접 호출로 본다.
  ['raw:auth:login-cancel', `window.__ccgRaw('auth:login-cancel', [])`],
  ['raw:codex-auth:login-cancel', `window.__ccgRaw('codex-auth:login-cancel', [])`],
  ['raw:codex-auth:reorder-accounts', `window.__ccgRaw('codex-auth:reorder-accounts', [[]])`],
  // ── T2: 엔진 ────────────────────────────────────────────────────────────────
  ['engine.state', `window.api.engine.state()`],
  ['engine.listAvailable', `window.api.engine.listAvailable().then(r => ({ latest: r && r.latest, installed: (r && r.installed || []).length, available: (r && r.available || []).length }))`],
  ['codexEngine.state', `window.api.codexEngine.state()`],
  ['codexEngine.listAvailable', `window.api.codexEngine.listAvailable().then(r => ({ latest: r && r.latest, installed: (r && r.installed || []).length }))`],
  ['engineUpdate.status', `window.api.engineUpdate.status()`],
  ['codexModels', `window.api.codexModels()`],
  // ── H2: MCP · Skill ─────────────────────────────────────────────────────────
  ['mcp.list(scratch)', `window.api.mcp.list(${MCPPROJ})`],
  ['skill.list(scratch)', `window.api.skill.list(${MCPPROJ})`],
  ['mcp.list(repo)', `window.api.mcp.list(${REPO_JS}).then(l => l.length)`],
  ['skill.list(repo)', `window.api.skill.list(${REPO_JS}).then(l => l.length)`],
  // ── 중간 ────────────────────────────────────────────────────────────────────
  ['app.getUpdateStatus', `window.api.app.getUpdateStatus()`],
  ['raw:app:update-check', `window.__ccgRaw('app:update-check', [])`],
  ['raw:app:open-directory(sub)', `(window.api.onOpenDirectory ? 'has-subscriber-api' : 'no-api')`],
  ['raw:ui:open-api-settings', `window.__ccgRaw('ui:open-api-settings', [])`],
  ['raw:shortcut:close', `window.__ccgRaw('shortcut:close', [])`],
  // git:ai-message — 실제 diff를 모으므로 스크래치 폴더로 던진다(부작용 없음: 읽기만)
  ['git.aiMessage(scratch)', `window.api.git.aiMessage({ cwd: ${JSON.stringify(path.join(REPO, 'bench', 'scratch'))}, files: [], account: '', model: 'haiku' }).then(r => ({ ok: r && r.ok, err: r && String(r.error||'').slice(0,80) }))`],
  // ── 기타 대조 ───────────────────────────────────────────────────────────────
  ['app.getVersion', `window.api.app.getVersion()`],
  ['lsp.servers', `window.api.lsp.servers().then(l => l.map(s => s.id ?? s.name ?? JSON.stringify(s).slice(0,20)))`],
  ['sessionWindows.list', `window.api.sessionWindows.list().then(l => l.length)`]
]

// 3.0의 `__unimplemented`를 **가리지 않고** 보는 원시 호출. 2.6.2에는 `ipc_call`이 없으므로
// preload의 채널 인보크로 같은 자리를 두드린다(없으면 'no-raw').
const RAW_JS = `window.__ccgRaw = async (ch, args) => {
  try {
    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
      const r = await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: ch, payload: args })
      if (r && typeof r === 'object' && r.__unimplemented) return 'UNIMPLEMENTED'
      return { ok: true, v: JSON.stringify(r).slice(0, 120) }
    }
    return 'no-raw(2.6.2)'
  } catch (e) { return 'THROW ' + String(e && e.message || e).slice(0, 100) }
}`

const out = { app: profile.name, kind, at: new Date().toISOString(), exe: profile.cmd, home: HOME, seededUsageCache: seededCache, probes: {}, shimWarns: [] }
let cdp = null
try {
  cdp = await connectMain(PORT)
  await cdp.send('Runtime.enable').catch(() => {})
  cdp.listeners.push((msg) => {
    if (msg.method !== 'Runtime.consoleAPICalled') return
    const txt = (msg.params?.args ?? []).map((a) => a.value ?? '').join(' ')
    if (/\[shim\]/.test(txt)) out.shimWarns.push(txt.slice(0, 200))
  })
  for (let i = 0; i < 400; i++) {
    const ok = await cdp.eval(`!!document.getElementById('root') && document.getElementById('root').children.length > 0`).catch(() => false)
    if (ok) break
    await sleep(150)
  }
  await sleep(3500)
  await cdp.eval(RAW_JS).catch(() => {})
  for (const [key, expr] of PROBES) {
    try {
      out.probes[key] = await cdp.eval(
        `Promise.resolve(${expr}).then(r => JSON.stringify(r === undefined ? '(undefined)' : r).slice(0, 700), e => 'REJECT ' + String(e && e.message || e).slice(0, 120))`,
        { awaitPromise: true, timeoutMs: 30000 }
      )
    } catch (e) {
      out.probes[key] = 'THROW ' + String(e.message ?? e).slice(0, 120)
    }
    console.log(`${key.padEnd(32)} ${String(out.probes[key]).slice(0, 120)}`)
  }
} catch (e) {
  out.fatal = String(e.stack ?? e).slice(0, 600)
  console.log('FATAL', out.fatal.split('\n')[0])
} finally {
  try { cdp?.close() } catch { /* 닫힘 */ }
  killTree(child.pid)
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log(`\nsaved: ${OUT}`)
