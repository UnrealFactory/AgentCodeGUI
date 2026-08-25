// 최종 파리티 R2 — 「눌러서 되는가」 실측기
//
//   node docs/critic/tools/critic-r28e-press.mjs tauri --exe=<경로> [--port=n] [--out=json]
//   node docs/critic/tools/critic-r28e-press.mjs electron          [--port=n] [--out=json]
//
// 채널 스캔(critic-r28e-channels.mjs)은 **핸들러가 있는가**만 답한다. 이 도구는 화면에서
// 실제로 눌러 결과를 본다 — R1이 잡은 「화면은 뜨는데 눌러도 아무 일이 없다」는 채널
// 스캔으로는 절대 안 보이고, 반대로 **핸들러가 생겼는데 화면이 여전히 안 되는** 자리도
// 스캔으로는 안 보인다.
//
// 안전 규약(사용자 실홈 불가침):
//   · 픽스처 홈은 실홈의 `accounts.json`을 **복사**하고 `engines/`를 **정션**한다.
//     따라서 로그아웃(서버 토큰 해지)·설치·정리·업데이트는 **한 번도 부르지 않는다.**
//   · 재정렬은 격리 홈의 사본만 바꾸므로 부른다(그게 이 라운드의 판정 대상이다).
//   · 네이티브 대화상자는 **내가 띄운 프로세스의 창만** 찾아 WM_CLOSE로 닫는다
//     (이름 기반 taskkill 없음).
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { electronProfile, tauriProfile, cdpTargets, Cdp, killTree, sleep, REPO } from '../../../bench/lib.mjs'
import { makeFixtureHome } from '../../../bench/fixture.mjs'
import { augmentFixture } from '../../../bench/screens.mjs'

const kind = process.argv[2] ?? 'tauri'
const argv = process.argv.slice(3)
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d }
const PORT = Number(arg('port', kind === 'tauri' ? 10235 : 10234))
const OUT = path.resolve(arg('out', path.join(REPO, 'docs', 'critic', `final-parity-r2-press-${kind}.json`)))
const ONLY = arg('only', '') ? new Set(arg('only', '').split(',')) : null
const profile = kind === 'tauri' ? tauriProfile({ port: PORT, exe: arg('exe', undefined) }) : electronProfile({ port: PORT })
if (kind !== 'tauri') profile.args = ['.', `--remote-debugging-port=${PORT}`]
const APP_VERSION = kind === 'tauri' ? '3.0.0-beta.1' : '2.6.2'
const HOME = path.join(os.tmpdir(), `ccg-r28e-press-${kind}`)

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch { /* 잠기면 덮어쓴다 */ }
makeFixtureHome(HOME, APP_VERSION)
augmentFixture(HOME, { repo: REPO })

const child = spawn(profile.cmd, profile.args, {
  env: { ...process.env, ...profile.env, CCG_HOME: HOME },
  cwd: profile.cwd,
  stdio: 'ignore'
})

const out = { app: profile.name, kind, at: new Date().toISOString(), exe: profile.cmd, home: HOME, pid: child.pid, cases: {} }

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

/** 내가 띄운 PID(와 그 자식)의 **가시 창 제목** 목록. 이름 기반 kill 없음. */
function visibleWindowsOf(pid) {
  const ps = String.raw`
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;
public class WW {
  public delegate bool E(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(E cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static List<string> Rows = new List<string>();
  public static void Scan(uint[] pids){
    Rows.Clear();
    EnumWindows((h,l)=>{
      if(!IsWindowVisible(h)) return true;
      uint p; GetWindowThreadProcessId(h,out p);
      foreach(var t in pids){ if(t==p){
        StringBuilder sb=new StringBuilder(256); GetWindowTextW(h,sb,256);
        Rows.Add(h.ToInt64()+"|"+p+"|"+sb.ToString()); break; } }
      return true;
    }, IntPtr.Zero);
  }
  public static void Close(long h){ PostMessage(new IntPtr(h), 0x0010, IntPtr.Zero, IntPtr.Zero); }
}
"@
$root = ${pid}
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId
$set = New-Object System.Collections.Generic.HashSet[uint32]
[void]$set.Add([uint32]$root)
for($i=0;$i -lt 6;$i++){ foreach($p in $all){ if($set.Contains([uint32]$p.ParentProcessId)){ [void]$set.Add([uint32]$p.ProcessId) } } }
[WW]::Scan(@($set))
[WW]::Rows -join "` + "`n" + String.raw`"
`
  try {
    const o = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 30000 })
    return o.split(/\r?\n/).filter(Boolean).map((l) => {
      const [h, p, ...t] = l.split('|')
      return { h, pid: Number(p), title: t.join('|') }
    })
  } catch { return [] }
}

function closeWindow(handle) {
  const ps = String.raw`
Add-Type @"
using System; using System.Runtime.InteropServices;
public class WC { [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); }
"@
[WC]::PostMessage([IntPtr]::new(${handle}), 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
`
  try { execFileSync('powershell', ['-NoProfile', '-Command', ps], { timeout: 20000 }) } catch { /* 이미 닫힘 */ }
}

let cdp = null
const record = (id, v) => { out.cases[id] = v; console.log(`\n[${id}] ${JSON.stringify(v).slice(0, 900)}`) }
const want = (id) => !ONLY || ONLY.has(id)

const HELP = `(() => {
  window.__q = (s) => document.querySelector(s)
  window.__all = (s) => [...document.querySelectorAll(s)]
  window.__txt = (s) => (document.querySelector(s)?.textContent || '').replace(/\\s+/g, ' ').trim()
  window.__clickText = (sel, txt) => {
    const el = [...document.querySelectorAll(sel)].find((x) => (x.textContent || '').includes(txt))
    if (!el) return false
    el.click(); return true
  }
  window.__openSettings = async (label) => {
    if (!document.querySelector('.set-modal')) {
      document.querySelector('.sb-foot')?.click()
      await new Promise((r) => setTimeout(r, 800))
    }
    const b = [...document.querySelectorAll('.set-nav .set-ni')].find((x) => (x.textContent || '').trim() === label)
    if (!b) return '레일에 ' + label + ' 없음: ' + [...document.querySelectorAll('.set-nav .set-ni')].map((x) => x.textContent.trim()).join(',')
    b.click()
    await new Promise((r) => setTimeout(r, 900))
    const on = document.querySelector('.set-nav .set-ni.on')
    return (on?.textContent || '').trim()
  }
  return true
})()`

try {
  cdp = await connectMain(PORT)
  await cdp.send('Runtime.enable').catch(() => {})
  out.shimWarns = []
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
  await sleep(4000)
  await cdp.eval(HELP)

  // ── 1. T1 — 설정 ▸ Account: 두 엔진 목록 · 재정렬 · 삭제 확인 카드 ────────────
  if (want('account')) {
    const r = { }
    r.tab = await cdp.eval(`__openSettings('Account')`, { awaitPromise: true, timeoutMs: 25000 })
    await sleep(2500)
    const snap = `(() => ({
      antRows: __all('.acct-card, .set-acct .acc-row, .acct-row').length,
      cards: __all('[class*="acct"]').length,
      addBtns: __all('.set-inner button').filter((b) => /계정 추가|Add account/.test(b.textContent || '')).length,
      emails: __all('.set-inner').map((x) => (x.textContent || '').match(/[\\w.+-]+@[\\w.-]+/g) || []).flat().slice(0, 12),
      sortBtns: __all('.set-inner button').map((b) => (b.textContent || '').trim()).filter((s) => s && s.length < 14).slice(0, 24)
    }))()`
    r.before = await cdp.eval(snap)
    // 계정 목록 개수는 API로도 읽는다(화면 셀렉터가 갈릴 수 있어 둘 다 남긴다)
    r.apiBefore = await cdp.eval(
      `Promise.all([window.api.auth.listAccounts(), window.api.codexAuth.listAccounts()]).then(([a, c]) => ({ ant: a.map(x => x.email), cx: c.map(x => x.email) }))`,
      { awaitPromise: true, timeoutMs: 25000 }
    )
    record('account', r)
  }

  // ── 2. Codex 계정 「맨 위로」/정렬 — 3.0은 채널이 없다(codex-auth:reorder-accounts) ──
  if (want('codex-reorder')) {
    const r = {}
    r.cxBefore = await cdp.eval(`window.api.codexAuth.listAccounts().then(l => l.map(a => a.email))`, { awaitPromise: true, timeoutMs: 25000 })
    // 렌더러가 실제로 부르는 그 호출 그대로 — 결과를 화면 상태(setCxAccounts)에 넣는 값이다
    r.reorderReturns = await cdp.eval(
      `window.api.codexAuth.listAccounts().then(l => window.api.codexAuth.reorderAccounts(l.map(a => a.email))).then(r => ({ isArray: Array.isArray(r), n: (r || []).length, emails: (r || []).map(a => a.email) }))`,
      { awaitPromise: true, timeoutMs: 25000 }
    )
    r.antReorderReturns = await cdp.eval(
      `window.api.auth.listAccounts().then(l => window.api.auth.reorderAccounts(l.map(a => a.email))).then(r => ({ isArray: Array.isArray(r), n: (r || []).length }))`,
      { awaitPromise: true, timeoutMs: 25000 }
    )
    record('codex-reorder', r)
  }

  // ── 2-b. OpenAI 「계정 추가」를 **화면에서 누른다** ─────────────────────────────
  //
  // 3.0에서 안전한 이유: `codex-auth:login` 문자열이 Rust 소스에 **0회**라 디스패처가
  // 매칭할 수 없다(= 자식 프로세스도 브라우저도 안 뜬다). 2.6.2에서는 진짜 로그인이
  // 시작되므로 **누르지 않는다** — 그쪽은 코드 대조로 갈음한다.
  if (want('codex-login') && kind === 'tauri') {
    const r = {}
    r.tab = await cdp.eval(`__openSettings('Account')`, { awaitPromise: true, timeoutMs: 25000 })
    await sleep(2000)
    const btns = `(() => {
      const rows = __all('.set-inner .set-addrow')
      return rows.map((b) => (b.textContent || '').trim())
    })()`
    r.addRows = await cdp.eval(btns)
    const t0 = Date.now()
    // OpenAI 섹션의 「계정 추가」 = 마지막 set-addrow (Anthropic 섹션이 먼저 그려진다)
    r.pressed = await cdp.eval(`(() => { const rows = __all('.set-inner .set-addrow'); const b = rows[rows.length - 1]; if (!b) return false; b.click(); return true })()`)
    await sleep(4000)
    r.msAfterPress = Date.now() - t0
    r.busySpinner = await cdp.eval(`__all('.set-inner .set-spin').length`)
    r.cxRowsAfter = await cdp.eval(`window.api.codexAuth.listAccounts().then(l => l.length)`, { awaitPromise: true, timeoutMs: 20000 })
    r.newWindows = visibleWindowsOf(child.pid).map((w) => w.title)
    r.shimWarnsNow = out.shimWarns.slice()
    record('codex-login', r)
    await cdp.eval(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true })()`).catch(() => {})
    await sleep(800)
  }

  // ── 3. 설정 닫기 ────────────────────────────────────────────────────────────
  await cdp.eval(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true })()`).catch(() => {})
  await sleep(900)

  // ── 4. T3 — 워크바 한도 팝오버에 값이 있는가 ────────────────────────────────
  if (want('limit-pop')) {
    const r = {}
    // 하네스의 `workbar-context-pop`과 같은 자리 — 5번째 칩(인덱스 4)이 컨텍스트·한도다.
    r.clicked = await cdp.eval(`(() => { const c = __all('.workbar .wb-chip')[4]; if (!c) return false; c.click(); return true })()`)
    await sleep(4000)
    r.popText = await cdp.eval(`(() => { const p = document.querySelector('.wb-cell .wb-pop.r'); return p ? (p.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500) : '(팝오버 없음)' })()`)
    r.prows = await cdp.eval(`__all('.wb-cell .wb-pop.r .wb-prow').length`)
    r.hasNoData = /데이터 없음|No data/.test(String(r.popText))
    await cdp.eval(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true })()`).catch(() => {})
    await sleep(600)
    record('limit-pop', r)
  }

  // ── 5. H1 — 컴포저 「＋」가 진짜 파일 대화상자를 띄우는가 ────────────────────
  if (want('attach-plus')) {
    const r = {}
    r.before = visibleWindowsOf(child.pid).map((w) => w.title)
    // 클릭은 **기다리지 않는다** — 대화상자가 뜨면 그 호출은 사용자가 닫을 때까지 안 돌아온다
    r.btnFound = await cdp.eval(`__all('.composer button.plus').length`)
    await cdp.eval(`(() => { const b = document.querySelector('.composer button.plus'); if (!b) return false; b.click(); return true })()`).catch(() => {})
    let seen = null
    for (let i = 0; i < 24; i++) {
      await sleep(500)
      const now = visibleWindowsOf(child.pid)
      const fresh = now.filter((w) => !r.before.includes(w.title))
      if (fresh.length) { seen = fresh; break }
    }
    r.dialogWindows = seen ? seen.map((w) => w.title) : []
    r.opened = !!seen
    for (const w of seen ?? []) closeWindow(w.h)
    await sleep(1500)
    r.afterClose = visibleWindowsOf(child.pid).map((w) => w.title)
    record('attach-plus', r)
  }

  // ── 7. §1.4 — 에러 안전망에서 나올 수 있는가 (부팅 루프) ────────────────────
  if (want('error-boundary')) {
    const r = {}
    // 왼쪽 칼럼은 탐색기와 사이드바가 **자리를 나눠 쓴다** — 탐색기가 열려 있으면
    // `.sb-item`이 0이라 "채팅 목록이 없다"로 오독된다. 먼저 닫는다.
    r.explorerClosed = await cdp.eval(
      `(async () => {
        if (document.querySelector('.lcol .explorer')) { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '\`', bubbles: true })); await new Promise((x) => setTimeout(x, 1200)) }
        return !document.querySelector('.lcol .explorer')
      })()`, { awaitPromise: true, timeoutMs: 20000 }
    )
    r.sbItemsPre = await cdp.eval(`__all('.sidebar .sb-item').length`)
    r.selected = await cdp.eval(
      `(async () => {
        const it = [...document.querySelectorAll('.sidebar .sb-item')].find((x) => (x.textContent || '').includes('벤치 예외 채팅'))
        if (!it) return 'no-item'
        it.click()
        await new Promise((x) => setTimeout(x, 2500))
        return document.querySelectorAll('.eb-card').length
      })()`, { awaitPromise: true, timeoutMs: 30000 }
    )
    await sleep(1500)
    r.beforeReload = await cdp.eval(`({ eb: __all('.eb-card').length, sbItems: __all('.sidebar .sb-item').length, win: __all('.win').length })`)
    // 카드의 「앱 새로고침」을 실제로 누른다
    await cdp.eval(`__clickText('.eb-actions .eb-btn', '새로고침') || __clickText('.eb-actions .eb-btn', 'Reload')`).catch(() => {})
    // 리로드는 CDP 세션을 끊으므로 다시 붙는다
    try { cdp.close() } catch { /* 닫힘 */ }
    await sleep(6000)
    cdp = await connectMain(PORT)
    await cdp.send('Runtime.enable').catch(() => {})
    for (let i = 0; i < 200; i++) {
      const ok = await cdp.eval(`document.readyState === 'complete'`).catch(() => false)
      if (ok) break
      await sleep(150)
    }
    await sleep(5000)
    await cdp.eval(HELP).catch(() => {})
    r.afterReload = await cdp.eval(`({ eb: __all('.eb-card').length, sbItems: __all('.sidebar .sb-item').length, win: __all('.win').length, chat: __all('.chat').length })`).catch((e) => 'THROW ' + e.message)
    r.stuck = !!(r.afterReload && r.afterReload.eb > 0 && r.afterReload.sbItems === 0)
    record('error-boundary', r)
  }
} catch (e) {
  out.fatal = String(e.stack ?? e).slice(0, 800)
  console.log('FATAL', out.fatal.split('\n')[0])
} finally {
  try { cdp?.close() } catch { /* 닫힘 */ }
  killTree(child.pid)
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log(`\nsaved: ${OUT}`)
