// M6 크리틱 — 살아 있는 두 앱에 같은 질문. node bench/critic-live.mjs both
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import { electronProfile, tauriProfile, connectMainPage, killTree, sleep, REPO } from './lib.mjs'
import { makeFixtureHome, FIX_ID } from './fixture.mjs'

const which = process.argv[2] ?? 'both'
const KINDS = which === 'both' ? ['electron', 'tauri'] : [which]
const WORK = path.join(os.tmpdir(), 'ccg-m6c-work')
const EXE = path.join(os.tmpdir(), 'ccg-m6-exe', 'agentcodegui.exe')

const g = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function makeWork() {
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.mkdirSync(WORK, { recursive: true })
  execFileSync('git', ['-C', WORK, 'init', '-q', '-b', 'main'])
  g(WORK, ['config', 'user.name', 'Critic'])
  g(WORK, ['config', 'user.email', 'critic@example.com'])
  // ① 35MB blob (32MB stdout 캡 자리)
  fs.writeFileSync(path.join(WORK, 'huge.txt'), '0123456789ABCDEF0123456789ABCDEF0123456789ABCDEFxx\n'.repeat(700_000))
  fs.writeFileSync(path.join(WORK, 'normal.txt'), 'a\nb\nc\n')
  fs.writeFileSync(path.join(WORK, 'pic.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))
  fs.writeFileSync(path.join(WORK, 'secret.json'), '{"token":"CRITIC-SECRET-42"}')
  g(WORK, ['add', '-A'])
  g(WORK, ['commit', '-qm', 'base'])
  // 사용자가 35MB 파일을 한 줄로 줄였다
  fs.writeFileSync(path.join(WORK, 'huge.txt'), '남은 한 줄\n')
  // ② 미추적 폴더(=Git 카드에 한 행으로 뜨는 통째 삭제 대상)
  fs.mkdirSync(path.join(WORK, 'newdir', 'nested'), { recursive: true })
  fs.writeFileSync(path.join(WORK, 'newdir', 'a.txt'), 'a')
  fs.writeFileSync(path.join(WORK, 'newdir', 'nested', 'b.txt'), 'b')
  // ③ 원격은 있지만 도달 불가 — fetch가 초 단위로 막히는 상태(블로킹 격리 시험)
  g(WORK, ['remote', 'add', 'origin', 'https://10.255.255.1/nope.git'])
}

function makeHome(kind, version) {
  const home = path.join(os.tmpdir(), `ccg-m6c-home-${kind}`)
  fs.rmSync(home, { recursive: true, force: true })
  makeFixtureHome(home, version)
  const f = path.join(home, 'chats', `${FIX_ID}.json`)
  const chat = JSON.parse(fs.readFileSync(f, 'utf8'))
  chat.manualCwd = WORK
  if (chat.snapshot) chat.snapshot.cwd = WORK
  fs.writeFileSync(f, JSON.stringify(chat))
  return home
}

const ps = (cmd) => {
  try { return execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim() }
  catch (e) { return 'PSERR:' + String(e.message).slice(0, 120) }
}

// 창의 메시지 펌프가 살아 있나 — SendMessageTimeout(WM_NULL, 2s)
const HANGPROBE = (pid) => ps(`
$sig = @'
using System; using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h,uint m,IntPtr w,IntPtr l,uint f,uint t,out IntPtr r);
  [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr h);
}
'@
Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue
$hs = @(Get-Process -Id ${pid} -ErrorAction SilentlyContinue | ForEach-Object { $_.MainWindowHandle } | Where-Object { $_ -ne 0 })
if ($hs.Count -eq 0) { 'NOWIN' } else {
  $h = $hs[0]; $r = [IntPtr]::Zero
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $ok = [W]::SendMessageTimeout($h, 0, [IntPtr]::Zero, [IntPtr]::Zero, 0, 2000, [ref]$r)
  $sw.Stop()
  "{0}|{1}|{2}" -f ($ok -ne [IntPtr]::Zero), $sw.ElapsedMilliseconds, [W]::IsHungAppWindow($h)
}`)

async function run(kind) {
  const version = kind === 'tauri' ? '3.0.0-beta.1' : '2.6.2'
  const profile = kind === 'tauri' ? tauriProfile({ port: 9366, exe: EXE }) : electronProfile({ port: 9365 })
  const home = makeHome(kind, version)
  const child = spawn(profile.cmd, profile.args, { env: { ...process.env, ...profile.env, CCG_HOME: home }, cwd: profile.cwd, stdio: 'ignore' })
  const R = { app: kind }
  let cdp
  try {
    cdp = await connectMainPage(profile.port, { timeoutMs: 60000 })
    await cdp.send('Runtime.enable')
    for (let i = 0; i < 600; i++) {
      if (await cdp.eval(profile.mountExpr).catch(() => false)) break
      await sleep(100)
    }
    await sleep(1500)
    const W = JSON.stringify(WORK)
    const imgUrl = (abs) => kind === 'tauri'
      ? `http://ccg-img.localhost/${encodeURIComponent(abs)}`
      : `ccg-img://local/?p=${encodeURIComponent(abs)}`

    // ── A. 32MB stdout 캡 — 거대 HEAD blob에서 diff가 무슨 말을 하나 ──────────
    R.bigBlobDiff = await cdp.eval(
      `(async () => { const d = await window.api.git.fileDiff(${W}, 'huge.txt')
         return { error: d.error ?? null, tag: d.diff?.tag ?? null, add: d.diff?.add ?? null, del: d.diff?.del ?? null,
                  lines: d.diff?.lines?.length ?? null } })()`,
      { awaitPromise: true, timeoutMs: 90000 })

    // ── B. ccg-img: 렌더러 JS가 임의 이미지 바이트를 fetch로 읽을 수 있나(CORS) ─
    R.imgFetch = await cdp.eval(
      `(async () => {
         const url = ${JSON.stringify(imgUrl(path.join(WORK, 'pic.png')))}
         const o = { origin: location.origin }
         try { const r = await fetch(url); o.status = r.status; o.bytes = (await r.arrayBuffer()).byteLength
               o.acao = r.headers.get('access-control-allow-origin') }
         catch (e) { o.fetchThrew = String(e).slice(0, 120) }
         // <img>로는 되나 (CORS와 무관한 경로)
         o.imgTag = await new Promise((res) => { const i = new Image()
           i.onload = () => res(true); i.onerror = () => res(false); i.src = url; setTimeout(() => res('timeout'), 6000) })
         return o })()`,
      { awaitPromise: true, timeoutMs: 20000 })

    // ── C. 비이미지 파일은 정말 안 나가나 + 확장자만 png인 비밀 ────────────────
    fs.copyFileSync(path.join(WORK, 'secret.json'), path.join(WORK, 'secret.json.png'))
    R.imgNonImage = await cdp.eval(
      `(async () => {
         const probe = async (u) => { try { const r = await fetch(u); return { s: r.status, t: (await r.text()).slice(0, 40) } }
                                      catch (e) { return { threw: String(e).slice(0, 60) } } }
         return { json: await probe(${JSON.stringify(imgUrl(path.join(WORK, 'secret.json')))}),
                  jsonNamedPng: await probe(${JSON.stringify(imgUrl(path.join(WORK, 'secret.json.png')))}) } })()`,
      { awaitPromise: true, timeoutMs: 20000 })

    // ── D. UI 스레드 — 도달 불가 UNC 이미지를 요청하는 동안 창이 응답하나 ──────
    R.hangBefore = HANGPROBE(child.pid)
    await cdp.eval(
      `(() => { const u = ${JSON.stringify(imgUrl('\\\\10.255.255.1\\share\\a.png'))}
                const i = new Image(); i.src = u; window.__ccgProbe = i; return true })()`)
    await sleep(1200)
    R.hangDuring = HANGPROBE(child.pid)
    await sleep(1200)
    R.hangDuring2 = HANGPROBE(child.pid)

    // ── E. 블로킹 격리 — 도달 불가 원격에 fetch를 걸어둔 채 다른 채널이 사나 ──
    R.starvation = await cdp.eval(
      `(async () => {
         const t0 = performance.now()
         const slow = window.api.git.fetch(${W})
         const lat = []
         for (let i = 0; i < 8; i++) {
           const a = performance.now()
           await window.api.listDir(${W}, '')
           lat.push(Math.round(performance.now() - a))
           await new Promise((r) => setTimeout(r, 250))
         }
         return { latencies: lat, max: Math.max(...lat), slowStillPending: await Promise.race([slow.then(() => false), new Promise((r) => setTimeout(() => r(true), 10))]) }
       })()`,
      { awaitPromise: true, timeoutMs: 60000 })

    // ── F. fs:create 실패 — 인라인 오류인가(네이티브 다이얼로그 금지 규약) ────
    R.createFail = await cdp.eval(
      `(async () => {
         const a = await window.api.createPath(${W}, 'normal.txt', false)   // 이미 있음
         const b = await window.api.createPath(${W}, 'newdir/nested', true) // 이미 있음
         const c = await window.api.writeFile('', 'Z:/nope/nope.txt', 'x')  // 없는 드라이브
         const d = await window.api.renamePath(${W}, 'normal.txt', 'a/b.txt')
         return { dupFile: a, dupDir: b, badDrive: c, badName: d } })()`,
      { awaitPromise: true, timeoutMs: 20000 })
    R.topLevelWindows = ps(`(Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue).MainWindowTitle`)

    // ── G. 미추적 폴더가 Git 변경 목록에 한 행으로 뜨나(되돌리기 반경) ────────
    R.gitRows = await cdp.eval(
      `(async () => { const s = await window.api.git.status(${W})
         return s.files.map((f) => f.status + ':' + f.path + (f.untracked ? '(u)' : '')) })()`,
      { awaitPromise: true, timeoutMs: 20000 })

    // ── H. 커밋 한글 + 이모지 왕복 ────────────────────────────────────────────
    R.commitKo = await cdp.eval(
      `window.api.git.commit(${W}, ['normal.txt'], '한글 커밋 제목 🎉 — 대시', '본문 첫 줄\\n본문 둘째 줄')`,
      { awaitPromise: true, timeoutMs: 30000 })
    R.commitOnDisk = { subject: g(WORK, ['log', '-1', '--pretty=%s']).trim(), body: g(WORK, ['log', '-1', '--pretty=%b']).trim() }

    // ── I. shell:reveal-path — 탐색기 창이 그 폴더로, 선택된 채 뜨나 ──────────
    const before = ps(`@((New-Object -ComObject Shell.Application).Windows() | ForEach-Object { $_.LocationURL }) -join "|"`)
    await cdp.eval(`window.api.revealPath(${W}, 'normal.txt')`, { awaitPromise: true, timeoutMs: 10000 }).catch(() => {})
    await sleep(2500)
    const after = ps(`@((New-Object -ComObject Shell.Application).Windows() | ForEach-Object { $_.LocationURL }) -join "|"`)
    R.reveal = { before, after, opened: after.length > before.length }
    // 내가 연 창만 닫는다 (explorer.exe는 절대 kill 하지 않는다)
    ps(`(New-Object -ComObject Shell.Application).Windows() | Where-Object { $_.LocationURL -like '*ccg-m6c-work*' } | ForEach-Object { $_.Quit() }`)
  } catch (e) {
    R.error = String(e?.message ?? e)
  } finally {
    try { cdp?.close() } catch { /* */ }
    killTree(child.pid)
    await sleep(800)
  }
  return R
}

makeWork()
const all = []
for (const k of KINDS) {
  console.log(`\n=== ${k} ===`)
  const r = await run(k)
  all.push(r)
  console.log(JSON.stringify(r, null, 1))
  // 다음 앱을 위해 상태 원복(커밋이 이력을 바꾼다)
  makeWork()
}
fs.writeFileSync(path.join(os.tmpdir(), 'ccg-m6c-live.json'), JSON.stringify(all, null, 2))
console.log('\n→ ' + path.join(os.tmpdir(), 'ccg-m6c-live.json'))
