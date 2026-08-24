// ── M7 크리틱 공격 — "언어 서버를 밖에서 죽이면?" ─────────────────────────────
//
// 보고서는 앱이 죽었을 때 서버가 남지 않는 것(잡 안전망)은 실측했지만, **반대 방향**
// (서버가 먼저 죽었을 때 앱이 회복하는가)은 재지 않았다. 사용자 눈에는 이쪽이 더 흔하다:
// tsserver OOM·크래시·작업 관리자에서 잘못 종료.
//
// 절차: 앱 부팅 → ready → 라이브 토큰 확인 → **내 앱이 스폰한 언어 서버 PID 트리만**
//       taskkill /T /F → 그 뒤 60초 동안 렌더러에서 status/토큰/호버를 폴링하고
//       프로세스 목록도 함께 본다(재기동 여부).
//
//   node m7-kill.mjs --kind tauri|electron [--exe ...] [--watch 60000] [--out f.json]
//
// 안전: 죽이는 것은 내가 spawn한 앱의 **자손 중 언어 서버 커맨드라인을 가진 것**뿐.
//       사용자 실앱(AgentCodeGUI)·실홈 무접촉. 이름 기반 kill 0회.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import { resolveTauriExe } from '../../../bench/lib.mjs'
import { connectMainPage, killTree, sleep, electronProfile, tauriProfile } from '../../../bench/lib.mjs'
import { makeFixtureHome, FIX_ID } from '../../../bench/fixture.mjs'

const argv = process.argv.slice(2)
const flag = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const KIND = flag('kind', 'tauri')
// M12 R2 — mainBinaryName 변경으로 exe 이름이 둘이다(구·신 모두 탐색·최신 mtime 우선)
// (격리 타깃 전용 — only:true라 공용 target/이 더 새것이어도 끌려가지 않는다)
const EXE = resolveTauriExe(flag('exe', ''), { targetDir: path.join(os.tmpdir(), 'ccg-m7c-tgt'), only: true })
const OUT = flag('out', '')
const PORT = Number(flag('port', KIND === 'tauri' ? 9401 : 9402))
const WORK = flag('work', path.join(os.tmpdir(), 'ccg-lsp-repo'))
const REL = flag('rel', 'lspbench/big.ts')
const WATCH = Number(flag('watch', '60000'))
const TTL = flag('ttl', '')
const SWEEP = flag('sweep', '')
const QUIET = Number(flag('quiet', '0')) // kill 직후 이만큼은 **아무 호출도 안 한다**(touch 없음)

function descendants(rootPid) {
  const ps = `$ErrorActionPreference='SilentlyContinue'
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine
$want = New-Object System.Collections.Generic.HashSet[int]
[void]$want.Add(${rootPid})
for ($i=0; $i -lt 6; $i++) { foreach ($p in $all) { if ($want.Contains([int]$p.ParentProcessId)) { [void]$want.Add([int]$p.ProcessId) } } }
$out = foreach ($p in $all) { if ($want.Contains([int]$p.ProcessId) -and [int]$p.ProcessId -ne ${rootPid}) { [pscustomobject]@{ pid=$p.ProcessId; ppid=$p.ParentProcessId; name=$p.Name; cmd=($p.CommandLine -replace '"','') } } }
$out | ConvertTo-Json -Compress -Depth 3`
  try {
    const raw = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 << 20
    }).trim()
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : [arr]
  } catch { return [] }
}
const isLsp = (p) => /typescript-language-server|tsserver/i.test(p.cmd || '')

const PROBE = `(() => {
  if (window.__m7k) return 'already'
  const K = (window.__m7k = { ready: null, samples: [] })
  K.api = () => (window.api && window.api.lsp) || null
  K.waitReady = async (cwd, rel, budget) => {
    const t0 = performance.now()
    for (;;) {
      const a = K.api()
      if (a) {
        const st = await a.status(cwd, rel).catch(() => 'err')
        if (st === 'ready') return { ms: Math.round(performance.now() - t0), st }
      }
      if (performance.now() - t0 > budget) return { ms: null, st: 'timeout' }
      await new Promise((r) => setTimeout(r, 120))
    }
  }
  K.tokens = async (cwd, rel) => {
    const t = await K.api().semanticTokens(cwd, rel).catch((e) => ({ __err: String(e && e.message || e) }))
    return { n: t && t.data ? t.data.length / 5 : 0, err: t && t.__err ? t.__err : null, nullish: t == null }
  }
  K.sampleOnce = async (cwd, rel) => {
    const t0 = performance.now()
    const st = await K.api().status(cwd, rel).catch((e) => 'throw:' + (e && e.message))
    const stMs = Math.round(performance.now() - t0)
    const t1 = performance.now()
    const tk = await K.tokens(cwd, rel)
    const tkMs = Math.round(performance.now() - t1)
    const t2 = performance.now()
    const hv = await K.api().hover(cwd, rel, { line: 1, character: 12 }).catch(() => null)
    const hvMs = Math.round(performance.now() - t2)
    const t3 = performance.now()
    const proj = await K.api().projectStatus(cwd).catch(() => null)
    const projMs = Math.round(performance.now() - t3)
    return { at: Math.round(performance.now()), st, stMs, tokens: tk.n, tkMs, tkErr: tk.err, tkNull: tk.nullish,
             hover: !!(hv && hv.contents), hvMs, proj: proj && proj.state, projMs }
  }
  return 'armed'
})()`

function makeHome(kind, version) {
  const home = path.join(os.tmpdir(), `ccg-m7c-kill-${kind}`)
  fs.rmSync(home, { recursive: true, force: true })
  makeFixtureHome(home, version)
  const f = path.join(home, 'chats', `${FIX_ID}.json`)
  const chat = JSON.parse(fs.readFileSync(f, 'utf8'))
  chat.manualCwd = WORK
  if (chat.snapshot) chat.snapshot.cwd = WORK
  fs.writeFileSync(f, JSON.stringify(chat))
  return home
}

const version = KIND === 'tauri' ? '3.0.0-beta.1' : '2.6.2'
const home = makeHome(KIND, version)
const profile = KIND === 'tauri' ? tauriProfile({ port: PORT, exe: EXE }) : electronProfile({ port: PORT })
const child = spawn(profile.cmd, profile.args, {
  env: { ...process.env, ...profile.env, CCG_HOME: home,
         ...(TTL ? { CCG_LSP_IDLE_TTL_MS: TTL } : {}), ...(SWEEP ? { CCG_LSP_SWEEP_MS: SWEEP } : {}) },
  cwd: profile.cwd,
  stdio: 'ignore'
})
const out = { kind: KIND, version, pid: child.pid, at: new Date().toISOString(), work: WORK, rel: REL }
const S = (v) => JSON.stringify(v)
try {
  const cdp = await connectMainPage(PORT, { timeoutMs: 90000 })
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  // 3.0은 CDP 접속 뒤 문서가 한 번 더 갈린다 — **마운트를 먼저 기다리고** 그 다음에 심는다
  const t0m = Date.now()
  while (Date.now() - t0m < 90000) {
    if (await cdp.eval(profile.mountExpr).catch(() => false)) break
    await sleep(120)
  }
  await sleep(400)
  for (let i = 0; i < 200; i++) {
    await cdp.eval(PROBE).catch(() => {})
    if (await cdp.eval(`!!(window.__m7k && window.api && window.api.lsp)`).catch(() => false)) break
    await sleep(200)
  }
  out.ready = await cdp.eval(`window.__m7k.waitReady(${S(WORK)}, ${S(REL)}, 120000)`, { awaitPromise: true, timeoutMs: 130000 })
  // 라이브 토큰이 실제로 올 때까지
  for (let i = 0; i < 200; i++) {
    const t = await cdp.eval(`window.__m7k.tokens(${S(WORK)}, ${S(REL)})`, { awaitPromise: true })
    if (t.n > 0) { out.tokensBefore = t.n; break }
    await sleep(300)
  }
  out.before = await cdp.eval(`window.__m7k.sampleOnce(${S(WORK)}, ${S(REL)})`, { awaitPromise: true })
  const procsBefore = descendants(child.pid)
  const victims = procsBefore.filter(isLsp)
  out.procsBefore = procsBefore.map((p) => ({ pid: p.pid, name: p.name, lsp: isLsp(p) }))
  out.victims = victims.map((p) => ({ pid: p.pid, name: p.name }))
  if (!victims.length) throw new Error('언어 서버 프로세스를 못 찾음 — 공격 전제 미성립')
  // ★ 내 앱의 자손 중 언어 서버만 — 이름 기반 kill 아님, PID 지정
  const killedAt = Date.now()
  for (const v of victims) {
    try { execFileSync('taskkill', ['/PID', String(v.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 이미 죽음 */ }
  }
  out.killedPids = victims.map((v) => v.pid)
  out.inject = { ttl: TTL || null, sweep: SWEEP || null, quietMs: QUIET }
  if (QUIET > 0) await sleep(QUIET) // 이 창에서는 status 폴링이 없다 → ensure()의 touch도 없다
  const samples = []
  const procSnaps = []
  for (;;) {
    const el = Date.now() - killedAt
    if (el > WATCH) break
    const s = await cdp.eval(`window.__m7k.sampleOnce(${S(WORK)}, ${S(REL)})`, { awaitPromise: true, timeoutMs: 60000 }).catch((e) => ({ err: String(e?.message ?? e) }))
    s.sinceKillMs = el
    samples.push(s)
    if (samples.length % 4 === 1) {
      const d = descendants(child.pid).filter(isLsp)
      procSnaps.push({ sinceKillMs: el, lsp: d.map((p) => p.pid) })
    }
    await sleep(1500)
  }
  out.samples = samples
  out.procSnaps = procSnaps
  const recovered = samples.find((s) => s.tokens > 0)
  const respawn = procSnaps.find((p) => p.lsp.length > 0 && !p.lsp.some((x) => out.killedPids.includes(x)))
  out.verdict = {
    statusesAfterKill: [...new Set(samples.map((s) => s.st))],
    projectStatesAfterKill: [...new Set(samples.map((s) => s.proj))],
    tokensRecovered: !!recovered,
    tokensRecoveredAtMs: recovered ? recovered.sinceKillMs : null,
    hoverRecovered: samples.some((s) => s.hover),
    respawned: !!respawn,
    respawnAtMs: respawn ? respawn.sinceKillMs : null,
    maxStatusCallMs: Math.max(...samples.map((s) => s.stMs || 0)),
    maxTokenCallMs: Math.max(...samples.map((s) => s.tkMs || 0)),
    maxHoverCallMs: Math.max(...samples.map((s) => s.hvMs || 0))
  }
  try { cdp.close() } catch { /* closed */ }
} catch (e) {
  out.error = String(e?.message ?? e)
} finally {
  killTree(child.pid)
  await sleep(1500)
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 잠김 */ }
}
const text = JSON.stringify(out, null, 2)
if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, text) }
console.log(JSON.stringify({ kind: out.kind, ready: out.ready, tokensBefore: out.tokensBefore, before: out.before,
  killedPids: out.killedPids, verdict: out.verdict, error: out.error }, null, 2))
