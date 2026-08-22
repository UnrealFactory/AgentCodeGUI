// 렌더러/브라우저 크래시 복구 — **출시 블로커의 실증 하네스**.
//
//   node bench/crash.mjs [default|single|gpuproc] [--how=pid|pagecrash] [--rounds=2]
//
// R3 크리틱 §7.3: 창 3개(메인+추가 채팅 2)를 띄우고 렌더러를 죽였더니 세 구성 전부
// OS 창이 유령으로 남고 앱이 다시 마운트되지 않았다. 그 상태를 재현하고, 복구 경로가
// 붙은 뒤 **같은 방법으로 다시 죽여** 복구를 실측한다.
//
// 재는 것:
//   - 죽이기 전/후 프로세스 수·역할, 화면의 200×200 이상 가시 창 수
//   - 메인 페이지가 다시 마운트되는가 (#root children > 0)
//   - **복구 시간** = 죽인 순간 → 다시 마운트된 순간 (ms)
//   - 셸이 남긴 crash-recovery.log(앱 홈)의 이벤트 타임라인
//
// 주의(크리틱 §9-7): `cdp.send('Page.crash')`는 **응답이 오지 않는다.** await하면 영구 정지.
// 그래서 Promise.race로 감싼다. `--how=pid`(기본)는 CDP를 안 쓰고 렌더러 PID를 직접
// taskkill한다 — 실제 크래시에 더 가깝고, 이름이 아니라 **내가 스폰한 트리의 PID**만 죽인다.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { tauriProfile, connectMainPage, cdpTargets, Cdp, procTreeMem, killTree, sleep, envInfo, provenance, REPO } from './lib.mjs'
import { makeMultiFixture } from './fixture.mjs'

const armName = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'default'
const how = (process.argv.find((a) => a.startsWith('--how=')) ?? '--how=pid').split('=')[1]
const rounds = Number((process.argv.find((a) => a.startsWith('--rounds=')) ?? '--rounds=2').split('=')[1])
// `--no-recovery` = 셸의 복구 경로를 끈 대조군(CCG_CRASH_RECOVERY=0). **같은 바이너리로**
// R3의 유령 창 상태를 재현하기 위한 것 — 수정 전/후를 다른 exe로 비교하면 교란이 남는다.
const noRecovery = process.argv.includes('--no-recovery')
const extraEnv = {
  ...(armName === 'single' ? { CCG_SINGLE_PROCESS: '1' } : armName === 'gpuproc' ? { CCG_GPU_PROCESS: '1' } : {}),
  ...(noRecovery ? { CCG_CRASH_RECOVERY: '0' } : {})
}

const HOME = path.join(REPO, '.bench-home-crash')
const profile = tauriProfile({ port: 9461, extraEnv })
profile.env.CCG_HOME = HOME
// 팔 + 죽이는 방법 + 복구 on/off가 전부 파일명에 들어간다(§9-2와 같은 이유 — 덮어쓰면
// 직전 근거가 사라진다).
const OUT = path.join(REPO, 'bench', 'results', `crash-recovery-${armName}-${how}${noRecovery ? '-norecovery' : ''}.json`)

fs.rmSync(HOME, { recursive: true, force: true })
makeMultiFixture(HOME, '3.0.0-beta.1', { panels: 4 })

// 내가 스폰한 트리의 PID만 보는 창 열거 (이름 기반 조회 없음 — 사용자 실앱을 건드리지 않는다).
// 개수만이 아니라 **크기·제목**을 남긴다: "유령 창 3개"라는 주장의 증거가 파일에 있어야 한다.
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

function readLog() {
  const p = path.join(HOME, 'crash-recovery.log')
  if (!fs.existsSync(p)) return []
  return fs.readFileSync(p, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => {
    try { return JSON.parse(l) } catch { return { raw: l } }
  })
}

const child = spawn(profile.cmd, profile.args, { env: { ...process.env, ...profile.env }, cwd: profile.cwd, stdio: 'ignore' })
const out = { arm: armName, recovery: !noRecovery, how, rounds, extraEnv, ...provenance(profile), env: envInfo(), at: new Date().toISOString(), attempts: [] }

try {
  let cdp = await connectMainPage(profile.port, { timeoutMs: 45000 })
  for (;;) { if (await cdp.eval(profile.mountExpr).catch(() => false)) break; await sleep(100) }
  await sleep(3000)
  for (let i = 0; i < 2; i++) { await cdp.eval(`window.api.openSessionWindow()`).catch(() => null); await sleep(3500) }
  await sleep(3000)

  for (let round = 1; round <= rounds; round++) {
    const att = { round, at: new Date().toISOString() }
    const before = procTreeMem(child.pid, { role: true })
    att.before = {
      procs: before.procs?.length,
      roles: before.procs?.map((p) => p.role),
      windows: windowList((before.procs ?? []).map((p) => p.pid)),
      cdpPages: (await cdpTargets(profile.port).catch(() => [])).filter((t) => t.type === 'page').length
    }
    att.before.visibleWindows = att.before.windows.length
    console.log(`[${armName}] round ${round} before:`, JSON.stringify(att.before))
    if (att.before.visibleWindows < 3) console.log('  경고: 창 3개가 안 떴다 — 그래도 진행')

    // ── 죽인다 ──
    const t0 = Date.now()
    if (how === 'pagecrash') {
      // 응답이 오지 않는다 — race 필수(§9-7)
      await Promise.race([cdp.send('Page.crash').catch(() => {}), sleep(2500)])
      att.killed = { how: 'Page.crash' }
    } else {
      // 렌더러 PID 직접 kill. `--how=browser`면 브라우저 프로세스를 죽인다 —
      // `--in-process-gpu`에서 GPU 드라이버가 죽었을 때(TDR 포함) 앱이 보는 그림과 같다.
      // single-process면 렌더러 역할이 아예 없으므로 자동으로 브라우저를 죽인다
      // (그게 그 구성에서의 '렌더러'다 — 같은 프로세스 안에 있다).
      const rend = (before.procs ?? []).filter((p) => p.role === 'renderer')
      const browser = (before.procs ?? []).filter((p) => p.role === 'browser' && /msedgewebview2/i.test(p.name))
      const useBrowser = how === 'browser' || !rend.length
      const target = useBrowser ? browser : rend
      att.killed = {
        how: 'taskkill /PID',
        role: useBrowser ? (rend.length ? 'browser(GPU 크래시 모사)' : 'browser(single-process)') : 'renderer',
        pids: target.map((p) => p.pid)
      }
      for (const p of target) {
        try { execFileSync('taskkill', ['/F', '/PID', String(p.pid)], { stdio: 'ignore', timeout: 10000 }) } catch { /* 이미 죽음 */ }
      }
    }
    console.log('  killed:', JSON.stringify(att.killed))

    // ── 복구를 기다린다 (죽인 순간부터 최대 30초) ──
    let recoveredMs = null
    let remounted = false
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      await sleep(250)
      try {
        // 죽은 렌더러에 붙으면 Runtime.evaluate가 **응답하지 않는다** — 짧은 타임아웃 필수.
        const c2 = await connectMainPage(profile.port, { timeoutMs: 1200, connectTimeoutMs: 1200 })
        const ok = await c2.eval(profile.mountExpr, { timeoutMs: 1200 }).catch(() => false)
        if (ok) { recoveredMs = Date.now() - t0; remounted = true; try { cdp.close() } catch { /* gone */ } cdp = c2; break }
        c2.close()
      } catch { /* 아직 */ }
      // 호스트가 스스로 종료했으면(single-process 정책) 더 기다릴 필요 없다
      const m = procTreeMem(child.pid)
      if (m?.error) break
    }

    await sleep(2500)
    const after = procTreeMem(child.pid, { role: true })
    const hostAlive = !after?.error
    // 메인만이 아니라 **모든 창**이 다시 마운트됐는가. `--process-per-site`로 렌더러를
    // 공유하므로 크래시 하나에 창 전부가 유령이 된다 — 복구도 전부여야 통과다.
    let pagesMounted = null
    if (hostAlive) {
      pagesMounted = []
      for (const t of (await cdpTargets(profile.port).catch(() => [])).filter((x) => x.type === 'page')) {
        try {
          const c = await Cdp.connect(t.webSocketDebuggerUrl, { timeoutMs: 1200 })
          const ok = await c.eval(`!!document.getElementById('root') && document.getElementById('root').children.length > 0`, { timeoutMs: 1200 }).catch(() => false)
          pagesMounted.push({ url: String(t.url).split('/').pop(), mounted: !!ok })
          c.close()
        } catch { pagesMounted.push({ url: String(t.url).split('/').pop(), mounted: false, err: 'connect' }) }
      }
    }
    const afterWins = hostAlive ? windowList((after.procs ?? []).map((p) => p.pid)) : []
    att.after = {
      hostAlive,
      procs: after?.procs?.length ?? 0,
      roles: after?.procs?.map((p) => p.role) ?? [],
      windows: afterWins,
      visibleWindows: afterWins.length,
      mainPageRemounted: remounted,
      pagesMounted,
      allPagesMounted: pagesMounted ? pagesMounted.length > 0 && pagesMounted.every((p) => p.mounted) : null,
      recoveryMs: recoveredMs
    }
    // 판정: (a) 되살아났거나, (b) 유령 없이 깨끗하게 죽었거나. 둘 다 아니면 실패.
    att.verdict = remounted
      ? (att.after.allPagesMounted === false ? '메인만 복구 — 일부 창이 유령' : '복구됨')
      : !hostAlive
        ? '정리 후 종료(유령 없음)'
        : att.after.visibleWindows > 0
          ? '**유령 창 — 실패**'
          : '창은 사라졌으나 호스트가 남아 있음'
    console.log(`  after: ${JSON.stringify(att.after)}\n  판정: ${att.verdict}`)
    out.attempts.push(att)
    if (!hostAlive) break
    await sleep(4000)
  }
  try { cdp.close() } catch { /* gone */ }
} catch (e) {
  out.error = String(e?.message ?? e)
  console.log('ERR', e?.message ?? e)
}

out.shellLog = readLog()
killTree(child.pid)
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log('saved:', path.relative(REPO, OUT))
process.exit(0)
