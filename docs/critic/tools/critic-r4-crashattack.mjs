// R4 크리틱 — 크래시 복구를 **깨뜨리려는** 하네스.
//
//   node docs/critic/tools/critic-r4-crashattack.mjs [scenario ...]
//
// bench/crash.mjs는 "정상 경로가 산다"를 보인다. 이건 반대다 — crash.rs의 상태 기계
// (DEBOUNCE_MS=4000 · RECOVERING 2500ms · MAX_RECOVERIES=5 · arm() 시점)에서
// 구멍이 날 자리를 노린다. 산출: bench/results/critic-r4-crash-attacks.json
//
// 절대 규칙: 이름 기반 kill 없음 — 내가 스폰한 트리의 PID만.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { tauriProfile, connectMainPage, cdpTargets, Cdp, procTreeMem, killTree, sleep, envInfo, provenance, REPO } from '../../../bench/lib.mjs'
import { makeMultiFixture } from '../../../bench/fixture.mjs'

const HOMEBASE = path.join(REPO, '.bench-home-critic-attack')
let HOME = HOMEBASE
const OUT = path.join(REPO, 'bench', 'results', 'critic-r4-crash-attacks.json')
const want = process.argv.slice(2).filter((a) => !a.startsWith('--'))

const winPs = (pids) => String.raw`
$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class W { public delegate bool E(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(E cb, IntPtr l);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
 [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,Rt,B; }
 public static string Big(uint[] pids){ var sb=new StringBuilder(); EnumWindows((h,l)=>{ if(!IsWindowVisible(h)) return true; uint p; GetWindowThreadProcessId(h,out p);
   bool m=false; foreach(var q in pids) if(q==p) m=true; if(!m) return true; R r; GetWindowRect(h,out r);
   if((r.Rt-r.L)>=200 && (r.B-r.T)>=200){ var t=new StringBuilder(200); GetWindowTextW(h,t,200); sb.Append((r.Rt-r.L)+"x"+(r.B-r.T)+" "+t.ToString()+"\n"); } return true; }, IntPtr.Zero); return sb.ToString(); } }
"@
[W]::Big([uint32[]]@(${pids}))`

function windowList(pids) {
  if (!pids?.length) return []
  try {
    const s = execFileSync('powershell', ['-NoProfile', '-Command', winPs(pids.join(','))], { encoding: 'utf8', timeout: 30000 })
    return s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
  } catch { return ['(열거 실패)'] }
}
function readLog(home = HOME) {
  const p = path.join(home, 'crash-recovery.log')
  if (!fs.existsSync(p)) return []
  return fs.readFileSync(p, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return { raw: l } } })
}
const evList = (log) => log.map((l) => l.event)
function killPid(pid) {
  try { execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore', timeout: 10000 }); return true } catch { return false }
}
const roleOf = (m, role) => (m?.procs ?? []).filter((p) => p.role === role)

/** 마운트된 페이지 수 / 전체 페이지 수 */
async function mountState(port) {
  const t = await cdpTargets(port).catch(() => [])
  const pages = t.filter((x) => x.type === 'page')
  const out = []
  for (const p of pages) {
    try {
      const c = await Cdp.connect(p.webSocketDebuggerUrl, { timeoutMs: 1500 })
      const ok = await c.eval(`!!document.getElementById('root') && document.getElementById('root').children.length > 0`, { timeoutMs: 1500 }).catch(() => false)
      out.push({ url: String(p.url).split('/').pop(), mounted: !!ok })
      c.close()
    } catch { out.push({ url: String(p.url).split('/').pop(), mounted: false, err: 'connect' }) }
  }
  return out
}
async function waitRemount(port, t0, ms = 25000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    await sleep(200)
    try {
      const c = await connectMainPage(port, { timeoutMs: 1200, connectTimeoutMs: 1200 })
      const ok = await c.eval(`!!document.getElementById('root') && document.getElementById('root').children.length > 0`, { timeoutMs: 1200 }).catch(() => false)
      c.close()
      if (ok) return Date.now() - t0
    } catch { /* 아직 */ }
  }
  return null
}

/** 창 3개(메인 + 추가 채팅 2)로 정착시킨 앱을 띄운다. */
async function boot({ port, extraEnv = {}, sessions = 2, home = HOME } = {}) {
  fs.rmSync(home, { recursive: true, force: true })
  makeMultiFixture(home, '3.0.0-beta.1', { panels: 4 })
  const profile = tauriProfile({ port, extraEnv })
  profile.env.CCG_HOME = home
  const child = spawn(profile.cmd, profile.args, { env: { ...process.env, ...profile.env }, cwd: profile.cwd, stdio: 'ignore' })
  const cdp = await connectMainPage(profile.port, { timeoutMs: 45000 })
  for (;;) { if (await cdp.eval(profile.mountExpr).catch(() => false)) break; await sleep(100) }
  await sleep(2500)
  for (let i = 0; i < sessions; i++) { await cdp.eval(`window.api.openSessionWindow()`).catch(() => null); await sleep(3200) }
  await sleep(2500)
  return { child, cdp, profile }
}

const results = []
const run = async (name, fn) => {
  if (want.length && !want.includes(name)) return
  // 시나리오별 HOME 격리 — 직전 인스턴스가 .instance-lock을 붙들고 있어 rmSync가 EPERM.
  HOME = `${HOMEBASE}-${name}`
  console.log(`\n=== ${name} ===`)
  const r = { scenario: name, at: new Date().toISOString() }
  try { Object.assign(r, await fn()) } catch (e) { r.error = String(e?.message ?? e) }
  console.log(`  → ${r.verdict ?? r.error}`)
  results.push(r)
}

// ── A1. 부팅 직중 kill ────────────────────────────────────────────────────────
// crash::arm은 창 생성 때 붙는다. 렌더러가 그보다 먼저(또는 붙는 도중) 죽으면?
await run('boot-kill', async () => {
  fs.rmSync(HOME, { recursive: true, force: true })
  makeMultiFixture(HOME, '3.0.0-beta.1', { panels: 4 })
  const profile = tauriProfile({ port: 9471 })
  profile.env.CCG_HOME = HOME
  const child = spawn(profile.cmd, profile.args, { env: { ...process.env, ...profile.env }, cwd: profile.cwd, stdio: 'ignore' })
  // 렌더러가 생기자마자(= 마운트를 기다리지 않고) 죽인다.
  let target = null
  const t0 = Date.now()
  while (Date.now() - t0 < 30000) {
    const m = procTreeMem(child.pid, { role: true })
    const r = roleOf(m, 'renderer')
    if (r.length) { target = r[0]; break }
  }
  const killedAt = Date.now()
  const msAfterSpawn = killedAt - t0
  const killed = target ? killPid(target.pid) : false
  const remountMs = await waitRemount(profile.port, killedAt, 25000)
  await sleep(3000)
  const after = procTreeMem(child.pid, { role: true })
  const hostAlive = !after?.error
  const wins = hostAlive ? windowList((after.procs ?? []).map((p) => p.pid)) : []
  const pages = hostAlive ? await mountState(profile.port) : []
  const log = readLog()
  killTree(child.pid)
  const verdict = !hostAlive ? '호스트 종료(유령 없음)'
    : remountMs != null ? `복구됨 ${remountMs}ms`
      : wins.length ? `**유령 창 ${wins.length}개 — 실패**` : '창 없음 + 호스트 생존'
  return { killedRendererPid: target?.pid ?? null, killed, msAfterSpawn, remountMs, hostAlive, procsAfter: after?.procs?.length ?? 0, windows: wins, pages, log: evList(log), verdict }
})

// ── A2. 디바운스 구멍 ────────────────────────────────────────────────────────
// recover(): LAST_AT에서 DEBOUNCE_MS(4000) 안에 온 사건은 **버린다**. RECOVERING은
// 2500ms에 풀린다. 즉 (2.5s, 4.0s) 구간의 새 크래시는 누구도 처리하지 않는다.
for (const gapMs of [3000, 5000]) {
  await run(`rekill-gap-${gapMs}`, async () => {
    const { child, profile } = await boot({ port: 9472 })
    const before = procTreeMem(child.pid, { role: true })
    const r1 = roleOf(before, 'renderer')[0]
    const t0 = Date.now()
    killPid(r1.pid)
    const firstMs = await waitRemount(profile.port, t0, 20000)
    // 첫 kill 기준 gapMs 시점에 두 번째 kill
    const waitLeft = gapMs - (Date.now() - t0)
    if (waitLeft > 0) await sleep(waitLeft)
    const mid = procTreeMem(child.pid, { role: true })
    const r2 = roleOf(mid, 'renderer')[0]
    const t1 = Date.now()
    const secondKilled = r2 ? killPid(r2.pid) : false
    const secondMs = await waitRemount(profile.port, t1, 25000)
    await sleep(3000)
    const after = procTreeMem(child.pid, { role: true })
    const hostAlive = !after?.error
    const wins = hostAlive ? windowList((after.procs ?? []).map((p) => p.pid)) : []
    const pages = hostAlive ? await mountState(profile.port) : []
    const log = readLog()
    killTree(child.pid)
    const ghost = hostAlive && secondMs == null && wins.length > 0
    return {
      gapMs, firstKillPid: r1?.pid, firstRecoverMs: firstMs, deltaFromFirstKillMs: t1 - t0,
      secondKillPid: r2?.pid, secondKilled, secondRecoverMs: secondMs,
      hostAlive, windows: wins, pages, mounted: pages.filter((p) => p.mounted).length + '/' + pages.length,
      recoverBeginCount: log.filter((l) => l.event === 'recover-begin').length,
      log: evList(log),
      verdict: ghost ? `**유령 창 ${wins.length}개 — 2차 크래시가 삼켜짐(디바운스)**` : secondMs != null ? `2차도 복구됨 ${secondMs}ms` : !hostAlive ? '호스트 종료' : '판정 불명'
    }
  })
}

// ── A3. 렌더러 kill 연타 6회(>4s 간격) — MAX_RECOVERIES=5 포기 경로 ─────────
await run('giveup-6x', async () => {
  const { child, profile } = await boot({ port: 9473 })
  const rows = []
  for (let i = 1; i <= 6; i++) {
    const m = procTreeMem(child.pid, { role: true })
    if (m?.error) { rows.push({ i, note: '호스트 이미 없음' }); break }
    const r = roleOf(m, 'renderer')[0]
    if (!r) { rows.push({ i, note: '렌더러 없음' }); break }
    const t = Date.now()
    killPid(r.pid)
    const ms = await waitRemount(profile.port, t, 20000)
    rows.push({ i, pid: r.pid, recoverMs: ms })
    console.log(`   kill ${i}: ${ms == null ? '복구 안 됨' : ms + 'ms'}`)
    await sleep(6000) // 디바운스(4s)보다 크게
  }
  await sleep(2000)
  const after = procTreeMem(child.pid, { role: true })
  const hostAlive = !after?.error
  const wins = hostAlive ? windowList((after.procs ?? []).map((p) => p.pid)) : []
  const log = readLog()
  killTree(child.pid)
  return {
    rows, hostAlive, windows: wins,
    gaveUp: log.some((l) => l.event === 'give-up'),
    log: evList(log),
    verdict: !hostAlive ? '포기 후 정리 종료(유령 없음)' : wins.length ? `**유령 창 ${wins.length}개**` : '호스트 생존/창 없음'
  }
})

// ── A4. 복구가 무엇을 잃는가 — 컴포저 초안 · 스크롤 위치 ─────────────────────
await run('state-loss', async () => {
  const { child, cdp, profile } = await boot({ port: 9474, sessions: 0 })
  // 스레드를 스크롤하고 컴포저에 초안을 넣는다.
  const setup = await cdp.eval(`(() => {
    const th = document.querySelector('.ma-p-thread')
    if (th) th.scrollTop = Math.max(0, Math.floor(th.scrollHeight * 0.4))
    const ta = document.querySelector('.ma-panel .composer textarea') || document.querySelector('.composer textarea') || document.querySelector('textarea')
    let typed = null
    if (ta) {
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      set.call(ta, 'CRITIC-DRAFT-DO-NOT-LOSE')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      typed = ta.value
    }
    return { scrollTop: th ? th.scrollTop : null, scrollHeight: th ? th.scrollHeight : null, draft: typed, taFound: !!ta }
  })()`)
  await sleep(1500)
  const confirmed = await cdp.eval(`(() => {
    const th = document.querySelector('.ma-p-thread')
    const ta = document.querySelector('.ma-panel .composer textarea') || document.querySelector('.composer textarea') || document.querySelector('textarea')
    return { scrollTop: th ? th.scrollTop : null, draft: ta ? ta.value : null }
  })()`)
  const before = procTreeMem(child.pid, { role: true })
  const r = roleOf(before, 'renderer')[0]
  const t0 = Date.now()
  killPid(r.pid)
  const ms = await waitRemount(profile.port, t0, 25000)
  await sleep(3500)
  let post = null
  try {
    const c2 = await connectMainPage(profile.port, { timeoutMs: 5000, connectTimeoutMs: 3000 })
    post = await c2.eval(`(() => {
      const th = document.querySelector('.ma-p-thread')
      const ta = document.querySelector('.ma-panel .composer textarea') || document.querySelector('.composer textarea') || document.querySelector('textarea')
      return { scrollTop: th ? th.scrollTop : null, scrollHeight: th ? th.scrollHeight : null, draft: ta ? ta.value : null,
               msgCount: document.querySelectorAll('.ma-p-thread > *').length, panels: document.querySelectorAll('.ma-panel').length }
    })()`, { timeoutMs: 5000 })
    c2.close()
  } catch (e) { post = { err: String(e?.message ?? e) } }
  const after = procTreeMem(child.pid, { role: true })
  const wins = windowList((after.procs ?? []).map((p) => p.pid))
  killTree(child.pid)
  const lost = []
  if (confirmed?.draft && post?.draft !== confirmed.draft) lost.push('컴포저 초안')
  if (confirmed?.scrollTop > 50 && (post?.scrollTop ?? 0) < confirmed.scrollTop - 50) lost.push('스크롤 위치')
  return {
    setup, confirmed, post, recoverMs: ms, windowsAfter: wins.length,
    lost, verdict: lost.length ? `복구되나 **${lost.join(' · ')} 소실**` : '상태 유지'
  }
})

// ── A5. 연쇄: 렌더러 → 3초 뒤 브라우저 (서로 다른 원인, 같은 디바운스) ───────
await run('cascade-renderer-then-browser', async () => {
  const { child, profile } = await boot({ port: 9475 })
  const before = procTreeMem(child.pid, { role: true })
  const r = roleOf(before, 'renderer')[0]
  const t0 = Date.now()
  killPid(r.pid)
  await sleep(3000 - (Date.now() - t0) > 0 ? 3000 - (Date.now() - t0) : 0)
  const mid = procTreeMem(child.pid, { role: true })
  const b = (mid.procs ?? []).filter((p) => p.role === 'browser' && /msedgewebview2/i.test(p.name))[0]
  const t1 = Date.now()
  const bk = b ? killPid(b.pid) : false
  const ms = await waitRemount(profile.port, t1, 25000)
  await sleep(3000)
  const after = procTreeMem(child.pid, { role: true })
  const hostAlive = !after?.error
  const wins = hostAlive ? windowList((after.procs ?? []).map((p) => p.pid)) : []
  const pages = hostAlive ? await mountState(profile.port) : []
  const log = readLog()
  killTree(child.pid)
  return {
    rendererPid: r?.pid, browserPid: b?.pid, browserKilled: bk, gapMs: t1 - t0, recoverMs: ms,
    hostAlive, windows: wins, pages, log: evList(log),
    verdict: ms != null ? `복구됨 ${ms}ms` : !hostAlive ? '**호스트 사망 — 앱이 조용히 사라짐**' : wins.length ? `**유령 창 ${wins.length}개**` : '창 없음 + 호스트 생존'
  }
})

// ── A6. 네이티브 폴더 선택 대화상자를 연 채로 렌더러 kill ────────────────────
await run('dialog-open-kill', async () => {
  const { child, cdp, profile } = await boot({ port: 9476, sessions: 0 })
  // 폴더 선택 대화상자(네이티브, 모달) — await하지 않는다(열려 있는 상태를 만든다).
  await cdp.eval(`window.api && window.api.pickDirectory ? void window.api.pickDirectory() : void window.__TAURI_INTERNALS__.invoke('ipc_call', { name: 'dialog:pick-directory', args: {} })`).catch((e) => ({ err: String(e) }))
  await sleep(2500)
  const before = procTreeMem(child.pid, { role: true })
  const winsBefore = windowList((before.procs ?? []).map((p) => p.pid))
  const r = roleOf(before, 'renderer')[0]
  const t0 = Date.now()
  killPid(r.pid)
  const ms = await waitRemount(profile.port, t0, 25000)
  await sleep(3000)
  const after = procTreeMem(child.pid, { role: true })
  const hostAlive = !after?.error
  const wins = hostAlive ? windowList((after.procs ?? []).map((p) => p.pid)) : []
  const pages = hostAlive ? await mountState(profile.port) : []
  const log = readLog()
  killTree(child.pid)
  return {
    windowsBefore: winsBefore, recoverMs: ms, hostAlive, windows: wins, pages, log: evList(log),
    verdict: ms != null ? `복구됨 ${ms}ms (대화상자 창: ${wins.filter((w) => !/AgentCodeGUI/.test(w)).length}개 잔존)` : hostAlive ? '**복구 실패**' : '호스트 종료'
  }
})

const out = {
  what: 'R4 크리틱 — 크래시 복구 상태 기계를 깨뜨리려는 시나리오',
  ...provenance(tauriProfile({})),
  env: envInfo(),
  at: new Date().toISOString(),
  results
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log('\nsaved:', path.relative(REPO, OUT))
process.exit(0)
