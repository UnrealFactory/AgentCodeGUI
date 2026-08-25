// ★R28i OPENDIR 확인 크리틱 R1의 결함 D1~D5를 **그대로 다시 재는** 계기.
//
//   node scripts/poc-opendir-crit.mjs --exe=<3.0 exe> [--port=10820] [--tag=fix-r1] [--out=json]
//
// `scripts/poc-opendir.mjs`가 「체크리스트가 닫혔나」를 재는 계기라면 이쪽은
// **크리틱이 실패시킨 칸만** 잰다. 판정문 `docs/critic/r28i-opendir-critic-r1.md`의 번호를 그대로 쓴다:
//
//   D1 (중·최대 격차) 권한 없는 폴더가 **열리고** 탐색기가 "비어 있음"이라 거짓말한다
//   D2 (중) 기동 후 0.3~0.8초 창의 폴더가 조용히 사라지고, 남은 인계가
//           **인자 없는 재실행**을 그 폴더로 납치한다
//   D3 (중·이월) 콜드 런치의 나쁜 인자는 침묵한다
//   D4 (낮음) 공백만 있는 인자는 카드도 없이 사라진다
//   D5 (낮음·정보) 겹친 두 번의 열기에서 앞의 것은 인계가 덮여 사라진다
//
// 안전 규약(poc-opendir.mjs와 같다): 홈은 전부 격리(`CCG_HOME`) · 사용자 실홈은 읽지도
// 쓰지도 않는다 · 죽이는 것은 **자기가 스폰한 PID**뿐(`killTree` — 이름 기반 kill 없음).
// deny ACL 픽스처는 주행 끝에 상속을 되돌려 지운다.
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
const PORT = Number(arg('port', 10820))
const TAG = arg('tag', 'fix-r1')
const EXE = resolveTauriExe(arg('exe', undefined), { targetDir: path.join(REPO, 'target-r28i-od'), only: !arg('exe', '') })
const ROOT = arg('root', path.join('C:\\Temp', 'ccg-r28i-odcrit', TAG))
const OUT = path.resolve(arg('out', path.join(REPO, 'docs', 'critic', `opendir-crit-${TAG}.json`)))
const WAIT_MS = Number(arg('wait', 9000))
// D2 경주 스윕의 지연들 — 크리틱이 잰 자리(+30 · +327)를 반드시 포함한다
const RACE = String(arg('race', '30,150,330,600,900')).split(',').map(Number)
const HANDOFF = '.pending-open-dir'

const out = {
  at: new Date().toISOString(),
  tag: TAG,
  exe: EXE,
  exeMtime: (() => { try { return new Date(fs.statSync(EXE).mtimeMs).toISOString() } catch { return null } })(),
  port: PORT,
  root: ROOT,
  race: RACE,
  cases: {}
}

// ── 격리 홈 ─────────────────────────────────────────────────────────────────
function makeHome(name, appVersion = '3.0.0-beta.1') {
  const home = path.join(ROOT, name)
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(path.join(home, 'chats'), { recursive: true })
  fs.writeFileSync(path.join(home, 'profile.json'), JSON.stringify({ nickname: 'OD', color: '#0EA5E9' }))
  fs.writeFileSync(path.join(home, 'engine-auto-update.json'), JSON.stringify({ enabled: false }))
  fs.writeFileSync(
    path.join(home, 'ui-prefs.json'),
    JSON.stringify({
      'workspace.mode': 'single',
      // D1의 증거('비어 있음')는 탐색기 트리에 있다 — 열어 둔다
      'explorer.swap': true,
      'chat.zoom': 1,
      'sidebar.autohide': false,
      'whatsnew.seenVersion': appVersion,
      'ui.lang': 'ko',
      'tray.noticeShown': true
    })
  )
  return home
}

const mkdirp = (p) => (fs.mkdirSync(p, { recursive: true }), p)

// ── deny ACL 픽스처 — 「부모는 읽히는데 안은 못 읽는」 폴더 ───────────────────
function denyAcl(dir) {
  try {
    execFileSync('icacls', [dir, '/inheritance:r', '/grant:r', 'SYSTEM:(OI)(CI)F'], { encoding: 'utf8', timeout: 20000 })
  } catch {
    /* 정책이 막으면 아래 probe가 false를 준다 */
  }
  // 진짜로 걸렸는지 **Node로 확인** — 걸리지 않았으면 이 칸의 측정은 의미가 없다
  let listable = true
  try {
    fs.readdirSync(dir)
  } catch {
    listable = false
  }
  let statable = false
  try {
    statable = fs.statSync(dir).isDirectory()
  } catch {
    /* 부모까지 막혔으면 false */
  }
  return { listable, statable }
}
function undoAcl(dir) {
  try {
    execFileSync('icacls', [dir, '/inheritance:e'], { encoding: 'utf8', timeout: 20000 })
  } catch {
    /* 최선 노력 */
  }
}

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
  const f = path.join(os.tmpdir(), `ccg-odc-vw-${process.pid}.ps1`)
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

// 화면 다섯 칸 — 작업 폴더 칩 · 카드 제목/본문 · **탐색기 트리**(D1의 "비어 있음"이 여기 있다)
const READ = `(() => {
  const head = document.querySelector('.fsel-txt')
  const tree = document.querySelector('.fxtree')
  return {
    chatHead: head ? head.textContent : null,
    card: document.querySelector('.pr-modal .pr-title') ? document.querySelector('.pr-modal .pr-title').textContent : null,
    cardBody: document.querySelector('.pr-modal .fop-confirm') ? document.querySelector('.pr-modal .fop-confirm').textContent : null,
    tree: tree ? tree.textContent : null,
    treeRows: tree ? tree.querySelectorAll('.fxr').length : -1,
    treeEmpty: tree ? !!tree.querySelector('.fx-empty') : null
  }
})()`

const read = async (cdp) => await cdp.eval(READ).catch(() => ({ chatHead: null, card: null, cardBody: null, tree: null, treeRows: -1 }))

function spawnSecond(home, args) {
  const t0 = Date.now()
  const c = spawn(EXE, args, { env: { ...process.env, CCG_HOME: home, CCG_CDP_PORT: '' }, cwd: REPO, stdio: 'ignore' })
  return new Promise((res) => {
    let done = false
    const fin = (code) => { if (!done) { done = true; res({ pid: c.pid, code, exitMs: Date.now() - t0 }) } }
    c.on('exit', fin)
    c.on('error', () => fin(-1))
    setTimeout(() => { if (!done) { killTree(c.pid); fin(-2) } }, 25000)
  })
}

async function until(cdp, pred, ms = WAIT_MS) {
  const t0 = Date.now()
  for (;;) {
    const last = await read(cdp)
    if (pred(last)) return { ok: true, ms: Date.now() - t0, ...last }
    if (Date.now() - t0 > ms) return { ok: false, ms: Date.now() - t0, ...last }
    await sleep(100)
  }
}

const same = (a, b) => String(a ?? '').replace(/\\+$/, '').toLowerCase() === String(b ?? '').replace(/\\+$/, '').toLowerCase()
const headHas = (s, dir) => String(s.chatHead ?? '').toLowerCase().includes(String(dir).toLowerCase())

// ── 픽스처 ───────────────────────────────────────────────────────────────────
fs.mkdirSync(ROOT, { recursive: true })
const FX = mkdirp(path.join(ROOT, 'fx'))
const PROJ_A = mkdirp(path.join(FX, 'ProjA'))
fs.writeFileSync(path.join(PROJ_A, 'AAA_alpha.txt'), 'a')
mkdirp(path.join(PROJ_A, 'alpha_dir'))
const PROJ_B = mkdirp(path.join(FX, 'ProjB'))
fs.writeFileSync(path.join(PROJ_B, 'BBB_beta.txt'), 'b')
const EMPTY = mkdirp(path.join(FX, 'EmptyProj')) // 「안이 비었다」 ≠ 「안을 못 본다」
const DENIED = mkdirp(path.join(FX, 'Denied'))
fs.writeFileSync(path.join(DENIED, 'secret.txt'), 's')
const FILE = path.join(FX, 'a-file.txt')
fs.writeFileSync(FILE, 'x')
const MISSING = path.join(FX, 'no-such-folder-xyz')
fs.rmSync(MISSING, { recursive: true, force: true })
out.fixtures = { PROJ_A, PROJ_B, EMPTY, DENIED, FILE, MISSING }
out.aclProbe = denyAcl(DENIED)

const plantHandoff = (home, p) => fs.writeFileSync(path.join(home, HANDOFF), JSON.stringify({ path: p, at: Date.now() }))
const handoffLeft = (home) => fs.existsSync(path.join(home, HANDOFF))

// ── A. 웜 주행 (첫 인스턴스 하나 · 창 보임) ──────────────────────────────────
{
  const HOME = makeHome('home-warm')
  let child = null
  let cdp = null
  try {
    child = spawn(EXE, [], { env: { ...process.env, CCG_HOME: HOME, CCG_CDP_PORT: String(PORT) }, cwd: REPO, stdio: 'ignore' })
    out.pid = child.pid
    cdp = await connectMain(PORT)
    out.mounted = await waitMount(cdp)
    await sleep(2500)
    const dismiss = async () => {
      await cdp.eval(`(() => { const b = document.querySelector('.pr-modal .pr-save'); if (b) b.click(); return !!b })()`).catch(() => {})
      await sleep(400)
    }

    // 기준 착지 하나 — 이후 「chat-head가 안 흔들렸다」의 잣대가 된다
    {
      const s = await spawnSecond(HOME, [PROJ_A])
      const r = await until(cdp, (x) => headHas(x, PROJ_A))
      out.cases.baseLanding = { arg: PROJ_A, second: s, landed: r.ok, ms: r.ms, chatHead: r.chatHead, treeRows: r.treeRows }
    }

    // ★D1 — 권한 없는 폴더. 열리면 안 되고, 화면이 말해야 한다.
    {
      const before = await read(cdp)
      const s = await spawnSecond(HOME, [DENIED])
      const r = await until(cdp, (x) => !!x.card)
      await sleep(500)
      const after = await read(cdp)
      out.cases.D1_warmDenied = {
        arg: DENIED,
        second: s,
        spoke: r.ok,
        ms: r.ms,
        card: r.card,
        cardBody: r.cardBody,
        chatHeadBefore: before.chatHead,
        chatHeadAfter: after.chatHead,
        chatHeadUnchanged: same(before.chatHead, after.chatHead),
        landedOnDenied: headHas(after, DENIED),
        tree: after.tree,
        treeRows: after.treeRows,
        handoffLeft: handoffLeft(HOME)
      }
      await dismiss()
    }

    // ★D4 — 공백만 있는 인자
    {
      const before = await read(cdp)
      const s = await spawnSecond(HOME, ['   '])
      const r = await until(cdp, (x) => !!x.card)
      const after = await read(cdp)
      out.cases.D4_blank = {
        second: s,
        spoke: r.ok,
        ms: r.ms,
        card: r.card,
        cardBody: r.cardBody,
        chatHeadUnchanged: same(before.chatHead, after.chatHead)
      }
      await dismiss()
    }

    // 빈 폴더는 **그대로 열려야 한다** — D1의 처방이 과잉이면 여기서 걸린다
    {
      const s = await spawnSecond(HOME, [EMPTY])
      const r = await until(cdp, (x) => headHas(x, EMPTY))
      out.cases.emptyDirStillOpens = { arg: EMPTY, second: s, landed: r.ok, ms: r.ms, tree: r.tree, treeRows: r.treeRows, card: r.card }
    }

    // ★D2(b) — 인계 잔해가 **인자 없는 재실행**을 납치하는가.
    // 잔해를 손으로 심어 결정적으로 잰다(경주에 기대지 않는다).
    {
      const before = await read(cdp)
      plantHandoff(HOME, PROJ_B)
      const s = await spawnSecond(HOME, [])
      await sleep(4000)
      const after = await read(cdp)
      out.cases.D2_hijackNoArg = {
        planted: PROJ_B,
        second: s,
        chatHeadBefore: before.chatHead,
        chatHeadAfter: after.chatHead,
        hijacked: headHas(after, PROJ_B),
        unchanged: same(before.chatHead, after.chatHead),
        card: after.card,
        raised: visibleWindows(child.pid) > 0,
        handoffStillThere: handoffLeft(HOME)
      }
    }

    // 심어 둔 잔해가 남아 있어도 **진짜 열기는 그대로 통해야 한다**
    {
      const s = await spawnSecond(HOME, [PROJ_B])
      const r = await until(cdp, (x) => headHas(x, PROJ_B))
      out.cases.realOpenStillWorks = { arg: PROJ_B, second: s, landed: r.ok, ms: r.ms, handoffLeft: handoffLeft(HOME) }
    }

    // ★D5 — 겹친 두 번(A 직후 B). 끝 상태만 기록한다(정보).
    {
      const p1 = spawnSecond(HOME, [PROJ_A])
      await sleep(40)
      const p2 = spawnSecond(HOME, [PROJ_B])
      const [s1, s2] = await Promise.all([p1, p2])
      await sleep(3500)
      const after = await read(cdp)
      out.cases.D5_overlap = { first: { arg: PROJ_A, ...s1 }, second: { arg: PROJ_B, ...s2 }, chatHead: after.chatHead, endsOnB: headHas(after, PROJ_B), endsOnA: headHas(after, PROJ_A) }
    }

    // 계약면 — 원시 호출
    {
      const raw = async (ch, payload = []) =>
        await cdp
          .eval(
            `window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: ${J(ch)}, payload: ${J(payload)} }).then(r => JSON.stringify(r) ?? 'undefined').catch(e => 'REJECT ' + String(e))`,
            { awaitPromise: true, timeoutMs: 30000 }
          )
          .catch((x) => 'THROW ' + x.message)
      out.cases.raw = {}
      out.cases.raw['open-directory(Denied)'] = await raw('app:open-directory', [DENIED])
      out.cases.raw['open-directory(Empty)'] = await raw('app:open-directory', [EMPTY])
      out.cases.raw['open-directory("   ")'] = await raw('app:open-directory', ['   '])
      out.cases.raw['get-initial-dir'] = await raw('app:get-initial-dir', [])
      await sleep(600)
      await dismiss()
      await sleep(400)
      await dismiss()
    }
  } catch (e) {
    out.cases.warmFatal = String(e.stack ?? e).slice(0, 900)
  } finally {
    try { cdp?.close() } catch { /* 닫힘 */ }
    if (child?.pid) killTree(child.pid)
  }
}

// ── B. 콜드 런치 — 나쁜 인자에 화면이 말하나 (D3 · D1의 콜드 반쪽) ────────────
async function coldRun(name, argPath, port, expectLandOn) {
  const home = makeHome(name)
  let c = null
  let cdp = null
  const res = { arg: argPath }
  try {
    const t0 = Date.now()
    c = spawn(EXE, argPath == null ? [] : [argPath], { env: { ...process.env, CCG_HOME: home, CCG_CDP_PORT: String(port) }, cwd: REPO, stdio: 'ignore' })
    cdp = await connectMain(port)
    res.mounted = await waitMount(cdp)
    if (expectLandOn) {
      const r = await until(cdp, (x) => headHas(x, expectLandOn), 20000)
      Object.assign(res, { landed: r.ok, ms: Date.now() - t0, chatHead: r.chatHead, card: r.card, treeRows: r.treeRows })
    } else {
      const r = await until(cdp, (x) => !!x.card, 20000)
      await sleep(700)
      const after = await read(cdp)
      Object.assign(res, {
        spoke: r.ok,
        ms: r.ms,
        card: r.card,
        cardBody: r.cardBody,
        chatHead: after.chatHead,
        landedOnArg: argPath ? headHas(after, argPath) : false,
        treeRows: after.treeRows
      })
    }
  } catch (e) {
    res.error = String(e.message ?? e).slice(0, 300)
  } finally {
    try { cdp?.close() } catch { /* 닫힘 */ }
    if (c?.pid) killTree(c.pid)
  }
  return res
}

await sleep(1200)
out.cases.D1_coldDenied = await coldRun('home-cold-denied', DENIED, PORT + 1, null)
await sleep(1000)
out.cases.D3_coldFile = await coldRun('home-cold-file', FILE, PORT + 2, null)
await sleep(1000)
out.cases.D3_coldMissing = await coldRun('home-cold-missing', MISSING, PORT + 3, null)
await sleep(1000)
out.cases.coldGood = await coldRun('home-cold-good', PROJ_B, PORT + 4, PROJ_B)

// ── C. D2(a) 부팅 경주 스윕 — 기동 +Nms에 온 폴더가 착지하는가 ───────────────
out.cases.D2_race = []
for (const delay of RACE) {
  const home = makeHome(`home-race-${delay}`)
  let c = null
  let cdp = null
  const row = { delay }
  try {
    c = spawn(EXE, [], { env: { ...process.env, CCG_HOME: home, CCG_CDP_PORT: String(PORT + 10) }, cwd: REPO, stdio: 'ignore' })
    await sleep(delay)
    const s = await spawnSecond(home, [PROJ_A])
    row.second = s
    cdp = await connectMain(PORT + 10)
    row.mounted = await waitMount(cdp)
    const r = await until(cdp, (x) => headHas(x, PROJ_A), 20000)
    await sleep(500)
    const after = await read(cdp)
    Object.assign(row, {
      landed: r.ok,
      ms: r.ms,
      chatHead: after.chatHead,
      card: after.card,
      cardBody: after.cardBody,
      handoffLeft: handoffLeft(home)
    })
    // 잔해가 남았다면 그 뒤의 **인자 없는** 재실행이 납치되는가
    if (row.handoffLeft) {
      const before = await read(cdp)
      const s2 = await spawnSecond(home, [])
      await sleep(3500)
      const a2 = await read(cdp)
      row.afterNoArg = { second: s2, chatHead: a2.chatHead, hijacked: headHas(a2, PROJ_A) && !same(before.chatHead, a2.chatHead) }
    }
  } catch (e) {
    row.error = String(e.message ?? e).slice(0, 300)
  } finally {
    try { cdp?.close() } catch { /* 닫힘 */ }
    if (c?.pid) killTree(c.pid)
  }
  out.cases.D2_race.push(row)
  await sleep(900)
}

// ── 정리 · 저장 ──────────────────────────────────────────────────────────────
undoAcl(DENIED)
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))

const line = (k, v) => console.log(String(k).padEnd(30), String(v).slice(0, 150))
line('exe', out.exe)
line('ACL 실제로 걸림', `listable=${out.aclProbe.listable} statable=${out.aclProbe.statable}`)
line('기준 착지', `${out.cases.baseLanding?.landed} · ${out.cases.baseLanding?.ms}ms`)
line('D1 웜 denied 카드', `${out.cases.D1_warmDenied?.spoke} · ${out.cases.D1_warmDenied?.ms}ms · ${out.cases.D1_warmDenied?.cardBody}`)
line('D1 웜 denied 착지했나', `landed=${out.cases.D1_warmDenied?.landedOnDenied} · head불변=${out.cases.D1_warmDenied?.chatHeadUnchanged} · tree=${out.cases.D1_warmDenied?.tree}`)
line('D1 콜드 denied', `spoke=${out.cases.D1_coldDenied?.spoke} · landed=${out.cases.D1_coldDenied?.landedOnArg} · ${out.cases.D1_coldDenied?.cardBody}`)
line('D3 콜드 파일', `spoke=${out.cases.D3_coldFile?.spoke} · ${out.cases.D3_coldFile?.cardBody}`)
line('D3 콜드 없는경로', `spoke=${out.cases.D3_coldMissing?.spoke} · ${out.cases.D3_coldMissing?.cardBody}`)
line('콜드 정상 폴더', `${out.cases.coldGood?.landed} · ${out.cases.coldGood?.ms}ms`)
line('D4 공백 인자', `spoke=${out.cases.D4_blank?.spoke} · ${out.cases.D4_blank?.cardBody}`)
line('빈 폴더는 열린다', `${out.cases.emptyDirStillOpens?.landed} · rows=${out.cases.emptyDirStillOpens?.treeRows}`)
line('D2 납치(인자 없음)', `hijacked=${out.cases.D2_hijackNoArg?.hijacked} · 인계잔존=${out.cases.D2_hijackNoArg?.handoffStillThere}`)
line('납치 뒤 진짜 열기', `${out.cases.realOpenStillWorks?.landed} · ${out.cases.realOpenStillWorks?.ms}ms`)
line('D5 겹침 끝상태', `B=${out.cases.D5_overlap?.endsOnB}`)
for (const r of out.cases.D2_race) line(`D2 경주 +${r.delay}ms`, `착지=${r.landed} (${r.ms}ms) · 인계잔존=${r.handoffLeft} · 납치=${r.afterNoArg?.hijacked ?? '-'}`)
for (const [k, v] of Object.entries(out.cases.raw ?? {})) line(`raw ${k}`, v)
line('saved', OUT)
