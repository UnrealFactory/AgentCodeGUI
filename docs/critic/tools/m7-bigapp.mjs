// ── M7 크리틱 공격 — 큰 무대 + 파일 수천 개 연속 열기 ─────────────────────────
//
// 보고서의 무대는 이 레포 클론 + 3,369줄 픽스처 하나였다. 사용자의 실제 무대는 그보다 크다.
// 여기서는 합성 대형 프로젝트(docs/critic/tools/m7-genbig.mjs: src 3,000 .ts 사슬 + node_modules
// 15,000 파일)를 열고
//   ① 프리웜 → ready · 첫 색칠 · 그동안의 rAF 프레임
//   ② 파일 N개를 **연속으로** 열며(status → cachedTokens → semanticTokens) 매 파일 지연과
//      그 구간의 프레임을 함께 잰다 — 문서 상한(32) 축출이 도는 구간이다
//   ③ 유휴 3초 대조군 · 언어 서버 프로세스 수
//
//   node m7-bigapp.mjs --kind tauri|electron [--files 600] [--dir ...] [--out f.json]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import { resolveTauriExe } from '../../../bench/lib.mjs'
import { connectMainPage, killTree, sleep, electronProfile, tauriProfile, envInfo } from '../../../bench/lib.mjs'
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
const PORT = Number(flag('port', KIND === 'tauri' ? 9421 : 9422))
const DIR = flag('dir', path.join(os.tmpdir(), 'ccg-m7c-big'))
const NFILES = Number(flag('files', '600'))
const HERO = flag('hero', 'src/m019/u02999.ts')

// 열 파일 목록(결정적) — src/ 전체에서 균등 추출
function pickFiles(root, n) {
  const all = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(p) }
      else if (e.name.endsWith('.ts')) all.push(path.relative(root, p).replace(/\\/g, '/'))
    }
  }
  walk(path.join(root, 'src'))
  all.sort()
  const step = Math.max(1, Math.floor(all.length / n))
  const out = []
  for (let i = 0; i < all.length && out.length < n; i += step) out.push(all[i])
  return out
}

function serverProcs(rootPid) {
  const ps = `$ErrorActionPreference='SilentlyContinue'
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine
$want = New-Object System.Collections.Generic.HashSet[int]
[void]$want.Add(${rootPid})
for ($i=0; $i -lt 6; $i++) { foreach ($p in $all) { if ($want.Contains([int]$p.ParentProcessId)) { [void]$want.Add([int]$p.ProcessId) } } }
$out = foreach ($p in $all) { if ($want.Contains([int]$p.ProcessId)) { [pscustomobject]@{ pid=$p.ProcessId; name=$p.Name; cmd=($p.CommandLine -replace '"','') } } }
$out | ConvertTo-Json -Compress -Depth 3`
  try {
    const raw = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 << 20
    }).trim()
    if (!raw) return []
    const arr = JSON.parse(raw)
    const list = Array.isArray(arr) ? arr : [arr]
    return list.filter((p) => /typescript-language-server|tsserver/i.test(p.cmd || '')).map((p) => ({ pid: p.pid, name: p.name }))
  } catch { return [] }
}

const PROBE = `(() => {
  if (window.__m7g) return 'already'
  const G = (window.__m7g = { frames: [], on: false })
  G.api = () => (window.api && window.api.lsp) || null
  G.fpsStart = () => { G.frames = []; G.on = true
    const t = (x) => { if (!G.on) return; G.frames.push(x); requestAnimationFrame(t) }; requestAnimationFrame(t); return true }
  G.fpsStop = () => {
    G.on = false
    const f = G.frames
    if (f.length < 3) return { frames: f.length, fps: null }
    const gaps = []; for (let i = 1; i < f.length; i++) gaps.push(f[i] - f[i-1])
    const s = gaps.slice().sort((a,b)=>a-b); const span = f[f.length-1]-f[0]
    return { frames: f.length, spanMs: Math.round(span), fps: Math.round((f.length-1)/(span/1000)*10)/10,
             medGapMs: Math.round(s[Math.floor(s.length/2)]*100)/100,
             p95GapMs: Math.round(s[Math.floor(s.length*0.95)]*100)/100,
             maxGapMs: Math.round(s[s.length-1]*100)/100, longFrames: gaps.filter(g=>g>33).length }
  }
  G.waitReady = async (cwd, rel, budget) => {
    const t0 = performance.now()
    for (;;) {
      const a = G.api()
      if (a) { const st = await a.status(cwd, rel).catch(()=>'err'); if (st === 'ready') return { ms: Math.round(performance.now()-t0), st } }
      if (performance.now()-t0 > budget) return { ms: null, st: 'timeout' }
      await new Promise(r=>setTimeout(r,120))
    }
  }
  G.firstPaint = async (cwd, rel, budget) => {
    const t0 = performance.now()
    for (;;) {
      const t = await G.api().semanticTokens(cwd, rel).catch(()=>null)
      if (t && t.data && t.data.length) return { ms: Math.round(performance.now()-t0), n: t.data.length/5 }
      if (performance.now()-t0 > budget) return { ms: null, n: 0, timeout: true }
      await new Promise(r=>setTimeout(r,250))
    }
  }
  // 파일 N개 연속 열기 — 뷰어가 파일을 열 때 실제로 부르는 3종을 그 순서로
  G.sweep = async (cwd, rels) => {
    const a = G.api()
    const rows = []
    for (const rel of rels) {
      const t0 = performance.now()
      const st = await a.status(cwd, rel).catch(()=>'err')
      const t1 = performance.now()
      const c = await a.cachedTokens(cwd, rel).catch(()=>null)
      const t2 = performance.now()
      const s = await a.semanticTokens(cwd, rel).catch(()=>null)
      const t3 = performance.now()
      rows.push({ rel, st,
        statusMs: Math.round((t1-t0)*100)/100, cacheMs: Math.round((t2-t1)*100)/100,
        semMs: Math.round((t3-t2)*100)/100, n: s && s.data ? s.data.length/5 : 0,
        cached: !!(c && c.data && c.data.length) })
      await new Promise(r=>setTimeout(r,0))
    }
    return rows
  }
  return 'armed'
})()`

function makeHome(kind, version) {
  const home = path.join(os.tmpdir(), `ccg-m7c-big-${kind}`)
  fs.rmSync(home, { recursive: true, force: true })
  makeFixtureHome(home, version)
  const f = path.join(home, 'chats', `${FIX_ID}.json`)
  const chat = JSON.parse(fs.readFileSync(f, 'utf8'))
  chat.manualCwd = DIR
  if (chat.snapshot) chat.snapshot.cwd = DIR
  fs.writeFileSync(f, JSON.stringify(chat))
  return home
}

const files = pickFiles(DIR, NFILES)
const version = KIND === 'tauri' ? '3.0.0-beta.1' : '2.6.2'
const home = makeHome(KIND, version)
const profile = KIND === 'tauri' ? tauriProfile({ port: PORT, exe: EXE }) : electronProfile({ port: PORT })
const child = spawn(profile.cmd, profile.args, { env: { ...process.env, ...profile.env, CCG_HOME: home }, cwd: profile.cwd, stdio: 'ignore' })
const out = { kind: KIND, version, dir: DIR, hero: HERO, files: files.length, at: new Date().toISOString(), env: envInfo() }
const S = (v) => JSON.stringify(v)
try {
  const cdp = await connectMainPage(PORT, { timeoutMs: 90000 })
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  const t0m = Date.now()
  while (Date.now() - t0m < 90000) { if (await cdp.eval(profile.mountExpr).catch(() => false)) break; await sleep(120) }
  await sleep(300)
  for (let i = 0; i < 200; i++) {
    await cdp.eval(PROBE).catch(() => {})
    if (await cdp.eval(`!!(window.__m7g && window.api && window.api.lsp)`).catch(() => false)) break
    await sleep(200)
  }
  const { windowId } = await cdp.send('Browser.getWindowForTarget').catch(() => ({}))
  if (windowId) await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: 1440, height: 900, windowState: 'normal' } }).catch(() => {})

  await cdp.eval(`window.__m7g.fpsStart()`)
  out.ready = await cdp.eval(`window.__m7g.waitReady(${S(DIR)}, ${S(HERO)}, 180000)`, { awaitPromise: true, timeoutMs: 190000 })
  out.firstPaint = await cdp.eval(`window.__m7g.firstPaint(${S(DIR)}, ${S(HERO)}, 180000)`, { awaitPromise: true, timeoutMs: 190000 })
  out.fpsWarm = await cdp.eval(`window.__m7g.fpsStop()`)
  out.procsAfterWarm = serverProcs(child.pid)

  // ② 연속 열기 + 그 구간의 프레임
  await cdp.eval(`window.__m7g.fpsStart()`)
  const t0 = Date.now()
  const rows = await cdp.eval(`window.__m7g.sweep(${S(DIR)}, ${S(files)})`, { awaitPromise: true, timeoutMs: 900000 })
  out.sweepMs = Date.now() - t0
  out.fpsSweep = await cdp.eval(`window.__m7g.fpsStop()`)
  const num = (k) => rows.map((r) => r[k]).sort((a, b) => a - b)
  const p = (arr, q) => (arr.length ? Math.round(arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] * 100) / 100 : null)
  out.sweep = {
    n: rows.length,
    statuses: [...new Set(rows.map((r) => r.st))],
    withTokens: rows.filter((r) => r.n > 0).length,
    cachedHits: rows.filter((r) => r.cached).length,
    statusP50: p(num('statusMs'), 0.5), statusP95: p(num('statusMs'), 0.95), statusMax: p(num('statusMs'), 1),
    cacheP50: p(num('cacheMs'), 0.5), cacheP95: p(num('cacheMs'), 0.95), cacheMax: p(num('cacheMs'), 1),
    semP50: p(num('semMs'), 0.5), semP95: p(num('semMs'), 0.95), semMax: p(num('semMs'), 1),
    perFileMsAvg: Math.round((out.sweepMs / rows.length) * 100) / 100
  }
  out.rowsHead = rows.slice(0, 5)
  out.rowsTail = rows.slice(-5)
  out.procsAfterSweep = serverProcs(child.pid)

  // ③ 유휴 대조군
  await cdp.eval(`window.__m7g.fpsStart()`)
  await sleep(3000)
  out.fpsIdle = await cdp.eval(`window.__m7g.fpsStop()`)
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
console.log(JSON.stringify({ kind: out.kind, ready: out.ready, firstPaint: out.firstPaint, fpsWarm: out.fpsWarm,
  sweepMs: out.sweepMs, sweep: out.sweep, fpsSweep: out.fpsSweep, fpsIdle: out.fpsIdle,
  procsAfterWarm: out.procsAfterWarm?.length, procsAfterSweep: out.procsAfterSweep?.length, error: out.error }, null, 2))
