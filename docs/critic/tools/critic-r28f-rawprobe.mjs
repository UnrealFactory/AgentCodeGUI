// 최종 파리티 R3 — 「닫혔다/안 닫혔다」를 **내 baseline exe**에서 다시 두드리는 원시 프로브.
//
//   node docs/critic/tools/critic-r28f-rawprobe.mjs --exe=<3.0 exe> [--port=10534] [--out=json]
//
// R2 감사(트리 `72a142d`)와 확인 크리틱 R1(`9aa75b5`) 이후로 커밋이 더 얹혔다. 정정
// 라운드의 결론이 「그 사이에 뭔가 무너지지 않았다」에 기대므로, 같은 자리를 **이 라운드의
// exe**로 한 번 더 두드린다. `raw:`는 `__TAURI_INTERNALS__.invoke('ipc_call', …)` 원시
// 호출이라 심의 안전값을 안 거친다 — `{__unimplemented:true}`가 그대로 보인다.
//
// 안전 규약(함정 5): 픽스처가 복사한 `accounts.json`·`codex-accounts.json`을 **기동 전에**
// 지운다. 그래서 이 프로브는 실계정 토큰을 한 바이트도 안 만지고, `usage:get`도 조회를
// 못 나가므로 회전 경로가 아예 안 열린다. 부작용 있는 채널(로그인·설치·정리·업데이트)은
// 안 부른다 — `app:open-directory`만 예외로 **원시 호출**한다(3.0에 핸들러가 없어
// 디스패처가 매칭조차 못 한다 = 부작용 0).
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { tauriProfile, cdpTargets, Cdp, killTree, sleep, REPO } from '../../../bench/lib.mjs'
import { makeFixtureHome } from '../../../bench/fixture.mjs'
import { augmentFixture } from '../../../bench/screens.mjs'

const argv = process.argv.slice(2)
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d }
const PORT = Number(arg('port', 10534))
const HOME = arg('home', 'C:\\Temp\\ccg-r28f-audit\\home-raw')
const OUT = path.resolve(arg('out', path.join(REPO, 'docs', 'critic', 'final-parity-r3-rawprobe.json')))

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch { /* 잠기면 덮어쓴다 */ }
makeFixtureHome(HOME, '3.0.0-beta.1')
augmentFixture(HOME, { repo: REPO })
const removed = []
for (const f of ['accounts.json', 'codex-accounts.json']) {
  const p = path.join(HOME, f)
  if (fs.existsSync(p)) { fs.rmSync(p); removed.push(f) }
}

const profile = tauriProfile({ port: PORT, exe: arg('exe', undefined) })
const child = spawn(profile.cmd, profile.args, { env: { ...process.env, ...profile.env, CCG_HOME: HOME }, cwd: profile.cwd, stdio: 'ignore' })
const out = { app: profile.name, at: new Date().toISOString(), exe: profile.cmd, home: HOME, accountsRemoved: removed, pid: child.pid, probes: {}, shimWarns: [] }

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
  await sleep(6000)

  const raw = async (ch, payload = []) => {
    const e = `window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: ${JSON.stringify(ch)}, payload: ${JSON.stringify(payload)} }).then(r => JSON.stringify(r) ?? 'undefined').catch(e => 'REJECT ' + String(e))`
    return await cdp.eval(e, { awaitPromise: true, timeoutMs: 25000 }).catch((x) => 'THROW ' + x.message)
  }
  const api = async (expr) => await cdp.eval(`Promise.resolve(${expr}).then(r => JSON.stringify(r) ?? 'undefined').catch(e => 'REJECT ' + String(e))`, { awaitPromise: true, timeoutMs: 30000 }).catch((x) => 'THROW ' + x.message)

  // ── ⛔ N1 — Codex 계정 축 5채널 (원시) ────────────────────────────────────
  for (const ch of ['codex-auth:login', 'codex-auth:logout', 'codex-auth:login-cancel', 'codex-auth:reorder-accounts', 'codex-auth:set-default-account']) {
    out.probes[`raw:${ch}`] = await raw(ch, ch === 'codex-auth:reorder-accounts' ? [[]] : ch === 'codex-auth:login' || ch === 'codex-auth:login-cancel' ? [] : [''])
  }
  // ── ⛔ N3 — `app:open-directory` (원시) ───────────────────────────────────
  out.probes['raw:app:open-directory'] = await raw('app:open-directory', ['C:\\Code'])
  out.probes['raw:app:get-initial-dir'] = await raw('app:get-initial-dir', [])

  // ── ✅ 닫혔다고 적힌 자리 재확인 (원시 — 부작용 없는 것만) ────────────────
  for (const ch of ['auth:login-cancel', 'auth:reorder-accounts', 'shortcut:close', 'ui:open-api-settings', 'btw:open']) {
    out.probes[`raw:${ch}`] = await raw(ch, ch === 'auth:reorder-accounts' ? [[]] : ch === 'btw:open' ? [{ parentChatId: 'fix-long-thread', prompt: '' }] : [])
  }

  // ── 심 경유 — (d)의 기전: 미구현 채널이 **빈 목록**으로 번역돼 도착하는가 ──
  out.probes['shim:codexAuth.reorderAccounts([])'] = await api(`window.api.codexAuth.reorderAccounts([])`)
  out.probes['shim:codexAuth.login()'] = await api(`window.api.codexAuth.login()`)
  out.probes['shim:codexAuth.logout("nobody@example.invalid")'] = await api(`window.api.codexAuth.logout('nobody@example.invalid')`)
  out.probes['shim:codexAuth.listAccounts()'] = await api(`window.api.codexAuth.listAccounts()`)
  // ★R4(F4) — R3의 키는 `shim:app.openDirectory 구독자`였는데 실제로 잰 것은 **구독자**
  //   (`onOpenDirectory`)다. 라벨이 방출자 이름을 달고 있어 다음 독자가 「3.0에 방출자가
  //   있다」로 읽는다. 이름을 고치고, 방출자 쪽도 **따로** 잰다(런타임 undefined 기대).
  out.probes['shim:app.onOpenDirectory 구독자'] = await api(`typeof window.api.app.onOpenDirectory`)
  out.probes['shim:app.openDirectory 방출자'] = await api(`typeof window.api.app.openDirectory`)

  // ── 값이 있는가 (T2·T3·H4·M5·M6) ─────────────────────────────────────────
  out.probes['engine.state'] = await api(`window.api.engine.state()`)
  out.probes['engine.listAvailable().latest'] = await api(`window.api.engine.listAvailable().then(x => ({ latest: x.latest, n: (x.versions || []).length }))`)
  out.probes['usage.get(false)'] = await api(`window.api.getUsage(false)`)
  out.probes['auth.listAccounts()'] = await api(`window.api.auth.listAccounts().then(a => a.length)`)
  out.probes['codex.models'] = await api(`window.api.codexModels().then(m => (m || []).map(x => x.id || x).slice(0, 4))`)
  out.probes['git.aiMessage(비-git)'] = await api(`window.api.git.aiMessage({ cwd: 'C:\\\\Windows\\\\Temp', diff: '' })`)
} catch (e) {
  out.fatal = String(e.stack ?? e).slice(0, 800)
} finally {
  try { cdp?.close() } catch { /* 닫힘 */ }
  killTree(child.pid)
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
for (const [k, v] of Object.entries(out.probes)) console.log(k.padEnd(46), String(v).slice(0, 110))
console.log(`\nshimWarns: ${JSON.stringify(out.shimWarns)}\nsaved: ${OUT}`)
