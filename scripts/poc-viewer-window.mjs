#!/usr/bin/env node
/* ============================================================================
 * poc-viewer-window — **파일 뷰어 독립 창**(#viewer)의 동작·자리 기억·비용을 제품 경로로 잰다.
 *
 * 사용자 요구(2026-09-02): "뷰어 상단바를 잡아 옮길 수 있고, 다음 파일을 열 때도 거기
 * 그 자리(듀얼 모니터: 한쪽은 IDE, 한쪽은 코드)". 카드 뷰어는 창 안 오버레이라 창 밖으로
 * 못 나가므로 독립 OS 창으로 만들었다(`src-tauri/src/viewer.rs` 헤더). 이 하네스는
 * **격리 홈 + 가짜 CLI**로 실앱을 띄워 다음을 순서대로 확인한다:
 *
 *   ① 탐색기 파일 클릭 → 카드 뷰어 → 「별도 창으로」 → 뷰어 창이 뜬다 (콜드 지연 ms)
 *      · 창은 파일이 그려진 뒤에 보인다 — 안전망 타이머가 아니라 `viewer:shown` 경로였는가
 *   ② 창을 옮긴다(Win32 SetWindowPos) → 400ms 디바운스 뒤 viewer-window.json에 그 자리가 있는가
 *   ③ Esc로 파일을 닫는다 → 창은 숨김(부수지 않음) → 다른 파일 클릭 → 같은 자리에 다시 뜬다 (웜 지연 ms)
 *   ④ 앱을 껐다 켠다 → 끈적한 모드라 파일 클릭이 곧장 뷰어 창으로 → 저장된 자리에 뜬다
 *   ⑤ 「창 안으로」 → 모드 해제 + 원래 창(메인)의 카드 뷰어로 되돌아온다
 *   ⑥ 비용 — 뷰어 창이 있을 때 / 숨겼을 때 프로세스 트리 메모리 델타(짧은 정착, 참고용)
 *
 *   node scripts/poc-viewer-window.mjs [--exe=…] [--port=11051] [--keep]
 *
 * ── 안전 규칙 (사용자 실앱이 떠 있다) ───────────────────────────────────────
 *  · 이름 기반 kill 금지 — 죽이는 것은 이 스크립트가 spawn한 PID 트리뿐이다.
 *  · 앱 홈은 CCG_HOME으로 격리하고 실 CLI·실계정을 아예 안 쓴다.
 *  · 창 이동은 **이 PID의 창**만 고른다(EnumWindows + pid 대조).
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { cdpTargets, connectMainPage, killTree, sleep, Cdp, REPO, resolveTauriExe, procTreeMem } from '../bench/lib.mjs'

const args = process.argv.slice(2)
const EXE = resolveTauriExe((args.find((a) => a.startsWith('--exe=')) ?? '').split('=')[1])
const FAKECLI = path.join(REPO, 'target', 'release', 'ccg-fakecli.exe')
const PORT = Number((args.find((a) => a.startsWith('--port=')) ?? '').split('=')[1] || 11051)
const KEEP = args.includes('--keep')
const OUT = path.join(REPO, 'docs', 'critic', 'viewer-window-r1.json')
const HOME = path.join(REPO, '.poc-home-viewer-window')
const WORK = path.join(HOME, 'work')

const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true })
function write(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v))
}
const rep = { at: new Date().toISOString(), exe: EXE, steps: {}, checks: [] }
const check = (name, ok, detail) => {
  rep.checks.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`)
}

function seed() {
  rmrf(HOME)
  fs.mkdirSync(WORK, { recursive: true })
  // 작업 폴더 — 탐색기에 뜰 파일 셋(코드·마크다운·텍스트)
  write(path.join(WORK, 'main.ts'), "export function hello(name: string): string {\n  return `hi ${name}`\n}\n" + 'const x = 1\n'.repeat(60))
  write(path.join(WORK, 'README.md'), '# PoC\n\n뷰어 독립 창 하네스용 문서.\n\n- 하나\n- 둘\n')
  write(path.join(WORK, 'notes.txt'), 'plain text\n'.repeat(30))
  if (!fs.existsSync(FAKECLI)) throw new Error(`가짜 CLI가 없다: ${FAKECLI}`)
  const enginedir = path.join(HOME, 'engines', 'fake', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64')
  fs.mkdirSync(enginedir, { recursive: true })
  fs.copyFileSync(FAKECLI, path.join(enginedir, 'claude.exe'))
  write(path.join(HOME, 'config.json'), { activeVersion: 'fake' })
  write(path.join(HOME, 'engine-auto-update.json'), { enabled: false })
  const sdkdir = path.join(HOME, 'engines', 'fake', 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
  fs.mkdirSync(sdkdir, { recursive: true })
  write(path.join(sdkdir, 'package.json'), { name: '@anthropic-ai/claude-agent-sdk', version: 'fake' })
  const PROBE = path.join(REPO, 'target', 'debug', 'ccg-auth-probe.exe')
  if (!fs.existsSync(PROBE)) throw new Error(`프로브가 없다: ${PROBE}\n  cargo build -p ccg-auth --features cli --bin ccg-auth-probe`)
  const pr = spawnSync(PROBE, ['seed', 'a@fake.test'], { env: { ...process.env, CCG_HOME: HOME }, encoding: 'utf8' })
  if (pr.status !== 0) throw new Error(`계정 심기 실패: ${pr.stderr || pr.stdout}`)
  fs.mkdirSync(path.join(HOME, 'accounts', 'a_fake.test'), { recursive: true })
  write(path.join(HOME, 'chats', 'index.json'), { version: 1, order: ['c-a'], activeChatId: 'c-a' })
  write(path.join(HOME, 'chats', 'c-a.json'), {
    id: 'c-a', title: '뷰어', custom: true, manualCwd: WORK,
    picker: { model: 'haiku', effort: 'minimal', mode: 'normal', account: 'a@fake.test' },
    refDirs: [], snapshot: { messages: [] }, updatedAt: 1700000000000
  })
  // 패치노트 카드(버전 다르면 매번 뜬다)·사이드바 자동숨김을 끄고, 왼쪽 칼럼을 탐색기로 전환해 둔다
  write(path.join(HOME, 'ui-prefs.json'), { 'ui.lang': 'ko', 'whatsnew.seenVersion': '3.0.0-beta.1', 'sidebar.autohide': false, 'explorer.swap': true })
  write(path.join(HOME, 'profile.json'), { nickname: 'poc' })
}

/** 이 PID의 보이는 창 중 메인(AgentCodeGUI3)이 아닌 큰 창을 찾아 옮긴다(물리 픽셀). */
function moveViewerWindow(pid, x, y, w, h) {
  const ps = String.raw`
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class VW {
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  static uint P; static IntPtr Found;
  static bool Cb(IntPtr h, IntPtr l) {
    uint p; GetWindowThreadProcessId(h, out p);
    if (p != P || !IsWindowVisible(h)) return true;
    var sb = new StringBuilder(256); GetWindowTextW(h, sb, 256); var t = sb.ToString();
    RECT r; GetWindowRect(h, out r);
    if (t == "AgentCodeGUI3" || t.Length == 0 || (r.Right - r.Left) < 300) return true;
    Found = h; return false;
  }
  public static string Move(uint pid, int x, int y, int w, int h) {
    P = pid; Found = IntPtr.Zero; EnumWindows(Cb, IntPtr.Zero);
    if (Found == IntPtr.Zero) return "notfound";
    SetWindowPos(Found, IntPtr.Zero, x, y, w, h, 0x0004 | 0x0010);
    var sb = new StringBuilder(256); GetWindowTextW(Found, sb, 256);
    return "ok:" + sb.ToString();
  }
}
"@
[VW]::Move(${pid}, ${x}, ${y}, ${w}, ${h})
`
  return execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 30000 }).trim()
}

/** 프로세스 트리 메모리 — 언어 서버(node.exe)는 따로 센다: 코드 파일을 열면 LSP가 뜨는데
 *  그건 카드 뷰어도 똑같이 치르는 값이라 "창 하나의 비용"이 아니다. app* = node.exe 제외. */
function memSample(pid) {
  const m = procTreeMem(pid, { role: true })
  const sum = (rows, k) => +rows.reduce((a, p) => a + (p[k] || 0), 0).toFixed(1)
  const lsp = m.procs.filter((p) => /node\.exe/i.test(p.name))
  return {
    ws: m.totalWsMB, priv: m.totalPrivMB,
    lspWs: sum(lsp, 'wsMB'), lspPriv: sum(lsp, 'privMB'),
    appWs: +(m.totalWsMB - sum(lsp, 'wsMB')).toFixed(1), appPriv: +(m.totalPrivMB - sum(lsp, 'privMB')).toFixed(1),
    procs: m.procs.map((p) => ({ name: p.name, role: p.role, sub: p.sub, ws: p.wsMB, priv: p.privMB }))
  }
}
const memDelta = (a, b) => ({ ...b, dAppWs: +(b.appWs - a.appWs).toFixed(1), dAppPriv: +(b.appPriv - a.appPriv).toFixed(1), dLspWs: +(b.lspWs - a.lspWs).toFixed(1) })

const launch = () => {
  const child = spawn(EXE, [], {
    env: { ...process.env, CCG_HOME: HOME, CCG_NO_NET: '1', CCG_CDP_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.log = ''
  child.stdout.on('data', (d) => (child.log += d.toString()))
  child.stderr.on('data', (d) => (child.log += d.toString()))
  return child
}

async function session(child, tag) {
  const cdp = await connectMainPage(PORT, { timeoutMs: 60_000 })
  const ev = async (expr) => JSON.parse(await cdp.eval(`(async () => JSON.stringify(${expr}))()`, { awaitPromise: true }))
  const dbg = () => ev(`await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: 'viewer:debug', payload: [] })`)
  const waitFor = async (fn, ms = 8000, step = 40) => {
    const t0 = Date.now()
    for (;;) {
      const v = await fn().catch(() => null)
      if (v) return v
      if (Date.now() - t0 > ms) throw new Error(`waitFor timeout (${tag})`)
      await sleep(step)
    }
  }
  const clickFile = (name) =>
    ev(`(() => { const b = [...document.querySelectorAll('.fxr')].find((e) => e.textContent.trim().endsWith(${JSON.stringify(name)})); if (!b) return false; b.click(); return true })()`)
  const shot = async (c, name) => {
    try {
      const r = await c.send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(path.join(REPO, `.poc-viewer-${name}.png`), Buffer.from(r.data, 'base64'))
    } catch { /* 참고용 */ }
  }
  const viewerPage = async () => {
    const t0 = Date.now()
    while (Date.now() - t0 < 20_000) {
      const ts = await cdpTargets(PORT).catch(() => [])
      const tg = ts.find((t) => t.type === 'page' && t.url.includes('#viewer'))
      if (tg?.webSocketDebuggerUrl) return await Cdp.connect(tg.webSocketDebuggerUrl, { timeoutMs: 8000 })
      await sleep(100)
    }
    throw new Error('viewer page target not found')
  }
  // 앱이 뜨고 탐색기가 그려질 때까지
  for (let i = 0; i < 300; i++) {
    const up = await cdp.eval(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`, { awaitPromise: true }).catch(() => false)
    if (up) break
    await sleep(100)
  }
  try {
    await waitFor(() => ev(`document.querySelectorAll('.fxr').length`), 30_000)
  } catch (e) {
    // 어디까지 갔는지 남긴다 — 보드(멀티)로 떴는지, 탐색기가 접혔는지, 게이트에 막혔는지
    rep.diag = await ev(`({ url: location.href, multi: document.querySelectorAll('.multi').length, grid: document.querySelector('.ma-grid')?.className ?? null, lcol: document.querySelector('.lcol')?.className ?? null, explorer: document.querySelectorAll('.explorer, .fx, .fx-tree').length, gates: [...document.querySelectorAll('.gate, .engine-gate, .set-dialog, .pn-card, .welcome')].map((e) => e.className).slice(0, 6), bodyText: document.body.innerText.slice(0, 400) })`).catch((err) => ({ err: String(err) }))
    await shot(cdp, 'diag')
    throw e
  }
  return { cdp, ev, dbg, waitFor, clickFile, shot, viewerPage }
}

async function main() {
  seed()
  let child = launch()
  let vp = null
  try {
    // ── 1회차 ──────────────────────────────────────────────────────────────
    let s = await session(child, 'run1')
    await sleep(1500)
    const memBase = memSample(child.pid)
    rep.steps.memBaseMB = memBase

    // ① 파일 클릭 → 카드 → 별도 창으로
    // 비교 기준은 **카드 뷰어**다: 같은 파일을 카드로 열었을 때(CodeMirror 청크·LSP까지 같은 값을
    // 치른다)와, 카드를 닫은 뒤(청크는 남는다)를 각각 재 둔다 — 창의 값은 그 둘과의 차이다.
    check('탐색기 파일 클릭', await s.clickFile('main.ts'))
    await s.waitFor(() => s.ev(`document.querySelectorAll('.fv-modal .cm-host, .fv-modal .fv-code').length`))
    await sleep(1500)
    const memCard = memSample(child.pid)
    rep.steps.memCardOpenMB = memDelta(memBase, memCard)
    await s.ev(`(() => { document.querySelector('.fv-modal .dclose[aria-label="닫기"]')?.click(); return true })()`)
    await s.waitFor(async () => ((await s.ev(`document.querySelectorAll('.fv-modal').length`)) === 0 ? true : null))
    await sleep(1500)
    const memCardClosed = memSample(child.pid)
    rep.steps.memCardClosedMB = memDelta(memBase, memCardClosed)
    check('탐색기 파일 다시 클릭', await s.clickFile('main.ts'))
    await s.waitFor(() => s.ev(`document.querySelectorAll('.fv-modal:not(.fv-winmodal) .fv-popout').length`))
    const d0 = await s.dbg()
    check('처음엔 카드 모드(창 없음)', d0.exists === false && d0.mode === false, d0)
    const tPop = Date.now()
    await s.ev(`(() => { const b = document.querySelector('.fv-popout'); if (!b) return false; b.click(); return true })()`)
    const dShown = await s.waitFor(async () => { const d = await s.dbg(); return d.exists && d.win?.visible ? d : null }, 20_000, 15)
    const coldMs = Date.now() - tPop
    rep.steps.coldPopoutMs = coldMs
    check('뷰어 창이 떴다(콜드)', dShown.win.visible, { coldMs, fallbackShows: dShown.fallbackShows })
    check('안전망이 아니라 렌더러 신호로 보였다', dShown.fallbackShows === 0, dShown.fallbackShows)
    check('메인의 카드 뷰어는 내려갔다', (await s.ev(`document.querySelectorAll('.fv-modal').length`)) === 0)
    check('끈적한 모드 ON', dShown.mode === true)
    vp = await s.viewerPage()
    const pev = async (expr) => JSON.parse(await vp.eval(`(async () => JSON.stringify(${expr}))()`, { awaitPromise: true }))
    await s.waitFor(() => pev(`document.querySelectorAll('.fv-win .fv-modal .cm-host, .fv-win .fv-modal .fv-code').length`), 10_000)
    const vinfo = await pev(`({ title: document.title, name: document.querySelector('.fv-name')?.textContent, hasDock: !!document.querySelector('.fv-dock'), hasWinCtl: document.querySelectorAll('.fv-winctl button').length, dpr: devicePixelRatio, drag: getComputedStyle(document.querySelector('.fv-win .diff-head')).getPropertyValue('-webkit-app-region') || window.__ccgChrome?.mode })`)
    check('뷰어 창 헤더 = 파일명 + 창 컨트롤 넷', vinfo.name === 'main.ts' && vinfo.hasDock && vinfo.hasWinCtl === 4, vinfo)
    await s.shot(vp, 'window')
    await sleep(1500)
    rep.steps.memWithViewerMB = memDelta(memCard, memSample(child.pid)) // 기준 = 같은 파일을 카드로 열었을 때

    // ② 옮긴다 → 자리 저장
    const dpr = vinfo.dpr || 1
    const target = { x: Math.round(dShown.win.x) + 137, y: Math.round(dShown.win.y) + 91 }
    const mv = moveViewerWindow(child.pid, Math.round(target.x * dpr), Math.round(target.y * dpr), Math.round(dShown.win.width * dpr), Math.round(dShown.win.height * dpr))
    check('창을 옮겼다(Win32)', mv.startsWith('ok'), mv)
    await sleep(900) // 저장 디바운스 400ms + 여유
    const dMoved = await s.dbg()
    const onDisk = JSON.parse(fs.readFileSync(path.join(HOME, 'viewer-window.json'), 'utf8'))
    rep.steps.moved = { target, win: dMoved.win, saved: dMoved.saved, onDisk }
    const near = (a, b) => Math.abs(a - b) <= 2
    check('옮긴 자리가 창에 반영', near(dMoved.win.x, target.x) && near(dMoved.win.y, target.y), { win: dMoved.win, target })
    check('옮긴 자리가 viewer-window.json에 저장', near(onDisk.x, target.x) && near(onDisk.y, target.y) && onDisk.window === true, onDisk)

    // ③ Esc → 숨김 → 다른 파일 → 같은 자리(웜)
    await vp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await vp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    const dHid = await s.waitFor(async () => { const d = await s.dbg(); return d.exists && d.win && !d.win.visible ? d : null }, 8000, 20)
    check('Esc = 창 숨김(부수지 않음)', dHid.exists && !dHid.win.visible && dHid.bootPath === null, dHid)
    await sleep(1500)
    rep.steps.memHiddenViewerMB = memDelta(memCardClosed, memSample(child.pid)) // 기준 = 카드를 닫은 뒤
    const tWarm = Date.now()
    check('다른 파일 클릭', await s.clickFile('README.md'))
    const dWarm = await s.waitFor(async () => { const d = await s.dbg(); return d.win?.visible ? d : null }, 10_000, 10)
    const warmMs = Date.now() - tWarm
    rep.steps.warmReopenMs = warmMs
    check('숨긴 창이 같은 자리에 다시 떴다(웜)', near(dWarm.win.x, target.x) && near(dWarm.win.y, target.y) && dWarm.fallbackShows === 0, { warmMs, win: dWarm.win, fallbackShows: dWarm.fallbackShows })
    check('메인에는 카드가 안 떴다(창 모드 라우팅)', (await s.ev(`document.querySelectorAll('.fv-modal').length`)) === 0)
    await s.waitFor(() => pev(`document.querySelector('.fv-name')?.textContent === 'README.md'`), 8000)
    check('뷰어 창 내용이 새 파일로 바뀌었다', true)
    await s.shot(vp, 'warm')
    vp.close()
    vp = null

    // ── ④ 재시작 → 저장된 자리 ───────────────────────────────────────────
    s.cdp.close()
    killTree(child.pid)
    await sleep(1200)
    child = launch()
    s = await session(child, 'run2')
    const dBoot = await s.dbg()
    check('재시작 뒤에도 끈적한 모드 + 저장된 자리', dBoot.mode === true && near(dBoot.saved.x, target.x) && near(dBoot.saved.y, target.y), dBoot)
    const tRe = Date.now()
    check('재시작 뒤 파일 클릭', await s.clickFile('notes.txt'))
    const dRe = await s.waitFor(async () => { const d = await s.dbg(); return d.win?.visible ? d : null }, 20_000, 15)
    rep.steps.restartColdMs = Date.now() - tRe
    check('재시작 뒤 첫 클릭이 곧장 뷰어 창으로, 저장된 자리에', near(dRe.win.x, target.x) && near(dRe.win.y, target.y) && dRe.fallbackShows === 0, { ms: rep.steps.restartColdMs, win: dRe.win })
    check('메인에는 카드가 안 떴다', (await s.ev(`document.querySelectorAll('.fv-modal').length`)) === 0)

    // ── ⑤ 창 안으로 ─────────────────────────────────────────────────────
    vp = await s.viewerPage()
    const pev2 = async (expr) => JSON.parse(await vp.eval(`(async () => JSON.stringify(${expr}))()`, { awaitPromise: true }))
    await s.waitFor(() => pev2(`document.querySelectorAll('.fv-dock').length`), 8000)
    await pev2(`(() => { document.querySelector('.fv-dock').click(); return true })()`)
    const dDock = await s.waitFor(async () => { const d = await s.dbg(); return d.mode === false && d.win && !d.win.visible ? d : null }, 8000, 20)
    check('창 안으로: 모드 OFF + 창 숨김', dDock.mode === false && !dDock.win.visible, dDock)
    await s.waitFor(() => s.ev(`document.querySelectorAll('.fv-modal:not(.fv-winmodal)').length`), 8000)
    const backName = await s.ev(`document.querySelector('.fv-modal .fv-name')?.textContent`)
    check('원래 창(메인)의 카드 뷰어로 되돌아왔다', backName === 'notes.txt', backName)
    await sleep(500) // 카드 등장 애니(rise .22s)가 끝난 뒤에 찍는다 — 반쯤 비친 프레임은 판독 불가
    await s.shot(s.cdp, 'docked')
    const onDisk2 = JSON.parse(fs.readFileSync(path.join(HOME, 'viewer-window.json'), 'utf8'))
    check('viewer-window.json: window=false, 자리는 유지', onDisk2.window === false && near(onDisk2.x, target.x), onDisk2)
    // 카드에서 파일 클릭 → 카드 그대로(모드 OFF)
    await s.ev(`(() => { document.querySelector('.fv-modal .dclose[aria-label="닫기"]')?.click(); return true })()`)
    await sleep(300)
    await s.clickFile('main.ts')
    await sleep(600)
    const dCard = await s.dbg()
    check('모드 OFF면 다시 카드로 열린다', (await s.ev(`document.querySelectorAll('.fv-modal:not(.fv-winmodal)').length`)) === 1 && !dCard.win.visible, dCard)

    // ── ⑦ 마우스 제스처 →↑(RU) = 별도 창으로 (사용자 결정 2026-09-02) ─────────
    // 우버튼 드래그를 합성한다: down은 카드(캡처), move/up은 window. buttons&2가 필수이고
    // 획은 기본 stroke 24px보다 넉넉히(140px). 동기 연속 디스패치로 인식된다(패턴 판정이 동기).
    const tGesture = Date.now()
    const drew = await s.ev(`(() => {
      const card = document.querySelector('.fv-modal'); if (!card) return false
      const r = card.getBoundingClientRect(); let x = r.left + r.width / 2, y = r.top + r.height / 2
      const ev = (type, tgt, extra) => tgt.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y, ...extra }))
      ev('pointerdown', card, { button: 2, buttons: 2 })
      for (let i = 0; i < 14; i++) { x += 10; ev('pointermove', window, { button: -1, buttons: 2 }) }
      for (let i = 0; i < 14; i++) { y -= 10; ev('pointermove', window, { button: -1, buttons: 2 }) }
      ev('pointerup', window, { button: 2, buttons: 0 })
      return true
    })()`)
    check('RU 제스처를 합성했다', drew)
    const dGest = await s.waitFor(async () => { const d = await s.dbg(); return d.mode && d.win?.visible ? d : null }, 20_000, 15)
    rep.steps.gesturePopoutMs = Date.now() - tGesture
    check('카드에서 →↑ 제스처 = 별도 창으로(모드 ON + 창 표시)', dGest.mode === true && dGest.win.visible && dGest.bootPath === 'main.ts', { ms: rep.steps.gesturePopoutMs, bootPath: dGest.bootPath })
    check('제스처 뒤 메인의 카드는 내려갔다', (await s.ev(`document.querySelectorAll('.fv-modal').length`)) === 0)
    s.cdp.close()
  } catch (e) {
    rep.error = String(e?.stack || e)
    rep.cliLog = (child.log || '').slice(-2000)
    console.error('FAIL', e)
  } finally {
    try { vp?.close() } catch { /* closed */ }
    if (!KEEP) {
      killTree(child.pid)
      await sleep(800)
      rmrf(HOME)
    }
  }
  rep.pass = rep.checks.every((c) => c.ok) && !rep.error
  write(OUT, JSON.stringify(rep, null, 2))
  console.log(JSON.stringify(rep.steps, null, 2))
  console.log(rep.pass ? 'ALL PASS' : 'SOME FAIL', '→', OUT)
  process.exit(rep.pass ? 0 : 1)
}

main()
