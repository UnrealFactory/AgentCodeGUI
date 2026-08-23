// ── M7 크리틱 — ready 격차(~220~290ms)의 진짜 자리 ────────────────────────────
//
// 보고서 §8-1: "첫 ipc_call의 워밍업(blocking 풀 기동/채널 초기화 의심)". 그 가설을 쪼갠다.
// 문서 시작에 프로브를 걸고 **경계 시각을 전부** 박는다(전부 performance.now = navigationStart):
//
//   apiAt          window.api.lsp 가 처음 존재한 시각   ← 2.6.2=preload(문서 시작) / 3.0=번들 실행 뒤
//   st0SentAt      첫 lsp:status 호출을 낸 시각          ← **지연 스폰의 방아쇠**
//   st0RespAt/Ms   그 첫 응답 · 왕복
//   readyAt        status가 'ready'가 된 시각
//   lag[]          같은 구간의 이벤트 루프 지연(setTimeout(0) 왕복) — 워밍업이 Rust 쪽인지
//                  웹뷰 메인 스레드 경합인지 가른다
//
//   node m7-ready.mjs --kind tauri|electron [--exe path] [--out f.json]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { connectMainPage, killTree, sleep, electronProfile, tauriProfile } from '../../../bench/lib.mjs'
import { makeFixtureHome, FIX_ID } from '../../../bench/fixture.mjs'

const argv = process.argv.slice(2)
const flag = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const KIND = flag('kind', 'tauri')
const EXE = flag('exe', path.join(os.tmpdir(), 'ccg-m7c-tgt', 'release', 'agentcodegui.exe'))
const OUT = flag('out', '')
const PORT = Number(flag('port', KIND === 'tauri' ? 9384 : 9385))
const WORK = flag('work', path.join(os.tmpdir(), 'ccg-lsp-repo'))
const REL = flag('rel', 'lspbench/big.ts')
const FRESH = !argv.includes('--warm')

const SRC = `(() => {
  if (window.__m7r) return 'already'
  const R = (window.__m7r = { installedAt: Math.round(performance.now() * 100) / 100, url: location.href,
                              apiAt: null, st0SentAt: null, st0RespAt: null, st0: null,
                              readyAt: null, states: [], lag: [], polls: [] })
  // 이벤트 루프 지연 샘플러 — 20ms마다 예약하고 실제 지연을 남긴다
  ;(function lagLoop() {
    const t = performance.now()
    setTimeout(() => {
      const now = performance.now()
      R.lag.push({ at: Math.round(now), lagMs: Math.round((now - t - 20) * 100) / 100 })
      if (now < 8000) lagLoop()
    }, 20)
  })()
  const cwd = ${JSON.stringify(WORK)}, rel = ${JSON.stringify(REL)}
  const tick = () => {
    const a = (window.api && window.api.lsp) || null
    if (!a) { setTimeout(tick, 1); return }
    if (R.apiAt == null) R.apiAt = Math.round(performance.now() * 100) / 100
    const sent = performance.now()
    if (R.st0SentAt == null) R.st0SentAt = Math.round(sent * 100) / 100
    a.status(cwd, rel).then((st) => {
      const got = performance.now()
      R.polls.push({ sent: Math.round(sent), ms: Math.round((got - sent) * 100) / 100, st })
      if (R.st0RespAt == null) { R.st0RespAt = Math.round(got * 100) / 100; R.st0 = st }
      if (R.states[R.states.length - 1] !== st) R.states.push(st)
      if (st === 'ready') { R.readyAt = Math.round(got * 100) / 100; return }
      setTimeout(tick, 100)
    }).catch((e) => { R.err = String(e && e.message || e); setTimeout(tick, 200) })
  }
  tick()
  return 'armed'
})()`

function makeHome(kind, version) {
  const home = path.join(os.tmpdir(), `ccg-m7c-ready-${kind}`)
  if (FRESH) {
    fs.rmSync(home, { recursive: true, force: true })
    makeFixtureHome(home, version)
    const f = path.join(home, 'chats', `${FIX_ID}.json`)
    const chat = JSON.parse(fs.readFileSync(f, 'utf8'))
    chat.manualCwd = WORK
    if (chat.snapshot) chat.snapshot.cwd = WORK
    fs.writeFileSync(f, JSON.stringify(chat))
  }
  return home
}

const version = KIND === 'tauri' ? '3.0.0-beta.1' : '2.6.2'
const home = makeHome(KIND, version)
const profile = KIND === 'tauri' ? tauriProfile({ port: PORT, exe: EXE }) : electronProfile({ port: PORT })
const child = spawn(profile.cmd, profile.args, {
  env: { ...process.env, ...profile.env, CCG_HOME: home },
  cwd: profile.cwd,
  stdio: 'ignore'
})
let out = { kind: KIND, version, port: PORT, pid: child.pid, at: new Date().toISOString(), fresh: FRESH }
try {
  const cdp = await connectMainPage(PORT, { timeoutMs: 90000 })
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SRC }).catch(() => {})
  await cdp.eval(SRC).catch(() => {})
  const t0 = Date.now()
  let r = null
  for (;;) {
    r = await cdp.eval(`window.__m7r ? JSON.parse(JSON.stringify(window.__m7r)) : null`).catch(() => null)
    if (!r) await cdp.eval(SRC).catch(() => {})
    if (r && r.readyAt != null) break
    if (Date.now() - t0 > 90000) break
    await sleep(150)
  }
  out.probe = r
  if (r) {
    out.derived = {
      installedAt: r.installedAt,
      url: r.url,
      apiAt: r.apiAt,
      st0SentAt: r.st0SentAt,
      st0Ms: r.st0RespAt != null && r.st0SentAt != null ? Math.round((r.st0RespAt - r.st0SentAt) * 100) / 100 : null,
      st0: r.st0,
      readyAt: r.readyAt,
      readyAfterFirstStatusMs: r.readyAt != null && r.st0SentAt != null ? Math.round(r.readyAt - r.st0SentAt) : null,
      polls: (r.polls || []).length,
      pollMsFirst5: (r.polls || []).slice(0, 5).map((p) => p.ms),
      lagMax2s: Math.max(0, ...(r.lag || []).filter((l) => l.at < 2000).map((l) => l.lagMs)),
      lagOver50Before2s: (r.lag || []).filter((l) => l.at < 2000 && l.lagMs > 50).length,
      lagSpikes: (r.lag || []).filter((l) => l.lagMs > 50).map((l) => `${l.at}ms:+${l.lagMs}`)
    }
  }
  try { cdp.close() } catch { /* closed */ }
} catch (e) {
  out.error = String(e?.message ?? e)
} finally {
  killTree(child.pid)
  await sleep(1500)
}
const text = JSON.stringify(out, null, 2)
if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, text) }
console.log(JSON.stringify({ kind: out.kind, derived: out.derived, error: out.error, states: out.probe?.states }, null, 2))
