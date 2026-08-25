// ★R28i N3 — 「AgentCodeGUI3으로 열기」(`app:open-directory`) 실측 하네스.
//
//   node scripts/poc-opendir.mjs --exe=<3.0 exe> [--port=10800] [--tag=r1] [--out=json]
//
// 최종 파리티 R5 §9.1의 `N3`이 잰 자리를 그대로 다시 잰다:
//   ① 3.0이 떠 있는 상태에서 **두 번째 실행(폴더 인자)** → 활성 채팅 cwd·chat-head가 바뀌나
//   ② 창이 **트레이에 숨어 있을 때**도 raise + 폴더 도착이 둘 다 되나
//   ③ 폴더가 아닌 것·없는 경로 → **화면이 말하나**(조용히 사라지지 않나)
//   ④ 원시 호출 `raw:app:open-directory("C:\Code")`가 `{__unimplemented:true}`가 아닌가
//   ⑤ 콜드 런치(앱이 꺼져 있을 때 폴더 인자)와 **같은 착지**인가
//
// 안전 규약: 홈은 전부 격리(`CCG_HOME`)이고 **사용자 실홈의 계정 파일은 읽지도 복사하지도
// 않는다**(bench/fixture.mjs와 다른 점 — 그쪽은 accounts.json을 복사한다). 죽이는 것은
// 자기가 스폰한 PID뿐(`killTree`).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { cdpTargets, Cdp, killTree, sleep, resolveTauriExe, REPO } from '../bench/lib.mjs'

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const a = argv.find((x) => x.startsWith(`--${k}=`))
  return a ? a.slice(k.length + 3) : d
}
const PORT = Number(arg('port', 10800))
const TAG = arg('tag', 'r1')
const EXE = resolveTauriExe(arg('exe', undefined), { targetDir: path.join(REPO, 'target-r28i-od'), only: !arg('exe', '') })
const ROOT = arg('root', path.join('C:\\Temp', 'ccg-r28i-od', TAG))
const OUT = path.resolve(arg('out', path.join(REPO, 'docs', 'critic', `opendir-${TAG}.json`)))
// 감사가 쓴 대기(9초)와 같은 상한. 도착이 그 안에 나면 「9초 대기 → 그대로」의 반증이다.
const WAIT_MS = Number(arg('wait', 9000))

const out = {
  at: new Date().toISOString(),
  tag: TAG,
  exe: EXE,
  exeMtime: (() => { try { return new Date(fs.statSync(EXE).mtimeMs).toISOString() } catch { return null } })(),
  port: PORT,
  root: ROOT,
  waitMs: WAIT_MS,
  cases: {}
}

// ── 격리 홈 (실홈은 한 바이트도 안 만진다) ───────────────────────────────────
function makeHome(name, appVersion = '3.0.0-beta.1') {
  const home = path.join(ROOT, name)
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(path.join(home, 'chats'), { recursive: true })
  fs.writeFileSync(path.join(home, 'profile.json'), JSON.stringify({ nickname: 'OD', color: '#0EA5E9' }))
  // 부팅 엔진 자동 업데이트 끔 — 네트워크·npm을 아예 안 건드린다
  fs.writeFileSync(path.join(home, 'engine-auto-update.json'), JSON.stringify({ enabled: false }))
  fs.writeFileSync(
    path.join(home, 'ui-prefs.json'),
    JSON.stringify({
      'workspace.mode': 'single',
      'explorer.swap': false,
      'chat.zoom': 1,
      'sidebar.autohide': false,
      'whatsnew.seenVersion': appVersion,
      'ui.lang': 'ko',
      // 첫 숨김 안내 카드는 이 하네스의 관심이 아니다 — 트레이 숨김 자체만 본다
      'tray.noticeShown': true
    })
  )
  return home
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true })
  return p
}

// 자기 PID의 **보이는** 창(200x200 이상) 개수 — 트레이 숨김을 증명하는 자리.
function visibleWindows(pid) {
  const ps = String.raw`
param($TargetPid)
Add-Type @"
using System; using System.Runtime.InteropServices;
public class VW {
  public delegate bool EW(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EW cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  public static int Count(uint target){
    int n=0;
    EnumWindows((h,l)=>{ if(!IsWindowVisible(h)) return true; uint p; GetWindowThreadProcessId(h,out p);
      if(p!=target) return true; RECT r; GetWindowRect(h,out r);
      if((r.R-r.L)>=200 && (r.B-r.T)>=200) n++; return true; }, IntPtr.Zero);
    return n; }
}
"@ | Out-Null
[VW]::Count([uint32]$TargetPid)
`
  const f = path.join(os.tmpdir(), `ccg-od-vw-${process.pid}.ps1`)
  fs.writeFileSync(f, ps)
  try {
    return Number(String(execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', f, String(pid)], { encoding: 'utf8', timeout: 20000 })).trim())
  } catch {
    return -1
  }
}

async function connectMain(port, timeoutMs = 90000) {
  const t0 = Date.now()
  for (;;) {
    try {
      const ts = await cdpTargets(port)
      const t = ts.find(
        (x) => x.type === 'page' && !x.url.startsWith('data:') && !/toast\.html|tray\.html/.test(x.url) && !x.url.includes('#') && /index\.html|localhost/.test(x.url)
      )
      if (t?.webSocketDebuggerUrl) return await Cdp.connect(t.webSocketDebuggerUrl)
    } catch {
      /* 아직 */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error('main target not found')
    await sleep(80)
  }
}

async function waitMount(cdp) {
  for (let i = 0; i < 500; i++) {
    const ok = await cdp.eval(`!!document.getElementById('root') && document.getElementById('root').children.length > 0`).catch(() => false)
    if (ok) return true
    await sleep(120)
  }
  return false
}

const J = (v) => JSON.stringify(v)

// 화면이 말하는 것 — chat-head의 작업 폴더 칩과 안내 카드.
const READ = `(() => {
  const head = document.querySelector('.fsel-txt')
  const card = document.querySelector('.pr-modal .pr-title')
  return {
    chatHead: head ? head.textContent : null,
    card: card ? card.textContent : null,
    cardBody: document.querySelector('.pr-modal .fop-confirm') ? document.querySelector('.pr-modal .fop-confirm').textContent : null,
    events: (window.__od || { dirs: [] }).dirs.slice()
  }
})()`

async function read(cdp) {
  return await cdp.eval(READ).catch(() => ({ chatHead: null, card: null, cardBody: null, events: [] }))
}

// 두 번째 인스턴스 — 같은 CCG_HOME으로 폴더 인자를 물려 띄운다(=우클릭 「…으로 열기」).
function secondInstance(home, folderArg) {
  const t0 = Date.now()
  const c = spawn(EXE, folderArg == null ? [] : [folderArg], {
    env: { ...process.env, CCG_HOME: home, CCG_CDP_PORT: '' },
    cwd: REPO,
    stdio: 'ignore'
  })
  return new Promise((res) => {
    let done = false
    const fin = (code) => { if (!done) { done = true; res({ pid: c.pid, code, exitMs: Date.now() - t0 }) } }
    c.on('exit', fin)
    c.on('error', () => fin(-1))
    setTimeout(() => { if (!done) { killTree(c.pid); fin(-2) } }, 20000)
  })
}

// 조건이 참이 될 때까지 화면을 읽는다 — 감사의 「9초 대기」와 같은 상한.
async function until(cdp, pred, ms = WAIT_MS) {
  const t0 = Date.now()
  let last = null
  for (;;) {
    last = await read(cdp)
    if (pred(last)) return { ok: true, ms: Date.now() - t0, ...last }
    if (Date.now() - t0 > ms) return { ok: false, ms: Date.now() - t0, ...last }
    await sleep(120)
  }
}

const same = (a, b) => String(a ?? '').replace(/\\+$/, '').toLowerCase() === String(b ?? '').replace(/\\+$/, '').toLowerCase()

// ── 주행 ────────────────────────────────────────────────────────────────────
fs.mkdirSync(ROOT, { recursive: true })
const HOME = makeHome('home-warm')
const DIRS = {
  t1: mkdirp(path.join(ROOT, 'dirs', 'proj-warm-visible')),
  t2: mkdirp(path.join(ROOT, 'dirs', 'proj-warm-hidden')),
  t3: mkdirp(path.join(ROOT, 'dirs', 'proj-raw')),
  t4: mkdirp(path.join(ROOT, 'dirs', 'proj-cold'))
}
const FILE = path.join(ROOT, 'dirs', 'not-a-folder.txt')
fs.writeFileSync(FILE, 'x')
const MISSING = path.join(ROOT, 'dirs', 'gone-forever')
fs.rmSync(MISSING, { recursive: true, force: true })
out.dirs = { ...DIRS, file: FILE, missing: MISSING }

let child = null
let cdp = null
try {
  child = spawn(EXE, [], { env: { ...process.env, CCG_HOME: HOME, CCG_CDP_PORT: String(PORT) }, cwd: REPO, stdio: 'ignore' })
  out.pid = child.pid
  cdp = await connectMain(PORT)
  out.mounted = await waitMount(cdp)
  await sleep(2500)
  // 방출자 자체를 잡는 계기 — 화면과 별개로 **이벤트가 왔는지**를 본다
  await cdp.eval(`(() => { window.__od = { dirs: [] }; window.api.app.onOpenDirectory((d) => window.__od.dirs.push(d)); return true })()`).catch(() => {})
  out.cases.boot = await read(cdp)

  // ── ① 웜(창이 보이는 상태) + 유효한 폴더 ─────────────────────────────────
  {
    const spawned = await secondInstance(HOME, DIRS.t1)
    const r = await until(cdp, (s) => same(s.chatHead, DIRS.t1))
    out.cases.warmVisible = { arg: DIRS.t1, second: spawned, folderArrived: r.ok, ...r }
    // 인계 파일은 **소비**돼야 한다(남으면 다음 평범한 재실행이 엉뚱한 폴더를 연다)
    out.cases.warmVisible.handoffLeft = fs.existsSync(path.join(HOME, '.pending-open-dir'))
  }

  // ── ② 트레이에 숨은 창 + 유효한 폴더 ─────────────────────────────────────
  {
    out.cases.hidden = { visibleBefore: visibleWindows(child.pid) }
    await cdp.eval(`window.api.win.close()`).catch(() => {})
    await sleep(2000)
    out.cases.hidden.visibleAfterClose = visibleWindows(child.pid)
    const spawned = await secondInstance(HOME, DIRS.t2)
    const r = await until(cdp, (s) => same(s.chatHead, DIRS.t2))
    await sleep(600)
    out.cases.hidden = {
      ...out.cases.hidden,
      arg: DIRS.t2,
      second: spawned,
      folderArrived: r.ok,
      raised: visibleWindows(child.pid) > 0,
      visibleAfterRaise: visibleWindows(child.pid),
      ...r
    }
  }

  // ── ③ 폴더가 아닌 것 · 없는 경로 → 화면이 말하나 ─────────────────────────
  const dismiss = async () => {
    await cdp.eval(`(() => { const b = document.querySelector('.pr-modal .pr-save'); if (b) b.click(); return !!b })()`).catch(() => {})
    await sleep(400)
  }
  {
    const before = await read(cdp)
    const spawned = await secondInstance(HOME, FILE)
    const r = await until(cdp, (s) => !!s.card)
    out.cases.warmFile = { arg: FILE, second: spawned, cardBefore: before.card, spoke: r.ok, ...r, chatHeadUnchanged: same(r.chatHead, before.chatHead) }
    await dismiss()
  }
  {
    const before = await read(cdp)
    const spawned = await secondInstance(HOME, MISSING)
    const r = await until(cdp, (s) => !!s.card)
    out.cases.warmMissing = { arg: MISSING, second: spawned, spoke: r.ok, ...r, chatHeadUnchanged: same(r.chatHead, before.chatHead) }
    await dismiss()
  }

  // ── ③-b 인자 **없는** 두 번째 실행 — 평범한 재실행이 엉뚱한 폴더를 열면 안 된다 ──
  // (인계를 소비 안 하거나 TTL이 없으면 여기서 직전 폴더가 되살아난다)
  {
    const before = await read(cdp)
    const spawned = await secondInstance(HOME, null)
    await sleep(3000)
    const after = await read(cdp)
    out.cases.warmNoArg = {
      second: spawned,
      chatHeadBefore: before.chatHead,
      chatHeadAfter: after.chatHead,
      unchanged: same(before.chatHead, after.chatHead),
      noCard: !after.card,
      raised: visibleWindows(child.pid) > 0
    }
  }

  // ── ④ 계약면: 원시 호출 ──────────────────────────────────────────────────
  {
    const raw = async (ch, payload = []) =>
      await cdp
        .eval(
          `window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: ${J(ch)}, payload: ${J(payload)} }).then(r => JSON.stringify(r) ?? 'undefined').catch(e => 'REJECT ' + String(e))`,
          { awaitPromise: true, timeoutMs: 25000 }
        )
        .catch((x) => 'THROW ' + x.message)
    out.cases.raw = {}
    out.cases.raw['app:open-directory(T3)'] = await raw('app:open-directory', [DIRS.t3])
    const landed = await until(cdp, (s) => same(s.chatHead, DIRS.t3), 5000)
    out.cases.raw.landedT3 = landed.ok
    out.cases.raw['app:open-directory("")'] = await raw('app:open-directory', [''])
    const spokeEmpty = await until(cdp, (s) => !!s.card, 5000)
    out.cases.raw.emptySpoke = spokeEmpty.ok
    out.cases.raw.emptyCard = spokeEmpty.card
    await dismiss()
    // 감사가 부른 것과 **글자 그대로 같은** 호출
    out.cases.raw['app:open-directory("C:\\\\Code")'] = await raw('app:open-directory', ['C:\\Code'])
    out.cases.raw['app:get-initial-dir'] = await raw('app:get-initial-dir', [])
    const landedCode = await until(cdp, (s) => same(s.chatHead, 'C:\\Code'), 5000)
    out.cases.raw.landedCCode = landedCode.ok
    out.cases.raw.chatHeadAfter = landedCode.chatHead
  }

  out.cases.eventsSeen = (await read(cdp)).events
} catch (e) {
  out.fatal = String(e.stack ?? e).slice(0, 900)
} finally {
  try { cdp?.close() } catch { /* 닫힘 */ }
  if (child?.pid) killTree(child.pid)
}

// ── ⑤ 콜드 런치 — 앱이 꺼져 있을 때 폴더 인자 ────────────────────────────────
await sleep(1200)
{
  const home2 = makeHome('home-cold')
  let c2 = null
  let cdp2 = null
  try {
    const t0 = Date.now()
    c2 = spawn(EXE, [DIRS.t4], { env: { ...process.env, CCG_HOME: home2, CCG_CDP_PORT: String(PORT + 1) }, cwd: REPO, stdio: 'ignore' })
    cdp2 = await connectMain(PORT + 1)
    const mounted = await waitMount(cdp2)
    const r = await until(cdp2, (s) => same(s.chatHead, DIRS.t4), 15000)
    out.cases.cold = { arg: DIRS.t4, mounted, folderArrived: r.ok, msFromLaunch: Date.now() - t0, chatHead: r.chatHead, card: r.card }
  } catch (e) {
    out.cases.cold = { error: String(e.message ?? e).slice(0, 300) }
  } finally {
    try { cdp2?.close() } catch { /* 닫힘 */ }
    if (c2?.pid) killTree(c2.pid)
  }
}

// 같은 착지인가 — 웜(보이는 창)과 콜드가 각자 받은 폴더에 **같은 모양으로** 앉았나
out.sameLanding =
  !!out.cases.warmVisible?.folderArrived &&
  !!out.cases.cold?.folderArrived &&
  same(out.cases.warmVisible.chatHead, DIRS.t1) &&
  same(out.cases.cold.chatHead, DIRS.t4)

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
const line = (k, v) => console.log(String(k).padEnd(34), String(v).slice(0, 120))
line('exe', out.exe)
line('mounted', out.mounted)
line('warm(보이는 창) 도착', `${out.cases.warmVisible?.folderArrived} · ${out.cases.warmVisible?.ms}ms · head=${out.cases.warmVisible?.chatHead}`)
line('warm 인계파일 잔존', out.cases.warmVisible?.handoffLeft)
line('트레이 숨김 창 수', `${out.cases.hidden?.visibleBefore} → ${out.cases.hidden?.visibleAfterClose} → ${out.cases.hidden?.visibleAfterRaise}`)
line('hidden 도착', `${out.cases.hidden?.folderArrived} · ${out.cases.hidden?.ms}ms · head=${out.cases.hidden?.chatHead}`)
line('파일 인자 → 카드', `${out.cases.warmFile?.spoke} · ${out.cases.warmFile?.card}`)
line('없는 경로 → 카드', `${out.cases.warmMissing?.spoke} · ${out.cases.warmMissing?.card}`)
line('인자 없는 재실행 무변화', `${out.cases.warmNoArg?.unchanged} · head=${out.cases.warmNoArg?.chatHeadAfter} · card=${out.cases.warmNoArg?.noCard}`)
for (const [k, v] of Object.entries(out.cases.raw ?? {})) line(`raw ${k}`, v)
line('cold 도착', `${out.cases.cold?.folderArrived} · head=${out.cases.cold?.chatHead}`)
line('같은 착지', out.sameLanding)
line('saved', OUT)
